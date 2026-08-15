/**
 * End-to-end smoke coverage.
 *
 * One test per screen, each asserting three things: it rendered something only
 * that screen renders, the API calls behind it succeeded, and the browser
 * console stayed clean. That last assertion is the point of the suite — the
 * static checks already prove the code compiles.
 */

import { expect, test } from "@playwright/test";
import {
  CLINICIAN_EMAIL,
  PATIENT_EMAIL,
  attachConsoleGuard,
  currentTheme,
  login,
  navigateTo,
} from "./helpers";

/* ========================================================= authentication === */
test.describe("authentication", () => {
  test("login page renders and the API is reachable", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await page.goto("/");

    await expect(page.getByRole("heading", { name: /take control of your tinnitus/i })).toBeVisible();
    await expect(page.locator(".brand__mark")).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    guard.assertClean();
  });

  test("bad credentials show an error rather than a blank screen", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await page.goto("/");
    const form = page.locator("form");
    await form.getByLabel(/email/i).fill("nobody@example.com");
    await form.getByLabel(/password/i).fill("wrong-password");
    await form.getByRole("button", { name: /^sign in$/i }).click();

    await expect(page.getByText(/incorrect email or password/i)).toBeVisible();
    // A 401 here is the expected outcome, not a defect, so the guard is scoped
    // to script errors only — assertClean() would otherwise flag the login POST.
    expect(guard.errors.filter((e) => e.startsWith("[pageerror]"))).toEqual([]);
  });

  test("registration form opens with its extra fields", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await page.goto("/");
    await page.locator(".btn-group").getByRole("button", { name: /create account/i }).click();

    const form = page.locator("form");
    await expect(form.getByLabel(/full name/i)).toBeVisible();
    await expect(form.getByLabel(/account type/i)).toBeVisible();
    await expect(form.getByRole("button", { name: /create account/i })).toBeVisible();
    guard.assertClean();
  });

  test("a patient can sign in and sign out", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await login(page, PATIENT_EMAIL);

    await expect(page.locator(".rail__nav")).toContainText("Therapy");
    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();
    guard.assertClean();
  });
});

