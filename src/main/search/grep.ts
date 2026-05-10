// Streaming project-wide content search backed by a bundled ripgrep binary.
//
// We spawn `rg --json` and parse newline-delimited JSON records as they
// arrive. Each `match` record is converted into a `SearchHit` and forwarded
// to the caller's `onHit` synchronously. When we hit `maxHits` we kill the
// child process so rg stops walking the workspace — this is what lets the
// Search panel render incrementally without ever buffering the full result
// set in memory.
//
// Binary path resolution: `@vscode/ripgrep` exports `rgPath` which resolves
// to a file inside an optional dependency package per platform/arch. In a
// packaged Electron app the binary lives inside `app.asar.unpacked` because
// the renderer cannot exec a file inside the asar archive — see the
// `asarUnpack` rules in `package.json`'s `build` block. The
// `app.asar/...` ↔ `app.asar.unpacked/...` rewrite below is what makes that
// work without per-platform special cases.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { rgPath as rgPathRaw } from "@vscode/ripgrep";
import type { SearchHit, SearchOptions, SearchSummary } from "@shared/types";

const DEFAULT_MAX_HITS = 2000;
const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024;

/**
 * Resolve the bundled `rg` binary path, accounting for Electron's asar
 * packaging. In dev `rgPath` points at the unpacked module under
 * `node_modules`; in a packaged build it points inside `app.asar` and we
 * have to rewrite to `app.asar.unpacked` (asarUnpack handles the actual
 * extraction).
 */
export function resolveRgPath(): string {
  const candidates: string[] = [];
  candidates.push(rgPathRaw);
  if (rgPathRaw.includes(`${"app.asar"}${pathSep()}`)) {
    candidates.push(rgPathRaw.replace(`${"app.asar"}${pathSep()}`, `app.asar.unpacked${pathSep()}`));
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore — fall through to the next candidate
    }
  }
  return rgPathRaw;
}

function pathSep(): string {
  return process.platform === "win32" ? "\\" : "/";
}

interface RgArbitraryData {
  text?: string;
  // rg also emits { bytes: "..." } for non-UTF-8 chunks; we treat those as
  // empty so the panel still renders something.
  bytes?: string;
}

interface RgSubmatch {
  match: RgArbitraryData;
  start: number;
  end: number;
}

interface RgRecordMatch {
  type: "match";
  data: {
    path: RgArbitraryData;
    lines: RgArbitraryData;
    line_number: number;
    absolute_offset: number;
    submatches: RgSubmatch[];
  };
}

interface RgRecordEnd {
  type: "end";
  data: {
    path: RgArbitraryData;
    stats?: { matches?: number };
  };
}

interface RgRecordSummary {
  type: "summary";
  data: {
    stats?: {
      matched_lines?: number;
      matches?: number;
    };
  };
}

type RgRecord = RgRecordMatch | RgRecordEnd | RgRecordSummary | { type: string };

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

function buildRgArgs(opts: SearchOptions): string[] {
  const args: string[] = [
    "--json",
    "--no-config",
    "--no-messages",
    "--hidden",
    "--max-filesize",
    String(opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE),
    "--glob",
    "!.git/**",
    "--glob",
    "!node_modules/**",
  ];
  if (opts.caseSensitive) args.push("--case-sensitive");
  else args.push("--ignore-case");
  if (opts.wholeWord) args.push("--word-regexp");
  if (!opts.isRegex) args.push("--fixed-strings");
  for (const include of opts.includeGlobs ?? []) {
    const trimmed = include.trim();
    if (!trimmed) continue;
    args.push("--glob", trimmed);
  }
  for (const exclude of opts.excludeGlobs ?? []) {
    const trimmed = exclude.trim();
    if (!trimmed) continue;
    args.push("--glob", trimmed.startsWith("!") ? trimmed : `!${trimmed}`);
  }
  // `--` separates the pattern from positional path args so a query that
  // starts with `-` is not interpreted as a flag.
  args.push("--", opts.query, opts.root);
  return args;
}

export interface StreamGrepHandle {
  cancel: () => void;
}

export type StreamGrepDoneHandler = (summary: SearchSummary) => void;
export type StreamGrepHitHandler = (hit: SearchHit) => void;

