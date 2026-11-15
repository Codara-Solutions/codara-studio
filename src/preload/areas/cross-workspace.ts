// window.spark.crossWorkspace: the renderer side of src/main/cross-workspace-ipc.ts
// (an agent asks to open terminals in another workspace; the grants the user
// chose "Always" for).

import { ipcRenderer } from "electron";

import type {
  CrossWorkspaceAnswer,
  CrossWorkspaceApprovalClosed,
  CrossWorkspaceApprovalRequest,
  CrossWorkspaceGrant,
} from "@shared/cross-workspace";
import { subscribe, subscribeSignal } from "../subscribe";

export const crossWorkspaceApi = {
  /** Requests still waiting for an answer, for a window that mounts after they were sent. */
  pending: (): Promise<CrossWorkspaceApprovalRequest[]> => ipcRenderer.invoke("crossWorkspace:pending"),
  onApproval: subscribe<CrossWorkspaceApprovalRequest>("crossWorkspace:approval"),
  /** The request is no longer waited for (it timed out, or another card's Always answered it). */
  onApprovalClosed: subscribe<CrossWorkspaceApprovalClosed>("crossWorkspace:approvalClosed"),
  /** False when the request is no longer waited for. */
  answer: (id: string, answer: CrossWorkspaceAnswer): Promise<boolean> =>
    ipcRenderer.invoke("crossWorkspace:answer", { id, answer }),
  allowAll: (): Promise<boolean> => ipcRenderer.invoke("crossWorkspace:allowAll"),
  setAllowAll: (value: boolean): Promise<boolean> => ipcRenderer.invoke("crossWorkspace:setAllowAll", value),
  grants: (): Promise<CrossWorkspaceGrant[]> => ipcRenderer.invoke("crossWorkspace:grants"),
  /** A grant was added or revoked. */
  onGrantsChanged: subscribeSignal("crossWorkspace:grantsChanged"),
  revoke: (callerWorkspaceId: string, targetWorkspaceId: string): Promise<boolean> =>
    ipcRenderer.invoke("crossWorkspace:revoke", { callerWorkspaceId, targetWorkspaceId }),
};
