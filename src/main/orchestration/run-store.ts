import { shell } from "electron";
import { promises as fs, createWriteStream } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import { dirname, join } from "node:path";
import type {
  AddRunMessageInput,
  AgentRuntimeModel,
  ApplyPendingMutationsInput,
  DiscardPendingMutationsInput,
  InterruptRunWithMessageInput,
  LaunchWorkerAttemptInput,
  PauseRunInput,
  CancelRunInput,
  PendingMutation,
  PendingWorkerTaskInput,
  ResumeRunInput,
  ReviewDecision,
  CreateStepInput,
  CreateRunInput,
  CreateWorkerTaskInput,
  PlannedStepAgent,
  PrepareWorkerTaskInput,
  RunArtifactPaths,
  RunState,
  SetPlanModeInput,
  SparkCall,
  SparkEvent,
  StartAutopilotInput,
  StepState,
  UpdateRunStatusInput,
  UpdateStepInput,
  UpdateWorkerTaskInput,
  WorkerRuntime,
  WorkerTask,
  WorkerTaskStatus,
  WorkerAttempt,
  WorkerArtifactPaths,
  VerifierVerdict,
  WorkerReport,
  WorkerTaskEnvelope,
} from "@shared/types";
import { appendEvent, eventsPath, listEvents, runDir, runsRoot } from "./event-log";
import { loadSettings } from "../storage";
import {
  buildOpenRouterManagerRequest,
  isStructuredOutputUnsupportedError,
  readOpenRouterConfig,
  requestOpenRouterManagerDecision,
  type OpenRouterConfig,
  type OpenRouterManagerMode,
  type OpenRouterManagerRequest,
  type OpenRouterManagerResult,
  type SparkManagerDecision,
  type SparkManagerStepDecision,
  type SparkManagerTaskDecision,
  type SparkManagerWorkerReportContext,
} from "./openrouter-manager";
import { DEFAULT_MANAGER_PROMPT_PROFILE, loadManagerPromptProfile } from "./prompt-profile";
import {
  finishLangSmithManagerTrace,
  readLangSmithConfig,
  startLangSmithManagerTrace,
  type LangSmithTrace,
} from "./langsmith-tracer";
import * as pty from "../pty-manager";
import { detectAgentRuntimes } from "../agent-runtimes";

const RUN_FILE = "run.json";
const ESC_KEY = "\x1b";
const CONTINUE_INPUT = "continue\r";
const HUMAN_INPUT_PAUSE_REASON = "Spark needs human input before continuing.";

// Lightweight handle for a running worker. The pty itself lives in
// pty-manager (same place user-spawned terminals live); this just remembers
// where to send pause/resume keystrokes and how to kill the pane.
interface ActiveWorkerProcess {
  runId: string;
  stepId?: string;
  workerTaskId: string;
  attemptId: string;
  pid?: number;
  command: string;
  write: (input: string) => void;
  kill: () => void;
}

const activeWorkerProcesses = new Map<string, ActiveWorkerProcess>();
const activeAutopilotCycles = new Map<string, Promise<void>>();
const activeAutopilotPlans = new Map<string, Promise<void>>();
const activeAutopilotReviews = new Map<string, Promise<void>>();
const runWriteQueues = new Map<string, Promise<void>>();

interface RuntimeReroute {
  [key: string]: unknown;
  from: WorkerTask["runtimePreference"];
  to: WorkerTask["runtimePreference"];
  modelHint?: string;
  effortHint?: WorkerTask["effortHint"];
  reason: string;
}

export async function createRun(input: CreateRunInput): Promise<RunState> {
  const now = new Date().toISOString();
  const run: RunState = {
    id: makeId("run"),
    workspaceId: input.workspaceId,
    title: input.title?.trim() || `Run - ${input.workspaceName}`,
    status: "idle",
    artifactDir: "",
    createdAt: now,
    updatedAt: now,
    plans: [],
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    sparkCalls: [],
    humanMessages: [],
    autopilot: {
      status: "idle",
      updatedAt: now,
    },
    planMode: false,
    pendingMutations: [],
  };
  run.artifactDir = runDir(run.id);

  await saveRun(run);
  await appendEvent({
    workspaceId: run.workspaceId,
    runId: run.id,
    type: "run.created",
    message: "Run created",
    payload: {
      title: run.title,
      cwd: input.cwd,
      workspaceName: input.workspaceName,
      artifactDir: run.artifactDir,
    },
  });

  return run;
}

