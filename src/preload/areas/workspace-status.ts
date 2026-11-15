// window.spark.workspaceStatus: the renderer side of src/main/workspace-status/
// (the status you set on each workspace, and each agent's own note). Kept out
// of index.ts so its owner adds calls here only.

import { ipcRenderer } from "electron";

import type { AgentNoteChange, AgentNoteMap } from "@shared/agent-status";
import type {
  WorkspaceStatusChange,
  WorkspaceStatusEntry,
  WorkspaceStatusMap,
  WorkspaceStatusPatch,
} from "@shared/workspace-status";
import { subscribe } from "../subscribe";

export const workspaceStatusApi = {
  list: (): Promise<WorkspaceStatusMap> => ipcRenderer.invoke("workspaceStatus:list"),
  set: (workspaceId: string, patch: WorkspaceStatusPatch): Promise<WorkspaceStatusEntry | null> =>
    ipcRenderer.invoke("workspaceStatus:set", workspaceId, patch),
  onChanged: subscribe<WorkspaceStatusChange>("workspaceStatus:changed"),
  agentNotes: (): Promise<AgentNoteMap> => ipcRenderer.invoke("workspaceStatus:agentNotes"),
  onAgentNoteChanged: subscribe<AgentNoteChange>("workspaceStatus:agentNoteChanged"),
};
