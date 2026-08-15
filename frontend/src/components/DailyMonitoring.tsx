/**
 * Daily monitoring: how the patient has actually been, over the programme.
 *
 * Sits under the rehabilitation programme rather than being its own screen, on
 * purpose. "What am I meant to do today" and "is it working" are the same
 * question asked at two timescales, and splitting them across two destinations
 * means the patient who is losing motivation never sees the evidence that they
 * are improving.
 *
 * The same component renders the clinician's view of an assigned patient. The
 * only difference is `readOnly` — a clinician sees the trends and cannot log a
 * check-in on somebody's behalf, because a self-report entered by someone else
 * is not a self-report.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, type Monitoring, type MonitoringMetric } from "../api/client";
import { useSession } from "../state/session";
import { Chip, Meter, Panel, Readout, fmt } from "./ui";
import { IconAlert, IconCheck, IconInfo, IconTrend } from "./icons";

/** The five scales, in the order they are asked. */
const METRIC_KEYS = [
  "tinnitus_loudness",
  "tinnitus_annoyance",
  "sleep_quality",
  "stress_level",
  "mood",
] as const;

type MetricKey = (typeof METRIC_KEYS)[number];

const TREND_TONE: Record<string, "ok" | "warn" | "crit" | "ghost"> = {
  improving: "ok",
  steady: "ghost",
  worsening: "crit",
};

/* ------------------------------------------------------------------------- */
/* A small multi-week line, drawn inline                                      */
/* ------------------------------------------------------------------------- */
/**
 * Weekly means as a sparkline.
 *
 * Weekly rather than daily because a daily line for a symptom rating is mostly
 * noise — people have bad Tuesdays — and the question this answers is about
 * direction over the programme. Weeks with too few ratings to trust are drawn
 * hollow rather than omitted, so a gap in engagement is visible as a gap.
 */
