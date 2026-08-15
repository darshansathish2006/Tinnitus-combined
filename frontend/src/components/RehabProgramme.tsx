/**
 * The rehabilitation programme: what to do today, how the four weeks progress,
 * and how far along the patient is.
 *
 * This sits above the sound player on the Rehabilitation screen. The split is
 * deliberate — the player is a *device*, and a device is not a recovery plan.
 * A patient opening this screen at 7am is asking "what am I meant to do today
 * and am I keeping up", and until now the answer was a list of sound blocks and
 * an adherence percentage, which answers neither.
 *
 * Every activity carries the finding that put it there (`because`). An exercise
 * with no stated reason is the first thing a patient drops, and "your anxiety
 * screening indicated this" is both true and the difference between a checklist
 * and a prescription.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, ApiError, type RehabActivity, type RehabProgramme as Programme } from "../api/client";
import { useSession } from "../state/session";
import { Chip, EmptyState, Meter, Panel, Readout, fmt } from "./ui";
import { IconArrowRight, IconCheck, IconClipboard, IconSpark, IconWave } from "./icons";

/** Tone for the severity chip. Mirrors the bands the report uses. */
const BAND_TONE: Record<string, "ok" | "warn" | "crit" | "ghost"> = {
  slight: "ok",
  mild: "ok",
  moderate: "warn",
  severe: "crit",
  unknown: "ghost",
};

