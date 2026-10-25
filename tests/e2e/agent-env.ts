// The environment for a test app and the agent processes a spec starts next
// to it (the stdio MCP server, `cora`): none of the SPARK_* / CODARA_* a
// Codara pane leaks into the run, or they would reach the user's own Codara.
// The runner's isolation flags (playwright.config.ts) stay: without them the
// app takes the desktop, answers the user's Chrome extension, and shows the
// first-run dialogs no spec drives.
const RUNNER_FLAGS = new Set(["SPARK_E2E_BACKGROUND", "CODARA_CHROME_LINK"]);

export function cleanEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || (/^(SPARK|CODARA)_/.test(key) && !RUNNER_FLAGS.has(key))) continue;
    env[key] = value;
  }
  return { ...env, CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_USER_DATA_DIR: home };
}
