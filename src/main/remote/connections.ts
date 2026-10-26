import { randomUUID } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Client, ClientChannel, ConnectConfig, ServerHostKeyAlgorithm, SFTPWrapper } from "ssh2";
import type {
  HostKeyChange,
  HostKeyPromptAnswer,
  HostKeyPromptRequest,
  RemoteAuthPromptAnswer,
  RemoteAuthPromptRequest,
  RemoteConnectionStatus,
  RemoteHostConfig,
} from "@shared/remote";
import { writeFileAtomic } from "../fs-atomic";
import { codaraHome } from "../codara-home";
import { getHost, knownHostsSettings, type KnownHostsSettings } from "./ssh-hosts";
import { openProxySocket, resolveProxyInvocation, type ProxySocket } from "./proxy-command";
import { wakeCodaraBox } from "./codara-boxes";
import { abortableDelay, clearFreshBoxKey, nextFreshKeyDelayMs } from "./box-key-retry";
import { deleteSecret, getSecret, setSecret } from "./secret-store";
import {
  displayFingerprint,
  hostKeyAlgorithms,
  hostKeyType,
  knownHostTypes,
  knownHostsVerdict,
  revokedByFile,
  RevokedKeysFormatError,
  sshFingerprint,
  type KnownHostsVerdict,
  storedFingerprint,
} from "./host-keys";

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

let hostKeyDefaultsPromise: Promise<readonly string[] | null> | null = null;

/**
 * ssh2's own server host key algorithms, the base of the reordered list: an
 * exact list must name only algorithms this ssh2 supports, or connect throws.
 * Null (ssh2's defaults stay) if its internals ever move.
 */
function loadHostKeyDefaults(): Promise<readonly string[] | null> {
  hostKeyDefaultsPromise ??= import("ssh2/lib/protocol/constants.js")
    .then((mod: unknown) => {
      const constants = ((mod as { default?: unknown }).default ?? mod) as { DEFAULT_SERVER_HOST_KEY?: unknown };
      const list = constants.DEFAULT_SERVER_HOST_KEY;
      return Array.isArray(list) && list.every((name) => typeof name === "string") ? (list as string[]) : null;
    })
    .catch(() => null);
  return hostKeyDefaultsPromise;
}

const READY_TIMEOUT_MS = 20_000;
// Through a ProxyCommand the handshake also waits for the proxy to dial.
const PROXY_READY_TIMEOUT_MS = 120_000;
// The handshake waits while the user reads a new host key's fingerprint.
const HOST_KEY_PROMPT_READY_TIMEOUT_MS = 5 * 60_000;
// That long wait starts only once the host answered: until then a machine
// that is down fails as fast as any other connect.
const timeouts = { reachMs: READY_TIMEOUT_MS, promptMs: HOST_KEY_PROMPT_READY_TIMEOUT_MS };

export function setHostKeyTimeoutsForTests(next: Partial<typeof timeouts>): void {
  Object.assign(timeouts, next);
}
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 3;
// A ProxyCommand that ignores the end of its input would outlive a closed
// connection, so dispose force-closes a client still open after this long.
const DISPOSE_GRACE_MS = 2_000;
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
  /** Connect, if needed, without prompts or a box wake (see `ensure`). */
  quiet?: boolean;
}

/**
 * A quiet connect (a pane reconnecting on its own) stopped where it would
 * have asked the user for a password or passphrase, or woken a Codara box.
 */
