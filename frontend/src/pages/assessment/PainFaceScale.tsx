/**
 * The 0–10 pain faces scale, as an animated control.
 *
 * This is the printed Visual Analogue pain scale — the ruler from 0 to 10, the
 * row of drawn faces beneath it, the verbal scale, and the correlation between
 * the two — asked once, as its own question, after the four tinnitus VAS
 * scales have been answered. It is *not* a fifth tinnitus VAS: it rates pain,
 * and it is stored and scored on its own (see `clinical.instruments.PAIN_VAS`
 * and the `vas_pain` column), exactly the way the PHQ-9's functional-difficulty
 * item is kept out of that instrument's 0–27 total.
 *
 * **Why the face is drawn rather than an emoji.** The printed scale's faces are
 * a continuum, and the patient's answer is a point on it — so the face here is
 * one SVG whose eyes, brows and mouth are computed from the current rating and
 * move through every position between the two the patient is choosing between.
 * A row of six fixed emoji can only cut between six states; a drawn face can
 * show 6.5, and can *travel* from 2 to 8 when a distant number is clicked, which
 * is the part that tells the patient the control understood them.
 *
 * Three things move, and they are deliberately separated:
 *
 *  - **The morph** — geometry interpolated from the rating, eased frame by
 *    frame in `useEasedValue`, so clicking a number animates there rather than
 *    snapping, and dragging across the rail is continuous.
 *  - **The band colour** — a CSS transition on `fill`/`stroke`, so crossing
 *    from moderate to severe cross-fades rather than cutting.
 *  - **The idle motion** — per band, on its own element and restarted only when
 *    the band actually changes (React keys the wrapper on the band name, the
 *    same trick the Mood Radar face uses), so moving within one band does not
 *    re-fire the pop on every step.
 *
 * Everything here degrades to a still, fully readable, fully answerable scale
 * under `prefers-reduced-motion` — the face, the colours and the numbers are
 * the information, and only the movement is the effect.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { anchorLabel, type PainScaleBand, type PainScaleSpec } from "./Questionnaires";

/* ------------------------------------------------------------------------- */
/* Motion helpers                                                             */
/* ------------------------------------------------------------------------- */

/** Live `prefers-reduced-motion`, re-read when the OS setting changes. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * Eases a number toward `target` on animation frames.
 *
 * An exponential approach rather than a fixed-duration tween: it has no end to
 * be interrupted, so a second click mid-flight simply re-aims the same motion
 * instead of restarting a tween from wherever it had got to. `dt` is clamped so
 * a backgrounded tab does not resume with one enormous step.
 */
function useEasedValue(target: number, animate: boolean): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);

  useEffect(() => {
    if (!animate) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      const gap = target - shownRef.current;
      if (Math.abs(gap) < 0.01) {
        shownRef.current = target;
        setShown(target);
        return;
      }
      // ~90 ms time constant: about 250 ms to cover the visible distance.
      shownRef.current += gap * (1 - Math.exp(-dt / 90));
      setShown(shownRef.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, animate]);

  return shown;
}

/* ------------------------------------------------------------------------- */
/* The face                                                                   */
/* ------------------------------------------------------------------------- */

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * The band a rating falls in, read from the server's own bands so the face,
 * the highlighted verbal step and the clinician's report can never disagree
 * about where "moderate" ends.
 */
export function bandFor(bands: PainScaleBand[], value: number): PainScaleBand {
  const rounded = Math.round(value);
  return bands.find((b) => rounded >= b.min && rounded <= b.max) ?? bands[bands.length - 1];
}

export function bandLabel(t: TFunction, band: PainScaleBand): string {
  return t(`instruments.painBands.${band.key}`, { defaultValue: band.label });
}

export function bandImpact(t: TFunction, band: PainScaleBand): string {
  return t(`instruments.painImpact.${band.key}`, { defaultValue: band.impact });
}

/**
 * One face, drawn for one rating.
 *
 * Pure geometry — no state, no animation of its own — so the same component
 * draws the big reacting face at a fractional, mid-morph value and the six
 * small fixed faces of the printed scale's face row.
 */
