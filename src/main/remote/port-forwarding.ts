// SSH port forwarding for remote workspaces, like VS Code's Ports view but
// smaller. A dev server that starts on the remote host is found two ways: a
// localhost URL printed in one of the host's terminals (Codara's own panes,
// including those agents open with codara_terminal_create or
// codara_terminal_run), and a light poll of the host's listening TCP ports.
// Each forward is a loopback-only net server here whose connections ride the
// host's existing ssh2 connection as direct-tcpip channels (ssh -L), so a
// Codara Cloud box, which reaches its sshd through a ProxyCommand, forwards
// the same way.
//
// Forwards belong to a host, kept while at least one workspace on it is in
// the app. They close when the last such workspace is removed, close and wait
// when the connection drops, and bind again (same local port when free) when
// it reconnects. Nothing here connects a host: forwarding only runs on a
// connection something else opened, so a host the user disconnected stays so.
//
// Every effect goes through PortForwardDeps (port-forward-runtime.ts wires the
// real ones), so scripts/test-remote-port-forward.cjs drives it against an
// in-process SSH server.

import { createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import { parseRemotePath } from "@shared/remote";
import type {
  ForwardedPort,
  ListeningRemotePort,
  PortForwardNotice,
  PortForwardSource,
  PortForwardState,
  PortsSnapshot,
  RemotePortListing,
} from "@shared/port-forwarding";
import {
  REMOTE_LISTEN_SCRIPT,
  TerminalPortScanner,
  bindFirstFree,
  candidateLocalPorts,
  forwardTargetHost,
  listeningPortAutoForwards,
  listeningPortOffered,
  localForwardUrl,
  parseListeningPorts,
  terminalPortAllowed,
  type TerminalPortUrl,
} from "./port-detect";

export interface PortForwardDeps {
  /** Whether the host's connection is open right now. Never connects. */
  isConnected(hostId: string): boolean;
  /** The SSH port from the host's config. */
  sshPort(hostId: string): Promise<number | null>;
  /** A direct-tcpip channel on the host's open connection. */
  openChannel(
    hostId: string,
    host: string,
    port: number,
    from: { address: string; port: number },
  ): Promise<Duplex>;
  /** One command on the host's open connection. */
  exec(
    hostId: string,
    command: string,
    options: { stdin?: string; timeoutMs: number },
  ): Promise<{ stdout: string; code: number | null }>;
  /** Live terminal sessions with their spawn cwd (remote ones are ssh://<host>/...). */
  panes(): Array<{ paneId: string; cwd: string }>;
  tapPane(paneId: string, listener: (text: string) => void): () => void;
  recentPaneOutput(paneId: string): string;
  /** The host's snapshot changed. */
  changed(hostId: string): void;
  /** A forward Codara made on its own is ready to open. */
  notice(notice: PortForwardNotice): void;
  /**
   * Whether another local process serves this port on ::1. The forward binds
   * 127.0.0.1 only, and a browser trying ::1 first for "localhost" would reach
   * that process instead.
   */
  localPortServedElsewhere?(port: number): Promise<boolean>;
}

export interface PortForwardOptions {
  pollMs?: number;
  paneSyncMs?: number;
  /** Waits before each check that a port named in output answers on the host. */
  probeDelaysMs?: readonly number[];
  /** Polls a port must be missing before its automatic forward closes. */
  goneAfterPolls?: number;
  execTimeoutMs?: number;
}

const DEFAULT_POLL_MS = 4_000;
const DEFAULT_PANE_SYNC_MS = 2_000;
const DEFAULT_PROBE_DELAYS_MS = [0, 250, 500, 1_000, 2_000];
const DEFAULT_GONE_AFTER_POLLS = 2;
const DEFAULT_EXEC_TIMEOUT_MS = 10_000;
const RECENT_OUTPUT_BYTES = 16_384;
const COMMAND_CHARS = 160;

interface Forward {
  remotePort: number;
  remoteHost: string;
  scheme: "http" | "https";
  path: string;
  source: PortForwardSource;
  state: PortForwardState;
  localPort: number | null;
  /** Bound before a drop; tried first when the connection comes back. */
  preferredLocalPort: number | null;
  server: Server | null;
  sockets: Set<Socket>;
  binding: Promise<void> | null;
  error?: string;
}

interface HostState {
  hostId: string;
  workspaces: number;
  connected: boolean;
  sshPort: number | null;
  forwards: Map<number, Forward>;
  listening: Map<number, ListeningRemotePort> | null;
  listing: RemotePortListing;
  /** Ports already listening at the first poll after connecting: not this session's servers. */
  baseline: Set<number> | null;
  missing: Map<number, number>;
  /** Stopped by the user; not forwarded again until the port closes. */
  dismissed: Set<number>;
  notified: Set<number>;
  probing: Set<number>;
  commands: Map<number, string>;
  pollTimer: NodeJS.Timeout | null;
  polling: boolean;
  lastSignature: string;
}

interface WatchedPane {
  hostId: string;
  scanner: TerminalPortScanner;
  off: () => void;
}

export type RemotePreviewUrl = { url: string } | { error: string };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function closeQuietly(stream: Duplex | Socket): void {
  try {
    stream.destroy();
  } catch {
    // Already gone.
  }
}

// One local socket to one channel. A channel that closes ends the socket
// gracefully so a response still queued for a slow reader is not cut off.
function bridge(socket: Socket, channel: Duplex): void {
  const fail = () => {
    closeQuietly(socket);
    closeQuietly(channel);
  };
  socket.on("error", fail);
  channel.on("error", fail);
  socket.once("close", () => closeQuietly(channel));
  channel.once("close", () => {
    if (!socket.destroyed) socket.end();
  });
  socket.pipe(channel);
  channel.pipe(socket);
}

function listenLoopback(port: number, onSocket: (socket: Socket) => void): Promise<Server | null> {
  return new Promise((resolve) => {
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, onSocket);
    const onError = () => {
      server.close();
      resolve(null);
    };
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", onError);
      server.on("error", () => undefined);
      resolve(server);
    });
  });
}

