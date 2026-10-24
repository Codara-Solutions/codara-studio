import type {
  NotificationCenterEntry,
  NotificationMute,
  NotificationViewSnapshot,
  NotifyEvent,
  NotifyKind,
} from "@shared/types";
import { isNeedsYouKind, isOpenQuestion, isTargetViewed, targetWorkspaceId } from "@shared/notify-center";

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
  const kindCounts = sanitizeKindCounts(e.kindCounts, entry.kind);
  if (kindCounts) entry.kindCounts = kindCounts;
  else delete entry.kindCounts;
  const earlier = Array.isArray(e.earlier) ? distinctBodies(e.earlier, entry.body) : [];
  if (earlier.length > 0) entry.earlier = earlier;
  else delete entry.earlier;
  return entry;
}

function sanitizeKindCounts(raw: unknown, own: NotifyKind): KindCounts | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: KindCounts = {};
  for (const [kind, tally] of Object.entries(raw as Record<string, unknown>)) {
    if (kind === own || !tally || typeof tally !== "object") continue;
    const { count, firstAt, earlier } = tally as { count?: unknown; firstAt?: unknown; earlier?: unknown };
    if (typeof count !== "number" || !Number.isFinite(count) || count < 1) continue;
    if (typeof firstAt !== "string" || !Number.isFinite(Date.parse(firstAt))) continue;
    const bodies = Array.isArray(earlier) ? distinctBodies(earlier, "") : [];
    out[kind as NotifyKind] = { count: Math.floor(count), firstAt, ...(bodies.length > 0 ? { earlier: bodies } : {}) };
  }
  return Object.keys(out).length > 0 ? out : null;
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

type KindCounts = NonNullable<NotificationCenterEntry["kindCounts"]>;

interface Tally {
  count: number;
  firstAt: string;
  // Newest first.
  bodies: string[];
}

function addTally(
  tallies: Map<NotifyKind, Tally>,
  kind: NotifyKind,
  count: number,
  firstAt: string,
  bodies: readonly string[] = [],
): void {
  const prior = tallies.get(kind);
  if (!prior) {
    tallies.set(kind, { count, firstAt, bodies: [...bodies] });
    return;
  }
  prior.count += count;
  if (timeOf(firstAt) < timeOf(prior.firstAt)) prior.firstAt = firstAt;
  prior.bodies.push(...bodies);
}

function addKindCounts(tallies: Map<NotifyKind, Tally>, kindCounts: KindCounts | undefined): void {
  for (const [kind, tally] of Object.entries(kindCounts ?? {})) {
    if (tally) addTally(tallies, kind as NotifyKind, tally.count, tally.firstAt, tally.earlier);
  }
}

// What a row being folded carries: a fresh event stands for one, a row from
// disk being replayed (coalesceEntries) for whatever it already counted.
type Foldable = NotifyEvent &
  Partial<Pick<NotificationCenterEntry, "count" | "firstAt" | "kindCounts" | "earlier">>;

// Record one event. Earlier rows from the same source that are unread or
// recent fold into the new row, which moves to the top: the latest state wins
// (a finished turn replaces the pane's stale "needs you"), repeats of the
// same kind carry their count forward ("finished 3 times"), and counts of the
// kinds it replaced wait on the row until that kind comes back, so a prompt
// between two finished turns does not restart the count. The last few
// distinct bodies of the same kind stay on the row. Older read rows stay as
// history.
export function insertEntry(
  list: NotificationCenterEntry[],
  event: Foldable,
  opts: { read: boolean; suppressed?: string },
  now: number,
  cap = CENTER_CAP,
): void {
  const key = collapseKey(event);
  const tallies = new Map<NotifyKind, Tally>();
  addTally(
    tallies,
    event.kind,
    entryCount(event as NotificationCenterEntry),
    event.firstAt ?? event.createdAt,
    event.earlier,
  );
  addKindCounts(tallies, event.kindCounts);
  // Newest first, so the bodies kept are the most recent ones.
  for (let i = 0; i < list.length; i += 1) {
    const prior = list[i];
    if (collapseKey(prior) !== key) continue;
    const recent = now - timeOf(prior.createdAt) < COLLAPSE_WINDOW_MS;
    if (prior.read && !recent) continue;
    list.splice(i, 1);
    i -= 1;
    addTally(tallies, prior.kind, entryCount(prior), prior.firstAt ?? prior.createdAt, [
      prior.body,
      ...(prior.earlier ?? []),
    ]);
    addKindCounts(tallies, prior.kindCounts);
  }
  const entry: NotificationCenterEntry = { ...event, read: opts.read };
  delete entry.count;
  delete entry.firstAt;
  delete entry.kindCounts;
  delete entry.earlier;
  delete entry.suppressed;
  delete entry.settled;
  if (opts.suppressed) entry.suppressed = opts.suppressed;
  const own = tallies.get(event.kind)!;
  tallies.delete(event.kind);
  if (own.count > 1) {
    entry.count = own.count;
    entry.firstAt = own.firstAt;
  }
  const earlier = distinctBodies(own.bodies, event.body);
  if (earlier.length > 0) entry.earlier = earlier;
  if (tallies.size > 0) {
    const kindCounts: KindCounts = {};
    for (const [kind, tally] of tallies) {
      const bodies = distinctBodies(tally.bodies, "");
      kindCounts[kind] = { count: tally.count, firstAt: tally.firstAt, ...(bodies.length > 0 ? { earlier: bodies } : {}) };
    }
    entry.kindCounts = kindCounts;
  }
  // A read question older than the fold window stays behind as history, but
  // the source has moved on to a newer state since, so it no longer waits.
  for (const prior of list) {
    if (prior.sourceKey !== event.sourceKey || !isOpenQuestion(prior)) continue;
    prior.settled = true;
    prior.read = true;
  }
  list.unshift(entry);
  evictToCap(list, cap);
}

