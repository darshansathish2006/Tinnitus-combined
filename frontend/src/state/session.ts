/**
 * Session and app-level state.
 *
 * Persisted to localStorage so a page reload mid-assessment does not log the
 * patient out — losing a half-finished audiogram to a refresh is the kind of
 * thing that makes people abandon a clinical tool entirely.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, ApiError, onAuthFailure, setActingPatient, setToken, type PatientProfile, type Session } from "../api/client";
import { engine, type Transducer } from "../audio/engine";
import i18n, { readStoredLocale, setLanguage, writeStoredLocale } from "../i18n";
import { resolveLanguage } from "../i18n/languages";

/**
 * Push a stored headphone calibration into the audio engine.
 *
 * The engine's calibration lives in memory only, so before this it was empty on
 * every page except the one that had just performed the calibration. That is why
 * the therapy player ignored the prescribed sensation level and fell back to a
 * fixed conservative level: `engine.calibration.calibratedAt` was always null
 * outside the assessment flow. Restoring it from the patient's saved device
 * profile makes the prescribed dB SL actually reachable everywhere.
 */
export function applySavedCalibration(profile: PatientProfile | null): boolean {
  const saved = profile?.saved_device_profile;
  if (!saved) return false;
  // `output_gain_db` is the digital dBFS the 1 kHz reference tone sat at when it
  // was levelled — the same field name Assessment.reuseCalibration() reads.
  const referenceDbfs = Number(saved.output_gain_db);
  if (!Number.isFinite(referenceDbfs)) return false;

  engine.setCalibration({
    transducer: (saved.transducer as Transducer) ?? "unknown",
    referenceDbfs,
    referenceSplDb: Number(saved.reference_spl_db) || 65,
    ambientNoiseDb: Number.isFinite(Number(saved.ambient_noise_db))
      ? Number(saved.ambient_noise_db)
      : null,
    calibratedAt: String(saved.calibrated_at ?? new Date().toISOString()),
  });
  return true;
}

export type Theme = "light" | "dark" | "system";

/* ------------------------------------------------------------------------- */
/* Language preference                                                        */
/* ------------------------------------------------------------------------- */
/**
 * Whether the language currently in localStorage was *chosen*, or merely
 * detected from the browser.
 *
 * This flag is the whole reason the sync rule below is not ambiguous. "Reconcile
 * localStorage with the account" has two defensible answers when they disagree,
 * and picking the wrong one is user-hostile in both directions: a patient who
 * deliberately switched to Tamil on the login screen must not be flipped back to
 * English by their stored profile, and a returning patient whose account says
 * Hindi must not be reset to English just because this browser has never been
 * used before. So an *explicit* pre-login choice wins and is written up to the
 * account; anything else defers to the account.
 */
const EXPLICIT_KEY = "echosense.locale.explicit";

function markExplicitChoice(): void {
  try {
    window.localStorage.setItem(EXPLICIT_KEY, "1");
  } catch {
    /* private mode — the choice still applies for this visit */
  }
}

function hasExplicitChoice(): boolean {
  try {
    return window.localStorage.getItem(EXPLICIT_KEY) === "1";
  } catch {
    return false;
  }
}

