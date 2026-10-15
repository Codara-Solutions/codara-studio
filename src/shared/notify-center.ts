import type {
  NavigationTarget,
  NotificationCenterEntry,
  NotificationMute,
  NotificationViewSnapshot,
  NotifyEvent,
  NotifyKind,
} from "./types";

// Pure notification-center vocabulary shared by the main-process store and
// the renderer panel. No Electron, DOM or fs imports: unit suites bundle this
// file on its own.

// Kinds that mean "something is waiting on the user". These, and only these,
// drive the bell badge and the pinned "Needs you" section.
const NEEDS_YOU_KINDS: ReadonlySet<NotifyKind> = new Set([
  "run.blocked",
  "terminal.agent.needs-input",
  "automation.blocked",
]);

const FAILED_KINDS: ReadonlySet<NotifyKind> = new Set([
  "run.failed",
  "terminal.agent.failed",
  "automation.failed",
  "git.ci-failed",
]);

const DONE_KINDS: ReadonlySet<NotifyKind> = new Set([
  "run.complete",
  "terminal.agent.done",
  "automation.finished",
]);

export type NotifyState = "needs-you" | "failed" | "done" | "info";

export function isNeedsYouKind(kind: NotifyKind): boolean {
  return NEEDS_YOU_KINDS.has(kind);
}

export function notifyState(kind: NotifyKind): NotifyState {
  if (NEEDS_YOU_KINDS.has(kind)) return "needs-you";
  if (FAILED_KINDS.has(kind)) return "failed";
  if (DONE_KINDS.has(kind)) return "done";
  return "info";
}

export function targetWorkspaceId(target: NavigationTarget): string | undefined {
  return "workspaceId" in target && typeof target.workspaceId === "string"
    ? target.workspaceId
    : undefined;
}

export const workspaceMuteKey = (workspaceId: string): string => `workspace:${workspaceId}`;
export const sourceMuteKey = (sourceKey: string): string => `source:${sourceKey}`;
export const agentMuteKey = (agentId: string): string => `agent:${agentId}`;
export const jobMuteKey = (jobId: string): string => `job:${jobId}`;
// The mute keys main accepts from a renderer.
export const MUTE_KEY_PATTERN = /^(?:workspace|source|agent|job):./;

export type MuteEvent = Pick<NotifyEvent, "kind" | "sourceKey" | "target" | "title">;

// Terminal titles read "<agent> <status>[ · <tab>]", from the terminal
// notifier and codara_notify_user alike; older builds put a dash before the
// status.
const AGENT_STATUS = /\s+(?:[\u2014\u2013-]\s+)?(?:finished\b.*|needs (?:you|input)\b.*|stopped\b.*|failed\b.*|is waiting\b.*)$/i;

// Who raised an event, across panes and workspaces: the agent CLI in a
// terminal, Cora for runs, the automation loop for automations. Null when a
// title names no agent (a bare "Agent" from an unknown runtime).
export function agentOf(event: Pick<NotifyEvent, "kind" | "title">): { id: string; label: string } | null {
  if (event.kind.startsWith("run.")) return { id: "cora", label: "Cora runs" };
  if (event.kind.startsWith("automation.")) return { id: "automations", label: "Automations" };
  if (!event.kind.startsWith("terminal.agent.")) return null;
  const head = (event.title || "").split(" \u00b7 ")[0].trim();
  const label = head.replace(AGENT_STATUS, "").trim();
  if (!label || label === head || /^agent$/i.test(label)) return null;
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return id ? { id, label } : null;
}

export function activeMutes(mutes: readonly NotificationMute[], now: number): NotificationMute[] {
  return mutes.filter((mute) => mute.until > now);
}

export function muteKeysFor(event: MuteEvent): string[] {
  const keys = [sourceMuteKey(event.sourceKey)];
  const workspaceId = targetWorkspaceId(event.target);
  if (workspaceId) keys.push(workspaceMuteKey(workspaceId));
  const agent = agentOf(event);
  if (agent) keys.push(agentMuteKey(agent.id));
  if (event.target.type === "automation" && event.target.jobId) keys.push(jobMuteKey(event.target.jobId));
  return keys;
}

