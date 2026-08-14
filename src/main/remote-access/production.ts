// Production wiring for Remote Access: builds the RemoteAccessService's
// dependencies from the real main process (sparkHome, storage, pty-manager,
// shells) and owns the process-wide singleton. This is the only module in
// remote-access/ allowed to import the rest of the main process; everything
// else stays plain Node so tests and the e2e harness can run it directly.

import { BrowserWindow, app, shell } from "electron";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, extname, join, posix, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";
import { makeId } from "@shared/ids";
import type {
  GitHubMarkReadyInput,
  GitHubMarkReadyResult,
  GitHubPublishInput,
  GitHubPublishResult,
  GitHubMergeInput,
  GitHubMergeResult,
  GitHubWorkspaceStatus,
  StartGitHubIssueInput,
  StartGitHubIssueResult,
  StartGitHubPullRequestInput,
  StartGitHubPullRequestResult,
} from "@shared/github";
import { isRemotePath } from "@shared/remote";
import {
  applyWorkspaceGroupShades,
  ensureWorkspaceGroupColors,
  normalizeWorkspaceColor,
  pickWorkspaceColor,
} from "@shared/workspace-colors";
import type {
  AppSettings,
  AppState,
  AgentEffortLevel,
  AutomationTrigger,
  BoardCard,
  BoardCardStatus,
  RunBoard,
  RunState,
  RunStatus,
  ScheduledJob,
  SparkEvent,
  Workspace,
  WorkspaceGroup,
  WorkerSessionMemoryScope,
} from "@shared/types";
import { logMain } from "../file-log";
import { setAllowedRoots } from "../fs-sandbox";
import { getCommitDetail as readGitCommitDetail } from "../git-inspect";
import {
  getGitLog as readGitLog,
  getGitStatus as readGitStatus,
} from "../git-ops";
import { readCachedGitHubWorkspaceStatus } from "../github-cli";
import {
  invalidateGitHubWorkQueueGlobalCache,
  readGitHubWorkQueue,
} from "../github-work-queue";
import { markGitHubPullRequestReady } from "../github-ready";
import { mergeGitHubPullRequest } from "../github-merge";
import { publishGitHubWorkspace } from "../github-publish";
import { startGitHubIssueWorkspace } from "../github-issue-workspace";
import { startGitHubPullRequestWorkspace } from "../github-pull-request-workspace";
import {
  addRunMessage,
  activeWorkerInputDescriptor,
  answerRunQuestion,
  deleteRun,
  forcePauseRun,
  getRun,
  getRunBoard,
  listRuns,
  onRunDeleted,
  resumeManagerTurnRecovery,
  resumeRun,
  startAutopilot,
  undoToCheckpoint,
  updateChatBackend,
  updateRunBoard,
  writeActiveWorkerInput,
} from "../orchestration/run-store";
import { inspectPiAccountProfileAuthStore } from "../orchestration/pi-account-auth-store";
import { inspectPiModelCatalog } from "../orchestration/pi-model-catalog";
import { PiAccountProfileRegistry } from "../orchestration/pi-account-profiles";
import { inspectCachedPiSubscriptionUsageProfiles } from "../orchestration/pi-subscription-usage";
import { nativeCliAccounts } from "../orchestration/native-cli-accounts";
import { BOARD_MAX_CARDS } from "../orchestration/board-store";
import { ensureCodexProjectTrust } from "../orchestration/codex-trust";
import { resolveNewNativeClaudeProfile } from "../orchestration/native-claude-profile-runtime";
import { runsRoot, subscribeToEvents } from "../orchestration/event-log";
import {
  getJob,
  listJobs,
  pauseJob,
  resumeJob,
  runJobNow,
  setEnabled as setJobEnabled,
} from "../orchestration/scheduler";
import { isWatchingRun } from "../notify/attention";
import {
  EXPO_RECEIPT_POLL_MS,
  ExpoReceiptTracker,
  PhoneNotificationStore,
  phoneNotificationKindAllowed,
  sendExpoPushMessages,
  type ExpoPushTarget,
} from "./phone-notify";
import { getPreferenceCached, getPreferenceSync } from "../preferences-store";
import * as pty from "../pty-manager";
import { sparkHome } from "../spark-home";
import {
  loadSettings,
  loadState,
  onStateSaved,
  saveSettings,
  saveState,
} from "../storage";
import { requestTerminalOp } from "../terminal-bridge";
import {
  deleteWorkerSession as deleteLocalWorkerSession,
  listWorkerSessions as listLocalWorkerSessions,
} from "../worker-sessions";
import {
  RemoteAccessService,
  type RemoteTerminalCreateRequest,
  type RemoteTerminalHandle,
  type RemoteWorkerTerminalOpenRequest,
} from "./index";
import { StudioTerminalShareStore } from "./studio-terminal-share";
import {
  findRemoteCoraRetry,
  KeyedSerialQueue,
  selectRemoteConversationRuns,
} from "./cora-policy";
import { repairCoraRetryFromRunWindow } from "./cora-retry-repair";
import { CoraSendReceiptIndex } from "./cora-send-receipts";
import { normalizeCoraMessage } from "./cora-message-policy";
import { remoteCoraRunContext } from "./cora-run-context";
import { projectBoundedRemoteCoraRun } from "./cora-run-projection";
import {
  CORA_HISTORY_RUNS_JSON_MAX_BYTES,
  isOneOf,
  isRemoteCoraIdentity,
  isRemoteCoraTimestamp,
  requireRemoteCoraIdentity,
  requireRemoteCoraTimestamp,
  takeJsonArrayPrefixWithinBudget,
} from "./remote-cora-contract";
import {
  projectRemoteBoardRead,
  type RemoteBoardReadProjection,
} from "./board-projection";
import {
  createRemoteWorkspaceEntry,
  deleteRemoteWorkspaceEntry,
  moveRemoteWorkspaceEntry,
  renameRemoteWorkspaceEntry,
} from "./file-mutations";
import {
  createRemoteImageUpload,
  pruneRemoteImageUploads,
  type RemoteImageUploadHandle,
  type RemoteImageUploadRequest,
} from "./image-upload";
import {
  isStudioExplorerIgnoredDirectory,
  resolveExistingInside,
  toWireRelative,
  truncateUtf8,
} from "./local-policy";
import type {
  RemoteAutomationDetail,
  RemoteAutomationInfo,
  RemoteAutomationLiveRun,
  RemoteAutomationRunRecord,
  RemoteAutomationTriggerKind,
  RemoteBoard,
  RemoteBoardAction,
  RemoteBoardCard,
  RemoteBoardUpdateResult,
  RemoteCoraMessage,
  RemoteCoraModel,
  RemoteCoraRun,
  RemoteCoraRunProjection,
  RemoteCoraRunSummary,
  RemoteCoraStep,
  RemoteCoraWorker,
  RemoteWhiteboard,
  RemoteWhiteboardEdge,
  RemoteWhiteboardNode,
  RemoteNotificationRegistration,
  RemotePhoneNotification,
  RemoteDirectoryListing,
  RemoteFileContent,
  RemoteFileDeleteResult,
  RemoteFileInfo,
  RemoteFileListing,
  RemoteFleetOverviewProjection,
  RemoteNativeCliAccount,
  RemoteSubscriptionProfile,
  RemoteSubscriptionProvider,
  RemoteGitChange,
  RemoteGitCommitDetail,
  RemoteGitCommitFile,
  RemoteGitCommitSummary,
  RemoteGitLog,
  RemoteGitStatus,
  RemoteWorkspaceGroupInfo,
  RemoteWorkspaceInfo,
  RemoteWorkspaceOrganization,
  RemoteWorkerSessionDeleteResult,
  RemoteWorkerSessionInfo,
  RemoteCoraChangedEvent,
  RemoteCoraResumeAccount,
  RemoteCoraResumeResult,
  RemoteCoraThinkingLevel,
  } from "./rpc";
import { createCoraChangedCoalescer } from "./cora-change-coalescer";
import { projectRemoteFleetOverview } from "./fleet-overview";
import { projectRemoteNativeCliAccounts } from "./native-cli-account-projection";
import { projectRemoteSubscriptionProfiles } from "./subscription-profile-projection";

let singleton: RemoteAccessService | null = null;
let stateSavedSubscriptionInstalled = false;
let coraSendReceiptCleanupInstalled = false;
let coraSendReceiptIndexPromise: Promise<CoraSendReceiptIndex> | null = null;
let workspaceMutation: Promise<void> = Promise.resolve();
// Every mutation that can affect the NEXT manager turn shares one per-run
// lane. Account selection, recovery, and message send must never overtake one
// another merely because they arrived over different RPC methods.
const coraRunMutations = new KeyedSerialQueue();
const fileMutations = new KeyedSerialQueue();
let lastRemoteImagePruneAt = 0;
let accountProfileRegistry: PiAccountProfileRegistry | null = null;

// DTO budgets deliberately leave generous headroom under the 1 MiB frame
// ceiling for JSON escaping and the response envelope.
const COLLECTION_BUDGET_BYTES = 384 * 1024;
const REMOTE_FILE_MAX_BYTES = 384 * 1024;
const MAX_REMOTE_WORKSPACES = 200;
const MAX_REMOTE_WORKSPACE_GROUPS = 100;
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_FILE_ENTRIES = 750;
const MAX_CORA_RUNS = 50;
const MAX_CORA_MESSAGES = 200;
const MAX_GIT_LOG_COMMITS = 100;
const MAX_GIT_COMMIT_FILES = 500;
const MAX_REMOTE_WORKER_SESSIONS = 40;
const MAX_REMOTE_AUTOMATIONS = 50;
const MAX_CORA_RUN_WORKERS = 12;
const CORA_WORKER_ROSTER_MAX_BYTES = 16 * 1024;
const MAX_CORA_RUN_STEPS = 12;
// A desktop board can hold BOARD_MAX_CARDS (500). The phone is a review
// surface, so it takes the head of the pipeline order and reports the rest as
// a count rather than shipping a 500-card list on every poll.
const MAX_REMOTE_BOARD_CARDS = 100;
const REMOTE_BOARD_TITLE_MAX_BYTES = 300;
const REMOTE_BOARD_DESCRIPTION_MAX_BYTES = 2000;
const REMOTE_BOARD_ERROR_MAX_BYTES = 500;
const MAX_REMOTE_WHITEBOARD_NODES = 200;
const MAX_REMOTE_WHITEBOARD_EDGES = 300;
const GIT_COMMIT_BODY_MAX_BYTES = 32 * 1024;
const TERMINAL_SPAWN_WAIT_MS = 10_000;
const TERMINAL_SPAWN_SETTLE_MS = 150;
const TERMINAL_BOOTSTRAP_BYTES = 256 * 1024;
const READ_ONLY_NO_FOLLOW_FLAGS =
  fsConstants.O_RDONLY | ((fsConstants.O_NOFOLLOW as number | undefined) ?? 0);

