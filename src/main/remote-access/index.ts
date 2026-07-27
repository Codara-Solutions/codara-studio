// Remote Access lifecycle: one RemoteAccessService owns the identity, the
// paired-device store, the listener, the open pairing window, and every live
// RPC session. Settings drives it through enable/disable/pair/revoke; the
// IPC layer subscribes to its status and pairing callbacks.
//
// The service takes every environment dependency (directories, workspace
// listing, terminal creation) through RemoteAccessDeps, so the unit tests
// and the e2e harness run the REAL lifecycle in plain Node. Production
// wiring over sparkHome/storage/pty-manager lives in ./production, which is
// the only module here allowed to import the rest of the main process.

import type {
  RemoteAccessStatus,
  RemotePairedDevice,
  RemotePairingSession,
  RemotePairingState,
} from "@shared/remote-access";
import { loadOrCreateIdentity, shortKey, type RemoteIdentity } from "./identity";
import {
  buildQrPayloadString,
  lanAddresses,
  parsePairRequestFrame,
  PairedDeviceStore,
  PairingWindow,
  PAIRING_TTL_MS,
  type PairResponseFrame,
} from "./pairing";
import { RemoteListener, type EncryptedPeerStream } from "./listener";
import {
  encodeFrame,
  FrameDecoder,
  RpcSession,
  type RemoteRpcServices,
  type RemoteTerminalCreateRequest,
  type RemoteTerminalHandle,
} from "./rpc";

export type { RemoteTerminalCreateRequest, RemoteTerminalHandle };

// A pairing candidate gets this long to send its one proof frame before the
// stream is dropped. Generous for a same-LAN phone, small enough that idle
// probes cannot hold sockets through the whole pairing window.
const PAIRING_FRAME_TIMEOUT_MS = 10_000;
// The pairing exchange consists of one small JSON frame; anything bigger is
// not a pairing attempt.
const PAIRING_MAX_FRAME_BYTES = 4096;
// Concurrent sessions one paired device may hold, and across all devices.
// These are what make the per-connection terminal cap in rpc.ts meaningful:
// the real pty ceiling is MAX_TOTAL_SESSIONS x MAX_TERMINALS_PER_CONNECTION.
const MAX_SESSIONS_PER_DEVICE = 4;
const MAX_TOTAL_SESSIONS = 16;
// How long a freshly accepted session has to prove liveness (complete a
// valid hello) before it is reaped. A passively replayed IK first flight can
// open a stream and even report a paired device's key, but it can never
// derive the session keys to send a real hello, so it never becomes proven;
// this deadline is what stops such phantom sessions from lingering.
const SESSION_HELLO_DEADLINE_MS = 15_000;

export interface RemoteAccessDeps {
  // <spark-home>/remote in production; a temp dir in tests.
  remoteDir: string;
  // Computer display name (QR + hello), e.g. os.hostname().
  deviceName: string;
  // Studio version reported in hello.
  appVersion: string;
  listWorkspaces: RemoteRpcServices["listWorkspaces"];
  createTerminal(request: RemoteTerminalCreateRequest): Promise<RemoteTerminalHandle>;
  log(line: string): void;
  // Test/harness overrides. Production leaves all of these unset.
  host?: string;
  port?: number;
  dhtBootstrap?: Array<{ host: string; port: number }> | false;
  advertisedAddrs?: string[];
  now?: () => number;
  // Test override for the unproven-session reaper deadline (see
  // SESSION_HELLO_DEADLINE_MS). Production leaves it unset.
  sessionHelloDeadlineMs?: number;
}

