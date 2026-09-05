/**
 * Run the e2e specs against servers that are already up.
 *
 * `playwright.config.ts` starts its own API and dev server on isolated ports,
 * which is the right default. It cannot be used in this checkout because
 * `backend/.venv` exists but is empty, and `scripts/run.mjs` resolves it ahead
 * of the populated `backend/venv` — so the API never starts.
 *
 * Until that is fixed (delete the empty `backend/.venv`, or run `npm run
 * setup`), start the two servers by hand and point Playwright here:
 *
 *   backend/venv/Scripts/python manage.py runserver 127.0.0.1:9000 --noreload
 *   npx vite --port 5173 --strictPort --host 127.0.0.1
 *   npx playwright test --config=playwright.local.config.ts
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /(i18n|features|onboarding|smoke)\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
});
