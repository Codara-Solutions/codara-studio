import { buildRemoteAgentAttach, buildRemoteAgentKill, buildRemoteAgentProbe } from "./remote-agents";
import { shQuote } from "./connections";

// The terminal of a remote pane: a shell channel on the host's SSH
// connection. A plain shell ends with its channel. An agent pane (Machines,
// remote-agents.ts) outlives the channel: when the connection drops, the
// pane stays open, says so, reconnects with backoff and attaches to the same
// tmux session, so the agent that kept working on the machine is back on
// screen without a second start. The pane ends only when its shell exits,
// the agent's session is gone, the user disconnects the host, or Studio
// kills it.

export interface RemoteShellChannel {
  write(data: string): unknown;
  setWindow(rows: number, cols: number, height: number, width: number): unknown;
  close(): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  stderr: {
    on(event: string, listener: (...args: any[]) => void): unknown;
    off(event: string, listener: (...args: any[]) => void): unknown;
  };
}

export interface RemoteShellConnection {
  shell(opts: { cols: number; rows: number }): Promise<RemoteShellChannel>;
  exec(command: string, opts?: { timeoutMs?: number }): Promise<{ code: number | null }>;
  /** True once the user disconnected the host or Studio is quitting. */
  readonly isDisposed: boolean;
}

export interface RemotePtyHandle {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export interface RemotePtyInput {
  conn: RemoteShellConnection;
  channel: RemoteShellChannel;
  paneId: string;
  hostLabel: string;
  /** POSIX folder on the host, for the shell a reattach opens. */
  cwd: string;
  cols: number;
  rows: number;
  /** The pane runs (or attached to) an agent session that outlives the channel. */
  agentPane: boolean;
  /** Read once, at kill: whether the user closed the pane, so its agent ends too. */
  endAgentOnKill: () => boolean;
  log?: (message: string) => void;
  /** Waits between reconnect attempts; the last one repeats. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000];

function dim(text: string): string {
  return `\r\n\x1b[2m[${text}]\x1b[0m\r\n`;
}

export function createRemotePtyHandle(input: RemotePtyInput): RemotePtyHandle {
  const { conn, paneId, hostLabel } = input;
  const delays = input.retryDelaysMs?.length ? input.retryDelaysMs : RETRY_DELAYS_MS;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(e: { exitCode: number; signal?: number }) => void>();
  let channel: RemoteShellChannel | null = input.channel;
  let cols = input.cols;
  let rows = input.rows;
  let killed = false;
  let ended = false;

  const emit = (data: string | Buffer) => {
    for (const listener of dataListeners) listener(data as unknown as string);
  };

  const finish = (exitCode: number) => {
    if (ended) return;
    ended = true;
    channel = null;
    for (const listener of exitListeners) listener({ exitCode });
  };

  const bind = (ch: RemoteShellChannel) => {
    let exitCode: number | null = null;
    ch.on("data", emit);
    ch.stderr.on("data", emit);
    // ssh2 reports the remote shell's exit status before the close; a
    // dropped connection closes the channel without one.
    ch.on("exit", (code: unknown) => {
      exitCode = typeof code === "number" ? code : 0;
    });
    ch.on("close", () => {
      if (ch !== channel || ended) return;
      if (killed || exitCode !== null || !input.agentPane || conn.isDisposed) {
        finish(exitCode ?? 0);
        return;
      }
      channel = null;
      void reconnect();
    });
  };

  const reconnect = async () => {
    emit(dim(`lost the connection to ${hostLabel}; the agent keeps running there. Reconnecting…`));
    for (let attempt = 0; !ended && !killed; attempt += 1) {
      if (conn.isDisposed) {
        emit(dim(`disconnected from ${hostLabel}; the agent keeps running there`));
        finish(0);
        return;
      }
      try {
        const probe = await conn.exec(buildRemoteAgentProbe(paneId), { timeoutMs: 15_000 });
        if (ended || killed) return;
        if (probe.code !== 0) {
          emit(dim(`the agent on ${hostLabel} has ended`));
          finish(0);
          return;
        }
        const next = await conn.shell({ cols, rows });
        if (ended || killed) {
          next.close();
          return;
        }
        channel = next;
        bind(next);
        next.write(`cd ${shQuote(input.cwd)} && export SPARK_TERMINAL=1 SPARK_REMOTE=1 && clear && ${buildRemoteAgentAttach(paneId)}\n`);
        input.log?.(`reattached pane ${paneId} on ${hostLabel} after ${attempt + 1} attempt(s)`);
        return;
      } catch (err) {
        input.log?.(`reconnect of pane ${paneId} to ${hostLabel} failed: ${String(err)}`);
      }
      await sleep(delays[Math.min(attempt, delays.length - 1)]);
    }
  };

  bind(input.channel);

  return {
    pid: 0,
    write(data) {
      try {
        channel?.write(data);
      } catch {
        /* channel already closed */
      }
    },
    resize(c, r) {
      cols = c;
      rows = r;
      try {
        // ssh2 order is (rows, cols, heightPx, widthPx).
        channel?.setWindow(r, c, 0, 0);
      } catch {
        /* ignore */
      }
    },
    kill() {
      killed = true;
      if (input.endAgentOnKill() && input.agentPane && !conn.isDisposed) {
        void conn.exec(buildRemoteAgentKill(paneId), { timeoutMs: 10_000 }).catch((err: unknown) => {
          input.log?.(`could not end the agent session of ${paneId} on ${hostLabel}: ${String(err)}`);
        });
      }
      const current = channel;
      if (!current) {
        // Between channels while reconnecting: nothing will close.
        finish(0);
        return;
      }
      try {
        current.close();
      } catch {
        finish(0);
      }
    },
    onData(cb) {
      dataListeners.add(cb);
      return { dispose: () => dataListeners.delete(cb) };
    },
    onExit(cb) {
      exitListeners.add(cb);
      return { dispose: () => exitListeners.delete(cb) };
    },
  };
}
