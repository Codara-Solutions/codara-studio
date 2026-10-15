// The review tab's model, free of React so scripts/test-review-notes.cjs can
// pin it: each file's diff split into its header and hunks with old and new
// line numbers, the flat row list the virtualized view renders (files, hunks,
// lines, notes and the open draft), what a selection of lines quotes and
// where its note is anchored, and the one-hunk patch hunk staging applies.

import {
  clampQuote,
  type ReviewDiffFile,
  type ReviewDiffLine,
  type ReviewNote,
  type ReviewNoteSide,
} from "@shared/review-notes";

export interface HunkInfo {
  /** Index of the @@ line in file.lines. */
  lineIndex: number;
  header: string;
  oldStart: number;
  newStart: number;
  /** Body is file.lines[bodyStart, bodyEnd). */
  bodyStart: number;
  bodyEnd: number;
  added: number;
  removed: number;
}

export interface FileStructure {
  /** Meta lines before the first hunk: diff --git, index, ---, +++, modes. */
  header: string[];
  hunks: HunkInfo[];
  /** Per line of file.lines; null for hunk and meta lines. */
  oldNos: Array<number | null>;
  newNos: Array<number | null>;
  conflicted: boolean;
}

const HUNK_RE = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function isConflictMarker(text: string): boolean {
  const body = text.slice(1);
  return /^(<{7}|={7}|>{7}|\|{7})/.test(body);
}

const structures = new WeakMap<ReviewDiffFile, FileStructure>();

/** The file's header, hunks and line numbers, computed once per loaded file. */
export function fileStructure(file: ReviewDiffFile): FileStructure {
  const cached = structures.get(file);
  if (cached) return cached;
  const lines = file.lines ?? [];
  const header: string[] = [];
  const hunks: HunkInfo[] = [];
  const oldNos: Array<number | null> = new Array(lines.length).fill(null);
  const newNos: Array<number | null> = new Array(lines.length).fill(null);
  let current: HunkInfo | null = null;
  let oldNo = 0;
  let newNo = 0;
  let conflicted = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.kind === "hunk") {
      if (current) current.bodyEnd = i;
      const match = HUNK_RE.exec(line.text);
      current = {
        lineIndex: i,
        header: line.text,
        oldStart: match ? Number(match[1]) : 0,
        newStart: match ? Number(match[2]) : 0,
        bodyStart: i + 1,
        bodyEnd: lines.length,
        added: 0,
        removed: 0,
      };
      oldNo = current.oldStart;
      newNo = current.newStart;
      hunks.push(current);
      continue;
    }
    if (!current) {
      if (line.kind === "meta") header.push(line.text);
      continue;
    }
    if (line.kind === "meta") {
      // "\ No newline at end of file" belongs to the hunk; anything else ends it.
      if (!line.text.startsWith("\\")) {
        current.bodyEnd = i;
        current = null;
      }
      continue;
    }
    if ((line.kind === "add" || line.kind === "context") && isConflictMarker(line.text)) conflicted = true;
    if (line.kind === "context") {
      oldNos[i] = oldNo++;
      newNos[i] = newNo++;
    } else if (line.kind === "del") {
      oldNos[i] = oldNo++;
      current.removed++;
    } else if (line.kind === "add") {
      newNos[i] = newNo++;
      current.added++;
    }
  }
  const structure: FileStructure = { header, hunks, oldNos, newNos, conflicted };
  structures.set(file, structure);
  return structure;
}

/** A one-hunk patch: the file header, the @@ line and the hunk body, verbatim. */
export function hunkPatch(file: ReviewDiffFile, hunk: HunkInfo): string {
  const lines = file.lines ?? [];
  const parts = [...fileStructure(file).header, hunk.header, ...lines.slice(hunk.bodyStart, hunk.bodyEnd).map((line) => line.text)];
  return `${parts.join("\n")}\n`;
}

export interface NoteAnchor {
  path: string;
  side: ReviewNoteSide;
  startLine: number;
  endLine: number;
}

/** A selection of lines, by index into file.lines, in either direction. */
export interface LineSelection {
  path: string;
  from: number;
  to: number;
}

function ordered(selection: LineSelection): [number, number] {
  return selection.from <= selection.to ? [selection.from, selection.to] : [selection.to, selection.from];
}

/**
 * Where a note on the selected lines is anchored: the new file's lines when
 * the selection has any, otherwise the removed lines in the old file.
 */