const ACTIVE_WORKER_ATTEMPT_STATUSES = new Set([
  "preparing",
  "prompt_ready",
  "launching",
  "running",
  "finishing",
]);
const ACCOUNT_PROFILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NATIVE_CLI_PROFILE_ID_PATTERN =
  /^(?:personal|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export function getRemoteAccessService(): RemoteAccessService {
  if (!singleton) {
    singleton = new RemoteAccessService({
      remoteDir: join(sparkHome(), "remote"),
      deviceName: hostname(),
      appVersion: app.getVersion(),
      listWorkspaces: listWorkspacesForRemote,
      getFleetOverview: getFleetOverviewForRemote,
      listSubscriptionProfiles: listSubscriptionProfilesForRemote,
      listCoraModels: listCoraModelsForRemote,
      listNativeCliAccounts: listNativeCliAccountsForRemote,
      listWorkspaceOrganization: listWorkspaceOrganizationForRemote,
      listDirectories: listDirectoriesForRemote,
      addWorkspace: addWorkspaceForRemote,
      createWorkspaceGroup: createWorkspaceGroupForRemote,
      updateWorkspaceGroup: updateWorkspaceGroupForRemote,
      deleteWorkspaceGroup: deleteWorkspaceGroupForRemote,
      moveWorkspace: moveWorkspaceForRemote,
      reorderWorkspaceRail: reorderWorkspaceRailForRemote,
      listFiles: listFilesForRemote,
      readFile: readFileForRemote,
      createFileEntry: createFileEntryForRemote,
      renameFileEntry: renameFileEntryForRemote,
      moveFileEntry: moveFileEntryForRemote,
      deleteFileEntry: deleteFileEntryForRemote,
      getGitStatus: getGitStatusForRemote,
      getGitLog: getGitLogForRemote,
      getGitCommitDetail: getGitCommitDetailForRemote,
      getGitHubStatus: getGitHubStatusForRemote,
      getGitHubWorkQueue: getGitHubWorkQueueForRemote,
      publishGitHub: publishGitHubForRemote,
      markGitHubReady: markGitHubReadyForRemote,
      mergeGitHub: mergeGitHubForRemote,
      startGitHubIssue: startGitHubIssueForRemote,
      startGitHubPullRequest: startGitHubPullRequestForRemote,
      listCoraHistory: listCoraHistoryForRemote,
      getCoraRun: getCoraRunForRemote,
      getCoraGraph: getCoraGraphForRemote,
      deleteCoraRun: deleteCoraRunForRemote,
      sendCoraMessage: sendCoraMessageForRemote,
      resumeCoraRun: resumeCoraRunForRemote,
      forcePauseCoraRun: forcePauseCoraRunForRemote,
      resumePausedCoraRun: resumePausedCoraRunForRemote,
      undoCoraRun: undoCoraRunForRemote,
      getCoraWhiteboard: getCoraWhiteboardForRemote,
      getCoraBoard: getCoraBoardForRemote,
      updateCoraBoard: updateCoraBoardForRemote,
      getOpenAiFastMode: getOpenAiFastModeForRemote,
      setOpenAiFastMode: setOpenAiFastModeForRemote,
      listWorkerSessions: listWorkerSessionsForRemote,
      deleteWorkerSession: deleteWorkerSessionForRemote,
      listAutomations: listAutomationsForRemote,
      getAutomation: getAutomationForRemote,
      runAutomation: runAutomationForRemote,
      pauseAutomation: pauseAutomationForRemote,
      resumeAutomation: resumeAutomationForRemote,
      setAutomationEnabled: setAutomationEnabledForRemote,
      registerNotifications: registerNotificationsForRemote,
      beginImageUpload: beginImageUploadForRemote,
      attachWorkerTerminal: attachRemoteWorkerTerminal,
      studioTerminalLeases: new StudioTerminalShareStore(),
      createTerminal: createRemoteTerminal,
      log: (line) => logMain("remote-access", line),
    });
  }
  if (!stateSavedSubscriptionInstalled) {
    stateSavedSubscriptionInstalled = true;
    onStateSaved(() => singleton?.notifyWorkspacesChanged());
  }
  if (!coraSendReceiptCleanupInstalled) {
    coraSendReceiptCleanupInstalled = true;
    onRunDeleted(async ({ workspaceId, runId }) => {
      await (await getCoraSendReceiptIndex()).removeRun(workspaceId, runId);
    });
  }
  startPhoneNotificationBridge(singleton);
  return singleton;
}

function getCoraSendReceiptIndex(): Promise<CoraSendReceiptIndex> {
  coraSendReceiptIndexPromise ??= CoraSendReceiptIndex.open({
    rootDir: join(sparkHome(), "remote"),
    log: (line) => logMain("remote-access", line),
  });
  return coraSendReceiptIndexPromise;
}

// Boot hook, called from index.ts once the app is ready: re-enable the
// listener when the user left the setting on. Fire-and-forget; a failed
// start surfaces through the status (Settings shows the error), never as a
// boot failure.
export function initRemoteAccessAtBoot(): void {
  try {
    if (getPreferenceSync("remoteAccessEnabled") !== true) return;
  } catch {
    return;
  }
  void getRemoteAccessService()
    .setEnabled(true)
    .catch((err) =>
      logMain("remote-access", `boot enable failed: ${(err as Error).message}`),
    );
}

// The phone lists local workspaces only. SSH workspaces are skipped because
// this transport is paired to this computer, not transitively to another host.
async function listWorkspacesForRemote(): Promise<RemoteWorkspaceInfo[]> {
  const state = await loadState();
  const result: RemoteWorkspaceInfo[] = [];
  let usedBytes = 2;
  for (const workspace of state.workspaces) {
    if (result.length >= MAX_REMOTE_WORKSPACES) break;
    if (isRemotePath(workspace.cwd)) continue;
    const info = await workspaceInfo(workspace);
    const bytes = Buffer.byteLength(JSON.stringify(info), "utf8") + 1;
    if (usedBytes + bytes > COLLECTION_BUDGET_BYTES) break;
    result.push(info);
    usedBytes += bytes;
  }
  return result;
}

async function getFleetOverviewForRemote(): Promise<RemoteFleetOverviewProjection> {
  // One read per backing collection. In particular, runs are loaded globally
  // once rather than once per workspace; the pure projector performs every
  // workspace aggregation over that one snapshot.
  const [workspaces, runs, automations] = await Promise.all([
    listWorkspacesForRemote(),
    listRuns(),
    listJobs(),
  ]);
  return projectRemoteFleetOverview(workspaces, runs, automations);
}

function getAccountProfileRegistry(): PiAccountProfileRegistry {
  // Metadata sits beside Pi's app-owned configuration, never in the remote
  // directory or a phone-readable auth store. The registry itself rejects
  // token-shaped/unknown fields and exposes only opaque ids + labels.
  accountProfileRegistry ??= new PiAccountProfileRegistry(
    join(sparkHome(), "pi-agent"),
  );
  return accountProfileRegistry;
}

async function listSubscriptionProfilesForRemote(): Promise<
  RemoteSubscriptionProfile[]
> {
  // Authentication is inspected in main and projected to one coarse status.
  // The phone receives no token, provider identity, expiry timestamp or auth
  // path, but it also never presents a stale metadata row as selectable when
  // its credentials are missing. Usage is a synchronous peek at the fresh
  // in-memory cache only: listing profiles never starts vendor/network I/O.
  const inspection = await inspectPiAccountProfileAuthStore();
  return projectRemoteSubscriptionProfiles(
    inspection,
    inspectCachedPiSubscriptionUsageProfiles(),
  );
}

const REMOTE_CORA_THINKING_LEVELS = new Set<RemoteCoraThinkingLevel>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

async function listCoraModelsForRemote(): Promise<RemoteCoraModel[]> {
  const live = await inspectPiModelCatalog();
  const models = live.length > 0
    ? live
    : [
        {
          id: "claude-fable-5",
          label: "Claude Fable 5",
          provider: "anthropic" as const,
          thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          id: "claude-opus-5",
          label: "Claude Opus 5",
          provider: "anthropic" as const,
          thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          id: "claude-sonnet-5",
          label: "Claude Sonnet 5",
          provider: "anthropic" as const,
          thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          id: "gpt-5.6-sol",
          label: "GPT-5.6 Sol",
          provider: "openai-codex" as const,
          thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          id: "gpt-5.6-terra",
          label: "GPT-5.6 Terra",
          provider: "openai-codex" as const,
          thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          id: "gpt-5.6-luna",
          label: "GPT-5.6 Luna",
          provider: "openai-codex" as const,
          thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
        },
      ];
  return models
    .map((model) => ({
      id: truncateUtf8(model.id, 128),
      label: truncateUtf8(model.label, 160),
      provider: model.provider,
      thinkingLevels: model.thinkingLevels.filter(
        (level): level is RemoteCoraThinkingLevel =>
          REMOTE_CORA_THINKING_LEVELS.has(level as RemoteCoraThinkingLevel),
      ),
    }))
    // Claude is deliberately first on every client surface.
    .sort(
      (left, right) =>
        (left.provider === "anthropic" ? 0 : 1) -
          (right.provider === "anthropic" ? 0 : 1) ||
        left.label.localeCompare(right.label),
    );
}

async function listNativeCliAccountsForRemote(): Promise<
  RemoteNativeCliAccount[]
> {
  return projectRemoteNativeCliAccounts(await nativeCliAccounts.inspect());
}

function providerForRemoteModel(model: string | undefined): RemoteSubscriptionProvider | null {
  const normalized = model?.trim().toLowerCase();
  if (normalized?.startsWith("claude-")) return "anthropic";
  if (normalized?.startsWith("gpt-")) return "openai-codex";
  return null;
}

async function resumeCoraRunForRemote(input: {
  workspaceId: string;
  runId: string;
  recoveryId: string;
  account?: RemoteCoraResumeAccount;
}): Promise<RemoteCoraResumeResult> {
  await requireLocalWorkspace(input.workspaceId);
  return coraRunMutations.run(
    JSON.stringify([input.workspaceId, input.runId]),
    async () => {
      const run = await requireOwnedRun(input.workspaceId, input.runId);
      if (run.automationId) {
        return {
          outcome: "stale",
          recoveryId: input.recoveryId,
          reason: "Automation runs are resumed from Automations.",
        };
      }
      const account = input.account
        ? input.account.kind === "subscription"
          ? {
              kind: "subscription" as const,
              profileId: input.account.profileId,
            }
          : {
              kind: "native-cli" as const,
              backend: input.account.runtime,
              profileId: input.account.profileId,
            }
        : undefined;
      const result = await resumeManagerTurnRecovery({
        runId: run.id,
        recoveryId: input.recoveryId,
        ...(account ? { account } : {}),
      });
      return {
        outcome: result.outcome,
        recoveryId: input.recoveryId,
        ...(result.reason
          ? { reason: truncateUtf8(result.reason, 512) }
          : {}),
      };
    },
  );
}

async function listWorkspaceOrganizationForRemote(): Promise<RemoteWorkspaceOrganization> {
  const state = await loadState();
  const groups: RemoteWorkspaceGroupInfo[] = [];
  let usedBytes = 2;
  for (const group of state.workspaceGroups) {
    if (groups.length >= MAX_REMOTE_WORKSPACE_GROUPS) break;
    const info = workspaceGroupInfo(group);
    const bytes = Buffer.byteLength(JSON.stringify(info), "utf8") + 1;
    if (usedBytes + bytes > COLLECTION_BUDGET_BYTES) break;
    groups.push(info);
    usedBytes += bytes;
  }
  const groupIds = new Set(groups.map((group) => group.id));
  const localUngroupedIds = state.workspaces
    .filter((workspace) => !workspace.groupId && !isRemotePath(workspace.cwd))
    .map((workspace) => workspace.id);
  const eligible = new Set([...localUngroupedIds, ...groupIds]);
  const railOrder: string[] = [];
  const seen = new Set<string>();
  for (const itemId of state.workspaceRailOrder ?? []) {
    if (!eligible.has(itemId) || seen.has(itemId)) continue;
    seen.add(itemId);
    railOrder.push(itemId);
  }
  for (const itemId of eligible) {
    if (!seen.has(itemId)) railOrder.push(itemId);
  }
  return { groups, railOrder };
}

function workspaceGroupInfo(group: WorkspaceGroup): RemoteWorkspaceGroupInfo {
  return {
    id: group.id,
    name: truncateUtf8(group.name, 512),
    collapsed: group.collapsed,
    ...(group.color ? { color: group.color } : {}),
  };
}

function remoteWorkspaceGroupName(value: string): string {
  const name = truncateUtf8(
    value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    512,
  );
  if (!name) throw new Error("Workspace folder names cannot be empty.");
  return name;
}

async function workspaceInfo(
  workspace: Workspace,
): Promise<RemoteWorkspaceInfo> {
  let branch: string | undefined;
  try {
    const status = await readGitStatus(workspace.cwd);
    if (status.isRepo && status.branch)
      branch = truncateUtf8(status.branch, 240);
  } catch {
    // A workspace remains selectable even if git cannot inspect it.
  }
  return {
    id: workspace.id,
    name: truncateUtf8(workspace.name, 512),
    path: workspace.cwd,
    ...(workspace.groupId ? { groupId: workspace.groupId } : {}),
    color: workspace.color,
    ...(branch ? { branch } : {}),
  };
}

async function listDirectoriesForRemote(
  rawPath?: string,
): Promise<RemoteDirectoryListing> {
  const resolved = await resolveExistingInside(homedir(), rawPath, {
    allowAbsolute: true,
    directory: true,
  });
  let entries;
  try {
    entries = await readdir(resolved.path, { withFileTypes: true });
  } catch {
    throw new Error("This directory cannot be opened.");
  }

  const directories: RemoteDirectoryListing["directories"] = [];
  let usedBytes = 2;
  for (const entry of entries
    .filter(
      (candidate) => candidate.isDirectory() && !candidate.isSymbolicLink(),
    )
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    )) {
    if (directories.length >= MAX_DIRECTORY_ENTRIES) break;
    const item = {
      name: entry.name,
      path: join(resolved.path, entry.name),
    };
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (usedBytes + bytes > COLLECTION_BUDGET_BYTES) break;
    directories.push(item);
    usedBytes += bytes;
  }
  return {
    path: resolved.path,
    parentPath: resolved.path === resolved.root ? null : dirname(resolved.path),
    rootPath: resolved.root,
    directories,
  };
}

async function addWorkspaceForRemote(input: {
  path: string;
  name?: string;
}): Promise<RemoteWorkspaceInfo> {
  return serializeWorkspaceMutation(async () => {
    const selected = await resolveExistingInside(homedir(), input.path, {
      allowAbsolute: true,
      directory: true,
    });
    const state = await loadState();
    for (const workspace of state.workspaces) {
      if (isRemotePath(workspace.cwd)) continue;
      const existing = await realpath(resolve(workspace.cwd)).catch(() =>
        resolve(workspace.cwd),
      );
      if (existing === selected.path) return workspaceInfo(workspace);
    }

    const color = pickWorkspaceColor(
      state.workspaces.map((workspace) => workspace.color),
      selected.path,
    );
    const requestedName = input.name?.trim();
    const workspace: Workspace = {
      id: `ws-mobile-${randomUUID()}`,
      name: truncateUtf8(
        requestedName || basename(selected.path) || "workspace",
        512,
      ),
      cwd: selected.path,
      color,
      workers: [],
    };
    const next: AppState = {
      ...state,
      workspaces: [...state.workspaces, workspace],
      workspaceRailOrder: [...(state.workspaceRailOrder ?? []), workspace.id],
      activeWorkspaceId: state.activeWorkspaceId ?? workspace.id,
    };
    await saveState(next);
    setAllowedRoots(next.workspaces.map((candidate) => candidate.cwd));
    broadcastStateChanged(next);
    return workspaceInfo(workspace);
  });
}

async function createWorkspaceGroupForRemote(
  name: string,
): Promise<RemoteWorkspaceGroupInfo> {
  return serializeWorkspaceMutation(async () => {
    const state = await loadState();
    if (state.workspaceGroups.length >= MAX_REMOTE_WORKSPACE_GROUPS) {
      throw new Error(
        `Codara Studio supports at most ${MAX_REMOTE_WORKSPACE_GROUPS} remote workspace folders.`,
      );
    }
    const id = `workspace-group-mobile-${randomUUID()}`;
    const coloredGroups = ensureWorkspaceGroupColors(state.workspaceGroups);
    const group: WorkspaceGroup = {
      id,
      name: remoteWorkspaceGroupName(name),
      collapsed: false,
      color: pickWorkspaceColor(
        coloredGroups.flatMap((candidate) => candidate.color ? [candidate.color] : []),
        id,
      ),
    };
    const next: AppState = {
      ...state,
      workspaceGroups: [...coloredGroups, group],
      workspaceRailOrder: normalizeWorkspaceRailOrderForRemote(
        [...(state.workspaceRailOrder ?? []), group.id],
        state.workspaces,
        [...coloredGroups, group],
      ),
    };
    await persistRemoteWorkspaceState(next);
    return workspaceGroupInfo(group);
  });
}

async function updateWorkspaceGroupForRemote(input: {
  groupId: string;
  name?: string;
  collapsed?: boolean;
  color?: string;
}): Promise<RemoteWorkspaceGroupInfo> {
  return serializeWorkspaceMutation(async () => {
    const state = await loadState();
    const index = state.workspaceGroups.findIndex(
      (group) => group.id === input.groupId,
    );
    if (index < 0) throw new Error("This workspace folder no longer exists.");
    const current = state.workspaceGroups[index];
    const updated: WorkspaceGroup = {
      ...current,
      ...(input.name !== undefined
        ? { name: remoteWorkspaceGroupName(input.name) }
        : {}),
      ...(input.collapsed !== undefined ? { collapsed: input.collapsed } : {}),
      ...(input.color !== undefined
        ? { color: normalizeWorkspaceColor(input.color) ?? current.color }
        : {}),
    };
    const workspaceGroups = state.workspaceGroups.slice();
    workspaceGroups[index] = updated;
    const workspaces = input.color === undefined
      ? state.workspaces
      : applyWorkspaceGroupShades(state.workspaces, workspaceGroups, [updated.id]);
    await persistRemoteWorkspaceState({ ...state, workspaces, workspaceGroups });
    return workspaceGroupInfo(updated);
  });
}

async function deleteWorkspaceGroupForRemote(groupId: string): Promise<void> {
  return serializeWorkspaceMutation(async () => {
    const state = await loadState();
    const groupIndex = state.workspaceGroups.findIndex(
      (group) => group.id === groupId,
    );
    if (groupIndex < 0)
      throw new Error("This workspace folder no longer exists.");
    const workspaceGroups = state.workspaceGroups.filter(
      (group) => group.id !== groupId,
    );
    const releasedIds: string[] = [];
    const usedColors = state.workspaces
      .filter((workspace) => workspace.groupId !== groupId)
      .map((workspace) => workspace.color);
    const workspaces = state.workspaces.map((workspace) => {
      if (workspace.groupId !== groupId) return workspace;
      releasedIds.push(workspace.id);
      const { groupId: _discarded, ...ungrouped } = workspace;
      const color = pickWorkspaceColor(usedColors, workspace.cwd);
      usedColors.push(color);
      return { ...ungrouped, color };
    });
    const oldOrder = state.workspaceRailOrder ?? [];
    const oldIndex = oldOrder.indexOf(groupId);
    const withoutGroup = oldOrder.filter(
      (itemId) => itemId !== groupId && !releasedIds.includes(itemId),
    );
    withoutGroup.splice(
      oldIndex >= 0
        ? Math.min(oldIndex, withoutGroup.length)
        : withoutGroup.length,
      0,
      ...releasedIds,
    );
    await persistRemoteWorkspaceState({
      ...state,
      workspaces,
      workspaceGroups,
      workspaceRailOrder: normalizeWorkspaceRailOrderForRemote(
        withoutGroup,
        workspaces,
        workspaceGroups,
      ),
    });
  });
}

