// CLI worker launch commands. These strings are passed to a fresh PTY as an
// `autorun` so the shell auto-launches the worker once the prompt is ready.
// Kept in a tiny module so the pane-toolbar dropdown (TerminalStack) and the
// keybind handlers (App.tsx) share one source of truth.

export const CLAUDE_LAUNCH_COMMAND = "claude --dangerously-skip-permissions";
export const CODEX_LAUNCH_COMMAND = "codex --yolo";
// Cursor's CLI worker — only the composer-2.5-fast model is supported, no flags.
export const CURSOR_LAUNCH_COMMAND = "agent";

// True when an autorun command launches an agent CLI (claude/codex). Such
// panes spawn with SPARK_NO_SHELL_INTEGRATION=1 so pwsh can take the
// command over args (-NoProfile -NoExit -Command …) — see withStartupCommand
// in src/main/pty-manager.ts — which removes the 1500ms type-after-mount race.
// Cursor is deliberately excluded: its runtime detection relies on the OSC
// 633;E command echo that shell integration provides.
export function isAgentSessionLaunchCommand(command: string | undefined | null): boolean {
  const cmd = command?.trim();
  if (!cmd) return false;
  return cmd.startsWith(CLAUDE_LAUNCH_COMMAND) || cmd.startsWith(CODEX_LAUNCH_COMMAND);
}
