import { createHash, randomUUID } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Client, ClientChannel, ConnectConfig, SFTPWrapper } from "ssh2";
import type {
  RemoteAuthPromptAnswer,
  RemoteAuthPromptRequest,
  RemoteConnectionStatus,
  RemoteHostConfig,
} from "@shared/remote";
import { writeFileAtomic } from "../fs-atomic";
import { codaraHome } from "../codara-home";
import { getHost } from "./ssh-hosts";
import { deleteSecret, getSecret, setSecret } from "./secret-store";

// One multiplexed SSH connection per host, shared by every consumer (SFTP
// file ops, git/search exec channels, terminal shell channels). Connections
// are created lazily on first use, kept alive with protocol keepalives, and
// re-established on the next demand after a drop. Auth ladder per connect:
// configured/default private keys (passphrase prompt when encrypted) → SSH
// agent when present → stored password → interactive password prompt (with
// opt-in remember via safeStorage).

// ssh2 costs ~45 ms of require time (protocol tables, key parsers, crypto
// bindings) and is only needed once a remote workspace is actually opened —
// but this module is in the eager main-process graph because quit calls
// disposeAllConnections(). So the module is pulled in on demand, at the two
// points that need it as a *value* (new Client, utils.parseKey); everything
// else here is `import type`, which costs nothing at runtime.
// disposeAllConnections() stays synchronous and never touches this: with no
// connections in the map there is nothing to dispose, and a connection can
// only exist if ssh2 was already loaded to create it.
//
// Interop: ssh2 is CommonJS and Node's named-export detection does not see
// its `utils` export, so we unwrap the namespace's `default` (the real
// module.exports) when the loader gives us one, and fall back to the
// namespace itself if a bundler compiled the import down to a require.
type Ssh2Module = typeof import("ssh2");

let ssh2Promise: Promise<Ssh2Module> | null = null;

function loadSsh2(): Promise<Ssh2Module> {
  if (!ssh2Promise) {
    ssh2Promise = import("ssh2")
      .then((mod) => (mod as { default?: Ssh2Module }).default ?? mod)
      .catch((err: unknown) => {
        // Don't cache a failed load — a later connect attempt should retry.
        ssh2Promise = null;
        throw err;
      });
  }
  return ssh2Promise;
}

const READY_TIMEOUT_MS = 20_000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 3;
const DEFAULT_EXEC_TIMEOUT_MS = 20_000;
const DEFAULT_EXEC_MAX_BUFFER = 16 * 1024 * 1024;

class ConnectionAttemptCancelledError extends Error {
  constructor() {
    super("SSH connection attempt was cancelled or superseded.");
    this.name = "ConnectionAttemptCancelledError";
  }
}

const swallowUnownedClientError = () => undefined;

export interface ExecOptions {
  stdin?: string | Buffer;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

// ── Auth prompt bridge (renderer modal) ──────────────────────────────────────

type PromptSender = (request: RemoteAuthPromptRequest) => void;
let promptSender: PromptSender | null = null;
const pendingPrompts = new Map<
  string,
  { resolve: (answer: RemoteAuthPromptAnswer) => void }
>();

export function setAuthPromptSender(sender: PromptSender | null): void {
  promptSender = sender;
}

export function answerAuthPrompt(answer: RemoteAuthPromptAnswer): void {
  const pending = pendingPrompts.get(answer.requestId);
  if (!pending) return;
  pending.resolve(answer);
}

async function promptAuth(
  hostId: string,
  kind: "password" | "passphrase",
  message: string,
  signal: AbortSignal,
): Promise<RemoteAuthPromptAnswer> {
  if (!promptSender || signal.aborted) {
    return { requestId: "", value: null, remember: false };
  }
  const requestId = randomUUID();
  const request: RemoteAuthPromptRequest = {
    requestId,
    hostId,
    kind,
    message,
    canRemember: true,
  };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer: RemoteAuthPromptAnswer) => {
      if (settled) return;
      settled = true;
      pendingPrompts.delete(requestId);
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(answer);
    };
    const onAbort = () => {
      finish({ requestId, value: null, remember: false });
    };
    // 5 minutes: a modal left unanswered should not leak the pending map
    // entry (or hang a connect forever) if the window closed meanwhile.
    const timer = setTimeout(() => {
      finish({ requestId, value: null, remember: false });
    }, 5 * 60_000);
    pendingPrompts.set(requestId, { resolve: finish });
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      promptSender?.(request);
    } catch {
      finish({ requestId, value: null, remember: false });
    }
  });
}

