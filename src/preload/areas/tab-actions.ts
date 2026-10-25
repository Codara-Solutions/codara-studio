// window.spark.tabActions: the renderer side of src/main/tab-action-ipc.ts
// (an agent asks to close, split or unsplit tabs it did not open).

import { ipcRenderer } from "electron";

import type {
  TabActionAnswer,
  TabActionApprovalClosed,
  TabActionApprovalRequest,
  TabActionGrant,
  TabActionGrantKind,
} from "@shared/tab-actions";

export const tabActionsApi = {
  /** Requests still waiting for an answer, for a window that mounts after they were sent. */
  pending: (): Promise<TabActionApprovalRequest[]> => ipcRenderer.invoke("tabAction:pending"),
  onApproval: (listener: (request: TabActionApprovalRequest) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: TabActionApprovalRequest): void => listener(payload);
    ipcRenderer.on("tabAction:approval", wrapped);
    return () => ipcRenderer.removeListener("tabAction:approval", wrapped);
  },
  /** The request is no longer waited for (it timed out, another card's Always answered it, or the agent left). */
  onApprovalClosed: (listener: (payload: TabActionApprovalClosed) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: TabActionApprovalClosed): void => listener(payload);
    ipcRenderer.on("tabAction:approvalClosed", wrapped);
    return () => ipcRenderer.removeListener("tabAction:approvalClosed", wrapped);
  },
  /** False when the request is no longer waited for. */
  answer: (id: string, answer: TabActionAnswer): Promise<boolean> =>
    ipcRenderer.invoke("tabAction:answer", { id, answer }),
  /** Close and move grants, each with its action. */
  grants: (): Promise<TabActionGrant[]> => ipcRenderer.invoke("tabAction:grants"),
  /** A grant was added or revoked. */
  onGrantsChanged: (listener: () => void): (() => void) => {
    const wrapped = (): void => listener();
    ipcRenderer.on("tabAction:grantsChanged", wrapped);
    return () => ipcRenderer.removeListener("tabAction:grantsChanged", wrapped);
  },
  revoke: (action: TabActionGrantKind, callerWorkspaceId: string, targetWorkspaceId: string): Promise<boolean> =>
    ipcRenderer.invoke("tabAction:revoke", { action, callerWorkspaceId, targetWorkspaceId }),
};
