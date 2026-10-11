import type { NotificationCenterEntry } from "@shared/types";
import { isNeedsYouKind, targetWorkspaceId } from "@shared/notify-center";
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
  // "needs-you" marks the pinned section of rows still waiting on the user.
  tone?: "needs-you";
  color?: string;
  items: CenterItem[];
  // Rows (not items) in the section, for the header count.
  rows: number;
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

// A row still waiting on the user: a needs-you kind whose source has not
// moved on since.
export function isWaiting(entry: NotificationCenterEntry): boolean {
  return isNeedsYouKind(entry.kind) && entry.settled !== true;
}

export function matchesFilter(entry: NotificationCenterEntry, filter: CenterFilter): boolean {
  if (filter === "needs-you") return isWaiting(entry);
  if (filter === "unread") return !entry.read;
  return true;
}

export function entryCount(entry: NotificationCenterEntry): number {
  return typeof entry.count === "number" && entry.count > 1 ? Math.floor(entry.count) : 1;
}

// Producers write titles for a one-line OS banner: a brand prefix and a
// dash before "needs you", or "Claude Code finished · server". In a list
// that already shows the workspace and an icon, the brand prefix says
// nothing and the trailing "· tab" crowds out the part that matters, so the
// head becomes the title and the tail moves to the context line.
const GENERIC_TITLE = /^(?:Codara Studio|Automation)\s+[\u2014\u2013-]\s+/;

export function displayText(entry: NotificationCenterEntry): { title: string; context: string | null } {
  const raw = (entry.title || "").trim();
  if (!raw || GENERIC_TITLE.test(raw)) return { title: kindMeta(entry.kind).label, context: null };
  const split = raw.indexOf(" · ");
  if (split > 0) return { title: raw.slice(0, split), context: raw.slice(split + 3) || null };
  return { title: raw, context: null };
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
  if (entry.kind.startsWith("automation.")) return "This automation";
  if (entry.kind.startsWith("run.")) return "This Cora run";
  return title;
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

export function buildSections(
  entries: readonly NotificationCenterEntry[],
  opts: {
    filter: CenterFilter;
    grouping: CenterGrouping;
    now: number;
    workspaces: ReadonlyMap<string, NotifyWorkspaceMeta>;
    // A row whose pane, run or workspace no longer exists. Such a question
    // can no longer be answered, so it is neither pinned nor counted.
    isGone?: (entry: NotificationCenterEntry) => boolean;
  },
): CenterSection[] {
  const { filter, grouping, now, workspaces } = opts;
  const isGone = opts.isGone ?? (() => false);
  const open = (entry: NotificationCenterEntry) => isWaiting(entry) && !isGone(entry);
  const visible = entries.filter((entry) =>
    filter === "needs-you" ? open(entry) : matchesFilter(entry, filter),
  );
  const sections: CenterSection[] = [];

  // Open questions sit above everything else, whatever the grouping, read or
  // not: reading one does not answer it.
  const pinned = filter === "needs-you" ? [] : visible.filter(open);
  if (pinned.length > 0) {
    sections.push({
      key: "needs-you",
      label: "Needs you",
      tone: "needs-you",
      items: pinned.map((entry) => ({ type: "row", entry })),
      rows: pinned.length,
      showCount: true,
      limit: PINNED_LIMIT,
    });
  }
  const pinnedIds = new Set(pinned.map((e) => e.id));
  const rest = visible.filter((e) => !pinnedIds.has(e.id));

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
      sections.push({
        key: `ws:${key}`,
        label: group.label,
        color: group.color,
        items: stackItems(group.entries, workspaces),
        rows: group.entries.length,
        showCount: true,
        limit: WORKSPACE_SECTION_LIMIT,
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
      items: filter === "needs-you" ? day.entries.map((entry) => ({ type: "row", entry })) : stackItems(day.entries, workspaces),
      rows: day.entries.length,
      collapsed: key === "older" && hasRecent,
    });
  }
  return sections;
}

export function filterCounts(
  entries: readonly NotificationCenterEntry[],
  isGone: (entry: NotificationCenterEntry) => boolean = () => false,
): Record<CenterFilter, number> {
  let needsYou = 0;
  let unread = 0;
  for (const entry of entries) {
    if (isWaiting(entry) && !isGone(entry)) needsYou += 1;
    if (!entry.read) unread += 1;
  }
  return { all: entries.length, "needs-you": needsYou, unread };
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
