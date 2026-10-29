// The Agents tab as an inbox, after T3 Code's thread sidebar
// (github.com/pingdotgg/t3code, MIT, by Theo / Ping Labs): agents that need
// you or finished sit on top, then the Working, Snoozed and Settled shelves.
// The behaviour follows T3 Code's (settle, snooze presets, a merged pull
// request settles itself, a request for the user ends a snooze early); the
// code is Codara's own.
//
// Pure and shared so the shelves, the snooze clock, auto-settle and undo are
// testable without the app (scripts/test-agent-inbox.cjs). The board
// (agent-board.ts) says where each agent stands; this file adds what the user
// decided about it, which the renderer keeps in localStorage.

import { formatAgentSpan, type AgentBoardCard, type AgentBoardModel } from "./agent-board";
import type { PullRequestWatchState } from "./pull-request-watch";

/** The agent most rows run; only other agents show their mark on a row. */
export const AGENT_INBOX_DEFAULT_RUNTIME = "claude";

/** Records older than this are dropped on load: the agent is long gone. */
export const AGENT_INBOX_RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 500;
const MAX_NAME = 120;

export interface AgentInboxSettle {
  at: number;
  /** "owner/name#42" when a merged pull request settled it. */
  auto?: string;
}

export interface AgentInboxSnooze {
  at: number;
  until: number;
}

/** What the user decided about each agent, by board card key. */
export interface AgentInboxPrefs {
  settled: Record<string, AgentInboxSettle>;
  snoozed: Record<string, AgentInboxSnooze>;
  pinned: Record<string, number>;
  names: Record<string, string>;
  unread: Record<string, number>;
  /**
   * The pull request each card was settled for once already. A card is never
   * auto-settled twice for one pull request, so undoing it, or new work after
   * the merge, keeps the card in view.
   */
  autoSettled: Record<string, string>;
}

