// Agent-session registry — the EXACT session identity for every Claude that
// runs in a Codara pane, fed by the SessionStart hook (see hook-watcher.ts).
//
// Why this exists: the renderer's restore pointer was captured by filesystem
// discovery ("newest transcript CREATED in this cwd within 60s"), which is
// blind to every flow that appends to an OLD transcript or switches session
// mid-TUI: in-TUI `/resume` (picker), a hand-typed `claude --resume <id>` /
// `claude -c`, and `/clear` (new id, same process). Panes whose users relied
// on those flows kept a stale pointer forever — every boot then "resumed"
// a dead id, self-healed to a fresh session, and the user's real conversation
// silently fell out of restore. That was the "resume works for some sessions,
// not all" bug. Claude Code's SessionStart hook fires with the real session id
// on startup / resume / clear alike, and every Codara pty carries SPARK_PANE_ID,
// so this registry can bind pane → newest session with zero guessing.
//
// Kept dependency-injected (no electron / spark-home imports) so
// scripts/test-session-registry.cjs can bundle and exercise it in plain node.
// index.ts wires the real sparkHome dir, logMain, and the renderer broadcast.

import { promises as fs } from "node:fs";
import { join } from "node:path";

export interface SessionStartRecord {
  paneId: string;
  // Hooks are Claude-only today; Codex keeps the discovery heuristic.
  runtime: "claude";
  sessionId: string;
  transcriptPath?: string;
  cwd?: string;
  // SessionStart's `source`: "startup" | "resume" | "clear" | "compact".
  source?: string;
  // ISO timestamp from the hook envelope (write time on the CLI side), so
  // backlog files replayed after a restart still order correctly.
  timestamp: string;
}

// Bounded so agent-session-starts.json can't grow with every pane id ever
// minted. Panes churn; 500 covers any realistic live set.
const MAX_ENTRIES = 500;
const PERSIST_DEBOUNCE_MS = 500;
const FILE_NAME = "agent-session-starts.json";
const FILE_VERSION = 1;

interface RegistryDeps {
  dir: string;
  log?: (line: string) => void;
  broadcast?: (rec: SessionStartRecord) => void;
}

let deps: RegistryDeps | null = null;
let entries = new Map<string, SessionStartRecord>();
let persistTimer: NodeJS.Timeout | null = null;
// Serialize writes so a slow disk can't interleave two JSON.stringify snapshots.
let writeChain: Promise<void> = Promise.resolve();

function parseTs(value: string | undefined): number {
  if (!value) return 0;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : 0;
}

function isValidRecord(rec: unknown): rec is SessionStartRecord {
  if (rec === null || typeof rec !== "object") return false;
  const r = rec as Record<string, unknown>;
  return (
    typeof r.paneId === "string" &&
    r.paneId.length > 0 &&
    typeof r.sessionId === "string" &&
    r.sessionId.length > 0 &&
    typeof r.timestamp === "string"
  );
}

/**
 * Pure newest-wins merge: apply `rec` to `map` iff it is newer than the
 * pane's existing record (or announces a different session at the same
 * millisecond — backlog rescans process files in arbitrary order). Returns
 * whether the map changed. Exported for the unit harness.
 */
export function applySessionStart(
  map: Map<string, SessionStartRecord>,
  rec: SessionStartRecord,
  maxEntries: number = MAX_ENTRIES,
): boolean {
  if (!isValidRecord(rec)) return false;
  const existing = map.get(rec.paneId);
  if (existing) {
    const incoming = parseTs(rec.timestamp);
    const current = parseTs(existing.timestamp);
    if (incoming < current) return false;
    if (incoming === current && rec.sessionId === existing.sessionId) return false;
  }
  map.set(rec.paneId, rec);
  // Prune oldest-by-timestamp beyond the cap so the persisted file stays small.
  while (map.size > maxEntries) {
    let oldestKey: string | null = null;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [key, value] of map) {
      const ts = parseTs(value.timestamp);
      if (ts < oldestTs) {
        oldestTs = ts;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    map.delete(oldestKey);
  }
  return true;
}

function filePath(): string | null {
  return deps ? join(deps.dir, FILE_NAME) : null;
}

/** Returns whether the persisted file existed (drives the one-time backfill). */
async function loadFromDisk(): Promise<boolean> {
  const path = filePath();
  if (!path) return false;
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    return false; // first run / wiped home — start empty
  }
  try {
    const parsed = JSON.parse(raw) as { version?: number; entries?: unknown };
    if (!Array.isArray(parsed.entries)) return true;
    for (const rec of parsed.entries) {
      if (isValidRecord(rec)) applySessionStart(entries, rec);
    }
  } catch (err) {
    // Corrupt file: start empty rather than crash — the hook backlog and live
    // sessions repopulate it.
    deps?.log?.(`session-start registry unreadable, starting empty: ${(err as Error).message}`);
  }
  return true;
}

const BACKFILL_BATCH = 64;

