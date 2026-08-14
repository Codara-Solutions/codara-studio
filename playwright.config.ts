import { defineConfig } from "@playwright/test";

// Every spec launches Electron with `{ ...process.env, ... }`, so setting this
// here applies it to the whole suite: the app renders its window without
// activating, and a test run stops stealing the desktop from whoever is using
// the machine. Playwright drives the renderer over the debug protocol, which
// never needed OS focus in the first place. See src/main/index.ts.
// Assigned rather than forced, so a debugging run can watch the window with
// SPARK_E2E_BACKGROUND=0 npx playwright test.
process.env.SPARK_E2E_BACKGROUND ??= "1";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  // One worker: each spec file boots a real Electron app; parallel workers
  // stack several apps on the machine at once, which both floods the screen
  // with windows and pushes slow flows past the 30s test timeout.
  workers: 1,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
