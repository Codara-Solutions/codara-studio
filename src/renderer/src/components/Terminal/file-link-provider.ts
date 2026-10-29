import type { IBufferRange, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

// xterm link provider that detects file-path-shaped tokens in terminal output
// and turns them into ctrl/cmd-clickable links. Sister to the bundled
// WebLinksAddon — same hover/underline UX (we share xterm's default link
// decorations), modifier-gated activation, async existence check before the
// callback fires so non-existent paths quietly never light up.
//
// Detector strategy: union of these patterns, applied to a single buffer row.
//   1. Windows drive-letter absolute   C:\foo\bar.ts  or  D:/foo/bar
//   2. POSIX absolute                  /home/jorge/foo.ts
//   3. Home-relative                   ~/notes/todo.md
//   4. Explicit relative               ./src/x  or  ../pkg/y
//   5. Bare with a separator           src/foo.ts  (needs a known extension)
//   6. Bare file name                  README.md, .env, .env.local  (a known
//                                      extension, or a .env file)
// Each match optionally consumes a `:line[:col]` or `(line,col)` suffix from
// stack-trace formats so the user clicks the whole pretty token, not just the
// path; the line and column go to the editor.
//
// Spaces: a token ends at whitespace, so `~/Documents/Codara SL/README.md`
// first matches as `~/Documents/Codara`. When that token is not a file, the
// words after it (and, for an unanchored relative path, the words before it)
// are tried as one path, longest first, and the longest one that exists wins.
// Only tokens that do not resolve pay for those checks.
//
// Wrapped rows are not stitched. A path that line-wraps mid-string will only
// match its trailing fragment; this is the same compromise WebLinksAddon makes
// for URLs and keeps the matcher cheap on every cursor-hover transition.

// Each alternative is anchored so we can pull a single contiguous run of path
// characters out of mixed terminal noise. Trailing punctuation that often
// hugs paths in prose (`.`, `,`, `:`, `;`, closing brackets) is stripped
// after the match — the regex deliberately includes them in the "stop" class
// to avoid backtracking surprises.
//
// Order matters: drive-letter must precede the colon-suffix matcher so
// `C:\Users\foo.ts:42` is captured as "drive-letter path + line suffix",
// not "POSIX path `C` + everything else". A bare file name only starts at
// the start of the row or after a space, quote or opening bracket, so the
// tail of a URL or an e-mail address never matches as one.
const PATH_TOKEN = String.raw`(?:[A-Za-z]:[\\/](?:[^\s"'()<>:*?|]|:(?!\d))+|\/[^\s"'()<>:]+|~[\\/][^\s"'()<>:]+|\.{1,2}[\\/][^\s"'()<>:]+|(?:[A-Za-z0-9_\-]+[\\/])+[A-Za-z0-9_\-.]+|(?<=^|[\s"'(\[<\x60])\.?[A-Za-z0-9_\-][A-Za-z0-9_\-.]*)`;
const LINE_COL = String.raw`(?::(\d+)(?::(\d+))?|\((\d+)(?:[,:](\d+))?\))`;
const MATCH_RE = new RegExp(String.raw`(${PATH_TOKEN})(?:${LINE_COL})?`, "g");
const LINE_COL_SUFFIX_RE = new RegExp(String.raw`${LINE_COL}$`);

// File-extension whitelist for the bare patterns (5 and 6 above). Without
// this, every "word/word" two-segment token (e.g. tab-separated columns in
// log output) and every "Node.js" in prose lights up. We allow common code /
// data / docs extensions; anything else needs a leading slash or `./`.
const KNOWN_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "json", "jsonc", "yaml", "yml", "toml", "ini", "env",
  "md", "mdx", "txt", "log", "csv", "tsv",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp",
  "cs", "php", "lua", "sh", "ps1", "bat", "cmd",
  "css", "scss", "sass", "less", "html", "htm", "vue", "svelte",
  "sql", "graphql", "proto", "xml", "lock",
]);

// `.env`, `.env.local`, `.env.production`: the files an agent most often
// names without a folder, and none of them has a known extension.
const ENV_FILE_RE = /^\.env(?:\.[A-Za-z0-9_\-.]+)?$/;

