import type { NotificationCenterEntry, NotificationMute } from "@shared/types";
import {
  agentMuteKey,
  agentOf,
  countsAsNeedsYou,
  isOpenQuestion,
  jobMuteKey,
  mutedBy,
  sourceMuteKey,
  targetWorkspaceId,
  workspaceMuteKey,
  type IsGone,
} from "@shared/notify-center";
import { kindMeta } from "./kinds";

// Pure view model for the notification-center panel: filtering, the pinned
// "Needs you" section, day or workspace sections, stacks of similar rows,
// display text and relative times. No React or DOM, so
// scripts/test-notify-center-view.cjs can bundle it on its own.

export interface NotifyWorkspaceMeta {
  id: string;
  name: string;
  color?: string;
}

export type CenterFilter = "all" | "needs-you" | "unread";
export type CenterGrouping = "time" | "workspace";

export type CenterItem =
  | { type: "row"; entry: NotificationCenterEntry }
  | { type: "stack"; key: string; entries: NotificationCenterEntry[] };

export interface CenterSection {
  key: string;
  label: string;
  // "needs-you" marks the pinned section of questions the user has not seen.
  tone?: "needs-you";
  color?: string;
  items: CenterItem[];
  // Rows (not items) in the section, for the header count.
  rows: number;
  // A quiet aside after the count ("3 seen · 1 muted").
  note?: string;
  // Starts folded (the "Older" day bucket when newer rows exist).
  collapsed?: boolean;
  // Items shown before a "Show N more" control.
  limit?: number;
  // Day headers name the day; a count beside a date reads as part of it.
  showCount?: boolean;
}

const DAY_MS = 86_400_000;
const WORKSPACE_SECTION_LIMIT = 4;
const PINNED_LIMIT = 3;
// A "Show N more" that would reveal only one or two rows costs a click for
// nothing; below this many hidden rows the whole section shows.
const MIN_HIDDEN = 3;
const RECENT_DAYS = 6;

function timeOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function daysAgo(ms: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
}

// A row still waiting on an answer, seen or not. Whether it also asks for
// attention (badge, pin) is countsAsNeedsYou.
export function isWaiting(entry: NotificationCenterEntry): boolean {
  return isOpenQuestion(entry);
}

export function entryCount(entry: NotificationCenterEntry): number {
  return typeof entry.count === "number" && entry.count > 1 ? Math.floor(entry.count) : 1;
}

// Producers write titles for a one-line OS banner: a brand prefix and a
// dash before "needs you", or "Claude Code finished · server". In a list
// that already shows the workspace and an icon, the brand prefix says
// nothing and the trailing "· tab" crowds out the part that matters, so the
// head becomes the title and the tail moves to the context line. Older
// builds wrote the status after a dash; that reads as a sentence too.
const GENERIC_TITLE = /^(?:Codara Studio|Automation)\s+[\u2014\u2013-]\s+/;
const DASHED_STATUS = /^(.+?)\s+[\u2014\u2013-]\s+(finished|needs you|failed|stopped|done)$/i;

export function displayText(entry: NotificationCenterEntry): { title: string; context: string | null } {
  const raw = (entry.title || "").trim();
  if (!raw || GENERIC_TITLE.test(raw)) return { title: kindMeta(entry.kind).label, context: null };
  const split = raw.indexOf(" · ");
  const head = split > 0 ? raw.slice(0, split) : raw;
  const context = split > 0 ? raw.slice(split + 3) || null : null;
  const dashed = DASHED_STATUS.exec(head);
  return { title: dashed ? `${dashed[1]} ${dashed[2].toLowerCase()}` : head, context };
}

// Filler a terminal alert's body carries for the OS banner, where the title
// is cut short. Under a title that already says "finished" or "needs you"
// it repeats it, so only the facts after it (the agent's own message, the
// duration) are shown.
const FILLER = [
  /^Finished its turn\.$/i,
  /^Its background tasks are done\.$/i,
  /^Waiting for your answer\.$/i,
  /^Click to jump to the terminal\.$/i,
];

// Producers join a message and its detail with a spaced dash ("... ran 18m",
// "1 commit to main, Retry once"); the list joins facts with a middle dot.
const SPACED_DASH = /\s+[\u2014\u2013]\s+/g;

