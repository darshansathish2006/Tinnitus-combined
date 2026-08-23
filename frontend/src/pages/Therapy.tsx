/**
 * Therapy player.
 *
 * Renders the prescription the server generated, synthesises each block live, and
 * logs the session with a pre/post loudness rating so the adaptation engine has
 * real per-modality response data to work from.
 *
 * The pre/post rating is the point. Without it, "adaptive therapy" is a slogan;
 * with it, the engine can measure that notched noise moves this patient 1.4 VAS
 * points and ocean surf moves them 0.2, and reallocate the time accordingly.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api, ApiError, type Assessment } from "../api/client";
import { useSession } from "../state/session";
import { engine } from "../audio/engine";
import { startTherapy, type TherapyBlock, type TherapyHandle } from "../audio/therapy";
import {
  Chip,
  Disclosure,
  EmptyState,
  ErrorState,
  Fader,
  Loading,
  Meter,
  Modal,
  Panel,
  Readout,
  fmt,
  useAsync,
} from "../components/ui";
import { IconPlay, IconStop, IconVolume } from "../components/icons";
import { RehabProgramme } from "../components/RehabProgramme";
import { DailyMonitoring } from "../components/DailyMonitoring";
import { ChartLegend, SpectrumBars, SpectrumChart } from "../components/charts";
import { RELAXING_SOUNDS } from "../data/relaxingSounds";

/**
 * Schedule slots are backend enum values; the label is looked up under
 * `therapy.schedule.*` at render time so it follows the active language, with
 * the raw token as the last-resort fallback for a slot this client has not
 * been taught yet.
 */
function scheduleLabel(t: TFunction, schedule: string): string {
  return t(`therapy.schedule.${schedule}`, { defaultValue: fmt.titleCase(schedule) });
}

const FAMILY_TONE: Record<string, "signal" | "data" | "ok" | "warn" | "info"> = {
  neuromodulation: "signal",
  masking: "data",
  habituation: "ok",
  relaxation: "info",
  psychological: "info",
  sleep: "data",
  hyperacusis: "warn",
};

type Phase = "idle" | "pre" | "playing" | "post";

function engineLabel(engine: string): string {
  switch (engine) {
    case "oceanWaves": return "🌊 Ocean";
    case "rain": return "🌧️ Rain / Fire";
    case "forest": return "🌲 Forest / Night";
    case "fractalTones": return "🔔 Chimes / Bowls";
    case "binaural": return "🎧 Binaural";
    case "breathingPacer": return "🫁 Breathing";
    case "shapedNoise": return "🔊 Comfort Noise";
    default: return "🔊 Sound";
  }
}

/**
 * The Rehabilitation screen.
 *
 * Renamed from "Therapy" and restructured: the programme — today's activities,
 * this week's goals, the four-week roadmap and progress — is the screen, and
 * the sound player it used to consist entirely of is now one activity within
 * it. The route is `/rehabilitation`; `/therapy` still resolves to it so no
 * existing link or bookmark breaks.
 */
