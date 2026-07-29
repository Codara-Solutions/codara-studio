// Layered policy for a manager turn the backend reported as FAILED. Before
// this module every turnFailed landed in one branch: brand the run failed and
// terminalize its workers. That verdict is right for a crashed CLI or an
// expired credential, but a transient provider hiccup ("Our servers are
// currently overloaded") on a single manager turn was branding runs failed
// whose every step had completed and whose deliverable existed on disk.
//
// The layers, evaluated in order:
//
//   keep_state -> the run already carries a state a dead turn must not
//     rewrite. Terminal verdicts (complete/cancelled/failed) landed while the
//     turn streamed; "blocked" means an open question the user can still
//     answer (re-branding it would strand the answer path, since
//     answerRunQuestion rejects paused runs); "paused" means the user already
//     holds the run. In every case the failure is recorded as a quiet notice
//     and the run keeps its state.
//   retry      -> transport/provider failures on a DRIVING run are worth a
//     bounded, jittered, seconds-scale retry of the SAME turn before
//     bothering the user. Rate limits are excluded on purpose (same
//     reasoning as the worker taxonomy: the quota window outlives any fast
//     retry).
//   park       -> provider trouble that outlived the retries. The run is
//     paused, not failed: the work did not fail, the provider did, and
//     Resume re-drives the turn. Rate limits land here directly.
//   fail       -> everything else keeps the pre-policy behaviour.
//
// Classification is delegated to the worker failure taxonomy: manager turns
// fail with the same provider/transport/auth strings worker attempts do, and
// one vocabulary means the two policies can never disagree about what
// "transient" means. All three chat backends (claude/codex/pi) surface the
// raw provider error text as the turn's notice, so a single text-driven
// policy is uniform across them by construction.

import { classifyWorkerFailure, isTransientWorkerFailure } from "./failure-taxonomy";
import type { RunStatus, SparkCall, WorkerFailureKind } from "@shared/types";

/**
 * Maximum automatic same-turn retries after a transient manager-turn failure.
 * Two means: the original turn, plus up to two quiet retries, before the run
 * parks and asks the user to Resume.
 */
export const MAX_MANAGER_TRANSIENT_RETRIES = 2;

/**
 * Jittered seconds-scale backoff for retry attempt N (1-based). Doubles per
 * attempt from a 2s base with up to 1.5s of jitter, so two retries stay well
 * under ten seconds of added wall clock while still giving an overloaded
 * provider a beat to recover.
 */
export function managerTurnRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const bounded = Math.max(1, Math.floor(attempt));
  return 2000 * 2 ** (bounded - 1) + Math.floor(random() * 1500);
}

export type ManagerTurnFailurePlan =
  | { action: "keep_state"; kind?: WorkerFailureKind; reason: string }
  | { action: "retry"; kind: WorkerFailureKind; reason: string; attempt: number }
  | {
      action: "park";
      kind: WorkerFailureKind;
      reason: string;
      /** User-facing park reason, surfaced in the run header and banner. */
      parkReason: string;
      /** autopilot.lastAction stamp; resumeRun routes on it. */
      lastAction: "chat_turn_parked" | "manager_turn_parked";
    }
  | { action: "fail"; kind?: WorkerFailureKind; reason: string };

/** Run statuses a failed manager turn must never overwrite. Terminal verdicts
 * (complete/cancelled/failed) landed while the turn streamed; blocked keeps
 * its question answerable (answerRunQuestion rejects paused runs, so parking
 * a blocked run would strand the answer); paused is user-owned, and retrying
 * under it would only burn the budget against the post-sleep driving guard. */
const KEEP_STATE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "complete",
  "cancelled",
  "failed",
  "blocked",
  "paused",
]);

/** Failure kinds that are provider trouble rather than the work failing, and
 * therefore park the run instead of branding it failed once retries are
 * exhausted. Rate limits park without retrying first. */
function parksInsteadOfFailing(kind: WorkerFailureKind | undefined): boolean {
  return kind === "transport" || kind === "provider" || kind === "rate_limit";
}

/**
 * Decide what a failed manager turn earns. `transientRetryCount` counts the
 * automatic retries this turn lineage has already consumed (0 on the first
 * failure).
 */
export function planManagerTurnFailure(input: {
  error: string | null | undefined;
  runStatus: RunStatus;
  mode: SparkCall["mode"];
  transientRetryCount: number;
}): ManagerTurnFailurePlan {
  const kind = classifyWorkerFailure(input.error);

  if (KEEP_STATE_RUN_STATUSES.has(input.runStatus)) {
    return {
      action: "keep_state",
      kind,
      reason: `the run is already ${input.runStatus}; a failed manager turn must not rewrite that state`,
    };
  }

  if (isTransientWorkerFailure(kind) && input.transientRetryCount < MAX_MANAGER_TRANSIENT_RETRIES) {
    return {
      action: "retry",
      kind: kind as WorkerFailureKind,
      reason: `transient ${kind} failure, retrying the turn before surfacing anything`,
      attempt: input.transientRetryCount + 1,
    };
  }

  if (parksInsteadOfFailing(kind)) {
    return {
      action: "park",
      kind: kind as WorkerFailureKind,
      reason:
        kind === "rate_limit"
          ? "the provider is rate limited; a fast retry cannot clear a quota window, so the run parks for the user"
          : "transient provider trouble outlived the automatic retries, so the run parks instead of failing",
      // One voice everywhere the parked state surfaces: the run header detail,
      // the composer placeholder, and the Retry button all speak this exact
      // sentence pair, naming the control that actually exists.
      parkReason:
        kind === "rate_limit"
          ? "Cora's provider is rate limited. Retry runs the turn again."
          : "Cora's provider is overloaded. Retry runs the turn again.",
      lastAction: input.mode === "chat" ? "chat_turn_parked" : "manager_turn_parked",
    };
  }

  return {
    action: "fail",
    kind,
    reason: kind
      ? `${kind} failure, the turn itself is broken and the run reports it honestly`
      : "unclassified turn failure, keeping the pre-policy verdict",
  };
}

/** True when the autopilot projection says a run was parked by this policy.
 * The renderer mirrors these two lastAction strings (timeline.ts,
 * ChatComposer) because it cannot import main-process modules. */
export function isParkedManagerTurnAction(lastAction: string | undefined): boolean {
  return lastAction === "chat_turn_parked" || lastAction === "manager_turn_parked";
}