export function displayBody(entry: NotificationCenterEntry): string | null {
  const body = (entry.body || "").trim().replace(SPACED_DASH, " \u00b7 ");
  if (!body || !entry.kind.startsWith("terminal.agent.")) return body || null;
  const parts = body
    .replace(/\s*Click to jump to the terminal\.\s*$/i, "")
    .split(" · ")
    .map((part) => part.trim())
    .filter((part) => part && !FILLER.some((re) => re.test(part)));
  if (parts.length === 0) return null;
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// What a folded row stands for beyond its latest message: "52 pushes to
// main, feature/sync". Branches come from the latest body and the earlier
// ones the row keeps.
export function foldSummary(entry: NotificationCenterEntry): string | null {
  const count = entryCount(entry);
  if (count < 2 || entry.kind !== "git.teammate-push") return null;
  const branches: string[] = [];
  for (const body of [entry.body, ...(entry.earlier ?? [])]) {
    const match = /\bcommits? to (\S+?)(?:\s|$)/.exec(body ?? "");
    if (match && !branches.includes(match[1])) branches.push(match[1]);
  }
  return `${count} pushes${branches.length > 0 ? ` to ${branches.join(", ")}` : ""}`;
}

export function workspaceOf(
  entry: NotificationCenterEntry,
  workspaces: ReadonlyMap<string, NotifyWorkspaceMeta>,
): { id: string | null; name: string | null; color?: string } {
  const id = targetWorkspaceId(entry.target) ?? null;
  const meta = id ? workspaces.get(id) : undefined;
  return { id, name: meta?.name ?? entry.workspaceName ?? null, color: meta?.color };
}

// What a mute of this row's source would silence, in words.
export function sourceLabel(entry: NotificationCenterEntry): string {
  if (entry.kind.startsWith("automation.")) return automationName(entry) ?? "This automation";
  const { title, context } = displayText(entry);
  const key = entry.sourceKey || "";
  if (entry.kind.startsWith("terminal.agent.")) {
    const agent = title.replace(/\s+(?:finished|needs (?:you|input)|stopped|failed|is waiting.*)$/i, "").trim();
    return `${agent || "This agent"}${context ? ` in ${context}` : " in this pane"}`;
  }
  if (entry.kind === "git.teammate-push") {
    const repo = key.replace(/^github-push:/, "").split("/").pop();
    return repo ? `Pushes to ${repo}` : "These pushes";
  }
  if (entry.kind === "git.pull-request") {
    const match = /#(\d+)$/.exec(key);
    return match ? `Pull request #${match[1]}` : "This pull request";
  }
  if (entry.kind.startsWith("run.")) return "This Cora run";
  return title;
}

// An automation's own name: the title of a loom "Notify" step, or the quoted
// name an outcome body starts with.
function automationName(entry: NotificationCenterEntry): string | null {
  if (entry.kind === "automation.step") return entry.title.trim() || null;
  const quoted = /^\u201c([^\u201d]{1,60})\u201d/.exec((entry.body || "").trim());
  return quoted ? quoted[1] : null;
}

export interface MuteChoice {
  key: string;
  // What the footer lists while the mute lasts.
  label: string;
}

// What a row's mute menu offers, narrowest first: the source itself (this
// pane, run, automation or repository), the agent everywhere, then the whole
// workspace. A source that can never notify again (a closed pane, a finished
// or deleted run) is left out; muting it would silence nothing.
export function muteChoices(
  entry: NotificationCenterEntry,
  workspace: { id: string | null; name: string | null },
  gone: boolean,
): MuteChoice[] {
  const out: MuteChoice[] = [];
  const target = entry.target;
  if (target.type === "automation" && target.jobId) {
    out.push({ key: jobMuteKey(target.jobId), label: sourceLabel(entry) });
  } else if (!gone && !(entry.kind === "run.complete" || entry.kind === "run.failed")) {
    out.push({ key: sourceMuteKey(entry.sourceKey), label: sourceLabel(entry) });
  }
  const agent = agentOf(entry);
  if (agent) {
    const label =
      agent.id === "cora" ? "All Cora runs" : agent.id === "automations" ? "All automations" : `${agent.label} everywhere`;
    out.push({ key: agentMuteKey(agent.id), label });
  }
  if (workspace.id && workspace.name) {
    out.push({ key: workspaceMuteKey(workspace.id), label: `Everything in ${workspace.name}` });
  }
  return out;
}

function prNumber(entry: NotificationCenterEntry): number | null {
  const match = /#(\d+)$/.exec(entry.sourceKey || "") ?? /#(\d+)\b/.exec(entry.title || "");
  return match ? Number(match[1]) : null;
}

// The head of a folded stack speaks for all of it: "Claude Code finished 7×
// in api-server", "Pull requests #41, #42 in api-server". The workspace is
// left out where a header already names it.
export function stackTitle(
  entries: readonly NotificationCenterEntry[],
  workspace: string | null,
): string {
  const head = entries[0];
  const where = workspace ? ` in ${workspace}` : "";
  if (head.kind === "git.pull-request") {
    const numbers = [...new Set(entries.map(prNumber).filter((n): n is number => n !== null))].sort((a, b) => a - b);
    if (numbers.length === 0) return `${entries.length} pull requests${where}`;
    const shown = numbers.slice(0, 3).map((n) => `#${n}`).join(", ");
    const more = numbers.length > 3 ? ` +${numbers.length - 3}` : "";
    return `Pull requests ${shown}${more}${where}`;
  }
  const total = entries.reduce((n, e) => n + entryCount(e), 0);
  return `${displayText(head).title} ${total}×${where}`;
}

// The control that unfolds a stack counts what it reveals in the unit the
// rows are: panes for an agent, runs for Cora. The title above it counts
// events ("finished 7×"), so the two never read as the same number gone
// wrong.
export function stackMoreLabel(entries: readonly NotificationCenterEntry[]): string {
  const n = entries.length;
  const sources = new Set(entries.map((e) => e.sourceKey)).size;
  const kind = entries[0].kind;
  const noun =
    sources !== n
      ? "notifications"
      : kind.startsWith("terminal.")
        ? "panes"
        : kind.startsWith("run.")
          ? "runs"
          : kind === "git.pull-request"
            ? "pull requests"
            : "notifications";
  return n === 2 ? `Show both ${noun}` : `Show ${n} ${noun}`;
}

// "now", "5m", "3h" within today. Older rows show the clock time when a day
// header already names the day, or a short day otherwise.
export function rowTime(iso: string, now: number, withDay: boolean): string {
  const t = timeOf(iso);
  if (!t) return "";
  const diff = Math.max(0, now - t);
  if (diff < 45_000) return "now";
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m`;
  const days = daysAgo(t, now);
  if (days <= 0) return `${Math.floor(diff / 3_600_000)}h`;
  const d = new Date(t);
  if (!withDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days <= RECENT_DAYS) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fullTime(iso: string): string {
  const t = timeOf(iso);
  if (!t) return "";
  return new Date(t).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function dayBucket(iso: string, now: number): { key: string; label: string } {
  const t = timeOf(iso);
  const days = t ? daysAgo(t, now) : Number.POSITIVE_INFINITY;
  if (days <= 0) return { key: "d0", label: "Today" };
  if (days === 1) return { key: "d1", label: "Yesterday" };
  if (days <= RECENT_DAYS) {
    return {
      key: `d${days}`,
      label: new Date(t).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }),
    };
  }
  return { key: "older", label: "Older" };
}

// Rows that read as "the same thing again" stack under their newest one:
// one agent finishing in several panes of a workspace, several pull requests
// in one repository. A question is never folded away.
function stackKey(entry: NotificationCenterEntry, workspaceKey: string): string | null {
  if (isWaiting(entry)) return null;
  if (entry.kind.startsWith("git.")) return `${workspaceKey}\u0000${entry.kind}`;
  return `${workspaceKey}\u0000${entry.kind}\u0000${displayText(entry).title}`;
}

function stackItems(
  entries: readonly NotificationCenterEntry[],
  workspaces: ReadonlyMap<string, NotifyWorkspaceMeta>,
): CenterItem[] {
  const items: CenterItem[] = [];
  const byKey = new Map<string, number>();
  for (const entry of entries) {
    const ws = workspaceOf(entry, workspaces);
    const key = stackKey(entry, ws.id ?? ws.name ?? "");
    const at = key === null ? undefined : byKey.get(key);
    if (key === null || at === undefined) {
      if (key !== null) byKey.set(key, items.length);
      items.push({ type: "row", entry });
      continue;
    }
    const existing = items[at];
    items[at] =
      existing.type === "row"
        ? { type: "stack", key, entries: [existing.entry, entry] }
        : { ...existing, entries: [...existing.entries, entry] };
  }
  return items;
}

function limitFor(items: number, limit: number): number | undefined {
  return items - limit >= MIN_HIDDEN ? limit : undefined;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export interface CenterContext {
  now: number;
  mutes: readonly NotificationMute[];
  // A row whose pane, run or workspace no longer exists. Such a question can
  // no longer be answered, so it is neither pinned nor counted.
  isGone?: IsGone;
}

function heldIn(held: ReadonlySet<string> | undefined): (entry: NotificationCenterEntry) => boolean {
  return held && held.size > 0 ? (entry) => held.has(entry.id) : () => false;
}

export function buildSections(
  entries: readonly NotificationCenterEntry[],
  opts: CenterContext & {
    filter: CenterFilter;
    grouping: CenterGrouping;
    workspaces: ReadonlyMap<string, NotifyWorkspaceMeta>;
    // Questions answered while the panel is open. They keep their place in
    // the pinned section until it closes, read or settled, so the card under
    // the pointer (and its "Answer sent") does not jump to its day. They do
    // not count: the header says how many still need the user.
    held?: ReadonlySet<string>;
  },
): CenterSection[] {
  const { filter, grouping, now, mutes, workspaces } = opts;
  const isGone = opts.isGone ?? (() => false);
  const isHeld = heldIn(opts.held);
  const counts = (entry: NotificationCenterEntry) => countsAsNeedsYou(entry, mutes, now, isGone);
  const open = (entry: NotificationCenterEntry) => isWaiting(entry) && !isGone(entry);
  const sections: CenterSection[] = [];

  // Questions the user has not seen sit above everything else, whatever the
  // grouping. A question already read, or muted, is still open but no longer
  // asks for attention: it stays in its day with a Waiting tag.
  const pinned = entries.filter((e) => counts(e) || isHeld(e));
  const counted = pinned.filter(counts).length;
  const seen = entries.filter((e) => open(e) && !counts(e) && !isHeld(e));
  if (pinned.length > 0) {
    const muted = seen.filter((e) => mutedBy(e, mutes, now)).length;
    const read = seen.length - muted;
    const note =
      counted === 0
        ? "All answered"
        : [read > 0 ? `${read} seen` : "", muted > 0 ? `${muted} muted` : ""].filter(Boolean).join(" · ");
    sections.push({
      key: "needs-you",
      label: "Needs you",
      tone: "needs-you",
      items: pinned.map((entry) => ({ type: "row", entry })),
      rows: counted,
      note: (filter === "all" || counted === 0) && note ? note : undefined,
      showCount: counted > 0,
      limit: filter === "needs-you" ? undefined : limitFor(pinned.length, PINNED_LIMIT),
    });
  }
  if (filter === "needs-you") {
    if (seen.length > 0) {
      sections.push({
        key: "seen",
        label: "Seen, still waiting",
        items: seen.map((entry) => ({ type: "row", entry })),
        rows: seen.length,
        showCount: true,
      });
    }
    return sections;
  }

  const pinnedIds = new Set(pinned.map((e) => e.id));
  const rest = entries.filter((e) => !pinnedIds.has(e.id) && (filter === "all" || !e.read));

  if (grouping === "workspace") {
    const groups = new Map<string, { label: string; color?: string; entries: NotificationCenterEntry[] }>();
    for (const entry of rest) {
      const ws = workspaceOf(entry, workspaces);
      const key = ws.id ?? (ws.name ? `name:${ws.name}` : "other");
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { label: ws.name ?? "Other", color: ws.color, entries: [] }));
      group.entries.push(entry);
    }
    for (const [key, group] of groups) {
      const items = stackItems(group.entries, workspaces);
      sections.push({
        key: `ws:${key}`,
        label: group.label,
        color: group.color,
        items,
        rows: group.entries.length,
        showCount: true,
        limit: limitFor(items.length, WORKSPACE_SECTION_LIMIT),
      });
    }
    return sections;
  }

  const days = new Map<string, { label: string; entries: NotificationCenterEntry[] }>();
  for (const entry of rest) {
    const bucket = dayBucket(entry.createdAt, now);
    let day = days.get(bucket.key);
    if (!day) days.set(bucket.key, (day = { label: bucket.label, entries: [] }));
    day.entries.push(entry);
  }
  const hasRecent = sections.length > 0 || [...days.keys()].some((key) => key !== "older");
  for (const [key, day] of days) {
    sections.push({
      key,
      label: day.label,
      items: stackItems(day.entries, workspaces),
      rows: day.entries.length,
      collapsed: key === "older" && hasRecent,
    });
  }
  return sections;
}

// The tab counts. "Needs you" is the same number as the badge and the pinned
// header; All carries none, since a total of everything says nothing.
export function filterCounts(
  entries: readonly NotificationCenterEntry[],
  ctx: CenterContext,
): { "needs-you": number; unread: number } {
  let needsYou = 0;
  let unread = 0;
  for (const entry of entries) {
    if (countsAsNeedsYou(entry, ctx.mutes, ctx.now, ctx.isGone)) needsYou += 1;
    if (!entry.read) unread += 1;
  }
  return { "needs-you": needsYou, unread };
}

// The rows Clear all removes: everything but the questions still open. A
// question whose pane or run is gone can never be answered, so it goes too.
export function clearableIds(entries: readonly NotificationCenterEntry[], isGone?: IsGone): string[] {
  return entries.filter((e) => !isWaiting(e) || isGone?.(e)).map((e) => e.id);
}

export function undoLabel(verb: "Dismissed" | "Cleared" | "Removed", count: number): string {
  return verb === "Dismissed" && count === 1 ? "Dismissed" : `${verb} ${plural(count, "notification")}`;
}

// The next 08:00 local time after `now`, for "until tomorrow morning".
export function untilTomorrowMs(now: number): number {
  const d = new Date(now);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 8, 0, 0, 0);
  return next.getTime() - now;
}

export function remainingLabel(until: number, now: number): string {
  const minutes = Math.max(1, Math.round((until - now) / 60_000));
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.round(minutes / 60);
  return `${hours}h left`;
}
