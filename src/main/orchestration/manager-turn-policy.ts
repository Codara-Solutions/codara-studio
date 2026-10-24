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
//     bothering the user. Pi owns a provider retry loop, so a Pi turn is
//     replayed only when that loop never ran and no tool started (a replay
//     would repeat the tool's side effects). Rate limits are excluded on
//     purpose (same reasoning as the worker taxonomy: the quota window
//     outlives any fast retry).
//   park       -> provider trouble that outlived the retries. The run is
//     paused, not failed: the work did not fail, the provider did, and
//     Resume re-drives the turn. Rate limits land here directly. So do a
//     crashed agent runtime and a model that ended with no reply (the
//     backend names those causes structurally), and any failure the
//     taxonomy cannot name while workers are still running: a manager-only
//     problem must never kill healthy workers.
//   fail_turn  -> subscription (billing) declines while workers still run.
//     The SparkCall fails visibly and the run keeps its status and its
//     workers, which go on driving it: a billing decline is a plain turn
//     failure the user retries themselves. Parking it paused the run and
//     took over the composer for something the user had not asked to be
//     handled. With no live worker it fails the run instead, since a
//     "running" run with nothing driving it would show Working forever.
//   fail       -> everything else, with no live workers, keeps the
//     pre-policy behaviour.
//
// Classification is delegated to the worker failure taxonomy: manager turns
// fail with the same provider/transport/auth strings worker attempts do, and
// one vocabulary means the two policies can never disagree about what
// "transient" means. All three chat backends (claude/codex/pi) surface the
// raw provider error text as the turn's notice, so a single text-driven
// policy is uniform across them by construction.

import { classifyWorkerFailure, isTransientWorkerFailure } from "./failure-taxonomy";
import type {
  ChatBackendKind,
  ManagerTurnRecoveryFailureKind,
  RunStatus,
  SparkCall,
  WorkerFailureKind,
} from "@shared/types";

/**
 * A failure cause the backend knows structurally, so the policy does not have
 * to recover it from free text. `runtime`: the agent process crashed or broke
 * its protocol. `empty_reply`: the model ended its turn with no answer even
 * after the backend's hidden reprompt.
 */
export type ManagerTurnFailureCause = "runtime" | "empty_reply";

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
      kind: ManagerTurnRecoveryFailureKind;
      reason: string;
      /** User-facing park reason, surfaced in the run header and banner. */
      parkReason: string;
      /** autopilot.lastAction stamp; resumeRun routes on it. */
      lastAction: "chat_turn_parked" | "manager_turn_parked";
    }
  | { action: "fail_turn"; kind?: WorkerFailureKind; reason: string }
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

/** Failure kinds that are provider trouble — or Cora's own patience running
 * out — rather than the work failing, and therefore park the run instead of
 * branding it failed once retries are exhausted. Rate limits park without
 * retrying first. `subscription` is intentionally absent: a billing decline
 * fails the turn visibly (and the run only when no worker is left to drive
 * it), so the composer stays a normal input.
 *
 * `timeout` is here because a manager turn that ran out of time says nothing
 * about the work. Observed live: a manager that had been correctly driving a
 * run for 90 minutes hit its turn cap while blocked on a healthy
 * codara_wait_for_workers; branding the run failed then terminalized a worker
 * that was three commits from done, and the recovery turn invented cleanup
 * work against a tree that did not need it. Parking keeps the run resumable
 * and, critically, leaves in-flight workers alone. */
