// The two real limit readings the CLIs leave in their own transcripts, for
// the usage forecast:
//
//   Claude Code writes a synthetic "You've hit your session limit · resets
//   3am (Europe/Madrid)" message when a 5-hour window runs out: a moment the
//   window was at exactly 100%.
//   Codex writes the account's rate limits (used percent, window length,
//   reset time) on every token_count event: a real reading per turn.
//
// Runs on the usage scan worker. Read-only on the transcripts; the per-file
// memo is persisted next to the usage scan cache.

import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { listTranscriptFiles, type UsageScanRoot } from "./usage-scan";

export interface ClaudeLimitHit {
  atMs: number;
  /** The reset the message announced, or null when its clock could not be read. */
  resetsAtMs: number | null;
  kind: "session" | "weekly" | "other";
}

export interface CodexLimitSample {
  atMs: number;
  limitId: string;
  windowMinutes: number;
  usedPercent: number;
  resetsAtMs: number;
}

export interface ForecastSignals {
  claudeHits: ClaudeLimitHit[];
  codexSamples: CodexLimitSample[];
}

export interface ForecastSignalsRequest {
  roots: UsageScanRoot[];
  memoPath: string;
  sinceMs: number;
}

interface MemoEntry {
  size: number;
  mtimeMs: number;
  hits?: ClaudeLimitHit[];
  samples?: CodexLimitSample[];
}

const MEMO_VERSION = 1;
const memo = new Map<string, MemoEntry>();
let memoLoadedFrom: string | null = null;

/** Session limits name a clock time in a zone ("resets 3am (Europe/Madrid)"). */
const RESET_CLOCK = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?/i;

function zoneOffsetMs(atMs: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(atMs));
    const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return asUtc - Math.floor(atMs / 1000) * 1000;
  } catch {
    return null;
  }
}

/** The first moment after atMs whose wall clock in the zone reads the given time. */
export function nextClockTime(atMs: number, hour24: number, minute: number, timeZone: string | null): number | null {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = zoneOffsetMs(atMs, zone);
  if (offset === null) return null;
  const local = new Date(atMs + offset);
  let candidate =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour24, minute) - offset;
  while (candidate <= atMs) candidate += 24 * 60 * 60 * 1000;
  return candidate;
}

export function parseClaudeLimitLine(line: string): ClaudeLimitHit | null {
  if (!line.includes('"rate_limit"') || !line.includes("hit your")) return null;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (record.error !== "rate_limit" || record.isApiErrorMessage !== true) return null;
  const atMs = Date.parse(String(record.timestamp ?? ""));
  if (Number.isNaN(atMs)) return null;
  const message = record.message as { content?: unknown } | undefined;
  const parts = Array.isArray(message?.content) ? (message?.content as unknown[]) : [];
  const text = parts
    .map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .join(" ");
  const kind = /session limit/i.test(text) ? "session" : /weekly limit/i.test(text) ? "weekly" : "other";
  const clock = RESET_CLOCK.exec(text);
  let resetsAtMs: number | null = null;
  if (clock) {
    const hour12 = Number(clock[1]) % 12;
    const hour24 = (clock[3] ?? "").toLowerCase() === "pm" ? hour12 + 12 : hour12;
    resetsAtMs = nextClockTime(atMs, hour24, Number(clock[2] ?? 0), clock[4] ?? null);
  }
  return { atMs, resetsAtMs, kind };
}