// ── Known hosts (trust-on-first-use) ─────────────────────────────────────────

const KNOWN_HOSTS_FILE = "spark-known-hosts.json";

async function readKnownHosts(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(join(codaraHome(), KNOWN_HOSTS_FILE), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function rememberHostKey(key: string, fingerprint: string): Promise<void> {
  const all = await readKnownHosts();
  all[key] = fingerprint;
  await writeFileAtomic(join(codaraHome(), KNOWN_HOSTS_FILE), JSON.stringify(all, null, 2)).catch(
    () => undefined,
  );
}

// ── Status broadcast ─────────────────────────────────────────────────────────

type StatusSender = (status: RemoteConnectionStatus) => void;
let statusSender: StatusSender | null = null;

export function setStatusSender(sender: StatusSender | null): void {
  statusSender = sender;
}

// ── Connection ───────────────────────────────────────────────────────────────

class RemoteConnection {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private connectingAbort: AbortController | null = null;
  private generation = 0;
  private disposed = false;
  private sftpCached: Promise<SFTPWrapper> | null = null;
  state: RemoteConnectionStatus["state"] = "disconnected";
  lastError: string | null = null;

  constructor(public readonly host: RemoteHostConfig) {}

  private setState(state: RemoteConnectionStatus["state"], error?: string): void {
    this.state = state;
    this.lastError = error ?? null;
    statusSender?.({ hostId: this.host.id, state, ...(error ? { error } : {}) });
  }

  async ensure(): Promise<Client> {
    if (this.client) return this.client;
    if (this.disposed) throw new ConnectionAttemptCancelledError();
    if (this.connecting) return this.connecting;
    const generation = ++this.generation;
    const controller = new AbortController();
    const connecting = this.connect(generation, controller.signal).finally(() => {
      if (this.connecting === connecting) {
        this.connecting = null;
        this.connectingAbort = null;
      }
    });
    this.connecting = connecting;
    this.connectingAbort = controller;
    return connecting;
  }

  private isCurrent(generation: number, signal: AbortSignal): boolean {
    return !this.disposed && !signal.aborted && this.generation === generation;
  }

  private assertCurrent(generation: number, signal: AbortSignal): void {
    if (!this.isCurrent(generation, signal)) throw new ConnectionAttemptCancelledError();
  }

  private async connect(generation: number, signal: AbortSignal): Promise<Client> {
    const host = this.host;
    this.assertCurrent(generation, signal);
    this.setState("connecting");
    const { utils: sshUtils } = await loadSsh2();
    this.assertCurrent(generation, signal);

    // Gather private keys up front (passphrase prompts must complete before
    // the TCP handshake starts consuming auth attempts).
    const keys: Buffer[] = [];
    const keyCandidates = host.identityFile
      ? [host.identityFile]
      : [join(homedir(), ".ssh", "id_ed25519"), join(homedir(), ".ssh", "id_rsa")];
    for (const candidate of keyCandidates) {
      try {
        const raw = await fs.readFile(candidate);
        this.assertCurrent(generation, signal);
        const parsed = sshUtils.parseKey(raw);
        if (parsed instanceof Error) {
          if (/passphrase/i.test(parsed.message)) {
            const secretKey = `passphrase:${host.id}:${candidate}`;
            let passphrase = await getSecret(secretKey);
            this.assertCurrent(generation, signal);
            let fromPrompt = false;
            if (passphrase === null) {
              const answer = await promptAuth(
                host.id,
                "passphrase",
                `Passphrase for key ${candidate}`,
                signal,
              );
              this.assertCurrent(generation, signal);
              passphrase = answer.value;
              fromPrompt = answer.value !== null && answer.remember;
              if (answer.value !== null && answer.remember) {
                void setSecret(secretKey, answer.value);
              }
            }
            if (passphrase !== null) {
              const unlocked = sshUtils.parseKey(raw, passphrase);
              if (!(unlocked instanceof Error)) {
                keys.push(raw);
                // Stash the passphrase for the connect config below by
                // pairing key+passphrase; ssh2 takes one passphrase per
                // privateKey config, so we record it alongside.
                this.keyPassphrases.set(raw, passphrase);
              } else if (fromPrompt) {
                void deleteSecret(secretKey);
              }
            }
          }
        } else {
          keys.push(raw);
        }
      } catch {
        this.assertCurrent(generation, signal);
        // Missing candidate key — fine, ladder continues.
      }
    }

    const agent =
      process.env.SSH_AUTH_SOCK ??
      (process.platform === "win32" && existsSync("\\\\.\\pipe\\openssh-ssh-agent")
        ? "\\\\.\\pipe\\openssh-ssh-agent"
        : undefined);

    const storedPassword = await getSecret(`password:${host.id}`);
    this.assertCurrent(generation, signal);

    // Build the ordered auth attempts. Each entry yields a ConnectConfig
    // fragment; we try them in sequence over fresh TCP connections (simpler
    // and more debuggable than a single authHandler state machine, and
    // connects are rare).
    const attempts: Array<{ label: string; cfg: Partial<ConnectConfig> }> = [];
    for (const key of keys) {
      attempts.push({
        label: "key",
        cfg: {
          privateKey: key,
          ...(this.keyPassphrases.has(key) ? { passphrase: this.keyPassphrases.get(key) } : {}),
        },
      });
    }
    if (agent) attempts.push({ label: "agent", cfg: { agent } });
    if (storedPassword !== null) {
      attempts.push({ label: "stored-password", cfg: { password: storedPassword } });
    }

    let lastErr: Error | null = null;
    for (const attempt of attempts) {
      try {
        const client = await this.tryConnect(attempt.cfg, generation, signal);
        this.adopt(client, generation, signal);
        return client;
      } catch (err) {
        if (err instanceof ConnectionAttemptCancelledError) throw err;
        lastErr = err as Error;
        if (!isAuthFailure(lastErr)) break; // network/hostkey errors: stop the ladder
      }
    }

    // Interactive password prompts (up to 3 tries), unless a non-auth error
    // already killed the ladder.
    if (lastErr === null || isAuthFailure(lastErr)) {
      for (let i = 0; i < 3; i++) {
        const answer = await promptAuth(
          this.host.id,
          "password",
          `Password for ${host.username}@${host.host}`,
          signal,
        );
        this.assertCurrent(generation, signal);
        if (answer.value === null) {
          lastErr = new Error("Authentication cancelled.");
          break;
        }
        try {
          const client = await this.tryConnect(
            {
              password: answer.value,
              tryKeyboard: true,
            },
            generation,
            signal,
          );
          if (answer.remember) void setSecret(`password:${host.id}`, answer.value);
          this.adopt(client, generation, signal);
          return client;
        } catch (err) {
          if (err instanceof ConnectionAttemptCancelledError) throw err;
          lastErr = err as Error;
          if (!isAuthFailure(lastErr)) break;
        }
      }
    }

    const message = lastErr?.message ?? "Unable to authenticate.";
    this.assertCurrent(generation, signal);
    this.setState("error", message);
    throw new Error(`SSH connection to ${host.id} failed: ${message}`);
  }

  private keyPassphrases = new Map<Buffer, string>();

  private async tryConnect(
    auth: Partial<ConnectConfig>,
    generation: number,
    signal: AbortSignal,
  ): Promise<Client> {
    const host = this.host;
    const { Client } = await loadSsh2();
    this.assertCurrent(generation, signal);
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        client.removeListener("ready", onReady);
        client.removeListener("error", onError);
        client.removeListener("close", onClose);
        client.removeListener("end", onEnd);
        client.removeListener("keyboard-interactive", onKeyboardInteractive);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const onReady = () => {
        if (!this.isCurrent(generation, signal)) {
          fail(new ConnectionAttemptCancelledError());
          disposeClient(client);
          return;
        }
        // Promise continuations run on the next microtask. Keep an inert
        // listener through that ready→adopt handoff so a transport error in
        // the gap cannot become an uncaught EventEmitter "error".
        client.on("error", swallowUnownedClientError);
        settled = true;
        cleanup();
        resolve(client);
      };
      const onError = (err: Error) => {
        fail(err);
      };
      const onClose = () => {
        fail(new Error(`SSH connection to ${host.id} closed before it was ready.`));
      };
      const onEnd = () => {
        fail(new Error(`SSH connection to ${host.id} ended before it was ready.`));
      };
      // Password auth servers sometimes only offer keyboard-interactive;
      // answer its prompts with the password we were given.
      const onKeyboardInteractive = (
        _name: string,
        _instr: string,
        _lang: string,
        prompts: unknown[],
        finish: (answers: string[]) => void,
      ) => {
        const pw = typeof auth.password === "string" ? auth.password : "";
        finish(prompts.map(() => pw));
      };
      const onAbort = () => {
        fail(new ConnectionAttemptCancelledError());
        disposeClient(client);
      };
      client.on("ready", onReady);
      client.on("error", onError);
      client.on("close", onClose);
      client.on("end", onEnd);
      client.on("keyboard-interactive", onKeyboardInteractive);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        client.connect({
          host: host.host,
          port: host.port,
          username: host.username,
          readyTimeout: READY_TIMEOUT_MS,
          keepaliveInterval: KEEPALIVE_INTERVAL_MS,
          keepaliveCountMax: KEEPALIVE_COUNT_MAX,
          tryKeyboard: typeof auth.password === "string",
          hostVerifier: (key: Buffer, verified: (ok: boolean) => void) => {
            void this.verifyHostKey(key, generation, signal).then(verified);
          },
          ...auth,
        });
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
        disposeClient(client);
      }
    });
  }

  private async verifyHostKey(
    key: Buffer,
    generation: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    // Trust-on-first-use: remember the key's fingerprint per host:port and
    // refuse silently-changed keys (the workspace row shows the error).
    const id = `${this.host.host}:${this.host.port}`;
    const fingerprint = createHash("sha256").update(key).digest("base64");
    const known = await readKnownHosts();
    if (!this.isCurrent(generation, signal)) return false;
    const prior = known[id];
    if (!prior) {
      await rememberHostKey(id, fingerprint);
      return true;
    }
    if (prior === fingerprint) return true;
    this.setState(
      "error",
      `Host key for ${id} changed (possible MITM). Remove it from spark-known-hosts.json to trust the new key.`,
    );
    return false;
  }

  private adopt(client: Client, generation: number, signal: AbortSignal): void {
    if (!this.isCurrent(generation, signal)) {
      disposeClient(client);
      throw new ConnectionAttemptCancelledError();
    }
    this.client = client;
    this.sftpCached = null;
    this.setState("connected");
    const drop = () => {
      if (this.client === client) {
        this.client = null;
        this.sftpCached = null;
        if (this.state !== "error") this.setState("disconnected");
      }
    };
    client.on("close", drop);
    client.on("end", drop);
    client.on("error", (err) => {
      if (this.client === client) this.setState("error", err.message);
      drop();
    });
    // The owned lifecycle listeners above are now installed atomically from
    // the EventEmitter's point of view; the handoff guard is no longer needed.
    client.removeListener("error", swallowUnownedClientError);
  }

  async sftp(): Promise<SFTPWrapper> {
    const client = await this.ensure();
    if (!this.sftpCached) {
      this.sftpCached = new Promise((resolve, reject) => {
        client.sftp((err, sftp) => {
          if (err) {
            this.sftpCached = null;
            reject(err);
          } else {
            sftp.on("close", () => {
              this.sftpCached = null;
            });
            resolve(sftp);
          }
        });
      });
    }
    return this.sftpCached;
  }

  // Run one command on the host. `command` is a full sh command line (caller
  // is responsible for quoting; use shQuote below). Output capped, deadline
  // enforced — mirrors runGit's execFile semantics closely enough that git
  // parsers behave identically.
  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const client = await this.ensure();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const maxBuffer = opts.maxBuffer ?? DEFAULT_EXEC_MAX_BUFFER;
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outBytes = 0;
        let errBytes = 0;
        let code: number | null = null;
        let done = false;
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            stream.close();
            reject(new Error(`Remote command timed out after ${timeoutMs}ms: ${command.slice(0, 120)}`));
          }
        }, timeoutMs);
        const overflow = () => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            stream.close();
            reject(new Error("Remote command output exceeded the buffer cap."));
          }
        };
        stream.on("data", (chunk: Buffer) => {
          outBytes += chunk.length;
          if (outBytes > maxBuffer) return overflow();
          stdout.push(chunk);
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          errBytes += chunk.length;
          if (errBytes > maxBuffer) return overflow();
          stderr.push(chunk);
        });
        stream.on("exit", (exitCode: number | null) => {
          code = exitCode;
        });
        stream.on("close", () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            code,
          });
        });
        if (opts.stdin !== undefined) {
          stream.end(opts.stdin);
        } else {
          stream.end();
        }
      });
    });
  }

  // Streaming exec for long/incremental output (project-wide search). The
  // caller gets stdout line-by-line-ish (raw chunks) and an exit callback; the
  // returned cancel() closes the channel. Unlike exec(), nothing is buffered.
  async execStream(
    command: string,
    handlers: { onStdout: (chunk: string) => void; onExit: (code: number | null) => void },
  ): Promise<{ cancel: () => void }> {
    const client = await this.ensure();
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        let code: number | null = null;
        stream.on("data", (chunk: Buffer) => handlers.onStdout(chunk.toString("utf8")));
        stream.on("exit", (c: number | null) => {
          code = c;
        });
        stream.on("close", () => handlers.onExit(code));
        stream.stderr.resume(); // drain stderr so the channel can close
        resolve({ cancel: () => stream.close() });
      });
    });
  }

  /** Interactive PTY shell channel (remote terminals). */
  async shell(opts: { cols: number; rows: number; term?: string }): Promise<ClientChannel> {
    const client = await this.ensure();
    return new Promise((resolve, reject) => {
      client.shell(
        { term: opts.term ?? "xterm-256color", cols: opts.cols, rows: opts.rows },
        (err, stream) => {
          if (err) reject(err);
          else resolve(stream);
        },
      );
    });
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.connectingAbort?.abort();
    this.connectingAbort = null;
    this.connecting = null;
    const client = this.client;
    this.client = null;
    this.sftpCached = null;
    client?.end();
    this.setState("disconnected");
  }
}

