/**
 * Patient overview.
 *
 * A calm daily landing screen, not an analytics dashboard. The charts, trend
 * lines and rolling means that used to live here were answering a question
 * patients were not asking: someone opening this at 7am wants to know what to do
 * today and whether things are moving in the right direction, in a sentence.
 * The analysis still exists in full on the Results screen, one click away, where
 * someone who wants it is deliberately looking for it.
 *
 * Three things carry the screen now:
 *
 *  - **A wellness check.** One question, five answers, answered in a second. It
 *    is stored locally rather than posted, because a check-in that silently
 *    becomes clinical data is not the same promise as one that does not — see
 *    `wellnessKey`.
 *  - **A quote that changes daily.** Deterministic from the date, so it is
 *    stable all day and different tomorrow, with no backend and no storage.
 *  - **A comparison against the previous assessment.** The one number-shaped
 *    thing worth showing, phrased as a sentence rather than a chart.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api, ApiError, type Assessment } from "../api/client";
import { useSession } from "../state/session";
import { Chip, ErrorState, Loading, Panel, fmt, useAsync } from "../components/ui";
import { AppointmentStrip } from "../components/Appointment";
import { MeetPanel, useConsultationPolling } from "../components/MeetPanel";
import {
  IconArrowRight,
  IconChat,
  IconCheck,
  IconClipboard,
  IconEar,
  IconMoodSmile,
  IconSpark,
  IconTrend,
  IconUser,
  IconWave,
} from "../components/icons";

/* ------------------------------------------------------------------------- */
/* Daily quote                                                                */
/* ------------------------------------------------------------------------- */
/**
 * Rotates once per day without a backend, storage or a random seed.
 *
 * Indexed by days-since-epoch so every device shows the same line on the same
 * day and a new one at midnight — `Math.random()` would change it on every
 * re-render, which reads as a glitch rather than a rotation.
 *
 * Written to be true rather than inspirational. Tinnitus advice that overpromises
 * ("stay positive and it will fade") is the fastest way to lose someone who has
 * had it for ten years.
 */
/**
 * Ten quotes, held in the translation files under `home.quotes.<index>` and
 * selected here by index.
 *
 * The count lives in the code rather than being derived from the resource
 * bundle so that a language which has not yet translated all ten cannot change
 * *which* quote a given day shows — every reader gets the same thought on the
 * same day regardless of language, and a missing key falls back to English
 * rather than shifting the rotation.
 */
const QUOTE_COUNT = 10;

function quoteIndexForToday(): number {
  const daysSinceEpoch = Math.floor(Date.now() / 86_400_000);
  return daysSinceEpoch % QUOTE_COUNT;
}

/* ------------------------------------------------------------------------- */
/* Wellness check                                                             */
/* ------------------------------------------------------------------------- */
const WELLNESS_OPTIONS = [
  { value: 5, key: "good", tone: "ok" as const },
  { value: 4, key: "ok", tone: "ok" as const },
  { value: 3, key: "mixed", tone: "warn" as const },
  { value: 2, key: "difficult", tone: "warn" as const },
  { value: 1, key: "struggling", tone: "crit" as const },
];

/**
 * Local, per-patient, per-day.
 *
 * Deliberately not sent to the server. The clinical record is built from
 * validated instruments with known psychometrics; a one-tap mood tap is not one
 * of those, and mixing it into the record would give it a weight it has not
 * earned. This is a nudge for the person, not a measurement for the clinician.
 */
function wellnessKey(patientKey: string): string {
  return `echosense.wellness.${patientKey}.${new Date().toISOString().slice(0, 10)}`;
}

function readWellness(patientKey: string): number | null {
  try {
    const stored = window.localStorage.getItem(wellnessKey(patientKey));
    return stored === null ? null : Number(stored);
  } catch {
    // Private browsing and blocked storage both throw here. A check-in that
    // cannot be remembered is still worth offering.
    return null;
  }
}

/* ------------------------------------------------------------------------- */
/* Assessment-to-assessment comparison                                        */
/* ------------------------------------------------------------------------- */
interface Comparison {
  text: string;
  tone: "ok" | "warn" | "ghost";
}

