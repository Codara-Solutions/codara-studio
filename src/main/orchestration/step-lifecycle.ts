import type { RunState, StepState, WorkerTask } from "@shared/types";

const TERMINAL_STEP_STATUSES = new Set([
  "complete",
  "completed_unverified",
  "failed",
  "skipped",
]);

/**
 * A step that will never run again. Mirrors run-store's isTerminalStepStatus;
 * exported so the re-homing below and its caller cannot disagree about what
 * "settled" means.
 */
export function isSettledStepStatus(status: string): boolean {
  return TERMINAL_STEP_STATUSES.has(status);
}

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

export interface RehomedFollowUp {
  /** Step the follow-up task now belongs to. */
  stepId: string;
  /** The minted follow-up task. */
  taskId: string;
  /** True when no step was current and one had to be appended. */
  createdStep: boolean;
}

/**
 * Re-home a corrective rework whose target sits in a step that already settled.
 *
 * Cora may follow up with a finished worker, but a step the user watched
 * complete must never show running workers again (run-msojtvqk-qjklvo: a
 * verifier FEEDBACK verdict reopened step 1 and ran "attempt 2" there while
 * step 3 was live). So instead of reopening that step and stacking another
 * attempt on its task, the rework runs as a FOLLOW-UP COPY of the target in the
 * current step, linked back through `followUpOfTaskId`. The settled step keeps
 * its tasks, its attempts and its counters byte-identical.
 *
 * Destination: the current step, i.e. the first step that is not settled. It
 * has to be exactly that one, because run-store's autopilot picker only
 * launches tasks belonging to the first non-terminal step, so a copy homed
 * anywhere else would sit queued forever. When every step is settled there is
 * no current step and one is appended, matching the "spawned work gets its own
 * worker_batch step" shape codara_spawn_workers uses for brand-new tasks.
 *
 * Mutates `run` in place (it runs inside run-store's commit mutate) and returns
 * null when re-homing does not apply, which is the caller's signal to retry the
 * target in place exactly as before.
 */
export function rehomeSettledStepFeedbackRetry(
  run: RunState,
  input: {
    targetTaskId: string;
    /** The target's description with the verifier feedback block appended. */
    description: string;
    followUpTaskId: string;
    /** Used only if a step has to be appended. */
    followUpStepId: string;
    timestamp: string;
  },
): RehomedFollowUp | null {
  const target = (run.workerTasks ?? []).find((task) => task.id === input.targetTaskId);
  if (!target?.stepId) return null;
  const targetStep = (run.steps ?? []).find((step) => step.id === target.stepId);
  if (!targetStep || !isSettledStepStatus(targetStep.status)) return null;

  let destination = (run.steps ?? []).find((step) => !isSettledStepStatus(step.status));
  const createdStep = !destination;
  if (!destination) {
    destination = {
      id: input.followUpStepId,
      runId: run.id,
      index: (run.steps?.length ?? 0) + 1,
      title: `Corrective rework: ${target.title}`,
      goal: `Address the verifier's corrective feedback on "${target.title}".`,
      kind: "worker_batch",
      plannedAgents: [],
      status: "queued",
      acceptanceCriteria: ["The verifier's corrective feedback is addressed."],
      verificationCommands: [],
      workerTaskIds: [],
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    } satisfies StepState;
    (run.steps ??= []).push(destination);
  }

  const followUp: WorkerTask = {
    id: input.followUpTaskId,
    runId: run.id,
    stepId: destination.id,
    // Same title as the work it continues, the runtime-fallback replacement
    // idiom. The step it now sits under is what tells the user this is a later
    // round.
    title: target.title,
    description: input.description,
    runtimePreference: target.runtimePreference,
    modelHint: target.modelHint,
    effortHint: target.effortHint,
    status: "queued",
    allowedPaths: target.allowedPaths,
    forbiddenPaths: target.forbiddenPaths,
    expectedOutputs: target.expectedOutputs,
    verificationCommands: target.verificationCommands,
    canRunParallel: target.canRunParallel,
    conflictsWith: target.conflictsWith,
    taskClass: target.taskClass,
    writeScopeSource: target.writeScopeSource,
    parallelTrust: target.parallelTrust,
    // Intent flags travel; the OUTCOME flag (peerComms) deliberately does not.
    // Group membership is a property of the step a worker runs in, and
    // prepareWorkerTask re-derives it against the destination step. A copied
    // outcome flag would claim a group chat with no members here. `isolated`
    // travels so a worker asked to stay independent cannot rejoin peer traffic
    // by being re-homed.
    peers: target.peers,
    isolated: target.isolated,
    // Loom identity and the node-derived launch fences survive re-homing for
    // the same reason they survive a runtime fallback: the follow-up is that
    // node's newest work and must run under its fence.
    loomNodeId: target.loomNodeId,
    accessHint: target.accessHint,
    blockedToolsHint: target.blockedToolsHint,
    collabMailDirHint: target.collabMailDirHint,
    // Warm-session linkage. followUpOfTaskId is the provenance link back to the
    // original, and resumeSessionId keeps a session-continuing worker on the
    // same session: the reuse gate is run-scoped, never step-scoped, so
    // re-homing does not disturb it. The original is terminal, so this copy
    // becomes the single live claim on that session.
    followUpOfTaskId: target.id,
    resumeSessionId: target.resumeSessionId,
    // Cumulative, so the fast policy's one-rework cap counts rounds of work
    // rather than rounds per task record.
    verifierFeedbackRounds: (target.verifierFeedbackRounds ?? 0) + 1,
    createdBy: "system",
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  };
  (run.workerTasks ??= []).push(followUp);
  if (!destination.workerTaskIds.includes(followUp.id)) {
    destination.workerTaskIds.push(followUp.id);
  }
  destination.updatedAt = input.timestamp;

  return { stepId: destination.id, taskId: followUp.id, createdStep };
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
