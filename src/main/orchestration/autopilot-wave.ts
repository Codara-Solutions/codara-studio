// Pure wave selection for the autopilot picker: given the queueable candidate
// tasks (state filtering stays in run-store), decide which of them launch in
// the same parallel wave and why a would-be batch collapsed to serial.
//
// Two launch paths exist for worker tasks and they must stay coherent:
//   1. The execute-mode manager spawn RPC (agent-socket's
//      handleOrchestratorSpawnWorkers) prepares every task of a batch and
//      launches ALL attempts simultaneously via scheduleAutopilotCycles,
//      without consulting this selector. Those tasks carry
//      parallelTrust="manager_batch".
//   2. Every relaunch (direct retry of a failed task, runtime fallback via
//      maybeQueueCliLaunchFallback, verifier-feedback requeue) goes through
//      pickAutopilotTasks, which delegates here.
// Before manager-batch trust existed, path 2 second-guessed path 1: a batch of
// leaf/research workers with empty allowedPaths relaunched one at a time
// because the fan-out guard read "wants parallel, no concrete write scope" as
// the fan-out anti-pattern (observed in run-ms0lod1m-h3pqoo, where 5 parallel
// research workers became a serial chain of runtime fallbacks). Trusted tasks
// keep the concurrency the system already granted them at first launch; the
// guard still downgrades planner/autopilot-created writer tasks that want
// parallel without naming a concrete write scope.

import { selectLargestCompatibleWave } from "@shared/parallel-wave";

// Structural subset of WorkerTask so run-store passes its real tasks and tests
// pass plain objects (same pattern as spawn-batch-guard's SpawnGuardTask).
export interface WaveTask {
  id: string;
  allowedPaths: string[];
  canRunParallel: boolean;
  conflictsWith: string[];
  taskClass?: string;
  runtimePreference?: string;
  parallelTrust?: string;
}

export function normalizeTaskPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/\*\*?$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function isBroadPathScope(path: string): boolean {
  const normalized = normalizeTaskPath(path);
  return (
    normalized === "" ||
    normalized === "." ||
    normalized === "./" ||
    normalized === "*" ||
    normalized === "**" ||
    normalized === "/"
  );
}

export function taskWritesWorkspace(task: Pick<WaveTask, "taskClass" | "runtimePreference">): boolean {
  return task.taskClass !== "verifier" && task.runtimePreference !== "manual";
}

function concreteAllowedPaths(task: WaveTask): string[] {
  return task.allowedPaths
    .map(normalizeTaskPath)
    .filter((path) => path.length > 0 && !isBroadPathScope(path));
}

export function hasConcreteParallelScope(task: WaveTask): boolean {
  if (!taskWritesWorkspace(task)) return true;
  return concreteAllowedPaths(task).length > 0;
}

// Manager-batch parallel trust. Only the execute-mode spawn handler mints
// parallelTrust="manager_batch" (for batches of >= 2 workers), and the runtime
// fallback path copies it onto the replacement task it creates, so the marker
// means: the system already launched this task's lineage as a simultaneous
// batch. The picker honoring it on relaunch is not a relaxation of the fan-out
// guard; it is parity with what the first launch already did.
export function hasManagerBatchParallelTrust(task: WaveTask): boolean {
  return task.parallelTrust === "manager_batch" && task.canRunParallel;
}

// A task may join a parallel wave when it either names a concrete write scope
// (or does not write at all) or carries manager-batch trust.
function eligibleForParallelLaunch(task: WaveTask): boolean {
  return task.canRunParallel && (hasConcreteParallelScope(task) || hasManagerBatchParallelTrust(task));
}

export function pathScopesOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function taskPathScopesConflict(left: WaveTask, right: WaveTask): boolean {
  if (!taskWritesWorkspace(left) || !taskWritesWorkspace(right)) return false;
  const leftPaths = concreteAllowedPaths(left);
  const rightPaths = concreteAllowedPaths(right);
  if (leftPaths.length === 0 || rightPaths.length === 0) return true;
  return leftPaths.some((leftPath) =>
    rightPaths.some((rightPath) => pathScopesOverlap(leftPath, rightPath)),
  );
}

export function tasksConflictForParallelLaunch(left: WaveTask, right: WaveTask): boolean {
  if (left.conflictsWith.includes(right.id) || right.conflictsWith.includes(left.id)) {
    return true;
  }
  // A pair of manager-batch-trusted tasks already ran simultaneously at first
  // launch (the spawn path schedules the whole batch without a scope check),
  // so treating their empty or overlapping scopes as a conflict on relaunch
  // would serialize a wave the system itself started in parallel. Explicit
  // conflictsWith above still wins; mixed pairs (trusted vs planner-scoped)
  // keep the conservative scope check.
  if (hasManagerBatchParallelTrust(left) && hasManagerBatchParallelTrust(right)) {
    return false;
  }
  return taskPathScopesConflict(left, right);
}

// Why the selector collapsed a would-be parallel batch to a single serial
// task. Only `no_concrete_scope` (a task that wants to run parallel but has no
// concrete write scope and no manager-batch trust, exactly the fan-out
// anti-pattern) is surfaced to the launch site as a fanout.downgraded_to_serial
// event; `not_parallel` (the manager deliberately marked the task serial) is
// normal and not reported.
export type SerialDowngradeReason = "no_concrete_scope" | "not_parallel";

export interface AutopilotWaveSelection<T extends WaveTask> {
  tasks: T[];
  downgrade: { task: T; reason: SerialDowngradeReason } | null;
}

export function selectAutopilotWave<T extends WaveTask>(
  candidates: readonly T[],
  cap: number | null,
): AutopilotWaveSelection<T> {
  if (candidates.length === 0) return { tasks: [], downgrade: null };

  const first = candidates[0];
  if (!first.canRunParallel) return { tasks: [first], downgrade: { task: first, reason: "not_parallel" } };
  if (!eligibleForParallelLaunch(first)) {
    return { tasks: [first], downgrade: { task: first, reason: "no_concrete_scope" } };
  }

  const parallelCandidates = candidates.filter(eligibleForParallelLaunch);
  const selected = selectLargestCompatibleWave(parallelCandidates, {
    cap,
    conflicts: tasksConflictForParallelLaunch,
  });
  return selected.length > 0 ? { tasks: selected, downgrade: null } : { tasks: [first], downgrade: null };
}
