import type { IBufferRange, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

// xterm link provider that detects file-path-shaped tokens in terminal output
// and turns them into ctrl/cmd-clickable links. Sister to the bundled
// WebLinksAddon — same hover/underline UX (we share xterm's default link
// decorations), modifier-gated activation, async existence check before the
// callback fires so non-existent paths quietly never light up.
//
// Detector strategy: union of three patterns, applied to a single buffer row.
//   1. Windows drive-letter absolute   C:\foo\bar.ts  or  D:/foo/bar
//   2. POSIX absolute                  /home/jorge/foo.ts
//   3. Explicit relative               ./src/x  or  ../pkg/y
//   4. Bare with extension             src/foo.ts  (only when matcher has a
//                                      path separator or a known-ish extension)
// Each match optionally consumes a `:line[:col]` or `(line,col)` suffix from
// stack-trace formats so the user clicks the whole pretty token, not just the
// path. For the prototype we ignore the captured line/col on the open call —
// openFileByPath takes a path-only argument today.
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
// not "POSIX path `C` + everything else".
const PATH_TOKEN = String.raw`(?:[A-Za-z]:[\\/](?:[^\s"'()<>:*?|]|:(?!\d))+|\/[^\s"'()<>:]+|\.{1,2}[\\/][^\s"'()<>:]+|(?:[A-Za-z0-9_\-]+[\\/])+[A-Za-z0-9_\-.]+)`;
const LINE_COL = String.raw`(?::(\d+)(?::(\d+))?|\((\d+)(?:[,:](\d+))?\))`;
const MATCH_RE = new RegExp(String.raw`(${PATH_TOKEN})(?:${LINE_COL})?`, "g");

// File-extension whitelist for the bare relative pattern (the 4th alternative
// above). Without this, every "word/word" two-segment token (e.g. tab-separated
// columns in log output) lights up. We allow common code / data / docs
// extensions; anything else needs a leading slash or `./` to activate.
const KNOWN_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "json", "jsonc", "yaml", "yml", "toml", "ini", "env",
  "md", "mdx", "txt", "log", "csv", "tsv",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp",
  "cs", "php", "lua", "sh", "ps1", "bat", "cmd",
  "css", "scss", "sass", "less", "html", "htm", "vue", "svelte",
  "sql", "graphql", "proto", "xml", "lock",
]);

// Punctuation that frequently trails a path in prose ("see foo.ts.") but is
// almost never part of the filename itself. Stripped after the regex match.
function stripTrailingPunct(s: string): string {
  return s.replace(/[.,;:!?)\]}>'"`]+$/u, "");
}

function looksLikeRealPath(token: string): boolean {
  if (!token) return false;
  // URLs sneak past the drive-letter branch (`https://…` matches as drive
  // letter `s` + `://…`). Drop anything with a scheme separator outright;
  // the WebLinksAddon already handles real URLs.
  if (token.includes("://")) return false;
  // Absolute and explicit-relative are always candidates.
  if (/^([A-Za-z]:[\\/]|\/|\.{1,2}[\\/])/.test(token)) return true;
  // Bare relative needs both a separator and a recognized extension to
  // avoid lighting up every prose "word/word".
  if (!/[\\/]/.test(token)) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = token.slice(dot + 1).toLowerCase();
  return KNOWN_EXTENSIONS.has(ext);
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

interface RawMatch {
  text: string;
  file: string;
  line?: number;
  column?: number;
  /** 1-based start column in the row. */
  startCol: number;
  /** 1-based end column (inclusive). */
  endCol: number;
}

export function scanRowForPaths(row: string): RawMatch[] {
  const out: RawMatch[] = [];
  MATCH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MATCH_RE.exec(row)) !== null) {
    const wholeStart = m.index;
    const whole = m[0];
    const rawPath = stripTrailingPunct(m[1] ?? "");
    if (!looksLikeRealPath(rawPath)) continue;
    // Reject POSIX-absolute matches whose enclosing whitespace-bounded token
    // contains a URL scheme — `http://localhost:5173/index.html` would
    // otherwise light up the `/index.html` tail as a clickable file. We
    // look at the run of non-space chars before the match for `://`.
    if (rawPath.startsWith("/")) {
      const before = row.slice(0, wholeStart);
      const lastWs = Math.max(
        before.lastIndexOf(" "),
        before.lastIndexOf("\t"),
      );
      const tokenPrefix = lastWs >= 0 ? before.slice(lastWs + 1) : before;
      if (tokenPrefix.includes("://")) continue;
    }
    const lineNum = m[2] ?? m[4];
    const colNum = m[3] ?? m[5];
    // 1-based columns for xterm IBufferRange. The provider returns the
    // FULL token including any line/col suffix so the underline covers it.
    const startCol = wholeStart + 1;
    const endCol = wholeStart + whole.length;
    out.push({
      text: whole,
      file: rawPath,
      line: lineNum ? Number(lineNum) : undefined,
      column: colNum ? Number(colNum) : undefined,
      startCol,
      endCol,
    });
  }
  return out;
}

export function createFileLinkProvider(
  term: Terminal,
  opts: FileLinkProviderOptions,
): ILinkProvider {
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
      // Resolve every match's existence in parallel — provideLinks fires once
      // per row entry so we're not doing this on every mouse-move.
      void Promise.all(
        matches.map(async (m) => {
          const resolved = await opts.resolveExisting(m.file, cwd);
          if (!resolved) return null;
          const range: IBufferRange = {
            start: { x: m.startCol, y: bufferLineNumber },
            end: { x: m.endCol, y: bufferLineNumber },
          };
          const link: ILink = {
            range,
            text: m.text,
            decorations: { pointerCursor: true, underline: true },
            activate: (event: MouseEvent) => {
              opts.onActivate({
                raw: m.text,
                file: resolved,
                line: m.line,
                column: m.column,
                event,
              });
            },
          };
          return link;
        }),
      ).then((resolved) => {
        const links = resolved.filter((l): l is ILink => l !== null);
        callback(links.length > 0 ? links : undefined);
      });
    },
  };
}
