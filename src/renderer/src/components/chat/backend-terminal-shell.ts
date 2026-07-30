import type { ShellInfo } from "@shared/types";

// Placeholder ShellInfo passed to TerminalPane when the underlying PTY was
// already spawned by main-process backend code (claude-backend, codex-backend).
// pty-manager's existing-session branch ignores the shell when an id is already
// registered, but the React prop is required. A no-op executable also makes an
// accidental spawn fail closed if id matching ever regresses.
export const BACKEND_TERMINAL_SHELL: ShellInfo = {
  id: "spark-backend-attached",
  label: "Backend PTY",
  exe: "noop",
  args: [],
  family: "other",
};
