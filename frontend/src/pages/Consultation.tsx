/**
 * Doctor consultation.
 *
 * The screen a patient opens when the question is "what is happening with my
 * care?" rather than "what are my numbers?". Everything here is about the
 * relationship with a human clinician: who they are, when you next see them,
 * what they wrote last time, and what you are supposed to do before then.
 *
 * It reads `/api/consultation`, which assembles the payload server-side from the
 * same `Appointment` and `ClinicalNote` rows the clinician console writes. The
 * two views deriving "your next appointment" independently is exactly how they
 * end up disagreeing, so only one of them derives it.
 *
 * Video consultations are real: an appointment carries a meeting link the
 * clinician sets, and the *server* decides whether the join button is live. See
 * `components/Appointment.tsx` for why that decision is not made here.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import { useSession } from "../state/session";
import {
  Chip,
  Disclosure,
  EmptyState,
  ErrorState,
  Loading,
  Panel,
  Readout,
  UrgencyChip,
  fmt,
  useAsync,
} from "../components/ui";
import {
  AppointmentCard,
  APPOINTMENT_STATUS_TONE as STATUS_TONE,
  JoinButton,
  appointmentStatusLabel,
  modalityLabel,
} from "../components/Appointment";
import DoctorPicker from "../components/DoctorPicker";
import { MeetPanel, useConsultationPolling } from "../components/MeetPanel";
import {
  IconAlert,
  IconArrowRight,
  IconChat,
  IconCheck,
  IconClipboard,
  IconFile,
  IconPhone,
  IconTarget,
  IconUser,
  IconWave,
} from "../components/icons";

export default function Consultation() {
  const { t } = useTranslation();
  const toast = useSession((s) => s.toast);
  const data = useAsync(() => api.consultation.get(), []);

  // The phase flips from "upcoming" to "imminent" to "live" with no user
  // action, so the screen refreshes itself as the appointment approaches.
  const nextAppointment = data.data?.upcoming?.[0] ?? null;
  useConsultationPolling(nextAppointment, data.reload);
  const [cancelling, setCancelling] = useState(false);

  async function cancel(appointmentId: number) {
    setCancelling(true);
    try {
      await api.consultation.cancel(appointmentId);
      toast(t("consultation.cancelled"), "info");
      await data.reload();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("consultation.cancelFailed"), "crit");
    } finally {
      setCancelling(false);
    }
  }

  if (data.loading) return <Loading label={t("consultation.loading")} rows={4} />;
  if (data.error) return <ErrorState error={data.error} retry={data.reload} />;
  if (!data.data) return null;

  const consultation = data.data;
  const { clinician, upcoming, history, notes, recommendations, summary } = consultation;
  const next = upcoming[0] ?? null;

  return (
    <div className="stack stack-5">
      {/* -- page head ------------------------------------------------------ */}
      <header className="pagehead">
        <div className="pagehead__title">
          <span className="label label--signal" data-tour="consultation">{t("consultation.label")}</span>
          <h1 style={{ fontSize: "clamp(1.9rem, 4.5vw, 2.9rem)" }}>{t("consultation.title")}</h1>
          <p className="meta">
            {clinician.assigned
              ? t("consultation.underCareOf", { name: clinician.name })
              : t("consultation.chooseDoctor")}
          </p>
        </div>
        <Link className="btn btn--sm" to="/results">
          <IconFile size={15} />
          {t("consultation.myReport")}
        </Link>
      </header>

      {/* -- choose a doctor, if they have not ------------------------------- */}
      {/* Shown *instead of* the clinician card rather than beside it. A patient
          with no clinician used to see a "Your clinician — Not assigned" panel,
          which is a card about the absence of a thing; the useful screen at
          that moment is the directory and a way to pick from it. */}
      {!clinician.assigned && (
        <Panel tone="signal" title={t("consultation.chooseTitle")} bracketed>
          <p style={{ fontSize: "var(--fs-small)", maxWidth: "60em" }}>{t("consultation.chooseBody")}</p>
        </Panel>
      )}

      {/* -- clinician + next appointment ----------------------------------- */}
      <div className="grid grid-2">
        {clinician.assigned && (
        <Panel tight>
          <div className="row row--tight row--top row--nowrap">
            <span className="iconbadge iconbadge--lg iconbadge--solid">
              <IconUser size={22} />
            </span>
            <div className="stack stack-1" style={{ minWidth: 0, flex: 1 }}>
              <span className="label">{t("consultation.yourClinician")}</span>
              <strong style={{ fontSize: "var(--fs-body)", lineHeight: 1.2 }}>
                {clinician.name}
              </strong>
              <span className="meta">
                {clinician.specialization ?? t("consultation.defaultSpecialisation")}
              </span>
              {clinician.qualifications && <span className="meta dim">{clinician.qualifications}</span>}
            </div>
          </div>

          {clinician.assigned && (
            <>
              <hr className="rule rule--tight" />
              <dl className="factlist">
                <div>
                  <dt>{t("consultation.workingDays")}</dt>
                  <dd>{clinician.working_days_label ?? "—"}</dd>
                </div>
                <div>
                  <dt>{t("consultation.consultationHours")}</dt>
                  <dd>
                    {(clinician.working_hours ?? []).map((w) => `${w.start}–${w.end}`).join(" · ") || "—"}
                    <span className="factlist__note">
                      {t("consultation.minutesPerConsultation", { count: clinician.slot_minutes ?? 0 })}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>{t("consultation.freeToday")}</dt>
                  <dd>
                    {clinician.works_today ? (
                      <>
                        {clinician.slots_remaining_today ?? 0}
                        <span className="factlist__unit">
                          {" "}
                          {t("consultation.slotsOf", { total: clinician.slots_today_total ?? 0 })}
                        </span>
                      </>
                    ) : (
                      t("consultation.notWorkingToday")
                    )}
                  </dd>
                </div>
              </dl>
              <hr className="rule rule--tight" />
              <div className="row row--tight">
                {clinician.email && (
                  <a className="btn btn--sm" href={`mailto:${clinician.email}`}>
                    <IconPhone size={14} />
                    {t("consultation.emailClinician", {
                      name: clinician.name?.split(" ").slice(-1)[0] ?? "",
                    })}
                  </a>
                )}
                <Link className="btn btn--sm btn--ghost" to="/support">
                  <IconChat size={14} />
                  {t("consultation.askAssistant")}
                </Link>
              </div>
              <p className="meta dim" style={{ marginTop: "var(--s2)", fontSize: "var(--fs-micro)" }}>
                {t("consultation.emailNote")}
              </p>
            </>
          )}
        </Panel>
        )}

        {next ? (
          <div className="stack stack-3">
            <AppointmentCard
              appointment={next}
              clinicianName={clinician.name}
              specialization={clinician.specialization}
              action={
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => void cancel(next.id)}
                  disabled={cancelling}
                >
                  {cancelling ? t("consultation.cancelling") : t("common.cancel")}
                </button>
              }
            />
            {/* The video surface sits under the card rather than inside it: the
                card is about the booking and never changes, this changes four
                times over the ten minutes around the start. */}
            <MeetPanel
              appointment={next}
              clinicianName={clinician.name}
              specialization={clinician.specialization}
            />
          </div>
        ) : (
          <Panel tight tone="sunken">
            <div className="row row--between row--nowrap" style={{ marginBottom: "var(--s3)" }}>
              <span className="label">{t("appointment.next")}</span>
            </div>
            <p className="meta">{t("consultation.nothingBooked")}</p>
          </Panel>
        )}
      </div>

      {/* -- the consultation that just happened ----------------------------- */}
      {/* Only the most recent, and only for a week. A completion notice that
          never goes away stops being a notice. */}
      {!next && history[0] && history[0].is_online && (
        <MeetPanel appointment={history[0]} clinicianName={history[0].clinician_name} />
      )}

      {/* -- quick summary of where treatment stands ------------------------- */}
      <Panel title={t("consultation.summary.title")} bracketed>
        <div className="grid grid-4">
          <Readout
            label={t("consultation.summary.handicap")}
            value={summary.thi_score ?? "—"}
            unit={summary.thi_score !== null ? "/100" : undefined}
            note={summary.thi_grade ?? t("consultation.summary.notAssessed")}
            size="md"
          />
          <Readout
            label={t("consultation.summary.hearing")}
            value={summary.hearing_grade ?? "—"}
            note={
              summary.laterality
                ? t("consultation.summary.lateralityTinnitus", {
                    side: t(`consultation.laterality.${summary.laterality}`, {
                      defaultValue: fmt.titleCase(summary.laterality),
                    }),
                  })
                : t("common.notGraded")
            }
            size="md"
          />
          <Readout
            label={t("consultation.summary.plan")}
            value={t(summary.plan_active ? "consultation.summary.planActive" : "consultation.summary.planNone")}
            note={
              summary.plan_active
                ? t("consultation.summary.planDetail", {
                    sounds: t("units.sounds", { count: summary.plan_blocks }),
                    minutes: t("units.minutesPerDay", { count: summary.daily_minutes_target ?? 0 }),
                  })
                : t("consultation.summary.completeAssessment")
            }
            size="md"
          />
          <Readout
            label={t("consultation.summary.lastAssessed")}
            value={summary.assessment_date ? fmt.date(summary.assessment_date) : "—"}
            note={
              summary.assessment_date
                ? fmt.ago(summary.assessment_date)
                : t("consultation.summary.noAssessment")
            }
            size="md"
          />
        </div>
        <hr className="rule rule--tight" />
        <div className="row row--tight no-print">
          <Link className="btn btn--sm btn--ghost" to="/results">
            {t("consultation.summary.fullReport")}
            <IconArrowRight size={14} />
          </Link>
          <Link className="btn btn--sm btn--ghost" to="/assessment">
            <IconClipboard size={14} />
            {t("consultation.summary.newAssessment")}
          </Link>
        </div>
      </Panel>

      <div className="grid grid-sidebar" style={{ ["--aside" as string]: "340px" }}>
        <div className="stack stack-5">
          {/* -- treatment recommendations --------------------------------- */}
          <Panel title={t("consultation.recommendations.title")} bracketed>
            {consultation.treatment_recommendations.length > 0 ? (
              <ul className="stack stack-3" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {consultation.treatment_recommendations.map((line, i) => (
                  <li key={i} className="row row--tight row--top row--nowrap">
                    <IconCheck
                      size={15}
                      style={{ color: "var(--ok-ink)", marginTop: 3, flex: "none" }}
                    />
                    <span style={{ fontSize: "var(--fs-small)", lineHeight: 1.6 }}>{line}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="meta">
                <Trans
                  i18nKey="consultation.recommendations.empty"
                  components={[<Link key="0" to="/assessment" />]}
                />
              </p>
            )}
          </Panel>

          {/* -- consultation notes ---------------------------------------- */}
          <Panel
            title={t("consultation.notes.title")}
            bracketed
            aside={<Chip tone="ghost">{notes.length}</Chip>}
          >
            {notes.length === 0 ? (
              <p className="meta">{t("consultation.notes.empty")}</p>
            ) : (
              <div className="stack stack-3">
                {notes.map((note) => (
                  <article key={note.id} className="notecard">
                    <div className="row row--between row--nowrap notecard__head">
                      <span className="notecard__author">
                        {note.clinician_name ?? t("consultation.notes.clinicalTeam")}
                      </span>
                      <span className="meta nowrap">{fmt.date(note.created_at)}</span>
                    </div>
                    <p className="notecard__body">{note.body}</p>
                    {note.ai_draft && (
                      <span className="meta dim" style={{ fontSize: "var(--fs-micro)" }}>
                        {t("consultation.notes.aiDraft")}
                      </span>
                    )}
                  </article>
                ))}
              </div>
            )}
          </Panel>

          {/* -- history --------------------------------------------------- */}
          <Panel
            title={t("consultation.history.title")}
            bracketed
            aside={<Chip tone="ghost">{history.length}</Chip>}
          >
            {history.length === 0 ? (
              <EmptyState
                title={t("consultation.history.emptyTitle")}
                body={t("consultation.history.emptyBody")}
              />
            ) : (
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t("consultation.history.date")}</th>
                      <th>{t("consultation.history.type")}</th>
                      <th>{t("consultation.history.how")}</th>
                      <th>{t("consultation.history.status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((appointment) => (
                      <tr key={appointment.id}>
                        <td className="mono nowrap">{fmt.date(appointment.scheduled_for)}</td>
                        <td>
                          {t(`consultation.kind.${appointment.kind}`, {
                            defaultValue: fmt.titleCase(appointment.kind),
                          })}
                        </td>
                        <td className="meta">{modalityLabel(t, appointment.modality)}</td>
                        <td>
                          <Chip tone={STATUS_TONE[appointment.status] ?? "ghost"}>
                            {appointmentStatusLabel(t, appointment.status)}
                          </Chip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        {/* -- aside: booking, follow-up ------------------------------------ */}
        <aside className="stack stack-4" aria-label={t("consultation.booking.title")}>
          <Panel title={t("consultation.booking.title")} bracketed>
            {next ? (
              <p className="meta">{t("consultation.booking.alreadyBooked")}</p>
            ) : (
              <DoctorPicker
                kinds={consultation.options.kinds}
                modalities={consultation.options.modalities}
                onBooked={() => {
                  toast(t("consultation.booked"), "ok");
                  void data.reload();
                }}
                onError={(message) => toast(message, "crit")}
                onAssigned={(name) => {
                  toast(t("consultation.confirmed", { name }), "ok");
                  void data.reload();
                }}
              />
            )}
          </Panel>

          <Panel title={t("consultation.followUp.title")} tight headPlain>
            {recommendations.length === 0 ? (
              <p className="meta">{t("consultation.followUp.empty")}</p>
            ) : (
              <div className="stack stack-3">
                {recommendations.map((item, i) => (
                  <div key={i} className="stack stack-1">
                    <div className="row row--tight row--nowrap">
                      {item.urgency !== "routine" && (
                        <IconAlert size={14} style={{ color: "var(--warn-ink)", flex: "none" }} />
                      )}
                      <strong style={{ fontSize: "var(--fs-tiny)" }}>{item.title}</strong>
                      {item.urgency !== "routine" && <UrgencyChip urgency={item.urgency} />}
                    </div>
                    <p className="meta">{item.detail}</p>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel tight tone="sunken">
            <div className="row row--tight row--top row--nowrap">
              <span className="iconbadge iconbadge--sm">
                <IconWave size={16} />
              </span>
              <div className="stack stack-1" style={{ minWidth: 0 }}>
                <span className="label">{t("consultation.video.title")}</span>
                <p className="meta">
                  {next?.is_online
                    ? t(next.has_meeting_link ? "consultation.video.linked" : "consultation.video.pending")
                    : t("consultation.video.none")}
                </p>
              </div>
            </div>
            {next?.is_online && (
              <div style={{ marginTop: "var(--s3)" }}>
                <JoinButton appointment={next} block />
              </div>
            )}
            <p className="meta dim" style={{ marginTop: "var(--s2)", fontSize: "var(--fs-micro)" }}>
              {t("consultation.video.note")}
            </p>
          </Panel>

          <Panel tight>
            <div className="row row--tight row--nowrap" style={{ marginBottom: "var(--s2)" }}>
              <IconTarget size={15} style={{ color: "var(--signal-ink)", flex: "none" }} />
              <span className="label">{t("consultation.before.title")}</span>
            </div>
            <Disclosure summary={t("consultation.before.whatToBring")}>
              <ul className="stack stack-2" style={{ margin: 0, paddingLeft: "var(--s5)" }}>
                <li className="meta">{t("consultation.before.item1")}</li>
                <li className="meta">{t("consultation.before.item2")}</li>
                <li className="meta">
                  <Trans
                    i18nKey="consultation.before.item3"
                    components={[<Link key="0" to="/assessment" />]}
                  />
                </li>
              </ul>
            </Disclosure>
          </Panel>
        </aside>
      </div>
    </div>
  );
}
