// CLI worker launch commands. These strings are passed to a fresh PTY as an
// `autorun` so the shell auto-launches the worker once the prompt is ready.
// Kept in a tiny module so the pane-toolbar dropdown (TerminalStack) and the
// keybind handlers (App.tsx) share one source of truth.

export const CLAUDE_LAUNCH_COMMAND = "claude --dangerously-skip-permissions";
export const CODEX_LAUNCH_COMMAND = "codex --yolo";
// Cursor's CLI worker — only the composer-2.5-fast model is supported, no flags.
export const CURSOR_LAUNCH_COMMAND = "agent";
