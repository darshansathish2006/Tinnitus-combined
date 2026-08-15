/**
 * The video consultation surface, shared by the dashboard and the consultation
 * screen so both show the same thing at the same moment.
 *
 * **The phase comes from the server, the countdown ticks locally.** That split
 * is the whole design. A browser deciding "has it started yet?" from its own
 * clock is how a patient sits looking at a disabled button while the clinician
 * waits in the room — so `phase` and `can_join` are the server's call, and the
 * only thing computed here is the seconds display, seeded from the server's
 * `starts_in_seconds` rather than from the wall clock.
 *
 * Four states, and each shows something different:
 *
 *   upcoming → date and time only. The meeting link is not even in the payload.
 *   imminent → "begins in 9:41", the join button, and who they are seeing.
 *   live     → join button, prominent, plus how long is left.
 *   ended    → the join button is gone; completion and follow-up take its place.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConsultationAppointment } from "../api/client";
import { Chip, Panel, fmt } from "./ui";
import { modalityLabel, whenLabel } from "./Appointment";
import { IconAlert, IconCalendar, IconCheck, IconUser, IconWave } from "./icons";

/** `503` → "8:23". Minutes and seconds, because "in 8 minutes" stops feeling live. */
function clock(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * A local countdown seeded from the server's offset.
 *
 * Re-seeded whenever the server sends a fresh number, so a drifted client
 * converges on every poll instead of accumulating error across a long wait.
 */
function useCountdown(seedSeconds: number, running: boolean): number {
  const [seconds, setSeconds] = useState(seedSeconds);
  const seededAt = useRef(Date.now());

  useEffect(() => {
    setSeconds(seedSeconds);
    seededAt.current = Date.now();
  }, [seedSeconds]);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      const elapsed = (Date.now() - seededAt.current) / 1000;
      setSeconds(seedSeconds - elapsed);
    }, 1000);
    return () => window.clearInterval(id);
  }, [seedSeconds, running]);

  return seconds;
}

/**
 * Poll while a consultation is close — the phase changes without any user
 * action, so the screen has to notice on its own.
 *
 * Deliberately narrow: only within the hour before the start, and only every
 * 30 seconds. A dashboard that polls all day to catch a transition that happens
 * once is a battery cost with no user visible.
 */
export function useConsultationPolling(
  appointment: ConsultationAppointment | null,
  reload: () => void
): void {
  const phase = appointment?.phase;
  const startsIn = appointment?.starts_in_seconds ?? Number.POSITIVE_INFINITY;
  const shouldPoll =
    Boolean(appointment) &&
    (phase === "imminent" || phase === "live" || (phase === "upcoming" && startsIn < 3600));

  useEffect(() => {
    if (!shouldPoll) return;
    const id = window.setInterval(reload, 30_000);
    return () => window.clearInterval(id);
  }, [shouldPoll, reload]);
}

