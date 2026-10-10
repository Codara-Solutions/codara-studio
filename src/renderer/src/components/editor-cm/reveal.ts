// A position to show once an editor for the path has its document. Opening a
// file and revealing a line are separate steps: the tab may not exist yet, and
// its CodeMirror view mounts only after the file has been read.

export interface EditorRevealTarget {
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column?: number;
}

export const EDITOR_REVEAL_EVENT = "spark:editor-reveal";

const pending = new Map<string, EditorRevealTarget>();

export function requestEditorReveal(path: string, target: EditorRevealTarget): void {
  pending.set(path, target);
  window.dispatchEvent(new CustomEvent(EDITOR_REVEAL_EVENT, { detail: { path } }));
}

export function takeEditorReveal(path: string): EditorRevealTarget | undefined {
  const target = pending.get(path);
  pending.delete(path);
  return target;
}

/** Document offset for a 1-based line and column, clamped into the text. */
export function revealOffset(
  doc: { lines: number; line: (n: number) => { from: number; to: number } },
  target: EditorRevealTarget,
): number {
  const lineNumber = Math.min(Math.max(1, Math.floor(target.line) || 1), doc.lines);
  const line = doc.line(lineNumber);
  const column = Math.max(1, Math.floor(target.column ?? 1) || 1);
  return Math.min(line.from + column - 1, line.to);
}
