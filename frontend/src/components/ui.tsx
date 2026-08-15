/**
 * The component kit for the "Clinical Instrument" design language.
 *
 * Deliberately small and unopinionated: these are thin, typed wrappers over the
 * CSS in `styles/app.css` rather than a component framework. The visual language
 * lives in the stylesheet so it stays consistent, and these exist to stop the
 * same class strings being retyped (and drifting) across twenty screens.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useSession, type Theme } from "../state/session";
import {
  EM_DASH,
  formatDate,
  formatDateTime,
  formatDayMonth,
  formatDecimal,
  formatDuration,
  formatInteger,
  formatMonths,
  formatPercent,
  formatRelativeDays,
  formatTime,
  formatWeekday,
} from "../i18n/format";
import { IconCheck, IconChevronRight, IconClose, IconMoon, IconSun } from "./icons";

/* ------------------------------------------------------------------------- */
/* Brand                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * The mark: a vermilion tile carrying an "E" whose three arms step shorter as
 * they descend — a letterform and a decaying echo in the same figure, which is
 * the product in one glyph.
 *
 * Three constraints drove it, and they are the reason it is built this way:
 *
 *  - **One colour on one tile.** Only two fills, and the glyph ink is a fixed
 *    near-black rather than `var(--ink)`. The tile is always vermilion in both
 *    themes, so a *themed* glyph would invert to bone on orange and lose its
 *    contrast; a fixed dark ink holds against both `--signal` values (5.7:1 in
 *    light, 7.9:1 in dark) and survives one-colour printing.
 *  - **Legible at 18 px.** Bars, not strokes — the old waveform's 2.6 px path
 *    collapsed into a smudge in the collapsed mobile rail.
 *  - **No asset.** Inline SVG, so there is nothing to load, nothing to cache and
 *    nothing to go missing offline.
 */
const MARK_INK = "#17171b";

export function BrandMark({ size = 34, title }: { size?: number; title?: string }) {
  return (
    <svg
      className="brand__mark"
      width={size}
      height={size}
      viewBox="0 0 36 36"
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      <rect x="0" y="0" width="36" height="36" rx="4" fill="var(--signal)" />
      {/* stem */}
      <rect x="7" y="8" width="3.6" height="20" fill={MARK_INK} />
      {/* three arms, stepping shorter — the echo losing energy */}
      <rect x="10.6" y="8" width="19" height="3.6" fill={MARK_INK} />
      <rect x="10.6" y="16.2" width="13" height="3.6" fill={MARK_INK} />
      <rect x="10.6" y="24.4" width="7" height="3.6" fill={MARK_INK} />
    </svg>
  );
}

/**
 * The wordmark. `subtitle` is passed in already translated by the caller —
 * "EchoSense" itself is a proper noun and stays in Latin script in every
 * language, because a transliterated product name is not the product name.
 */
