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
