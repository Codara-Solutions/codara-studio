// CLI worker launch commands. These strings are passed to a fresh PTY as an
// `autorun` so the shell auto-launches the worker once the prompt is ready.
// Kept in a tiny module so the pane-toolbar dropdown (TerminalStack) and the
// keybind handlers (App.tsx) share one source of truth.

export const CLAUDE_LAUNCH_COMMAND = "claude --dangerously-skip-permissions";
export const CODEX_LAUNCH_COMMAND = "codex --yolo";
// Cursor's CLI worker — only the composer-2.5-fast model is supported, no flags.
export const CURSOR_LAUNCH_COMMAND = "agent";

// Runtimes whose CLI sessions Codara can capture + restore across app restarts.
export type AgentSessionRuntime = "claude" | "codex";

// Fresh Claude launch with a Codara-minted session id. Forcing `--session-id`
// makes the transcript path deterministic (~/.claude/projects/<enc-cwd>/<id>.jsonl)
// and lets a pane record its resume pointer synchronously at launch — no fragile
// post-hoc "newest .jsonl by mtime" discovery, which mis-binds when several Claude
// sessions share one cwd. Mirrors the chat backend (claude-backend.ts:828-833).
// Codex has no `--session-id`, so it keeps the bare command + disk discovery.
export function buildClaudeLaunch(): { command: string; sessionId: string } {
  const sessionId = crypto.randomUUID();
  return {
    command: `${CLAUDE_LAUNCH_COMMAND} --session-id ${sessionId}`,
    sessionId,
  };
}

// True when an autorun command launches a restorable agent CLI (claude/codex).
// Such panes spawn with SPARK_NO_SHELL_INTEGRATION=1 so pwsh can take the
// command over args (-NoProfile -NoExit -Command …) — see withStartupCommand
// in src/main/pty-manager.ts — which removes the 1500ms type-after-mount race.
// Cursor is deliberately excluded: its runtime detection relies on the OSC
// 633;E command echo that shell integration provides.
export function isAgentSessionLaunchCommand(command: string | undefined | null): boolean {
  const cmd = command?.trim();
  if (!cmd) return false;
  return cmd.startsWith(CLAUDE_LAUNCH_COMMAND) || cmd.startsWith(CODEX_LAUNCH_COMMAND);
}

// Resume-command builders — the autorun typed into a restored pane's fresh
// shell on reopen. These mirror the (main-side) provider `buildResumeArgs` in
// src/main/providers/{claude,codex}.ts (`-r <id>` / `resume <id>`), rendered as
// a single shell string because the terminal pane types one command, not argv.
export function buildClaudeResumeCommand(sessionId: string): string {
  return `${CLAUDE_LAUNCH_COMMAND} --resume ${sessionId}`;
}

export function buildCodexResumeCommand(sessionId: string): string {
  return `codex resume ${sessionId} --yolo`;
}

export function buildAgentResumeCommand(session: {
  runtime: AgentSessionRuntime;
  sessionId: string;
}): string {
  return session.runtime === "claude"
    ? buildClaudeResumeCommand(session.sessionId)
    : buildCodexResumeCommand(session.sessionId);
}
