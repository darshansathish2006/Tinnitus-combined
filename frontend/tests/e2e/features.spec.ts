/**
 * Verification for the onboarding, rehabilitation and clinician-assignment work.
 *
 * Each test asserts the behaviour that was actually specified, not just that a
 * screen renders — a walkthrough that shows every time is a worse defect than
 * one that never shows, and only the second is visible from a screenshot.
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { CLINICIAN_EMAIL, DEMO_PASSWORD, PATIENT_EMAIL, attachConsoleGuard } from "./helpers";

const NEW_PATIENT = "walkthrough.test@example.com";
const NEW_PATIENT_PASSWORD = "testpass2026";

/**
 * Sign in and *wait for the session to land*.
 *
 * The wait is not politeness. Navigating straight after clicking races the
 * login request: the router re-renders on the new URL before the session store
 * has the token, the app decides nobody is signed in, and the test sees the
 * login screen with an empty form — which looks exactly like a broken feature
 * and is not one.
 */
async function signIn(page: Page, email: string, password: string) {
  await page.goto("/");
  await page.getByLabel(/^Email$/i).fill(email);
  await page.getByLabel(/^Password$/i).fill(password);
  await page.getByRole("button", { name: /^Sign in$/ }).last().click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible({ timeout: 30_000 });
}

/**
 * Dismiss whichever onboarding overlay this role gets.
 *
 * Not optional scaffolding: the walkthrough *navigates on every step*, so a
 * test that calls `page.goto()` with it open gets bounced straight back to the
 * dashboard. Any test not about onboarding has to clear it first.
 */
async function dismissOnboarding(page: Page) {
  const walk = page.locator(".walk__card");
  if (await walk.count()) {
    await walk.getByRole("button", { name: /Skip tour/ }).last().click();
    await expect(page.locator(".walk__card")).toHaveCount(0);
  }
  // The clinician console still uses the older pointer tour, whose welcome
  // modal sits over the caseload table.
  const skip = page.getByRole("button", { name: /^Skip$/ });
  if (await skip.count()) await skip.first().click();
}

