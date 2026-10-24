// Agent hibernation, renderer side (pure part). Finished, untouched agent
// terminals in background workspaces are stopped after the idle time set in
// Settings, and resumed when the user opens the pane again. Main makes the
// decision (src/main/agent-hibernation.ts); this module picks which panes to
// ask about and gives the rest of the UI (rail, Agents view) one way to read
// the sleeping state off a layout. useAgentHibernation.ts runs the timer.
//
// Dep-free on purpose (no React, no window) so the node test harness
// scripts/test-agent-hibernation-policy.cjs can bundle it.

import { isAgentHibernationRuntime } from "@shared/agent-hibernation";
import { collectLeaves } from "../tabs/paneTree";
import type { Tab, TerminalAgentSession, TerminalLeaf } from "../tabs/types";

export interface HibernationCandidate {
  workspaceId: string;
  tabId: string;
  paneId: string;
  session: TerminalAgentSession;
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

// Chip states that say the agent is in the middle of something. Main judges
// from its own evidence anyway; this only saves it a pointless request.
// "launching" is left out on purpose: a restored pane's leaf keeps it after
// the agent settled while its workspace was hidden, so it proves nothing.
const BUSY_CHIP_STATES = new Set(["working", "background", "blocked", "stalled", "error"]);

/**
 * Panes in a background workspace that are worth asking main about: a
 * user-run agent (not a Cora worker, not a phone pane) whose session Codara
 * can resume, not pinned awake and not already sleeping.
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
  workspaceId: string,
  tabs: readonly Tab[],
): HibernationCandidate[] {
  const out: HibernationCandidate[] = [];
  for (const tab of tabs) {
    if (tab.kind !== "terminal" || tab.scope?.kind === "workers") continue;
    for (const leaf of collectLeaves(tab.root)) {
      const session = leaf.agentSession;
      if (!session?.sessionId || session.active !== true) continue;
      if (!isAgentHibernationRuntime(session.runtime)) continue;
      if (leaf.keepAwake === true || leaf.hibernation) continue;
      if (leaf.origin?.kind === "phone") continue;
      if (leaf.worker?.source === "spark") continue;
      if (leaf.worker?.runtimeState && BUSY_CHIP_STATES.has(leaf.worker.runtimeState)) continue;
      out.push({ workspaceId, tabId: tab.id, paneId: leaf.paneId, session });
    }
  }
  return out;
}

/**
 * Keep "hidden since" stamps per workspace: the active one has none, a
 * workspace that just left the screen gets `now`, and workspaces that no
 * longer exist are forgotten. Mutates and returns `stamps`.
 */
export function updateHiddenSince(
  stamps: Map<string, number>,
  activeWorkspaceId: string | null,
  inactiveWorkspaceIds: readonly string[],
  now: number,
): Map<string, number> {
  const live = new Set<string>();
  for (const id of inactiveWorkspaceIds) {
    if (id === activeWorkspaceId) continue;
    live.add(id);
    if (!stamps.has(id)) stamps.set(id, now);
  }
  for (const id of [...stamps.keys()]) {
    if (!live.has(id)) stamps.delete(id);
  }
  return stamps;
}
