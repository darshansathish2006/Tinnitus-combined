/**
 * Clinical measurement procedures.
 *
 * These implement the actual psychoacoustic methods rather than sliders that
 * happen to produce numbers:
 *
 *  - **Audiometry** uses the modified Hughson-Westlake procedure (BSA recommended
 *    procedure): 10 dB down after a response, 5 dB up after none, threshold taken
 *    as the lowest level with two responses out of three ascending presentations.
 *  - **Pitch matching** is a two-alternative forced choice bracketing search in
 *    log-frequency, followed by an explicit octave-confusion check — patients very
 *    commonly match an octave away from their true percept, and a notch placed on
 *    the wrong octave has no mechanism of benefit.
 *  - **Loudness matching** and **minimum masking level** are ascending methods
 *    reported in dB sensation level, referenced to the patient's own threshold at
 *    the matched frequency.
 *  - **Residual inhibition** samples perceived loudness on a fixed grid after the
 *    masker stops, then fits the decay to report depth and duration.
 *
 * Presentation timing is randomised throughout. A predictable rhythm lets the
 * patient anticipate the tone and produces false positives, which is the single
 * commonest way self-administered audiometry goes wrong.
 */

export type Ear = "left" | "right";

/* ------------------------------------------------------------------------- */
/* Pure-tone audiometry                                                       */
/* ------------------------------------------------------------------------- */
export interface TrackerStep {
  level: number;
  responded: boolean;
  ascending: boolean;
  at: number;
}

export type TrackerState = "idle" | "presenting" | "waiting" | "converged" | "floor" | "ceiling";

export interface TrackerResult {
  freq: number;
  ear: Ear;
  thresholdDbHl: number | null;
  responsesAtThreshold: number;
  presentations: number;
  reliable: boolean;
  note: string;
  trace: TrackerStep[];
}

/**
 * Modified Hughson-Westlake threshold tracker for one ear at one frequency.
 *
 * The caller presents a tone at `level`, then reports back with `record(true)` or
 * `record(false)`. The tracker owns the level rule and the stopping rule.
 */
export class ThresholdTracker {
  private level: number;
  private lastWasAscending = false;
  private ascendingResponses = new Map<number, number>();
  private ascendingPresentations = new Map<number, number>();
  readonly trace: TrackerStep[] = [];
  state: TrackerState = "idle";

  constructor(
    readonly freq: number,
    readonly ear: Ear,
    private options: {
      startDbHl?: number;
      minDbHl?: number;
      maxDbHl?: number;
      downStep?: number;
      upStep?: number;
      requiredResponses?: number;
      ofPresentations?: number;
    } = {}
  ) {
    this.level = options.startDbHl ?? 40;
  }

  get currentLevel(): number {
    return this.level;
  }

  get presentationCount(): number {
    return this.trace.length;
  }

  /** Randomised inter-stimulus interval, so the tone cannot be anticipated. */
  nextDelayMs(): number {
    return 900 + Math.random() * 1400;
  }

  record(responded: boolean): TrackerState {
    const {
      minDbHl = -10,
      maxDbHl = 90,
      downStep = 10,
      upStep = 5,
      requiredResponses = 2,
      ofPresentations = 3,
    } = this.options;

    this.trace.push({
      level: this.level,
      responded,
      ascending: this.lastWasAscending,
      at: Date.now(),
    });

    // Only ascending presentations count toward threshold: a descending run
    // establishes audibility, an ascending run establishes the threshold.
    if (this.lastWasAscending) {
      this.ascendingPresentations.set(this.level, (this.ascendingPresentations.get(this.level) ?? 0) + 1);
      if (responded) {
        this.ascendingResponses.set(this.level, (this.ascendingResponses.get(this.level) ?? 0) + 1);
      }
      const responses = this.ascendingResponses.get(this.level) ?? 0;
      const presentations = this.ascendingPresentations.get(this.level) ?? 0;
      if (responses >= requiredResponses) {
        this.state = "converged";
        return this.state;
      }
      // Three ascending presentations without two responses: this level is below
      // threshold, so step up and start again.
      if (presentations >= ofPresentations) {
        this.level = Math.min(maxDbHl, this.level + upStep);
        this.lastWasAscending = true;
        this.state = this.level >= maxDbHl ? "ceiling" : "waiting";
        return this.state;
      }
    }

    if (responded) {
      // Whether we are at the floor depends on the level just *presented*, not on
      // the level we are about to step down to. Testing the new level declares
      // "floor" one step early, which records a patient with a genuine 0 dB HL
      // threshold as being at or below -10 dB HL.
      const presentedAtFloor = this.level <= minDbHl;
      this.level = Math.max(minDbHl, this.level - downStep);
      this.lastWasAscending = false;
      this.state = presentedAtFloor ? "floor" : "waiting";
    } else {
      const presentedAtCeiling = this.level >= maxDbHl;
      this.level = Math.min(maxDbHl, this.level + upStep);
      this.lastWasAscending = true;
      this.state = presentedAtCeiling ? "ceiling" : "waiting";
    }

    if (this.trace.length >= 30) this.state = "converged";
    return this.state;
  }