export default function Rehabilitation() {
  const { t } = useTranslation();
  const toast = useSession((s) => s.toast);
  const playerRef = useRef<HTMLDivElement>(null);

  // Fetched here rather than inside the programme component so that ticking an
  // activity and finishing a listening session refresh the same object — the
  // player writes a `TherapySession`, which the programme counts as that day's
  // sound activity, and two independent copies of the progress would disagree
  // the moment a patient did both.
  const programme = useAsync(async () => {
    try {
      return await api.rehab.programme();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }, []);

  // Monitoring is fetched alongside the programme rather than inside its own
  // component so that logging an activity and logging a check-in both refresh
  // the same picture — the two feed the same adherence and streak numbers.
  const monitoring = useAsync(async () => {
    try {
      return await api.monitoring.get();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }, []);

  const prescription = useAsync(async () => {
    try {
      return await api.therapy.current();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }, []);
  const adherence = useAsync(() => api.therapy.adherence(28), []);
  const latest = useAsync<Assessment | null>(async () => {
    try {
      return await api.assessments.latest();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }, []);
  const [generating, setGenerating] = useState(false);

  const [block, setBlock] = useState<TherapyBlock | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [levelDbfs, setLevelDbfs] = useState(-34);
  const [preVas, setPreVas] = useState(5);
  const [postVas, setPostVas] = useState(5);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState<string>("");
  const [spectrumData, setSpectrumData] = useState<Uint8Array | null>(null);
  const [showSpectrum, setShowSpectrum] = useState(false);
  const [adapting, setAdapting] = useState(false);

  const handleRef = useRef<TherapyHandle | null>(null);
  const startedAt = useRef(0);
  const frame = useRef(0);

  const plan = prescription.data;
  const assessment = latest.data;
  const pitchHz = assessment?.pitch_match_hz ?? null;

  /* -- teardown ----------------------------------------------------------- */
  const stopPlayback = useCallback(() => {
    handleRef.current?.stop(1.2);
    handleRef.current = null;
    cancelAnimationFrame(frame.current);
  }, []);

  useEffect(
    () => () => {
      stopPlayback();
      engine.stopAll(0.3);
    },
    [stopPlayback]
  );

  /* -- animation loop: timer, spectrum, generator status ------------------- */
  useEffect(() => {
    if (phase !== "playing") return;
    const tick = () => {
      setElapsed((performance.now() - startedAt.current) / 1000);
      const buffer = new Uint8Array(1024);
      if (engine.spectrum(buffer)) setSpectrumData(buffer);
      const text = handleRef.current?.status?.();
      if (text) setStatus(text);
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [phase]);

  /* -- level: derived from the prescription, not guessed ------------------- */
  const [levelSource, setLevelSource] = useState<"calibrated" | "conservative">("conservative");

  useEffect(() => {
    if (!block) return;
    const target = Number(block.params.targetSensationLevelDb);
    const guardrail = Number(plan?.guardrails?.level?.target_sensation_level_db);
    const sl = Number.isFinite(target) ? target : Number.isFinite(guardrail) ? guardrail : 8;

    // Sensation level is relative to this patient's threshold at their tinnitus
    // frequency, so it needs the audiogram *and* a levelled headphone reference.
    // The engine's calibration is restored from the patient profile at session
    // hydrate; before that was added it was always empty here and every block
    // silently played at the conservative fallback instead of the prescribed
    // dose. Which branch ran is now surfaced in the UI rather than hidden.
    if (pitchHz && engine.calibration.calibratedAt) {
      const side = assessment?.audiogram?.right ?? assessment?.audiogram?.left ?? {};
      const entries = Object.entries(side)
        .map(([f, db]) => ({ f: Number(f), db: Number(db) }))
        .sort((a, b) => Math.abs(a.f - pitchHz) - Math.abs(b.f - pitchHz));
      const threshold = entries[0]?.db ?? 15;
      setLevelDbfs(Math.min(-6, engine.hlToDbfs(threshold + sl, pitchHz)));
      setLevelSource("calibrated");
    } else {
      setLevelDbfs(-36);
      setLevelSource("conservative");
    }
  }, [block, plan, pitchHz, assessment]);

  async function beginBlock(chosen: TherapyBlock) {
    stopPlayback();
    setBlock(chosen);
    setPhase("pre");
    setElapsed(0);
    setStatus("");
  }

  async function startPlaying() {
    if (!block) return;
    try {
      // Must happen inside the click handler — an AudioContext created outside a
      // user gesture stays suspended and the block plays silently.
      await engine.resume();
      handleRef.current = startTherapy(block, levelDbfs);
      startedAt.current = performance.now();
      setPhase("playing");
      setStatus(handleRef.current.status?.() ?? "");
    } catch (error) {
      stopPlayback();
      setPhase("pre");
      toast(
        error instanceof Error
          ? t("therapy.audioFailedNamed", { message: error.message })
          : t("therapy.audioFailed"),
        "crit"
      );
    }
  }

  function finishPlaying() {
    stopPlayback();
    setPostVas(Math.max(0, preVas - 1));
    setPhase("post");
  }

  async function logSession(completed: boolean) {
    if (!block) return;
    try {
      await api.therapy.logSession({
        prescription_id: plan?.id,
        modality: block.modality,
        planned_seconds: block.minutes * 60,
        actual_seconds: Math.round(elapsed),
        completed,
        volume_db: levelDbfs,
        pre_vas_loudness: preVas,
        post_vas_loudness: postVas,
        params: { engine: block.engine },
      });
      // The session counts toward today's sound activity, so the programme's
      // streak and weekly percentage move the moment the session is filed.
      programme.reload();
      const delta = preVas - postVas;
      toast(
        delta > 0.4
          ? t("therapy.loggedRelief", { points: fmt.num(delta, 1) })
          : t("therapy.logged"),
        "ok"
      );
      await adherence.reload();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("therapy.logFailed"), "crit");
    }
    setPhase("idle");
    setBlock(null);
    setElapsed(0);
  }

  /**
   * Build a plan from the latest completed assessment.
   *
   * Finalising an assessment normally creates the prescription automatically, so
   * this is the recovery path for the case where a patient has a completed
   * assessment but no active plan — previously that state dead-ended on an empty
   * screen telling them to start an assessment they had already done.
   */
  async function generatePlan() {
    setGenerating(true);
    try {
      prescription.setData(await api.therapy.generate(assessment?.id));
      toast(t("therapy.ready"), "ok");
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("therapy.buildFailed"), "crit");
    } finally {
      setGenerating(false);
    }
  }

  async function runAdaptation() {
    setAdapting(true);
    try {
      const revised = await api.therapy.adapt();
      prescription.setData(revised);
      toast(t("therapy.adapted", { revision: revised.revision }), "ok");
    } catch (error) {
      toast(
        error instanceof ApiError ? error.message : t("therapy.adaptFailed"),
        error instanceof ApiError && error.status === 412 ? "info" : "crit"
      );
    } finally {
      setAdapting(false);
    }
  }

  // Wait for the assessment too: the level derivation needs its audiogram, and
  // rendering the player before it arrives would briefly show the conservative
  // fallback level and then jump.
  if (prescription.loading || latest.loading) return <Loading label={t("therapy.loading")} rows={4} />;
  if (prescription.error) return <ErrorState error={prescription.error} retry={prescription.reload} />;

  if (!plan) {
    // Two genuinely different states. Telling someone who has just finished an
    // assessment to "start an assessment" is the kind of dead end that makes a
    // screen look broken.
    const hasAssessment = assessment?.status === "complete";
    return (
      <Panel bracketed>
        <EmptyState
          title={t(hasAssessment ? "therapy.noActivePlanTitle" : "therapy.noPlanTitle")}
          body={t(hasAssessment ? "therapy.noActivePlanBody" : "therapy.noPlanBody")}
          action={
            hasAssessment ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={generatePlan}
                disabled={generating}
              >
                {generating ? t("therapy.building") : t("therapy.build")}
              </button>
            ) : (
              <Link className="btn btn--primary" to="/assessment">
                {t("therapy.startAssessment")}
              </Link>
            )
          }
        />
      </Panel>
    );
  }

  const grouped = plan.program.reduce<Record<string, TherapyBlock[]>>((acc, item: TherapyBlock) => {
    (acc[item.schedule] ??= []).push(item);
    return acc;
  }, {});
  const guardrails = plan.guardrails ?? {};
  const level = guardrails.level ?? {};
  const contraindications: string[] = guardrails.contraindications ?? [];

  const targetSeconds = (block?.minutes ?? 0) * 60;
  const progress = handleRef.current?.progress?.() ?? (targetSeconds ? Math.min(1, elapsed / targetSeconds) : 0);

  return (
    <div className="stack stack-6">
      <header className="row row--between">
        <div className="stack stack-1">
          <span className="label label--signal" data-tour="rehabilitation">{t("rehab.label")}</span>
          <h1>{t("rehab.title")}</h1>
          <p className="meta">
            {programme.data && (
              <>
                {t("rehab.weekOf", {
                  week: programme.data.progress.week,
                  total: programme.data.progress.week_of,
                })}
                {" \u00b7 "}
              </>
            )}
            {t("therapy.subtitle", {
              revision: plan.revision,
              strategy: fmt.titleCase(String(level.strategy ?? "mixing point")),
              minutes: t("units.minutesPerDay", { count: plan.daily_minutes_target }),
              days: t("units.days", { count: plan.review_after_days }),
            })}
            {" · "}
            {t(plan.generated_by === "clinician_approved" ? "therapy.clinicianApproved" : "therapy.pendingReview")}
          </p>
        </div>
        <div className="row row--tight no-print">
          <button type="button" className="btn btn--sm" onClick={() => setShowSpectrum(true)}>
            <IconVolume size={14} />
            {t("therapy.verifySpectrum")}
          </button>
          <button type="button" className="btn btn--sm" onClick={runAdaptation} disabled={adapting}>
            {adapting ? t("therapy.adapting") : t("therapy.adapt")}
          </button>
        </div>
      </header>

      {/* -- the rehabilitation programme ----------------------------------- */}
      {programme.data && (
        <RehabProgramme
          programme={programme.data}
          onChanged={() => {
            programme.reload();
            monitoring.reload();
          }}
          onOpenPlayer={() => playerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
        />
      )}

      {/* -- daily monitoring ------------------------------------------------ */}
      {/* Below the programme, not on its own screen: "what do I do today" and
          "is it working" are the same question at two timescales, and splitting
          them means the patient losing motivation never sees the evidence that
          they are improving. */}
      {monitoring.data && (
        <>
          <hr className="rule" />
          <DailyMonitoring
            monitoring={monitoring.data}
            onChanged={() => {
              monitoring.reload();
              programme.reload();
            }}
          />
        </>
      )}

      <div ref={playerRef} className="stack stack-2">
        <span className="label label--signal">{t("rehab.player.title")}</span>
        <p className="meta">{t("rehab.player.sub")}</p>
      </div>

      {/* The adherence and assessment fetches are secondary — the programme is
          still fully usable without them, so they degrade to a note rather than
          replacing the page with an error. */}
      {Boolean(adherence.error || latest.error) && (
        <Panel tone="warn" tight>
          <p className="meta">
            {t("therapy.partialLoad", {
              what: t(adherence.error ? "therapy.partialAdherence" : "therapy.partialAssessment"),
            })}{" "}
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => {
                if (adherence.error) adherence.reload();
                if (latest.error) latest.reload();
              }}
            >
              {t("common.retry")}
            </button>
          </p>
        </Panel>
      )}

      {contraindications.length > 0 && (
        <Panel tone="warn" title={t("therapy.contraindications")} bracketed>
          <ul style={{ paddingLeft: "var(--s5)", fontSize: "var(--fs-small)" }} className="stack stack-1">
            {contraindications.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </Panel>
      )}

      {/* ================================================== active player === */}
      {block && phase !== "idle" && (
        <Panel tone="signal" bracketed>
          <div className="grid grid-sidebar" style={{ ["--aside" as string]: "280px" }}>
            <div className="stack stack-5">
              <div className="row row--between">
                <div className="stack stack-1">
                  <span className="label label--signal">{scheduleLabel(t, block.schedule)}</span>
                  <h3>{block.title}</h3>
                </div>
                <div className="row row--tight">
                  <Chip tone={FAMILY_TONE[block.family] ?? "ghost"}>{block.family}</Chip>
                  {phase === "playing" && (
                    <Chip tone="signal" live>
                      {t("therapy.playing")}
                    </Chip>
                  )}
                </div>
              </div>

              {/* -- pre rating ------------------------------------------------ */}
              {phase === "pre" && (
                <div className="stack stack-4">
                  <p style={{ fontSize: "var(--fs-small)", maxWidth: "44em" }}>{block.instruction || block.goal}</p>
                  <Panel tone="sunken" tight>
                    <div className="stack stack-3">
                      <span className="label">{t("therapy.pre.prompt")}</span>
                      <Fader
                        label={t("therapy.pre.loudnessNow")}
                        value={preVas}
                        min={0}
                        max={10}
                        step={0.5}
                        onChange={setPreVas}
                        lowLabel={t("therapy.pre.silent")}
                        highLabel={t("therapy.pre.extremelyLoud")}
                      />
                      <p className="meta">{t("therapy.pre.note")}</p>
                    </div>
                  </Panel>
                  {levelSource === "conservative" && (
                    <Panel tone="info" tight>
                      <p className="meta">
                        {t("therapy.pre.uncalibrated", {
                          level: fmt.db(level.target_sensation_level_db, 0),
                        })}
                      </p>
                    </Panel>
                  )}

                  <div className="row">
                    <button type="button" className="btn btn--primary btn--lg" onClick={startPlaying}>
                      <IconPlay size={16} />
                      {t("therapy.pre.start", { minutes: fmt.duration(block.minutes) })}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => {
                        setPhase("idle");
                        setBlock(null);
                      }}
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                </div>
              )}

              {/* -- playing --------------------------------------------------- */}
              {phase === "playing" && (
                <div className="stack stack-5">
                  <div className="row" style={{ gap: "var(--s8)" }}>
                    <Readout
                      label={t("therapy.player.elapsed")}
                      value={`${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`}
                      size="lg"
                      tone="signal"
                    />
                    <Readout label={t("therapy.player.target")} value={block.minutes} unit="min" size="sm" />
                    {pitchHz && block.params.notchHz ? (
                      <Readout
                        label={t("therapy.player.notchAt")}
                        value={fmt.hz(Number(block.params.notchHz))}
                        unit="Hz"
                        size="sm"
                        tone="data"
                      />
                    ) : null}
                  </div>

                  <Meter value={progress * 100} tone="ok" tall />

                  {status && (
                    <Panel tone="sunken" tight>
                      <span className="mono" style={{ fontSize: "var(--fs-body)", fontWeight: 600 }}>
                        {status}
                      </span>
                    </Panel>
                  )}

                  <div>
                    <span className="label" style={{ marginBottom: "var(--s2)" }}>
                      {t("therapy.player.liveOutput")}
                    </span>
                    <SpectrumBars data={spectrumData} height={64} bars={56} />
                  </div>

                  <Fader
                    label={t("therapy.player.level")}
                    value={levelDbfs}
                    min={-60}
                    max={-8}
                    step={1}
                    unit="dBFS"
                    onChange={(value) => {
                      setLevelDbfs(value);
                      handleRef.current?.setLevelDb(value, 0.25);
                    }}
                    lowLabel={t("therapy.player.quieter")}
                    highLabel={t("therapy.player.louder")}
                  />

                  <Panel tone="warn" tight>
                    <p className="meta">
                      <Trans i18nKey="therapy.player.maskingWarning" components={[<strong key="0" />]} />
                    </p>
                  </Panel>

                  <div className="row">
                    <button type="button" className="btn btn--primary" onClick={finishPlaying}>
                      <IconStop size={15} />
                      {t("therapy.player.finish")}
                    </button>
                    <button
                      type="button"
                      className="btn btn--danger btn--sm"
                      onClick={() => {
                        stopPlayback();
                        setPhase("idle");
                        setBlock(null);
                        toast(t("therapy.stopped"), "info");
                      }}
                    >
                      {t("therapy.player.stopUncomfortable")}
                    </button>
                  </div>
                </div>
              )}

              {/* -- post rating ---------------------------------------------- */}
              {phase === "post" && (
                <div className="stack stack-4">
                  <span className="label label--signal">{t("therapy.post.howIsItNow")}</span>
                  <Fader
                    label={t("therapy.post.loudnessAfter")}
                    value={postVas}
                    min={0}
                    max={10}
                    step={0.5}
                    onChange={setPostVas}
                    lowLabel={t("therapy.pre.silent")}
                    highLabel={t("therapy.pre.extremelyLoud")}
                    tone="data"
                  />

                  <div className="row" style={{ gap: "var(--s8)" }}>
                    <Readout label={t("therapy.post.before")} value={preVas.toFixed(1)} size="sm" />
                    <Readout label={t("therapy.post.after")} value={postVas.toFixed(1)} size="sm" />
                    <Readout
                      label={t("therapy.post.change")}
                      value={fmt.signed(postVas - preVas, 1)}
                      size="md"
                      tone={postVas < preVas ? "ok" : postVas > preVas ? "crit" : undefined}
                    />
                  </div>

                  {postVas > preVas + 0.5 && (
                    <Panel tone="crit" tight>
                      <p className="meta">{t("therapy.post.louderWarning")}</p>
                    </Panel>
                  )}

                  <div className="row">
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => logSession(elapsed >= targetSeconds * 0.85)}
                    >
                      {t("therapy.post.save")}
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPhase("idle")}>
                      {t("therapy.post.discard")}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="stack stack-4">
              <Panel title={t("therapy.block.title")} tight headPlain tone="sunken">
                <div className="stack stack-2">
                  <p className="meta">{block.goal}</p>
                  {block.evidence && (
                    <>
                      <div className="tickrule" />
                      <span className="label">{t("therapy.block.evidence")}</span>
                      <p className="meta dim" style={{ fontSize: "var(--fs-micro)" }}>
                        {block.evidence}
                      </p>
                    </>
                  )}
                  {block.caution && (
                    <p className="meta" style={{ color: "var(--warn-ink)" }}>
                      {block.caution}
                    </p>
                  )}
                  {block.device_note && <p className="meta dim">{block.device_note}</p>}
                </div>
              </Panel>

              <Panel title={t("therapy.block.synthesis")} tight headPlain>
                <div className="stack stack-1">
                  <div className="row row--between">
                    <span className="meta">{t("therapy.block.generator")}</span>
                    <span className="mono" style={{ fontSize: "var(--fs-micro)" }}>
                      {block.engine}
                    </span>
                  </div>
                  {Object.entries(block.params)
                    .filter(([key]) => key !== "filterChain")
                    .slice(0, 8)
                    .map(([key, value]) => (
                      <div key={key} className="row row--between">
                        <span className="meta">{key}</span>
                        <span className="mono dim" style={{ fontSize: "var(--fs-micro)" }}>
                          {typeof value === "number" ? Math.round(value * 100) / 100 : String(value)}
                        </span>
                      </div>
                    ))}
                </div>
              </Panel>
            </div>
          </div>
        </Panel>
      )}

      {/* ==================================================== plan blocks === */}
      {phase === "idle" && (
        <>
          <div className="grid grid-4">
            <Panel tight>
              <Readout
                label={t("therapy.stats.adherence")}
                value={fmt.pct100(adherence.data?.adherence_pct)}
                size="md"
                tone={
                  (adherence.data?.adherence_pct ?? 0) >= 70
                    ? "ok"
                    : (adherence.data?.adherence_pct ?? 0) >= 40
                      ? "warn"
                      : "crit"
                }
                note={t("therapy.stats.adherenceNote", {
                  sessions: adherence.data?.sessions ?? 0,
                  days: adherence.data?.days_active ?? 0,
                })}
              />
            </Panel>
            <Panel tight>
              <Readout
                label={t("therapy.stats.mostEffective")}
                value={adherence.data?.best_modality ? fmt.titleCase(adherence.data.best_modality) : "—"}
                size="sm"
                tone="ok"
                note={t("therapy.stats.byRelief")}
              />
            </Panel>
            <Panel tight>
              <Readout
                label={t("therapy.stats.deliveryLevel")}
                value={fmt.db(level.target_sensation_level_db, 1)}
                unit="dB SL"
                size="md"
                tone="signal"
                note={
                  <>
                    {fmt.titleCase(String(level.strategy ?? ""))}
                    {!engine.calibration.calibratedAt && (
                      <>
                        {" · "}
                        <Link to="/assessment" style={{ color: "var(--warn-ink)" }}>
                          {t("therapy.stats.levelHeadphones")}
                        </Link>
                      </>
                    )}
                  </>
                }
              />
            </Panel>
            <Panel tight>
              <Readout
                label={t("therapy.stats.outputCap")}
                value={guardrails.absolute_output_cap_db_spl ?? "—"}
                unit="dB SPL"
                size="md"
                note={t("therapy.stats.hardLimit")}
              />
            </Panel>
          </div>

          {Object.entries(grouped).map(([schedule, blocks]) => (
            <Panel key={schedule} title={scheduleLabel(t, schedule)} bracketed>
              <div className="grid grid-auto" style={{ ["--min" as string]: "320px" }}>
                {blocks.map((item) => (
                  <Panel key={item.id} tone="sunken" tight>
                    <div className="stack stack-3">
                      <div className="row row--between row--top">
                        <div className="stack stack-1" style={{ minWidth: 0 }}>
                          <strong style={{ fontSize: "var(--fs-small)" }}>{item.title}</strong>
                          <span className="meta">{item.goal}</span>
                        </div>
                        <Chip tone={FAMILY_TONE[item.family] ?? "ghost"}>{item.minutes}m</Chip>
                      </div>
                      {item.instruction && (
                        <p className="meta" style={{ fontStyle: "italic" }}>
                          {item.instruction}
                        </p>
                      )}
                      <button
                        type="button"
                        className="btn btn--primary btn--sm btn--block"
                        onClick={() => beginBlock(item)}
                      >
                        <IconPlay size={13} />
                        {t("therapy.block.start")}
                      </button>
                    </div>
                  </Panel>
                ))}
              </div>
            </Panel>
          ))}

          <Panel
            title={
              <div className="stack stack-1">
                <h3 className="panel__title">{t("rehab.relaxing.title", { defaultValue: "Nature & Relaxing Sounds" })}</h3>
                <p className="meta" style={{ fontWeight: "normal", textTransform: "none", color: "var(--ink-3)", marginTop: "2px" }}>
                  {t("rehab.relaxing.sub", { defaultValue: "A curated collection of 20 nature and relaxation sounds generated live." })}
                </p>
              </div>
            }
            bracketed
          >
            <div className="grid grid-auto" style={{ ["--min" as string]: "320px" }}>
              {RELAXING_SOUNDS.map((item) => {
                const localizedTitle = t(`rehab.relaxing.${item.id}.title`, { defaultValue: item.title });
                const localizedGoal = t(`rehab.relaxing.${item.id}.goal`, { defaultValue: item.goal });
                return (
                  <Panel key={item.id} tone="sunken" tight>
                    <div className="stack stack-3">
                      <div className="row row--between row--top">
                        <div className="stack stack-1" style={{ minWidth: 0 }}>
                          <strong style={{ fontSize: "var(--fs-small)" }}>{localizedTitle}</strong>
                          <span className="meta">{localizedGoal}</span>
                        </div>
                        <div className="stack stack-1" style={{ alignItems: "flex-end", gap: "4px" }}>
                          <Chip tone="ghost">{engineLabel(item.engine)}</Chip>
                          <Chip tone="info">{item.minutes}m</Chip>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm btn--block"
                        onClick={() => beginBlock(item)}
                      >
                        <IconPlay size={13} />
                        {t("therapy.block.start", { defaultValue: "Start Session" })}
                      </button>
                    </div>
                  </Panel>
                );
              })}
            </div>
          </Panel>

          <Panel title={t("therapy.why")} bracketed>
            <ol className="stack stack-2" style={{ paddingLeft: "var(--s5)", fontSize: "var(--fs-small)" }}>
              {plan.rationale.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ol>
          </Panel>

          <Panel title={t("therapy.safety")} tone="warn">
            <ul className="stack stack-1" style={{ paddingLeft: "var(--s5)", fontSize: "var(--fs-small)" }}>
              {(guardrails.stop_rules ?? []).map((rule: string, i: number) => (
                <li key={i}>{rule}</li>
              ))}
            </ul>
            {guardrails.escalation && (
              <p className="meta" style={{ marginTop: "var(--s3)" }}>
                {guardrails.escalation}
              </p>
            )}
          </Panel>

          {adherence.data?.by_modality && Object.keys(adherence.data.by_modality).length > 0 && (
            <Panel title={t("therapy.worked.title")} bracketed>
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t("therapy.worked.modality")}</th>
                      <th className="num">{t("therapy.worked.sessions")}</th>
                      <th className="num">{t("therapy.worked.minutes")}</th>
                      <th className="num">{t("therapy.worked.completed")}</th>
                      <th className="num">{t("therapy.worked.meanRelief")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(adherence.data.by_modality)
                      .sort((a: any, b: any) => (b[1].mean_relief_vas ?? -9) - (a[1].mean_relief_vas ?? -9))
                      .map(([modality, stats]: [string, any]) => (
                        <tr key={modality}>
                          <td>{fmt.titleCase(modality)}</td>
                          <td className="num">{stats.sessions}</td>
                          <td className="num">{fmt.num(stats.minutes, 0)}</td>
                          <td className="num">{stats.completed}</td>
                          <td
                            className="num"
                            style={{
                              color:
                                (stats.mean_relief_vas ?? 0) >= 1
                                  ? "var(--ok)"
                                  : (stats.mean_relief_vas ?? 0) <= 0.1
                                    ? "var(--ink-4)"
                                    : undefined,
                              fontWeight: 600,
                            }}
                          >
                            {stats.mean_relief_vas === null ? "—" : fmt.signed(stats.mean_relief_vas, 2)}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <p className="meta" style={{ marginTop: "var(--s3)" }}>{t("therapy.worked.note")}</p>
            </Panel>
          )}
        </>
      )}

      <SpectrumModal
        open={showSpectrum}
        onClose={() => setShowSpectrum(false)}
        pitchHz={pitchHz}
        program={plan.program}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/**
 * Spectrum verification.
 *
 * Fetches the spectrum the *server* computed with SciPy for this prescription,
 * including the measured attenuation at the tinnitus frequency and the residual
 * energy left inside the notch. This is the check that the therapy does what the
 * plan claims — not a decorative curve.
 */
function SpectrumModal({
  open,
  onClose,
  pitchHz,
  program,
}: {
  open: boolean;
  onClose(): void;
  pitchHz: number | null;
  program: TherapyBlock[];
}) {
  const { t } = useTranslation();
  const notchBlock = program.find((b) => b.params?.notchHz);
  const notchHz = notchBlock ? Number(notchBlock.params.notchHz) : pitchHz;
  const width = notchBlock ? Number(notchBlock.params.notchWidthOctaves ?? 0.5) : 0.5;

  const spectrum = useAsync(
    () =>
      open && notchHz
        ? api.therapy.spectrum({
          notch_hz: notchHz,
          tinnitus_hz: pitchHz,
          width_octaves: width,
          depth_db: 40,
          noise_color: String(notchBlock?.params.noiseColor ?? "pink"),
        })
        : Promise.resolve(null),
    [open, notchHz, width]
  );

  const verification = spectrum.data?.verification ?? {};

  return (
    <Modal open={open} onClose={onClose} title={t("therapy.spectrum.title")}>
      {!notchHz ? (
        <p className="meta">{t("therapy.spectrum.noNotch")}</p>
      ) : spectrum.loading ? (
        <Loading label={t("therapy.spectrum.computing")} />
      ) : spectrum.error ? (
        <ErrorState error={spectrum.error} retry={spectrum.reload} />
      ) : !spectrum.data ? null : (
        // The `!spectrum.data` guard is load-bearing, not defensive padding.
        // JSX children are evaluated eagerly, so this body runs even while the
        // modal is closed — and while closed the fetch short-circuits to
        // `Promise.resolve(null)`, leaving `loading: false`, `error: null` and
        // `data: null`. Without the guard, every patient whose plan contains a
        // notched block threw `Cannot read properties of null` on opening the
        // therapy screen.
        <div className="stack stack-4">
          <p className="meta">{t("therapy.spectrum.intro")}</p>

          <SpectrumChart
            frequencies={spectrum.data.frequencies_hz}
            notchHz={notchHz}
            tinnitusHz={pitchHz}
            height={230}
            series={[
              {
                label: t("therapy.spectrum.delivered"),
                values: spectrum.data.delivered_db,
                color: "var(--signal)",
                fill: true,
              },
              {
                label: t("therapy.spectrum.filter"),
                values: spectrum.data.filter_db,
                color: "var(--data)",
                dashed: true,
              },
            ]}
          />
          <ChartLegend
            items={[
              { label: t("therapy.spectrum.deliveredSpectrum"), color: "var(--signal)" },
              { label: t("therapy.spectrum.filterResponse"), color: "var(--data)", dashed: true },
            ]}
          />

          <div className="grid grid-2">
            <Readout
              label={t("therapy.spectrum.attenuation")}
              value={fmt.db(verification.achieved_attenuation_db, 1)}
              unit="dB"
              size="md"
              tone={verification.meets_target ? "ok" : "warn"}
            />
            <Readout
              label={t("therapy.spectrum.achievedWidth")}
              value={fmt.num(verification.achieved_width_octaves, 2)}
              unit="oct"
              size="md"
              tone="data"
              note={t("therapy.spectrum.requestedWidth", { width })}
            />
            <Readout
              label={t("therapy.spectrum.residualEnergy")}
              value={fmt.num(verification.residual_energy_in_notch_pct, 3)}
              unit="%"
              size="sm"
              tone="ok"
            />
            <Readout
              label={t("therapy.spectrum.notchEdges")}
              value={
                verification.notch_edges_hz
                  ? `${fmt.hz(verification.notch_edges_hz[0])}–${fmt.hz(verification.notch_edges_hz[1])}`
                  : "—"
              }
              unit="Hz"
              size="sm"
            />
          </div>

          <Disclosure summary={t("therapy.spectrum.filterChain")}>
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("therapy.spectrum.stage")}</th>
                    <th>{t("therapy.spectrum.type")}</th>
                    <th className="num">{t("therapy.spectrum.frequency")}</th>
                    <th className="num">Q</th>
                    <th className="num">{t("therapy.spectrum.gain")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(spectrum.data.filter_chain ?? []).map((node: any, i: number) => (
                    <tr key={i}>
                      <td className="mono">{i + 1}</td>
                      <td>{node.type}</td>
                      <td className="num">{fmt.int(node.frequency)} Hz</td>
                      <td className="num">{node.Q?.toFixed(3) ?? "—"}</td>
                      <td className="num">{node.gain ? `${node.gain.toFixed(1)} dB` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="meta" style={{ marginTop: "var(--s2)" }}>
              <Trans i18nKey="therapy.spectrum.chainNote" components={[<em key="0" />]} />
            </p>
          </Disclosure>
        </div>
      )}
    </Modal>
  );
}
