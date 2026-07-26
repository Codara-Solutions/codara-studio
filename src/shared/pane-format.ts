import { stripAnsi } from "./agent-patterns";

// ── Worker pane text formatting ─────────────────────────────────────────────
//
// Every line Codara WRITES ITSELF into a terminal pane goes through here: the
// Pi worker activity display (main process, run-store paints RPC events onto
// an idle host pty used as a canvas) and the renderer's exit banner. One home
// for the vocabulary and the colors so the two processes cannot drift.
//
// Three rules hold for every helper below.
//   1. Transport truthful. Nothing here decides an outcome or renames one; it
//      only formats a fact that was already established upstream (the pty's
//      `sanctioned` bit, a tool result the harness already received).
//   2. Never hide error content entirely. A collapse always keeps the head AND
//      the tail of the output, states how many lines it folded, and says where
//      the untouched copy lives (the run log, which is written in full).
//   3. Only OUR bytes. These helpers are for text Codara authors. Raw bytes
//      from a live agent CLI hosted on a real pty (the legacy worker harness)
//      pass through untouched, and must keep doing so: rewriting another
//      program's screen updates would corrupt its TUI.
//
// Everything is pure string work, no DOM / Electron / Node imports, so it is
// safe to import from main, preload, and renderer alike.

const RESET = "\x1b[0m";

// Raw SGR openers. Exported so a call site that has to build a compound
// sequence by hand still shares the palette instead of inlining truecolor.
export const PANE_DIM = "\x1b[2m";
export const PANE_RED = "\x1b[31m";
export const PANE_GREEN = "\x1b[32m";
export const PANE_YELLOW = "\x1b[33m";
// The Codara accent (teal), the same value the worker banner has always used.
export const PANE_ACCENT = "\x1b[38;2;74;222;208m";
// Tool labels: a soft slate rather than pure white, so the marker glyph and
// the label read as one quiet unit next to the dim detail line under them.
export const PANE_LABEL = "\x1b[38;2;203;213;225m";
export const PANE_RESET = RESET;

const style = (open: string) => (text: string): string => (text ? `${open}${text}${RESET}` : "");

export const paneDim = style(PANE_DIM);
export const paneRed = style(PANE_RED);
export const paneGreen = style(PANE_GREEN);
export const paneYellow = style(PANE_YELLOW);
export const paneAccent = style(PANE_ACCENT);
export const paneLabel = style(PANE_LABEL);

// ── Tool markers ────────────────────────────────────────────────────────────
//
// Subtle by design: the glyph carries the color, the word stays quiet. A
// successful step is the common case and must not shout, so "done" is dim
// next to a green check; a failure is the exception and stays fully red.

export function paneToolStartMarker(label: string): string {
  return `${paneAccent("◇")} ${paneLabel(label)}`;
}

export function paneToolOkMarker(): string {
  return `${paneGreen("✓")} ${paneDim("done")}`;
}

export function paneToolFailMarker(): string {
  return `${paneRed("×")} ${paneRed("failed")}`;
}

export function paneRetryMarker(text: string): string {
  return `${paneYellow("↻")} ${paneDim(text)}`;
}

// ── Exit banner ─────────────────────────────────────────────────────────────

export interface PaneExitInfo {
  exitCode?: number | null;
  signal?: number | null;
  sanctioned?: boolean;
}

/**
 * The last line a pane ever shows. `sanctioned` (see PtyExitInfo) is already
 * decided by pty-manager: it marks a teardown Codara asked for, which is the
 * ONLY kind of exit that is not a fault. Those get a calm sentence naming who
 * ended the session. Everything else keeps the raw, unfriendly banner on
 * purpose: an unsanctioned pty death is the one crash signal the app has, and
 * softening its wording would hide a fault the status chip is painting red.
 *
 * The sanctioned sentence deliberately carries NO exit code. That number comes
 * from the teardown itself (a host shell taking a signal once Cora is done
 * with the pane), not from the work that ran there, so a failed worker whose
 * pty is then killed would end on a reassuring "exit 0" right under its own
 * red failure frame. The frame and the status chip own the outcome; this line
 * only says who ended the session.
 */
