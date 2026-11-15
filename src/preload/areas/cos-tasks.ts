// window.spark.cosTasks: the renderer side of src/main/cos/ (each
// workspace's task list, as the count line the rail shows). Kept out of
// index.ts so its owner adds calls here only.

import { ipcRenderer } from "electron";

import type { TaskSummary, TaskSummaryChange } from "@shared/cos-tasks";
import { subscribe } from "../subscribe";

export const cosTasksApi = {
  summaries: (): Promise<Record<string, TaskSummary>> => ipcRenderer.invoke("cosTasks:summaries"),
  /** Records `url` as the workspace's origin; false when it is no longer the one waiting. */
  confirmOrigin: (workspaceId: string, url: string): Promise<boolean> => ipcRenderer.invoke("cosTasks:confirmOrigin", workspaceId, url),
  onChanged: subscribe<TaskSummaryChange>("cosTasks:changed"),
};
