// OSC 133 (FinalTerm) and OSC 633 (VS Code) prompt markers, as printed by
// resources/shell-integration: C before a command runs, D;<exit> after it.
// Kept free of imports so pty-manager can scan every chunk with it.
export const SHELL_MARKER = /\x1b\](?:133|633);([ABCD])(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)/g;

export type ShellActivity = "running" | "idle" | null;

/** Whether the pane's shell last reported a running command or a prompt. */
export function shellActivity(tail: Buffer | null): ShellActivity {
  if (!tail || tail.length === 0) return null;
  const text = tail.toString("latin1");
  let last: string | null = null;
  SHELL_MARKER.lastIndex = 0;
  for (let match = SHELL_MARKER.exec(text); match; match = SHELL_MARKER.exec(text)) {
    last = match[1];
  }
  if (last === null) return null;
  return last === "C" ? "running" : "idle";
}

/**
 * A chunk's shell activity, or null when it holds no marker. The byte search
 * runs first so the regex never sees the bulk of a busy agent's output.
 */
export function chunkShellActivity(chunk: Buffer): ShellActivity {
  if (!chunk.includes("\x1b]133;") && !chunk.includes("\x1b]633;")) return null;
  return shellActivity(chunk);
}
