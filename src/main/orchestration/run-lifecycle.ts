import type { RunBlocker, RunState } from "@shared/types";
import type { AppendEventInput } from "./event-log";

export interface RunStatusTransitionInput {
  run: RunState;
  previousStatus: RunState["status"];
  previousBlocker?: RunBlocker;
  openQuestionMessageId?: string;
  timestamp: string;
  causeType: string;
  causeEventId: string;
  causeMessage: string;
  eventId: string;
  stepId?: string;
  workerTaskId?: string;
  sparkCallId?: string;
}

/** Build the one canonical lifecycle record for an actual persisted status
 * transition. Returning null for no-ops keeps status re-emits out of both the
 * journal and the notification adapter. */
export function buildRunStatusTransitionEvent(
  input: RunStatusTransitionInput,
): AppendEventInput | null {
  const { run, previousStatus } = input;
  if (previousStatus === run.status) return null;

  const blocker = run.blockedOn ?? input.previousBlocker;
  const questionMessageId = blocker?.questionMessageId ?? input.openQuestionMessageId;

  return {
    id: input.eventId,
    timestamp: input.timestamp,
    workspaceId: run.workspaceId,
    runId: run.id,
    stepId: input.stepId,
    workerTaskId: input.workerTaskId,
    sparkCallId: input.sparkCallId,
    type: "run.status_updated",
    message: input.causeMessage,
    payload: {
      previousStatus,
      status: run.status,
      nextStatus: run.status,
      reason: input.causeMessage,
      causeType: input.causeType,
      causeEventId: input.causeEventId,
      automationId: run.automationId,
      currentStepId: run.currentStepId,
      questionMessageId,
      blocker: blocker
        ? {
            questionMessageId: blocker.questionMessageId,
            category: blocker.category,
            source: blocker.source,
            resumeStrategy: blocker.resumeStrategy,
            previousStatus: blocker.previousStatus,
            resumeStatus: blocker.resumeStatus,
            managerMode: blocker.managerMode,
            blockedAt: blocker.blockedAt,
          }
        : undefined,
    },
  };
}
