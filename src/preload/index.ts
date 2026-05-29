import { contextBridge, ipcRenderer, webFrame } from "electron";
import type {
  AddRunMessageInput,
  AgentAssetDeleteResult,
  AgentAssetInstallResult,
  AgentAssetInventory,
  AgentRuntimeDiagnostic,
  AgentSyncResult,
  SparkBuiltinActionResult,
  SparkBuiltinMcpId,
  SparkBuiltinMcpStatus,
  SparkBuiltinRuntime,
  AppPreferences,
  AppSettings,
  AppState,
  CreateEntryInput,
  CreateStepInput,
  CreateRunInput,
  CreateWorkerTaskInput,
  FileListResult,
  FsChangeEvent,
  FsEntry,
  FsFileContent,
  FsReadResult,
  GitCommitMessageResult,
  GitDiff,
  GitFileChange,
  GitLog,
  GitOpResult,
  GitSmartMergeResult,
  GitStatus,
  InAppNotificationPayload,
  InterruptRunWithMessageInput,
  LaunchWorkerAttemptInput,
  MarkRunSeenInput,
  NotificationSoundKind,
  UpdateChatBackendInput,
  PauseRunInput,
  PlanFile,
  PrefKey,
  PreferencesChange,
  PrepareWorkerTaskInput,
  RenameRunInput,
  ResumeRunInput,
  RenameFileInput,
  RunArtifactPaths,
  RunState,
  RuntimeState,
  SearchHit,
  SearchOptions,
  SearchSummary,
  ShellInfo,
  SparkEvent,
  StartAutopilotInput,
  StartSearchResponse,
  UndoToCheckpointInput,
  UndoToCheckpointResult,
  UpdateRunStatusInput,
  UpdateStepInput,
  UpdateWorkerTaskInput,
  WorkerReport,
  WorkerTaskEnvelope,
} from "@shared/types";

type PtyDataHandler = (data: Uint8Array | string) => void;
type PtyExitHandler = (info: { exitCode: number; signal?: number }) => void;
type OrchestrationEventHandler = (event: SparkEvent) => void;
type FsChangeHandler = (event: FsChangeEvent) => void;
type WindowStateHandler = (state: { maximized: boolean }) => void;
type PreferencesChangeHandler = (change: PreferencesChange) => void;
type InAppNotificationHandler = (payload: InAppNotificationPayload) => void;
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

