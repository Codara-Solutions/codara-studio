import { buildDockIndex, canDockTab, dockLeaf, isDockLeaf } from "./dock";
import { collectLeaves, findLeaf, removeLeaf } from "./paneTree";
import { isRunOwnedTab, type DockableTabKind, type PaneNode, type Tab, type TerminalTab } from "./types";

export interface SplitDropSource {
  tabId: string;
  paneId?: string;
}

export interface SplitDropPlacement {
  direction: "horizontal" | "vertical";
  position: "before" | "after";
}

export function canSplitDrop(tabs: Tab[], source: SplitDropSource, targetId: string): boolean {
  const target = tabs.find((tab) => tab.id === targetId);
  const from = tabs.find((tab) => tab.id === source.tabId);
  const docked = buildDockIndex(tabs);
  if (!target || !canDockTab(target) || docked.has(targetId)) return false;
  if (!from || from.id === targetId || isRunOwnedTab(from)) return false;
  if (source.paneId) {
    if (from.kind !== "terminal") return false;
    const pane = findLeaf(from.root, source.paneId);
    if (!pane || pane.worker?.source === "spark") return false;
    if (isDockLeaf(pane)) {
      const content = tabs.find((tab) => tab.id === pane.content.tabId);
      if (!content || !canDockTab(content)) return false;
    }
  } else if (from.kind !== "terminal" && (!canDockTab(from) || docked.has(from.id))) {
    return false;
  }
  // ChatStack can display only one docked chat per workspace.
  const chats = tabs.filter((tab) => tab.kind === "chat" && (
    docked.has(tab.id) || tab.id === targetId || (!source.paneId && tab.id === from.id)
  ));
  return chats.length <= 1;
}

export function applySplitDrop(
  tabs: Tab[],
  source: SplitDropSource,
  targetId: string,
  placement: SplitDropPlacement,
  ids: { host: string; targetCell: string; sourceCell: string },
): { tabs: Tab[]; activeId: string } | null {
  if (!canSplitDrop(tabs, source, targetId)) return null;
  const target = tabs.find((tab) => tab.id === targetId)!;
  const from = tabs.find((tab) => tab.id === source.tabId)!;
  const targetCell = dockLeaf(ids.targetCell, target.id, target.kind as DockableTabKind);
  let moving: PaneNode;
  let host: TerminalTab;
  let remaining: PaneNode | null = null;
  if (from.kind === "terminal") {
    moving = source.paneId ? findLeaf(from.root, source.paneId)! : from.root;
    remaining = source.paneId ? removeLeaf(from.root, source.paneId) : null;
    // Reuse the source host when all its panes move so live terminals stay
    // in the same mounted tab and retain their sessions and renderers.
    host = remaining
      ? { id: ids.host, kind: "terminal", title: "terminals", root: moving, activePaneId: collectLeaves(moving)[0].paneId }
      : from;
  } else {
    moving = dockLeaf(ids.sourceCell, from.id, from.kind as DockableTabKind);
    host = { id: ids.host, kind: "terminal", title: "terminals", root: moving, activePaneId: moving.paneId };
  }
  const root: PaneNode = {
    kind: "split", direction: placement.direction, ratio: 0.5,
    a: placement.position === "before" ? moving : targetCell,
    b: placement.position === "before" ? targetCell : moving,
  };
  host = { ...host, root, zoomedPaneId: null };
  const next: Tab[] = [];
  for (const tab of tabs) {
    if (tab.id === targetId && host.id !== from.id) next.push(host);
    if (tab.id === host.id) {
      next.push(host);
    } else if (tab.id === from.id && tab.kind === "terminal" && remaining) {
      next.push({
        ...tab, root: remaining,
        activePaneId: findLeaf(remaining, tab.activePaneId) ? tab.activePaneId : collectLeaves(remaining)[0].paneId,
        zoomedPaneId: tab.zoomedPaneId && findLeaf(remaining, tab.zoomedPaneId) ? tab.zoomedPaneId : null,
      });
    } else {
      next.push(tab);
    }
  }
  return { tabs: next, activeId: host.id };
}
