import { app, BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
  NotificationCenterEntry,
  NotificationCenterSummary,
  NotificationMute,
  NotificationViewSnapshot,
  NotifyEvent,
} from "@shared/types";
import { activeMutes, mutedBy, type MuteEvent } from "@shared/notify-center";
import { writeFileAtomic } from "../fs-atomic";
import { getPreferenceCached } from "../preferences-store";
import { codaraHome } from "../codara-home";
import {
  clearExceptOpen,
  coalesceEntries,
  evictToCap,
  insertEntry,
  markViewed,
  pruneByAge,
  removeIds,
  removeWorkspaces,
  restoreEntries,
  sanitizeEntries,
  sanitizeMutes,
  setRead,
  settleIds,
  settleMissingWorkspaces,
  settleSource,
  settleTerminalQuestions,
  summarize,
} from "./center-model";

// Notification-center history: a newest-first list of recorded NotifyEvents
// (delivered, watching-suppressed, DND-muted or source-muted), persisted to
// codaraHome()/notifications.json with debounced atomic writes. The list
// operations themselves are pure (center-model.ts); this module owns the
// state, the per-source mutes (notification-mutes.json), persistence and the
// "notify:center-updated" summary push. The bell badge and the macOS dock
// badge both show the summary's needsYou count.

const CENTER_FILE = "notifications.json";
const MUTES_FILE = "notification-mutes.json";
const WRITE_DEBOUNCE_MS = 500;
const MAX_MUTE_MS = 7 * 24 * 60 * 60_000;

let entries: NotificationCenterEntry[] = [];
let mutes: NotificationMute[] = [];
let loadPromise: Promise<void> | null = null;
// Every read and mutation runs on this chain, after the initial load, so an
// alert raised while the file is still being read lands in the loaded list
// instead of being overwritten by it, and a quit-time flush can wait for all
// of them.
let chain: Promise<unknown> = Promise.resolve();
let persistTimer: NodeJS.Timeout | null = null;
let dirtyEntries = false;
let dirtyMutes = false;
let writing: Promise<void> = Promise.resolve();
let version = 0;
let knownWorkspaceIds: Set<string> | null = null;

function centerPath(): string {
  return join(codaraHome(), CENTER_FILE);
}

function mutesPath(): string {
  return join(codaraHome(), MUTES_FILE);
}

