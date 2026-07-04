import { ipcMain, dialog, BrowserWindow, app, shell, webContents, clipboard, nativeImage, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { listShells, defaultShell } from "./shells";
import { buildIntegratedShellLaunch } from "./shell-init";
import { createFile, createFolder, deleteFile, importEntries, listDir, listFiles, listMarkdownFiles, readFileEx, readTextFile, renameFile, writeTextFile } from "./fs-tree";
import { assertAllowedReadPath, setAllowedRoots } from "./fs-sandbox";
import { loadSettings, loadState, saveSettings, saveState } from "./storage";
import { sparkHome } from "./spark-home";
import { detectAgentRuntimes } from "./agent-runtimes";
import { loadPreferences, setPreference } from "./preferences-store";
import * as pty from "./pty-manager";
import * as fsWatcher from "./fs-watcher";
import { streamGrep, type StreamGrepHandle } from "./search/grep";
import { listEvents } from "./orchestration/event-log";
import {
  clearCenter,
  listCenterEntries,
  markCenterAllRead,
  markCenterRead,
  removeCenterEntry,
  setAttention,
} from "./notify";
import {
  syncTerminalNotifyPanes,
  type TerminalNotifyPaneEntry,
} from "./terminal-agent-notify";
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

async function getGitWorktrees(): Promise<typeof import("./git-worktrees")> {
  return import("./git-worktrees");
}

let agentSyncMod: typeof import("./agent-sync") | undefined;
async function getAgentSync(): Promise<typeof import("./agent-sync")> {
  agentSyncMod ??= await import("./agent-sync");
  return agentSyncMod;
}

let mcpInstallerMod: typeof import("./mcp-installer") | undefined;
async function getMcpInstaller(): Promise<typeof import("./mcp-installer")> {
  mcpInstallerMod ??= await import("./mcp-installer");
  return mcpInstallerMod;
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

let runQueueMod: typeof import("./orchestration/run-queue") | undefined;
async function getRunQueue(): Promise<typeof import("./orchestration/run-queue")> {
  runQueueMod ??= await import("./orchestration/run-queue");
  return runQueueMod;
}

let schedulerMod: typeof import("./orchestration/scheduler") | undefined;
async function getScheduler(): Promise<typeof import("./orchestration/scheduler")> {
  schedulerMod ??= await import("./orchestration/scheduler");
  return schedulerMod;
}
import type {
  AddRunMessageInput,
  AppPreferences,
  AppSettings,
  AppState,
  CreateEntryInput,
  AutomationDetail,
  AutomationWorkerInfo,
  CreateScheduledJobInput,
  CreateStepInput,
  CreateRunInput,
  CreateWorkerTaskInput,
  EnqueueRunInput,
  FileListResult,
  FsEntry,
  FsFileContent,
  FsReadResult,
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
  UpdateChatBackendInput,
  PauseRunInput,
  PrefKey,
  PreferencesChange,
  PrepareWorkerTaskInput,
  NotificationCenterEntry,
  QueuedRun,
  RenameRunInput,
  ResumeRunInput,
  RenameFileInput,
  PlanFile,
  RunArtifactPaths,
  RunQueueState,
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
  UpdateStepInput,
  UpdateWorkerTaskInput,
} from "@shared/types";

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
  ipcMain.handle(
    "agents:installAsset",
    async (_e, input: { id: string; target: "claude" | "codex" }) => {
      const { installAgentAssetToRuntime } = await getAgentSync();
      return installAgentAssetToRuntime({ id: input.id, target: input.target });
    },
  );
  ipcMain.handle("agents:builtins", async () => {
    const [{ getSparkBuiltinStatus }, runtimes, settings] = await Promise.all([
      getMcpInstaller(),
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
  ipcMain.handle(
    "agents:installBuiltin",
    async (_e, input: { id: SparkBuiltinMcpId; runtime: SparkBuiltinRuntime }) => {
      const { installSparkBuiltin } = await getMcpInstaller();
      return installSparkBuiltin(input.id, input.runtime);
    },
  );
  ipcMain.handle(
    "agents:uninstallBuiltin",
    async (_e, input: { id: SparkBuiltinMcpId; runtime: SparkBuiltinRuntime }) => {
      const { uninstallSparkBuiltin } = await getMcpInstaller();
      return uninstallSparkBuiltin(input.id, input.runtime);
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

  // Save a draw-mode screenshot (page capture + freehand annotation, both
  // already composited in the renderer) under <tmp>/spark-drawings as a PNG.
  // Returning the path — not the base64 bytes — keeps the chat message small
  // and lets Claude Code use its native image-read tool on the file. Inputs
  // are validated as a `data:image/png;base64,...` URL; everything else is
  // rejected so a compromised webview can't drop arbitrary bytes on disk.
  ipcMain.handle(
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

  // Existence probe for the terminal link provider's ctrl/cmd-click feature.
  // Resolves `target` against an optional `baseDir` (the terminal pane's
  // tracked cwd), then checks via fs.stat. Sandboxed against the same
  // allow-list as the other read primitives so a hostile pty can't make the
  // renderer probe arbitrary disk locations.
  ipcMain.handle(
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
      const resolved = base ? join(base, target) : target;
      try {
        assertAllowedReadPath(resolved);
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

  // Import external files/folders dropped onto the Explorer. The DESTINATION
  // is gated by the read sandbox so a hostile renderer can't make Codara write
  // a copy outside the open workspaces; the sources can live anywhere on disk
  // (that's the whole point of importing them in).
  ipcMain.handle(
    "fs:importEntries",
    async (_e, args: { destDir: string; sourcePaths: string[] }): Promise<FsEntry[]> => {
      const destDir = typeof args?.destDir === "string" ? args.destDir : "";
      if (!destDir) throw new Error("Missing import destination.");
      assertAllowedReadPath(destDir);
      const sourcePaths = Array.isArray(args?.sourcePaths)
        ? args.sourcePaths.filter((p): p is string => typeof p === "string" && p.length > 0)
        : [];
      if (sourcePaths.length === 0) return [];
      return importEntries(destDir, sourcePaths);
    },
  );

  // Native OS drag-out: the renderer's `dragstart` on an Explorer row sends the
  // selected file paths here, and we hand them to Chromium's drag machinery so
  // the user can drop them onto the desktop, another app, etc. Fire-and-forget
  // (`ipcMain.on`) because `webContents.startDrag` returns nothing and must run
  // on the sender's own contents while the drag gesture is live.
  ipcMain.on("fs:startDrag", (e, paths: unknown) => {
    const files = Array.isArray(paths)
      ? paths.filter((p): p is string => typeof p === "string" && p.length > 0)
      : typeof paths === "string" && paths.length > 0
        ? [paths]
        : [];
    if (files.length === 0) return;
    try {
      e.sender.startDrag({
        // `file` is the legacy single-path field some platforms still read;
        // `files` carries the full (possibly multi-) selection.
        file: files[0],
        files,
        icon: getDragIcon(),
      });
    } catch (err) {
      console.warn("[main] fs:startDrag failed:", err);
    }
  });

  ipcMain.handle("fs:setWatchRoot", async (e, root: string | null): Promise<void> => {
    // Gate only the root path here; downstream watcher events do not need a
    // per-event check (they all fire inside the gated root).
    if (root !== null) assertAllowedReadPath(root);
    await fsWatcher.setWatchRoot(e.sender, root);
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
    async (
      _e,
      input: { cwd: string; message: string; amend?: boolean },
    ): Promise<GitOpResult> => {
      const { commitChanges } = await getGitOps();
      return commitChanges(input.cwd, input.message, { amend: input.amend });
    },
  );

  ipcMain.handle("git:generateCommitMessage", async (_e, cwd: string): Promise<GitCommitMessageResult> => {
    const { generateCommitMessage } = await getGitCommitMessage();
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

  // ── Branches ──────────────────────────────────────────────────────────────
  ipcMain.handle("git:branches", async (_e, cwd: string): Promise<GitBranchList> => {
    const { listBranches } = await getGitBranches();
    return listBranches(cwd);
  });

  ipcMain.handle(
    "git:checkoutBranch",
    async (_e, input: { cwd: string; name: string }): Promise<GitOpResult> => {
      const { checkoutBranch } = await getGitBranches();
      return checkoutBranch(input.cwd, input.name);
    },
  );

  ipcMain.handle(
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

  ipcMain.handle(
    "git:renameBranch",
    async (_e, input: { cwd: string; oldName: string; newName: string }): Promise<GitOpResult> => {
      const { renameBranch } = await getGitBranches();
      return renameBranch(input.cwd, input.oldName, input.newName);
    },
  );

  ipcMain.handle(
    "git:deleteBranch",
    async (_e, input: { cwd: string; name: string; force?: boolean }): Promise<GitOpResult> => {
      const { deleteBranch } = await getGitBranches();
      return deleteBranch(input.cwd, input.name, { force: input.force });
    },
  );

  ipcMain.handle(
    "git:mergeBranch",
    async (_e, input: { cwd: string; name: string }): Promise<GitOpResult> => {
      const { mergeBranch } = await getGitBranches();
      return mergeBranch(input.cwd, input.name);
    },
  );

  // ── Copy-branch worktrees ───────────────────────────────────────────────────
  ipcMain.handle(
    "git:createCopyWorktree",
    async (
      _e,
      input: { repoCwd: string; baseBranch?: string; city?: string },
    ): Promise<GitCopyWorktreeResult> => {
      const { createCopyWorktree } = await getGitWorktrees();
      const worktreesRoot = join(sparkHome(), "worktrees", basename(input.repoCwd));
      const result = await createCopyWorktree({
        repoCwd: input.repoCwd,
        worktreesRoot,
        baseBranch: input.baseBranch,
        city: input.city,
      });
      if (result.ok) {
        // The new branch is a shared ref — refresh the source repo's panel.
        const { invalidateGitCache } = await getGitOps();
        invalidateGitCache(input.repoCwd);
      }
      return result;
    },
  );

  ipcMain.handle(
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
  ipcMain.handle("git:stashes", async (_e, cwd: string): Promise<GitStashList> => {
    const { listStashes } = await getGitStash();
    return listStashes(cwd);
  });

  ipcMain.handle(
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

  ipcMain.handle(
    "git:stashApply",
    async (_e, input: { cwd: string; ref: string }): Promise<GitOpResult> => {
      const { applyStash } = await getGitStash();
      return applyStash(input.cwd, input.ref);
    },
  );

  ipcMain.handle(
    "git:stashPop",
    async (_e, input: { cwd: string; ref: string }): Promise<GitOpResult> => {
      const { popStash } = await getGitStash();
      return popStash(input.cwd, input.ref);
    },
  );

  ipcMain.handle(
    "git:stashDrop",
    async (_e, input: { cwd: string; ref: string }): Promise<GitOpResult> => {
      const { dropStash } = await getGitStash();
      return dropStash(input.cwd, input.ref);
    },
  );

  // ── Commit inspection ────────────────────────────────────────────────────────
  ipcMain.handle(
    "git:commitDetail",
    async (_e, input: { cwd: string; hash: string }): Promise<GitCommitDetailResult> => {
      const { getCommitDetail } = await getGitInspect();
      return getCommitDetail(input.cwd, input.hash);
    },
  );

  ipcMain.handle(
    "git:commitFileDiff",
    async (_e, input: { cwd: string; hash: string; path: string }): Promise<GitDiff> => {
      const { getCommitFileDiff } = await getGitInspect();
      return getCommitFileDiff(input.cwd, input.hash, input.path);
    },
  );

  // ── Partial staging + conflict resolution ─────────────────────────────────────
  ipcMain.handle(
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

  ipcMain.handle(
    "git:resolveConflict",
    async (
      _e,
      input: { cwd: string; path: string; side: GitConflictSide },
    ): Promise<GitOpResult> => {
      const { resolveConflict } = await getGitApply();
      return resolveConflict(input.cwd, input.path, input.side);
    },
  );

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

  ipcMain.handle(
    "orchestration:stopAndUndoPending",
    async (_e, runId: string): Promise<UndoToCheckpointResult> => {
      const { stopAndUndoPending } = await getRunStore();
      return stopAndUndoPending(runId);
    },
  );

  ipcMain.handle("orchestration:resumeRun", async (_e, input: ResumeRunInput): Promise<RunState> => {
    const { resumeRun } = await getRunStore();
    return resumeRun(input);
  });

  ipcMain.handle("orchestration:addRunMessage", async (_e, input: AddRunMessageInput): Promise<RunState> => {
    const { addRunMessage } = await getRunStore();
    return addRunMessage(input);
  });

  ipcMain.handle(
    "orchestration:undoToCheckpoint",
    async (_e, input: UndoToCheckpointInput): Promise<UndoToCheckpointResult> => {
      const { undoToCheckpoint } = await getRunStore();
      return undoToCheckpoint(input);
    },
  );

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

  ipcMain.handle("orchestration:renameRun", async (_e, input: RenameRunInput): Promise<RunState> => {
    const { renameRun } = await getRunStore();
    return renameRun(input);
  });

  ipcMain.handle(
    "orchestration:updateChatBackend",
    async (_e, input: UpdateChatBackendInput): Promise<RunState> => {
      const { updateChatBackend } = await getRunStore();
      return updateChatBackend(input);
    },
  );

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

  // ── Overnight queue ─────────────────────────────────────────────────────
  // Thin IPC over the run-queue module (src/main/orchestration/run-queue.ts).
  // The queue persists its own JSON state and drains pending runs through
  // run-store's startAutopilot; these channels just expose CRUD + a manual
  // burn-down trigger so the renderer Queue panel can enqueue/list. run-queue.ts
  // imports RunQueueState/QueuedRun/EnqueueRunInput from @shared/types, so these
  // handlers return its values directly — the shapes are the IPC contract.
  ipcMain.handle("queue:list", async (): Promise<RunQueueState> => {
    const { loadQueue } = await getRunQueue();
    return loadQueue();
  });

  ipcMain.handle("queue:enqueue", async (_e, input: EnqueueRunInput): Promise<QueuedRun> => {
    const { enqueue, burnDown } = await getRunQueue();
    const queued = await enqueue(input);
    // Fire-and-forget: kick the drain so a free slot starts this run without
    // making the renderer wait on autopilot. Errors are logged, not surfaced.
    void burnDown().catch((err: unknown) =>
      console.error("[queue] burnDown after enqueue failed", err),
    );
    return queued;
  });

  ipcMain.handle("queue:dequeue", async (_e, id: string): Promise<RunQueueState> => {
    const { dequeue } = await getRunQueue();
    return dequeue(id);
  });

  ipcMain.handle("queue:setConcurrency", async (_e, n: number): Promise<RunQueueState> => {
    const { setConcurrency } = await getRunQueue();
    return setConcurrency(n);
  });

  // burnDown() drains in place and resolves with the post-drain queue snapshot,
  // which is exactly what the renderer wants back from this channel.
  ipcMain.handle("queue:burnDown", async (): Promise<RunQueueState> => {
    const { burnDown } = await getRunQueue();
    return burnDown();
  });

  // ── Scheduler ───────────────────────────────────────────────────────────
  // Thin IPC over the scheduler registry stub (scheduler.ts). Cron firing is
  // stubbed for the scaffold; these channels manage the job registry and let
  // the renderer trigger a job immediately via runNow.
  ipcMain.handle("scheduler:list", async (): Promise<ScheduledJob[]> => {
    const { listJobs } = await getScheduler();
    return listJobs();
  });

  ipcMain.handle(
    "scheduler:create",
    async (_e, input: CreateScheduledJobInput): Promise<ScheduledJob> => {
      const { createJob } = await getScheduler();
      return createJob(input);
    },
  );

  ipcMain.handle("scheduler:delete", async (_e, id: string): Promise<void> => {
    const { deleteJob } = await getScheduler();
    await deleteJob(id);
  });

  ipcMain.handle(
    "scheduler:setEnabled",
    async (_e, input: { id: string; enabled: boolean }): Promise<ScheduledJob> => {
      const { setEnabled } = await getScheduler();
      return setEnabled(input.id, input.enabled);
    },
  );

  ipcMain.handle("scheduler:runNow", async (_e, id: string): Promise<RunState> => {
    const { runJobNow } = await getScheduler();
    return runJobNow(id);
  });

  // Edit an automation's definition (name / trigger / input / loop / prompt).
  ipcMain.handle(
    "scheduler:update",
    async (_e, input: UpdateScheduledJobInput): Promise<ScheduledJob> => {
      const { updateJob } = await getScheduler();
      return updateJob(input);
    },
  );

  // Pause an automation's loop (trigger stays armed).
  ipcMain.handle("scheduler:pause", async (_e, id: string): Promise<ScheduledJob | undefined> => {
    const { pauseJob } = await getScheduler();
    return pauseJob(id);
  });

  // Resume a paused loop.
  ipcMain.handle("scheduler:resume", async (_e, id: string): Promise<ScheduledJob | undefined> => {
    const { resumeJob } = await getScheduler();
    return resumeJob(id);
  });

  // Stop an automation's loop now (finalize + force-pause the live run).
  ipcMain.handle("scheduler:stop", async (_e, id: string): Promise<ScheduledJob | undefined> => {
    const { stopJob } = await getScheduler();
    return stopJob(id);
  });

  // Resolve an automation + its live worker run for the Hub detail pane.
  ipcMain.handle("scheduler:getDetail", async (_e, id: string): Promise<AutomationDetail | null> => {
    const { getDetail } = await getScheduler();
    return getDetail(id);
  });

  // Looms v2: live direct-worker inventory for the Hub's Workers sub-tab.
  ipcMain.handle("automations:listActiveWorkers", async (): Promise<AutomationWorkerInfo[]> => {
    const { listActiveAutomationWorkers } = await import("./orchestration/direct-worker");
    return listActiveAutomationWorkers();
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

  // Probe for an existing session. Used by ChatPanel's backend-terminal tab
  // to decide whether to mount a TerminalPane (which would try to spawn —
  // and fail with ENOENT — if the session hasn't been spawned yet by the
  // headless cli-session). Cheap: just a Map.has() check.
  ipcMain.handle("pty:exists", async (_e, args: { id: string }) => {
    return pty.exists(args.id);
  });

  // Pause / resume the live byte stream while the renderer-side TerminalPane
  // is unmounted (workspace switch). Paused sessions buffer pty output into a
  // detached backlog instead of sending it to webContents — the listener is
  // gone, so the send would be dropped. Resume drains the backlog through the
  // same data channel before live output continues.
  ipcMain.handle("pty:pause", async (_e, args: { id: string }) => {
    pty.pause(args.id);
  });
  ipcMain.handle("pty:resume", async (_e, args: { id: string }) => {
    pty.resume(args.id);
  });
  // Detach — the raw-tail-reattach variant of pause used by ChatPanel's backend
  // terminal. Nulls the renderer sink and DISCARDS the pause/backlog state so
  // the next spawn() replays the raw pty tail into a fresh xterm (like a first
  // attach) instead of resuming a backlog that would double-deliver tail bytes.
  ipcMain.handle("pty:detach", async (_e, args: { id: string }) => {
    pty.detach(args.id);
  });

  // Live runtime-state report from the renderer-side terminal poller. Main
  // forwards the report into run-store (which finds the worker attempt by
  // paneId/attemptId and updates its `runtimeState` field, broadcasting a
  // change event). Reports for panes with no matching attempt — manual
  // claude/codex panes started by the user — are silently ignored.
  ipcMain.handle(
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
  ipcMain.handle(
    "terminalNotify:sync",
    async (
      _e,
      input: { workspaceId: string; workspaceName?: string; panes: TerminalNotifyPaneEntry[] },
    ) => {
      syncTerminalNotifyPanes(input);
    },
  );

  // Renderer reports what the user is looking at (focus + active workspace/
  // tab/run/pane) in one snapshot; the notify policy suppresses alerts for
  // the surface the user is already watching.
  ipcMain.handle(
    "ui:setAttention",
    async (_e, snapshot: Partial<UiAttentionSnapshot> | null): Promise<void> => {
      setAttention(snapshot);
    },
  );

  // Notification center (src/main/notify/center-store).
  ipcMain.handle(
    "notify:list",
    async (): Promise<NotificationCenterEntry[]> => listCenterEntries(),
  );
  ipcMain.handle("notify:markRead", async (_e, id: string): Promise<void> => {
    if (typeof id === "string") await markCenterRead(id);
  });
  ipcMain.handle("notify:markAllRead", async (): Promise<void> => {
    await markCenterAllRead();
  });
  ipcMain.handle("notify:remove", async (_e, id: string): Promise<void> => {
    if (typeof id === "string") await removeCenterEntry(id);
  });
  ipcMain.handle("notify:clear", async (): Promise<void> => {
    await clearCenter();
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

  // Hide the window to the system tray (close-to-tray) without quitting. On
  // win32 we also drop the taskbar button so the hidden window doesn't linger
  // there — mirrors the close-to-tray path in main's window `close` handler.
  ipcMain.handle("window:hide-to-tray", async (e): Promise<void> => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    win.hide();
    if (process.platform === "win32") win.setSkipTaskbar(true);
  });

  ipcMain.handle(
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

  ipcMain.handle("app:platform", async (): Promise<NodeJS.Platform> => process.platform);
  ipcMain.handle("app:home", async (): Promise<string> => app.getPath("home"));

  // Resolve the absolute file:// URL of the webview-side inspector preload
  // bundle so the renderer can attach it via `<webview preload="...">`.
  // The bundle is emitted by electron-vite alongside the main renderer
  // preload, so we walk relative to `__dirname` (out/main).
  ipcMain.handle("app:inspectorPreloadUrl", async (): Promise<string> => {
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

  ipcMain.handle(
    "search:start",
    async (e, opts: SearchOptions): Promise<StartSearchResponse> => {
      const sender = e.sender;
      assertAllowedReadPath(opts.root);
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

  ipcMain.handle("search:cancel", async (_e, searchId: string): Promise<void> => {
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
  // Image paste bridge for terminal panes. Agent CLIs (Claude Code) accept an
  // image by its file path — dragging or pasting an image into their TUI turns
  // into an `[Image #N]` chip when they see a bracketed-paste of a path ending
  // in an image extension. The system clipboard, however, holds the image as
  // raw pixels, not a path. So when the clipboard carries an image (and no
  // usable text), materialise it as a PNG in the OS temp dir and return that
  // path for the renderer to shell-escape and bracketed-paste. Returns null
  // when the clipboard has no image, so the caller can fall back cleanly.
  ipcMain.handle("clipboard:readImageAsTempFile", async (): Promise<string | null> => {
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

  ipcMain.handle("app:openExternal", async (_e, url: string): Promise<void> => {
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
