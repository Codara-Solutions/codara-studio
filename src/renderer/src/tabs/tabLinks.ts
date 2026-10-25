// What a tab or group link (shared/tab-links.ts) points at in the layouts,
// and how "Split right", "Split down" and "Unsplit" rearrange them. Pure, so
// the rules are testable without the app (scripts/test-tab-links.cjs).
//
// Splitting reuses the grid every terminal tab already has: a browser,
// editor or chat tab docks into it as a cell (dock.ts), two surfaces with no
// grid get a container (splitDrop.ts), and a terminal tab moved beside
// another terminal tab hands its panes to that tab's grid. That last move
// retires the moved tab's id, so it is remembered as a MergedTab: its link
// keeps resolving to the panes it held, and Unsplit gives them back under
// the same id.

import type { TabLinkRef } from "@shared/tab-links";
import { buildDockIndex, canDockTab, collectDockLeaves, collectTerminalLeaves } from "./dock";
import { collectLeaves, findLeaf, removeLeaf } from "./paneTree";
import { canSplitDrop } from "./splitDrop";
import { isRunOwnedTab, type PaneNode, type Tab, type TabGroup, type TabId, type TerminalLeaf, type TerminalTab } from "./types";

export interface WorkspaceTabsSnapshot {
  workspaceId: string;
  tabs: readonly Tab[];
  // False for a workspace read from its saved layout, not mounted this session.
  loaded: boolean;
}

export interface MergedTab {
  tabId: TabId;
  workspaceId: string;
  hostTabId: TabId;
  // The tab's own layout when it moved, so Unsplit restores its shape.
  root: PaneNode;
  title: string;
  group?: TabGroup;
  color?: string;
}

export interface TabLinkMember {
  tabId: TabId;
  kind: Tab["kind"];
  title: string;
  dirty?: boolean;
  paneIds?: string[];
  // The terminal tab whose grid shows it.
  dockedIn?: TabId;
  mergedInto?: TabId;
}

export interface TabLinkResolution {
  workspaceId: string;
  loaded: boolean;
  kind: TabLinkRef["kind"];
  group?: { id: string; name: string };
  tabs: TabLinkMember[];
}

function member(tab: Tab, dockedIn: TabId | undefined): TabLinkMember {
  return {
    tabId: tab.id,
    kind: tab.kind,
    title: tab.title,
    ...(tab.kind === "editor" && tab.dirty ? { dirty: true } : {}),
    ...(tab.kind === "terminal" ? { paneIds: collectTerminalLeaves(tab.root).map((leaf) => leaf.paneId) } : {}),
    ...(dockedIn ? { dockedIn } : {}),
  };
}

function mergedMember(merged: MergedTab, tabs: readonly Tab[]): TabLinkMember | null {
  const host = tabs.find((tab): tab is TerminalTab => tab.id === merged.hostTabId && tab.kind === "terminal");
  if (!host) return null;
  const paneIds = collectLeaves(merged.root)
    .map((leaf) => leaf.paneId)
    .filter((paneId) => findLeaf(host.root, paneId));
  if (paneIds.length === 0) return null;
  return { tabId: merged.tabId, kind: "terminal", title: merged.title, paneIds, mergedInto: host.id };
}

// The tabs a link names, or null when its workspace or tab is gone. A group
// with no members left is gone too.
export function resolveTabLink(
  layouts: readonly WorkspaceTabsSnapshot[],
  ref: TabLinkRef,
  merged: ReadonlyMap<TabId, MergedTab> = new Map(),
): TabLinkResolution | null {
  const layout = layouts.find((item) => item.workspaceId === ref.workspaceId);
  if (!layout) return null;
  const docked = buildDockIndex(layout.tabs as Tab[]);
  const base = { workspaceId: layout.workspaceId, loaded: layout.loaded, kind: ref.kind };
  if (ref.kind === "tab") {
    const tab = layout.tabs.find((item) => item.id === ref.id);
    if (tab) return { ...base, tabs: [member(tab, docked.get(tab.id)?.hostTabId)] };
    const alias = merged.get(ref.id);
    const aliasMember = alias && alias.workspaceId === ref.workspaceId ? mergedMember(alias, layout.tabs) : null;
    return aliasMember ? { ...base, tabs: [aliasMember] } : null;
  }
  const members = layout.tabs.filter((tab) => tab.group?.id === ref.id);
  if (members.length === 0) return null;
  const group = members[0].group!;
  return {
    ...base,
    group: { id: group.id, name: group.name },
    tabs: members.map((tab) => member(tab, docked.get(tab.id)?.hostTabId)),
  };
}