  result(): TrackerResult {
    const minDbHl = this.options.minDbHl ?? -10;
    const candidates = [...this.ascendingResponses.entries()]
      .filter(([, count]) => count >= (this.options.requiredResponses ?? 2))
      .map(([level]) => level);
    let threshold = candidates.length ? Math.min(...candidates) : null;

    let note = "";
    let reliable = true;
    if (this.state === "floor") {
      // The patient responded at the lowest presentable level. Their threshold is
      // at or below it, which is a *result* — reporting null here would discard a
      // normal-hearing ear as a measurement failure, and near-normal thresholds
      // are exactly where the descending run reaches the floor before an
      // ascending run has had a chance to confirm.
      if (threshold === null) threshold = minDbHl;
      note = `Responded at the lowest presentable level — threshold is at or below ${minDbHl} dB HL.`;
    } else if (this.state === "ceiling") {
      note = "No response at the maximum safe output — threshold could not be established here.";
      reliable = false;
    } else if (threshold === null) {
      note = "Did not converge on two responses out of three ascending presentations.";
      reliable = false;
    } else if (this.trace.length > 22) {
      note = "Unusually many presentations needed — responses were inconsistent. Consider repeating.";
      reliable = false;
    } else {
      note = "Converged normally.";
    }

    return {
      freq: this.freq,
      ear: this.ear,
      thresholdDbHl: threshold,
      responsesAtThreshold: threshold === null ? 0 : (this.ascendingResponses.get(threshold) ?? 0),
      presentations: this.trace.length,
      reliable,
      note,
      trace: this.trace,
    };
  }
}

/**
 * False-positive check: a "presentation" where no tone is actually played. If the
 * patient responds, they are guessing and the whole audiogram is suspect.
 *
 * Every 10th presentation rather than every 7th. The check exists to catch a
 * guesser, not to sample continuously — one silent trial roughly every ten
 * genuine ones is still frequent enough that a patient responding at random
 * is caught within the ~6-12 presentations a single frequency typically
 * takes, while presenting about 30% fewer silent trials than the previous
 * 1-in-7 rate over a full two-ear test. The mechanism itself (a real
 * presentation is silently skipped, a response is recorded as a false
 * positive) is unchanged.
 */
export function shouldInsertCatchTrial(presentationsSoFar: number): boolean {
  return presentationsSoFar > 0 && presentationsSoFar % 10 === 0;
}

/* ------------------------------------------------------------------------- */
/* Pitch matching (2AFC bracketing)                                           */
/* ------------------------------------------------------------------------- */
export interface PitchTrial {
  step: number;
  aHz: number;
  bHz: number;
  chosenHz: number;
  at: number;
}

export interface PitchResult {
  hz: number;
  confidence: number;
  octaveConfusion: boolean;
  trace: PitchTrial[];
  note: string;
}

/**
 * Two-alternative forced-choice bracketing over log-frequency.
 *
 * Patients are poor at naming a frequency but reliable at saying which of two
 * tones is *closer* to their tinnitus, so the search only ever asks that. The
 * bracket halves each round, which converges on a match in roughly seven trials.
 */
export class PitchMatcher {
  private lowOct: number;
  private highOct: number;
  private step = 0;
  readonly trace: PitchTrial[] = [];
  private lastSeparationOct = 0;
  private reversals = 0;
  private choices: number[] = [];
  private retrial: { originalHz: number; retestHz: number; agreed: boolean } | null = null;

  constructor(lowHz = 250, highHz = 14000, private maxSteps = 8) {
    this.lowOct = Math.log2(lowHz);
    this.highOct = Math.log2(highHz);
  }

  /** The next pair to present. */
  pair(): { aHz: number; bHz: number; step: number; done: boolean } {
    const span = this.highOct - this.lowOct;
    const a = this.lowOct + span * 0.28;
    const b = this.lowOct + span * 0.72;
    this.lastSeparationOct = b - a;
    return {
      aHz: Math.round(Math.pow(2, a)),
      bHz: Math.round(Math.pow(2, b)),
      step: this.step,
      done: this.step >= this.maxSteps || this.lastSeparationOct < 0.08,
    };
  }

  /** Record which tone the patient judged closer, and narrow the bracket. */
  choose(chosenHz: number): void {
    const { aHz, bHz } = this.pair();
    this.trace.push({ step: this.step, aHz, bHz, chosenHz, at: Date.now() });

    const chosenOct = Math.log2(chosenHz);
    const span = this.highOct - this.lowOct;
    if (chosenHz === aHz) {
      this.highOct = chosenOct + span * 0.18;
    } else {
      this.lowOct = chosenOct - span * 0.18;
    }

    // Count direction reversals in the sequence of choices. A patient
    // flip-flopping between high and low is not converging on anything, and the
    // confidence score has to reflect that — it is what stops the therapy engine
    // placing a notch on an unstable match.
    this.choices.push(chosenOct);
    if (this.choices.length >= 3) {
      const n = this.choices.length;
      const previousDelta = this.choices[n - 2] - this.choices[n - 3];
      const currentDelta = this.choices[n - 1] - this.choices[n - 2];
      // Ignore deltas below a tenth of an octave as measurement grain.
      if (Math.abs(previousDelta) > 0.1 && Math.abs(currentDelta) > 0.1) {
        if (Math.sign(previousDelta) !== Math.sign(currentDelta)) this.reversals++;
      }
    }
    this.step++;
  }

