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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const demo = useAsync(() => api.auth.demoAccounts(), []);
  const health = useAsync(() => api.health(), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        const session = await login(email.trim(), password);
        toast(t("auth.signedInAs", { name: session.full_name }), "ok");
      } else {
        const session = await register({
          email: email.trim(),
          password,
          full_name: fullName.trim(),
          role,
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
          {/* Full variant, not compact: on the one screen where the reader may
              not understand a single other word, the control has to name the
              language it is currently in rather than be a bare globe glyph. */}
          <LanguageSelector />
          <ThemeToggle />
        </div>
      </header>

      <main className="wrap" style={{ flex: 1, paddingBlock: "var(--s12)" }}>
        <div className="grid grid-sidebar" style={{ ["--aside" as string]: "420px", gap: "var(--s10)" }}>
          {/* -- pitch ------------------------------------------------------- */}
          <div className="stack stack-5">
            <div className="stack stack-3">
              {/* No `maxWidth` in ch here. A ch unit is the width of "0" in the
                  current face, and Tamil and Devanagari set far wider per
                  character than Latin — an 18ch cap that frames the English
                  headline cuts the Tamil one to three words a line. */}
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
                    {/* Shown on the registration form as well as the header: the
                        language picked here is written onto the new account, so
                        it is a field of the form as much as a page control. */}
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
                  <span className="label">{t("auth.demo.clinician")}</span>
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
                    {t("auth.demo.patients")}
                  </span>
                  {patients.slice(0, 4).map((account) => (
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

                <p className="meta mono" style={{ marginTop: "var(--s3)" }}>
                  {t("auth.demo.password", { password: demo.data.accounts[0]?.password })}
                </p>
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
