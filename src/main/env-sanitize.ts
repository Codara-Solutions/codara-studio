// Nested-agent-CLI env sanitization.
//
// When Codara itself is launched from inside a Claude Code session (the
// standard way the dev instance gets started — `npm run dev` typed into a CC
// terminal), the Electron process inherits CC's nesting markers:
// CLAUDECODE=1, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_SESSION_ID, and friends.
// Every pty Codara spawns then re-inherits them, so any `claude` CLI Codara
// runs (chat backends, worker panes, standing terminals, or the user typing
// `claude` into a regular pane) believes it is a NESTED Claude Code child.
//
// Proven consequence on CC 2.1.201: a nested CC writes NO session JSONL
// transcript at all — which kills Codara's JSONL heartbeat, message tailing,
// and MCP-call tracking, so every chat turn times out at the 90s cap.
//
// The fix is central: pty-manager strips these keys from the inherited base
// env for EVERY pty it spawns, BEFORE layering the caller's explicit env
// overrides. Codara's own deliberate vars (CLAUDE_CODE_DISABLE_NONESSENTIAL_
// TRAFFIC, CLAUDE_CODE_HIDE_CWD, CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY — set
// via CliSessionOptions.env / SpawnOptions.env) are applied AFTER this strip,
// so they always survive.

// Exact-name nesting markers that don't share the CLAUDE_CODE_ prefix.
const NESTED_AGENT_ENV_EXACT = new Set([
  "CLAUDECODE",
  "CLAUDE_EFFORT",
  "CLAUDE_PLUGIN_DATA",
]);

/** True when `key` is a Claude Code session-nesting marker that must not
 *  leak into a spawned pty's environment. Everything under the CLAUDE_CODE_
 *  prefix counts (ENTRYPOINT, SESSION_ID, CHILD_SESSION, EXECPATH, SSE_PORT,
 *  EXPERIMENTAL_AGENT_TEAMS, …) plus the exact names above. */
export function isNestedAgentEnvKey(key: string): boolean {
  return key.startsWith("CLAUDE_CODE_") || NESTED_AGENT_ENV_EXACT.has(key);
}

/**
 * Delete every Claude Code nesting marker from `env`, in place. Call on an
 * env derived from process.env BEFORE applying any deliberate per-spawn
 * overrides, so an app-set CLAUDE_CODE_* key is preserved while inherited
 * leakage is dropped.
 */
export function sanitizeNestedAgentEnv(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (isNestedAgentEnvKey(key)) delete env[key];
  }
}

// electron-vite dev wiring.
//
// `npm run dev` exports these into the Electron process so the app finds the
// renderer dev server and electron-vite can relaunch Electron. No other tool
// defines them, and each one reconfigures the next electron-vite or Electron
// dev run started from a pane: ELECTRON_RENDERER_URL makes any `electron .`
// (every Playwright spec) load the LIVE dev server instead of its own
// out/renderer, and ELECTRON_EXEC_PATH / ELECTRON_MAJOR_VER / ELECTRON_ENTRY /
// ELECTRON_CLI_ARGS make another project's `electron-vite dev` launch this
// app's Electron binary and entry.
const ELECTRON_VITE_DEV_ENV = [
  "ELECTRON_RENDERER_URL",
  "ELECTRON_CLI_ARGS",
  "ELECTRON_ENTRY",
  "ELECTRON_EXEC_PATH",
  "ELECTRON_MAJOR_VER",
];
const ELECTRON_VITE_MODE_MARKER = "NODE_ENV_ELECTRON_VITE";

/**
 * Delete electron-vite's dev wiring from `env`, in place. NODE_ENV is a
 * user-facing variable, so it goes only while it still equals electron-vite's
 * mode marker (electron-vite overwrites NODE_ENV with that mode on every
 * dev/build/preview run); a NODE_ENV the user set survives.
 */
export function sanitizeElectronViteDevEnv(env: Record<string, string | undefined>): void {
  for (const key of ELECTRON_VITE_DEV_ENV) delete env[key];
  const mode = env[ELECTRON_VITE_MODE_MARKER];
  if (mode !== undefined && env.NODE_ENV === mode) delete env.NODE_ENV;
  delete env[ELECTRON_VITE_MODE_MARKER];
}

/**
 * A copy of process.env without electron-vite's dev wiring, for a child that
 * runs the user's own commands outside pty-manager (automation steps and
 * checks). Those must behave as they would from a plain terminal.
 */
export function processEnvWithoutElectronViteDev(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  sanitizeElectronViteDevEnv(env);
  return env;
}

// Codara's zsh integration dir. Must match the cache layout shell-init.ts
// materializes (<home>/.cache/spark/shell-integration/zsh). Matched by suffix
// rather than against this process's home: an instance started with another
// HOME (every e2e spec) still inherits the outer instance's dir.
const ZSH_INTEGRATION_DIR_SUFFIX = "/.cache/spark/shell-integration/zsh";

function isCodaraZshIntegrationDir(dir: string): boolean {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "").endsWith(ZSH_INTEGRATION_DIR_SUFFIX);
}

/**
 * The user's own ZDOTDIR behind `env`, or undefined when zsh should read the
 * startup files in $HOME. Inside a Codara pane ZDOTDIR is the integration dir
 * and the user's original, if they had one, is in SPARK_USER_ZDOTDIR. Taking
 * the integration dir itself for the user's makes each integration file
 * source itself until zsh aborts with "job table full or recursion limit
 * exceeded".
 */
export function userZdotdirFromEnv(env: Record<string, string | undefined>): string | undefined {
  const zdotdir = env.ZDOTDIR;
  if (!zdotdir) return undefined;
  if (!isCodaraZshIntegrationDir(zdotdir)) return zdotdir;
  const recorded = env.SPARK_USER_ZDOTDIR;
  return recorded && !isCodaraZshIntegrationDir(recorded) ? recorded : undefined;
}

/**
 * Give an env inherited from a Codara pane the user's own ZDOTDIR back, in
 * place. SPARK_USER_ZDOTDIR always goes: it only means something next to an
 * integration ZDOTDIR, and shell-init sets both afresh for an integrated
 * shell.
 */
export function restoreUserZdotdir(env: Record<string, string | undefined>): void {
  if (env.ZDOTDIR !== undefined && isCodaraZshIntegrationDir(env.ZDOTDIR)) {
    const user = userZdotdirFromEnv(env);
    if (user === undefined) delete env.ZDOTDIR;
    else env.ZDOTDIR = user;
  }
  delete env.SPARK_USER_ZDOTDIR;
}
