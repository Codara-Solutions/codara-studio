import { promises as fs, createWriteStream, watch, type FSWatcher } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import type {
  AddDirectIterationInput,
  AddRunMessageInput,
  AnswerRunQuestionInput,
  ManagerTurnRecoveryFailureKind,
  PlanValidation,
  WorkerHandoffArtifact,
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
  BoardCard,
  ChatBackendKind,
  LoomWorkerConfig,
  ManagerApplicationReceipt,
  RunBoard,
  RunBoardUpdateInput,
  RunBoardUpdateResult,
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
  ResumeRunInput,
  CreateStepInput,
  CreateRunInput,
  CreateWorkerTaskInput,
  FanOutDirective,
  CouncilDirective,
  PlannedStepAgent,
  PrepareWorkerTaskInput,
  PtyExitInfo,
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
  TaskComplexity,
  UpdateRunStatusInput,
  UpdateStepInput,
  UpdateWorkerTaskInput,
  WorkerRuntime,
  WorkerTask,
  WorkerTaskStatus,
  WorkerAttempt,
  WorkerArtifactPaths,
  UserConstitutionCapture,
  WorkerRuntimeState,
  VerifierVerdict,
  PriorVerifierRound,
  WorkerReport,
  WorkerTaskEnvelope,
} from "@shared/types";
import { FAN_OUT_DIRECTIVE_MARKER, normalizeGitHubOrigin } from "@shared/types";
import {
  normalizeHumanRunQuestionMessages,
  resolveOpenRunQuestion as resolveOpenRunQuestionPure,
  resolveSingleUnresolvedRunQuestion,
  resumeBlockingRunQuestion,
  unresolvedRunQuestions,
} from "@shared/run-questions";
import { makeId } from "@shared/ids";
import { stripAnsiAndControls } from "@shared/agent-patterns";
import {
  formatPaneCollapsedBlock,
  paneDim,
  paneRetryMarker,
  paneStreamAdd,
  paneStreamBudget,
  paneStreamExceeded,
  paneToolFailMarker,
  paneToolOkMarker,
  paneToolStartMarker,
  PANE_RED,
  PANE_STREAM_CUT_NOTE,
} from "@shared/pane-format";
import {
  effectiveChatMode,
  effectiveChatOneMillionContext,
  normalizeChatFeatureFlags,
} from "@shared/chat-policy";
import { contextWindowForModel } from "@shared/context-window";
import {
  chatContextCapacityTokens,
  resolveCompactAtTokens,
} from "@shared/context-compaction";
import { normalizeCoraExecutionPolicy } from "@shared/cora-execution-policy";
import { effectiveRunExecutionPolicy } from "./execution-policy";
import {
  normalizeProjectConstitutionSnapshot,
  readProjectConstitutionSnapshot,
} from "./project-constitution";
import { resolveCapturedManagerConstitutionBlock } from "./manager-constitution-resolver";
import { captureCurrentUserConstitution } from "../user-constitution-store";
import {
  copyUserConstitutionCapture,
  copyRunUserConstitutionCapture,
  normalizeRunUserConstitutionProvenance,
} from "../user-constitution-capture";
import {
  resolveProjectPolicyMode,
  runProjectPolicyMode,
} from "./project-policy";
import {
  CORA_WHITEBOARD_NODE_DEFAULT_SIZES,
  whiteboardNodeSizeLimits,
} from "@shared/cora-whiteboard-file";
import { CODEX_MODEL_BY_TIER, loomRuntimeForModel, normalizeCodexModelId } from "@shared/model-catalog";
import {
  applyUserBoardUpdate,
  composeBoardNudgeMessage,
  emptyRunBoard,
  markLegacyBoardAdopted,
  normalizeBoardCards,
  normalizeStoredRunBoard,
  readLegacyBoardForAdoption,
} from "./board-store";
import {
  hasExplicitParallelAgentIntent,
  isHeuristicUserMessage,
  latestUserRunMessageText,
} from "./user-intent";
// Pure wave selection for pickAutopilotTasks, including manager-batch parallel
// trust (tasks the execute-mode spawn RPC already launched simultaneously must
// relaunch concurrently too) and the fan-out no-concrete-scope serial guard.
import {
  isBroadPathScope,
  normalizeTaskPath,
  pathScopesOverlap,
  selectAutopilotWave,
  taskWritesWorkspace,
} from "./autopilot-wave";
import {
  appendBufferedEvent as appendBufferedEventRaw,
  appendEvent as appendEventRaw,
  appendEvents as appendEventsRaw,
  flushBufferedEvents,
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
import {
  reconcileAcceptedVerifierOnlySteps,
  rehomeSettledStepFeedbackRetry,
} from "./step-lifecycle";
import { describeRunSettlement, isRunSettled } from "./run-settled";
import { PEER_COMMS_HELPER_SCRIPT } from "./peer-comms-script";
import { decideWorkerReport, readWorkerReport } from "./worker-report";
import { classifyWorkerFailure, planWorkerFailureRetry } from "./failure-taxonomy";
import { classifyWorkerSilence, PI_WORKER_TURN_CEILING_MS } from "./agent-liveness";
import {
  isParkedManagerTurnAction,
  managerTurnRetryDelayMs,
  MAX_MANAGER_TRANSIENT_RETRIES,
  planManagerTurnFailure,
} from "./manager-turn-policy";
import {
  MANUAL_REVIEW_ACCEPT_OPTION_ID,
  MANUAL_REVIEW_QUESTION_OPTIONS,
  parseManualReviewVerdict,
} from "./manual-review";
// Re-exported for external importers (ipc.ts reaches it via getRunStore()).
export { readWorkerReport } from "./worker-report";
// Spawn-time batch shape guard. agent-socket's codara_spawn_workers handler is
// the single choke point every MCP-driven spawn passes through and reaches it
// through getRunStore(), so the run store owns this policy alongside the rest
// of the worker-task contract.
export {
  evaluateSpawnBatchShape,
  runHasImplementationTask,
  VERIFIER_BATCH_REJECTION_MESSAGE,
} from "./spawn-batch-guard";
import {
  COMPLETION_SUMMARY_PREFIX,
  buildCompletionSummaryMessage,
} from "./completion-summary";
import { collectRunResultManifest } from "./result-manifest";
import {
  readWorkerPromptForLaunch,
  renderWorkerPrompt,
  shouldProvisionWorkerMailbox,
  shouldUsePeerComms,
} from "./worker-prompt";
import {
  buildClaudeShieldPrefix,
  buildCodexShieldPrefix,
  logConfigShieldOnce,
} from "./agent-config-shield";
import {
  detectFatalWorkerRuntimeError,
  FATAL_ERROR_GATE_OVERLAP,
  mayContainFatalWorkerRuntimeError,
  pasteAndSubmit,
  waitForAgentTui,
  waitForCodexInputReady,
  watchAgentCliExit,
  writeAutoFailureReport,
} from "./worker-launch";
import {
  claudeDisallowedTools,
  codexAccessFlags,
  codexFastModeArgs,
  decorateWavePrompt,
  waveHasChat,
  type WavePeerInfo,
} from "./worker-access";
import { writeFileAtomic } from "../fs-atomic";
import { loadSettings } from "../storage";
import { estimateWorkerCostUsd } from "../model-prices";
import {
  type ManagerMode,
  type SparkManagerDecision,
  type SparkManagerQuestionOption,
  type SparkManagerStepDecision,
  type SparkManagerTaskDecision,
} from "./manager-protocol";
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
import {
  resolveFrozenNativeCodexProfile,
  resolveNewNativeCodexProfile,
  nativeCodexProfileStore,
} from "./native-codex-profile-runtime";
import {
  resolveNewNativeClaudeProfile,
  nativeClaudeProfileStore,
} from "./native-claude-profile-runtime";
import type { LoomGraph, LoomNodeDef } from "@shared/types";
import { recordRunMemory } from "./run-memory";
import { recordRunLessons } from "./workspace-lessons";
import { formatCoraMemoryForTurn, releaseCoraMemoryInjection } from "./cora-memory";
import {
  describeHeadroomForPrompt,
  readSubscriptionHeadroomSummary,
} from "./subscription-headroom";
import {
  createCheckpoint,
  deleteRunCheckpoints,
  restoreCheckpointCode,
  rewindShadowRef,
  runCheckpointStartPoint,
} from "./checkpoints";
import { resolveConversationRewindTransaction } from "./conversation-rewind";
import { createKeyedTaskQueue } from "./keyed-task-queue";
import {
  createSandboxWorktree,
  managedWorktreesRoot,
  mergeBackSandboxWorktree,
  removeSandboxWorktree,
} from "../git-worktrees";
import { readGitText } from "../git-exec";
import { sparkHome } from "../spark-home";
import { defaultShell } from "../shells";
import {
  plannedWorkerModel,
  rosterModelFor,
  sanitizeWorkerModelHint,
  WORKER_DEFAULT_CLAUDE_MODEL,
} from "./worker-model-hint";
import { shouldResumeForUserMessage } from "./user-message-resume";
import * as pty from "../pty-manager";
import {
  deleteAgentTerminalRun,
  fenceAgentTerminalRunDeleting,
  markAgentTerminalRunActive,
  settleAgentTerminalRun,
} from "../agent-terminal-lifecycle";
import { runStructuredWorker } from "./structured-worker";
import { detectWorkerAssignableRuntimes } from "./pi-worker-providers";
import { getProvider } from "../providers";
import type { SpawnOpts } from "../providers/types";
import {
  buildManagerTurnPrompt,
  isCheckpointJobCurrent,
  isManagerTurnCurrent,
  resolveChatBackendConfig,
  shouldIncludeCanonicalReplay,
  type ChatBackendConfig,
  type ChatStreamEvent,
} from "./spark-agent-backend";
import { disposeManagerSessions, getBackend } from "./backend-registry";
import { createRunRuntimeShutdown } from "./run-runtime-shutdown";
import {
  cleanupPiMcpBridgeConfig,
  createCodaraPiWorkerLaunchPlan,
  resolveCodaraPiExecutionAccount,
} from "./pi-runtime-electron";
import { PiRpcClient, type PiRpcEvent } from "./pi-rpc-client";
import type { PiSubscriptionProvider, PiThinkingLevel } from "./pi-runtime";
import { resolveCapturedWorkerConstitutionBlock } from "./worker-constitution-resolver";
import {
  unsupportedEnabledWorkerConstitutionReason,
  workerConstitutionLaunchSurface,
} from "./worker-constitution-support";
import {
  cleanupPrivateWorkerConstitutionPrompt,
  privateWorkerConstitutionPromptPath,
  writePrivateWorkerConstitutionPrompt,
} from "./worker-constitution-file";
import {
  normalizePiAccountProfileId,
  preserveFrozenPiAccountProfileId,
  selectPiWorkerAccountProfile,
} from "./pi-account-execution";
import {
  applyAtomicManagerCallSettlement,
  type AppliedManagerCallSettlementInput,
} from "./manager-call-settlement";
import {
  canonicalCodaraCompleteSummary,
  codaraCompleteReceiptForCall,
  codaraCompleteReceiptKey,
  hashCodaraCompletePayload,
  normalizeManagerApplicationReceipts,
} from "./manager-application-receipts";
import {
  rankImplicitPiAccounts,
  selectImplicitPiAccount,
} from "./pi-account-router";
import {
  abandonRunQuestionOwnership,
  applyRunQuestionAnswer,
  applyRunQuestionBlocker,
  claimPendingManagerResume,
  createRunBlocker,
  decideRunManagerQuestion,
  inferRunQuestionCategory,
  normalizeRunQuestionSignature,
  recoverPendingManagerResumeLease,
  releaseRunQuestionBlocker,
} from "./run-question-policy";

function piProviderForManagerModel(model: string): PiSubscriptionProvider {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-")) return "openai-codex";
  throw new Error(`Pi subscription backend does not support model ${model}`);
}

async function freezeManagerExecutionAccount(
  chat: ChatBackendConfig,
): Promise<ChatBackendConfig> {
  if (chat.backend === "claude") {
    const account = await nativeClaudeProfileStore.resolveProfile({
      profileId: chat.nativeClaudeProfileId,
      requireConnected: true,
    });
    return {
      ...chat,
      nativeClaudeProfileId: account.profileId,
    };
  }
  if (chat.backend === "codex") {
    const account = await nativeCodexProfileStore.resolveProfile({
      profileId: chat.nativeCodexProfileId,
      requireConnected: true,
    });
    return {
      ...chat,
      nativeCodexProfileId: account.profileId,
    };
  }
  if (chat.backend !== "pi") return chat;
  const account = await resolveCodaraPiExecutionAccount({
    provider: piProviderForManagerModel(chat.model),
    preferredAccountProfileId: chat.accountProfileId,
  });
  return {
    ...chat,
    accountProfileId: account.accountProfileId,
  };
}

async function pinImplicitPiManagerAccount(
  run: RunState,
): Promise<RunState> {
  const initial = resolveChatBackendConfig(run);
  if (
    initial.backend !== "pi" ||
    initial.accountProfileId ||
    run.sparkCalls.length > 0
  ) {
    return run;
  }
  const provider = piProviderForManagerModel(initial.model);
  const candidate = await selectImplicitPiAccount(provider, initial.model);
  if (!candidate) return run;

  // Re-resolve the route as an exact identity pin before persisting it. A
  // stale cached quota row may rank an account, but only the auth-store
  // resolver can authorize its private config root for execution.
  await resolveCodaraPiExecutionAccount({
    provider,
    preferredAccountProfileId: candidate.accountProfileId,
  });
  return commitRunChange(run, {
    type: "run.pi_account_profile_selected",
    message: candidate.knownLimitReached
      ? "Cora froze a connected subscription account before checking its live limit"
      : "Cora selected a connected subscription account for this chat",
    payload: {
      accountProfileId: candidate.accountProfileId,
      provider,
      selection: "implicit",
      ...(candidate.knownLimitReached ? { cachedLimitReached: true } : {}),
    },
    mutate: (draft, timestamp) => {
      const current = resolveChatBackendConfig(draft);
      if (
        current.backend !== "pi" ||
        current.accountProfileId ||
        draft.sparkCalls.length > 0 ||
        piProviderForManagerModel(current.model) !== provider
      ) {
        return false;
      }
      draft.chatAccountProfileId = candidate.accountProfileId;
      draft.updatedAt = timestamp;
    },
  });
}

type DirectNativeBackend = Extract<ChatBackendKind, "claude" | "codex">;

async function resolveSelectableNativeProfile(
  backend: DirectNativeBackend,
  profileId: string | null | undefined,
): Promise<string> {
  const input = profileId === null || profileId === undefined
    ? { useDefault: true as const, requireConnected: true }
    : { profileId, requireConnected: true };
  const resolved = backend === "claude"
    ? await nativeClaudeProfileStore.resolveProfile(input)
    : await nativeCodexProfileStore.resolveProfile(input);
  return resolved.profileId;
}

const RUN_FILE = "run.json";
const ESC_KEY = "\x1b";
const CONTINUE_INPUT = "continue\r";
const HUMAN_INPUT_PAUSE_REASON = "Cora needs human input before continuing.";
// How many run directories under ~/.SparkAgent/runs/ count toward retained
// history. Live/nonterminal runs never consume deletion eligibility: retain all
// of them even when they exceed this budget, then fill the remaining slots with
// the newest known-terminal runs.
const RUN_RETENTION_KEEP = 50;
const RUN_RETRY_REPAIR_READ_LIMIT = 64;
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
  processGenerationId: string;
  inputCapability: "pty" | "steer" | "none";
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
const activeManagerTurnRecoveries = new Map<string, Promise<void>>();
const activeConversationRewinds = new Map<string, Promise<UndoToCheckpointResult>>();
// Durable answer continuations are keyed by question identity until the intended
// manager stage claims their persisted pendingManagerResume record.
const activePendingManagerResumes = new Set<string>();
// Runs whose paused state is being lifted by a user message that just landed.
// One at a time per run: a burst of sends must produce one resume, not one per
// message (the later messages ride the same turn's queue).
const activeUserMessageResumes = new Set<string>();
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

const drainRunRuntimeResources = createRunRuntimeShutdown({
  activeWorkers: () => activeWorkerProcesses.values(),
  activeRunIds: () => runCache.keys(),
  persistedRunIds: () => fs.readdir(runsRoot()),
  disposeManagerSessions,
  killPty: (attemptId) => pty.killImmediate(attemptId),
  releaseWorker: (attemptId) => {
    activeWorkerProcesses.delete(attemptId);
  },
});

/**
 * Best-effort process-lifetime teardown for explicit application quit. Durable
 * run, worktree, and artifact data is intentionally left untouched.
 */
export function shutdownRunRuntimeResources(maxWaitMs?: number): Promise<void> {
  return drainRunRuntimeResources(maxWaitMs);
}

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

const appendBufferedEvent = (
  ...args: Parameters<typeof appendBufferedEventRaw>
): ReturnType<typeof appendBufferedEventRaw> => {
  assertManagerDecisionMutationCurrent(args[0].runId);
  return appendBufferedEventRaw(...args);
};

// One-shot per process: fired lazily from listRuns(). Keeps the runs/ dir
// from growing unbounded (see RUN_RETENTION_KEEP).
let didRetentionSweep = false;
const runDeletedListeners = new Set<
  (input: { workspaceId: string; runId: string }) => void | Promise<void>
>();
const runSavedListeners = new Set<
  (input: { workspaceId: string; runId: string }) => void | Promise<void>
>();

/**
 * Narrow lifecycle hook for durable indexes that point at run ids. The
 * run-store remains unaware of those indexes; listeners receive identities
 * only after the run directory and cache entry are gone.
 */
export function onRunDeleted(
  listener: (input: {
    workspaceId: string;
    runId: string;
  }) => void | Promise<void>,
): () => void {
  runDeletedListeners.add(listener);
  return () => runDeletedListeners.delete(listener);
}

/** Identity-only post-commit hook for bounded derived indexes and caches. */
export function onRunSaved(
  listener: (input: {
    workspaceId: string;
    runId: string;
  }) => void | Promise<void>,
): () => void {
  runSavedListeners.add(listener);
  return () => runSavedListeners.delete(listener);
}

export type RunLinkSummary = Pick<
  RunState,
  | "id"
  | "workspaceId"
  | "title"
  | "status"
  | "updatedAt"
  | "automationId"
  | "origin"
>;

const RUN_LINK_SUMMARY_READ_LIMIT = 64;

/**
 * Bounded queue-oriented projection. Every run.json may contribute only a
 * cheap filesystem timestamp; only the 64 most recently written bodies are
 * deserialized. This keeps an older, still-active run linkable after many
 * newer conversations were created without loading the complete run store.
 */
export async function listRecentRunLinkSummaries(
  requestedLimit = RUN_LINK_SUMMARY_READ_LIMIT,
): Promise<RunLinkSummary[]> {
  const limit = Math.max(
    0,
    Math.min(
      RUN_LINK_SUMMARY_READ_LIMIT,
      Number.isSafeInteger(requestedLimit)
        ? Math.floor(requestedLimit)
        : RUN_LINK_SUMMARY_READ_LIMIT,
    ),
  );
  if (limit === 0) return [];

  let names: string[];
  try {
    names = await fs.readdir(runsRoot());
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const candidates = await Promise.all(
    names.map(async (name) => {
      try {
        return { name, mtimeMs: (await fs.stat(runPath(name))).mtimeMs };
      } catch {
        return { name, mtimeMs: Number.NEGATIVE_INFINITY };
      }
    }),
  );
  const recent = candidates
    .sort(
      (left, right) =>
        right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name),
    )
    .slice(0, limit);
  const runs = await Promise.all(
    recent.map(({ name }) => getRun(name)),
  );
  return runs
    .filter((run): run is RunState => Boolean(run))
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, limit)
    .map((run) => ({
      id: run.id,
      workspaceId: run.workspaceId,
      title: run.title,
      status: run.status,
      updatedAt: run.updatedAt,
      ...(run.automationId ? { automationId: run.automationId } : {}),
      ...(run.origin ? { origin: run.origin } : {}),
    }));
}

interface RuntimeReroute {
  [key: string]: unknown;
  from: WorkerTask["runtimePreference"];
  to: WorkerTask["runtimePreference"];
  modelHint?: string;
  effortHint?: WorkerTask["effortHint"];
  reason: string;
}

/**
 * Runtime diagnostics for WORKER ASSIGNMENT, decorated with `workerAssignable`.
 *
 * Every caller of this helper is deciding where a worker goes, and workers run
 * on the bundled Pi harness, so the question is "is there a connected Pi
 * subscription for that provider", not "is the CLI binary on PATH". See
 * pi-worker-providers for the split. Surfaces that really do spawn the
 * binaries keep reading `installed` from detectAgentRuntimes directly.
 */
async function detectConfiguredAgentRuntimes(): Promise<AgentRuntimeDiagnostic[]> {
  return detectWorkerAssignableRuntimes();
}

/** Worker assignability for one runtimePreference within a decorated set. */
function runtimeAssignable(diagnostic: AgentRuntimeDiagnostic): boolean {
  return diagnostic.workerAssignable ?? diagnostic.installed;
}

const reservedRunCreations = new Map<string, Promise<RunState>>();

export async function createRun(input: CreateRunInput): Promise<RunState> {
  return createRunInternal(input);
}

/**
 * Crash-recovery seam for journaled PR imports. The id is preallocated before
 * Git/state side effects; replay returns only an exact authoritative match and
 * refuses an unrelated collision.
 */
export async function createRunWithReservedId(
  runId: string,
  input: CreateRunInput,
): Promise<RunState> {
  if (
    !/^run-pr-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      runId,
    )
  ) {
    throw new Error("Reserved pull-request run id is invalid.");
  }
  const inflight = reservedRunCreations.get(runId);
  if (inflight) return inflight;
  const operation = (async () => {
    const existing = await getRun(runId);
    if (existing) {
      const expectedOrigin = normalizeGitHubOrigin(input.origin);
      const exact =
        existing.workspaceId === input.workspaceId &&
        existing.settingsSnapshot?.workspaceCwd === input.cwd &&
        existing.projectPolicyMode ===
          resolveProjectPolicyMode({
            origin: expectedOrigin,
            projectPolicyMode: input.projectPolicyMode,
          }) &&
        JSON.stringify(existing.origin ?? null) ===
          JSON.stringify(expectedOrigin ?? null);
      if (!exact) {
        throw new Error("Reserved pull-request run id belongs to another run.");
      }
      return existing;
    }
    return createRunInternal(input, runId);
  })();
  reservedRunCreations.set(runId, operation);
  try {
    return await operation;
  } finally {
    if (reservedRunCreations.get(runId) === operation) {
      reservedRunCreations.delete(runId);
    }
  }
}

async function createRunInternal(
  input: CreateRunInput,
  reservedRunId?: string,
): Promise<RunState> {
  const now = new Date().toISOString();
  const origin = normalizeGitHubOrigin(input.origin);
  const projectPolicyMode = resolveProjectPolicyMode({
    origin,
    projectPolicyMode: input.projectPolicyMode,
  });
  const projectConstitution =
    projectPolicyMode === "trusted"
      ? await readProjectConstitutionSnapshot(input.cwd)
      : null;
  const initialBackend = input.chatBackend ?? "pi";
  if (
    projectPolicyMode === "untrusted-pull-request" &&
    initialBackend !== "pi"
  ) {
    throw new Error(
      "Imported pull-request runs currently require Cora · Pi so repository-owned agent policy stays disabled.",
    );
  }
  // Account selection is not a per-chat input: native backends freeze the
  // provider's active account from Settings at creation.
  const initialNativeCodexProfileId =
    initialBackend === "codex"
      ? await resolveSelectableNativeProfile("codex", undefined)
      : null;
  const initialNativeClaudeProfileId =
    initialBackend === "claude"
      ? await resolveSelectableNativeProfile("claude", undefined)
      : null;
  const initialChatFlags = normalizeChatFeatureFlags(initialBackend, {
    chat1mContext: input.chat1mContext,
  });
  // This is the only global-constitution read in the managed-run lifecycle.
  // Retries, resumes, compaction, and reserved-id replay inherit this exact
  // pointer from the run and never consult current Settings again.
  const userConstitution = await captureCurrentUserConstitution();
  const run: RunState = {
    id: reservedRunId ?? makeId("run"),
    workspaceId: input.workspaceId,
    origin,
    projectPolicyMode,
    title: input.title?.trim() || `Run - ${input.workspaceName}`,
    status: "idle",
    settingsSnapshot: {
      workspaceCwd: input.cwd,
      projectPolicyMode,
    },
    ...(projectConstitution ? { projectConstitution } : {}),
    userConstitution: copyUserConstitutionCapture(userConstitution),
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
    ...(initialNativeCodexProfileId
      ? { nativeCodexProfileId: initialNativeCodexProfileId }
      : {}),
    ...(initialNativeClaudeProfileId
      ? { nativeClaudeProfileId: initialNativeClaudeProfileId }
      : {}),
    coraExecutionPolicy: input.coraExecutionPolicy === undefined
      ? undefined
      : normalizeCoraExecutionPolicy(input.coraExecutionPolicy),
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
  if (projectPolicyMode === "trusted") {
    void recordCheckpointInBackground({
      runId: run.id,
      cwd: input.cwd,
      kind: "run-start",
      messagePointer: 0,
      label: "Chat start",
      conversationEpoch: 0,
    });
  }

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
      // A failed/cancelled sandbox may still be the only copy of a worker's
      // edits. removeSandboxWorktree force-removes its directory before the
      // safe branch deletion runs, so retention must never send an
      // un-reconciled attempt through deleteRun.
      if (unreconciledSandboxAttempts(latest).length > 0) return;
      await deleteRun(runId);
    });
  runMutationQueues.set(runId, next);
  try {
    await next;
  } finally {
    if (runMutationQueues.get(runId) === next) runMutationQueues.delete(runId);
  }
}

function unreconciledSandboxAttempts(run: RunState): WorkerAttempt[] {
  return run.workerAttempts.filter(
    (attempt) =>
      Boolean(
        attempt.sandboxWorktreePath &&
          attempt.sandboxBranch &&
          attempt.sandboxBaseRepo,
      ) && attempt.sandboxMergedBack !== true,
  );
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

/**
 * One-time legacy repair surface for durable retry indexes. Directory metadata
 * may be inspected to find the newest candidates, but no more than 64 run
 * bodies are ever read. Normal indexed retries use getRun(runId) directly.
 */
export async function listRecentRunsForRetryRepair(
  requestedLimit = RUN_RETRY_REPAIR_READ_LIMIT,
): Promise<{ runs: RunState[]; truncated: boolean }> {
  const limit = Math.max(
    0,
    Math.min(
      RUN_RETRY_REPAIR_READ_LIMIT,
      Number.isSafeInteger(requestedLimit)
        ? Math.floor(requestedLimit)
        : RUN_RETRY_REPAIR_READ_LIMIT,
    ),
  );
  if (limit === 0) return { runs: [], truncated: true };
  let names: string[];
  try {
    names = await fs.readdir(runsRoot());
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { runs: [], truncated: false };
    }
    throw err;
  }
  const candidates = await Promise.all(
    names.map(async (name) => {
      try {
        return { name, mtimeMs: (await fs.stat(runPath(name))).mtimeMs };
      } catch {
        return { name, mtimeMs: Number.NEGATIVE_INFINITY };
      }
    }),
  );
  const recent = candidates
    .sort(
      (left, right) =>
        right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name),
    )
    .slice(0, limit);
  const runs = await Promise.all(recent.map(({ name }) => getRun(name)));
  return {
    runs: runs.filter((run): run is RunState => Boolean(run)),
    truncated: candidates.length > recent.length,
  };
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
      origin: input.origin,
      projectPolicyMode: input.projectPolicyMode,
      title: chatTitleFromInput(input),
      // Engine choice from the "Run plan" / "Smart Merge" pickers and from
      // per-automation loop config. Threading these through createRun stamps
      // run.chatBackend/chatModel/chatMode/chatEffort so askManagerBackend
      // dispatches to the right manager backend with the right model.
      // Undefined → Pi + backend defaults.
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

  // The manager transports intentionally consume only durable queued human
  // messages. A "Run plan" invocation historically persisted planText in
  // run.plans without queueing a turn, so the manager received "There is no
  // new user message" and could mark untouched work complete. Mirror the plan
  // into one stable user turn. A stable client id makes re-entered
  // startAutopilot calls idempotent.
  const cliManagerNeedsPlanTurn = Boolean(planText);
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
    run = fastPathPlan ?? ((await askManagerBackend(run, input.cwd, "step_planning")) ?? run);
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
    // Say WHY there is nothing to run. "I could not find a ready task" reads as
    // the model being confused, when the usual cause is concrete and visible in
    // the plan, most often every step already failed. Naming the real state
    // tells the user what decision is actually in front of them.
    const failedSteps = run.steps.filter((step) => step.status === "failed");
    const unfinishedSteps = run.steps.filter(
      (step) => !["complete", "completed_unverified", "failed", "skipped"].includes(step.status),
    );
    // Every step complete, every worker task accepted, nothing in flight: the
    // manager's own turn WAS the run, and it ended without codara_complete
    // (execute/auto CLI managers reach here whenever that happens, since
    // runAutopilotWorkerCycle deliberately skips scheduleAutopilotReview for
    // them). Finish the run instead of asking the user about work that is
    // already done. Reversible: a later user message reopens it through the
    // steering-followup path. Completion still has to earn the same verifier
    // freshness codara_complete demands: an execute/auto CLI manager
    // auto-accepts a task on process exit without reading its report, so
    // "everything accepted" is not evidence anything was verified.
    if (isRunSettled(run)) {
      const verification = await describeVerificationFreshness(run);
      if (verification.ok) {
        return completeRunFromOrchestrator(run.id);
      }
      return askHumanQuestion(run.id, UNVERIFIED_COMPLETION_QUESTION, undefined, {
        reason: `Latest verifier confidence: ${verification.latestVerifierConfidence ?? "none"}.`,
        managerMode: "worker_result_review",
      });
    }
    // A step sitting in review is NOT blocked on the user, it is blocked on
    // Cora. Boot recovery produces exactly this shape (a worker whose report
    // was already on disk becomes needs_review), so asking the user to unblock
    // it would be both wrong and the most likely message they ever see after a
    // restart. Re-drive the review instead of asking.
    const reviewPending = run.steps.some((step) => step.status === "reviewing");
    if (reviewPending) {
      scheduleAutopilotReview(run.id, input.cwd);
      return run;
    }
    const question =
      run.steps.length > 0 && failedSteps.length > 0 && unfinishedSteps.length === 0
        ? failedSteps.length === run.steps.length
          ? "Every step in this plan has failed, so there is nothing left to run. Tell me how you'd like to proceed, retry the work, change the approach, or start over."
          : `${failedSteps.length} of ${run.steps.length} steps failed and the rest are finished, so there is nothing left to run. Tell me whether to retry the failed work or move on.`
        : run.steps.length === 0
          ? "I don't have a plan to run yet. Tell me what you'd like me to do."
          : "None of the remaining steps has runnable work, they're waiting on something I can't resolve myself. Tell me how you'd like to proceed.";
    return askHumanQuestion(run.id, question, undefined, {
      reason: "No safe runnable task can be inferred from the current plan.",
      managerMode: run.workerAttempts.length > 0 ? "worker_result_review" : "plan_analysis",
    });
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

// The same set under a name that does not imply direct runs, managed-run boot
// recovery needs it too, and "DIRECT_" reads as a scope restriction it never
// had. Aliased rather than renamed so the direct-run call sites stay legible
// against their own comments.
const ATTEMPT_TERMINAL_STATUSES = DIRECT_ATTEMPT_TERMINAL;

