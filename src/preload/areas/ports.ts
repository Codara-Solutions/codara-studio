// window.spark.ports: the renderer side of SSH port forwarding
// (src/main/remote/port-forward-runtime.ts). Kept out of index.ts so its
// owner adds calls here only.

import { ipcRenderer } from "electron";

import type { PortForwardNotice, PortsSnapshot } from "@shared/port-forwarding";
import { subscribe } from "../subscribe";

export const portsApi = {
  /** The forwards of the workspace's host; null for a local workspace. */
  snapshot: (workspaceId: string): Promise<PortsSnapshot | null> => ipcRenderer.invoke("ports:snapshot", workspaceId),
  forward: (workspaceId: string, port: number): Promise<PortsSnapshot> =>
    ipcRenderer.invoke("ports:forward", { workspaceId, port }),
  stop: (workspaceId: string, port: number): Promise<PortsSnapshot> =>
    ipcRenderer.invoke("ports:stop", { workspaceId, port }),
  onChanged: subscribe<{ hostId: string }>("ports:changed"),
  /** Codara forwarded a port on its own. */
  onNotice: subscribe<PortForwardNotice>("ports:notice"),
};