export async function getRun(runId: string): Promise<RunState | null> {
  try {
    const raw = await fs.readFile(runPath(runId), "utf8");
    return normalizeRun(JSON.parse(raw) as RunState);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function listRuns(workspaceId?: string): Promise<RunState[]> {
  let names: string[];
  try {
    names = await fs.readdir(runsRoot());
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const runs = await Promise.all(names.map((name) => getRun(name)));
  return runs
    .filter((run): run is RunState => Boolean(run))
    .filter((run) => !workspaceId || run.workspaceId === workspaceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getRunArtifactPaths(runId: string): Promise<RunArtifactPaths> {
  const run = await getRun(runId);
  return {
    runDir: runDir(runId),
    runJson: runPath(runId),
    eventsJsonl: eventsPath(runId),
    workerArtifacts:
      run?.workerAttempts.map((attempt) => {
        const task = run.workerTasks.find((item) => item.id === attempt.workerTaskId);
        return workerArtifactPaths(runId, task?.stepId, attempt.workerTaskId, attempt.id);
      }) ?? [],
  };
}

export async function appendTestEvent(runId: string, message?: string): Promise<SparkEvent> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const event = await appendEvent({
    workspaceId: run.workspaceId,
    runId: run.id,
    type: "test.event",
    message: message?.trim() || "Test event appended",
    payload: {
      count: (await listEvents(run.id)).length + 1,
      runStatus: run.status,
    },
  });

  run.updatedAt = event.timestamp;
  await saveRun(run);
  return event;
}

export async function startAutopilot(input: StartAutopilotInput): Promise<RunState> {
  let run = input.runId ? await requireRun(input.runId) : null;
  if (!run) {
    run = await createRun({
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName,
      cwd: input.cwd,
      title: input.planTitle ? `Autopilot - ${input.planTitle}` : `Autopilot - ${input.workspaceName}`,
    });
  }

  const planText = input.planText?.trim();
  run = await commitRunChange(run, {
    type: "autopilot.started",
    message: "Autopilot started",
    payload: {
      cwd: input.cwd,
      planPath: input.planPath,
      hasPlanText: Boolean(planText),
    },
    mutate: (draft, timestamp) => {
      draft.status = "running";
      if (planText) {
        const existingPlan = input.planPath
          ? draft.plans.find((plan) => plan.sourceFile === input.planPath)
          : undefined;
        if (existingPlan) {
          existingPlan.rawContent = planText;
          existingPlan.status = "active";
          existingPlan.updatedAt = timestamp;
          draft.planId = existingPlan.id;
        } else {
          const plan = {
            id: makeId("plan"),
            workspaceId: input.workspaceId,
            title: input.planTitle?.trim() || "Selected project plan",
            sourceFile: input.planPath,
            rawContent: planText,
            requirements: [],
            status: "active" as const,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          draft.plans.push(plan);
          draft.planId = plan.id;
        }
      }
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
        status: "running",
        lastAction: "started",
        stopReason: undefined,
        startedAt: draft.autopilot?.startedAt ?? timestamp,
        resumedAt: timestamp,
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
  });

  // Pre-run user note: append before initial planning so the manager's
  // plan_analysis read of run.humanMessages picks it up. Only on first start
  // (no runId passed in); recursive startAutopilot calls already carry the
  // run forward and shouldn't re-append.
  const initialNote = input.initialUserNote?.trim();
  if (!input.runId && initialNote) {
    run = await addRunMessage({
      runId: run.id,
      author: "user",
      kind: "note",
      message: initialNote,
    });
  }

  if (run.steps.length === 0 && run.workerTasks.length === 0) {
    scheduleInitialAutopilotPlanning(run.id, input);
    return run;
  }

  run = await requireRun(run.id);
  // Plan-mode short-circuit: if the manager queued worker dispatches into
  // pendingMutations (instead of creating worker tasks), the autopilot has
  // nothing to launch yet — but we DON'T want to fall into the
  // "no ready task / ask user" branch below, because the run is intentionally
  // waiting on the user's review. Idle until applyPendingMutations runs.
  if (run.planMode && (run.pendingMutations?.length ?? 0) > 0) {
    return run;
  }
  const tasks = pickAutopilotTasks(run);
  if (tasks.length === 0) {
    return askHumanQuestion(run.id, "I could not find a ready task to run. Please clarify the next goal.");
  }

  const launchQueue: Array<{ task: WorkerTask; attemptId: string }> = [];
  for (const task of tasks) {
    let attemptId = run.workerAttempts
      .slice()
      .reverse()
      .find((item) => item.workerTaskId === task.id && (item.status === "prompt_ready" || item.status === "failed"))
      ?.id;
    if (!attemptId) {
      const envelope = await prepareWorkerTask({
        runId: run.id,
        workerTaskId: task.id,
        cwd: input.cwd,
      });
      attemptId = envelope.attemptId;
      run = await requireRun(run.id);
    }

    if (activeAutopilotCycles.has(autopilotCycleKey(run.id, attemptId))) continue;
    launchQueue.push({ task, attemptId });
  }

  run = await requireRun(run.id);
  const scheduledAttemptIds: string[] = [];
  for (const item of launchQueue) {
    if (activeAutopilotCycles.has(autopilotCycleKey(run.id, item.attemptId))) continue;
    const latestTask = run.workerTasks.find((task) => task.id === item.task.id) ?? item.task;
    scheduledAttemptIds.push(item.attemptId);
    await appendEvent({
      workspaceId: run.workspaceId,
      runId: run.id,
      stepId: latestTask.stepId,
      workerTaskId: latestTask.id,
      attemptId: item.attemptId,
      type: "autopilot.cycle_scheduled",
      message: "Autopilot worker cycle scheduled",
      payload: {
        workerTasks: run.workerTasks.length,
        workerAttempts: run.workerAttempts.length,
      },
    });
  }
  scheduleAutopilotCycles(run.id, scheduledAttemptIds);

  return scheduledAttemptIds.length > 0 ? await requireRun(run.id) : run;
}

function scheduleInitialAutopilotPlanning(
  runId: string,
  input: StartAutopilotInput,
  opts?: { afterCurrent?: boolean },
): void {
  const existing = activeAutopilotPlans.get(runId);
  if (existing && !opts?.afterCurrent) return;

  const start = existing && opts?.afterCurrent ? existing.catch(() => undefined) : Promise.resolve();
  const cycle = start
    .then(async () => {
      const latest = await getRun(runId);
      if (!latest || latest.status === "paused" || latest.status === "cancelled") return;
      await runInitialAutopilotPlanning(runId, input);
    })
    .catch(async (err) => {
      await markInitialAutopilotPlanningFailed(runId, err);
    })
    .finally(() => {
      if (activeAutopilotPlans.get(runId) === cycle) {
        activeAutopilotPlans.delete(runId);
      }
    });
  activeAutopilotPlans.set(runId, cycle);
  void cycle;
}

async function runInitialAutopilotPlanning(runId: string, input: StartAutopilotInput): Promise<void> {
  let run = await requireRun(runId);
  if (run.status === "paused" || run.status === "cancelled") return;

  let managerPlannedRun = await askOpenRouterManagerForInitialTasks(run, input.cwd);
  if (
    managerPlannedRun &&
    managerPlannedRun.status !== "paused" &&
    managerPlannedRun.status !== "cancelled" &&
    managerPlannedRun.steps.length > 0
  ) {
    // If plan_analysis lands on a brake as the first step, resolve it and
    // replan before asking step_planning for worker prompts.
    managerPlannedRun = await resolveActiveBrakeAndReplan(managerPlannedRun, input.cwd);
  }
  if (
    managerPlannedRun &&
    managerPlannedRun.status !== "paused" &&
    managerPlannedRun.status !== "cancelled" &&
    managerPlannedRun.steps.length > 0 &&
    managerPlannedRun.workerTasks.length === 0
  ) {
    const fastPath = await tryTrivialFastPathStepPlanning(managerPlannedRun);
    managerPlannedRun = fastPath
      ?? (await askOpenRouterManager(managerPlannedRun, input.cwd, "step_planning"));
  }

  if (!managerPlannedRun && !manualFallbackEnabled()) {
    await askHumanQuestion(
      run.id,
      "OpenRouter is not configured, so Spark cannot plan Claude/Codex worker tasks yet. Add the API key in Settings, then run the plan again.",
    );
    return;
  }

  run = managerPlannedRun ?? (await createFallbackAutopilotTask(run, input));
  if (run.status === "paused" || run.status === "cancelled") return;
  await startAutopilot({ ...input, runId: run.id });
}

async function markInitialAutopilotPlanningFailed(runId: string, err: unknown): Promise<void> {
  const run = await getRun(runId);
  if (!run) return;
  const error = err instanceof Error ? err.message : String(err);
  await commitRunChange(run, {
    type: "autopilot.planning_failed",
    message: `Autopilot planning failed: ${error}`,
    payload: { error },
    mutate: (draft, timestamp) => {
      draft.status = "failed";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
        status: "failed",
        lastAction: "manager_planning_failed",
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
  });
}

async function runAutopilotWorkerCycle(runId: string, attemptId: string): Promise<void> {
  let launched: RunState;
  let cwd = "";
  try {
    launched = await launchWorkerAttempt({
      runId,
      attemptId,
    });
    cwd = launched.workerAttempts.find((attempt) => attempt.id === attemptId)?.cwd ?? "";
  } catch (err) {
    await markAutopilotCycleFailed(runId, attemptId, err);
    return;
  }

  const latest = await requireRun(launched.id);
  if (latest.status === "paused") return;
  const hasOtherActiveCycles = hasOtherAutopilotCycles(runId, attemptId);
  const hasOtherActiveWorkers = activeWorkersForRun(runId).some((worker) => worker.attemptId !== attemptId);

  await commitRunChange(latest, {
    type: "autopilot.cycle_completed",
    message: "Autopilot completed one execution cycle",
    payload: {
      workerTasks: latest.workerTasks.length,
      workerAttempts: latest.workerAttempts.length,
      waitingForOtherWorkers: hasOtherActiveCycles || hasOtherActiveWorkers,
    },
    mutate: (draft, timestamp) => {
      draft.status = hasOtherActiveCycles || hasOtherActiveWorkers ? "running" : "reviewing";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
        status: hasOtherActiveCycles || hasOtherActiveWorkers ? "running" : "blocked",
        lastAction:
          hasOtherActiveCycles || hasOtherActiveWorkers
            ? "worker_cycle_completed_waiting_for_parallel_workers"
            : "worker_cycle_completed_needs_manager_review",
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
  });

  if (!hasOtherActiveCycles && !hasOtherActiveWorkers) {
    scheduleAutopilotReview(runId, cwd);
  }
}

function scheduleAutopilotCycles(runId: string, attemptIds: string[]): void {
  for (const attemptId of attemptIds) {
    const key = autopilotCycleKey(runId, attemptId);
    if (activeAutopilotCycles.has(key)) continue;

    const cycle = Promise.resolve()
      .then(async () => {
        const run = await getRun(runId);
        if (!run || run.status === "paused" || run.status === "cancelled") return;
        await runAutopilotWorkerCycle(runId, attemptId);
      })
      .catch(async (err) => {
        try {
          await markAutopilotCycleFailed(runId, attemptId, err);
        } catch {
          /* run may have been deleted while the background cycle was failing */
        }
      })
      .finally(() => {
        activeAutopilotCycles.delete(key);
      });

    activeAutopilotCycles.set(key, cycle);
    void cycle;
  }
}

function scheduleAutopilotReview(runId: string, cwd: string): void {
  if (activeAutopilotReviews.has(runId)) return;
  const review = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      runAutopilotManagerReview(runId, cwd).then(resolve, reject);
    }, 0);
  })
    .catch(async (err) => {
      await markAutopilotCycleFailed(runId, "manager-review", err);
    })
    .finally(() => {
      activeAutopilotReviews.delete(runId);
    });
  activeAutopilotReviews.set(runId, review);
  void review;
}

async function runAutopilotManagerReview(runId: string, cwd: string): Promise<void> {
  let run = await requireRun(runId);
  if (run.status === "paused" || run.status === "cancelled") return;
  if (hasAutopilotCycles(runId) || activeWorkersForRun(runId).length > 0) return;

  const settings = await loadSettings();
  const config = readOpenRouterConfig(settings);
  if (!config) {
    if (manualFallbackEnabled()) {
      await appendEvent({
        workspaceId: run.workspaceId,
        runId: run.id,
        type: "autopilot.manager_review_skipped",
        message: "Spark manager review skipped because OpenRouter is not configured",
        payload: {
          reason: "manual_fallback",
        },
      });
      return;
    }
    await askHumanQuestion(
      run.id,
      "Worker results are ready, but OpenRouter is not configured for Spark manager review. Add the API key in Settings, then resume the run.",
    );
    return;
  }

  // Trivial fast-path: skip the manager review LLM call when decideWorkerReport
  // already accepted everything and every step is complete. The manager review
  // on a trivial happy-path is a rubber stamp; cut it.
  const fastPathReview = await tryTrivialFastPathReview(run);
  if (fastPathReview) return;

  // Standard-tier clean-impl fast-path: when an impl worker on a STANDARD run
  // reports complete and Spark itself can re-run its verificationCommands with
  // every command exiting 0, skip the verifier follow-up entirely. The verifier
  // is a safety net for behavioral correctness; if the impl's own checks pass
  // the net rarely catches anything new and burns ~100s of wall. We still fall
  // through to the manager review when any command fails.
  const standardFastPath = await tryStandardCleanImplFastPathReview(run, cwd);
  if (standardFastPath) {
    run = standardFastPath;
    if (run.status === "complete" || run.status === "failed" || run.status === "cancelled") return;
    // Step is complete but more steps remain — skip the worker_result_review
    // LLM call (the whole point of this fast-path) and jump straight to
    // step_planning for the next step.
  } else {
    // Loop the worker_result_review when the manager hallucinates a `complete`
    // verdict despite pending work (completion_refused). On the first refusal
    // the autopilot used to fall through to pickAutopilotTasks — which
    // returned empty because nothing had advanced — and the run hung silently
    // until budget exhaustion. The completion_refused failsafe at
    // applySparkManagerDecision force-accepts needs_review tasks once
    // `consecutiveCompletionRefusals` >= 2, but that path is only reached when
    // worker_result_review is invoked again. Bound the loop to a small number
    // of iterations so a model that stays stuck still gets force-landed.
    const REVIEW_REPROMPT_CAP = 3;
    for (let attempt = 0; attempt < REVIEW_REPROMPT_CAP; attempt++) {
      run = await askOpenRouterManager(run, cwd, "worker_result_review") ?? run;
      if (run.status === "paused" || run.status === "cancelled" || run.status === "complete") return;
      const lastAction = run.autopilot?.lastAction;
      if (lastAction !== "completion_refused") break;
    }
  }
  // Brake checkpoint: if the next active step is a brake, resolve it and
  // re-invoke plan_analysis so the manager can extend the plan with prior
  // worker reports as evidence.
  run = await resolveActiveBrakeAndReplan(run, cwd);
  if (run.status === "paused" || run.status === "cancelled" || run.status === "complete") return;
  // After advancing past a worker (and possibly a brake), the next active step
  // is usually a worker_batch that has plannedAgents but no worker tasks yet.
  // Call step_planning so the manager turns those plannedAgents into worker
  // task prompts before we try to launch.
  let tasks = pickAutopilotTasks(run);
  if (tasks.length === 0 && needsStepPlanning(run)) {
    const fastPathPlan = await tryTrivialFastPathStepPlanning(run);
    run = fastPathPlan ?? ((await askOpenRouterManager(run, cwd, "step_planning")) ?? run);
    if (run.status === "paused" || run.status === "cancelled" || run.status === "complete") return;
    tasks = pickAutopilotTasks(run);
  }
  if (tasks.length === 0) {
    // No work left for autopilot to do. If that's because every remaining
    // worker task hit MAX_WORKER_ATTEMPTS, fail the run loudly instead of
    // silently stalling at status=running until budget exhaustion.
    const cappedTasks = run.workerTasks.filter(
      (task) => task.status === "failed" && countWorkerAttempts(run, task.id) >= MAX_WORKER_ATTEMPTS,
    );
    if (cappedTasks.length > 0) {
      await commitRunChange(run, {
        type: "autopilot.retry_cap_reached",
        message: `Autopilot stopped: ${cappedTasks.length} worker task(s) exceeded ${MAX_WORKER_ATTEMPTS} attempts`,
        payload: {
          maxAttempts: MAX_WORKER_ATTEMPTS,
          cappedTaskIds: cappedTasks.map((t) => t.id),
        },
        mutate: (draft, timestamp) => {
          draft.status = "failed";
          draft.autopilot = {
            ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
            status: "failed",
            lastAction: "retry_cap_reached",
            stopReason: `worker_retry_cap_${MAX_WORKER_ATTEMPTS}`,
            updatedAt: timestamp,
          };
          draft.updatedAt = timestamp;
        },
      });
    }
    return;
  }

  await startAutopilot({
    workspaceId: run.workspaceId,
    workspaceName: run.title,
    cwd,
    runId: run.id,
  });
}

async function markAutopilotCycleFailed(runId: string, attemptId: string, err: unknown): Promise<void> {
  const run = await getRun(runId);
  if (!run) return;
  const error = err instanceof Error ? err.message : String(err);
  await commitRunChange(run, {
    type: "autopilot.cycle_failed",
    message: `Autopilot worker cycle failed: ${error}`,
    payload: {
      attemptId,
      error,
    },
    mutate: (draft, timestamp) => {
      draft.status = "failed";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
        status: "failed",
        lastAction: "worker_cycle_failed",
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
  });
}

function autopilotCycleKey(runId: string, attemptId: string): string {
  return `${runId}:${attemptId}`;
}

function hasOtherAutopilotCycles(runId: string, attemptId: string): boolean {
  const currentKey = autopilotCycleKey(runId, attemptId);
  return [...activeAutopilotCycles.keys()].some((key) => key.startsWith(`${runId}:`) && key !== currentKey);
}

function hasAutopilotCycles(runId: string): boolean {
  return [...activeAutopilotCycles.keys()].some((key) => key.startsWith(`${runId}:`));
}

function manualFallbackEnabled(): boolean {
  return process.env.SPARK_ENABLE_MANUAL_FALLBACK === "1";
}

function normalizeOpenRouterManagerMode(
  mode: SparkCall["mode"],
): "plan_analysis" | "step_planning" | "worker_result_review" {
  if (mode === "worker_result_review") return "worker_result_review";
  if (mode === "plan_analysis") return "plan_analysis";
  return "step_planning";
}

async function safeStartLangSmithManagerTrace(
  input: Parameters<typeof startLangSmithManagerTrace>[0],
): Promise<LangSmithTrace | null> {
  try {
    return await startLangSmithManagerTrace(input);
  } catch (err) {
    console.warn("[langsmith] failed to start manager trace:", err);
    return null;
  }
}

async function safeFinishLangSmithManagerTrace(
  input: Parameters<typeof finishLangSmithManagerTrace>[0],
): Promise<void> {
  try {
    await finishLangSmithManagerTrace(input);
  } catch (err) {
    console.warn("[langsmith] failed to finish manager trace:", err);
  }
}

async function createFallbackAutopilotTask(run: RunState, input: StartAutopilotInput): Promise<RunState> {
  run = await createStep({
    runId: run.id,
    title: "Understand project plan",
    goal: input.planText?.trim() || "Read the project plan and decide the first concrete implementation task.",
    acceptanceCriteria: ["A worker task is prepared from the current project plan."],
    verificationCommands: ["npm run typecheck"],
  });

  const activeStep = pickAutopilotStep(run);
  return createWorkerTask({
    runId: run.id,
    stepId: activeStep?.id,
    title: "Autopilot task 1",
    description:
      input.planText?.trim() ||
      "Inspect the current project state and produce the next concrete implementation report.",
    runtimePreference: "manual",
    expectedOutputs: ["A final report artifact explaining what was done and what remains."],
    verificationCommands: ["npm run typecheck"],
    createdBy: "spark",
  });
}

async function askOpenRouterManagerForInitialTasks(run: RunState, cwd: string): Promise<RunState | null> {
  return askOpenRouterManager(run, cwd, "plan_analysis");
}

// Brake support: when the next active step has kind="brake", treat it as a
// no-op checkpoint. Mark it complete (no workers run) and re-invoke
// plan_analysis with the run's accumulated worker reports in context, so the
// manager can extend the plan based on what's been learned. The manager is
// instructed (via plan_analysis modeRules) to only emit *new* steps for the
// remaining work, so we append rather than replace.
//
// Loops are bounded: the same brake will not come back as the active step
// after resolution because we mark it complete. If the manager were to emit
// another brake as the very next step, this still terminates because
// pickAutopilotStep advances and we call ourselves only once per autopilot
// hop (initial planning + each worker_result_review).
async function resolveActiveBrakeAndReplan(run: RunState, cwd: string): Promise<RunState> {
  const next = pickAutopilotStep(run);
  if (!next || (next.kind ?? "worker_batch") !== "brake") return run;

  const updated = await updateStep({
    runId: run.id,
    stepId: next.id,
    status: "complete",
    reviewSummary: "Brake checkpoint reached; replanning downstream steps with accumulated worker evidence.",
  });
  await appendEvent({
    workspaceId: updated.workspaceId,
    runId: updated.id,
    stepId: next.id,
    type: "autopilot.brake_resolved",
    message: `Brake step "${next.title}" resolved; replanning with worker evidence`,
    payload: { stepId: next.id, stepIndex: next.index },
  });
  return (await askOpenRouterManager(updated, cwd, "plan_analysis")) ?? updated;
}

// Retry the OpenRouter manager fetch on transient errors. Terminal failures
// (auth, structured-output-unsupported, malformed config) re-throw immediately
// so the outer catch in askOpenRouterManager handles them as before. Bounded
// to 3 attempts with exponential backoff so a single provider outage costs
// ~6s rather than hanging the autopilot loop for the rest of the budget.
const MANAGER_REQUEST_MAX_ATTEMPTS = 3;
const MANAGER_REQUEST_BACKOFF_BASE_MS = 1500;

function isTerminalManagerError(message: string): boolean {
  if (isStructuredOutputUnsupportedError(message)) return true;
  if (/\b(401|403)\b/.test(message)) return true;
  if (/invalid api key|unauthor[is]z/i.test(message)) return true;
  if (/no api key|missing api key|not configured/i.test(message)) return true;
  return false;
}

async function requestManagerWithRetries(
  config: OpenRouterConfig,
  requestBody: OpenRouterManagerRequest,
  managerMode: OpenRouterManagerMode,
): Promise<OpenRouterManagerResult> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MANAGER_REQUEST_MAX_ATTEMPTS; attempt++) {
    try {
      return await requestOpenRouterManagerDecision(config, requestBody, managerMode);
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      if (isTerminalManagerError(message)) throw err;
      if (attempt >= MANAGER_REQUEST_MAX_ATTEMPTS) throw err;
      const backoffMs = MANAGER_REQUEST_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastErr ?? new Error("manager request failed without explicit error");
}

async function askOpenRouterManager(
  run: RunState,
  cwd: string,
  mode: SparkCall["mode"],
): Promise<RunState | null> {
  const settings = await loadSettings();
  const config = readOpenRouterConfig(settings);
  if (!config) return null;
  const langSmithConfig = readLangSmithConfig(settings);

  const callId = makeId("spark");
  const callDir = join(runDir(run.id), "spark-calls", callId);
  const requestPath = join(callDir, "request.json");
  const responsePath = join(callDir, "response.json");
  const parsedJsonPath = join(callDir, "parsed-decision.json");
  const workerReports = await collectWorkerReportContext(run);
  const managerMode = normalizeOpenRouterManagerMode(mode);
  const availableRuntimes = await detectAgentRuntimes().catch(() => []);
  const requestBody = buildOpenRouterManagerRequest({
    run,
    cwd,
    model: config.model,
    mode: managerMode,
    workerReports,
    availableRuntimes,
  });
  await fs.mkdir(callDir, { recursive: true });
  await fs.writeFile(requestPath, JSON.stringify(requestBody, null, 2), "utf8");

  const startedAt = new Date().toISOString();
  const sparkCall: SparkCall = {
    id: callId,
    runId: run.id,
    mode,
    model: config.model,
    status: "started",
    requestPath,
    responsePath,
    parsedJsonPath,
    createdAt: startedAt,
  };
  run.sparkCalls.push(sparkCall);
  run.settingsSnapshot = {
    ...(run.settingsSnapshot ?? {}),
    openRouterModel: config.model,
    openRouterBaseUrl: config.baseUrl,
    openRouterStructuredOutputFallbackModel: config.structuredOutputFallbackModel,
    langSmithProject: langSmithConfig?.project,
    langSmithEndpoint: langSmithConfig?.endpoint,
  };
  run.updatedAt = startedAt;
  await saveRun(run);
  await appendEvent({
    timestamp: startedAt,
    workspaceId: run.workspaceId,
    runId: run.id,
    sparkCallId: callId,
    type: "spark_call.started",
    message: `Spark manager call started: ${config.model}`,
    payload: {
      mode,
      model: config.model,
      requestPath,
    },
  });

  let langSmithTrace: LangSmithTrace | null = null;
  try {
    langSmithTrace = await safeStartLangSmithManagerTrace({
      config: langSmithConfig,
      runId: run.id,
      workspaceId: run.workspaceId,
      sparkCallId: callId,
      mode,
      requestBody,
    });
    // Transient OpenRouter / provider errors (network, 5xx, provider-routed
    // backends crashing mid-request) used to bubble straight to the catch
    // block, which returns null and exits the autopilot loop silently —
    // observed in practice as multi-hour run hangs after a single fireworks
    // outage. Retry the inner request a small number of times with backoff;
    // re-throw structured-output-unsupported and other terminal errors
    // unchanged so the outer catch still routes them to the operator.
    const result = await requestManagerWithRetries(config, requestBody, managerMode);
    await safeFinishLangSmithManagerTrace({
      config: langSmithConfig,
      trace: langSmithTrace,
      output: {
        decision: result.decision,
        rawResponse: result.rawResponse,
        durationMs: result.durationMs,
        model: result.model,
        fallbackFrom: result.fallbackFrom,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
      },
    });
    await Promise.all([
      fs.writeFile(responsePath, JSON.stringify(result.rawResponse, null, 2), "utf8"),
      fs.writeFile(parsedJsonPath, JSON.stringify(result.decision, null, 2), "utf8"),
    ]);

    const latest = await requireRun(run.id);
    const targetCall = latest.sparkCalls.find((call) => call.id === callId);
    const completedAt = new Date().toISOString();
    if (targetCall) {
      targetCall.status = "completed";
      targetCall.model = result.model;
      targetCall.durationMs = result.durationMs;
      targetCall.promptTokens = result.promptTokens;
      targetCall.completionTokens = result.completionTokens;
      targetCall.completedAt = completedAt;
    }
    latest.updatedAt = completedAt;
    await saveRun(latest);
    if (result.fallbackFrom) {
      await appendEvent({
        timestamp: completedAt,
        workspaceId: latest.workspaceId,
        runId: latest.id,
        sparkCallId: callId,
        type: "spark_call.model_fallback",
        message: `Spark manager retried with structured-output fallback model: ${result.model}`,
        payload: {
          mode,
          requestedModel: result.fallbackFrom,
          fallbackModel: result.model,
          reason: "requested model did not support strict JSON Schema structured outputs",
        },
      });
    }
    await appendEvent({
      timestamp: completedAt,
      workspaceId: latest.workspaceId,
      runId: latest.id,
      sparkCallId: callId,
      type: "spark_call.completed",
      message: `Spark manager call completed: ${result.decision.status}`,
      payload: {
        mode,
        model: result.model,
        requestedModel: result.fallbackFrom ?? config.model,
        fallbackFrom: result.fallbackFrom,
        durationMs: result.durationMs,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        parsedJsonPath,
        decision: result.decision,
      },
    });

    return applySparkManagerDecision(latest, result.decision, mode);
  } catch (err) {
    const latest = await requireRun(run.id);
    const targetCall = latest.sparkCalls.find((call) => call.id === callId);
    const completedAt = new Date().toISOString();
    const error = err instanceof Error ? err.message : String(err);
    await safeFinishLangSmithManagerTrace({
      config: langSmithConfig,
      trace: langSmithTrace,
      error,
    });
    if (targetCall) {
      targetCall.status = "failed";
      targetCall.error = error;
      targetCall.completedAt = completedAt;
      targetCall.durationMs = Date.now() - Date.parse(startedAt);
    }
    latest.updatedAt = completedAt;
    await saveRun(latest);
    await appendEvent({
      timestamp: completedAt,
      workspaceId: latest.workspaceId,
      runId: latest.id,
      sparkCallId: callId,
      type: "spark_call.failed",
      message: `Spark manager call failed: ${error}`,
      payload: {
        mode,
        model: config.model,
        error,
      },
    });
    if (isStructuredOutputUnsupportedError(error)) {
      return askHumanQuestion(
        latest.id,
        [
          "The selected OpenRouter manager model does not support strict JSON Schema structured outputs.",
          "Choose a manager model that supports `response_format: json_schema` in Settings, then resume the run.",
        ].join(" "),
      );
    }
    return null;
  }
}

// Top-tier worker assignments for trivial-classified runs. The verifier
// follow-up loop (which makes mid-tier workers safe) is skipped on trivial
// runs, so the implementation worker is the only check on the work and must
// have the stronger 'taste' that catches all distinct issues in one pass.
const TRIVIAL_TOP_TIER_BY_RUNTIME: Record<string, { modelHint: string; effortHint: WorkerTask["effortHint"] }> = {
  claude: { modelHint: "claude-opus-4-7", effortHint: "high" },
  codex: { modelHint: "gpt-5.5", effortHint: "high" },
};

// Top-tier model identifiers (post-normalization). Anything else for a
// claude/codex runtime is treated as mid-tier and gets promoted on trivial.
// We compare on the base model only — `@<effort>` suffixes are stripped first
// because grok-4.3 has shipped both `"claude-sonnet-4-6"` and
// `"claude-sonnet-4-6@medium"` as the modelHint string across runs, and an
// allow-list keyed on raw strings silently misses the suffixed variant.
const TOP_TIER_MODEL_BASES = new Set([
  "claude-opus-4-7",
  "opus",
  "gpt-5.5",
]);

function normalizeModelHint(hint: string | undefined): string {
  if (!hint) return "";
  const at = hint.indexOf("@");
  return (at >= 0 ? hint.slice(0, at) : hint).trim();
}

function isTopTierModel(hint: string | undefined): boolean {
  return TOP_TIER_MODEL_BASES.has(normalizeModelHint(hint));
}

function promoteForTrivial(agent: PlannedStepAgent): PlannedStepAgent {
  if (agent.taskClass === "skeleton" || agent.taskClass === "verifier") return agent;
  const floor = TRIVIAL_TOP_TIER_BY_RUNTIME[agent.runtimePreference];
  if (!floor) return agent;
  const needsModelBump = !isTopTierModel(agent.modelHint);
  const needsEffortBump = agent.effortHint !== "high" && agent.effortHint !== "xhigh" && agent.effortHint !== "max";
  if (!needsModelBump && !needsEffortBump) return agent;
  return {
    ...agent,
    modelHint: needsModelBump ? floor.modelHint : agent.modelHint,
    effortHint: needsEffortBump ? floor.effortHint : agent.effortHint,
  };
}

function promoteTaskForTrivial(task: SparkManagerTaskDecision): SparkManagerTaskDecision {
  if (task.taskClass === "skeleton" || task.taskClass === "verifier") return task;
  const floor = TRIVIAL_TOP_TIER_BY_RUNTIME[task.runtimePreference];
  if (!floor) return task;
  const needsModelBump = !isTopTierModel(task.modelHint);
  const needsEffortBump = task.effortHint !== "high" && task.effortHint !== "xhigh";
  if (!needsModelBump && !needsEffortBump) return task;
  return {
    ...task,
    modelHint: needsModelBump ? floor.modelHint : task.modelHint,
    effortHint: needsEffortBump ? floor.effortHint : task.effortHint,
  };
}

// Trivial fast-path: synthesize the worker task locally instead of round-tripping
// through manager call 2 (step_planning). The manager has zero filesystem access,
// so its task description guesses file paths — verified on bjgp3uso7, where the
// manager guessed cli.js but the fix landed in parser.js / rules/*. The worker
// (Codex/Claude) has full filesystem access and writes a more accurate plan
// internally. Spark's job is to relay intent, not invent files.
//
// Only fires when:
//   - run.taskComplexity === 'trivial'
//   - active step has exactly 1 plannedAgent (parallel work goes through manager)
//   - active step has no queueable worker tasks yet
//   - the agent is non-verifier and runs on claude/codex
//
// Saves ~3 minutes (manager call 2 was 2992 reasoning tokens / ~3 min on
// bjgp3uso7).
async function tryTrivialFastPathStepPlanning(run: RunState): Promise<RunState | null> {
  if (run.taskComplexity !== "trivial") return null;
  const activeStep = pickAutopilotStep(run);
  if (!activeStep) return null;
  if ((activeStep.kind ?? "worker_batch") !== "worker_batch") return null;
  const agents = activeStep.plannedAgents ?? [];
  if (agents.length !== 1) return null;
  const agent = agents[0];
  if (agent.taskClass === "verifier") return null;
  if (agent.runtimePreference !== "claude" && agent.runtimePreference !== "codex") {
    return null;
  }
  const queueable: WorkerTaskStatus[] = ["created", "queued", "retry_queued"];
  const hasQueueable = run.workerTasks.some(
    (task) => task.stepId === activeStep.id && queueable.includes(task.status),
  );
  if (hasQueueable) return null;

  const acceptanceLines = (activeStep.acceptanceCriteria ?? []).map((c) => `- ${c}`);
  const description = [
    "GOAL",
    activeStep.goal || activeStep.title,
    "",
    "ACCEPTANCE CRITERIA",
    ...(acceptanceLines.length > 0 ? acceptanceLines : ["- Worker completes the goal above and reports evidence."]),
    "",
    "WORKING METHOD",
    "Spark Agent (the orchestrator that dispatched you) has no filesystem access and knows nothing concrete about this codebase. It's just relaying intent. You have full access — explore the repo yourself.",
    "Use Glob/Grep/Read to find the actual files involved. Do not assume any file paths from this brief.",
    "Identify the real bugs from the codebase, not from the brief. Fix them. Keep changes scoped.",
    "",
    "VERIFICATION",
    "Discover whatever existing tests, lints, or build commands the repo provides for the modules you change, and run them yourself before reporting complete. Capture their literal stdout (truncated to 600 chars) in proof[] — one entry per command — so the orchestrator can confirm without re-running.",
    "If no tests exist for the area you touched, write a minimal probe (or a one-shot CLI invocation) that demonstrates the fix and include its stdout in proof[].",
  ].join("\n");

  const synthesizedTitle = (agent.summary?.trim() || activeStep.title).slice(0, 200);

  let next = await createWorkerTask({
    runId: run.id,
    stepId: activeStep.id,
    title: synthesizedTitle,
    description,
    runtimePreference: agent.runtimePreference,
    modelHint: agent.modelHint,
    effortHint: agent.effortHint,
    expectedOutputs: [],
    verificationCommands: [],
    canRunParallel: false,
    conflictsWith: [],
    taskClass: agent.taskClass ?? "feature",
    createdBy: "spark",
  });

  await appendEvent({
    workspaceId: next.workspaceId,
    runId: next.id,
    stepId: activeStep.id,
    type: "spark_manager.trivial_fast_path_step_planning",
    message: "Skipped manager step_planning call: trivial+single-agent → synthesized worker task locally",
    payload: {
      stepId: activeStep.id,
      runtime: agent.runtimePreference,
      modelHint: agent.modelHint,
      effortHint: agent.effortHint,
      taskClass: agent.taskClass ?? "feature",
    },
  });

  return next;
}

// Trivial fast-path: skip the manager's worker_result_review LLM call when
// decideWorkerReport already accepted every task locally and every step is
// already complete. On bjgp3uso7 manager call 3 spent 514 tokens producing
// "looks complete, accept run" — a rubber stamp the autopilot can apply
// deterministically.
//
// Returns the run with status=complete on success, null otherwise.
async function tryTrivialFastPathReview(run: RunState): Promise<RunState | null> {
  if (run.taskComplexity !== "trivial") return null;
  if (run.status === "complete" || run.status === "failed" || run.status === "cancelled") {
    return null;
  }
  if (run.workerTasks.length === 0) return null;
  const everyTaskAccepted = run.workerTasks.every(
    (t) => t.status === "accepted" || t.status === "cancelled",
  );
  if (!everyTaskAccepted) return null;
  if (run.steps.length === 0) return null;
  const everyStepDone = run.steps.every(
    (s) => s.status === "complete" || s.status === "failed" || s.status === "skipped",
  );
  if (!everyStepDone) return null;

  return commitRunChange(run, {
    type: "spark_manager.trivial_fast_path_review",
    message: "Skipped manager worker_result_review call: trivial run with all tasks accepted and all steps complete",
    payload: {
      taskCount: run.workerTasks.length,
      stepCount: run.steps.length,
    },
    mutate: (draft, timestamp) => {
      draft.status = "complete";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
        status: "complete",
        lastAction: "trivial_fast_path_review_skipped",
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
  });
}

// Run an implementation worker's verificationCommands directly from Spark's
// process so we can confirm the worker's report claims with deterministic exit
// codes — no LLM in the loop. Used by tryStandardCleanImplFastPathReview to
// decide whether the verifier follow-up is necessary.
//
// Per-command timeout caps the total cost when a command hangs (e.g. a test
// that opens an interactive prompt). Output is captured but only the first
// 600 chars are surfaced — same budget the worker uses in its proof[] entries.
async function runVerificationCommandsLocally(
  commands: string[],
  cwd: string,
  perCommandTimeoutMs = 90_000,
): Promise<Array<{ command: string; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>> {
  const results: Array<{ command: string; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> = [];
  for (const command of commands) {
    const trimmed = command.trim();
    if (!trimmed) continue;
    const result = await new Promise<{ command: string; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
      const child = spawnChild(trimmed, {
        cwd,
        shell: true,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch { /* ignore */ }
      }, perCommandTimeoutMs);
      child.stdout?.on("data", (chunk) => {
        if (stdout.length < 8000) stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 8000) stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ command: trimmed, exitCode: null, stdout, stderr: stderr + `\nspawn error: ${err.message}`, timedOut });
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({
          command: trimmed,
          exitCode: code,
          stdout: stdout.slice(0, 600),
          stderr: stderr.slice(0, 600),
          timedOut,
        });
      });
    });
    results.push(result);
  }
  return results;
}

// Standard-tier deterministic verifier-skip. After the impl worker on a
// standard-complexity run has been accepted and BEFORE we call the
// worker_result_review LLM (which would queue a verifier task), re-run the
// impl's verificationCommands ourselves. If every command exits 0, mark the
// step complete and let the autopilot loop advance — saving the verifier's
// ~100s of wall on clean runs. If anything fails, return null so the existing
// manager-review path runs and queues the verifier as a corrective.
//
// We deliberately DON'T do this for complex tier (two peer verifiers exist for
// a reason: catch what one model misses) or trivial tier (already skipped).
async function tryStandardCleanImplFastPathReview(
  run: RunState,
  cwd: string,
): Promise<RunState | null> {
  if (run.taskComplexity !== "standard") return null;
  if (run.status === "complete" || run.status === "failed" || run.status === "cancelled") {
    return null;
  }
  // Find the most recent accepted impl worker (taskClass != verifier).
  const acceptedImpls = run.workerTasks
    .filter((t) => t.status === "accepted" && t.taskClass !== "verifier")
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  if (acceptedImpls.length === 0) return null;
  const impl = acceptedImpls[0];
  if (!impl.stepId) return null;
  // Skip when a verifier already exists for the impl's step (manager already
  // queued one in a prior cycle, or the prior impl was itself a verifier).
  const verifierExists = run.workerTasks.some(
    (t) => t.stepId === impl.stepId && t.taskClass === "verifier",
  );
  if (verifierExists) return null;
  // Skip when the impl's step already wrapped (nothing to short-circuit).
  const step = run.steps.find((s) => s.id === impl.stepId);
  if (!step) return null;
  if (["complete", "failed", "skipped"].includes(step.status)) return null;
  // Skip when there are still active sibling tasks on the same step — wait for
  // them to settle before we decide whether the step is clean.
  const siblingActive = run.workerTasks.some(
    (t) =>
      t.stepId === impl.stepId &&
      t.id !== impl.id &&
      ["created", "queued", "claimed", "running", "needs_review", "retry_queued"].includes(t.status),
  );
  if (siblingActive) return null;
  const commands = (impl.verificationCommands ?? []).map((c) => c.trim()).filter(Boolean);
  if (commands.length === 0) return null;

  await appendEvent({
    workspaceId: run.workspaceId,
    runId: run.id,
    stepId: impl.stepId,
    type: "spark_manager.standard_clean_impl_check_started",
    message: `Re-running ${commands.length} verificationCommand(s) deterministically to decide whether the verifier is needed`,
    payload: { workerTaskId: impl.id, commands },
  });

  const results = await runVerificationCommandsLocally(commands, cwd);
  const allClean = results.length > 0 && results.every((r) => r.exitCode === 0);

  await appendEvent({
    workspaceId: run.workspaceId,
    runId: run.id,
    stepId: impl.stepId,
    type: allClean
      ? "spark_manager.standard_clean_impl_check_passed"
      : "spark_manager.standard_clean_impl_check_failed",
    message: allClean
      ? "Deterministic re-run of verificationCommands all green; skipping verifier follow-up"
      : "Deterministic re-run of verificationCommands had at least one non-zero exit; falling through to manager review + verifier",
    payload: {
      workerTaskId: impl.id,
      results: results.map((r) => ({
        command: r.command,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        stdoutSnippet: r.stdout,
        stderrSnippet: r.stderr,
      })),
    },
  });

  if (!allClean) return null;

  return commitRunChange(run, {
    type: "spark_manager.standard_fast_path_review",
    message: "Skipped manager worker_result_review + verifier: standard run with clean impl + green verificationCommands",
    payload: {
      workerTaskId: impl.id,
      stepId: impl.stepId,
      commands,
    },
    mutate: (draft, timestamp) => {
      const targetStep = draft.steps.find((s) => s.id === impl.stepId);
      if (targetStep) {
        targetStep.status = "complete";
        targetStep.updatedAt = timestamp;
        if (draft.currentStepId === targetStep.id) draft.currentStepId = undefined;
      }
      const allStepsTerminal =
        draft.steps.length > 0 &&
        draft.steps.every((s) => ["complete", "failed", "skipped"].includes(s.status));
      if (allStepsTerminal) {
        draft.status = "complete";
        draft.autopilot = {
          ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
          status: "complete",
          lastAction: "standard_fast_path_review_skipped",
          updatedAt: timestamp,
        };
      } else {
        draft.autopilot = {
          ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
          lastAction: "standard_fast_path_review_skipped",
          updatedAt: timestamp,
        };
      }
      draft.updatedAt = timestamp;
    },
  });
}

async function applySparkManagerDecision(
  run: RunState,
  decision: SparkManagerDecision,
  mode: SparkCall["mode"],
): Promise<RunState> {
  // Surface the manager's natural-language reply to the user as a Spark chat
  // bubble before applying the structural decision. Avoids dupes by skipping
  // when the latest spark/note already matches verbatim.
  const reply = decision.chatReply?.trim();
  if (reply && reply.length > 0) {
    const lastMessage = run.humanMessages[run.humanMessages.length - 1];
    const alreadyEmitted = Boolean(
      lastMessage &&
        lastMessage.author === "spark" &&
        lastMessage.kind === "note" &&
        lastMessage.message === reply,
    );
    if (!alreadyEmitted) {
      run = await addRunMessage({
        runId: run.id,
        author: "spark",
        kind: "note",
        message: reply,
      });
    }
  }

  if (decision.status === "ask_user") {
    if (mode === "plan_analysis" && hasPlannedWorkAfterBrake(run)) {
      const activeStep = pickAutopilotStep(run);
      await appendEvent({
        workspaceId: run.workspaceId,
        runId: run.id,
        stepId: activeStep?.id,
        type: "spark_manager.question_deferred",
        message: "Spark manager asked for input while planned work remained; continuing the existing plan",
        payload: {
          summary: decision.summary,
          question: decision.question,
          activeStepId: activeStep?.id,
          activeStepTitle: activeStep?.title,
        },
      });
      return run;
    }
    // Worker-review path: if the manager wants to ask a question after every
    // implementation + verifier in the run is already in a terminal state,
    // the question is post-hoc (tactical scope retro, "should we have done X
    // differently"). Refuse to pause: the work is done. Mark the run complete
    // so headless / interactive runs alike land cleanly.
    if (mode === "worker_result_review") {
      const activeTaskStatuses = new Set([
        "created",
        "queued",
        "claimed",
        "running",
        "needs_review",
        "retry_queued",
      ]);
      const pendingTasks = run.workerTasks.filter((task) => activeTaskStatuses.has(task.status));
      const pendingSteps = run.steps.filter(
        (step) => !["complete", "failed", "skipped"].includes(step.status),
      );
      if (pendingTasks.length === 0 && pendingSteps.length === 0) {
        return commitRunChange(run, {
          type: "spark_manager.posthoc_question_dropped",
          message: "Manager asked a tactical question after the run finished; landing the run instead of pausing",
          payload: {
            summary: decision.summary,
            question: decision.question,
          },
          mutate: (draft, timestamp) => {
            draft.status = "complete";
            draft.autopilot = {
              ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
              status: "complete",
              lastAction: "posthoc_question_dropped",
              updatedAt: timestamp,
            };
            draft.updatedAt = timestamp;
          },
        });
      }
    }
    return askHumanQuestion(run.id, decision.question || "Please clarify what Spark should do next.");
  }

  if (decision.status === "complete") {
    // Refuse premature completion: the manager occasionally returns "complete"
    // after a single worker review even when the planned step division still
    // has queued/in-progress steps, or when verifier follow-ups are queued but
    // not yet executed. Trusting it here would skip the brake checkpoint, the
    // remaining worker_batch steps, or the verifier feedback loop. Demote to a
    // no-op so the autopilot loop advances to the next pending unit instead.
    const pendingSteps = run.steps.filter(
      (step) => !["complete", "failed", "skipped"].includes(step.status),
    );
    const activeTaskStatuses = new Set([
      "created",
      "queued",
      "claimed",
      "running",
      "needs_review",
      "retry_queued",
    ]);
    const pendingTasks = run.workerTasks.filter((task) => activeTaskStatuses.has(task.status));
    if (pendingSteps.length > 0 || pendingTasks.length > 0) {
      const priorRefusals = run.autopilot?.consecutiveCompletionRefusals ?? 0;
      const nextRefusals = priorRefusals + 1;
      // Failsafe: if the manager keeps returning complete despite the guard
      // demoting it, the autopilot loop has nothing to advance and would stall
      // until budget exhaustion. After 2 consecutive refusals, force-accept
      // needs_review tasks so the run can land — better to lose the verifier
      // pass than to deadlock the entire run.
      if (nextRefusals >= 2) {
        const needsReviewTasks = pendingTasks.filter((t) => t.status === "needs_review");
        if (needsReviewTasks.length > 0) {
          return commitRunChange(run, {
            type: "spark_manager.force_accepted_after_refused_completion",
            message: `Manager returned complete twice with ${needsReviewTasks.length} needs_review task(s); force-accepting so the run can land`,
            payload: {
              summary: decision.summary,
              acceptedTaskIds: needsReviewTasks.map((t) => t.id),
              acceptedTaskTitles: needsReviewTasks.map((t) => t.title),
              acceptedTaskClasses: needsReviewTasks.map((t) => t.taskClass),
              priorRefusals,
            },
            mutate: (draft, timestamp) => {
              const acceptedIds = new Set(needsReviewTasks.map((t) => t.id));
              for (const task of draft.workerTasks) {
                if (acceptedIds.has(task.id)) {
                  task.status = "accepted";
                  task.updatedAt = timestamp;
                }
              }
              // Mirror the worker-review accept path: promote any step whose
              // tasks are now all accepted to status=complete, so the autopilot
              // doesn't loop on a step stuck at "reviewing" with nothing to do.
              const affectedStepIds = new Set(
                draft.workerTasks
                  .filter((t) => acceptedIds.has(t.id) && t.stepId)
                  .map((t) => t.stepId as string),
              );
              for (const step of draft.steps) {
                if (!affectedStepIds.has(step.id)) continue;
                const stepTasks = draft.workerTasks.filter((t) => t.stepId === step.id);
                const allDone =
                  stepTasks.length > 0 &&
                  stepTasks.every((t) =>
                    ["accepted", "failed", "cancelled", "blocked"].includes(t.status),
                  );
                if (allDone) {
                  step.status = "complete";
                  step.updatedAt = timestamp;
                  if (draft.currentStepId === step.id) draft.currentStepId = undefined;
                }
              }
              // If every step is now in a terminal state, the manager's
              // 'complete' verdict was correct in spirit even though it skipped
              // the verifier follow-up. Land the run rather than leaving the
              // autopilot to spin one more empty plan_analysis cycle.
              const allStepsTerminal =
                draft.steps.length > 0 &&
                draft.steps.every((s) =>
                  ["complete", "failed", "skipped"].includes(s.status),
                );
              draft.autopilot = {
                ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
                lastAction: "force_accept_after_refused_completion",
                consecutiveCompletionRefusals: 0,
                updatedAt: timestamp,
              };
              if (allStepsTerminal) {
                draft.status = "complete";
                draft.autopilot.status = "complete";
                draft.autopilot.lastAction = "force_completed_after_refused_completion";
              }
              draft.updatedAt = timestamp;
            },
          });
        }
      }
      return commitRunChange(run, {
        type: "spark_manager.completion_refused",
        message: `Manager returned complete with ${pendingSteps.length} step(s) and ${pendingTasks.length} task(s) still pending; advancing instead`,
        payload: {
          summary: decision.summary,
          pendingStepIds: pendingSteps.map((step) => step.id),
          pendingStepTitles: pendingSteps.map((step) => step.title),
          pendingTaskIds: pendingTasks.map((task) => task.id),
          pendingTaskTitles: pendingTasks.map((task) => task.title),
          pendingTaskClasses: pendingTasks.map((task) => task.taskClass),
          consecutiveRefusals: nextRefusals,
        },
        mutate: (draft, timestamp) => {
          draft.autopilot = {
            ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
            lastAction: "completion_refused",
            consecutiveCompletionRefusals: nextRefusals,
            updatedAt: timestamp,
          };
          draft.updatedAt = timestamp;
        },
      });
    }
    return commitRunChange(run, {
      type: "spark_manager.completed_run",
      message: "Spark manager marked the run complete",
      payload: {
        summary: decision.summary,
      },
      mutate: (draft, timestamp) => {
        draft.status = "complete";
        draft.autopilot = {
          ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
          status: "complete",
          lastAction: "manager_marked_complete",
          updatedAt: timestamp,
        };
        draft.updatedAt = timestamp;
      },
    });
  }

  // The manager returned run_workers (or equivalent forward progress); the
  // run is moving again, so clear any prior consecutive-completion-refusal
  // count so the failsafe doesn't trip on a future unrelated refusal.
  let latest =
    (run.autopilot?.consecutiveCompletionRefusals ?? 0) > 0
      ? await commitRunChange(run, {
          type: "autopilot.refusal_counter_reset",
          message: "Cleared consecutive completion refusal counter after forward-progress decision",
          mutate: (draft, timestamp) => {
            draft.autopilot = {
              ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
              consecutiveCompletionRefusals: 0,
              updatedAt: timestamp,
            };
            draft.updatedAt = timestamp;
          },
        })
      : run;
  const stepIds: string[] = [];
  const steps: SparkManagerStepDecision[] =
    mode === "plan_analysis" && decision.steps.length > 0
      ? decision.steps
      : latest.steps.length > 0
        ? []
        : [
          {
            kind: "worker_batch",
            title: "Spark planned work",
            goal: decision.summary,
            plannedAgents: [],
            acceptanceCriteria: ["The selected worker tasks complete and report final evidence."],
            riskLevel: undefined,
          },
        ];

  // Brake replan: when plan_analysis fires after a brake checkpoint resolves,
  // the run already has terminal steps for the work done so far AND a queued
  // tail from the initial plan. The manager now re-emits the entire downstream
  // plan with fresh evidence — appending it would duplicate every queued step
  // (we saw 3-7 dup as 8-12, then again as 13-15). Drop the still-queued tail
  // before appending so the plan stays linear and indices stay coherent.
  if (mode === "plan_analysis" && steps.length > 0 && latest.steps.length > 0) {
    const stale = latest.steps.filter((step) =>
      ["queued", "planning", "ready", "blocked"].includes(step.status),
    );
    if (stale.length > 0) {
      latest = await pruneQueuedTailSteps(latest, stale.map((step) => step.id));
    }
  }

  for (const step of steps) {
    latest = await createStep({
      runId: latest.id,
      title: step.title,
      goal: step.goal,
      kind: step.kind,
      plannedAgents: step.plannedAgents,
      riskLevel: step.riskLevel,
      acceptanceCriteria: step.acceptanceCriteria,
    });
    stepIds.push(latest.steps.at(-1)?.id ?? "");
  }

  // Persist task complexity once during plan_analysis. Downstream modes propagate
  // it via the rendered TASK COMPLEXITY context section. Adaptive depth depends
  // on this — if it isn't persisted, every review reverts to the default
  // (complex) verifier behavior.
  if (
    mode === "plan_analysis" &&
    decision.taskComplexity &&
    decision.taskComplexity !== latest.taskComplexity
  ) {
    latest = await commitRunChange(latest, {
      type: "spark_manager.task_complexity_classified",
      message: `Manager classified the run as taskComplexity=${decision.taskComplexity}`,
      payload: {
        taskComplexity: decision.taskComplexity,
        priorComplexity: latest.taskComplexity,
        summary: decision.summary,
      },
      mutate: (draft, timestamp) => {
        draft.taskComplexity = decision.taskComplexity;
        draft.updatedAt = timestamp;
      },
    });
  }

  // Trivial worker model floor: when the run is classified trivial, the
  // implementation worker is the ONLY check on the work (zero verifier
  // follow-ups). Mid-tier sonnet/gpt-5.4 misses 1-of-N distinct issues without
  // a verifier to catch it; we observed exactly this on a 3-bug fix where the
  // worker landed only 2/3 hidden gates. Code-level enforcement: walk every
  // plannedAgent on every step and every incoming task, and promote any
  // mid-tier (sonnet/gpt-5.4) feature/leaf assignment to top-tier (opus@high
  // for claude, gpt-5.5@high for codex). Manager prompt drift would otherwise
  // silently re-introduce the regression.
  if (latest.taskComplexity === "trivial") {
    const stepBumps: Array<{ stepId: string; bumped: number }> = [];
    for (const step of latest.steps) {
      if (!step.plannedAgents || step.plannedAgents.length === 0) continue;
      let bumpedInStep = 0;
      const promotedAgents = step.plannedAgents.map((agent) => {
        const promoted = promoteForTrivial(agent);
        if (promoted !== agent) bumpedInStep += 1;
        return promoted;
      });
      if (bumpedInStep > 0) {
        latest = await updateStep({
          runId: latest.id,
          stepId: step.id,
          plannedAgents: promotedAgents,
        });
        stepBumps.push({ stepId: step.id, bumped: bumpedInStep });
      }
    }
    let taskBumps = 0;
    decision = {
      ...decision,
      tasks: decision.tasks.map((task) => {
        const promoted = promoteTaskForTrivial(task);
        if (promoted !== task) taskBumps += 1;
        return promoted;
      }),
    };
    if (stepBumps.length > 0 || taskBumps > 0) {
      await appendEvent({
        workspaceId: latest.workspaceId,
        runId: latest.id,
        type: "spark_manager.trivial_worker_model_floor_enforced",
        message: `Promoted mid-tier workers to top-tier on a trivial run (${stepBumps.reduce((s, b) => s + b.bumped, 0)} agent(s) on steps, ${taskBumps} task(s))`,
        payload: {
          taskComplexity: latest.taskComplexity,
          stepBumps,
          taskBumpsCount: taskBumps,
        },
      });
    }
  }

  // If worker_result_review queued new tasks while there are still tasks in
  // the run sitting at needs_review status, the manager has implicitly moved
  // on from those: a corrective task (or verifier follow-up) supersedes the
  // partial worker. Without auto-accepting them they linger forever and block
  // step completion forever, which is exactly what stalled smoke 12 — gbk
  // stayed at needs_review and pickAutopilotStep kept returning step 1, so
  // every subsequent step's tasks piled into step 1 instead of advancing.
  if (mode === "worker_result_review" && decision.tasks.length > 0) {
    const lingeringNeedsReview = latest.workerTasks.filter((t) => t.status === "needs_review");
    if (lingeringNeedsReview.length > 0) {
      latest = await commitRunChange(latest, {
        type: "spark_manager.auto_accept_superseded_needs_review",
        message: `Manager queued ${decision.tasks.length} new task(s) while ${lingeringNeedsReview.length} task(s) sat at needs_review; auto-accepting the superseded ones`,
        payload: {
          acceptedTaskIds: lingeringNeedsReview.map((t) => t.id),
          acceptedTaskTitles: lingeringNeedsReview.map((t) => t.title),
        },
        mutate: (draft, timestamp) => {
          const ids = new Set(lingeringNeedsReview.map((t) => t.id));
          for (const t of draft.workerTasks) {
            if (ids.has(t.id)) {
              t.status = "accepted";
              t.updatedAt = timestamp;
            }
          }
          draft.updatedAt = timestamp;
        },
      });
    }
  }

  // Adaptive-depth verifier enforcement: even when the manager forgets the
  // depth-conditional VERIFIER FOLLOW-UP RULE and queues 2 peer verifiers on a
  // trivial/standard run, the autopilot drops the excess so the wall-clock
  // savings of the classification are realized regardless of LLM compliance.
  //   - trivial: drop ALL verifier-class tasks (the SELF-CHECK on the impl is
  //              the only check this complexity earns).
  //   - standard: keep at most ONE verifier per step (cross-provider single
  //              peer), drop additional ones.
  //   - complex: no change (current dual-peer pattern stands).
  if (mode === "worker_result_review" && decision.tasks.length > 0 && latest.taskComplexity) {
    const complexity = latest.taskComplexity;
    if (complexity === "trivial") {
      const dropped = decision.tasks.filter((t) => t.taskClass === "verifier");
      if (dropped.length > 0) {
        decision = {
          ...decision,
          tasks: decision.tasks.filter((t) => t.taskClass !== "verifier"),
        };
        await appendEvent({
          workspaceId: latest.workspaceId,
          runId: latest.id,
          type: "spark_manager.adaptive_depth_dropped_verifiers",
          message: `Dropped ${dropped.length} verifier task(s) on a trivial run (depth-adaptive policy: 0 verifiers)`,
          payload: {
            taskComplexity: complexity,
            droppedCount: dropped.length,
            droppedTitles: dropped.map((t) => t.title),
          },
        });
      }
    } else if (complexity === "standard") {
      const verifiersByStep = new Map<string | undefined, SparkManagerTaskDecision[]>();
      for (const task of decision.tasks) {
        if (task.taskClass !== "verifier") continue;
        const sid = String(task.stepIndex ?? "");
        const list = verifiersByStep.get(sid) ?? [];
        list.push(task);
        verifiersByStep.set(sid, list);
      }
      const droppedTitles: string[] = [];
      const keptIds = new Set<SparkManagerTaskDecision>();
      for (const [, list] of verifiersByStep) {
        if (list.length <= 1) {
          for (const task of list) keptIds.add(task);
          continue;
        }
        // Prefer the verifier whose runtime is OPPOSITE to the most recent
        // implementation worker on this step (cross-provider single peer).
        // Fall back to the first listed verifier when no impl is recorded yet.
        const recentImpl = [...latest.workerTasks]
          .reverse()
          .find((t) => t.taskClass !== "verifier");
        const oppositeRuntime: WorkerRuntime | undefined =
          recentImpl?.runtimePreference === "claude"
            ? "codex"
            : recentImpl?.runtimePreference === "codex"
              ? "claude"
              : undefined;
        const kept =
          (oppositeRuntime && list.find((t) => t.runtimePreference === oppositeRuntime)) ||
          list[0];
        keptIds.add(kept);
        for (const task of list) {
          if (task !== kept) droppedTitles.push(task.title);
        }
      }
      if (droppedTitles.length > 0) {
        decision = {
          ...decision,
          tasks: decision.tasks.filter((t) => t.taskClass !== "verifier" || keptIds.has(t)),
        };
        await appendEvent({
          workspaceId: latest.workspaceId,
          runId: latest.id,
          type: "spark_manager.adaptive_depth_demoted_verifier_pair",
          message: `Demoted dual-verifier pair to single cross-provider verifier on a standard run (${droppedTitles.length} dropped)`,
          payload: {
            taskComplexity: complexity,
            droppedCount: droppedTitles.length,
            droppedTitles,
          },
        });
      }
    }
  }

  // Corrective-rounds guard: count how many tasks each step already has, and
  // refuse to queue more once we exceed MAX_TASKS_PER_STEP. The verifier loop
  // can in principle ping-pong forever. With dual-verifier peer pressure each
  // round costs 1 impl + 2 verifiers = 3 tasks. We cap at:
  //   1 initial feature + 2 verifiers + 2 corrective rounds × (1 feature +
  //   2 verifiers) = 9 tasks per step.
  // When the cap is hit, force-accept all pending tasks on the step so the
  // step can transition complete on its own and the manager moves on.
  const MAX_TASKS_PER_STEP = 9;
  const decisionsByStep = new Map<string, number>();
  for (const task of decision.tasks) {
    const sid = resolveTaskStepId(latest, task.stepIndex, stepIds);
    if (!sid) continue;
    decisionsByStep.set(sid, (decisionsByStep.get(sid) ?? 0) + 1);
  }
  const skippedStepIds = new Set<string>();
  for (const [stepId, incoming] of decisionsByStep) {
    const existing = latest.workerTasks.filter((t) => t.stepId === stepId).length;
    if (existing + incoming > MAX_TASKS_PER_STEP) {
      skippedStepIds.add(stepId);
    }
  }
  if (skippedStepIds.size > 0) {
    latest = await commitRunChange(latest, {
      type: "spark_manager.corrective_rounds_capped",
      message: `Step task cap (${MAX_TASKS_PER_STEP}) reached; force-accepting pending work and skipping new tasks`,
      payload: {
        cappedStepIds: Array.from(skippedStepIds),
        maxTasksPerStep: MAX_TASKS_PER_STEP,
      },
      mutate: (draft, timestamp) => {
        const activeTaskStatuses = new Set([
          "created",
          "queued",
          "claimed",
          "running",
          "needs_review",
          "retry_queued",
        ]);
        for (const t of draft.workerTasks) {
          if (t.stepId && skippedStepIds.has(t.stepId) && activeTaskStatuses.has(t.status)) {
            t.status = "accepted";
            t.updatedAt = timestamp;
          }
        }
        const stepTerminal = (s: typeof draft.steps[number]): boolean =>
          ["complete", "failed", "skipped"].includes(s.status);
        for (const step of draft.steps) {
          if (!skippedStepIds.has(step.id)) continue;
          const allDone = draft.workerTasks
            .filter((t) => t.stepId === step.id)
            .every((t) => ["accepted", "failed", "cancelled", "blocked"].includes(t.status));
          if (allDone && !stepTerminal(step)) {
            step.status = "complete";
            step.updatedAt = timestamp;
          }
        }
        draft.updatedAt = timestamp;
      },
    });
  }

  // Plan-mode branch: when the user has flipped the run into plan mode, the
  // manager's worker dispatches are mutating actions we want the user to
  // review BEFORE Spark touches the workspace. Queue each task into
  // pendingMutations and skip createWorkerTask. The autopilot loop will see
  // no new tasks were created and naturally idle until the user applies via
  // the PlanDiffReview overlay (which calls applyPendingMutations to flush
  // them through createWorkerTask + scheduleAutopilotCycles).
  const planModeOn = latest.planMode === true;
  const queuedMutations: PendingMutation[] = [];
  if (planModeOn && decision.tasks.length > 0) {
    const proposedAt = new Date().toISOString();
    for (const task of decision.tasks) {
      const stepId = resolveTaskStepId(latest, task.stepIndex, stepIds);
      if (skippedStepIds.has(stepId ?? "")) continue;
      queuedMutations.push({
        id: makeId("pmut"),
        source: "manager_decision",
        proposedAt,
        description: task.title,
        workerTaskInput: {
          stepId,
          title: task.title,
          description: task.description,
          runtimePreference: task.runtimePreference,
          modelHint: task.modelHint,
          effortHint: task.effortHint,
          allowedPaths: task.allowedPaths,
          forbiddenPaths: task.forbiddenPaths,
          expectedOutputs: task.expectedOutputs,
          verificationCommands: task.verificationCommands,
          canRunParallel: task.canRunParallel,
          conflictsWith: task.conflictsWith,
          taskClass: task.taskClass,
        },
      });
    }
    if (queuedMutations.length > 0) {
      latest = await commitRunChange(latest, {
        type: "spark_manager.pending_mutations_added",
        message: `Plan mode queued ${queuedMutations.length} worker task(s) for review`,
        payload: {
          count: queuedMutations.length,
          ids: queuedMutations.map((m) => m.id),
          titles: queuedMutations.map((m) => m.description),
        },
        mutate: (draft, timestamp) => {
          draft.pendingMutations = [...(draft.pendingMutations ?? []), ...queuedMutations];
          draft.updatedAt = timestamp;
        },
      });
    }
  } else {
    for (const task of decision.tasks) {
      const stepId = resolveTaskStepId(latest, task.stepIndex, stepIds);
      if (skippedStepIds.has(stepId ?? "")) continue;
      latest = await createWorkerTask({
        runId: latest.id,
        stepId,
        title: task.title,
        description: task.description,
        runtimePreference: task.runtimePreference,
        modelHint: task.modelHint,
        effortHint: task.effortHint,
        allowedPaths: task.allowedPaths,
        forbiddenPaths: task.forbiddenPaths,
        expectedOutputs: task.expectedOutputs,
        verificationCommands: task.verificationCommands,
        canRunParallel: task.canRunParallel,
        conflictsWith: task.conflictsWith,
        taskClass: task.taskClass,
        createdBy: "spark",
      });
    }
  }

  latest = await requireRun(latest.id);
  await appendEvent({
    workspaceId: latest.workspaceId,
    runId: latest.id,
    type: "spark_manager.decision_applied",
    message: "Spark manager decision applied",
    payload: {
      summary: decision.summary,
      status: decision.status,
      stepsCreated: steps.length,
      tasksCreated: planModeOn ? 0 : decision.tasks.length,
      tasksQueued: planModeOn ? queuedMutations.length : 0,
      planMode: planModeOn,
      runtimes: decision.tasks.map((task) => task.runtimePreference),
    },
  });
  return latest;
}

export async function pauseRun(input: PauseRunInput): Promise<RunState> {
  const run = await requireRun(input.runId);
  const reason = input.reason?.trim() || "Paused by user";
  const recordPauseMessage = shouldRecordPauseReasonAsUserNote(reason);
  await sendPauseSignals(run, reason);
  return commitRunChange(run, {
    type: "run.paused",
    message: reason,
    payload: {
      reason,
      activeWorkerAttempts: activeWorkersForRun(run.id).map((worker) => worker.attemptId),
      controlSignal: "escape",
      messageRecorded: recordPauseMessage,
    },
    mutate: (draft, timestamp) => {
      if (recordPauseMessage) {
        draft.humanMessages.push({
          id: makeId("msg"),
          runId: draft.id,
          author: "user",
          kind: "note",
          message: reason,
          createdAt: timestamp,
        });
      }
      draft.status = "paused";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
        status: "paused",
        lastAction: "paused_by_user",
        stopReason: reason,
        pausedAt: timestamp,
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
  });
}

export async function resumeRun(input: ResumeRunInput): Promise<RunState> {
  const run = await requireRun(input.runId);
  const resumePrompt = buildResumePrompt(run);
  await sendResumeSignals(run, resumePrompt);
  const resumed = await commitRunChange(run, {
    type: "run.resumed",
    message: resumePrompt.kind === "prompt" ? "Run resumed with user update" : "Run resumed",
    payload: {
      activeWorkerAttempts: activeWorkersForRun(run.id).map((worker) => worker.attemptId),
      controlSignal: resumePrompt.kind,
      messageId: resumePrompt.messageId,
    },
    mutate: (draft, timestamp) => {
      draft.status = "running";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
        status: "running",
        lastAction: "resumed_by_user",
        stopReason: undefined,
        resumedAt: timestamp,
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
  });
  if (shouldResumeManagerPlanning(run)) {
    const resumeInput = autopilotInputFromRun(resumed);
    if (resumed.workerAttempts.length > 0) {
      scheduleAutopilotReview(resumed.id, resumeInput.cwd);
    } else {
      scheduleInitialAutopilotPlanning(resumed.id, resumeInput, { afterCurrent: true });
    }
  }
  return resumed;
}

export async function cancelRun(input: CancelRunInput): Promise<RunState> {
  const run = await requireRun(input.runId);
  if (run.status === "complete" || run.status === "failed" || run.status === "cancelled") {
    return run;
  }
  const reason = input.reason?.trim() || "Run cancelled";
  await sendPauseSignals(run, reason);
  return commitRunChange(run, {
    type: "run.cancelled",
    message: reason,
    payload: { reason },
    mutate: (draft, timestamp) => {
      draft.status = "cancelled";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
        status: "cancelled",
        lastAction: "cancelled",
        stopReason: reason,
        updatedAt: timestamp,
      };
      for (const task of draft.workerTasks) {
        if (
          task.status === "created" ||
          task.status === "queued" ||
          task.status === "claimed" ||
          task.status === "running" ||
          task.status === "needs_review" ||
          task.status === "retry_queued"
        ) {
          task.status = "cancelled";
          task.updatedAt = timestamp;
        }
      }
      for (const step of draft.steps) {
        if (
          step.status === "queued" ||
          step.status === "planning" ||
          step.status === "ready" ||
          step.status === "running" ||
          step.status === "reviewing"
        ) {
          step.status = "skipped";
          step.updatedAt = timestamp;
        }
      }
      draft.updatedAt = timestamp;
    },
  });
}

export async function addRunMessage(input: AddRunMessageInput): Promise<RunState> {
  const run = await requireRun(input.runId);
  const message = input.message.trim();
  if (!message) throw new Error("Message is required.");
  const humanMessage = {
    id: makeId("msg"),
    runId: run.id,
    author: input.author,
    kind: input.kind,
    message,
    createdAt: new Date().toISOString(),
  };

  const wasTerminal = run.status === "complete" || run.status === "failed" || run.status === "cancelled";
  const updated = await commitRunChange(run, {
    type: `human.${input.kind}`,
    message: `${input.author}: ${message.slice(0, 160)}`,
    payload: { message: humanMessage },
    mutate: (draft, timestamp) => {
      draft.humanMessages.push({ ...humanMessage, createdAt: timestamp });
      // When the user chats into a finished run, transition it back into a
      // planning state so the autopilot loop wakes up and the run badge shifts
      // off "complete" while the manager replans. Keep the prior terminal as
      // last_status if downstream code wants to know.
      if (input.author === "user" && wasTerminal) {
        draft.status = "planning";
        draft.autopilot = {
          ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
          status: "running",
          lastAction: "user_followup",
          stopReason: undefined,
          resumedAt: timestamp,
          updatedAt: timestamp,
        };
      }
      draft.updatedAt = timestamp;
    },
  });

  // Re-engage the manager when the user chatted into a terminal run. We hand
  // off via scheduleInitialAutopilotPlanning because plan_analysis already
  // reads humanMessages.slice(-8), so the user's new note is in context and
  // the manager can append additional steps + emit a chatReply. Schedule
  // afterCurrent in case planning was already in flight.
  if (input.author === "user" && wasTerminal) {
    const autopilotInput = autopilotInputFromRun(updated);
    scheduleInitialAutopilotPlanning(updated.id, autopilotInput, { afterCurrent: true });
  }

  return updated;
}

// Append a user message AND interrupt the in-flight run so the manager picks
// the message up on its next decision. Two interrupt modes:
//
//   "graceful" — push the message, send ESC to active worker ptys (the same
//                signal pauseRun uses), set status=paused. Workers may still
//                emit a final report; nothing is killed mid-syscall. Resume
//                folds the message into the resume prompt via the existing
//                buildResumePrompt path.
//
//   "hard"     — same message + pause, but additionally pty.dispose() each
//                active worker session (forcing an immediate kill) and
//                transition their attempts/tasks to cancelled so the
//                autopilot won't wait on a final report that will never
//                land. The user can still resume the run; the manager will
//                see the cancelled attempts on its next worker_result_review
//                and replan with the new message in context.
export async function interruptRunWithMessage(
  input: InterruptRunWithMessageInput,
): Promise<RunState> {
  const message = input.message.trim();
  if (!message) throw new Error("Message is required.");
  const reason = input.reason?.trim() || "Paused for user message";
  const kind = input.kind ?? "note";
  const mode = input.mode;

  // 1. Append the user message first so resume / replan paths see it as the
  // most recent humanMessage.
  let run = await addRunMessage({
    runId: input.runId,
    author: "user",
    kind,
    message,
  });

  // 2. Send ESC + record the pause. This mirrors pauseRun without re-emitting
  // the user note we just pushed.
  const activeWorkers = activeWorkersForRun(run.id);
  await sendPauseSignals(run, reason);
  run = await commitRunChange(run, {
    type: "run.paused",
    message: reason,
    payload: {
      reason,
      activeWorkerAttempts: activeWorkers.map((worker) => worker.attemptId),
      controlSignal: "escape",
      messageRecorded: false,
      interrupt: { mode, byMessage: true },
    },
    mutate: (draft, timestamp) => {
      draft.status = "paused";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
        status: "paused",
        lastAction: mode === "hard" ? "interrupted_hard" : "interrupted_graceful",
        stopReason: reason,
        pausedAt: timestamp,
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
  });

  // 3. Hard mode: dispose active worker ptys and transition attempts/tasks to
  // cancelled. We dispose AFTER the pause commit so the run snapshot already
  // reflects status=paused before the pty exit handlers fire.
  if (mode === "hard" && activeWorkers.length > 0) {
    for (const worker of activeWorkers) {
      try {
        pty.dispose(worker.attemptId);
      } catch {
        /* the session may have already exited between sendPauseSignals and
           here — disposing twice is a no-op in pty-manager. */
      }
    }
    const cancelledAttemptIds = new Set(activeWorkers.map((w) => w.attemptId));
    const cancelledTaskIds = new Set(
      activeWorkers
        .map((w) => w.workerTaskId)
        .filter((id): id is string => Boolean(id)),
    );
    run = await commitRunChange(run, {
      type: "run.interrupted_hard",
      message: `Hard-cancelled ${activeWorkers.length} active worker attempt(s)`,
      payload: {
        reason,
        cancelledAttemptIds: [...cancelledAttemptIds],
        cancelledTaskIds: [...cancelledTaskIds],
      },
      mutate: (draft, timestamp) => {
        for (const attempt of draft.workerAttempts) {
          if (!cancelledAttemptIds.has(attempt.id)) continue;
          if (
            attempt.status === "preparing" ||
            attempt.status === "prompt_ready" ||
            attempt.status === "launching" ||
            attempt.status === "running" ||
            attempt.status === "finishing"
          ) {
            attempt.status = "cancelled";
            attempt.finishedAt = attempt.finishedAt ?? timestamp;
          }
        }
        for (const task of draft.workerTasks) {
          if (!cancelledTaskIds.has(task.id)) continue;
          if (
            task.status === "created" ||
            task.status === "queued" ||
            task.status === "claimed" ||
            task.status === "running" ||
            task.status === "needs_review" ||
            task.status === "retry_queued"
          ) {
            task.status = "cancelled";
            task.updatedAt = timestamp;
          }
        }
        draft.updatedAt = timestamp;
      },
    });
  }

  return run;
}

export async function updateRunStatus(input: UpdateRunStatusInput): Promise<RunState> {
  const run = await requireRun(input.runId);
  return commitRunChange(run, {
    type: "run.status_updated",
    message: `Run status changed to ${input.status}`,
    payload: {
      previousStatus: run.status,
      status: input.status,
      currentStepId: input.currentStepId ?? run.currentStepId,
    },
    mutate: (draft, timestamp) => {
      draft.status = input.status;
      if (input.currentStepId !== undefined) draft.currentStepId = input.currentStepId;
      draft.updatedAt = timestamp;
    },
  });
}

export async function createStep(input: CreateStepInput): Promise<RunState> {
  const run = await requireRun(input.runId);
  const title = input.title.trim();
  if (!title) throw new Error("Step title is required.");

  const now = new Date().toISOString();
  const stepIndex = run.steps.length + 1;
  const step: StepState = {
    id: makeId("step"),
    runId: run.id,
    index: stepIndex,
    title,
    goal: input.goal?.trim() || title,
    kind: input.kind ?? "worker_batch",
    status: "queued",
      riskLevel: input.riskLevel,
      plannedAgents: normalizePlannedAgentLabels(input.plannedAgents ?? [], stepIndex),
      acceptanceCriteria: input.acceptanceCriteria ?? [],
    verificationCommands: input.verificationCommands ?? [],
    workerTaskIds: [],
    createdAt: now,
    updatedAt: now,
  };

  return commitRunChange(run, {
    type: "step.created",
    message: `Step created: ${step.title}`,
    stepId: step.id,
    payload: { step },
    mutate: (draft, timestamp) => {
      draft.steps.push({ ...step, createdAt: timestamp, updatedAt: timestamp });
      draft.updatedAt = timestamp;
    },
  });
}

export async function updateStep(input: UpdateStepInput): Promise<RunState> {
  const run = await requireRun(input.runId);
  const step = run.steps.find((item) => item.id === input.stepId);
  if (!step) throw new Error(`Step not found: ${input.stepId}`);

  return commitRunChange(run, {
    type: "step.updated",
    message: `Step updated: ${step.title}`,
    stepId: step.id,
    payload: {
      stepId: step.id,
      status: input.status ?? step.status,
      changedFields: changedFields(input, ["runId", "stepId"]),
    },
    mutate: (draft, timestamp) => {
      const target = draft.steps.find((item) => item.id === input.stepId);
      if (!target) throw new Error(`Step not found: ${input.stepId}`);
      if (input.title !== undefined) target.title = input.title.trim();
      if (input.goal !== undefined) target.goal = input.goal.trim();
      if (input.kind !== undefined) target.kind = input.kind;
      if (input.plannedAgents !== undefined) target.plannedAgents = input.plannedAgents;
      if (input.status !== undefined) target.status = input.status;
      if (input.riskLevel !== undefined) target.riskLevel = input.riskLevel;
      if (input.acceptanceCriteria !== undefined) target.acceptanceCriteria = input.acceptanceCriteria;
      if (input.verificationCommands !== undefined) target.verificationCommands = input.verificationCommands;
      if (input.workerTaskIds !== undefined) target.workerTaskIds = input.workerTaskIds;
      if (input.reviewSummary !== undefined) target.reviewSummary = input.reviewSummary;
      if (input.status === "running") draft.currentStepId = target.id;
      if (draft.currentStepId === target.id && ["complete", "failed", "skipped"].includes(target.status)) {
        draft.currentStepId = undefined;
      }
      target.updatedAt = timestamp;
      draft.updatedAt = timestamp;
    },
  });
}

// Drop steps the brake-replan is about to make stale. Removes the matching
// step rows (and any worker tasks pinned to them — there should be none for
// "queued" steps, but worker_batch steps with plannedAgents may have task
// rows generated by step_planning that never started). Indices on the
// surviving steps are not renumbered: pruning removes a contiguous tail, so
// existing indices remain dense up to the kept prefix and freshly-created
// steps continue from `run.steps.length + 1`.
async function pruneQueuedTailSteps(run: RunState, stepIds: string[]): Promise<RunState> {
  if (stepIds.length === 0) return run;
  const idSet = new Set(stepIds);
  const removedTitles = run.steps
    .filter((step) => idSet.has(step.id))
    .map((step) => `${step.index}. ${step.title}`);
  return commitRunChange(run, {
    type: "autopilot.steps_pruned",
    message: `Replanning after brake — pruned ${stepIds.length} stale queued step(s)`,
    payload: {
      stepIds: [...idSet],
      stepTitles: removedTitles,
      reason: "brake_replan",
    },
    mutate: (draft, timestamp) => {
      draft.steps = draft.steps.filter((step) => !idSet.has(step.id));
      draft.workerTasks = draft.workerTasks.filter(
        (task) => !task.stepId || !idSet.has(task.stepId),
      );
      if (draft.currentStepId && idSet.has(draft.currentStepId)) {
        draft.currentStepId = undefined;
      }
      draft.updatedAt = timestamp;
    },
  });
}

export async function createWorkerTask(input: CreateWorkerTaskInput): Promise<RunState> {
  const run = await requireRun(input.runId);
  if (input.stepId && !run.steps.some((step) => step.id === input.stepId)) {
    throw new Error(`Step not found: ${input.stepId}`);
  }
  const title = input.title.trim();
  if (!title) throw new Error("Worker task title is required.");

  const now = new Date().toISOString();
  const task: WorkerTask = {
    id: makeId("task"),
    runId: run.id,
    stepId: input.stepId,
    title,
    description: input.description?.trim() || title,
    runtimePreference: input.runtimePreference ?? "manual",
    modelHint: input.modelHint,
    effortHint: input.effortHint,
    status: "created",
    allowedPaths: input.allowedPaths ?? [],
    forbiddenPaths: input.forbiddenPaths ?? [],
    expectedOutputs: input.expectedOutputs ?? [],
    verificationCommands: input.verificationCommands ?? [],
    canRunParallel: input.canRunParallel ?? false,
    conflictsWith: input.conflictsWith ?? [],
    taskClass: input.taskClass,
    createdBy: input.createdBy ?? "user",
    createdAt: now,
    updatedAt: now,
  };

  return commitRunChange(run, {
    type: "worker_task.created",
    message: `Worker task created: ${task.title}`,
    stepId: task.stepId,
    workerTaskId: task.id,
    payload: { workerTask: task },
    mutate: (draft, timestamp) => {
      const nextTask = { ...task, createdAt: timestamp, updatedAt: timestamp };
      draft.workerTasks.push(nextTask);
      if (nextTask.stepId) {
        const step = draft.steps.find((item) => item.id === nextTask.stepId);
        if (step && !step.workerTaskIds.includes(nextTask.id)) {
          step.workerTaskIds.push(nextTask.id);
          step.updatedAt = timestamp;
        }
      }
      draft.updatedAt = timestamp;
    },
  });
}

export async function updateWorkerTask(input: UpdateWorkerTaskInput): Promise<RunState> {
  const run = await requireRun(input.runId);
  const task = run.workerTasks.find((item) => item.id === input.workerTaskId);
  if (!task) throw new Error(`Worker task not found: ${input.workerTaskId}`);

  return commitRunChange(run, {
    type: "worker_task.updated",
    message: `Worker task updated: ${task.title}`,
    stepId: task.stepId,
    workerTaskId: task.id,
    payload: {
      workerTaskId: task.id,
      status: input.status ?? task.status,
      changedFields: changedFields(input, ["runId", "workerTaskId"]),
    },
    mutate: (draft, timestamp) => {
      const target = draft.workerTasks.find((item) => item.id === input.workerTaskId);
      if (!target) throw new Error(`Worker task not found: ${input.workerTaskId}`);
      if (input.title !== undefined) target.title = input.title.trim();
      if (input.description !== undefined) target.description = input.description.trim();
      if (input.status !== undefined) target.status = input.status;
      if (input.runtimePreference !== undefined) target.runtimePreference = input.runtimePreference;
      if (input.modelHint !== undefined) target.modelHint = input.modelHint;
      if (input.effortHint !== undefined) target.effortHint = input.effortHint;
      if (input.allowedPaths !== undefined) target.allowedPaths = input.allowedPaths;
      if (input.forbiddenPaths !== undefined) target.forbiddenPaths = input.forbiddenPaths;
      if (input.expectedOutputs !== undefined) target.expectedOutputs = input.expectedOutputs;
      if (input.verificationCommands !== undefined) target.verificationCommands = input.verificationCommands;
      if (input.canRunParallel !== undefined) target.canRunParallel = input.canRunParallel;
      if (input.conflictsWith !== undefined) target.conflictsWith = input.conflictsWith;
      target.updatedAt = timestamp;
      draft.updatedAt = timestamp;
    },
  });
}

export async function prepareWorkerTask(input: PrepareWorkerTaskInput): Promise<WorkerTaskEnvelope> {
  const run = await requireRun(input.runId);
  const task = run.workerTasks.find((item) => item.id === input.workerTaskId);
  if (!task) throw new Error(`Worker task not found: ${input.workerTaskId}`);
  const step = task.stepId ? run.steps.find((item) => item.id === task.stepId) : undefined;
  const timestamp = new Date().toISOString();
  const runtimeReroute = await rerouteSparkShellTaskToAgent(task);
  const attemptNumber =
    run.workerAttempts.filter((attempt) => attempt.workerTaskId === task.id).length + 1;
  const attempt: WorkerAttempt = {
    id: makeId("attempt"),
    runId: run.id,
    workerTaskId: task.id,
    attemptNumber,
    runtime: task.runtimePreference,
    cwd: input.cwd,
    status: "prompt_ready",
  };
  const paths = workerArtifactPaths(run.id, task.stepId, task.id, attempt.id);
  task.status = "queued";
  task.updatedAt = timestamp;
  if (step && !["running", "reviewing", "complete", "failed", "skipped"].includes(step.status)) {
    step.status = "ready";
    step.updatedAt = timestamp;
  }
  const envelope: WorkerTaskEnvelope = {
    runId: run.id,
    workerTaskId: task.id,
    attemptId: attempt.id,
    runtime: task.runtimePreference,
    cwd: input.cwd,
    executionDisabled: true,
    task,
    step,
    paths,
    createdAt: timestamp,
  };
  const prompt = renderWorkerPrompt({ cwd: input.cwd, run, step, task, paths });

  await fs.mkdir(paths.attemptDir, { recursive: true });
  await fs.writeFile(paths.taskJson, JSON.stringify(envelope, null, 2), "utf8");
  await fs.writeFile(paths.promptMd, prompt, "utf8");

  attempt.promptPath = paths.promptMd;
  attempt.finalReportPath = paths.finalReportJson;

  run.workerAttempts.push(attempt);
  run.updatedAt = timestamp;
  await saveRun(run);
  await appendEvent({
    timestamp,
    workspaceId: run.workspaceId,
    runId: run.id,
    stepId: task.stepId,
    workerTaskId: task.id,
    attemptId: attempt.id,
    type: "worker_task.envelope_prepared",
    message: `Worker task envelope prepared: ${task.title}`,
    payload: {
      executionDisabled: true,
      attemptId: attempt.id,
      paths,
    },
  });
  if (runtimeReroute) {
    await appendEvent({
      timestamp,
      workspaceId: run.workspaceId,
      runId: run.id,
      stepId: task.stepId,
      workerTaskId: task.id,
      attemptId: attempt.id,
      type: "worker_task.runtime_rerouted",
      message: `Worker runtime rerouted: ${runtimeReroute.from} -> ${runtimeReroute.to}`,
      payload: runtimeReroute,
    });
  }

  return envelope;
}

async function rerouteSparkShellTaskToAgent(task: WorkerTask): Promise<RuntimeReroute | null> {
  if (task.createdBy !== "spark" || task.runtimePreference !== "shell") return null;
  const runtimes = await detectAgentRuntimes().catch(() => []);
  const target =
    runtimes.find((runtime) => runtime.kind === "codex" && runtime.installed) ??
    runtimes.find((runtime) => runtime.kind === "claude" && runtime.installed);
  if (!target) return null;

  const model = target.models.find((item) => item.isDefault) ?? target.models[0];
  const effortHint = normalizeWorkerEffortForModel(task.effortHint, model);
  const modelHint = task.modelHint?.trim() || model?.id;

  task.runtimePreference = target.kind;
  task.modelHint = modelHint;
  task.effortHint = effortHint;

  return {
    from: "shell",
    to: target.kind,
    modelHint,
    effortHint,
    reason:
      "Spark-created shell workers are not autonomous yet; route command-heavy work through an installed agent so it can inspect output and write the final report.",
  };
}

function normalizeWorkerEffortForModel(
  existing: WorkerTask["effortHint"],
  model: AgentRuntimeModel | undefined,
): WorkerTask["effortHint"] {
  const allowed = new Set(model?.effortLevels.filter(isWorkerEffort) ?? []);
  if (existing && (allowed.size === 0 || allowed.has(existing))) return existing;
  if (allowed.has("medium")) return "medium";
  if (allowed.has("low")) return "low";
  return [...allowed][0] ?? "medium";
}

function isWorkerEffort(value: string): value is NonNullable<WorkerTask["effortHint"]> {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

export async function launchWorkerAttempt(input: LaunchWorkerAttemptInput): Promise<RunState> {
  let run = await requireRun(input.runId);
  const attempt = run.workerAttempts.find((item) => item.id === input.attemptId);
  if (!attempt) throw new Error(`Worker attempt not found: ${input.attemptId}`);
  if (attempt.status !== "prompt_ready" && attempt.status !== "failed") {
    throw new Error(`Worker attempt is not ready to launch: ${attempt.status}`);
  }
  const task = run.workerTasks.find((item) => item.id === attempt.workerTaskId);
  if (!task) throw new Error(`Worker task not found: ${attempt.workerTaskId}`);

  const paths = workerArtifactPaths(run.id, task.stepId, task.id, attempt.id);
  await fs.mkdir(paths.attemptDir, { recursive: true });
  await Promise.all([
    fs.writeFile(paths.stdoutLog, "", "utf8"),
    fs.writeFile(paths.stderrLog, "", "utf8"),
    fs.writeFile(paths.rawLog, "", "utf8"),
  ]);

  const promptText = await readWorkerPromptForLaunch(paths);
  // codex >= v0.113 prompts for directory trust on every TUI launch and
  // node-pty has no human to answer. The -c flag override stopped being
  // honored in v0.128 (path-format mismatch); the only reliable suppressor
  // is an exact-path entry in ~/.codex/config.toml, which we ensure here
  // before spawning. Idempotent and cheap.
  if (task.runtimePreference === "codex") {
    await ensureCodexProjectTrust(attempt.cwd).catch(() => undefined);
  }
  const launchCommand = buildLaunchCommandLine(task, attempt.cwd);
  const command = launchCommand
    ? `pwsh -> ${launchCommand}`
    : "pwsh (manual)";
  const launchTimestamp = new Date().toISOString();
  attempt.status = "launching";
  attempt.startedAt = launchTimestamp;
  attempt.finishedAt = undefined;
  attempt.exitCode = undefined;
  attempt.error = undefined;
  attempt.command = command;
  attempt.promptPath = paths.promptMd;
  attempt.stdoutLogPath = paths.stdoutLog;
  attempt.stderrLogPath = paths.stderrLog;
  attempt.rawLogPath = paths.rawLog;
  attempt.finalReportPath = paths.finalReportJson;
  task.status = "claimed";
  task.updatedAt = launchTimestamp;
  const launchStep = task.stepId ? run.steps.find((item) => item.id === task.stepId) : undefined;
  if (launchStep && !["complete", "failed", "skipped"].includes(launchStep.status)) {
    launchStep.status = "running";
    launchStep.updatedAt = launchTimestamp;
    run.currentStepId = launchStep.id;
  }
  run.updatedAt = launchTimestamp;
  await saveRun(run);
  await appendEvent({
    timestamp: launchTimestamp,
    workspaceId: run.workspaceId,
    runId: run.id,
    stepId: task.stepId,
    workerTaskId: task.id,
    attemptId: attempt.id,
    type: "worker_attempt.launch_requested",
    message: `Worker attempt launch requested: ${task.title}`,
    payload: {
      command,
      paths,
    },
  });

  const result = await runWorkerSession({
    run,
    task,
    attemptId: attempt.id,
    paths,
    cwd: attempt.cwd,
    launchCommand,
    promptText,
    command,
  });

  run = await requireRun(input.runId);
  const finishedAttempt = run.workerAttempts.find((item) => item.id === input.attemptId);
  const finishedTask = run.workerTasks.find((item) => item.id === task.id);
  if (!finishedAttempt) throw new Error(`Worker attempt not found: ${input.attemptId}`);
  if (!finishedTask) throw new Error(`Worker task not found: ${task.id}`);

  const finishedAt = new Date().toISOString();
  finishedAttempt.status = result.exitCode === 0 ? "succeeded" : "failed";
  finishedAttempt.finishedAt = finishedAt;
  finishedAttempt.exitCode = result.exitCode;
  finishedAttempt.error = result.error;
  finishedAttempt.command = command;
  finishedAttempt.stdoutLogPath = paths.stdoutLog;
  finishedAttempt.stderrLogPath = paths.stderrLog;
  finishedAttempt.rawLogPath = paths.rawLog;
  finishedAttempt.finalReportPath = paths.finalReportJson;
  finishedTask.status = result.exitCode === 0 ? "needs_review" : "failed";
  finishedTask.updatedAt = finishedAt;
  const finishedStep = finishedTask.stepId ? run.steps.find((item) => item.id === finishedTask.stepId) : undefined;
  if (finishedStep && !["complete", "skipped"].includes(finishedStep.status)) {
    if (result.exitCode !== 0) {
      finishedStep.status = "failed";
      if (run.currentStepId === finishedStep.id) run.currentStepId = undefined;
    } else if (!hasActiveStepWorkers(run, finishedStep.id, finishedTask.id)) {
      finishedStep.status = "reviewing";
    }
    finishedStep.updatedAt = finishedAt;
  }
  run.updatedAt = finishedAt;
  await saveRun(run);
  await appendEvent({
    timestamp: finishedAt,
    workspaceId: run.workspaceId,
    runId: run.id,
    stepId: finishedTask.stepId,
    workerTaskId: finishedTask.id,
    attemptId: finishedAttempt.id,
    type: "worker_attempt.finished",
    message: `Worker attempt finished with exit code ${result.exitCode}`,
    payload: {
      exitCode: result.exitCode,
      error: result.error,
      paths,
    },
  });

  run = await reviewWorkerReportArtifact({
    run,
    task: finishedTask,
    attempt: finishedAttempt,
    paths,
  });

  return run;
}

export async function deleteRun(runId: string): Promise<void> {
  const run = await requireRun(runId);
  const timestamp = new Date().toISOString();
  for (const worker of activeWorkersForRun(run.id)) {
    worker.kill();
    activeWorkerProcesses.delete(worker.attemptId);
  }
  for (const key of [...activeAutopilotCycles.keys()]) {
    if (key.startsWith(`${run.id}:`)) activeAutopilotCycles.delete(key);
  }
  activeAutopilotPlans.delete(run.id);
  activeAutopilotReviews.delete(run.id);
  await appendEvent({
    timestamp,
    workspaceId: run.workspaceId,
    runId: run.id,
    type: "run.deleted",
    message: `Run deleted: ${run.title}`,
    payload: {
      title: run.title,
      artifactDir: run.artifactDir,
    },
  });

  try {
    await shell.trashItem(runDir(run.id));
  } catch {
    await fs.rm(runDir(run.id), { recursive: true, force: true });
  }
}

// ── AI plan mode ────────────────────────────────────────────────────────────
// Plan mode is a per-run flag that intercepts mutating manager decisions
// (worker dispatches that would touch the workspace) and queues them as
// pendingMutations for the user to review in the PlanDiffReview overlay.
//
// setPlanMode flips the flag and emits a system message so the chat shows
// the toggle. applyPendingMutations replays a queued worker_task_input
// through createWorkerTask + scheduleAutopilotCycles (the same path the
// autopilot uses post-decision); discardPendingMutations drops them
// entirely. Both leave the manager prompts untouched — the manager doesn't
// need to know about plan mode; the gating happens after its decision lands.

export async function setPlanMode(input: SetPlanModeInput): Promise<RunState> {
  const run = await requireRun(input.runId);
  const enabled = Boolean(input.enabled);
  if ((run.planMode ?? false) === enabled) return run;
  return commitRunChange(run, {
    type: enabled ? "run.plan_mode_enabled" : "run.plan_mode_disabled",
    message: enabled
      ? "Plan mode enabled — Spark will queue mutating actions for review"
      : "Plan mode disabled — Spark will execute mutating actions automatically",
    payload: { enabled, pending: run.pendingMutations?.length ?? 0 },
    mutate: (draft, timestamp) => {
      draft.planMode = enabled;
      draft.humanMessages.push({
        id: makeId("msg"),
        runId: draft.id,
        author: "system",
        kind: "decision",
        message: enabled
          ? "Plan mode on. Spark will queue worker dispatches for your review before executing."
          : "Plan mode off. Spark will resume executing worker dispatches automatically.",
        createdAt: timestamp,
      });
      draft.updatedAt = timestamp;
    },
  });
}

export async function applyPendingMutations(
  input: ApplyPendingMutationsInput,
): Promise<RunState> {
  let run = await requireRun(input.runId);
  const queue = run.pendingMutations ?? [];
  if (queue.length === 0) return run;

  const idFilter = input.ids && input.ids.length > 0 ? new Set(input.ids) : null;
  const toApply = idFilter ? queue.filter((m) => idFilter.has(m.id)) : queue.slice();
  if (toApply.length === 0) return run;
  const applyIds = new Set(toApply.map((m) => m.id));

  // Pop from the queue first so a mid-loop failure doesn't leave a half-
  // applied stripe of "still queued" entries. createWorkerTask is itself
  // idempotent-by-id, so re-running apply on the same set is safe.
  run = await commitRunChange(run, {
    type: "run.pending_mutations_applying",
    message: `Applying ${toApply.length} queued mutation(s)`,
    payload: {
      ids: toApply.map((m) => m.id),
      titles: toApply.map((m) => m.description),
    },
    mutate: (draft, timestamp) => {
      draft.pendingMutations = (draft.pendingMutations ?? []).filter(
        (m) => !applyIds.has(m.id),
      );
      draft.updatedAt = timestamp;
    },
  });

  for (const mutation of toApply) {
    const w = mutation.workerTaskInput;
    run = await createWorkerTask({
      runId: run.id,
      stepId: w.stepId,
      title: w.title,
      description: w.description,
      runtimePreference: w.runtimePreference,
      modelHint: w.modelHint,
      effortHint: w.effortHint,
      allowedPaths: w.allowedPaths,
      forbiddenPaths: w.forbiddenPaths,
      expectedOutputs: w.expectedOutputs,
      verificationCommands: w.verificationCommands,
      canRunParallel: w.canRunParallel,
      conflictsWith: w.conflictsWith,
      taskClass: w.taskClass,
      createdBy: "spark",
    });
  }

  await appendEvent({
    workspaceId: run.workspaceId,
    runId: run.id,
    type: "run.pending_mutations_applied",
    message: `Applied ${toApply.length} queued mutation(s)`,
    payload: {
      ids: toApply.map((m) => m.id),
      titles: toApply.map((m) => m.description),
      remaining: run.pendingMutations?.length ?? 0,
    },
  });

  // Hand the new tasks to the autopilot so they actually launch. We re-run
  // startAutopilot — it picks up unrun work via pickAutopilotTasks and
  // schedules attempts the same way the post-decision path would.
  if (run.status !== "paused" && run.status !== "cancelled") {
    const autopilotInput = autopilotInputFromRun(run);
    void startAutopilot(autopilotInput).catch(() => {
      /* startAutopilot logs its own failures via appendEvent */
    });
  }

  return run;
}

export async function discardPendingMutations(
  input: DiscardPendingMutationsInput,
): Promise<RunState> {
  const run = await requireRun(input.runId);
  const queue = run.pendingMutations ?? [];
  if (queue.length === 0) return run;

  const idFilter = input.ids && input.ids.length > 0 ? new Set(input.ids) : null;
  const toDiscard = idFilter ? queue.filter((m) => idFilter.has(m.id)) : queue.slice();
  if (toDiscard.length === 0) return run;
  const discardIds = new Set(toDiscard.map((m) => m.id));

  return commitRunChange(run, {
    type: "run.pending_mutations_discarded",
    message: `Discarded ${toDiscard.length} queued mutation(s)`,
    payload: {
      ids: toDiscard.map((m) => m.id),
      titles: toDiscard.map((m) => m.description),
    },
    mutate: (draft, timestamp) => {
      draft.pendingMutations = (draft.pendingMutations ?? []).filter(
        (m) => !discardIds.has(m.id),
      );
      draft.humanMessages.push({
        id: makeId("msg"),
        runId: draft.id,
        author: "system",
        kind: "decision",
        message:
          toDiscard.length === 1
            ? `Discarded queued mutation: ${toDiscard[0].description}`
            : `Discarded ${toDiscard.length} queued mutations.`,
        createdAt: timestamp,
      });
      draft.updatedAt = timestamp;
    },
  });
}

async function reviewWorkerReportArtifact({
  run,
  task,
  attempt,
  paths,
}: {
  run: RunState;
  task: WorkerTask;
  attempt: WorkerAttempt;
  paths: WorkerArtifactPaths;
}): Promise<RunState> {
  const report = await readWorkerReport(paths.finalReportJson);
  if (!report) {
    await appendEvent({
      workspaceId: run.workspaceId,
      runId: run.id,
      stepId: task.stepId,
      workerTaskId: task.id,
      attemptId: attempt.id,
      type: "worker_report.missing",
      message: "Worker report is missing or invalid",
      payload: {
        finalReportJson: paths.finalReportJson,
      },
    });
    return run;
  }

  await appendEvent({
    workspaceId: run.workspaceId,
    runId: run.id,
    stepId: task.stepId,
    workerTaskId: task.id,
    attemptId: attempt.id,
    type: "worker_report.parsed",
    message: `Worker report parsed: ${report.status}`,
    payload: {
      report,
      finalReportJson: paths.finalReportJson,
    },
  });

  const decision = decideWorkerReport(report);
  const latest = await requireRun(run.id);
  const reviewedTask = latest.workerTasks.find((item) => item.id === task.id);
  const reviewedStep = task.stepId ? latest.steps.find((item) => item.id === task.stepId) : undefined;
  if (!reviewedTask) return latest;

  const timestamp = new Date().toISOString();
  if (decision.decision === "accept") {
    reviewedTask.status = "accepted";
    if (reviewedStep) {
      // Promote step to "complete" once every task in it is accepted. Without
      // this the step sits at "reviewing" forever and the user sees workers
      // finish with no green check on the plan-step view.
      const stepTasks = latest.workerTasks.filter((t) => t.stepId === reviewedStep.id);
      const allAccepted =
        stepTasks.length > 0 &&
        stepTasks.every((t) => (t.id === reviewedTask.id ? true : t.status === "accepted"));
      reviewedStep.status = allAccepted
        ? "complete"
        : hasActiveStepWorkers(latest, reviewedStep.id, reviewedTask.id)
          ? "running"
          : "reviewing";
      if (allAccepted && latest.currentStepId === reviewedStep.id) latest.currentStepId = undefined;
    }
  } else {
    reviewedTask.status = "needs_review";
    if (reviewedStep) reviewedStep.status = "reviewing";
  }
  if (reviewedStep) {
    reviewedStep.reviewSummary = decision.reason;
    reviewedStep.updatedAt = timestamp;
  }
  reviewedTask.updatedAt = timestamp;
  latest.updatedAt = timestamp;
  await saveRun(latest);
  await appendEvent({
    timestamp,
    workspaceId: latest.workspaceId,
    runId: latest.id,
    stepId: reviewedTask.stepId,
    workerTaskId: reviewedTask.id,
    attemptId: attempt.id,
    type: "worker_report.reviewed",
    message: `Worker report review decision: ${decision.decision}`,
    payload: {
      decision,
      reportStatus: report.status,
    },
  });

  return latest;
}

async function collectWorkerReportContext(run: RunState): Promise<SparkManagerWorkerReportContext[]> {
  const contexts: SparkManagerWorkerReportContext[] = [];
  for (const attempt of run.workerAttempts.slice(-8)) {
    const task = run.workerTasks.find((item) => item.id === attempt.workerTaskId);
    if (!task) continue;
    const reportPath =
      attempt.finalReportPath ??
      workerArtifactPaths(run.id, task.stepId, task.id, attempt.id).finalReportJson;
    const report = await readWorkerReport(reportPath);
    contexts.push({
      taskTitle: task.title,
      runtime: attempt.runtime,
      taskStatus: task.status,
      attemptStatus: attempt.status,
      reportStatus: report?.status,
      summary: report?.summary,
      proof: report?.proof ?? [],
      risks: report?.risks ?? [],
      followups: report?.followups ?? [],
      verifier: report?.verifier
        ? {
            status: report.verifier.status,
            confidence: report.verifier.confidence,
            atomicClaims: report.verifier.atomicClaims,
            correctivePrompt: report.verifier.correctivePrompt,
            missingOracle: report.verifier.missingOracle,
          }
        : undefined,
      taskClass: task.taskClass,
    });
  }
  return contexts;
}

async function saveRun(run: RunState): Promise<void> {
  const previous = runWriteQueues.get(run.id) ?? Promise.resolve();
  const next = previous
    .catch(() => {
      /* keep later writes moving after an earlier failure */
    })
    .then(() => writeRunFile(run));
  runWriteQueues.set(run.id, next);
  try {
    await next;
  } finally {
    if (runWriteQueues.get(run.id) === next) runWriteQueues.delete(run.id);
  }
}

async function writeRunFile(run: RunState): Promise<void> {
  await fs.mkdir(runDir(run.id), { recursive: true });
  const path = runPath(run.id);
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(run, null, 2), "utf8");
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rename(tmp, path);
      return;
    } catch (err: unknown) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (!["EEXIST", "EPERM", "EBUSY"].includes(code ?? "")) throw err;
      await fs.rm(path, { force: true }).catch(() => undefined);
      await delay(25 * (attempt + 1));
    }
  }

  try {
    await fs.rm(path, { force: true }).catch(() => undefined);
    await fs.copyFile(tmp, path);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  } catch (err) {
    throw lastError ?? err;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requireRun(runId: string): Promise<RunState> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  return run;
}

function normalizeRun(run: RunState): RunState {
  run.humanMessages ??= [];
  for (const step of run.steps ?? []) {
    step.plannedAgents ??= [];
  }
  run.autopilot ??= {
    status: run.status === "running" ? "running" : "idle",
    updatedAt: run.updatedAt,
  };
  // Plan-mode fields are additive; older run.json files predate them and
  // would otherwise read as undefined and break consumers that expect arrays.
  run.planMode ??= false;
  run.pendingMutations ??= [];
  return run;
}

async function commitRunChange(
  run: RunState,
  change: {
    type: string;
    message: string;
    stepId?: string;
    workerTaskId?: string;
    payload?: Record<string, unknown>;
    mutate: (draft: RunState, timestamp: string) => void;
  },
): Promise<RunState> {
  const timestamp = new Date().toISOString();
  change.mutate(run, timestamp);
  await saveRun(run);
  await appendEvent({
    timestamp,
    workspaceId: run.workspaceId,
    runId: run.id,
    stepId: change.stepId,
    workerTaskId: change.workerTaskId,
    type: change.type,
    message: change.message,
    payload: change.payload,
  });
  return run;
}

function changedFields(input: object, excluded: string[]): string[] {
  const values = input as Record<string, unknown>;
  return Object.keys(values).filter((key) => !excluded.includes(key) && values[key] !== undefined);
}

function pickAutopilotStep(run: RunState): StepState | undefined {
  return (
    run.steps.find((step) => !["complete", "failed", "skipped"].includes(step.status)) ??
    run.steps[0]
  );
}

// Hard cap on attempts per worker task. The manager is allowed to retry, but
// after this many failures we treat the task as terminally failed instead of
// looping forever — the previous behaviour wasted ~30 min on a codex trust
// prompt that headless can't dismiss.
const MAX_WORKER_ATTEMPTS = 3;

function countWorkerAttempts(run: RunState, taskId: string): number {
  return run.workerAttempts.filter((attempt) => attempt.workerTaskId === taskId).length;
}

function pickAutopilotTasks(run: RunState): WorkerTask[] {
  const activeStep = pickAutopilotStep(run);
  const terminalStepIds = new Set(
    run.steps
      .filter((step) => ["complete", "failed", "skipped"].includes(step.status))
      .map((step) => step.id),
  );
  const candidates = run.workerTasks.filter((task) => {
    if (!["created", "queued", "failed", "retry_queued"].includes(task.status)) return false;
    if (task.status === "failed" && countWorkerAttempts(run, task.id) >= MAX_WORKER_ATTEMPTS) {
      return false;
    }
    if (!activeStep) return true;
    if (task.stepId === activeStep.id) return true;
    // Orphaned task: stepId points to a terminal step (manager queued late, or
    // step.index resolution attached it to the wrong step). Surface it on the
    // active step so the autopilot launches it instead of stalling.
    if (task.stepId && terminalStepIds.has(task.stepId)) return true;
    return false;
  });
  if (candidates.length === 0) return [];

  const first = candidates[0];
  if (!first.canRunParallel) return [first];

  const selected: WorkerTask[] = [];
  for (const task of candidates) {
    if (!task.canRunParallel) continue;
    if (selected.some((other) => other.conflictsWith.includes(task.id) || task.conflictsWith.includes(other.id))) {
      continue;
    }
    selected.push(task);
  }
  return selected.length > 0 ? selected : [first];
}

// True when the next active step is a worker_batch with plannedAgents but no
// queueable worker tasks. Used by the autopilot review loop to decide whether
// to invoke step_planning before declaring "nothing to do".
function needsStepPlanning(run: RunState): boolean {
  const active = pickAutopilotStep(run);
  if (!active) return false;
  if ((active.kind ?? "worker_batch") !== "worker_batch") return false;
  if ((active.plannedAgents?.length ?? 0) === 0) return false;
  const queueable: WorkerTaskStatus[] = ["created", "queued", "retry_queued"];
  const hasQueueable = run.workerTasks.some(
    (task) => task.stepId === active.id && queueable.includes(task.status),
  );
  return !hasQueueable;
}

function hasPlannedWorkAfterBrake(run: RunState): boolean {
  const active = pickAutopilotStep(run);
  if (!active) return false;
  if ((active.kind ?? "worker_batch") !== "worker_batch") return false;
  if ((active.plannedAgents?.length ?? 0) > 0) return true;
  return run.workerTasks.some((task) => {
    if (task.stepId !== active.id) return false;
    return !["accepted", "cancelled"].includes(task.status);
  });
}

function resolveTaskStepId(run: RunState, requestedStepIndex: number | undefined, createdStepIds: string[]): string | undefined {
  if (run.steps.length === 0) return undefined;

  // Honor the manager's requested stepIndex when both interpretations
  // (one-based step.index match vs zero-based array slot) point to a step
  // the autopilot will actually run. Empirically grok-4.3 has shipped both
  // conventions across versions; if we lock to one, the other interpretation
  // orphans tasks on terminal steps and the autopilot stalls.
  const isTerminal = (step: StepState) =>
    ["complete", "failed", "skipped"].includes(step.status);
  if (typeof requestedStepIndex === "number" && Number.isFinite(requestedStepIndex)) {
    const oneBasedStep = run.steps.find((step) => step.index === requestedStepIndex);
    const zeroBasedStep = run.steps[requestedStepIndex];
    if (oneBasedStep && !isTerminal(oneBasedStep)) return oneBasedStep.id;
    if (zeroBasedStep && !isTerminal(zeroBasedStep)) return zeroBasedStep.id;
    // Both interpretations land on terminal steps. Fall through to the
    // active step — orphaning the task on a complete step deadlocks
    // pickAutopilotTasks, which only launches tasks for the active step.
  }

  const activeStep = pickAutopilotStep(run);
  if (activeStep) return activeStep.id;

  const availableStepIds = createdStepIds.length > 0 ? createdStepIds : run.steps.map((step) => step.id);
  return availableStepIds[0];
}

function hasActiveStepWorkers(run: RunState, stepId: string, excludingTaskId?: string): boolean {
  const activeTaskIds = new Set(
    run.workerTasks
      .filter((task) =>
        task.stepId === stepId &&
        task.id !== excludingTaskId &&
        ["claimed", "running"].includes(task.status),
      )
      .map((task) => task.id),
  );
  return run.workerAttempts.some(
    (attempt) =>
      activeTaskIds.has(attempt.workerTaskId) &&
      ["preparing", "prompt_ready", "launching", "running", "finishing"].includes(attempt.status),
  );
}

async function askHumanQuestion(runId: string, message: string): Promise<RunState> {
  const run = await addRunMessage({
    runId,
    author: "spark",
    kind: "question",
    message,
  });
  return pauseRun({
    runId: run.id,
    reason: HUMAN_INPUT_PAUSE_REASON,
  });
}

function shouldRecordPauseReasonAsUserNote(reason: string): boolean {
  return reason !== "Paused by user" && reason !== HUMAN_INPUT_PAUSE_REASON;
}

function normalizePlannedAgentLabels(
  agents: NonNullable<StepState["plannedAgents"]>,
  stepIndex: number,
): NonNullable<StepState["plannedAgents"]> {
  return agents.map((agent, index) => ({
    ...agent,
    label: normalizePlannedAgentLabel(agent.label, stepIndex, index + 1),
  }));
}

function normalizePlannedAgentLabel(label: string | undefined, stepIndex: number, agentIndex: number): string {
  const trimmed = label?.trim() ?? "";
  const workerStepLabel = trimmed.match(/^worker\s+\d+\.(\d+)$/i);
  if (workerStepLabel) return `worker ${stepIndex}.${workerStepLabel[1]}`;
  if (/^worker\s+\d+$/i.test(trimmed)) return `worker ${stepIndex}.${agentIndex}`;
  return trimmed || `worker ${stepIndex}.${agentIndex}`;
}

function activeWorkersForRun(runId: string): ActiveWorkerProcess[] {
  return Array.from(activeWorkerProcesses.values()).filter((worker) => worker.runId === runId);
}

function shouldResumeManagerPlanning(run: RunState): boolean {
  if (activeWorkersForRun(run.id).length > 0) return false;
  if (run.status !== "paused" || run.autopilot?.status !== "paused") return false;
  return run.humanMessages.some((message) => message.author === "spark" && message.kind === "question");
}

function autopilotInputFromRun(run: RunState): StartAutopilotInput {
  const plan = run.planId
    ? run.plans.find((item) => item.id === run.planId)
    : run.plans.at(-1);
  const latestAttemptCwd = run.workerAttempts
    .slice()
    .reverse()
    .find((attempt) => attempt.cwd)?.cwd;
  const cwd = latestAttemptCwd || (plan?.sourceFile ? dirname(plan.sourceFile) : process.cwd());
  return {
    runId: run.id,
    workspaceId: run.workspaceId,
    workspaceName: run.title.replace(/^Autopilot -\s*/i, "") || "workspace",
    cwd,
    planPath: plan?.sourceFile,
    planText: plan?.rawContent,
    planTitle: plan?.title,
  };
}

async function sendPauseSignals(run: RunState, reason: string): Promise<void> {
  const workers = activeWorkersForRun(run.id);
  await Promise.all(
    workers.map(async (worker) => {
      writeWorkerInput(worker, ESC_KEY);
      await appendEvent({
        workspaceId: run.workspaceId,
        runId: run.id,
        stepId: worker.stepId,
        workerTaskId: worker.workerTaskId,
        attemptId: worker.attemptId,
        type: "worker_attempt.pause_signal_sent",
        message: "Pause signal sent to worker attempt",
        payload: {
          signal: "escape",
          reason,
          pid: worker.pid,
          command: worker.command,
        },
      });
    }),
  );
}

async function sendResumeSignals(
  run: RunState,
  resumePrompt: { kind: "continue" | "prompt"; input: string; messageId?: string },
): Promise<void> {
  const workers = activeWorkersForRun(run.id);
  await Promise.all(
    workers.map(async (worker) => {
      writeWorkerInput(worker, resumePrompt.input);
      await appendEvent({
        workspaceId: run.workspaceId,
        runId: run.id,
        stepId: worker.stepId,
        workerTaskId: worker.workerTaskId,
        attemptId: worker.attemptId,
        type: "worker_attempt.resume_signal_sent",
        message:
          resumePrompt.kind === "prompt"
            ? "Resume prompt sent to worker attempt"
            : "Continue signal sent to worker attempt",
        payload: {
          signal: resumePrompt.kind,
          messageId: resumePrompt.messageId,
          pid: worker.pid,
          command: worker.command,
        },
      });
    }),
  );
}

function writeWorkerInput(worker: ActiveWorkerProcess, input: string): void {
  worker.write(input);
}

function buildResumePrompt(run: RunState): { kind: "continue" | "prompt"; input: string; messageId?: string } {
  const pausedAt = run.autopilot?.pausedAt;
  const userUpdate = run.humanMessages
    .slice()
    .reverse()
    .find((message) => {
      if (message.author !== "user") return false;
      if (!pausedAt) return true;
      return message.createdAt >= pausedAt;
    });

  const pauseReason = run.autopilot?.stopReason?.trim();
  const promptText =
    userUpdate?.message ??
    (pauseReason && pauseReason !== "Paused by user" ? pauseReason : undefined);

  if (!promptText) {
    return { kind: "continue", input: CONTINUE_INPUT };
  }

  return {
    kind: "prompt",
    messageId: userUpdate?.id,
    input: [
      "",
      "SPARK MANAGER UPDATE",
      "The user changed or clarified the direction while this worker was paused.",
      "Use this instruction if it applies to your task; otherwise continue with the existing assignment.",
      "",
      promptText,
      "",
      "continue",
      "",
    ].join("\r\n"),
  };
}

export async function readWorkerReport(path: string): Promise<WorkerReport | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  try {
    return normalizeWorkerReport(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return null;
  }
}

function normalizeWorkerReport(raw: Record<string, unknown>): WorkerReport {
  const status = raw.status;
  if (status !== "complete" && status !== "partial" && status !== "blocked" && status !== "failed") {
    throw new Error("Invalid worker report status.");
  }

  return {
    status,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    filesChanged: normalizeReportItems(raw.filesChanged ?? raw.files_changed, ["path", "reason"]),
    commandsRun: normalizeCommandReports(raw.commandsRun ?? raw.commands_run),
    tests: normalizeTestReports(raw.tests),
    proof: normalizeStringList(raw.proof),
    risks: normalizeStringList(raw.risks),
    followups: normalizeStringList(raw.followups),
    verifier: normalizeVerifierVerdict(raw.verifier),
  };
}

function normalizeVerifierVerdict(value: unknown): VerifierVerdict | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const status = raw.status;
  const confidenceRaw = raw.confidence;
  const okStatus = status === "verified" || status === "failed" || status === "unsure";
  const okConfidence =
    confidenceRaw === "PERFECT" ||
    confidenceRaw === "VERIFIED" ||
    confidenceRaw === "PARTIAL" ||
    confidenceRaw === "FEEDBACK" ||
    confidenceRaw === "FAILED";
  if (!okStatus || !okConfidence) return undefined;
  const claimsRaw = Array.isArray(raw.atomic_claims)
    ? raw.atomic_claims
    : Array.isArray(raw.atomicClaims)
      ? raw.atomicClaims
      : [];
  const atomicClaims = claimsRaw
    .filter((item: unknown): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item: Record<string, unknown>) => {
      const v = item.verdict;
      const verdict: "verified" | "failed" | "unsure" =
        v === "verified" || v === "failed" || v === "unsure" ? v : "unsure";
      return {
        claim: typeof item.claim === "string" ? item.claim : "",
        verdict,
        evidence: typeof item.evidence === "string" ? item.evidence : "",
      };
    });
  const correctivePrompt =
    typeof raw.corrective_prompt === "string"
      ? raw.corrective_prompt
      : typeof raw.correctivePrompt === "string"
        ? raw.correctivePrompt
        : undefined;
  const missingOracle =
    typeof raw.missing_oracle === "string"
      ? raw.missing_oracle
      : typeof raw.missingOracle === "string"
        ? raw.missingOracle
        : undefined;
  return {
    status,
    confidence: confidenceRaw,
    atomicClaims,
    correctivePrompt: correctivePrompt && correctivePrompt.trim().length > 0 ? correctivePrompt : undefined,
    missingOracle: missingOracle && missingOracle.trim().length > 0 ? missingOracle : undefined,
  };
}

function normalizeReportItems(value: unknown, keys: ["path", "reason"]): WorkerReport["filesChanged"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => {
      const path = item[keys[0]];
      const reason = item[keys[1]];
      return {
        path: typeof path === "string" ? path : "",
        reason: typeof reason === "string" ? reason : "",
      };
    });
}

function normalizeCommandReports(value: unknown): WorkerReport["commandsRun"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      command: typeof item.command === "string" ? item.command : "",
      exitCode: typeof item.exitCode === "number" ? item.exitCode : typeof item.exit_code === "number" ? item.exit_code : undefined,
      summary: typeof item.summary === "string" ? item.summary : "",
    }));
}