export function anchorFor(file: ReviewDiffFile, selection: LineSelection): NoteAnchor | null {
  const structure = fileStructure(file);
  const [a, b] = ordered(selection);
  let newMin = Infinity;
  let newMax = -Infinity;
  let oldMin = Infinity;
  let oldMax = -Infinity;
  for (let i = a; i <= b; i++) {
    const n = structure.newNos[i];
    const o = structure.oldNos[i];
    if (n != null) {
      newMin = Math.min(newMin, n);
      newMax = Math.max(newMax, n);
    }
    if (o != null) {
      oldMin = Math.min(oldMin, o);
      oldMax = Math.max(oldMax, o);
    }
  }
  if (newMax >= newMin) return { path: file.path, side: "new", startLine: newMin, endLine: newMax };
  if (oldMax >= oldMin) return { path: file.path, side: "old", startLine: oldMin, endLine: oldMax };
  return null;
}

/** The selected lines as quoted to the agent, with their +, - or space; "…" where hunks skip lines. */
export function quoteFor(file: ReviewDiffFile, selection: LineSelection): string {
  const lines = file.lines ?? [];
  const [a, b] = ordered(selection);
  const out: string[] = [];
  for (let i = a; i <= b && i < lines.length; i++) {
    const line = lines[i];
    if (line.kind === "hunk") {
      if (out.length) out.push("…");
      continue;
    }
    if (line.kind === "meta") continue;
    // A CRLF file's lines keep their CR for hunk patches; quotes do not.
    out.push(line.text.endsWith("\r") ? line.text.slice(0, -1) : line.text);
  }
  return clampQuote(out.join("\n"));
}

/** The line index a note's anchor ends on in this diff, or -1 when that line is not shown. */
export function anchorLineIndex(file: ReviewDiffFile, anchor: Pick<NoteAnchor, "side" | "endLine">): number {
  const structure = fileStructure(file);
  const numbers = anchor.side === "old" ? structure.oldNos : structure.newNos;
  return numbers.indexOf(anchor.endLine);
}

/** The line indexes a note covers in this diff, for highlighting; empty when not shown. */
export function anchorRange(file: ReviewDiffFile, anchor: Pick<NoteAnchor, "side" | "startLine" | "endLine">): [number, number] | null {
  const structure = fileStructure(file);
  const numbers = anchor.side === "old" ? structure.oldNos : structure.newNos;
  let first = -1;
  let last = -1;
  for (let i = 0; i < numbers.length; i++) {
    const n = numbers[i];
    if (n == null || n < anchor.startLine || n > anchor.endLine) continue;
    if (first < 0) first = i;
    last = i;
  }
  return first < 0 ? null : [first, last];
}

export type ReviewRow =
  | { kind: "line"; key: string; path: string; lineIndex: number; line: ReviewDiffLine; oldNo: number | null; newNo: number | null }
  | { kind: "hunk"; key: string; path: string; hunkIndex: number; hunk: HunkInfo }
  | { kind: "note"; key: string; path: string; note: ReviewNote; outdated: boolean }
  | { kind: "draft"; key: string; path: string }
  | { kind: "placeholder"; key: string; path: string; reason: "budget" | "large" | "binary" | "empty" | "error" | "loading"; text: string };

export interface FileGroup {
  file: ReviewDiffFile;
  collapsed: boolean;
  /** Notes on this file, diff notes only. */
  noteCount: number;
  rows: ReviewRow[];
}

export interface DraftAnchor extends NoteAnchor {
  /** Placed after this line; -1 places it under the file header. */
  afterLineIndex: number;
}

function changedLines(file: ReviewDiffFile): number {
  return file.additions + file.deletions;
}

function placeholderFor(file: ReviewDiffFile, loading: boolean): ReviewRow | null {
  const key = `p:${file.path}`;
  if (loading) return { kind: "placeholder", key, path: file.path, reason: "loading", text: "Loading diff…" };
  if (file.error) return { kind: "placeholder", key, path: file.path, reason: "error", text: file.error };
  if (file.deferred === "large") {
    return {
      kind: "placeholder",
      key,
      path: file.path,
      reason: "large",
      text: changedLines(file) > 0 ? `Large diff, ${changedLines(file).toLocaleString("en-US")} changed lines.` : "Large file.",
    };
  }
  if (file.deferred === "budget") return { kind: "placeholder", key, path: file.path, reason: "budget", text: "Loading diff…" };
  if (file.binary) return { kind: "placeholder", key, path: file.path, reason: "binary", text: "Binary file, no preview." };
  if (!(file.lines ?? []).some((line) => line.kind === "hunk")) {
    const text = file.status === "renamed" ? "Renamed without changes." : file.status === "untracked" || file.status === "added" ? "Empty file." : "No line changes.";
    return { kind: "placeholder", key, path: file.path, reason: "empty", text };
  }
  return null;
}

