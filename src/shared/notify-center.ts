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

export function activeMutes(mutes: readonly NotificationMute[], now: number): NotificationMute[] {
  return mutes.filter((mute) => mute.until > now);
}

export function mutedBy(
  event: Pick<NotifyEvent, "sourceKey" | "target">,
  mutes: readonly NotificationMute[],
  now: number,
): NotificationMute | null {
  const workspaceId = targetWorkspaceId(event.target);
  const keys = new Set([sourceMuteKey(event.sourceKey)]);
  if (workspaceId) keys.add(workspaceMuteKey(workspaceId));
  return mutes.find((mute) => mute.until > now && keys.has(mute.key)) ?? null;
}

// Unread rows, and the subset the badge shows: rows still waiting on the user
// whose source is not muted right now.
export function summarizeCenter(
  list: readonly NotificationCenterEntry[],
  mutes: readonly NotificationMute[],
  now: number,
): { unread: number; needsYou: number; mutes: NotificationMute[] } {
  const live = activeMutes(mutes, now);
  let unread = 0;
  let needsYou = 0;
  for (const entry of list) {
    if (entry.read) continue;
    unread += 1;
    if (!isNeedsYouKind(entry.kind) || entry.settled) continue;
    if (live.length > 0 && mutedBy(entry, live, now)) continue;
    needsYou += 1;
  }
  return { unread, needsYou, mutes: live };
}

// Whether a row's target is the exact surface on screen. Only a visible run
// and the selected terminal pane count: being in a workspace, or on the
// Automations hub, says nothing about whether a particular alert was seen.
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
  const runId = target.runId;
  if (!runId || runId !== view.visibleRunId) return false;
  // Run ids are unique across workspaces, but a stale view can still name a
  // run from the workspace the user just left. Require the workspaces to
  // agree whenever both sides know theirs.
  const workspaceId = targetWorkspaceId(target);
  return !workspaceId || !view.workspaceId || workspaceId === view.workspaceId;
}
