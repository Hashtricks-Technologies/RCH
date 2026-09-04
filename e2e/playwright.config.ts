import { defineConfig, devices } from "@playwright/test";

/**
 * One browser, no retries locally, one worker.
 *
 * The smoke writes into a real database — it sells, it issues, it receives goods — so two workers
 * racing the same seed would fight over the same shelf and fail for reasons that have nothing to
 * do with the code. Retries are off locally for the same reason: a retry re-runs a scenario whose
 * first attempt already moved stock. In CI one retry is allowed *only* because the cluster is
 * thrown away afterwards and a flake there is more often a port-forward than a defect.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  // The app is a HashRouter served from any host with no SPA rewrite, so every URL the smoke
  // navigates to is "/#/<key>" — never "/<key>", which the static server answers with a 404.
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
