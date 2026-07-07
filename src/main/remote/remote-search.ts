import type { SearchHit, SearchOptions, SearchSummary } from "@shared/types";
import { makeRemotePath, parseRemotePath, remoteJoin } from "@shared/remote";
import { getConnection, shQuote } from "./connections";
import { parseRgLine } from "../search/rg-parse";

// Remote project-wide search: run `rg --json` on the host over a streaming
// exec channel and reuse the exact same NDJSON parser as local search. Paths
// rg reports are absolute host paths; we re-prefix them with ssh://<host>.
//
// Requires ripgrep on the host. If rg isn't installed (exit 127), the summary
// carries a clear "install ripgrep" error rather than silently returning
// nothing — grep has no --json mode, so matching the highlight fidelity of
// the local UI cheaply isn't possible without it.

const DEFAULT_MAX_HITS = 2000;
const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024;
const FLUSH_THRESHOLD = 100;
const FLUSH_INTERVAL_MS = 24;

export interface RemoteGrepHandle {
  cancel: () => void;
}

function buildRemoteRgCommand(opts: SearchOptions, remoteRootPath: string): string {
  const args = [
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
  for (const g of opts.includeGlobs ?? []) {
    const t = g.trim();
    if (t) args.push("--glob", t);
  }
  for (const g of opts.excludeGlobs ?? []) {
    const t = g.trim();
    if (t) args.push("--glob", t.startsWith("!") ? t : `!${t}`);
  }
  args.push("--", opts.query, remoteRootPath);
  // `command -v rg` guard turns a missing binary into exit 127 with a clear
  // marker on stderr; we surface that as the search error.
  return `rg ${args.map(shQuote).join(" ")}`;
}

export function remoteStreamGrep(
  opts: SearchOptions,
  onHit: (hits: SearchHit[]) => void,
  onDone: (summary: SearchSummary) => void,
): RemoteGrepHandle {
  const startedAt = Date.now();
  const maxHits = Math.max(1, opts.maxHits ?? DEFAULT_MAX_HITS);
  const parts = parseRemotePath(opts.root);

  let totalHits = 0;
  let filesSearched = 0;
  let hitCap = false;
  let cancelled = false;
  let done = false;
  let error: string | undefined;
  let hitBuffer: SearchHit[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let cancelStream: (() => void) | null = null;
  let stdoutBuffer = "";

  const flush = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (hitBuffer.length === 0) return;
    const batch = hitBuffer;
    hitBuffer = [];
    try {
      onHit(batch);
    } catch {
      /* ignore renderer listener errors */
    }
  };

  const finish = (): void => {
    if (done) return;
    done = true;
    flush();
    onDone({ totalHits, filesSearched, hitCap, error, durationMs: Date.now() - startedAt });
  };

  if (!parts) {
    error = "Not a remote path.";
    finish();
    return { cancel: () => undefined };
  }

  const mapPath = (hostPath: string): string => {
    // rg emits absolute host paths (we passed an absolute root); prefix them.
    const abs = hostPath.startsWith("/") ? hostPath : remoteJoin(parts.path, hostPath);
    return makeRemotePath(parts.hostId, abs);
  };

  const forwardHit = (hit: SearchHit): void => {
    totalHits += 1;
    hitBuffer.push(hit);
    if (hitBuffer.length >= FLUSH_THRESHOLD) flush();
    else if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
    if (totalHits >= maxHits && !hitCap) {
      hitCap = true;
      cancelStream?.();
    }
  };

  const feedLine = (line: string): void => {
    if (cancelled || hitCap) return;
    const result = parseRgLine(line, mapPath);
    if (result.fileEnded) filesSearched += 1;
    for (const hit of result.hits) {
      if (cancelled || hitCap) break;
      forwardHit(hit);
    }
    if (typeof result.summaryMatches === "number" && !hitCap) {
      totalHits = Math.max(totalHits, result.summaryMatches);
    }
  };

  void (async () => {
    try {
      const conn = await getConnection(parts.hostId);
      const command = buildRemoteRgCommand(opts, parts.path);
      const stream = await conn.execStream(command, {
        onStdout: (chunk) => {
          if (cancelled || hitCap) return;
          stdoutBuffer += chunk;
          let nl = stdoutBuffer.indexOf("\n");
          while (nl >= 0) {
            const line = stdoutBuffer.slice(0, nl);
            stdoutBuffer = stdoutBuffer.slice(nl + 1);
            if (line.length > 0) feedLine(line);
            if (hitCap || cancelled) {
              stdoutBuffer = "";
              return;
            }
            nl = stdoutBuffer.indexOf("\n");
          }
        },
        onExit: (code) => {
          // rg: 0 = hits, 1 = no hits, 127 = not found, else error.
          if (!cancelled && !hitCap && code !== null && code !== 0 && code !== 1) {
            error =
              code === 127
                ? "ripgrep (rg) is not installed on the host. Install it to search remote workspaces."
                : `remote search exited ${code}`;
          }
          finish();
        },
      });
      cancelStream = stream.cancel;
      if (cancelled) stream.cancel();
    } catch (err) {
      error = (err as Error).message || String(err);
      finish();
    }
  })();

  return {
    cancel: () => {
      if (cancelled || done) return;
      cancelled = true;
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      cancelStream?.();
    },
  };
}
