/**
 * First-run guidance.
 *
 * A short pointer tour that names each screen and what it is for, and hands off
 * to the full guide at `/guide` for anything longer than two sentences. Nobody
 * reads a manual inside a popover, so this does not try to be one.
 *
 * Progress is stored per role, so a patient and a clinician get different tours
 * and neither is asked twice. The `?` in the header brings it back at any time.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  IconArrowRight,
  IconCalendar,
  IconChart,
  IconChat,
  IconClipboard,
  IconClose,
  IconEar,
  IconHeadphones,
  IconHelp,
  IconShield,
  IconSpark,
  IconTrend,
  IconUser,
  IconWave,
} from "./icons";

/**
 * A tour step, carrying keys rather than prose.
 *
 * Resolved inside the component so a language change re-renders the card in
 * place — a patient who switches language mid-tour should see the step they are
 * on, translated, not be dropped back to the first one.
 */
interface Step {
  icon: ReactNode;
  key: string;
  go?: { to: string; labelKey: string };
}

const PATIENT_STEPS: Step[] = [
  { icon: <IconClipboard size={20} />, key: "assessment", go: { to: "/assessment", labelKey: "tour.openIt" } },
  { icon: <IconHeadphones size={20} />, key: "headphones" },
  { icon: <IconWave size={20} />, key: "therapy", go: { to: "/rehabilitation", labelKey: "tour.seeIt" } },
  { icon: <IconChat size={20} />, key: "chat", go: { to: "/support", labelKey: "tour.tryIt" } },
  { icon: <IconCalendar size={20} />, key: "clinician", go: { to: "/consultation", labelKey: "tour.openIt" } },
  { icon: <IconHelp size={20} />, key: "guide", go: { to: "/guide", labelKey: "tour.openGuide" } },
];

const CLINICIAN_STEPS: Step[] = [
  { icon: <IconUser size={20} />, key: "caseload", go: { to: "/clinic", labelKey: "tour.openCaseload" } },
  { icon: <IconShield size={20} />, key: "safety" },
  { icon: <IconTrend size={20} />, key: "attribution" },
  { icon: <IconEar size={20} />, key: "cochlea" },
  { icon: <IconSpark size={20} />, key: "interval" },
  { icon: <IconHelp size={20} />, key: "docs", go: { to: "/guide", labelKey: "tour.openGuide" } },
];

const storageKey = (role: string) => `echosense.tour.${role}`;

export interface TourState {
  open: boolean;
  step: number;
  welcomed: boolean;
  setStep(n: number): void;
  begin(): void;
  finish(): void;
  restart(): void;
}

export function useTour(role: string): TourState {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [welcomed, setWelcomed] = useState(true);

  useEffect(() => {
    // Role can change once the session hydrates, so re-evaluate rather than
    // running only on mount.
    try {
      if (!localStorage.getItem(storageKey(role))) {
        setWelcomed(false);
        setStep(0);
        setOpen(true);
      } else {
        setOpen(false);
      }
    } catch {
      /* private mode — skip the tour rather than breaking the app */
    }
  }, [role]);

  /** Leave the welcome screen and start the step cards. */
  const begin = useCallback(() => {
    setWelcomed(true);
    setStep(0);
    setOpen(true);
  }, []);

  const finish = useCallback(() => {
    setOpen(false);
    setWelcomed(true);
    try {
      localStorage.setItem(storageKey(role), "1");
    } catch {
      /* nothing to persist to */
    }
  }, [role]);

  const restart = useCallback(() => {
    setWelcomed(true);
    setStep(0);
    setOpen(true);
  }, []);

  return { open, step, welcomed, setStep, begin, finish, restart };
}

export function Tour({ role, state }: { role: string; state: TourState }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isPatient = role === "patient";
  const steps = isPatient ? PATIENT_STEPS : CLINICIAN_STEPS;
  const group = isPatient ? "patient" : "clinician";
  const { open, step, welcomed, setStep, begin, finish } = state;

  if (!open) return null;

  /* -- first-run welcome -------------------------------------------------- */
  if (!welcomed) {
    return (
      <div className="overlay" role="presentation">
        <div
          className="modal fade-in"
          role="dialog"
          aria-modal="true"
          aria-label={t("tour.welcome")}
          style={{ maxWidth: 500 }}
        >
          <div className="stack stack-4">
            <span className="iconbadge iconbadge--lg iconbadge--solid">
              {isPatient ? <IconEar size={24} /> : <IconUser size={24} />}
            </span>
            <div className="stack stack-2">
              <span className="tickrule" />
              <h2 style={{ fontSize: "var(--fs-h2)" }}>
                {t(isPatient ? "tour.welcomePatientTitle" : "tour.welcomeClinicianTitle")}
              </h2>
              <p className="lead" style={{ fontSize: "var(--fs-small)" }}>
                {t(isPatient ? "tour.welcomePatientBody" : "tour.welcomeClinicianBody")}
              </p>
            </div>
            <div className="row">
              <button type="button" className="btn btn--primary" onClick={begin}>
                {t("tour.showMeAround")}
                <IconArrowRight size={16} />
              </button>
              <Link className="btn" to="/guide" onClick={finish}>
                {t("tour.readFullGuide")}
              </Link>
              <button type="button" className="btn btn--ghost" onClick={finish}>
                {t("common.skip")}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* -- step card ---------------------------------------------------------- */
  const current = steps[Math.min(step, steps.length - 1)];
  const isLast = step >= steps.length - 1;

  return (
    <aside className="tour no-print" role="dialog" aria-label={t("tour.gettingStarted")}>
      <div className="stack stack-3">
        <div className="row row--between row--top row--nowrap">
          <div className="row row--tight row--nowrap" style={{ minWidth: 0 }}>
            <span className="iconbadge">{current.icon}</span>
            <div style={{ minWidth: 0 }}>
              <strong style={{ fontSize: "var(--fs-small)", display: "block", lineHeight: 1.25 }}>
                {t(`tour.${group}.${current.key}Title`)}
              </strong>
              <span className="meta">
                {t("common.step", { current: step + 1, total: steps.length })}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="btn btn--sm btn--ghost btn--icon"
            onClick={finish}
            aria-label={t("tour.closeGuide")}
          >
            <IconClose size={15} />
          </button>
        </div>

        <p style={{ fontSize: "var(--fs-small)", lineHeight: 1.5 }}>
          {t(`tour.${group}.${current.key}Body`)}
        </p>

        <div className="row row--between">
          <div className="tour__dots" aria-hidden="true">
            {steps.map((_, i) => (
              <span key={i} className={`tour__dot${i === step ? " tour__dot--on" : ""}`} />
            ))}
          </div>
          <div className="row row--tight">
            {step > 0 && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setStep(step - 1)}>
                {t("common.back")}
              </button>
            )}
            {current.go && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  navigate(current.go!.to);
                  if (isLast) finish();
                  else setStep(step + 1);
                }}
              >
                {t(current.go.labelKey)}
              </button>
            )}
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => (isLast ? finish() : setStep(step + 1))}
            >
              {t(isLast ? "common.done" : "common.next")}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

/** Header button that brings the guide back. */
export function TourButton({ onClick }: { onClick(): void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="btn btn--sm btn--ghost btn--icon"
      onClick={onClick}
      title={t("tour.showTour")}
      aria-label={t("tour.showTour")}
    >
      <IconHelp size={18} />
    </button>
  );
}

export { IconChart };
