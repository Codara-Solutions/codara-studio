// Agent hibernation, renderer side (pure part). Finished, untouched agent
// terminals are stopped after the idle time set in Settings, and resumed
// when the user asks for them.
// Main makes the decision (src/main/agent-hibernation.ts); this module picks
// which panes to ask about and gives the rest of the UI (rail, Agents view)
// one way to read the sleeping state off a layout. useAgentHibernation.ts
// runs the timer.
//
// Dep-free on purpose (no React, no window) so the node test harness
// scripts/test-agent-hibernation-policy.cjs can bundle it.

import { isAgentHibernationRuntime, type AgentHibernationPlacement } from "@shared/agent-hibernation";
import { collectLeaves } from "../tabs/paneTree";
import type { Tab, TerminalAgentSession, TerminalLeaf } from "../tabs/types";

export interface HibernationCandidate {
  workspaceId: string;
  tabId: string;
  paneId: string;
  session: TerminalAgentSession;
  placement: AgentHibernationPlacement;
}

/** What is on screen: the workspace shown, its active tab and the pane with the keyboard. */
export interface HibernationView {
  activeWorkspaceId: string | null;
  activeTabId: string | null;
  focusedPaneId: string | null;
}

/** True while Codara has this pane's agent stopped to save memory. */
export function isLeafSleeping(leaf: Pick<TerminalLeaf, "hibernation">): boolean {
  return Boolean(leaf.hibernation);
}

/** Sleeping agent panes in one workspace layout (for the rail and Agents view). */
export function sleepingPaneIds(tabs: readonly Tab[]): string[] {
  const ids: string[] = [];
  for (const tab of tabs) {
    if (tab.kind !== "terminal") continue;
    for (const leaf of collectLeaves(tab.root)) {
      if (isLeafSleeping(leaf)) ids.push(leaf.paneId);
    }
  }
  return ids;
}

/** The pane that has the keyboard: the active pane of the active terminal tab. */
export function focusedTerminalPaneId(tabs: readonly Tab[], activeTabId: string | null): string | null {
  const tab = tabs.find((candidate) => candidate.id === activeTabId);
  return tab && tab.kind === "terminal" ? tab.activePaneId ?? null : null;
}

/** The panes of the active tab: on screen right now, so shown (and touched). */
export function visibleTerminalPaneIds(tabs: readonly Tab[], activeTabId: string | null): string[] {
  const tab = tabs.find((candidate) => candidate.id === activeTabId);
  return tab && tab.kind === "terminal" ? collectLeaves(tab.root).map((leaf) => leaf.paneId) : [];
}

// Chip states that say the agent is in the middle of something. Main judges
// from its own evidence anyway; this only saves it a pointless request.
// "launching" is left out on purpose: a restored pane's leaf keeps it after
// the agent settled while its workspace was hidden, so it proves nothing.
const BUSY_CHIP_STATES = new Set(["working", "background", "blocked", "stalled", "error"]);

/**
 * Panes worth asking main about, in every workspace: a user-run agent (not a
 * Cora worker, not a phone pane) whose session Codara can resume, not pinned
 * awake, not already sleeping, and not the pane the user is typing in.
 * Background workspaces come first, then hidden tabs, then visible panes.
 *
 * A restored pane's one-shot `bootResume` marker does not exclude it: a pane
 * restored into a hidden workspace keeps that marker until the workspace is
 * shown, so excluding it kept every agent restored behind the active
 * workspace awake for the whole run. Main refuses a pane whose restore has
 * not spawned yet (no pty), and once it has, the resume guards
 * (autorunFiredSessions, the attach gate) stop the marker from resuming it a
 * second time.
 */
export function hibernationCandidates(
  layouts: ReadonlyArray<{ workspaceId: string; tabs: readonly Tab[] }>,
  view: HibernationView,
): HibernationCandidate[] {
  const out: HibernationCandidate[] = [];
  for (const layout of layouts) {
    const shown = layout.workspaceId === view.activeWorkspaceId;
    for (const tab of layout.tabs) {
      if (tab.kind !== "terminal" || tab.scope?.kind === "workers") continue;
      const placement: AgentHibernationPlacement = !shown
        ? "background-workspace"
        : tab.id === view.activeTabId
          ? "visible"
          : "hidden-tab";
      for (const leaf of collectLeaves(tab.root)) {
        if (shown && leaf.paneId === view.focusedPaneId) continue;
        const session = leaf.agentSession;
        if (!session?.sessionId || session.active !== true) continue;
        if (!isAgentHibernationRuntime(session.runtime)) continue;
        if (leaf.keepAwake === true || leaf.hibernation) continue;
        if (leaf.origin?.kind === "phone") continue;
        if (leaf.worker?.source === "spark") continue;
        if (leaf.worker?.runtimeState && BUSY_CHIP_STATES.has(leaf.worker.runtimeState)) continue;
        out.push({ workspaceId: layout.workspaceId, tabId: tab.id, paneId: leaf.paneId, session, placement });
      }
    }
  }
  const order: Record<AgentHibernationPlacement, number> = { "background-workspace": 0, "hidden-tab": 1, visible: 2 };
  return out.sort((a, b) => order[a.placement] - order[b.placement]);
}
