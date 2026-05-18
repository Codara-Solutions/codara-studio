import { ipcMain, dialog, BrowserWindow, app, shell, webContents } from "electron";
import { listShells, defaultShell } from "./shells";
import { buildIntegratedShellLaunch } from "./shell-init";
import { createFile, createFolder, deleteFile, listDir, listMarkdownFiles, readFileEx, readTextFile, renameFile, writeTextFile } from "./fs-tree";
import {
  checkoutRef,
  commitChanges,
  discardChanges,
  fetchRemote,
  generateCommitMessage,
  getGitDiff,
  getGitLog,
  getGitStatus,
  initRepo,
  pull,
  push,
  revertCommit,
  stageAll,
  stageFiles,
  undoLastCommit,
  unstageAll,
  unstageFiles,
} from "./git-ops";
import { loadSettings, loadState, saveSettings, saveState } from "./storage";
import { loadPreferences, setPreference } from "./preferences-store";
import {
  abortInlineAiCompletion,
  runInlineAiCompletion,
  type InlineAiCompletionRequest,
  type InlineAiCompletionResponse,
} from "./inline-ai";
import * as pty from "./pty-manager";
import * as fsWatcher from "./fs-watcher";
import { streamGrep, type StreamGrepHandle } from "./search/grep";
import {
  addRunMessage,
  appendTestEvent,
  createStep,
  createRun,
  createWorkerTask,
  deleteRun,
  forcePauseRun,
  getRunArtifactPaths,
  getRun,
  interruptRunWithMessage,
  launchWorkerAttempt,
  listRuns,
  pauseRunAfterCurrentWorkers,
  pauseRun,
  prepareWorkerTask,
  readWorkerReport,
  resumeRun,
  startAutopilot,
  updateRunStatus,
  updateStep,
  updateWorkerTask,
} from "./orchestration/run-store";
import { listEvents } from "./orchestration/event-log";
import type {
  AddRunMessageInput,
  AppPreferences,
  AppSettings,
  AppState,
  CreateEntryInput,
  CreateStepInput,
  CreateRunInput,
  CreateWorkerTaskInput,
  FsEntry,
  FsFileContent,
  FsReadResult,
  GitCommitMessageResult,
  GitDiff,
  GitFileChange,
  GitLog,
  GitOpResult,
  GitStatus,
  InterruptRunWithMessageInput,
  LaunchWorkerAttemptInput,
  PauseRunInput,
  PrefKey,
  PreferencesChange,
  PrepareWorkerTaskInput,
  ResumeRunInput,
  RenameFileInput,
  PlanFile,
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
} from "@shared/types";

// Fan a preferences change out to every live webContents so the main window
// and the settings window stay in sync regardless of which one wrote.
function broadcastPreferencesChanged<K extends PrefKey>(
  change: PreferencesChange<K>,
): void {
  const payload: PreferencesChange = change;
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    wc.send("preferences:changed", payload);
  }
}

