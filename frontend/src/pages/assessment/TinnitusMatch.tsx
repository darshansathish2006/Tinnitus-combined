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
  RI_SAMPLE_TIMES,
  analyseResidualInhibition,
  interpretLoudnessMatch,
  interpretMml,
  toSensationLevel,
  type PitchResult,
  type RiSample,
} from "../../audio/procedures";
import { RiCurve } from "../../components/charts";
import { Chip, Fader, OptionGroup, Panel, Readout, StepRail, fmt } from "../../components/ui";
import { IconCheck, IconPlay, IconStop } from "../../components/icons";

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
  ldl_left: number | null;
  ldl_right: number | null;
  ri_depth_pct: number | null;
  ri_duration_s: number | null;
  ri_trace: RiSample[];
  /** The patient's own answer after the masker stopped; "" when not asked. */
  ri_reported_category: "" | "none" | "partial" | "complete";
  /** Masker centre frequency, null when it was left at the tinnitus pitch. */
  mml_masker_hz: number | null;
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
  const [ldl, setLdl] = useState<{ left: number | null; right: number | null }>({ left: null, right: null });
  const [ldlProbe, setLdlProbe] = useState(70);
  const [ldlEar, setLdlEar] = useState<"left" | "right">("right");

  const [riPhase, setRiPhase] = useState<"idle" | "masking" | "rating" | "done">("idle");
  const [riIndex, setRiIndex] = useState(0);
  const [riTrace, setRiTrace] = useState<RiSample[]>([]);
  const [riCurrent, setRiCurrent] = useState(100);
  /**
   * What the patient says happened, as three categories.
   *
   * Kept entirely separate from the 0-100% trace and from the graded
   * `ri_category` the server derives from it. The trace measures how loud the
   * tinnitus was at nine time points; this records the answer to "has it gone
   * down?" — and the two can legitimately disagree. A patient who reports
   * complete abolition while the trace shows a 30% dip is telling you something
   * about how they experience the percept that the numbers do not, and
   * collapsing the two into one value would throw that away.
   */
  const [riReported, setRiReported] = useState<"none" | "partial" | "complete" | null>(null);
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

  /* -- residual inhibition ------------------------------------------------ */
  async function startRi() {
    if (!pitchHz) return;
    await engine.resume();
    setRiPhase("masking");
    setRiTrace([]);
    setRiIndex(0);

    // Masker 10 dB above the MML for 45 s — the standard RI induction.
    const handle = engine.playBandNoise({
      centreHz: pitchHz,
      bandwidthOctaves: 0.5,
      dbfs: engine.hlToDbfs(mmlDbHl + 10, pitchHz),
      ear: matchEar,
      fadeInS: 1,
    });
    handleRef.current = handle;

    let remaining = 45;
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
      setRiPhase("rating");
      setRiCurrent(100);
    }, 45_000);
    timers.current.push(stopTimer as unknown as number);
  }

  function recordRiSample() {
    const sample = { t: RI_SAMPLE_TIMES[riIndex], loudness_pct: riCurrent };
    const next = [...riTrace, sample];
    setRiTrace(next);
    if (riIndex + 1 >= RI_SAMPLE_TIMES.length) setRiPhase("done");
    else setRiIndex(riIndex + 1);
  }

  const riAnalysis = riTrace.length >= 2 ? analyseResidualInhibition(riTrace) : null;

  /* -- completion --------------------------------------------------------- */
  function finish() {
    stopSound();
    engine.stopAll(0.2);
    const analysis = riTrace.length >= 2 ? analyseResidualInhibition(riTrace) : null;
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
      ri_depth_pct: analysis?.depthPct ?? null,
      ri_duration_s: analysis?.durationS ?? null,
      ri_trace: riTrace,
      ri_reported_category: riReported ?? "",
      // Null unless the clinician actually moved the band off the pitch, so an
      // untouched run is recorded as having been measured at the tinnitus
      // frequency rather than being given a redundant explicit value.
      mml_masker_hz: mmlHzOverride,
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
            <div className="grid grid-sidebar" style={{ ["--aside" as string]: "260px" }}>
              <div className="stack stack-4">
                <p style={{ fontSize: "var(--fs-small)", maxWidth: "44em" }}>
                  <Trans i18nKey="match.ldlLead" components={[<strong key="0" />]} />
                </p>

                <div className="btn-group">
                  {(["right", "left"] as const).map((ear) => (
                    <button
                      key={ear}
                      type="button"
                      className="btn btn--sm"
                      aria-pressed={ldlEar === ear}
                      onClick={() => setLdlEar(ear)}
                    >
                      {t(ear === "left" ? "match.leftEar" : "match.rightEar")}
                    </button>
                  ))}
                </div>

                <Fader
                  label={t("match.levelForEar", {
                    ear: t(ldlEar === "left" ? "match.leftEar" : "match.rightEar"),
                  })}
                  value={ldlProbe}
                  min={40}
                  max={Math.min(100, engine.maxReachableHl(1000))}
                  step={5}
                  unit="dB HL"
                  onChange={setLdlProbe}
                  tone="data"
                  lowLabel="40"
                  highLabel="100"
                />

                <div className="row">
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      await engine.resume();
                      engine.playTone({ freq: 1000, dbHL: ldlProbe, ear: ldlEar, durationMs: 1200, rampMs: 40 });
                    }}
                  >
                    <IconPlay size={15} />
                    {t("match.play1k")}
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => setLdl((prev) => ({ ...prev, [ldlEar]: ldlProbe }))}
                  >
                    {t("match.uncomfortablyLoud")}
                  </button>
                </div>
              </div>

              <div className="stack stack-3">
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
                {(ldl.left !== null && ldl.left < 80) || (ldl.right !== null && ldl.right < 80) ? (
                  <Panel tone="warn" tight>
                    <p className="meta">{t("match.ldlReduced")}</p>
                  </Panel>
                ) : (
                  <p className="meta dim">{t("match.ldlOptional")}</p>
                )}
              </div>
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
                    <button type="button" className="btn btn--primary btn--lg" onClick={startRi}>
                      {t("match.startRi")}
                    </button>
                  </>
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

                {riPhase === "rating" && (
                  <div className="stack stack-5">
                    <div className="row row--between">
                      <span className="label label--signal">{t("match.rateNow")}</span>
                      <Chip tone="ghost">
                        {t("common.of", { current: riIndex + 1, total: RI_SAMPLE_TIMES.length })}
                      </Chip>
                    </div>

                    <Readout
                      label={t("match.atSeconds", { seconds: RI_SAMPLE_TIMES[riIndex] })}
                      value={riCurrent}
                      unit={t("match.percentOfNormal")}
                      size="lg"
                      tone={riCurrent < 60 ? "ok" : riCurrent > 105 ? "crit" : "data"}
                    />

                    <Fader
                      label={t("match.compareLoudness")}
                      value={riCurrent}
                      min={0}
                      max={120}
                      step={5}
                      onChange={setRiCurrent}
                      lowLabel={t("match.riLow")}
                      highLabel={t("match.riHigh")}
                      tone="data"
                    />

                    <button type="button" className="btn btn--primary btn--lg" onClick={recordRiSample}>
                      {t("match.recordRating")}
                    </button>
                  </div>
                )}

                {riPhase === "done" && riAnalysis && (
                  <div className="stack stack-4">
                    {/* The patient's own answer, asked once the trace is in so
                        it is a summary of what they experienced rather than a
                        prediction that then biases the ratings. */}
                    <Panel tone="sunken" tight>
                      <div className="stack stack-3">
                        <span className="label">{t("match.riReportedQuestion")}</span>
                        <div className="row row--tight row--wrap">
                          {(["none", "partial", "complete"] as const).map((key) => (
                            <button
                              key={key}
                              type="button"
                              className={`btn btn--sm${riReported === key ? " btn--primary" : ""}`}
                              aria-pressed={riReported === key}
                              onClick={() => setRiReported(key)}
                            >
                              {riReported === key && <IconCheck size={13} />}
                              {t(`match.riReported.${key}`)}
                            </button>
                          ))}
                        </div>
                        <p className="meta">{t("match.riReportedNote")}</p>
                      </div>
                    </Panel>

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
                    <div className="row row--end">
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