/**
 * Plain-language change since the previous assessment.
 *
 * Only reports a direction where the instrument has a defensible threshold for
 * one: the THI's 7-point MCID, and a full band change on the graded scales.
 * Reporting "your stress improved" off a 1-point PSS move would be reporting
 * noise as progress, which costs trust the first time the next assessment
 * reverses it.
 */
function buildComparisons(t: TFunction, current: Assessment, previous: Assessment): Comparison[] {
  const out: Comparison[] = [];

  const thiNow = current.thi_score;
  const thiWas = previous.thi_score;
  if (thiNow !== null && thiWas !== null) {
    const delta = thiNow - thiWas;
    if (delta <= -7) {
      out.push({
        text:
          current.thi_grade && previous.thi_grade && current.thi_grade !== previous.thi_grade
            ? // The grades come from the server as "Grade 3 - Moderate". They are
              // interpolated as given rather than lower-cased: `toLowerCase()` is a
              // no-op on Tamil and Devanagari, which have no letter case, so the
              // English-only flourish bought nothing and the sentence reads better
              // in all three languages without it.
              t("home.since.thiGradeDown", { from: previous.thi_grade, to: current.thi_grade })
            : t("home.since.thiDown", { points: Math.abs(delta) }),
        tone: "ok",
      });
    } else if (delta >= 7) {
      out.push({ text: t("home.since.thiUp", { points: delta }), tone: "warn" });
    } else {
      out.push({ text: t("home.since.thiSteady"), tone: "ghost" });
    }
  }

  // Sleep and stress are only scored when the screener escalated, so both
  // assessments having a value is the exception rather than the rule.
  const psqiNow = current.psqi_score;
  const psqiWas = previous.psqi_score;
  if (psqiNow !== null && psqiWas !== null && Math.abs(psqiNow - psqiWas) >= 3) {
    out.push({
      text: t(psqiNow < psqiWas ? "home.since.sleepBetter" : "home.since.sleepWorse"),
      tone: psqiNow < psqiWas ? "ok" : "warn",
    });
  }

  const stressNow = current.pss10_score ?? current.pss4_score;
  const stressWas = previous.pss10_score ?? previous.pss4_score;
  // Only comparable when both came from the same instrument.
  const sameInstrument =
    (current.pss10_score === null) === (previous.pss10_score === null) &&
    stressNow !== null &&
    stressWas !== null;
  if (sameInstrument && stressNow !== null && stressWas !== null) {
    const threshold = current.pss10_score !== null ? 4 : 2;
    if (Math.abs(stressNow - stressWas) >= threshold) {
      out.push({
        text: t(stressNow < stressWas ? "home.since.stressBetter" : "home.since.stressWorse"),
        tone: stressNow < stressWas ? "ok" : "warn",
      });
    }
  }

  const anxietyNow = current.gad7_score;
  const anxietyWas = previous.gad7_score;
  if (anxietyNow !== null && anxietyWas !== null && Math.abs(anxietyNow - anxietyWas) >= 4) {
    out.push({
      text: t(anxietyNow < anxietyWas ? "home.since.anxietyBetter" : "home.since.anxietyWorse"),
      tone: anxietyNow < anxietyWas ? "ok" : "warn",
    });
  }

  return out;
}

