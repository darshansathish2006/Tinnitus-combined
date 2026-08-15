/**
 * Clinician caseload.
 *
 * Sorted by triage score, not by name or date. The ranking is deliberately
 * safety-first: an urgent red flag outranks any questionnaire score, so the
 * clinician's scarce attention lands on the patient who might have retrocochlear
 * pathology before the patient with a high but stable THI.
 *
 * Every row carries the reasons for its position. A ranking a clinician cannot
 * interrogate is a ranking they will stop trusting.
 */

import { Fragment, lazy, Suspense, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  api,
  ApiError,
  type CaseloadRow,
  type ClinicianAppointment,
  type EarModelInputs,
} from "../api/client";
import { useSession } from "../state/session";
import {
  Chip,
  Disclosure,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Panel,
  Readout,
  UrgencyChip,
  fmt,
  useAsync,
} from "../components/ui";
import { modalityLabel, APPOINTMENT_STATUS_TONE } from "../components/Appointment";
import { IconAlert, IconCheck, IconDownload, IconEar, IconWave } from "../components/icons";
import { DistributionBars } from "../components/charts";

// Three.js is ~500 kB and most console sessions never open a case. Loaded on the
// first expand, not on mount.
const EarModel = lazy(() => import("../components/EarModel"));

type Filter = "all" | "flagged" | "unassessed" | "disengaged";

/* ------------------------------------------------------------------------- */
/* Critical alerts                                                            */
/* ------------------------------------------------------------------------- */
/**
 * Which patients belong at the top of the console, and why.
 *
 * Derived from the caseload row rather than fetched separately: the row already
 * carries the red-flag urgency, the grade, the modelled risk and the triage
 * reasons, and a second source of truth for "who is critical" is a second thing
 * to keep in step.
 *
 * Three independent routes in, because they catch different failures. A
 * catastrophic questionnaire score with no red flag is a distress emergency; a
 * red flag with a mild score is a possible retrocochlear lesion; a high modelled
 * risk is neither, and is the one a clinician would otherwise miss.
 */
interface CriticalCase {
  row: CaseloadRow;
  severity: "emergency" | "critical" | "high";
  reasons: string[];
}

const SEVERITY_TONE: Record<CriticalCase["severity"], "crit" | "warn"> = {
  emergency: "crit",
  critical: "crit",
  high: "warn",
};

function criticalCases(t: TFunction, rows: CaseloadRow[]): CriticalCase[] {
  const out: CriticalCase[] = [];

  for (const row of rows) {
    const reasons: string[] = [];
    let severity: CriticalCase["severity"] | null = null;

    if (row.highest_urgency === "emergency") {
      severity = "emergency";
      reasons.push(t("clinician.reason.emergencyFlag"));
    } else if (row.highest_urgency === "urgent") {
      severity = "critical";
      reasons.push(t("clinician.reason.urgentFlag"));
    }

    // Grade 5 is the top THI band — "always heard, sleep badly disturbed".
    if (row.thi_grade?.includes("Catastrophic")) {
      severity = severity === "emergency" ? severity : "critical";
      reasons.push(t("clinician.reason.extremeSeverity", { score: row.thi_score ?? "?" }));
    } else if (row.thi_grade?.includes("Severe")) {
      severity = severity ?? "high";
      reasons.push(t("clinician.reason.severeHandicap", { score: row.thi_score ?? "?" }));
    }

    if ((row.worsening_risk ?? 0) >= 0.5) {
      severity = severity ?? "high";
      reasons.push(t("clinician.reason.worseningRisk", { pct: fmt.pct(row.worsening_risk, 0) }));
    }

    // A deterioration past the MCID is a real change, not measurement noise.
    if ((row.thi_change ?? 0) >= 7) {
      severity = severity ?? "high";
      reasons.push(t("clinician.reason.deteriorated", { points: fmt.signed(row.thi_change, 0) }));
    }

    if (severity) out.push({ row, severity, reasons });
  }

  const order = { emergency: 0, critical: 1, high: 2 };
  return out.sort(
    (a, b) => order[a.severity] - order[b.severity] || b.row.triage_score - a.row.triage_score
  );
}

