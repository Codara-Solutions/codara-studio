// Lets the agent bridges (previewRpc, terminalRpc) read and set tab groups,
// which live in App's tab store. App registers the adapter at mount, as it
// does for the preview and terminal registries.

export interface TabGroupBridge {
  // The group name of a tab in any loaded workspace layout, or null.
  groupOf: (tabId: string) => string | null;
  // Move a tab into the named group of its workspace, starting the group if
  // needed. Returns the group's name, or null when the tab is not loaded.
  assignTab: (tabId: string, workspaceId: string | null, name: string) => string | null;
  // The same for the tab that holds a terminal pane.
  assignPane: (paneId: string, name: string) => string | null;
}

let bridge: TabGroupBridge | null = null;

export function setTabGroupBridge(next: TabGroupBridge | null): void {
  bridge = next;
}

export function tabGroupNameOf(tabId: string): string | null {
  return bridge?.groupOf(tabId) ?? null;
}

export function assignTabToGroup(tabId: string, workspaceId: string | null, name: string): string | null {
  if (!bridge) throw new Error("Codara is not ready to group tabs yet. Retry in a moment.");
  return bridge.assignTab(tabId, workspaceId, name);
}

export function assignPaneToGroup(paneId: string, name: string): string | null {
  if (!bridge) throw new Error("Codara is not ready to group tabs yet. Retry in a moment.");
  return bridge.assignPane(paneId, name);
}
