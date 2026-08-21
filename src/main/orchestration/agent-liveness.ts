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
/** Backstop for a worker that keeps emitting events but never settles. */
export const PI_WORKER_TURN_CEILING_MS = 90 * 60 * 1000;

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
export const PI_TURN_ABSOLUTE_CEILING_MS = 6 * 60 * 60 * 1000;
/** Maximum time a normal Pi tool may produce no result. */
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
    const expired = inFlightTools
      .map((tool) => ({
        tool,
        waitingFor: now - tool.startedAt,
        timeout: tool.longPoll ? PI_LONG_POLL_TRUST_MS : PI_TOOL_RESULT_TIMEOUT_MS,
      }))
      .filter((entry) => entry.waitingFor >= entry.timeout)
      .sort((left, right) => (left.tool.startedAt + left.timeout) - (right.tool.startedAt + right.timeout))[0];
    if (!expired) return { action: "continue", detail: "" };
    return {
      action: "fail",
      detail: expired.tool.longPoll
        ? `Cora's Pi turn is stuck in ${expired.tool.name}: ` +
          `${Math.round(expired.waitingFor / 60_000)} min with no result, past the point that call can legally take.`
        : `Cora's Pi turn is stuck in ${expired.tool.name}: ` +
          `${Math.round(expired.waitingFor / 60_000)} min with no result.`,
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