export function Brand({
  subtitle,
  size = 34,
  large = false,
}: {
  subtitle?: string | null;
  size?: number;
  large?: boolean;
}) {
  return (
    <span className={`brand${large ? " brand--lg" : ""}`}>
      <BrandMark size={large ? 46 : size} title="EchoSense" />
      <span className="brand__text">
        <span className="brand__name">EchoSense</span>
        {subtitle && <span className="brand__sub">{subtitle}</span>}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------------- */
/* Panel                                                                      */
/* ------------------------------------------------------------------------- */
type Tone = "default" | "signal" | "ok" | "warn" | "crit" | "info" | "sunken";

export function Panel({
  children,
  title,
  aside,
  tone = "default",
  bracketed = false,
  flush = false,
  tight = false,
  className = "",
  style,
  headPlain = false,
  id,
}: {
  children?: ReactNode;
  title?: ReactNode;
  aside?: ReactNode;
  tone?: Tone;
  bracketed?: boolean;
  flush?: boolean;
  tight?: boolean;
  className?: string;
  style?: CSSProperties;
  headPlain?: boolean;
  id?: string;
}) {
  const toneClass = tone === "default" ? "" : ` panel--${tone}`;
  return (
    <section
      id={id}
      className={`panel${toneClass}${bracketed ? " panel--bracketed" : ""}${flush ? " panel--flush" : ""}${tight ? " panel--tight" : ""} ${className}`}
      style={style}
    >
      {(title || aside) && (
        <header className={`panel__head${headPlain ? " panel__head--plain" : ""}`}>
          {typeof title === "string" ? <h3 className="panel__title">{title}</h3> : title}
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------------- */
/* Readout                                                                    */
/* ------------------------------------------------------------------------- */
export function Readout({
  label,
  value,
  unit,
  note,
  size = "md",
  tone,
  title,
}: {
  label?: string;
  value: ReactNode;
  unit?: string;
  note?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  tone?: "signal" | "data" | "ok" | "warn" | "crit";
  title?: string;
}) {
  const empty = value === null || value === undefined || value === "" || value === "—";
  const sizeClass = size === "xl" ? "readout--lg" : size === "sm" ? "readout--sm" : size === "md" ? "readout--md" : "";
  return (
    <div
      className={`readout ${sizeClass}${tone && !empty ? ` readout--${tone}` : ""}${empty ? " readout--empty" : ""}`}
      title={title}
    >
      {label && <span className="label">{label}</span>}
      <span className="readout__value">
        {empty ? "—" : value}
        {unit && !empty && <span className="readout__unit">{unit}</span>}
      </span>
      {note && <span className="readout__note">{note}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Chip                                                                       */
/* ------------------------------------------------------------------------- */
export function Chip({
  children,
  tone,
  dot = false,
  live = false,
  title,
}: {
  children: ReactNode;
  tone?: "signal" | "data" | "ok" | "warn" | "crit" | "info" | "ghost" | "solid";
  dot?: boolean;
  live?: boolean;
  title?: string;
}) {
  return (
    <span className={`chip${tone ? ` chip--${tone}` : ""}`} title={title}>
      {(dot || live) && <span className={`dot${live ? " dot--live" : ""}`} />}
      {children}
    </span>
  );
}

const URGENCY_TONE: Record<string, "crit" | "warn" | "info" | "ok"> = {
  emergency: "crit",
  urgent: "crit",
  soon: "warn",
  routine: "ok",
};

export function UrgencyChip({ urgency }: { urgency: string }) {
  const { t } = useTranslation();
  return (
    <Chip tone={URGENCY_TONE[urgency] ?? "ghost"} dot>
      {/* Falls through to the raw token if the API introduces an urgency this
          client has no translation for — an untranslated word beats a blank
          chip on a screen whose whole job is conveying urgency. */}
      {t(`urgency.${urgency}`, { defaultValue: urgency })}
    </Chip>
  );
}

/* ------------------------------------------------------------------------- */
/* Meters                                                                     */
/* ------------------------------------------------------------------------- */
export function Meter({
  value,
  max = 100,
  tone,
  tall = false,
  label,
}: {
  value: number;
  max?: number;
  tone?: "data" | "ok" | "warn" | "crit";
  tall?: boolean;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      className={`meter${tall ? " meter--tall" : ""}`}
      role="meter"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
    >
      <div className={`meter__fill${tone ? ` meter__fill--${tone}` : ""}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Segmented LED bargraph. Reads as an instrument, not a progress bar. */
export function SegMeter({
  value,
  max = 100,
  segments = 20,
  tone,
  label,
}: {
  value: number;
  max?: number;
  segments?: number;
  tone?: "ok" | "warn" | "crit";
  label?: string;
}) {
  const filled = Math.round((Math.max(0, Math.min(max, value)) / max) * segments);
  return (
    <div className="segmeter" role="meter" aria-valuenow={value} aria-valuemax={max} aria-label={label}>
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className={`segmeter__seg${i < filled ? (tone ? ` segmeter__seg--on-${tone}` : " segmeter__seg--on") : ""}`}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Form controls                                                              */
/* ------------------------------------------------------------------------- */
export function Field({
  label,
  hint,
  children,
  error,
}: {
  label?: string;
  hint?: ReactNode;
  children: ReactNode;
  error?: string | null;
}) {
  return (
    <label className="field">
      {label && <span className="label">{label}</span>}
      {children}
      {error ? <span className="meta" style={{ color: "var(--crit-ink)" }}>{error}</span> : hint ? <span className="meta">{hint}</span> : null}
    </label>
  );
}

/**
 * The instrument fader. Shows its own value as a monospace readout because a
 * slider with no numeric display is unusable for anything clinical.
 */
export function Fader({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  unit,
  lowLabel,
  highLabel,
  disabled,
  tone = "signal",
  format,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange(value: number): void;
  label?: string;
  unit?: string;
  lowLabel?: string;
  highLabel?: string;
  disabled?: boolean;
  tone?: "signal" | "data";
  format?(value: number): string;
}) {
  const id = useId();
  return (
    <div className="stack stack-1">
      {(label || unit) && (
        <div className="row row--between row--baseline">
          {label && (
            <label className="label" htmlFor={id}>
              {label}
            </label>
          )}
          <span className="mono" style={{ fontSize: "var(--fs-small)", fontWeight: 600 }}>
            {format ? format(value) : value}
            {unit ? <span className="dim"> {unit}</span> : null}
          </span>
        </div>
      )}
      <input
        id={id}
        className={`fader${tone === "data" ? " fader--data" : ""}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {(lowLabel || highLabel) && (
        <div className="fader-scale">
          <span>{lowLabel}</span>
          <span>{highLabel}</span>
        </div>
      )}
    </div>
  );
}

export function OptionGroup<T extends string | number>({
  options,
  value,
  onChange,
  columns = 1,
  showKeys = false,
}: {
  options: { value: T; label: string; help?: string }[];
  value: T | null | undefined;
  onChange(value: T): void;
  columns?: number;
  showKeys?: boolean;
}) {
  return (
    <div
      className="grid"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: "var(--s2)" }}
      role="group"
    >
      {options.map((option, index) => (
        <button
          key={String(option.value)}
          type="button"
          className="option"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {showKeys && <span className="option__key">{index + 1}</span>}
          <span style={{ minWidth: 0 }}>
            <span style={{ display: "block" }}>{option.label}</span>
            {option.help && (
              <span className="meta" style={{ display: "block" }}>
                {option.help}
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Step rail                                                                  */
/* ------------------------------------------------------------------------- */
export function StepRail({
  steps,
  current,
  onJump,
  completed,
}: {
  steps: { key: string; label: string }[];
  current: number;
  onJump?(index: number): void;
  completed: Set<string>;
}) {
  const { t } = useTranslation();
  return (
    <nav className="steprail" aria-label={t("assessment.progressLabel")}>
      {steps.map((step, index) => {
        const state = index === current ? "active" : completed.has(step.key) ? "done" : "todo";
        const reachable = index <= current || completed.has(step.key);
        return (
          <button
            key={step.key}
            type="button"
            className="steprail__step"
            data-state={state}
            disabled={!onJump || !reachable}
            onClick={() => onJump?.(index)}
            aria-current={index === current ? "step" : undefined}
          >
            <span className="steprail__n">
              {String(index + 1).padStart(2, "0")}
              {state === "done" && <IconCheck size={11} />}
            </span>
            <span className="steprail__label">{step.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/* ------------------------------------------------------------------------- */
/* States                                                                     */
/* ------------------------------------------------------------------------- */
export function Loading({ label, rows = 3 }: { label?: string; rows?: number }) {
  const { t } = useTranslation();
  return (
    <div className="stack stack-2" aria-busy="true" aria-live="polite">
      <span className="label">{label ?? t("common.loading")}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 14, width: `${100 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="stack stack-3" style={{ padding: "var(--s8) var(--s4)", textAlign: "center" }}>
      <div className="tickrule" style={{ maxWidth: 200, margin: "0 auto" }} />
      <h4>{title}</h4>
      {body && <p className="meta" style={{ maxWidth: "48ch", margin: "0 auto" }}>{body}</p>}
      {action && <div className="row" style={{ justifyContent: "center" }}>{action}</div>}
    </div>
  );
}

/**
 * The failure surface for a whole screen.
 *
 * The heading and the retry affordance translate; the message underneath is
 * whatever the server said. Server `detail` strings are not translated by this
 * client — inventing a local paraphrase of a message the backend authored would
 * mean a patient and their clinician reading two different accounts of the same
 * failure. See the final report for how to make these translatable end to end.
 */
export function ErrorState({ error, retry }: { error: unknown; retry?(): void }) {
  const { t } = useTranslation();
  const message = error instanceof Error ? error.message : String(error);
  return (
    <Panel tone="crit" tight>
      <div className="stack stack-2">
        <span className="label" style={{ color: "var(--crit-ink)" }}>
          {t("errors.requestFailed")}
        </span>
        <p style={{ fontSize: "var(--fs-small)" }}>{message}</p>
        {retry && (
          <button type="button" className="btn btn--sm" onClick={retry}>
            {t("common.retry")}
          </button>
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------------- */
/* Modal                                                                      */
/* ------------------------------------------------------------------------- */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="overlay" onClick={onClose} role="presentation">
      <div
        className="modal fade-in"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row row--between" style={{ marginBottom: "var(--s4)" }}>
          <h3 className="panel__title">{title}</h3>
          <button type="button" className="btn btn--sm btn--ghost" onClick={onClose} aria-label={t("common.close")}>
            <IconClose size={15} />
          </button>
        </div>
        {children}
        {footer && (
          <>
            <hr className="rule" />
            <div className="row row--end">{footer}</div>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Toasts + theme                                                             */
/* ------------------------------------------------------------------------- */
export function ToastStack() {
  const toasts = useSession((s) => s.toasts);
  const dismiss = useSession((s) => s.dismissToast);
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast fade-in${toast.kind === "crit" ? " toast--crit" : toast.kind === "ok" ? " toast--ok" : ""}`}
          onClick={() => dismiss(toast.id)}
          role="presentation"
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}

export function ThemeToggle() {
  const { t } = useTranslation();
  const theme = useSession((s) => s.theme);
  const setTheme = useSession((s) => s.setTheme);
  // Dark is the product's default, so the toggle is a simple two-way switch
  // rather than a three-state cycle nobody can predict.
  const next: Theme = theme === "light" ? "dark" : "light";
  const label = t("theme.switchTo", { mode: t(`theme.${next}`) });
  return (
    <button
      type="button"
      className="btn btn--sm btn--ghost btn--icon"
      onClick={() => setTheme(next)}
      title={label}
      aria-label={label}
    >
      {theme === "light" ? <IconMoon size={17} /> : <IconSun size={17} />}
    </button>
  );
}

/* ------------------------------------------------------------------------- */
/* Disclosure                                                                 */
/* ------------------------------------------------------------------------- */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  count,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  count?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        className="row row--tight"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          background: "none",
          border: "none",
          padding: "var(--s1) 0",
          cursor: "pointer",
          width: "100%",
          textAlign: "left",
        }}
      >
        <IconChevronRight
          size={13}
          className="disclosure__chev"
          style={{ color: "var(--ink-3)", transform: open ? "rotate(90deg)" : undefined }}
        />
        <span className="label" style={{ display: "inline" }}>
          {summary}
        </span>
        {count !== undefined && <Chip tone="ghost">{count}</Chip>}
      </button>
      {open && <div className="fade-in" style={{ paddingTop: "var(--s2)" }}>{children}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Data hook                                                                  */
/* ------------------------------------------------------------------------- */
interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload(): void;
  setData(updater: T | ((prev: T | null) => T)): void;
}

/**
 * Minimal data-fetching hook. Guards against setting state after unmount and
 * exposes `reload` so mutations can refresh their view without a router trip.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    setError(null);
    fnRef
      .current()
      .then((result) => {
        if (alive.current) setData(result);
      })
      .catch((err) => {
        if (alive.current) setError(err);
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const update = useCallback(
    (updater: T | ((prev: T | null) => T)) =>
      setData((prev) => (typeof updater === "function" ? (updater as (p: T | null) => T)(prev) : updater)),
    []
  );

  return { data, error, loading, reload, setData: update };
}

/* ------------------------------------------------------------------------- */
/* Formatters                                                                 */
/* ------------------------------------------------------------------------- */
/**
 * The formatting surface, unchanged in shape and now locale-aware underneath.
 *
 * Every date, relative time and grouped number routes through `i18n/format`,
 * which reads the active language *at call time* — so a language switch
 * reformats the screen already on the glass without a reload and without a
 * single one of the several hundred `fmt.*` call sites changing.
 *
 * **Physical quantities deliberately stay in Latin digits and SI notation.**
 * `hz`, `db` and `signed` are instrument readings: "6.30k", "45", "+3.2". A
 * clinician reading an audiogram in Hindi still reads decibels the way the
 * literature, the printed report and the device itself write them, and the
 * chart axes they sit on are drawn to a fixed pixel budget that locale-grouped
 * digits would overflow. Only the labels around them translate.
 */
export const fmt = {
  hz(value: number | null | undefined): string {
    if (value === null || value === undefined) return EM_DASH;
    return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)}k` : String(Math.round(value));
  },
  hzFull(value: number | null | undefined): string {
    return value === null || value === undefined ? EM_DASH : `${Math.round(value)} Hz`;
  },
  db(value: number | null | undefined, digits = 0): string {
    return value === null || value === undefined ? EM_DASH : value.toFixed(digits);
  },
  pct(value: number | null | undefined, digits = 0): string {
    return value === null || value === undefined ? EM_DASH : formatPercent(value, digits);
  },
  pct100(value: number | null | undefined, digits = 0): string {
    return value === null || value === undefined ? EM_DASH : formatPercent(value / 100, digits);
  },
  num(value: number | null | undefined, digits = 1): string {
    return value === null || value === undefined ? EM_DASH : formatDecimal(value, digits);
  },
  int(value: number | null | undefined): string {
    return value === null || value === undefined ? EM_DASH : formatInteger(value);
  },
  date(value: string | null | undefined): string {
    return formatDate(value);
  },
  dateTime(value: string | null | undefined): string {
    return formatDateTime(value);
  },
  time(value: string | null | undefined): string {
    return formatTime(value);
  },
  weekday(value: string | null | undefined, long = false): string {
    return formatWeekday(value, long);
  },
  dayMonth(value: string | null | undefined): string {
    return formatDayMonth(value);
  },
  ago(value: string | null | undefined): string {
    return formatRelativeDays(value);
  },
  duration(minutes: number | null | undefined): string {
    return minutes === null || minutes === undefined ? EM_DASH : formatDuration(minutes);
  },
  months(value: number | null | undefined): string {
    return value === null || value === undefined ? EM_DASH : formatMonths(value);
  },
  /**
   * Humanise a backend enum ("no_show" → "No Show").
   *
   * A last-resort fallback only. Anything a patient reads should be looked up
   * by key in the translation files — this exists for diagnostic strings and
   * for enum values the API may add after this client shipped, where showing
   * the raw token is worse than showing an untranslated but legible word.
   */
  titleCase(value: string | null | undefined): string {
    if (!value) return EM_DASH;
    return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  },
  signed(value: number | null | undefined, digits = 1): string {
    if (value === null || value === undefined) return EM_DASH;
    return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
  },
};

/* ------------------------------------------------------------------------- */
/* Simple markdown (bold, bullets, paragraphs) for assistant replies          */
/* ------------------------------------------------------------------------- */
export function RichText({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        const isList = lines.every((l) => /^\s*[-*]\s+/.test(l) || /^\s*\d+\.\s+/.test(l));
        if (isList) {
          const ordered = /^\s*\d+\./.test(lines[0]);
          const Tag = ordered ? "ol" : "ul";
          return (
            <Tag key={i}>
              {lines.map((line, j) => (
                <li key={j}>{inline(line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""))}</li>
              ))}
            </Tag>
          );
        }
        return <p key={i}>{inline(block)}</p>;
      })}
    </>
  );
}

function inline(text: string): ReactNode[] {
  // Only bold is supported. Assistant replies are authored in this repo, so the
  // set of markup that can appear is known and bounded.
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

/* ------------------------------------------------------------------------- */
/* Keyboard shortcut context (used by the assessment flow)                    */
/* ------------------------------------------------------------------------- */
const HotkeyContext = createContext<(key: string, handler: () => void, label?: string) => () => void>(
  () => () => {}
);

export function HotkeyProvider({ children }: { children: ReactNode }) {
  const handlers = useRef(new Map<string, { handler: () => void; label?: string }>());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const entry = handlers.current.get(e.key.toLowerCase());
      if (entry) {
        e.preventDefault();
        entry.handler();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const register = useCallback((key: string, handler: () => void, label?: string) => {
    const k = key.toLowerCase();
    handlers.current.set(k, { handler, label });
    return () => {
      handlers.current.delete(k);
    };
  }, []);

  return <HotkeyContext.Provider value={register}>{children}</HotkeyContext.Provider>;
}

export function useHotkey(key: string, handler: () => void, label?: string, enabled = true): void {
  const register = useContext(HotkeyContext);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    return register(key, () => ref.current(), label);
  }, [key, label, enabled, register]);
}

/**
 * A keycap.
 *
 * `children` is optional because this is also used as a `<Trans>` component
 * placeholder — there the element is written with no children and react-i18next
 * substitutes the text from the translation file at render time.
 */
export function Kbd({ children }: { children?: ReactNode }) {
  return (
    <kbd
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-micro)",
        border: "1px solid var(--line-strong)",
        borderRadius: "var(--radius)",
        padding: "1px 5px",
        background: "var(--paper-sunken)",
        color: "var(--ink-3)",
      }}
    >
      {children}
    </kbd>
  );
}
