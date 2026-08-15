/**
 * The patient's view of a booked consultation, and the door into it.
 *
 * Shared between the overview and the consultation screen so there is exactly
 * one implementation of "can I join yet?". The answer comes from the server as
 * `can_join` — the client never compares the appointment time against its own
 * clock, because a laptop whose clock has drifted five minutes would either hide
 * the button during the appointment or open it early, and both look like the app
 * is broken rather than the clock.
 *
 * The button has three states and each says something different:
 *
 *   live         → join, styled as the primary action on the page
 *   too early    → disabled, with the time it opens
 *   no link yet  → disabled, and says the clinician has not issued one
 *
 * A single disabled button with no explanation is the version people call
 * support about.
 */

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ConsultationAppointment } from "../api/client";
import { Chip, Panel, fmt } from "./ui";
import { IconAlert, IconCalendar, IconCheck, IconUser, IconWave } from "./icons";

/**
 * Translate a backend modality or status token.
 *
 * `defaultValue` matters here: the API owns these vocabularies and can add a
 * value after this client ships. A humanised token is a worse label than a
 * translated one but a far better one than a blank chip on an appointment card.
 */
export function modalityLabel(t: TFunction, modality: string): string {
  return t(`appointment.modality.${modality}`, { defaultValue: fmt.titleCase(modality) });
}

export function appointmentStatusLabel(t: TFunction, status: string): string {
  return t(`appointment.status.${status}`, { defaultValue: fmt.titleCase(status) });
}

export const APPOINTMENT_STATUS_TONE: Record<string, "ok" | "warn" | "ghost" | "crit"> = {
  scheduled: "ok",
  requested: "warn",
  completed: "ghost",
  cancelled: "crit",
  no_show: "crit",
};

/** Minutes until `iso`, negative once it has passed. */
function minutesUntil(iso: string): number {
  return Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
}

/**
 * Human "when": today and tomorrow are worth saying in words, anything further
 * out is a date. "In 43,200 minutes" is technically the answer to a question
 * nobody asked.
 *
 * The time itself comes from `fmt.time`, so it follows the selected language's
 * clock convention — 12-hour with an am/pm marker in English and Hindi, and the
 * same in Tamil, rather than a hardcoded English rendering.
 */
export function whenLabel(t: TFunction, iso: string): string {
  const minutes = minutesUntil(iso);
  if (minutes < 0) return t("common.now");
  if (minutes < 60) return t("appointment.inMinutes", { count: minutes });
  const start = new Date(iso);
  const today = new Date();
  const sameDay = start.toDateString() === today.toDateString();
  const tomorrow = new Date(today.getTime() + 86_400_000).toDateString() === start.toDateString();
  const time = fmt.time(iso);
  if (sameDay) return t("appointment.todayAt", { time });
  if (tomorrow) return t("appointment.tomorrowAt", { time });
  return fmt.dateTime(iso);
}

export function JoinButton({
  appointment,
  block = false,
}: {
  appointment: ConsultationAppointment;
  block?: boolean;
}) {
  const { t } = useTranslation();
  const size = `btn btn--sm${block ? " btn--block" : ""}`;

  if (appointment.can_join) {
    return (
      <a
        className={`${size} btn--primary`}
        href={appointment.meeting_link}
        target="_blank"
        rel="noreferrer"
      >
        <IconWave size={15} />
        {t("appointment.join")}
      </a>
    );
  }

  if (!appointment.has_meeting_link) {
    return (
      <button type="button" className={size} disabled>
        {t("appointment.linkNotIssued")}
      </button>
    );
  }

  return (
    <button type="button" className={size} disabled>
      {t("appointment.opensWhen", {
        when: appointment.join_opens_at ? whenLabel(t, appointment.join_opens_at) : t("common.shortly"),
      })}
    </button>
  );
}

/**
 * Full appointment card, with the join affordance if it is an online booking.
 *
 * `compact` drops the secondary lines for the overview, where this sits beside
 * three other cards and does not need to repeat the clinician's job title.
 */