async function readJson(path: string, label: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[notify] ${label} read failed:`, err);
    }
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // The next write would replace the file, so keep the unreadable copy
    // beside it instead of discarding the user's history silently.
    const backup = `${path}.corrupt-${Date.now()}`;
    console.warn(`[notify] ${label} is not valid JSON, keeping it as ${backup}:`, err);
    await fs.rename(path, backup).catch(() => undefined);
    return null;
  }
}

function load(): Promise<void> {
  loadPromise ??= (async () => {
    const now = Date.now();
    const [rawEntries, rawMutes] = await Promise.all([
      readJson(centerPath(), "center history"),
      readJson(mutesPath(), "center mutes"),
    ]);
    entries = sanitizeEntries(rawEntries);
    const coalesced = coalesceEntries(entries);
    const pruned = pruneByAge(entries, now);
    const settled = settleTerminalQuestions(entries);
    if (evictToCap(entries) || coalesced || pruned || settled) dirtyEntries = true;
    mutes = sanitizeMutes(rawMutes, now);
  })();
  return loadPromise;
}

function enqueue<T>(fn: () => T): Promise<T> {
  const run = chain.then(async () => {
    await load();
    return fn();
  });
  chain = run.catch((err) => {
    console.warn("[notify] center operation failed:", err);
  });
  return run;
}

function commit(changed: { entries?: boolean; mutes?: boolean }): void {
  if (!changed.entries && !changed.mutes) return;
  if (changed.entries) dirtyEntries = true;
  if (changed.mutes) dirtyMutes = true;
  version += 1;
  schedulePersist();
  pushSummary();
}

function writeDirty(): void {
  if (dirtyEntries) {
    dirtyEntries = false;
    const snapshot = JSON.stringify(entries);
    writing = writing.then(() => writeFileAtomic(centerPath(), snapshot)).catch((err) => {
      console.warn("[notify] center history write failed:", err);
    });
  }
  if (dirtyMutes) {
    dirtyMutes = false;
    const snapshot = JSON.stringify(mutes);
    writing = writing.then(() => writeFileAtomic(mutesPath(), snapshot)).catch((err) => {
      console.warn("[notify] center mutes write failed:", err);
    });
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeDirty();
  }, WRITE_DEBOUNCE_MS);
  persistTimer.unref();
}

// Drain pending operations and the debounced write on quit so the last
// notifications survive, including one recorded before the initial load
// finished.
export async function flushNotificationCenter(): Promise<void> {
  await chain;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  writeDirty();
  await writing;
}

export function centerSummarySync(): NotificationCenterSummary {
  return { ...summarize(entries, mutes, Date.now()), version };
}

// Every window shows a bell, so every window gets the summary.
function pushSummary(): void {
  const summary = centerSummarySync();
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send("notify:center-updated", summary);
    } catch {
      /* best-effort */
    }
  }
  if (process.platform === "darwin") {
    try {
      const osCues = getPreferenceCached("notificationChannels").osCues;
      app.setBadgeCount(osCues ? summary.needsYou : 0);
    } catch {
      /* badge is best-effort */
    }
  }
}

// Read the history early so mutes apply to the first alerts after launch.
export function loadNotificationCenter(): Promise<void> {
  return enqueue(() => undefined);
}

// Synchronous so publish() can consult it before deciding delivery. Until the
// mutes file is read this reports nothing muted.
export function isEventMuted(event: MuteEvent): boolean {
  return mutedBy(event, mutes, Date.now()) !== null;
}

export function recordToCenter(
  event: NotifyEvent,
  opts: { read: boolean; suppressed?: string },
): Promise<void> {
  return enqueue(() => {
    const now = Date.now();
    pruneByAge(entries, now);
    insertEntry(entries, event, opts, now);
    commit({ entries: true });
  });
}

export function listCenterEntries(): Promise<NotificationCenterEntry[]> {
  return enqueue(() => entries.map((entry) => ({ ...entry })));
}

export function centerSummary(): Promise<NotificationCenterSummary> {
  return enqueue(() => centerSummarySync());
}

export function markCenterRead(id: string): Promise<void> {
  return setCenterRead([id], true);
}

export function setCenterRead(ids: readonly string[], read: boolean): Promise<void> {
  return enqueue(() => commit({ entries: setRead(entries, ids, read) }));
}

export function markCenterAllRead(): Promise<void> {
  return enqueue(() =>
    commit({ entries: setRead(entries, entries.map((entry) => entry.id), true) }),
  );
}

export function markCenterViewed(view: NotificationViewSnapshot): Promise<void> {
  return enqueue(() => commit({ entries: markViewed(entries, view) }));
}

export function settleCenterSource(sourceKey: string): Promise<void> {
  return enqueue(() => commit({ entries: settleSource(entries, sourceKey) }));
}

// The renderer found these questions' panes or runs gone. Main has no view
// of panes, so without this a question whose pane closed outside the normal
// disposal path would keep the dock badge up for good.
export function settleCenterEntries(ids: readonly string[]): Promise<void> {
  return enqueue(() => commit({ entries: settleIds(entries, ids) }));
}

export function removeCenterEntry(id: string): Promise<void> {
  return removeCenterEntries([id]);
}

export function removeCenterEntries(ids: readonly string[]): Promise<void> {
  return enqueue(() => commit({ entries: removeIds(entries, ids) }));
}

export function clearCenter(): Promise<void> {
  return enqueue(() => commit({ entries: clearExceptOpen(entries) }));
}

export function restoreCenterEntries(raw: unknown): Promise<void> {
  return enqueue(() => commit({ entries: restoreEntries(entries, raw) }));
}

export function muteCenterSource(key: string, label: string, durationMs: number): Promise<void> {
  return enqueue(() => {
    const now = Date.now();
    const until = now + Math.min(Math.max(durationMs, 60_000), MAX_MUTE_MS);
    mutes = [...activeMutes(mutes, now).filter((mute) => mute.key !== key), { key, label, until }];
    commit({ mutes: true });
  });
}

export function unmuteCenterSource(key: string): Promise<void> {
  return enqueue(() => {
    const before = mutes.length;
    mutes = mutes.filter((mute) => mute.key !== key);
    commit({ mutes: mutes.length !== before });
  });
}

// Called with the full workspace set whenever app state is saved. Only ids
// that were present before and are gone now count as deletions: a first save,
// or a transiently empty set, must never wipe the history. The first save
// only settles questions from workspaces deleted in an earlier session, so
// they stop counting toward the badge; their rows stay, marked gone.
export function noteCenterWorkspaces(workspaceIds: readonly string[]): Promise<void> {
  const next = new Set(workspaceIds);
  const previous = knownWorkspaceIds;
  if (next.size === 0) return Promise.resolve();
  knownWorkspaceIds = next;
  if (!previous) return enqueue(() => commit({ entries: settleMissingWorkspaces(entries, next) }));
  const removed = new Set([...previous].filter((id) => !next.has(id)));
  if (removed.size === 0) return Promise.resolve();
  return enqueue(() => commit({ entries: removeWorkspaces(entries, removed) }));
}
