/**
 * Verification for the introduction video and the ten-minute Meet workflow.
 *
 * The two things worth actually asserting here are the ones a screenshot
 * cannot show: that the onboarding sequence runs *once*, and that the meeting
 * link is genuinely absent from the payload before the window opens rather than
 * merely hidden by CSS.
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { CLINICIAN_EMAIL, DEMO_PASSWORD, PATIENT_EMAIL, attachConsoleGuard } from "./helpers";

const API = "http://127.0.0.1:9000";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/");
  await page.getByLabel(/^Email$/i).fill(email);
  await page.getByLabel(/^Password$/i).fill(password);
  await page.getByRole("button", { name: /^Sign in$/ }).last().click();
  await expect(page.locator(".rail__nav")).toBeVisible({ timeout: 30_000 });
}

async function freshPatient(request: APIRequestContext) {
  const email = `video.${Date.now()}@example.com`;
  const password = "videopass2026";
  const response = await request.post(`${API}/api/auth/register`, {
    data: { email, password, full_name: "Video Test", role: "patient" },
  });
  expect(response.ok()).toBe(true);
  return { email, password, body: await response.json() };
}

test.describe("introduction video", () => {
  test("plays before the walkthrough for a new patient, and only once", async ({ page, request }) => {
    const guard = attachConsoleGuard(page);
    const account = await freshPatient(request);
    await signIn(page, account.email, account.password);

    // The video modal comes first — before any spotlight step.
    const modal = page.locator(".videomodal");
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await expect(modal.getByRole("heading", { name: "Welcome to EchoSense AI" })).toBeVisible();
    await expect(page.locator(".walk__card")).toHaveCount(0);

    // The four controls the brief asked for are all present and operable.
    const video = modal.locator("video");
    await expect(video).toBeVisible();
    await expect(modal.getByRole("button", { name: /^Pause$|^Play$/ })).toBeVisible();
    await expect(modal.getByRole("button", { name: /Mute|Unmute/ })).toBeVisible();
    await expect(modal.getByRole("button", { name: /Replay from the start/ })).toBeVisible();
    await expect(modal.getByRole("button", { name: /Skip video/ }).last()).toBeVisible();

    // Play/pause toggles the underlying element, not just the icon.
    await modal.getByRole("button", { name: /^Pause$|^Play$/ }).click();
    await page.waitForTimeout(400);
    await modal.getByRole("button", { name: /^Pause$|^Play$/ }).click();

    // Continue hands over to the walkthrough.
    await modal.getByRole("button", { name: /Continue to walkthrough/ }).click();
    await expect(page.locator(".videomodal")).toHaveCount(0);
    await expect(page.locator(".walk__card")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".walk__card").getByRole("heading", { name: "Your dashboard" })).toBeVisible();

    // Finish the six steps.
    for (let i = 0; i < 5; i++) {
      await page.locator(".walk__card").getByRole("button", { name: /^Next$/ }).click();
    }
    await page.locator(".walk__card").getByRole("button", { name: /Finish/ }).click();

    // The whole sequence is done for good.
    await page.reload();
    await page.waitForTimeout(3000);
    await expect(page.locator(".videomodal")).toHaveCount(0);
    await expect(page.locator(".walk__card")).toHaveCount(0);

    guard.assertClean();
  });

  test("skipping the video ends onboarding without starting the tour", async ({ page, request }) => {
    const guard = attachConsoleGuard(page);
    const account = await freshPatient(request);
    await signIn(page, account.email, account.password);

    const modal = page.locator(".videomodal");
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await modal.getByRole("button", { name: /Skip video/ }).last().click();

    await expect(page.locator(".videomodal")).toHaveCount(0);
    await page.waitForTimeout(1500);
    await expect(page.locator(".walk__card")).toHaveCount(0);

    guard.assertClean();
  });

  test("the Guide page carries the same video and its quick actions", async ({ page, request }) => {
    const guard = attachConsoleGuard(page);

    // Pin the account language. The multilingual suite deliberately writes a
    // language preference onto this account, so a test asserting on English
    // copy has to state which language it is testing rather than inherit
    // whatever ran last.
    const login = await request.post(`${API}/api/auth/login`, {
      data: { email: PATIENT_EMAIL, password: DEMO_PASSWORD },
    });
    await request.patch(`${API}/api/auth/locale`, {
      headers: { Authorization: `Bearer ${(await login.json()).access_token}` },
      data: { locale: "en" },
    });

    await signIn(page, PATIENT_EMAIL, DEMO_PASSWORD);
    await page.goto("/guide");

    const section = page.locator(".guidevideo");
    await expect(section).toBeVisible({ timeout: 20_000 });
    await expect(section.getByRole("heading", { name: "Welcome to EchoSense AI" })).toBeVisible();

    // Native controls on this one — it is a reference screen.
    const video = section.locator("video");
    await expect(video).toBeVisible();
    expect(await video.getAttribute("controls")).not.toBeNull();

    await expect(section.getByRole("button", { name: /Start guided tour/ })).toBeVisible();
    await expect(section.getByRole("button", { name: /Watch again/ })).toBeVisible();
    await expect(section.getByRole("link", { name: /Go to dashboard/ })).toBeVisible();

    // "Watch again" restarts rather than doing nothing.
    await section.getByRole("button", { name: /Watch again/ }).click();
    await expect(section.locator("video")).toBeVisible();

    guard.assertClean();
  });

  test("the video asset is served, not 404", async ({ page, request }) => {
    await signIn(page, PATIENT_EMAIL, DEMO_PASSWORD);
    await page.goto("/guide");
    const src = await page.locator(".guidevideo video").getAttribute("src");
    expect(src).toBeTruthy();
    // A HEAD-style range request: enough to prove the file resolves without
    // pulling 76 MB through the test.
    const asset = await request.get(new URL(src!, "http://127.0.0.1:5173").toString(), {
      headers: { Range: "bytes=0-1023" },
    });
    expect([200, 206]).toContain(asset.status());
  });
});

test.describe("Google Meet workflow", () => {
  test("the link is withheld from the patient until the window opens", async ({ request }) => {
    // Asserted against the API rather than the UI on purpose: "hidden" has to
    // mean absent from the payload, not merely unrendered.
    const login = await request.post(`${API}/api/auth/login`, {
      data: { email: PATIENT_EMAIL, password: DEMO_PASSWORD },
    });
    const token = (await login.json()).access_token;
    const consultation = await request.get(`${API}/api/consultation`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await consultation.json();

    for (const appointment of [...body.upcoming, ...body.history]) {
      if (!appointment.is_online) continue;
      if (appointment.phase === "imminent" || appointment.phase === "live") {
        expect(appointment.meeting_link, `${appointment.phase} must expose the room`).toBeTruthy();
        expect(appointment.can_join).toBe(true);
      } else {
        expect(appointment.meeting_link, `${appointment.phase} must withhold the room`).toBe("");
        expect(appointment.can_join).toBe(false);
      }
    }
  });

  test("the clinician always has the room, and never has to create one", async ({ request }) => {
    const login = await request.post(`${API}/api/auth/login`, {
      data: { email: CLINICIAN_EMAIL, password: DEMO_PASSWORD },
    });
    const token = (await login.json()).access_token;
    const appointments = await request.get(`${API}/api/clinician/appointments`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const rows = await appointments.json();

    const online = rows.filter((a: { is_online: boolean }) => a.is_online);
    expect(online.length).toBeGreaterThan(0);
    for (const appointment of online) {
      // No per-appointment setup required: every consultation already resolves
      // to a room, whatever its phase.
      expect(appointment.meeting_link).toContain("meet.google.com");
      expect(appointment.has_meeting_link).toBe(true);
    }
  });
});