export type SplitDirection = "right" | "down";

export function splitPlacement(direction: SplitDirection): { direction: "horizontal" | "vertical"; position: "after" } {
  return { direction: direction === "down" ? "vertical" : "horizontal", position: "after" };
}

export type TabSplitPlan =
  // A browser, editor or chat tab takes a cell in the grid on screen.
  | { kind: "dock"; hostTabId: TabId; paneId: string }
  // A terminal tab's panes join the grid on screen.
  | { kind: "merge"; hostTabId: TabId; paneId: string }
  // Two surfaces with no grid between them get a container (splitDrop).
  | { kind: "pair"; targetId: TabId }
  | { kind: "refused"; reason: string };

// Where "Split right" or "Split down" puts `tabId`: beside the tab on screen,
// which is the one the user is looking at, never one picked from the strip.
export function planTabSplit(tabs: readonly Tab[], activeId: TabId | null, tabId: TabId): TabSplitPlan {
  const target = tabs.find((tab) => tab.id === tabId);
  if (!target) return { kind: "refused", reason: "That tab is not open." };
  if (isRunOwnedTab(target)) return { kind: "refused", reason: "That tab belongs to a chat's worker view and cannot be split." };
  const active = activeId ? tabs.find((tab) => tab.id === activeId) : undefined;
  if (!active) return { kind: "refused", reason: "No tab is on screen to split beside." };
  if (active.id === tabId) {
    return { kind: "refused", reason: "That tab is the one on screen. Show another tab first, then split this one beside it." };
  }
  if (active.kind === "terminal" && !isRunOwnedTab(active)) {
    const docked = buildDockIndex(tabs as Tab[]);
    const ownCell = docked.get(tabId);
    const anchor =
      ownCell?.hostTabId === active.id && ownCell.leafId === active.activePaneId
        ? collectLeaves(active.root).find((leaf) => leaf.paneId !== ownCell.leafId)
        : findLeaf(active.root, active.activePaneId) ?? collectLeaves(active.root)[0];
    if (!anchor) return { kind: "refused", reason: "That tab is already split there." };
    if (target.kind === "terminal") return { kind: "merge", hostTabId: active.id, paneId: anchor.paneId };
    if (!canDockTab(target)) return { kind: "refused", reason: "That kind of tab cannot be split." };
    if (target.kind === "chat") {
      for (const [dockedId] of docked) {
        if (dockedId !== tabId && tabs.find((tab) => tab.id === dockedId)?.kind === "chat") {
          return { kind: "refused", reason: "Only one chat can be in a split at a time." };
        }
      }
    }
    return { kind: "dock", hostTabId: active.id, paneId: anchor.paneId };
  }
  if (canSplitDrop(tabs as Tab[], { tabId }, active.id)) return { kind: "pair", targetId: active.id };
  return { kind: "refused", reason: "Codara cannot put these two tabs side by side. Unsplit the tab first, or show a terminal or browser tab." };
}