// How far a token is grown across spaces looking for a path that exists.
// Each extra word is one more existence check, and only for tokens that did
// not resolve as they are.
const MAX_WORDS_AFTER = 5;
const MAX_WORDS_BEFORE = 2;
// One word of a path with spaces: the characters a path token may hold.
const WORD_RE = /^[^\s"'()<>]+/;
const WORD_BEFORE_RE = /[^\s"'()<>]+$/;

// Punctuation that frequently trails a path in prose ("see foo.ts.") but is
// almost never part of the filename itself. Stripped after the regex match.
function stripTrailingPunct(s: string): string {
  return s.replace(/[.,;:!?)\]}>'"`]+$/u, "");
}

function hasKnownExtension(token: string): boolean {
  const name = token.split(/[\\/]/).pop() ?? token;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return KNOWN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function isAnchored(token: string): boolean {
  return /^([A-Za-z]:[\\/]|\/|~[\\/]|\.{1,2}[\\/])/.test(token);
}

function looksLikeRealPath(token: string): boolean {
  if (!token) return false;
  // URLs sneak past the drive-letter branch (`https://…` matches as drive
  // letter `s` + `://…`). Drop anything with a scheme separator outright;
  // the WebLinksAddon already handles real URLs.
  if (token.includes("://")) return false;
  // Absolute, home and explicit-relative are always candidates.
  if (isAnchored(token)) return true;
  // A bare name or path needs a recognized extension (or to name a .env
  // file, as in config/.env) to avoid lighting up every prose "word/word"
  // and "Node.js".
  const name = token.split(/[\\/]/).pop() ?? token;
  return ENV_FILE_RE.test(name) || hasKnownExtension(token);
}

export interface FileLinkActivation {
  /** Original token as it appeared in the buffer (path + optional suffix). */
  raw: string;
  /** Just the file portion, after stripping any `:line:col` / `(line,col)` suffix. */
  file: string;
  line?: number;
  column?: number;
  /** Browser event so the caller can decide modifier-gating. */
  event: MouseEvent;
}

export interface FileLinkProviderOptions {
  /**
   * Latest known cwd for this terminal session. The provider re-reads it on
   * every match so a pane that's `cd`'d around still resolves relatives
   * correctly. May return null for panes without an OSC 7 source — relative
   * matches just won't verify in that case.
   */
  getCwd: () => string | null;
  /**
   * Existence check. Returns the absolute resolved path if the target is a
   * real file inside the renderer's allowed-roots sandbox, or null otherwise.
   * Implemented via window.spark.fs.pathExists in production; injectable for
   * tests.
   */
  resolveExisting: (target: string, baseDir: string | null) => Promise<string | null>;
  /** Called when the user activates a link (modifier-gating is decided here). */
  onActivate: (activation: FileLinkActivation) => void;
}

/** One way to read a stretch of the row as a path. */
export interface PathCandidate {
  text: string;
  file: string;
  line?: number;
  column?: number;
  /** 1-based start column in the row. */
  startCol: number;
  /** 1-based end column (inclusive). */
  endCol: number;
}

export interface RawMatch extends PathCandidate {
  /**
   * Longer readings across spaces, longest first, tried when the match itself
   * is not a file. Empty for a token that cannot hold more words.
   */
  wider: PathCandidate[];
  /**
   * False when the token alone is not path-shaped and only a wider reading
   * can be: `docs/my` in `docs/my notes.txt`.
   */
  direct?: false;
}

// A stretch of the row as a candidate: its line suffix split off, trailing
// prose punctuation dropped. Null when what is left is not path-shaped.
function candidateAt(row: string, start: number, end: number): PathCandidate | null {
  const text = row.slice(start, end);
  const suffix = LINE_COL_SUFFIX_RE.exec(text);
  const pathPart = suffix ? text.slice(0, suffix.index) : text;
  const file = stripTrailingPunct(pathPart);
  if (!looksLikeRealPath(file)) return null;
  const lineNum = suffix ? suffix[1] ?? suffix[3] : undefined;
  const colNum = suffix ? suffix[2] ?? suffix[4] : undefined;
  // The underline covers the path and its line suffix, not prose punctuation.
  const shown = suffix ? text : file;
  return {
    text: shown,
    file,
    line: lineNum ? Number(lineNum) : undefined,
    column: colNum ? Number(colNum) : undefined,
    startCol: start + 1,
    endCol: start + shown.length,
  };
}

// The end offsets of up to `max` words after `end`, each one space apart.
function wordEndsAfter(row: string, end: number, max: number): number[] {
  const ends: number[] = [];
  let at = end;
  while (ends.length < max && row[at] === " ") {
    const word = WORD_RE.exec(row.slice(at + 1));
    if (!word) break;
    at += 1 + word[0].length;
    ends.push(at);
  }
  return ends;
}

// The start offsets of up to `max` words before `start`, each one space apart.
function wordStartsBefore(row: string, start: number, max: number): number[] {
  const starts: number[] = [];
  let at = start;
  while (starts.length < max && at > 1 && row[at - 1] === " ") {
    const word = WORD_BEFORE_RE.exec(row.slice(0, at - 1));
    if (!word) break;
    at = at - 1 - word[0].length;
    starts.push(at);
  }
  return starts;
}

// Readings of the token across the spaces around it. A token with a line
// suffix ends there, but may still start earlier (`meeting notes.md:12`).
// Anchored paths only grow forward, since their first character is the
// anchor; a bare file name only grows backward (`meeting notes.md`), since
// the word after a file name in a sentence is never part of it.
function widerCandidates(row: string, start: number, end: number, base: PathCandidate): PathCandidate[] {
  if (base.text !== row.slice(start, end)) return [];
  const bare = !isAnchored(base.file) && !/[\\/]/.test(base.file);
  const ends = [end, ...(bare || base.line !== undefined ? [] : wordEndsAfter(row, end, MAX_WORDS_AFTER))];
  // A bare name takes plain words only: `/tmp/report 2.md` printed after a
  // file that exists is two paths, and the one that exists as printed wins.
  const before = isAnchored(base.file) ? [] : wordStartsBefore(row, start, MAX_WORDS_BEFORE);
  const starts = [start, ...(bare ? before.filter((s) => !/[\\/]/.test(row.slice(s, start))) : before)];
  const out: PathCandidate[] = [];
  for (const s of starts) {
    for (const e of ends) {
      if (s === start && e === end) continue;
      const candidate = candidateAt(row, s, e);
      if (candidate && candidate.file.length > base.file.length) out.push(candidate);
    }
  }
  return out.sort((a, b) => b.endCol - b.startCol - (a.endCol - a.startCol));
}

export function scanRowForPaths(row: string): RawMatch[] {
  const out: RawMatch[] = [];
  MATCH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MATCH_RE.exec(row)) !== null) {
    const wholeStart = m.index;
    const whole = m[0];
    const rawPath = stripTrailingPunct(m[1] ?? "");
    // A relative token without an extension may be the first part of a path
    // with spaces; it only counts through a wider reading.
    const direct = looksLikeRealPath(rawPath);
    if (!direct && !(/[\\/]/.test(rawPath) && whole === rawPath && !rawPath.includes("://"))) continue;
    // Reject matches whose enclosing whitespace-bounded token contains a URL
    // scheme — `http://localhost:5173/index.html` would otherwise light up
    // the `/index.html` tail as a clickable file. We look at the run of
    // non-space chars before the match for `://`.
    const before = row.slice(0, wholeStart);
    const lastWs = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\t"));
    const tokenPrefix = lastWs >= 0 ? before.slice(lastWs + 1) : before;
    if (tokenPrefix.includes("://")) continue;
    const lineNum = m[2] ?? m[4];
    const colNum = m[3] ?? m[5];
    // 1-based columns for xterm IBufferRange. The provider returns the
    // FULL token including any line/col suffix so the underline covers it.
    const base: PathCandidate = {
      text: whole,
      file: rawPath,
      line: lineNum ? Number(lineNum) : undefined,
      column: colNum ? Number(colNum) : undefined,
      startCol: wholeStart + 1,
      endCol: wholeStart + whole.length,
    };
    const wider = widerCandidates(row, wholeStart, wholeStart + whole.length, base);
    if (direct) out.push({ ...base, wider });
    else if (wider.length > 0) out.push({ ...base, wider, direct: false });
  }
  return out;
}

