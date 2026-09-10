/**
 * Pure-tone audiometry step — Continuous Adaptive Audiometry.
 *
 * Drives `ThresholdTracker` (modified Hughson-Westlake) across a frequency
 * sequence for each ear. Three details separate this from a "click if you hear a
 * beep" toy:
 *
 *  - **Randomised presentation timing.** The patient must not be able to predict
 *    when the tone arrives, or they will respond to the rhythm.
 *  - **Catch trials.** Every tenth presentation is silent. Responding to
 *    silence means the patient is guessing, and the whole audiogram is flagged.
 *  - **1 kHz retest.** The standard reliability check — the sequence starts and
 *    ends at 1 kHz and the two thresholds must agree within 10 dB.
 *
 * None of the above changed in this pass. What changed is `sessionPhase`, the
 * layer wrapping the original per-frequency `phase` state machine
 * (`idle`/`presenting`/`gap`/`done`, still exactly what it always was):
 * previously each of the 14+ frequency/ear measurements needed its own
 * manual "Start" press, because the tracker-rebuild effect below always put
 * `phase` back to `idle` and waited. `sessionPhase` now makes one continuous
 * session out of that: a patient presses Start once, on an intro screen, and
 * the effect that rebuilds the tracker for each new frequency calls
 * `present()` itself rather than waiting — so the test auto-advances through
 * every frequency and both ears without another button press, unless the
 * patient explicitly pauses. `sessionPhase` also adds a genuine Pause/Resume
 * (distinct from the old "waiting for Start" idle state, which this replaces)
 * and a Stop confirmation that preserves whatever has already been measured
 * — see `onProgress`/`onExit` — rather than silently discarding it the way
 * the existing "abandon the whole module" `onSkip` always has and still does.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { engine } from "../../audio/engine";
import { ThresholdTracker, shouldInsertCatchTrial, type Ear, type TrackerResult } from "../../audio/procedures";
import { Audiogram } from "../../components/charts";
import { Chip, Kbd, Panel, Readout, useHotkey } from "../../components/ui";
import { IconCheck, IconPlay, IconStop } from "../../components/icons";
// The audiometer's frequency and level controls reuse the assessment's own
// slider so manual mode is visually identical to the tinnitus modules.
import { SteppedSlider } from "./HearingMeasurement";

/**
 * Octave frequencies, 1 kHz first because it is the most reliably matched and
 * gives the patient a clear reference for what they are listening for. 1 kHz is
 * repeated at the end as the reliability retest.
 *
 * 3 kHz and 6 kHz are **not** in this list. Per the BSA recommended procedure they
 * are tested only when adjacent octaves differ by 20 dB or more — which is where a
 * notch could otherwise be missed. Testing them unconditionally would add four
 * threshold searches per patient for information the octave set usually already
 * determines.
 */
const CORE_SEQUENCE = [1000, 2000, 4000, 8000, 500, 250, 1000];
const INTER_OCTAVE_TRIGGERS: [number, number, number][] = [
  // [inter-octave frequency, lower octave, upper octave]
  [3000, 2000, 4000],
  [6000, 4000, 8000],
];
const INTER_OCTAVE_GAP_DB = 20;

/** Which inter-octave frequencies this ear's measured thresholds indicate. */
function interOctaveNeeded(thresholds: Record<string, number>): number[] {
  const needed: number[] = [];
  for (const [freq, low, high] of INTER_OCTAVE_TRIGGERS) {
    const a = thresholds[String(low)];
    const b = thresholds[String(high)];
    if (a === undefined || b === undefined) continue;
    if (Math.abs(b - a) >= INTER_OCTAVE_GAP_DB) needed.push(freq);
  }
  return needed;
}

/**
 * Where a resumed session picks up — the first not-yet-measured position in
 * each ear's sequence, so returning to a session that already has thresholds
 * on file (a page reload, or a patient who exited and came back) re-measures
 * nothing that is already known, rather than restarting from the right ear's
 * 1 kHz.
 *
 * One honest limitation, documented rather than worked around with a new
 * persisted field: the 1 kHz retest and the ear's first 1 kHz measurement
 * write to the same `audiogram["1000"]` key (the retest's value simply
 * overwrites the first, exactly as it always has — see `finishFrequency`),
 * so a resumed session cannot tell from the audiogram alone whether the
 * retest already happened. Rather than guess, a session resuming at or past
 * that point in the sequence always re-measures the retest — never fewer
 * measurements than the protocol calls for, only possibly one harmless extra
 * one, which matches "never sacrifice measurement integrity for speed."
 */
function resumePosition(
  initialAudiogram: Record<Ear, Record<string, number>>
): { ear: Ear; stepIndex: number; extraFreqs: Record<Ear, number[]> } {
  const extraFreqs: Record<Ear, number[]> = {
    right: interOctaveNeeded(initialAudiogram.right ?? {}),
    left: interOctaveNeeded(initialAudiogram.left ?? {}),
  };
  const retestSlot = CORE_SEQUENCE.length - 1;
  for (const ear of ["right", "left"] as const) {
    const measured = initialAudiogram[ear] ?? {};
    const sequence = [...CORE_SEQUENCE, ...extraFreqs[ear]];
    // The retest slot (the final core-sequence index) is deliberately never
    // considered "already measured" here — see the limitation above.
    const firstUnmeasured = sequence.findIndex((f, i) => i !== retestSlot && !(String(f) in measured));
    if (firstUnmeasured !== -1) return { ear, stepIndex: firstUnmeasured, extraFreqs };
    // Every non-retest core and inter-octave frequency for this ear is
    // measured; the only slot that can still be ambiguous is the retest
    // itself, and the limitation above means that ambiguity is resolved the
    // same way for either ear — redo it, never skip it — rather than
    // guessing this ear is actually finished and jumping to the next one.
    // Once that redone retest is recorded, `finishFrequency`'s own,
    // unmodified ear-switch logic takes over exactly as it always has.
    return { ear, stepIndex: retestSlot, extraFreqs };
  }
  // Unreachable — the loop above always returns on its first iteration, but
  // TypeScript cannot see that from a `for...of` over a fixed tuple.
  return { ear: "right", stepIndex: 0, extraFreqs };
}