async function moveWorkspaceForRemote(input: {
  workspaceId: string;
  groupId: string | null;
  beforeWorkspaceId?: string | null;
  beforeRailItemId?: string | null;
}): Promise<RemoteWorkspaceInfo> {
  return serializeWorkspaceMutation(async () => {
    const state = await loadState();
    const sourceIndex = state.workspaces.findIndex(
      (workspace) => workspace.id === input.workspaceId,
    );
    if (sourceIndex < 0 || isRemotePath(state.workspaces[sourceIndex].cwd)) {
      throw new Error("This local workspace no longer exists.");
    }
    if (
      input.groupId !== null &&
      !state.workspaceGroups.some((group) => group.id === input.groupId)
    ) {
      throw new Error("The destination workspace folder no longer exists.");
    }
    if (input.groupId !== null && input.beforeRailItemId !== undefined) {
      throw new Error(
        "A workspace folder position cannot use a top-level destination.",
      );
    }
    if (
      input.beforeWorkspaceId === input.workspaceId ||
      (sourceIndex >= 0 &&
        !state.workspaces[sourceIndex].groupId &&
        input.beforeRailItemId === input.workspaceId)
    ) {
      return workspaceInfo(state.workspaces[sourceIndex]);
    }
    if (input.beforeWorkspaceId) {
      const before = state.workspaces.find(
        (workspace) => workspace.id === input.beforeWorkspaceId,
      );
      if (
        !before ||
        isRemotePath(before.cwd) ||
        (before.groupId ?? null) !== input.groupId
      ) {
        throw new Error(
          "The requested workspace position is no longer available.",
        );
      }
    }

    const source = state.workspaces[sourceIndex];
    const remaining = state.workspaces.filter(
      (workspace) => workspace.id !== input.workspaceId,
    );
    const color = (source.groupId ?? null) === input.groupId
      ? source.color
      : input.groupId
        ? source.color
        : pickWorkspaceColor(remaining.map((workspace) => workspace.color), source.cwd);
    const moved: Workspace = input.groupId
      ? { ...source, groupId: input.groupId, color }
      : (() => {
          const { groupId: _discarded, ...ungrouped } = source;
          return { ...ungrouped, color };
        })();
    let insertAt = input.beforeWorkspaceId
      ? remaining.findIndex(
          (workspace) => workspace.id === input.beforeWorkspaceId,
        )
      : -1;
    if (insertAt < 0) {
      let lastInDestination = -1;
      for (let index = 0; index < remaining.length; index += 1) {
        if ((remaining[index].groupId ?? null) === input.groupId) {
          lastInDestination = index;
        }
      }
      insertAt =
        lastInDestination >= 0 ? lastInDestination + 1 : remaining.length;
    }
    const insertedWorkspaces = remaining.slice();
    insertedWorkspaces.splice(insertAt, 0, moved);
    const affectedGroups = [source.groupId, input.groupId]
      .filter((id): id is string => Boolean(id));
    const workspaces = applyWorkspaceGroupShades(
      insertedWorkspaces,
      state.workspaceGroups,
      [...new Set(affectedGroups)],
    );
    const persistedWorkspace = workspaces.find((workspace) => workspace.id === moved.id) ?? moved;

    let railOrder = normalizeWorkspaceRailOrderForRemote(
      state.workspaceRailOrder ?? [],
      workspaces,
      state.workspaceGroups,
    ).filter((itemId) => itemId !== input.workspaceId);
    if (input.groupId === null) {
      if (
        input.beforeRailItemId &&
        !state.workspaceGroups.some(
          (group) => group.id === input.beforeRailItemId,
        ) &&
        !state.workspaces.some(
          (workspace) =>
            workspace.id === input.beforeRailItemId &&
            !isRemotePath(workspace.cwd) &&
            workspace.id !== input.workspaceId &&
            !(
              workspace.groupId &&
              state.workspaceGroups.some(
                (group) => group.id === workspace.groupId,
              )
            ),
        )
      ) {
        throw new Error(
          "The requested top-level position is no longer available.",
        );
      }
      const railInsertAt = input.beforeRailItemId
        ? railOrder.indexOf(input.beforeRailItemId)
        : railOrder.length;
      railOrder.splice(
        railInsertAt >= 0 ? railInsertAt : railOrder.length,
        0,
        input.workspaceId,
      );
    }
    railOrder = normalizeWorkspaceRailOrderForRemote(
      railOrder,
      workspaces,
      state.workspaceGroups,
    );
    await persistRemoteWorkspaceState({
      ...state,
      workspaces,
      workspaceRailOrder: railOrder,
    });
    return workspaceInfo(persistedWorkspace);
  });
}

async function reorderWorkspaceRailForRemote(input: {
  itemId: string;
  beforeItemId?: string | null;
}): Promise<void> {
  return serializeWorkspaceMutation(async () => {
    const state = await loadState();
    const isVisibleRailItem = (itemId: string): boolean =>
      state.workspaceGroups.some((group) => group.id === itemId) ||
      state.workspaces.some(
        (workspace) =>
          workspace.id === itemId &&
          !workspace.groupId &&
          !isRemotePath(workspace.cwd),
      );
    if (!isVisibleRailItem(input.itemId)) {
      throw new Error("This workspace rail item no longer exists.");
    }
    if (
      input.beforeItemId !== undefined &&
      input.beforeItemId !== null &&
      !isVisibleRailItem(input.beforeItemId)
    ) {
      throw new Error(
        "The requested workspace rail position no longer exists.",
      );
    }
    if (input.beforeItemId === input.itemId) return;
    const current = normalizeWorkspaceRailOrderForRemote(
      state.workspaceRailOrder ?? [],
      state.workspaces,
      state.workspaceGroups,
    );
    const remaining = current.filter((itemId) => itemId !== input.itemId);
    const insertAt = input.beforeItemId
      ? remaining.indexOf(input.beforeItemId)
      : remaining.length;
    if (input.beforeItemId && insertAt < 0) {
      throw new Error(
        "The requested workspace rail position no longer exists.",
      );
    }
    const workspaceRailOrder = remaining.slice();
    workspaceRailOrder.splice(insertAt, 0, input.itemId);
    await persistRemoteWorkspaceState({ ...state, workspaceRailOrder });
  });
}

function normalizeWorkspaceRailOrderForRemote(
  order: readonly string[],
  workspaces: readonly Workspace[],
  groups: readonly WorkspaceGroup[],
): string[] {
  const eligible = new Set([
    ...workspaces
      .filter((workspace) => !workspace.groupId)
      .map((workspace) => workspace.id),
    ...groups.map((group) => group.id),
  ]);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const itemId of order) {
    if (!eligible.has(itemId) || seen.has(itemId)) continue;
    seen.add(itemId);
    result.push(itemId);
  }
  for (const itemId of eligible) {
    if (!seen.has(itemId)) result.push(itemId);
  }
  return result;
}

async function persistRemoteWorkspaceState(state: AppState): Promise<void> {
  await saveState(state);
  setAllowedRoots(state.workspaces.map((workspace) => workspace.cwd));
  broadcastStateChanged(state);
}

function serializeWorkspaceMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = workspaceMutation.catch(() => undefined).then(operation);
  workspaceMutation = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function broadcastStateChanged(state: AppState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents;
    if (contents.isDestroyed()) continue;
    try {
      contents.send("state:changed", state);
    } catch {
      // A window can disappear between enumeration and send.
    }
  }
}

// The renderer caches AppSettings and only re-hydrates from what a writer
// republishes (useOpenAiFastMode). A phone-side write happens in main, so it
// has to push the saved record itself; without this the composer bolt would
// stay stale and the next Settings save would revert the phone's flip.
function broadcastSettingsChanged(settings: AppSettings): void {
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents;
    if (contents.isDestroyed()) continue;
    try {
      contents.send("settings:changed", settings);
    } catch {
      // A window can disappear between enumeration and send.
    }
  }
}

async function requireLocalWorkspace(
  workspaceId: string,
): Promise<{ workspace: Workspace; root: string }> {
  const state = await loadState();
  const workspace = state.workspaces.find(
    (candidate) => candidate.id === workspaceId,
  );
  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
  if (isRemotePath(workspace.cwd)) {
    throw new Error(
      "This workspace lives on an SSH host; open it on the computer instead.",
    );
  }
  const resolved = await resolveExistingInside(workspace.cwd, undefined, {
    directory: true,
  });
  return { workspace, root: resolved.root };
}

async function listFilesForRemote(input: {
  workspaceId: string;
  path?: string;
}): Promise<RemoteFileListing> {
  const { root } = await requireLocalWorkspace(input.workspaceId);
  const target = await resolveExistingInside(root, input.path, {
    directory: true,
    rejectSymlinks: true,
  });
  let entries;
  try {
    entries = await readdir(target.path, { withFileTypes: true });
  } catch {
    throw new Error("This directory cannot be opened.");
  }

  const result: RemoteFileInfo[] = [];
  let usedBytes = 2;
  const sorted = entries
    .filter(
      (entry) =>
        !entry.isSymbolicLink() &&
        (entry.isDirectory() || entry.isFile()) &&
        !(entry.isDirectory() && isStudioExplorerIgnoredDirectory(entry.name)),
    )
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  for (const entry of sorted) {
    if (result.length >= MAX_FILE_ENTRIES) break;
    const absolute = join(target.path, entry.name);
    const extension = entry.isFile()
      ? extname(entry.name).slice(1).toLowerCase()
      : "";
    const item: RemoteFileInfo = {
      name: entry.name,
      path: toWireRelative(root, absolute),
      isDir: entry.isDirectory(),
      ...(extension ? { ext: extension } : {}),
    };
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (usedBytes + bytes > COLLECTION_BUDGET_BYTES) break;
    result.push(item);
    usedBytes += bytes;
  }
  const path = toWireRelative(root, target.path);
  return {
    path,
    parentPath: path
      ? posix.dirname(path) === "."
        ? ""
        : posix.dirname(path)
      : null,
    entries: result,
  };
}