/* ================================================================ patient === */
test.describe("patient screens", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, PATIENT_EMAIL);
  });

  test("overview renders the dashboard", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator(".panel").first()).toBeVisible();
    guard.assertClean();
  });

  test("therapy renders the programme and its blocks", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await navigateTo(page, "Therapy", "/therapy");

    await expect(page.getByRole("heading", { name: /your programme/i })).toBeVisible();
    await expect(page.getByText(/28-day adherence/i)).toBeVisible();
    // The programme must actually list playable blocks — the original complaint
    // was that this screen showed nothing.
    await expect(page.getByRole("button", { name: /^start$/i }).first()).toBeVisible();
    guard.assertClean();
  });

  test("therapy pre-session panel opens without starting audio", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await navigateTo(page, "Therapy", "/therapy");
    await page.getByRole("button", { name: /^start$/i }).first().click();

    await expect(page.getByText(/how loud is your tinnitus right now/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /start ·/i })).toBeVisible();
    await page.getByRole("button", { name: /^cancel$/i }).click();
    guard.assertClean();
  });

  test("results opens on the plain-language summary", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await navigateTo(page, "Results", "/results");

    await expect(page.getByText(/your results in plain language/i)).toBeVisible();
    await expect(page.getByText(/overall hearing/i)).toBeVisible();
    await expect(page.getByText(/tinnitus severity/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: /key findings/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /risk indicators/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /what happens next/i })).toBeVisible();
    guard.assertClean();
  });

  test("the full clinical report is collapsed for patients and expands", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await navigateTo(page, "Results", "/results");

    const toggle = page.getByRole("button", { name: /view detailed clinical report/i });
    await expect(toggle).toBeVisible();
    await expect(page.locator("#full-clinical-report")).toHaveCount(0);

    await toggle.click();
    await expect(page.locator("#full-clinical-report")).toBeVisible();
    await expect(page.getByRole("heading", { name: /^audiometry$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /validated instruments/i })).toBeVisible();
    guard.assertClean();
  });

  test("support renders the conversation, the topic row and the crisis panel", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await navigateTo(page, "Support", "/support");

    await expect(page.getByRole("heading", { name: /everyday assistant companion/i })).toBeVisible();
    // The "What this is" card was removed; its disclaimer moved to the header
    // and must not have gone with it.
    await expect(page.getByText(/does not replace your audiologist/i)).toBeVisible();

    // The conversation now spans the content column rather than sitting beside a
    // 320px rail, and the topics sit underneath it.
    await expect(page.locator(".chatpanel__log")).toBeVisible();
    await expect(page.locator(".topicrow .topic").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /what this is/i })).toHaveCount(0);

    await expect(page.getByText(/if you need someone now/i)).toBeVisible();
    // Crisis numbers must be reachable without opening anything.
    await expect(page.locator("a.crisis-line__num").first()).toBeVisible();
    guard.assertClean();
  });

  test("the overview is a calm summary, not an analytics dashboard", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);

    await expect(page.getByRole("heading", { name: /how have you been today/i })).toBeVisible();
    await expect(page.locator(".quote__line")).toBeVisible();
    await expect(page.getByRole("heading", { name: /since your last assessment/i })).toBeVisible();

    // The charts, the Today tile and the Impact tile were removed outright.
    // Asserted by the panels that carried them, since the chart components are
    // plain inline SVG with no distinguishing class of their own.
    await expect(page.locator(".bento")).toHaveCount(0);
    await expect(page.locator(".stat")).toHaveCount(0);
    for (const gone of [/how you have been/i, /your hearing/i, /^today$/i, /^impact$/i, /^trends$/i]) {
      await expect(page.getByText(gone)).toHaveCount(0);
    }

    // Quick access sits above the fold.
    const quick = page.getByRole("navigation", { name: /quick access/i });
    await expect(quick.getByText("Therapy", { exact: true })).toBeVisible();
    await expect(quick.getByText("Support", { exact: true })).toBeVisible();
    guard.assertClean();
  });

  test("the wellness check records an answer and survives a reload", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    const option = page.getByRole("button", { name: "Difficult", exact: true });
    await option.click();
    await expect(option).toHaveAttribute("aria-pressed", "true");
    // A low answer offers a way out rather than just acknowledging it.
    await expect(page.getByRole("link", { name: /talk it through/i })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("button", { name: "Difficult", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    guard.assertClean();
  });

  test("doctor consultation shows the clinician's published schedule", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await navigateTo(page, "Doctor consultation", "/consultation");

    await expect(page.getByRole("heading", { name: /doctor consultation/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /clinical summary/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /consultation notes/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /consultation history/i })).toBeVisible();

    // Specialization, working days, hours and today's remaining capacity.
    await expect(page.getByText(/working days/i)).toBeVisible();
    await expect(page.getByText(/consultation hours/i)).toBeVisible();
    await expect(page.getByText(/free today/i)).toBeVisible();
    guard.assertClean();
  });

  test("booking starts by comparing doctors, then picking a time", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await navigateTo(page, "Doctor consultation", "/consultation");

    // The seeded patient already holds an appointment, so booking is closed
    // until it is released — which is the duplicate-booking guard working.
    const existing = page.getByRole("button", { name: /^cancel$/i });
    if (await existing.count()) {
      await expect(page.getByText(/already have an upcoming appointment/i)).toBeVisible();
      await existing.first().click();
      await expect(page.getByText(/appointment cancelled/i)).toBeVisible();
    }

    // Step 1: every doctor, comparable, with nobody pre-selected.
    await expect(page.getByText(/step 1 of 2/i)).toBeVisible();
    const cards = page.locator(".doctorcard");
    expect(await cards.count()).toBeGreaterThan(1);
    const first = cards.first();
    await expect(first.locator(".doctorcard__name")).toBeVisible();
    await expect(first.getByText(/working days/i)).toBeVisible();
    await expect(first.getByText(/in practice/i)).toBeVisible();

    // Step 2: only that doctor's slots.
    await first.getByRole("button", { name: /times$/i }).click();
    await expect(page.getByText(/step 2 of 2/i)).toBeVisible();
    await expect(page.getByRole("group", { name: /available days/i })).toBeVisible();

    const times = page.getByRole("group", { name: /available times/i });
    await expect(times).toBeVisible();
    // Taken slots must render disabled rather than vanish — a day with two free
    // times and a day with only two times have to look different.
    const slot = times.getByRole("button").and(page.locator(":not([disabled])")).first();
    const label = ((await slot.textContent()) ?? "").trim();
    await slot.click();

    const book = page.getByRole("button", { name: /^confirm /i });
    await expect(book).toBeEnabled();
    await book.click();
    await expect(page.getByText(/appointment confirmed/i)).toBeVisible();
    await expect(page.getByText(/awaiting confirmation/i)).toBeVisible();

    // Slot locking: cancelling releases the time again, which is what the
    // partial unique constraint excluding cancelled rows exists for.
    await page.getByRole("button", { name: /^cancel$/i }).first().click();
    await expect(page.getByText(/appointment cancelled/i)).toBeVisible();
    await page.reload();
    await page.locator(".doctorcard").first().getByRole("button", { name: /times$/i }).click();
    await expect(
      page.getByRole("group", { name: /available times/i }).getByRole("button", { name: label, exact: true })
    ).toBeEnabled();
    guard.assertClean();
  });

  test("a doctor is chosen, never assigned automatically", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await navigateTo(page, "Doctor consultation", "/consultation");
    const existing = page.getByRole("button", { name: /^cancel$/i });
    if (await existing.count()) {
      await existing.first().click();
      await expect(page.getByText(/appointment cancelled/i)).toBeVisible();
    }
    // No slot grid at all until a doctor has been picked.
    await expect(page.getByText(/you are not assigned one automatically/i)).toBeVisible();
    await expect(page.getByRole("group", { name: /available times/i })).toHaveCount(0);
    guard.assertClean();
  });

  test("the meeting button is disabled outside the consultation window", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await navigateTo(page, "Doctor consultation", "/consultation");

    // Every seeded appointment is days away, so the join affordance must exist
    // and must not be live. A button that opens early is as wrong as one that
    // never opens.
    const join = page.getByRole("button", { name: /opens |link not issued/i });
    if (await join.count()) {
      await expect(join.first()).toBeDisabled();
      await expect(page.getByRole("link", { name: /join meeting/i })).toHaveCount(0);
    }
    guard.assertClean();
  });

  test("the diary is gone: no rail entry and no route", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await expect(page.locator(".rail__nav")).not.toContainText("Diary");

    await page.goto("/diary");
    await expect(page.getByRole("heading", { name: /not found/i })).toBeVisible();
    guard.assertClean();
  });

  test("the 3D ear model lives in the report, not a page of its own", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await expect(page.locator(".rail__nav")).not.toContainText("Your ear");

    // A stale bookmark must land somewhere deliberate, not on a blank screen.
    await page.goto("/learn");
    await expect(page.getByRole("heading", { name: /not found/i })).toBeVisible();

    await navigateTo(page, "Results", "/results");
    await expect(page.getByRole("heading", { name: /inside your ear/i })).toBeVisible();
    // WebGL actually initialised rather than the fallback panel rendering.
    await expect(page.locator(".meaning .earmodel__canvas canvas")).toBeVisible({ timeout: 20_000 });
    guard.assertClean();
  });

  test("assessment starts and shows the intake step", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await navigateTo(page, "Assessment", "/assessment");

    await expect(page.locator(".steprail")).toBeVisible();
    await expect(page.getByText(/about you/i).first()).toBeVisible();
    guard.assertClean();
  });

  test("guide renders both audiences", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await navigateTo(page, "Guide", "/guide");

    await expect(page.getByRole("heading", { name: /the guide/i })).toBeVisible();
    await expect(page.getByText(/how it affects you/i).first()).toBeVisible();
    await page.getByRole("button", { name: /for clinicians/i }).click();
    await expect(page.getByRole("heading", { name: /red-flag screening/i })).toBeVisible();
    guard.assertClean();
  });

  test("an unknown route renders the not-found panel, not a blank page", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await page.goto("/does-not-exist");
    await expect(page.getByRole("heading", { name: /not found/i })).toBeVisible();
    guard.assertClean();
  });
});