/**
 * A starting level informed by what this ear's audiogram already shows,
 * rather than a blind 40 dB HL for every one of the 14 frequency/ear
 * searches.
 *
 * An audiogram is a smooth curve, not fourteen independent draws — the
 * threshold just measured at an adjacent frequency (or, for the very first
 * frequency of the second ear, the other ear's threshold at the same
 * frequency) is a far better starting guess than a fixed value. Starting
 * 10 dB *above* that estimate preserves exactly the shape `ThresholdTracker`
 * has always assumed: the first presentation should be comfortably audible
 * so the descending run can establish audibility before the ascending run
 * finds threshold. This is the same seeding principle standard computerised
 * audiometers use to shorten testing — it changes nothing about the
 * tracker's bracketing, convergence rule, or floor/ceiling handling, only
 * where it starts.
 *
 * Falls back to 40 dB HL — the previous fixed starting point — whenever no
 * informative prior measurement exists yet, which is only true for the very
 * first frequency tested on the very first ear.
 */
function estimateStartLevel(
  ear: Ear,
  freq: number,
  stepIndex: number,
  audiogram: Record<Ear, Record<string, number>>
): number {
  const FALLBACK_DB_HL = 40;
  const AUDIBILITY_MARGIN_DB = 10;
  const seed = (threshold: number | undefined): number | null =>
    threshold === undefined ? null : threshold + AUDIBILITY_MARGIN_DB;

  let estimate: number | null = null;

  if (stepIndex === 0) {
    // First frequency of this ear (1 kHz). The right ear goes first and has
    // no prior information at all; the left ear can start near the right
    // ear's already-measured 1 kHz threshold.
    if (ear === "left") estimate = seed(audiogram.right?.["1000"]);
  } else if (stepIndex === CORE_SEQUENCE.length - 1) {
    // The 1 kHz reliability retest — start near this same ear's own first
    // 1 kHz measurement, not near 250 Hz (the frequency immediately before
    // it in the sequence), since retesting the same frequency is best seeded
    // from that frequency's own prior result.
    estimate = seed(audiogram[ear]?.["1000"]);
  } else if (stepIndex < CORE_SEQUENCE.length) {
    // Every other core frequency: start near the previous frequency in this
    // ear's own sequence.
    estimate = seed(audiogram[ear]?.[String(CORE_SEQUENCE[stepIndex - 1])]);
  } else {
    // Inter-octave frequency (3 kHz or 6 kHz), only ever reached once both of
    // its flanking octaves are already measured — seed from their average.
    const trigger = INTER_OCTAVE_TRIGGERS.find(([f]) => f === freq);
    if (trigger) {
      const [, low, high] = trigger;
      const a = audiogram[ear]?.[String(low)];
      const b = audiogram[ear]?.[String(high)];
      if (a !== undefined && b !== undefined) estimate = seed((a + b) / 2);
    }
  }

  return estimate ?? FALLBACK_DB_HL;
}

type Phase = "idle" | "presenting" | "gap" | "done";

/**
 * The continuous-session layer wrapping the per-frequency `phase` above.
 *
 *  - `intro` — the start screen; nothing has played yet.
 *  - `active` — the test is running; frequencies auto-advance without a
 *    per-frequency Start press (see the tracker-rebuild effect below).
 *  - `paused` — the patient asked to pause; all audio and timers are
 *    stopped, exactly as they were before `phase` doubled as this state.
 *  - `confirmExit` — the Stop confirmation; testing is paused underneath it.
 *  - `complete` — every required measurement and reliability check is done;
 *    mirrors the old `phase === "done"`, kept as a distinct session phase so
 *    "done with this frequency" and "done with the whole session" are never
 *    the same value again.
 */
type SessionPhase = "intro" | "active" | "paused" | "confirmExit" | "complete";

export interface AudiometryResult {
  audiogram: Record<Ear, Record<string, number>>;
  results: TrackerResult[];
  falsePositives: number;
  catchTrials: number;
  retestAgreementDb: number | null;
  reliable: boolean;
  notes: string[];
  interOctaveTested: Record<Ear, number[]>;
}