export default function Clinician() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const actAsPatient = useSession((s) => s.actAsPatient);
  const toast = useSession((s) => s.toast);

  const caseload = useAsync(() => api.clinician.caseload(), []);
  const alerts = useAsync(() => api.clinician.alerts(true), []);
  const cohort = useAsync(() => api.clinician.cohort(), []);
  const [exporting, setExporting] = useState(false);

  /**
   * The extract is clinician-scoped and token-authenticated, so it is fetched
   * with the auth header and saved as a blob. The previous plain `<a href>`
   * reconstructed the URL by string-splitting another endpoint's URL and then
   * hit the API unauthenticated — it always returned 401.
   */
  async function exportExtract() {
    setExporting(true);
    try {
      const filename = await api.reports.downloadResearchExtract();
      toast(t("clinician.downloaded", { filename }), "ok");
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("clinician.extractFailed"), "crit");
    } finally {
      setExporting(false);
    }
  }
  const appointments = useAsync(() => api.clinician.appointments(true), []);

  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  /**
   * One expanded case at a time, by patient id.
   *
   * Not a set. Each expanded case mounts a WebGL context for the 3D cochlea, and
   * browsers silently drop the oldest once you pass roughly a dozen — on a
   * caseload that size, "expand all" would present as cards going randomly
   * blank rather than as a limit being hit.
   */
  const [expanded, setExpanded] = useState<number | null>(null);

  const rows = useMemo(() => {
    let list = caseload.data ?? [];
    if (filter === "flagged") list = list.filter((r) => r.highest_urgency !== "routine" || r.open_alerts > 0);
    if (filter === "unassessed") list = list.filter((r) => !r.last_assessment);
    // Adherence alone since the diary was withdrawn — the 14-day diary count it
    // used to also test can no longer move, so keeping it in the predicate would
    // have marked every patient disengaged.
    if (filter === "disengaged") list = list.filter((r) => (r.adherence_pct ?? 100) < 40);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((r) => r.full_name.toLowerCase().includes(q) || r.mrn.toLowerCase().includes(q));
    }
    return list;
  }, [caseload.data, filter, query]);

  function openPatient(row: CaseloadRow) {
    actAsPatient(row.patient_id, row.full_name);
    navigate(`/clinic/patient/${row.patient_id}`);
  }

  async function acknowledge(alertId: number) {
    try {
      await api.clinician.acknowledge(alertId);
      await Promise.all([alerts.reload(), caseload.reload()]);
      toast(t("clinician.alertAcknowledged"), "ok");
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("clinician.acknowledgeFailed"), "crit");
    }
  }

  if (caseload.loading) return <Loading label={t("clinician.loading")} rows={5} />;
  if (caseload.error) return <ErrorState error={caseload.error} retry={caseload.reload} />;

  const critical = criticalCases(t, caseload.data ?? []);

  return (
    <div className="stack stack-6">
      <header className="row row--between">
        <div className="stack stack-1">
          <span className="label label--signal">{t("clinician.label")}</span>
          <h1>{t("clinician.title")}</h1>
          <p className="meta">
            {t("clinician.subtitle", {
              patients: caseload.data?.length ?? 0,
              alerts: alerts.data?.length ?? 0,
            })}
          </p>
        </div>
        <div className="row row--tight">
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={exportExtract}
            disabled={exporting}
          >
            <IconDownload size={15} />
            {t(exporting ? "clinician.preparing" : "clinician.researchExtract")}
          </button>
        </div>
      </header>

      {/* -- critical patients ----------------------------------------------- */}
      {critical.length > 0 && (
        <Panel
          tone="crit"
          bracketed
          title={t("clinician.critical.title", { count: critical.length })}
          aside={
            <span className="row row--tight row--nowrap meta">
              <IconAlert size={14} style={{ color: "var(--crit-ink)" }} />
              {t("clinician.critical.aside")}
            </span>
          }
        >
          <div className="stack stack-3">
            {critical.map(({ row, severity, reasons }) => (
              <article key={row.patient_id} className={`critcase critcase--${severity}`}>
                <div className="critcase__head">
                  <div className="row row--tight row--nowrap" style={{ minWidth: 0 }}>
                    <Chip tone={SEVERITY_TONE[severity]} dot>
                      {t(`clinician.critical.${severity}`)}
                    </Chip>
                    <strong className="critcase__name">{row.full_name}</strong>
                    <span className="meta mono nowrap">{row.mrn}</span>
                  </div>
                  <div className="row row--tight row--nowrap">
                    <span className="meta nowrap">
                      {t("clinician.critical.assessedWhen", {
                        when: row.last_assessment ? fmt.ago(row.last_assessment) : t("common.never"),
                      })}
                    </span>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => setExpanded(expanded === row.patient_id ? null : row.patient_id)}
                      aria-expanded={expanded === row.patient_id}
                    >
                      {t("clinician.critical.quickView")}
                    </button>
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => openPatient(row)}>
                      {t("clinician.critical.openRecord")}
                    </button>
                  </div>
                </div>
                <ul className="critcase__reasons">
                  {reasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
                {expanded === row.patient_id && <CaseDetail row={row} onOpen={() => openPatient(row)} />}
              </article>
            ))}
          </div>
        </Panel>
      )}

      {/* -- service summary ------------------------------------------------- */}
      <div className="grid grid-4">
        <Panel tight>
          <Readout label={t("clinician.summary.patients")} value={cohort.data?.n_patients ?? "—"} size="md" />
        </Panel>
        <Panel tight>
          <Readout
            label={t("clinician.summary.openAlerts")}
            value={cohort.data?.open_alerts ?? "—"}
            size="md"
            tone={(cohort.data?.open_alerts ?? 0) > 0 ? "warn" : "ok"}
          />
        </Panel>
        <Panel tight>
          <Readout label={t("clinician.summary.meanThi")} value={fmt.num(cohort.data?.thi?.mean, 1)} unit="/100" size="md" tone="data" />
        </Panel>
        <Panel tight>
          <Readout
            label={t("clinician.summary.nextAppointment")}
            value={
              appointments.data?.[0]
                ? fmt.dateTime(appointments.data[0].scheduled_for)
                : t("clinician.summary.none")
            }
            size="sm"
            note={appointments.data?.[0]?.patient_name}
          />
        </Panel>
      </div>

      {/* -- filters --------------------------------------------------------- */}
      <div className="row row--between">
        <div className="btn-group">
          {(
            [
              "all",
              "flagged",
              "unassessed",
              "disengaged",
            ] as Filter[]
          ).map((key) => (
            <button key={key} type="button" className="btn btn--sm" aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {t(`clinician.filter.${key}`)}
            </button>
          ))}
        </div>
        <input
          className="input"
          style={{ maxWidth: 260 }}
          placeholder={t("clinician.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {/* -- caseload table -------------------------------------------------- */}
      <Panel flush bracketed>
        {rows.length === 0 ? (
          <EmptyState title={t("clinician.noMatchTitle")} body={t("clinician.noMatchBody")} />
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th className="num">{t("clinician.table.priority")}</th>
                  <th>{t("clinician.table.patient")}</th>
                  <th>{t("clinician.table.flags")}</th>
                  <th className="num">{t("clinician.table.thi")}</th>
                  <th className="num">{t("clinician.table.thiDelta")}</th>
                  <th className="num">{t("clinician.table.tri")}</th>
                  <th className="num">{t("clinician.table.risk")}</th>
                  <th className="num">{t("clinician.table.adherence")}</th>
                  <th className="num">{t("clinician.table.lastSeen")}</th>
                  <th aria-label={t("clinician.table.caseDetails")} />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Fragment key={row.patient_id}>
                  <tr data-clickable="true" onClick={() => openPatient(row)}>
                    <td className="num">
                      <span
                        className="mono"
                        style={{
                          fontWeight: 700,
                          color:
                            row.triage_score >= 60
                              ? "var(--crit)"
                              : row.triage_score >= 30
                                ? "var(--warn)"
                                : "var(--ink-3)",
                        }}
                      >
                        {row.triage_score.toFixed(0)}
                      </span>
                    </td>
                    <td>
                      <div className="stack stack-1">
                        <strong>{row.full_name}</strong>
                        <span className="meta mono">
                          {row.mrn}
                          {row.age ? ` · ${row.age}y` : ""}
                          {row.laterality ? ` · ${row.laterality}` : ""}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="row row--tight">
                        {row.highest_urgency !== "routine" && <UrgencyChip urgency={row.highest_urgency} />}
                        {row.open_alerts > 0 && <Chip tone="warn">{row.open_alerts}</Chip>}
                        {row.highest_urgency === "routine" && row.open_alerts === 0 && (
                          <span className="dim">—</span>
                        )}
                      </div>
                    </td>
                    <td className="num">
                      {row.thi_score ?? "—"}
                      {row.thi_grade && (
                        <span className="meta dim" style={{ display: "block", fontSize: "var(--fs-micro)" }}>
                          {row.thi_grade.replace(/^Grade \d+ - /, "")}
                        </span>
                      )}
                    </td>
                    <td
                      className="num"
                      style={{
                        color:
                          row.thi_change === null
                            ? undefined
                            : row.thi_change >= 7
                              ? "var(--crit)"
                              : row.thi_change <= -7
                                ? "var(--ok)"
                                : undefined,
                        fontWeight: row.thi_change !== null && Math.abs(row.thi_change) >= 7 ? 700 : undefined,
                      }}
                    >
                      {row.thi_change === null ? "—" : fmt.signed(row.thi_change, 0)}
                    </td>
                    <td className="num">{fmt.num(row.tri_score, 0)}</td>
                    <td
                      className="num"
                      style={{
                        color:
                          (row.worsening_risk ?? 0) >= 0.5
                            ? "var(--crit)"
                            : (row.worsening_risk ?? 0) >= 0.25
                              ? "var(--warn)"
                              : undefined,
                      }}
                    >
                      {fmt.pct(row.worsening_risk, 0)}
                    </td>
                    <td
                      className="num"
                      style={{
                        color:
                          (row.adherence_pct ?? 100) < 40
                            ? "var(--crit)"
                            : (row.adherence_pct ?? 100) < 70
                              ? "var(--warn)"
                              : "var(--ok)",
                      }}
                    >
                      {fmt.pct100(row.adherence_pct, 0)}
                    </td>
                    <td className="num meta">{fmt.ago(row.last_assessment)}</td>
                    <td className="num">
                      {/* Stops the row's own navigate handler firing — expanding
                          a case and leaving the page are different intents. */}
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost nowrap"
                        aria-expanded={expanded === row.patient_id}
                        onClick={(event) => {
                          event.stopPropagation();
                          setExpanded(expanded === row.patient_id ? null : row.patient_id);
                        }}
                      >
                        <IconEar size={14} />
                        {t(expanded === row.patient_id ? "clinician.table.hide" : "clinician.table.quickView")}
                      </button>
                    </td>
                  </tr>
                  {expanded === row.patient_id && (
                    <tr className="caserow">
                      <td colSpan={10}>
                        <CaseDetail row={row} onOpen={() => openPatient(row)} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* -- triage reasoning ------------------------------------------------ */}
      <Panel title={t("clinician.triage.title")} bracketed>
        <div className="stack stack-3">
          <p className="meta">{t("clinician.triage.body")}</p>
          {rows.slice(0, 6).map((row) => (
            <div key={row.patient_id} className="row row--top row--tight">
              <span
                className="mono"
                style={{ minWidth: 34, fontWeight: 700, color: row.triage_score >= 60 ? "var(--crit)" : "var(--ink-3)" }}
              >
                {row.triage_score.toFixed(0)}
              </span>
              <strong style={{ fontSize: "var(--fs-tiny)", minWidth: 130 }}>{row.full_name}</strong>
              <span className="meta" style={{ flex: 1 }}>
                {row.triage_reasons.length
                  ? row.triage_reasons.join(" · ")
                  : t("clinician.triage.noDrivers")}
              </span>
            </div>
          ))}
        </div>
      </Panel>

      {/* -- cohort ---------------------------------------------------------- */}
      {cohort.data && cohort.data.n_assessed > 0 && (
        <Panel title={t("clinician.analytics.title")} bracketed>
          <div className="grid grid-3">
            <div className="stack stack-2">
              <span className="label">{t("clinician.analytics.thiDistribution")}</span>
              <DistributionBars data={cohort.data.thi.distribution} tone="signal" />
            </div>
            <div className="stack stack-2">
              <span className="label">Tinnitus pitch</span>
              <DistributionBars data={cohort.data.pitch_hz.distribution} tone="data" />
              <span className="meta dim">median {fmt.hzFull(cohort.data.pitch_hz.median)}</span>
            </div>
            <div className="stack stack-2">
              <span className="label">Hearing grade</span>
              <DistributionBars data={cohort.data.hearing.distribution} tone="data" />
            </div>
          </div>
          <p className="meta" style={{ marginTop: "var(--s4)" }}>
            {cohort.data.research_note}
          </p>
        </Panel>
      )}

      {/* -- schedule + appointments ----------------------------------------- */}
      <div className="grid grid-2">
        <SchedulePanel />
        <AppointmentsPanel
          appointments={appointments.data ?? []}
          loading={appointments.loading}
          onChanged={() => void appointments.reload()}
          onError={(message) => toast(message, "crit")}
          onSaved={(message) => toast(message, "ok")}
        />
      </div>

      {/* -- alerts ---------------------------------------------------------- */}
      <div className="grid grid-2">
        <Panel title={t("clinician.alerts.title")} bracketed>
          {alerts.loading ? (
            <Loading rows={3} />
          ) : (alerts.data ?? []).length === 0 ? (
            <EmptyState title={t("clinician.alerts.emptyTitle")} body={t("clinician.alerts.emptyBody")} />
          ) : (
            <div className="stack stack-3">
              {(alerts.data ?? []).map((alert) => (
                <div key={alert.id} className="stack stack-1">
                  <div className="row row--between">
                    <div className="row row--tight" style={{ minWidth: 0 }}>
                      <Chip tone={alert.severity === "critical" ? "crit" : alert.severity === "warning" ? "warn" : "info"} dot>
                        {alert.severity}
                      </Chip>
                      <strong style={{ fontSize: "var(--fs-tiny)" }}>{alert.title}</strong>
                    </div>
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      onClick={() => acknowledge(alert.id)}
                      aria-label={`Acknowledge: ${alert.title}`}
                      title={t("clinician.acknowledge")}
                    >
                      <IconCheck size={14} />
                    </button>
                  </div>
                  <span className="meta">
                    {alert.patient_name} · {fmt.ago(alert.created_at)} · {alert.kind}
                  </span>
                  <Disclosure summary={t("clinician.alerts.detail")}>
                    <p className="meta">{alert.detail}</p>
                  </Disclosure>
                </div>
              ))}
            </div>
          )}
        </Panel>

      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/**
 * Expanded case: the patient's own cochlea beside the numbers that matter.
 *
 * The 3D model is the point. A clinician reading "4 kHz notch, 55 dB" has to
 * hold the shape in their head; seeing the dead region on this patient's own
 * hair cells with their matched tinnitus frequency sitting inside it is the same
 * fact in a form you can point at during the consultation. Having it here rather
 * than on a separate screen means it is available while triaging, which is when
 * the question is actually being asked.
 *
 * The audiogram comes from the caseload overview endpoint, fetched on expand —
 * loading twelve patients' thresholds to render one is a lot of payload for a
 * list where most rows are never opened.
 */
function CaseDetail({ row, onOpen }: { row: CaseloadRow; onOpen(): void }) {
  const { t } = useTranslation();
  const overview = useAsync(() => api.clinician.overview(row.patient_id), [row.patient_id]);

  if (overview.loading) return <Loading label={t("clinician.case.loading")} rows={2} />;
  if (overview.error) return <ErrorState error={overview.error} retry={overview.reload} />;

  const ear: EarModelInputs | null = overview.data?.ear_model ?? null;
  const change = overview.data?.thi_change;

  return (
    <div className="casedetail">
      <div className="casedetail__model">
        <Suspense fallback={<Loading label={t("clinician.case.loading3d")} rows={2} />}>
          <EarModel
            thresholds={ear?.thresholds}
            pitchHz={ear?.pitch_match_hz}
            ear={ear?.ear}
            height={240}
          />
        </Suspense>
      </div>

      <div className="casedetail__facts">
        <dl className="factlist">
          <div>
            <dt>{t("clinician.case.hearing")}</dt>
            <dd>
              {ear?.hearing_grade ?? t("clinician.case.notGraded")}
              {ear?.pitch_match_hz && (
                <span className="factlist__note">Percept {fmt.hzFull(ear.pitch_match_hz)}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>{t("clinician.case.handicap")}</dt>
            <dd>
              {row.thi_score ?? "—"}
              <span className="factlist__unit">/100</span>
              {row.thi_grade && (
                <span className="factlist__note">{row.thi_grade.replace(/^Grade \d+ - /, "")}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>{t("clinician.case.sinceBaseline")}</dt>
            <dd>
              {change ? fmt.signed(change.delta, 0) : "—"}
              {change && <span className="factlist__note">{fmt.titleCase(change.direction)}</span>}
            </dd>
          </div>
          <div>
            <dt>{t("clinician.case.worseningRisk")}</dt>
            <dd>
              {fmt.pct(row.worsening_risk, 0)}
              {row.risk_band && <span className="factlist__note">{fmt.titleCase(row.risk_band)}</span>}
            </dd>
          </div>
          <div>
            <dt>{t("clinician.case.adherence")}</dt>
            <dd>{fmt.pct100(row.adherence_pct, 0)}</dd>
          </div>
        </dl>

        {row.triage_reasons.length > 0 && (
          <p className="meta" style={{ marginTop: "var(--s3)" }}>
            <strong>Priority drivers:</strong> {row.triage_reasons.join(" · ")}
          </p>
        )}

        <button type="button" className="btn btn--sm btn--primary" style={{ marginTop: "var(--s3)" }} onClick={onOpen}>
          Open full record
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/**
 * Upcoming appointments, with the meeting link editable in place.
 *
 * The link belongs next to the appointment it is for, not on a settings screen:
 * the moment a clinician thinks about it is when they see "tomorrow, 10:00,
 * video". Confirming a patient's requested slot is the same interaction, one
 * button along, for the same reason.
 */
function AppointmentsPanel({
  appointments,
  loading,
  onChanged,
  onError,
  onSaved,
}: {
  appointments: ClinicianAppointment[];
  loading: boolean;
  onChanged(): void;
  onError(message: string): void;
  onSaved(message: string): void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function update(id: number, body: Record<string, unknown>, message: string) {
    setBusy(true);
    try {
      await api.clinician.updateAppointment(id, body);
      setEditing(null);
      onSaved(message);
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : t("clinician.appointments.updateFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title={t("clinician.appointments.title")}
      bracketed
      aside={<Chip tone="ghost">{appointments.length}</Chip>}
    >
      {loading ? (
        <Loading label={t("clinician.appointments.loading")} rows={2} />
      ) : appointments.length === 0 ? (
        <EmptyState
          title={t("clinician.appointments.emptyTitle")}
          body={t("clinician.appointments.emptyBody")}
        />
      ) : (
        <div className="stack stack-3">
          {appointments.slice(0, 8).map((appointment) => (
            <article key={appointment.id} className="apptrow">
              <div className="row row--between row--nowrap">
                <div className="stack stack-1" style={{ minWidth: 0 }}>
                  <div className="row row--tight row--nowrap">
                    <strong style={{ fontSize: "var(--fs-tiny)" }}>{appointment.patient_name}</strong>
                    <Chip tone={APPOINTMENT_STATUS_TONE[appointment.status] ?? "ghost"}>
                      {fmt.titleCase(appointment.status)}
                    </Chip>
                    {appointment.can_join && (
                      <Chip tone="ok" dot>
                        live
                      </Chip>
                    )}
                  </div>
                  <span className="meta">
                    {fmt.dateTime(appointment.scheduled_for)} ·{" "}
                    {fmt.duration(appointment.duration_minutes)} · {modalityLabel(t, appointment.modality)}
                  </span>
                </div>
                <div className="row row--tight row--nowrap">
                  {appointment.status === "requested" && (
                    <button
                      type="button"
                      className="btn btn--sm btn--primary"
                      disabled={busy}
                      onClick={() => void update(appointment.id, { status: "scheduled" }, t("clinician.appointments.confirmed"))}
                    >
                      <IconCheck size={14} />
                      Confirm
                    </button>
                  )}
                  {appointment.is_online && (
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      onClick={() => {
                        setEditing(editing === appointment.id ? null : appointment.id);
                        setDraft(appointment.meeting_link);
                      }}
                    >
                      <IconWave size={14} />
                      {t("clinician.appointments.customLink")}
                    </button>
                  )}
                </div>
              </div>

              {/* The "no meeting link yet" warning was removed. Every
                  consultation now resolves to a standing room server-side
                  (`settings.CONSULTATION_MEET_LINK`), so there is no state in
                  which a clinician has to add one before a patient can join —
                  and warning about a problem that can no longer occur trains
                  people to ignore the warnings that can. Setting a per-
                  appointment link is still offered below, as an override. */}

              {appointment.has_meeting_link && editing !== appointment.id && (
                <a
                  className="meta mono apptrow__link"
                  href={appointment.meeting_link}
                  target="_blank"
                  rel="noreferrer"
                >
                  {appointment.meeting_link}
                </a>
              )}

              {editing === appointment.id && (
                <form
                  className="stack stack-2"
                  style={{ marginTop: "var(--s3)" }}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void update(appointment.id, { meeting_link: draft.trim() }, t("clinician.appointments.linkSaved"));
                  }}
                >
                  <Field
                    label={t("clinician.appointments.meetingLink")}
                    hint={t("clinician.appointments.standingRoom")}
                  >
                    <input
                      className="input"
                      type="url"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder={t("clinician.appointments.linkPlaceholder")}
                    />
                  </Field>
                  <div className="row row--tight">
                    <button type="submit" className="btn btn--sm btn--primary" disabled={busy}>
                      {busy ? t("common.saving") : t("clinician.appointments.saveLink")}
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      onClick={() => setEditing(null)}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------------- */
/**
 * The clinician's own working pattern and today's remaining capacity.
 *
 * Editable here because the pattern is what generates every bookable slot a
 * patient sees — burying it in a settings page would mean the one number that
 * governs the whole booking flow lives somewhere nobody visits.
 */
function SchedulePanel() {
  const { t } = useTranslation();
  const schedule = useAsync(() => api.clinician.schedule(), []);
  const toast = useSession((s) => s.toast);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ specialization: string; slot: string; link: string; days: number[] }>({
    specialization: "",
    slot: "30",
    link: "",
    days: [],
  });

  const profile = schedule.data?.profile;

  function startEditing() {
    if (!profile) return;
    setForm({
      specialization: profile.specialization,
      slot: String(profile.slot_minutes),
      link: profile.default_meeting_link ?? "",
      days: profile.working_days,
    });
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    try {
      await api.clinician.updateSchedule({
        specialization: form.specialization,
        slot_minutes: Number(form.slot),
        default_meeting_link: form.link.trim(),
        working_days: form.days,
      });
      toast(t("clinician.schedule.saved"), "ok");
      setEditing(false);
      await schedule.reload();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("clinician.schedule.saveFailed"), "crit");
    } finally {
      setBusy(false);
    }
  }

  if (schedule.loading) return <Loading label={t("clinician.schedule.loading")} rows={3} />;
  if (schedule.error) return <ErrorState error={schedule.error} retry={schedule.reload} />;
  if (!profile) return null;

  const today = schedule.data?.today;
  const openToday = (today?.slots ?? []).filter((s) => s.available);

  return (
    <Panel
      title={t("clinician.schedule.title")}
      bracketed
      aside={
        <button type="button" className="btn btn--sm btn--ghost" onClick={editing ? () => setEditing(false) : startEditing}>
          {t(editing ? "common.cancel" : "clinician.schedule.edit")}
        </button>
      }
    >
      {editing ? (
        <div className="stack stack-3">
          <Field label={t("clinician.schedule.specialization")}>
            <input
              className="input"
              value={form.specialization}
              onChange={(e) => setForm({ ...form, specialization: e.target.value })}
            />
          </Field>
          <Field label={t("clinician.schedule.workingDays")}>
            <div className="row row--tight">
              {[1, 2, 3, 4, 5, 6, 7].map((day) => {
                const on = form.days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    className={`wellness__option${on ? " wellness__option--on" : ""}`}
                    aria-pressed={on}
                    onClick={() =>
                      setForm({
                        ...form,
                        days: on ? form.days.filter((d) => d !== day) : [...form.days, day].sort(),
                      })
                    }
                  >
                    {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day - 1]}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label={t("clinician.schedule.minutesPerConsultation")}>
            <input
              className="input"
              type="number"
              min={5}
              max={180}
              step={5}
              value={form.slot}
              onChange={(e) => setForm({ ...form, slot: e.target.value })}
            />
          </Field>
          <Field
            label={t("clinician.schedule.defaultLink")}
            hint={t("clinician.schedule.defaultLinkHint")}
          >
            <input
              className="input"
              type="url"
              value={form.link}
              onChange={(e) => setForm({ ...form, link: e.target.value })}
              placeholder={t("clinician.appointments.linkPlaceholder")}
            />
          </Field>
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={busy}>
            {busy ? t("common.saving") : t("clinician.schedule.saveSchedule")}
          </button>
        </div>
      ) : (
        <>
          <dl className="factlist">
            <div>
              <dt>{t("clinician.schedule.specialization")}</dt>
              <dd>{profile.specialization}</dd>
            </div>
            <div>
              <dt>{t("clinician.schedule.workingDays")}</dt>
              <dd>{profile.working_days_label}</dd>
            </div>
            <div>
              <dt>Hours</dt>
              <dd>
                {profile.working_hours.map((w) => `${w.start}–${w.end}`).join(" · ")}
                <span className="factlist__note">{profile.slot_minutes} minutes per slot</span>
              </dd>
            </div>
            <div>
              <dt>{t("clinician.schedule.remainingToday")}</dt>
              <dd>
                {profile.works_today ? profile.slots_remaining_today : "—"}
                <span className="factlist__unit">
                  {profile.works_today ? ` of ${profile.slots_today_total}` : " not working"}
                </span>
              </dd>
            </div>
            <div>
              <dt>{t("clinician.schedule.defaultLink")}</dt>
              <dd>
                {t(profile.has_default_meeting_link ? "clinician.schedule.set" : "clinician.schedule.notSet")}
              </dd>
            </div>
          </dl>

          {profile.works_today && (
            <>
              <hr className="rule rule--tight" />
              <span className="label" style={{ display: "block", marginBottom: "var(--s2)" }}>
                Today · {today?.weekday}
              </span>
              {(today?.slots ?? []).length === 0 ? (
                <p className="meta">No slots configured for today.</p>
              ) : (
                <>
                  <div className="slotgrid">
                    {(today?.slots ?? []).map((slot) => (
                      <span
                        key={slot.start}
                        className={`slot slot--static${slot.available ? "" : " slot--taken"}`}
                        title={t(
                          slot.available
                            ? "clinician.schedule.slotFree"
                            : slot.reason === "booked"
                              ? "clinician.schedule.slotBooked"
                              : "clinician.schedule.slotPassed"
                        )}
                      >
                        {slot.label}
                      </span>
                    ))}
                  </div>
                  <p className="meta" style={{ marginTop: "var(--s2)" }}>
                    {openToday.length} slot{openToday.length === 1 ? "" : "s"} still free today.
                  </p>
                </>
              )}
            </>
          )}
        </>
      )}
    </Panel>
  );
}
