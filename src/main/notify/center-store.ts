import { app } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
  NotificationCenterEntry,
  NotificationCenterSummary,
  NotifyEvent,
} from "@shared/types";
import { writeFileAtomic } from "../fs-atomic";
import { getPreferenceCached } from "../preferences-store";
import { sparkHome } from "../spark-home";
import { activeWindow } from "./deliver";

// Notification-center history: a newest-first ring buffer of every recorded
// NotifyEvent (delivered, watching-suppressed, or DND-muted), persisted to
// sparkHome()/notifications.json with debounced atomic writes. The renderer
// bell reads it via notify:* IPC and tracks unread through the
// "notify:center-updated" summary push. The macOS dock badge mirrors the
// unread count (the old per-alert unseen counter cleared on focus; the badge
// now clears when notifications are read instead).

const CENTER_FILE = "notifications.json";
const CAP = 200;
const WRITE_DEBOUNCE_MS = 500;

let entries: NotificationCenterEntry[] | null = null;
let loadPromise: Promise<NotificationCenterEntry[]> | null = null;
let persistTimer: NodeJS.Timeout | null = null;
let writing: Promise<void> = Promise.resolve();

function centerPath(): string {
  return join(sparkHome(), CENTER_FILE);
}

function sanitizeEntry(raw: unknown): NotificationCenterEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as NotificationCenterEntry;
  if (typeof e.id !== "string" || typeof e.kind !== "string") return null;
  if (!e.target || typeof e.target !== "object") return null;
  return { ...e, read: e.read === true };
}

async function ensureLoaded(): Promise<NotificationCenterEntry[]> {
  if (entries) return entries;
  loadPromise ??= (async () => {
    try {
      const raw = await fs.readFile(centerPath(), "utf8");
      const parsed: unknown = JSON.parse(raw);
      entries = Array.isArray(parsed)
        ? parsed.map(sanitizeEntry).filter((e): e is NotificationCenterEntry => e !== null).slice(0, CAP)
        : [];
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[notify] center history read failed, starting empty:", err);
      }
      entries = [];
    }
    return entries;
  })();
  return loadPromise;
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const snapshot = entries ? JSON.stringify(entries, null, 2) : null;
    if (snapshot === null) return;
    writing = writing
      .then(() => writeFileAtomic(centerPath(), snapshot))
      .catch((err) => {
        console.warn("[notify] center history write failed:", err);
      });
  }, WRITE_DEBOUNCE_MS);
  persistTimer.unref();
}

// Drain the debounced write on quit so the last notifications survive.
export async function flushNotificationCenter(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
    if (entries) {
      const snapshot = JSON.stringify(entries, null, 2);
      writing = writing
        .then(() => writeFileAtomic(centerPath(), snapshot))
        .catch((err) => {
          console.warn("[notify] center history write failed:", err);
        });
    }
  }
  await writing;
}

function unreadCount(): number {
  return entries ? entries.reduce((n, e) => n + (e.read ? 0 : 1), 0) : 0;
}

// Push the {unread} summary to the renderer bell and mirror it on the macOS
// dock badge (gated by the osCues channel preference).
function pushSummary(): void {
  const summary: NotificationCenterSummary = { unread: unreadCount() };
  try {
    activeWindow()?.webContents.send("notify:center-updated", summary);
  } catch {
    /* best-effort */
  }
  if (process.platform === "darwin") {
    try {
      const osCues = getPreferenceCached("notificationChannels").osCues;
      app.setBadgeCount(osCues ? summary.unread : 0);
    } catch {
      /* badge is best-effort */
    }
  }
}

export async function recordToCenter(
  event: NotifyEvent,
  opts: { read: boolean; suppressed?: string },
): Promise<void> {
  const list = await ensureLoaded();
  list.unshift({ ...event, read: opts.read, suppressed: opts.suppressed });
  if (list.length > CAP) list.length = CAP;
  schedulePersist();
  pushSummary();
}

export async function listCenterEntries(): Promise<NotificationCenterEntry[]> {
  return [...(await ensureLoaded())];
}

export async function markCenterRead(id: string): Promise<void> {
  const list = await ensureLoaded();
  const entry = list.find((e) => e.id === id);
  if (!entry || entry.read) return;
  entry.read = true;
  schedulePersist();
  pushSummary();
}

export async function markCenterAllRead(): Promise<void> {
  const list = await ensureLoaded();
  let changed = false;
  for (const entry of list) {
    if (!entry.read) {
      entry.read = true;
      changed = true;
    }
  }
  if (!changed) return;
  schedulePersist();
  pushSummary();
}

export async function clearCenter(): Promise<void> {
  const list = await ensureLoaded();
  if (list.length === 0) return;
  list.length = 0;
  schedulePersist();
  pushSummary();
}