function normalizeTestReports(value: unknown): WorkerReport["tests"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => {
      const result = item.result;
      return {
        command: typeof item.command === "string" ? item.command : "",
        result: result === "passed" || result === "failed" || result === "not_run" ? result : "not_run",
        details: typeof item.details === "string" ? item.details : undefined,
      };
    });
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function decideWorkerReport(report: WorkerReport): ReviewDecision {
  if (report.status === "complete") {
    // Trust complete-status reports. Workers are full Claude/Codex harnesses
    // and can run their own verification — risks/followups are advisory, not
    // blockers. The manager loop reviews them when planning the next step.
    return {
      decision: "accept",
      confidence: 0.7,
      reason: report.summary || "Worker reported completion.",
      issues: [...report.risks, ...report.followups],
      acceptedEvidence: report.proof,
      nextStepAllowed: true,
    };
  }

  if (report.status === "failed") {
    return {
      decision: "retry_same_worker",
      confidence: 0.65,
      reason: report.summary || "Worker reported failure.",
      issues: [...report.risks, ...report.followups],
      acceptedEvidence: report.proof,
      nextStepAllowed: false,
    };
  }

  if (report.status === "blocked") {
    return {
      decision: "escalate_to_user",
      confidence: 0.75,
      reason: report.summary || "Worker reported a blocker.",
      issues: [...report.risks, ...report.followups],
      acceptedEvidence: report.proof,
      nextStepAllowed: false,
    };
  }

  return {
    decision: "escalate_to_user",
    confidence: 0.55,
    reason: report.summary || "Worker produced a partial report that needs review.",
    issues: [...report.risks, ...report.followups],
    acceptedEvidence: report.proof,
    nextStepAllowed: false,
  };
}

