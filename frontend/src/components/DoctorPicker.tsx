/**
 * Choose a doctor, then a time.
 *
 * Nobody is assigned a clinician silently any more. Booking starts with every
 * accepting doctor side by side — qualification, specialisation, experience,
 * working pattern and the soonest times they have free — because "who should I
 * see?" is a real question and answering it for the patient is how people end up
 * with an appointment they do not understand the point of.
 *
 * Two steps rather than one screen: comparing four doctors and picking a Tuesday
 * morning are different decisions, and a page that asks both at once gets neither
 * read. Selecting a doctor loads only their slots, and the patient can go back
 * without losing anything.
 *
 * Availability shown on a card is a *preview*, deliberately not the full grid —
 * the whole directory carrying every slot for every doctor would be tens of
 * kilobytes to render four cards, and the patient narrows to one before they need
 * the detail.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, type DoctorCard, type SlotDay } from "../api/client";
import { Chip, EmptyState, ErrorState, Field, Loading, fmt, useAsync } from "./ui";
import { modalityLabel } from "./Appointment";
import {
  IconArrowRight,
  IconCalendar,
  IconCheck,
  IconClipboard,
  IconUser,
} from "./icons";

/* ------------------------------------------------------------------------- */
export default function DoctorPicker({
  kinds,
  modalities,
  onBooked,
  onError,
  onAssigned,
}: {
  kinds: string[];
  modalities: string[];
  onBooked(): void;
  onError(message: string): void;
  /** Fired once a doctor has been confirmed as this patient's clinician. */
  onAssigned?(name: string): void;
}) {
  const { t } = useTranslation();
  const directory = useAsync(() => api.consultation.doctors(), []);
  const [chosen, setChosen] = useState<DoctorCard | null>(null);
  /** Clinician id currently being confirmed, so the row can show its own state. */
  const [confirming, setConfirming] = useState<number | null>(null);

  async function confirmDoctor(doctor: DoctorCard) {
    setConfirming(doctor.clinician_id);
    try {
      await api.consultation.selectClinician(doctor.clinician_id);
      // Reload rather than patching local state: the directory's
      // `current_clinician_id` is what drives the "your clinician" chip, and
      // the server is the only thing that knows the assignment actually stuck.
      await directory.reload();
      onAssigned?.(doctor.name);
    } catch (error) {
      onError(error instanceof ApiError ? error.message : t("consultation.confirmFailed"));
    } finally {
      setConfirming(null);
    }
  }

  if (directory.loading) return <Loading label={t("doctorPicker.finding")} rows={3} />;
  if (directory.error) return <ErrorState error={directory.error} retry={directory.reload} />;

  const doctors = directory.data?.doctors ?? [];
  const currentId = directory.data?.current_clinician_id ?? null;

  if (doctors.length === 0) {
    return (
      <EmptyState
        title={t("doctorPicker.noneTitle")}
        body={t("doctorPicker.noneBody")}
      />
    );
  }

  if (chosen) {
    return (
      <SlotStep
        doctor={chosen}
        kinds={kinds}
        modalities={modalities}
        onBack={() => setChosen(null)}
        onBooked={onBooked}
        onError={onError}
      />
    );
  }

  return (
    <div className="stack stack-4">
      <div className="stack stack-1">
        <span className="label">{t("doctorPicker.step1")}</span>
        <p className="meta">{t("doctorPicker.step1Lead")}</p>
      </div>

      <div className="doctorgrid">
        {doctors.map((doctor) => (
          <article key={doctor.clinician_id} className="doctorcard">
            <div className="row row--tight row--top row--nowrap">
              <span className="iconbadge iconbadge--lg iconbadge--solid">
                <IconUser size={22} />
              </span>
              <div className="stack stack-1" style={{ minWidth: 0, flex: 1 }}>
                <div className="row row--tight row--nowrap">
                  <strong className="doctorcard__name">{doctor.name}</strong>
                  {doctor.clinician_id === currentId && (
                    <Chip tone="ok">{t("doctorPicker.yourClinician")}</Chip>
                  )}
                </div>
                <span className="meta">{doctor.specialization}</span>
                {doctor.qualifications && (
                  <span className="row row--tight row--nowrap meta dim">
                    <IconClipboard size={13} />
                    {doctor.qualifications}
                  </span>
                )}
                {doctor.years_experience !== null && doctor.years_experience !== undefined && (
                  <span className="meta dim">
                    {t("doctorPicker.experience", { count: doctor.years_experience })}
                  </span>
                )}
              </div>
            </div>

            {doctor.bio && <p className="doctorcard__bio">{doctor.bio}</p>}

            <dl className="factlist">
              <div>
                <dt>{t("doctorPicker.workingDays")}</dt>
                <dd>{doctor.working_days_label}</dd>
              </div>
              <div>
                <dt>{t("doctorPicker.hours")}</dt>
                <dd>
                  {doctor.working_hours.map((w) => `${w.start}–${w.end}`).join(" · ")}
                  <span className="factlist__note">
                    {t("doctorPicker.slotLength", { count: doctor.slot_minutes })}
                  </span>
                </dd>
              </div>
              <div>
                <dt>{t("doctorPicker.soonest")}</dt>
                <dd>
                  {doctor.next_available_date ? (
                    <>
                      {fmt.weekday(doctor.next_available_date, true)}{" "}
                      {fmt.date(doctor.next_available_date)}
                      <span className="factlist__note">
                        {t("doctorPicker.slotsFree", { count: doctor.open_slots_soon })}
                      </span>
                    </>
                  ) : (
                    <>
                      {t("doctorPicker.noAvailability")}
                      <span className="factlist__note">{t("doctorPicker.nothingFree")}</span>
                    </>
                  )}
                </dd>
              </div>
            </dl>

            {doctor.next_slots.length > 0 && (
              <div className="stack stack-2">
                <span className="label">{t("doctorPicker.nextTimes")}</span>
                <div className="row row--tight">
                  {doctor.next_slots.map((time) => (
                    <Chip key={time} tone="ghost">
                      {time}
                    </Chip>
                  ))}
                </div>
              </div>
            )}

            <div className="stack stack-2">
              <button
                type="button"
                className="btn btn--primary btn--block"
                onClick={() => setChosen(doctor)}
                disabled={!doctor.next_available_date}
              >
                {doctor.next_available_date
                  ? t("doctorPicker.seeTimes", { name: doctor.name.split(" ").slice(-1)[0] })
                  : t("doctorPicker.noTimes")}
                <IconArrowRight size={15} />
              </button>

              {/* Choosing a doctor and booking a time are two decisions, so
                  they are two buttons. A patient who wants to settle who looks
                  after them before opening a calendar can; a patient who wants
                  to do both at once still can, because booking assigns the
                  clinician as a side effect server-side. */}
              {doctor.clinician_id !== currentId && (
                <button
                  type="button"
                  className="btn btn--block"
                  onClick={() => void confirmDoctor(doctor)}
                  disabled={confirming !== null}
                >
                  {confirming === doctor.clinician_id ? (
                    t("consultation.confirming")
                  ) : (
                    <>
                      <IconCheck size={15} />
                      {t("consultation.confirmDoctor", {
                        name: doctor.name.split(" ").slice(-1)[0],
                      })}
                    </>
                  )}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/**
 * Step two: the chosen doctor's slots.
 *
 * Taken slots render disabled rather than being omitted. A Tuesday showing
 * "10:00, 15:30" reads as a doctor with almost no availability; the same
 * Tuesday showing four struck-through times and two live ones reads as a busy
 * morning, which is what it is.
 */
function SlotStep({
  doctor,
  kinds,
  modalities,
  onBack,
  onBooked,
  onError,
}: {
  doctor: DoctorCard;
  kinds: string[];
  modalities: string[];
  onBack(): void;
  onBooked(): void;
  onError(message: string): void;
}) {
  const { t } = useTranslation();
  const slots = useAsync(() => api.consultation.slots(doctor.clinician_id), [doctor.clinician_id]);
  const [day, setDay] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [kind, setKind] = useState(kinds[0] ?? "follow_up");
  const [modality, setModality] = useState(modalities[0] ?? "teleaudiology");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const days = (slots.data?.days ?? []).filter((d: SlotDay) => d.working);
  const activeDay = days.find((d) => d.date === day) ?? days.find((d) => d.open_count > 0) ?? null;

  async function book() {
    if (!chosen || busy) return;
    setBusy(true);
    try {
      await api.consultation.request({
        scheduled_for: chosen,
        clinician_id: doctor.clinician_id,
        kind,
        modality,
        notes: notes.trim(),
      });
      onBooked();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : t("doctorPicker.bookFailed"));
      // Most likely somebody took the slot between render and click, so the grid
      // on screen is stale whatever went wrong.
      void slots.reload();
      setChosen(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack stack-4">
      <div className="row row--between row--nowrap">
        <div className="stack stack-1" style={{ minWidth: 0 }}>
          <span className="label">{t("doctorPicker.step2")}</span>
          <strong style={{ fontSize: "var(--fs-small)" }}>{doctor.name}</strong>
          <span className="meta">
            {t("doctorPicker.consultationLength", {
              specialisation: doctor.specialization,
              count: doctor.slot_minutes,
            })}
          </span>
        </div>
        <button type="button" className="btn btn--sm btn--ghost nowrap" onClick={onBack}>
          {t("doctorPicker.changeDoctor")}
        </button>
      </div>

      {slots.loading ? (
        <Loading label={t("doctorPicker.loadingAvailability")} rows={3} />
      ) : slots.error ? (
        <ErrorState error={slots.error} retry={slots.reload} />
      ) : days.length === 0 ? (
        <EmptyState
          title={t("doctorPicker.noSlotsTitle")}
          body={t("doctorPicker.noSlotsBody")}
        />
      ) : (
        <>
          <div className="stack stack-2">
            <span className="label">{t("doctorPicker.chooseDay")}</span>
            <div className="dayscroll" role="group" aria-label={t("doctorPicker.availableDays")}>
              {days.slice(0, 21).map((d) => {
                // Midday, not midnight: a bare date parses as UTC and renders a
                // day early anywhere west of Greenwich.
                const date = new Date(`${d.date}T12:00`);
                const active = activeDay?.date === d.date;
                const full = d.open_count === 0;
                return (
                  <button
                    key={d.date}
                    type="button"
                    className={`daychip${active ? " daychip--on" : ""}${full ? " daychip--full" : ""}`}
                    aria-pressed={active}
                    disabled={full}
                    onClick={() => {
                      setDay(d.date);
                      setChosen(null);
                    }}
                  >
                    {/* The weekday label comes off the parsed date rather than
                        the server's English `d.weekday`, so Intl abbreviates it
                        in the active language instead of it being sliced to
                        three Latin characters. */}
                    <span className="daychip__dow">{fmt.weekday(d.date)}</span>
                    <span className="daychip__num">{date.getDate()}</span>
                    <span className="daychip__slots">
                      {full ? t("doctorPicker.full") : t("doctorPicker.countFree", { count: d.open_count })}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="stack stack-2">
            <div className="row row--between row--nowrap">
              <span className="label">{t("doctorPicker.availableTimes")}</span>
              {activeDay && (
                <span className="meta">
                  {fmt.weekday(activeDay.date, true)} {fmt.date(activeDay.date)}
                </span>
              )}
            </div>
            {!activeDay || activeDay.slots.length === 0 ? (
              <p className="meta">{t("doctorPicker.noSlotsLeft")}</p>
            ) : (
              <div className="slotgrid" role="group" aria-label={t("doctorPicker.availableTimes")}>
                {activeDay.slots.map((slot) => (
                  <button
                    key={slot.start}
                    type="button"
                    className={`slot${chosen === slot.start ? " slot--on" : ""}`}
                    disabled={!slot.available}
                    aria-pressed={chosen === slot.start}
                    aria-label={
                      slot.available
                        ? t("doctorPicker.slotLabel", { time: slot.label, count: slot.minutes })
                        : t("doctorPicker.slotUnavailable", { time: slot.label, reason: slot.reason })
                    }
                    title={
                      slot.available
                        ? fmt.duration(slot.minutes)
                        : t("doctorPicker.unavailableTitle", { reason: slot.reason })
                    }
                    onClick={() => setChosen(slot.start)}
                  >
                    {slot.label}
                  </button>
                ))}
              </div>
            )}
            {activeDay && activeDay.open_count === 0 && activeDay.slots.length > 0 && (
              <p className="meta">{t("doctorPicker.fullyBooked")}</p>
            )}
          </div>

          <Field label={t("doctorPicker.reason")}>
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
              {kinds.map((option) => (
                <option key={option} value={option}>
                  {t(`consultation.kind.${option}`, { defaultValue: fmt.titleCase(option) })}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t("doctorPicker.modality")}>
            <select className="select" value={modality} onChange={(e) => setModality(e.target.value)}>
              {modalities.map((option) => (
                <option key={option} value={option}>
                  {modalityLabel(t, option)}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t("doctorPicker.notesLabel")} hint={t("common.optional")}>
            <textarea
              className="input"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("doctorPicker.notesPlaceholder")}
            />
          </Field>

          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={() => void book()}
            disabled={busy || !chosen}
          >
            {chosen ? <IconCheck size={15} /> : <IconCalendar size={15} />}
            {busy
              ? t("doctorPicker.booking")
              : chosen
                ? t("doctorPicker.confirmAt", { when: fmt.dateTime(chosen) })
                : t("doctorPicker.chooseATime")}
          </button>
          <p className="meta dim" style={{ fontSize: "var(--fs-micro)" }}>
            {t("doctorPicker.holdNote")}
          </p>
        </>
      )}
    </div>
  );
}
