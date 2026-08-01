// When a user message must lift a paused run.
//
// Split out of run-store.ts so the decision is a pure predicate the test
// harness can exercise without electron/pty/git (see
// scripts/test-user-message-resume.cjs). This module imports ONLY types, so
// esbuild erases every import and the bundle is dependency-free.

import type { RunConversationMessageIntent, RunState } from "@shared/types";

/** The run fields the decision reads. */
export type ResumeCandidateRun = Pick<
  RunState,
  "status" | "executionMode" | "blockedOn"
>;

/**
 * True when a user message that just landed should resume the run.
 *
 * Sending into a paused run IS resuming it: the user paused, typed, and hit
 * send, which says "continue, with this". Before this predicate existed the
 * message was recorded and nothing happened — the steering followup returns
 * early while paused and only resumeRun consumes the queue, so the text sat
 * unread until the user found the Resume button (run-msa0s2t6-sz26w1).
 *
 * The four exclusions are all "someone else owns the next move":
 *   - direct/loom runs: the loop driver decides what runs next.
 *   - answers: an answered question resumes through answerRunQuestion's own
 *     continuation (schedulePendingManagerResume).
 *   - any status other than paused: a live run already has a turn to queue
 *     behind, a terminal run is revived by addRunMessage's own branch, and a
 *     cancelled run stays cancelled.
 *   - a run holding an open question (blockedOn): the question owns the run
 *     until it is answered, whatever the status says.
 *
 * "paused" deliberately covers BOTH a user force-pause and a run parked by the
 * manager-turn failure policy (provider overload, billing): both are waiting on
 * a human, and in both the human just spoke.
 */
export function shouldResumeForUserMessage(
  run: ResumeCandidateRun,
  intent: RunConversationMessageIntent,
): boolean {
  if (run.executionMode === "direct") return false;
  if (intent !== "turn" && intent !== "steer") return false;
  if (run.status !== "paused") return false;
  if (run.blockedOn) return false;
  return true;
}
