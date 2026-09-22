import { defineConfig } from "@playwright/test";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { restoreUserZdotdir, sanitizeElectronViteDevEnv } from "./src/main/env-sanitize";

// Every spec launches Electron with `{ ...process.env, ... }`, so setting this
// here applies it to the whole suite: the app renders its window without
// activating, and a test run stops stealing the desktop from whoever is using
// the machine. Playwright drives the renderer over the debug protocol, which
// never needed OS focus in the first place. See src/main/index.ts.
// Assigned rather than forced, so a debugging run can watch the window with
// SPARK_E2E_BACKGROUND=0 npx playwright test.
process.env.SPARK_E2E_BACKGROUND ??= "1";

// A run started from a Codara pane inherits the pane's environment, and the
// test app must see what a plain terminal would give it instead:
// - electron-vite's dev wiring: ELECTRON_RENDERER_URL alone makes the test
//   app load the live `npm run dev` renderer instead of out/renderer.
// - CODARA_HOME_DIR / SPARK_HOME_DIR outrank a spec's SPARK_USER_DATA_DIR
//   and boot the test app on the real ~/.codarastudio.
// - The agent socket, hook RPC and pane ids address the live app, so a child
//   the test app spawns outside pty-manager would report into it.
// - A CLAUDE_CONFIG_DIR / GROK_HOME / CODEX_HOME inside a Codara home is one
//   of the user's managed accounts, which a test app with a fixture home
//   takes for the personal login.
// - ZDOTDIR names the outer instance's zsh integration dir.
// Specs that pin any of these set them after the spread, so theirs win.
const codaraHomes = [process.env.CODARA_HOME_DIR, process.env.SPARK_HOME_DIR, join(homedir(), ".codarastudio")]
  .map((home) => home?.trim())
  .filter((home): home is string => !!home)
  .map((home) => resolve(home));
for (const key of ["CLAUDE_CONFIG_DIR", "GROK_HOME", "CODEX_HOME"]) {
  const value = process.env[key]?.trim();
  if (value && codaraHomes.some((home) => resolve(value).startsWith(home + sep))) {
    delete process.env[key];
  }
}
for (const key of [
  "CODARA_HOME_DIR",
  "SPARK_HOME_DIR",
  "SPARK_AGENT_SOCKET",
  "SPARK_AGENT_TOKEN",
  "SPARK_AGENT_PANE_ID",
  "SPARK_HOOK_URL",
  "SPARK_HOOK_TOKEN",
  "SPARK_PANE_ID",
]) {
  delete process.env[key];
}
sanitizeElectronViteDevEnv(process.env);
restoreUserZdotdir(process.env);

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