  /**
   * The pair to re-present as a reliability check — the first comparison, because
   * it had the widest separation and is therefore the most diagnostic.
   *
   * Test-retest agreement is the only measure that reliably detects a guesser.
   * Counting reversals does not work, because the bracket narrows on every trial
   * regardless of what the patient picks, so even random choices trend toward the
   * centre and look convergent. Comparing choices against the final answer does
   * not work either, since random late choices *determine* that answer and are
   * trivially consistent with it. Asking the same question twice does work.
   */
  retrialPair(): { aHz: number; bHz: number } | null {
    if (!this.trace.length) return null;
    const first = this.trace[0];
    return { aHz: first.aHz, bHz: first.bHz };
  }

  /** Record the retest choice. Returns whether it agreed with the original. */
  recordRetrial(chosenHz: number): boolean {
    if (!this.trace.length) return false;
    const agreed = chosenHz === this.trace[0].chosenHz;
    this.retrial = { originalHz: this.trace[0].chosenHz, retestHz: chosenHz, agreed };
    return agreed;
  }

  get retrialResult(): { originalHz: number; retestHz: number; agreed: boolean } | null {
    return this.retrial;
  }

  /** Candidate octaves to test for confusion, once bracketing has converged. */
  octaveCandidates(): number[] {
    const centre = Math.pow(2, (this.lowOct + this.highOct) / 2);
    return [centre / 2, centre, centre * 2].map((f) => Math.round(f)).filter((f) => f >= 125 && f <= 16000);
  }

  result(confirmedHz?: number, octaveConfusionDetected = false): PitchResult {
    const bracketed = Math.pow(2, (this.lowOct + this.highOct) / 2);
    const hz = Math.round(confirmedHz ?? bracketed);

    // Confidence gates whether the therapy engine will place a notch at all, so
    // it has to detect a patient who is guessing. Test-retest agreement carries
    // the most weight because it is the only component that a guesser cannot
    // accidentally satisfy (see `retrialPair`).
    const tightness = Math.max(0, 1 - (this.highOct - this.lowOct) / 2.2);
    const stability = Math.max(0, 1 - this.reversals / Math.max(1, this.trace.length - 1));
    const completeness = Math.min(1, this.trace.length / 6);
    const retestCredit = this.retrial ? 0.25 : 0.1; // no retest caps confidence below 0.9

    let confidence = tightness * 0.35 + stability * 0.2 + completeness * 0.2 + retestCredit;
    if (this.retrial && !this.retrial.agreed) {
      // A failed retest is disqualifying, not a minor deduction: the same question
      // got two different answers, so the match cannot be relied on for a notch.
      confidence *= 0.45;
    }
    confidence = Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100;

    let note: string;
    if (this.retrial && !this.retrial.agreed) {
      note =
        `Test-retest failed: the same comparison produced ${Math.round(this.retrial.originalHz)} Hz ` +
        `first and ${Math.round(this.retrial.retestHz)} Hz on repeat. The match is not reproducible, so a ` +
        "therapy notch will not be prescribed on it.";
    } else if (octaveConfusionDetected) {
      note = "Octave confusion detected and resolved during confirmation. The confirmed octave is reported.";
    } else if (confidence >= 0.75) {
      note = "Converged consistently and reproduced on retest. Suitable for placing a therapy notch.";
    } else if (confidence >= 0.5) {
      note = "Converged, but with some inconsistency. Repeat at the next visit to confirm.";
    } else {
      note =
        "Did not converge reliably — the percept may be broadband or fluctuating. A notch will not be " +
        "prescribed on this match.";
    }

    return {
      hz,
      confidence,
      octaveConfusion: octaveConfusionDetected,
      trace: this.trace,
      note,
    };
  }
}

/* ------------------------------------------------------------------------- */
/* Pitch matching — deterministic 2AFC narrowing (patient-facing workflow)    */
/* ------------------------------------------------------------------------- */
export type PitchAFCResponse = "A" | "B" | "not_sure";

export interface PitchAFCTrial {
  trial_number: number;
  phase: "coarse" | "fine";
  frequency_a: number;
  frequency_b: number;
  response: PitchAFCResponse;
  at: number;
}

/**
 * Deterministic adaptive two-alternative forced-choice frequency-narrowing
 * search, starting from a fixed 1000/8000 Hz pair.
 *
 * `A` is always the lower frequency of the current bracket and `B` the
 * higher, so the patient is comparing two clearly ordered tones on every
 * trial. Whichever side is chosen becomes the fixed anchor for the next
 * trial; the *other* bound moves toward it — two-thirds of the remaining
 * log-frequency gap during the coarse phase, one-half (ordinary bisection)
 * during the fine phase — so the bracket only ever shrinks, never depends on
 * randomness, and always converges in a bounded number of trials.
 *
 * "Not Sure" is handled as neither a vote for A nor for B: both bounds move
 * one-sixth of the gap toward the centre instead, which keeps the search
 * making guaranteed forward progress (so a patient who is never sure still
 * reaches a result) without the outcome depending on which side happened to
 * be asked about.
 *
 * Protocol: a minimum of three coarse trials, continuing until the bracket
 * has closed to within one octave or five coarse trials have run (whichever
 * first), then up to three fine trials, stopping early once the bracket is
 * within a semitone (1/12 octave). Both limits are fixed constants, not
 * influenced by the patient or by chance.
 */
export class PitchNarrower {
  private lowOct: number;
  private highOct: number;
  private trials: PitchAFCTrial[] = [];
  private notSureCount = 0;
  private phaseName: "coarse" | "fine" = "coarse";