/**
 * The reading of a match that names a real file: the match itself when it
 * does, otherwise the longest wider reading that does. Checks run in
 * parallel.
 */
export async function resolveMatch(
  match: RawMatch,
  resolve: (file: string) => Promise<string | null>,
): Promise<{ candidate: PathCandidate; resolved: string } | null> {
  const direct = match.direct === false ? null : await resolve(match.file);
  if (direct) return { candidate: match, resolved: direct };
  if (match.wider.length === 0) return null;
  const results = await Promise.all(match.wider.map((candidate) => resolve(candidate.file)));
  const index = results.findIndex((resolved) => resolved !== null);
  return index >= 0 ? { candidate: match.wider[index], resolved: results[index]! } : null;
}

/** Keeps the longest of any links that overlap, then sorts them by column. */
export function dropOverlapping<T extends { startCol: number; endCol: number }>(found: T[]): T[] {
  const byLength = [...found].sort((a, b) => b.endCol - b.startCol - (a.endCol - a.startCol));
  const kept: T[] = [];
  for (const item of byLength) {
    if (kept.some((other) => item.startCol <= other.endCol && other.startCol <= item.endCol)) continue;
    kept.push(item);
  }
  return kept.sort((a, b) => a.startCol - b.startCol);
}

/** The parts of an xterm buffer row cellColumnsOfRow reads; IBufferLine has them. */
export interface CellRowLike {
  readonly length: number;
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
}

