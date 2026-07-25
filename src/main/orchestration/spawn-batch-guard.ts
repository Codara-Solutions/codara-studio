// Structural shape checks for a manager-requested worker batch, applied at the
// spawn RPC before any step or task is created.
//
// The case this exists for: a manager (observed on the pi backend, whose only
// definition of taskClass was the MCP schema's "tier/pricing selection" line)
// spawned five research workers with taskClass="verifier" on the FIRST batch of
// a run. Verifier prompts are read-only and are rendered around the premise
// that an implementation worker just finished, so the batch was structurally
// incapable of producing the deliverable; the workers detected it themselves
// and the whole batch ran twice.
//
// Rejection, not coercion: the manager must learn the class semantics, and a
// silently rewritten class hides a planning error that also affects the briefs
// (a "verifier" brief is written as an audit, not as the work).

// Structural subsets of RunState/WorkerTask so callers pass their real run and
// tests pass plain objects.
export interface SpawnGuardTask {
  taskClass?: string;
  status?: string;
}

export interface SpawnGuardRun {
  workerTasks: SpawnGuardTask[];
}

export interface SpawnGuardWorkerInput {
  taskClass?: string;
}

export interface SpawnBatchRejection {
  code: "verifier_batch_without_implementer";
  message: string;
  verifierCount: number;
}

function isVerifierClass(taskClass: unknown): boolean {
  return typeof taskClass === "string" && taskClass.trim().toLowerCase() === "verifier";
}

// An implementation artifact exists once the run holds any non-verifier worker
// task that was not cancelled. Deliberately looser than "an attempt finished":
// a verifier queued alongside a running implementer is the normal review shape
// and must not trip this guard. Cancelled tasks are excluded because a run
// whose only implementer was cancelled has nothing to verify either.
export function runHasImplementationTask(run: SpawnGuardRun): boolean {
  return run.workerTasks.some(
    (task) => !isVerifierClass(task.taskClass) && task.status !== "cancelled",
  );
}

export const VERIFIER_BATCH_REJECTION_MESSAGE =
  "Rejected: every worker in this batch has taskClass \"verifier\", and this run has no implementation " +
  "worker for them to verify. taskClass is a role, not a price tier. \"verifier\" is ONLY a read-only " +
  "follow-up that re-derives ground truth about work an implementation worker already produced: it gets " +
  "read-only tools and a prompt that asserts an implementation just finished, so it cannot research, " +
  "write, or deliver anything. Respawn this batch with implementation classes: \"leaf\" for research, " +
  "recon, one-shot or mechanical work against an existing contract, \"feature\" for a standard " +
  "implementation slice, \"skeleton\" for the rare foundational slice later workers build on. Spawn a " +
  "verifier only AFTER an implementation worker has produced the artifact it should check, and never as " +
  "every worker in a batch.";

// Returns null when the batch is acceptable. Rejects only the all-verifier,
// no-implementer shape: a mixed batch passes (the implementers are in it), and
// an all-verifier batch passes once the run has an implementation task (the
// legitimate single verifier follow-up and the complex-tier two-peer batch).
export function evaluateSpawnBatchShape(
  run: SpawnGuardRun,
  requested: SpawnGuardWorkerInput[],
): SpawnBatchRejection | null {
  if (requested.length === 0) return null;
  if (!requested.every((worker) => isVerifierClass(worker.taskClass))) return null;
  if (runHasImplementationTask(run)) return null;
  return {
    code: "verifier_batch_without_implementer",
    message: VERIFIER_BATCH_REJECTION_MESSAGE,
    verifierCount: requested.length,
  };
}