export class NeedsUserError extends Error {
  readonly needsUser = true;
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

// Every read-modify-write of the store runs alone: two hosts trusted at once
// must not both pass the check, nor lose each other's entry.
let knownHostsQueue: Promise<unknown> = Promise.resolve();

function updateKnownHosts<T>(update: (all: Record<string, string>) => { result: T; write: boolean }): Promise<T> {
  const run = knownHostsQueue.then(async () => {
    const all = await readKnownHosts();
    const { result, write } = update(all);
    if (write) {
      await writeFileAtomic(join(codaraHome(), KNOWN_HOSTS_FILE), JSON.stringify(all, null, 2)).catch(
        () => undefined,
      );
    }
    return result;
  });
  knownHostsQueue = run.catch(() => undefined);
  return run;
}

async function rememberHostKey(key: string, fingerprint: string): Promise<void> {
  await updateKnownHosts((all) => {
    all[key] = fingerprint;
    return { result: undefined, write: true };
  });
}

/**
 * Stores a first-use key unless the entry appeared meanwhile (another host at
 * the same address was trusted while this one waited) or `wanted` says the
 * attempt is over. Returns the entry that stands in its way, if any.
 */
function rememberFirstHostKey(
  key: string,
  fingerprint: string,
  wanted: () => boolean,
): Promise<{ stored: boolean; existing: string | null }> {
  return updateKnownHosts<{ stored: boolean; existing: string | null }>((all) => {
    const existing = all[key] ?? null;
    if (existing === fingerprint) return { result: { stored: true, existing: null }, write: false };
    if (existing !== null || !wanted()) return { result: { stored: false, existing }, write: false };
    all[key] = fingerprint;
    return { result: { stored: true, existing: null }, write: true };
  });
}

// ── Host key confirmation ────────────────────────────────────────────────────
//
// With confirmation on (the Machines preference), a key Studio has not seen is
// trusted silently only when the user's own ~/.ssh/known_hosts already lists
// it; otherwise the user confirms the fingerprint first. Codara Cloud boxes
// keep trust on first use: their alias-keyed entry comes from the signed-in
// CLI. A changed key is always refused; the user can trust the new one
// explicitly, which replaces only that host's entry.

type HostKeyPromptSender = (request: HostKeyPromptRequest) => void;
let hostKeyPromptSender: HostKeyPromptSender | null = null;
let hostKeyPromptClosedSender: ((requestId: string) => void) | null = null;
const pendingHostKeyPrompts = new Map<string, (trust: boolean) => void>();
let confirmNewHostKeys: () => Promise<boolean> = async () => false;

export function setHostKeyPromptSender(sender: HostKeyPromptSender | null): void {
  hostKeyPromptSender = sender;
}

/** Told when a prompt ends however it ends, so every window that shows it drops it. */
export function setHostKeyPromptClosedSender(sender: ((requestId: string) => void) | null): void {
  hostKeyPromptClosedSender = sender;
}

/** Whether a new host key needs the user's confirmation; read on each connect. */
export function setHostKeyConfirmation(enabled: () => Promise<boolean>): void {
  confirmNewHostKeys = enabled;
}

export function answerHostKeyPrompt(answer: HostKeyPromptAnswer): void {
  pendingHostKeyPrompts.get(answer.requestId)?.(answer.trust === true);
}

/**
 * Open questions by the entry and key they ask about: two hosts for one
 * address (two aliases of one machine) offering one key share a question,
 * and it lasts while any of their attempts still waits for it.
 */
const openHostKeyPrompts = new Map<
  string,
  { waiters: Set<(trust: boolean) => void>; finish: (trust: boolean) => void }
>();

function promptHostKey(request: Omit<HostKeyPromptRequest, "requestId">, signal: AbortSignal): Promise<boolean> {
  if (!hostKeyPromptSender || signal.aborted) return Promise.resolve(false);
  const shareKey = `${request.hostLabel}\n${request.fingerprint}`;
  const existing = openHostKeyPrompts.get(shareKey);
  const requestId = randomUUID();
  const prompt = existing ?? {
    waiters: new Set<(trust: boolean) => void>(),
    finish: (trust: boolean) => {
      if (!pendingHostKeyPrompts.delete(requestId)) return;
      openHostKeyPrompts.delete(shareKey);
      clearTimeout(timer);
      try {
        hostKeyPromptClosedSender?.(requestId);
      } catch {
        // A window mid-teardown must not keep the handshake waiting.
      }
      for (const waiter of prompt.waiters) waiter(trust);
      prompt.waiters.clear();
    },
  };
  const answered = new Promise<boolean>((resolve) => {
    const waiter = (trust: boolean) => {
      signal.removeEventListener("abort", onAbort);
      resolve(trust);
    };
    const onAbort = () => {
      prompt.waiters.delete(waiter);
      resolve(false);
      if (prompt.waiters.size === 0) prompt.finish(false);
    };
    prompt.waiters.add(waiter);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  if (existing) return answered;
  // ssh2's handshake waits on this answer; an unanswered prompt must not
  // hold a connection open forever.
  const timer = setTimeout(() => prompt.finish(false), timeouts.promptMs);
  openHostKeyPrompts.set(shareKey, prompt);
  pendingHostKeyPrompts.set(requestId, prompt.finish);
  try {
    hostKeyPromptSender?.({ requestId, ...request });
  } catch {
    prompt.finish(false);
  }
  return answered;
}

type KnownHostsFiles = Exclude<KnownHostsSettings, { refusal: string }>;

/** The known_hosts files ssh reads for this host, read only. */
async function readUserKnownHosts(known: KnownHostsFiles): Promise<string> {
  const texts = await Promise.all(known.files.map((file) => fs.readFile(file, "utf8").catch(() => "")));
  return texts.join("\n");
}

/**
 * Why RevokedHostKeys refuses `key`, or null. ssh checks each file in turn:
 * it refuses a key one revokes, and refuses to connect when it cannot read
 * one at all.
 */
async function revokedHostKeysRefusal(known: KnownHostsFiles, key: Buffer, id: string): Promise<string | null> {
  for (const candidates of known.revoked ?? []) {
    let read = false;
    for (const file of candidates) {
      let data: Buffer;
      try {
        data = await fs.readFile(file);
      } catch {
        continue;
      }
      read = true;
      try {
        if (revokedByFile(data, key)) return `The host key of ${id} is revoked by ${file} (RevokedHostKeys).`;
      } catch (err) {
        if (!(err instanceof RevokedKeysFormatError)) throw err;
        return `RevokedHostKeys ${file} ${err.message}, so ssh would not connect to ${id} either.`;
      }
    }
    if (!read) return `RevokedHostKeys ${candidates[0]} cannot be read, so ssh would not connect to ${id} either.`;
  }
  return null;
}

/**
 * The name known_hosts lists the host under. OpenSSH lowercases a HostKeyAlias
 * as it lowercases a host name, and then hashes it as is.
 */
function knownHostsName(host: RemoteHostConfig): { name: string; port: number } {
  return host.hostKeyAlias
    ? { name: host.hostKeyAlias.toLowerCase(), port: 22 }
    : { name: host.host.toLowerCase(), port: host.port };
}

/** Where Codara's own store keeps a host's key: the alias when it has one. */
function hostKeyStoreId(host: RemoteHostConfig): string {
  return host.hostKeyAlias ?? `${host.host}:${host.port}`;
}

/**
 * Changed keys the user may trust, by host id: the entry to replace, the new
 * key as stored, and as the card showed it.
 */
const changedHostKeys = new Map<string, { storeId: string; fingerprint: string; shown: string }>();

/**
 * Trusts the key a host presented when it was refused as changed, only if it
 * is still the one the user saw (`fingerprint`, as `sshFingerprint` prints
 * it): a key that arrived after the card was drawn is not what they checked.
 */
export async function trustChangedHostKey(hostId: string, fingerprint: string): Promise<boolean> {
  const pending = changedHostKeys.get(hostId);
  if (!pending || pending.shown !== fingerprint) return false;
  changedHostKeys.delete(hostId);
  await rememberHostKey(pending.storeId, pending.fingerprint);
  const conn = connections.get(hostId);
  if (conn) conn.hostKeyChange = null;
  return true;
}

/** Drops the offer to trust a changed key: the host was disconnected, edited or removed. */
export function forgetChangedHostKey(hostId: string): void {
  changedHostKeys.delete(hostId);
}

// ── Status broadcast ─────────────────────────────────────────────────────────

type StatusSender = (status: RemoteConnectionStatus) => void;
let statusSender: StatusSender | null = null;

export function setStatusSender(sender: StatusSender | null): void {
  statusSender = sender;
}

// ── Client lifecycle (port forwarding follows it) ────────────────────────────

export type ConnectionLifecycleEvent = "connected" | "closed";
type ConnectionLifecycleListener = (hostId: string, event: ConnectionLifecycleEvent) => void;
const lifecycleListeners = new Set<ConnectionLifecycleListener>();

/** "connected" once a client is adopted, "closed" when that client's transport closes. */
export function onConnectionLifecycle(listener: ConnectionLifecycleListener): () => void {
  lifecycleListeners.add(listener);
  return () => lifecycleListeners.delete(listener);
}

function emitLifecycle(hostId: string, event: ConnectionLifecycleEvent): void {
  for (const listener of lifecycleListeners) {
    try {
      listener(hostId, event);
    } catch {
      // A listener must never break the connection it observes.
    }
  }
}

// ── Connection ───────────────────────────────────────────────────────────────

class RemoteConnection {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private connectingAbort: AbortController | null = null;
  private connectingQuiet = false;
  /** The generation of the quiet connect under way, which must never ask about a key. */
  private quietGeneration = -1;
  private generation = 0;
  private disposed = false;
  private sftpCached: Promise<SFTPWrapper> | null = null;
  state: RemoteConnectionStatus["state"] = "disconnected";
  lastError: string | null = null;
  hostKeyChange: HostKeyChange | null = null;
  // Why verifyHostKey refused, which ssh2 only reports as "verification failed".
  private hostKeyRefusal: string | null = null;

  constructor(public readonly host: RemoteHostConfig) {}

  /** The user disconnected the host, or Studio is quitting: never reconnect. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  private setState(state: RemoteConnectionStatus["state"], error?: string, progress?: string): void {
    this.state = state;
    this.lastError = error ?? null;
    statusSender?.({
      hostId: this.host.id,
      state,
      ...(error ? { error } : {}),
      ...(progress ? { progress } : {}),
      ...(state === "error" && this.hostKeyChange ? { hostKeyChange: this.hostKeyChange } : {}),
    });
  }

  /**
   * The open client, connecting first if needed. `quiet` is for work nobody
   * asked for just now (a pane reconnecting on its own): it uses only what
   * needs no prompt (keys without a passphrase or with a saved one, the
   * agent, a saved password) and never dials a Codara box, whose wake costs
   * money; where it would ask it fails with NeedsUserError instead.
   */
  async ensure(opts: { quiet?: boolean } = {}): Promise<Client> {
    const quiet = opts.quiet === true;
    if (this.client) return this.client;
    if (this.disposed) throw new ConnectionAttemptCancelledError();
    if (this.connecting) {
      // The user's connect is never handed a quiet attempt's failure: it
      // starts its own, which may ask, once the quiet one gives up.
      if (this.connectingQuiet && !quiet) return this.connecting.catch(() => this.ensure());
      return this.connecting;
    }
    if (quiet && this.host.codaraBoxId) {
      throw new NeedsUserError(`Reconnecting to ${this.host.id} could wake the box.`);
    }
    const generation = ++this.generation;
    const controller = new AbortController();
    const connecting = this.connect(generation, controller.signal, quiet).finally(() => {
      if (this.connecting === connecting) {
        this.connecting = null;
        this.connectingAbort = null;
      }
    });
    this.connecting = connecting;
    this.connectingAbort = controller;
    this.connectingQuiet = quiet;
    return connecting;
  }

  private isCurrent(generation: number, signal: AbortSignal): boolean {
    return !this.disposed && !signal.aborted && this.generation === generation;
  }

  private assertCurrent(generation: number, signal: AbortSignal): void {
    if (!this.isCurrent(generation, signal)) throw new ConnectionAttemptCancelledError();
  }

  private async connect(generation: number, signal: AbortSignal, quiet = false): Promise<Client> {
    const host = this.host;
    if (quiet) this.quietGeneration = generation;
    this.assertCurrent(generation, signal);
    // A card drawn for an earlier attempt must not trust a key this one never saw.
    forgetChangedHostKey(host.id);
    this.hostKeyChange = null;
    this.hostKeyRefusal = null;
    this.setState("connecting");
    const known = await knownHostsSettings(host);
    this.assertCurrent(generation, signal);
    // ssh stops before connecting, or may apply a revocation list Codara
    // cannot see: refused whatever the confirmation setting.
    if ("refusal" in known) {
      const message = `Codara will not connect to ${host.id} because of your ssh config: ${known.refusal}.`;
      this.setState("error", message);
      throw new Error(`SSH connection to ${host.id} failed: ${message}`);
    }
    const { utils: sshUtils } = await loadSsh2();
    this.assertCurrent(generation, signal);

    // A Codara box may be asleep: the CLI wakes it first and reports phases,
    // so the handshake below starts against a box that is already running.
    if (host.codaraBoxId) {
      try {
        await wakeCodaraBox(host.codaraBoxId, {
          signal,
          onPhase: (line) => {
            if (this.isCurrent(generation, signal)) this.setState("connecting", undefined, line);
          },
        });
      } catch (err) {
        this.assertCurrent(generation, signal);
        const message = err instanceof Error ? err.message : "The box could not be woken.";
        this.setState("error", message);
        throw new Error(`SSH connection to ${host.id} failed: ${message}`);
      }
      this.assertCurrent(generation, signal);
    }

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
            if (passphrase === null && !quiet) {
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
    for (let retry = 0; ; retry++) {
      lastErr = null;
      for (const attempt of attempts) {
        try {
          const client = await this.tryConnect(attempt.cfg, known, generation, signal);
          if (host.codaraBoxId) clearFreshBoxKey(host.id);
          this.adopt(client, generation, signal);
          return client;
        } catch (err) {
          if (err instanceof ConnectionAttemptCancelledError) throw err;
          lastErr = err as Error;
          if (!isAuthFailure(lastErr)) break; // network/hostkey errors: stop the ladder
        }
      }
      // A key the CLI added moments ago may not have reached the box yet:
      // only then is an authentication failure worth another round.
      if (quiet || !host.codaraBoxId || lastErr === null || !isAuthFailure(lastErr)) break;
      const delay = nextFreshKeyDelayMs(host.id, retry);
      if (delay === null) break;
      this.setState(
        "connecting",
        undefined,
        `Waiting for your new SSH key to reach the box (about 1 to 2 minutes), retrying in ${Math.ceil(delay / 1000)}s`,
      );
      await abortableDelay(delay, signal);
      this.assertCurrent(generation, signal);
    }

    if (quiet && (lastErr === null || isAuthFailure(lastErr))) {
      this.assertCurrent(generation, signal);
      this.setState("disconnected");
      throw new NeedsUserError(`Reconnecting to ${host.id} needs a password or passphrase.`);
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
            known,
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

    const message = this.hostKeyRefusal ?? lastErr?.message ?? "Unable to authenticate.";
    this.assertCurrent(generation, signal);
    this.setState("error", message);
    throw new Error(`SSH connection to ${host.id} failed: ${message}`);
  }

  private keyPassphrases = new Map<Buffer, string>();

  private async tryConnect(
    auth: Partial<ConnectConfig>,
    known: KnownHostsFiles,
    generation: number,
    signal: AbortSignal,
  ): Promise<Client> {
    const host = this.host;
    const { Client } = await loadSsh2();
    this.assertCurrent(generation, signal);
    const plan = await this.hostKeyPlan(known);
    const mayAskHostKey = plan.mayAsk;
    this.assertCurrent(generation, signal);
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      // A host-key prompt belongs to this attempt: sshd drops a handshake the
      // user reads too long (LoginGraceTime), and a Trust after that must not
      // store a key with no connection behind it.
      const attempt = new AbortController();
      let proxy: ProxySocket | null = null;
      try {
        const invocation = resolveProxyInvocation(host);
        if (invocation) {
          proxy = openProxySocket(invocation, {
            onStderrLine: (line) => {
              if (this.isCurrent(generation, signal)) this.setState("connecting", undefined, line);
            },
          });
          // A proxy that dies destroys its socket; ssh2 then reports the close.
          proxy.on("error", (err) => fail(err));
          client.once("close", () => proxy?.destroy());
        }
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let reachTimer: ReturnType<typeof setTimeout> | null = null;
      const reached = () => {
        if (reachTimer) clearTimeout(reachTimer);
        reachTimer = null;
      };
      const cleanup = () => {
        reached();
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
        attempt.abort();
        cleanup();
        // The handshake may still report after giving up (a host-key answer
        // that came too late): never as an uncaught "error".
        if (!client.listeners("error").includes(swallowUnownedClientError)) {
          client.on("error", swallowUnownedClientError);
        }
        proxy?.destroy();
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
      if (mayAskHostKey) {
        const reachMs = proxy ? PROXY_READY_TIMEOUT_MS : timeouts.reachMs;
        reachTimer = setTimeout(() => {
          fail(new Error(`${host.id} did not answer within ${Math.round(reachMs / 1000)}s.`));
          disposeClient(client);
        }, reachMs);
      }
      try {
        client.connect({
          host: host.host,
          port: host.port,
          username: host.username,
          readyTimeout: mayAskHostKey
            ? HOST_KEY_PROMPT_READY_TIMEOUT_MS
            : proxy
              ? PROXY_READY_TIMEOUT_MS
              : READY_TIMEOUT_MS,
          ...(proxy ? { sock: proxy } : {}),
          ...(plan.serverHostKey ? { algorithms: { serverHostKey: plan.serverHostKey } } : {}),
          keepaliveInterval: KEEPALIVE_INTERVAL_MS,
          keepaliveCountMax: KEEPALIVE_COUNT_MAX,
          tryKeyboard: typeof auth.password === "string",
          hostVerifier: (key: Buffer, verified: (ok: boolean) => void) => {
            reached();
            void this.verifyHostKey(key, known, generation, attempt.signal).then(verified);
          },
          ...auth,
        });
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
        disposeClient(client);
      }
    });
  }

  /**
   * Whether this connect may stop to ask about a new key, and the host key
   * algorithms to offer: with confirmation on, the types known_hosts lists for
   * the host come first, as OpenSSH orders them.
   */
  private async hostKeyPlan(
    settings: KnownHostsFiles,
  ): Promise<{ mayAsk: boolean; serverHostKey: ServerHostKeyAlgorithm[] | null }> {
    const host = this.host;
    if (host.codaraBoxId || !(await confirmNewHostKeys())) return { mayAsk: false, serverHostKey: null };
    const known = await readKnownHosts();
    const { name, port } = knownHostsName(host);
    const types = knownHostTypes(await readUserKnownHosts(settings), name, port);
    const available = types.length > 0 ? await loadHostKeyDefaults() : null;
    // hostKeyAlgorithms only reorders ssh2's own default list.
    const serverHostKey = available ? (hostKeyAlgorithms(types, available) as ServerHostKeyAlgorithm[]) : null;
    return { mayAsk: !known[hostKeyStoreId(host)], serverHostKey };
  }

  private async verifyHostKey(
    key: Buffer,
    settings: KnownHostsFiles,
    generation: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    // Fingerprints are kept per host:port (or the host's alias); a key that
    // changed is refused until the user trusts it (trustChangedHostKey).
    const host = this.host;
    const id = hostKeyStoreId(host);
    const fingerprint = storedFingerprint(key);
    const known = await readKnownHosts();
    if (!this.isCurrent(generation, signal)) return false;
    const prior = known[id];
    const confirm = !host.codaraBoxId && (await confirmNewHostKeys());
    if (!this.isCurrent(generation, signal)) return false;
    // ssh checks RevokedHostKeys first, even with StrictHostKeyChecking=no.
    const revokedBy = await revokedHostKeysRefusal(settings, key, id);
    if (!this.isCurrent(generation, signal)) return false;
    if (revokedBy) {
      this.hostKeyRefusal = revokedBy;
      return false;
    }
    // Read before trusting even a stored key: the user may have revoked it
    // in known_hosts since. A revoked key loses whatever the confirmation
    // setting; with it off, known_hosts is read for nothing else. OpenSSH
    // looks a HostKeyAlias up without the port.
    const { name, port } = knownHostsName(host);
    const listed = knownHostsVerdict(await readUserKnownHosts(settings), name, port, key);
    if (!this.isCurrent(generation, signal)) return false;
    if (listed.kind === "revoked") {
      this.hostKeyRefusal = `The host key of ${id} is marked revoked in known_hosts.`;
      return false;
    }
    const verdict: KnownHostsVerdict | null = confirm ? listed : null;
    if (prior === fingerprint) {
      forgetChangedHostKey(host.id);
      return true;
    }
    if (verdict?.kind === "mismatch") {
      this.refuseChangedKey(id, sshFingerprint(verdict.listedKey), key, hostKeyType(verdict.listedKey));
      return false;
    }
    if (!prior) {
      if (verdict?.kind === "none") {
        if (this.quietGeneration === generation) {
          this.hostKeyRefusal = `The host key of ${id} needs your confirmation: connect to ${host.id} again.`;
          return false;
        }
        const trust = await promptHostKey(
          {
            hostId: host.id,
            hostLabel: id,
            keyType: hostKeyType(key),
            fingerprint: sshFingerprint(key),
            ...(verdict.certAuthority ? { certAuthority: true } : {}),
          },
          signal,
        );
        if (!this.isCurrent(generation, signal)) return false;
        if (!trust) {
          this.hostKeyRefusal = `The host key of ${id} was not trusted.`;
          return false;
        }
      }
      if (confirm) {
        // Another host at the same address may have been trusted while this
        // one waited: its key stands, and this one is a change.
        const { stored, existing } = await rememberFirstHostKey(id, fingerprint, () =>
          this.isCurrent(generation, signal),
        );
        if (existing) {
          this.refuseChangedKey(id, displayFingerprint(existing), key, null);
          return false;
        }
        return stored && this.isCurrent(generation, signal);
      }
      await rememberHostKey(id, fingerprint);
      return true;
    }
    if (confirm) {
      // Codara keeps one key per host; a host has one per type, and the type
      // negotiated can change (known_hosts gained a line, the order of host
      // key algorithms moved). One the user's known_hosts lists is the host's.
      if (verdict?.kind === "match") {
        forgetChangedHostKey(host.id);
        return true;
      }
      this.refuseChangedKey(id, displayFingerprint(prior), key, null);
      return false;
    }
    this.hostKeyRefusal = `Host key for ${id} changed (possible MITM). Remove it from spark-known-hosts.json to trust the new key.`;
    return false;
  }

  /**
   * Refuses a key that differs from the one Codara has for the host
   * (`listedType` null), or from one known_hosts lists, of that type.
   */
  private refuseChangedKey(id: string, previousFingerprint: string, key: Buffer, listedType: string | null): void {
    const shown = sshFingerprint(key);
    const keyType = hostKeyType(key);
    this.hostKeyChange = {
      hostLabel: id,
      previousFingerprint,
      newFingerprint: shown,
      keyType,
      ...(listedType ? { listedBy: "known_hosts" as const, previousKeyType: listedType } : {}),
    };
    changedHostKeys.set(this.host.id, { storeId: id, fingerprint: storedFingerprint(key), shown });
    const why =
      listedType === null
        ? `The host key of ${id} changed since Codara last connected. `
        : listedType === keyType
          ? `The host key of ${id} changed: it is not the key your known_hosts lists. `
          : `The host key of ${id} changed: your known_hosts lists an ${listedType} key for it, and it offered ${keyType}. `;
    this.hostKeyRefusal = why + "Someone may be intercepting the connection, or the machine was reinstalled.";
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
    // After drop(), so a "closed" listener already sees the host disconnected.
    client.once("close", () => emitLifecycle(this.host.id, "closed"));
    emitLifecycle(this.host.id, "connected");
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
    const client = await this.ensure({ quiet: opts.quiet });
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
  async shell(opts: { cols: number; rows: number; term?: string; quiet?: boolean }): Promise<ClientChannel> {
    const client = await this.ensure({ quiet: opts.quiet });
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

  /**
   * A direct-tcpip channel to host:port as the remote machine sees it (local
   * port forwarding, see port-forwarding.ts). Only on the client that is open
   * now: a forward must never reconnect a host the user disconnected.
   */
  forwardOut(
    host: string,
    port: number,
    from: { address: string; port: number },
  ): Promise<ClientChannel> {
    const client = this.client;
    if (!client) return Promise.reject(new Error(`SSH connection to ${this.host.id} is not open.`));
    return new Promise((resolve, reject) => {
      client.forwardOut(from.address, from.port, host, port, (err, channel) => {
        if (err) reject(err);
        else resolve(channel);
      });
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
    if (client) {
      client.end();
      const forceClose = setTimeout(() => disposeClient(client), DISPOSE_GRACE_MS);
      forceClose.unref?.();
      client.once("close", () => clearTimeout(forceClose));
    }
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
    ...(conn.state === "error" && conn.hostKeyChange ? { hostKeyChange: conn.hostKeyChange } : {}),
  };
}

export function disconnectHost(hostId: string): void {
  forgetChangedHostKey(hostId);
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
