import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import type {
  RemoteAuthPromptAnswer,
  RemoteAuthPromptRequest,
  RemoteBrowseResult,
  RemoteConnectionStatus,
  RemoteHostConfig,
} from "@shared/remote";
import type {
  AddRunMessageInput,
  AnswerRunQuestionInput,
  AgentAssetDeleteResult,
  AgentAssetInstallResult,
  AgentAssetInventory,
  AgentMcpSaveResult,
  AgentMcpServerDetail,
  AgentMcpServerDraft,
  AgentMcpTarget,
  AgentRuntimeDiagnostic,
  AgentSyncResult,
  SparkBuiltinActionResult,
  SparkBuiltinMcpId,
  SparkBuiltinMcpStatus,
  SparkBuiltinRuntime,
  AppPreferences,
  AppSettings,
  AppState,
  AutomationDetail,
  AutomationWorkerInfo,
  CoraMemoryScope,
  CoraMemoryStatus,
  CreateEntryInput,
  CreateStepInput,
  CreateRunInput,
  CreateScheduledJobInput,
  CreateWorkerTaskInput,
  DeleteWorkerSessionInput,
  DeleteWorkerSessionResult,
  EnqueueRunInput,
  FileListResult,
  FsChangeEvent,
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
  GitSmartMergeResult,
  GitStashList,
  GitStatus,
  InterruptRunWithMessageInput,
  LaunchWorkerAttemptInput,
  MarkRunSeenInput,
  NavigationTarget,
  NotificationCenterEntry,
  NotificationCenterSummary,
  NotificationSoundKind,
  NotifyEvent,
  UpdateChatBackendInput,
  UpdateCoraWhiteboardInput,
  ExportCoraWhiteboardFileInput,
  ExportFileDialogInput,
  ImportedCoraWhiteboardFile,
  WorkerSessionRuntime,
  WorkerSessionSummary,
  PauseRunInput,
  PiRuntimeInstallEvent,
  PiSubscriptionAuthEvent,
  PiCatalogModel,
  PiSubscriptionOverview,
  PiUsageOverview,
  PiSubscriptionProvider,
  PlanFile,
  PrefKey,
  PreferencesChange,
  PrepareWorkerTaskInput,
  PtyExitInfo,
  QueuedRun,
  RenameRunInput,
  ResumeRunInput,
  RenameFileInput,
  RunArtifactPaths,
  RunQueueState,
  RunState,
  RuntimeState,
  ScheduledJob,
  SearchHit,
  SearchOptions,
  SearchSummary,
  ShellInfo,
  SparkEvent,
  StartAutopilotInput,
  StartSearchResponse,
  TerminalAgentAttentionPayload,
  TerminalAgentStatePayload,
  UiAttentionSnapshot,
  UndoToCheckpointInput,
  UndoToCheckpointResult,
  UpdateRunStatusInput,
  UpdateScheduledJobInput,
  UpdateStepInput,
  UpdateWorkerTaskInput,
  WorkerReport,
  WorkerTaskEnvelope,
} from "@shared/types";

type PtyDataHandler = (data: Uint8Array | string) => void;
type PtyExitHandler = (info: PtyExitInfo) => void;
type HostResumeHandler = (info: {
  reason: "resume" | "unlock-screen";
  at: number;
}) => void;
type OrchestrationEventHandler = (event: SparkEvent) => void;
type FsChangeHandler = (event: FsChangeEvent) => void;
type WindowStateHandler = (state: { maximized: boolean }) => void;
type PreferencesChangeHandler = (change: PreferencesChange) => void;
type InAppNotificationHandler = (payload: NotifyEvent) => void;
type NotificationSoundHandler = (info: { kind: NotificationSoundKind }) => void;
// Hits arrive batched (one IPC message per ~100 hits or per ~24ms) — see
// `streamGrep` in the main process. The handler receives the whole batch.
type SearchHitHandler = (hits: SearchHit[]) => void;
type SearchDoneHandler = (summary: SearchSummary) => void;

// electron-updater event surface. The main process narrows each
// autoUpdater.on(...) callback into one of these `kind` strings and bundles
// the relevant fields under `payload`. Renderer treats payload as an opaque
// bag and inspects only the fields it cares about per kind.
export type UpdaterEventKind =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "download-progress"
  | "update-downloaded"
  | "error";

export interface UpdaterEvent {
  kind: UpdaterEventKind;
  payload?: unknown;
}

type UpdaterEventHandler = (event: UpdaterEvent) => void;

export interface SearchStartCallbacks {
  onHit: SearchHitHandler;
  onDone: SearchDoneHandler;
}

export interface SearchHandle {
  searchId: string;
  /** Cancels the search and removes the streaming listeners. */
  cancel: () => Promise<void>;
}

function isMissingIpcHandlerError(err: unknown, channel: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(`No handler registered for '${channel}'`);
}

// One SessionStart hook record from the pane → session-identity registry
// (src/main/agent-session-registry.ts). Mirrors that module's shape; kept
// local so the preload stays free of main-process imports.
interface AgentSessionStartRecord {
  paneId: string;
  runtime: "claude";
  sessionId: string;
  transcriptPath?: string;
  cwd?: string;
  // "startup" | "resume" | "clear" | "compact" (SessionStart's `source`).
  source?: string;
  timestamp: string;
}

// One past conversation for a workspace cwd (src/main/agent-history.ts).
// Mirrors that module's AgentHistoryEntry; kept local so the preload stays
// free of main-process imports.
interface AgentHistoryEntry {
  runtime: "claude" | "codex";
  sessionId: string;
  cwd: string;
  title: string;
  lastActivityAt: string;
  transcriptPath: string;
}

