import { ipcMain, dialog, BrowserWindow, app } from "electron";
import { listShells, defaultShell } from "./shells";
import { deleteFile, listDir, readTextFile, renameFile, writeTextFile } from "./fs-tree";
import { getGitGraph } from "./git-graph";
import { loadState, saveState } from "./storage";
import * as pty from "./pty-manager";
import {
  appendTestEvent,
  createStep,
  createRun,
  createWorkerTask,
  deleteRun,
  getRunArtifactPaths,
  getRun,
  listRuns,
  updateRunStatus,
  updateStep,
  updateWorkerTask,
} from "./orchestration/run-store";
import { listEvents } from "./orchestration/event-log";
import type {
  AppState,
  CreateStepInput,
  CreateRunInput,
  CreateWorkerTaskInput,
  FsEntry,
  FsFileContent,
  GitGraph,
  RenameFileInput,
  RunArtifactPaths,
  RunState,
  ShellInfo,
  SparkEvent,
  UpdateRunStatusInput,
  UpdateStepInput,
  UpdateWorkerTaskInput,
} from "@shared/types";

export function registerIpc(): void {
  ipcMain.handle("state:load", async (): Promise<AppState> => {
    return loadState();
  });

  ipcMain.handle("state:save", async (_e, state: AppState): Promise<void> => {
    await saveState(state);
  });

  ipcMain.handle("shells:list", async (): Promise<ShellInfo[]> => {
    return listShells();
  });

  ipcMain.handle("shells:default", async (): Promise<ShellInfo | null> => {
    return defaultShell();
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

  ipcMain.handle("fs:list", async (_e, dir: string) => {
    return listDir(dir);
  });

  ipcMain.handle("fs:readText", async (_e, path: string): Promise<FsFileContent> => {
    return readTextFile(path);
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

  ipcMain.handle("git:graph", async (_e, cwd: string): Promise<GitGraph> => {
    return getGitGraph(cwd);
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

  ipcMain.handle("orchestration:deleteRun", async (_e, runId: string): Promise<void> => {
    await deleteRun(runId);
  });

  ipcMain.handle(
    "pty:spawn",
    async (e, args: { id: string; shell: ShellInfo; cwd: string; cols: number; rows: number }) => {
      return pty.spawn({
        id: args.id,
        shell: args.shell,
        cwd: args.cwd,
        cols: args.cols,
        rows: args.rows,
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

  ipcMain.handle("app:platform", async (): Promise<NodeJS.Platform> => process.platform);
  ipcMain.handle("app:home", async (): Promise<string> => app.getPath("home"));
}