const api = {
  state: {
    load: (): Promise<AppState> => ipcRenderer.invoke("state:load"),
    save: (state: AppState): Promise<void> => ipcRenderer.invoke("state:save", state),
  },
  settings: {
    load: (): Promise<AppSettings> => ipcRenderer.invoke("settings:load"),
    save: (settings: AppSettings): Promise<AppSettings> => ipcRenderer.invoke("settings:save", settings),
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
          mcp: { toClaude: [], toCodex: [], skipped: [], errors: ["Restart Spark to enable agent sync."] },
          skills: { toClaude: [], toCodex: [], skipped: [], errors: ["Restart Spark to enable agent sync."] },
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
          return { ok: false, deleted: [], error: "Restart Spark to enable agent asset deletion." };
        }
        throw err;
      }),
    installAsset: (id: string, target: "claude" | "codex"): Promise<AgentAssetInstallResult> =>
      ipcRenderer.invoke("agents:installAsset", { id, target }).catch((err: unknown) => {
        if (isMissingIpcHandlerError(err, "agents:installAsset")) {
          return { ok: false, installed: [], error: "Restart Spark to enable installing to another runtime." };
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
          return { ok: false, error: "Restart Spark to enable installing built-in MCP servers." };
        }
        throw err;
      }),
    uninstallBuiltin: (
      id: SparkBuiltinMcpId,
      runtime: SparkBuiltinRuntime,
    ): Promise<SparkBuiltinActionResult> =>
      ipcRenderer.invoke("agents:uninstallBuiltin", { id, runtime }).catch((err: unknown) => {
        if (isMissingIpcHandlerError(err, "agents:uninstallBuiltin")) {
          return { ok: false, error: "Restart Spark to enable removing built-in MCP servers." };
        }
        throw err;
      }),
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
  // Renderer subscriptions for the four-channel notification system.
  // Two channels are renderer-side (in-app toast + embedded sound clip);
  // the other two (native Notification, OS dock badge / taskbar flash)
  // live entirely in main and don't surface here.
  notifications: {
    onInAppNotification: (handler: InAppNotificationHandler): (() => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        payload: InAppNotificationPayload,
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
    writeText: (path: string, content: string): Promise<FsFileContent> =>
      ipcRenderer.invoke("fs:writeText", { path, content }),
    renameFile: (input: RenameFileInput): Promise<FsEntry> =>
      ipcRenderer.invoke("fs:renameFile", input),
    deleteFile: (path: string): Promise<void> => ipcRenderer.invoke("fs:deleteFile", path),
    createFile: (input: CreateEntryInput): Promise<FsEntry> =>
      ipcRenderer.invoke("fs:createFile", input),
    createFolder: (input: CreateEntryInput): Promise<FsEntry> =>
      ipcRenderer.invoke("fs:createFolder", input),
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
    commit: (cwd: string, message: string): Promise<GitOpResult> =>
      ipcRenderer.invoke("git:commit", { cwd, message }),
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
  },
  orchestration: {
    createRun: (input: CreateRunInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:createRun", input),
    getRun: (runId: string): Promise<RunState | null> =>
      ipcRenderer.invoke("orchestration:getRun", runId),
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
  pty: {
    spawn: (args: {
      id: string;
      shell: ShellInfo;
      cwd: string;
      cols: number;
      rows: number;
      env?: Record<string, string>;
      startupCommand?: string;
    }): Promise<{ id: string; pid: number; startupCommandHandled?: boolean }> =>
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
    onData: (id: string, handler: PtyDataHandler): (() => void) => {
      const channel = `pty:data:${id}`;
      const listener = (_e: Electron.IpcRendererEvent, data: Uint8Array | string) => handler(data);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.off(channel, listener);
    },
    onExit: (id: string, handler: PtyExitHandler): (() => void) => {
      const channel = `pty:exit:${id}`;
      const listener = (_e: Electron.IpcRendererEvent, info: { exitCode: number; signal?: number }) =>
        handler(info);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.off(channel, listener);
    },
  },
  terminalState: {
    /**
     * Report a transition in the live agent state for a single pane. Fired by
     * the renderer-side poller in `useTerminalSession`; main forwards the
     * update into run-store so any worker attempt hosted in that pane carries
     * the freshest "what is the agent doing" state.
     *
     * `paneId` is the same id used for pty:spawn — for Spark workers this is
     * the attemptId, for manual claude/codex panes it's the leaf id. Main
     * silently drops reports for panes that have no live WorkerAttempt
     * attached (manual user panes), so the IPC is safe to call from every
     * pane the poller is watching.
     */
    report: (input: { paneId: string; state: RuntimeState }): Promise<void> =>
      ipcRenderer.invoke("terminalState:report", input),
  },
  windowControls: {
    minimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke("window:toggleMaximize"),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:isMaximized"),
    close: (): Promise<void> => ipcRenderer.invoke("window:close"),
    setTitleBarTheme: (theme: { color: string; symbolColor: string }): Promise<void> =>
      ipcRenderer.invoke("window:setTitleBarTheme", theme),
    onStateChanged: (handler: WindowStateHandler): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, state: { maximized: boolean }) => handler(state);
      ipcRenderer.on("window:state-changed", listener);
      return () => ipcRenderer.off("window:state-changed", listener);
    },
  },
  app: {
    platform: (): Promise<NodeJS.Platform> => ipcRenderer.invoke("app:platform"),
    home: (): Promise<string> => ipcRenderer.invoke("app:home"),
    inspectorPreloadUrl: (): Promise<string> =>
      ipcRenderer.invoke("app:inspectorPreloadUrl"),
  },
  ui: {
    // Tell main which filesystem roots the renderer considers in scope right
    // now. Main uses this list to gate fs:* read handlers; renderer should
    // call it on boot and whenever the workspace list changes.
    setAllowedRoots: (roots: string[]): Promise<void> =>
      ipcRenderer.invoke("ui:setAllowedRoots", roots),
    // Tells main which run the user is currently looking at so the
    // notification module can suppress "run complete" alerts for that run.
    // Null = no run selected (e.g. the new-chat draft composer).
    setActiveRun: (id: string | null): Promise<void> =>
      ipcRenderer.invoke("ui:setActiveRun", id),
  },
  clipboard: {
    readText: (): Promise<string> => ipcRenderer.invoke("clipboard:readText"),
    writeText: (text: string): Promise<void> =>
      ipcRenderer.invoke("clipboard:writeText", text),
  },
  // Spark-preview MCP bridge: main forwards preview-tool requests here, the
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
  // Browser-ish URLs should stay inside Spark by default. Non-browser
  // schemes still route through Electron so mailto: and friends work.
  openExternal: async (url: string): Promise<void> => {
    if (isBrowserUrl(url)) {
      dispatchOpenInSparkBrowser(url);
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

function dispatchOpenInSparkBrowser(url: string): void {
  const rendererWindow = globalThis as unknown as {
    dispatchEvent: (event: CustomEvent) => boolean;
  };
  rendererWindow.dispatchEvent(
    new CustomEvent("spark:open-browser-url", {
      detail: { url },
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
// dispatching on window is what makes Ctrl+1, Cmd+P, … keep working when
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

contextBridge.exposeInMainWorld("spark", api);

export type SparkApi = typeof api;
