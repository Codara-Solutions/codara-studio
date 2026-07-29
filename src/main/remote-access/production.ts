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
import { isRemotePath } from "@shared/remote";
import type {
  AppState,
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
import {
  addRunMessage,
  answerRunQuestion,
  getRun,
  getRunBoard,
  listRuns,
  startAutopilot,
  updateRunBoard,
} from "../orchestration/run-store";
import { BOARD_MAX_CARDS } from "../orchestration/board-store";
import { ensureCodexProjectTrust } from "../orchestration/codex-trust";
import { subscribeToEvents } from "../orchestration/event-log";
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
import { loadState, onStateSaved, saveState } from "../storage";
import { requestTerminalOp } from "../terminal-bridge";
import {
  deleteWorkerSession as deleteLocalWorkerSession,
  listWorkerSessions as listLocalWorkerSessions,
} from "../worker-sessions";
import {
  RemoteAccessService,
  type RemoteTerminalCreateRequest,
  type RemoteTerminalHandle,
} from "./index";
import { findRemoteCoraRetry, KeyedSerialQueue } from "./cora-policy";
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
  RemoteAutomationRunRecord,
  RemoteAutomationTriggerKind,
  RemoteBoard,
  RemoteBoardAction,
  RemoteBoardCard,
  RemoteBoardUpdateResult,
  RemoteCoraMessage,
  RemoteCoraRun,
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
} from "./rpc";

let singleton: RemoteAccessService | null = null;
let stateSavedSubscriptionInstalled = false;
let workspaceMutation: Promise<void> = Promise.resolve();
const coraMessageMutations = new KeyedSerialQueue();
const fileMutations = new KeyedSerialQueue();
let lastRemoteImagePruneAt = 0;

const WORKSPACE_COLORS = [
  "#2AA298",
  "#7FB3FF",
  "#5BD68F",
  "#FF5C2B",
  "#C99BFF",
  "#E0E0E0",
  "#FF8FB1",
  "#5DD6D6",
] as const;

// DTO budgets deliberately leave generous headroom under the 1 MiB frame
// ceiling for JSON escaping and the response envelope.
const COLLECTION_BUDGET_BYTES = 384 * 1024;
const REMOTE_FILE_MAX_BYTES = 384 * 1024;
const CORA_MESSAGE_MAX_BYTES = 32 * 1024;
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
  fsConstants.O_RDONLY |
  ((fsConstants.O_NOFOLLOW as number | undefined) ?? 0);

const ACTIVE_WORKER_ATTEMPT_STATUSES = new Set([
  "preparing",
  "prompt_ready",
  "launching",
  "running",
  "finishing",
]);

export function getRemoteAccessService(): RemoteAccessService {
  if (!singleton) {
    singleton = new RemoteAccessService({
      remoteDir: join(sparkHome(), "remote"),
      deviceName: hostname(),
      appVersion: app.getVersion(),
      listWorkspaces: listWorkspacesForRemote,
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
      listCoraHistory: listCoraHistoryForRemote,
      getCoraRun: getCoraRunForRemote,
      sendCoraMessage: sendCoraMessageForRemote,
      getCoraWhiteboard: getCoraWhiteboardForRemote,
      getCoraBoard: getCoraBoardForRemote,
      updateCoraBoard: updateCoraBoardForRemote,
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
      createTerminal: createRemoteTerminal,
      log: (line) => logMain("remote-access", line),
    });
  }
  if (!stateSavedSubscriptionInstalled) {
    stateSavedSubscriptionInstalled = true;
    onStateSaved(() => singleton?.notifyWorkspacesChanged());
  }
  startPhoneNotificationBridge(singleton);
  return singleton;
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
    .catch((err) => logMain("remote-access", `boot enable failed: ${(err as Error).message}`));
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
  };
}

function remoteWorkspaceGroupName(value: string): string {
  const name = truncateUtf8(
    value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(),
    512,
  );
  if (!name) throw new Error("Workspace folder names cannot be empty.");
  return name;
}

