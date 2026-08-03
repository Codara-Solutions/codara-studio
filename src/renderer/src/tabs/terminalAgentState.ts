import type { RuntimeState } from "@shared/types";
import type { TerminalAgentSession, TerminalLeafWorker } from "./types";

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