export function PainFace({ value, size = 132 }: { value: number; size?: number }) {
  const p = clamp01(value / 10);

  // Eyes narrow and the pupils shrink and drift upward as pain rises — the
  // squint of someone bracing, not a different face swapped in.
  const eyeRx = 8.5 - 2 * p;
  const eyeRy = 8.5 - 5 * p;
  const pupilR = 3.6 - 0.9 * p;
  const pupilY = 50 - 2 * p;

  // At the top of the range the eyes stop being narrowed and are squeezed
  // shut, cross-fading from the open eye to a wince. This is the line between
  // hurting and angry on a face this simple: a furrowed brow over a narrowed,
  // still-open eye reads as a glare, and the same brow over a shut one reads
  // as someone bracing against something.
  const wince = clamp01((p - 0.58) / 0.2);
  const eyeOpen = 1 - wince;

  // Brows appear only once there is something to be braced against, and their
  // inner ends drop into a furrow as it worsens. They keep clear of the eye at
  // the top of the range on purpose: a brow resting on a narrowed eye reads as
  // anger, and the difference between anger and pain on a face this simple is
  // mostly that gap.
  const browOpacity = clamp01((p - 0.3) / 0.3);
  const browOuterY = 32 + 2 * p;
  const browInnerY = 29 + 12 * p;

  // One quadratic: control point above the ends is a smile, level is a
  // straight line, below is a frown. 5 on this scale is exactly the flat mouth
  // the printed scale draws.
  const mouthControlY = 78 + 22 - 44 * p;
  const mouthWidth = 3 + 2 * p;

  // Tears are the printed scale's own top-of-range face, so they arrive at the
  // top of the range and not before.
  const tearOpacity = clamp01((p - 0.7) / 0.2);

  return (
    <svg
      className="painface"
      viewBox="0 0 120 120"
      width={size}
      height={size}
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="painface__head" cx="60" cy="58" r="46" />

      <g className="painface__ink">
        <g opacity={browOpacity} strokeWidth={2.6}>
          <path d={`M 32 ${browOuterY} L 54 ${browInnerY}`} />
          <path d={`M 88 ${browOuterY} L 66 ${browInnerY}`} />
        </g>

        <g opacity={eyeOpen}>
          <ellipse cx="44" cy="50" rx={eyeRx} ry={eyeRy} fill="none" />
          <ellipse cx="76" cy="50" rx={eyeRx} ry={eyeRy} fill="none" />
          <circle className="painface__pupil" cx="44" cy={pupilY} r={pupilR} />
          <circle className="painface__pupil" cx="76" cy={pupilY} r={pupilR} />
        </g>
        <g opacity={wince}>
          <path d="M 36 52 Q 44 45 52 52" fill="none" />
          <path d="M 68 52 Q 76 45 84 52" fill="none" />
        </g>

        <path
          d={`M 40 78 Q 60 ${mouthControlY} 80 78`}
          fill="none"
          strokeWidth={mouthWidth}
          strokeLinecap="round"
        />
      </g>

      {/* Two drops, offset in time so they do not fall as a pair. */}
      <g className="painface__tears" opacity={tearOpacity}>
        <path className="painface__tear" d="M 38 60 q -4 7 -4 10 a 4 4 0 0 0 8 0 q 0 -3 -4 -10 z" />
        <path
          className="painface__tear painface__tear--right"
          d="M 82 60 q -4 7 -4 10 a 4 4 0 0 0 8 0 q 0 -3 -4 -10 z"
        />
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------------------- */
/* The scale                                                                  */
/* ------------------------------------------------------------------------- */

export default function PainFaceScale({
  spec,
  value,
  onChange,
  disabled,
}: {
  spec: PainScaleSpec;
  /** The rating, or `undefined` while unanswered — never defaulted to 0, since
   *  0 ("no pain") is itself a real answer and must not be recorded by
   *  someone simply walking past the question. */
  value: number | undefined;
  onChange(value: number): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const reduced = usePrefersReducedMotion();
  const answered = value !== undefined;
  const shown = useEasedValue(value ?? 0, !reduced);
  const band = bandFor(spec.bands, answered ? shown : 0);

  const ticks: number[] = [];
  for (let n = spec.min; n <= spec.max; n += spec.step) ticks.push(Number(n.toFixed(2)));

  const label = bandLabel(t, band);

  return (
    <div className={`painscale${answered ? "" : " painscale--unset"}`}>
      {/* -- the reacting face --------------------------------------------- */}
      <div className={`painscale__stage painscale__stage--${band.key}`}>
        {/* Keyed on the band so the pop replays when the band changes and
            stays out of the way while the patient moves within one. */}
        <div key={band.key} className="painscale__facewrap">
          <PainFace value={answered ? shown : 0} />
        </div>

        <div className="painscale__reading">
          {answered ? (
            <>
              <div className="painscale__number">
                <strong>{Math.round(shown)}</strong>
                <span>/ {spec.max}</span>
              </div>
              <span className="painscale__band">{label}</span>
              <p className="painscale__impact">{bandImpact(t, band)}</p>
            </>
          ) : (
            <>
              <div className="painscale__number painscale__number--empty">
                <strong>—</strong>
              </div>
              <span className="painscale__band">
                {t("assessment.module2.painUnanswered", { defaultValue: "Not answered yet" })}
              </span>
              <p className="painscale__impact">
                {t("assessment.module2.painHelp", {
                  defaultValue: spec.help ?? "Choose the face and the number that match how you feel.",
                })}
              </p>
            </>
          )}
        </div>
      </div>

      <span className="sr-only" aria-live="polite">
        {answered
          ? t("assessment.module2.painAnnounce", {
              value: Math.round(shown),
              max: spec.max,
              band: label,
              defaultValue: `${Math.round(shown)} out of ${spec.max} — ${label}`,
            })
          : ""}
      </span>

      {/* -- the ruler ------------------------------------------------------ */}
      <div className="painscale__anchors">
        <span>{anchorLabel(t, spec.low, "0")}</span>
        {spec.mid && <span>{anchorLabel(t, spec.mid, "")}</span>}
        <span>{anchorLabel(t, spec.high, String(spec.max))}</span>
      </div>

      <div
        className="painscale__rule"
        role="radiogroup"
        aria-label={t("assessment.module2.painRuleLabel", {
          defaultValue: "Pain rating from 0 to 10",
        })}
      >
        {ticks.map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            className="painscale__tick"
            aria-checked={value === n}
            disabled={disabled}
            onClick={() => onChange(n)}
          >
            <span className="painscale__tickmark" aria-hidden="true" />
            <span className="painscale__ticknum">{n}</span>
          </button>
        ))}
      </div>

      {/* -- the printed scale's face row, also the primary way to answer --- */}
      <div className="painscale__faces">
        {spec.face_values.map((n) => {
          const faceBand = bandFor(spec.bands, n);
          return (
            <button
              key={n}
              type="button"
              className={`painscale__facebtn painscale__facebtn--${faceBand.key}`}
              aria-pressed={value === n}
              aria-label={t("assessment.module2.painFaceOption", {
                value: n,
                band: bandLabel(t, faceBand),
                defaultValue: `${n} — ${bandLabel(t, faceBand)}`,
              })}
              disabled={disabled}
              onClick={() => onChange(n)}
            >
              <PainFace value={n} size={62} />
              <span className="painscale__facenum">{n}</span>
            </button>
          );
        })}
      </div>

      {/* -- verbal scale, with the step the current rating falls in lit ---- */}
      <div className="painscale__verbal">
        {spec.bands.map((b) => (
          <span
            key={b.key}
            className="painscale__verbalstep"
            data-active={answered && b.key === band.key ? "true" : "false"}
          >
            {bandLabel(t, b)}
          </span>
        ))}
      </div>
    </div>
  );
}
