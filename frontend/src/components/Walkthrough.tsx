/**
 * First-run guided walkthrough.
 *
 * A spotlight tour: the rest of the screen dims, the section being described is
 * cut out of the dimming layer, and a card is positioned beside it. Eight steps,
 * in the order a patient actually uses the product — Overview, Assessment,
 * Results, Rehabilitation, Community, Group therapy, Consultation, Reports.
 *
 * **It runs once, for genuinely new accounts only.** Two guards, and they catch
 * different things:
 *
 *  - The completion flag is keyed by *user id*, so a shared device does not
 *    show one patient's completed tour state to the next person who signs in.
 *  - It only offers itself to an account with no completed assessment. A
 *    patient returning after six months has not "just created an account" in
 *    any sense that matters, and a walkthrough that ambushes them because a
 *    browser was cleared reads as the product breaking.
 *
 * The spotlight is driven by `data-tour` attributes on the real elements rather
 * than by hardcoded coordinates, so a layout change moves the highlight with it
 * instead of leaving it pointing at empty space.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { IconArrowRight, IconCheck, IconClose } from "./icons";

/** The element each step points at, and where it lives. */
interface WalkStep {
  /** Matches `data-tour="<target>"` in the DOM. */
  target: string;
  /** Route to be on before the step can highlight anything. */
  route: string;
}

/**
 * Eight steps. The route is part of the step because a walkthrough that
 * describes the assessment while the patient is looking at the dashboard is a
 * slideshow, not a tour — each step navigates first, then highlights.
 *
 * Community and Group therapy sit between Rehabilitation and Consultation
 * deliberately: the order follows how the product is actually used, from what
 * you do alone, through what you do alongside other patients, to what you do
 * with a clinician. Both routes are patient-only, and both targets live on the
 * page header rather than inside a conditional branch, so the spotlight has
 * something to land on for a brand-new account that has not joined a community
 * or a room yet — which is precisely who sees this tour.
 */
const STEPS: WalkStep[] = [
  { target: "overview", route: "/" },
  { target: "assessment", route: "/assessment" },
  { target: "results", route: "/results" },
  { target: "rehabilitation", route: "/rehabilitation" },
  { target: "community", route: "/community" },
  { target: "group_therapy", route: "/group-therapy" },
  { target: "consultation", route: "/consultation" },
  { target: "reports", route: "/results" },
];

const DONE_KEY = (userId: number | string) => `echosense.walkthrough.${userId}`;

export function hasCompletedWalkthrough(userId: number | string): boolean {
  try {
    return localStorage.getItem(DONE_KEY(userId)) === "1";
  } catch {
    // Private mode: treat as complete rather than showing the tour on every
    // single page load, which is far worse than never showing it.
    return true;
  }
}

export function markWalkthroughComplete(userId: number | string): void {
  try {
    localStorage.setItem(DONE_KEY(userId), "1");
  } catch {
    /* nothing to persist to */
  }
}

