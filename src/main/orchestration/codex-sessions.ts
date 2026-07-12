// Shared Codex rollout/session discovery.
//
// Codex writes one JSONL "rollout" per session at
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// organized by DATE, not by cwd — so a session's working directory is only
// recoverable by reading the file's leading `session_meta` entry, not from the
// path. These primitives (originally private to codex-backend.ts) are shared so
// both the managed chat backend and the manual-terminal session-restore feature
// can find and identify a rollout after spawning `codex`.

import { promises as fs } from "node:fs";
import { join } from "node:path";

export const ROLLOUT_FILENAME_UUID_RE = /rollout-.*-([0-9a-f-]{36})\.jsonl$/i;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function sessionsDirFor(date: Date): string {
  const homeDir = process.env.USERPROFILE || process.env.HOME || "";
  return join(
    homeDir,
    ".codex",
    "sessions",
    String(date.getFullYear()),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  );
}

export function extractSessionUuid(rolloutPath: string): string | null {
  const match = rolloutPath.match(ROLLOUT_FILENAME_UUID_RE);
  return match ? match[1] : null;
}

// Candidate day-folders to scan for a rollout spawned around `spawnDate`: today,
// the spawn day, and the day before the spawn day. Codex names the file from the
// local time at run start, so a slow startup can leave it one folder back, and a
// midnight rollover during the spawn window is likewise covered.
function candidateDirs(spawnDate: Date, today: Date): Set<string> {
  const dirs = new Set<string>([sessionsDirFor(today), sessionsDirFor(spawnDate)]);
  const previous = new Date(spawnDate.getTime() - 24 * 60 * 60 * 1000);
  dirs.add(sessionsDirFor(previous));
  return dirs;
}

interface RolloutCandidate {
  path: string;
  mtimeMs: number;
}

export interface RolloutMetadata {
  cwd: string | null;
  /** Session creation time recorded by Codex's leading session_meta event. */
  startedAtMs: number | null;
}

// All rollout files across the candidate day-folders whose mtime is at or after
// `since`, sorted newest first.
async function listCandidates(
  since: number,
  spawnDate: Date,
  today: Date,
): Promise<RolloutCandidate[]> {
  const paths: string[] = [];
  for (const dir of candidateDirs(spawnDate, today)) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      paths.push(join(dir, name));
    }
  }
  const out: RolloutCandidate[] = [];
  for (const path of paths) {
    try {
      const stat = await fs.stat(path);
      if (stat.mtimeMs + 5 < since) continue; // 5ms slack for clock skew
      out.push({ path, mtimeMs: stat.mtimeMs });
    } catch {
      // vanished between readdir and stat — ignore
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Find the newest rollout-*.jsonl whose mtime is at or after `since`. This is
 * the original mtime-only heuristic used by the managed chat backend, which
 * spawns codex serially and can assume the newest file is its own.
 */
export async function discoverRolloutPath(since: number, spawnDate: Date): Promise<string | null> {
  const candidates = await listCandidates(since, spawnDate, new Date());
  return candidates.length > 0 ? candidates[0].path : null;
}

/**
 * Snapshot the rollout files that already exist immediately before Codara
 * spawns a fresh Codex manager. A currently-open personal Codex session keeps
 * changing its mtime, so mtime alone can never prove that a file belongs to
 * the process we just launched. Excluding this snapshot gives fresh sessions
 * an important ownership boundary: only a newly-created rollout may attach.
 */
export async function snapshotRolloutPaths(spawnDate: Date): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const dir of candidateDirs(spawnDate, new Date())) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      paths.add(join(dir, name));
    }
  }
  return paths;
}

function extractCwd(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const rec = entry as Record<string, unknown>;
  if (typeof rec.cwd === "string" && rec.cwd) return rec.cwd;
  const payload = rec.payload;
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (typeof p.cwd === "string" && p.cwd) return p.cwd;
  }
  return null;
}

