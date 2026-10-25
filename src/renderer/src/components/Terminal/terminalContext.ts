// "Copy terminal context": the pane's recent output (or the selection) and
// its working directory, as one block ready to paste into an agent's prompt.
// Panes register a reader here while mounted, so the pane toolbar and the
// keyboard command reach the same pane without holding React refs to it.

export interface BufferLineLike {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

export interface BufferLike {
  readonly length: number;
  getLine(y: number): BufferLineLike | undefined;
}

export interface TerminalContextSnapshot {
  cwd: string | null;
  shell: string | null;
  output: string;
  /** The output is what the user selected, not the latest lines. */
  fromSelection: boolean;
}

export const CONTEXT_MAX_LINES = 200;
export const CONTEXT_MAX_CHARS = 24_000;

/**
 * The last `maxLines` logical lines of a buffer, rows that wrapped joined back
 * into one line, blank rows at the bottom dropped and long blank runs
 * squeezed to one.
 */
export function readRecentOutput(
  buffer: BufferLike,
  maxLines: number = CONTEXT_MAX_LINES,
  maxChars: number = CONTEXT_MAX_CHARS,
): string {
  const lines: string[] = [];
  let end = buffer.length - 1;
  while (end >= 0 && !buffer.getLine(end)?.translateToString(true).trim()) end -= 1;
  // Walk up from the last non-blank row until enough logical lines are in
  // hand. A logical line starts at the first row of a wrap chain.
  let current = "";
  // A row that continues on the next one keeps its trailing spaces: the wrap
  // may have fallen right after a space between two words.
  let continues = false;
  let chars = 0;
  // `current` counts too: one logical line can wrap across the whole
  // scrollback (minified JSON, a progress bar without newlines), and reading
  // all of it only to keep the last maxChars would build a string of megabytes.
  for (
    let y = end;
    y >= 0 && lines.length < maxLines && chars + current.length < maxChars;
    y -= 1
  ) {
    const line = buffer.getLine(y);
    if (!line) continue;
    current = line.translateToString(!continues) + current;
    continues = line.isWrapped;
    if (continues) continue;
    lines.push(current.trimEnd());
    chars += current.length + 1;
    current = "";
  }
  if (current) lines.push(current.trimEnd());
  lines.reverse();
  let text = squeezeBlankLines(lines).join("\n").replace(/^\n+/, "");
  if (text.length > maxChars) {
    text = text.slice(text.length - maxChars);
    const firstBreak = text.indexOf("\n");
    if (firstBreak !== -1) text = text.slice(firstBreak + 1);
  }
  return text;
}

function squeezeBlankLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line === "" && out.length > 0 && out[out.length - 1] === "") continue;
    out.push(line);
  }
  return out;
}

/** A fence longer than any backtick run inside the text, so it cannot end early. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

function countLines(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

export function formatTerminalContext(snapshot: TerminalContextSnapshot): string {
  // trimEnd, not /\s+$/: that regex retries from every space of every run and
  // takes a noticeable pause on a large selection padded with spaces.
  const output = snapshot.output.replace(/\r\n?/g, "\n").trimEnd();
  const header = ["Terminal context"];
  if (snapshot.cwd) header.push(`Working directory: ${snapshot.cwd}`);
  if (snapshot.shell) header.push(`Shell: ${snapshot.shell}`);
  if (!output) {
    header.push("No output yet.");
    return `${header.join("\n")}\n`;
  }
  const count = countLines(output);
  header.push(
    snapshot.fromSelection
      ? `Selected output (${count} ${count === 1 ? "line" : "lines"}):`
      : `Last ${count} ${count === 1 ? "line" : "lines"} of output:`,
  );
  const fence = fenceFor(output);
  return `${header.join("\n")}\n\n${fence}text\n${output}\n${fence}\n`;
}

// ── Registry ────────────────────────────────────────────────────────────────

type ContextSource = () => TerminalContextSnapshot | null;

const sources = new Map<string, ContextSource>();

/** Called by a mounted, input-owning pane. Returns the unregister function. */
export function registerTerminalContextSource(sessionId: string, source: ContextSource): () => void {
  sources.set(sessionId, source);
  return () => {
    if (sources.get(sessionId) === source) sources.delete(sessionId);
  };
}

export function readTerminalContext(sessionId: string): TerminalContextSnapshot | null {
  try {
    return sources.get(sessionId)?.() ?? null;
  } catch {
    return null;
  }
}