export function formatPaneExitLine(info: PaneExitInfo): string {
  if (info.sanctioned) return `\r\n${paneDim("session ended by Cora")}\r\n`;
  const code = typeof info.exitCode === "number" && Number.isFinite(info.exitCode) ? info.exitCode : 0;
  return `\r\n${paneDim(`[process exited (${code})]`)}\r\n`;
}

// ── Output collapse ─────────────────────────────────────────────────────────

// A single tool result can be a whole `--help` dump or a stack trace per file.
// Past this many lines the pane shows the head and the tail and folds the
// middle; the full text is still written to the run log by the caller.
export const PANE_COLLAPSE_MAX_LINES = 40;
export const PANE_COLLAPSE_HEAD_LINES = 20;
export const PANE_COLLAPSE_TAIL_LINES = 12;
// One pathological line (a minified bundle, a base64 blob) can wrap for pages
// on its own, so lines are capped independently of the line count.
export const PANE_COLLAPSE_MAX_LINE_LENGTH = 400;
// The cap above exists to stop a FLOOD of long lines from wrapping off the
// screen. A failure that is one long sentence ("command failed: …") is the
// common shape and has no flood to guard against, so it keeps the older, more
// generous budget rather than losing 300 characters to a rule aimed at floods.
export const PANE_COLLAPSE_MAX_SINGLE_LINE_LENGTH = 700;
export const PANE_COLLAPSE_LOG_NOTE = "full output in the run log";

// Streamed assistant prose has no length known in advance (it arrives delta by
// delta), so it cannot be head/tail folded. It gets a per-message pane budget
// instead: past the budget the pane stops repainting and says where the rest
// is. The log still receives every byte.
export const PANE_STREAM_MAX_LINES = 240;
// Lines alone are not enough: a delta stream can be newline free (one JSON
// blob, a base64 payload, a single unbroken paragraph) and would then soft
// wrap forever without ever adding a line, so characters are counted too.
export const PANE_STREAM_MAX_CHARS = 24_000;
export const PANE_STREAM_CUT_NOTE = "output continues in the run log";

export interface PaneCollapseOptions {
  maxLines?: number;
  headLines?: number;
  tailLines?: number;
  maxLineLength?: number;
  maxSingleLineLength?: number;
}

export interface PaneCollapsedOutput {
  head: string[];
  tail: string[];
  /** Lines folded away between head and tail; 0 when nothing was collapsed. */
  collapsedLines: number;
  totalLines: number;
}

function paneTextOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// Keep tabs (they carry alignment in compiler output), drop every other C0 /
// DEL byte, and drop ANSI so the caller's color wraps the whole block without
// a nested reset punching a hole in it.
const PANE_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function paneLinesOf(value: unknown, maxLineLength: number, singleLineMaxLength: number): string[] {
  const text = stripAnsi(paneTextOf(value))
    .replace(/\r\n?/g, "\n")
    .replace(PANE_CONTROL_RE, " ");
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    // Fold runs of blank lines: a flood is usually double spaced, and the
    // pane budget should be spent on content.
    if (!line && lines.length > 0 && !lines[lines.length - 1]) continue;
    lines.push(line);
  }
  while (lines.length > 0 && !lines[0]) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1]) lines.pop();
  // Capping happens after the split so a lone line can be measured as one:
  // there is no flood to hold back, so it gets the wider budget.
  const cap = lines.length <= 1 ? Math.max(maxLineLength, singleLineMaxLength) : maxLineLength;
  return lines.map((line) => (line.length > cap ? `${line.slice(0, Math.max(0, cap - 1))}…` : line));
}

/**
 * Line-based collapse of one command result. Unlike a character truncation it
 * preserves structure (a stack trace still looks like a stack trace) and it
 * never drops the tail, which is where the actual error usually is.
 */
