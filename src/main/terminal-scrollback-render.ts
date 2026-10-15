import { Terminal } from "@xterm/headless";

// Turns a pane's recorded output into text a terminal can replay.
//
// Raw PTY bytes are a poor record: an agent's TUI repaints its footer many
// times a second, so a few hundred kilobytes may hold only the last minute of
// a long turn, and replaying them into a pane of another width garbles every
// cursor-relative repaint. The store therefore folds old bytes through a
// throwaway headless terminal into the cells they produced, and this module
// writes those cells back out as plain lines with SGR colors.
//
// Two forms:
// - resume: the screen exactly as it stood (viewport rows, cursor, scroll
//   region, alternate screen), so the raw bytes recorded after it still land
//   where the program meant them to.
// - display: logical lines only, no cursor movement and no modes, safe to
//   write into any xterm at any width. Nothing in it can make a terminal
//   answer, open a link or change how keys are encoded.

type HeadlessBuffer = Terminal["buffer"]["normal"];
type HeadlessLine = NonNullable<ReturnType<HeadlessBuffer["getLine"]>>;
type HeadlessCell = ReturnType<HeadlessBuffer["getNullCell"]>;

export interface ScrollbackRenderLimits {
  // Physical rows kept above and including the screen.
  maxLines: number;
  // Characters of output, escape sequences included. The screen itself is
  // always kept in the resume form.
  maxChars: number;
}

const MIN_COLS = 10;
const MAX_COLS = 1000;
const MIN_ROWS = 2;
const MAX_ROWS = 500;

export function clampGeometry(cols: number, rows: number): { cols: number; rows: number } {
  const c = Number.isFinite(cols) ? Math.trunc(cols) : 80;
  const r = Number.isFinite(rows) ? Math.trunc(rows) : 24;
  return {
    cols: Math.min(MAX_COLS, Math.max(MIN_COLS, c)),
    rows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, r)),
  };
}

/** Parse `chunks` into a fresh headless terminal and resolve once xterm has consumed them all. */
export async function parseTerminal(
  chunks: ReadonlyArray<string | Uint8Array>,
  cols: number,
  rows: number,
  scrollback: number,
): Promise<Terminal> {
  const size = clampGeometry(cols, rows);
  const term = new Terminal({
    cols: size.cols,
    rows: size.rows,
    scrollback: Math.max(0, Math.trunc(scrollback)),
    allowProposedApi: true,
  });
  try {
    for (const chunk of chunks) {
      if (chunk.length > 0) term.write(chunk);
    }
    await new Promise<void>((resolve) => term.write("", resolve));
  } catch (err) {
    term.dispose();
    throw err;
  }
  return term;
}

function sgrFor(cell: HeadlessCell): string {
  if (cell.isAttributeDefault()) return "";
  const params: string[] = [];
  if (cell.isBold()) params.push("1");
  if (cell.isDim()) params.push("2");
  if (cell.isItalic()) params.push("3");
  if (cell.isUnderline()) params.push("4");
  if (cell.isBlink()) params.push("5");
  if (cell.isInverse()) params.push("7");
  if (cell.isInvisible()) params.push("8");
  if (cell.isStrikethrough()) params.push("9");
  if (cell.isOverline()) params.push("53");
  if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    params.push(`38;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`);
  } else if (cell.isFgPalette()) {
    const n = cell.getFgColor();
    params.push(n < 8 ? String(30 + n) : n < 16 ? String(90 + n - 8) : `38;5;${n}`);
  }
  if (cell.isBgRGB()) {
    const c = cell.getBgColor();
    params.push(`48;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`);
  } else if (cell.isBgPalette()) {
    const n = cell.getBgColor();
    params.push(n < 8 ? String(40 + n) : n < 16 ? String(100 + n - 8) : `48;5;${n}`);
  }
  return params.join(";");
}