function extractStartedAtMs(entry: unknown): number | null {
  if (!entry || typeof entry !== "object") return null;
  const rec = entry as Record<string, unknown>;
  const payload =
    rec.payload && typeof rec.payload === "object"
      ? (rec.payload as Record<string, unknown>)
      : null;
  // Modern Codex records the true thread creation time on payload.timestamp.
  // The outer event timestamp can be later (for example after startup work),
  // so use it only as a compatibility fallback for older rollout schemas.
  const raw =
    typeof payload?.timestamp === "string"
      ? payload.timestamp
      : typeof rec.timestamp === "string"
        ? rec.timestamp
        : null;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

// Read the cwd Codex recorded in a rollout's leading `session_meta` entry.
// Best-effort: the exact JSONL shape is version-dependent, so we scan the first
// chunk for a `cwd` string at any of the shapes Codex has used. Reads only the
// head of the file (session_meta is the first line) to stay cheap on long
// transcripts. Returns null when no cwd can be found.
export async function readRolloutMetadata(path: string): Promise<RolloutMetadata> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path, "r");
    const buf = Buffer.alloc(16384);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    let cwd: string | null = null;
    let startedAtMs: number | null = null;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue; // truncated tail line in the fixed-size read — skip
      }
      cwd ??= extractCwd(entry);
      startedAtMs ??= extractStartedAtMs(entry);
      if (cwd && startedAtMs != null) break;
    }
    return { cwd, startedAtMs };
  } catch {
    return { cwd: null, startedAtMs: null };
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

// Read only the cwd for existing callers (manual-terminal capture). Keeping
// this wrapper avoids making those call sites care about rollout timestamps.
export async function readRolloutCwd(path: string): Promise<string | null> {
  return (await readRolloutMetadata(path)).cwd;
}

// Compare paths case-insensitively with separators unified so a Windows
// drive-letter/backslash mismatch doesn't cause a false miss.
function normalizePath(p: string): string {
  return p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Like discoverRolloutPath, but prefers a rollout whose recorded cwd matches
 * `cwd`. Used by the manual-terminal capture path, where several Codex windows
 * could be writing rollouts concurrently and the newest-by-mtime file might
 * belong to a different pane. By default falls back to the newest candidate
 * when no file's cwd can be matched (unknown/older schema), so it never does
 * worse than the mtime heuristic. `strict: true` returns null instead — for
 * callers that retry (the agentSession:capture poll loop), where "no cwd match
 * yet" usually means the session_meta line hasn't flushed and binding the
 * newest unmatched file would capture some OTHER pane's conversation.
 */
export async function discoverRolloutForCwd(
  since: number,
  spawnDate: Date,
  cwd: string,
  opts?: {
    strict?: boolean;
    /** Files present before a fresh spawn can never belong to that spawn. */
    excludePaths?: ReadonlySet<string>;
    /** Require Codex's recorded session creation time to be this recent. */
    createdAfter?: number;
    /** Resume flows can bind safely by the exact persisted session UUID. */
    sessionUuid?: string;
  },
): Promise<string | null> {
  const candidates = await listCandidates(since, spawnDate, new Date());
  if (candidates.length === 0) return null;
  const target = normalizePath(cwd);
  let fallback: string | null = null;
  for (const candidate of candidates) {
    if (opts?.excludePaths?.has(candidate.path)) continue;
    if (
      opts?.sessionUuid &&
      extractSessionUuid(candidate.path)?.toLowerCase() !== opts.sessionUuid.toLowerCase()
    ) {
      continue;
    }
    const metadata = await readRolloutMetadata(candidate.path);
    if (opts?.createdAfter != null) {
      // Small slack covers timestamp serialization and filesystem clock
      // granularity without admitting a pre-existing interactive session.
      if (metadata.startedAtMs == null || metadata.startedAtMs + 2_000 < opts.createdAfter) {
        continue;
      }
    }
    fallback ??= candidate.path;
    if (metadata.cwd && normalizePath(metadata.cwd) === target) return candidate.path;
  }
  return opts?.strict ? null : fallback;
}
