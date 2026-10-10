// Questions the run store asks the user about worker outcomes when no Cora turn
// is live to decide for itself.
//
// The unverified-completion question resolves LOCALLY in answerRunQuestion
// (run-store's maybeApplyUnverifiedCompletionAnswer): a click on one of its
// canned options either finishes the run as unverified or launches a check,
// with no manager turn in between. The option ids are contract: the check id
// marks the question as this one, and the parser below decides which choice,
// if any, an answer carries. Free text falls through to the manager.
//
// Pure and dependency-light so the parser can be pinned in a node harness
// without bundling the run store.

import type { SparkManagerQuestionOption } from "./manager-protocol";

export const UNVERIFIED_COMPLETION_QUESTION =
  "The changes are written, but nothing has checked them yet, so I haven't marked this done. Should I check them now, or are you happy to use them as they are?";

export const UNVERIFIED_CHECK_OPTION_ID = "check_changes_now";
export const UNVERIFIED_ACCEPT_OPTION_ID = "use_changes_as_is";

export const UNVERIFIED_COMPLETION_OPTIONS: SparkManagerQuestionOption[] = [
  {
    id: UNVERIFIED_CHECK_OPTION_ID,
    label: "Check it now",
    description: "Have an independent worker test the final changes before finishing.",
    answer: "Check the changes now.",
    recommended: true,
  },
  {
    id: UNVERIFIED_ACCEPT_OPTION_ID,
    label: "Use it as is",
    description: "Finish now. The run is marked as not checked.",
    answer: "Use the changes as they are, without a check.",
    recommended: false,
  },
];

export type UnverifiedCompletionChoice = "check" | "accept";

/**
 * Which choice, if any, an answer to the unverified-completion question
 * carries. Only the canned option counts (its id, or text that is exactly or
 * begins with its answer sentence, which is what a click submits), for the same
 * negation reason parseManualReviewVerdict gives.
 */
export function parseUnverifiedCompletionChoice(
  answerText: string,
  options: ReadonlyArray<Pick<SparkManagerQuestionOption, "id" | "answer">> | undefined,
): UnverifiedCompletionChoice | null {
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
  if (matches(UNVERIFIED_ACCEPT_OPTION_ID)) return "accept";
  if (matches(UNVERIFIED_CHECK_OPTION_ID)) return "check";
  return null;
}

// Asked when a worker failed or stopped short and no manager turn is live. The
// answer goes to Cora's next turn as ordinary text, so these stay plain
// choices rather than locally applied verdicts.
export const UNFINISHED_WORKER_OPTIONS: SparkManagerQuestionOption[] = [
  {
    id: "retry_unfinished_worker",
    label: "Try again",
    description: "Run the unfinished work again.",
    answer: "Try the unfinished work again.",
    recommended: true,
  },
  {
    id: "change_unfinished_approach",
    label: "Change the approach",
    description: "Rework the plan based on what went wrong, then run it.",
    answer: "Change the approach for the unfinished work based on what went wrong, then run it.",
    recommended: false,
  },
  {
    id: "keep_finished_work",
    label: "Stop here",
    description: "Keep what is done and wrap up.",
    answer: "Stop here: keep the work that is done and summarize what is left.",
    recommended: false,
  },
];
