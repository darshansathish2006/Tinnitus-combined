/**
 * The introduction video, shown once before the guided walkthrough.
 *
 * A separate component from `Walkthrough` rather than a seventh step inside it,
 * because the two are structurally different: the walkthrough is a spotlight
 * that navigates between screens and lets the page underneath stay live, and
 * this is a modal that deliberately owns the whole viewport while it plays.
 * Folding a video into the spotlight machinery would mean a step that has no
 * highlight target and no route — a special case in every branch.
 *
 * "Skip video" and "Continue to walkthrough" are the same destination and stay
 * two buttons anyway. Someone who has watched it wants a confident forward
 * action; someone who has not wants a way out that does not read as abandoning
 * onboarding. One button labelled for one of those two people fails the other.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { OnboardingVideo } from "./OnboardingVideo";
import { IconArrowRight, IconClose, IconVideo } from "./icons";

export function OnboardingVideoModal({
  open,
  onSkip,
  onContinue,
}: {
  open: boolean;
  /** Dismiss the whole onboarding sequence — video and walkthrough. */
  onSkip(): void;
  /** Move on to the guided walkthrough. */
  onContinue(): void;
}) {
  const { t } = useTranslation();
  /** True once the video has played to the end, which promotes the CTA. */
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (!open) setFinished(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onSkip();
    };
    window.addEventListener("keydown", onKey);
    // The page behind must not scroll while a modal owns the viewport.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onSkip]);

  if (!open) return null;

  return (
    <div className="overlay" role="presentation">
      <div
        className="modal fade-in videomodal"
        role="dialog"
        aria-modal="true"
        aria-label={t("video.introTitle")}
      >
        <div className="row row--between row--top row--nowrap" style={{ marginBottom: "var(--s4)" }}>
          <div className="row row--tight row--nowrap" style={{ minWidth: 0 }}>
            <span className="iconbadge iconbadge--solid">
              <IconVideo size={19} />
            </span>
            <div style={{ minWidth: 0 }}>
              <h2 style={{ fontSize: "var(--fs-h3)", lineHeight: 1.2 }}>{t("video.introTitle")}</h2>
              <span className="meta">{t("video.introLead")}</span>
            </div>
          </div>
          <button
            type="button"
            className="btn btn--sm btn--ghost btn--icon"
            onClick={onSkip}
            aria-label={t("video.skip")}
          >
            <IconClose size={15} />
          </button>
        </div>

        {/* Autoplays muted — the only form of autoplay browsers allow without a
            prior interaction. The mute control is right there. */}
        <OnboardingVideo autoPlay onEnded={() => setFinished(true)} />

        <hr className="rule" />

        <div className="row row--between">
          <span className="meta dim">{t(finished ? "video.finishedNote" : "video.skipNote")}</span>
          <div className="row row--tight">
            <button type="button" className="btn btn--sm btn--ghost" onClick={onSkip}>
              {t("video.skip")}
            </button>
            <button type="button" className="btn btn--sm btn--primary" onClick={onContinue}>
              {t("video.continue")}
              <IconArrowRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default OnboardingVideoModal;