/* ------------------------------------------------------------------------- */
export default function PatientHome() {
  const { t } = useTranslation();
  const session = useSession((s) => s.session);
  const actingName = useSession((s) => s.actingPatientName);
  const actingPatientId = useSession((s) => s.actingPatientId);

  const profile = useAsync(() => api.patients.me(), []);
  const assessments = useAsync(() => api.assessments.list(), []);
  const prescription = useAsync(async () => {
    try {
      return await api.therapy.current();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }, []);
  const consultation = useAsync(() => api.consultation.get(), []);

  // The dashboard is where a patient is most likely to be sitting ten minutes
  // before a consultation, so it refreshes itself into the join window rather
  // than waiting for them to reload.
  //
  // Declared here, above the loading and error returns below, because it is a
  // hook: reading `nextAppointment` first and calling it further down meant it
  // was skipped on the loading render and called on the loaded one, which is
  // exactly the "rendered more hooks than during the previous render" crash.
  useConsultationPolling(consultation.data?.upcoming?.[0] ?? null, consultation.reload);

  // The check-in is keyed per patient so a clinician stepping through several
  // records does not see the previous patient's answer.
  const patientKey = String(actingPatientId ?? session?.patient_id ?? session?.user_id ?? "self");
  const [wellness, setWellness] = useState<number | null>(null);
  useEffect(() => {
    setWellness(readWellness(patientKey));
  }, [patientKey]);

  function recordWellness(value: number) {
    setWellness(value);
    try {
      window.localStorage.setItem(wellnessKey(patientKey), String(value));
    } catch {
      /* storage unavailable — the answer still shows for this visit */
    }
  }

  if (profile.loading || assessments.loading) return <Loading label={t("home.loading")} rows={4} />;
  if (profile.error) return <ErrorState error={profile.error} retry={profile.reload} />;

  const firstName = (actingName ?? session?.full_name ?? "").split(" ")[0];
  const completed = (assessments.data ?? []).filter((row) => row.status === "complete");
  const assessment = completed.length > 0 ? completed[completed.length - 1] : null;
  const previous = completed.length > 1 ? completed[completed.length - 2] : null;
  const nextAppointment = consultation.data?.upcoming[0] ?? null;
  const quoteIndex = quoteIndexForToday();

  /* -- nothing on file yet: one screen, one button ------------------------ */
  if (!assessment) {
    return (
      <div className="stack stack-6">
        <section className="hero">
          <svg className="hero__art" viewBox="0 0 800 200" preserveAspectRatio="none" aria-hidden="true">
            <path
              d="M0 100 Q 60 30 120 100 T 240 100 T 360 100 T 480 100 T 600 100 T 720 100 T 840 100"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path
              d="M0 130 Q 40 90 80 130 T 160 130 T 240 130 T 320 130 T 400 130 T 480 130 T 560 130 T 640 130 T 720 130 T 800 130"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
          <div className="stack stack-3" style={{ position: "relative", maxWidth: "34ch" }}>
            <h1 style={{ fontSize: "clamp(1.8rem, 4vw, 2.5rem)" }}>
              {firstName ? t("home.hello", { name: firstName }) : t("home.welcome")}
            </h1>
            <p className="lead" style={{ fontSize: "var(--fs-body)" }}>
              {t("home.firstRun.lead")}
            </p>
          </div>
        </section>

        <Link className="action action--primary" to="/assessment">
          <span className="iconbadge iconbadge--lg">
            <IconClipboard size={22} />
          </span>
          <span className="action__body">
            <span className="action__title">{t("home.firstRun.startTitle")}</span>
            <span className="action__sub">{t("home.firstRun.startSub")}</span>
          </span>
          <IconArrowRight className="action__go" size={20} />
        </Link>

        <div className="grid grid-3">
          {[
            { icon: <IconEar size={20} />, key: "hearing" },
            { icon: <IconWave size={20} />, key: "plan" },
            { icon: <IconChat size={20} />, key: "support" },
          ].map((card) => (
            <Panel key={card.key} tight>
              <div className="row row--tight">
                <span className="iconbadge">{card.icon}</span>
                <div style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: "var(--fs-small)", display: "block" }}>
                    {t(`home.firstRun.${card.key}Title`)}
                  </strong>
                  <span className="meta">{t(`home.firstRun.${card.key}Sub`)}</span>
                </div>
              </div>
            </Panel>
          ))}
        </div>
      </div>
    );
  }

  const comparisons = previous ? buildComparisons(t, assessment, previous) : [];
  const answered = WELLNESS_OPTIONS.find((option) => option.value === wellness) ?? null;

  return (
    <div className="stack stack-5">
      {/* -- page head ------------------------------------------------------ */}
      <header className="pagehead" data-tour="overview">
        <div className="pagehead__title">
          <span className="label label--signal">{t("home.overview")}</span>
          <h1 style={{ fontSize: "clamp(2rem, 5vw, 3.25rem)" }}>
            {firstName ? firstName : t("home.yourTinnitus")}
          </h1>
          <p className="meta">
            {t("home.lastChecked", {
              grade: assessment.thi_grade ?? t("home.assessed"),
              when: fmt.ago(assessment.created_at),
            })}
          </p>
        </div>
        <Link className="btn btn--sm" to="/assessment">
          {t("home.newAssessment")}
        </Link>
      </header>

      {/* -- next consultation ---------------------------------------------- */}
      {/* Above the quick-access row on purpose: on the day of an appointment it
          is the only thing on this screen that is time-critical. It disappears
          entirely when there is nothing booked rather than leaving an empty
          card. */}
      {/* The strip is the always-on line: when, and with whom. The Meet panel
          appears beneath it only once the consultation is inside its ten-minute
          window, and carries the countdown and the join button. */}
      {nextAppointment && <AppointmentStrip appointment={nextAppointment} />}
      {nextAppointment && nextAppointment.phase !== "upcoming" && (
        <MeetPanel appointment={nextAppointment} compact />
      )}

      {/* -- quick access, pinned to the top -------------------------------- */}
      <nav className="grid grid-3" aria-label={t("shell.quickAccess")}>
        <Link className="action" to="/rehabilitation">
          <span className="iconbadge">
            <IconWave size={20} />
          </span>
          <span className="action__body">
            <span className="action__title">{t("home.quick.therapy")}</span>
            <span className="action__sub">
              {prescription.data
                ? t("home.quick.therapyPlan", {
                    sounds: t("units.sounds", { count: prescription.data.program.length }),
                    minutes: t("units.minutesPerDay", {
                      count: prescription.data.daily_minutes_target,
                    }),
                  })
                : t("home.quick.noPlan")}
            </span>
          </span>
          <IconArrowRight className="action__go" size={18} />
        </Link>

        <Link className="action" to="/support">
          <span className="iconbadge iconbadge--info">
            <IconChat size={20} />
          </span>
          <span className="action__body">
            <span className="action__title">{t("home.quick.support")}</span>
            <span className="action__sub">{t("home.quick.supportSub")}</span>
          </span>
          <IconArrowRight className="action__go" size={18} />
        </Link>

        {/* The 3D cochlea moved into the report, so this slot is the care team
            for everyone — there is no longer a clinician-only destination. */}
        <Link className="action" to="/consultation">
            <span className="iconbadge iconbadge--ok">
              <IconUser size={20} />
            </span>
            <span className="action__body">
              <span className="action__title">{t("home.quick.consultation")}</span>
              <span className="action__sub">
                {nextAppointment
                  ? t("home.quick.nextAt", { when: fmt.dateTime(nextAppointment.scheduled_for) })
                  : profile.data?.clinician_name
                    ? t("home.quick.withClinician", { name: profile.data.clinician_name })
                    : t("home.quick.bookAppointment")}
              </span>
            </span>
          <IconArrowRight className="action__go" size={18} />
        </Link>
      </nav>

      {/* -- daily wellness -------------------------------------------------- */}
      <Panel className="wellness" bracketed>
        <div className="wellness__grid">
          {/* check-in */}
          <div className="stack stack-3">
            <div className="row row--tight row--nowrap">
              <span className="iconbadge iconbadge--sm iconbadge--solid">
                <IconMoodSmile size={16} />
              </span>
              <div style={{ minWidth: 0 }}>
                <h2 className="wellness__title">{t("home.wellness.question")}</h2>
                <span className="meta">{t("home.wellness.sub")}</span>
              </div>
            </div>

            <div className="wellness__options" role="group" aria-label={t("home.wellness.question")}>
              {WELLNESS_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`wellness__option${wellness === option.value ? " wellness__option--on" : ""}`}
                  aria-pressed={wellness === option.value}
                  onClick={() => recordWellness(option.value)}
                >
                  {wellness === option.value && <IconCheck size={13} />}
                  {t(`home.wellness.${option.key}`)}
                </button>
              ))}
            </div>

            {answered && (
              <div className="wellness__reply fade-in">
                <p style={{ fontSize: "var(--fs-small)", lineHeight: 1.55 }}>
                  {t(`home.wellness.${answered.key}Reply`)}
                </p>
                {answered.value <= 2 && (
                  <div className="row row--tight" style={{ marginTop: "var(--s3)" }}>
                    <Link className="btn btn--sm btn--primary" to="/support">
                      <IconChat size={14} />
                      {t("home.wellness.talkItThrough")}
                    </Link>
                    <Link className="btn btn--sm" to="/rehabilitation">
                      <IconWave size={14} />
                      {t("home.wellness.startBlock")}
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* quote of the day */}
          <figure className="quote">
            <IconSpark size={16} className="quote__mark" />
            <blockquote className="quote__line">{t(`home.quotes.${quoteIndex}.line`)}</blockquote>
            <figcaption className="quote__source">{t(`home.quotes.${quoteIndex}.source`)}</figcaption>
          </figure>
        </div>
      </Panel>

      {/* -- how you compare to last time ------------------------------------ */}
      <Panel
        title={t("home.since.title")}
        bracketed
        aside={
          previous ? (
            <Chip tone="ghost">
              {fmt.date(previous.created_at)} → {fmt.date(assessment.created_at)}
            </Chip>
          ) : undefined
        }
      >
        {!previous ? (
          <p className="meta">{t("home.since.firstTime")}</p>
        ) : comparisons.length === 0 ? (
          <p className="meta">{t("home.since.noChange")}</p>
        ) : (
          <ul className="stack stack-3" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {comparisons.map((item, i) => (
              <li key={i} className="row row--tight row--top row--nowrap">
                <span className={`dot dot--${item.tone === "ghost" ? "ghost" : item.tone}`} aria-hidden="true" />
                <span style={{ fontSize: "var(--fs-small)", lineHeight: 1.6 }}>{item.text}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* -- where things stand, in words ------------------------------------ */}
      <div className="grid grid-2">
        <Panel title={t("home.latest.title")} tight headPlain>
          <dl className="factlist">
            <div>
              <dt>{t("home.latest.handicap")}</dt>
              <dd>
                {assessment.thi_score === null ? "—" : fmt.int(assessment.thi_score)}
                {assessment.thi_score !== null && <span className="factlist__unit">/100</span>}
                {assessment.thi_grade && <span className="factlist__note">{assessment.thi_grade}</span>}
              </dd>
            </div>
            <div>
              <dt>{t("home.latest.hearing")}</dt>
              <dd>
                {assessment.hearing_grade ?? t("common.notGraded")}
                {assessment.pitch_match_hz && (
                  <span className="factlist__note">
                    {t("home.latest.pitchNear", { hz: fmt.hz(assessment.pitch_match_hz) })}
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt>{t("home.latest.plan")}</dt>
              <dd>
                {t(prescription.data ? "home.latest.planActive" : "home.latest.planNone")}
                <span className="factlist__note">
                  {prescription.data
                    ? t("home.latest.reviewAfter", { days: prescription.data.review_after_days })
                    : t("home.latest.generatedFrom")}
                </span>
              </dd>
            </div>
          </dl>
        </Panel>

        <Panel title={t("home.next.title")} tight headPlain>
          <div className="stack stack-3">
            <p className="meta">
              {prescription.data
                ? t("home.next.withPlan", {
                    minutes: prescription.data.daily_minutes_target,
                    count: prescription.data.program.length,
                  })
                : t("home.next.withoutPlan")}
            </p>
            <div className="row row--tight">
              <Link className="btn btn--sm btn--primary" to={prescription.data ? "/rehabilitation" : "/assessment"}>
                {t(prescription.data ? "home.next.openProgramme" : "home.next.startAssessment")}
                <IconArrowRight size={14} />
              </Link>
              <Link className="btn btn--sm btn--ghost" to="/results">
                <IconTrend size={14} />
                {t("home.next.fullReport")}
              </Link>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