const MAX_EARLIER = 3;
const MAX_EARLIER_BODY = 300;

function distinctBodies(bodies: readonly unknown[], current: string): string[] {
  const seen = new Set([current.trim()]);
  const out: string[] = [];
  for (const raw of bodies) {
    if (typeof raw !== "string") continue;
    const body = raw.trim().slice(0, MAX_EARLIER_BODY);
    if (!body || seen.has(body)) continue;
    seen.add(body);
    out.push(body);
    if (out.length === MAX_EARLIER) break;
  }
  return out;
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
    const { read, suppressed, settled } = entry;
    insertEntry(list, entry, { read, suppressed }, timeOf(entry.createdAt), Number.POSITIVE_INFINITY);
    if (settled) list[0].settled = true;
  }
  return list.length !== before;
}

// Over the cap, drop the oldest read row first, then the oldest row that is
// not waiting on the user, and only then the oldest row of all. A question
// still open counts as waiting even once read. A chatty repository must not
// push a pending question out of the history.
export function evictToCap(list: NotificationCenterEntry[], cap = CENTER_CAP): boolean {
  let changed = false;
  while (list.length > cap) {
    let victim = -1;
    for (let i = list.length - 1; i >= 0 && victim < 0; i -= 1) {
      if (list[i].read && !isOpenQuestion(list[i])) victim = i;
    }
    for (let i = list.length - 1; i >= 0 && victim < 0; i -= 1) {
      if (!isOpenQuestion(list[i])) victim = i;
    }
    if (victim < 0) victim = list.length - 1;
    list.splice(victim, 1);
    changed = true;
  }
  return changed;
}

// Age limits: read rows go after a week, anything after a month. A question
// still open stays the month even once read: it is still waiting on the user,
// and a row that vanished would make it look handled.
export function pruneByAge(list: NotificationCenterEntry[], now: number): boolean {
  let changed = false;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = list[i];
    const age = now - timeOf(entry.createdAt);
    if (age > MAX_AGE_MS || (entry.read && age > READ_MAX_AGE_MS && !isOpenQuestion(entry))) {
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

// An automation stopped: every question one of its iterations asked can no
// longer be answered. Iteration questions carry their run's source key, so
// only the target's job id ties them to the loop.
export function settleJob(list: NotificationCenterEntry[], jobId: string): boolean {
  let changed = false;
  for (const entry of list) {
    if (entry.target.type !== "automation" || entry.target.jobId !== jobId) continue;
    if (!isOpenQuestion(entry)) continue;
    entry.settled = true;
    entry.read = true;
    changed = true;
  }
  return changed;
}

// Questions whose pane, run or workspace the renderer can no longer find.
export function settleIds(list: NotificationCenterEntry[], ids: readonly string[]): boolean {
  const wanted = new Set(ids);
  let changed = false;
  for (const entry of list) {
    if (!wanted.has(entry.id) || !isOpenQuestion(entry)) continue;
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

// Clear all: everything except the questions still waiting on an answer.
// Clearing a list must not make a blocked agent or run look handled.
export function clearExceptOpen(list: NotificationCenterEntry[]): boolean {
  const before = list.length;
  for (let i = list.length - 1; i >= 0; i -= 1) if (!isOpenQuestion(list[i])) list.splice(i, 1);
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