export function emptyAgentInboxPrefs(): AgentInboxPrefs {
  return { settled: {}, snoozed: {}, pinned: {}, names: {}, unread: {}, autoSettled: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validKey(key: string): boolean {
  return /^(?:pane|run):[\w.:-]{1,200}$/.test(key);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

// Newest first, capped, so a long-lived install never grows without bound.
function capped<T>(entries: [string, T][], at: (value: T) => number): Record<string, T> {
  entries.sort((a, b) => at(b[1]) - at(a[1]));
  return Object.fromEntries(entries.slice(0, MAX_RECORDS));
}

/** Stored prefs, with anything malformed or older than the TTL left out. */
export function parseAgentInboxPrefs(raw: unknown, now: number): AgentInboxPrefs {
  const prefs = emptyAgentInboxPrefs();
  if (!isRecord(raw)) return prefs;
  const fresh = (at: number) => now - at <= AGENT_INBOX_RECORD_TTL_MS;
  const settled: [string, AgentInboxSettle][] = [];
  for (const [key, value] of Object.entries(isRecord(raw.settled) ? raw.settled : {})) {
    if (!validKey(key) || !isRecord(value)) continue;
    const at = finite(value.at);
    if (at === null || !fresh(at)) continue;
    settled.push([key, typeof value.auto === "string" ? { at, auto: value.auto.slice(0, 300) } : { at }]);
  }
  prefs.settled = capped(settled, (value) => value.at);
  const snoozed: [string, AgentInboxSnooze][] = [];
  for (const [key, value] of Object.entries(isRecord(raw.snoozed) ? raw.snoozed : {})) {
    if (!validKey(key) || !isRecord(value)) continue;
    const at = finite(value.at);
    const until = finite(value.until);
    if (at === null || until === null || !fresh(at)) continue;
    snoozed.push([key, { at, until }]);
  }
  prefs.snoozed = capped(snoozed, (value) => value.at);
  const stamps = (field: unknown): Record<string, number> => {
    const out: [string, number][] = [];
    for (const [key, value] of Object.entries(isRecord(field) ? field : {})) {
      const at = finite(value);
      if (validKey(key) && at !== null && fresh(at)) out.push([key, at]);
    }
    return capped(out, (value) => value);
  };
  prefs.pinned = stamps(raw.pinned);
  prefs.unread = stamps(raw.unread);
  for (const [key, value] of Object.entries(isRecord(raw.names) ? raw.names : {})) {
    const name = typeof value === "string" ? cleanAgentInboxName(value) : null;
    if (validKey(key) && name) prefs.names[key] = name;
  }
  for (const [key, value] of Object.entries(isRecord(raw.autoSettled) ? raw.autoSettled : {})) {
    if (validKey(key) && typeof value === "string" && value) prefs.autoSettled[key] = value.slice(0, 300);
  }
  return prefs;
}

/** A name typed for a row: one line, trimmed; null clears it. */
export function cleanAgentInboxName(value: string): string | null {
  const name = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return name || null;
}

/** "owner/name#42": one pull request, whatever workspace shows it. */
export function pullRequestRef(pr: Pick<PullRequestWatchState, "repository" | "number">): string {
  return `${pr.repository}#${pr.number}`;
}

/** Merge PR is offered only for an open, non-draft pull request whose checks pass. */
export function isMergeReady(pr: PullRequestWatchState | null | undefined): boolean {
  return Boolean(pr && pr.phase === "open" && pr.checks === "passing");
}

/**
 * Merging into the repository's main line asks first: it is what ships. Any
 * other base (a release or integration branch) merges on the menu click,
 * after main re-checks the pull request.
 */
export function mergeNeedsConfirmation(baseBranch: string, defaultBranch?: string | null): boolean {
  const base = baseBranch.trim();
  if (!base) return true;
  if (defaultBranch && base === defaultBranch.trim()) return true;
  return base === "main" || base === "master";
}

// ---------------------------------------------------------------------------
// Reconcile: what the agents did since the user's last decision
// ---------------------------------------------------------------------------

export interface AgentInboxContext {
  now: number;
  /** The watched pull request of each workspace's branch, by workspace id. */
  pullRequests: Readonly<Record<string, PullRequestWatchState | undefined>>;
  /** Each workspace's current branch, by workspace id. */
  branches?: Readonly<Record<string, string | null | undefined>>;
}

function allCards(model: AgentBoardModel): AgentBoardCard[] {
  return [...model.needsYou, ...model.working, ...model.done];
}

/**
 * Whether the agent did something new since `at`: a settled agent comes back
 * when it starts working again, asks something new, or finishes a new turn
 * the user has not seen. A state it was already in when settled does not
 * count, and neither does a quiet move between ready and idle.
 */
export function agentActedSince(card: AgentBoardCard, at: number): boolean {
  if (!(card.since > at)) return false;
  if (card.bucket !== "done") return true;
  return card.unseen || card.tone === "danger";
}

/**
 * Whether a snoozed agent wakes early: only a request for the user or a fresh
 * failure ends a snooze before its time. A finished turn never does, so a
 * snoozed long job stays out of the way until the user asked to see it.
 */
export function snoozeEndsEarly(card: AgentBoardCard, at: number): boolean {
  if (!(card.since > at)) return false;
  return card.bucket === "needs-you" || card.tone === "danger";
}

export interface AgentInboxReconcile {
  prefs: AgentInboxPrefs;
  changed: boolean;
  /** Cards a merged pull request settled just now, for the undo line. */
  autoSettled: { key: string; ref: string; number: number }[];
}

/**
 * Applies what happened since the last look: wakes snoozes that are due or
 * cut short, brings back settled agents that acted, and settles finished
 * agents whose pull request merged. Returns the same prefs object when
 * nothing changed.
 */
export function reconcileAgentInbox(
  model: AgentBoardModel,
  prefs: AgentInboxPrefs,
  context: AgentInboxContext,
): AgentInboxReconcile {
  let next: AgentInboxPrefs | null = null;
  const edit = (): AgentInboxPrefs => {
    next ??= {
      ...prefs,
      settled: { ...prefs.settled },
      snoozed: { ...prefs.snoozed },
      autoSettled: { ...prefs.autoSettled },
    };
    return next;
  };
  const autoSettled: AgentInboxReconcile["autoSettled"] = [];
  const present = new Set<string>();
  for (const card of allCards(model)) {
    present.add(card.key);
    const snooze = prefs.snoozed[card.key];
    if (snooze && (context.now >= snooze.until || snoozeEndsEarly(card, snooze.at))) delete edit().snoozed[card.key];
    const pr = context.pullRequests[card.workspaceId];
    const settle = prefs.settled[card.key];
    if (settle && agentActedSince(card, settle.at)) {
      const target = edit();
      delete target.settled[card.key];
      // New work after the merge is news: the same merge never hides it again.
      if (pr?.phase === "merged") target.autoSettled[card.key] = pullRequestRef(pr);
    }
    // A failure stays in view whatever happened to the pull request.
    if (!pr || pr.phase !== "merged" || card.bucket !== "done" || card.tone === "danger") continue;
    const ref = pullRequestRef(pr);
    const current = next ?? prefs;
    if (current.settled[card.key] || prefs.pinned[card.key] || current.autoSettled[card.key] === ref) continue;
    const target = edit();
    target.settled[card.key] = { at: context.now, auto: ref };
    target.autoSettled[card.key] = ref;
    delete target.snoozed[card.key];
    autoSettled.push({ key: card.key, ref, number: pr.number });
  }
  // A snooze whose time passed is spent, even for an agent that is not on
  // the board right now (its terminal reconnects later).
  for (const [key, snooze] of Object.entries((next ?? prefs).snoozed)) {
    if (!present.has(key) && context.now >= snooze.until) delete edit().snoozed[key];
  }
  return { prefs: next ?? prefs, changed: next !== null, autoSettled };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export type AgentInboxStatus = "input" | "failed" | "done" | "working" | "age";

export interface AgentInboxRow {
  key: string;
  card: AgentBoardCard;
  /** The user's name for it, else the agent's own title. */
  title: string;
  renamed: boolean;
  status: AgentInboxStatus;
  /** "Input", "Failed", "Done", "Working"; null when the slot shows the age. */
  statusWord: string | null;
  /** "18m", "3h", "now": the live timer while working, the age otherwise. */
  time: string;
  /** Seen and nothing new: the title is dimmed. */
  read: boolean;
  pinned: boolean;
  /** The agent's mark is shown only when it is not the default agent. */
  showAgent: boolean;
  branch: string | null;
  pullRequest: PullRequestWatchState | null;
  /** +/- line counts belong only to a finished agent's pull request. */
  showDiff: boolean;
  mergeReady: boolean;
  snoozedUntil: number | null;
  settledAt: number | null;
}

export interface AgentInboxView {
  /** Needs you and finished, pinned first. */
  inbox: AgentInboxRow[];
  working: AgentInboxRow[];
  snoozed: AgentInboxRow[];
  settled: AgentInboxRow[];
  /** Rows in the inbox that wait on the user: the switch's badge. */
  needsYou: number;
  total: number;
}

function statusOf(card: AgentBoardCard, unread: boolean): { status: AgentInboxStatus; word: string | null } {
  if (card.bucket === "working") return { status: "working", word: "Working" };
  if (card.tone === "danger") return { status: "failed", word: "Failed" };
  if (card.bucket === "needs-you") return { status: "input", word: "Input" };
  if ((card.unseen || unread) && card.tone === "ok") return { status: "done", word: "Done" };
  return { status: "age", word: null };
}

/** The short time in a row's top right: "now", "18m", "3h". */
export function agentInboxSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  return formatAgentSpan(ms).replace(/ \d+m$/, "");
}

function row(card: AgentBoardCard, prefs: AgentInboxPrefs, context: AgentInboxContext): AgentInboxRow {
  const unread = prefs.unread[card.key] !== undefined;
  const { status, word } = statusOf(card, unread);
  const pr = context.pullRequests[card.workspaceId] ?? null;
  const name = prefs.names[card.key];
  const span = card.since > 0 ? Math.max(0, context.now - card.since) : Number.NaN;
  return {
    key: card.key,
    card,
    title: name ?? card.title,
    renamed: Boolean(name),
    status,
    statusWord: word,
    time: card.since > 0 ? agentInboxSpan(span) : "",
    read: card.bucket === "done" && !card.unseen && !unread,
    pinned: prefs.pinned[card.key] !== undefined,
    showAgent: card.runtime !== AGENT_INBOX_DEFAULT_RUNTIME,
    branch: context.branches?.[card.workspaceId] ?? null,
    pullRequest: pr,
    showDiff: Boolean(pr) && card.bucket === "done" && card.tone !== "danger",
    mergeReady: isMergeReady(pr),
    snoozedUntil: prefs.snoozed[card.key]?.until ?? null,
    settledAt: prefs.settled[card.key]?.at ?? null,
  };
}

/**
 * Sorts every agent into the inbox and the shelves. Expects prefs already
 * reconciled (reconcileAgentInbox); a snooze that is due still counts as
 * awake here, so the view is right between a tick and its reconcile.
 */
export function buildAgentInbox(
  model: AgentBoardModel,
  prefs: AgentInboxPrefs,
  context: AgentInboxContext,
): AgentInboxView {
  const inbox: AgentInboxRow[] = [];
  const working: AgentInboxRow[] = [];
  const snoozed: AgentInboxRow[] = [];
  const settled: AgentInboxRow[] = [];
  for (const card of allCards(model)) {
    const entry = row(card, prefs, context);
    const snooze = prefs.snoozed[card.key];
    if (prefs.settled[card.key]) settled.push(entry);
    else if (snooze && context.now < snooze.until) snoozed.push(entry);
    else if (card.bucket === "working") working.push(entry);
    else inbox.push(entry);
  }
  // Pinned rows lead, the earliest pin first; the board's order stays
  // otherwise (Needs you before finished, each in its own order).
  const pinnedOrder = (entry: AgentInboxRow) => prefs.pinned[entry.key] ?? Number.POSITIVE_INFINITY;
  const byPin = (a: AgentInboxRow, b: AgentInboxRow) => {
    const pa = pinnedOrder(a);
    const pb = pinnedOrder(b);
    return pa === pb ? 0 : pa < pb ? -1 : 1;
  };
  inbox.sort(byPin);
  working.sort(byPin);
  snoozed.sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0));
  settled.sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
  return {
    inbox,
    working,
    snoozed,
    settled,
    needsYou: inbox.filter((entry) => entry.card.bucket === "needs-you").length,
    total: model.total,
  };
}

// ---------------------------------------------------------------------------
// Actions, each with what undo needs
// ---------------------------------------------------------------------------

/** What one key held before an action, for undo. */
export interface AgentInboxSnapshot {
  key: string;
  settled?: AgentInboxSettle;
  snoozed?: AgentInboxSnooze;
  pinned?: number;
  names?: string;
  unread?: number;
}

export function snapshotAgentInbox(prefs: AgentInboxPrefs, keys: readonly string[]): AgentInboxSnapshot[] {
  return keys.map((key) => ({
    key,
    ...(prefs.settled[key] ? { settled: prefs.settled[key] } : {}),
    ...(prefs.snoozed[key] ? { snoozed: prefs.snoozed[key] } : {}),
    ...(prefs.pinned[key] !== undefined ? { pinned: prefs.pinned[key] } : {}),
    ...(prefs.names[key] !== undefined ? { names: prefs.names[key] } : {}),
    ...(prefs.unread[key] !== undefined ? { unread: prefs.unread[key] } : {}),
  }));
}

/**
 * Puts each key back as it was. The auto-settle memory is left alone, so an
 * undone auto-settle does not settle the card again for the same merge.
 */
export function restoreAgentInbox(prefs: AgentInboxPrefs, snapshots: readonly AgentInboxSnapshot[]): AgentInboxPrefs {
  const next = clone(prefs);
  for (const snap of snapshots) {
    for (const field of ["settled", "snoozed", "pinned", "names", "unread"] as const) {
      const value = snap[field];
      const map = next[field] as Record<string, unknown>;
      if (value === undefined) delete map[snap.key];
      else map[snap.key] = value;
    }
  }
  return next;
}

function clone(prefs: AgentInboxPrefs): AgentInboxPrefs {
  return {
    settled: { ...prefs.settled },
    snoozed: { ...prefs.snoozed },
    pinned: { ...prefs.pinned },
    names: { ...prefs.names },
    unread: { ...prefs.unread },
    autoSettled: { ...prefs.autoSettled },
  };
}

export function settleAgent(prefs: AgentInboxPrefs, key: string, now: number): AgentInboxPrefs {
  const next = clone(prefs);
  next.settled[key] = { at: now };
  delete next.snoozed[key];
  delete next.unread[key];
  return next;
}

/**
 * Settles a row whose pull request the user just merged from the inbox. It
 * counts as that merge's auto-settle, so undoing it is never followed by the
 * watcher settling it again for the same merge.
 */
export function settleMergedAgent(prefs: AgentInboxPrefs, key: string, ref: string, now: number): AgentInboxPrefs {
  const next = clone(prefs);
  next.settled[key] = { at: now, auto: ref };
  next.autoSettled[key] = ref;
  delete next.snoozed[key];
  delete next.unread[key];
  return next;
}

export function unsettleAgent(prefs: AgentInboxPrefs, key: string): AgentInboxPrefs {
  const next = clone(prefs);
  delete next.settled[key];
  return next;
}

export function snoozeAgent(prefs: AgentInboxPrefs, key: string, until: number, now: number): AgentInboxPrefs {
  const next = clone(prefs);
  next.snoozed[key] = { at: now, until };
  delete next.settled[key];
  return next;
}

export function wakeAgent(prefs: AgentInboxPrefs, key: string): AgentInboxPrefs {
  const next = clone(prefs);
  delete next.snoozed[key];
  return next;
}

export function setAgentPinned(prefs: AgentInboxPrefs, key: string, pinned: boolean, now: number): AgentInboxPrefs {
  const next = clone(prefs);
  if (pinned) next.pinned[key] = now;
  else delete next.pinned[key];
  return next;
}

export function renameAgent(prefs: AgentInboxPrefs, key: string, name: string): AgentInboxPrefs {
  const next = clone(prefs);
  const clean = cleanAgentInboxName(name);
  if (clean) next.names[key] = clean;
  else delete next.names[key];
  return next;
}

export function setAgentUnread(prefs: AgentInboxPrefs, key: string, unread: boolean, now: number): AgentInboxPrefs {
  if (!unread && prefs.unread[key] === undefined) return prefs;
  const next = clone(prefs);
  if (unread) next.unread[key] = now;
  else delete next.unread[key];
  return next;
}

// ---------------------------------------------------------------------------
// Snooze presets
// ---------------------------------------------------------------------------

export interface AgentSnoozePreset {
  id: "1h" | "3h" | "evening" | "tomorrow" | "next-week";
  label: string;
  /** The wake time as the menu shows it: "18:00", "Mon". */
  when: string;
  until: number;
}

const EVENING_HOUR = 18;
const MORNING_HOUR = 9;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function atLocal(base: Date, daysAhead: number, hour: number): Date {
  const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + daysAhead, hour, 0, 0, 0);
  return date;
}