/**
 * The 0-based cell column of every UTF-16 code unit of the row's
 * translateToString text, plus one entry for the end of the text. A string
 * index is not a column: a wide character (CJK, or an emoji under the
 * Unicode 11 widths) spans two cells, and an emoji outside the BMP is two
 * code units. Built the way xterm builds that string: an empty cell reads as
 * a space, and the second half of a wide character adds nothing.
 */
export function cellColumnsOfRow(line: CellRowLike): number[] {
  const columns: number[] = [];
  let x = 0;
  while (x < line.length) {
    const cell = line.getCell(x);
    if (!cell) break;
    const chars = cell.getChars() || " ";
    for (let i = 0; i < chars.length; i += 1) columns.push(x);
    x += cell.getWidth() || 1;
  }
  columns.push(x);
  return columns;
}

// Hovering re-asks for the links of a row on every move between rows, so a
// path's existence is remembered for a moment instead of being checked again.
const EXISTENCE_TTL_MS = 3_000;
const EXISTENCE_CACHE_MAX = 512;

export function createFileLinkProvider(
  term: Terminal,
  opts: FileLinkProviderOptions,
): ILinkProvider {
  const cache = new Map<string, { at: number; value: Promise<string | null> }>();
  const resolveCached = (file: string, cwd: string | null): Promise<string | null> => {
    const key = `${cwd ?? ""}\0${file}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < EXISTENCE_TTL_MS) return hit.value;
    if (cache.size >= EXISTENCE_CACHE_MAX) cache.clear();
    const value = opts.resolveExisting(file, cwd).catch(() => null);
    cache.set(key, { at: now, value });
    return value;
  };
  return {
    provideLinks(
      bufferLineNumber: number,
      callback: (links: ILink[] | undefined) => void,
    ): void {
      const buf = term.buffer.active;
      // xterm provides 1-based buffer line numbers; getLine wants 0-based
      // offsets into the active buffer (scrollback included).
      const line = buf.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      if (!text) {
        callback(undefined);
        return;
      }
      const matches = scanRowForPaths(text);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      const cwd = opts.getCwd();
      // The matches are string positions; the range is in cells, which part
      // ways after the first emoji or CJK character on the row.
      const columns = cellColumnsOfRow(line);
      // Resolve every match's existence in parallel — provideLinks fires once
      // per row entry so we're not doing this on every mouse-move.
      void Promise.all(matches.map((m) => resolveMatch(m, (file) => resolveCached(file, cwd)))).then((found) => {
        const resolved = dropOverlapping(
          found
            .filter((hit): hit is { candidate: PathCandidate; resolved: string } => hit !== null)
            .map((hit) => ({ ...hit.candidate, resolved: hit.resolved })),
        );
        const links = resolved.map((m): ILink => ({
          range: {
            // startCol - 1 is the first character's string index; endCol is
            // the index just past the last one, whose 0-based column is the
            // 1-based inclusive end column.
            start: { x: (columns[m.startCol - 1] ?? m.startCol - 1) + 1, y: bufferLineNumber },
            end: { x: columns[m.endCol] ?? m.endCol, y: bufferLineNumber },
          } satisfies IBufferRange,
          text: m.text,
          decorations: { pointerCursor: true, underline: true },
          activate: (event: MouseEvent) => {
            opts.onActivate({
              raw: m.text,
              file: m.resolved,
              line: m.line,
              column: m.column,
              event,
            });
          },
        }));
        callback(links.length > 0 ? links : undefined);
      });
    },
  };
}
