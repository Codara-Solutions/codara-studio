// window.spark.cosTasks: the renderer side of src/main/cos/ (each
// workspace's task list, as the count line the rail shows). Kept out of
// index.ts so its owner adds calls here only.

import { ipcRenderer } from "electron";

import type { TaskSummary, TaskSummaryChange } from "@shared/cos-tasks";

export const cosTasksApi = {
  summaries: (): Promise<Record<string, TaskSummary>> => ipcRenderer.invoke("cosTasks:summaries"),
  /** Records `url` as the workspace's origin; false when it is no longer the one waiting. */
  confirmOrigin: (workspaceId: string, url: string): Promise<boolean> => ipcRenderer.invoke("cosTasks:confirmOrigin", workspaceId, url),
  onChanged: (listener: (change: TaskSummaryChange) => void): (() => void) => {
    const wrapped = (_event: unknown, change: TaskSummaryChange): void => listener(change);
    ipcRenderer.on("cosTasks:changed", wrapped);
    return () => ipcRenderer.removeListener("cosTasks:changed", wrapped);
  },
};