export function streamGrep(
  opts: SearchOptions,
  onHit: StreamGrepHitHandler,
  onDone: StreamGrepDoneHandler,
): StreamGrepHandle {
  const startedAt = Date.now();
  const maxHits = Math.max(1, opts.maxHits ?? DEFAULT_MAX_HITS);

  let totalHits = 0;
  let filesSearched = 0;
  let hitCap = false;
  let cancelled = false;
  let error: string | undefined;
  let done = false;

  const finish = (): void => {
    if (done) return;
    done = true;
    onDone({
      totalHits,
      filesSearched,
      hitCap,
      error,
      durationMs: Date.now() - startedAt,
    });
  };

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(resolveRgPath(), buildRgArgs(opts), {
      cwd: opts.root,
      windowsHide: true,
    });
  } catch (err) {
    error = (err as Error).message || String(err);
    finish();
    return { cancel: () => undefined };
  }

  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (cancelled || hitCap) return;
    stdoutBuffer += chunk;
    let nl = stdoutBuffer.indexOf("\n");
    while (nl >= 0) {
      const line = stdoutBuffer.slice(0, nl);
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      if (line.length > 0) handleLine(line);
      if (hitCap || cancelled) {
        stdoutBuffer = "";
        return;
      }
      nl = stdoutBuffer.indexOf("\n");
    }
  });

  // rg writes path-not-found and config errors to stderr. Capture only the
  // first message so we can report it without truncating the result panel.
  let stderrBuffer = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderrBuffer.length < 4096) stderrBuffer += chunk;
  });

  child.on("error", (err) => {
    error = err.message || String(err);
    finish();
  });

  child.on("close", (code) => {
    if (cancelled || hitCap) {
      finish();
      return;
    }
    // rg exits 0 on hits, 1 on no hits, anything else is an error.
    if (code !== null && code !== 0 && code !== 1) {
      const trimmed = stderrBuffer.trim();
      error = trimmed.length > 0 ? trimmed : `ripgrep exited ${code}`;
    }
    finish();
  });

  function handleLine(line: string): void {
    let record: RgRecord;
    try {
      record = JSON.parse(line) as RgRecord;
    } catch {
      return;
    }
    switch (record.type) {
      case "match":
        emitMatch(record as RgRecordMatch);
        break;
      case "end":
        filesSearched += 1;
        break;
      case "summary":
        // rg's own totals override our counter so we surface the correct
        // count even when --max-count caps line emission.
        if (record.type === "summary") {
          const summaryHits = (record as RgRecordSummary).data.stats?.matches;
          if (typeof summaryHits === "number" && !hitCap) {
            totalHits = Math.max(totalHits, summaryHits);
          }
        }
        break;
      default:
        break;
    }
  }

  function emitMatch(record: RgRecordMatch): void {
    if (cancelled || hitCap) return;
    const path = decodeText(record.data.path);
    const lineText = decodeText(record.data.lines).replace(/\r?\n$/, "");
    const lineNumber = record.data.line_number;
    const submatches = record.data.submatches ?? [];
    if (submatches.length === 0) {
      // rg always sets submatches for `match` records; if missing, fall back
      // to a synthesized hit that still surfaces the file/line so the user
      // is not silently dropped.
      const fallback: SearchHit = {
        path,
        line: lineNumber,
        column: 1,
        text: lineText,
        preMatch: "",
        matchText: lineText,
        postMatch: "",
      };
      forwardHit(fallback);
      return;
    }
    for (const submatch of submatches) {
      if (cancelled || hitCap) return;
      const matchText = decodeText(submatch.match);
      // rg's `start`/`end` are byte offsets into `lines.text`; for ASCII
      // they're equal to char offsets. For non-ASCII we'd ideally translate,
      // but the panel only uses pre/match/post for highlighting so a
      // best-effort byte slice is fine — rg already returned UTF-8 text.
      const buffer = Buffer.from(lineText, "utf8");
      const preBuf = buffer.subarray(0, Math.min(submatch.start, buffer.length));
      const postBuf = buffer.subarray(Math.min(submatch.end, buffer.length));
      const preMatch = preBuf.toString("utf8");
      const postMatch = postBuf.toString("utf8");
      const hit: SearchHit = {
        path,
        line: lineNumber,
        column: submatch.start + 1,
        text: lineText,
        preMatch,
        matchText,
        postMatch,
      };
      forwardHit(hit);
    }
  }

  function forwardHit(hit: SearchHit): void {
    totalHits += 1;
    try {
      onHit(hit);
    } catch {
      // Swallow renderer-side errors so a single bad listener cannot kill
      // the search stream.
    }
    if (totalHits >= maxHits) {
      hitCap = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
  }

  return {
    cancel: () => {
      if (cancelled || done) return;
      cancelled = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
    },
  };
}
