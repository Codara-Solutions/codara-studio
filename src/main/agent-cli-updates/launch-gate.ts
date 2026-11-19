import { resolve } from "node:path";

// Only the app a person uses updates the machine's agent CLIs. A launch with
// its own Codara home (the unit suites that boot the built app, a throwaway
// instance) or under the e2e suite gets no update service, so a test can
// never update the tools installed on the machine running it. A pane exports
// SPARK_HOME_DIR as the real home, so Studio started from a Studio terminal
// still counts as the user's.
export function agentCliUpdatesAllowed(env: NodeJS.ProcessEnv, defaultHome: string): boolean {
  if (env.CODARA_DISABLE_AGENT_CLI_UPDATES === "1") return false;
  if (env.SPARK_E2E_BACKGROUND !== undefined) return false;
  return [env.CODARA_HOME_DIR, env.SPARK_HOME_DIR, env.SPARK_USER_DATA_DIR].every(
    (value) => !value?.trim() || resolve(value.trim()) === resolve(defaultHome),
  );
}
