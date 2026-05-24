import { ipcMain, dialog, BrowserWindow, app, shell, webContents, clipboard } from "electron";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { listShells, defaultShell } from "./shells";
import { buildIntegratedShellLaunch } from "./shell-init";
import { createFile, createFolder, deleteFile, listDir, listFiles, listMarkdownFiles, readFileEx, readTextFile, renameFile, writeTextFile } from "./fs-tree";
import { assertAllowedReadPath, setAllowedRoots } from "./fs-sandbox";
import { loadSettings, loadState, saveSettings, saveState } from "./storage";
import { detectAgentRuntimes } from "./agent-runtimes";
import { loadPreferences, setPreference } from "./preferences-store";
import * as pty from "./pty-manager";
import * as fsWatcher from "./fs-watcher";
import { streamGrep, type StreamGrepHandle } from "./search/grep";
import { listEvents } from "./orchestration/event-log";
import { setActiveRunId } from "./notifications";
import type {
  InlineAiCompletionRequest,
  InlineAiCompletionResponse,
} from "./inline-ai";

// Heavy modules deferred via dynamic import to keep cold startup snappy. Each
// cache slot is populated on the first IPC call that needs the module and
// reused thereafter, so we pay the resolve+evaluate cost once per process.
let gitOpsMod: typeof import("./git-ops") | undefined;
async function getGitOps(): Promise<typeof import("./git-ops")> {
  gitOpsMod ??= await import("./git-ops");
  return gitOpsMod;
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

let runStoreMod: typeof import("./orchestration/run-store") | undefined;
async function getRunStore(): Promise<typeof import("./orchestration/run-store")> {
  runStoreMod ??= await import("./orchestration/run-store");
  return runStoreMod;
}
import type {
  AddRunMessageInput,
  AppPreferences,
  AppSettings,
  AppState,
  CreateEntryInput,
  CreateStepInput,
  CreateRunInput,
  CreateWorkerTaskInput,
  FileListResult,
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
  InterruptRunWithMessageInput,
  LaunchWorkerAttemptInput,
  MarkRunSeenInput,
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

const MAX_PASTED_IMAGE_BYTES = 12 * 1024 * 1024;
const PASTED_IMAGE_EXTENSIONS = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["image/bmp", ".bmp"],
]);

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
    // Refresh the fs sandbox allowlist whenever workspaces change. The
    // renderer also pushes via ui:setAllowedRoots, but updating here means a
    // newly-added workspace is reachable the instant it's persisted, even
    // before the renderer effect that calls setAllowedRoots fires.
    const roots = state.workspaces
      .map((w) => w.cwd)
      .filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0);
    setAllowedRoots(roots);
  });

  ipcMain.handle("settings:load", async (): Promise<AppSettings> => {
    return loadSettings();
  });

  ipcMain.handle("settings:save", async (_e, settings: AppSettings): Promise<AppSettings> => {
    return saveSettings(settings);
  });

  ipcMain.handle(
    "agents:runtimes",
    async (_e, input?: { force?: boolean }) => {
      return detectAgentRuntimes(Boolean(input?.force));
    },
  );
  ipcMain.handle(
    "agents:sync",
    async (_e, input?: { cwd?: string | null }) => {
      const { syncAgentAssets } = await getAgentSync();
      return syncAgentAssets({ cwd: input?.cwd ?? null });
    },
  );
  ipcMain.handle(
    "agents:assets",
    async (_e, input?: { cwd?: string | null }) => {
      const { listAgentAssets } = await getAgentSync();
      return listAgentAssets({ cwd: input?.cwd ?? null, settings: await loadSettings() });
    },
  );
  ipcMain.handle(
    "agents:deleteAsset",
    async (_e, input: { id: string }) => {
      const { deleteAgentAsset } = await getAgentSync();
      return deleteAgentAsset({ id: input.id });
    },
  );

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
      const { runInlineAiCompletion } = await getInlineAi();
      return runInlineAiCompletion(req);
    },
  );
  ipcMain.handle("inline-ai:abort", async (_e, requestId: string): Promise<void> => {
    const { abortInlineAiCompletion } = await getInlineAi();
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

  ipcMain.handle(
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

  // Read-path sandbox: each handler below rejects paths outside the active
  // workspace roots + a small static allowlist (see fs-sandbox.ts). Write/
  // create/delete handlers further down are intentionally NOT gated — they
  // have a different attack surface and broader internal use; future work can
  // extend the sandbox to those if needed.
  ipcMain.handle("fs:list", async (_e, dir: string) => {
    assertAllowedReadPath(dir);
    return listDir(dir);
  });

  ipcMain.handle("fs:listFiles", async (_e, root: string): Promise<FileListResult> => {
    assertAllowedReadPath(root);
    return listFiles(root);
  });

  ipcMain.handle("fs:readText", async (_e, path: string): Promise<FsFileContent> => {
    assertAllowedReadPath(path);
    return readTextFile(path);
  });

  ipcMain.handle("fs:readEx", async (_e, path: string): Promise<FsReadResult> => {
    assertAllowedReadPath(path);
    return readFileEx(path);
  });

  ipcMain.handle("fs:listMarkdownFiles", async (_e, root: string): Promise<PlanFile[]> => {
    assertAllowedReadPath(root);
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
    // Gate only the root path here; downstream watcher events do not need a
    // per-event check (they all fire inside the gated root).
    if (root !== null) assertAllowedReadPath(root);
    fsWatcher.setWatchRoot(e.sender, root);
  });

  // The renderer is authoritative about which workspaces are open, but the
  // sandbox lives in main. Renderer pushes the cwd list whenever it changes;
  // main treats the list as the source of truth for read-path checks.
  ipcMain.handle("ui:setAllowedRoots", async (_e, roots: unknown): Promise<void> => {
    if (!Array.isArray(roots)) return;
    const cleaned = roots.filter((r): r is string => typeof r === "string" && r.length > 0);
    setAllowedRoots(cleaned);
  });

  ipcMain.handle("fs:revealInOS", async (_e, path: string): Promise<void> => {
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

  ipcMain.handle("git:status", async (_e, cwd: string): Promise<GitStatus> => {
    const { getGitStatus } = await getGitOps();
    return getGitStatus(cwd);
  });

  ipcMain.handle("git:log", async (_e, cwd: string): Promise<GitLog> => {
    const { getGitLog } = await getGitOps();
    return getGitLog(cwd);
  });

  ipcMain.handle(
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

  ipcMain.handle(
    "git:stage",
    async (_e, input: { cwd: string; paths: string[] }): Promise<GitOpResult> => {
      const { stageFiles } = await getGitOps();
      return stageFiles(input.cwd, input.paths);
    },
  );

  ipcMain.handle(
    "git:unstage",
    async (_e, input: { cwd: string; paths: string[] }): Promise<GitOpResult> => {
      const { unstageFiles } = await getGitOps();
      return unstageFiles(input.cwd, input.paths);
    },
  );

  ipcMain.handle("git:stageAll", async (_e, cwd: string): Promise<GitOpResult> => {
    const { stageAll } = await getGitOps();
    return stageAll(cwd);
  });

  ipcMain.handle("git:unstageAll", async (_e, cwd: string): Promise<GitOpResult> => {
    const { unstageAll } = await getGitOps();
    return unstageAll(cwd);
  });

  ipcMain.handle(
    "git:discard",
    async (_e, input: { cwd: string; files: GitFileChange[] }): Promise<GitOpResult> => {
      const { discardChanges } = await getGitOps();
      return discardChanges(input.cwd, input.files);
    },
  );

  ipcMain.handle(
    "git:commit",
    async (_e, input: { cwd: string; message: string }): Promise<GitOpResult> => {
      const { commitChanges } = await getGitOps();
      return commitChanges(input.cwd, input.message);
    },
  );

  ipcMain.handle("git:generateCommitMessage", async (_e, cwd: string): Promise<GitCommitMessageResult> => {
    const { generateCommitMessage } = await getGitOps();
    return generateCommitMessage(cwd);
  });

  ipcMain.handle("git:push", async (_e, cwd: string): Promise<GitOpResult> => {
    const { push } = await getGitOps();
    return push(cwd);
  });

  ipcMain.handle("git:pull", async (_e, cwd: string): Promise<GitOpResult> => {
    const { pull } = await getGitOps();
    return pull(cwd);
  });

  ipcMain.handle("git:fetch", async (_e, cwd: string): Promise<GitOpResult> => {
    const { fetchRemote } = await getGitOps();
    return fetchRemote(cwd);
  });

  ipcMain.handle("git:prepareSmartMerge", async (_e, cwd: string): Promise<GitSmartMergeResult> => {
    const { prepareSmartMerge } = await getGitOps();
    return prepareSmartMerge(cwd);
  });

  ipcMain.handle("git:undoLastCommit", async (_e, cwd: string): Promise<GitOpResult> => {
    const { undoLastCommit } = await getGitOps();
    return undoLastCommit(cwd);
  });

  ipcMain.handle(
    "git:checkout",
    async (_e, input: { cwd: string; ref: string }): Promise<GitOpResult> => {
      const { checkoutRef } = await getGitOps();
      return checkoutRef(input.cwd, input.ref);
    },
  );

  ipcMain.handle(
    "git:revert",
    async (_e, input: { cwd: string; hash: string }): Promise<GitOpResult> => {
      const { revertCommit } = await getGitOps();
      return revertCommit(input.cwd, input.hash);
    },
  );

  ipcMain.handle("git:init", async (_e, cwd: string): Promise<GitOpResult> => {
    const { initRepo } = await getGitOps();
    return initRepo(cwd);
  });

  ipcMain.handle("orchestration:createRun", async (_e, input: CreateRunInput): Promise<RunState> => {
    const { createRun } = await getRunStore();
    return createRun(input);
  });

  ipcMain.handle("orchestration:getRun", async (_e, runId: string): Promise<RunState | null> => {
    const { getRun } = await getRunStore();
    return getRun(runId);
  });

  ipcMain.handle("orchestration:listRuns", async (_e, workspaceId?: string): Promise<RunState[]> => {
    const { listRuns } = await getRunStore();
    return listRuns(workspaceId);
  });

  ipcMain.handle("orchestration:listEvents", async (_e, runId: string): Promise<SparkEvent[]> => {
    return listEvents(runId);
  });

  ipcMain.handle("orchestration:getArtifactPaths", async (_e, runId: string): Promise<RunArtifactPaths> => {
    const { getRunArtifactPaths } = await getRunStore();
    return getRunArtifactPaths(runId);
  });

  ipcMain.handle("orchestration:appendTestEvent", async (_e, args: { runId: string; message?: string }): Promise<SparkEvent> => {
    const { appendTestEvent } = await getRunStore();
    return appendTestEvent(args.runId, args.message);
  });

  ipcMain.handle("orchestration:startAutopilot", async (_e, input: StartAutopilotInput): Promise<RunState> => {
    const { startAutopilot } = await getRunStore();
    return startAutopilot(input);
  });

  ipcMain.handle("orchestration:pauseRun", async (_e, input: PauseRunInput): Promise<RunState> => {
    const { pauseRun } = await getRunStore();
    return pauseRun(input);
  });

  ipcMain.handle("orchestration:pauseRunAfterCurrentWorkers", async (_e, input: PauseRunInput): Promise<RunState> => {
    const { pauseRunAfterCurrentWorkers } = await getRunStore();
    return pauseRunAfterCurrentWorkers(input);
  });

  ipcMain.handle("orchestration:forcePauseRun", async (_e, runId: string): Promise<RunState> => {
    const { forcePauseRun } = await getRunStore();
    return forcePauseRun(runId);
  });

  ipcMain.handle("orchestration:resumeRun", async (_e, input: ResumeRunInput): Promise<RunState> => {
    const { resumeRun } = await getRunStore();
    return resumeRun(input);
  });

  ipcMain.handle("orchestration:addRunMessage", async (_e, input: AddRunMessageInput): Promise<RunState> => {
    const { addRunMessage } = await getRunStore();
    return addRunMessage(input);
  });

  ipcMain.handle(
    "orchestration:interruptRunWithMessage",
    async (_e, input: InterruptRunWithMessageInput): Promise<RunState> => {
      const { interruptRunWithMessage } = await getRunStore();
      return interruptRunWithMessage(input);
    },
  );

  ipcMain.handle("orchestration:updateRunStatus", async (_e, input: UpdateRunStatusInput): Promise<RunState> => {
    const { updateRunStatus } = await getRunStore();
    return updateRunStatus(input);
  });

  ipcMain.handle("orchestration:markRunSeen", async (_e, input: MarkRunSeenInput): Promise<RunState> => {
    const { markRunSeen } = await getRunStore();
    return markRunSeen(input);
  });

  ipcMain.handle("orchestration:createStep", async (_e, input: CreateStepInput): Promise<RunState> => {
    const { createStep } = await getRunStore();
    return createStep(input);
  });

  ipcMain.handle("orchestration:updateStep", async (_e, input: UpdateStepInput): Promise<RunState> => {
    const { updateStep } = await getRunStore();
    return updateStep(input);
  });

  ipcMain.handle("orchestration:createWorkerTask", async (_e, input: CreateWorkerTaskInput): Promise<RunState> => {
    const { createWorkerTask } = await getRunStore();
    return createWorkerTask(input);
  });

  ipcMain.handle("orchestration:updateWorkerTask", async (_e, input: UpdateWorkerTaskInput): Promise<RunState> => {
    const { updateWorkerTask } = await getRunStore();
    return updateWorkerTask(input);
  });

  ipcMain.handle("orchestration:prepareWorkerTask", async (_e, input: PrepareWorkerTaskInput) => {
    const { prepareWorkerTask } = await getRunStore();
    return prepareWorkerTask(input);
  });

  ipcMain.handle("orchestration:launchWorkerAttempt", async (_e, input: LaunchWorkerAttemptInput): Promise<RunState> => {
    const { launchWorkerAttempt } = await getRunStore();
    return launchWorkerAttempt(input);
  });

  ipcMain.handle("orchestration:readWorkerReport", async (_e, path: string) => {
    const { readWorkerReport } = await getRunStore();
    return readWorkerReport(path);
  });

  ipcMain.handle("orchestration:deleteRun", async (_e, runId: string): Promise<void> => {
    const { deleteRun } = await getRunStore();
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

  ipcMain.handle(
    "pty:inject",
    async (_e, args: { id: string; text: string; submit?: boolean }) => {
      pty.inject(args.id, args.text, { submit: args.submit ?? true });
    },
  );

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

  ipcMain.handle(
    "window:setTitleBarTheme",
    async (e, theme: { color?: unknown; symbolColor?: unknown }): Promise<void> => {
      if (process.platform !== "win32") return;
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!win) return;
      const color = typeof theme?.color === "string" && theme.color ? theme.color : "#171513";
      const symbolColor =
        typeof theme?.symbolColor === "string" && theme.symbolColor
          ? theme.symbolColor
          : "#bdbcb8";
      try {
        win.setBackgroundColor(color);
        win.setTitleBarOverlay({ color, symbolColor, height: 30 });
      } catch {
        /* Unsupported color strings or platform quirks should not break theme switches. */
      }
    },
  );

  // Renderer reports which run is currently selected so main can suppress
  // "run complete" notifications for the run the user is already looking at.
  // Passing null clears the selection (e.g. when the user opens the "new
  // chat" draft composer).
  ipcMain.handle("ui:setActiveRun", async (_e, runId: string | null): Promise<void> => {
    setActiveRunId(typeof runId === "string" ? runId : null);
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

  // Clipboard bridge for terminal Ctrl+Shift+C / Ctrl+Shift+V. The xterm.js
  // canvas can't reach navigator.clipboard reliably inside Electron when the
  // renderer hasn't been granted clipboard-read permission, so route through
  // main where Electron's `clipboard` API works unconditionally.
  ipcMain.handle("clipboard:readText", async (): Promise<string> => {
    try {
      return clipboard.readText();
    } catch {
      return "";
    }
  });
  ipcMain.handle("clipboard:writeText", async (_e, text: string): Promise<void> => {
    if (typeof text !== "string" || text.length === 0) return;
    try {
      clipboard.writeText(text);
    } catch {
      /* best-effort */
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

  // Auto-updater: renderer's "Restart and install" button calls this after
  // the download-complete event arrives. Lazy-imported so loading ipc.ts
  // never pulls in electron-updater on the dev/test path.
  ipcMain.handle("updater:quitAndInstall", async (): Promise<void> => {
    const { quitAndInstall } = await import("./auto-updater");
    quitAndInstall();
  });
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
