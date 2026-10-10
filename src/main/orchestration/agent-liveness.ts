// Liveness policy for the two places Cora waits on an agent: a worker turn
// (run-store's waitForPiWorkerTurn) and a manager turn (pi-backend's
// waitForSettled).
//
// Both used to wait on a single flat wall-clock timeout, and both got it wrong
// in the same run:
//
//   - The WORKER wait ended only on `agent_settled`. A Codex 500 arrived
//     mid-turn, Pi started an auto-retry that produced no further events, and
//     the settle never came. The wait sat there for 16 minutes while the pane
//     kept claiming "working", and nothing in the product said otherwise.
//   - The MANAGER wait capped the whole turn at 90 minutes. A manager
//     legitimately spends most of a turn blocked inside codara_wait_for_workers,
//     so the cap fired on a turn that was orchestrating correctly - and the
//     failure path then force-failed the run and killed a worker three commits
//     from done.
//
// The fix in both cases is to measure SILENCE rather than duration, so the
// policy is pure and lives here where it can be tested directly. The thresholds
// are sized from recorded sessions, not taste: across 120 worker sessions
// (7906 inter-event gaps) the widest gap a healthy worker ever produced was
// 5.1 min, and p99 was 68s.

// Declared ahead of both turn policies so the worker cap can reuse it.
const PI_TURN_ABSOLUTE_CEILING_MS_VALUE = 6 * 60 * 60 * 1000;

/** Widest inter-event gap ever observed from a healthy worker, for reference. */
export const OBSERVED_HEALTHY_WORKER_GAP_MS = 5.1 * 60 * 1000;

/**
 * Silence after which a worker with NO known problem is reported stalled.
 *
 * Sized well clear of OBSERVED_HEALTHY_WORKER_GAP_MS rather than level with it.
 * This started at 5 min - exactly the widest healthy gap on record - and a
 * healthy worker tripped it on the first real run, mid-message between
 * message_update and message_end. The warning is non-destructive and
 * self-clearing so the cost was only a moment of amber, but a state that cries
 * wolf is a state people learn to ignore, which defeats the whole point.
 */
export const PI_WORKER_STALL_WARN_MS = 8 * 60 * 1000;
/**
 * Silence after which a worker that ALREADY reported a provider error is
 * reported stalled. Far shorter than the generic window because this is not a
 * guess: something demonstrably went wrong, so saying so immediately is
 * accurate rather than noisy.
 */
export const PI_WORKER_PROVIDER_FAILURE_WARN_MS = 60 * 1000;
/**
 * Silence after which a worker that already reported a provider error is
 * failed. Shorter than the generic window because there is a concrete
 * diagnosis to report; still above the widest healthy gap, so a slow retry
 * that is genuinely producing events is never cut off.
 */
export const PI_WORKER_PROVIDER_FAILURE_GRACE_MS = 6 * 60 * 1000;
/** Silence after which any worker is failed, with or without a diagnosis. */
export const PI_WORKER_STALL_FAIL_MS = 20 * 60 * 1000;
/**
 * Backstop for a worker that keeps emitting events but never finishes
 * anything: the longest it may go without completing a tool call or an
 * assistant message. Progress re-arms it. This used to be a flat 90 minutes
 * from the start of the turn, which killed long slices that were working
 * steadily and relaunched them cold on the other provider.
 */
export const PI_WORKER_NO_PROGRESS_CEILING_MS = 90 * 60 * 1000;
/** Wall-clock cap on one worker turn, matching the manager's. */
export const PI_WORKER_TURN_ABSOLUTE_CEILING_MS = PI_TURN_ABSOLUTE_CEILING_MS_VALUE;
/**
 * How long a worker that reached the absolute cap gets to hand in a partial
 * report after being asked to wrap up, before it is stopped.
 */
export const PI_WORKER_WRAP_UP_GRACE_MS = 15 * 60 * 1000;

export const PI_WORKER_WRAP_UP_PROMPT =
  "You have reached the time limit for one worker turn. Stop starting new work now. " +
  'Write your final-report.json at the path from your task prompt with status "partial": ' +
  "put what is done in summary and proof, and everything still left to do in followups, " +
  "so the next worker can continue from it instead of starting over. Then end your turn.";

