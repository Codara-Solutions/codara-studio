import { makeId } from "@shared/ids";
import type { RunQuestionOption } from "@shared/types";

// One-click answer flow for a blocked run, shared by the toast cards and the
// notification center. Records the answer as a user message; `resume` is
// false for loom-owned runs (the loop driver's answer seam consumes the
// recorded message on its own — resumeRun would re-finalize the stale
// blocked report and re-ask the question).
export async function answerRunQuestion(
  runId: string,
  option: RunQuestionOption,
  resume: boolean,
): Promise<void> {
  await window.spark.orchestration.addRunMessage({
    runId,
    clientMessageId: makeId("client-msg"),
    author: "user",
    kind: "answer",
    message: option.answer,
  });
  if (resume) {
    await window.spark.orchestration.resumeRun({ runId });
  }
}
