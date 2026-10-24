import { useEffect } from "react";
import type { NavigationTarget, TerminalAgentTarget } from "@shared/types";
import { targetWorkspaceId } from "@shared/notify-center";

// Click-routing for the unified notifications pipeline: one navigateTo()
// shared by the toast cards, the notification center, and native
// notification clicks (which arrive as "notify:focus" pushes from main).

export type AutomationTarget = Extract<NavigationTarget, { type: "automation" }>;

export interface NavigationHandlers {
  selectRun: (runId: string, workspaceId?: string) => void;
  focusTerminal: (target: TerminalAgentTarget) => void;
  // Switch to the automation's workspace and open its Automations hub on the
  // automation, or on the workflow run when the target names one.
  openAutomation: (target: AutomationTarget) => void;
  // Switch to the workspace and, for panel "git", reveal its Source Control
  // section (teammate-push alerts from the background auto-fetcher).
  openWorkspace: (workspaceId: string, panel?: "git") => void;
  // Whether the target still exists. A row whose pane was closed or whose
  // run was deleted (or swept by retention) is "gone", and opening it lands
  // on its workspace instead.
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
  run: "Run no longer available",
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
        status.reason === "pane" ? "That pane was closed" : "That run is no longer available",
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
        handlers.openAutomation(target);
        break;
      case "workspace":
        handlers.openWorkspace(target.workspaceId, target.panel);
        break;
    }
    return "opened";
  };
}

// The single renderer-side listener for main's "notify:focus" push (native
// notification clicks, every kind). Opening one marks its center row read
// unless nothing could be opened, the same as a click on the row or toast.
export function useNotifyFocusRouting(navigateTo: NavigateTo, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    return window.spark.notifications.onFocusTarget?.((target, entryId) => {
      const outcome = navigateTo(target);
      if (entryId && outcome !== "gone") {
        void window.spark.notifications.markRead(entryId).catch(() => undefined);
      }
    });
  }, [enabled, navigateTo]);
}