/**
 * One-time seed for installs that predate the registry: SessionStart events
 * already routed to run-store sit in <dir>/hooks/processed/ (7-day retention,
 * see hook-watcher.ts). Replaying them means the FIRST boot with the registry
 * heals every stale pointer immediately — without this, a pane whose user
 * `/resume`d away from its pointer would stay broken for one more full
 * quit → relaunch cycle before the live events caught it up.
 */
async function backfillFromProcessedHooks(): Promise<void> {
  if (!deps) return;
  const processedDir = join(deps.dir, "hooks", "processed");
  let names: string[];
  try {
    names = await fs.readdir(processedDir);
  } catch {
    return; // no processed hooks yet — nothing to seed
  }
  let applied = 0;
  for (let i = 0; i < names.length; i += BACKFILL_BATCH) {
    await Promise.all(
      names.slice(i, i + BACKFILL_BATCH).map(async (name) => {
        if (!name.endsWith(".json")) return;
        try {
          const raw = await fs.readFile(join(processedDir, name), "utf8");
          // Cheap pre-filter: the vast majority of processed hooks are
          // PreToolUse/PostToolUse — skip the JSON.parse for those. Same
          // event set as the live ingest in hook-watcher.ts.
          if (
            !raw.includes('"SessionStart"') &&
            !raw.includes('"UserPromptSubmit"') &&
            !raw.includes('"Stop"')
          ) {
            return;
          }
          const parsed = JSON.parse(raw) as {
            hookName?: unknown;
            paneId?: unknown;
            timestamp?: unknown;
            payload?: Record<string, unknown> | null;
          };
          if (
            parsed.hookName !== "SessionStart" &&
            parsed.hookName !== "UserPromptSubmit" &&
            parsed.hookName !== "Stop"
          ) {
            return;
          }
          if (typeof parsed.paneId !== "string" || !parsed.paneId) return;
          const payload = parsed.payload;
          const sessionId =
            payload && typeof payload.session_id === "string" ? payload.session_id : undefined;
          if (!sessionId) return;
          const str = (key: string): string | undefined =>
            payload && typeof payload[key] === "string" ? (payload[key] as string) : undefined;
          const rec: SessionStartRecord = {
            paneId: parsed.paneId,
            runtime: "claude",
            sessionId,
            transcriptPath: str("transcript_path"),
            cwd: str("cwd"),
            source:
              parsed.hookName === "SessionStart"
                ? str("source")
                : parsed.hookName === "Stop"
                  ? "stop"
                  : "prompt",
            timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
          };
          if (applySessionStart(entries, rec)) applied += 1;
        } catch {
          /* corrupt / vanished file — skip */
        }
      }),
    );
  }
  deps.log?.(`registry backfilled ${applied} SessionStart record(s) from processed hooks`);
  // Persist immediately (still debounced) so the backfill runs exactly once —
  // the file's existence is the "already seeded" marker.
  schedulePersist();
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const path = filePath();
    if (!path) return;
    const payload = JSON.stringify({
      version: FILE_VERSION,
      entries: [...entries.values()],
    });
    writeChain = writeChain
      .then(async () => {
        const tmp = `${path}.tmp`;
        await fs.writeFile(tmp, payload, "utf8");
        await fs.rename(tmp, path);
      })
      .catch(() => undefined); // best-effort; repopulated from hooks next boot
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
}

/**
 * Wire the registry to its home dir + sinks and load the persisted map.
 * Called once from index.ts BEFORE startHookWatcher so the boot backlog
 * replay merges against (not clobbers) the previous run's records. On the
 * very first init (no persisted file yet) the processed-hooks history is
 * replayed so pointers that went stale before the registry existed heal on
 * this boot, not the one after.
 */
export async function initAgentSessionRegistry(opts: RegistryDeps): Promise<void> {
  deps = opts;
  const hadFile = await loadFromDisk();
  if (!hadFile) await backfillFromProcessedHooks();
}

/**
 * Ingest one session-identity hook event (SessionStart / UserPromptSubmit /
 * Stop). Newest-per-pane wins; every accepted event is persisted (debounced)
 * so the freshest timestamp survives a quit, but the log line and renderer
 * broadcast fire only when the pane's session IDENTITY changes — prompt/stop
 * events re-announce the same id every turn and would otherwise be pure noise.
 */
export function recordSessionStart(rec: SessionStartRecord): void {
  const previousId = entries.get(rec.paneId)?.sessionId;
  if (!applySessionStart(entries, rec)) return;
  schedulePersist();
  if (previousId === rec.sessionId) return;
  deps?.log?.(
    `hook bind pane=${rec.paneId} id=${rec.sessionId} source=${rec.source ?? "-"}` +
      (previousId ? ` (was ${previousId})` : ""),
  );
  try {
    deps?.broadcast?.(rec);
  } catch {
    /* renderer gone mid-quit; the persisted map covers the next boot */
  }
}

/** Newest SessionStart seen for a pane (this run or persisted), or null. */
export function latestSessionStart(paneId: string): SessionStartRecord | null {
  return entries.get(paneId) ?? null;
}

// Test-only: reset module state between harness cases.
export function __resetAgentSessionRegistryForTest(): void {
  deps = null;
  entries = new Map();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}
