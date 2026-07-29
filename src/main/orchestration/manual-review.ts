// The human-review escalation contract for manual-runtime workers.
//
// A manual task has no manager to review it (it exists precisely because the
// manager yielded no decision), so when its report lands needs_review the run
// escalates to the user with these options, and the linked answer applies the
// verdict LOCALLY in answerRunQuestion (run-store's
// maybeApplyManualReviewAnswer). The option ids are contract, not cosmetics:
// the accept id marks the question as this escalation, and the parser below
// decides which verdict, if any, an answer carries.
//
// Pure and dependency-light so the parser's negation behavior can be pinned in
// a node harness without bundling the run store.

import type { SparkManagerQuestionOption } from "./manager-protocol";

export const MANUAL_REVIEW_ACCEPT_OPTION_ID = "accept_manual_report";
export const MANUAL_REVIEW_FAIL_OPTION_ID = "fail_manual_task";

export const MANUAL_REVIEW_QUESTION_OPTIONS: SparkManagerQuestionOption[] = [
  {
    id: MANUAL_REVIEW_ACCEPT_OPTION_ID,
    label: "Accept report",
    description: "Mark the worker's report accepted and continue the run.",
    answer: "Accept the manual worker's report.",
    recommended: true,
  },
  {
    id: MANUAL_REVIEW_FAIL_OPTION_ID,
    label: "Fail the task",
    description: "Record the task as failed; the run reports it honestly.",
    answer: "Reject the manual worker's report and fail the task.",
    recommended: false,
  },
];

export type ManualReviewVerdict = "accept" | "fail";

/**
 * Which verdict, if any, an answer to the manual-review question carries.
 *
 * Deliberately strict: only the CANNED option earns a local verdict - the
 * option id itself, or text that is exactly (or begins with) the option's
 * answer sentence, which is what the question UI submits on a click. Anything
 * else is free text and returns null so it falls through to the normal
 * manager path. Keyword matching was negation-blind ("Don't accept this"
 * parsed as accept and could complete a run green), so no bag-of-words
 * shortcut is acceptable here.
 */
export function parseManualReviewVerdict(
  answerText: string,
  options: ReadonlyArray<Pick<SparkManagerQuestionOption, "id" | "answer">> | undefined,
): ManualReviewVerdict | null {
  const normalized = answerText.trim().toLowerCase();
  if (!normalized) return null;
  const matches = (optionId: string): boolean => {
    if (normalized === optionId) return true;
    const canned = (options ?? [])
      .find((option) => option.id === optionId)
      ?.answer?.trim()
      .toLowerCase();
    if (!canned) return false;
    return normalized === canned || normalized.startsWith(canned);
  };
  if (matches(MANUAL_REVIEW_FAIL_OPTION_ID)) return "fail";
  if (matches(MANUAL_REVIEW_ACCEPT_OPTION_ID)) return "accept";
  return null;
}
