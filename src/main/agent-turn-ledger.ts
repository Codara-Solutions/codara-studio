import * as fs from "node:fs";
import * as path from "node:path";

/**
 * When an agent last worked in a folder, for the worktree idle clock: one
 * time per workspace and folder, kept after its pane closes and, through
 * the file persistAgentTurns names, across restarts. Every answer leans
 * towards "worked recently": a time dropped to make room, or a saved file
 * that could not be read, raises the floor every answer is at least.
 */
export const AGENT_TURNS_MAX = 2000;
// Longer than the longest idle span anyone asks about (365 days), so an
// entry that ages out never changes an answer.
export const AGENT_TURNS_MAX_AGE_MS = 400 * 24 * 60 * 60_000;
// A stamp inside a turn is written at most this often; a turn's start and
// end are written at once.
export const AGENT_TURNS_SAVE_EVERY_MS = 60_000;

type Entry = { at: number; workspaceId: string; cwd: string | null };

const entries = new Map<string, Entry>();
let floor = 0;
let file: string | null = null;
let savedAt = 0;
let unsaved = false;

/**
 * An agent of `workspaceId` worked at `at` in each of `cwds` (none known:
 * the workspace alone). `edge` (a turn's start or end) is written now.
 */
export function noteAgentTurn(workspaceId: string, cwds: readonly string[], at: number, edge: boolean): void {
  for (const cwd of cwds.length ? cwds : [null]) {
    const key = `${workspaceId}\u0000${cwd ?? ""}`;
    const before = entries.get(key);
    if (before && before.at >= at) continue;
    entries.set(key, { at, workspaceId, cwd });
    unsaved = true;
  }
  if (!unsaved) return;
  trim(at);
  if (edge || at - savedAt >= AGENT_TURNS_SAVE_EVERY_MS) save(at);
}

function trim(now: number): void {
  for (const [key, entry] of entries) if (now - entry.at > AGENT_TURNS_MAX_AGE_MS) entries.delete(key);
  if (entries.size <= AGENT_TURNS_MAX) return;
  // The oldest go first, and the newest of them becomes the floor: the
  // folder it named may have worked as late as that.
  const oldest = [...entries].sort((a, b) => a[1].at - b[1].at).slice(0, entries.size - AGENT_TURNS_MAX);
  for (const [key, entry] of oldest) {
    entries.delete(key);
    floor = Math.max(floor, entry.at);
  }
}

function save(now: number): void {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, floor, entries: [...entries.values()] }), { mode: 0o600 });
    fs.renameSync(temp, file);
    savedAt = now;
    unsaved = false;
  } catch (err) {
    console.warn("[agent-turn-ledger] could not save the agent turn times:", err);
  }
}

/**
 * Keeps the times in `target` across restarts: reads what is there now
 * (newer times win) and writes each turn's start and end as they happen. A
 * file that is there but cannot be read raises the floor to when it was
 * last written.
 */
export function persistAgentTurns(target: string, now = Date.now()): void {
  file = target;
  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") lost(target, now);
    return;
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const saved = parsed && typeof parsed === "object" ? (parsed as { floor?: unknown; entries?: unknown }) : null;
  if (!saved || !Array.isArray(saved.entries)) return lost(target, now);
  const savedFloor = Number(saved.floor);
  if (Number.isFinite(savedFloor) && savedFloor > 0) floor = Math.max(floor, Math.min(savedFloor, now));
  for (const item of saved.entries) {
    const entry = item as Partial<Entry> | null;
    const at = Number(entry?.at);
    if (!entry || !Number.isFinite(at) || at <= 0 || typeof entry.workspaceId !== "string") continue;
    const cwd = typeof entry.cwd === "string" && entry.cwd ? entry.cwd : null;
    const key = `${entry.workspaceId}\u0000${cwd ?? ""}`;
    const current = entries.get(key);
    if (!current || current.at < at) entries.set(key, { at: Math.min(at, now), workspaceId: entry.workspaceId, cwd });
  }
  trim(now);
}

function lost(target: string, now: number): void {
  let at = now;
  try {
    at = Math.min(now, fs.statSync(target).mtimeMs);
  } catch {
    // Unreadable to stat too: as late as now.
  }
  floor = Math.max(floor, at);
  console.warn("[agent-turn-ledger] the saved agent turn times could not be read; nothing reads idle before", new Date(at).toISOString());
}

/** Writes what a turn in progress stamped since the last write (at quit). */
export function flushAgentTurns(): void {
  if (unsaved) save(Date.now());
}

/**
 * When an agent `include` takes (by its workspace and the folder it worked
 * in, null when not known) last worked; never before the floor; null when
 * none did and there is no floor.
 */
export function lastAgentTurnAt(include: (workspaceId: string, cwd: string | null) => boolean): number | null {
  let latest = floor > 0 ? floor : null;
  for (const entry of entries.values()) {
    if ((latest === null || entry.at > latest) && include(entry.workspaceId, entry.cwd)) latest = entry.at;
  }
  return latest;
}

// Tests only: forget every time, the floor and the file.
export function __resetAgentTurnsForTests(): void {
  entries.clear();
  floor = 0;
  file = null;
  savedAt = 0;
  unsaved = false;
}
