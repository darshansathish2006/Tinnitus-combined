/**
 * Browser smoke tests.
 *
 * These exist because typecheck, build and API checks all pass on code that
 * throws the moment React renders it — a null dereference in a component, a
 * missing route, a stylesheet that hides its own text. Nothing before this
 * actually loaded the app.
 *
 * The suite starts both servers itself, so `npm run test:e2e` works from a cold
 * checkout. `scripts/run.mjs smoke` points the API at a throwaway SQLite file
 * first, so exercising it never writes audit rows into the demo cohort.
 */

import { defineConfig, devices } from "@playwright/test";

const WEB = "http://127.0.0.1:5273";
const API = "http://127.0.0.1:8055";

export default defineConfig({
  testDir: "./tests/e2e",
  // Rendering, navigation and audio-context setup are slower than a unit test
  // but nothing here should take 30 s; a timeout is a real hang.
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: WEB,
    // 127.0.0.1 deliberately, not localhost: it proves the IPv4 loopback fix and
    // would have caught the IPv6-only bind that made the dev server look broken.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],

  webServer: [
    {
      // The venv is resolved by run.mjs, which also handles .venv vs venv.
      command: "node ../scripts/run.mjs manage runserver 8055 --noreload",
      url: `${API}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `npx vite --port 5273 --strictPort --host 127.0.0.1`,
      url: WEB,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
      env: { VITE_API_BASE: API },
    },
  ],
});