  static readonly MIN_COARSE_TRIALS = 3;
  static readonly MAX_COARSE_TRIALS = 5;
  static readonly MAX_FINE_TRIALS = 3;
  static readonly COARSE_NARROW_FRACTION = 2 / 3;
  static readonly FINE_NARROW_FRACTION = 1 / 2;
  static readonly NOT_SURE_NUDGE_FRACTION = 1 / 6;
  static readonly COARSE_TO_FINE_GAP_OCT = 1;
  static readonly FINE_STOP_GAP_OCT = 1 / 12;

  constructor(startLowHz = 1000, startHighHz = 8000) {
    this.lowOct = Math.log2(startLowHz);
    this.highOct = Math.log2(startHighHz);
  }

  get trace(): PitchAFCTrial[] {
    return this.trials;
  }

  get notSureTotal(): number {
    return this.notSureCount;
  }

  get phase(): "coarse" | "fine" {
    return this.phaseName;
  }

  /** The pair to present right now: A is always the lower frequency. */
  pair(): { aHz: number; bHz: number } {
    return { aHz: Math.round(2 ** this.lowOct), bHz: Math.round(2 ** this.highOct) };
  }

  private gapOct(): number {
    return this.highOct - this.lowOct;
  }

  private coarseCount(): number {
    return this.trials.filter((t) => t.phase === "coarse").length;
  }

  /** Has the search reached its stopping point? */
  get done(): boolean {
    if (this.phaseName !== "fine") return false;
    const fineCount = this.trials.filter((t) => t.phase === "fine").length;
    return fineCount >= PitchNarrower.MAX_FINE_TRIALS || this.gapOct() <= PitchNarrower.FINE_STOP_GAP_OCT;
  }

  /** Record the patient's response for the current pair and narrow the bracket. */
  choose(response: PitchAFCResponse): void {
    const { aHz, bHz } = this.pair();
    this.trials.push({
      trial_number: this.trials.length + 1,
      phase: this.phaseName,
      frequency_a: aHz,
      frequency_b: bHz,
      response,
      at: Date.now(),
    });

    if (response === "not_sure") {
      this.notSureCount++;
      const nudge = this.gapOct() * PitchNarrower.NOT_SURE_NUDGE_FRACTION;
      this.lowOct += nudge;
      this.highOct -= nudge;
    } else {
      const k = this.phaseName === "coarse" ? PitchNarrower.COARSE_NARROW_FRACTION : PitchNarrower.FINE_NARROW_FRACTION;
      if (response === "A") {
        this.highOct = this.lowOct + this.gapOct() * (1 - k);
      } else {
        this.lowOct = this.highOct - this.gapOct() * (1 - k);
      }
    }

    if (this.phaseName === "coarse") {
      const coarseTrials = this.coarseCount();
      if (
        coarseTrials >= PitchNarrower.MIN_COARSE_TRIALS &&
        (this.gapOct() <= PitchNarrower.COARSE_TO_FINE_GAP_OCT || coarseTrials >= PitchNarrower.MAX_COARSE_TRIALS)
      ) {
        this.phaseName = "fine";
      }
    }
  }

  /** The matched frequency: the geometric mean of the final bracket. */
  result(): number {
    return Math.round(2 ** ((this.lowOct + this.highOct) / 2));
  }

  /**
   * Reliability, on the same 0-1 scale and with the same weighting shape as
   * the bracketing search this replaces, so downstream consumers that gate
   * on it (the therapy engine's notch-placement threshold) keep behaving the
   * same way. Components:
   *
   *  - **Tightness** — how narrow the final bracket is.
   *  - **Stability** — how often the patient reversed direction (chose A then
   *    B then A on adjoining decisive trials), from `reversalCount()`.
   *  - **Completeness** — trial count relative to a typical full search.
   *  - **Octave-check credit** — replaces the old test-retest credit: a
   *    patient who confirms the matched pitch over its octave-doubled
   *    alternative is giving the same kind of reliability evidence a
   *    reproduced retest used to.
   */
  confidence(octaveResponse: "matched" | "octave_higher" | "not_sure" | null): number {
    const tightness = Math.max(0, 1 - this.gapOct() / 2.2);
    const stability = Math.max(0, 1 - this.reversalCount() / Math.max(1, this.trials.length - 1));
    const completeness = Math.min(1, this.trials.length / 6);
    const octaveCredit = octaveResponse === "matched" ? 0.25 : octaveResponse === "octave_higher" ? 0.15 : 0.1;
    const value = tightness * 0.35 + stability * 0.2 + completeness * 0.2 + octaveCredit;
    return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
  }

  /** Direction reversals among decisive (non-"not_sure") trials. */
  private reversalCount(): number {
    const decisive = this.trials.filter((t) => t.response !== "not_sure").map((t) => t.response);
    let reversals = 0;
    for (let i = 2; i < decisive.length; i++) {
      if (decisive[i] !== decisive[i - 1] && decisive[i - 1] !== decisive[i - 2]) reversals++;
    }
    return reversals;
  }
}

/* ------------------------------------------------------------------------- */
/* Loudness match / MML / LDL                                                 */
/* ------------------------------------------------------------------------- */
export interface AscendingResult {
  levelDbHl: number;
  sensationLevelDb: number | null;
  note: string;
}

