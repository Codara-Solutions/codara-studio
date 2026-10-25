import type { ElectronApplication } from "playwright";

// The environment for a test app and the agent processes a spec starts next
// to it (the stdio MCP server, `cora`): none of the SPARK_* / CODARA_* a
// Codara pane leaks into the run, or they would reach the user's own Codara.
// The runner's isolation flags (playwright.config.ts) stay: without them the
// app takes the desktop, answers the user's Chrome extension, uses the
// system keyring, and shows the first-run dialogs no spec drives.
// CODARA_E2E_SEED_TERMINAL is not one of them: it seeds a terminal for specs
// written before workspaces opened empty. These specs drive the browser tab
// of an empty workspace, and a seeded terminal would push that tab into the
// background, where events Chromium delivers with a frame (a dialog's close)
// wait until the tab is shown.
export const RUNNER_FLAGS = [
  "SPARK_E2E_BACKGROUND",
  "CODARA_CHROME_LINK",
  "CODARA_DISABLE_KEYCHAIN",
] as const;

const KEPT = new Set<string>(RUNNER_FLAGS);

export function cleanEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || (/^(SPARK|CODARA)_/.test(key) && !KEPT.has(key))) continue;
    env[key] = value;
  }
  return { ...env, CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_USER_DATA_DIR: home };
}

/** The runner's isolation flags as this test process has them, and as a launched app sees them. */
export async function runnerFlags(app: ElectronApplication): Promise<{ runner: Record<string, string | null>; app: Record<string, string | null> }> {
  const runner = Object.fromEntries(RUNNER_FLAGS.map((key) => [key, process.env[key] ?? null]));
  const seen = await app.evaluate((_electron, keys) => Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null])), [...RUNNER_FLAGS]);
  return { runner, app: seen };
}
