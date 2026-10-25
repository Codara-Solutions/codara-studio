// The live port forwarder: port-forwarding.ts behind the real SSH
// connections, terminal sessions, workspace list and renderer. ipc.ts calls
// registerPortForwardIpc once at boot; nothing else runs until a remote
// workspace's host connects. The renderer side is window.spark.ports
// (src/preload/areas/ports.ts).

import { connect } from "node:net";
import { app, webContents } from "electron";

import { isRemotePath } from "@shared/remote";
import type { PortsSnapshot } from "@shared/port-forwarding";
import type { IpcHandle } from "../ipc";
import * as pty from "../pty-manager";
import { loadState, onStateSaved } from "../storage";
import { getConnection, getConnectionStatus, onConnectionLifecycle } from "./connections";
import { provideRemotePreviewResolver } from "./port-forward-preview";
import { PortForwardManager } from "./port-forwarding";

const IPV6_PROBE_MS = 300;

let manager: PortForwardManager | null = null;

function broadcast(channel: string, payload: unknown): void {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    try {
      contents.send(channel, payload);
    } catch {
      // Window mid-teardown.
    }
  }
}

function isConnected(hostId: string): boolean {
  return getConnectionStatus(hostId).state === "connected";
}

// getConnection would create (and later connect) a host that has none, so
// every remote call checks the live state first.
async function openConnection(hostId: string) {
  if (!isConnected(hostId)) throw new Error(`SSH connection to ${hostId} is not open.`);
  return getConnection(hostId);
}

function servedOnIpv6Loopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "::1", port });
    const finish = (served: boolean) => {
      socket.destroy();
      resolve(served);
    };
    socket.setTimeout(IPV6_PROBE_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.unref();
  });
}

export function portForwarding(): PortForwardManager {
  if (manager) return manager;
  const created = new PortForwardManager({
    isConnected,
    sshPort: async (hostId) => (isConnected(hostId) ? (await getConnection(hostId)).host.port : null),
    openChannel: async (hostId, host, port, from) => (await openConnection(hostId)).forwardOut(host, port, from),
    exec: async (hostId, command, options) => (await openConnection(hostId)).exec(command, options),
    panes: () =>
      pty
        .resourceSnapshot()
        .sessions.filter((session) => isRemotePath(session.cwd))
        .map((session) => ({ paneId: session.id, cwd: session.cwd })),
    tapPane: (paneId, listener) => {
      const decoder = new TextDecoder();
      return pty.tap(paneId, (chunk) => listener(decoder.decode(chunk, { stream: true })));
    },
    recentPaneOutput: (paneId) => pty.readTail(paneId, 16_384)?.toString("utf8") ?? "",
    changed: (hostId) => broadcast("ports:changed", { hostId }),
    notice: (notice) => broadcast("ports:notice", notice),
    localPortServedElsewhere: servedOnIpv6Loopback,
  });
  manager = created;
  onConnectionLifecycle((hostId, event) => created.connectionEvent(hostId, event));
  // A save that lands while the first read is in flight is newer than it.
  let saved = false;
  onStateSaved((state) => {
    saved = true;
    created.setWorkspaces(state.workspaces);
  });
  void loadState()
    .then((state) => {
      if (!saved) created.setWorkspaces(state.workspaces);
    })
    .catch(() => undefined);
  provideRemotePreviewResolver(async (workspaceId, url) => {
    const id =
      typeof workspaceId === "string" && workspaceId
        ? workspaceId
        : ((await loadState().catch(() => null))?.activeWorkspaceId ?? null);
    return id ? created.resolvePreviewUrl(id, url) : null;
  });
  app.once("will-quit", () => created.dispose());
  return created;
}

function workspaceIdOf(input: unknown): string {
  const value = input && typeof input === "object" ? (input as { workspaceId?: unknown }).workspaceId : input;
  if (typeof value !== "string" || !value) throw new Error("workspaceId is required");
  return value;
}

function portOf(input: unknown): number {
  const value = input && typeof input === "object" ? (input as { port?: unknown }).port : undefined;
  const port = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Enter a port number from 1 to 65535.");
  }
  return port;
}

/** Register this area's channels with the trusted-sender `handle`. */
export function registerPortForwardIpc(handle: IpcHandle): void {
  const ports = portForwarding();
  handle("ports:snapshot", async (_event, workspaceId: unknown): Promise<PortsSnapshot | null> =>
    ports.snapshotForWorkspace(workspaceIdOf(workspaceId)),
  );
  handle("ports:forward", async (_event, input: unknown): Promise<PortsSnapshot> =>
    ports.forwardForWorkspace(workspaceIdOf(input), portOf(input)),
  );
  handle("ports:stop", async (_event, input: unknown): Promise<PortsSnapshot> =>
    ports.stopForWorkspace(workspaceIdOf(input), portOf(input)),
  );
}
