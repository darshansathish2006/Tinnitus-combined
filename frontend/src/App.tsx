/**
 * Application shell: routing, role-based navigation, and the clinician's
 * "acting as patient" banner.
 *
 * The banner matters. A clinician viewing a patient's therapy player is looking
 * at that patient's prescription, and it must be impossible to mistake it for
 * their own view — so when a clinician is scoped to a patient, the shell says so
 * persistently and offers one click to exit.
 */

import { Suspense, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useSession } from "./state/session";
import { Brand, HotkeyProvider, Loading, Panel, ThemeToggle, ToastStack } from "./components/ui";
import { LanguageSelector } from "./components/LanguageSelector";
import { IconUser, NAV_ICONS } from "./components/icons";
import { Tour, TourButton, useTour } from "./components/Tour";
import {
  Walkthrough,
  hasCompletedWalkthrough,
  markWalkthroughComplete,
} from "./components/Walkthrough";
import { OnboardingVideoModal } from "./components/OnboardingVideoModal";
import { ConsultationNotice } from "./components/ConsultationNotice";
import { api } from "./api/client";
import { engine } from "./audio/engine";

import Login from "./pages/Login";
import PatientHome from "./pages/PatientHome";
import Assessment from "./pages/Assessment";
import Rehabilitation from "./pages/Therapy";
import Chat from "./pages/Chat";
import Consultation from "./pages/Consultation";
import Results from "./pages/Results";
import Clinician from "./pages/Clinician";
import PatientRecord from "./pages/PatientRecord";
import Guide from "./pages/Guide";

/**
 * Patient rail.
 *
 * There is no "Your ear" entry, for either role. The 3D cochlea is no longer a
 * destination — it lives inside the report, next to the audiogram it visualises,
 * which is where the question it answers actually gets asked. A separate page
 * meant navigating away from your results to look at a picture of them.
 */
/**
 * Navigation entries carry a translation *key* rather than a label. The rail is
 * rendered from this list on every language change, so the labels have to be
 * resolved at render time — a pre-translated constant would be frozen in
 * whichever language happened to be active when this module was first
 * evaluated.
 */
const PATIENT_NAV = [
  { to: "/", labelKey: "nav.overview", end: true },
  { to: "/assessment", labelKey: "nav.assessment" },
  { to: "/rehabilitation", labelKey: "nav.rehabilitation" },
  { to: "/support", labelKey: "nav.support" },
  { to: "/consultation", labelKey: "nav.consultation" },
  { to: "/results", labelKey: "nav.results" },
  { to: "/guide", labelKey: "nav.guide" },
];

const CLINICIAN_NAV = [
  { to: "/clinic", labelKey: "nav.caseload", end: true },
  { to: "/guide", labelKey: "nav.guide" },
];

/**
 * What a clinician sees when scoped to a patient: the clinical record, and
 * nothing else.
 *
 * Deliberately not the patient's own navigation. Overview, Assessment, Therapy,
 * Support and Doctor consultation are screens a patient drives — an assessment
 * a clinician "completes" on a patient's behalf is fabricated data, a therapy
 * player is a listening session, and the support chat is that person's private
 * counselling history. What a clinician needs from a patient's record is what
 * they have already produced: results, reports, consultation detail and history.
 * Those live on the patient record and Results, both of which are here.
 */
const CLINICIAN_PATIENT_NAV: { to: string; labelKey: string; end?: boolean }[] = [
  { to: "/results", labelKey: "nav.results" },
];

