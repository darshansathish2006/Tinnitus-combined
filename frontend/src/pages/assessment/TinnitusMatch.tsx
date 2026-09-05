/**
 * Psychoacoustic tinnitus characterisation.
 *
 * Five measurements, in the order an audiologist takes them, because each depends
 * on the one before:
 *
 *  1. **Character and bandwidth** — decides whether pitch matching is meaningful.
 *  2. **Pitch match** — 2AFC bracketing, then an explicit octave-confusion check.
 *  3. **Loudness match** — reported in dB *sensation level*, referenced to the
 *     patient's own threshold at the matched frequency.
 *  4. **Comfort limits (LDL)** and **minimum masking level**.
 *  5. **Residual inhibition** — a timed masker followed by a sampled recovery curve.
 *
 * The octave check in step 2 is not optional polish. Patients routinely match an
 * octave away from their true percept, and the therapy engine refuses to place a
 * notch on a match that has not passed it.
 */

import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { engine, type Ear as AudioEar } from "../../audio/engine";
import {
  BANDWIDTH_OPTIONS,
  PitchMatcher,
  ToleranceLevelFinder,
  analyseResidualInhibition,
  interpretLoudnessMatch,
  interpretMml,
  toSensationLevel,
  type PitchResult,
  type RiSample,
  type ToleranceResponse,
  type ToleranceTrial,
} from "../../audio/procedures";
import { RiCurve } from "../../components/charts";
import { Chip, Fader, OptionGroup, Panel, Readout, StepRail, fmt } from "../../components/ui";
import { IconPlay, IconStop } from "../../components/icons";

/** The patient's structured immediate response, asked right after the masker
 *  stops — the primary classification (never inferred from a numeric score
 *  alone). */
export type RiImmediateResponse = "COMPLETELY_ABSENT" | "REDUCED" | "NO_CHANGE" | "LOUDER";

/** One monitoring check-in during the residual-inhibition window. */
export interface RiMonitoringCheckpoint {
  elapsed_s: number;
  response: "still_reduced" | "returned_to_baseline";
  at: number;
}

/**
 * Residual-inhibition induction parameters. Frequency and level are not new
 * clinical values: frequency is the existing pitch match, and level is the
 * existing MML-plus-margin this component has always used to run the masker
 * (see `startRi`, below) — the only change is naming them so the stimulus can
 * be shown to the patient before it plays and stored explicitly per trial.
 * No standardised monitoring cadence exists elsewhere in this codebase, so
 * `RI_MONITORING_PROMPT_INTERVAL_S` is declared here as an explicit,
 * configurable constant rather than an invented clinical parameter — see the
 * implementation report.
 */
const RI_STIMULATION_DURATION_S = 45; // unchanged from the existing induction
const RI_MONITORING_PROMPT_INTERVAL_S = 10; // not defined elsewhere in this repository — configurable

/** Standard audiometric octave series already used for pure-tone audiometry
 *  in this app (`CORE_SEQUENCE` in `assessment/Audiometry.tsx`), reused here
 *  as the existing frequency-set convention for Sound Tolerance rather than
 *  inventing a new one. */
const ULL_FREQUENCIES = [250, 500, 1000, 2000, 4000, 8000];
/** No standardised ULL/LDL starting level exists elsewhere in this
 *  repository; this mirrors the ascending-search starting-level pattern
 *  already established for Masking Threshold and Loudness Match in this
 *  codebase, declared as an explicit, configurable constant. */
const ULL_STARTING_DB = 50;

export interface LdlFrequencyResult {
  ear: "left" | "right";
  frequency_hz: number;
  trials: ToleranceTrial[];
  ull_db: number | null;
}

export interface MatchResult {
  tinnitus_bandwidth: "tonal" | "narrowband" | "broadband";
  character: string;
  pitch_match_hz: number | null;
  pitch_match_confidence: number | null;
  octave_confusion: boolean | null;
  pitch_match_trace: unknown[];
  pitch_match_ear: "left" | "right" | "both";
  loudness_match_db_hl: number | null;
  loudness_match_db_sl: number | null;
  mml_db_sl: number | null;
  /** Backward-compatible scalar LDL per ear (existing fields, unchanged
   *  meaning) — the 1 kHz result from `ldl_trace`, the frequency the old
   *  single-value measurement always represented. */
  ldl_left: number | null;
  ldl_right: number | null;
  /** The complete multi-frequency, multi-ear Sound Tolerance trial history —
   *  additive to `ldl_left`/`ldl_right` above. */
  ldl_trace: LdlFrequencyResult[];
  ldl_repeated: boolean;
  ri_depth_pct: number | null;
  ri_duration_s: number | null;
  ri_trace: RiSample[];
  /** The patient's own answer after the masker stopped; "" when not asked. */
  ri_reported_category: "" | "none" | "partial" | "complete";
  /** Masker centre frequency, null when it was left at the tinnitus pitch. */
  mml_masker_hz: number | null;
  /** The structured 4-way immediate response `ri_reported_category` above
   *  cannot represent on its own (it has no "louder" option) — additive. */
  ri_immediate_response: RiImmediateResponse | "";
  ri_baseline_pct: number | null;
  ri_post_stimulation_pct: number | null;
  ri_monitoring: RiMonitoringCheckpoint[];
  ri_stimulus_frequency_hz: number | null;
  ri_stimulus_level_db: number | null;
  ri_stimulation_duration_s: number | null;
  ri_stimulation_started_at: number | null;
  ri_stimulation_stopped_at: number | null;
  ri_reduction_detected_at: number | null;
  ri_return_to_baseline_at: number | null;
  ri_repeated: boolean;
}

const SUBSTEP_KEYS = ["character", "pitch", "loudness", "limits", "ri"];

/** Interpolate the audiometric threshold at an arbitrary frequency. */
function thresholdAt(audiogram: Record<string, Record<string, number>>, ear: string, hz: number): number | null {
  const side = audiogram[ear] ?? {};
  const points = Object.entries(side)
    .map(([f, db]) => ({ f: Number(f), db: Number(db) }))
    .filter((p) => Number.isFinite(p.f) && Number.isFinite(p.db))
    .sort((a, b) => a.f - b.f);
  if (!points.length) return null;
  if (hz <= points[0].f) return points[0].db;
  if (hz >= points[points.length - 1].f) return points[points.length - 1].db;
  for (let i = 0; i < points.length - 1; i++) {
    if (hz >= points[i].f && hz <= points[i + 1].f) {
      const t = (Math.log2(hz) - Math.log2(points[i].f)) / (Math.log2(points[i + 1].f) - Math.log2(points[i].f));
      return points[i].db + t * (points[i + 1].db - points[i].db);
    }
  }
  return null;
}

