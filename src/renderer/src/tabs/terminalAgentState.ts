import type { RuntimeState } from "@shared/types";
import type { TerminalAgentSession, TerminalLeafWorker } from "./types";

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
