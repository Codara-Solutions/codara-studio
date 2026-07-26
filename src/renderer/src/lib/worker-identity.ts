import type { RunState, WorkerAttempt, WorkerTask } from "../../../shared/types";

// One logical worker as the user should count them: a task collapsed over its
// supersedesTaskId lineage (a cancelled task replaced by a runtime-fallback
// clone folds into the replacement) carrying every attempt that ran for any
// task in the chain, oldest first. Every renderer surface that says "worker"
// must count these — never raw workerTasks and never workerAttempts — so the
// graph, the chat, the terminals and the header can no longer disagree.
export interface LogicalWorker {
  // The surviving (most recent) task in the supersedes chain.
  task: WorkerTask;
  // Cancelled predecessors, oldest first. Empty for normal tasks.
  supersededTasks: WorkerTask[];
  // All attempts across the chain in chronological chain order: each task's
  // attempts sorted by attemptNumber, superseded predecessors first. Attempt
  // numbers restart at 1 on a fallback clone, so a global attemptNumber sort
  // would interleave dead and live attempts.
  attempts: WorkerAttempt[];
  // Latest attempt across the chain, if any ran.
  latestAttempt: WorkerAttempt | null;
}

function attemptOrder(a: WorkerAttempt, b: WorkerAttempt): number {
  if (a.attemptNumber !== b.attemptNumber) return a.attemptNumber - b.attemptNumber;
  return (a.startedAt ?? "").localeCompare(b.startedAt ?? "");
}

export function logicalWorkers(run: RunState): LogicalWorker[] {
  const tasksById = new Map(run.workerTasks.map((task) => [task.id, task]));
  const supersededIds = new Set<string>();
  for (const task of run.workerTasks) {
    if (task.supersedesTaskId && tasksById.has(task.supersedesTaskId)) {
      supersededIds.add(task.supersedesTaskId);
    }
  }

  const attemptsByTask = new Map<string, WorkerAttempt[]>();
  for (const attempt of run.workerAttempts) {
    const list = attemptsByTask.get(attempt.workerTaskId);
    if (list) list.push(attempt);
    else attemptsByTask.set(attempt.workerTaskId, [attempt]);
  }

  const workers: LogicalWorker[] = [];
  for (const task of run.workerTasks) {
    if (supersededIds.has(task.id)) continue;
    const chain: WorkerTask[] = [];
    let cursor: WorkerTask | undefined = task;
    const seen = new Set<string>();
    while (cursor?.supersedesTaskId && !seen.has(cursor.supersedesTaskId)) {
      seen.add(cursor.supersedesTaskId);
      const previous = tasksById.get(cursor.supersedesTaskId);
      if (!previous) break;
      chain.unshift(previous);
      cursor = previous;
    }
    const attempts = [...chain, task].flatMap((member) =>
      (attemptsByTask.get(member.id) ?? []).slice().sort(attemptOrder),
    );
    workers.push({
      task,
      supersededTasks: chain,
      attempts,
      latestAttempt: attempts.length > 0 ? attempts[attempts.length - 1] : null,
    });
  }
  return workers;
}

export function logicalWorkersForStep(run: RunState, stepId: string): LogicalWorker[] {
  return logicalWorkers(run).filter((worker) => worker.task.stepId === stepId);
}

export function attemptsForTask(run: RunState, taskId: string): WorkerAttempt[] {
  return run.workerAttempts
    .filter((attempt) => attempt.workerTaskId === taskId)
    .sort(attemptOrder);
}