function WeeklyLine({
  weekly,
  direction,
  height = 54,
}: {
  weekly: MonitoringMetric["weekly"];
  direction: MonitoringMetric["direction"];
  height?: number;
}) {
  const width = 200;
  const pad = 6;
  const points = weekly.filter((w) => w.mean !== null) as (typeof weekly[number] & { mean: number })[];
  if (points.length < 2) return null;

  const x = (i: number) => pad + (i / Math.max(1, weekly.length - 1)) * (width - pad * 2);
  const y = (v: number) => pad + ((10 - v) / 10) * (height - pad * 2);

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(weekly.indexOf(p))},${y(p.mean)}`)
    .join(" ");

  const first = points[0].mean;
  const last = points[points.length - 1].mean;
  const better = direction === "lower_better" ? last < first : last > first;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto" }} aria-hidden="true">
      <path
        d={path}
        fill="none"
        stroke={better ? "var(--ok)" : "var(--warn)"}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {points.map((p) => (
        <circle
          key={p.week}
          cx={x(weekly.indexOf(p))}
          cy={y(p.mean)}
          r={3}
          fill={p.confident ? (better ? "var(--ok)" : "var(--warn)") : "var(--paper)"}
          stroke={better ? "var(--ok)" : "var(--warn)"}
          strokeWidth={1.4}
        />
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------------- */
/* Calendar strip                                                             */
/* ------------------------------------------------------------------------- */
/** The last 28 days, one square each — the "did I show up" view. */
function CalendarStrip({ dates, label }: { dates: string[]; label: string }) {
  const done = new Set(dates);
  const days: { iso: string; done: boolean }[] = [];
  const today = new Date();
  for (let i = 27; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    days.push({ iso, done: done.has(iso) });
  }
  return (
    <div className="stack stack-1">
      <span className="label">{label}</span>
      <div className="calstrip" role="img" aria-label={label}>
        {days.map((d) => (
          <span
            key={d.iso}
            className={`calstrip__day${d.done ? " calstrip__day--on" : ""}`}
            title={d.iso}
          />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
export function DailyMonitoring({
  monitoring,
  onChanged,
  readOnly = false,
}: {
  monitoring: Monitoring;
  onChanged(): void;
  /** Clinician view: trends only, no check-in form. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const toast = useSession((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<MetricKey, number>>({
    tinnitus_loudness: 5,
    tinnitus_annoyance: 5,
    sleep_quality: 5,
    stress_level: 5,
    mood: 5,
  });

  async function submit() {
    setBusy(true);
    try {
      await api.monitoring.checkIn(draft);
      onChanged();
      toast(t("monitoring.saved"), "ok");
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("monitoring.saveFailed"), "crit");
    } finally {
      setBusy(false);
    }
  }

  const { metrics, check_in: checkIn, adherence, recovery_pct: recovery } = monitoring;

  return (
    <div className="stack stack-5">
      <div className="row row--between row--baseline">
        <div className="stack stack-1">
          <span className="label label--signal">{t("monitoring.label")}</span>
          <h2 style={{ fontSize: "var(--fs-h3)" }}>{t("monitoring.title")}</h2>
        </div>
        {monitoring.shared_with && !readOnly && (
          <Chip tone="info" dot>
            {t("monitoring.sharedWith", { name: monitoring.shared_with.clinician_name })}
          </Chip>
        )}
      </div>

      {/* -- headline numbers ------------------------------------------------ */}
      <div className="grid grid-4">
        <Panel tight>
          <Readout
            label={t("monitoring.recovery")}
            value={recovery === null ? "—" : fmt.pct100(recovery, 0)}
            size="md"
            tone={recovery === null ? "data" : recovery >= 60 ? "ok" : recovery >= 35 ? "warn" : "crit"}
            note={t("monitoring.recoveryNote")}
          />
          {recovery !== null && <Meter value={recovery} max={100} tone={recovery >= 60 ? "ok" : "data"} />}
        </Panel>
        <Panel tight>
          <Readout
            label={t("monitoring.checkInStreak")}
            value={checkIn.streak_days}
            size="md"
            tone={checkIn.streak_days >= 3 ? "ok" : "data"}
            note={t("monitoring.daysLogged", { count: checkIn.total_days })}
          />
        </Panel>
        <Panel tight>
          <Readout
            label={t("monitoring.adherence")}
            value={fmt.pct100(adherence.pct, 0)}
            size="md"
            tone={adherence.pct >= 70 ? "ok" : adherence.pct >= 40 ? "warn" : "crit"}
            note={t("monitoring.activeDays", {
              active: adherence.active_days,
              total: adherence.elapsed_days,
            })}
          />
          <Meter value={adherence.pct} max={100} tone={adherence.pct >= 70 ? "ok" : "data"} />
        </Panel>
        <Panel tight>
          <Readout
            label={t("monitoring.dayOf")}
            value={monitoring.day_of_programme}
            size="md"
            tone="data"
            note={t("monitoring.ofWeeks", { weeks: monitoring.programme_weeks })}
          />
        </Panel>
      </div>

      {/* -- today's check-in ------------------------------------------------ */}
      {!readOnly && (
        <Panel
          title={t("monitoring.todayTitle")}
          bracketed
          aside={
            checkIn.logged_today ? (
              <Chip tone="ok" dot>
                {t("monitoring.loggedToday")}
              </Chip>
            ) : undefined
          }
        >
          <div className="stack stack-4">
            <p className="meta">{t(checkIn.logged_today ? "monitoring.alreadyLogged" : "monitoring.todayLead")}</p>

            <div className="grid grid-auto" style={{ ["--min" as string]: "260px" }}>
              {METRIC_KEYS.map((key) => (
                <div key={key} className="stack stack-1">
                  <div className="row row--between row--baseline">
                    <span className="label">{t(`monitoring.metric.${key}`)}</span>
                    <span className="mono" style={{ fontSize: "var(--fs-small)", fontWeight: 700 }}>
                      {draft[key].toFixed(0)}
                    </span>
                  </div>
                  <input
                    className="fader"
                    type="range"
                    min={0}
                    max={10}
                    step={1}
                    value={draft[key]}
                    aria-label={t(`monitoring.metric.${key}`)}
                    onChange={(e) => setDraft((d) => ({ ...d, [key]: Number(e.target.value) }))}
                  />
                  <div className="fader-scale">
                    <span>{t(`monitoring.anchor.${key}Low`)}</span>
                    <span>{t(`monitoring.anchor.${key}High`)}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="row row--end">
              <button type="button" className="btn btn--primary" onClick={submit} disabled={busy}>
                <IconCheck size={15} />
                {t(checkIn.logged_today ? "monitoring.update" : "monitoring.save")}
              </button>
            </div>
          </div>
        </Panel>
      )}

      {/* -- trends ---------------------------------------------------------- */}
      <Panel title={t("monitoring.trendsTitle")} bracketed>
        <div className="stack stack-3">
          <p className="meta">{t("monitoring.trendsLead")}</p>
          <div className="grid grid-auto" style={{ ["--min" as string]: "240px" }}>
            {METRIC_KEYS.map((key) => {
              const metric = metrics[key];
              if (!metric) return null;
              const { trend } = metric;
              const tone = TREND_TONE[trend.direction ?? "steady"] ?? "ghost";
              return (
                <Panel key={key} tone="sunken" tight>
                  <div className="stack stack-2">
                    <div className="row row--between row--baseline">
                      <span className="label">{t(`monitoring.metric.${key}`)}</span>
                      {trend.direction && (
                        <Chip tone={tone} dot>
                          {t(`monitoring.trend.${trend.direction}`)}
                        </Chip>
                      )}
                    </div>

                    {trend.current === null ? (
                      <p className="meta dim">{t("monitoring.noRatings")}</p>
                    ) : (
                      <>
                        <div className="row" style={{ gap: "var(--s5)" }}>
                          <Readout
                            label={t("monitoring.baseline")}
                            value={trend.baseline?.toFixed(1) ?? "—"}
                            size="sm"
                          />
                          <Readout
                            label={t("monitoring.now")}
                            value={trend.current.toFixed(1)}
                            size="sm"
                            tone={tone === "ghost" ? "data" : tone}
                          />
                        </div>
                        <WeeklyLine weekly={metric.weekly} direction={metric.direction} />
                        <span className="meta dim" style={{ fontSize: "var(--fs-micro)" }}>
                          {t("monitoring.fromRatings", { count: trend.n })}
                        </span>
                      </>
                    )}
                  </div>
                </Panel>
              );
            })}
          </div>
        </div>
      </Panel>

      {/* -- attendance ------------------------------------------------------ */}
      <div className="grid grid-2">
        <Panel title={t("monitoring.calendarTitle")} bracketed>
          <div className="stack stack-4">
            <CalendarStrip dates={adherence.dates} label={t("monitoring.activityDays")} />
            <CalendarStrip dates={checkIn.dates} label={t("monitoring.checkInDays")} />
            <p className="meta dim" style={{ fontSize: "var(--fs-micro)" }}>
              {t("monitoring.calendarNote")}
            </p>
          </div>
        </Panel>

        <Panel title={t("monitoring.consultationsTitle")} bracketed headPlain>
          {monitoring.consultations.length === 0 ? (
            <p className="meta">{t("monitoring.noConsultations")}</p>
          ) : (
            <ul className="stack stack-2" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {monitoring.consultations.slice(0, 5).map((c) => (
                <li key={c.id} className="row row--between row--nowrap">
                  <span className="row row--tight row--nowrap" style={{ minWidth: 0 }}>
                    <IconTrend size={13} style={{ color: "var(--ink-3)", flex: "none" }} />
                    <span className="meta">{fmt.dateTime(c.scheduled_for)}</span>
                  </span>
                  <Chip tone={c.status === "completed" ? "ok" : c.status === "cancelled" ? "crit" : "ghost"}>
                    {t(`appointment.status.${c.status}`, { defaultValue: c.status })}
                  </Chip>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {!readOnly && (
        <Panel tone="sunken" tight>
          <p className="row row--tight row--top meta">
            <IconInfo size={14} style={{ flex: "none", marginTop: 2 }} />
            {monitoring.shared_with
              ? t("monitoring.privacyShared", { name: monitoring.shared_with.clinician_name })
              : t("monitoring.privacyPrivate")}
          </p>
        </Panel>
      )}

      {readOnly && adherence.pct < 40 && (
        <Panel tone="warn" tight>
          <p className="row row--tight row--top meta">
            <IconAlert size={14} style={{ color: "var(--warn-ink)", flex: "none", marginTop: 2 }} />
            {t("monitoring.lowAdherence")}
          </p>
        </Panel>
      )}
    </div>
  );
}

export default DailyMonitoring;