export function MeetPanel({
  appointment,
  clinicianName,
  specialization,
  compact = false,
}: {
  appointment: ConsultationAppointment;
  clinicianName?: string | null;
  specialization?: string | null;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { phase } = appointment;
  const countdown = useCountdown(appointment.starts_in_seconds, phase === "imminent");

  // Nothing to show for an in-person booking — the card above it already
  // carries the time and the address, and a "join" surface on a face-to-face
  // appointment is just confusing.
  if (!appointment.is_online) return null;

  const name = clinicianName ?? appointment.clinician_name;
  const role = specialization ?? appointment.clinician_specialization;

  /* -- more than ten minutes away: details only, no link ------------------- */
  if (phase === "upcoming") {
    return (
      <Panel tight tone="sunken" className="meet">
        <div className="row row--tight row--nowrap">
          <span className="iconbadge iconbadge--sm">
            <IconCalendar size={15} />
          </span>
          <div style={{ minWidth: 0 }}>
            <span className="label">{t("meet.scheduled")}</span>
            <span className="meta" style={{ display: "block" }}>
              {fmt.dateTime(appointment.scheduled_for)} · {modalityLabel(t, appointment.modality)}
            </span>
          </div>
        </div>
        <p className="meta dim" style={{ marginTop: "var(--s2)", fontSize: "var(--fs-micro)" }}>
          {t("meet.linkAppearsBefore")}
        </p>
      </Panel>
    );
  }

  /* -- finished ------------------------------------------------------------ */
  if (phase === "ended" || phase === "closed") {
    const cancelled = phase === "closed";
    return (
      <Panel tight tone={cancelled ? "warn" : "ok"} className="meet">
        <div className="row row--tight row--nowrap">
          <span className={`iconbadge iconbadge--sm${cancelled ? " iconbadge--warn" : " iconbadge--ok"}`}>
            {cancelled ? <IconAlert size={15} /> : <IconCheck size={15} />}
          </span>
          <div style={{ minWidth: 0 }}>
            <span className="label">
              {t(cancelled ? "meet.notHeld" : "meet.completed")}
            </span>
            <span className="meta" style={{ display: "block" }}>
              {fmt.dateTime(appointment.scheduled_for)}
              {name ? ` · ${name}` : ""}
            </span>
          </div>
        </div>

        {/* The clinician's note from the visit is the summary. Shown when one
            exists rather than an empty "Summary" heading, which reads as the
            clinician having failed to write anything. */}
        {appointment.notes && (
          <>
            <hr className="rule rule--tight" />
            <span className="label">{t("meet.summary")}</span>
            <p className="meta" style={{ marginTop: "var(--s1)", whiteSpace: "pre-wrap" }}>
              {appointment.notes}
            </p>
          </>
        )}
        <p className="meta dim" style={{ marginTop: "var(--s2)", fontSize: "var(--fs-micro)" }}>
          {t(cancelled ? "meet.notHeldNote" : "meet.followUpNote")}
        </p>
      </Panel>
    );
  }

  /* -- imminent or live ---------------------------------------------------- */
  const live = phase === "live";
  return (
    <Panel tight tone={live ? "ok" : "signal"} className="meet meet--active" bracketed>
      <div className="row row--between row--nowrap" style={{ marginBottom: "var(--s3)" }}>
        <span className="row row--tight row--nowrap">
          <span className={`iconbadge iconbadge--sm${live ? " iconbadge--ok" : ""}`}>
            <IconWave size={15} />
          </span>
          <span className="label">{t(live ? "meet.inProgress" : "meet.startingSoon")}</span>
        </span>
        <Chip tone={live ? "ok" : "signal"} dot live={live}>
          {live ? t("appointment.liveNow") : clock(countdown)}
        </Chip>
      </div>

      <div className="stack stack-2">
        <strong style={{ fontSize: "var(--fs-body)", lineHeight: 1.25 }}>
          {live
            ? t("meet.happeningNow")
            : t("meet.beginsIn", { minutes: Math.max(1, Math.ceil(countdown / 60)) })}
        </strong>

        {name && (
          <span className="row row--tight row--nowrap meta">
            <IconUser size={14} />
            {name}
            {role ? ` · ${role}` : ""}
          </span>
        )}

        {!compact && (
          <span className="meta">
            {fmt.dateTime(appointment.scheduled_for)} · {fmt.duration(appointment.duration_minutes)} ·{" "}
            {modalityLabel(t, appointment.modality)}
          </span>
        )}
      </div>

      <hr className="rule rule--tight" />

      {appointment.can_join ? (
        <a
          className="btn btn--primary btn--block"
          href={appointment.meeting_link}
          target="_blank"
          rel="noreferrer"
        >
          <IconWave size={16} />
          {t("meet.join")}
        </a>
      ) : (
        // Inside the window but the clinician has not issued a link. Says which
        // of the two it is, because "the button is greyed out" with no reason is
        // the thing people phone the clinic about.
        <button type="button" className="btn btn--block" disabled>
          {t("meet.awaitingLink")}
        </button>
      )}

      <p className="meta dim" style={{ marginTop: "var(--s2)", fontSize: "var(--fs-micro)" }}>
        {t(appointment.can_join ? "meet.opensInNewTab" : "meet.awaitingLinkNote")}
      </p>
    </Panel>
  );
}

/** One line for the dashboard, when there is nothing imminent to shout about. */
export function MeetStrip({ appointment }: { appointment: ConsultationAppointment }) {
  const { t } = useTranslation();
  return (
    <span className="meta">
      {whenLabel(t, appointment.scheduled_for)}
      {appointment.clinician_name ? ` · ${appointment.clinician_name}` : ""}
    </span>
  );
}

export default MeetPanel;