function processLabel(entry: ListeningRemotePort | undefined): string | undefined {
  if (!entry?.process) return undefined;
  return entry.pid ? `${entry.process} (${entry.pid})` : entry.process;
}

export class PortForwardManager {
  private readonly hosts = new Map<string, HostState>();
  private readonly workspaceHosts = new Map<string, string>();
  private readonly panes = new Map<string, WatchedPane>();
  private paneTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private readonly pollMs: number;
  private readonly paneSyncMs: number;
  private readonly probeDelaysMs: readonly number[];
  private readonly goneAfterPolls: number;
  private readonly execTimeoutMs: number;

  constructor(
    private readonly deps: PortForwardDeps,
    options: PortForwardOptions = {},
  ) {
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.paneSyncMs = options.paneSyncMs ?? DEFAULT_PANE_SYNC_MS;
    this.probeDelaysMs = options.probeDelaysMs ?? DEFAULT_PROBE_DELAYS_MS;
    this.goneAfterPolls = options.goneAfterPolls ?? DEFAULT_GONE_AFTER_POLLS;
    this.execTimeoutMs = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  }

  // ── Inputs ────────────────────────────────────────────────────────────────

  /** The app's workspace list: a host is followed while one of its workspaces is in it. */
  setWorkspaces(workspaces: ReadonlyArray<{ id: string; cwd: string }>): void {
    if (this.disposed) return;
    this.workspaceHosts.clear();
    const counts = new Map<string, number>();
    for (const workspace of workspaces) {
      const hostId = parseRemotePath(workspace.cwd)?.hostId;
      if (!hostId) continue;
      this.workspaceHosts.set(workspace.id, hostId);
      counts.set(hostId, (counts.get(hostId) ?? 0) + 1);
    }
    for (const [hostId, state] of this.hosts) {
      if (counts.has(hostId)) continue;
      this.closeHost(state);
      this.hosts.delete(hostId);
    }
    for (const [hostId, count] of counts) {
      const existing = this.hosts.get(hostId);
      if (existing) {
        existing.workspaces = count;
        continue;
      }
      const state = this.newHost(hostId, count);
      this.hosts.set(hostId, state);
      if (this.deps.isConnected(hostId)) void this.activate(state);
    }
    this.updatePaneTimer();
  }

