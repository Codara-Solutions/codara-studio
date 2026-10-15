// window.spark.workspaceStatus: the renderer side of src/main/workspace-status/
// (each workspace's status and progress note). Kept out of index.ts so its
// owner adds calls here only.

import { ipcRenderer } from "electron";

import type {
  WorkspaceStatusChange,
  WorkspaceStatusEntry,
  WorkspaceStatusMap,
  WorkspaceStatusPatch,
} from "@shared/workspace-status";

export const workspaceStatusApi = {
  list: (): Promise<WorkspaceStatusMap> => ipcRenderer.invoke("workspaceStatus:list"),
  set: (workspaceId: string, patch: WorkspaceStatusPatch): Promise<WorkspaceStatusEntry | null> =>
    ipcRenderer.invoke("workspaceStatus:set", workspaceId, patch),
  onChanged: (listener: (change: WorkspaceStatusChange) => void): (() => void) => {
    const wrapped = (_event: unknown, change: WorkspaceStatusChange): void => listener(change);
    ipcRenderer.on("workspaceStatus:changed", wrapped);
    return () => ipcRenderer.removeListener("workspaceStatus:changed", wrapped);
  },
};