function workerArtifactPaths(
  runId: string,
  stepId: string | undefined,
  workerTaskId: string,
  attemptId: string,
): WorkerArtifactPaths {
  const stepSegment = stepId ?? "no-step";
  const attemptDir = join(runDir(runId), "steps", stepSegment, "workers", workerTaskId, "attempts", attemptId);
  return {
    workerTaskId,
    attemptId,
    attemptDir,
    taskJson: join(attemptDir, "task.json"),
    promptMd: join(attemptDir, "prompt.md"),
    workpadMd: join(attemptDir, "workpad.md"),
    stdoutLog: join(attemptDir, "stdout.log"),
    stderrLog: join(attemptDir, "stderr.log"),
    rawLog: join(attemptDir, "raw.log"),
    finalReportJson: join(attemptDir, "final-report.json"),
  };
}

// The orchestration worker now uses the EXACT same pty path as a user-opened
// terminal (and the TEST CLAUDE button): the renderer's TerminalView spawns
// pwsh via pty-manager, sizes it to its real pane, and we just type into it
// from main — first the launch command, then the prompt followed by Enter.
// No second pty stack, no attachOnly mode, no stripped -NoProfile shell.
async function runWorkerSession({
  run,
  task,
  attemptId,
  paths,
  launchCommand,
  promptText,
  command,
}: {
  run: RunState;
  task: WorkerTask;
  attemptId: string;
  paths: WorkerArtifactPaths;
  cwd: string;
  launchCommand: string | null;
  promptText: string;
  command: string;
}): Promise<{ exitCode: number; error?: string }> {
  // Wait until the renderer's TerminalView mounts and calls pty:spawn for
  // this attempt. The "envelope_prepared" event triggers the pane add in
  // App.tsx; from there it's normally <1s before pty-manager has a session.
  const spawned = await pty.waitForSpawn(attemptId, 30_000);
  if (!spawned) {
    return { exitCode: 1, error: "Worker pane never spawned (renderer did not call pty:spawn within 30s)." };
  }

  // Hold off on typing until the renderer has reported a real pane size, so
  // claude/codex paint at the correct width from the very first frame.
  await pty.waitForResize(attemptId, 5_000);

  // Mirror the worker's pty byte stream to raw.log so a hung worker is
  // debuggable after the fact. Without this, the only on-disk evidence of
  // what the agent CLI printed lives in the renderer's xterm.js scrollback —
  // which doesn't exist in headless eval mode and is wiped when an
  // interactive pane is closed.
  const rawStream = createWriteStream(paths.rawLog, { flags: "a" });
  const offRawTap = pty.tap(attemptId, (chunk) => {
    try {
      rawStream.write(chunk);
    } catch {
      /* best-effort; never let logging break the run loop */
    }
  });

  const handle = {
    write: (input: string) => pty.write(attemptId, input),
    kill: () => pty.dispose(attemptId),
  };

  const runningTimestamp = new Date().toISOString();
  await markAttemptRunning(run.id, task.id, attemptId, runningTimestamp);
  await appendEvent({
    timestamp: runningTimestamp,
    workspaceId: run.workspaceId,
    runId: run.id,
    stepId: task.stepId,
    workerTaskId: task.id,
    attemptId,
    type: "worker_attempt.running",
    message: `Worker attempt running: ${task.title}`,
    payload: {
      command,
      runtime: task.runtimePreference,
      session: "pty",
    },
  });

  activeWorkerProcesses.set(attemptId, {
    runId: run.id,
    stepId: task.stepId,
    workerTaskId: task.id,
    attemptId,
    command,
    write: handle.write,
    kill: handle.kill,
  });

  // Resolve when either:
  //   * the launch driver detects the agent never started (fast fail), or
  //   * the worker writes final-report.json (success path), or
  //   * the user closes the pane (ptyExit), or
  //   * we hit the hard timeout (90 minutes).
  let failFast: (reason: string) => void = () => undefined;
  const exitPromise = new Promise<{ exitCode: number; error?: string }>((resolve) => {
    let settled = false;
    const finish = (value: { exitCode: number; error?: string }) => {
      if (settled) return;
      settled = true;
      offExit();
      offRawTap();
      rawStream.end();
      clearInterval(reportPoll);
      clearTimeout(hardTimeout);
      resolve(value);
    };
    const offExit = pty.onExit(attemptId, (info) => {
      finish({
        exitCode: info.exitCode ?? 1,
        error: info.signal ? `Worker pane closed (signal ${info.signal})` : "Worker pane closed before final report",
      });
    });
    const reportPoll = setInterval(() => {
      void fs.access(paths.finalReportJson)
        .then(() => finish({ exitCode: 0 }))
        .catch(() => {
          /* not yet written */
        });
    }, 750);
    const hardTimeout = setTimeout(() => {
      finish({ exitCode: 1, error: "Worker timed out after 90 minutes." });
    }, 90 * 60 * 1000);
    failFast = (reason: string) => finish({ exitCode: 1, error: reason });
  });

  // Stagger launch + prompt the same way the TEST CLAUDE button does:
  //  1. wait 1.5s for pwsh to render its prompt,
  //  2. type `claude --dangerously-skip-permissions ...\r`,
  //  3. sniff pty output for the agent's TUI banner (claude/codex), with a
  //     hard timeout so a bad launch command (codex not installed, wrong
  //     model id, etc.) fails the worker fast instead of hanging the whole
  //     run waiting for a final report that will never come,
  //  4. paste the prompt and submit.
  void (async () => {
    try {
      await delay(1500);
      if (launchCommand) {
        handle.write(`${launchCommand}\r`);
        const launched = await waitForAgentTui(attemptId, task.runtimePreference);
        if (!launched.ok) {
          await recordWorkerOutput(
            run,
            task,
            attemptId,
            paths,
            "stderr",
            `\n[spark] ${task.runtimePreference} TUI did not start within ${launched.timeoutMs}ms — ${launched.reason}.\n` +
              "Aborting paste; check that the runtime is installed, logged in, and the model id is valid.\n",
          );
          await writeAutoFailureReport(paths, task, launched.reason);
          failFast(`${task.runtimePreference} CLI failed to launch: ${launched.reason}`);
          return;
        }
      }
      await pasteAndSubmit(handle, promptText, task.runtimePreference);
    } catch (err) {
      await recordWorkerOutput(run, task, attemptId, paths, "stderr",
        `\n[spark] failed to drive worker pane: ${(err as Error).message}\n`);
    }
  })();

  const result = await exitPromise;
  activeWorkerProcesses.delete(attemptId);
  return result;
}