  /** The host's ssh2 client was adopted ("connected") or its transport closed. */
  connectionEvent(hostId: string, event: "connected" | "closed"): void {
    if (this.disposed) return;
    const state = this.hosts.get(hostId);
    if (!state) return;
    if (event === "connected") {
      if (!state.connected) void this.activate(state);
      return;
    }
    // A replaced client closing late while its successor is already open:
    // the listeners stay, their next channel opens on the new client.
    if (!state.connected || this.deps.isConnected(hostId)) return;
    state.connected = false;
    this.stopPolling(state);
    for (const forward of state.forwards.values()) {
      this.closeListener(forward);
      if (forward.state === "active") forward.preferredLocalPort = forward.localPort;
      // A bind still in flight checks the connection when it lands and is
      // reused by the next one, so a quick reconnect cannot bind twice.
      forward.state = "waiting";
      forward.localPort = null;
    }
    state.listening = null;
    state.baseline = null;
    state.missing.clear();
    state.listing = "pending";
    this.releasePanes(hostId);
    this.updatePaneTimer();
    this.emitChanged(state);
  }

  // ── Renderer and agent entry points ───────────────────────────────────────

  hostOfWorkspace(workspaceId: string): string | null {
    return this.workspaceHosts.get(workspaceId) ?? null;
  }

  snapshotForWorkspace(workspaceId: string): PortsSnapshot | null {
    const hostId = this.hostOfWorkspace(workspaceId);
    return hostId ? this.snapshot(hostId) : null;
  }

  snapshot(hostId: string): PortsSnapshot | null {
    const state = this.hosts.get(hostId);
    if (!state) return null;
    const context = { sshPort: state.sshPort };
    const forwards: ForwardedPort[] = [...state.forwards.values()]
      .sort((a, b) => a.remotePort - b.remotePort)
      .map((forward) => {
        const listed = state.listening?.get(forward.remotePort);
        const process = processLabel(listed);
        const command = listed?.pid ? state.commands.get(listed.pid) : undefined;
        return {
          remotePort: forward.remotePort,
          remoteHost: forward.remoteHost,
          localPort: forward.state === "active" ? forward.localPort : null,
          localUrl:
            forward.state === "active" && forward.localPort
              ? localForwardUrl(forward.scheme, forward.localPort, forward.path)
              : null,
          source: forward.source,
          state: forward.state,
          ...(process ? { process } : {}),
          ...(command ? { command } : {}),
          ...(forward.error ? { error: forward.error } : {}),
        };
      });
    const available = [...(state.listening?.values() ?? [])].filter(
      (entry) => !state.forwards.has(entry.port) && listeningPortOffered(entry, context),
    );
    return { hostId, connected: state.connected, forwards, available, listing: state.listing };
  }