// One past the last cell that shows anything: a glyph, or a colored or
// inverted background. Trailing default blanks are dropped.
function contentEnd(line: HeadlessLine, cell: HeadlessCell, cols: number): number {
  for (let x = Math.min(line.length, cols) - 1; x >= 0; x -= 1) {
    line.getCell(x, cell);
    const chars = cell.getChars();
    if ((chars !== "" && chars !== " ") || !cell.isBgDefault() || cell.isInverse()) return x + 1;
  }
  return 0;
}

interface SgrState {
  sgr: string;
}

function serializeCells(
  line: HeadlessLine,
  cell: HeadlessCell,
  end: number,
  state: SgrState,
): string {
  let out = "";
  for (let x = 0; x < end; x += 1) {
    line.getCell(x, cell);
    if (cell.getWidth() === 0) continue;
    const sgr = sgrFor(cell);
    if (sgr !== state.sgr) {
      out += sgr ? `\x1b[0;${sgr}m` : "\x1b[0m";
      state.sgr = sgr;
    }
    const chars = cell.getChars();
    out += chars === "" ? " " : chars;
  }
  return out;
}

// Rows `start..end` of one logical line (the first row not wrapped, the rest
// wrap continuations). Every row but the last is written at full width so it
// wraps at the same column when parsed again at the same size.
function serializeLogicalLine(
  buffer: HeadlessBuffer,
  cell: HeadlessCell,
  cols: number,
  start: number,
  end: number,
): string {
  const state: SgrState = { sgr: "" };
  let out = "";
  for (let row = start; row <= end; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const width = row < end ? Math.min(line.length, cols) : contentEnd(line, cell, cols);
    out += serializeCells(line, cell, width, state);
  }
  if (state.sgr) out += "\x1b[0m";
  return out;
}

interface CollectedLines {
  lines: string[];
  firstRow: number;
}

// Logical lines ending at `lastRow`, newest first until a budget runs out.
// A line reaching into the bottom `keepRows` rows is kept whatever the
// budget says.
function collectLines(
  buffer: HeadlessBuffer,
  cols: number,
  lastRow: number,
  limits: ScrollbackRenderLimits,
  keepRows: number,
): CollectedLines {
  const cell = buffer.getNullCell();
  const lines: string[] = [];
  let rowsUsed = 0;
  let chars = 0;
  let row = lastRow;
  let firstRow = lastRow + 1;
  while (row >= 0) {
    let start = row;
    while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1;
    const height = row - start + 1;
    const text = serializeLogicalLine(buffer, cell, cols, start, row);
    const mandatory = lastRow - row < keepRows;
    if (!mandatory && (rowsUsed + height > limits.maxLines || chars + text.length + 2 > limits.maxChars)) break;
    lines.push(text);
    rowsUsed += height;
    chars += text.length + 2;
    firstRow = start;
    row = start - 1;
  }
  lines.reverse();
  return { lines, firstRow };
}

function lastContentRow(buffer: HeadlessBuffer, cols: number, from: number): number {
  const cell = buffer.getNullCell();
  for (let row = from; row >= 0; row -= 1) {
    const line = buffer.getLine(row);
    if (line && contentEnd(line, cell, cols) > 0) return row;
  }
  return -1;
}

function scrollRegion(term: Terminal, which: "normal" | "alternate"): { top: number; bottom: number } | null {
  // Not public API: xterm keeps the margins on each buffer. Read defensively
  // so a future xterm only loses the margins, never the output.
  try {
    const core = (term as unknown as {
      _core?: { _bufferService?: { buffers?: Record<string, { scrollTop?: unknown; scrollBottom?: unknown }> } };
    })._core;
    const buffer = core?._bufferService?.buffers?.[which];
    if (typeof buffer?.scrollTop === "number" && typeof buffer.scrollBottom === "number") {
      return { top: buffer.scrollTop, bottom: buffer.scrollBottom };
    }
  } catch {
    /* fall through */
  }
  return null;
}

