/**
 * Sign in / register.
 *
 * The demo accounts are listed inline and fill the form on click. A reviewer with
 * five minutes should not have to find credentials in a README.
 *
 * **The language selector is in the header of this screen, not behind the
 * login.** Someone who cannot read English cannot be asked to authenticate
 * before they are allowed to change the language — the choice made here applies
 * to this page immediately, is held in localStorage while there is no account to
 * write it to, and is carried up onto the account on the first successful
 * sign-in. See `syncLocaleOnLogin` in `state/session`.
 */

import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { api, API_BASE, ApiError } from "../api/client";
import { useSession } from "../state/session";
import { Brand, Field, Loading, Panel, ThemeToggle, useAsync } from "../components/ui";
import { LanguageSelector } from "../components/LanguageSelector";
import { IconChat, IconEar, IconTrend, IconWave } from "../components/icons";

const FEATURES = [
  { icon: IconEar, key: "hearingTest" },
  { icon: IconWave, key: "soundTherapy" },
  { icon: IconTrend, key: "trackProgress" },
  { icon: IconChat, key: "support" },
];

/**
 * Plausible bounds for a date of birth.
 *
 * Without a `min` the year field accepts anything up to the year 275760, which
 * is not validation so much as an invitation. 120 years is past the verified
 * human record and comfortably clear of any real patient.
 */
const DOB_MAX = new Date().toISOString().slice(0, 10);
const DOB_MIN = new Date(new Date().getFullYear() - 120, 0, 1).toISOString().slice(0, 10);

