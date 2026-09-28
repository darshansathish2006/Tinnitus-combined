/**
 * Residual inhibition — a timed masker followed by a sampled recovery curve.
 *
 * This used to be the last of five measurements in a "psychoacoustic
 * characterisation" battery (character/bandwidth, pitch match, loudness
 * match, comfort limits + minimum masking level, then this). Those first
 * four steps were removed from the active assessment UI — see the
 * "ECHOSENSE — REMOVE OPTIONAL TESTING EXCEPT RESIDUAL INHIBITION" change —
 * because they duplicated measurements Hearing Measurement already takes
 * (pitch matching, loudness matching) or only ever fed this component's own
 * stimulus (the manual masking-level fader). Residual inhibition's stimulus
 * still needs a frequency and a level; those now come in as `pitchHz` and
 * `riLevelDb` props, derived by the caller from the patient's actual Hearing
 * Measurement results (matched pitch, masking curve, loudness match) instead
 * of being measured again here. Nothing about the induction itself —
 * timing, response options, reduction/monitoring, or the result
 * calculation — changed.
 */

import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { engine, type Ear as AudioEar } from "../../audio/engine";
import { analyseResidualInhibition, type RiSample } from "../../audio/procedures";
import { RiCurve } from "../../components/charts";
import { Chip, OptionGroup, Panel, Readout } from "../../components/ui";
import { IconPlay } from "../../components/icons";

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

export interface MatchResult {
  ri_depth_pct: number | null;
  ri_duration_s: number | null;
  ri_trace: RiSample[];
  /** The patient's own answer after the masker stopped; "" when not asked. */
  ri_reported_category: "" | "none" | "partial" | "complete";
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

/**
 * Interpolate the audiometric threshold at an arbitrary frequency. Exported
 * so the caller can use the same interpolation when deriving `riLevelDb`
 * from the patient's loudness match (see this file's top-of-file comment).
 */
export function thresholdAt(audiogram: Record<string, Record<string, number>>, ear: string, hz: number): number | null {
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
  pitchHz,
  riLevelDb,
  laterality,
  onComplete,
}: {
  /** The patient's tinnitus pitch — sourced by the caller from Hearing
   *  Measurement's own pitch match, not measured here. Null only if Hearing
   *  Measurement's pitch match is itself unavailable. */
  pitchHz: number | null;
  /** The masker level to induce residual inhibition at — sourced by the
   *  caller from Hearing Measurement's masking curve (or loudness match as a
   *  fallback), already including the same margin this component's masker
   *  has always used above the patient's own masking level. Null only if
   *  neither source is available. */
  riLevelDb: number | null;
  laterality: string | null;
  onComplete(result: MatchResult): void;
}) {
  const { t } = useTranslation();

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

  /** Screen 2 — a brief preview at the induction parameters, not the
   *  45 s induction itself. */
  async function playRiPreview() {
    if (!pitchHz || riLevelDb === null) return;
    await engine.resume();
    stopSound();
    engine.playTone({ freq: pitchHz, dbHL: riLevelDb, ear: matchEar, durationMs: 1500, rampMs: 30 });
  }

  function beginRiSetup() {
    setRiPhase("setup");
  }

  async function startRi() {
    if (!pitchHz || riLevelDb === null) return;
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
      ri_depth_pct: analysis?.depthPct ?? null,
      ri_duration_s: analysis?.durationS ?? null,
      ri_trace: riTrace,
      ri_reported_category: reportedCategory,
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

  return (
    <div className="stack stack-5">
      <div className="grid grid-sidebar" style={{ ["--aside" as string]: "320px" }}>
        <Panel title={t("match.riTitle")} bracketed>
          {!pitchHz || riLevelDb === null ? (
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
    </div>
  );
}