const WORKER_TURN_CEILING_FAILURE = /while still making progress/i;

/** True for the failure a worker that was still working gets at the cap. */
export function isWorkerTurnCeilingFailure(message: string | null | undefined): boolean {
  return typeof message === "string" && WORKER_TURN_CEILING_FAILURE.test(message);
}

export type WorkerTurnCeilingAction = "continue" | "wrap_up" | "fail";

/**
 * Decide what a worker turn's age earns. A turn that keeps finishing tool calls
 * and messages runs until the absolute cap; there it is asked once to wrap up
 * with a partial report and given a grace period. Only a worker that stopped
 * making progress, or ignored the wrap-up, is failed. Both failure texts read
 * as a timeout to the failure taxonomy; the cap one also says the worker was
 * still making progress, so the retry path never treats it as a stall.
 */
export function classifyWorkerTurnCeiling(input: {
  now: number;
  startedAt: number;
  lastProgressAt: number;
  wrapUpRequestedAt: number | null;
}): { action: WorkerTurnCeilingAction; detail: string } {
  const { now, startedAt, lastProgressAt, wrapUpRequestedAt } = input;
  const idleMinutes = Math.round((now - lastProgressAt) / 60_000);
  if (now - lastProgressAt >= PI_WORKER_NO_PROGRESS_CEILING_MS) {
    return {
      action: "fail",
      detail: `Pi worker timed out: no finished tool call or message for ${idleMinutes} min.`,
    };
  }
  if (wrapUpRequestedAt !== null) {
    if (now - wrapUpRequestedAt >= PI_WORKER_WRAP_UP_GRACE_MS) {
      const hours = Math.round(PI_WORKER_TURN_ABSOLUTE_CEILING_MS / 3_600_000);
      return {
        action: "fail",
        detail:
          `Pi worker exceeded its ${hours}h turn ceiling while still making progress ` +
          `and did not wrap up within ${Math.round(PI_WORKER_WRAP_UP_GRACE_MS / 60_000)} min.`,
      };
    }
    return { action: "continue", detail: "" };
  }
  if (now - startedAt >= PI_WORKER_TURN_ABSOLUTE_CEILING_MS) {
    return { action: "wrap_up", detail: PI_WORKER_WRAP_UP_PROMPT };
  }
  return { action: "continue", detail: "" };
}

export type WorkerSilenceAction = "continue" | "warn" | "fail";

export interface WorkerSilenceVerdict {
  action: WorkerSilenceAction;
  /** Human-readable reason; the failure message, or the stall note. */
  detail: string;
}

export function describeSilence(ms: number, lastEventType: string | null): string {
  const minutes = Math.round(ms / 60_000);
  const since = lastEventType ? `; last signal was ${lastEventType}` : "; it never sent one";
  return `no response from the Pi worker for ${minutes} min${since}`;
}

/**
 * Decide what a given stretch of worker silence earns.
 *
 * `alreadyWarned` makes "warn" edge-triggered: the caller reports a stall once
 * and is told to continue until the silence becomes terminal, so a stalled
 * worker does not re-announce itself every poll.
 */
export function classifyWorkerSilence(input: {
  silentForMs: number;
  providerFailure: string | null;
  lastEventType: string | null;
  alreadyWarned: boolean;
}): WorkerSilenceVerdict {
  const { silentForMs, providerFailure, lastEventType, alreadyWarned } = input;
  const silence = describeSilence(silentForMs, lastEventType);

  if (silentForMs >= PI_WORKER_STALL_FAIL_MS) {
    return {
      action: "fail",
      detail: providerFailure
        ? `${providerFailure} (${silence})`
        : `Pi worker stalled: ${silence}.`,
    };
  }
  if (providerFailure && silentForMs >= PI_WORKER_PROVIDER_FAILURE_GRACE_MS) {
    return {
      action: "fail",
      detail: `${providerFailure} (${silence}, so the retry never produced a response)`,
    };
  }
  // Two warn thresholds, because the two situations carry different evidence.
  // With a provider error in hand there is nothing to guess about, so surface it
  // almost at once; without one, silence alone is weak evidence and must clear
  // the healthy envelope by a wide margin before it is worth saying anything.
  const warnAfter = providerFailure ? PI_WORKER_PROVIDER_FAILURE_WARN_MS : PI_WORKER_STALL_WARN_MS;
  if (!alreadyWarned && silentForMs >= warnAfter) {
    return {
      action: "warn",
      detail: providerFailure ? `${providerFailure} - ${silence}.` : `${silence}.`,
    };
  }
  return { action: "continue", detail: "" };
}

