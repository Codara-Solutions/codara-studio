import { contextBridge, ipcRenderer } from "electron";
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

type PtyDataHandler = (data: string) => void;
type PtyExitHandler = (info: { exitCode: number; signal?: number }) => void;
type OrchestrationEventHandler = (event: SparkEvent) => void;

const api = {
  state: {
    load: (): Promise<AppState> => ipcRenderer.invoke("state:load"),
    save: (state: AppState): Promise<void> => ipcRenderer.invoke("state:save", state),
  },
  shells: {
    list: (): Promise<ShellInfo[]> => ipcRenderer.invoke("shells:list"),
    default: (): Promise<ShellInfo | null> => ipcRenderer.invoke("shells:default"),
  },
  dialog: {
    openDirectory: (defaultPath?: string): Promise<string | null> =>
      ipcRenderer.invoke("dialog:openDirectory", defaultPath),
  },
  fs: {
    list: (dir: string): Promise<FsEntry[]> => ipcRenderer.invoke("fs:list", dir),
    readText: (path: string): Promise<FsFileContent> => ipcRenderer.invoke("fs:readText", path),
    writeText: (path: string, content: string): Promise<FsFileContent> =>
      ipcRenderer.invoke("fs:writeText", { path, content }),
    renameFile: (input: RenameFileInput): Promise<FsEntry> =>
      ipcRenderer.invoke("fs:renameFile", input),
    deleteFile: (path: string): Promise<void> => ipcRenderer.invoke("fs:deleteFile", path),
  },
  git: {
    graph: (cwd: string): Promise<GitGraph> => ipcRenderer.invoke("git:graph", cwd),
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
    }): Promise<{ id: string; pid: number }> => ipcRenderer.invoke("pty:spawn", args),
    write: (id: string, data: string): Promise<void> =>
      ipcRenderer.invoke("pty:write", { id, data }),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke("pty:resize", { id, cols, rows }),
    dispose: (id: string): Promise<void> => ipcRenderer.invoke("pty:dispose", { id }),
    onData: (id: string, handler: PtyDataHandler): (() => void) => {
      const channel = `pty:data:${id}`;
      const listener = (_e: Electron.IpcRendererEvent, data: string) => handler(data);
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
  app: {
    platform: (): Promise<NodeJS.Platform> => ipcRenderer.invoke("app:platform"),
    home: (): Promise<string> => ipcRenderer.invoke("app:home"),
  },
};

contextBridge.exposeInMainWorld("spark", api);

export type SparkApi = typeof api;