export function mutedBy(
  event: MuteEvent,
  mutes: readonly NotificationMute[],
  now: number,
): NotificationMute | null {
  if (mutes.length === 0) return null;
  const keys = new Set(muteKeysFor(event));
  return mutes.find((mute) => mute.until > now && keys.has(mute.key)) ?? null;
}

// A row still waiting on the user: a needs-you kind whose source has not
// moved on since (resumed, answered, closed or deleted).
export function isOpenQuestion(entry: Pick<NotificationCenterEntry, "kind" | "settled">): boolean {
  return NEEDS_YOU_KINDS.has(entry.kind) && entry.settled !== true;
}

export type IsGone = (entry: NotificationCenterEntry) => boolean;

// The one rule behind the bell badge, the "Needs you" tab count and the
// pinned section: an open question the user has not seen, whose source is
// not muted, and whose pane, run or workspace still exists. Main has no view
// of panes, so it passes no isGone and relies on settling instead (a pane's
// disposal and a run's deletion settle their questions); the renderer passes
// one so a closed pane drops out as soon as its layout changes. A read or
// muted question is still open, but no longer asks for attention.
export function countsAsNeedsYou(
  entry: NotificationCenterEntry,
  mutes: readonly NotificationMute[],
  now: number,
  isGone?: IsGone,
): boolean {
  if (entry.read || !isOpenQuestion(entry)) return false;
  if (mutes.length > 0 && mutedBy(entry, mutes, now)) return false;
  return !isGone?.(entry);
}

// Unread rows that earn the bell's quiet dot when nothing needs the user:
// not muted, and not a teammate's push, which arrives all day and never asks
// for anything.
export function countsAsNotable(
  entry: NotificationCenterEntry,
  mutes: readonly NotificationMute[],
  now: number,
): boolean {
  if (entry.read || entry.kind === "git.teammate-push") return false;
  return !(mutes.length > 0 && mutedBy(entry, mutes, now));
}

export interface CenterCounts {
  unread: number;
  needsYou: number;
  notable: number;
}

export function countCenter(
  list: readonly NotificationCenterEntry[],
  mutes: readonly NotificationMute[],
  now: number,
  isGone?: IsGone,
): CenterCounts {
  const live = activeMutes(mutes, now);
  let unread = 0;
  let needsYou = 0;
  let notable = 0;
  for (const entry of list) {
    if (entry.read) continue;
    unread += 1;
    if (countsAsNeedsYou(entry, live, now, isGone)) needsYou += 1;
    else if (countsAsNotable(entry, live, now)) notable += 1;
  }
  return { unread, needsYou, notable };
}

export function summarizeCenter(
  list: readonly NotificationCenterEntry[],
  mutes: readonly NotificationMute[],
  now: number,
): CenterCounts & { mutes: NotificationMute[] } {
  return { ...countCenter(list, mutes, now), mutes: activeMutes(mutes, now) };
}

// Whether a row's target is the exact surface on screen. Only a visible run,
// the selected terminal pane and the page of the automation itself count:
// being in a workspace, or on the Automations hub showing another
// automation, says nothing about whether a particular alert was seen.
// A loom "Notify" step is the user's own message to themselves and a
// teammate push has no single surface, so neither is ever acknowledged by
// looking.
export function isTargetViewed(
  target: NavigationTarget,
  view: NotificationViewSnapshot,
  kind?: NotifyKind,
): boolean {
  if (kind === "automation.step") return false;
  if (target.type === "workspace") return false;
  if (target.type === "terminal") {
    return (
      view.terminal !== null &&
      target.workspaceId === view.terminal.workspaceId &&
      target.tabId === view.terminal.tabId &&
      target.paneId === view.terminal.paneId
    );
  }
  // A loom's own alerts (finished, failed, blocked) carry its pass's run,
  // which has no chat tab, so its page is the surface they are seen on.
  if (
    target.type === "automation" &&
    target.jobId &&
    view.automation &&
    target.jobId === view.automation.jobId &&
    (!target.workspaceId || target.workspaceId === view.automation.workspaceId)
  ) {
    return true;
  }
  const runId = target.runId;
  if (!runId || runId !== view.visibleRunId) return false;
  // Run ids are unique across workspaces, but a stale view can still name a
  // run from the workspace the user just left. Require the workspaces to
  // agree whenever both sides know theirs.
  const workspaceId = targetWorkspaceId(target);
  return !workspaceId || !view.workspaceId || workspaceId === view.workspaceId;
}
