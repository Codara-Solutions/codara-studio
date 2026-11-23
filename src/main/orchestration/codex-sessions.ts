// Shared Codex rollout/session discovery.
//
// Codex writes one JSONL "rollout" per session at
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// organized by DATE, not by cwd — so a session's working directory is only
// recoverable by reading the file's leading `session_meta` entry, not from the
// path. These primitives let the manual-terminal session-restore feature find
// and identify a rollout after spawning `codex`.

import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import {
  resolveCodexHomeDir,
  resolveCodexHomePaths,
  resolveCodexSessionDirectoryPath,
  resolveCodexTranscriptPath,
} from "./codex-home";

// Codex 0.157+ continues a long conversation in segment files named
// `rollout-<ts>-<session>_<segment>.jsonl`; the session id is the first UUID.
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const ROLLOUT_FILENAME_UUID_RE = new RegExp(
  `rollout-.*?-(${UUID_PATTERN})(?:_${UUID_PATTERN})?\\.jsonl$`,
  "i",
);

// Interactive terminal sessions only: exec runs, subagents, and the desktop,
// browser and IDE clients are someone else's conversation. Codex 0.157+ can
// record a terminal session as `source: "vscode"` (its app-server transport);
// the originator still names the terminal UI.
export function isInteractiveCodexSource(source: unknown, originator: unknown): boolean {
  return source === "cli" || (source === "vscode" && originator === "codex-tui");
}

