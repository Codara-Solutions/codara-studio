// window.spark.crossWorkspace: the renderer side of src/main/cross-workspace-ipc.ts
// (an agent asks to open terminals in another workspace; the grants the user
// chose "Always" for).

import { ipcRenderer } from "electron";

import type {
  CrossWorkspaceAnswer,
  CrossWorkspaceApprovalRequest,
  CrossWorkspaceGrant,
} from "@shared/cross-workspace";

export const crossWorkspaceApi = {
  /** Requests still waiting for an answer, for a window that mounts after they were sent. */
  pending: (): Promise<CrossWorkspaceApprovalRequest[]> => ipcRenderer.invoke("crossWorkspace:pending"),
  onApproval: (listener: (request: CrossWorkspaceApprovalRequest) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: CrossWorkspaceApprovalRequest): void => listener(payload);
    ipcRenderer.on("crossWorkspace:approval", wrapped);
    return () => ipcRenderer.removeListener("crossWorkspace:approval", wrapped);
  },
  /** The request is no longer waited for (it timed out). */
  onApprovalClosed: (listener: (payload: { id: string }) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: { id: string }): void => listener(payload);
    ipcRenderer.on("crossWorkspace:approvalClosed", wrapped);
    return () => ipcRenderer.removeListener("crossWorkspace:approvalClosed", wrapped);
  },
  /** False when the request is no longer waited for. */
  answer: (id: string, answer: CrossWorkspaceAnswer): Promise<boolean> =>
    ipcRenderer.invoke("crossWorkspace:answer", { id, answer }),
  grants: (): Promise<CrossWorkspaceGrant[]> => ipcRenderer.invoke("crossWorkspace:grants"),
  revoke: (callerWorkspaceId: string, targetWorkspaceId: string): Promise<boolean> =>
    ipcRenderer.invoke("crossWorkspace:revoke", { callerWorkspaceId, targetWorkspaceId }),
};
