import { createHash, randomUUID } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Client,
  utils as sshUtils,
  type ClientChannel,
  type ConnectConfig,
  type SFTPWrapper,
} from "ssh2";
import type {
  RemoteAuthPromptAnswer,
  RemoteAuthPromptRequest,
  RemoteConnectionStatus,
  RemoteHostConfig,
} from "@shared/remote";
import { writeFileAtomic } from "../fs-atomic";
import { sparkHome } from "../spark-home";
import { getHost } from "./ssh-hosts";
import { deleteSecret, getSecret, setSecret } from "./secret-store";

// One multiplexed SSH connection per host, shared by every consumer (SFTP
// file ops, git/search exec channels, terminal shell channels). Connections
// are created lazily on first use, kept alive with protocol keepalives, and
// re-established on the next demand after a drop. Auth ladder per connect:
// configured/default private keys (passphrase prompt when encrypted) → SSH
// agent when present → stored password → interactive password prompt (with
// opt-in remember via safeStorage).

const READY_TIMEOUT_MS = 20_000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 3;
const DEFAULT_EXEC_TIMEOUT_MS = 20_000;
const DEFAULT_EXEC_MAX_BUFFER = 16 * 1024 * 1024;

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

export class RemoteExecError extends Error {
  constructor(
    message: string,
    public readonly result: ExecResult,
  ) {
    super(message);
  }
}

// ── Auth prompt bridge (renderer modal) ──────────────────────────────────────

type PromptSender = (request: RemoteAuthPromptRequest) => void;
let promptSender: PromptSender | null = null;
const pendingPrompts = new Map<
  string,
  { resolve: (answer: RemoteAuthPromptAnswer) => void; timer: ReturnType<typeof setTimeout> }
>();

export function setAuthPromptSender(sender: PromptSender | null): void {
  promptSender = sender;
}

export function answerAuthPrompt(answer: RemoteAuthPromptAnswer): void {
  const pending = pendingPrompts.get(answer.requestId);
  if (!pending) return;
  pendingPrompts.delete(answer.requestId);
  clearTimeout(pending.timer);
  pending.resolve(answer);
}

async function promptAuth(
  hostId: string,
  kind: "password" | "passphrase",
  message: string,
): Promise<RemoteAuthPromptAnswer> {
  if (!promptSender) {
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
    // 5 minutes: a modal left unanswered should not leak the pending map
    // entry (or hang a connect forever) if the window closed meanwhile.
    const timer = setTimeout(() => {
      pendingPrompts.delete(requestId);
      resolve({ requestId, value: null, remember: false });
    }, 5 * 60_000);
    pendingPrompts.set(requestId, { resolve, timer });
    promptSender?.(request);
  });
}

// ── Known hosts (trust-on-first-use) ─────────────────────────────────────────

const KNOWN_HOSTS_FILE = "spark-known-hosts.json";

async function readKnownHosts(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(join(sparkHome(), KNOWN_HOSTS_FILE), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function rememberHostKey(key: string, fingerprint: string): Promise<void> {
  const all = await readKnownHosts();
  all[key] = fingerprint;
  await writeFileAtomic(join(sparkHome(), KNOWN_HOSTS_FILE), JSON.stringify(all, null, 2)).catch(
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
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    const host = this.host;
    this.setState("connecting");

    // Gather private keys up front (passphrase prompts must complete before
    // the TCP handshake starts consuming auth attempts).
    const keys: Buffer[] = [];
    const keyCandidates = host.identityFile
      ? [host.identityFile]
      : [join(homedir(), ".ssh", "id_ed25519"), join(homedir(), ".ssh", "id_rsa")];
    for (const candidate of keyCandidates) {
      try {
        const raw = await fs.readFile(candidate);
        const parsed = sshUtils.parseKey(raw);
        if (parsed instanceof Error) {
          if (/passphrase/i.test(parsed.message)) {
            const secretKey = `passphrase:${host.id}:${candidate}`;
            let passphrase = await getSecret(secretKey);
            let fromPrompt = false;
            if (passphrase === null) {
              const answer = await promptAuth(
                host.id,
                "passphrase",
                `Passphrase for key ${candidate}`,
              );
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
        // Missing candidate key — fine, ladder continues.
      }
    }

    const agent =
      process.env.SSH_AUTH_SOCK ??
      (process.platform === "win32" && existsSync("\\\\.\\pipe\\openssh-ssh-agent")
        ? "\\\\.\\pipe\\openssh-ssh-agent"
        : undefined);

    const storedPassword = await getSecret(`password:${host.id}`);

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
        const client = await this.tryConnect(attempt.cfg);
        this.adopt(client);
        return client;
      } catch (err) {
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
        );
        if (answer.value === null) {
          lastErr = new Error("Authentication cancelled.");
          break;
        }
        try {
          const client = await this.tryConnect({
            password: answer.value,
            tryKeyboard: true,
          });
          if (answer.remember) void setSecret(`password:${host.id}`, answer.value);
          this.adopt(client);
          return client;
        } catch (err) {
          lastErr = err as Error;
          if (!isAuthFailure(lastErr)) break;
        }
      }
    }

    const message = lastErr?.message ?? "Unable to authenticate.";
    this.setState("error", message);
    throw new Error(`SSH connection to ${host.id} failed: ${message}`);
  }

  private keyPassphrases = new Map<Buffer, string>();

  private tryConnect(auth: Partial<ConnectConfig>): Promise<Client> {
    const host = this.host;
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      client.on("ready", () => {
        settled = true;
        resolve(client);
      });
      client.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      // Password auth servers sometimes only offer keyboard-interactive;
      // answer its prompts with the password we were given.
      client.on("keyboard-interactive", (_name, _instr, _lang, prompts, finish) => {
        const pw = typeof auth.password === "string" ? auth.password : "";
        finish(prompts.map(() => pw));
      });
      client.connect({
        host: host.host,
        port: host.port,
        username: host.username,
        readyTimeout: READY_TIMEOUT_MS,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        tryKeyboard: typeof auth.password === "string",
        hostVerifier: (key: Buffer, verified: (ok: boolean) => void) => {
          void this.verifyHostKey(key).then(verified);
        },
        ...auth,
      });
    });
  }

  private async verifyHostKey(key: Buffer): Promise<boolean> {
    // Trust-on-first-use: remember the key's fingerprint per host:port and
    // refuse silently-changed keys (the workspace row shows the error).
    const id = `${this.host.host}:${this.host.port}`;
    const fingerprint = createHash("sha256").update(key).digest("base64");
    const known = await readKnownHosts();
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

  private adopt(client: Client): void {
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
    this.client?.end();
    this.client = null;
    this.sftpCached = null;
    this.setState("disconnected");
  }
}

// ── Manager ──────────────────────────────────────────────────────────────────

const connections = new Map<string, RemoteConnection>();

export async function getConnection(hostId: string): Promise<RemoteConnection> {
  let conn = connections.get(hostId);
  if (!conn) {
    const host = await getHost(hostId);
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
  connections.get(hostId)?.dispose();
  connections.delete(hostId);
}

export function disposeAllConnections(): void {
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

export type { RemoteConnection };