export function AppointmentCard({
  appointment,
  clinicianName,
  specialization,
  compact = false,
  action,
}: {
  appointment: ConsultationAppointment;
  clinicianName?: string | null;
  specialization?: string | null;
  compact?: boolean;
  action?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const online = appointment.is_online;
  const live = appointment.can_join;
  const waiting = online && !live && appointment.status === "scheduled";

  return (
    <Panel tight tone={live ? "ok" : "default"} className="appointment">
      <div className="row row--between row--nowrap" style={{ marginBottom: "var(--s3)" }}>
        <span className="row row--tight row--nowrap">
          <span className={`iconbadge iconbadge--sm${live ? " iconbadge--ok" : ""}`}>
            <IconCalendar size={15} />
          </span>
          <span className="label">{t(live ? "appointment.inProgress" : "appointment.next")}</span>
        </span>
        <Chip tone={live ? "ok" : APPOINTMENT_STATUS_TONE[appointment.status] ?? "ghost"} dot={live}>
          {live ? t("appointment.liveNow") : appointmentStatusLabel(t, appointment.status)}
        </Chip>
      </div>

      <div className="stack stack-2">
        <strong style={{ fontSize: "var(--fs-body)", lineHeight: 1.2 }}>
          {whenLabel(t, appointment.scheduled_for)}
        </strong>
        <span className="meta">
          {fmt.dateTime(appointment.scheduled_for)} · {fmt.duration(appointment.duration_minutes)} ·{" "}
          {modalityLabel(t, appointment.modality)}
        </span>

        {!compact && clinicianName && (
          <span className="row row--tight row--nowrap meta">
            <IconUser size={14} />
            {clinicianName}
            {specialization ? ` · ${specialization}` : ""}
          </span>
        )}

        {appointment.status === "requested" && (
          <p className="meta">
            <IconAlert size={13} style={{ color: "var(--warn-ink)", verticalAlign: "-2px" }} />{" "}
            {t("appointment.awaitingConfirmation")}
          </p>
        )}

        {!compact && appointment.notes && <p className="meta">{appointment.notes}</p>}
      </div>

      {(online || action) && (
        <>
          <hr className="rule rule--tight" />
          <div className="row row--tight">
            {online && <JoinButton appointment={appointment} />}
            {action}
          </div>
          {waiting && (
            <p className="meta dim" style={{ marginTop: "var(--s2)", fontSize: "var(--fs-micro)" }}>
              {t(appointment.has_meeting_link ? "appointment.joinHint" : "appointment.noLinkHint")}
            </p>
          )}
          {live && (
            <p className="meta dim" style={{ marginTop: "var(--s2)", fontSize: "var(--fs-micro)" }}>
              <IconCheck size={12} style={{ verticalAlign: "-1px" }} /> {t("appointment.liveHint")}
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

/** The one-line version for the overview's quick-access row. */
export function AppointmentStrip({ appointment }: { appointment: ConsultationAppointment }) {
  const { t } = useTranslation();
  return (
    <div className={`apptstrip${appointment.can_join ? " apptstrip--live" : ""}`}>
      <span className="row row--tight row--nowrap" style={{ minWidth: 0 }}>
        <IconCalendar size={16} style={{ flex: "none" }} />
        <span style={{ minWidth: 0 }}>
          <strong className="apptstrip__title">
            {t(appointment.can_join ? "appointment.liveConsultation" : "appointment.nextConsultation")}
          </strong>
          <span className="apptstrip__sub">
            {whenLabel(t, appointment.scheduled_for)}
            {appointment.clinician_name ? ` · ${appointment.clinician_name}` : ""}
          </span>
        </span>
      </span>
      <span className="row row--tight row--nowrap">
        {appointment.is_online && <JoinButton appointment={appointment} />}
        <Link className="btn btn--sm btn--ghost" to="/consultation">
          {t("common.details")}
        </Link>
      </span>
    </div>
  );
}