function insertNodeAtLeaf(
  node: PaneNode,
  paneId: string,
  direction: "horizontal" | "vertical",
  moving: PaneNode,
): PaneNode {
  if (node.kind === "leaf") {
    return node.paneId === paneId ? { kind: "split", direction, ratio: 0.5, a: node, b: moving } : node;
  }
  const a = insertNodeAtLeaf(node.a, paneId, direction, moving);
  const b = a === node.a ? insertNodeAtLeaf(node.b, paneId, direction, moving) : node.b;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

// Moves every pane of terminal tab `sourceId` beside `paneId` in terminal tab
// `hostTabId`. The panes keep their ids, so their sessions keep running.
export function mergeTerminalTabInto(
  tabs: readonly Tab[],
  sourceId: TabId,
  hostTabId: TabId,
  paneId: string,
  direction: SplitDirection,
  workspaceId: string,
): { tabs: Tab[]; merged: MergedTab } | null {
  const source = tabs.find((tab): tab is TerminalTab => tab.id === sourceId && tab.kind === "terminal");
  const host = tabs.find((tab): tab is TerminalTab => tab.id === hostTabId && tab.kind === "terminal");
  if (!source || !host || source.id === host.id || isRunOwnedTab(source) || isRunOwnedTab(host)) return null;
  if (!findLeaf(host.root, paneId)) return null;
  const root = insertNodeAtLeaf(host.root, paneId, splitPlacement(direction).direction, source.root);
  const first = collectLeaves(source.root)[0];
  const next: Tab[] = [];
  for (const tab of tabs) {
    if (tab.id === source.id) continue;
    next.push(tab.id === host.id ? { ...host, root, activePaneId: first.paneId, zoomedPaneId: null } : tab);
  }
  return {
    tabs: next,
    merged: {
      tabId: source.id,
      workspaceId,
      hostTabId: host.id,
      root: source.root,
      title: source.title,
      ...(source.group ? { group: source.group } : {}),
      ...(source.color ? { color: source.color } : {}),
    },
  };
}

// The moved tab's old shape, holding the live leaves that are still in the
// host (the user may have closed or dragged some since).
function rebuild(node: PaneNode, live: ReadonlyMap<string, TerminalLeaf>): PaneNode | null {
  if (node.kind === "leaf") return live.get(node.paneId) ?? null;
  const a = rebuild(node.a, live);
  const b = rebuild(node.b, live);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

// Gives a merged tab its panes back as a tab of its own, under its old id,
// right after the host.
export function extractMergedTab(tabs: readonly Tab[], merged: MergedTab): Tab[] | null {
  const host = tabs.find((tab): tab is TerminalTab => tab.id === merged.hostTabId && tab.kind === "terminal");
  if (!host || tabs.some((tab) => tab.id === merged.tabId)) return null;
  const live = new Map<string, TerminalLeaf>();
  for (const leaf of collectLeaves(merged.root)) {
    const current = findLeaf(host.root, leaf.paneId);
    if (current) live.set(leaf.paneId, current);
  }
  const restored = rebuild(merged.root, live);
  if (!restored) return null;
  let hostRoot: PaneNode | null = host.root;
  for (const paneId of live.keys()) hostRoot = hostRoot ? removeLeaf(hostRoot, paneId) : null;
  const extracted: TerminalTab = {
    id: merged.tabId,
    kind: "terminal",
    title: merged.title,
    root: restored,
    activePaneId: collectLeaves(restored)[0].paneId,
    ...(merged.group ? { group: merged.group } : {}),
    ...(merged.color ? { color: merged.color } : {}),
  };
  const next: Tab[] = [];
  for (const tab of tabs) {
    if (tab.id !== host.id) {
      next.push(tab);
      continue;
    }
    if (hostRoot) {
      const leaves = collectLeaves(hostRoot);
      next.push({
        ...host,
        root: hostRoot,
        activePaneId: findLeaf(hostRoot, host.activePaneId) ? host.activePaneId : leaves[0].paneId,
        zoomedPaneId: host.zoomedPaneId && findLeaf(hostRoot, host.zoomedPaneId) ? host.zoomedPaneId : null,
      });
    }
    next.push(extracted);
  }
  return next;
}

export type TabUnsplitPlan =
  | { kind: "unsplit"; undock: TabId[]; extract: TabId[] }
  | { kind: "refused"; reason: string };

// What "Unsplit" undoes for `tabId`: a docked tab goes back to the strip, a
// merged terminal tab gets its panes back, and a grid that holds either
// releases all of them.
export function planTabUnsplit(
  tabs: readonly Tab[],
  tabId: TabId,
  merged: ReadonlyMap<TabId, MergedTab> = new Map(),
): TabUnsplitPlan {
  const docked = buildDockIndex(tabs as Tab[]);
  if (docked.has(tabId)) return { kind: "unsplit", undock: [tabId], extract: [] };
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab) {
    const alias = merged.get(tabId);
    if (alias && mergedMember(alias, tabs)) return { kind: "unsplit", undock: [], extract: [tabId] };
    return { kind: "refused", reason: "That tab is not open." };
  }
  if (tab.kind === "terminal") {
    const undock = collectDockLeaves(tab.root).map((leaf) => leaf.content.tabId);
    const extract = [...merged.values()]
      .filter((alias) => alias.hostTabId === tab.id && mergedMember(alias, tabs))
      .map((alias) => alias.tabId);
    if (undock.length > 0 || extract.length > 0) return { kind: "unsplit", undock, extract };
  }
  return { kind: "refused", reason: "That tab is not in a split." };
}

