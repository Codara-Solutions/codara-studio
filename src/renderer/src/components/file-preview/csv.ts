export type CsvDelimiter = "auto" | "," | ";" | "\t" | "|";
export const CSV_ROW_LIMIT = 50_000;
export const CSV_COLUMN_LIMIT = 200;

export function isCsvPath(path: string): boolean {
  return /\.(csv|tsv|psv)$/i.test(path);
}

export interface CsvData {
  rows: string[][];
  rowStarts: number[];
  sourceRows: number;
  sourceColumns: number;
  malformed: boolean;
  truncated: boolean;
}

// Keep values as strings: previewing must preserve leading zeros, large IDs,
// formula-like text, whitespace, and the spelling of dates and decimals.
export function parseCsv(
  text: string,
  delimiter: string,
  rowLimit = CSV_ROW_LIMIT + 1,
  columnLimit = CSV_COLUMN_LIMIT,
  sample = false,
): CsvData {
  const rows: string[][] = [];
  const rowStarts: number[] = [];
  let rowStart = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let row: string[] = [];
  let value = "";
  let quoted = false;
  let closedQuote = false;
  let started = false;
  let fieldStarted = false;
  let columns = 0;
  let sourceRows = 0;
  let sourceColumns = 0;
  let malformed = false;
  const append = (char: string) => {
    if (sourceRows < rowLimit && columns < columnLimit) value += char;
  };
  const finishCell = () => {
    if (sourceRows < rowLimit && columns < columnLimit) row.push(value);
    columns++;
    value = "";
    closedQuote = false;
    fieldStarted = false;
  };
  const finishRow = () => {
    finishCell();
    if (sourceRows < rowLimit) { rows.push(row); rowStarts.push(rowStart); }
    sourceRows++;
    sourceColumns = Math.max(sourceColumns, columns);
    row = [];
    columns = 0;
    started = false;
  };
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          append('"');
          i++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else append(char);
      continue;
    }
    if (char === delimiter) {
      finishCell();
      started = true;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      // A truly blank line is not a record. Explicit empty cells still are.
      if (started || columns > 0) finishRow();
      rowStart = i + 1;
      if (sample && sourceRows >= rowLimit) break;
    } else if (char === '"' && !fieldStarted) {
      quoted = true;
      started = true;
      fieldStarted = true;
    } else {
      if (closedQuote || char === '"') malformed = true;
      append(char);
      started = true;
      fieldStarted = true;
    }
  }
  if (quoted) malformed = true;
  if (started || columns > 0) finishRow();
  return {
    rows, rowStarts, sourceRows, sourceColumns, malformed,
    truncated: sourceRows > rowLimit || sourceColumns > columnLimit,
  };
}

export function resolveCsv(text: string, path: string, choice: CsvDelimiter) {
  const preamble = /^\uFEFF?sep=([,;\t|])(?:\r\n|\n|\r)/i.exec(text);
  const content = preamble ? text.slice(preamble[0].length) : text;
  let delimiter = choice === "auto" ? preamble?.[1] : choice;
  if (!delimiter) {
    const preferred = /\.tsv$/i.test(path) ? "\t" : /\.psv$/i.test(path) ? "|" : ",";
    let best = 0;
    delimiter = preferred;
    for (const candidate of [preferred, ...[",", ";", "\t", "|"].filter((d) => d !== preferred)]) {
      const sample = parseCsv(content, candidate, 32, CSV_COLUMN_LIMIT, true);
      const counts = new Map<number, number>();
      for (const row of sample.rows) {
        if (row.length > 1) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
      }
      for (const [width, count] of counts) {
        const score = count / Math.max(sample.rows.length, 1) * 100 + Math.min(width, 10) - (sample.malformed ? 20 : 0);
        if (score > best) { best = score; delimiter = candidate; }
      }
    }
  }
  const parsed = parseCsv(content, delimiter);
  if (preamble) parsed.rowStarts = parsed.rowStarts.map((start) => start + preamble[0].length);
  return { ...parsed, delimiter };
}

export function csvColumnLabel(index: number): string {
  let label = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    label = String.fromCharCode(65 + (n - 1) % 26) + label;
  }
  return label;
}

export function isCsvNumber(value: string): boolean {
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim());
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export function compareCsvCells(a: string, b: string): number {
  if (!a.trim()) return b.trim() ? 1 : 0;
  if (!b.trim()) return -1;
  if (isCsvNumber(a) && isCsvNumber(b)) {
    const left = Number(a), right = Number(b);
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left < right ? -1 : 1;
  }
  return collator.compare(a, b);
}

// Replace one field in place so untouched quoting, blank lines, the BOM, and
// line endings survive a cell edit. Ragged rows gain only the missing cells.
export function replaceCsvCell(
  text: string,
  parsed: CsvData & { delimiter: string },
  row: number,
  column: number,
  value: string,
): string {
  const rowStart = parsed.rowStarts[row];
  if (parsed.malformed || rowStart === undefined || !Number.isInteger(column) || column < 0 || column >= CSV_COLUMN_LIMIT) {
    throw new Error("Check the file in Source before editing this cell.");
  }
  if ((parsed.rows[row]?.[column] ?? "") === value) return text;
  const encode = (wasQuoted: boolean) => {
    const quote = wasQuoted || value === "" || /[",;\t|\r\n]/.test(value) || /^\s|\s$/.test(value);
    return quote ? `"${value.replace(/"/g, '""')}"` : value;
  };
  let fieldStart = rowStart;
  let currentColumn = 0;
  let quoted = false;
  for (let i = rowStart; i <= text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && (char === parsed.delimiter || char === "\r" || char === "\n" || char === undefined)) {
      if (currentColumn === column) {
        return text.slice(0, fieldStart) + encode(text[fieldStart] === '"') + text.slice(i);
      }
      if (char !== parsed.delimiter) {
        return text.slice(0, i) + parsed.delimiter.repeat(column - currentColumn) + encode(false) + text.slice(i);
      }
      currentColumn++;
      fieldStart = i + 1;
    }
  }
  throw new Error("This cell could not be located. Reopen it and try again.");
}
