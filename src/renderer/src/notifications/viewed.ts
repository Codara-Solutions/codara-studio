import type { NavigationTarget, NotifyKind } from "@shared/types";

export interface ActiveNotificationView {
  workspaceId: string | null;
  visibleRunId: string | null;
  terminal: {
    workspaceId: string;
    tabId: string;
    paneId: string;
  } | null;
  automationsActive: boolean;
}

function workspaceMatches(
  targetWorkspaceId: string | undefined,
  activeWorkspaceId: string | null,
): boolean {
  return targetWorkspaceId === undefined || targetWorkspaceId === activeWorkspaceId;
}

export function isNotificationTargetViewed(
  target: NavigationTarget,
  view: ActiveNotificationView,
  kind?: NotifyKind,
): boolean {
  // A loom "Notify" step is the user's OWN message to themselves — being seen
  // is its whole purpose. It targets its automation, and the automations page
  // is exactly where the user sits after pressing Run now, so the generic
  // "already looking at it" rule would swallow every one of them. Never
  // auto-acknowledge; the click or dismiss is the read.
  if (kind === "automation.step") return false;

  if (target.type === "run") {
    return (
      target.runId === view.visibleRunId &&
      workspaceMatches(target.workspaceId, view.workspaceId)
    );
  }

  if (target.type === "terminal") {
    return (
      view.terminal !== null &&
      target.workspaceId === view.terminal.workspaceId &&
      target.tabId === view.terminal.tabId &&
      target.paneId === view.terminal.paneId
    );
  }

  // A teammate-push alert has no "already looking at it" surface: the user
  // may be in that workspace but not at the Source Control graph. Never
  // auto-acknowledge; the click (or dismiss) is the read.
  if (target.type === "workspace") return false;

  if (!workspaceMatches(target.workspaceId, view.workspaceId)) return false;
  if (target.runId && target.runId === view.visibleRunId) return true;
  return view.automationsActive;
}
