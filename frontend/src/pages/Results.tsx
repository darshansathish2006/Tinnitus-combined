/**
 * The assessment report, in two layers.
 *
 * **Layer one is a plain-language clinical summary** and it is what the page
 * opens on. It answers the six questions a person actually arrives with — how is
 * my hearing, how bad is the tinnitus, what did you find, what should I be aware
 * of, what am I at risk of, and what happens next — in sentences, with a colour
 * and a word for the verdict rather than a number to decode.
 *
 * **Layer two is the full clinical report**, unchanged and complete, behind one
 * toggle. Audiogram, psychoacoustics, every instrument score, the Shapley
 * attributions, the counterfactual, coding, the management plan.
 *
 * The split exists because the two audiences want opposite things from the same
 * data and the previous single view served neither: a patient met a wall of
 * dB SL and ROC-calibrated probabilities, while a clinician had to scroll past
 * patient-facing framing to reach the attribution chart. Nothing was removed —
 * the detail is one click away and it prints in full.
 */

import { Suspense, lazy, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { api, ApiError, type AudiometryReview } from "../api/client";
import { useSession } from "../state/session";
import {
  Brand,
  Chip,
  Disclosure,
  EmptyState,
  ErrorState,
  Loading,
  Meter,
  Modal,
  Panel,
  Readout,
  UrgencyChip,
  fmt,
  useAsync,
} from "../components/ui";
import {
  IconAlert,
  IconArrowRight,
  IconCheck,
  IconChevronRight,
  IconEar,
  IconFile,
  IconInfo,
  IconShield,
  IconTarget,
  IconWave,
} from "../components/icons";
import {
  Audiogram,
  CombinedAudiogramMasking,
  Fingerprint,
  RadialGauge,
  RiCurve,
  ShapWaterfall,
  TrendChart,
} from "../components/charts";
import { TinnitusAssessmentDashboard } from "../components/TinnitusAssessmentDashboard";
import { InstrumentSectionForm, MODULE2_SECTIONS } from "./assessment/AboutYourTinnitus";

/** Field each real About Your Tinnitus instrument's answers are stored under —
 *  the same mapping `Assessment.tsx` uses to save a section during the
 *  assessment itself, reused here so completing one from the Results page
 *  writes to exactly the same place. */
const MODULE2_ITEMS_FIELD: Record<string, string> = {
  vas: "vas",
  thi: "thi_items",
  tfi: "tfi_items",
  isi: "isi_items",
  phq9: "phq9_items",
  gad7: "gad7_items",
  pss10: "pss10_items",
  whoqol_bref: "whoqol_bref_items",
};

// Three.js is ~500 kB and the summary renders long before it arrives, so the
// cochlea streams in beside the text rather than holding up the report.
const EarModel = lazy(() => import("../components/EarModel"));

const TARGET_LABELS: Record<string, { label: string; asPercent: boolean; unit: string }> = {
  // `label` is a translation key under `results.outputs.*`; the units stay as
  // SI symbols, which are not translated.
  worsening_risk: { label: "results.outputs.worsening_risk", asPercent: true, unit: "" },
  therapy_response: { label: "results.outputs.therapy_response", asPercent: true, unit: "" },
  thi_6mo: { label: "results.outputs.thi_6mo", asPercent: false, unit: " pts" },
  distress_class: { label: "results.outputs.distress_class", asPercent: true, unit: "" },
  dominant_hz: { label: "results.outputs.dominant_hz", asPercent: false, unit: " oct" },
  loudness_db_sl: { label: "results.outputs.loudness_db_sl", asPercent: false, unit: " dB" },
};

export default function Results() {
  const { t } = useTranslation();
  const session = useSession((s) => s.session);
  const toast = useSession((s) => s.toast);
  const isClinician = session?.role !== "patient";

  const assessments = useAsync(() => api.assessments.list(), []);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const completed = (assessments.data ?? []).filter((a) => a.status === "complete");
  const activeId = selectedId ?? completed[0]?.id ?? null;

  /**
   * The most recent completed assessment that actually carries an audiogram.
   *
   * The report is always *this* assessment's report — borrowing another one's
   * thresholds into it would put March's audiogram under June's heading, and a
   * report that mixes two visits is worse than one with a gap. But the patient
   * still needs to know the difference between "your hearing has never been
   * measured" and "it was measured, just not on the visit you are looking at",
   * and reading only the newest record cannot tell them apart: both render as
   * "No audiometric data".
   *
   * This is the same rule the backend already applies for the 3D cochlea, whose
   * own comment records that reading only the newest record "showed 'no
   * audiogram' for people with three of them". The audiogram on this page never
   * learned it. Computed from the list already fetched, so it costs no request.
   */
  const audiogramSourceId =
    completed.find((a) => {
      const g = (a as { audiogram?: Record<string, Record<string, number>> }).audiogram;
      return Boolean(g && (Object.keys(g.left ?? {}).length || Object.keys(g.right ?? {}).length));
    })?.id ?? null;

  const report = useAsync(
    () => (activeId ? api.reports.clinical(activeId) : Promise.resolve(null)),
    [activeId]
  );
  const analysis = useAsync(
    () => (activeId ? api.assessments.analysis(activeId) : Promise.resolve(null)),
    [activeId]
  );

  const [explainTarget, setExplainTarget] = useState<string | null>(null);
  const [fhirOpen, setFhirOpen] = useState(false);
  // "Complete <instrument>" — reopens one skipped or not-started About Your
  // Tinnitus instrument without restarting the assessment. The assessment is
  // already finalised at this point; the server allows a PATCH that touches
  // only this instrument's own items and status (see
  // `POST_COMPLETE_EDITABLE_FIELDS` in `backend/api/views.py`) and
  // `report_clinical` recomputes scores fresh on every call, so reloading the
  // report after saving is enough — no re-finalise needed.
  const [completingKey, setCompletingKey] = useState<string | null>(null);
  const [completingSaving, setCompletingSaving] = useState(false);
  const instruments = useAsync(() => api.assessments.instruments(), []);
  const [whatIf, setWhatIf] = useState<Record<string, number>>({});
  const [whatIfResult, setWhatIfResult] = useState<any>(null);
  const [whatIfBusy, setWhatIfBusy] = useState(false);
  // Clinicians land on this page to read the detail, so it opens expanded for
  // them; patients get the summary first.
  const [showDetail, setShowDetail] = useState(isClinician);

  if (assessments.loading) return <Loading label={t("results.loading")} rows={4} />;
  if (assessments.error) return <ErrorState error={assessments.error} retry={assessments.reload} />;

  if (!completed.length) {
    return (
      <Panel bracketed>
        <EmptyState
          title={t("results.emptyTitle")}
          body={t("results.emptyBody")}
          action={
            <Link className="btn btn--primary" to="/assessment">
              Start an assessment
            </Link>
          }
        />
      </Panel>
    );
  }

  const data = report.data;
  const detail = analysis.data?.analysis;
  /** Does the assessment currently on screen carry any thresholds? */
  const hasAudiogram = Boolean(
    data?.audiometry?.raw &&
      (Object.keys(data.audiometry.raw.left ?? {}).length ||
        Object.keys(data.audiometry.raw.right ?? {}).length)
  );
  const prediction = detail?.prediction;
  const outputs = prediction?.outputs ?? {};
  const tri = detail?.derived?.tri;

  // Trajectory across all completed assessments.
  const trajectory = completed
    .slice()
    .reverse()
    .map((a) => ({
      date: a.created_at,
      thi: a.thi_score,
      psqi: a.psqi_score,
      gad7: a.gad7_score,
      tri: a.derived?.tri?.score ?? null,
    }));

  /**
   * Print the whole report, not whatever happens to be expanded.
   *
   * The detail section is unmounted while collapsed rather than hidden, so it
   * has to be mounted and laid out before the print dialog opens — a printed
   * "full clinical report" that silently omits the audiogram because the reader
   * had it collapsed would be a genuinely dangerous document.
   */
  function printReport() {
    if (showDetail) {
      window.print();
      return;
    }
    setShowDetail(true);
    window.setTimeout(() => window.print(), 150);
  }

  async function saveCompletedInstrument(
    domainKey: string,
    items: Record<string, number> | undefined,
    sectionStatus: "completed" | "skipped"
  ) {
    if (!activeId) return;
    const field = MODULE2_ITEMS_FIELD[domainKey];
    const body: Record<string, unknown> = { questionnaire_status: { [domainKey]: sectionStatus } };
    if (sectionStatus === "completed" && field && items) {
      // Same split as `Assessment.tsx::saveModule2Section` — the PHQ-9's
      // functional-difficulty answer and the VAS's pain faces rating both
      // travel in the same `items` dict but are never scored items of the
      // instrument that asked them.
      const { phq9_functional_difficulty, vas_pain, ...scoredItems } = items as Record<string, number> & {
        phq9_functional_difficulty?: number;
        vas_pain?: number;
      };
      body[field] = scoredItems;
      if (domainKey === "phq9" && phq9_functional_difficulty !== undefined) {
        body.phq9_functional_difficulty = phq9_functional_difficulty;
      }
      if (domainKey === "vas" && vas_pain !== undefined) {
        body.vas_pain = vas_pain;
      }
    }
    setCompletingSaving(true);
    try {
      await api.assessments.save(activeId, body);
      setCompletingKey(null);
      await Promise.all([report.reload(), assessments.reload()]);
      toast(t("results.dashboard.instrumentSaved", { defaultValue: "Saved." }), "ok");
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("results.dashboard.instrumentSaveFailed", { defaultValue: "Could not save — please try again." }), "crit");
    } finally {
      setCompletingSaving(false);
    }
  }

  async function runWhatIf() {
    if (!activeId || Object.keys(whatIf).length === 0) return;
    setWhatIfBusy(true);
    try {
      setWhatIfResult(await api.ml.whatIf(whatIf, activeId));
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("results.counterfactualFailed"), "crit");
    } finally {
      setWhatIfBusy(false);
    }
  }

  return (
    <div className="stack stack-6">
      <header className="row row--between no-print">
        <div className="stack stack-1">
          <span className="label label--signal">Report</span>
          <h1>{t("results.title")}</h1>
          <p className="meta">
            {completed.length} completed assessment{completed.length > 1 ? "s" : ""} on record
          </p>
        </div>
        <div className="row row--tight">
          {completed.length > 1 && (
            <select
              className="select"
              style={{ width: "auto" }}
              value={activeId ?? ""}
              onChange={(e) => setSelectedId(Number(e.target.value))}
            >
              {completed.map((a) => (
                <option key={a.id} value={a.id}>
                  {fmt.date(a.created_at)} — THI {a.thi_score ?? "—"}
                </option>
              ))}
            </select>
          )}
          {isClinician && (
            <button type="button" className="btn btn--sm" onClick={() => setFhirOpen(true)}>
              FHIR export
            </button>
          )}
          <button type="button" className="btn btn--sm btn--primary" onClick={printReport}>
            Print / PDF
          </button>
        </div>
      </header>

      {report.loading || analysis.loading ? (
        <Loading label={t("results.assembling")} rows={5} />
      ) : report.error ? (
        <ErrorState error={report.error} retry={report.reload} />
      ) : !data || !detail ? null : (
        <>
          {/* ================================================== summary === */}
          <ClinicalSummary report={data} detail={detail} />

          {/* ============================== 04 · tinnitus assessment results === */}
          {/* Everything here is additive to the plain summary above — the same
              report, read into the fuller dashboard structure, never a second
              source of truth for the same numbers. See
              `TinnitusAssessmentDashboard.tsx` for exactly which existing
              calculation backs each card. */}
          <TinnitusAssessmentDashboard
            report={data}
            activeAssessment={completed.find((a) => a.id === activeId) ?? null}
            onCompleteInstrument={setCompletingKey}
          />

          {/* -- the gate to everything technical ------------------------- */}
          <button
            type="button"
            className="reveal no-print"
            data-tour="reports"
            aria-expanded={showDetail}
            aria-controls="full-clinical-report"
            onClick={() => setShowDetail((v) => !v)}
          >
            <IconChevronRight size={18} className="reveal__chev" />
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong style={{ display: "block", fontSize: "var(--fs-body)" }}>
                {t(showDetail ? "results.hideDetail" : "results.showDetail")}
              </strong>
              <span className="meta">
                Audiogram and calibration, every instrument score, psychoacoustic measurements, the model's
                per-driver attributions, clinical reasoning and coding.
              </span>
            </span>
            <IconFile size={18} style={{ flex: "none", color: "var(--ink-3)" }} />
          </button>

          {showDetail && (
          <div id="full-clinical-report" className="stack stack-6 fade-in">
          {/* -- document header ------------------------------------------- */}
          <Panel bracketed>
            {/* The mark heads the printed document. A report that leaves the app
                as a PDF has to be identifiable as an EchoSense report. */}
            <div className="row row--between" style={{ marginBottom: "var(--s4)" }}>
              <Brand subtitle={t("results.reportSubtitle")} />
              <span className="meta mono">{data.patient.mrn}</span>
            </div>
            <hr className="rule rule--tight" />
            <div className="row row--between row--top">
              <div className="stack stack-2">
                <h2 className="serif" style={{ fontFamily: "var(--font-serif)" }}>
                  {data.meta.title}
                </h2>
                <div className="row row--tight">
                  <Chip tone="ghost">{data.patient.mrn}</Chip>
                  <Chip tone="ghost">
                    {data.patient.age ? `${data.patient.age} y` : "age unknown"} · {data.patient.sex ?? "—"}
                  </Chip>
                  <Chip tone="ghost">assessed {fmt.date(data.meta.assessment_date)}</Chip>
                  {data.meta.model_version && <Chip tone="ghost">{data.meta.model_version}</Chip>}
                </div>
              </div>
              <div className="stack stack-1 right">
                <span className="label">Generated</span>
                <span className="mono meta">{fmt.dateTime(data.meta.generated_at)}</span>
              </div>
            </div>

            <hr className="rule" />

            <p className="lead" style={{ fontSize: "var(--fs-body)" }}>
              {data.summary.headline}
            </p>

            <div className="grid grid-2" style={{ marginTop: "var(--s4)" }}>
              <div className="stack stack-2">
                <span className="label">Findings</span>
                <ul className="stack stack-1" style={{ paddingLeft: "var(--s5)", fontSize: "var(--fs-small)" }}>
                  {data.summary.findings.map((finding: string, i: number) => (
                    <li key={i}>{finding}</li>
                  ))}
                </ul>
              </div>
              <div className="stack stack-2">
                <span className="label">Recommended actions</span>
                <ul className="stack stack-1" style={{ paddingLeft: "var(--s5)", fontSize: "var(--fs-small)" }}>
                  {data.summary.actions.map((action: string, i: number) => (
                    <li key={i}>{action}</li>
                  ))}
                </ul>
              </div>
            </div>
          </Panel>

          {/* -- safety ---------------------------------------------------- */}
          <Panel
            title={t("results.clinical.safetyScreening")}
            tone={data.safety.count === 0 ? "ok" : data.safety.highest_urgency === "routine" ? "info" : "crit"}
            aside={<UrgencyChip urgency={data.safety.highest_urgency} />}
            bracketed
          >
            {data.safety.count === 0 ? (
              <p style={{ fontSize: "var(--fs-small)" }}>{data.safety.summary}</p>
            ) : (
              <div className="stack stack-4">
                {data.safety.flags.map((flag: any) => (
                  <div key={flag.code} className="stack stack-1">
                    <div className="row row--tight">
                      <UrgencyChip urgency={flag.urgency} />
                      <strong style={{ fontSize: "var(--fs-small)" }}>{flag.title}</strong>
                      <Chip tone="ghost">{flag.pathway}</Chip>
                    </div>
                    <p className="meta">{flag.evidence}</p>
                    <p style={{ fontSize: "var(--fs-small)" }}>{flag.action}</p>
                  </div>
                ))}
                <p className="meta dim">
                  These checks are rule-based and run before and independently of the prediction models, so a
                  referral never depends on an ML artifact being available.
                </p>
              </div>
            )}
          </Panel>

          {/* -- measurements --------------------------------------------- */}
          <div className="grid grid-sidebar" style={{ ["--aside" as string]: "330px" }}>
            <div className="stack stack-5">
              <Panel title={t("results.clinical.audiometry")} bracketed>
                <Audiogram
                  audiogram={data.audiometry.raw}
                  pitchHz={data.psychoacoustics.pitch_match_hz}
                  notchHz={data.audiometry.audiometric_notch_hz}
                  height={330}
                />
                <AudiometryReviewBlock review={data.audiometry.review} />
                {!hasAudiogram && (
                  <AudiogramElsewhereNotice
                    sourceId={audiogramSourceId === activeId ? null : audiogramSourceId}
                    onOpen={setSelectedId}
                  />
                )}
                <MaskingOverlayBlock report={data} />
                <div className="grid grid-4" style={{ marginTop: "var(--s4)" }}>
                  <Readout label={t("results.clinical.ptaRight")} value={fmt.db(data.audiometry.pta_right, 1)} unit="dB HL" size="sm" />
                  <Readout label={t("results.clinical.ptaLeft")} value={fmt.db(data.audiometry.pta_left, 1)} unit="dB HL" size="sm" />
                  <Readout label={t("results.clinical.asymmetry")} value={fmt.db(data.audiometry.asymmetry_db, 1)} unit="dB" size="sm"
                    tone={(data.audiometry.asymmetry_db ?? 0) >= 15 ? "crit" : undefined} />
                  <Readout label={t("results.clinical.whoGrade")} value={data.audiometry.who_grade ?? "—"} size="sm" />
                </div>
                <div className="grid grid-2" style={{ marginTop: "var(--s3)" }}>
                  <Readout label={t("results.clinical.configRight")} value={data.audiometry.configuration_right ?? "—"} size="sm" />
                  <Readout label={t("results.clinical.configLeft")} value={data.audiometry.configuration_left ?? "—"} size="sm" />
                </div>
                {data.audiometry.notch && (
                  <Panel tone="warn" tight style={{ marginTop: "var(--s3)" }}>
                    <p className="meta">
                      Audiometric notch at {data.audiometry.notch.centre_hz} Hz, {data.audiometry.notch.depth_db} dB
                      deep with {data.audiometry.notch.recovery_db} dB recovery — the pattern associated with noise
                      exposure (Coles criteria).
                    </p>
                  </Panel>
                )}
                <Disclosure summary={t("results.clinical.calibrationProvenance")}>
                  <div className="grid grid-2">
                    {Object.entries(data.audiometry.device_profile ?? {}).map(([key, value]) => (
                      <div key={key} className="row row--between">
                        <span className="meta">{fmt.titleCase(key)}</span>
                        <span className="mono dim" style={{ fontSize: "var(--fs-micro)" }}>
                          {String(value).slice(0, 40)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="meta" style={{ marginTop: "var(--s2)" }}>
                    Browser-based thresholds are screening estimates. They are comparable across sessions on the
                    same hardware but are not calibrated clinical audiometry.
                  </p>
                </Disclosure>
              </Panel>

              <Panel title={t("results.clinical.psychoacoustics")} bracketed>
                <div className="grid grid-4">
                  <Readout
                    label={t("results.clinical.matchedPitch")}
                    value={fmt.hz(data.psychoacoustics.pitch_match_hz)}
                    unit="Hz"
                    size="md"
                    tone="signal"
                    note={
                      data.psychoacoustics.pitch_match_confidence !== null
                        ? `confidence ${fmt.pct(data.psychoacoustics.pitch_match_confidence, 0)}`
                        : undefined
                    }
                  />
                  <Readout
                    label={t("results.clinical.loudness")}
                    value={fmt.db(data.psychoacoustics.loudness_match_db_sl, 1)}
                    unit="dB SL"
                    size="md"
                  />
                  <Readout label={t("results.clinical.mml")} value={fmt.db(data.psychoacoustics.mml_db_sl, 1)} unit="dB SL" size="md" tone="data" />
                  <Readout
                    label={t("results.clinical.bandwidth")}
                    value={fmt.titleCase(data.psychoacoustics.bandwidth)}
                    size="sm"
                  />
                </div>

                <hr className="rule" />

                <div className="grid grid-2">
                  <div className="stack stack-2">
                    <span className="label">Maskability</span>
                    <Readout
                      label=""
                      value={data.psychoacoustics.maskability?.category ?? "—"}
                      size="sm"
                      note={
                        data.psychoacoustics.maskability?.index !== null
                          ? `index ${fmt.num(data.psychoacoustics.maskability?.index, 2)}`
                          : undefined
                      }
                    />
                  </div>
                  <div className="stack stack-2">
                    <span className="label">Residual inhibition</span>
                    <Readout
                      label=""
                      value={data.psychoacoustics.residual_inhibition?.category ?? "—"}
                      size="sm"
                      tone={
                        data.psychoacoustics.residual_inhibition?.category === "Rebound"
                          ? "crit"
                          : ["Complete", "Partial"].includes(data.psychoacoustics.residual_inhibition?.category)
                            ? "ok"
                            : undefined
                      }
                    />
                  </div>
                </div>

                {data.psychoacoustics.residual_inhibition?.note && (
                  <p className="meta" style={{ marginTop: "var(--s3)" }}>
                    {data.psychoacoustics.residual_inhibition.note}
                  </p>
                )}

                {detail.derived?.residual_inhibition && analysis.data?.assessment && (
                  <div style={{ marginTop: "var(--s4)" }}>
                    <RiCurve
                      trace={(analysis.data.assessment as any).ri_trace ?? []}
                      depthPct={analysis.data.assessment.ri_depth_pct}
                      durationS={analysis.data.assessment.ri_duration_s}
                    />
                  </div>
                )}

                {(data.psychoacoustics.ldl_left !== null || data.psychoacoustics.ldl_right !== null) && (
                  <div className="grid grid-2" style={{ marginTop: "var(--s3)" }}>
                    <Readout label={t("results.clinical.ldlRight")} value={data.psychoacoustics.ldl_right ?? "—"} unit="dB HL" size="sm" />
                    <Readout label={t("results.clinical.ldlLeft")} value={data.psychoacoustics.ldl_left ?? "—"} unit="dB HL" size="sm" />
                  </div>
                )}
              </Panel>

              {/* -- questionnaires ---------------------------------------- */}
              <Panel title={t("results.clinical.instruments")} bracketed>
                <div className="scroll-x">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t("results.clinical.instrument")}</th>
                        <th className="num">Score</th>
                        <th>Grade</th>
                        <th>{t("results.clinical.interpretation")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {["thi", "psqi", "pss10", "gad7", "phq2"].map((key) => {
                        const score = data.questionnaires[key];
                        if (!score) return null;
                        return (
                          <tr key={key}>
                            <td>
                              <strong>{score.instrument}</strong>
                              {score.prorated && (
                                <span className="meta dim"> · prorated</span>
                              )}
                            </td>
                            <td className="num">
                              {score.score ?? "—"}
                              <span className="dim">/{score.max_score}</span>
                            </td>
                            <td>{score.grade ?? "—"}</td>
                            <td className="meta" style={{ maxWidth: 380 }}>
                              {score.interpretation}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {data.questionnaires.thi?.subscales && (
                  <div className="grid grid-3" style={{ marginTop: "var(--s4)" }}>
                    {["functional", "emotional", "catastrophic"].map((sub) => {
                      const value = data.questionnaires.thi.subscales[sub];
                      if (!value) return null;
                      return (
                        <div key={sub} className="stack stack-1">
                          <div className="row row--between">
                            <span className="label">{sub}</span>
                            <span className="mono meta">
                              {value.score ?? "—"}/{value.max}
                            </span>
                          </div>
                          <Meter
                            value={value.percent ?? 0}
                            tone={(value.percent ?? 0) >= 60 ? "crit" : (value.percent ?? 0) >= 35 ? "warn" : "ok"}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}

                {data.questionnaires.vas && (
                  <div className="grid grid-4" style={{ marginTop: "var(--s4)" }}>
                    {Object.entries(data.questionnaires.vas).map(([key, value]) => (
                      <Readout
                        key={key}
                        label={fmt.titleCase(key.replace("vas_", ""))}
                        value={value === null ? "—" : fmt.num(value as number, 1)}
                        unit="/10"
                        size="sm"
                      />
                    ))}
                  </div>
                )}

                {/* The pain faces scale — a separate question asked after the
                    four scales above, so it is reported beside them rather
                    than inside that grid, with the band the printed scale's
                    own correlation puts it in. */}
                {data.questionnaires.vas_pain?.score != null && (
                  <div style={{ marginTop: "var(--s4)" }}>
                    <Readout
                      label={t("results.clinical.painScale", { defaultValue: "Pain (VAS faces)" })}
                      value={fmt.num(data.questionnaires.vas_pain.score, 0)}
                      unit="/10"
                      size="sm"
                      tone={
                        data.questionnaires.vas_pain.band === "severe"
                          ? "crit"
                          : data.questionnaires.vas_pain.band === "moderate"
                            ? "warn"
                            : "ok"
                      }
                      note={data.questionnaires.vas_pain.interpretation}
                    />
                  </div>
                )}

                {(data.stepped_screening?.administration?.deferred ?? []).length > 0 && (
                  <Panel tone="warn" tight style={{ marginTop: "var(--s3)" }}>
                    <span className="label" style={{ color: "var(--warn-ink)" }}>
                      Indicated but not administered
                    </span>
                    <p className="meta" style={{ marginTop: "var(--s1)" }}>
                      {data.stepped_screening.administration.deferred
                        .map((key: string) => key.toUpperCase())
                        .join(", ")}{" "}
                      screened positive but the patient deferred the long form. Those scores are absent because
                      the instrument was not administered, not because it was negative — an outstanding
                      recommendation rather than a normal result.
                    </p>
                  </Panel>
                )}

                {(data.questionnaires.thi?.flags ?? []).length > 0 && (
                  <Panel tone="crit" tight style={{ marginTop: "var(--s3)" }}>
                    <span className="label" style={{ color: "var(--crit-ink)" }}>
                      Item-level flags
                    </span>
                    <p className="meta" style={{ marginTop: "var(--s1)" }}>
                      {data.questionnaires.thi.flags.join(", ").replace(/_/g, " ")} — maximal responses on the
                      hopelessness cluster warrant a psychological pathway independently of the total score.
                    </p>
                  </Panel>
                )}
              </Panel>

              {/* -- explainability ---------------------------------------- */}
              {prediction && Object.keys(prediction.explanations ?? {}).length > 0 && (
                <Panel title={t("results.clinical.whyModel")} bracketed>
                  <div className="stack stack-5">
                    <p className="meta">
                      {prediction.explanations[Object.keys(prediction.explanations)[0]]?.method}. Attributions sum
                      exactly to the difference between the cohort baseline and this patient's prediction — the
                      chart cannot hide a contribution.
                    </p>

                    {["worsening_risk", "therapy_response", "thi_6mo"].map((target) => {
                      const explanation = prediction.explanations[target];
                      if (!explanation) return null;
                      const meta = TARGET_LABELS[target];
                      return (
                        <div key={target} className="stack stack-3">
                          <div className="row row--between row--baseline">
                            <span className="label label--signal">{meta?.label ?? target}</span>
                            <button
                              type="button"
                              className="btn btn--sm btn--ghost no-print"
                              onClick={() => setExplainTarget(target)}
                            >
                              Full attribution
                            </button>
                          </div>
                          <ShapWaterfall
                            drivers={explanation.drivers.slice(0, 6)}
                            baseline={explanation.baseline}
                            prediction={explanation.prediction}
                            asPercent={meta?.asPercent ?? false}
                            unit={meta?.unit ?? ""}
                          />
                          {prediction.narratives?.[target] && (
                            <p className="meta">{prediction.narratives[target]}</p>
                          )}
                        </div>
                      );
                    })}

                    <hr className="rule" />

                    <div className="stack stack-2">
                      <span className="label">Consistency checks</span>
                      {(prediction.consistency_checks ?? []).map((check) => (
                        <div key={check.check} className="row row--top row--tight">
                          <Chip tone={check.passed ? "ok" : "warn"} dot>
                            {check.passed ? "pass" : "review"}
                          </Chip>
                          <span className="meta" style={{ flex: 1 }}>
                            {check.detail}
                          </span>
                        </div>
                      ))}
                      <p className="meta dim">
                        Scored on {prediction.features_measured} of {prediction.features_total} features — missing
                        values are handled natively by the models rather than imputed.
                      </p>
                    </div>
                  </div>
                </Panel>
              )}

              {/* -- what-if (clinician only) ------------------------------ */}
              {isClinician && prediction && (
                <Panel title="Counterfactual" bracketed className="no-print">
                  <div className="stack stack-4">
                    <p className="meta">
                      Ask what the projection would be if a modifiable factor changed. This shows which lever
                      actually moves the number — a more useful question than the risk figure alone.
                    </p>
                    <div className="grid grid-3">
                      {[
                        { key: "pss10_score", label: "PSS-10", max: 40 },
                        { key: "psqi_score", label: "PSQI", max: 21 },
                        { key: "gad7_score", label: "GAD-7", max: 21 },
                      ].map((field) => (
                        <div key={field.key} className="stack stack-1">
                          <div className="row row--between">
                            <span className="label">{field.label}</span>
                            <span className="mono meta">
                              {whatIf[field.key] ?? (analysis.data?.assessment as any)?.[field.key] ?? "—"}
                            </span>
                          </div>
                          <input
                            className="fader fader--data"
                            type="range"
                            min={0}
                            max={field.max}
                            value={whatIf[field.key] ?? (analysis.data?.assessment as any)?.[field.key] ?? 0}
                            onChange={(e) =>
                              setWhatIf((prev) => ({ ...prev, [field.key]: Number(e.target.value) }))
                            }
                          />
                        </div>
                      ))}
                    </div>
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn--sm btn--primary"
                        onClick={runWhatIf}
                        disabled={whatIfBusy || Object.keys(whatIf).length === 0}
                      >
                        {t(whatIfBusy ? "results.clinical.scoring" : "results.clinical.recompute")}
                      </button>
                      {whatIfResult && (
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          onClick={() => {
                            setWhatIf({});
                            setWhatIfResult(null);
                          }}
                        >
                          Reset
                        </button>
                      )}
                    </div>

                    {whatIfResult && (
                      <div className="grid grid-3">
                        {["worsening_risk", "therapy_response", "thi_6mo"].map((key) => {
                          const before = whatIfResult.before[key];
                          const after = whatIfResult.after[key];
                          if (typeof before !== "number" || typeof after !== "number") return null;
                          const isPct = key !== "thi_6mo";
                          const improved = key === "therapy_response" ? after > before : after < before;
                          return (
                            <Readout
                              key={key}
                              label={TARGET_LABELS[key]?.label ?? key}
                              value={`${isPct ? fmt.pct(before, 0) : fmt.int(before)} → ${isPct ? fmt.pct(after, 0) : fmt.int(after)}`}
                              size="sm"
                              tone={Math.abs(after - before) < 1e-6 ? undefined : improved ? "ok" : "crit"}
                            />
                          );
                        })}
                        <p className="meta span-full">{whatIfResult.note}</p>
                      </div>
                    )}
                  </div>
                </Panel>
              )}
            </div>

            {/* -- sidebar ------------------------------------------------- */}
            <div className="stack stack-5">
              <Panel title={t("results.clinical.compositeIndex")} headPlain tight>
                <div className="center stack stack-3">
                  <RadialGauge
                    value={tri?.score ?? null}
                    label="TRI"
                    sublabel={tri?.band}
                    tone={(tri?.score ?? 0) >= 60 ? "crit" : (tri?.score ?? 0) >= 40 ? "warn" : "data"}
                  />
                  <p className="meta">{tri?.recommended_intensity}</p>
                </div>
                {tri?.components && (
                  <Disclosure summary={t("results.clinical.componentBreakdown")}>
                    <div className="stack stack-1">
                      {tri.components.map((component: any) => (
                        <div key={component.key} className="row row--between">
                          <span className="meta" style={{ minWidth: 0, flex: 1 }}>
                            {component.label}
                          </span>
                          <span className="mono dim" style={{ fontSize: "var(--fs-micro)" }}>
                            w{component.weight} ·{" "}
                            {component.contribution === null ? "n/a" : component.contribution.toFixed(1)}
                          </span>
                        </div>
                      ))}
                      <p className="meta dim" style={{ marginTop: "var(--s2)", fontSize: "var(--fs-micro)" }}>
                        Coverage {fmt.pct(tri.coverage, 0)} — the index is renormalised over the components that
                        were actually measured, so a missing questionnaire does not silently score as zero.
                      </p>
                    </div>
                  </Disclosure>
                )}
              </Panel>

              <Panel title={t("results.clinical.spectralSignature")} headPlain tight>
                <div className="center">
                  <Fingerprint
                    signature={detail.derived?.spectral_signature}
                    pitchHz={data.psychoacoustics.pitch_match_hz}
                    size={215}
                  />
                </div>
              </Panel>

              {Object.keys(outputs).length > 0 && (
                <Panel title={t("results.clinical.projections")} headPlain tight>
                  <div className="stack stack-3">
                    <Readout
                      label={t("results.clinical.predictedDominant")}
                      value={fmt.hz(outputs.dominant_hz)}
                      unit="Hz"
                      size="sm"
                      tone="data"
                      note={t("results.clinical.fromHearingAlone")}
                    />
                    <Readout
                      label={t("results.clinical.predictedLoudness")}
                      value={fmt.db(outputs.loudness_db_sl, 1)}
                      unit="dB SL"
                      size="sm"
                    />
                    <Readout
                      label={t("results.clinical.distressBand")}
                      value={fmt.titleCase(outputs.distress_class)}
                      size="sm"
                      note={
                        outputs.distress_class_confidence
                          ? `confidence ${fmt.pct(outputs.distress_class_confidence, 0)}`
                          : undefined
                      }
                    />
                    <hr className="rule rule--tight" />
                    <Readout
                      label={t("results.clinical.worseningRisk")}
                      value={fmt.pct(outputs.worsening_risk, 0)}
                      size="md"
                      tone={
                        (outputs.worsening_risk ?? 0) >= 0.5 ? "crit" : (outputs.worsening_risk ?? 0) >= 0.25 ? "warn" : "ok"
                      }
                      note={outputs.risk_action}
                    />
                    <Readout
                      label={t("results.clinical.therapyResponse")}
                      value={fmt.pct(outputs.therapy_response, 0)}
                      size="md"
                      tone={(outputs.therapy_response ?? 0) >= 0.5 ? "ok" : "warn"}
                    />
                    <Readout
                      label={t("results.clinical.projectedThi")}
                      value={fmt.int(outputs.thi_6mo)}
                      unit="/100"
                      size="md"
                      note={
                        prediction?.intervals?.thi_6mo
                          ? `80% interval ${fmt.int(prediction.intervals.thi_6mo.low)}–${fmt.int(prediction.intervals.thi_6mo.high)}`
                          : undefined
                      }
                    />
                  </div>
                </Panel>
              )}

              {/* -- coding ------------------------------------------------ */}
              <Panel title={t("results.clinical.coding")} headPlain tight>
                <div className="stack stack-2">
                  {data.coding.icd11.map((code: any) => (
                    <div key={code.code} className="stack stack-1">
                      <div className="row row--tight">
                        <span className="mono" style={{ fontSize: "var(--fs-small)", fontWeight: 700 }}>
                          {code.code}
                        </span>
                        {code.primary && <Chip tone="signal">primary</Chip>}
                        {code.verify && <Chip tone="warn">verify</Chip>}
                      </div>
                      <span className="meta">{code.title}</span>
                      <span className="meta dim" style={{ fontSize: "var(--fs-micro)" }}>
                        {code.rationale}
                      </span>
                    </div>
                  ))}
                  <p className="meta dim" style={{ fontSize: "var(--fs-micro)", marginTop: "var(--s2)" }}>
                    {data.coding.disclaimer}
                  </p>
                </div>
              </Panel>
            </div>
          </div>

          {/* -- trajectory ------------------------------------------------ */}
          {trajectory.length > 1 && (
            <Panel title={t("results.clinical.trajectory")} bracketed>
              <TrendChart
                points={trajectory}
                height={230}
                yMax={100}
                yLabel="score"
                series={[
                  { key: "thi", label: "THI", color: "var(--signal)", width: 2.4, dots: true },
                  { key: "tri", label: "TRI", color: "var(--data)", width: 1.8, dots: true },
                  { key: "psqi", label: "PSQI", color: "var(--warn)", width: 1.2, dashed: true, dots: true },
                ]}
              />
              <p className="meta" style={{ marginTop: "var(--s3)" }}>
                A change of 7 points or more is the accepted minimum clinically important difference on the
                full 25-item THI. Assessments taken with the 5-item short form move in steps of 10, so every
                change they can show already exceeds that threshold — read the direction and the grade, not
                the margin.
              </p>
            </Panel>
          )}

          {/* -- management plan ------------------------------------------- */}
          {data.management_plan?.program && (
            <Panel
              title={t("results.clinical.managementPlan")}
              aside={
                <Chip tone={data.management_plan.approved ? "ok" : "warn"} dot>
                  {data.management_plan.approved ? "clinician approved" : "AI draft"}
                </Chip>
              }
              bracketed
            >
              <div className="stack stack-4">
                <div className="grid grid-4">
                  <Readout label={t("results.clinical.strategy")} value={fmt.titleCase(data.management_plan.strategy)} size="sm" />
                  <Readout label={t("results.clinical.dailyTarget")} value={data.management_plan.daily_minutes_target} unit="min" size="sm" tone="signal" />
                  <Readout label={t("results.clinical.reviewIn")} value={data.management_plan.review_after_days} unit="days" size="sm" />
                  <Readout label={t("results.clinical.revision")} value={data.management_plan.revision ?? "—"} size="sm" />
                </div>

                <div className="scroll-x">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Block</th>
                        <th>{t("results.clinical.family")}</th>
                        <th>{t("results.clinical.schedule")}</th>
                        <th className="num">Minutes</th>
                        <th>{t("results.clinical.mechanism")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.management_plan.program.map((block: any) => (
                        <tr key={block.id}>
                          <td>
                            <strong>{block.title}</strong>
                          </td>
                          <td>{fmt.titleCase(block.family)}</td>
                          <td>{fmt.titleCase(block.schedule)}</td>
                          <td className="num">{block.minutes}</td>
                          <td className="meta" style={{ maxWidth: 340 }}>
                            {block.goal}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="stack stack-2">
                  <span className="label">Clinical reasoning</span>
                  <ol className="stack stack-1" style={{ paddingLeft: "var(--s5)", fontSize: "var(--fs-small)" }}>
                    {(data.management_plan.rationale ?? []).map((reason: string, i: number) => (
                      <li key={i}>{reason}</li>
                    ))}
                  </ol>
                </div>
              </div>
            </Panel>
          )}

          <Panel tone="sunken">
            <p className="meta">{data.disclaimer}</p>
          </Panel>
          </div>
          )}
        </>
      )}

      {/* -- modals ---------------------------------------------------------- */}
      <Modal
        open={explainTarget !== null}
        onClose={() => setExplainTarget(null)}
        title={explainTarget ? (TARGET_LABELS[explainTarget]?.label ?? explainTarget) : ""}
      >
        {explainTarget && prediction?.explanations[explainTarget] && (
          <div className="stack stack-4">
            <ShapWaterfall
              drivers={prediction.explanations[explainTarget].drivers}
              baseline={prediction.explanations[explainTarget].baseline}
              prediction={prediction.explanations[explainTarget].prediction}
              asPercent={TARGET_LABELS[explainTarget]?.asPercent ?? false}
              unit={TARGET_LABELS[explainTarget]?.unit ?? ""}
            />
            <hr className="rule" />
            <div className="stack stack-2">
              <span className="label">Contribution by group</span>
              {prediction.explanations[explainTarget].group_contributions.map((group) => (
                <div key={group.group} className="stack stack-1">
                  <div className="row row--between">
                    <span className="meta">{fmt.titleCase(group.group)}</span>
                    <span className="mono meta">{group.share_pct}%</span>
                  </div>
                  <Meter value={group.share_pct} tone={group.contribution > 0 ? "crit" : "ok"} />
                </div>
              ))}
            </div>
            <p className="meta dim">
              {prediction.explanations[explainTarget].method}. Local-accuracy residual{" "}
              {prediction.explanations[explainTarget].local_accuracy_residual.toExponential(1)} — the attributions
              reconstruct the prediction to numerical precision.
            </p>
          </div>
        )}
      </Modal>

      <FhirModal open={fhirOpen} onClose={() => setFhirOpen(false)} assessmentId={activeId} />

      <Modal
        open={completingKey !== null}
        onClose={() => setCompletingKey(null)}
        title={
          completingKey
            ? t("results.dashboard.completeInstrument", {
                instrument: MODULE2_SECTIONS.find((s) => s.key === completingKey)?.instrumentAbbrev ?? completingKey,
                defaultValue: `Complete ${MODULE2_SECTIONS.find((s) => s.key === completingKey)?.instrumentAbbrev ?? completingKey}`,
              })
            : ""
        }
      >
        {completingKey && (
          <InstrumentSectionForm
            section={MODULE2_SECTIONS.find((s) => s.key === completingKey)!}
            instruments={instruments.data?.instruments ?? null}
            onSkip={() => saveCompletedInstrument(completingKey, undefined, "skipped")}
            onSubmit={(answers) => saveCompletedInstrument(completingKey, answers, "completed")}
            submitLabel={t("common.save", { defaultValue: "Save" })}
            saving={completingSaving}
            // The three Core Tinnitus Assessment instruments (VAS, THI, TFI)
            // are mandatory and never treated as complete when skipped — see
            // `AboutYourTinnitus` — so reopening one here offers no Skip either.
            allowSkip={!MODULE2_SECTIONS.find((s) => s.key === completingKey)?.required}
          />
        )}
      </Modal>
    </div>
  );
}

/* ========================================================================= */
/* Clinical summary — the default view                                       */
/* ========================================================================= */

type Tone = "ok" | "warn" | "crit" | "data" | "signal";

/** WHO 2021 better-ear grade → verdict word and how worried to look. */
const HEARING_TONE: Record<string, Tone> = {
  "no impairment": "ok",
  mild: "warn",
  moderate: "warn",
  "moderately severe": "crit",
  severe: "crit",
  profound: "crit",
  complete: "crit",
};

/**
 * THI grade number → the tone its verdict is shown in.
 *
 * Only the tone lives here now. The one-word verdict and the sentence a patient
 * should take away are looked up under `results.severity.<grade>`, because they
 * are the most-read prose on the most-read screen in the product and they have
 * to be in the patient's own language.
 */
const THI_TONE: Record<number, Tone> = { 1: "ok", 2: "ok", 3: "warn", 4: "crit", 5: "crit" };

/** Icons are foreground, so they take the accessible text variant of the tone. */
function toneVar(tone: Tone): string {
  return `var(--${tone}-ink)`;
}

/**
 * The hearing test's flagged review.
 *
 * Rendered from `report.audiometry.review`, which the server derives from the
 * stored assessment — never from a prop a caller assembled, so the plain
 * summary, the detailed report and the clinician's record cannot disagree about
 * whether a measurement was sound.
 *
 * Silent when the audiometry was clean *and* when none was submitted: a reader
 * who did no hearing test needs an empty audiogram explained, not a reliability
 * verdict on a measurement that does not exist.
 */
function AudiometryReviewBlock({ review }: { review?: AudiometryReview | null }) {
  const { t } = useTranslation();
  if (!review || review.reliable === null) return null;

  const notes = review.notes ?? [];
  if (!review.flagged && notes.length === 0) return null;

  return (
    <Panel
      tone={review.flagged ? "warn" : "sunken"}
      tight
      style={{ marginTop: "var(--s4)" }}
      title={t("results.audiometryReview.title")}
    >
      <div className="stack stack-2">
        <div className="row row--tight">
          <Chip tone={review.flagged ? "warn" : "ok"} dot>
            {t(review.flagged ? "results.audiometryReview.flagged" : "results.audiometryReview.clean")}
          </Chip>
          {review.catch_trials !== null && (
            <Chip tone="ghost">
              {t("results.audiometryReview.catchTrials", {
                false: review.false_positives ?? 0,
                total: review.catch_trials,
              })}
            </Chip>
          )}
          {review.retest_agreement_db !== null && (
            <Chip tone="ghost">
              {t("results.audiometryReview.retest", { db: review.retest_agreement_db })}
            </Chip>
          )}
        </div>
        {notes.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: "var(--s5)", fontSize: "var(--fs-tiny)", lineHeight: 1.6 }}>
            {notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        )}
        {review.flagged && <p className="meta">{t("results.audiometryReview.caveat")}</p>}
      </div>
    </Panel>
  );
}

/**
 * Hearing thresholds and the tinnitus masking curve, on one set of axes.
 *
 * Both series come from the stored assessment: thresholds from
 * `audiometry.raw`, the curve from `psychoacoustics.masking.curve`, which the
 * server derives from `masking_thresholds` — the per-frequency levels the
 * masking module recorded. Nothing here is synthesised, and a patient who
 * skipped the masking module gets the empty state rather than a drawn curve.
 *
 * The masking curve had no home in the report at all before this: it was
 * rendered inside the assessment module that collected it and then only the
 * derived reference level survived into the record. So the one comparison the
 * chart exists to support — how far above threshold the percept has to be
 * covered, frequency by frequency — could not be made after the session.
 */
function MaskingOverlayBlock({ report }: { report: any }) {
  const { t } = useTranslation();
  const curve = report?.psychoacoustics?.masking?.curve;
  const raw = report?.audiometry?.raw;
  const pitchHz = report?.psychoacoustics?.pitch_match_hz ?? null;

  const hasCurve = Array.isArray(curve) && curve.some((p: any) => p?.threshold_db !== null && p?.masked === true);
  const hasThresholds = Boolean(raw && (Object.keys(raw.left ?? {}).length || Object.keys(raw.right ?? {}).length));

  // Nothing to overlay: say so rather than drawing empty axes, which read as a
  // measurement that came back flat.
  if (!hasCurve && !hasThresholds) return null;

  return (
    <Panel title={t("results.maskingOverlay.title")} tight headPlain style={{ marginTop: "var(--s4)" }}>
      <div className="stack stack-3">
        <p className="meta">{t("results.maskingOverlay.body")}</p>
        <CombinedAudiogramMasking
          audiogram={raw}
          curve={Array.isArray(curve) ? curve : []}
          pitchHz={pitchHz}
          height={340}
        />
        {!hasCurve && <p className="meta">{t("results.maskingOverlay.noMasking")}</p>}
      </div>
    </Panel>
  );
}

/**
 * Shown when *this* assessment has no thresholds but an earlier one does.
 *
 * Deliberately a pointer rather than a substitution: it offers to open the
 * assessment that holds the measurement instead of quietly drawing that
 * measurement here. Nothing is fabricated and no data is moved between records.
 */
function AudiogramElsewhereNotice({
  sourceId,
  onOpen,
}: {
  sourceId: number | null;
  onOpen(id: number): void;
}) {
  const { t } = useTranslation();
  if (sourceId === null) return null;
  return (
    <Panel tone="info" tight style={{ marginTop: "var(--s3)" }}>
      <div className="stack stack-2">
        <span className="label">{t("results.audiogramElsewhere.title")}</span>
        <p className="meta">{t("results.audiogramElsewhere.body")}</p>
        <button type="button" className="btn btn--sm" onClick={() => onOpen(sourceId)}>
          {t("results.audiogramElsewhere.open")}
        </button>
      </div>
    </Panel>
  );
}

/** A verdict card: icon, heading, one-word conclusion, one plain sentence. */
function StatusCard({
  icon: Icon,
  label,
  verdict,
  tone,
  children,
  meter,
}: {
  icon: typeof IconEar;
  label: string;
  verdict: string;
  tone: Tone;
  children?: ReactNode;
  meter?: { value: number; max: number; caption: string };
}) {
  return (
    <div className={`statuscard statuscard--${tone}`}>
      <div className="statuscard__head">
        <span className="iconbadge iconbadge--sm" style={{ color: toneVar(tone) }}>
          <Icon size={17} />
        </span>
        <span className="label">{label}</span>
      </div>
      <span className="statuscard__verdict">{verdict}</span>
      {children && <p className="statuscard__body">{children}</p>}
      {meter && (
        <div className="stack stack-1">
          <Meter
            value={meter.value}
            max={meter.max}
            tone={tone === "signal" || tone === "data" ? "data" : tone}
            label={meter.caption}
          />
          <span className="meta dim" style={{ fontSize: "var(--fs-micro)" }}>
            {meter.caption}
          </span>
        </div>
      )}
    </div>
  );
}

/** A bullet that carries its own status icon. */
function Finding({ tone, children }: { tone: "ok" | "warn" | "crit" | "info"; children: ReactNode }) {
  const Icon = tone === "ok" ? IconCheck : tone === "info" ? IconInfo : IconAlert;
  return (
    <li className={`finding finding--${tone}`}>
      <Icon size={15} className="finding__icon" />
      <span>{children}</span>
    </li>
  );
}

/**
 * The plain-language clinical summary.
 *
 * Exported because the assessment's review step renders it too: finishing an
 * assessment used to show four tiles and a link, and the detail a patient had
 * just spent ten minutes producing was a page change away. Sharing the
 * component rather than copying it is what stops the two screens drifting into
 * two different accounts of the same assessment.
 */
export function ClinicalSummary({ report, detail }: { report: any; detail: any }) {
  const { t } = useTranslation();
  const audiometry = report.audiometry ?? {};
  const psycho = report.psychoacoustics ?? {};
  const thi = report.questionnaires?.thi;
  const safety = report.safety ?? {};
  const outputs = detail.prediction?.outputs ?? {};
  const plan = report.management_plan;

  /* -- overall hearing --------------------------------------------------- */
  const grade: string | null = audiometry.who_grade ?? null;
  const hearingTone: Tone = grade ? (HEARING_TONE[grade.toLowerCase()] ?? "warn") : "data";
  const betterPta = [audiometry.pta_right, audiometry.pta_left]
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b)[0];

  /* -- tinnitus severity -------------------------------------------------- */
  const gradeNumber: number | null = thi?.subscales?.grade_number ?? null;
  const severity = gradeNumber
    ? {
        tone: THI_TONE[gradeNumber] ?? "data",
        verdict: t(`results.severity.${gradeNumber}.verdict`),
        body: t(`results.severity.${gradeNumber}.body`),
      }
    : null;

  /* -- important observations -------------------------------------------- */
  const observations: { tone: "ok" | "warn" | "crit" | "info"; text: string }[] = [];
  if (psycho.pitch_match_hz) {
    observations.push({
      tone: "info",
      text: t("results.observation.pitchMatched", {
        freq: fmt.hzFull(psycho.pitch_match_hz),
        band: t(
          psycho.pitch_match_hz >= 4000
            ? "results.observation.pitchHigh"
            : psycho.pitch_match_hz >= 1000
              ? "results.observation.pitchMid"
              : "results.observation.pitchLow"
        ),
      }),
    });
  }
  if (typeof psycho.loudness_match_db_sl === "number") {
    observations.push({
      tone: "info",
      text: t("results.observation.loudness", { db: fmt.db(psycho.loudness_match_db_sl, 0) }),
    });
  }
  const ri = psycho.residual_inhibition?.category;
  if (ri === "Rebound") {
    observations.push({
      tone: "crit",
      text: t("results.observation.riRebound"),
    });
  } else if (ri === "Complete" || ri === "Partial") {
    observations.push({
      tone: "ok",
      // `ri` is the server's English token ("Complete"/"Partial"); it is
      // translated through the same keys the psychoacoustics module uses so the
      // word matches what the rest of the report calls it.
      text: t("results.observation.riPositive", {
        category: t(`procedures.ri.category.${ri.toLowerCase()}`, { defaultValue: ri }),
      }),
    });
  }
  if (audiometry.notch) {
    observations.push({
      tone: "warn",
      text: t("results.observation.notch", { freq: fmt.hzFull(audiometry.notch.centre_hz) }),
    });
  }
  if ((audiometry.asymmetry_db ?? 0) >= 15) {
    observations.push({
      tone: "warn",
      text: t("results.observation.asymmetry", { db: fmt.db(audiometry.asymmetry_db, 0) }),
    });
  }
  if (psycho.maskability?.category) {
    observations.push({
      tone: "info",
      text: t("results.observation.maskability", { category: psycho.maskability.category }),
    });
  }

  /* -- risk indicators ---------------------------------------------------- */
  const risks: { tone: "ok" | "warn" | "crit" | "info"; text: string }[] = [];
  for (const flag of safety.flags ?? []) {
    risks.push({
      tone: flag.urgency === "routine" ? "info" : flag.urgency === "soon" ? "warn" : "crit",
      text: t("results.risk.flag", { title: flag.title, action: flag.action }),
    });
  }
  if (typeof outputs.worsening_risk === "number") {
    const high = outputs.worsening_risk >= 0.5;
    risks.push({
      tone: high ? "crit" : outputs.worsening_risk >= 0.25 ? "warn" : "ok",
      text: t("results.risk.worsening", {
        pct: fmt.pct(outputs.worsening_risk, 0),
        qualifier: t(high ? "results.risk.worseningHigh" : "results.risk.worseningNormal"),
      }),
    });
  }
  if (typeof outputs.therapy_response === "number") {
    risks.push({
      tone: outputs.therapy_response >= 0.5 ? "ok" : "warn",
      text: t("results.risk.therapyResponse", { pct: fmt.pct(outputs.therapy_response, 0) }),
    });
  }
  if ((thi?.flags ?? []).includes("catastrophic_ideation_item")) {
    risks.push({
      tone: "crit",
      text: t("results.risk.catastrophic"),
    });
  }
  if (safety.count === 0 && risks.length === 0) {
    risks.push({ tone: "ok", text: t("results.risk.allClear") });
  }

  /* -- what this means ---------------------------------------------------- */
  /**
   * The paragraph a patient would repeat to somebody else.
   *
   * Assembled from the two headline verdicts rather than written per-case,
   * because it has to say the same thing the cards above say — a summary that
   * can drift from the numbers it summarises is worse than no summary. Every
   * sentence is conditional on a measurement actually existing; nothing here
   * asserts a finding the assessment did not produce.
   */
  const meaning = (() => {
    const body: string[] = [];
    // Three separate headline keys rather than one with optional clauses
    // spliced in. The "and your hearing is graded X" clause attaches at a
    // different point in Tamil and Hindi sentence order, so building it by
    // concatenation would produce grammatical English and broken everything
    // else.
    const headline = severity
      ? grade
        ? t("results.meaning.headlineBoth", { severity: severity.verdict, grade })
        : t("results.meaning.headlineSeverityOnly", { severity: severity.verdict })
      : grade
        ? t("results.meaning.headlineGradeOnly", { grade })
        : t("results.meaning.headlineIncomplete");

    if (grade && hearingTone !== "ok") {
      body.push(t("results.meaning.hearingLoss"));
    } else if (grade) {
      body.push(t("results.meaning.hearingNormal"));
    }

    if (severity) {
      body.push(
        t(
          gradeNumber && gradeNumber >= 4
            ? "results.meaning.severityHigh"
            : "results.meaning.severityModerate"
        )
      );
    }

    if (psycho.pitch_match_hz) {
      body.push(
        t("results.meaning.pitchBuiltAround", { freq: fmt.hzFull(psycho.pitch_match_hz) })
      );
    }

    if ((safety.count ?? 0) === 0) {
      body.push(t("results.meaning.noSafetyFlags"));
    }

    return { headline, body };
  })();

  /**
   * Thresholds for the embedded cochlea.
   *
   * Prefers the worse ear — someone looking at this wants to see the damage, and
   * defaulting to the right ear would hide a one-sided loss half the time.
   */
  const earModel = (() => {
    // `raw` is the report's name for the measured thresholds, keyed by ear then
    // by frequency-as-string — the same shape `EarScene` colours hair cells from.
    const audiogram = report.audiometry?.raw ?? null;
    if (!audiogram) return null;
    const left = audiogram.left ?? {};
    const right = audiogram.right ?? {};
    if (!Object.keys(left).length && !Object.keys(right).length) return null;
    const mean = (v: Record<string, number>) => {
      const nums = Object.values(v).filter((n): n is number => typeof n === "number");
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : -1;
    };
    const ear = mean(left) > mean(right) ? "left" : "right";
    return {
      ear,
      thresholds: (ear === "left" ? left : right) as Record<string, number>,
      pitch_match_hz: psycho.pitch_match_hz ?? null,
    };
  })();

  /* -- next steps --------------------------------------------------------- */
  const steps: ReactNode[] = [];
  for (const flag of (safety.flags ?? []).filter((f: any) => f.urgency !== "routine").slice(0, 2)) {
    steps.push(
      <Trans
        i18nKey="results.steps.flag"
        components={[<strong key="0" />]}
        values={{ title: flag.title, action: flag.action }}
      />
    );
  }
  if (plan?.program) {
    steps.push(
      <Trans
        i18nKey="results.steps.startProgramme"
        components={[<strong key="0" />, <Link key="1" to="/rehabilitation" />]}
        values={{ minutes: plan.daily_minutes_target }}
      />
    );
  }
  steps.push(
    <Trans
      i18nKey="results.steps.rate"
      components={[<strong key="0" />, <em key="1" />, <Link key="2" to="/rehabilitation" />]}
    />
  );
  if (plan?.review_after_days) {
    steps.push(
      <Trans
        i18nKey="results.steps.review"
        components={[<strong key="0" />, <Link key="1" to="/consultation" />]}
        values={{ days: plan.review_after_days }}
      />
    );
  }

  return (
    <div className="stack stack-5">
      <div className="row row--between row--baseline">
        <span className="label label--signal" data-tour="results">{t("results.plain.label")}</span>
        <span className="meta">
          {t("results.plain.assessedOn", { date: fmt.date(report.meta?.assessment_date) })}
        </span>
      </div>

      {/* -- the two headline verdicts ------------------------------------ */}
      <div className="grid grid-2">
        <StatusCard
          icon={IconEar}
          label={t("results.plain.overallHearing")}
          verdict={grade ?? t("results.plain.notMeasured")}
          tone={hearingTone}
          meter={
            typeof betterPta === "number"
              ? {
                  value: Math.max(0, betterPta),
                  max: 90,
                  caption: t("results.plain.betterEarAverages", { value: fmt.db(betterPta, 0) }),
                }
              : undefined
          }
        >
          {grade
            ? audiometry.who_grade_detail ?? t("results.plain.whoGradeDefault")
            : t("results.plain.noThresholds")}
        </StatusCard>

        <StatusCard
          icon={IconWave}
          label={t("results.plain.tinnitusSeverity")}
          verdict={severity?.verdict ?? t("results.plain.notScored")}
          tone={severity?.tone ?? "data"}
          meter={
            typeof thi?.score === "number"
              ? {
                  value: thi.score,
                  max: 100,
                  caption: t("results.plain.handicapScore", { score: thi.score }),
                }
              : undefined
          }
        >
          {severity?.body ?? t("results.plain.notGradedBody")}
        </StatusCard>
      </div>

      {/* -- what this means, beside the patient's own cochlea -------------- */}
      {/* The two verdicts above are labels. This is the paragraph that turns
          them into a sentence somebody can repeat to their family, next to the
          picture that shows where it comes from. The 3D model used to be a
          separate destination, which meant navigating away from your results to
          look at a visualisation of them. */}
      <div className="grid grid-sidebar meaning" style={{ ["--aside" as string]: "min(360px, 42%)" }}>
        <Panel title={t("results.plain.whatThisMeans")} bracketed>
          <div className="stack stack-3">
            <p className="meaning__lead">{meaning.headline}</p>
            {meaning.body.map((paragraph, i) => (
              <p key={i} style={{ fontSize: "var(--fs-small)", lineHeight: 1.65 }}>
                {paragraph}
              </p>
            ))}
          </div>
        </Panel>

        <Panel title={t("results.plain.insideYourEar")} bracketed headPlain>
          <Suspense fallback={<Loading label={t("results.plain.loading3d")} rows={2} />}>
            <EarModel
              thresholds={earModel?.thresholds}
              pitchHz={earModel?.pitch_match_hz}
              ear={earModel?.ear}
              height={230}
            />
          </Suspense>
          <p className="meta" style={{ marginTop: "var(--s3)" }}>
            {t(earModel ? "results.plain.cochleaBody" : "results.plain.cochleaEmpty")}
          </p>
          {/* Same block as the detailed report, same source. A patient reading
              only the plain layer should not be the one person not told that
              their hearing test was flagged. */}
          <AudiometryReviewBlock review={report.audiometry?.review} />
          <p className="meta dim" style={{ fontSize: "var(--fs-micro)" }}>
            {t("results.plain.dragToRotate")}
          </p>
        </Panel>
      </div>

      {/* -- key findings -------------------------------------------------- */}
      <Panel title={t("results.plain.keyFindings")} bracketed>
        <ul className="stack stack-3" style={{ listStyle: "none", padding: 0 }}>
          {severity && (
            <Finding tone={severity.tone === "ok" ? "ok" : severity.tone === "warn" ? "warn" : "crit"}>
              <Trans
                i18nKey="results.finding.severity"
                components={[<strong key="0" />]}
                values={{
                  severity: severity.verdict,
                  score:
                    typeof thi?.score === "number"
                      ? t("results.finding.severityScore", { score: thi.score })
                      : "",
                }}
              />
            </Finding>
          )}
          {grade && (
            <Finding tone={hearingTone === "ok" ? "ok" : hearingTone === "warn" ? "warn" : "crit"}>
              <Trans
                i18nKey="results.finding.hearing"
                components={[<strong key="0" />]}
                values={{
                  grade,
                  average:
                    typeof betterPta === "number"
                      ? t("results.finding.hearingAverage", { value: fmt.db(betterPta, 0) })
                      : "",
                  note: hearingTone !== "ok" ? t("results.finding.hearingNote") : "",
                }}
              />
            </Finding>
          )}
          {psycho.pitch_match_hz && (
            <Finding tone="info">
              <Trans
                i18nKey="results.finding.pitch"
                components={[<strong key="0" />]}
                values={{ freq: fmt.hzFull(psycho.pitch_match_hz) }}
              />
            </Finding>
          )}
          {plan?.strategy && (
            <Finding tone="ok">
              <Trans
                i18nKey="results.finding.plan"
                components={[<strong key="0" />]}
                values={{
                  strategy: fmt.titleCase(plan.strategy),
                  minutes: plan.daily_minutes_target,
                }}
              />
            </Finding>
          )}
          {safety.count === 0 && (
            <Finding tone="ok">
              {t("results.finding.safetyClear")}
            </Finding>
          )}
        </ul>
      </Panel>

      {/* -- observations + risks ------------------------------------------ */}
      <div className="grid grid-2">
        <Panel title={t("results.plain.importantObservations")} bracketed>
          {observations.length === 0 ? (
            <p className="meta">{t("results.plain.noObservations")}</p>
          ) : (
            <ul className="stack stack-3" style={{ listStyle: "none", padding: 0 }}>
              {observations.map((item, i) => (
                <Finding key={i} tone={item.tone}>
                  {item.text}
                </Finding>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title={t("results.plain.riskIndicators")}
          tone={safety.count > 0 && safety.highest_urgency !== "routine" ? "crit" : "default"}
          aside={safety.count > 0 ? <UrgencyChip urgency={safety.highest_urgency} /> : undefined}
          bracketed
        >
          <ul className="stack stack-3" style={{ listStyle: "none", padding: 0 }}>
            {risks.map((item, i) => (
              <Finding key={i} tone={item.tone}>
                {item.text}
              </Finding>
            ))}
          </ul>
        </Panel>
      </div>

      {/* -- next steps ----------------------------------------------------- */}
      <Panel title="What happens next" bracketed>
        <ol className="stack stack-3" style={{ listStyle: "none", padding: 0 }}>
          {steps.map((step, i) => (
            <li key={i} className="row row--tight row--top row--nowrap">
              <span className="step-n">{i + 1}</span>
              <span style={{ fontSize: "var(--fs-small)", lineHeight: 1.6 }}>{step}</span>
            </li>
          ))}
        </ol>
        <hr className="rule rule--tight" />
        <div className="row row--tight no-print">
          <Link className="btn btn--sm btn--primary" to="/rehabilitation">
            <IconTarget size={14} />
            My programme
          </Link>
          <Link className="btn btn--sm" to="/support">
            Ask about these results
            <IconArrowRight size={14} />
          </Link>
          <Link className="btn btn--sm btn--ghost" to="/guide#numbers">
            <IconShield size={14} />
            What do these numbers mean?
          </Link>
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
function FhirModal({
  open,
  onClose,
  assessmentId,
}: {
  open: boolean;
  onClose(): void;
  assessmentId: number | null;
}) {
  const bundle = useAsync(
    () => (open && assessmentId ? api.reports.fhir(assessmentId) : Promise.resolve(null)),
    [open, assessmentId]
  );

  const counts: Record<string, number> = {};
  for (const entry of (bundle.data?.entry ?? []) as { resource: { resourceType: string } }[]) {
    const type = entry.resource.resourceType;
    counts[type] = (counts[type] ?? 0) + 1;
  }

  function download() {
    if (!bundle.data) return;
    const blob = new Blob([JSON.stringify(bundle.data, null, 2)], { type: "application/fhir+json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `echosense-fhir-${assessmentId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="HL7 FHIR R4 export"
      footer={
        <button type="button" className="btn btn--primary btn--sm" onClick={download} disabled={!bundle.data}>
          Download bundle
        </button>
      }
    >
      {bundle.loading ? (
        <Loading label="Building bundle" />
      ) : bundle.error ? (
        <ErrorState error={bundle.error} retry={bundle.reload} />
      ) : bundle.data ? (
        <div className="stack stack-4">
          <p className="meta">
            A FHIR R4 <code>Bundle</code> for this encounter, ready to post to an EHR. Audiometric thresholds
            become one <code>Observation</code> per ear with a component per frequency; the risk model becomes a{" "}
            <code>RiskAssessment</code>; the therapy plan becomes a <code>CarePlan</code>.
          </p>
          <div className="grid grid-3">
            {Object.entries(counts).map(([type, count]) => (
              <Readout key={type} label={type} value={count} size="sm" />
            ))}
          </div>
          <Panel tone="sunken" tight>
            <p className="meta">
              Tinnitus psychoacoustics have no universal LOINC, so they are published under an EchoSense{" "}
              <code>CodeSystem</code> URI — which is what FHIR expects for locally-defined measures, rather than
              guessing at a standard code. ICD-11 codes that could not be verified are marked{" "}
              <code>provisional</code> in <code>verificationStatus</code>.
            </p>
          </Panel>
          <Disclosure summary="Raw JSON (first 2 kB)">
            <pre
              className="mono"
              style={{
                fontSize: "var(--fs-micro)",
                background: "var(--paper-sunken)",
                padding: "var(--s3)",
                borderRadius: "var(--radius)",
                border: "1px solid var(--line)",
                overflowX: "auto",
                maxHeight: 280,
              }}
            >
              {JSON.stringify(bundle.data, null, 2).slice(0, 2000)}…
            </pre>
          </Disclosure>
        </div>
      ) : null}
    </Modal>
  );
}