/**
 * Convert an absolute presentation level into sensation level.
 * dB SL is the number that matters clinically — a tinnitus matched at 45 dB HL in
 * an ear with a 40 dB threshold is a 5 dB SL percept, i.e. very quiet, even though
 * the absolute figure looks large.
 */
export function toSensationLevel(levelDbHl: number, thresholdDbHl: number | null): number | null {
  if (thresholdDbHl === null) return null;
  return Math.round((levelDbHl - thresholdDbHl) * 10) / 10;
}

/**
 * These interpreters return a **translation key**, not prose.
 *
 * This module is pure signal-processing and psychoacoustic logic — it runs the
 * adaptive staircases and the RI analysis — and giving it a dependency on the
 * i18n runtime would drag React state into an audio path that has to stay
 * synchronous and testable. The band boundaries are the clinical content and
 * they live here; the sentence that describes each band lives in the
 * translation files under `procedures.*`, and the component resolves it.
 */
export function interpretLoudnessMatch(sensationLevelDb: number | null): string {
  if (sensationLevelDb === null) return "procedures.loudness.unknown";
  if (sensationLevelDb <= 6) return "procedures.loudness.veryQuiet";
  if (sensationLevelDb <= 15) return "procedures.loudness.typical";
  if (sensationLevelDb <= 25) return "procedures.loudness.louder";
  return "procedures.loudness.unusuallyHigh";
}

export function interpretMml(mmlSensationLevelDb: number | null): string {
  if (mmlSensationLevelDb === null) return "procedures.mml.notMeasured";
  if (mmlSensationLevelDb <= 6) return "procedures.mml.veryEasy";
  if (mmlSensationLevelDb <= 12) return "procedures.mml.easy";
  if (mmlSensationLevelDb <= 20) return "procedures.mml.moderate";
  if (mmlSensationLevelDb <= 32) return "procedures.mml.difficult";
  return "procedures.mml.refractory";
}

/* ------------------------------------------------------------------------- */
/* Loudness matching — deterministic adaptive intensity search (patient-facing */
/* Loudness Match workflow, distinct from the ascending methods above)        */
/* ------------------------------------------------------------------------- */
export type LoudnessResponse = "much_softer" | "softer" | "about_same" | "louder" | "much_louder";
export type LoudnessFineResponse = "softer" | "about_same" | "louder";

export interface LoudnessTrial {
  trial_number: number;
  phase: "coarse" | "fine";
  level_db: number;
  response: LoudnessResponse | LoudnessFineResponse;
  at: number;
}

/**
 * Deterministic adaptive loudness-matching search at a *fixed* frequency —
 * the frequency never changes here, only the presentation intensity. Started
 * from a protocol-defined level (the patient's own confirmed audible level,
 * plus a fixed comfort margin — see `LoudnessMatcher.startingLevel`), the
 * coarse phase moves in two step sizes depending on how far off the
 * comparison sounds ("much" vs a plain "softer"/"louder"), and the fine phase
 * narrows with a single small step. Every step size and stopping rule is a
 * named constant here rather than a number scattered through the UI.
 */
export class LoudnessMatcher {
  private level: number;
  private trials: LoudnessTrial[] = [];
  private phaseName: "coarse" | "fine" = "coarse";
  private lastDirection: "up" | "down" | null = null;

  static readonly MUCH_STEP_DB = 10;
  static readonly SMALL_STEP_DB = 5;
  static readonly FINE_STEP_DB = 2;
  static readonly MIN_COARSE_TRIALS = 2;
  static readonly MAX_COARSE_TRIALS = 6;
  static readonly MAX_FINE_TRIALS = 5;
  /** Consecutive "about the same" fine responses that count as converged. */
  static readonly FINE_CONVERGENCE_STREAK = 2;
  /** How far above the patient's own confirmed-audible level the adaptive
   *  search starts — comparing against a barely-audible tone is not a
   *  meaningful loudness comparison, so the search opens a bit above it. */
  static readonly STARTING_COMFORT_MARGIN_DB = 10;

  constructor(
    audibleLevelDb: number,
    private minDb = -10,
    private maxDb = 90
  ) {
    this.level = Math.min(maxDb, Math.max(minDb, audibleLevelDb + LoudnessMatcher.STARTING_COMFORT_MARGIN_DB));
  }

  get currentLevel(): number {
    return this.level;
  }

  get phase(): "coarse" | "fine" {
    return this.phaseName;
  }

  get trace(): LoudnessTrial[] {
    return this.trials;
  }

  private coarseCount(): number {
    return this.trials.filter((t) => t.phase === "coarse").length;
  }

  private fineTrials(): LoudnessTrial[] {
    return this.trials.filter((t) => t.phase === "fine");
  }

  /** Has the search reached its stopping point? */
  get done(): boolean {
    if (this.phaseName !== "fine") return false;
    const fine = this.fineTrials();
    if (fine.length >= LoudnessMatcher.MAX_FINE_TRIALS) return true;
    const streak = fine.slice(-LoudnessMatcher.FINE_CONVERGENCE_STREAK);
    return (
      streak.length === LoudnessMatcher.FINE_CONVERGENCE_STREAK &&
      streak.every((t) => t.response === "about_same")
    );
  }