export function parseCodexLimitLine(line: string): CodexLimitSample[] {
  if (!line.includes('"rate_limits"')) return [];
  let record: { timestamp?: unknown; payload?: { rate_limits?: unknown } };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    return [];
  }
  const atMs = Date.parse(String(record.timestamp ?? ""));
  const limits = record.payload?.rate_limits as Record<string, unknown> | null | undefined;
  if (Number.isNaN(atMs) || !limits || typeof limits !== "object") return [];
  const limitId = typeof limits.limit_id === "string" ? limits.limit_id : "codex";
  const samples: CodexLimitSample[] = [];
  for (const key of ["primary", "secondary"]) {
    const window = limits[key] as Record<string, unknown> | null | undefined;
    if (!window || typeof window !== "object") continue;
    const usedPercent = Number(window.used_percent);
    const windowMinutes = Number(window.window_minutes);
    const resetsAt = Number(window.resets_at);
    if (![usedPercent, windowMinutes, resetsAt].every(Number.isFinite)) continue;
    samples.push({ atMs, limitId, windowMinutes, usedPercent, resetsAtMs: resetsAt * 1000 });
  }
  return samples;
}

async function readSignals(path: string, provider: UsageScanRoot["provider"]): Promise<MemoEntry | null> {
  const hits: ClaudeLimitHit[] = [];
  const samples: CodexLimitSample[] = [];
  let lastKey = "";
  try {
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (provider === "claude") {
        const hit = parseClaudeLimitLine(line);
        if (hit) hits.push(hit);
      } else if (provider === "codex") {
        for (const sample of parseCodexLimitLine(line)) {
          // Codex repeats the same reading on every event of a turn; keep changes only.
          const key = `${sample.limitId}|${sample.windowMinutes}|${sample.usedPercent}|${sample.resetsAtMs}`;
          if (key === lastKey) continue;
          lastKey = key;
          samples.push(sample);
        }
      }
    }
  } catch {
    return null;
  }
  return { size: 0, mtimeMs: 0, hits, samples };
}

async function loadMemo(memoPath: string): Promise<void> {
  if (memoLoadedFrom === memoPath) return;
  memo.clear();
  memoLoadedFrom = memoPath;
  try {
    const raw = JSON.parse(await fs.readFile(memoPath, "utf8")) as { version?: number; files?: Record<string, MemoEntry> };
    if (raw.version !== MEMO_VERSION || !raw.files) return;
    for (const [path, entry] of Object.entries(raw.files)) memo.set(path, entry);
  } catch {
    // Missing or unreadable: one cold read, then it is rewritten.
  }
}

export async function scanForecastSignals(request: ForecastSignalsRequest): Promise<ForecastSignals> {
  await loadMemo(request.memoPath);
  const claudeHits: ClaudeLimitHit[] = [];
  const codexSamples: CodexLimitSample[] = [];
  const live = new Set<string>();
  let dirty = false;
  for (const root of request.roots) {
    if (root.error !== null || root.dir.length === 0) continue;
    if (root.provider !== "claude" && root.provider !== "codex") continue;
    const files = await listTranscriptFiles(root.dir, request.sinceMs);
    for (const file of files) {
      live.add(file.path);
      let entry = memo.get(file.path);
      if (!entry || entry.size !== file.size || entry.mtimeMs !== file.mtimeMs) {
        const read = await readSignals(file.path, root.provider);
        if (read === null) continue;
        entry = { ...read, size: file.size, mtimeMs: file.mtimeMs };
        memo.set(file.path, entry);
        dirty = true;
      }
      if (entry.hits) claudeHits.push(...entry.hits.filter((hit) => hit.atMs >= request.sinceMs));
      if (entry.samples) codexSamples.push(...entry.samples.filter((sample) => sample.atMs >= request.sinceMs));
    }
  }
  for (const path of memo.keys()) {
    if (!live.has(path)) {
      memo.delete(path);
      dirty = true;
    }
  }
  if (dirty) {
    try {
      await fs.writeFile(
        request.memoPath,
        JSON.stringify({ version: MEMO_VERSION, files: Object.fromEntries(memo) }),
        "utf8",
      );
    } catch {
      // The memo only saves time; the next scan reads again.
    }
  }
  claudeHits.sort((a, b) => a.atMs - b.atMs);
  codexSamples.sort((a, b) => a.atMs - b.atMs);
  return { claudeHits, codexSamples };
}