/* ============================================================== clinician === */
test.describe("clinician screens", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, CLINICIAN_EMAIL);
  });

  test("caseload renders and the research extract downloads", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await expect(page).toHaveURL(/\/clinic$/);
    await expect(page.locator(".table").first()).toBeVisible();

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /research extract/i }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^echosense-research-extract-\d{4}-\d{2}-\d{2}\.csv$/);
    guard.assertClean();
  });

  test("opening a patient exposes their screens in the rail", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await page.locator(".table tbody tr").first().click();
    await expect(page).toHaveURL(/\/clinic\/patient\/\d+$/);

    // The routes existed before but nothing linked to them, so /therapy silently
    // redirected back to the caseload.
    await expect(page.locator(".rail__group")).toBeVisible();
    await page.locator(".rail__nav").getByRole("link", { name: "Therapy", exact: true }).click();
    await expect(page).toHaveURL(/\/therapy$/);
    await expect(page.getByRole("heading", { name: /your programme/i })).toBeVisible();
    guard.assertClean();
  });

  test("the model card is gone from the rail and the routes", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await expect(page.locator(".rail__nav")).not.toContainText("Model card");
    await page.goto("/model");
    await expect(page).toHaveURL(/\/clinic$/);
    guard.assertClean();
  });

  test("clinicians only reach the clinical record, not patient screens", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    for (const label of ["Your ear", "Therapy", "Support", "Assessment", "Doctor consultation", "Overview"]) {
      await expect(page.locator(".rail__nav")).not.toContainText(label);
    }
    // And typing the routes lands back on the caseload rather than rendering them.
    for (const route of ["/therapy", "/support", "/assessment", "/consultation", "/learn"]) {
      await page.goto(route);
      await expect(page).toHaveURL(/\/clinic$/);
    }
    guard.assertClean();
  });

  test("quick view and open record both load the clinical record", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    // Both used to 500: the view had lost its @api_view decorator to an edit
    // that inserted a helper between the decorator and the function, so DRF
    // never wrapped it and request.user did not exist.
    const row = page.locator(".table tbody tr[data-clickable]").first();
    await row.getByRole("button", { name: /quick view/i }).click();
    await expect(page.locator(".casedetail")).toBeVisible();
    await expect(page.getByText(/request failed/i)).toHaveCount(0);

    await page.locator(".table tbody tr[data-clickable]").first().click();
    await expect(page).toHaveURL(/\/clinic\/patient\/\d+$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(/request failed/i)).toHaveCount(0);
    guard.assertClean();
  });

  test("critical patients are surfaced at the top with a reason", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    // The seeded cohort deliberately contains a catastrophic THI, a pulsatile
    // red flag and a sudden asymmetric loss, so this block cannot be empty.
    const block = page.getByRole("heading", { name: /patients? needing attention/i });
    await expect(block).toBeVisible();

    const first = page.locator(".critcase").first();
    await expect(first).toBeVisible();
    // Name, severity, reason, last assessment date and a quick view.
    await expect(first.locator(".critcase__name")).toBeVisible();
    await expect(first.locator(".critcase__reasons li").first()).toBeVisible();
    await expect(first.getByText(/assessed/i)).toBeVisible();
    await expect(first.getByRole("button", { name: /quick view/i })).toBeVisible();
    guard.assertClean();
  });

  test("quick view renders the patient's own 3D cochlea in the case", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await page.locator(".table tbody tr").first().getByRole("button", { name: /quick view/i }).click();

    const detail = page.locator(".casedetail");
    await expect(detail).toBeVisible();
    // WebGL actually initialised rather than the fallback panel rendering.
    await expect(detail.locator(".earmodel__canvas canvas")).toBeVisible({ timeout: 20_000 });
    await expect(detail.getByText(/hair cells coloured by/i)).toBeVisible();
    guard.assertClean();
  });

  test("the caseload lists only this clinician's patients", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    const rows = await page.locator(".table tbody tr[data-clickable]").count();
    // The demo splits twelve patients across two clinicians. Seeing all twelve
    // would mean the console fell back to the authorisation boundary.
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(12);
    guard.assertClean();
  });

  test("the schedule publishes working days, hours and remaining slots", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await expect(page.getByRole("heading", { name: /your consultation schedule/i })).toBeVisible();
    await expect(page.getByText(/specialization/i)).toBeVisible();
    await expect(page.getByText(/remaining today/i)).toBeVisible();
    guard.assertClean();
  });

  test("a clinician can set a meeting link on an appointment", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await expect(page.getByRole("heading", { name: /upcoming appointments/i })).toBeVisible();

    const edit = page.getByRole("button", { name: /add link|edit link/i }).first();
    if (!(await edit.count())) {
      // No teleaudiology appointment in this seed — nothing to assert against.
      guard.assertClean();
      return;
    }
    await edit.click();
    const field = page.getByLabel(/meeting link/i);
    await field.fill("https://meet.google.com/smo-ketd-est");
    await page.getByRole("button", { name: /save link/i }).click();
    await expect(page.getByText(/meeting link saved/i)).toBeVisible();

    // Rejected rather than stored: this is shown to a patient as "join your
    // consultation", so an arbitrary host is a phishing vector.
    await page.getByRole("button", { name: /edit link/i }).first().click();
    await page.getByLabel(/meeting link/i).fill("https://example.com/not-a-meeting");
    await page.getByRole("button", { name: /save link/i }).click();
    await expect(page.getByText(/valid https:\/\/ meeting link/i)).toBeVisible();
    guard.assertClean();
  });

  test("results opens expanded for a clinician", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await page.locator(".table tbody tr").first().click();
    await page.locator(".rail__nav").getByRole("link", { name: "Results", exact: true }).click();

    await expect(page.locator("#full-clinical-report")).toBeVisible();
    await expect(page.getByRole("button", { name: /hide detailed clinical report/i })).toBeVisible();
    guard.assertClean();
  });
});