// ── Manager ──────────────────────────────────────────────────────────────────

const connections = new Map<string, RemoteConnection>();
const connectionGenerations = new Map<string, number>();
let allConnectionsGeneration = 0;

export async function getConnection(hostId: string): Promise<RemoteConnection> {
  let conn = connections.get(hostId);
  if (!conn) {
    const hostGeneration = connectionGenerations.get(hostId) ?? 0;
    const allGeneration = allConnectionsGeneration;
    const host = await getHost(hostId);
    conn = connections.get(hostId);
    if (conn) return conn;
    if (
      hostGeneration !== (connectionGenerations.get(hostId) ?? 0) ||
      allGeneration !== allConnectionsGeneration
    ) {
      throw new ConnectionAttemptCancelledError();
    }
    if (!host) throw new Error(`Unknown SSH host "${hostId}".`);
    conn = new RemoteConnection(host);
    connections.set(hostId, conn);
  }
  return conn;
}

export function getConnectionStatus(hostId: string): RemoteConnectionStatus {
  const conn = connections.get(hostId);
  if (!conn) return { hostId, state: "disconnected" };
  return {
    hostId,
    state: conn.state,
    ...(conn.lastError ? { error: conn.lastError } : {}),
  };
}

export function disconnectHost(hostId: string): void {
  connectionGenerations.set(hostId, (connectionGenerations.get(hostId) ?? 0) + 1);
  connections.get(hostId)?.dispose();
  connections.delete(hostId);
}

export function disposeAllConnections(): void {
  allConnectionsGeneration += 1;
  for (const conn of connections.values()) conn.dispose();
  connections.clear();
}

/** POSIX single-quote shell escaping for remote command lines. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isAuthFailure(err: Error): boolean {
  return /authentication|All configured authentication methods failed/i.test(err.message);
}

function disposeClient(client: Client): void {
  // ssh2 may report a final socket error after end()/destroy(). Keep one
  // inert listener on the now-unreachable client so that late transport
  // cleanup cannot become an uncaught EventEmitter "error".
  if (!client.listeners("error").includes(swallowUnownedClientError)) {
    client.on("error", swallowUnownedClientError);
  }
  try {
    client.end();
  } catch {
    // Best effort: a half-open ssh2 client may not have a socket yet.
  }
  try {
    client.destroy();
  } catch {
    // The stale resource is already unusable; cancellation must still settle.
  }
}

export type { RemoteConnection };
