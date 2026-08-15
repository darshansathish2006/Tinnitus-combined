/**
 * The ten-minute consultation notice.
 *
 * Mounted once in the shell rather than on the two screens that show the join
 * button, because the patient who most needs it is the one who is *not* looking
 * at their consultation page — they are in the rehabilitation player or the
 * support chat and about to miss their appointment.
 *
 * **Once per appointment, ever.** Keyed by appointment id in localStorage, not
 * by component state: a notice that reappears on every route change or reload
 * is worse than no notice, because people learn to dismiss it without reading.
 * Dismissing is therefore permanent for that appointment, and the join button
 * on the dashboard and consultation screens remains the durable affordance.
 *
 * It polls only inside the hour before the appointment — see
 * `useConsultationPolling`. Outside that window there is nothing to notice.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, ApiError, type ConsultationAppointment } from "../api/client";
import { useAsync } from "./ui";
import { useConsultationPolling } from "./MeetPanel";
import { IconArrowRight, IconCalendar, IconClose, IconWave } from "./icons";

const SEEN_KEY = (appointmentId: number) => `echosense.meetNotice.${appointmentId}`;

function alreadySeen(appointmentId: number): boolean {
  try {
    return localStorage.getItem(SEEN_KEY(appointmentId)) === "1";
  } catch {
    // Private mode: better to stay silent than to fire on every render.
    return true;
  }
}

function markSeen(appointmentId: number): void {
  try {
    localStorage.setItem(SEEN_KEY(appointmentId), "1");
  } catch {
    /* nothing to persist to */
  }
}

export function ConsultationNotice() {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState<number | null>(null);

  const consultation = useAsync(async () => {
    try {
      return await api.consultation.get();
    } catch (error) {
      // A clinician with no acting patient, or a patient with no record yet —
      // neither is an error worth surfacing from a background poll.
      if (error instanceof ApiError) return null;
      throw error;
    }
  }, []);

  const next: ConsultationAppointment | null = consultation.data?.upcoming?.[0] ?? null;
  useConsultationPolling(next, consultation.reload);

  const dismiss = useCallback((appointmentId: number) => {
    markSeen(appointmentId);
    setDismissed(appointmentId);
  }, []);

  useEffect(() => {
    if (!next) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss(next.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, dismiss]);

  if (!next || !next.is_online) return null;
  // Only inside the join window, and only while it is still live. Once the
  // consultation ends the notice goes with it.
  if (next.phase !== "imminent" && next.phase !== "live") return null;
  if (dismissed === next.id || alreadySeen(next.id)) return null;

  const minutes = Math.max(1, Math.ceil(next.starts_in_seconds / 60));
  const name = next.clinician_name ?? "";

  return (
    <aside className="meetnotice fade-in" role="alert" aria-live="assertive">
      <div className="row row--between row--top row--nowrap" style={{ marginBottom: "var(--s2)" }}>
        <span className="row row--tight row--nowrap" style={{ minWidth: 0 }}>
          <span className="iconbadge iconbadge--sm iconbadge--solid">
            <IconCalendar size={15} />
          </span>
          <strong className="meetnotice__title">
            {next.phase === "live"
              ? t("meetNotice.live", { name })
              : t("meetNotice.title", { name, minutes })}
          </strong>
        </span>
        <button
          type="button"
          className="btn btn--sm btn--ghost btn--icon"
          onClick={() => dismiss(next.id)}
          aria-label={t("meetNotice.dismiss")}
        >
          <IconClose size={14} />
        </button>
      </div>

      <div className="row row--tight">
        {next.can_join ? (
          <a
            className="btn btn--sm btn--primary"
            href={next.meeting_link}
            target="_blank"
            rel="noreferrer"
            onClick={() => dismiss(next.id)}
          >
            <IconWave size={14} />
            {t("meetNotice.join")}
          </a>
        ) : (
          // Inside the window but no link resolved. The consultation screen
          // explains why; sending them there beats a dead button here.
          <Link className="btn btn--sm" to="/consultation" onClick={() => dismiss(next.id)}>
            {t("meetNotice.openConsultation")}
            <IconArrowRight size={14} />
          </Link>
        )}
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => dismiss(next.id)}>
          {t("meetNotice.dismiss")}
        </button>
      </div>
    </aside>
  );
}

export default ConsultationNotice;