export function RehabProgramme({
  programme,
  onChanged,
  onOpenPlayer,
}: {
  programme: Programme;
  onChanged(): void;
  onOpenPlayer?(): void;
}) {
  const { t } = useTranslation();
  const toast = useSession((s) => s.toast);
  /** Keys currently in flight, so a double-tap cannot double-post. */
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const { progress, today, weeks, severity } = programme;
  const doneToday = new Set(progress.completed_today);

  async function toggle(activity: RehabActivity) {
    if (busy.has(activity.key)) return;
    setBusy((prev) => new Set(prev).add(activity.key));
    const wasDone = doneToday.has(activity.key);
    try {
      if (wasDone) await api.rehab.undo(activity.key);
      else await api.rehab.complete(activity.key, activity.minutes);
      onChanged();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("rehab.logFailed"), "crit");
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(activity.key);
        return next;
      });
    }
  }

  const doneCount = today.filter((a) => doneToday.has(a.key)).length;
  const allDone = today.length > 0 && doneCount === today.length;

  return (
    <div className="stack stack-5">
      {/* -- the four-number summary ---------------------------------------- */}
      <div className="grid grid-4">
        <Panel tight>
          <Readout
            label={t("rehab.dashboard.today")}
            value={`${doneCount}/${today.length}`}
            size="md"
            tone={allDone ? "ok" : "signal"}
            note={t("rehab.dashboard.todaySub", { done: doneCount, total: today.length })}
          />
        </Panel>
        <Panel tight>
          <Readout
            label={t("rehab.dashboard.streak")}
            value={progress.streak_days}
            unit={progress.streak_days === 1 ? "" : ""}
            size="md"
            tone={progress.streak_days >= 3 ? "ok" : "data"}
            note={t("rehab.dashboard.streakNote")}
          />
        </Panel>
        <Panel tight>
          <div className="stack stack-2">
            <Readout
              label={t("rehab.dashboard.thisWeek")}
              value={fmt.pct100(progress.week_completion_pct, 0)}
              size="md"
              tone={progress.week_completion_pct >= 70 ? "ok" : progress.week_completion_pct >= 40 ? "warn" : "data"}
              note={t("rehab.dashboard.weekNote")}
            />
            <Meter
              value={progress.week_completion_pct}
              max={100}
              tone={progress.week_completion_pct >= 70 ? "ok" : "data"}
              label={t("rehab.dashboard.thisWeek")}
            />
          </div>
        </Panel>
        <Panel tight>
          <div className="stack stack-2">
            <Readout
              label={t("rehab.dashboard.overall")}
              value={fmt.pct100(progress.overall_completion_pct, 0)}
              size="md"
              tone="data"
              note={t("rehab.dashboard.overallNote")}
            />
            <Meter value={progress.overall_completion_pct} max={100} tone="data" />
          </div>
        </Panel>
      </div>

      {/* -- today's checklist ----------------------------------------------- */}
      <Panel
        title={t("rehab.dashboard.today")}
        bracketed
        aside={
          <Chip tone={BAND_TONE[severity.band] ?? "ghost"} dot>
            {t(`rehab.band.${severity.band}`, { defaultValue: severity.band })}
          </Chip>
        }
      >
        <div className="stack stack-3">
          {allDone && (
            <p className="row row--tight meta" style={{ color: "var(--ok-ink)" }}>
              <IconCheck size={15} />
              {t("rehab.dashboard.allDone")}
            </p>
          )}

          <ul className="stack stack-2" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {today.map((activity) => {
              const done = doneToday.has(activity.key);
              return (
                <li key={activity.key} className={`rehabitem${done ? " rehabitem--done" : ""}`}>
                  <button
                    type="button"
                    className="rehabitem__tick"
                    aria-pressed={done}
                    aria-label={done ? t("rehab.undo") : t("rehab.markDone")}
                    disabled={busy.has(activity.key)}
                    onClick={() => void toggle(activity)}
                  >
                    {done && <IconCheck size={14} />}
                  </button>

                  <span className="rehabitem__body">
                    <span className="rehabitem__title">
                      {t(`rehab.activity.${activity.key}`, { defaultValue: activity.key })}
                    </span>
                    <span className="meta" style={{ display: "block" }}>
                      {t(`rehab.activity.${activity.key}What`, { defaultValue: "" })}
                    </span>
                    <span className="row row--tight" style={{ marginTop: "var(--s1)" }}>
                      <Chip tone="ghost">{t(`rehab.slot.${activity.slot}`, { defaultValue: activity.slot })}</Chip>
                      <Chip tone="ghost">{fmt.duration(activity.minutes)}</Chip>
                      {activity.because && (
                        <span className="meta dim" style={{ fontSize: "var(--fs-micro)" }}>
                          {t(`rehab.reason.${activity.because}`, { defaultValue: "" })}
                        </span>
                      )}
                    </span>
                  </span>

                  {/* The sound block is the one activity with somewhere to go:
                      it is completed by using the player, not by ticking a box,
                      so it offers the door rather than only the checkbox. */}
                  {activity.key === "sound_therapy" && onOpenPlayer && (
                    <button type="button" className="btn btn--sm" onClick={onOpenPlayer}>
                      <IconWave size={14} />
                      {t("rehab.openPlayer")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </Panel>

      {/* -- this week's goals ----------------------------------------------- */}
      <div className="grid grid-2">
        <Panel title={t("rehab.goal.title")} bracketed>
          <ul className="stack stack-2" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {programme.current_week.goals.map((goal) => (
              <li key={goal.key} className="row row--tight row--top row--nowrap">
                <IconSpark size={14} style={{ color: "var(--signal-ink)", flex: "none", marginTop: 3 }} />
                <span style={{ fontSize: "var(--fs-small)", lineHeight: 1.55 }}>
                  {t(`rehab.goal.${goal.key}`, {
                    target: goal.target,
                    defaultValue: goal.key,
                  })}
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title={t("rehab.dashboard.nextMilestone")} bracketed headPlain>
          {progress.programme_complete ? (
            <div className="stack stack-2">
              <Chip tone="ok" dot>
                {t("rehab.dashboard.complete")}
              </Chip>
              <p className="meta">{t("rehab.dashboard.completeNote")}</p>
            </div>
          ) : progress.next_milestone ? (
            <div className="stack stack-2">
              <Readout
                label={t("rehab.dashboard.milestoneWeek", { week: progress.next_milestone.week })}
                value={
                  progress.next_milestone.introduces
                    ? t(`rehab.activity.${progress.next_milestone.introduces}`, {
                        defaultValue: progress.next_milestone.introduces,
                      })
                    : t("rehab.roadmap.establishes")
                }
                size="sm"
                tone="signal"
              />
              <p className="meta">
                {t("rehab.dashboard.milestoneAdds", {
                  activity: progress.next_milestone.introduces
                    ? t(`rehab.activity.${progress.next_milestone.introduces}`, {
                        defaultValue: progress.next_milestone.introduces,
                      })
                    : "",
                })}
              </p>
            </div>
          ) : (
            <p className="meta">{t("rehab.dashboard.milestoneNone")}</p>
          )}
        </Panel>
      </div>

      {/* -- the roadmap ------------------------------------------------------ */}
      <Panel title={t("rehab.roadmap.title")} bracketed>
        <ol className="roadmap">
          {weeks.map((week) => {
            const state =
              week.week < progress.week ? "done" : week.week === progress.week ? "current" : "todo";
            return (
              <li key={week.week} className={`roadmap__step roadmap__step--${state}`}>
                <span className="roadmap__marker" aria-hidden="true">
                  {state === "done" ? <IconCheck size={13} /> : week.week}
                </span>
                <div className="stack stack-1" style={{ minWidth: 0 }}>
                  <div className="row row--tight row--nowrap">
                    <strong style={{ fontSize: "var(--fs-small)" }}>
                      {t("rehab.roadmap.week", { week: week.week })}
                    </strong>
                    {state === "current" && <Chip tone="signal" dot>{t("rehab.roadmap.current")}</Chip>}
                  </div>
                  {/* `display: block` explicitly: `.stack` spaces its children
                      with `margin-top`, which does nothing to an inline span, so
                      these two lines ran together into "54 min of sound a
                      dayEstablish the daily routine". */}
                  <span className="meta" style={{ display: "block" }}>
                    {t("rehab.roadmap.soundTarget", { minutes: week.sound_minutes })}
                  </span>
                  <span className="meta dim" style={{ display: "block" }}>
                    {week.introduces
                      ? t("rehab.roadmap.introduces", {
                          activity: t(`rehab.activity.${week.introduces}`, { defaultValue: week.introduces }),
                        })
                      : t("rehab.roadmap.establishes")}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      </Panel>

      {/* -- why this programme ---------------------------------------------- */}
      <Panel title={t("rehab.recommendations.title")} bracketed tone="sunken">
        <div className="stack stack-3">
          <p className="meta">{t("rehab.recommendations.intro")}</p>
          {programme.activities.filter((a) => a.because).length === 0 ? (
            <p className="meta">{t("rehab.recommendations.none")}</p>
          ) : (
            <ul className="stack stack-2" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {programme.activities
                .filter((a) => a.because)
                .map((activity) => (
                  <li key={activity.key} className="row row--tight row--top row--nowrap">
                    <span className="dot dot--signal" aria-hidden="true" style={{ marginTop: 7 }} />
                    <span style={{ fontSize: "var(--fs-small)", lineHeight: 1.55 }}>
                      <strong>{t(`rehab.activity.${activity.key}`, { defaultValue: activity.key })}</strong>
                      {" — "}
                      {t(`rehab.reason.${activity.because}`, { defaultValue: activity.because ?? "" })}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </Panel>
    </div>
  );
}

/** Shown when there is no assessment to build a programme from. */
export function RehabEmpty() {
  const { t } = useTranslation();
  return (
    <EmptyState
      title={t("rehab.noProgrammeTitle")}
      body={t("rehab.noProgrammeBody")}
      action={
        <Link className="btn btn--primary" to="/assessment">
          <IconClipboard size={15} />
          {t("rehab.startAssessment")}
          <IconArrowRight size={15} />
        </Link>
      }
    />
  );
}

export default RehabProgramme;
