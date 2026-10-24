// window.spark.ports: the renderer side of SSH port forwarding
// (src/main/remote/port-forward-runtime.ts). Kept out of index.ts so its
// owner adds calls here only.

import { ipcRenderer } from "electron";

import type { PortForwardNotice, PortsSnapshot } from "@shared/port-forwarding";

export const portsApi = {
  /** The forwards of the workspace's host; null for a local workspace. */
  snapshot: (workspaceId: string): Promise<PortsSnapshot | null> => ipcRenderer.invoke("ports:snapshot", workspaceId),
  forward: (workspaceId: string, port: number): Promise<PortsSnapshot> =>
    ipcRenderer.invoke("ports:forward", { workspaceId, port }),
  stop: (workspaceId: string, port: number): Promise<PortsSnapshot> =>
    ipcRenderer.invoke("ports:stop", { workspaceId, port }),
  onChanged: (listener: (payload: { hostId: string }) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: { hostId: string }): void => listener(payload);
    ipcRenderer.on("ports:changed", wrapped);
    return () => ipcRenderer.removeListener("ports:changed", wrapped);
  },
  /** Codara forwarded a port on its own. */
  onNotice: (listener: (notice: PortForwardNotice) => void): (() => void) => {
    const wrapped = (_event: unknown, notice: PortForwardNotice): void => listener(notice);
    ipcRenderer.on("ports:notice", wrapped);
    return () => ipcRenderer.removeListener("ports:notice", wrapped);
  },
};
