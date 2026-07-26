import type {
  AutopilotStatus,
  HumanRunMessage,
  RunAssumption,
  RunBlocker,
  RunQuestionCategory,
  RunQuestionOption,
  RunQuestionResumeStrategy,
  RunQuestionSource,
  RunState,
  RunStatus,
  SparkCall,
} from "@shared/types";
import {
  linkedAnswerForQuestion,
  unresolvedRunQuestions,
} from "@shared/run-questions";

const QUESTION_CATEGORIES = new Set<RunQuestionCategory>([
  "credentials_access",
  "destructive_irreversible",
  "safety_policy",
  "irreducible_product_scope",
  "plan_approval",
]);

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "complete" || status === "failed" || status === "cancelled";
}

export function isRunQuestionCategory(value: unknown): value is RunQuestionCategory {
  return typeof value === "string" && QUESTION_CATEGORIES.has(value as RunQuestionCategory);
}

export const REVERSIBLE_MANAGER_DEFAULT =
  "Use the smallest reversible implementation consistent with the repository's existing conventions and tests.";

export type RunManagerQuestionDecision =
  | {
      action: "block";
      category: RunQuestionCategory;
      reason: string;
      recommendedOptionId?: string;
      signature: string;
    }
  | {
      action: "assume";
      selectedAnswer: string;
      optionId?: string;
      signature: string;
    }
  | {
      action: "protocol_error";
      error: string;
      signature: string;
    };