export function registerIpc(): void {
  ipcMain.handle("state:load", async (): Promise<AppState> => {
    return loadState();
  });

  ipcMain.handle("state:save", async (_e, state: AppState): Promise<void> => {
    await saveState(state);
  });

  ipcMain.handle("settings:load", async (): Promise<AppSettings> => {
    return loadSettings();
  });

  ipcMain.handle("settings:save", async (_e, settings: AppSettings): Promise<AppSettings> => {
    return saveSettings(settings);
  });

  ipcMain.handle("preferences:load", async (): Promise<AppPreferences> => {
    return loadPreferences();
  });

  ipcMain.handle(
    "preferences:set",
    async <K extends PrefKey>(
      _e: Electron.IpcMainInvokeEvent,
      args: { key: K; value: AppPreferences[K] },
    ): Promise<AppPreferences> => {
      const next = await setPreference(args.key, args.value);
      broadcastPreferencesChanged({ key: args.key, value: next[args.key] });
      return next;
    },
  );

  // Inline-AI editor autocomplete proxy. Renderer-side fetch to OpenRouter
  // hits CORS in dev; routing through main bypasses that.
  ipcMain.handle(
    "inline-ai:complete",
    async (_e, req: InlineAiCompletionRequest): Promise<InlineAiCompletionResponse> => {
      return runInlineAiCompletion(req);
    },
  );
  ipcMain.handle("inline-ai:abort", async (_e, requestId: string): Promise<void> => {
    abortInlineAiCompletion(requestId);
  });

  ipcMain.handle("shells:list", async (): Promise<ShellInfo[]> => {
    return listShells();
  });

  ipcMain.handle("shells:default", async (): Promise<ShellInfo | null> => {
    return defaultShell();
  });

  ipcMain.handle("shells:integratedDefault", async (): Promise<ShellInfo> => {
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

  ipcMain.handle("dialog:openDirectory", async (e, defaultPath?: string): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(win!, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: defaultPath || app.getPath("home"),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("dialog:openImages", async (e, defaultPath?: string): Promise<string[]> => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(win!, {
      properties: ["openFile", "multiSelections"],
      defaultPath: defaultPath || app.getPath("pictures") || app.getPath("home"),
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
        },
      ],
    });
    if (result.canceled) return [];
    return result.filePaths;
  });

  ipcMain.handle("fs:list", async (_e, dir: string) => {
    return listDir(dir);
  });

  ipcMain.handle("fs:readText", async (_e, path: string): Promise<FsFileContent> => {
    return readTextFile(path);
  });

  ipcMain.handle("fs:readEx", async (_e, path: string): Promise<FsReadResult> => {
    return readFileEx(path);
  });

  ipcMain.handle("fs:listMarkdownFiles", async (_e, root: string): Promise<PlanFile[]> => {
    return listMarkdownFiles(root);
  });

  ipcMain.handle("fs:writeText", async (_e, args: { path: string; content: string }): Promise<FsFileContent> => {
    return writeTextFile(args.path, args.content);
  });

  ipcMain.handle("fs:renameFile", async (_e, args: RenameFileInput): Promise<FsEntry> => {
    return renameFile(args.path, args.newName);
  });

  ipcMain.handle("fs:deleteFile", async (_e, path: string): Promise<void> => {
    await deleteFile(path);
  });

  ipcMain.handle("fs:createFile", async (_e, args: CreateEntryInput): Promise<FsEntry> => {
    return createFile(args.parentPath, args.name);
  });

  ipcMain.handle("fs:createFolder", async (_e, args: CreateEntryInput): Promise<FsEntry> => {
    return createFolder(args.parentPath, args.name);
  });

  ipcMain.handle("fs:setWatchRoot", async (e, root: string | null): Promise<void> => {
    fsWatcher.setWatchRoot(e.sender, root);
  });

  ipcMain.handle("fs:revealInOS", async (_e, path: string): Promise<void> => {
    shell.showItemInFolder(path);
  });

  ipcMain.handle("git:status", async (_e, cwd: string): Promise<GitStatus> => {
    return getGitStatus(cwd);
  });

  ipcMain.handle("git:log", async (_e, cwd: string): Promise<GitLog> => {
    return getGitLog(cwd);
  });

  ipcMain.handle(
    "git:diff",
    async (
      _e,
      input: { cwd: string; path: string; staged: boolean; untracked: boolean },
    ): Promise<GitDiff> => {
      return getGitDiff(input.cwd, input.path, {
        staged: input.staged,
        untracked: input.untracked,
      });
    },
  );

  ipcMain.handle(
    "git:stage",
    async (_e, input: { cwd: string; paths: string[] }): Promise<GitOpResult> => {
      return stageFiles(input.cwd, input.paths);
    },
  );

  ipcMain.handle(
    "git:unstage",
    async (_e, input: { cwd: string; paths: string[] }): Promise<GitOpResult> => {
      return unstageFiles(input.cwd, input.paths);
    },
  );

  ipcMain.handle("git:stageAll", async (_e, cwd: string): Promise<GitOpResult> => {
    return stageAll(cwd);
  });

  ipcMain.handle("git:unstageAll", async (_e, cwd: string): Promise<GitOpResult> => {
    return unstageAll(cwd);
  });

  ipcMain.handle(
    "git:discard",
    async (_e, input: { cwd: string; files: GitFileChange[] }): Promise<GitOpResult> => {
      return discardChanges(input.cwd, input.files);
    },
  );

  ipcMain.handle(
    "git:commit",
    async (_e, input: { cwd: string; message: string }): Promise<GitOpResult> => {
      return commitChanges(input.cwd, input.message);
    },
  );

  ipcMain.handle("git:generateCommitMessage", async (_e, cwd: string): Promise<GitCommitMessageResult> => {
    return generateCommitMessage(cwd);
  });

  ipcMain.handle("git:push", async (_e, cwd: string): Promise<GitOpResult> => {
    return push(cwd);
  });

  ipcMain.handle("git:pull", async (_e, cwd: string): Promise<GitOpResult> => {
    return pull(cwd);
  });

  ipcMain.handle("git:fetch", async (_e, cwd: string): Promise<GitOpResult> => {
    return fetchRemote(cwd);
  });

  ipcMain.handle("git:undoLastCommit", async (_e, cwd: string): Promise<GitOpResult> => {
    return undoLastCommit(cwd);
  });

  ipcMain.handle(
    "git:checkout",
    async (_e, input: { cwd: string; ref: string }): Promise<GitOpResult> => {
      return checkoutRef(input.cwd, input.ref);
    },
  );

  ipcMain.handle(
    "git:revert",
    async (_e, input: { cwd: string; hash: string }): Promise<GitOpResult> => {
      return revertCommit(input.cwd, input.hash);
    },
  );

  ipcMain.handle("git:init", async (_e, cwd: string): Promise<GitOpResult> => {
    return initRepo(cwd);
  });

  ipcMain.handle("orchestration:createRun", async (_e, input: CreateRunInput): Promise<RunState> => {
    return createRun(input);
  });

  ipcMain.handle("orchestration:getRun", async (_e, runId: string): Promise<RunState | null> => {
    return getRun(runId);
  });

  ipcMain.handle("orchestration:listRuns", async (_e, workspaceId?: string): Promise<RunState[]> => {
    return listRuns(workspaceId);
  });

  ipcMain.handle("orchestration:listEvents", async (_e, runId: string): Promise<SparkEvent[]> => {
    return listEvents(runId);
  });

  ipcMain.handle("orchestration:getArtifactPaths", async (_e, runId: string): Promise<RunArtifactPaths> => {
    return getRunArtifactPaths(runId);
  });

  ipcMain.handle("orchestration:appendTestEvent", async (_e, args: { runId: string; message?: string }): Promise<SparkEvent> => {
    return appendTestEvent(args.runId, args.message);
  });

  ipcMain.handle("orchestration:startAutopilot", async (_e, input: StartAutopilotInput): Promise<RunState> => {
    return startAutopilot(input);
  });

  ipcMain.handle("orchestration:pauseRun", async (_e, input: PauseRunInput): Promise<RunState> => {
    return pauseRun(input);
  });

  ipcMain.handle("orchestration:pauseRunAfterCurrentWorkers", async (_e, input: PauseRunInput): Promise<RunState> => {
    return pauseRunAfterCurrentWorkers(input);
  });

  ipcMain.handle("orchestration:forcePauseRun", async (_e, runId: string): Promise<RunState> => {
    return forcePauseRun(runId);
  });

  ipcMain.handle("orchestration:resumeRun", async (_e, input: ResumeRunInput): Promise<RunState> => {
    return resumeRun(input);
  });

  ipcMain.handle("orchestration:addRunMessage", async (_e, input: AddRunMessageInput): Promise<RunState> => {
    return addRunMessage(input);
  });

  ipcMain.handle(
    "orchestration:interruptRunWithMessage",
    async (_e, input: InterruptRunWithMessageInput): Promise<RunState> => {
      return interruptRunWithMessage(input);
    },
  );

  ipcMain.handle("orchestration:updateRunStatus", async (_e, input: UpdateRunStatusInput): Promise<RunState> => {
    return updateRunStatus(input);
  });

  ipcMain.handle("orchestration:createStep", async (_e, input: CreateStepInput): Promise<RunState> => {
    return createStep(input);
  });

  ipcMain.handle("orchestration:updateStep", async (_e, input: UpdateStepInput): Promise<RunState> => {
    return updateStep(input);
  });

  ipcMain.handle("orchestration:createWorkerTask", async (_e, input: CreateWorkerTaskInput): Promise<RunState> => {
    return createWorkerTask(input);
  });

  ipcMain.handle("orchestration:updateWorkerTask", async (_e, input: UpdateWorkerTaskInput): Promise<RunState> => {
    return updateWorkerTask(input);
  });

  ipcMain.handle("orchestration:prepareWorkerTask", async (_e, input: PrepareWorkerTaskInput) => {
    return prepareWorkerTask(input);
  });

  ipcMain.handle("orchestration:launchWorkerAttempt", async (_e, input: LaunchWorkerAttemptInput): Promise<RunState> => {
    return launchWorkerAttempt(input);
  });

  ipcMain.handle("orchestration:readWorkerReport", async (_e, path: string) => {
    return readWorkerReport(path);
  });

  ipcMain.handle("orchestration:deleteRun", async (_e, runId: string): Promise<void> => {
    await deleteRun(runId);
  });

  ipcMain.handle(
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
      },
    ) => {
      return pty.spawn({
        id: args.id,
        shell: args.shell,
        cwd: args.cwd,
        cols: args.cols,
        rows: args.rows,
        env: args.env,
        startupCommand: args.startupCommand,
        webContents: e.sender,
      });
    },
  );

  ipcMain.handle("pty:write", async (_e, args: { id: string; data: string }) => {
    pty.write(args.id, args.data);
  });

  ipcMain.handle("pty:resize", async (_e, args: { id: string; cols: number; rows: number }) => {
    pty.resize(args.id, args.cols, args.rows);
  });

  ipcMain.handle("pty:dispose", async (_e, args: { id: string }) => {
    pty.dispose(args.id);
  });

  ipcMain.handle("window:minimize", async (e): Promise<void> => {
    BrowserWindow.fromWebContents(e.sender)?.minimize();
  });

  ipcMain.handle("window:toggleMaximize", async (e): Promise<boolean> => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return win.isMaximized();
  });

  ipcMain.handle("window:isMaximized", async (e): Promise<boolean> => {
    return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false;
  });

  ipcMain.handle("window:close", async (e): Promise<void> => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });

  ipcMain.handle("app:platform", async (): Promise<NodeJS.Platform> => process.platform);
  ipcMain.handle("app:home", async (): Promise<string> => app.getPath("home"));

  // Project-wide search. The renderer kicks off a search and gets back an
  // ID; the main process then streams `search:hit:<id>` and ends with
  // `search:done:<id>`. Cancellation goes through `search:cancel`.
  const activeSearches = new Map<string, StreamGrepHandle>();
  let searchCounter = 0;

  ipcMain.handle(
    "search:start",
    async (e, opts: SearchOptions): Promise<StartSearchResponse> => {
      const sender = e.sender;
      const searchId = `search-${Date.now().toString(36)}-${(searchCounter++).toString(36)}`;
      const hitChannel = `search:hit:${searchId}`;
      const doneChannel = `search:done:${searchId}`;
      const handle = streamGrep(
        opts,
        // streamGrep batches hits, so each message carries an array — keeps
        // a 2000-hit search to a handful of IPC sends.
        (hits: SearchHit[]) => {
          if (sender.isDestroyed()) return;
          sender.send(hitChannel, hits);
        },
        (summary: SearchSummary) => {
          activeSearches.delete(searchId);
          if (sender.isDestroyed()) return;
          sender.send(doneChannel, summary);
        },
      );
      activeSearches.set(searchId, handle);
      return { searchId };
    },
  );

  ipcMain.handle("search:cancel", async (_e, searchId: string): Promise<void> => {
    const handle = activeSearches.get(searchId);
    if (handle) {
      handle.cancel();
      activeSearches.delete(searchId);
    }
  });

  ipcMain.handle("app:openExternal", async (_e, url: string): Promise<void> => {
    if (typeof url !== "string" || url.length === 0) return;
    // Electron's shell.openExternal accepts http(s) and a few extra schemes by
    // default; reject anything else so a malicious URL detected on the PTY
    // stream cannot launch arbitrary handlers.
    const safe = /^(https?:|file:|mailto:)/i.test(url);
    if (!safe) return;
    try {
      await shell.openExternal(url);
    } catch {
      /* shell.openExternal rejects when no handler is registered; ignore. */
    }
  });
}