// Sniff the pty output stream for an agent-TUI marker so we know the launch
// command actually became the foreground process. If we don't see one inside
// the budget, the launch failed — pwsh is back at its prompt and pasting the
// worker prompt would just shove it in as command input. Returns the reason
// for failure so we can log + write a fail-report.
async function waitForAgentTui(
  attemptId: string,
  runtime: WorkerTask["runtimePreference"],
): Promise<{ ok: true } | { ok: false; reason: string; timeoutMs: number }> {
  // Markers that indicate the CLI's TUI is running. Both claude and codex
  // emit their model name on first paint, plus Ink/React-CLI specific frames.
  // We also look for the "bypass permissions" banner claude prints with our
  // launch flag, and codex's "/help" or "Pasted Content" hints.
  const claudeMarkers = [
    "bypass permissions",
    "Sonnet",
    "Opus",
    "Haiku",
    "claude-sonnet",
    "claude-opus",
    "claude-haiku",
  ];
  const codexMarkers = [
    "GPT-",
    "gpt-5",
    "/help",
    "Pasted Content",
    "Codex",
    "codex >",
    "Reasoning effort",
  ];
  const markers = runtime === "codex" ? codexMarkers : claudeMarkers;
  // Patterns that signal a hard launch failure — pwsh complaining the binary
  // isn't on PATH, or a CommandNotFoundException, or the CLI rejecting an
  // invalid flag. If we see any of these we bail immediately rather than
  // waiting out the budget.
  const failureMarkers = [
    "is not recognized as the name of a cmdlet",
    "CommandNotFoundException",
    "command not found",
    "ENOENT",
    "error: option",
    "error: unknown option",
    "Unknown option",
    "is invalid. It must be one of",
  ];
  const timeoutMs = runtime === "codex" ? 12_000 : 9_000;

  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    let sawOscC = false;
    const finish = (value: { ok: true } | { ok: false; reason: string; timeoutMs: number }) => {
      if (settled) return;
      settled = true;
      offTap();
      clearTimeout(timer);
      resolve(value);
    };
    const offTap = pty.tap(attemptId, (chunk) => {
      // Keep the ring buffer small; we only need the most recent visible text.
      buffer = (buffer + chunk.toString("utf8")).slice(-4096);

      // Track spark.ps1's OSC 633 markers so we can detect "launch command
      // returned to shell" — the shell integration emits ESC ]633;C right
      // before a command runs and ESC ]633;D;<exit> when it finishes. If we
      // see D after C for our launch command, the agent CLI exited (bad
      // flag, auth error, missing binary) and pwsh is back at its prompt;
      // pasting the worker prompt would just dump it as shell input.
      if (!sawOscC && /\x1b\]633;C/.test(buffer)) sawOscC = true;
      if (sawOscC && /\x1b\]633;D;/.test(buffer)) {
        finish({
          ok: false,
          reason:
            "launch command returned to shell prompt — agent CLI exited before TUI took over (bad flag, auth, or missing binary)",
          timeoutMs,
        });
        return;
      }

      // Strip CSI and OSC escape sequences so the echoed command line in
      // ]633;E;<command> doesn't false-positive against marker text like
      // "claude-haiku" — the model name appears in the typed command and
      // would otherwise look identical to the TUI banner.
      const visible = buffer
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI
        .replace(/\x1b\][^\x07]*\x07/g, ""); // OSC ESC ] ... BEL
      for (const marker of markers) {
        if (visible.includes(marker)) {
          finish({ ok: true });
          return;
        }
      }
      for (const marker of failureMarkers) {
        if (visible.includes(marker)) {
          finish({
            ok: false,
            reason: `runtime binary did not start (saw '${marker}')`,
            timeoutMs,
          });
          return;
        }
      }
    });
    const timer = setTimeout(() => {
      finish({ ok: false, reason: "no TUI banner observed", timeoutMs });
    }, timeoutMs);
  });
}