/** Stable identity for a manager question across retries and process restarts. */
export function normalizeRunQuestionSignature(question: string): string {
  return question
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function reversibleOptionScore(option: RunQuestionOption): number {
  const text = `${option.label} ${option.description} ${option.answer}`.toLowerCase();
  let score = 0;
  // A recommendation is a tie-breaker, never permission to choose an unsafe
  // action. Managers occasionally recommend the broad/destructive choice.
  if (option.recommended) score += 2;
  if (/\b(smallest|minimal|safe|reversible|existing|default|conservative|local|test|preview|dry run)\b/.test(text)) {
    score += 20;
  }
  if (/\b(delete|destroy|drop|purge|overwrite|publish|deploy|purchase|charge|full|broad|rewrite)\b/.test(text)) {
    score -= 100;
  }
  return score;
}

function hasIrreversibleSignal(question: string, options: RunQuestionOption[]): boolean {
  const unsafe = /\b(delete|destroy|irreversible|overwrite|drop|purge|publish|deploy|purchase|charge|production|credential|secret|token|legal|policy|unsafe)\b/;
  if (unsafe.test(question.toLowerCase())) return true;
  return options.length > 0 && options.every((option) =>
    unsafe.test(`${option.label} ${option.description} ${option.answer}`.toLowerCase()),
  );
}

function pickReversibleOption(
  options: RunQuestionOption[],
  recommendedOptionId?: string,
): RunQuestionOption | undefined {
  const normalizedId = recommendedOptionId?.trim();
  return options
    .map((option, index) => ({
      option,
      index,
      score: reversibleOptionScore(option) + (normalizedId === option.id ? 2 : 0),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]
    ?.option;
}

/** Decide whether a manager question genuinely requires a human. Missing
 * categories may describe reversible technical choices, but an unsupported
 * category or destructive signal fails closed. Explicit
 * hard blockers must carry a rationale and a usable recommendation when options
 * are offered, otherwise the manager protocol fails instead of guessing. */
export function decideRunManagerQuestion(input: {
  question: string;
  category?: unknown;
  reason?: string;
  options?: RunQuestionOption[];
  recommendedOptionId?: string;
  priorAssumptions?: RunAssumption[];
}): RunManagerQuestionDecision {
  const question = input.question.trim();
  const signature = normalizeRunQuestionSignature(question);
  if (!signature) {
    return {
      action: "protocol_error",
      error: "Manager question must contain non-empty text.",
      signature,
    };
  }

  const repeated = (input.priorAssumptions ?? []).some((assumption) =>
    assumption.signature
      ? assumption.signature === signature
      : normalizeRunQuestionSignature(assumption.question) === signature,
  );
  if (repeated) {
    return {
      action: "protocol_error",
      error: "Manager repeated a tactical question that Cora already resolved as an assumption.",
      signature,
    };
  }

  const options = (input.options ?? []).filter(
    (option) => option.answer.trim().length > 0 || option.label.trim().length > 0,
  );
  if (input.category !== undefined && !isRunQuestionCategory(input.category)) {
    return {
      action: "protocol_error",
      error: `Unsupported human-blocker category: ${String(input.category)}.`,
      signature,
    };
  }
  if (isRunQuestionCategory(input.category)) {
    const reason = input.reason?.trim() ?? "";
    if (!reason) {
      return {
        action: "protocol_error",
        error: `Human blocker ${input.category} is missing the required rationale.`,
        signature,
      };
    }
    const explicitRecommendedId = input.recommendedOptionId?.trim();
    const recommended =
      (explicitRecommendedId
        ? options.find((option) => option.id === explicitRecommendedId)
        : undefined) ?? options.find((option) => option.recommended);
    if (options.length > 0 && !recommended) {
      return {
        action: "protocol_error",
        error: `Human blocker ${input.category} offers options without a usable recommendation.`,
        signature,
      };
    }
    return {
      action: "block",
      category: input.category,
      reason,
      recommendedOptionId: recommended?.id,
      signature,
    };
  }

  if (hasIrreversibleSignal(question, options)) {
    return {
      action: "protocol_error",
      error: "Potentially irreversible or sensitive question is missing a valid human-blocker category.",
      signature,
    };
  }

  const selected = pickReversibleOption(options, input.recommendedOptionId);
  return {
    action: "assume",
    selectedAnswer:
      selected?.answer.trim() || selected?.label.trim() || REVERSIBLE_MANAGER_DEFAULT,
    optionId: selected?.id,
    signature,
  };
}

export function inferRunQuestionCategory(
  question: string,
  source: RunQuestionSource,
): RunQuestionCategory {
  if (source === "consent_gate") return "destructive_irreversible";
  const text = question.toLowerCase();
  if (/\b(api key|credential|login|log in|sign in|permission|access|token|secret|account)\b/.test(text)) {
    return "credentials_access";
  }
  if (/\b(delete|destroy|irreversible|overwrite|drop|purge|publish|deploy|charge|purchase)\b/.test(text)) {
    return "destructive_irreversible";
  }
  if (/\b(safety|policy|legal|compliance|privacy|security|harm|unsafe)\b/.test(text)) {
    return "safety_policy";
  }
  return "irreducible_product_scope";
}

export function createRunBlocker(input: {
  questionMessageId: string;
  category: RunQuestionCategory;
  currentStatus: RunStatus;
  resumeStatus?: RunStatus;
  source: RunQuestionSource;
  resumeStrategy: RunQuestionResumeStrategy;
  managerMode?: SparkCall["mode"];
  blockedAt: string;
}): RunBlocker {
  const resumeStatus = input.resumeStatus ?? fallbackResumeStatus(input.currentStatus);
  return {
    questionMessageId: input.questionMessageId,
    category: input.category,
    previousStatus: input.currentStatus,
    resumeStatus,
    source: input.source,
    resumeStrategy: input.resumeStrategy,
    managerMode: input.managerMode,
    blockedAt: input.blockedAt,
  };
}

export function applyRunQuestionBlocker(
  draft: RunState,
  blocker: RunBlocker,
  reason: string,
  timestamp: string,
): void {
  draft.blockedOn = blocker;
  draft.status = "blocked";
  draft.autopilot = {
    ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
    status: "blocked",
    lastAction: "waiting_for_user",
    stopReason: reason,
    updatedAt: timestamp,
  };
  draft.updatedAt = timestamp;
}

function autopilotStatusForRunStatus(status: RunStatus): AutopilotStatus {
  if (status === "complete" || status === "failed" || status === "cancelled") return status;
  if (status === "paused") return "paused";
  if (status === "blocked") return "blocked";
  if (status === "idle") return "idle";
  return "running";
}

function fallbackResumeStatus(status: RunStatus): RunStatus {
  if (status === "blocked" || status === "paused") return "running";
  return status;
}

export function restoreRunFromBlocker(
  draft: RunState,
  blocker: RunBlocker,
  timestamp: string,
  lastAction = "question_answered",
): void {
  delete draft.blockedOn;
  draft.status = blocker.resumeStatus;
  draft.autopilot = {
    ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
    status: autopilotStatusForRunStatus(blocker.resumeStatus),
    lastAction,
    stopReason: undefined,
    resumedAt:
      blocker.resumeStatus === "running" ||
      blocker.resumeStatus === "planning" ||
      blocker.resumeStatus === "reviewing"
        ? timestamp
        : draft.autopilot?.resumedAt,
    updatedAt: timestamp,
  };
  draft.updatedAt = timestamp;
}

/** Explicit lifecycle control owns the run after this point. Old questions stay
 * in the transcript for audit, but can no longer resume or approve anything. */
export function abandonRunQuestionOwnership(draft: RunState): void {
  delete draft.blockedOn;
  delete draft.pendingManagerResume;
}

/** Release only the exact blocker that still owns a blocked run. Disconnects or
 * timeouts racing with pause/cancel/answer become harmless no-ops. */
export function releaseRunQuestionBlocker(
  draft: RunState,
  questionMessageId: string,
  timestamp: string,
): boolean {
  const blocker = draft.blockedOn;
  if (
    draft.status !== "blocked" ||
    !blocker ||
    blocker.questionMessageId !== questionMessageId
  ) {
    return false;
  }
  restoreRunFromBlocker(draft, blocker, timestamp, "question_wait_ended");
  return true;
}

/** Lease one exact durable manager continuation immediately before scheduling
 * its stage. The record remains `launching` until a manager SparkCall carrying
 * the same claim id is durably registered, so process exit cannot lose it. */
export function claimPendingManagerResume(
  draft: RunState,
  questionMessageId: string,
  managerMode: SparkCall["mode"],
  launchClaimId: string,
  claimedAt: string,
): boolean {
  const pending = draft.pendingManagerResume;
  if (
    !pending ||
    pending.questionMessageId !== questionMessageId ||
    pending.managerMode !== managerMode ||
    draft.status === "blocked" ||
    draft.status === "paused" ||
    isTerminalRunStatus(draft.status)
  ) {
    return false;
  }
  if (pending.state === "launching") {
    return pending.launchClaimId === launchClaimId;
  }
  pending.state = "launching";
  pending.launchClaimId = launchClaimId;
  pending.launchClaimedAt = claimedAt;
  return true;
}

/** Clear a launch lease only after its exact manager call registration exists. */
export function clearRegisteredPendingManagerResume(
  draft: RunState,
  launchClaimId: string,
): boolean {
  const pending = draft.pendingManagerResume;
  if (
    !pending ||
    pending.state !== "launching" ||
    pending.launchClaimId !== launchClaimId ||
    !draft.sparkCalls.some((call) => call.managerResumeClaimId === launchClaimId)
  ) {
    return false;
  }
  delete draft.pendingManagerResume;
  return true;
}

/** Startup repair for a process that exited while a resume lease was launching.
 * A matching SparkCall proves the manager stage registered, so no duplicate is
 * launched. Without one, return the abandoned lease to `pending` for recovery. */
export function recoverPendingManagerResumeLease(
  draft: RunState,
): "none" | "pending" | "registered" {
  const pending = draft.pendingManagerResume;
  if (!pending) return "none";
  if (pending.state !== "launching") {
    pending.state = "pending";
    delete pending.launchClaimId;
    delete pending.launchClaimedAt;
    return "pending";
  }
  const claimId = pending.launchClaimId?.trim();
  if (
    claimId &&
    draft.sparkCalls.some(
      (call) => call.managerResumeClaimId === claimId && call.status === "completed",
    )
  ) {
    delete draft.pendingManagerResume;
    return "registered";
  }
  pending.state = "pending";
  delete pending.launchClaimId;
  delete pending.launchClaimedAt;
  return "pending";
}

function managerModeForQuestionResume(
  draft: RunState,
  blocker: RunBlocker,
): SparkCall["mode"] {
  if (blocker.managerMode) return blocker.managerMode;
  return draft.workerAttempts.length > 0 ? "worker_result_review" : "plan_analysis";
}

export interface ApplyRunQuestionAnswerResult {
  question: HumanRunMessage;
  blocker?: RunBlocker;
  duplicate: boolean;
}

/**
 * Validate and apply one exact linked answer. Durable blockers are authoritative:
 * a different id is rejected even if another old question is still unresolved.
 * Direct Loom report-blockers intentionally remain blocked when they have no
 * RunBlocker; the loop driver's answer seam owns their continuation.
 */
export function applyRunQuestionAnswer(
  draft: RunState,
  answer: HumanRunMessage,
  timestamp: string,
): ApplyRunQuestionAnswerResult {
  const questionMessageId = answer.answersMessageId?.trim();
  if (!questionMessageId) throw new Error("questionMessageId is required.");

  const question = draft.humanMessages.find(
    (message) =>
      message.id === questionMessageId &&
      message.author === "spark" &&
      message.kind === "question",
  );
  if (!question) throw new Error(`Run question not found: ${questionMessageId}`);

  // An explicit pause/cancel/terminal transition always wins, even over an
  // otherwise-idempotent repeat of an answer that landed just before it.
  if (draft.status === "paused" || isTerminalRunStatus(draft.status)) {
    throw new Error(`Run question is no longer active: ${questionMessageId}`);
  }

  if (draft.blockedOn && draft.blockedOn.questionMessageId !== questionMessageId) {
    throw new Error(
      `Run is blocked on question ${draft.blockedOn.questionMessageId}, not ${questionMessageId}.`,
    );
  }

  const existingAnswer = linkedAnswerForQuestion(draft.humanMessages, questionMessageId);
  if (existingAnswer) {
    if (existingAnswer.message.trim() === answer.message.trim()) {
      return { question, blocker: draft.blockedOn, duplicate: true };
    }
    throw new Error(`Run question has already been answered: ${questionMessageId}`);
  }
  if (draft.status !== "blocked") {
    throw new Error(`Run question is no longer active: ${questionMessageId}`);
  }

  const unresolved = unresolvedRunQuestions(draft.humanMessages);
  if (!unresolved.some((message) => message.id === questionMessageId)) {
    throw new Error(`Run question has already been consumed: ${questionMessageId}`);
  }

  const blocker = draft.blockedOn;
  draft.humanMessages.push({ ...answer, createdAt: timestamp });
  if (blocker) {
    restoreRunFromBlocker(draft, blocker, timestamp);
    if (blocker.resumeStrategy === "schedule_manager") {
      draft.pendingManagerResume = {
        questionMessageId,
        managerMode: managerModeForQuestionResume(draft, blocker),
        requestedAt: timestamp,
        state: "pending",
      };
    }
  } else if (draft.executionMode !== "direct") {
    // Compatibility for pre-blocker managed runs: only the newest unresolved
    // question on a still-blocked run may acquire legacy ownership.
    const openQuestion = unresolved.at(-1);
    if (openQuestion?.id !== questionMessageId) {
      draft.humanMessages.pop();
      throw new Error(`Run question is no longer active: ${questionMessageId}`);
    }
    const legacyBlocker = createRunBlocker({
      questionMessageId,
      category:
        question.questionContext?.category ??
        inferRunQuestionCategory(question.message, "manager_decision"),
      currentStatus: draft.status,
      resumeStatus: "running",
      source: question.questionContext?.source ?? "manager_decision",
      resumeStrategy: "schedule_manager",
      blockedAt: question.createdAt,
    });
    restoreRunFromBlocker(draft, legacyBlocker, timestamp);
    draft.pendingManagerResume = {
      questionMessageId,
      managerMode: managerModeForQuestionResume(draft, legacyBlocker),
      requestedAt: timestamp,
      state: "pending",
    };
    return { question, blocker: legacyBlocker, duplicate: false };
  } else {
    // Direct report-blocked Loom runs deliberately remain blocked; the loop
    // driver owns the per-node continuation after observing this linked answer.
    draft.updatedAt = timestamp;
  }
  return { question, blocker, duplicate: false };
}
