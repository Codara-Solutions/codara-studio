import type { RunState } from "@shared/types";

export type CoraView = "chat" | "terminal" | "whiteboard" | "board";

/**
 * True for a run that exists but has never had a conversation: created by the
 * board's draft-promotion path (a card on a draft chat mints the run without
 * starting autopilot) or by a bare createRun. Such a chat still shows the
 * welcome state on its Chat pill, and the composer's first send starts the
 * manager on THIS run instead of minting a sibling.
 */
export function isUnstartedChatRun(run: RunState): boolean {
  return (
    run.status === "idle" &&
    run.humanMessages.length === 0 &&
    run.steps.length === 0 &&
    run.workerTasks.length === 0
  );
}