function marginSequence(term: Terminal, which: "normal" | "alternate"): string {
  const region = scrollRegion(term, which);
  if (!region) return "";
  if (region.top <= 0 && region.bottom >= term.rows - 1) return "";
  return `\x1b[${region.top + 1};${region.bottom + 1}r`;
}

/**
 * The screen as it stands, for the store to keep in place of the bytes that
 * produced it. Parsing this at the same size gives the same viewport rows and
 * cursor, so later raw output still lands in the right place.
 */
export function serializeForResume(term: Terminal, limits: ScrollbackRenderLimits): string {
  const cols = term.cols;
  const rows = term.rows;
  const normal = term.buffer.normal;
  const viewportEnd = normal.length - 1;
  const { lines } = collectLines(normal, cols, viewportEnd, limits, rows);
  let out = lines.join("\r\n");
  out += marginSequence(term, "normal");
  out += `\x1b[${normal.cursorY + 1};${normal.cursorX + 1}H`;
  if (!term.modes.wraparoundMode) out += "\x1b[?7l";
  if (term.modes.insertMode) out += "\x1b[4h";
  if (term.buffer.active.type === "alternate") {
    const alt = term.buffer.alternate;
    const cell = alt.getNullCell();
    // 1049 saves the cursor placed above and clears the alternate screen.
    out += "\x1b[?1049h\x1b[H";
    for (let row = 0; row < rows; row += 1) {
      const line = alt.getLine(row);
      if (!line) continue;
      const end = contentEnd(line, cell, cols);
      if (end === 0) continue;
      const state: SgrState = { sgr: "" };
      out += `\x1b[${row + 1};1H${serializeCells(line, cell, end, state)}`;
      if (state.sgr) out += "\x1b[0m";
    }
    out += marginSequence(term, "alternate");
    out += `\x1b[${alt.cursorY + 1};${alt.cursorX + 1}H`;
  }
  return out;
}

/**
 * Logical lines for a person to read, oldest first, each ending in CRLF.
 * When a full-screen program was open, its last frame follows the history.
 */
export function serializeForDisplay(term: Terminal, limits: ScrollbackRenderLimits): string {
  const cols = term.cols;
  const normal = term.buffer.normal;
  const parts: string[] = [];
  let budget = limits;
  if (term.buffer.active.type === "alternate") {
    const alt = term.buffer.alternate;
    const lastAlt = lastContentRow(alt, cols, alt.length - 1);
    if (lastAlt >= 0) {
      const frame = collectLines(alt, cols, lastAlt, limits, 0);
      parts.push(...frame.lines);
      const used = frame.lines.reduce((sum, line) => sum + line.length + 2, 0);
      budget = {
        maxLines: Math.max(0, limits.maxLines - (lastAlt - frame.firstRow + 1)),
        maxChars: Math.max(0, limits.maxChars - used),
      };
    }
  }
  const lastNormal = lastContentRow(normal, cols, normal.length - 1);
  const history = lastNormal >= 0 ? collectLines(normal, cols, lastNormal, budget, 0).lines : [];
  const lines = [...history, ...parts];
  return lines.length > 0 ? `${lines.join("\r\n")}\r\n` : "";
}

/** Fold `prefix` (an earlier resume form) and newer raw bytes into one resume form. */
export async function compactScrollback(
  prefix: string,
  raw: ReadonlyArray<Uint8Array>,
  cols: number,
  rows: number,
  limits: ScrollbackRenderLimits,
): Promise<string> {
  const term = await parseTerminal([prefix, ...raw], cols, rows, limits.maxLines);
  try {
    return serializeForResume(term, limits);
  } finally {
    term.dispose();
  }
}

/** What a restored pane shows of its saved output. */
export async function renderScrollbackForDisplay(
  chunks: ReadonlyArray<string | Uint8Array>,
  cols: number,
  rows: number,
  limits: ScrollbackRenderLimits,
): Promise<string> {
  const term = await parseTerminal(chunks, cols, rows, limits.maxLines);
  try {
    return serializeForDisplay(term, limits);
  } finally {
    term.dispose();
  }
}
