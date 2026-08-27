/**
 * Pure-tone audiometry step.
 *
 * Drives `ThresholdTracker` (modified Hughson-Westlake) across a frequency
 * sequence for each ear. Three details separate this from a "click if you hear a
 * beep" toy:
 *
 *  - **Randomised presentation timing.** The patient must not be able to predict
 *    when the tone arrives, or they will respond to the rhythm.
 *  - **Catch trials.** Every seventh presentation is silent. Responding to
 *    silence means the patient is guessing, and the whole audiogram is flagged.
 *  - **1 kHz retest.** The standard reliability check — the sequence starts and
 *    ends at 1 kHz and the two thresholds must agree within 10 dB.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { engine } from "../../audio/engine";
import { ThresholdTracker, shouldInsertCatchTrial, type Ear, type TrackerResult } from "../../audio/procedures";
import { Audiogram } from "../../components/charts";
import { Chip, Kbd, Panel, Readout, useHotkey } from "../../components/ui";
import { IconCheck } from "../../components/icons";

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

type Phase = "idle" | "presenting" | "gap" | "done";

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
  initialAudiogram,
}: {
  onComplete(result: AudiometryResult): void;
  initialAudiogram?: Record<string, Record<string, number>>;
}) {
  const { t } = useTranslation();
  const [ear, setEar] = useState<Ear>("right");
  const [stepIndex, setStepIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
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

  // Extra frequencies added mid-test when the 20 dB inter-octave rule fires.
  const [extraFreqs, setExtraFreqs] = useState<Record<Ear, number[]>>({ left: [], right: [] });

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
    tracker.current = new ThresholdTracker(freq, ear, { startDbHl: 40, maxDbHl: Math.min(90, engine.maxReachableHl(freq)) });
    setPhase("idle");
  }, [freq, ear]);

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
      setAudiogram((prev) => ({ ...prev, [ear]: sideThresholds }));
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

  const respond = useCallback(() => {
    if (phase !== "presenting" || respondedRef.current) return;
    respondedRef.current = true;
    setResponded(true);
  }, [phase]);

  useHotkey(" ", respond, "I heard it", phase === "presenting");
  useHotkey("enter", respond, "I heard it", phase === "presenting");

  function start() {
    clearTimers();
    void present();
  }

  function stop() {
    clearTimers();
    engine.stopAll(0.05);
    setPhase("idle");
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
      <div className="grid grid-sidebar" style={{ ["--aside" as string]: "300px" }}>
        {/* -- test panel ----------------------------------------------------- */}
        <Panel bracketed>
          <div className="row row--between" style={{ marginBottom: "var(--s5)" }}>
            <div className="row row--tight">
              <Chip tone={ear === "right" ? "crit" : "info"} dot>
                {t(ear === "left" ? "audiometry.leftEar" : "audiometry.rightEar")}
              </Chip>
              <Chip tone="ghost">
                {isRetestStep
                  ? t("audiometry.retestChip")
                  : t("audiometry.stepOf", { current: doneSteps + 1, total: totalSteps })}
              </Chip>
              {isInterOctave && (
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
            <span className="mono meta">{progress}%</span>
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

            {phase === "idle" && (
              <div className="stack stack-3" style={{ maxWidth: "32em", marginInline: "auto" }}>
                <p style={{ fontSize: "var(--fs-small)" }}>
                  <Trans i18nKey="audiometry.instruction" components={[<strong key="0" />]} />
                </p>
                <button type="button" className="btn btn--primary btn--lg" onClick={start}>
                  {t(ear === "left" ? "audiometry.startLeft" : "audiometry.startRight", {
                    freq: freq >= 1000 ? `${freq / 1000} kHz` : `${freq} Hz`,
                  })}
                </button>
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
                  <button type="button" className="btn btn--sm btn--ghost" onClick={stop}>
                    {t("audiometry.pause")}
                  </button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={skipFrequency}>
                    {t("audiometry.skipFrequency")}
                  </button>
                </div>
              </div>
            )}

            {phase === "done" && (
              <div className="stack stack-3">
                <Chip tone={measuredCount > 0 ? "ok" : "crit"} dot>
                  {t("audiometry.bothComplete")}
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
                        }}
                      >
                        {t("audiometry.restart")}
                      </button>
                    </div>
                  </Panel>
                ) : (
                  <button type="button" className="btn btn--primary btn--lg" onClick={complete}>
                    {t("audiometry.saveAndContinue")}
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
    </div>
  );
}