/* ================================================================== theme === */
test.describe("theming", () => {
  test("the toggle switches themes and the rail stays readable", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await login(page, PATIENT_EMAIL);

    const before = await currentTheme(page);
    await page.getByRole("button", { name: /switch to (dark|light) mode/i }).click();
    const after = await currentTheme(page);
    expect(after).not.toBe(before);

    // The dark-mode regression that made this suite necessary: the rail is
    // filled with --ink, which inverts to bone, while its links were hardcoded
    // white. Assert the two actually differ in the rendered output.
    const contrastOk = await page.evaluate(() => {
      const link = document.querySelector(".rail__link");
      const rail = document.querySelector(".rail");
      if (!link || !rail) return false;
      const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = (rgb: number[]) => {
        const [r, g, b] = rgb.map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const a = lum(parse(getComputedStyle(link).color));
      const b = lum(parse(getComputedStyle(rail).backgroundColor));
      const [hi, lo] = a > b ? [a, b] : [b, a];
      return (hi + 0.05) / (lo + 0.05) >= 4.5;
    });
    expect(contrastOk, "rail link text must clear 4.5:1 against the rail").toBe(true);

    await page.reload();
    expect(await currentTheme(page)).toBe(after);
    guard.assertClean();
  });

  test("every patient screen renders in dark mode without console errors", async ({ page }, testInfo) => {
    const guard = attachConsoleGuard(page, testInfo);
    await login(page, PATIENT_EMAIL);
    await page.getByRole("button", { name: /switch to dark mode/i }).click();

    for (const [label, path] of [
      ["Assessment", "/assessment"],
      ["Therapy", "/therapy"],
      ["Support", "/support"],
      ["Doctor consultation", "/consultation"],
      ["Results", "/results"],
      ["Guide", "/guide"],
    ] as const) {
      await navigateTo(page, label, path);
      await expect(page.locator("main .panel, main .statuscard, main .steprail").first()).toBeVisible();
    }
    guard.assertClean();
  });
});
