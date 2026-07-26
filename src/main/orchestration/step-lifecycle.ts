import type { RunState } from "@shared/types";

const TERMINAL_STEP_STATUSES = new Set([
  "complete",
  "completed_unverified",
  "failed",
  "skipped",
]);

const LIVE_FEEDBACK_RETRY_STATUSES = new Set([
  "created",
  "queued",
  "claimed",
  "running",
  "needs_review",
  "retry_queued",
]);

const VERIFIER_FEEDBACK_MARKER = "## VERIFIER FEEDBACK";

interface RequestedWorkerScope {
  title?: string;
  taskClass?: string;
  allowedPaths?: string[];
  expectedOutputs?: string[];
}

function normalizeScopePath(value: string): string {
  return value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function scopePaths(scope: RequestedWorkerScope): string[] {
  return [...(scope.allowedPaths ?? []), ...(scope.expectedOutputs ?? [])]
    .filter((value): value is string => typeof value === "string")
    .map(normalizeScopePath)
    .filter(Boolean);
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * Verifier FEEDBACK can automatically requeue an implementation task before
 * the manager's wait call returns. If that still-open manager then asks to
 * spawn a corrective worker for the same files, reusing the automatic retry
 * avoids two workers editing the same scope and producing duplicate graph
 * steps.
 */
export function findLiveVerifierFeedbackRetry(
  run: RunState,
  requested: RequestedWorkerScope,
): RunState["workerTasks"][number] | undefined {
  if (requested.taskClass === "verifier") return undefined;
  const requestedPaths = scopePaths(requested);
  const requestedTitle = requested.title?.trim().toLowerCase() ?? "";

  return [...(run.workerTasks ?? [])].reverse().find((task) => {
    if (task.taskClass === "verifier") return false;
    if (!LIVE_FEEDBACK_RETRY_STATUSES.has(task.status)) return false;
    if (!task.description?.includes(VERIFIER_FEEDBACK_MARKER)) return false;

    const taskPaths = scopePaths(task);
    if (requestedPaths.length > 0 && taskPaths.length > 0) {
      return requestedPaths.some((left) =>
        taskPaths.some((right) => pathsOverlap(left, right)));
    }

    return requestedTitle.length > 0 && requestedTitle === task.title.trim().toLowerCase();
  });
}

/**
 * A standalone verifier completes its own step by producing a verdict, even
 * when that verdict is FEEDBACK and reopens a different implementation step.
 * This also repairs historical runs written before the feedback fast path
 * closed the verifier step.
 */
export function reconcileAcceptedVerifierOnlySteps(
  run: RunState,
  timestamp?: string,
): string[] {
  const completed: string[] = [];
  for (const step of run.steps ?? []) {
    if (TERMINAL_STEP_STATUSES.has(step.status)) continue;
    const tasks = (run.workerTasks ?? []).filter((task) => task.stepId === step.id);
    if (tasks.length === 0) continue;
    if (!tasks.every((task) => task.taskClass === "verifier")) continue;
    if (!tasks.some((task) => task.status === "accepted")) continue;
    if (!tasks.every((task) => task.status === "accepted" || task.status === "cancelled")) continue;
    step.status = "complete";
    step.updatedAt = timestamp ?? step.updatedAt ?? run.updatedAt;
    if (run.currentStepId === step.id) run.currentStepId = undefined;
    completed.push(step.id);
  }
  return completed;
}
