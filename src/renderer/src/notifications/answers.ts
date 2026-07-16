import { makeId } from "@shared/ids";
import type { RunQuestionOption } from "@shared/types";

// One-click answer flow shared by toasts and the notification center. The main
// process owns blocker clearing and resume strategy, including the direct-Loom
// seam where the run must remain blocked until the loop driver consumes it.
export async function answerRunQuestion(
  runId: string,
  option: RunQuestionOption,
  questionMessageId: string,
): Promise<void> {
  await window.spark.orchestration.answerRunQuestion({
    runId,
    questionMessageId,
    clientMessageId: makeId("client-msg"),
    message: option.answer,
  });
}
