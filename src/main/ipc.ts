import { ipcMain, dialog, BrowserWindow, app, shell, webContents, clipboard, nativeImage, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { listShells, defaultShell } from "./shells";
import { buildIntegratedShellLaunch } from "./shell-init";
import { createFile, createFolder, deleteFile, deleteToStash, importEntries, listDir, listFiles, listMarkdownFiles, moveEntries, purgeDeleteStash, readFileBytes, readFileEx, readTextFile, readTextFileTail, renameFile, statFile, undoDeleteFromStash, writeTextFile } from "./fs-tree";
import { assertAllowedReadPathResolved, setAllowedRoots } from "./fs-sandbox";
import { readClipboardFilePaths, writeClipboardFilePaths } from "./clipboard-files";
import { deleteManualHost, listHosts, saveManualHost } from "./remote/ssh-hosts";
import { browseRemoteDir } from "./remote/browse";
import {
  listKeys as listSshKeys,
  generateKey as generateSshKey,
  importKey as importSshKey,
  deleteKey as deleteSshKey,
} from "./remote/ssh-keys";
import type { SshKeyImportResult, SshKeyInfo } from "@shared/ssh-keys";
import {
  answerAuthPrompt,
  disconnectHost,
  getConnection,
  getConnectionStatus,
  setAuthPromptSender,
  setStatusSender,
} from "./remote/connections";
import { isRemotePath } from "@shared/remote";
import type { UsageSummaryInput } from "@shared/usage-analytics";
import { detectRemoteAgents, type RemoteAgentAvailability } from "./remote/remote-agents";
import type {
  RemoteAuthPromptAnswer,
  RemoteBrowseResult,
  RemoteConnectionStatus,
  RemoteHostConfig,
} from "@shared/remote";

// Managed orchestration (Cora chat backend, automations, autopilot,
// checkpoints) is wired to local file side-channels — the CLI's on-disk
// transcript, the hook queue/turn files, the checkpoint temp index — all of
// which assume the agent runs on the same machine as the app. Those don't hold
// for a remote host yet, so we refuse cleanly instead of hanging. Running the
// agent CLI directly on the VPS works today via a "Worker — Claude/Codex"
// terminal on the remote workspace.
function assertLocalWorkspace(cwd: string, feature: string): void {
  if (isRemotePath(cwd)) {
    throw new Error(
      `${feature} isn't available for remote (SSH) workspaces yet. Open a terminal on the host and run the agent there instead.`,
    );
  }
}
import { loadSettings, loadState, saveSettings, saveState } from "./storage";
import { codaraHome } from "./codara-home";
import { logMain } from "./file-log";
import { isTrustedOnSender, requireTrustedSender } from "./main-window-trust";
import { detectAgentRuntimes } from "./agent-runtimes";
import { loadPreferences, setPreference } from "./preferences-store";
import * as pty from "./pty-manager";
import { isLoopbackPreviewServerUp } from "./preview-navigation";
import * as fsWatcher from "./fs-watcher";
import { streamGrep, type StreamGrepHandle } from "./search/grep";
import { remoteStreamGrep } from "./remote/remote-search";
import { listEvents, subscribeToEvents } from "./orchestration/event-log";
import {
  claudeSessionTranscriptPath,
  discoverClaudeSessionForCwd,
  inspectClaudeTranscriptTail,
  repairClaudeTranscriptTail,
  resolveSafeClaudeTranscriptPath,
} from "./orchestration/claude-paths";
import { discoverRolloutForCwd, extractSessionUuid } from "./orchestration/codex-sessions";
import { resolveCodexTranscriptPath } from "./orchestration/codex-home";
import { latestSessionStart } from "./agent-session-registry";
import { ensureCodexProjectTrust } from "./orchestration/codex-trust";
import { parseManualAgentStartupCommand } from "./manual-agent-startup";
import { workspaceProjectPolicyModeForTerminalCwd } from "./orchestration/project-policy";
import {
  resolveFrozenNativeCodexProfile,
  resolveNewNativeCodexProfile,
} from "./orchestration/native-codex-profile-runtime";
import {
  resolveFrozenNativeClaudeProfile,
  resolveNewNativeClaudeProfile,
} from "./orchestration/native-claude-profile-runtime";
import {
  nativeCliAccounts,
  NativeCliAccountError,
} from "./orchestration/native-cli-accounts";
import { focusStudioWindow } from "./window-focus";
import { detectNativeCliShellProfileLeftover } from "./orchestration/native-cli-terminal-cleanup";
import type { NativeCliShellProfileLeftover } from "@shared/native-cli-shell-leftover";
import * as mcpInstaller from "./mcp-installer";
import * as coraMemory from "./orchestration/cora-memory";
import {
  deleteWorkerSession,
  listAllWorkerSessions,
  listWorkerSessions,
} from "./worker-sessions";
import {
  clearCenter,
  listCenterEntries,
  markCenterAllRead,
  markCenterRead,
  removeCenterEntry,
  setAttention,
} from "./notify";
import {
  noteTerminalWillDispose,
  noteTerminalUserInput,
  syncTerminalNotifyPanes,
  terminalAgentStateSnapshot,
  type TerminalNotifyPaneEntry,
} from "./terminal-agent-notify";
import type {
  InlineAiCompletionRequest,
  InlineAiCompletionResponse,
} from "./inline-ai";
import type {
  RemoteAccessStatus,
  RemotePairedDevice,
  RemotePairingSession,
} from "@shared/remote-access";
import type {
  GitHubPublishInput,
  GitHubPublishResult,
  GitHubMarkReadyInput,
  GitHubMarkReadyResult,
  GitHubMergeInput,
  GitHubMergeResult,
  GitHubWorkspaceStatus,
  GitHubWorkQueueStatus,
  StartGitHubIssueInput,
  StartGitHubIssueResult,
  StartGitHubPullRequestInput,
  StartGitHubPullRequestResult,
} from "@shared/github";

// Heavy modules deferred via dynamic import to keep cold startup snappy. Each
// cache slot is populated on the first IPC call that needs the module and
// reused thereafter, so we pay the resolve+evaluate cost once per process.
let gitOpsMod: typeof import("./git-ops") | undefined;
async function getGitOps(): Promise<typeof import("./git-ops")> {
  gitOpsMod ??= await import("./git-ops");
  return gitOpsMod;
}

let gitCommitMessageMod: typeof import("./git-commit-message") | undefined;
async function getGitCommitMessage(): Promise<typeof import("./git-commit-message")> {
  gitCommitMessageMod ??= await import("./git-commit-message");
  return gitCommitMessageMod;
}

let gitBranchesMod: typeof import("./git-branches") | undefined;
async function getGitBranches(): Promise<typeof import("./git-branches")> {
  gitBranchesMod ??= await import("./git-branches");
  return gitBranchesMod;
}

let gitStashMod: typeof import("./git-stash") | undefined;
async function getGitStash(): Promise<typeof import("./git-stash")> {
  gitStashMod ??= await import("./git-stash");
  return gitStashMod;
}

let gitInspectMod: typeof import("./git-inspect") | undefined;
async function getGitInspect(): Promise<typeof import("./git-inspect")> {
  gitInspectMod ??= await import("./git-inspect");
  return gitInspectMod;
}

let gitApplyMod: typeof import("./git-apply") | undefined;
async function getGitApply(): Promise<typeof import("./git-apply")> {
  gitApplyMod ??= await import("./git-apply");
  return gitApplyMod;
}

let githubCliMod: typeof import("./github-cli") | undefined;
async function getGitHubCli(): Promise<typeof import("./github-cli")> {
  githubCliMod ??= await import("./github-cli");
  return githubCliMod;
}

let githubPublishMod: typeof import("./github-publish") | undefined;
async function getGitHubPublish(): Promise<typeof import("./github-publish")> {
  githubPublishMod ??= await import("./github-publish");
  return githubPublishMod;
}

let githubMergeMod: typeof import("./github-merge") | undefined;
async function getGitHubMerge(): Promise<typeof import("./github-merge")> {
  githubMergeMod ??= await import("./github-merge");
  return githubMergeMod;
}

let githubReadyMod: typeof import("./github-ready") | undefined;
async function getGitHubReady(): Promise<typeof import("./github-ready")> {
  githubReadyMod ??= await import("./github-ready");
  return githubReadyMod;
}

async function getGitWorktrees(): Promise<typeof import("./git-worktrees")> {
  return import("./git-worktrees");
}

let agentSyncMod: typeof import("./agent-sync") | undefined;
async function getAgentSync(): Promise<typeof import("./agent-sync")> {
  agentSyncMod ??= await import("./agent-sync");
  return agentSyncMod;
}

let inlineAiMod: typeof import("./inline-ai") | undefined;
async function getInlineAi(): Promise<typeof import("./inline-ai")> {
  inlineAiMod ??= await import("./inline-ai");
  return inlineAiMod;
}

let piSubscriptionAuthMod: typeof import("./orchestration/pi-subscription-auth") | undefined;
async function getPiSubscriptionAuth(): Promise<typeof import("./orchestration/pi-subscription-auth")> {
  piSubscriptionAuthMod ??= await import("./orchestration/pi-subscription-auth");
  return piSubscriptionAuthMod;
}

let runStoreMod: typeof import("./orchestration/run-store") | undefined;
async function getRunStore(): Promise<typeof import("./orchestration/run-store")> {
  runStoreMod ??= await import("./orchestration/run-store");
  return runStoreMod;
}

let schedulerMod: typeof import("./orchestration/scheduler") | undefined;
async function getScheduler(): Promise<typeof import("./orchestration/scheduler")> {
  schedulerMod ??= await import("./orchestration/scheduler");
  return schedulerMod;
}


// Remote Access (phone pairing + listener). Deferred like the git modules:
// the hyperswarm stack only loads when the user first touches the feature.
// Status and pairing pushes are wired to every webContents on first access
// so the Settings panel updates live wherever it is open.
let remoteAccessMod: typeof import("./remote-access/production") | undefined;
let remoteAccessPushesWired = false;
async function getRemoteAccess(): Promise<
  import("./remote-access/index").RemoteAccessService
> {
  remoteAccessMod ??= await import("./remote-access/production");
  const service = remoteAccessMod.getRemoteAccessService();
  if (!remoteAccessPushesWired) {
    remoteAccessPushesWired = true;
    const push = (channel: string, payload: unknown) => {
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.isDestroyed()) {
          try {
            wc.send(channel, payload);
          } catch {
            /* window mid-teardown */
          }
        }
      }
    };
    service.onStatusChanged((status) => push("remoteAccess:statusChanged", status));
    service.onPairingChanged((state) => push("remoteAccess:pairingChanged", state));
  }
  return service;
}

// ── Cora-only kill authority for worker ptys ────────────────────────────────
// Worker panes use their attemptId as the pty session id, and every renderer
// pane-close path funnels into "pty:dispose". Killing a live worker is the
// orchestrator's decision alone (run-store's activeWorkerProcesses and its
// cancel/fail paths call pty-manager directly and never cross this IPC
// boundary), so the handler downgrades a renderer dispose of a still-live
// attempt to a detach: the view lets go, the session survives for follow-ups.
// The attempt→run map is fed from the durable event journal; attempts that
// never launched (preparing/prompt_ready) are deliberately not protected —
// their pty is an idle shell no worker owns yet.
const workerAttemptRunIds = new Map<string, string>();
subscribeToEvents((event) => {
  if (!event.attemptId) return;
  if (event.type === "worker_task.envelope_prepared" && event.runId) {
    workerAttemptRunIds.set(event.attemptId, event.runId);
  } else if (event.type === "worker_attempt.finished") {
    workerAttemptRunIds.delete(event.attemptId);
  }
});

const KILL_PROTECTED_ATTEMPT_STATUSES = new Set(["launching", "running", "finishing"]);

async function isLiveWorkerAttemptPty(id: string): Promise<boolean> {
  const runId = workerAttemptRunIds.get(id);
  if (!runId) return false;
  try {
    const { getRun } = await getRunStore();
    const run = await getRun(runId);
    const attempt = run?.workerAttempts.find((item) => item.id === id);
    if (attempt && KILL_PROTECTED_ATTEMPT_STATUSES.has(attempt.status)) return true;
    // Terminal (or unknown) attempt: forget it so the map stays bounded and
    // later disposes take the fast path.
    workerAttemptRunIds.delete(id);
    return false;
  } catch {
    // Fail closed: an unreadable run must not let the UI kill a worker.
    return true;
  }
}
import type {
  AddRunMessageInput,
  CancelQueuedMessageInput,
  CancelQueuedMessageResult,
  AnswerRunQuestionInput,
  AppPreferences,
  AppSettings,
  AgentMcpServerDraft,
  AppState,
  CreateEntryInput,
  AutomationDetail,
  AutomationWorkerInfo,
  CreateScheduledJobInput,
  CreateStepInput,
  CreateRunInput,
  CreateWorkerTaskInput,
  FileListResult,
  FsEntry,
  FsFileContent,
  FsReadResult,
  FsWriteResult,
  GitBranchList,
  GitCommitDetailResult,
  GitCommitMessageResult,
  GitConflictSide,
  GitCopyWorktreeResult,
  GitDiff,
  GitFileChange,
  GitLog,
  GitOpResult,
  GitStashList,
  GitStatus,
  LaunchWorkerAttemptInput,
  MarkRunSeenInput,
  RunBoard,
  RunBoardUpdateInput,
  RunBoardUpdateResult,
  CoraMemoryScope,
  CoraMemoryStatus,
  MemoryClearInput,
  MemorySetEnabledInput,
  MemoryStatusInput,
  UpdateChatBackendInput,
  UpdateCoraWhiteboardInput,
  ExportCoraWhiteboardFileInput,
  ExportFileDialogInput,
  ImportedCoraWhiteboardFile,
  NativeCliAccountCancelLoginInput,
  NativeCliAccountCreateInput,
  NativeCliAccountDeleteResult,
  NativeCliAccountLoginPreparation,
  NativeCliAccountMutationResult,
  NativeCliAccountProfileInput,
  NativeCliAccountRenameInput,
  NativeCliAccountsInspection,
  NativeCliAccountRuntime,
  PiSubscriptionAddAccountInput,
  PiSubscriptionDeleteAccountInput,
  PiSubscriptionMakeDefaultInput,
  PiSubscriptionOverview,
  PiSubscriptionProvider,
  PiSubscriptionReconnectAccountInput,
  PiSubscriptionRenameAccountInput,
  ProjectPolicyMode,
  PrefKey,
  PreferencesChange,
  PrepareWorkerTaskInput,
  NotificationCenterEntry,
  RenameRunInput,
  ResumeRunInput,
  RenameFileInput,
  RunState,
  RuntimeState,
  ScheduledJob,
  SearchHit,
  SearchOptions,
  SearchSummary,
  ShellInfo,
  SparkBuiltinMcpId,
  SparkBuiltinRuntime,
  SparkEvent,
  StartAutopilotInput,
  StartSearchResponse,
  UiAttentionSnapshot,
  UndoToCheckpointInput,
  UndoToCheckpointResult,
  UpdateRunStatusInput,
  UpdateScheduledJobInput,
  DeleteWorkerSessionInput,
  DeleteWorkerSessionResult,
  WorkerSessionRuntime,
  WorkerSessionSummary,
} from "@shared/types";

