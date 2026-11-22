import type { ChatWorker } from "./timeline";

// Its own module so it loads with the direct turn's lazy chunk, not the entry.

/** What a direct turn's head says (DirectTurn.tsx). A blocked worker is
 *  asking the user a question: the turn waits, it did not fail. */
export type DirectTurnState = "starting" | "running" | "done" | "stopped" | "failed" | "blocked";

export function directTurnState(
  worker: Pick<ChatWorker, "status" | "runtimeState">,
  rowTone?: string,
): DirectTurnState {
  if (worker.status === "accepted") return "done";
  if (worker.status === "cancelled") return "stopped";
  if (worker.status === "blocked") return "blocked";
  if (worker.status === "failed" || rowTone === "failed") return "failed";
  if (rowTone === "live" || worker.status === "running" || worker.runtimeState === "working") return "running";
  return "starting";
}