/** Whole years between `iso` and today, or null if the date is not usable. */
function ageFromDob(iso: string): number | null {
  if (!iso) return null;
  const dob = new Date(iso);
  if (Number.isNaN(dob.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const before =
    today.getMonth() < dob.getMonth() ||
    (today.getMonth() === dob.getMonth() && today.getDate() < dob.getDate());
  if (before) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

export default function Login() {
  const { t } = useTranslation();
  const login = useSession((s) => s.login);
  const register = useSession((s) => s.register);
  const toast = useSession((s) => s.toast);

  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<"patient" | "clinician">("patient");
  const [sex, setSex] = useState<"female" | "male" | "other" | "prefer_not_to_say" | "">("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  // Echoed back under the field so a mistyped year is obvious before submit.
  const dobAge = ageFromDob(dateOfBirth);
  const [country, setCountry] = useState("");
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [busy, setBusy] = useState(false);
  const [detectingLocation, setDetectingLocation] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const demo = useAsync(() => api.auth.demoAccounts(), []);
  const health = useAsync(() => api.health(), []);

  function handleUseMyLocation() {
    if (!navigator.geolocation) {
      toast("Geolocation is not supported by your browser.", "info");
      return;
    }
    setDetectingLocation(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const lat = pos.coords.latitude;
          const lon = pos.coords.longitude;
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`
          );
          if (res.ok) {
            const geo = await res.json();
            const addr = geo.address || {};
            const foundCountry = addr.country || "";
            const foundState = addr.state || addr.region || addr.province || "";
            const foundCity =
              addr.city || addr.town || addr.village || addr.municipality || addr.county || "";

            if (foundCountry) setCountry(foundCountry);
            if (foundState) setState(foundState);
            if (foundCity) setCity(foundCity);

            toast("Location detected! Please review.", "ok");
          } else {
            toast("Could not resolve location address. Please enter details manually.", "info");
          }
        } catch {
          toast("Location service unavailable. Please enter details manually.", "info");
        } finally {
          setDetectingLocation(false);
        }
      },
      (err) => {
        setDetectingLocation(false);
        toast(`Location access denied or unavailable (${err.message}).`, "info");
      },
      { timeout: 10000 }
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        const session = await login(email.trim(), password);
        toast(t("auth.signedInAs", { name: session.full_name }), "ok");
      } else {
        if (!sex) {
          setError(t("auth.sexRequired", "Please select your sex."));
          setBusy(false);
          return;
        }
        if (!dateOfBirth) {
          setError(t("auth.dobRequired", "Please select your date of birth."));
          setBusy(false);
          return;
        }
        const session = await register({
          email: email.trim(),
          password,
          full_name: fullName.trim(),
          role,
          country: country.trim(),
          state: state.trim(),
          city: city.trim(),
          sex,
          date_of_birth: dateOfBirth,
        });
        toast(t("auth.accountCreatedFor", { name: session.full_name }), "ok");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("errors.apiUnreachable"));
    } finally {
      setBusy(false);
    }
  }

  function useDemo(account: { email: string; password: string }) {
    setMode("login");
    setEmail(account.email);
    setPassword(account.password);
    setError(null);
  }

  const patients = demo.data?.accounts.filter((a) => a.role === "patient") ?? [];
  const clinicians = demo.data?.accounts.filter((a) => a.role !== "patient") ?? [];

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header className="topbar">
        <div className="topbar__inner">
          <Brand subtitle={t("shell.brandSubtitlePatient")} />
          <span className="spacer" />
          <LanguageSelector />
          <ThemeToggle />
        </div>
      </header>

      <main className="wrap" style={{ flex: 1, paddingBlock: "var(--s12)" }}>
        <div className="grid grid-sidebar" style={{ ["--aside" as string]: "420px", gap: "var(--s10)" }}>
          {/* -- pitch ------------------------------------------------------- */}
          <div className="stack stack-5">
            <div className="stack stack-3">
              <h1 style={{ fontSize: "clamp(2rem, 4.5vw, 3rem)", maxWidth: "20em" }}>
                {t("auth.headline")}
              </h1>
              <p className="lead">{t("auth.subhead")}</p>
            </div>

            <div className="grid grid-2">
              {FEATURES.map((item) => (
                <Panel key={item.key} tight>
                  <div className="row row--tight">
                    <span className="iconbadge">
                      <item.icon size={19} />
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <strong style={{ fontSize: "var(--fs-small)", display: "block" }}>
                        {t(`auth.features.${item.key}`)}
                      </strong>
                      <span className="meta">{t(`auth.features.${item.key}Detail`)}</span>
                    </div>
                  </div>
                </Panel>
              ))}
            </div>
          </div>

          {/* -- auth -------------------------------------------------------- */}
          <div className="stack stack-4">
            <Panel bracketed>
              <div className="btn-group" style={{ width: "100%", marginBottom: "var(--s5)" }}>
                <button
                  type="button"
                  className="btn"
                  style={{ flex: 1 }}
                  aria-pressed={mode === "login"}
                  onClick={() => setMode("login")}
                >
                  {t("auth.signIn")}
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ flex: 1 }}
                  aria-pressed={mode === "register"}
                  onClick={() => setMode("register")}
                >
                  {t("auth.createAccount")}
                </button>
              </div>

              <form className="stack stack-4" onSubmit={submit}>
                {mode === "register" && (
                  <>
                    <Field label={t("auth.fullName")}>
                      <input
                        className="input"
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        required
                        minLength={2}
                        autoComplete="name"
                      />
                    </Field>
                    <Field label={t("auth.accountType")}>
                      <select className="select" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                        <option value="patient">{t("auth.rolePatient")}</option>
                        <option value="clinician">{t("auth.roleClinician")}</option>
                      </select>
                    </Field>

                    <Field label={t("auth.sex")}>
                      <select
                        className="select"
                        value={sex}
                        onChange={(e) => setSex(e.target.value as typeof sex)}
                        required
                      >
                        <option value="" disabled hidden>
                          {t("auth.selectSex", "-- Select Sex --")}
                        </option>
                        <option value="female">{t("auth.sexFemale")}</option>
                        <option value="male">{t("auth.sexMale")}</option>
                        <option value="other">{t("auth.sexOther")}</option>
                        <option value="prefer_not_to_say">{t("auth.sexPreferNotToSay")}</option>
                      </select>
                    </Field>

                    {/* A native `type="date"` already carries the browser's own
                        calendar, and it is the right control: it is localised,
                        keyboard accessible, and it hands back the exact
                        `YYYY-MM-DD` string the API expects, so the stored format
                        and the existing validation are untouched. What made it
                        awkward for a *birth* date was the range — the year
                        spinner ran to the year 275760 and the picker opened on
                        today, so a sixty-year-old paged back sixty years.

                        `min` bounds it to a plausible human lifespan, and
                        clicking anywhere in the field opens the calendar rather
                        than only the small icon at its right edge. `showPicker`
                        is wrapped because Safari and Firefox either lack it or
                        throw when it is called without a user gesture; the field
                        stays fully usable by typing when it is unavailable. */}
                    <Field
                      label={t("auth.dateOfBirth")}
                      hint={dobAge === null ? t("auth.dobHint") : t("auth.dobAge", { age: dobAge })}
                    >
                      <input
                        type="date"
                        className="input"
                        value={dateOfBirth}
                        min={DOB_MIN}
                        max={DOB_MAX}
                        placeholder="YYYY-MM-DD"
                        onFocus={(e) => {
                          try {
                            (e.currentTarget as HTMLInputElement & { showPicker?(): void }).showPicker?.();
                          } catch {
                            /* not supported here — typing still works */
                          }
                        }}
                        onClick={(e) => {
                          try {
                            (e.currentTarget as HTMLInputElement & { showPicker?(): void }).showPicker?.();
                          } catch {
                            /* not supported here — typing still works */
                          }
                        }}
                        onChange={(e) => setDateOfBirth(e.target.value)}
                        required
                      />
                    </Field>

                    {/* Location Section */}
                    <div className="stack stack-3" style={{ borderTop: "1px solid var(--ink-line)", paddingTop: "var(--s3)" }}>
                      <div className="row row--between">
                        <span className="label">Location (Local Community)</span>
                        <button
                          type="button"
                          className="btn btn--sm"
                          style={{ fontSize: "var(--fs-tiny)" }}
                          onClick={handleUseMyLocation}
                          disabled={detectingLocation}
                        >
                          {detectingLocation ? "Detecting…" : "Use my location"}
                        </button>
                      </div>
                      <Field label="Country">
                        <input
                          className="input"
                          value={country}
                          onChange={(e) => setCountry(e.target.value)}
                          placeholder="e.g. India"
                        />
                      </Field>
                      <Field label="State / Province">
                        <input
                          className="input"
                          value={state}
                          onChange={(e) => setState(e.target.value)}
                          placeholder="e.g. Tamil Nadu"
                        />
                      </Field>
                      <Field label="City">
                        <input
                          className="input"
                          value={city}
                          onChange={(e) => setCity(e.target.value)}
                          placeholder="e.g. Chennai"
                        />
                      </Field>
                    </div>

                    <Field label={t("language.label")}>
                      <LanguageSelector variant="block" align="start" />
                    </Field>
                  </>
                )}

                <Field label={t("auth.email")}>
                  <input
                    className="input"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="username"
                  />
                </Field>

                <Field
                  label={t("auth.password")}
                  hint={mode === "register" ? t("auth.passwordHint") : undefined}
                >
                  <input
                    className="input"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={mode === "register" ? 8 : 1}
                    autoComplete={mode === "register" ? "new-password" : "current-password"}
                  />
                </Field>

                {error && (
                  <p className="meta" style={{ color: "var(--crit-ink)" }}>
                    {error}
                  </p>
                )}

                <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={busy}>
                  {busy ? t("common.working") : t(mode === "login" ? "auth.signIn" : "auth.createAccount")}
                </button>
              </form>
            </Panel>

            {demo.loading && <Loading label={t("auth.demo.loading")} rows={2} />}

            {demo.data?.seeded && (
              <Panel title={t("auth.demo.title")} tone="sunken" tight>
                <p className="meta" style={{ marginBottom: "var(--s3)" }}>
                  {t("auth.demo.intro")}
                </p>

                <div className="stack stack-2">
                  <span className="label">
                    {t("auth.demo.clinician")} ({clinicians.length})
                  </span>
                  {clinicians.map((account) => (
                    <button
                      key={account.email}
                      type="button"
                      className="option"
                      onClick={() => useDemo(account)}
                    >
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: "block", fontWeight: 600 }}>{account.full_name}</span>
                        <span className="meta mono" style={{ display: "block" }}>
                          {account.email}
                        </span>
                      </span>
                    </button>
                  ))}

                  <span className="label" style={{ marginTop: "var(--s2)" }}>
                    {t("auth.demo.patients")} ({patients.length})
                  </span>
                  {/* Every seeded patient, not the first four.

                      The list is rendered straight from `/api/auth/demo-accounts`,
                      which reads the seeded emails from `seed_demo`, so *which*
                      accounts appear is decided by the seed and cannot drift
                      from it — the cap was the only thing hiding eight of them.
                      That mattered: the accounts worth demonstrating are not all
                      near the front. James Whelan (catastrophic THI with masking
                      rebound), Meera Iyer (pulsatile — an urgent red flag) and
                      Wei Chen (bilateral hearing aids) were all below the cut,
                      so the three cases that best show what the platform does
                      were the three you could not click.

                      Scrolls past roughly six entries rather than pushing the
                      sign-in button off a laptop screen. */}
                  <div
                    className="stack stack-2"
                    style={{ maxHeight: "268px", overflowY: "auto", paddingRight: "2px" }}
                  >
                    {patients.map((account) => (
                      <button
                        key={account.email}
                        type="button"
                        className="option"
                        onClick={() => useDemo(account)}
                      >
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: "block", fontWeight: 600 }}>{account.full_name}</span>
                          <span className="meta mono" style={{ display: "block" }}>
                            {account.mrn} · {account.email}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <p className="meta mono" style={{ marginTop: "var(--s3)" }}>
                  {t("auth.demo.password", { password: demo.data.accounts[0]?.password })}
                </p>
              </Panel>
            )}

            {/* A failed fetch used to render nothing at all: `demo.data` stays
                null, both branches below test `demo.data`, and the panel simply
                was not there. That is the worst possible failure mode for this
                particular panel, because "the demo accounts are missing" and
                "the API is unreachable" look identical — and the second is the
                one that is actually true whenever the backend is on a port the
                client is not calling. Now it says so, and names the base it
                tried. */}
            {/* `Boolean(...)`, not a bare `&&`: `demo.error` is typed
                `unknown`, and `unknown && <JSX/>` has type `unknown` — which
                React would be asked to render when the guard is falsy. */}
            {Boolean(demo.error) && (
              <Panel tone="crit" tight>
                <div className="stack stack-2">
                  <span className="label">{t("auth.demo.unreachableTitle")}</span>
                  <p className="meta">{t("auth.demo.unreachableBody")}</p>
                  <p className="meta mono" style={{ fontSize: "var(--fs-micro)" }}>
                    {window.location.origin}/api
                  </p>
                  <button type="button" className="btn btn--sm" onClick={demo.reload}>
                    {t("common.retry")}
                  </button>
                </div>
              </Panel>
            )}

            {demo.data && !demo.data.seeded && (
              <Panel tone="warn" tight>
                {/* <Trans> rather than t(): the sentence wraps a <code> element
                    around a shell command, and the command sits in a different
                    place in Tamil and Hindi word order. Splitting it into three
                    concatenated fragments would hard-code English syntax. */}
                <p className="meta">
                  <Trans i18nKey="auth.demo.missing" components={[<code key="0" />]} />
                </p>
              </Panel>
            )}

            {health.error ? (
              <Panel tone="crit" tight>
                <p className="meta">
                  <Trans
                    i18nKey="auth.apiDown"
                    values={{ base: API_BASE }}
                    components={[<code key="0" />]}
                  />{" "}
                  {/* "Start it with npm run dev" is the right next step on a
                      developer's machine and nonsense to someone on the
                      deployed site, where there is no local server to start. */}
                  {import.meta.env.DEV ? (
                    <Trans i18nKey="auth.apiDownDev" components={[<code key="0" />]} />
                  ) : (
                    <Trans i18nKey="auth.apiDownRetry" />
                  )}
                </p>
                <p className="meta dim" style={{ marginTop: "var(--s2)" }}>
                  {health.error instanceof Error ? health.error.message : String(health.error)}
                </p>
              </Panel>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}