async function workspaceInfo(workspace: Workspace): Promise<RemoteWorkspaceInfo> {
  let branch: string | undefined;
  try {
    const status = await readGitStatus(workspace.cwd);
    if (status.isRepo && status.branch) branch = truncateUtf8(status.branch, 240);
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

async function listDirectoriesForRemote(rawPath?: string): Promise<RemoteDirectoryListing> {
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
    .filter((candidate) => candidate.isDirectory() && !candidate.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))) {
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
      const existing = await realpath(resolve(workspace.cwd)).catch(() => resolve(workspace.cwd));
      if (existing === selected.path) return workspaceInfo(workspace);
    }

    const usedColors = new Set(state.workspaces.map((workspace) => workspace.color.toLowerCase()));
    const color =
      WORKSPACE_COLORS.find((candidate) => !usedColors.has(candidate.toLowerCase())) ??
      WORKSPACE_COLORS[state.workspaces.length % WORKSPACE_COLORS.length];
    const requestedName = input.name?.trim();
    const workspace: Workspace = {
      id: `ws-mobile-${randomUUID()}`,
      name: truncateUtf8(requestedName || basename(selected.path) || "workspace", 512),
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

async function createWorkspaceGroupForRemote(name: string): Promise<RemoteWorkspaceGroupInfo> {
  return serializeWorkspaceMutation(async () => {
    const state = await loadState();
    if (state.workspaceGroups.length >= MAX_REMOTE_WORKSPACE_GROUPS) {
      throw new Error(`Codara Studio supports at most ${MAX_REMOTE_WORKSPACE_GROUPS} remote workspace folders.`);
    }
    const group: WorkspaceGroup = {
      id: `workspace-group-mobile-${randomUUID()}`,
      name: remoteWorkspaceGroupName(name),
      collapsed: false,
    };
    const next: AppState = {
      ...state,
      workspaceGroups: [...state.workspaceGroups, group],
      workspaceRailOrder: normalizeWorkspaceRailOrderForRemote(
        [...(state.workspaceRailOrder ?? []), group.id],
        state.workspaces,
        [...state.workspaceGroups, group],
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
}): Promise<RemoteWorkspaceGroupInfo> {
  return serializeWorkspaceMutation(async () => {
    const state = await loadState();
    const index = state.workspaceGroups.findIndex((group) => group.id === input.groupId);
    if (index < 0) throw new Error("This workspace folder no longer exists.");
    const current = state.workspaceGroups[index];
    const updated: WorkspaceGroup = {
      ...current,
      ...(input.name !== undefined
        ? { name: remoteWorkspaceGroupName(input.name) }
        : {}),
      ...(input.collapsed !== undefined ? { collapsed: input.collapsed } : {}),
    };
    const workspaceGroups = state.workspaceGroups.slice();
    workspaceGroups[index] = updated;
    await persistRemoteWorkspaceState({ ...state, workspaceGroups });
    return workspaceGroupInfo(updated);
  });
}

async function deleteWorkspaceGroupForRemote(groupId: string): Promise<void> {
  return serializeWorkspaceMutation(async () => {
    const state = await loadState();
    const groupIndex = state.workspaceGroups.findIndex((group) => group.id === groupId);
    if (groupIndex < 0) throw new Error("This workspace folder no longer exists.");
    const workspaceGroups = state.workspaceGroups.filter((group) => group.id !== groupId);
    const releasedIds: string[] = [];
    const workspaces = state.workspaces.map((workspace) => {
      if (workspace.groupId !== groupId) return workspace;
      releasedIds.push(workspace.id);
      const { groupId: _discarded, ...ungrouped } = workspace;
      return ungrouped;
    });
    const oldOrder = state.workspaceRailOrder ?? [];
    const oldIndex = oldOrder.indexOf(groupId);
    const withoutGroup = oldOrder.filter(
      (itemId) => itemId !== groupId && !releasedIds.includes(itemId),
    );
    withoutGroup.splice(
      oldIndex >= 0 ? Math.min(oldIndex, withoutGroup.length) : withoutGroup.length,
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
      throw new Error("A workspace folder position cannot use a top-level destination.");
    }
    if (
      input.beforeWorkspaceId === input.workspaceId ||
      ((sourceIndex >= 0 && !state.workspaces[sourceIndex].groupId) &&
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
        throw new Error("The requested workspace position is no longer available.");
      }
    }

    const source = state.workspaces[sourceIndex];
    const remaining = state.workspaces.filter(
      (workspace) => workspace.id !== input.workspaceId,
    );
    const moved: Workspace = input.groupId
      ? { ...source, groupId: input.groupId }
      : (() => {
          const { groupId: _discarded, ...ungrouped } = source;
          return ungrouped;
        })();
    let insertAt = input.beforeWorkspaceId
      ? remaining.findIndex((workspace) => workspace.id === input.beforeWorkspaceId)
      : -1;
    if (insertAt < 0) {
      let lastInDestination = -1;
      for (let index = 0; index < remaining.length; index += 1) {
        if ((remaining[index].groupId ?? null) === input.groupId) {
          lastInDestination = index;
        }
      }
      insertAt = lastInDestination >= 0 ? lastInDestination + 1 : remaining.length;
    }
    const workspaces = remaining.slice();
    workspaces.splice(insertAt, 0, moved);

    let railOrder = normalizeWorkspaceRailOrderForRemote(
      state.workspaceRailOrder ?? [],
      workspaces,
      state.workspaceGroups,
    ).filter((itemId) => itemId !== input.workspaceId);
    if (input.groupId === null) {
      if (
        input.beforeRailItemId &&
        !state.workspaceGroups.some((group) => group.id === input.beforeRailItemId) &&
        !state.workspaces.some(
          (workspace) =>
            workspace.id === input.beforeRailItemId &&
            !isRemotePath(workspace.cwd) &&
            workspace.id !== input.workspaceId &&
            !(workspace.groupId &&
              state.workspaceGroups.some((group) => group.id === workspace.groupId)),
        )
      ) {
        throw new Error("The requested top-level position is no longer available.");
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
    await persistRemoteWorkspaceState({ ...state, workspaces, workspaceRailOrder: railOrder });
    return workspaceInfo(moved);
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
      throw new Error("The requested workspace rail position no longer exists.");
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
      throw new Error("The requested workspace rail position no longer exists.");
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
    ...workspaces.filter((workspace) => !workspace.groupId).map((workspace) => workspace.id),
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

function serializeWorkspaceMutation<T>(operation: () => Promise<T>): Promise<T> {
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

async function requireLocalWorkspace(
  workspaceId: string,
): Promise<{ workspace: Workspace; root: string }> {
  const state = await loadState();
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
  if (isRemotePath(workspace.cwd)) {
    throw new Error("This workspace lives on an SSH host; open it on the computer instead.");
  }
  const resolved = await resolveExistingInside(workspace.cwd, undefined, { directory: true });
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
    const extension = entry.isFile() ? extname(entry.name).slice(1).toLowerCase() : "";
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
    parentPath: path ? (posix.dirname(path) === "." ? "" : posix.dirname(path)) : null,
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
  const handle = await open(target.path, READ_ONLY_NO_FOLLOW_FLAGS).catch(() => null);
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
      const read = await handle.read(data, offset, data.length - offset, offset);
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
      ...(input.parentPath !== undefined ? { parentPath: input.parentPath } : {}),
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

async function getGitStatusForRemote(workspaceId: string): Promise<RemoteGitStatus> {
  const { root } = await requireLocalWorkspace(workspaceId);
  const status = await readGitStatus(root);
  let usedBytes = 2;
  const fitChanges = (changes: typeof status.staged): RemoteGitChange[] => {
    const result: RemoteGitChange[] = [];
    for (const change of changes) {
      const item: RemoteGitChange = {
        path: truncateUtf8(change.path, 4096),
        ...(change.oldPath ? { oldPath: truncateUtf8(change.oldPath, 4096) } : {}),
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
    ...(status.upstream ? { upstream: truncateUtf8(status.upstream, 500) } : {}),
    ahead: status.ahead,
    behind: status.behind,
    staged: fitChanges(status.staged),
    unstaged: fitChanges(status.unstaged),
    hasConflicts: status.hasConflicts,
    ...(status.error ? { error: truncateUtf8(status.error, 1000) } : {}),
  };
}

async function getGitLogForRemote(input: {
  workspaceId: string;
  limit: number;
}): Promise<RemoteGitLog> {
  const { root } = await requireLocalWorkspace(input.workspaceId);
  const log = await readGitLog(root);
  const limit = Math.max(1, Math.min(MAX_GIT_LOG_COMMITS, Math.floor(input.limit)));
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
  let usedBytes = Buffer.byteLength(JSON.stringify({ ...base, files: [] }), "utf8");
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
  const result: RemoteCoraRunSummary[] = [];
  let usedBytes = 2;
  for (const run of runs.slice(0, MAX_CORA_RUNS)) {
    const summary = toRemoteRunSummary(run);
    const bytes = Buffer.byteLength(JSON.stringify(summary), "utf8") + 1;
    if (usedBytes + bytes > COLLECTION_BUDGET_BYTES) break;
    result.push(summary);
    usedBytes += bytes;
  }
  return result;
}

async function getCoraRunForRemote(input: {
  workspaceId: string;
  runId: string;
}): Promise<RemoteCoraRun> {
  await requireLocalWorkspace(input.workspaceId);
  const run = await requireOwnedRun(input.workspaceId, input.runId);
  return toRemoteRun(run);
}

async function sendCoraMessageForRemote(input: {
  workspaceId: string;
  runId?: string;
  message: string;
  clientMessageId: string;
}): Promise<RemoteCoraRun> {
  const { workspace, root } = await requireLocalWorkspace(input.workspaceId);
  const message = input.message.trim();
  if (Buffer.byteLength(message, "utf8") > CORA_MESSAGE_MAX_BYTES) {
    throw new Error(`Cora messages are limited to ${CORA_MESSAGE_MAX_BYTES / 1024} KiB.`);
  }
  const clientMessageId = input.clientMessageId.trim();
  if (!clientMessageId || Buffer.byteLength(clientMessageId, "utf8") > 256) {
    throw new Error("clientMessageId is invalid.");
  }

  const mutationKey = JSON.stringify([workspace.id, clientMessageId]);
  return coraMessageMutations.run(mutationKey, async () => {
    // This lookup is deliberately inside the key queue and reads persisted run
    // messages. It covers a reply lost after commit, a reconnect retry, and
    // concurrent deliveries before a new conversation has a run id.
    const retry = findRemoteCoraRetry(await listRuns(workspace.id), {
      workspaceId: workspace.id,
      ...(input.runId ? { runId: input.runId } : {}),
      message,
      clientMessageId,
    });
    if (retry) return toRemoteRun(retry);

    let run: RunState;
    if (!input.runId) {
      run = await startAutopilot({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        cwd: root,
        initialUserNote: message,
        initialUserNoteClientMessageId: clientMessageId,
      });
    } else {
      const existing = await requireOwnedRun(workspace.id, input.runId);
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
    return toRemoteRun(run);
  });
}

async function requireOwnedRun(workspaceId: string, runId: string): Promise<RunState> {
  const run = await getRun(runId);
  if (!run || run.workspaceId !== workspaceId) {
    throw new Error(`Cora run not found in this workspace: ${runId}`);
  }
  return run;
}

function toRemoteRunSummary(run: RunState): RemoteCoraRunSummary {
  const lastMessage = run.humanMessages.at(-1)?.message;
  const costUsd =
    run.totalCostUsd !== undefined || run.estimatedWorkerCostUsd !== undefined
      ? (run.totalCostUsd ?? 0) + (run.estimatedWorkerCostUsd ?? 0)
      : undefined;
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    title: truncateUtf8(run.title, 512),
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    messageCount: run.humanMessages.length,
    ...(lastMessage ? { lastMessage: truncateUtf8(lastMessage, 512) } : {}),
    activeWorkers: run.workerAttempts.filter((attempt) =>
      ACTIVE_WORKER_ATTEMPT_STATUSES.has(attempt.status),
    ).length,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(run.automationId ? { automated: true } : {}),
  };
}

// Worker roster for the phone's run header: active attempts first, then the
// most recent settled ones, capped so a long run cannot bloat every poll.
function toRemoteRunWorkers(run: RunState): RemoteCoraWorker[] {
  const titles = new Map(run.workerTasks.map((task) => [task.id, task.title]));
  const toWorker = (attempt: RunState["workerAttempts"][number]): RemoteCoraWorker => ({
    id: attempt.id,
    title: truncateUtf8(titles.get(attempt.workerTaskId) || "Worker", 300),
    runtime: attempt.runtime,
    ...(attempt.model ? { model: truncateUtf8(attempt.model, 120) } : {}),
    status: attempt.status,
    ...(attempt.startedAt ? { startedAt: attempt.startedAt } : {}),
    ...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
  });
  const active = run.workerAttempts.filter((attempt) =>
    ACTIVE_WORKER_ATTEMPT_STATUSES.has(attempt.status),
  );
  const settled = run.workerAttempts.filter(
    (attempt) => !ACTIVE_WORKER_ATTEMPT_STATUSES.has(attempt.status),
  );
  // slice(-0) would return the whole array, so the settled fill is guarded.
  const settledBudget = Math.max(0, MAX_CORA_RUN_WORKERS - active.length);
  const recentSettled = settledBudget > 0 ? settled.slice(-settledBudget) : [];
  return [...active, ...recentSettled].slice(0, MAX_CORA_RUN_WORKERS).map(toWorker);
}

// Steps a step will never leave: the plan progress line counts all three as
// finished so a skipped step cannot stall the count at "3 of 5" forever.
const FINISHED_STEP_STATUSES = new Set(["complete", "completed_unverified", "skipped"]);

// Plan progress for the phone's run header. The list is capped but the totals
// are computed over the whole plan, so a long plan still reports honestly.
function toRemoteRunSteps(run: RunState): {
  steps: RemoteCoraStep[];
  total: number;
  finished: number;
} {
  const ordered = [...run.steps].sort((left, right) => left.index - right.index);
  return {
    steps: ordered.slice(0, MAX_CORA_RUN_STEPS).map((step) => ({
      title: truncateUtf8(step.title, 300),
      status: step.status,
    })),
    total: ordered.length,
    finished: ordered.filter((step) => FINISHED_STEP_STATUSES.has(step.status)).length,
  };
}

function toRemoteRun(run: RunState): RemoteCoraRun {
  const messages: RemoteCoraMessage[] = [];
  let usedBytes = 2;
  for (const message of run.humanMessages.slice(-MAX_CORA_MESSAGES).reverse()) {
    const item: RemoteCoraMessage = {
      id: message.id,
      author: message.author === "spark" ? "cora" : message.author,
      kind: message.kind,
      message: truncateUtf8(message.message, 16 * 1024),
      createdAt: message.createdAt,
    };
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (usedBytes + bytes > COLLECTION_BUDGET_BYTES) break;
    messages.push(item);
    usedBytes += bytes;
  }
  messages.reverse();
  const workers = toRemoteRunWorkers(run);
  const plan = toRemoteRunSteps(run);
  const boardCards = run.board?.cards.length ?? 0;
  const whiteboardNodes = run.whiteboard?.nodes.length ?? 0;
  const blockedMessage = run.blockedOn
    ? run.humanMessages.find((message) => message.id === run.blockedOn?.questionMessageId)
    : undefined;
  return {
    ...toRemoteRunSummary(run),
    messages,
    ...(workers.length > 0 ? { workers } : {}),
    ...(plan.total > 0
      ? { steps: plan.steps, stepsTotal: plan.total, stepsFinished: plan.finished }
      : {}),
    ...(boardCards > 0 ? { boardCards } : {}),
    ...(whiteboardNodes > 0 ? { whiteboardNodes } : {}),
    ...(run.blockedOn && blockedMessage
      ? {
          blockedQuestion: {
            messageId: blockedMessage.id,
            message: truncateUtf8(blockedMessage.message, 16 * 1024),
          },
        }
      : {}),
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
      const match = sessions.find((session) => session.sessionId === input.sessionId);
      if (!match) {
        throw new Error("That session is no longer in this workspace's history.");
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
        warnings: result.warnings.slice(0, 4).map((warning) => truncateUtf8(warning, 512)),
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
      ? { description: truncateUtf8(card.description, REMOTE_BOARD_DESCRIPTION_MAX_BYTES) }
      : {}),
    status: card.status,
    order: card.order,
    ...(card.workerTaskId ? { workerTaskId: truncateUtf8(card.workerTaskId, 200) } : {}),
    ...(card.createdBy ? { createdBy: card.createdBy } : {}),
    ...(card.error ? { error: truncateUtf8(card.error, REMOTE_BOARD_ERROR_MAX_BYTES) } : {}),
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
}): Promise<RemoteBoard> {
  await requireLocalWorkspace(input.workspaceId);
  await requireOwnedRun(input.workspaceId, input.runId);
  return toRemoteBoard(await getRunBoard(input.runId));
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
      throw new Error("This board is full. Clear some cards in Codara Studio first.");
    }
    const lane = cards.filter((card) => card.status === "idea");
    next = [
      ...cards,
      {
        id: makeId("card"),
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
        status: "idea",
        order: lane.length > 0 ? Math.max(...lane.map((card) => card.order)) + 1 : 1,
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
        throw new Error("Cards on an automation's chat cannot be queued from the phone.");
      }
      // Queueing is the go signal: the board write emits run.board_updated,
      // which is what wakes this chat's Cora (orchestration/board-nudge).
      const lane = cards.filter((card) => card.status === "queued");
      const order = lane.length > 0 ? Math.max(...lane.map((card) => card.order)) + 1 : 1;
      next = cards.map((card) =>
        card.id === target.id
          ? { ...card, status: "queued" as BoardCardStatus, order, updatedAt: now }
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
      return { kind: "cron", summary: `On schedule (${truncateUtf8(trigger.expr, 60)})` };
    case "interval":
      return { kind: "interval", summary: `Every ${formatIntervalMs(trigger.everyMs)}` };
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

function toRemoteAutomation(job: ScheduledJob): RemoteAutomationInfo {
  const trigger = describeAutomationTrigger(job.trigger);
  const lastRecord = job.history.at(-1);
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
    ...(job.state.spentUsd !== undefined ? { spentUsd: job.state.spentUsd } : {}),
  };
}

async function listAutomationsForRemote(
  workspaceId: string,
): Promise<RemoteAutomationInfo[]> {
  await requireLocalWorkspace(workspaceId);
  const jobs = (await listJobs()).filter((job) => job.input.workspaceId === workspaceId);
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

// The loom's detail: what it is asking for, which worker runs it, and how the
// recent passes went. Read only; authoring and the node graph stay desktop-side.
async function getAutomationForRemote(input: {
  workspaceId: string;
  automationId: string;
}): Promise<RemoteAutomationDetail> {
  const job = await requireOwnedAutomation(input.workspaceId, input.automationId);
  const template = job.prompt?.template ?? job.input.initialUserNote ?? "";
  const prompt = template.slice(0, REMOTE_AUTOMATION_PROMPT_CHARS);

  const history: RemoteAutomationRunRecord[] = [];
  let usedBytes = 2;
  for (const record of [...job.history].reverse().slice(0, MAX_REMOTE_AUTOMATION_HISTORY)) {
    const item: RemoteAutomationRunRecord = {
      iteration: record.iteration,
      runId: record.runId,
      startedAt: record.startedAt,
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      status: record.status,
      ...(record.summary ? { summary: truncateUtf8(record.summary, 1000) } : {}),
      ...(record.costUsd !== undefined ? { costUsd: record.costUsd } : {}),
      ...(record.stopReason ? { stopReason: record.stopReason } : {}),
    };
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (usedBytes + bytes > COLLECTION_BUDGET_BYTES) break;
    history.push(item);
    usedBytes += bytes;
  }

  return {
    ...toRemoteAutomation(job),
    ...(job.worker?.model ? { model: truncateUtf8(job.worker.model, 120) } : {}),
    ...(job.worker?.effort ? { effort: job.worker.effort } : {}),
    ...(job.worker?.timeoutMinutes !== undefined
      ? { timeoutMinutes: job.worker.timeoutMinutes }
      : {}),
    ...(prompt ? { prompt } : {}),
    ...(template.length > prompt.length ? { promptTruncated: true } : {}),
    history,
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
  if (!job) throw new Error("That automation no longer exists in this workspace.");
  return { automation: toRemoteAutomation(job), runId: run.id };
}

async function pauseAutomationForRemote(input: {
  workspaceId: string;
  automationId: string;
}): Promise<RemoteAutomationInfo> {
  await requireOwnedAutomation(input.workspaceId, input.automationId);
  const job = await pauseJob(input.automationId);
  if (!job) throw new Error("That automation no longer exists in this workspace.");
  return toRemoteAutomation(job);
}

async function resumeAutomationForRemote(input: {
  workspaceId: string;
  automationId: string;
}): Promise<RemoteAutomationInfo> {
  await requireOwnedAutomation(input.workspaceId, input.automationId);
  const job = await resumeJob(input.automationId);
  if (!job) throw new Error("That automation no longer exists in this workspace.");
  return toRemoteAutomation(job);
}

async function setAutomationEnabledForRemote(input: {
  workspaceId: string;
  automationId: string;
  enabled: boolean;
}): Promise<RemoteAutomationInfo> {
  await requireOwnedAutomation(input.workspaceId, input.automationId);
  return toRemoteAutomation(await setJobEnabled(input.automationId, input.enabled));
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
  phoneNotifyStore ??= new PhoneNotificationStore(join(sparkHome(), "remote"), (line) =>
    logMain("remote-access", line),
  );
  return phoneNotifyStore;
}

// Same idempotency guard the desktop run adapter uses: one canonical journal
// event never notifies twice even if a subscriber re-registers or retries.
function claimPhoneNotifyEvent(eventId: string): boolean {
  if (handledPhoneNotifyEventIds.has(eventId)) return false;
  handledPhoneNotifyEventIds.add(eventId);
  if (handledPhoneNotifyEventIds.size > MAX_HANDLED_PHONE_NOTIFY_EVENT_IDS) {
    const oldest = handledPhoneNotifyEventIds.values().next().value as string | undefined;
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

async function remoteWorkspaceName(workspaceId: string): Promise<string | undefined> {
  if (!workspaceId) return undefined;
  try {
    const state = await loadState();
    const name = state.workspaces.find((workspace) => workspace.id === workspaceId)?.name;
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
      typeof payload?.status === "string" ? (payload.status as RunStatus) : undefined;
    const prevStatus =
      typeof payload?.previousStatus === "string"
        ? (payload.previousStatus as RunStatus)
        : undefined;
    const automationId =
      typeof payload?.automationId === "string" && payload.automationId.length > 0
        ? payload.automationId
        : undefined;
    const runId = event.runId;
    if (!status || !runId || prevStatus === status) return null;
    if (status !== "blocked" && status !== "complete" && status !== "failed") return null;
    if (!claimPhoneNotifyEvent(event.id)) return null;
    // Mirror the desktop policy's context gates (notify/policy.ts decide()):
    // DND mutes every alert, and a completion for the run the user is
    // actively watching in Studio is suppressed. "Needs you" survives
    // watching on the desktop, so it survives here too.
    if (getPreferenceCached("notificationsDnd") === true) return null;
    if ((status === "complete" || status === "failed") && isWatchingRun(runId)) return null;

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
          body: event.message?.trim() || "An automation is waiting on your answer.",
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
        event.message?.trim() || (ok ? "Cora finished a run." : "A run failed."),
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
    if (payload?.status !== "stopped" || typeof payload.automationId !== "string") {
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
      typeof payload.iteration === "number" && Number.isFinite(payload.iteration)
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
    if (service.pushPhoneNotificationToDevice(devicePublicKey, notification)) continue;
    const registration = await store.get(devicePublicKey);
    if (!registration?.enabled || !registration.token) continue;
    if (!phoneNotificationKindAllowed(notification.kind, registration.prefs)) continue;
    pushTargets.push({ devicePublicKey, token: registration.token });
  }
  // Earlier sends' tickets are due a verdict by now; resolve them before
  // adding this send's own.
  await pollExpoReceipts();
  if (pushTargets.length === 0) return;
  const outcomes = await sendExpoPushMessages(pushTargets, notification);
  for (const outcome of outcomes) {
    if (outcome.ok) {
      if (outcome.ticketId) expoReceipts.add(outcome.ticketId, outcome.devicePublicKey);
      continue;
    }
    if (outcome.deviceNotRegistered) await store.clearToken(outcome.devicePublicKey);
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
    if (failure.deviceNotRegistered) await store.clearToken(failure.devicePublicKey);
    logMain(
      "remote-access",
      `expo push receipt for ${failure.devicePublicKey.slice(0, 8)} failed: ${failure.detail}`,
    );
  }
}

function startPhoneNotificationBridge(service: RemoteAccessService): void {
  if (phoneNotifyStarted) return;
  phoneNotifyStarted = true;
  subscribeToEvents((event) => {
    void (async () => {
      const notification = await buildPhoneNotification(event);
      if (!notification) return;
      await deliverPhoneNotification(service, notification);
    })().catch((err) => {
      logMain("remote-access", `phone notify failed: ${(err as Error).message}`);
    });
  });
  // Backstop for quiet periods: without another send, a pending receipt would
  // otherwise wait forever for its verdict.
  const receiptTimer = setInterval(() => {
    void pollExpoReceipts().catch(() => undefined);
  }, EXPO_RECEIPT_POLL_MS);
  receiptTimer.unref?.();
}

// Phone terminals are real renderer-owned tabs. The bridge mints the leaf,
// TerminalPane spawns its PTY, and this service taps that same PTY for the
// encrypted phone stream. The session remains the lifecycle owner: disconnect
// or revoke closes both the PTY and its visible desktop tab.
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
  const resumeSession =
    request.resumeSessionId && resumableRuntime
      ? (
          await listLocalWorkerSessions(resumableRuntime, cwd.path)
        ).find((session) => session.sessionId === request.resumeSessionId)
      : null;
  if (request.resumeSessionId && !resumeSession) {
    throw new Error("That worker session is no longer resumable in this workspace.");
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
  const result = await requestTerminalOp<{
    tabId: string;
    paneId: string;
    cwd: string;
  }>(
    "create",
    {
      cwd: cwd.path,
      ...(command ? { command } : {}),
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
  if (!result?.tabId || !result.paneId) {
    throw new Error("Codara did not create the terminal tab.");
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
    throw new Error("The terminal failed to start. Check that its directory is accessible.");
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
        logMain("remote-access", `desktop terminal resize mirror missed: ${(err as Error).message}`);
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