function nativeCliAccountRuntimeFromIpc(value: unknown): NativeCliAccountRuntime {
  if (value === "claude" || value === "codex") return value;
  throw new TypeError("Native CLI account runtime must be Claude or Codex.");
}

function nativeCliAccountProfileIdFromIpc(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 64 ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw new TypeError("Native CLI account profile id is invalid.");
  }
  return value;
}

function nativeCliAccountLabelFromIpc(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Native CLI account name is required.");
  }
  const label = value.trim();
  if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new TypeError("Native CLI account name must be 1 to 80 characters.");
  }
  return label;
}

function nativeCliLoginTokenFromIpc(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 24 ||
    value.length > 256 ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw new TypeError("Native CLI account login preparation is invalid.");
  }
  return value;
}

function nativeCliAccountProfileInputFromIpc(
  value: unknown,
): NativeCliAccountProfileInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Native CLI account input is required.");
  }
  const input = value as Partial<NativeCliAccountProfileInput>;
  return {
    runtime: nativeCliAccountRuntimeFromIpc(input.runtime),
    profileId: nativeCliAccountProfileIdFromIpc(input.profileId),
  };
}

function broadcastNativeCliAccountsChanged(): void {
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) {
      contents.send("native-cli-accounts:changed");
    }
  }
}

/**
 * Outcomes where the user is already back in Studio — they closed the login
 * terminal, or the prepared plan lapsed before anything launched. Stealing
 * focus for these would be noise rather than a rescue.
 */
function isNativeCliLoginCancellation(error: unknown): boolean {
  if (!(error instanceof NativeCliAccountError)) return false;
  return (
    error.code === "NATIVE_CLI_ACCOUNT_LOGIN_SIGNAL" ||
    error.code === "NATIVE_CLI_ACCOUNT_LOGIN_PLAN_INVALID" ||
    error.code === "NATIVE_CLI_ACCOUNT_LOGIN_PLAN_EXPIRED"
  );
}

async function spawnPreparedNativeCliLogin(
  sender: WebContents,
  input: {
    id?: unknown;
    cols?: unknown;
    rows?: unknown;
    nativeCliLoginToken?: unknown;
  },
): Promise<{
  id: string;
  pid: number;
  startupCommandHandled?: boolean;
  attached?: boolean;
}> {
  const id =
    typeof input?.id === "string" &&
    input.id.length > 0 &&
    input.id.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(input.id)
      ? input.id
      : null;
  if (!id) throw new TypeError("Native CLI login terminal id is invalid.");
  const cols = Number(input.cols);
  const rows = Number(input.rows);
  if (
    !Number.isSafeInteger(cols) ||
    cols < 1 ||
    cols > 1_000 ||
    !Number.isSafeInteger(rows) ||
    rows < 1 ||
    rows > 1_000
  ) {
    throw new TypeError("Native CLI login terminal dimensions are invalid.");
  }
  const launchToken = nativeCliLoginTokenFromIpc(
    input.nativeCliLoginToken,
  );

  let resolveStarted!: (value: {
    id: string;
    pid: number;
    startupCommandHandled?: boolean;
    attached?: boolean;
  }) => void;
  let rejectStarted!: (reason: Error) => void;
  let startSettled = false;
  const started = new Promise<{
    id: string;
    pid: number;
    startupCommandHandled?: boolean;
    attached?: boolean;
  }>((resolve, reject) => {
    resolveStarted = (value) => {
      if (startSettled) return;
      startSettled = true;
      resolve(value);
    };
    rejectStarted = (reason) => {
      if (startSettled) return;
      startSettled = true;
      reject(reason);
    };
  });

  void nativeCliAccounts
    .launchPreparedLogin(launchToken, async (spec) => {
      const launched = await pty.spawnExactExecutable({
        id,
        cwd: app.getPath("home"),
        cols,
        rows,
        webContents: sender,
        executable: spec.executable,
        args: spec.args,
        env: spec.env,
      });
      resolveStarted(launched.spawn);
      const exit = await launched.exit;
      return {
        exitCode: exit.exitCode,
        signal: exit.signal ? "SIGTERM" : null,
        timedOut: false,
        spawnFailed: false,
      };
    })
    .then(
      () => {
        // The CLI sent the user to a browser to authorize; bring the window
        // they started from back in front instead of leaving them there.
        focusStudioWindow(sender);
      },
      (error: unknown) => {
        rejectStarted(
          error instanceof Error
            ? error
            : new Error("Native CLI account login failed."),
        );
        if (!isNativeCliLoginCancellation(error)) focusStudioWindow(sender);
      },
    )
    .finally(() => {
      broadcastNativeCliAccountsChanged();
    });

  return started;
}

const PI_ACCOUNT_PROFILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PI_ACCOUNT_TERMINAL_RUN_STATUSES = new Set<RunState["status"]>([
  "complete",
  "failed",
  "cancelled",
]);
const PI_ACCOUNT_TERMINAL_ATTEMPT_STATUSES = new Set<
  RunState["workerAttempts"][number]["status"]
>(["succeeded", "failed", "timed_out", "cancelled"]);
const PI_ACCOUNT_IN_USE_MESSAGE =
  "This account is still in use by an active Cora run or worker. Finish or cancel that work before deleting it.";

function piSubscriptionProviderFromIpc(value: unknown): PiSubscriptionProvider {
  if (value === "anthropic" || value === "openai-codex") return value;
  throw new TypeError("Unsupported Pi subscription provider");
}

function piAccountProfileIdFromIpc(value: unknown): string {
  if (typeof value !== "string" || !PI_ACCOUNT_PROFILE_ID_PATTERN.test(value)) {
    throw new TypeError("Pi account profile id must be a lowercase UUIDv4");
  }
  return value;
}

function piAccountLabelFromIpc(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new TypeError("Account label must be a string");
  const label = value.trim();
  if (!label) {
    if (!required) return undefined;
    throw new TypeError("Account label cannot be empty");
  }
  return label;
}

function runOwnsActivePiAccountProfile(run: RunState, profileId: string): boolean {
  if (!PI_ACCOUNT_TERMINAL_RUN_STATUSES.has(run.status)) {
    if (run.chatAccountProfileId === profileId) return true;
    // The live selector is next-turn-only. A running chat may therefore have
    // an older actual identity stamped on its durable call after the selector
    // has moved; keep that account until the owning run settles too.
    if (run.sparkCalls.some((call) => call.accountProfileId === profileId)) {
      return true;
    }
  }
  return run.workerAttempts.some(
    (attempt) =>
      attempt.accountProfileId === profileId &&
      !PI_ACCOUNT_TERMINAL_ATTEMPT_STATUSES.has(attempt.status),
  );
}

async function assertPiAccountProfileIsNotActive(profileId: string): Promise<void> {
  try {
    const { listRuns } = await getRunStore();
    const runs = await listRuns();
    if (runs.some((run) => runOwnsActivePiAccountProfile(run, profileId))) {
      throw new Error(PI_ACCOUNT_IN_USE_MESSAGE);
    }
  } catch (error) {
    if (error instanceof Error && error.message === PI_ACCOUNT_IN_USE_MESSAGE) throw error;
    // Deletion is the unsafe branch when durable ownership cannot be read.
    throw new Error(
      "Codara could not verify whether this account is used by an active run. The account was not deleted.",
    );
  }
}

function broadcastPiSubscriptionChanged(provider: PiSubscriptionProvider): void {
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) {
      contents.send("pi-subscriptions:event", { type: "changed", provider });
    }
  }
}

async function inspectAfterPiAccountMetadataChange(
  provider: PiSubscriptionProvider,
): Promise<PiSubscriptionOverview> {
  const [{ invalidatePiSubscriptionUsageCache }, { invalidatePiModelCatalogCache }] =
    await Promise.all([
      import("./orchestration/pi-subscription-usage"),
      import("./orchestration/pi-model-catalog"),
    ]);
  invalidatePiSubscriptionUsageCache();
  invalidatePiModelCatalogCache();
  broadcastPiSubscriptionChanged(provider);
  const { inspectPiSubscriptions } = await getPiSubscriptionAuth();
  return inspectPiSubscriptions();
}

async function deletePiAccountProfileWithRunGuard(
  profileId: string,
): Promise<PiSubscriptionOverview> {
  const { deletePiSubscriptionProfile } = await getPiSubscriptionAuth();
  return deletePiSubscriptionProfile(profileId, {
    ownershipGuard: async (profile) => {
      await assertPiAccountProfileIsNotActive(profile.id);
      return false;
    },
  });
}

import {
  parseCoraWhiteboard,
  parseCoraWhiteboardFile,
  serializeCoraWhiteboardFile,
  whiteboardFileName,
} from "@shared/cora-whiteboard-file";

// A small document glyph used as the drag image for `webContents.startDrag`.
// Windows rejects an empty icon ("Must specify non-empty 'icon' option"), so
// we ship a tiny generated PNG and build the NativeImage once, lazily.
const DRAG_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAcUlEQVR4nO3RMQrAIAyFYc/p1FM59ZjStU4BESpRiz/EPHiLqHwkIXg8ncR4vdr27i8Bcn5UlTft+XZAi0AANQIDCAIFyB8oYCkjgK9um4B9QEr3UO0B8BXgAHwFOABfAQ7QjtwuAF/BuYA/Og3wHJECBKtIBObIWvMAAAAASUVORK5CYII=";
let dragIcon: Electron.NativeImage | null = null;
function getDragIcon(): Electron.NativeImage {
  dragIcon ??= nativeImage.createFromDataURL(DRAG_ICON_DATA_URL);
  return dragIcon;
}

const MAX_PASTED_IMAGE_BYTES = 12 * 1024 * 1024;
const PASTED_IMAGE_EXTENSIONS = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["image/bmp", ".bmp"],
]);

// Callback registered by index.ts so the IPC handler can manipulate the tray
// without creating a circular import (index → ipc is fine; ipc → index would
// cycle). index.ts calls setTrayHook() once after defining ensureTray /
// destroyTray; the handler calls them on keepRunningInBackground changes.
type TrayHook = { ensure: () => void; destroy: () => void };
let _trayHook: TrayHook | null = null;
export function setTrayHook(hook: TrayHook): void {
  _trayHook = hook;
}

// Fan a preferences change out to every live webContents so the main window
// and the settings window stay in sync regardless of which one wrote.
// Exported for the agent-socket's app.prefs.set RPC, which writes through the
// same store and must trigger the same fanout.
export function broadcastPreferencesChanged<K extends PrefKey>(
  change: PreferencesChange<K>,
): void {
  const payload: PreferencesChange = change;
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    wc.send("preferences:changed", payload);
  }
}

// ── Privileged-channel sender gating ────────────────────────────────────────
// Almost every IPC channel here can spawn processes, run arbitrary shell
// commands (pty:write / pty:inject), enable remote access, widen the filesystem
// sandbox, write arbitrary paths, drive git in an arbitrary cwd, or mutate
// preferences. Those must only ever be driven by the app's own trusted
// renderer, never by attacker-controlled content that somehow became a frame of
// a window (or by a preview <webview> guest).
//
// The trust decision (which sender is the main window's current, allowlisted
// main frame) lives in ./main-window-trust so ipc.ts, index.ts, and the
// preview/terminal bridges all key their sender checks off one implementation.
// requireTrustedSender throws for the invoke gate below; isTrustedOnSender
// returns false for the ipcMain.on gates. registerTrustedMainWindow (called by
// index.ts) maintains the "current allowlisted main frame" state that both read.
//
// The gate here is DEFAULT-ON: registrations go through `handle()` below, which
// runs requireTrustedSender before the listener. The rare channel that must
// accept any sender uses `handleOpen()` with a comment justifying it (there are
// none today: only one BrowserWindow exists and the webview inspector preload
// exposes no ipcRenderer.invoke, so no non-main-window sender can reach these
// channels at all).

// Mirror Electron's own ipcMain.handle listener signature exactly (its args are
// `...args: any[]`), so every existing typed listener stays assignable through
// the wrapper without widening or casting at 200 call sites.
type InvokeListener = Parameters<typeof ipcMain.handle>[1];

// Gate-by-default registration. Every channel registered through `handle`
// requires the trusted main-window sender BEFORE its listener runs. This is the
// only registration path used in registerIpc, so a newly-added channel cannot
// silently land ungated (see scripts/test-ipc-gate-default.cjs, which fails the
// build if a raw ipcMain.handle appears in any main-process file, or an
// ipcMain.on registration whose body does not consult the sender gate).
function handle(channel: string, listener: InvokeListener): void {
  ipcMain.handle(channel, (event, ...args) => {
    requireTrustedSender(event, channel);
    return listener(event, ...args);
  });
}

// Explicit, commented opt-out: NOT gated, for the (currently empty) set of
// channels that must accept a non-main-window sender. Kept as a distinct,
// greppable entry point so every ungated channel is auditable at a glance and
// the gate-by-default test can enumerate the opt-outs. If you reach for this,
// justify it in a comment at the call site. `void handleOpen` below marks it
// used while the opt-out set is empty, so it stays available without a lint
// error.
function handleOpen(channel: string, listener: InvokeListener): void {
  ipcMain.handle(channel, listener);
}
void handleOpen;

