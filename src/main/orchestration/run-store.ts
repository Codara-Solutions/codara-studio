import { shell } from "electron";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AddRunMessageInput,
  LaunchWorkerAttemptInput,
  PauseRunInput,
  ResumeRunInput,
  CreateStepInput,
  CreateRunInput,
  CreateWorkerTaskInput,
  PrepareWorkerTaskInput,
  ReviewDecision,
  RunArtifactPaths,
  RunState,
  SparkCall,
  SparkEvent,
  StartAutopilotInput,
  StepState,
  UpdateRunStatusInput,
  UpdateStepInput,
  UpdateWorkerTaskInput,
  WorkerTask,
  WorkerAttempt,
  WorkerArtifactPaths,
  WorkerReport,
  WorkerTaskEnvelope,
} from "@shared/types";
import { appendEvent, eventsPath, listEvents, runDir, runsRoot } from "./event-log";
import { loadSettings } from "../storage";
import {
  buildOpenRouterManagerRequest,
  readOpenRouterConfig,
  requestOpenRouterManagerDecision,
  type SparkManagerDecision,
  type SparkManagerWorkerReportContext,
} from "./openrouter-manager";
import {
  finishLangSmithManagerTrace,
  readLangSmithConfig,
  startLangSmithManagerTrace,
  type LangSmithTrace,
} from "./langsmith-tracer";
import { disposeWorkerSession, startWorkerSession, type WorkerCommand, type WorkerSession } from "./worker-session";

const RUN_FILE = "run.json";
const ESC_KEY = "\x1b";
const CONTINUE_INPUT = "continue\r";

interface ActiveWorkerProcess {
  runId: string;
  stepId?: string;
  workerTaskId: string;
  attemptId: string;
  pid?: number;
  command: string;
  session: WorkerSession;
}

const activeWorkerProcesses = new Map<string, ActiveWorkerProcess>();
const activeAutopilotCycles = new Map<string, Promise<void>>();
const activeAutopilotPlans = new Map<string, Promise<void>>();
const activeAutopilotReviews = new Map<string, Promise<void>>();
const runWriteQueues = new Map<string, Promise<void>>();

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

  if (run.steps.length === 0 && run.workerTasks.length === 0) {
    scheduleInitialAutopilotPlanning(run.id, input);
    return run;
  }

  run = await requireRun(run.id);
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

