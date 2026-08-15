/**
 * Locale-aware formatting.
 *
 * These back the `fmt` helpers exported from `components/ui`, so every date,
 * time and number in the application follows the selected language without a
 * single call site changing. The locale is read from i18next *at call time*
 * rather than captured, because a language switch has to reformat the screen
 * that is already rendered — no reload, no remount.
 *
 * **What is not localised, and why.** Physical units keep Latin digits and their
 * SI symbols: "45 dB HL", "6.3 kHz", "ESA-2026-00007". A clinician reading an
 * audiogram in Tamil still reads decibels in the notation the instrument, the
 * literature and the printed report use, and a translated unit symbol would make
 * the number less legible, not more. Only the *labels* around them translate.
 */

import i18n from "./index";
import { languageOf } from "./languages";

/** The BCP 47 tag for the active language, e.g. "ta-IN". */
export function intlLocale(): string {
  return languageOf(i18n.language).intl;
}

/**
 * `Intl` object caches.
 *
 * A new `Intl.DateTimeFormat` costs real time and these run inside table rows
 * and chart axes. Keyed by locale plus options so a language change gets fresh
 * formatters rather than stale ones.
 */
const dateCache = new Map<string, Intl.DateTimeFormat>();
const numberCache = new Map<string, Intl.NumberFormat>();

function dateFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = intlLocale();
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = dateCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    dateCache.set(key, formatter);
  }
  return formatter;
}

function numberFormatter(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const locale = intlLocale();
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = numberCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    numberCache.set(key, formatter);
  }
  return formatter;
}

/** Parse an API timestamp, returning null rather than an Invalid Date. */
function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const EM_DASH = "—";

export function formatDate(value: string | null | undefined): string {
  const date = parse(value);
  if (!date) return EM_DASH;
  return dateFormatter({ day: "2-digit", month: "short", year: "numeric" }).format(date);
}

export function formatDateTime(value: string | null | undefined): string {
  const date = parse(value);
  if (!date) return EM_DASH;
  return dateFormatter({
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatTime(value: string | null | undefined): string {
  const date = parse(value);
  if (!date) return EM_DASH;
  return dateFormatter({ hour: "2-digit", minute: "2-digit" }).format(date);
}

export function formatWeekday(value: string | null | undefined, long = false): string {
  const date = parse(value);
  if (!date) return EM_DASH;
  return dateFormatter({ weekday: long ? "long" : "short" }).format(date);
}

/** Day and month only — used on calendars and slot pickers. */
export function formatDayMonth(value: string | null | undefined): string {
  const date = parse(value);
  if (!date) return EM_DASH;
  return dateFormatter({ day: "numeric", month: "short" }).format(date);
}

/**
 * "3 days ago", "in 2 months" — through `Intl.RelativeTimeFormat`, so the
 * phrasing and pluralisation are the platform's job rather than ours.
 *
 * Same-day, previous-day and next-day get the `numeric: "auto"` treatment,
 * which yields "today" / "yesterday" / "tomorrow" in every locale that has
 * words for them.
 */
export function formatRelativeDays(value: string | null | undefined): string {
  const date = parse(value);
  if (!date) return i18n.t("common.never");

  const days = Math.round((date.getTime() - Date.now()) / 86_400_000);
  const relative = new Intl.RelativeTimeFormat(intlLocale(), { numeric: "auto" });

  const magnitude = Math.abs(days);
  if (magnitude < 30) return relative.format(days, "day");
  if (magnitude < 365) return relative.format(Math.round(days / 30), "month");
  return relative.format(Math.round(days / 365), "year");
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return numberFormatter(options).format(value);
}

export function formatDecimal(value: number, digits = 1): string {
  return numberFormatter({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

export function formatInteger(value: number): string {
  return numberFormatter({ maximumFractionDigits: 0 }).format(value);
}

export function formatPercent(fraction: number, digits = 0): string {
  return numberFormatter({
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(fraction);
}

/**
 * A duration in minutes as "45 min" or "1 h 20 m", in the active language.
 *
 * Built from translated unit strings rather than `Intl.DurationFormat`, which
 * is too new to rely on in the browsers a hospital desktop actually runs.
 */
export function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return i18n.t("units.minutesShort", { count: Math.round(minutes) });
  }
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest
    ? i18n.t("units.hoursMinutesShort", { hours, minutes: rest })
    : i18n.t("units.hoursShort", { count: hours });
}

/** A span in months, switching to years past two — "18 mo", "3.5 yr". */
export function formatMonths(value: number): string {
  return value >= 24
    ? i18n.t("units.yearsShort", { value: formatDecimal(value / 12, 1) })
    : i18n.t("units.monthsShort", { value: formatInteger(value) });
}