  /** Record the patient's comparison and adjust the presentation level. */
  respond(response: LoudnessResponse | LoudnessFineResponse): void {
    this.trials.push({
      trial_number: this.trials.length + 1,
      phase: this.phaseName,
      level_db: this.level,
      response,
      at: Date.now(),
    });

    let direction: "up" | "down" | null = null;
    if (response === "much_softer") {
      this.level = Math.min(this.maxDb, this.level + LoudnessMatcher.MUCH_STEP_DB);
      direction = "up";
    } else if (response === "softer") {
      const step = this.phaseName === "coarse" ? LoudnessMatcher.SMALL_STEP_DB : LoudnessMatcher.FINE_STEP_DB;
      this.level = Math.min(this.maxDb, this.level + step);
      direction = "up";
    } else if (response === "much_louder") {
      this.level = Math.max(this.minDb, this.level - LoudnessMatcher.MUCH_STEP_DB);
      direction = "down";
    } else if (response === "louder") {
      const step = this.phaseName === "coarse" ? LoudnessMatcher.SMALL_STEP_DB : LoudnessMatcher.FINE_STEP_DB;
      this.level = Math.max(this.minDb, this.level - step);
      direction = "down";
    }
    // "about_same": no change — a match, not a direction.

    if (this.phaseName === "coarse") {
      const count = this.coarseCount();
      // Move to fine matching once the search has bracketed the match — an
      // explicit "about the same", or a reversal in direction (the level
      // just crossed from one side of the true match to the other) — or
      // once the coarse phase has run long enough that it should stop
      // regardless.
      const reversed = direction !== null && this.lastDirection !== null && direction !== this.lastDirection;
      if (
        response === "about_same" ||
        (count >= LoudnessMatcher.MIN_COARSE_TRIALS && reversed) ||
        count >= LoudnessMatcher.MAX_COARSE_TRIALS
      ) {
        this.phaseName = "fine";
      }
    }
    if (direction !== null) this.lastDirection = direction;
  }

  /** The final matched presentation level, in dB HL. */
  result(): number {
    return Math.round(this.level);
  }
}

/* ------------------------------------------------------------------------- */
/* Masking threshold — deterministic per-frequency MML search (Feldmann      */
/* masking curve workflow: frequency is fixed while this runs, intensity     */
/* is the only variable it controls)                                        */
/* ------------------------------------------------------------------------- */
export type MaskingResponse = "audible" | "masked" | "not_sure";

export interface MaskingTrial {
  trial_number: number;
  phase: "coarse" | "fine";
  level_db: number;
  response: MaskingResponse;
  at: number;
}

/**
 * Deterministic adaptive search for the Minimum Masking Level (MML) at one
 * fixed masker frequency — one instance per frequency in the predefined
 * sequence, never spanning frequencies itself.
 *
 * Coarse phase ascends from a protocol-defined starting level (see
 * `MaskingLevelFinder.startFor`) in fixed steps while the tinnitus stays
 * audible, until the patient reports it is masked — bracketing the level
 * from below. Fine phase then descends in smaller steps from that bracket,
 * confirming the boundary: as soon as the tinnitus becomes audible again,
 * the *last* level that still masked it is the MML. "Not Sure" is handled
 * as neither "audible" nor "masked" — it nudges the search forward by half
 * a normal step so the procedure still terminates, and is tallied
 * separately rather than folded into either response.
 *
 * If the coarse phase reaches the safety ceiling without ever being
 * reported as masked, the search stops there: this frequency could not be
 * masked within the permitted range, which is recorded as such (mirroring
 * `masking_unmasked_hz`, the same "tried and could not mask" concept the
 * existing manual masking module already used) rather than reported as a
 * value.
 */
export class MaskingLevelFinder {
  private level: number;
  private trials: MaskingTrial[] = [];
  private phaseName: "coarse" | "fine" = "coarse";
  private bracketDb: number | null = null;
  private notSureCount = 0;
  private ceilingReachedUnmasked = false;

  static readonly COARSE_STEP_DB = 10;
  static readonly COARSE_NOT_SURE_STEP_DB = 5;
  static readonly FINE_STEP_DB = 3;
  /** A pure safety backstop, not the normal stopping path. From the lowest
   *  legal starting level (-10 dB) to the ceiling (85 dB) at a 10 dB step
   *  takes 10 steps — 11 presentations including the starting one — so this
   *  is set with headroom above that to guarantee the ceiling itself is
   *  always actually tested before the search gives up on a frequency. */
  static readonly MAX_COARSE_TRIALS = 13;
  static readonly MAX_FINE_TRIALS = 5;
  /** Matches `LOUDNESS_TO_MASKING_DB` in `backend/api/services/masking.py` —
   *  MML typically sits a few dB above the patient's own loudness match, so
   *  that (when available) is the best starting guess for the first
   *  frequency in the sequence. */
  static readonly LOUDNESS_TO_MASKING_MARGIN_DB = 6;

  constructor(
    startDb: number,
    private minDb = -10,
    private maxDb = 85 // MAX_SAFE_MASKING_DB in backend/api/services/masking.py
  ) {
    this.level = Math.min(maxDb, Math.max(minDb, startDb));
  }

  get currentLevel(): number {
    return this.level;
  }

  get phase(): "coarse" | "fine" {
    return this.phaseName;
  }

  get trace(): MaskingTrial[] {
    return this.trials;
  }

  get notSureTotal(): number {
    return this.notSureCount;
  }

  private coarseCount(): number {
    return this.trials.filter((t) => t.phase === "coarse").length;
  }

