import type { RunState } from "@shared/types";
import type { PaneNode, Tab, TerminalLeaf } from "../tabs/types";
import type { RoutingDestination } from "./SelectionRoutingContext";

// Where a picked element, a comment on the page or a tab reference can go:
// the agent in any terminal pane of the workspace, whatever CLI it runs (a
// detected one is labelled by name, an unrecognised one is still offered as
// "Terminal"), a Cora chat, or the workspace inbox any agent can pull from.
// Pure functions of the tab tree, so the menu and its default are testable
// without React.

export interface PaneAgentState {
  /** Panes main's monitor reports an agent CLI in, including runtimes the UI has no chip for. */
  detected: Readonly<Record<string, true>>;
  /** Panes whose terminal is in a full-screen program (an agent TUI, usually). */
  altScreen: ReadonlySet<string>;
}

const RUNTIME_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  pi: "Pi",
};

export function runtimeLabel(runtime: string | null | undefined): string | null {
  if (!runtime) return null;
  return RUNTIME_NAMES[runtime] ?? runtime.charAt(0).toUpperCase() + runtime.slice(1);
}

function leaves(node: PaneNode, out: TerminalLeaf[] = []): TerminalLeaf[] {
  if (node.kind === "leaf") out.push(node);
  else {
    leaves(node.a, out);
    leaves(node.b, out);
  }
  return out;
}

export function findPaneLeaf(node: PaneNode, paneId: string): TerminalLeaf | null {
  return leaves(node).find((leaf) => leaf.paneId === paneId) ?? null;
}

/** The id the pty layer knows a leaf by: a Cora worker's attempt, otherwise the pane. */
export function leafInjectId(leaf: TerminalLeaf): string {
  return leaf.worker?.source === "spark" && leaf.worker.attemptId ? leaf.worker.attemptId : leaf.paneId;
}

export interface DeliverablePane {
  paneId: string;
  workspaceId: string;
}

/**
 * Every pane paneDestinations can offer, in every workspace layout, keyed the
 * way delivery addresses it. Main checks a send's workspace against this, so
 * it must include the Cora worker and phone-origin panes that the phone-share
 * inventory leaves out.
 */
export function deliverablePanes(layouts: ReadonlyArray<{ workspaceId: string; tabs: readonly Tab[] }>): DeliverablePane[] {
  const out: DeliverablePane[] = [];
  for (const layout of layouts) {
    for (const tab of layout.tabs) {
      if (tab.kind !== "terminal") continue;
      for (const leaf of leaves(tab.root)) {
        if (leaf.content?.type === "tab") continue;
        out.push({ paneId: leafInjectId(leaf), workspaceId: layout.workspaceId });
      }
    }
  }
  return out;
}

export interface PaneDestination extends RoutingDestination {
  kind: "pane";
  paneId: string;
  agent: boolean;
  focused: boolean;
}

/** Every terminal pane, agents first, the focused one leading its group. */
export function paneDestinations(
  tabs: readonly Tab[],
  runs: readonly RunState[],
  state: PaneAgentState,
  focusedPaneId: string | null,
): PaneDestination[] {
  const out: PaneDestination[] = [];
  let terminalIndex = 0;
  for (const tab of tabs) {
    if (tab.kind !== "terminal") continue;
    const cells = leaves(tab.root).filter((leaf) => leaf.content?.type !== "tab");
    for (const [index, leaf] of cells.entries()) {
      terminalIndex++;
      const paneId = leafInjectId(leaf);
      const worker = leaf.worker && leaf.worker.agentRunning !== false ? leaf.worker : null;
      const detected = Boolean(state.detected[leaf.paneId] || state.detected[paneId]);
      const agent = Boolean(worker) || detected || state.altScreen.has(leaf.paneId);
      const name = runtimeLabel(worker?.runtime) ?? (agent ? "Agent" : "Terminal");
      const place = cells.length > 1 ? `${tab.title} (pane ${index + 1})` : tab.title || `Terminal ${terminalIndex}`;
      const runTitle = worker?.source === "spark" ? runs.find((run) => run.id === worker.runId)?.title : undefined;
      const focused = focusedPaneId !== null && (leaf.paneId === focusedPaneId || paneId === focusedPaneId);
      out.push({
        id: `pane:${paneId}`,
        kind: "pane",
        paneId,
        agent,
        focused,
        label: `${name} · ${runTitle ?? place}`,
        sublabel: focused ? "focused" : agent ? undefined : "no agent detected",
        group: "agents",
      });
    }
  }
  const rank = (d: PaneDestination) => (d.agent ? 0 : 2) + (d.focused ? 0 : 1);
  return out.map((d, i) => ({ d, i })).sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i).map(({ d }) => d);
}

export function chatDestinations(runs: readonly RunState[], activeRunId: string | null, extraRunIds: readonly string[], hasWorkspace: boolean): RoutingDestination[] {
  const out: RoutingDestination[] = [];
  const seen = new Set<string>();
  for (const runId of [activeRunId, ...extraRunIds]) {
    if (!runId || seen.has(runId)) continue;
    const run = runs.find((candidate) => candidate.id === runId);
    if (!run) continue;
    seen.add(runId);
    out.push({ id: `chat:${runId}`, kind: "chat", runId, label: `Cora chat · ${run.title || "Untitled"}`, sublabel: runId === activeRunId ? "open" : undefined, group: "chat" });
  }
  out.push({
    id: "chat-new",
    kind: "chat-new",
    label: "New Cora chat",
    group: "chat",
    disabled: !hasWorkspace,
    disabledReason: hasWorkspace ? undefined : "Open a workspace first.",
  });
  return out;
}

export const INBOX_DESTINATION: RoutingDestination = {
  id: "inbox",
  kind: "inbox",
  label: "Agent inbox",
  sublabel: "any agent pulls it",
  group: "inbox",
};

export interface TabOwner {
  runId: string | null;
  paneId: string | null;
}

/**
 * Where a send goes unless the user picks another: the agent in the pane the
 * user was last in, then the agent that drives the tab (its pane, or its
 * Cora chat), then the only agent pane, then the open Cora chat, then the
 * inbox.
 */
export function defaultDestination(
  destinations: readonly RoutingDestination[],
  owner: TabOwner | null,
  activeRunId: string | null,
): string {
  const has = (id: string) => destinations.some((d) => d.id === id && !d.disabled);
  const panes = destinations.filter((d): d is PaneDestination => d.kind === "pane");
  const focused = panes.find((d) => d.agent && d.focused);
  if (focused) return focused.id;
  if (owner?.paneId && has(`pane:${owner.paneId}`)) return `pane:${owner.paneId}`;
  if (owner?.runId && has(`chat:${owner.runId}`)) return `chat:${owner.runId}`;
  const agents = panes.filter((d) => d.agent);
  if (agents.length === 1) return agents[0].id;
  if (activeRunId && has(`chat:${activeRunId}`)) return `chat:${activeRunId}`;
  if (agents.length) return agents[0].id;
  return INBOX_DESTINATION.id;
}
