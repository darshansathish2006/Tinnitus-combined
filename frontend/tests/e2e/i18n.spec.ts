/**
 * Multilingual smoke tests.
 *
 * These assert the four claims the feature actually makes, because each one is
 * a place a "translated" app quietly fails:
 *
 *  1. The selector works **before** authentication, and switching re-renders the
 *     login screen without a reload.
 *  2. The choice survives a page reload while still signed out.
 *  3. The choice is carried up onto the account at sign-in and drives the
 *     navigation rail, so a patient does not land on an English dashboard.
 *  4. Nothing renders a raw translation key — the failure mode that looks fine
 *     in review and ships `home.wellness.question` to a patient.
 *
 * The console guard is attached throughout: a missing i18next key logs an error
 * rather than throwing, so a test that only asserted on visible text would pass
 * over exactly the defect it was written to catch.
 */

import { expect, test } from "@playwright/test";
import { CLINICIAN_EMAIL, DEMO_PASSWORD, PATIENT_EMAIL, attachConsoleGuard } from "./helpers";

/** Any `a.b.c` token that leaked into rendered text instead of a translation. */
const RAW_KEY =
  /\b(common|nav|shell|auth|home|assessment|questionnaires|chat|consultation|doctorPicker|instruments|tour|errors|validation|appointment|language|units|theme|urgency|therapy|calibration|audiometry|match|procedures|results|clinician|record|guide)\.[a-zA-Z0-9_.]+/;

async function chooseLanguage(page: import("@playwright/test").Page, native: string) {
  await page.getByRole("button", { name: /select language/i }).first().click();
  await page.getByRole("option", { name: new RegExp(native) }).click();
}

test.describe("language selection", () => {
  test("switches the login screen without a reload and persists it", async ({ page }) => {
    const guard = attachConsoleGuard(page);
    await page.goto("/");

    // English is the default for a browser with no stored preference.
    await expect(page.getByRole("heading", { name: /take control of your tinnitus/i })).toBeVisible();

    await chooseLanguage(page, "தமிழ்");

    // Instant: the same DOM, re-rendered. No navigation happened.
    await expect(page.getByRole("heading", { name: /காது ஒலி/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /உள்நுழை/ }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("ta");

    // Persisted for the *next* visit, while still signed out.
    await page.reload();
    await expect(page.getByRole("heading", { name: /காது ஒலி/ })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("echosense.locale"))).toBe("ta");

    guard.assertClean();
  });

  test("Hindi renders and the document language follows", async ({ page }) => {
    const guard = attachConsoleGuard(page);
    await page.goto("/");

    await chooseLanguage(page, "हिन्दी");

    await expect(page.getByRole("heading", { name: /टिनिटस/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("hi");

    guard.assertClean();
  });

  test("a language chosen before login is carried onto the account", async ({ page }) => {
    const guard = attachConsoleGuard(page);
    await page.goto("/");

    await chooseLanguage(page, "தமிழ்");
    await page.getByLabel(/மின்னஞ்சல்/).fill(PATIENT_EMAIL);
    await page.getByLabel(/கடவுச்சொல்/).fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: /உள்நுழை/ }).last().click();

    // The rail is the proof: it is rendered after authentication, from the
    // session the server returned, so it can only be Tamil if the pre-login
    // choice actually reached the account.
    //
    // Scoped to the nav landmark deliberately. Unscoped, "சிகிச்சை" (therapy)
    // matches the rail link *and* the dashboard's quick-access card — which is
    // the right outcome for the app and a strict-mode violation for the test.
    const rail = page.getByRole("navigation", { name: /முதன்மை வழிசெலுத்தல்/ });
    await expect(rail.getByRole("link", { name: /மேலோட்டம்/ })).toBeVisible({ timeout: 15_000 });
    // "மறுவாழ்வு" — the module was renamed from Therapy to Rehabilitation.
    await expect(rail.getByRole("link", { name: /மறுவாழ்வு/ })).toBeVisible();
    await expect(rail.getByRole("link", { name: /மருத்துவர் ஆலோசனை/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /வெளியேறு/ })).toBeVisible();

    // And the account itself now holds the preference, not just this browser.
    const me = await page.evaluate(async () => {
      const session = JSON.parse(localStorage.getItem("echosense.session") ?? "{}");
      const token = session?.state?.session?.access_token;
      const response = await fetch("http://127.0.0.1:9000/api/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      return response.json();
    });
    expect(me.locale).toBe("ta");

    guard.assertClean();
  });

  test("no screen renders a raw translation key", async ({ page }) => {
    const guard = attachConsoleGuard(page);
    await page.goto("/");
    await chooseLanguage(page, "தமிழ்");

    await page.getByLabel(/மின்னஞ்சல்/).fill(PATIENT_EMAIL);
    await page.getByLabel(/கடவுச்சொல்/).fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: /உள்நுழை/ }).last().click();
    await expect(page.getByRole("link", { name: /மேலோட்டம்/ })).toBeVisible({ timeout: 15_000 });

    for (const path of ["/", "/assessment", "/therapy", "/support", "/consultation", "/results", "/guide"]) {
      await page.goto(path);
      // Let the screen's data settle before scraping it.
      await page.waitForTimeout(1200);
      const text = await page.locator("body").innerText();
      const leaked = text.match(RAW_KEY);
      expect(leaked ? `${path}: ${leaked[0]}` : null).toBeNull();
    }

    guard.assertClean();
  });
});

test.describe("clinician console", () => {
  test("renders in Tamil and reaches the patient record", async ({ page }) => {
    const guard = attachConsoleGuard(page);
    await page.goto("/");
    await chooseLanguage(page, "தமிழ்");

    await page.getByLabel(/மின்னஞ்சல்/).fill(CLINICIAN_EMAIL);
    await page.getByLabel(/கடவுச்சொல்/).fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: /உள்நுழை/ }).last().click();

    // The caseload is the clinician landing screen.
    await expect(page.getByRole("heading", { name: /நோயாளிப் பட்டியல்/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("navigation", { name: /முதன்மை/ })).toBeVisible();

    const text = await page.locator("body").innerText();
    expect(text.match(RAW_KEY)?.[0] ?? null).toBeNull();

    guard.assertClean();
  });
});
