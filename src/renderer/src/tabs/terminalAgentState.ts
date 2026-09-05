import type { RuntimeState } from "@shared/types";
import type { Tab, TerminalAgentSession, TerminalLeafWorker } from "./types";
import { collectLeaves } from "./paneTree";

type LiveAgentRuntime = TerminalAgentSession["runtime"];

function liveAgentRuntime(
  value: string | null | undefined,
): LiveAgentRuntime | null {
  return value === "claude" || value === "codex" || value === "grok" ? value : null;
}

export function createManualAgentLaunchWorker(
  runtime: TerminalAgentSession["runtime"],
  paneId: string,
): TerminalLeafWorker {
  return {
    runtime,
    runId: "manual",
    workerTaskId: `manual-${paneId}`,
    attemptId: paneId,
    source: "manual",
    state: "running",
    agentRunning: true,
    runtimeState: "launching",
  };
}

export function isPaneAgentInjectable(
  worker: TerminalLeafWorker | null | undefined,
  paneRuntime: { altScreenActive?: boolean } | null | undefined,
): boolean {
  return worker?.agentRunning === true && paneRuntime?.altScreenActive === true;
}

export function mergeTerminalRuntimeState(
  current: RuntimeState | undefined,
  incoming: RuntimeState,
): RuntimeState {
  if (incoming === "launching" && current && current !== "launching") {
    return current;
  }
  return incoming;
}

function isLiveRuntimeState(state: RuntimeState | undefined): boolean {
  return (
    state === "launching" ||
    state === "working" ||
    state === "blocked" ||
    state === "idle" ||
    state === "stalled" ||
    state === "error"
  );
}

/**
 * Whether the pane should still show an agent chip / tab glyph. A standing
 * terminal that once ran Claude must not keep the Claude mark after the TUI
 * has returned to a shell prompt — the durable `agentSession` pointer stays
 * for resume, but it is not "running now".
 */
export function visibleWorkerChip(
  worker: TerminalLeafWorker | null | undefined,
): TerminalLeafWorker | null {
  if (!worker) return null;
  if (worker.agentRunning === false) return null;
  if (worker.source === "spark") {
    if (worker.state === "done" && worker.agentRunning !== true) return null;
    return worker;
  }
  if (worker.source === "manual") {
    return worker.state === "running" || isLiveRuntimeState(worker.runtimeState)
      ? worker
      : null;
  }
  return null;
}

/** Agent family to paint on a tab while that agent is actually in the pane. */
export function liveTerminalRuntime(
  worker: TerminalLeafWorker | null | undefined,
): LiveAgentRuntime | null {
  const chip = visibleWorkerChip(worker);
  return chip ? liveAgentRuntime(chip.runtime) : null;
}

export function terminalAgentCensus(
  tabs: readonly Tab[],
  detectedAgents: Readonly<Record<string, true>> = {},
  detectedWorking: Readonly<Record<string, true>> = {},
): { total: number; working: number } {
  const agents = new Set(Object.keys(detectedAgents));
  const working = new Set(Object.keys(detectedWorking));
  for (const tab of tabs) {
    if (tab.kind !== "terminal") continue;
    collectLeaves(tab.root).forEach((leaf) => {
      const worker = leaf.worker;
      if (!worker) return;
      if (worker.source === "spark" || worker.agentRunning === false) {
        agents.delete(leaf.paneId);
        working.delete(leaf.paneId);
        return;
      }
      // Hydration strips transient workers. A saved resume pointer alone
      // cannot prove the CLI launched, but a live chip must count immediately.
      if (!liveTerminalRuntime(worker)) return;
      agents.add(leaf.paneId);
      if (worker.runtimeState === "working") working.add(leaf.paneId);
      else if (worker.runtimeState) working.delete(leaf.paneId);
    });
  }
  for (const paneId of working) agents.add(paneId);
  return { total: agents.size, working: working.size };
}
