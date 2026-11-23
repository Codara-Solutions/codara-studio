import type { RunState, ScheduledJob, WorkerAttemptStatus } from "./types";

// When a run may be deleted on request from a surface that lists runs for
// cleanup (the session picker). Main applies the same rule under the run's
// mutation queue, so a pass starting between the picker's check and the
// delete is still refused.

const ACTIVE_ATTEMPTS = new Set<WorkerAttemptStatus>(["preparing", "prompt_ready", "launching", "running", "finishing"]);
const WORKING = new Set<RunState["status"]>(["planning", "running", "reviewing"]);

export const RUN_ID_SHAPE = /^run-[A-Za-z0-9_-]{1,128}$/;

export const LOOM_HOLDS_RUN = "Its Loom is still using this run. Stop the Loom first.";
export const RUN_IS_WORKING = "Working now, so it can't be deleted. Stop it first.";

/** Working now, or stopped with a worker still going. */
export function runHasLiveWork(run: Pick<RunState, "status" | "workerAttempts">): boolean {
  if (WORKING.has(run.status)) return true;
  return (run.workerAttempts ?? []).some((attempt) => ACTIVE_ATTEMPTS.has(attempt.status));
}

/**
 * A Loom keeps its current run between passes (a later pass of the cycle is
 * added to it), and through a pause or a question, while the run itself
 * reads as finished.
 */
export function loomHoldsRun(jobs: readonly Pick<ScheduledJob, "state">[], runId: string): boolean {
  return jobs.some((job) => job.state?.currentRunId === runId);
}

export function liveRunDeleteRefusal(
  run: Pick<RunState, "id" | "status" | "workerAttempts">,
  jobs: readonly Pick<ScheduledJob, "state">[],
): string | null {
  if (runHasLiveWork(run)) return RUN_IS_WORKING;
  if (loomHoldsRun(jobs, run.id)) return LOOM_HOLDS_RUN;
  return null;
}