function clearExplicitChoice(): void {
  try {
    window.localStorage.removeItem(EXPLICIT_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Reconcile the device preference with the account preference after sign-in.
 *
 * Returns the language that ended up active. Never throws: a language write
 * failing is not a reason to fail a login the user has already completed, so a
 * rejected PATCH leaves the choice applied locally and simply does not persist.
 */
async function syncLocaleOnLogin(accountLocale: string | null | undefined): Promise<string> {
  const account = resolveLanguage(accountLocale);
  const device = resolveLanguage(readStoredLocale());

  if (hasExplicitChoice() && device !== account) {
    await setLanguage(device);
    try {
      await api.auth.setLocale(device);
    } catch {
      /* offline or read-only account — applied locally, retried next change */
    }
    clearExplicitChoice();
    return device;
  }

  clearExplicitChoice();
  await setLanguage(account);
  return account;
}

interface Toast {
  id: number;
  message: string;
  kind: "info" | "ok" | "crit";
}

interface SessionState {
  session: Session | null;
  profile: PatientProfile | null;
  /** Set when a clinician opens a patient record. */
  actingPatientId: number | null;
  actingPatientName: string | null;
  theme: Theme;
  locale: string;
  toasts: Toast[];
  booting: boolean;

  login(email: string, password: string): Promise<Session>;
  register(body: Record<string, unknown>): Promise<Session>;
  logout(): void;
  refreshProfile(): Promise<void>;
  actAsPatient(id: number | null, name?: string | null): void;
  setTheme(theme: Theme): void;
  setLocale(locale: string): Promise<void>;
  toast(message: string, kind?: Toast["kind"]): void;
  dismissToast(id: number): void;
  hydrate(): void;
}

let toastId = 0;

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("echosense.theme", theme);
  } catch {
    /* storage unavailable (private mode) — theme just will not persist */
  }
}

export const useSession = create<SessionState>()(
  persist(
    (set, get) => ({
      session: null,
      profile: null,
      actingPatientId: null,
      actingPatientName: null,
      theme: "light",
      // Seeded from whatever i18next resolved at import time — the stored
      // preference, then the browser's, then English. The login screen renders
      // before this store hydrates, so it has to already be right.
      locale: resolveLanguage(i18n.language),
      toasts: [],
      booting: true,

      async login(email, password) {
        const session = await api.auth.login(email, password);
        setToken(session.access_token);
        setActingPatient(null);
        const locale = await syncLocaleOnLogin(session.locale);
        set({
          session,
          actingPatientId: null,
          actingPatientName: null,
          locale,
        });
        if (session.role === "patient") await get().refreshProfile();
        return session;
      },

      async register(body) {
        // A language chosen on the registration screen is the language this
        // person wants their account in, so it is sent with the account rather
        // than patched in a second call afterwards.
        const chosen = resolveLanguage(get().locale);
        const session = await api.auth.register({ locale: chosen, ...body });
        setToken(session.access_token);
        const locale = await syncLocaleOnLogin(session.locale || chosen);
        set({ session, locale });
        if (session.role === "patient") await get().refreshProfile();
        return session;
      },

      logout() {
        setToken(null);
        setActingPatient(null);
        set({ session: null, profile: null, actingPatientId: null, actingPatientName: null });
      },

      async refreshProfile() {
        const { session } = get();
        if (!session) return;
        try {
          const profile = await api.patients.me();
          set({ profile });
          applySavedCalibration(profile);
        } catch (error) {
          // A clinician with no acting patient legitimately has no profile.
          if (!(error instanceof ApiError && (error.status === 404 || error.status === 400))) throw error;
        }
      },

      actAsPatient(id, name) {
        setActingPatient(id);
        set({ actingPatientId: id, actingPatientName: name ?? null, profile: null });
        // Scoping to a patient changes whose profile — and whose headphone
        // calibration — every subsequent screen should be using.
        if (id !== null) void get().refreshProfile();
      },

      setTheme(theme) {
        applyTheme(theme);
        set({ theme });
      },

      /**
       * Change the interface language.
       *
       * Applied to i18next first so the screen re-renders immediately — the
       * account write is a background concern and must never be something the
       * user waits on. Signed out, the choice is recorded as explicit so the
       * next successful login carries it up to the account.
       */
      async setLocale(locale) {
        const code = await setLanguage(locale);
        set({ locale: code });

        const { session } = get();
        if (!session) {
          markExplicitChoice();
          return;
        }
        try {
          await api.auth.setLocale(code);
        } catch {
          // Applied locally and persisted to this device regardless; the next
          // successful change re-attempts the account write.
          get().toast(i18n.t("language.saveFailed"), "info");
        }
      },

      toast(message, kind = "info") {
        const id = ++toastId;
        set((state) => ({ toasts: [...state.toasts, { id, message, kind }] }));
        window.setTimeout(() => get().dismissToast(id), kind === "crit" ? 8000 : 4200);
      },

      dismissToast(id) {
        set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
      },

      hydrate() {
        const { session, theme, actingPatientId, locale } = get();
        if (session) setToken(session.access_token);
        if (actingPatientId !== null) setActingPatient(actingPatientId);
        applyTheme(theme);

        // Restore the language on every app open. The persisted session is the
        // authority once someone is signed in — it was last written from their
        // account — and the standalone `echosense.locale` key covers the signed-
        // out case, where there is no session blob to read from.
        const restored = resolveLanguage(session ? locale : readStoredLocale() ?? locale);
        if (restored !== resolveLanguage(i18n.language)) void setLanguage(restored);
        else writeStoredLocale(restored);
        if (restored !== locale) set({ locale: restored });

        set({ booting: false });
        // The profile is deliberately not persisted (it is clinical data and it
        // goes stale), so it is re-fetched on every boot. Therapy levels depend
        // on the calibration it carries, so this cannot wait for a screen that
        // happens to need it.
        if (session) void get().refreshProfile();
      },
    }),
    {
      name: "echosense.session",
      partialize: (state) => ({
        session: state.session,
        theme: state.theme,
        locale: state.locale,
        actingPatientId: state.actingPatientId,
        actingPatientName: state.actingPatientName,
      }),
    }
  )
);

// An expired token must drop the user to the login screen rather than leaving
// them staring at a screen full of failed requests.
onAuthFailure(() => {
  const { session, logout, toast } = useSession.getState();
  if (session) {
    logout();
    toast("Your session expired. Please sign in again.", "crit");
  }
});
