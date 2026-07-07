import type { SearchHit } from "@shared/types";

// Pure parser for ripgrep's `--json` NDJSON output, shared by the local
// (child_process spawn) and remote (SSH exec stream) search backends. Each
// `match` record becomes one or more SearchHits; `end` marks a file finished;
// `summary` carries rg's authoritative match total. `mapPath` lets the remote
// backend re-prefix rg's absolute host paths with ssh://<host>.

interface RgArbitraryData {
  text?: string;
  bytes?: string;
}
interface RgSubmatch {
  match: RgArbitraryData;
  start: number;
  end: number;
}
interface RgRecordMatch {
  type: "match";
  data: { path: RgArbitraryData; lines: RgArbitraryData; line_number: number; submatches: RgSubmatch[] };
}
interface RgRecordSummary {
  type: "summary";
  data: { stats?: { matches?: number } };
}
type RgRecord = RgRecordMatch | RgRecordSummary | { type: string };

function decodeText(value: RgArbitraryData | undefined): string {
  if (!value) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.bytes === "string") {
    try {
      return Buffer.from(value.bytes, "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  return "";
}

export interface RgLineResult {
  hits: SearchHit[];
  fileEnded: boolean;
  summaryMatches?: number;
}

const EMPTY: RgLineResult = { hits: [], fileEnded: false };

export function parseRgLine(line: string, mapPath: (p: string) => string): RgLineResult {
  let record: RgRecord;
  try {
    record = JSON.parse(line) as RgRecord;
  } catch {
    return EMPTY;
  }
  if (record.type === "end") return { hits: [], fileEnded: true };
  if (record.type === "summary") {
    const matches = (record as RgRecordSummary).data.stats?.matches;
    return { hits: [], fileEnded: false, summaryMatches: typeof matches === "number" ? matches : undefined };
  }
  if (record.type !== "match") return EMPTY;

  const m = record as RgRecordMatch;
  const path = mapPath(decodeText(m.data.path));
  const lineText = decodeText(m.data.lines).replace(/\r?\n$/, "");
  const lineNumber = m.data.line_number;
  const submatches = m.data.submatches ?? [];
  if (submatches.length === 0) {
    return {
      hits: [{ path, line: lineNumber, column: 1, text: lineText, preMatch: "", matchText: lineText, postMatch: "" }],
      fileEnded: false,
    };
  }
  const buffer = Buffer.from(lineText, "utf8");
  const hits: SearchHit[] = [];
  for (const sm of submatches) {
    const matchText = decodeText(sm.match);
    const preMatch = buffer.subarray(0, Math.min(sm.start, buffer.length)).toString("utf8");
    const postMatch = buffer.subarray(Math.min(sm.end, buffer.length)).toString("utf8");
    hits.push({ path, line: lineNumber, column: sm.start + 1, text: lineText, preMatch, matchText, postMatch });
  }
  return { hits, fileEnded: false };
}
