// window.spark.servers: the renderer side of src/main/servers/ (running dev
// servers, the status view, launch arguments). Kept out of index.ts so its
// owner adds calls here only.

import { ipcRenderer } from "electron";

import type {
  DevServerLogs,
  DevServerSaveInput,
  DevServerStartInput,
  DevServerStartReply,
  DevServerStatus,
  LaunchArgRuntime,
  LaunchArgsCheck,
  LaunchArgsSettings,
  StatusSnapshot,
} from "@shared/servers";

export const serversApi = {
  status: (workspaceId: string | null, options?: { detail?: boolean }): Promise<StatusSnapshot> =>
    ipcRenderer.invoke("servers:status", workspaceId, options),
  /** Starts the workspace's auto-start servers the first time it opens in this app session. */
  workspaceOpened: (workspaceId: string): Promise<string[]> => ipcRenderer.invoke("servers:workspaceOpened", workspaceId),
  start: (input: DevServerStartInput): Promise<DevServerStartReply> => ipcRenderer.invoke("servers:start", input),
  stop: (workspaceId: string, id: string): Promise<{ server: DevServerStatus; alreadyStopped: boolean }> =>
    ipcRenderer.invoke("servers:stop", { workspaceId, id }),
  restart: (workspaceId: string, id: string): Promise<DevServerStartReply> => ipcRenderer.invoke("servers:restart", { workspaceId, id }),
  logs: (workspaceId: string, id: string, since?: number): Promise<DevServerLogs> =>
    ipcRenderer.invoke("servers:logs", { workspaceId, id, since }),
  save: (input: DevServerSaveInput): Promise<DevServerStatus> => ipcRenderer.invoke("servers:save", input),
  forget: (workspaceId: string, id: string): Promise<{ id: string; forgotten: boolean }> =>
    ipcRenderer.invoke("servers:forget", { workspaceId, id }),
  onChanged: (listener: (payload: { workspaceId: string }) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: { workspaceId: string }): void => listener(payload);
    ipcRenderer.on("servers:changed", wrapped);
    return () => ipcRenderer.removeListener("servers:changed", wrapped);
  },
  launchArgs: {
    get: (): Promise<LaunchArgsSettings> => ipcRenderer.invoke("servers:launchArgs:get"),
    check: (runtime: LaunchArgRuntime, text: string): Promise<LaunchArgsCheck> =>
      ipcRenderer.invoke("servers:launchArgs:check", { runtime, text }),
    set: (settings: LaunchArgsSettings): Promise<LaunchArgsSettings> => ipcRenderer.invoke("servers:launchArgs:set", settings),
  },
};