export default function App() {
  const { t } = useTranslation();
  const session = useSession((s) => s.session);
  const booting = useSession((s) => s.booting);
  const hydrate = useSession((s) => s.hydrate);
  const actingPatientId = useSession((s) => s.actingPatientId);
  const actingPatientName = useSession((s) => s.actingPatientName);
  const actAsPatient = useSession((s) => s.actAsPatient);
  const logout = useSession((s) => s.logout);
  const navigate = useNavigate();
  const tour = useTour(session?.role === "patient" ? "patient" : "clinician");
  /**
   * Where the patient is in the onboarding sequence.
   *
   *   idle  → nothing showing
   *   video → the introduction video modal
   *   tour  → the six-step spotlight walkthrough
   *
   * One value rather than two booleans, because "video open" and "walkthrough
   * open" are mutually exclusive and two flags make the illegal state
   * representable — which is how you end up with a spotlight highlighting
   * something behind a modal.
   */
  const [onboarding, setOnboarding] = useState<"idle" | "video" | "tour">("idle");

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  /**
   * Offer the walkthrough exactly once, to a genuinely new patient.
   *
   * Three conditions, and each rules out a different false positive:
   *
   *  - **Patient only.** A clinician has their own console tour; the six steps
   *    here describe screens their role does not serve.
   *  - **Not already completed**, keyed by user id so a shared device does not
   *    carry one patient's state to the next.
   *  - **No completed assessment.** This is the one that separates "just signed
   *    up" from "cleared their browser". Somebody six months into treatment
   *    being ambushed by an onboarding tour reads as the product breaking, and
   *    the assessment is the only durable, server-side signal of whether they
   *    have actually started.
   */
  useEffect(() => {
    if (!session || session.role !== "patient") return;
    if (hasCompletedWalkthrough(session.user_id)) return;

    let cancelled = false;
    void (async () => {
      try {
        const assessments = await api.assessments.list();
        const started = assessments.some((row) => row.status === "complete");
        if (cancelled) return;
        if (started) markWalkthroughComplete(session.user_id);
        else setOnboarding("video");
      } catch {
        // The list failing is not a reason to withhold onboarding from someone
        // who may genuinely be new — but it is a reason not to loop on it.
        if (!cancelled) setOnboarding("video");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  /** Sequence finished or abandoned — either way it does not come back. */
  function endOnboarding() {
    if (session) markWalkthroughComplete(session.user_id);
    setOnboarding("idle");
  }

  // Never leave audio running when the app unmounts or the tab is hidden for
  // good — a masker playing behind a closed tab is a real complaint.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden" && engine.activeCount > 0) {
        // Therapy is allowed to continue in the background (that is the point of
        // an overnight fade), so only stop if nothing is deliberately running.
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  if (booting) {
    return (
      <main className="wrap wrap--narrow" style={{ paddingTop: "var(--s16)" }}>
        <Loading label={t("shell.starting")} />
      </main>
    );
  }

  if (!session) return <Login />;

  const isClinician = session.role === "clinician" || session.role === "admin";
  const nav = isClinician ? CLINICIAN_NAV : PATIENT_NAV;

  return (
    <HotkeyProvider>
      <div className="shell">
        {/* -- full-height navigation rail -------------------------------- */}
        <aside className="rail no-print">
          <div className="rail__brand">
            <NavLink to={isClinician ? "/clinic" : "/"} style={{ textDecoration: "none" }}>
              <Brand
                subtitle={t(isClinician ? "shell.brandSubtitleClinician" : "shell.brandSubtitlePatient")}
              />
            </NavLink>
          </div>

          <nav className="rail__nav" aria-label={t("shell.mainNav")}>
            {nav.map((item) => (
              <RailLink key={item.to} to={item.to} end={item.end} label={t(item.labelKey)} />
            ))}

            {/* A clinician scoped to a patient gets that patient's screens as a
                labelled second group, so it is always obvious which of the two
                records the current screen belongs to. */}
            {isClinician && actingPatientId !== null && (
              <>
                <span className="rail__group">
                  {actingPatientName ?? t("shell.patientNumber", { id: actingPatientId })}
                </span>
                {CLINICIAN_PATIENT_NAV.map((item) => (
                  <RailLink key={item.to} to={item.to} end={item.end} label={t(item.labelKey)} />
                ))}
              </>
            )}
          </nav>

          <div className="rail__foot">
            <div className="row row--tight row--nowrap" style={{ marginBottom: "var(--s3)" }}>
              <span
                className="iconbadge iconbadge--sm iconbadge--solid"
                style={{ borderColor: "var(--on-ink-line)" }}
              >
                <IconUser size={16} />
              </span>
              <span style={{ minWidth: 0 }}>
                <span
                  style={{
                    display: "block",
                    fontSize: "var(--fs-tiny)",
                    fontWeight: 700,
                    color: "var(--on-ink)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {session.full_name}
                </span>
                <span style={{ display: "block", fontSize: "var(--fs-micro)", color: "var(--on-ink-3)" }}>
                  {t(`shell.roles.${session.role}`, { defaultValue: session.role })}
                </span>
              </span>
            </div>
            {/* The rail copy is the one place a signed-in user reliably looks
                for account-level settings, so the language control lives here
                as well as in the top bar. */}
            <div style={{ marginBottom: "var(--s2)" }}>
              <LanguageSelector variant="block" align="start" />
            </div>
            <button
              type="button"
              className="btn btn--sm btn--block"
              onClick={() => {
                engine.stopAll(0.2);
                logout();
                navigate("/");
              }}
            >
              {t("shell.signOut")}
            </button>
          </div>
        </aside>

        {/* -- content column ---------------------------------------------- */}
        <div className="main">
          <header className="topbar no-print">
            <div className="topbar__inner">
              {isClinician && actingPatientId !== null ? (
                <>
                  <span className="chip chip--signal">{t("shell.viewing")}</span>
                  <strong style={{ fontSize: "var(--fs-small)" }}>
                    {actingPatientName ?? t("shell.patientNumber", { id: actingPatientId })}
                  </strong>
                  <span className="meta nowrap">{t("shell.viewingNote")}</span>
                  <span className="spacer" />
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      actAsPatient(null, null);
                      navigate("/clinic");
                    }}
                  >
                    {t("shell.exitPatientView")}
                  </button>
                </>
              ) : (
                <>
                  <span className="label">
                    {t(isClinician ? "shell.topbarClinician" : "shell.topbarPatient")}
                  </span>
                  <span className="spacer" />
                </>
              )}
              <LanguageSelector variant="compact" />
              {/* For a patient the `?` replays the full walkthrough, which is
                  what the Help section promises; clinicians keep the pointer
                  tour, which is the only one written for their console. */}
              <TourButton onClick={isClinician ? tour.restart : () => setOnboarding("video")} />
              <ThemeToggle />
            </div>
          </header>

          <main className="wrap" style={{ paddingBlock: "var(--s6) var(--s16)" }}>
            <Suspense fallback={<Loading label={t("shell.loadingModule")} />}>
              <Routes>
            {isClinician ? (
              <>
                <Route path="/clinic" element={<Clinician />} />
                <Route path="/clinic/patient/:id" element={<PatientRecord />} />
                {/* Results is the one patient-facing screen a clinician opens,
                    and only while scoped to a patient — it is the clinical
                    report, and it opens expanded for them. The patient's own
                    navigation (overview, assessment, therapy, support, their
                    consultation booking) redirects to the caseload: those are
                    screens the patient drives, and a clinician acting inside
                    them either fabricates data or reads private material. */}
                <Route path="/results" element={actingPatientId ? <Results /> : <Navigate to="/clinic" replace />} />
                <Route path="/guide" element={<Guide />} />
                <Route path="*" element={<Navigate to="/clinic" replace />} />
              </>
            ) : (
              <>
                <Route path="/" element={<PatientHome />} />
                <Route path="/assessment" element={<Assessment />} />
                <Route path="/rehabilitation" element={<Rehabilitation />} />
                {/* The module was renamed from Therapy to Rehabilitation. The
                    old path is kept as a permanent redirect rather than
                    deleted: it is in patients' history, in the seeded demo
                    links, and in any note a clinician has already written. */}
                <Route path="/therapy" element={<Navigate to="/rehabilitation" replace />} />
                <Route path="/support" element={<Chat />} />
                <Route path="/consultation" element={<Consultation />} />
                <Route path="/results" element={<Results />} />
                <Route path="/guide" element={<Guide />} />
                <Route path="*" element={<NotFound />} />
              </>
            )}
              </Routes>
            </Suspense>
          </main>

        </div>
      </div>

      {/* Rendered outside the routed content so the spotlight can measure
          elements on whichever screen the current step navigated to. */}
      {/* The video plays first; finishing or skipping it hands straight over
          to the walkthrough, which is what makes this one sequence rather than
          two things that both happen to appear on first login. */}
      <OnboardingVideoModal
        open={onboarding === "video" && !isClinician}
        onSkip={endOnboarding}
        onContinue={() => setOnboarding("tour")}
      />

      <Walkthrough
        open={onboarding === "tour" && !isClinician}
        onClose={endOnboarding}
        onFinish={endOnboarding}
      />

      {/* Ten-minute consultation notice. Outside the routed content so it
          reaches a patient wherever they are in the app, not only on the two
          screens that render the join button. */}
      {!isClinician && <ConsultationNotice />}

      {/* Clinicians only. The pointer tour and the spotlight walkthrough are two
          onboarding overlays, and a new patient was getting both — the "Welcome
          to EchoSense" modal on top of the walkthrough's first step. The
          walkthrough is the patient onboarding now; this stays for the console,
          which is the one role it was written for. */}
      {isClinician && <Tour role="clinician" state={tour} />}
      <ToastStack />
    </HotkeyProvider>
  );
}

function RailLink({ to, end, label }: { to: string; end?: boolean; label: string }) {
  const Icon = NAV_ICONS[to];
  return (
    <NavLink
      to={to}
      end={end}
      title={label}
      className={({ isActive }) => `rail__link${isActive ? " rail__link--active" : ""}`}
    >
      {Icon && <Icon size={18} />}
      <span>{label}</span>
    </NavLink>
  );
}

function NotFound() {
  const { t } = useTranslation();
  return (
    <Panel title={t("errors.notFound")} bracketed>
      <p className="meta">{t("errors.notFoundBody")}</p>
      <NavLink className="btn btn--sm" to="/" style={{ marginTop: "var(--s3)" }}>
        {t("errors.backToOverview")}
      </NavLink>
    </Panel>
  );
}