function scheduleInitialAutopilotPlanning(runId: string, input: StartAutopilotInput): void {
  if (activeAutopilotPlans.has(runId)) return;
  const cycle = runInitialAutopilotPlanning(runId, input)
    .catch(async (err) => {
      await markInitialAutopilotPlanningFailed(runId, err);
    })
    .finally(() => {
      activeAutopilotPlans.delete(runId);
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
    managerPlannedRun.steps.length > 0 &&
    managerPlannedRun.workerTasks.length === 0
  ) {
    managerPlannedRun = await askOpenRouterManager(managerPlannedRun, input.cwd, "step_planning");
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

  run = await askOpenRouterManager(run, cwd, "worker_result_review") ?? run;
  if (run.status === "paused" || run.status === "cancelled" || run.status === "complete") return;
  const tasks = pickAutopilotTasks(run);
  if (tasks.length === 0) return;

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
  const requestBody = buildOpenRouterManagerRequest({
    run,
    cwd,
    model: config.model,
    mode: managerMode,
    workerReports,
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
    const result = await requestOpenRouterManagerDecision(config, requestBody, managerMode);
    await safeFinishLangSmithManagerTrace({
      config: langSmithConfig,
      trace: langSmithTrace,
      output: {
        decision: result.decision,
        rawResponse: result.rawResponse,
        durationMs: result.durationMs,
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
      targetCall.durationMs = result.durationMs;
      targetCall.promptTokens = result.promptTokens;
      targetCall.completionTokens = result.completionTokens;
      targetCall.completedAt = completedAt;
    }
    latest.updatedAt = completedAt;
    await saveRun(latest);
    await appendEvent({
      timestamp: completedAt,
      workspaceId: latest.workspaceId,
      runId: latest.id,
      sparkCallId: callId,
      type: "spark_call.completed",
      message: `Spark manager call completed: ${result.decision.status}`,
      payload: {
        mode,
        model: config.model,
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

function isStructuredOutputUnsupportedError(error: string): boolean {
  const normalized = error.toLowerCase();
  return (
    normalized.includes("no endpoints found") && normalized.includes("requested parameters")
  ) || (
    normalized.includes("response_format") && normalized.includes("not support")
  ) || (
    normalized.includes("json_schema") && normalized.includes("not support")
  );
}

async function applySparkManagerDecision(
  run: RunState,
  decision: SparkManagerDecision,
  mode: SparkCall["mode"],
): Promise<RunState> {
  if (decision.status === "ask_user") {
    return askHumanQuestion(run.id, decision.question || "Please clarify what Spark should do next.");
  }

  if (decision.status === "complete") {
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

  let latest = run;
  const stepIds: string[] = [];
  const steps =
    mode === "plan_analysis" && decision.steps.length > 0
      ? decision.steps
      : run.steps.length > 0
        ? []
        : [
          {
            title: "Spark planned work",
            goal: decision.summary,
            acceptanceCriteria: ["The selected worker tasks complete and report final evidence."],
            verificationCommands: ["npm run typecheck"],
          },
        ];

  for (const step of steps) {
    latest = await createStep({
      runId: latest.id,
      title: step.title,
      goal: step.goal,
      riskLevel: step.riskLevel,
      acceptanceCriteria: step.acceptanceCriteria,
      verificationCommands: step.verificationCommands,
    });
    stepIds.push(latest.steps.at(-1)?.id ?? "");
  }

  for (const task of decision.tasks) {
    const availableStepIds = stepIds.length > 0 ? stepIds : latest.steps.map((step) => step.id);
    const stepId =
      availableStepIds[Math.max(0, Math.min(task.stepIndex ?? 0, availableStepIds.length - 1))] ||
      availableStepIds[0];
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
      createdBy: "spark",
    });
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
      tasksCreated: decision.tasks.length,
      runtimes: decision.tasks.map((task) => task.runtimePreference),
    },
  });
  return latest;
}

export async function pauseRun(input: PauseRunInput): Promise<RunState> {
  const run = await requireRun(input.runId);
  const reason = input.reason?.trim() || "Paused by user";
  await sendPauseSignals(run, reason);
  return commitRunChange(run, {
    type: "run.paused",
    message: reason,
    payload: {
      reason,
      activeWorkerAttempts: activeWorkersForRun(run.id).map((worker) => worker.attemptId),
      controlSignal: "escape",
      messageRecorded: reason !== "Paused by user",
    },
    mutate: (draft, timestamp) => {
      if (reason !== "Paused by user") {
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
      scheduleInitialAutopilotPlanning(resumed.id, resumeInput);
    }
  }
  return resumed;
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

  return commitRunChange(run, {
    type: `human.${input.kind}`,
    message: `${input.author}: ${message.slice(0, 160)}`,
    payload: { message: humanMessage },
    mutate: (draft, timestamp) => {
      draft.humanMessages.push({ ...humanMessage, createdAt: timestamp });
      draft.updatedAt = timestamp;
    },
  });
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
  const step: StepState = {
    id: makeId("step"),
    runId: run.id,
    index: run.steps.length + 1,
    title,
    goal: input.goal?.trim() || title,
    status: "queued",
    riskLevel: input.riskLevel,
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
  const workpad = renderInitialWorkpad({ run, step, task });

  await fs.mkdir(paths.attemptDir, { recursive: true });
  await fs.writeFile(paths.taskJson, JSON.stringify(envelope, null, 2), "utf8");
  await fs.writeFile(paths.promptMd, prompt, "utf8");
  await fs.writeFile(paths.workpadMd, workpad, "utf8");

  attempt.promptPath = paths.promptMd;
  attempt.workpadPath = paths.workpadMd;
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

  return envelope;
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
  const workerCommand = buildWorkerCommand(task, paths, promptText);
  const command = workerCommand.display;
  const launchTimestamp = new Date().toISOString();
  attempt.status = "launching";
  attempt.startedAt = launchTimestamp;
  attempt.finishedAt = undefined;
  attempt.exitCode = undefined;
  attempt.error = undefined;
  attempt.command = command;
  attempt.promptPath = paths.promptMd;
  attempt.workpadPath = paths.workpadMd;
  attempt.stdoutLogPath = paths.stdoutLog;
  attempt.stderrLogPath = paths.stderrLog;
  attempt.rawLogPath = paths.rawLog;
  attempt.finalReportPath = paths.finalReportJson;
  task.status = "claimed";
  task.updatedAt = launchTimestamp;
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
    workerCommand,
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
    disposeWorkerSession(worker.attemptId);
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
    if (reviewedStep) reviewedStep.status = "reviewing";
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
  run.autopilot ??= {
    status: run.status === "running" ? "running" : "idle",
    updatedAt: run.updatedAt,
  };
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

function pickAutopilotTasks(run: RunState): WorkerTask[] {
  const candidates = run.workerTasks.filter((task) =>
    ["created", "queued", "failed", "retry_queued"].includes(task.status),
  );
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
    if (selected.length >= 2) break;
  }
  return selected.length > 0 ? selected : [first];
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
    reason: "Spark needs human input before continuing.",
  });
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
  worker.session.write(input);
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

async function readWorkerReport(path: string): Promise<WorkerReport | null> {
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
  if (report.status === "complete" && report.risks.length === 0 && report.followups.length === 0) {
    return {
      decision: "accept",
      confidence: 0.7,
      reason: report.summary || "Worker reported completion with no risks or followups.",
      issues: [],
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

async function runWorkerSession({
  run,
  task,
  attemptId,
  paths,
  cwd,
  workerCommand,
}: {
  run: RunState;
  task: WorkerTask;
  attemptId: string;
  paths: WorkerArtifactPaths;
  cwd: string;
  workerCommand: WorkerCommand;
}): Promise<{ exitCode: number; error?: string }> {
  const writes: Promise<void>[] = [];
  let session: WorkerSession;
  try {
    session = startWorkerSession({
      id: attemptId,
      command: workerCommand,
      cwd,
      env: {
        SPARK_RUN_ID: run.id,
        SPARK_WORKER_TASK_ID: task.id,
        SPARK_ATTEMPT_ID: attemptId,
        SPARK_TASK_TITLE: task.title,
        SPARK_PROMPT_PATH: paths.promptMd,
        SPARK_WORKPAD_PATH: paths.workpadMd,
        SPARK_FINAL_REPORT_PATH: paths.finalReportJson,
      },
      onOutput: (text) => {
        writes.push(recordWorkerOutput(run, task, attemptId, paths, "stdout", text));
      },
    });
  } catch (err) {
    return { exitCode: 1, error: err instanceof Error ? err.message : String(err) };
  }

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
      pid: session.pid,
      command: session.command,
      runtime: task.runtimePreference,
      session: "pty",
    },
  });

  activeWorkerProcesses.set(attemptId, {
    runId: run.id,
    stepId: task.stepId,
    workerTaskId: task.id,
    attemptId,
    pid: session.pid,
    command: session.command,
    session,
  });

  const result = await session.done;
  activeWorkerProcesses.delete(attemptId);
  await Promise.allSettled(writes);
  return {
    exitCode: result.exitCode ?? 1,
    error: result.signal ? `Worker session exited from signal ${result.signal}` : undefined,
  };
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
  attempt.status = "running";
  task.status = "running";
  attempt.startedAt = attempt.startedAt ?? timestamp;
  task.updatedAt = timestamp;
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

async function readWorkerPromptForLaunch(paths: WorkerArtifactPaths): Promise<string> {
  try {
    return await fs.readFile(paths.promptMd, "utf8");
  } catch {
    return renderInteractiveWorkerLaunchFallback(paths);
  }
}

function buildWorkerCommand(task: WorkerTask, paths: WorkerArtifactPaths, promptText: string): WorkerCommand {
  if (task.runtimePreference === "manual") {
    return {
      exe: process.execPath,
      args: ["-e", manualWorkerRunnerScript()],
      display: `${process.execPath} -e <spark-manual-worker-runner>`,
      env: {
        ELECTRON_RUN_AS_NODE: "1",
      },
    };
  }

  if (task.runtimePreference === "claude") {
    const command = configuredWorkerCommand(
      "SPARK_CLAUDE_WORKER_COMMAND",
      "SPARK_CLAUDE_WORKER_ARGS",
      process.platform === "win32" ? "claude.exe" : "claude",
    );
    return {
      ...command,
      display: command.display || "claude",
      initialInput: renderInteractiveWorkerLaunchInput(paths, promptText),
      initialInputDelayMs: 1800,
      initialInputMaxDelayMs: 6500,
      initialInputWaitForOutput: true,
      initialInputChunkSize: 1000,
      initialInputChunkDelayMs: 20,
      initialSubmitInput: "\r",
      initialSubmitDelayMs: 1200,
    };
  }

  if (task.runtimePreference === "codex") {
    const command = configuredWorkerCommand(
      "SPARK_CODEX_WORKER_COMMAND",
      "SPARK_CODEX_WORKER_ARGS",
      process.platform === "win32" ? "codex.cmd" : "codex",
    );
    return {
      ...command,
      display: command.display || "codex",
      initialInput: renderInteractiveWorkerLaunchInput(paths, promptText),
      initialInputDelayMs: 2200,
      initialInputMaxDelayMs: 7000,
      initialInputWaitForOutput: true,
      initialInputChunkSize: 1000,
      initialInputChunkDelayMs: 20,
      initialSubmitInput: "\r",
      initialSubmitDelayMs: 1200,
    };
  }

  const shellExe = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "sh";
  const shellArgs = process.platform === "win32" ? ["/d", "/s"] : [];
  return {
    exe: shellExe,
    args: shellArgs,
    display: `${shellExe} ${shellArgs.join(" ")}`.trim(),
    initialInput: renderInteractiveWorkerLaunchInput(paths, promptText),
    initialInputChunkSize: 1000,
    initialInputChunkDelayMs: 20,
    initialSubmitInput: "\r",
    initialSubmitDelayMs: 300,
  };
}

function configuredWorkerCommand(commandEnv: string, argsEnv: string, fallbackExe: string): WorkerCommand {
  const exe = process.env[commandEnv]?.trim() || fallbackExe;
  const args = parseWorkerArgs(process.env[argsEnv]);
  return {
    exe,
    args,
    display: `${exe} ${args.join(" ")}`.trim(),
  };
}

function parseWorkerArgs(raw: string | undefined): string[] {
  const text = raw?.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    /* fall back to a simple command-line split */
  }
  return text.match(/"([^"]*)"|'([^']*)'|\S+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) ?? [];
}

function renderInteractiveWorkerLaunchInput(paths: WorkerArtifactPaths, promptText: string): string {
  return [
    promptText.trim(),
    "",
    "SPARK ARTIFACT PATHS",
    `Prompt artifact: ${paths.promptMd}`,
    `Workpad: ${paths.workpadMd}`,
    `Final report JSON: ${paths.finalReportJson}`,
  ].join("\n");
}

function renderInteractiveWorkerLaunchFallback(paths: WorkerArtifactPaths): string {
  return [
    "You are a Spark worker agent running inside the user's project.",
    "",
    "The prepared prompt artifact could not be read before launch, so use these artifacts directly.",
    `Prompt artifact: ${paths.promptMd}`,
    `Workpad: ${paths.workpadMd}`,
    `Final report JSON: ${paths.finalReportJson}`,
    "",
    "Read the prompt artifact, complete the task, and write the final JSON report to the final report path.",
  ].join("\n");
}

function manualWorkerRunnerScript(): string {
  return `
const fs = require("node:fs");
const reportPath = process.env.SPARK_FINAL_REPORT_PATH;
const promptPath = process.env.SPARK_PROMPT_PATH;
const workpadPath = process.env.SPARK_WORKPAD_PATH;
const title = process.env.SPARK_TASK_TITLE || "Manual worker task";
const finishDelayMs = Math.max(0, Number(process.env.SPARK_MANUAL_WORKER_DELAY_MS || 0));
let paused = false;
let finished = false;
let finishTimer = null;
console.log("Spark manual worker runner started.");
console.log("Prompt:", promptPath);
console.log("Workpad:", workpadPath);
if (!reportPath) {
  console.error("SPARK_FINAL_REPORT_PATH is missing.");
  process.exit(1);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  if (data.includes(String.fromCharCode(27))) {
    paused = true;
    if (finishTimer) clearTimeout(finishTimer);
    console.log("Spark worker pause signal received.");
    return;
  }
  const text = String(data).trim();
  if (!text) return;
  paused = false;
  console.log("Spark worker resume input received.");
  if (text.toLowerCase() !== "continue") {
    console.log(text);
  }
  scheduleFinish();
});
process.stdin.resume();
scheduleFinish();

function scheduleFinish() {
  if (paused || finished) return;
  if (finishTimer) clearTimeout(finishTimer);
  finishTimer = setTimeout(finish, finishDelayMs);
}

function finish() {
  if (paused || finished) return;
  finished = true;
  const report = {
    status: "partial",
    summary: "Manual worker launch path verified. No project edits were performed by this runner.",
    files_changed: [],
    commands_run: [
      {
        command: "spark-manual-worker-runner",
        exit_code: 0,
        summary: "Captured stdout/stderr and wrote final-report.json for " + title
      }
    ],
    tests: [],
    proof: ["Worker process launched and completed.", "Final report artifact was written."],
    risks: ["This is a controlled runner, not a real Claude/Codex worker yet."],
    followups: ["Replace manual runner with configured worker runtime once execution controls are stable."]
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Final report:", reportPath);
  process.exit(0);
}
`;
}

function renderWorkerPrompt({
  cwd,
  run,
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
  return [
    "You are a worker agent running inside the user's project.",
    "",
    "WORKSPACE",
    `Project directory: ${cwd}`,
    "",
    "RUN",
    `${run.title} (${run.id})`,
    "",
    "PROJECT PLAN SNAPSHOT",
    formatPlanSnapshot(run),
    "",
    "STEP-BY-STEP DIVISION",
    formatRunStepDivision(run),
    "",
    "CURRENT STEP",
    step ? `${step.title}\n${step.goal}` : "No step is assigned to this task.",
    "",
    "YOUR TASK",
    task.title,
    task.description,
    "",
    "ALLOWED FILES / FOLDERS",
    formatList(task.allowedPaths, "No explicit allowed paths. Keep changes tightly scoped to the task."),
    "",
    "FORBIDDEN FILES / FOLDERS",
    formatList(task.forbiddenPaths, "No explicit forbidden paths."),
    "",
    "WORKPAD",
    `Before editing, create or update: ${paths.workpadMd}`,
    "",
    "Your workpad must include:",
    "- goal",
    "- plan",
    "- acceptance criteria",
    "- progress",
    "- validation",
    "- blockers",
    "- final evidence",
    "",
    "CONSTRAINTS",
    "- Keep the change focused.",
    "- Do not redesign unrelated parts of the app.",
    "- Do not delete existing user work.",
    "- Do not install new dependencies unless explicitly allowed.",
    "- Prefer small, understandable changes.",
    "- If blocked, report the blocker clearly instead of guessing.",
    "",
    "VERIFICATION",
    formatList(task.verificationCommands, "No verification commands were specified."),
    "",
    "FINAL REPORT",
    `Write final JSON to: ${paths.finalReportJson}`,
    "The JSON must match this schema:",
    "```json",
    JSON.stringify(
      {
        status: "complete | partial | blocked | failed",
        summary: "...",
        files_changed: [{ path: "...", reason: "..." }],
        commands_run: [{ command: "...", exit_code: 0, summary: "..." }],
        tests: [{ command: "...", result: "passed | failed | not_run", details: "..." }],
        proof: ["..."],
        risks: ["..."],
        followups: ["..."],
      },
      null,
      2,
    ),
    "```",
    "",
  ].join("\n");
}

function formatPlanSnapshot(run: RunState): string {
  const plan = run.planId
    ? run.plans.find((item) => item.id === run.planId)
    : run.plans.at(-1);
  const content = plan?.rawContent?.trim() || plan?.summary?.trim();
  if (!content) return "No selected project plan content was captured for this run.";
  const source = plan?.sourceFile ? `Source: ${plan.sourceFile}\n\n` : "";
  return source + truncateText(content, 12000);
}

function formatRunStepDivision(run: RunState): string {
  if (run.steps.length === 0) return "No manager step division was captured for this run.";
  return run.steps
    .map((step) =>
      [
        `${step.index}. ${step.title}`,
        `Goal: ${step.goal}`,
        `Status: ${step.status}`,
        `Acceptance: ${step.acceptanceCriteria.length ? step.acceptanceCriteria.join("; ") : "not specified"}`,
        `Verification: ${step.verificationCommands.length ? step.verificationCommands.join("; ") : "not specified"}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n\n[truncated ${value.length - maxLength} characters]`;
}

function renderInitialWorkpad({
  run,
  step,
  task,
}: {
  run: RunState;
  step?: StepState;
  task: WorkerTask;
}): string {
  return [
    `# Workpad - ${task.title}`,
    "",
    "## Goal",
    task.description,
    "",
    "## Run",
    `- ${run.title}`,
    `- ${run.id}`,
    "",
    "## Step",
    step ? `- ${step.title}\n- ${step.goal}` : "- No step assigned",
    "",
    "## Plan",
    "- Pending worker execution.",
    "",
    "## Acceptance Criteria",
    formatList(task.expectedOutputs, "- Pending definition."),
    "",
    "## Progress",
    "- Envelope prepared. Execution has not started.",
    "",
    "## Validation",
    formatList(task.verificationCommands, "- No verification commands specified."),
    "",
    "## Blockers",
    "- None recorded.",
    "",
    "## Final Evidence",
    "- Pending worker execution.",
    "",
  ].join("\n");
}

function formatList(values: string[], emptyText: string): string {
  if (values.length === 0) return emptyText;
  return values.map((value) => `- ${value}`).join("\n");
}

function runPath(runId: string): string {
  return join(runDir(runId), RUN_FILE);
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
