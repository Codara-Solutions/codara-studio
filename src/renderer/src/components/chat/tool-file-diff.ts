// GitHub-style per-file change view for the MANAGER's own file-mutating tool
// calls. Workers already report measured Git diffs (attempt.diffSummary); the
// main agent's edits only exist as streamed tool input, so the renderer
// reconstructs the change from the call payload itself:
//   edit  -> { path, edits: [{ oldText, newText }] }
//   write -> { path, content }
// No filesystem access and no backend round-trip: what you see is exactly
// what the model asked to change, computed locally from the event journal.

export interface ToolDiffLine {
  kind: "add" | "del";
  text: string;
}

export interface ToolFileChange {
  path: string;
  additions: number;
  deletions: number;
  lines: ToolDiffLine[];
  /** True when the change was bigger than MAX_TOOL_DIFF_LINES and lines[] was cut off. */
  truncated: boolean;
}

/** Hard cap on collected diff lines. Guards against a whole-file rewrite
 * flooding both memory and the conversation; the UI shows an even smaller
 * preview and points at the disclosure for the raw payload. */
export const MAX_TOOL_DIFF_LINES = 2000;

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  // A trailing newline is a line terminator, not an empty extra line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function normalizeToolName(toolName: string): string {
  return toolName.replace(/^mcp__[^_]+__/, "").toLowerCase();
}

function inputRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

// Some models send edits as a JSON string instead of an array; pi tolerates
// that on the execution side, so the viewer tolerates it too.
function parseEdits(value: unknown): Array<{ oldText: string; newText: string }> {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).oldText === "string" &&
        typeof (entry as Record<string, unknown>).newText === "string",
    )
    .map((entry) => ({
      oldText: entry.oldText as string,
      newText: entry.newText as string,
    }));
}

/**
 * The file change one manager tool call describes, or null when the call does
 * not mutate a file (reads, commands, orchestration calls) or carries no
 * usable payload yet (input streams complete, but replay of a foreign runtime
 * may omit it).
 */
export function toolFileDiff(toolName: string, input: unknown): ToolFileChange | null {
  const normalized = normalizeToolName(toolName);
  const value = inputRecord(input);
  if (!value) return null;
  const path = typeof value.path === "string" ? value.path : null;
  if (!path) return null;

  const lines: ToolDiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let truncated = false;

  const pushChangedLines = (kind: ToolDiffLine["kind"], changed: string[]): void => {
    // Stats describe the full requested change even when the visual sample is
    // capped. Counting only collected rows made a 5,000-line write report
    // +2,000, which looked precise while being wrong.
    if (kind === "add") additions += changed.length;
    else deletions += changed.length;
    const available = Math.max(0, MAX_TOOL_DIFF_LINES - lines.length);
    for (const line of changed.slice(0, available)) lines.push({ kind, text: line });
    if (changed.length > available) truncated = true;
  };
  const pushLines = (kind: ToolDiffLine["kind"], text: string): void => {
    pushChangedLines(kind, splitLines(text));
  };

  if (
    ["edit", "multiedit", "multi_edit", "str_replace", "str_replace_editor"].includes(normalized)
  ) {
    // Targeted replacements: every removed line is a deletion, every
    // replacement line an addition. Multiple edits[] entries concatenate in
    // call order, which reads exactly like the hunks they touch.
    const direct =
      typeof value.oldText === "string" && typeof value.newText === "string"
        ? [{ oldText: value.oldText, newText: value.newText }]
        : [];
    const seenEdits = new Set<string>();
    const edits = [...parseEdits(value.edits), ...direct].filter((edit) => {
      const key = `${edit.oldText.length}:${edit.oldText}${edit.newText}`;
      if (seenEdits.has(key)) return false;
      seenEdits.add(key);
      return true;
    });
    if (edits.length === 0) return null;
    for (const edit of edits) {
      const before = splitLines(edit.oldText);
      const after = splitLines(edit.newText);
      // Models often include unchanged boundary lines to make oldText unique.
      // Trim those shared edges so the preview counts the actual replacement,
      // not its matching context, as changed.
      let prefix = 0;
      while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
        prefix += 1;
      }
      let suffix = 0;
      while (
        suffix < before.length - prefix &&
        suffix < after.length - prefix &&
        before[before.length - suffix - 1] === after[after.length - suffix - 1]
      ) {
        suffix += 1;
      }
      const removed = before.slice(prefix, before.length - suffix);
      const added = after.slice(prefix, after.length - suffix);
      if (removed.length > 0) pushChangedLines("del", removed);
      if (added.length > 0) pushChangedLines("add", added);
    }
  } else if (["write", "write_file", "writefile", "create_file", "save"].includes(normalized)) {
    // Full-content writes carry no previous text in their payload, so the
    // whole body reports as additions (the honest reading for a new file,
    // and the standard convention elsewhere for overwrites).
    const content = typeof value.content === "string" ? value.content : null;
    if (!content) return null;
    pushLines("add", content);
  } else {
    return null;
  }

  if (lines.length === 0) return null;
  return { path, additions, deletions, lines, truncated };
}