function parksInsteadOfFailing(
  kind: WorkerFailureKind | undefined,
): kind is "transport" | "provider" | "rate_limit" | "timeout" | "auth" {
  // `auth` parks too: a dead credential says nothing about the work or the
  // workers. Observed live (run-msq6zj3l-1e2qv8): an invalidated OAuth token
  // failed the turn, and the failure surfaced as a misleading "nothing left
  // to run" question instead of a sign-in-again prompt.
  return (
    kind === "transport" ||
    kind === "provider" ||
    kind === "rate_limit" ||
    kind === "timeout" ||
    kind === "auth"
  );
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
  /** Pi retries each provider request internally. Retrying the entire manager
   *  turn after that loop is exhausted replays tools and multiplies load. */
  backend?: ChatBackendKind;
  /** Structured cause reported by the backend; see ManagerTurnFailureCause. */
  failureCause?: ManagerTurnFailureCause;
  /** The backend's own provider retry loop ran during the failed turn. */
  providerRetried?: boolean;
  /** No tool started during the failed turn, so replaying it cannot repeat a
   *  side effect. Absent means unknown, which is treated as unsafe. */
  replaySafe?: boolean;
  /** Worker processes of this run still alive when the turn failed. */
  activeWorkerCount?: number;
}): ManagerTurnFailurePlan {
  const kind = classifyWorkerFailure(input.error);
  const lastAction = input.mode === "chat" ? "chat_turn_parked" : "manager_turn_parked";

  if (KEEP_STATE_RUN_STATUSES.has(input.runStatus)) {
    return {
      action: "keep_state",
      kind,
      reason: `the run is already ${input.runStatus}; a failed manager turn must not rewrite that state`,
    };
  }

  // A crash or an empty reply is never replayed automatically: live tools may
  // already have run, and the empty reply already had its hidden reprompt.
  if (input.failureCause) {
    return {
      action: "park",
      kind: "runtime",
      reason:
        input.failureCause === "runtime"
          ? "Cora's agent runtime stopped mid-turn, which says nothing about the work or the workers, so the run parks resumable"
          : "the model ended its turn without a reply even after a reprompt, so the run parks for the user to retry",
      parkReason:
        input.failureCause === "runtime"
          ? "Cora's runtime stopped unexpectedly. Retry the saved turn."
          : "Cora finished without a reply. Retry the saved turn.",
      lastAction,
    };
  }

  // Pi owns a provider retry loop, so the whole turn is replayed only when
  // that loop never ran (Pi does not retry a socket reset) and no tool
  // started, since a replay would repeat its side effects.
  const backendAllowsReplay =
    input.backend !== "pi" ||
    (input.replaySafe === true && input.providerRetried !== true);
  if (
    isTransientWorkerFailure(kind) &&
    backendAllowsReplay &&
    input.transientRetryCount < MAX_MANAGER_TRANSIENT_RETRIES
  ) {
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
      kind,
      reason:
        kind === "timeout"
          ? "the manager turn ran out of time, which says nothing about the work or the workers, so the run parks resumable instead of failing"
          : kind === "rate_limit"
            ? "the provider is rate limited; a fast retry cannot clear a quota window, so the run parks for the user"
            : kind === "auth"
              ? "the provider credential is invalid or expired; only the user can re-authenticate, so the run parks with the real cause named"
              : input.backend === "pi"
                ? "Pi already retried the provider or a tool already ran, so replaying the entire manager turn could duplicate work"
                : "transient provider trouble outlived the automatic retries, so the run parks instead of failing",
      // One voice everywhere the parked state surfaces: the run header detail,
      // the composer placeholder, and the Retry button all speak this exact
      // sentence pair, naming the control that actually exists.
      parkReason: managerTurnParkReason(kind),
      lastAction,
    };
  }

  const workersRunning = (input.activeWorkerCount ?? 0) > 0;
  // Only live workers keep driving a run whose turn failed. With none, a run
  // left "running" has no driver and shows Working forever, so a billing
  // decline then fails the run like any other unrecoverable turn.
  if (kind === "subscription" && workersRunning) {
    return {
      action: "fail_turn",
      kind,
      reason:
        "a billing decline is the user's to resolve; the turn fails visibly while the run and its workers keep their state",
    };
  }

  if (workersRunning) {
    return {
      action: "park",
      kind: "runtime",
      reason: kind
        ? `${kind} failure on the manager turn while workers are still running; a manager-only problem must not kill them, so the run parks`
        : "unclassified manager-turn failure while workers are still running; a manager-only problem must not kill them, so the run parks",
      parkReason: "Cora's turn failed, but its workers are still running. Retry the saved turn.",
      lastAction,
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

/**
 * The user-facing sentence for a parked turn of `kind`. One voice everywhere
 * the parked state surfaces: the run header detail, the composer placeholder,
 * and the Retry button, including a recovery re-parked after a restart. A
 * recovery replay that fails and returns to parked must read the same sentence
 * again, or an auth park would turn into a "provider unavailable" one the
 * moment the user retried without signing in.
 */
export function managerTurnParkReason(
  kind: ManagerTurnRecoveryFailureKind | WorkerFailureKind | undefined,
): string {
  switch (kind) {
    case "timeout":
      return "Cora's turn ran out of time. Its saved request is ready to retry.";
    case "rate_limit":
      return "The selected provider account reached its usage limit. Switch accounts or retry after quota resets.";
    case "auth":
      return "Cora's provider account is not connected, or its sign-in expired. Connect it in Settings > Agents, then retry the saved turn.";
    case "transport":
      return "Cora lost its connection to the provider. Retry when the connection is stable.";
    case "runtime":
      return "Cora's turn did not finish. Retry the saved turn.";
    default:
      return "Cora's provider is temporarily unavailable or at capacity. Retry the saved turn or switch accounts.";
  }
}

/** True when the autopilot projection says a run was parked by this policy.
 * The renderer mirrors these two lastAction strings (timeline.ts,
 * ChatComposer) because it cannot import main-process modules. */
export function isParkedManagerTurnAction(lastAction: string | undefined): boolean {
  return lastAction === "chat_turn_parked" || lastAction === "manager_turn_parked";
}