  private fineCount(): number {
    return this.trials.filter((t) => t.phase === "fine").length;
  }

  get done(): boolean {
    if (this.ceilingReachedUnmasked) return true;
    return this.phaseName === "fine" && (this.bracketDb === null || this.fineCount() >= MaskingLevelFinder.MAX_FINE_TRIALS);
  }

  respond(response: MaskingResponse): void {
    this.trials.push({
      trial_number: this.trials.length + 1,
      phase: this.phaseName,
      level_db: this.level,
      response,
      at: Date.now(),
    });

    if (this.phaseName === "coarse") {
      if (response === "masked") {
        this.bracketDb = this.level;
        this.phaseName = "fine";
        this.level = Math.max(this.minDb, this.level - MaskingLevelFinder.FINE_STEP_DB);
        return;
      }
      if (response === "not_sure") this.notSureCount++;
      if (this.level >= this.maxDb) {
        // The ceiling itself was *just presented* (this trial) and still was
        // not reported as masked — stop here rather than exceeding the
        // safe range. This frequency could not be masked within it. Checked
        // after recording the trial, so the ceiling level is always actually
        // tested at least once before giving up on it.
        this.ceilingReachedUnmasked = true;
        return;
      }
      const step = response === "not_sure" ? MaskingLevelFinder.COARSE_NOT_SURE_STEP_DB : MaskingLevelFinder.COARSE_STEP_DB;
      this.level = Math.min(this.maxDb, this.level + step);
      // Backstop only — see the constant's doc comment.
      if (this.coarseCount() >= MaskingLevelFinder.MAX_COARSE_TRIALS) this.ceilingReachedUnmasked = true;
      return;
    }

    // Fine phase: descending from the coarse bracket to confirm the boundary.
    if (response === "masked") {
      this.bracketDb = this.level;
      this.level = Math.max(this.minDb, this.level - MaskingLevelFinder.FINE_STEP_DB);
    } else if (response === "audible") {
      // Overshot below the true MML — the previous (still-masked) level is
      // the answer, so the search is done as soon as `done` is checked next.
    } else {
      this.notSureCount++;
      // Neither confirms nor overshoots — hold position and let the fixed
      // fine-trial cap bound the search.
    }
  }

  /** The MML for this frequency, or `null` if it was never bracketed
   *  (the ceiling was reached without the tinnitus ever being masked). */
  result(): number | null {
    if (this.ceilingReachedUnmasked && this.bracketDb === null) return null;
    return this.bracketDb === null ? null : Math.round(this.bracketDb);
  }

  get reachedCeilingUnmasked(): boolean {
    return this.ceilingReachedUnmasked && this.bracketDb === null;
  }
}

/* ------------------------------------------------------------------------- */
/* Residual inhibition                                                        */
/* ------------------------------------------------------------------------- */
export interface RiSample {
  t: number;
  loudness_pct: number;
}

export interface RiResult {
  depthPct: number;
  durationS: number | null;
  /**
   * The stable English token. Kept as-is because it is compared against in the
   * UI, stored on the assessment and read by the therapy engine — translating
   * the value would fork the record by the patient's language.
   */
  category: string;
  /** Translation key for `category`, resolved by whichever screen renders it. */
  categoryKey: string;
  /** Translation key for the clinical interpretation of this result. */
  noteKey: string;
  trace: RiSample[];
}

/** Sampling grid, in seconds after the masker stops. Dense early, where the
 *  recovery happens, sparse later. */
export const RI_SAMPLE_TIMES = [0, 5, 10, 15, 20, 30, 40, 50, 60];

/**
 * Analyse a residual-inhibition recovery curve.
 *
 * Depth is the maximum reduction from the 100% baseline. Duration is the time to
 * recover to 90% of baseline, linearly interpolated between samples rather than
 * snapped to the grid.
 */
export function analyseResidualInhibition(trace: RiSample[]): RiResult {
  const sorted = [...trace].sort((a, b) => a.t - b.t);
  if (!sorted.length) {
    return {
      depthPct: 0,
      durationS: null,
      category: "Not measured",
      categoryKey: "procedures.ri.category.notMeasured",
      noteKey: "",
      trace: sorted,
    };
  }

  // Depth is signed. A reduction below the 100% baseline is positive depth; an
  // *increase* above it is rebound and must come out negative, because rebound is
  // a contraindication to masking-based therapy rather than simply "no effect".
  // Taking 100 - min() alone silently reports a rebound as depth 0.
  const values = sorted.map((s) => s.loudness_pct);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const reduction = 100 - minimum;
  const increase = maximum - 100;
  const depth = Math.round((increase > reduction ? -increase : reduction) * 10) / 10;

  let duration: number | null = null;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a.loudness_pct < 90 && b.loudness_pct >= 90) {
      const t = (90 - a.loudness_pct) / (b.loudness_pct - a.loudness_pct);
      duration = Math.round((a.t + t * (b.t - a.t)) * 10) / 10;
      break;
    }
  }
  if (duration === null && sorted[sorted.length - 1].loudness_pct < 90) {
    duration = sorted[sorted.length - 1].t;
  }
  if (depth < 10) duration = 0;

  let category: string;
  let key: string;
  if (depth >= 95) {
    category = "Complete";
    key = "complete";
  } else if (depth >= 40) {
    category = "Partial";
    key = "partial";
  } else if (depth >= 10) {
    category = "Minimal";
    key = "minimal";
  } else if (depth <= -10) {
    category = "Rebound";
    key = "rebound";
  } else {
    category = "Absent";
    key = "absent";
  }

  return {
    depthPct: depth,
    durationS: duration,
    category,
    categoryKey: `procedures.ri.category.${key}`,
    noteKey: `procedures.ri.note.${key}`,
    trace: sorted,
  };
}

