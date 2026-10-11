import type {
  NotificationCenterEntry,
  NotificationMute,
  NotificationViewSnapshot,
  NotifyEvent,
} from "@shared/types";
import { isNeedsYouKind, isTargetViewed, targetWorkspaceId } from "@shared/notify-center";

// Pure list operations behind the notification center (center-store.ts owns
// the state, persistence and pushes). No Electron or fs imports, so
// scripts/test-notify-center-model.cjs can bundle this file on its own.
// Every function mutates the newest-first list in place and reports whether
// anything changed, so the store persists and pushes only on real changes.

export const CENTER_CAP = 200;
// Repeats from one source fold into its existing row while that row is
// unread, or while it is this recent even if read. Past that, a read row is
// history and a new event starts a fresh one.
export const COLLAPSE_WINDOW_MS = 6 * 60 * 60_000;
export const READ_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const MAX_TITLE = 300;
const MAX_BODY = 2_000;

function timeOf(iso: string | undefined): number {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

export function entryCount(entry: NotificationCenterEntry): number {
  return typeof entry.count === "number" && entry.count > 1 ? Math.floor(entry.count) : 1;
}

// A persisted row is user-editable JSON written by any past build. Anything
// that would break rendering or sorting (no id, no target, an unparseable
// date) is dropped; text fields are coerced and bounded.
export function sanitizeEntry(raw: unknown): NotificationCenterEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Partial<NotificationCenterEntry>;
  if (typeof e.id !== "string" || !e.id) return null;
  if (typeof e.kind !== "string" || !e.kind) return null;
  if (!e.target || typeof e.target !== "object" || typeof e.target.type !== "string") return null;
  if (typeof e.createdAt !== "string" || !Number.isFinite(Date.parse(e.createdAt))) return null;
  const entry: NotificationCenterEntry = {
    ...(e as NotificationCenterEntry),
    sourceKey: typeof e.sourceKey === "string" ? e.sourceKey : `entry:${e.id}`,
    title: typeof e.title === "string" ? e.title.slice(0, MAX_TITLE) : "",
    body: typeof e.body === "string" ? e.body.slice(0, MAX_BODY) : "",
    read: e.read === true,
  };
  if (typeof e.count === "number" && Number.isFinite(e.count) && e.count > 1) {
    entry.count = Math.floor(e.count);
  } else {
    delete entry.count;
  }
  if (typeof e.firstAt !== "string" || !Number.isFinite(Date.parse(e.firstAt))) delete entry.firstAt;
  if (e.settled !== true) delete entry.settled;
  return entry;
}

export function sanitizeEntries(raw: unknown): NotificationCenterEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: NotificationCenterEntry[] = [];
  for (const item of raw) {
    const entry = sanitizeEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  out.sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
  return out;
}

export function sanitizeMutes(raw: unknown, now: number): NotificationMute[] {
  if (!Array.isArray(raw)) return [];
  const out: NotificationMute[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const m = item as Partial<NotificationMute>;
    if (typeof m.key !== "string" || !m.key) continue;
    if (typeof m.until !== "number" || !Number.isFinite(m.until) || m.until <= now) continue;
    out.push({ key: m.key, label: typeof m.label === "string" ? m.label.slice(0, 200) : m.key, until: m.until });
  }
  return out;
}

// The rows one source keeps folding into. A loom "Notify" step is the user's
// own message, so only identical messages fold.
function collapseKey(entry: Pick<NotifyEvent, "kind" | "sourceKey" | "body">): string {
  return entry.kind === "automation.step" ? `${entry.sourceKey}\u0000${entry.body}` : entry.sourceKey;
}

// Record one event. Earlier rows from the same source that are unread or
// recent fold into the new row, which moves to the top: the latest state wins
// (a finished turn replaces the pane's stale "needs you"), and repeats of the
// same kind carry their count forward ("finished 3 times"). Older read rows
// stay as history.
export function insertEntry(
  list: NotificationCenterEntry[],
  event: NotifyEvent,
  opts: { read: boolean; suppressed?: string },
  now: number,
  cap = CENTER_CAP,
): void {
  const key = collapseKey(event);
  let count = 1;
  let firstAt = event.createdAt;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const prior = list[i];
    if (collapseKey(prior) !== key) continue;
    const recent = now - timeOf(prior.createdAt) < COLLAPSE_WINDOW_MS;
    if (prior.read && !recent) continue;
    list.splice(i, 1);
    if (prior.kind === event.kind) {
      count += entryCount(prior);
      const priorFirst = prior.firstAt ?? prior.createdAt;
      if (timeOf(priorFirst) < timeOf(firstAt)) firstAt = priorFirst;
    }
  }
  const entry: NotificationCenterEntry = { ...event, read: opts.read };
  if (opts.suppressed) entry.suppressed = opts.suppressed;
  if (count > 1) {
    entry.count = count;
    entry.firstAt = firstAt;
  }
  list.unshift(entry);
  evictToCap(list, cap);
}