export function codexHomeDir(explicitHome?: string | null): string {
  return resolveCodexHomeDir(explicitHome);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function sessionsDirFor(date: Date, explicitHome?: string | null): string {
  return join(
    codexHomeDir(explicitHome),
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
function candidateDirs(
  spawnDate: Date,
  today: Date,
  explicitHome?: string | null,
): Set<string> {
  const dirs = new Set<string>([
    sessionsDirFor(today, explicitHome),
    sessionsDirFor(spawnDate, explicitHome),
  ]);
  const previous = new Date(spawnDate.getTime() - 24 * 60 * 60 * 1000);
  dirs.add(sessionsDirFor(previous, explicitHome));
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
  explicitHome?: string | null,
): Promise<RolloutCandidate[]> {
  resolveCodexHomePaths(explicitHome);
  const paths: string[] = [];
  for (const dir of candidateDirs(spawnDate, today, explicitHome)) {
    const safeDir = resolveCodexSessionDirectoryPath(dir, explicitHome);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(safeDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith("rollout-") ||
        !entry.name.endsWith(".jsonl")
      ) {
        continue;
      }
      const candidate = join(safeDir, entry.name);
      resolveCodexTranscriptPath(candidate, explicitHome, {
        requireExisting: true,
      });
      paths.push(candidate);
    }
  }
  const out: RolloutCandidate[] = [];
  for (const path of paths) {
    try {
      const stat = await fs.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (stat.mtimeMs + 5 < since) continue; // 5ms slack for clock skew
      out.push({ path, mtimeMs: stat.mtimeMs });
    } catch {
      // vanished between readdir and stat — ignore
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
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

// The header contains the CLI's full instructions and can exceed a single
// read buffer. Stop at its newline so long conversations stay cheap to inspect.
export async function readRolloutHeader(handle: Awaited<ReturnType<typeof fs.open>>): Promise<unknown> {
  const chunks: Buffer[] = [];
  const limit = 8 * 1024 * 1024;
  let position = 0;
  while (position < limit) {
    const buffer = Buffer.alloc(Math.min(16_384, limit - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    const newline = buffer.subarray(0, bytesRead).indexOf(10);
    chunks.push(buffer.subarray(0, newline < 0 ? bytesRead : newline));
    position += bytesRead;
    if (newline >= 0 || bytesRead === 0) {
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
    }
  }
  return null;
}

// Read only the leading metadata record, including older cwd/timestamp shapes.
export async function readRolloutMetadata(
  path: string,
  explicitHome?: string | null,
): Promise<RolloutMetadata> {
  const safePath = resolveCodexTranscriptPath(path, explicitHome);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(safePath, "r");
    const entry = await readRolloutHeader(handle);
    return { cwd: extractCwd(entry), startedAtMs: extractStartedAtMs(entry) };
  } catch {
    return { cwd: null, startedAtMs: null };
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
// A session that ran at quit wrote its newest segment recently, so only this
// many of the newest day folders are read unless a hint names an older one.
const RECENT_DAY_FOLDERS = 31;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY_FOLDER_RE = /[\\/]sessions[\\/](\d{4})[\\/](\d{2})[\\/](\d{2})[\\/][^\\/]+$/;

/** When a UUIDv7 was minted (its first 48 bits), else null. */
export function uuidV7TimeMs(id: string): number | null {
  if (!UUID_V7_RE.test(id)) return null;
  const ms = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function dayFolder(date: Date): string {
  return join(String(date.getFullYear()), pad2(date.getMonth() + 1), pad2(date.getDate()));
}

async function newestDayFolders(sessionsRoot: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  const children = async (dir: string, pattern: RegExp): Promise<string[]> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
    return entries
      .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  };
  for (const year of await children(sessionsRoot, /^\d{4}$/)) {
    for (const month of await children(join(sessionsRoot, year), /^\d{2}$/)) {
      for (const day of await children(join(sessionsRoot, year, month), /^\d{2}$/)) {
        out.push(join(year, month, day));
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

export interface LocatedCodexRollout {
  /** The session's newest file: the one Codex writes now. */
  path: string;
  /**
   * The largest of the session's files. A fresh continuation segment can be
   * tiny while the conversation lives in an older one, so this, not the
   * newest file's size, says whether there is anything to resume.
   */
  largestSize: number;
}

// Rollouts below this hold no conversation (a stillborn session's header).
export const CODEX_RESUMABLE_MIN_BYTES = 1_024;

async function statRollout(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  const stat = await fs.lstat(path).catch(() => null);
  return stat && stat.isFile() && !stat.isSymbolicLink() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null;
}

/**
 * Find a Codex session's rollout in the selected home: the stored path when
 * it still validates there and holds a conversation, else the newest file
 * named for the session id
 * (plain or `_<segment>`) in the day folders its id, the stored path and the
 * hint times name, plus the newest RECENT_DAY_FOLDERS folders. Day and file
 * symlinks are skipped, and every hit passes resolveCodexTranscriptPath.
 * Null means the session has no file in this home; a home that cannot be
 * resolved throws, so the caller can tell an error from a missing session.
 */
export async function locateCodexRollout(input: {
  sessionId: string;
  transcriptPath?: string | null;
  codexHome?: string | null;
  hintTimesMs?: readonly (number | null | undefined)[];
}): Promise<LocatedCodexRollout | null> {
  const { sessionsRoot } = resolveCodexHomePaths(input.codexHome);
  const id = input.sessionId.toLowerCase();
  const stored = input.transcriptPath;
  if (stored && extractSessionUuid(stored)?.toLowerCase() === id) {
    let path: string | null = null;
    try {
      path = resolveCodexTranscriptPath(stored, input.codexHome, { requireExisting: true });
    } catch {
      path = null;
    }
    const stat = path ? await statRollout(path) : null;
    if (path && stat && stat.size >= CODEX_RESUMABLE_MIN_BYTES) return { path, largestSize: stat.size };
  }
  const folders = new Set<string>();
  const storedDay = stored ? DAY_FOLDER_RE.exec(stored) : null;
  if (storedDay) folders.add(join(storedDay[1], storedDay[2], storedDay[3]));
  for (const ms of [uuidV7TimeMs(id), ...(input.hintTimesMs ?? [])]) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) continue;
    for (const offset of [-DAY_MS, 0, DAY_MS]) folders.add(dayFolder(new Date(ms + offset)));
  }
  for (const folder of await newestDayFolders(sessionsRoot, RECENT_DAY_FOLDERS)) folders.add(folder);
  let best: { path: string; mtimeMs: number } | null = null;
  let largestSize = 0;
  for (const folder of folders) {
    let dir: string;
    try {
      dir = resolveCodexSessionDirectoryPath(join(sessionsRoot, folder), input.codexHome);
    } catch {
      continue;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith("rollout-")) continue;
      if (extractSessionUuid(entry.name)?.toLowerCase() !== id) continue;
      const candidate = join(dir, entry.name);
      try {
        resolveCodexTranscriptPath(candidate, input.codexHome, { requireExisting: true });
      } catch {
        continue;
      }
      const stat = await statRollout(candidate);
      if (!stat) continue;
      largestSize = Math.max(largestSize, stat.size);
      if (!best || stat.mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs: stat.mtimeMs };
    }
  }
  return best ? { path: best.path, largestSize } : null;
}

// Compare paths case-insensitively with separators unified so a Windows
// drive-letter/backslash mismatch doesn't cause a false miss.
function normalizePath(p: string): string {
  return p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Find the newest rollout-*.jsonl whose mtime is at or after `since`,
 * preferring one whose recorded cwd matches `cwd`. Used by the manual-terminal
 * capture path, where several Codex windows
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
    /** Lowercased session UUIDs already bound to other panes — never rebind. */
    excludeSessionIds?: ReadonlySet<string>;
    /** Exact resolved Codex home selected for this session. */
    codexHome?: string;
  },
): Promise<string | null> {
  const candidates = await listCandidates(
    since,
    spawnDate,
    new Date(),
    opts?.codexHome,
  );
  if (candidates.length === 0) return null;
  const target = normalizePath(cwd);
  let fallback: string | null = null;
  for (const candidate of candidates) {
    if (opts?.excludePaths?.has(candidate.path)) continue;
    if (opts?.excludeSessionIds?.size) {
      const uuid = extractSessionUuid(candidate.path)?.toLowerCase();
      if (uuid && opts.excludeSessionIds.has(uuid)) continue;
    }
    if (
      opts?.sessionUuid &&
      extractSessionUuid(candidate.path)?.toLowerCase() !== opts.sessionUuid.toLowerCase()
    ) {
      continue;
    }
    const metadata = await readRolloutMetadata(candidate.path, opts?.codexHome);
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