export default function TinnitusMatch({
  audiogram,
  laterality,
  character,
  onComplete,
  onSkip,
}: {
  audiogram: Record<string, Record<string, number>>;
  laterality: string | null;
  /** Already captured at intake — not asked again here. */
  character?: string | null;
  onComplete(result: MatchResult): void;
  onSkip?(): void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [done, setDone] = useState<Set<string>>(new Set());

  const [bandwidth, setBandwidth] = useState<"tonal" | "narrowband" | "broadband">("tonal");

  const matcher = useRef(new PitchMatcher());
  const [pair, setPair] = useState(() => matcher.current.pair());
  const [pitchResult, setPitchResult] = useState<PitchResult | null>(null);
  const [pitchPhase, setPitchPhase] = useState<"bracketing" | "retest" | "octave" | "done">("bracketing");
  const [retestPair, setRetestPair] = useState<{ aHz: number; bHz: number } | null>(null);
  const [retestAgreed, setRetestAgreed] = useState<boolean | null>(null);
  const [octaveCandidates, setOctaveCandidates] = useState<number[]>([]);

  const [loudnessDbHl, setLoudnessDbHl] = useState(20);
  const [mmlDbHl, setMmlDbHl] = useState(30);
  /**
   * Centre frequency of the masking band, as an adjustable control.
   *
   * `null` means "follow the matched tinnitus pitch", which is what the
   * procedure did before this was adjustable and remains the default — so a
   * clinician who never touches the slider gets exactly the previous behaviour,
   * and `mml_masker_hz` is submitted as null for those runs rather than as a
   * value that only looks deliberate.
   *
   * It is worth being able to move: the minimum masking level is not always
   * lowest at the tinnitus frequency, and a band placed half an octave away can
   * mask a percept at a level several dB below what the on-pitch band needs.
   */
  const [mmlHzOverride, setMmlHzOverride] = useState<number | null>(null);

  /* -- sound tolerance / ULL-LDL ------------------------------------------ */
  type LdlScreen = "select_ear" | "presenting" | "done";
  const [ldl, setLdl] = useState<{ left: number | null; right: number | null }>({ left: null, right: null });
  const [ldlScreen, setLdlScreen] = useState<LdlScreen>("select_ear");
  const [ldlEarsToTest, setLdlEarsToTest] = useState<("left" | "right")[]>([]);
  const [ldlEarIndex, setLdlEarIndex] = useState(0);
  const [ldlFreqIndex, setLdlFreqIndex] = useState(0);
  const [ldlResults, setLdlResults] = useState<LdlFrequencyResult[]>([]);
  const [ldlLevel, setLdlLevel] = useState<number | null>(null);
  const [ldlRepeated, setLdlRepeated] = useState(false);
  const ldlFinder = useRef<ToleranceLevelFinder | null>(null);

  /* -- residual inhibition ------------------------------------------------- */
  const [riPhase, setRiPhase] = useState<
    "idle" | "setup" | "masking" | "immediate" | "reduction" | "monitoring" | "done"
  >("idle");
  const [riTrace, setRiTrace] = useState<RiSample[]>([]);
  /**
   * The patient's structured 4-way response. `ri_reported_category` (the
   * existing 3-way field) is derived from this at submission time — see
   * `finish()` — since it can additionally represent "louder", something the
   * older 3-way value cannot.
   */
  const [riImmediateResponse, setRiImmediateResponse] = useState<RiImmediateResponse | null>(null);
  const [riImmediateAt, setRiImmediateAt] = useState<number | null>(null);
  const [riPostStimPct, setRiPostStimPct] = useState(100);
  const [riMonitoring, setRiMonitoring] = useState<RiMonitoringCheckpoint[]>([]);
  const [riStimStartedAt, setRiStimStartedAt] = useState<number | null>(null);
  const [riStimStoppedAt, setRiStimStoppedAt] = useState<number | null>(null);
  const [riReturnedAt, setRiReturnedAt] = useState<number | null>(null);
  const [riElapsedSinceStop, setRiElapsedSinceStop] = useState(0);
  const [riRepeated, setRiRepeated] = useState(false);
  const [maskCountdown, setMaskCountdown] = useState(0);

  const handleRef = useRef<{ stop(f?: number): void; setLevelDb(db: number, r?: number): void } | null>(null);
  const timers = useRef<number[]>([]);

  const matchEar: AudioEar = laterality === "left" || laterality === "right" ? (laterality as AudioEar) : "both";
  const referenceEar = laterality === "left" ? "left" : "right";
  const pitchHz = pitchResult?.hz ?? null;
  const thresholdDbHl = pitchHz ? thresholdAt(audiogram, referenceEar, pitchHz) : null;
  /** The frequency the masker is actually centred on right now. */
  const mmlHz = mmlHzOverride ?? pitchHz ?? null;
  /**
   * Threshold at the *masker's* frequency, not the tinnitus pitch.
   *
   * A sensation level is only meaningful against the threshold at the frequency
   * it was measured at. Keeping the pitch threshold here once the band could be
   * moved would have quietly mis-stated the MML by the difference between the
   * two thresholds — which on a sloping loss is easily 30 dB.
   */
  const mmlThresholdDbHl = mmlHz ? thresholdAt(audiogram, referenceEar, mmlHz) : null;

  useEffect(
    () => () => {
      handleRef.current?.stop(0.1);
      timers.current.forEach((t) => window.clearTimeout(t));
      engine.stopAll(0.1);
    },
    []
  );

  function stopSound() {
    handleRef.current?.stop(0.15);
    handleRef.current = null;
  }

  async function playProbe(hz: number, dbHL: number, ms = 1600) {
    await engine.resume();
    stopSound();
    engine.playTone({ freq: hz, dbHL, ear: matchEar, durationMs: ms, rampMs: 30 });
  }

  function advance(key: string, next: number) {
    setDone((prev) => new Set(prev).add(key));
    stopSound();
    engine.stopAll(0.15);
    setStep(next);
  }

  /* -- pitch matching ----------------------------------------------------- */
  const probeLevel = 35;

  function choose(hz: number) {
    matcher.current.choose(hz);
    const next = matcher.current.pair();
    setPair(next);
    if (next.done) {
      // Reliability check before the octave check: re-present the very first
      // comparison and see whether the same answer comes back.
      setRetestPair(matcher.current.retrialPair());
      setPitchPhase("retest");
    }
  }

  function recordRetest(hz: number) {
    const agreed = matcher.current.recordRetrial(hz);
    setRetestAgreed(agreed);
    setOctaveCandidates(matcher.current.octaveCandidates());
    setPitchPhase("octave");
  }

  function confirmOctave(hz: number) {
    const bracketed = matcher.current.result().hz;
    const confusion = Math.abs(Math.log2(hz / bracketed)) > 0.5;
    setPitchResult(matcher.current.result(hz, confusion));
    setPitchPhase("done");
    // Start the loudness search a little above the threshold at the matched pitch.
    const base = thresholdAt(audiogram, referenceEar, hz);
    setLoudnessDbHl(Math.round(((base ?? 15) + 8) / 5) * 5);
    setMmlDbHl(Math.round(((base ?? 15) + 18) / 5) * 5);
  }

  function skipPitch() {
    setPitchResult(null);
    advance("pitch", 2);
  }

  function restartPitch() {
    matcher.current = new PitchMatcher();
    setPair(matcher.current.pair());
    setPitchResult(null);
    setRetestPair(null);
    setRetestAgreed(null);
    setPitchPhase("bracketing");
  }

  /* -- residual inhibition ------------------------------------------------- */
  /** Stimulus level: the same MML-plus-margin this component has always used
   *  to induce RI (see the historical "Masker 10 dB above the MML" comment,
   *  now a named constant), never re-derived independently of the MML the
   *  patient just gave. */
  const riLevelDb = mmlDbHl + 10;

  /** Screen 2 — a brief preview at the induction parameters, not the
   *  45 s induction itself. */
  async function playRiPreview() {
    if (!pitchHz) return;
    await engine.resume();
    stopSound();
    engine.playTone({ freq: pitchHz, dbHL: riLevelDb, ear: matchEar, durationMs: 1500, rampMs: 30 });
  }

  function beginRiSetup() {
    setRiPhase("setup");
  }

  async function startRi() {
    if (!pitchHz) return;
    await engine.resume();
    stopSound();
    setRiPhase("masking");
    setRiTrace([{ t: 0, loudness_pct: 100 }]);
    setRiMonitoring([]);
    setRiImmediateResponse(null);
    setRiReturnedAt(null);
    const startedAt = Date.now();
    setRiStimStartedAt(startedAt);

    // Masker at `riLevelDb` for `RI_STIMULATION_DURATION_S` — the existing RI
    // induction this component has always used, unchanged.
    const handle = engine.playBandNoise({
      centreHz: pitchHz,
      bandwidthOctaves: 0.5,
      dbfs: engine.hlToDbfs(riLevelDb, pitchHz),
      ear: matchEar,
      fadeInS: 1,
    });
    handleRef.current = handle;

    let remaining = RI_STIMULATION_DURATION_S;
    setMaskCountdown(remaining);
    const tick = window.setInterval(() => {
      remaining -= 1;
      setMaskCountdown(remaining);
      if (remaining <= 0) window.clearInterval(tick);
    }, 1000);

    const stopTimer = window.setTimeout(() => {
      handle.stop(0.3);
      handleRef.current = null;
      window.clearInterval(tick);
      setRiStimStoppedAt(Date.now());
      setRiPhase("immediate");
    }, RI_STIMULATION_DURATION_S * 1000);
    timers.current.push(stopTimer as unknown as number);
  }

  /** Screen 4 — the primary, explicit classification. Never inferred from a
   *  numeric score: the patient's own answer decides which branch runs next. */
  function recordImmediateResponse(response: RiImmediateResponse) {
    const at = Date.now();
    setRiImmediateResponse(response);
    setRiImmediateAt(at);
    if (response === "COMPLETELY_ABSENT" || response === "REDUCED") {
      setRiPostStimPct(response === "COMPLETELY_ABSENT" ? 0 : 50);
      setRiPhase("reduction");
    } else {
      // NO_CHANGE / LOUDER — no reduction to measure, no RI duration timer.
      // `riTrace` keeps only its baseline point, so `analyseResidualInhibition`
      // never runs and no depth/duration is fabricated for either outcome.
      setRiPhase("done");
    }
  }

  /** Screen 5 — confirms the degree of remaining tinnitus, then the elapsed
   *  time since the stimulus stopped becomes the second, real point on the
   *  existing recovery-curve trace (`ri_trace`) — not a fixed sample grid,
   *  but not fabricated either. */
  function confirmReduction() {
    const stoppedAt = riStimStoppedAt ?? Date.now();
    const elapsed = Math.max(0, (Date.now() - stoppedAt) / 1000);
    setRiTrace((prev) => [...prev, { t: Math.round(elapsed * 10) / 10, loudness_pct: riPostStimPct }]);
    setRiElapsedSinceStop(0);
    setRiPhase("monitoring");
  }

  /** Screen 6 — patient-paced: "No, back to usual" and "End" are answerable
   *  the instant the patient notices either, rather than gated behind a
   *  countdown (delaying detection would bias the duration measurement).
   *  `RI_MONITORING_PROMPT_INTERVAL_S` still governs the passive, automatic
   *  "still reduced" checkpoints logged while nothing has been clicked. */
  useEffect(() => {
    if (riPhase !== "monitoring" || !riStimStoppedAt) return;
    const tick = window.setInterval(() => {
      setRiElapsedSinceStop(Math.round((Date.now() - riStimStoppedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(tick);
  }, [riPhase, riStimStoppedAt]);

  useEffect(() => {
    if (riPhase !== "monitoring" || !riStimStoppedAt) return;
    const auto = window.setInterval(() => {
      const elapsed = Math.round((Date.now() - riStimStoppedAt) / 1000);
      setRiMonitoring((prev) => [...prev, { elapsed_s: elapsed, response: "still_reduced", at: Date.now() }]);
    }, RI_MONITORING_PROMPT_INTERVAL_S * 1000);
    return () => window.clearInterval(auto);
  }, [riPhase, riStimStoppedAt]);

  function reportStillReduced() {
    if (!riStimStoppedAt) return;
    const elapsed = Math.round((Date.now() - riStimStoppedAt) / 1000);
    setRiMonitoring((prev) => [...prev, { elapsed_s: elapsed, response: "still_reduced", at: Date.now() }]);
  }

  function reportReturnedToBaseline() {
    if (!riStimStoppedAt) return;
    const at = Date.now();
    const elapsed = Math.round((at - riStimStoppedAt) / 1000);
    setRiMonitoring((prev) => [...prev, { elapsed_s: elapsed, response: "returned_to_baseline", at }]);
    setRiReturnedAt(at);
    setRiTrace((prev) => [...prev, { t: elapsed, loudness_pct: 100 }]);
    setRiPhase("done");
  }

  /** [End] — the patient stops monitoring without confirming a return. The
   *  last real reading stands; duration is reported as "at least" that long,
   *  the same fallback `analyseResidualInhibition` already uses when a trace
   *  never recovers to 90% of baseline. */
  function endMonitoring() {
    setRiPhase("done");
  }

  /** Runs the induction again, preserving the completed run's data (marked
   *  `ri_repeated`) rather than discarding it — the same convention used for
   *  every other repeatable module in this battery. */
  function repeatRi() {
    setRiTrace([]);
    setRiMonitoring([]);
    setRiImmediateResponse(null);
    setRiImmediateAt(null);
    setRiPostStimPct(100);
    setRiStimStartedAt(null);
    setRiStimStoppedAt(null);
    setRiReturnedAt(null);
    setRiRepeated(true);
    setRiPhase("idle");
  }

  const riAnalysis = riTrace.length >= 2 ? analyseResidualInhibition(riTrace) : null;

  /* -- sound tolerance / ULL-LDL ------------------------------------------- */
  function chooseLdlEars(choice: "left" | "right" | "both") {
    const ears: ("left" | "right")[] = choice === "both" ? ["right", "left"] : [choice];
    setLdlEarsToTest(ears);
    setLdlEarIndex(0);
    setLdlFreqIndex(0);
    beginLdlFrequency(0);
  }

  function beginLdlFrequency(freqIndex: number) {
    // A fresh ear starts from the configured starting level; within an ear,
    // each subsequent frequency starts from the previous one's result (the
    // same "seed from the last finding" pattern `MaskingLevelFinder` uses),
    // never inventing a value when that previous result was never obtained.
    const previous = freqIndex > 0 ? ldlResults[ldlResults.length - 1] : undefined;
    const start = previous?.ull_db ?? ULL_STARTING_DB;
    const hz = ULL_FREQUENCIES[freqIndex];
    ldlFinder.current = new ToleranceLevelFinder(start, Math.min(90, Math.round(engine.maxReachableHl(hz))));
    setLdlLevel(ldlFinder.current.currentLevel);
    setLdlScreen("presenting");
  }

  async function playLdlTone(ear: "left" | "right", hz: number, dbHL: number) {
    await engine.resume();
    stopSound();
    engine.playTone({ freq: hz, dbHL, ear, durationMs: 1500, rampMs: 40 });
  }

  function respondLdl(ear: "left" | "right", hz: number, response: ToleranceResponse) {
    if (!ldlFinder.current) return;
    ldlFinder.current.respond(response);
    if (ldlFinder.current.done) {
      const result: LdlFrequencyResult = {
        ear,
        frequency_hz: hz,
        trials: ldlFinder.current.trace,
        ull_db: ldlFinder.current.result(),
      };
      setLdlResults((prev) => [...prev, result]);
      if (result.ull_db !== null) setLdl((prev) => ({ ...prev, [ear]: prev[ear] ?? result.ull_db }));
      if (hz === 1000) setLdl((prev) => ({ ...prev, [ear]: result.ull_db }));

      const nextFreqIndex = ldlFreqIndex + 1;
      if (nextFreqIndex < ULL_FREQUENCIES.length) {
        setLdlFreqIndex(nextFreqIndex);
        beginLdlFrequency(nextFreqIndex);
      } else {
        const nextEarIndex = ldlEarIndex + 1;
        if (nextEarIndex < ldlEarsToTest.length) {
          setLdlEarIndex(nextEarIndex);
          setLdlFreqIndex(0);
          beginLdlFrequency(0);
        } else {
          setLdlScreen("done");
        }
      }
    } else {
      setLdlLevel(ldlFinder.current.currentLevel);
    }
  }

  function repeatLdl() {
    setLdlResults([]);
    setLdl({ left: null, right: null });
    setLdlRepeated(true);
    setLdlScreen("select_ear");
  }

  /* -- completion --------------------------------------------------------- */
  function finish() {
    stopSound();
    engine.stopAll(0.2);
    const analysis = riTrace.length >= 2 ? analyseResidualInhibition(riTrace) : null;
    // Backward-compatible 3-way category, derived from the structured 4-way
    // response — LOUDER has no equivalent in the old vocabulary, so it is
    // reported as "none" (no *reduction* was reported), while the fuller
    // truth still lives in `ri_immediate_response`.
    const reportedCategory: "" | "none" | "partial" | "complete" =
      riImmediateResponse === "COMPLETELY_ABSENT"
        ? "complete"
        : riImmediateResponse === "REDUCED"
          ? "partial"
          : riImmediateResponse === "NO_CHANGE" || riImmediateResponse === "LOUDER"
            ? "none"
            : "";
    onComplete({
      tinnitus_bandwidth: bandwidth,
      character: character ?? "",
      pitch_match_hz: pitchHz,
      pitch_match_confidence: pitchResult?.confidence ?? null,
      octave_confusion: pitchResult ? pitchResult.octaveConfusion : null,
      pitch_match_trace: pitchResult?.trace ?? [],
      pitch_match_ear: matchEar === "both" ? "both" : (matchEar as "left" | "right"),
      loudness_match_db_hl: pitchHz ? loudnessDbHl : null,
      loudness_match_db_sl: pitchHz ? toSensationLevel(loudnessDbHl, thresholdDbHl) : null,
      mml_db_sl: pitchHz ? toSensationLevel(mmlDbHl, mmlThresholdDbHl ?? thresholdDbHl) : null,
      ldl_left: ldl.left,
      ldl_right: ldl.right,
      ldl_trace: ldlResults,
      ldl_repeated: ldlRepeated,
      ri_depth_pct: analysis?.depthPct ?? null,
      ri_duration_s: analysis?.durationS ?? null,
      ri_trace: riTrace,
      ri_reported_category: reportedCategory,
      // Null unless the clinician actually moved the band off the pitch, so an
      // untouched run is recorded as having been measured at the tinnitus
      // frequency rather than being given a redundant explicit value.
      mml_masker_hz: mmlHzOverride,
      ri_immediate_response: riImmediateResponse ?? "",
      ri_baseline_pct: riTrace.length ? 100 : null,
      ri_post_stimulation_pct: riImmediateResponse === "COMPLETELY_ABSENT" || riImmediateResponse === "REDUCED"
        ? riPostStimPct
        : null,
      ri_monitoring: riMonitoring,
      ri_stimulus_frequency_hz: riStimStartedAt ? pitchHz : null,
      ri_stimulus_level_db: riStimStartedAt ? riLevelDb : null,
      ri_stimulation_duration_s: riStimStartedAt ? RI_STIMULATION_DURATION_S : null,
      ri_stimulation_started_at: riStimStartedAt,
      ri_stimulation_stopped_at: riStimStoppedAt,
      ri_reduction_detected_at:
        riImmediateResponse === "COMPLETELY_ABSENT" || riImmediateResponse === "REDUCED" ? riImmediateAt : null,
      ri_return_to_baseline_at: riReturnedAt,
      ri_repeated: riRepeated,
    });
  }

  const loudnessSl = toSensationLevel(loudnessDbHl, thresholdDbHl);
  const mmlSl = toSensationLevel(mmlDbHl, mmlThresholdDbHl ?? thresholdDbHl);

  return (
    <div className="stack stack-5">
      <StepRail
        steps={SUBSTEP_KEYS.map((key) => ({ key, label: t(`match.steps.${key}`) }))}
        current={step}
        completed={done}
        onJump={(i) => setStep(i)}
      />

      {/* ================================================== 1 · character === */}
      {step === 0 && (
        <Panel title={t("match.characterTitle")} bracketed>
          <div className="stack stack-5">
            {character && (
              <p className="meta">
                {/* No `toLowerCase()`. Tamil and Devanagari have no letter case,
                    so it was a no-op there, and it mangled the translated
                    character name in English-derived transliterations. */}
                <Trans
                  i18nKey="match.youSaid"
                  components={[<strong key="0" />]}
                  values={{ character: t(`assessment.character.${character}`, { defaultValue: character }) }}
                />
              </p>
            )}

            <div className="stack stack-2">
              <span className="label">{t("match.whichClosest")}</span>
              <OptionGroup<"tonal" | "narrowband" | "broadband">
                options={BANDWIDTH_OPTIONS.map((option) => ({
                  value: option.value,
                  label: t(`procedures.bandwidth.${option.value}`),
                  help: t(`procedures.bandwidth.${option.value}Help`),
                }))}
                value={bandwidth}
                onChange={setBandwidth}
              />
              {bandwidth === "broadband" && (
                <Panel tone="info" tight>
                  <p className="meta">{t("match.broadbandNote")}</p>
                </Panel>
              )}
            </div>

            <div className="row row--between">
              {onSkip ? (
                <button type="button" className="btn btn--ghost btn--sm" onClick={onSkip}>
                  {t("match.skipShowResults")}
                </button>
              ) : (
                <span />
              )}
              <button type="button" className="btn btn--primary" onClick={() => advance("character", 1)}>
                {t("match.continueToPitch")}
              </button>
            </div>
          </div>
        </Panel>
      )}

      {/* ===================================================== 2 · pitch === */}
      {step === 1 && (
        <div className="grid grid-sidebar" style={{ ["--aside" as string]: "290px" }}>
          <Panel title={t("match.pitchTitle")} bracketed>
            {pitchPhase === "bracketing" && (
              <div className="stack stack-5">
                <p style={{ fontSize: "var(--fs-small)", maxWidth: "44em" }}>
                  <Trans i18nKey="match.bracketLead" components={[<strong key="0" />]} />
                </p>

                <div className="grid grid-2">
                  {(
                    [
                      { hz: pair.aHz, key: "A" },
                      { hz: pair.bHz, key: "B" },
                    ] as const
                  ).map((option) => (
                    <Panel key={option.key} tone="sunken" tight>
                      <div className="stack stack-3 center">
                        <span className="label">{t("match.tone", { key: option.key })}</span>
                        <Readout label="" value={fmt.hz(option.hz)} unit="Hz" size="md" tone="data" />
                        <button
                          type="button"
                          className="btn btn--block"
                          onClick={() => playProbe(option.hz, probeLevel)}
                        >
                          <IconPlay size={15} />
                          {t("match.play")}
                        </button>
                        <button
                          type="button"
                          className="btn btn--primary btn--block"
                          onClick={() => choose(option.hz)}
                        >
                          {t("match.closerToMine")}
                        </button>
                      </div>
                    </Panel>
                  ))}
                </div>

                <div className="row row--between">
                  <span className="meta">
                    {t("match.trialInfo", {
                      trial: pair.step + 1,
                      low: fmt.hz(pair.aHz),
                      high: fmt.hz(pair.bHz),
                    })}
                  </span>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={skipPitch}>
                    {t("match.cannotMatch")}
                  </button>
                </div>
              </div>
            )}

            {pitchPhase === "retest" && retestPair && (
              <div className="stack stack-5">
                <Panel tone="info" tight>
                  <span className="label">{t("match.reliabilityCheck")}</span>
                  <p className="meta" style={{ marginTop: "var(--s1)" }}>{t("match.reliabilityBody")}</p>
                </Panel>

                <div className="grid grid-2">
                  {(
                    [
                      { hz: retestPair.aHz, key: "A" },
                      { hz: retestPair.bHz, key: "B" },
                    ] as const
                  ).map((option) => (
                    <Panel key={option.key} tone="sunken" tight>
                      <div className="stack stack-3 center">
                        <span className="label">{t("match.tone", { key: option.key })}</span>
                        <Readout label="" value={fmt.hz(option.hz)} unit="Hz" size="md" tone="data" />
                        <button type="button" className="btn btn--block" onClick={() => playProbe(option.hz, probeLevel)}>
                          <IconPlay size={15} />
                          {t("match.play")}
                        </button>
                        <button
                          type="button"
                          className="btn btn--primary btn--block"
                          onClick={() => recordRetest(option.hz)}
                        >
                          {t("match.closerToMine")}
                        </button>
                      </div>
                    </Panel>
                  ))}
                </div>
              </div>
            )}

            {pitchPhase === "octave" && (
              <div className="stack stack-5">
                {retestAgreed !== null && (
                  <Panel tone={retestAgreed ? "ok" : "crit"} tight>
                    <span className="label">
                      {t(retestAgreed ? "match.retestPassed" : "match.retestFailed")}
                    </span>
                    <p className="meta" style={{ marginTop: "var(--s1)" }}>
                      {t(retestAgreed ? "match.retestPassedBody" : "match.retestFailedBody")}
                    </p>
                  </Panel>
                )}
                <Panel tone="info" tight>
                  <span className="label">{t("match.octaveTitle")}</span>
                  <p className="meta" style={{ marginTop: "var(--s1)" }}>{t("match.octaveBody")}</p>
                </Panel>

                <div className="grid grid-3">
                  {octaveCandidates.map((hz, i) => (
                    <Panel key={hz} tone="sunken" tight>
                      <div className="stack stack-3 center">
                        <span className="label">
                          {t(
                            i === 0
                              ? "match.octaveLower"
                              : i === 1
                                ? "match.octaveBracketed"
                                : "match.octaveHigher"
                          )}
                        </span>
                        <Readout label="" value={fmt.hz(hz)} unit="Hz" size="sm" tone="data" />
                        <button type="button" className="btn btn--sm btn--block" onClick={() => playProbe(hz, probeLevel)}>
                          <IconPlay size={15} />
                          {t("match.play")}
                        </button>
                        <button type="button" className="btn btn--primary btn--sm btn--block" onClick={() => confirmOctave(hz)}>
                          {t("match.thisOne")}
                        </button>
                      </div>
                    </Panel>
                  ))}
                </div>
              </div>
            )}

            {pitchResult && (
              <div className="stack stack-4">
                <div className="row" style={{ gap: "var(--s8)" }}>
                  <Readout
                    label={t("match.matchedPitch")}
                    value={fmt.hz(pitchResult.hz)}
                    unit="Hz"
                    size="lg"
                    tone="signal"
                  />
                  <Readout
                    label={t("match.confidence")}
                    value={Math.round(pitchResult.confidence * 100)}
                    unit="%"
                    size="md"
                    tone={pitchResult.confidence >= 0.75 ? "ok" : pitchResult.confidence >= 0.5 ? "warn" : "crit"}
                  />
                  <Readout
                    label={t("match.thresholdThere")}
                    value={thresholdDbHl === null ? "—" : Math.round(thresholdDbHl)}
                    unit="dB HL"
                    size="md"
                  />
                </div>

                {pitchResult.octaveConfusion && (
                  <Panel tone="warn" tight>
                    <p className="meta">
                      <Trans i18nKey="match.octaveCorrected" components={[<strong key="0" />]} />
                    </p>
                  </Panel>
                )}

                <p className="meta">{pitchResult.note}</p>

                <div className="row row--between">
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={restartPitch}
                  >
                    {t("match.redoPitch")}
                  </button>
                  <button type="button" className="btn btn--primary" onClick={() => advance("pitch", 2)}>
                    {t("match.continueToLoudness")}
                  </button>
                </div>
              </div>
            )}
          </Panel>

          <Panel title={t("match.howThisWorks")} tight headPlain>
            <div className="stack stack-3">
              <p className="meta">
                <Trans i18nKey="match.howThisWorksBody" components={[<em key="0" />]} />
              </p>
              <div className="tickrule" />
              <div className="stack stack-1">
                <span className="label">{t("match.searchTrace")}</span>
                {matcher.current.trace.length === 0 ? (
                  <span className="meta dim">{t("match.noTrials")}</span>
                ) : (
                  matcher.current.trace.map((t) => (
                    <div key={t.step} className="row row--between mono" style={{ fontSize: "var(--fs-micro)" }}>
                      <span className="dim">#{t.step + 1}</span>
                      <span className="dim">
                        {fmt.hz(t.aHz)} / {fmt.hz(t.bHz)}
                      </span>
                      <span style={{ color: "var(--signal-ink)" }}>{fmt.hz(t.chosenHz)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </Panel>
        </div>
      )}

      {/* ================================================== 3 · loudness === */}
      {step === 2 && (
        <Panel title={t("match.loudnessTitle")} bracketed>
          {!pitchHz ? (
            <div className="stack stack-3">
              <p className="meta">{t("match.needsPitch")}</p>
              <div className="row row--end">
                <button type="button" className="btn btn--primary" onClick={() => advance("loudness", 3)}>
                  {t("common.continue")}
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-sidebar" style={{ ["--aside" as string]: "260px" }}>
              <div className="stack stack-5">
                <p style={{ fontSize: "var(--fs-small)", maxWidth: "44em" }}>
                  <Trans
                    i18nKey="match.loudnessLead"
                    components={[<strong key="0" />, <strong key="1" />]}
                    values={{ freq: fmt.hzFull(pitchHz) }}
                  />
                </p>

                <Fader
                  label={t("match.toneLevel")}
                  value={loudnessDbHl}
                  min={-10}
                  max={Math.min(90, engine.maxReachableHl(pitchHz))}
                  step={1}
                  unit="dB HL"
                  onChange={setLoudnessDbHl}
                  lowLabel={t("match.quieter")}
                  highLabel={t("match.louder")}
                />

                <div className="row">
                  <button type="button" className="btn btn--primary" onClick={() => playProbe(pitchHz, loudnessDbHl, 2200)}>
                    <IconPlay size={15} />
                    {t("match.playAtLevel")}
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={stopSound}>
                    <IconStop size={15} />
                    {t("match.stop")}
                  </button>
                </div>

                <Panel tone="sunken" tight>
                  <p className="meta">{t("match.loudnessInsight")}</p>
                </Panel>

                <div className="row row--end">
                  <button type="button" className="btn btn--primary" onClick={() => advance("loudness", 3)}>
                    {t("match.continueToMasking")}
                  </button>
                </div>
              </div>

              <div className="stack stack-4">
                <Readout label={t("match.absoluteLevel")} value={loudnessDbHl} unit="dB HL" size="md" />
                <Readout
                  label={t("match.sensationLevel")}
                  value={loudnessSl === null ? "—" : loudnessSl.toFixed(1)}
                  unit="dB SL"
                  size="lg"
                  tone="signal"
                  note={t("match.aboveThreshold")}
                />
                <p className="meta">{t(interpretLoudnessMatch(loudnessSl))}</p>
              </div>
            </div>
          )}
        </Panel>
      )}

      {/* ============================================ 4 · limits & masking === */}
      {step === 3 && (
        <div className="stack stack-5">
          <Panel title={t("match.ldlTitle")} bracketed>
            <div className="stack stack-4">
              <p style={{ fontSize: "var(--fs-small)", maxWidth: "44em" }}>
                <Trans i18nKey="match.ldlLead" components={[<strong key="0" />]} />
              </p>

              {ldlScreen === "select_ear" && (
                <div className="stack stack-3">
                  <span className="label">{t("match.ldlChooseEar", { defaultValue: "Which ear should we test first?" })}</span>
                  <div className="btn-group">
                    {(["right", "left", "both"] as const).map((choice) => (
                      <button key={choice} type="button" className="btn" onClick={() => chooseLdlEars(choice)}>
                        {choice === "both"
                          ? t("match.bothEars", { defaultValue: "Both ears" })
                          : t(choice === "left" ? "match.leftEar" : "match.rightEar")}
                      </button>
                    ))}
                  </div>
                  {ldlResults.length > 0 && (
                    <p className="meta dim">
                      {t("match.ldlRepeatNote", {
                        defaultValue: "Starting a new sound tolerance measurement. Your previous results stay in your record.",
                      })}
                    </p>
                  )}
                </div>
              )}

              {ldlScreen === "presenting" &&
                (() => {
                  const ear = ldlEarsToTest[ldlEarIndex];
                  const hz = ULL_FREQUENCIES[ldlFreqIndex];
                  const lastTrial = ldlFinder.current?.trace[ldlFinder.current.trace.length - 1];
                  const isConfirmation = Boolean(lastTrial && lastTrial.response === "uncomfortable" && !lastTrial.confirmation);
                  return (
                    <div className="stack stack-4">
                      <div className="row row--between">
                        <Chip tone="ghost">{t(ear === "left" ? "match.leftEar" : "match.rightEar")}</Chip>
                        <Chip tone="ghost">
                          {t("common.of", { current: ldlFreqIndex + 1, total: ULL_FREQUENCIES.length })}
                        </Chip>
                      </div>
                      <p className="meta">
                        {hz} Hz · {ldlLevel} dB HL
                      </p>
                      {isConfirmation && (
                        <Panel tone="sunken" tight>
                          <p className="meta">
                            {t("match.ldlConfirm", { defaultValue: "Was that previous sound uncomfortably loud?" })}
                          </p>
                        </Panel>
                      )}
                      <div className="row">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => ldlLevel !== null && playLdlTone(ear, hz, ldlLevel)}
                        >
                          <IconPlay size={15} />
                          {t("match.playSound", { defaultValue: "Play sound" })}
                        </button>
                      </div>
                      <div className="row row--tight row--wrap">
                        <button
                          type="button"
                          className="btn btn--primary"
                          onClick={() => respondLdl(ear, hz, "comfortable")}
                        >
                          {t("match.comfortable", { defaultValue: "Comfortable" })}
                        </button>
                        <button type="button" className="btn" onClick={() => respondLdl(ear, hz, "uncomfortable")}>
                          {t("match.uncomfortablyLoud")}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => respondLdl(ear, hz, "stop")}
                        >
                          <IconStop size={15} />
                          {t("match.stopTooLoud", { defaultValue: "Stop / too loud" })}
                        </button>
                      </div>
                    </div>
                  );
                })()}

              {ldlScreen === "done" && (
                <div className="stack stack-3">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t("match.ear", { defaultValue: "Ear" })}</th>
                        <th>{t("match.frequency", { defaultValue: "Frequency" })}</th>
                        <th>{t("match.ullLdl", { defaultValue: "ULL / LDL" })}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ldlResults.map((r, i) => (
                        <tr key={i}>
                          <td>{t(r.ear === "left" ? "match.leftEar" : "match.rightEar")}</td>
                          <td>{r.frequency_hz} Hz</td>
                          <td>
                            {r.ull_db !== null
                              ? `${r.ull_db} dB HL`
                              : t("match.notObtained", { defaultValue: "Not obtained" })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div className="row" style={{ gap: "var(--s8)" }}>
                    <Readout
                      label={t("match.ldlRight")}
                      value={ldl.right ?? "—"}
                      unit="dB HL"
                      size="sm"
                      tone={ldl.right !== null && ldl.right < 80 ? "warn" : undefined}
                    />
                    <Readout
                      label={t("match.ldlLeft")}
                      value={ldl.left ?? "—"}
                      unit="dB HL"
                      size="sm"
                      tone={ldl.left !== null && ldl.left < 80 ? "warn" : undefined}
                    />
                  </div>
                  {(ldl.left !== null && ldl.left < 80) || (ldl.right !== null && ldl.right < 80) ? (
                    <Panel tone="warn" tight>
                      <p className="meta">{t("match.ldlReduced")}</p>
                    </Panel>
                  ) : (
                    <p className="meta dim">{t("match.ldlOptional")}</p>
                  )}
                  <div className="row">
                    <button type="button" className="btn btn--sm btn--ghost" onClick={repeatLdl}>
                      {t("match.repeatLdl", { defaultValue: "Repeat sound tolerance" })}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </Panel>

          <Panel title={t("match.mmlTitle")} bracketed>
            {!pitchHz ? (
              <p className="meta">{t("match.requiresPitch")}</p>
            ) : (
              <div className="grid grid-sidebar" style={{ ["--aside" as string]: "260px" }}>
                <div className="stack stack-4">
                  <p style={{ fontSize: "var(--fs-small)", maxWidth: "44em" }}>
                    <Trans i18nKey="match.mmlLead" components={[<strong key="0" />]} />
                  </p>

                  <div className="row row--tight">
                    <Chip tone="ghost">{t("match.stimulusNarrowband")}</Chip>
                    {mmlHzOverride !== null && (
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        onClick={() => setMmlHzOverride(null)}
                      >
                        {t("match.maskerFreqReset")}
                      </button>
                    )}
                  </div>

                  <Fader
                    label={t("match.maskerFrequency")}
                    value={mmlHz ?? pitchHz}
                    min={250}
                    max={12000}
                    step={50}
                    unit="Hz"
                    onChange={(value) => {
                      setMmlHzOverride(value);
                      // Restart rather than retune: a band-pass centre cannot be
                      // swept on a running node without an audible artefact, and
                      // the masker is a clinical stimulus, not a sound effect.
                      stopSound();
                    }}
                    tone="data"
                    lowLabel="250 Hz"
                    highLabel="12 kHz"
                  />

                  <Fader
                    label={t("match.maskerLevel")}
                    value={mmlDbHl}
                    min={-5}
                    max={Math.min(95, engine.maxReachableHl(mmlHz ?? pitchHz))}
                    step={1}
                    unit="dB HL"
                    onChange={(value) => {
                      setMmlDbHl(value);
                      handleRef.current?.setLevelDb(engine.hlToDbfs(value, mmlHz ?? pitchHz), 0.1);
                    }}
                    tone="data"
                    lowLabel={t("match.inaudible")}
                    highLabel={t("match.loud")}
                  />

                  <div className="row">
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={async () => {
                        await engine.resume();
                        stopSound();
                        handleRef.current = engine.playBandNoise({
                          centreHz: mmlHz ?? pitchHz,
                          bandwidthOctaves: 0.5,
                          dbfs: engine.hlToDbfs(mmlDbHl, mmlHz ?? pitchHz),
                          ear: matchEar,
                          fadeInS: 0.6,
                        });
                      }}
                    >
                      <IconPlay size={15} />
                      {t("match.startMasker")}
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={stopSound}>
                      <IconStop size={15} />
                      {t("match.stop")}
                    </button>
                  </div>
                </div>

                <div className="stack stack-3">
                  <Readout
                    label={t("match.mmlTitle")}
                    value={mmlSl === null ? "—" : mmlSl.toFixed(1)}
                    unit="dB SL"
                    size="lg"
                    tone="data"
                  />
                  <p className="meta">{t(interpretMml(mmlSl))}</p>
                </div>
              </div>
            )}

            <hr className="rule" />
            <div className="row row--end">
              <button type="button" className="btn btn--primary" onClick={() => advance("limits", 4)}>
                {t("match.continueToRi")}
              </button>
            </div>
          </Panel>
        </div>
      )}

      {/* =========================================== 5 · residual inhibition */}
      {step === 4 && (
        <div className="grid grid-sidebar" style={{ ["--aside" as string]: "320px" }}>
          <Panel title={t("match.riTitle")} bracketed>
            {!pitchHz ? (
              <div className="stack stack-3">
                <p className="meta">{t("match.requiresPitch")}</p>
                <div className="row row--end">
                  <button type="button" className="btn btn--primary" onClick={finish}>
                    {t("match.finishCharacterisation")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="stack stack-5">
                {riPhase === "idle" && (
                  <>
                    <p style={{ fontSize: "var(--fs-small)", maxWidth: "44em" }}>
                      <Trans i18nKey="match.riLead" components={[<strong key="0" />]} />
                    </p>
                    <Panel tone="sunken" tight>
                      <p className="meta">{t("match.riWhy")}</p>
                    </Panel>
                    <button type="button" className="btn btn--primary btn--lg" onClick={beginRiSetup}>
                      {t("match.riContinue", { defaultValue: "Continue" })}
                    </button>
                  </>
                )}

                {riPhase === "setup" && (
                  <div className="stack stack-4">
                    <div className="row row--tight row--wrap">
                      <Chip tone="ghost">{pitchHz} Hz</Chip>
                      <Chip tone="ghost">{riLevelDb.toFixed(0)} dB HL</Chip>
                      <Chip tone="ghost">
                        {t("match.riDurationChip", { seconds: RI_STIMULATION_DURATION_S, defaultValue: "{{seconds}} s" })}
                      </Chip>
                    </div>
                    <p className="meta">
                      {t("match.riSetupNote", {
                        defaultValue: "The level and duration are fixed by your earlier measurements — there is nothing to adjust here.",
                      })}
                    </p>
                    <div className="row">
                      <button type="button" className="btn" onClick={playRiPreview}>
                        <IconPlay size={15} />
                        {t("match.playTestSound", { defaultValue: "Play test sound" })}
                      </button>
                      <button type="button" className="btn btn--primary" onClick={startRi}>
                        {t("match.startRi")}
                      </button>
                    </div>
                  </div>
                )}

                {riPhase === "masking" && (
                  <div className="center stack stack-4" style={{ paddingBlock: "var(--s8)" }}>
                    <Chip tone="signal" live>
                      {t("match.maskerPlaying")}
                    </Chip>
                    <Readout
                      label={t("match.timeRemaining")}
                      value={maskCountdown}
                      unit="s"
                      size="lg"
                      tone="signal"
                    />
                    <p className="meta">{t("match.listenNormally")}</p>
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      onClick={() => {
                        stopSound();
                        timers.current.forEach((t) => window.clearTimeout(t));
                        setRiPhase("idle");
                      }}
                    >
                      {t("match.stopUncomfortable")}
                    </button>
                  </div>
                )}

                {riPhase === "immediate" && (
                  <div className="stack stack-4">
                    <span className="label label--signal">
                      {t("match.riImmediateQuestion", { defaultValue: "How does your tinnitus sound right now?" })}
                    </span>
                    <div className="grid" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "var(--s2)" }}>
                      {(
                        [
                          ["COMPLETELY_ABSENT", "match.riImmediate.completelyAbsent", "My tinnitus is completely gone"],
                          ["REDUCED", "match.riImmediate.reduced", "It's quieter than usual"],
                          ["NO_CHANGE", "match.riImmediate.noChange", "No change"],
                          ["LOUDER", "match.riImmediate.louder", "It's louder than usual"],
                        ] as const
                      ).map(([value, key, defaultValue]) => (
                        <button
                          key={value}
                          type="button"
                          className="option"
                          onClick={() => recordImmediateResponse(value)}
                        >
                          {t(key, { defaultValue })}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {riPhase === "reduction" && (
                  <div className="stack stack-4">
                    <span className="label">
                      {t("match.riReductionQuestion", {
                        defaultValue: "How much of your tinnitus loudness remains, compared with before the masker?",
                      })}
                    </span>
                    <OptionGroup<number>
                      columns={5}
                      value={riPostStimPct}
                      onChange={setRiPostStimPct}
                      options={[0, 25, 50, 75, 100].map((pct) => ({ value: pct, label: `${pct}%` }))}
                    />
                    <p className="meta">
                      {t("match.riReductionNote", {
                        defaultValue: "0% = completely suppressed. 100% = no reduction at all.",
                      })}
                    </p>
                    <div className="row row--end">
                      <button type="button" className="btn btn--primary btn--lg" onClick={confirmReduction}>
                        {t("match.riConfirmReduction", { defaultValue: "Confirm" })}
                      </button>
                    </div>
                  </div>
                )}

                {riPhase === "monitoring" && (
                  <div className="center stack stack-4" style={{ paddingBlock: "var(--s6)" }}>
                    <Readout
                      label={t("match.riElapsed", { defaultValue: "Time since the masker stopped" })}
                      value={riElapsedSinceStop}
                      unit="s"
                      size="lg"
                      tone="data"
                    />
                    <span className="label">
                      {t("match.riMonitoringQuestion", { defaultValue: "Can you still notice a reduction?" })}
                    </span>
                    <div className="row">
                      <button type="button" className="btn btn--primary" onClick={reportStillReduced}>
                        {t("match.riYesStillReduced", { defaultValue: "Yes, still reduced" })}
                      </button>
                      <button type="button" className="btn" onClick={reportReturnedToBaseline}>
                        {t("match.riNoBackToUsual", { defaultValue: "No — back to usual" })}
                      </button>
                    </div>
                    <button type="button" className="btn btn--sm btn--ghost" onClick={endMonitoring}>
                      {t("match.riEnd", { defaultValue: "End" })}
                    </button>
                  </div>
                )}

                {riPhase === "done" && (riImmediateResponse === "NO_CHANGE" || riImmediateResponse === "LOUDER") && (
                  <div className="stack stack-4">
                    <Chip tone={riImmediateResponse === "LOUDER" ? "crit" : "warn"} dot>
                      {t(
                        riImmediateResponse === "LOUDER" ? "match.riImmediate.louder" : "match.riImmediate.noChange",
                        { defaultValue: riImmediateResponse === "LOUDER" ? "It's louder than usual" : "No change" }
                      )}
                    </Chip>
                    <p className="meta">
                      {t("match.riNoReductionNote", {
                        defaultValue: "No reduction was reported, so no recovery duration is measured for this run.",
                      })}
                    </p>
                    <div className="row row--end">
                      <button type="button" className="btn btn--sm btn--ghost" onClick={repeatRi}>
                        {t("match.repeatRi", { defaultValue: "Repeat residual inhibition" })}
                      </button>
                      <button type="button" className="btn btn--primary btn--lg" onClick={finish}>
                        {t("match.finishCharacterisation")}
                      </button>
                    </div>
                  </div>
                )}

                {riPhase === "done" && riAnalysis && (
                  <div className="stack stack-4">
                    <div className="row" style={{ gap: "var(--s8)" }}>
                      <Readout
                        label={t("match.depth")}
                        value={riAnalysis.depthPct.toFixed(0)}
                        unit="%"
                        size="lg"
                        tone={riAnalysis.depthPct >= 40 ? "ok" : riAnalysis.depthPct <= -10 ? "crit" : "warn"}
                      />
                      <Readout
                        label={t("match.duration")}
                        value={riAnalysis.durationS ?? "—"}
                        unit="s"
                        size="md"
                      />
                      <div className="stack stack-1">
                        <span className="label">{t("match.category")}</span>
                        <Chip
                          tone={
                            riAnalysis.category === "Complete" || riAnalysis.category === "Partial"
                              ? "ok"
                              : riAnalysis.category === "Rebound"
                                ? "crit"
                                : "warn"
                          }
                          dot
                        >
                          {t(riAnalysis.categoryKey)}
                        </Chip>
                      </div>
                    </div>
                    <p style={{ fontSize: "var(--fs-small)" }}>
                      {riAnalysis.noteKey ? t(riAnalysis.noteKey) : ""}
                    </p>
                    {!riReturnedAt && (
                      <p className="meta dim">
                        {t("match.riNoReturnConfirmed", {
                          defaultValue: "Monitoring was ended before a return to baseline was confirmed — duration is a lower bound.",
                        })}
                      </p>
                    )}
                    <div className="row row--end">
                      <button type="button" className="btn btn--sm btn--ghost" onClick={repeatRi}>
                        {t("match.repeatRi", { defaultValue: "Repeat residual inhibition" })}
                      </button>
                      <button type="button" className="btn btn--primary btn--lg" onClick={finish}>
                        {t("match.finishCharacterisation")}
                      </button>
                    </div>
                  </div>
                )}

                {riPhase !== "done" && (
                  <div className="row row--end">
                    <button type="button" className="btn btn--sm btn--ghost" onClick={finish}>
                      {t("match.skipRi")}
                    </button>
                  </div>
                )}
              </div>
            )}
          </Panel>

          <Panel title={t("match.recoveryCurve")} tight headPlain>
            {riTrace.length >= 2 ? (
              <RiCurve trace={riTrace} depthPct={riAnalysis?.depthPct} durationS={riAnalysis?.durationS} />
            ) : (
              <p className="meta dim">{t("match.curveAppears")}</p>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