/**
 * A manager turn is bounded by inactivity, not duration. A turn parked inside
 * a blocking orchestration tool is waiting on purpose and never ages - but only
 * for as long as that wait is credible, since those RPCs are themselves
 * client-aborted at ORCHESTRATION_TIMEOUT_MS and one still "in flight" past
 * that has lost its tool_execution_end.
 */
export const PI_TURN_IDLE_TIMEOUT_MS = 25 * 60 * 1000;
export const PI_TURN_ABSOLUTE_CEILING_MS = PI_TURN_ABSOLUTE_CEILING_MS_VALUE;
/** Maximum time a normal Pi tool may produce neither a result nor progress. */
export const PI_TOOL_RESULT_TIMEOUT_MS = 25 * 60 * 1000;
export const PI_LONG_POLL_TRUST_MS = 30 * 60 * 1000;

export type TurnLivenessAction = "continue" | "fail";

export interface TurnLivenessVerdict {
  action: TurnLivenessAction;
  detail: string;
}

export interface TurnInFlightTool {
  name: string;
  startedAt: number;
  longPoll: boolean;
  /** Last streamed progress (tool_execution_update), e.g. bash output. */
  lastProgressAt?: number;
}

export function classifyTurnLiveness(input: {
  now: number;
  startedAt: number;
  lastEventAt: number;
  /** Every tool that emitted a start event but has not emitted its result. */
  inFlightTools: readonly TurnInFlightTool[];
}): TurnLivenessVerdict {
  const { now, startedAt, lastEventAt, inFlightTools } = input;

  if (now - startedAt >= PI_TURN_ABSOLUTE_CEILING_MS) {
    return {
      action: "fail",
      detail: `Cora's Pi turn exceeded its ${Math.round(PI_TURN_ABSOLUTE_CEILING_MS / 3_600_000)}h ceiling.`,
    };
  }

  if (inFlightTools.length > 0) {
    // A normal tool that keeps streaming output (a long build, a test suite)
    // is alive, so it is timed from its latest progress. A long-poll is timed
    // from its start: its bound is the RPC's own legal duration.
    const expired = inFlightTools
      .map((tool) => {
        const since = tool.longPoll
          ? tool.startedAt
          : Math.max(tool.startedAt, tool.lastProgressAt ?? tool.startedAt);
        return {
          tool,
          since,
          waitingFor: now - since,
          timeout: tool.longPoll ? PI_LONG_POLL_TRUST_MS : PI_TOOL_RESULT_TIMEOUT_MS,
        };
      })
      .filter((entry) => entry.waitingFor >= entry.timeout)
      .sort((left, right) => (left.since + left.timeout) - (right.since + right.timeout))[0];
    if (!expired) return { action: "continue", detail: "" };
    return {
      action: "fail",
      detail: expired.tool.longPoll
        ? `Cora's Pi turn is stuck in ${expired.tool.name}: ` +
          `${Math.round(expired.waitingFor / 60_000)} min with no result, past the point that call can legally take.`
        : `Cora's Pi turn is stuck in ${expired.tool.name}: ` +
          `${Math.round(expired.waitingFor / 60_000)} min with no result or output.`,
    };
  }

  const idleFor = now - lastEventAt;
  if (idleFor >= PI_TURN_IDLE_TIMEOUT_MS) {
    return {
      action: "fail",
      detail: `Cora's Pi turn went quiet for ${Math.round(idleFor / 60_000)} min with no tool call in flight.`,
    };
  }
  return { action: "continue", detail: "" };
}

/**
 * Orchestration tools that block on purpose. Matched on the bare tool name and
 * on the `mcp__codara-studio__` prefixed form some providers surface.
 */
export const PI_LONG_POLL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "codara_wait_for_workers",
  "codara_ask_user",
  "codara_wait_for_automation",
]);

export function isLongPollToolName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return PI_LONG_POLL_TOOL_NAMES.has(bare);
}