export default function Audiometry({
  onComplete,
  onSkip,
  onProgress,
  onExit,
  initialAudiogram,
}: {
  onComplete(result: AudiometryResult): void;
  /**
   * Leave the hearing test without taking it.
   *
   * Distinct from the per-frequency Skip in the test controls, which drops one
   * tone and carries on. This abandons the module: nothing is submitted, so no
   * audiogram is written and `modules_done` does not gain `audiometry` — an
   * assessment that skipped the test must not read as one that passed it.
   */
  onSkip?(): void;
  /**
   * Fires after every threshold actually established, with the audiogram as
   * it stands — a background autosave so a page reload or a later "Exit
   * Test" resumes with nothing lost, distinct from `onComplete` in that it
   * never implies the session is finished (the caller must not add
   * `"audiometry"` to `modules_done` for this). Optional: a caller that does
   * not wire it up simply gets no mid-session persistence, exactly the
   * previous behaviour.
   */
  onProgress?(audiogram: Record<Ear, Record<string, number>>): void;
  /**
   * The patient chose "Exit Test" after starting — as opposed to `onSkip`,
   * which is never taking the test at all, this preserves whatever was
   * already measured (the same audiogram `onProgress` has been saving) but,
   * like `onSkip`, must not be recorded as a completed module.
   */
  onExit?(audiogram: Record<Ear, Record<string, number>>): void;
  initialAudiogram?: Record<string, Record<string, number>>;
}) {
  const { t } = useTranslation();
  const resumed = useRef(
    initialAudiogram && (Object.keys(initialAudiogram.left ?? {}).length || Object.keys(initialAudiogram.right ?? {}).length)
      ? resumePosition({ left: initialAudiogram.left ?? {}, right: initialAudiogram.right ?? {} })
      : null
  ).current;
  const [ear, setEar] = useState<Ear>(resumed?.ear ?? "right");
  const [stepIndex, setStepIndex] = useState(resumed?.stepIndex ?? 0);
  /**
   * Guided or manual.
   *
   * "guided" is the existing procedure and the default: the adaptive tracker
   * chooses the level, inserts catch trials and retests 1 kHz, and the patient
   * only answers "I heard it". Nothing about it changes.
   *
   * "manual" hands frequency and level to the operator, which is what an
   * audiometer does and what a student learning the procedure needs to practise.
   * It writes into the same `audiogram` state, so a threshold taken by hand is
   * indistinguishable downstream from one the tracker found — same shape, same
   * audiogram, same report, same cochlea.
   *
   * They are alternatives rather than a merge because the two disagree about
   * who decides the level, and a control that sometimes moves on its own is
   * worse than either.
   */
  const [mode, setMode] = useState<"guided" | "manual">("guided");
  const [phase, setPhase] = useState<Phase>("idle");
  // The continuous-session layer. A resumed session (existing thresholds on
  // file) opens straight onto the intro screen like any other — resuming
  // still gets a deliberate "Start" press before any audio plays, rather
  // than auto-presenting into a session the patient has not chosen to
  // continue yet in *this* visit.
  const [sessionPhase, setSessionPhase] = useState<SessionPhase>("intro");
  const [audiogram, setAudiogram] = useState<Record<Ear, Record<string, number>>>(() => ({
    left: { ...(initialAudiogram?.left ?? {}) },
    right: { ...(initialAudiogram?.right ?? {}) },
  }));
  const [results, setResults] = useState<TrackerResult[]>([]);
  const [isCatchTrial, setIsCatchTrial] = useState(false);
  const [falsePositives, setFalsePositives] = useState(0);
  const [catchTrials, setCatchTrials] = useState(0);
  const [responded, setResponded] = useState(false);
  const [presentations, setPresentations] = useState(0);
  const [retest, setRetest] = useState<{ first: number | null; second: number | null }>({ first: null, second: null });

  // Extra frequencies added mid-test when the 20 dB inter-octave rule fires
  // — seeded from the resumed audiogram's own thresholds when reopening a
  // session that already has some, so a resumed session that already
  // qualifies for 3/6 kHz does not lose that requirement.
  const [extraFreqs, setExtraFreqs] = useState<Record<Ear, number[]>>(
    () => resumed?.extraFreqs ?? { left: [], right: [] }
  );

  const tracker = useRef<ThresholdTracker | null>(null);
  const timers = useRef<number[]>([]);
  const respondedRef = useRef(false);

  // The sequence for the current ear: core octaves, then any inter-octave
  // frequencies the measured thresholds turned out to indicate.
  const sequence = [...CORE_SEQUENCE, ...extraFreqs[ear]];
  const freq = sequence[Math.min(stepIndex, sequence.length - 1)];
  const isRetestStep = stepIndex === CORE_SEQUENCE.length - 1;
  const isInterOctave = stepIndex >= CORE_SEQUENCE.length;

  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  /** Fresh tracker whenever the ear or frequency changes. */
  useEffect(() => {
    const maxDbHl = Math.min(90, engine.maxReachableHl(freq));
    const startDbHl = Math.max(-10, Math.min(maxDbHl, estimateStartLevel(ear, freq, stepIndex, audiogram)));
    tracker.current = new ThresholdTracker(freq, ear, { startDbHl, maxDbHl });
    setPhase("idle");
    // `audiogram` is deliberately not a dependency: `setAudiogram` and the
    // `stepIndex`/`ear` advance that changes `freq` are committed in the same
    // update from `finishFrequency`, so by the time this effect re-runs (on
    // `freq`/`ear`/`stepIndex` changing) it always reads the audiogram as of
    // that same render, not a stale one — and re-running it on every
    // in-place audiogram edit would rebuild the tracker mid-measurement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freq, ear, stepIndex]);

  const finishFrequency = useCallback(() => {
    const current = tracker.current;
    if (!current) return;
    const result = current.result();
    setResults((prev) => [...prev, result]);

    // Compute the next sequence from the thresholds *including* the one just
    // measured, so the inter-octave decision uses complete information.
    let sideThresholds = audiogram[ear];
    if (result.thresholdDbHl !== null) {
      sideThresholds = { ...sideThresholds, [String(freq)]: result.thresholdDbHl };
      // Merged from `prev`, not from the closure's copy of `audiogram`.
      //
      // `sideThresholds` is still needed below for the inter-octave decision,
      // which wants the thresholds *including* the one just measured. But using
      // it as the new state would overwrite this ear's whole map with whatever
      // the closure captured — and this runs from a `setTimeout` chain, so the
      // closure is one the scheduler is holding rather than necessarily the
      // latest. It happens to be current today because the operator presses
      // Start once per frequency, which rebuilds the chain each time; it would
      // silently start dropping thresholds the moment the test auto-advanced.
      // Merging costs nothing and does not depend on that remaining true.
      setAudiogram((prev) => ({
        ...prev,
        [ear]: { ...(prev[ear] ?? {}), [String(freq)]: result.thresholdDbHl as number },
      }));
      if (freq === 1000) {
        setRetest((prev) =>
          prev.first === null
            ? { ...prev, first: result.thresholdDbHl }
            : { ...prev, second: result.thresholdDbHl }
        );
      }
    }

    const lastCoreIndex = CORE_SEQUENCE.length - 1;
    let extras = extraFreqs[ear];

    // Once the octave set is done, decide which inter-octave frequencies the BSA
    // 20 dB rule calls for on this ear.
    if (stepIndex === lastCoreIndex) {
      extras = interOctaveNeeded(sideThresholds);
      setExtraFreqs((prev) => ({ ...prev, [ear]: extras }));
    }

    const totalForEar = CORE_SEQUENCE.length + extras.length;
    if (stepIndex < totalForEar - 1) {
      setStepIndex((i) => i + 1);
    } else if (ear === "right") {
      setEar("left");
      setStepIndex(0);
    } else {
      setPhase("done");
      setSessionPhase("complete");
    }
  }, [audiogram, ear, extraFreqs, freq, stepIndex]);

  /** Present one stimulus (or a silent catch trial) and open the response window. */
  const present = useCallback(async () => {
    const current = tracker.current;
    if (!current) return;
    await engine.resume();

    const catchTrial = shouldInsertCatchTrial(presentations);
    setIsCatchTrial(catchTrial);
    setResponded(false);
    respondedRef.current = false;
    setPhase("presenting");

    if (!catchTrial) {
      engine.playTone({ freq, dbHL: current.currentLevel, ear, durationMs: 1000, rampMs: 25, warble: false });
    } else {
      setCatchTrials((n) => n + 1);
    }

    // Response window: 1 s tone + 900 ms afterwards.
    const windowTimer = window.setTimeout(() => {
      const heard = respondedRef.current;
      setPresentations((n) => n + 1);

      if (catchTrial) {
        if (heard) setFalsePositives((n) => n + 1);
        setPhase("gap");
        const next = window.setTimeout(() => void present(), 700);
        timers.current.push(next);
        return;
      }

      const state = current.record(heard);
      setPhase("gap");
      if (state === "converged" || state === "ceiling") {
        const done = window.setTimeout(() => finishFrequency(), 500);
        timers.current.push(done);
      } else {
        const next = window.setTimeout(() => void present(), current.nextDelayMs());
        timers.current.push(next);
      }
    }, 1900);
    timers.current.push(windowTimer);
  }, [ear, freq, finishFrequency, presentations]);

  /**
   * Mid-session persistence: fires whenever the audiogram actually changes —
   * a new threshold from `finishFrequency`, a redo from `previousFrequency`,
   * or a manual-mode record/clear — with the audiogram exactly as committed.
   * Deliberately a plain effect watching the committed state rather than a
   * call from inside `finishFrequency`'s `setAudiogram` updater: an updater
   * must stay pure (React's Strict Mode, which this app renders under, can
   * invoke it twice), so the side effect belongs here instead. Skipped
   * before the patient has pressed Start, when `audiogram` is only the
   * initial value echoed back and there is nothing new to save.
   */
  useEffect(() => {
    if (sessionPhase === "intro") return;
    onProgress?.(audiogram);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audiogram]);

  /** Auto-advance: once the tracker-rebuild effect above has reset `phase` to
   *  `idle` for a new frequency, start presenting immediately — the whole
   *  point of a continuous session. Does nothing while paused, exiting, or
   *  on the intro screen; `present()` guards `tracker.current` itself, so
   *  this is safe to fire on every phase/session-phase change. */
  useEffect(() => {
    if (sessionPhase === "active" && phase === "idle") void present();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPhase, phase]);

  const respond = useCallback(() => {
    if (phase !== "presenting" || respondedRef.current) return;
    respondedRef.current = true;
    setResponded(true);
  }, [phase]);

  useHotkey(" ", respond, "I heard it", phase === "presenting");
  useHotkey("enter", respond, "I heard it", phase === "presenting");

  /** The intro screen's single "Start Hearing Test" press — the only manual
   *  Start in the whole session from here on; every later frequency
   *  auto-presents via the effect above once `sessionPhase` is `active`. */
  function start() {
    clearTimers();
    setSessionPhase("active");
    void present();
  }

  /** Pause: stop all audio and timers immediately, exactly as the original
   *  per-frequency "Pause" always has, and show the paused screen rather
   *  than silently returning to what used to be indistinguishable from it —
   *  the old per-frequency "waiting for Start" idle state this replaces. */
  function pause() {
    clearTimers();
    engine.stopAll(0.05);
    setPhase("idle");
    setSessionPhase("paused");
  }

  /** Resume: the tracker for the current frequency was never torn down —
   *  only its presentation timers were cleared — so this continues the same
   *  bracket search rather than restarting the frequency. The auto-advance
   *  effect calls `present()` once `sessionPhase` flips back to `active`. */
  function resumeSession() {
    setSessionPhase("active");
  }

  /** The Stop control during active testing — pauses underneath the "Stop
   *  Hearing Test?" confirmation rather than leaving audio running behind it. */
  function openExitConfirm() {
    clearTimers();
    engine.stopAll(0.05);
    setPhase("idle");
    setSessionPhase("confirmExit");
  }

  function continueTesting() {
    setSessionPhase("active");
  }

  /** "Exit Test": preserves whatever has already been measured (the same
   *  audiogram `onProgress` has been saving throughout) but, like `onSkip`,
   *  must not read as a completed module — see `onExit`'s own doc comment. */
  function exitTest() {
    clearTimers();
    engine.stopAll(0.05);
    onExit?.(audiogram);
  }

  function skipFrequency() {
    clearTimers();
    engine.stopAll(0.05);
    finishFrequency();
  }

  /** Is there a step behind this one? False only on the very first tone. */
  const canGoBack = !(ear === "right" && stepIndex === 0) && phase !== "done";

  /**
   * Step back one frequency and re-open it for measurement.
   *
   * The subtlety is that going back must not leave the *old* reading behind.
   * `stepIndex` points at the tone being measured now, so the tone to redo is
   * the one before it — and its result is already in `results`, its threshold
   * already in `audiogram`, and if it was 1 kHz it has already been folded into
   * the retest pair. Re-measuring without unwinding all three would append a
   * second result for the same frequency: the reliability count would climb, the
   * retest comparison would use the wrong pair, and "frequencies done" would
   * exceed the number of frequencies.
   *
   * So this removes exactly one reading — the one about to be taken again — and
   * leaves every other measurement untouched. Crossing back from the left ear's
   * first tone returns to the right ear's last, including any inter-octave
   * frequencies that ear turned out to need.
   */
  function previousFrequency() {
    if (!canGoBack) return;
    clearTimers();
    engine.stopAll(0.05);

    const targetEar: Ear = stepIndex === 0 ? "right" : ear;
    const targetSequence = [...CORE_SEQUENCE, ...extraFreqs[targetEar]];
    const targetIndex = stepIndex === 0 ? targetSequence.length - 1 : stepIndex - 1;
    const targetFreq = targetSequence[targetIndex];

    // Drop the reading for the tone we are about to redo — one entry, matched on
    // ear *and* frequency so an inter-octave repeat cannot remove the wrong one.
    setResults((prev) => {
      const at = prev.findIndex((r) => r.ear === targetEar && r.freq === targetFreq);
      if (at === -1) return prev;
      return [...prev.slice(0, at), ...prev.slice(at + 1)];
    });

    setAudiogram((prev) => {
      const side = { ...(prev[targetEar] ?? {}) };
      delete side[String(targetFreq)];
      return { ...prev, [targetEar]: side };
    });

    // 1 kHz is measured twice on purpose — once in sequence and once as the
    // retest. Unwind whichever half is being redone, newest first.
    if (targetFreq === 1000) {
      setRetest((prev) => (prev.second !== null ? { ...prev, second: null } : { ...prev, first: null }));
    }

    setEar(targetEar);
    setStepIndex(targetIndex);
    setResponded(false);
    respondedRef.current = false;
    setIsCatchTrial(false);
    // The tracker is rebuilt by the effect that watches `ear` and `freq`, which
    // also returns the phase to `idle` — so the tone starts from the top rather
    // than resuming a run that belonged to the reading just discarded.
  }

  function complete() {
    const agreement =
      retest.first !== null && retest.second !== null ? Math.abs(retest.first - retest.second) : null;
    // The reliability notes are written in the patient's language and stored on
    // the assessment as prose. They are a *narrative* for the report, not scored
    // data — the numbers they describe (`falsePositives`, `retestAgreementDb`,
    // `reliable`) travel alongside them as structured fields, so a clinician
    // reading the record in a different language still has the machine-readable
    // version to work from.
    const notes: string[] = [];
    if (falsePositives > 0) {
      notes.push(
        t("audiometry.notes.falsePositives", { count: falsePositives, trials: catchTrials })
      );
    }
    if (agreement !== null && agreement > 10) {
      notes.push(t("audiometry.notes.retestDiffered", { db: agreement }));
    }
    const unreliable = results.filter((r) => !r.reliable);
    if (unreliable.length) {
      notes.push(t("audiometry.notes.notConverged", { count: unreliable.length }));
    }
    if (!notes.length) notes.push(t("audiometry.notes.clean"));

    const extras = extraFreqs.left.length + extraFreqs.right.length;
    notes.push(
      extras
        ? t("audiometry.notes.interOctaveAdded", { count: extras, gap: INTER_OCTAVE_GAP_DB })
        : t("audiometry.notes.interOctaveNone", { gap: INTER_OCTAVE_GAP_DB })
    );

    onComplete({
      audiogram,
      results,
      falsePositives,
      catchTrials,
      retestAgreementDb: agreement,
      reliable: falsePositives === 0 && (agreement === null || agreement <= 10) && unreliable.length === 0,
      notes,
      interOctaveTested: extraFreqs,
    });
  }

  /**
   * How many thresholds were actually obtained.
   *
   * This is the number the whole downstream pipeline depends on and, until now,
   * nothing checked it. A tone that is skipped — or one where the tracker never
   * converged — yields `thresholdDbHl === null`, and `finishFrequency` only
   * writes to the audiogram when that is non-null. Skip enough of them and
   * `complete()` posts `{left:{}, right:{}}`, which the API accepts without
   * complaint. The result is an assessment that looks finished and produces "No
   * audiometric data" in both reports and no 3D cochlea, with nothing anywhere
   * having reported a problem.
   *
   * So the count is surfaced, and saving an audiogram with nothing in it is
   * refused rather than silently accepted.
   */
  const measuredCount =
    Object.keys(audiogram.left ?? {}).length + Object.keys(audiogram.right ?? {}).length;
  const skippedCount = Math.max(0, results.length - measuredCount);

  const totalSteps = CORE_SEQUENCE.length * 2 + extraFreqs.left.length + extraFreqs.right.length;
  const doneSteps = (ear === "left" ? CORE_SEQUENCE.length + extraFreqs.right.length : 0) + stepIndex;
  const progress = Math.round((doneSteps / Math.max(1, totalSteps)) * 100);

  return (
    <div className="stack stack-5">
      {/* Guided is the default and the clinical procedure; manual is the
          audiometer. One or the other, never both driving the audio at once.
          Hidden mid-session (guided, actively testing) so the continuous
          screen stays free of chrome the patient never needs — still
          reachable before starting and once the session pauses, stops or
          completes. */}
      {(mode === "manual" || sessionPhase === "intro" || sessionPhase === "paused" || sessionPhase === "complete") && (
        <div className="row row--between row--wrap">
          <div className="btn-group">
            <button
              type="button"
              className="btn btn--sm"
              aria-pressed={mode === "guided"}
              onClick={() => {
                clearTimers();
                engine.stopAll(0.05);
                setMode("guided");
              }}
            >
              {t("audiometry.modeGuided")}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              aria-pressed={mode === "manual"}
              onClick={() => {
                clearTimers();
                engine.stopAll(0.05);
                setMode("manual");
              }}
            >
              {t("audiometry.modeManual")}
            </button>
          </div>
          <Chip tone="ghost">{t("audiometry.stimulusPureTone")}</Chip>
        </div>
      )}

      {mode === "manual" ? (
        <ManualThreshold
          audiogram={audiogram}
          ear={ear}
          onEar={setEar}
          onRecord={(side, freqHz, dbHl) =>
            setAudiogram((prev) => ({
              ...prev,
              [side]: { ...(prev[side] ?? {}), [String(freqHz)]: dbHl },
            }))
          }
          onClear={(side, freqHz) =>
            setAudiogram((prev) => {
              const next = { ...(prev[side] ?? {}) };
              delete next[String(freqHz)];
              return { ...prev, [side]: next };
            })
          }
          onDone={complete}
        />
      ) : sessionPhase === "intro" ? (
        <IntroScreen resuming={!!resumed} onStart={start} onSkip={onSkip} />
      ) : sessionPhase === "paused" ? (
        <PausedScreen onResume={resumeSession} onExitConfirm={openExitConfirm} />
      ) : sessionPhase === "confirmExit" ? (
        <ConfirmExitScreen onContinue={continueTesting} onExit={exitTest} />
      ) : (
      <div className="grid grid-sidebar" style={{ ["--aside" as string]: "300px" }}>
        {/* -- test panel ----------------------------------------------------- */}
        <Panel bracketed>
          <div className="row row--between" style={{ marginBottom: "var(--s5)" }}>
            <div className="row row--tight">
              <Chip tone={ear === "right" ? "crit" : "info"} dot>
                {t(ear === "left" ? "audiometry.leftEar" : "audiometry.rightEar")}
              </Chip>
              {sessionPhase === "active" && (
                <Chip tone="ghost">
                  {isRetestStep
                    ? t("audiometry.retestChip")
                    : t("audiometry.stepOf", { current: doneSteps + 1, total: totalSteps })}
                </Chip>
              )}
              {sessionPhase === "active" && isInterOctave && (
                <Chip tone="warn" title={t("audiometry.interOctaveTitle", { gap: INTER_OCTAVE_GAP_DB })}>
                  {t("audiometry.extraFrequency")}
                </Chip>
              )}
              {phase === "presenting" && !isCatchTrial && (
                <Chip tone="signal" live>
                  {t("audiometry.tonePlaying")}
                </Chip>
              )}
              {phase === "presenting" && isCatchTrial && (
                <Chip tone="ghost">{t("audiometry.listening")}</Chip>
              )}
            </div>
            <div className="row row--tight row--nowrap">
              <span className="mono meta">{progress}%</span>
            </div>
          </div>

          <div className="center stack stack-5" style={{ paddingBlock: "var(--s6)" }}>
            <Readout
              label={t("audiometry.testFrequency")}
              value={freq >= 1000 ? `${freq / 1000}` : freq}
              unit={freq >= 1000 ? "kHz" : "Hz"}
              size="lg"
              tone="data"
            />

            <div>
              <span className="label center" style={{ marginBottom: "var(--s2)" }}>
                {t("audiometry.presentingAt")}
              </span>
              <Readout
                label=""
                value={tracker.current?.currentLevel ?? "—"}
                unit="dB HL"
                size="md"
                tone="signal"
              />
            </div>

            {/* The only moment nothing is playing during an active session:
                the brief gap while the tracker rebuilds for the next
                frequency, before the auto-advance effect calls `present()`.
                No button here any more — that effect is the trigger now,
                not a patient click, which is the whole point of "continuous". */}
            {phase === "idle" && (
              <div className="stack stack-2" style={{ minHeight: 78 }}>
                <span className="meta" aria-live="polite">
                  {t("audiometry.nextFrequency", { defaultValue: "Preparing next measurement…" })}
                </span>
              </div>
            )}

            {(phase === "presenting" || phase === "gap") && (
              <div className="stack stack-3">
                <button
                  type="button"
                  className={`btn btn--lg ${responded ? "btn--ink" : "btn--primary"}`}
                  style={{ minWidth: 240, minHeight: 78, fontSize: "1.125rem" }}
                  onClick={respond}
                  disabled={phase !== "presenting"}
                >
                  {responded ? (
                    <>
                      <IconCheck size={15} />
                      {t("audiometry.responseRecorded")}
                    </>
                  ) : (
                    t("audiometry.iHearIt")
                  )}
                </button>
                <p className="meta">
                  <Trans i18nKey="audiometry.orPressSpace" components={[<Kbd key="0" />]} />
                </p>
                <div className="row" style={{ justifyContent: "center" }}>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={previousFrequency}
                    disabled={!canGoBack}
                    title={t("audiometry.previousHint")}
                  >
                    ← {t("audiometry.previous")}
                  </button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={pause}>
                    {t("audiometry.pause")}
                  </button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={skipFrequency}>
                    {t("audiometry.skipFrequency")}
                  </button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={openExitConfirm}>
                    {t("audiometry.stopTest", { defaultValue: "Stop" })}
                  </button>
                </div>
              </div>
            )}

            {sessionPhase === "complete" && phase === "done" && (
              <div className="stack stack-3">
                <Chip tone={measuredCount > 0 ? "ok" : "crit"} dot>
                  {t("audiometry.sessionCompleteTitle", { defaultValue: "Hearing measurement complete" })}
                </Chip>

                {/* What was actually captured, in the one place where it can
                    still be put right. */}
                <p className="meta">
                  {t("audiometry.measuredSummary", {
                    measured: measuredCount,
                    total: totalSteps,
                  })}
                  {skippedCount > 0 && ` ${t("audiometry.skippedSummary", { count: skippedCount })}`}
                </p>

                {measuredCount === 0 ? (
                  // Nothing was measured. Saving this would produce a finished-
                  // looking assessment with no audiogram, no graph and no 3D
                  // model, and no explanation anywhere of why.
                  <Panel tone="crit" tight>
                    <div className="stack stack-2">
                      <span className="label">{t("audiometry.noThresholdsTitle")}</span>
                      <p className="meta">{t("audiometry.noThresholdsBody")}</p>
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={() => {
                          setEar("right");
                          setStepIndex(0);
                          setResults([]);
                          setRetest({ first: null, second: null });
                          setPhase("idle");
                          setSessionPhase("active");
                        }}
                      >
                        {t("audiometry.restart")}
                      </button>
                    </div>
                  </Panel>
                ) : (
                  <button type="button" className="btn btn--primary btn--lg" onClick={complete}>
                    {t("audiometry.viewAudiogram", { defaultValue: "View audiogram" })}
                  </button>
                )}
              </div>
            )}
          </div>

          {phase !== "idle" && phase !== "done" && (
            <>
              <hr className="rule" />
              <div className="row row--between">
                <span className="meta">
                  {t("audiometry.presentationCount", {
                    count: (tracker.current?.presentationCount ?? 0) + 1,
                  })}
                </span>
                <span className="meta">
                  {t("audiometry.catchTrials", { count: catchTrials })}
                  {falsePositives > 0 && (
                    <span style={{ color: "var(--crit-ink)" }}>
                      {t("audiometry.falsePositiveSuffix", { count: falsePositives })}
                    </span>
                  )}
                </span>
              </div>
            </>
          )}
        </Panel>

        {/* -- live audiogram + reliability ----------------------------------- */}
        <div className="stack stack-4">
          <Panel title={t("audiometry.progress", { defaultValue: "Progress" })} tight headPlain>
            <FrequencyProgressGrid audiogram={audiogram} extraFreqs={extraFreqs} t={t} />
          </Panel>

          <Panel title={t("audiometry.liveAudiogram")} tight headPlain>
            <Audiogram audiogram={audiogram} height={280} showLegend />
          </Panel>

          <Panel title={t("audiometry.reliability")} tight headPlain>
            <div className="stack stack-2">
              <div className="row row--between">
                <span className="meta">{t("audiometry.catchTrialsLabel")}</span>
                <span className="mono" style={{ fontSize: "var(--fs-small)" }}>
                  {t("audiometry.falseOf", { false: falsePositives, total: catchTrials })}
                </span>
              </div>
              <div className="row row--between">
                <span className="meta">{t("audiometry.retestLabel")}</span>
                <span className="mono" style={{ fontSize: "var(--fs-small)" }}>
                  {retest.first !== null && retest.second !== null
                    ? `${Math.abs(retest.first - retest.second)} dB`
                    : retest.first !== null
                      ? t("audiometry.pending")
                      : "—"}
                </span>
              </div>
              <div className="row row--between">
                <span className="meta">{t("audiometry.frequenciesDone")}</span>
                <span className="mono" style={{ fontSize: "var(--fs-small)" }}>
                  {results.length}/{totalSteps}
                </span>
              </div>
              <div className="row row--between">
                <span className="meta">{t("audiometry.extraFrequencies")}</span>
                <span className="mono" style={{ fontSize: "var(--fs-small)" }}>
                  {extraFreqs.right.length + extraFreqs.left.length || t("audiometry.none")}
                </span>
              </div>
              <p className="meta dim" style={{ marginTop: "var(--s2)" }}>
                {t("audiometry.catchNote")}
              </p>
              <p className="meta dim">
                {t("audiometry.interOctaveNote", { gap: INTER_OCTAVE_GAP_DB })}
              </p>
            </div>
          </Panel>

          {phase === "done" && results.some((r) => !r.reliable) && (
            <Panel tone="warn" tight>
              <span className="label">{t("audiometry.repeatTitle")}</span>
              <ul style={{ margin: "var(--s2) 0 0", paddingLeft: "var(--s5)", fontSize: "var(--fs-tiny)" }}>
                {results
                  .filter((r) => !r.reliable)
                  .map((r, i) => (
                    <li key={i}>
                      {t(r.ear === "left" ? "audiometry.leftEar" : "audiometry.rightEar")} {r.freq} Hz —{" "}
                      {r.note}
                    </li>
                  ))}
              </ul>
            </Panel>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Continuous-session screens                                                */
/* ------------------------------------------------------------------------- */

/**
 * The one manual "Start" left in the whole guided flow. Everything the
 * duration estimate below says is derived directly from the existing timing
 * already in `present()` — the 1.9 s response window plus `nextDelayMs()`'s
 * 0.9–2.3 s gap, times the ~6–12 presentations a frequency typically takes
 * (see `shouldInsertCatchTrial`'s own doc comment), times up to 16
 * frequency/ear searches — not a clinical claim, just arithmetic on numbers
 * already in this file.
 */
function IntroScreen({
  resuming,
  onStart,
  onSkip,
}: {
  resuming: boolean;
  onStart(): void;
  onSkip?(): void;
}) {
  const { t } = useTranslation();
  return (
    <Panel bracketed>
      <div className="center stack stack-5" style={{ paddingBlock: "var(--s6)" }}>
        <div className="stack stack-3" style={{ maxWidth: "34em", marginInline: "auto", textAlign: "center" }}>
          <h2 style={{ margin: 0 }}>{t("audiometry.introTitle", { defaultValue: "Hearing measurement" })}</h2>
          <p style={{ fontSize: "var(--fs-body)" }}>
            {resuming
              ? t("audiometry.introResuming", {
                  defaultValue:
                    "You already have some measurements on file for this test. It will pick up from where you left off rather than starting over.",
                })
              : t("audiometry.introLead", { defaultValue: "You'll hear a series of soft tones." })}
          </p>
          <p style={{ fontSize: "var(--fs-body)" }}>
            {t("audiometry.introInstruction", {
              defaultValue: 'Press "I heard it" whenever you hear a tone.',
            })}
          </p>
          <p className="meta">
            {t("audiometry.introAuto", {
              defaultValue:
                "The test will automatically adjust the sound level to estimate the softest sound you can hear. You do not need to adjust the volume yourself.",
            })}
          </p>
          <p className="meta">
            {t("audiometry.introDuration", { defaultValue: "Estimated duration: about 5–10 minutes." })}
          </p>
        </div>
        <button type="button" className="btn btn--primary btn--lg" onClick={onStart}>
          {t("audiometry.introStart", { defaultValue: "Start Hearing Test" })}
        </button>
        {onSkip && (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={onSkip}
            title={t("audiometry.skipModuleHint")}
          >
            {t("audiometry.skipModule")}
          </button>
        )}
      </div>
    </Panel>
  );
}

function PausedScreen({ onResume, onExitConfirm }: { onResume(): void; onExitConfirm(): void }) {
  const { t } = useTranslation();
  return (
    <Panel bracketed tone="warn">
      <div className="center stack stack-4" style={{ paddingBlock: "var(--s6)" }}>
        <h2 style={{ margin: 0 }}>{t("audiometry.pausedTitle", { defaultValue: "Hearing test paused" })}</h2>
        <p className="meta">
          {t("audiometry.pausedBody", { defaultValue: "Your progress has been saved temporarily." })}
        </p>
        <div className="row row--tight" style={{ justifyContent: "center" }}>
          <button type="button" className="btn btn--primary btn--lg" onClick={onResume}>
            {t("audiometry.resumeTest", { defaultValue: "Resume Test" })}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={onExitConfirm}>
            {t("audiometry.stopTest", { defaultValue: "Stop" })}
          </button>
        </div>
      </div>
    </Panel>
  );
}

/** The safe-exit confirmation — rule 21. Testing is already paused (audio
 *  and timers stopped) by `openExitConfirm` before this ever renders. */
function ConfirmExitScreen({ onContinue, onExit }: { onContinue(): void; onExit(): void }) {
  const { t } = useTranslation();
  return (
    <Panel bracketed tone="crit">
      <div className="center stack stack-4" style={{ paddingBlock: "var(--s6)" }}>
        <h2 style={{ margin: 0 }}>{t("audiometry.confirmExitTitle", { defaultValue: "Stop hearing test?" })}</h2>
        <p className="meta" style={{ maxWidth: "34em" }}>
          {t("audiometry.confirmExitBody", {
            defaultValue:
              "Your current measurements will be preserved, but the audiogram will not be marked complete until the required measurements are finished.",
          })}
        </p>
        <div className="row row--tight" style={{ justifyContent: "center" }}>
          <button type="button" className="btn btn--primary" onClick={onContinue}>
            {t("audiometry.continueTesting", { defaultValue: "Continue Testing" })}
          </button>
          <button type="button" className="btn btn--ghost" onClick={onExit}>
            {t("audiometry.exitTest", { defaultValue: "Exit Test" })}
          </button>
        </div>
      </div>
    </Panel>
  );
}

/** Meaningful progress (rule 8) — one row per threshold actually being
 *  sought, not one per stimulus presentation. `extraFreqs` deliberately only
 *  ever contains 3 kHz / 6 kHz once the inter-octave rule has decided they
 *  are needed for that ear, so an ear that never triggers them never shows a
 *  pending row for a measurement that may not happen. */
const CORE_UNIQUE_FREQS = Array.from(new Set(CORE_SEQUENCE)).sort((a, b) => a - b);

function FrequencyProgressGrid({
  audiogram,
  extraFreqs,
  t,
}: {
  audiogram: Record<Ear, Record<string, number>>;
  extraFreqs: Record<Ear, number[]>;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  function column(ear: Ear) {
    const freqs = [...CORE_UNIQUE_FREQS, ...extraFreqs[ear]].sort((a, b) => a - b);
    return (
      <div className="stack stack-1">
        <span className="label center">{t(ear === "left" ? "audiometry.leftEar" : "audiometry.rightEar")}</span>
        {freqs.map((f) => {
          const measured = String(f) in (audiogram[ear] ?? {});
          const label = f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`;
          const statusLabel = t(
            measured ? "audiometry.measuredStatus" : "audiometry.remainingStatus",
            { defaultValue: measured ? "measured" : "remaining" }
          );
          return (
            <div
              key={f}
              className="row row--between"
              style={{ fontSize: "var(--fs-small)" }}
              aria-label={`${label} ${statusLabel}`}
            >
              <span className="mono">{f >= 1000 ? `${f / 1000}k` : f}</span>
              <span aria-hidden="true">{measured ? "●" : "○"}</span>
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <div className="grid grid-2" style={{ gap: "var(--s4)" }}>
      {column("right")}
      {column("left")}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Manual mode — the audiometer                                               */
/* ------------------------------------------------------------------------- */
/**
 * Frequency and level under the operator's hand, with a button to record the
 * threshold at the current setting.
 *
 * The frequency slider steps through the standard audiometric ladder rather
 * than sweeping continuously. That is deliberate on two counts: it is what an
 * audiometer offers, and it keeps the keys of the stored audiogram to the
 * frequencies every downstream consumer already understands — the WHO grading,
 * the notch detector, the Greenwood placement in the 3D cochlea and the report's
 * own tables all read specific frequencies, and a threshold recorded at 1373 Hz
 * would be stored faithfully and then ignored by all of them.
 *
 * Level steps in 5 dB, the audiometric convention and the same step the adaptive
 * tracker ascends in.
 */
const MANUAL_FREQS = [250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000];

function ManualThreshold({
  audiogram,
  ear,
  onEar,
  onRecord,
  onClear,
  onDone,
}: {
  audiogram: Record<Ear, Record<string, number>>;
  ear: Ear;
  onEar(ear: Ear): void;
  onRecord(ear: Ear, hz: number, dbHl: number): void;
  onClear(ear: Ear, hz: number): void;
  onDone(): void;
}) {
  const { t } = useTranslation();
  const [freqIndex, setFreqIndex] = useState(3); // 1 kHz — where audiometry starts
  const [level, setLevel] = useState(40);
  const [playing, setPlaying] = useState(false);
  const handleRef = useRef<{ stop(f?: number): void } | null>(null);

  const hz = MANUAL_FREQS[freqIndex];
  const ceiling = Math.min(90, Math.round(engine.maxReachableHl(hz)));
  const recorded = audiogram[ear]?.[String(hz)];

  const stop = useCallback(() => {
    handleRef.current?.stop(0.05);
    handleRef.current = null;
    engine.stopAll(0.05);
  }, []);

  useEffect(() => () => stop(), [stop]);

  // A continuous tone that follows the sliders, so frequency and level can be
  // hunted the way they are on a real audiometer rather than re-triggered for
  // every step.
  useEffect(() => {
    if (!playing) return;
    stop();
    handleRef.current = engine.playTone({
      freq: hz,
      dbHL: Math.min(level, ceiling),
      ear,
      durationMs: null,
      rampMs: 25,
    });
  }, [hz, level, ear, ceiling, playing, stop]);

  const measuredCount =
    Object.keys(audiogram.left ?? {}).length + Object.keys(audiogram.right ?? {}).length;

  return (
    <div className="grid grid-sidebar" style={{ ["--aside" as string]: "300px" }}>
      <Panel bracketed title={t("audiometry.manualTitle")}>
        <div className="stack stack-5">
          <p className="meta" style={{ maxWidth: "48em" }}>
            {t("audiometry.manualLead")}
          </p>

          <div className="row row--tight">
            {(["right", "left"] as const).map((side) => (
              <button
                key={side}
                type="button"
                className={`btn btn--sm${ear === side ? " btn--primary" : ""}`}
                aria-pressed={ear === side}
                onClick={() => {
                  stop();
                  setPlaying(false);
                  onEar(side);
                }}
              >
                {t(side === "left" ? "audiometry.leftEar" : "audiometry.rightEar")}
              </button>
            ))}
          </div>

          <Readout
            label={t("audiometry.testFrequency")}
            value={hz >= 1000 ? hz / 1000 : hz}
            unit={hz >= 1000 ? "kHz" : "Hz"}
            size="lg"
            tone="data"
            note={t("audiometry.manualRecorded", {
              value: recorded === undefined ? "—" : `${recorded} dB HL`,
            })}
          />

          <SteppedSlider
            value={freqIndex}
            min={0}
            max={MANUAL_FREQS.length - 1}
            step={1}
            onChange={setFreqIndex}
            format={(i) => {
              const f = MANUAL_FREQS[i];
              return f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`;
            }}
            label={t("audiometry.manualFrequency")}
            ariaLabel={t("audiometry.manualFrequency")}
            lowLabel="250 Hz"
            highLabel="8 kHz"
          />

          <SteppedSlider
            value={Math.min(level, ceiling)}
            min={-10}
            max={ceiling}
            step={5}
            onChange={setLevel}
            format={(v) => `${v} dB HL`}
            label={t("audiometry.manualLevel")}
            ariaLabel={t("audiometry.manualLevel")}
            lowLabel={t("audiometry.manualQuiet")}
            highLabel={t("audiometry.manualLoud")}
            tone="data"
          />

          <div className="row row--tight row--wrap">
            <button
              type="button"
              className={`btn ${playing ? "" : "btn--primary"}`}
              onClick={async () => {
                if (playing) {
                  stop();
                  setPlaying(false);
                  return;
                }
                await engine.resume();
                setPlaying(true);
              }}
            >
              {playing ? <IconStop size={15} /> : <IconPlay size={15} />}
              {t(playing ? "audiometry.manualStop" : "audiometry.manualPlay")}
            </button>

            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                onRecord(ear, hz, Math.min(level, ceiling));
                stop();
                setPlaying(false);
              }}
            >
              <IconCheck size={14} />
              {t("audiometry.manualRecord")}
            </button>

            {recorded !== undefined && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => onClear(ear, hz)}>
                {t("audiometry.manualClear")}
              </button>
            )}
          </div>

          <hr className="rule" />

          <div className="row row--between">
            <span className="meta">
              {t("audiometry.measuredSummary", { measured: measuredCount, total: MANUAL_FREQS.length * 2 })}
            </span>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                stop();
                onDone();
              }}
              disabled={measuredCount === 0}
            >
              {t("audiometry.saveAndContinue")}
            </button>
          </div>
        </div>
      </Panel>

      <div className="stack stack-4">
        <Panel title={t("audiometry.liveAudiogram")} tight headPlain>
          <Audiogram audiogram={audiogram} height={280} showLegend />
        </Panel>
      </div>
    </div>
  );
}
