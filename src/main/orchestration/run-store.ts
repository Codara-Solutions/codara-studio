import { shell } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
  AddRunMessageInput,
  LaunchWorkerAttemptInput,
  PauseRunInput,
  ResumeRunInput,
  CreateStepInput,
  CreateRunInput,
  CreateWorkerTaskInput,
  PrepareWorkerTaskInput,
  RunArtifactPaths,
  RunState,
  SparkEvent,
  StartAutopilotInput,
  StepState,
  UpdateRunStatusInput,
  UpdateStepInput,
  UpdateWorkerTaskInput,
  WorkerTask,
  WorkerAttempt,
  WorkerArtifactPaths,
  WorkerTaskEnvelope,
} from "@shared/types";
import { appendEvent, eventsPath, listEvents, runDir, runsRoot } from "./event-log";

const RUN_FILE = "run.json";
const ESC_KEY = "\x1b";
const CONTINUE_INPUT = "continue\n";

interface ActiveWorkerProcess {
  runId: string;
  stepId?: string;
  workerTaskId: string;
  attemptId: string;
  pid?: number;
  command: string;
  child: ChildProcessWithoutNullStreams;
}

const activeWorkerProcesses = new Map<string, ActiveWorkerProcess>();

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

  if (run.steps.length === 0) {
    run = await createStep({
      runId: run.id,
      title: "Understand project plan",
      goal: input.planText?.trim() || "Read the project plan and decide the first concrete implementation task.",
      acceptanceCriteria: ["A worker task is prepared from the current project plan."],
      verificationCommands: ["npm run typecheck"],
    });
  }

  const activeStep = pickAutopilotStep(run);
  const existingTask = activeStep
    ? run.workerTasks.find((task) => task.stepId === activeStep.id)
    : run.workerTasks[0];

  if (!existingTask) {
    run = await createWorkerTask({
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

  run = await requireRun(run.id);
  const task = pickAutopilotTask(run);
  if (!task) {
    return askHumanQuestion(run.id, "I could not find a ready task to run. Please clarify the next goal.");
  }

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
  }

  run = await launchWorkerAttempt({
    runId: run.id,
    attemptId,
  });

  const latest = await requireRun(run.id);
  if (latest.status === "paused") return latest;

  return commitRunChange(latest, {
    type: "autopilot.cycle_completed",
    message: "Autopilot completed one execution cycle",
    payload: {
      workerTasks: latest.workerTasks.length,
      workerAttempts: latest.workerAttempts.length,
    },
    mutate: (draft, timestamp) => {
      draft.status = "reviewing";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
        status: "blocked",
        lastAction: "worker_cycle_completed_needs_review",
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
  });
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
  return commitRunChange(run, {
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

  const command = "node -e <spark-manual-worker-runner>";
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

  const result = await runManualWorkerProcess({
    run,
    task,
    attemptId: attempt.id,
    paths,
    cwd: attempt.cwd,
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

  return run;
}

export async function deleteRun(runId: string): Promise<void> {
  const run = await requireRun(runId);
  const timestamp = new Date().toISOString();
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

async function saveRun(run: RunState): Promise<void> {
  await fs.mkdir(runDir(run.id), { recursive: true });
  const path = runPath(run.id);
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(run, null, 2), "utf8");
  await fs.rename(tmp, path);
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

function pickAutopilotTask(run: RunState): WorkerTask | undefined {
  return (
    run.workerTasks.find((task) => ["created", "queued", "failed", "retry_queued"].includes(task.status)) ??
    run.workerTasks[0]
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
    reason: "Spark needs human input before continuing.",
  });
}

function activeWorkersForRun(runId: string): ActiveWorkerProcess[] {
  return Array.from(activeWorkerProcesses.values()).filter((worker) => worker.runId === runId);
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
  if (worker.child.stdin.destroyed || !worker.child.stdin.writable) return;
  worker.child.stdin.write(input);
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
    ].join("\n"),
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

async function runManualWorkerProcess({
  run,
  task,
  attemptId,
  paths,
  cwd,
  command,
}: {
  run: RunState;
  task: WorkerTask;
  attemptId: string;
  paths: WorkerArtifactPaths;
  cwd: string;
  command: string;
}): Promise<{ exitCode: number; error?: string }> {
  const child = spawn("node", ["-e", manualWorkerRunnerScript()], {
    cwd,
    windowsHide: true,
    env: {
      ...process.env,
      SPARK_RUN_ID: run.id,
      SPARK_WORKER_TASK_ID: task.id,
      SPARK_ATTEMPT_ID: attemptId,
      SPARK_TASK_TITLE: task.title,
      SPARK_PROMPT_PATH: paths.promptMd,
      SPARK_WORKPAD_PATH: paths.workpadMd,
      SPARK_FINAL_REPORT_PATH: paths.finalReportJson,
    },
  });

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
      pid: child.pid,
      command,
    },
  });

  activeWorkerProcesses.set(attemptId, {
    runId: run.id,
    stepId: task.stepId,
    workerTaskId: task.id,
    attemptId,
    pid: child.pid,
    command,
    child,
  });

  return new Promise((resolve) => {
    const writes: Promise<void>[] = [];
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      writes.push(recordWorkerOutput(run, task, attemptId, paths, "stdout", chunk.toString("utf8")));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      writes.push(recordWorkerOutput(run, task, attemptId, paths, "stderr", chunk.toString("utf8")));
    });
    child.on("error", (err) => {
      settled = true;
      activeWorkerProcesses.delete(attemptId);
      resolve({ exitCode: 1, error: err.message });
    });
    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      activeWorkerProcesses.delete(attemptId);
      await Promise.allSettled(writes);
      resolve({ exitCode: code ?? 1 });
    });
  });
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
  await appendEvent({
    timestamp,
    workspaceId: run.workspaceId,
    runId: run.id,
    stepId: task.stepId,
    workerTaskId: task.id,
    attemptId,
    type: `worker_attempt.${stream}`,
    message: text.trim().slice(0, 240) || `${stream} output`,
    payload: {
      stream,
      bytes: Buffer.byteLength(text),
      text: text.slice(0, 4000),
    },
  });
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
