import { contextBridge, ipcRenderer } from "electron";
import type {
  AddRunMessageInput,
  AppPreferences,
  AppSettings,
  AppState,
  CreateEntryInput,
  CreateStepInput,
  CreateRunInput,
  CreateWorkerTaskInput,
  FsChangeEvent,
  FsEntry,
  FsFileContent,
  FsReadResult,
  GitDiff,
  GitFileChange,
  GitLog,
  GitOpResult,
  GitStatus,
  InterruptRunWithMessageInput,
  LaunchWorkerAttemptInput,
  PauseRunInput,
  PlanFile,
  PrefKey,
  PreferencesChange,
  PrepareWorkerTaskInput,
  ResumeRunInput,
  RenameFileInput,
  RunArtifactPaths,
  RunState,
  SearchHit,
  SearchOptions,
  SearchSummary,
  ShellInfo,
  SparkEvent,
  StartAutopilotInput,
  StartSearchResponse,
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
// Hits arrive batched (one IPC message per ~100 hits or per ~24ms) — see
// `streamGrep` in the main process. The handler receives the whole batch.
type SearchHitHandler = (hits: SearchHit[]) => void;
type SearchDoneHandler = (summary: SearchSummary) => void;

export interface SearchStartCallbacks {
  onHit: SearchHitHandler;
  onDone: SearchDoneHandler;
}

export interface SearchHandle {
  searchId: string;
  /** Cancels the search and removes the streaming listeners. */
  cancel: () => Promise<void>;
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
  },
  fs: {
    list: (dir: string): Promise<FsEntry[]> => ipcRenderer.invoke("fs:list", dir),
    readText: (path: string): Promise<FsFileContent> => ipcRenderer.invoke("fs:readText", path),
    readEx: (path: string): Promise<FsReadResult> => ipcRenderer.invoke("fs:readEx", path),
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
    push: (cwd: string): Promise<GitOpResult> => ipcRenderer.invoke("git:push", cwd),
    pull: (cwd: string): Promise<GitOpResult> => ipcRenderer.invoke("git:pull", cwd),
    fetch: (cwd: string): Promise<GitOpResult> => ipcRenderer.invoke("git:fetch", cwd),
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
    resumeRun: (input: ResumeRunInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:resumeRun", input),
    addRunMessage: (input: AddRunMessageInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:addRunMessage", input),
    interruptRunWithMessage: (input: InterruptRunWithMessageInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:interruptRunWithMessage", input),
    updateRunStatus: (input: UpdateRunStatusInput): Promise<RunState> =>
      ipcRenderer.invoke("orchestration:updateRunStatus", input),
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
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke("pty:resize", { id, cols, rows }),
    dispose: (id: string): Promise<void> => ipcRenderer.invoke("pty:dispose", { id }),
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
  windowControls: {
    minimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke("window:toggleMaximize"),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:isMaximized"),
    close: (): Promise<void> => ipcRenderer.invoke("window:close"),
    onStateChanged: (handler: WindowStateHandler): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, state: { maximized: boolean }) => handler(state);
      ipcRenderer.on("window:state-changed", listener);
      return () => ipcRenderer.off("window:state-changed", listener);
    },
  },
  app: {
    platform: (): Promise<NodeJS.Platform> => ipcRenderer.invoke("app:platform"),
    home: (): Promise<string> => ipcRenderer.invoke("app:home"),
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
  // Convenience shortcut for the terminal pane's URL chip and the WebLinks
  // addon. Routes through Electron's shell.openExternal in the main process,
  // which is the only handler that survives Chrome's external-navigation
  // block in BrowserWindow.
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke("app:openExternal", url),
};

contextBridge.exposeInMainWorld("spark", api);

export type SparkApi = typeof api;