export function registerIpc(): void {
  handle("state:load", async (): Promise<AppState> => {
    return loadState();
  });

  handle("state:save", async (event, state: AppState): Promise<void> => {
    // Persisting workspaces re-seeds the fs sandbox allowlist (below), so this
    // channel can widen readable roots. It is gated to the trusted renderer by
    // default via handle() (see the sender-gating section above).
    await saveState(state);
    // Refresh the fs sandbox allowlist whenever workspaces change. The
    // renderer also pushes via ui:setAllowedRoots, but updating here means a
    // newly-added workspace is reachable the instant it's persisted, even
    // before the renderer effect that calls setAllowedRoots fires.
    const roots = state.workspaces
      .flatMap((w) => [w.cwd, ...(w.extraFolders ?? [])])
      .filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0);
    setAllowedRoots(roots);
  });

  handle("settings:load", async (): Promise<AppSettings> => {
    return loadSettings();
  });

  handle("settings:save", async (_e, settings: AppSettings): Promise<AppSettings> => {
    return saveSettings(settings);
  });

  handle(
    "native-cli-accounts:inspect",
    async (): Promise<NativeCliAccountsInspection> => {
      return nativeCliAccounts.inspect();
    },
  );
  handle(
    "native-cli-accounts:create",
    async (
      _event,
      rawInput: Partial<NativeCliAccountCreateInput> | null,
    ): Promise<NativeCliAccountMutationResult> => {
      const input: NativeCliAccountCreateInput = {
        runtime: nativeCliAccountRuntimeFromIpc(rawInput?.runtime),
        label: nativeCliAccountLabelFromIpc(rawInput?.label),
      };
      const result = await nativeCliAccounts.create(input);
      broadcastNativeCliAccountsChanged();
      return result;
    },
  );
  handle(
    "native-cli-accounts:rename",
    async (
      _event,
      rawInput: Partial<NativeCliAccountRenameInput> | null,
    ): Promise<NativeCliAccountMutationResult> => {
      const profile = nativeCliAccountProfileInputFromIpc(rawInput);
      const input: NativeCliAccountRenameInput = {
        ...profile,
        label: nativeCliAccountLabelFromIpc(rawInput?.label),
      };
      const result = await nativeCliAccounts.rename(input);
      broadcastNativeCliAccountsChanged();
      return result;
    },
  );
  handle(
    "native-cli-accounts:set-default",
    async (
      _event,
      rawInput: Partial<NativeCliAccountProfileInput> | null,
    ): Promise<NativeCliAccountMutationResult> => {
      const result = await nativeCliAccounts.setDefault(
        nativeCliAccountProfileInputFromIpc(rawInput),
      );
      broadcastNativeCliAccountsChanged();
      return result;
    },
  );
  handle(
    "native-cli-accounts:prepare-login",
    async (
      _event,
      rawInput: Partial<NativeCliAccountProfileInput> | null,
    ): Promise<NativeCliAccountLoginPreparation> => {
      return nativeCliAccounts.prepareLogin(
        nativeCliAccountProfileInputFromIpc(rawInput),
      );
    },
  );
  handle(
    "native-cli-accounts:cancel-login",
    async (
      _event,
      rawInput: Partial<NativeCliAccountCancelLoginInput> | null,
    ): Promise<boolean> => {
      const cancelled = await nativeCliAccounts.cancelPreparedLogin(
        nativeCliLoginTokenFromIpc(rawInput?.launchToken),
      );
      if (cancelled) broadcastNativeCliAccountsChanged();
      return cancelled;
    },
  );
  handle(
    "native-cli-accounts:logout",
    async (
      _event,
      rawInput: Partial<NativeCliAccountProfileInput> | null,
    ): Promise<NativeCliAccountsInspection> => {
      await nativeCliAccounts.logout(
        nativeCliAccountProfileInputFromIpc(rawInput),
      );
      broadcastNativeCliAccountsChanged();
      return nativeCliAccounts.inspect();
    },
  );
  handle(
    "native-cli-accounts:delete",
    async (
      _event,
      rawInput: Partial<NativeCliAccountProfileInput> | null,
    ): Promise<NativeCliAccountDeleteResult> => {
      const result = await nativeCliAccounts.delete(
        nativeCliAccountProfileInputFromIpc(rawInput),
      );
      broadcastNativeCliAccountsChanged();
      return result;
    },
  );

  // READ-ONLY: reports whether a shell startup file still carries the block
  // the retired "Active account in your terminal" feature appended, so the
  // Accounts panel can tell the user how to delete it themselves. Codara no
  // longer writes to shell startup files anywhere.
  handle(
    "native-cli-shell-leftover:status",
    async (): Promise<NativeCliShellProfileLeftover | null> => {
      return detectNativeCliShellProfileLeftover();
    },
  );

  handle("pi-subscriptions:status", async () => {
    const { inspectPiSubscriptions } = await getPiSubscriptionAuth();
    return inspectPiSubscriptions();
  });
  handle("pi-subscriptions:connect", async (event, input?: { provider?: unknown }) => {
    const { startPiSubscriptionLogin } = await getPiSubscriptionAuth();
    return startPiSubscriptionLogin(input?.provider, event.sender);
  });
  handle(
    "pi-subscriptions:add-account",
    async (event, input?: Partial<PiSubscriptionAddAccountInput>) => {
      const provider = piSubscriptionProviderFromIpc(input?.provider);
      const label = piAccountLabelFromIpc(input?.label, false);
      const { startPiSubscriptionProfileLogin } = await getPiSubscriptionAuth();
      return startPiSubscriptionProfileLogin(
        {
          provider,
          ...(label ? { label } : {}),
        },
        event.sender,
      );
    },
  );
  handle(
    "pi-subscriptions:reconnect-account",
    async (event, input?: Partial<PiSubscriptionReconnectAccountInput>) => {
      const provider = piSubscriptionProviderFromIpc(input?.provider);
      const profileId = piAccountProfileIdFromIpc(input?.profileId);
      const { startPiSubscriptionProfileLogin } = await getPiSubscriptionAuth();
      return startPiSubscriptionProfileLogin(
        { provider, profileId },
        event.sender,
      );
    },
  );
  handle(
    "pi-subscriptions:rename-account",
    async (_event, input?: Partial<PiSubscriptionRenameAccountInput>) => {
      const profileId = piAccountProfileIdFromIpc(input?.profileId);
      const label = piAccountLabelFromIpc(input?.label, true)!;
      const { renamePiAccountProfile } = await getPiSubscriptionAuth();
      const profile = await renamePiAccountProfile(profileId, label);
      return inspectAfterPiAccountMetadataChange(profile.provider);
    },
  );
  handle(
    "pi-subscriptions:make-default",
    async (_event, input?: Partial<PiSubscriptionMakeDefaultInput>) => {
      const provider = piSubscriptionProviderFromIpc(input?.provider);
      const profileId = piAccountProfileIdFromIpc(input?.profileId);
      const { setDefaultPiAccountProfile } = await getPiSubscriptionAuth();
      await setDefaultPiAccountProfile(provider, profileId);
      return inspectAfterPiAccountMetadataChange(provider);
    },
  );
  handle(
    "pi-subscriptions:delete-account",
    async (_event, input?: Partial<PiSubscriptionDeleteAccountInput>) => {
      const profileId = piAccountProfileIdFromIpc(input?.profileId);
      return deletePiAccountProfileWithRunGuard(profileId);
    },
  );
  handle(
    "pi-subscriptions:respond",
    async (event, input?: { requestId?: unknown; promptId?: unknown; value?: unknown }) => {
      const { answerPiSubscriptionPrompt } = await getPiSubscriptionAuth();
      answerPiSubscriptionPrompt(input ?? {}, event.sender);
    },
  );
  handle("pi-subscriptions:cancel", async (event, input?: { requestId?: unknown }) => {
    const { cancelPiSubscriptionLogin } = await getPiSubscriptionAuth();
    cancelPiSubscriptionLogin(input?.requestId, event.sender);
  });
  handle("pi-subscriptions:disconnect", async (_event, input?: { provider?: unknown }) => {
    const provider = piSubscriptionProviderFromIpc(input?.provider);
    const { inspectPiSubscriptions } = await getPiSubscriptionAuth();
    const overview = await inspectPiSubscriptions();
    const target =
      overview.profiles?.find(
        (profile) => profile.provider === provider && profile.isDefault,
      ) ??
      overview.profiles?.find((profile) => profile.provider === provider);
    return target
      ? deletePiAccountProfileWithRunGuard(target.id)
      : overview;
  });
  handle("pi-runtime:install", async (event) => {
    const { installPiRuntimeForWindow } = await getPiSubscriptionAuth();
    return installPiRuntimeForWindow(event.sender);
  });
  handle("pi-subscriptions:usage", async (_event, input?: { force?: unknown }) => {
    const { inspectPiSubscriptionUsage } = await import("./orchestration/pi-subscription-usage");
    return inspectPiSubscriptionUsage(input?.force === true);
  });
  // Lazily imported like the pi-subscription handlers: the scanner pulls in the
  // transcript readers and the persisted memo, none of which is worth loading
  // for a session that never opens the Usage tab.
  handle("usage-analytics:summary", async (_event, input: UsageSummaryInput) => {
    const { readUsageSummary } = await import("./usage-analytics");
    return readUsageSummary(input);
  });
  handle("pi-models:catalog", async (_event, input?: { force?: unknown }) => {
    const { inspectPiModelCatalog } = await import("./orchestration/pi-model-catalog");
    return inspectPiModelCatalog(input?.force === true);
  });

  handle(
    "agents:runtimes",
    async (_e, input?: { force?: boolean }) => {
      return detectAgentRuntimes(Boolean(input?.force));
    },
  );
  handle(
    "agents:sync",
    async (_e, input?: { cwd?: string | null }) => {
      const { syncAgentAssets } = await getAgentSync();
      const result = await syncAgentAssets({ cwd: input?.cwd ?? null });
      // Sync is also the manual repair path for the built-in: an entry stranded
      // by a moved install (command path gone) is rewritten to the current app
      // path here instead of waiting for the next launch. Repair only: a runtime
      // the user removed the built-in from must not get it back from a sync
      // click, so nothing is reported for it either.
      const settings = await loadSettings();
      if (settings.playwrightMcpAutoInstall !== false) {
        try {
          const { repairSparkBuiltinEntries, SPARK_BUILTIN_SERVER_NAME } = mcpInstaller;
          const repaired = await repairSparkBuiltinEntries();
          if (repaired.claude) result.mcp.toClaude.push(SPARK_BUILTIN_SERVER_NAME);
          if (repaired.codex) result.mcp.toCodex.push(SPARK_BUILTIN_SERVER_NAME);
        } catch (err) {
          result.mcp.errors.push(
            `Could not refresh the built-in MCP entry: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return result;
    },
  );
  handle(
    "agents:assets",
    async (_e, input?: { cwd?: string | null }) => {
      const { listAgentAssets } = await getAgentSync();
      return listAgentAssets({ cwd: input?.cwd ?? null, settings: await loadSettings() });
    },
  );
  handle(
    "agents:deleteAsset",
    async (_e, input: { id: string }) => {
      const { deleteAgentAsset } = await getAgentSync();
      return deleteAgentAsset({ id: input.id });
    },
  );
  handle(
    "agents:installAsset",
    async (_e, input: { id: string; target: "claude" | "codex" }) => {
      const { installAgentAssetToRuntime } = await getAgentSync();
      return installAgentAssetToRuntime({ id: input.id, target: input.target });
    },
  );
  handle(
    "agents:mcpTargets",
    async (_e, input?: { cwd?: string | null }) => {
      const { listMcpWriteTargets } = await getAgentSync();
      return listMcpWriteTargets({ cwd: input?.cwd ?? null });
    },
  );
  handle(
    "agents:mcpDetail",
    async (_e, input: { id: string }) => {
      const { readMcpServerDetail } = await getAgentSync();
      return readMcpServerDetail({ id: input.id });
    },
  );
  handle(
    "agents:saveMcpServer",
    async (
      _e,
      input: {
        cwd?: string | null;
        targetId: string;
        server: AgentMcpServerDraft;
        replaceId?: string | null;
      },
    ) => {
      const { saveMcpServer } = await getAgentSync();
      return saveMcpServer({
        cwd: input.cwd ?? null,
        targetId: input.targetId,
        server: input.server,
        replaceId: input.replaceId ?? null,
      });
    },
  );
  handle("agents:builtins", async () => {
    const [{ getSparkBuiltinStatus }, runtimes, settings] = await Promise.all([
      mcpInstaller,
      detectAgentRuntimes(false),
      loadSettings(),
    ]);
    const isAvailable = (kind: "claude" | "codex") =>
      runtimes.some((r) => r.kind === kind && r.installed);
    return getSparkBuiltinStatus({
      claudeRuntimeAvailable: isAvailable("claude"),
      codexRuntimeAvailable: isAvailable("codex"),
      autoInstallEnabled: settings.playwrightMcpAutoInstall !== false,
    });
  });
  handle(
    "agents:installBuiltin",
    async (_e, input: { id: SparkBuiltinMcpId; runtime: SparkBuiltinRuntime }) => {
      const { installSparkBuiltin } = mcpInstaller;
      return installSparkBuiltin(input.id, input.runtime);
    },
  );
  handle(
    "agents:uninstallBuiltin",
    async (_e, input: { id: SparkBuiltinMcpId; runtime: SparkBuiltinRuntime }) => {
      const { uninstallSparkBuiltin } = mcpInstaller;
      return uninstallSparkBuiltin(input.id, input.runtime);
    },
  );

  handle("preferences:load", async (): Promise<AppPreferences> => {
    return loadPreferences();
  });

  handle(
    "preferences:set",
    async <K extends PrefKey>(
      event: Electron.IpcMainInvokeEvent,
      args: { key: K; value: AppPreferences[K] },
    ): Promise<AppPreferences> => {
      const next = await setPreference(args.key, args.value);
      broadcastPreferencesChanged({ key: args.key, value: next[args.key] });
      // Reflect keepRunningInBackground changes in the tray immediately so the
      // user doesn't have to restart the app to see the menu-bar icon appear or
      // disappear. The hook is registered by index.ts after ensureTray /
      // destroyTray are defined; it's null if somehow called before that.
      if (args.key === "keepRunningInBackground" && _trayHook) {
        if (args.value) {
          _trayHook.ensure();
        } else {
          _trayHook.destroy();
        }
      }
      return next;
    },
  );

  // Cora's writable memory. The markdown files are the source of truth and the
  // user edits them in the editor, so these three channels only report on them
  // and toggle/clear a whole tier. Every one resolves to the fresh status PAIR,
  // including the mutations, so the Capability Center never has to re-read.
  handle(
    "memory:get",
    async (_e, input?: MemoryStatusInput): Promise<CoraMemoryStatus> => {
      return readMemoryStatus(input?.workspaceId ?? null);
    },
  );

  handle(
    "memory:setEnabled",
    async (_e, input: MemorySetEnabledInput): Promise<CoraMemoryStatus> => {
      const workspaceId = requireMemoryWorkspace(input.scope, input.workspaceId);
      const { setMemoryEnabled } = coraMemory;
      await setMemoryEnabled(input.scope, workspaceId, input.enabled);
      return readMemoryStatus(input.workspaceId ?? null);
    },
  );

  handle(
    "memory:clear",
    async (_e, input: MemoryClearInput): Promise<CoraMemoryStatus> => {
      const workspaceId = requireMemoryWorkspace(input.scope, input.workspaceId);
      const { clearMemory } = coraMemory;
      // The user's own lines survive unless the caller opted in explicitly:
      // a missing flag must never be read as permission to delete them.
      await clearMemory(input.scope, workspaceId, input.includeUserLines === true);
      return readMemoryStatus(input.workspaceId ?? null);
    },
  );

  // Inline-AI editor autocomplete proxy. Renderer-side fetch to OpenRouter
  // hits CORS in dev; routing through main bypasses that.
  handle(
    "inline-ai:complete",
    async (_e, req: InlineAiCompletionRequest): Promise<InlineAiCompletionResponse> => {
      const { runInlineAiCompletion } = await getInlineAi();
      return runInlineAiCompletion(req);
    },
  );
  handle("inline-ai:abort", async (_e, requestId: string): Promise<void> => {
    const { abortInlineAiCompletion } = await getInlineAi();
    abortInlineAiCompletion(requestId);
  });

  handle("shells:list", async (): Promise<ShellInfo[]> => {
    return listShells();
  });

  handle("shells:default", async (): Promise<ShellInfo | null> => {
    return defaultShell();
  });

  handle("shells:integratedDefault", async (): Promise<ShellInfo> => {
    // Materializes the bundled OSC 7/133/633/8888 shell-integration scripts
    // into ~/.cache/spark/shell-integration/ and returns a ShellInfo whose
    // args/env wire the shell to dot-source them on startup. Used by the
    // bottom-strip terminal so a fresh interactive pane gets cwd/prompt/
    // open-file markers without modifying the orchestration shell list.
    const launch = await buildIntegratedShellLaunch();
    return {
      id: launch.exe,
      label: launch.label,
      exe: launch.exe,
      args: launch.args,
      family: launch.family,
      env: launch.env,
    };
  });

  handle("dialog:openDirectory", async (e, defaultPath?: string): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(win!, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: defaultPath || app.getPath("home"),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });


  handle("dialog:openSshKey", async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(win!, {
      title: "Import SSH key",
      properties: ["openFile", "showHiddenFiles"],
      defaultPath: join(app.getPath("home"), ".ssh"),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  handle(
    "dialog:exportWhiteboard",
    async (e, input: ExportCoraWhiteboardFileInput): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const board = parseCoraWhiteboard(input?.board);
      const suggestedName = whiteboardFileName(input?.suggestedName || board.title);
      const result = await dialog.showSaveDialog(win!, {
        title: "Export Cora whiteboard",
        defaultPath: input?.defaultPath || join(app.getPath("documents"), suggestedName),
        filters: [{ name: "Codara Whiteboard", extensions: ["coraboard"] }],
      });
      if (result.canceled || !result.filePath) return null;
      const destination = result.filePath.toLowerCase().endsWith(".coraboard")
        ? result.filePath
        : `${result.filePath}.coraboard`;
      await fs.writeFile(destination, serializeCoraWhiteboardFile(board), "utf8");
      return destination;
    },
  );

  handle(
    "dialog:importWhiteboard",
    async (e, defaultPath?: string): Promise<ImportedCoraWhiteboardFile | null> => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const result = await dialog.showOpenDialog(win!, {
        title: "Import Cora whiteboard",
        properties: ["openFile"],
        defaultPath: defaultPath || app.getPath("documents"),
        filters: [
          { name: "Codara Whiteboard", extensions: ["coraboard"] },
          { name: "JSON", extensions: ["json"] },
        ],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const path = result.filePaths[0];
      const stat = await fs.stat(path);
      if (stat.size > 4 * 1024 * 1024) throw new Error("Whiteboard files must be smaller than 4 MB.");
      const board = parseCoraWhiteboardFile(await fs.readFile(path, "utf8"));
      return { path, board };
    },
  );

  // Generic dialog-based export: prompt for a destination and write a
  // renderer-produced payload (board SVG/PNG images today). One narrow channel
  // instead of one IPC surface per format; the extension is forced onto the
  // chosen name exactly like dialog:exportWhiteboard does for .coraboard.
  handle(
    "dialog:exportFile",
    async (e, input: ExportFileDialogInput): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (typeof input?.data !== "string") throw new Error("Export payload must be a string.");
      if (input.data.length > 64 * 1024 * 1024) throw new Error("Export payload is too large.");
      const filters = (Array.isArray(input.filters) ? input.filters : []).filter(
        (filter) =>
          filter &&
          typeof filter.name === "string" &&
          Array.isArray(filter.extensions) &&
          filter.extensions.every((ext) => typeof ext === "string" && /^[a-z0-9]+$/i.test(ext)) &&
          filter.extensions.length > 0,
      );
      if (filters.length === 0) throw new Error("Export requires at least one file filter.");
      const extensions = filters.flatMap((filter) => filter.extensions.map((ext) => ext.toLowerCase()));
      const result = await dialog.showSaveDialog(win!, {
        title: input.title || "Export file",
        defaultPath:
          input.defaultPath ||
          join(app.getPath("documents"), input.suggestedName || `export.${extensions[0]}`),
        filters,
      });
      if (result.canceled || !result.filePath) return null;
      const lower = result.filePath.toLowerCase();
      const destination = extensions.some((ext) => lower.endsWith(`.${ext}`))
        ? result.filePath
        : `${result.filePath}.${extensions[0]}`;
      if (input.encoding === "base64") {
        await fs.writeFile(destination, Buffer.from(input.data, "base64"));
      } else {
        await fs.writeFile(destination, input.data, "utf8");
      }
      return destination;
    },
  );

  handle(
    "attachments:savePastedImage",
    async (_e, input: { dataUrl?: unknown; name?: unknown }): Promise<string> => {
      const parsed = parsePastedImageDataUrl(input?.dataUrl);
      const ext = PASTED_IMAGE_EXTENSIONS.get(parsed.mimeType);
      if (!ext) throw new Error("Unsupported pasted image type.");
      if (parsed.buffer.byteLength > MAX_PASTED_IMAGE_BYTES) {
        throw new Error("Pasted image is too large.");
      }

      const dir = join(app.getPath("userData"), "pasted-images");
      await fs.mkdir(dir, { recursive: true });
      const path = join(dir, `${Date.now()}-${randomUUID()}-${pastedImageStem(input?.name)}${ext}`);
      await fs.writeFile(path, parsed.buffer, { flag: "wx" });
      return path;
    },
  );

  // Save a draw-mode screenshot (page capture + freehand annotation, both
  // already composited in the renderer) under <tmp>/spark-drawings as a PNG.
  // Returning the path — not the base64 bytes — keeps the chat message small
  // and lets Claude Code use its native image-read tool on the file. Inputs
  // are validated as a `data:image/png;base64,...` URL; everything else is
  // rejected so a compromised webview can't drop arbitrary bytes on disk.
  handle(
    "drawing:save",
    async (_e, input: { dataUrl?: unknown }): Promise<string> => {
      const value = input?.dataUrl;
      if (typeof value !== "string") throw new Error("Missing drawing data.");
      const match = value.match(/^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/);
      if (!match) throw new Error("Drawing must be a PNG data URL.");
      const buffer = Buffer.from(match[1].replace(/\s/g, ""), "base64");
      if (buffer.byteLength === 0) throw new Error("Drawing is empty.");
      if (buffer.byteLength > MAX_PASTED_IMAGE_BYTES) {
        throw new Error("Drawing is too large.");
      }
      const dir = join(tmpdir(), "spark-drawings");
      await fs.mkdir(dir, { recursive: true });
      const path = join(dir, `${Date.now()}-${randomUUID()}.png`);
      await fs.writeFile(path, buffer, { flag: "wx" });
      return path;
    },
  );

  // Read-path sandbox: each handler below rejects paths outside the active
  // workspace roots + a small static allowlist (see fs-sandbox.ts). Write/
  // create/delete handlers further down are intentionally NOT gated — they
  // have a different attack surface and broader internal use; future work can
  // extend the sandbox to those if needed.
  handle("fs:list", async (_e, dir: string) => {
    await assertAllowedReadPathResolved(dir);
    return listDir(dir);
  });

  handle("fs:listFiles", async (_e, root: string): Promise<FileListResult> => {
    await assertAllowedReadPathResolved(root);
    return listFiles(root);
  });

  handle("fs:readText", async (_e, path: string): Promise<FsFileContent> => {
    await assertAllowedReadPathResolved(path);
    return readTextFile(path);
  });

  handle(
    "fs:readTextTail",
    async (_e, args: { path: string; maxBytes: number }): Promise<FsFileContent> => {
      await assertAllowedReadPathResolved(args.path);
      return readTextFileTail(args.path, args.maxBytes);
    },
  );

  handle("fs:readEx", async (_e, path: string): Promise<FsReadResult> => {
    await assertAllowedReadPathResolved(path);
    return readFileEx(path);
  });

  // Existence probe for the terminal link provider's ctrl/cmd-click feature.
  // Resolves `target` against an optional `baseDir` (the terminal pane's
  // tracked cwd), then checks via fs.stat. Sandboxed against the same
  // allow-list as the other read primitives so a hostile pty can't make the
  // renderer probe arbitrary disk locations.
  handle(
    "fs:pathExists",
    async (
      _e,
      args: { target: string; baseDir?: string },
    ): Promise<{ exists: boolean; isFile: boolean; resolved: string }> => {
      const target = typeof args?.target === "string" ? args.target : "";
      if (!target) return { exists: false, isFile: false, resolved: "" };
      const base =
        typeof args?.baseDir === "string" && args.baseDir.length > 0
          ? args.baseDir
          : undefined;
      // Terminal ctrl-click link probing is a local-fs feature; for a remote
      // pane the base cwd is a ssh:// path and there's nothing local to stat.
      if (isRemotePath(target) || (base && isRemotePath(base))) {
        return { exists: false, isFile: false, resolved: target };
      }
      const resolved = base ? join(base, target) : target;
      try {
        await assertAllowedReadPathResolved(resolved);
      } catch {
        return { exists: false, isFile: false, resolved };
      }
      try {
        const stat = await fs.stat(resolved);
        return { exists: true, isFile: stat.isFile(), resolved };
      } catch {
        return { exists: false, isFile: false, resolved };
      }
    },
  );


  handle(
    "fs:statFile",
    async (_e, path: string): Promise<{ size: number; mtimeMs: number }> => {
      await assertAllowedReadPathResolved(path);
      return statFile(path);
    },
  );

  handle("fs:readFileBytes", async (_e, path: string): Promise<Uint8Array> => {
    await assertAllowedReadPathResolved(path);
    return readFileBytes(path);
  });

  handle(
    "fs:writeText",
    async (
      event,
      args: { path: string; content: string; expectedMtimeMs?: number },
    ): Promise<FsWriteResult> => {
      // Write/create/delete/rename/import/move take arbitrary destination paths
      // and are intentionally NOT read-sandboxed; they rely on the default-on
      // sender gate (handle()) to keep untrusted content out instead.
      return writeTextFile(
        args.path,
        args.content,
        typeof args.expectedMtimeMs === "number" ? { expectedMtimeMs: args.expectedMtimeMs } : undefined,
      );
    },
  );

  handle("fs:renameFile", async (event, args: RenameFileInput): Promise<FsEntry> => {
    return renameFile(args.path, args.newName);
  });

  handle("fs:deleteFile", async (event, path: string): Promise<void> => {
    await deleteFile(path);
  });

  // Undoable delete: the entry moves into the app-owned delete stash instead
  // of the OS trash, so fs:undoDelete can restore it. Evicted/stale stash
  // entries end up in the OS trash via fs:purgeDeleteStash (and the startup
  // sweep below), so delete still ultimately means "goes to trash".
  handle("fs:deleteToStash", async (event, path: string) => {
    return deleteToStash(path);
  });

  handle(
    "fs:undoDelete",
    async (event, args: { token: string; originalPath: string }) => {
      if (typeof args?.token !== "string" || typeof args?.originalPath !== "string") {
        throw new Error("Invalid undo request.");
      }
      return undoDeleteFromStash(args.token, args.originalPath);
    },
  );

  handle("fs:purgeDeleteStash", async (event, tokens: string[]): Promise<void> => {
    const list = Array.isArray(tokens)
      ? tokens.filter((t): t is string => typeof t === "string")
      : [];
    await purgeDeleteStash(list);
  });

  // Leftover stash entries from a previous session (crash, or undo history
  // that was never consumed) move on to the OS trash at startup.
  void purgeDeleteStash().catch(() => undefined);

  handle("fs:createFile", async (event, args: CreateEntryInput): Promise<FsEntry> => {
    return createFile(args.parentPath, args.name);
  });

  handle("fs:createFolder", async (event, args: CreateEntryInput): Promise<FsEntry> => {
    return createFolder(args.parentPath, args.name);
  });

  // Import external files/folders dropped onto the Explorer. The DESTINATION
  // is gated by the read sandbox so a hostile renderer can't make Codara write
  // a copy outside the open workspaces; the sources can live anywhere on disk
  // (that's the whole point of importing them in).
  handle(
    "fs:importEntries",
    async (event, args: { destDir: string; sourcePaths: string[] }): Promise<FsEntry[]> => {
      const destDir = typeof args?.destDir === "string" ? args.destDir : "";
      if (!destDir) throw new Error("Missing import destination.");
      await assertAllowedReadPathResolved(destDir);
      const sourcePaths = Array.isArray(args?.sourcePaths)
        ? args.sourcePaths.filter((p): p is string => typeof p === "string" && p.length > 0)
        : [];
      if (sourcePaths.length === 0) return [];
      return importEntries(destDir, sourcePaths);
    },
  );

  // Move workspace files/folders into another workspace directory (drag-and-drop
  // MOVE). Both the destination AND every source are gated by the read sandbox:
  // unlike importEntries — whose sources may live anywhere on disk because it
  // only copies — a move DELETES from the source location, so each source must
  // already sit inside an allowed workspace root.
  handle(
    "fs:moveEntries",
    async (event, args: { destDir: string; sourcePaths: string[] }): Promise<FsEntry[]> => {
      const destDir = typeof args?.destDir === "string" ? args.destDir : "";
      if (!destDir) throw new Error("Missing move destination.");
      await assertAllowedReadPathResolved(destDir);
      const sourcePaths = Array.isArray(args?.sourcePaths)
        ? args.sourcePaths.filter((p): p is string => typeof p === "string" && p.length > 0)
        : [];
      if (sourcePaths.length === 0) return [];
      for (const src of sourcePaths) await assertAllowedReadPathResolved(src);
      return moveEntries(destDir, sourcePaths);
    },
  );

  // Native OS drag-out: the renderer's `dragstart` on an Explorer row sends the
  // selected file paths here, and we hand them to Chromium's drag machinery so
  // the user can drop them onto the desktop, another app, etc. Fire-and-forget
  // (`ipcMain.on`) because `webContents.startDrag` returns nothing and must run
  // on the sender's own contents while the drag gesture is live.
  ipcMain.on(
    "fs:startDrag",
    (e, paths: unknown, icon?: { dataUrl?: unknown; scaleFactor?: unknown }) => {
      // Starts an OS drag of arbitrary paths on behalf of the sender; gate it to
      // the trusted main frame like the invoke channels.
      if (!isTrustedOnSender(e, "fs:startDrag")) return;
      const files = Array.isArray(paths)
        ? paths.filter((p): p is string => typeof p === "string" && p.length > 0)
        : typeof paths === "string" && paths.length > 0
          ? [paths]
          : [];
      if (files.length === 0) return;
      // Optional renderer-drawn drag badge (name + count chip). Registered at
      // the renderer's devicePixelRatio so it stays crisp on retina. Falls back
      // to the built-in glyph on any malformed payload.
      let dragImage = getDragIcon();
      if (
        typeof icon?.dataUrl === "string" &&
        icon.dataUrl.startsWith("data:image/png;base64,") &&
        icon.dataUrl.length < 1024 * 1024
      ) {
        try {
          const scale =
            typeof icon.scaleFactor === "number" && icon.scaleFactor >= 1 && icon.scaleFactor <= 4
              ? icon.scaleFactor
              : 1;
          const img = nativeImage.createEmpty();
          img.addRepresentation({ scaleFactor: scale, dataURL: icon.dataUrl });
          if (!img.isEmpty()) dragImage = img;
        } catch {
          // Keep the fallback glyph.
        }
      }
      try {
        e.sender.startDrag({
          // `file` is the legacy single-path field some platforms still read;
          // `files` carries the full (possibly multi-) selection.
          file: files[0],
          files,
          icon: dragImage,
        });
      } catch (err) {
        console.warn("[main] fs:startDrag failed:", err);
      }
    },
  );

  handle("fs:addWatchRoot", async (e, root: string): Promise<void> => {
    // Remote (ssh://) roots have no local fs.watch — the git panel's 10s poll
    // + manual refresh cover change detection, exactly as on Linux where
    // recursive fs.watch is unavailable. No-op here so nothing throws.
    if (isRemotePath(root)) return;
    // Gate only the root path here; downstream watcher events do not need a
    // per-event check (they all fire inside the gated root).
    await assertAllowedReadPathResolved(root);
    await fsWatcher.addWatchRoot(e.sender, root);
  });

  handle("fs:removeWatchRoot", async (e, root: string): Promise<void> => {
    fsWatcher.removeWatchRoot(e.sender, root);
  });

  // The renderer is authoritative about which workspaces are open, but the
  // sandbox lives in main. Renderer pushes the cwd list whenever it changes;
  // main treats the list as the source of truth for read-path checks.
  handle("ui:setAllowedRoots", async (event, roots: unknown): Promise<void> => {
    // This directly sets the fs read-sandbox allowlist, so only the trusted
    // renderer may call it.
    if (!Array.isArray(roots)) return;
    const cleaned = roots.filter((r): r is string => typeof r === "string" && r.length > 0);
    setAllowedRoots(cleaned);
  });

  handle("fs:revealInOS", async (_e, path: string): Promise<void> => {
    // No OS file manager for a path on a remote host — silently ignore.
    if (isRemotePath(path)) return;
    try {
      const stat = await fs.stat(path);
      if (stat.isDirectory()) {
        await shell.openPath(path);
        return;
      }
    } catch {
      // Fall through to showItemInFolder so callers still get the OS-level
      // behavior for missing paths or paths that disappeared between clicks.
    }
    shell.showItemInFolder(path);
  });

  handle("git:status", async (_e, cwd: string): Promise<GitStatus> => {
    const { getGitStatus } = await getGitOps();
    return getGitStatus(cwd);
  });

  handle("git:log", async (_e, cwd: string): Promise<GitLog> => {
    const { getGitLog } = await getGitOps();
    return getGitLog(cwd);
  });

  handle("github:status", async (_e, cwd: unknown): Promise<GitHubWorkspaceStatus> => {
    if (typeof cwd !== "string" || !cwd.trim() || cwd.length > 16_384) {
      return {
        kind: "error",
        message: "GitHub status requires a valid local workspace.",
      };
    }
    if (isRemotePath(cwd)) {
      return {
        kind: "unavailable",
        message: "GitHub status is currently available for local workspaces only.",
      };
    }
    const { readGitHubWorkspaceStatus } = await getGitHubCli();
    return readGitHubWorkspaceStatus(cwd);
  });

  handle(
    "github:workQueue",
    async (_e, request?: unknown): Promise<GitHubWorkQueueStatus> => {
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        return {
          kind: "error",
          message: "The GitHub work queue requires an active workspace.",
        };
      }
      const candidate = request as {
        sourceWorkspaceId?: unknown;
        refresh?: unknown;
      };
      const sourceWorkspaceId =
        typeof candidate.sourceWorkspaceId === "string"
          ? candidate.sourceWorkspaceId.trim()
          : "";
      if (!sourceWorkspaceId || sourceWorkspaceId.length > 256) {
        return {
          kind: "error",
          message: "The GitHub work queue requires a valid active workspace.",
        };
      }
      const queue = await import("./github-work-queue");
      if (candidate.refresh === true) queue.invalidateGitHubWorkQueueCache();
      return queue.readGitHubWorkQueue(undefined, { sourceWorkspaceId });
    },
  );

  handle(
    "github:publish",
    async (
      _e,
      request: { cwd?: unknown; input?: GitHubPublishInput } | null,
    ): Promise<GitHubPublishResult> => {
      const cwd = request?.cwd;
      if (typeof cwd !== "string" || !cwd.trim() || cwd.length > 16_384) {
        throw new Error("GitHub publish requires a valid local workspace.");
      }
      if (isRemotePath(cwd)) {
        throw new Error(
          "Publishing pull requests is currently available for local workspaces only.",
        );
      }
      const { publishGitHubWorktree } = await getGitHubPublish();
      return publishGitHubWorktree(cwd, request?.input);
    },
  );
  handle(
    "github:markReady",
    async (
      _e,
      request: { cwd?: unknown; input?: GitHubMarkReadyInput } | null,
    ): Promise<GitHubMarkReadyResult> => {
      const cwd = request?.cwd;
      if (typeof cwd !== "string" || !cwd.trim() || cwd.length > 16_384) {
        throw new Error("Marking a GitHub pull request ready requires a valid local workspace.");
      }
      if (isRemotePath(cwd)) {
        throw new Error(
          "Marking pull requests ready is currently available for local workspaces only.",
        );
      }
      const { markGitHubPullRequestReady } = await getGitHubReady();
      return markGitHubPullRequestReady(cwd, request?.input);
    },
  );
  handle(
    "github:merge",
    async (
      _e,
      request: { cwd?: unknown; input?: GitHubMergeInput } | null,
    ): Promise<GitHubMergeResult> => {
      const cwd = request?.cwd;
      if (typeof cwd !== "string" || !cwd.trim() || cwd.length > 16_384) {
        throw new Error("GitHub merge requires a valid local workspace.");
      }
      if (isRemotePath(cwd)) {
        throw new Error(
          "Merging pull requests is currently available for local workspaces only.",
        );
      }
      const { mergeGitHubPullRequest } = await getGitHubMerge();
      return mergeGitHubPullRequest(cwd, request?.input);
    },
  );
  handle(
    "github:startIssue",
    async (
      _e,
      input: StartGitHubIssueInput,
    ): Promise<StartGitHubIssueResult> => {
      const { startGitHubIssueWorkspace } = await import("./github-issue-workspace");
      return startGitHubIssueWorkspace(input);
    },
  );
  handle(
    "github:startPullRequest",
    async (
      _e,
      input: StartGitHubPullRequestInput,
    ): Promise<StartGitHubPullRequestResult> => {
      const { startGitHubPullRequestWorkspace } = await import(
        "./github-pull-request-workspace"
      );
      return startGitHubPullRequestWorkspace(input);
    },
  );

  handle(
    "git:diff",
    async (
      _e,
      input: { cwd: string; path: string; staged: boolean; untracked: boolean },
    ): Promise<GitDiff> => {
      const { getGitDiff } = await getGitOps();
      return getGitDiff(input.cwd, input.path, {
        staged: input.staged,
        untracked: input.untracked,
      });
    },
  );

  handle(
    "git:stage",
    async (_e, input: { cwd: string; paths: string[] }): Promise<GitOpResult> => {
      const { stageFiles } = await getGitOps();
      return stageFiles(input.cwd, input.paths);
    },
  );

  handle(
    "git:unstage",
    async (_e, input: { cwd: string; paths: string[] }): Promise<GitOpResult> => {
      const { unstageFiles } = await getGitOps();
      return unstageFiles(input.cwd, input.paths);
    },
  );

  handle("git:stageAll", async (_e, cwd: string): Promise<GitOpResult> => {
    const { stageAll } = await getGitOps();
    return stageAll(cwd);
  });

  handle("git:unstageAll", async (_e, cwd: string): Promise<GitOpResult> => {
    const { unstageAll } = await getGitOps();
    return unstageAll(cwd);
  });

  handle(
    "git:discard",
    async (_e, input: { cwd: string; files: GitFileChange[] }): Promise<GitOpResult> => {
      const { discardChanges } = await getGitOps();
      return discardChanges(input.cwd, input.files);
    },
  );

  handle(
    "git:commit",
    async (
      _e,
      input: { cwd: string; message: string; amend?: boolean },
    ): Promise<GitOpResult> => {
      const { commitChanges } = await getGitOps();
      return commitChanges(input.cwd, input.message, { amend: input.amend });
    },
  );

  handle("git:generateCommitMessage", async (_e, cwd: string): Promise<GitCommitMessageResult> => {
    const { generateCommitMessage } = await getGitCommitMessage();
    return generateCommitMessage(cwd);
  });

  handle("git:push", async (_e, cwd: string): Promise<GitOpResult> => {
    const { push } = await getGitOps();
    return push(cwd);
  });

  handle("git:pull", async (_e, cwd: string): Promise<GitOpResult> => {
    const { pull } = await getGitOps();
    return pull(cwd);
  });

  handle("git:fetch", async (_e, cwd: string): Promise<GitOpResult> => {
    const { fetchRemote } = await getGitOps();
    return fetchRemote(cwd);
  });

  handle("git:undoLastCommit", async (_e, cwd: string): Promise<GitOpResult> => {
    const { undoLastCommit } = await getGitOps();
    return undoLastCommit(cwd);
  });

  handle(
    "git:checkout",
    async (_e, input: { cwd: string; ref: string }): Promise<GitOpResult> => {
      const { checkoutRef } = await getGitOps();
      return checkoutRef(input.cwd, input.ref);
    },
  );

  handle(
    "git:revert",
    async (_e, input: { cwd: string; hash: string }): Promise<GitOpResult> => {
      const { revertCommit } = await getGitOps();
      return revertCommit(input.cwd, input.hash);
    },
  );

  handle("git:init", async (_e, cwd: string): Promise<GitOpResult> => {
    const { initRepo } = await getGitOps();
    return initRepo(cwd);
  });

  // ── Branches ──────────────────────────────────────────────────────────────
  handle("git:branches", async (_e, cwd: string): Promise<GitBranchList> => {
    const { listBranches } = await getGitBranches();
    return listBranches(cwd);
  });

  handle(
    "git:checkoutBranch",
    async (_e, input: { cwd: string; name: string }): Promise<GitOpResult> => {
      const { checkoutBranch } = await getGitBranches();
      return checkoutBranch(input.cwd, input.name);
    },
  );

  handle(
    "git:createBranch",
    async (
      _e,
      input: { cwd: string; name: string; checkout?: boolean; startPoint?: string },
    ): Promise<GitOpResult> => {
      const { createBranch } = await getGitBranches();
      return createBranch(input.cwd, input.name, {
        checkout: input.checkout,
        startPoint: input.startPoint,
      });
    },
  );

  handle(
    "git:renameBranch",
    async (_e, input: { cwd: string; oldName: string; newName: string }): Promise<GitOpResult> => {
      const { renameBranch } = await getGitBranches();
      return renameBranch(input.cwd, input.oldName, input.newName);
    },
  );

  handle(
    "git:deleteBranch",
    async (_e, input: { cwd: string; name: string; force?: boolean }): Promise<GitOpResult> => {
      const { deleteBranch } = await getGitBranches();
      return deleteBranch(input.cwd, input.name, { force: input.force });
    },
  );

  handle(
    "git:mergeBranch",
    async (_e, input: { cwd: string; name: string }): Promise<GitOpResult> => {
      const { mergeBranch } = await getGitBranches();
      return mergeBranch(input.cwd, input.name);
    },
  );

  // ── Copy-branch worktrees ───────────────────────────────────────────────────
  handle(
    "git:createCopyWorktree",
    async (
      _e,
      input: {
        repoCwd: string;
        // Exactly one of these: check an existing branch out, or create a new
        // user-named branch off the repo's default branch.
        checkoutBranch?: string;
        checkoutIsRemote?: boolean;
        newBranch?: string;
      },
    ): Promise<GitCopyWorktreeResult> => {
      const {
        createCopyWorktree,
        createCheckoutWorktree,
        managedWorktreesRoot,
      } = await getGitWorktrees();
      const worktreesRoot = managedWorktreesRoot(codaraHome(), input.repoCwd);
      const result = input.checkoutBranch
        ? await createCheckoutWorktree({
            repoCwd: input.repoCwd,
            worktreesRoot,
            branch: input.checkoutBranch,
            isRemote: input.checkoutIsRemote,
          })
        : await createCopyWorktree({
            repoCwd: input.repoCwd,
            worktreesRoot,
            newBranch: input.newBranch ?? "",
          });
      if (result.ok) {
        // The new branch is a shared ref — refresh the source repo's panel.
        const { invalidateGitCache } = await getGitOps();
        invalidateGitCache(input.repoCwd);
      }
      return result;
    },
  );

  handle(
    "git:removeCopyWorktree",
    async (
      _e,
      input: {
        repoCwd: string;
        worktreePath: string;
        branch: string;
        force?: boolean;
        deleteBranch?: boolean;
      },
    ): Promise<GitOpResult> => {
      const { removeCopyWorktree } = await getGitWorktrees();
      const result = await removeCopyWorktree(input, {
        // A shell or agent pane whose cwd is the worktree holds the directory
        // open on Windows (EBUSY). Only kill those PTYs once a lock actually
        // blocks the removal — so an unrelated refusal (e.g. a dirty worktree)
        // never needlessly destroys the user's terminals.
        onBusy: () => {
          pty.disposeUnderCwd(input.worktreePath);
        },
      });
      const { invalidateGitCache } = await getGitOps();
      invalidateGitCache(input.repoCwd);
      return result;
    },
  );

  // ── Stash ───────────────────────────────────────────────────────────────────
  handle("git:stashes", async (_e, cwd: string): Promise<GitStashList> => {
    const { listStashes } = await getGitStash();
    return listStashes(cwd);
  });

  handle(
    "git:stashSave",
    async (
      _e,
      input: { cwd: string; message?: string; includeUntracked?: boolean },
    ): Promise<GitOpResult> => {
      const { saveStash } = await getGitStash();
      return saveStash(input.cwd, {
        message: input.message,
        includeUntracked: input.includeUntracked,
      });
    },
  );

  handle(
    "git:stashApply",
    async (_e, input: { cwd: string; ref: string }): Promise<GitOpResult> => {
      const { applyStash } = await getGitStash();
      return applyStash(input.cwd, input.ref);
    },
  );

  handle(
    "git:stashPop",
    async (_e, input: { cwd: string; ref: string }): Promise<GitOpResult> => {
      const { popStash } = await getGitStash();
      return popStash(input.cwd, input.ref);
    },
  );

  handle(
    "git:stashDrop",
    async (_e, input: { cwd: string; ref: string }): Promise<GitOpResult> => {
      const { dropStash } = await getGitStash();
      return dropStash(input.cwd, input.ref);
    },
  );

  // ── Commit inspection ────────────────────────────────────────────────────────
  handle(
    "git:commitDetail",
    async (_e, input: { cwd: string; hash: string }): Promise<GitCommitDetailResult> => {
      const { getCommitDetail } = await getGitInspect();
      return getCommitDetail(input.cwd, input.hash);
    },
  );

  handle(
    "git:commitFileDiff",
    async (_e, input: { cwd: string; hash: string; path: string }): Promise<GitDiff> => {
      const { getCommitFileDiff } = await getGitInspect();
      return getCommitFileDiff(input.cwd, input.hash, input.path);
    },
  );

  // ── Partial staging + conflict resolution ─────────────────────────────────────
  handle(
    "git:applyPatch",
    async (
      _e,
      input: { cwd: string; patch: string; cached: boolean; reverse: boolean },
    ): Promise<GitOpResult> => {
      const { applyPatch } = await getGitApply();
      return applyPatch(input.cwd, input.patch, {
        cached: input.cached,
        reverse: input.reverse,
      });
    },
  );

  handle(
    "git:resolveConflict",
    async (
      _e,
      input: { cwd: string; path: string; side: GitConflictSide },
    ): Promise<GitOpResult> => {
      const { resolveConflict } = await getGitApply();
      return resolveConflict(input.cwd, input.path, input.side);
    },
  );

  handle("orchestration:createRun", async (_e, input: CreateRunInput): Promise<RunState> => {
    assertLocalWorkspace(input.cwd, "Managed chat");
    const { createRun } = await getRunStore();
    return createRun(input);
  });

  handle("orchestration:getRun", async (_e, runId: string): Promise<RunState | null> => {
    const { getRun } = await getRunStore();
    return getRun(runId);
  });

  handle(
    "orchestration:readWorkerPrompt",
    async (_e, input: { runId: string; attemptId: string }): Promise<string> => {
      if (!input || typeof input.runId !== "string" || typeof input.attemptId !== "string") {
        throw new Error("Invalid worker prompt request.");
      }
      const { readWorkerAttemptPrompt } = await getRunStore();
      return readWorkerAttemptPrompt(input.runId, input.attemptId);
    },
  );

  handle("orchestration:listRuns", async (_e, workspaceId?: string): Promise<RunState[]> => {
    const { listRuns } = await getRunStore();
    return listRuns(workspaceId);
  });

  handle("orchestration:listEvents", async (_e, runId: string): Promise<SparkEvent[]> => {
    return listEvents(runId);
  });



  handle("orchestration:startAutopilot", async (_e, input: StartAutopilotInput): Promise<RunState> => {
    assertLocalWorkspace(input.cwd, "Automations and autopilot");
    const { startAutopilot } = await getRunStore();
    return startAutopilot(input);
  });



  handle("orchestration:forcePauseRun", async (_e, runId: string): Promise<RunState> => {
    const { forcePauseRun } = await getRunStore();
    return forcePauseRun(runId);
  });

  handle(
    "orchestration:stopAndUndoPending",
    async (_e, runId: string): Promise<UndoToCheckpointResult> => {
      const { stopAndUndoPending } = await getRunStore();
      return stopAndUndoPending(runId);
    },
  );

  handle("orchestration:resumeRun", async (_e, input: ResumeRunInput): Promise<RunState> => {
    const { resumeRun } = await getRunStore();
    return resumeRun(input);
  });

  handle("orchestration:addRunMessage", async (_e, input: AddRunMessageInput): Promise<RunState> => {
    const { addRunMessage } = await getRunStore();
    return addRunMessage(input);
  });

  handle(
    "orchestration:cancelQueuedMessage",
    async (_e, input: CancelQueuedMessageInput): Promise<CancelQueuedMessageResult> => {
      const { cancelQueuedMessage } = await getRunStore();
      return cancelQueuedMessage(input);
    },
  );

  handle(
    "orchestration:deliverQueuedMessagesNow",
    async (_e, runId: string): Promise<RunState> => {
      const { deliverQueuedMessagesNow } = await getRunStore();
      return deliverQueuedMessagesNow(runId);
    },
  );

  handle(
    "orchestration:answerRunQuestion",
    async (_e, input: AnswerRunQuestionInput): Promise<RunState> => {
      const { answerRunQuestion } = await getRunStore();
      return answerRunQuestion(input);
    },
  );

  handle(
    "orchestration:undoToCheckpoint",
    async (_e, input: UndoToCheckpointInput): Promise<UndoToCheckpointResult> => {
      const { undoToCheckpoint } = await getRunStore();
      return undoToCheckpoint(input);
    },
  );


  handle("orchestration:markRunSeen", async (_e, input: MarkRunSeenInput): Promise<RunState> => {
    const { markRunSeen } = await getRunStore();
    return markRunSeen(input);
  });

  handle("orchestration:renameRun", async (_e, input: RenameRunInput): Promise<RunState> => {
    const { renameRun } = await getRunStore();
    return renameRun(input);
  });

  handle(
    "orchestration:updateWhiteboard",
    async (_e, input: UpdateCoraWhiteboardInput): Promise<RunState> => {
      const { updateCoraWhiteboard } = await getRunStore();
      return updateCoraWhiteboard(input);
    },
  );

  handle(
    "orchestration:updateChatBackend",
    async (_e, input: UpdateChatBackendInput): Promise<RunState> => {
      const { updateChatBackend } = await getRunStore();
      return updateChatBackend(input);
    },
  );

  handle("orchestration:createStep", async (_e, input: CreateStepInput): Promise<RunState> => {
    const { createStep } = await getRunStore();
    return createStep(input);
  });


  handle("orchestration:createWorkerTask", async (_e, input: CreateWorkerTaskInput): Promise<RunState> => {
    const { createWorkerTask } = await getRunStore();
    return createWorkerTask(input);
  });


  handle("orchestration:prepareWorkerTask", async (_e, input: PrepareWorkerTaskInput) => {
    const { prepareWorkerTask } = await getRunStore();
    return prepareWorkerTask(input);
  });

  handle("orchestration:launchWorkerAttempt", async (_e, input: LaunchWorkerAttemptInput): Promise<RunState> => {
    const { launchWorkerAttempt } = await getRunStore();
    return launchWorkerAttempt(input);
  });

  handle("orchestration:readWorkerReport", async (_e, path: string) => {
    // The renderer only ever passes an attempt's recorded finalReportPath,
    // which lives under the runs root. Gating it keeps this from doubling as an
    // arbitrary-path existence oracle, and matches the confinement its sibling
    // orchestration:readWorkerPrompt already enforces internally.
    await assertAllowedReadPathResolved(path);
    const { readWorkerReport } = await getRunStore();
    return readWorkerReport(path);
  });

  handle("orchestration:deleteRun", async (_e, runId: string): Promise<void> => {
    const { deleteRun } = await getRunStore();
    await deleteRun(runId);
  });

  // ── Cora Board ──────────────────────────────────────────────────────────
  // Thin IPC over the per-chat board on RunState.board (run-store). Two
  // reads-and-writes plus a push: the board is also written by Cora over the
  // agent socket and by the one-time legacy adoption, so the renderer cannot
  // assume its own writes are the only ones and subscribes to "board:changed"
  // for everything else. The read also triggers legacy adoption (see
  // run-store.getRunBoard), which is why opening the surface goes through it.
  handle("board:get", async (_e, runId: string): Promise<RunBoard> => {
    if (typeof runId !== "string" || !runId.trim()) {
      throw new Error("board:get requires a runId");
    }
    const { getRunBoard } = await getRunStore();
    return getRunBoard(runId.trim());
  });

  // A stale baseRevision resolves with ok:false plus the current board rather
  // than throwing — losing a race with Cora is an ordinary outcome the
  // renderer rebases on, not an error to surface.
  handle(
    "board:update",
    async (
      _e,
      input: RunBoardUpdateInput & { workspaceCwd?: string },
    ): Promise<RunBoardUpdateResult> => {
      if (!input || typeof input.runId !== "string" || !input.runId.trim()) {
        throw new Error("board:update requires a runId");
      }
      const { updateRunBoard } = await getRunStore();
      return updateRunBoard(input);
    },
  );

  // Push accepted board writes at every window. Board commits ride the
  // orchestration event bus (run.board_updated / run.board_nudged), so the
  // push is derived from it rather than a second listener registry. Cadence is
  // human-scale (drags, card edits, agent lane moves), so a plain
  // getAllWindows fan-out is enough.
  void (async () => {
    const { getRun } = await getRunStore();
    subscribeToEvents((event) => {
      if (!event.runId) return;
      if (event.type !== "run.board_updated" && event.type !== "run.board_nudged") return;
      const runId = event.runId;
      void getRun(runId)
        .then((run) => {
          if (!run?.board) return;
          for (const win of BrowserWindow.getAllWindows()) {
            if (win.webContents.isDestroyed()) continue;
            win.webContents.send("board:changed", { runId, board: run.board });
          }
        })
        .catch((err: unknown) => console.warn("[board] change push failed:", err));
    });
  })().catch((err: unknown) => console.error("[board] change push wiring failed:", err));

  // ── Scheduler ───────────────────────────────────────────────────────────
  // Thin IPC over the scheduler registry stub (scheduler.ts). Cron firing is
  // stubbed for the scaffold; these channels manage the job registry and let
  // the renderer trigger a job immediately via runNow.
  handle("scheduler:list", async (): Promise<ScheduledJob[]> => {
    const { listJobs } = await getScheduler();
    return listJobs();
  });

  handle(
    "scheduler:create",
    async (_e, input: CreateScheduledJobInput): Promise<ScheduledJob> => {
      const { createJob } = await getScheduler();
      return createJob(input);
    },
  );

  handle("scheduler:delete", async (_e, id: string): Promise<void> => {
    const { deleteJob } = await getScheduler();
    await deleteJob(id);
  });

  handle(
    "scheduler:setEnabled",
    async (_e, input: { id: string; enabled: boolean }): Promise<ScheduledJob> => {
      const { setEnabled } = await getScheduler();
      return setEnabled(input.id, input.enabled);
    },
  );

  handle("scheduler:runNow", async (_e, id: string): Promise<RunState> => {
    const { runJobNow } = await getScheduler();
    return runJobNow(id);
  });

  // Edit an automation's definition (name / trigger / input / loop / prompt).
  handle(
    "scheduler:update",
    async (_e, input: UpdateScheduledJobInput): Promise<ScheduledJob> => {
      const { updateJob } = await getScheduler();
      return updateJob(input);
    },
  );

  // Pause an automation's loop (trigger stays armed).
  handle("scheduler:pause", async (_e, id: string): Promise<ScheduledJob | undefined> => {
    const { pauseJob } = await getScheduler();
    return pauseJob(id);
  });

  // Resume a paused loop.
  handle("scheduler:resume", async (_e, id: string): Promise<ScheduledJob | undefined> => {
    const { resumeJob } = await getScheduler();
    return resumeJob(id);
  });

  // Stop an automation's loop now (finalize + force-pause the live run).
  handle("scheduler:stop", async (_e, id: string): Promise<ScheduledJob | undefined> => {
    const { stopJob } = await getScheduler();
    return stopJob(id);
  });

  // Resolve an automation + its live worker run for the Hub detail pane.
  handle("scheduler:getDetail", async (_e, id: string): Promise<AutomationDetail | null> => {
    const { getDetail } = await getScheduler();
    return getDetail(id);
  });

  // Looms v2: live direct-worker inventory for the Hub's Workers sub-tab.
  handle("automations:listActiveWorkers", async (): Promise<AutomationWorkerInfo[]> => {
    const { listActiveAutomationWorkers } = await import("./orchestration/direct-worker");
    return listActiveAutomationWorkers();
  });

  handle(
    "pty:spawn",
    async (
      e,
      args: {
        id: string;
        shell: ShellInfo;
        cwd: string;
        cols: number;
        rows: number;
        env?: Record<string, string>;
        startupCommand?: string;
        nativeCodexProfileId?: string;
        nativeClaudeProfileId?: string;
        nativeCliLoginToken?: string;
        mirror?: boolean;
        preserveSizeOnAttach?: boolean;
      },
    ) => {
      // Spawning a pty starts a real OS process; only the trusted renderer may.
      // A native-account login token selects a main-owned exact executable,
      // argv, and environment. None of those values can be supplied by or
      // returned to the renderer.
      if (args?.nativeCliLoginToken !== undefined) {
        return spawnPreparedNativeCliLogin(e.sender, args);
      }
      let projectPolicyMode: ProjectPolicyMode | undefined;
      if (parseManualAgentStartupCommand(args.startupCommand)) {
        // Security boundary: trust for a managed agent autorun comes only from
        // the persisted workspace origin loaded in main. The renderer supplies
        // a process cwd, never a policy label, and cannot mark an imported pull
        // request trusted. Plain shells skip this read and remain available.
        const state = await loadState();
        projectPolicyMode = await workspaceProjectPolicyModeForTerminalCwd(
          args.cwd,
          state.workspaces,
        );
      }
      return pty.spawn({
        id: args.id,
        shell: args.shell,
        cwd: args.cwd,
        cols: args.cols,
        rows: args.rows,
        env: args.env,
        startupCommand: args.startupCommand,
        projectPolicyMode,
        nativeCodexProfileId: args.nativeCodexProfileId,
        nativeClaudeProfileId: args.nativeClaudeProfileId,
        mirror: args.mirror,
        preserveSizeOnAttach: args.preserveSizeOnAttach,
        webContents: e.sender,
      });
    },
  );

  // A pane's first input can outrun its own pty:spawn: the renderer mounts,
  // spawns, and focuses in one tick, but main can hold the spawn for seconds
  // (native-account resolution shells out to the claude/codex CLIs before a
  // plain shell starts). pty.write/inject silently no-op on an unknown id, so
  // bytes sent in that window — early keystrokes, or the session picker's
  // injected launch command landing in a still-booting pane — used to vanish.
  // Ride out the in-flight spawn instead; a session that never comes up still
  // drops the bytes after the bound. IPC arrival order is preserved across the
  // wait: spawnWaiters resolve in registration order, so queued writes land in
  // the pty in the order they were sent.
  const awaitPendingSpawn = async (id: string) => {
    if (!pty.hasSession(id)) await pty.waitForSpawn(id, 10_000);
  };

  handle("pty:write", async (_e, args: { id: string; data: string }) => {
    await awaitPendingSpawn(args.id);
    pty.write(args.id, args.data);
    // User keystrokes are the notifier's "a fresh turn may start" signal —
    // they re-arm the pane's alert dedup (see noteTerminalUserInput).
    noteTerminalUserInput(args.id);
  });

  handle(
    "pty:inject",
    async (_e, args: { id: string; text: string; submit?: boolean }) => {
      await awaitPendingSpawn(args.id);
      pty.inject(args.id, args.text, { submit: args.submit ?? true });
      // Injected prompts (slash commands, drag-drop paths) start turns the
      // same way keystrokes do.
      noteTerminalUserInput(args.id);
    },
  );

  handle("pty:resize", async (_e, args: { id: string; cols: number; rows: number }) => {
    pty.resize(args.id, args.cols, args.rows);
  });

  handle("pty:dispose", async (_e, args: { id: string }) => {
    // Only Cora may kill a live worker attempt — downgrade to detach so the
    // session keeps running headless (the workers-tab reconcile loop can
    // re-attach it later). See workerAttemptRunIds above.
    if (await isLiveWorkerAttemptPty(args.id)) {
      pty.detach(args.id);
      return;
    }
    noteTerminalWillDispose(args.id);
    pty.dispose(args.id);
  });

  // Probe for an existing session. Used by ChatPanel's backend-terminal tab
  // to decide whether to mount a TerminalPane (which would try to spawn —
  // and fail with ENOENT — if the session hasn't been spawned yet in main).
  // Cheap: just a Map.has() check.
  handle("pty:exists", async (_e, args: { id: string }) => {
    return pty.exists(args.id);
  });
  handle("pty:resourceSnapshot", async () => {
    return pty.resourceSnapshot();
  });

  // Pause / resume the live byte stream while the renderer-side TerminalPane
  // is unmounted (workspace switch). Paused sessions buffer pty output into a
  // detached backlog instead of sending it to webContents — the listener is
  // gone, so the send would be dropped. Resume drains the backlog through the
  // same data channel before live output continues.
  handle("pty:pause", async (_e, args: { id: string }) => {
    pty.pause(args.id);
  });
  handle("pty:resume", async (_e, args: { id: string }) => {
    pty.resume(args.id);
  });
  // Detach — the raw-tail-reattach variant of pause used by ChatPanel's backend
  // terminal. Nulls the renderer sink and DISCARDS the pause/backlog state so
  // the next spawn() replays the raw pty tail into a fresh xterm (like a first
  // attach) instead of resuming a backlog that would double-deliver tail bytes.
  handle("pty:detach", async (_e, args: { id: string }) => {
    pty.detach(args.id);
  });

  // Is a local dev server actually listening at this URL? The renderer asks
  // before auto-opening a preview tab for a URL it sniffed on a terminal, so a
  // banner line that arrives as replayed history (or one a resumed agent CLI
  // reprints from an old transcript) can't spawn a tab onto a dead port.
  handle("preview:probeLocalServer", async (_e, args: { url: string }): Promise<boolean> => {
    if (!args || typeof args.url !== "string" || !args.url.trim()) return false;
    return isLoopbackPreviewServerUp(args.url);
  });

  // ── Agent session restore (manual Claude/Codex terminal panes) ──────────
  handle(
    "agentSession:list",
    async (
      _e,
      args: {
        runtime: WorkerSessionRuntime;
        cwd: string;
        nativeCodexProfileId?: string;
        nativeClaudeProfileId?: string;
      },
    ): Promise<WorkerSessionSummary[]> => {
      if (!args || (args.runtime !== "claude" && args.runtime !== "codex")) return [];
      if (typeof args.cwd !== "string" || !args.cwd.trim()) return [];
      assertLocalWorkspace(args.cwd, "Worker session history");
      if (args.runtime === "claude") {
        const execution =
          args.nativeClaudeProfileId === undefined
            ? await resolveNewNativeClaudeProfile()
            : await resolveFrozenNativeClaudeProfile(
                args.nativeClaudeProfileId,
              );
        const items = await listWorkerSessions(args.runtime, args.cwd, {
          claudeStateDir:
            execution.env.CLAUDE_CONFIG_DIR ?? null,
        });
        return items.map((item) => ({
          ...item,
          nativeClaudeProfileId: execution.profileId,
        }));
      }
      const execution =
        args.nativeCodexProfileId === undefined
          ? await resolveNewNativeCodexProfile()
          : await resolveFrozenNativeCodexProfile(
              args.nativeCodexProfileId,
            );
      const items = await listWorkerSessions(args.runtime, args.cwd, {
        codexHome: execution.env.CODEX_HOME,
      });
      return items.map((item) => ({
        ...item,
        nativeCodexProfileId: execution.profileId,
      }));
    },
  );

  handle(
    "agentSession:listAll",
    async (): Promise<WorkerSessionSummary[]> => {
      const [execution, claudeExecution] = await Promise.all([
        resolveNewNativeCodexProfile(),
        resolveNewNativeClaudeProfile(),
      ]);
      const items = await listAllWorkerSessions({
        codexHome: execution.env.CODEX_HOME,
        claudeStateDir:
          claudeExecution.env.CLAUDE_CONFIG_DIR ?? null,
      });
      return items.map((item) =>
        item.runtime === "codex"
          ? { ...item, nativeCodexProfileId: execution.profileId }
          : { ...item, nativeClaudeProfileId: claudeExecution.profileId },
      );
    },
  );

  handle(
    "agentSession:delete",
    async (_e, input: DeleteWorkerSessionInput): Promise<DeleteWorkerSessionResult> => {
      if (typeof input?.cwd === "string") {
        assertLocalWorkspace(input.cwd, "Worker session deletion");
      }
      if (input.runtime === "claude") {
        const execution = await resolveFrozenNativeClaudeProfile(
          input.nativeClaudeProfileId,
        );
        return deleteWorkerSession(input, {
          claudeStateDir:
            execution.env.CLAUDE_CONFIG_DIR ?? null,
        });
      }
      const execution = await resolveFrozenNativeCodexProfile(
        input.nativeCodexProfileId,
      );
      return deleteWorkerSession(input, {
        codexHome: execution.env.CODEX_HOME,
      });
    },
  );

  // Capture: when the renderer detects a `claude`/`codex` agent running in a
  // pane, find the transcript it just started writing and return its session id
  // so a future reopen can `--resume` it. Neither CLI reports its id back over
  // the PTY, so it is discovered from disk: Claude buckets transcripts per-cwd
  // (newest .jsonl in ~/.claude/projects/<enc-cwd>/); Codex date-buckets rollout
  // files (newest matching this cwd). Polls up to 15s since the file may appear
  // a beat after the TUI does.
  handle(
    "agentSession:capture",
    async (
      _e,
      args: {
        runtime: "claude" | "codex";
        paneId?: string;
        nativeCodexProfileId?: string;
        nativeClaudeProfileId?: string;
        cwd: string;
        sinceMs: number;
        // Session ids already bound to OTHER panes. Two agents launched in the
        // same cwd within the discovery window would otherwise both bind to the
        // newest transcript — one pane silently stealing the other's session, so
        // its own conversation is never restore-reachable again.
        excludeSessionIds?: string[];
      },
    ): Promise<{
      sessionId: string;
      transcriptPath: string;
      nativeCodexProfileId?: string;
      nativeClaudeProfileId?: string;
    } | null> => {
      const since = args.sinceMs;
      const spawnDate = new Date(since);
      const deadline = Date.now() + 15_000;
      const exclude = new Set(
        (args.excludeSessionIds ?? []).map((id) => id.toLowerCase()).filter(Boolean),
      );
      const nativeCodexProfileId =
        args.runtime === "codex"
          ? args.nativeCodexProfileId ??
            (args.paneId ? pty.nativeCodexProfileId(args.paneId) : undefined)
          : undefined;
      const nativeCodexExecution =
        args.runtime === "codex"
          ? await resolveFrozenNativeCodexProfile(nativeCodexProfileId)
          : null;
      const nativeClaudeProfileId =
        args.runtime === "claude"
          ? args.nativeClaudeProfileId ??
            (args.paneId ? pty.nativeClaudeProfileId(args.paneId) : undefined)
          : undefined;
      const nativeClaudeExecution =
        args.runtime === "claude"
          ? await resolveFrozenNativeClaudeProfile(nativeClaudeProfileId)
          : null;
      for (;;) {
        let found: {
          sessionId: string;
          transcriptPath: string;
          nativeCodexProfileId?: string;
          nativeClaudeProfileId?: string;
        } | null = null;
        if (args.runtime === "claude") {
          const discovered = await discoverClaudeSessionForCwd(
            args.cwd,
            since,
            exclude,
            nativeClaudeExecution?.env.CLAUDE_CONFIG_DIR ?? null,
          ).catch(() => null);
          found = discovered
            ? {
                ...discovered,
                nativeClaudeProfileId: nativeClaudeExecution?.profileId,
              }
            : null;
        } else {
          // strict: an unmatched-cwd fallback here would bind the pane to some
          // OTHER session's rollout. This poll loop retries for 15s, so a
          // not-yet-flushed session_meta line just means "try again next tick".
          const path = await discoverRolloutForCwd(since, spawnDate, args.cwd, {
            strict: true,
            excludeSessionIds: exclude,
            codexHome: nativeCodexExecution?.env.CODEX_HOME,
          }).catch(() => null);
          if (path) {
            const sessionId = extractSessionUuid(path);
            if (sessionId) {
              found = {
                sessionId,
                transcriptPath: path,
                nativeCodexProfileId:
                  nativeCodexExecution?.profileId,
              };
            }
          }
        }
        if (found) return found;
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    },
  );

  // Persistent trail of restore decisions (fire-and-forget from the renderer).
  // "Some panes resume, some don't" is undebuggable without knowing what each
  // pane decided at boot — this lands every decision in <codaraHome>/logs/main.log.
  ipcMain.on("agentSession:logRestore", (e, line: string) => {
    if (!isTrustedOnSender(e, "agentSession:logRestore")) return;
    if (typeof line === "string" && line.length < 2048) logMain("restore", line);
  });

  // Newest SessionStart hook record for a pane (see agent-session-registry.ts).
  // The renderer consults this before every restore/hint so a pointer that
  // went stale via in-TUI `/resume` or `/clear` heals to the session that
  // ACTUALLY last ran in the pane, instead of resuming a dead id.
  handle(
    "agentSession:latestStart",
    async (_e, args: { paneId: string }) =>
      args?.paneId ? latestSessionStart(args.paneId) : null,
  );

  // Probe: on reopen, before a restored pane fires its `--resume` autorun, check
  // that the CLI's transcript still exists on disk AND is actually resumable.
  // Existence alone isn't enough: a session that was killed at birth leaves a
  // ~2KB .jsonl with no user message, and `claude --resume` refuses those with
  // "No conversation found with session ID" — stranding the pane on an error.
  // `resumable: false` → the renderer self-heals (fresh forced-id Claude, or a
  // plain shell for codex) instead of delivering a doomed resume.
  handle(
    "agentSession:probe",
    async (
      _e,
      args: {
        runtime: "claude" | "codex";
        sessionId: string;
        cwd: string;
        transcriptPath?: string;
        nativeCodexProfileId?: string;
        nativeClaudeProfileId?: string;
      },
    ): Promise<{ exists: boolean; resumable?: boolean; repairable?: boolean; transcriptPath?: string }> => {
      if (!args.sessionId) return { exists: false };
      if (args.runtime === "claude") {
        const execution = await resolveFrozenNativeClaudeProfile(
          args.nativeClaudeProfileId,
        );
        const expectedPath = claudeSessionTranscriptPath(
          args.cwd,
          args.sessionId,
          execution.env.CLAUDE_CONFIG_DIR ?? null,
        );
        const path = await resolveSafeClaudeTranscriptPath(
          args.cwd,
          args.sessionId,
          execution.env.CLAUDE_CONFIG_DIR ?? null,
        ).catch(() => null);
        if (!path) return { exists: false, transcriptPath: expectedPath };
        const exists = await fs.access(path).then(() => true, () => false);
        if (!exists) return { exists: false, transcriptPath: path };
        // Resumability: the transcript must contain at least one real user
        // message line. Scan only the head — a genuine conversation has its
        // first user message within the first few KB.
        const resumable = await fs
          .open(path, "r")
          .then(async (handle) => {
            try {
              const buf = Buffer.alloc(65_536);
              const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
              return buf.subarray(0, bytesRead).toString("utf8").includes('"type":"user"');
            } finally {
              await handle.close().catch(() => undefined);
            }
          })
          .catch(() => true); // unreadable head → don't block the resume attempt
        if (!resumable) return { exists: true, resumable: false, transcriptPath: path };
        // The head scan passes even when a sleep/crash cut the writer mid-line,
        // leaving a truncated LAST record that `claude --resume` may refuse.
        // Check the TAIL and flag it repairable so the renderer truncates the
        // partial line (preserving the conversation) instead of self-healing
        // into a fresh session and losing it.
        const { repairable } = await inspectClaudeTranscriptTail(path);
        return { exists: true, resumable: true, repairable, transcriptPath: path };
      }
      // Codex: sessions are date-bucketed, not addressable by cwd, so rely on the
      // transcript path captured at launch. Size floor stands in for the message
      // scan (rollout formats vary): a stillborn rollout is a few hundred bytes.
      const path = args.transcriptPath;
      if (path) {
        const execution = await resolveFrozenNativeCodexProfile(
          args.nativeCodexProfileId,
        );
        const safePath = resolveCodexTranscriptPath(
          path,
          execution.env.CODEX_HOME,
        );
        const stat = await fs.stat(safePath).catch(() => null);
        if (stat) {
          return {
            exists: true,
            resumable: stat.size >= 1_024,
            transcriptPath: safePath,
          };
        }
      }
      return { exists: false };
    },
  );

  // Pre-seed Codex directory trust before a resumed (or fresh) `codex --yolo`
  // pane so its TUI never stalls on the "trust this directory?" prompt.
  handle("agentSession:ensureCodexTrust", async (
    _e,
    args: { cwd: string; nativeCodexProfileId?: string },
  ): Promise<void> => {
    const execution =
      args.nativeCodexProfileId === undefined
        ? await resolveNewNativeCodexProfile()
        : await resolveFrozenNativeCodexProfile(
            args.nativeCodexProfileId,
          );
    await ensureCodexProjectTrust(
      args.cwd,
      execution.env.CODEX_HOME,
    ).catch(() => undefined);
  });

  // Repair a Claude transcript whose tail was truncated by an abrupt kill
  // (sleep/crash mid-write) so `claude --resume` accepts it. Truncates the
  // trailing partial JSON line, keeping a `<path>.bak`. Claude only — Codex
  // rollout formats are not safely truncatable, so this is a no-op for them.
  // Returns whether a repair was actually written.
  handle(
    "agentSession:repairTranscript",
    async (
      _e,
      args: {
        runtime: "claude" | "codex";
        sessionId: string;
        cwd: string;
        nativeClaudeProfileId?: string;
      },
    ): Promise<{ repaired: boolean }> => {
      if (args.runtime !== "claude" || !args.sessionId) return { repaired: false };
      const execution = await resolveFrozenNativeClaudeProfile(
        args.nativeClaudeProfileId,
      );
      const path = await resolveSafeClaudeTranscriptPath(
        args.cwd,
        args.sessionId,
        execution.env.CLAUDE_CONFIG_DIR ?? null,
        { requireExisting: true },
      );
      const repaired = await repairClaudeTranscriptTail(path).catch(() => false);
      return { repaired };
    },
  );

  // Live runtime-state report from the renderer-side terminal poller. Main
  // forwards the report into run-store (which finds the worker attempt by
  // paneId/attemptId and updates its `runtimeState` field, broadcasting a
  // change event). Reports for panes with no matching attempt — manual
  // claude/codex panes started by the user — are silently ignored.
  handle(
    "terminalState:report",
    async (_e, input: { paneId: string; state: RuntimeState }) => {
      if (!input?.paneId || !input.state) return;
      const store = await getRunStore();
      await store.reportTerminalState(input.paneId, input.state);
    },
  );

  // Terminal-agent notifier registry. The renderer ships the full pane set
  // for a workspace whenever its terminal layout changes; main reconciles
  // watchers against it (see terminal-agent-notify.ts). Cheap enough to call
  // on every layout change — the per-pane upsert is a Map write.
  handle(
    "terminalNotify:sync",
    async (
      _e,
      input: { workspaceId: string; workspaceName?: string; panes: TerminalNotifyPaneEntry[] },
    ) => {
      return syncTerminalNotifyPanes(input);
    },
  );
  handle("terminalNotify:snapshot", async () => terminalAgentStateSnapshot());

  // Renderer reports what the user is looking at (focus + active workspace/
  // tab/run/pane) in one snapshot; the notify policy suppresses alerts for
  // the surface the user is already watching.
  handle(
    "ui:setAttention",
    async (_e, snapshot: Partial<UiAttentionSnapshot> | null): Promise<void> => {
      setAttention(snapshot);
    },
  );

  // Notification center (src/main/notify/center-store).
  handle(
    "notify:list",
    async (): Promise<NotificationCenterEntry[]> => listCenterEntries(),
  );
  handle("notify:markRead", async (_e, id: string): Promise<void> => {
    if (typeof id === "string") await markCenterRead(id);
  });
  handle("notify:markAllRead", async (): Promise<void> => {
    await markCenterAllRead();
  });
  handle("notify:remove", async (_e, id: string): Promise<void> => {
    if (typeof id === "string") await removeCenterEntry(id);
  });
  handle("notify:clear", async (): Promise<void> => {
    await clearCenter();
  });

  handle("window:minimize", async (e): Promise<void> => {
    BrowserWindow.fromWebContents(e.sender)?.minimize();
  });

  handle("window:toggleMaximize", async (e): Promise<boolean> => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return win.isMaximized();
  });

  handle("window:isMaximized", async (e): Promise<boolean> => {
    return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false;
  });

  handle("window:close", async (e): Promise<void> => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });

  // Hide the window to the system tray (close-to-tray) without quitting. On
  // win32 we also drop the taskbar button so the hidden window doesn't linger
  // there — mirrors the close-to-tray path in main's window `close` handler.

  handle(
    "window:setTitleBarTheme",
    async (e, theme: { color?: unknown; symbolColor?: unknown }): Promise<void> => {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!win) return;
      const color = typeof theme?.color === "string" && theme.color ? theme.color : "#171513";
      try {
        // All platforms: keep the window's own background in key with the
        // active theme so resize exposes theme-colored (not hardcoded-dark)
        // pixels — the BrowserWindow is created with the classic dark color.
        win.setBackgroundColor(color);
      } catch {
        /* Unsupported color strings should not break theme switches. */
      }
      if (process.platform !== "win32") return;
      const symbolColor =
        typeof theme?.symbolColor === "string" && theme.symbolColor
          ? theme.symbolColor
          : "#bdbcb8";
      try {
        win.setTitleBarOverlay({ color, symbolColor, height: 30 });
      } catch {
        /* Platform quirks should not break theme switches. */
      }
    },
  );

  handle("app:platform", async (): Promise<NodeJS.Platform> => process.platform);
  handle("app:home", async (): Promise<string> => app.getPath("home"));

  // Resolve the absolute file:// URL of the webview-side inspector preload
  // bundle so the renderer can attach it via `<webview preload="...">`.
  // The bundle is emitted by electron-vite alongside the main renderer
  // preload, so we walk relative to `__dirname` (out/main).
  handle("app:inspectorPreloadUrl", async (): Promise<string> => {
    const path = join(__dirname, "..", "preload", "inspector-preload.js");
    return pathToFileURL(path).toString();
  });

  // Project-wide search. The renderer kicks off a search and gets back an
  // ID; the main process then streams `search:hit:<id>` and ends with
  // `search:done:<id>`. Cancellation goes through `search:cancel`.
  const activeSearches = new Map<
    string,
    { handle: StreamGrepHandle; sender: WebContents; onDestroyed: () => void }
  >();
  let searchCounter = 0;

  handle(
    "search:start",
    async (e, opts: SearchOptions): Promise<StartSearchResponse> => {
      const sender = e.sender;
      const remote = isRemotePath(opts.root);
      if (!remote) await assertAllowedReadPathResolved(opts.root);
      const searchId = `search-${Date.now().toString(36)}-${(searchCounter++).toString(36)}`;
      const hitChannel = `search:hit:${searchId}`;
      const doneChannel = `search:done:${searchId}`;
      const handle = (remote ? remoteStreamGrep : streamGrep)(
        opts,
        // streamGrep batches hits, so each message carries an array — keeps
        // a 2000-hit search to a handful of IPC sends.
        (hits: SearchHit[]) => {
          if (sender.isDestroyed()) return;
          sender.send(hitChannel, hits);
        },
        (summary: SearchSummary) => {
          const entry = activeSearches.get(searchId);
          if (entry) sender.removeListener("destroyed", entry.onDestroyed);
          activeSearches.delete(searchId);
          if (sender.isDestroyed()) return;
          sender.send(doneChannel, summary);
        },
      );
      const onDestroyed = (): void => {
        handle.cancel();
        activeSearches.delete(searchId);
      };
      activeSearches.set(searchId, { handle, sender, onDestroyed });
      sender.once("destroyed", onDestroyed);
      return { searchId };
    },
  );

  handle("search:cancel", async (_e, searchId: string): Promise<void> => {
    const entry = activeSearches.get(searchId);
    if (entry) {
      entry.handle.cancel();
      if (!entry.sender.isDestroyed()) entry.sender.removeListener("destroyed", entry.onDestroyed);
      activeSearches.delete(searchId);
    }
  });

  // Clipboard bridge for terminal Ctrl+Shift+C / Ctrl+Shift+V. The xterm.js
  // canvas can't reach navigator.clipboard reliably inside Electron when the
  // renderer hasn't been granted clipboard-read permission, so route through
  // main where Electron's `clipboard` API works unconditionally.
  handle("clipboard:readText", async (): Promise<string> => {
    try {
      return clipboard.readText();
    } catch {
      return "";
    }
  });
  handle("clipboard:writeText", async (_e, text: string): Promise<void> => {
    if (typeof text !== "string" || text.length === 0) return;
    try {
      clipboard.writeText(text);
    } catch {
      /* best-effort */
    }
  });
  // ── SSH remote workspaces ──────────────────────────────────────────────
  // Host registry, pre-workspace folder browsing, connection lifecycle, and
  // the auth-prompt bridge (main asks → renderer modal answers).
  const broadcast = (channel: string, payload: unknown) => {
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) {
        try {
          wc.send(channel, payload);
        } catch {
          /* window mid-teardown */
        }
      }
    }
  };
  setAuthPromptSender((request) => broadcast("remote:authPrompt", request));
  setStatusSender((status) => broadcast("remote:status", status));

  handle("remote:listHosts", async (): Promise<RemoteHostConfig[]> => listHosts());
  handle(
    "remote:saveHost",
    async (_e, host: RemoteHostConfig): Promise<RemoteHostConfig[]> => saveManualHost(host),
  );
  handle(
    "remote:deleteHost",
    async (_e, hostId: string): Promise<RemoteHostConfig[]> => deleteManualHost(hostId),
  );
  handle(
    "remote:connect",
    async (_e, hostId: string): Promise<RemoteConnectionStatus> => {
      try {
        const conn = await getConnection(hostId);
        await conn.ensure();
      } catch {
        // getConnectionStatus below carries the error detail.
      }
      return getConnectionStatus(hostId);
    },
  );
  handle("remote:disconnect", async (_e, hostId: string): Promise<void> => {
    disconnectHost(hostId);
  });
  handle(
    "remote:status",
    async (_e, hostId: string): Promise<RemoteConnectionStatus> => getConnectionStatus(hostId),
  );
  handle(
    "remote:browse",
    async (_e, args: { hostId: string; path: string | null }): Promise<RemoteBrowseResult> =>
      browseRemoteDir(args.hostId, args.path),
  );
  ipcMain.on("remote:authPromptAnswer", (e, answer: RemoteAuthPromptAnswer) => {
    // Answers an SSH auth prompt (password/passphrase/host-key acceptance);
    // only the trusted renderer may answer, never a webview guest process.
    if (!isTrustedOnSender(e, "remote:authPromptAnswer")) return;
    answerAuthPrompt(answer);
  });
  handle(
    "remoteAccess:setEnabled",
    async (event, enabled: boolean): Promise<RemoteAccessStatus> => {
      const on = enabled === true;
      // Persist first so a crash mid-start still remembers the intent, then
      // fan the preference out exactly like the preferences:set handler.
      const next = await setPreference("remoteAccessEnabled", on);
      broadcastPreferencesChanged({ key: "remoteAccessEnabled", value: next.remoteAccessEnabled });
      const service = await getRemoteAccess();
      return service.setEnabled(on);
    },
  );
  handle("remoteAccess:startPairing", async (event): Promise<RemotePairingSession> => {
    const service = await getRemoteAccess();
    return service.startPairing();
  });
  handle("remoteAccess:cancelPairing", async (event): Promise<void> => {
    const service = await getRemoteAccess();
    service.cancelPairing();
  });
  handle("remoteAccess:listDevices", async (event): Promise<RemotePairedDevice[]> => {
    const service = await getRemoteAccess();
    return service.listPairedDevices();
  });
  handle(
    "remoteAccess:revokeDevice",
    async (event, publicKey: string): Promise<RemotePairedDevice[]> => {
      const service = await getRemoteAccess();
      // Awaited: the renderer's list must not repaint as "revoked" until the
      // removal is durable, so the UI can never claim a revocation that a
      // crash could undo.
      await service.revokeDevice(publicKey);
      return service.listPairedDevices();
    },
  );
  // Approving is what actually writes a device into the trust store, so it is
  // gated like the rest: only the real renderer's top frame can decide, never
  // a navigated-away document or a preview guest.
  handle("remoteAccess:approvePairing", async (event): Promise<void> => {
    const service = await getRemoteAccess();
    service.approvePairing();
  });
  handle("remoteAccess:denyPairing", async (event): Promise<void> => {
    const service = await getRemoteAccess();
    service.denyPairing();
  });

  // File clipboard bridge for the explorer's copy/cut/paste. Real OS-clipboard
  // interop with the native file manager via clipboard-files.ts (Windows
  // CF_HDROP, macOS NSPasteboard file URLs); both directions fail soft so the
  // renderer's in-app clipboard keeps working regardless.
  handle("clipboard:readFilePaths", async (): Promise<string[] | null> => {
    return readClipboardFilePaths();
  });
  handle(
    "clipboard:writeFilePaths",
    async (_e, args: { paths: string[] }): Promise<boolean> => {
      const paths = Array.isArray(args?.paths)
        ? args.paths.filter((p): p is string => typeof p === "string" && p.length > 0)
        : [];
      return writeClipboardFilePaths(paths);
    },
  );
  // Image paste bridge for terminal panes. Agent CLIs (Claude Code) accept an
  // image by its file path — dragging or pasting an image into their TUI turns
  // into an `[Image #N]` chip when they see a bracketed-paste of a path ending
  // in an image extension. The system clipboard, however, holds the image as
  // raw pixels, not a path. So when the clipboard carries an image (and no
  // usable text), materialise it as a PNG in the OS temp dir and return that
  // path for the renderer to shell-escape and bracketed-paste. Returns null
  // when the clipboard has no image, so the caller can fall back cleanly.
  handle("clipboard:readImageAsTempFile", async (): Promise<string | null> => {
    try {
      const image = clipboard.readImage();
      if (!image || image.isEmpty()) return null;
      const png = image.toPNG();
      if (!png || png.length === 0) return null;
      const filePath = join(
        app.getPath("temp"),
        `spark-paste-${Date.now()}-${randomUUID().slice(0, 8)}.png`,
      );
      await fs.writeFile(filePath, png);
      return filePath;
    } catch {
      return null;
    }
  });

  handle("app:openExternal", async (_e, url: string): Promise<void> => {
    if (typeof url !== "string" || url.length === 0) return;
    // file: URLs are deliberately NOT handed to shell.openExternal — on
    // Windows that executes the file with its default handler (e.g. a .bat),
    // so a malicious file:// URL would be remote code execution. Instead
    // reveal the target in the OS file manager (never run it). The preload's
    // openExternal already routes file:// to Codara's in-app browser, so this
    // branch only fires for callers (openInSystemBrowser) that hit the channel
    // directly.
    if (/^file:/i.test(url)) {
      try {
        const filePath = fileURLToPath(url);
        shell.showItemInFolder(filePath);
      } catch {
        /* malformed file: URL — drop it rather than guess a path. */
      }
      return;
    }
    // Electron's shell.openExternal accepts http(s) and a few extra schemes by
    // default; reject anything else so a malicious URL detected on the PTY
    // stream cannot launch arbitrary handlers.
    const safe = /^(https?:|mailto:)/i.test(url);
    if (!safe) return;
    try {
      await shell.openExternal(url);
    } catch {
      /* shell.openExternal rejects when no handler is registered; ignore. */
    }
  });

  // Auto-updater: renderer's "Restart and install" button calls this after
  // the download-complete event arrives. Lazy-imported so loading ipc.ts
  // never pulls in electron-updater on the dev/test path.
  handle("updater:quitAndInstall", async (): Promise<void> => {
    const { quitAndInstall } = await import("./auto-updater");
    quitAndInstall();
  });
}

// cora-memory keys the workspace tier by workspaceId and sanitizes whatever it
// is given, so an empty id would silently resolve to a real "_unknown.md" file
// the user could then toggle and clear. With no workspace open there is no
// workspace tier to report, so say so instead of inventing one.
async function readMemoryStatus(workspaceId: string | null): Promise<CoraMemoryStatus> {
  const { getMemoryStatus, MEMORY_FILE_MAX_BYTES } = coraMemory;
  const status = await getMemoryStatus(workspaceId ?? "");
  if (workspaceId) return status;
  return {
    global: status.global,
    workspace: {
      enabled: false,
      path: "",
      bytesUsed: 0,
      bytesCap: MEMORY_FILE_MAX_BYTES,
      overCap: false,
      counts: { user: 0, cora: 0, auto: 0 },
    },
  };
}

// The renderer disables the workspace controls when no workspace is open; this
// is the boundary check that makes that a guarantee rather than a UI habit.
function requireMemoryWorkspace(scope: CoraMemoryScope, workspaceId: string | null): string {
  if (scope !== "workspace") return workspaceId ?? "";
  if (!workspaceId) throw new Error("Open a workspace before changing its memory.");
  return workspaceId;
}

function parsePastedImageDataUrl(value: unknown): { mimeType: string; buffer: Buffer } {
  if (typeof value !== "string") throw new Error("Missing pasted image data.");
  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw new Error("Invalid pasted image data.");
  const mimeType = match[1].toLowerCase();
  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (buffer.byteLength === 0) throw new Error("Pasted image is empty.");
  return { mimeType, buffer };
}

function pastedImageStem(name: unknown): string {
  if (typeof name !== "string") return "pasted-image";
  const withoutExt = name.trim().replace(/\.[A-Za-z0-9]+$/, "");
  const safe = withoutExt.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "pasted-image";
}
