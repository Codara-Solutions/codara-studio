// Worker failure taxonomy: turn the free-form error text an attempt already
// records into one of a small closed set of kinds, and derive the retry policy
// that kind earns.
//
// Before this module every failure looked identical to the retry path: an auth
// rejection, a missing binary, a one-off provider 500, and a real 90 minute
// timeout all produced the same decision, and maybeQueueCliLaunchFallback's
// single regex could only answer "environmental or not". The patterns here are
// the ones already scattered across worker-launch.ts (waitForAgentTui's launch
// markers, detectFatalWorkerRuntimeError's runtime checks), pi-runtime.ts's
// OAuth throws, and run-store.ts's interrupt regex, collected in one place so
// the policy can differ per kind:
//
//   transport / provider -> transient. Retry the SAME runtime once, fast,
//     before paying for a cross-runtime relaunch. A socket that dropped or a
//     provider 500 says nothing about the runtime itself.
//   rate_limit           -> NOT transient: the quota window outlives any fast
//     retry, so relaunching the same runtime immediately just burns another
//     attempt. Switch runtimes; the other provider's quota is independent.
//   auth / launch        -> the runtime is unusable here. Go straight to the
//     opposite runtime, which is what the code did for every failure before.
//   timeout / tool       -> keep the pre-taxonomy behaviour (switch runtime).
//   cancelled            -> control flow, never an automatic retry.
//
// Everything is additive: an unclassified failure returns undefined and the
// caller keeps its old behaviour, so runs written before this module stay
// readable and behave exactly as they did.

import type { WorkerFailureKind } from "@shared/types";

// Ordered: the first pattern that matches wins, so the more specific and more
// consequential kinds are tested before the generic ones. cancelled is first
// because a user stop can carry any other error text in the same string, and
// auth is next because an expired credential often surfaces as an "API error".
const FAILURE_PATTERNS: ReadonlyArray<readonly [WorkerFailureKind, RegExp]> = [
  [
    "cancelled",
    /worker (?:was )?interrupted|was interrupted\b|user (?:stop|pause)|force[- ]paused|run (?:was )?paused|stopped by (?:the )?user|cancelled by|aborted by (?:the )?user|SIGINT/i,
  ],
  [
    "auth",
    /not authenticated|no OAuth access token|OAuth session expired|refresh token|token (?:has )?expired|session expired|invalid api key|missing api key|no api key|api key (?:is )?(?:invalid|missing|expired)|unauthori[sz]ed|(?:status|code|error|http)[^A-Za-z0-9]{0,10}(?:401|403)\b|forbidden|authentication failed|please (?:run )?\/?login|log ?in (?:again|required)|credentials?(?: are)? (?:invalid|missing|expired)|subscription (?:required|expired)/i,
  ],
  [
    "launch",
    /is not recognized as the name of a cmdlet|CommandNotFoundException|command not found|\bENOENT\b|error: (?:unknown )?option|Unknown option|is invalid\. It must be one of|no TUI banner observed|runtime binary did not start|launch command returned to shell|failed to launch|is not installed|executable is missing|not on PATH|spawn \S+ (?:ENOENT|EACCES)|EACCES/i,
  ],
  [
    "timeout",
    /timed out|\btimeout\b|ETIMEDOUT|deadline exceeded|no response within/i,
  ],
  [
    "transport",
    /socket (?:connection|hang ?up)|connection (?:was )?(?:closed|reset|refused|aborted)|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ENOTFOUND|EAI_AGAIN|network (?:error|failure|fetch)|fetch failed|fetch\(\)|stream (?:closed|disconnected|ended) (?:unexpectedly|early)|premature close|transport (?:closed|error)|websocket/i,
  ],
  [
    // Rate limits are the one provider failure an IMMEDIATE same-runtime
    // relaunch is guaranteed to hit again: the window is minutes to hours, not
    // milliseconds. Tested before "provider" so it never lands in the
    // fast-retry bucket; the retry plan switches runtimes instead, since the
    // other provider's quota is independent.
    "rate_limit",
    /rate ?limit|(?:status|code|error|http)[^A-Za-z0-9]{0,10}429\b|too many requests|quota (?:exceeded|reached|hit)|usage limit/i,
  ],
  [
    "provider",
    /(?:status|code|error|http)[^A-Za-z0-9]{0,10}(?:500|502|503|504|529)\b|overloaded|temporarily unavailable|service unavailable|internal server error|server error|upstream error|An error occurred while processing your request|provider (?:error|turn failed)|exhausted its provider retries|API Error|runtime API error|capacity|model (?:is )?unavailable/i,
  ],
  [
    "tool",
    /tool (?:call )?(?:failed|error)|tool execution failed|extension (?:error|failed)|MCP (?:server|bridge|tool)|bridge is incompatible|failed to call tool/i,
  ],
];

/**
 * Classify one attempt's failure text. Returns undefined when the text is empty
 * or no pattern claims it, which callers must read as "unknown, behave as
 * before" rather than as "no failure".
 */
export function classifyWorkerFailure(text: string | null | undefined): WorkerFailureKind | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  for (const [kind, pattern] of FAILURE_PATTERNS) {
    if (pattern.test(trimmed)) return kind;
  }
  return undefined;
}

/** Kinds that are transient enough to earn one fast same-runtime retry. */
export function isTransientWorkerFailure(kind: WorkerFailureKind | undefined): boolean {
  return kind === "transport" || kind === "provider";
}

export type WorkerRetryAction = "retry_same_runtime" | "switch_runtime" | "no_auto_retry";

export interface WorkerFailureRetryPlan {
  kind?: WorkerFailureKind;
  action: WorkerRetryAction;
  reason: string;
}

/**
 * Maximum number of attempts on the SAME runtime for one task lineage before a
 * transient failure stops earning a fast retry and falls through to the
 * cross-runtime path. Two means: the original run, plus exactly one fast retry.
 */
export const MAX_SAME_RUNTIME_TRANSIENT_ATTEMPTS = 2;

/**
 * Decide what an environmentally failed attempt earns next.
 *
 * `sameRuntimeAttempts` counts how many tasks in this lineage (same step, same
 * title) already ran on the runtime that just failed, including the one that
 * failed. `oppositeRuntimeAvailable` says whether another installed runtime
 * exists to fall back to.
 */
export function planWorkerFailureRetry(input: {
  kind?: WorkerFailureKind;
  sameRuntimeAttempts: number;
  oppositeRuntimeAvailable: boolean;
}): WorkerFailureRetryPlan {
  const kind = input.kind;
  if (kind === "cancelled") {
    return {
      kind,
      action: "no_auto_retry",
      reason: "the attempt was stopped by the user, which is control flow rather than a runtime failure",
    };
  }

  if (isTransientWorkerFailure(kind) && input.sameRuntimeAttempts < MAX_SAME_RUNTIME_TRANSIENT_ATTEMPTS) {
    return {
      kind,
      action: "retry_same_runtime",
      reason: `transient ${kind} failure, retrying the same runtime once before switching runtimes`,
    };
  }

  if (!input.oppositeRuntimeAvailable) {
    return {
      kind,
      action: "no_auto_retry",
      reason: "no other runtime is installed to fall back to",
    };
  }

  return {
    kind,
    action: "switch_runtime",
    reason: kind
      ? `${kind} failure, the runtime cannot be trusted for this task so the opposite runtime takes over`
      : "unclassified runtime failure, falling back to the opposite runtime",
  };
}