test.describe("first-run walkthrough", () => {
  test("appears for a new patient, then never again", async ({ page }) => {
    const guard = attachConsoleGuard(page);
    await signIn(page, NEW_PATIENT, NEW_PATIENT_PASSWORD);

    // Step one names the dashboard and offers the four controls.
    const card = page.locator(".walk__card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByRole("heading", { name: "Your dashboard" })).toBeVisible();
    await expect(card.getByRole("button", { name: /Skip tour/ }).last()).toBeVisible();
    await expect(card.getByRole("button", { name: /^Next$/ })).toBeVisible();
    await expect(card.getByRole("button", { name: /^Back$/ })).toBeDisabled();

    // Walk all eight, checking the order the brief specified.
    const titles = [
      "Your dashboard",
      "Hearing assessment",
      "Your results",
      "Rehabilitation",
      "Community",
      "Group therapy",
      "Consultation",
      "Reports",
    ];
    for (let i = 1; i < titles.length; i++) {
      await card.getByRole("button", { name: /^Next$/ }).click();
      await expect(card.getByRole("heading", { name: titles[i] })).toBeVisible();
    }

    // The last step finishes rather than advancing.
    await expect(card.getByRole("button", { name: /Finish/ })).toBeVisible();
    await card.getByRole("button", { name: /Finish/ }).click();
    await expect(page.locator(".walk__card")).toHaveCount(0);

    // The whole point: a reload must not bring it back.
    await page.reload();
    await page.waitForTimeout(2500);
    await expect(page.locator(".walk__card")).toHaveCount(0);

    guard.assertClean();
  });

  test("never appears for an established patient", async ({ page }) => {
    const guard = attachConsoleGuard(page);
    await signIn(page, PATIENT_EMAIL, DEMO_PASSWORD);
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(2500);
    await expect(page.locator(".walk__card")).toHaveCount(0);
    guard.assertClean();
  });
});

test.describe("rehabilitation", () => {
  test("is named Rehabilitation and /therapy still resolves", async ({ page }) => {
    const guard = attachConsoleGuard(page);
    await signIn(page, PATIENT_EMAIL, DEMO_PASSWORD);
    await dismissOnboarding(page);

    const rail = page.getByRole("navigation", { name: "Main" });
    await expect(rail.getByRole("link", { name: "Rehabilitation" })).toBeVisible({ timeout: 20_000 });
    await expect(rail.getByRole("link", { name: /^Therapy$/ })).toHaveCount(0);

    // The old path is a redirect, not a 404.
    await page.goto("/therapy");
    await expect(page).toHaveURL(/\/rehabilitation$/);
    await expect(page.getByRole("heading", { name: /Your recovery programme/ })).toBeVisible();

    guard.assertClean();
  });

  test("shows the programme: today, goals, roadmap and progress", async ({ page }) => {
    const guard = attachConsoleGuard(page);
    await signIn(page, PATIENT_EMAIL, DEMO_PASSWORD);
    await dismissOnboarding(page);
    await page.goto("/rehabilitation");

    await expect(page.getByRole("heading", { name: /Your recovery programme/ })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("Streak", { exact: true })).toBeVisible();
    await expect(page.getByText("This week", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "This week's goals" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your four-week roadmap" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Why your programme looks like this/ })).toBeVisible();

    // Four weeks on the roadmap, exactly one of them marked current.
    await expect(page.locator(".roadmap__step")).toHaveCount(4);
    await expect(page.locator(".roadmap__step--current")).toHaveCount(1);

    guard.assertClean();
  });

  test("ticking an activity updates progress and persists", async ({ page }) => {
    const guard = attachConsoleGuard(page);
    await signIn(page, PATIENT_EMAIL, DEMO_PASSWORD);
    await dismissOnboarding(page);
    await page.goto("/rehabilitation");
    await expect(page.locator(".rehabitem").first()).toBeVisible({ timeout: 20_000 });

    // Breathing is core, so it is on every patient's list in week 1.
    const item = page.locator(".rehabitem", { hasText: "Breathing exercise" });
    const tick = item.getByRole("button", { name: /Mark done|Undo/ });

    const wasDone = await item.evaluate((el) => el.classList.contains("rehabitem--done"));
    if (wasDone) {
      await tick.click();
      await expect(item).not.toHaveClass(/rehabitem--done/);
    }

    await tick.click();
    await expect(item).toHaveClass(/rehabitem--done/);

    // Survives a reload — it was written to the server, not to component state.
    await page.reload();
    const after = page.locator(".rehabitem", { hasText: "Breathing exercise" });
    await expect(after).toHaveClass(/rehabitem--done/, { timeout: 20_000 });

    // Put it back so the demo cohort is left as it was found.
    await after.getByRole("button", { name: /Undo/ }).click();
    await expect(after).not.toHaveClass(/rehabitem--done/);

    guard.assertClean();
  });
});

test.describe("clinician assignment", () => {
  /**
   * Register a throwaway patient through the API.
   *
   * The seeded cohort all have clinicians, and the account used by the
   * walkthrough test acquires one the moment anything confirms a doctor — so
   * "a patient with no clinician" has to be created, not found.
   */
  async function freshPatient(request: APIRequestContext) {
    const email = `fresh.${Date.now()}@example.com`;
    const password = "freshpass2026";
    const response = await request.post("http://127.0.0.1:9000/api/auth/register", {
      data: { email, password, full_name: "Fresh Patient", role: "patient" },
    });
    expect(response.ok()).toBe(true);
    return { email, password, body: await response.json() };
  }

  test("a new account has no clinician and is asked to choose one", async ({ page, request }) => {
    const guard = attachConsoleGuard(page);
    const account = await freshPatient(request);

    // The registration response itself proves the auto-assignment is gone.
    const me = await request.get("http://127.0.0.1:9000/api/consultation", {
      headers: { Authorization: `Bearer ${account.body.access_token}` },
    });
    expect((await me.json()).clinician.assigned).toBe(false);

    await signIn(page, account.email, account.password);
    await dismissOnboarding(page);
    await page.goto("/consultation");

    // The prompt is shown and the "Your clinician" card is not — a card about
    // the absence of a clinician is worse than no card.
    await expect(page.getByRole("heading", { name: "Choose your doctor" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("Your clinician", { exact: true })).toHaveCount(0);

    guard.assertClean();
  });

  test("choosing a doctor assigns them and reveals the clinician card", async ({ page, request }) => {
    const guard = attachConsoleGuard(page);
    const account = await freshPatient(request);
    await signIn(page, account.email, account.password);
    await dismissOnboarding(page);
    await page.goto("/consultation");

    // Every comparison field the brief asked for is on the card.
    const card = page.locator(".doctorcard").first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText("Working days")).toBeVisible();
    await expect(card.getByText("Hours", { exact: true })).toBeVisible();
    await expect(card.getByText("Soonest", { exact: true })).toBeVisible();

    await card.getByRole("button", { name: /^Choose / }).click();

    // Assigned: the card appears, the prompt goes.
    await expect(page.getByText("Your clinician", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Choose your doctor" })).toHaveCount(0);

    // And it stuck server-side, not just in component state.
    const after = await request.get("http://127.0.0.1:9000/api/consultation", {
      headers: { Authorization: `Bearer ${account.body.access_token}` },
    });
    expect((await after.json()).clinician.assigned).toBe(true);

    guard.assertClean();
  });
});

test.describe("removed sections", () => {
  test("the clinician record no longer offers patient screens", async ({ page }) => {
    const guard = attachConsoleGuard(page);
    await signIn(page, CLINICIAN_EMAIL, DEMO_PASSWORD);
    await expect(page.getByRole("heading", { name: "Caseload" })).toBeVisible({ timeout: 20_000 });
    await dismissOnboarding(page);

    const row = page.locator("table tbody tr").first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await expect(page.getByText("Patient record")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);

    // `exact` matters: an inexact match also hits the acting-as-patient
    // banner's "— all patient screens show their data", which is a different
    // string that is supposed to be there.
    await expect(page.getByText("Patient screens", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Open the patient-facing app scoped to this record/)).toHaveCount(0);

    guard.assertClean();
  });
});