  /** Forward a port by hand. Waits for the connection when it is not open. */
  async forwardForWorkspace(workspaceId: string, remotePort: number): Promise<PortsSnapshot> {
    const state = this.requireHost(workspaceId);
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
      throw new Error("Enter a port number from 1 to 65535.");
    }
    state.dismissed.delete(remotePort);
    const existing = state.forwards.get(remotePort);
    if (existing) {
      existing.source = "manual";
      if (existing.state === "failed" && state.connected) await this.bind(state, existing);
    } else {
      await this.addForward(state, remotePort, { source: "manual" });
    }
    this.emitChanged(state);
    return this.snapshot(state.hostId)!;
  }

  async stopForWorkspace(workspaceId: string, remotePort: number): Promise<PortsSnapshot> {
    const state = this.requireHost(workspaceId);
    const forward = state.forwards.get(remotePort);
    if (forward) {
      this.closeListener(forward);
      state.forwards.delete(remotePort);
      state.missing.delete(remotePort);
      state.dismissed.add(remotePort);
    }
    this.emitChanged(state);
    return this.snapshot(state.hostId)!;
  }

  /**
   * What codara_preview_navigate opens for a loopback URL in a remote
   * workspace: the forward's local URL, forwarding the port first when the
   * host answers on it. Null for a local workspace.
   */
  async resolvePreviewUrl(workspaceId: string, rawUrl: string): Promise<RemotePreviewUrl | null> {
    const hostId = this.hostOfWorkspace(workspaceId);
    if (!hostId) return null;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") return null;
    const remotePort = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    const state = this.hosts.get(hostId);
    if (!state?.connected) {
      return {
        error: `The SSH connection to ${hostId} is not open, so localhost:${remotePort} on it cannot be reached. Open a terminal or a file of the workspace to connect, then try again.`,
      };
    }
    let forward = state.forwards.get(remotePort);
    if (forward?.state !== "active") {
      const remoteHost = forward?.remoteHost ?? this.targetFor(state, remotePort, hostname);
      if (!(await this.probe(state, remoteHost, remotePort))) {
        return {
          error: `Nothing is listening on port ${remotePort} on ${hostId} yet. Start the server in a terminal of the workspace (codara_terminal_create), then navigate again.`,
        };
      }
      state.dismissed.delete(remotePort);
      if (forward) await this.bind(state, forward);
      else forward = await this.addForward(state, remotePort, { source: "agent", remoteHost });
      this.emitChanged(state);
    }
    if (forward.state !== "active" || !forward.localPort) {
      return { error: forward.error ?? `Port ${remotePort} on ${hostId} could not be forwarded.` };
    }
    url.port = String(forward.localPort);
    if (hostname === "::1") url.hostname = "localhost";
    return { url: url.toString() };
  }

  /** Runs one listening-port poll now (tests, and the first poll after connecting). */
  async pollHost(hostId: string): Promise<void> {
    const state = this.hosts.get(hostId);
    if (!state || !this.isActive(state) || state.polling) return;
    state.polling = true;
    try {
      const result = await this.deps.exec(hostId, "sh -s", {
        stdin: REMOTE_LISTEN_SCRIPT,
        timeoutMs: this.execTimeoutMs,
      });
      if (this.hosts.get(hostId) !== state || !this.isActive(state)) return;
      await this.applyListing(state, parseListeningPorts(result.stdout));
    } catch {
      // A failed poll (channel limit, connection closing) waits for the next.
    } finally {
      state.polling = false;
    }
  }

  /** Watches new remote terminal panes and lets go of closed ones. */
  syncPanes(): void {
    if (this.disposed) return;
    const live = new Set<string>();
    for (const pane of this.deps.panes()) {
      const hostId = parseRemotePath(pane.cwd)?.hostId;
      const state = hostId ? this.hosts.get(hostId) : undefined;
      if (!hostId || !state || !this.isActive(state)) continue;
      live.add(pane.paneId);
      if (this.panes.has(pane.paneId)) continue;
      const watched: WatchedPane = { hostId, scanner: new TerminalPortScanner(), off: () => undefined };
      this.panes.set(pane.paneId, watched);
      watched.off = this.deps.tapPane(pane.paneId, (text) => this.onPaneText(watched, text));
      const recent = this.deps.recentPaneOutput(pane.paneId).slice(-RECENT_OUTPUT_BYTES);
      if (recent) this.onPaneText(watched, recent);
    }
    for (const [paneId, watched] of this.panes) {
      if (live.has(paneId)) continue;
      watched.off();
      this.panes.delete(paneId);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.paneTimer) clearInterval(this.paneTimer);
    this.paneTimer = null;
    for (const watched of this.panes.values()) watched.off();
    this.panes.clear();
    for (const state of this.hosts.values()) this.closeHost(state);
    this.hosts.clear();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private newHost(hostId: string, workspaces: number): HostState {
    return {
      hostId,
      workspaces,
      connected: false,
      sshPort: null,
      forwards: new Map(),
      listening: null,
      listing: "pending",
      baseline: null,
      missing: new Map(),
      dismissed: new Set(),
      notified: new Set(),
      probing: new Set(),
      commands: new Map(),
      pollTimer: null,
      polling: false,
      lastSignature: "",
    };
  }

  private requireHost(workspaceId: string): HostState {
    const hostId = this.hostOfWorkspace(workspaceId);
    const state = hostId ? this.hosts.get(hostId) : undefined;
    if (!state) throw new Error("This workspace is not on an SSH host.");
    return state;
  }

  private isActive(state: HostState): boolean {
    return !this.disposed && state.connected && state.workspaces > 0 && this.hosts.get(state.hostId) === state;
  }

  private async activate(state: HostState): Promise<void> {
    state.connected = true;
    state.listing = "pending";
    state.baseline = null;
    state.sshPort = await this.deps.sshPort(state.hostId).catch(() => null);
    if (!this.isActive(state)) return;
    for (const forward of state.forwards.values()) {
      if (forward.state !== "active") await this.bind(state, forward);
    }
    if (!this.isActive(state)) return;
    this.stopPolling(state);
    state.pollTimer = setInterval(() => void this.pollHost(state.hostId), this.pollMs);
    state.pollTimer.unref?.();
    this.updatePaneTimer();
    this.syncPanes();
    this.emitChanged(state);
    await this.pollHost(state.hostId);
  }

  private stopPolling(state: HostState): void {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  private closeHost(state: HostState): void {
    this.stopPolling(state);
    for (const forward of state.forwards.values()) this.closeListener(forward);
    state.forwards.clear();
    state.connected = false;
    this.releasePanes(state.hostId);
    this.deps.changed(state.hostId);
  }

  private releasePanes(hostId: string): void {
    for (const [paneId, watched] of this.panes) {
      if (watched.hostId !== hostId) continue;
      watched.off();
      this.panes.delete(paneId);
    }
  }

  private updatePaneTimer(): void {
    const wanted = !this.disposed && [...this.hosts.values()].some((state) => this.isActive(state));
    if (wanted && !this.paneTimer) {
      this.paneTimer = setInterval(() => this.syncPanes(), this.paneSyncMs);
      this.paneTimer.unref?.();
    } else if (!wanted && this.paneTimer) {
      clearInterval(this.paneTimer);
      this.paneTimer = null;
      for (const watched of this.panes.values()) watched.off();
      this.panes.clear();
    }
  }

  private emitChanged(state: HostState): void {
    const signature = JSON.stringify(this.snapshot(state.hostId));
    if (signature === state.lastSignature) return;
    state.lastSignature = signature;
    this.deps.changed(state.hostId);
  }

  private targetFor(state: HostState, remotePort: number, printedHost?: string): string {
    return forwardTargetHost(state.listening?.get(remotePort)?.addresses ?? [], printedHost);
  }

  private reservedLocalPorts(except: Forward): Set<number> {
    const reserved = new Set<number>();
    for (const state of this.hosts.values()) {
      for (const forward of state.forwards.values()) {
        if (forward !== except && forward.localPort) reserved.add(forward.localPort);
      }
    }
    return reserved;
  }

  private async addForward(
    state: HostState,
    remotePort: number,
    options: { source: PortForwardSource; remoteHost?: string; scheme?: "http" | "https"; path?: string; notify?: boolean },
  ): Promise<Forward> {
    const existing = state.forwards.get(remotePort);
    if (existing) return existing;
    const forward: Forward = {
      remotePort,
      remoteHost: options.remoteHost ?? this.targetFor(state, remotePort),
      scheme: options.scheme ?? "http",
      path: options.path ?? "/",
      source: options.source,
      state: "waiting",
      localPort: null,
      preferredLocalPort: null,
      server: null,
      sockets: new Set(),
      binding: null,
    };
    state.forwards.set(remotePort, forward);
    if (state.connected) await this.bind(state, forward);
    if (state.listening?.get(remotePort)?.pid) {
      void this.describeProcesses(state).then(() => this.emitChanged(state));
    }
    if (options.notify && forward.state === "active" && forward.localPort && !state.notified.has(remotePort)) {
      state.notified.add(remotePort);
      this.deps.notice({
        hostId: state.hostId,
        remotePort,
        localPort: forward.localPort,
        url: localForwardUrl(forward.scheme, forward.localPort, forward.path),
      });
    }
    return forward;
  }

  private bind(state: HostState, forward: Forward): Promise<void> {
    if (forward.binding) return forward.binding;
    const binding = this.bindNow(state, forward).finally(() => {
      if (forward.binding === binding) forward.binding = null;
    });
    forward.binding = binding;
    return binding;
  }

  private async bindNow(state: HostState, forward: Forward): Promise<void> {
    const candidates = candidateLocalPorts(forward.remotePort, {
      preferred: forward.preferredLocalPort,
      reserved: this.reservedLocalPorts(forward),
    });
    const bound = await bindFirstFree(candidates, async (port) => {
      if (port !== 0 && (await this.deps.localPortServedElsewhere?.(port).catch(() => false))) return null;
      return listenLoopback(port, (socket) => this.accept(state, forward, socket));
    });
    // Closed, stopped or disconnected while binding: this server is nobody's.
    if (!this.isActive(state) || state.forwards.get(forward.remotePort) !== forward) {
      bound?.value.close();
      return;
    }
    if (!bound) {
      forward.state = "failed";
      forward.error = `No local port is free for port ${forward.remotePort}.`;
      return;
    }
    const address = bound.value.address();
    forward.server = bound.value;
    forward.localPort = typeof address === "object" && address ? address.port : bound.port;
    forward.preferredLocalPort = forward.localPort;
    forward.state = "active";
    delete forward.error;
  }

  private accept(state: HostState, forward: Forward, socket: Socket): void {
    forward.sockets.add(socket);
    socket.once("close", () => forward.sockets.delete(socket));
    socket.on("error", () => undefined);
    if (!this.isActive(state) || forward.server === null || !this.deps.isConnected(state.hostId)) {
      socket.destroy();
      return;
    }
    this.deps
      .openChannel(state.hostId, forward.remoteHost, forward.remotePort, {
        address: socket.remoteAddress ?? "127.0.0.1",
        port: socket.remotePort ?? 0,
      })
      .then((channel) => {
        if (socket.destroyed || forward.server === null) {
          closeQuietly(channel);
          socket.destroy();
          return;
        }
        bridge(socket, channel);
      })
      .catch(() => socket.destroy());
  }

  private closeListener(forward: Forward): void {
    const server = forward.server;
    forward.server = null;
    server?.close();
    for (const socket of forward.sockets) socket.destroy();
    forward.sockets.clear();
  }

  /** Does the host answer on this port? Opens one channel and closes it. */
  private async probe(state: HostState, remoteHost: string, remotePort: number): Promise<boolean> {
    for (const delay of this.probeDelaysMs) {
      if (delay > 0) await sleep(delay);
      if (!this.isActive(state)) return false;
      try {
        const channel = await this.deps.openChannel(state.hostId, remoteHost, remotePort, {
          address: "127.0.0.1",
          port: 0,
        });
        closeQuietly(channel);
        return true;
      } catch {
        // Not listening yet.
      }
    }
    return false;
  }

  private onPaneText(watched: WatchedPane, text: string): void {
    const urls = watched.scanner.push(text);
    if (urls.length === 0) return;
    const state = this.hosts.get(watched.hostId);
    if (!state || !this.isActive(state)) return;
    for (const url of urls) void this.forwardPrinted(state, url);
  }

  private async forwardPrinted(state: HostState, printed: TerminalPortUrl): Promise<void> {
    const port = printed.port;
    if (!terminalPortAllowed(port, { sshPort: state.sshPort })) return;
    if (state.forwards.has(port) || state.dismissed.has(port) || state.probing.has(port)) return;
    state.probing.add(port);
    try {
      const remoteHost = this.targetFor(state, port, printed.host);
      // Replayed history can name a server that has since stopped.
      if (!(await this.probe(state, remoteHost, port))) return;
      if (!this.isActive(state) || state.forwards.has(port) || state.dismissed.has(port)) return;
      await this.addForward(state, port, {
        source: "terminal",
        remoteHost,
        scheme: printed.scheme,
        path: printed.path,
        notify: true,
      });
      this.emitChanged(state);
    } finally {
      state.probing.delete(port);
    }
  }

  private async applyListing(
    state: HostState,
    parsed: ReturnType<typeof parseListeningPorts>,
  ): Promise<void> {
    state.listing = parsed.listing;
    if (parsed.listing === "none") {
      // No tool to ask: terminal output is the only source for this connection.
      this.stopPolling(state);
      state.listening = null;
      this.emitChanged(state);
      return;
    }
    const ports = new Map(parsed.ports.map((entry) => [entry.port, entry]));
    state.listening = ports;
    const first = state.baseline === null;
    if (first) state.baseline = new Set(ports.keys());
    const context = { sshPort: state.sshPort };
    for (const port of [...(state.baseline ?? [])]) if (!ports.has(port)) state.baseline?.delete(port);
    for (const port of [...state.dismissed]) if (!ports.has(port)) state.dismissed.delete(port);

    for (const forward of [...state.forwards.values()]) {
      if (ports.has(forward.remotePort)) {
        state.missing.delete(forward.remotePort);
        continue;
      }
      if (forward.source === "manual" || forward.state !== "active") continue;
      const misses = (state.missing.get(forward.remotePort) ?? 0) + 1;
      if (misses < this.goneAfterPolls) {
        state.missing.set(forward.remotePort, misses);
        continue;
      }
      // The server stopped: its automatic forward goes, and a later start is news again.
      this.closeListener(forward);
      state.forwards.delete(forward.remotePort);
      state.missing.delete(forward.remotePort);
      state.notified.delete(forward.remotePort);
    }

    if (!first) {
      for (const entry of ports.values()) {
        if (state.forwards.has(entry.port) || state.baseline?.has(entry.port)) continue;
        if (state.dismissed.has(entry.port) || state.probing.has(entry.port)) continue;
        if (!listeningPortAutoForwards(entry, context)) continue;
        await this.addForward(state, entry.port, {
          source: "listening",
          remoteHost: forwardTargetHost(entry.addresses),
          notify: true,
        });
        if (!this.isActive(state)) return;
      }
    }
    await this.describeProcesses(state);
    this.emitChanged(state);
  }

  // The listing names "node" for most dev servers; the command line says which.
  private async describeProcesses(state: HostState): Promise<void> {
    for (const forward of state.forwards.values()) {
      const pid = state.listening?.get(forward.remotePort)?.pid;
      if (!pid || state.commands.has(pid)) continue;
      state.commands.set(pid, "");
      try {
        const result = await this.deps.exec(state.hostId, `ps -o args= -p ${pid}`, { timeoutMs: this.execTimeoutMs });
        const command = result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
        if (command) state.commands.set(pid, command.slice(0, COMMAND_CHARS));
      } catch {
        // Unknown stays unknown.
      }
      if (!this.isActive(state)) return;
    }
  }
}
