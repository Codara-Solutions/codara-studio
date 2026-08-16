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

export const DOCKABLE_KINDS: ReadonlySet<string> = new Set([
  "preview",
  "editor",
  "chat",
  "diff",
  "whiteboard",
  "usage",
  "automations",
]);

export interface DockRef {
  hostTabId: TabId;
  leafId: string;
}

export type DockLeaf = TerminalLeaf & {
  content: { type: "tab"; tabId: TabId; tabKind: DockableTabKind };
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

// Where "Open in split" should put a tab.
//
//   dock         — an existing terminal tab's grid takes the cell.
//   container    — nothing on screen owns a grid, so a new terminal tab is
//                  minted holding `partnerTabId`, and the target docks beside
//                  it. This is what makes "split a chat with an editor" work:
//                  the grid lives on terminal tabs, but a split of two
//                  non-terminal surfaces needs no shell in it at all.
//   new-terminal — there is no partner and no grid: pair the target with a
//                  fresh shell, which is the only other surface available.
export type OpenInSplitPlan =
  | { kind: "dock"; hostTabId: TabId }
  | { kind: "container"; partnerTabId: TabId }
  | { kind: "new-terminal" };

// Resolve that plan. Pure so the decision is testable on its own — the rule it
// encodes is a UX contract, not an implementation detail:
//
//   "Open in split" pairs the tab you picked with the surface you are LOOKING
//   AT. Previously it always hunted for a terminal tab — the active one if it
//   happened to be a terminal, otherwise whichever terminal tab sat last in the
//   strip — so invoking it from a chat teleported the chat into an unrelated
//   grid (possibly a hidden worker grid), and a workspace with no terminal tab
//   at all didn't even render the menu item.
//
// `lastTerminalTabId` is the terminal tab the user was in most recently; it
// only decides the fallback, where "the one I was just in" beats "the last one
// in strip order".
export function planOpenInSplit(
  tabs: readonly Tab[],
  activeId: TabId | null,
  tabId: TabId,
  lastTerminalTabId?: TabId | null,
): OpenInSplitPlan | null {
  const target = tabs.find((t) => t.id === tabId);
  if (!target || !canDockTab(target)) return null;

  const usableHost = (tab: Tab | undefined): tab is Tab =>
    !!tab && tab.kind === "terminal" && !isRunOwnedTab(tab);

  const active = activeId ? tabs.find((t) => t.id === activeId) : undefined;
  // Looking at a grid already → that grid takes the cell.
  if (active && active.id !== tabId && usableHost(active)) {
    return { kind: "dock", hostTabId: active.id };
  }
  // Looking at another workspace surface → pair the two of them directly.
  // A partner that is itself docked would be torn out of the grid it is
  // showing in, so it is left alone and the fallback below applies.
  const docked = buildDockIndex(tabs as Tab[]);
  if (
    active &&
    active.id !== tabId &&
    canDockTab(active) &&
    !docked.has(active.id) &&
    !docked.has(tabId)
  ) {
    return { kind: "container", partnerTabId: active.id };
  }
  // No usable partner (the target IS the active tab, or the active surface is
  // run-owned): fall back to a grid, preferring the one the user was last in.
  const remembered = lastTerminalTabId
    ? tabs.find((t) => t.id === lastTerminalTabId)
    : undefined;
  if (usableHost(remembered) && remembered.id !== tabId) {
    return { kind: "dock", hostTabId: remembered.id };
  }
  const fallback = [...tabs].reverse().find((t) => usableHost(t) && t.id !== tabId);
  if (fallback) return { kind: "dock", hostTabId: fallback.id };
  return { kind: "new-terminal" };
}
