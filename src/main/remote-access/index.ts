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
import type {
  GitHubMarkReadyInput,
  GitHubMarkReadyResult,
  GitHubPublishInput,
  GitHubPublishResult,
  GitHubMergeInput,
  GitHubMergeResult,
  GitHubWorkspaceStatus,
  StartGitHubIssueInput,
  StartGitHubIssueResult,
  StartGitHubPullRequestInput,
  StartGitHubPullRequestResult,
} from "@shared/github";
import {
  keyFingerprint,
  loadOrCreateIdentity,
  shortKey,
  type RemoteIdentity,
} from "./identity";
import {
  buildQrPayloadString,
  lanAddresses,
  parsePairRequestFrame,
  PairedDeviceStore,
  PairingWindow,
  PAIRING_TTL_MS,
  sanitizeDeviceName,
  type PairResponseFrame,
} from "./pairing";
import { RemoteListener, type EncryptedPeerStream } from "./listener";
import {
  encodeFrame,
  FrameDecoder,
  RpcSession,
  type RemoteCoraChangedEvent,
  type RemoteCoraResumeAccount,
  type RemoteCoraResumeResult,
  type RemoteNotificationRegistration,
  type RemotePhoneNotification,
  type RemoteRpcServices,
  type RemoteTerminalCreateRequest,
  type RemoteTerminalHandle,
  type RemoteWorkerTerminalOpenRequest,
} from "./rpc";
import { DurableMutationLedger } from "./mutation-ledger";
import { stableRemoteAccessPortCandidates } from "./stable-port";
import {
  RemoteTerminalLeaseRegistry,
  type RemoteTerminalLeaseStore,
} from "./terminal-leases";
import { WorkerTerminalControlRegistry } from "./worker-terminal-controls";

export type {
  RemoteTerminalCreateRequest,
  RemoteTerminalHandle,
  RemoteWorkerTerminalOpenRequest,
};

