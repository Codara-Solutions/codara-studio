import { collectLeaves } from "../../tabs/paneTree";
import { isRunOwnedTab } from "../../tabs/types";
import type { JumpSources, JumpTarget } from "./jump-model";

// Ctrl+Tab and Ctrl+Shift+Tab step through terminal panes in the order they
// sit on screen: a tab's panes left to right (top to bottom in a vertical
// split), then the next terminal tab along the strip. Ctrl+Tab stays in the
// workspace and wraps; Ctrl+Shift+Tab carries on into the next workspace in
// rail order. Chats, editors and browsers are skipped, and so are Cora worker
// tabs and the tabs folded into a collapsed group, as in tab cycling. Pure,
// so scripts/test-terminal-switch.cjs covers it without React.

export type TerminalSwitchScope = "workspace" | "all";

export interface TerminalStop extends JumpTarget {
  tabId: string;
  paneId: string;
  /** The tab's position in its workspace's strip. */
  tabIndex: number;
}

export function terminalStops(sources: JumpSources, scope: TerminalSwitchScope): TerminalStop[] {
  const layoutByWorkspace = new Map(sources.layouts.map((layout) => [layout.workspaceId, layout]));
  const out: TerminalStop[] = [];
  for (const workspace of sources.workspaces) {
    if (scope === "workspace" && workspace.id !== sources.activeWorkspaceId) continue;
    const layout = layoutByWorkspace.get(workspace.id);
    (layout?.tabs ?? []).forEach((tab, tabIndex) => {
      if (tab.kind !== "terminal" || isRunOwnedTab(tab)) return;
      if (tab.group?.collapsed && tab.id !== layout?.activeTabId) return;
      // A cell can hold a docked editor or browser tab; only shells count.
      for (const leaf of collectLeaves(tab.root)) {
        if (leaf.content?.type === "tab") continue;
        out.push({ workspaceId: workspace.id, tabId: tab.id, paneId: leaf.paneId, tabIndex });
      }
    });
  }
  return out;
}

/**
 * The stop after the pane on screen. From a chat, editor or browser tab it is
 * the first terminal to its right in the same workspace, else the first one
 * in a later workspace in rail order. Null when there is nowhere else to go.
 */
export function nextTerminalStop(sources: JumpSources, scope: TerminalSwitchScope): TerminalStop | null {
  const stops = terminalStops(sources, scope);
  if (stops.length === 0) return null;
  const workspaceId = sources.activeWorkspaceId;
  // A later layout for the same workspace is the live one.
  let layout: JumpSources["layouts"][number] | undefined;
  for (const item of sources.layouts) if (item.workspaceId === workspaceId) layout = item;
  const activeIndex = layout?.tabs.findIndex((tab) => tab.id === layout?.activeTabId) ?? -1;
  const activeTab = activeIndex >= 0 ? layout?.tabs[activeIndex] : undefined;
  const activePaneId = activeTab?.kind === "terminal" ? activeTab.activePaneId : null;

  const at = stops.findIndex((stop) => stop.workspaceId === workspaceId && stop.paneId === activePaneId);
  if (at >= 0) return stops.length > 1 ? stops[(at + 1) % stops.length] : null;
  // From a docked editor or browser cell: the next shell along its own tab.
  if (activeTab?.kind === "terminal") {
    const leaves = collectLeaves(activeTab.root);
    const after = new Set(leaves.slice(leaves.findIndex((leaf) => leaf.paneId === activePaneId) + 1).map((leaf) => leaf.paneId));
    const inTab = stops.find((stop) => stop.tabId === activeTab.id && after.has(stop.paneId));
    if (inTab) return inTab;
  }
  const right = stops.findIndex((stop) => stop.workspaceId === workspaceId && stop.tabIndex > activeIndex);
  if (right >= 0) return stops[right];
  // Past the workspace's last terminal, or in a workspace with none: on along
  // the rail from this workspace's place, wrapping only past the rail's end.
  const here = sources.workspaces.findIndex((workspace) => workspace.id === workspaceId);
  const later = new Set(sources.workspaces.slice(here + 1).map((workspace) => workspace.id));
  return stops.find((stop) => later.has(stop.workspaceId)) ?? stops[0];
}
