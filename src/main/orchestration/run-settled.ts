import type { RunState } from "@shared/types";

/**
 * "Every piece of work this run owns finished successfully and nothing is left
 * to drive."
 *
 * An execute/auto CLI manager (claude/codex/pi in execute or auto mode) is the
 * only thing that terminalizes its own run: it reads the worker reports that
 * codara_wait_for_workers handed back and calls codara_complete. When its turn
 * ends WITHOUT codara_complete, every step is complete, every worker task is
 * accepted, no attempt is live, and no driver is left holding the run, so the
 * run sits at status "running" forever while the timeline shows finished work.
 * This predicate names that shape for the two places that must recognize it:
 * the post-turn driver hop in startAutopilot, and boot recovery.
 *
 * Deliberately strict, failure shapes are NOT settled. A failed step, a failed
 * or cancelled worker task, or a task still awaiting review is a decision the
 * user or the manager still owes, and startAutopilot already has accurate
 * questions for those. Only unanimous success terminalizes without a human.
 *
 * Unverified success is not success either. `completed_unverified` and
 * `forceAccepted` are the honest markers the force-accept paths leave when work
 * landed without ever earning a terminal verifier verdict (cap-break, refused
 * completion). Auto-completing those would report cap-broken work as a clean
 * green run, so they stay reviewable and keep reaching the human question.
 *
 * Pure and dependency-free so both call sites and the harness share one rule.
 * Freshness of the verifier verdict itself needs report I/O, so it lives with
 * the call sites (describeVerificationFreshness) rather than here.
 */

const SUCCEEDED_STEP_STATUSES = new Set(["complete", "skipped"]);
const UNVERIFIED_STEP_STATUSES = new Set(["completed_unverified"]);
const TERMINAL_ATTEMPT_STATUSES = new Set(["succeeded", "failed", "timed_out", "cancelled"]);

export type RunSettlementReason =
  | "settled"
  | "direct_run"
  | "terminal_run"
  | "no_steps"
  | "step_unfinished"
  | "step_unverified"
  | "worker_task_unfinished"
  | "worker_task_force_accepted"
  | "attempt_in_flight";

export interface RunSettlement {
  settled: boolean;
  reason: RunSettlementReason;
  /** id of the first step/task/attempt that blocked settlement, for events. */
  blockedBy?: string;
}

export function describeRunSettlement(run: RunState): RunSettlement {
  // Direct (loom) runs are finalized by finalizeDirectRun, never by a manager.
  if (run.executionMode === "direct") return { settled: false, reason: "direct_run" };
  if (["complete", "failed", "cancelled"].includes(run.status)) {
    return { settled: false, reason: "terminal_run" };
  }
  // A run with no steps never started work, so there is nothing to declare
  // finished; the plan/chat paths own it.
  if (run.steps.length === 0) return { settled: false, reason: "no_steps" };

  const unverifiedStep = run.steps.find((step) => UNVERIFIED_STEP_STATUSES.has(step.status));
  if (unverifiedStep) {
    return { settled: false, reason: "step_unverified", blockedBy: unverifiedStep.id };
  }
  const unfinishedStep = run.steps.find((step) => !SUCCEEDED_STEP_STATUSES.has(step.status));
  if (unfinishedStep) {
    return { settled: false, reason: "step_unfinished", blockedBy: unfinishedStep.id };
  }
  const unfinishedTask = run.workerTasks.find((task) => task.status !== "accepted");
  if (unfinishedTask) {
    return { settled: false, reason: "worker_task_unfinished", blockedBy: unfinishedTask.id };
  }
  const forcedTask = run.workerTasks.find((task) => task.forceAccepted === true);
  if (forcedTask) {
    return { settled: false, reason: "worker_task_force_accepted", blockedBy: forcedTask.id };
  }
  const liveAttempt = run.workerAttempts.find(
    (attempt) => !TERMINAL_ATTEMPT_STATUSES.has(attempt.status),
  );
  if (liveAttempt) {
    return { settled: false, reason: "attempt_in_flight", blockedBy: liveAttempt.id };
  }
  return { settled: true, reason: "settled" };
}

export function isRunSettled(run: RunState): boolean {
  return describeRunSettlement(run).settled;
}