// A pairing candidate gets this long to send its one proof frame before the
// stream is dropped. Generous for a same-LAN phone, small enough that idle
// probes cannot hold sockets through the whole pairing window.
const PAIRING_FRAME_TIMEOUT_MS = 10_000;
// The pairing exchange consists of one small JSON frame; anything bigger is
// not a pairing attempt.
const PAIRING_MAX_FRAME_BYTES = 4096;
// How long a device that has proven the pairing secret waits for the desktop
// user to approve or deny it before the request is denied automatically. The
// phone simply keeps its pairing stream open for the reply, so this is a
// generous window; a deny or a timeout closes the stream, which the phone
// reads as a clean refusal rather than a hang.
const PAIRING_APPROVAL_TIMEOUT_MS = 60_000;
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
  getFleetOverview?: RemoteRpcServices["getFleetOverview"];
  listSubscriptionProfiles?: RemoteRpcServices["listSubscriptionProfiles"];
  listCoraModels?: RemoteRpcServices["listCoraModels"];
  studioTerminalLeases?: RemoteTerminalLeaseStore;
  listNativeCliAccounts?: RemoteRpcServices["listNativeCliAccounts"];
  listWorkspaceOrganization?: RemoteRpcServices["listWorkspaceOrganization"];
  listDirectories?: RemoteRpcServices["listDirectories"];
  addWorkspace?: RemoteRpcServices["addWorkspace"];
  createWorkspaceGroup?: RemoteRpcServices["createWorkspaceGroup"];
  updateWorkspaceGroup?: RemoteRpcServices["updateWorkspaceGroup"];
  deleteWorkspaceGroup?: RemoteRpcServices["deleteWorkspaceGroup"];
  moveWorkspace?: RemoteRpcServices["moveWorkspace"];
  reorderWorkspaceRail?: RemoteRpcServices["reorderWorkspaceRail"];
  listFiles?: RemoteRpcServices["listFiles"];
  readFile?: RemoteRpcServices["readFile"];
  createFileEntry?: RemoteRpcServices["createFileEntry"];
  renameFileEntry?: RemoteRpcServices["renameFileEntry"];
  moveFileEntry?: RemoteRpcServices["moveFileEntry"];
  deleteFileEntry?: RemoteRpcServices["deleteFileEntry"];
  getGitStatus?: RemoteRpcServices["getGitStatus"];
  getGitLog?: RemoteRpcServices["getGitLog"];
  getGitCommitDetail?: RemoteRpcServices["getGitCommitDetail"];
  getGitHubStatus?(workspaceId: string): Promise<GitHubWorkspaceStatus>;
  getGitHubWorkQueue?: RemoteRpcServices["getGitHubWorkQueue"];
  publishGitHub?(input: {
    workspaceId: string;
    input: GitHubPublishInput;
  }): Promise<GitHubPublishResult>;
  markGitHubReady?(input: {
    workspaceId: string;
    input: GitHubMarkReadyInput;
  }): Promise<GitHubMarkReadyResult>;
  mergeGitHub?(input: {
    workspaceId: string;
    input: GitHubMergeInput;
  }): Promise<GitHubMergeResult>;
  startGitHubIssue?(input: StartGitHubIssueInput): Promise<StartGitHubIssueResult>;
  startGitHubPullRequest?(
    input: StartGitHubPullRequestInput,
  ): Promise<StartGitHubPullRequestResult>;
  listCoraHistory?: RemoteRpcServices["listCoraHistory"];
  getCoraRun?: RemoteRpcServices["getCoraRun"];
  getCoraGraph?: RemoteRpcServices["getCoraGraph"];
  deleteCoraRun?(input: { workspaceId: string; runId: string }): Promise<void>;
  sendCoraMessage?: RemoteRpcServices["sendCoraMessage"];
  resumeCoraRun?(input: {
    workspaceId: string;
    runId: string;
    recoveryId: string;
    account?: RemoteCoraResumeAccount;
  }): Promise<RemoteCoraResumeResult>;
  forcePauseCoraRun?: RemoteRpcServices["forcePauseCoraRun"];
  resumePausedCoraRun?: RemoteRpcServices["resumePausedCoraRun"];
  getCoraWhiteboard?: RemoteRpcServices["getCoraWhiteboard"];
  getCoraBoard?: RemoteRpcServices["getCoraBoard"];
  updateCoraBoard?: RemoteRpcServices["updateCoraBoard"];
  listWorkerSessions?: RemoteRpcServices["listWorkerSessions"];
  deleteWorkerSession?: RemoteRpcServices["deleteWorkerSession"];
  listAutomations?: RemoteRpcServices["listAutomations"];
  getAutomation?: RemoteRpcServices["getAutomation"];
  runAutomation?: RemoteRpcServices["runAutomation"];
  pauseAutomation?: RemoteRpcServices["pauseAutomation"];
  resumeAutomation?: RemoteRpcServices["resumeAutomation"];
  setAutomationEnabled?: RemoteRpcServices["setAutomationEnabled"];
  // Receives the trusted peer key alongside the phone's registration; the
  // service binds it per connection so a phone can only register itself.
  registerNotifications?: (
    input: RemoteNotificationRegistration & { devicePublicKey: string },
  ) => Promise<void>;
  beginImageUpload?: RemoteRpcServices["beginImageUpload"];
  attachWorkerTerminal?: RemoteRpcServices["attachWorkerTerminal"];
  createTerminal(
    request: RemoteTerminalCreateRequest,
  ): Promise<RemoteTerminalHandle>;
  log(line: string): void;
  // Test/harness overrides. Production leaves all of these unset.
  host?: string;
  port?: number;
  relayUrl?: string | false;
  advertisedAddrs?: string[];
  now?: () => number;
  // Test override for the unproven-session reaper deadline (see
  // SESSION_HELLO_DEADLINE_MS). Production leaves it unset.
  sessionHelloDeadlineMs?: number;
  // Test override for the desktop pairing-approval timeout (see
  // PAIRING_APPROVAL_TIMEOUT_MS). Production leaves it unset.
  approvalTimeoutMs?: number;
}

