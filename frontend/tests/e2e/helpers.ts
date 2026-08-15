/**
 * Shared smoke-test scaffolding.
 *
 * The important piece is `attachConsoleGuard`. A page that renders is not a page
 * that works: React swallows nothing, but a failed fetch, a missing key or an
 * unhandled rejection all land in the console and are invisible to a test that
 * only asserts on visible text. Every test attaches the guard and every test
 * fails if the console produced an error.
 */

import { expect, type ConsoleMessage, type Page, type TestInfo } from "@playwright/test";

export const DEMO_PASSWORD = "echosense2026";
export const PATIENT_EMAIL = "priya.sundaram@example.com";
export const CLINICIAN_EMAIL = "dr.mehta@echosense.health";

/**
 * Console noise that is not a defect.
 *
 * Kept deliberately short and specific — a broad pattern here turns the guard
 * into decoration. Each entry says why it cannot be fixed in app code.
 */
const IGNORED = [
  // Chromium blocks AudioContext until a user gesture. The engine creates its
  // context inside click handlers; the warning is emitted by the platform when a
  // page merely imports the audio module.
  /AudioContext was not allowed to start/i,
  /The AudioContext was not allowed to start/i,
  // React Router logs upcoming-major advisories on startup.
  /React Router Future Flag/i,
  // Vite's HMR client during dev-server startup races.
  /\[vite\] connect/i,
  // A brand-new account legitimately 404s on the endpoints that describe work
  // it has not done yet — `therapy/current`, `assessments/latest`. The client
  // catches those and renders an empty state; the browser still logs the failed
  // fetch. Narrowed to the status line so a 404 on a *route* still fails.
  /Failed to load resource: the server responded with a status of 404/i,
];

export interface ConsoleGuard {
  errors: string[];
  assertClean(): void;
}

export function attachConsoleGuard(page: Page, testInfo?: TestInfo): ConsoleGuard {
  const errors: string[] = [];

  const record = (source: string, text: string) => {
    if (IGNORED.some((pattern) => pattern.test(text))) return;
    errors.push(`[${source}] ${text}`);
  };

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") record("console.error", message.text());
  });
  page.on("pageerror", (error) => record("pageerror", `${error.name}: ${error.message}`));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown";
    // Aborted requests are normal when a component unmounts mid-fetch.
    if (/ERR_ABORTED|NS_BINDING_ABORTED/i.test(failure)) return;
    record("requestfailed", `${request.method()} ${request.url()} — ${failure}`);
  });
  // A 5xx from the API is a broken API call even if the UI renders a fallback.
  page.on("response", (response) => {
    if (response.status() >= 500) record("http", `${response.status()} ${response.url()}`);
  });

  return {
    errors,
    assertClean() {
      if (errors.length && testInfo) {
        testInfo.attach("console-errors", { body: errors.join("\n"), contentType: "text/plain" });
      }
      expect(errors, `Browser reported ${errors.length} error(s):\n${errors.join("\n")}`).toEqual([]);
    },
  };
}

/**
 * Sign in through the real form and wait for the app shell to mount.
 *
 * Selectors are scoped to the `<form>`: the login panel has a mode switcher
 * whose tabs are also labelled "Sign in" and "Create account", so an unscoped
 * role query matches two buttons.
 */
export async function login(page: Page, email: string, password = DEMO_PASSWORD): Promise<void> {
  await page.goto("/");
  const form = page.locator("form");
  await form.getByLabel(/email/i).fill(email);
  await form.getByLabel(/password/i).fill(password);
  await form.getByRole("button", { name: /^sign in$/i }).click();
  await expect(page.locator(".rail")).toBeVisible({ timeout: 20_000 });
}

/** Open a rail destination by its visible label and wait for the URL to settle. */
export async function navigateTo(page: Page, label: string, path: string): Promise<void> {
  await page.locator(".rail__nav").getByRole("link", { name: label, exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, "\\/")}$`));
}

/** Current theme, read from the attribute the app actually sets. */
export async function currentTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute("data-theme"));
}

/**
 * Resolve a CSS custom property to its computed value, so contrast assertions
 * test what the browser paints rather than what the stylesheet says.
 */
export async function cssVar(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (prop) => getComputedStyle(document.documentElement).getPropertyValue(prop).trim(),
    name
  );
}
