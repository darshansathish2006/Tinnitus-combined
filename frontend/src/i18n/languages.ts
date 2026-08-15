/**
 * The language registry — the single place a language is declared.
 *
 * Adding a language is two edits and one file: drop `xx.json` next to this file,
 * add its entry here, and import it in `index.ts`. Nothing else in the
 * application names a locale, so nothing else has to change. The selector, the
 * `<html lang>` attribute, date and number formatting, and the backend
 * preference sync all read from this list.
 *
 * `intl` is deliberately separate from `code`. The translation files are keyed
 * by language ("ta"), but `Intl` needs a region to pick the right date order and
 * digit grouping ("ta-IN" gives 1,23,456 — the Indian lakh grouping — where a
 * bare "ta" does not reliably). English is `en-GB` because the source copy is
 * British: "anonymised", "programme", day-before-month.
 */

export interface Language {
  /** Translation-file key and the value stored on the user's profile. */
  code: string;
  /** English name, for accessibility labels and clinician-facing lists. */
  name: string;
  /** The name as written by its own speakers — what the selector shows. */
  native: string;
  /** BCP 47 tag handed to `Intl.*` for dates, times and numbers. */
  intl: string;
  /** Writing direction. All three current languages are left-to-right. */
  dir: "ltr" | "rtl";
}

export const LANGUAGES: Language[] = [
  { code: "en", name: "English", native: "English", intl: "en-GB", dir: "ltr" },
  { code: "ta", name: "Tamil", native: "தமிழ்", intl: "ta-IN", dir: "ltr" },
  { code: "hi", name: "Hindi", native: "हिन्दी", intl: "hi-IN", dir: "ltr" },
];

export const DEFAULT_LANGUAGE = "en";

export const SUPPORTED_CODES: string[] = LANGUAGES.map((l) => l.code);

/**
 * Resolve anything that claims to be a language into one we actually ship.
 *
 * Tolerant on purpose: the value can arrive from a stale localStorage entry, a
 * `navigator.language` of "ta-IN", or a user profile seeded with a language the
 * frontend has not been translated into yet (the demo cohort contains `te`,
 * `es` and `fr` speakers). None of those should leave the UI blank — they fall
 * back to English, which is always complete.
 */
export function resolveLanguage(value: string | null | undefined): string {
  if (!value) return DEFAULT_LANGUAGE;
  const normalised = value.toLowerCase().replace("_", "-");
  const exact = SUPPORTED_CODES.find((code) => code === normalised);
  if (exact) return exact;
  // "ta-IN" → "ta"
  const base = normalised.split("-")[0];
  return SUPPORTED_CODES.find((code) => code === base) ?? DEFAULT_LANGUAGE;
}

export function languageOf(code: string): Language {
  return LANGUAGES.find((l) => l.code === resolveLanguage(code)) ?? LANGUAGES[0];
}
