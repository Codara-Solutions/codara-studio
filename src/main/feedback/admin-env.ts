// CODARA_FEEDBACK_ADMIN_TOKEN, taken out of the environment before anything
// else runs (index.ts imports this module second), so no terminal, agent or
// other child Codara starts inherits it.
//
// Only a development run honours it (npm run dev, the e2e specs): a packaged
// Studio ignores it and uses only the token saved in Settings. A launch
// environment stays readable to programs under the same account (Linux
// /proc/<pid>/environ), and the admin tools hand strangers' text to agents:
// one that followed such text could read the token there and call the admin
// API itself, skipping the delete question.

export const FEEDBACK_ADMIN_TOKEN_ENV = "CODARA_FEEDBACK_ADMIN_TOKEN";

const captured = (process.env[FEEDBACK_ADMIN_TOKEN_ENV] ?? "").trim();
delete process.env[FEEDBACK_ADMIN_TOKEN_ENV];

/** The launch token in a development run; empty in a packaged app. */
export function feedbackAdminEnvToken(packaged: boolean): string {
  return packaged ? "" : captured;
}
