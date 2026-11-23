import { terminalAgentPlacement } from "@shared/agent-board";
import type { TerminalAgentRuntime } from "@shared/types";
import { collectLeaves, findLeaf } from "./paneTree";
import { liveTerminalRuntime } from "./terminalAgentState";
import type { Tab, TerminalLeaf } from "./types";

// Whether a close the user asked for would stop an agent mid-work, and what
// the question says (DESIGN.md, "Closing a working agent"). Working reads the
// pane state the tab chip, the Agents view and the rail's running count read
// (terminalAgentPlacement over leaf.worker, then main's working flag), plus
// an agent waiting on the user's answer. Idle, finished, starting and
// sleeping agents, plain shells and every other tab kind close without one.

export type ClosingAgentState = "working" | "waiting";

export interface ClosingAgent {
  paneId: string;
  runtime: TerminalAgentRuntime | null;
  tabTitle: string;
  state: ClosingAgentState;
}

/** A whole tab, or one pane of a terminal tab. */
export interface CloseTarget {
  tabId: string;
  paneId?: string;
}

export interface CloseConfirmText {
  title: string;
  text: string;
  /** One line per agent when more than one would stop. */
  items: string[];
}

const RUNTIME_NAME: Record<TerminalAgentRuntime, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  pi: "Pi",
  antigravity: "Antigravity",
};

export function closingAgentState(
  leaf: TerminalLeaf,
  workingPaneIds?: Readonly<Record<string, true>>,
): ClosingAgentState | null {
  if (leaf.content?.type === "tab" || leaf.hibernation) return null;
  const worker = leaf.worker;
  const runtimeState = worker?.runtimeState;
  if (liveTerminalRuntime(worker) && runtimeState) {
    if (runtimeState === "blocked") return "waiting";
    // "launching" is the placement's Starting: nothing has begun that a
    // close would cut off.
    if (runtimeState === "launching") return null;
    return terminalAgentPlacement(runtimeState).bucket === "working" ? "working" : null;
  }
  return workingPaneIds?.[leaf.paneId] && worker?.agentRunning !== false ? "working" : null;
}

export function closingAgents(
  tabs: readonly Tab[],
  targets: readonly CloseTarget[],
  workingPaneIds?: Readonly<Record<string, true>>,
): ClosingAgent[] {
  const out: ClosingAgent[] = [];
  for (const target of targets) {
    const tab = tabs.find((item) => item.id === target.tabId);
    if (!tab || tab.kind !== "terminal") continue;
    const leaves = target.paneId
      ? [findLeaf(tab.root, target.paneId)].filter((leaf): leaf is TerminalLeaf => leaf !== null)
      : collectLeaves(tab.root);
    for (const leaf of leaves) {
      const state = closingAgentState(leaf, workingPaneIds);
      if (!state) continue;
      out.push({
        paneId: leaf.paneId,
        runtime: liveTerminalRuntime(leaf.worker),
        tabTitle: tab.title || "terminals",
        state,
      });
    }
  }
  return out;
}

/** The tabs closeOthers removes: everything but the kept tab, chats and run workers. */
export function closeOthersTargets(tabs: readonly Tab[], keepId: string): CloseTarget[] {
  if (!tabs.some((tab) => tab.id === keepId)) return [];
  return tabs
    .filter((tab) => tab.id !== keepId && tab.kind !== "chat" && !(tab.kind === "terminal" && tab.scope?.kind === "workers"))
    .map((tab) => ({ tabId: tab.id }));
}

function agentName(agent: ClosingAgent): string {
  return agent.runtime ? RUNTIME_NAME[agent.runtime] : "the agent";
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The question for a close that would stop these agents, or null to close at once. */
export function closeConfirmText(agents: readonly ClosingAgent[]): CloseConfirmText | null {
  if (agents.length === 0) return null;
  if (agents.length === 1) {
    const agent = agents[0];
    return {
      title: `Close ${agentName(agent)} in ${agent.tabTitle}?`,
      text: agent.state === "waiting"
        ? "It is waiting for your answer and its work will stop."
        : "It is still working and its work will stop.",
      items: [],
    };
  }
  return {
    title: `Close ${agents.length} working agents?`,
    text: agents.every((agent) => agent.state === "waiting")
      ? "They are waiting for your answer and their work will stop."
      : "They are still working and their work will stop.",
    items: agents.map((agent) =>
      `${capitalized(agentName(agent))} in ${agent.tabTitle}${agent.state === "waiting" ? " (waiting for you)" : ""}`,
    ),
  };
}