async function readFileForRemote(input: {
  workspaceId: string;
  path: string;
}): Promise<RemoteFileContent> {
  const { root } = await requireLocalWorkspace(input.workspaceId);
  const target = await resolveExistingInside(root, input.path, {
    rejectSymlinks: true,
  });
  // O_NOFOLLOW, where exposed by the platform, closes the final-component
  // swap window between the policy realpath/lstat checks above and open().
  // Intermediate components remain canonicalized by resolveExistingInside;
  // the open handle then pins the selected inode for the bounded read below.
  const handle = await open(target.path, READ_ONLY_NO_FOLLOW_FLAGS).catch(
    () => null,
  );
  if (!handle) throw new Error("This file cannot be opened.");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Path must identify a regular file.");
    if (info.size > REMOTE_FILE_MAX_BYTES) {
      throw new Error(
        `File is too large for Remote Access (maximum ${REMOTE_FILE_MAX_BYTES / 1024} KiB).`,
      );
    }
    const data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < data.length) {
      const read = await handle.read(
        data,
        offset,
        data.length - offset,
        offset,
      );
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const exact = offset === data.length ? data : data.subarray(0, offset);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(exact);
    } catch {
      throw new Error("Only UTF-8 text files can be opened on the phone.");
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)) {
      throw new Error("Binary files cannot be opened on the phone.");
    }
    return {
      path: toWireRelative(root, target.path),
      name: basename(target.path),
      content,
      size: exact.length,
      mtimeMs: info.mtimeMs,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function createFileEntryForRemote(input: {
  workspaceId: string;
  parentPath?: string;
  name: string;
  kind: "file" | "directory";
}): Promise<RemoteFileInfo> {
  return fileMutations.run(input.workspaceId, async () => {
    const { root } = await requireLocalWorkspace(input.workspaceId);
    return createRemoteWorkspaceEntry(root, {
      ...(input.parentPath !== undefined
        ? { parentPath: input.parentPath }
        : {}),
      name: input.name,
      kind: input.kind,
    });
  });
}

async function renameFileEntryForRemote(input: {
  workspaceId: string;
  path: string;
  name: string;
}): Promise<RemoteFileInfo> {
  return fileMutations.run(input.workspaceId, async () => {
    const { root } = await requireLocalWorkspace(input.workspaceId);
    return renameRemoteWorkspaceEntry(root, {
      path: input.path,
      name: input.name,
    });
  });
}

async function moveFileEntryForRemote(input: {
  workspaceId: string;
  path: string;
  destinationPath?: string;
}): Promise<RemoteFileInfo> {
  return fileMutations.run(input.workspaceId, async () => {
    const { root } = await requireLocalWorkspace(input.workspaceId);
    return moveRemoteWorkspaceEntry(root, {
      path: input.path,
      ...(input.destinationPath !== undefined
        ? { destinationPath: input.destinationPath }
        : {}),
    });
  });
}

async function deleteFileEntryForRemote(input: {
  workspaceId: string;
  path: string;
}): Promise<RemoteFileDeleteResult> {
  return fileMutations.run(input.workspaceId, async () => {
    const { root } = await requireLocalWorkspace(input.workspaceId);
    // Match Studio's local Explorer: deleting a local workspace entry moves it
    // to the computer's Trash, so an accidental phone action is recoverable.
    return deleteRemoteWorkspaceEntry(root, { path: input.path }, (path) =>
      shell.trashItem(path),
    );
  });
}

async function beginImageUploadForRemote(
  input: RemoteImageUploadRequest,
): Promise<RemoteImageUploadHandle> {
  // Image attachments are tied to a real local workspace even though the
  // materialised file lives in the OS temp directory. This keeps the surface
  // aligned with the rest of Remote Access and rejects stale workspace ids.
  await requireLocalWorkspace(input.workspaceId);
  const directory = join(app.getPath("temp"), "codara-remote-images");
  const now = Date.now();
  if (now - lastRemoteImagePruneAt > 60 * 60 * 1000) {
    lastRemoteImagePruneAt = now;
    void pruneRemoteImageUploads(directory, now).catch(() => undefined);
  }
  return createRemoteImageUpload(directory, input);
}

async function getGitStatusForRemote(
  workspaceId: string,
): Promise<RemoteGitStatus> {
  const { root } = await requireLocalWorkspace(workspaceId);
  const status = await readGitStatus(root);
  let usedBytes = 2;
  const fitChanges = (changes: typeof status.staged): RemoteGitChange[] => {
    const result: RemoteGitChange[] = [];
    for (const change of changes) {
      const item: RemoteGitChange = {
        path: truncateUtf8(change.path, 4096),
        ...(change.oldPath
          ? { oldPath: truncateUtf8(change.oldPath, 4096) }
          : {}),
        status: change.status,
      };
      const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
      if (usedBytes + bytes > COLLECTION_BUDGET_BYTES) break;
      result.push(item);
      usedBytes += bytes;
    }
    return result;
  };
  return {
    isRepo: status.isRepo,
    ...(status.branch ? { branch: truncateUtf8(status.branch, 240) } : {}),
    detached: status.detached,
    ...(status.upstream
      ? { upstream: truncateUtf8(status.upstream, 500) }
      : {}),
    ahead: status.ahead,
    behind: status.behind,
    staged: fitChanges(status.staged),
    unstaged: fitChanges(status.unstaged),
    hasConflicts: status.hasConflicts,
    ...(status.error ? { error: truncateUtf8(status.error, 1000) } : {}),
  };
}

async function getGitHubStatusForRemote(
  workspaceId: string,
): Promise<GitHubWorkspaceStatus> {
  const { root } = await requireLocalWorkspace(workspaceId);
  // The phone has no explicit refresh for status, so this read is always the
  // cached one. Codara's own writes (publish, mark ready, merge) drop the
  // entry, so the only staleness left is a change made outside this app
  // within the TTL.
  return readCachedGitHubWorkspaceStatus(root);
}

async function getGitHubWorkQueueForRemote(input: { refresh: boolean }) {
  if (input.refresh) invalidateGitHubWorkQueueGlobalCache();
  return readGitHubWorkQueue();
}

async function publishGitHubForRemote(input: {
  workspaceId: string;
  input: GitHubPublishInput;
}): Promise<GitHubPublishResult> {
  const { root } = await requireLocalWorkspace(input.workspaceId);
  return publishGitHubWorkspace(root, input.input);
}

async function markGitHubReadyForRemote(input: {
  workspaceId: string;
  input: GitHubMarkReadyInput;
}): Promise<GitHubMarkReadyResult> {
  const { root } = await requireLocalWorkspace(input.workspaceId);
  return markGitHubPullRequestReady(root, input.input);
}

async function mergeGitHubForRemote(input: {
  workspaceId: string;
  input: GitHubMergeInput;
}): Promise<GitHubMergeResult> {
  const { root } = await requireLocalWorkspace(input.workspaceId);
  return mergeGitHubPullRequest(root, input.input);
}

async function startGitHubIssueForRemote(
  input: StartGitHubIssueInput,
): Promise<StartGitHubIssueResult> {
  // The transaction resolves the source workspace locally and treats the
  // phone's issue number as the only selector; title, URL, branch, path, and
  // setup command are all authoritative desktop-side data.
  return startGitHubIssueWorkspace(input);
}

async function startGitHubPullRequestForRemote(
  input: StartGitHubPullRequestInput,
): Promise<StartGitHubPullRequestResult> {
  // The phone echoes only the queue's canonical repository and pinned head.
  // The desktop re-resolves both immediately before checkout and refuses a
  // moved head, so a delayed or replayed tap cannot silently import new code.
  return startGitHubPullRequestWorkspace(input);
}

async function getGitLogForRemote(input: {
  workspaceId: string;
  limit: number;
}): Promise<RemoteGitLog> {
  const { root } = await requireLocalWorkspace(input.workspaceId);
  const log = await readGitLog(root);
  const limit = Math.max(
    1,
    Math.min(MAX_GIT_LOG_COMMITS, Math.floor(input.limit)),
  );
  const commits: RemoteGitCommitSummary[] = [];
  let usedBytes = 2;

  for (const row of log.rows) {
    if (!row.hash) continue;
    const commit: RemoteGitCommitSummary = {
      hash: row.hash,
      shortHash: row.shortHash || row.hash.slice(0, 7),
      subject: truncateUtf8(row.subject || "", 2000),
      author: truncateUtf8(row.author || "", 500),
      relativeDate: truncateUtf8(row.relativeDate || "", 240),
      parentHashes: (row.parentHashes || []).slice(0, 16),
      refs: (row.refs || []).slice(0, 24).map((ref) => truncateUtf8(ref, 500)),
      isHead: row.isHead === true,
    };
    const bytes = Buffer.byteLength(JSON.stringify(commit), "utf8") + 1;
    if (usedBytes + bytes > COLLECTION_BUDGET_BYTES) break;
    commits.push(commit);
    usedBytes += bytes;
    if (commits.length >= limit) break;
  }

  return {
    isRepo: log.isRepo,
    commits,
    ...(log.error ? { error: truncateUtf8(log.error, 1000) } : {}),
  };
}

async function getGitCommitDetailForRemote(input: {
  workspaceId: string;
  hash: string;
}): Promise<RemoteGitCommitDetail> {
  if (!/^[0-9a-f]{7,64}$/i.test(input.hash)) {
    throw new Error("Commit hash must be hexadecimal.");
  }
  const { root } = await requireLocalWorkspace(input.workspaceId);
  const result = await readGitCommitDetail(root, input.hash);
  if (!result.ok) throw new Error(truncateUtf8(result.error, 1000));

  const detail = result.detail;
  const base: Omit<RemoteGitCommitDetail, "files"> = {
    hash: detail.hash,
    shortHash: detail.shortHash || detail.hash.slice(0, 7),
    subject: truncateUtf8(detail.subject, 2000),
    body: truncateUtf8(detail.body, GIT_COMMIT_BODY_MAX_BYTES),
    author: truncateUtf8(detail.author, 500),
    authorEmail: truncateUtf8(detail.authorEmail, 500),
    relativeDate: truncateUtf8(detail.relativeDate, 240),
    isoDate: truncateUtf8(detail.isoDate, 100),
    parentHashes: detail.parentHashes.slice(0, 16),
    refs: detail.refs.slice(0, 24).map((ref) => truncateUtf8(ref, 500)),
    isHead: false,
  };
  const files: RemoteGitCommitFile[] = [];
  let usedBytes = Buffer.byteLength(
    JSON.stringify({ ...base, files: [] }),
    "utf8",
  );
  for (const file of detail.files) {
    if (files.length >= MAX_GIT_COMMIT_FILES) break;
    const item: RemoteGitCommitFile = {
      path: truncateUtf8(file.path, 4096),
      ...(file.oldPath ? { oldPath: truncateUtf8(file.oldPath, 4096) } : {}),
      status: file.status,
      additions: Math.max(0, file.additions),
      deletions: Math.max(0, file.deletions),
    };
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (usedBytes + bytes > COLLECTION_BUDGET_BYTES) break;
    files.push(item);
    usedBytes += bytes;
  }

  return { ...base, files };
}

async function listCoraHistoryForRemote(
  workspaceId: string,
): Promise<RemoteCoraRunSummary[]> {
  await requireLocalWorkspace(workspaceId);
  const runs = await listRuns(workspaceId);
  // Automation passes have their own list/detail/history RPCs. Keeping them
  // out here makes "conversation history" true at the data boundary instead
  // of making every client download them and remember to hide them.
  const sliced = selectRemoteConversationRuns(runs, MAX_CORA_RUNS);
  // One job-store read joined against the whole page, only when an automation
  // run is actually present.
  const join = sliced.some((run) => run.automationId)
    ? buildAutomationJoin(await listJobs().catch(() => [] as ScheduledJob[]))
    : () => undefined;
  const candidates: RemoteCoraRunSummary[] = [];
  for (const run of sliced) {
    let summary: RemoteCoraRunSummary;
    try {
      summary = toRemoteRunSummary(run, join(run));
    } catch {
      // One hand-edited/legacy identity must not make every healthy history
      // row disappear. Detail requests for the malformed run still fail
      // explicitly at the same validation boundary.
      continue;
    }
    candidates.push(summary);
  }
  return takeJsonArrayPrefixWithinBudget(
    candidates,
    CORA_HISTORY_RUNS_JSON_MAX_BYTES,
  );
}

async function getCoraRunForRemote(input: {
  workspaceId: string;
  runId: string;
  afterCursor?: string;
}): Promise<RemoteCoraRunProjection> {
  await requireLocalWorkspace(input.workspaceId);
  const run = await requireOwnedRun(input.workspaceId, input.runId);
  return projectCoraRunForRemote(run, input.afterCursor);
}

async function getCoraGraphForRemote(input: {
  workspaceId: string;
  runId: string;
}): Promise<RemoteCoraRun> {
  await requireLocalWorkspace(input.workspaceId);
  const run = await requireOwnedRun(input.workspaceId, input.runId);
  // Deliberately bypass the message-window projector. This route exists for
  // the graph, so sending a 400 KiB transcript after a pass tap would undo the
  // mobile data savings that the bounded step/worker projection provides.
  return toRemoteRun(run, await automationJoinForRun(run), []);
}

async function projectCoraRunForRemote(
  run: RunState,
  afterCursor?: string,
): Promise<RemoteCoraRunProjection> {
  const runId = requireRemoteCoraIdentity(run.id, "run.id");
  const base = toRemoteRun(run, await automationJoinForRun(run), []);
  const sourceMessages = remoteCoraSourceMessages(run);
  return projectBoundedRemoteCoraRun({
    base,
    runId,
    conversationEpoch: run.conversationEpoch ?? 0,
    sourceMessages,
    projectMessage: toRemoteCoraMessage,
    ...(afterCursor !== undefined ? { afterCursor } : {}),
    maxMessageCount: MAX_CORA_MESSAGES,
    maxMessageBytes: COLLECTION_BUDGET_BYTES,
  });
}

async function deleteCoraRunForRemote(input: {
  workspaceId: string;
  runId: string;
}): Promise<void> {
  await requireLocalWorkspace(input.workspaceId);
  const run = await getRun(input.runId);
  // Deletion is intentionally idempotent. A phone can lose the successful
  // reply, reconnect, and retry after the run directory is already gone.
  // A run owned by another workspace is treated as absent and never touched.
  if (!run || run.workspaceId !== input.workspaceId) return;
  await deleteRun(run.id);
}

// Stop means stop in place — the same host call as Studio's own Stop button
// (orchestration:forcePauseRun). Chat turns and completed workspace changes
// survive; rewinding stays an explicit desktop-only Undo.
async function forcePauseCoraRunForRemote(input: {
  workspaceId: string;
  runId: string;
}): Promise<void> {
  await requireLocalWorkspace(input.workspaceId);
  const run = await requireOwnedRun(input.workspaceId, input.runId);
  await forcePauseRun(run.id);
}

// DUPLICATE DELIVERY IS NOT FREE. Unlike the stop above, a second resume of an
// already-running run re-commits run.resumed: it resets verification rounds and
// re-signals live workers. There is deliberately no requestId and no mutation
// ledger here, so the client must not blind-retry this call after a lost reply
// — re-poll cora.get and read the run's status instead.
async function resumePausedCoraRunForRemote(input: {
  workspaceId: string;
  runId: string;
}): Promise<void> {
  await requireLocalWorkspace(input.workspaceId);
  const run = await requireOwnedRun(input.workspaceId, input.runId);
  await resumeRun({ runId: run.id });
}

// DUPLICATE DELIVERY IS NOT FREE, and here it would cost a whole user turn:
// undoToCheckpoint deletes the messages after the checkpoint, so a blind retry
// of a lost reply peels off the message BEFORE the one the operator meant.
// There is no requestId and no mutation ledger; what stands in for one is the
// checkpoint token. The caller must send back the exact id the run's `undo`
// field published, and this refuses anything else — a second delivery, a
// double tap, or a tap composed against a poll that has since moved arrives
// pointing at a checkpoint that is no longer the target, and is refused
// without touching the run. Clients still re-poll cora.get rather than retry.
//
// Scope is "chat" and only ever "chat": rewinding the workspace tree is a
// desktop decision made in front of a diff, never a phone tap.
async function undoCoraRunForRemote(input: {
  workspaceId: string;
  runId: string;
  checkpointId: string;
}): Promise<{ restoredText?: string }> {
  await requireLocalWorkspace(input.workspaceId);
  const run = await requireOwnedRun(input.workspaceId, input.runId);
  const target = remoteCoraUndoTarget(run);
  if (!target || target.checkpointId !== input.checkpointId) {
    throw Object.assign(new Error("This message can no longer be undone."), {
      code: "CORA_UNDO_STALE_CHECKPOINT",
    });
  }
  const { restoredText } = await undoToCheckpoint({
    runId: run.id,
    checkpointId: target.checkpointId,
    scope: "chat",
  });
  return restoredText === null ? {} : { restoredText };
}

async function sendCoraMessageForRemote(input: {
  workspaceId: string;
  runId?: string;
  message: string;
  clientMessageId: string;
  afterCursor?: string;
  model?: string;
  effort?: RemoteCoraThinkingLevel;
}): Promise<RemoteCoraRunProjection> {
  const { workspace, root } = await requireLocalWorkspace(input.workspaceId);
  const message = normalizeCoraMessage(input.message);
  const clientMessageId = input.clientMessageId.trim();
  if (!clientMessageId || Buffer.byteLength(clientMessageId, "utf8") > 256) {
    throw new Error("clientMessageId is invalid.");
  }
  const model = input.model?.trim();
  const provider = providerForRemoteModel(model);
  if (model && !provider) {
    throw new Error("That Cora model is not supported.");
  }

  const mutationKey = input.runId
    ? JSON.stringify([workspace.id, input.runId])
    : JSON.stringify([workspace.id, "new", clientMessageId]);
  return coraRunMutations.run(mutationKey, async () => {
    const receiptInput = {
      workspaceId: workspace.id,
      ...(input.runId ? { runId: input.runId } : {}),
      message,
      clientMessageId,
    };
    const receipts = await getCoraSendReceiptIndex();
    // A normal retry or a restart reads exactly the indexed run. The receipt
    // stores identities + a message digest only; the authoritative message in
    // run.json still decides whether this is the same request.
    let retry: RunState | undefined =
      (await receipts.resolve(receiptInput, getRun)) ?? undefined;
    let existing: RunState | undefined;
    if (!retry && input.runId) {
      // Existing-conversation first deliveries already identify the only run
      // that may be mutated. This O(1) authoritative read also repairs a
      // missing legacy receipt without touching sibling run bodies.
      existing = await requireOwnedRun(workspace.id, input.runId);
      retry = findRemoteCoraRetry([existing], receiptInput);
    } else if (!retry) {
      // A legacy or crash-window new-conversation retry has no run id. Inspect
      // the run files WRITTEN inside the repair window once, then persist the
      // repaired O(1) route. Old retained runs fall outside that window instead
      // of consuming the read ceiling, so a workspace that has simply
      // accumulated history can no longer refuse a first send.
      const repair = await repairCoraRetryFromRunWindow(receiptInput, {
        runsRoot: runsRoot(),
        loadRun: getRun,
      });
      retry = repair.run;
      if (!retry && repair.truncated) {
        // Only reachable when the window ITSELF overflowed the read ceiling,
        // i.e. an older delivery inside the crash window may sit beyond the
        // explicit repair bound. Starting a second run would be a guess; ask
        // for a retry once the window has drained instead.
        throw new Error(
          "Could not safely reconcile this Cora retry key within the retained run window. Please retry.",
        );
      }
    }
    if (retry) {
      await receipts.record(receiptInput, retry.id);
      return projectCoraRunForRemote(retry, input.afterCursor);
    }

    let run: RunState;
    if (!input.runId) {
      run = await startAutopilot({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        cwd: root,
        initialUserNote: message,
        initialUserNoteClientMessageId: clientMessageId,
        chatBackend: "pi",
        ...(model ? { chatModel: model } : {}),
        ...(input.effort ? { chatEffort: input.effort as AgentEffortLevel } : {}),
      });
    } else {
      existing ??= await requireOwnedRun(workspace.id, input.runId);
      if (existing.automationId) {
        throw new Error("Automation-owned runs cannot be continued as Cora chats.");
      }
      if (model || input.effort) {
        existing = await updateChatBackend({
          runId: existing.id,
          chatBackend: "pi",
          ...(model ? { chatModel: model } : {}),
          ...(input.effort ? { chatEffort: input.effort as AgentEffortLevel } : {}),
        });
      }
      run = existing.blockedOn?.questionMessageId
        ? await answerRunQuestion({
            runId: existing.id,
            questionMessageId: existing.blockedOn.questionMessageId,
            message,
            clientMessageId,
          })
        : await addRunMessage({
            runId: existing.id,
            author: "user",
            kind: "note",
            message,
            clientMessageId,
          });
    }
    // Commit the compact route before replying. A lost reply can now recover
    // after restart with one run read and no full-run mutation result ledger.
    await receipts.record(receiptInput, run.id);
    return projectCoraRunForRemote(run, input.afterCursor);
  });
}

async function requireOwnedRun(
  workspaceId: string,
  runId: string,
): Promise<RunState> {
  const run = await getRun(runId);
  if (!run || run.workspaceId !== workspaceId) {
    throw new Error(`Cora run not found in this workspace: ${runId}`);
  }
  return run;
}

// Owning-automation identity resolved from the scheduler's job store — the
// run record itself only carries the automation id.
interface RemoteAutomationJoin {
  name?: string;
  iteration?: number;
}

function automationJoinFromJob(
  job: ScheduledJob | undefined,
  run: RunState,
): RemoteAutomationJoin | undefined {
  if (!job) return undefined;
  // Latest matching record wins: iteration alone collides across loop cycles
  // ("Run now" resets the counter while history is retained), so scan by runId
  // and keep the newest entry.
  let iteration: number | undefined;
  for (const record of job.history) {
    if (record.runId === run.id) iteration = record.iteration;
  }
  return { name: job.name, ...(iteration !== undefined ? { iteration } : {}) };
}

// One listJobs() pass shared by a whole history listing — a 50-run history
// must not hit the job store once per run.
function buildAutomationJoin(
  jobs: ScheduledJob[],
): (run: RunState) => RemoteAutomationJoin | undefined {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  return (run) =>
    run.automationId
      ? automationJoinFromJob(byId.get(run.automationId), run)
      : undefined;
}

async function automationJoinForRun(
  run: RunState,
): Promise<RemoteAutomationJoin | undefined> {
  if (!run.automationId) return undefined;
  const job = await getJob(run.automationId).catch(() => undefined);
  return automationJoinFromJob(job ?? undefined, run);
}

const REMOTE_CORA_RUN_STATUSES = new Set<RemoteCoraRun["status"]>([
  "idle",
  "planning",
  "running",
  "reviewing",
  "blocked",
  "paused",
  "complete",
  "failed",
  "cancelled",
]);
const REMOTE_CORA_MESSAGE_AUTHORS = new Set<RemoteCoraMessage["author"]>([
  "user",
  "cora",
  "system",
]);
const REMOTE_CORA_MESSAGE_KINDS = new Set<RemoteCoraMessage["kind"]>([
  "note",
  "question",
  "answer",
  "decision",
  "assistant_stream",
]);
const REMOTE_CORA_MESSAGE_DELIVERY_STATES = new Set<
  NonNullable<RemoteCoraMessage["deliveryState"]>
>(["queued", "submitted", "acknowledged", "cancelled"]);
const REMOTE_CORA_MESSAGE_INTENTS = new Set<
  NonNullable<RemoteCoraMessage["intent"]>
>(["turn", "steer", "answer"]);
const REMOTE_CORA_WORKER_STATUSES = new Set<RemoteCoraWorker["status"]>([
  "preparing",
  "prompt_ready",
  "launching",
  "running",
  "finishing",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);
const REMOTE_CORA_WORKER_RUNTIMES = new Set([
  "claude",
  "codex",
  "shell",
  "manual",
] as const);
const REMOTE_CORA_STEP_STATUSES = new Set<RemoteCoraStep["status"]>([
  "queued",
  "planning",
  "ready",
  "running",
  "reviewing",
  "complete",
  "completed_unverified",
  "blocked",
  "failed",
  "skipped",
]);

function remoteCoraRecoverySummary(
  run: RunState,
): RemoteCoraRunSummary["recovery"] {
  const recovery = run.managerTurnRecovery;
  if (
    !recovery ||
    run.automationId ||
    (recovery.failureKind !== "provider" &&
      recovery.failureKind !== "transport" &&
      recovery.failureKind !== "rate_limit") ||
    !isRemoteCoraTimestamp(recovery.parkedAt)
  ) {
    return undefined;
  }
  return {
    cause:
      recovery.failureKind === "provider"
        ? "provider_unavailable"
        : recovery.failureKind === "transport"
          ? "connection"
          : "rate_limit",
    parkedAt: recovery.parkedAt,
  };
}

function toRemoteRunSummary(
  run: RunState,
  automation?: RemoteAutomationJoin,
): RemoteCoraRunSummary {
  const id = requireRemoteCoraIdentity(run.id, "run.id");
  const workspaceId = requireRemoteCoraIdentity(
    run.workspaceId,
    "run.workspaceId",
  );
  if (!isOneOf(run.status, REMOTE_CORA_RUN_STATUSES)) {
    throw new TypeError("run.status is not a supported remote Cora status.");
  }
  const createdAt = requireRemoteCoraTimestamp(run.createdAt, "run.createdAt");
  const updatedAt = requireRemoteCoraTimestamp(run.updatedAt, "run.updatedAt");
  const projectedMessages = remoteCoraSourceMessages(run);
  const lastMessage = projectedMessages.at(-1)?.message;
  // Honest split: costUsd carries ONLY measured spend (metered manager calls
  // plus worker attempts whose transport reported real cost); the placeholder
  // estimate for unmeasured attempts travels apart as estimatedCostUsd. The
  // rollup guarantees the two never cover the same attempt.
  const computedCostUsd =
    run.totalCostUsd !== undefined || run.measuredWorkerCostUsd !== undefined
      ? (run.totalCostUsd ?? 0) + (run.measuredWorkerCostUsd ?? 0)
      : undefined;
  const costUsd = Number.isFinite(computedCostUsd)
    ? computedCostUsd
    : undefined;
  const estimatedCostUsd = Number.isFinite(run.estimatedWorkerCostUsd)
    ? run.estimatedWorkerCostUsd
    : undefined;
  // Model chip for automation rows: the newest attempt's resolved model wins
  // (what actually launched), else the newest task's hint (what will launch).
  const automationModel = run.automationId
    ? [...run.workerAttempts].reverse().find((attempt) => attempt.model)
        ?.model ||
      [...run.workerTasks].reverse().find((task) => task.modelHint)?.modelHint
    : undefined;
  const displayedModel =
    automationModel || (!run.automationId ? run.chatModel : undefined);
  const automationIteration = automation?.iteration;
  const automationId = run.automationId
    ? requireRemoteCoraIdentity(run.automationId, "run.automationId")
    : undefined;
  return {
    id,
    workspaceId,
    title: truncateUtf8(typeof run.title === "string" ? run.title : "", 512),
    status: run.status,
    createdAt,
    updatedAt,
    messageCount: projectedMessages.length,
    ...(typeof lastMessage === "string" && lastMessage
      ? { lastMessage: truncateUtf8(lastMessage, 512) }
      : {}),
    activeWorkers: run.workerAttempts.filter((attempt) =>
      ACTIVE_WORKER_ATTEMPT_STATUSES.has(attempt.status),
    ).length,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(estimatedCostUsd ? { estimatedCostUsd } : {}),
    ...(automationId
      ? { automated: true, automationId }
      : {}),
    ...(automationId && automation?.name
      ? { automationName: truncateUtf8(automation.name, 200) }
      : {}),
    ...(automationId &&
    Number.isSafeInteger(automationIteration) &&
    automationIteration! >= 0
      ? { iteration: automationIteration }
      : {}),
    ...(typeof displayedModel === "string" && displayedModel
      ? { model: truncateUtf8(displayedModel, 120) }
      : {}),
    ...(!run.automationId && run.chatEffort
      ? { effort: run.chatEffort as RemoteCoraThinkingLevel }
      : {}),
    ...(remoteCoraRecoverySummary(run)
      ? { recovery: remoteCoraRecoverySummary(run) }
      : {}),
  };
}

// Worker roster for the phone's run header: active attempts first, then the
// most recent settled ones, capped so a long run cannot bloat every poll.
function toRemoteRunWorkers(run: RunState): {
  workers: RemoteCoraWorker[];
  total: number;
  /**
   * How many still-running attempts did not make the roster. Zero on every
   * ordinary run, however long: actives are placed first and only the settled
   * tail is trimmed. It is only non-zero when there are genuinely more live
   * workers than the roster can carry, which is the one case a remote client
   * cannot reconstruct a step's live fan from what it received.
   */
  activeOmitted: number;
} {
  const tasks = new Map(run.workerTasks.map((task) => [task.id, task]));
  const toWorker = (
    attempt: RunState["workerAttempts"][number],
  ): RemoteCoraWorker | undefined => {
    const task = tasks.get(attempt.workerTaskId);
    if (
      !isRemoteCoraIdentity(attempt.id) ||
      !isOneOf(attempt.status, REMOTE_CORA_WORKER_STATUSES) ||
      !isOneOf(attempt.runtime, REMOTE_CORA_WORKER_RUNTIMES)
    ) {
      return undefined;
    }
    // The attempt only records a model once the launch resolved one; before
    // that (and for legacy attempts) the owning task's hint is what Studio
    // itself displays, so the phone gets the same fallback.
    const model = attempt.model || task?.modelHint;
    return {
      id: attempt.id,
      ...(typeof task?.stepId === "string" && isRemoteCoraIdentity(task.stepId)
        ? { stepId: task.stepId }
        : {}),
      title: truncateUtf8(
        typeof task?.title === "string" && task.title ? task.title : "Worker",
        300,
      ),
      runtime: attempt.runtime,
      ...(typeof model === "string" && model
        ? { model: truncateUtf8(model, 120) }
        : {}),
      ...(typeof task?.effortHint === "string" && task.effortHint
        ? { effort: truncateUtf8(task.effortHint, 40) }
        : {}),
      status: attempt.status,
      ...(isRemoteCoraTimestamp(attempt.startedAt)
        ? { startedAt: attempt.startedAt }
        : {}),
      ...(isRemoteCoraTimestamp(attempt.finishedAt)
        ? { finishedAt: attempt.finishedAt }
        : {}),
      ...(typeof attempt.runtimeState === "string" && attempt.runtimeState
        ? { runtimeState: truncateUtf8(attempt.runtimeState, 200) }
        : {}),
      // Live tool-call readout. It is already capped at 120 chars where it is
      // written, so this only guards a legacy or hostile attempt record.
      ...(typeof attempt.runtimeActivity === "string" &&
      attempt.runtimeActivity.trim()
        ? { runtimeActivity: truncateUtf8(attempt.runtimeActivity.trim(), 120) }
        : {}),
      // Peer-group membership, the same predicate the desktop graph draws its
      // team thread from (renderer graph-layout.ts): the task recorded the
      // group-chat outcome AND was not asked to be independent, since
      // `isolated` beats an explicit flag everywhere else too. Omitted rather
      // than sent as `false` — the default is off, so the empty case must cost
      // nothing on a roster that ships on every poll.
      ...(task?.peerComms === true && task?.isolated !== true
        ? { peerComms: true as const }
        : {}),
    };
  };
  const active = run.workerAttempts.filter((attempt) =>
    ACTIVE_WORKER_ATTEMPT_STATUSES.has(attempt.status),
  );
  const settled = run.workerAttempts.filter(
    (attempt) => !ACTIVE_WORKER_ATTEMPT_STATUSES.has(attempt.status),
  );
  // slice(-0) would return the whole array, so the settled fill is guarded.
  const settledBudget = Math.max(0, MAX_CORA_RUN_WORKERS - active.length);
  const recentSettled = settledBudget > 0 ? settled.slice(-settledBudget) : [];
  const projected = [...active, ...recentSettled]
    .slice(0, MAX_CORA_RUN_WORKERS)
    .map(toWorker)
    .filter((worker): worker is RemoteCoraWorker => worker !== undefined);
  const bounded: RemoteCoraWorker[] = [];
  let usedBytes = 2;
  for (const worker of projected) {
    const bytes = Buffer.byteLength(JSON.stringify(worker), "utf8") + 1;
    if (usedBytes + bytes > CORA_WORKER_ROSTER_MAX_BYTES) break;
    bounded.push(worker);
    usedBytes += bytes;
  }
  // Counted from the rows that survived rather than from the cap, so every way
  // an active attempt can fall out is caught at once: the roster cap, the byte
  // bound, and toWorker rejecting a malformed attempt record outright.
  const rosterIds = new Set(bounded.map((worker) => worker.id));
  const activeOmitted = Math.max(
    0,
    active.filter((attempt) => !rosterIds.has(attempt.id)).length,
  );
  return { workers: bounded, total: run.workerAttempts.length, activeOmitted };
}

// Steps a step will never leave: the plan progress line counts all three as
// finished so a skipped step cannot stall the count at "3 of 5" forever.
const FINISHED_STEP_STATUSES = new Set([
  "complete",
  "completed_unverified",
  "skipped",
]);

// Plan progress for the phone's run header. The list is capped but the totals
// are computed over the whole plan, so a long plan still reports honestly.
function toRemoteRunSteps(run: RunState): {
  steps: RemoteCoraStep[];
  total: number;
  finished: number;
} {
  const ordered = [...run.steps].sort(
    (left, right) => left.index - right.index,
  );
  return {
    steps: ordered
      .slice(0, MAX_CORA_RUN_STEPS)
      .filter((step) => isOneOf(step.status, REMOTE_CORA_STEP_STATUSES))
      .map((step) => ({
        ...(isRemoteCoraIdentity(step.id) ? { id: step.id } : {}),
        title: truncateUtf8(
          typeof step.title === "string" ? step.title : "",
          300,
        ),
        status: step.status,
      })),
    total: ordered.length,
    finished: ordered.filter((step) => FINISHED_STEP_STATUSES.has(step.status))
      .length,
  };
}

// The board nudge and the pause-resume note are authored "user" only so the
// next manager turn consumes them as its input; their bodies are lists of card
// titles and attempt ids, never the person's own words. Studio's own timeline
// demotes both to quiet system rows (buildChatTimeline), and so does this
// projection — which also means neither may ever be an undo target.
function isSyntheticCoraNote(
  message: RunState["humanMessages"][number],
): boolean {
  return message.boardNote === true || message.resumeNote === true;
}

function toRemoteCoraMessage(
  message: RunState["humanMessages"][number],
): RemoteCoraMessage {
  // A synthetic note stays in the transcript — the reader still needs to see
  // that the board handed Cora work, or that a resume did — and the wire enum
  // already carries "system", so this is a projection choice and not a
  // contract change.
  const syntheticNote = isSyntheticCoraNote(message);
  const author = syntheticNote
    ? "system"
    : message.author === "spark"
      ? "cora"
      : message.author;
  if (!isOneOf(author, REMOTE_CORA_MESSAGE_AUTHORS)) {
    throw new TypeError("message.author is not a supported remote Cora author.");
  }
  if (!isOneOf(message.kind, REMOTE_CORA_MESSAGE_KINDS)) {
    throw new TypeError("message.kind is not a supported remote Cora kind.");
  }
  // Delivery state and intent are copied, never inferred: a message the run
  // store left unlabelled (Cora's own prose, an older run's history) sends no
  // key at all, which the phone reads as ordinary delivered history. Together
  // they cost at most 49 bytes on a user message and nothing on Cora's, well
  // inside the message window's byte budget.
  //
  // SHIP TOGETHER, NOT MERELY IN THE SAME TASK. The phone's message validator
  // rejects unknown KEYS outright (hasOnlyKeys over MESSAGE_KEYS), and these
  // land on essentially every user message, so a phone built before the mirror
  // would refuse every projection this Studio sends and show a permanently
  // blank chat on every run. The mirror is in the same commit pair for exactly
  // this reason; never release one side alone.
  //
  // HOW A CHANGE OF STATE REACHES A PHONE ON THE DELTA PATH: the message cursor
  // digests the full JSON of every message in the window it was issued for
  // (buildCursor, cora-run-message-window.ts), so mutating a message ALREADY
  // sent invalidates that cursor and the next poll receives the whole window
  // instead of an append. That is the only delivery mechanism for an in-place
  // edit — the append delta carries new messages only — and it is why
  // deliveryState may live on the message rather than in a side channel.
  return {
    id: requireRemoteCoraIdentity(message.id, "message.id"),
    author,
    kind: message.kind,
    message: truncateUtf8(publicRemoteCoraMessage(message), 16 * 1024),
    createdAt: requireRemoteCoraTimestamp(
      message.createdAt,
      "message.createdAt",
    ),
    ...(isOneOf(message.deliveryState, REMOTE_CORA_MESSAGE_DELIVERY_STATES)
      ? { deliveryState: message.deliveryState }
      : {}),
    ...(isOneOf(message.intent, REMOTE_CORA_MESSAGE_INTENTS)
      ? { intent: message.intent }
      : {}),
  };
}

const LEGACY_CORA_BACKEND_FAILURE =
  /^(Codex|Claude Code|Cora Pi) backend error:\s*(.+)$/is;

function legacyCoraBackendFailureDetail(
  message: RunState["humanMessages"][number],
): string | null {
  if (message.author !== "spark" || typeof message.message !== "string") {
    return null;
  }
  return LEGACY_CORA_BACKEND_FAILURE.exec(message.message.trim())?.[2]?.trim() ?? null;
}

/**
 * Legacy builds wrote raw provider envelopes into Cora dialogue. Remote and
 * mobile projections never need request ids, response bodies, paths, or token
 * fragments, so collapse those records to a small evidence-based sentence.
 */
function publicRemoteCoraMessage(
  message: RunState["humanMessages"][number],
): string {
  const raw = typeof message.message === "string" ? message.message : "";
  const detail = legacyCoraBackendFailureDetail(message);
  if (!detail) return raw;
  const normalized = detail.replace(/[_-]+/g, " ");
  if (
    /not authenticated|no OAuth access token|OAuth (?:refresh failed|session expired)|token (?:has )?expired|invalid api key|missing api key|unauthori[sz]ed|(?:status|code|error|http)[^A-Za-z0-9]{0,10}(?:401|403)\b|authentication failed|please (?:run )?\/?login|log ?in (?:again|required)|credentials?(?: are)? (?:invalid|missing|expired)/i.test(
      normalized,
    )
  ) {
    return "Cora could not authenticate the selected provider account. Reconnect it in Studio, then retry.";
  }
  if (
    /rate ?limit|(?:status|code|error|http)[^A-Za-z0-9]{0,10}429\b|too many requests|insufficient quota|quota (?:exceeded|exhausted|reached|hit)|usage limit/i.test(
      normalized,
    )
  ) {
    return "The selected provider account reached its usage limit. Switch accounts or retry after quota resets.";
  }
  if (
    /(?:status|code|error|http)[^A-Za-z0-9]{0,10}(?:500|502|503|504|529)\b|overloaded|capacity|high demand|servers? (?:are )?(?:too )?busy|temporarily unavailable|service unavailable/i.test(
      normalized,
    )
  ) {
    return "The provider is temporarily unavailable or at capacity. Retry shortly or switch accounts.";
  }
  if (/socket|connection|ECONN|EPIPE|network|fetch failed|websocket/i.test(normalized)) {
    return "Studio lost the provider connection. Retry when the connection is stable.";
  }
  return "Cora could not complete this provider turn. Retry from Studio.";
}

function remoteCoraSourceMessages(run: RunState): RunState["humanMessages"] {
  return run.humanMessages
    .filter(
      (message) =>
        !run.managerTurnRecovery || legacyCoraBackendFailureDetail(message) === null,
    )
    .map((message) => ({
      ...message,
      message: publicRemoteCoraMessage(message),
    }));
}

/**
 * The one chat rewind this run affords right now, or undefined.
 *
 * A faithful port of the desktop pill's `latestUndoableCheckpoint`
 * (ChatConversation.tsx): find the genuinely-LAST user message, then the
 * `user-message` checkpoint that names it. Both halves of that order matter,
 * and they are the renderer's reasons, kept here verbatim:
 *
 *   1. "Undo my last message" is the only mental model that does not surprise
 *      — one tap peels off exactly one user turn, and successive taps keep
 *      walking backwards.
 *   2. Checkpoints land a tick late, in the background. Matching "the latest
 *      checkpoint that has a message" instead would briefly point at the
 *      PREVIOUS user message right after a send, and a tap there would wipe
 *      two messages instead of one.
 *
 * The scan reads raw authorship, exactly as the renderer does, which is what
 * makes a synthetic note (board nudge / pause-resume note) SUPPRESS the
 * affordance while it is last rather than shifting it onto the real message
 * underneath: those notes are queued manager input, and a rewind past one
 * would silently drop work the board handed over. They can never be targets
 * either — no checkpoint is ever recorded for them, since they are pushed
 * straight into a commit rather than through addRunMessage — and the explicit
 * guard below says so rather than leaving it to that coincidence.
 */
function remoteCoraUndoTarget(
  run: RunState,
): { checkpointId: string; messageId: string } | undefined {
  let lastUserMessage: RunState["humanMessages"][number] | undefined;
  for (let index = run.humanMessages.length - 1; index >= 0; index -= 1) {
    if (run.humanMessages[index].author === "user") {
      lastUserMessage = run.humanMessages[index];
      break;
    }
  }
  if (!lastUserMessage || isSyntheticCoraNote(lastUserMessage)) return undefined;
  const messageId = lastUserMessage.id;
  const checkpoint = (run.checkpoints ?? []).find(
    (entry) => entry.kind === "user-message" && entry.messageId === messageId,
  );
  if (
    !checkpoint ||
    !isRemoteCoraIdentity(checkpoint.id) ||
    !isRemoteCoraIdentity(messageId)
  ) {
    return undefined;
  }
  return { checkpointId: checkpoint.id, messageId };
}

function toRemoteRun(
  run: RunState,
  automation?: RemoteAutomationJoin,
  messages: RemoteCoraMessage[] = [],
): RemoteCoraRun {
  const workerProjection = toRemoteRunWorkers(run);
  const workers = workerProjection.workers;
  const plan = toRemoteRunSteps(run);
  const boardCards = run.board?.cards.length ?? 0;
  const whiteboardNodes = run.whiteboard?.nodes.length ?? 0;
  const blockedMessage = run.blockedOn
    ? run.humanMessages.find(
        (message) => message.id === run.blockedOn?.questionMessageId,
      )
    : undefined;
  const accountProfileId =
    typeof run.chatAccountProfileId === "string" &&
    ACCOUNT_PROFILE_ID_PATTERN.test(run.chatAccountProfileId)
      ? run.chatAccountProfileId
      : undefined;
  const backend =
    run.chatBackend === "claude" || run.chatBackend === "codex"
      ? run.chatBackend
      : run.chatBackend === "pi" || run.chatBackend === undefined
        ? "pi"
        : undefined;
  const nativeAccountProfileId =
    backend === "claude" &&
    typeof run.nativeClaudeProfileId === "string" &&
    NATIVE_CLI_PROFILE_ID_PATTERN.test(run.nativeClaudeProfileId)
      ? run.nativeClaudeProfileId
      : backend === "codex" &&
          typeof run.nativeCodexProfileId === "string" &&
          NATIVE_CLI_PROFILE_ID_PATTERN.test(run.nativeCodexProfileId)
        ? run.nativeCodexProfileId
        : undefined;
  const recoverySummary = remoteCoraRecoverySummary(run);
  const failedRecoveryAccount = run.managerTurnRecovery?.failedAccountProfileId;
  const recovery =
    run.managerTurnRecovery &&
    recoverySummary &&
    isRemoteCoraIdentity(run.managerTurnRecovery.id) &&
    (run.managerTurnRecovery.state === "parked" ||
      run.managerTurnRecovery.state === "resuming")
      ? {
          ...recoverySummary,
          id: run.managerTurnRecovery.id,
          state: run.managerTurnRecovery.state,
          ...(failedRecoveryAccount &&
          (ACCOUNT_PROFILE_ID_PATTERN.test(failedRecoveryAccount) ||
            NATIVE_CLI_PROFILE_ID_PATTERN.test(failedRecoveryAccount))
            ? { failedAccountProfileId: failedRecoveryAccount }
            : {}),
        }
      : undefined;
  const {
    recovery: _summaryRecovery,
    ...summary
  } = toRemoteRunSummary(run, automation);
  const projectedBlockedMessage = blockedMessage
    ? toRemoteCoraMessage(blockedMessage)
    : undefined;
  const context = remoteCoraRunContext(run);
  const undo = remoteCoraUndoTarget(run);
  const workersOmitted = Math.max(0, workerProjection.total - workers.length);
  const stepsOmitted = Math.max(0, plan.total - plan.steps.length);
  const blockedQuestionBodyTruncated = Boolean(
    blockedMessage &&
      projectedBlockedMessage &&
      blockedMessage.message !== projectedBlockedMessage.message,
  );
  const truncation = {
    // The roster receipt and its breakdown travel together, zero included.
    // `workersOmitted` alone is the ordinary long-run shape — old finished
    // attempts scrolled off a window filled actives-first — and must not be
    // read as an incomplete live fan. A client deciding whether it holds one
    // has to tell "no live worker was dropped" from "this computer is too old
    // to say", and a field that vanished at zero would collapse those two into
    // the same silence. Nothing is emitted at all when nothing was omitted, so
    // the ordinary run still pays nothing. See RemoteCoraRunTruncation.
    ...(workersOmitted > 0
      ? {
          workersOmitted,
          activeWorkersOmitted: workerProjection.activeOmitted,
        }
      : {}),
    ...(stepsOmitted > 0 ? { stepsOmitted } : {}),
    ...(blockedQuestionBodyTruncated
      ? { blockedQuestionBodyTruncated: true as const }
      : {}),
  };
  return {
    ...summary,
    messages,
    ...(backend ? { backend } : {}),
    ...(backend === "pi" && accountProfileId ? { accountProfileId } : {}),
    ...(nativeAccountProfileId ? { nativeAccountProfileId } : {}),
    ...(recovery ? { recovery } : {}),
    ...(workers.length > 0 ? { workers } : {}),
    ...(isRemoteCoraIdentity(run.currentStepId)
      ? { currentStepId: run.currentStepId }
      : {}),
    ...(plan.total > 0
      ? {
          steps: plan.steps,
          stepsTotal: plan.total,
          stepsFinished: plan.finished,
        }
      : {}),
    ...(boardCards > 0 ? { boardCards } : {}),
    ...(whiteboardNodes > 0 ? { whiteboardNodes } : {}),
    ...(context ? { context } : {}),
    ...(undo ? { undo } : {}),
    ...(run.blockedOn && projectedBlockedMessage
      ? {
          blockedQuestion: {
            messageId: projectedBlockedMessage.id,
            message: projectedBlockedMessage.message,
          },
        }
      : {}),
    ...(Object.keys(truncation).length > 0 ? { truncation } : {}),
  };
}

async function listWorkerSessionsForRemote(input: {
  workspaceId: string;
  runtime: "claude" | "codex";
}): Promise<RemoteWorkerSessionInfo[]> {
  const { root } = await requireLocalWorkspace(input.workspaceId);
  const sessions = await listLocalWorkerSessions(input.runtime, root);
  return sessions.slice(0, MAX_REMOTE_WORKER_SESSIONS).map((session) => ({
    runtime: session.runtime,
    sessionId: session.sessionId,
    title: truncateUtf8(session.title, 512),
    updatedAt: session.updatedAt,
  }));
}

async function deleteWorkerSessionForRemote(input: {
  workspaceId: string;
  runtime: "claude" | "codex";
  sessionId: string;
  memoryScope: WorkerSessionMemoryScope;
}): Promise<RemoteWorkerSessionDeleteResult> {
  const { root } = await requireLocalWorkspace(input.workspaceId);
  // The phone knows a session id and a memory scope. Both file paths the
  // delete needs are re-derived from THIS workspace's own listing, so a paired
  // device can only ever reach sessions the workspace already offers to
  // resume, and deleteWorkerSession still cross-checks the transcript's own
  // recorded cwd before removing anything.
  // Keyed per RUNTIME, not per session: two deletes of different sessions
  // still rewrite the same provider history file, so serializing per session
  // id would let one read-modify-write clobber the other's removal.
  return fileMutations.run(
    JSON.stringify(["workerSession.delete", input.workspaceId, input.runtime]),
    async () => {
      const sessions = await listLocalWorkerSessions(input.runtime, root);
      const match = sessions.find(
        (session) => session.sessionId === input.sessionId,
      );
      if (!match) {
        throw new Error(
          "That session is no longer in this workspace's history.",
        );
      }
      const result = await deleteLocalWorkerSession({
        runtime: match.runtime,
        sessionId: match.sessionId,
        cwd: match.cwd,
        transcriptPath: match.transcriptPath,
        memoryScope: input.memoryScope,
      });
      return {
        deleted: result.deleted,
        memoryDeleted: result.memoryDeleted,
        memoryScope: result.memoryScope,
        warnings: result.warnings
          .slice(0, 4)
          .map((warning) => truncateUtf8(warning, 512)),
      };
    },
  );
}

/* ------------------------------------------------------ Cora whiteboard */

// A phone reads the whiteboard as a grouped list, so the canvas geometry is
// dropped at the boundary and only the semantic content crosses.
async function getCoraWhiteboardForRemote(input: {
  workspaceId: string;
  runId: string;
}): Promise<RemoteWhiteboard | null> {
  await requireLocalWorkspace(input.workspaceId);
  const run = await requireOwnedRun(input.workspaceId, input.runId);
  const board = run.whiteboard;
  if (!board) return null;

  let usedBytes = 2;
  let truncated = false;
  const nodes: RemoteWhiteboardNode[] = [];
  for (const node of board.nodes.slice(0, MAX_REMOTE_WHITEBOARD_NODES)) {
    const item: RemoteWhiteboardNode = {
      id: node.id,
      kind: node.kind,
      title: truncateUtf8(node.title, 300),
      ...(node.body ? { body: truncateUtf8(node.body, 2000) } : {}),
      ...(node.tone ? { tone: node.tone } : {}),
    };
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (usedBytes + bytes > COLLECTION_BUDGET_BYTES) {
      truncated = true;
      break;
    }
    nodes.push(item);
    usedBytes += bytes;
  }
  if (nodes.length < board.nodes.length) truncated = true;

  // Only edges whose endpoints both survived the node cap are sent; an edge
  // pointing at a node the phone never received would render as a dangling row.
  const keptNodeIds = new Set(nodes.map((node) => node.id));
  const edges: RemoteWhiteboardEdge[] = [];
  for (const edge of board.edges) {
    if (!keptNodeIds.has(edge.from) || !keptNodeIds.has(edge.to)) {
      truncated = true;
      continue;
    }
    if (edges.length >= MAX_REMOTE_WHITEBOARD_EDGES) {
      truncated = true;
      break;
    }
    const item: RemoteWhiteboardEdge = {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      ...(edge.label ? { label: truncateUtf8(edge.label, 300) } : {}),
      ...(edge.tone ? { tone: edge.tone } : {}),
      ...(edge.style ? { style: edge.style } : {}),
    };
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (usedBytes + bytes > COLLECTION_BUDGET_BYTES) {
      truncated = true;
      break;
    }
    edges.push(item);
    usedBytes += bytes;
  }

  return {
    title: truncateUtf8(board.title, 300),
    ...(board.summary ? { summary: truncateUtf8(board.summary, 700) } : {}),
    nodes,
    edges,
    updatedAt: board.updatedAt,
    ...(truncated ? { truncated: true } : {}),
  };
}

/* ----------------------------------------------------------- Cora Board */

// Lane order matches the desktop board's columns left to right. "failed"
// shares the Review lane there, so it shares the rank here.
const BOARD_LANE_RANK: Record<BoardCardStatus, number> = {
  idea: 0,
  queued: 1,
  running: 2,
  blocked: 3,
  review: 4,
  failed: 4,
  done: 5,
};

function toRemoteBoardCard(card: BoardCard): RemoteBoardCard {
  return {
    id: card.id,
    title: truncateUtf8(card.title, REMOTE_BOARD_TITLE_MAX_BYTES),
    ...(card.description
      ? {
          description: truncateUtf8(
            card.description,
            REMOTE_BOARD_DESCRIPTION_MAX_BYTES,
          ),
        }
      : {}),
    status: card.status,
    order: card.order,
    ...(card.workerTaskId
      ? { workerTaskId: truncateUtf8(card.workerTaskId, 200) }
      : {}),
    ...(card.createdBy ? { createdBy: card.createdBy } : {}),
    ...(card.error
      ? { error: truncateUtf8(card.error, REMOTE_BOARD_ERROR_MAX_BYTES) }
      : {}),
    ...(card.imagePaths && card.imagePaths.length > 0
      ? { imageCount: card.imagePaths.length }
      : {}),
    updatedAt: card.updatedAt,
  };
}

// Cards in desktop lane order, capped by count and by the shared collection
// budget. The phone groups them back into lanes; the ordering is done here so
// both surfaces agree on what "first" means.
function toRemoteBoard(board: RunBoard): RemoteBoard {
  const ordered = [...board.cards].sort(
    (left, right) =>
      BOARD_LANE_RANK[left.status] - BOARD_LANE_RANK[right.status] ||
      left.order - right.order ||
      left.createdAt.localeCompare(right.createdAt),
  );
  const cards: RemoteBoardCard[] = [];
  let usedBytes = 2;
  for (const card of ordered.slice(0, MAX_REMOTE_BOARD_CARDS)) {
    const item = toRemoteBoardCard(card);
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (usedBytes + bytes > COLLECTION_BUDGET_BYTES) break;
    cards.push(item);
    usedBytes += bytes;
  }
  return { revision: board.revision, cards };
}

async function getCoraBoardForRemote(input: {
  workspaceId: string;
  runId: string;
  ifRevision?: string;
}): Promise<RemoteBoardReadProjection> {
  await requireLocalWorkspace(input.workspaceId);
  await requireOwnedRun(input.workspaceId, input.runId);
  return projectRemoteBoardRead(toRemoteBoard(await getRunBoard(input.runId)));
}

/**
 * Round-trip a stored card as a write payload. imagePaths are dropped rather
 * than echoed: board-store re-validates any paths it is handed against the
 * workspace, and an omitted field is what makes it carry the stored (already
 * validated) attachments over instead.
 */
function toBoardWritePayload(card: BoardCard): BoardCard {
  const { imagePaths: _imagePaths, ...rest } = card;
  return rest;
}

/**
 * One phone card action, applied against the board the computer holds right
 * now. The phone sends the revision it rendered; a board that moved on in the
 * meantime is reported back as applied:false with the fresh state rather than
 * being overwritten, because a card list composed against stale content could
 * resurrect a card Cora just finished or drop one it just added.
 */
async function updateCoraBoardForRemote(input: {
  workspaceId: string;
  runId: string;
  baseRevision: number;
  action: RemoteBoardAction;
  cardId?: string;
  title?: string;
  description?: string;
}): Promise<RemoteBoardUpdateResult> {
  const { root } = await requireLocalWorkspace(input.workspaceId);
  const run = await requireOwnedRun(input.workspaceId, input.runId);
  const current = await getRunBoard(input.runId);
  if (current.revision !== input.baseRevision) {
    return { board: toRemoteBoard(current), applied: false };
  }

  const cards = current.cards.map(toBoardWritePayload);
  const now = new Date().toISOString();
  let next: BoardCard[];

  if (input.action === "add-idea") {
    if (!input.title) throw new Error("A card needs a title.");
    if (cards.length >= BOARD_MAX_CARDS) {
      throw new Error(
        "This board is full. Clear some cards in Codara Studio first.",
      );
    }
    const lane = cards.filter((card) => card.status === "idea");
    next = [
      ...cards,
      {
        id: makeId("card"),
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
        status: "idea",
        order:
          lane.length > 0 ? Math.max(...lane.map((card) => card.order)) + 1 : 1,
        createdAt: now,
        updatedAt: now,
      },
    ];
  } else {
    const target = cards.find((card) => card.id === input.cardId);
    if (!target) {
      throw new Error("That card is no longer on this board.");
    }
    if (input.action === "delete") {
      next = cards.filter((card) => card.id !== target.id);
    } else {
      if (target.status !== "idea") {
        throw new Error("Only an idea card can be queued from the phone.");
      }
      // The nudge deliberately ignores automation runs (board-nudge's
      // attemptNudge drops any run with an automationId), so queueing on one
      // would be a promise nothing keeps. The phone hides the action; this is
      // the enforcement behind it.
      if (run.automationId) {
        throw new Error(
          "Cards on an automation's chat cannot be queued from the phone.",
        );
      }
      // Queueing is the go signal: the board write emits run.board_updated,
      // which is what wakes this chat's Cora (orchestration/board-nudge).
      const lane = cards.filter((card) => card.status === "queued");
      const order =
        lane.length > 0 ? Math.max(...lane.map((card) => card.order)) + 1 : 1;
      next = cards.map((card) =>
        card.id === target.id
          ? {
              ...card,
              status: "queued" as BoardCardStatus,
              order,
              updatedAt: now,
            }
          : card,
      );
    }
  }

  const result = await updateRunBoard({
    runId: input.runId,
    baseRevision: current.revision,
    cards: next,
    workspaceCwd: root,
  });
  return { board: toRemoteBoard(result.board), applied: result.ok };
}

/* ------------------------------------------------------------- fast mode */

// Fast mode is one global app setting (AppSettings.openAiFastMode), the same
// one Studio's composer bolt writes. An absent value means OFF, matching the
// desktop hook's fail-closed read: the wrong answer costs 2x on every OpenAI
// token rather than merely running at normal speed.
async function getOpenAiFastModeForRemote(): Promise<boolean> {
  const settings = await loadSettings();
  return settings.openAiFastMode === true;
}

// Declarative, not a toggle, so a retried set converges. Writing goes through
// saveSettings — the same path settings:save uses — so the value pi-backend
// reads at the next manager turn changes, relaunching the Pi session exactly
// as a desktop flip would.
async function setOpenAiFastModeForRemote(input: {
  enabled: boolean;
}): Promise<void> {
  const current = await loadSettings();
  const saved = await saveSettings({
    ...current,
    openAiFastMode: input.enabled,
  });
  broadcastSettingsChanged(saved);
}

/* ----------------------------------------------------------- automations */

// Read-mostly automations surface for the phone. Everything below delegates
// to the scheduler's existing exported functions; no orchestration behaviour
// lives here.
function formatIntervalMs(everyMs: number): string {
  const seconds = Math.round(everyMs / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

function describeAutomationTrigger(trigger: AutomationTrigger): {
  kind: RemoteAutomationTriggerKind;
  summary: string;
} {
  switch (trigger.kind) {
    case "cron":
      return {
        kind: "cron",
        summary: `On schedule (${truncateUtf8(trigger.expr, 60)})`,
      };
    case "interval":
      return {
        kind: "interval",
        summary: `Every ${formatIntervalMs(trigger.everyMs)}`,
      };
    case "folder":
      return {
        kind: "folder",
        summary: `Watches ${truncateUtf8(basename(trigger.path) || trigger.path, 80)}`,
      };
    case "continuous":
      return { kind: "continuous", summary: "Runs continuously" };
    case "onFinishOf":
      return { kind: "chain", summary: "Runs after another automation" };
    default:
      return { kind: "manual", summary: "Runs when you start it" };
  }
}

// Round a derived USD remainder to the ledger's 6-decimal precision and clamp
// float dust so "measured == total" reliably yields no estimated field.
function usdRemainder(
  total: number | undefined,
  measured: number | undefined,
): number {
  if (total === undefined) return 0;
  const remainder =
    Math.round((total - (measured ?? 0)) * 1_000_000) / 1_000_000;
  return remainder > 0 ? remainder : 0;
}

function toRemoteAutomation(job: ScheduledJob): RemoteAutomationInfo {
  const trigger = describeAutomationTrigger(job.trigger);
  const lastRecord = job.history.at(-1);
  // Same honest split as the run payload: `spentUsd` on the wire is measured
  // spend only; the estimate-only remainder (including everything on legacy
  // records that never tallied a measured figure) rides in estimatedSpentUsd.
  const measuredSpentUsd = job.state.measuredSpentUsd;
  const estimatedSpentUsd = usdRemainder(job.state.spentUsd, measuredSpentUsd);
  return {
    id: job.id,
    name: truncateUtf8(job.name, 300),
    enabled: job.enabled,
    status: job.state.status,
    triggerKind: trigger.kind,
    triggerSummary: trigger.summary,
    iteration: job.state.iteration,
    ...(job.state.nextFireAt ? { nextFireAt: job.state.nextFireAt } : {}),
    ...(job.lastRunAt ? { lastRunAt: job.lastRunAt } : {}),
    ...(lastRecord ? { lastRunStatus: lastRecord.status } : {}),
    ...(lastRecord?.summary
      ? { lastRunSummary: truncateUtf8(lastRecord.summary, 500) }
      : {}),
    ...(measuredSpentUsd ? { spentUsd: measuredSpentUsd } : {}),
    ...(estimatedSpentUsd ? { estimatedSpentUsd } : {}),
  };
}

async function listAutomationsForRemote(
  workspaceId: string,
): Promise<RemoteAutomationInfo[]> {
  await requireLocalWorkspace(workspaceId);
  const jobs = (await listJobs()).filter(
    (job) => job.input.workspaceId === workspaceId,
  );
  const result: RemoteAutomationInfo[] = [];
  let usedBytes = 2;
  for (const job of jobs.slice(0, MAX_REMOTE_AUTOMATIONS)) {
    const info = toRemoteAutomation(job);
    const bytes = Buffer.byteLength(JSON.stringify(info), "utf8") + 1;
    if (usedBytes + bytes > COLLECTION_BUDGET_BYTES) break;
    result.push(info);
    usedBytes += bytes;
  }
  return result;
}

const MAX_REMOTE_AUTOMATION_HISTORY = 10;
const REMOTE_AUTOMATION_PROMPT_CHARS = 500;

async function toRemoteAutomationLiveRun(
  job: ScheduledJob,
): Promise<RemoteAutomationLiveRun | undefined> {
  const runId = job.state.currentRunId;
  if (!runId) return undefined;
  const run = await getRun(runId);
  if (
    !run ||
    run.workspaceId !== job.input.workspaceId ||
    run.automationId !== job.id
  ) {
    return undefined;
  }
  const plan = toRemoteRunSteps(run);
  return {
    id: run.id,
    status: run.status,
    workers: toRemoteRunWorkers(run).workers,
    ...(isRemoteCoraIdentity(run.currentStepId)
      ? { currentStepId: run.currentStepId }
      : {}),
    ...(plan.total > 0
      ? {
          steps: plan.steps,
          stepsTotal: plan.total,
          stepsFinished: plan.finished,
        }
      : {}),
  };
}

// The loom's detail: what it is asking for, which worker runs it, and how the
// recent passes went. Read only; authoring stays desktop-side while the bounded
// live plan projection lets the phone render the same run relationships.
async function getAutomationForRemote(input: {
  workspaceId: string;
  automationId: string;
}): Promise<RemoteAutomationDetail> {
  const job = await requireOwnedAutomation(
    input.workspaceId,
    input.automationId,
  );
  const template = job.prompt?.template ?? job.input.initialUserNote ?? "";
  const prompt = template.slice(0, REMOTE_AUTOMATION_PROMPT_CHARS);
  const liveRun = await toRemoteAutomationLiveRun(job);

  const history: RemoteAutomationRunRecord[] = [];
  let usedBytes = 2;
  for (const record of [...job.history]
    .reverse()
    .slice(0, MAX_REMOTE_AUTOMATION_HISTORY)) {
    // Per-pass honest split, mirroring toRemoteAutomation: costUsd measured
    // only, estimatedCostUsd the estimate-only remainder.
    const estimatedCostUsd = usdRemainder(
      record.costUsd,
      record.measuredCostUsd,
    );
    const item: RemoteAutomationRunRecord = {
      iteration: record.iteration,
      runId: record.runId,
      startedAt: record.startedAt,
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      status: record.status,
      ...(record.summary
        ? { summary: truncateUtf8(record.summary, 1000) }
        : {}),
      ...(record.measuredCostUsd ? { costUsd: record.measuredCostUsd } : {}),
      ...(estimatedCostUsd ? { estimatedCostUsd } : {}),
      ...(record.stopReason ? { stopReason: record.stopReason } : {}),
    };
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (usedBytes + bytes > COLLECTION_BUDGET_BYTES) break;
    history.push(item);
    usedBytes += bytes;
  }

  return {
    ...toRemoteAutomation(job),
    ...(job.worker?.model
      ? { model: truncateUtf8(job.worker.model, 120) }
      : {}),
    ...(job.worker?.effort ? { effort: job.worker.effort } : {}),
    ...(job.worker?.timeoutMinutes !== undefined
      ? { timeoutMinutes: job.worker.timeoutMinutes }
      : {}),
    ...(prompt ? { prompt } : {}),
    ...(template.length > prompt.length ? { promptTruncated: true } : {}),
    history,
    ...(liveRun ? { liveRun } : {}),
  };
}

// The phone may only touch automations pinned to a workspace it can already
// see; the id alone never grants access to another workspace's looms.
async function requireOwnedAutomation(
  workspaceId: string,
  automationId: string,
): Promise<ScheduledJob> {
  await requireLocalWorkspace(workspaceId);
  const job = await getJob(automationId);
  if (!job || job.input.workspaceId !== workspaceId) {
    throw new Error("That automation no longer exists in this workspace.");
  }
  return job;
}

async function runAutomationForRemote(input: {
  workspaceId: string;
  automationId: string;
}): Promise<{ automation: RemoteAutomationInfo; runId: string }> {
  await requireOwnedAutomation(input.workspaceId, input.automationId);
  const run = await runJobNow(input.automationId);
  const job = await getJob(input.automationId);
  if (!job)
    throw new Error("That automation no longer exists in this workspace.");
  return { automation: toRemoteAutomation(job), runId: run.id };
}

async function pauseAutomationForRemote(input: {
  workspaceId: string;
  automationId: string;
}): Promise<RemoteAutomationInfo> {
  await requireOwnedAutomation(input.workspaceId, input.automationId);
  const job = await pauseJob(input.automationId);
  if (!job)
    throw new Error("That automation no longer exists in this workspace.");
  return toRemoteAutomation(job);
}

async function resumeAutomationForRemote(input: {
  workspaceId: string;
  automationId: string;
}): Promise<RemoteAutomationInfo> {
  await requireOwnedAutomation(input.workspaceId, input.automationId);
  const job = await resumeJob(input.automationId);
  if (!job)
    throw new Error("That automation no longer exists in this workspace.");
  return toRemoteAutomation(job);
}

async function setAutomationEnabledForRemote(input: {
  workspaceId: string;
  automationId: string;
  enabled: boolean;
}): Promise<RemoteAutomationInfo> {
  await requireOwnedAutomation(input.workspaceId, input.automationId);
  return toRemoteAutomation(
    await setJobEnabled(input.automationId, input.enabled),
  );
}

/* ---------------------------------------------------- phone notifications */

// Mirrors the desktop notify pipeline (src/main/notify/index.ts run adapter +
// automation-loop's finalize alert) onto paired phones. Connected phones get
// a live cora.notify relay event; phones without a proven session fall back
// to Expo push when they registered a token and left the kind enabled.
// Trigger conditions and copy deliberately track the desktop's.

let phoneNotifyStore: PhoneNotificationStore | null = null;
let phoneNotifyStarted = false;
const expoReceipts = new ExpoReceiptTracker();
const handledPhoneNotifyEventIds = new Set<string>();
const MAX_HANDLED_PHONE_NOTIFY_EVENT_IDS = 4_096;

function getPhoneNotifyStore(): PhoneNotificationStore {
  phoneNotifyStore ??= new PhoneNotificationStore(
    join(sparkHome(), "remote"),
    (line) => logMain("remote-access", line),
  );
  return phoneNotifyStore;
}

// Same idempotency guard the desktop run adapter uses: one canonical journal
// event never notifies twice even if a subscriber re-registers or retries.
function claimPhoneNotifyEvent(eventId: string): boolean {
  if (handledPhoneNotifyEventIds.has(eventId)) return false;
  handledPhoneNotifyEventIds.add(eventId);
  if (handledPhoneNotifyEventIds.size > MAX_HANDLED_PHONE_NOTIFY_EVENT_IDS) {
    const oldest = handledPhoneNotifyEventIds.values().next().value as
      string | undefined;
    if (oldest) handledPhoneNotifyEventIds.delete(oldest);
  }
  return true;
}

async function registerNotificationsForRemote(
  input: RemoteNotificationRegistration & { devicePublicKey: string },
): Promise<void> {
  await getPhoneNotifyStore().set(input.devicePublicKey, {
    enabled: input.enabled,
    prefs: input.prefs,
    ...(input.token ? { token: input.token } : {}),
    ...(input.deviceName ? { deviceName: input.deviceName } : {}),
    updatedAt: new Date().toISOString(),
  });
}

async function remoteWorkspaceName(
  workspaceId: string,
): Promise<string | undefined> {
  if (!workspaceId) return undefined;
  try {
    const state = await loadState();
    const name = state.workspaces.find(
      (workspace) => workspace.id === workspaceId,
    )?.name;
    return name ? truncateUtf8(name, 120) : undefined;
  } catch {
    return undefined;
  }
}

// The desktop's handleRunEvent conditions, reproduced: run-level status
// transitions only, blocked requires a real user blocker, and loom-owned
// iterations defer their terminal ping to the loop-level finalize (observed
// here via the automation.iteration "stopped" journal event).
async function buildPhoneNotification(
  event: SparkEvent,
): Promise<RemotePhoneNotification | null> {
  if (event.type === "run.status_updated") {
    const payload = event.payload as
      | {
          status?: unknown;
          previousStatus?: unknown;
          automationId?: unknown;
          questionMessageId?: unknown;
          blocker?: unknown;
        }
      | undefined;
    const status =
      typeof payload?.status === "string"
        ? (payload.status as RunStatus)
        : undefined;
    const prevStatus =
      typeof payload?.previousStatus === "string"
        ? (payload.previousStatus as RunStatus)
        : undefined;
    const automationId =
      typeof payload?.automationId === "string" &&
      payload.automationId.length > 0
        ? payload.automationId
        : undefined;
    const runId = event.runId;
    if (!status || !runId || prevStatus === status) return null;
    if (status !== "blocked" && status !== "complete" && status !== "failed")
      return null;
    if (!claimPhoneNotifyEvent(event.id)) return null;
    // Mirror the desktop policy's context gates (notify/policy.ts decide()):
    // DND mutes every alert, and a completion for the run the user is
    // actively watching in Studio is suppressed. "Needs you" survives
    // watching on the desktop, so it survives here too.
    if (getPreferenceCached("notificationsDnd") === true) return null;
    if ((status === "complete" || status === "failed") && isWatchingRun(runId))
      return null;

    if (status === "blocked") {
      const hasUserBlocker =
        (typeof payload?.questionMessageId === "string" &&
          payload.questionMessageId.length > 0) ||
        (typeof payload?.blocker === "object" && payload.blocker !== null);
      if (!hasUserBlocker) return null;
      const workspaceName = await remoteWorkspaceName(event.workspaceId);
      if (automationId) {
        // kind "blocked", not "automation": a blocked iteration is a question
        // for the user, so it rides the needsAnswer preference on both the
        // push gate here and the phone's local filter. The automations pref
        // gates only loop outcomes (the automation.iteration branch below).
        return {
          id: event.id,
          kind: "blocked",
          title: "Automation needs your answer",
          body:
            event.message?.trim() || "An automation is waiting on your answer.",
          workspaceId: event.workspaceId,
          ...(workspaceName ? { workspaceName } : {}),
          runId,
          automationId,
          createdAt: event.timestamp,
        };
      }
      return {
        id: event.id,
        kind: "blocked",
        title: "Cora needs your answer",
        body: event.message?.trim() || "A run is waiting on your answer.",
        workspaceId: event.workspaceId,
        ...(workspaceName ? { workspaceName } : {}),
        runId,
        createdAt: event.timestamp,
      };
    }

    // Loom iterations finalize through the automation branch below.
    if (automationId) return null;
    const ok = status === "complete";
    const workspaceName = await remoteWorkspaceName(event.workspaceId);
    return {
      id: event.id,
      kind: ok ? "completed" : "failed",
      title: ok ? "Run complete" : "Run failed",
      body:
        event.message?.trim() ||
        (ok ? "Cora finished a run." : "A run failed."),
      workspaceId: event.workspaceId,
      ...(workspaceName ? { workspaceName } : {}),
      runId,
      createdAt: event.timestamp,
    };
  }

  if (event.type === "automation.iteration") {
    const payload = event.payload as
      | { automationId?: unknown; status?: unknown; iteration?: unknown }
      | undefined;
    if (
      payload?.status !== "stopped" ||
      typeof payload.automationId !== "string"
    ) {
      return null;
    }
    if (!claimPhoneNotifyEvent(event.id)) return null;
    if (getPreferenceCached("notificationsDnd") === true) return null;
    // The job re-read below can race an immediate trigger-restart, which
    // resets state between the "stopped" event and this handler. The event
    // payload carries the finalize-time iteration count, so prefer it;
    // lastStopReason and lastRunId have no event-payload equivalent (the
    // finalize emit lives in read-only automation-loop.ts) and keep the small
    // residual window: a restart cannot rewrite them, only the NEXT finalize
    // or firing can.
    const job = await getJob(payload.automationId);
    if (!job) return null;
    // The user stopped it themselves; pinging them about their own click is
    // noise (same rule as the desktop's finalize alert).
    const reason = job.state.lastStopReason;
    if (reason === "user-stop") return null;
    const failed = reason === "iteration-failed" || reason === "engine-missing";
    const iterations =
      typeof payload.iteration === "number" &&
      Number.isFinite(payload.iteration)
        ? payload.iteration
        : job.state.iteration;
    const passes = `${iterations} iteration${iterations === 1 ? "" : "s"}`;
    const workspaceName = await remoteWorkspaceName(job.input.workspaceId);
    // lastRunId is the run of the loop's final iteration — the emit itself
    // never carries a runId for "stopped" — so a tap can deep-link the run.
    const runId = job.lastRunId;
    return {
      id: event.id,
      kind: "automation",
      title: failed ? "Automation failed" : "Automation finished",
      body: `"${truncateUtf8(job.name, 120)}" ${failed ? "stopped" : "finished"} after ${passes}.`,
      workspaceId: job.input.workspaceId,
      ...(workspaceName ? { workspaceName } : {}),
      automationId: job.id,
      ...(runId ? { runId } : {}),
      createdAt: event.timestamp,
    };
  }

  return null;
}

async function deliverPhoneNotification(
  service: RemoteAccessService,
  notification: RemotePhoneNotification,
): Promise<void> {
  const store = getPhoneNotifyStore();
  const pushTargets: ExpoPushTarget[] = [];
  for (const devicePublicKey of service.pairedDeviceKeys()) {
    // A push-live phone gets the live event and filters by its own local
    // preferences; the registered prefs gate only server-initiated push.
    // Stale-but-open sessions still receive the event (the phone dedupes by
    // event id), but only recent inbound activity counts as delivered.
    if (service.pushPhoneNotificationToDevice(devicePublicKey, notification))
      continue;
    const registration = await store.get(devicePublicKey);
    if (!registration?.enabled || !registration.token) continue;
    if (!phoneNotificationKindAllowed(notification.kind, registration.prefs))
      continue;
    pushTargets.push({ devicePublicKey, token: registration.token });
  }
  // Earlier sends' tickets are due a verdict by now; resolve them before
  // adding this send's own.
  await pollExpoReceipts();
  if (pushTargets.length === 0) return;
  const outcomes = await sendExpoPushMessages(pushTargets, notification);
  for (const outcome of outcomes) {
    if (outcome.ok) {
      if (outcome.ticketId)
        expoReceipts.add(outcome.ticketId, outcome.devicePublicKey);
      continue;
    }
    if (outcome.deviceNotRegistered)
      await store.clearToken(outcome.devicePublicKey);
    logMain(
      "remote-access",
      `expo push to ${outcome.devicePublicKey.slice(0, 8)} failed: ${outcome.detail}`,
    );
  }
}

// Resolves pending push tickets against Expo's receipts endpoint. A ticket
// that looked "ok" at send time can still receipt as DeviceNotRegistered —
// that is in fact where the signal usually arrives — and must clear the dead
// token exactly like an immediate ticket failure.
async function pollExpoReceipts(): Promise<void> {
  if (expoReceipts.size() === 0) return;
  const store = getPhoneNotifyStore();
  const failures = await expoReceipts.poll();
  for (const failure of failures) {
    if (failure.deviceNotRegistered)
      await store.clearToken(failure.devicePublicKey);
    logMain(
      "remote-access",
      `expo push receipt for ${failure.devicePublicKey.slice(0, 8)} failed: ${failure.detail}`,
    );
  }
}

function startPhoneNotificationBridge(service: RemoteAccessService): void {
  if (phoneNotifyStarted) return;
  phoneNotifyStarted = true;
  const changedCoalescer = createCoraChangedCoalescer<RemoteCoraChangedEvent>(
    (changed) => service.broadcastCoraChanged(changed),
  );
  subscribeToEvents((event) => {
    const changed: RemoteCoraChangedEvent = {
      workspaceId: event.workspaceId,
      ...(event.runId ? { runId: event.runId } : {}),
      ...(event.runId &&
      Number.isSafeInteger(event.sequence) &&
      (event.sequence as number) > 0
        ? { sequence: event.sequence as number }
        : {}),
    };
    // assistant_block can append many journal records per second. Keep the
    // invalidation live without mirroring that stream rate onto every phone;
    // notifications below remain immediate and use their own semantic gate.
    changedCoalescer.push(changed);
    void (async () => {
      const notification = await buildPhoneNotification(event);
      if (!notification) return;
      await deliverPhoneNotification(service, notification);
    })().catch((err) => {
      logMain(
        "remote-access",
        `phone notify failed: ${(err as Error).message}`,
      );
    });
  });
  // Backstop for quiet periods: without another send, a pending receipt would
  // otherwise wait forever for its verdict.
  const receiptTimer = setInterval(() => {
    void pollExpoReceipts().catch(() => undefined);
  }, EXPO_RECEIPT_POLL_MS);
  receiptTimer.unref?.();
}

// A live automation terminal observes the exact worker PTY shown by Studio.
// Writes and resizes are exposed only to the authenticated, process-scoped
// worker control registry; closing the phone sheet still removes only this tap
// and can never kill the canonical worker process.
async function attachRemoteWorkerTerminal(
  request: RemoteWorkerTerminalOpenRequest,
): Promise<RemoteTerminalHandle> {
  await requireLocalWorkspace(request.workspaceId);
  const run = await requireOwnedRun(request.workspaceId, request.runId);
  if (!run.automationId) {
    throw new Error("That run is not owned by an automation.");
  }
  const attempt = run.workerAttempts.find(
    (candidate) => candidate.id === request.workerId,
  );
  if (!attempt) {
    throw new Error("That worker is not part of this automation pass.");
  }
  if (
    !ACTIVE_WORKER_ATTEMPT_STATUSES.has(attempt.status) ||
    !pty.exists(attempt.id)
  ) {
    throw new Error("That worker terminal is no longer running.");
  }

  const task = run.workerTasks.find(
    (candidate) => candidate.id === attempt.workerTaskId,
  );
  const title = truncateUtf8(task?.title || "Automation worker", 240);
  const inputDescriptor = activeWorkerInputDescriptor(attempt.id);
  const inputCapability =
    attempt.status === "running" && inputDescriptor?.capability === "steer"
      ? (inputDescriptor?.capability ?? "none")
      : "none";
  const decoder = new StringDecoder("utf8");
  const notifyExit = request.onExit;
  let closed = false;

  // readTail() and tap() are synchronous on the main event loop, so output
  // cannot slip between replaying the bounded tail and subscribing live.
  const bootstrap = pty.readTail(attempt.id, TERMINAL_BOOTSTRAP_BYTES);
  if (bootstrap === null) {
    throw new Error("That worker terminal is no longer running.");
  }
  if (bootstrap.length > 0) {
    const text = decoder.write(bootstrap);
    if (text) request.onData(text);
  }
  const untap = pty.tap(attempt.id, (chunk) => {
    if (closed) return;
    const text = decoder.write(chunk);
    if (text) request.onData(text);
  });
  const offExit = pty.onExit(attempt.id, () => {
    if (closed) return;
    closed = true;
    untap();
    offExit();
    const final = decoder.end();
    if (final) request.onData(final);
    notifyExit();
  });
  const close = (): void => {
    if (closed) return;
    closed = true;
    untap();
    offExit();
    decoder.end();
  };

  return {
    title,
    ...(inputCapability !== "none"
      ? {
          controlTargetId: `automation-worker:${request.workspaceId}:${request.runId}:${attempt.id}:${inputDescriptor!.processGenerationId}`,
          controlCapability: inputCapability,
        }
      : {}),
    write: (data) => {
      if (
        !inputDescriptor ||
        !writeActiveWorkerInput(
          attempt.id,
          inputDescriptor.processGenerationId,
          data,
        )
      ) {
        throw new Error("That automation worker no longer accepts input.");
      }
    },
    resize: () => undefined,
    close,
  };
}

// Phone-created terminals are real renderer-owned tabs. The bridge mints the
// leaf, TerminalPane spawns its PTY, and this service taps that same PTY for
// the encrypted phone stream. The authenticated device lease remains the
// lifecycle owner across ordinary socket handoffs; revoke, expiry, explicit
// close, or Remote Access shutdown closes the PTY and visible desktop tab.
async function createRemoteTerminal(
  request: RemoteTerminalCreateRequest,
): Promise<RemoteTerminalHandle> {
  const { workspace, root } = await requireLocalWorkspace(request.workspaceId);
  const cwd = await resolveExistingInside(root, request.cwd, {
    allowAbsolute: true,
    directory: true,
    rejectSymlinks: true,
  });
  const resumableRuntime =
    request.profile === "claude" || request.profile === "codex"
      ? request.profile
      : null;
  const nativeClaudeExecution =
    request.profile === "claude"
      ? await resolveNewNativeClaudeProfile()
      : null;
  const resumeSession =
    request.resumeSessionId && resumableRuntime
      ? (
          await listLocalWorkerSessions(resumableRuntime, cwd.path, {
            ...(nativeClaudeExecution
              ? {
                  claudeStateDir:
                    nativeClaudeExecution.env.CLAUDE_CONFIG_DIR ?? null,
                }
              : {}),
          })
        ).find(
          (session) => session.sessionId === request.resumeSessionId,
        )
      : null;
  if (request.resumeSessionId && !resumeSession) {
    throw new Error(
      "That worker session is no longer resumable in this workspace.",
    );
  }
  if (request.profile === "codex") {
    await ensureCodexProjectTrust(cwd.path).catch(() => undefined);
  }
  const command =
    request.profile === "claude"
      ? resumeSession
        ? `claude --dangerously-skip-permissions --resume ${resumeSession.sessionId}`
        : "claude --dangerously-skip-permissions"
      : request.profile === "codex"
        ? resumeSession
          ? `codex resume ${resumeSession.sessionId} --yolo`
          : "codex --yolo"
        : undefined;
  const profileLabel =
    request.profile === "claude"
      ? "Claude"
      : request.profile === "codex"
        ? "Codex"
        : "Terminal";
  const title =
    request.title?.trim() ||
    `${truncateUtf8(request.origin.deviceName, 80)} · ${profileLabel}`;
  let result: {
    tabId: string;
    paneId: string;
    cwd: string;
  };
  try {
    result = await requestTerminalOp<{
      tabId: string;
      paneId: string;
      cwd: string;
    }>(
      "create",
      {
        cwd: cwd.path,
        ...(command ? { command } : {}),
        ...(nativeClaudeExecution
          ? { nativeClaudeProfileId: nativeClaudeExecution.profileId }
          : {}),
        title: truncateUtf8(title, 240),
        workspaceId: workspace.id,
        workspaceCwd: root,
        origin: {
          ...request.origin,
          initialCols: request.cols,
          initialRows: request.rows,
        },
      },
      { timeoutMs: 15_000 },
    );
  } catch (cause) {
    throw Object.assign(
      new Error(
        (cause as Error).message ||
          "The terminal create outcome could not be confirmed.",
      ),
      { code: "REMOTE_TERMINAL_CREATE_OUTCOME_UNKNOWN" },
    );
  }
  if (!result?.tabId || !result.paneId) {
    throw Object.assign(
      new Error("Codara did not confirm the created terminal tab."),
      { code: "REMOTE_TERMINAL_CREATE_OUTCOME_UNKNOWN" },
    );
  }

  const decoder = new StringDecoder("utf8");
  // readTail() and tap() are synchronous, so no pty callback can run between
  // them on the main event loop. This replays output emitted before the bridge
  // response without either losing or duplicating it.
  const bootstrap = pty.readTail(result.paneId, TERMINAL_BOOTSTRAP_BYTES);
  if (bootstrap?.length) {
    const text = decoder.write(bootstrap);
    if (text) request.onData(text);
  }
  const untap = pty.tap(result.paneId, (chunk) => {
    const text = decoder.write(chunk);
    if (text.length > 0) request.onData(text);
  });
  let ready = false;
  let closed = false;
  let exitedBeforeReady = false;
  const offExit = pty.onExit(result.paneId, () => {
    if (closed) return;
    closed = true;
    untap();
    offExit();
    const final = decoder.end();
    if (final) request.onData(final);
    if (ready) {
      // Tell the phone first so it can mark the session ended, then remove the
      // exact renderer-owned tab. Leaving a dead phone-origin agent pane in
      // Studio would retain its placement bookkeeping and could let the
      // desktop auto-resume it after remote ownership had ended.
      request.onExit();
      void requestTerminalOp("destroy", {
        tabId: result.tabId,
        paneId: result.paneId,
      }).catch(() => undefined);
    } else {
      exitedBeforeReady = true;
    }
  });

  let alive = await pty.waitForSpawn(result.paneId, TERMINAL_SPAWN_WAIT_MS);
  if (alive) {
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, TERMINAL_SPAWN_SETTLE_MS),
    );
    alive = pty.exists(result.paneId);
  }
  if (!alive || exitedBeforeReady) {
    if (!closed) {
      closed = true;
      untap();
      offExit();
      pty.resumeFlow(result.paneId);
      pty.dispose(result.paneId, { sanctioned: true });
    }
    await requestTerminalOp("destroy", {
      tabId: result.tabId,
      paneId: result.paneId,
    }).catch(() => undefined);
    throw new Error(
      "The terminal failed to start. Check that its directory is accessible.",
    );
  }
  ready = true;

  const closeVisibleTerminal = (): void => {
    if (closed) return;
    closed = true;
    untap();
    offExit();
    // Always release OS-level flow control before teardown. Otherwise a PTY
    // paused because the phone stopped draining can remain frozen during the
    // renderer's asynchronous tab-close path.
    pty.resumeFlow(result.paneId);
    pty.dispose(result.paneId, { sanctioned: true });
    void requestTerminalOp("destroy", {
      tabId: result.tabId,
      paneId: result.paneId,
    }).catch(() => undefined);
  };

  return {
    desktopTabId: result.tabId,
    title: truncateUtf8(title, 240),
    write: (data) => pty.write(result.paneId, data),
    resize: async (cols, rows) => {
      // Resize xterm first so it parses the TUI's next repaint using the same
      // grid the PTY is about to advertise. If the renderer is reloading, keep
      // the remote terminal usable and let its cached size apply on remount.
      await requestTerminalOp(
        "resize",
        { paneId: result.paneId, cols, rows },
        { timeoutMs: 2_000 },
      ).catch((err) => {
        logMain(
          "remote-access",
          `desktop terminal resize mirror missed: ${(err as Error).message}`,
        );
      });
      pty.resize(result.paneId, cols, rows);
    },
    pause: () => {
      pty.pauseFlow(result.paneId);
    },
    resume: () => {
      pty.resumeFlow(result.paneId);
    },
    close: closeVisibleTerminal,
  };
}
