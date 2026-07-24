import { promises as fs, createWriteStream, watch, type FSWatcher } from "node:fs";
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import type {
  AddDirectIterationInput,
  AddRunMessageInput,
  AnswerRunQuestionInput,
  AgentEffortLevel,
  AgentRuntimeDiagnostic,
  Checkpoint,
  CoraWhiteboard,
  CoraWhiteboardEdge,
  CoraWhiteboardNode,
  UndoToCheckpointInput,
  UndoToCheckpointResult,
  AgentRuntimeModel,
  AppSettings,
  LoomEngine,
  LoomWorkerConfig,
  RunStatus,
  StartDirectWorkerRunInput,
  WorkerAttemptStatus,
  InterruptRunWithMessageInput,
  LaunchWorkerAttemptInput,
  MarkRunSeenInput,
  PauseRunInput,
  RenameRunInput,
  UpdateChatBackendInput,
  UpdateCoraWhiteboardInput,
  CancelRunInput,
  ContextPacket,
  ResumeRunInput,
  CreateStepInput,
  CreateRunInput,
  CreateWorkerTaskInput,
  FanOutDirective,
  CouncilDirective,
  PlannedStepAgent,
  PrepareWorkerTaskInput,
  RunArtifactPaths,
  RunAssumption,
  RunBlocker,
  HumanRunMessage,
  RunConversationMessageIntent,
  RunMessageDeliveryState,
  RunMessageAttachment,
  RunQuestionCategory,
  RunQuestionContext,
  RunQuestionOption,
  RunQuestionResumeStrategy,
  RunQuestionSource,
  RunState,
  RuntimeState,
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
  WorkerRuntimeState,
  VerifierVerdict,
  WorkerReport,
  WorkerTaskEnvelope,
} from "@shared/types";
import { FAN_OUT_DIRECTIVE_MARKER } from "@shared/types";
import {
  normalizeHumanRunQuestionMessages,
  resolveOpenRunQuestion as resolveOpenRunQuestionPure,
  resolveSingleUnresolvedRunQuestion,
  unresolvedRunQuestions,
} from "@shared/run-questions";
import { makeId } from "@shared/ids";
import { stripAnsiAndControls } from "@shared/agent-patterns";
import {
  contextWindowForModel,
  estimateImageTokens,
  estimateTokensFromText,
} from "@shared/context-window";
import { normalizeChatFeatureFlags } from "@shared/chat-policy";
import { normalizeCoraExecutionPolicy } from "@shared/cora-execution-policy";
import {
  CORA_WHITEBOARD_NODE_DEFAULT_SIZES,
  whiteboardNodeSizeLimits,
} from "@shared/cora-whiteboard-file";
import { selectLargestCompatibleWave } from "@shared/parallel-wave";
import { CODEX_MODEL_BY_TIER, normalizeCodexModelId } from "@shared/model-catalog";
import {
  appendEvent as appendEventRaw,
  appendEvents as appendEventsRaw,
  appendFanOutDirectiveForcedEvent,
  appendFanOutDowngradedEvent,
  appendRegressionRevertEvent,
  appendWriteScopesDerivedEvent,
  eventsPath,
  listEvents,
  runDir,
  runsRoot,
} from "./event-log";
import { buildRunStatusTransitionEvent } from "./run-lifecycle";
import { reconcileAcceptedVerifierOnlySteps } from "./step-lifecycle";
import { PEER_COMMS_HELPER_SCRIPT } from "./peer-comms-script";
import { decideWorkerReport, readWorkerReport } from "./worker-report";
// Re-exported for external importers (ipc.ts reaches it via getRunStore()).
export { readWorkerReport } from "./worker-report";
import {
  COMPLETION_SUMMARY_PREFIX,
  buildCompletionSummaryMessage,
} from "./completion-summary";
import { collectRunResultManifest } from "./result-manifest";
import {
  readWorkerPromptForLaunch,
  renderWorkerPrompt,
  shouldUsePeerComms,
} from "./worker-prompt";
import {
  buildClaudeShieldPrefix,
  buildCodexShieldPrefix,
  logConfigShieldOnce,
} from "./agent-config-shield";
import {
  detectFatalWorkerRuntimeError,
  pasteAndSubmit,
  waitForAgentTui,
  waitForCodexInputReady,
  writeAutoFailureReport,
} from "./worker-launch";
import {
  claudeDisallowedTools,
  codexAccessFlags,
  decorateWavePrompt,
  waveHasChat,
  type WavePeerInfo,
} from "./worker-access";
import { writeFileAtomic } from "../fs-atomic";
import { loadSettings } from "../storage";
import { estimateWorkerCostUsd } from "../openrouter-prices";
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
import {
  backEdgesToFire,
  computeSkips,
  forwardDescendants,
  isPassComplete,
  MAX_BACK_EDGE_VISIT_CAP,
  mergeOutput,
  nextReadyWave,
  readyGuardNodes,
  readyMergeNodes,
  renderNodePrompt,
  retryDisposition,
  upstreamOf,
} from "./loom-graph";
import { evaluateGuardPredicate } from "./loom-predicates";
import { ensureCodexProjectTrust } from "./codex-trust";
import type { LoomGraph, LoomNodeDef } from "@shared/types";
import { recordRunMemory } from "./run-memory";
import {
  createCheckpoint,
  deleteRunCheckpoints,
  restoreCheckpointCode,
  rewindShadowRef,
  runCheckpointStartPoint,
} from "./checkpoints";
import { resolveConversationRewindTransaction } from "./conversation-rewind";
import { createKeyedTaskQueue } from "./keyed-task-queue";
import { createSandboxWorktree, mergeBackSandboxWorktree, removeSandboxWorktree } from "../git-worktrees";
import { readGitText } from "../git-exec";
import { sparkHome } from "../spark-home";
import { defaultShell } from "../shells";
import {
  sanitizeWorkerModelHint,
  WORKER_DEFAULT_CLAUDE_MODEL,
} from "./worker-model-hint";
import * as pty from "../pty-manager";
import { runStructuredWorker } from "./structured-worker";
import { detectAgentRuntimes } from "../agent-runtimes";
import { renderAgentSyncManagerContext } from "../agent-sync";
import { getProvider } from "../providers";
import type { SpawnOpts } from "../providers/types";
import {
  buildManagerTurnPrompt,
  isCheckpointJobCurrent,
  isManagerTurnCurrent,
  resolveChatBackendConfig,
  shouldIncludeCanonicalReplay,
  type ChatStreamEvent,
} from "./spark-agent-backend";
import { getBackend } from "./backend-registry";
import { createCodaraPiWorkerLaunchPlan } from "./pi-runtime-electron";
import { PiRpcClient, type PiRpcEvent } from "./pi-rpc-client";
import type { PiSubscriptionProvider, PiThinkingLevel } from "./pi-runtime";
import {
  abandonRunQuestionOwnership,
  applyRunQuestionAnswer,
  applyRunQuestionBlocker,
  claimPendingManagerResume,
  clearRegisteredPendingManagerResume,
  createRunBlocker,
  decideRunManagerQuestion,
  inferRunQuestionCategory,
  normalizeRunQuestionSignature,
  recoverPendingManagerResumeLease,
  releaseRunQuestionBlocker,
} from "./run-question-policy";

const RUN_FILE = "run.json";
const ESC_KEY = "\x1b";
const CONTINUE_INPUT = "continue\r";
const HUMAN_INPUT_PAUSE_REASON = "Cora needs human input before continuing.";
// How many run directories under ~/.SparkAgent/runs/ count toward retained
// history. Live/nonterminal runs never consume deletion eligibility: retain all
// of them even when they exceed this budget, then fill the remaining slots with
// the newest known-terminal runs.
const RUN_RETENTION_KEEP = 50;
const RETENTION_TERMINAL_STATUSES = new Set<RunStatus>([
  "complete",
  "failed",
  "cancelled",
]);

// SLICE 6 (bounded loop-back cycles) — the SECOND, independent termination bound.
// Beyond each back-edge's per-edge visitCap (loom-graph.effectiveVisitCap), this
// caps the TOTAL worker-node activations across a single loom pass: the sum of
// loomPass.nodeStates[*].activations (every worker launch + every retry/loop
// re-launch bumps a node's activations by 1). If a wave would push the running
// total over this cap, finalizeDirectRun terminalizes the pass as "failed" with a
// clear message INSTEAD of launching — so even a pathological multi-back-edge
// graph (or a mis-set visitCap that slipped the per-edge clamp) can never spin
// forever. Sized well above any realistic loom (10 back-edges × cap 10 × a few
// body nodes), so it only trips on genuine runaways.
const MAX_PASS_ACTIVATIONS = 500;

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
  // Self-reported runtime state from the worker process via the hook RPC
  // (big-bet "Hook contract for sub-agents to self-report"). Updated by
  // applyHookStateReport; authoritative over any regex-tail detection
  // pulled from pty output (big bet A) — the doc says so. Optional + last
  // update wins.
  runtimeState?: WorkerRuntimeState;
  runtimeStateNote?: string;
  runtimeStateAt?: string;
}

const activeWorkerProcesses = new Map<string, ActiveWorkerProcess>();
const activeAutopilotCycles = new Map<string, Promise<void>>();
const activeAutopilotPlans = new Map<string, Promise<void>>();
const activeAutopilotReviews = new Map<string, Promise<void>>();
const activeSteeringFollowups = new Map<string, Promise<void>>();
const activeConversationRewinds = new Map<string, Promise<UndoToCheckpointResult>>();
// Durable answer continuations are keyed by question identity until the intended
// manager stage claims their persisted pendingManagerResume record.
const activePendingManagerResumes = new Set<string>();
// Guard so the fan-out serial-downgrade event is emitted at most once per
// (run, task): pickAutopilotTasks is a PURE selector called every autopilot
// tick, so without this the launch site would re-emit fanout.downgraded_to_serial
// on every loop. Keyed `${runId}:${taskId}`; lives for the process lifetime
// (re-emitting once after a restart is harmless for an observability event).
const emittedFanOutDowngrades = new Set<string>();
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

interface ManagerDecisionMutationContext {
  runId: string;
  conversationEpoch: number;
}

const managerDecisionMutationContext =
  new AsyncLocalStorage<ManagerDecisionMutationContext>();

class StaleManagerDecisionError extends Error {
  constructor(runId: string, expectedEpoch: number, actualEpoch: number) {
    super(
      `Manager decision for run ${runId} belongs to conversation epoch ${expectedEpoch}; current epoch is ${actualEpoch}.`,
    );
    this.name = "StaleManagerDecisionError";
  }
}

function assertManagerDecisionMutationCurrent(runId: string | undefined): void {
  const context = managerDecisionMutationContext.getStore();
  if (!runId || !context || context.runId !== runId) return;
  const current = runCache.get(runId);
  if (!current) return;
  const actualEpoch = conversationEpoch(current);
  if (actualEpoch !== context.conversationEpoch) {
    throw new StaleManagerDecisionError(
      runId,
      context.conversationEpoch,
      actualEpoch,
    );
  }
}

const appendEvent = (
  ...args: Parameters<typeof appendEventRaw>
): ReturnType<typeof appendEventRaw> => {
  assertManagerDecisionMutationCurrent(args[0].runId);
  return appendEventRaw(...args);
};

const appendEvents = (
  ...args: Parameters<typeof appendEventsRaw>
): ReturnType<typeof appendEventsRaw> => {
  for (const input of args[0]) assertManagerDecisionMutationCurrent(input.runId);
  return appendEventsRaw(...args);
};

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

async function detectConfiguredAgentRuntimes(): Promise<AgentRuntimeDiagnostic[]> {
  return detectAgentRuntimes().catch(() => []);
}

export async function createRun(input: CreateRunInput): Promise<RunState> {
  const now = new Date().toISOString();
  const initialBackend = input.chatBackend ?? "pi";
  const initialChatFlags = normalizeChatFeatureFlags(initialBackend, {
    chatFastMode: input.chatFastMode,
    chat1mContext: input.chat1mContext,
  });
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
    conversationEpoch: 0,
    autopilot: {
      status: "idle",
      updatedAt: now,
    },
    // Stamp the chip's draft selections onto the fresh run so the chip's
    // backend/model/mode/effort survive the draft→live transition without an
    // extra updateChatBackend round-trip. Fields are individually optional
    // because pre-feature callers pass none of them. New runs stamp Pi so
    // ordinary Cora sessions use the bundled subscription harness unless the
    // caller explicitly selects a legacy backend.
    chatBackend: initialBackend,
    chatModel: input.chatModel?.trim() || (initialBackend === "pi" ? "gpt-5.6-sol" : undefined),
    chatMode: input.chatMode,
    chatEffort: input.chatEffort ?? (initialBackend === "pi" ? "high" : undefined),
    coraExecutionPolicy: input.coraExecutionPolicy === undefined
      ? undefined
      : normalizeCoraExecutionPolicy(input.coraExecutionPolicy),
    chatFastMode: initialChatFlags.chatFastMode,
    chat1mContext: initialChatFlags.chat1mContext,
    // Looms v2: ownership + execution mode are stamped at creation (not
    // patched after) so the run.created event itself already carries them.
    automationId: input.automationId,
    executionMode: input.executionMode,
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
      automationId: run.automationId,
      executionMode: run.executionMode,
    },
  });

  // Take a baseline snapshot in the background so a fresh chat opens without
  // waiting on `git add -A`. The baseline shows up on the next event tick.
  void recordCheckpointInBackground({
    runId: run.id,
    cwd: input.cwd,
    kind: "run-start",
    messagePointer: 0,
    label: "Chat start",
    conversationEpoch: 0,
  });

  return run;
}

export async function getRun(runId: string): Promise<RunState | null> {
  // Cache HIT: the in-memory copy is authoritative (this module is the sole
  // writer of run.json) and canonical. It was normalized before entering the
  // cache and stays normalized across saveRun, so return it without rebuilding.
  const cached = runCache.get(runId);
  if (cached) return cached;

  // Cache MISS: read + parse + normalize from disk, then populate the cache.
  try {
    const raw = await fs.readFile(runPath(runId), "utf8");
    const run = normalizeRun(JSON.parse(raw) as RunState);
    runCache.set(run.id, run);
    return run;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (err instanceof SyntaxError) {
      console.warn(`[run-store] Skipping corrupt run.json for run ${runId} (${runPath(runId)}):`, err);
      return null;
    }
    throw err;
  }
}

export async function readWorkerAttemptPrompt(
  runId: string,
  attemptId: string,
): Promise<string> {
  const run = await requireRun(runId);
  const attempt = run.workerAttempts.find((candidate) => candidate.id === attemptId);
  if (!attempt?.promptPath) {
    throw new Error(`Worker prompt not found: ${attemptId}`);
  }

  // This API deliberately reads only the prompt recorded for this attempt.
  // Resolve real paths as well as lexical paths so a symlink inside the run
  // directory cannot turn this narrow reader into a general filesystem API.
  const artifactRoot = await fs.realpath(runDir(run.id));
  const promptPath = await fs.realpath(resolvePath(attempt.promptPath));
  const relativePrompt = relative(artifactRoot, promptPath);
  if (
    relativePrompt === "" ||
    relativePrompt.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    relativePrompt === ".." ||
    isAbsolute(relativePrompt)
  ) {
    throw new Error("Worker prompt path is outside its run artifacts.");
  }
  return fs.readFile(promptPath, "utf8");
}

async function purgeTerminalRunForRetention(runId: string): Promise<void> {
  // Serialize the final status check with normal run commits. A run can be
  // resumed while the sweep is scanning; checking only the earlier disk
  // snapshot would let retention delete it after it became live again.
  const previous = runMutationQueues.get(runId) ?? Promise.resolve();
  const next = previous
    .catch(() => {
      /* an earlier failed commit must not wedge retention */
    })
    .then(async () => {
      const latest = await getRun(runId);
      if (!latest || !RETENTION_TERMINAL_STATUSES.has(latest.status)) return;
      if (
        activeWorkersForRun(runId).length > 0 ||
        [...activeAutopilotCycles.keys()].some((key) => key.startsWith(`${runId}:`)) ||
        activeAutopilotPlans.has(runId) ||
        activeAutopilotReviews.has(runId)
      ) {
        return;
      }
      await deleteRun(runId);
    });
  runMutationQueues.set(runId, next);
  try {
    await next;
  } finally {
    if (runMutationQueues.get(runId) === next) runMutationQueues.delete(runId);
  }
}

// Recursively delete only known-terminal runs outside the retention budget.
// Nonterminal, missing, malformed, and unknown statuses are conservative keeps:
// retention must never destroy work merely because its metadata cannot prove it
// finished. The remaining budget after those protected entries is filled by the
// newest terminal runs. Best-effort: failures never bubble into listRuns().
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
        let status: unknown;
        let createdMs = Number.NEGATIVE_INFINITY;
        let readable = false;
        try {
          const raw = await fs.readFile(runPath(name), "utf8");
          const parsed = JSON.parse(raw) as { createdAt?: unknown; status?: unknown };
          readable = true;
          status = parsed.status;
          if (typeof parsed.createdAt === "string") {
            const parsedMs = Date.parse(parsed.createdAt);
            if (Number.isFinite(parsedMs)) createdMs = parsedMs;
          }
        } catch {
          // unreadable/corrupt means protected below
        }
        if (!Number.isFinite(createdMs)) {
          try {
            createdMs = (await fs.stat(join(root, name))).mtimeMs;
          } catch {
            createdMs = Number.NEGATIVE_INFINITY;
          }
        }
        const terminal =
          readable &&
          typeof status === "string" &&
          RETENTION_TERMINAL_STATUSES.has(status as RunStatus);
        return { name, createdMs, terminal };
      }),
    );

    const terminal = entries
      .filter((entry) => entry.terminal)
      .sort((a, b) => b.createdMs - a.createdMs || b.name.localeCompare(a.name));
    const toPurge = terminal.slice(RUN_RETENTION_KEEP);
    for (const entry of toPurge) {
      try {
        await purgeTerminalRunForRetention(entry.name);
      } catch {
        // A failed final re-read/check is conservative: keep the run. The next
        // process gets another sweep rather than deleting uncertain state.
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
      // Engine choice from the "Run plan" / "Smart Merge" pickers and from
      // per-automation loop config. Threading these through createRun stamps
      // run.chatBackend/chatModel/chatMode/chatEffort so askOpenRouterManager
      // dispatches to the Claude Code / Codex manager with the right model.
      // Undefined → OpenRouter + backend defaults.
      chatBackend: input.chatBackend,
      chatModel: input.chatModel,
      chatMode: input.chatMode,
      chatEffort: input.chatEffort,
      coraExecutionPolicy: input.coraExecutionPolicy,
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
  // plan_analysis read of run.humanMessages picks it up. addRunMessage
  // dedupes by clientMessageId, so re-entering startAutopilot with the same
  // initialUserNote (recursive resume) is a no-op. The previous guard on
  // `!input.runId` mis-skipped fresh chats too whenever the caller had
  // pre-created the run via createRun() to thread chip config — which is
  // what the v1 chip flow does.
  // First-class parallel fan-out: when the composer/explorer seeded a
  // FanOutDirective (structured input.fanOut, or a marker-bearing initial
  // note), run-store synthesizes the parallel batch deterministically instead
  // of round-tripping plan_analysis. Resolve it up front so the note-handling
  // early-returns below don't divert a fan-out into the chat/plan path.
  const fanOutDirective = resolveFanOutDirective(input);
  const councilDirective = resolveCouncilDirective(run, input);

  // OpenRouter's manager request includes the active plan directly, but the
  // Claude/Codex manager transports intentionally consume only durable queued
  // human messages. A "Run plan" invocation historically persisted planText
  // in run.plans without queueing a turn, so a CLI-backed manager received
  // "There is no new user message" and could mark untouched work complete.
  // Mirror the plan into one stable user turn for those transports. A stable
  // client id makes re-entered startAutopilot calls idempotent.
  const cliManagerNeedsPlanTurn =
    Boolean(planText) &&
    (run.chatBackend === "claude" || run.chatBackend === "codex" || run.chatBackend === "pi");
  const initialNote = input.initialUserNote?.trim() ||
    (cliManagerNeedsPlanTurn ? planText : undefined);
  if (initialNote) {
    run = await addRunMessage({
      runId: run.id,
      clientMessageId:
        input.initialUserNoteClientMessageId ??
        (cliManagerNeedsPlanTurn ? `plan-turn-${run.planId ?? run.id}` : undefined),
      author: "user",
      kind: "note",
      message: initialNote,
      attachments: input.initialAttachments,
      intent: "turn",
    });
    if (!planText && !fanOutDirective && !councilDirective) {
      scheduleInitialChatDecision(run.id, input);
      return run;
    }
  }

  // Force the fan-out batch before the generic planning branch. On a fresh run
  // (no steps yet) this materializes exactly one worker_batch — one parallel
  // worker per target, each scoped to its own file — and we fall through to the
  // launch loop below. If no usable targets survive normalization, fall back to
  // normal planning so the user still gets a run.
  if (fanOutDirective && run.steps.length === 0 && run.workerTasks.length === 0) {
    const forced = await forceFanOutBatch(run, fanOutDirective);
    if (forced) {
      run = forced;
    } else {
      scheduleInitialAutopilotPlanning(run.id, input);
      return run;
    }
  }

  // Plan-mode Best-of-N council: force a parallel batch of candidate planners
  // (a mix of top-tier Claude/Codex agents) writing into disjoint candidate
  // folders. The synthesis judge runs at review time (runAutopilotManagerReview).
  if (councilDirective && run.steps.length === 0 && run.workerTasks.length === 0) {
    const forced = await forceCouncilBatch(run, councilDirective);
    if (forced) {
      run = forced;
    } else {
      scheduleInitialAutopilotPlanning(run.id, input);
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
  // concludes "no ready task" and asks the user a clarifying question Codara
  // already has the answer to.
  if (tasks.length === 0 && needsStepPlanning(run)) {
    const fastPathPlan = await tryTrivialFastPathStepPlanning(run);
    run = fastPathPlan ?? ((await askOpenRouterManager(run, input.cwd, "step_planning")) ?? run);
    if (run.status === "paused" || run.status === "blocked" || run.status === "cancelled" || run.status === "complete") return run;
    tasks = pickAutopilotTasks(run);
  }
  if (tasks.length === 0) {
    // A force-pause or a still-active worker can race this launch loop: the
    // pause requeues the manager input, startAutopilot re-enters, and the sole
    // non-terminal task is unqueueable because its attempt was just killed
    // (observed in run-mrz25z39-9ffs4w). Asking "I could not find a ready
    // task" then reads as model confusion — stay quiet and let the real
    // driver (resume, worker finish, or review) pick the run back up.
    run = await requireRun(run.id);
    const attemptInFlight = run.workerAttempts.some(
      (item) => !["succeeded", "failed", "timed_out", "cancelled"].includes(item.status),
    );
    const forcePausedJustNow =
      run.autopilot?.lastAction === "force_paused" &&
      typeof run.autopilot.pausedAt === "string" &&
      Date.now() - Date.parse(run.autopilot.pausedAt) < 30_000;
    if (
      ["paused", "blocked", "cancelled", "complete"].includes(run.status) ||
      forcePausedJustNow ||
      attemptInFlight ||
      activeWorkersForRun(run.id).length > 0
    ) {
      return run;
    }
    return askHumanQuestion(
      run.id,
      "I could not find a ready task to run. Please clarify the next goal.",
      undefined,
      {
        reason: "No safe runnable task can be inferred from the current plan.",
        managerMode: run.workerAttempts.length > 0 ? "worker_result_review" : "plan_analysis",
      },
    );
  }

  // Observability: if the next batch was collapsed to a single serial task only
  // because that task wants to run parallel but has no concrete write scope,
  // surface it as a fanout.downgraded_to_serial event (once per run+task). This
  // is the launch site — pickAutopilotTasks is pure and runs every tick, so the
  // emit lives here behind the in-memory guard rather than in the selector.
  await maybeEmitFanOutDowngrade(run);

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
        unattended: true,
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

// ── Looms v2: direct-worker runs ────────────────────────────────────────────
// An automation iteration runs ONE CLI worker (claude/codex) with the rendered
// loop prompt — no manager LLM anywhere in the path. Direct runs reuse the
// hardened worker pipeline unchanged (prepareWorkerTask → autopilot cycle →
// final-report.json) and finalizeDirectRun replaces the manager review as the
// terminal hop (see the executionMode seam in runAutopilotManagerReview).

const DIRECT_ATTEMPT_TERMINAL = new Set<WorkerAttemptStatus>([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);

// LoomWorkerConfig and WorkerTask now share the full effort vocabulary,
// including GPT-5.6's max setting, so automation workers preserve the user's
// exact choice instead of silently clamping it to xhigh.
function loomEffortToWorkerEffort(
  effort: AgentEffortLevel | undefined,
): WorkerTask["effortHint"] {
  return effort;
}

export async function startDirectWorkerRun(input: StartDirectWorkerRunInput): Promise<RunState> {
  let run = await createRun({
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName ?? "workspace",
    cwd: input.cwd,
    title: input.title,
    automationId: input.automationId,
    executionMode: "direct",
  });
  run = await commitRunChange(run, {
    type: "direct_run.started",
    message: "Loom direct-worker run started",
    payload: { automationId: input.automationId, engine: input.engine, model: input.model ?? null },
    mutate: (draft, timestamp) => {
      draft.status = "running";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
        status: "running",
        lastAction: "started",
        startedAt: timestamp,
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
  });
  // MULTI-NODE entry seam: the loop driver may hand the WHOLE layer-0 frontier
  // (≥2 entry nodes) as `nodes`. Each entry's prompt was already var-substituted
  // by the driver, so we note + launch them as ONE wave (one task/attempt each,
  // pendingNodeIds seeded for all). The degenerate single-node path (no `nodes`)
  // is preserved byte-identically below.
  if (input.nodes && input.nodes.length > 0) {
    for (const node of input.nodes) {
      run = await addRunMessage({
        runId: run.id,
        clientMessageId: `loom-entry-${node.nodeId}`,
        author: "user",
        kind: "note",
        message: node.template,
      });
    }
    return launchDirectNodeTasks(run.id, input.cwd, 1, input.nodes, {
      vars: input.vars,
      freshPass: input.freshPass,
    });
  }
  // The prompt lands as a user note so history detail, {{lastOutput}}
  // provenance, and the codara_ask_user long-poll all see a normal transcript.
  run = await addRunMessage({
    runId: run.id,
    author: "user",
    kind: "note",
    message: input.prompt,
  });
  return launchDirectIterationTask({
    runId: run.id,
    cwd: input.cwd,
    passNumber: 1,
    prompt: input.prompt,
    engine: input.engine,
    model: input.model,
    effort: input.effort,
    loomNodeId: input.loomNodeId,
    access: input.access,
    blockedTools: input.blockedTools,
    vars: input.vars,
    freshPass: input.freshPass,
  });
}

// Same-run chaining (loop.isolate === false): iteration N+1 reuses the run so
// cost accumulates and the transcript carries across passes. The engine/model
// may differ per pass — buildLaunchCommandLine reads them per task.
export async function addDirectIteration(input: AddDirectIterationInput): Promise<RunState> {
  let run = await requireRun(input.runId);
  if (run.executionMode !== "direct") {
    throw new Error(`addDirectIteration requires a direct-mode run: ${input.runId}`);
  }
  // Race defense: never stack two live CLI workers on one loom run. The loop
  // driver already HOLDs on non-terminal runs; this is the engine-side bound.
  if (run.workerAttempts.some((a) => !DIRECT_ATTEMPT_TERMINAL.has(a.status))) {
    return run;
  }
  // MULTI-NODE entry seam (same-run pass-chaining): the loop driver may chain a
  // fresh PASS whose layer 0 is the WHOLE entry frontier (≥2 nodes). Note each
  // already-rendered entry prompt, then launch them as ONE wave. freshPass is
  // set TRUE on this pass-chaining call so launchDirectNodeTasks rebuilds the
  // loomPass from scratch (the previous pass's downstream/loop state must NOT
  // carry over). The single-node / answer-resume path below is unchanged.
  if (input.nodes && input.nodes.length > 0) {
    const cwdMulti = workspaceCwdFromRun(run);
    if (!cwdMulti) throw new Error(`Direct run has no workspace cwd: ${input.runId}`);
    for (let i = 0; i < input.nodes.length; i += 1) {
      run = await addRunMessage({
        runId: run.id,
        clientMessageId: `${input.clientMessageId ?? "loom-entry"}-${input.nodes[i].nodeId}-${i}`,
        author: "user",
        kind: "note",
        message: input.nodes[i].template,
      });
    }
    const passNumberMulti = run.steps.length + 1;
    run = await commitRunChange(run, {
      type: "direct_run.iteration_started",
      message: `Loom iteration ${passNumberMulti} started`,
      payload: { engine: input.engine, model: input.model ?? null, effort: input.effort ?? null },
      mutate: (draft, timestamp) => {
        draft.status = "running";
        draft.autopilot = {
          ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
          status: "running",
          lastAction: "direct_iteration_started",
          stopReason: undefined,
          resumedAt: timestamp,
          updatedAt: timestamp,
        };
        draft.updatedAt = timestamp;
      },
    });
    return launchDirectNodeTasks(run.id, cwdMulti, passNumberMulti, input.nodes, {
      vars: input.vars,
      freshPass: input.freshPass,
    });
  }
  run = await addRunMessage({
    runId: run.id,
    clientMessageId: input.clientMessageId,
    author: "user",
    kind: "note",
    message: input.prompt,
  });
  const passNumber = run.steps.length + 1;
  run = await commitRunChange(run, {
    type: "direct_run.iteration_started",
    message: `Loom iteration ${passNumber} started`,
    payload: { engine: input.engine, model: input.model ?? null, effort: input.effort ?? null },
    mutate: (draft, timestamp) => {
      draft.status = "running";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
        status: "running",
        lastAction: "direct_iteration_started",
        stopReason: undefined,
        resumedAt: timestamp,
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
  });
  const cwd = workspaceCwdFromRun(run);
  if (!cwd) throw new Error(`Direct run has no workspace cwd: ${input.runId}`);
  return launchDirectIterationTask({
    runId: run.id,
    cwd,
    passNumber,
    prompt: input.prompt,
    engine: input.engine,
    model: input.model,
    effort: input.effort,
    loomNodeId: input.loomNodeId,
    access: input.access,
    blockedTools: input.blockedTools,
    vars: input.vars,
    freshPass: input.freshPass,
  });
}

// One node to launch within a loom-pass wave. The `template` is rendered through
// loom-graph.renderNodePrompt against the pass vars + the settled upstream
// outputs; `incoming` is this node's forward-edge parent ids (computed by the
// caller via the pure upstreamOf), whose outputs feed the {{incoming}} token.
// For the ENTRY (layer-0) wave the "template" is the prompt automation-loop
// already assembled (var-substituted + firedPath note + agent footer) with no
// remaining tokens, so the re-render is a no-op and the launched string is
// byte-identical to the pre-graph single-node launch.
interface DirectNodeLaunch {
  nodeId: string;
  template: string;
  worker: LoomWorkerConfig;
  incoming?: string[]; // forward-parent node ids (empty/omitted for entry nodes)
  isolate?: boolean; // per-node isolation; reserved (run-level isolate stays in the loop)
  label?: string; // shown in the awareness peer list
  access?: "full" | "edits" | "readonly"; // per-worker tool-access preset
  blockedTools?: string[]; // claude-only extra hard-denies
  collab?: { awareness?: boolean; chat?: boolean }; // parallel-wave collaboration
}

// Single-node delegate kept under its original name so its sole callers
// (startDirectWorkerRun / addDirectIteration) and the surrounding mental model
// don't churn: it forwards to launchDirectNodeTasks with one node. For ONE node
// the wave is behaviorally identical to the pre-graph single-task launch — the
// prompt is the already-assembled entry string, rendered with empty upstream
// context (renderNodePrompt no-op).
async function launchDirectIterationTask(opts: {
  runId: string;
  cwd: string;
  passNumber: number; // 1-based
  prompt: string;
  engine: LoomEngine;
  model?: string;
  effort?: AgentEffortLevel;
  loomNodeId?: string;
  access?: "full" | "edits" | "readonly";
  blockedTools?: string[];
  vars?: Record<string, string>;
  freshPass?: boolean;
}): Promise<RunState> {
  return launchDirectNodeTasks(
    opts.runId,
    opts.cwd,
    opts.passNumber,
    [
      {
        nodeId: opts.loomNodeId ?? "w0",
        template: opts.prompt,
        worker: { engine: opts.engine, model: opts.model, effort: opts.effort },
        access: opts.access,
        blockedTools: opts.blockedTools,
        // collab is intentionally omitted: a single-node launch has no peers.
      },
    ],
    { vars: opts.vars, freshPass: opts.freshPass },
  );
}

// Shared tail of both direct entry points: synthesize ONE step for the wave,
// one worker task PER NODE (each stamped with workerTask.loomNodeId), wait for
// the checkpoint queue, prepare every node's attempt, seed/advance
// RunState.loomPass for this layer, then hand ALL attempt ids to the autopilot
// cycle machinery in ONE scheduleAutopilotCycles call so the autopilot join
// barrier is the wave boundary. Modeled on forceFanOutBatch's manager-less task
// creation. For a single node this is behaviorally identical to the pre-graph
// launchDirectIterationTask (one step, one task, one attempt, one cycle).
async function launchDirectNodeTasks(
  runId: string,
  cwd: string,
  passNumber: number, // 1-based
  nodes: DirectNodeLaunch[],
  _opts?: {
    layer?: number;
    // The pass-level {{var}} snapshot — seeded onto loomPass.vars on the entry
    // wave, re-read (off the run) for later waves.
    vars?: Record<string, string>;
    // Outputs of already-settled nodes, keyed by node id; feeds {{node:<id>}}
    // and each launching node's {{incoming}} (its forward parents' outputs).
    nodeOutputs?: Record<string, string>;
    // Add each rendered node prompt as a user note (provenance/transcript). The
    // entry points already note their prompt, so this is set only for the later
    // waves finalizeDirectRun launches.
    addPromptNotes?: boolean;
    // PASS BOUNDARY: when true, rebuild loomPass FROM SCRATCH (only this wave's
    // nodes, activations 1, fresh attemptIds, no carried back-edge budget) — the
    // loop driver's same-run pass-chaining launch sets this so pass 2+ of a
    // multi-node loom re-runs downstream nodes and re-arms loops. Absent/false on
    // a mid-pass answer-resume AND on finalizeDirectRun's intra-pass advance/
    // relaunch launches (those MUST keep the merge/preserve behavior so a wave
    // join and a bounded loop see the prior pass state). Single-node: the reset
    // re-seeds the one running node = today's behavior.
    freshPass?: boolean;
  },
): Promise<RunState> {
  if (nodes.length === 0) throw new Error("launchDirectNodeTasks requires at least one node.");
  const layer = _opts?.layer ?? 0;
  const vars = _opts?.vars ?? {};
  const nodeOutputs = _opts?.nodeOutputs ?? {};
  const freshPass = _opts?.freshPass === true;

  // FIX 7: resolve a node's "auto" engine against the INSTALLED set (claude-then-
  // codex, mirroring resolveWorker) — NOT a hard-coded "claude". The entry wave
  // already passes a concrete engine (automation-loop resolved it), but advance/
  // relaunch waves carry the node's raw "auto", which on a Codex-only host would
  // otherwise pin a missing Claude CLI and fail the pass. Detect ONCE per wave,
  // and only when some node is actually "auto" (no extra probe on legacy paths).
  let resolveAuto: (engine: LoomEngine | "auto") => LoomEngine = (engine) =>
    engine === "auto" ? "claude" : engine;
  if (nodes.some((n) => n.worker.engine === "auto")) {
    const { detectAgentRuntimes } = await import("../agent-runtimes");
    const runtimes = await detectAgentRuntimes();
    const installed = new Set(
      runtimes
        .filter((r) => (r.kind === "claude" || r.kind === "codex") && r.installed)
        .map((r) => r.kind),
    );
    resolveAuto = (engine) =>
      engine !== "auto"
        ? engine
        : installed.has("claude")
          ? "claude"
          : installed.has("codex")
            ? "codex"
            : "claude";
  }

  // Render every launching node's prompt from its template through the pure
  // renderNodePrompt: pass vars + the {{node:<id>}} outputs map + this node's
  // {{incoming}} (its forward parents' outputs). For the entry wave the template
  // is already fully assembled and carries no tokens, so this is a no-op and the
  // launched string is byte-identical to the pre-graph single-node launch.
  // Downstream (advance/relaunch) waves pass `incoming`, so renderNodePrompt's
  // auto-incoming rule applies: a template that references neither {{incoming}}
  // nor {{node:*}} gets its upstream output appended — a downstream worker must
  // never run blind on "this"/"it" prompts written without explicit tokens.
  const rendered = nodes.map((node) =>
    renderNodePrompt(node.template, {
      vars,
      nodeOutputs,
      incoming: (node.incoming ?? []).map((id) => nodeOutputs[id] ?? ""),
    }),
  );

  // Parallel-wave collaboration: wrap each worker's rendered prompt with the
  // awareness (peers listed) and/or chat (shared board) blocks its node enabled,
  // but only when this wave actually has peers. decorateWavePrompt is a no-op for
  // a lone worker or a node with no collab, so the default wave is byte-identical
  // to before. The chat board lives at <runDir>/mail — create it once when any
  // node in this wave will genuinely post to a peer (a board of one has no
  // readers, so waveHasChat gates the mkdir too).
  const dir = runDir(runId);
  const mailDir = join(dir, "mail");
  const peerInfos: WavePeerInfo[] = nodes.map((node, i) => ({
    nodeId: node.nodeId,
    label: node.label,
    engine: resolveAuto(node.worker.engine),
    prompt: rendered[i],
    collab: node.collab,
    access: node.access,
    blockedTools: node.blockedTools,
  }));
  const othersOf = (i: number): WavePeerInfo[] => peerInfos.filter((_, j) => j !== i);
  // Per-node: did we render a chat block for it? Drives BOTH the mail-dir mkdir
  // and (for a codex worker) making <runDir>/mail writable via --add-dir at
  // launch, so a chat participant can read AND post to the board.
  const nodeHasChat = nodes.map((node, i) => waveHasChat(node.collab, othersOf(i)));
  if (nodeHasChat.some(Boolean)) {
    await fs.mkdir(mailDir, { recursive: true }).catch(() => undefined);
  }
  const decorated = nodes.map((node, i) =>
    decorateWavePrompt(rendered[i], {
      self: peerInfos[i],
      peers: othersOf(i),
      collab: node.collab,
      runDir: dir,
    }),
  );

  let run = await requireRun(runId);
  // Later waves get a user note per node so the transcript shows what each
  // downstream worker was asked (the entry points already noted layer 0).
  if (_opts?.addPromptNotes) {
    for (let i = 0; i < nodes.length; i += 1) {
      run = await addRunMessage({
        runId: run.id,
        clientMessageId: `loom-node-${nodes[i].nodeId}-${run.workerAttempts.length}-${i}`,
        author: "user",
        kind: "note",
        message: decorated[i],
      });
    }
  }

  run = await createStep({
    runId,
    title: `Loom pass ${passNumber}`,
    goal: "Run one automation-loop iteration: execute the instruction below and write the final report.",
    kind: "worker_batch",
    riskLevel: "low",
    plannedAgents: nodes.map((node, i) => ({
      label: `worker ${passNumber}.${i + 1}`,
      summary: decorated[i].length > 200 ? `${decorated[i].slice(0, 200)}…` : decorated[i],
      runtimePreference: resolveAuto(node.worker.engine),
      taskClass: "feature",
    })),
    acceptanceCriteria: [
      "The worker executed the iteration's instruction and reported its real results in final-report.json.",
    ],
  });
  const stepId = run.steps.at(-1)?.id;

  // One worker task per node, each stamped with its graph node id.
  const taskIds: Array<{ nodeId: string; taskId: string }> = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    run = await createWorkerTask({
      runId: run.id,
      stepId,
      title: `Loom pass ${passNumber}`,
      description: decorated[i],
      runtimePreference: resolveAuto(node.worker.engine),
      modelHint: node.worker.model,
      effortHint: loomEffortToWorkerEffort(node.worker.effort),
      allowedPaths: [],
      forbiddenPaths: [],
      expectedOutputs: [],
      verificationCommands: [],
      canRunParallel: nodes.length > 1,
      conflictsWith: [],
      taskClass: "feature",
      createdBy: "spark",
      loomNodeId: node.nodeId,
      // Per-worker tool access — buildLaunchCommandLine maps these to CLI flags.
      // blockedTools is claude-only; ignored for codex tasks at launch.
      accessHint: node.access,
      blockedToolsHint: node.blockedTools,
      // When this node rendered a chat block, remember the board dir so a codex
      // launch can --add-dir it (codex's sandbox otherwise can't reach the
      // out-of-workspace mail dir). Absent when the node isn't a chat participant.
      collabMailDirHint: nodeHasChat[i] ? mailDir : undefined,
    });
    const taskId = run.workerTasks.at(-1)?.id;
    if (!taskId) throw new Error("Direct worker task creation failed.");
    taskIds.push({ nodeId: node.nodeId, taskId });
  }

  // The sandbox fork point is the run's shadow-ref checkpoint, but checkpoints
  // land through a background queue (createRun's baseline + the prompt note
  // above are both still in flight here — managed runs hide this behind
  // manager-planning latency; direct runs have none). Wait for the queue so
  // the worktree forks from the CURRENT tree: without this, pass 1 forks from
  // the default branch (empty shadow ref → resolveDefaultBranch) and chained
  // passes fork one pass stale, stranding the previous pass's merged work.
  await withCheckpointLock.wait(runId);

  // unattended:true so the user's autopilotSandbox setting applies exactly as
  // it does for managed unattended workers (worktree isolation + merge-back
  // on success are both handled inside the worker pipeline, not the manager).
  const attempts: Array<{ nodeId: string; attemptId: string }> = [];
  for (const { nodeId, taskId } of taskIds) {
    const envelope = await prepareWorkerTask({
      runId: run.id,
      workerTaskId: taskId,
      cwd,
      unattended: true,
    });
    attempts.push({ nodeId, attemptId: envelope.attemptId });
  }

  // Seed / advance RunState.loomPass for this wave: every launched node becomes
  // "running" at its layer, its attempt id recorded; pendingNodeIds is the set
  // of node ids in this wave (the join barrier finalizeDirectRun waits on).
  //
  // FIX 2 — PASS BOUNDARY vs MID-PASS. This commit rebuilds loomPass wholesale,
  // so it is the seam where pass state either carries forward (mid-pass joins +
  // bounded loops) or resets (a brand-new pass). `freshPass` distinguishes them:
  //   • freshPass (the loop driver's same-run pass-chaining launch): rebuild FROM
  //     SCRATCH — only THIS wave's nodes, activations 1, fresh attemptIds, no
  //     carried output/back-edge budget, vars from the new pass snapshot. Without
  //     this, pass 2+ of a multi-node loom would leave downstream nodes
  //     "succeeded" (never relaunched), back-edges exhausted (loops never
  //     re-fire), and activations as lifetime (not per-pass) counts. Single-node:
  //     the reset re-seeds the one running node = today's behavior exactly.
  //   • NOT freshPass (finalizeDirectRun's intra-pass advance/relaunch, AND a
  //     mid-pass answer-resume): MERGE into the existing loomPass — preserve
  //     prior node outputs/activations/back-edge budget so a within-pass wave
  //     join and a bounded loop settle correctly.
  run = await requireRun(run.id);
  await commitRunChange(run, {
    type: "direct_run.node_wave_launched",
    message: `Loom pass ${passNumber} wave launched (${attempts.length} node${attempts.length === 1 ? "" : "s"})`,
    payload: { passNumber, layer, nodeIds: attempts.map((a) => a.nodeId), freshPass },
    mutate: (draft, timestamp) => {
      const prior = draft.loomPass;
      // freshPass starts from an EMPTY state (the previous pass is discarded);
      // otherwise we merge into the prior node states.
      const nodeStates = freshPass ? {} : { ...(prior?.nodeStates ?? {}) };
      for (const { nodeId, attemptId } of attempts) {
        const existing = freshPass ? undefined : nodeStates[nodeId];
        nodeStates[nodeId] = {
          status: "running",
          attemptIds: freshPass ? [attemptId] : [...(existing?.attemptIds ?? []), attemptId],
          output: existing?.output,
          layer,
          activations: (existing?.activations ?? 0) + 1,
        };
      }
      // FIX 3(a) — pendingNodeIds is the join barrier. On a MID-PASS launch we
      // UNION the new wave with any node still recorded "blocked" that we are NOT
      // relaunching: a single-node answer-resume otherwise replaces pendingNodeIds
      // with just the resumed node, so when it succeeds the wave aggregate reads
      // "complete" and a co-blocked sibling's question is silently abandoned.
      // Keeping the still-blocked siblings pending re-enters them at the next
      // finalize. For freshPass (and single-node) this reduces to exactly the new
      // wave (a fresh pass has no prior blocked node; one node has no sibling).
      const launchSet = new Set(attempts.map((a) => a.nodeId));
      const stillBlocked = freshPass
        ? []
        : (prior?.pendingNodeIds ?? []).filter(
            (id) => !launchSet.has(id) && nodeStates[id]?.status === "blocked",
          );
      draft.loomPass = {
        graphVersion: 1,
        nodeStates,
        layerCursor: layer,
        pendingNodeIds: [...attempts.map((a) => a.nodeId), ...stillBlocked],
        // Seed the pass var snapshot on the entry wave; on a mid-pass wave preserve
        // the one the entry stored (`vars` is {} when not passed). freshPass takes
        // the NEW pass snapshot (the prior pass's vars are discarded with it).
        vars: freshPass
          ? Object.keys(vars).length > 0
            ? vars
            : undefined
          : (prior?.vars ?? (Object.keys(vars).length > 0 ? vars : undefined)),
        // SLICE 6: carry the per-back-edge fire budget across MID-PASS waves so a
        // loop's remaining-fire counters survive each wholesale rebuild. freshPass
        // drops it (undefined) so a new pass re-arms every loop from a clean slate.
        backEdgeVisits: freshPass ? undefined : prior?.backEdgeVisits,
      };
      draft.updatedAt = timestamp;
    },
  });

  scheduleAutopilotCycles(run.id, attempts.map((a) => a.attemptId));
  return requireRun(run.id);
}

// Force-fail a live (or stuck-preparing) attempt. Used by the automation-loop
// watchdog and boot recovery. Ends with finalizeDirectRun so the loop driver
// sees a terminal run.
export async function failWorkerAttempt(
  runId: string,
  attemptId: string,
  error: string,
): Promise<RunState> {
  const run = await requireRun(runId);
  const attempt = run.workerAttempts.find((a) => a.id === attemptId);
  if (!attempt) throw new Error(`Worker attempt not found: ${attemptId}`);
  if (!DIRECT_ATTEMPT_TERMINAL.has(attempt.status)) {
    await commitRunChange(run, {
      type: "worker_attempt.force_failed",
      message: `Worker attempt force-failed: ${error}`,
      payload: { attemptId, error },
      mutate: (draft, timestamp) => {
        const a = draft.workerAttempts.find((x) => x.id === attemptId);
        if (!a || DIRECT_ATTEMPT_TERMINAL.has(a.status)) return false;
        a.status = "failed";
        a.error = error;
        a.finishedAt = a.finishedAt ?? timestamp;
        const t = draft.workerTasks.find((x) => x.id === a.workerTaskId);
        if (t && !["accepted", "failed", "cancelled"].includes(t.status)) {
          t.status = "failed";
          t.updatedAt = timestamp;
        }
        const s = t?.stepId ? draft.steps.find((x) => x.id === t.stepId) : undefined;
        if (s && !["complete", "completed_unverified", "failed", "skipped"].includes(s.status)) {
          s.status = "failed";
          s.updatedAt = timestamp;
          if (draft.currentStepId === s.id) draft.currentStepId = undefined;
        }
        draft.updatedAt = timestamp;
      },
    });
    // Kill either structured transport or legacy PTY, if it is still alive.
    const active = activeWorkerProcesses.get(attemptId);
    if (active) {
      try {
        active.kill();
      } catch {
        /* already gone */
      }
      activeWorkerProcesses.delete(attemptId);
    }
    try {
      pty.dispose(attemptId);
    } catch {
      /* already gone */
    }
  }
  const latest = await requireRun(runId);
  if (latest.executionMode === "direct") await finalizeDirectRun(runId);
  return requireRun(runId);
}

// Boot-recovery: the app quit while this direct attempt was non-terminal, but
// the worker DID finish — its final-report.json is on disk. Settle the attempt
// as succeeded (never re-run completed work), converge any sandboxed edits the
// crashed process never merged back, and finalize from the report.
export async function settleRecoveredDirectAttempt(
  runId: string,
  attemptId: string,
): Promise<void> {
  const run = await requireRun(runId);
  const attempt = run.workerAttempts.find((a) => a.id === attemptId);
  if (!attempt) return;
  if (!DIRECT_ATTEMPT_TERMINAL.has(attempt.status)) {
    await commitRunChange(run, {
      type: "direct_run.attempt_recovered",
      message: "Direct worker attempt recovered from on-disk final report after restart",
      payload: { attemptId },
      mutate: (draft, timestamp) => {
        const a = draft.workerAttempts.find((x) => x.id === attemptId);
        if (!a || DIRECT_ATTEMPT_TERMINAL.has(a.status)) return false;
        a.status = "succeeded";
        a.finishedAt = a.finishedAt ?? timestamp;
        draft.updatedAt = timestamp;
      },
    });
  }
  // The in-process merge-back lives in launchWorkerAttempt's finish path — a
  // quit between the worker finishing and that merge strands the pass's edits
  // in the worktree while the loop records the pass complete (and runs its
  // untilGitClean/untilTestsPass checks against a tree that never got the
  // work). Mirror the finish path's gates here; best-effort, never throws.
  await mergeBackRecoveredSandbox(runId, attemptId).catch(() => undefined);
  await finalizeDirectRun(runId);
}

// Converge EVERY succeeded-but-unmerged sandbox attempt of a recovered run, not
// just the one the recovery table named. A crash mid-wave can strand several
// parallel siblings unmerged at once; each is its own worktree that must land in
// the base repo before the loop driver records the pass. We loop over a snapshot
// of attempt ids (each merge re-reads the run, so a fresh `requireRun` per pass
// sees the prior merge's sandboxMergedBack flag and skips it). attemptId is kept
// in the signature for call-site symmetry but no longer singles out one attempt.
async function mergeBackRecoveredSandbox(runId: string, _attemptId: string): Promise<void> {
  const settings = await loadSettings();
  if (!settings.autopilotSandbox) return;
  const initial = await requireRun(runId);
  const candidateIds = initial.workerAttempts
    .filter(
      (a) =>
        a.status === "succeeded" &&
        !a.sandboxMergedBack &&
        a.sandboxWorktreePath &&
        a.sandboxBaseRepo,
    )
    .map((a) => a.id);
  for (const id of candidateIds) {
    await mergeBackOneRecoveredAttempt(runId, id);
  }
}

// Merge ONE recovered attempt's worktree back into its base repo, serialized per
// base repo so two stranded siblings merging into the same tree can't interleave.
async function mergeBackOneRecoveredAttempt(runId: string, attemptId: string): Promise<void> {
  const run = await requireRun(runId);
  const attempt = run.workerAttempts.find((a) => a.id === attemptId);
  if (
    !attempt ||
    attempt.status !== "succeeded" || // failed work is never auto-converged
    attempt.sandboxMergedBack || // already applied by the finish path / a prior pass
    !attempt.sandboxWorktreePath ||
    !attempt.sandboxBaseRepo
  ) {
    return;
  }
  const baseRepo = attempt.sandboxBaseRepo;
  const worktreePath = attempt.sandboxWorktreePath;
  const mergeBack = await withMergeBackLock(baseRepo, () =>
    mergeBackSandboxWorktree({ repoCwd: baseRepo, worktreePath }),
  );
  const mergedAt = new Date().toISOString();
  if (mergeBack.ok) {
    await commitRunChange(run, {
      type: "worker_attempt.sandbox_merged",
      message: `Merged recovered sandbox worktree back: ${attempt.sandboxBranch ?? "(branch)"}`,
      payload: {
        attemptId,
        sandboxWorktreePath: attempt.sandboxWorktreePath,
        sandboxBranch: attempt.sandboxBranch,
        sandboxBaseRepo: attempt.sandboxBaseRepo,
        changed: mergeBack.changed,
        recovered: true,
      },
      mutate: (draft, timestamp) => {
        const a = draft.workerAttempts.find((x) => x.id === attemptId);
        if (a) a.sandboxMergedBack = true;
        draft.updatedAt = timestamp;
      },
    });
  } else {
    await appendEvent({
      timestamp: mergedAt,
      workspaceId: run.workspaceId,
      runId: run.id,
      attemptId,
      type: "worker_attempt.sandbox_merge_failed",
      message: `Recovered sandbox merge-back failed; worktree left intact: ${attempt.sandboxBranch ?? "(branch)"}`,
      payload: {
        sandboxWorktreePath: attempt.sandboxWorktreePath,
        sandboxBranch: attempt.sandboxBranch,
        sandboxBaseRepo: attempt.sandboxBaseRepo,
        error: mergeBack.error,
        recovered: true,
      },
    }).catch(() => undefined);
  }
}

// Boot-recovery: the app quit mid-iteration and no report exists. Fail the
// orphaned attempt, reset its task/step, and launch ONE fresh attempt for the
// same task in place (the loop's iteration record keeps its number — retries
// are attempt-level, not iteration-level). Returns the new attemptId, or null
// when the run/task is no longer in a relaunchable state.
export async function relaunchDirectAttempt(
  runId: string,
  attemptId: string,
): Promise<string | null> {
  const run = await requireRun(runId);
  if (run.executionMode !== "direct") return null;
  if (run.status === "paused" || run.status === "blocked" || run.status === "cancelled" || isTerminalRunStatus(run.status)) {
    return null;
  }
  const attempt = run.workerAttempts.find((a) => a.id === attemptId);
  if (!attempt) return null;
  const task = run.workerTasks.find((t) => t.id === attempt.workerTaskId);
  if (!task) return null;

  await commitRunChange(run, {
    type: "direct_run.attempt_relaunched",
    message: "Relaunching direct worker attempt after app restart",
    payload: { staleAttemptId: attemptId, workerTaskId: task.id },
    mutate: (draft, timestamp) => {
      const a = draft.workerAttempts.find((x) => x.id === attemptId);
      if (a && !DIRECT_ATTEMPT_TERMINAL.has(a.status)) {
        a.status = "failed";
        a.error = "app restarted mid-iteration";
        a.finishedAt = a.finishedAt ?? timestamp;
      }
      const t = draft.workerTasks.find((x) => x.id === task.id);
      if (t) {
        t.status = "queued";
        t.updatedAt = timestamp;
      }
      const s = t?.stepId ? draft.steps.find((x) => x.id === t.stepId) : undefined;
      if (s && !["complete", "completed_unverified", "skipped"].includes(s.status)) {
        s.status = "ready";
        s.updatedAt = timestamp;
      }
      draft.status = "running";
      draft.updatedAt = timestamp;
    },
  });

  const cwd = workspaceCwdFromRun(await requireRun(runId));
  if (!cwd) return null;
  const envelope = await prepareWorkerTask({
    runId,
    workerTaskId: task.id,
    cwd,
    unattended: true,
  });
  scheduleAutopilotCycles(runId, [envelope.attemptId]);
  return envelope.attemptId;
}

// Newest worker attempt belonging to a given loom graph node, identified by the
// node id stamped on the node's worker task. Pre-graph direct runs (no
// loomNodeId on any task) fall through to the run's newest attempt — which, for
// the single-task-per-pass shape they always had, is exactly that node's
// attempt. Returns undefined when the node has no attempt yet.
export function newestAttemptForNode(run: RunState, nodeId: string): WorkerAttempt | undefined {
  const taskIds = new Set(
    run.workerTasks.filter((t) => t.loomNodeId === nodeId).map((t) => t.id),
  );
  if (taskIds.size === 0) return run.workerAttempts.at(-1);
  for (let i = run.workerAttempts.length - 1; i >= 0; i -= 1) {
    if (taskIds.has(run.workerAttempts[i].workerTaskId)) return run.workerAttempts[i];
  }
  return undefined;
}

// Derive an attempt's iteration summary (the loop's sentinel/untilPhrase
// contract). Ladder: report.summary → cleaned pty tail → raw-log tail → honest
// placeholder. Sentinels (SPARK_LOOP_CONTINUE/DONE) survive every rung. The pty
// rung only helps in the force-fail window (runWorkerSession kills the pty
// before this review is even scheduled, and boot recovery runs in a fresh
// process) — the raw byte log persists the same stream, so its tail covers
// every normal exit.
async function deriveAttemptSummary(
  attempt: WorkerAttempt,
  report: WorkerReport | null,
): Promise<string> {
  let summary = report?.summary?.trim() ?? "";
  if (!summary) {
    const tail = pty.readTail(attempt.id, 64 * 1024);
    let rawText = tail ? tail.toString("utf8") : null;
    if (!rawText && attempt.rawLogPath) {
      rawText = await readFileTailUtf8(attempt.rawLogPath, 64 * 1024);
    }
    if (rawText) {
      const lines = stripAnsiAndControls(rawText)
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0);
      summary = lines.slice(-40).join("\n").trim();
    }
  }
  if (!summary) summary = `Worker exited (status ${attempt.status}) and produced no report.`;
  return summary;
}

// Map a single node's report/attempt outcome onto a run status. A blocked report
// holds the run open for the user; it is never coerced to complete. No report +
// clean exit counts as success (the CLI may have answered a trivial pass without
// writing the report).
function mapDirectOutcome(
  reportStatus: WorkerReport["status"] | undefined,
  attemptStatus: WorkerAttemptStatus,
): RunStatus {
  if (reportStatus === "blocked") return "blocked";
  if (reportStatus === "complete" || reportStatus === "partial") return "complete";
  if (reportStatus === "failed") return "failed";
  return attemptStatus === "succeeded" ? "complete" : "failed";
}

// Fetch the loom's node graph for this direct run (via its automationId). Returns
// undefined for pre-graph runs / unknown jobs / non-loom runs — the caller then
// keeps the degenerate single-wave terminalize behavior, so single-node looms
// (and pre-graph runs) are unaffected. Lazily imports scheduler to avoid a static
// cycle (scheduler already lazy-imports run-store), matching direct-worker.ts.
async function loomGraphForRun(run: RunState): Promise<LoomGraph | undefined> {
  if (!run.automationId) return undefined;
  try {
    const { getJob } = await import("./scheduler");
    const job = await getJob(run.automationId);
    return job?.graph;
  } catch {
    return undefined;
  }
}

// The direct-run replacement for the manager review: read each settled wave
// node's final report, derive its summary, map the outcome, and either ADVANCE
// the pass to the next ready wave (sequential chains) or TERMINALIZE the run.
// Runs through commitRunChange so the complete-transition plumbing (seen bit,
// run memory, notifications) fires identically to a managed completion.
//
// Looms v2.5: a loom PASS executes its graph node-by-node as worker attempts in
// THIS one run, layer by layer, with the autopilot join barrier as the wave
// boundary. finalizeDirectRun is the join: it only settles once EVERY node in
// the current wave (loomPass.pendingNodeIds) has its newest attempt terminal.
// For a single-node loom a pass has exactly ONE node, so "every pending node's
// newest attempt is terminal" reduces to "workerAttempts.at(-1) is terminal" —
// byte-identical to the pre-graph behavior. (Pre-graph direct runs with no
// loomPass fall through to the same single-attempt path.)
async function finalizeDirectRun(runId: string): Promise<void> {
  const run = await requireRun(runId);
  if (run.executionMode !== "direct") return;
  // paused/cancelled are user decisions; blocked/terminal mean this iteration
  // was already decided (idempotency under watchdog + cycle double-fires).
  if (run.status === "paused" || run.status === "blocked" || run.status === "cancelled") return;
  if (isTerminalRunStatus(run.status)) return;

  // The wave's pending nodes (the join barrier). When loomPass is present, the
  // pass's current layer; otherwise the degenerate single-node case keyed off
  // the newest attempt, exactly as before.
  const pendingNodeIds =
    run.loomPass && run.loomPass.pendingNodeIds.length > 0
      ? run.loomPass.pendingNodeIds
      : undefined;

  // Map each pending node to its newest attempt; bail unless they are ALL
  // terminal (the join hasn't completed yet). For one pending node this is the
  // same `workerAttempts.at(-1)` terminal check as the pre-graph code.
  const waveAttempts: Array<{ nodeId: string; attempt: WorkerAttempt }> = [];
  if (pendingNodeIds) {
    // ADVANCE idempotency: while terminalizing flips the run terminal (so a
    // re-entry early-returns on isTerminalRunStatus above), ADVANCING leaves the
    // run "running". A re-entry in the narrow window between the settle commit
    // (which marks the wave's nodes succeeded) and the next-wave seed would see
    // the SAME pending nodes with terminal attempts and try to settle/advance
    // them again — a duplicate wave. Guard on the recorded node status: once a
    // pending node is no longer "running"/"pending" in loomPass, this wave was
    // already processed, so bail. (A still-"running" node means a genuinely
    // fresh join.) A RELAUNCH (retry) leaves its node "running" but re-launches
    // it WITHIN this same finalizeDirectRun call — by the time any re-entry could
    // fire (the review is single-flight per run), the fresh retry attempt is the
    // node's newest and is non-terminal, so the per-node terminal check below
    // bails; relaunch needs no separate idempotency flag here.
    const recorded = run.loomPass?.nodeStates;
    if (recorded && pendingNodeIds.every((id) => {
      const st = recorded[id]?.status;
      return st !== undefined && st !== "running" && st !== "pending";
    })) {
      return;
    }
    for (const nodeId of pendingNodeIds) {
      const a = newestAttemptForNode(run, nodeId);
      if (!a || !DIRECT_ATTEMPT_TERMINAL.has(a.status)) return; // wave not joined yet
      waveAttempts.push({ nodeId, attempt: a });
    }
  } else {
    const a = run.workerAttempts.at(-1);
    if (!a || !DIRECT_ATTEMPT_TERMINAL.has(a.status)) return;
    waveAttempts.push({ nodeId: run.loomPass?.pendingNodeIds[0] ?? "w0", attempt: a });
  }

  // The loom's node graph (via automationId). Needed up-front this slice for
  // BOTH per-node worker retry (read node.retry) and guard resolution. Undefined
  // for pre-graph / non-loom runs — those keep the degenerate single-wave path.
  const graph: LoomGraph | undefined = run.loomPass ? await loomGraphForRun(run) : undefined;
  const nodeById = new Map<string, LoomNodeDef>((graph?.nodes ?? []).map((n) => [n.id, n]));
  // cwd for predicate evaluation (retry-until + guard predicates) — shared with
  // the advance launch below. Undefined-safe: predicates that need a shell never
  // run with an empty cwd (the advance/relaunch re-checks cwd before launching).
  const predicateCwd = workspaceCwdFromRun(run) ?? "";

  // Settle EVERY wave node: derive its summary + per-node outcome. For a
  // sequential chain the wave is one node, so this loops once.
  const settled: Array<{
    nodeId: string;
    attempt: WorkerAttempt;
    summary: string;
    reportStatus: WorkerReport["status"] | undefined;
    nodeStatus: "succeeded" | "failed" | "blocked";
  }> = [];
  for (const { nodeId, attempt } of waveAttempts) {
    const report = attempt.finalReportPath ? await readWorkerReport(attempt.finalReportPath) : null;
    const summary = await deriveAttemptSummary(attempt, report);
    const outcome = mapDirectOutcome(report?.status, attempt.status);
    settled.push({
      nodeId,
      attempt,
      summary,
      reportStatus: report?.status,
      nodeStatus: outcome === "complete" ? "succeeded" : outcome === "blocked" ? "blocked" : "failed",
    });
  }

  // ── SLICE 5: per-node worker RETRY ────────────────────────────────────────
  // BEFORE treating a settled WORKER node as succeeded/failed, honor a retry
  // clause: the node is "satisfied" iff it succeeded AND (no retry.until OR the
  // until-predicate holds against its OWN just-produced output). When not
  // satisfied and activations remain, the node RE-LAUNCHES as a fresh single-
  // node wave (the run stays RUNNING — we neither advance nor fail). When not
  // satisfied and activations are exhausted, it has failed (fails the pass as
  // today). A blocked node never retries (blocked holds the pass). A worker with
  // no retry behaves EXACTLY as today (effective === its nodeStatus). This is a
  // bounded self-retry, NOT a graph back-edge.
  const effective: Array<{
    nodeId: string;
    effectiveStatus: "succeeded" | "failed" | "blocked" | "relaunch";
  }> = [];
  for (const s of settled) {
    const node = nodeById.get(s.nodeId);
    const retry = node && node.kind === "worker" ? node.retry : undefined;
    if (!retry || retry.maxAttempts <= 0 || s.nodeStatus === "blocked") {
      effective.push({ nodeId: s.nodeId, effectiveStatus: s.nodeStatus });
      continue;
    }
    const succeeded = s.nodeStatus === "succeeded";
    // until held? No until ⇒ true; else evaluate against this node's own output
    // (the worker's just-produced summary) + its forward-parents' outputs.
    let untilHeld = true;
    if (succeeded && retry.until) {
      const incomingOutputs: Record<string, string> = {};
      if (graph) {
        for (const pid of upstreamOf(graph, s.nodeId)) {
          const out = run.loomPass?.nodeStates[pid]?.output;
          if (out !== undefined) incomingOutputs[pid] = out;
        }
      }
      untilHeld = await evaluateGuardPredicate(retry.until, {
        cwd: predicateCwd,
        sourceOutput: s.summary,
        incomingOutputs,
      });
    } else if (!succeeded) {
      untilHeld = false;
    }
    const activations = run.loomPass?.nodeStates[s.nodeId]?.activations ?? 0;
    const disposition = retryDisposition({
      succeeded,
      untilHeld,
      activations,
      maxAttempts: retry.maxAttempts,
    });
    effective.push({
      nodeId: s.nodeId,
      effectiveStatus:
        disposition === "satisfied" ? "succeeded" : disposition === "relaunch" ? "relaunch" : "failed",
    });
  }
  const effOf = (nodeId: string) =>
    effective.find((e) => e.nodeId === nodeId)?.effectiveStatus ?? "succeeded";
  const relaunchNodeIds = effective.filter((e) => e.effectiveStatus === "relaunch").map((e) => e.nodeId);

  // Aggregate wave outcome (retry-aware). Precedence: any blocked node blocks the
  // pass (holds for the user); else any failed/exhausted node fails the pass;
  // else any node wants to RELAUNCH (the pass continues running, no advance);
  // else the wave fully succeeded and we advance/terminalize. Blocked and
  // failure are checked BEFORE relaunch so a hard failure/hold in the same wave
  // wins over a sibling's pending re-attempt (matching "any failed node fails").
  const aggregate: RunStatus = effective.some((e) => e.effectiveStatus === "blocked")
    ? "blocked"
    : effective.some((e) => e.effectiveStatus === "failed")
      ? "failed"
      : "complete";
  const relaunching = aggregate === "complete" && relaunchNodeIds.length > 0;

  // ── SLICE 4/5: decide ADVANCE vs TERMINALIZE (inline merge + guard join) ──
  // Only a fully-succeeded wave (and one with no pending retry relaunch) can
  // advance. Project the just-settled worker nodes onto the pass's nodeStates,
  // then run the INLINE-RESOLUTION LOOP that — each turn — resolves every ready
  // MERGE (its output is the labeled concat of its succeeded parents) AND every
  // ready GUARD (await its predicate; record branchResult pass/fail), then prunes
  // the now-dead-only branches to "skipped" (computeSkips), feeding all of it back
  // into the projection. Repeat until stable, so a chain of merges/guards/skips
  // collapses in ONE finalize. THEN ask the pure walk for the next WORKER wave.
  // If it is all-worker we keep the run RUNNING and launch it; if empty AND the
  // pass is complete we terminalize; if it still contains a non-worker node we
  // terminalize cleanly rather than dropping it. A failed/blocked wave (or a
  // relaunch) never advances. A single-node loom (or any sink wave) resolves
  // nothing, nextReadyWave is [] and it terminalizes — identical to slice 3.
  let nextWaveNodeIds: string[] = [];
  let nextWaveNodes: LoomNodeDef[] = [];
  // Merge nodes resolved inline by the loop below: their status flips to
  // "succeeded" with the joined output, persisted in the SAME advance commit so
  // {{node:<mergeId>}} / {{incoming}} downstream and boot recovery see them.
  const resolvedMerges: Array<{ nodeId: string; output: string }> = [];
  // Guard nodes resolved inline (status succeeded + which branch they routed) and
  // the nodes pruned dead by those routes (status skipped). Both are persisted in
  // the SAME advance commit; neither launches an attempt nor pushes a note.
  const resolvedGuards: Array<{ nodeId: string; branch: "pass" | "fail"; output: string }> = [];
  const skippedNodeIds = new Set<string>();
  // ── SLICE 6: bounded loop-back state for this advance ──────────────────────
  // The per-edge fire counters carried into this advance (defaults {} for an
  // acyclic / pre-slice-6 pass). `workingVisits` is a mutable copy bumped each
  // time a back-edge fires below; it is persisted in the advance commit so the
  // remaining-fire budget survives a restart mid-cycle. `resetByBackEdge`
  // collects every node a fired back-edge flips back to "pending" so the commit
  // re-applies the reset to the durable nodeStates. `backEdgeFired` flags that at
  // least one loop re-opened (drives the commit message + the activation-cap
  // bookkeeping). `activationCapHit` short-circuits to a failed terminalization
  // (the second, per-pass termination bound) when re-launching would run away.
  const workingVisits: Record<string, number> = { ...(run.loomPass?.backEdgeVisits ?? {}) };
  const resetByBackEdge = new Set<string>();
  let backEdgeFired = false;
  let activationCapHit = false;
  if (aggregate === "complete" && !relaunching && run.loomPass && graph) {
    // Local projection of the pass's node states: status + output + branchResult.
    // Seeded from the recorded states, then the just-settled worker nodes'
    // summaries are layered on top (relaunch nodes are excluded by the
    // !relaunching guard above, so every settled node here is succeeded).
    const projected: Record<
      string,
      {
        status: "pending" | "skipped" | "running" | "succeeded" | "failed" | "blocked";
        output?: string;
        branchResult?: "pass" | "fail";
      }
    > = {};
    for (const [id, ns] of Object.entries(run.loomPass.nodeStates)) {
      projected[id] = { status: ns.status, output: ns.output, branchResult: ns.branchResult };
    }
    for (const s of settled) projected[s.nodeId] = { status: "succeeded", output: s.summary };

    // Cumulative worker-node activations across the whole pass so far — the input
    // to the per-pass activation backstop (bound 2). Every launch/relaunch/loop
    // re-launch bumped a node's activations by 1, so this sum monotonically grows.
    const totalActivations = (): number =>
      Object.values(run.loomPass!.nodeStates).reduce((sum, ns) => sum + (ns.activations ?? 0), 0);

    // Reset one back-edge's loop body in the projection: every body node flips
    // back to "pending" with output/branchResult cleared (a fresh re-run), so the
    // body re-enters readiness. CRUCIALLY also un-skip every node FORWARD-REACHABLE
    // from the body — the loop-EXIT branch a body guard pruned to "skipped" on the
    // prior fail-turn (e.g. the "DONE" sink past a fix-until guard) must become
    // "pending" again so a later turn's guard routing can re-reach it; otherwise a
    // loop could never exit to its sink. computeSkips re-prunes from the fresh
    // routing on the next stabilization turn, so un-skipping never wrongly runs a
    // node — it only restores eligibility. Body nodes (which actually re-run) and
    // descendant exits (which become eligible) both persist as "pending".
    const resetCycleBody = (resetNodes: string[]) => {
      const widen = new Set<string>(resetNodes);
      for (const id of forwardDescendants(graph!, resetNodes)) widen.add(id);
      for (const id of widen) {
        projected[id] = { status: "pending" };
        resetByBackEdge.add(id);
        // A node re-opened by a loop is no longer a settled skip; drop any stale
        // skip record so the persisted state matches the live re-run.
        skippedNodeIds.delete(id);
      }
    };

    // OUTER loop: stabilize merges/guards/skips, THEN fire any armed+firable
    // back-edges (which re-open loop bodies), THEN re-stabilize — repeating until
    // a turn neither resolves anything NOR fires a back-edge. Bounded by the
    // per-edge visitCap (an exhausted edge stops firing) AND, defensively, by an
    // iteration cap derived from the total fire budget so a malformed graph can't
    // spin even before the activation backstop trips. computeSkips/merge/guard are
    // monotonic within a stabilization; a back-edge reset is the only thing that
    // re-opens them, and each fire consumes one unit of an edge's bounded budget.
    const maxBackEdgeFires =
      graph.edges.filter((e) => e.backEdge === true).length * MAX_BACK_EDGE_VISIT_CAP + 1;
    for (let outer = maxBackEdgeFires; outer >= 0; outer -= 1) {
      // Inline-resolution loop: resolve ready merges + guards, then prune. Each
      // resolved merge/guard feeds the projection so a downstream merge/guard can
      // become ready next turn; pruning a branch can in turn ready a merge whose
      // skipped parents now let "any"/"all" settle. Bounded by the node count + 1
      // (each merge/guard resolves at most once — it only leaves "pending" when
      // picked up here, and skips are monotonic).
      for (let bound = graph.nodes.length + 1; bound >= 0; bound -= 1) {
        let progressed = false;
        // Merges first (pure): a guard downstream of a merge reads the joined output.
        for (const mergeId of readyMergeNodes(graph, projected)) {
          const output = mergeOutput(graph, mergeId, projected);
          projected[mergeId] = { status: "succeeded", output };
          resolvedMerges.push({ nodeId: mergeId, output });
          progressed = true;
        }
        // Guards (impure: await the predicate). The guard's source output is its
        // single forward parent's output; incomingOutputs maps every forward parent.
        for (const guardId of readyGuardNodes(graph, projected)) {
          const parents = upstreamOf(graph, guardId);
          const incomingOutputs: Record<string, string> = {};
          for (const pid of parents) {
            const out = projected[pid]?.output;
            if (out !== undefined) incomingOutputs[pid] = out;
          }
          const sourceOutput = parents.length > 0 ? (projected[parents[0]]?.output ?? "") : "";
          const node = nodeById.get(guardId);
          const predicate = node && node.kind === "guard" ? node.predicate : undefined;
          const passed = predicate
            ? await evaluateGuardPredicate(predicate, {
                cwd: predicateCwd,
                sourceOutput,
                incomingOutputs,
              })
            : false;
          const branch: "pass" | "fail" = passed ? "pass" : "fail";
          const output = `guard: ${branch}`;
          projected[guardId] = { status: "succeeded", output, branchResult: branch };
          resolvedGuards.push({ nodeId: guardId, branch, output });
          progressed = true;
        }
        // Prune branches whose every path just went dead (transitive closure).
        const skips = computeSkips(graph, projected);
        for (const id of skips) {
          projected[id] = { ...(projected[id] ?? { status: "pending" }), status: "skipped" };
          skippedNodeIds.add(id);
          progressed = true;
        }
        if (!progressed) break;
      }

      // The stabilized projection is settled for this turn. Now fire any armed +
      // firable back-edges: an armed back-edge whose source ROUTED to it AND whose
      // per-edge visit budget remains. Firing resets its loop body to "pending"
      // (re-opening readiness) and consumes one unit of its budget. An exhausted
      // (or un-armed) back-edge does NOT fire — the loop EXITS and flow falls
      // through (the guard's other branch / downstream of the body). Acyclic
      // graphs have no back-edge, so this is [] and the outer loop runs once.
      const firing = backEdgesToFire(graph, projected, workingVisits);
      if (firing.length === 0) break;
      for (const { edge, resetNodes } of firing) {
        workingVisits[edge.id] = (workingVisits[edge.id] ?? 0) + 1;
        resetCycleBody(resetNodes);
        backEdgeFired = true;
      }
      // Re-stabilize on the next outer iteration (the reset re-opened the body).
    }

    if (!isPassComplete(graph, projected, workingVisits)) {
      const ready = nextReadyWave(graph, projected);
      nextWaveNodes = ready.map((id) => nodeById.get(id)).filter((n): n is LoomNodeDef => Boolean(n));
      // Only WORKER nodes are launchable as a wave. Merges + guards were already
      // resolved inline above (so neither can appear here); if the ready wave
      // still contains any non-worker node, do NOT advance: terminalize cleanly
      // rather than dropping it.
      if (nextWaveNodes.length === ready.length && nextWaveNodes.every((n) => n.kind === "worker")) {
        // ── Bound 2: per-pass activation backstop. Launching this wave bumps each
        // of its nodes' activations by 1; if that would push the pass's cumulative
        // worker activations over MAX_PASS_ACTIVATIONS, do NOT advance — fail the
        // pass with a clear cap message. This is the independent backstop that
        // guarantees termination even if a back-edge's visitCap were mis-set or
        // many back-edges interleaved. Acyclic / normally-bounded passes never
        // approach the cap, so this is inert for every slice-1..5 graph.
        if (totalActivations() + ready.length > MAX_PASS_ACTIVATIONS) {
          activationCapHit = true;
          nextWaveNodeIds = [];
          nextWaveNodes = [];
        } else {
          nextWaveNodeIds = ready;
        }
      } else {
        nextWaveNodeIds = [];
        nextWaveNodes = [];
      }
    }
  }
  const advancing = nextWaveNodeIds.length > 0;

  // SLICE 6: the per-pass activation backstop tripped — the loom kept re-opening
  // loop bodies past the safe cap. Terminalize the pass as FAILED with a clear,
  // self-explaining summary (recorded as the pass's last spark note below). This
  // never coincides with advancing/relaunching (the cap check only fires when we
  // would otherwise advance, and zeroes nextWaveNodeIds), so the run terminalizes.
  const activationCapSummary =
    "Loom graph exceeded the per-pass activation cap " +
    `(${MAX_PASS_ACTIVATIONS}); a loop-back never terminated. Pass failed.`;

  // The run status this commit lands on: keep RUNNING when advancing (the next
  // wave is about to launch) OR relaunching (a retry node re-runs in place),
  // else the aggregate terminal status — UNLESS the activation backstop tripped,
  // in which case the pass fails outright. advancing and relaunching are mutually
  // exclusive: relaunching short-circuits the advance block (its !relaunching
  // guard leaves nextWaveNodeIds empty).
  const stayingLive = advancing || relaunching;
  let committedStatus: RunStatus = activationCapHit
    ? "failed"
    : stayingLive
      ? "running"
      : aggregate;

  // FIX 3(b) — co-blocked sibling backstop. Before terminalizing a non-staying-
  // live "complete" run, scan the WHOLE pass for any node still recorded
  // "blocked" whose newest attempt is terminal (a report-blocked node from an
  // earlier wave whose question is still unanswered). A single-node answer-resume
  // that succeeds would otherwise let the wave aggregate read "complete" while a
  // sibling node is still blocked — terminalizing the run and abandoning the
  // sibling's question. Forcing "blocked" re-enters the run blocked so
  // maybeResumeAnsweredPass re-fires for the sibling. Settled-this-wave nodes are
  // excluded (their fresh status is in `settled`, not yet in nodeStates). For a
  // single-node loom / pre-graph run there is no sibling, so this never fires.
  if (!stayingLive && !activationCapHit && committedStatus === "complete" && run.loomPass) {
    const settledThisWave = new Set(settled.map((s) => s.nodeId));
    const hasBlockedSibling = Object.entries(run.loomPass.nodeStates).some(([nodeId, ns]) => {
      if (ns.status !== "blocked" || settledThisWave.has(nodeId)) return false;
      const att = newestAttemptForNode(run, nodeId);
      return Boolean(att && DIRECT_ATTEMPT_TERMINAL.has(att.status));
    });
    if (hasBlockedSibling) committedStatus = "blocked";
  }

  // FIX 3(c) — duplicate-question dedupe. A node that settles "blocked" again
  // with the SAME question (e.g. an idempotent finalize re-entry, or a co-blocked
  // sibling whose state is re-walked) must NOT push a second identical question
  // note (it would spam the Hub and confuse answerForBlockedNode's newest-question
  // scan). Captured PRE-commit: for each node that will settle blocked, its prior
  // recorded status and the newest question message it already left. The mutate
  // skips the push only when the node is ALREADY recorded blocked with an
  // identical message; a new or changed question is always pushed.
  const priorBlockedNote = new Map<string, { status: string | undefined; message: string | undefined }>();
  for (const s of settled) {
    if (s.nodeStatus !== "blocked") continue;
    const recorded = run.loomPass?.nodeStates[s.nodeId]?.status;
    let lastQuestion: string | undefined;
    for (let i = run.humanMessages.length - 1; i >= 0; i -= 1) {
      const m = run.humanMessages[i];
      if (m.author === "spark" && m.kind === "question" && m.loomNodeId === s.nodeId) {
        lastQuestion = m.message;
        break;
      }
    }
    priorBlockedNote.set(s.nodeId, { status: recorded, message: lastQuestion });
  }

  await commitRunChange(run, {
    type: "direct_run.finalized",
    message: activationCapHit
      ? `Loom pass failed: per-pass activation cap (${MAX_PASS_ACTIVATIONS}) exceeded`
      : advancing
        ? backEdgeFired
          ? `Loom wave settled; looping back to ${nextWaveNodeIds.join(", ")}`
          : `Loom wave settled; advancing to ${nextWaveNodeIds.join(", ")}`
        : relaunching
          ? `Loom wave settled; retrying ${relaunchNodeIds.join(", ")}`
          : `Loom iteration finalized: ${aggregate}`,
    payload: {
      attemptIds: settled.map((s) => s.attempt.id),
      reportStatuses: settled.map((s) => s.reportStatus ?? null),
      nextStatus: committedStatus,
      settledNodeIds: settled.map((s) => s.nodeId),
      advancingTo: advancing ? nextWaveNodeIds : null,
      retryingNodeIds: relaunching ? relaunchNodeIds : null,
      resolvedMergeNodeIds: resolvedMerges.length > 0 ? resolvedMerges.map((m) => m.nodeId) : null,
      resolvedGuardNodeIds: resolvedGuards.length > 0 ? resolvedGuards.map((g) => g.nodeId) : null,
      skippedNodeIds: skippedNodeIds.size > 0 ? [...skippedNodeIds] : null,
      // SLICE 6: which loop bodies a back-edge re-opened this advance, and the
      // updated per-edge fire budget (observability + boot-recovery audit trail).
      loopBackResetNodeIds: backEdgeFired ? [...resetByBackEdge] : null,
      backEdgeVisits: backEdgeFired ? { ...workingVisits } : null,
      activationCapExceeded: activationCapHit ? true : null,
    },
    mutate: (draft, timestamp) => {
      if (draft.status === "paused" || draft.status === "cancelled" || draft.status === "blocked") {
        return false;
      }
      if (isTerminalRunStatus(draft.status)) return false;
      for (const s of settled) {
        // A node electing to RELAUNCH (bounded retry) is NOT settled here: it
        // stays running and is re-launched right after this commit (which bumps
        // its activations + appends a fresh attempt). Skipping it leaves its
        // task/step/nodeState untouched and pushes NO spark note (the re-launch
        // owns the next attempt's transcript).
        const eff = effOf(s.nodeId);
        if (eff === "relaunch") continue;
        const t = draft.workerTasks.find((x) => x.id === s.attempt.workerTaskId);
        if (t) {
          t.status = eff === "succeeded" ? "accepted" : eff === "blocked" ? "blocked" : "failed";
          t.updatedAt = timestamp;
        }
        const step = t?.stepId ? draft.steps.find((x) => x.id === t.stepId) : undefined;
        if (step && eff !== "blocked") {
          step.status = eff === "succeeded" ? "complete" : "failed";
          step.updatedAt = timestamp;
          if (draft.currentStepId === step.id) draft.currentStepId = undefined;
        }
        // Record the settled node's outcome + output into the loom pass, keyed
        // by node id so the advance walk (and later slices) read per-node
        // results. The advance launch below feeds these as {{node:<id>}} /
        // {{incoming}} to the next wave. (Uses the retry-effective status so an
        // exhausted retry records "failed".)
        if (draft.loomPass) {
          const ns = draft.loomPass.nodeStates[s.nodeId];
          if (ns) {
            ns.status = eff;
            ns.output = s.summary;
          }
        }
        // The summary message IS the loop contract: automation-loop scans the
        // LAST spark note for sentinels/untilPhrase and renders it in history.
        // Pushed in the SAME commit that flips status so the completion-summary
        // suppressor sees it and never appends a templated duplicate after it.
        // Stamped with the node id so per-node attribution survives in the
        // transcript. When terminalizing a chain, the sink node settles last, so
        // its note is the LAST spark note — exactly the pass-level summary
        // onTerminal reads. (undefined-safe for pre-graph runs.)
        //
        // FIX 3(c): a node re-settling blocked with the SAME question it already
        // asked must not push a duplicate question note (the Hub would show it
        // twice and answerForBlockedNode's newest-question scan would re-pair it).
        // Only suppress when the node was ALREADY recorded blocked with an
        // identical message; a new/changed question still pushes.
        const priorNote = priorBlockedNote.get(s.nodeId);
        const isDuplicateQuestion =
          eff === "blocked" && priorNote?.status === "blocked" && priorNote.message === s.summary;
        if (!isDuplicateQuestion) {
          const messageId = makeId("msg");
          draft.humanMessages.push({
            id: messageId,
            clientMessageId:
              eff === "blocked"
                ? `loom-question-${draft.id}-${s.nodeId}-${s.attempt.id}`
                : undefined,
            runId: draft.id,
            author: "spark",
            kind: eff === "blocked" ? "question" : "note",
            message: s.summary,
            attachments: [],
            intent: "answer",
            deliveryState: "acknowledged",
            conversationEpoch: conversationEpoch(draft),
            createdAt: timestamp,
            loomNodeId: s.nodeId,
          });
        }
      }
      // Persist every inline-resolved MERGE node's status="succeeded" + joined
      // output into loomPass.nodeStates in the SAME commit, so the advance launch
      // below feeds {{node:<mergeId>}} / {{incoming}} from it AND boot recovery
      // re-derives the same frontier. A merge launches NO worker, so it gets no
      // task/step transition and pushes NO humanMessages note (it is not a worker
      // and must not become the pass's last spark note). Merge nodes are absent
      // from nodeStates (launchDirectNodeTasks only seeds launched nodes), so the
      // entry is CREATED here with an empty attemptIds list, layer = the next
      // layer above the current cursor (it resolves between waves).
      if (draft.loomPass) {
        const mergeLayer = (draft.loomPass.layerCursor ?? 0) + 1;
        for (const m of resolvedMerges) {
          const existing = draft.loomPass.nodeStates[m.nodeId];
          draft.loomPass.nodeStates[m.nodeId] = {
            status: "succeeded",
            attemptIds: existing?.attemptIds ?? [],
            output: m.output,
            layer: existing?.layer ?? mergeLayer,
            activations: existing?.activations,
          };
        }
        // Persist every inline-resolved GUARD: status="succeeded" + branchResult
        // (which branch it routed) + a short "guard: pass/fail" output. Like a
        // merge it launches NO worker, gets no task/step transition and pushes NO
        // note. Created here if absent (guards aren't seeded by the launcher).
        // edgeIsLive reads branchResult to prune the un-taken branch.
        const guardLayer = (draft.loomPass.layerCursor ?? 0) + 1;
        for (const g of resolvedGuards) {
          const existing = draft.loomPass.nodeStates[g.nodeId];
          draft.loomPass.nodeStates[g.nodeId] = {
            status: "succeeded",
            attemptIds: existing?.attemptIds ?? [],
            output: g.output,
            layer: existing?.layer ?? guardLayer,
            activations: existing?.activations,
            branchResult: g.branch,
          };
        }
        // Persist every pruned node as "skipped" so the walk treats it as settled
        // (never launched, never waited on) and boot recovery re-derives the same
        // dead frontier. A skipped node launches no worker and pushes no note.
        const skipLayer = (draft.loomPass.layerCursor ?? 0) + 1;
        for (const id of skippedNodeIds) {
          const existing = draft.loomPass.nodeStates[id];
          draft.loomPass.nodeStates[id] = {
            status: "skipped",
            attemptIds: existing?.attemptIds ?? [],
            output: existing?.output,
            layer: existing?.layer ?? skipLayer,
            activations: existing?.activations,
            branchResult: existing?.branchResult,
          };
        }
        // ── SLICE 6: reset every fired-back-edge loop-body node to "pending" ──
        // Applied LAST so it OVERRIDES the settled/merge/guard/skip persistence
        // above for any node a back-edge re-opened: clear status→pending,
        // output→undefined, branchResult→undefined; PRESERVE attemptIds history
        // (the prior attempts happened) and activations (the activation backstop
        // counts cumulative launches across the whole pass — never decremented).
        // The just-settled worker's completion note was still pushed above (the
        // attempt really ran); the RESET itself pushes NO note — only the node's
        // NEXT re-run attempt will, when it settles. nextReadyWave then re-surfaces
        // the re-opened body as the next worker wave (launched after this commit).
        for (const id of resetByBackEdge) {
          const existing = draft.loomPass.nodeStates[id];
          draft.loomPass.nodeStates[id] = {
            status: "pending",
            attemptIds: existing?.attemptIds ?? [],
            output: undefined,
            layer: existing?.layer ?? (draft.loomPass.layerCursor ?? 0),
            activations: existing?.activations,
            branchResult: undefined,
          };
        }
        // Persist the updated per-back-edge fire budget so a restart mid-cycle
        // resumes with the same remaining fires (recoverDirectRuns re-derives the
        // wave from pendingNodeIds; the durable backEdgeVisits gate the next fire).
        // Only written when a back-edge actually fired (acyclic passes leave it
        // undefined — byte-identical to slice 1..5).
        if (backEdgeFired) draft.loomPass.backEdgeVisits = { ...workingVisits };
      }
      // SLICE 6: the per-pass activation backstop tripped — terminalize FAILED.
      // Push the cap summary as the LAST spark note so onTerminal surfaces the
      // reason (mirrors a settled worker's note being the pass-level summary). No
      // node settled into a note this turn when the cap trips at a fresh advance,
      // so this note is the pass's terminal summary.
      if (activationCapHit) {
        draft.humanMessages.push({
          id: makeId("msg"),
          runId: draft.id,
          author: "spark",
          kind: "note",
          message: activationCapSummary,
          attachments: [],
          intent: "answer",
          deliveryState: "acknowledged",
          conversationEpoch: conversationEpoch(draft),
          createdAt: timestamp,
        });
      }
      // ADVANCE (chain continues) / RELAUNCH (retry in place): leave the run
      // RUNNING — the next wave (or the retry attempt) is launched right after
      // this commit. TERMINALIZE (sink reached / failed / blocked): flip to the
      // aggregate terminal status as the pre-graph code did.
      draft.status = committedStatus;
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
        status: stayingLive
          ? "running"
          : committedStatus === "complete"
            ? "idle"
            : committedStatus === "blocked"
              ? "blocked"
              : "failed",
        lastAction: advancing
          ? "direct_run_wave_advanced"
          : relaunching
            ? "direct_run_node_retried"
            : "direct_run_finalized",
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
  });

  // RELAUNCH: a bounded per-node retry — re-run the unsatisfied node(s) IN PLACE
  // at the SAME layer (not a graph advance). The commit above left the run
  // RUNNING and did NOT settle these nodes; launchDirectNodeTasks appends a fresh
  // attempt, bumps activations, flips them back to "running", and resets
  // pendingNodeIds to exactly the retry nodes — so the next finalize re-evaluates
  // only them against this same projection. Re-render the node's ORIGINAL prompt
  // against current vars + upstream outputs (a retry is a fresh attempt of the
  // same instruction, not a continuation).
  if (relaunching && graph) {
    const fresh = await requireRun(runId);
    if (fresh.status !== "running") return;
    const cwd = workspaceCwdFromRun(fresh);
    if (!cwd) return;
    const vars = fresh.loomPass?.vars ?? {};
    const nodeOutputs: Record<string, string> = {};
    for (const [id, ns] of Object.entries(fresh.loomPass?.nodeStates ?? {})) {
      if (ns.output !== undefined) nodeOutputs[id] = ns.output;
    }
    const passNumber = fresh.steps.length + 1;
    const retryLayer = fresh.loomPass?.layerCursor ?? 0; // SAME layer (retry in place)
    const retryNodes = relaunchNodeIds
      .map((id) => nodeById.get(id))
      .filter((n): n is Extract<LoomNodeDef, { kind: "worker" }> => n?.kind === "worker");
    await launchDirectNodeTasks(
      runId,
      cwd,
      passNumber,
      retryNodes.map((wn) => ({
        nodeId: wn.id,
        template: wn.prompt,
        worker: wn.worker,
        incoming: upstreamOf(graph!, wn.id),
        label: wn.label,
        access: wn.access,
        blockedTools: wn.blockedTools,
        collab: wn.collab,
      })),
      { layer: retryLayer, vars, nodeOutputs, addPromptNotes: true },
    );
    return; // run stays live; the retry's finalize will decide again
  }

  // ADVANCE: launch the next ready wave in the SAME run. The commit above left
  // the run RUNNING and recorded the upstream outputs; build the launch
  // descriptors (template = node.prompt, incoming = forward parents) and hand
  // them to launchDirectNodeTasks, which renders each via renderNodePrompt
  // against the pass vars + those outputs. No terminal status was pushed, so
  // the loop driver keeps holding until the SINK wave finalizes.
  if (advancing && graph) {
    const fresh = await requireRun(runId);
    // Re-check: a pause/cancel/block could have landed between the commit and
    // here (the mutate bails on those, but the cache could still have flipped).
    if (fresh.status !== "running") return;
    const cwd = workspaceCwdFromRun(fresh);
    if (!cwd) return;
    const vars = fresh.loomPass?.vars ?? {};
    const nodeOutputs: Record<string, string> = {};
    for (const [id, ns] of Object.entries(fresh.loomPass?.nodeStates ?? {})) {
      if (ns.output !== undefined) nodeOutputs[id] = ns.output;
    }
    const passNumber = fresh.steps.length + 1;
    const nextLayer = (fresh.loomPass?.layerCursor ?? 0) + 1;
    await launchDirectNodeTasks(
      runId,
      cwd,
      passNumber,
      nextWaveNodes.map((node) => {
        const wn = node as Extract<LoomNodeDef, { kind: "worker" }>;
        return {
          nodeId: wn.id,
          template: wn.prompt,
          worker: wn.worker,
          incoming: upstreamOf(graph!, wn.id),
          label: wn.label,
          access: wn.access,
          blockedTools: wn.blockedTools,
          collab: wn.collab,
        };
      }),
      { layer: nextLayer, vars, nodeOutputs, addPromptNotes: true },
    );
    return; // run stays live; the next wave's finalize will decide again
  }

  // commitRunChange emits the canonical blocked lifecycle event from the
  // authoritative status transition. No compensating re-emit is needed here.
}

// Positioned tail read of a (possibly large) log file — never the whole file.
async function readFileTailUtf8(path: string, maxBytes: number): Promise<string | null> {
  try {
    const { open } = await import("node:fs/promises");
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, maxBytes);
      if (length <= 0) return null;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, stat.size - length);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
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
  const scheduledEpoch = runCache.get(runId)?.conversationEpoch ?? 0;

  const start = existing && opts?.afterCurrent ? existing.catch(() => undefined) : Promise.resolve();
  const cycle = start
    .then(async () => {
      const latest = await getRun(runId);
      if (
        !latest ||
        conversationEpoch(latest) !== scheduledEpoch ||
        latest.status === "paused" ||
        latest.status === "blocked" ||
        latest.status === "cancelled"
      ) return;
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

function hasQueuedSteering(run: RunState): boolean {
  return queuedManagerInputMessages(run).some((message) => message.intent === "steer");
}

function scheduleQueuedSteeringFollowup(run: RunState): void {
  if (run.executionMode === "direct" || !hasQueuedSteering(run)) return;
  if (activeSteeringFollowups.has(run.id)) return;
  const scheduledEpoch = conversationEpoch(run);
  const waits = [activeAutopilotPlans.get(run.id), activeAutopilotReviews.get(run.id)].filter(
    (promise): promise is Promise<void> => Boolean(promise),
  );
  const cycle = Promise.all(waits.map((promise) => promise.catch(() => undefined)))
    .then(async () => {
      let latest = await getRun(run.id);
      if (
        !latest ||
        conversationEpoch(latest) !== scheduledEpoch ||
        !hasQueuedSteering(latest)
      ) return;
      if (
        latest.status === "paused" ||
        latest.status === "blocked" ||
        latest.status === "cancelled"
      ) {
        return;
      }
      if (latest.status === "complete" || latest.status === "failed") {
        latest = await commitRunChange(latest, {
          type: "run.steering_followup_started",
          message: "Queued steering started a fresh Cora manager turn",
          payload: { conversationEpoch: conversationEpoch(latest) },
          mutate: (draft, timestamp) => {
            if (!hasQueuedSteering(draft)) return false;
            draft.status = "planning";
            draft.autopilot = {
              ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
              status: "running",
              lastAction: "queued_steering_followup",
              updatedAt: timestamp,
            };
            draft.updatedAt = timestamp;
          },
        });
      }
      await runInitialAutopilotPlanning(
        latest.id,
        autopilotInputFromRun(latest),
        "chat",
      );
    })
    .catch(async (err) => {
      await markInitialAutopilotPlanningFailed(run.id, err);
    })
    .finally(() => {
      if (activeSteeringFollowups.get(run.id) === cycle) {
        activeSteeringFollowups.delete(run.id);
        // Steering can arrive while this follow-up turn itself is active. The
        // in-flight map dedupes that arrival; re-arm after settlement so it gets
        // its own next Cora turn instead of remaining queued forever.
        void getRun(run.id).then((latest) => {
          if (
            latest &&
            conversationEpoch(latest) === scheduledEpoch &&
            latest.status !== "paused" &&
            latest.status !== "blocked" &&
            latest.status !== "cancelled" &&
            hasQueuedSteering(latest)
          ) {
            scheduleQueuedSteeringFollowup(latest);
          }
        });
      }
    });
  activeSteeringFollowups.set(run.id, cycle);
  void cycle;
}

function pendingManagerResumeKey(
  runId: string,
  pending: NonNullable<RunState["pendingManagerResume"]>,
): string {
  return `${runId}:${pending.questionMessageId}:${pending.managerMode}`;
}

async function claimScheduledManagerResume(
  runId: string,
  pending: NonNullable<RunState["pendingManagerResume"]>,
): Promise<string | null> {
  const run = await requireRun(runId);
  const launchClaimId = makeId("resume");
  let claimed = false;
  await commitRunChange(run, {
    type: "run.question_resume_claimed",
    message: `Claimed manager continuation: ${pending.managerMode}`,
    payload: {
      questionMessageId: pending.questionMessageId,
      managerMode: pending.managerMode,
      launchClaimId,
    },
    mutate: (draft, timestamp) => {
      claimed = claimPendingManagerResume(
        draft,
        pending.questionMessageId,
        pending.managerMode,
        launchClaimId,
        timestamp,
      );
      if (!claimed) return false;
      draft.updatedAt = timestamp;
    },
  });
  return claimed ? launchClaimId : null;
}

async function clearRegisteredManagerResume(
  runId: string,
  launchClaimId: string,
  sparkCallId: string,
): Promise<void> {
  const run = await requireRun(runId);
  await commitRunChange(run, {
    type: "run.question_resume_launched",
    message: "Manager continuation launch registered",
    payload: { launchClaimId, sparkCallId },
    mutate: (draft, timestamp) => {
      if (!clearRegisteredPendingManagerResume(draft, launchClaimId)) return false;
      draft.updatedAt = timestamp;
    },
  });
}

async function finalizeAppliedManagerCall(
  runId: string,
  callId: string,
  epoch: number,
): Promise<RunState> {
  const run = await requireRun(runId);
  return commitRunChange(run, {
    type: "spark_call.completed",
    message: "Cora manager decision applied",
    sparkCallId: callId,
    payload: { callId, conversationEpoch: epoch },
    mutate: (draft, timestamp) => {
      if (conversationEpoch(draft) !== epoch) return false;
      const call = draft.sparkCalls.find((entry) => entry.id === callId);
      if (!call || call.status !== "started" || call.completedAt) return false;
      call.status = "completed";
      call.completedAt = timestamp;
      recomputeRunCostRollups(draft);
      draft.updatedAt = timestamp;
    },
  });
}

async function runManagerStageAfterQuestion(
  run: RunState,
  cwd: string,
  mode: SparkCall["mode"],
  managerResumeClaimId: string,
  autonomyRetryCount = 0,
): Promise<void> {
  if (mode === "chat" || mode === "plan_analysis") {
    await runInitialAutopilotPlanning(
      run.id,
      autopilotInputFromRun(run),
      mode,
      managerResumeClaimId,
      autonomyRetryCount,
    );
    return;
  }
  if (mode === "worker_result_review") {
    await runAutopilotManagerReview(run.id, cwd, managerResumeClaimId);
    return;
  }

  const decided = await askOpenRouterManager(
    run,
    cwd,
    mode,
    managerResumeClaimId,
    autonomyRetryCount,
  );
  if (
    !decided ||
    decided.status === "paused" ||
    decided.status === "blocked" ||
    decided.status === "cancelled" ||
    isTerminalRunStatus(decided.status)
  ) {
    return;
  }
  if (mode !== "final_summary" && mode !== "test") {
    const input = autopilotInputFromRun(decided);
    await startAutopilot({ ...input, cwd, runId: decided.id });
  }
}

function schedulePendingManagerResume(run: RunState): void {
  const pending = run.pendingManagerResume;
  if (!pending || run.executionMode === "direct") return;
  const key = pendingManagerResumeKey(run.id, pending);
  const scheduledEpoch = conversationEpoch(run);
  if (activePendingManagerResumes.has(key)) return;
  activePendingManagerResumes.add(key);

  const waits = [activeAutopilotPlans.get(run.id), activeAutopilotReviews.get(run.id)].filter(
    (promise): promise is Promise<void> => Boolean(promise),
  );
  const start = Promise.all(waits.map((promise) => promise.catch(() => undefined))).then(
    () => undefined,
  );
  const cycle = start
    .then(async () => {
      const beforeClaim = await getRun(run.id);
      if (!beforeClaim || conversationEpoch(beforeClaim) !== scheduledEpoch) return;
      const launchClaimId = await claimScheduledManagerResume(run.id, pending);
      if (!launchClaimId) return;
      const latest = await getRun(run.id);
      if (
        !latest ||
        conversationEpoch(latest) !== scheduledEpoch ||
        latest.status === "paused" ||
        latest.status === "blocked" ||
        latest.status === "cancelled" ||
        isTerminalRunStatus(latest.status)
      ) {
        return;
      }
      await runManagerStageAfterQuestion(
        latest,
        autopilotInputFromRun(latest).cwd,
        pending.managerMode,
        launchClaimId,
        pending.autonomyRetryCount ?? 0,
      );
    })
    .catch(async (err) => {
      await markInitialAutopilotPlanningFailed(run.id, err);
    })
    .finally(() => {
      activePendingManagerResumes.delete(key);
      if (activeAutopilotPlans.get(run.id) === cycle) {
        activeAutopilotPlans.delete(run.id);
      }
      if (activeAutopilotReviews.get(run.id) === cycle) {
        activeAutopilotReviews.delete(run.id);
      }
    });

  if (pending.managerMode === "worker_result_review") {
    activeAutopilotReviews.set(run.id, cycle);
  } else {
    activeAutopilotPlans.set(run.id, cycle);
  }
  void cycle;
}

/** Finish a rewind whose epoch barrier was durable when the prior process
 * exited. Code restoration and ref movement are idempotent, so replaying the
 * target is safer than exposing a mixed old-chat/new-epoch run. */
export async function recoverPendingConversationRewinds(): Promise<void> {
  const runs = await listRuns();
  for (const run of runs) {
    const pending = run.pendingConversationRewind;
    if (!pending) continue;
    const checkpoints = run.checkpoints ?? [];
    const checkpointIndex = pending.checkpointId
      ? checkpoints.findIndex((checkpoint) => checkpoint.id === pending.checkpointId)
      : -1;
    const checkpoint = checkpointIndex >= 0 ? checkpoints[checkpointIndex] : undefined;
    try {
      await queueConversationRewind(run.id, {
        checkpoint,
        checkpointId: pending.checkpointId,
        checkpointIndex: pending.checkpointIndex,
        messagePointer: pending.messagePointer,
        messageId: pending.messageId,
        scope: pending.scope,
      });
    } catch (error) {
      console.warn(`[run-store] failed to recover conversation rewind for ${run.id}:`, error);
    }
  }
}

/** Repair manager turns that were durable but had no live driver after process
 * exit. Claimed queued/submitted input is released, the orphaned call is marked
 * failed, and answer-driven continuations are recreated from the exact linked
 * answer so startup can safely retry them. */
export async function recoverOrphanedManagerTurns(): Promise<void> {
  const runs = await listRuns();
  for (const run of runs) {
    const epoch = conversationEpoch(run);
    const orphaned = run.sparkCalls.filter(
      (call) =>
        call.status === "started" &&
        !call.completedAt &&
        (call.conversationEpoch ?? 0) === epoch,
    );
    if (orphaned.length === 0) continue;
    const orphanedIds = new Set(orphaned.map((call) => call.id));

    const recovered = await commitRunChange(run, {
      type: "run.manager_turns_recovered",
      message: `Recovered ${orphaned.length} interrupted manager turn(s) after restart`,
      payload: { callIds: [...orphanedIds], conversationEpoch: epoch },
      mutate: (draft, timestamp) => {
        if (conversationEpoch(draft) !== epoch) return false;
        let changed = false;
        for (const call of draft.sparkCalls) {
          if (!orphanedIds.has(call.id) || call.status !== "started") continue;
          call.status = "failed";
          call.error = "Manager turn interrupted by application restart.";
          call.completedAt = timestamp;
          changed = true;
        }
        for (const message of draft.humanMessages) {
          if (!message.backendTurnId || !orphanedIds.has(message.backendTurnId)) continue;
          if (message.deliveryState === "acknowledged" || message.deliveryState === "cancelled") continue;
          message.deliveryState = "queued";
          delete message.backendTurnId;
          if (message.targetTurnId && orphanedIds.has(message.targetTurnId)) {
            delete message.targetTurnId;
          }
          changed = true;
        }

        if (!draft.pendingManagerResume) {
          const resumeCall = [...orphaned]
            .reverse()
            .find((call) => Boolean(call.managerResumeClaimId));
          if (resumeCall) {
            const linkedAnswer = [...draft.humanMessages]
              .reverse()
              .find(
                (message) =>
                  message.author === "user" &&
                  message.kind === "answer" &&
                  Boolean(message.answersMessageId) &&
                  message.createdAt <= resumeCall.createdAt,
              );
            if (linkedAnswer?.answersMessageId) {
              draft.pendingManagerResume = {
                questionMessageId: linkedAnswer.answersMessageId,
                managerMode: resumeCall.mode,
                requestedAt: timestamp,
                state: "pending",
              };
              changed = true;
            }
          }
        }
        if (!changed) return false;
        draft.updatedAt = timestamp;
      },
    });

    if (recovered.pendingManagerResume) {
      schedulePendingManagerResume(recovered);
    } else if (
      recovered.executionMode !== "direct" &&
      queuedManagerInputMessages(recovered).length > 0 &&
      recovered.status !== "paused" &&
      recovered.status !== "blocked" &&
      recovered.status !== "cancelled" &&
      !isTerminalRunStatus(recovered.status)
    ) {
      scheduleInitialChatDecision(recovered.id, autopilotInputFromRun(recovered), {
        afterCurrent: true,
      });
    }
  }
}

/** Re-arm durable queued input whose in-memory follow-up scheduler disappeared
 * on process exit. Claimed orphaned input is released by
 * recoverOrphanedManagerTurns first; this pass covers messages that were saved
 * immediately before the process exited and were never claimed. */
export async function recoverQueuedManagerInputs(): Promise<void> {
  const runs = await listRuns();
  for (const run of runs) {
    if (
      run.executionMode === "direct" ||
      run.status === "paused" ||
      run.status === "blocked" ||
      run.status === "cancelled" ||
      activeManagerCall(run)
    ) continue;
    const queued = queuedManagerInputMessages(run);
    if (queued.length === 0) continue;
    if (queued.some((message) => message.intent === "steer")) {
      scheduleQueuedSteeringFollowup(run);
    } else {
      scheduleInitialChatDecision(run.id, autopilotInputFromRun(run), { afterCurrent: true });
    }
  }
}

/** Re-arm linked-answer manager continuations left by a prior process. Pending
 * records schedule normally. A launching lease without a completed SparkCall
 * returns to pending; only a completed call proves the continuation landed. */
export async function recoverPendingManagerResumes(): Promise<void> {
  const runs = await listRuns();
  for (const run of runs) {
    const pending = run.pendingManagerResume;
    if (!pending) continue;
    const key = pendingManagerResumeKey(run.id, pending);
    if (activePendingManagerResumes.has(key)) continue;

    const recovery: { action: "none" | "pending" | "registered" } = { action: "none" };
    const recovered = await commitRunChange(run, {
      type: "run.question_resume_recovered",
      message: "Recovered manager continuation after process restart",
      payload: {
        questionMessageId: pending.questionMessageId,
        managerMode: pending.managerMode,
        priorState: pending.state ?? "pending",
        launchClaimId: pending.launchClaimId,
      },
      mutate: (draft, timestamp) => {
        recovery.action = recoverPendingManagerResumeLease(draft);
        if (recovery.action === "none") return false;
        draft.updatedAt = timestamp;
      },
    });
    if (recovery.action === "pending" && recovered.pendingManagerResume) {
      schedulePendingManagerResume(recovered);
    }
  }
}

/** A live MCP long-poll cannot survive process exit. Convert managed provider
 * and consent questions to the durable scheduled-manager strategy; direct
 * worker report blockers keep their Loom-owned continuation path. */
export async function recoverAbandonedActiveRpcQuestions(): Promise<void> {
  const runs = await listRuns();
  for (const run of runs) {
    const blocker = run.blockedOn;
    if (
      run.status !== "blocked" ||
      run.executionMode === "direct" ||
      blocker?.resumeStrategy !== "active_rpc"
    ) continue;
    await commitRunChange(run, {
      type: "run.question_rpc_recovered",
      message: "Recovered question whose live provider wait ended during restart",
      payload: { questionMessageId: blocker.questionMessageId },
      mutate: (draft, timestamp) => {
        if (
          draft.status !== "blocked" ||
          draft.blockedOn?.questionMessageId !== blocker.questionMessageId ||
          draft.blockedOn.resumeStrategy !== "active_rpc"
        ) return false;
        draft.blockedOn.resumeStrategy = "schedule_manager";
        draft.blockedOn.managerMode ??=
          [...draft.sparkCalls]
            .reverse()
            .find((call) => call.status === "started" && !call.completedAt)?.mode ??
          "plan_analysis";
        draft.updatedAt = timestamp;
      },
    });
  }
}

async function runInitialAutopilotPlanning(
  runId: string,
  input: StartAutopilotInput,
  mode: "plan_analysis" | "chat" = "plan_analysis",
  managerResumeClaimId?: string,
  autonomyRetryCount = 0,
): Promise<void> {
  let run = await requireRun(runId);
  if (run.status === "paused" || run.status === "blocked" || run.status === "cancelled") return;

  let managerPlannedRun = mode === "chat"
    ? await askOpenRouterManager(run, input.cwd, "chat", managerResumeClaimId, autonomyRetryCount)
    : await askOpenRouterManager(run, input.cwd, "plan_analysis", managerResumeClaimId, autonomyRetryCount);
  if (
    managerPlannedRun &&
    managerPlannedRun.status !== "paused" &&
    managerPlannedRun.status !== "blocked" &&
    managerPlannedRun.status !== "cancelled" &&
    managerPlannedRun.status !== "failed" &&
    managerPlannedRun.steps.length > 0
  ) {
    // If plan_analysis lands on a brake as the first step, resolve it and
    // replan before asking step_planning for worker prompts.
    managerPlannedRun = await resolveActiveBrakeAndReplan(managerPlannedRun, input.cwd);
  }
  if (
    managerPlannedRun &&
    managerPlannedRun.status !== "paused" &&
    managerPlannedRun.status !== "blocked" &&
    managerPlannedRun.status !== "cancelled" &&
    managerPlannedRun.status !== "failed" &&
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
        ? "OpenRouter is not configured, so Cora cannot think through this chat turn yet. Add the API key in Settings, then send the message again."
        : "OpenRouter is not configured, so Cora cannot plan Claude/Codex worker tasks yet. Add the API key in Settings, then run the plan again.",
      undefined,
      {
        category: "credentials_access",
        reason: "The configured manager backend has no API credentials.",
        managerMode: mode,
      },
    );
    return;
  }

  run = managerPlannedRun ?? (await createFallbackAutopilotTask(run, input));
  // A spawn_terminals decision lands the run as `complete` straight out of
  // plan_analysis — there is nothing to orchestrate, so don't fall through
  // into startAutopilot (which would flip it back to running and re-plan).
  if (
    run.status === "paused" ||
    run.status === "blocked" ||
    run.status === "cancelled" ||
    run.status === "complete" ||
    run.status === "failed"
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
      if (
        draft.status === "paused" ||
        draft.status === "blocked" ||
        draft.status === "cancelled" ||
        draft.status === "complete"
      ) {
        return false;
      }
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
  if (
    latest.status === "paused" ||
    latest.status === "blocked" ||
    latest.status === "cancelled" ||
    latest.status === "complete" ||
    latest.status === "failed"
  ) {
    return;
  }
  const hasOtherActiveCycles = hasOtherAutopilotCycles(runId, attemptId);
  const hasOtherActiveWorkers = activeWorkersForRun(runId).some((worker) => worker.attemptId !== attemptId);
  // For execute/auto-mode CC/Codex chat backends, the CC/Codex manager session
  // is doing review itself (reading the worker's final_report_path returned by
  // codara_wait_for_workers and deciding codara_complete vs spawn correctives).
  // We need the worker_task to reach a TERMINAL status (accepted/failed/
  // cancelled) so codara_wait_for_workers actually unblocks — `needs_review`
  // is non-terminal in the WorkerTaskStatus enum, and the OpenRouter-driven
  // review path that normally transitions needs_review → accepted via
  // decideWorkerReport is explicitly skipped below. So auto-accept on
  // success here; the CC manager will inspect the report and judge quality.
  const isExecuteModeCliManager =
    (latest.chatBackend === "claude" || latest.chatBackend === "codex" || latest.chatBackend === "pi") &&
    (latest.chatMode === "execute" || latest.chatMode === "auto");
  const finishedAttempt = latest.workerAttempts.find((a) => a.id === attemptId);
  const finishedTaskId = finishedAttempt?.workerTaskId;
  const shouldAutoAccept =
    isExecuteModeCliManager &&
    Boolean(finishedTaskId) &&
    latest.workerTasks.find((t) => t.id === finishedTaskId)?.status === "needs_review";

  await commitRunChange(latest, {
    type: "autopilot.cycle_completed",
    message: "Autopilot completed one execution cycle",
    payload: {
      workerTasks: latest.workerTasks.length,
      workerAttempts: latest.workerAttempts.length,
      waitingForOtherWorkers: hasOtherActiveCycles || hasOtherActiveWorkers,
      autoAcceptedForExecuteModeCli: shouldAutoAccept,
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
      if (shouldAutoAccept && finishedTaskId) {
        const taskInDraft = draft.workerTasks.find((t) => t.id === finishedTaskId);
        if (taskInDraft && taskInDraft.status === "needs_review") {
          taskInDraft.status = "accepted";
          taskInDraft.updatedAt = timestamp;
          // Also roll up the parent step's review status so it doesn't sit
          // at "reviewing" forever — the manager (CC) consumes the report
          // directly via final_report_path.
          if (taskInDraft.stepId) {
            const stepInDraft = draft.steps.find((s) => s.id === taskInDraft.stepId);
            if (stepInDraft && stepInDraft.status === "reviewing") {
              stepInDraft.status = "complete";
              stepInDraft.updatedAt = timestamp;
            }
          }
        }
      }
      draft.updatedAt = timestamp;
    },
  });

  if (!hasOtherActiveCycles && !hasOtherActiveWorkers) {
    // A completed worker can deterministically queue its own continuation:
    // verifier FEEDBACK re-queues the matching implementation task, and an
    // environmental CLI failure queues an opposite-runtime fallback. Those
    // tasks previously remained parked forever for execute-mode CLI managers,
    // because the code below intentionally skips a second manager prompt. Run
    // the pending wave directly before deciding whether manager review is due.
    const settled = await requireRun(runId);
    const pendingContinuationTasks = pickAutopilotTasks(settled);
    if (pendingContinuationTasks.length > 0) {
      await appendEvent({
        workspaceId: settled.workspaceId,
        runId: settled.id,
        type: "autopilot.worker_continuation_started",
        message: `Launching ${pendingContinuationTasks.length} worker continuation task(s) queued by the completed cycle`,
        payload: {
          taskIds: pendingContinuationTasks.map((task) => task.id),
          taskTitles: pendingContinuationTasks.map((task) => task.title),
        },
      });
      const input = autopilotInputFromRun(settled);
      await startAutopilot({
        ...input,
        cwd: cwd || input.cwd,
        runId: settled.id,
      });
      return;
    }
    // Skip the autopilot's worker_result_review re-prompt when the chat
    // backend is a long-lived CC/Codex execute session. In that flow the
    // manager is ALREADY waiting on codara_wait_for_workers in its current
    // turn; when those workers terminate, the wait_for_workers RPC unblocks
    // and the same CC/Codex session decides what to do next (read final
    // reports, then codara_complete or spawn correctives) — all inside its
    // active turn. Re-prompting it with latestUserPromptFromRun would be
    // the SAME prompt as turn 1 (because askChatBackendNonOpenRouter has no
    // mode-specific message builder), which is precisely how one user
    // message produced multiple worker-spawn rounds in run-mpo92kqf-7eaym0.
    // OpenRouter manager retains the review re-prompt because OpenRouter's
    // openrouter-manager.ts:buildManagerUserMessage DOES vary by mode.
    if (!isExecuteModeCliManager) {
      scheduleAutopilotReview(runId, cwd);
    }
  }
}

export function scheduleAutopilotCycles(runId: string, attemptIds: string[]): void {
  for (const attemptId of attemptIds) {
    const key = autopilotCycleKey(runId, attemptId);
    if (activeAutopilotCycles.has(key)) continue;

    const cycle = Promise.resolve()
      .then(async () => {
        const run = await getRun(runId);
        if (!run || run.status === "paused" || run.status === "blocked" || run.status === "cancelled") return;
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

function scheduleAutopilotReview(
  runId: string,
  cwd: string,
  opts?: { afterCurrent?: boolean },
): void {
  const existing = activeAutopilotReviews.get(runId);
  if (existing && !opts?.afterCurrent) return;
  const start = existing && opts?.afterCurrent ? existing.catch(() => undefined) : Promise.resolve();
  const review = start
    .then(
      () =>
        new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            runAutopilotManagerReview(runId, cwd).then(resolve, reject);
          }, 0);
        }),
    )
    .catch(async (err) => {
      await markAutopilotCycleFailed(runId, "manager-review", err);
    })
    .finally(() => {
      if (activeAutopilotReviews.get(runId) === review) {
        activeAutopilotReviews.delete(runId);
      }
    });
  activeAutopilotReviews.set(runId, review);
  void review;
}

async function runAutopilotManagerReview(
  runId: string,
  cwd: string,
  managerResumeClaimId?: string,
): Promise<void> {
  let run = await requireRun(runId);
  if (run.status === "paused" || run.status === "blocked" || run.status === "cancelled") return;
  if (hasAutopilotCycles(runId) || activeWorkersForRun(runId).length > 0) return;

  // Looms v2: direct runs never consult a manager — the worker's final report
  // is the verdict. This is THE seam that replaces review for automations.
  if (run.executionMode === "direct") {
    await finalizeDirectRun(runId);
    return;
  }

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

  // Plan-mode council: all candidate planners have finished (no pending tasks,
  // no active workers). Synthesize the best merged PLAN.md + PRD.md and complete
  // the run — skip the verifier/manager review (planning docs aren't code).
  //
  // Gate out chatMode "execute"/"auto": council tasks keep their councilGroupId
  // forever, so isCouncilRun(run) stays true even after the plan is finalized.
  // Once the user flips the SAME chat to Execute or Auto ("run the plan"),
  // we must NOT re-route into council finalize — otherwise the flip would
  // re-finalize the old plan instead of spawning execute workers. Any other
  // mode (plan, or unset for a programmatic council) still advances/finalizes
  // the council normally.
  if (isCouncilRun(run) && run.chatMode !== "execute" && run.chatMode !== "auto") {
    await advanceCouncil(run, cwd);
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
        message: "Cora manager review skipped because OpenRouter is not configured",
        payload: {
          reason: "manual_fallback",
        },
      });
      return;
    }
    await askHumanQuestion(
      run.id,
      "Worker results are ready, but OpenRouter is not configured for Cora manager review. Add the API key in Settings, then resume the run.",
      undefined,
      {
        category: "credentials_access",
        reason: "The manager review requires OpenRouter credentials.",
        managerMode: "worker_result_review",
      },
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
  // when Codara could re-run the impl worker's OWN verificationCommands and
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
  //
  // Verifier invariant: before the manager reviews, guarantee every changed-
  // files impl step is covered by an independent cross-provider verifier. This
  // is idempotent (it skips steps that already have a live verifier or a
  // terminal verdict), so enforcing it each review hop just closes any hole the
  // manager opened by accepting without spawning one.
  run = await ensureVerifierCoverage(run, cwd);
  if (run.status === "paused" || run.status === "blocked" || run.status === "cancelled" || run.status === "complete") return;
  const REVIEW_REPROMPT_CAP = 3;
  for (let attempt = 0; attempt < REVIEW_REPROMPT_CAP; attempt++) {
    run = await askOpenRouterManager(
      run,
      cwd,
      "worker_result_review",
      attempt === 0 ? managerResumeClaimId : undefined,
    ) ?? run;
    if (run.status === "paused" || run.status === "blocked" || run.status === "cancelled" || run.status === "complete") return;
    const lastAction = run.autopilot?.lastAction;
    if (lastAction !== "completion_refused") break;
  }
  // Advance any now-fully-accepted steps before we pick the next tasks. A
  // worker_result_review that accepts step N AND queues step N+1's task in the
  // same turn used to leave step N non-terminal — the step-completion pass in
  // applySparkManagerDecision only runs when the decision queues ZERO tasks.
  // That stranded the step N+1 task: pickAutopilotStep kept returning the
  // still-active step N, so pickAutopilotTasks (which filters by the active
  // step) never picked the step N+1 task, and the run idled until budget
  // exhaustion. completeAcceptedReviewingSteps only closes a step when every
  // one of its tasks is terminal, so a same-step verifier still holds its step
  // open — making this safe to run regardless of queued follow-ups.
  run = await completeAcceptedReviewingSteps(run, "");
  if (run.status === "paused" || run.status === "blocked" || run.status === "cancelled" || run.status === "complete") return;
  // Brake checkpoint: if the next active step is a brake, resolve it and
  // re-invoke plan_analysis so the manager can extend the plan with prior
  // worker reports as evidence.
  run = await resolveActiveBrakeAndReplan(run, cwd);
  if (run.status === "paused" || run.status === "blocked" || run.status === "cancelled" || run.status === "complete") return;
  // Cross-step plan hint: when worker_result_review tried to queue work into
  // a non-existent step (a real-world Grok-4.3 behavior — exploration done,
  // model wants to add the "now implement it" step itself), applySparkManagerDecision
  // captured those proposed tasks as a plan hint instead of silently dropping.
  // Re-invoke plan_analysis so the manager extends the plan with that hint in
  // context. Without this re-entry the run parks in reviewing/blocked forever.
  let tasks = pickAutopilotTasks(run);
  if (tasks.length === 0 && run.autopilot?.pendingPlanHint && !needsStepPlanning(run)) {
    run = (await askOpenRouterManager(run, cwd, "plan_analysis")) ?? run;
    if (run.status === "paused" || run.status === "blocked" || run.status === "cancelled" || run.status === "complete") return;
    tasks = pickAutopilotTasks(run);
  }
  // After advancing past a worker (and possibly a brake), the next active step
  // is usually a worker_batch that has plannedAgents but no worker tasks yet.
  // Call step_planning so the manager turns those plannedAgents into worker
  // task prompts before we try to launch.
  if (tasks.length === 0 && needsStepPlanning(run)) {
    const fastPathPlan = await tryTrivialFastPathStepPlanning(run);
    run = fastPathPlan ?? ((await askOpenRouterManager(run, cwd, "step_planning")) ?? run);
    if (run.status === "paused" || run.status === "blocked" || run.status === "cancelled" || run.status === "complete") return;
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
      return;
    }
    // No queueable work and nothing capped. If nothing is actually in flight
    // either, the run has stalled in a non-terminal state — commonly
    // "reviewing" after the manager declined to complete but produced no new
    // work. Leaving it inert here pins the chat composer on the Stop button
    // forever (isActive stays true, Send never returns). Settle to "paused" so
    // the user gets Resume/Send back. Guarded on activeWorkersForRun AND
    // non-terminal worker tasks so we NEVER cut off workers still running —
    // their completion re-drives this review and finds the real next step.
    const stillInFlight =
      activeWorkersForRun(run.id).length > 0 ||
      run.workerTasks.some((task) =>
        ["created", "queued", "claimed", "running", "needs_review", "retry_queued"].includes(
          task.status,
        ),
      );
    // Only the "active" statuses pin the composer on the Stop button (this
    // matches the renderer's isActive = running|planning|reviewing). By this
    // point earlier returns have already excluded paused/cancelled/complete;
    // failed/blocked/idle are not stuck, so leave them be.
    const runIsActive =
      run.status === "running" ||
      run.status === "planning" ||
      run.status === "reviewing";
    if (!stillInFlight && runIsActive) {
      await commitRunChange(run, {
        type: "autopilot.review_stalled",
        message:
          "Autopilot review found no remaining work and no workers in flight; pausing for input.",
        payload: { previousStatus: run.status },
        mutate: (draft, timestamp) => {
          abandonRunQuestionOwnership(draft);
          draft.status = "paused";
          draft.autopilot = {
            ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
            status: "idle",
            lastAction: "review_no_work",
            stopReason: "review_no_remaining_work",
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
      if (draft.status === "cancelled" || draft.status === "complete") return false;
      draft.status = "failed";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
        status: "failed",
        lastAction: "worker_cycle_failed",
        updatedAt: timestamp,
      };
      // The run is failing — terminalize any in-flight worker attempts/tasks so
      // a CC/Codex manager blocked in codara_wait_for_workers observes a terminal
      // status promptly instead of waiting out the ~20-min MCP hold ceiling.
      // Mirrors the status sets in forcePauseRun/cancelRun.
      for (const attempt of draft.workerAttempts) {
        if (
          attempt.status === "preparing" ||
          attempt.status === "prompt_ready" ||
          attempt.status === "launching" ||
          attempt.status === "running" ||
          attempt.status === "finishing"
        ) {
          attempt.status = "failed";
          attempt.finishedAt = attempt.finishedAt ?? timestamp;
        }
      }
      for (const task of draft.workerTasks) {
        if (
          task.status === "created" ||
          task.status === "queued" ||
          task.status === "claimed" ||
          task.status === "running" ||
          task.status === "needs_review" ||
          task.status === "retry_queued"
        ) {
          task.status = "failed";
          task.updatedAt = timestamp;
        }
      }
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

function conversationEpoch(run: RunState): number {
  return run.conversationEpoch ?? 0;
}

function activeManagerCall(run: RunState): SparkCall | undefined {
  const epoch = conversationEpoch(run);
  for (let index = run.sparkCalls.length - 1; index >= 0; index -= 1) {
    const call = run.sparkCalls[index];
    if ((call.conversationEpoch ?? 0) !== epoch) continue;
    if (call.status === "started" && !call.completedAt) return call;
  }
  return undefined;
}

function queuedManagerInputMessages(run: RunState): HumanRunMessage[] {
  const epoch = conversationEpoch(run);
  return run.humanMessages.filter(
    (message) =>
      message.author === "user" &&
      (message.conversationEpoch ?? 0) === epoch &&
      message.deliveryState === "queued" &&
      !message.backendTurnId,
  );
}

interface PreparedManagerTurn {
  run: RunState;
  call: SparkCall;
  prompt: string;
  inputMessages: HumanRunMessage[];
  conversationEpoch: number;
}

async function prepareManagerTurn(
  run: RunState,
  call: SparkCall,
  backend: ReturnType<typeof resolveChatBackendConfig>["backend"],
): Promise<PreparedManagerTurn> {
  let selectedIds: string[] = [];
  let includeCanonicalReplay = false;
  const epoch = conversationEpoch(run);
  const prepared = await commitRunChange(run, {
    type: "spark_call.started",
    message: `Cora manager call started: ${call.model}`,
    sparkCallId: call.id,
    payload: {
      mode: call.mode,
      model: call.model,
      conversationEpoch: epoch,
    },
    mutate: (draft, timestamp) => {
      if (conversationEpoch(draft) !== epoch) return false;
      includeCanonicalReplay = shouldIncludeCanonicalReplay(
        draft,
        backend,
        epoch,
      );
      const selected = queuedManagerInputMessages(draft);
      selectedIds = selected.map((message) => message.id);
      call.inputMessageIds = selectedIds;
      call.conversationEpoch = epoch;
      call.createdAt = timestamp;
      for (const message of selected) {
        message.targetTurnId ??= call.id;
        message.backendTurnId = call.id;
      }
      draft.sparkCalls.push(call);
      draft.updatedAt = timestamp;
    },
  });
  const persistedCall = prepared.sparkCalls.find((entry) => entry.id === call.id);
  if (!persistedCall || conversationEpoch(prepared) !== epoch) {
    throw new Error(`Manager turn ${call.id} became stale before backend startup.`);
  }
  const inputMessages = selectedIds
    .map((id) => prepared.humanMessages.find((message) => message.id === id))
    .filter((message): message is HumanRunMessage => Boolean(message));
  return {
    run: prepared,
    call: persistedCall,
    prompt: buildManagerTurnPrompt(prepared, inputMessages, { includeCanonicalReplay }),
    inputMessages,
    conversationEpoch: epoch,
  };
}

const DELIVERY_RANK: Record<RunMessageDeliveryState, number> = {
  queued: 0,
  submitted: 1,
  acknowledged: 2,
  cancelled: 3,
};

async function releaseUnsubmittedManagerInput(
  runId: string,
  callId: string,
  epoch: number,
): Promise<void> {
  const run = await getRun(runId);
  if (!run || !isManagerTurnCurrent(run, callId, epoch)) return;
  await commitRunChange(run, {
    type: "run.manager_input_requeued",
    message: "Manager input requeued after pre-submission failure",
    payload: { callId, conversationEpoch: epoch },
    mutate: (draft, timestamp) => {
      if (!isManagerTurnCurrent(draft, callId, epoch)) return false;
      let changed = false;
      for (const message of draft.humanMessages) {
        if (message.backendTurnId !== callId) continue;
        if (message.deliveryState === "acknowledged" || message.deliveryState === "cancelled") continue;
        message.deliveryState = "queued";
        delete message.backendTurnId;
        if (message.targetTurnId === callId) delete message.targetTurnId;
        changed = true;
      }
      if (!changed) return false;
      draft.updatedAt = timestamp;
    },
  });
}

async function updateManagerInputDelivery(
  runId: string,
  callId: string,
  epoch: number,
  state: "submitted" | "acknowledged",
): Promise<void> {
  const run = await getRun(runId);
  if (!run || conversationEpoch(run) !== epoch) return;
  const call = run.sparkCalls.find(
    (entry) => entry.id === callId && (entry.conversationEpoch ?? 0) === epoch,
  );
  if (!call) return;
  await commitRunChange(run, {
    type: `run.manager_input_${state}`,
    message: `Manager input ${state}`,
    payload: { callId, inputMessageIds: call.inputMessageIds ?? [], conversationEpoch: epoch },
    mutate: (draft, timestamp) => {
      if (conversationEpoch(draft) !== epoch) return false;
      let changed = false;
      for (const message of draft.humanMessages) {
        if (message.backendTurnId !== callId) continue;
        const current = message.deliveryState ?? "queued";
        if (current === "cancelled" || DELIVERY_RANK[current] >= DELIVERY_RANK[state]) continue;
        message.deliveryState = state;
        changed = true;
      }
      if (!changed) return false;
      draft.updatedAt = timestamp;
    },
  });
}

function normalizeOpenRouterManagerMode(
  mode: SparkCall["mode"],
): "plan_analysis" | "chat" | "step_planning" | "worker_result_review" {
  if (mode === "worker_result_review") return "worker_result_review";
  if (mode === "chat") return "chat";
  if (mode === "plan_analysis") return "plan_analysis";
  return "step_planning";
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

async function askOpenRouterManagerForInitialTasks(
  run: RunState,
  cwd: string,
  managerResumeClaimId?: string,
): Promise<RunState | null> {
  return askOpenRouterManager(run, cwd, "plan_analysis", managerResumeClaimId);
}

async function askOpenRouterManagerForChat(
  run: RunState,
  cwd: string,
  managerResumeClaimId?: string,
): Promise<RunState | null> {
  const enriched = await enrichLatestUserMessageWithMentionedFiles(run, cwd);
  return askOpenRouterManager(enriched, cwd, "chat", managerResumeClaimId);
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
const MAX_MANAGER_QUESTION_REPROMPTS = 2;

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
  managerResumeClaimId?: string,
  autonomyRetryCount = 0,
): Promise<RunState | null> {
  // Defense in depth: a direct (loom) run must never reach a manager LLM. If
  // a code path gets here anyway, surface it loudly instead of silently
  // spending API tokens the user explicitly opted out of.
  if (run.executionMode === "direct") {
    await appendEvent({
      workspaceId: run.workspaceId,
      runId: run.id,
      type: "direct_run.manager_call_suppressed",
      message: `Manager call suppressed on direct run (mode=${mode})`,
      payload: { mode },
    });
    return null;
  }
  const settings = await loadSettings();
  const chatConfig = resolveChatBackendConfig(run, settings);

  // Non-OpenRouter backends own their own request lifecycle (spawn a real
  // `claude` / `codex` CLI, tail its JSONL transcript, etc.). Dispatch and
  // skip the OpenRouter-specific SparkCall and artifact pipeline
  // below. Both backends still apply their resulting SparkManagerDecision
  // through applySparkManagerDecision so downstream worker spawns + chat
  // replies work identically.
  if (chatConfig.backend !== "openrouter") {
    return await askChatBackendNonOpenRouter(
      run,
      cwd,
      mode,
      chatConfig,
      settings,
      managerResumeClaimId,
      autonomyRetryCount,
    );
  }

  // Automation mode is a CLI-architect feature: it drives the spark_*_automation
  // MCP tools, which only the Claude Code / Codex CLI backends can reach. The
  // OpenRouter manager has no such tools — if we fell through here it would run
  // the normal worker-spawning manager path and mutate the workspace, which is
  // exactly what Automation mode must NOT do. Short-circuit with a conversational
  // note telling the user to switch backends, and do nothing else.
  if (run.chatMode === "automation") {
    return await addRunMessage({
      runId: run.id,
      author: "spark",
      kind: "note",
      message:
        "Automation mode requires the Claude Code or Codex CLI backend — the OpenRouter backend can't manage automations. Switch this chat's model to a Claude Code or Codex option to design, create, and run automations here.",
    });
  }

  const baseConfig = readOpenRouterConfig(settings);
  if (!baseConfig) return null;

  // The composer chip's per-chat model override beats the global setting. We
  // shadow `config` with the resolved version so the rest of the pipeline
  // (request body, SparkCall record, artifacts) all see the chip's selected
  // model without a per-call-site rewrite.
  const config: OpenRouterConfig =
    chatConfig.model && chatConfig.model !== baseConfig.model
      ? { ...baseConfig, model: chatConfig.model }
      : baseConfig;

  const callId = makeId("spark");
  const callDir = join(runDir(run.id), "spark-calls", callId);
  const requestPath = join(callDir, "request.json");
  const responsePath = join(callDir, "response.json");
  const parsedJsonPath = join(callDir, "parsed-decision.json");
  const contextPacketPath = join(callDir, "context-packet.json");
  const sparkCall: SparkCall = {
    id: callId,
    runId: run.id,
    stepId: run.currentStepId,
    mode,
    model: config.model,
    status: "started",
    managerResumeClaimId,
    requestPath,
    responsePath,
    parsedJsonPath,
    createdAt: new Date().toISOString(),
  };
  const preparedTurn = await prepareManagerTurn(run, sparkCall, "openrouter");
  run = preparedTurn.run;
  const startedAt = preparedTurn.call.createdAt;

  // Build the stateless OpenRouter request once from the prepared run snapshot.
  // Later steering remains queued for another SparkCall and cannot leak into it.
  const frozenRun = structuredClone(run);
  const managerMode = normalizeOpenRouterManagerMode(mode);
  const workerReports = await collectWorkerReportContext(frozenRun, managerMode);
  const availableRuntimes = await detectConfiguredAgentRuntimes();
  const agentSyncContext = renderAgentSyncManagerContext({ cwd, settings });
  const requestBody = buildOpenRouterManagerRequest({
    run: frozenRun,
    cwd,
    model: config.model,
    mode: managerMode,
    workerReports,
    availableRuntimes,
    agentSyncContext,
  });
  const requestUserMessage = [...requestBody.messages]
    .reverse()
    .find((message) => message.role === "user");
  if (requestUserMessage && preparedTurn.inputMessages.length > 0) {
    requestUserMessage.content += [
      "",
      "IMMUTABLE QUEUED TURN INPUT",
      "The messages below are the exact FIFO bundle owned by this SparkCall. Process every entry exactly once; do not replace it with only the newest chat row.",
      JSON.stringify(
        preparedTurn.inputMessages.map((message) => ({
          id: message.id,
          kind: message.kind,
          intent: message.intent,
          message: message.message,
          attachments: (message.attachments ?? []).map(
            (attachment) =>
              `${attachment.kind}:${attachment.name} (${attachment.path})`,
          ),
        })),
        null,
        2,
      ),
    ].join("\n");
  }
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
  const preparedCall = run.sparkCalls.find((call) => call.id === callId);
  if (preparedCall) {
    preparedCall.contextPacketId = contextPacket.id;
    preparedCall.promptTokenEstimate = contextPacket.tokenEstimate;
    preparedCall.contextWindowTokens = contextWindow.tokens;
    preparedCall.contextWindowSource = contextWindow.source;
  }
  run.settingsSnapshot = {
    ...(run.settingsSnapshot ?? {}),
    openRouterModel: config.model,
    openRouterBaseUrl: config.baseUrl,
    openRouterStructuredOutputFallbackModel: config.structuredOutputFallbackModel,
    agentMcpSyncEnabled: settings.agentMcpSyncEnabled,
    agentSkillSyncEnabled: settings.agentSkillSyncEnabled,
  };
  await saveRun(run);

  try {
    // Transient OpenRouter / provider errors (network, 5xx, provider-routed
    // backends crashing mid-request) used to bubble straight to the catch
    // block, which returns null and exits the autopilot loop silently —
    // observed in practice as multi-hour run hangs after a single fireworks
    // outage. Retry the inner request a small number of times with backoff;
    // re-throw structured-output-unsupported and other terminal errors
    // unchanged so the outer catch still routes them to the operator.
    await updateManagerInputDelivery(
      run.id,
      callId,
      preparedTurn.conversationEpoch,
      "submitted",
    );
    const result = await requestManagerWithRetries(config, requestBody, managerMode);
    await Promise.all([
      fs.writeFile(responsePath, JSON.stringify(result.rawResponse, null, 2), "utf8"),
      fs.writeFile(parsedJsonPath, JSON.stringify(result.decision, null, 2), "utf8"),
    ]);

    const latest = await requireRun(run.id);
    const targetCall = latest.sparkCalls.find((call) => call.id === callId);
    if (!targetCall || !isManagerTurnCurrent(latest, callId, preparedTurn.conversationEpoch)) {
      return latest;
    }
    const completedAt = new Date().toISOString();
    const completedContextWindow = contextWindowForModel(result.model);
    if (targetCall) {
      targetCall.model = result.model;
      targetCall.durationMs = result.durationMs;
      targetCall.promptTokens = result.promptTokens;
      targetCall.completionTokens = result.completionTokens;
      targetCall.promptTokenEstimate = contextPacket.tokenEstimate;
      targetCall.contextWindowTokens = completedContextWindow.tokens;
      targetCall.contextWindowSource = completedContextWindow.source;
      // Cost + token-split fields from the OpenRouter-prices layer. Optional —
      // older runs and unknown models leave these undefined; the Costs tab and
      // header pill handle that gracefully.
      if (typeof result.costUsd === "number") targetCall.costUsd = result.costUsd;
      if (typeof result.inputTokens === "number") targetCall.inputTokens = result.inputTokens;
      if (typeof result.outputTokens === "number") targetCall.outputTokens = result.outputTokens;
      if (typeof result.cacheReadTokens === "number") {
        targetCall.cacheReadTokens = result.cacheReadTokens;
      }
    }
    // Recompute the run-level rollup + per-step rollups now that we have a
    // fresh call cost. Cheap (O(calls) per save) and keeps the pill reactive
    // without a separate aggregator.
    recomputeRunCostRollups(latest);
    latest.updatedAt = completedAt;
    await saveRun(latest);
    if (result.fallbackFrom) {
      await appendEvent({
        timestamp: completedAt,
        workspaceId: latest.workspaceId,
        runId: latest.id,
        sparkCallId: callId,
        type: "spark_call.model_fallback",
        message: `Cora manager retried with structured-output fallback model: ${result.model}`,
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
        type: "spark_call.decision_received",
        message: `Cora manager decision received: ${result.decision.status}`,
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
        // Cost / token-split fields from the price-table layer so the event
        // log carries the same data the SparkCall record does. Lets the
        // Session Inspector Costs tab and any external audit replay both.
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        runTotalCostUsd: latest.totalCostUsd,
        parsedJsonPath,
        decision: result.decision,
      },
    });

    const applied = await applySparkManagerDecision(
      latest,
      result.decision,
      mode,
      cwd,
      callId,
      preparedTurn.conversationEpoch,
      autonomyRetryCount,
    );
    await updateManagerInputDelivery(
      run.id,
      callId,
      preparedTurn.conversationEpoch,
      "acknowledged",
    );
    const finalized = await finalizeAppliedManagerCall(
      run.id,
      callId,
      preparedTurn.conversationEpoch,
    );
    if (managerResumeClaimId) {
      await clearRegisteredManagerResume(run.id, managerResumeClaimId, callId);
    }
    scheduleQueuedSteeringFollowup(finalized);
    return finalized;
  } catch (err) {
    const latest = await requireRun(run.id);
    const targetCall = latest.sparkCalls.find((call) => call.id === callId);
    if (!targetCall || !isManagerTurnCurrent(latest, callId, preparedTurn.conversationEpoch)) {
      return latest;
    }
    await releaseUnsubmittedManagerInput(
      run.id,
      callId,
      preparedTurn.conversationEpoch,
    );
    const completedAt = new Date().toISOString();
    const error = err instanceof Error ? err.message : String(err);
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
      message: `Cora manager call failed: ${error}`,
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
        undefined,
        {
          reason: "The selected manager model cannot satisfy the required structured-output contract.",
          managerMode: mode,
        },
      );
    }
    return null;
  }
}

// Non-OpenRouter backend dispatch — see askOpenRouterManager's top branch.
// Calls the chosen backend (Claude Code or Codex) via the backend registry,
// forwards streaming chat events onto the orchestration event bus, persists
// any new CLI-side session UUID returned by the backend onto the RunState,
// records a minimal SparkCall for cost/audit consistency, and applies the
// resulting SparkManagerDecision through the same downstream path the
// OpenRouter pipeline uses.
async function askChatBackendNonOpenRouter(
  run: RunState,
  cwd: string,
  mode: SparkCall["mode"],
  chatConfig: ReturnType<typeof resolveChatBackendConfig>,
  settings: AppSettings,
  managerResumeClaimId?: string,
  autonomyRetryCount = 0,
): Promise<RunState | null> {
  const backend = getBackend(chatConfig.backend);
  const callId = makeId("spark");
  const sparkCall: SparkCall = {
    id: callId,
    runId: run.id,
    stepId: run.currentStepId,
    mode,
    model: chatConfig.model,
    status: "started",
    managerResumeClaimId,
    createdAt: new Date().toISOString(),
  };
  const preparedTurn = await prepareManagerTurn(run, sparkCall, chatConfig.backend);
  run = preparedTurn.run;
  const startedAt = preparedTurn.call.createdAt;
  const frozenRun = structuredClone(run);

  // Once requestManagerDecision settles, that SparkCall owns no more stream
  // events. Every callback also checks the epoch before it can reach the log.
  let acceptingStreamEvents = true;
  const onStream = (event: ChatStreamEvent): void => {
    if (!acceptingStreamEvents) return;
    void (async () => {
      const current = await getRun(run.id);
      if (!current || conversationEpoch(current) !== preparedTurn.conversationEpoch) return;
      if (!current.sparkCalls.some(
        (call) => call.id === callId && call.status === "started" && !call.completedAt,
      )) return;
      // Startup/system/tool stream records are not proof that the prompt reached
      // the provider. Only the backend's explicit onPromptAccepted callback may
      // advance input ownership to submitted.
      const stillCurrent = await getRun(run.id);
      if (
        !acceptingStreamEvents ||
        !stillCurrent ||
        !isManagerTurnCurrent(stillCurrent, callId, preparedTurn.conversationEpoch) ||
        !stillCurrent.sparkCalls.some(
          (call) => call.id === callId && call.status === "started" && !call.completedAt,
        )
      ) return;
      await appendEvent({
        timestamp: new Date().toISOString(),
        workspaceId: run.workspaceId,
        runId: run.id,
        sparkCallId: callId,
        type: `chat.${event.kind}`,
        payload: {
          ...(event as unknown as Record<string, unknown>),
          conversationEpoch: preparedTurn.conversationEpoch,
        },
      });
    })().catch((err) => {
      console.warn("[run-store] appendEvent for chat stream event failed:", err);
    });
  };

  const callStartedMs = Date.now();
  try {
    const result = await backend.requestManagerDecision(
      {
        run: frozenRun,
        cwd,
        mode: normalizeOpenRouterManagerMode(mode),
        settings,
        chat: { ...chatConfig },
        prompt: preparedTurn.prompt,
        inputMessageIds: preparedTurn.call.inputMessageIds ?? [],
        conversationEpoch: preparedTurn.conversationEpoch,
        onPromptAccepted: () => {
          return updateManagerInputDelivery(
            run.id,
            callId,
            preparedTurn.conversationEpoch,
            "submitted",
          );
        },
      },
      onStream,
    );
    acceptingStreamEvents = false;
    const latest = await requireRun(run.id);
    const targetCall = latest.sparkCalls.find((call) => call.id === callId);
    if (!targetCall || !isManagerTurnCurrent(latest, callId, preparedTurn.conversationEpoch)) {
      return latest;
    }
    const completedAt = new Date().toISOString();
    const turnAborted = result.turnAborted === true;
    const turnFailed = !turnAborted && result.turnFailed === true;
    if (turnFailed || turnAborted) {
      // A failed/aborted turn did not produce a decision that Cora durably
      // applied. Release both queued and submitted ownership so Resume/retry can
      // deliver the user's input again instead of silently consuming it.
      await releaseUnsubmittedManagerInput(
        run.id,
        callId,
        preparedTurn.conversationEpoch,
      );
    }
    if (targetCall) {
      // Successful decisions remain started until their run mutations land.
      // Aborted/failed turns have no decision to apply and can settle now.
      targetCall.status = turnFailed ? "failed" : turnAborted ? "completed" : "started";
      if (turnFailed) {
        targetCall.error = result.notice ?? "Chat turn failed.";
      }
      targetCall.model = result.model;
      targetCall.durationMs = result.durationMs;
      if (typeof result.promptTokens === "number") targetCall.promptTokens = result.promptTokens;
      if (typeof result.completionTokens === "number") targetCall.completionTokens = result.completionTokens;
      if (typeof result.costUsd === "number") targetCall.costUsd = result.costUsd;
      if (typeof result.inputTokens === "number") targetCall.inputTokens = result.inputTokens;
      if (typeof result.outputTokens === "number") targetCall.outputTokens = result.outputTokens;
      if (typeof result.cacheReadTokens === "number") targetCall.cacheReadTokens = result.cacheReadTokens;
      if (turnFailed || turnAborted) targetCall.completedAt = completedAt;
    }
    if (result.newSessionUuid && result.newSessionUuid !== latest.chatSessionUuid) {
      latest.chatSessionUuid = result.newSessionUuid;
    }
    // Stamp the mode the session was spawned under. Next-turn dispatch
    // checks this against the current chatMode and forces a fresh session
    // on mismatch — otherwise CC/Codex resume into a transcript whose prior
    // assistant replies were written in the old mode's persona and the new
    // mode's prompt gets ignored.
    if (result.newSessionUuid) {
      latest.chatSessionMode = chatConfig.mode;
    }
    recomputeRunCostRollups(latest);
    latest.updatedAt = completedAt;
    await saveRun(latest);

    // Backend reported the turn was ABORTED by the user (Stop button). Not
    // a failure and not an answer: the Stop path (forcePauseRun /
    // stopAndUndoPending) already interrupted the CLI, cancelled workers,
    // and set the run status. Record a quiet note and return — applying the
    // placeholder decision would fabricate a "Cora answered the chat turn"
    // completion, and the turnFailed branch would flag a routine Stop as
    // run.failed with a danger toast.
    if (turnAborted) {
      await appendEvent({
        timestamp: completedAt,
        workspaceId: latest.workspaceId,
        runId: latest.id,
        sparkCallId: callId,
        type: "chat.backend_notice",
        message: result.notice ?? "Chat turn interrupted by user.",
        payload: { backend: chatConfig.backend, interrupted: true },
      });
      return latest;
    }

    // Backend reported the turn itself FAILED (turn timeout, CLI crash,
    // backend error). The decision object only carries a best-effort
    // chatReply — applying it through applySparkManagerDecision would record
    // "Cora answered the chat turn" and complete the run as if it had been
    // answered (the CC 2.1.201 false-finish). Instead: surface the reply
    // (partial assistant text or the error description) as a chat bubble,
    // record the SparkCall failure, and move the run to "failed" through a
    // run.status_updated event so the notify pipeline emits a truthful
    // run.failed. The CLI session stays alive in the backend's session map
    // and addRunMessage re-engages the manager when the user chats into a
    // terminal run, so the chat remains fully usable afterwards.
    if (turnFailed) {
      const failureMessage = result.notice ?? "Chat turn failed.";
      await appendEvent({
        timestamp: completedAt,
        workspaceId: latest.workspaceId,
        runId: latest.id,
        sparkCallId: callId,
        type: "spark_call.failed",
        message: `Cora manager (${chatConfig.backend}) turn failed: ${failureMessage}`,
        payload: { mode, model: result.model, backend: chatConfig.backend, error: failureMessage },
      });
      let failedRun = latest;
      const replyText = result.decision.chatReply?.trim();
      if (replyText) {
        failedRun = await addRunMessage({
          runId: latest.id,
          author: "spark",
          kind: "note",
          message: replyText,
          intent: "answer",
          deliveryState: "acknowledged",
          targetTurnId: callId,
          backendTurnId: callId,
          conversationEpoch: preparedTurn.conversationEpoch,
        });
      }
      return commitRunChange(failedRun, {
        type: "run.chat_turn_failed",
        message: `Cora's ${chatConfig.backend} chat turn failed: ${failureMessage}`,
        payload: {
          backend: chatConfig.backend,
          sparkCallId: callId,
          error: failureMessage,
        },
        mutate: (draft, timestamp) => {
          draft.status = "failed";
          draft.autopilot = {
            ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
            status: "failed",
            lastAction: "chat_turn_failed",
            updatedAt: timestamp,
          };
          // The run is failing — terminalize any in-flight worker attempts/
          // tasks, mirroring markAutopilotCycleFailed (and the status sets in
          // forcePauseRun/cancelRun). Without this, a worker finishing after
          // the failure hits handleAutopilotCycleCompletion's terminal-run
          // early-return and its task is stranded in needs_review forever,
          // while a revived manager turn's codara_wait_for_workers blocks to
          // its ceiling waiting on tasks nothing will ever settle.
          for (const attempt of draft.workerAttempts) {
            if (
              attempt.status === "preparing" ||
              attempt.status === "prompt_ready" ||
              attempt.status === "launching" ||
              attempt.status === "running" ||
              attempt.status === "finishing"
            ) {
              attempt.status = "failed";
              attempt.finishedAt = attempt.finishedAt ?? timestamp;
            }
          }
          for (const task of draft.workerTasks) {
            if (
              task.status === "created" ||
              task.status === "queued" ||
              task.status === "claimed" ||
              task.status === "running" ||
              task.status === "needs_review" ||
              task.status === "retry_queued"
            ) {
              task.status = "failed";
              task.updatedAt = timestamp;
            }
          }
          draft.updatedAt = timestamp;
        },
      });
    }

    if (result.notice) {
      await appendEvent({
        timestamp: completedAt,
        workspaceId: latest.workspaceId,
        runId: latest.id,
        sparkCallId: callId,
        type: "chat.backend_notice",
        message: result.notice,
        payload: { backend: chatConfig.backend },
      });
    }
    if (result.decisionAlreadyApplied) {
      // Claude/Codex execute-mode MCP handlers mutate the run synchronously
      // while the provider turn is live. Reapplying their synthesized
      // spawn/ask/complete decision would duplicate workers or falsely finish
      // a turn whose question merely settled.
      const appliedLive = await requireRun(run.id);
      await updateManagerInputDelivery(
        run.id,
        callId,
        preparedTurn.conversationEpoch,
        "acknowledged",
      );
      const finalized = await finalizeAppliedManagerCall(
        run.id,
        callId,
        preparedTurn.conversationEpoch,
      );
      if (managerResumeClaimId) {
        await clearRegisteredManagerResume(run.id, managerResumeClaimId, callId);
      }
      scheduleQueuedSteeringFollowup(finalized);
      return finalized;
    }
    const applied = await applySparkManagerDecision(
      latest,
      result.decision,
      mode,
      cwd,
      callId,
      preparedTurn.conversationEpoch,
      autonomyRetryCount,
    );
    await updateManagerInputDelivery(
      run.id,
      callId,
      preparedTurn.conversationEpoch,
      "acknowledged",
    );
    const finalized = await finalizeAppliedManagerCall(
      run.id,
      callId,
      preparedTurn.conversationEpoch,
    );
    if (managerResumeClaimId) {
      await clearRegisteredManagerResume(run.id, managerResumeClaimId, callId);
    }
    scheduleQueuedSteeringFollowup(finalized);
    return finalized;
  } catch (err) {
    acceptingStreamEvents = false;
    const latest = await requireRun(run.id);
    const targetCall = latest.sparkCalls.find((call) => call.id === callId);
    if (!targetCall || !isManagerTurnCurrent(latest, callId, preparedTurn.conversationEpoch)) {
      return latest;
    }
    await releaseUnsubmittedManagerInput(
      run.id,
      callId,
      preparedTurn.conversationEpoch,
    );
    const completedAt = new Date().toISOString();
    const error = err instanceof Error ? err.message : String(err);
    if (targetCall) {
      targetCall.status = "failed";
      targetCall.error = error;
      targetCall.completedAt = completedAt;
      targetCall.durationMs = Date.now() - callStartedMs;
    }
    latest.updatedAt = completedAt;
    await saveRun(latest);
    await appendEvent({
      timestamp: completedAt,
      workspaceId: latest.workspaceId,
      runId: latest.id,
      sparkCallId: callId,
      type: "spark_call.failed",
      message: `Cora manager (${chatConfig.backend}) call failed: ${error}`,
      payload: { mode, model: chatConfig.model, backend: chatConfig.backend, error },
    });
    return null;
  }
}

// Top-tier worker assignments for trivial-classified runs. The verifier
// follow-up loop (which makes mid-tier workers safe) is skipped on trivial
// runs, so the implementation worker is the only check on the work and must
// have the stronger 'taste' that catches all distinct issues in one pass.
const TRIVIAL_TOP_TIER_BY_RUNTIME: Record<string, { modelHint: string; effortHint: WorkerTask["effortHint"] }> = {
  claude: { modelHint: "claude-opus-4-8", effortHint: "high" },
  codex: { modelHint: CODEX_MODEL_BY_TIER.top, effortHint: "high" },
};

// Top-tier model identifiers (post-normalization). Anything else for a
// claude/codex runtime is treated as mid-tier and gets promoted on trivial.
// We compare on the base model only — `@<effort>` suffixes are stripped first
// because grok-4.3 has shipped both `"claude-sonnet-4-6"` and
// `"claude-sonnet-4-6@medium"` as the modelHint string across runs, and an
// allow-list keyed on raw strings silently misses the suffixed variant.
const TOP_TIER_MODEL_BASES = new Set([
  "claude-opus-4-8",
  "opus",
  CODEX_MODEL_BY_TIER.top,
  // Legacy persisted assignments remain top-tier semantically; the launch
  // sanitizer migrates this id to GPT-5.6 Sol before spawning.
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

// sanitizeWorkerModelHint (the superseded-Sonnet remap + Codex id
// normalization) lives in worker-model-hint.ts so it can be unit-tested
// without run-store's deps. Re-exported here because callers (e.g.
// agent-socket) reach it through the run-store namespace.
export { sanitizeWorkerModelHint } from "./worker-model-hint";

function promoteForTrivial(agent: PlannedStepAgent): PlannedStepAgent {
  // Skeleton/verifier are exempt from the floor by design; leaf is mechanical
  // work where top-tier "taste" buys nothing — running a single shell command
  // and reporting its output does not benefit from Opus 4.8@high, and the
  // surprise cost (e.g. a chat-mode "what time is it?" worker on opus) is
  // worse than the recipe's intended cheap pick.
  if (agent.taskClass === "skeleton" || agent.taskClass === "verifier" || agent.taskClass === "leaf") return agent;
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
  if (task.taskClass === "skeleton" || task.taskClass === "verifier" || task.taskClass === "leaf") return task;
  const floor = TRIVIAL_TOP_TIER_BY_RUNTIME[task.runtimePreference];
  if (!floor) return task;
  const needsModelBump = !isTopTierModel(task.modelHint);
  const needsEffortBump = task.effortHint !== "high" && task.effortHint !== "xhigh" && task.effortHint !== "max";
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
        ? "The human does not want a .spark-parts workspace folder; moving staged parallel artifacts into the Cora run artifact directory."
        : shouldUseHybridRuntimes
          ? "The explicit parallel UI/logic split should use the available hybrid of installed runtimes instead of one runtime for every worker."
        : hasParallelPartsStep
        ? "The human explicitly requested a final combine step; the manager planned the parallel workers but omitted the integrator."
        : "The human explicitly requested simultaneous/different agents for UI/structure and logic, followed by a combine step.",
    stagedFiles: [parts.uiFile, parts.logicFile, finalFile],
    decision: {
      ...decision,
      summary: usesWorkspaceSparkParts
        ? "Explicit multi-agent plan repaired: staging moves to the Cora run artifact directory, followed by a single integration worker."
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
  if (!/\b(different agents?|claude|codex|hybrid)\b/i.test(intent)) return false;
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
    /\bspawn\b[\s\S]{0,80}\b(agent|worker|codex|claude)s?\b/.test(lower) ||
    /\b(agent|worker|codex|claude)s?\b[\s\S]{0,80}\b(simultaneous|parallel|at the same time)\b/.test(lower) ||
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
  const ui: WorkerRuntime = hasClaude ? "claude" : hasCodex ? "codex" : "manual";
  const logic: WorkerRuntime = hasCodex ? "codex" : ui;
  const integrator: WorkerRuntime = hasClaude ? "claude" : logic;
  return { ui, logic, integrator };
}

// --- First-class parallel fan-out -------------------------------------------
// A FanOutDirective (seeded by the composer "Fan out" button or the Explorer
// multi-select context action) asks the run to apply ONE instruction across an
// explicit set of per-target files. run-store synthesizes the batch
// deterministically — one parallel worker per target, each scoped to exactly
// its own file — so correctness never depends on the LLM manager honoring the
// prose [FAN OUT] contract. The manager profile is also taught the marker, but
// this path is what actually guarantees the disjoint parallel scopes.

// Distribute fan-out workers across the runtimes that are actually installed so
// a multi-target fan-out is not single-runtime by default. Falls back to a
// single available runtime (or "manual" when none is configured). The list is
// stable + index-addressable so each target gets a deterministic assignment.
async function chooseFanOutRuntimes(): Promise<WorkerRuntime[]> {
  const diagnostics = await detectConfiguredAgentRuntimes();
  const installed = new Set(
    diagnostics.filter((runtime) => runtime.installed).map((runtime) => runtime.kind),
  );
  const ordered: WorkerRuntime[] = [];
  if (installed.has("claude")) ordered.push("claude");
  if (installed.has("codex")) ordered.push("codex");
  return ordered.length > 0 ? ordered : ["manual"];
}

// Reconstruct a FanOutDirective from a seeded note body whose first line is the
// FAN_OUT_DIRECTIVE_MARKER. Mirrors formatFanOutDirective's layout (marker on
// line 1, then one target per line, then a blank line + optional instruction)
// so a note seeded by the renderer round-trips even when input.fanOut was not
// threaded (e.g. a live-run addRunMessage steer).
function parseFanOutDirectiveFromNote(note: string): FanOutDirective | null {
  const trimmed = note.trim();
  if (!trimmed.startsWith(FAN_OUT_DIRECTIVE_MARKER)) return null;
  const lines = trimmed.split(/\r?\n/);
  // Drop the marker line.
  lines.shift();
  const targets: string[] = [];
  let cursor = 0;
  for (; cursor < lines.length; cursor++) {
    const line = lines[cursor].trim();
    if (line.length === 0) {
      cursor += 1;
      break;
    }
    targets.push(line);
  }
  const instruction = lines.slice(cursor).join("\n").trim();
  if (targets.length === 0) return null;
  return {
    targets,
    instruction: instruction.length > 0 ? instruction : undefined,
    origin: "composer",
  };
}

// Resolve the directive that should force a fan-out for this startAutopilot
// call: the structured input.fanOut wins; otherwise fall back to parsing a
// marker-bearing initial note.
function resolveFanOutDirective(input: StartAutopilotInput): FanOutDirective | null {
  if (input.fanOut && input.fanOut.targets.length > 0) return input.fanOut;
  const note = input.initialUserNote?.trim();
  if (note) return parseFanOutDirectiveFromNote(note);
  return null;
}

// De-duplicate + normalize targets while preserving the caller's original path
// strings for allowedPaths (normalizeTaskPath is only used for the disjointness
// key). Empty / broad scopes are dropped — a fan-out target must be a concrete
// file so each worker owns exactly one disjoint scope.
function normalizeFanOutTargets(targets: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const original = raw.trim();
    if (!original) continue;
    if (isBroadPathScope(original)) continue;
    const key = normalizeTaskPath(original);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(original.replace(/\\/g, "/"));
  }
  return out;
}

// Deterministically synthesize ONE worker_batch step plus one feature task per
// target and create them through the same createStep/createWorkerTask path the
// manager decisions use. Each task: allowedPaths = [its own file], forbidden =
// [], canRunParallel = true, writeScopeSource = "fan-out", taskClass =
// "feature". Disjoint single-file scopes mean strengthenParallelTaskScopes /
// pickAutopilotTasks keep them parallel (no downgrade). Returns the updated run,
// or null when no usable targets survive normalization.
async function forceFanOutBatch(
  run: RunState,
  directive: FanOutDirective,
): Promise<RunState | null> {
  const targets = normalizeFanOutTargets(directive.targets);
  if (targets.length === 0) return null;

  const runtimes = await chooseFanOutRuntimes();
  const instruction = directive.instruction?.trim();
  const instructionLine = instruction && instruction.length > 0 ? instruction : "Apply the requested change";

  const plannedAgents: PlannedStepAgent[] = targets.map((target, index) => ({
    label: `worker 1.${index + 1}`,
    summary: `${instructionLine} in ${target}; own only this file.`,
    runtimePreference: runtimes[index % runtimes.length],
    taskClass: "feature",
  }));

  let updated = await createStep({
    runId: run.id,
    title: `Fan out across ${targets.length} file${targets.length === 1 ? "" : "s"}`,
    goal:
      `Apply the same change to ${targets.length} target file${targets.length === 1 ? "" : "s"} in parallel, ` +
      "one worker per file, with disjoint write scopes so the workers never collide.",
    kind: "worker_batch",
    plannedAgents,
    riskLevel: "low",
    acceptanceCriteria: targets.map(
      (target) => `${target} reflects the requested change and the worker reports its real filesChanged.`,
    ),
  });
  const stepId = updated.steps.at(-1)?.id;
  if (!stepId) return updated;

  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    updated = await createWorkerTask({
      runId: updated.id,
      stepId,
      title: `Fan out: ${target}`,
      description: `${instructionLine}. Edit ONLY ${target}; this is one worker of a ${targets.length}-way parallel fan-out and the other files are owned by sibling workers.`,
      runtimePreference: runtimes[index % runtimes.length],
      allowedPaths: [target],
      forbiddenPaths: [],
      expectedOutputs: [],
      verificationCommands: [],
      canRunParallel: true,
      conflictsWith: [],
      taskClass: "feature",
      writeScopeSource: "fan-out",
      createdBy: "spark",
    });
  }

  await appendFanOutDirectiveForcedEvent({
    workspaceId: updated.workspaceId,
    runId: updated.id,
    targetCount: targets.length,
    origin: directive.origin,
  });

  return requireRun(updated.id);
}

// ── Plan-mode Best-of-N council ─────────────────────────────────────────────
// A council mirrors fan-out's deterministic forcing, but instead of one worker
// per file it spawns N candidate PLANNERS (a mix of top-tier Claude Code + Codex
// agents) that each write PLAN.md + PRD.md into a DISJOINT
// .spark/<runId>/candidates/<i>/ folder. Disjoint scopes let the existing parallel
// machinery run them concurrently with no sandbox/conflict surgery. When they all
// finish, runAutopilotManagerReview calls synthesizePlanCouncil to judge + merge.

const COUNCIL_TOP_TIER_MODEL: Partial<Record<WorkerRuntime, string>> = {
  claude: "claude-opus-4-8",
  codex: CODEX_MODEL_BY_TIER.top,
};

// Plan-council scratch + output live under .spark/<runId>/ so every run owns a
// self-contained, clearly Codara-owned folder: candidate drafts under
// candidates/<i>/ and the synthesized result under spark-plan/. Keeping it inside
// .spark (and namespaced by run id) means we never clobber a user's own
// root-level PLAN.md / plan.md, runs never collide, and the result is easy to
// find, review, and re-run.
function councilCandidateDir(runId: string, index: number): string {
  return `.spark/${runId}/candidates/${index}/`;
}

// Relative (POSIX) path to the synthesized-plan folder for a run — used in
// prompts, allowedPaths and expectedOutputs. For on-disk reads/writes join the
// segments against cwd instead (see finalizeCouncil*).
function councilPlanDir(runId: string): string {
  return `.spark/${runId}/spark-plan`;
}

// Distinct planning lenses so N candidates explore genuinely different angles
// rather than producing N near-identical drafts (diversity beats redundancy).
const COUNCIL_CANDIDATE_ANGLES = [
  "Favor the simplest design that fully satisfies the request; minimize moving parts.",
  "Favor robustness and edge-case coverage; enumerate failure modes and how the plan handles them.",
  "Favor speed to a first working version; sequence the plan so something runs end-to-end early.",
  "Favor maintainability and clean architecture; emphasize module boundaries and a testing strategy.",
  "Favor user experience and product polish; emphasize the acceptance criteria a user would feel.",
  "Favor pragmatic risk management; identify the riskiest unknowns and de-risk them first.",
];

// True once a run carries council candidate tasks — routes the review hop into
// synthesis instead of the normal verifier/manager loop.
function isCouncilRun(run: RunState): boolean {
  return run.workerTasks.some((task) => task.councilGroupId !== undefined);
}

// The original planning task for a council run (latest user message / note).
function councilTaskFromRun(run: RunState): string {
  return (
    run.humanMessages
      .filter((message) => message.author === "user")
      .at(-1)
      ?.message?.trim() ?? ""
  );
}

// Map the run's SELECTED chat backend to a council worker runtime. The user's
// choice drives the synthesis engine — they explicitly don't want the judge on
// OpenRouter — so synthesis runs on the same agent they picked. Returns null when
// the selection isn't a CLI agent runtime (then we fall back to a deterministic
// pick of the most complete candidate, still no OpenRouter).
function councilSynthesisRuntime(run: RunState): WorkerRuntime | null {
  if (run.chatBackend === "claude") return "claude";
  if (run.chatBackend === "codex") return "codex";
  if (run.chatBackend === "pi") {
    return run.chatModel?.startsWith("claude-") ? "claude" : "codex";
  }
  return null;
}

// Resolve the council directive for this startAutopilot call: an explicit
// input.council wins; otherwise a run in chatMode "plan" treats the user's note
// (or latest user message) as the planning task.
function resolveCouncilDirective(
  run: RunState,
  input: StartAutopilotInput,
): CouncilDirective | null {
  if (input.council && input.council.task.trim().length > 0) return input.council;
  if (run.chatMode === "plan") {
    const task = input.initialUserNote?.trim() || councilTaskFromRun(run);
    if (task) return { task, origin: "composer" };
  }
  return null;
}

// Deterministically synthesize ONE worker_batch step plus N candidate planner
// tasks. By default that's one Claude + one Codex planner (both top-tier, at
// xhigh effort), each owning a disjoint .spark/<runId>/candidates/<i>/ scope and
// told to write PLAN.md + PRD.md there without touching any other file. Returns
// the updated run, or null when the task is empty / no runtimes are available.
async function forceCouncilBatch(
  run: RunState,
  directive: CouncilDirective,
): Promise<RunState | null> {
  const task = directive.task.trim();
  if (!task) return null;
  const runtimes =
    directive.engines && directive.engines.length > 0
      ? directive.engines
      : await chooseFanOutRuntimes();
  if (runtimes.length === 0) return null;
  // Default: one planner per installed CLI agent (Claude + Codex → 2 candidates,
  // one each). An explicit directive.n can override; clamp to [2, 6].
  const n = Math.min(6, Math.max(2, directive.n ?? runtimes.length));

  const councilGroupId = makeId("council");
  const runtimeFor = (index: number): WorkerRuntime => runtimes[index % runtimes.length];

  const plannedAgents: PlannedStepAgent[] = Array.from({ length: n }, (_unused, index) => ({
    label: `planner ${index + 1}`,
    summary: `Independent planner #${index + 1}: drafts PLAN.md + PRD.md in ${councilCandidateDir(run.id, index)}.`,
    runtimePreference: runtimeFor(index),
    taskClass: "feature",
  }));

  let updated = await createStep({
    runId: run.id,
    title: `Plan council — ${n} candidates`,
    goal:
      `Best-of-N planning: ${n} independent top-tier agents each draft a complete implementation ` +
      `PLAN.md and PRD.md for the task, in parallel, into disjoint candidate folders. A judge then ` +
      `synthesizes the single best merged PLAN.md + PRD.md.`,
    kind: "worker_batch",
    plannedAgents,
    riskLevel: "low",
    acceptanceCriteria: [
      `${n} candidate plans are produced under .spark/${run.id}/candidates/.`,
      `A synthesized PLAN.md and PRD.md are written to ${councilPlanDir(run.id)}/.`,
    ],
  });
  const stepId = updated.steps.at(-1)?.id;
  if (!stepId) return updated;

  const promptFor = (index: number): string =>
    `You are candidate planner #${index + 1} of ${n} INDEPENDENT planners working on the SAME task. ` +
    `Do NOT write or modify any application code. Your ONLY job is to produce two markdown files in your own folder:\n` +
    `  - ${councilCandidateDir(run.id, index)}PLAN.md  — a concrete, step-by-step implementation plan\n` +
    `  - ${councilCandidateDir(run.id, index)}PRD.md   — a product requirements document (goals, users, scope, requirements, acceptance criteria)\n\n` +
    `Create the folder ${councilCandidateDir(run.id, index)} if it does not exist and write ONLY those two files; do not touch anything outside that folder.\n\n` +
    `Planning lens for this candidate: ${COUNCIL_CANDIDATE_ANGLES[index % COUNCIL_CANDIDATE_ANGLES.length]}\n\n` +
    `# Task\n${task}`;

  for (let index = 0; index < n; index++) {
    updated = await createWorkerTask({
      runId: updated.id,
      stepId,
      title: `Plan candidate #${index + 1}`,
      description: promptFor(index),
      runtimePreference: runtimeFor(index),
      modelHint: COUNCIL_TOP_TIER_MODEL[runtimeFor(index)],
      effortHint: "xhigh",
      allowedPaths: [councilCandidateDir(run.id, index)],
      forbiddenPaths: [],
      expectedOutputs: [
        `${councilCandidateDir(run.id, index)}PLAN.md`,
        `${councilCandidateDir(run.id, index)}PRD.md`,
      ],
      verificationCommands: [],
      canRunParallel: true,
      conflictsWith: [],
      taskClass: "feature",
      councilGroupId,
      candidateIndex: index,
      councilRole: "candidate",
      createdBy: "spark",
    });
  }

  await appendEvent({
    workspaceId: updated.workspaceId,
    runId: updated.id,
    stepId,
    type: "plan_council.started",
    message: `Plan council started: ${n} candidate planner${n === 1 ? "" : "s"}`,
    payload: {
      councilGroupId,
      candidateCount: n,
      runtimes: plannedAgents.map((agent) => agent.runtimePreference),
    },
  });

  return requireRun(updated.id);
}

async function readCandidateDoc(
  cwd: string,
  runId: string,
  index: number,
  file: string,
): Promise<string> {
  try {
    return await fs.readFile(
      join(cwd, ".spark", runId, "candidates", String(index), file),
      "utf8",
    );
  } catch {
    return "";
  }
}

// Remove this run's candidate scratch folder once the synthesis has consumed it.
// The merged result under .spark/<runId>/spark-plan/ is kept — that's what the
// user (and a later Execute "run the plan") cares about. We intentionally do NOT
// rmdir .spark/<runId> (it still holds spark-plan) or .spark (other runs live
// there).
async function cleanupCouncilCandidates(cwd: string, runId: string): Promise<void> {
  await fs
    .rm(join(cwd, ".spark", runId, "candidates"), { recursive: true, force: true })
    .catch(() => undefined);
}

// Read each candidate's PLAN.md/PRD.md and return the most complete pair, or null
// when none produced anything. Used by the deterministic fallback.
async function pickMostCompleteCandidate(
  run: RunState,
  cwd: string,
): Promise<{ plan: string; prd: string } | null> {
  const candidates = run.workerTasks
    .filter((task) => task.councilRole === "candidate")
    .sort((a, b) => (a.candidateIndex ?? 0) - (b.candidateIndex ?? 0));
  const docs = await Promise.all(
    candidates.map(async (task) => {
      const index = task.candidateIndex ?? 0;
      return {
        plan: await readCandidateDoc(cwd, run.id, index, "PLAN.md"),
        prd: await readCandidateDoc(cwd, run.id, index, "PRD.md"),
      };
    }),
  );
  const usable = docs.filter((doc) => doc.plan.trim() || doc.prd.trim());
  if (usable.length === 0) return null;
  return usable.reduce((best, doc) =>
    doc.plan.length + doc.prd.length > best.plan.length + best.prd.length ? doc : best,
  );
}

// Drive a council run forward at each review hop. Phase 1: the candidate planners
// have finished — spawn ONE synthesis worker on the user's SELECTED backend (no
// OpenRouter) that reads the drafts and writes the merged .spark/<runId>/spark-plan/ itself.
// Phase 2: the synthesis worker has finished — finalize the run from its files.
async function advanceCouncil(run: RunState, cwd: string): Promise<void> {
  const synthesisTask = run.workerTasks.find((task) => task.councilRole === "synthesis");
  if (!synthesisTask) {
    const prepared = await prepareCouncilSynthesis(run, cwd);
    if (!prepared) {
      // No CLI agent selected (or every candidate failed) — fall back to a
      // deterministic pick of the most complete draft. No OpenRouter, no agent.
      await finalizeCouncilDeterministic(run, cwd);
      return;
    }
    // Re-enter the loop to launch the synthesis worker — mirrors the pending-task
    // deferral above (the force-council guard is steps.length===0, so no second
    // candidate batch is spawned).
    const input = autopilotInputFromRun(prepared);
    await startAutopilot({ ...input, cwd: cwd || input.cwd, runId: prepared.id });
    return;
  }
  await finalizeCouncilFromDisk(run, cwd);
}

// Phase 1 → 2: mark the candidate batch accepted + close its step, then add a
// synthesis step with one worker (on the selected backend) that reads every
// candidate's PLAN.md/PRD.md and writes the merged best-of-all into .spark/<runId>/spark-plan/.
// Returns the updated run, or null when synthesis can't run (caller falls back).
async function prepareCouncilSynthesis(run: RunState, cwd: string): Promise<RunState | null> {
  const runtime = councilSynthesisRuntime(run);
  if (!runtime) return null;
  const candidates = run.workerTasks
    .filter((task) => task.councilRole === "candidate")
    .sort((a, b) => (a.candidateIndex ?? 0) - (b.candidateIndex ?? 0));
  if (candidates.length === 0) return null;
  // Nothing to merge if every candidate failed — let the deterministic fallback
  // (which writes whatever drafts exist) handle it instead of spawning a worker.
  if (candidates.every((task) => task.status === "failed")) return null;
  const councilGroupId = candidates[0]?.councilGroupId;

  // Close out the candidate batch so the synthesis step becomes the ACTIVE step —
  // pickAutopilotTasks only launches tasks in the active step. Complete existing
  // steps first, THEN add the synthesis step below (which stays open).
  let updated = await commitRunChange(run, {
    type: "plan_council.candidates_complete",
    message: `Plan council — ${candidates.length} candidate draft(s) ready; synthesizing on ${runtime}`,
    mutate: (draft, timestamp) => {
      for (const task of draft.workerTasks) {
        if (task.councilRole === "candidate" && task.status !== "failed") {
          task.status = "accepted";
          task.updatedAt = timestamp;
        }
      }
      for (const step of draft.steps) {
        if (step.status !== "failed") {
          step.status = "complete";
          step.updatedAt = timestamp;
        }
      }
      draft.updatedAt = timestamp;
    },
  });

  const candidateList = candidates
    .map((task) => `  - ${councilCandidateDir(run.id, task.candidateIndex ?? 0)} (${task.runtimePreference})`)
    .join("\n");
  const taskText = councilTaskFromRun(run);
  const synthPrompt =
    `You are the SYNTHESIS judge of a Best-of-N planning council. ${candidates.length} independent agents ` +
    `each drafted an implementation PLAN.md and a PRD.md for the SAME task, in these folders:\n${candidateList}\n\n` +
    `Read every candidate's PLAN.md and PRD.md, then produce the SINGLE BEST merged pair by taking the strongest, ` +
    `most correct and most complete ideas from across ALL candidates — resolve contradictions in favor of the ` +
    `most rigorous option and drop weak or duplicated material. Write ONLY these two files:\n` +
    `  - ${councilPlanDir(run.id)}/PLAN.md  — the merged, best-of-all implementation plan\n` +
    `  - ${councilPlanDir(run.id)}/PRD.md   — the merged, best-of-all product requirements document\n\n` +
    `Create the ${councilPlanDir(run.id)}/ folder if needed and write ONLY those two files. Do NOT write application ` +
    `code and do NOT modify anything outside ${councilPlanDir(run.id)}/.\n\n# Task\n${taskText}`;

  updated = await createStep({
    runId: updated.id,
    title: "Plan synthesis",
    goal:
      `A single judge on the selected agent merges the ${candidates.length} candidate drafts into the best ` +
      `PLAN.md + PRD.md and writes them to ${councilPlanDir(run.id)}/.`,
    kind: "worker_batch",
    plannedAgents: [
      {
        label: "synthesis judge",
        summary: `Merge the ${candidates.length} candidate plans into ${councilPlanDir(run.id)}/PLAN.md + PRD.md.`,
        runtimePreference: runtime,
        taskClass: "feature",
      },
    ],
    riskLevel: "low",
    acceptanceCriteria: [
      `${councilPlanDir(run.id)}/PLAN.md and ${councilPlanDir(run.id)}/PRD.md are written, merging the candidate drafts.`,
    ],
  });
  const stepId = updated.steps.at(-1)?.id;
  if (!stepId) return null;

  // The "main AI" judge runs on the model + effort the user picked in the
  // composer (e.g. Opus 4.8 @ medium) — it's the one that decides what to keep
  // from each candidate. Fall back to a top-tier default only if the run didn't
  // record a selection. Sanitize the hint so a stale superseded-Sonnet or
  // legacy Codex id from an old run is remapped to the current catalog.
  const judgeModel = sanitizeWorkerModelHint(run.chatModel ?? COUNCIL_TOP_TIER_MODEL[runtime]);

  updated = await createWorkerTask({
    runId: updated.id,
    stepId,
    title: "Synthesize best-of-all plan",
    description: synthPrompt,
    runtimePreference: runtime,
    modelHint: judgeModel,
    effortHint: run.chatEffort ?? "high",
    allowedPaths: [`${councilPlanDir(run.id)}/`],
    forbiddenPaths: [],
    expectedOutputs: [`${councilPlanDir(run.id)}/PLAN.md`, `${councilPlanDir(run.id)}/PRD.md`],
    verificationCommands: [],
    canRunParallel: false,
    conflictsWith: [],
    taskClass: "feature",
    councilGroupId,
    councilRole: "synthesis",
    createdBy: "spark",
  });

  await appendEvent({
    workspaceId: updated.workspaceId,
    runId: updated.id,
    stepId,
    type: "plan_council.synthesis_started",
    message: `Plan synthesis started on ${runtime}`,
    payload: { runtime, candidateCount: candidates.length },
  });

  return requireRun(updated.id);
}

// Phase 2: the synthesis worker has written spark-plan/PLAN.md + PRD.md itself.
// Read PLAN.md (fall back to the most complete candidate if the worker produced
// nothing), then finalize.
async function finalizeCouncilFromDisk(run: RunState, cwd: string): Promise<void> {
  const planDir = join(cwd, ".spark", run.id, "spark-plan");
  const planFilePath = join(planDir, "PLAN.md");
  const prdFilePath = join(planDir, "PRD.md");
  let planText = await fs.readFile(planFilePath, "utf8").catch(() => "");
  let via: "synthesis" | "fallback" = "synthesis";

  if (!planText.trim()) {
    via = "fallback";
    const best = await pickMostCompleteCandidate(run, cwd);
    if (best) {
      planText = best.plan;
      await fs.mkdir(planDir, { recursive: true }).catch(() => undefined);
      if (best.plan.trim()) {
        await fs.writeFile(planFilePath, `${best.plan.trimEnd()}\n`, "utf8").catch(() => undefined);
      }
      if (best.prd.trim()) {
        await fs.writeFile(prdFilePath, `${best.prd.trimEnd()}\n`, "utf8").catch(() => undefined);
      }
    }
  }

  await cleanupCouncilCandidates(cwd, run.id);
  await finalizeCouncil(run, planText, planFilePath, via);
}

// Fallback when no CLI agent is available to synthesize: pick the most complete
// candidate draft, write it to spark-plan/, complete the run. No OpenRouter.
async function finalizeCouncilDeterministic(run: RunState, cwd: string): Promise<void> {
  const planDir = join(cwd, ".spark", run.id, "spark-plan");
  const planFilePath = join(planDir, "PLAN.md");
  const prdFilePath = join(planDir, "PRD.md");
  const best = await pickMostCompleteCandidate(run, cwd);
  const planText = best?.plan ?? "";
  if (best && (best.plan.trim() || best.prd.trim())) {
    await fs.mkdir(planDir, { recursive: true }).catch(() => undefined);
    if (best.plan.trim()) {
      await fs.writeFile(planFilePath, `${best.plan.trimEnd()}\n`, "utf8").catch(() => undefined);
    }
    if (best.prd.trim()) {
      await fs.writeFile(prdFilePath, `${best.prd.trimEnd()}\n`, "utf8").catch(() => undefined);
    }
  }
  await cleanupCouncilCandidates(cwd, run.id);
  await finalizeCouncil(run, planText, planFilePath, "fallback");
}

// Shared completion: surface the plan as the run's active plan (with sourceFile so
// Execute / "Run plan" targets the file), mark all council tasks accepted + steps
// complete, and complete the run.
async function finalizeCouncil(
  run: RunState,
  planText: string,
  planFilePath: string,
  via: "synthesis" | "fallback",
): Promise<void> {
  await appendEvent({
    workspaceId: run.workspaceId,
    runId: run.id,
    type: "plan_council.synthesized",
    message: `Plan written to ${councilPlanDir(run.id)}/ (${via})`,
    payload: { via, planPath: planFilePath },
  });

  const fresh = await requireRun(run.id);
  await commitRunChange(fresh, {
    type: "plan_council.completed",
    message: `Plan council complete — plan written to ${councilPlanDir(run.id)}/`,
    payload: { via },
    mutate: (draft, timestamp) => {
      for (const task of draft.workerTasks) {
        if (task.councilGroupId !== undefined && task.status !== "failed") {
          task.status = "accepted";
          task.updatedAt = timestamp;
        }
      }
      for (const step of draft.steps) {
        if (step.status !== "failed") {
          step.status = "complete";
          step.updatedAt = timestamp;
        }
      }
      if (planText.trim()) {
        const plan = {
          id: makeId("plan"),
          workspaceId: draft.workspaceId,
          title: "Synthesized plan (council)",
          // Point at the on-disk file so switching to Execute / "Run plan"
          // targets it directly (the execute path keys off plan.sourceFile).
          sourceFile: planFilePath,
          rawContent: planText,
          requirements: [],
          status: "active" as const,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        draft.plans.push(plan);
        draft.planId = plan.id;
      }
      draft.status = "complete";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
        status: "complete",
        lastAction: "plan_council_synthesized",
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
  });
}

async function rerouteUnavailableAgentRuntimes(
  decision: SparkManagerDecision,
): Promise<{ decision: SparkManagerDecision; rerouted: RuntimeReroute[] }> {
  const diagnostics = await detectConfiguredAgentRuntimes();
  const available = diagnostics.filter((runtime) => runtime.installed);
  const availableKinds = new Set(available.map((runtime) => runtime.kind));
  const fallback = available.find((runtime) => runtime.kind === "codex")
    ?? available.find((runtime) => runtime.kind === "claude");
  const rerouted: RuntimeReroute[] = [];

  const rewrite = (runtimePreference: WorkerRuntime, modelHint?: string, effortHint?: WorkerTask["effortHint"]) => {
    if (runtimePreference !== "claude" && runtimePreference !== "codex") {
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
// runtime mandate ("use only claude", "every agent should be codex"). Returns
// the mandated runtime or null. When a mandate is present,
// enforceUserRuntimeMandate rewrites every follow-up task the manager queues
// to that runtime — overriding the manager's cross-provider verifier rotation
// and any attempt to escalate to a different runtime on failure. The manager
// profile contains the same instruction at the prompt layer; this code path
// is the defensive backstop when the manager forgets.
function detectPlanRuntimeMandate(run: RunState): WorkerRuntime | null {
  const planText = run.plans?.[0]?.rawContent ?? "";
  if (!planText) return null;
  const runtimes: WorkerRuntime[] = ["claude", "codex"];
  for (const rt of runtimes) {
    const patterns = [
      // "all/every/only the workers ... <runtime>"
      new RegExp(`\\b(all|every|only|each)\\s+(the\\s+|of\\s+the\\s+)?(worker|workers|agent|agents)\\b[^.\\n]{0,80}\\b${rt}\\b`, "i"),
      // "<runtime> only" / "<runtime> exclusively"
      new RegExp(`\\b${rt}\\s+(only|exclusively|throughout)\\b`, "i"),
      // "only <runtime>" / "exclusively <runtime>"
      new RegExp(`\\b(only|exclusively)\\s+${rt}\\b`, "i"),
      // "use (only) <runtime> for/workers/agents"
      new RegExp(`\\buse\\s+(only\\s+)?${rt}\\b`, "i"),
      // "(workers|agents) (should|must|to) be <runtime>"
      new RegExp(`\\b(worker|workers|agent|agents)\\s+(should|must|need(s)?\\s+to|have\\s+to|to)\\s+be\\s+${rt}\\b`, "i"),
      // "I want ... workers ... be <runtime>"
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
  if (mandate !== "claude" && mandate !== "codex") {
    return { decision, overrides: [] };
  }
  if (!installedKinds.has(mandate)) {
    return { decision, overrides: [] };
  }
  const modelDefaults: Record<string, { modelHint?: string; effortHint?: WorkerTask["effortHint"] }> = {
    claude: { modelHint: "claude-opus-4-8", effortHint: "high" },
    codex: { modelHint: CODEX_MODEL_BY_TIER.top, effortHint: "high" },
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
      runtimePreference !== "codex"
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

// Does this decision task write to the workspace (so it deserves a concrete
// write scope)? Verifier-class and manual workers do not edit files, so they
// are never scope-derived. Mirrors taskWritesWorkspace (which operates on a
// materialized WorkerTask) for the pre-creation SparkManagerTaskDecision shape.
function decisionTaskWritesWorkspace(task: SparkManagerTaskDecision): boolean {
  return task.taskClass !== "verifier" && task.runtimePreference !== "manual";
}

// Collect the REAL files prior completed NON-verifier workers touched, read
// from their final reports (attempt.finalReportPath → readWorkerReport). This
// is the recon/skeleton lineage's actual filesystem footprint. Deduped by
// normalized path while preserving the worker's original path string for the
// rewritten allowedPaths. Also returns the titles of the source tasks for the
// derived-scopes event payload.
async function collectPriorWorkerChangedFiles(
  run: RunState,
): Promise<{ paths: string[]; sourceTaskTitles: string[] }> {
  const byKey = new Map<string, string>();
  const sourceTaskTitles = new Set<string>();
  for (const attempt of run.workerAttempts) {
    const task = run.workerTasks.find((t) => t.id === attempt.workerTaskId);
    if (!task || task.taskClass === "verifier") continue;
    if (!taskWritesWorkspace(task)) continue;
    if (!attempt.finalReportPath) continue;
    const report = await readWorkerReport(attempt.finalReportPath);
    if (!report || !Array.isArray(report.filesChanged)) continue;
    let contributed = false;
    for (const file of report.filesChanged) {
      const original = file.path?.trim();
      if (!original) continue;
      if (isBroadPathScope(original)) continue;
      const key = normalizeTaskPath(original);
      if (!key || byKey.has(key)) continue;
      byKey.set(key, original.replace(/\\/g, "/"));
      contributed = true;
    }
    if (contributed) sourceTaskTitles.add(task.title);
  }
  return {
    paths: [...byKey.values()].sort((a, b) => a.localeCompare(b)),
    sourceTaskTitles: [...sourceTaskTitles],
  };
}

// After a recon/skeleton step, overwrite empty / broad-glob allowedPaths on the
// downstream implementation tasks the manager just proposed with the CONCRETE
// files prior workers actually changed. The manager has no filesystem access
// and guesses these scopes; deriving them from real filesChanged makes the next
// batch launch with disjoint, concrete scopes (so it stays parallel instead of
// being downgraded to serial by hasConcreteParallelScope). Only rewrites tasks
// whose concrete scope is currently EMPTY; never touches verifier/manual tasks.
// Returns the (possibly new) decision plus a per-task from/to diff, the source
// titles for the event, and the SET of rewritten decision-task references so
// the creation loop can stamp writeScopeSource="derived".
async function deriveDownstreamScopesFromFilesChanged(
  run: RunState,
  decision: SparkManagerDecision,
  stepIds: string[],
): Promise<{
  decision: SparkManagerDecision;
  derived: Array<{ taskTitle: string; from: string[]; to: string[] }>;
  sourceTaskTitles: string[];
  rewrittenTasks: Set<SparkManagerTaskDecision>;
}> {
  const empty = {
    decision,
    derived: [] as Array<{ taskTitle: string; from: string[]; to: string[] }>,
    sourceTaskTitles: [] as string[],
    rewrittenTasks: new Set<SparkManagerTaskDecision>(),
  };
  if (decision.tasks.length === 0) return empty;

  // Candidates: about-to-be-created workspace-writing tasks that map onto a
  // mutable step and whose concrete scope the manager left empty/broad.
  const candidates = decision.tasks.filter((task) => {
    if (!decisionTaskWritesWorkspace(task)) return false;
    if (concreteDecisionAllowedPaths(task).length > 0) return false;
    return Boolean(resolveTaskStepId(run, task.stepIndex, stepIds));
  });
  if (candidates.length === 0) return empty;

  const prior = await collectPriorWorkerChangedFiles(run);
  if (prior.paths.length === 0) return empty;

  // Partition concrete paths across the candidates. A single downstream impl
  // task owns ALL prior changed files; multiple candidates split them
  // round-robin so each worker still gets a disjoint slice. A candidate that
  // would receive zero paths (more candidates than files) is left untouched.
  const assignments = new Map<SparkManagerTaskDecision, string[]>();
  if (candidates.length === 1) {
    assignments.set(candidates[0], [...prior.paths]);
  } else {
    for (let i = 0; i < prior.paths.length; i++) {
      const candidate = candidates[i % candidates.length];
      const list = assignments.get(candidate) ?? [];
      list.push(prior.paths[i]);
      assignments.set(candidate, list);
    }
  }

  const rewrittenTasks = new Set<SparkManagerTaskDecision>();
  const derived: Array<{ taskTitle: string; from: string[]; to: string[] }> = [];
  const tasks = decision.tasks.map((task) => {
    const assigned = assignments.get(task);
    if (!assigned || assigned.length === 0) return task;
    const rewritten: SparkManagerTaskDecision = { ...task, allowedPaths: assigned };
    rewrittenTasks.add(rewritten);
    derived.push({ taskTitle: task.title, from: [...task.allowedPaths], to: assigned });
    return rewritten;
  });

  if (derived.length === 0) return empty;
  return {
    decision: { ...decision, tasks },
    derived,
    sourceTaskTitles: prior.sourceTaskTitles,
    rewrittenTasks,
  };
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
// internally. Codara's job is to relay intent, not invent files.
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
  const activeStep = pickPendingAutopilotStep(run);
  if (!activeStep) return null;
  if ((activeStep.kind ?? "worker_batch") !== "worker_batch") return null;
  const agents = activeStep.plannedAgents ?? [];
  if (agents.length !== 1) return null;
  const agent = agents[0];
  if (agent.taskClass === "verifier") return null;
  if (
    agent.runtimePreference !== "claude" &&
    agent.runtimePreference !== "codex"
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
    "Cora (the orchestrator that dispatched you) has no filesystem access and knows nothing concrete about this codebase. It's just relaying intent. You have full access — explore the repo yourself.",
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

// Effort levels accepted by the current Claude and Codex CLIs for standing
// interactive terminals. GPT-5.6 adds Max as a first-class quality setting;
// both providers receive the explicit choice instead of silently ignoring it.
const STANDING_TERMINAL_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

// Build the launch command for a standing interactive terminal: a plain
// claude/codex session the user drives. Like buildLaunchCommandLine, but
// without the worker-task wiring — these are not Cora workers.
//
// The CLI-specific argv is produced by the runtime's `CliProvider`
// (see src/main/providers/) so adding a new CLI later only requires a new
// provider file.
function buildStandingTerminalCommand(
  runtime: "claude" | "codex",
  model?: string,
  effort?: string,
): string {
  let effectiveEffort: SpawnOpts["effort"];
  if (effort && STANDING_TERMINAL_EFFORTS.has(effort)) {
    effectiveEffort = effort as SpawnOpts["effort"];
  }

  let effectiveModel = model?.trim() || undefined;
  if (runtime === "codex" && effectiveModel) {
    effectiveModel = normalizeCodexModelId(effectiveModel);
  }

  const provider = getProvider(runtime);
  const providerArgs = provider.buildArgs({
    cwd: "",
    model: effectiveModel,
    effort: effectiveEffort,
  });

  // Claude and Codex bin names are unique on PATH and don't collide with
  // PowerShell aliases, so the head is just the runtime name.
  const head = runtime === "codex" ? "codex" : "claude";
  const tail = providerArgs.map((arg) => quoteShellArg(arg));
  return [head, ...tail].join(" ");
}

function standingTerminalTitle(runtime: "claude" | "codex", model?: string): string {
  const base = runtime === "codex" ? "Codex" : "Claude";
  return model ? `${base} ${model}` : base;
}

// One-line chat confirmation for a spawn_terminals decision, e.g. "Opened 2
// Claude and 1 Codex standing terminals ...". Counts by runtime (claude,
// codex) so the user gets concrete acknowledgement that the request landed.
function describeSpawnedTerminals(terminals: Array<{ runtime: string }>): string {
  const counts = new Map<string, number>();
  for (const terminal of terminals) {
    const label = terminal.runtime === "codex" ? "Codex" : "Claude";
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
    const label = terminal.runtime === "codex" ? "Codex" : "Claude";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts].map(([label, n]) => `${label} x${n}`);
  if (parts.length === 0) return "Agent terminals";
  return `${parts.join(" + ")} terminals`;
}

// Handle a spawn_terminals manager decision: the user asked Codara to open
// standing interactive terminals they will drive themselves. Codara emits one
// spark.spawn_terminals event carrying ready-to-run terminal specs (the
// renderer opens a grid tab with a pane per spec) and marks the run
// complete. A later chat message re-engages the manager via addRunMessage's
// terminal-run replanning path; the terminals are user-driven and are not
// tracked as Cora workers.
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

async function failManagerQuestionProtocol(
  run: RunState,
  decision: SparkManagerDecision,
  mode: SparkCall["mode"],
  error: string,
): Promise<RunState> {
  return commitRunChange(run, {
    type: "spark_manager.question_protocol_failed",
    message: `Cora manager question protocol failed: ${error}`,
    payload: {
      mode,
      question: decision.question,
      category: decision.questionCategory,
      reason: decision.questionReason,
      error,
    },
    mutate: (draft, timestamp) => {
      draft.status = "failed";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
        status: "failed",
        lastAction: "question_protocol_failed",
        stopReason: error,
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
  cwd: string,
  backendTurnId?: string,
  decisionEpoch: number = conversationEpoch(run),
  autonomyRetryCount = 0,
): Promise<RunState> {
  if (conversationEpoch(run) !== decisionEpoch) return run;
  return managerDecisionMutationContext.run(
    { runId: run.id, conversationEpoch: decisionEpoch },
    () => applySparkManagerDecisionCurrent(
      run,
      decision,
      mode,
      cwd,
      backendTurnId,
      decisionEpoch,
      autonomyRetryCount,
    ),
  );
}

async function applySparkManagerDecisionCurrent(
  run: RunState,
  decision: SparkManagerDecision,
  mode: SparkCall["mode"],
  cwd: string,
  backendTurnId: string | undefined,
  decisionEpoch: number,
  autonomyRetryCount: number,
): Promise<RunState> {
  // Defensive: if the run already reached a terminal state, drop the decision.
  // This guards against a race where an MCP tool call (e.g. codara_complete
  // via handleOrchestratorComplete) flipped run.status BEFORE the same
  // turn's tool calls were synthesized into a SparkManagerDecision and
  // applied here. Without this guard, a stale {status:"run_workers"} decision
  // would create phantom steps and worker tasks on top of an already-
  // complete run — they'd sit in status="created"/"queued" forever because
  // autopilot is already blocked, producing the "STEP 01 ... 0/1 done" UI
  // artifact even though the user's real request finished cleanly.
  if (
    run.status === "complete" ||
    run.status === "failed" ||
    run.status === "cancelled"
  ) {
    await appendEvent({
      workspaceId: run.workspaceId,
      runId: run.id,
      type: "spark_manager.decision_dropped_run_terminal",
      message: `Dropped ${decision.status} decision; run is already ${run.status}.`,
      payload: {
        runStatus: run.status,
        decisionStatus: decision.status,
        summary: decision.summary,
        mode,
      },
    });
    return run;
  }
  // Execute-mode planning must never turn a prose-only promise into a green
  // run. CLI managers synthesize a status=complete talk decision when no Cora
  // tool was called; with an empty run that used to produce "done" after zero
  // workers, zero edits, and zero checks. Real codara_spawn_workers calls
  // mutate the run live before this decision is applied, so an untouched
  // plan_analysis completion is unambiguously a manager protocol failure.
  if (
    mode === "plan_analysis" &&
    decision.status === "complete" &&
    run.steps.length === 0 &&
    run.workerTasks.length === 0
  ) {
    return commitRunChange(run, {
      type: "spark_manager.empty_execution_refused",
      message: "Cora refused an execute-mode completion with no worker activity",
      payload: {
        summary: decision.summary,
        reply: decision.chatReply,
        mode,
        reason: "no_steps_or_workers",
      },
      mutate: (draft, timestamp) => {
        draft.status = "failed";
        draft.autopilot = {
          ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
          status: "failed",
          lastAction: "empty_execution_refused",
          stopReason:
            "The manager finished without calling a Cora orchestration tool or creating any worker task.",
          updatedAt: timestamp,
        };
        draft.updatedAt = timestamp;
      },
    });
  }
  // Surface the manager's natural-language reply to the user as a Codara chat
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
        intent: "answer",
        deliveryState: "acknowledged",
        targetTurnId: backendTurnId,
        backendTurnId,
        conversationEpoch: decisionEpoch,
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
        message: "Cora asked for input while planned work remained; continuing the existing plan",
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
        (step) => !["complete", "completed_unverified", "failed", "skipped"].includes(step.status),
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
    const question =
      decision.question || "Please clarify what Cora should do next.";
    const policy = decideRunManagerQuestion({
      question,
      category: decision.questionCategory,
      reason: decision.questionReason,
      options: decision.questionOptions,
      recommendedOptionId: decision.recommendedOptionId,
      priorAssumptions: run.assumptions,
    });
    if (policy.action === "protocol_error") {
      return failManagerQuestionProtocol(run, decision, mode, policy.error);
    }
    if (
      policy.action === "assume" &&
      autonomyRetryCount >= MAX_MANAGER_QUESTION_REPROMPTS
    ) {
      return failManagerQuestionProtocol(
        run,
        decision,
        mode,
        `Manager exceeded the ${MAX_MANAGER_QUESTION_REPROMPTS}-attempt autonomous question retry limit.`,
      );
    }
    let resolved: ResolveManagerQuestionResult;
    try {
      resolved = await resolveManagerQuestion({
        runId: run.id,
        message: question,
        questionOptions: decision.questionOptions,
        category: decision.questionCategory,
        reason: decision.questionReason,
        recommendedOptionId: decision.recommendedOptionId,
        source: "manager_decision",
        resumeStrategy: "schedule_manager",
        managerMode: mode,
        backendTurnId,
        conversationEpoch: decisionEpoch,
        autonomyRetryCount,
      });
    } catch (error) {
      return failManagerQuestionProtocol(
        run,
        decision,
        mode,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (resolved.action === "blocked") return resolved.run;
    // resolveManagerQuestion persisted and scheduled this exact same-stage
    // continuation. Returning lets the current manager call settle before the
    // durable queue launches the reprompt (and survives a process exit here).
    return resolved.run;
  }

  if (decision.status === "complete") {
    if (mode === "chat") {
      return commitRunChange(run, {
        type: "spark_manager.chat_completed",
        message: "Cora answered the chat turn",
        payload: {
          summary: decision.summary,
        },
        mutate: (draft, timestamp) => {
          const terminalStepStatuses = new Set(["complete", "completed_unverified", "failed", "skipped"]);
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
      (step) => !["complete", "completed_unverified", "failed", "skipped"].includes(step.status),
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
          message: "Cora marked the run complete after accepting reviewed steps",
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
          // Verifier invariant gate: this force-accept path deliberately lands
          // the run even though the manager skipped the verifier. A changed-
          // files step that never earned a terminal verifier verdict must NOT
          // masquerade as a clean `complete` — it lands as `completed_unverified`
          // instead, honestly labeling the missing cross-provider sign-off.
          // Precompute which affected steps DID earn a terminal verdict (read
          // from disk) before the synchronous mutate.
          const affectedStepIdsForVerdict = new Set(
            needsReviewTasks
              .map((t) => t.stepId)
              .filter((id): id is string => Boolean(id)),
          );
          const affectedStepIdsWithVerdict = new Set<string>();
          for (const stepId of affectedStepIdsForVerdict) {
            if (await stepHasTerminalVerifierVerdict(run, stepId)) {
              affectedStepIdsWithVerdict.add(stepId);
            }
          }
          return commitRunChange(run, {
            type: "spark_manager.force_accepted_after_refused_completion",
            message: `Manager returned complete twice with ${needsReviewTasks.length} needs_review task(s); force-accepting so the run can land`,
            payload: {
              summary: decision.summary,
              acceptedTaskIds: needsReviewTasks.map((t) => t.id),
              acceptedTaskTitles: needsReviewTasks.map((t) => t.title),
              acceptedTaskClasses: needsReviewTasks.map((t) => t.taskClass),
              priorRefusals,
              unverifiedStepIds: Array.from(affectedStepIdsForVerdict).filter(
                (id) => !affectedStepIdsWithVerdict.has(id),
              ),
              reason: "no_terminal_verifier_verdict",
            },
            mutate: (draft, timestamp) => {
              const acceptedIds = new Set(needsReviewTasks.map((t) => t.id));
              for (const task of draft.workerTasks) {
                if (acceptedIds.has(task.id)) {
                  task.status = "accepted";
                  // Mark this as a deadlock-break accept (no passing verifier
                  // verdict) so the UI can render the "Unverified — accepted to
                  // avoid deadlock" pill instead of the normal verified treatment.
                  task.forceAccepted = true;
                  task.forceAcceptReason = "completion_refused";
                  task.updatedAt = timestamp;
                }
              }
              // Mirror the worker-review accept path: promote any step whose
              // tasks are now all accepted. A changed-files step without a
              // terminal verifier verdict lands as completed_unverified (honest
              // label) rather than a clean complete, so the autopilot doesn't
              // loop on a step stuck at "reviewing" with nothing to do.
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
                  step.status = affectedStepIdsWithVerdict.has(step.id)
                    ? "complete"
                    : "completed_unverified";
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
                  ["complete", "completed_unverified", "failed", "skipped"].includes(s.status),
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
      message: "Cora marked the run complete",
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
  // the manager decided — the dominant cause of "Codara almost only uses
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

  // Cross-provider verification is a code-level invariant, not a manager habit.
  // Before any step-completion pass below can flip a changed-files impl step to
  // complete, guarantee it has (or will have) an independent verifier. This runs
  // on the normalized run_workers decision and synthesizes a verifier task for
  // any uncovered, changed-files step — so the step-completion passes (and the
  // gating helper) see the pending verifier and keep the step reviewing.
  if (mode === "worker_result_review") {
    run = await ensureVerifierCoverage(run, cwd);
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
            title: "Cora planned work",
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
  // follow-ups). Mid-tier sonnet misses 1-of-N distinct issues without a
  // verifier to catch it; we observed exactly this on a 3-bug fix where the
  // worker landed only 2/3 hidden gates. Code-level enforcement: walk every
  // plannedAgent on every step and every incoming task, and promote any
  // non-top-tier feature assignment to top-tier (opus@high for claude,
  // GPT-5.6 Sol@high for codex). Codex now has a real model ladder, so this
  // promotes Terra/Luna to Sol as well as bumping effort; sonnet→opus still
  // applies on Claude.
  // Leaf and verifier are exempt from this floor (see promoteForTrivial).
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
        // Prefer any verifier whose runtime differs from the implementation
        // worker's; either supported cross-provider direction is acceptable.
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

  // Derive concrete downstream write scopes from prior workers' REAL
  // filesChanged. After a recon/skeleton step finishes, the manager often hands
  // a downstream implementation task a broad glob or empty allowedPaths because
  // it has no filesystem access and was guessing. Overwrite those with the
  // exact files the recon/skeleton workers actually touched so the next batch
  // launches with disjoint, concrete scopes (and stays parallel). Tasks rewritten
  // here are tagged writeScopeSource="derived" when created below.
  const derivedScopes = await deriveDownstreamScopesFromFilesChanged(latest, decision, stepIds);
  const derivedTaskRefs = derivedScopes.rewrittenTasks;
  if (derivedScopes.derived.length > 0) {
    decision = derivedScopes.decision;
    await appendWriteScopesDerivedEvent({
      workspaceId: latest.workspaceId,
      runId: latest.id,
      derived: derivedScopes.derived,
      sourceTaskTitles: derivedScopes.sourceTaskTitles,
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
    // Verifier invariant gate: this is a force-accept path (the corrective loop
    // hit MAX_TASKS_PER_STEP). A capped step that changed files but never earned
    // a terminal verifier verdict must land as `completed_unverified`, not a
    // clean `complete`. Precompute which capped steps DID earn a terminal
    // verdict (those land as `complete`) before the synchronous mutate.
    const cappedWithVerdict = new Set<string>();
    for (const stepId of skippedStepIds) {
      if (await stepHasTerminalVerifierVerdict(latest, stepId)) {
        cappedWithVerdict.add(stepId);
      }
    }
    latest = await commitRunChange(latest, {
      type: "spark_manager.corrective_rounds_capped",
      message: `Step task cap (${MAX_TASKS_PER_STEP}) reached; force-accepting pending work and skipping new tasks`,
      payload: {
        cappedStepIds: Array.from(skippedStepIds),
        cappedStepIdsWithVerifierVerdict: Array.from(cappedWithVerdict),
        cappedStepIdsUnverified: Array.from(skippedStepIds).filter((id) => !cappedWithVerdict.has(id)),
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
            // Cap-break accept (corrective re-attempts exhausted without a
            // passing verdict) — flag it so the UI distinguishes this from a
            // verified accept.
            t.forceAccepted = true;
            t.forceAcceptReason = "corrective_rounds_capped";
            t.updatedAt = timestamp;
          }
        }
        const stepTerminal = (s: typeof draft.steps[number]): boolean =>
          ["complete", "completed_unverified", "failed", "skipped"].includes(s.status);
        for (const step of draft.steps) {
          if (!skippedStepIds.has(step.id)) continue;
          const allDone = draft.workerTasks
            .filter((t) => t.stepId === step.id)
            .every((t) => ["accepted", "failed", "cancelled", "blocked"].includes(t.status));
          if (allDone && !stepTerminal(step)) {
            step.status = cappedWithVerdict.has(step.id) ? "complete" : "completed_unverified";
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
      writeScopeSource: derivedTaskRefs.has(task) ? "derived" : undefined,
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
    message: "Cora decision applied",
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

export interface PostRunQuestionInput {
  runId: string;
  clientMessageId?: string;
  message: string;
  questionOptions?: RunQuestionOption[];
  category?: RunQuestionCategory;
  reason?: string;
  recommendedOptionId?: string;
  source: RunQuestionSource;
  resumeStrategy: RunQuestionResumeStrategy;
  resumeStatus?: RunStatus;
  managerMode?: SparkCall["mode"];
  backendTurnId?: string;
  conversationEpoch?: number;
  autonomyRetryCount?: number;
}

export interface PostRunQuestionResult {
  run: RunState;
  questionMessageId: string;
}

export function resolveOpenRunQuestion(run: RunState) {
  return resolveOpenRunQuestionPure(run);
}

export type ResolveManagerQuestionResult =
  | { action: "blocked"; run: RunState; questionMessageId: string }
  | { action: "assumed"; run: RunState; assumption: RunAssumption };

/** Apply Cora's deterministic ask-versus-assume policy before any manager-owned
 * question reaches the human. Consent gates deliberately bypass this helper. */
export async function resolveManagerQuestion(
  input: PostRunQuestionInput,
): Promise<ResolveManagerQuestionResult> {
  const run = await requireRun(input.runId);
  const decision = decideRunManagerQuestion({
    question: input.message,
    category: input.category,
    reason: input.reason,
    options: input.questionOptions,
    recommendedOptionId: input.recommendedOptionId,
    priorAssumptions: run.assumptions,
  });
  if (decision.action === "protocol_error") {
    throw new Error(decision.error);
  }
  if (decision.action === "block") {
    const posted = await postRunQuestion({
      ...input,
      category: decision.category,
      reason: decision.reason,
      recommendedOptionId: decision.recommendedOptionId,
    });
    return {
      action: "blocked",
      run: posted.run,
      questionMessageId: posted.questionMessageId,
    };
  }

  // The budget is reconstructed from persisted assumptions, not the current
  // JavaScript call stack. This covers restarts and live Claude/Codex MCP turns
  // as well as OpenRouter recursion.
  const durableRetryCount = (run.assumptions ?? []).filter(
    (assumption) =>
      assumption.managerMode === input.managerMode &&
      (assumption.conversationEpoch ?? 0) ===
        (input.conversationEpoch ?? conversationEpoch(run)),
  ).length;
  if (durableRetryCount >= MAX_MANAGER_QUESTION_REPROMPTS) {
    throw new Error(
      `Manager exceeded the ${MAX_MANAGER_QUESTION_REPROMPTS}-attempt autonomous question retry limit.`,
    );
  }

  const assumptionId = makeId("assumption");
  let assumption: RunAssumption | undefined;
  const updated = await commitRunChange(run, {
    type: "manager.assumption_applied",
    message: decision.selectedAnswer.slice(0, 200),
    payload: {
      assumptionId,
      question: input.message,
      selectedAnswer: decision.selectedAnswer,
      optionId: decision.optionId,
      signature: decision.signature,
      source: input.source,
      managerMode: input.managerMode,
      conversationEpoch: input.conversationEpoch ?? conversationEpoch(run),
    },
    mutate: (draft, timestamp) => {
      if (
        input.conversationEpoch !== undefined &&
        conversationEpoch(draft) !== input.conversationEpoch
      ) {
        throw new StaleManagerDecisionError(
          draft.id,
          input.conversationEpoch,
          conversationEpoch(draft),
        );
      }
      const current = decideRunManagerQuestion({
        question: input.message,
        category: input.category,
        reason: input.reason,
        options: input.questionOptions,
        recommendedOptionId: input.recommendedOptionId,
        priorAssumptions: draft.assumptions,
      });
      if (current.action !== "assume") {
        throw new Error(
          current.action === "protocol_error"
            ? current.error
            : "Manager question policy changed while the assumption was being persisted.",
        );
      }
      assumption = {
        id: assumptionId,
        question: input.message.trim(),
        selectedAnswer: current.selectedAnswer,
        source: input.source,
        optionId: current.optionId,
        signature: current.signature,
        managerMode: input.managerMode,
        conversationEpoch: input.conversationEpoch ?? conversationEpoch(draft),
        createdAt: timestamp,
      };
      draft.assumptions ??= [];
      draft.assumptions.push(assumption);
      // Stateless manager decisions end the current call after an assumption.
      // Persist the same-stage continuation before returning so a crash cannot
      // strand the run between recording the assumption and re-prompting.
      if (input.source === "manager_decision" && input.managerMode) {
        draft.pendingManagerResume = {
          questionMessageId: `assumption:${assumptionId}`,
          assumptionId,
          managerMode: input.managerMode,
          autonomyRetryCount: durableRetryCount + 1,
          requestedAt: timestamp,
          state: "pending",
        };
      }
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
        lastAction: "assumption_applied",
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
  });
  if (!assumption) throw new Error("Manager assumption was not persisted.");
  schedulePendingManagerResume(updated);
  return { action: "assumed", run: updated, assumption };
}

/** Atomically persist one question and the blocker that owns its answer. */
export async function postRunQuestion(input: PostRunQuestionInput): Promise<PostRunQuestionResult> {
  const run = await requireRun(input.runId);
  const message = input.message.trim();
  if (!message) throw new Error("Question message is required.");
  const questionMessageId = makeId("msg");
  // Every new blocker needs a distinct normalization identity even when the
  // producer did not supply an idempotency key. Otherwise equal question text
  // can collapse while blockedOn still points at the removed second message.
  const clientMessageId = input.clientMessageId?.trim() || `run-question-${questionMessageId}`;
  const existing = run.humanMessages.find((entry) => entry.clientMessageId === clientMessageId);
  if (existing) {
    if (existing.author === "spark" && existing.kind === "question") {
      if (run.status === "blocked" && run.blockedOn?.questionMessageId === existing.id) {
        return { run, questionMessageId: existing.id };
      }
      throw new Error(`Run question is no longer active: ${existing.id}`);
    }
    throw new Error(`clientMessageId is already used by a non-question message: ${clientMessageId}`);
  }

  const questionOptions = normalizeQuestionOptionsForMessage(message, input.questionOptions);
  const category = input.category ?? inferRunQuestionCategory(message, input.source);
  const reason =
    input.reason?.trim() || "Cora cannot safely continue without the user's answer.";
  const recommendedOptionId =
    input.recommendedOptionId?.trim() ||
    questionOptions.find((option) => option.recommended)?.id;
  const questionContext: RunQuestionContext = {
    category,
    reason,
    recommendedOptionId,
    source: input.source,
  };
  let posted = false;
  let postedBlocker: RunBlocker | undefined;

  const updated = await commitRunChange(run, {
    type: "run.question_posted",
    message: message.slice(0, 160),
    payload: {
      questionMessageId,
      category,
      source: input.source,
      resumeStrategy: input.resumeStrategy,
    },
    mutate: (draft, timestamp) => {
      if (
        input.conversationEpoch !== undefined &&
        conversationEpoch(draft) !== input.conversationEpoch
      ) {
        throw new StaleManagerDecisionError(
          draft.id,
          input.conversationEpoch,
          conversationEpoch(draft),
        );
      }
      if (
        clientMessageId &&
        draft.humanMessages.some((entry) => entry.clientMessageId === clientMessageId)
      ) {
        return false;
      }
      if (draft.status === "paused" || isTerminalRunStatus(draft.status)) {
        throw new Error(`Cannot block inactive run ${draft.id} (${draft.status}).`);
      }
      const existingOpen = resolveOpenRunQuestionPure(draft);
      if (existingOpen) {
        throw new Error(`Run is already blocked on question ${existingOpen.id}.`);
      }
      const blocker = createRunBlocker({
        questionMessageId,
        category,
        currentStatus: draft.status,
        resumeStatus: input.resumeStatus,
        source: input.source,
        resumeStrategy: input.resumeStrategy,
        managerMode: input.managerMode,
        blockedAt: timestamp,
      });
      draft.humanMessages.push({
        id: questionMessageId,
        clientMessageId,
        runId: draft.id,
        author: "spark",
        kind: "question",
        message,
        questionOptions,
        questionContext,
        attachments: [],
        intent: "answer",
        deliveryState: "acknowledged",
        targetTurnId: input.backendTurnId,
        backendTurnId: input.backendTurnId,
        conversationEpoch: input.conversationEpoch ?? conversationEpoch(draft),
        createdAt: timestamp,
      });
      applyRunQuestionBlocker(draft, blocker, reason, timestamp);
      posted = true;
      postedBlocker = blocker;
    },
  });
  if (!posted) {
    const existing = clientMessageId
      ? updated.humanMessages.find((entry) => entry.clientMessageId === clientMessageId)
      : undefined;
    if (existing?.author === "spark" && existing.kind === "question") {
      if (
        updated.status === "blocked" &&
        updated.blockedOn?.questionMessageId === existing.id
      ) {
        return { run: updated, questionMessageId: existing.id };
      }
      throw new Error(`Run question is no longer active: ${existing.id}`);
    }
  }
  return {
    run: updated,
    questionMessageId: postedBlocker?.questionMessageId ?? questionMessageId,
  };
}

/** Validate and answer exactly one question, then apply its resume strategy. */
export async function answerRunQuestion(input: AnswerRunQuestionInput): Promise<RunState> {
  const run = await requireRun(input.runId);
  if (activeConversationRewinds.has(run.id)) {
    throw new Error("Conversation rewind is still in progress. Try answering again when it finishes.");
  }
  const questionMessageId = input.questionMessageId.trim();
  if (!questionMessageId) throw new Error("questionMessageId is required.");
  const attachmentInputs = input.attachments ?? [];
  const message = input.message.trim() || fallbackMessageForAttachments(attachmentInputs);
  if (!message) throw new Error("Answer message is required.");
  const clientMessageId = input.clientMessageId?.trim();
  if (
    run.status === "paused" ||
    run.status === "complete" ||
    run.status === "failed" ||
    run.status === "cancelled"
  ) {
    throw new Error(`Run question is no longer active: ${questionMessageId}`);
  }
  if (run.blockedOn && run.blockedOn.questionMessageId !== questionMessageId) {
    throw new Error(
      `Run is blocked on question ${run.blockedOn.questionMessageId}, not ${questionMessageId}.`,
    );
  }

  if (clientMessageId) {
    const existing = run.humanMessages.find((entry) => entry.clientMessageId === clientMessageId);
    if (existing) {
      if (
        existing.author === "user" &&
        existing.kind === "answer" &&
        existing.answersMessageId === questionMessageId &&
        existing.message === message
      ) {
        schedulePendingManagerResume(run);
        return run;
      }
      throw new Error(`clientMessageId is already used by another message: ${clientMessageId}`);
    }
  }

  const messageId = makeId("msg");
  const answerDeliveryState: RunMessageDeliveryState =
    run.blockedOn?.resumeStrategy === "active_rpc" ? "acknowledged" : "queued";
  const attachments = await persistRunMessageAttachments(
    run.id,
    messageId,
    attachmentInputs,
  );
  const answerMessage: RunState["humanMessages"][number] = {
    id: messageId,
    clientMessageId,
    runId: run.id,
    author: "user",
    kind: "answer",
    message,
    attachments,
    answersMessageId: questionMessageId,
    intent: "answer",
    deliveryState: answerDeliveryState,
    targetTurnId: `question:${questionMessageId}`,
    conversationEpoch: conversationEpoch(run),
    createdAt: new Date().toISOString(),
  };
  let answerRecorded = false;
  const updated = await commitRunChange(run, {
    type: "human.answer",
    message: `user: ${message.slice(0, 160)}`,
    payload: { message: answerMessage, questionMessageId },
    mutate: (draft, timestamp) => {
      if (
        clientMessageId &&
        draft.humanMessages.some((entry) => entry.clientMessageId === clientMessageId)
      ) {
        return false;
      }
      const applied = applyRunQuestionAnswer(draft, answerMessage, timestamp);
      if (applied.duplicate) return false;
      answerRecorded = true;
    },
  });
  if (!answerRecorded) {
    schedulePendingManagerResume(updated);
    return updated;
  }

  const cwd = workspaceCwdFromRun(updated);
  if (cwd) {
    const labelText = message.length > 60 ? `${message.slice(0, 60).trimEnd()}…` : message;
    void recordCheckpointInBackground({
      runId: updated.id,
      cwd,
      kind: "user-message",
      messageId,
      messagePointer: Math.max(0, updated.humanMessages.length - 1),
      label: labelText,
      conversationEpoch: conversationEpoch(updated),
    });
  }

  schedulePendingManagerResume(updated);
  return updated;
}

/** Release a live RPC blocker after disconnect/timeout without fabricating an answer. */
export async function releaseRunQuestion(
  runId: string,
  questionMessageId: string,
): Promise<RunState> {
  const run = await requireRun(runId);
  return commitRunChange(run, {
    type: "run.question_released",
    message: "Question wait ended without an answer",
    payload: { questionMessageId },
    mutate: (draft, timestamp) => {
      if (!releaseRunQuestionBlocker(draft, questionMessageId, timestamp)) return false;
    },
  });
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
          intent: "turn",
          deliveryState: "acknowledged",
          conversationEpoch: conversationEpoch(draft),
          createdAt: timestamp,
        });
      }
      abandonRunQuestionOwnership(draft);
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
          intent: "turn",
          deliveryState: "acknowledged",
          conversationEpoch: conversationEpoch(draft),
          createdAt: timestamp,
        });
      }
      abandonRunQuestionOwnership(draft);
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
      if (
        chatDecision.status === "paused" ||
        chatDecision.status === "blocked" ||
        chatDecision.status === "cancelled" ||
        chatDecision.status === "complete"
      ) {
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
      // A user-driven resume is a fresh engagement: reset the verification
      // budget so the run doesn't re-trip a saturated round ceiling on its
      // first corrective verdict (mirrors the user-turn reset in addRunMessage).
      draft.verificationRounds = 0;
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
  // Guarantee a manager driver after resume. The original gate only fired when
  // a spark QUESTION was pending, so resuming a run paused for any other reason
  // — e.g. the stalled-review failsafe in runAutopilotManagerReview, or a plain
  // force-pause between cycles — left it in "running" with nothing driving it
  // (stuck on the Stop button forever). Broaden it so any resumed autopilot run
  // with no workers in flight gets re-driven. Skip execute-mode CLI managers:
  // they re-drive via the resume signals sent above, not the autopilot
  // scheduler (scheduleAutopilotReview is never used for them — see the worker
  // cycle path). The scheduler itself dedupes, so this can't double-drive.
  const isExecuteModeCliManager =
    (resumed.chatBackend === "claude" || resumed.chatBackend === "codex" || resumed.chatBackend === "pi") &&
    (resumed.chatMode === "execute" || resumed.chatMode === "auto");
  const shouldScheduleDriver =
    !isExecuteModeCliManager && activeWorkersForRun(resumed.id).length === 0;
  if (shouldScheduleManagerAfterResume || shouldScheduleDriver) {
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
      abandonRunQuestionOwnership(draft);
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

function classifyRunMessageIntent(
  run: RunState,
  input: AddRunMessageInput,
): RunConversationMessageIntent {
  if (input.intent) return input.intent;
  if (input.author !== "user" || input.kind === "answer") return "answer";
  if (
    run.status === "planning" ||
    run.status === "running" ||
    run.status === "reviewing" ||
    Boolean(activeManagerCall(run))
  ) {
    return "steer";
  }
  return "turn";
}

function targetTurnForMessage(
  run: RunState,
  intent: RunConversationMessageIntent,
  explicit?: string,
): string | undefined {
  if (explicit) return explicit;
  if (intent !== "steer") return undefined;
  const active = activeManagerCall(run);
  return active ? `after:${active.id}` : `epoch:${conversationEpoch(run)}:next`;
}

function sameMessageDeliverySignature(
  message: HumanRunMessage,
  input: {
    author: HumanRunMessage["author"];
    kind: HumanRunMessage["kind"];
    text: string;
    intent: RunConversationMessageIntent;
    targetTurnId?: string;
    conversationEpoch: number;
    answersMessageId?: string;
  },
): boolean {
  return (
    message.author === input.author &&
    message.kind === input.kind &&
    message.message === input.text &&
    message.intent === input.intent &&
    message.targetTurnId === input.targetTurnId &&
    (message.conversationEpoch ?? 0) === input.conversationEpoch &&
    message.answersMessageId === input.answersMessageId
  );
}

export async function addRunMessage(input: AddRunMessageInput): Promise<RunState> {
  const run = await requireRun(input.runId);
  if (input.author === "user" && activeConversationRewinds.has(run.id)) {
    throw new Error("Conversation rewind is still in progress. Try sending again when it finishes.");
  }
  if (input.kind === "answer") {
    if (input.author !== "user") throw new Error("Run answers must be authored by the user.");
    const question = input.answersMessageId
      ? run.humanMessages.find(
          (entry) =>
            entry.id === input.answersMessageId &&
            entry.author === "spark" &&
            entry.kind === "question",
        )
      : resolveSingleUnresolvedRunQuestion(run);
    if (!question) {
      throw new Error(
        input.answersMessageId
          ? `Run question not found: ${input.answersMessageId}`
          : "An answer must identify the one unresolved run question.",
      );
    }
    return answerRunQuestion({
      runId: input.runId,
      questionMessageId: question.id,
      clientMessageId: input.clientMessageId,
      message: input.message,
      attachments: input.attachments,
    });
  }
  const attachmentInputs = input.attachments ?? [];
  const message = input.message.trim() || fallbackMessageForAttachments(attachmentInputs);
  if (!message) throw new Error("Message is required.");
  const clientMessageId = input.clientMessageId?.trim();
  const messageEpoch = input.conversationEpoch ?? conversationEpoch(run);
  if (messageEpoch !== conversationEpoch(run)) return run;
  const intent = classifyRunMessageIntent(run, input);
  const targetTurnId = targetTurnForMessage(run, intent, input.targetTurnId);
  const deliveryState = input.deliveryState ?? (input.author === "user" ? "queued" : "acknowledged");

  if (
    clientMessageId &&
    run.humanMessages.some((entry) => entry.clientMessageId === clientMessageId)
  ) {
    return run;
  }

  // Swallow a repeated message: the same author re-sending identical text
  // shortly after their last one is a double-click, an Enter-key repeat, or a
  // frustrated re-send while waiting — never intent. Look back past any Codara
  // replies in between, since the immediately-previous message is often
  // Codara's own confirmation, which would otherwise mask the repeat.
  //
  // Two identical-text cases ARE intent and must not be swallowed:
  //   * an answer to a DIFFERENT question ("Allow" for edit #1, then "Allow"
  //     for edit #2 seconds later) — distinguished by answersMessageId;
  //   * a question re-posted under a distinct clientMessageId (a consent gate
  //     re-asking after a denied/timed-out attempt with the same diff text).
  // Same-question answer repeats (double-click) still dedupe.
  const priorSameAuthor = [...run.humanMessages]
    .reverse()
    .find((entry) => entry.author === input.author);
  const answersDifferentQuestion =
    Boolean(input.answersMessageId) &&
    priorSameAuthor?.answersMessageId !== input.answersMessageId;
  const distinctQuestionRepost =
    input.kind === "question" &&
    Boolean(clientMessageId) &&
    priorSameAuthor?.clientMessageId !== clientMessageId;
  if (
    attachmentInputs.length === 0 &&
    priorSameAuthor &&
    sameMessageDeliverySignature(priorSameAuthor, {
      author: input.author,
      kind: input.kind,
      text: message,
      intent,
      targetTurnId,
      conversationEpoch: messageEpoch,
      answersMessageId: input.answersMessageId,
    }) &&
    !answersDifferentQuestion &&
    !distinctQuestionRepost &&
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
  const humanMessage: HumanRunMessage = {
    id: messageId,
    clientMessageId,
    runId: run.id,
    author: input.author,
    kind: input.kind,
    message,
    questionOptions,
    questionContext:
      input.author === "spark" && input.kind === "question"
        ? input.questionContext
        : undefined,
    attachments,
    answersMessageId: input.answersMessageId,
    intent,
    deliveryState,
    targetTurnId,
    backendTurnId: input.backendTurnId,
    conversationEpoch: messageEpoch,
    createdAt: new Date().toISOString(),
  };

  let messageRecorded = false;
  let revivedTerminal = false;
  let recordedIntent = intent;
  const updated = await commitRunChange(run, {
    type: `human.${input.kind}`,
    message: `${input.author}: ${message.slice(0, 160)}`,
    payload: { message: humanMessage },
    mutate: (draft, timestamp) => {
      if (conversationEpoch(draft) !== messageEpoch) return false;
      if (
        clientMessageId &&
        draft.humanMessages.some((entry) => entry.clientMessageId === clientMessageId)
      ) {
        return false;
      }
      const authoritativeIntent = classifyRunMessageIntent(draft, input);
      const authoritativeTargetTurnId = targetTurnForMessage(
        draft,
        authoritativeIntent,
        input.targetTurnId,
      );
      const latestSameAuthor = [...draft.humanMessages]
        .reverse()
        .find((entry) => entry.author === input.author);
      const answersDifferentQuestionInDraft =
        Boolean(input.answersMessageId) &&
        latestSameAuthor?.answersMessageId !== input.answersMessageId;
      const distinctQuestionRepostInDraft =
        input.kind === "question" &&
        Boolean(clientMessageId) &&
        latestSameAuthor?.clientMessageId !== clientMessageId;
      if (
        attachmentInputs.length === 0 &&
        latestSameAuthor &&
        sameMessageDeliverySignature(latestSameAuthor, {
          author: input.author,
          kind: input.kind,
          text: message,
          intent: authoritativeIntent,
          targetTurnId: authoritativeTargetTurnId,
          conversationEpoch: messageEpoch,
          answersMessageId: input.answersMessageId,
        }) &&
        !answersDifferentQuestionInDraft &&
        !distinctQuestionRepostInDraft &&
        Date.now() - new Date(latestSameAuthor.createdAt).getTime() < 20000
      ) {
        return false;
      }
      messageRecorded = true;
      recordedIntent = authoritativeIntent;
      draft.humanMessages.push({
        ...humanMessage,
        intent: authoritativeIntent,
        targetTurnId: authoritativeTargetTurnId,
        createdAt: timestamp,
      });
      // A user turn opens a fresh verification budget. The round ceiling
      // guards a single runaway corrective loop, not the whole conversation —
      // without this reset a follow-up inherits a saturated counter and the
      // first corrective verdict of the new turn instantly force-lands the run.
      if (input.author === "user") draft.verificationRounds = 0;
      const draftWasTerminal =
        draft.status === "complete" || draft.status === "failed" || draft.status === "cancelled";
      // When the user chats into a finished run, transition it back into a
      // planning state so the autopilot loop wakes up and the run badge shifts
      // off "complete" while the manager replans. Keep the prior terminal as
      // last_status if downstream code wants to know.
      // Direct (loom) runs are exempt: addDirectIteration owns their status
      // transitions, and a stray user note must never wake a manager.
      if (input.author === "user" && draftWasTerminal && draft.executionMode !== "direct") {
        revivedTerminal = true;
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

  // Land the message checkpoint before any new manager turn is allowed to edit
  // the workspace. This makes Chat+Code undo restore the send-time tree rather
  // than a later tree captured after the requested work had already begun.
  if (input.author === "user") {
    const cwd = workspaceCwdFromRun(updated);
    if (cwd) {
      const labelText = message.length > 60 ? `${message.slice(0, 60).trimEnd()}…` : message;
      await recordCheckpointInBackground({
        runId: updated.id,
        cwd,
        kind: "user-message",
        messageId,
        messagePointer: Math.max(0, updated.humanMessages.length - 1),
        label: labelText,
        conversationEpoch: messageEpoch,
      });
    }
  }

  // Re-engage the manager only after the undo baseline is durable. Never for
  // direct (loom) runs — the loop driver decides what runs next.
  if (input.author === "user" && revivedTerminal && updated.executionMode !== "direct") {
    const autopilotInput = autopilotInputFromRun(updated);
    scheduleInitialChatDecision(updated.id, autopilotInput, { afterCurrent: true });
  }
  if (
    input.author === "user" &&
    recordedIntent === "steer" &&
    (Boolean(activeManagerCall(updated)) ||
      activeAutopilotPlans.has(updated.id) ||
      activeAutopilotReviews.has(updated.id))
  ) {
    scheduleQueuedSteeringFollowup(updated);
  }

  return updated;
}

// Per-run task chain. Checkpoint creation parents each new git commit to the
// previous shadow-ref tip, so concurrent tasks would interleave parents and
// invert the chronology (a "later" baseline ending up as the child of a
// "newer" user-message commit). Serializing here keeps the git graph in the
// same order the chat events fired.
const withCheckpointLock = createKeyedTaskQueue();

// Per-baseRepo merge-back chain (Looms v4 parallel fan-out). Two SAME-WAVE
// sibling workers each ran in their OWN sandbox worktree forked off the run
// checkpoint, and on success each `git apply`s its diff back into the SAME base
// repo working tree. Two such applies interleaving can corrupt the tree (a
// partially-applied patch, a racing `git add -A`). Serialize them with a
// promise chain keyed by the RESOLVED base-repo path, exactly mirroring
// checkpointTaskQueue. The mutex wraps ONLY the merge git ops (mergeBack…
// + the success bookkeeping), never the whole worker attempt, so independent
// base repos run in parallel and a managed parallel batch (no shared base repo
// to contend on) is never serialized. A failing merge still releases the lock
// (finally) and keeps its fail-and-strand behavior — conflicts are never auto-
// resolved here.
const mergeBackQueue = new Map<string, Promise<unknown>>();

// Run `fn` under the merge-back mutex for `baseRepo`: it chains after any
// in-flight merge into the SAME repo and releases as soon as the body settles —
// the chain tail swallows the body's error (a failed merge must not poison the
// next sibling), while the caller still receives the body's real result/throw.
// The body MUST be only the merge git ops (never the whole attempt) so distinct
// base repos run fully in parallel — a managed parallel batch sharing no base
// repo never contends, so this can't deadlock it. Self-pruning: when this body
// is still the chain tail after it settles, the entry is dropped so the map
// doesn't grow across many one-off base repos.
async function withMergeBackLock<T>(baseRepo: string, fn: () => Promise<T>): Promise<T> {
  const prior = mergeBackQueue.get(baseRepo) ?? Promise.resolve();
  // `body` runs after any prior merge into this repo (its own errors swallowed
  // so they never poison the chain) and is what the CALLER awaits — it carries
  // the real result/throw. The error-swallowing `tail` is what later siblings
  // wait on, and it self-prunes the map entry once it is the chain's end.
  const body = prior.catch(() => undefined).then(() => fn());
  const tail = body.catch(() => undefined).then(() => {
    if (mergeBackQueue.get(baseRepo) === tail) mergeBackQueue.delete(baseRepo);
  });
  mergeBackQueue.set(baseRepo, tail);
  return body;
}

function recordCheckpointInBackground(input: {
  runId: string;
  cwd: string;
  kind: Checkpoint["kind"];
  messageId?: string;
  messagePointer: number;
  label: string;
  conversationEpoch?: number;
}): Promise<void> {
  return withCheckpointLock(input.runId, () => doRecordCheckpoint(input)).catch(() => undefined);
}

function scheduleShadowRefRewind(input: {
  runId: string;
  cwd: string;
  sha: string | null;
}): Promise<void> {
  return withCheckpointLock(input.runId, () => rewindShadowRef(input));
}

async function doRecordCheckpoint(input: {
  runId: string;
  cwd: string;
  kind: Checkpoint["kind"];
  messageId?: string;
  messagePointer: number;
  label: string;
  conversationEpoch?: number;
}): Promise<void> {
  const messageId = input.kind === "user-message" ? input.messageId : undefined;
  const before = await getRun(input.runId);
  if (
    !before ||
    !isCheckpointJobCurrent(before, input.conversationEpoch, messageId)
  ) return;
  const checkpoint = await createCheckpoint(input);
  const fresh = await getRun(input.runId);
  if (!fresh || !isCheckpointJobCurrent(fresh, input.conversationEpoch, messageId)) return;
  await commitRunChange(fresh, {
    type: "run.checkpoint_created",
    message: `Checkpoint ${checkpoint.kind} ${checkpoint.id}`,
    payload: { checkpointId: checkpoint.id, sha: checkpoint.sha, kind: checkpoint.kind },
    mutate: (draft, timestamp) => {
      if (!isCheckpointJobCurrent(draft, input.conversationEpoch, messageId)) return false;
      draft.checkpoints = [...(draft.checkpoints ?? []), checkpoint];
      draft.updatedAt = timestamp;
    },
  });
}

function workspaceCwdFromRun(run: RunState): string | undefined {
  return typeof run.settingsSnapshot?.workspaceCwd === "string"
    ? (run.settingsSnapshot.workspaceCwd as string)
    : undefined;
}

// True when `cwd` lives inside a git work tree. Gates sandbox-worktree
// provisioning in prepareWorkerTask: `git worktree add` only works from a
// repo, and a non-repo workspace must fall back to running in place.
async function isGitWorktreeRepo(cwd: string): Promise<boolean> {
  if (!cwd) return false;
  return (await readGitText(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
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
      abandonRunQuestionOwnership(draft);
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
    type: "run.status_change_requested",
    message: `Run status changed to ${input.status}`,
    payload: {
      requestedStatus: input.status,
      currentStepId: input.currentStepId ?? run.currentStepId,
    },
    mutate: (draft, timestamp) => {
      if (input.status !== "blocked") delete draft.blockedOn;
      if (
        input.status === "paused" ||
        input.status === "complete" ||
        input.status === "failed" ||
        input.status === "cancelled"
      ) {
        abandonRunQuestionOwnership(draft);
      }
      draft.status = input.status;
      if (input.currentStepId !== undefined) draft.currentStepId = input.currentStepId;
      draft.updatedAt = timestamp;
    },
  });
}

const WHITEBOARD_MAX_NODES = 500;
const WHITEBOARD_MAX_EDGES = 1_000;
const WHITEBOARD_COORDINATE_LIMIT = 100_000;

/** Persist the visual model Cora and the renderer share for one chat. */
export async function updateCoraWhiteboard(
  input: UpdateCoraWhiteboardInput,
): Promise<RunState> {
  const run = await requireRun(input.runId);
  const action = input.action ?? "replace";
  if (action !== "replace" && action !== "merge" && action !== "clear") {
    throw new Error(`Unsupported whiteboard action: ${String(action)}`);
  }

  return commitRunChange(run, {
    type: "run.whiteboard_updated",
    message: action === "clear" ? "Cleared Cora whiteboard" : "Updated Cora whiteboard",
    payload: {
      action,
      editor: input.editor ?? "cora",
      baseRevision: input.baseRevision,
      nodeCount: input.nodes?.length ?? 0,
      edgeCount: input.edges?.length ?? 0,
    },
    mutate: (draft, timestamp) => {
      const currentRevision = draft.whiteboard?.revision ?? 0;
      if (
        input.baseRevision !== undefined &&
        Math.max(0, Math.floor(input.baseRevision)) !== currentRevision
      ) {
        throw new Error(
          `Whiteboard changed since revision ${input.baseRevision}. Read it again and apply the update to revision ${currentRevision}.`,
        );
      }
      if (action === "clear") {
        if (!draft.whiteboard) return false;
        delete draft.whiteboard;
        draft.updatedAt = timestamp;
        return;
      }

      const prior = action === "merge" ? draft.whiteboard : undefined;
      const removedNodes = new Set((input.removeNodeIds ?? []).map(sanitizeWhiteboardId).filter(Boolean));
      const removedEdges = new Set((input.removeEdgeIds ?? []).map(sanitizeWhiteboardId).filter(Boolean));
      const nodesById = new Map<string, CoraWhiteboardNode>();
      const edgesById = new Map<string, CoraWhiteboardEdge>();
      // Sanitization maps distinct raw ids like "step 1"/"step-1" to the same
      // id; silently upserting one over the other would lose a card, so two
      // different raw ids colliding is an input error.
      const rawIdBySanitized = new Map<string, string>();
      const guardIdCollision = (sanitized: string, raw: unknown, what: "node" | "edge") => {
        const rawId = typeof raw === "string" ? raw.trim() : "";
        const existing = rawIdBySanitized.get(`${what}:${sanitized}`);
        if (existing !== undefined && existing !== rawId) {
          throw new Error(
            `Whiteboard ${what} ids "${existing}" and "${rawId}" both normalize to "${sanitized}". Use ids made of letters, digits, and . _ : - so they stay distinct.`,
          );
        }
        rawIdBySanitized.set(`${what}:${sanitized}`, rawId);
      };

      for (const node of prior?.nodes ?? []) {
        if (!removedNodes.has(node.id)) nodesById.set(node.id, node);
      }
      for (const node of input.nodes ?? []) {
        // Merge upserts by id: fields omitted from the payload keep the prior
        // node's values instead of silently resetting to defaults.
        const priorNode = prior ? nodesById.get(sanitizeWhiteboardId(node?.id)) : undefined;
        const normalized = normalizeWhiteboardNode(node, priorNode);
        guardIdCollision(normalized.id, node?.id, "node");
        if (removedNodes.has(normalized.id)) continue;
        nodesById.set(normalized.id, normalized);
      }
      if (nodesById.size > WHITEBOARD_MAX_NODES) {
        throw new Error(
          `The whiteboard would hold ${nodesById.size} nodes; the limit is ${WHITEBOARD_MAX_NODES}. Remove nodes or rebuild a smaller board.`,
        );
      }
      const nodes = Array.from(nodesById.values());
      const validNodeIds = new Set(nodes.map((node) => node.id));

      for (const edge of prior?.edges ?? []) {
        if (!removedEdges.has(edge.id) && validNodeIds.has(edge.from) && validNodeIds.has(edge.to)) {
          edgesById.set(edge.id, edge);
        }
      }
      for (const edge of input.edges ?? []) {
        const priorEdge = prior ? edgesById.get(sanitizeWhiteboardId(edge?.id)) : undefined;
        const normalized = normalizeWhiteboardEdge(edge, priorEdge);
        guardIdCollision(normalized.id, edge?.id, "edge");
        if (removedEdges.has(normalized.id)) continue;
        if (!validNodeIds.has(normalized.from) || !validNodeIds.has(normalized.to)) {
          throw new Error(`Whiteboard edge ${normalized.id} references a missing node.`);
        }
        edgesById.set(normalized.id, normalized);
      }
      if (edgesById.size > WHITEBOARD_MAX_EDGES) {
        throw new Error(
          `The whiteboard would hold ${edgesById.size} edges; the limit is ${WHITEBOARD_MAX_EDGES}. Remove edges or rebuild a smaller board.`,
        );
      }

      const title = sanitizeWhiteboardText(input.title ?? prior?.title ?? "Cora whiteboard", 100);
      const summary = sanitizeWhiteboardText(input.summary ?? prior?.summary ?? "", 700) || undefined;
      draft.whiteboard = {
        version: 1,
        revision: currentRevision + 1,
        lastEditedBy: input.editor ?? "cora",
        title: title || "Cora whiteboard",
        summary,
        nodes,
        edges: Array.from(edgesById.values()),
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
  });
}

function sanitizeWhiteboardId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 80);
}

function sanitizeWhiteboardText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n/g, "\n").trim().slice(0, maxLength);
}

function finiteWhiteboardNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  // The fallback is clamped too: a merge that changes a node's kind inherits
  // the prior size, which may sit outside the new kind's limits.
  const chosen = Number.isFinite(number) ? number : fallback;
  return Math.max(min, Math.min(max, Math.round(chosen)));
}

const WHITEBOARD_TONES: readonly NonNullable<CoraWhiteboardEdge["tone"]>[] = [
  "default", "accent", "success", "warning", "danger",
];

/**
 * Sanitize one node. When `prior` is present (a merge upsert over an existing
 * node), omitted fields inherit the prior value; explicitly provided empty
 * strings still clear a field.
 */
function normalizeWhiteboardNode(
  node: CoraWhiteboardNode,
  prior?: CoraWhiteboardNode,
): CoraWhiteboardNode {
  const id = sanitizeWhiteboardId(node?.id);
  const title = sanitizeWhiteboardText(node?.title, 120) || prior?.title || "";
  if (!id || !title) throw new Error("Every whiteboard node needs a non-empty id and title.");
  const allowedKinds: CoraWhiteboardNode["kind"][] = [
    "topic", "group", "file", "symbol", "flow", "condition", "decision", "risk", "note",
  ];
  const kind = allowedKinds.includes(node.kind) ? node.kind : prior?.kind ?? "note";
  const defaultSize = CORA_WHITEBOARD_NODE_DEFAULT_SIZES[kind];
  const limits = whiteboardNodeSizeLimits(kind);
  const body = node.body === undefined
    ? prior?.body
    : sanitizeWhiteboardText(node.body, 900) || undefined;
  const tone = node.tone === undefined
    ? prior?.tone
    : WHITEBOARD_TONES.includes(node.tone) ? node.tone : undefined;
  return {
    id,
    kind,
    title,
    body,
    x: finiteWhiteboardNumber(
      node.x,
      prior?.x ?? 80,
      -WHITEBOARD_COORDINATE_LIMIT,
      WHITEBOARD_COORDINATE_LIMIT,
    ),
    y: finiteWhiteboardNumber(
      node.y,
      prior?.y ?? 80,
      -WHITEBOARD_COORDINATE_LIMIT,
      WHITEBOARD_COORDINATE_LIMIT,
    ),
    width: finiteWhiteboardNumber(
      node.width,
      prior?.width ?? defaultSize.width,
      limits.minWidth,
      limits.maxWidth,
    ),
    height: finiteWhiteboardNumber(
      node.height,
      prior?.height ?? defaultSize.height,
      limits.minHeight,
      limits.maxHeight,
    ),
    tone,
  };
}

function normalizeWhiteboardEdge(
  edge: CoraWhiteboardEdge,
  prior?: CoraWhiteboardEdge,
): CoraWhiteboardEdge {
  const id = sanitizeWhiteboardId(edge?.id);
  const from = sanitizeWhiteboardId(edge?.from);
  const to = sanitizeWhiteboardId(edge?.to);
  if (!id || !from || !to) throw new Error("Every whiteboard edge needs id, from, and to fields.");
  const label = edge.label === undefined
    ? prior?.label
    : sanitizeWhiteboardText(edge.label, 100) || undefined;
  const tone = edge.tone === undefined
    ? prior?.tone
    : WHITEBOARD_TONES.includes(edge.tone) ? edge.tone : undefined;
  const style = edge.style === undefined
    ? prior?.style
    : edge.style === "dashed" ? "dashed" : undefined;
  return { id, from, to, label, tone, style };
}

/**
 * Terminalize a run after codara_complete has passed the socket's worker and
 * verification invariants. Unlike the generic status editor, this keeps the
 * autopilot projection and completed timestamp consistent with run.status.
 */
export async function completeRunFromOrchestrator(runId: string): Promise<RunState> {
  const run = await requireRun(runId);
  return commitRunChange(run, {
    type: "run.status_change_requested",
    message: "Cora marked the run complete",
    payload: {
      requestedStatus: "complete",
      source: "codara_complete",
      currentStepId: run.currentStepId,
    },
    mutate: (draft, timestamp) => {
      delete draft.blockedOn;
      abandonRunQuestionOwnership(draft);
      draft.status = "complete";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
        status: "complete",
        lastAction: "manager_marked_complete",
        updatedAt: timestamp,
      };
      draft.completedAt = timestamp;
      draft.updatedAt = timestamp;
    },
  });
}

// Persist the composer chip's backend/model/mode/effort selection onto the
// run. The fields are all optional on the input — passing only `chatMode`
// toggles Execute<->Talk without touching the others. The mutator does
// nothing when every field on the input is undefined (UI sanity), and emits
// a single `run.chat_backend_updated` event so the renderer and any audit
// listener see the change.
export async function updateChatBackend(input: UpdateChatBackendInput): Promise<RunState> {
  const run = await requireRun(input.runId);
  const noChange =
    input.chatBackend === undefined &&
    input.chatModel === undefined &&
    input.chatMode === undefined &&
    input.chatEffort === undefined &&
    input.coraExecutionPolicy === undefined &&
    input.chatFastMode === undefined &&
    input.chat1mContext === undefined;
  if (noChange) return run;
  const nextBackend = input.chatBackend ?? run.chatBackend ?? "pi";
  const nextFeatureFlags = normalizeChatFeatureFlags(nextBackend, {
    chatFastMode: input.chatFastMode ?? run.chatFastMode,
    chat1mContext: input.chat1mContext ?? run.chat1mContext,
  });
  const nextExecutionPolicy = normalizeCoraExecutionPolicy(
    input.coraExecutionPolicy ?? run.coraExecutionPolicy,
  );
  return commitRunChange(run, {
    type: "run.chat_backend_updated",
    message: "Chat backend / model / mode / effort updated",
    payload: {
      previous: {
        chatBackend: run.chatBackend,
        chatModel: run.chatModel,
        chatMode: run.chatMode,
        chatEffort: run.chatEffort,
        coraExecutionPolicy: run.coraExecutionPolicy,
        chatFastMode: run.chatFastMode,
        chat1mContext: run.chat1mContext,
      },
      next: {
        chatBackend: input.chatBackend ?? run.chatBackend,
        chatModel: input.chatModel ?? run.chatModel,
        chatMode: input.chatMode ?? run.chatMode,
        chatEffort: input.chatEffort ?? run.chatEffort,
        coraExecutionPolicy: nextExecutionPolicy,
        chatFastMode: nextFeatureFlags.chatFastMode,
        chat1mContext: nextFeatureFlags.chat1mContext,
      },
    },
    mutate: (draft, timestamp) => {
      if (input.chatBackend !== undefined) draft.chatBackend = input.chatBackend;
      if (input.chatModel !== undefined) draft.chatModel = input.chatModel.trim() || undefined;
      if (input.chatMode !== undefined) draft.chatMode = input.chatMode;
      if (input.chatEffort !== undefined) draft.chatEffort = input.chatEffort;
      if (input.coraExecutionPolicy !== undefined) {
        draft.coraExecutionPolicy = nextExecutionPolicy;
      }
      draft.chatFastMode = nextFeatureFlags.chatFastMode;
      draft.chat1mContext = nextFeatureFlags.chat1mContext;
      // Switching backend invalidates the prior session UUID — the new
      // backend would mis-resume otherwise. Selected per the answers: no
      // cross-backend handoff; each backend gets its own fresh thread.
      if (input.chatBackend !== undefined && input.chatBackend !== run.chatBackend) {
        draft.chatSessionUuid = undefined;
        draft.chatSessionMode = undefined;
      }
      // A Pi policy change alters the active system contract and extension
      // set. Rotate the provider session instead of letting Deep/Frontier
      // inherit a transcript created under Fast (or vice versa).
      if (
        nextBackend === "pi" &&
        input.coraExecutionPolicy !== undefined &&
        nextExecutionPolicy !== normalizeCoraExecutionPolicy(run.coraExecutionPolicy)
      ) {
        draft.chatSessionUuid = undefined;
        draft.chatSessionMode = undefined;
      }
      // Mode flips (talk↔execute) DO NOT invalidate the session — the
      // backend's mid-turn handler respawns CC/Codex with the new
      // --append-system-prompt + MCP-isolation args but still passes
      // -r <uuid> so the conversation history is preserved. To stop the
      // model anchoring on its prior-mode persona, the backend ALSO
      // prepends a "ROLE UPDATE" prelude to the next user prompt. That
      // combination — new system prompt + resumed transcript + inline
      // role-shift announcement — lets the user toggle mid-chat without
      // losing the chat thread. See spark-chat-mode-anchor memory.
      draft.updatedAt = timestamp;
    },
  });
}

// Rename a chat. The renderer drives this from the top tab strip's hover-
// revealed pencil affordance; the title is shown on the tab and in any
// stored manifest that derives from `run.title`. Empty / whitespace-only
// titles are rejected so a chat never ends up with a blank tab label.
export async function renameRun(input: RenameRunInput): Promise<RunState> {
  const run = await requireRun(input.runId);
  const title = input.title.trim();
  if (!title) throw new Error("Chat title cannot be empty.");
  if (title === run.title) return run;
  return commitRunChange(run, {
    type: "run.renamed",
    message: `Run renamed to ${title}`,
    payload: { previousTitle: run.title, title },
    mutate: (draft, timestamp) => {
      draft.title = title;
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
      if (draft.currentStepId === target.id && ["complete", "completed_unverified", "failed", "skipped"].includes(target.status)) {
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
    writeScopeSource: input.writeScopeSource,
    councilGroupId: input.councilGroupId,
    candidateIndex: input.candidateIndex,
    councilRole: input.councilRole,
    createdBy: input.createdBy ?? "user",
    loomNodeId: input.loomNodeId,
    accessHint: input.accessHint,
    blockedToolsHint: input.blockedToolsHint,
    collabMailDirHint: input.collabMailDirHint,
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
  const settings = await loadSettings();
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
  // Filesystem-isolate unattended (autopilot) workers in a throwaway git
  // worktree forked off the run's checkpoint, so a misbehaving agent can't
  // touch the user's working tree. Best-effort: any failure (non-repo, no
  // checkpoint yet, git error) falls back to input.cwd byte-identically. The
  // worktree cwd then flows through the attempt, the rendered prompt, the
  // envelope, codex trust, and the launch command via `effectiveCwd`.
  let effectiveCwd = input.cwd;
  // Plan-mode council candidates are deliberately NOT sandboxed: each writes to
  // its own disjoint .spark/<runId>/candidates/<i>/ dir in the real workspace so the
  // synthesis judge can read every candidate's PLAN.md / PRD.md afterward.
  if (
    input.unattended &&
    settings.autopilotSandbox &&
    !task.councilGroupId &&
    (await isGitWorktreeRepo(input.cwd))
  ) {
    try {
      const worktreesRoot = join(sparkHome(), "worktrees", basename(input.cwd), "sandbox");
      const startPoint = (await runCheckpointStartPoint(input.cwd, run.id)) ?? undefined;
      const created = await createSandboxWorktree({
        repoCwd: input.cwd,
        worktreesRoot,
        startPoint,
      });
      if (created.ok) {
        effectiveCwd = created.path;
        attempt.cwd = created.path;
        attempt.sandboxWorktreePath = created.path;
        attempt.sandboxBranch = created.branch;
        attempt.sandboxBaseRepo = input.cwd;
        await appendEvent({
          timestamp,
          workspaceId: run.workspaceId,
          runId: run.id,
          stepId: task.stepId,
          workerTaskId: task.id,
          attemptId: attempt.id,
          type: "worker_attempt.sandbox_provisioned",
          message: `Sandboxed worker in worktree: ${created.branch}`,
          payload: {
            sandboxWorktreePath: created.path,
            sandboxBranch: created.branch,
            sandboxBaseRepo: input.cwd,
            startPoint: startPoint ?? null,
          },
        });
      } else {
        await appendEvent({
          timestamp,
          workspaceId: run.workspaceId,
          runId: run.id,
          stepId: task.stepId,
          workerTaskId: task.id,
          attemptId: attempt.id,
          type: "worker_attempt.sandbox_failed",
          message: `Sandbox worktree provisioning failed; falling back to workspace cwd`,
          payload: { error: created.error, cwd: input.cwd },
        });
      }
    } catch (err) {
      await appendEvent({
        timestamp,
        workspaceId: run.workspaceId,
        runId: run.id,
        stepId: task.stepId,
        workerTaskId: task.id,
        attemptId: attempt.id,
        type: "worker_attempt.sandbox_failed",
        message: `Sandbox worktree provisioning threw; falling back to workspace cwd`,
        payload: { error: err instanceof Error ? err.message : String(err), cwd: input.cwd },
      });
    }
  }
  const paths = workerArtifactPaths(run.id, task.stepId, task.id, attempt.id);
  task.status = "queued";
  task.updatedAt = timestamp;
  if (step && !["running", "reviewing", "complete", "completed_unverified", "failed", "skipped"].includes(step.status)) {
    step.status = "ready";
    step.updatedAt = timestamp;
  }
  const envelope: WorkerTaskEnvelope = {
    runId: run.id,
    workerTaskId: task.id,
    attemptId: attempt.id,
    runtime: task.runtimePreference,
    cwd: effectiveCwd,
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
  const prompt = renderWorkerPrompt({ cwd: effectiveCwd, run, step, task, paths, settings });

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
      // Looms v2: lets the renderer suppress the workers tab (and the
      // direct-worker spawn handler claim the pty) synchronously from the
      // event payload, with no getRun round-trip race.
      automationId: run.automationId,
      executionMode: run.executionMode,
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
      "Cora-created shell workers are not autonomous yet; route command-heavy work through an installed agent so it can inspect output and write the final report.",
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
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
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
    fs.rm(paths.finalReportJson, { force: true }),
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
  // A direct run bound to an automationId is the automation (loom) worker
  // path: it launches on a pinned/handoff model the automation engine already
  // validated, so buildLaunchCommandLine passes its hint verbatim instead of
  // running the Cora-worker sanitize backstop.
  const isAutomationRun = run.executionMode === "direct" && Boolean(run.automationId);
  const usePiWorkerHarness =
    process.env.SPARK_E2E_LEGACY_WORKER_HARNESS !== "1" &&
    !isAutomationRun &&
    (task.runtimePreference === "claude" || task.runtimePreference === "codex");
  const piWorkerModel = usePiWorkerHarness
    ? piModelForWorker(task)
    : undefined;
  // Dirs a sandboxed codex worker must be able to WRITE despite them living
  // outside the workspace: the attempt dir (holds final-report.json + logs) and,
  // for a chat participant, the shared board. buildLaunchCommandLine --add-dir's
  // them only on codex sandbox launches (claude + --yolo already reach them).
  const extraWritableDirs = [
    paths.attemptDir,
    ...(task.collabMailDirHint ? [task.collabMailDirHint] : []),
  ];
  const launchCommand = buildLaunchCommandLine(task, attempt.cwd, {
    sandboxDir: attempt.sandboxWorktreePath,
    isAutomation: isAutomationRun,
    extraWritableDirs,
  });
  const command = usePiWorkerHarness
    ? `Pi harness (${task.runtimePreference}/${piWorkerModel || "subscription default"}, ${task.effortHint ?? "high"})`
    : isAutomationRun && task.runtimePreference === "claude"
    ? "Claude Agent SDK (headless automation worker)"
    : isAutomationRun && task.runtimePreference === "codex"
      ? "Codex App Server (headless automation worker)"
      : launchCommand
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
  if (launchStep && !["complete", "completed_unverified", "failed", "skipped"].includes(launchStep.status)) {
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

  // Pre-worker snapshot: for impl/corrective workers (anything that mutates the
  // workspace — skip verifier/manual), capture a checkpoint of the tree BEFORE
  // the worker runs. A later verifier verdict that regresses a previously-green
  // claim can then auto-restore the workspace to this exact pre-mutation state.
  // Best-effort: a failed snapshot or non-git workspace yields sha=null and just
  // disables restore for this attempt; it must never block the launch.
  if (taskWritesWorkspace(task)) {
    try {
      const cwd = workspaceCwdFromRun(run) ?? attempt.cwd;
      const checkpoint = await withCheckpointLock(run.id, () =>
        createCheckpoint({
          runId: run.id,
          cwd,
          kind: "pre-worker",
          messagePointer: run.humanMessages.length,
          label: `pre-worker ${task.title}`,
        }),
      );
      attempt.preWorkerCheckpointSha = checkpoint.sha;
      run.checkpoints = [...(run.checkpoints ?? []), checkpoint];
      run.updatedAt = new Date().toISOString();
      await saveRun(run);
      await appendEvent({
        timestamp: run.updatedAt,
        workspaceId: run.workspaceId,
        runId: run.id,
        stepId: task.stepId,
        workerTaskId: task.id,
        attemptId: attempt.id,
        type: "run.checkpoint_created",
        message: `Checkpoint ${checkpoint.kind} ${checkpoint.id}`,
        payload: { checkpointId: checkpoint.id, sha: checkpoint.sha, kind: checkpoint.kind },
      });
    } catch {
      // Checkpoint capture is best-effort; never let it abort the launch.
    }
  }

  // Peer-traffic observability rides the batch lifecycle: the first
  // peer-comms worker to launch opens the run's mailbox watcher, the last one
  // to finish closes it. Best-effort — traffic events must never block a run.
  // Release is paired strictly with a successful acquire so a failed acquire
  // can never decrement a sibling worker's refcount.
  const watchPeerComms = shouldUsePeerComms(run, launchStep, task);
  const peerCommsAcquired = watchPeerComms
    ? await acquirePeerCommsWatcher(run).catch(() => false)
    : false;
  let result: { exitCode: number; error?: string };
  try {
    result = usePiWorkerHarness
      ? await runPiWorkerSession({
          run,
          task,
          attemptId: attempt.id,
          paths,
          cwd: attempt.cwd,
          promptText,
          command,
        })
      : isAutomationRun && (task.runtimePreference === "claude" || task.runtimePreference === "codex")
      ? await runStructuredAutomationWorkerSession({
          run,
          task,
          attemptId: attempt.id,
          paths,
          cwd: attempt.cwd,
          promptText,
          command,
          sandboxed: Boolean(attempt.sandboxWorktreePath),
          extraWritableDirs,
        })
      : await runWorkerSession({
          run,
          task,
          attemptId: attempt.id,
          paths,
          cwd: attempt.cwd,
          launchCommand,
          promptText,
          command,
        });
  } finally {
    if (peerCommsAcquired) releasePeerCommsWatcher(run.id);
  }

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
  if (finishedStep && !["complete", "completed_unverified", "skipped"].includes(finishedStep.status)) {
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

  // Converge a successful sandboxed worker's edits back into the run workspace.
  // The worker ran in an isolated worktree forked off the run checkpoint, so its
  // changes haven't touched the workspace yet — merge them back now, before the
  // report is reviewed, so the verdict and any follow-up see the real tree.
  // Gated by the autopilotSandbox setting (the sandbox fields are only set when
  // it was on; re-check it in case it was toggled off mid-run). A failure here
  // is best-effort: it's logged/evented and never aborts the finish path, and
  // the worktree is left intact for the user to recover. The non-sandbox path
  // (no sandbox fields) skips this block entirely.
  if (
    result.exitCode === 0 &&
    finishedAttempt.sandboxWorktreePath &&
    finishedAttempt.sandboxBaseRepo
  ) {
    const settings = await loadSettings();
    if (settings.autopilotSandbox) {
      // Serialize the merge into THIS base repo: same-wave sibling workers (Looms
      // parallel fan-out) each apply their diff into the same tree, and two
      // interleaved `git add -A` + `git apply` would corrupt it. The lock wraps
      // only the merge git op (not the surrounding bookkeeping/eventing), so
      // distinct base repos still merge in parallel. A throw here still releases
      // the lock (withMergeBackLock's finally-equivalent tail).
      const baseRepo = finishedAttempt.sandboxBaseRepo;
      const worktreePath = finishedAttempt.sandboxWorktreePath;
      const mergeBack = await withMergeBackLock(baseRepo, () =>
        mergeBackSandboxWorktree({ repoCwd: baseRepo, worktreePath }),
      );
      const mergedAt = new Date().toISOString();
      if (mergeBack.ok) {
        console.log(
          `[sandbox] merge-back ${finishedAttempt.sandboxBranch ?? "(branch)"} -> ${finishedAttempt.sandboxBaseRepo}: ${mergeBack.changed ? "applied worker edits" : "no changes to apply"}`,
        );
        // Persisted so boot recovery never re-applies an already-merged patch
        // (the second all-or-nothing `git apply` would fail spuriously).
        finishedAttempt.sandboxMergedBack = true;
        run.updatedAt = mergedAt;
        await saveRun(run);
        await appendEvent({
          timestamp: mergedAt,
          workspaceId: run.workspaceId,
          runId: run.id,
          stepId: finishedTask.stepId,
          workerTaskId: finishedTask.id,
          attemptId: finishedAttempt.id,
          type: "worker_attempt.sandbox_merged",
          message: mergeBack.changed
            ? `Merged sandbox worktree back: ${finishedAttempt.sandboxBranch ?? "(branch)"}`
            : `Sandbox worktree had no changes to merge: ${finishedAttempt.sandboxBranch ?? "(branch)"}`,
          payload: {
            sandboxWorktreePath: finishedAttempt.sandboxWorktreePath,
            sandboxBranch: finishedAttempt.sandboxBranch,
            sandboxBaseRepo: finishedAttempt.sandboxBaseRepo,
            changed: mergeBack.changed,
          },
        });
      } else {
        console.warn(
          `[sandbox] merge-back failed for ${finishedAttempt.sandboxBranch ?? "(branch)"} -> ${finishedAttempt.sandboxBaseRepo}: ${mergeBack.error}`,
        );
        await appendEvent({
          timestamp: mergedAt,
          workspaceId: run.workspaceId,
          runId: run.id,
          stepId: finishedTask.stepId,
          workerTaskId: finishedTask.id,
          attemptId: finishedAttempt.id,
          type: "worker_attempt.sandbox_merge_failed",
          message: `Sandbox merge-back failed; worktree left intact: ${finishedAttempt.sandboxBranch ?? "(branch)"}`,
          payload: {
            sandboxWorktreePath: finishedAttempt.sandboxWorktreePath,
            sandboxBranch: finishedAttempt.sandboxBranch,
            sandboxBaseRepo: finishedAttempt.sandboxBaseRepo,
            error: mergeBack.error,
          },
        });
      }
    }
  }

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

  // Tear down any throwaway sandbox worktrees this run provisioned for its
  // unattended workers. Best-effort and idempotent: dedup by worktree path,
  // and a failed removal (e.g. unmerged branch) just leaves the dir for the
  // next worktree-prune. Workers were killed above so the dirs are released.
  const removedSandboxPaths = new Set<string>();
  for (const attempt of run.workerAttempts) {
    if (
      !attempt.sandboxWorktreePath ||
      !attempt.sandboxBranch ||
      !attempt.sandboxBaseRepo ||
      removedSandboxPaths.has(attempt.sandboxWorktreePath)
    ) {
      continue;
    }
    removedSandboxPaths.add(attempt.sandboxWorktreePath);
    await removeSandboxWorktree({
      repoCwd: attempt.sandboxBaseRepo,
      worktreePath: attempt.sandboxWorktreePath,
      branch: attempt.sandboxBranch,
    }).catch(() => undefined);
  }

  // shell.trashItem on Windows can prompt the user when the recycle bin is
  // full, when a file is locked, or when sync providers (OneDrive) intercept
  // the delete. We bypass it entirely and remove the directory directly.
  // Workers were just killed; give the OS a beat to release ConPTY handles
  // before the rm so EBUSY/EPERM doesn't bounce us.
  await rmRunDirHard(runDir(run.id));

  // Drop the shadow ref that backs this run's checkpoints. Best-effort; a
  // missing ref or non-repo workspace is fine.
  const cwd = workspaceCwdFromRun(run);
  if (cwd) await deleteRunCheckpoints(cwd, run.id);

  // Evict from the in-memory cache so a later getRun for this id falls
  // through to disk (and correctly returns null now that the file is gone).
  runCache.delete(run.id);
}

// Reliable Cora-owned rewind. The epoch barrier lands before any asynchronous
// provider disposal or code restoration, so old provider callbacks immediately
// become stale. The final commit then trims chat/downstream work atomically.
interface ConversationRewindTarget {
  checkpoint?: Checkpoint;
  checkpointId?: string;
  checkpointIndex?: number;
  messagePointer: number;
  messageId?: string;
  scope: "chat" | "chat+code";
}

function disposeManagerSessions(runId: string): Promise<void> {
  for (const backendKind of ["claude", "codex", "pi"] as const) {
    try {
      getBackend(backendKind).interruptChat?.(runId);
    } catch {
      // Continue: epoch invalidation is authoritative even if ESC fails.
    }
  }
  return Promise.all(
    (["claude", "codex", "pi"] as const).map(async (backendKind) => {
      try {
        await getBackend(backendKind).disposeChat?.(runId);
      } catch {
        // Provider processes are best-effort cleanup; stale callbacks are still
        // blocked by the epoch barrier below.
      }
    }),
  ).then(() => undefined);
}

async function markConversationRewindFailed(
  run: RunState,
  error: unknown,
  target: ConversationRewindTarget,
): Promise<RunState> {
  const message = error instanceof Error ? error.message : String(error);
  return commitRunChange(run, {
    type: "run.conversation_rewind_failed",
    message: `Conversation rewind failed: ${message}`,
    payload: {
      error: message,
      checkpointId: target.checkpoint?.id,
      messageId: target.messageId,
      scope: target.scope,
    },
    mutate: (draft, timestamp) => {
      const activeCallIds = new Set(
        draft.sparkCalls
          .filter((call) => call.status === "started" && !call.completedAt)
          .map((call) => call.id),
      );
      for (const call of draft.sparkCalls) {
        if (!activeCallIds.has(call.id)) continue;
        call.status = "failed";
        call.error = `Conversation rewind failed after interrupt: ${message}`;
        call.completedAt = timestamp;
      }
      for (const userMessage of draft.humanMessages) {
        if (!userMessage.backendTurnId || !activeCallIds.has(userMessage.backendTurnId)) continue;
        if (userMessage.deliveryState === "acknowledged" || userMessage.deliveryState === "cancelled") continue;
        userMessage.deliveryState = "queued";
        delete userMessage.backendTurnId;
        if (userMessage.targetTurnId && activeCallIds.has(userMessage.targetTurnId)) {
          delete userMessage.targetTurnId;
        }
      }
      for (const attempt of draft.workerAttempts) {
        if (["preparing", "prompt_ready", "launching", "running", "finishing"].includes(attempt.status)) {
          attempt.status = "cancelled";
          attempt.finishedAt = attempt.finishedAt ?? timestamp;
        }
      }
      for (const task of draft.workerTasks) {
        if (["created", "queued", "claimed", "running", "needs_review", "retry_queued"].includes(task.status)) {
          task.status = "cancelled";
          task.updatedAt = timestamp;
        }
      }
      // Keep the durable rewind marker so startup or an explicit retry can
      // finish the same oldEpoch -> newEpoch transaction without advancing the
      // conversation generation again.
      delete draft.chatSessionUuid;
      delete draft.chatSessionMode;
      draft.status = "paused";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
        status: "paused",
        lastAction: "conversation_rewind_failed",
        stopReason: `Rewind failed: ${message}`,
        pausedAt: timestamp,
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
  });
}

async function performConversationRewind(
  runId: string,
  target: ConversationRewindTarget,
): Promise<UndoToCheckpointResult> {
  const original = await requireRun(runId);
  const transaction = resolveConversationRewindTransaction({
    conversationEpoch: conversationEpoch(original),
    messageCount: original.humanMessages.length,
    pending: original.pendingConversationRewind,
    request: {
      messagePointer: target.messagePointer,
      messageId: target.messageId,
      checkpointId: target.checkpointId ?? target.checkpoint?.id,
      checkpointIndex: target.checkpointIndex,
      scope: target.scope,
    },
  });
  const { oldEpoch, newEpoch, pointer } = transaction;
  const checkpointIndex = transaction.checkpointIndex ?? target.checkpointIndex;
  const restoredMessage = target.messageId
    ? original.humanMessages.find((message) => message.id === target.messageId) ?? null
    : original.humanMessages[pointer] ?? null;
  const restoredText = restoredMessage?.message ?? null;
  const cutoff = original.humanMessages[pointer]?.createdAt;
  const priorPendingResume = original.pendingManagerResume;
  const interruptedCall = activeManagerCall(original);

  const keptCheckpoints = target.checkpoint
    ? (original.checkpoints ?? []).slice(0, checkpointIndex ?? 0)
    : (original.checkpoints ?? []).filter((checkpoint) =>
        checkpoint.kind === "user-message"
          ? checkpoint.messagePointer < pointer
          : checkpoint.messagePointer <= pointer,
      );
  const parentCheckpoint = [...keptCheckpoints].reverse().find((checkpoint) => checkpoint.sha);

  const activeWorkers = activeWorkersForRun(original.id);

  // Epoch barrier first: callbacks that settle while provider processes are
  // being disposed can no longer persist UUIDs, stream events, or decisions.
  // Recovery resumes the already-durable barrier instead of advancing the
  // conversation generation a second time.
  let barrier = original;
  if (!transaction.resuming) {
    barrier = await commitRunChange(original, {
    type: "run.conversation_rewind_started",
    message: "Conversation rewind started",
    payload: {
      oldEpoch,
      newEpoch,
      checkpointId: target.checkpoint?.id,
      messageId: restoredMessage?.id,
      scope: target.scope,
    },
    mutate: (draft, timestamp) => {
      if (conversationEpoch(draft) !== oldEpoch) return false;
      draft.conversationEpoch = newEpoch;
      delete draft.chatSessionUuid;
      delete draft.chatSessionMode;
      draft.pendingConversationRewind = {
        oldEpoch,
        newEpoch,
        messagePointer: pointer,
        messageId: restoredMessage?.id,
        checkpointId: target.checkpoint?.id,
        checkpointIndex: target.checkpointIndex,
        scope: target.scope,
        startedAt: timestamp,
      };
      draft.status = "paused";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
        status: "paused",
        lastAction: "conversation_rewind_started",
        stopReason: "Rewinding conversation",
        pausedAt: timestamp,
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
    });
  }

  for (const worker of activeWorkers) {
    try {
      worker.kill();
    } catch {
      // best-effort
    }
    try {
      pty.killImmediate(worker.attemptId);
    } catch {
      // already gone
    }
    activeWorkerProcesses.delete(worker.attemptId);
  }
  for (const key of [...activeAutopilotCycles.keys()]) {
    if (key.startsWith(`${original.id}:`)) activeAutopilotCycles.delete(key);
  }
  activeAutopilotPlans.delete(original.id);
  activeAutopilotReviews.delete(original.id);
  activeSteeringFollowups.delete(original.id);
  for (const key of [...activePendingManagerResumes]) {
    if (key.startsWith(`${original.id}:`)) activePendingManagerResumes.delete(key);
  }
  await disposeManagerSessions(runId);

  try {
    if (target.scope === "chat+code") {
      if (!target.checkpoint?.sha) {
        throw new Error("This checkpoint has no workspace snapshot — chat-only undo is still available.");
      }
      const cwd = workspaceCwdFromRun(barrier);
      if (!cwd) throw new Error("Workspace path missing — cannot restore code.");
      await restoreCheckpointCode({ cwd, sha: target.checkpoint.sha });
    }

    const rewindCwd = workspaceCwdFromRun(barrier);
    if (rewindCwd) {
      await scheduleShadowRefRewind({
        runId: barrier.id,
        cwd: rewindCwd,
        sha: parentCheckpoint?.sha ?? null,
      });
    }
  } catch (error) {
    barrier = await markConversationRewindFailed(barrier, error, target);
    throw error;
  }

  const removedForAudit = barrier.humanMessages.slice(pointer).map((message) => ({
    id: message.id,
    author: message.author,
    kind: message.kind,
    intent: message.intent,
    priorDeliveryState: message.deliveryState,
    deliveryState: "cancelled" as const,
    targetTurnId: message.targetTurnId,
    backendTurnId: message.backendTurnId,
    conversationEpoch: message.conversationEpoch ?? oldEpoch,
    message: message.message,
  }));
  const cancelledAttemptIds = new Set(activeWorkers.map((worker) => worker.attemptId));
  const cancelledTaskIds = new Set(activeWorkers.map((worker) => worker.workerTaskId));
  for (const attempt of barrier.workerAttempts) {
    if (["preparing", "prompt_ready", "launching", "running", "finishing"].includes(attempt.status)) {
      cancelledAttemptIds.add(attempt.id);
    }
  }
  for (const task of barrier.workerTasks) {
    if (["created", "queued", "claimed", "running", "needs_review", "retry_queued"].includes(task.status)) {
      cancelledTaskIds.add(task.id);
    }
  }

  const rewound = await commitRunChange(barrier, {
    type: "run.conversation_rewound",
    message: `Conversation rewound from epoch ${oldEpoch} to ${newEpoch}`,
    payload: {
      oldEpoch,
      newEpoch,
      checkpointId: target.checkpoint?.id,
      messageId: restoredMessage?.id,
      pointer,
      scope: target.scope,
      removedMessages: removedForAudit,
      cancelledAttemptIds: [...cancelledAttemptIds],
      cancelledTaskIds: [...cancelledTaskIds],
    },
    mutate: (draft, timestamp) => {
      if (conversationEpoch(draft) !== newEpoch) return false;
      draft.humanMessages = draft.humanMessages.slice(0, pointer);
      draft.checkpoints = keptCheckpoints;
      delete draft.pendingManagerResume;
      delete draft.pendingConversationRewind;
      delete draft.blockedOn;
      delete draft.chatSessionUuid;
      delete draft.chatSessionMode;

      if (cutoff) {
        draft.steps = draft.steps.filter((step) => step.createdAt < cutoff);
        const keptStepIds = new Set(draft.steps.map((step) => step.id));
        draft.workerTasks = draft.workerTasks.filter((task) => task.createdAt < cutoff);
        const keptTaskIds = new Set(draft.workerTasks.map((task) => task.id));
        draft.workerAttempts = draft.workerAttempts.filter((attempt) =>
          keptTaskIds.has(attempt.workerTaskId),
        );
        draft.sparkCalls = draft.sparkCalls.filter(
          (call) => call.createdAt < cutoff && call.status !== "started",
        );
        draft.assumptions = (draft.assumptions ?? []).filter(
          (assumption) => assumption.createdAt < cutoff,
        );
        if (draft.currentStepId && !keptStepIds.has(draft.currentStepId)) {
          draft.currentStepId = undefined;
        }
      } else {
        draft.sparkCalls = draft.sparkCalls.filter((call) => call.status !== "started");
        draft.assumptions = [];
      }

      for (const attempt of draft.workerAttempts) {
        if (
          attempt.status === "preparing" ||
          attempt.status === "prompt_ready" ||
          attempt.status === "launching" ||
          attempt.status === "running" ||
          attempt.status === "finishing"
        ) {
          attempt.status = "cancelled";
          attempt.finishedAt = attempt.finishedAt ?? timestamp;
          cancelledAttemptIds.add(attempt.id);
        }
      }
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
          cancelledTaskIds.add(task.id);
        }
      }

      const openQuestion = unresolvedRunQuestions(draft.humanMessages).at(-1) ?? null;
      if (openQuestion) {
        const source = openQuestion.questionContext?.source ??
          (draft.executionMode === "direct" ? "direct_worker" : "manager_decision");
        if (draft.executionMode === "direct" || source === "direct_worker") {
          // A report-blocked direct run has no live RPC after rewind. Keep the
          // question ownerless so the automation loop's exact linked-answer
          // seam can launch the continuation; fabricating active_rpc ownership
          // would restore the run to running and suppress that seam.
          delete draft.blockedOn;
          draft.status = "blocked";
          draft.autopilot = {
            ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
            status: "blocked",
            lastAction: "waiting_for_user",
            stopReason:
              openQuestion.questionContext?.reason ?? "Cora still needs this answer.",
            updatedAt: timestamp,
          };
          draft.updatedAt = timestamp;
          return;
        }
        const managerMode =
          priorPendingResume?.questionMessageId === openQuestion.id
            ? priorPendingResume.managerMode
            : interruptedCall?.mode;
        const blocker = createRunBlocker({
          questionMessageId: openQuestion.id,
          category:
            openQuestion.questionContext?.category ??
            inferRunQuestionCategory(openQuestion.message, source),
          currentStatus: "paused",
          resumeStatus: "running",
          source,
          // Rewind always invalidates the provider session/RPC owner. Managed
          // questions therefore resume through a fresh scheduled stage.
          resumeStrategy: "schedule_manager",
          managerMode,
          blockedAt: openQuestion.createdAt,
        });
        applyRunQuestionBlocker(
          draft,
          blocker,
          openQuestion.questionContext?.reason ?? "Cora still needs this answer.",
          timestamp,
        );
      } else {
        draft.status = "complete";
        draft.completedAt = timestamp;
        draft.seen = true;
        draft.autopilot = {
          ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
          status: "idle",
          lastAction: "undo",
          stopReason: "Undone by user",
          updatedAt: timestamp,
        };
      }
      draft.updatedAt = timestamp;
    },
  });

  return { run: rewound, restoredText };
}

function queueConversationRewind(
  runId: string,
  target: ConversationRewindTarget,
): Promise<UndoToCheckpointResult> {
  const prior = activeConversationRewinds.get(runId);
  const rewind = (prior ? prior.catch(() => undefined) : Promise.resolve()).then(() =>
    performConversationRewind(runId, target),
  );
  const tail = rewind.finally(() => {
    if (activeConversationRewinds.get(runId) === tail) {
      activeConversationRewinds.delete(runId);
    }
  });
  activeConversationRewinds.set(runId, tail);
  return rewind;
}

export async function undoToCheckpoint(
  input: UndoToCheckpointInput,
): Promise<UndoToCheckpointResult> {
  const run = await requireRun(input.runId);
  const checkpoints = run.checkpoints ?? [];
  const checkpointIndex = checkpoints.findIndex((checkpoint) => checkpoint.id === input.checkpointId);
  if (checkpointIndex < 0) throw new Error("Checkpoint not found on this run.");
  const checkpoint = checkpoints[checkpointIndex];
  if (input.scope === "chat+code" && !checkpoint.sha) {
    throw new Error("This checkpoint has no workspace snapshot — chat-only undo is still available.");
  }
  return queueConversationRewind(run.id, {
    checkpoint,
    checkpointIndex,
    messagePointer: checkpoint.messagePointer,
    messageId: checkpoint.messageId,
    scope: input.scope,
  });
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
  const oldEpoch = conversationEpoch(run);
  const activeCallIds = new Set(
    run.sparkCalls
      .filter((call) => call.status === "started" && !call.completedAt)
      .map((call) => call.id),
  );

  // 0. Dispose both provider sessions, not only the currently-installed PTY.
  // Session generation invalidation also catches a turn still inside async
  // startup/readiness, so it cannot submit after the pause commit.
  await disposeManagerSessions(run.id);

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
      if (conversationEpoch(draft) !== oldEpoch) return false;
      draft.conversationEpoch = oldEpoch + 1;
      delete draft.chatSessionUuid;
      delete draft.chatSessionMode;
      for (const call of draft.sparkCalls) {
        if (!activeCallIds.has(call.id) || call.status !== "started") continue;
        call.status = "failed";
        call.error = "Manager turn interrupted by force pause.";
        call.completedAt = timestamp;
      }
      for (const message of draft.humanMessages) {
        if (!message.backendTurnId || !activeCallIds.has(message.backendTurnId)) continue;
        if (message.deliveryState === "acknowledged" || message.deliveryState === "cancelled") continue;
        message.deliveryState = "queued";
        message.conversationEpoch = oldEpoch + 1;
        delete message.backendTurnId;
        if (message.targetTurnId && activeCallIds.has(message.targetTurnId)) {
          delete message.targetTurnId;
        }
      }
      abandonRunQuestionOwnership(draft);
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

// Legacy compound operation retained for API compatibility: force-pause, then
// explicitly rewind pending chat. The renderer's Stop controls MUST NOT call
// this — Stop preserves history and uses forcePauseRun; only a deliberately
// named rewind/undo flow may remove conversation state.
export async function stopAndUndoPending(
  runId: string,
): Promise<UndoToCheckpointResult> {
  const run = await requireRun(runId);
  let lastUserIndex = -1;
  for (let index = run.humanMessages.length - 1; index >= 0; index -= 1) {
    if (run.humanMessages[index].author === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) {
    const paused = await forcePauseRun(run.id);
    return { run: paused, restoredText: null };
  }
  const epoch = conversationEpoch(run);
  const activeCallId = activeManagerCall(run)?.id;
  const pendingIndexes = run.humanMessages
    .map((message, index) => ({ message, index }))
    .filter(
      ({ message }) =>
        message.author === "user" &&
        (message.conversationEpoch ?? 0) === epoch &&
        (message.deliveryState === "queued" || message.deliveryState === "submitted") &&
        (message.backendTurnId === activeCallId || message.intent === "steer"),
    )
    .map(({ index }) => index);
  const rollbackIndex = pendingIndexes.length > 0
    ? Math.min(...pendingIndexes)
    : lastUserIndex;
  // Stop rewinds from the earliest pending turn, so return every removed user
  // message in FIFO order. Returning only the newest silently discarded older
  // queued steering when the composer was restored.
  const restoredMessages = run.humanMessages
    .slice(rollbackIndex)
    .filter((message) => message.author === "user")
    .map((message) => message.message.trim())
    .filter(Boolean);
  const result = await queueConversationRewind(run.id, {
    messagePointer: rollbackIndex,
    messageId: run.humanMessages[rollbackIndex]?.id,
    scope: "chat",
  });
  return {
    ...result,
    restoredText: restoredMessages.join("\n\n"),
  };
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
  // LLM manager round-trip — Codara already knows the answer is "try the same
  // task with the other runtime." Queue that fallback deterministically here,
  // before the manager review consumes the failed report.
  const launchFallback = await maybeQueueCliLaunchFallback({
    run,
    task,
    attempt,
    report,
  });
  if (launchFallback) return launchFallback;

  // Closed-loop verifier processing. Order matters:
  //   1. Regression auto-restore — if this verdict fails a claim that a prior
  //      verdict marked green, a later worker broke previously-working behavior;
  //      revert the workspace to the most recent pre-worker snapshot and emit a
  //      loud notice before anything else looks at the verdict.
  //   2. Record this report's newly-verified claims as green — done BEFORE the
  //      FEEDBACK short-circuit so a partial pass isn't lost when the same report
  //      also re-enqueues the impl with corrective feedback.
  //   3. Round accounting + guardrails — bump the persisted verification-round
  //      counter for CORRECTIVE verdicts only, short-circuit oracle-blocked
  //      verdicts (re-running the impl cannot conjure missing tooling), and
  //      force-land past the run-level verification ceiling instead of feeding
  //      another corrective loop.
  //   4. FEEDBACK re-enqueue — deterministically re-run the impl worker with the
  //      verifier's corrective prompt, skipping a full manager round-trip.
  if (report.verifier) {
    const regressionRestore = await maybeRestoreGreenClaimRegression({ run, task, attempt, report });
    if (regressionRestore) {
      run = regressionRestore.run;
      if (regressionRestore.restoreFailed) return run;
    }
    run = await recordGreenClaims({ run, attempt, report });
    // Only corrective verdicts (FEEDBACK/FAILED — the ones that trigger rework)
    // consume verification budget. Clean terminal-OK passes on distinct scopes
    // are the healthy shape of a multi-feature run; counting them would let
    // the runaway-loop ceiling guillotine a run that never looped.
    const correctiveVerdict = !TERMINAL_OK_VERIFIER_CONFIDENCE.has(report.verifier.confidence);
    if (correctiveVerdict) {
      run = await recordVerificationRound({ run, task, attempt });
    }
    const oracleAccept = await maybeAcceptOracleBlockedVerifierVerdict({ run, task, attempt, report });
    if (oracleAccept) return oracleAccept;
    if (correctiveVerdict) {
      const ceilingLanded = await maybeForceLandAtVerificationCeiling(run);
      if (ceilingLanded) return ceilingLanded;
    }
    const feedbackRetry = await maybeQueueVerifierFeedbackRetry({
      run,
      task,
      attempt,
      report,
    });
    if (feedbackRetry) return feedbackRetry;
  }

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

// The five verifier confidence rungs that count as a *terminal* cross-provider
// verdict for invariant purposes. PERFECT/VERIFIED/PARTIAL mean an independent
// verifier re-derived ground truth and signed off (PARTIAL = signed off with
// caveats); FEEDBACK/FAILED demand another corrective round, so they do NOT
// satisfy coverage. Mirrors the spec's terminal-OK set.
const TERMINAL_OK_VERIFIER_CONFIDENCE = new Set<VerifierVerdict["confidence"]>([
  "PERFECT",
  "VERIFIED",
  "PARTIAL",
]);

// Worker-task statuses that mean a verifier is still "live" (in flight or
// awaiting review) on a step. If one of these exists we must NOT synthesize a
// second verifier — the existing one will produce the terminal verdict.
const LIVE_VERIFIER_TASK_STATUSES = new Set<WorkerTaskStatus>([
  "created",
  "queued",
  "claimed",
  "running",
  "needs_review",
  "retry_queued",
]);

// Per-step facts derived from worker reports on disk. Computed once and reused
// by ensureVerifierCoverage (to decide whether to synthesize a verifier) and by
// stepHasTerminalVerifierVerdict (to gate step->complete transitions).
interface StepVerifierFacts {
  // At least one of the step's attempts produced a parseable worker report.
  // False means the step never executed (or nothing it ran reported back) —
  // callers must not read changedFiles=false as "verified no-op" in that case.
  hasAnyReport: boolean;
  // The step's non-verifier workers collectively reported >=1 filesChanged.
  changedFiles: boolean;
  // A verifier task is in flight / awaiting review on the step.
  hasLiveVerifier: boolean;
  // A verifier task on the step reported a terminal-OK verdict
  // (PERFECT/VERIFIED/PARTIAL).
  hasTerminalVerifierVerdict: boolean;
  // Runtime of the implementer whose work changed files (claude/codex), used to
  // pick the opposite runtime for cross-provider verification. undefined when
  // the implementer ran on a non-agent runtime (shell/manual).
  implementerRuntime?: WorkerRuntime;
}

// Reads the on-disk reports for a single step's worker attempts and distills the
// facts the verifier invariant needs. Modeled on the report-reading loop in
// maybeReconAsCompletionRefusal (iterate workerAttempts -> map to task ->
// readWorkerReport -> inspect filesChanged / verifier verdict).
async function computeStepVerifierFacts(
  run: RunState,
  stepId: string,
): Promise<StepVerifierFacts> {
  const stepTasks = run.workerTasks.filter((task) => task.stepId === stepId);
  const verifierTaskIds = new Set(
    stepTasks.filter((task) => task.taskClass === "verifier").map((task) => task.id),
  );
  const hasLiveVerifier = stepTasks.some(
    (task) => task.taskClass === "verifier" && LIVE_VERIFIER_TASK_STATUSES.has(task.status),
  );

  let hasAnyReport = false;
  let changedFiles = false;
  let hasTerminalVerifierVerdict = false;
  let implementerRuntime: WorkerRuntime | undefined;

  for (const attempt of run.workerAttempts) {
    const task = stepTasks.find((t) => t.id === attempt.workerTaskId);
    if (!task) continue;
    if (!attempt.finalReportPath) continue;
    const report = await readWorkerReport(attempt.finalReportPath);
    if (!report) continue;
    hasAnyReport = true;
    if (verifierTaskIds.has(task.id)) {
      const confidence = report.verifier?.confidence;
      if (confidence && TERMINAL_OK_VERIFIER_CONFIDENCE.has(confidence)) {
        hasTerminalVerifierVerdict = true;
      }
    } else if (Array.isArray(report.filesChanged) && report.filesChanged.length > 0) {
      changedFiles = true;
      if (
        !implementerRuntime &&
        (task.runtimePreference === "claude" || task.runtimePreference === "codex")
      ) {
        implementerRuntime = task.runtimePreference;
      }
    }
  }

  return { hasAnyReport, changedFiles, hasLiveVerifier, hasTerminalVerifierVerdict, implementerRuntime };
}

// Cross-provider verification as a code-level invariant. For each non-terminal
// worker_batch step whose non-verifier workers changed files but which has
// NEITHER a live verifier task NOR an existing terminal verifier verdict,
// synthesize one cross-provider verifier task (opposite runtime of the
// implementer) so the silent-verifier hole cannot reopen. Steps that changed no
// files are skipped — identical behavior to before. Modeled on
// maybeReconAsCompletionRefusal's report-reading loop; reuses the
// dropVerifierTasksWithExistingPeer guard semantics (a live verifier on the step
// short-circuits) so we never double-add.
async function ensureVerifierCoverage(run: RunState, cwd: string): Promise<RunState> {
  void cwd; // createWorkerTask resolves cwd at launch; accepted for call-site symmetry.
  let latest = run;
  for (const step of run.steps) {
    if (isTerminalStepStatus(step.status)) continue;
    if ((step.kind ?? "worker_batch") !== "worker_batch") continue;
    const facts = await computeStepVerifierFacts(latest, step.id);
    if (!facts.changedFiles) continue; // identical behavior for no-change steps
    if (facts.hasLiveVerifier) continue; // existing verifier will produce the verdict
    if (facts.hasTerminalVerifierVerdict) continue; // already covered

    // Cross-provider: verify on the runtime opposite the implementer's. Default
    // to claude when the implementer ran on a non-agent runtime (shell/manual).
    const verifierRuntime: WorkerRuntime =
      facts.implementerRuntime === "claude" ? "codex" : "claude";
    const criteria = step.acceptanceCriteria.filter((c) => c.trim().length > 0);
    const claims =
      criteria.length > 0
        ? criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
        : "1. The implementation matches the step goal and changed files behave as specified.";
    const description = [
      `Independently verify the implementation for step "${step.title}".`,
      step.goal ? `Step goal: ${step.goal}` : "",
      "Re-derive ground truth from the filesystem; do NOT trust the implementer's self-report.",
      "Confirm each of these atomic claims and return a verifier verdict:",
      claims,
    ]
      .filter((line) => line.length > 0)
      .join("\n");

    latest = await createWorkerTask({
      runId: latest.id,
      stepId: step.id,
      title: `Verify: ${step.title}`,
      description,
      taskClass: "verifier",
      allowedPaths: [],
      runtimePreference: verifierRuntime,
      createdBy: "spark",
    });
    await appendEvent({
      workspaceId: latest.workspaceId,
      runId: latest.id,
      stepId: step.id,
      type: "spark_manager.verifier_coverage_enforced",
      message: `Synthesized a cross-provider verifier for step "${step.title}" (changed files, no terminal verifier verdict)`,
      payload: {
        stepId: step.id,
        stepTitle: step.title,
        verifierRuntime,
        implementerRuntime: facts.implementerRuntime,
        acceptanceCriteriaCount: criteria.length,
      },
    });
  }
  return latest;
}

// Gating helper for the THREE step->complete transitions. Returns true (the
// step may flip to a clean `complete`) when the step changed no files, or when a
// verifier task on the step reported a terminal-OK verdict. Returns false only
// for a changed-files step that lacks a terminal verifier verdict — such a step
// must stay reviewing (when a verifier is pending) or land as
// `completed_unverified` (force-accept paths) rather than as a clean complete.
async function stepHasTerminalVerifierVerdict(run: RunState, stepId: string): Promise<boolean> {
  const facts = await computeStepVerifierFacts(run, stepId);
  if (!facts.changedFiles) return true;
  return facts.hasTerminalVerifierVerdict;
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
  const candidateStepIds = run.steps
    .filter((step) => !isTerminalStepStatus(step.status))
    .filter((step) => {
      const tasks = run.workerTasks.filter((task) => task.stepId === step.id);
      return tasks.length > 0 && tasks.every((task) => task.status === "accepted" || task.status === "cancelled");
    })
    .map((step) => step.id);

  // Verifier invariant gate: a candidate step whose impl changed files may only
  // flip to a clean `complete` when an independent verifier signed off
  // (PERFECT/VERIFIED/PARTIAL). A changed-files step lacking that terminal
  // verdict is held back here (kept reviewing) — in practice ensureVerifierCoverage
  // has already queued a verifier whose non-terminal task status keeps the step
  // out of `candidateStepIds` anyway, but this gate enforces the rule even if
  // that task was cancelled. Steps that changed no files pass unchanged.
  const eligibleStepIds: string[] = [];
  for (const stepId of candidateStepIds) {
    if (await stepHasTerminalVerifierVerdict(run, stepId)) {
      eligibleStepIds.push(stepId);
    }
  }

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
  const failureContext = [
    attempt.error ?? "",
    report.summary,
    ...report.risks,
  ].join("\n");
  // A user stop/pause is control flow, not evidence that the provider or CLI
  // is broken. Never turn it into an automatic cross-provider retry.
  if (
    /(?:worker (?:was )?interrupted|user (?:stop|pause)|force[- ]paused|run (?:was )?paused|stopped by (?:the )?user)/i.test(
      failureContext,
    )
  ) {
    return null;
  }
  const isLaunchFailure = report.risks.some((risk) =>
    /CLI failed (?:to launch|before producing a final report)|runtime API error|socket connection/i.test(risk),
  );
  if (!isLaunchFailure) return null;
  if (
    task.runtimePreference !== "claude" &&
    task.runtimePreference !== "codex"
  ) {
    return null;
  }
  const availableRuntimes = await detectConfiguredAgentRuntimes();
  // Prefer the first installed runtime OTHER than the one that just failed.
  // Order claude → codex by default, but skip the failing one.
  const preferenceOrder: WorkerRuntime[] = ["claude", "codex"];
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
        supersedesTaskId: task.id,
        stepId: task.stepId,
        title: task.title,
        description: task.description,
        runtimePreference: opposite,
        modelHint: fallbackModelHintForRuntime(opposite, task.modelHint),
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

// Normalizes a verifier atomic-claim string into a stable key so the same claim
// phrased with incidental whitespace/case differences across attempts maps to a
// single green-map entry.
function normalizeClaimKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

// One verification round = one reviewed worker report carrying a CORRECTIVE
// verifier verdict (FEEDBACK/FAILED — the caller skips clean terminal-OK
// passes). Persisted on the run so the ceiling survives restarts and can be
// read from the spawn chokepoint as well as here; reset on every new user
// turn so a follow-up never inherits a saturated counter.
async function recordVerificationRound({
  run,
  task,
  attempt,
}: {
  run: RunState;
  task: WorkerTask;
  attempt: WorkerAttempt;
}): Promise<RunState> {
  const nextRounds = (run.verificationRounds ?? 0) + 1;
  return commitRunChange(run, {
    type: "autopilot.verification_round_recorded",
    stepId: task.stepId,
    workerTaskId: task.id,
    message: `Verification round ${nextRounds} reviewed`,
    payload: { attemptId: attempt.id, verificationRounds: nextRounds },
    mutate: (draft, timestamp) => {
      draft.verificationRounds = (draft.verificationRounds ?? 0) + 1;
      draft.updatedAt = timestamp;
    },
  });
}

// Run-level verification-round ceiling for execute-mode CLI/Pi managers. The
// per-spawn cap in agent-socket stops new verifier steps at the source; this
// backstop bounds shapes it cannot see (multi-verifier batches, verifiers
// minted before the cap existed). Deliberately generous — it exists to stop
// runaway loops, not to police normal runs.
const VERIFICATION_ROUND_CEILING = { fast: 4, deep: 6, frontier: 9 } as const;

async function maybeForceLandAtVerificationCeiling(run: RunState): Promise<RunState | null> {
  if (!runHasMcpManager(run)) return null;
  const rounds = run.verificationRounds ?? 0;
  const ceiling = VERIFICATION_ROUND_CEILING[normalizeCoraExecutionPolicy(run.coraExecutionPolicy)];
  if (rounds < ceiling) return null;
  return forceLandRunUnverified(run.id, {
    trigger: "verification_rounds_capped",
    note:
      `Verification hit its hard ceiling: ${rounds} rounds against a limit of ${ceiling} for this policy. ` +
      "Codara accepted the remaining reviewed work and landed it as unverified — further rounds were repeating the same evidence.",
  });
}

// Guardrail landing: accept everything still pending (except tasks with a
// live worker process), cancel pending work that never even produced an
// attempt, label steps that never earned a terminal verifier verdict as
// completed_unverified, and land the run when that leaves every step
// terminal. Mirrors the deadlock-break in applySparkManagerDecision —
// this variant is callable from code-level caps (verification-round ceiling,
// synthetic-step ceiling) where no manager decision object exists.
export async function forceLandRunUnverified(
  runId: string,
  input: { trigger: "verification_rounds_capped" | "synthetic_step_ceiling"; note: string },
): Promise<RunState> {
  let run = await requireRun(runId);
  const liveWorkerTaskIds = new Set(
    activeWorkersForRun(run.id)
      .map((worker) => worker.workerTaskId)
      .filter((id): id is string => Boolean(id)),
  );
  const landableStatuses = new Set<WorkerTaskStatus>([
    "created",
    "queued",
    "claimed",
    "running",
    "needs_review",
    "retry_queued",
  ]);
  const pendingTasks = run.workerTasks.filter(
    (task) => landableStatuses.has(task.status) && !liveWorkerTaskIds.has(task.id),
  );
  // Work that never produced an attempt cannot honestly be "accepted" —
  // force-accepting it would report never-executed work as done. Cancel it
  // instead so the landing is explicit about what was skipped.
  const attemptedTaskIds = new Set(run.workerAttempts.map((attempt) => attempt.workerTaskId));
  const cancelTaskIds = new Set(
    pendingTasks
      .filter(
        (task) =>
          (task.status === "created" || task.status === "queued") &&
          !attemptedTaskIds.has(task.id),
      )
      .map((task) => task.id),
  );
  const landableTasks = pendingTasks.filter((task) => !cancelTaskIds.has(task.id));
  // Precompute which affected steps may land as a clean `complete` (reads
  // reports from disk) before the synchronous mutate. A step qualifies only
  // when it actually reported back AND either changed no files or earned a
  // terminal verifier verdict — a step with NO reports at all never executed,
  // so the changedFiles=false shortcut must not mark it clean.
  const openStepIds = run.steps
    .filter((step) => !isTerminalStepStatus(step.status))
    .map((step) => step.id);
  const cleanCompleteStepIds = new Set<string>();
  for (const stepId of openStepIds) {
    const facts = await computeStepVerifierFacts(run, stepId);
    if (facts.hasAnyReport && (!facts.changedFiles || facts.hasTerminalVerifierVerdict)) {
      cleanCompleteStepIds.add(stepId);
    }
  }
  run = await commitRunChange(run, {
    type: "autopilot.guardrail_force_landed",
    message: input.note,
    payload: {
      trigger: input.trigger,
      acceptedTaskIds: landableTasks.map((task) => task.id),
      cancelledTaskIds: [...cancelTaskIds],
      verificationRounds: run.verificationRounds,
    },
    mutate: (draft, timestamp) => {
      const acceptIds = new Set(landableTasks.map((task) => task.id));
      for (const task of draft.workerTasks) {
        if (cancelTaskIds.has(task.id)) {
          task.status = "cancelled";
          task.updatedAt = timestamp;
          continue;
        }
        if (!acceptIds.has(task.id)) continue;
        task.status = "accepted";
        task.forceAccepted = true;
        task.forceAcceptReason = input.trigger;
        task.updatedAt = timestamp;
      }
      for (const step of draft.steps) {
        if (isTerminalStepStatus(step.status)) continue;
        const stepTasks = draft.workerTasks.filter((task) => task.stepId === step.id);
        const allDone =
          stepTasks.length > 0 &&
          stepTasks.every((task) =>
            ["accepted", "failed", "cancelled", "blocked"].includes(task.status),
          );
        if (!allDone) continue;
        step.status = cleanCompleteStepIds.has(step.id) ? "complete" : "completed_unverified";
        step.updatedAt = timestamp;
        if (draft.currentStepId === step.id) draft.currentStepId = undefined;
      }
      const allStepsTerminal =
        draft.steps.length > 0 &&
        draft.steps.every((step) => isTerminalStepStatus(step.status));
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
        lastAction: "guardrail_force_landed",
        stopReason: input.trigger,
        updatedAt: timestamp,
      };
      if (allStepsTerminal) {
        draft.status = "complete";
        draft.autopilot.status = "complete";
      }
      draft.updatedAt = timestamp;
    },
  });
  await addRunMessage({
    runId: run.id,
    author: "system",
    kind: "note",
    message: input.note,
  }).catch(() => undefined);
  return requireRun(run.id);
}

// True when a FEEDBACK verdict is environmental rather than behavioral: the
// verifier flagged an unavailable oracle (missing_oracle in its final report)
// and none of its failed claims stand on independent evidence. Re-running the
// implementation cannot conjure the missing tooling, so requeueing it just
// burns attempts — the exact loop from run-mrz25z39-9ffs4w, where every
// verifier hedged on absent codara-studio MCP tools and each hedge re-ran the
// build. A failed claim with real evidence keeps the corrective path.
//
// Oracle-taint is an AVAILABILITY statement, never a topic match. The schema's
// `unsure` claim verdict is the natural encoding for "couldn't verify", so a
// verdict whose only non-verified claims are unsure ones is oracle-blocked. A
// hard-`failed` claim is discounted only when its own evidence explicitly says
// the tool/oracle could not be exercised — substring-matching topic words
// ("mcp", "codara-studio") over claim text would swallow genuine failures in
// any task whose subject matter IS the MCP/preview stack.
function verifierVerdictIsOracleBlocked(verdict: VerifierVerdict): boolean {
  const oracle = verdict.missingOracle?.trim().toLowerCase();
  if (!oracle) return false;
  const failed = (verdict.atomicClaims ?? []).filter((claim) => claim.verdict === "failed");
  if (failed.length === 0) return true;
  return failed.every((claim) => evidenceStatesOracleUnavailable(claim.evidence ?? "", oracle));
}

// Tight availability phrasings a verifier writes when it could not exercise a
// tool. Deliberately narrow: these describe the oracle being ABSENT, not the
// implementation failing. No /g flags — exec() must stay stateless.
const ORACLE_UNAVAILABLE_PHRASES: RegExp[] = [
  /\bnot\s+available\b/,
  /\bunavailable\b/,
  /\b(?:was|were|is|are)\s+not\s+(?:present|exposed|installed|loaded|accessible|reachable)\b/,
  /\bcould\s+not\s+(?:be\s+)?(?:run|invoked?|reached|accessed|used|found)\b/,
  /\bmissing\s+oracle\b/,
  /\bno\s+such\s+tool\b/,
  /\btools?\s+(?:was\s+|were\s+|is\s+|are\s+)?missing\b/,
];

// True when the evidence explicitly states the oracle/tool was unavailable:
// an availability phrase must appear ADJACENT to a tool/oracle reference, so a
// stray "not available" elsewhere in a long evidence blob — or a mere topic
// mention of a tool name alongside real failure evidence (a stack trace, a
// failing command) — never discounts the claim.
function evidenceStatesOracleUnavailable(evidence: string, oracle: string): boolean {
  const text = evidence.toLowerCase();
  for (const phrase of ORACLE_UNAVAILABLE_PHRASES) {
    const match = phrase.exec(text);
    if (!match) continue;
    const windowStart = Math.max(0, match.index - 100);
    const window = text.slice(windowStart, match.index + match[0].length + 100);
    if (window.includes(oracle) || /\b(?:tool|oracle|mcp)s?\b/.test(window)) return true;
  }
  return false;
}

// Accept a FEEDBACK verdict without re-running the implementation. Used when
// the feedback cannot be acted on (missing oracle) or when the policy's
// rework budget is spent. Terminalizes the verifier, leaves the
// implementation as-is, and lands the settled steps this verdict covered as
// completed_unverified — FEEDBACK is not a terminal-OK confidence, so a clean
// `complete` would misrepresent the evidence.
async function acceptVerifierFeedbackWithoutRetry({
  run,
  task,
  attempt,
  report,
  targetStepId,
  reason,
  note,
}: {
  run: RunState;
  task: WorkerTask;
  attempt: WorkerAttempt;
  report: WorkerReport;
  targetStepId?: string;
  reason: "missing_oracle" | "fast_policy_rework_cap";
  note: string;
}): Promise<RunState> {
  const settleStepIds = new Set(
    [task.stepId, targetStepId].filter((id): id is string => Boolean(id)),
  );
  const updated = await commitRunChange(run, {
    type: "autopilot.verifier_feedback_accepted_with_caveat",
    stepId: task.stepId,
    workerTaskId: task.id,
    message: note,
    payload: {
      reason,
      attemptId: attempt.id,
      confidence: report.verifier?.confidence,
      missingOracle: report.verifier?.missingOracle,
    },
    mutate: (draft, timestamp) => {
      const verifierTask = draft.workerTasks.find((candidate) => candidate.id === task.id);
      if (verifierTask) {
        verifierTask.status = "accepted";
        verifierTask.updatedAt = timestamp;
      }
      reconcileAcceptedVerifierOnlySteps(draft, timestamp);
      // Land only the steps this verdict actually settles; any step whose
      // tasks are all terminal but that lacks a terminal-OK confidence gets
      // the honest completed_unverified label.
      for (const step of draft.steps) {
        if (!settleStepIds.has(step.id) || isTerminalStepStatus(step.status)) continue;
        const stepTasks = draft.workerTasks.filter((candidate) => candidate.stepId === step.id);
        const allDone =
          stepTasks.length > 0 &&
          stepTasks.every((candidate) =>
            ["accepted", "failed", "cancelled", "blocked"].includes(candidate.status),
          );
        if (!allDone) continue;
        step.status = "completed_unverified";
        step.reviewSummary = note;
        step.updatedAt = timestamp;
        if (draft.currentStepId === step.id) draft.currentStepId = undefined;
      }
      draft.updatedAt = timestamp;
    },
  });
  await addRunMessage({
    runId: updated.id,
    author: "system",
    kind: "note",
    message: note,
  }).catch(() => undefined);
  return requireRun(updated.id);
}

// Short-circuits the corrective loop for verdicts that only hedge on missing
// tooling. Runs before maybeQueueVerifierFeedbackRetry so an oracle-blocked
// FEEDBACK never re-enqueues the implementation.
async function maybeAcceptOracleBlockedVerifierVerdict({
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
  const verdict = report.verifier;
  if (!verdict || verdict.confidence !== "FEEDBACK") return null;
  if (!verifierVerdictIsOracleBlocked(verdict)) return null;
  const oracle = verdict.missingOracle?.trim() || "required verification tooling";
  return acceptVerifierFeedbackWithoutRetry({
    run,
    task,
    attempt,
    report,
    reason: "missing_oracle",
    note:
      `The verifier could not run its required tooling (${oracle}) and had no independent failing evidence. ` +
      "Accepted the implementation with that caveat — re-running the build cannot restore missing tools.",
  });
}

const VERIFIER_FEEDBACK_HEADER = "## VERIFIER FEEDBACK";

// Detects a verifier FEEDBACK verdict and deterministically re-enqueues the
// implementation task the verifier was checking, carrying the verifier's
// correctivePrompt (plus failed atomic-claim bullets) into the next worker's
// prompt by appending a `## VERIFIER FEEDBACK` block to the impl task's
// description. Mirrors maybeQueueCliLaunchFallback: returns the updated run when
// it re-enqueues (so the caller short-circuits the normal review and the loop
// re-runs the same worker with the corrective prompt), or null when no FEEDBACK
// retry applies (cap reached / no target / not a FEEDBACK verdict).
async function maybeQueueVerifierFeedbackRetry({
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
  const verdict = report.verifier;
  if (!verdict || verdict.confidence !== "FEEDBACK") return null;
  const correctivePrompt = verdict.correctivePrompt?.trim();
  if (!correctivePrompt) return null;

  // Resolve the impl task to fix. Prefer a non-verifier, non-cancelled task in
  // the same step (the impl the verifier was checking). Managers may also put a
  // verifier in its own follow-up step; in that shape, match the failed claims
  // and corrective prompt against prior tasks' scoped paths/outputs instead of
  // dropping a perfectly actionable verdict.
  let target =
    task.taskClass !== "verifier" && task.status !== "cancelled"
      ? task
      : run.workerTasks.find(
          (t) =>
            t.stepId === task.stepId &&
            t.taskClass !== "verifier" &&
            t.status !== "cancelled",
        );
  if (!target && task.taskClass === "verifier") {
    const feedbackText = [
      correctivePrompt,
      ...(verdict.atomicClaims ?? [])
        .filter((claim) => claim.verdict === "failed")
        .flatMap((claim) => [claim.claim, claim.evidence]),
    ].join("\n").toLowerCase();
    const candidates = run.workerTasks.filter(
      (candidate) =>
        candidate.taskClass !== "verifier" &&
        candidate.status !== "cancelled",
    );
    const scored = candidates
      .map((candidate, index) => {
        const scopedPaths = [
          ...(candidate.allowedPaths ?? []),
          ...(candidate.expectedOutputs ?? []),
        ].filter((path) => path.trim().length > 0);
        const pathScore = scopedPaths.reduce(
          (score, path) => score + (feedbackText.includes(path.toLowerCase()) ? 10 : 0),
          0,
        );
        const titleTokens = candidate.title
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((token) => token.length >= 4);
        const titleScore = titleTokens.reduce(
          (score, token) => score + (feedbackText.includes(token) ? 1 : 0),
          0,
        );
        return { candidate, index, score: pathScore + titleScore };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || right.index - left.index);
    target = scored[0]?.candidate ?? (candidates.length === 1 ? candidates[0] : undefined);
  }
  if (!target) return null;
  const retriesUsed = countWorkerAttempts(run, target.id);
  if (retriesUsed >= MAX_WORKER_ATTEMPTS) return null;
  // "Fast" means at most one corrective rework in code, not just in prose.
  // Count FEEDBACK-driven requeues specifically — countWorkerAttempts also
  // includes non-verification retries (e.g. environmental relaunches). The
  // policy is only honored by the Pi backend (other backends persist but
  // ignore it), so the cap keys off chatBackend to avoid changing OpenRouter
  // and CC/Codex behavior via the fast default.
  const feedbackRoundsUsed = target.verifierFeedbackRounds ?? 0;
  if (
    run.chatBackend === "pi" &&
    normalizeCoraExecutionPolicy(run.coraExecutionPolicy) === "fast" &&
    feedbackRoundsUsed >= 1
  ) {
    return acceptVerifierFeedbackWithoutRetry({
      run,
      task,
      attempt,
      report,
      targetStepId: target.stepId,
      reason: "fast_policy_rework_cap",
      note:
        `The fast execution policy allows one verifier-feedback rework and "${target.title}" already used it. ` +
        "Accepted the current implementation with the verifier's remaining caveats instead of another rework round.",
    });
  }

  const failedClaims = (verdict.atomicClaims ?? []).filter(
    (claim) => claim.verdict === "failed",
  );
  const claimBullets = failedClaims
    .map((claim) => {
      const evidence = claim.evidence?.trim();
      return evidence
        ? `- ${claim.claim.trim()} (evidence: ${evidence})`
        : `- ${claim.claim.trim()}`;
    })
    .join("\n");
  const feedbackBlock = [
    VERIFIER_FEEDBACK_HEADER,
    "",
    "A cross-engine verifier reviewed your previous attempt and found it not yet",
    "complete. Address this feedback, then re-verify before reporting:",
    "",
    correctivePrompt,
    ...(claimBullets ? ["", "Failed checks:", claimBullets] : []),
  ].join("\n");

  const targetId = target.id;
  return commitRunChange(run, {
    type: "autopilot.verifier_feedback_retry",
    stepId: target.stepId,
    workerTaskId: targetId,
    message: `Re-queuing ${target.title} with verifier corrective feedback (attempt ${retriesUsed + 1}/${MAX_WORKER_ATTEMPTS})`,
    payload: {
      targetTaskId: targetId,
      verifierAttemptId: attempt.id,
      correctivePrompt,
      retriesUsed,
    },
    mutate: (draft, timestamp) => {
      const targetTask = draft.workerTasks.find((t) => t.id === targetId);
      if (!targetTask) return false;
      // De-dupe: don't stack an identical feedback block across repeated
      // retries. Guard on both the header and the corrective text already being
      // present in the description.
      const alreadyHasBlock =
        targetTask.description.includes(VERIFIER_FEEDBACK_HEADER) &&
        targetTask.description.includes(correctivePrompt);
      if (!alreadyHasBlock) {
        const trimmed = targetTask.description.replace(/\s+$/, "");
        targetTask.description = `${trimmed}\n\n${feedbackBlock}`;
      }
      targetTask.status = "retry_queued";
      targetTask.verifierFeedbackRounds = (targetTask.verifierFeedbackRounds ?? 0) + 1;
      targetTask.updatedAt = timestamp;
      // The verifier successfully completed its job even though the code did
      // not pass. Terminalize that verifier so a live CLI manager waiting on
      // codara_wait_for_workers can receive the verdict while the corrective
      // implementation task is launched independently.
      if (task.taskClass === "verifier" && task.id !== targetTask.id) {
        const verifierTask = draft.workerTasks.find((candidate) => candidate.id === task.id);
        if (verifierTask) {
          verifierTask.status = "accepted";
          verifierTask.updatedAt = timestamp;
        }
      }
      // A manager may put verification in its own follow-up step. FEEDBACK
      // means the implementation needs another pass, not that the verifier
      // failed its job. Close a now-settled verifier-only step before reopening
      // the implementation step, otherwise the graph permanently shows the
      // old verification step as REVIEWING while later steps execute.
      reconcileAcceptedVerifierOnlySteps(draft, timestamp);
      // Re-open the target's step so pickAutopilotTasks will relaunch it.
      const step = targetTask.stepId
        ? draft.steps.find((s) => s.id === targetTask.stepId)
        : undefined;
      if (step) {
        if (isTerminalStepStatus(step.status) || step.status === "reviewing") {
          step.status = "queued";
        }
        if (!step.workerTaskIds.includes(targetTask.id)) {
          step.workerTaskIds.push(targetTask.id);
        }
        step.updatedAt = timestamp;
      }
      draft.updatedAt = timestamp;
    },
  });
}

// Marks the report's newly-verified atomic claims green on the run (claim key ->
// the attempt that verified it). Records green even when the same report also
// triggers a FEEDBACK re-enqueue, so a partial pass isn't lost on the retry.
async function recordGreenClaims({
  run,
  attempt,
  report,
}: {
  run: RunState;
  attempt: WorkerAttempt;
  report: WorkerReport;
}): Promise<RunState> {
  const verified = (report.verifier?.atomicClaims ?? []).filter(
    (claim) => claim.verdict === "verified" && claim.claim.trim().length > 0,
  );
  if (verified.length === 0) return run;
  return commitRunChange(run, {
    type: "autopilot.green_claims_recorded",
    workerTaskId: attempt.workerTaskId,
    message: `Recorded ${verified.length} verified claim(s) as green`,
    payload: { attemptId: attempt.id, count: verified.length },
    mutate: (draft, timestamp) => {
      const greenClaims = (draft.greenClaims ??= {});
      for (const claim of verified) {
        greenClaims[normalizeClaimKey(claim.claim)] = attempt.id;
      }
      draft.updatedAt = timestamp;
    },
  });
}

// Detects regressions on previously-green claims: a verdict that marks an
// already-green claim as `failed`. When found, restores the workspace to the
// most recent impl pre-worker checkpoint (the latest non-null
// preWorkerCheckpointSha) and emits a loud revert notice, then drops the now-
// stale green entries so the next attempt re-establishes green. Returns the
// updated run (regression restored) or null when no regression applies.
async function maybeRestoreGreenClaimRegression({
  run,
  task,
  attempt,
  report,
}: {
  run: RunState;
  task: WorkerTask;
  attempt: WorkerAttempt;
  report: WorkerReport;
}): Promise<{ run: RunState; restoreFailed: boolean } | null> {
  const green = run.greenClaims;
  if (!green) return null;
  const regressedKeys: string[] = [];
  const regressedClaims: string[] = [];
  for (const claim of report.verifier?.atomicClaims ?? []) {
    if (claim.verdict !== "failed") continue;
    const key = normalizeClaimKey(claim.claim);
    if (green[key]) {
      regressedKeys.push(key);
      regressedClaims.push(claim.claim.trim());
    }
  }
  if (regressedKeys.length === 0) return null;

  // Latest impl pre-worker snapshot that predates the regressing change.
  let restoredSha: string | null = null;
  for (let i = run.workerAttempts.length - 1; i >= 0; i--) {
    const sha = run.workerAttempts[i].preWorkerCheckpointSha;
    if (sha) {
      restoredSha = sha;
      break;
    }
  }
  const cwd = workspaceCwdFromRun(run);
  if (!restoredSha || !cwd) {
    // Nothing to restore to (non-git workspace or no prior snapshot). Still drop
    // the stale green entries below so the regression isn't silently retained.
    const unavailable = await commitRunChange(run, {
      type: "autopilot.green_claim_regression_detected",
      stepId: task.stepId,
      workerTaskId: task.id,
      message: `Detected regression on ${regressedKeys.length} previously-verified claim(s); no pre-worker snapshot available to restore`,
      payload: { claims: regressedClaims, attemptId: attempt.id },
      mutate: (draft, timestamp) => {
        if (draft.greenClaims) {
          for (const key of regressedKeys) delete draft.greenClaims[key];
        }
        draft.updatedAt = timestamp;
      },
    });
    return { run: unavailable, restoreFailed: false };
  }

  try {
    await restoreCheckpointCode({ cwd, sha: restoredSha });
  } catch (error) {
    const restoreError = error instanceof Error ? error.message : String(error);
    const failed = await commitRunChange(run, {
      type: "autopilot.green_claim_regression_restore_failed",
      stepId: task.stepId,
      workerTaskId: task.id,
      message: `Detected regression on ${regressedKeys.length} previously-verified claim(s), but the pre-worker snapshot could not be restored`,
      payload: {
        claims: regressedClaims,
        restoredSha,
        attemptId: attempt.id,
        error: restoreError,
      },
      mutate: (draft, timestamp) => {
        if (draft.greenClaims) {
          for (const key of regressedKeys) delete draft.greenClaims[key];
        }
        draft.status = "paused";
        draft.autopilot = {
          ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
          status: "paused",
          lastAction: "green_claim_regression_restore_failed",
          stopReason: `Regression restore failed: ${restoreError}`,
          pausedAt: timestamp,
          updatedAt: timestamp,
        };
        draft.updatedAt = timestamp;
      },
    });
    return { run: failed, restoreFailed: true };
  }
  for (const claim of regressedClaims) {
    await appendRegressionRevertEvent({
      workspaceId: run.workspaceId,
      runId: run.id,
      stepId: task.stepId,
      workerTaskId: task.id,
      attemptId: attempt.id,
      claim,
      restoredSha,
    });
  }
  // Drop the reverted claims from the green map so the next attempt re-verifies
  // and re-establishes green against the restored tree.
  const reverted = await commitRunChange(run, {
    type: "autopilot.green_claim_regression_reverted",
    stepId: task.stepId,
    workerTaskId: task.id,
    message: `Reverted regression on ${regressedKeys.length} previously-verified claim(s) to pre-worker snapshot`,
    payload: { claims: regressedClaims, restoredSha, attemptId: attempt.id },
    mutate: (draft, timestamp) => {
      if (draft.greenClaims) {
        for (const key of regressedKeys) delete draft.greenClaims[key];
      }
      draft.updatedAt = timestamp;
    },
  });
  return { run: reverted, restoreFailed: false };
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

function fallbackModelHintForRuntime(
  runtime: WorkerRuntime,
  previousModelHint?: string,
): string | undefined {
  const prior = previousModelHint?.trim().toLowerCase() ?? "";
  // Preserve the manager's intended price/speed tier across providers. A
  // Terra verifier failing to launch should become Sonnet, not silently jump
  // to Opus; likewise Sonnet should become Terra. Unknown/top-tier hints keep
  // the conservative flagship fallback.
  if (runtime === "claude") {
    if (prior.includes("luna") || prior.includes("haiku")) return "claude-haiku-4-5";
    if (prior.includes("terra") || prior.includes("sonnet")) return "claude-sonnet-5";
    return "claude-opus-4-8";
  }
  if (runtime === "codex") {
    if (prior.includes("haiku") || prior.includes("luna")) return CODEX_MODEL_BY_TIER.cheap;
    if (prior.includes("sonnet") || prior.includes("terra")) return CODEX_MODEL_BY_TIER.mid;
    return CODEX_MODEL_BY_TIER.top;
  }
  return undefined;
}

function fallbackEffortHintForRuntime(
  runtime: WorkerRuntime,
  prior: WorkerTask["effortHint"],
): WorkerTask["effortHint"] {
  if (runtime === "codex") {
    if (
      prior === "low" ||
      prior === "medium" ||
      prior === "high" ||
      prior === "xhigh" ||
      prior === "max"
    ) return prior;
    return "xhigh";
  }
  if (runtime === "claude") {
    if (prior === "low" || prior === "medium" || prior === "high" || prior === "max") return prior;
    return "high";
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
  run.sparkCalls ??= [];
  run.conversationEpoch ??= 0;
  if (run.whiteboard) {
    const normalizedNodes: CoraWhiteboardNode[] = [];
    for (const node of run.whiteboard.nodes ?? []) {
      try {
        normalizedNodes.push(normalizeWhiteboardNode(node));
      } catch {
        /* discard malformed legacy/external nodes instead of losing the run */
      }
    }
    const nodes = normalizedNodes.slice(0, WHITEBOARD_MAX_NODES);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges: CoraWhiteboardEdge[] = [];
    for (const edge of run.whiteboard.edges ?? []) {
      try {
        const normalized = normalizeWhiteboardEdge(edge);
        if (nodeIds.has(normalized.from) && nodeIds.has(normalized.to)) edges.push(normalized);
      } catch {
        /* discard malformed legacy/external edges */
      }
    }
    run.whiteboard = {
      version: 1,
      revision: Math.max(0, Math.floor(run.whiteboard.revision ?? 0)),
      lastEditedBy:
        run.whiteboard.lastEditedBy === "user" ||
        run.whiteboard.lastEditedBy === "import" ||
        run.whiteboard.lastEditedBy === "cora"
          ? run.whiteboard.lastEditedBy
          : "cora",
      title: sanitizeWhiteboardText(run.whiteboard.title, 100) || "Cora whiteboard",
      summary: sanitizeWhiteboardText(run.whiteboard.summary, 700) || undefined,
      nodes,
      edges: edges.slice(0, WHITEBOARD_MAX_EDGES),
      updatedAt: run.whiteboard.updatedAt || run.updatedAt,
    };
  }
  const seenAssumptionSignatures = new Set<string>();
  run.assumptions = (run.assumptions ?? []).filter((assumption) => {
    if (!assumption?.question?.trim() || !assumption.selectedAnswer?.trim()) return false;
    assumption.signature ??= normalizeRunQuestionSignature(assumption.question);
    assumption.conversationEpoch ??= 0;
    if (!assumption.signature || seenAssumptionSignatures.has(assumption.signature)) return false;
    seenAssumptionSignatures.add(assumption.signature);
    return true;
  });
  const migrateLegacyDirectLoomNotes =
    run.executionMode === "direct" &&
    Boolean(run.automationId) &&
    run.status === "blocked" &&
    !run.blockedOn &&
    run.humanMessages.some(
      (message) =>
        message.author === "spark" &&
        message.kind === "question" &&
        Boolean(message.loomNodeId),
    );
  run.humanMessages = normalizeHumanRunQuestionMessages(run.humanMessages, {
    migrateLegacyDirectLoomNotes,
  });
  for (const message of run.humanMessages) {
    const legacyMessage = message.conversationEpoch === undefined;
    message.attachments ??= [];
    message.conversationEpoch ??= 0;
    message.intent ??=
      message.author === "user" && message.kind !== "answer"
        ? "turn"
        : "answer";
    // Legacy inputs predate durable turn ownership and were already consumed;
    // never queue them for redelivery merely because the app upgraded.
    message.deliveryState ??= legacyMessage
      ? "acknowledged"
      : message.author === "user"
        ? "queued"
        : "acknowledged";
    if (message.author === "spark" && message.kind === "question") {
      message.questionOptions = normalizeQuestionOptionsForMessage(
        message.message,
        message.questionOptions,
      );
    } else {
      delete message.questionOptions;
      delete message.questionContext;
    }
  }
  for (const call of run.sparkCalls) {
    call.inputMessageIds ??= [];
    call.conversationEpoch ??= 0;
  }
  for (const step of run.steps ?? []) {
    step.plannedAgents ??= [];
  }
  // Repair runs written by the verifier-feedback fast path before it learned
  // to close a standalone verifier step. The verifier did finish and its task
  // was accepted; only the step status was stranded at `reviewing`.
  reconcileAcceptedVerifierOnlySteps(run);
  run.autopilot ??= {
    status: run.status === "running" ? "running" : "idle",
    updatedAt: run.updatedAt,
  };
  // A blocker owns only an actively blocked run. Old pause/cancel/status files
  // sometimes retained it and could resurrect the pre-pause status on answer.
  if (run.status !== "blocked") delete run.blockedOn;
  // Backfill the pre-state-machine resume shape. A malformed launching lease
  // cannot be safely identified after restart, so recover it as pending.
  if (run.pendingManagerResume) {
    const pending = run.pendingManagerResume;
    if (pending.state !== "launching" || !pending.launchClaimId?.trim()) {
      pending.state = "pending";
      delete pending.launchClaimId;
      delete pending.launchClaimedAt;
    }
  }
  if (
    run.executionMode === "direct" ||
    run.status === "blocked" ||
    run.status === "paused" ||
    isTerminalRunStatus(run.status)
  ) {
    delete run.pendingManagerResume;
  }
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
  // turn teal the first time Codara restarts.
  if (run.seen === undefined) {
    run.seen = run.status === "complete" ? true : false;
  }
  // Backfill cost rollups on load so runs persisted before the cost-tracking
  // big bet landed pick up a totalCostUsd on the next read. Cheap (O(calls))
  // and avoids special-casing the renderer for legacy run.json files.
  recomputeRunCostRollups(run);
  return run;
}

/**
 * Sum every priced SparkCall on a run and stamp `totalCostUsd` on the run
 * record (always) and each step record that owns at least one priced call.
 * Calls without a `costUsd` field contribute nothing; the rollup only writes
 * a number when at least one call had one — leaves the field undefined
 * otherwise so the UI can keep its "no data" path distinct from "$0.00".
 */
function recomputeRunCostRollups(run: RunState): void {
  let runTotal = 0;
  let runHasAny = false;
  const stepTotals = new Map<string, number>();
  const stepHasAny = new Set<string>();
  for (const call of run.sparkCalls ?? []) {
    const cost = typeof call.costUsd === "number" && Number.isFinite(call.costUsd) ? call.costUsd : null;
    if (cost === null) continue;
    runTotal += cost;
    runHasAny = true;
    if (call.stepId) {
      stepTotals.set(call.stepId, (stepTotals.get(call.stepId) ?? 0) + cost);
      stepHasAny.add(call.stepId);
    }
  }
  if (runHasAny) {
    run.totalCostUsd = roundCost(runTotal);
  } else {
    delete run.totalCostUsd;
  }
  for (const step of run.steps ?? []) {
    if (stepHasAny.has(step.id)) {
      step.totalCostUsd = roundCost(stepTotals.get(step.id) ?? 0);
    } else {
      delete step.totalCostUsd;
    }
  }

  // Worker-side cost estimate (separate from the priced manager SparkCalls
  // above). Live per-token usage from the Claude Code / Codex CLIs isn't
  // ingested yet, so we can only multiply the price table by conservative,
  // hardcoded token guesses per terminal attempt. These two constants are
  // PLACEHOLDERS — replace them with measured input/output token counts once
  // the worker-usage pipeline lands. Until then `estimatedWorkerCostUsd` is a
  // directional figure for the CostPill split, not billed truth.
  const estimatedInputTokens = 12_000;
  const estimatedOutputTokens = 4_000;
  const tasksById = new Map<string, WorkerTask>();
  for (const task of run.workerTasks ?? []) {
    tasksById.set(task.id, task);
  }
  let runWorkerTotal = 0;
  for (const attempt of run.workerAttempts ?? []) {
    // Only count attempts that actually finished — `finishedAt` is set in
    // lockstep with the terminal attempt statuses below, so a missing
    // timestamp means the attempt is still in flight and has no cost yet.
    if (!attempt.finishedAt) continue;
    if (
      attempt.status !== "succeeded" &&
      attempt.status !== "failed" &&
      attempt.status !== "timed_out" &&
      attempt.status !== "cancelled"
    ) {
      continue;
    }
    const owningTask = tasksById.get(attempt.workerTaskId);
    // The attempt carries the runtime that actually ran; the model hint only
    // lives on the owning task. Fall back to the task's runtime preference if
    // the attempt somehow lacks one.
    const runtime = attempt.runtime ?? owningTask?.runtimePreference;
    if (!runtime) continue;
    runWorkerTotal += estimateWorkerCostUsd({
      runtime,
      modelHint: owningTask?.modelHint,
      estimatedInputTokens,
      estimatedOutputTokens,
    });
  }
  if (runWorkerTotal > 0) {
    run.estimatedWorkerCostUsd = roundCost(runWorkerTotal);
  } else {
    delete run.estimatedWorkerCostUsd;
  }
}

function roundCost(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function commitRunChange(
  run: RunState,
  change: {
    type: string;
    message: string;
    stepId?: string;
    workerTaskId?: string;
    payload?: Record<string, unknown>;
    sparkCallId?: string;
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
      assertManagerDecisionMutationCurrent(latest.id);
      // The cached run supplied by the caller may be stale by the time this
      // serialized mutation starts. Capture lifecycle ownership only here, from
      // the authoritative queue head, so previousStatus and blocker metadata
      // describe the transition that actually persisted.
      prevStatus = latest.status;
      const previousBlocker = latest.blockedOn ? { ...latest.blockedOn } : undefined;
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

      const domainEventId = makeId("evt");
      const domainType =
        change.type === "run.status_updated" ? "run.status_change_requested" : change.type;
      const events: Parameters<typeof appendEvents>[0] = [
        {
          id: domainEventId,
          timestamp,
          workspaceId: latest.workspaceId,
          runId: latest.id,
          stepId: change.stepId,
          workerTaskId: change.workerTaskId,
          sparkCallId: change.sparkCallId,
          type: domainType,
          message: change.message,
          payload: change.payload,
        },
      ];

      const openQuestion =
        latest.status === "blocked" ? resolveOpenRunQuestionPure(latest) : undefined;
      const lifecycleEvent = buildRunStatusTransitionEvent({
        run: latest,
        previousStatus: prevStatus,
        previousBlocker,
        openQuestionMessageId: openQuestion?.id,
        timestamp,
        causeType: domainType,
        causeEventId: domainEventId,
        causeMessage: change.message,
        eventId: makeId("evt"),
        stepId: change.stepId,
        workerTaskId: change.workerTaskId,
        sparkCallId: change.sparkCallId,
      });
      if (lifecycleEvent) events.push(lifecycleEvent);

      // Domain + lifecycle are one event-log batch. appendEvents serializes every
      // same-run writer, persists both lines, then broadcasts in the identical
      // sequence, so a direct append cannot split cause from transition.
      await appendEvents(events);
      nextStatus = latest.status;
      persisted = true;
    });
  runMutationQueues.set(run.id, next);
  try {
    await next;
  } finally {
    if (runMutationQueues.get(run.id) === next) runMutationQueues.delete(run.id);
  }
  if (persisted && prevStatus !== "complete" && nextStatus === "complete") {
    try {
      const completedRun = result ?? (await requireRun(run.id));
      const manifest = await collectRunResultManifest(completedRun, workerArtifactPaths);
      await fs.mkdir(completedRun.artifactDir, { recursive: true });
      await writeFileAtomic(
        join(completedRun.artifactDir, "result-manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      result = await commitRunChange(completedRun, {
        type: "run.result_manifest_persisted",
        message: "Persisted evidence-backed run result manifest",
        payload: {
          files: manifest.workspaceDelta.length,
          checks: manifest.checks.length,
          evidence: manifest.evidence.length,
          workspaceMode: manifest.workspace.mode,
        },
        mutate: (draft, timestamp) => {
          draft.resultManifest = manifest;
          draft.updatedAt = timestamp;
        },
      });
    } catch (err) {
      console.error("[run-store] failed to collect result manifest", err);
    }
    try {
      result = await appendCompletionSummaryMessage(run.id);
    } catch (err) {
      console.error("[run-store] failed to append completion summary", err);
    }
    // Distill + persist this freshly-completed run into the per-workspace
    // orchestration memory ledger. Best-effort: recordRunMemory is itself
    // non-throwing, but a stray write failure must never break the completion
    // path, so it stays wrapped. Pass readWorkerReport so run-memory.ts can
    // resolve worker reports without importing run-store (no cycle).
    try {
      const completedRun = result ?? (await requireRun(run.id));
      await recordRunMemory(completedRun, readWorkerReport);
    } catch (err) {
      console.error("[run-store] failed to record run memory", err);
    }
  }
  return result ?? (await requireRun(run.id));
}

async function appendCompletionSummaryMessage(runId: string): Promise<RunState> {
  const run = await requireRun(runId);
  if (run.status !== "complete") return run;
  // Chat-only runs (no steps, no worker tasks) already showed their answer in
  // the chatReply Cora bubble. A separate "Run complete / Codara answered the
  // chat." turn would just repeat that. The renderer paints a tiny "done"
  // marker under the last Cora bubble instead.
  if (run.steps.length === 0 && run.workerTasks.length === 0) return run;
  const completedAt = run.completedAt ?? run.updatedAt;
  const completedAtMs = Date.parse(completedAt);
  // If the manager already posted a chatReply note for this completion turn,
  // suppress the templated summary entirely — one Cora bubble per turn is the
  // goal. The chatReply is emitted as spark/note by applySparkManagerDecision
  // just before the run flips to complete, so a spark/note whose createdAt is
  // at-or-after completedAt (with a small grace window for clock skew) is the
  // user-facing answer; the auto-summary would just duplicate it.
  const lastMessage = run.humanMessages[run.humanMessages.length - 1];
  if (lastMessage && lastMessage.author === "spark" && lastMessage.kind === "note") {
    const lastMs = Date.parse(lastMessage.createdAt);
    if (
      Number.isFinite(lastMs) &&
      Number.isFinite(completedAtMs) &&
      lastMs >= completedAtMs - 5_000
    ) {
      return run;
    }
  }
  const alreadyAppended = run.humanMessages.some((message) => {
    if (message.author !== "spark" || message.kind !== "decision") return false;
    const messageAt = Date.parse(message.createdAt);
    if (Number.isFinite(completedAtMs) && Number.isFinite(messageAt)) {
      return messageAt >= completedAtMs;
    }
    return message.message.startsWith(COMPLETION_SUMMARY_PREFIX);
  });
  if (alreadyAppended) return run;

  const message = await buildCompletionSummaryMessage(
    run,
    workerArtifactPaths,
    run.resultManifest,
  );
  return addRunMessage({
    runId: run.id,
    author: "spark",
    kind: "decision",
    message,
  });
}

function changedFields(input: object, excluded: string[]): string[] {
  const values = input as Record<string, unknown>;
  return Object.keys(values).filter((key) => !excluded.includes(key) && values[key] !== undefined);
}

function isTerminalStepStatus(status: StepState["status"]): boolean {
  return (
    status === "complete" ||
    status === "completed_unverified" ||
    status === "failed" ||
    status === "skipped"
  );
}

function isTerminalRunStatus(status: RunState["status"]): boolean {
  return status === "complete" || status === "failed" || status === "cancelled";
}

function isImmutableStepStatus(status: StepState["status"]): boolean {
  return (
    status === "complete" || status === "completed_unverified" || status === "skipped"
  );
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

// Why pickAutopilotTasks collapsed a would-be parallel batch to a single serial
// task. Only `no_concrete_scope` (a task that wants to run parallel but has no
// concrete write scope — exactly the fan-out anti-pattern) is surfaced to the
// launch site as a fanout.downgraded_to_serial event; `not_parallel` (the
// manager deliberately marked the task serial) is normal and not reported.
type SerialDowngradeReason = "no_concrete_scope" | "not_parallel";

// Pure selector with the downgrade reason exposed. pickAutopilotTasks wraps this
// and discards the reason so its existing call sites keep their WorkerTask[]
// semantics; only the launch site reads `downgrade` to emit an observability
// event. Selection behaviour is byte-for-byte identical to the prior body.
function pickAutopilotTasksWithReason(run: RunState): {
  tasks: WorkerTask[];
  downgrade: { task: WorkerTask; reason: SerialDowngradeReason } | null;
} {
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
  if (candidates.length === 0) return { tasks: [], downgrade: null };

  const cap = evalMaxParallelWorkers();
  const first = candidates[0];
  if (!first.canRunParallel) return { tasks: [first], downgrade: { task: first, reason: "not_parallel" } };
  if (!hasConcreteParallelScope(first)) {
    return { tasks: [first], downgrade: { task: first, reason: "no_concrete_scope" } };
  }

  const parallelCandidates = candidates.filter(
    (task) => task.canRunParallel && hasConcreteParallelScope(task),
  );
  const selected = selectLargestCompatibleWave(parallelCandidates, {
    cap,
    conflicts: tasksConflictForParallelLaunch,
  });
  return selected.length > 0 ? { tasks: selected, downgrade: null } : { tasks: [first], downgrade: null };
}

function pickAutopilotTasks(run: RunState): WorkerTask[] {
  return pickAutopilotTasksWithReason(run).tasks;
}

// Emit the fan-out serial-downgrade observability event at the real launch
// site, exactly once per (run, task). Called only where attempts are actually
// materialized — pickAutopilotTasks itself stays pure (it runs every tick).
async function maybeEmitFanOutDowngrade(run: RunState): Promise<void> {
  const { downgrade } = pickAutopilotTasksWithReason(run);
  if (!downgrade || downgrade.reason !== "no_concrete_scope") return;
  const guardKey = `${run.id}:${downgrade.task.id}`;
  if (emittedFanOutDowngrades.has(guardKey)) return;
  emittedFanOutDowngrades.add(guardKey);
  await appendFanOutDowngradedEvent({
    workspaceId: run.workspaceId,
    runId: run.id,
    stepId: downgrade.task.stepId,
    workerTaskId: downgrade.task.id,
    taskTitle: downgrade.task.title,
    reason: "no_concrete_scope",
  });
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
  context?: {
    category?: RunQuestionCategory;
    reason?: string;
    managerMode?: SparkCall["mode"];
    backendTurnId?: string;
    conversationEpoch?: number;
  },
): Promise<RunState> {
  const posted = await postRunQuestion({
    runId,
    message,
    questionOptions: options,
    category: context?.category,
    reason: context?.reason,
    source: "manager_decision",
    resumeStrategy: "schedule_manager",
    managerMode: context?.managerMode,
    backendTurnId: context?.backendTurnId,
    conversationEpoch: context?.conversationEpoch,
  });
  return posted.run;
}

function normalizeQuestionOptionsForMessage(
  question: string,
  options: SparkManagerQuestionOption[] | undefined,
): SparkManagerQuestionOption[] {
  const normalized = (options ?? [])
    .slice(0, 4)
    .map((option, index) => ({
      id: option.id?.trim() || `option_${index + 1}`,
      label: option.label?.trim() || `Option ${index + 1}`,
      description: option.description?.trim() || option.answer?.trim() || option.label?.trim() || "",
      answer: option.answer?.trim() || option.label?.trim() || "",
      recommended: option.recommended === true,
    }))
    .filter((option) => option.label && option.answer);
  if (normalized.length >= 2) {
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

// Hook RPC handoff (big-bet "Hook contract for sub-agents to self-report").
// Called from hook-rpc.ts when a worker POSTs to /state. The paneId is the
// PTY session id, which Codara uses interchangeably with attemptId for active
// workers — see ActiveWorkerProcess.attemptId + how pty-manager keys sessions
// by opts.id. We:
//   1. find the ActiveWorkerProcess by paneId,
//   2. de-dup repeat reports of the same state (no event, no spam),
//   3. otherwise mutate in place and append a worker_attempt.state_reported
//      event so the renderer can react (or a future Session Inspector tab
//      can replay the timeline).
//
// Tolerates an unknown paneId quietly — a worker spawned outside Codara's
// orchestration loop (e.g. a user-launched claude pane that picked up the
// env vars) is allowed to call us, but if we don't have an ActiveWorkerProcess
// to attach the state to we just drop the report. This matches the doc's
// "hook wins when present" rule: if there's no worker to update, there's
// nothing to win.
export function applyHookStateReport(report: {
  paneId: string;
  state: WorkerRuntimeState;
  note?: string;
}): void {
  const worker = activeWorkerProcesses.get(report.paneId);
  if (!worker) return;

  // De-dup: identical state + note as the last report on the
  // ActiveWorkerProcess is a no-op for THAT object's event stream — workers
  // often re-emit the same state on every tool call ("still working") and we
  // don't want to flood worker_attempt.state_reported. We still bridge to
  // WorkerAttempt unconditionally below so the renderer side recovers even
  // if regex briefly overwrote a value the hook had previously claimed.
  const sameState = worker.runtimeState === report.state;
  const sameNote = (worker.runtimeStateNote ?? undefined) === (report.note ?? undefined);
  const skipWorkerEvent = sameState && sameNote;

  const previousState = worker.runtimeState;
  const timestamp = new Date().toISOString();
  worker.runtimeState = report.state;
  worker.runtimeStateNote = report.note;
  worker.runtimeStateAt = timestamp;

  // Bridge to WorkerAttempt so the renderer (which reads
  // WorkerAttempt.runtimeState via timeline.ts → ChatConversation.tsx) sees
  // hook reports too — without this, only the regex tail poller can move
  // the chip. WorkerRuntimeState and RuntimeState are the same union so
  // the value passes through; runtimeStateSource = "hook" tells
  // reportTerminalState to skip its next regex tick for HOOK_TRUST_MS.
  // Best-effort: if the attempt isn't in the cache (run not yet loaded)
  // we still updated ActiveWorkerProcess above; the next poller tick will
  // hydrate the cache and the next hook report will land cleanly.
  //
  // Note: this runs even when skipWorkerEvent is true, because the regex
  // detector may have stomped on a previous hook value between dedupes —
  // a fresh hook tick of the same "working" must still reclaim the
  // WorkerAttempt slot if regex flipped it to "blocked" in the meantime.
  const match = findAttemptByPaneId(report.paneId);
  if (match) {
    const { run: targetRun, attempt: targetAttempt } = match;
    const attemptStateChanged =
      targetAttempt.runtimeState !== report.state ||
      targetAttempt.runtimeStateSource !== "hook";
    if (attemptStateChanged) {
      const attemptPrevious = targetAttempt.runtimeState ?? null;
      targetAttempt.runtimeState = report.state;
      targetAttempt.runtimeStateUpdatedAt = timestamp;
      targetAttempt.runtimeStateSource = "hook";
      targetRun.updatedAt = timestamp;
      // Same fire-and-forget save pattern reportTerminalState uses — the
      // event below is the authoritative UI trigger, the run.json rewrite
      // is bookkeeping that mustn't block the hook RPC reply.
      void saveRun(targetRun).catch(() => undefined);
      void appendEvent({
        timestamp,
        workspaceId: targetRun.workspaceId,
        runId: targetRun.id,
        workerTaskId: targetAttempt.workerTaskId,
        attemptId: targetAttempt.id,
        type: "worker_attempt.runtime_state_changed",
        message: `Worker attempt runtime state: ${attemptPrevious ?? "unknown"} -> ${report.state}`,
        payload: {
          previous: attemptPrevious,
          state: report.state,
          attemptId: targetAttempt.id,
          source: "hook",
          note: report.note,
        },
      }).catch((err) => {
        console.warn("[run-store] appendEvent for hook attempt state failed:", err);
      });
    } else {
      // No attempt-side change but still refresh the timestamp so the
      // HOOK_TRUST_MS window in reportTerminalState slides forward — that's
      // the whole point of receiving repeat hook reports. No save / no
      // event: nothing observable changed for the renderer.
      targetAttempt.runtimeStateUpdatedAt = timestamp;
    }
  }

  // Bail out of the ActiveWorkerProcess event emit when the hook just
  // re-stated the same value. The renderer-side update above already kept
  // the trust window fresh, so nothing else is needed.
  if (skipWorkerEvent) return;

  // Fire-and-forget event so a subscriber (renderer, Session Inspector,
  // headless eval) can pick up the change. Don't await — the hook RPC must
  // stay responsive even if appendEvent has to fsync a big events.jsonl.
  // The workspaceId is looked up async via getRun so renderer filtering by
  // workspace keeps working; if the run was deleted under us the event is
  // skipped silently.
  void (async () => {
    try {
      const run = await getRun(worker.runId);
      if (!run) return;
      await appendEvent({
        timestamp,
        workspaceId: run.workspaceId,
        runId: worker.runId,
        stepId: worker.stepId,
        workerTaskId: worker.workerTaskId,
        attemptId: worker.attemptId,
        type: "worker_attempt.state_reported",
        message: `Worker self-reported state: ${report.state}`,
        payload: {
          paneId: report.paneId,
          state: report.state,
          previousState,
          note: report.note,
          source: "hook",
        },
      });
    } catch (err) {
      console.warn("[run-store] appendEvent for hook state failed:", err);
    }
  })();
}

// CLI hook ingestion (big-bet "CLI hook ingestion — free observability").
// Sibling to applyHookStateReport above: that one handles state transitions
// (worker says "I'm blocked on a permission prompt"), this one handles
// everything else — tool calls, prompt submissions, compaction, session
// start, etc. — so the Session Inspector tab and Cost-Tracking pill have a
// canonical event log.
//
// The hook-watcher dispatches state-bearing events (Notification, Stop,
// SubagentStop) through applyHookStateReport so the worker's runtimeState
// updates; everything else lands here as a plain event log entry. We:
//   1. look up the ActiveWorkerProcess by paneId so we can stamp the event
//      with runId/stepId/workerTaskId/attemptId (without those, the Session
//      Inspector can't filter the log per-worker);
//   2. if no worker matches, drop quietly — same rule as applyHookStateReport.
//      A future "ambient" hook (claude pane the user spawned themselves with
//      our env vars) can be wired up later if we want it.
//   3. otherwise append a hook.<HookName> event so consumers see the raw
//      payload. We do NOT throttle these — Claude's PreToolUse fires once
//      per tool call which is bursty but bounded.
export function applyHookEvent(input: {
  paneId: string;
  hookName: string;
  payload?: Record<string, unknown> | null;
  // ISO timestamp the hook recorded the event. Falls back to now() if the
  // script's clock disagreed or the wrapper was missing a timestamp.
  timestamp?: string;
  // Optional human-readable summary for logs. Hook-watcher fills this in
  // for the hooks where a short label helps (PreToolUse: tool name, etc.).
  message?: string;
}): void {
  const worker = activeWorkerProcesses.get(input.paneId);
  if (!worker) return;
  const timestamp = input.timestamp ?? new Date().toISOString();
  void (async () => {
    try {
      const run = await getRun(worker.runId);
      if (!run) return;
      await appendEvent({
        timestamp,
        workspaceId: run.workspaceId,
        runId: worker.runId,
        stepId: worker.stepId,
        workerTaskId: worker.workerTaskId,
        attemptId: worker.attemptId,
        type: `hook.${input.hookName}`,
        message: input.message,
        payload: {
          paneId: input.paneId,
          hookName: input.hookName,
          ...(input.payload && typeof input.payload === "object"
            ? { hookPayload: input.payload }
            : {}),
          source: "cli-hook",
        },
      });
    } catch (err) {
      console.warn("[run-store] appendEvent for hook event failed:", err);
    }
  })();
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

// How long (ms) a hook-sourced runtime state is considered authoritative
// over the regex tail poller. The doc rule is "hook reports win over regex
// detection". We implement that as a 5-second trust window: if the worker
// last self-reported via the localhost RPC inside that window, the regex
// poller is gagged. After the window the hook stream is considered stale
// (the agent may have crashed without sending a final state) and the regex
// detector is allowed to take back over.
const HOOK_TRUST_MS = 5_000;

// Find the WorkerAttempt + its parent RunState anywhere in the in-memory
// run cache. paneId === attempt.id for Cora workers (pty-manager keys
// sessions by attemptId). Returns null if no cached run owns that attempt
// — happens for manual user-spawned terminals and for runs that haven't
// been loaded from disk yet. Bounded by RUN_RETENTION_KEEP (~50 cached
// runs × workerAttempts each), so cheap.
function findAttemptByPaneId(
  paneId: string,
): { run: RunState; attempt: WorkerAttempt } | null {
  for (const run of runCache.values()) {
    const attempt = run.workerAttempts.find((item) => item.id === paneId);
    if (attempt) return { run, attempt };
  }
  return null;
}

// Live agent state report from the renderer-side terminal poller. paneId is
// the same id the renderer used for pty:spawn — for Cora workers this is
// the attemptId. We walk the in-memory run cache to find the matching
// attempt, stamp the new state on it, and broadcast a change event so the
// chat UI and notification system can react.
//
// Hot path: this runs every time a worker pane changes state. Reports for
// panes with no matching attempt (manual user-spawned claude/codex panes)
// are silently dropped — the renderer doesn't filter by ownership before
// reporting and we want a single round-trip, not a probe + write.
//
// Hook priority: when the same attempt also has a hook RPC stream
// (applyHookStateReport landed within HOOK_TRUST_MS), the hook wins and
// this regex report is dropped. After the trust window expires the regex
// detector takes back over so a crashed hook doesn't freeze the UI.
export async function reportTerminalState(
  paneId: string,
  state: RuntimeState,
): Promise<void> {
  if (!paneId) return;
  const match = findAttemptByPaneId(paneId);
  if (!match) return;
  const { run: targetRun, attempt: targetAttempt } = match;

  // Hook trumps regex while the hook stream is fresh. We compare against
  // Date.now() (not the new event's timestamp) because runtimeStateUpdatedAt
  // is ISO-encoded; Date.parse round-trips that cleanly.
  if (targetAttempt.runtimeStateSource === "hook" && targetAttempt.runtimeStateUpdatedAt) {
    const lastHookAt = Date.parse(targetAttempt.runtimeStateUpdatedAt);
    if (Number.isFinite(lastHookAt) && Date.now() - lastHookAt < HOOK_TRUST_MS) {
      return;
    }
  }

  // No-op transition. When the value matches we still re-stamp the source
  // and timestamp (for any case where the hook trust window just expired
  // with the same state the regex is now reporting), but emit no event
  // and skip the run.json rewrite — nothing visible changed for the UI.
  if (targetAttempt.runtimeState === state) {
    if (targetAttempt.runtimeStateSource !== "regex") {
      targetAttempt.runtimeStateSource = "regex";
      targetAttempt.runtimeStateUpdatedAt = new Date().toISOString();
    }
    return;
  }

  const timestamp = new Date().toISOString();
  const previous = targetAttempt.runtimeState ?? null;
  targetAttempt.runtimeState = state;
  targetAttempt.runtimeStateUpdatedAt = timestamp;
  targetAttempt.runtimeStateSource = "regex";
  targetRun.updatedAt = timestamp;
  // saveRun re-writes run.json; the cache stays in sync via writeRunFile().
  // We don't await the save before broadcasting — the event below is the
  // authoritative trigger for UI updates, and a slow disk write must not
  // delay the chat indicator flipping.
  void saveRun(targetRun).catch(() => undefined);
  await appendEvent({
    timestamp,
    workspaceId: targetRun.workspaceId,
    runId: targetRun.id,
    workerTaskId: targetAttempt.workerTaskId,
    attemptId: targetAttempt.id,
    type: "worker_attempt.runtime_state_changed",
    message: `Worker attempt runtime state: ${previous ?? "unknown"} -> ${state}`,
    payload: {
      previous,
      state,
      attemptId: targetAttempt.id,
      source: "regex",
    },
  });
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
    agents: runHasMcpManager(run) ? [managerAgentCard(timestamp), ...cards] : cards,
  };
  await writeFileAtomic(paths.peerCommsAgents, JSON.stringify(registry, null, 2));
}

// The manager (the orchestrator that spawned this batch) is a first-class
// mailbox participant under the reserved id "manager". It shows up in `list`
// so workers know they can address it, and it sends/reads via the main-process
// helpers below rather than the on-disk CLI.
const MANAGER_PEER_ID = "manager";

// True only when a live CC/Codex execute- or auto-mode manager drives this run
// — the ONLY flows where anything ever READS the manager inbox (the
// orchestrator.message_workers / check_messages RPCs and the wait_for_workers
// drain). Fan-out, council, loom, and OpenRouter-autopilot parallel batches
// have no manager session, so advertising a `manager` mailbox participant
// there would leave workers awaiting replies that can never come. Keep this
// predicate in sync with isExecuteModeCliManager (worker auto-accept path).
export function runHasMcpManager(run: RunState): boolean {
  return (
    (run.chatBackend === "claude" || run.chatBackend === "codex" || run.chatBackend === "pi") &&
    (run.chatMode === "execute" || run.chatMode === "auto")
  );
}

function managerAgentCard(timestamp: string): PeerCommsAgentCard {
  return {
    workerTaskId: MANAGER_PEER_ID,
    title: "Cora manager (orchestrator)",
    runtime: "claude",
    status: "running",
    canRunParallel: true,
    allowedPaths: [],
    forbiddenPaths: [],
    expectedOutputs: [],
    updatedAt: timestamp,
  };
}

interface PeerCommsMessage {
  id: string;
  createdAt: string;
  from: string;
  to: string | string[];
  subject: string;
  body: string;
  replyTo: string | null;
  readBy: string[];
}

function peerCommsRunPaths(runId: string): {
  dir: string;
  messagesDir: string;
  script: string;
  agents: string;
} {
  const dir = join(runDir(runId), "peer-comms");
  return {
    dir,
    messagesDir: join(dir, "messages"),
    script: join(dir, "spark-peer-comms.cjs"),
    agents: join(dir, "agents.json"),
  };
}

// Mirror the id + shape the on-disk peer-comms CLI produces so the manager's
// writes are indistinguishable from a worker's and interoperate on the same
// message files (see peer-comms-script.ts messageId()).
function peerCommsMessageId(): string {
  return "msg-" + Date.now().toString(36) + "-" + randomBytes(4).toString("hex");
}

async function readPeerCommsMessages(messagesDir: string): Promise<PeerCommsMessage[]> {
  let names: string[];
  try {
    names = (await fs.readdir(messagesDir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const messages: PeerCommsMessage[] = [];
  for (const name of names) {
    try {
      const raw = await fs.readFile(join(messagesDir, name), "utf8");
      const parsed = JSON.parse(raw) as PeerCommsMessage;
      if (parsed && typeof parsed.id === "string") messages.push(parsed);
    } catch {
      /* skip malformed / partially-written files */
    }
  }
  return messages.sort((a, b) =>
    String(a.createdAt || "").localeCompare(String(b.createdAt || "")),
  );
}

// Write a message from the reserved "manager" id into the run's peer-comms
// mailbox. Ensures the peer-comms artifacts exist first (dir + helper script)
// so a manager can reach workers even before a worker has read its own inbox.
export async function sendManagerMessage(
  runId: string,
  to: string,
  subject: string,
  body: string,
): Promise<{ id: string }> {
  await requireRun(runId);
  const trimmedTo = to.trim();
  if (!trimmedTo) throw new Error("message recipient (to) is required");
  if (!body.trim()) throw new Error("message body is required");
  const paths = peerCommsRunPaths(runId);
  await fs.mkdir(paths.messagesDir, { recursive: true });
  // Best-effort: keep the on-disk CLI available for workers that want to reply.
  await writeFileAtomic(paths.script, PEER_COMMS_HELPER_SCRIPT).catch(() => undefined);
  const message: PeerCommsMessage = {
    id: peerCommsMessageId(),
    createdAt: new Date().toISOString(),
    from: MANAGER_PEER_ID,
    to: trimmedTo,
    subject: subject ?? "",
    body,
    replyTo: null,
    readBy: [],
  };
  await writeFileAtomic(
    join(paths.messagesDir, message.id + ".json"),
    JSON.stringify(message, null, 2),
  );
  return { id: message.id };
}

// Read messages addressed to the manager: anything sent directly `--to manager`
// plus worker broadcasts to `all` (the manager never reads its own broadcasts).
// When markRead, appends "manager" to each returned message's readBy so a
// subsequent check does not re-surface it.
export async function readManagerInbox(
  runId: string,
  opts?: { markRead?: boolean },
): Promise<PeerCommsMessage[]> {
  await requireRun(runId);
  const paths = peerCommsRunPaths(runId);
  const messages = await readPeerCommsMessages(paths.messagesDir);
  const inbox = messages.filter((message) => {
    if (message.from === MANAGER_PEER_ID) return false;
    const readBy = Array.isArray(message.readBy) ? message.readBy : [];
    if (readBy.includes(MANAGER_PEER_ID)) return false;
    const target = message.to;
    if (target === MANAGER_PEER_ID || target === "all") return true;
    return Array.isArray(target) && target.includes(MANAGER_PEER_ID);
  });
  if (opts?.markRead) {
    for (const message of inbox) {
      const readBy = Array.isArray(message.readBy) ? message.readBy : [];
      if (readBy.includes(MANAGER_PEER_ID)) continue;
      message.readBy = [...readBy, MANAGER_PEER_ID];
      await writeFileAtomic(
        join(paths.messagesDir, message.id + ".json"),
        JSON.stringify(message, null, 2),
      ).catch(() => undefined);
    }
  }
  return inbox;
}

// ── Peer-traffic observability ──────────────────────────────────────────────
// While a parallel batch is live, watch the run's peer-comms messages dir and
// surface each new message file as a lightweight `peer_message.sent` event
// (from/to/subject only) so Cora and the event log can see worker-to-worker
// traffic that never crosses the manager inbox. Ref-counted per run: the
// first peer-comms worker launch opens the watcher, the last active one
// closes it. Everything here is best-effort — observability must never block
// or fail a run.

interface PeerCommsWatchState {
  watcher: FSWatcher;
  refs: number;
  seen: Set<string>;
  timer: NodeJS.Timeout | null;
  scanning: boolean;
  workspaceId: string;
}

const peerCommsWatchers = new Map<string, PeerCommsWatchState>();

// In-flight watcher creations keyed by run id. Reserved SYNCHRONOUSLY before
// the first await in acquirePeerCommsWatcher so concurrent worker launches of
// the same batch share one creation instead of racing through the mkdir/readdir
// window — the losing racer would leak an unclosed FSWatcher and leave refs=1
// for two holders, closing the survivor when the first worker finished.
const peerCommsWatcherCreations = new Map<string, Promise<boolean>>();

// Returns true when a reference was actually taken. Callers must pair
// releasePeerCommsWatcher ONLY with a `true` result — releasing after a failed
// acquire would decrement a sibling's refcount and close the shared watcher
// mid-batch. Deliberately not `async`: the refs fast path and the creation
// reservation must both happen in the same synchronous tick.
function acquirePeerCommsWatcher(run: RunState): Promise<boolean> {
  const existing = peerCommsWatchers.get(run.id);
  if (existing && existing.refs > 0) {
    existing.refs += 1;
    return Promise.resolve(true);
  }
  const inFlight = peerCommsWatcherCreations.get(run.id);
  if (inFlight) {
    return inFlight.then((created) => {
      const state = peerCommsWatchers.get(run.id);
      if (created && state && state.refs > 0) {
        state.refs += 1;
        return true;
      }
      // The shared creation failed or was fully released before we got our
      // reference — retry from the top and create our own watcher.
      return acquirePeerCommsWatcher(run);
    });
  }
  const creation = createPeerCommsWatcher(run)
    .then(() => true)
    .catch(() => false);
  peerCommsWatcherCreations.set(run.id, creation);
  void creation.finally(() => {
    peerCommsWatcherCreations.delete(run.id);
  });
  return creation;
}

// Builds and registers the watcher state with refs=1 for the reserving caller.
// Only ever one in flight per run id (guarded by peerCommsWatcherCreations).
async function createPeerCommsWatcher(run: RunState): Promise<void> {
  const stale = peerCommsWatchers.get(run.id);
  if (stale) {
    // Stale entry from a release whose final sweep has not finished; its
    // watcher is already closed, so replace it rather than reuse it.
    try { stale.watcher.close(); } catch { /* already closed */ }
    peerCommsWatchers.delete(run.id);
  }
  const { messagesDir } = peerCommsRunPaths(run.id);
  await fs.mkdir(messagesDir, { recursive: true });
  // The mailbox dir is per-run, so earlier batches' traffic is already on
  // disk — prime `seen` so only new messages are announced.
  const seen = new Set<string>(await fs.readdir(messagesDir).catch(() => [] as string[]));
  const state: PeerCommsWatchState = {
    watcher: watch(messagesDir, () => schedulePeerCommsScan(run.id)),
    refs: 1,
    seen,
    timer: null,
    scanning: false,
    workspaceId: run.workspaceId,
  };
  state.watcher.on("error", () => {
    try { state.watcher.close(); } catch { /* already closed */ }
    peerCommsWatchers.delete(run.id);
  });
  peerCommsWatchers.set(run.id, state);
}

function releasePeerCommsWatcher(runId: string): void {
  const state = peerCommsWatchers.get(runId);
  if (!state) return;
  state.refs -= 1;
  if (state.refs > 0) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  try { state.watcher.close(); } catch { /* already closed */ }
  // One last sweep so messages written inside the final debounce window still
  // reach the event log, then drop the entry.
  void scanPeerCommsMessages(runId)
    .catch(() => undefined)
    .finally(() => {
      const current = peerCommsWatchers.get(runId);
      if (current === state) peerCommsWatchers.delete(runId);
    });
}

function schedulePeerCommsScan(runId: string): void {
  const state = peerCommsWatchers.get(runId);
  if (!state || state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void scanPeerCommsMessages(runId).catch(() => undefined);
  }, 300);
  state.timer.unref();
}

async function scanPeerCommsMessages(runId: string): Promise<void> {
  const state = peerCommsWatchers.get(runId);
  if (!state || state.scanning) return;
  state.scanning = true;
  try {
    const { messagesDir } = peerCommsRunPaths(runId);
    const names = (await fs.readdir(messagesDir).catch(() => [] as string[])).filter((name) =>
      name.endsWith(".json"),
    );
    for (const name of names) {
      if (state.seen.has(name)) continue;
      state.seen.add(name);
      let message: PeerCommsMessage | null = null;
      try {
        message = JSON.parse(await fs.readFile(join(messagesDir, name), "utf8")) as PeerCommsMessage;
      } catch {
        // Partially-written file — retry on the next watch event.
        state.seen.delete(name);
        continue;
      }
      if (!message || typeof message.id !== "string" || typeof message.from !== "string") continue;
      const to = Array.isArray(message.to) ? message.to.join(", ") : String(message.to ?? "");
      await appendEvent({
        workspaceId: state.workspaceId,
        runId,
        type: "peer_message.sent",
        message: `Peer message: ${message.from} -> ${to}`,
        payload: {
          from: message.from,
          to: message.to,
          subject: piWorkerSafeText(message.subject, 160),
          messageId: message.id,
        },
      }).catch(() => undefined);
    }
  } finally {
    state.scanning = false;
  }
}

// Loom iterations are unattended jobs, so they use the same structured
// transports as Cora itself: Claude Agent SDK or Codex App Server. Ordinary
// Cora implementation workers deliberately stay on the visible PTY path below
// so the user can watch and interact with their real CLI UI.
async function runStructuredAutomationWorkerSession({
  run,
  task,
  attemptId,
  paths,
  cwd,
  promptText,
  command,
  sandboxed,
  extraWritableDirs,
}: {
  run: RunState;
  task: WorkerTask;
  attemptId: string;
  paths: WorkerArtifactPaths;
  cwd: string;
  promptText: string;
  command: string;
  sandboxed: boolean;
  extraWritableDirs: string[];
}): Promise<{ exitCode: number; error?: string }> {
  const runningTimestamp = new Date().toISOString();
  await markAttemptRunning(run.id, task.id, attemptId, runningTimestamp);
  const transport = task.runtimePreference === "claude" ? "agent-sdk" : "app-server";
  await appendEvent({
    timestamp: runningTimestamp,
    workspaceId: run.workspaceId,
    runId: run.id,
    stepId: task.stepId,
    workerTaskId: task.id,
    attemptId,
    type: "worker_attempt.running",
    message: `Automation worker running via ${transport}: ${task.title}`,
    payload: {
      command,
      runtime: task.runtimePreference,
      session: transport,
      headless: true,
    },
  });
  const step = run.steps.find((item) => item.id === task.stepId);
  if (shouldUsePeerComms(run, step, task)) {
    await updatePeerCommsRegistry(run, step, task, attemptId, paths, "running")
      .catch(() => undefined);
  }

  let transportKill: (() => void) | null = null;
  let interruptedBeforeStart = false;
  const kill = () => {
    interruptedBeforeStart = true;
    transportKill?.();
  };
  activeWorkerProcesses.set(attemptId, {
    runId: run.id,
    stepId: task.stepId,
    workerTaskId: task.id,
    attemptId,
    command,
    write: () => undefined,
    kill,
  });

  try {
    const result = await runStructuredWorker({
      runId: run.id,
      automationId: run.automationId ?? "",
      task,
      cwd,
      prompt: promptText,
      paths,
      sandboxed,
      extraWritableDirs,
      onStarted(nextKill) {
        transportKill = nextKill;
        if (interruptedBeforeStart) nextKill();
      },
    });
    return { exitCode: result.exitCode, error: result.error };
  } finally {
    activeWorkerProcesses.delete(attemptId);
  }
}

async function readWorkerReportWithWorkspaceShadowRecovery(
  cwd: string,
  expectedPath: string,
): Promise<{ report: WorkerReport | null; relocatedFrom: string | null }> {
  const expected = await readWorkerReport(expectedPath);
  if (expected) return { report: expected, relocatedFrom: null };

  // Claude occasionally abbreviates the absolute report target from the
  // prompt to `.Codara/runs/...` and therefore writes it under the workspace
  // instead of SPARK_HOME. Recover only the exact run-relative path; never
  // scan or move arbitrary workspace JSON. The parsed report proves the file
  // is complete before we copy it, and unlinking that exact shadow keeps the
  // generated artifact out of the user's git status.
  const home = sparkHome();
  const reportRelative = relative(home, expectedPath);
  if (
    !reportRelative ||
    reportRelative === ".." ||
    reportRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(reportRelative)
  ) {
    return { report: null, relocatedFrom: null };
  }
  const shadowPath = join(cwd, basename(home), reportRelative);
  if (shadowPath === expectedPath) return { report: null, relocatedFrom: null };
  const shadowReport = await readWorkerReport(shadowPath);
  if (!shadowReport) return { report: null, relocatedFrom: null };

  const raw = await fs.readFile(shadowPath, "utf8");
  await fs.mkdir(dirname(expectedPath), { recursive: true });
  await writeFileAtomic(expectedPath, raw);
  await fs.unlink(shadowPath).catch(() => undefined);
  return { report: shadowReport, relocatedFrom: shadowPath };
}

function piProviderForWorker(task: WorkerTask): PiSubscriptionProvider {
  return task.runtimePreference === "claude" ? "anthropic" : "openai-codex";
}

function piThinkingForWorker(task: WorkerTask): PiThinkingLevel {
  const effort = task.effortHint;
  if (
    effort === "minimal" || effort === "low" || effort === "medium" ||
    effort === "high" || effort === "xhigh" || effort === "max"
  ) return effort;
  return "high";
}

function piModelForWorker(task: WorkerTask): string | undefined {
  const model = task.modelHint?.trim();
  // Never let Pi choose Anthropic's subscription default implicitly. That
  // default can be Fable 5, the premium tier, which a planner that omitted
  // modelHint never chose on purpose. Opus 4.8 is the documented worker
  // fallback; an explicit Fable hint still passes below.
  if (!model) {
    return task.runtimePreference === "claude"
      ? WORKER_DEFAULT_CLAUDE_MODEL
      : undefined;
  }
  if (task.runtimePreference === "claude" && model.startsWith("claude-")) {
    return sanitizeWorkerModelHint(model) ?? WORKER_DEFAULT_CLAUDE_MODEL;
  }
  if (task.runtimePreference === "codex" && model.startsWith("gpt-")) return model;
  return task.runtimePreference === "claude"
    ? WORKER_DEFAULT_CLAUDE_MODEL
    : undefined;
}

function piWorkerToolLabel(value: unknown): string {
  const name = typeof value === "string" ? value : "tool";
  const normalized = name.replace(/^mcp__codara-studio__/, "");
  const known: Record<string, string> = {
    read: "Read context",
    write: "Write file",
    edit: "Edit file",
    bash: "Run command",
    grep: "Search code",
    find: "Find files",
    ls: "List files",
    codara_preview_screenshot: "Inspect preview",
    codara_preview_navigate: "Open preview",
    codara_whiteboard_update: "Update whiteboard",
  };
  return known[normalized] ?? normalized
    .replace(/^codara_/, "")
    .split("_")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function piWorkerSafeText(value: unknown, maxLength = 260): string {
  let text = "";
  if (typeof value === "string") text = value;
  else if (value !== undefined) {
    try { text = JSON.stringify(value); } catch { text = String(value); }
  }
  text = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function piWorkerToolDetail(event: PiRpcEvent): string {
  const args = event.args && typeof event.args === "object" && !Array.isArray(event.args)
    ? event.args as Record<string, unknown>
    : {};
  const name = typeof event.toolName === "string"
    ? event.toolName.replace(/^mcp__codara-studio__/, "").toLowerCase()
    : "";
  const keys = name === "bash"
    ? ["command"]
    : name === "grep" || name === "find" || name === "glob"
      ? ["pattern", "path"]
      : name === "read" || name === "write" || name === "edit" || name === "multi_edit"
        ? ["path", "file_path", "filePath"]
        : name === "ls"
          ? ["path"]
          : name === "fetch" || name === "web_fetch" || name === "webfetch"
            ? ["url"]
            : name.startsWith("codara_preview")
              ? ["url", "selector", "key", "text", "code"]
              : name.startsWith("codara_terminal")
                ? ["command", "text"]
                : ["path", "command", "query", "pattern", "url", "prompt", "description"];
  const pieces = keys
    .map((key) => piWorkerSafeText(args[key], name === "bash" ? 320 : 160))
    .filter(Boolean);
  if (pieces.length > 0) return pieces.join(" · ");
  return piWorkerSafeText(event.args, 220);
}

function piWorkerResultText(result: unknown): string {
  if (typeof result === "string") return piWorkerSafeText(result, 700);
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  if (Array.isArray(record.content)) {
    const text = record.content
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const candidate = (item as Record<string, unknown>).text;
        return typeof candidate === "string" ? candidate : "";
      })
      .filter(Boolean)
      .join(" ");
    if (text) return piWorkerSafeText(text, 700);
  }
  return piWorkerSafeText(result, 700);
}

// Terminal frame painted after final-report.json lands: the report facts plus
// the deterministic review outcome, so the worker pane does not dead-end at
// "Cora is reviewing the evidence" with the verdict visible only in the run
// log. Facts first, one quiet line per item.
function paintPiWorkerReportOutcome(
  paint: (text: string) => void,
  report: WorkerReport,
): void {
  const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
  const lines: string[] = [`\r\n\x1b[32m  ✓  Report ready — ${report.status}\x1b[0m`];
  const summary = piWorkerSafeText(report.summary, 220);
  if (summary) lines.push(`     ${dim(summary)}`);
  const counts: string[] = [];
  if (report.filesChanged.length > 0) counts.push(`${report.filesChanged.length} file(s) changed`);
  if (report.commandsRun.length > 0) counts.push(`${report.commandsRun.length} command(s) run`);
  if (report.tests.length > 0) {
    const passed = report.tests.filter((test) => test.result === "passed").length;
    counts.push(`${passed}/${report.tests.length} test(s) passed`);
  }
  if (counts.length > 0) lines.push(`     ${dim(counts.join(" · "))}`);
  const verdict = report.verifier;
  if (verdict) {
    lines.push(`     Verifier verdict: ${verdict.confidence} (${verdict.status})`);
    if (verdict.missingOracle) {
      lines.push(`     ${dim(`Missing oracle: ${piWorkerSafeText(verdict.missingOracle, 180)}`)}`);
    }
    if (verdict.atomicClaims.length > 0) {
      const failed = verdict.atomicClaims.filter((claim) => claim.verdict === "failed").length;
      const unsure = verdict.atomicClaims.filter((claim) => claim.verdict === "unsure").length;
      const verified = verdict.atomicClaims.length - failed - unsure;
      lines.push(`     ${dim(`Claims: ${verified} verified · ${failed} failed · ${unsure} unsure`)}`);
    }
  }
  let review: string;
  if (verdict && verdict.confidence === "FEEDBACK") {
    review = verifierVerdictIsOracleBlocked(verdict)
      ? "Verifier tooling was unavailable; Cora accepts with this caveat."
      : "Cora is sending the corrective feedback back to the implementation.";
  } else {
    const decision = decideWorkerReport(report);
    review = decision.decision === "accept"
      ? "Cora accepted the report."
      : decision.decision === "retry_same_worker"
        ? "Cora is queuing a retry."
        : "Cora is flagging this for your review.";
  }
  lines.push(`     ${review}`);
  paint(lines.join("\r\n") + "\r\n");
}

function piWorkerEventFailure(event: PiRpcEvent): string | null {
  if (event.type === "message_end") {
    const message = event.message && typeof event.message === "object" && !Array.isArray(event.message)
      ? event.message as Record<string, unknown>
      : null;
    if (message?.stopReason === "error") {
      return typeof message.errorMessage === "string" && message.errorMessage.trim()
        ? message.errorMessage.trim()
        : "Pi provider turn failed.";
    }
  }
  if (event.type === "auto_retry_end" && event.success === false) {
    return typeof event.finalError === "string" && event.finalError.trim()
      ? event.finalError.trim()
      : "Pi exhausted its provider retries.";
  }
  if (event.type === "extension_error") {
    return typeof event.error === "string" && event.error.trim()
      ? event.error.trim()
      : "Pi worker extension failed.";
  }
  return null;
}

async function waitForPiWorkerTurn(client: PiRpcClient, prompt: string): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  let poll: NodeJS.Timeout | null = null;
  let unsubscribe: () => void = () => undefined;
  try {
    const settled = new Promise<void>((resolve, reject) => {
      let providerFailure: string | null = null;
      unsubscribe = client.onEvent((event) => {
        providerFailure = piWorkerEventFailure(event) ?? providerFailure;
        if (event.type === "agent_settled") {
          if (providerFailure) reject(new Error(providerFailure));
          else resolve();
        }
      });
      poll = setInterval(() => {
        const state = client.state();
        if (state.phase === "failed" || state.phase === "stopped") {
          reject(new Error(state.failure?.message || `Pi worker runtime ${state.phase}.`));
        }
      }, 500);
      poll.unref();
      timer = setTimeout(() => reject(new Error("Pi worker timed out after 90 minutes.")), 90 * 60 * 1000);
      timer.unref();
    });
    await client.prompt(prompt);
    await settled;
  } finally {
    unsubscribe();
    if (poll) clearInterval(poll);
    if (timer) clearTimeout(timer);
  }
}

const PI_WORKER_RENDERER_PTY_GRACE_MS = 1_500;
const PI_WORKER_FALLBACK_COLS = 110;
const PI_WORKER_FALLBACK_ROWS = 32;

/**
 * Pi runs in a main-process RPC client; its PTY is only a durable activity
 * display. Give the renderer a short chance to create the normal visible
 * pane, then create a headless display PTY ourselves. A later TerminalPane
 * attaches to this same session and receives its tail, so background
 * workspaces and missed envelope events keep running instead of failing a
 * provider that was never launched.
 */
async function ensurePiWorkerDisplayPty(attemptId: string, cwd: string): Promise<boolean> {
  if (await pty.waitForSpawn(attemptId, PI_WORKER_RENDERER_PTY_GRACE_MS)) return false;
  const shell = await defaultShell();
  if (!shell) throw new Error("No default shell is available for the Cora worker display.");
  await pty.spawn({
    id: attemptId,
    shell,
    cwd,
    cols: PI_WORKER_FALLBACK_COLS,
    rows: PI_WORKER_FALLBACK_ROWS,
    webContents: null,
    env: { SPARK_NO_SHELL_INTEGRATION: "1" },
  });
  pty.resize(attemptId, PI_WORKER_FALLBACK_COLS, PI_WORKER_FALLBACK_ROWS);
  return true;
}

/**
 * Ordinary Cora workers now use Pi as their coding harness while retaining
 * the existing WorkerTask/Attempt/report/review contract. The renderer-owned
 * PTY becomes a live activity display; the actual model process is Pi RPC so
 * provider subscriptions, native tools, and extension behavior are uniform
 * with the Cora manager.
 */
async function runPiWorkerSession({
  run,
  task,
  attemptId,
  paths,
  cwd,
  promptText,
  command,
}: {
  run: RunState;
  task: WorkerTask;
  attemptId: string;
  paths: WorkerArtifactPaths;
  cwd: string;
  promptText: string;
  command: string;
}): Promise<{ exitCode: number; error?: string }> {
  const displayPtyRecovered = await ensurePiWorkerDisplayPty(attemptId, cwd);
  if (displayPtyRecovered) {
    await appendEvent({
      workspaceId: run.workspaceId,
      runId: run.id,
      stepId: task.stepId,
      workerTaskId: task.id,
      attemptId,
      type: "worker_attempt.display_pty_recovered",
      message: "Cora created a main-owned worker display after the renderer missed the launch event",
      payload: { cwd, graceMs: PI_WORKER_RENDERER_PTY_GRACE_MS },
    });
  }
  await pty.waitForResize(attemptId, 5_000);

  const provider = piProviderForWorker(task);
  const model = piModelForWorker(task);
  const thinking = piThinkingForWorker(task);
  const modelLabel = model ?? (provider === "anthropic" ? "Claude subscription default" : "Codex subscription default");
  pty.publishOutput(
    attemptId,
    `\x1b[2J\x1b[H\r\n\x1b[38;2;74;222;208m  ✦  CORA PI WORKER\x1b[0m\r\n` +
      `\x1b[2m     ${task.title}\x1b[0m\r\n\x1b[2m     ${modelLabel} · ${thinking}\x1b[0m\r\n\r\n` +
      `\x1b[38;2;74;222;208m  ●\x1b[0m Starting the pinned Pi harness…\r\n`,
  );

  let client: PiRpcClient | null = null;
  let unsubscribe: (() => void) | null = null;
  let interrupted = false;
  let logQueue: Promise<void> = Promise.resolve();
  const appendWorkerLog = (text: string) => {
    logQueue = logQueue
      .catch(() => undefined)
      .then(async () => {
        await Promise.all([
          fs.appendFile(paths.stdoutLog, text, "utf8"),
          fs.appendFile(paths.rawLog, `[${new Date().toISOString()}] pi-rpc\n${text}\n`, "utf8"),
        ]);
      });
  };
  const paint = (text: string) => {
    pty.publishOutput(attemptId, text);
    appendWorkerLog(text.replace(/\x1b\[[0-9;]*m/g, ""));
  };

  try {
    const step = run.steps.find((item) => item.id === task.stepId);
    const peerCommsEnabled = shouldUsePeerComms(run, step, task);
    const plan = await createCodaraPiWorkerLaunchPlan({
      provider,
      runId: run.id,
      attemptId,
      cwd,
      model,
      thinking,
      sessionName: task.title,
      executionPolicy: normalizeCoraExecutionPolicy(run.coraExecutionPolicy),
      // Frozen contract with resources/pi-cora/worker.ts: parallel-batch
      // workers get CODARA_PI_PEER_DIR + CODARA_PI_SELF_ID to reach the
      // run's mailbox natively. Same gate as the prompt-side guidance.
      peerCommsDir: peerCommsEnabled ? paths.peerCommsDir : undefined,
      peerSelfId: peerCommsEnabled ? task.id : undefined,
    });
    client = new PiRpcClient(plan, {
      requestTimeoutMs: 120_000,
      shutdownGraceMs: 2_000,
    });
    await client.start();

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
      message: `Worker attempt running through Pi: ${task.title}`,
      payload: {
        command,
        runtime: task.runtimePreference,
        harness: "pi",
        provider,
        model: plan.model,
        thinking: plan.thinking,
        session: "pi-rpc",
      },
    });
    if (peerCommsEnabled) {
      await updatePeerCommsRegistry(run, step, task, attemptId, paths, "running").catch(() => undefined);
    }

    activeWorkerProcesses.set(attemptId, {
      runId: run.id,
      stepId: task.stepId,
      workerTaskId: task.id,
      attemptId,
      command,
      write: (input) => {
        if (!client) return;
        if (input === ESC_KEY) {
          void client.abort().catch(() => undefined);
          return;
        }
        const steering = input.replace(/[\r\n]+$/g, "").trim();
        if (steering) void client.prompt(steering, "steer").catch(() => undefined);
      },
      kill: () => {
        interrupted = true;
        void client?.abort().catch(() => undefined);
        void client?.stop().catch(() => undefined);
      },
    });
    applyHookStateReport({ paneId: attemptId, state: "working", note: "Pi harness" });

    let assistantLineOpen = false;
    unsubscribe = client.onEvent((event: PiRpcEvent) => {
      if (event.type === "tool_execution_start") {
        assistantLineOpen = false;
        const detail = piWorkerToolDetail(event);
        paint(
          `\r\n  \x1b[38;2;74;222;208m◇\x1b[0m ${piWorkerToolLabel(event.toolName)}` +
          `${detail ? `\r\n    \x1b[2m${detail}\x1b[0m` : ""}\r\n`,
        );
      } else if (event.type === "tool_execution_end") {
        const failed = event.isError === true;
        const detail = failed ? piWorkerResultText(event.result) : "";
        paint(
          `  ${failed ? "\x1b[31m× failed\x1b[0m" : "\x1b[32m✓ done\x1b[0m"}` +
          `${detail ? `\r\n    \x1b[31m${detail}\x1b[0m` : ""}\r\n`,
        );
      } else if (event.type === "message_update") {
        const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.delta === "string" && delta.delta) {
          if (!assistantLineOpen) {
            paint("\r\n  ");
            assistantLineOpen = true;
          }
          paint(delta.delta.replace(/\n/g, "\r\n  "));
        }
      } else if (event.type === "message_end") {
        if (assistantLineOpen) {
          paint("\r\n");
          assistantLineOpen = false;
        }
        const failure = piWorkerEventFailure(event);
        if (failure) paint(`\r\n  \x1b[31mProvider error: ${piWorkerSafeText(failure, 700)}\x1b[0m\r\n`);
      } else if (event.type === "auto_retry_start") {
        paint("\r\n  \x1b[33m↻ Provider retry…\x1b[0m\r\n");
      } else if (event.type === "auto_retry_end" && event.success === false) {
        paint(`\r\n  \x1b[31mProvider retry failed: ${piWorkerSafeText(event.finalError, 700)}\x1b[0m\r\n`);
      } else if (event.type === "extension_error") {
        paint(`\r\n  \x1b[31mExtension error: ${String(event.error ?? "unknown")}\x1b[0m\r\n`);
      }
    });

    paint(`  \x1b[32m✓ Pi ready\x1b[0m · ${plan.provider}/${plan.model}\r\n`);
    await waitForPiWorkerTurn(client, promptText);
    if (interrupted) throw new Error("Pi worker was interrupted.");

    let report = await readWorkerReport(paths.finalReportJson);
    if (!report) {
      paint("\r\n  \x1b[33m↻ Finalizing the evidence report…\x1b[0m\r\n");
      await waitForPiWorkerTurn(
        client,
        `Your task turn ended without a parseable final report at ${paths.finalReportJson}. ` +
          "Do not redo completed work. Inspect the current diff and verification evidence, then write the mandatory final-report.json using the exact schema and absolute path from the original task prompt. End only after confirming the file parses as JSON.",
      );
      report = await readWorkerReport(paths.finalReportJson);
    }
    if (!report) throw new Error("Pi worker completed without a parseable final-report.json.");

    applyHookStateReport({ paneId: attemptId, state: "done", note: "Pi worker report ready" });
    paintPiWorkerReportOutcome(paint, report);
    await logQueue.catch(() => undefined);
    return { exitCode: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    applyHookStateReport({ paneId: attemptId, state: interrupted ? "done" : "error", note: message });
    paint(`\r\n\x1b[31m  ×  PI WORKER STOPPED\x1b[0m\r\n  ${message}\r\n`);
    await writeAutoFailureReport(paths, task, message, { interrupted }).catch(() => undefined);
    await logQueue.catch(() => undefined);
    return { exitCode: 1, error: message };
  } finally {
    unsubscribe?.();
    activeWorkerProcesses.delete(attemptId);
    await client?.stop().catch(() => undefined);
    // Keep the completed frame in xterm; disposing the idle host shell matches
    // the former CLI worker lifecycle and prevents one process per old worker.
    try { pty.killImmediate(attemptId); } catch { /* already closed */ }
  }
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
  cwd,
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
      // A CLI that exits the instant it writes final-report.json must not be
      // failed just because the exit event beat the 750ms report poll. Give
      // the report one last chance to parse (short grace covers a mid-write
      // file) before declaring the pane closed. finish() is idempotent, so a
      // poll tick landing during the grace resolves first and this no-ops.
      void (async () => {
        for (let i = 0; i < 4 && !settled; i++) {
          try {
            const located = await readWorkerReportWithWorkspaceShadowRecovery(
              cwd,
              paths.finalReportJson,
            );
            if (located.report) {
              if (located.relocatedFrom) {
                await appendEvent({
                  workspaceId: run.workspaceId,
                  runId: run.id,
                  stepId: task.stepId,
                  workerTaskId: task.id,
                  attemptId,
                  type: "worker_attempt.report_path_recovered",
                  message: "Recovered a final report written to a workspace-relative .Codara path",
                  payload: {
                    relocatedFrom: located.relocatedFrom,
                    finalReportPath: paths.finalReportJson,
                  },
                }).catch(() => undefined);
              }
              finish({ exitCode: 0 });
              return;
            }
          } catch {
            /* absent or mid-write; retry below */
          }
          await new Promise((r) => setTimeout(r, 300));
        }
        finish({
          exitCode: info.exitCode ?? 1,
          error: info.signal ? `Worker pane closed (signal ${info.signal})` : "Worker pane closed before final report",
        });
      })();
    });
    const reportPoll = setInterval(() => {
      // Finish only once the report PARSES, not merely exists. The agent CLI
      // writes final-report.json non-atomically, and finish() kills the worker
      // tree before resolving — a tick landing mid-write would otherwise kill
      // the CLI and leave the file permanently truncated. Guard with the cheap
      // existence check first (the file is absent for most of the session), then
      // attempt the read+parse; a partially-written file fails JSON.parse and is
      // retried on the next tick.
      void readWorkerReportWithWorkspaceShadowRecovery(cwd, paths.finalReportJson)
        .then(async ({ report, relocatedFrom }) => {
          if (!report) return;
          if (relocatedFrom) {
            await appendEvent({
              workspaceId: run.workspaceId,
              runId: run.id,
              stepId: task.stepId,
              workerTaskId: task.id,
              attemptId,
              type: "worker_attempt.report_path_recovered",
              message: "Recovered a final report written to a workspace-relative .Codara path",
              payload: {
                relocatedFrom,
                finalReportPath: paths.finalReportJson,
              },
            }).catch(() => undefined);
          }
          finish({ exitCode: 0 });
        })
        .catch(() => {
          /* not yet written / not yet parseable */
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
        if (task.runtimePreference === "codex") {
          await waitForCodexInputReady(attemptId);
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
  if (step && !["complete", "completed_unverified", "failed", "skipped"].includes(step.status)) {
    step.status = "running";
    step.updatedAt = timestamp;
    run.currentStepId = step.id;
  }
  run.updatedAt = timestamp;
  await saveRun(run);
}

async function recordWorkerOutput(
  _run: RunState,
  _task: WorkerTask,
  _attemptId: string,
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
//
// `opts.sandboxDir` is set only for unattended attempts running inside a
// throwaway git worktree (AppSettings.autopilotSandbox). When present it
// scopes the agent's filesystem permissions to that worktree: claude keeps
// --dangerously-skip-permissions but adds `--add-dir <sandboxDir>`, and codex
// swaps its blanket `--yolo` for `--sandbox workspace-write` so writes are
// confined to the worktree. With sandboxDir undefined the output is
// byte-identical to before (plain --yolo / no --add-dir), so interactive and
// unsandboxed launches are unchanged.
function buildLaunchCommandLine(
  task: WorkerTask,
  cwd: string,
  opts?: { sandboxDir?: string; isAutomation?: boolean; extraWritableDirs?: string[] },
): string | null {
  // Pin the shell to the workspace directory before the agent CLI starts.
  // The pty is spawned with cwd=workspaceCwd, but the user's $PROFILE
  // (PowerShell, bash, zsh) frequently includes a `Set-Location $HOME` /
  // `cd ~` that moves the shell away before we type the launch command.
  // The agent CLI inherits cwd from the shell, so without this prefix the
  // worker ends up running in the user's home directory instead of the
  // workspace. `cd` works as an alias / built-in in pwsh, bash, zsh and cmd.
  const cdPrefix =
    cwd && cwd.trim().length > 0 ? `cd ${quoteShellArg(cwd)}; ` : "";
  const sandboxDir = opts?.sandboxDir?.trim() || undefined;

  if (task.runtimePreference === "claude") {
    const args = ["claude", "--dangerously-skip-permissions"];
    if (sandboxDir) args.push("--add-dir", quoteShellArg(sandboxDir));
    // Per-worker tool access is appended LAST (below), after model/effort, so the
    // variadic --disallowedTools <tools...> can't swallow a following flag.
    const disallowed = claudeDisallowedTools(task.accessHint, task.blockedToolsHint);
    // Model-hint backstop: remaps superseded Sonnet ids to the current one.
    // Automation (loom) workers launch on a pinned/handoff model the
    // automation engine already validated, so their hint goes through
    // verbatim; for every other claude worker (the Cora-spawned execute/
    // council/autopilot path) this is defence-in-depth — tasks persisted by
    // pre-remap builds still get their stale sonnet hint fixed here at launch.
    const rawModel = task.modelHint?.trim();
    const launchModel = opts?.isAutomation
      ? rawModel
      : sanitizeWorkerModelHint(rawModel);
    // A missing hint must not delegate model choice to Claude's current CLI
    // default: that default may be Fable 5, the premium tier, which nobody
    // chose on purpose here. Pin the documented worker fallback instead.
    args.push("--model", quoteShellArg(launchModel || WORKER_DEFAULT_CLAUDE_MODEL));
    const claudeEffort = mapClaudeEffort(task.effortHint);
    if (claudeEffort) args.push("--effort", claudeEffort);
    // Tool fence LAST: --dangerously-skip-permissions suppresses the prompts, but
    // a preset (or the node's extra blockedTools) still hard-denies tools on top.
    // "edits" removes shell + web, "readonly" removes existing-file edits + shell
    // + web (Write stays, for the report); blockedTools merge into ANY preset incl.
    // "full". Empty = the flag is omitted (full access), so a plain worker is
    // byte-identical to before. Each tool is its own space-separated value of the
    // variadic flag — `claude --help` documents `--disallowedTools, --disallowed-
    // tools <tools...>` and accepts a comma OR space separated list; we use the
    // space-separated form (claude-backend.ts uses the kebab spelling of the same
    // variadic flag) and place it LAST so it can't swallow a following flag.
    if (disallowed.length > 0) {
      args.push("--disallowedTools", ...disallowed.map((tool) => quoteShellArg(tool)));
    }
    // Config shield: run the CLI under sandbox-exec so it can't read the user's
    // personal ~/.claude config (CLAUDE.md, custom agents, hooks, …). darwin
    // only; null elsewhere, where worker-prompt.ts adds a prompt-level fallback
    // note instead. See agent-config-shield.ts.
    logConfigShieldOnce();
    const claudeShield = buildClaudeShieldPrefix() ?? "";
    return cdPrefix + claudeShield + args.join(" ");
  }
  if (task.runtimePreference === "codex") {
    // codex >= v0.128 ignores the older `-c projects."<abs>".trust_level=...`
    // override at the command line — it requires an exact-path match in the
    // saved config.toml against codex's own normalized cwd (lowercase,
    // backslash). We write that entry from launchWorkerAttempt before
    // spawning, so by the time codex starts, the directory is already
    // trusted and the prompt is skipped silently.
    //
    // When sandboxed, run under `--sandbox <mode>` (writes confined to — or, for
    // read-only, forbidden outside — the cwd) instead of the blanket `--yolo`.
    // The mode is chosen by codexAccessFlags: an access preset ("edits" →
    // workspace-write, "readonly" → read-only) wins over the legacy
    // isolate-worktree sandboxDir (which alone still maps to workspace-write), so
    // when both apply the more restrictive sandbox wins. With neither, output is
    // byte-identical to before (plain --yolo). The new presets also add
    // `-a never` so a mid-run approval prompt can't hang a watch-only worker
    // terminal; the legacy sandboxDir path keeps its prior approval behavior.
    // blockedTools is claude-only (codex has no per-tool deny — the sandbox IS
    // the fence), so it is ignored here.
    const codex = codexAccessFlags(task.accessHint, Boolean(sandboxDir));
    const args = codex.sandboxMode
      ? ["codex", "--sandbox", codex.sandboxMode]
      : ["codex", "--yolo"];
    if (codex.approvalsNever) args.push("-a", "never");
    // A codex --sandbox confines writes to the workspace cwd, but the worker's
    // final-report.json (and, for chat, the shared board) live OUTSIDE it under
    // ~/.Codara/runs. Make exactly those dirs writable with --add-dir so a fenced
    // codex worker can report + post — WITHOUT exposing the rest of the run dir
    // (run.json/events.jsonl stay out of reach). Only meaningful when sandboxed;
    // a --yolo launch already has full disk access, so skip it there.
    if (codex.sandboxMode) {
      for (const extra of opts?.extraWritableDirs ?? []) {
        const d = extra.trim();
        if (d) args.push("--add-dir", quoteShellArg(d));
      }
    }
    if (task.modelHint?.trim()) args.push("-m", quoteShellArg(task.modelHint.trim()));
    const codexEffort = mapCodexEffort(task.effortHint);
    if (codexEffort) args.push("-c", quoteShellArg(`model_reasoning_effort=${codexEffort}`));
    // Config shield: deny reads of ~/.codex/AGENTS.md (personal global codex
    // instructions). darwin only — and ONLY for --yolo launches: whenever a
    // `--sandbox` mode is set (for ANY reason — a preset OR the isolate
    // worktree), codex applies its own macOS Seatbelt profile per command, and
    // Seatbelt cannot nest, so wrapping that variant in sandbox-exec makes every
    // worker command fail with "sandbox_apply: Operation not permitted". See
    // agent-config-shield.ts.
    logConfigShieldOnce();
    const codexShield = codex.sandboxMode ? "" : (buildCodexShieldPrefix() ?? "");
    return cdPrefix + codexShield + args.join(" ");
  }
  return null;
}

// Translate Codara's internal effort scale to the values the claude CLI
// actually accepts: low, medium, high, xhigh, max. Codara's manager profile
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
  if (effort === "minimal") return "low";
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max") return effort;
  return "medium";
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

function runPath(runId: string): string {
  return join(runDir(runId), RUN_FILE);
}
