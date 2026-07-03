import { defineConfig } from "@playwright/test";

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