// Apply the folding rule to a list loaded from disk, oldest first, as if each
// row had just arrived. Older builds folded only terminal rows, and only one
// earlier copy at a time, so a history written by them can hold dozens of
// rows from one source.
export function coalesceEntries(list: NotificationCenterEntry[]): boolean {
  const before = list.length;
  const replay = [...list].reverse();
  list.length = 0;
  for (const entry of replay) {
    const event: NotificationCenterEntry = { ...entry };
    delete event.count;
    delete event.firstAt;
    delete event.settled;
    delete event.suppressed;
    const { read, suppressed, firstAt, settled } = entry;
    insertEntry(list, event, { read, suppressed }, timeOf(entry.createdAt), Number.POSITIVE_INFINITY);
    const inserted = list[0];
    // insertEntry counted this row as one event; it may already stand for more.
    const own = entryCount(entry);
    if (own > 1) inserted.count = entryCount(inserted) + own - 1;
    const earliest = firstAt ?? entry.createdAt;
    if (inserted.count && timeOf(earliest) < timeOf(inserted.firstAt ?? inserted.createdAt)) {
      inserted.firstAt = earliest;
    }
    if (settled) inserted.settled = true;
  }
  return list.length !== before;
}

// Over the cap, drop the oldest read row first, then the oldest row that is
// not waiting on the user, and only then the oldest row of all. A chatty
// repository must not push a pending question out of the history.
export function evictToCap(list: NotificationCenterEntry[], cap = CENTER_CAP): boolean {
  let changed = false;
  while (list.length > cap) {
    let victim = -1;
    for (let i = list.length - 1; i >= 0 && victim < 0; i -= 1) if (list[i].read) victim = i;
    for (let i = list.length - 1; i >= 0 && victim < 0; i -= 1) {
      if (!isNeedsYouKind(list[i].kind) || list[i].settled) victim = i;
    }
    if (victim < 0) victim = list.length - 1;
    list.splice(victim, 1);
    changed = true;
  }
  return changed;
}

// Age limits: read rows go after a week, anything after a month.
export function pruneByAge(list: NotificationCenterEntry[], now: number): boolean {
  let changed = false;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const age = now - timeOf(list[i].createdAt);
    if (age > MAX_AGE_MS || (list[i].read && age > READ_MAX_AGE_MS)) {
      list.splice(i, 1);
      changed = true;
    }
  }
  return changed;
}

// The source resumed, was answered, or went away: its needs-you rows stop
// waiting. They stay in the history, read and marked settled.
export function settleSource(list: NotificationCenterEntry[], sourceKey: string): boolean {
  let changed = false;
  for (const entry of list) {
    if (entry.sourceKey !== sourceKey || entry.settled || !isNeedsYouKind(entry.kind)) continue;
    entry.settled = true;
    entry.read = true;
    changed = true;
  }
  return changed;
}

// At launch: every terminal pane of the previous session ended with it, so a
// prompt one of them was showing can no longer be answered.
export function settleTerminalQuestions(list: NotificationCenterEntry[]): boolean {
  let changed = false;
  for (const entry of list) {
    if (entry.kind !== "terminal.agent.needs-input" || entry.settled) continue;
    entry.settled = true;
    entry.read = true;
    changed = true;
  }
  return changed;
}

// Questions from workspaces that no longer exist can never be answered.
export function settleMissingWorkspaces(
  list: NotificationCenterEntry[],
  workspaceIds: ReadonlySet<string>,
): boolean {
  let changed = false;
  for (const entry of list) {
    if (entry.settled || !isNeedsYouKind(entry.kind)) continue;
    const workspaceId = targetWorkspaceId(entry.target);
    if (!workspaceId || workspaceIds.has(workspaceId)) continue;
    entry.settled = true;
    entry.read = true;
    changed = true;
  }
  return changed;
}

export function markViewed(list: NotificationCenterEntry[], view: NotificationViewSnapshot): boolean {
  let changed = false;
  for (const entry of list) {
    if (entry.read) continue;
    if (!isTargetViewed(entry.target, view, entry.kind)) continue;
    entry.read = true;
    changed = true;
  }
  return changed;
}

export function setRead(list: NotificationCenterEntry[], ids: readonly string[], read: boolean): boolean {
  const wanted = new Set(ids);
  let changed = false;
  for (const entry of list) {
    if (!wanted.has(entry.id) || entry.read === read) continue;
    entry.read = read;
    changed = true;
  }
  return changed;
}

export function removeIds(list: NotificationCenterEntry[], ids: readonly string[]): boolean {
  const wanted = new Set(ids);
  const before = list.length;
  for (let i = list.length - 1; i >= 0; i -= 1) if (wanted.has(list[i].id)) list.splice(i, 1);
  return list.length !== before;
}

// A deleted workspace takes its rows with it.
export function removeWorkspaces(list: NotificationCenterEntry[], workspaceIds: ReadonlySet<string>): boolean {
  const before = list.length;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const workspaceId = targetWorkspaceId(list[i].target);
    if (workspaceId && workspaceIds.has(workspaceId)) list.splice(i, 1);
  }
  return list.length !== before;
}

// Undo for Dismiss and Clear: put rows back where their dates say, skipping
// any id that is already present.
export function restoreEntries(list: NotificationCenterEntry[], raw: unknown): boolean {
  const present = new Set(list.map((entry) => entry.id));
  const back = sanitizeEntries(raw).filter((entry) => !present.has(entry.id));
  if (back.length === 0) return false;
  list.push(...back);
  list.sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
  evictToCap(list);
  return true;
}

export { summarizeCenter as summarize } from "@shared/notify-center";
