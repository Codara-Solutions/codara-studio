// The match engine behind every document find bar: one query language
// (literal or regular expression, case and whole-word toggles) compiled to a
// RegExp, run over plain text. Pure, so the editor, rendered previews, PDF
// text and table cells all count and step through matches the same way.

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export const DEFAULT_FIND_OPTIONS: FindOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

/** Counting stops here; the bar then reads "1 of 10000+". */
export const MAX_FIND_MATCHES = 10_000;

export type CompiledFind =
  | { ok: true; regex: RegExp }
  | { ok: false; error: string };

export interface CompileFlags {
  /**
   * Rendered text: a space in a literal query matches any run of spaces,
   * tabs or non-breaking spaces, the way a browser's find treats collapsed
   * whitespace. Source text (the editor) matches whitespace exactly.
   */
  collapseWhitespace?: boolean;
}

const WORD_CHAR = "[\\p{L}\\p{N}_]";
const ASCII_WORD_CHAR = "[A-Za-z0-9_]";

// Only the syntax characters: Unicode mode rejects any other escaped
// punctuation, and the query never lands inside a character class.
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a query, or null for an empty one. An invalid regular expression
 * comes back as an error the bar can show instead of throwing.
 */
export function compileFind(
  query: string,
  options: FindOptions,
  flags: CompileFlags = {},
): CompiledFind | null {
  if (!query) return null;
  let source: string;
  if (options.regex) {
    source = query;
  } else {
    source = escapeLiteral(query);
    if (flags.collapseWhitespace) source = source.replace(/\s+/g, "[ \\t\\u00a0]+");
  }
  const caseFlag = options.caseSensitive ? "" : "i";
  // Unicode mode gives whole-word its letter classes and case-insensitive
  // search proper folding, but rejects some patterns plain JavaScript accepts
  // (an escaped "-" outside a class), so a pattern only valid without it
  // still runs, with ASCII word boundaries.
  const attempt = (unicode: boolean): RegExp => {
    const word = unicode ? WORD_CHAR : ASCII_WORD_CHAR;
    const body = options.wholeWord ? `(?<!${word})(?:${source})(?!${word})` : source;
    return new RegExp(body, `gm${caseFlag}${unicode ? "u" : ""}`);
  };
  try {
    return { ok: true, regex: attempt(true) };
  } catch {
    try {
      return { ok: true, regex: attempt(false) };
    } catch (error) {
      return { ok: false, error: describeRegexError(error) };
    }
  }
}

function describeRegexError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // "Invalid regular expression: /(/gmi: Unterminated group" reads better as
  // just the reason.
  const reason = message.split(": ").pop()?.trim();
  return reason ? `Invalid regular expression: ${reason}` : "Invalid regular expression";
}

export interface MatchList {
  /** Start offsets, ascending. */
  starts: number[];
  /** End offsets, one per start. */
  ends: number[];
  /** True when counting stopped at the limit. */
  capped: boolean;
}

export function emptyMatches(): MatchList {
  return { starts: [], ends: [], capped: false };
}

/**
 * Every non-empty match of `compiled` in `text`, in order. Empty matches
 * (a bare `^` or `x*`) are skipped: they have nothing to highlight.
 */
export function findAllMatches(
  text: string,
  compiled: CompiledFind | null,
  limit = MAX_FIND_MATCHES,
): MatchList {
  const result = emptyMatches();
  if (!compiled || !compiled.ok) return result;
  const regex = new RegExp(compiled.regex.source, compiled.regex.flags);
  regex.lastIndex = 0;
  for (;;) {
    const match = regex.exec(text);
    if (!match) break;
    const start = match.index;
    const end = start + match[0].length;
    if (end === start) {
      regex.lastIndex = advance(text, start, regex.unicode);
      if (regex.lastIndex > text.length) break;
      continue;
    }
    if (result.starts.length >= limit) {
      result.capped = true;
      break;
    }
    result.starts.push(start);
    result.ends.push(end);
  }
  return result;
}