// Write a synthetic final-report so the autopilot review loop can consume the
// failure as worker evidence (the manager will see status=failed and decide
// whether to retry, route to a different runtime, or ask the user).
async function writeAutoFailureReport(
  paths: WorkerArtifactPaths,
  task: WorkerTask,
  reason: string,
): Promise<void> {
  const report: WorkerReport = {
    status: "failed",
    summary: `Spark could not start the ${task.runtimePreference} CLI for this task: ${reason}.`,
    filesChanged: [],
    commandsRun: [],
    tests: [],
    proof: [],
    risks: [
      `${task.runtimePreference} CLI failed to launch — verify it is installed, logged in, and the model id is valid.`,
    ],
    followups: [
      "Verify the CLI is installed, on PATH, and logged in, then re-run.",
    ],
  };
  try {
    await fs.writeFile(paths.finalReportJson, JSON.stringify(report, null, 2), "utf8");
  } catch {
    /* if we can't write the report the watchdog still resolves on pty exit */
  }
}

// Send a multi-line prompt as a single bracketed paste (so Ink-based TUIs
// don't treat each newline as Enter), then submit with \r. Empty prompt =>
// no-op (manual runtime: user drives the shell themselves).
async function pasteAndSubmit(
  handle: { write: (input: string) => void },
  promptText: string,
  runtime: WorkerTask["runtimePreference"],
): Promise<void> {
  const body = promptText.replace(/\r\n?/g, "\n").trim();
  if (!body) return;
  if (runtime === "claude" || runtime === "codex") {
    const PASTE_BEGIN = "\x1b[200~";
    const PASTE_END = "\x1b[201~";
    handle.write(PASTE_BEGIN);
    await delay(25);
    handle.write(body);
    await delay(25);
    handle.write(PASTE_END);
    // Long Spark prompts take a moment for the agent TUI to commit from
    // bracketed-paste into the actual input box. Submitting too early leaves
    // Claude sitting there with the prompt visible but unsent.
    await delay(promptSubmitSettleMs(runtime, body.length));
    handle.write("\r");
    if (runtime === "claude" || runtime === "codex") {
      // Some TUI builds drop the first Enter right after a large paste. A
      // second Enter is harmless while the agent is busy and fixes the stuck
      // "prompt typed but not submitted" state.
      await delay(700);
      handle.write("\r");
    }
    return;
  }
  // Manual / shell runtimes: just dump the prompt as text into pwsh as a
  // here-string comment so the user can read it. They drive the work
  // themselves and write the final-report.json by hand.
  handle.write(`# Prompt:\r`);
  for (const line of body.split("\n")) {
    handle.write(`# ${line}\r`);
  }
}

