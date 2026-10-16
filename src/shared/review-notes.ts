// Review notes: what the user writes on lines of the workspace's diff (or on
// a rendered Markdown file such as a plan) and hands to an agent as one batch.
// Shared by main's per-workspace store, the review tab and the Markdown
// preview. Pure functions only, so the format agents receive is pinned by
// scripts/test-review-notes.cjs.

import { plainTerminalText } from "./terminal-text";

export type ReviewNoteSource = "diff" | "markdown";

/**
 * Which file the line numbers count in. "new" is the file as it is on disk
 * now; "old" is the file before the change, for notes on removed lines only.
 */
export type ReviewNoteSide = "new" | "old";

export interface ReviewNote {
  id: string;
  source: ReviewNoteSource;
  /**
   * Diff notes: the repository-relative path, forward slashes. Markdown
   * notes: the file's absolute path, shown relative to the workspace when it
   * is inside it.
   */
  filePath: string;
  side: ReviewNoteSide;
  /** 1-based and inclusive. 0 and 0 mean the whole file. */
  startLine: number;
  endLine: number;
  /** The lines the note is about as they read when it was written; diff lines keep their +, - or space. */
  quote: string;
  body: string;
  createdAt: number;
  updatedAt?: number;
}

export type ReviewDiffMode = "uncommitted" | "base";

export type ReviewFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "typechange";

export interface ReviewDiffLine {
  kind: "add" | "del" | "context" | "hunk" | "meta";
  text: string;
}

export interface ReviewDiffFile {
  /** Repository-relative path, forward slashes. */
  path: string;
  oldPath?: string;
  status: ReviewFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** The file's unified diff, file header included. Absent while deferred. */
  lines?: ReviewDiffLine[];
  /**
   * Not loaded with the rest: "budget" files load when they scroll into view,
   * "large" ones only when the user asks.
   */
  deferred?: "budget" | "large";
  /** Lines were cut at the per-file cap. */
  truncated?: boolean;
  error?: string;
}

export interface ReviewDiffRequest {
  cwd: string;
  mode: ReviewDiffMode;
  /** Base branch for mode "base"; the workspace's own base or the default branch when absent. */
  base?: string | null;
  /**
   * Load only these files (repository-relative), with no budget. Name a
   * renamed file's old path too: git pairs the two only when both are asked
   * for, and shows the new one as an added file otherwise.
   */
  paths?: string[];
  /** With paths: load them in full, even a file too large to show unasked. */
  force?: boolean;
  /** Also list the branches the base can be picked from. */
  listBases?: boolean;
}

export interface ReviewDiff {
  mode: ReviewDiffMode;
  isRepo: boolean;
  /** The repository's top folder; file paths are relative to it. */
  root?: string;
  /** What the diff compares against: "HEAD", a base branch, or null when there is no commit yet. */
  base: string | null;
  /** The commit the base branch and HEAD share, short form (mode "base"). */
  mergeBase?: string | null;
  files: ReviewDiffFile[];
  /** Branch names the base can be picked from, when asked. */
  bases?: string[];
  error?: string;
}

/** Paths one diff request loads at most; the rest of a longer list are ignored. */
export const MAX_REVIEW_REQUEST_PATHS = 200;
/**
 * Characters of the paths one diff request names at most. Each becomes an
 * argument of git's command line, which Windows caps at 32,767 characters.
 */
export const MAX_REVIEW_REQUEST_CHARS = 12_000;

export const MAX_REVIEW_NOTES = 500;
export const MAX_NOTE_BODY_CHARS = 8_000;
export const MAX_QUOTE_LINES = 40;
export const MAX_QUOTE_CHARS = 4_000;
const MAX_PATH_CHARS = 4_096;
const MAX_ID_CHARS = 120;

function finiteLine(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10_000_000) return null;
  return value;
}

