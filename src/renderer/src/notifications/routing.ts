import { useEffect } from "react";
import type { NavigationTarget, TerminalAgentTarget } from "@shared/types";

// Click-routing for the unified notifications pipeline: one navigateTo()
// shared by the toast cards, the notification center, and native
// notification clicks (which arrive as "notify:focus" pushes from main).

export interface NavigationHandlers {
  selectRun: (runId: string, workspaceId?: string) => void;
  focusTerminal: (target: TerminalAgentTarget) => void;
  openAutomations: () => void;
}

export type NavigateTo = (target: NavigationTarget) => void;

export function createNavigateTo(handlers: NavigationHandlers): NavigateTo {
  return (target) => {
    if (!target || typeof target !== "object") return;
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
    }
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