export class RemoteAccessService {
  private identity: RemoteIdentity | null = null;
  private readonly devices: PairedDeviceStore;
  private listener: RemoteListener | null = null;
  private status: RemoteAccessStatus = { state: "disabled", detail: "", port: null, dhtReady: false };
  private pairing: PairingWindow | null = null;
  private pairingExpiryTimer: NodeJS.Timeout | null = null;
  private pairingState: RemotePairingState = { phase: "idle" };
  // Mirrors the last listener's DHT state across its own teardown; see
  // isDhtActive.
  private dhtActive = false;
  // Live sessions keyed by the peer's canonical base64 public key. One
  // device may hold several (phone reconnect race); revoke kills them all.
  private readonly sessions = new Map<string, Set<RpcSession>>();
  // Per-session reaper timers for the hello deadline (see onAuthorizedStream).
  private readonly sessionHelloTimers = new Map<RpcSession, NodeJS.Timeout>();
  private readonly statusListeners = new Set<(status: RemoteAccessStatus) => void>();
  private readonly pairingListeners = new Set<(state: RemotePairingState) => void>();
  // Serializes enable/disable so a fast toggle cannot interleave a start
  // and a stop of the same listener.
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RemoteAccessDeps) {
    this.devices = new PairedDeviceStore(deps.remoteDir, deps.log);
  }

  /* ---------------------------------------------------------------- status */

  getStatus(): RemoteAccessStatus {
    return this.status;
  }

  getPairingState(): RemotePairingState {
    return this.pairingState;
  }

  onStatusChanged(listener: (status: RemoteAccessStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onPairingChanged(listener: (state: RemotePairingState) => void): () => void {
    this.pairingListeners.add(listener);
    return () => this.pairingListeners.delete(listener);
  }

  private setStatus(status: RemoteAccessStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private setPairingState(state: RemotePairingState): void {
    this.pairingState = state;
    for (const listener of this.pairingListeners) listener(state);
  }

  /* ------------------------------------------------------------- lifecycle */

  async setEnabled(enabled: boolean): Promise<RemoteAccessStatus> {
    const run = this.lifecycle.then(() => (enabled ? this.start() : this.stop()));
    // Keep the chain alive whether or not this transition failed.
    this.lifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
    return this.status;
  }

  private async start(): Promise<void> {
    if (this.listener) return;
    this.setStatus({ state: "starting", detail: "", port: null, dhtReady: false });
    try {
      this.identity ??= loadOrCreateIdentity(this.deps.remoteDir);
      const listener = new RemoteListener({
        keyPair: { publicKey: this.identity.publicKey, secretKey: this.identity.secretKey },
        isAuthorized: (publicKey) => this.devices.isAuthorized(publicKey),
        onAuthorizedStream: (stream) => this.onAuthorizedStream(stream),
        onPairingCandidateStream: (stream) => this.onPairingCandidateStream(stream),
        log: this.deps.log,
        host: this.deps.host,
        port: this.deps.port,
        dhtBootstrap: this.deps.dhtBootstrap,
      });
      const { port, dhtReady } = await listener.start();
      this.listener = listener;
      this.dhtActive = listener.isDhtActive();
      this.setStatus({ state: "reachable", detail: "", port, dhtReady });
      this.deps.log(
        `listening on port ${port} (dht ${dhtReady ? "announced" : "unavailable"}) as ${shortKey(this.identity.publicKeyB64)}`,
      );
    } catch (err) {
      this.listener = null;
      this.setStatus({
        state: "error",
        detail: plainLanguageStartError(err as Error),
        port: null,
        dhtReady: false,
      });
    }
  }

  private async stop(): Promise<void> {
    this.cancelPairing();
    const listener = this.listener;
    this.listener = null;
    for (const timer of this.sessionHelloTimers.values()) clearTimeout(timer);
    this.sessionHelloTimers.clear();
    for (const sessions of this.sessions.values()) {
      for (const session of sessions) session.destroy();
    }
    this.sessions.clear();
    if (listener) {
      await listener.stop();
      // Observed AFTER the stop so it reflects what teardown actually
      // achieved, not what it intended. See isDhtActive.
      this.dhtActive = listener.isDhtActive();
    }
    // Land any coalesced last-seen timestamps before going quiet.
    await this.devices.flushPendingWrites();
    this.setStatus({ state: "disabled", detail: "", port: null, dhtReady: false });
  }

  /* --------------------------------------------------------------- pairing */

  // Mints the one-time pairing window and returns the QR payload string.
  // Requires the listener to be up: the QR embeds its live port.
  startPairing(): RemotePairingSession {
    if (!this.listener || this.status.state !== "reachable" || !this.identity) {
      throw new Error("Enable remote access before pairing a device.");
    }
    this.cancelPairing();
    const now = this.deps.now?.() ?? Date.now();
    const window = new PairingWindow(now);
    this.pairing = window;
    this.listener.setPairingOpen(true);
    this.pairingExpiryTimer = setTimeout(() => {
      // Expiry with no successful pairing: close the window and tell the
      // modal, which flips to its "expired" state.
      if (this.pairing === window) {
        this.closePairingWindow();
        this.setPairingState({ phase: "expired" });
      }
    }, PAIRING_TTL_MS);
    this.setPairingState({ phase: "waiting", expiresAt: window.expiresAt });
    const qrPayload = buildQrPayloadString({
      publicKeyB64: this.identity.publicKeyB64,
      addrs: this.deps.advertisedAddrs ?? lanAddresses(),
      port: this.status.port ?? 0,
      window,
      name: this.deps.deviceName,
      now,
    });
    return { qrPayload, expiresAt: window.expiresAt };
  }

  // Modal closed (or a new window replaces this one): stop accepting
  // strangers and forget the secret.
  cancelPairing(): void {
    this.closePairingWindow();
    if (this.pairingState.phase === "waiting") this.setPairingState({ phase: "idle" });
  }

  private closePairingWindow(): void {
    this.pairing = null;
    this.listener?.setPairingOpen(false);
    if (this.pairingExpiryTimer) {
      clearTimeout(this.pairingExpiryTimer);
      this.pairingExpiryTimer = null;
    }
  }

  // A stranger connected while a pairing window is open. One frame decides:
  // a valid proof pairs the device, anything else destroys the stream with
  // no reply (silent-listener rule).
  private onPairingCandidateStream(stream: EncryptedPeerStream): void {
    const decoder = new FrameDecoder(PAIRING_MAX_FRAME_BYTES);
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        stream.destroy();
      }
    }, PAIRING_FRAME_TIMEOUT_MS);

    stream.on("data", (chunk) => {
      if (settled) return;
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch {
        settled = true;
        clearTimeout(timer);
        stream.destroy();
        return;
      }
      const frame = frames[0];
      if (frame === undefined) return;
      settled = true;
      clearTimeout(timer);
      this.completePairing(stream, frame);
    });
    stream.on("close", () => {
      settled = true;
      clearTimeout(timer);
    });
  }

  private completePairing(stream: EncryptedPeerStream, frame: unknown): void {
    const window = this.pairing;
    const request = parsePairRequestFrame(frame);
    const now = this.deps.now?.() ?? Date.now();
    if (!window || !request) {
      stream.destroy();
      return;
    }
    const proof = Buffer.from(request.secret, "base64");
    if (!window.consume(proof, now)) {
      // Wrong secret, expired, or already used: no reply, no hint.
      stream.destroy();
      return;
    }
    const record = this.devices.addDevice(stream.remotePublicKey, request.name, now);
    this.closePairingWindow();
    const response: PairResponseFrame = { t: "paired", name: this.deps.deviceName };
    stream.write(encodeFrame(response));
    stream.end();
    this.deps.log(`paired device ${shortKey(record.publicKey)} (${record.name})`);
    this.setPairingState({ phase: "paired", deviceName: record.name });
  }

  /* --------------------------------------------------------------- devices */

  listPairedDevices(): RemotePairedDevice[] {
    return this.devices.listForUi();
  }

  // Removes the key and kills its live sessions. The session teardown runs
  // FIRST and synchronously, so a revoked phone loses live access in this
  // tick; the returned promise then additionally guarantees the removal is
  // on disk with no other trust-file write outstanding, so a crash after it
  // resolves cannot bring the device back.
  async revokeDevice(publicKeyB64: string): Promise<boolean> {
    const sessions = this.sessions.get(publicKeyB64);
    if (sessions) {
      for (const session of sessions) {
        const timer = this.sessionHelloTimers.get(session);
        if (timer) {
          clearTimeout(timer);
          this.sessionHelloTimers.delete(session);
        }
        session.destroy();
      }
      this.sessions.delete(publicKeyB64);
    }
    const removed = await this.devices.revokeDevice(publicKeyB64);
    if (removed) this.deps.log(`revoked device ${shortKey(publicKeyB64)}`);
    return removed;
  }

  /* -------------------------------------------------------------- sessions */

  private onAuthorizedStream(stream: EncryptedPeerStream): void {
    const keyB64 = Buffer.from(stream.remotePublicKey).toString("base64");
    // Connection caps. Without these the per-connection terminal cap in
    // rpc.ts bounds nothing: a paired device could open any number of
    // connections and multiply its pty budget by that number.
    //
    // Per device we evict the OLDEST session rather than refusing the new
    // one, because the common cause of a stacked session is a phone that
    // reconnected before we noticed the old socket was dead; refusing there
    // would lock the user out of their own computer. Globally we refuse,
    // since that path means several devices are already at their limit.
    if (this.totalSessionCount() >= MAX_TOTAL_SESSIONS) {
      this.deps.log(`refused session for ${shortKey(keyB64)}: global session cap reached`);
      stream.destroy();
      return;
    }
    const existing = this.sessions.get(keyB64);
    if (existing && existing.size >= MAX_SESSIONS_PER_DEVICE) {
      // A newcomer is unproven until it completes a hello. It must not be
      // able to evict a proven, healthy session for the same device: that is
      // exactly the replay-eviction attack, where four replayed IK first
      // flights report the phone's key and knock its live session offline.
      // Prefer evicting an unproven incumbent (a phantom replay or a stalled
      // peer); if every incumbent is proven, refuse the unproven newcomer.
      let victim: RpcSession | null = null;
      for (const candidate of existing) {
        if (!candidate.isProven()) {
          victim = candidate;
          break;
        }
      }
      if (victim) {
        this.deps.log(`evicting an unproven session for ${shortKey(keyB64)}: per-device cap reached`);
        this.reapSession(keyB64, victim);
      } else {
        this.deps.log(
          `refused session for ${shortKey(keyB64)}: per-device cap reached and every session is proven`,
        );
        stream.destroy();
        return;
      }
    }
    this.devices.touchLastSeen(stream.remotePublicKey);
    const services: RemoteRpcServices = {
      device: {
        publicKey: this.identity?.publicKeyB64 ?? "",
        name: this.deps.deviceName,
        role: "computer",
        version: this.deps.appVersion,
      },
      listWorkspaces: this.deps.listWorkspaces,
      createTerminal: (request) => this.deps.createTerminal(request),
    };
    const session = new RpcSession(stream, services, this.deps.log);
    let set = this.sessions.get(keyB64);
    if (!set) {
      set = new Set();
      this.sessions.set(keyB64, set);
    }
    set.add(session);
    // Reap a session that authenticates but never speaks. Without this an
    // unproven phantom (a replayed IK first flight) would sit in the
    // per-device set indefinitely, taking a slot from real reconnects.
    const helloDeadline = this.deps.sessionHelloDeadlineMs ?? SESSION_HELLO_DEADLINE_MS;
    const helloTimer = setTimeout(() => {
      this.sessionHelloTimers.delete(session);
      if (!session.isProven()) {
        this.deps.log(`reaping unproven session for ${shortKey(keyB64)}: no hello within the deadline`);
        session.destroy();
      }
    }, helloDeadline);
    helloTimer.unref?.();
    this.sessionHelloTimers.set(session, helloTimer);
    stream.on("close", () => {
      const timer = this.sessionHelloTimers.get(session);
      if (timer) {
        clearTimeout(timer);
        this.sessionHelloTimers.delete(session);
      }
      const current = this.sessions.get(keyB64);
      if (!current) return;
      current.delete(session);
      if (current.size === 0) this.sessions.delete(keyB64);
    });
    this.deps.log(`session opened for device ${shortKey(keyB64)}`);
  }

  // Destroys a session and removes it from its device set and reaper map
  // synchronously, so the caller can rely on the slot being freed at once
  // rather than waiting on the stream's asynchronous close event.
  private reapSession(keyB64: string, session: RpcSession): void {
    const timer = this.sessionHelloTimers.get(session);
    if (timer) {
      clearTimeout(timer);
      this.sessionHelloTimers.delete(session);
    }
    const set = this.sessions.get(keyB64);
    if (set) {
      set.delete(session);
      if (set.size === 0) this.sessions.delete(keyB64);
    }
    session.destroy();
  }

  // Test/diagnostic visibility only.
  sessionCountFor(publicKeyB64: string): number {
    return this.sessions.get(publicKeyB64)?.size ?? 0;
  }

  totalSessionCount(): number {
    let total = 0;
    for (const set of this.sessions.values()) total += set.size;
    return total;
  }

  // Whether the last listener this service built still holds DHT objects.
  // Survives stop() on purpose: "did the teardown really run" is only a
  // meaningful question after the listener is gone.
  isDhtActive(): boolean {
    return this.dhtActive;
  }
}

function plainLanguageStartError(err: Error): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") return "The listening port is already in use by another app.";
  if (code === "EACCES") return "The system refused to open the listening port.";
  return err.message || "Remote access could not start.";
}
