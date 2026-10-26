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
//
// Reconnecting on its own is quiet: it never asks for a password or
// passphrase and never wakes a Codara box the user stopped (a paid wake).
// When the host needs the user, or the retries run out, the pane waits for a
// key the user types in it (reconnectByUser), and that round may ask. Text
// Studio writes on its own never reconnects.

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
  /** `quiet` connects only with what needs no prompt and no box wake. */
  shell(opts: { cols: number; rows: number; quiet?: boolean }): Promise<RemoteShellChannel>;
  exec(command: string, opts?: { timeoutMs?: number; quiet?: boolean }): Promise<{ code: number | null }>;
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
  /** The connection dropped and the pane waits for the user's key to reconnect. */
  waitingForKey(): boolean;
  /** The user typed a key in the pane: reconnect, asking for a password if needed. */
  reconnectByUser(): void;
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
  /**
   * The shell's own exit status for a plain shell pane. Off, the pane
   * reports 0, as remote panes did before Machines.
   */
  reportExitStatus?: boolean;
  /** Waits between reconnect attempts; the last one repeats. */
  retryDelaysMs?: readonly number[];
  /** Attempts per round before the pane waits for a key. */
  maxAttempts?: number;
  /** The channel closed before the handle existed, with this exit status. */
  closedBeforeBind?: { exitCode: number | null } | null;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000];
// About two minutes with the delays above.
const MAX_ATTEMPTS = 8;

// Kill-session commands still running, by pane: a pane opened again with the
// same id waits for them (remoteAgentKillSettled) so the kill cannot land on
// its new agent.
const pendingAgentKills = new Map<string, Promise<void>>();

export function remoteAgentKillSettled(paneId: string): Promise<void> {
  return pendingAgentKills.get(paneId) ?? Promise.resolve();
}

function needsUser(err: unknown): boolean {
  return (err as { needsUser?: unknown } | null)?.needsUser === true;
}

function dim(text: string): string {
  return `\r\n\x1b[2m[${text}]\x1b[0m\r\n`;
}

export function createRemotePtyHandle(input: RemotePtyInput): RemotePtyHandle {
  const { conn, paneId, hostLabel } = input;
  const delays = input.retryDelaysMs?.length ? input.retryDelaysMs : RETRY_DELAYS_MS;
  const maxAttempts = Math.max(1, input.maxAttempts ?? MAX_ATTEMPTS);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(e: { exitCode: number; signal?: number }) => void>();
  let channel: RemoteShellChannel | null = input.channel;
  let cols = input.cols;
  let rows = input.rows;
  let killed = false;
  let ended = false;
  let waitingForKey = false;

  const emit = (data: string | Buffer) => {
    for (const listener of dataListeners) listener(data as unknown as string);
  };

  const finish = (exitCode: number) => {
    if (ended) return;
    ended = true;
    channel = null;
    for (const listener of exitListeners) listener({ exitCode });
  };

  const bind = (ch: RemoteShellChannel, early?: { exitCode: number | null } | null) => {
    let exitCode: number | null = early?.exitCode ?? null;
    ch.on("data", emit);
    ch.stderr.on("data", emit);
    // ssh2 reports the remote shell's exit status before the close; a
    // dropped connection closes the channel without one.
    ch.on("exit", (code: unknown) => {
      exitCode = typeof code === "number" ? code : 0;
    });
    const onClose = () => {
      if (ch !== channel || ended) return;
      if (killed || exitCode !== null || !input.agentPane || conn.isDisposed) {
        // No exit status means the connection went away, not the user's
        // `exit`: -1 keeps the pane, where 0 would close it like a clean exit.
        if (exitCode === null && !killed) finish(-1);
        else finish(input.agentPane || input.reportExitStatus !== false ? (exitCode ?? 0) : 0);
        return;
      }
      channel = null;
      void reconnect(false);
    };
    ch.on("close", onClose);
    // After the caller has subscribed to the handle.
    if (early) queueMicrotask(onClose);
  };

  const waitForKey = (why: string) => {
    waitingForKey = true;
    emit(dim(`${why}; the agent keeps running there. Press any key to reconnect`));
  };

  const reconnect = async (byUser: boolean) => {
    waitingForKey = false;
    emit(
      dim(
        byUser
          ? `reconnecting to ${hostLabel}…`
          : `lost the connection to ${hostLabel}; the agent keeps running there. Reconnecting…`,
      ),
    );
    for (let attempt = 0; !ended && !killed; attempt += 1) {
      if (conn.isDisposed) {
        emit(dim(`disconnected from ${hostLabel}; the agent keeps running there`));
        finish(-1);
        return;
      }
      // Only the first attempt of a round the user started may ask.
      const quiet = !(byUser && attempt === 0);
      try {
        const probe = await conn.exec(buildRemoteAgentProbe(paneId), { timeoutMs: 15_000, quiet });
        if (ended || killed) return;
        if (probe.code !== 0) {
          emit(dim(`the agent on ${hostLabel} has ended`));
          finish(0);
          return;
        }
        const next = await conn.shell({ cols, rows, quiet });
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
        if (ended || killed) return;
        input.log?.(`reconnect of pane ${paneId} to ${hostLabel} failed: ${String(err)}`);
        if (needsUser(err)) {
          waitForKey(`${hostLabel} cannot reconnect without you`);
          return;
        }
      }
      if (attempt + 1 >= maxAttempts) {
        waitForKey(`could not reconnect to ${hostLabel}`);
        return;
      }
      await sleep(delays[Math.min(attempt, delays.length - 1)]);
    }
  };

  bind(input.channel, input.closedBeforeBind);

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
        // Quiet: a close never asks for a password or wakes a box to end the agent.
        const kill = conn
          .exec(buildRemoteAgentKill(paneId), { timeoutMs: 10_000, quiet: true })
          .then(
            () => undefined,
            (err: unknown) => {
              input.log?.(`could not end the agent session of ${paneId} on ${hostLabel}: ${String(err)}`);
            },
          )
          .finally(() => {
            if (pendingAgentKills.get(paneId) === kill) pendingAgentKills.delete(paneId);
          });
        pendingAgentKills.set(paneId, kill);
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
    waitingForKey() {
      return waitingForKey && !ended && !killed;
    },
    reconnectByUser() {
      if (waitingForKey && !ended && !killed) void reconnect(true);
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