// A device that has proven the pairing secret and is waiting for the desktop
// user to approve or deny it. Held until approve/deny/timeout, or until the
// device hangs up.
interface PendingApproval {
  stream: EncryptedPeerStream;
  publicKey: Buffer;
  // The name the device asked to be known by, already control-stripped.
  displayName: string;
  // The device key's short confirmation fingerprint, shown to the user.
  fingerprint: string;
  timer: NodeJS.Timeout;
}

export class RemoteAccessService {
  private identity: RemoteIdentity | null = null;
  private readonly devices: PairedDeviceStore;
  private listener: RemoteListener | null = null;
  private status: RemoteAccessStatus = {
    state: "disabled",
    detail: "",
    port: null,
    relayReady: false,
  };
  private pairing: PairingWindow | null = null;
  private pairingExpiryTimer: NodeJS.Timeout | null = null;
  private pairingState: RemotePairingState = { phase: "idle" };
  // A device awaiting the desktop user's approval, or null. See
  // completePairing / approvePairing / denyPairing.
  private pendingApproval: PendingApproval | null = null;
  // Mirrors the last listener's relay state across teardown for diagnostics.
  private relayActive = false;
  // Live sessions keyed by the peer's canonical base64 public key. One
  // device may hold several (phone reconnect race); revoke kills them all.
  private readonly sessions = new Map<string, Set<RpcSession>>();
  // Per-session reaper timers for the hello deadline (see onAuthorizedStream).
  private readonly sessionHelloTimers = new Map<RpcSession, NodeJS.Timeout>();
  private readonly statusListeners = new Set<
    (status: RemoteAccessStatus) => void
  >();
  private readonly pairingListeners = new Set<
    (state: RemotePairingState) => void
  >();
  // Serializes enable/disable so a fast toggle cannot interleave a start
  // and a stop of the same listener.
  private lifecycle: Promise<void> = Promise.resolve();
  // Open lazily so a corrupt receipt file fails only mutating RPCs; read-only
  // remote access and terminal recovery remain available for reconciliation.
  private mutationLedger: Promise<DurableMutationLedger> | null = null;
  // Process-scoped PTY ownership, keyed by the Noise-authenticated phone key.
  // Socket generations only attach subscribers to these leases.
  private readonly terminalLeases: RemoteTerminalLeaseRegistry;
  private readonly workerTerminalControls: WorkerTerminalControlRegistry;

  constructor(private readonly deps: RemoteAccessDeps) {
    this.devices = new PairedDeviceStore(deps.remoteDir, deps.log);
    this.terminalLeases = new RemoteTerminalLeaseRegistry({
      createTerminal: deps.createTerminal,
      now: deps.now,
      log: deps.log,
    });
    this.workerTerminalControls = new WorkerTerminalControlRegistry({
      now: deps.now,
      log: deps.log,
    });
  }

  private getMutationLedger(): Promise<DurableMutationLedger> {
    this.mutationLedger ??= DurableMutationLedger.open({
      rootDir: this.deps.remoteDir,
    });
    return this.mutationLedger;
  }

  private async executeMutation<T>(
    callerNamespace: string,
    requestId: string | undefined,
    method: string,
    params: unknown,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    // Compatibility for an older paired phone. Current clients always send a
    // stable request id, which is what makes a lost-reply retry safe.
    if (!requestId) return operation();
    const ledger = await this.getMutationLedger();
    return ledger.execute(
      { callerNamespace, requestId, method, params },
      operation,
    );
  }