/**
 * The rows of one file under its header: placeholder, or hunks and lines with
 * each note after the line it ends on and the draft after its range. Notes
 * whose lines are no longer in the diff, and whole-file notes, come first.
 */
export function fileRows(
  file: ReviewDiffFile,
  options: { collapsed: boolean; notes: readonly ReviewNote[]; draft: DraftAnchor | null; loading: boolean },
): ReviewRow[] {
  if (options.collapsed) return [];
  const rows: ReviewRow[] = [];
  const structure = file.lines ? fileStructure(file) : null;
  const placed = new Map<number, ReviewNote[]>();
  const top: ReviewRow[] = [];
  for (const note of options.notes) {
    const atFile = note.startLine === 0 && note.endLine === 0;
    const index = atFile || !structure ? -1 : anchorLineIndex(file, note);
    if (index < 0) {
      top.push({ kind: "note", key: `n:${note.id}`, path: file.path, note, outdated: !atFile && Boolean(file.lines) && !file.deferred });
      continue;
    }
    const list = placed.get(index) ?? [];
    list.push(note);
    placed.set(index, list);
  }
  rows.push(...top);
  const draftAt = options.draft && options.draft.path === file.path ? options.draft.afterLineIndex : null;
  if (draftAt === -1) rows.push({ kind: "draft", key: `d:${file.path}`, path: file.path });

  const placeholder = placeholderFor(file, options.loading);
  if (placeholder || !structure) {
    if (placeholder) rows.push(placeholder);
    return rows;
  }
  const lines = file.lines ?? [];
  let hunkIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.kind === "hunk") {
      hunkIndex++;
      rows.push({ kind: "hunk", key: `h:${file.path}:${i}`, path: file.path, hunkIndex, hunk: structure.hunks[hunkIndex] });
      continue;
    }
    if (hunkIndex < 0) continue;
    if (line.kind === "meta" && !line.text.startsWith("\\") && !line.text.startsWith("…")) continue;
    rows.push({ kind: "line", key: `l:${file.path}:${i}`, path: file.path, lineIndex: i, line, oldNo: structure.oldNos[i], newNo: structure.newNos[i] });
    for (const note of placed.get(i) ?? []) rows.push({ kind: "note", key: `n:${note.id}`, path: file.path, note, outdated: false });
    if (draftAt === i) rows.push({ kind: "draft", key: `d:${file.path}`, path: file.path });
  }
  return rows;
}

/** Diff notes grouped by file path, each list in line order. */
export function notesByPath(notes: readonly ReviewNote[]): Map<string, ReviewNote[]> {
  const out = new Map<string, ReviewNote[]>();
  for (const note of notes) {
    if (note.source !== "diff") continue;
    const list = out.get(note.filePath) ?? [];
    list.push(note);
    out.set(note.filePath, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.endLine - b.endLine || a.startLine - b.startLine || a.createdAt - b.createdAt);
  return out;
}

/** The word for a file's status in its header. */
export function statusWord(file: Pick<ReviewDiffFile, "status">): string {
  switch (file.status) {
    case "added":
      return "Added";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "copied":
      return "Copied";
    case "untracked":
      return "New";
    case "typechange":
      return "Type changed";
    default:
      return "Modified";
  }
}

/** "Line 12", "Lines 12-14", "Old line 3", "Whole file": how the notes list names a place. */
export function shortLocation(note: Pick<ReviewNote, "startLine" | "endLine" | "side">): string {
  if (note.startLine === 0 && note.endLine === 0) return "Whole file";
  const plural = note.startLine !== note.endLine;
  const range = plural ? `${note.startLine}-${note.endLine}` : `${note.startLine}`;
  return `${note.side === "old" ? "Old line" : "Line"}${plural ? "s" : ""} ${range}`;
}

/**
 * The folder git actions on the review's paths run in, and files open from:
 * the repository's top folder, since every path in the review is relative to
 * it. A workspace that is a subfolder of its repository would otherwise apply
 * a hunk of a file outside it as a silent no-op (git apply skips paths
 * outside the folder it runs in). Spelled like the workspace folder when it
 * is that folder, and with backslashes when the workspace uses them (git
 * prints C:/x on Windows), so open tabs and caches keyed by path match.
 */
export function reviewRepoFolder(root: string | null | undefined, cwd: string): string {
  if (!root) return cwd;
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const caseless = /^[A-Za-z]:\//.test(norm(cwd)) || /^[A-Za-z]:\//.test(norm(root));
  const a = norm(root);
  const b = norm(cwd);
  if (caseless ? a.toLowerCase() === b.toLowerCase() : a === b) return cwd;
  return cwd.includes("\\") && !cwd.includes("/") ? root.replace(/\//g, "\\") : root;
}
