import { findLeaf } from "./paneTree";
import type { Tab, TabId } from "./types";

// Where an agent's new terminal tab goes. Pure so the placement rules are
// testable without mounting the app (scripts/test-agent-terminal-placement.cjs).

export interface WorkspaceTabs {
  workspaceId: string;
  tabs: readonly Tab[];
}

export function locateTerminalPane(
  layouts: readonly WorkspaceTabs[],
  paneId: string,
): { workspaceId: string; tabId: TabId } | null {
  for (const layout of layouts) {
    const tab = layout.tabs.find(
      (item) => item.kind === "terminal" && findLeaf(item.root, paneId) !== null,
    );
    if (tab) return { workspaceId: layout.workspaceId, tabId: tab.id };
  }
  return null;
}

// The workspace of the pane an agent runs in. After the window reloads, panes
// keep running in workspaces whose layout this renderer has not loaded (or has
// loaded only as a background shell holding a bridge-opened tab), so their
// saved layouts are consulted too. tabId is null when only a saved layout
// knows the pane.
export function locateCallerPane(
  loaded: readonly WorkspaceTabs[],
  paneId: string,
  workspaceIds: Iterable<string>,
  savedPaneIds: (workspaceId: string) => ReadonlySet<string>,
): { workspaceId: string; tabId: TabId | null } | null {
  const found = locateTerminalPane(loaded, paneId);
  if (found) return found;
  for (const workspaceId of workspaceIds) {
    if (savedPaneIds(workspaceId).has(paneId)) return { workspaceId, tabId: null };
  }
  return null;
}

// The caller's own tab, or the last of the terminals it already opened right
// behind it, so several creates from one agent keep their order beside it.
export function agentTerminalAnchor(
  tabs: readonly Tab[],
  callerTabId: TabId,
  openedByCaller: (tabId: TabId) => boolean,
): TabId | null {
  let index = tabs.findIndex((tab) => tab.id === callerTabId);
  if (index < 0) return null;
  while (index + 1 < tabs.length && openedByCaller(tabs[index + 1].id)) index += 1;
  return tabs[index].id;
}

export function insertTabAfter<T extends { id: TabId }>(
  tabs: readonly T[],
  tab: T,
  afterTabId?: TabId | null,
): T[] {
  const index = afterTabId ? tabs.findIndex((item) => item.id === afterTabId) : -1;
  if (index < 0) return [...tabs, tab];
  return [...tabs.slice(0, index + 1), tab, ...tabs.slice(index + 1)];
}
