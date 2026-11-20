import { terminalAgentPlacement } from "@shared/agent-board";
import { buildDockIndex } from "./dock";
import { collectLeaves } from "./paneTree";
import { liveTerminalRuntime } from "./terminalAgentState";
import { isRunOwnedTab, type Tab, type TerminalLeaf } from "./types";

// The number at a rail row's right edge (DESIGN.md, "Tab counts in the
// rail"): a workspace's tabs, and how many of them run something now.

export interface RailTabCount {
  open: number;
  running: number;
}

export interface RailTabSignals {
  /** Cora runs in an active phase. A chat tab's id is its run id. */
  runningRunIds: ReadonlySet<string>;
  /** Panes main's notifier saw an agent in, idle or not. */
  agentPaneIds?: Readonly<Record<string, true>>;
  /** Panes main's notifier saw an agent working in. */
  workingPaneIds?: Readonly<Record<string, true>>;
  /** Panes whose shell is running a command (pty:shell-busy). */
  busyShellPaneIds: ReadonlySet<string>;
}

// An agent pane runs while its agent works ("working" as the agent lines mean
// it: mid-turn, in the background, quiet or starting). Its shell is busy for
// as long as the agent CLI is open, so the shell says nothing there.
function paneRunning(leaf: TerminalLeaf, signals: RailTabSignals): boolean {
  if (leaf.content?.type === "tab") {
    return leaf.content.tabKind === "chat" && signals.runningRunIds.has(leaf.content.tabId);
  }
  const worker = leaf.worker;
  if (liveTerminalRuntime(worker) && worker?.runtimeState) {
    return terminalAgentPlacement(worker.runtimeState).bucket === "working";
  }
  if (signals.workingPaneIds?.[leaf.paneId] && worker?.agentRunning !== false) return true;
  const agentPresent =
    liveTerminalRuntime(worker) !== null ||
    signals.agentPaneIds?.[leaf.paneId] === true ||
    leaf.agentSession?.active === true;
  return !agentPresent && signals.busyShellPaneIds.has(leaf.paneId);
}

/**
 * The tabs the tab bar shows for a workspace (run-owned worker and Runs tabs
 * live in the chat panel, a docked tab inside its host's grid, so neither
 * counts), and how many of them run: a Cora chat whose run is live, or a
 * terminal with a working agent or a shell running a command in any pane.
 * Browser, editor, diff and the other tabs never run.
 */
export function railTabCount(tabs: readonly Tab[], signals: RailTabSignals): RailTabCount {
  const docked = buildDockIndex(tabs as Tab[]);
  let open = 0;
  let running = 0;
  for (const tab of tabs) {
    if (isRunOwnedTab(tab) || docked.has(tab.id)) continue;
    open += 1;
    if (
      (tab.kind === "chat" && signals.runningRunIds.has(tab.id)) ||
      (tab.kind === "terminal" && collectLeaves(tab.root).some((leaf) => paneRunning(leaf, signals)))
    ) {
      running += 1;
    }
  }
  return { open, running };
}
