// CODARA_FEEDBACK_ADMIN_TOKEN, taken out of the environment before anything
// else runs (index.ts imports this module second), so no terminal, agent or
// other child Codara starts inherits it: an agent holding the token could
// delete feedback on the service without the question Studio asks.

export const FEEDBACK_ADMIN_TOKEN_ENV = "CODARA_FEEDBACK_ADMIN_TOKEN";

const captured = (process.env[FEEDBACK_ADMIN_TOKEN_ENV] ?? "").trim();
delete process.env[FEEDBACK_ADMIN_TOKEN_ENV];

export function feedbackAdminEnvToken(): string {
  return captured;
}