export function resetWalkthrough(userId: number | string): void {
  try {
    localStorage.removeItem(DONE_KEY(userId));
  } catch {
    /* nothing to clear */
  }
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Where the card sits relative to the spotlight, given the space available. */
function placeCard(rect: Rect | null, cardHeight: number): { top: number; left: number } {
  const margin = 16;
  const cardWidth = 380;
  if (!rect) {
    return {
      top: Math.max(margin, window.innerHeight / 2 - cardHeight / 2),
      left: Math.max(margin, window.innerWidth / 2 - cardWidth / 2),
    };
  }
  // Below the target when there is room, above it when there is not. The card
  // is never allowed off-screen, which is the failure people actually hit on a
  // laptop with a short viewport.
  const below = rect.top + rect.height + margin;
  const above = rect.top - cardHeight - margin;
  const top = below + cardHeight < window.innerHeight - margin ? below : above > margin ? above : margin;
  const left = Math.min(
    Math.max(margin, rect.left),
    Math.max(margin, window.innerWidth - cardWidth - margin)
  );
  return { top, left };
}

export function Walkthrough({
  open,
  onClose,
  onFinish,
}: {
  open: boolean;
  onClose(): void;
  onFinish(): void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState(230);

  const step = STEPS[Math.min(index, STEPS.length - 1)];
  const isFirst = index === 0;
  const isLast = index === STEPS.length - 1;

  // Navigate first. The highlight measurement below then runs against the
  // screen the step is actually describing.
  useEffect(() => {
    if (!open) return;
    navigate(step.route);
  }, [open, step.route, navigate]);

  /**
   * Locate the highlighted element and keep the spotlight on it.
   *
   * Re-measured on scroll and resize because the page behind the overlay still
   * scrolls — the alternative, locking the body, means a target below the fold
   * can never be brought into view.
   */
  const measure = useCallback(() => {
    const node = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    if (!node) {
      setRect(null);
      return;
    }
    const box = node.getBoundingClientRect();
    setRect({ top: box.top, left: box.left, width: box.width, height: box.height });
  }, [step.target]);

  useEffect(() => {
    if (!open) return;
    // One frame of slack so the route's own render has committed before the
    // target is looked for; without it every step measures the previous screen.
    const raf = requestAnimationFrame(() => {
      measure();
      document
        .querySelector<HTMLElement>(`[data-tour="${step.target}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    // Data-driven screens finish loading after the first frame, so re-measure
    // shortly afterwards rather than pinning to a skeleton's height.
    const settle = window.setTimeout(measure, 700);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, step.target, measure]);

  useLayoutEffect(() => {
    if (cardRef.current) setCardHeight(cardRef.current.offsetHeight);
  }, [index, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") setIndex((i) => Math.min(STEPS.length - 1, i + 1));
      if (event.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const pad = 8;
  const card = placeCard(rect, cardHeight);

  return (
    <div className="walk" role="dialog" aria-modal="true" aria-label={t("walkthrough.title")}>
      {/*
        The dimming is four rectangles around the target rather than one panel
        with a CSS cut-out. A `box-shadow: 0 0 0 9999px` spotlight is the usual
        trick and it works, but it also swallows every click on the page — with
        four panels the highlighted element itself stays genuinely interactive,
        which is what makes this a walkthrough rather than a screenshot.
      */}
      {rect ? (
        <>
          <div className="walk__mask" style={{ top: 0, left: 0, right: 0, height: Math.max(0, rect.top - pad) }} />
          <div
            className="walk__mask"
            style={{ top: Math.max(0, rect.top - pad), left: 0, width: Math.max(0, rect.left - pad), height: rect.height + pad * 2 }}
          />
          <div
            className="walk__mask"
            style={{
              top: Math.max(0, rect.top - pad),
              left: rect.left + rect.width + pad,
              right: 0,
              height: rect.height + pad * 2,
            }}
          />
          <div className="walk__mask" style={{ top: rect.top + rect.height + pad, left: 0, right: 0, bottom: 0 }} />
          <div
            className="walk__ring"
            style={{
              top: rect.top - pad,
              left: rect.left - pad,
              width: rect.width + pad * 2,
              height: rect.height + pad * 2,
            }}
            aria-hidden="true"
          />
        </>
      ) : (
        // No target on this screen — dim everything and show the card centred
        // rather than silently skipping a step the patient paid attention to.
        <div className="walk__mask" style={{ inset: 0 }} />
      )}

      <div ref={cardRef} className="walk__card fade-in" style={{ top: card.top, left: card.left }}>
        <div className="row row--between row--top row--nowrap" style={{ marginBottom: "var(--s3)" }}>
          <div style={{ minWidth: 0 }}>
            <span className="label label--signal">
              {t("common.step", { current: index + 1, total: STEPS.length })}
            </span>
            <h3 style={{ fontSize: "var(--fs-h3)", marginTop: "var(--s1)", lineHeight: 1.25 }}>
              {t(`walkthrough.steps.${step.target}.title`)}
            </h3>
          </div>
          <button
            type="button"
            className="btn btn--sm btn--ghost btn--icon"
            onClick={onClose}
            aria-label={t("walkthrough.skip")}
          >
            <IconClose size={15} />
          </button>
        </div>

        <p style={{ fontSize: "var(--fs-small)", lineHeight: 1.6 }}>
          {t(`walkthrough.steps.${step.target}.body`)}
        </p>

        <div className="row row--between" style={{ marginTop: "var(--s5)" }}>
          <div className="tour__dots" aria-hidden="true">
            {STEPS.map((s, i) => (
              <span key={s.target} className={`tour__dot${i === index ? " tour__dot--on" : ""}`} />
            ))}
          </div>
          <div className="row row--tight">
            <button type="button" className="btn btn--sm btn--ghost" onClick={onClose}>
              {t("walkthrough.skip")}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={isFirst}
            >
              {t("common.back")}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => (isLast ? onFinish() : setIndex((i) => i + 1))}
            >
              {isLast ? (
                <>
                  <IconCheck size={14} />
                  {t("walkthrough.finish")}
                </>
              ) : (
                <>
                  {t("common.next")}
                  <IconArrowRight size={14} />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Walkthrough;