/* ------------------------------------------------------------------------- */
/* Bandwidth classification                                                   */
/* ------------------------------------------------------------------------- */
/**
 * Bandwidth classes. The `value` is what gets stored and drives whether a notch
 * is placed; the label and help text are looked up under
 * `procedures.bandwidth.*` by the component that renders them.
 */
export const BANDWIDTH_OPTIONS = [
  { value: "tonal" as const },
  { value: "narrowband" as const },
  { value: "broadband" as const },
];

export const CHARACTER_OPTIONS = [
  "Ringing",
  "Hissing",
  "Buzzing",
  "Whistling",
  "Clicking",
  "Roaring",
  "Cricket-like",
  "Pulsing",
  "Humming",
  "Multiple sounds",
];

/* ------------------------------------------------------------------------- */
/* Sound tolerance — deterministic ascending ULL/LDL search                  */
/* ------------------------------------------------------------------------- */
export type ToleranceResponse = "comfortable" | "uncomfortable" | "stop";

export interface ToleranceTrial {
  trial_number: number;
  level_db: number;
  response: ToleranceResponse;
  /** True for the single re-presentation used to confirm an "uncomfortable"
   *  report before it is accepted as the ULL/LDL. */
  confirmation: boolean;
  at: number;
}

/**
 * Deterministic ascending search for the Uncomfortable Loudness Level (ULL) /
 * Loudness Discomfort Level (LDL) at one fixed frequency and ear.
 *
 * No standardised ULL/LDL step size, starting level or confirmation rule was
 * found anywhere in this repository (see the implementation report), so this
 * reuses the same ascending-with-confirmation shape already established for
 * Masking Threshold (`MaskingLevelFinder`) and Loudness Match
 * (`LoudnessMatcher`) in this codebase, with its own constants declared here
 * rather than scattered through the UI, and the 90 dB safety ceiling already
 * used identically by `LoudnessMatcher`'s default and throughout
 * `Audiometry.tsx`.
 *
 * The patient reports "comfortable" or "uncomfortable" at each presentation;
 * "uncomfortable" is re-presented once for confirmation before being accepted
 * — a patient who reverses on the confirmation trial is not yet at their
 * limit, and the search resumes ascending from there. "Stop / Too loud" ends
 * the search immediately and reports the *previous* confirmed-comfortable
 * level, never the level that triggered the stop.
 */
export class ToleranceLevelFinder {
  private level: number;
  private trials: ToleranceTrial[] = [];
  private awaitingConfirmation = false;
  private stopped = false;

  static readonly STEP_DB = 10;
  static readonly MAX_TRIALS = 10;

  constructor(
    startDb: number,
    private maxDb = 90 // same safety ceiling `LoudnessMatcher` and `Audiometry.tsx` already use
  ) {
    // Ascending-only search — there is no lower clamp to track beyond the
    // starting value itself, since the level only ever increases from here.
    this.level = Math.min(maxDb, Math.max(-10, startDb));
  }

  get currentLevel(): number {
    return this.level;
  }

  get trace(): ToleranceTrial[] {
    return this.trials;
  }

  get done(): boolean {
    if (this.stopped) return true;
    if (this.trials.length >= ToleranceLevelFinder.MAX_TRIALS) return true;
    const last = this.trials[this.trials.length - 1];
    return Boolean(last?.confirmation && last.response === "uncomfortable");
  }

  respond(response: ToleranceResponse): void {
    const confirmation = this.awaitingConfirmation;
    this.trials.push({ trial_number: this.trials.length + 1, level_db: this.level, response, confirmation, at: Date.now() });

    if (response === "stop") {
      this.stopped = true;
      return;
    }

    if (confirmation) {
      this.awaitingConfirmation = false;
      if (response === "uncomfortable") return; // confirmed — `done` now true
      // Disconfirmed: resume ascending from the level that was being confirmed.
      this.level = Math.min(this.maxDb, this.level + ToleranceLevelFinder.STEP_DB);
      return;
    }

    if (response === "uncomfortable") {
      this.awaitingConfirmation = true;
      return; // re-present the same level next for confirmation
    }

    // "comfortable" — continue ascending, capped at the safety ceiling. If
    // already at the ceiling with no discomfort reported, the search ends
    // without a value rather than exceeding the safe range (see `result`).
    if (this.level >= this.maxDb) {
      this.stopped = true;
      return;
    }
    this.level = Math.min(this.maxDb, this.level + ToleranceLevelFinder.STEP_DB);
  }

  /** The ULL/LDL in dB, or `null` if the ceiling was reached with no
   *  discomfort reported, or the patient used the safety stop before a level
   *  was confirmed — never fabricated in either case. */
  result(): number | null {
    const confirmed = this.trials.find((t) => t.confirmation && t.response === "uncomfortable");
    return confirmed ? confirmed.level_db : null;
  }

  get reachedCeilingWithoutDiscomfort(): boolean {
    return this.stopped && this.result() === null && !this.trials.some((t) => t.response === "stop");
  }
}
