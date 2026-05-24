import { promises as fs, createWriteStream } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import type {
  AddRunMessageInput,
  AgentRuntimeDiagnostic,
  AgentRuntimeModel,
  AppSettings,
  InterruptRunWithMessageInput,
  LaunchWorkerAttemptInput,
  MarkRunSeenInput,
  PauseRunInput,
  CancelRunInput,
  ContextPacket,
  ResumeRunInput,
  ReviewDecision,
  CreateStepInput,
  CreateRunInput,
  CreateWorkerTaskInput,
  PlannedStepAgent,
  PrepareWorkerTaskInput,
  RunArtifactPaths,
  RunMessageAttachment,
  RunState,
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
import { makeId } from "@shared/ids";
import {
  contextWindowForModel,
  estimateImageTokens,
  estimateTokensFromText,
} from "@shared/context-window";
import { appendEvent, eventsPath, listEvents, runDir, runsRoot } from "./event-log";
import { writeFileAtomic } from "../fs-atomic";
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
  type SparkManagerQuestionOption,
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
import { applyAgentRuntimeSettings, detectAgentRuntimes } from "../agent-runtimes";
import { renderAgentSyncManagerContext, renderAgentSyncPromptLines } from "../agent-sync";
import { getProvider } from "../providers";
import type { SpawnOpts } from "../providers/types";

const RUN_FILE = "run.json";
const ESC_KEY = "\x1b";
const CONTINUE_INPUT = "continue\r";
const HUMAN_INPUT_PAUSE_REASON = "Spark needs human input before continuing.";
// How many run directories under ~/.SparkAgent/runs/ we keep on disk. Older
// runs are swept lazily on the first listRuns() call per process. Bumped from
// "unbounded" because users reported the runs/ tree growing into GB of pty
// raw.log + worker artifacts after a few weeks of heavy use.
const RUN_RETENTION_KEEP = 50;

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
const runMutationQueues = new Map<string, Promise<void>>();
const runWriteQueues = new Map<string, Promise<void>>();
const MAX_ATTACHMENTS_PER_MESSAGE = 8;
const MAX_IMAGE_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const DIRECT_FILE_MENTION_SCAN_DEPTH = 6;
const DIRECT_FILE_MENTION_SCAN_RESULTS = 700;
const SKIPPED_DIRECT_FILE_MENTION_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

// In-memory authoritative cache of run state, keyed by run id. This module is
// the SOLE writer of run.json (the orchestration loop lives in the single
// main process), so once a run is loaded — or written — the in-memory copy is
// canonical and we never need to touch the disk again to read it.
//
// Before this cache, the renderer's listRuns (which fans out to getRun per
// run file) fired on every orchestration event, re-reading + JSON.parsing
// every run.json from disk each time and stalling the main thread. getRun now
// returns the cached RunState directly on a hit.
//
// The store's own mutating functions follow a `requireRun -> mutate the
// returned object in place -> saveRun` pattern; because the cache holds that
// same object identity, in-place mutation + re-save keeps the cache current
// with no copy-on-read needed. External consumers (ipc.ts, headless-runner)
// only read snapshots and the IPC bridge structured-clones results across to
// the renderer, so no caller relies on getRun handing back a fresh deep copy.
const runCache = new Map<string, RunState>();

// One-shot per process: fired lazily from listRuns(). Keeps the runs/ dir
// from growing unbounded (see RUN_RETENTION_KEEP).
let didRetentionSweep = false;

interface RuntimeReroute {
  [key: string]: unknown;
  from: WorkerTask["runtimePreference"];
  to: WorkerTask["runtimePreference"];
  modelHint?: string;
  effortHint?: WorkerTask["effortHint"];
  reason: string;
}

async function detectConfiguredAgentRuntimes(
  settings?: AppSettings,
): Promise<AgentRuntimeDiagnostic[]> {
  const liveSettings = settings ?? await loadSettings();
  const runtimes = await detectAgentRuntimes().catch(() => []);
  return applyAgentRuntimeSettings(runtimes, liveSettings);
}

export async function createRun(input: CreateRunInput): Promise<RunState> {
  const now = new Date().toISOString();
  const run: RunState = {
    id: makeId("run"),
    workspaceId: input.workspaceId,
    title: input.title?.trim() || `Run - ${input.workspaceName}`,
    status: "idle",
    settingsSnapshot: {
      workspaceCwd: input.cwd,
    },
    artifactDir: "",
    createdAt: now,
    updatedAt: now,
    // Fresh run hasn't been "seen done" yet; flips when the user focuses
    // a `status === "complete"` chat (see `markRunSeen`).
    seen: false,
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
  // Cache HIT: the in-memory copy is authoritative (this module is the sole
  // writer of run.json), so skip the disk read + JSON.parse entirely. The
  // cached object is already normalized and stays normalized across saveRun.
  const cached = runCache.get(runId);
  if (cached) return normalizeRun(cached);

  // Cache MISS: read + parse + normalize from disk, then populate the cache.
  try {
    const raw = await fs.readFile(runPath(runId), "utf8");
    const run = normalizeRun(JSON.parse(raw) as RunState);
    runCache.set(run.id, run);
    return run;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// Recursively delete any runs beyond RUN_RETENTION_KEEP, oldest-first. Reads
// each run.json for its createdAt; falls back to the directory mtime if the
// JSON is unreadable so a corrupt run still has a stable position in the
// ordering. Reuses deleteRun() so the in-memory runCache is evicted in lockstep
// with the on-disk removal. Best-effort: every failure is swallowed so a
// permission / EBUSY hiccup never bubbles up into the IPC reply for listRuns.
async function runRetentionSweep(): Promise<void> {
  try {
    const root = runsRoot();
    let names: string[];
    try {
      names = await fs.readdir(root);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (names.length <= RUN_RETENTION_KEEP) return;

    const entries = await Promise.all(
      names.map(async (name) => {
        let createdAt: string | null = null;
        try {
          const raw = await fs.readFile(runPath(name), "utf8");
          const parsed = JSON.parse(raw) as { createdAt?: unknown };
          if (typeof parsed.createdAt === "string") createdAt = parsed.createdAt;
        } catch {
          /* fall through to mtime */
        }
        if (!createdAt) {
          try {
            const stat = await fs.stat(join(root, name));
            createdAt = new Date(stat.mtimeMs).toISOString();
          } catch {
            createdAt = "1970-01-01T00:00:00.000Z";
          }
        }
        return { name, createdAt };
      }),
    );

    // Newest first, then drop the head we want to keep.
    entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const toPurge = entries.slice(RUN_RETENTION_KEEP);
    for (const entry of toPurge) {
      try {
        await deleteRun(entry.name);
      } catch {
        // deleteRun requires an in-memory run; for purely on-disk leftovers
        // that aren't cached, fall back to rmRunDirHard + cache eviction.
        try { await rmRunDirHard(join(root, entry.name)); } catch { /* best-effort */ }
        runCache.delete(entry.name);
      }
    }
  } catch (err) {
    console.error("[run-store] runRetentionSweep failed", err);
  }
}

export async function listRuns(workspaceId?: string): Promise<RunState[]> {
  // Lazy, one-shot retention sweep. Fire-and-forget so the user's first
  // listRuns() doesn't pay the cost of N stats + rms; the next refresh will
  // already see the pruned tree.
  if (!didRetentionSweep) {
    didRetentionSweep = true;
    void runRetentionSweep();
  }

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

// A run is a chat in the panel, so it needs a title the user can tell apart
// from its siblings. A plan run is named after the plan; a conversational
// chat (no plan, just an opening message) is named after that message, the
// way a chat app titles a thread by its first line. "Autopilot - <workspace>"
// is the last resort — without this, every chat in one workspace collided on
// that single name and the switcher / tabs looked duplicated.
function chatTitleFromInput(input: StartAutopilotInput): string {
  const planTitle = input.planTitle?.trim();
  if (planTitle) return `Autopilot - ${planTitle}`;
  const note = input.initialUserNote?.trim().replace(/\s+/g, " ");
  if (note) {
    if (note.length <= 52) return note;
    const cut = note.slice(0, 49);
    const lastSpace = cut.lastIndexOf(" ");
    return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
  }
  return `Autopilot - ${input.workspaceName}`;
}

export async function startAutopilot(input: StartAutopilotInput): Promise<RunState> {
  let run = input.runId ? await requireRun(input.runId) : null;
  if (!run) {
    run = await createRun({
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName,
      cwd: input.cwd,
      title: chatTitleFromInput(input),
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
      clientMessageId: input.initialUserNoteClientMessageId,
      author: "user",
      kind: "note",
      message: initialNote,
      attachments: input.initialAttachments,
    });
    if (!planText) {
      scheduleInitialChatDecision(run.id, input);
      return run;
    }
  }

  if (run.steps.length === 0 && run.workerTasks.length === 0) {
    scheduleInitialAutopilotPlanning(run.id, input);
    return run;
  }

  run = await requireRun(run.id);
  let tasks = pickAutopilotTasks(run);
  // When a follow-up message causes the manager to append a new step (e.g. user
  // says "make it scientific calculator instead"), the new step lands with
  // plannedAgents but no materialized worker tasks. Mirror runAutopilotManagerReview's
  // line ~595 fallback: run step_planning to turn plannedAgents into worker tasks
  // before deciding there's nothing to do. Without this, startAutopilot falsely
  // concludes "no ready task" and asks the user a clarifying question Spark
  // already has the answer to.
  if (tasks.length === 0 && needsStepPlanning(run)) {
    const fastPathPlan = await tryTrivialFastPathStepPlanning(run);
    run = fastPathPlan ?? ((await askOpenRouterManager(run, input.cwd, "step_planning")) ?? run);
    if (run.status === "paused" || run.status === "cancelled" || run.status === "complete") return run;
    tasks = pickAutopilotTasks(run);
  }
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
  const parallelGroupId = launchQueue.length > 1 ? makeId("pgrp") : undefined;
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
        parallelGroupId,
        parallelGroupSize: launchQueue.length,
        canRunParallel: latestTask.canRunParallel,
        allowedPaths: latestTask.allowedPaths,
        conflictsWith: latestTask.conflictsWith,
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
  scheduleInitialManagerDecision(runId, input, "plan_analysis", opts);
}

function scheduleInitialChatDecision(
  runId: string,
  input: StartAutopilotInput,
  opts?: { afterCurrent?: boolean },
): void {
  scheduleInitialManagerDecision(runId, input, "chat", opts);
}

function scheduleInitialManagerDecision(
  runId: string,
  input: StartAutopilotInput,
  mode: "plan_analysis" | "chat",
  opts?: { afterCurrent?: boolean },
): void {
  const existing = activeAutopilotPlans.get(runId);
  if (existing && !opts?.afterCurrent) return;

  const start = existing && opts?.afterCurrent ? existing.catch(() => undefined) : Promise.resolve();
  const cycle = start
    .then(async () => {
      const latest = await getRun(runId);
      if (!latest || latest.status === "paused" || latest.status === "cancelled") return;
      await runInitialAutopilotPlanning(runId, input, mode);
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

async function runInitialAutopilotPlanning(
  runId: string,
  input: StartAutopilotInput,
  mode: "plan_analysis" | "chat" = "plan_analysis",
): Promise<void> {
  let run = await requireRun(runId);
  if (run.status === "paused" || run.status === "cancelled") return;

  let managerPlannedRun = mode === "chat"
    ? await askOpenRouterManagerForChat(run, input.cwd)
    : await askOpenRouterManagerForInitialTasks(run, input.cwd);
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

  if (!managerPlannedRun && (mode === "chat" || !manualFallbackEnabled())) {
    await askHumanQuestion(
      run.id,
      mode === "chat"
        ? "OpenRouter is not configured, so Spark cannot think through this chat turn yet. Add the API key in Settings, then send the message again."
        : "OpenRouter is not configured, so Spark cannot plan Claude/Codex/Cursor worker tasks yet. Add the API key in Settings, then run the plan again.",
    );
    return;
  }

  run = managerPlannedRun ?? (await createFallbackAutopilotTask(run, input));
  // A spawn_terminals decision lands the run as `complete` straight out of
  // plan_analysis — there is nothing to orchestrate, so don't fall through
  // into startAutopilot (which would flip it back to running and re-plan).
  if (
    run.status === "paused" ||
    run.status === "cancelled" ||
    run.status === "complete"
  ) {
    return;
  }
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

  const pendingLaunchTasks = pickAutopilotTasks(run);
  if (pendingLaunchTasks.length > 0) {
    await appendEvent({
      workspaceId: run.workspaceId,
      runId: run.id,
      type: "autopilot.manager_review_deferred_for_pending_tasks",
      message: `Manager review deferred while ${pendingLaunchTasks.length} queued worker task(s) remain`,
      payload: {
        taskIds: pendingLaunchTasks.map((task) => task.id),
        taskTitles: pendingLaunchTasks.map((task) => task.title),
        stepIds: [...new Set(pendingLaunchTasks.map((task) => task.stepId).filter(Boolean))],
      },
    });
    const input = autopilotInputFromRun(run);
    await startAutopilot({
      ...input,
      cwd: cwd || input.cwd,
      runId: run.id,
    });
    return;
  }

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

  // NOTE: trivial runs used to skip the manager review entirely (a "rubber
  // stamp" fast-path). That blind-accepted whatever the implementation worker
  // self-reported — and eval runs proved a confident worker can fail even the
  // public gate with zero detection. Trivial runs now fall through to the same
  // worker_result_review path as standard runs and get one verifier follow-up.
  // The verifier re-derives ground truth from the filesystem, so it catches
  // wrong-but-confident implementations the self-check missed.

  // NOTE: a standard-tier "clean-impl fast-path" used to skip the verifier
  // when Spark could re-run the impl worker's OWN verificationCommands and
  // they all exited 0. But the worker picks those commands itself — they
  // rarely probe the adversarial edge cases an independent verifier would.
  // Eval runs proved this: a pricing refactor self-verified green, the
  // verifier was skipped, and a hidden formatMoney edge case shipped broken.
  // Standard runs now always go through worker_result_review and earn their
  // verifier, exactly like trivial and complex runs.

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
  // Brake checkpoint: if the next active step is a brake, resolve it and
  // re-invoke plan_analysis so the manager can extend the plan with prior
  // worker reports as evidence.
  run = await resolveActiveBrakeAndReplan(run, cwd);
  if (run.status === "paused" || run.status === "cancelled" || run.status === "complete") return;
  // Cross-step plan hint: when worker_result_review tried to queue work into
  // a non-existent step (a real-world Grok-4.3 behavior — exploration done,
  // model wants to add the "now implement it" step itself), applySparkManagerDecision
  // captured those proposed tasks as a plan hint instead of silently dropping.
  // Re-invoke plan_analysis so the manager extends the plan with that hint in
  // context. Without this re-entry the run parks in reviewing/blocked forever.
  let tasks = pickAutopilotTasks(run);
  if (tasks.length === 0 && run.autopilot?.pendingPlanHint && !needsStepPlanning(run)) {
    run = (await askOpenRouterManager(run, cwd, "plan_analysis")) ?? run;
    if (run.status === "paused" || run.status === "cancelled" || run.status === "complete") return;
    tasks = pickAutopilotTasks(run);
  }
  // After advancing past a worker (and possibly a brake), the next active step
  // is usually a worker_batch that has plannedAgents but no worker tasks yet.
  // Call step_planning so the manager turns those plannedAgents into worker
  // task prompts before we try to launch.
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
): "plan_analysis" | "chat" | "step_planning" | "worker_result_review" {
  if (mode === "worker_result_review") return "worker_result_review";
  if (mode === "chat") return "chat";
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

async function askOpenRouterManagerForChat(run: RunState, cwd: string): Promise<RunState | null> {
  const enriched = await enrichLatestUserMessageWithMentionedFiles(run, cwd);
  return askOpenRouterManager(enriched, cwd, "chat");
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
  const next = pickPendingAutopilotStep(run);
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
  const contextPacketPath = join(callDir, "context-packet.json");
  const managerMode = normalizeOpenRouterManagerMode(mode);
  const workerReports = await collectWorkerReportContext(run, managerMode);
  const availableRuntimes = await detectConfiguredAgentRuntimes(settings);
  const agentSyncContext = renderAgentSyncManagerContext({ cwd, settings });
  const requestBody = buildOpenRouterManagerRequest({
    run,
    cwd,
    model: config.model,
    mode: managerMode,
    workerReports,
    availableRuntimes,
    agentSyncContext,
  });
  const contextWindow = contextWindowForModel(config.model);
  const contextPacket = buildContextPacket({
    runId: run.id,
    callId,
    mode,
    requestBody,
    tokenBudget: contextWindow.tokens,
  });
  await fs.mkdir(callDir, { recursive: true });
  await Promise.all([
    fs.writeFile(requestPath, JSON.stringify(redactRequestBodyForArtifact(requestBody), null, 2), "utf8"),
    fs.writeFile(contextPacketPath, JSON.stringify(contextPacket, null, 2), "utf8"),
  ]);

  const startedAt = new Date().toISOString();
  const sparkCall: SparkCall = {
    id: callId,
    runId: run.id,
    mode,
    model: config.model,
    status: "started",
    contextPacketId: contextPacket.id,
    requestPath,
    responsePath,
    parsedJsonPath,
    promptTokenEstimate: contextPacket.tokenEstimate,
    contextWindowTokens: contextWindow.tokens,
    contextWindowSource: contextWindow.source,
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
    agentRuntimeSelection: settings.agentRuntimeSelection,
    agentMcpSyncEnabled: settings.agentMcpSyncEnabled,
    agentSkillSyncEnabled: settings.agentSkillSyncEnabled,
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
      contextPacketPath,
      promptTokenEstimate: contextPacket.tokenEstimate,
      contextWindowTokens: contextWindow.tokens,
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
    const completedContextWindow = contextWindowForModel(result.model);
    if (targetCall) {
      targetCall.status = "completed";
      targetCall.model = result.model;
      targetCall.durationMs = result.durationMs;
      targetCall.promptTokens = result.promptTokens;
      targetCall.completionTokens = result.completionTokens;
      targetCall.promptTokenEstimate = contextPacket.tokenEstimate;
      targetCall.contextWindowTokens = completedContextWindow.tokens;
      targetCall.contextWindowSource = completedContextWindow.source;
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
        promptTokenEstimate: contextPacket.tokenEstimate,
        contextWindowTokens: completedContextWindow.tokens,
        contextWindowSource: completedContextWindow.source,
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
      targetCall.promptTokenEstimate = contextPacket.tokenEstimate;
      targetCall.contextWindowTokens = contextWindow.tokens;
      targetCall.contextWindowSource = contextWindow.source;
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
// Cursor has a single model (composer-2.5-fast) with no effort levels, so it
// is absent from this table on purpose — promoteForTrivial leaves cursor
// agents alone.
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

function managerStepText(step: SparkManagerStepDecision): string {
  return [
    step.title,
    step.goal,
    ...(step.acceptanceCriteria ?? []),
    ...(step.plannedAgents ?? []).map((agent) => [agent.label, agent.summary].filter(Boolean).join(" ")),
  ].join(" ");
}

function managerTaskText(task: SparkManagerTaskDecision): string {
  return [
    task.title,
    task.description,
    ...(task.expectedOutputs ?? []),
    ...(task.verificationCommands ?? []),
  ].join(" ");
}

async function maybeEnforceExplicitParallelStagingPlan(
  run: RunState,
  decision: SparkManagerDecision,
  mode: SparkCall["mode"],
): Promise<{ decision: SparkManagerDecision; reason: string; stagedFiles: string[] } | null> {
  if (mode !== "plan_analysis" && mode !== "chat") return null;
  if (decision.status !== "run_workers") return null;
  if (decision.steps.length === 0) return null;

  const sourceIntent = explicitParallelSourceIntentForMode(run, mode);
  if (mode === "chat" && !hasExplicitParallelAgentIntent(sourceIntent)) return null;

  const intent = [
    sourceIntent,
    decision.summary,
    decision.steps.map(managerStepText).join("\n"),
  ].join("\n");
  if (!hasExplicitParallelAgentIntent(intent) || !hasUiLogicSplitIntent(intent)) return null;

  const finalFile = inferFinalHtmlFile(intent);
  const runtimes = await chooseUiLogicRuntimes();
  const parts = explicitParallelPartPaths(run, finalFile);
  const hasParallelPartsStep = decision.steps.some((step) => isExplicitParallelPartsStep(step));
  const hasIntegratorStep = decision.steps.some((step) => isExplicitIntegratorStep(step, finalFile));
  const shouldUseHybridRuntimes = shouldEnforceHybridParallelRuntimes(intent, decision, runtimes);
  const decisionText = decision.steps
    .map((step) =>
      [
        step.title,
        step.goal,
        ...step.acceptanceCriteria,
        ...step.plannedAgents.map((agent) => agent.summary),
      ].join(" "),
    )
    .join("\n");
  const usesWorkspaceSparkParts = /\.spark-parts\b/i.test(decisionText);
  if (hasParallelPartsStep && hasIntegratorStep && !usesWorkspaceSparkParts && !shouldUseHybridRuntimes) {
    return null;
  }

  const integratorStep = makeExplicitIntegratorStep({
    finalFile,
    uiFile: parts.uiFile,
    logicFile: parts.logicFile,
    runtime: runtimes.integrator,
    stepLabel: hasParallelPartsStep ? decision.steps.length + 1 : 2,
    oneFileRequired: explicitOneFileRequired(intent),
  });

  return {
    reason:
      usesWorkspaceSparkParts
        ? "The human does not want a .spark-parts workspace folder; moving staged parallel artifacts into the Spark run artifact directory."
        : shouldUseHybridRuntimes
          ? "The explicit parallel UI/logic split should use the available hybrid of installed runtimes instead of one runtime for every worker."
        : hasParallelPartsStep
        ? "The human explicitly requested a final combine step; the manager planned the parallel workers but omitted the integrator."
        : "The human explicitly requested simultaneous/different agents for UI/structure and logic, followed by a combine step.",
    stagedFiles: [parts.uiFile, parts.logicFile, finalFile],
    decision: {
      ...decision,
      summary: usesWorkspaceSparkParts
        ? "Explicit multi-agent plan repaired: staging moves to the Spark run artifact directory, followed by a single integration worker."
        : shouldUseHybridRuntimes
          ? "Explicit multi-agent plan repaired: parallel UI/logic staging uses the available runtime hybrid, followed by a single integration worker."
        : hasParallelPartsStep
          ? "Explicit multi-agent plan repaired: parallel staging workers are followed by a single integration worker."
          : "Explicit multi-agent plan enforced: parallel UI/structure and logic staging workers, followed by a single integration worker.",
      steps: hasParallelPartsStep && !usesWorkspaceSparkParts && !shouldUseHybridRuntimes
        ? [...decision.steps, integratorStep]
        : [
            makeExplicitParallelPartsStep({
              finalFile,
              uiFile: parts.uiFile,
              logicFile: parts.logicFile,
              runtimes,
            }),
            integratorStep,
          ],
      taskComplexity: decision.taskComplexity ?? "standard",
    },
  };
}

function explicitParallelSourceIntentForMode(run: RunState, mode: SparkCall["mode"]): string {
  if (mode !== "chat") return planIntentTextForRun(run);

  // A chat follow-up is an amendment to the current run, not a fresh replay of
  // the original plan. Only re-apply the explicit parallel staging override
  // when the latest user turn itself asks for parallel agents.
  return latestUserRunMessageText(run);
}

async function maybeAppendMissingExplicitParallelIntegratorStep(run: RunState): Promise<RunState | null> {
  const intent = planIntentTextForRun(run);
  if (!hasExplicitParallelAgentIntent(intent) || !hasUiLogicSplitIntent(intent)) return null;
  if (!run.steps.some((step) => isExplicitParallelPartsStep(step))) return null;
  const finalFile = inferFinalHtmlFile(intent);
  if (run.steps.some((step) => isExplicitIntegratorStep(step, finalFile))) return null;
  const parts = explicitParallelPartPaths(run, finalFile);
  const runtimes = await chooseUiLogicRuntimes();
  const integratorStep = makeExplicitIntegratorStep({
    finalFile,
    uiFile: parts.uiFile,
    logicFile: parts.logicFile,
    runtime: runtimes.integrator,
    stepLabel: run.steps.length + 1,
    oneFileRequired: explicitOneFileRequired(intent),
  });
  const updated = await createStep({
    runId: run.id,
    title: integratorStep.title,
    goal: integratorStep.goal,
    kind: integratorStep.kind,
    plannedAgents: integratorStep.plannedAgents,
    riskLevel: integratorStep.riskLevel,
    acceptanceCriteria: integratorStep.acceptanceCriteria,
  });
  await appendEvent({
    workspaceId: updated.workspaceId,
    runId: updated.id,
    type: "spark_manager.missing_explicit_integrator_appended",
    message: "Added missing final integration step before accepting explicit multi-agent run",
    payload: {
      finalFile,
      stagedFiles: [parts.uiFile, parts.logicFile],
    },
  });
  return updated;
}

function explicitParallelPartPaths(run: RunState, finalFile: string): { uiFile: string; logicFile: string } {
  const stem = finalFile.replace(/\.html$/i, "") || "app";
  const stagingDir = join(run.artifactDir, "staging");
  return {
    uiFile: join(stagingDir, `${stem}-ui.html`),
    logicFile: join(stagingDir, `${stem}-logic.js`),
  };
}

function explicitOneFileRequired(text: string): boolean {
  return /\b(one|single)\s+file\b/i.test(text) || /only\s+one\s+html/i.test(text);
}

function makeExplicitParallelPartsStep(input: {
  finalFile: string;
  uiFile: string;
  logicFile: string;
  runtimes: { ui: WorkerRuntime; logic: WorkerRuntime; integrator: WorkerRuntime };
}): SparkManagerStepDecision {
  const uiAgent = makeExplicitParallelAgent(
    "worker 1.1",
    `Create the retro HTML/CSS structure in ${input.uiFile}; own only the staged UI artifact and define clear DOM hooks for the logic worker.`,
    input.runtimes.ui,
  );
  const logicAgent = makeExplicitParallelAgent(
    "worker 1.2",
    `Create the calculator JavaScript logic in ${input.logicFile}; own only the staged logic artifact and target the UI worker's DOM hooks.`,
    input.runtimes.logic,
  );
  return {
    kind: "worker_batch",
    title: "Build calculator parts in parallel",
    goal:
      `Honor the explicit simultaneous-agent request without write collisions. ` +
      `The UI worker owns ${input.uiFile}; the logic worker owns ${input.logicFile}; neither edits ${input.finalFile} in this step.`,
    plannedAgents: [uiAgent, logicAgent],
    acceptanceCriteria: [
      `${input.uiFile} contains the retro calculator HTML/CSS structure with display, controls, semantic landmarks, responsive polish, and stable DOM hooks.`,
      `${input.logicFile} contains calculator behavior for digits, decimal input, clear, operators, equals, error handling, and keyboard or click-friendly event wiring without eval/new Function.`,
      "The two staged artifacts agree on the DOM hook contract and do not overwrite each other's files.",
    ],
    riskLevel: "low",
  };
}

function makeExplicitIntegratorStep(input: {
  finalFile: string;
  uiFile: string;
  logicFile: string;
  runtime: WorkerRuntime;
  stepLabel: number;
  oneFileRequired: boolean;
}): SparkManagerStepDecision {
  const integrator = makeExplicitParallelAgent(
    `worker ${input.stepLabel}.1`,
    `Combine ${input.uiFile} and ${input.logicFile} into the final ${input.finalFile}, verify behavior, and remove staging artifacts.`,
    input.runtime,
  );
  const cleanupCriterion = input.oneFileRequired
    ? `Final workspace contains ${input.finalFile} plus the plan file only; do not leave staging folders or temporary artifacts in the workspace.`
    : `Do not leave staging folders or temporary artifacts in the workspace after ${input.finalFile} is integrated.`;
  return {
    kind: "worker_batch",
    title: "Combine staged calculator",
    goal:
      `Integrate the staged UI and logic into ${input.finalFile}, inline everything needed to run locally, ` +
      "verify the calculator, and clean up staging artifacts.",
    plannedAgents: [integrator],
    acceptanceCriteria: [
      `${input.finalFile} is a polished retro calculator with HTML, CSS, and JavaScript integrated.`,
      "Calculator supports basic arithmetic, clear/reset, equals, decimal input, divide-by-zero handling, and usable click/keyboard interaction.",
      cleanupCriterion,
    ],
    riskLevel: "low",
  };
}

function isExplicitParallelPartsStep(step: Pick<StepState, "title" | "goal" | "acceptanceCriteria" | "plannedAgents">): boolean {
  const text = [
    step.title,
    step.goal,
    ...(step.acceptanceCriteria ?? []),
    ...(step.plannedAgents ?? []).map((agent) => agent.summary),
  ].join(" ");
  return (step.plannedAgents?.length ?? 0) >= 2 && hasStagingArtifactReference(text) && hasUiLogicSplitIntent(text);
}

function isExplicitIntegratorStep(
  step: Pick<StepState, "title" | "goal" | "acceptanceCriteria" | "plannedAgents">,
  finalFile: string,
): boolean {
  const text = [
    step.title,
    step.goal,
    ...(step.acceptanceCriteria ?? []),
    ...(step.plannedAgents ?? []).map((agent) => agent.summary),
  ].join(" ");
  return (
    /\b(combine|integrate|merge|assemble)\b/i.test(text) &&
    (text.includes(finalFile) || hasStagingArtifactReference(text))
  );
}

function shouldEnforceHybridParallelRuntimes(
  intent: string,
  decision: SparkManagerDecision,
  runtimes: { ui: WorkerRuntime; logic: WorkerRuntime; integrator: WorkerRuntime },
): boolean {
  if (runtimes.ui === runtimes.logic) return false;
  if (!/\b(different agents?|claude|codex|cursor|hybrid)\b/i.test(intent)) return false;
  const parallelStep = decision.steps.find((step) => {
    const text = [
      step.title,
      step.goal,
      ...step.acceptanceCriteria,
      ...step.plannedAgents.map((agent) => agent.summary),
    ].join(" ");
    return (step.plannedAgents?.length ?? 0) >= 2 && hasUiLogicSplitIntent(text);
  });
  if (!parallelStep) return false;
  const assigned = new Set(parallelStep.plannedAgents.map((agent) => agent.runtimePreference));
  return !(assigned.has(runtimes.ui) && assigned.has(runtimes.logic));
}

function hasStagingArtifactReference(text: string): boolean {
  return /\.spark-parts\b|[\\/]staging[\\/]|run artifact|artifact directory/i.test(text);
}

function planIntentTextForRun(run: RunState): string {
  const plan = run.planId
    ? run.plans.find((item) => item.id === run.planId)
    : run.plans.at(-1);
  const notes = run.humanMessages
    .filter((message) => message.author === "user" && (message.kind === "note" || message.kind === "answer"))
    .map((message) => message.message);
  return [plan?.rawContent ?? "", ...notes].join("\n");
}

function latestUserRunMessageText(run: RunState): string {
  return (
    [...run.humanMessages]
      .reverse()
      .find((message) => message.author === "user" && (message.kind === "note" || message.kind === "answer"))
      ?.message ?? ""
  );
}

function hasExplicitParallelAgentIntent(text: string): boolean {
  const lower = text.toLowerCase();
  const asksForAgents =
    /\bspawn\b[\s\S]{0,80}\b(agent|worker|codex|claude|cursor)s?\b/.test(lower) ||
    /\b(agent|worker|codex|claude|cursor)s?\b[\s\S]{0,80}\b(simultaneous|parallel|at the same time)\b/.test(lower) ||
    /\bdifferent agent\b/.test(lower);
  const asksForParallel = /\b(simultaneous|parallel|at the same time)\b/.test(lower);
  const asksForCombine = /\b(combine|integrate|merge|assemble)\b/.test(lower);
  return asksForAgents && (asksForParallel || asksForCombine);
}

function hasUiLogicSplitIntent(text: string): boolean {
  const lower = text.toLowerCase();
  const ui = /\b(html|css|ui|structure|layout|visual|design)\b/.test(lower);
  const logic = /\b(javascript|js|logic|functionality|behavior|behaviour)\b/.test(lower);
  return ui && logic;
}

function inferFinalHtmlFile(text: string): string {
  const explicit = text.match(/(?:^|[\s`'"])([A-Za-z0-9._-]+\.html)(?=$|[\s`'",.)])/i)?.[1];
  if (explicit && explicit.toLowerCase() !== "plan.html") return explicit;
  if (/\bcalculator\b/i.test(text)) return "calculator.html";
  return "index.html";
}

async function chooseUiLogicRuntimes(): Promise<{
  ui: WorkerRuntime;
  logic: WorkerRuntime;
  integrator: WorkerRuntime;
}> {
  const diagnostics = await detectConfiguredAgentRuntimes();
  const installed = new Set(
    diagnostics
      .filter((runtime) => runtime.installed)
      .map((runtime) => runtime.kind),
  );
  const hasClaude = installed.has("claude");
  const hasCodex = installed.has("codex");
  const hasCursor = installed.has("cursor");
  const ui: WorkerRuntime = hasClaude ? "claude" : hasCursor ? "cursor" : hasCodex ? "codex" : "manual";
  const logic: WorkerRuntime = hasCodex ? "codex" : hasCursor ? "cursor" : ui;
  const integrator: WorkerRuntime = hasClaude ? "claude" : hasCursor ? "cursor" : logic;
  return { ui, logic, integrator };
}

async function rerouteUnavailableAgentRuntimes(
  decision: SparkManagerDecision,
): Promise<{ decision: SparkManagerDecision; rerouted: RuntimeReroute[] }> {
  const diagnostics = await detectConfiguredAgentRuntimes();
  const available = diagnostics.filter((runtime) => runtime.installed);
  const availableKinds = new Set(available.map((runtime) => runtime.kind));
  const fallback = available.find((runtime) => runtime.kind === "codex")
    ?? available.find((runtime) => runtime.kind === "claude")
    ?? available.find((runtime) => runtime.kind === "cursor");
  const rerouted: RuntimeReroute[] = [];

  const rewrite = (runtimePreference: WorkerRuntime, modelHint?: string, effortHint?: WorkerTask["effortHint"]) => {
    if (runtimePreference !== "claude" && runtimePreference !== "codex" && runtimePreference !== "cursor") {
      return { runtimePreference, modelHint, effortHint };
    }
    if (availableKinds.has(runtimePreference)) {
      return { runtimePreference, modelHint, effortHint };
    }
    if (!fallback) {
      rerouted.push({
        from: runtimePreference,
        to: "manual",
        reason: "Requested agent runtime is not installed or is disabled by Settings > Agents.",
      });
      return {
        runtimePreference: "manual" as WorkerRuntime,
        modelHint: undefined,
        effortHint: undefined,
      };
    }

    const model = fallback.models.find((item) => item.isDefault) ?? fallback.models[0];
    const nextModelHint = modelHint?.trim() && fallback.kind === runtimePreference
      ? modelHint
      : model?.id;
    const nextEffortHint = normalizeWorkerEffortForModel(effortHint, model);
    rerouted.push({
      from: runtimePreference,
      to: fallback.kind,
      modelHint: nextModelHint,
      effortHint: nextEffortHint,
      reason: "Requested agent runtime is not installed or is disabled by Settings > Agents.",
    });
    return {
      runtimePreference: fallback.kind as WorkerRuntime,
      modelHint: nextModelHint,
      effortHint: nextEffortHint,
    };
  };

  const steps = decision.steps.map((step) => ({
    ...step,
    plannedAgents: step.plannedAgents.map((agent) => ({
      ...agent,
      ...rewrite(agent.runtimePreference, agent.modelHint, agent.effortHint),
    })),
  }));
  const tasks = decision.tasks.map((task) => ({
    ...task,
    ...rewrite(task.runtimePreference, task.modelHint, task.effortHint),
  }));

  return {
    decision: { ...decision, steps, tasks },
    rerouted,
  };
}

// Detects whether the project plan rawContent contains an explicit, universal
// runtime mandate ("I want all the workers to be cursor", "use only claude",
// "every agent should be codex"). Returns the mandated runtime or null. When a
// mandate is present, enforceUserRuntimeMandate rewrites every follow-up task
// the manager queues to that runtime — overriding the manager's cross-provider
// verifier rotation and any attempt to escalate to a different runtime on
// failure. The manager profile contains the same instruction at the prompt
// layer; this code path is the defensive backstop when the manager forgets.
function detectPlanRuntimeMandate(run: RunState): WorkerRuntime | null {
  const planText = run.plans?.[0]?.rawContent ?? "";
  if (!planText) return null;
  const runtimes: WorkerRuntime[] = ["cursor", "claude", "codex"];
  for (const rt of runtimes) {
    const patterns = [
      // "all/every/only the workers ... cursor"
      new RegExp(`\\b(all|every|only|each)\\s+(the\\s+|of\\s+the\\s+)?(worker|workers|agent|agents)\\b[^.\\n]{0,80}\\b${rt}\\b`, "i"),
      // "cursor only" / "cursor exclusively"
      new RegExp(`\\b${rt}\\s+(only|exclusively|throughout)\\b`, "i"),
      // "only cursor" / "exclusively cursor"
      new RegExp(`\\b(only|exclusively)\\s+${rt}\\b`, "i"),
      // "use (only) cursor for/workers/agents"
      new RegExp(`\\buse\\s+(only\\s+)?${rt}\\b`, "i"),
      // "(workers|agents) (should|must|to) be cursor"
      new RegExp(`\\b(worker|workers|agent|agents)\\s+(should|must|need(s)?\\s+to|have\\s+to|to)\\s+be\\s+${rt}\\b`, "i"),
      // "I want ... workers ... be cursor"
      new RegExp(`\\b(want|need|require)\\s+(all\\s+)?(the\\s+)?(worker|workers|agent|agents)\\s+(to\\s+)?be\\s+${rt}\\b`, "i"),
    ];
    for (const re of patterns) {
      if (re.test(planText)) return rt;
    }
  }
  return null;
}

// Rewrites every task and plannedAgent in the decision so its runtimePreference,
// modelHint, and effortHint match the user's mandated runtime. Skips entries
// already on the mandate, and leaves shell/manual entries alone (those are
// escape hatches, not autonomous runtimes). If the mandated runtime is not
// installed, returns the decision unchanged so rerouteUnavailableAgentRuntimes
// can pick a fallback the usual way.
async function enforceUserRuntimeMandate(
  decision: SparkManagerDecision,
  mandate: WorkerRuntime,
): Promise<{ decision: SparkManagerDecision; overrides: RuntimeReroute[] }> {
  const diagnostics = await detectConfiguredAgentRuntimes();
  const installedKinds = new Set(
    diagnostics.filter((runtime) => runtime.installed).map((runtime) => runtime.kind),
  );
  if (mandate !== "claude" && mandate !== "codex" && mandate !== "cursor") {
    return { decision, overrides: [] };
  }
  if (!installedKinds.has(mandate)) {
    return { decision, overrides: [] };
  }
  const modelDefaults: Record<string, { modelHint?: string; effortHint?: WorkerTask["effortHint"] }> = {
    cursor: { modelHint: "composer-2.5-fast", effortHint: "medium" },
    claude: { modelHint: "claude-opus-4-7", effortHint: "high" },
    codex: { modelHint: "gpt-5.5", effortHint: "high" },
  };
  const defaults = modelDefaults[mandate] ?? { modelHint: undefined, effortHint: undefined };
  const overrides: RuntimeReroute[] = [];
  const rewrite = (
    runtimePreference: WorkerRuntime,
    modelHint: string | undefined,
    effortHint: WorkerTask["effortHint"] | undefined,
    contextLabel: string,
  ) => {
    if (runtimePreference === mandate) {
      return { runtimePreference, modelHint, effortHint };
    }
    if (
      runtimePreference !== "claude" &&
      runtimePreference !== "codex" &&
      runtimePreference !== "cursor"
    ) {
      return { runtimePreference, modelHint, effortHint };
    }
    overrides.push({
      from: runtimePreference,
      to: mandate,
      modelHint: defaults.modelHint,
      effortHint: defaults.effortHint,
      reason: `User plan mandates runtime '${mandate}' for every worker (${contextLabel})`,
    });
    return {
      runtimePreference: mandate,
      modelHint: defaults.modelHint,
      effortHint: defaults.effortHint,
    };
  };
  const steps = decision.steps.map((step) => ({
    ...step,
    plannedAgents: step.plannedAgents.map((agent) => ({
      ...agent,
      ...rewrite(agent.runtimePreference, agent.modelHint, agent.effortHint, `plannedAgent ${agent.label}`),
    })),
  }));
  const tasks = decision.tasks.map((task) => ({
    ...task,
    ...rewrite(task.runtimePreference, task.modelHint, task.effortHint, `task '${task.title}'`),
  }));
  return {
    decision: { ...decision, steps, tasks },
    overrides,
  };
}

function makeExplicitParallelAgent(
  label: string,
  summary: string,
  runtimePreference: WorkerRuntime,
): PlannedStepAgent {
  const floor = TRIVIAL_TOP_TIER_BY_RUNTIME[runtimePreference];
  return {
    label,
    summary,
    runtimePreference,
    modelHint: floor?.modelHint,
    effortHint: floor?.effortHint,
    taskClass: "feature",
  };
}

function strengthenParallelTaskScopes(
  run: RunState,
  decision: SparkManagerDecision,
  stepIds: string[],
): { decision: SparkManagerDecision; repairedCount: number } {
  if (decision.tasks.length < 2) return { decision, repairedCount: 0 };
  let repairedCount = 0;
  const tasks = decision.tasks.map((task) => ({
    ...task,
    allowedPaths: [...task.allowedPaths],
    forbiddenPaths: [...task.forbiddenPaths],
    expectedOutputs: [...task.expectedOutputs],
    verificationCommands: [...task.verificationCommands],
    conflictsWith: [...task.conflictsWith],
  }));

  const tasksByStep = new Map<string, SparkManagerTaskDecision[]>();
  for (const task of tasks) {
    const stepId = resolveTaskStepId(run, task.stepIndex, stepIds);
    if (!stepId) continue;
    const step = run.steps.find((item) => item.id === stepId);
    if ((step?.plannedAgents?.length ?? 0) <= 1) continue;
    const list = tasksByStep.get(stepId) ?? [];
    list.push(task);
    tasksByStep.set(stepId, list);
  }

  for (const group of tasksByStep.values()) {
    for (const task of group) {
      if (task.taskClass === "verifier") continue;
      if (task.allowedPaths.length > 0) continue;
      const inferred = inferStagingAllowedPaths(task);
      if (inferred.length === 0) continue;
      task.allowedPaths = inferred;
      repairedCount += 1;
    }

    const implementationTasks = group.filter((task) => task.taskClass !== "verifier");
    if (implementationTasks.length <= 1) continue;
    const allHaveConcreteScopes = implementationTasks.every(
      (task) => concreteDecisionAllowedPaths(task).length > 0,
    );
    const scopesOverlap = implementationTasks.some((task, index) =>
      implementationTasks.slice(index + 1).some((other) =>
        decisionTaskScopesOverlap(task, other),
      ),
    );
    if (!allHaveConcreteScopes || scopesOverlap) continue;
    for (const task of implementationTasks) {
      if (!task.canRunParallel) {
        task.canRunParallel = true;
        repairedCount += 1;
      }
    }
  }

  return repairedCount > 0 ? { decision: { ...decision, tasks }, repairedCount } : { decision, repairedCount };
}

function inferStagingAllowedPaths(task: SparkManagerTaskDecision): string[] {
  const text = [task.title, task.description, ...task.expectedOutputs].join("\n");
  const paths = new Set<string>();
  for (const match of text.matchAll(/(?:^|[\s`'"])(\.spark-parts\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+)(?=$|[\s`'",.)])/gi)) {
    const normalized = normalizeTaskPath(match[1]);
    if (normalized && !isBroadPathScope(normalized)) paths.add(normalized);
  }
  for (const match of text.matchAll(/([A-Za-z]:[\\/][^\n`'"]*?[\\/]staging[\\/][^\s`'",)]+?\.[A-Za-z0-9]+)/gi)) {
    const normalized = normalizeTaskPath(match[1]);
    if (normalized && !isBroadPathScope(normalized)) paths.add(normalized);
  }
  return Array.from(paths);
}

function concreteDecisionAllowedPaths(task: SparkManagerTaskDecision): string[] {
  return task.allowedPaths
    .map(normalizeTaskPath)
    .filter((path) => path.length > 0 && !isBroadPathScope(path));
}

function decisionTaskScopesOverlap(left: SparkManagerTaskDecision, right: SparkManagerTaskDecision): boolean {
  const leftPaths = concreteDecisionAllowedPaths(left);
  const rightPaths = concreteDecisionAllowedPaths(right);
  if (leftPaths.length === 0 || rightPaths.length === 0) return true;
  return leftPaths.some((leftPath) =>
    rightPaths.some((rightPath) => pathScopesOverlap(leftPath, rightPath)),
  );
}

function dropVerifierTasksWithExistingPeer(
  run: RunState,
  decision: SparkManagerDecision,
  stepIds: string[],
): { decision: SparkManagerDecision; dropped: Array<{ title: string; stepId: string; existingTaskId: string }> } {
  const dropped: Array<{ title: string; stepId: string; existingTaskId: string }> = [];
  const tasks = decision.tasks.filter((task) => {
    if (task.taskClass !== "verifier") return true;
    const stepId = resolveTaskStepId(run, task.stepIndex, stepIds);
    if (!stepId) return true;
    const existing = run.workerTasks.find(
      (candidate) =>
        candidate.stepId === stepId &&
        candidate.taskClass === "verifier" &&
        candidate.status !== "failed" &&
        candidate.status !== "cancelled",
    );
    if (!existing) return true;
    dropped.push({ title: task.title, stepId, existingTaskId: existing.id });
    return false;
  });
  return dropped.length > 0
    ? { decision: { ...decision, tasks }, dropped }
    : { decision, dropped };
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
//   - the agent is non-verifier and runs on claude/codex/cursor
//
// Saves ~3 minutes (manager call 2 was 2992 reasoning tokens / ~3 min on
// bjgp3uso7).
async function tryTrivialFastPathStepPlanning(run: RunState): Promise<RunState | null> {
  if (run.taskComplexity !== "trivial") return null;
  const activeStep = pickPendingAutopilotStep(run);
  if (!activeStep) return null;
  if ((activeStep.kind ?? "worker_batch") !== "worker_batch") return null;
  const agents = activeStep.plannedAgents ?? [];
  if (agents.length !== 1) return null;
  const agent = agents[0];
  if (agent.taskClass === "verifier") return null;
  if (
    agent.runtimePreference !== "claude" &&
    agent.runtimePreference !== "codex" &&
    agent.runtimePreference !== "cursor"
  ) {
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
    "First inspect the workspace. If files already exist, discover the real files involved with Glob/Grep/Read before editing. If the workspace is blank or only contains the plan, create exactly the artifact(s) required by the goal.",
    "Do not assume file paths beyond names explicitly stated in the goal/acceptance criteria. Keep the change scoped to this task.",
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
  // Product-facing UI work needs an adversarial verifier even when the
  // implementation supplied green smoke commands. The quality failures we care
  // about here are often "dead affordance" or "looks unfinished" gaps that a
  // narrow command cannot see.
  if (taskLooksLikeVisibleUi(step, impl)) return null;
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

// Effort levels Spark passes through verbatim when building a Claude
// standing terminal. "max" is intentionally omitted: the user types these
// terminals manually and Claude rejects `--effort max` outside of certain
// model+plan combinations. "minimal" is omitted because the Claude CLI
// rejects it outright (Codex's lowest tier). Anything else from this set
// gets forwarded to the provider's buildArgs unchanged.
const STANDING_TERMINAL_CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

// Build the launch command for a standing interactive terminal: a plain
// claude/codex/cursor session the user drives. Like buildLaunchCommandLine,
// but without the worker-task wiring — these are not Spark workers.
//
// The CLI-specific argv is produced by the runtime's `CliProvider`
// (see src/main/providers/) so adding a new CLI later only requires a new
// provider file. This function still owns shell-rendering concerns
// (quoting, the cursor pwsh dispatch quirk) because those depend on the
// shell we're spawning into, not on the CLI itself.
function buildStandingTerminalCommand(
  runtime: "claude" | "codex" | "cursor",
  model?: string,
  effort?: string,
): string {
  // Behaviour preservation: the previous inline builder only forwarded
  // `effort` for Claude (and only the four gated values below). Codex and
  // Cursor standing terminals deliberately ignored effort, even when the
  // caller passed it. We replicate that gate here so the provider doesn't
  // start emitting `-c "model_reasoning_effort=..."` for codex terminals
  // it never did before.
  let effectiveEffort: SpawnOpts["effort"];
  if (runtime === "claude" && effort && STANDING_TERMINAL_CLAUDE_EFFORTS.has(effort)) {
    effectiveEffort = effort as SpawnOpts["effort"];
  }

  const provider = getProvider(runtime);
  const providerArgs = provider.buildArgs({
    cwd: "",
    model: model?.trim(),
    effort: effectiveEffort,
  });

  // Render the argv into a single shell-ready string. The head segment is
  // the binary itself: for Cursor on Windows we dispatch through the
  // absolute path to `agent.cmd` because typing bare `agent` into pwsh
  // resolves to `agent.ps1` (an ExternalScript that runs IN THE PARENT
  // pwsh) and trips the user's $PROFILE hooks (Terminal-Icons floods the
  // pane with Import-PowerShellDataFile errors before the Cursor banner
  // even appears). `agent.cmd` spawns a fresh -NoProfile child.
  const head = renderStandingTerminalHead(runtime);
  const tail = providerArgs.map((arg) => quoteShellArg(arg));
  return [head, ...tail].join(" ");
}

function renderStandingTerminalHead(runtime: "claude" | "codex" | "cursor"): string {
  if (runtime === "cursor") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      // Quoted path needs the `&` call operator in pwsh.
      const cmdPath = join(localAppData, "cursor-agent", "agent.cmd");
      return `& ${quoteShellArg(cmdPath)}`;
    }
    return "agent";
  }
  // Claude and Codex are well-behaved on every shell we ship: their bin
  // names are unique on PATH and don't collide with PowerShell aliases.
  return runtime === "codex" ? "codex" : "claude";
}

function standingTerminalTitle(runtime: "claude" | "codex" | "cursor", model?: string): string {
  const base = runtime === "codex" ? "Codex" : runtime === "cursor" ? "Cursor" : "Claude";
  return model ? `${base} ${model}` : base;
}

// One-line chat confirmation for a spawn_terminals decision, e.g. "Opened 2
// Claude and 1 Codex standing terminals ...". Counts by runtime (claude,
// codex, cursor) so the user gets concrete acknowledgement that the request
// landed.
function describeSpawnedTerminals(terminals: Array<{ runtime: string }>): string {
  const counts = new Map<string, number>();
  for (const terminal of terminals) {
    const label = terminal.runtime === "codex" ? "Codex" : terminal.runtime === "cursor" ? "Cursor" : "Claude";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts].map(([label, n]) => `${n} ${label}`);
  const list =
    parts.length <= 1
      ? parts.join("")
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  const noun = terminals.length === 1 ? "terminal" : "terminals";
  return `Opened ${list} standing ${noun} in the workbench, yours to prompt and drive directly.`;
}

function spawnedTerminalsTitle(terminals: Array<{ runtime: string }>): string {
  const counts = new Map<string, number>();
  for (const terminal of terminals) {
    const label = terminal.runtime === "codex" ? "Codex" : terminal.runtime === "cursor" ? "Cursor" : "Claude";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts].map(([label, n]) => `${label} x${n}`);
  if (parts.length === 0) return "Agent terminals";
  return `${parts.join(" + ")} terminals`;
}

// Handle a spawn_terminals manager decision: the user asked Spark to open
// standing interactive terminals they will drive themselves. Spark emits one
// spark.spawn_terminals event carrying ready-to-run terminal specs (the
// renderer opens a grid tab with a pane per spec) and marks the run
// complete. A later chat message re-engages the manager via addRunMessage's
// terminal-run replanning path; the terminals are user-driven and are not
// tracked as Spark workers.
async function applySpawnTerminalsDecision(
  run: RunState,
  decision: SparkManagerDecision,
): Promise<RunState> {
  const terminals: Array<{ runtime: string; title: string; command: string }> = [];
  for (const req of decision.terminals ?? []) {
    for (let i = 0; i < req.count; i++) {
      terminals.push({
        runtime: req.runtime,
        title: standingTerminalTitle(req.runtime, req.model),
        command: buildStandingTerminalCommand(req.runtime, req.model, req.effort),
      });
    }
  }

  // Confirm in the chat so the user sees the terminals landed and does not
  // resend. Skip when the manager already posted its own reply this turn
  // (applySparkManagerDecision emits decision.chatReply before calling us).
  const lastMessage = run.humanMessages[run.humanMessages.length - 1];
  const managerAlreadyReplied = Boolean(
    lastMessage && lastMessage.author === "spark" && lastMessage.kind === "note",
  );
  if (!managerAlreadyReplied && terminals.length > 0) {
    run = await addRunMessage({
      runId: run.id,
      author: "spark",
      kind: "note",
      message: describeSpawnedTerminals(terminals),
    });
  }

  await appendEvent({
    workspaceId: run.workspaceId,
    runId: run.id,
    type: "spark.spawn_terminals",
    message: `Opening ${terminals.length} standing terminal(s)`,
    payload: { terminals },
  });

  return commitRunChange(run, {
    type: "autopilot.spawned_terminals",
    message: `Opened ${terminals.length} standing terminal(s) for the user to drive`,
    payload: { count: terminals.length, runtimes: terminals.map((t) => t.runtime) },
    mutate: (draft, timestamp) => {
      // The run did its one job — open the terminals. Mark it complete so a
      // later chat message re-engages the manager (addRunMessage replans a
      // terminal/complete run).
      draft.title = spawnedTerminalsTitle(terminals);
      draft.status = "complete";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
        status: "complete",
        lastAction: "spawned_terminals",
        spawnedTerminals: terminals.length,
        updatedAt: timestamp,
      };
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

  if (decision.status === "spawn_terminals") {
    return applySpawnTerminalsDecision(run, decision);
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
    return askHumanQuestion(
      run.id,
      decision.question || "Please clarify what Spark should do next.",
      decision.questionOptions,
    );
  }

  if (decision.status === "complete") {
    if (mode === "chat") {
      return commitRunChange(run, {
        type: "spark_manager.chat_completed",
        message: "Spark manager answered the chat turn",
        payload: {
          summary: decision.summary,
        },
        mutate: (draft, timestamp) => {
          const terminalStepStatuses = new Set(["complete", "failed", "skipped"]);
          for (const step of draft.steps) {
            if (terminalStepStatuses.has(step.status)) continue;
            step.status = "skipped";
            step.updatedAt = timestamp;
          }
          const cancellableTaskStatuses = new Set([
            "created",
            "queued",
            "claimed",
            "running",
            "needs_review",
            "retry_queued",
          ]);
          for (const task of draft.workerTasks) {
            if (!cancellableTaskStatuses.has(task.status)) continue;
            task.status = "cancelled";
            task.updatedAt = timestamp;
          }
          draft.currentStepId = undefined;
          draft.status = "complete";
          draft.autopilot = {
            ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
            status: "complete",
            lastAction: "manager_answered_chat",
            updatedAt: timestamp,
          };
          draft.updatedAt = timestamp;
        },
      });
    }

    const repaired = await maybeAppendMissingExplicitParallelIntegratorStep(run);
    if (repaired) return repaired;

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
      const pendingStepsCanComplete =
        pendingTasks.length === 0 &&
        pendingSteps.length > 0 &&
        pendingSteps.every((step) => {
          const tasks = run.workerTasks.filter((task) => task.stepId === step.id);
          return tasks.length > 0 && tasks.every((task) => task.status === "accepted" || task.status === "cancelled");
        });
      if (pendingStepsCanComplete) {
        return commitRunChange(run, {
          type: "spark_manager.completed_run",
          message: "Spark manager marked the run complete after accepting reviewed steps",
          payload: {
            summary: decision.summary,
            completedStepIds: pendingSteps.map((step) => step.id),
          },
          mutate: (draft, timestamp) => {
            const ids = new Set(pendingSteps.map((step) => step.id));
            for (const step of draft.steps) {
              if (!ids.has(step.id)) continue;
              step.status = "complete";
              step.reviewSummary = decision.summary || step.reviewSummary;
              step.updatedAt = timestamp;
              if (draft.currentStepId === step.id) draft.currentStepId = undefined;
            }
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
    // Recon-as-completion guard: even when no steps/tasks remain pending,
    // refuse `complete` when the run executed only read-only / recon-style
    // workers and zero non-verifier tasks reported any filesChanged. Without
    // this, a manager that planned a single recon worker_batch (no following
    // implementation step) lands the run with no behavioral changes — the
    // run.json shows `lastAction: "manager_marked_complete"` and the user
    // gets back an empty diff for a request that demanded code edits. The
    // existing failsafe at >=2 refusals still applies, so a model that
    // truly believes no changes are needed can land after the loop.
    if (mode === "worker_result_review") {
      const reconRefusal = await maybeReconAsCompletionRefusal(run, decision.summary);
      if (reconRefusal) return reconRefusal;
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

  const explicitParallelPlan = await maybeEnforceExplicitParallelStagingPlan(run, decision, mode);
  if (explicitParallelPlan) {
    decision = explicitParallelPlan.decision;
    await appendEvent({
      workspaceId: run.workspaceId,
      runId: run.id,
      type: "spark_manager.explicit_parallel_staging_enforced",
      message: "Normalized explicit parallel staging plan",
      payload: {
        reason: explicitParallelPlan.reason,
        stagedFiles: explicitParallelPlan.stagedFiles,
      },
    });
  }

  // Note: a hardcoded "route any calculator-shaped step to codex" override
  // used to live here. It second-guessed every plan touching the word
  // "calculator" and rewrote claude assignments to codex regardless of what
  // the manager decided — the dominant cause of "Spark almost only uses
  // codex" complaints. Removed so the manager's own routing (and the
  // hybrid-runtime split in shouldEnforceHybridParallelRuntimes) stand.
  // Quality regressions on calculator-shaped tasks should be addressed by
  // tuning the manager profile or worker prompt, not by per-task overrides.

  const userRuntimeMandate = detectPlanRuntimeMandate(run);
  if (userRuntimeMandate) {
    const mandateRepair = await enforceUserRuntimeMandate(decision, userRuntimeMandate);
    decision = mandateRepair.decision;
    if (mandateRepair.overrides.length > 0) {
      await appendEvent({
        workspaceId: run.workspaceId,
        runId: run.id,
        type: "spark_manager.user_runtime_mandate_enforced",
        message: `Rewrote ${mandateRepair.overrides.length} assignment(s) to honor user plan runtime mandate '${userRuntimeMandate}'`,
        payload: {
          mandate: userRuntimeMandate,
          overrides: mandateRepair.overrides,
          mode,
        },
      });
    }
  }

  const runtimeRepair = await rerouteUnavailableAgentRuntimes(decision);
  decision = runtimeRepair.decision;
  if (runtimeRepair.rerouted.length > 0) {
    await appendEvent({
      workspaceId: run.workspaceId,
      runId: run.id,
      type: "spark_manager.unavailable_runtime_rerouted",
      message: `Rerouted ${runtimeRepair.rerouted.length} assignment(s) away from disabled or unavailable runtimes`,
      payload: {
        rerouted: runtimeRepair.rerouted,
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
    (mode === "plan_analysis" || mode === "chat") && decision.steps.length > 0
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
  if ((mode === "plan_analysis" || mode === "chat") && steps.length > 0 && latest.steps.length > 0) {
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
    (mode === "plan_analysis" || mode === "chat") &&
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
  //   - trivial/standard: keep at most ONE verifier per step (cross-provider
  //              single peer), drop additional ones. Trivial keeps its one
  //              verifier — a confident worker self-report is not proof, and
  //              eval runs showed blind-accepted trivial work failing basic
  //              input/output checks with zero detection.
  //   - complex: no change (current dual-peer pattern stands).
  if (mode === "worker_result_review" && decision.tasks.length > 0 && latest.taskComplexity) {
    const complexity = latest.taskComplexity;
    if (complexity === "standard" || complexity === "trivial") {
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
        const implRuntime = recentImpl?.runtimePreference;
        // Prefer ANY verifier whose runtime differs from the impl's. With
        // three runtimes (claude/codex/cursor) there are two valid
        // cross-provider picks per impl; either is acceptable.
        const kept =
          (implRuntime && list.find((t) => t.runtimePreference && t.runtimePreference !== implRuntime)) ||
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
          message: `Demoted dual-verifier pair to single cross-provider verifier on a ${complexity} run (${droppedTitles.length} dropped)`,
          payload: {
            taskComplexity: complexity,
            droppedCount: droppedTitles.length,
            droppedTitles,
          },
        });
      }
    }
  }

  if (mode === "worker_result_review" && decision.tasks.length > 0) {
    const verifierDedup = dropVerifierTasksWithExistingPeer(latest, decision, stepIds);
    if (verifierDedup.dropped.length > 0) {
      decision = verifierDedup.decision;
      await appendEvent({
        workspaceId: latest.workspaceId,
        runId: latest.id,
        type: "spark_manager.duplicate_verifier_tasks_dropped",
        message: `Dropped ${verifierDedup.dropped.length} duplicate verifier task(s) because a verifier already exists for the step`,
        payload: {
          dropped: verifierDedup.dropped,
        },
      });
    }
  }

  const parallelScopeRepair = strengthenParallelTaskScopes(latest, decision, stepIds);
  if (parallelScopeRepair.repairedCount > 0) {
    decision = parallelScopeRepair.decision;
    await appendEvent({
      workspaceId: latest.workspaceId,
      runId: latest.id,
      type: "spark_manager.parallel_task_scopes_repaired",
      message: `Repaired ${parallelScopeRepair.repairedCount} parallel task scope hint(s)`,
      payload: {
        repairedCount: parallelScopeRepair.repairedCount,
        taskTitles: decision.tasks.map((task) => task.title),
      },
    });
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

  if (mode === "worker_result_review" && decision.tasks.length === 0) {
    // Recon-as-completion guard (parallel to the one in applySparkManagerDecision):
    // the manager can also bypass `status: "complete"` by returning run_workers
    // with tasks=[] (accept-no-verifier path). Without this check that path
    // marks the recon step complete via completeAcceptedReviewingSteps, the
    // run lands with no impl changes, and the user gets an empty diff.
    const reconRefusal = await maybeReconAsCompletionRefusal(latest, decision.summary);
    if (reconRefusal) {
      latest = reconRefusal;
    } else {
      latest = await completeAcceptedReviewingSteps(latest, decision.summary);
    }
  }

  let createdTaskCount = 0;
  let droppedTaskCount = 0;
  // Review-mode tasks that target a non-existent step are not really drops —
  // they are cross-step gap proposals (e.g. "exploration is done, now edit
  // file X"). Capture them as a plan hint so the next plan_analysis pass
  // extends the plan instead of the run silently parking in reviewing/blocked.
  const crossStepHintTasks: SparkManagerTaskDecision[] = [];
  for (const task of decision.tasks) {
    let stepId = resolveTaskStepId(latest, task.stepIndex, stepIds);
    if (!stepId && mode === "worker_result_review") {
      const reopened = await maybeReopenCompletedStepForFollowUpTask(latest, task);
      if (reopened) {
        latest = reopened.run;
        stepId = reopened.stepId;
      }
    }
    if (!stepId) {
      droppedTaskCount += 1;
      if (mode === "worker_result_review") {
        crossStepHintTasks.push(task);
      }
      await appendEvent({
        workspaceId: latest.workspaceId,
        runId: latest.id,
        type: "spark_manager.task_without_active_step_dropped",
        message: `Dropped manager task because no mutable step is active: ${task.title}`,
        payload: {
          title: task.title,
          requestedStepIndex: task.stepIndex,
          completedStepCount: latest.steps.filter((step) => isTerminalStepStatus(step.status)).length,
          capturedAsPlanHint: mode === "worker_result_review",
        },
      });
      continue;
    }
    if (skippedStepIds.has(stepId ?? "")) {
      droppedTaskCount += 1;
      continue;
    }
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
    createdTaskCount += 1;
  }

  latest = await requireRun(latest.id);

  // Persist or clear the cross-step plan hint. Review-mode drops become hints
  // for the next plan_analysis call; any successful plan_analysis pass that
  // emits new steps consumes the prior hint (the gap is now planned for).
  if (crossStepHintTasks.length > 0) {
    latest = await commitRunChange(latest, {
      type: "autopilot.plan_hint_captured",
      message: `Captured ${crossStepHintTasks.length} cross-step task hint(s) from review for next plan_analysis`,
      payload: {
        summary: decision.summary,
        taskTitles: crossStepHintTasks.map((t) => t.title),
      },
      mutate: (draft, timestamp) => {
        draft.autopilot = {
          ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
          pendingPlanHint: {
            summary: decision.summary,
            droppedTasks: crossStepHintTasks.map((t) => ({
              title: t.title,
              description: t.description,
              requestedStepIndex: t.stepIndex,
              allowedPaths: t.allowedPaths,
              runtimePreference: t.runtimePreference,
              taskClass: t.taskClass,
            })),
            createdAt: timestamp,
          },
          updatedAt: timestamp,
        };
        draft.updatedAt = timestamp;
      },
    });
  } else if (
    (mode === "plan_analysis" || mode === "chat") &&
    steps.length > 0 &&
    latest.autopilot?.pendingPlanHint
  ) {
    latest = await commitRunChange(latest, {
      type: "autopilot.plan_hint_consumed",
      message: "Cleared pending plan hint after plan_analysis emitted new steps",
      payload: {
        consumedTaskTitles: latest.autopilot.pendingPlanHint.droppedTasks.map((t) => t.title),
      },
      mutate: (draft, timestamp) => {
        if (!draft.autopilot) return;
        const { pendingPlanHint: _consumed, ...rest } = draft.autopilot;
        draft.autopilot = {
          ...rest,
          updatedAt: timestamp,
        };
        draft.updatedAt = timestamp;
      },
    });
  }

  await appendEvent({
    workspaceId: latest.workspaceId,
    runId: latest.id,
    type: "spark_manager.decision_applied",
    message: "Spark manager decision applied",
    payload: {
      summary: decision.summary,
      status: decision.status,
      stepsCreated: steps.length,
      tasksRequested: decision.tasks.length,
      tasksCreated: createdTaskCount,
      tasksDropped: droppedTaskCount,
      planHintCaptured: crossStepHintTasks.length,
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

export async function pauseRunAfterCurrentWorkers(input: PauseRunInput): Promise<RunState> {
  const run = await requireRun(input.runId);
  const reason = input.reason?.trim() || "Stop after current workers finish";
  const recordPauseMessage = shouldRecordPauseReasonAsUserNote(reason);
  return commitRunChange(run, {
    type: "run.pause_after_workers",
    message: reason,
    payload: {
      reason,
      activeWorkerAttempts: activeWorkersForRun(run.id).map((worker) => worker.attemptId),
      controlSignal: "none",
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
        lastAction: "pause_after_current_workers",
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
  const resumeInput = autopilotInputFromRun(run);
  const shouldScheduleManagerAfterResume = shouldResumeManagerPlanning(run);
  if (activeWorkersForRun(run.id).length === 0 && shouldRoutePausedResumeToChat(run)) {
    const chatDecision = await askOpenRouterManagerForChat(run, resumeInput.cwd);
    if (chatDecision) {
      if (chatDecision.status === "paused" || chatDecision.status === "cancelled" || chatDecision.status === "complete") {
        return chatDecision;
      }
      if (chatDecision.steps.length > 0 || chatDecision.workerTasks.length > 0) {
        return startAutopilot({ ...resumeInput, runId: chatDecision.id });
      }
    }
  }
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
  if (shouldScheduleManagerAfterResume) {
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
  const attachmentInputs = input.attachments ?? [];
  const message = input.message.trim() || fallbackMessageForAttachments(attachmentInputs);
  if (!message) throw new Error("Message is required.");
  const clientMessageId = input.clientMessageId?.trim();

  if (
    clientMessageId &&
    run.humanMessages.some((entry) => entry.clientMessageId === clientMessageId)
  ) {
    return run;
  }

  // Swallow a repeated message: the same author re-sending identical text
  // shortly after their last one is a double-click, an Enter-key repeat, or a
  // frustrated re-send while waiting — never intent. Look back past any Spark
  // replies in between, since the immediately-previous message is often
  // Spark's own confirmation, which would otherwise mask the repeat.
  const priorSameAuthor = [...run.humanMessages]
    .reverse()
    .find((entry) => entry.author === input.author);
  if (
    attachmentInputs.length === 0 &&
    priorSameAuthor &&
    priorSameAuthor.message === message &&
    Date.now() - new Date(priorSameAuthor.createdAt).getTime() < 20000
  ) {
    return run;
  }

  const messageId = makeId("msg");
  const attachments = await persistRunMessageAttachments(run.id, messageId, attachmentInputs);
  const questionOptions =
    input.author === "spark" && input.kind === "question"
      ? normalizeQuestionOptionsForMessage(message, input.questionOptions)
      : undefined;
  const humanMessage = {
    id: messageId,
    clientMessageId,
    runId: run.id,
    author: input.author,
    kind: input.kind,
    message,
    questionOptions,
    attachments,
    createdAt: new Date().toISOString(),
  };

  const wasTerminal = run.status === "complete" || run.status === "failed" || run.status === "cancelled";
  let messageRecorded = false;
  const updated = await commitRunChange(run, {
    type: `human.${input.kind}`,
    message: `${input.author}: ${message.slice(0, 160)}`,
    payload: { message: humanMessage },
    mutate: (draft, timestamp) => {
      if (
        clientMessageId &&
        draft.humanMessages.some((entry) => entry.clientMessageId === clientMessageId)
      ) {
        return false;
      }
      const latestSameAuthor = [...draft.humanMessages]
        .reverse()
        .find((entry) => entry.author === input.author);
      if (
        attachmentInputs.length === 0 &&
        latestSameAuthor &&
        latestSameAuthor.message === message &&
        Date.now() - new Date(latestSameAuthor.createdAt).getTime() < 20000
      ) {
        return false;
      }
      messageRecorded = true;
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
  if (!messageRecorded) return updated;

  // Re-engage the manager when the user chatted into a terminal run. Terminal
  // follow-ups begin in chat-decision mode so Spark can either answer directly
  // from context or choose worker orchestration when tools are useful.
  if (input.author === "user" && wasTerminal) {
    const autopilotInput = autopilotInputFromRun(updated);
    scheduleInitialChatDecision(updated.id, autopilotInput, { afterCurrent: true });
  }

  return updated;
}

async function enrichLatestUserMessageWithMentionedFiles(run: RunState, cwd: string): Promise<RunState> {
  if (run.humanMessages.length === 0) return run;
  const latest = run.humanMessages[run.humanMessages.length - 1];
  if (latest.author !== "user" || (latest.kind !== "note" && latest.kind !== "answer")) return run;

  const explicitAttachments = (latest.attachments ?? []).filter((attachment) => attachment.kind === "file");
  const mentionedAttachments = await resolveMentionedFileAttachments(latest.message, cwd, explicitAttachments);
  if (mentionedAttachments.length === 0) return run;

  return commitRunChange(run, {
    type: "human.file_mentions_resolved",
    message: `Resolved ${mentionedAttachments.length} @file mention(s) for manager context`,
    payload: {
      messageId: latest.id,
      attachments: mentionedAttachments.map((attachment) => ({
        name: attachment.name,
        path: attachment.path,
        size: attachment.size,
        mimeType: attachment.mimeType,
      })),
    },
    mutate: (draft, timestamp) => {
      const target = draft.humanMessages.find((message) => message.id === latest.id);
      if (!target) return false;
      target.attachments = mergeRunMessageAttachments(target.attachments ?? [], mentionedAttachments);
      draft.updatedAt = timestamp;
    },
  });
}

async function resolveMentionedFileAttachments(
  message: string,
  cwd: string,
  existing: RunMessageAttachment[],
): Promise<RunMessageAttachment[]> {
  if (!cwd) return [];
  const existingKeys = new Set(existing.map((attachment) => normalizedPathKey(attachment.path)));
  const attachments: RunMessageAttachment[] = [];
  for (const token of parseInlineFileMentionTokens(message)) {
    const path = await resolveMentionedFilePath(cwd, token);
    if (!path) continue;
    const key = normalizedPathKey(path);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    try {
      const stat = await fs.stat(path);
      if (!stat.isFile()) continue;
      attachments.push({
        id: makeId("att-ref"),
        kind: "file",
        name: displayPathForResolvedMention(cwd, path),
        path,
        mimeType: fileMimeTypeForPath(path),
        size: stat.size,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // Ignore stale mentions. The manager still receives the user's text and
      // can decide whether to ask, answer from other context, or spawn workers.
    }
  }
  return attachments;
}

async function resolveMentionedFilePath(cwd: string, token: string): Promise<string | null> {
  const cleaned = cleanInlineFileMentionToken(token);
  if (!cleaned) return null;

  const directCandidates = isAbsolute(cleaned)
    ? [cleaned]
    : [resolvePath(cwd, cleaned)];
  for (const candidate of directCandidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try the workspace scan fallback below.
    }
  }

  return findWorkspaceFileMention(cwd, normalizeMentionPath(cleaned));
}

async function findWorkspaceFileMention(cwd: string, normalizedToken: string): Promise<string | null> {
  let visitedFiles = 0;
  async function walk(dir: string, depth: number): Promise<string | null> {
    if (depth > DIRECT_FILE_MENTION_SCAN_DEPTH || visitedFiles >= DIRECT_FILE_MENTION_SCAN_RESULTS) return null;
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    const files = entries.filter((entry) => entry.isFile());
    for (const entry of files) {
      visitedFiles += 1;
      const fullPath = join(dir, entry.name);
      const rel = normalizeMentionPath(relative(cwd, fullPath));
      const name = normalizeMentionPath(entry.name);
      if (rel === normalizedToken || name === normalizedToken) return fullPath;
      if (visitedFiles >= DIRECT_FILE_MENTION_SCAN_RESULTS) return null;
    }

    const dirs = entries.filter((entry) => entry.isDirectory() && !SKIPPED_DIRECT_FILE_MENTION_DIRS.has(entry.name));
    for (const entry of dirs) {
      const found = await walk(join(dir, entry.name), depth + 1);
      if (found) return found;
      if (visitedFiles >= DIRECT_FILE_MENTION_SCAN_RESULTS) return null;
    }
    return null;
  }
  return walk(cwd, 0);
}

function mergeRunMessageAttachments(
  first: RunMessageAttachment[],
  second: RunMessageAttachment[],
): RunMessageAttachment[] {
  const byPath = new Map<string, RunMessageAttachment>();
  for (const attachment of [...first, ...second]) {
    byPath.set(normalizedPathKey(attachment.path), attachment);
  }
  return [...byPath.values()];
}

function parseInlineFileMentionTokens(message: string): string[] {
  const tokens: string[] = [];
  const pattern = /(^|[\s([{,;:])@([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(message)) !== null) {
    const token = cleanInlineFileMentionToken(match[2]);
    if (token) tokens.push(token);
  }
  return tokens;
}

function cleanInlineFileMentionToken(token: string): string {
  return token
    .trim()
    .replace(/^@+/, "")
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/[),.;:!?]+$/g, "");
}

function normalizeMentionPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
}

function normalizedPathKey(path: string): string {
  return resolvePath(path).toLowerCase();
}

function displayPathForResolvedMention(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  if (rel && rel !== ".." && !rel.startsWith(`..${"\\"}`) && !rel.startsWith("../") && !isAbsolute(rel)) {
    return rel;
  }
  return basename(path);
}

async function persistRunMessageAttachments(
  runId: string,
  messageId: string,
  inputs: AddRunMessageInput["attachments"],
): Promise<RunMessageAttachment[]> {
  const selected = (inputs ?? [])
    .filter((input) => input?.sourcePath?.trim())
    .slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  if (selected.length === 0) return [];

  const attachmentDir = join(runDir(runId), "attachments");
  await fs.mkdir(attachmentDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const attachments: RunMessageAttachment[] = [];

  for (const input of selected) {
    const sourcePath = input.sourcePath.trim();
    const mimeType = imageMimeTypeForPath(sourcePath);
    const kind = input.kind ?? (mimeType ? "image" : "file");
    if (kind === "image" && !mimeType) {
      throw new Error(`Unsupported image attachment type: ${basename(sourcePath)}`);
    }
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) throw new Error(`Attachment is not a file: ${sourcePath}`);
    if (kind === "image" && stat.size > MAX_IMAGE_ATTACHMENT_BYTES) {
      throw new Error(`Image attachment is too large: ${basename(sourcePath)}`);
    }

    const id = makeId("att");
    const safeName = basename(input.name?.trim() || sourcePath);
    if (kind === "file") {
      attachments.push({
        id,
        kind,
        name: safeName,
        path: sourcePath,
        mimeType: fileMimeTypeForPath(sourcePath),
        size: stat.size,
        createdAt,
      });
      continue;
    }

    const ext = normalizedImageExtension(sourcePath);
    const storedPath = join(attachmentDir, `${messageId}-${id}${ext}`);
    await fs.copyFile(sourcePath, storedPath);
    attachments.push({
      id,
      kind,
      name: safeName,
      path: storedPath,
      mimeType: mimeType!,
      size: stat.size,
      createdAt,
    });
  }

  return attachments;
}

function fallbackMessageForAttachments(inputs: AddRunMessageInput["attachments"]): string {
  const count = inputs?.filter((input) => input?.sourcePath?.trim()).length ?? 0;
  if (count === 0) return "";
  return `Use the attached reference${count === 1 ? "" : "s"} as context.`;
}

function imageMimeTypeForPath(path: string): string | null {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    default:
      return null;
  }
}

function normalizedImageExtension(path: string): string {
  const ext = extname(path).toLowerCase();
  return ext === ".jpeg" ? ".jpg" : ext;
}

function fileMimeTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".css":
      return "text/css";
    case ".csv":
      return "text/csv";
    case ".htm":
    case ".html":
      return "text/html";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "text/javascript";
    case ".json":
      return "application/json";
    case ".md":
    case ".mdx":
      return "text/markdown";
    case ".svg":
      return "image/svg+xml";
    case ".ts":
    case ".tsx":
      return "text/typescript";
    case ".txt":
      return "text/plain";
    case ".xml":
      return "application/xml";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    default:
      return "application/octet-stream";
  }
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
    clientMessageId: input.clientMessageId,
    author: "user",
    kind,
    message,
    attachments: input.attachments,
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

// Flip the "seen" attention bit to true. The renderer calls this when the
// user focuses a chat whose status is `complete` and `seen === false`, so
// the visual treatment drops from done-unseen (teal) back to done-seen
// (green). Idempotent — calling on a run that is already seen, or whose
// status isn't `complete`, is a no-op.
export async function markRunSeen(input: MarkRunSeenInput): Promise<RunState> {
  const run = await requireRun(input.runId);
  if (run.seen === true || run.status !== "complete") return run;
  return commitRunChange(run, {
    type: "run.seen",
    message: "Run marked seen",
    payload: { previousSeen: run.seen ?? false },
    mutate: (draft, timestamp) => {
      if (draft.seen === true) return false;
      draft.seen = true;
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
  if (input.stepId) {
    const step = run.steps.find((item) => item.id === input.stepId);
    if (!step) {
      throw new Error(`Step not found: ${input.stepId}`);
    }
    if (isImmutableStepStatus(step.status)) {
      throw new Error(`Cannot add a worker task to ${step.status} step: ${step.title}`);
    }
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
      const step = nextTask.stepId
        ? draft.steps.find((item) => item.id === nextTask.stepId)
        : undefined;
      if (step && isImmutableStepStatus(step.status)) {
        throw new Error(`Cannot add a worker task to ${step.status} step: ${step.title}`);
      }
      draft.workerTasks.push(nextTask);
      if (nextTask.stepId) {
        if (step) {
          if (!step.workerTaskIds.includes(nextTask.id)) {
            step.workerTaskIds.push(nextTask.id);
            step.updatedAt = timestamp;
          }
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
  if (step && isImmutableStepStatus(step.status)) {
    throw new Error(`Cannot prepare worker task for ${step.status} step: ${step.title}`);
  }
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
  const peerCommsEnabled = shouldUsePeerComms(run, step, task);
  if (peerCommsEnabled) {
    await ensurePeerCommsArtifacts(run, step, task, attempt.id, paths, "prompt_ready").catch(() => undefined);
  }
  const settings = await loadSettings();
  const prompt = renderWorkerPrompt({ cwd: input.cwd, run, step, task, paths, settings });

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
  const runtimes = await detectConfiguredAgentRuntimes();
  const target =
    runtimes.find((runtime) => runtime.kind === "codex" && runtime.installed) ??
    runtimes.find((runtime) => runtime.kind === "claude" && runtime.installed) ??
    runtimes.find((runtime) => runtime.kind === "cursor" && runtime.installed);
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
  const taskStep = task.stepId ? run.steps.find((item) => item.id === task.stepId) : undefined;
  if (taskStep && isImmutableStepStatus(taskStep.status)) {
    throw new Error(`Cannot launch worker task for ${taskStep.status} step: ${taskStep.title}`);
  }

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
  if (task.runtimePreference === "cursor") {
    await ensureCursorProjectTrust(attempt.cwd).catch(() => undefined);
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
  await updatePeerCommsRegistry(run, launchStep, task, attempt.id, paths, "launching").catch(() => undefined);

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
  await updatePeerCommsRegistry(run, finishedStep, finishedTask, finishedAttempt.id, paths, finishedAttempt.status)
    .catch(() => undefined);

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
    pty.killImmediate(worker.attemptId);
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

  // shell.trashItem on Windows can prompt the user when the recycle bin is
  // full, when a file is locked, or when sync providers (OneDrive) intercept
  // the delete. We bypass it entirely and remove the directory directly.
  // Workers were just killed; give the OS a beat to release ConPTY handles
  // before the rm so EBUSY/EPERM doesn't bounce us.
  await rmRunDirHard(runDir(run.id));

  // Evict from the in-memory cache so a later getRun for this id falls
  // through to disk (and correctly returns null now that the file is gone).
  runCache.delete(run.id);
}

// Force-pause: hard-kill every active worker for the run, stop all autopilot
// cycles, transition active attempts/tasks to cancelled, set status=paused.
// This is the "pause everything NOW" button — the graceful pauseRun path
// only sends ESC and waits for workers to wind down on their own, which on
// Windows leaves ConPTY descendants alive long enough that a follow-up
// deleteRun trips the OS file-in-use prompt. Use this before deleting.
export async function forcePauseRun(runId: string): Promise<RunState> {
  const run = await requireRun(runId);
  const reason = "Force-paused by user";
  const activeWorkers = activeWorkersForRun(run.id);

  // 1. Kill every PTY immediately. No GRACE_MS, no taskkill race.
  for (const worker of activeWorkers) {
    try {
      worker.kill();
    } catch {
      /* worker.kill is best-effort; continue with hard pty kill */
    }
    try {
      pty.killImmediate(worker.attemptId);
    } catch {
      /* session may have already exited */
    }
    activeWorkerProcesses.delete(worker.attemptId);
  }

  // 2. Drop autopilot cycles so a queued review/plan doesn't relaunch.
  for (const key of [...activeAutopilotCycles.keys()]) {
    if (key.startsWith(`${run.id}:`)) activeAutopilotCycles.delete(key);
  }
  activeAutopilotPlans.delete(run.id);
  activeAutopilotReviews.delete(run.id);

  // 3. Commit the paused status and transition in-flight attempts/tasks to
  //    cancelled (so the next resume doesn't think they're still alive).
  const cancelledAttemptIds = new Set(activeWorkers.map((w) => w.attemptId));
  const cancelledTaskIds = new Set(
    activeWorkers.map((w) => w.workerTaskId).filter((id): id is string => Boolean(id)),
  );
  return commitRunChange(run, {
    type: "run.force_paused",
    message: reason,
    payload: {
      reason,
      cancelledAttemptIds: [...cancelledAttemptIds],
      cancelledTaskIds: [...cancelledTaskIds],
    },
    mutate: (draft, timestamp) => {
      draft.status = "paused";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
        status: "paused",
        lastAction: "force_paused",
        stopReason: reason,
        pausedAt: timestamp,
        updatedAt: timestamp,
      };
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

// Recursively delete the run directory with retries. Windows will reject
// the rm with EBUSY/EPERM if a process still has a handle open, or EACCES
// if a file is read-only. We retry a handful of times with a short sleep
// (giving ConPTY descendants time to exit) and chmod read-onlys in between.
async function rmRunDirHard(dir: string): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const attempts = [0, 100, 400, 1200];
  let lastError: unknown = null;
  for (const wait of attempts) {
    if (wait > 0) await sleep(wait);
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
      return;
    } catch (err) {
      lastError = err;
      await chmodReadable(dir).catch(() => undefined);
    }
  }
  // Last-ditch: log but don't throw; the user ran "delete" knowing the
  // run was misbehaving, and we don't want to surface a half-success that
  // looks worse than just leaving the directory in place.
  console.error("[run-store] rmRunDirHard failed", { dir, lastError });
}

async function chmodReadable(dir: string): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    try {
      await fs.chmod(full, 0o666);
    } catch {
      /* not all FS support chmod; ignore */
    }
    if (entry.isDirectory()) {
      await chmodReadable(full);
    }
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

  // CLI launch failure auto-fallback: when the runtime binary couldn't even
  // start (codex demanded an interactive update, claude not logged in, model id
  // invalid, etc.) the failure is environmental, not behavioral. Don't waste an
  // LLM manager round-trip — Spark already knows the answer is "try the same
  // task with the other runtime." Queue that fallback deterministically here,
  // before the manager review consumes the failed report.
  const launchFallback = await maybeQueueCliLaunchFallback({
    run,
    task,
    attempt,
    report,
  });
  if (launchFallback) return launchFallback;

  const decision = decideWorkerReport(report);
  const latest = await requireRun(run.id);
  const reviewedTask = latest.workerTasks.find((item) => item.id === task.id);
  const reviewedStep = task.stepId ? latest.steps.find((item) => item.id === task.stepId) : undefined;
  if (!reviewedTask) return latest;

  const timestamp = new Date().toISOString();
  if (decision.decision === "accept") {
    reviewedTask.status = "accepted";
    if (reviewedStep) {
      const stepTasks = latest.workerTasks.filter((t) => t.stepId === reviewedStep.id);
      const allAccepted =
        stepTasks.length > 0 &&
        stepTasks.every((t) => (t.id === reviewedTask.id ? true : t.status === "accepted"));
      const canCompleteLocally =
        allAccepted && canCompleteStepImmediatelyAfterLocalReview(latest, reviewedTask);
      reviewedStep.status = canCompleteLocally
        ? "complete"
        : hasActiveStepWorkers(latest, reviewedStep.id, reviewedTask.id)
          ? "running"
          : "reviewing";
      if (canCompleteLocally && latest.currentStepId === reviewedStep.id) latest.currentStepId = undefined;
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

function canCompleteStepImmediatelyAfterLocalReview(
  run: RunState,
  task: WorkerTask,
): boolean {
  // For standard/complex runs, an implementation worker's local "complete"
  // report is not the end of the step. The manager still has to accept,
  // queue verifier work, or produce a corrective task. Keeping the step in
  // reviewing until that decision means a later verifier lands before the
  // step ever shows as done in the chat timeline.
  if (
    (run.taskComplexity === "standard" || run.taskComplexity === "complex") &&
    task.taskClass !== "verifier"
  ) {
    return false;
  }
  return true;
}

// Returns a refusal RunState when the manager wants to land the run with zero
// implementation changes (recon-as-completion). Returns null when the run has
// legitimate impl work behind it OR when the refusal counter has already hit
// the failsafe threshold (so the run can land instead of looping forever).
// Shared by both the `status: "complete"` path and the `run_workers tasks=[]`
// path — both can end a run without an implementation worker ever editing a
// file, so both need the same check.
async function maybeReconAsCompletionRefusal(
  run: RunState,
  summary: string,
): Promise<RunState | null> {
  const nonVerifierTasks = run.workerTasks.filter(
    (task) => task.taskClass !== "verifier",
  );
  if (nonVerifierTasks.length === 0) return null;
  // Brake-bypass: if the very next non-terminal step after the currently
  // reviewing one is a brake, the recon-with-no-edits shape is EXPECTED —
  // the brake exists precisely to trigger plan_analysis re-entry with the
  // recon evidence so an implementation step can be planned next. Refusing
  // here keeps the recon step stuck in `reviewing`, the brake never becomes
  // active, and the autopilot loops on worker_result_review until the 2x
  // refusal cap force-accepts. That looks like a hang to the user and can
  // also trip step_planning into asking a generic "what should I do" question
  // because the only un-terminated step has plannedAgents already satisfied.
  const reviewingStepIdx = run.steps.findIndex((step) => step.status === "reviewing");
  if (reviewingStepIdx >= 0) {
    const nextStep = run.steps[reviewingStepIdx + 1];
    if (nextStep && (nextStep.kind ?? "worker_batch") === "brake" && !isTerminalStepStatus(nextStep.status)) {
      return null;
    }
  }
  let anyChanges = false;
  for (const attempt of run.workerAttempts) {
    const task = run.workerTasks.find((t) => t.id === attempt.workerTaskId);
    if (!task || task.taskClass === "verifier") continue;
    if (!attempt.finalReportPath) continue;
    const report = await readWorkerReport(attempt.finalReportPath);
    if (report && Array.isArray(report.filesChanged) && report.filesChanged.length > 0) {
      anyChanges = true;
      break;
    }
  }
  if (anyChanges) return null;
  const priorRefusals = run.autopilot?.consecutiveCompletionRefusals ?? 0;
  const nextRefusals = priorRefusals + 1;
  if (nextRefusals >= 2) return null;
  return commitRunChange(run, {
    type: "spark_manager.completion_refused",
    message: `Manager wants to land the run after only read-only workers (${nonVerifierTasks.length} non-verifier task(s), 0 filesChanged); replanning to add an implementation step`,
    payload: {
      summary,
      reason: "no_implementation_changes",
      nonVerifierTaskCount: nonVerifierTasks.length,
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

async function completeAcceptedReviewingSteps(
  run: RunState,
  summary: string,
): Promise<RunState> {
  const eligibleStepIds = run.steps
    .filter((step) => !isTerminalStepStatus(step.status))
    .filter((step) => {
      const tasks = run.workerTasks.filter((task) => task.stepId === step.id);
      return tasks.length > 0 && tasks.every((task) => task.status === "accepted" || task.status === "cancelled");
    })
    .map((step) => step.id);

  if (eligibleStepIds.length === 0) return run;

  return commitRunChange(run, {
    type: "spark_manager.accepted_reviewed_steps",
    message: `Manager accepted ${eligibleStepIds.length} reviewing step(s) with no follow-up tasks`,
    payload: {
      stepIds: eligibleStepIds,
      summary,
    },
    mutate: (draft, timestamp) => {
      const ids = new Set(eligibleStepIds);
      for (const step of draft.steps) {
        if (!ids.has(step.id)) continue;
        step.status = "complete";
        step.reviewSummary = summary || step.reviewSummary;
        step.updatedAt = timestamp;
        if (draft.currentStepId === step.id) draft.currentStepId = undefined;
      }

      const allStepsTerminal =
        draft.steps.length > 0 &&
        draft.steps.every((step) => isTerminalStepStatus(step.status));
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
        lastAction: allStepsTerminal
          ? "accepted_reviewed_steps_completed_run"
          : "accepted_reviewed_steps",
        updatedAt: timestamp,
      };
      if (allStepsTerminal) {
        draft.status = "complete";
        draft.autopilot.status = "complete";
      }
      draft.updatedAt = timestamp;
    },
  });
}

function formatProofAsSparkReply(proof: string): string {
  const trimmed = proof.trim();
  const parsed = parseProofCommandOutput(trimmed);
  if (parsed && parsed.exitCode === 0 && parsed.output.trim()) {
    const readTarget = inferReadCommandTarget(parsed.command);
    if (readTarget) {
      return formatFileContentReply(readTarget, parsed.output);
    }
  }

  const compactProof = trimmed.slice(0, 1800);
  const truncated = compactProof.length < trimmed.length;
  return [
    "Done. Verification output:",
    "",
    fencedMarkdown(compactProof, "text"),
    ...(truncated ? ["", "..."] : []),
  ].join("\n");
}

function formatFileContentReply(target: string, output: string): string {
  const content = output.trim();
  const compactContent = content.slice(0, 2400);
  const truncated = compactContent.length < content.length;
  return [
    `\`${displayReadTarget(target)}\` contains:`,
    "",
    fencedMarkdown(compactContent, markdownLanguageForPath(target)),
    ...(truncated ? ["", "..."] : []),
  ].join("\n");
}

function parseProofCommandOutput(
  proof: string,
): { command: string; exitCode: number; output: string } | null {
  const normalized = proof.replace(/\r\n/g, "\n").trim();
  const match = normalized.match(/^\$?\s*([^\n]+)\n\[exit=(-?\d+)\]\n*([\s\S]*)$/);
  if (!match) return null;
  return {
    command: match[1].trim(),
    exitCode: Number.parseInt(match[2], 10),
    output: match[3].trim(),
  };
}

function inferReadCommandTarget(command: string): string | null {
  const tokens = shellishTokens(command.replace(/^\$\s*/, ""));
  const readIndex = tokens.findIndex((token) =>
    /^(cat|type|gc|get-content)$/i.test(token),
  );
  if (readIndex < 0) return null;
  for (let i = readIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token === "|" || token === ";" || token === "&&" || token === "||") break;
    if (token.startsWith("-")) {
      if (/^-path$/i.test(token) || /^-literalpath$/i.test(token)) {
        return tokens[i + 1] ?? null;
      }
      continue;
    }
    return token;
  }
  return null;
}

function shellishTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function displayReadTarget(target: string): string {
  const cleaned = target.trim().replace(/^['"]|['"]$/g, "");
  return cleaned.length > 90 ? basename(cleaned) : cleaned;
}

function markdownLanguageForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".ps1")) return "powershell";
  if (lower.endsWith(".sh")) return "bash";
  return "text";
}

function fencedMarkdown(content: string, language: string): string {
  let fence = "```";
  while (content.includes(fence)) fence += "`";
  return `${fence}${language}\n${content.trim()}\n${fence}`;
}

// Detects the synthetic report written by writeAutoFailureReport when the
// agent CLI failed environmentally (launch failure, auth/API/socket failure),
// and if we haven't already exhausted runtimes, queues a fresh task on the
// same step with the opposite runtime. Returns the updated run when a fallback
// was queued (so the caller can short-circuit the normal review path), or null
// when no fallback applies.
async function maybeQueueCliLaunchFallback({
  run,
  task,
  attempt,
  report,
}: {
  run: RunState;
  task: WorkerTask;
  attempt: WorkerAttempt;
  report: WorkerReport;
}): Promise<RunState | null> {
  if (report.status !== "failed") return null;
  const isLaunchFailure = report.risks.some((risk) =>
    /CLI failed (?:to launch|before producing a final report)|runtime API error|socket connection/i.test(risk),
  );
  if (!isLaunchFailure) return null;
  if (
    task.runtimePreference !== "claude" &&
    task.runtimePreference !== "codex" &&
    task.runtimePreference !== "cursor"
  ) {
    return null;
  }
  const availableRuntimes = await detectConfiguredAgentRuntimes();
  // Prefer the first installed runtime OTHER than the one that just failed.
  // Order claude → codex → cursor by default, but skip the failing one. With
  // three runtimes we may still find a valid fallback even when one runtime
  // is offline.
  const preferenceOrder: WorkerRuntime[] = ["claude", "codex", "cursor"];
  const opposite: WorkerRuntime | null = preferenceOrder
    .filter((kind) => kind !== task.runtimePreference)
    .find((kind) => availableRuntimes.some((runtime) => runtime.kind === kind && runtime.installed)) ?? null;
  if (!opposite) return null;
  // Only fall back once per (step, title) lineage. If a sibling with the
  // opposite runtime already exists (failed, cancelled, or pending), both
  // runtimes have been tried — let the manager handle it.
  const triedRuntimes = new Set(
    run.workerTasks
      .filter((t) => t.stepId === task.stepId && t.title === task.title)
      .map((t) => t.runtimePreference),
  );
  if (triedRuntimes.has(opposite)) return null;

  const fallbackId = makeId("task");
  return commitRunChange(run, {
    type: "autopilot.cli_launch_fallback",
    message: `Auto-falling back from ${task.runtimePreference} to ${opposite} after CLI/runtime failure`,
    stepId: task.stepId,
    workerTaskId: fallbackId,
    payload: {
      previousTaskId: task.id,
      previousAttemptId: attempt.id,
      previousRuntime: task.runtimePreference,
      nextRuntime: opposite,
    },
    mutate: (draft, timestamp) => {
      // Cancel the failed task so pickAutopilotTasks won't re-launch it with
      // the same runtime that just failed environmentally.
      const failedTask = draft.workerTasks.find((t) => t.id === task.id);
      if (failedTask) {
        failedTask.status = "cancelled";
        failedTask.updatedAt = timestamp;
      }
      const fallbackTask: WorkerTask = {
        id: fallbackId,
        runId: draft.id,
        stepId: task.stepId,
        title: task.title,
        description: task.description,
        runtimePreference: opposite,
        modelHint: fallbackModelHintForRuntime(opposite),
        effortHint: fallbackEffortHintForRuntime(opposite, task.effortHint),
        status: "queued",
        allowedPaths: task.allowedPaths,
        forbiddenPaths: task.forbiddenPaths,
        expectedOutputs: task.expectedOutputs,
        verificationCommands: task.verificationCommands,
        canRunParallel: task.canRunParallel,
        conflictsWith: task.conflictsWith,
        taskClass: task.taskClass,
        createdBy: "system",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      draft.workerTasks.push(fallbackTask);
      if (fallbackTask.stepId) {
        const step = draft.steps.find((s) => s.id === fallbackTask.stepId);
        if (step) {
          if (!step.workerTaskIds.includes(fallbackTask.id)) {
            step.workerTaskIds.push(fallbackTask.id);
          }
          if (["complete", "failed", "skipped"].includes(step.status)) {
            step.status = "queued";
          }
          step.updatedAt = timestamp;
        }
      }
      draft.updatedAt = timestamp;
    },
  });
}

function buildContextPacket(input: {
  runId: string;
  callId: string;
  mode: SparkCall["mode"];
  requestBody: OpenRouterManagerRequest;
  tokenBudget: number;
}): ContextPacket {
  const included = describeRequestContext(input.requestBody);
  return {
    id: `ctx-${input.callId}`,
    runId: input.runId,
    decisionType: input.mode,
    included,
    excluded: [
      {
        label: "older worker report detail",
        reason: "kept as compact step review summaries and recent report excerpts",
      },
      {
        label: "older image pixels",
        reason: "stored as attachment artifacts; only the newest image turn is sent to planning/task-writing calls",
      },
    ],
    tokenBudget: input.tokenBudget,
    tokenEstimate: included.reduce((sum, item) => sum + (item.tokenEstimate ?? 0), 0),
    createdAt: new Date().toISOString(),
  };
}

function describeRequestContext(
  requestBody: OpenRouterManagerRequest,
): ContextPacket["included"] {
  const items: ContextPacket["included"] = [];
  for (const message of requestBody.messages) {
    if (typeof message.content === "string") {
      items.push(...estimateTextSections(message.content, message.role));
      continue;
    }

    for (const part of message.content) {
      if (part.type === "text") {
        for (const section of estimateTextSections(part.text, message.role)) {
          items.push(section);
        }
      } else {
        items.push({
          label: "attached image",
          reason: "latest user-provided visual context",
          tokenEstimate: estimateImageTokens(),
        });
      }
    }
  }
  return items;
}

function estimateTextSections(
  text: string,
  role: string,
): ContextPacket["included"] {
  if (role !== "user") {
    return [{
      label: `${role} message`,
      reason: "manager instruction/context text",
      tokenEstimate: estimateTokensFromText(text),
    }];
  }
  const matches = [...text.matchAll(/^([A-Z][A-Z0-9 -]+)$/gm)];
  if (matches.length === 0) {
    return [{
      label: "user message",
      reason: "manager run context",
      tokenEstimate: estimateTokensFromText(text),
    }];
  }
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    return {
      label: match[1].toLowerCase(),
      reason: "manager run context section",
      tokenEstimate: estimateTokensFromText(text.slice(start, end)),
    };
  });
}

function fallbackModelHintForRuntime(runtime: WorkerRuntime): string | undefined {
  if (runtime === "claude") return "claude-opus-4-7";
  if (runtime === "codex") return "gpt-5.5";
  if (runtime === "cursor") return "composer-2.5-fast";
  return undefined;
}

function fallbackEffortHintForRuntime(
  runtime: WorkerRuntime,
  prior: WorkerTask["effortHint"],
): WorkerTask["effortHint"] {
  if (runtime === "codex") {
    if (prior === "low" || prior === "medium" || prior === "high") return prior;
    return "xhigh";
  }
  if (runtime === "claude") {
    if (prior === "low" || prior === "medium" || prior === "high" || prior === "max") return prior;
    return "high";
  }
  if (runtime === "cursor") {
    // Cursor CLI has no reasoning-effort knob; the field exists only for
    // schema consistency and the launch command builder ignores it.
    return "medium";
  }
  return prior;
}

function redactRequestBodyForArtifact(requestBody: OpenRouterManagerRequest): OpenRouterManagerRequest {
  return JSON.parse(JSON.stringify(requestBody, (_key, value) => {
    if (typeof value === "string" && value.startsWith("data:image/")) {
      const prefix = value.slice(0, Math.min(value.indexOf(";base64,"), 64));
      return `${prefix};base64,[redacted image bytes]`;
    }
    return value;
  })) as OpenRouterManagerRequest;
}

async function collectWorkerReportContext(
  run: RunState,
  mode: OpenRouterManagerMode,
): Promise<SparkManagerWorkerReportContext[]> {
  const contexts: SparkManagerWorkerReportContext[] = [];
  const attemptLimit = mode === "worker_result_review" ? 6 : 4;
  for (const attempt of run.workerAttempts.slice(-attemptLimit)) {
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
      summary: truncateText(report?.summary, 700),
      proof: compactStringList(report?.proof, 5, 280),
      risks: compactStringList(report?.risks, 4, 260),
      followups: compactStringList(report?.followups, 4, 260),
      verifier: report?.verifier
        ? {
            status: report.verifier.status,
            confidence: report.verifier.confidence,
            atomicClaims: report.verifier.atomicClaims.map((claim) => ({
              claim: truncateText(claim.claim, 260) ?? "",
              verdict: claim.verdict,
              evidence: truncateText(claim.evidence, 320) ?? "",
            })),
            correctivePrompt: truncateText(report.verifier.correctivePrompt, 1800),
            missingOracle: truncateText(report.verifier.missingOracle, 600),
          }
        : undefined,
      taskClass: task.taskClass,
    });
  }
  return contexts;
}

function compactStringList(
  value: string[] | undefined,
  maxItems: number,
  maxLength: number,
): string[] {
  const source = value ?? [];
  const shown = source.slice(0, maxItems).map((item) => truncateText(item, maxLength) ?? "");
  if (source.length > shown.length) {
    shown.push(`[${source.length - shown.length} more item(s) omitted]`);
  }
  return shown.filter(Boolean);
}

function truncateText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return value;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength).trimEnd()}\n[truncated]`;
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
  normalizeRun(run);
  // Keep the in-memory cache current. saveRun is the only caller and it
  // always routes here, so setting the cache here covers every persist path
  // (createRun, commitRunChange, and every ad-hoc saveRun in this module).
  runCache.set(run.id, run);
  await fs.mkdir(runDir(run.id), { recursive: true });
  const path = runPath(run.id);
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  // run.json is machine-read, never shown to a human, so persist it compact —
  // no pretty-print whitespace. Human-facing artifacts (spark-call request/
  // response files, final reports) stay pretty-printed elsewhere.
  await fs.writeFile(tmp, JSON.stringify(run), "utf8");
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
  run.humanMessages = dedupeHumanMessages(run.humanMessages);
  for (const message of run.humanMessages) {
    message.attachments ??= [];
    if (message.author === "spark" && message.kind === "question") {
      message.questionOptions = normalizeQuestionOptionsForMessage(
        message.message,
        message.questionOptions,
      );
    } else {
      delete message.questionOptions;
    }
  }
  for (const step of run.steps ?? []) {
    step.plannedAgents ??= [];
  }
  run.autopilot ??= {
    status: run.status === "running" ? "running" : "idle",
    updatedAt: run.updatedAt,
  };
  // Older run.json files may carry legacy plan-mode fields; strip them so
  // consumers don't trip on stale state from the removed feature.
  delete (run as unknown as Record<string, unknown>).planMode;
  delete (run as unknown as Record<string, unknown>).pendingMutations;
  if (isTerminalRunStatus(run.status)) {
    run.completedAt ??= run.updatedAt;
  } else {
    delete run.completedAt;
  }
  // Older run.json files (pre-attention-rollup) didn't track `seen`. A
  // freshly-loaded complete run from disk has no signal to claim "I'm
  // unseen", so treat it as already-seen — otherwise every prior run would
  // turn teal the first time Spark restarts.
  if (run.seen === undefined) {
    run.seen = run.status === "complete" ? true : false;
  }
  return run;
}

const NORMALIZE_DUPLICATE_MESSAGE_WINDOW_MS = 120_000;

function dedupeHumanMessages(messages: RunState["humanMessages"]): RunState["humanMessages"] {
  const deduped: RunState["humanMessages"] = [];
  const byClientId = new Set<string>();
  const recentByText = new Map<string, { at: number }>();

  for (const message of messages) {
    const clientMessageId = message.clientMessageId?.trim();
    if (clientMessageId) {
      if (byClientId.has(clientMessageId)) continue;
      byClientId.add(clientMessageId);
    }

    const at = Date.parse(message.createdAt);
    const signature = [
      message.author,
      message.kind,
      message.message.replace(/\s+/g, " ").trim().toLowerCase(),
      (message.attachments ?? []).map((attachment) => attachment.id || attachment.path).join("|"),
    ].join("\u0000");
    const recent = recentByText.get(signature);
    if (
      recent &&
      Number.isFinite(at) &&
      Number.isFinite(recent.at) &&
      at - recent.at >= 0 &&
      at - recent.at <= NORMALIZE_DUPLICATE_MESSAGE_WINDOW_MS
    ) {
      recent.at = at;
      continue;
    }

    deduped.push(message);
    recentByText.set(signature, { at });
  }

  return deduped;
}

async function commitRunChange(
  run: RunState,
  change: {
    type: string;
    message: string;
    stepId?: string;
    workerTaskId?: string;
    payload?: Record<string, unknown>;
    mutate: (draft: RunState, timestamp: string) => void | false;
  },
): Promise<RunState> {
  let result: RunState | null = null;
  let prevStatus: RunState["status"] | null = null;
  let nextStatus: RunState["status"] | null = null;
  let persisted = false;
  const previous = runMutationQueues.get(run.id) ?? Promise.resolve();
  const next = previous
    .catch(() => {
      /* keep later mutations moving after an earlier failure */
    })
    .then(async () => {
      const latest = await requireRun(run.id);
      // Capture the pre-mutation status so we can detect transitions after
      // persistence. The notifications module suppresses no-ops (rule 3), and
      // the seen-flag reset below also needs the prior status.
      prevStatus = latest.status;
      const timestamp = new Date().toISOString();
      const changed = change.mutate(latest, timestamp);
      result = latest;
      if (changed === false) return;
      if (isTerminalRunStatus(latest.status)) {
        latest.completedAt ??= timestamp;
      } else {
        delete latest.completedAt;
      }
      // Non-complete → complete transitions reset the "seen" attention bit so
      // the chat surfaces as done-unseen until the user focuses it. Other
      // terminal statuses (failed/cancelled) are deliberately not part of the
      // seen calculus — they have their own dedicated tones in the UI.
      if (prevStatus !== "complete" && latest.status === "complete") {
        latest.seen = false;
      }
      await saveRun(latest);
      await appendEvent({
        timestamp,
        workspaceId: latest.workspaceId,
        runId: latest.id,
        stepId: change.stepId,
        workerTaskId: change.workerTaskId,
        type: change.type,
        message: change.message,
        payload: change.payload,
      });
      nextStatus = latest.status;
      persisted = true;
    });
  runMutationQueues.set(run.id, next);
  try {
    await next;
  } finally {
    if (runMutationQueues.get(run.id) === next) runMutationQueues.delete(run.id);
  }
  // Fire desktop notifications for blocked / complete transitions. Lazy-load
  // the module so the run-store cold path doesn't pull in the Electron
  // Notification API on every import — matches the deferred-load pattern used
  // for heavy modules in ipc.ts.
  if (persisted && result && prevStatus !== nextStatus && nextStatus !== null) {
    void (async () => {
      try {
        const mod = await import("../notifications");
        mod.notifyRunStateTransition(result!, prevStatus, nextStatus!);
      } catch {
        /* notification delivery is best-effort */
      }
    })();
  }
  return result ?? (await requireRun(run.id));
}

function changedFields(input: object, excluded: string[]): string[] {
  const values = input as Record<string, unknown>;
  return Object.keys(values).filter((key) => !excluded.includes(key) && values[key] !== undefined);
}

function isTerminalStepStatus(status: StepState["status"]): boolean {
  return status === "complete" || status === "failed" || status === "skipped";
}

function isTerminalRunStatus(status: RunState["status"]): boolean {
  return status === "complete" || status === "failed" || status === "cancelled";
}

function isImmutableStepStatus(status: StepState["status"]): boolean {
  return status === "complete" || status === "skipped";
}

function pickPendingAutopilotStep(run: RunState): StepState | undefined {
  return run.steps.find((step) => !isTerminalStepStatus(step.status));
}

function pickAutopilotStep(run: RunState): StepState | undefined {
  return pickPendingAutopilotStep(run) ?? run.steps[0];
}

// Hard cap on attempts per worker task. The manager is allowed to retry, but
// after this many failures we treat the task as terminally failed instead of
// looping forever — the previous behaviour wasted ~30 min on a codex trust
// prompt that headless can't dismiss.
const MAX_WORKER_ATTEMPTS = 3;

function countWorkerAttempts(run: RunState, taskId: string): number {
  return run.workerAttempts.filter((attempt) => attempt.workerTaskId === taskId).length;
}

function normalizeTaskPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/\*\*?$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function isBroadPathScope(path: string): boolean {
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

function taskWritesWorkspace(task: WorkerTask): boolean {
  return task.taskClass !== "verifier" && task.runtimePreference !== "manual";
}

function concreteAllowedPaths(task: WorkerTask): string[] {
  return task.allowedPaths
    .map(normalizeTaskPath)
    .filter((path) => path.length > 0 && !isBroadPathScope(path));
}

function hasConcreteParallelScope(task: WorkerTask): boolean {
  if (!taskWritesWorkspace(task)) return true;
  return concreteAllowedPaths(task).length > 0;
}

function pathScopesOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function taskPathScopesConflict(left: WorkerTask, right: WorkerTask): boolean {
  if (!taskWritesWorkspace(left) || !taskWritesWorkspace(right)) return false;
  const leftPaths = concreteAllowedPaths(left);
  const rightPaths = concreteAllowedPaths(right);
  if (leftPaths.length === 0 || rightPaths.length === 0) return true;
  return leftPaths.some((leftPath) =>
    rightPaths.some((rightPath) => pathScopesOverlap(leftPath, rightPath)),
  );
}

function tasksConflictForParallelLaunch(left: WorkerTask, right: WorkerTask): boolean {
  if (left.conflictsWith.includes(right.id) || right.conflictsWith.includes(left.id)) {
    return true;
  }
  return taskPathScopesConflict(left, right);
}

function pickAutopilotTasks(run: RunState): WorkerTask[] {
  const activeStep = pickAutopilotStep(run);
  const candidates = run.workerTasks.filter((task) => {
    if (!["created", "queued", "failed", "retry_queued"].includes(task.status)) return false;
    if (task.status === "failed" && countWorkerAttempts(run, task.id) >= MAX_WORKER_ATTEMPTS) {
      return false;
    }
    if (!activeStep) return true;
    if (isTerminalStepStatus(activeStep.status)) return false;
    if (task.stepId === activeStep.id) return true;
    return false;
  });
  if (candidates.length === 0) return [];

  const cap = evalMaxParallelWorkers();
  const first = candidates[0];
  if (!first.canRunParallel) return [first];
  if (!hasConcreteParallelScope(first)) return [first];

  const selected: WorkerTask[] = [];
  for (const task of candidates) {
    if (!task.canRunParallel) continue;
    if (!hasConcreteParallelScope(task)) continue;
    if (selected.some((other) => tasksConflictForParallelLaunch(other, task))) {
      continue;
    }
    selected.push(task);
    if (cap && selected.length >= cap) break;
  }
  return selected.length > 0 ? selected : [first];
}

function evalMaxParallelWorkers(): number | null {
  const raw = process.env.SPARK_EVAL_MAX_PARALLEL_WORKERS;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

// True when the next active step is a worker_batch with plannedAgents but no
// queueable worker tasks. Used by the autopilot review loop to decide whether
// to invoke step_planning before declaring "nothing to do".
function needsStepPlanning(run: RunState): boolean {
  const active = pickPendingAutopilotStep(run);
  if (!active) return false;
  if ((active.kind ?? "worker_batch") !== "worker_batch") return false;
  if ((active.plannedAgents?.length ?? 0) === 0) return false;
  // A step already in `reviewing` has its tasks done — step_planning has
  // nothing to plan and the model will either return tasks=[] or, worse,
  // fall back to status=ask_user with a generic "Please clarify the first
  // concrete task" question. The reviewing state is handled by
  // worker_result_review and the brake-resolution path, not by replanning.
  if (active.status === "reviewing") return false;
  const stepTasks = run.workerTasks.filter((task) => task.stepId === active.id);
  // If we already have at least one task per plannedAgent for this step,
  // there is nothing to plan — even if those tasks are accepted/in-progress
  // rather than queueable. This guards against the autopilot looping into
  // step_planning after the only task has finished and the step is sitting
  // in `reviewing` waiting for the manager-review pass.
  if (stepTasks.length >= (active.plannedAgents?.length ?? 0)) return false;
  const queueable: WorkerTaskStatus[] = ["created", "queued", "retry_queued"];
  const hasQueueable = stepTasks.some((task) => queueable.includes(task.status));
  return !hasQueueable;
}

function hasPlannedWorkAfterBrake(run: RunState): boolean {
  const active = pickPendingAutopilotStep(run);
  if (!active) return false;
  if ((active.kind ?? "worker_batch") !== "worker_batch") return false;
  if ((active.plannedAgents?.length ?? 0) > 0) return true;
  return run.workerTasks.some((task) => {
    if (task.stepId !== active.id) return false;
    return !["accepted", "cancelled"].includes(task.status);
  });
}

function resolveTaskStepId(
  run: RunState,
  requestedStepIndex: number | undefined,
  createdStepIds: string[],
): string | undefined {
  if (run.steps.length === 0) return undefined;

  // Honor the manager's requested stepIndex when both interpretations
  // (one-based step.index match vs zero-based array slot) point to a step
  // the autopilot will actually run. Empirically grok-4.3 has shipped both
  // conventions across versions; if we lock to one, the other interpretation
  // orphans tasks on terminal steps and the autopilot stalls.
  if (typeof requestedStepIndex === "number" && Number.isFinite(requestedStepIndex)) {
    const oneBasedStep = run.steps.find((step) => step.index === requestedStepIndex);
    const zeroBasedStep = run.steps[requestedStepIndex];
    if (oneBasedStep && !isTerminalStepStatus(oneBasedStep.status)) return oneBasedStep.id;
    if (zeroBasedStep && !isTerminalStepStatus(zeroBasedStep.status)) return zeroBasedStep.id;
    // Both interpretations land on terminal steps. Fall through to the
    // pending active step. Completed/skipped steps are immutable: a later
    // chat turn must append a new step, not mutate visible history.
  }

  const activeStep = pickPendingAutopilotStep(run);
  if (activeStep) return activeStep.id;

  const availableStepIds = createdStepIds.length > 0
    ? createdStepIds
    : run.steps
      .filter((step) => !isTerminalStepStatus(step.status))
      .map((step) => step.id);
  return availableStepIds[0];
}

async function maybeReopenCompletedStepForFollowUpTask(
  run: RunState,
  task: SparkManagerTaskDecision,
): Promise<{ run: RunState; stepId: string } | null> {
  const isVerifier = task.taskClass === "verifier";
  // Verifier and corrective follow-ups both need a just-completed impl step
  // reopened. Trivial runs mark the impl step complete before the verifier is
  // queued, so without this the verifier task is dropped and the run ships
  // unverified work.
  if (!isVerifier && !isCorrectiveFollowUpTask(task)) return null;
  let step = resolveRequestedStepIncludingTerminal(run, task.stepIndex);
  if ((!step || step.status !== "complete") && isVerifier) {
    // The manager may omit or mis-index stepIndex on a verifier follow-up.
    // Fall back to the most recently completed worker_batch step so the
    // verifier still lands somewhere instead of being silently dropped.
    step = [...run.steps]
      .filter((s) => s.status === "complete" && (s.kind ?? "worker_batch") === "worker_batch")
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
  }
  if (!step || step.status !== "complete") return null;

  const updated = await commitRunChange(run, {
    type: "spark_manager.completed_step_reopened_for_followup",
    message: `Reopened completed step for verifier follow-up: ${step.title}`,
    stepId: step.id,
    payload: {
      stepId: step.id,
      stepIndex: step.index,
      taskTitle: task.title,
      requestedStepIndex: task.stepIndex,
    },
    mutate: (draft, timestamp) => {
      const target = draft.steps.find((item) => item.id === step.id);
      if (!target) return;
      target.status = "reviewing";
      target.updatedAt = timestamp;
      draft.status = "running";
      draft.currentStepId = target.id;
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
        status: "running",
        lastAction: "reopened_completed_step_for_followup",
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
  });

  return { run: updated, stepId: step.id };
}

function resolveRequestedStepIncludingTerminal(
  run: RunState,
  requestedStepIndex: number | undefined,
): StepState | undefined {
  if (typeof requestedStepIndex !== "number" || !Number.isFinite(requestedStepIndex)) {
    return undefined;
  }

  const candidates: StepState[] = [];
  const oneBasedStep = run.steps.find((step) => step.index === requestedStepIndex);
  const zeroBasedStep = run.steps[requestedStepIndex];
  if (oneBasedStep) candidates.push(oneBasedStep);
  if (zeroBasedStep && zeroBasedStep.id !== oneBasedStep?.id) candidates.push(zeroBasedStep);
  return candidates.find((step) => step.status === "complete") ?? candidates[0];
}

function isCorrectiveFollowUpTask(task: SparkManagerTaskDecision): boolean {
  if (task.taskClass === "verifier") return false;
  const text = [task.title, task.description, ...task.expectedOutputs].join(" ");
  return /\b(corrective|follow[- ]?up|fix|repair|retry|merge|integrate|combine|complete|produce|missing|failed|feedback)\b/i.test(text);
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

async function askHumanQuestion(
  runId: string,
  message: string,
  options?: SparkManagerQuestionOption[],
): Promise<RunState> {
  const run = await addRunMessage({
    runId,
    author: "spark",
    kind: "question",
    message,
    questionOptions: normalizeQuestionOptionsForMessage(message, options),
  });
  return pauseRun({
    runId: run.id,
    reason: HUMAN_INPUT_PAUSE_REASON,
  });
}

function normalizeQuestionOptionsForMessage(
  question: string,
  options: SparkManagerQuestionOption[] | undefined,
): SparkManagerQuestionOption[] {
  const normalized = (options ?? [])
    .slice(0, 3)
    .map((option, index) => ({
      id: option.id?.trim() || `option_${index + 1}`,
      label: option.label?.trim() || `Option ${index + 1}`,
      description: option.description?.trim() || option.answer?.trim() || option.label?.trim() || "",
      answer: option.answer?.trim() || option.label?.trim() || "",
      recommended: option.recommended === true,
    }))
    .filter((option) => option.label && option.answer);
  if (normalized.length >= 3) {
    if (!normalized.some((option) => option.recommended)) normalized[0].recommended = true;
    let seenRecommended = false;
    for (const option of normalized) {
      if (!option.recommended) continue;
      if (!seenRecommended) {
        seenRecommended = true;
        continue;
      }
      option.recommended = false;
    }
    return normalized;
  }
  return fallbackQuestionOptions(question);
}

function fallbackQuestionOptions(question: string): SparkManagerQuestionOption[] {
  const q = question.toLowerCase();
  if (/\b(export|csv|json|field|privacy|user data)\b/.test(q)) {
    return [
      {
        id: "recommended_json_minimal",
        label: "JSON minimal",
        description: "Export only non-sensitive fields as JSON; safest default for implementation.",
        answer: "Use JSON format and export only non-sensitive fields. Do not include private or credential-like data.",
        recommended: true,
      },
      {
        id: "csv_basic",
        label: "CSV basic",
        description: "Use CSV for spreadsheet workflows with a conservative field set.",
        answer: "Use CSV format with a conservative set of non-sensitive fields suitable for spreadsheets.",
        recommended: false,
      },
      {
        id: "ask_full_scope",
        label: "Full export",
        description: "Include a broader export surface; higher privacy and review risk.",
        answer: "Build a broader export flow, but require explicit field allowlisting and avoid sensitive data by default.",
        recommended: false,
      },
    ];
  }
  if (/\b(delete|remove|clean|destructive|wipe|purge)\b/.test(q)) {
    return [
      {
        id: "dry_run",
        label: "Dry run first",
        description: "Inspect and report what would change before deleting anything.",
        answer: "Do a dry run first. Report exactly what would be deleted and wait for approval before destructive changes.",
        recommended: true,
      },
      {
        id: "safe_delete",
        label: "Safe delete",
        description: "Delete only clearly generated/transient items with narrow scope.",
        answer: "Proceed only with safe deletion of clearly generated or transient items inside the requested scope.",
        recommended: false,
      },
      {
        id: "manual_review",
        label: "Manual review",
        description: "Pause and prepare a checklist for me to approve manually.",
        answer: "Prepare a manual review checklist and do not delete anything automatically.",
        recommended: false,
      },
    ];
  }
  return [
    {
      id: "safe_default",
      label: "Safe default",
      description: "Choose the conservative implementation with minimal scope.",
      answer: `Use the safest conservative default for this question: ${question}`,
      recommended: true,
    },
    {
      id: "fast_path",
      label: "Fast path",
      description: "Optimize for speed and a narrow useful result.",
      answer: `Choose the fastest narrow implementation that still satisfies the request: ${question}`,
      recommended: false,
    },
    {
      id: "thorough_path",
      label: "Thorough path",
      description: "Spend more time to cover edge cases and future-proofing.",
      answer: `Choose the more thorough implementation and include relevant edge cases: ${question}`,
      recommended: false,
    },
  ];
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

function shouldRoutePausedResumeToChat(run: RunState): boolean {
  if (run.status !== "paused" && run.status !== "blocked") return false;
  const latest = [...run.humanMessages]
    .reverse()
    .find((message) => message.author === "user" && (message.kind === "note" || message.kind === "answer"));
  return Boolean(latest && parseInlineFileMentionTokens(latest.message).length > 0);
}

function autopilotInputFromRun(run: RunState): StartAutopilotInput {
  const plan = run.planId
    ? run.plans.find((item) => item.id === run.planId)
    : run.plans.at(-1);
  const latestAttemptCwd = run.workerAttempts
    .slice()
    .reverse()
    .find((attempt) => attempt.cwd)?.cwd;
  const savedWorkspaceCwd =
    typeof run.settingsSnapshot?.workspaceCwd === "string"
      ? run.settingsSnapshot.workspaceCwd
      : undefined;
  const latestFileAttachmentDir = run.humanMessages
    .flatMap((message) => message.attachments ?? [])
    .reverse()
    .find((attachment) => attachment.kind === "file")?.path;
  const cwd =
    latestAttemptCwd ||
    savedWorkspaceCwd ||
    (latestFileAttachmentDir ? dirname(latestFileAttachmentDir) : undefined) ||
    (plan?.sourceFile ? dirname(plan.sourceFile) : process.cwd());
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
    // Trust complete-status reports. Workers are full Claude/Codex/Cursor harnesses
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
  const peerCommsDir = join(runDir(runId), "peer-comms");
  const attemptDir = join(runDir(runId), "steps", stepSegment, "workers", workerTaskId, "attempts", attemptId);
  return {
    workerTaskId,
    attemptId,
    attemptDir,
    peerCommsDir,
    peerCommsScript: join(peerCommsDir, "spark-peer-comms.cjs"),
    peerCommsAgents: join(peerCommsDir, "agents.json"),
    taskJson: join(attemptDir, "task.json"),
    promptMd: join(attemptDir, "prompt.md"),
    workpadMd: join(attemptDir, "workpad.md"),
    stdoutLog: join(attemptDir, "stdout.log"),
    stderrLog: join(attemptDir, "stderr.log"),
    rawLog: join(attemptDir, "raw.log"),
    finalReportJson: join(attemptDir, "final-report.json"),
  };
}

const PEER_COMMS_HELPER_SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function parseArgs(tokens) {
  const out = { _: [] };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = tokens[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function usage() {
  return [
    "Spark peer comms",
    "",
    "Commands:",
    "  list  --dir <peer-comms-dir>",
    "  inbox --dir <peer-comms-dir> --self <workerTaskId> [--limit 20] [--unread] [--mark-read]",
    "  send  --dir <peer-comms-dir> --from <workerTaskId> --to <workerTaskId|all> --subject <text> --body <text>",
    "  send  --dir <peer-comms-dir> --from <workerTaskId> --to <workerTaskId|all> --subject <text> --stdin",
    "  reply --dir <peer-comms-dir> --from <workerTaskId> --to <workerTaskId> --reply-to <msgId> --subject <text> --stdin",
    "  await --dir <peer-comms-dir> --self <workerTaskId> [--from <workerTaskId>] [--reply-to <msgId>] [--timeout 120]",
  ].join("\n");
}

function required(args, name) {
  const value = args[name] || process.env["SPARK_" + name.toUpperCase().replace(/-/g, "_")];
  if (!value || value === true) {
    throw new Error("missing --" + name);
  }
  return String(value);
}

function resolveDir(args) {
  const dir = args.dir || process.env.SPARK_PEER_COMMS_DIR || path.dirname(__filename);
  return path.resolve(String(dir));
}

function ensureDir(dir) {
  fs.mkdirSync(path.join(dir, "messages"), { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + "." + Date.now() + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function readStdin() {
  return new Promise((resolve) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => resolve(body.trim()));
    if (process.stdin.isTTY) resolve("");
  });
}

function messageId() {
  return "msg-" + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
}

function readMessages(dir) {
  const messagesDir = path.join(dir, "messages");
  let names = [];
  try {
    names = fs.readdirSync(messagesDir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((name) => readJson(path.join(messagesDir, name), null))
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

function targetMatches(message, self) {
  const to = message.to;
  if (to === "all" || to === self) return true;
  return Array.isArray(to) && to.includes(self);
}

function renderMessage(message) {
  const head = [
    "[" + message.id + "]",
    String(message.createdAt || ""),
    String(message.from || "?") + " -> " + String(message.to || "?"),
    message.replyTo ? "replyTo=" + message.replyTo : "",
  ].filter(Boolean).join(" ");
  const subject = message.subject ? "Subject: " + message.subject + "\n" : "";
  return head + "\n" + subject + String(message.body || "").trim();
}

async function bodyFromArgs(args) {
  if (args.stdin) return await readStdin();
  if (args.body && args.body !== true) return String(args.body);
  if (args._ && args._.length > 0) return args._.join(" ");
  return "";
}

function commandList(dir, args) {
  const registry = readJson(path.join(dir, "agents.json"), { agents: [] });
  const agents = Array.isArray(registry.agents) ? registry.agents : [];
  if (args.json) {
    console.log(JSON.stringify(registry, null, 2));
    return;
  }
  if (agents.length === 0) {
    console.log("No peer agents registered.");
    return;
  }
  for (const agent of agents) {
    const paths = Array.isArray(agent.allowedPaths) && agent.allowedPaths.length
      ? " paths=" + agent.allowedPaths.join(",")
      : "";
    console.log(
      agent.workerTaskId + " | " +
      (agent.runtime || "?") + " | " +
      (agent.status || "?") + " | " +
      (agent.title || agent.label || "untitled") +
      paths
    );
  }
}

function commandInbox(dir, args) {
  const self = required(args, "self");
  const limit = Math.max(1, Number(args.limit || 20));
  const messages = readMessages(dir).filter((message) => targetMatches(message, self));
  const filtered = args.unread
    ? messages.filter((message) => !Array.isArray(message.readBy) || !message.readBy.includes(self))
    : messages;
  const selected = filtered.slice(-limit);
  if (args.json) {
    console.log(JSON.stringify(selected, null, 2));
  } else if (selected.length === 0) {
    console.log("No messages for " + self + ".");
  } else {
    console.log(selected.map(renderMessage).join("\n\n---\n\n"));
  }
  if (args["mark-read"]) {
    for (const message of selected) markRead(dir, message, self);
  }
}

function markRead(dir, message, self) {
  const readBy = Array.isArray(message.readBy) ? message.readBy : [];
  if (readBy.includes(self)) return;
  message.readBy = [...readBy, self];
  writeJsonAtomic(path.join(dir, "messages", message.id + ".json"), message);
}

async function commandSend(dir, args, replyTo) {
  const from = required(args, "from");
  const to = required(args, "to");
  const subject = args.subject && args.subject !== true ? String(args.subject) : "";
  const body = await bodyFromArgs(args);
  if (!body.trim()) throw new Error("message body is empty; pass --body or --stdin");
  const message = {
    id: messageId(),
    createdAt: new Date().toISOString(),
    from,
    to,
    subject,
    body,
    replyTo: replyTo || null,
    readBy: [],
  };
  writeJsonAtomic(path.join(dir, "messages", message.id + ".json"), message);
  console.log(message.id);
}

async function commandAwait(dir, args) {
  const self = required(args, "self");
  const from = args.from && args.from !== true ? String(args.from) : null;
  const replyTo = args["reply-to"] && args["reply-to"] !== true ? String(args["reply-to"]) : null;
  const timeoutSeconds = Math.max(1, Number(args.timeout || 120));
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() <= deadline) {
    const messages = readMessages(dir).filter((message) => targetMatches(message, self));
    const match = messages.find((message) => {
      if (from && message.from !== from) return false;
      if (replyTo && message.replyTo !== replyTo) return false;
      if (Array.isArray(message.readBy) && message.readBy.includes(self)) return false;
      return true;
    });
    if (match) {
      console.log(args.json ? JSON.stringify(match, null, 2) : renderMessage(match));
      markRead(dir, match, self);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.error("Timed out waiting for peer message.");
  process.exitCode = 2;
}

async function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  const dir = resolveDir(args);
  ensureDir(dir);
  if (command === "list") return commandList(dir, args);
  if (command === "inbox") return commandInbox(dir, args);
  if (command === "send") return await commandSend(dir, args, null);
  if (command === "reply") return await commandSend(dir, args, required(args, "reply-to"));
  if (command === "await") return await commandAwait(dir, args);
  throw new Error("unknown command: " + command + "\n\n" + usage());
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
`;

interface PeerCommsAgentCard {
  workerTaskId: string;
  attemptId?: string;
  label?: string;
  title: string;
  runtime: WorkerRuntime;
  taskClass?: WorkerTask["taskClass"];
  status: string;
  canRunParallel: boolean;
  allowedPaths: string[];
  forbiddenPaths: string[];
  expectedOutputs: string[];
  updatedAt: string;
}

async function ensurePeerCommsArtifacts(
  run: RunState,
  step: StepState | undefined,
  task: WorkerTask,
  attemptId: string,
  paths: WorkerArtifactPaths,
  status: string,
): Promise<void> {
  if (!paths.peerCommsDir || !paths.peerCommsScript || !paths.peerCommsAgents) return;
  await fs.mkdir(join(paths.peerCommsDir, "messages"), { recursive: true });
  await writeFileAtomic(paths.peerCommsScript, PEER_COMMS_HELPER_SCRIPT);
  await updatePeerCommsRegistry(run, step, task, attemptId, paths, status);
}

async function updatePeerCommsRegistry(
  run: RunState,
  step: StepState | undefined,
  currentTask: WorkerTask,
  attemptId: string,
  paths: WorkerArtifactPaths,
  status: string,
): Promise<void> {
  if (!paths.peerCommsAgents) return;
  const timestamp = new Date().toISOString();
  const stepTaskIds = new Set(step?.workerTaskIds ?? []);
  const peers = run.workerTasks.filter((task) => {
    if (currentTask.stepId && task.stepId === currentTask.stepId) return true;
    if (stepTaskIds.has(task.id)) return true;
    return task.id === currentTask.id;
  });
  const cards: PeerCommsAgentCard[] = peers.map((peer) => {
    const latestAttempt = run.workerAttempts
      .slice()
      .reverse()
      .find((attempt) => attempt.workerTaskId === peer.id);
    const planned = step?.plannedAgents?.find(
      (agent) =>
        agent.summary === peer.description ||
        agent.label === peer.title ||
        agent.label?.toLowerCase() === peer.title.toLowerCase(),
    );
    return {
      workerTaskId: peer.id,
      attemptId: peer.id === currentTask.id ? attemptId : latestAttempt?.id,
      label: planned?.label,
      title: peer.title,
      runtime: peer.runtimePreference,
      taskClass: peer.taskClass,
      status: peer.id === currentTask.id ? status : latestAttempt?.status ?? peer.status,
      canRunParallel: peer.canRunParallel,
      allowedPaths: peer.allowedPaths,
      forbiddenPaths: peer.forbiddenPaths,
      expectedOutputs: peer.expectedOutputs,
      updatedAt: peer.id === currentTask.id ? timestamp : peer.updatedAt,
    };
  });
  const registry = {
    version: 1,
    runId: run.id,
    stepId: currentTask.stepId,
    stepTitle: step?.title,
    updatedAt: timestamp,
    agents: cards,
  };
  await writeFileAtomic(paths.peerCommsAgents, JSON.stringify(registry, null, 2));
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
  // claude/codex/cursor paint at the correct width from the very first frame.
  await pty.waitForResize(attemptId, 5_000);

  // Mirror the worker's pty byte stream to raw.log so a hung worker is
  // debuggable after the fact. Without this, the only on-disk evidence of
  // what the agent CLI printed lives in the renderer's xterm.js scrollback —
  // which doesn't exist in headless eval mode and is wiped when an
  // interactive pane is closed.
  const rawStream = createWriteStream(paths.rawLog, { flags: "a" });
  let fatalErrorTimer: NodeJS.Timeout | undefined;
  let fatalErrorBuffer = "";
  const offRawTap = pty.tap(attemptId, (chunk) => {
    try {
      rawStream.write(chunk);
    } catch {
      /* best-effort; never let logging break the run loop */
    }
    fatalErrorBuffer = (fatalErrorBuffer + chunk.toString("utf8")).slice(-8192);
    const fatalReason = detectFatalWorkerRuntimeError(fatalErrorBuffer, task.runtimePreference);
    if (fatalReason && !fatalErrorTimer) {
      fatalErrorTimer = setTimeout(() => {
        void (async () => {
          await recordWorkerOutput(
            run,
            task,
            attemptId,
            paths,
            "stderr",
            `\n[spark] detected worker runtime failure: ${fatalReason}\n`,
          );
          await writeAutoFailureReport(paths, task, fatalReason);
          pty.dispose(attemptId);
          failFast(fatalReason);
        })();
      }, 2500);
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
  const step = run.steps.find((item) => item.id === task.stepId);
  if (shouldUsePeerComms(run, step, task)) {
    await updatePeerCommsRegistry(run, step, task, attemptId, paths, "running")
      .catch(() => undefined);
  }

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
    // Separate guard for the kill so the funnel through finish() is idempotent
    // even if some path also tries to kill directly. Without this, early-resolve
    // paths (hardTimeout, failFast) leaked the pwsh + agent CLI tree (200-500MB)
    // until app quit because finish() resolved without disposing the pty.
    let killed = false;
    const killWorkerTree = (): void => {
      if (killed) return;
      killed = true;
      try { pty.killImmediate(attemptId); } catch { /* idempotent */ }
      try { handle.kill?.(); } catch { /* defensive; pty.dispose may have already fired */ }
    };
    const finish = (value: { exitCode: number; error?: string }) => {
      if (settled) return;
      settled = true;
      // Tear down the worker tree BEFORE resolving so callers awaiting
      // exitPromise observe a fully cleaned-up worker. killImmediate is a
      // no-op if the pty already exited via offExit, so success paths cost
      // nothing.
      killWorkerTree();
      offExit();
      offRawTap();
      rawStream.end();
      clearInterval(reportPoll);
      clearTimeout(hardTimeout);
      if (fatalErrorTimer) clearTimeout(fatalErrorTimer);
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
      // Belt-and-braces: kill here too in case finish() is ever refactored to
      // not own the teardown. The `killed` guard makes the inner call in
      // finish() a no-op.
      killWorkerTree();
      finish({ exitCode: 1, error: "Worker timed out after 90 minutes." });
    }, 90 * 60 * 1000);
    failFast = (reason: string) => {
      killWorkerTree();
      finish({ exitCode: 1, error: reason });
    };
  });

  // Stagger launch + prompt the same way the TEST CLAUDE button does:
  //  1. wait 1.5s for pwsh to render its prompt,
  //  2. type `claude --dangerously-skip-permissions ...\r`,
  //  3. sniff pty output for the agent's TUI banner (claude/codex/cursor), with a
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
        if (task.runtimePreference === "codex") {
          await waitForCodexInputReady(attemptId);
        } else if (task.runtimePreference === "cursor") {
          await waitForCursorInputReady(attemptId);
        }
      }
      const submitted = await pasteAndSubmit(attemptId, handle, promptText, task.runtimePreference);
      if (!submitted) {
        await recordWorkerOutput(
          run,
          task,
          attemptId,
          paths,
          "stderr",
          `\n[spark] ${task.runtimePreference} accepted the pasted prompt but never started a turn ` +
            `after repeated submit attempts — the CLI dropped the Enter keystroke during TUI startup.\n`,
        );
        await writeAutoFailureReport(
          paths,
          task,
          "agent CLI did not begin the task after the prompt was submitted (submit keystroke dropped during TUI startup)",
        );
        failFast(`${task.runtimePreference} CLI did not start the task after prompt submission`);
        return;
      }
    } catch (err) {
      await recordWorkerOutput(run, task, attemptId, paths, "stderr",
        `\n[spark] failed to drive worker pane: ${(err as Error).message}\n`);
    }
  })();

  const result = await exitPromise;
  activeWorkerProcesses.delete(attemptId);
  return result;
}

// Pre-compiled ANSI escape strippers. Worker pty taps run these on every
// data chunk (multiple taps per worker × up to N concurrent workers × tens
// of chunks/sec). Hoisting the regex literals out of the hot path saves the
// per-chunk recompilation cost.
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07]*\x07/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI_RE, "").replace(ANSI_OSC_RE, "");
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
  // Markers that indicate the CLI's TUI is running. Claude, codex, and cursor
  // each emit their model name on first paint, plus Ink/React-CLI specific
  // frames. We also look for the "bypass permissions" banner claude prints
  // with our launch flag, codex's "/help" or "Pasted Content" hints, and
  // cursor's "Cursor Agent" / "Composer 2.5 Fast" banner.
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
  const cursorMarkers = [
    "Cursor Agent",
    "Composer 2.5 Fast",
    "Plan, search, build anything",
    "Add a follow-up",
  ];
  const markers =
    runtime === "codex" ? codexMarkers : runtime === "cursor" ? cursorMarkers : claudeMarkers;
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
  const timeoutMs = runtime === "codex" ? 12_000 : runtime === "cursor" ? 10_000 : 9_000;

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
      const visible = stripAnsi(buffer);
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

async function waitForCodexInputReady(attemptId: string): Promise<void> {
  // Codex paints its model banner before it finishes MCP-server startup. If
  // Spark bracket-pastes the worker prompt during that startup window, some
  // Codex TUI builds drop the paste/submit and sit forever at the prompt.
  //
  // The placeholder/suggestion strings rotate and change between Codex
  // releases, so matching them is unreliable on its own (the old fixed list
  // matched nothing on v0.131.0 and this wait silently degraded to a blind
  // 18s timeout). The robust signal is the "Starting MCP servers (N/5)" line:
  // it repaints every spinner frame while servers boot and stops once they
  // are up. We treat Codex as input-ready when that line has gone quiet for
  // QUIET_MS, or when a known input-placeholder marker appears, whichever is
  // first — with a hard cap so a build that prints neither still proceeds.
  const readyMarkers = [
    "Write tests for",
    "Explain this codebase",
    "Summarize recent",
    "Ask about this codebase",
    "What should I work on",
    "Run /review",
    "Fix a bug",
    "/help for",
  ];
  const HARD_CAP_MS = 30_000;
  const QUIET_MS = 2_500;
  const NO_MCP_GRACE_MS = 4_000;
  await new Promise<void>((resolve) => {
    let settled = false;
    let buffer = "";
    let sawMcpStartup = false;
    let lastMcpSeen = 0;
    const startedAt = Date.now();
    const finish = () => {
      if (settled) return;
      settled = true;
      offTap();
      clearInterval(poll);
      clearTimeout(cap);
      resolve();
    };
    const offTap = pty.tap(attemptId, (chunk) => {
      // Check THIS chunk for the MCP line — once it stops being repainted,
      // lastMcpSeen stops advancing and the poll below detects quiescence.
      const text = stripAnsi(chunk.toString("utf8"));
      if (/Starting MCP servers/i.test(text)) {
        sawMcpStartup = true;
        lastMcpSeen = Date.now();
      }
      buffer = (buffer + text).slice(-8192);
      if (readyMarkers.some((marker) => buffer.includes(marker))) finish();
    });
    const poll = setInterval(() => {
      const now = Date.now();
      if (sawMcpStartup && now - lastMcpSeen >= QUIET_MS) finish();
      // No MCP-startup line ever appeared — Codex has no servers configured
      // or finished before we tapped; give it a short grace then proceed.
      else if (!sawMcpStartup && now - startedAt >= NO_MCP_GRACE_MS) finish();
    }, 250);
    const cap = setTimeout(finish, HARD_CAP_MS);
  });
  await delay(400);
}

async function waitForCursorInputReady(attemptId: string): Promise<void> {
  // Cursor TUI paints its banner + footer ("Composer 2.5 Fast … main") before
  // the input box is fully ready to accept a bracketed paste. Empirically the
  // banner is up by ~3s after spawn. We watch for the input-placeholder
  // marker "Plan, search, build anything" (initial) or the footer's "Composer"
  // model line, then add a small settle delay. Hard cap at 20s so a slow
  // network startup still proceeds.
  const readyMarkers = [
    "Plan, search, build anything",
    "Add a follow-up",
    "Composer 2.5 Fast",
  ];
  const HARD_CAP_MS = 20_000;
  const SETTLE_MS = 600;
  await new Promise<void>((resolve) => {
    let settled = false;
    let buffer = "";
    const finish = () => {
      if (settled) return;
      settled = true;
      offTap();
      clearTimeout(cap);
      resolve();
    };
    const offTap = pty.tap(attemptId, (chunk) => {
      buffer = (buffer + stripAnsi(chunk.toString("utf8"))).slice(-8192);
      if (readyMarkers.some((marker) => buffer.includes(marker))) finish();
    });
    const cap = setTimeout(finish, HARD_CAP_MS);
  });
  await delay(SETTLE_MS);
}

function detectFatalWorkerRuntimeError(
  buffer: string,
  runtime: WorkerTask["runtimePreference"],
): string | null {
  if (runtime !== "claude" && runtime !== "codex" && runtime !== "cursor") return null;
  const visible = stripAnsi(buffer);
  const checks: Array<[RegExp, string]> = [
    [/API Error:.*socket connection was closed unexpectedly/i, "runtime API error: socket connection closed unexpectedly"],
    [/API Error:/i, "runtime API error before final report"],
    [/socket connection was closed unexpectedly/i, "runtime API error: socket connection closed unexpectedly"],
    [/fetch\(\)/i, "runtime network fetch failure before final report"],
    [/rate limit/i, "runtime rate limit before final report"],
    [/overloaded|temporarily unavailable/i, "runtime temporarily unavailable before final report"],
  ];
  for (const [pattern, reason] of checks) {
    if (pattern.test(visible)) return reason;
  }
  return null;
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
    summary: `Spark could not complete the ${task.runtimePreference} CLI worker for this task: ${reason}.`,
    filesChanged: [],
    commandsRun: [],
    tests: [],
    proof: [],
    risks: [
      `${task.runtimePreference} CLI failed before producing a final report: ${reason}. Verify it is installed, logged in, reachable, and the model id is valid.`,
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
  attemptId: string,
  handle: { write: (input: string) => void },
  promptText: string,
  runtime: WorkerTask["runtimePreference"],
): Promise<boolean> {
  const body = promptText.replace(/\r\n?/g, "\n").trim();
  if (!body) return true;
  if (runtime === "claude" || runtime === "codex" || runtime === "cursor") {
    const PASTE_BEGIN = "\x1b[200~";
    const PASTE_END = "\x1b[201~";

    // Watch the worker's pty so we can CONFIRM the prompt was submitted
    // instead of firing a fixed number of Enters and hoping. Codex drops the
    // submit keystroke when a large bracketed paste lands while its TUI is
    // still settling, leaving the prompt visible-but-unsent — that hangs the
    // whole run until the 90-minute watchdog. The agent has started its turn
    // once it paints a working/interrupt indicator or its context usage
    // moves off 0%. Cursor's working indicator is the "Composing" line plus
    // "ctrl+c to stop" in the follow-up footer. The tap is installed now
    // (input is idle post-startup) so no stale "esc to interrupt" from the
    // startup phase is captured.
    let visible = "";
    const offTap = pty.tap(attemptId, (chunk) => {
      visible = (visible + stripAnsi(chunk.toString("utf8"))).slice(-6000);
    });
    const startedTurn = (): boolean =>
      /esc to interrupt/i.test(visible) ||
      /Context\s+[1-9][0-9]?%\s+used/i.test(visible) ||
      /\btokens used\b/i.test(visible) ||
      /\bComposing\b/.test(visible) ||
      /ctrl\+c to stop/i.test(visible) ||
      /Composer\s+2\.5\s+Fast\s+·\s+[0-9]+(?:\.[0-9]+)?%/i.test(visible);

    try {
      handle.write(PASTE_BEGIN);
      await delay(25);
      handle.write(body);
      await delay(25);
      handle.write(PASTE_END);
      // Let the TUI commit the bracketed paste into its input box before the
      // first Enter — submitting mid-commit leaves the prompt unsent.
      await delay(promptSubmitSettleMs(runtime, body.length));

      // Press Enter, then verify the agent actually started a turn. If it
      // didn't, the keystroke was dropped (paste still settling, TUI busy) —
      // press again. Extra Enters once the agent is already working are
      // harmless newlines typed into an empty input box.
      const maxAttempts = 22;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        handle.write("\r");
        const deadline = Date.now() + 2200;
        while (Date.now() < deadline) {
          if (startedTurn()) return true;
          await delay(150);
        }
      }
      // Codex is the runtime with the known dropped-submit failure mode, so
      // surface a never-started turn as a hard failure (fast watchdog)
      // rather than hanging. Claude's submit path has been reliable; if our
      // detector simply did not recognise its working banner, don't
      // false-fail the worker — proceed and let the report watchdog decide.
      return runtime === "codex" ? startedTurn() : true;
    } finally {
      offTap();
    }
  }
  // Manual / shell runtimes: just dump the prompt as text into pwsh as a
  // here-string comment so the user can read it. They drive the work
  // themselves and write the final-report.json by hand.
  handle.write(`# Prompt:\r`);
  for (const line of body.split("\n")) {
    handle.write(`# ${line}\r`);
  }
  return true;
}

function promptSubmitSettleMs(
  runtime: WorkerTask["runtimePreference"],
  promptLength: number,
): number {
  const sizeCost = Math.ceil(promptLength / 2048) * 150;
  if (runtime === "claude") return clamp(1800 + sizeCost, 1800, 5000);
  if (runtime === "codex") return clamp(1200 + sizeCost, 1200, 4500);
  if (runtime === "cursor") return clamp(900 + sizeCost, 900, 4000);
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
  // Pin the shell to the workspace directory before the agent CLI starts.
  // The pty is spawned with cwd=workspaceCwd, but the user's $PROFILE
  // (PowerShell, bash, zsh) frequently includes a `Set-Location $HOME` /
  // `cd ~` that moves the shell away before we type the launch command.
  // The agent CLI inherits cwd from the shell, so without this prefix the
  // worker ends up running in the user's home directory instead of the
  // workspace. `cd` works as an alias / built-in in pwsh, bash, zsh and cmd.
  const cdPrefix =
    cwd && cwd.trim().length > 0 ? `cd ${quoteShellArg(cwd)}; ` : "";

  if (task.runtimePreference === "claude") {
    const args = ["claude", "--dangerously-skip-permissions"];
    if (task.modelHint?.trim()) args.push("--model", quoteShellArg(task.modelHint.trim()));
    const claudeEffort = mapClaudeEffort(task.effortHint);
    if (claudeEffort) args.push("--effort", claudeEffort);
    return cdPrefix + args.join(" ");
  }
  if (task.runtimePreference === "codex") {
    // codex >= v0.128 ignores the older `-c projects."<abs>".trust_level=...`
    // override at the command line — it requires an exact-path match in the
    // saved config.toml against codex's own normalized cwd (lowercase,
    // backslash). We write that entry from launchWorkerAttempt before
    // spawning, so by the time codex --yolo starts, the directory is already
    // trusted and the prompt is skipped silently.
    const args = ["codex", "--yolo"];
    if (task.modelHint?.trim()) args.push("-m", quoteShellArg(task.modelHint.trim()));
    const codexEffort = mapCodexEffort(task.effortHint);
    if (codexEffort) args.push("-c", quoteShellArg(`model_reasoning_effort=${codexEffort}`));
    return cdPrefix + args.join(" ");
  }
  if (task.runtimePreference === "cursor") {
    // Cursor CLI: `agent --yolo --model <id>`. The `--trust` flag is rejected
    // in interactive mode (it is only valid with `--print`), and Cursor does
    // not expose reasoning-effort levels, so effortHint is ignored here.
    //
    // We dispatch through the .cmd shim by its absolute path instead of typing
    // bare "agent". Reason: pwsh resolves bare "agent" to agent.ps1 (an
    // ExternalScript), which runs IN THE PARENT pwsh process — that process
    // has the user's $PROFILE loaded, including any PreCommandLookupAction
    // hook (e.g. lazy-load Terminal-Icons on Get-ChildItem). agent.ps1 calls
    // Get-ChildItem internally to find its version dir, triggers the hook,
    // and floods the pane with red Import-PowerShellDataFile errors before
    // the Cursor banner even appears. agent.cmd instead spawns a FRESH
    // powershell.exe with -NoProfile, so the user's profile hooks never run.
    const localAppData = process.env.LOCALAPPDATA;
    const cmdPath = localAppData
      ? join(localAppData, "cursor-agent", "agent.cmd")
      : "agent";
    // PowerShell parses a bare quoted string as an expression and reads
    // `--yolo` as the decrement operator. The `&` call operator tells pwsh
    // "this quoted string is a command path, invoke it". Skip the prefix
    // only when we fall back to bare "agent" (an unquoted Get-Command name).
    const head = localAppData ? `& ${quoteShellArg(cmdPath)}` : "agent";
    const args = [head, "--yolo"];
    const modelId = task.modelHint?.trim() || "composer-2.5-fast";
    args.push("--model", quoteShellArg(modelId));
    return cdPrefix + args.join(" ");
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
// Process-local set of (configPath -> Set<tomlKey>) we've already verified
// during this Spark session. The first worker spawn in a given cwd does the
// read-modify-write under the lock; every subsequent spawn in the same cwd
// short-circuits without touching the filesystem, eliminating the per-spawn
// lock wait under high concurrency. Cleared on app restart, so a codex
// upgrade that invalidates the trust format is picked up next launch.
const codexTrustedCwds = new Map<string, Set<string>>();
async function ensureCodexProjectTrust(cwd: string): Promise<void> {
  if (!cwd) return;
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  if (!homeDir) return;
  const configPath = join(homeDir, ".codex", "config.toml");
  const tomlKey = cwd.toLowerCase().replace(/\//g, "\\");
  const cached = codexTrustedCwds.get(configPath);
  if (cached?.has(tomlKey)) return;
  const prior = codexConfigLocks.get(configPath) ?? Promise.resolve();
  const next = prior.then(() => writeCodexProjectTrustEntry(configPath, cwd)).catch(() => undefined);
  codexConfigLocks.set(configPath, next);
  await next;
  if (codexConfigLocks.get(configPath) === next) {
    codexConfigLocks.delete(configPath);
  }
  const set = codexTrustedCwds.get(configPath) ?? new Set<string>();
  set.add(tomlKey);
  codexTrustedCwds.set(configPath, set);
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

// Cursor's interactive TUI rejects --trust (only valid with --print) and so
// prompts for workspace trust on every fresh cwd. The CLI persists trust as
// a sentinel file at ~/.cursor/projects/<encoded-cwd>/.workspace-trusted
// where <encoded-cwd> replaces ':' and '\' and '/' with '-'. Spark writes
// this file before spawning the worker so node-pty never sees the prompt.
// Trust grants are per-cwd, so an eval that materializes 500 fresh repos
// would otherwise need 500 human clicks; this writes them all in one place.
const cursorTrustedCwds = new Set<string>();
async function ensureCursorProjectTrust(cwd: string): Promise<void> {
  if (!cwd) return;
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  if (!homeDir) return;
  if (cursorTrustedCwds.has(cwd)) return;
  // Cursor encodes the path by stripping the drive colon and converting
  // every path separator to '-'. Example: "C:\Users\Etienne\Documents\workspace\test"
  // → "C-Users-Etienne-Documents-workspace-test". Forward slashes also
  // collapse to '-' so paths normalized either way produce the same key.
  const encoded = cwd.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const projectDir = join(homeDir, ".cursor", "projects", encoded);
  const trustFile = join(projectDir, ".workspace-trusted");
  try {
    // If the marker is already there, nothing to do — just remember it.
    await fs.access(trustFile);
    cursorTrustedCwds.add(cwd);
    return;
  } catch {
    /* not yet trusted — write it below */
  }
  try {
    await fs.mkdir(projectDir, { recursive: true });
    const payload = JSON.stringify(
      { trustedAt: new Date().toISOString(), workspacePath: cwd },
      null,
      2,
    );
    await fs.writeFile(trustFile, payload, "utf8");
    cursorTrustedCwds.add(cwd);
  } catch {
    /* swallow — the worst case is the user gets the trust prompt once */
  }
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

function mapCodexEffort(effort: WorkerTask["effortHint"] | undefined): string | null {
  if (!effort) return null;
  if (effort === "minimal" || effort === "max") return effort === "minimal" ? "low" : "xhigh";
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh") return effort;
  return "medium";
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

function quotePwshString(value: string): string {
  return `"${value.replace(/`/g, "``").replace(/"/g, '`"')}"`;
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
  run,
  step,
  task,
  paths,
  settings,
}: {
  cwd: string;
  run: RunState;
  step?: StepState;
  task: WorkerTask;
  paths: WorkerArtifactPaths;
  settings: AppSettings;
}): string {
  if (task.taskClass === "verifier") {
    return renderVerifierWorkerPrompt({ cwd, run, step, task, paths, settings });
  }
  return renderImplementationWorkerPrompt({ cwd, run, step, task, paths, settings });
}

function taskContextText(step: StepState | undefined, task: WorkerTask): string {
  return [
    task.title,
    task.description,
    task.taskClass ?? "",
    step?.title ?? "",
    step?.goal ?? "",
    ...(step?.acceptanceCriteria ?? []),
    ...(task.expectedOutputs ?? []),
    ...(task.verificationCommands ?? []),
  ].join("\n");
}

function shouldOfferRuntimeDelegation(step: StepState | undefined, task: WorkerTask): boolean {
  const text = taskContextText(step, task);
  if (/\b(subagent|sub-agent|delegate|delegation|agent team|worktree|parallel probes?|independent probes?)\b/i.test(text)) {
    return true;
  }
  if (/\b(recon|explor|investigat|triage|large files?|logs?|summari[sz]e|second opinion|independent review)\b/i.test(text)) {
    return true;
  }
  if (task.taskClass === "verifier") {
    return task.verificationCommands.length > 2 || /\b(complex|subtle|broad|cross-module|multi-file)\b/i.test(text);
  }
  return false;
}

function shouldRenderAgentSyncPromptLines(step: StepState | undefined, task: WorkerTask): boolean {
  return /\b(mcp|skill|playwright|browser|screenshot|web search|github|figma|notion|railway|runpod|openai docs|image|vision|pdf|spreadsheet|presentation|document)\b/i.test(
    taskContextText(step, task),
  );
}

function shouldUsePeerComms(
  run: RunState,
  step: StepState | undefined,
  task: WorkerTask,
): boolean {
  if (!step || !task.canRunParallel) return false;
  const peerTasks = run.workerTasks.filter((item) => item.stepId === task.stepId && item.id !== task.id);
  const plannedPeerCount = Math.max(0, (step.plannedAgents?.length ?? 0) - 1);
  if (peerTasks.length + plannedPeerCount <= 0) return false;

  const text = taskContextText(step, task);
  if (task.taskClass === "verifier") {
    return /\b(peer|parallel|disagreement|other runtime|same surface|second verifier)\b/i.test(text);
  }
  return /\b(shared|interface|contract|api|schema|integrat|consume|producer|provider|handoff|merge|combine|staging|coordinate|collision|conflict|depends|dependency|same file|data hook|dom hook)\b/i.test(
    text,
  );
}

function renderRuntimeDelegationGuidance(task: WorkerTask): string[] {
  const isVerifier = task.taskClass === "verifier";

  if (task.runtimePreference === "claude") {
    const lines = [
      "Spark is the top-level orchestrator. You may use Claude Code native subagents, agent teams, or worktrees only when they materially reduce your context load or improve independent checking.",
      "- Good uses: bounded read-heavy exploration, test/log triage, summarizing large files, or independent review probes with a clear return format.",
      "- Do not create a nested implementation team for ordinary write work. Spark owns cross-worker coordination and parallel write planning.",
      "- Keep delegated results compact: ask for distilled findings, file/line references, commands run, and uncertainties. Do not paste raw logs back into your own context.",
      "- If you use subagents, agent teams, or worktrees, your final report must list each one's purpose, scope, and distilled findings.",
    ];
    if (isVerifier) {
      lines.push(
        "- This is a verifier task: every delegated probe must be read-only, and any worktree usage must not edit, commit, merge, or push.",
      );
    } else {
      lines.push(
        "- Use worktrees only for explicitly isolated experiments or disjoint write scopes. Do not merge, commit, push, or overwrite another worker's changes unless this task explicitly requires it.",
      );
    }
    return lines;
  }

  if (task.runtimePreference === "codex") {
    const lines = [
      "Spark explicitly permits Codex subagents for this task when they are bounded, useful, and mostly read-only.",
      "- Good uses: codebase exploration, tests/log triage, independent review, summarizing large files, or checking a narrow hypothesis.",
      "- Give each subagent a concrete job, clear limits, and the exact return format you need. Wait for the result and synthesize disagreements yourself.",
      "- Do not spawn subagents for every small task. Keep the main path local when the next action depends on the answer.",
      "- Avoid write-heavy parallel subagents unless scopes are isolated and disjoint. Spark owns top-level parallelism and cross-worker coordination.",
      "- If you use subagents, your final report must list each subagent's purpose, scope, and distilled findings.",
    ];
    if (isVerifier) {
      lines.push("- This is a verifier task: subagents must be read-only and must not edit files or mutate repository state.");
    }
    return lines;
  }

  return [];
}

function renderPeerCommsGuidance(task: WorkerTask, paths: WorkerArtifactPaths): string[] {
  if (!paths.peerCommsDir || !paths.peerCommsScript) return [];
  const script = quotePwshString(paths.peerCommsScript);
  const dir = quotePwshString(paths.peerCommsDir);
  const self = quotePwshString(task.id);
  return [
    "Spark may be running several Claude/Codex/Cursor workers for this same step. Use this mailbox when direct peer coordination would prevent duplicated work, clarify an interface, share a narrow finding, or ask for a second opinion.",
    "This is a run artifact mailbox, not the project source tree; using it is allowed even for read-only verifier tasks.",
    "If your task defines or consumes a shared interface/contract that another peer may depend on, send one short contract note to `all` before editing and check your inbox once before finalizing.",
    `List peers: node ${script} list --dir ${dir}`,
    `Read your inbox: node ${script} inbox --dir ${dir} --self ${self} --limit 10 --mark-read`,
    "Send a peer message from PowerShell:",
    "```powershell",
    "@'",
    "Short question or finding. Keep it under 300 words. Include exact files/commands when useful.",
    "'@ | node " + script + " send --dir " + dir + " --from " + self + " --to \"<peer_worker_task_id|all>\" --subject \"<topic>\" --stdin",
    "```",
    "Reply to a peer message:",
    "```powershell",
    "@'",
    "Short answer with evidence or uncertainty.",
    "'@ | node " + script + " reply --dir " + dir + " --from " + self + " --to \"<sender_worker_task_id>\" --reply-to \"<msg_id>\" --subject \"Re: <topic>\" --stdin",
    "```",
    `Wait briefly for a reply: node ${script} await --dir ${dir} --self ${self} --reply-to "<msg_id>" --timeout 120`,
    "- Shared contracts must come from the task spec, not from invention. If your contract note conflicts with a peer's note, reconcile the conflict before finalizing or report `partial` with the exact conflict in `risks[]`.",
    "- Before your final report on any shared-interface task, read your inbox with `--mark-read` and include a short `proof[]` entry naming the mailbox command and the contract you accepted.",
    "- If your slice consumes another worker's output, run a small integration probe when possible. If the peer file is not ready yet, wait briefly once; if still unavailable, state that risk instead of claiming the cross-file contract is proven.",
    "- Do not wait indefinitely. If no peer replies within about 2 minutes, continue with the safest explicit assumption and mention it in `risks[]`.",
    "- Summarize any material peer input in `proof[]`, `risks[]`, or `followups[]`; do not paste long mailbox transcripts into the final report.",
  ];
}

function taskLooksLikeVisibleUi(step: StepState | undefined, task: WorkerTask): boolean {
  const text = [
    task.title,
    task.description,
    step?.title ?? "",
    step?.goal ?? "",
    ...(step?.acceptanceCriteria ?? []),
    ...(task.expectedOutputs ?? []),
  ].join(" ");
  return /\b(ui|ux|frontend|front-end|html|css|page|screen|component|layout|form|button|modal|view|visual|design|calculator|dashboard|professional\s+ui|polished)\b/i.test(
    text,
  );
}

function taskLooksLikeCalculator(step: StepState | undefined, task: WorkerTask): boolean {
  const text = [
    task.title,
    task.description,
    step?.title ?? "",
    step?.goal ?? "",
    ...(step?.acceptanceCriteria ?? []),
    ...(task.expectedOutputs ?? []),
  ].join(" ");
  return /\b(calculator|calculate|arithmetic|keypad|numeric input)\b/i.test(text);
}

function renderUiQualityGuidance(step: StepState | undefined, task: WorkerTask): string[] {
  if (!taskLooksLikeVisibleUi(step, task)) {
    return [];
  }
  const lines = [
    "- Treat words like `nice`, `polished`, and `professional` as concrete UI requirements: semantic structure, accessible names or live regions for dynamic values, keyboard/focus states, hover/active states, responsive sizing, and no text/layout overlap at mobile or desktop widths.",
    "- For a standalone HTML deliverable, include a viewport meta tag, a `<main>` landmark, self-contained CSS/JS when the task asks for one file, and no external assets unless the task explicitly allows them.",
    "- For calculators or expression-like inputs, use explicit state/event handling. Do not use `eval()` or `new Function()`.",
    "- Do not leave decorative-but-dead UI: every visible control, display region, history strip, tab, toggle, badge, and data-* hook must be wired to real behavior or removed.",
    "- Avoid visible instructional copy that explains basic usage or keyboard shortcuts inside the app; make the interface self-evident through controls, labels, focus, and affordances.",
    "- Include a deliberate empty/loading/error/success state only when it can actually occur; otherwise do not style unreachable states as if they were product features.",
    "- Before reporting `complete`, run or construct a UI smoke probe. At minimum, prove the final file has the expected controls, no accidental external refs, no `eval`/`new Function`, and that the primary user flow updates the visible DOM/state.",
    "- Include file:line evidence for the main markup, core styles, event wiring, and any dynamic display updates in `proof[]`.",
  ];
  if (taskLooksLikeCalculator(step, task)) {
    lines.push(
      "- Calculator quality floor: include visible controls for clear, decimal, the four basic operators, equals, and a correction path such as backspace or CE. For a `professional` calculator, consider percent and sign toggle unless the plan explicitly rules them out.",
      "- Calculator operator labels must be unambiguous and probe-friendly: use `+`, `-`, `×` or `*`, `÷` or `/`, and `=` visibly on the buttons. Do not use a plain `x` as the only multiplication signal.",
      "- Calculator probes must cover: basic arithmetic, decimal arithmetic (`0.1 + 0.2` display), divide-by-zero handling and recovery, repeated equals, chained operations, keyboard input, correction/backspace behavior, and focus double-activation guards.",
      "- Calculator focus probes must include: after pointer-clicking clear, pressing keys `7`, `/`, `2`, `Enter` displays `3.5`; after clicking `2`, `+`, `3`, focusing equals and pressing `Enter` executes exactly once and stays `5`; focusing clear and pressing `Enter` clears to `0`; any focused button activated by `Enter`/Space must run that button's action exactly once instead of the global shortcut; null/undefined/empty key values are ignored.",
      "- A history or expression line is good only if it is updated by the logic; an empty static history strip is a quality failure.",
    );
  }
  return lines;
}

function renderUiVerifierGuidance(step: StepState | undefined, task: WorkerTask): string[] {
  if (!taskLooksLikeVisibleUi(step, task)) return [];
  const lines = [
    "## UI / FRONTEND 10/10 VERIFICATION",
    "- Judge the finished artifact as a product, not as a code sample. A pass requires behavior, accessibility, responsive layout, and visual/interaction polish.",
    "- Inspect the final user-facing files directly. Verify there are no leftover staging directories/files in the user workspace unless the plan explicitly asked for them.",
    "- Verify there are no dead UI affordances: if a control, display region, history line, badge, tab, toggle, or data-* hook exists, prove it is wired to real behavior. If it is not wired, verdict=failed or FEEDBACK.",
    "- Check keyboard reachability, focus-visible states, accessible names/live regions for dynamic values, hover/active/disabled states where relevant, and no text overlap at small and desktop viewport sizes.",
    "- For standalone HTML/CSS/JS, verify viewport meta, semantic landmarks, self-contained assets when required, no accidental external src/href, and no `eval()` or `new Function()`.",
    "- Run deterministic DOM/static probes and behavioral probes. Browser screenshots are ideal when available; if browser/file access is unavailable, state that limitation and compensate with static + runtime probes rather than guessing.",
  ];
  if (taskLooksLikeCalculator(step, task)) {
    lines.push(
      "- Calculator probes must include: `2 + 3 = 5`, `7 / 2 = 3.5`, `0.1 + 0.2` displays as `0.3`, divide-by-zero shows an error and recovers on next digit, repeated equals continues the prior operation, correction/backspace works, and keyboard Enter/Escape/operator input works.",
      "- Calculator operator labels must be visible as `+`, `-`, `×` or `*`, `÷` or `/`, and `=`. A plain `x` multiplication label is not enough.",
      "- Calculator focus probes must include: after pointer-clicking clear, pressing keys `7`, `/`, `2`, `Enter` displays `3.5`; after clicking `2`, `+`, `3`, focusing equals and pressing `Enter` executes exactly once and stays `5`; focusing clear and pressing `Enter` clears to `0`; any focused button activated by `Enter`/Space must run that button's action exactly once instead of the global shortcut; null/undefined/empty key values are ignored.",
      "- Fail any calculator that contains an expression/history display that never updates, silently accepts impossible operators, or has no visible correction path.",
    );
  }
  return lines;
}

function renderImplementationWorkerPrompt({
  cwd,
  run,
  step,
  task,
  paths,
  settings,
}: {
  cwd: string;
  run: RunState;
  step?: StepState;
  task: WorkerTask;
  paths: WorkerArtifactPaths;
  settings: AppSettings;
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

  lines.push(
    "",
    "## SPEC EXACTNESS",
    "- Treat exact names, exported function shapes, JSON keys, sample output, punctuation, and decimal precision in the task as tests. If the prompt gives an example like `margin 80.0%`, match that formatting exactly unless the task explicitly says the example is illustrative.",
    "- Before reporting `complete`, run or construct a small probe that checks the exact public contract you implemented, and include the command/output in `proof[]`.",
  );

  const uiQualityGuidance = renderUiQualityGuidance(step, task);
  if (uiQualityGuidance.length) {
    lines.push("", "## UI QUALITY BAR", ...uiQualityGuidance);
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

  const delegationGuidance = shouldOfferRuntimeDelegation(step, task)
    ? renderRuntimeDelegationGuidance(task)
    : [];
  if (delegationGuidance.length) {
    lines.push("", "## RUNTIME-NATIVE DELEGATION", ...delegationGuidance);
  }

  const syncGuidance = shouldRenderAgentSyncPromptLines(step, task)
    ? renderAgentSyncPromptLines({ cwd, runtime: task.runtimePreference, settings })
    : [];
  if (syncGuidance.length) {
    lines.push("", "## SYNCED MCP / SKILL CONTEXT", ...syncGuidance);
  }

  const peerCommsGuidance = shouldUsePeerComms(run, step, task)
    ? renderPeerCommsGuidance(task, paths)
    : [];
  if (peerCommsGuidance.length) {
    lines.push("", "## PEER WORKER COMMUNICATION", ...peerCommsGuidance);
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
  run,
  step,
  task,
  paths,
  settings,
}: {
  cwd: string;
  run: RunState;
  step?: StepState;
  task: WorkerTask;
  paths: WorkerArtifactPaths;
  settings: AppSettings;
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

  const uiVerifierGuidance = renderUiVerifierGuidance(step, task);
  if (uiVerifierGuidance.length) {
    lines.push("", ...uiVerifierGuidance);
  }

  const delegationGuidance = shouldOfferRuntimeDelegation(step, task)
    ? renderRuntimeDelegationGuidance(task)
    : [];
  if (delegationGuidance.length) {
    lines.push("", "## RUNTIME-NATIVE DELEGATION", ...delegationGuidance);
  }

  const syncGuidance = shouldRenderAgentSyncPromptLines(step, task)
    ? renderAgentSyncPromptLines({ cwd, runtime: task.runtimePreference, settings })
    : [];
  if (syncGuidance.length) {
    lines.push("", "## SYNCED MCP / SKILL CONTEXT", ...syncGuidance);
  }

  const peerCommsGuidance = shouldUsePeerComms(run, step, task)
    ? renderPeerCommsGuidance(task, paths)
    : [];
  if (peerCommsGuidance.length) {
    lines.push("", "## PEER WORKER COMMUNICATION", ...peerCommsGuidance);
  }

  lines.push(
    "",
    "## WORKSPACE",
    `Workspace: ${cwd}`,
    "Read files directly from this path. Do NOT use the prior worker's narrative as your source of truth.",
    "",
    "## TOOL DISCIPLINE",
    peerCommsGuidance.length
      ? "Read-only tools only. Do not Write, Edit, or run any command that mutates project state (>, >>, tee, rm, mv, chmod, npm install, git commit, git push, destructive SQL). The Spark peer mailbox commands above are the only allowed write outside the project tree."
      : "Read-only tools only. Do not Write, Edit, or run any command that mutates project state (>, >>, tee, rm, mv, chmod, npm install, git commit, git push, destructive SQL).",
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
