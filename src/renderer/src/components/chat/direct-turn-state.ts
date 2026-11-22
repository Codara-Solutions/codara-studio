import type { ChatWorker } from "./timeline";

// Its own module so it loads with the direct turn's lazy chunk, not the entry.

/** What a direct turn's head says (DirectTurn.tsx). A blocked worker is
 *  asking the user a question: the turn waits, it did not fail, and only
 *  while that question is open; the answer starts a new pass, and this one
 *  then reads as finished. */
export type DirectTurnState = "starting" | "running" | "done" | "stopped" | "failed" | "blocked";

export function directTurnState(
  worker: Pick<ChatWorker, "status" | "runtimeState">,
  rowTone?: string,
  awaitingAnswer = false,
): DirectTurnState {
  if (worker.status === "accepted") return "done";
  if (worker.status === "cancelled") return "stopped";
  if (worker.status === "blocked") return awaitingAnswer ? "blocked" : "done";
  if (worker.status === "failed" || rowTone === "failed") return "failed";
  if (rowTone === "live" || worker.status === "running" || worker.runtimeState === "working") return "running";
  return "starting";
}
