import type { DockableTabKind, PaneNode, Tab, TabId, TerminalLeaf } from "./types";
import { isRunOwnedTab } from "./types";
import { collectLeaves } from "./paneTree";

// Helpers for docked tabs — tabs whose content is laid out inside a terminal
// tab's split grid instead of filling the workbench.
//
// There is deliberately NO `dockedIn` back-pointer on the tab: the pane tree is
// the single source of truth and the reverse index is derived on demand. That
// makes drift impossible (no pointer to forget to clear), makes "host tab
// closed → its docked tabs come back as pills" fall out for free, and means a
// dangling reference can only ever be a leaf pointing at a tab that no longer
// exists — which the loader and the reconcile effect prune.

export const DOCKABLE_KINDS: ReadonlySet<string> = new Set(["preview", "editor", "chat"]);

export interface DockRef {
  hostTabId: TabId;
  leafId: string;
}

export type DockLeaf = TerminalLeaf & {
  content: { type: "tab"; tabId: TabId; tabKind: "preview" | "editor" | "chat" };
};

export function isDockLeaf(leaf: TerminalLeaf): leaf is DockLeaf {
  return leaf.content?.type === "tab";
}

// Dock cell ids are deliberately prefixed: the PTY layer must never be handed
// one, and a persisted layout carrying a dock id is recognisable on sight.
export function dockLeaf(paneId: string, tabId: TabId, tabKind: DockableTabKind): DockLeaf {
  return { kind: "leaf", paneId, content: { type: "tab", tabId, tabKind } } as DockLeaf;
}

// Terminal cells only — every caller that disposes PTYs, counts shells or
// collects scrollback must go through this rather than collectLeaves, or it
// will try to dispose a `dock_*` id that was never a PTY.
export function collectTerminalLeaves(root: PaneNode): TerminalLeaf[] {
  return collectLeaves(root).filter((l) => !isDockLeaf(l));
}

export function collectDockLeaves(root: PaneNode): DockLeaf[] {
  return collectLeaves(root).filter(isDockLeaf);
}

export function dockLeafFor(root: PaneNode, tabId: TabId): DockLeaf | null {
  return collectDockLeaves(root).find((l) => l.content.tabId === tabId) ?? null;
}

// tabId -> where it is docked. First occurrence wins so a corrupted layout that
// docks one tab twice resolves deterministically instead of flickering between
// two host cells.
export function buildDockIndex(tabs: Tab[]): ReadonlyMap<TabId, DockRef> {
  const index = new Map<TabId, DockRef>();
  for (const tab of tabs) {
    if (tab.kind !== "terminal") continue;
    for (const leaf of collectDockLeaves(tab.root)) {
      if (index.has(leaf.content.tabId)) continue;
      index.set(leaf.content.tabId, { hostTabId: tab.id, leafId: leaf.paneId });
    }
  }
  return index;
}

// Run-owned tabs (worker terminals, run canvases, orchestration previews) live
// in the chat panel's inner strip and are excluded: docking one would strand it
// with no pill to undock from once its owning chat closes.
export function canDockTab(tab: Tab): boolean {
  return DOCKABLE_KINDS.has(tab.kind) && !isRunOwnedTab(tab);
}