const api = {
  state: {
    load: (): Promise<AppState> => ipcRenderer.invoke("state:load"),
    save: (state: AppState): Promise<void> => ipcRenderer.invoke("state:save", state),
    // Main-side clients such as the `cora` CLI can create a workspace while
    // the renderer is already open. Push the authoritative state immediately
    // so the new Cora session appears without requiring an app restart.
    onChanged: (handler: (state: AppState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: AppState) => handler(state);
      ipcRenderer.on("state:changed", listener);
      return () => ipcRenderer.off("state:changed", listener);
    },
  },
  settings: {
    load: (): Promise<AppSettings> => ipcRenderer.invoke("settings:load"),
    save: (settings: AppSettings): Promise<AppSettings> => ipcRenderer.invoke("settings:save", settings),
  },
  piSubscriptions: {
    status: (): Promise<PiSubscriptionOverview> => ipcRenderer.invoke("pi-subscriptions:status"),
    connect: (
      provider: PiSubscriptionProvider,
    ): Promise<{ requestId: string; provider: PiSubscriptionProvider }> =>
      ipcRenderer.invoke("pi-subscriptions:connect", { provider }),
    respond: (input: { requestId: string; promptId: string; value: string }): Promise<void> =>
      ipcRenderer.invoke("pi-subscriptions:respond", input),
    cancel: (requestId: string): Promise<void> =>
      ipcRenderer.invoke("pi-subscriptions:cancel", { requestId }),
    disconnect: (provider: PiSubscriptionProvider): Promise<PiSubscriptionOverview> =>
      ipcRenderer.invoke("pi-subscriptions:disconnect", { provider }),
    onEvent: (handler: (event: PiSubscriptionAuthEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, authEvent: PiSubscriptionAuthEvent) =>
        handler(authEvent);
      ipcRenderer.on("pi-subscriptions:event", listener);
      return () => ipcRenderer.off("pi-subscriptions:event", listener);
    },
    installRuntime: (): Promise<PiSubscriptionOverview> =>
      ipcRenderer.invoke("pi-runtime:install"),
    usage: (force = false): Promise<PiUsageOverview> =>
      ipcRenderer.invoke("pi-subscriptions:usage", { force }),
    // Returns [] rather than throwing when Pi is absent, so the picker falls
    // back to its curated rows instead of failing to render.
    catalog: (force = false): Promise<PiCatalogModel[]> =>
      ipcRenderer.invoke("pi-models:catalog", { force }).catch(() => []),
    onRuntimeInstallEvent: (handler: (event: PiRuntimeInstallEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, installEvent: PiRuntimeInstallEvent) =>
        handler(installEvent);
      ipcRenderer.on("pi-runtime:install-event", listener);
      return () => ipcRenderer.off("pi-runtime:install-event", listener);
    },
  },
  agents: {
    runtimes: (force = false): Promise<AgentRuntimeDiagnostic[]> =>
      ipcRenderer.invoke("agents:runtimes", { force }).catch((err: unknown) => {
        if (isMissingIpcHandlerError(err, "agents:runtimes")) return [];
        throw err;
      }),
    sync: (input?: { cwd?: string | null }): Promise<AgentSyncResult> =>
      ipcRenderer.invoke("agents:sync", input ?? {}).catch((err: unknown) => {
        if (!isMissingIpcHandlerError(err, "agents:sync")) throw err;
        const now = new Date().toISOString();
        return {
          startedAt: now,
          completedAt: now,
          mcp: { toClaude: [], toCodex: [], skipped: [], errors: ["Restart Codara to enable agent sync."] },
          skills: { toClaude: [], toCodex: [], skipped: [], errors: ["Restart Codara to enable agent sync."] },
        };
      }),
    assets: (input?: { cwd?: string | null }): Promise<AgentAssetInventory> =>
      ipcRenderer.invoke("agents:assets", input ?? {}).catch((err: unknown) => {
        if (isMissingIpcHandlerError(err, "agents:assets")) return { mcp: [], skills: [] };
        throw err;
      }),
    deleteAsset: (id: string): Promise<AgentAssetDeleteResult> =>
      ipcRenderer.invoke("agents:deleteAsset", { id }).catch((err: unknown) => {
        if (isMissingIpcHandlerError(err, "agents:deleteAsset")) {
          return { ok: false, deleted: [], error: "Restart Codara to enable agent asset deletion." };
        }
        throw err;
      }),
    installAsset: (id: string, target: "claude" | "codex"): Promise<AgentAssetInstallResult> =>
      ipcRenderer.invoke("agents:installAsset", { id, target }).catch((err: unknown) => {
        if (isMissingIpcHandlerError(err, "agents:installAsset")) {
          return { ok: false, installed: [], error: "Restart Codara to enable installing to another runtime." };
        }
        throw err;
      }),
    mcpTargets: (input?: { cwd?: string | null }): Promise<AgentMcpTarget[]> =>
      ipcRenderer.invoke("agents:mcpTargets", input ?? {}).catch((err: unknown) => {
        if (isMissingIpcHandlerError(err, "agents:mcpTargets")) return [];
        throw err;
      }),
    mcpDetail: (id: string): Promise<AgentMcpServerDetail | null> =>
      ipcRenderer.invoke("agents:mcpDetail", { id }).catch((err: unknown) => {
        if (isMissingIpcHandlerError(err, "agents:mcpDetail")) return null;
        throw err;
      }),
    saveMcpServer: (input: {
      cwd?: string | null;
      targetId: string;
      server: AgentMcpServerDraft;
      replaceId?: string | null;
    }): Promise<AgentMcpSaveResult> =>
      ipcRenderer.invoke("agents:saveMcpServer", input).catch((err: unknown) => {
        if (isMissingIpcHandlerError(err, "agents:saveMcpServer")) {
          return { ok: false, error: "Restart Codara to enable adding MCP servers." };
        }
        throw err;
      }),
    builtins: (): Promise<SparkBuiltinMcpStatus[]> =>
      ipcRenderer.invoke("agents:builtins").catch((err: unknown) => {
        if (isMissingIpcHandlerError(err, "agents:builtins")) return [];
        throw err;
      }),
    installBuiltin: (
      id: SparkBuiltinMcpId,
      runtime: SparkBuiltinRuntime,
    ): Promise<SparkBuiltinActionResult> =>
      ipcRenderer.invoke("agents:installBuiltin", { id, runtime }).catch((err: unknown) => {
        if (isMissingIpcHandlerError(err, "agents:installBuiltin")) {
          return { ok: false, error: "Restart Codara to enable installing built-in MCP servers." };
        }
        throw err;
      }),
    uninstallBuiltin: (
      id: SparkBuiltinMcpId,
      runtime: SparkBuiltinRuntime,
    ): Promise<SparkBuiltinActionResult> =>
      ipcRenderer.invoke("agents:uninstallBuiltin", { id, runtime }).catch((err: unknown) => {
        if (isMissingIpcHandlerError(err, "agents:uninstallBuiltin")) {
          return { ok: false, error: "Restart Codara to enable removing built-in MCP servers." };
        }
        throw err;
      }),
  },
  // Cora's writable memory files. Reads and mutations both resolve to the
  // fresh status pair for both tiers, so a toggle or a clear needs no follow-up
  // read. Content is edited in the editor, not through this bridge.
  memory: {
    get: (workspaceId: string | null): Promise<CoraMemoryStatus> =>
      ipcRenderer.invoke("memory:get", { workspaceId }),
    setEnabled: (
      scope: CoraMemoryScope,
      workspaceId: string | null,
      enabled: boolean,
    ): Promise<CoraMemoryStatus> =>
      ipcRenderer.invoke("memory:setEnabled", { scope, workspaceId, enabled }),
    clear: (
      scope: CoraMemoryScope,
      workspaceId: string | null,
      includeUserLines: boolean,
    ): Promise<CoraMemoryStatus> =>
      ipcRenderer.invoke("memory:clear", { scope, workspaceId, includeUserLines }),
  },
  preferences: {
    load: (): Promise<AppPreferences> => ipcRenderer.invoke("preferences:load"),
    set: <K extends PrefKey>(
      key: K,
      value: AppPreferences[K],
    ): Promise<AppPreferences> => ipcRenderer.invoke("preferences:set", { key, value }),
    onChanged: (handler: PreferencesChangeHandler): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, change: PreferencesChange) =>
        handler(change);
      ipcRenderer.on("preferences:changed", listener);
      return () => ipcRenderer.off("preferences:changed", listener);
    },
  },
  // Renderer surface of the unified notifications pipeline: the two
  // renderer-side delivery channels (in-app toast + embedded sound clip),
  // the click-routing target push ("notify:focus", fired by native
  // notification clicks for every kind), and the notification-center store.
  notifications: {
    onInAppNotification: (handler: InAppNotificationHandler): (() => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        payload: NotifyEvent,
      ) => handler(payload);
      ipcRenderer.on("notification:in-app", listener);
      return () => ipcRenderer.off("notification:in-app", listener);
    },
    onNotificationSound: (handler: NotificationSoundHandler): (() => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        info: { kind: NotificationSoundKind },
      ) => handler(info);
      ipcRenderer.on("notification:sound", listener);
      return () => ipcRenderer.off("notification:sound", listener);
    },
    // Where a clicked notification should navigate. Main sends this after
    // focusing the window (native-notification clicks); the renderer's
    // single routing listener dispatches on the target type.
    onFocusTarget: (handler: (target: NavigationTarget) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, target: NavigationTarget) =>
        handler(target);
      ipcRenderer.on("notify:focus", listener);
      return () => ipcRenderer.off("notify:focus", listener);
    },
    // Notification-center history (persisted main-side, capped at 200).
    list: (): Promise<NotificationCenterEntry[]> => ipcRenderer.invoke("notify:list"),
    markRead: (id: string): Promise<void> => ipcRenderer.invoke("notify:markRead", id),
    markAllRead: (): Promise<void> => ipcRenderer.invoke("notify:markAllRead"),
    // Remove a single entry — fired when the user acts on a notification
    // (toast click-through, inline answer, or opening the entry). Handled
    // items must not linger; the main side no-ops if it's already gone.
    remove: (id: string): Promise<void> => ipcRenderer.invoke("notify:remove", id),
    clear: (): Promise<void> => ipcRenderer.invoke("notify:clear"),
    onCenterUpdated: (
      handler: (summary: NotificationCenterSummary) => void,
    ): (() => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        summary: NotificationCenterSummary,
      ) => handler(summary);
      ipcRenderer.on("notify:center-updated", listener);
      return () => ipcRenderer.off("notify:center-updated", listener);
    },
  },
  shells: {
    list: (): Promise<ShellInfo[]> => ipcRenderer.invoke("shells:list"),
    default: (): Promise<ShellInfo | null> => ipcRenderer.invoke("shells:default"),
    // Returns the user's default shell with bundled OSC 7/133/633/8888
    // shell-integration wired in via cwd-staged scripts. Used by the bottom
    // terminal strip so a fresh interactive pane gets cwd/prompt/open-file
    // markers without touching the orchestration shell list.
    integratedDefault: (): Promise<ShellInfo> =>
      ipcRenderer.invoke("shells:integratedDefault"),
  },
  dialog: {
    openDirectory: (defaultPath?: string): Promise<string | null> =>
      ipcRenderer.invoke("dialog:openDirectory", defaultPath),
    openImages: (defaultPath?: string): Promise<string[]> =>
      ipcRenderer.invoke("dialog:openImages", defaultPath),
    exportWhiteboard: (input: ExportCoraWhiteboardFileInput): Promise<string | null> =>
      ipcRenderer.invoke("dialog:exportWhiteboard", input),
    importWhiteboard: (defaultPath?: string): Promise<ImportedCoraWhiteboardFile | null> =>
      ipcRenderer.invoke("dialog:importWhiteboard", defaultPath),
    // Generic dialog-based export for renderer-produced artifacts (board
    // images, …): prompts for a destination and writes utf8 text or base64
    // bytes. See dialog:exportFile in ipc.ts.
    exportFile: (input: ExportFileDialogInput): Promise<string | null> =>
      ipcRenderer.invoke("dialog:exportFile", input),
  },
  attachments: {
    savePastedImage: (input: { dataUrl: string; name?: string }): Promise<string> =>
      ipcRenderer.invoke("attachments:savePastedImage", input),
  },
  drawing: {
    save: (input: { dataUrl: string }): Promise<string> =>
      ipcRenderer.invoke("drawing:save", input),
  },
  fs: {
    list: (dir: string): Promise<FsEntry[]> => ipcRenderer.invoke("fs:list", dir),
    listFiles: (root: string): Promise<FileListResult> =>
      ipcRenderer.invoke("fs:listFiles", root),
    readText: (path: string): Promise<FsFileContent> => ipcRenderer.invoke("fs:readText", path),
    readEx: (path: string): Promise<FsReadResult> => ipcRenderer.invoke("fs:readEx", path),
    // Resolve a dropped File's absolute filesystem path. `File.path` was removed
    // under the sandbox in Electron 32; webUtils.getPathForFile is the supported
    // replacement (Electron 30+, synchronous, callable from a sandboxed preload).
    // Used by the terminal's Finder drag-and-drop (iTerm2-style path insertion).
    getPathForFile: (file: File): string => webUtils.getPathForFile(file),
    // Existence probe used by the terminal's file-link provider. `baseDir`
    // is the resolution base for relative targets (the tracked cwd of the
    // pane); absolute targets ignore it. Returns `{exists:false}` for any
    // path that fails the read sandbox so the caller can simply not light
    // up the link.
    pathExists: (input: { target: string; baseDir?: string }): Promise<{
      exists: boolean;
      isFile: boolean;
      resolved: string;
    }> => ipcRenderer.invoke("fs:pathExists", input),
    listMarkdownFiles: (root: string): Promise<PlanFile[]> =>
      ipcRenderer.invoke("fs:listMarkdownFiles", root),
    // Size + mtime only — used by the file previewers, which load content
    // via file:// URLs and never round-trip bytes through IPC.
    statFile: (path: string): Promise<{ size: number; mtimeMs: number }> =>
      ipcRenderer.invoke("fs:statFile", path),
    // Raw bytes (capped main-side) — pdf.js document data and the blob-URL
    // fallback path for previews when file:// subresources are unavailable.
    readFileBytes: (path: string): Promise<Uint8Array> =>
      ipcRenderer.invoke("fs:readFileBytes", path),
    // Editor save. `expectedMtimeMs` (autosave) makes the write conditional:
    // the main process refuses with kind:"conflict" if the file on disk
    // changed since the buffer loaded. Omitted (manual save) = always write.
    writeText: (
      path: string,
      content: string,
      opts?: { expectedMtimeMs?: number },
    ): Promise<FsWriteResult> =>
      ipcRenderer.invoke("fs:writeText", { path, content, expectedMtimeMs: opts?.expectedMtimeMs }),
    renameFile: (input: RenameFileInput): Promise<FsEntry> =>
      ipcRenderer.invoke("fs:renameFile", input),
    deleteFile: (path: string): Promise<void> => ipcRenderer.invoke("fs:deleteFile", path),
    createFile: (input: CreateEntryInput): Promise<FsEntry> =>
      ipcRenderer.invoke("fs:createFile", input),
    createFolder: (input: CreateEntryInput): Promise<FsEntry> =>
      ipcRenderer.invoke("fs:createFolder", input),
    // Copy externally-dropped files/folders into a workspace directory.
    importEntries: (input: { destDir: string; sourcePaths: string[] }): Promise<FsEntry[]> =>
      ipcRenderer.invoke("fs:importEntries", input),
    // Move workspace-internal files/folders into another workspace directory
    // (drag-and-drop MOVE). Each source must already live inside a workspace
    // root; the main side renames (copy+delete across volumes) rather than copy.
    moveEntries: (input: { destDir: string; sourcePaths: string[] }): Promise<FsEntry[]> =>
      ipcRenderer.invoke("fs:moveEntries", input),
    // Begin a native OS drag-out of the given workspace paths so the user can
    // drop them onto the desktop or another app. Fire-and-forget: the main
    // process owns the drag session via webContents.startDrag.
    startDrag: (paths: string[]): void => ipcRenderer.send("fs:startDrag", paths),
    setWatchRoot: (root: string | null): Promise<void> =>
      ipcRenderer.invoke("fs:setWatchRoot", root),
    revealInOS: (path: string): Promise<void> => ipcRenderer.invoke("fs:revealInOS", path),
    onChanged: (handler: FsChangeHandler): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: FsChangeEvent) => handler(event);
      ipcRenderer.on("fs:changed", listener);
      return () => ipcRenderer.off("fs:changed", listener);
    },
  },
  git: {
    status: (cwd: string): Promise<GitStatus> => ipcRenderer.invoke("git:status", cwd),
    log: (cwd: string): Promise<GitLog> => ipcRenderer.invoke("git:log", cwd),
    diff: (
      cwd: string,
      path: string,
      staged: boolean,
      untracked: boolean,
    ): Promise<GitDiff> =>
      ipcRenderer.invoke("git:diff", { cwd, path, staged, untracked }),
    stage: (cwd: string, paths: string[]): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:stage", { cwd, paths }),
    unstage: (cwd: string, paths: string[]): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:unstage", { cwd, paths }),
    stageAll: (cwd: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:stageAll", cwd),
    unstageAll: (cwd: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:unstageAll", cwd),
    discard: (cwd: string, files: GitFileChange[]): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:discard", { cwd, files }),
    commit: (cwd: string, message: string, amend?: boolean): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:commit", { cwd, message, amend }),
    generateCommitMessage: (cwd: string): Promise<GitCommitMessageResult> =>
      ipcRenderer.invoke("git:generateCommitMessage", cwd),
    push: (cwd: string): Promise<GitOpResult> => ipcRenderer.invoke("git:push", cwd),
    pull: (cwd: string): Promise<GitOpResult> => ipcRenderer.invoke("git:pull", cwd),
    fetch: (cwd: string): Promise<GitOpResult> => ipcRenderer.invoke("git:fetch", cwd),
    prepareSmartMerge: (cwd: string): Promise<GitSmartMergeResult> =>
      ipcRenderer.invoke("git:prepareSmartMerge", cwd),
    undoLastCommit: (cwd: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:undoLastCommit", cwd),
    checkout: (cwd: string, ref: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:checkout", { cwd, ref }),
    revert: (cwd: string, hash: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:revert", { cwd, hash }),
    init: (cwd: string): Promise<GitOpResult> => ipcRenderer.invoke("git:init", cwd),

    // Branches
    branches: (cwd: string): Promise<GitBranchList> =>
      ipcRenderer.invoke("git:branches", cwd),
    checkoutBranch: (cwd: string, name: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:checkoutBranch", { cwd, name }),
    createBranch: (
      cwd: string,
      name: string,
      opts?: { checkout?: boolean; startPoint?: string },
    ): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:createBranch", {
        cwd,
        name,
        checkout: opts?.checkout,
        startPoint: opts?.startPoint,
      }),
    renameBranch: (cwd: string, oldName: string, newName: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:renameBranch", { cwd, oldName, newName }),
    deleteBranch: (cwd: string, name: string, force?: boolean): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:deleteBranch", { cwd, name, force }),
    mergeBranch: (cwd: string, name: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:mergeBranch", { cwd, name }),

    // Copy-branch worktrees
    createCopyWorktree: (
      repoCwd: string,
      opts?: {
        checkoutBranch?: string;
        checkoutIsRemote?: boolean;
        newBranch?: string;
      },
    ): Promise<GitCopyWorktreeResult> =>
      ipcRenderer.invoke("git:createCopyWorktree", {
        repoCwd,
        checkoutBranch: opts?.checkoutBranch,
        checkoutIsRemote: opts?.checkoutIsRemote,
        newBranch: opts?.newBranch,
      }),
    removeCopyWorktree: (input: {
      repoCwd: string;
      worktreePath: string;
      branch: string;
      force?: boolean;
      deleteBranch?: boolean;
    }): Promise<GitOpResult> => ipcRenderer.invoke("git:removeCopyWorktree", input),

    // Stash
    stashes: (cwd: string): Promise<GitStashList> => ipcRenderer.invoke("git:stashes", cwd),
    stashSave: (
      cwd: string,
      opts?: { message?: string; includeUntracked?: boolean },
    ): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:stashSave", {
        cwd,
        message: opts?.message,
        includeUntracked: opts?.includeUntracked,
      }),
    stashApply: (cwd: string, ref: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:stashApply", { cwd, ref }),
    stashPop: (cwd: string, ref: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:stashPop", { cwd, ref }),
    stashDrop: (cwd: string, ref: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:stashDrop", { cwd, ref }),

    // Commit inspection
    commitDetail: (cwd: string, hash: string): Promise<GitCommitDetailResult> =>
      ipcRenderer.invoke("git:commitDetail", { cwd, hash }),
    commitFileDiff: (cwd: string, hash: string, path: string): Promise<GitDiff> =>
      ipcRenderer.invoke("git:commitFileDiff", { cwd, hash, path }),

    // Partial staging + conflict resolution
    applyPatch: (
      cwd: string,
      patch: string,
      opts: { cached: boolean; reverse: boolean },
    ): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:applyPatch", {
        cwd,
        patch,
        cached: opts.cached,
        reverse: opts.reverse,
      }),
    resolveConflict: (cwd: string, path: string, side: GitConflictSide): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:resolveConflict", { cwd, path, side }),
  },
  orchestration: {
    createRun: (input: CreateRunInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:createRun", input),
    getRun: (runId: string): Promise<RunState | null> =>
      ipcRenderer.invoke("orchestration:getRun", runId),
    readWorkerPrompt: (runId: string, attemptId: string): Promise<string> =>
      ipcRenderer.invoke("orchestration:readWorkerPrompt", { runId, attemptId }),
    listRuns: (workspaceId?: string): Promise<RunState[]> =>
      ipcRenderer.invoke("orchestration:listRuns", workspaceId),
    listEvents: (runId: string): Promise<SparkEvent[]> =>
      ipcRenderer.invoke("orchestration:listEvents", runId),
    getArtifactPaths: (runId: string): Promise<RunArtifactPaths> =>
      ipcRenderer.invoke("orchestration:getArtifactPaths", runId),
    appendTestEvent: (runId: string, message?: string): Promise<SparkEvent> =>
      ipcRenderer.invoke("orchestration:appendTestEvent", { runId, message }),
    startAutopilot: (input: StartAutopilotInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:startAutopilot", input),
    pauseRun: (input: PauseRunInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:pauseRun", input),
    pauseRunAfterCurrentWorkers: (input: PauseRunInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:pauseRunAfterCurrentWorkers", input),
    forcePauseRun: (runId: string): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:forcePauseRun", runId),
    stopAndUndoPending: (runId: string): Promise<UndoToCheckpointResult> =>
      ipcRenderer.invoke("orchestration:stopAndUndoPending", runId),
    resumeRun: (input: ResumeRunInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:resumeRun", input),
    addRunMessage: (input: AddRunMessageInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:addRunMessage", input),
    answerRunQuestion: (input: AnswerRunQuestionInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:answerRunQuestion", input),
    undoToCheckpoint: (input: UndoToCheckpointInput): Promise<UndoToCheckpointResult> =>
      ipcRenderer.invoke("orchestration:undoToCheckpoint", input),
    interruptRunWithMessage: (input: InterruptRunWithMessageInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:interruptRunWithMessage", input),
    updateRunStatus: (input: UpdateRunStatusInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:updateRunStatus", input),
    markRunSeen: (input: MarkRunSeenInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:markRunSeen", input),
    renameRun: (input: RenameRunInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:renameRun", input),
    updateWhiteboard: (input: UpdateCoraWhiteboardInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:updateWhiteboard", input),
    updateChatBackend: (input: UpdateChatBackendInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:updateChatBackend", input),
    createStep: (input: CreateStepInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:createStep", input),
    updateStep: (input: UpdateStepInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:updateStep", input),
    createWorkerTask: (input: CreateWorkerTaskInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:createWorkerTask", input),
    updateWorkerTask: (input: UpdateWorkerTaskInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:updateWorkerTask", input),
    prepareWorkerTask: (input: PrepareWorkerTaskInput): Promise<WorkerTaskEnvelope> =>
      ipcRenderer.invoke("orchestration:prepareWorkerTask", input),
    launchWorkerAttempt: (input: LaunchWorkerAttemptInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:launchWorkerAttempt", input),
    readWorkerReport: (path: string): Promise<WorkerReport | null> =>
      ipcRenderer.invoke("orchestration:readWorkerReport", path),
    deleteRun: (runId: string): Promise<void> =>
      ipcRenderer.invoke("orchestration:deleteRun", runId),
    onEvent: (handler: OrchestrationEventHandler): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: SparkEvent) => handler(event);
      ipcRenderer.on("orchestration:event", listener);
      return () => ipcRenderer.off("orchestration:event", listener);
    },
  },
  // Overnight run queue: a FIFO of pending autopilot runs drained under a
  // concurrency cap. Channels are registered in main's IPC layer (T4) and back
  // onto the RunQueue model in orchestration/run-queue.ts.
  queue: {
    list: (): Promise<RunQueueState> => ipcRenderer.invoke("queue:list"),
    enqueue: (input: EnqueueRunInput): Promise<QueuedRun> =>
      ipcRenderer.invoke("queue:enqueue", input),
    dequeue: (id: string): Promise<RunQueueState> =>
      ipcRenderer.invoke("queue:dequeue", id),
    setConcurrency: (n: number): Promise<RunQueueState> =>
      ipcRenderer.invoke("queue:setConcurrency", n),
    // burnDown drains the queue in place and resolves with the post-drain
    // snapshot (mirrors the queue:burnDown IPC handler's return).
    burnDown: (): Promise<RunQueueState> => ipcRenderer.invoke("queue:burnDown"),
  },
  // Scheduler registry: cron-style jobs that enqueue autopilot runs on a
  // schedule. Channels registered in main (T4); backed by the scheduler
  // registry stub in orchestration/scheduler.ts.
  scheduler: {
    list: (): Promise<ScheduledJob[]> => ipcRenderer.invoke("scheduler:list"),
    create: (input: CreateScheduledJobInput): Promise<ScheduledJob> =>
      ipcRenderer.invoke("scheduler:create", input),
    remove: (id: string): Promise<void> => ipcRenderer.invoke("scheduler:delete", id),
    setEnabled: (id: string, enabled: boolean): Promise<ScheduledJob> =>
      ipcRenderer.invoke("scheduler:setEnabled", { id, enabled }),
    runNow: (id: string): Promise<RunState> => ipcRenderer.invoke("scheduler:runNow", id),
    // Loop-aware controls (see automation-loop.ts).
    update: (input: UpdateScheduledJobInput): Promise<ScheduledJob> =>
      ipcRenderer.invoke("scheduler:update", input),
    pause: (id: string): Promise<ScheduledJob | undefined> =>
      ipcRenderer.invoke("scheduler:pause", id),
    resume: (id: string): Promise<ScheduledJob | undefined> =>
      ipcRenderer.invoke("scheduler:resume", id),
    stop: (id: string): Promise<ScheduledJob | undefined> =>
      ipcRenderer.invoke("scheduler:stop", id),
    getDetail: (id: string): Promise<AutomationDetail | null> =>
      ipcRenderer.invoke("scheduler:getDetail", id),
    // Looms v2: live direct-worker inventory for the Hub's Workers sub-tab.
    listActiveWorkers: (): Promise<AutomationWorkerInfo[]> =>
      ipcRenderer.invoke("automations:listActiveWorkers"),
  },
  pty: {
    spawn: (args: {
      id: string;
      shell: ShellInfo;
      cwd: string;
      cols: number;
      rows: number;
      env?: Record<string, string>;
      startupCommand?: string;
      // Mirror attach: observe an EXISTING session without touching its
      // state (no resize / no sink change / no tail replay). Set by readOnly
      // TerminalPanes; throws if the session does not exist.
      mirror?: boolean;
      // Result `attached` is true when spawn bound to an EXISTING session
      // (remount / mirror) instead of creating a fresh pty — startupCommand
      // is never delivered in that case.
    }): Promise<{ id: string; pid: number; startupCommandHandled?: boolean; attached?: boolean }> =>
      ipcRenderer.invoke("pty:spawn", args),
    write: (id: string, data: string): Promise<void> =>
      ipcRenderer.invoke("pty:write", { id, data }),
    inject: (id: string, text: string, opts?: { submit?: boolean }): Promise<void> =>
      ipcRenderer.invoke("pty:inject", { id, text, submit: opts?.submit }),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke("pty:resize", { id, cols, rows }),
    dispose: (id: string): Promise<void> => ipcRenderer.invoke("pty:dispose", { id }),
    exists: (id: string): Promise<boolean> => ipcRenderer.invoke("pty:exists", { id }),
    pause: (id: string): Promise<void> => ipcRenderer.invoke("pty:pause", { id }),
    resume: (id: string): Promise<void> => ipcRenderer.invoke("pty:resume", { id }),
    onHostResume: (handler: HostResumeHandler): (() => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        info: { reason: "resume" | "unlock-screen"; at: number },
      ) => handler(info);
      ipcRenderer.on("terminal:host-resumed", listener);
      return () => ipcRenderer.off("terminal:host-resumed", listener);
    },
    // Raw-tail-reattach variant of pause: drops main's renderer sink and
    // discards the pause/backlog state so the next spawn() replays the raw pty
    // tail into a fresh xterm (like a first attach). Used by ChatPanel's
    // backend terminal so a live Ink TUI reattaches cleanly instead of garbling.
    detach: (id: string): Promise<void> => ipcRenderer.invoke("pty:detach", { id }),
    onData: (id: string, handler: PtyDataHandler): (() => void) => {
      const channel = `pty:data:${id}`;
      const listener = (_e: Electron.IpcRendererEvent, data: Uint8Array | string) => handler(data);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.off(channel, listener);
    },
    onExit: (id: string, handler: PtyExitHandler): (() => void) => {
      const channel = `pty:exit:${id}`;
      const listener = (_e: Electron.IpcRendererEvent, info: PtyExitInfo) => handler(info);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.off(channel, listener);
    },
  },
  // Manual Claude/Codex terminal-pane session restore. Capture a launched
  // session's id, probe whether it still exists before resuming, and pre-seed
  // Codex directory trust. See src/main/ipc.ts "agentSession:*" handlers.
  agentSession: {
    // List resumable sessions whose recorded cwd matches the worker launch
    // directory. The main process reads CLI-owned JSONL metadata; transcript
    // contents remain on disk.
    list: (args: {
      runtime: WorkerSessionRuntime;
      cwd: string;
    }): Promise<WorkerSessionSummary[]> => ipcRenderer.invoke("agentSession:list", args),
    listAll: (): Promise<WorkerSessionSummary[]> => ipcRenderer.invoke("agentSession:listAll"),
    delete: (input: DeleteWorkerSessionInput): Promise<DeleteWorkerSessionResult> =>
      ipcRenderer.invoke("agentSession:delete", input),
    // Discover the session id of a Claude/Codex agent just detected running in a
    // pane, by finding the transcript it started writing for this cwd. Resolves
    // null on timeout.
    capture: (args: {
      runtime: "claude" | "codex";
      cwd: string;
      sinceMs: number;
      // Session ids already bound to other panes — discovery must never rebind
      // them to this pane (same-cwd concurrent-launch race).
      excludeSessionIds?: string[];
    }): Promise<{ sessionId: string; transcriptPath: string } | null> =>
      ipcRenderer.invoke("agentSession:capture", args),
    // Fire-and-forget diagnostic trail: restore decisions land in
    // <sparkHome>/logs/main.log so "this pane didn't resume" is debuggable.
    logRestore: (line: string): void => {
      ipcRenderer.send("agentSession:logRestore", line);
    },
    // Check a saved session's transcript still exists — and is resumable
    // (has a real user message; stillborn transcripts make `--resume` refuse)
    // — before resuming it.
    probe: (args: {
      runtime: "claude" | "codex";
      sessionId: string;
      cwd: string;
      transcriptPath?: string;
    }): Promise<{ exists: boolean; resumable?: boolean; repairable?: boolean; transcriptPath?: string }> =>
      ipcRenderer.invoke("agentSession:probe", args),
    // Pre-seed Codex directory trust before a `codex --yolo` (re)launch.
    ensureCodexTrust: (cwd: string): Promise<void> =>
      ipcRenderer.invoke("agentSession:ensureCodexTrust", { cwd }),
    // Repair a Claude transcript whose tail a sleep/crash truncated, so
    // `claude --resume` accepts it (keeps a .bak). No-op for Codex.
    repairTranscript: (args: {
      runtime: "claude" | "codex";
      sessionId: string;
      cwd: string;
    }): Promise<{ repaired: boolean }> =>
      ipcRenderer.invoke("agentSession:repairTranscript", args),
    // Newest SessionStart hook record for a pane — the EXACT session identity
    // last seen running there (covers in-TUI `/resume` and `/clear`, which
    // filesystem discovery can't observe). Null when no hook ever fired for
    // the pane (hooks not installed / python missing / external launch).
    latestStart: (paneId: string): Promise<AgentSessionStartRecord | null> =>
      ipcRenderer.invoke("agentSession:latestStart", { paneId }),
    // Every resumable Claude/Codex conversation recorded for a workspace cwd,
    // newest activity first — the pane-toolbar history menu's data source.
    history: (args: { cwd: string; limit?: number }): Promise<AgentHistoryEntry[]> =>
      ipcRenderer.invoke("agentSession:history", args),
    // Live SessionStart events, fired as Claude sessions start / resume /
    // clear inside Codara panes. Returns an unsubscribe.
    onStarted: (handler: (rec: AgentSessionStartRecord) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, rec: AgentSessionStartRecord) =>
        handler(rec);
      ipcRenderer.on("agentSession:started", listener);
      return () => ipcRenderer.off("agentSession:started", listener);
    },
  },
  terminalState: {
    /**
     * Report a transition in the live agent state for a single pane. Fired by
     * the renderer-side poller in `useTerminalSession`; main forwards the
     * update into run-store so any worker attempt hosted in that pane carries
     * the freshest "what is the agent doing" state.
     *
     * `paneId` is the same id used for pty:spawn — for Cora workers this is
     * the attemptId, for manual claude/codex panes it's the leaf id. Main
     * silently drops reports for panes that have no live WorkerAttempt
     * attached (manual user panes), so the IPC is safe to call from every
     * pane the poller is watching.
     */
    report: (input: { paneId: string; state: RuntimeState }): Promise<void> =>
      ipcRenderer.invoke("terminalState:report", input),
  },
  // Terminal-agent notifier (main-process watcher over manual claude/codex
  // panes). `sync` ships the active workspace's full terminal-pane registry.
  // Alert click navigation now arrives via notifications.onFocusTarget.
  terminalNotify: {
    sync: (input: {
      workspaceId: string;
      workspaceName?: string;
      panes: Array<{
        paneId: string;
        tabId: string;
        tabTitle: string;
        excluded: boolean;
        runtimeHint?: "claude" | "codex" | null;
      }>;
    }): Promise<TerminalAgentStatePayload[]> => ipcRenderer.invoke("terminalNotify:sync", input),
    // Level-triggered recovery for renderer reload/cold hydration. Live events
    // stay the fast path; this snapshot repairs any transition emitted before
    // the listener or restored worker chip existed.
    snapshot: (): Promise<TerminalAgentStatePayload[]> =>
      ipcRenderer.invoke("terminalNotify:snapshot"),
    // Fires alongside every terminal-agent alert (regardless of channel
    // settings) so the workspace rail can mark the owning workspace as
    // needing attention until the user visits the pane's tab.
    onAttention: (
      handler: (payload: TerminalAgentAttentionPayload) => void,
    ): (() => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        payload: TerminalAgentAttentionPayload,
      ) => handler(payload);
      ipcRenderer.on("terminal-agent:attention", listener);
      return () => ipcRenderer.off("terminal-agent:attention", listener);
    },
    // Focus-independent live chip state from the main-process notifier. Fires
    // on every turn-boundary transition the notifier detects on the raw pty
    // stream — including while the pane is hidden, which is exactly when the
    // renderer's own visible-buffer poller is frozen and the chip would
    // otherwise stay stuck on "working". The renderer routes `state` onto the
    // matching leaf.worker.runtimeState (never minting a worker).
    onState: (
      handler: (payload: TerminalAgentStatePayload) => void,
    ): (() => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        payload: TerminalAgentStatePayload,
      ) => handler(payload);
      ipcRenderer.on("terminal-agent:state", listener);
      return () => ipcRenderer.off("terminal-agent:state", listener);
    },
  },
  windowControls: {
    minimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke("window:toggleMaximize"),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:isMaximized"),
    close: (): Promise<void> => ipcRenderer.invoke("window:close"),
    // Hide the window to the system tray without quitting (close-to-tray).
    hideToTray: (): Promise<void> => ipcRenderer.invoke("window:hide-to-tray"),
    setTitleBarTheme: (theme: { color: string; symbolColor: string }): Promise<void> =>
      ipcRenderer.invoke("window:setTitleBarTheme", theme),
    onStateChanged: (handler: WindowStateHandler): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, state: { maximized: boolean }) => handler(state);
      ipcRenderer.on("window:state-changed", listener);
      return () => ipcRenderer.off("window:state-changed", listener);
    },
    // Fired by the tray menu's "Open Automations" item and the global
    // CommandOrControl+Shift+A accelerator so the renderer can switch to the
    // Automations view. Returns an unsubscribe function.
    onOpenAutomations: (handler: () => void): (() => void) => {
      const listener = () => handler();
      ipcRenderer.on("window:open-automations", listener);
      return () => ipcRenderer.off("window:open-automations", listener);
    },
  },
  app: {
    platform: (): Promise<NodeJS.Platform> => ipcRenderer.invoke("app:platform"),
    home: (): Promise<string> => ipcRenderer.invoke("app:home"),
    inspectorPreloadUrl: (): Promise<string> =>
      ipcRenderer.invoke("app:inspectorPreloadUrl"),
    // Fired by main just before the OS suspends (system sleep). The renderer
    // should synchronously flush any state it wouldn't want to lose if the
    // process is torn down during sleep (terminal tab tree + scrollback).
    // Returns an unsubscribe function.
    onCheckpoint: (handler: () => void): (() => void) => {
      const listener = () => handler();
      ipcRenderer.on("app:checkpoint", listener);
      return () => ipcRenderer.off("app:checkpoint", listener);
    },
    // Fired by main at the START of a quit (before-quit / window-all-closed),
    // BEFORE it kills the PTYs, so the renderer can mark teardown and stop
    // deactivating running agents' restore pointers as their shells die. Returns
    // an unsubscribe function.
    onBeforeQuit: (
      handler: (payload: { activeAgentPaneIds: string[] }) => void,
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload?: { activeAgentPaneIds?: unknown },
      ) =>
        handler({
          activeAgentPaneIds: Array.isArray(payload?.activeAgentPaneIds)
            ? payload.activeAgentPaneIds.filter(
                (paneId): paneId is string => typeof paneId === "string" && paneId.length > 0,
              )
            : [],
        });
      ipcRenderer.on("app:before-quit", listener);
      return () => ipcRenderer.off("app:before-quit", listener);
    },
    // Renderer boot handshake: App calls this once React has mounted. Main's
    // boot watchdog escalates (reload → relaunch/dialog) if a loaded page never
    // signals ready — the "splash breathing forever" hang after system sleep.
    signalReady: (): void => {
      ipcRenderer.send("app:renderer-ready");
    },
  },
  ui: {
    // Tell main which filesystem roots the renderer considers in scope right
    // now. Main uses this list to gate fs:* read handlers; renderer should
    // call it on boot and whenever the workspace list changes.
    setAllowedRoots: (roots: string[]): Promise<void> =>
      ipcRenderer.invoke("ui:setAllowedRoots", roots),
    // Tells main what the user is looking at — window focus + active
    // workspace/tab/run/pane in one snapshot — so the notify policy can
    // suppress alerts for the surface already on screen.
    setAttention: (snapshot: UiAttentionSnapshot): Promise<void> =>
      ipcRenderer.invoke("ui:setAttention", snapshot),
  },
  clipboard: {
    readText: (): Promise<string> => ipcRenderer.invoke("clipboard:readText"),
    writeText: (text: string): Promise<void> =>
      ipcRenderer.invoke("clipboard:writeText", text),
    // When the system clipboard holds an image, write it to a PNG in the OS
    // temp dir and return its absolute path (null if the clipboard has no
    // image). Used by the terminal paste path so agent CLIs receive an image
    // file path they can turn into an `[Image #N]` chip.
    readImageAsTempFile: (): Promise<string | null> =>
      ipcRenderer.invoke("clipboard:readImageAsTempFile"),
    // Explorer file clipboard (Windows CF_HDROP interop). Null / false when
    // the OS clipboard holds no files or interop is unavailable — callers
    // fall back to the in-app clipboard state.
    readFilePaths: (): Promise<string[] | null> =>
      ipcRenderer.invoke("clipboard:readFilePaths"),
    writeFilePaths: (paths: string[]): Promise<boolean> =>
      ipcRenderer.invoke("clipboard:writeFilePaths", { paths }),
  },
  // SSH remote workspaces: host registry, connection lifecycle, the
  // pre-workspace folder browser, and the auth-prompt bridge.
  remote: {
    listHosts: (): Promise<RemoteHostConfig[]> => ipcRenderer.invoke("remote:listHosts"),
    saveHost: (host: RemoteHostConfig): Promise<RemoteHostConfig[]> =>
      ipcRenderer.invoke("remote:saveHost", host),
    deleteHost: (hostId: string): Promise<RemoteHostConfig[]> =>
      ipcRenderer.invoke("remote:deleteHost", hostId),
    connect: (hostId: string): Promise<RemoteConnectionStatus> =>
      ipcRenderer.invoke("remote:connect", hostId),
    disconnect: (hostId: string): Promise<void> => ipcRenderer.invoke("remote:disconnect", hostId),
    status: (hostId: string): Promise<RemoteConnectionStatus> =>
      ipcRenderer.invoke("remote:status", hostId),
    browse: (hostId: string, path: string | null): Promise<RemoteBrowseResult> =>
      ipcRenderer.invoke("remote:browse", { hostId, path }),
    answerAuthPrompt: (answer: RemoteAuthPromptAnswer): void => {
      ipcRenderer.send("remote:authPromptAnswer", answer);
    },
    onAuthPrompt: (handler: (request: RemoteAuthPromptRequest) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, request: RemoteAuthPromptRequest) =>
        handler(request);
      ipcRenderer.on("remote:authPrompt", listener);
      return () => ipcRenderer.off("remote:authPrompt", listener);
    },
    onStatus: (handler: (status: RemoteConnectionStatus) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, status: RemoteConnectionStatus) =>
        handler(status);
      ipcRenderer.on("remote:status", listener);
      return () => ipcRenderer.off("remote:status", listener);
    },
    // Which agent CLIs (claude/codex) are installed on the host — used to
    // hint before launching a remote agent terminal.
    detectAgents: (hostIdOrPath: string): Promise<{ hostId: string; claude: boolean; codex: boolean }> =>
      ipcRenderer.invoke("remote:detectAgents", hostIdOrPath),
  },
  // cora-preview MCP bridge: main forwards preview-tool requests here, the
  // renderer dispatches against the picked preview tab and sends a response
  // back through ipcRenderer.send. One listener per renderer process.
  previewBridge: {
    onRequest: (
      handler: (req: { reqId: string; op: string; params: Record<string, unknown> }) => void,
    ): (() => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        req: { reqId: string; op: string; params: Record<string, unknown> },
      ) => handler(req);
      ipcRenderer.on("preview-bridge:request", listener);
      return () => ipcRenderer.off("preview-bridge:request", listener);
    },
    sendResponse: (response: { reqId: string; ok: boolean; result?: unknown; error?: string }): void => {
      ipcRenderer.send("preview-bridge:response", response);
    },
    // Announce a preview tab's guest webContents id (fired at dom-ready) so
    // main's computer-use executor can wire console capture before the
    // agent's first op.
    announce: (payload: { tabId: string; webContentsId: number }): void => {
      ipcRenderer.send("preview-bridge:announce", payload);
    },
  },
  // codara-studio MCP terminal bridge: main forwards terminal.create requests
  // here, the renderer mints an agent-tinted terminal tab via useTabs and sends
  // back the new tabId + paneId. One listener per renderer process. (Mirrors
  // previewBridge; terminal.write/read talk to the PTY directly in main and do
  // not use this channel.)
  terminalBridge: {
    onRequest: (
      handler: (req: { reqId: string; op: string; params: Record<string, unknown> }) => void,
    ): (() => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        req: { reqId: string; op: string; params: Record<string, unknown> },
      ) => handler(req);
      ipcRenderer.on("terminal-bridge:request", listener);
      return () => ipcRenderer.off("terminal-bridge:request", listener);
    },
    sendResponse: (response: { reqId: string; ok: boolean; result?: unknown; error?: string }): void => {
      ipcRenderer.send("terminal-bridge:response", response);
    },
  },
  updater: {
    // Subscribe to electron-updater lifecycle events. The returned function
    // unsubscribes the listener; callers should invoke it in a useEffect
    // cleanup so the banner component doesn't leak listeners on remount.
    onEvent: (handler: UpdaterEventHandler): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: UpdaterEvent) => handler(event);
      ipcRenderer.on("updater:event", listener);
      return () => ipcRenderer.off("updater:event", listener);
    },
    // Triggered by the "Restart and install" button after the
    // update-downloaded event. Main side calls autoUpdater.quitAndInstall()
    // which quits the app and runs the installer.
    quitAndInstall: (): Promise<void> => ipcRenderer.invoke("updater:quitAndInstall"),
  },
  inlineAi: {
    complete: (req: {
      prefix: string;
      suffix: string;
      filename: string | null;
      language: string | null;
      modelId: string;
      requestId: string;
    }): Promise<{ text: string; error: string | null }> =>
      ipcRenderer.invoke("inline-ai:complete", req),
    abort: (requestId: string): Promise<void> =>
      ipcRenderer.invoke("inline-ai:abort", requestId),
  },
  search: {
    /**
     * Start a streaming search. The promise resolves to a handle exposing
     * the assigned `searchId` and a `cancel()` that both kills the rg
     * process in main and unsubscribes the renderer-side listeners. Hits
     * arrive via `onHit` and the search ends with a single `onDone` call
     * carrying the summary.
     */
    start: async (
      opts: SearchOptions,
      callbacks: SearchStartCallbacks,
    ): Promise<SearchHandle> => {
      const { searchId } = (await ipcRenderer.invoke(
        "search:start",
        opts,
      )) as StartSearchResponse;
      const hitChannel = `search:hit:${searchId}`;
      const doneChannel = `search:done:${searchId}`;
      const hitListener = (_e: Electron.IpcRendererEvent, hits: SearchHit[]) =>
        callbacks.onHit(hits);
      const doneListener = (
        _e: Electron.IpcRendererEvent,
        summary: SearchSummary,
      ) => {
        ipcRenderer.off(hitChannel, hitListener);
        ipcRenderer.off(doneChannel, doneListener);
        callbacks.onDone(summary);
      };
      ipcRenderer.on(hitChannel, hitListener);
      ipcRenderer.on(doneChannel, doneListener);
      return {
        searchId,
        cancel: async () => {
          ipcRenderer.off(hitChannel, hitListener);
          ipcRenderer.off(doneChannel, doneListener);
          await ipcRenderer.invoke("search:cancel", searchId);
        },
      };
    },
    cancel: (searchId: string): Promise<void> =>
      ipcRenderer.invoke("search:cancel", searchId),
  },
  // Browser-ish URLs should stay inside Codara by default. Non-browser
  // schemes still route through Electron so mailto: and friends work.
  openExternal: async (url: string): Promise<void> => {
    if (isBrowserUrl(url)) {
      dispatchOpenInSparkBrowser(url);
      return;
    }
    await ipcRenderer.invoke("app:openExternal", url);
  },
  // Explicit user action: unlike a normal link navigation, this must never
  // recycle an orchestration-owned/background preview. It creates a focused,
  // workspace-level Preview tab with the normal top-strip controls.
  openInNewPreview: async (url: string): Promise<void> => {
    if (isBrowserUrl(url)) {
      dispatchOpenInSparkBrowser(url, { forceNew: true });
      return;
    }
    await ipcRenderer.invoke("app:openExternal", url);
  },
  openInSystemBrowser: (url: string): Promise<void> =>
    ipcRenderer.invoke("app:openExternal", url),
  view: {
    // Chromium zoom levels are integer-ish steps where each unit is ~20% of
    // the page scale. Clamp to the same range Chrome uses (~25% → ~500%) so
    // repeated keypresses can't pin the UI at an unusable scale.
    getZoomLevel: (): number => webFrame.getZoomLevel(),
    setZoomLevel: (level: number): void => {
      const clamped = Math.max(-5, Math.min(8, level));
      webFrame.setZoomLevel(clamped);
    },
    zoomBy: (delta: number): void => {
      const next = webFrame.getZoomLevel() + delta;
      const clamped = Math.max(-5, Math.min(8, next));
      webFrame.setZoomLevel(clamped);
    },
  },
};

function isBrowserUrl(url: string): boolean {
  return /^(https?:|file:)/i.test(url);
}

function dispatchOpenInSparkBrowser(
  url: string,
  options?: { forceNew?: boolean },
): void {
  const rendererWindow = globalThis as unknown as {
    dispatchEvent: (event: CustomEvent) => boolean;
  };
  rendererWindow.dispatchEvent(
    new CustomEvent("spark:open-browser-url", {
      detail: { url, forceNew: options?.forceNew === true },
    }),
  );
}

ipcRenderer.on("app:open-browser-url", (_event, url: string) => {
  if (typeof url === "string" && isBrowserUrl(url)) {
    dispatchOpenInSparkBrowser(url);
  }
});

// Replay chord keystrokes from a focused <webview> guest as a synthetic
// KeyboardEvent on the host window. The main process is the one that
// observes them via `before-input-event` (a WebContents-only event — the
// <webview> tag does not surface it) and pushes the relevant fields here.
// useGlobalShortcuts.ts registers a capture-phase listener on window, so
// dispatching on window is what makes Ctrl+1, Cmd+P Quick Open, … work when
// focus is inside an embedded page.
type WebviewChordKey = {
  key: string;
  code?: string;
  modifiers?: ReadonlyArray<string>;
};
ipcRenderer.on("webview:chord-key", (_event, payload: WebviewChordKey) => {
  if (!payload || typeof payload.key !== "string" || !payload.key) return;
  const mods = payload.modifiers ?? [];
  const synth = new KeyboardEvent("keydown", {
    key: payload.key,
    code: payload.code ?? "",
    ctrlKey: mods.includes("ctrl") || mods.includes("control"),
    shiftKey: mods.includes("shift"),
    altKey: mods.includes("alt"),
    metaKey: mods.includes("meta") || mods.includes("cmd"),
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(synth);
});

// Liveness pong. Main sends `app:health-ping` with a nonce on wake-from-sleep
// (and can at any time) to check the renderer is still pumping its event loop;
// we echo the nonce straight back. Handled here in preload rather than in React
// so a healthy-but-mid-reload renderer still answers — and, crucially, a
// renderer whose JS main thread is WEDGED (the "frozen/blank after sleep"
// symptom) can't run this listener either, so main's ping simply times out and
// it recovers the window. No React dependency, no per-component wiring.
ipcRenderer.on("app:health-ping", (_event, nonce: number) => {
  ipcRenderer.send("app:health-pong", nonce);
});

contextBridge.exposeInMainWorld("spark", api);

export type SparkApi = typeof api;
