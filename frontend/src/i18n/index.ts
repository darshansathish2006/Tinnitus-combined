/**
 * Internationalisation setup.
 *
 * One i18next instance, three bundled resource files, no network fetch. The
 * translations ship in the bundle rather than being loaded over HTTP because
 * this is a clinical tool that has to work on a hospital wifi that drops, and a
 * half-loaded language file means a screen of missing keys during an
 * assessment.
 *
 * **Storage order.** The active language is decided by, in order:
 *
 *   1. the signed-in user's saved profile preference (applied on login/hydrate),
 *   2. `echosense.locale` in localStorage — which is how a language chosen on
 *      the login screen, before there is any account to save it to, survives,
 *   3. the browser's own `navigator.language`,
 *   4. English.
 *
 * The localStorage key is deliberately *not* the zustand-persisted session blob.
 * The language has to be readable before the session store hydrates, because the
 * login page renders first and must already be in the right language.
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import { DEFAULT_LANGUAGE, LANGUAGES, SUPPORTED_CODES, languageOf, resolveLanguage } from "./languages";

// -- resource bundles. One import per entry in LANGUAGES. -------------------- //
import en from "./en.json";
import ta from "./ta.json";
import hi from "./hi.json";

export const LOCALE_STORAGE_KEY = "echosense.locale";

const resources = {
  en: { translation: en },
  ta: { translation: ta },
  hi: { translation: hi },
} as const;

/** Read the pre-login preference. Safe in private mode, where storage throws. */
export function readStoredLocale(): string | null {
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredLocale(locale: string): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* private mode — the choice still applies for this visit */
  }
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: SUPPORTED_CODES,
    // "ta-IN" from the browser should load "ta", not fall through to English.
    load: "languageOnly",
    nonExplicitSupportedLngs: true,
    interpolation: {
      // React escapes for us; double-escaping turns an apostrophe into &#39;.
      escapeValue: false,
    },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: LOCALE_STORAGE_KEY,
      // Writing is done by `setLanguage` so the profile sync and the storage
      // write stay in one place rather than happening in two.
      caches: [],
    },
    react: {
      // Everything is bundled, so there is nothing to suspend on, and a Suspense
      // boundary here would blank the shell on every language change.
      useSuspense: false,
    },
  });

/**
 * Reflect the active language onto the document.
 *
 * `lang` matters for screen readers picking a voice and for the browser's own
 * hyphenation; `dir` is set from the registry so a right-to-left language added
 * later works without touching this file.
 */
function applyDocumentLanguage(code: string): void {
  const language = languageOf(code);
  const root = document.documentElement;
  root.setAttribute("lang", language.code);
  root.setAttribute("dir", language.dir);
}

applyDocumentLanguage(i18n.language ?? DEFAULT_LANGUAGE);
i18n.on("languageChanged", applyDocumentLanguage);

/**
 * Switch language.
 *
 * The single entry point — it changes i18next, writes the pre-login store, and
 * updates the document attributes. Callers that also need to persist to the
 * signed-in account go through `useSession().setLocale`, which calls this and
 * then patches the profile.
 */
export async function setLanguage(value: string): Promise<string> {
  const code = resolveLanguage(value);
  if (i18n.language !== code) await i18n.changeLanguage(code);
  writeStoredLocale(code);
  applyDocumentLanguage(code);
  return code;
}

/** The active language code, always one we ship. */
export function currentLanguage(): string {
  return resolveLanguage(i18n.language);
}

export { LANGUAGES, DEFAULT_LANGUAGE, resolveLanguage, languageOf };
export default i18n;