export function collapsePaneOutput(value: unknown, options: PaneCollapseOptions = {}): PaneCollapsedOutput {
  const maxLines = Math.max(1, options.maxLines ?? PANE_COLLAPSE_MAX_LINES);
  const maxLineLength = Math.max(16, options.maxLineLength ?? PANE_COLLAPSE_MAX_LINE_LENGTH);
  const singleLineMaxLength = Math.max(16, options.maxSingleLineLength ?? PANE_COLLAPSE_MAX_SINGLE_LINE_LENGTH);
  const lines = paneLinesOf(value, maxLineLength, singleLineMaxLength);
  if (lines.length <= maxLines) {
    return { head: lines, tail: [], collapsedLines: 0, totalLines: lines.length };
  }
  let headLines = Math.max(1, options.headLines ?? PANE_COLLAPSE_HEAD_LINES);
  let tailLines = Math.max(1, options.tailLines ?? PANE_COLLAPSE_TAIL_LINES);
  // A collapse has to actually save lines, otherwise the marker costs more
  // than it hides; shrink the window until at least two lines are folded.
  while (headLines + tailLines > maxLines - 2 && headLines + tailLines > 2) {
    if (headLines > tailLines) headLines -= 1;
    else tailLines -= 1;
  }
  const collapsedLines = lines.length - headLines - tailLines;
  if (collapsedLines <= 0) {
    return { head: lines, tail: [], collapsedLines: 0, totalLines: lines.length };
  }
  return {
    head: lines.slice(0, headLines),
    tail: lines.slice(lines.length - tailLines),
    collapsedLines,
    totalLines: lines.length,
  };
}

export function paneCollapseMarker(collapsedLines: number, note = PANE_COLLAPSE_LOG_NOTE): string {
  const plural = collapsedLines === 1 ? "line" : "lines";
  return `… ${collapsedLines} ${plural} collapsed (${note})`;
}

export interface PaneBlockOptions extends PaneCollapseOptions {
  /** Prefix for every rendered line, e.g. the four spaces a tool detail uses. */
  indent?: string;
  /** SGR opener applied to content lines. The marker is always dim. */
  color?: string;
  note?: string;
}

/**
 * Render one collapsed block ready to be written to a pane: CRLF terminated
 * (the pane is a raw pty canvas, a bare LF would stair-step), indented, and
 * with a dim marker where the fold happened. Returns "" for empty input so
 * call sites can concatenate it unconditionally.
 */
export function formatPaneCollapsedBlock(value: unknown, options: PaneBlockOptions = {}): string {
  const indent = options.indent ?? "";
  const color = options.color ?? "";
  const collapsed = collapsePaneOutput(value, options);
  if (collapsed.totalLines === 0) return "";
  const paint = (line: string): string => `\r\n${indent}${line ? `${color}${line}${color ? RESET : ""}` : ""}`;
  let out = collapsed.head.map(paint).join("");
  if (collapsed.collapsedLines > 0) {
    out += `\r\n${indent}${paneDim(paneCollapseMarker(collapsed.collapsedLines, options.note))}`;
    out += collapsed.tail.map(paint).join("");
  }
  return out;
}

/** Lines a chunk of streamed text adds to the pane. */
export function paneStreamLineCount(chunk: string): number {
  let count = 0;
  for (const char of chunk) if (char === "\n") count += 1;
  return count;
}

/**
 * What one assistant message has already painted. Lines are the honest unit
 * for prose, characters are the backstop for a stream that never breaks a
 * line, and a message that runs past either one gets cut with a pointer to
 * the log. Kept here, not in the caller, so the two budgets cannot drift.
 */
export interface PaneStreamBudget {
  lines: number;
  chars: number;
}

/** A fresh budget; the pane resets one per assistant message. */
export function paneStreamBudget(): PaneStreamBudget {
  return { lines: 0, chars: 0 };
}

export function paneStreamAdd(budget: PaneStreamBudget, chunk: string): PaneStreamBudget {
  return { lines: budget.lines + paneStreamLineCount(chunk), chars: budget.chars + chunk.length };
}

export function paneStreamExceeded(budget: PaneStreamBudget): boolean {
  return budget.lines > PANE_STREAM_MAX_LINES || budget.chars > PANE_STREAM_MAX_CHARS;
}