function promptSubmitSettleMs(
  runtime: WorkerTask["runtimePreference"],
  promptLength: number,
): number {
  const sizeCost = Math.ceil(promptLength / 2048) * 150;
  if (runtime === "claude") return clamp(1800 + sizeCost, 1800, 5000);
  if (runtime === "codex") return clamp(1200 + sizeCost, 1200, 4500);
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function markAttemptRunning(
  runId: string,
  workerTaskId: string,
  attemptId: string,
  timestamp: string,
): Promise<void> {
  const run = await requireRun(runId);
  const attempt = run.workerAttempts.find((item) => item.id === attemptId);
  const task = run.workerTasks.find((item) => item.id === workerTaskId);
  if (!attempt || !task) return;
  const step = task.stepId ? run.steps.find((item) => item.id === task.stepId) : undefined;
  attempt.status = "running";
  task.status = "running";
  attempt.startedAt = attempt.startedAt ?? timestamp;
  task.updatedAt = timestamp;
  if (step && !["complete", "failed", "skipped"].includes(step.status)) {
    step.status = "running";
    step.updatedAt = timestamp;
    run.currentStepId = step.id;
  }
  run.updatedAt = timestamp;
  await saveRun(run);
}

async function recordWorkerOutput(
  run: RunState,
  task: WorkerTask,
  attemptId: string,
  paths: WorkerArtifactPaths,
  stream: "stdout" | "stderr",
  text: string,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const logPath = stream === "stdout" ? paths.stdoutLog : paths.stderrLog;
  await Promise.all([
    fs.appendFile(logPath, text, "utf8"),
    fs.appendFile(paths.rawLog, `[${timestamp}] ${stream}\n${text}\n`, "utf8"),
  ]);
}

// Returns the full command line we type into pwsh — the same string a user
// would type at TEST CLAUDE: `claude --dangerously-skip-permissions ...`.
// Returns null for runtimes that don't auto-launch (manual / shell), in
// which case the worker pane is just a plain pwsh and the prompt is dumped
// as comments for the user to drive themselves.
function buildLaunchCommandLine(task: WorkerTask, cwd: string): string | null {
  if (task.runtimePreference === "claude") {
    const args = ["claude", "--dangerously-skip-permissions"];
    if (task.modelHint?.trim()) args.push("--model", quoteShellArg(task.modelHint.trim()));
    const claudeEffort = mapClaudeEffort(task.effortHint);
    if (claudeEffort) args.push("--effort", claudeEffort);
    return args.join(" ");
  }
  if (task.runtimePreference === "codex") {
    // codex >= v0.128 ignores the older `-c projects."<abs>".trust_level=...`
    // override at the command line — it requires an exact-path match in the
    // saved config.toml against codex's own normalized cwd (lowercase,
    // backslash). We write that entry from launchWorkerAttempt before
    // spawning, so by the time codex --yolo starts, the directory is already
    // trusted and the prompt is skipped silently.
    return "codex --yolo";
  }
  return null;
}

// Codex v0.128 stores trusted-directory entries in ~/.codex/config.toml as
// `[projects.'<lowercase-backslash-cwd>'] trust_level = "trusted"`. The
// directory-trust prompt on TUI launch matches the cwd against that exact
// key only — parent-dir trust does NOT propagate, and the -c CLI override
// stopped being honored. We append the entry once per cwd before spawning
// so node-pty workers don't get stuck on the prompt.
//
// Concurrency: when two codex workers in the same workspace spawn at the same
// time (parallel impl+verifier, two peer impls), both calls would otherwise
// read the file before either writes, both see "no entry", and both append —
// producing a duplicate `[projects.'X']` key that fails TOML parsing on the
// next codex launch. We serialize per configPath via a process-local lock so
// the read+check+append window is atomic.
const codexConfigLocks = new Map<string, Promise<unknown>>();
async function ensureCodexProjectTrust(cwd: string): Promise<void> {
  if (!cwd) return;
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  if (!homeDir) return;
  const configPath = join(homeDir, ".codex", "config.toml");
  const prior = codexConfigLocks.get(configPath) ?? Promise.resolve();
  const next = prior.then(() => writeCodexProjectTrustEntry(configPath, cwd)).catch(() => undefined);
  codexConfigLocks.set(configPath, next);
  await next;
  if (codexConfigLocks.get(configPath) === next) {
    codexConfigLocks.delete(configPath);
  }
}

async function writeCodexProjectTrustEntry(configPath: string, cwd: string): Promise<void> {
  const tomlKey = cwd.toLowerCase().replace(/\//g, "\\");
  const entry = `[projects.'${tomlKey}']\ntrust_level = "trusted"\n`;
  let existing = "";
  try {
    existing = await fs.readFile(configPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return;
    await fs.mkdir(dirname(configPath), { recursive: true }).catch(() => undefined);
  }
  if (existing.includes(`[projects.'${tomlKey}']`)) {
    return;
  }
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await fs.appendFile(configPath, `${sep}\n${entry}`, "utf8");
}

// Translate Spark's internal effort scale to the values the claude CLI
// actually accepts: low, medium, high, xhigh, max. Spark's manager profile
// emits "minimal" for the cheapest/quickest leaf tasks, which the CLI
// rejects with `error: option '--effort <level>' argument 'minimal' is
// invalid`. Mapping minimal -> low preserves the manager's intent (lowest
// effort) without making the launch command an obvious error.
function mapClaudeEffort(effort: WorkerTask["effortHint"] | undefined): string | null {
  if (!effort) return null;
  if (effort === "minimal") return "low";
  if (effort === "xhigh") return "xhigh";
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "max") {
    return effort;
  }
  // Unknown values default to low rather than passing them through and
  // letting the CLI fail.
  return "low";
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

async function readWorkerPromptForLaunch(paths: WorkerArtifactPaths): Promise<string> {
  try {
    return await fs.readFile(paths.promptMd, "utf8");
  } catch {
    return [
      "You are a Spark worker. The prepared prompt could not be read at launch.",
      `Read it now: ${paths.promptMd}`,
      `Then complete the task and write the final JSON report to ${paths.finalReportJson}.`,
    ].join("\n");
  }
}

function renderWorkerPrompt({
  cwd,
  step,
  task,
  paths,
}: {
  cwd: string;
  run: RunState;
  step?: StepState;
  task: WorkerTask;
  paths: WorkerArtifactPaths;
}): string {
  if (task.taskClass === "verifier") {
    return renderVerifierWorkerPrompt({ cwd, step, task, paths });
  }
  return renderImplementationWorkerPrompt({ cwd, step, task, paths });
}

function renderImplementationWorkerPrompt({
  cwd,
  step,
  task,
  paths,
}: {
  cwd: string;
  step?: StepState;
  task: WorkerTask;
  paths: WorkerArtifactPaths;
}): string {
  const lines: string[] = [];
  const promptProfile = loadManagerPromptProfile();

  lines.push(
    ...promptProfile.workerPrompt.opening,
    "",
    "## TASK",
    task.title,
    "",
    task.description.trim(),
  );

  if (step) {
    lines.push(
      "",
      "## STEP CONTEXT",
      `Step ${step.index}: ${step.title}`,
      `Goal: ${step.goal}`,
      `Status: ${step.status}`,
    );
  }

  if (step?.acceptanceCriteria?.length) {
    lines.push("", "## ACCEPTANCE", ...step.acceptanceCriteria.map((c) => `- ${c}`));
  }

  if (task.allowedPaths.length || task.forbiddenPaths.length || task.conflictsWith.length || task.canRunParallel) {
    lines.push("", "## BOUNDARIES");
    if (task.allowedPaths.length) {
      lines.push("Allowed paths:", ...task.allowedPaths.map((p) => `- ${p}`));
    }
    if (task.forbiddenPaths.length) {
      lines.push("Forbidden paths:", ...task.forbiddenPaths.map((p) => `- ${p}`));
    }
    if (task.canRunParallel) {
      lines.push("- This task may be running alongside other workers. Keep your edits inside the assigned scope.");
    }
    if (task.conflictsWith.length) {
      lines.push("Conflicts with:", ...task.conflictsWith.map((id) => `- ${id}`));
    }
  }

  if (task.expectedOutputs.length) {
    lines.push("", "## EXPECTED OUTPUTS", ...task.expectedOutputs.map((output) => `- ${output}`));
  }

  if (task.verificationCommands?.length) {
    lines.push(
      "",
      "## VERIFICATION",
      ...task.verificationCommands.map((c) => `- ${c}`),
      "",
      "## SELF-CHECK",
      "Before reporting `complete`, you MUST run each command listed under VERIFICATION in a fresh shell and capture its exit code + first 600 chars of stdout. Include the literal output as one `proof[]` entry per verification command, formatted as:",
      "  $ <command>",
      "  [exit=<code>]",
      "  <stdout truncated to 600 chars>",
      "A `complete` status with empty `proof[]` will be treated as `partial` by the manager review and forced to retry — do not skip this step.",
      "If any verificationCommand fails (non-zero exit, error in output), set status=\"partial\" or \"failed\" and include the failure mode in `risks[]`. Do NOT paper over a failing check by reporting `complete`.",
      "If your task description references atomic claims (sub-claims under acceptanceCriteria), enumerate them in `proof[]` — one entry per claim, citing the file:line or command output that demonstrates each one.",
    );
  }

  lines.push(
    "",
    "## WORKSPACE",
    `Workspace: ${cwd}`,
    "",
    "## FINAL REPORT",
    `When done, write valid JSON to ${paths.finalReportJson}.`,
    ...promptProfile.workerPrompt.finalReportIntro,
    "Use this shape:",
    JSON.stringify(
      {
        status: "complete | partial | blocked | failed",
        summary: "What changed and why.",
        files_changed: [{ path: "path/to/file", reason: "Why it changed." }],
        commands_run: [{ command: "npm run typecheck", exitCode: 0, summary: "What the command proved." }],
        tests: [{ command: "npm run typecheck", result: "passed | failed | not_run", details: "Optional detail." }],
        proof: ["Concrete evidence that the task is done."],
        risks: ["Known risk or empty array."],
        followups: ["Useful next task or empty array."],
      },
      null,
      2,
    ),
  );

  return lines.join("\n");
}

function renderVerifierWorkerPrompt({
  cwd,
  step,
  task,
  paths,
}: {
  cwd: string;
  step?: StepState;
  task: WorkerTask;
  paths: WorkerArtifactPaths;
}): string {
  const lines: string[] = [];
  const promptProfile = loadManagerPromptProfile();

  const verifierOpening =
    promptProfile.workerPrompt.verifierOpening?.length
      ? promptProfile.workerPrompt.verifierOpening
      : DEFAULT_MANAGER_PROMPT_PROFILE.workerPrompt.verifierOpening ?? [];
  const verifierFinalReportIntro =
    promptProfile.workerPrompt.verifierFinalReportIntro?.length
      ? promptProfile.workerPrompt.verifierFinalReportIntro
      : DEFAULT_MANAGER_PROMPT_PROFILE.workerPrompt.verifierFinalReportIntro ?? [];

  lines.push(
    ...verifierOpening,
    "",
    "## VERIFICATION TASK",
    task.title,
    "",
    task.description.trim(),
  );

  if (step) {
    lines.push(
      "",
      "## STEP CONTEXT (the implementation worker just finished this step)",
      `Step ${step.index}: ${step.title}`,
      `Goal: ${step.goal}`,
      `Status: ${step.status}`,
    );
  }

  if (step?.acceptanceCriteria?.length) {
    lines.push(
      "",
      "## ACCEPTANCE CRITERIA — your ground truth",
      "These are the claims you must independently prove or disprove. Decompose each into atomic sub-claims and verify each one.",
      ...step.acceptanceCriteria.map((c) => `- ${c}`),
    );
  }

  if (task.expectedOutputs.length) {
    lines.push(
      "",
      "## IMPLEMENTATION WORKER'S EXPECTED OUTPUTS — orientation only",
      "These are what the prior worker was supposed to produce. Use them to know WHERE to look — but do NOT trust them as evidence on their own.",
      ...task.expectedOutputs.map((output) => `- ${output}`),
    );
  }

  if (task.verificationCommands?.length) {
    lines.push(
      "",
      "## VERIFICATION COMMANDS — run each one yourself in a fresh shell",
      "Capture exit code + first 600 chars of stdout for each. These are the same commands the implementation worker was supposed to run; you re-run them with no caching, no shortcuts.",
      ...task.verificationCommands.map((c) => `- ${c}`),
    );
  }

  lines.push(
    "",
    "## WORKSPACE",
    `Workspace: ${cwd}`,
    "Read files directly from this path. Do NOT use the prior worker's narrative as your source of truth.",
    "",
    "## TOOL DISCIPLINE",
    "Read-only tools only. Do not Write, Edit, or run any command that mutates state (>, >>, tee, rm, mv, chmod, npm install, git commit, git push, destructive SQL).",
    "If you cannot verify a claim because the verification harness or fixture is missing, set verdict=unsure for that claim and explain WHAT is missing in `missing_oracle`. Do NOT create the fixture yourself.",
    "",
    "## FINAL REPORT",
    `When done, write valid JSON to ${paths.finalReportJson}.`,
    ...verifierFinalReportIntro,
    "Use this shape (note: this is the VERIFIER shape, NOT the implementation-worker shape):",
    JSON.stringify(
      {
        status: "complete",
        summary: "One-paragraph overview of what you verified and the headline verdict.",
        verifier: {
          status: "verified | failed | unsure",
          confidence: "PERFECT | VERIFIED | PARTIAL | FEEDBACK | FAILED",
          atomic_claims: [
            {
              claim: "function quoteForShell is exported from src/main/shell-utils.ts",
              verdict: "verified",
              evidence: "src/main/shell-utils.ts:14 — `export function quoteForShell(value: string)`",
            },
            {
              claim: "quoteForShell preserves spaces by quoting (input 'a b' → 'a b' wrapped)",
              verdict: "failed",
              evidence: "$ node --eval ... [exit=0] returned 'a b' (unquoted) — strips spaces",
            },
          ],
          corrective_prompt:
            "Full prompt the manager will use as the next implementation task description. Be specific: exact paths, exact failing assertions, suggested fix. 200-400 words. Set to null when status=verified.",
          missing_oracle: "Describe what fixture/harness/script we need but don't have, or null when not applicable.",
        },
        commands_run: [
          { command: "node --eval \"...\"", exitCode: 0, summary: "Probed quoteForShell with 'a b' input." },
        ],
        proof: ["Mirror the atomic_claims array's evidence here for cross-tool consumption."],
        risks: ["Known risk or empty array."],
        followups: ["Useful next task or empty array."],
      },
      null,
      2,
    ),
    "",
    "Confidence ladder (Spark uses this to decide what to do next):",
    "- PERFECT: every atomic claim verified with strong evidence; no missing oracle. Spark accepts the implementation.",
    "- VERIFIED: every atomic claim verified; minor gaps not load-bearing. Spark accepts.",
    "- PARTIAL: some atomic claims verified, some unverifiable, none failed. Spark may accept-with-risk or queue a follow-up.",
    "- FEEDBACK: at least one atomic claim FAILED with a fixable, specific corrective_prompt. Spark retries the implementation worker with your corrective_prompt.",
    "- FAILED: implementation is broken in ways no narrow corrective prompt fixes (architectural error, wrong file modified, wrong approach). Spark may escalate to the human.",
  );

  return lines.join("\n");
}


function runPath(runId: string): string {
  return join(runDir(runId), RUN_FILE);
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
