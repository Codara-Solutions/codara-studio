import { BrowserWindow } from "electron";
import type { UiAttentionSnapshot } from "@shared/types";

// The single attention tracker: what the user is looking at right now, as
// reported by the renderer through one IPC ("ui:setAttention") on every
// relevant change (active tab / workspace / run / pane / window focus).
// Replaces the two parallel trackers the old notifiers kept
// (notifications.ts activeRunId + terminal-agent-notify.ts activeContext).

let current: UiAttentionSnapshot = {
  focused: false,
  workspaceId: null,
  tabId: null,
  runId: null,
  paneId: null,
};

export function setAttention(snapshot: Partial<UiAttentionSnapshot> | null | undefined): void {
  const src = snapshot && typeof snapshot === "object" ? snapshot : {};
  current = {
    focused: src.focused === true,
    workspaceId: typeof src.workspaceId === "string" ? src.workspaceId : null,
    tabId: typeof src.tabId === "string" ? src.tabId : null,
    runId: typeof src.runId === "string" ? src.runId : null,
    paneId: typeof src.paneId === "string" ? src.paneId : null,
  };
}

// Window focus is queried live from Electron rather than trusted from the
// renderer snapshot: BrowserWindow knows synchronously, while the renderer's
// report can lag an IPC turn behind an alt-tab.
function windowFocused(): boolean {
  return BrowserWindow.getFocusedWindow() !== null;
}

// The user is looking at the chat of this run: window focused AND the
// renderer-reported selected run matches.
export function isWatchingRun(runId: string): boolean {
  return windowFocused() && current.runId === runId;
}

// The user is actively operating this exact terminal pane: window focused,
// workspace + tab selected, and the split's active pane matches. A sibling
// split may be visible, but it cannot receive input; permission prompts there
// should still surface instead of being silently treated as "watched".
export function isWatchingPane(workspaceId: string, tabId: string, paneId: string): boolean {
  return (
    windowFocused() &&
    current.workspaceId === workspaceId &&
    current.tabId === tabId &&
    current.paneId === paneId
  );
}
