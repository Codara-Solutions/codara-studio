import { useEffect } from "react";
import type { NavigationTarget, TerminalAgentTarget } from "@shared/types";
import { targetWorkspaceId } from "@shared/notify-center";

// Click-routing for the unified notifications pipeline: one navigateTo()
// shared by the toast cards, the notification center, and native
// notification clicks (which arrive as "notify:focus" pushes from main).

export interface NavigationHandlers {
  selectRun: (runId: string, workspaceId?: string) => void;
  focusTerminal: (target: TerminalAgentTarget) => void;
  openAutomations: () => void;
  // Switch to the workspace and, for panel "git", reveal its Source Control
  // section (teammate-push alerts from the background auto-fetcher).
  openWorkspace: (workspaceId: string, panel?: "git") => void;
  // Whether the target still exists. A row whose pane was closed or whose
  // run was deleted is "gone", and opening it lands on its workspace instead.
  describeTarget: (target: NavigationTarget) => NotifyTargetStatus;
  // Say why a click landed somewhere other than its target.
  explain: (title: string, body: string) => void;
}

export type NotifyGoneReason = "pane" | "run" | "workspace";

export type NotifyTargetStatus =
  | { state: "live" }
  | { state: "gone"; reason: NotifyGoneReason };

// "opened": the exact target is on screen. "fallback": the target is gone
// but its workspace was opened. "gone": nothing could be opened.
export type NavigateOutcome = "opened" | "fallback" | "gone";

export type NavigateTo = (target: NavigationTarget) => NavigateOutcome;

export const GONE_LABEL: Record<NotifyGoneReason, string> = {
  pane: "Pane closed",
  run: "Run deleted",
  workspace: "Workspace removed",
};

export function createNavigateTo(handlers: NavigationHandlers): NavigateTo {
  return (target) => {
    if (!target || typeof target !== "object") return "gone";
    const status = handlers.describeTarget(target);
    if (status.state === "gone") {
      const workspaceId = targetWorkspaceId(target);
      if (status.reason === "workspace" || !workspaceId) {
        handlers.explain("Can't open this notification", GONE_LABEL[status.reason] + ".");
        return "gone";
      }
      handlers.openWorkspace(workspaceId);
      handlers.explain(
        status.reason === "pane" ? "That pane was closed" : "That run was deleted",
        "Opened its workspace instead.",
      );
      return "fallback";
    }
    switch (target.type) {
      case "run":
        handlers.selectRun(target.runId, target.workspaceId);
        break;
      case "terminal":
        handlers.focusTerminal({
          workspaceId: target.workspaceId,
          tabId: target.tabId,
          paneId: target.paneId,
        });
        break;
      case "automation":
        // A loom's live run is the most useful landing spot; without one,
        // fall back to the Automations hub. Pass workspaceId so a cross-
        // workspace click switches projects first (selectRun →
        // handleSelectRunAnywhere routes loom runs to that workspace's hub);
        // without it the click dead-ends in the wrong workspace's hub.
        if (target.runId) handlers.selectRun(target.runId, target.workspaceId);
        else handlers.openAutomations();
        break;
      case "workspace":
        handlers.openWorkspace(target.workspaceId, target.panel);
        break;
    }
    return "opened";
  };
}

// The single renderer-side listener for main's "notify:focus" push (native
// notification clicks, every kind).
export function useNotifyFocusRouting(navigateTo: NavigateTo, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    return window.spark.notifications.onFocusTarget?.((target) => {
      navigateTo(target);
    });
  }, [enabled, navigateTo]);
}