/** A note read from disk or from the renderer, or null when it is not one. */
export function cleanReviewNote(raw: unknown): ReviewNote | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id || id.length > MAX_ID_CHARS) return null;
  const filePath = typeof value.filePath === "string" ? value.filePath.trim() : "";
  if (!filePath || filePath.length > MAX_PATH_CHARS || /[\u0000\n\r]/.test(filePath)) return null;
  const body = typeof value.body === "string" ? value.body.trim().slice(0, MAX_NOTE_BODY_CHARS) : "";
  if (!body) return null;
  const startLine = finiteLine(value.startLine);
  const endLine = finiteLine(value.endLine);
  if (startLine === null || endLine === null) return null;
  const quote = typeof value.quote === "string" ? clampQuote(value.quote) : "";
  const createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : 0;
  const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : undefined;
  return {
    id,
    source: value.source === "markdown" ? "markdown" : "diff",
    filePath,
    side: value.side === "old" ? "old" : "new",
    startLine: Math.min(startLine, endLine),
    endLine: Math.max(startLine, endLine),
    quote,
    body,
    createdAt,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

/** Every valid note, duplicates by id dropped, at most MAX_REVIEW_NOTES. */
export function cleanReviewNotes(raw: unknown): ReviewNote[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ReviewNote[] = [];
  for (const item of raw) {
    const note = cleanReviewNote(item);
    if (!note || seen.has(note.id)) continue;
    seen.add(note.id);
    out.push(note);
    if (out.length >= MAX_REVIEW_NOTES) break;
  }
  return out;
}

/** The quote cut to MAX_QUOTE_LINES lines and MAX_QUOTE_CHARS characters. */
export function clampQuote(quote: string): string {
  const lines = plainTerminalText(quote).split("\n");
  let kept = lines.slice(0, MAX_QUOTE_LINES);
  let more = lines.length - kept.length;
  let text = kept.join("\n");
  if (text.length > MAX_QUOTE_CHARS) {
    text = text.slice(0, MAX_QUOTE_CHARS);
    const cut = text.lastIndexOf("\n");
    if (cut > 0) text = text.slice(0, cut);
    kept = text.split("\n");
    more = lines.length - kept.length;
  }
  return more > 0 ? `${text}\n… ${more} more line${more === 1 ? "" : "s"}` : text;
}

/**
 * The note's place, as an agent reads it: "src/app.ts:12", "src/app.ts:12-14",
 * "src/app.ts (whole file)", or "src/app.ts, old lines 40-42 (removed)".
 */
export function reviewNoteLocation(note: Pick<ReviewNote, "startLine" | "endLine" | "side">, path: string): string {
  if (note.startLine === 0 && note.endLine === 0) return `${path} (whole file)`;
  const range = note.startLine === note.endLine ? `${note.startLine}` : `${note.startLine}-${note.endLine}`;
  if (note.side === "old") {
    return `${path}, old line${note.startLine === note.endLine ? "" : "s"} ${range} (removed)`;
  }
  return `${path}:${range}`;
}

function fenceFor(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

function compareNotes(a: ReviewNote, b: ReviewNote): number {
  if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
  if (a.side !== b.side) return a.side === "new" ? -1 : 1;
  return a.startLine - b.startLine || a.endLine - b.endLine || a.createdAt - b.createdAt;
}

/** Notes in the order they are listed and sent: by file, then by line. */
export function sortReviewNotes(notes: readonly ReviewNote[]): ReviewNote[] {
  return [...notes].sort(compareNotes);
}

/** A Markdown note's absolute path shown relative to the workspace when it is inside it. */
export function displayNotePath(note: Pick<ReviewNote, "filePath" | "source">, workspaceCwd: string | null | undefined): string {
  if (note.source !== "markdown" || !workspaceCwd) return note.filePath;
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = norm(workspaceCwd);
  const file = norm(note.filePath);
  const caseless = /^[A-Za-z]:\//.test(root);
  const inside = caseless
    ? file.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    : file.startsWith(`${root}/`);
  return inside ? file.slice(root.length + 1) : note.filePath;
}

export interface ReviewNotesFormatOptions {
  /** What the diff showed: "uncommitted changes" or "changes against origin/main". */
  scope?: string | null;
  workspaceCwd?: string | null;
  /**
   * The repository's top folder. Diff notes name files relative to it, so
   * the message says so when the workspace is a folder inside it, where the
   * agent works.
   */
  repoRoot?: string | null;
}

function samePlace(a: string, b: string): boolean {
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const x = norm(a);
  const y = norm(b);
  return /^[A-Za-z]:\//.test(x) || /^[A-Za-z]:\//.test(y) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * The one message an agent receives for a batch of notes. The format is the
 * contract between the review tab and whichever agent reads it, so it stays
 * deterministic: a header, then each note with its place, the quoted lines
 * and the note itself.
 */
export function formatReviewNotes(notes: readonly ReviewNote[], options: ReviewNotesFormatOptions = {}): string {
  const sorted = sortReviewNotes(notes);
  const count = sorted.length;
  const scope = options.scope?.trim();
  const root = options.repoRoot?.trim();
  const elsewhere =
    root && options.workspaceCwd && sorted.some((note) => note.source === "diff") && !samePlace(root, options.workspaceCwd)
      ? `\nFile paths are relative to the repository at ${root}.`
      : "";
  const head = `[Codara] ${count === 1 ? "1 review note" : `${count} review notes`}${scope ? ` on the ${scope}` : ""}. Address each one, then say what you changed.${elsewhere}`;
  const blocks = sorted.map((note, index) => {
    const path = displayNotePath(note, options.workspaceCwd);
    const lines = [`${index + 1}. ${reviewNoteLocation(note, path)}${note.source === "markdown" ? " (Markdown)" : ""}`];
    const quote = note.quote.replace(/\s+$/, "");
    if (quote) {
      if (note.source === "markdown") {
        lines.push(quote.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n"));
      } else {
        const fence = fenceFor(quote);
        lines.push(`${fence}diff\n${quote}\n${fence}`);
      }
    }
    lines.push(`Note: ${note.body.trim()}`);
    return lines.join("\n");
  });
  return plainTerminalText([head, ...blocks].join("\n\n"));
}

/** Whether a note still reads exactly as it did when it was sent. */
export function sameReviewNote(a: ReviewNote, b: ReviewNote): boolean {
  return (
    a.id === b.id &&
    a.body === b.body &&
    a.filePath === b.filePath &&
    a.side === b.side &&
    a.startLine === b.startLine &&
    a.endLine === b.endLine &&
    a.quote === b.quote
  );
}

/**
 * The notes left after a send: every note that was sent as it reads now is
 * gone. A note edited while the send was on its way stays, since the agent
 * got the older words.
 */
export function withoutDelivered(current: readonly ReviewNote[], delivered: readonly ReviewNote[]): ReviewNote[] {
  const sent = new Map(delivered.map((note) => [note.id, note]));
  return current.filter((note) => {
    const snapshot = sent.get(note.id);
    return !snapshot || !sameReviewNote(note, snapshot);
  });
}