export interface CellMatch {
  /** Display position of the cell, after any sort or filter. */
  row: number;
  column: number;
  start: number;
  end: number;
}

export interface CellSource {
  rows: number;
  columns: number;
  /** The text the cell shows. */
  text: (row: number, column: number) => string;
}

/**
 * Appends the matches in rows [from, to) of a table to `out`, cell by cell in
 * reading order; returns true when `limit` stopped it. A match never spans
 * two cells, and a line break inside a cell counts as a space.
 */
export function scanCells(
  source: CellSource,
  compiled: Extract<CompiledFind, { ok: true }>,
  from: number,
  to: number,
  out: CellMatch[],
  limit = MAX_FIND_MATCHES,
): boolean {
  const regex = new RegExp(compiled.regex.source, compiled.regex.flags);
  for (let row = from; row < to; row++) {
    for (let column = 0; column < source.columns; column++) {
      const raw = source.text(row, column);
      if (!raw) continue;
      const text = raw.includes("\n") || raw.includes("\r") ? raw.replace(/[\r\n]/g, " ") : raw;
      regex.lastIndex = 0;
      for (;;) {
        const match = regex.exec(text);
        if (!match) break;
        const start = match.index;
        const end = start + match[0].length;
        if (end === start) {
          regex.lastIndex = advance(text, start, regex.unicode);
          if (regex.lastIndex > text.length) break;
          continue;
        }
        if (out.length >= limit) return true;
        out.push({ row, column, start, end });
      }
    }
  }
  return false;
}

/** Index of the first cell match at or after (row, column), wrapping to 0. */
export function firstCellMatchFrom(matches: readonly CellMatch[], row: number, column: number): number {
  if (matches.length === 0) return -1;
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const match = matches[mid];
    if (match.row < row || (match.row === row && match.column < column)) lo = mid + 1;
    else hi = mid;
  }
  return lo < matches.length ? lo : 0;
}

function advance(text: string, index: number, unicode: boolean): number {
  if (!unicode || index >= text.length) return index + 1;
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff ? index + 2 : index + 1;
}

/** The match to land on after stepping `delta` from `current`, wrapping. */
export function stepMatch(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta < 0 ? count - 1 : 0;
  return (((current + delta) % count) + count) % count;
}

/** Index of the first match starting at or after `offset`, wrapping to 0. */
export function firstMatchFrom(starts: readonly number[], offset: number): number {
  if (starts.length === 0) return -1;
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo < starts.length ? lo : 0;
}

export interface FindStatus {
  total: number;
  /** Zero-based index of the current match, or -1 when there is none. */
  current: number;
  capped: boolean;
  /** Still counting (a big document, or text still loading). */
  pending: boolean;
  error: string | null;
}

export const IDLE_FIND_STATUS: FindStatus = {
  total: 0,
  current: -1,
  capped: false,
  pending: false,
  error: null,
};

/** The count readout: "3 of 41", "41 matches", "No results". */
export function describeFindStatus(query: string, status: FindStatus): string {
  if (!query) return "";
  if (status.error) return "Invalid pattern";
  if (status.pending && status.total === 0) return "Searching…";
  if (status.total === 0) return "No results";
  const total = `${status.total.toLocaleString("en-US")}${status.capped ? "+" : ""}`;
  if (status.current >= 0) return `${(status.current + 1).toLocaleString("en-US")} of ${total}`;
  return `${total} ${status.total === 1 && !status.capped ? "match" : "matches"}`;
}

/**
 * Text to seed the bar with: a selection on one line, short enough to be a
 * search term. Anything else leaves the previous query in place.
 */
export function seedFromSelection(text: string | null | undefined): string | null {
  if (!text) return null;
  if (/[\r\n]/.test(text)) return null;
  if (!text.trim() || text.length > 200) return null;
  return text;
}