/**
 * The snooze menu at `now`, in local time: in 1 hour, in 3 hours, this
 * evening (18:00, left out once it has passed), tomorrow 09:00 and next
 * Monday 09:00. Soonest first, one row per wake minute.
 */
export function agentSnoozePresets(now: number): AgentSnoozePreset[] {
  const base = new Date(now);
  const hourLater = new Date(now + 60 * 60 * 1000);
  const threeLater = new Date(now + 3 * 60 * 60 * 1000);
  const evening = atLocal(base, 0, EVENING_HOUR);
  const tomorrow = atLocal(base, 1, MORNING_HOUR);
  const toMonday = ((8 - base.getDay()) % 7) || 7;
  const monday = atLocal(base, toMonday, MORNING_HOUR);
  const presets: AgentSnoozePreset[] = [
    { id: "1h", label: "1 hour", when: clock(hourLater), until: hourLater.getTime() },
    { id: "3h", label: "3 hours", when: clock(threeLater), until: threeLater.getTime() },
  ];
  if (evening.getTime() > now) presets.push({ id: "evening", label: "This evening", when: clock(evening), until: evening.getTime() });
  presets.push({ id: "tomorrow", label: "Tomorrow", when: clock(tomorrow), until: tomorrow.getTime() });
  presets.push({ id: "next-week", label: "Next week", when: WEEKDAYS[monday.getDay()], until: monday.getTime() });
  // Two rows that wake on the same minute keep the one named for the time of
  // day ("This evening" over "3 hours").
  const byMinute = new Map<number, AgentSnoozePreset>();
  for (const preset of presets) {
    const minute = Math.floor(preset.until / 60_000);
    const held = byMinute.get(minute);
    if (!held || (held.id === "1h" || held.id === "3h")) byMinute.set(minute, preset);
  }
  return [...byMinute.values()].sort((a, b) => a.until - b.until);
}

/** When a snoozed row wakes, as its status slot says it: "18:00", "Tue 09:00". */
export function agentSnoozeWakeLabel(until: number, now: number): string {
  const wake = new Date(until);
  if (wake.toDateString() === new Date(now).toDateString()) return clock(wake);
  return `${WEEKDAYS[wake.getDay()]} ${clock(wake)}`;
}