// Does this path exist? Boot recovery uses it to decide whether a worker that
// vanished with the app had already written its final report.
async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

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
    origin: input.origin,
    projectPolicyMode: input.projectPolicyMode,
    title: input.title,
    automationId: input.automationId,
    executionMode: "direct",
  });
  run = await commitRunChange(run, {
    type: "direct_run.started",
    message: "Loom direct-worker run started",
    payload: { automationId: input.automationId, model: input.model ?? null },
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
// cost accumulates and the transcript carries across passes. The model/effort
// may differ per pass — the launcher reads them per task.
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
      payload: { model: input.model ?? null, effort: input.effort ?? null },
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
    payload: { model: input.model ?? null, effort: input.effort ?? null },
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
  model: string;
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
        worker: { model: opts.model, effort: opts.effort ?? "medium" },
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

  // Looms on Pi: a node's runtime family is derived from its model id (gpt-* →
  // codex provider, everything else → claude provider). No install detection —
  // the Pi runtime ships with the app.
  const runtimeOf = (worker: LoomWorkerConfig): WorkerRuntime =>
    loomRuntimeForModel(worker.model);

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
    model: node.worker.model,
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
      runtimePreference: runtimeOf(node.worker),
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
      runtimePreference: runtimeOf(node.worker),
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

// Reject before launch without pretending that a process started. The event
// and persisted reason are deliberately content-free: no captured body,
// revision, digest, command, argv, or environment crosses this seam.
async function rejectWorkerAttemptLaunchForUnsupportedConstitution(
  runId: string,
  attemptId: string,
  error: string,
): Promise<RunState> {
  const run = await requireRun(runId);
  await commitRunChange(run, {
    type: "worker_attempt.launch_rejected",
    message: `Worker attempt launch rejected: ${error}`,
    payload: { attemptId, error },
    mutate: (draft, timestamp) => {
      const attempt = draft.workerAttempts.find((item) => item.id === attemptId);
      if (!attempt || (attempt.status !== "prompt_ready" && attempt.status !== "failed")) {
        return false;
      }
      attempt.status = "failed";
      attempt.startedAt = undefined;
      attempt.finishedAt = timestamp;
      attempt.exitCode = undefined;
      attempt.error = error;
      attempt.failureKind = classifyWorkerFailure(error);
      attempt.command = undefined;
      const task = draft.workerTasks.find((item) => item.id === attempt.workerTaskId);
      if (task && !["accepted", "cancelled"].includes(task.status)) {
        task.status = "failed";
        task.updatedAt = timestamp;
      }
      const step = task?.stepId
        ? draft.steps.find((item) => item.id === task.stepId)
        : undefined;
      if (
        step &&
        !["complete", "completed_unverified", "skipped"].includes(step.status)
      ) {
        step.status = "failed";
        step.updatedAt = timestamp;
        if (draft.currentStepId === step.id) draft.currentStepId = undefined;
      }
      draft.updatedAt = timestamp;
    },
  });
  const latest = await requireRun(runId);
  if (latest.executionMode === "direct") await finalizeDirectRun(runId);
  return requireRun(runId);
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
        a.failureKind = classifyWorkerFailure(error);
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
      pty.dispose(attemptId, { sanctioned: true });
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

/**
 * Sending into a paused run resumes it, carrying the message.
 *
 * A user who pauses, types, and hits send has already said what they want:
 * continue, with this. Before this, the message was recorded and then nothing
 * happened — scheduleQueuedSteeringFollowup returns early while paused and
 * only resumeRun consumes the queue, so the text sat there until the user
 * found the Resume button (run-msa0s2t6-sz26w1). The send arrow and Resume are
 * now the same act, and resumeRun is the single path both take, so a message
 * cannot resume a run by some second, divergent route.
 *
 * Deliberately scoped to `paused`, which covers BOTH a user force-pause and a
 * run the manager-turn failure policy parked (provider overload, billing):
 * both leave the run waiting on a human, and in both the human just spoke.
 * Excluded:
 *   - "blocked": an open question is answered through answerRunQuestion long
 *     before this point, and it owns its own continuation
 *     (schedulePendingManagerResume).
 *   - terminal runs: the revived-terminal branch in addRunMessage replans them.
 *   - direct/loom runs: the loop driver decides what runs next.
 */
function scheduleResumeForUserMessage(
  run: RunState,
  intent: RunConversationMessageIntent,
): void {
  if (!shouldResumeForUserMessage(run, intent)) return;
  if (activeUserMessageResumes.has(run.id)) return;
  const scheduledEpoch = conversationEpoch(run);
  activeUserMessageResumes.add(run.id);

  // Same ordering discipline as the other schedulers: never start a turn on
  // top of planning/review work that is still settling.
  const waits = [activeAutopilotPlans.get(run.id), activeAutopilotReviews.get(run.id)].filter(
    (promise): promise is Promise<void> => Boolean(promise),
  );
  void Promise.all(waits.map((promise) => promise.catch(() => undefined)))
    .then(async () => {
      const latest = await getRun(run.id);
      if (!latest || conversationEpoch(latest) !== scheduledEpoch) return;
      // Re-decide on the freshly read run: the Resume button, another client,
      // or a question arriving in the meantime may already own the next move.
      if (!shouldResumeForUserMessage(latest, intent)) return;
      await resumeRun({ runId: latest.id });
    })
    .catch(async (err) => {
      // Leave the run paused and usable — the Resume button is still there.
      // Journal the failure so a resume that never happened is visible in the
      // run's history instead of reading as another silent send.
      const error = err instanceof Error ? err.message : String(err);
      await appendEvent({
        workspaceId: run.workspaceId,
        runId: run.id,
        type: "run.auto_resume_failed",
        message: `Resuming after a user message failed: ${error}`,
        payload: { error },
      }).catch(() => undefined);
    })
    .finally(() => {
      activeUserMessageResumes.delete(run.id);
    });
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

async function clearRegisteredManagerTurnRecovery(
  runId: string,
  launchClaimId: string,
  sparkCallId: string,
): Promise<void> {
  const run = await requireRun(runId);
  await commitRunChange(run, {
    type: "run.manager_turn_recovery_completed",
    message: "Parked manager turn resumed successfully",
    payload: { launchClaimId, sparkCallId },
    mutate: (draft, timestamp) => {
      const recovery = draft.managerTurnRecovery;
      if (
        !recovery ||
        recovery.state !== "resuming" ||
        recovery.resumeClaimId !== launchClaimId ||
        recovery.conversationEpoch !== conversationEpoch(draft)
      ) {
        return false;
      }
      const call = draft.sparkCalls.find(
        (entry) =>
          entry.id === sparkCallId &&
          entry.managerRecoveryClaimId === launchClaimId &&
          (entry.conversationEpoch ?? 0) === recovery.conversationEpoch &&
          entry.status === "completed",
      );
      if (!call) return false;
      if (
        recovery.resumeAccountProfileId &&
        call.accountProfileId !== recovery.resumeAccountProfileId &&
        call.nativeClaudeProfileId !== recovery.resumeAccountProfileId &&
        call.nativeCodexProfileId !== recovery.resumeAccountProfileId
      ) {
        return false;
      }
      delete draft.managerTurnRecovery;
      draft.updatedAt = timestamp;
    },
  });
}

async function settleAppliedManagerCall(
  run: RunState,
  input: AppliedManagerCallSettlementInput,
): Promise<RunState> {
  return commitRunChange(run, {
    type: "spark_call.completed",
    message: "Cora manager decision applied and settled",
    sparkCallId: input.callId,
    payload: {
      callId: input.callId,
      conversationEpoch: input.conversationEpoch,
      managerResumeClaimId: input.managerResumeClaimId,
      managerRecoveryClaimId: input.managerRecoveryClaimId,
    },
    mutate: (draft, timestamp) => {
      if (!applyAtomicManagerCallSettlement(draft, input, timestamp)) return false;
      recomputeRunCostRollups(draft);
      draft.updatedAt = timestamp;
    },
  });
}

async function runManagerStageAfterQuestion(
  run: RunState,
  cwd: string,
  mode: SparkCall["mode"],
  managerResumeClaimId?: string,
  autonomyRetryCount = 0,
  managerRecoveryClaimId?: string,
): Promise<void> {
  if (mode === "chat" || mode === "plan_analysis") {
    await runInitialAutopilotPlanning(
      run.id,
      autopilotInputFromRun(run),
      mode,
      managerResumeClaimId,
      autonomyRetryCount,
      managerRecoveryClaimId,
    );
    return;
  }
  if (mode === "worker_result_review") {
    await runAutopilotManagerReview(
      run.id,
      cwd,
      managerResumeClaimId,
      managerRecoveryClaimId,
    );
    return;
  }

  const decided = await askManagerBackend(
    run,
    cwd,
    mode,
    managerResumeClaimId,
    autonomyRetryCount,
    0,
    managerRecoveryClaimId,
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

/** Stamped on every manager turn this pass fails. It is the ONLY durable trace
 * that a turn was cut off mid-work: once this pass has run, the call is
 * "failed" like any other, so a later boot step cannot use "started with no
 * completedAt" to recognize an interrupted turn (see interruptedManagerCall). */
export const MANAGER_TURN_INTERRUPTED_ERROR = "Manager turn interrupted by application restart.";
export const MANAGER_APPLICATION_RECOVERY_INTEGRITY_ERROR =
  "Manager effects may already be applied, but their durable receipt could not be settled safely; provider replay was suppressed.";

/** Repair manager turns that were durable but had no live driver after process
 * exit. Ordinary interrupted calls release their input for a user-approved
 * retry. Calls carrying an effects_applied receipt settle locally and
 * acknowledge their exact input instead, so provider replay cannot duplicate
 * the already-applied completion. */
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
    const interruptedIds = new Set(
      orphaned
        .filter(
          (call) =>
            call.applicationReceiptIntegrity !== "invalid" &&
            !codaraCompleteReceiptForCall(call),
        )
        .map((call) => call.id),
    );

    const recovered = await commitRunChange(run, {
      type: "run.manager_turns_recovered",
      message: `Recovered ${orphaned.length} interrupted manager turn(s) after restart`,
      payload: {
        callIds: [...orphanedIds],
        interruptedCallIds: [...interruptedIds],
        conversationEpoch: epoch,
      },
      mutate: (draft, timestamp) => {
        if (conversationEpoch(draft) !== epoch) return false;
        let changed = false;
        for (const call of draft.sparkCalls) {
          if (!orphanedIds.has(call.id) || call.status !== "started") continue;

          const receipt = codaraCompleteReceiptForCall(call);
          if (receipt) {
            const settled = applyAtomicManagerCallSettlement(
              draft,
              {
                callId: call.id,
                conversationEpoch: epoch,
                applicationProof: {
                  kind: "durable-effects-applied",
                  receiptKey: receipt.key,
                },
                managerResumeClaimId: call.managerResumeClaimId,
                managerRecoveryClaimId: call.managerRecoveryClaimId,
                managerRecoveryClaimedAccountProfileId:
                  receipt.recoveryAccountProfileId,
              },
              timestamp,
            );
            if (settled) {
              changed = true;
              continue;
            }
            // A receipt is an irreversible replay fence. If ownership was
            // hand-edited or otherwise cannot pass the exact settlement
            // checks, close the local call and acknowledge its inputs rather
            // than converting an already-applied effect back into provider
            // work.
            call.status = "failed";
            call.error = MANAGER_APPLICATION_RECOVERY_INTEGRITY_ERROR;
            call.completedAt = timestamp;
            for (const message of draft.humanMessages) {
              if (
                message.backendTurnId !== call.id &&
                !(call.inputMessageIds ?? []).includes(message.id)
              ) {
                continue;
              }
              if (message.deliveryState !== "cancelled") {
                message.deliveryState = "acknowledged";
              }
            }
            if (
              call.managerResumeClaimId &&
              draft.pendingManagerResume?.launchClaimId === call.managerResumeClaimId
            ) {
              delete draft.pendingManagerResume;
            }
            if (
              call.managerRecoveryClaimId &&
              draft.managerTurnRecovery?.resumeClaimId === call.managerRecoveryClaimId
            ) {
              delete draft.managerTurnRecovery;
            }
            changed = true;
            continue;
          }

          if (call.applicationReceiptIntegrity === "invalid") {
            // Normalization found a receipt-shaped record it could not trust.
            // Treat that as "effects may have landed": fail closed locally,
            // acknowledge the owned input, and never release it for replay.
            call.status = "failed";
            call.error = MANAGER_APPLICATION_RECOVERY_INTEGRITY_ERROR;
            call.completedAt = timestamp;
            for (const message of draft.humanMessages) {
              if (
                message.backendTurnId !== call.id &&
                !(call.inputMessageIds ?? []).includes(message.id)
              ) {
                continue;
              }
              if (message.deliveryState !== "cancelled") {
                message.deliveryState = "acknowledged";
              }
            }
            if (
              call.managerResumeClaimId &&
              draft.pendingManagerResume?.launchClaimId === call.managerResumeClaimId
            ) {
              delete draft.pendingManagerResume;
            }
            if (
              call.managerRecoveryClaimId &&
              draft.managerTurnRecovery?.resumeClaimId === call.managerRecoveryClaimId
            ) {
              delete draft.managerTurnRecovery;
            }
            changed = true;
            continue;
          }

          call.status = "failed";
          call.error = MANAGER_TURN_INTERRUPTED_ERROR;
          call.completedAt = timestamp;
          changed = true;
        }
        for (const message of draft.humanMessages) {
          if (!message.backendTurnId || !interruptedIds.has(message.backendTurnId)) continue;
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
            .find(
              (call) =>
                interruptedIds.has(call.id) && Boolean(call.managerResumeClaimId),
            );
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
        recomputeRunCostRollups(draft);
        draft.updatedAt = timestamp;
      },
    });
    void recovered;
    // Deliberately does NOT re-drive the run. Restarting the app is not consent
    // to resume: this pass repairs the record (the interrupted turn is failed,
    // its input returns to queued, an answered question's continuation returns
    // to pending) and stops there. pauseManagedRunsAfterRestart then parks the
    // run, and the user's Resume, which re-drives everything, including a
    // queued input and a pending continuation, is what starts work again.
  }
}

/**
 * Repair durable parked-turn launch claims after orphaned SparkCalls have been
 * settled. A completed linked call proves recovery landed and clears the
 * token; every other resuming claim returns to the same user-owned parked
 * token without starting work during boot.
 */
export async function recoverManagerTurnRecoveries(): Promise<void> {
  const runs = await listRuns();
  for (const run of runs) {
    const recovery = run.managerTurnRecovery;
    if (!recovery) continue;
    if (recovery.state === "parked") continue;
    const claimId = recovery.resumeClaimId;
    if (!claimId) {
      // normalizeRun normally repairs this shape, but keep boot recovery
      // defensive against an in-memory record written by an older process.
      await commitRunChange(run, {
        type: "run.manager_turn_recovery_repaired",
        message: "Recovered an incomplete manager turn recovery claim",
        mutate: (draft, timestamp) => {
          const current = draft.managerTurnRecovery;
          if (!current || current.id !== recovery.id) return false;
          current.state = "parked";
          delete current.resumeClaimId;
          delete current.resumeRequestedAt;
          draft.status = "paused";
          draft.updatedAt = timestamp;
        },
      }).catch(() => undefined);
      continue;
    }
    const linked = [...run.sparkCalls]
      .reverse()
      .find((call) => call.managerRecoveryClaimId === claimId);
    if (linked?.status === "completed") {
      await clearRegisteredManagerTurnRecovery(
        run.id,
        claimId,
        linked.id,
      ).catch(() => undefined);
      const afterClear = await getRun(run.id);
      if (afterClear?.managerTurnRecovery?.resumeClaimId !== claimId) {
        continue;
      }
    }
    await returnUnfinishedManagerRecoveryToParked(
      run.id,
      claimId,
      recovery.conversationEpoch,
      "The application restarted before the replacement manager turn completed.",
    ).catch(() => undefined);
  }
}

/**
 * Boot recovery for MANAGED (non-direct) runs' worker attempts.
 *
 * Direct/loom runs get recoverDirectRuns (direct-worker.ts); orchestrated runs
 * got nothing, so an attempt left non-terminal when the app died stayed
 * "running" forever. Every mechanism that can end a worker attempt lives in
 * memory, the Pi RPC client's child exit listeners, the final-report poll, the
 * 90-minute cap, so all of them die with the process and none is re-armed at
 * boot. The stale attempt then wedges the run shut: startAutopilot's
 * attemptInFlight guard returns quietly while any attempt is non-terminal,
 * deferring to "the real driver (resume, worker finish, or review)" that no
 * longer exists. Observed on run-mrzgc7xm-u7ljcx.
 *
 * This is EXIT detection, not stuck detection. A worker is a child of the main
 * process, so at boot the absence of its live handle IS proof that it died , 
 * nothing here is time-based and nothing polls. (The deleted stuck-worker
 * watchdog is unrelated: it only ever covered the legacy PTY path, never Pi
 * workers, and being an in-process interval it died with the app too.)
 *
 * Report-first, mirroring recoverDirectRuns: a worker that finished before the
 * app went away left final-report.json on disk, and that work is kept rather
 * than discarded.
 */
export async function recoverOrphanedManagedWorkerAttempts(): Promise<void> {
  let runs: RunState[];
  try {
    runs = await listRuns();
  } catch {
    return;
  }
  for (const run of runs) {
    // Direct runs are recoverDirectRuns' job, it can relaunch them, which
    // needs loom ownership checks this pass has no business making.
    if (run.executionMode === "direct") continue;
    if (isTerminalRunStatus(run.status)) continue;
    // Paused and blocked runs are NOT skipped. Their status is user-owned and
    // this pass never changes it, but their worker processes died with the
    // app just the same, and leaving those attempts non-terminal reproduces
    // the original bug precisely where a human is already waiting: the user
    // answers the question, startAutopilot hits its attemptInFlight guard, and
    // nothing happens. Settling the corpse is what makes their answer work.

    const orphaned = run.workerAttempts.filter(
      (attempt) =>
        !ATTEMPT_TERMINAL_STATUSES.has(attempt.status) &&
        // A "prompt_ready" attempt was PREPARED but never launched, it has no
        // process because it never had one, not because it died. Failing it
        // would be both a lie and destructive: the cascade marks its step
        // failed, which is terminal, so the step's work would be skipped
        // forever. startAutopilot deliberately REUSES a prompt_ready attempt on
        // the next launch, so leaving it alone is what lets the run pick that
        // work back up.
        attempt.status !== "preparing" &&
        attempt.status !== "prompt_ready" &&
        // Guard against dev hot-reload re-entering recovery inside a process
        // whose workers are genuinely still alive. In a real boot neither of
        // these in-memory handles can exist.
        !pty.exists(attempt.id) &&
        !activeWorkerProcesses.has(attempt.id),
    );
    if (orphaned.length === 0) continue;

    for (const attempt of orphaned) {
      const reportOnDisk = attempt.finalReportPath
        ? await fileExists(attempt.finalReportPath)
        : false;
      if (reportOnDisk) {
        // The worker finished; only the bookkeeping was lost. Settle it exactly
        // as the live finish path would (attempt succeeded -> task needs_review
        // -> step reviewing) so the normal review funnel can pick it up instead
        // of the work being thrown away.
        await commitRunChange(run, {
          type: "worker_attempt.recovered",
          message: "Worker finished before the app closed; recovered its report after restart",
          payload: { attemptId: attempt.id },
          mutate: (draft, timestamp) => {
            const a = draft.workerAttempts.find((x) => x.id === attempt.id);
            if (!a || ATTEMPT_TERMINAL_STATUSES.has(a.status)) return false;
            a.status = "succeeded";
            a.finishedAt = a.finishedAt ?? timestamp;
            a.runtimeState = "done";
            a.runtimeStateUpdatedAt = timestamp;
            const t = draft.workerTasks.find((x) => x.id === a.workerTaskId);
            if (t && !["accepted", "failed", "cancelled"].includes(t.status)) {
              t.status = "needs_review";
              t.updatedAt = timestamp;
            }
            const s = t?.stepId ? draft.steps.find((x) => x.id === t.stepId) : undefined;
            if (
              s &&
              !["complete", "completed_unverified", "failed", "skipped"].includes(s.status) &&
              !hasActiveStepWorkers(draft, s.id, t?.id)
            ) {
              s.status = "reviewing";
              s.updatedAt = timestamp;
            }
            draft.updatedAt = timestamp;
          },
        }).catch(() => undefined);
        // A sandboxed worker ran in an isolated worktree, so its edits have not
        // touched the workspace yet, the live finish path merges them back and
        // the direct-run recovery does the same. Without this the run would
        // record the work as done while the workspace contains none of it, and
        // the worktree is later destroyed with the run: silent loss of a
        // completed worker's entire diff. Best-effort, exactly as the other two
        // call paths treat it; sandboxMergedBack keeps it from double-applying.
        await mergeBackRecoveredSandbox(run.id, attempt.id).catch(() => undefined);
        continue;
      }
      // No report: the worker died mid-turn. Say so plainly rather than
      // leaving a phantom spinner. failWorkerAttempt cascades attempt -> task
      // -> step, is idempotent, and its finalizeDirectRun tail is gated on
      // executionMode === "direct", so it is safe here.
      await failWorkerAttempt(
        run.id,
        attempt.id,
        "the app closed while this worker was running; its process is gone",
      ).catch(() => undefined);
      // requireRun is awaited as an ARGUMENT, so its rejection would escape the
      // trailing .catch and abort recovery for every remaining run. A run
      // deleted between listRuns() and here is entirely possible, so resolve it
      // defensively first.
      const refreshed = await getRun(run.id).catch(() => undefined);
      if (!refreshed) continue;
      await commitRunChange(refreshed, {
        type: "worker_attempt.runtime_state_changed",
        message: "Worker runtime state cleared after restart",
        payload: { attemptId: attempt.id, state: "error" },
        mutate: (draft, timestamp) => {
          const a = draft.workerAttempts.find((x) => x.id === attempt.id);
          // The stale "working" chip must not outlive the process it described.
          if (!a || a.runtimeState === "error") return false;
          a.runtimeState = "error";
          a.runtimeStateUpdatedAt = timestamp;
          draft.updatedAt = timestamp;
        },
      }).catch(() => undefined);
    }
  }
}

const PASSING_VERIFIER_CONFIDENCES = new Set(["PERFECT", "VERIFIED", "PARTIAL"]);

export interface RunVerificationFreshness {
  /** false when the latest files-changing report has no newer passing verdict. */
  ok: boolean;
  latestVerifierConfidence: string | null;
  latestChangedImplementationAt: number;
  latestPassingVerifierAt: number;
  /**
   * A verifier covering the CURRENT tree that did not pass. Set even when a
   * sibling verifier in the same round did pass, which is the whole point:
   * scope-split rounds expect some shards to fail, and the failing one owns
   * the verdict for the round.
   */
  blockingVerifier: { confidence: string; title: string } | null;
}

/**
 * Verification freshness invariant: an earlier green verifier does not cover a
 * later corrective edit, and a FEEDBACK report is evidence of a defect rather
 * than permission to land, so every files-changing implementation needs a
 * terminal-OK verifier verdict AFTER it before a run may be called done.
 *
 * Shared rule, one implementation. codara_complete rejects the manager on it
 * (agent-socket handleOrchestratorComplete) and the orchestrator-side terminal
 * hops gate on it too: an execute/auto CLI manager auto-accepts a worker task
 * the moment the process exits, without reading the report, so "every task
 * accepted" alone is not evidence that anything was verified.
 */
export async function describeVerificationFreshness(
  run: RunState,
): Promise<RunVerificationFreshness> {
  let latestChangedImplementationAt = 0;
  let latestVerifierConfidence: string | null = null;
  const verdicts: Array<{ at: number; confidence: string; title: string }> = [];
  for (const attempt of run.workerAttempts ?? []) {
    if (!attempt.finalReportPath) continue;
    const task = (run.workerTasks ?? []).find((candidate) => candidate.id === attempt.workerTaskId);
    if (!task) continue;
    const report = await readWorkerReport(attempt.finalReportPath).catch(() => null);
    if (!report) continue;
    const finishedAt = Date.parse(attempt.finishedAt ?? attempt.startedAt ?? "") || 0;
    if (task.taskClass === "verifier" && report.verifier) {
      latestVerifierConfidence = report.verifier.confidence;
      verdicts.push({ at: finishedAt, confidence: report.verifier.confidence, title: task.title });
    } else if (report.filesChanged.length > 0) {
      latestChangedImplementationAt = Math.max(latestChangedImplementationAt, finishedAt);
    }
  }

  // Only verdicts that postdate the newest files-changing implementation say
  // anything about the current tree; an older FEEDBACK was answered by the
  // corrective edit that superseded it, which is what keeps the normal
  // fix -> verify -> fix -> verify loop able to finish.
  const current = verdicts.filter((v) => v.at >= latestChangedImplementationAt);
  const latestPassingVerifierAt = current
    .filter((v) => PASSING_VERIFIER_CONFIDENCES.has(v.confidence))
    .reduce((newest, v) => Math.max(newest, v.at), 0);
  // A passing verdict must not mask a failing sibling from the SAME round.
  // Previously this took the newest passing timestamp alone, so with two
  // verifiers over one tree a green one could carry a red one over the line.
  // That was mostly latent while every verifier covered the whole surface;
  // splitting a round into disjoint scopes makes "one shard fails" the
  // expected case, so the gate has to see the whole round, not its best member.
  const blocking = current.find((v) => !PASSING_VERIFIER_CONFIDENCES.has(v.confidence)) ?? null;
  return {
    ok:
      latestChangedImplementationAt === 0 ||
      (latestPassingVerifierAt >= latestChangedImplementationAt && blocking === null),
    latestVerifierConfidence,
    latestChangedImplementationAt,
    latestPassingVerifierAt,
    blockingVerifier: blocking ? { confidence: blocking.confidence, title: blocking.title } : null,
  };
}

export interface RunHandoffArtifactAudit {
  /** false when a worker-declared in-workspace artifact no longer exists. */
  ok: boolean;
  missing: Array<{ taskTitle: string; path: string; reuse: string }>;
}

/**
 * Deliverable-preservation invariant: handoff artifacts are output, not scratch.
 *
 * `handoff[]` is how a worker says "I left this on disk on purpose". Codara
 * injects those paths into later worker prompts and surfaces them to the
 * manager through wait_for_workers, so they are load-bearing inside the run,
 * and they are often the only thing the user actually bought: an investigation
 * whose entire deliverable is a written report has nothing else to show.
 *
 * Observed live (run-msatwoee-dqndvr): two read-only investigators spent ~$19
 * writing research/codex-fast-mode/{claude,codex}.md and both declared them in
 * handoff[] with reuse "Keep it read-only". In its final turn the manager ran
 * `rm -rf research/codex-fast-mode` bundled into a tidy-the-tree command, after
 * the verifier had already passed, and said nothing about it in the completion
 * summary. Every existing gate was green: the files were untracked, so no diff
 * showed the loss, and the reports were only recoverable from a dangling
 * pre-worker checkpoint commit.
 *
 * Only paths INSIDE the workspace are audited. A handoff pointing at a temp dir
 * or a torn-down sandbox worktree is legitimately transient, and failing on
 * those would wedge runs for no gain.
 */
export async function describeMissingHandoffArtifacts(
  run: RunState,
): Promise<RunHandoffArtifactAudit> {
  const cwd = workspaceCwdFromRun(run);
  if (!cwd) return { ok: true, missing: [] };
  const workspaceRoot = resolvePath(cwd);
  const missing: RunHandoffArtifactAudit["missing"] = [];
  const seen = new Set<string>();
  for (const attempt of run.workerAttempts ?? []) {
    if (!attempt.finalReportPath) continue;
    const report = await readWorkerReport(attempt.finalReportPath).catch(() => null);
    if (!report?.handoff?.length) continue;
    const task = (run.workerTasks ?? []).find((candidate) => candidate.id === attempt.workerTaskId);
    for (const artifact of report.handoff) {
      if (!artifact?.path) continue;
      const target = resolvePath(workspaceRoot, artifact.path);
      if (target !== workspaceRoot && !target.startsWith(workspaceRoot + sep)) continue;
      if (seen.has(target)) continue;
      seen.add(target);
      const exists = await fs.access(target).then(
        () => true,
        () => false,
      );
      if (exists) continue;
      missing.push({
        taskTitle: task?.title ?? attempt.workerTaskId,
        path: artifact.path,
        reuse: artifact.reuse,
      });
    }
  }
  return { ok: missing.length === 0, missing };
}

/** Asked instead of completing when the work is finished but unverified. The
 * run stays reviewable and the user owns the call, rather than a cap-broken or
 * never-verified run being reported as a clean green finish. */
const UNVERIFIED_COMPLETION_QUESTION =
  "Every worker finished, but the latest code changes never earned a passing verifier verdict, so I won't mark this done on my own. Tell me whether to run a verifier over the final state or accept the work as it stands.";

/**
 * Finish managed runs that a restart found already done.
 *
 * A run whose steps are all complete, whose worker tasks are all accepted and
 * whose attempts are all terminal has nothing left to drive: the previous
 * process died (or the manager turn ended) between the last acceptance and the
 * terminal hop that codara_complete would have made. Parking that run as
 * "Paused, press Resume" asks the user to restart work that is finished, and
 * Resume would then spend a whole extra manager turn re-reviewing accepted
 * reports.
 *
 * Ordering is load-bearing. This must run AFTER
 * recoverOrphanedManagedWorkerAttempts, so attempts killed by the restart are
 * already settled and a dead worker cannot read as "still in flight", and
 * BEFORE pauseManagedRunsAfterRestart, which would otherwise claim the run
 * first.
 *
 * This is not the app resuming work on its own: it starts nothing, it only
 * records the terminal state the run already reached.
 */
export async function completeSettledManagedRunsAfterRestart(): Promise<void> {
  let runs: RunState[];
  try {
    runs = await listRuns();
  } catch {
    return;
  }
  for (const run of runs) {
    // Only live-looking managed runs. Paused/blocked status is user-owned, and
    // a question the user never answered outranks a tidy ending: completing the
    // run would bury it.
    if (!["running", "reviewing"].includes(run.status)) continue;
    if (run.blockedOn || unresolvedRunQuestions(run.humanMessages).length > 0) continue;
    // An undelivered turn or a manager call the restart cut off is unfinished
    // conversation, not finished work. Leave all of these to the user's Resume:
    // a turn truncated mid-work (interruptedManagerCall, NOT activeManagerCall,
    // the orphan pass above already failed every live call), a continuation
    // whose lease was repaired to "pending", and an answer whose live RPC died
    // with the process. Each is a piece of conversation the user is owed, and
    // completing the run would bury it with no Resume left to reach it.
    if (queuedManagerInputMessages(run).length > 0) continue;
    if (interruptedManagerCall(run)) continue;
    if (run.pendingManagerResume) continue;
    if (unactedUserAnswer(run)) continue;
    if (activeWorkersForRun(run.id).length > 0) continue;
    const settlement = describeRunSettlement(run);
    if (!settlement.settled) continue;
    // Unverified work is never completed unattended, same rule codara_complete
    // enforces. The pause pass below parks it instead, so Resume re-drives it
    // into startAutopilot's question.
    if (!(await describeVerificationFreshness(run)).ok) continue;
    await appendEvent({
      workspaceId: run.workspaceId,
      runId: run.id,
      type: "run.settled_after_restart",
      message: "Every step finished before the app closed; marking the run complete",
      payload: { priorStatus: run.status, steps: run.steps.length, workerTasks: run.workerTasks.length },
    }).catch(() => undefined);
    await completeRunFromOrchestrator(run.id).catch(() => undefined);
  }
}

/**
 * Park every managed run that a restart interrupted.
 *
 * Relaunching the app is not consent to resume. Whatever was mid-flight , 
 * a manager turn, a worker, a queued message, died with the previous process,
 * and silently picking it back up means work starts while the user is still
 * looking at the window. So any run whose status implies live activity is
 * moved to `paused` with an honest reason, and the user's Resume (which
 * re-drives the manager, a queued input, and a pending continuation alike) is
 * the only thing that restarts it.
 *
 * Runs already paused, blocked, or terminal are left exactly as they are:
 * their status is already the truth, and a blocked run is waiting on an answer
 * the user can still give.
 *
 * Must run AFTER the attempt-level recovery above, so a run is parked with its
 * dead workers already settled rather than mid-repair.
 */
export async function pauseManagedRunsAfterRestart(): Promise<void> {
  let runs: RunState[];
  try {
    runs = await listRuns();
  } catch {
    return;
  }
  const reason = "Paused because the app was restarted. Resume when you're ready.";
  for (const run of runs) {
    // Looms/automations are scheduled work the user set up to run on its own;
    // their own recovery decides whether to continue. This is about Cora.
    if (run.executionMode === "direct") continue;
    if (!["planning", "running", "reviewing"].includes(run.status)) continue;
    await commitRunChange(run, {
      type: "run.paused_after_restart",
      message: reason,
      payload: { priorStatus: run.status },
      mutate: (draft, timestamp) => {
        if (!["planning", "running", "reviewing"].includes(draft.status)) return false;
        draft.status = "paused";
        draft.autopilot = {
          ...(draft.autopilot ?? { status: "idle", updatedAt: timestamp }),
          status: "paused",
          lastAction: "paused_after_restart",
          stopReason: reason,
          pausedAt: timestamp,
          updatedAt: timestamp,
        };
        draft.updatedAt = timestamp;
      },
    }).catch(() => undefined);
  }
}

/**
 * Queued manager input left by a prior process stays queued.
 *
 * This pass used to re-drive the run so the message wasn't stranded. It no
 * longer does: relaunching the app must never start work on its own. The
 * message is already durable on disk with deliveryState "queued", the composer
 * shows it as QUEUED, and resumeRun consumes it, so nothing is lost by
 * waiting for the user, and the alternative (Cora silently picking up a
 * conversation the user walked away from) is exactly what we don't want.
 *
 * Kept as a no-op rather than deleted: the boot sequence documents its
 * recovery steps in order, and a missing step reads as an oversight.
 */
export async function recoverQueuedManagerInputs(): Promise<void> {
  /* intentionally empty, see the comment above */
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
    // The lease is repaired (a launch that never completed returns to
    // "pending") but the continuation is NOT scheduled: relaunching the app is
    // not consent to resume. The record stays durable, so the user's Resume
    // picks the continuation up exactly where it was left.
    void recovered;
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
  managerRecoveryClaimId?: string,
): Promise<void> {
  let run = await requireRun(runId);
  if (run.status === "paused" || run.status === "blocked" || run.status === "cancelled") return;

  let managerPlannedRun = mode === "chat"
    ? await askManagerBackend(
        run,
        input.cwd,
        "chat",
        managerResumeClaimId,
        autonomyRetryCount,
        0,
        managerRecoveryClaimId,
      )
    : await askManagerBackend(
        run,
        input.cwd,
        "plan_analysis",
        managerResumeClaimId,
        autonomyRetryCount,
        0,
        managerRecoveryClaimId,
      );
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
      ?? (await askManagerBackend(managerPlannedRun, input.cwd, "step_planning"));
  }

  // A null result means the manager backend threw before producing a decision
  // (runtime missing, spawn failure, provider error), the failure itself is
  // already journaled as spark_call.failed. Park the run on an accurate
  // question instead of silently idling at status=running with no driver.
  if (
    !managerPlannedRun &&
    !managerRecoveryClaimId &&
    (mode === "chat" || !manualFallbackEnabled())
  ) {
    await askHumanQuestion(
      run.id,
      mode === "chat"
        ? "Cora's manager turn failed before it could answer this chat message. Check the run log for the backend error, then send the message again."
        : "Cora's manager turn failed before it could plan worker tasks. Check the run log for the backend error, then run the plan again.",
      undefined,
      {
        reason: "The Cora manager backend could not complete the turn.",
        managerMode: mode,
      },
    );
    return;
  }
  // A claimed parked-turn recovery is replaying one exact manager stage. If
  // its backend fails before producing a decision, the recovery scheduler
  // returns the same durable token to "parked"; synthesizing a manual worker
  // here would silently replace the failed stage with different work.
  if (!managerPlannedRun && managerRecoveryClaimId) return;

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
  // This is the post-turn driver hop, not a fresh start: the initial note was
  // already appended and already delivered to the manager. Re-feeding it makes
  // startAutopilot take the initialNote branch again, which addRunMessage
  // dedupes to nothing and then hands to scheduleInitialChatDecision, whose
  // activeAutopilotPlans guard sees THIS cycle still in flight and returns. The
  // hop then drives nothing at all, which is how a run whose workers all
  // finished stays "running" with no timer, no worker and no pending call
  // (run-ms0dijmk-54pw6g). Strip the initial-turn fields so the hop reaches the
  // launch/finish decision below.
  await startAutopilot({
    ...input,
    initialUserNote: undefined,
    initialUserNoteClientMessageId: undefined,
    initialAttachments: undefined,
    runId: run.id,
  });
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
  // is non-terminal in the WorkerTaskStatus enum, and the manager-review
  // path that normally transitions needs_review → accepted via
  // decideWorkerReport is explicitly skipped below. So auto-accept on
  // success here; the CC manager will inspect the report and judge quality.
  const isExecuteModeCliManager = runHasMcpManager(latest);
  const finishedAttempt = latest.workerAttempts.find((a) => a.id === attemptId);
  const finishedTaskId = finishedAttempt?.workerTaskId;
  const finishedTask = latest.workerTasks.find((t) => t.id === finishedTaskId);
  const shouldAutoAccept =
    isExecuteModeCliManager &&
    finishedTask?.status === "needs_review" &&
    // ...but never for a manual-runtime task. Those exist precisely because
    // the manager yielded no decision (createFallbackAutopilotTask after a
    // failed manager startup): no CLI manager session spawned the task and
    // none is blocked on codara_wait_for_workers for it, so the auto-accept's
    // whole rationale is absent. Accepting here would launder an unreviewed
    // (possibly partial) report into a settled run that the completion hop
    // below then marks green; the classic needs_review escalation keeps the
    // verdict with the human.
    finishedTask.runtimePreference !== "manual";

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
    // A manual task the auto-accept above deliberately excluded: no manager
    // session reviews manual workers, no renderer surface accepts or rejects
    // one, and the stalled-review failsafe counts needs_review as in-flight —
    // so without this the run wedges at "reviewing" forever. Escalate to the
    // human with the report in hand; the linked answer applies the verdict
    // locally (maybeApplyManualReviewAnswer), so resolution needs no manager.
    const manualNeedsReview =
      isExecuteModeCliManager && finishedTask?.runtimePreference === "manual"
        ? settled.workerTasks.find(
            (task) => task.id === finishedTask.id && task.status === "needs_review",
          )
        : undefined;
    if (manualNeedsReview) {
      await escalateManualNeedsReview(settled, manualNeedsReview);
      return;
    }
    // Skip the autopilot's worker_result_review re-prompt when the chat
    // backend is a long-lived CC/Codex execute session. In that flow the
    // manager is ALREADY waiting on codara_wait_for_workers in its current
    // turn; when those workers terminate, the wait_for_workers RPC unblocks
    // and the same CC/Codex session decides what to do next (read final
    // reports, then codara_complete or spawn correctives) — all inside its
    // active turn. Re-prompting it with latestUserPromptFromRun would be
    // the SAME prompt as turn 1 (askManagerBackend has no mode-specific
    // message builder), which is precisely how one user message produced
    // multiple worker-spawn rounds in run-mpo92kqf-7eaym0.
    if (!isExecuteModeCliManager) {
      scheduleAutopilotReview(runId, cwd);
      return;
    }
    // ...but that only holds while the manager's turn is actually live. If its
    // call already finished (the turn ended without codara_wait_for_workers, or
    // the provider cut it short), no RPC will unblock and no re-entry is
    // coming, so the run would sit at "reviewing" with every worker accepted
    // and nothing driving it. When all the work is settled, take the terminal
    // hop codara_complete would have taken. Deliberately narrow: an unsettled
    // run still gets no re-prompt, that is the duplicate-spawn bug above.
    //
    // The manager never read the reports on this path (that is what "the turn
    // ended early" means), so the verifier freshness invariant cannot be waived
    // here: unverified work is handed to the user instead of being reported as
    // a clean finish.
    if (activeManagerCall(settled) || activeWorkersForRun(runId).length > 0) return;
    if (isRunSettled(settled)) {
      const verification = await describeVerificationFreshness(settled);
      if (verification.ok) {
        await completeRunFromOrchestrator(runId);
        return;
      }
      await askHumanQuestion(runId, UNVERIFIED_COMPLETION_QUESTION, undefined, {
        reason: `Latest verifier confidence: ${verification.latestVerifierConfidence ?? "none"}.`,
        managerMode: "worker_result_review",
      });
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
  managerRecoveryClaimId?: string,
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

  // A parked worker-result review owns one exact provider stage. Register and
  // run that claimed SparkCall before any of the review pipeline's ordinary
  // preflight actions (pending-task launch, verifier synthesis, council
  // advancement, or a manual-review question) can mutate the run. A backend
  // failure returns immediately so the recovery finalizer can repark it.
  let recoveredReviewApplied = false;
  if (managerRecoveryClaimId) {
    const recovered = await askManagerBackend(
      run,
      cwd,
      "worker_result_review",
      managerResumeClaimId,
      0,
      0,
      managerRecoveryClaimId,
    );
    if (!recovered) return;
    run = recovered;
    recoveredReviewApplied = true;
    if (
      run.status === "paused" ||
      run.status === "blocked" ||
      run.status === "cancelled" ||
      isTerminalRunStatus(run.status)
    ) {
      return;
    }
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
  // Gate on the council's OWN state, not on chat mode: council tasks keep their
  // councilGroupId forever, so isCouncilRun(run) stays true after the plan is
  // finalized. The next round in the same chat ("run the plan") must review its
  // own workers instead of re-finalizing the old plan.
  if (isCouncilRun(run) && !councilAlreadyFinalized(run)) {
    await advanceCouncil(run, cwd);
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
  const verifierTaskIdsBeforeCoverage = new Set(
    run.workerTasks.filter((task) => task.taskClass === "verifier").map((task) => task.id),
  );
  const stepsWithPriorVerifier = new Set(
    run.workerTasks
      .filter((task) => task.taskClass === "verifier")
      .map((task) => task.stepId)
      .filter((stepId): stepId is string => Boolean(stepId)),
  );
  run = await ensureVerifierCoverage(run, cwd);
  if (run.status === "paused" || run.status === "blocked" || run.status === "cancelled" || run.status === "complete") return;
  // Coverage just synthesized a verifier that has not run yet. Reviewing now
  // costs a full manager turn (a fresh CLI spawn/resume, minutes of wall clock)
  // to judge evidence that is about to change, and it parks the verifier behind
  // that turn. Launch the queued work instead and let its completion re-drive
  // this review with the verdict in hand, the same deferral the pending-launch
  // branch above already takes. The review is not skipped, only paid once.
  //
  // Strictly the FIRST coverage pass for a step: a verifier that lands without
  // a terminal-OK confidence leaves the step uncovered again, and deferring a
  // second time would spawn verifiers forever with no manager ever looking. A
  // re-synthesis falls through to the review, exactly as before.
  const freshVerifiers = run.workerTasks.filter(
    (task) => task.taskClass === "verifier" && !verifierTaskIdsBeforeCoverage.has(task.id),
  );
  const firstCoverageForEveryStep =
    freshVerifiers.length > 0 &&
    freshVerifiers.every((task) => !task.stepId || !stepsWithPriorVerifier.has(task.stepId));
  const coverageTasks = firstCoverageForEveryStep ? pickAutopilotTasks(run) : [];
  if (coverageTasks.length > 0) {
    await appendEvent({
      workspaceId: run.workspaceId,
      runId: run.id,
      type: "autopilot.manager_review_deferred_for_verifier_coverage",
      message: `Manager review deferred while ${coverageTasks.length} synthesized verifier task(s) run`,
      payload: {
        taskIds: coverageTasks.map((task) => task.id),
        taskTitles: coverageTasks.map((task) => task.title),
      },
    });
    const input = autopilotInputFromRun(run);
    await startAutopilot({ ...input, cwd: cwd || input.cwd, runId: run.id });
    return;
  }
  // A manual task at needs_review cannot be settled by any manager turn - it
  // exists precisely because the manager yielded no decision - and an earlier
  // escalation may have been abandoned by a force pause (the question message
  // survives, but its ownership died with the pause). Post or re-post the
  // human-review question instead of burning review turns that cannot act.
  const manualPendingReview = run.workerTasks.find(
    (task) => task.runtimePreference === "manual" && task.status === "needs_review",
  );
  if (manualPendingReview && !resolveOpenRunQuestionPure(run)) {
    if (await escalateManualNeedsReview(run, manualPendingReview)) return;
  }
  const REVIEW_REPROMPT_CAP = 3;
  if (!recoveredReviewApplied) {
    for (let attempt = 0; attempt < REVIEW_REPROMPT_CAP; attempt++) {
      const reviewed = await askManagerBackend(
        run,
        cwd,
        "worker_result_review",
        attempt === 0 ? managerResumeClaimId : undefined,
      );
      if (!reviewed) return;
      run = reviewed;
      if (run.status === "paused" || run.status === "blocked" || run.status === "cancelled" || run.status === "complete") return;
      const lastAction = run.autopilot?.lastAction;
      if (lastAction !== "completion_refused") break;
    }
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
    run = (await askManagerBackend(run, cwd, "plan_analysis")) ?? run;
    if (run.status === "paused" || run.status === "blocked" || run.status === "cancelled" || run.status === "complete") return;
    tasks = pickAutopilotTasks(run);
  }
  // After advancing past a worker (and possibly a brake), the next active step
  // is usually a worker_batch that has plannedAgents but no worker tasks yet.
  // Call step_planning so the manager turns those plannedAgents into worker
  // task prompts before we try to launch.
  if (tasks.length === 0 && needsStepPlanning(run)) {
    const fastPathPlan = await tryTrivialFastPathStepPlanning(run);
    run = fastPathPlan ?? ((await askManagerBackend(run, cwd, "step_planning")) ?? run);
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
    // The auto-compaction summarize call is maintenance, not a conversational
    // turn: a message sent while it runs is an ordinary turn for the run's
    // status, never steering targeted at it. Real-turn/compaction mutual
    // exclusion does not rest on this predicate — it is enforced by the
    // compaction commit's own other-started-call re-check (performAutoCompaction).
    if (call.purpose === "compaction") continue;
    if (call.status === "started" && !call.completedAt) return call;
  }
  return undefined;
}

/**
 * The manager's most recent turn in this epoch never reached an ending: it is
 * either still live, or recoverOrphanedManagerTurns already failed it with the
 * restart marker. Boot recovery MUST use this rather than activeManagerCall:
 * the orphan pass runs first and clears every "started" call, so by the time
 * later boot steps look, a turn cut off mid-work is indistinguishable from a
 * turn that finished cleanly without the marker.
 *
 * Only the newest call in the epoch is consulted. An older interrupted turn the
 * user already resumed past is history, not unfinished conversation.
 */
function interruptedManagerCall(run: RunState): SparkCall | undefined {
  const epoch = conversationEpoch(run);
  for (let index = run.sparkCalls.length - 1; index >= 0; index -= 1) {
    const call = run.sparkCalls[index];
    if ((call.conversationEpoch ?? 0) !== epoch) continue;
    // Auto-compaction summarize calls are maintenance: one cut off by a
    // restart is settled by the orphan pass but is not unfinished conversation
    // the user is owed, so it must not read as an interrupted turn (it would
    // block completeSettledManagedRunsAfterRestart from settling a finished
    // run). Walk past it to the newest real call.
    if (call.purpose === "compaction") continue;
    if (call.status === "started" && !call.completedAt) return call;
    if (call.status === "failed" && call.error === MANAGER_TURN_INTERRUPTED_ERROR) return call;
    return undefined;
  }
  return undefined;
}

/**
 * A user answer no manager turn ever consumed.
 *
 * An `active_rpc` answer (codara_ask_user on a CLI manager) is delivered by the
 * live RPC and marked `acknowledged` on the spot, so nothing durable records
 * whether the manager acted on it: it is neither queued input nor an unresolved
 * question. Only a manager turn that STARTED after the answer proves it landed.
 * Without this, a restart between "user says yes" and Cora acting on it buries
 * the answer under a tidy completion.
 */
function unactedUserAnswer(run: RunState): HumanRunMessage | undefined {
  const epoch = conversationEpoch(run);
  const answer = [...run.humanMessages]
    .reverse()
    .find(
      (message) =>
        message.author === "user" &&
        message.kind === "answer" &&
        (message.conversationEpoch ?? 0) === epoch,
    );
  if (!answer) return undefined;
  const consumed = run.sparkCalls.some(
    (call) => (call.conversationEpoch ?? 0) === epoch && call.createdAt > answer.createdAt,
  );
  return consumed ? undefined : answer;
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
      const recovery = draft.managerTurnRecovery;
      const recoveryOwnsCall =
        Boolean(call.managerRecoveryClaimId) &&
        recovery?.state === "resuming" &&
        recovery.resumeClaimId === call.managerRecoveryClaimId &&
        recovery.conversationEpoch === epoch;
      includeCanonicalReplay =
        shouldIncludeCanonicalReplay(draft, epoch) ||
        (recoveryOwnsCall && recovery?.forceCanonicalReplay === true);
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
  // Subscription headroom rides the same dynamic tail as the memory. The read
  // hits pi-subscription-usage's 60s cache (never forced), and any failure
  // degrades to "no section": a quota-endpoint hiccup must never cost a turn.
  let subscriptionHeadroom: string | null = null;
  try {
    subscriptionHeadroom = describeHeadroomForPrompt(await readSubscriptionHeadroomSummary());
  } catch {
    subscriptionHeadroom = null;
  }
  // Cora memory rides the same dynamic tail. formatCoraMemoryForTurn is
  // hash-gated per run (null when this run already carries the unchanged
  // content) and forced on canonical replay, which rebuilds the CLI session
  // that held the earlier injection. Best-effort: a memory read failure must
  // never cost a turn.
  let coraMemory: string | null = null;
  try {
    coraMemory = await formatCoraMemoryForTurn(prepared.workspaceId, prepared.id, {
      force: includeCanonicalReplay,
    });
  } catch {
    coraMemory = null;
  }
  return {
    run: prepared,
    call: persistedCall,
    // Every backend's per-turn user text comes from this one call, so the Cora
    // memory sections are replayed here, in the dynamic half, and never in the
    // cacheable system prompt. Read at turn time so a memory written a minute
    // ago is already live for the next turn.
    prompt: buildManagerTurnPrompt(prepared, inputMessages, {
      includeCanonicalReplay,
      compactionSummary: includeCanonicalReplay ? compactionReplaySummary(prepared) : null,
      coraMemory,
      subscriptionHeadroom,
    }),
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
  // The failed/aborted turn did not durably apply a manager decision, so roll
  // its input ownership back for Resume/retry. This also covers a prompt that
  // reached the provider but failed before any live orchestration tool applied;
  // callers must acknowledge instead when a tool already mutated the run.
  // Release the memory gate too so the retried prompt carries the same context.
  releaseCoraMemoryInjection(runId);
  const run = await getRun(runId);
  if (!run || !isManagerTurnCurrent(run, callId, epoch)) return;
  await commitRunChange(run, {
    type: "run.manager_input_requeued",
    message: "Manager input requeued after an interrupted or unapplied turn",
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

function normalizeManagerMode(mode: SparkCall["mode"]): ManagerMode {
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

async function askManagerForChat(
  run: RunState,
  cwd: string,
  managerResumeClaimId?: string,
): Promise<RunState | null> {
  const enriched = await enrichLatestUserMessageWithMentionedFiles(run, cwd);
  return askManagerBackend(enriched, cwd, "chat", managerResumeClaimId);
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
  return (await askManagerBackend(updated, cwd, "plan_analysis")) ?? updated;
}

// Cap on the manager's autonomous question-retry loop; past this the pending
// question escalates to the human instead of another silent self-answer.
const MAX_MANAGER_QUESTION_REPROMPTS = 2;

async function askManagerBackend(
  run: RunState,
  cwd: string,
  mode: SparkCall["mode"],
  managerResumeClaimId?: string,
  autonomyRetryCount = 0,
  // Automatic same-turn retries already consumed after transient provider
  // failures (see manager-turn-policy). Distinct from autonomyRetryCount,
  // which counts question reprompts.
  transientRetryCount = 0,
  managerRecoveryClaimId?: string,
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
  run = await pinImplicitPiManagerAccount(run);
  const chatConfig = await freezeManagerExecutionAccount(
    resolveChatBackendConfig(run, settings.openAiFastMode === true),
  );
  if (
    runProjectPolicyMode(run) === "untrusted-pull-request" &&
    chatConfig.backend !== "pi"
  ) {
    throw new Error(
      "Imported pull-request runs currently require Cora · Pi so repository-owned agent policy stays disabled.",
    );
  }

  // Every manager backend (Claude Code, Codex, Pi) owns its own request
  // lifecycle, spawn/resume a real agent session, stream events, and return
  // a SparkManagerDecision. Run-store forwards streaming chat events onto the
  // orchestration event bus, persists any new CLI-side session UUID returned
  // by the backend onto the RunState, records a SparkCall for cost/audit
  // consistency, and applies the resulting SparkManagerDecision through
  // applySparkManagerDecision so downstream worker spawns and chat replies
  // work identically across backends.
  const backend = getBackend(chatConfig.backend);
  const callId = makeId("spark");
  const callUserConstitution = copyRunUserConstitutionCapture(run);
  const sparkCall: SparkCall = {
    id: callId,
    runId: run.id,
    ...(callUserConstitution ? { userConstitution: callUserConstitution } : {}),
    stepId: run.currentStepId,
    mode,
    model: chatConfig.model,
    accountProfileId: chatConfig.accountProfileId,
    nativeCodexProfileId: chatConfig.nativeCodexProfileId,
    nativeClaudeProfileId: chatConfig.nativeClaudeProfileId,
    status: "started",
    managerResumeClaimId,
    managerRecoveryClaimId,
    createdAt: new Date().toISOString(),
  };
  const preparedTurn = await prepareManagerTurn(run, sparkCall);
  run = preparedTurn.run;
  const managerRecoveryClaimedAccountProfileId =
    managerRecoveryClaimId &&
    run.managerTurnRecovery?.state === "resuming" &&
    run.managerTurnRecovery.resumeClaimId === managerRecoveryClaimId &&
    run.managerTurnRecovery.conversationEpoch === preparedTurn.conversationEpoch
      ? run.managerTurnRecovery.resumeAccountProfileId
      : undefined;
  const frozenRun = structuredClone(run);

  // Once requestManagerDecision settles, that SparkCall owns no more stream
  // events. Every callback also checks the epoch before it can reach the log.
  let acceptingStreamEvents = true;
  // Last context gauge seen on the stream. Pi returns the gauge on the
  // ManagerCallResult itself, but Claude/Codex only ever report occupancy via
  // usage stream events; Claude's carry no contextTokens at all, so occupancy
  // is derived from the latest request's input + cache-read counts. Folded
  // into the SparkCall at completion when the result left the fields empty —
  // that persisted gauge re-seeds the composer meter on reopen and feeds the
  // autocompaction trigger.
  const streamGauge = { contextTokens: 0, contextWindowTokens: 0, sawExplicitContext: false };
  const onStream = (event: ChatStreamEvent): void => {
    if (!acceptingStreamEvents) return;
    if (event.kind === "usage") {
      if (typeof event.contextTokens === "number" && event.contextTokens > 0) {
        streamGauge.contextTokens = event.contextTokens;
        streamGauge.sawExplicitContext = true;
      } else if (!streamGauge.sawExplicitContext) {
        // Claude events never carry contextTokens; the latest request's
        // input + cache-read counts are its occupancy. Codex events carry
        // per-event deltas here instead, so once one explicit gauge arrived
        // a delta-derived value must never replace it.
        const derived = (event.inputTokens ?? 0) + (event.cacheReadTokens ?? 0);
        if (Number.isFinite(derived) && derived > 0) streamGauge.contextTokens = derived;
      }
      if (
        typeof event.contextWindowTokens === "number" &&
        Number.isFinite(event.contextWindowTokens) &&
        event.contextWindowTokens > 0
      ) {
        streamGauge.contextWindowTokens = event.contextWindowTokens;
      }
    }
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
      const input = {
        timestamp: new Date().toISOString(),
        workspaceId: run.workspaceId,
        runId: run.id,
        sparkCallId: callId,
        type: `chat.${event.kind}`,
        payload: {
          ...(event as unknown as Record<string, unknown>),
          conversationEpoch: preparedTurn.conversationEpoch,
        },
      };
      // assistant_block is the only stream kind emitted at token cadence (one
      // per text delta: pi-turn, codex-backend, claude-backend). Buffer it so a
      // streaming turn costs one journal append and one IPC send per ~50ms
      // instead of per token. Every other kind (tool_use, tool_result,
      // system_note, usage, error) is low-rate and appends directly — which also
      // flushes whatever is buffered ahead of it, preserving emission order.
      if (event.kind === "assistant_block") {
        appendBufferedEvent(input);
        return;
      }
      await appendEvent(input);
    })().catch((err) => {
      console.warn("[run-store] appendEvent for chat stream event failed:", err);
    });
  };

  const callStartedMs = Date.now();
  try {
    const managerConstitutionBlock =
      await resolveCapturedManagerConstitutionBlock(frozenRun);
    const result = await backend.requestManagerDecision(
      {
        run: frozenRun,
        cwd,
        mode: normalizeManagerMode(mode),
        settings,
        managerConstitutionBlock,
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
    // The turn owns no more stream events, so land the buffered tail now rather
    // than leaving up to one flush interval of the reply undurable.
    await flushBufferedEvents(run.id);
    const latest = await requireRun(run.id);
    const targetCall = latest.sparkCalls.find((call) => call.id === callId);
    if (!targetCall || !isManagerTurnCurrent(latest, callId, preparedTurn.conversationEpoch)) {
      return latest;
    }
    const completedAt = new Date().toISOString();
    const turnAborted = result.turnAborted === true;
    const turnFailed = !turnAborted && result.turnFailed === true;
    if (targetCall) {
      // Successful decisions remain started until their run mutations land.
      // Aborted/failed turns have no decision to apply and can settle now.
      targetCall.status = turnFailed ? "failed" : turnAborted ? "completed" : "started";
      if (turnFailed) {
        targetCall.error = result.notice ?? "Chat turn failed.";
      }
      targetCall.model = result.model;
      targetCall.accountProfileId = preserveFrozenPiAccountProfileId(
        targetCall.accountProfileId,
        result.accountProfileId,
      );
      targetCall.durationMs = result.durationMs;
      if (typeof result.promptTokens === "number") targetCall.promptTokens = result.promptTokens;
      if (typeof result.completionTokens === "number") targetCall.completionTokens = result.completionTokens;
      if (typeof result.contextWindowTokens === "number" && result.contextWindowTokens > 0) {
        targetCall.contextWindowTokens = result.contextWindowTokens;
        targetCall.contextWindowSource = "known";
      }
      // Claude/Codex results leave the context gauge empty; fall back to the
      // last stream-reported occupancy so reopened chats re-seed the composer
      // meter and the autocompaction trigger sees a real number.
      if (
        !(typeof targetCall.promptTokens === "number" && targetCall.promptTokens > 0) &&
        streamGauge.contextTokens > 0
      ) {
        targetCall.promptTokens = streamGauge.contextTokens;
      }
      if (
        !(typeof targetCall.contextWindowTokens === "number" && targetCall.contextWindowTokens > 0) &&
        streamGauge.contextWindowTokens > 0
      ) {
        targetCall.contextWindowTokens = streamGauge.contextWindowTokens;
        targetCall.contextWindowSource = "known";
      }
      if (typeof result.costUsd === "number") targetCall.costUsd = result.costUsd;
      if (typeof result.inputTokens === "number") targetCall.inputTokens = result.inputTokens;
      if (typeof result.outputTokens === "number") targetCall.outputTokens = result.outputTokens;
      if (typeof result.cacheReadTokens === "number") targetCall.cacheReadTokens = result.cacheReadTokens;
      if (result.providerResponseIds?.length) {
        targetCall.providerResponseIds = [...new Set(result.providerResponseIds)];
      }
      if (turnFailed || turnAborted) targetCall.completedAt = completedAt;
    }
    // Account/backend changes are next-turn mutations. A provider response
    // completing after such a change still belongs to the frozen SparkCall,
    // but its session UUID must never be attached to the newly selected
    // account. Compare the latest persisted owner to the turn's pre-launch
    // snapshot rather than to the resolved config: legacy/default Pi runs may
    // intentionally keep an undefined pin while the turn resolves a concrete
    // account internally.
    const managerSessionOwnerUnchanged =
      (latest.chatBackend ?? "pi") === (frozenRun.chatBackend ?? "pi") &&
      (chatConfig.backend === "claude"
        ? latest.nativeClaudeProfileId === frozenRun.nativeClaudeProfileId
        : chatConfig.backend === "codex"
          ? latest.nativeCodexProfileId === frozenRun.nativeCodexProfileId
          : latest.chatAccountProfileId === frozenRun.chatAccountProfileId);
    if (
      managerSessionOwnerUnchanged &&
      result.newSessionUuid &&
      result.newSessionUuid !== latest.chatSessionUuid
    ) {
      latest.chatSessionUuid = result.newSessionUuid;
    }
    // Stamp the mode the session was spawned under. Next-turn dispatch
    // checks this against the current chatMode and forces a fresh session
    // on mismatch — otherwise CC/Codex resume into a transcript whose prior
    // assistant replies were written in the old mode's persona and the new
    // mode's prompt gets ignored.
    if (managerSessionOwnerUnchanged && result.newSessionUuid) {
      latest.chatSessionMode = chatConfig.mode;
    }
    recomputeRunCostRollups(latest);
    latest.updatedAt = completedAt;
    await saveRun(latest);

    // Settle input ownership only after the call metadata above is durable.
    // Doing this before saveRun(latest) lets that stale snapshot overwrite the
    // delivery transition. A failed Pi turn may also have successfully applied
    // a live orchestration tool before its final provider request died; that
    // input is acknowledged, never replayed on Resume.
    let settledRun = latest;
    if (turnFailed && result.decisionAlreadyApplied) {
      await updateManagerInputDelivery(
        run.id,
        callId,
        preparedTurn.conversationEpoch,
        "acknowledged",
      );
      settledRun = await requireRun(run.id);
    } else if (turnFailed || turnAborted) {
      await releaseUnsubmittedManagerInput(
        run.id,
        callId,
        preparedTurn.conversationEpoch,
      );
      settledRun = await requireRun(run.id);
    }

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
        workspaceId: settledRun.workspaceId,
        runId: settledRun.id,
        sparkCallId: callId,
        type: "chat.backend_notice",
        message: result.notice ?? "Chat turn interrupted by user.",
        payload: { backend: chatConfig.backend, interrupted: true },
      });
      return settledRun;
    }

    // Backend reported the turn itself FAILED (turn timeout, CLI crash,
    // backend error). The decision object only carries a best-effort
    // chatReply — applying it through applySparkManagerDecision would record
    // "Cora answered the chat turn" and complete the run as if it had been
    // answered (the CC 2.1.201 false-finish). Instead, record the SparkCall
    // failure and let manager-turn-policy preserve, retry, park, or fail the
    // run. Only a settled park/fail gets a durable error bubble; quiet retries
    // and late failures after an authoritative state do not spam the chat.
    if (turnFailed) {
      const failureMessage = result.notice ?? "Chat turn failed.";
      const failurePlan = planManagerTurnFailure({
        error: failureMessage,
        runStatus: settledRun.status,
        mode,
        transientRetryCount,
        backend: chatConfig.backend,
      });

      // The run already carries a state this dead turn must not rewrite: a
      // terminal verdict that landed mid-turn (codara_complete, a user
      // cancel, a worker-cycle failure), an open question the user can still
      // answer (parking a blocked run would strand the answer, since
      // answerRunQuestion rejects paused runs), or a user-held pause. The
      // SparkCall keeps its failure for the audit trail; the run keeps its
      // state and the failure lands as a quiet notice.
      if (failurePlan.action === "keep_state") {
        await appendEvent({
          timestamp: completedAt,
          workspaceId: settledRun.workspaceId,
          runId: settledRun.id,
          sparkCallId: callId,
          type: "chat.backend_notice",
          message: `Cora's manager turn failed while the run was ${settledRun.status} (${failureMessage}). The run keeps its state.`,
          payload: {
            backend: chatConfig.backend,
            error: failureMessage,
            keptStatus: settledRun.status,
            providerResponseIds: result.providerResponseIds,
          },
        });
        return settledRun;
      }

      if (failurePlan.action === "retry") {
        const delayMs = managerTurnRetryDelayMs(failurePlan.attempt);
        const attemptLabel = `attempt ${failurePlan.attempt + 1} of ${MAX_MANAGER_TRANSIENT_RETRIES + 1}`;
        console.warn(
          `[run-store] manager turn ${callId} (${chatConfig.backend}/${mode}) failed transiently (${failurePlan.kind}); retrying in ${delayMs}ms (${attemptLabel}): ${failureMessage}`,
        );
        await appendEvent({
          timestamp: completedAt,
          workspaceId: settledRun.workspaceId,
          runId: settledRun.id,
          sparkCallId: callId,
          type: "run.chat_turn_retrying",
          message: `Cora's provider hiccuped (${failurePlan.kind}); retrying the turn in ${Math.round(delayMs / 1000)}s (${attemptLabel})`,
          payload: {
            backend: chatConfig.backend,
            mode,
            error: failureMessage,
            failureKind: failurePlan.kind,
            attempt: failurePlan.attempt,
            maxAttempts: MAX_MANAGER_TRANSIENT_RETRIES + 1,
            delayMs,
            providerResponseIds: result.providerResponseIds,
          },
        });
        // A trace note on the failed call so the conversation's "Technical
        // details" explains the red row that a quiet retry follows.
        await appendEvent({
          timestamp: completedAt,
          workspaceId: settledRun.workspaceId,
          runId: settledRun.id,
          sparkCallId: callId,
          type: "chat.backend_notice",
          message: `Provider issue (${failureMessage}). Cora is retrying this turn automatically (${attemptLabel}).`,
          payload: { backend: chatConfig.backend, retrying: true },
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        // The world may have moved while we slept: only retry when this
        // conversation is still current, nothing else took over the manager,
        // and the run is still in a driving state (a user Stop, cancel, or a
        // mid-sleep completion all abandon the retry).
        const fresh = await getRun(run.id);
        if (!fresh || conversationEpoch(fresh) !== preparedTurn.conversationEpoch) {
          return fresh ?? settledRun;
        }
        if (fresh.status !== "planning" && fresh.status !== "running" && fresh.status !== "reviewing") {
          return fresh;
        }
        if (fresh.sparkCalls.some((call) => call.status === "started" && !call.completedAt)) {
          return fresh;
        }
        return askManagerBackend(
          fresh,
          cwd,
          mode,
          managerResumeClaimId,
          autonomyRetryCount,
          transientRetryCount + 1,
          managerRecoveryClaimId,
        );
      }

      // Quiet automatic retries never create a durable assistant error bubble.
      // Once the policy settles on park/fail, persist exactly one final card
      // and one failure event for the whole turn lineage.
      await appendEvent({
        timestamp: completedAt,
        workspaceId: settledRun.workspaceId,
        runId: settledRun.id,
        sparkCallId: callId,
        type: "spark_call.failed",
        message: `Cora manager (${chatConfig.backend}) turn failed: ${failureMessage}`,
        payload: {
          mode,
          model: result.model,
          backend: chatConfig.backend,
          error: failureMessage,
          providerResponseIds: result.providerResponseIds,
        },
      });
      // Never turn provider diagnostics or partial output into conversational
      // history. Canonical replay treats spark notes as Cora dialogue, so doing
      // so would make an overload string a future manager prompt. The failed
      // SparkCall and typed events above are the sole durable error surface.
      const failedRun = settledRun;

      // Provider trouble that outlived the retries (or a rate limit, which a
      // fast retry can never clear): park instead of failing. The work did
      // not fail, the provider did. Unapplied input was requeued above; input
      // whose live tool already mutated the run was acknowledged so Resume
      // cannot duplicate that side effect. Workers still in flight keep
      // running and are reviewed on resume.
      if (failurePlan.action === "park") {
        console.warn(
          `[run-store] manager turn ${callId} (${chatConfig.backend}/${mode}) parked after ${failurePlan.kind} failure: ${failureMessage}`,
        );
        return commitRunChange(failedRun, {
          type: "run.chat_turn_parked",
          message: `Cora's ${chatConfig.backend} chat turn hit provider trouble: ${failureMessage}`,
          payload: {
            backend: chatConfig.backend,
            sparkCallId: callId,
            mode,
            error: failureMessage,
            failureKind: failurePlan.kind,
            reason: failurePlan.parkReason,
          },
          mutate: (draft, timestamp) => {
            draft.status = "paused";
            draft.managerTurnRecovery = {
              id: makeId("recovery"),
              state: "parked",
              // manager-turn-policy only parks these classes; keep the
              // persisted union narrower than the generic worker failure
              // taxonomy.
              failureKind: failurePlan.kind as ManagerTurnRecoveryFailureKind,
              backend: chatConfig.backend,
              managerMode: mode,
              conversationEpoch: preparedTurn.conversationEpoch,
              failedSparkCallId: callId,
              failedAccountProfileId:
                sparkCall.accountProfileId ??
                sparkCall.nativeClaudeProfileId ??
                sparkCall.nativeCodexProfileId,
              parkedAt: timestamp,
            };
            draft.autopilot = {
              ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
              status: "paused",
              lastAction: failurePlan.lastAction,
              stopReason: failurePlan.parkReason,
              pausedAt: timestamp,
              updatedAt: timestamp,
            };
            draft.updatedAt = timestamp;
          },
        });
      }

      // Declaring a worker failed and leaving its process running is the worst
      // of both worlds, and it is exactly what used to happen: attempts were
      // marked failed while their Pi children kept executing tools and writing
      // COMMITS to the user's tree for minutes afterwards, unobserved, with the
      // run already terminal. If the verdict is that this run is over, stop its
      // workers for real before recording it - the same order forcePauseRun
      // uses (kill first, then commit, so nothing settles into a terminal run).
      const orphanedWorkers = activeWorkersForRun(failedRun.id);
      for (const worker of orphanedWorkers) {
        try {
          worker.kill();
        } catch {
          /* best-effort; fall through to the hard pty kill */
        }
        try {
          pty.killImmediate(worker.attemptId);
        } catch {
          /* the session may already have exited */
        }
        activeWorkerProcesses.delete(worker.attemptId);
      }
      if (orphanedWorkers.length > 0) {
        console.warn(
          `[run-store] manager turn ${callId} failed; stopped ${orphanedWorkers.length} in-flight worker process(es) so none outlive the run`,
        );
      }

      return commitRunChange(failedRun, {
        type: "run.chat_turn_failed",
        message: `Cora's ${chatConfig.backend} chat turn failed: ${failureMessage}`,
        payload: {
          backend: chatConfig.backend,
          sparkCallId: callId,
          error: failureMessage,
          stoppedWorkerProcesses: orphanedWorkers.length,
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
      const finalized = await settleAppliedManagerCall(appliedLive, {
        callId,
        conversationEpoch: preparedTurn.conversationEpoch,
        applicationProof: {
          kind: "decision-already-applied",
          decisionAlreadyApplied: result.decisionAlreadyApplied,
        },
        managerResumeClaimId,
        managerRecoveryClaimId,
        managerRecoveryClaimedAccountProfileId,
      });
      scheduleQueuedSteeringFollowup(finalized);
      await maybeAutoCompactConversation(run.id, callId, cwd);
      // Re-read: if compaction just cut the conversation over, callers that
      // chain another manager turn off this state (step_planning, brake
      // replans) need the new epoch or their prepareManagerTurn goes stale.
      return (await getRun(run.id)) ?? finalized;
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
    const finalized = await settleAppliedManagerCall(applied, {
      callId,
      conversationEpoch: preparedTurn.conversationEpoch,
      applicationProof: {
        kind: "structured-decision-applied",
        applicationReady: true,
      },
      managerResumeClaimId,
      managerRecoveryClaimId,
      managerRecoveryClaimedAccountProfileId,
    });
    scheduleQueuedSteeringFollowup(finalized);
    await maybeAutoCompactConversation(run.id, callId, cwd);
    // Re-read: if compaction just cut the conversation over, callers that
    // chain another manager turn off this state (step_planning, brake
    // replans) need the new epoch or their prepareManagerTurn goes stale.
    return (await getRun(run.id)) ?? finalized;
  } catch (err) {
    acceptingStreamEvents = false;
    // The turn owns no more stream events, so land the buffered tail now rather
    // than leaving up to one flush interval of the reply undurable.
    await flushBufferedEvents(run.id);
    const latest = await requireRun(run.id);
    const targetCall = latest.sparkCalls.find((call) => call.id === callId);
    if (!targetCall || !isManagerTurnCurrent(latest, callId, preparedTurn.conversationEpoch)) {
      return latest;
    }
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
    // Persist the call failure first; otherwise saveRun(latest)'s pre-release
    // snapshot can overwrite the requeued input written by the helper.
    await releaseUnsubmittedManagerInput(
      run.id,
      callId,
      preparedTurn.conversationEpoch,
    );
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
  claude: { modelHint: "claude-opus-5", effortHint: "high" },
  codex: { modelHint: CODEX_MODEL_BY_TIER.top, effortHint: "high" },
};

// Top-tier model identifiers (post-normalization). Anything else for a
// claude/codex runtime is treated as mid-tier and gets promoted on trivial.
// We compare on the base model only — `@<effort>` suffixes are stripped first
// because grok-4.3 has shipped both `"claude-sonnet-4-6"` and
// `"claude-sonnet-4-6@medium"` as the modelHint string across runs, and an
// allow-list keyed on raw strings silently misses the suffixed variant.
const TOP_TIER_MODEL_BASES = new Set([
  "claude-opus-5",
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
    .filter(isHeuristicUserMessage)
    .map((message) => message.message);
  return [plan?.rawContent ?? "", ...notes].join("\n");
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
      .filter(runtimeAssignable)
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

// Distribute fan-out workers across the providers Cora can actually assign to
// so a multi-target fan-out is not single-provider by default. Falls back to a
// single available runtime (or "manual" when none is configured). The list is
// stable + index-addressable so each target gets a deterministic assignment.
async function chooseFanOutRuntimes(): Promise<WorkerRuntime[]> {
  const diagnostics = await detectConfiguredAgentRuntimes();
  const installed = new Set(
    diagnostics.filter(runtimeAssignable).map((runtime) => runtime.kind),
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
  claude: "claude-opus-5",
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

// Title finalizeCouncil stamps on the merged plan. Doubles as the durable
// "this council already produced its plan" marker (see councilAlreadyFinalized).
const COUNCIL_PLAN_TITLE = "Synthesized plan (council)";

// True once a council run has written its synthesized plan, so a later round in
// the same chat routes through the normal verifier/manager review.
function councilAlreadyFinalized(run: RunState): boolean {
  return run.plans.some((plan) => plan.title === COUNCIL_PLAN_TITLE);
}

// The original planning task for a council run (latest user message / note).
// Board-nudge and pause-resume notes are synthetic and never the task the
// council should plan.
function councilTaskFromRun(run: RunState): string {
  return (
    run.humanMessages
      .filter((message) => message.author === "user" && !message.boardNote && !message.resumeNote)
      .at(-1)
      ?.message?.trim() ?? ""
  );
}

// Map the run's SELECTED chat backend to a council worker runtime, the user's
// choice drives the synthesis engine, so synthesis runs on the same agent they
// picked. Returns null when no backend is recorded on the run (a legacy chat);
// then we fall back to a deterministic pick of the most complete candidate.
function councilSynthesisRuntime(run: RunState): WorkerRuntime | null {
  if (run.chatBackend === "claude") return "claude";
  if (run.chatBackend === "codex") return "codex";
  if (run.chatBackend === "pi") {
    return run.chatModel?.startsWith("claude-") ? "claude" : "codex";
  }
  return null;
}

// Resolve the council directive for this startAutopilot call. Only an explicit
// input.council triggers the Best-of-N council now: there is no "plan" chat mode
// to infer it from, so the council is a programmatic capability the manager's
// own plan gate does not use.
function resolveCouncilDirective(
  _run: RunState,
  input: StartAutopilotInput,
): CouncilDirective | null {
  if (input.council && input.council.task.trim().length > 0) return input.council;
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
// have finished, spawn ONE synthesis worker on the user's SELECTED backend
// that reads the drafts and writes the merged .spark/<runId>/spark-plan/ itself.
// Phase 2: the synthesis worker has finished — finalize the run from its files.
async function advanceCouncil(run: RunState, cwd: string): Promise<void> {
  const synthesisTask = run.workerTasks.find((task) => task.councilRole === "synthesis");
  if (!synthesisTask) {
    const prepared = await prepareCouncilSynthesis(run, cwd);
    if (!prepared) {
      // No CLI agent selected (or every candidate failed) — fall back to a
      // deterministic pick of the most complete draft; no agent involved.
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
// candidate draft, write it to spark-plan/, complete the run. No agent involved.
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
          title: COUNCIL_PLAN_TITLE,
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
  const available = diagnostics.filter(runtimeAssignable);
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
        reason: "Requested provider has no connected subscription, or is disabled by Settings > Agents.",
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
      reason: "Requested provider has no connected subscription, or is disabled by Settings > Agents.",
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
// escape hatches, not autonomous runtimes). If the mandated provider has no
// connected subscription, returns the decision unchanged so
// rerouteUnavailableAgentRuntimes can pick a fallback the usual way.
async function enforceUserRuntimeMandate(
  decision: SparkManagerDecision,
  mandate: WorkerRuntime,
): Promise<{ decision: SparkManagerDecision; overrides: RuntimeReroute[] }> {
  const diagnostics = await detectConfiguredAgentRuntimes();
  const assignableKinds = new Set(
    diagnostics.filter(runtimeAssignable).map((runtime) => runtime.kind),
  );
  if (mandate !== "claude" && mandate !== "codex") {
    return { decision, overrides: [] };
  }
  if (!assignableKinds.has(mandate)) {
    return { decision, overrides: [] };
  }
  const modelDefaults: Record<string, { modelHint?: string; effortHint?: WorkerTask["effortHint"] }> = {
    claude: { modelHint: "claude-opus-5", effortHint: "high" },
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
  /** Mandatory on plan_approval asks; see PlanValidation. */
  planValidation?: PlanValidation;
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
  // as well as manager-loop recursion.
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
    ...(input.planValidation ? { planValidation: input.planValidation } : {}),
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
  if (cwd && runProjectPolicyMode(updated) === "trusted") {
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

  // A manual-review escalation resolves HERE, not in a manager turn: the
  // question exists precisely because no manager reviews manual workers. Any
  // pending manager resume stamped by the answer is still scheduled below; its
  // claim guard skips the terminal/blocked states this can produce.
  const manualReview = await maybeApplyManualReviewAnswer(updated, questionMessageId, message);
  if (manualReview) {
    schedulePendingManagerResume(manualReview);
    return manualReview;
  }

  schedulePendingManagerResume(updated);
  return updated;
}

/**
 * Post the human-review escalation for a manual task sitting at needs_review.
 * Called by cycle completion when the report first lands, and by the
 * autopilot review stage as a RE-escalation: a force pause abandons question
 * ownership (the question message survives, but applyRunQuestionAnswer
 * rejects answers off the blocked state), so without a fresh question after
 * resume the manual review would be permanently stranded.
 */
async function escalateManualNeedsReview(run: RunState, task: WorkerTask): Promise<boolean> {
  const attempt = [...run.workerAttempts]
    .reverse()
    .find((entry) => entry.workerTaskId === task.id);
  const report = attempt?.finalReportPath
    ? await readWorkerReport(attempt.finalReportPath).catch(() => null)
    : null;
  const summary = report?.summary?.trim();
  const question = [
    `The manual worker "${task.title}" finished and reported ${report?.status ?? "no parseable report"}.`,
    summary ? `Report summary: ${summary}` : null,
    "Manual workers have no manager to review them, so tell me whether to accept this report.",
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  try {
    await askHumanQuestion(run.id, question, MANUAL_REVIEW_QUESTION_OPTIONS, {
      reason: "A manual worker's report needs a human verdict; no manager reviews manual workers.",
      managerMode: "worker_result_review",
    });
    return true;
  } catch (err) {
    // Most likely another question is already open; that question is the
    // run's active escalation and this one can wait for the next driver.
    console.warn(`[run-store] manual review escalation for ${run.id} not posted:`, err);
    return false;
  }
}

/**
 * Apply a manual-review escalation answer locally. Returns null when the
 * answered question is not the manual-review escalation, when the answer is
 * anything other than the CANNED accept/fail option (free text, including
 * negations like "Don't accept this", falls through to the normal manager
 * path - see parseManualReviewVerdict), or when no manual task still sits at
 * needs_review.
 *
 * Accept mirrors the local review's accept transitions (task accepted, step
 * complete once all its tasks are), then takes the same terminal hop
 * codara_complete would: complete when settled and verification is fresh,
 * else the standing unverified-completion question. Reject is the user's own
 * verdict on the work, so the task, its step, and the run read failed.
 *
 * The verdict applies to EVERY manual task at needs_review, not just one.
 * Today that is always exactly one task: createFallbackAutopilotTask is the
 * only producer of manual-runtime tasks and creates a single task per run, so
 * a batch where one answer would accept a report the user never saw cannot be
 * constructed. If a second producer ever appears, scope this to the task the
 * question was posted about before shipping it.
 */
async function maybeApplyManualReviewAnswer(
  run: RunState,
  questionMessageId: string,
  answerText: string,
): Promise<RunState | null> {
  const question = run.humanMessages.find(
    (entry) => entry.id === questionMessageId && entry.kind === "question",
  );
  const options = question?.questionOptions ?? [];
  if (!options.some((option) => option.id === MANUAL_REVIEW_ACCEPT_OPTION_ID)) return null;
  const verdict = parseManualReviewVerdict(answerText, options);
  if (!verdict) return null;

  let changed = false;
  const applied = await commitRunChange(run, {
    type: "manual_review.applied",
    message:
      verdict === "accept"
        ? "User accepted the manual worker's report"
        : "User rejected the manual worker's report; the task is failed",
    payload: { questionMessageId, verdict },
    mutate: (draft, timestamp) => {
      for (const task of draft.workerTasks) {
        if (task.runtimePreference !== "manual" || task.status !== "needs_review") continue;
        task.status = verdict === "accept" ? "accepted" : "failed";
        task.updatedAt = timestamp;
        changed = true;
        const step = task.stepId
          ? draft.steps.find((entry) => entry.id === task.stepId)
          : undefined;
        if (!step) continue;
        if (verdict === "fail") {
          step.status = "failed";
        } else {
          const stepTasks = draft.workerTasks.filter((entry) => entry.stepId === step.id);
          if (stepTasks.every((entry) => entry.status === "accepted")) {
            step.status = "complete";
            if (draft.currentStepId === step.id) draft.currentStepId = undefined;
          }
        }
        step.updatedAt = timestamp;
      }
      if (!changed) return false;
      if (verdict === "fail") {
        draft.status = "failed";
        draft.autopilot = {
          ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
          status: "failed",
          lastAction: "manual_review_rejected",
          stopReason: "The user rejected the manual worker's report.",
          updatedAt: timestamp,
        };
      }
      draft.updatedAt = timestamp;
    },
  });
  if (!changed) return null;

  if (verdict === "accept" && isRunSettled(applied)) {
    const verification = await describeVerificationFreshness(applied);
    if (verification.ok) {
      return completeRunFromOrchestrator(applied.id);
    }
    return askHumanQuestion(applied.id, UNVERIFIED_COMPLETION_QUESTION, undefined, {
      reason: `Latest verifier confidence: ${verification.latestVerifierConfidence ?? "none"}.`,
      managerMode: "worker_result_review",
    });
  }
  return applied;
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

export type ManagerTurnRecoveryAccountSelection =
  | { kind: "subscription"; profileId: string }
  | { kind: "native-cli"; backend: "claude" | "codex"; profileId: string };

export interface ResumeManagerTurnRecoveryInput {
  runId: string;
  recoveryId: string;
  account?: ManagerTurnRecoveryAccountSelection;
}

export type ResumeManagerTurnRecoveryResult = {
  outcome:
    | "accepted"
    | "already-resuming"
    | "stale"
    | "account-unavailable"
    | "account-incompatible";
  run: RunState;
  reason?: string;
};

type ResolvedManagerRecoveryAccount =
  | { backend: "pi"; profileId: string }
  | { backend: "claude" | "codex"; profileId: string };

async function resolveManagerRecoveryAccount(
  run: RunState,
  account: ManagerTurnRecoveryAccountSelection | undefined,
): Promise<
  | { ok: true; account?: ResolvedManagerRecoveryAccount }
  | { ok: false; outcome: "account-unavailable" | "account-incompatible"; reason: string }
> {
  if (!account) return { ok: true };
  const backend = run.chatBackend ?? "pi";
  if (account.kind === "subscription") {
    if (backend !== "pi") {
      return {
        ok: false,
        outcome: "account-incompatible",
        reason: "Subscription accounts can only resume a Cora · Pi manager turn.",
      };
    }
    try {
      const profileId = normalizePiAccountProfileId(
        account.profileId,
        "Recovery Pi account profile id",
      );
      if (!profileId) throw new Error("A concrete subscription account is required.");
      const config = resolveChatBackendConfig(run);
      const resolved = await resolveCodaraPiExecutionAccount({
        provider: piProviderForManagerModel(config.model),
        preferredAccountProfileId: profileId,
      });
      if (resolved.accountProfileId !== profileId) {
        throw new Error("The selected subscription account could not be pinned exactly.");
      }
      return { ok: true, account: { backend: "pi", profileId } };
    } catch (error) {
      return {
        ok: false,
        outcome: "account-unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (backend !== account.backend) {
    return {
      ok: false,
      outcome: "account-incompatible",
      reason: `A ${account.backend} CLI account cannot resume a ${backend} manager turn.`,
    };
  }
  try {
    const profileId = await resolveSelectableNativeProfile(
      account.backend,
      account.profileId,
    );
    if (profileId !== account.profileId) {
      throw new Error("The selected native CLI account could not be pinned exactly.");
    }
    return { ok: true, account: { backend: account.backend, profileId } };
  } catch (error) {
    return {
      ok: false,
      outcome: "account-unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function returnUnfinishedManagerRecoveryToParked(
  runId: string,
  claimId: string,
  expectedEpoch: number,
  reason: string,
): Promise<void> {
  const run = await getRun(runId);
  if (!run) return;
  await commitRunChange(run, {
    type: "run.manager_turn_recovery_reparked",
    message: "Cora could not finish the recovered manager turn; it remains ready to retry",
    payload: { claimId, reason },
    mutate: (draft, timestamp) => {
      const recovery = draft.managerTurnRecovery;
      if (
        !recovery ||
        recovery.state !== "resuming" ||
        recovery.resumeClaimId !== claimId ||
        recovery.conversationEpoch !== expectedEpoch
      ) {
        return false;
      }
      if (
        conversationEpoch(draft) !== expectedEpoch ||
        isTerminalRunStatus(draft.status) ||
        draft.status === "blocked"
      ) {
        // A rewind/new generation, terminal verdict, or durable question owns
        // the run now. Retire the old recovery token without rewriting that
        // newer/user-owned state.
        delete draft.managerTurnRecovery;
        draft.updatedAt = timestamp;
        return;
      }
      recovery.state = "parked";
      delete recovery.resumeClaimId;
      delete recovery.resumeRequestedAt;
      if (draft.status === "paused") {
        // Stop/pause may have won while the replacement provider was live.
        // Preserve its reason and projection; only release the stale launch
        // lease so a later explicit Resume can claim it again.
        draft.updatedAt = timestamp;
        return;
      }
      if (
        draft.status !== "planning" &&
        draft.status !== "running" &&
        draft.status !== "reviewing"
      ) {
        delete draft.managerTurnRecovery;
        draft.updatedAt = timestamp;
        return;
      }
      draft.status = "paused";
      draft.autopilot = {
        ...(draft.autopilot ?? { status: "running", updatedAt: timestamp }),
        status: "paused",
        lastAction:
          recovery.managerMode === "chat"
            ? "chat_turn_parked"
            : "manager_turn_parked",
        stopReason:
          recovery.failureKind === "rate_limit"
            ? "The selected provider account reached its usage limit. Switch accounts or retry after quota resets."
            : recovery.failureKind === "transport"
              ? "Cora lost its provider connection. Retry when the connection is stable."
              : "Cora's provider is temporarily unavailable or at capacity. Retry the saved turn or switch accounts.",
        pausedAt: timestamp,
        updatedAt: timestamp,
      };
      draft.updatedAt = timestamp;
    },
  });
}

function scheduleClaimedManagerTurnRecovery(
  run: RunState,
  claimId: string,
): void {
  const recovery = run.managerTurnRecovery;
  if (
    !recovery ||
    recovery.state !== "resuming" ||
    recovery.resumeClaimId !== claimId
  ) {
    return;
  }
  const key = `${run.id}:${claimId}`;
  if (activeManagerTurnRecoveries.has(key)) return;
  const cycle = Promise.resolve()
    .then(async () => {
      const latest = await getRun(run.id);
      if (
        !latest ||
        latest.managerTurnRecovery?.state !== "resuming" ||
        latest.managerTurnRecovery.resumeClaimId !== claimId ||
        latest.managerTurnRecovery.conversationEpoch !==
          recovery.conversationEpoch ||
        conversationEpoch(latest) !== recovery.conversationEpoch ||
        (latest.status !== "planning" &&
          latest.status !== "running" &&
          latest.status !== "reviewing") ||
        isTerminalRunStatus(latest.status)
      ) {
        return;
      }
      const current = latest.managerTurnRecovery;
      await runManagerStageAfterQuestion(
        latest,
        autopilotInputFromRun(latest).cwd,
        current.managerMode,
        undefined,
        0,
        claimId,
      );
    })
    .catch(async (error) => {
      console.warn(
        `[run-store] parked manager turn recovery ${claimId} failed:`,
        error,
      );
    })
    .finally(async () => {
      activeManagerTurnRecoveries.delete(key);
      await returnUnfinishedManagerRecoveryToParked(
        run.id,
        claimId,
        recovery.conversationEpoch,
        "The replacement manager turn did not complete.",
      ).catch(() => undefined);
    });
  activeManagerTurnRecoveries.set(key, cycle);
  void cycle;
}

/**
 * Atomically claim one exact parked manager stage and, optionally, switch the
 * account that will serve it. The mutation returns before provider work
 * starts; retries with the same recovery id observe `already-resuming`.
 */
export async function resumeManagerTurnRecovery(
  input: ResumeManagerTurnRecoveryInput,
): Promise<ResumeManagerTurnRecoveryResult> {
  let run = await requireRun(input.runId);
  const recovery = run.managerTurnRecovery;
  if (!recovery || recovery.id !== input.recoveryId) {
    return { outcome: "stale", run };
  }
  if (recovery.state === "resuming") {
    return { outcome: "already-resuming", run };
  }
  if (
    run.status !== "paused" ||
    run.executionMode === "direct" ||
    (run.chatBackend ?? "pi") !== recovery.backend ||
    conversationEpoch(run) !== recovery.conversationEpoch
  ) {
    return { outcome: "stale", run };
  }

  const resolved = await resolveManagerRecoveryAccount(run, input.account);
  if (!resolved.ok) {
    return {
      outcome: resolved.outcome,
      run,
      reason: resolved.reason,
    };
  }

  const claimId = makeId("recovery-claim");
  const decision: { outcome: ResumeManagerTurnRecoveryResult["outcome"] } = {
    outcome: "stale",
  };
  run = await commitRunChange(run, {
    type: "run.manager_turn_recovery_claimed",
    message: "Parked manager turn recovery claimed",
    payload: {
      recoveryId: input.recoveryId,
      claimId,
      accountBackend: resolved.account?.backend,
      accountProfileId: resolved.account?.profileId,
    },
    mutate: (draft, timestamp) => {
      const current = draft.managerTurnRecovery;
      if (!current || current.id !== input.recoveryId) {
        decision.outcome = "stale";
        return false;
      }
      if (current.state === "resuming") {
        decision.outcome = "already-resuming";
        return false;
      }
      if (
        draft.status !== "paused" ||
        draft.executionMode === "direct" ||
        (draft.chatBackend ?? "pi") !== current.backend ||
        conversationEpoch(draft) !== current.conversationEpoch
      ) {
        decision.outcome = "stale";
        return false;
      }

      if (resolved.account) {
        if (resolved.account.backend !== current.backend) {
          decision.outcome = "account-incompatible";
          return false;
        }
        let accountChanged = false;
        if (resolved.account.backend === "pi") {
          accountChanged =
            draft.chatAccountProfileId !== resolved.account.profileId;
          draft.chatAccountProfileId = resolved.account.profileId;
        } else if (resolved.account.backend === "claude") {
          accountChanged =
            draft.nativeClaudeProfileId !== resolved.account.profileId;
          draft.nativeClaudeProfileId = resolved.account.profileId;
        } else {
          accountChanged =
            draft.nativeCodexProfileId !== resolved.account.profileId;
          draft.nativeCodexProfileId = resolved.account.profileId;
        }
        if (accountChanged) {
          delete draft.chatSessionUuid;
          delete draft.chatSessionMode;
          current.forceCanonicalReplay = true;
        }
        current.resumeAccountProfileId = resolved.account.profileId;
      }

      current.state = "resuming";
      current.resumeClaimId = claimId;
      current.resumeRequestedAt = timestamp;
      draft.status = "running";
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
      decision.outcome = "accepted";
    },
  });

  if (decision.outcome === "accepted") {
    scheduleClaimedManagerTurnRecovery(run, claimId);
  }
  return { outcome: decision.outcome, run };
}

/** One worker attempt a pause killed before it could finish. */
interface ResumeInterruptedAttempt {
  attemptId: string;
  attemptNumber: number;
  taskId: string;
  taskTitle: string;
  stepLabel: string;
}

// forcePauseRun kills the PTYs first and commits the pause after, so an attempt
// killed by that pause can carry a finishedAt slightly EARLIER than the recorded
// pausedAt. Attempts that settled further back than this belong to an older
// pause and are not this resume's business.
const PAUSE_KILL_LEAD_MS = 60_000;

// Header of the synthetic queued note the chat-route resume hands the manager.
// Doubles as the "one undelivered resume note at a time" marker.
const RESUME_INTERRUPTED_NOTE_HEADER = "[Cora resume — worker attempts interrupted by the pause]";

// How many interrupted attempts are named individually before the note tails
// off into a count. A killed wave is usually 2-6 workers; the cap only guards
// against a pathological run bloating the manager prompt.
const RESUME_INTERRUPTED_NOTE_LIMIT = 12;

/**
 * The attempts a pause interrupted and nobody has picked back up: their task is
 * still `cancelled` (so no follow-up task superseded it) and their newest
 * attempt is `cancelled` (killed, not failed and not retried). This is the list
 * the manager needs on resume — it owns retry bookkeeping, so Resume's job is
 * to tell it exactly what stopped mid-flight, not to relaunch behind its back.
 */
function interruptedAttemptsForResume(run: RunState): ResumeInterruptedAttempt[] {
  const pausedAtMs = Date.parse(run.autopilot?.pausedAt ?? "");
  const supersededTaskIds = new Set(
    run.workerTasks
      .map((task) => task.supersedesTaskId)
      .filter((id): id is string => Boolean(id)),
  );
  const rows: ResumeInterruptedAttempt[] = [];
  for (const task of run.workerTasks) {
    if (task.status !== "cancelled") continue;
    if (supersededTaskIds.has(task.id)) continue;
    const attempts = run.workerAttempts.filter((attempt) => attempt.workerTaskId === task.id);
    if (attempts.length === 0) continue;
    const latest = attempts.reduce((best, attempt) =>
      (attempt.attemptNumber ?? 0) >= (best.attemptNumber ?? 0) ? attempt : best,
    );
    if (latest.status !== "cancelled") continue;
    if (Number.isFinite(pausedAtMs)) {
      const finishedMs = Date.parse(latest.finishedAt ?? "");
      if (Number.isFinite(finishedMs) && finishedMs < pausedAtMs - PAUSE_KILL_LEAD_MS) continue;
    }
    const step = task.stepId ? run.steps.find((item) => item.id === task.stepId) : undefined;
    rows.push({
      attemptId: latest.id,
      attemptNumber: latest.attemptNumber ?? 1,
      taskId: task.id,
      taskTitle: task.title,
      stepLabel: step ? `Step ${step.index} "${step.title}"` : "No step",
    });
  }
  return rows;
}

/**
 * The manager turn a paused resume dispatches gets its context the same way the
 * board nudge does: one synthetic queued user note (the house pattern for
 * synthetic conversation input — see nudgeBoardManager). Anything else would
 * have to travel through the prompt builder, which is a pure function of the
 * run plus its queued input.
 */
function composeResumeInterruptedNote(rows: ResumeInterruptedAttempt[]): string {
  const listed = rows.slice(0, RESUME_INTERRUPTED_NOTE_LIMIT);
  const remaining = rows.length - listed.length;
  return [
    RESUME_INTERRUPTED_NOTE_HEADER,
    "Resume this run. The pause stopped the attempts below before they finished, and nothing is running now:",
    ...listed.map(
      (row) =>
        `- ${row.stepLabel} · ${row.taskTitle} — task ${row.taskId}, attempt ${row.attemptId} (attempt #${row.attemptNumber}, interrupted)`,
    ),
    ...(remaining > 0 ? [`- …and ${remaining} more interrupted attempt(s).`] : []),
    "Re-issue the work that is still needed (relaunch those tasks, or replace them if the plan changed), then carry on.",
  ].join("\n");
}

/**
 * Settle the resume notes already on the run, and report whether one of them is
 * still deliverable.
 *
 * A note queued in the CURRENT epoch is live — the next manager turn consumes
 * it (queuedManagerInputMessages) — so this resume must not stack a second one.
 * A note the epoch moved past is a different animal: a force pause that lands
 * between the resume commit and the turn start bumps the conversation epoch
 * without re-homing an UNCLAIMED note (forcePauseRun only re-homes input a live
 * call owned), and queuedManagerInputMessages never looks outside the current
 * epoch. That note can no longer be delivered, so it must neither block a fresh
 * one nor sit "queued" forever: cancel it, which is exactly what that delivery
 * state means, and let this resume write the current list of interrupted work.
 */
function settleResumeInterruptedNotes(draft: RunState): boolean {
  const epoch = conversationEpoch(draft);
  let deliverable = false;
  for (const message of draft.humanMessages) {
    if (message.resumeNote !== true || message.deliveryState !== "queued") continue;
    if ((message.conversationEpoch ?? 0) === epoch) {
      deliverable = true;
      continue;
    }
    message.deliveryState = "cancelled";
  }
  return deliverable;
}

export async function resumeRun(input: ResumeRunInput): Promise<RunState> {
  const run = await requireRun(input.runId);
  // A run blocked on an open question resumes by ANSWERING it, never by a plain
  // resume. Plain-resuming it wedged the run: this function drops the blocker
  // and writes "running", but nothing is scheduled to drive it (an auto Pi
  // manager fails shouldScheduleDriver, and shouldResumeManagerPlanning only
  // fires from "paused"), and answerRunQuestion then rejects the orphaned
  // question off the non-blocked state — an unanswerable question on a run with
  // no driver. The guard lives here because every transport (renderer IPC,
  // remote access, CLI bridge) resumes through this one function.
  const blockingQuestion = resumeBlockingRunQuestion(run);
  if (blockingQuestion) {
    throw new Error(`Run is blocked on question ${blockingQuestion.id}. Answer it to resume.`);
  }
  if (run.managerTurnRecovery) {
    if (run.managerTurnRecovery.state === "resuming") return run;
    return (
      await resumeManagerTurnRecovery({
        runId: run.id,
        recoveryId: run.managerTurnRecovery.id,
      })
    ).run;
  }
  const resumeInput = autopilotInputFromRun(run);
  const shouldScheduleManagerAfterResume = shouldResumeManagerPlanning(run);
  // A run parked by the manager-turn failure policy (provider overload/rate
  // limit) resumes with a fresh chat turn. Unapplied input was requeued at
  // park time; if a live Pi tool had already mutated the run, that input was
  // acknowledged and the fresh turn continues from the durable run state
  // instead of replaying the side effect.
  const parkedChatTurn =
    run.status === "paused" && run.autopilot?.lastAction === "chat_turn_parked";
  // A force-paused run has no live worker left to receive a resume signal:
  // forcePauseRun killed every PTY. sendResumeSignals is then a no-op, and the
  // fallback below commits "running" with nothing driving the run — the wedge
  // users hit as "Stop, Resume, nothing happens" (run.json: status running,
  // last spark call failed, no workers, no autopilot cycle). So ANY paused
  // resume that finds no worker in flight goes through the manager chat turn:
  // it is the one driver that can relaunch the interrupted work, and it owns
  // the retry bookkeeping.
  //
  // Three shapes keep the old signal path, matching nudgeBoardManager's
  // eligibility rules for the same synthetic-note-plus-chat-turn move:
  //   - direct (loom) runs: their manager calls are deliberately suppressed, so
  //     a chat turn drives nothing;
  //   - automation runs: an automation drives itself from its schedule and has
  //     no conversational manager to hand a note to;
  //   - a run paused with a manager turn STILL in flight (the soft pauseRun
  //     path never kills the turn): it already has its driver, and a second
  //     concurrent turn would race the first one's decision.
  const pausedWithNoWorkers =
    run.status === "paused" &&
    run.executionMode !== "direct" &&
    !run.automationId &&
    !activeManagerCall(run);
  // Sticky for the fallback below: a resume that already spent its chat turn
  // must still leave a driver behind if that turn neither settled the run nor
  // spawned work (a failed/suppressed manager call returns null here).
  let routedToChat = false;
  if (
    activeWorkersForRun(run.id).length === 0 &&
    (parkedChatTurn || pausedWithNoWorkers || shouldRoutePausedResumeToChat(run))
  ) {
    routedToChat = true;
    // Leave "paused" BEFORE the turn dispatches. The turn-failure policy and
    // its retry guards read run.status: a turn resumed while the run still
    // says "paused" would forfeit its transient-retry budget (the post-sleep
    // guard rejects non-driving states), and the header would keep the parked
    // parked banner through a perfectly healthy resumed turn.
    const interruptedAttempts = interruptedAttemptsForResume(run);
    const driving = await commitRunChange(run, {
      type: "run.resumed",
      message: parkedChatTurn
        ? "Run resumed to retry the parked chat turn"
        : "Run resumed with a chat turn",
      payload: {
        route: "chat",
        parkedChatTurn,
        interruptedAttemptIds: interruptedAttempts.map((row) => row.attemptId),
      },
      mutate: (draft, timestamp) => {
        // Recomputed off the authoritative draft: the cached run this call read
        // may be a mutation or two old by the time the commit runs.
        const interrupted = interruptedAttemptsForResume(draft);
        const noteAlreadyDeliverable = settleResumeInterruptedNotes(draft);
        if (interrupted.length > 0 && !noteAlreadyDeliverable) {
          draft.humanMessages.push({
            id: makeId("msg"),
            runId: draft.id,
            author: "user",
            kind: "note",
            // Same contract as boardNote: authored "user" so delivery hands it
            // to the manager, flagged so no surface or heuristic mistakes it
            // for something the user typed.
            resumeNote: true,
            message: composeResumeInterruptedNote(interrupted),
            intent: "turn",
            // "queued" (not acknowledged) is what makes the chat turn dispatched
            // below consume this as its input — see queuedManagerInputMessages.
            deliveryState: "queued",
            conversationEpoch: conversationEpoch(draft),
            createdAt: timestamp,
          });
        }
        draft.status = "running";
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
    // askManagerBackend's own failure policy (park / retry / fail) only covers
    // what happens INSIDE a turn. Everything before the turn exists throws
    // straight out: the untrusted-pull-request backend refusal, an account that
    // will not resolve or freeze, a turn that went stale during startup. Left
    // unguarded, that throw escapes resumeRun with the commit above already
    // applied — "running", no driver, and no Resume button to try again, which
    // is the exact wedge this function is being fixed for. Catch it, journal it,
    // and fall through: routedToChat is already set, so the tail below still
    // schedules a driver (and that turn surfaces the same failure through
    // markAutopilotCycleFailed, where the UI can see it).
    let chatDecision: RunState | null = null;
    try {
      chatDecision = await askManagerForChat(driving, resumeInput.cwd);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[run-store] resume chat turn for ${driving.id} could not start: ${detail}`);
      await appendEvent({
        workspaceId: driving.workspaceId,
        runId: driving.id,
        type: "run.resume_chat_turn_failed",
        message: `Cora's resume chat turn could not start: ${detail}`,
        payload: { route: "chat", error: detail },
      });
    }
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
  const isExecuteModeCliManager = runHasMcpManager(resumed);
  // ...but that exemption assumes the manager session is still ALIVE to receive
  // those signals. A run parked by the restart pass has no live anything: its
  // manager session and every worker process died with the previous app
  // process, and the resume signals are written to in-memory worker handles
  // that no longer exist. Without this the default configuration (pi + auto)
  // took the exemption, so Resume flipped the run to "running" with no workers
  // and no scheduled manager, and nothing ever drove it again. That merely
  // moved the wedge from boot to the first Resume click.
  const parkedByRestart = resumed.autopilot?.lastAction === "paused_after_restart";
  // A run parked by the manager-turn failure policy is in the same boat: the
  // turn that would have driven it died with the provider, so the resume
  // signals sent above have no live manager to land on. Schedule a driver.
  const parkedManagerTurn = isParkedManagerTurnAction(run.autopilot?.lastAction);
  // Reaching here after the chat route means that turn neither settled the run
  // nor spawned work — a failed or suppressed manager call returns null, and a
  // reply-only decision leaves the run driving nothing. The exemption above
  // assumes a live manager session is listening to the resume signals; the turn
  // that would have been it just died. Schedule a driver so a resumed run is
  // never left "running" with nothing scheduled.
  const shouldScheduleDriver =
    (parkedByRestart || parkedManagerTurn || routedToChat || !isExecuteModeCliManager) &&
    activeWorkersForRun(resumed.id).length === 0;
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
  if (
    input.author === "user" &&
    runProjectPolicyMode(updated) === "trusted"
  ) {
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
  // A paused run has no manager turn to queue behind, so neither branch above
  // fires and the message would sit unread until the user pressed Resume.
  // Sending IS resuming — see scheduleResumeForUserMessage for what that
  // covers and what it deliberately leaves to the question/terminal paths.
  if (input.author === "user") {
    scheduleResumeForUserMessage(updated, recordedIntent);
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
        pty.dispose(worker.attemptId, { sanctioned: true });
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

// ── Cora Board (the per-chat kanban) ────────────────────────────────────────
// Persisted on RunState.board exactly like the whiteboard: every write is one
// commitRunChange with the baseRevision guard evaluated inside the mutate (so
// it validates against the state at the head of the per-run mutation queue,
// not the caller's snapshot). The card model itself lives in board-store.ts.

/** Conflict carrying the current board so the user path can resolve ok:false
 * instead of throwing (the agent path rethrows it as an RPC error). */
class BoardRevisionConflictError extends Error {
  readonly board: RunBoard;
  constructor(baseRevision: number, board: RunBoard) {
    super(
      `Board changed since revision ${baseRevision}. Read it again and apply the update to revision ${board.revision}.`,
    );
    this.name = "BoardRevisionConflictError";
    this.board = board;
  }
}

// One adoption attempt per workspace at a time: two chats opening empty boards
// concurrently must not both adopt the legacy workspace board's cards.
const legacyBoardAdoptionOps = new Map<string, Promise<void>>();

function withLegacyBoardAdoption(workspaceId: string, fn: () => Promise<void>): Promise<void> {
  const previous = legacyBoardAdoptionOps.get(workspaceId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  legacyBoardAdoptionOps.set(
    workspaceId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * One-time migration: a run opening its empty board adopts the retired
 * per-workspace board's cards (see board-store.ts for the lane mapping).
 * Returns whether any cards were adopted by THIS call.
 *
 * Crash-safety ordering: the merge is idempotent (dedup by card id), so the
 * sidecar marker is written AFTER the successful commit. A crash between the
 * two leaves the marker missing and the worst case is a harmless re-adoption
 * merge on the next open, never a permanent loss of the legacy cards. The
 * per-workspace mutex keeps two concurrent chats from double-adopting within
 * a session; the marker keeps later sessions out.
 */
async function adoptLegacyBoardIfPending(run: RunState): Promise<boolean> {
  const workspaceId = run.workspaceId;
  if (!workspaceId) return false;
  let adopted = false;
  await withLegacyBoardAdoption(workspaceId, async () => {
    const latest = await getRun(run.id);
    // Only a chat with an EMPTY board inherits the legacy cards — a board the
    // user or Cora already populated keeps its content, and the legacy cards
    // stay available for the next empty-board chat.
    if (!latest || (latest.board && latest.board.cards.length > 0)) return;
    const adoption = await readLegacyBoardForAdoption(workspaceId);
    if (!adoption) return;
    await commitRunChange(latest, {
      type: "run.board_updated",
      message: `Adopted ${adoption.cards.length} card(s) from the legacy workspace board`,
      payload: { editor: "system", action: "adopt_legacy", cardCount: adoption.cards.length },
      mutate: (draft, timestamp) => {
        const current = draft.board ?? emptyRunBoard();
        const have = new Set(current.cards.map((card) => card.id));
        const merged = [...current.cards, ...adoption.cards.filter((card) => !have.has(card.id))];
        if (merged.length === current.cards.length && draft.board) return false;
        draft.board = { revision: current.revision + 1, cards: merged };
        draft.updatedAt = timestamp;
        adopted = true;
      },
    });
    if (adopted) await markLegacyBoardAdopted(workspaceId, run.id);
  });
  return adopted;
}

/**
 * This chat's board, or an empty default (never persisted until the first
 * write). Opening the board is what triggers legacy adoption, so the first
 * chat to look at an empty board in a workspace that still has the old
 * per-workspace kanban inherits its cards.
 */
export async function getRunBoard(runId: string): Promise<RunBoard> {
  const run = await requireRun(runId);
  // An EMPTY board (absent or zero cards) re-checks adoption: the marker
  // makes the check a single stat once a board has been adopted. A crash
  // between the adopting commit and its marker leaves the legacy file
  // unmarked; the adopting run's board is non-empty so IT never re-enters
  // this path, and the next chat that opens an empty board in the workspace
  // adopts a duplicate copy. Deliberate trade: duplicated cards are
  // recoverable, silently orphaned ones are not.
  if (run.board && run.board.cards.length > 0) return run.board;
  await adoptLegacyBoardIfPending(run);
  const fresh = await requireRun(runId);
  return fresh.board ?? emptyRunBoard();
}

/**
 * Guarded USER write from the renderer (full card powers; new cards stamped
 * createdBy "user"). A stale baseRevision resolves ok:false with the current
 * board so the caller rebases rather than treating it as an exception.
 */
export async function updateRunBoard(
  input: RunBoardUpdateInput & { workspaceCwd?: string },
): Promise<RunBoardUpdateResult> {
  const run = await requireRun(input.runId);
  // Materialize adoption first so this chat's very first write can't strand
  // the legacy cards behind a board that is no longer empty. The merge branch
  // below fires only when adoption ACTUALLY ran in this call — an empty but
  // already-initialized board must still conflict normally.
  const adoptionRace =
    run.board && run.board.cards.length > 0 ? false : await adoptLegacyBoardIfPending(run);
  const baseRevision = Math.max(0, Math.floor(input.baseRevision));
  try {
    const updated = await commitRunChange(await requireRun(input.runId), {
      type: "run.board_updated",
      message: "Updated Cora Board",
      payload: {
        editor: "user",
        baseRevision,
        cardCount: Array.isArray(input.cards) ? input.cards.length : 0,
      },
      mutate: (draft, timestamp) => {
        const current = draft.board ?? emptyRunBoard();
        let nextCards: BoardCard[];
        if (adoptionRace && baseRevision === 0 && current.revision > 0) {
          // The write was composed against the empty board this chat had
          // before legacy adoption landed mid-call. Its cards are new by
          // construction, so append them to the adopted set instead of
          // bouncing the user's very first card as a conflict.
          const incoming = applyUserBoardUpdate(current, input.cards, input.workspaceCwd).filter(
            (card) => !current.cards.some((existing) => existing.id === card.id),
          );
          nextCards = [...current.cards, ...incoming];
        } else {
          if (baseRevision !== current.revision) {
            throw new BoardRevisionConflictError(baseRevision, current);
          }
          nextCards = applyUserBoardUpdate(current, input.cards, input.workspaceCwd);
        }
        draft.board = { revision: current.revision + 1, cards: nextCards };
        draft.updatedAt = timestamp;
      },
    });
    return { ok: true, board: updated.board ?? emptyRunBoard() };
  } catch (err) {
    if (err instanceof BoardRevisionConflictError) {
      return { ok: false, error: err.message, board: err.board };
    }
    throw err;
  }
}

/**
 * Guarded AGENT write. `cards` must already have passed agent-socket's
 * authorizeAgentBoardWrite (which enforces the permission matrix and strips
 * what the model may not touch); this commit re-normalizes them against the
 * live board so server-owned fields still come from stored state even if the
 * authorization snapshot was a hair old. Throws on a stale baseRevision so the
 * RPC surfaces a re-read instruction to the model.
 */
export async function updateRunBoardFromAgent(input: {
  runId: string;
  baseRevision: number;
  cards: BoardCard[];
}): Promise<RunBoard> {
  const run = await requireRun(input.runId);
  const baseRevision = Math.max(0, Math.floor(input.baseRevision));
  const updated = await commitRunChange(run, {
    type: "run.board_updated",
    message: "Cora updated the board",
    payload: { editor: "agent", baseRevision, cardCount: input.cards.length },
    mutate: (draft, timestamp) => {
      const current = draft.board ?? emptyRunBoard();
      if (baseRevision !== current.revision) {
        throw new Error(
          `Board changed since revision ${baseRevision}. Read it again with codara_board_get and apply the update to revision ${current.revision}.`,
        );
      }
      const validTaskIds = new Set(draft.workerTasks.map((task) => task.id));
      draft.board = {
        revision: current.revision + 1,
        cards: normalizeBoardCards(input.cards, {
          existingById: new Map(current.cards.map((card) => [card.id, card])),
          stampAuthor: "agent",
          acceptWorkerTaskIds: validTaskIds,
        }),
      };
      draft.updatedAt = timestamp;
    },
  });
  return updated.board ?? emptyRunBoard();
}

// ── Board nudge ─────────────────────────────────────────────────────────────
// When cards are queued on a run's board and that run's manager is idle, the
// board-nudge module asks this function to hand the queued cards to the
// manager: it injects one synthetic queued user note describing them (the
// house pattern for synthetic conversation input; flagged boardNote so the
// renderer can label it) and schedules a chat decision, exactly like the
// terminal-revive path in addRunMessage. It never touches automation runs and
// never interrupts an active manager.

export type BoardNudgeOutcome = "nudged" | "busy" | "no_queued" | "ineligible";

export async function nudgeBoardManager(runId: string): Promise<BoardNudgeOutcome> {
  const run = await getRun(runId);
  if (!run) return "ineligible";
  if (run.automationId || run.executionMode === "direct") return "ineligible";
  // paused/blocked wait for the user; cancelled is terminal-by-choice. All
  // three come back through the nudge module's pending set when the run's
  // status next changes.
  if (run.status === "blocked" || run.status === "paused" || run.status === "cancelled") {
    return "busy";
  }
  const queued = (run.board?.cards ?? []).filter((card) => card.status === "queued");
  if (queued.length === 0) return "no_queued";
  if (
    isRunMidAutoCompaction(runId) ||
    activeManagerCall(run) ||
    activeWorkersForRun(runId).length > 0 ||
    activeAutopilotPlans.has(runId) ||
    activeAutopilotReviews.has(runId) ||
    [...activeAutopilotCycles.keys()].some((key) => key.startsWith(`${runId}:`))
  ) {
    // The manager (or its workers) is mid-flight; it will either read the
    // board itself or get nudged when the run settles.
    return "busy";
  }

  const noteId = makeId("msg");
  let injected = false;
  let alreadyPending = false;
  const updated = await commitRunChange(run, {
    type: "run.board_nudged",
    message: `Cora Board: ${queued.length} queued card(s) handed to the manager`,
    payload: { noteMessageId: noteId, cardIds: queued.map((card) => card.id) },
    mutate: (draft, timestamp) => {
      // Re-check everything the pre-read validated: the commit runs behind
      // whatever else was in the mutation queue.
      if (draft.automationId || draft.executionMode === "direct") return false;
      if (draft.status === "blocked" || draft.status === "paused" || draft.status === "cancelled") {
        return false;
      }
      const stillQueued = (draft.board?.cards ?? []).filter((card) => card.status === "queued");
      if (stillQueued.length === 0) return false;
      // One undelivered nudge at a time: if an earlier board note is still
      // queued in this conversation epoch, the manager will see the board
      // anyway — stacking a second note would double-prompt the same work.
      const epoch = draft.conversationEpoch ?? 0;
      const undeliveredNudge = draft.humanMessages.some(
        (message) =>
          message.boardNote === true &&
          message.deliveryState === "queued" &&
          (message.conversationEpoch ?? 0) === epoch,
      );
      if (undeliveredNudge) {
        alreadyPending = true;
        return false;
      }
      draft.humanMessages.push({
        id: noteId,
        runId: draft.id,
        author: "user",
        kind: "note",
        boardNote: true,
        message: composeBoardNudgeMessage(stillQueued),
        intent: "turn",
        // "queued" (not acknowledged) is what makes the next manager turn
        // consume this as its new input (see queuedManagerInputMessages).
        deliveryState: "queued",
        conversationEpoch: draft.conversationEpoch ?? 0,
        createdAt: timestamp,
      });
      if (draft.status === "idle" || draft.status === "complete" || draft.status === "failed") {
        // Mirror the terminal-revive path: flip to planning so surfaces show
        // the manager is about to act.
        draft.status = "planning";
        if (draft.autopilot) {
          draft.autopilot.lastAction = "board_nudge";
          draft.autopilot.updatedAt = timestamp;
        }
      }
      draft.updatedAt = timestamp;
      injected = true;
    },
  });
  if (injected) {
    scheduleInitialChatDecision(updated.id, autopilotInputFromRun(updated), { afterCurrent: true });
    return "nudged";
  }
  // An earlier note is still queued: the cards are already handed over, so
  // report "nudged" (the caller's ledger marks them) without stacking a
  // second note or a second decision.
  return alreadyPending ? "nudged" : "busy";
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

/** Stored-response outcome for the call-scoped codara_complete application. */
export interface CodaraCompleteApplicationOutcome {
  run: RunState;
  callId: string;
  replayed: boolean;
  result: { ok: true };
}

/**
 * Apply the live codara_complete tool exactly once for the authoritative
 * current-epoch manager call.
 *
 * The completion note, terminal run projection, and application receipt share
 * one run.json commit. The SparkCall deliberately remains started until the
 * provider turn reaches the manager-call settlement boundary; if the process
 * exits in between, boot recovery uses the receipt to settle locally without
 * replaying the provider.
 */
export async function applyCodaraCompleteFromManagerCall(input: {
  runId: string;
  summary: string;
}): Promise<CodaraCompleteApplicationOutcome> {
  const run = await requireRun(input.runId);
  const summary = canonicalCodaraCompleteSummary(input.summary);
  const payloadSha256 = hashCodaraCompletePayload(summary);
  let outcome: Omit<CodaraCompleteApplicationOutcome, "run"> | undefined;
  const eventPayload: Record<string, unknown> = {
    requestedStatus: "complete",
    source: "codara_complete",
  };

  const applied = await commitRunChange(run, {
    type: "run.status_change_requested",
    message: "Cora marked the run complete",
    payload: eventPayload,
    mutate: (draft, timestamp) => {
      const epoch = conversationEpoch(draft);
      const activeCalls = draft.sparkCalls.filter(
        (call) =>
          call.status === "started" &&
          !call.completedAt &&
          call.purpose !== "compaction" &&
          (call.conversationEpoch ?? 0) === epoch,
      );
      if (activeCalls.length === 0) {
        throw new Error(
          "No active current-epoch manager call can apply codara_complete.",
        );
      }
      if (activeCalls.length > 1) {
        throw new Error(
          `Ambiguous active current-epoch manager calls (${activeCalls.length}); refusing codara_complete.`,
        );
      }

      const call = activeCalls[0];
      if (call.applicationReceiptIntegrity === "invalid") {
        throw new Error(
          `Manager application receipt integrity failed for ${call.id}; refusing codara_complete.`,
        );
      }
      const existing = codaraCompleteReceiptForCall(call);
      if (existing) {
        if (existing.payloadSha256 !== payloadSha256) {
          throw new Error(
            "codara_complete was already applied for this manager call with a different payload.",
          );
        }
        outcome = {
          callId: call.id,
          replayed: true,
          result: existing.result,
        };
        return false;
      }
      if ((call.applicationReceipts?.length ?? 0) !== 0) {
        throw new Error(
          `Manager application receipt integrity failed for ${call.id}; refusing codara_complete.`,
        );
      }

      const summaryMessageId = summary ? makeId("msg") : undefined;
      if (summaryMessageId) {
        draft.humanMessages.push({
          id: summaryMessageId,
          runId: draft.id,
          author: "spark",
          kind: "note",
          message: summary,
          attachments: [],
          intent: "answer",
          deliveryState: "acknowledged",
          backendTurnId: call.id,
          conversationEpoch: epoch,
          createdAt: timestamp,
        });
      }

      const matchingRecovery =
        call.managerRecoveryClaimId &&
        draft.managerTurnRecovery?.state === "resuming" &&
        draft.managerTurnRecovery.resumeClaimId === call.managerRecoveryClaimId
          ? draft.managerTurnRecovery
          : undefined;
      const receipt: ManagerApplicationReceipt = {
        key: codaraCompleteReceiptKey(call.id),
        method: "codara_complete",
        state: "effects_applied",
        payloadSchemaVersion: 1,
        payloadSha256,
        result: { ok: true },
        appliedAt: timestamp,
        ...(summaryMessageId ? { summaryMessageId } : {}),
        ...(matchingRecovery?.resumeAccountProfileId
          ? { recoveryAccountProfileId: matchingRecovery.resumeAccountProfileId }
          : {}),
      };
      call.applicationReceipts = [receipt];

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

      eventPayload.callId = call.id;
      eventPayload.conversationEpoch = epoch;
      eventPayload.receiptKey = receipt.key;
      eventPayload.summaryMessageId = summaryMessageId;
      outcome = { callId: call.id, replayed: false, result: receipt.result };
    },
  });

  if (!outcome) {
    throw new Error("codara_complete did not establish an application result.");
  }
  return { run: applied, ...outcome };
}

/**
 * Terminalize a run from non-live-tool orchestration paths. Live
 * codara_complete calls must use applyCodaraCompleteFromManagerCall so their
 * application receipt and summary share the terminal status commit.
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
    input.chat1mContext === undefined;
  if (noChange) return run;
  if (run.managerTurnRecovery?.state === "resuming") {
    throw new Error(
      "Cora is retrying this turn with a frozen provider configuration. Wait for that retry to finish before changing its backend, model, mode, or effort.",
    );
  }
  const nextBackend = input.chatBackend ?? run.chatBackend ?? "pi";
  if (
    runProjectPolicyMode(run) === "untrusted-pull-request" &&
    nextBackend !== "pi"
  ) {
    throw new Error(
      "Imported pull-request runs cannot switch to a native manager until project policy isolation is available for that CLI.",
    );
  }
  const switchingBackend =
    input.chatBackend !== undefined && input.chatBackend !== run.chatBackend;
  // Account identity is not a per-chat input. Switching onto a native backend
  // re-freezes that provider's active account from Settings; everything else
  // leaves the run's pinned accounts untouched.
  const nextNativeCodexProfileId =
    nextBackend === "codex" && switchingBackend
      ? await resolveSelectableNativeProfile("codex", undefined)
      : null;
  const nextNativeClaudeProfileId =
    nextBackend === "claude" && switchingBackend
      ? await resolveSelectableNativeProfile("claude", undefined)
      : null;
  const nextFeatureFlags = normalizeChatFeatureFlags(nextBackend, {
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
        nativeCodexProfileId: run.nativeCodexProfileId,
        nativeClaudeProfileId: run.nativeClaudeProfileId,
        coraExecutionPolicy: run.coraExecutionPolicy,
        chat1mContext: run.chat1mContext,
      },
      next: {
        chatBackend: input.chatBackend ?? run.chatBackend,
        chatModel: input.chatModel ?? run.chatModel,
        chatMode: input.chatMode ?? run.chatMode,
        chatEffort: input.chatEffort ?? run.chatEffort,
        nativeCodexProfileId:
          nextNativeCodexProfileId ?? run.nativeCodexProfileId,
        nativeClaudeProfileId:
          nextNativeClaudeProfileId ?? run.nativeClaudeProfileId,
        coraExecutionPolicy: nextExecutionPolicy,
        chat1mContext: nextFeatureFlags.chat1mContext,
      },
    },
    mutate: (draft, timestamp) => {
      if (input.chatBackend !== undefined) draft.chatBackend = input.chatBackend;
      if (input.chatModel !== undefined) draft.chatModel = input.chatModel.trim() || undefined;
      if (input.chatMode !== undefined) draft.chatMode = input.chatMode;
      if (input.chatEffort !== undefined) draft.chatEffort = input.chatEffort;
      if (nextNativeCodexProfileId !== null) {
        draft.nativeCodexProfileId = nextNativeCodexProfileId;
      }
      if (nextNativeClaudeProfileId !== null) {
        draft.nativeClaudeProfileId = nextNativeClaudeProfileId;
      }
      if (input.coraExecutionPolicy !== undefined) {
        draft.coraExecutionPolicy = nextExecutionPolicy;
      }
      draft.chat1mContext = nextFeatureFlags.chat1mContext;
      // Switching backend invalidates the prior session UUID — the new
      // backend would mis-resume otherwise. Selected per the answers: no
      // cross-backend handoff; each backend gets its own fresh thread.
      if (switchingBackend) {
        draft.chatSessionUuid = undefined;
        draft.chatSessionMode = undefined;
      }
      // A Pi policy change alters the active system contract and extension
      // set. Rotate the provider session instead of letting Deep/Frontier
      // inherit a transcript created under Fast (or vice versa). Reachable
      // only when a caller PINS the policy explicitly (no UI does): a policy
      // that moves because the manager reclassified complexity must NOT come
      // through here, because dropping chatSessionUuid would drop the thread.
      // Pi restarts its own runtime for that case via its session identity.
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

// Complexity classification arriving from an MCP orchestrator (Pi / CC /
// Codex execute mode) rather than from a JSON manager decision. Those turns
// mutate the run live through tool calls, so they never reach the
// plan_analysis branch in applySparkManagerDecision that persists the same
// field. Emits the identical event so both paths read alike in the timeline.
// No-op when unchanged; the classification may legitimately move as a chat
// run's scope grows.
export async function recordTaskComplexity(
  runId: string,
  taskComplexity: TaskComplexity,
): Promise<RunState> {
  const run = await requireRun(runId);
  if (run.taskComplexity === taskComplexity) return run;
  return commitRunChange(run, {
    type: "spark_manager.task_complexity_classified",
    message: `Manager classified the run as taskComplexity=${taskComplexity}`,
    payload: {
      taskComplexity,
      priorComplexity: run.taskComplexity,
      source: "orchestrator_tool",
    },
    mutate: (draft, timestamp) => {
      draft.taskComplexity = taskComplexity;
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
    ...(input.isolated === true ? { isolated: true as const } : {}),
    ...(input.peers === true ? { peers: true as const } : {}),
    conflictsWith: input.conflictsWith ?? [],
    taskClass: input.taskClass,
    writeScopeSource: input.writeScopeSource,
    parallelTrust: input.parallelTrust,
    councilGroupId: input.councilGroupId,
    candidateIndex: input.candidateIndex,
    councilRole: input.councilRole,
    createdBy: input.createdBy ?? "user",
    loomNodeId: input.loomNodeId,
    accessHint: input.accessHint,
    blockedToolsHint: input.blockedToolsHint,
    collabMailDirHint: input.collabMailDirHint,
    followUpOfTaskId: input.followUpOfTaskId,
    resumeSessionId: input.resumeSessionId,
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
  const attemptUserConstitution = copyRunUserConstitutionCapture(run);
  const attempt: WorkerAttempt = {
    id: makeId("attempt"),
    runId: run.id,
    ...(attemptUserConstitution ? { userConstitution: attemptUserConstitution } : {}),
    workerTaskId: task.id,
    attemptNumber,
    runtime: task.runtimePreference,
    cwd: input.cwd,
    status: "prompt_ready",
  };
  // Only native Codex transports own a CODEX_HOME. Codex-labelled Pi workers
  // keep their separate Pi account identity and never enter this path.
  if (
    task.runtimePreference === "codex" &&
    process.env.SPARK_E2E_LEGACY_WORKER_HARNESS === "1" &&
    runProjectPolicyMode(run) === "trusted"
  ) {
    attempt.nativeCodexProfileId = (
      await resolveNewNativeCodexProfile()
    ).profileId;
  }
  if (
    task.runtimePreference === "claude" &&
    process.env.SPARK_E2E_LEGACY_WORKER_HARNESS === "1" &&
    runProjectPolicyMode(run) === "trusted"
  ) {
    attempt.nativeClaudeProfileId = (
      await resolveNewNativeClaudeProfile()
    ).profileId;
  }
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
    runProjectPolicyMode(run) === "trusted" &&
    settings.autopilotSandbox &&
    !task.councilGroupId &&
    (await isGitWorktreeRepo(input.cwd))
  ) {
    try {
      const worktreesRoot = join(
        managedWorktreesRoot(sparkHome(), input.cwd),
        "sandbox",
      );
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
    nativeCodexProfileId: attempt.nativeCodexProfileId,
    nativeClaudeProfileId: attempt.nativeClaudeProfileId,
    cwd: effectiveCwd,
    executionDisabled: true,
    task,
    step,
    paths,
    createdAt: timestamp,
  };
  const peerCommsEnabled = shouldUsePeerComms(run, step, task);
  // Persist the group-chat gate's answer on the task itself. The renderer
  // already receives workerTasks, so this is what lets the run graph draw the
  // flagged workers as a team that can message itself rather than as isolated
  // satellites. `task` is the live run record, and both the envelope JSON below
  // and saveRun pick it up.
  if (peerCommsEnabled) task.peerComms = true;
  else delete task.peerComms;
  // Broader than the group chat on purpose: an unflagged batch worker still
  // gets the mailbox so Cora can steer it (codara_message_workers). The
  // registry roster inside keeps peer traffic restricted to flagged workers.
  if (shouldProvisionWorkerMailbox(run, step, task)) {
    await ensurePeerCommsArtifacts(run, step, task, attempt.id, paths, "prompt_ready").catch(() => undefined);
  }
  const priorHandoffs = await collectPriorWorkerHandoffs(run, task);
  const priorVerifierRound = await collectPriorVerifierRound(run, task);
  const prompt = renderWorkerPrompt({
    cwd: effectiveCwd,
    run,
    step,
    task,
    paths,
    settings,
    priorHandoffs,
    priorVerifierRound,
  });

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
      nativeCodexProfileId: attempt.nativeCodexProfileId,
      nativeClaudeProfileId: attempt.nativeClaudeProfileId,
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
    runtimes.find((runtime) => runtime.kind === "codex" && runtimeAssignable(runtime)) ??
    runtimes.find((runtime) => runtime.kind === "claude" && runtimeAssignable(runtime));
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

  // Select the concrete launch seam before performing any launch work. An
  // enabled immutable capture may proceed only through a seam that can deliver
  // its exact block as provider-owned system guidance (or Claude's append-only
  // system-prompt file). The legacy visible Codex CLI, shell/manual terminals,
  // and unknown persisted runtimes have no secure equivalent, so fail closed
  // before log creation, trust preparation, running state, PTY, or provider.
  const isAutomationRun = run.executionMode === "direct" && Boolean(run.automationId);
  const untrustedPullRequest =
    runProjectPolicyMode(run) === "untrusted-pull-request";
  const usePiWorkerHarness =
    (untrustedPullRequest ||
      process.env.SPARK_E2E_LEGACY_WORKER_HARNESS !== "1") &&
    (task.runtimePreference === "claude" || task.runtimePreference === "codex");
  const constitutionLaunchSurface = workerConstitutionLaunchSurface({
    runtimePreference: task.runtimePreference,
    isAutomationRun,
    usePiWorkerHarness,
  });
  const unsupportedConstitutionReason =
    unsupportedEnabledWorkerConstitutionReason(
      attempt.userConstitution,
      constitutionLaunchSurface,
    );
  if (unsupportedConstitutionReason) {
    return rejectWorkerAttemptLaunchForUnsupportedConstitution(
      run.id,
      attempt.id,
      unsupportedConstitutionReason,
    );
  }

  const nativeCodexFastMode =
    !usePiWorkerHarness && task.runtimePreference === "codex"
      ? await loadSettings().then(
          (settings) => settings.openAiFastMode === true,
          () => false,
        )
      : false;

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
  if (
    task.runtimePreference === "codex" &&
    process.env.SPARK_E2E_LEGACY_WORKER_HARNESS === "1" &&
    runProjectPolicyMode(run) === "trusted"
  ) {
    const nativeCodexExecution = await resolveFrozenNativeCodexProfile(
      attempt.nativeCodexProfileId,
    );
    await ensureCodexProjectTrust(
      attempt.cwd,
      nativeCodexExecution.env.CODEX_HOME,
    ).catch(() => undefined);
  }
  // A direct run bound to an automationId is the automation (loom) worker
  // path: it launches on a pinned/handoff model the automation engine already
  // validated, so the launcher passes its hint verbatim instead of running the
  // Cora-worker roster coercion. Automation workers run on the SAME Pi harness
  // as ordinary Cora workers (the legacy structured transports below survive
  // only behind the SPARK_E2E_LEGACY_WORKER_HARNESS escape hatch).
  const piWorkerModel = usePiWorkerHarness
    ? piModelForWorker(task, isAutomationRun)
    : undefined;
  // Dirs a sandboxed codex worker must be able to WRITE despite them living
  // outside the workspace: the attempt dir (holds final-report.json + logs) and,
  // for a chat participant, the shared board. buildLaunchCommandLine --add-dir's
  // them only on codex sandbox launches (claude + --yolo already reach them).
  const extraWritableDirs = [
    paths.attemptDir,
    ...(task.collabMailDirHint ? [task.collabMailDirHint] : []),
  ];
  // The legacy visible Claude CLI accepts an append-only system prompt file.
  // Derive its path now for the display command, but do not create it until
  // the launch driver has completed every PTY prerequisite and resolved this
  // exact attempt capture. Pi owns a separate process-scoped file below.
  const cliWorkerConstitutionPrompt =
    task.runtimePreference === "claude" &&
    attempt.userConstitution?.enabledAtCapture
      ? {
          directory: join(paths.attemptDir, ".system"),
          fileStem: "global-user-constitution",
        }
      : undefined;
  const cliWorkerConstitutionPromptPath = cliWorkerConstitutionPrompt
    ? privateWorkerConstitutionPromptPath(cliWorkerConstitutionPrompt)
    : undefined;
  const launchCommand = buildLaunchCommandLine(task, attempt.cwd, {
    sandboxDir: attempt.sandboxWorktreePath,
    isAutomation: isAutomationRun,
    extraWritableDirs,
    workerConstitutionPromptPath: cliWorkerConstitutionPromptPath,
    openAiFastMode: nativeCodexFastMode,
  });
  const command = usePiWorkerHarness
    ? `Pi harness (${task.runtimePreference}/${piWorkerModel || "subscription default"}, ${task.effortHint ?? "high"})`
    : isAutomationRun && task.runtimePreference === "claude"
    ? "Claude Agent SDK (legacy e2e automation worker)"
    : isAutomationRun && task.runtimePreference === "codex"
      ? "Codex App Server (legacy e2e automation worker)"
      : launchCommand
        ? `pwsh -> ${launchCommand}`
        : "pwsh (manual)";
  const launchTimestamp = new Date().toISOString();
  attempt.status = "launching";
  attempt.startedAt = launchTimestamp;
  attempt.finishedAt = undefined;
  attempt.exitCode = undefined;
  attempt.error = undefined;
  attempt.failureKind = undefined;
  attempt.command = command;
  attempt.model = piWorkerModel ?? sanitizeWorkerModelHint(task.modelHint?.trim() || undefined);
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
      // This event is what materializes the renderer's worker pane (App.tsx),
      // so it carries the same loom stamp envelope_prepared does: a direct/loom
      // attempt must be recognizable synchronously from the payload, with no
      // getRun round-trip, or the Automations Hub's worker would briefly claim
      // a chat terminal tab.
      automationId: run.automationId,
      executionMode: run.executionMode,
    },
  });
  await updatePeerCommsRegistry(run, launchStep, task, attempt.id, paths, "launching").catch(() => undefined);

  // Pre-worker snapshot: for impl/corrective workers (anything that mutates the
  // workspace — skip verifier/manual), capture a checkpoint of the tree BEFORE
  // the worker runs. A later verifier verdict that regresses a previously-green
  // claim can then auto-restore the workspace to this exact pre-mutation state.
  // Best-effort: a failed snapshot or non-git workspace yields sha=null and just
  // disables restore for this attempt; it must never block the launch.
  if (
    taskWritesWorkspace(task) &&
    runProjectPolicyMode(run) === "trusted"
  ) {
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

  // Mailbox-traffic observability rides the batch lifecycle: the first worker
  // with a mailbox to launch opens the run's watcher, the last one to finish
  // closes it. Gated on provisioning rather than group membership so
  // manager↔worker steering stays visible in the event log even in a batch
  // where nobody was flagged for the group chat. Best-effort — traffic events
  // must never block a run. Release is paired strictly with a successful
  // acquire so a failed acquire can never decrement a sibling's refcount.
  const watchPeerComms = shouldProvisionWorkerMailbox(run, launchStep, task);
  const peerCommsAcquired = watchPeerComms
    ? await acquirePeerCommsWatcher(run).catch(() => false)
    : false;
  let result: {
    exitCode: number;
    error?: string;
    costUsd?: number;
    piSessionId?: string;
    contextTokens?: number;
    contextWindowTokens?: number;
  };
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
          userConstitution: attempt.userConstitution,
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
          nativeCodexProfileId: attempt.nativeCodexProfileId,
          nativeClaudeProfileId: attempt.nativeClaudeProfileId,
          sandboxed: Boolean(attempt.sandboxWorktreePath),
          extraWritableDirs,
          openAiFastMode: nativeCodexFastMode,
          userConstitution: attempt.userConstitution,
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
          userConstitution: attempt.userConstitution,
          workerConstitutionPromptFile: cliWorkerConstitutionPrompt,
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
  // A worker the user's Stop killed did not fail — it was interrupted. Record it
  // that way whichever side of the pause commit this exit lands on, so Resume
  // and the report surfaces don't carry a phantom failure for a process the
  // user stopped on purpose.
  const pauseInterrupted = workerExitInterruptedByForcePause({
    runId: run.id,
    exitCode: result.exitCode,
    attemptStatus: finishedAttempt.status,
  });
  finishedAttempt.status =
    result.exitCode === 0 ? "succeeded" : pauseInterrupted ? "cancelled" : "failed";
  finishedAttempt.finishedAt = finishedAt;
  finishedAttempt.exitCode = result.exitCode;
  finishedAttempt.error = result.error;
  // Measured spend, when the session transport reported one. Recorded even on
  // failures — the tokens were spent — and folded into the run's
  // measuredWorkerCostUsd by the cost rollup, which then skips this attempt
  // in the placeholder estimate.
  if (typeof result.costUsd === "number" && Number.isFinite(result.costUsd) && result.costUsd > 0) {
    finishedAttempt.costUsd = roundCost(result.costUsd);
  }
  // Runtime session identity + final context occupancy (Pi sessions only).
  // Recorded even on failures so a later follow_up_of gate can explain itself
  // from real numbers; the gate independently requires a SUCCEEDED attempt.
  if (result.piSessionId) finishedAttempt.piSessionId = result.piSessionId;
  if (typeof result.contextTokens === "number" && result.contextTokens > 0) {
    finishedAttempt.contextTokens = result.contextTokens;
  }
  if (typeof result.contextWindowTokens === "number" && result.contextWindowTokens > 0) {
    finishedAttempt.contextWindowTokens = result.contextWindowTokens;
  }
  // Classify the failure at the one point every worker session funnels through,
  // so the retry path can branch on a kind instead of re-reading error prose.
  finishedAttempt.failureKind =
    result.exitCode === 0 || pauseInterrupted ? undefined : classifyWorkerFailure(result.error);
  finishedAttempt.command = command;
  finishedAttempt.stdoutLogPath = paths.stdoutLog;
  finishedAttempt.stderrLogPath = paths.stderrLog;
  finishedAttempt.rawLogPath = paths.rawLog;
  finishedAttempt.finalReportPath = paths.finalReportJson;
  finishedTask.status =
    result.exitCode === 0 ? "needs_review" : pauseInterrupted ? "cancelled" : "failed";
  finishedTask.updatedAt = finishedAt;
  const finishedStep = finishedTask.stepId ? run.steps.find((item) => item.id === finishedTask.stepId) : undefined;
  // A pause-interrupted worker says nothing about its step: the force pause owns
  // the run's state (and cancels the task itself), so failing the step here
  // would make Resume look at a failure that never happened.
  if (
    finishedStep &&
    !pauseInterrupted &&
    !["complete", "completed_unverified", "skipped"].includes(finishedStep.status)
  ) {
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
    message: pauseInterrupted
      ? `Worker attempt interrupted by a force pause (exit code ${result.exitCode})`
      : `Worker attempt finished with exit code ${result.exitCode}`,
    payload: {
      exitCode: result.exitCode,
      error: result.error,
      paths,
      ...(pauseInterrupted ? { interruptedByForcePause: true } : {}),
    },
  });
  await updatePeerCommsRegistry(run, finishedStep, finishedTask, finishedAttempt.id, paths, finishedAttempt.status)
    .catch(() => undefined);

  // Nothing downstream may run for an interrupted attempt: the report review
  // queues launch fallbacks and verifier retries, and relaunching a worker into
  // a run the user just stopped is exactly what the pause was for.
  if (pauseInterrupted) return run;

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
  const sandboxBlockers = unreconciledSandboxAttempts(run);
  if (sandboxBlockers.length > 0) {
    const labels = sandboxBlockers
      .slice(0, 3)
      .map((attempt) => attempt.sandboxBranch ?? attempt.id)
      .join(", ");
    const suffix = sandboxBlockers.length > 3 ? ` and ${sandboxBlockers.length - 3} more` : "";
    throw new Error(
      `This run still owns ${sandboxBlockers.length} sandbox worktree${
        sandboxBlockers.length === 1 ? "" : "s"
      } whose changes were not confirmed merged back (${labels}${suffix}). ` +
        "Open or recover those worktrees before deleting the run.",
    );
  }
  // Close the terminal-create race at the first destructive point. Provider
  // disposal below can await several runtimes; a stale MCP child must not mint
  // a new run-owned pane during that window and land after the cleanup
  // snapshot. The unreconciled-worktree refusal above deliberately remains
  // first and leaves the run fully usable.
  fenceAgentTerminalRunDeleting(run.id);
  // The safety guard above must remain first: refusing deletion for an
  // unreconciled sandbox is non-destructive and must not tear down a chat the
  // user can still use to recover it. Once deletion is authorized, stop every
  // provider runtime before removing its durable artifacts. Retention uses this
  // same entry point, so old terminal runs cannot leave invisible manager
  // processes behind. The helper attempts every backend even if one rejects.
  await disposeManagerSessions(run.id);
  const timestamp = new Date().toISOString();
  for (const worker of activeWorkersForRun(run.id)) {
    worker.kill();
    pty.killImmediate(worker.attemptId);
    activeWorkerProcesses.delete(worker.attemptId);
  }
  // Reconcile every auxiliary terminal minted by this exact run. This includes
  // explicitly retained service panes: they may outlive run completion, but
  // never deletion. The bulk closer stops PTYs before asking the renderer to
  // remove tabs and reports individual failures without aborting the remaining
  // panes, so deletion cannot strand CPU-consuming child processes.
  const terminalCleanup = await deleteAgentTerminalRun(run.id);
  if (terminalCleanup.failures.length > 0) {
    console.warn(
      `[run-store] ${terminalCleanup.failures.length} run-owned terminal tab(s) ` +
        `could not be removed while deleting ${run.id}; their PTYs were stopped`,
    );
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
      agentTerminalsClosed: terminalCleanup.closed.length,
      agentTerminalCleanupFailures: terminalCleanup.failures.length,
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
  for (const listener of runDeletedListeners) {
    try {
      await listener({ workspaceId: run.workspaceId, runId: run.id });
    } catch (error) {
      console.warn(
        `[run-store] run deletion listener failed for ${run.id}:`,
        error,
      );
    }
  }
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

// ---------------------------------------------------------------------------
// Automatic conversation compaction.
//
// When a completed manager turn reports context occupancy at or above the
// ratio below, the conversation is compacted: the OUTGOING provider session
// (which still holds the full dialogue) is asked for a dense summary, then one
// atomic commit appends that summary as a marked spark note, bumps the
// conversation epoch, and drops the provider session ids — the same fresh-
// session barrier the rewind machinery uses. The next manager turn spawns a
// new session whose canonical replay is the stored summary instead of the raw
// last-N-messages window (see buildManagerTurnInput / compactionReplaySummary).

/**
 * Fraction of the model's context window at which a completed manager turn
 * triggers automatic compaction. 0.8 leaves headroom for the summarize turn
 * itself while cutting over before long-context quality degradation.
 * Hardcoded in v1 — no settings UI.
 */
const AUTO_COMPACTION_CONTEXT_RATIO = 0.8;

/** Header of the compaction note; stripped again when the summary is replayed
 * into the next epoch's first turn. */
const AUTO_COMPACTION_NOTE_PREFIX =
  "**Conversation compacted.** Older history was summarized to stay within the model's context window:\n\n";

const AUTO_COMPACTION_SUMMARY_PROMPT = [
  "Summarize this entire conversation so a fresh session can continue seamlessly:",
  "capture the user's goals, all decisions and constraints, the current state of the",
  "work (files, branches, outstanding tasks), and unresolved questions. Be dense and",
  "complete; this summary replaces the conversation history for the next session.",
  "Reply with the summary text only — do not call any tools and do not start new work.",
].join(" ");

/** A compaction summary shorter than this is a refusal, an error string, or a
 * throwaway reply — not a usable replacement for the conversation history.
 * Reject it and leave the conversation untouched. */
const MIN_AUTO_COMPACTION_SUMMARY_CHARS = 200;

/** Runs currently summarizing/cutting over. Both the trigger and
 * performAutoCompaction itself bail on re-entry. */
const runsMidAutoCompaction = new Set<string>();

/**
 * True while performAutoCompaction owns this run's manager session (from
 * before the summarize SparkCall is recorded until the cutover commit — or its
 * clean abort — has settled). Exported for agent-socket, which rejects
 * run-mutating orchestrator.* RPCs during the window so a summarize turn that
 * ignores its "do not call tools" instruction cannot spawn workers, complete
 * the run, or post questions mid-compaction.
 */
export function isRunMidAutoCompaction(runId: string): boolean {
  return runsMidAutoCompaction.has(runId);
}

/**
 * The stored compaction summary a fresh session's first turn should replay,
 * or null when this epoch was not seeded by compaction. Guarded on the epoch:
 * a later rewind moves the run past the compaction generation, and its replay
 * must fall back to the retained message window (which contains the summary
 * note itself as ordinary dialogue).
 */
function compactionReplaySummary(run: RunState): string | null {
  if (!run.compactionSummaryMessageId) return null;
  if (run.compactionEpoch !== conversationEpoch(run)) return null;
  const note = run.humanMessages.find(
    (message) => message.id === run.compactionSummaryMessageId,
  );
  if (!note) return null;
  const text = note.message.startsWith(AUTO_COMPACTION_NOTE_PREFIX)
    ? note.message.slice(AUTO_COMPACTION_NOTE_PREFIX.length)
    : note.message;
  return text.trim() || null;
}

/**
 * Post-turn compaction trigger. Called (and awaited) at the tail of a
 * SUCCESSFUL askManagerBackend turn, which keeps the whole compaction inside
 * the same activeAutopilotPlans / activeAutopilotReviews cycle that ran the
 * turn — every scheduler that starts the next manager turn chains behind those
 * maps, so a queued user message cannot open a new turn until the compaction
 * commit (or its clean abort) has landed. Entry points outside the maps
 * (resumeRun's direct chat call) are covered by the atomic guards inside
 * performAutoCompaction's final commit instead.
 */
async function maybeAutoCompactConversation(
  runId: string,
  callId: string,
  cwd: string,
): Promise<void> {
  try {
    const run = await getRun(runId);
    if (!run) return;
    const call = run.sparkCalls.find((entry) => entry.id === callId);
    // Never compact off the summarize call itself.
    if (!call || call.purpose === "compaction") return;
    if (!isManagerTurnCurrent(run, callId, call.conversationEpoch ?? 0)) return;
    const contextTokens = typeof call.promptTokens === "number" ? call.promptTokens : 0;
    if (contextTokens <= 0) return;
    // Capacity MUST mirror the composer's ContextPill budget (ChatComposer.tsx
    // feeds the same chatContextCapacityTokens helper): Claude chats are
    // normalized to 1M context by effectiveChatOneMillionContext, and pricing
    // the trigger off the 200k per-model default while the meter shows a 1M
    // budget would compact a Claude conversation at 16% of displayed budget.
    // For a Pi chat the ceiling is the compaction cap, not the raw window, so
    // this summary pass runs before the Pi extension's own compaction.
    const chatBackend = run.chatBackend ?? "pi";
    const windowTokens = chatContextCapacityTokens({
      contextWindowTokens:
        typeof call.contextWindowTokens === "number" && call.contextWindowTokens > 0
          ? call.contextWindowTokens
          : effectiveChatOneMillionContext(chatBackend) && chatBackend === "claude"
            ? 1_000_000
            : contextWindowForModel(call.model).tokens,
      backend: chatBackend,
      // Same env override the Pi session was stamped with and the composer
      // meter reads back off the usage stream (pi-turn emits it as
      // compactAtTokens). Resolving it here too is what keeps this trigger and
      // the ContextPill measuring the same ceiling: without it, an override
      // below ~204.8k would silently disable this summary pass, and one above
      // 256k would fire it at 204.8k while the meter advertised more.
      compactAtTokens: resolveCompactAtTokens(process.env.CODARA_PI_COMPACT_AT_TOKENS),
    });
    if (contextTokens / windowTokens < AUTO_COMPACTION_CONTEXT_RATIO) return;
    if (runsMidAutoCompaction.has(runId)) return;
    if (run.executionMode === "direct") return;
    if (
      run.status === "paused" ||
      run.status === "blocked" ||
      run.status === "cancelled" ||
      run.status === "failed"
    ) {
      return;
    }
    if (run.pendingConversationRewind || activeConversationRewinds.has(runId)) return;
    if (run.pendingManagerResume) return;
    if (activeManagerCall(run)) return;
    // A queued message or unfinished worker wave means another manager turn is
    // owed imminently; let it run on the current session and re-check after it.
    if (queuedManagerInputMessages(run).length > 0) return;
    if (activeWorkersForRun(runId).length > 0) return;
    const pendingTaskStatuses = new Set([
      "created",
      "queued",
      "claimed",
      "running",
      "needs_review",
      "retry_queued",
    ]);
    if (run.workerTasks.some((task) => pendingTaskStatuses.has(task.status))) return;
    // Frontier resends the full user-contract document each turn, so a fresh
    // session loses nothing and a summary would shadow the contract.
    if (effectiveRunExecutionPolicy(run) === "frontier") {
      console.warn(
        `[run-store] auto-compaction skipped for run ${runId}: pi-frontier policy resends its user contract each turn`,
      );
      return;
    }
    await performAutoCompaction(runId, cwd);
  } catch (err) {
    console.warn("[run-store] auto-compaction failed:", err);
  }
}

/** Settle a compaction summarize call that did not end in a cutover. */
async function settleAutoCompactionCall(
  runId: string,
  callId: string,
  epoch: number,
  error: string,
): Promise<void> {
  const run = await getRun(runId);
  if (!run) return;
  await commitRunChange(run, {
    type: "run.conversation_compaction_skipped",
    message: `Conversation compaction did not complete: ${error}`,
    sparkCallId: callId,
    payload: { sparkCallId: callId, conversationEpoch: epoch, error },
    mutate: (draft, timestamp) => {
      const call = draft.sparkCalls.find((entry) => entry.id === callId);
      if (!call || call.status !== "started" || call.completedAt) return false;
      call.status = "failed";
      call.error = error;
      call.completedAt = timestamp;
      draft.updatedAt = timestamp;
    },
  });
}

/**
 * Summarize the conversation with the outgoing session, then cut over to a
 * fresh epoch in one atomic commit. Any failure or race aborts cleanly: the
 * conversation, session ids and queued input are left exactly as they were,
 * and the summarize call is settled as failed for the audit trail.
 */
async function performAutoCompaction(runId: string, cwd: string): Promise<void> {
  if (runsMidAutoCompaction.has(runId)) return;
  runsMidAutoCompaction.add(runId);
  try {
    let run = await requireRun(runId);
    const epoch = conversationEpoch(run);
    const settings = await loadSettings();
    const chatConfig = await freezeManagerExecutionAccount(
      resolveChatBackendConfig(run),
    );
    if (
      runProjectPolicyMode(run) === "untrusted-pull-request" &&
      chatConfig.backend !== "pi"
    ) {
      console.warn(
        `[run-store] auto-compaction skipped for untrusted PR run ${runId}: native manager policy isolation unavailable`,
      );
      return;
    }
    // No provider session means there is no held context to summarize — the
    // backend would spawn a FRESH session and "summarize" nothing. Skip;
    // nothing durable has been recorded yet.
    if (!chatConfig.sessionUuid) {
      console.warn(
        `[run-store] auto-compaction skipped for run ${runId}: no provider session to summarize`,
      );
      return;
    }
    const backend = getBackend(chatConfig.backend);
    const callId = makeId("spark");
    const callUserConstitution = copyRunUserConstitutionCapture(run);
    const summarizeCall: SparkCall = {
      id: callId,
      runId: run.id,
      ...(callUserConstitution ? { userConstitution: callUserConstitution } : {}),
      stepId: run.currentStepId,
      mode: "chat",
      purpose: "compaction",
      model: chatConfig.model,
      accountProfileId: chatConfig.accountProfileId,
      nativeCodexProfileId: chatConfig.nativeCodexProfileId,
      nativeClaudeProfileId: chatConfig.nativeClaudeProfileId,
      status: "started",
      inputMessageIds: [],
      conversationEpoch: epoch,
      createdAt: new Date().toISOString(),
    };
    // Unlike prepareManagerTurn, this deliberately selects NO queued user
    // messages: the summarize turn is maintenance, not conversation, and input
    // arriving while it runs must stay queued for the next real turn.
    const prepared = await commitRunChange(run, {
      type: "spark_call.started",
      message: `Cora compaction summary call started: ${summarizeCall.model}`,
      sparkCallId: callId,
      payload: {
        mode: "chat",
        purpose: "compaction",
        model: summarizeCall.model,
        conversationEpoch: epoch,
      },
      mutate: (draft, timestamp) => {
        if (conversationEpoch(draft) !== epoch) return false;
        if (activeManagerCall(draft)) return false;
        if (
          draft.status === "paused" ||
          draft.status === "blocked" ||
          draft.status === "cancelled" ||
          draft.status === "failed"
        ) {
          return false;
        }
        summarizeCall.createdAt = timestamp;
        draft.sparkCalls.push(summarizeCall);
        draft.updatedAt = timestamp;
      },
    });
    if (!prepared.sparkCalls.some((entry) => entry.id === callId)) return;
    run = prepared;

    const startedMs = Date.now();
    let result: Awaited<ReturnType<typeof backend.requestManagerDecision>>;
    try {
      const managerConstitutionBlock =
        await resolveCapturedManagerConstitutionBlock(run);
      result = await backend.requestManagerDecision({
        run: structuredClone(run),
        cwd,
        mode: "chat",
        settings,
        managerConstitutionBlock,
        chat: { ...chatConfig },
        prompt: AUTO_COMPACTION_SUMMARY_PROMPT,
        inputMessageIds: [],
        conversationEpoch: epoch,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await settleAutoCompactionCall(
        runId,
        callId,
        epoch,
        `Compaction summary call failed: ${error}`,
      );
      return;
    }
    const durationMs = result.durationMs ?? Date.now() - startedMs;
    const summary =
      !result.turnFailed && !result.turnAborted
        ? result.decision.chatReply?.trim()
        : undefined;
    if (!summary || summary.length < MIN_AUTO_COMPACTION_SUMMARY_CHARS) {
      const reason = result.turnAborted
        ? "Compaction summary turn was interrupted."
        : !summary
          ? result.notice ?? "Compaction summary turn produced no summary text."
          : `Compaction summary too short to replace the conversation (${summary.length} chars).`;
      console.warn(`[run-store] auto-compaction aborted for run ${runId}: ${reason}`);
      await settleAutoCompactionCall(runId, callId, epoch, reason);
      return;
    }

    const noteId = makeId("msg");
    let compacted = false;
    await commitRunChange(await requireRun(runId), {
      type: "run.conversation_compacted",
      message: "Conversation compacted: history summarized, cutting over to a fresh session",
      sparkCallId: callId,
      payload: {
        sparkCallId: callId,
        oldEpoch: epoch,
        newEpoch: epoch + 1,
        summaryMessageId: noteId,
      },
      mutate: (draft, timestamp) => {
        const call = draft.sparkCalls.find((entry) => entry.id === callId);
        if (!call || call.status !== "started" || call.completedAt) return false;
        if (conversationEpoch(draft) !== epoch) return false;
        if (draft.pendingConversationRewind) return false;
        if (
          draft.status === "paused" ||
          draft.status === "blocked" ||
          draft.status === "cancelled" ||
          draft.status === "failed"
        ) {
          return false;
        }
        // A real turn raced the summarize; its session/input ownership wins.
        if (
          draft.sparkCalls.some(
            (entry) => entry.id !== callId && entry.status === "started" && !entry.completedAt,
          )
        ) {
          return false;
        }
        // Undelivered input queued while summarizing belongs to the old epoch;
        // cutting over would strand it, so abort and let its turn run first —
        // the ratio is still high after that turn, so compaction re-triggers.
        if (queuedManagerInputMessages(draft).length > 0) return false;
        call.status = "completed";
        call.completedAt = timestamp;
        call.durationMs = durationMs;
        if (result.model) call.model = result.model;
        call.accountProfileId = preserveFrozenPiAccountProfileId(
          call.accountProfileId,
          result.accountProfileId,
        );
        if (typeof result.costUsd === "number") call.costUsd = result.costUsd;
        if (typeof result.inputTokens === "number") call.inputTokens = result.inputTokens;
        if (typeof result.outputTokens === "number") call.outputTokens = result.outputTokens;
        if (typeof result.cacheReadTokens === "number") call.cacheReadTokens = result.cacheReadTokens;
        if (typeof result.promptTokens === "number") call.promptTokens = result.promptTokens;
        if (typeof result.contextWindowTokens === "number" && result.contextWindowTokens > 0) {
          call.contextWindowTokens = result.contextWindowTokens;
          call.contextWindowSource = "known";
        }
        draft.humanMessages.push({
          id: noteId,
          runId: draft.id,
          author: "spark",
          kind: "note",
          compaction: true,
          message: `${AUTO_COMPACTION_NOTE_PREFIX}${summary}`,
          intent: "answer",
          deliveryState: "acknowledged",
          targetTurnId: callId,
          backendTurnId: callId,
          conversationEpoch: epoch + 1,
          createdAt: timestamp,
        });
        draft.conversationEpoch = epoch + 1;
        delete draft.chatSessionUuid;
        delete draft.chatSessionMode;
        draft.compactionSummaryMessageId = noteId;
        draft.compactionEpoch = epoch + 1;
        recomputeRunCostRollups(draft);
        draft.updatedAt = timestamp;
        compacted = true;
      },
    });
    if (!compacted) {
      await settleAutoCompactionCall(
        runId,
        callId,
        epoch,
        "Compaction abandoned: a newer turn arrived before the cutover could apply.",
      );
      return;
    }
    // The epoch barrier is durable, so stale provider callbacks are already
    // blocked; disposing the outgoing sessions is best-effort cleanup, same as
    // the rewind path.
    await disposeManagerSessions(runId);
  } finally {
    runsMidAutoCompaction.delete(runId);
  }
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
      delete draft.managerTurnRecovery;
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
  for (const key of [...activeManagerTurnRecoveries.keys()]) {
    if (key.startsWith(`${original.id}:`)) activeManagerTurnRecoveries.delete(key);
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
      delete draft.managerTurnRecovery;
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

// Runs whose force-pause is inside its kill+commit window. A worker killed by
// the pause reports its exit through launchWorkerAttempt's finish path, which
// lands on its own (unqueued) write and races the pause commit either way
// round. Both orderings must record the same thing — see
// workerExitInterruptedByForcePause. Counted, not a flag: two overlapping Stops
// on the same run (double click, Stop + stopAndUndoPending) must not have the
// first one to finish close the window under the second.
const forcePausingRuns = new Map<string, number>();

function openForcePauseWindow(runId: string): void {
  forcePausingRuns.set(runId, (forcePausingRuns.get(runId) ?? 0) + 1);
}

function closeForcePauseWindow(runId: string): void {
  const depth = (forcePausingRuns.get(runId) ?? 0) - 1;
  if (depth > 0) forcePausingRuns.set(runId, depth);
  else forcePausingRuns.delete(runId);
}

/**
 * Did this worker exit belong to a force pause rather than to the work?
 *
 * The kill/exit race has two orderings and both used to end in a phantom
 * failure: run run-msojtvqk-qjklvo recorded attempt attempt-msok8193 as
 * failed/exit 1 "Pi worker runtime stopped." while the user's Stop was in
 * flight, so Resume and the report surfaces showed a step that "failed" when in
 * truth it was interrupted. `forcePausingRuns` covers the exit landing first,
 * the persisted `cancelled` status covers the pause commit landing first.
 * Everything outside that window is a genuine failure and stays `failed`.
 *
 * Exported for scripts/test-force-pause-resume.cjs.
 */
export function workerExitInterruptedByForcePause(input: {
  runId: string;
  exitCode: number;
  attemptStatus: WorkerAttempt["status"];
}): boolean {
  if (input.exitCode === 0) return false;
  return (forcePausingRuns.get(input.runId) ?? 0) > 0 || input.attemptStatus === "cancelled";
}

// Force-pause: hard-kill every active worker for the run, stop all autopilot
// cycles, transition active attempts/tasks to cancelled, set status=paused.
// This is the "pause everything NOW" button — the graceful pauseRun path
// only sends ESC and waits for workers to wind down on their own, which on
// Windows leaves ConPTY descendants alive long enough that a follow-up
// deleteRun trips the OS file-in-use prompt. Use this before deleting.
export async function forcePauseRun(runId: string): Promise<RunState> {
  const run = await requireRun(runId);
  // Opened BEFORE the first teardown step and closed only once the pause commit
  // is durable: every worker exit inside this window is the pause's doing.
  openForcePauseWindow(run.id);
  try {
    return await forcePauseRunInner(run);
  } finally {
    closeForcePauseWindow(run.id);
  }
}

async function forcePauseRunInner(run: RunState): Promise<RunState> {
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
  //
  // Synthetic notes are authored "user" for delivery only (board nudge,
  // pause-resume note). Rewinding past them is right — they are undelivered
  // manager input like anything else here — but restoring them into the
  // composer would hand the user a wall of attempt ids or tool names to
  // re-send as if they had typed it.
  const restoredMessages = run.humanMessages
    .slice(rollbackIndex)
    .filter((message) => message.author === "user" && !message.boardNote && !message.resumeNote)
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
  // MCP-managed runs settle their synthetic worker_batch steps here and
  // nowhere else: codara_complete only moves the RUN status, so holding one in
  // `reviewing` would strand it in the graph forever. They were never affected
  // by this rule (they carried no classification at all until the orchestrator
  // gained a taskComplexity argument), so keep them out of it.
  if (runHasMcpManager(run)) return true;
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
// same step. The failure taxonomy picks WHICH runtime that replacement gets:
// a transient transport/provider failure earns one fast retry on the same
// runtime first (the runtime is not what broke), while auth and launch
// failures go straight to the opposite runtime exactly as before. Returns the
// updated run when a replacement was queued (so the caller can short-circuit
// the normal review path), or null when no retry applies.
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
    .find((kind) => availableRuntimes.some((runtime) => runtime.kind === kind && runtimeAssignable(runtime))) ?? null;
  // Only fall back once per (step, title) lineage. If a sibling with the
  // opposite runtime already exists (failed, cancelled, or pending), both
  // runtimes have been tried — let the manager handle it.
  const lineage = run.workerTasks.filter((t) => t.stepId === task.stepId && t.title === task.title);
  const triedRuntimes = new Set(lineage.map((t) => t.runtimePreference));
  const oppositeAvailable = opposite !== null && !triedRuntimes.has(opposite);
  // Classify from the attempt's own error first (the raw runtime message) and
  // only then from the synthetic report text, which wraps every reason in the
  // same boilerplate. The plan is what decides same-runtime vs cross-runtime.
  const failureKind =
    attempt.failureKind ?? classifyWorkerFailure(attempt.error) ?? classifyWorkerFailure(failureContext);
  const retryPlan = planWorkerFailureRetry({
    kind: failureKind,
    sameRuntimeAttempts: lineage.filter((t) => t.runtimePreference === task.runtimePreference).length,
    oppositeRuntimeAvailable: oppositeAvailable,
  });
  if (retryPlan.action === "no_auto_retry") return null;
  const retriesSameRuntime = retryPlan.action === "retry_same_runtime";
  const nextRuntime: WorkerRuntime | null = retriesSameRuntime ? task.runtimePreference : opposite;
  if (!nextRuntime) return null;

  const fallbackId = makeId("task");
  return commitRunChange(run, {
    type: "autopilot.cli_launch_fallback",
    message: retriesSameRuntime
      ? `Fast-retrying ${task.runtimePreference} after a transient ${failureKind ?? "runtime"} failure`
      : `Auto-falling back from ${task.runtimePreference} to ${nextRuntime} after CLI/runtime failure`,
    stepId: task.stepId,
    workerTaskId: fallbackId,
    payload: {
      previousTaskId: task.id,
      previousAttemptId: attempt.id,
      previousRuntime: task.runtimePreference,
      nextRuntime,
      failureKind,
      retryAction: retryPlan.action,
      retryReason: retryPlan.reason,
    },
    mutate: (draft, timestamp) => {
      // Cancel the failed task so pickAutopilotTasks re-launches the queued
      // replacement below rather than the task that just failed.
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
        runtimePreference: nextRuntime,
        // A same-runtime fast retry keeps the original model and effort: only
        // a runtime swap needs the hints translated to the other provider.
        modelHint: retriesSameRuntime ? task.modelHint : fallbackModelHintForRuntime(nextRuntime, task.modelHint),
        effortHint: retriesSameRuntime ? task.effortHint : fallbackEffortHintForRuntime(nextRuntime, task.effortHint),
        status: "queued",
        allowedPaths: task.allowedPaths,
        forbiddenPaths: task.forbiddenPaths,
        expectedOutputs: task.expectedOutputs,
        verificationCommands: task.verificationCommands,
        canRunParallel: task.canRunParallel,
        conflictsWith: task.conflictsWith,
        taskClass: task.taskClass,
        // Manager-batch parallel trust survives the runtime swap: the failed
        // task's batch already launched simultaneously, so its replacement
        // must be picked into the same relaunch wave as its sibling fallbacks
        // instead of serializing behind them.
        parallelTrust: task.parallelTrust,
        // The replacement joins the same batch, so it inherits the team marker
        // and the graph keeps showing the peer link across the runtime swap.
        // Both mailbox flags travel with it: peer comms are opt-in per worker
        // now, so a replacement that inherited only the outcome flag would be
        // dropped from the step's group chat the moment prepareWorkerTask
        // re-evaluated the gate, and a replacement that dropped `isolated`
        // would silently rejoin peer traffic its predecessor was kept out of.
        peers: task.peers,
        isolated: task.isolated,
        peerComms: task.peerComms,
        // Loom identity survives the retry: newestAttemptForNode judges a graph
        // node by the newest attempt among tasks stamped with its id, so a
        // fallback without loomNodeId would leave the node forever settled on
        // the failed first attempt. The node-derived fence hints travel with
        // the id: a fenced node's replacement must run under the same fence.
        loomNodeId: task.loomNodeId,
        accessHint: task.accessHint,
        blockedToolsHint: task.blockedToolsHint,
        collabMailDirHint: task.collabMailDirHint,
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
  const ceiling = VERIFICATION_ROUND_CEILING[effectiveRunExecutionPolicy(run)];
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
  // A settled step is history. When the corrective target sits in a step that
  // already finished, reopening it would show running workers under a step the
  // user watched complete (run-msojtvqk-qjklvo: step 1 back to "1 running,
  // attempt 2" beside a running step 3). Instead the rework re-homes: a
  // follow-up copy of the target is minted in the CURRENT step and the attempt
  // lands there, leaving the completed step's tasks, attempts and counters
  // exactly as they were.
  const targetStep = target.stepId
    ? run.steps.find((item) => item.id === target.stepId)
    : undefined;
  const reHomesToCurrentStep = Boolean(targetStep && isTerminalStepStatus(targetStep.status));
  // The attempt cap has to hold across the re-homing, or every round would mint
  // a fresh task with zero attempts and the corrective loop would never end.
  // Only the re-homing branch pays for the lineage walk; the in-place retry
  // keeps counting exactly as it always has.
  const retriesUsed = reHomesToCurrentStep
    ? countFollowUpLineageAttempts(run, target)
    : countWorkerAttempts(run, target.id);
  if (retriesUsed >= MAX_WORKER_ATTEMPTS) return null;
  // "Fast" means at most one corrective rework in code, not just in prose.
  // Count FEEDBACK-driven requeues specifically — countWorkerAttempts also
  // includes non-verification retries (e.g. environmental relaunches). The
  // policy is only honored by the Pi backend (other backends persist but
  // ignore it), so the cap keys off chatBackend to avoid changing CC/Codex
  // behavior via the fast default. A run the manager called complex derives
  // deep and is therefore exempt.
  const feedbackRoundsUsed = target.verifierFeedbackRounds ?? 0;
  if (
    run.chatBackend === "pi" &&
    effectiveRunExecutionPolicy(run) === "fast" &&
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
  // Pre-minted so the ids exist for the event payload; only the re-homing
  // branch actually spends them, and an unused id costs nothing.
  const followUpTaskId = makeId("task");
  const followUpStepId = makeId("step");
  const payload: Record<string, unknown> = {
    targetTaskId: targetId,
    verifierAttemptId: attempt.id,
    correctivePrompt,
    retriesUsed,
  };
  return commitRunChange(run, {
    type: "autopilot.verifier_feedback_retry",
    stepId: target.stepId,
    workerTaskId: targetId,
    message: reHomesToCurrentStep
      ? `Re-homing ${target.title} to the current step with verifier corrective feedback (attempt ${retriesUsed + 1}/${MAX_WORKER_ATTEMPTS})`
      : `Re-queuing ${target.title} with verifier corrective feedback (attempt ${retriesUsed + 1}/${MAX_WORKER_ATTEMPTS})`,
    payload,
    mutate: (draft, timestamp) => {
      const targetTask = draft.workerTasks.find((t) => t.id === targetId);
      if (!targetTask) return false;
      // The rework brief. It lands on whichever task is about to run it - the
      // target itself in place, or its follow-up copy in the current step.
      // De-dupe: don't stack an identical feedback block across repeated
      // retries. Guard on both the header and the corrective text already being
      // present in the description.
      const withFeedback = (description: string): string =>
        description.includes(VERIFIER_FEEDBACK_HEADER) && description.includes(correctivePrompt)
          ? description
          : `${description.replace(/\s+$/, "")}\n\n${feedbackBlock}`;
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
      // It also has to run BEFORE the re-homing below picks a destination, so a
      // verifier-only step that just settled is never mistaken for the current
      // step.
      reconcileAcceptedVerifierOnlySteps(draft, timestamp);
      // Settled step? Then it is history: run the rework as a follow-up copy of
      // the target in the CURRENT step (a fresh one when every step settled)
      // and leave the completed step's tasks, attempts and counters untouched.
      // Returns null when the target's step is still live, which is the signal
      // to retry in place exactly as before.
      const rehomed = rehomeSettledStepFeedbackRetry(draft, {
        targetTaskId: targetTask.id,
        description: withFeedback(targetTask.description),
        followUpTaskId,
        followUpStepId,
        timestamp,
      });
      if (rehomed) {
        payload.reHomedToStepId = rehomed.stepId;
        payload.followUpTaskId = rehomed.taskId;
        payload.reHomedFromStepId = targetTask.stepId;
        payload.createdStepForFollowUp = rehomed.createdStep;
        draft.updatedAt = timestamp;
        return;
      }
      targetTask.description = withFeedback(targetTask.description);
      targetTask.status = "retry_queued";
      targetTask.verifierFeedbackRounds = (targetTask.verifierFeedbackRounds ?? 0) + 1;
      targetTask.updatedAt = timestamp;
      // Re-open the target's step so pickAutopilotTasks will relaunch it. Only
      // a `reviewing` step can need this now; a settled one re-homed above.
      const step = targetTask.stepId
        ? draft.steps.find((s) => s.id === targetTask.stepId)
        : undefined;
      if (step) {
        if (step.status === "reviewing") {
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

function fallbackModelHintForRuntime(
  runtime: WorkerRuntime,
  previousModelHint?: string,
): string | undefined {
  const prior = previousModelHint?.trim().toLowerCase() ?? "";
  if (runtime !== "claude" && runtime !== "codex") return undefined;
  // This used to preserve the manager's intended price/speed tier across
  // providers (a Terra verifier falling back to Sonnet rather than jumping to
  // Opus). The worker roster has a single standard tier per provider, so there
  // are no longer intermediate tiers to preserve, the only distinction that
  // survives a cross-provider fallback is premium vs standard, and premium
  // exists on Anthropic alone.
  return rosterModelFor(runtime, /fable/.test(prior) ? "premium" : "standard");
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
    for (const listener of runSavedListeners) {
      try {
        await listener({ workspaceId: run.workspaceId, runId: run.id });
      } catch (err) {
        console.error("[run-store] run-saved listener failed:", err);
      }
    }
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
  // Validate all present provenance before mutating legacy/default fields.
  // Absence remains absence: a reload must never capture current Settings on
  // behalf of a run, call, or attempt created by an older build.
  normalizeRunUserConstitutionProvenance(run);
  const origin = normalizeGitHubOrigin(run.origin);
  if (origin) run.origin = origin;
  else delete run.origin;
  run.projectPolicyMode = resolveProjectPolicyMode({
    origin,
    projectPolicyMode: run.projectPolicyMode,
  });
  if (run.settingsSnapshot && typeof run.settingsSnapshot === "object") {
    run.settingsSnapshot.projectPolicyMode = run.projectPolicyMode;
  }
  const projectConstitution =
    run.projectPolicyMode === "trusted"
      ? normalizeProjectConstitutionSnapshot(run.projectConstitution)
      : null;
  if (projectConstitution) {
    run.projectConstitution = projectConstitution;
  } else {
    delete run.projectConstitution;
  }
  run.humanMessages ??= [];
  run.sparkCalls ??= [];
  run.conversationEpoch ??= 0;
  // Chats persisted before the OpenRouter manager was removed can still carry
  // chatBackend "openrouter" on disk. Migrate them to Pi (the bundled default)
  // so the value stays inside the ChatBackendKind union. The stored chatModel
  // was an OpenRouter catalog id that no surviving backend understands, so
  // drop it and let resolveChatBackendConfig apply Pi's default model.
  if ((run.chatBackend as string) === "openrouter") {
    run.chatBackend = "pi";
    run.chatModel = undefined;
  }
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
  if (run.board !== undefined) {
    // Same defensive rebuild as the whiteboard: a hand-edited or older-build
    // board degrades card by card instead of losing the run.
    const board = normalizeStoredRunBoard(run.board);
    if (board) run.board = board;
    else delete run.board;
    // Link hygiene: a card whose worker task no longer exists on the run
    // (conversation rewind, hand-edited state) must not keep offering a dead
    // "Open terminal" target. Cleared here so both read and write edges heal.
    if (run.board) {
      const taskIds = new Set((run.workerTasks ?? []).map((task) => task.id));
      for (const card of run.board.cards) {
        if (card.workerTaskId && !taskIds.has(card.workerTaskId)) delete card.workerTaskId;
      }
    }
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
    normalizeManagerApplicationReceipts(call);
  }
  if (run.managerTurnRecovery) {
    const recovery = run.managerTurnRecovery;
    const validMode =
      recovery.managerMode === "plan_analysis" ||
      recovery.managerMode === "chat" ||
      recovery.managerMode === "step_planning" ||
      recovery.managerMode === "worker_prompt_generation" ||
      recovery.managerMode === "worker_result_review" ||
      recovery.managerMode === "retry_planning" ||
      recovery.managerMode === "final_summary" ||
      recovery.managerMode === "test";
    const valid =
      typeof recovery.id === "string" &&
      recovery.id.startsWith("recovery-") &&
      (recovery.state === "parked" || recovery.state === "resuming") &&
      (recovery.failureKind === "rate_limit" ||
        recovery.failureKind === "provider" ||
        recovery.failureKind === "transport") &&
      (recovery.backend === "pi" ||
        recovery.backend === "claude" ||
        recovery.backend === "codex") &&
      validMode &&
      Number.isSafeInteger(recovery.conversationEpoch) &&
      recovery.conversationEpoch >= 0 &&
      recovery.conversationEpoch === conversationEpoch(run) &&
      typeof recovery.failedSparkCallId === "string" &&
      recovery.failedSparkCallId.startsWith("spark-") &&
      Number.isFinite(Date.parse(recovery.parkedAt)) &&
      (recovery.resumeAccountProfileId === undefined ||
        (typeof recovery.resumeAccountProfileId === "string" &&
          recovery.resumeAccountProfileId.length > 0 &&
          recovery.resumeAccountProfileId.length <= 256)) &&
      (recovery.forceCanonicalReplay === undefined ||
        typeof recovery.forceCanonicalReplay === "boolean");
    if (!valid || run.executionMode === "direct" || isTerminalRunStatus(run.status)) {
      delete run.managerTurnRecovery;
    } else if (recovery.state === "resuming") {
      if (
        !recovery.resumeClaimId?.startsWith("recovery-claim-") ||
        !recovery.resumeRequestedAt ||
        !Number.isFinite(Date.parse(recovery.resumeRequestedAt))
      ) {
        recovery.state = "parked";
        delete recovery.resumeClaimId;
        delete recovery.resumeRequestedAt;
      }
    } else {
      delete recovery.resumeClaimId;
      delete recovery.resumeRequestedAt;
    }
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

  // Worker-side cost, split MEASURED vs ESTIMATED per attempt. An attempt
  // whose transport reported real cost or token usage (Agent SDK result,
  // Codex turn usage, Pi message_end usage — stamped as `attempt.costUsd` at
  // session finish) rolls into `measuredWorkerCostUsd` and is excluded from
  // the estimate below, so the two rollups never double-count one attempt.
  // Attempts with no measurement (interactive pty CLIs, legacy runs) keep the
  // old placeholder estimate: the price table times conservative hardcoded
  // token guesses. `estimatedWorkerCostUsd` therefore remains a directional
  // fallback figure, not billed truth.
  const estimatedInputTokens = 12_000;
  const estimatedOutputTokens = 4_000;
  const tasksById = new Map<string, WorkerTask>();
  for (const task of run.workerTasks ?? []) {
    tasksById.set(task.id, task);
  }
  let runWorkerTotal = 0;
  let runMeasuredWorkerTotal = 0;
  let runHasMeasuredWorker = false;
  for (const attempt of run.workerAttempts ?? []) {
    // Measured attempts are done: `costUsd` is only ever stamped alongside
    // `finishedAt`, so no in-flight gating is needed on this branch.
    if (typeof attempt.costUsd === "number" && Number.isFinite(attempt.costUsd)) {
      runMeasuredWorkerTotal += attempt.costUsd;
      runHasMeasuredWorker = true;
      continue;
    }
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
  if (runHasMeasuredWorker) {
    run.measuredWorkerCostUsd = roundCost(runMeasuredWorkerTotal);
  } else {
    delete run.measuredWorkerCostUsd;
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
      nextStatus = latest.status;
      persisted = true;

      // The run file is the lifecycle authority. Fence + schedule cleanup as
      // soon as that terminal status is durable, before the event journal
      // append: a disk error in events.jsonl must not leave a live forgotten
      // watcher behind after run.json already says complete/failed/cancelled.
      if (
        prevStatus !== null &&
        !isTerminalRunStatus(prevStatus) &&
        isTerminalRunStatus(latest.status)
      ) {
        void settleAgentTerminalRun(run.id)
          .then((cleanup) => {
            if (cleanup.failures.length > 0) {
              console.warn(
                `[run-store] ${cleanup.failures.length} temporary terminal tab(s) ` +
                  `could not be removed after ${run.id} settled; their PTYs were stopped and cleanup was queued for retry`,
              );
            }
          })
          .catch((error) => {
            console.warn(`[run-store] failed to reconcile terminals for ${run.id}`, error);
          });
      } else if (
        prevStatus !== null &&
        isTerminalRunStatus(prevStatus) &&
        !isTerminalRunStatus(latest.status)
      ) {
        // Continuing a completed chat opens a new lifecycle epoch. The
        // lifecycle module releases the fence now, or after a pending cleanup
        // retry finishes, so a retry can never close a new epoch's terminal.
        markAgentTerminalRunActive(run.id);
      }

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
    });
  runMutationQueues.set(run.id, next);
  try {
    await next;
  } finally {
    if (runMutationQueues.get(run.id) === next) runMutationQueues.delete(run.id);
  }
  if (persisted && prevStatus !== "complete" && nextStatus === "complete") {
    scheduleRunCompletionTail(run.id, result ?? undefined);
  }
  return result ?? (await requireRun(run.id));
}

// Post-completion bookkeeping, detached from the turn that completed the run.
//
// Nothing in here is needed for anything the user can already see: BOTH
// completion paths post the user-visible bubble strictly before the run flips
// to `complete` (the MCP path in agent-socket's codara_complete handler, the
// structured-decision path in applySparkManagerDecision's chatReply note).
// Awaiting it inline kept the live codara_complete MCP call open, and with it
// the model's whole turn, for two git subprocesses, one report read per worker
// attempt, three extra full run serializations, and the ledger writes.
//
// Chained per run so two completions of the same run cannot interleave their
// writes, and awaited by flushRunCompletionTails for tests and shutdown.
const runCompletionTails = new Map<string, Promise<void>>();

/** The last chat bubble as it stood the instant the run completed. */
type CompletionTimeMessage = Pick<HumanRunMessage, "author" | "kind" | "createdAt">;

function scheduleRunCompletionTail(runId: string, completedRun?: RunState): void {
  // Copied by value now, because getRun hands out the live cached RunState:
  // holding the object itself would let a message the user sends while the tail
  // runs rewrite the suppression decision this completion already earned.
  const last = completedRun?.humanMessages[completedRun.humanMessages.length - 1];
  const lastAtCompletion: CompletionTimeMessage | undefined = last
    ? { author: last.author, kind: last.kind, createdAt: last.createdAt }
    : undefined;
  const previous = runCompletionTails.get(runId) ?? Promise.resolve();
  const tail: Promise<void> = previous
    .catch(() => {
      /* keep later completions moving after an earlier tail failure */
    })
    .then(() => runCompletionTail(runId, lastAtCompletion))
    .finally(() => {
      if (runCompletionTails.get(runId) === tail) runCompletionTails.delete(runId);
    });
  runCompletionTails.set(runId, tail);
  void tail;
}

/**
 * Await the detached completion bookkeeping. Tests that assert on
 * result-manifest.json, the completion-summary message, or the memory/lessons
 * ledgers must call this after the completing mutation; app shutdown calls it
 * so a quit cannot drop a half-written ledger.
 */
export async function flushRunCompletionTails(runId?: string): Promise<void> {
  // Shutdown funnels through here (main/index.ts flushAllStores), so it is also
  // where a quit mid-stream drains any coalesced chat.assistant_block events
  // that have not hit their flush timer yet.
  await flushBufferedEvents(runId);
  const pending = runId
    ? [runCompletionTails.get(runId)].filter(Boolean)
    : [...runCompletionTails.values()];
  await Promise.all(pending.map((tail) => tail!.catch(() => undefined)));
}

async function runCompletionTail(
  runId: string,
  lastAtCompletion?: CompletionTimeMessage,
): Promise<void> {
  try {
    const run = await requireRun(runId);
    const manifest = await collectRunResultManifest(run, workerArtifactPaths);
    await fs.mkdir(run.artifactDir, { recursive: true });
    await writeFileAtomic(
      join(run.artifactDir, "result-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await commitRunChange(run, {
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
    await appendCompletionSummaryMessage(runId, lastAtCompletion);
  } catch (err) {
    console.error("[run-store] failed to append completion summary", err);
  }
  // Distill + persist this freshly-completed run into the per-workspace
  // orchestration memory ledger. Best-effort: recordRunMemory is itself
  // non-throwing, but a stray write failure must never break the completion
  // path, so it stays wrapped. Pass readWorkerReport so run-memory.ts can
  // resolve worker reports without importing run-store (no cycle).
  try {
    const completed = await requireRun(runId);
    // Both distillers walk every finished attempt's final report, and
    // readWorkerReport is an uncached fs.readFile + JSON.parse per call. Share
    // one memo for this completion so a 60-attempt run does 60 reads, not 120.
    // Scoped to this call, so it can never serve a stale report to a later one.
    const reportCache = new Map<string, Promise<WorkerReport | null>>();
    const readReportOnce = (path: string): Promise<WorkerReport | null> => {
      const cached = reportCache.get(path);
      if (cached) return cached;
      const pending = readWorkerReport(path);
      reportCache.set(path, pending);
      return pending;
    };
    await recordRunMemory(completed, readReportOnce);
    // Same seam, same contract: distill this run's operational lessons
    // (search rate limits, runtime fallbacks) into the workspace's Cora
    // memory file as [auto] bullets that later manager turns replay. Also
    // non-throwing.
    await recordRunLessons(completed, readReportOnce);
  } catch (err) {
    console.error("[run-store] failed to record run memory", err);
  }
}

async function appendCompletionSummaryMessage(
  runId: string,
  lastAtCompletion?: CompletionTimeMessage,
): Promise<RunState> {
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
  // user-facing answer; the auto-summary would just duplicate it. Judged
  // against the completion-time copy when one is available, so a user message
  // that lands while the detached tail runs cannot un-suppress it.
  const lastMessage =
    lastAtCompletion ?? run.humanMessages[run.humanMessages.length - 1];
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

/**
 * Attempts spent on one continuous line of work, following `followUpOfTaskId`
 * back through every task that continues an earlier one. A corrective rework
 * whose step already settled is re-homed onto a fresh follow-up task, so per-
 * task counting would restart the attempt budget on every round and the loop
 * would never hit MAX_WORKER_ATTEMPTS. The walk is bounded by a seen-set, so a
 * corrupted run whose links form a cycle terminates instead of hanging.
 */
function countFollowUpLineageAttempts(run: RunState, task: WorkerTask): number {
  const seen = new Set<string>();
  let total = 0;
  let cursor: WorkerTask | undefined = task;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    total += countWorkerAttempts(run, cursor.id);
    const previousId: string | undefined = cursor.followUpOfTaskId;
    cursor = previousId ? run.workerTasks.find((item) => item.id === previousId) : undefined;
  }
  return total;
}

// Pure selector with the downgrade reason exposed. pickAutopilotTasks wraps this
// and discards the reason so its existing call sites keep their WorkerTask[]
// semantics; only the launch site reads `downgrade` to emit an observability
// event. Run-state filtering (statuses, attempt cap, active step) lives here;
// wave selection itself (manager-batch parallel trust, the fan-out
// no-concrete-scope guard, and scope-conflict checks) is delegated to the
// pure autopilot-wave module so it stays testable in isolation.
function pickAutopilotTasksWithReason(run: RunState): {
  tasks: WorkerTask[];
  downgrade: { task: WorkerTask; reason: "no_concrete_scope" | "not_parallel" } | null;
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
  return selectAutopilotWave(candidates, evalMaxParallelWorkers());
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

/** How many earlier attempts' handoffs one worker prompt may inherit. */
const MAX_INHERITED_HANDOFF_ARTIFACTS = 8;

/**
 * Gather the reusable artifacts earlier attempts in this run deliberately left
 * behind, newest first, so the next worker is HANDED them.
 *
 * Deliberately not limited to the supersedes lineage: the case this exists for
 * is a SEQUENCE of tasks in different steps attacking the same job, where a
 * blocked attempt's scratch dry-run is exactly what the next step needs. Before
 * this, that only carried over when a human read the prose summary and pasted
 * the path into the next task description, and a 24-minute dry run got rebuilt
 * from cold when nobody did.
 */
async function collectPriorWorkerHandoffs(
  run: RunState,
  task: WorkerTask,
): Promise<WorkerHandoffArtifact[]> {
  const seenPaths = new Set<string>();
  const collected: WorkerHandoffArtifact[] = [];
  for (const attempt of [...run.workerAttempts].reverse()) {
    if (collected.length >= MAX_INHERITED_HANDOFF_ARTIFACTS) break;
    // Its own lineage's artifacts are the point; its own in-flight attempt has
    // nothing to hand over yet.
    if (attempt.workerTaskId === task.id) continue;
    if (!attempt.finalReportPath) continue;
    const report = await readWorkerReport(attempt.finalReportPath).catch(() => null);
    if (!report?.handoff?.length) continue;
    const sourceTask = run.workerTasks.find((entry) => entry.id === attempt.workerTaskId);
    for (const artifact of report.handoff) {
      if (collected.length >= MAX_INHERITED_HANDOFF_ARTIFACTS) break;
      if (seenPaths.has(artifact.path)) continue;
      seenPaths.add(artifact.path);
      collected.push({
        ...artifact,
        description: sourceTask
          ? `${artifact.description} (left by "${sourceTask.title}", which ended ${report.status})`
          : artifact.description,
      });
    }
  }
  return collected;
}

/** Caps on what a re-verification inherits, so the prompt stays readable. */
const MAX_ESTABLISHED_CLAIMS = 24;
const MAX_OUTSTANDING_CLAIMS = 8;
const MAX_CHANGED_SINCE_FILES = 12;
const MAX_CLAIM_CHARS = 300;

const clampClaim = (text: string): string =>
  text.length > MAX_CLAIM_CHARS ? `${text.slice(0, MAX_CLAIM_CHARS - 1)}…` : text;

/**
 * Hand a re-running verifier the ground the previous one already covered.
 *
 * Only ever consulted for verifier-class tasks. Returns the most recent verifier
 * verdict in the run plus the files any implementation touched after it, so the
 * next round can scope itself to the delta and whatever was left open instead of
 * re-deriving a settled surface from scratch. See PriorVerifierRound for the
 * incident that motivated it.
 *
 * This deliberately does NOT weaken the freshness gate: a passing verdict is
 * still required after the latest files-changing implementation. It only tells
 * the verifier where its turn is worth spending.
 */
async function collectPriorVerifierRound(
  run: RunState,
  task: WorkerTask,
): Promise<PriorVerifierRound | null> {
  if (task.taskClass !== "verifier") return null;
  const attempts = [...(run.workerAttempts ?? [])];
  let latest: { finishedAt: number; verdict: VerifierVerdict } | null = null;
  for (const attempt of attempts) {
    // Its own lineage is the thing under review, not evidence about it.
    if (attempt.workerTaskId === task.id) continue;
    if (!attempt.finalReportPath) continue;
    const owner = (run.workerTasks ?? []).find((entry) => entry.id === attempt.workerTaskId);
    if (owner?.taskClass !== "verifier") continue;
    const report = await readWorkerReport(attempt.finalReportPath).catch(() => null);
    if (!report?.verifier?.atomicClaims?.length) continue;
    const finishedAt = Date.parse(attempt.finishedAt ?? attempt.startedAt ?? "") || 0;
    if (!latest || finishedAt >= latest.finishedAt) {
      latest = { finishedAt, verdict: report.verifier };
    }
  }
  if (!latest) return null;

  // Everything an implementation touched since that verdict. This is the only
  // reason an established claim could have moved, so naming the files is what
  // makes "re-check only what the delta could affect" an actionable rule rather
  // than an invitation to trust stale results.
  const changedSince = new Set<string>();
  for (const attempt of attempts) {
    if (!attempt.finalReportPath) continue;
    const owner = (run.workerTasks ?? []).find((entry) => entry.id === attempt.workerTaskId);
    if (owner?.taskClass === "verifier") continue;
    const finishedAt = Date.parse(attempt.finishedAt ?? attempt.startedAt ?? "") || 0;
    if (finishedAt < latest.finishedAt) continue;
    const report = await readWorkerReport(attempt.finalReportPath).catch(() => null);
    for (const file of report?.filesChanged ?? []) {
      if (changedSince.size >= MAX_CHANGED_SINCE_FILES) break;
      if (file?.path) changedSince.add(file.path);
    }
  }

  const established: string[] = [];
  const outstanding: PriorVerifierRound["outstanding"] = [];
  for (const claim of latest.verdict.atomicClaims) {
    if (claim.verdict === "verified") {
      if (established.length < MAX_ESTABLISHED_CLAIMS) established.push(clampClaim(claim.claim));
    } else if (outstanding.length < MAX_OUTSTANDING_CLAIMS) {
      outstanding.push({
        claim: clampClaim(claim.claim),
        verdict: claim.verdict,
        evidence: clampClaim(claim.evidence),
      });
    }
  }
  if (established.length === 0) return null;
  return {
    verifiedAt: new Date(latest.finishedAt).toISOString(),
    confidence: latest.verdict.confidence,
    established,
    outstanding,
    changedSince: [...changedSince],
  };
}

// Write a runtime state onto the WorkerAttempt behind a pane and tell the
// renderer about it. Shared by the hook RPC (applyHookStateReport) and the
// unsanctioned-pty-death path, which must produce the identical attempt-side
// write so the run graph, chat timeline and pane never disagree about whether
// a worker is alive.
//
// `source` records the writer: "hook" gives reportTerminalState its
// HOOK_TRUST_MS deference window, "exit" is terminal (the process behind every
// other report is gone).
function bridgeRuntimeStateToAttempt(
  paneId: string,
  state: WorkerRuntimeState,
  note: string | undefined,
  timestamp: string,
  source: "hook" | "exit",
): void {
  const match = findAttemptByPaneId(paneId);
  if (!match) return;
  const { run: targetRun, attempt: targetAttempt } = match;
  // A report that carries a note has something to say about what the worker
  // is doing right now; land it in the ephemeral activity readout whether or
  // not the state WORD moved (the state is often "working" for a whole
  // session while the note names each tool). In-memory + updatedAt bump only:
  // the 1s snapshot poll reads the run cache, so a note-only change needs no
  // run.json write and must not emit runtime_state_changed. A note-less
  // report leaves the last activity standing — only a writer with something
  // to say may overwrite it.
  const activity = note ? piWorkerSafeText(note, PI_WORKER_ACTIVITY_MAX_CHARS) : "";
  const activityChanged = Boolean(activity) && targetAttempt.runtimeActivity !== activity;
  if (activityChanged) {
    targetAttempt.runtimeActivity = activity;
    targetAttempt.runtimeActivityAt = timestamp;
  }
  const attemptStateChanged =
    targetAttempt.runtimeState !== state || targetAttempt.runtimeStateSource !== source;
  if (!attemptStateChanged) {
    // No state-word change but still refresh the timestamp so the
    // HOOK_TRUST_MS window in reportTerminalState slides forward, which is
    // the whole point of receiving repeat hook reports. No save / no
    // event: only the activity line (if any) changed for the renderer.
    targetAttempt.runtimeStateUpdatedAt = timestamp;
    if (activityChanged) targetRun.updatedAt = timestamp;
    return;
  }
  const attemptPrevious = targetAttempt.runtimeState ?? null;
  targetAttempt.runtimeState = state;
  targetAttempt.runtimeStateUpdatedAt = timestamp;
  targetAttempt.runtimeStateSource = source;
  targetRun.updatedAt = timestamp;
  // Same fire-and-forget save pattern reportTerminalState uses: the
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
    message: `Worker attempt runtime state: ${attemptPrevious ?? "unknown"} -> ${state}`,
    payload: {
      previous: attemptPrevious,
      state,
      attemptId: targetAttempt.id,
      source,
      note,
    },
  }).catch((err) => {
    console.warn("[run-store] appendEvent for attempt state failed:", err);
  });
}

// A worker CLI can exit the same instant it writes final-report.json, so the
// pty exit races the finish path that marks the attempt terminal. Let that
// path win before calling anything a crash; 2.5s is well clear of the 750ms
// report poll plus its 4-tick exit grace.
const WORKER_PTY_CRASH_SETTLE_MS = 2_500;

/**
 * Only Cora ends a worker. A worker pty that dies WITHOUT Cora asking for it
 * (sanctioned exits carry PtyExitInfo.sanctioned) and without the attempt ever
 * reaching a terminal status is a crash, and the attempt has to say so while
 * the app is open: every other writer that could notice is the dead process
 * itself, so before this the stale "working" chip survived until the next boot,
 * where recoverOrphanedManagedWorkerAttempts finally cleared it.
 *
 * Scope: this covers the pane itself going away (the user closes the worker
 * pane, the shell dies, the host is swept after wake). It does NOT cover the
 * agent CLI dying on its own, because a CLI worker's pty is an interactive
 * shell and claude/codex is a child of it: `kill -9` on the CLI leaves the
 * shell at its prompt and no pty exit is ever emitted. runWorkerSession watches
 * that case separately via watchAgentCliExit (shell-integration command-done
 * marker) and routes it to markWorkerProcessDeath below.
 *
 * A Pi worker's pty is a display shell in front of a main-process RPC child, so
 * its death says nothing about the worker's health; that path reports its own
 * state from the RPC client instead and is not watched here.
 */
function watchWorkerPtyForCrash(attemptId: string): void {
  pty.onExit(attemptId, (info) => {
    if (info.sanctioned) return;
    // pty-manager drops its exit waiters after the emit, so the watch needs no
    // teardown; the settle checks below decide whether the death was a crash.
    const timer = setTimeout(() => {
      void settleWorkerPtyCrash(attemptId, info);
    }, WORKER_PTY_CRASH_SETTLE_MS);
    timer.unref();
  });
}

async function settleWorkerPtyCrash(attemptId: string, info: PtyExitInfo): Promise<void> {
  // Respawned at the same session id (the claude-backend mode flip kills and
  // re-spawns ~150ms apart): the worker is alive, nothing died.
  if (pty.exists(attemptId)) return;
  const note = info.signal
    ? `Worker process died (signal ${info.signal})`
    : `Worker process died (exit code ${info.exitCode})`;
  await markWorkerProcessDeath(attemptId, note);
}

// Brand an attempt whose worker process died without Cora asking for it.
// Shared by the pty-exit watcher and runWorkerSession's agent-CLI-exit watcher
// so both deaths produce the same "exit"-sourced state.
async function markWorkerProcessDeath(attemptId: string, note: string): Promise<void> {
  const match = findAttemptByPaneId(attemptId);
  if (!match) return;
  const { attempt } = match;
  // The finish path got there first. A settled attempt is Cora's own record of
  // how the worker ended, and no process death may repaint it. "finishing"
  // counts: the turn is over and Cora is grading the report.
  if (ATTEMPT_TERMINAL_STATUSES.has(attempt.status)) return;
  if (attempt.status === "finishing") return;
  // "preparing" / "prompt_ready" attempts have no process yet, so a death
  // here is a launch shell closing, not a worker dying.
  if (attempt.status === "preparing" || attempt.status === "prompt_ready") return;
  if (attempt.runtimeState === "done" || attempt.runtimeState === "error") return;
  // A worker that wrote its final report did its job, whatever its shell did
  // on the way out. Same evidence-first test boot recovery applies.
  if (attempt.finalReportPath && (await fileExists(attempt.finalReportPath))) return;

  const timestamp = new Date().toISOString();
  const worker = activeWorkerProcesses.get(attemptId);
  if (worker) {
    worker.runtimeState = "error";
    worker.runtimeStateNote = note;
    worker.runtimeStateAt = timestamp;
  }
  bridgeRuntimeStateToAttempt(attemptId, "error", note, timestamp, "exit");
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
  bridgeRuntimeStateToAttempt(report.paneId, report.state, report.note, timestamp, "hook");

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
  const latest = [...run.humanMessages].reverse().find(isHeuristicUserMessage);
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
    origin: run.origin,
    projectPolicyMode: runProjectPolicyMode(run),
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

export type ActiveWorkerInputCapability = "pty" | "steer" | "none";

export function activeWorkerInputDescriptor(
  attemptId: string,
): {
  capability: ActiveWorkerInputCapability;
  processGenerationId: string;
} | null {
  const worker = activeWorkerProcesses.get(attemptId);
  if (!worker) return null;
  return {
    capability: worker.inputCapability,
    processGenerationId: worker.processGenerationId,
  };
}

export function writeActiveWorkerInput(
  attemptId: string,
  processGenerationId: string,
  input: string,
): boolean {
  const worker = activeWorkerProcesses.get(attemptId);
  if (
    !worker ||
    worker.processGenerationId !== processGenerationId ||
    worker.inputCapability === "none"
  ) {
    return false;
  }
  worker.write(input);
  return true;
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

  // stopReason is operational state, not user-authored direction. Provider
  // failures, quota notices, and pause labels must never be injected into a
  // worker as if the user had asked for them.
  const promptText = userUpdate?.message;

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

  // A recorded pty death outranks everything: the process whose tail this
  // regex read is gone, so any state it reports now describes a corpse.
  if (targetAttempt.runtimeStateSource === "exit") return;

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
  /**
   * The step this worker belongs to. The chat is per step, and the roster is a
   * union over the whole run (see updatePeerCommsRegistry), so this is what
   * tells two live steps apart inside one file. Undefined for a stepless task,
   * and on rosters written before the union, where every card compares equal
   * and the file behaves exactly as it did.
   */
  stepId?: string;
  label?: string;
  title: string;
  runtime: WorkerRuntime;
  taskClass?: WorkerTask["taskClass"];
  status: string;
  canRunParallel: boolean;
  /**
   * Deliberately independent: not a valid peer_send recipient, and its own
   * sends to anyone but `manager` are refused. Both mailbox transports read
   * this card, so the registry is the single source of truth for the rule.
   */
  isolated?: boolean;
  /**
   * Group-chat membership (WorkerTask.peers / peerComms). False cards are in
   * the file so the transports can refuse their traffic from POSITIVE evidence
   * rather than from absence. `list` / `peer_list` hide them, so a worker is
   * never shown a peer it may not address. Undefined on rosters written before
   * the flag existed: those runs were all-members, and the transports read
   * undefined as such, so upgrading mid-run never severs a live batch.
   */
  peers?: boolean;
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

// Who is in the step's group chat, from the task record alone. Deliberately
// reads BOTH flags: `peers` is the manager's intent, stamped at task creation,
// so a batch launching simultaneously never has a window where a flagged peer
// is not yet addressable; `peerComms` is the per-attempt outcome, which also
// keeps runs that were already in flight before `peers` existed working (their
// tasks carry the outcome flag and nothing else). isolated beats both.
function isPeerGroupMember(task: WorkerTask): boolean {
  if (task.isolated === true) return false;
  return task.peers === true || task.peerComms === true;
}

// A task whose work is over: its card is dropped from the roster on the next
// write, which is what keeps a union over the whole run small and makes the
// file read as "who is live right now". The preparing task is always kept
// regardless, because its own card is what tells the transports it is a known
// participant rather than a worker whose roster moved on.
const TERMINAL_PEER_ROSTER_STATUSES = new Set<WorkerTaskStatus>([
  "accepted",
  "failed",
  "cancelled",
]);

// The roster every mailbox transport reads. A UNION over the run's live worker
// tasks, not a snapshot of the preparing step: agents.json lives at the run
// root, so a per-step snapshot silently evicted the workers of an earlier step
// that was still running, and eviction is indistinguishable from "never a
// member". Every card carries its own stepId instead, and the transports pair
// membership with a same-step check, which keeps the chat per step (the rule
// has not changed) while letting two live steps share one file.
//
// Peer traffic is allowed only between members of the same step, and
// `list` / `peer_list` show only those, so an unflagged or cross-step worker is
// never advertised as reachable. The `manager` card is separate and is not
// subject to either rule: steering must survive a batch where nobody was
// flagged, and a manager broadcast reaches every step.
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
  const peers = run.workerTasks.filter(
    (task) => task.id === currentTask.id || !TERMINAL_PEER_ROSTER_STATUSES.has(task.status),
  );
  const cards: PeerCommsAgentCard[] = peers.map((peer) => {
    const latestAttempt = run.workerAttempts
      .slice()
      .reverse()
      .find((attempt) => attempt.workerTaskId === peer.id);
    // Labels come from the peer's OWN step: matching a cross-step card against
    // the preparing step's plannedAgents would hand it a stranger's label.
    const peerStep = peer.stepId === step?.id ? step : run.steps.find((item) => item.id === peer.stepId);
    const planned = peerStep?.plannedAgents?.find(
      (agent) =>
        agent.summary === peer.description ||
        agent.label === peer.title ||
        agent.label?.toLowerCase() === peer.title.toLowerCase(),
    );
    return {
      workerTaskId: peer.id,
      attemptId: peer.id === currentTask.id ? attemptId : latestAttempt?.id,
      stepId: peer.stepId,
      label: planned?.label,
      title: peer.title,
      runtime: peer.runtimePreference,
      taskClass: peer.taskClass,
      status: peer.id === currentTask.id ? status : latestAttempt?.status ?? peer.status,
      canRunParallel: peer.canRunParallel,
      ...(peer.isolated === true ? { isolated: true as const } : {}),
      peers: isPeerGroupMember(peer),
      allowedPaths: peer.allowedPaths,
      forbiddenPaths: peer.forbiddenPaths,
      expectedOutputs: peer.expectedOutputs,
      updatedAt: peer.id === currentTask.id ? timestamp : peer.updatedAt,
    };
  });
  const registry = {
    version: 1,
    runId: run.id,
    // Provenance only, now that cards carry their own stepId: this says which
    // attempt last rewrote the file, not who is in it.
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
// drain). Fan-out, council, loom, and non-execute autopilot parallel batches
// have no manager session, so advertising a `manager` mailbox participant
// there would leave workers awaiting replies that can never come.
//
// executionMode "direct" is the load-bearing exclusion. A loom/automation run
// is created programmatically, so it carries chatBackend "pi" by default and no
// chatMode at all, which effectiveChatMode collapses to "auto", so the backend
// and mode fields alone can no longer tell a chat manager from a loom. Direct
// runs are finalized by finalizeDirectRun via scheduleAutopilotReview, so
// claiming a manager here would also strand every loom wave at "reviewing"
// (the wave join, downstream layers and pass chaining all hang off it).
// This is the single predicate for "a live CLI manager session drives this
// run"; the worker auto-accept and resume paths call it rather than restating
// it, and worker-prompt's managerInboxIsRead mirrors it.
export function runHasMcpManager(run: RunState): boolean {
  return (
    run.executionMode !== "direct" &&
    (run.chatBackend === "claude" || run.chatBackend === "codex" || run.chatBackend === "pi") &&
    effectiveChatMode(run.chatMode) === "auto"
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
  nativeCodexProfileId,
  nativeClaudeProfileId,
  sandboxed,
  extraWritableDirs,
  openAiFastMode,
  userConstitution,
}: {
  run: RunState;
  task: WorkerTask;
  attemptId: string;
  paths: WorkerArtifactPaths;
  cwd: string;
  promptText: string;
  command: string;
  nativeCodexProfileId?: string;
  nativeClaudeProfileId?: string;
  sandboxed: boolean;
  extraWritableDirs: string[];
  openAiFastMode: boolean;
  userConstitution?: UserConstitutionCapture;
}): Promise<{ exitCode: number; error?: string; costUsd?: number }> {
  let workerConstitutionBlock: string;
  try {
    workerConstitutionBlock = await resolveCapturedWorkerConstitutionBlock({
      userConstitution,
    });
  } catch (error) {
    return {
      exitCode: 1,
      error: `Worker global constitution could not be resolved from the attempt capture: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
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
  if (shouldProvisionWorkerMailbox(run, step, task)) {
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
    processGenerationId: randomUUID(),
    inputCapability: "none",
    write: () => undefined,
    kill,
  });

  try {
    const result = await runStructuredWorker({
      runId: run.id,
      attemptId,
      automationId: run.automationId ?? "",
      task,
      nativeCodexProfileId,
      nativeClaudeProfileId,
      cwd,
      prompt: promptText,
      workerConstitutionBlock,
      paths,
      sandboxed,
      extraWritableDirs,
      openAiFastMode,
      onStarted(nextKill) {
        transportKill = nextKill;
        if (interruptedBeforeStart) nextKill();
      },
    });
    return {
      exitCode: result.exitCode,
      error: result.error,
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    };
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

function piModelForWorker(task: WorkerTask, isAutomationRun = false): string | undefined {
  // One answer, shared with the renderer: plannedWorkerModel holds both the
  // automation passthrough (a pinned/handoff model the automation validation
  // layer already vetted) and the roster coercion Cora-spawned workers get.
  // The renderer prints the same value on queued worker rows, so a row can
  // never advertise a model this chokepoint will not launch.
  return plannedWorkerModel(task, { isAutomationRun });
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

// Tool-result text with its ORIGINAL line structure intact. The pane folds it
// by line (formatPaneCollapsedBlock) instead of the former flatten-to-one-line
// then cut-at-700-characters, which squashed a failed command's usage dump
// into a single giant wrapped line and threw away the tail, where the actual
// error usually is. Callers that want a one-line preview still use
// piWorkerSafeText.
function piWorkerResultRaw(result: unknown): string {
  if (typeof result === "string") return result;
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
      .join("\n");
    if (text) return text;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
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

// Per-turn provider usage from a Pi message_end event, using the same field
// fallbacks as pi-turn.ts: `input` EXCLUDES what came from cache; reads and
// writes are reported apart. Returns null when the event carried no usage.
function piWorkerMessageUsage(
  event: PiRpcEvent,
): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  if (event.type !== "message_end") return null;
  const message = event.message && typeof event.message === "object" && !Array.isArray(event.message)
    ? event.message as Record<string, unknown>
    : null;
  const usage = message?.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
    ? message.usage as Record<string, unknown>
    : null;
  if (!usage) return null;
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  return {
    input: count(usage.input ?? usage.inputTokens ?? usage.input_tokens),
    output: count(usage.output ?? usage.outputTokens ?? usage.output_tokens),
    cacheRead: count(usage.cacheRead ?? usage.cache_read ?? usage.cached),
    cacheWrite: count(usage.cacheWrite ?? usage.cache_write ?? usage.cacheCreation),
  };
}

// Warm follow-up resume, restricted to the task's FIRST attempt. A retry or a
// verifier-FEEDBACK rework of the same task launches cold on a fresh
// per-attempt id instead: the prior attempt's Pi process may be hung rather
// than dead and still hold the session file, and an unbounded rework loop must
// not keep growing one transcript past the gate that admitted it. Verifiers
// are re-fenced on principle; independence of verification is an invariant,
// not a spawn-handler courtesy.
function piWorkerResumeSessionId(
  run: RunState,
  task: WorkerTask,
  attemptId: string,
): string | undefined {
  if (!task.resumeSessionId || task.taskClass === "verifier") return undefined;
  const hasPriorAttempt = run.workerAttempts.some(
    (attempt) => attempt.workerTaskId === task.id && attempt.id !== attemptId,
  );
  return hasPriorAttempt ? undefined : task.resumeSessionId;
}

// Forward-compatibility only, mirroring pi-turn.ts contextWindowFrom: the
// pinned Pi 0.82 never reports a context window on message_end, so the reuse
// gate falls back to contextWindowForModel(attempt.model) while this is null.
function piWorkerMessageContextWindow(event: PiRpcEvent): number | null {
  if (event.type !== "message_end") return null;
  const message = event.message && typeof event.message === "object" && !Array.isArray(event.message)
    ? event.message as Record<string, unknown>
    : null;
  const usage = message?.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
    ? message.usage as Record<string, unknown>
    : null;
  const positive = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  return (
    positive(usage?.contextWindow ?? usage?.context_window) ??
    positive(message?.contextWindow ?? message?.context_window)
  );
}

/**
 * Drive one Pi worker turn to completion.
 *
 * Ends on `agent_settled` (the happy path), on runtime death, on SILENCE (see
 * the constants above), or on the ceiling. `onStallChange` reports the
 * non-terminal middle ground — Cora has heard nothing for a while but the
 * process is alive — so the pane and the run timeline can say so instead of
 * showing a pulsing "working" over a worker nobody can hear.
 */
async function waitForPiWorkerTurn(
  client: PiRpcClient,
  prompt: string,
  onStallChange?: (stall: { stalled: boolean; detail: string }) => void,
): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  let poll: NodeJS.Timeout | null = null;
  let unsubscribe: () => void = () => undefined;
  try {
    const settled = new Promise<void>((resolve, reject) => {
      let providerFailure: string | null = null;
      let lastEventAt = Date.now();
      let lastEventType: string | null = null;
      let stallReported = false;
      unsubscribe = client.onEvent((event) => {
        lastEventAt = Date.now();
        lastEventType = event.type;
        // Any traffic at all means the worker is reachable again. Clear the
        // stall mark so the pane returns to its real state rather than wearing
        // an amber badge for the rest of a turn that recovered.
        if (stallReported) {
          stallReported = false;
          onStallChange?.({ stalled: false, detail: `Pi worker responded again (${event.type}).` });
        }
        providerFailure = piWorkerEventFailure(event) ?? providerFailure;
        // A provider error is provisional while Pi's own retry loop is running:
        // a later clean assistant message or a successful retry means the
        // provider recovered, and the turn must not be failed for it on settle.
        if (
          (event.type === "message_end" && piWorkerEventFailure(event) === null) ||
          (event.type === "auto_retry_end" && event.success === true)
        ) {
          providerFailure = null;
        }
        if (event.type === "agent_settled") {
          if (providerFailure) reject(new Error(providerFailure));
          else resolve();
        }
      });
      poll = setInterval(() => {
        const state = client.state();
        if (state.phase === "failed" || state.phase === "stopped") {
          reject(new Error(state.failure?.message || `Pi worker runtime ${state.phase}.`));
          return;
        }
        const verdict = classifyWorkerSilence({
          silentForMs: Date.now() - lastEventAt,
          providerFailure,
          lastEventType,
          alreadyWarned: stallReported,
        });
        if (verdict.action === "fail") {
          reject(new Error(verdict.detail));
          return;
        }
        if (verdict.action === "warn") {
          stallReported = true;
          onStallChange?.({ stalled: true, detail: verdict.detail });
        }
      }, 500);
      poll.unref();
      timer = setTimeout(
        () => reject(new Error("Pi worker timed out after 90 minutes.")),
        PI_WORKER_TURN_CEILING_MS,
      );
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

const PI_WORKER_FALLBACK_COLS = 110;
const PI_WORKER_FALLBACK_ROWS = 32;
// WorkerAttempt.runtimeActivity is one ellipsized console line on the Runs
// card; anything longer than this is noise the title= tooltip can carry.
const PI_WORKER_ACTIVITY_MAX_CHARS = 120;

/**
 * Pi runs in a main-process RPC client; its PTY is only a durable activity
 * display, and MAIN owns that session outright. The renderer's workers pane
 * is a pure attacher: it materializes only once this session exists (App.tsx
 * gates the pane on pty.exists) and hands TerminalPane a fail-closed display
 * shell, so pane creation can never spawn a process of its own. Create the
 * headless display PTY immediately — a later TerminalPane attach receives the
 * full tail, so background workspaces and late-opened panes see the whole
 * transcript instead of a black hole.
 */
async function ensurePiWorkerDisplayPty(attemptId: string, cwd: string): Promise<void> {
  if (pty.exists(attemptId)) return;
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
  userConstitution,
}: {
  run: RunState;
  task: WorkerTask;
  attemptId: string;
  paths: WorkerArtifactPaths;
  cwd: string;
  promptText: string;
  command: string;
  userConstitution?: UserConstitutionCapture;
}): Promise<{
  exitCode: number;
  error?: string;
  costUsd?: number;
  piSessionId?: string;
  contextTokens?: number;
  contextWindowTokens?: number;
}> {
  const isAutomationRun = run.executionMode === "direct" && Boolean(run.automationId);
  await ensurePiWorkerDisplayPty(attemptId, cwd);
  await pty.waitForResize(attemptId, 5_000);

  const provider = piProviderForWorker(task);
  const model = piModelForWorker(task, isAutomationRun);
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
  // Real provider token usage summed across the session's message_end events,
  // priced at the end so the attempt records a MEASURED cost and the run's
  // rollup can skip its placeholder estimate.
  const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let sawUsage = false;
  // Session identity + final context occupancy, persisted on the attempt so a
  // later follow_up_of spawn can gate warm session reuse. The gauge follows
  // pi-turn.ts semantics: the newest message carries the whole conversation,
  // so each message_end supersedes the previous value instead of adding to it.
  let piSessionId: string | undefined;
  let lastContextTokens = 0;
  let reportedContextWindowTokens: number | undefined;
  const sessionCapture = () => ({
    ...(piSessionId ? { piSessionId } : {}),
    ...(lastContextTokens > 0 ? { contextTokens: lastContextTokens } : {}),
    ...(reportedContextWindowTokens !== undefined
      ? { contextWindowTokens: reportedContextWindowTokens }
      : {}),
  });
  const measuredPiCostUsd = (): number =>
    sawUsage
      ? estimateWorkerCostUsd({
          runtime: task.runtimePreference,
          modelHint: model ?? task.modelHint,
          usage: {
            // The pricer subtracts cache reads from input_tokens before
            // applying the full input rate, so hand it the cache-inclusive
            // total. Cache writes have no table rate of their own and are
            // folded in at the plain input rate.
            input_tokens: usageTotals.input + usageTotals.cacheRead + usageTotals.cacheWrite,
            output_tokens: usageTotals.output,
            cache_read_input_tokens: usageTotals.cacheRead,
          },
        })
      : 0;
  // Mode-600 MCP roster written for this attempt; removed with the session.
  let mcpConfigPath: string | null = null;
  let workerConstitutionPromptPath: string | null = null;
  let agentSocketCapabilityId: string | undefined;
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
  const stripPaneSgr = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
  const paint = (text: string) => {
    pty.publishOutput(attemptId, text);
    appendWorkerLog(stripPaneSgr(text));
  };
  // Pane and log get different text. Used where the pane shows a folded view:
  // paint() logs exactly what it paints, so anything the pane hides has to be
  // handed to the log separately or it is gone for good.
  const paintFolded = (paneText: string, logText: string) => {
    pty.publishOutput(attemptId, paneText);
    appendWorkerLog(stripPaneSgr(logText));
  };
  // Live "what is it doing right now" readout for the Runs graph card.
  // In-memory only and value-gated: mutate the cached attempt and bump its
  // run's updatedAt so the renderer's live-worker snapshot poll carries it —
  // deliberately NO run.json write and NO event per tool call, this fires on
  // every tool start. Resolve the target attempt at WRITE time through the
  // run cache, exactly like the hook bridge does: only mutations on the
  // instance listRuns serves are ever visible to the renderer, and the `run`
  // parameter this session captured stops being that instance if the cache
  // entry is ever replaced mid-session.
  const reportActivity = (text: unknown) => {
    const activity = piWorkerSafeText(text, PI_WORKER_ACTIVITY_MAX_CHARS);
    if (!activity) return;
    const target = findAttemptByPaneId(attemptId);
    if (!target || target.attempt.runtimeActivity === activity) return;
    const at = new Date().toISOString();
    target.attempt.runtimeActivity = activity;
    target.attempt.runtimeActivityAt = at;
    target.run.updatedAt = at;
  };

  try {
    const step = run.steps.find((item) => item.id === task.stepId);
    // Mailbox provisioning, not group membership: an unflagged batch worker
    // still gets the peer_* tools so Cora can reach it. Which recipients those
    // tools accept is decided by the registry roster, not by the env stamp.
    const peerCommsEnabled =
      runProjectPolicyMode(run) === "trusted" &&
      shouldProvisionWorkerMailbox(run, step, task);
    const persistedAttempt = run.workerAttempts.find(
      (item) => item.id === attemptId,
    );
    const managerChat = resolveChatBackendConfig(run);
    let workerAccountProfileId = selectPiWorkerAccountProfile({
      persistedAttemptProfileId: persistedAttempt?.accountProfileId,
      runManagerProfileId: managerChat.accountProfileId,
      runManagerProvider:
        managerChat.backend === "pi"
          ? piProviderForManagerModel(managerChat.model)
          : null,
      workerProvider: provider,
    });
    if (!workerAccountProfileId) {
      workerAccountProfileId = (
        await rankImplicitPiAccounts(provider, model)
      )[0]?.accountProfileId;
    }
    const resolvedWorkerAccount = await resolveCodaraPiExecutionAccount({
      provider,
      ...(workerAccountProfileId
        ? { preferredAccountProfileId: workerAccountProfileId }
        : {}),
    });
    await stampAttemptAccountProfile(
      run.id,
      task.id,
      attemptId,
      resolvedWorkerAccount.accountProfileId,
    );
    // Resolve only this attempt's immutable provenance after account/runtime
    // prerequisites, immediately before the plan can create a provider-owned
    // prompt file or start Pi. Current Settings and run-level fallback are not
    // available through this resolver's type or implementation.
    const workerConstitutionBlock =
      await resolveCapturedWorkerConstitutionBlock({ userConstitution });
    const plan = await createCodaraPiWorkerLaunchPlan({
      provider,
      runId: run.id,
      attemptId,
      cwd,
      model,
      thinking,
      sessionName: task.title,
      accountProfileId: resolvedWorkerAccount.accountProfileId,
      resolvedAccount: resolvedWorkerAccount,
      executionPolicy: effectiveRunExecutionPolicy(run),
      projectPolicyMode: runProjectPolicyMode(run),
      workerConstitutionBlock,
      untrustedWriteAllowFiles:
        runProjectPolicyMode(run) === "untrusted-pull-request"
          ? [paths.finalReportJson]
          : undefined,
      // Warm follow-up: continue the accepted source worker's transcript. The
      // spawn-time gate stamped this only after checking runtime, success, and
      // context headroom; piWorkerResumeSessionId re-fences verifiers and
      // restricts the resume to the task's FIRST attempt.
      resumeSessionId: piWorkerResumeSessionId(run, task, attemptId),
      // Frozen contract with resources/pi-cora/worker.ts: parallel-batch
      // workers get CODARA_PI_PEER_DIR + CODARA_PI_SELF_ID to reach the
      // run's mailbox natively. Same gate as the prompt-side guidance.
      peerCommsDir: peerCommsEnabled ? paths.peerCommsDir : undefined,
      peerSelfId: peerCommsEnabled ? task.id : undefined,
      // Automation (loom) workers: flips the bridge roster to SPARK_MCP_MODE
      // "worker" (ask_user + request_next_iteration), stamps the automation/
      // node identity, and arms the extension's tool-access fence. A fenced
      // worker's writes are contained to the workspace plus these dirs (the
      // attempt dir carries the mandatory final report; the mail dir is the
      // chat board for collab participants).
      automation: isAutomationRun
        ? {
            automationId: run.automationId as string,
            nodeId: task.loomNodeId,
            access: task.accessHint,
            blockedTools: task.blockedToolsHint,
            writeAllowDirs: [
              paths.attemptDir,
              ...(task.collabMailDirHint ? [task.collabMailDirHint] : []),
            ],
          }
        : undefined,
    });
    // The plan creator may write a per-session MCP bridge file. Capture it
    // before the durable profile stamp so any stamp failure still reaches the
    // finally cleanup path.
    mcpConfigPath = plan.mcpConfigPath;
    workerConstitutionPromptPath = plan.workerConstitutionPromptPath;
    agentSocketCapabilityId = plan.agentSocketCapabilityId;
    piSessionId = plan.sessionId;
    if (plan.accountProfileId !== resolvedWorkerAccount.accountProfileId) {
      throw new Error("Pi worker plan changed its frozen account identity");
    }
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
      processGenerationId: randomUUID(),
      inputCapability: "steer",
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
    // The note doubles as the card's first activity line, so it should read
    // as what the worker is DOING ("starting…"), not which harness runs it —
    // the first tool call replaces it moments later.
    applyHookStateReport({ paneId: attemptId, state: "working", note: "starting…" });

    let assistantLineOpen = false;
    // Pane budget for ONE streamed assistant message. Prose arrives delta by
    // delta so its length is unknown until it ends and it cannot be head/tail
    // folded like a tool result; past the budget (lines OR characters, since a
    // stream can run on without a single newline) the pane stops repainting
    // and says where the rest is, while appendWorkerLog still gets every byte.
    let assistantBudget = paneStreamBudget();
    let assistantPaneCut = false;
    unsubscribe = client.onEvent((event: PiRpcEvent) => {
      if (event.type === "tool_execution_start") {
        assistantLineOpen = false;
        assistantBudget = paneStreamBudget();
        assistantPaneCut = false;
        const label = piWorkerToolLabel(event.toolName);
        const detail = piWorkerToolDetail(event);
        reportActivity(detail ? `${label} · ${detail}` : label);
        paint(
          `\r\n  ${paneToolStartMarker(label)}` +
          `${detail ? `\r\n    ${paneDim(detail)}` : ""}\r\n`,
        );
      } else if (event.type === "tool_execution_end") {
        const failed = event.isError === true;
        const marker = `  ${failed ? paneToolFailMarker() : paneToolOkMarker()}`;
        // Failure output keeps its line structure and is folded head + tail in
        // the PANE with a dim marker. The folded middle would otherwise be lost
        // for good, since paint() logs what it paints, so the log is written
        // from the untouched text instead. That is what the marker's "full
        // output in the run log" promises.
        const raw = failed ? piWorkerResultRaw(event.result) : "";
        if (raw) {
          const detail = formatPaneCollapsedBlock(raw, { indent: "    ", color: PANE_RED });
          paintFolded(`${marker}${detail}\r\n`, `${marker}\r\n${raw}\r\n`);
        } else {
          paint(`${marker}\r\n`);
        }
      } else if (event.type === "message_update") {
        const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.delta === "string" && delta.delta) {
          if (assistantPaneCut) {
            appendWorkerLog(delta.delta);
          } else {
            if (!assistantLineOpen) {
              paint("\r\n  ");
              assistantLineOpen = true;
              // Once per streamed message (this branch runs on its first
              // delta only), never per delta.
              reportActivity("writing…");
            }
            paint(delta.delta.replace(/\n/g, "\r\n  "));
            assistantBudget = paneStreamAdd(assistantBudget, delta.delta);
            if (paneStreamExceeded(assistantBudget)) {
              assistantPaneCut = true;
              assistantLineOpen = false;
              paint(`\r\n  ${paneDim(`… ${PANE_STREAM_CUT_NOTE}`)}\r\n`);
            }
          }
        }
      } else if (event.type === "message_end") {
        if (assistantLineOpen) {
          paint("\r\n");
          assistantLineOpen = false;
        }
        assistantBudget = paneStreamBudget();
        assistantPaneCut = false;
        const usage = piWorkerMessageUsage(event);
        if (usage) {
          sawUsage = true;
          usageTotals.input += usage.input;
          usageTotals.output += usage.output;
          usageTotals.cacheRead += usage.cacheRead;
          usageTotals.cacheWrite += usage.cacheWrite;
          // Context gauge for the reuse gate: what the newest request occupied.
          const gauge = usage.input + usage.cacheRead + usage.cacheWrite;
          if (gauge > 0) lastContextTokens = gauge;
          reportedContextWindowTokens =
            piWorkerMessageContextWindow(event) ?? reportedContextWindowTokens;
        }
        const failure = piWorkerEventFailure(event);
        if (failure) {
          reportActivity(`Provider error: ${piWorkerSafeText(failure, 300)}`);
          paint(`\r\n  \x1b[31mProvider error: ${piWorkerSafeText(failure, 700)}\x1b[0m\r\n`);
        }
      } else if (event.type === "auto_retry_start") {
        reportActivity("Provider retry…");
        paint(`\r\n  ${paneRetryMarker("Provider retry…")}\r\n`);
      } else if (event.type === "auto_retry_end" && event.success === false) {
        reportActivity(`Provider retry failed: ${piWorkerSafeText(event.finalError, 300)}`);
        paint(`\r\n  \x1b[31mProvider retry failed: ${piWorkerSafeText(event.finalError, 700)}\x1b[0m\r\n`);
      } else if (event.type === "extension_error") {
        paint(`\r\n  \x1b[31mExtension error: ${String(event.error ?? "unknown")}\x1b[0m\r\n`);
      }
    });

    // Silence is reported, not just eventually acted on. The pane chip flips to
    // amber "no response" and the run timeline gets a state change, so a worker
    // Cora cannot hear stops looking identical to one that is working.
    const reportStall = (stall: { stalled: boolean; detail: string }) => {
      if (stall.stalled) {
        applyHookStateReport({ paneId: attemptId, state: "stalled", note: stall.detail });
        paint(`\r\n  \x1b[33m⏸ ${piWorkerSafeText(stall.detail, 700)}\x1b[0m\r\n`);
      } else {
        applyHookStateReport({ paneId: attemptId, state: "working", note: stall.detail });
        paint(`\r\n  \x1b[32m▸ ${piWorkerSafeText(stall.detail, 300)}\x1b[0m\r\n`);
      }
    };

    paint(`  \x1b[32m✓ Pi ready\x1b[0m · ${plan.provider}/${plan.model}\r\n`);
    await waitForPiWorkerTurn(client, promptText, reportStall);
    if (interrupted) throw new Error("Pi worker was interrupted.");

    let report = await readWorkerReport(paths.finalReportJson);
    if (!report) {
      paint("\r\n  \x1b[33m↻ Finalizing the evidence report…\x1b[0m\r\n");
      await waitForPiWorkerTurn(
        client,
        `Your task turn ended without a parseable final report at ${paths.finalReportJson}. ` +
          "Do not redo completed work. Inspect the current diff and verification evidence, then write the mandatory final-report.json using the exact schema and absolute path from the original task prompt. End only after confirming the file parses as JSON.",
        reportStall,
      );
      report = await readWorkerReport(paths.finalReportJson);
    }
    if (!report) throw new Error("Pi worker completed without a parseable final-report.json.");

    applyHookStateReport({ paneId: attemptId, state: "done", note: "Pi worker report ready" });
    paintPiWorkerReportOutcome(paint, report);
    await logQueue.catch(() => undefined);
    const successCost = measuredPiCostUsd();
    return { exitCode: 0, ...(successCost > 0 ? { costUsd: successCost } : {}), ...sessionCapture() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A late error must not fail work that already finished: when the worker's
    // own final report is on disk with a non-failed status (observed live: a
    // provider "servers overloaded" arriving during shutdown, long after the
    // validated report), writeAutoFailureReport preserves it and this session
    // settles as succeeded so the report's verdict decides the node.
    const failureWrite = await writeAutoFailureReport(paths, task, message, { interrupted }).catch(() => null);
    if (failureWrite?.preservedExisting) {
      const report = await readWorkerReport(paths.finalReportJson).catch(() => null);
      if (report && (report.status === "complete" || report.status === "partial")) {
        applyHookStateReport({ paneId: attemptId, state: "done", note: "Pi worker report ready" });
        paint(`\r\n\x1b[33m  !  Late worker error ignored (final report already written): ${piWorkerSafeText(message, 700)}\x1b[0m\r\n`);
        paintPiWorkerReportOutcome(paint, report);
        await logQueue.catch(() => undefined);
        const preservedCost = measuredPiCostUsd();
        return { exitCode: 0, ...(preservedCost > 0 ? { costUsd: preservedCost } : {}), ...sessionCapture() };
      }
    }
    applyHookStateReport({ paneId: attemptId, state: interrupted ? "done" : "error", note: message });
    paint(`\r\n\x1b[31m  ×  PI WORKER STOPPED\x1b[0m\r\n  ${message}\r\n`);
    await logQueue.catch(() => undefined);
    const failureCost = measuredPiCostUsd();
    return { exitCode: 1, error: message, ...(failureCost > 0 ? { costUsd: failureCost } : {}), ...sessionCapture() };
  } finally {
    unsubscribe?.();
    activeWorkerProcesses.delete(attemptId);
    await client?.stop().catch(() => undefined);
    await cleanupPiMcpBridgeConfig({
      mcpConfigPath,
      workerConstitutionPromptPath,
      agentSocketCapabilityId,
    }).catch(() => undefined);
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
  userConstitution,
  workerConstitutionPromptFile,
}: {
  run: RunState;
  task: WorkerTask;
  attemptId: string;
  paths: WorkerArtifactPaths;
  cwd: string;
  launchCommand: string | null;
  promptText: string;
  command: string;
  userConstitution?: UserConstitutionCapture;
  workerConstitutionPromptFile?: {
    directory: string;
    fileStem: string;
  };
}): Promise<{ exitCode: number; error?: string }> {
  // Wait until the renderer's TerminalView mounts and calls pty:spawn for
  // this attempt. The "worker_attempt.launch_requested" event (emitted by
  // launchWorkerAttempt just above) triggers the pane add in App.tsx; from
  // there it's normally <1s before pty-manager has a session.
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
    const chunkText = chunk.toString("utf8");
    // The fresh chunk plus a bounded carry overlap (a fatal banner can split
    // across a chunk boundary) — the cheap hint gate below sees only this
    // window, while a confirmed scan still runs on the full carry.
    const gateWindow = fatalErrorBuffer.slice(-FATAL_ERROR_GATE_OVERLAP) + chunkText;
    fatalErrorBuffer = (fatalErrorBuffer + chunkText).slice(-8192);
    // Gate the full 8 KB strip + regex scan on the fresh window containing a
    // fatal-error hint substring: for the overwhelming majority of chunks
    // (ordinary agent output) this is a single small strip + a few includes.
    if (fatalErrorTimer || !mayContainFatalWorkerRuntimeError(gateWindow)) return;
    const fatalReason = detectFatalWorkerRuntimeError(fatalErrorBuffer, task.runtimePreference);
    if (fatalReason) {
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
          // Cora is ending this attempt, so the pane's death is sanctioned:
          // the failure is already recorded on the attempt, and a second
          // "crashed" brand from the pty exit would outlive it.
          pty.dispose(attemptId, { sanctioned: true });
          failFast(fatalReason);
        })();
      }, 2500);
    }
  });

  const handle = {
    write: (input: string) => pty.write(attemptId, input),
    kill: () => pty.dispose(attemptId, { sanctioned: true }),
  };

  const step = run.steps.find((item) => item.id === task.stepId);
  const announceCliWorkerRunning = async (): Promise<void> => {
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
    if (shouldProvisionWorkerMailbox(run, step, task)) {
      await updatePeerCommsRegistry(
        run,
        step,
        task,
        attemptId,
        paths,
        "running",
      ).catch(() => undefined);
    }
  };
  // Preserve the historical legacy/disabled timing exactly. Enabled captures
  // defer the running transition until their immutable file exists.
  if (!workerConstitutionPromptFile) await announceCliWorkerRunning();

  activeWorkerProcesses.set(attemptId, {
    runId: run.id,
    stepId: task.stepId,
    workerTaskId: task.id,
    attemptId,
    command,
    processGenerationId: randomUUID(),
    inputCapability: "pty",
    write: handle.write,
    kill: handle.kill,
  });

  // Resolve when either:
  //   * the launch driver detects the agent never started (fast fail), or
  //   * the worker writes final-report.json (success path), or
  //   * the user closes the pane (ptyExit), or
  //   * we hit the hard timeout (90 minutes).
  let failFast: (reason: string) => void = () => undefined;
  // The agent CLI died but its host shell is still at a prompt, so no pty exit
  // will ever fire. Assigned by the executor below, armed by the launch driver.
  let onAgentCliExit: (exitCode: number | null) => void = () => undefined;
  let offAgentCliExit: (() => void) | null = null;
  let sessionSettled = false;
  // Backstop for a death Cora never asked for. exitPromise below settles the
  // attempt whenever this orchestration loop is still watching, and the settle
  // checks skip anything it settled; what survives is the case that used to
  // leave a pane pulsing "working" until the next boot.
  watchWorkerPtyForCrash(attemptId);
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
      sessionSettled = true;
      // Tear down the worker tree BEFORE resolving so callers awaiting
      // exitPromise observe a fully cleaned-up worker. killImmediate is a
      // no-op if the pty already exited via offExit, so success paths cost
      // nothing.
      killWorkerTree();
      offExit();
      offAgentCliExit?.();
      offRawTap();
      rawStream.end();
      clearInterval(reportPoll);
      clearTimeout(hardTimeout);
      if (fatalErrorTimer) clearTimeout(fatalErrorTimer);
      resolve(value);
    };
    // A CLI that exits the instant it writes final-report.json must not be
    // failed just because the death beat the 750ms report poll. Give the report
    // one last chance to parse (short grace covers a mid-write file) before
    // declaring the worker gone. finish() is idempotent, so a poll tick landing
    // during the grace resolves first and this no-ops. brandCrash runs only
    // when no report showed up, and before finish() so the attempt is still
    // non-terminal when markWorkerProcessDeath checks it.
    const settleAfterWorkerGone = async (
      fallback: { exitCode: number; error: string },
      brandCrash?: () => Promise<void>,
    ): Promise<void> => {
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
      if (settled) return;
      if (brandCrash) await brandCrash().catch(() => undefined);
      finish(fallback);
    };
    const offExit = pty.onExit(attemptId, (info) => {
      void settleAfterWorkerGone({
        exitCode: info.exitCode ?? 1,
        error: info.signal ? `Worker pane closed (signal ${info.signal})` : "Worker pane closed before final report",
      });
    });
    // The shell outlived its agent CLI: nothing else in the pipeline reports
    // this death, so brand the attempt here and resolve the run loop instead of
    // letting it wait out the 90-minute watchdog.
    onAgentCliExit = (exitCode: number | null) => {
      const reason =
        exitCode === null || exitCode === 0
          ? "Agent CLI exited before writing a final report"
          : `Agent CLI exited with code ${exitCode} before writing a final report`;
      void settleAfterWorkerGone(
        { exitCode: exitCode && exitCode !== 0 ? exitCode : 1, error: reason },
        () => markWorkerProcessDeath(attemptId, reason),
      );
    };
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
  let workerConstitutionPromptPath: string | null = null;
  void (async () => {
    try {
      await delay(1500);
      if (sessionSettled) return;
      if (launchCommand) {
        if (workerConstitutionPromptFile) {
          // Final prerequisite before the provider command: resolve this exact
          // attempt and materialize an owner-only append-system-prompt file.
          // The task prompt and event stream never receive these bytes.
          const block = await resolveCapturedWorkerConstitutionBlock({
            userConstitution,
          });
          workerConstitutionPromptPath =
            await writePrivateWorkerConstitutionPrompt({
              block,
              ...workerConstitutionPromptFile,
            });
          if (sessionSettled) {
            await cleanupPrivateWorkerConstitutionPrompt(
              workerConstitutionPromptPath,
            );
            workerConstitutionPromptPath = null;
            return;
          }
        }
        if (workerConstitutionPromptFile) {
          await announceCliWorkerRunning();
        }
        if (sessionSettled) return;
        // Armed before the command is typed so the watcher sees that command's
        // own pre-exec marker; without a pre-exec first it would fire on the
        // marker the shell already emitted for its startup prompt.
        offAgentCliExit = watchAgentCliExit(attemptId, (exitCode) => onAgentCliExit(exitCode));
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
      const reason = err instanceof Error ? err.message : String(err);
      await recordWorkerOutput(run, task, attemptId, paths, "stderr",
        `\n[spark] failed to prepare or drive worker pane: ${reason}\n`);
      await writeAutoFailureReport(paths, task, reason).catch(() => undefined);
      failFast(`Worker launch preparation failed: ${reason}`);
    }
  })();

  try {
    return await exitPromise;
  } finally {
    activeWorkerProcesses.delete(attemptId);
    await cleanupPrivateWorkerConstitutionPrompt(
      workerConstitutionPromptPath,
    ).catch(() => undefined);
  }
}

async function stampAttemptAccountProfile(
  runId: string,
  workerTaskId: string,
  attemptId: string,
  accountProfileId: string | undefined,
): Promise<void> {
  if (!accountProfileId) return;
  const run = await requireRun(runId);
  const existing = run.workerAttempts.find((item) => item.id === attemptId);
  if (!existing) throw new Error(`Worker attempt not found: ${attemptId}`);
  if (existing.accountProfileId === accountProfileId) return;
  if (existing.accountProfileId) {
    throw new Error(
      `Worker attempt ${attemptId} is pinned to a different Pi account profile`,
    );
  }
  await commitRunChange(run, {
    type: "worker_attempt.account_profile_selected",
    message: "Worker attempt pinned to its Pi account profile",
    workerTaskId,
    payload: { attemptId, accountProfileId },
    mutate: (draft, timestamp) => {
      const attempt = draft.workerAttempts.find((item) => item.id === attemptId);
      if (!attempt) throw new Error(`Worker attempt not found: ${attemptId}`);
      if (attempt.accountProfileId === accountProfileId) return false;
      if (attempt.accountProfileId && attempt.accountProfileId !== accountProfileId) {
        throw new Error(
          `Worker attempt ${attemptId} is pinned to a different Pi account profile`,
        );
      }
      attempt.accountProfileId = accountProfileId;
      draft.updatedAt = timestamp;
    },
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
  opts?: {
    sandboxDir?: string;
    isAutomation?: boolean;
    extraWritableDirs?: string[];
    workerConstitutionPromptPath?: string;
    openAiFastMode?: boolean;
  },
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
    if (opts?.workerConstitutionPromptPath) {
      args.push(
        "--append-system-prompt-file",
        quoteShellArg(opts.workerConstitutionPromptPath),
      );
    }
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
    args.push(...codexFastModeArgs(opts?.openAiFastMode));
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