  private async executeRecoverableMutation<T>(
    callerNamespace: string,
    requestId: string | undefined,
    method: string,
    params: unknown,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    if (!requestId) return operation();
    const ledger = await this.getMutationLedger();
    return ledger.executeRecoverable(
      { callerNamespace, requestId, method, params },
      operation,
    );
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

  notifyWorkspacesChanged(): void {
    for (const sessions of this.sessions.values()) {
      for (const session of sessions) session.pushWorkspacesChanged();
    }
  }

  // Journal activity is only an invalidation hint. Broadcast the same tiny
  // metadata envelope to every session that completed hello; an authenticated
  // stream that has not proved liveness must not receive unsolicited state.
  broadcastCoraChanged(event: RemoteCoraChangedEvent): void {
    for (const sessions of this.sessions.values()) {
      for (const session of sessions) {
        if (session.isProven()) session.pushCoraChanged(event);
      }
    }
  }

  // Live delivery of one desktop-mirrored notification to a specific paired
  // phone. Returns whether at least one session counts as push-live (proven
  // AND recently heard from — see rpc.ts PUSH_LIVENESS_WINDOW_MS), so the
  // caller can fall back to Expo push for a phone that is not reachable. The
  // event is still written to every proven session, stale ones included: a
  // zombie write is lost harmlessly, and the phone dedupes by event id if
  // both channels land.
  pushPhoneNotificationToDevice(
    publicKeyB64: string,
    notification: RemotePhoneNotification,
  ): boolean {
    const sessions = this.sessions.get(publicKeyB64);
    if (!sessions) return false;
    const now = this.deps.now?.() ?? Date.now();
    let live = false;
    for (const session of sessions) {
      if (!session.isProven()) continue;
      session.pushPhoneNotification(notification);
      if (session.isPushLive(now)) live = true;
    }
    return live;
  }

  // Public keys of every paired device, for notification fan-out.
  pairedDeviceKeys(): string[] {
    return this.devices.list().map((device) => device.publicKey);
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
    const run = this.lifecycle.then(() =>
      enabled ? this.start() : this.stop(),
    );
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
    this.setStatus({
      state: "starting",
      detail: "",
      port: null,
      relayReady: false,
    });
    try {
      this.identity ??= loadOrCreateIdentity(this.deps.remoteDir);
      let listener!: RemoteListener;
      listener = new RemoteListener({
        keyPair: {
          publicKey: this.identity.publicKey,
          secretKey: this.identity.secretKey,
        },
        isAuthorized: (publicKey) => this.devices.isAuthorized(publicKey),
        onAuthorizedStream: (stream) => this.onAuthorizedStream(stream),
        onPairingCandidateStream: (stream, promote) =>
          this.onPairingCandidateStream(stream, promote),
        log: this.deps.log,
        host: this.deps.host,
        // Tests and the interop harness may request an exact port (including
        // zero). Production derives an ordered candidate sequence from the
        // persistent identity. The listener advances only on EADDRINUSE.
        ...(this.deps.port !== undefined
          ? { port: this.deps.port }
          : {
              portCandidates: stableRemoteAccessPortCandidates(
                this.identity.publicKey,
              ),
            }),
        ...(this.deps.relayUrl !== undefined
          ? { relayUrl: this.deps.relayUrl }
          : {}),
        onRelayReadyChanged: (relayReady) => {
          if (this.listener !== listener || this.status.state !== "reachable")
            return;
          this.setStatus({ ...this.status, relayReady });
        },
      });
      const { port, relayReady } = await listener.start();
      this.listener = listener;
      this.relayActive = listener.isRelayActive();
      this.setStatus({ state: "reachable", detail: "", port, relayReady });
      this.deps.log(
        `listening on port ${port} (relay ${relayReady ? "connected" : "reconnecting"}) as ${shortKey(this.identity.publicKeyB64)}`,
      );
    } catch (err) {
      this.listener = null;
      this.setStatus({
        state: "error",
        detail: plainLanguageStartError(err as Error),
        port: null,
        relayReady: false,
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
    this.terminalLeases.shutdown();
    this.deps.studioTerminalLeases?.shutdown();
    this.workerTerminalControls.shutdown();
    if (listener) {
      await listener.stop();
      this.relayActive = listener.isRelayActive();
    }
    // Land any coalesced last-seen timestamps before going quiet.
    await this.devices.flushPendingWrites();
    this.setStatus({
      state: "disabled",
      detail: "",
      port: null,
      relayReady: false,
    });
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
  // strangers, forget the secret, and refuse any device still awaiting
  // approval (a clean stream close the phone reads as a refusal).
  cancelPairing(): void {
    this.closePairingWindow();
    const hadPending = this.pendingApproval !== null;
    this.abandonPendingApproval();
    if (
      hadPending ||
      this.pairingState.phase === "waiting" ||
      this.pairingState.phase === "pending-approval"
    ) {
      this.setPairingState({ phase: "idle" });
    }
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
  private onPairingCandidateStream(
    stream: EncryptedPeerStream,
    promote: () => void,
  ): void {
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
      this.completePairing(stream, frame, promote);
    });
    stream.on("close", () => {
      settled = true;
      clearTimeout(timer);
    });
  }

  private completePairing(
    stream: EncryptedPeerStream,
    frame: unknown,
    promote: () => void,
  ): void {
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
    // The secret is proven, but the device is NOT trusted yet. Consuming the
    // window here means a racing device cannot also redeem the same secret;
    // the user now decides, comparing the fingerprint below against the one
    // the phone shows on its confirm screen. Close the stranger window (the
    // secret is spent) and wait for an explicit approve or deny.
    this.closePairingWindow();
    this.abandonPendingApproval();
    // The secret is proven: hand this stream's remaining lifetime to the
    // approval timer below rather than the listener's short pre-auth reaper,
    // which would otherwise kill it before a human could approve.
    promote();
    const publicKey = Buffer.from(stream.remotePublicKey);
    const displayName = sanitizeDeviceName(request.name);
    const fingerprint = keyFingerprint(publicKey.toString("base64"));
    const timeoutMs =
      this.deps.approvalTimeoutMs ?? PAIRING_APPROVAL_TIMEOUT_MS;
    const timer = setTimeout(() => this.denyPairing("timeout"), timeoutMs);
    timer.unref?.();
    const pending: PendingApproval = {
      stream,
      publicKey,
      displayName,
      fingerprint,
      timer,
    };
    this.pendingApproval = pending;
    // If the phone gives up and disconnects while we wait, drop the request.
    stream.on("close", () => {
      if (this.pendingApproval === pending) {
        this.abandonPendingApproval();
        if (this.pairingState.phase === "pending-approval")
          this.setPairingState({ phase: "idle" });
      }
    });
    this.deps.log(`pairing request awaiting approval: ${fingerprint}`);
    this.setPairingState({
      phase: "pending-approval",
      deviceName: displayName,
      fingerprint,
    });
  }

  // The desktop user approved the device waiting in pending-approval: write
  // it to the trust store and answer the phone. No-op if nothing is pending
  // (a double click, or the phone already hung up).
  approvePairing(): void {
    const pending = this.pendingApproval;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingApproval = null;
    const now = this.deps.now?.() ?? Date.now();
    const record = this.devices.addDevice(
      pending.publicKey,
      pending.displayName,
      now,
    );
    const response: PairResponseFrame = {
      t: "paired",
      name: this.deps.deviceName,
    };
    try {
      pending.stream.write(encodeFrame(response));
      pending.stream.end();
    } catch {
      // The phone vanished between approval and the reply; the device is
      // still trusted and will connect on its next attempt.
    }
    this.deps.log(
      `paired device ${shortKey(record.publicKey)} (${record.name})`,
    );
    this.setPairingState({ phase: "paired", deviceName: record.name });
  }

  // The desktop user denied the waiting device, or the approval timed out:
  // refuse it with a clean stream close (the phone reads this as a refusal,
  // not a hang) and never write it to the trust store.
  denyPairing(reason: "denied" | "timeout" = "denied"): void {
    const pending = this.pendingApproval;
    if (!pending) return;
    this.abandonPendingApproval();
    this.deps.log(`pairing ${reason}: ${pending.fingerprint}`);
    this.setPairingState({ phase: "denied" });
  }

  // Tears down a pending approval without changing the pairing state: clears
  // its timeout and destroys its stream. Used by deny/timeout, by a new
  // request superseding an old one, and by shutdown.
  private abandonPendingApproval(): void {
    const pending = this.pendingApproval;
    if (!pending) return;
    this.pendingApproval = null;
    clearTimeout(pending.timer);
    try {
      pending.stream.destroy();
    } catch {
      // Already gone.
    }
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
    this.terminalLeases.revokeOwner(publicKeyB64);
    this.workerTerminalControls.revokeOwner(publicKeyB64);
    const sessions = this.sessions.get(publicKeyB64);
    if (sessions) {
      for (const session of sessions) {
        const timer = this.sessionHelloTimers.get(session);
        if (timer) {
          clearTimeout(timer);
          this.sessionHelloTimers.delete(session);
        }
        session.revoke();
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
      this.deps.log(
        `refused session for ${shortKey(keyB64)}: global session cap reached`,
      );
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
        this.deps.log(
          `evicting an unproven session for ${shortKey(keyB64)}: per-device cap reached`,
        );
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
    const pairedDevice = this.devices
      .list()
      .find((device) => device.publicKey === keyB64);
    let session!: RpcSession;
    const services: RemoteRpcServices = {
      device: {
        publicKey: this.identity?.publicKeyB64 ?? "",
        name: this.deps.deviceName,
        role: "computer",
        version: this.deps.appVersion,
      },
      // RpcSession installs its stream listener in the constructor; defer the
      // promotion so even an already-buffered hello runs after this session is
      // registered in the service's per-device set.
      onSessionProven: () =>
        queueMicrotask(() => this.promoteSession(keyB64, session)),
      peerDevice: {
        publicKey: keyB64,
        name: pairedDevice?.name || "Phone",
        role: "phone",
        version: "",
      },
      listWorkspaces: this.deps.listWorkspaces,
      getFleetOverview: this.deps.getFleetOverview,
      listSubscriptionProfiles: this.deps.listSubscriptionProfiles,
      listCoraModels: this.deps.listCoraModels,
      listNativeCliAccounts: this.deps.listNativeCliAccounts,
      listWorkspaceOrganization: this.deps.listWorkspaceOrganization,
      listDirectories: this.deps.listDirectories,
      addWorkspace: this.deps.addWorkspace,
      createWorkspaceGroup: this.deps.createWorkspaceGroup,
      updateWorkspaceGroup: this.deps.updateWorkspaceGroup,
      deleteWorkspaceGroup: this.deps.deleteWorkspaceGroup,
      moveWorkspace: this.deps.moveWorkspace,
      reorderWorkspaceRail: this.deps.reorderWorkspaceRail,
      listFiles: this.deps.listFiles,
      readFile: this.deps.readFile,
      createFileEntry: this.deps.createFileEntry,
      renameFileEntry: this.deps.renameFileEntry,
      moveFileEntry: this.deps.moveFileEntry
        ? (input) =>
            this.executeMutation(
              keyB64,
              input.requestId,
              "files.move",
              {
                workspaceId: input.workspaceId,
                path: input.path,
                ...(input.destinationPath !== undefined
                  ? { destinationPath: input.destinationPath }
                  : {}),
              },
              () =>
                this.deps.moveFileEntry!({
                  workspaceId: input.workspaceId,
                  path: input.path,
                  ...(input.destinationPath !== undefined
                    ? { destinationPath: input.destinationPath }
                    : {}),
                }),
            )
        : undefined,
      deleteFileEntry: this.deps.deleteFileEntry,
      getGitStatus: this.deps.getGitStatus,
      getGitLog: this.deps.getGitLog,
      getGitCommitDetail: this.deps.getGitCommitDetail,
      getGitHubStatus: this.deps.getGitHubStatus,
      getGitHubWorkQueue: this.deps.getGitHubWorkQueue,
      publishGitHub: this.deps.publishGitHub
        ? (input) =>
            this.executeMutation(
              keyB64,
              input.requestId,
              "github.publish",
              {
                workspaceId: input.workspaceId,
                input: input.input,
              },
              () =>
                this.deps.publishGitHub!({
                  workspaceId: input.workspaceId,
                  input: input.input,
                }),
            )
        : undefined,
      markGitHubReady: this.deps.markGitHubReady
        ? (input) =>
            this.executeMutation(
              keyB64,
              input.requestId,
              "github.ready",
              {
                workspaceId: input.workspaceId,
                input: input.input,
              },
              () =>
                this.deps.markGitHubReady!({
                  workspaceId: input.workspaceId,
                  input: input.input,
                }),
            )
        : undefined,
      mergeGitHub: this.deps.mergeGitHub
        ? (input) =>
            this.executeMutation(
              keyB64,
              input.requestId,
              "github.merge",
              {
                workspaceId: input.workspaceId,
                input: input.input,
              },
              () =>
                this.deps.mergeGitHub!({
                  workspaceId: input.workspaceId,
                  input: input.input,
                }),
            )
        : undefined,
      startGitHubIssue: this.deps.startGitHubIssue
        ? (input) =>
            this.executeMutation(
              keyB64,
              input.requestId,
              "github.issue.start",
              {
                sourceWorkspaceId: input.sourceWorkspaceId,
                issueNumber: input.issueNumber,
              },
              () =>
                this.deps.startGitHubIssue!({
                  sourceWorkspaceId: input.sourceWorkspaceId,
                  issueNumber: input.issueNumber,
                }),
            )
        : undefined,
      startGitHubPullRequest: this.deps.startGitHubPullRequest
        ? (input) =>
            // PR import owns a second, exact-OID transaction journal and is
            // safe to reconcile after an ambiguous remote receipt. Other
            // generic mutations remain fail-closed in executeMutation().
            this.executeRecoverableMutation(
              keyB64,
              input.requestId,
              "github.pullRequest.start",
              {
                sourceWorkspaceId: input.sourceWorkspaceId,
                repositoryUrl: input.repositoryUrl,
                pullRequestNumber: input.pullRequestNumber,
                expectedHeadCommitOid: input.expectedHeadCommitOid,
              },
              () =>
                this.deps.startGitHubPullRequest!({
                  sourceWorkspaceId: input.sourceWorkspaceId,
                  repositoryUrl: input.repositoryUrl,
                  pullRequestNumber: input.pullRequestNumber,
                  expectedHeadCommitOid: input.expectedHeadCommitOid,
                }),
            )
        : undefined,
      listCoraHistory: this.deps.listCoraHistory,
      getCoraRun: this.deps.getCoraRun,
      getCoraGraph: this.deps.getCoraGraph,
      deleteCoraRun: this.deps.deleteCoraRun
        ? (input) =>
            this.executeMutation(
              keyB64,
              input.requestId,
              "cora.delete",
              { workspaceId: input.workspaceId, runId: input.runId },
              () =>
                this.deps.deleteCoraRun!({
                  workspaceId: input.workspaceId,
                  runId: input.runId,
                }),
            )
        : undefined,
      sendCoraMessage: this.deps.sendCoraMessage,
      resumeCoraRun: this.deps.resumeCoraRun
        ? (input) =>
            this.executeRecoverableMutation(
              keyB64,
              input.requestId,
              "cora.resume",
              {
                workspaceId: input.workspaceId,
                runId: input.runId,
                recoveryId: input.recoveryId,
                account: input.account,
              },
              () =>
                this.deps.resumeCoraRun!({
                  workspaceId: input.workspaceId,
                  runId: input.runId,
                  recoveryId: input.recoveryId,
                  ...(input.account ? { account: input.account } : {}),
                }),
            )
        : undefined,
      // Idempotent state transitions with no side effect to replay: stopping a
      // stopped run or resuming a running one is a no-op, so they pass through
      // without a mutation-ledger receipt (same as automations.pause/resume).
      forcePauseCoraRun: this.deps.forcePauseCoraRun,
      resumePausedCoraRun: this.deps.resumePausedCoraRun,
      getCoraWhiteboard: this.deps.getCoraWhiteboard,
      getCoraBoard: this.deps.getCoraBoard,
      updateCoraBoard: this.deps.updateCoraBoard,
      listWorkerSessions: this.deps.listWorkerSessions,
      deleteWorkerSession: this.deps.deleteWorkerSession,
      listAutomations: this.deps.listAutomations,
      getAutomation: this.deps.getAutomation,
      runAutomation: this.deps.runAutomation,
      pauseAutomation: this.deps.pauseAutomation,
      resumeAutomation: this.deps.resumeAutomation,
      setAutomationEnabled: this.deps.setAutomationEnabled,
      registerNotifications: this.deps.registerNotifications
        ? (input) =>
            this.deps.registerNotifications!({
              ...input,
              devicePublicKey: keyB64,
            })
        : undefined,
      beginImageUpload: this.deps.beginImageUpload,
      attachWorkerTerminal: this.deps.attachWorkerTerminal,
      terminalLeases: this.terminalLeases,
      studioTerminalLeases: this.deps.studioTerminalLeases,
      workerTerminalControls: this.workerTerminalControls,
      createTerminal: (request) => this.deps.createTerminal(request),
    };
    session = new RpcSession(
      stream,
      services,
      this.deps.log,
      this.deps.now,
    );
    let set = this.sessions.get(keyB64);
    if (!set) {
      set = new Set();
      this.sessions.set(keyB64, set);
    }
    set.add(session);
    // Reap a session that authenticates but never speaks. Without this an
    // unproven phantom (a replayed IK first flight) would sit in the
    // per-device set indefinitely, taking a slot from real reconnects.
    const helloDeadline =
      this.deps.sessionHelloDeadlineMs ?? SESSION_HELLO_DEADLINE_MS;
    const helloTimer = setTimeout(() => {
      this.sessionHelloTimers.delete(session);
      if (!session.isProven()) {
        this.deps.log(
          `reaping unproven session for ${shortKey(keyB64)}: no hello within the deadline`,
        );
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

  // A phone reconnect may overlap its old, already-authenticated socket. A
  // terminal lease deliberately has one subscriber, so keeping both proven
  // sessions would let a delayed attach on the old socket steal output from
  // the new one. Last successful hello wins; unproven sessions cannot trigger
  // this promotion and therefore cannot evict a healthy phone.
  private promoteSession(keyB64: string, session: RpcSession): void {
    const set = this.sessions.get(keyB64);
    if (!set?.has(session) || !session.isProven()) return;
    const timer = this.sessionHelloTimers.get(session);
    if (timer) {
      clearTimeout(timer);
      this.sessionHelloTimers.delete(session);
    }
    for (const other of [...set]) {
      if (other !== session) this.reapSession(keyB64, other);
    }
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

  // Whether the last listener this service built still owns relay work.
  isRelayActive(): boolean {
    return this.relayActive;
  }
}

function plainLanguageStartError(err: Error): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE")
    return "The listening port is already in use by another app.";
  if (code === "EACCES")
    return "The system refused to open the listening port.";
  return err.message || "Remote access could not start.";
}
