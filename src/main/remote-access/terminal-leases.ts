import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import type {
  RemoteTerminalCreateRequest,
  RemoteTerminalHandle,
} from "./rpc";

export type RemoteTerminalLeaseKind = "interactive";
export type RemoteTerminalLeasePhase = "starting" | "live" | "ended";

export interface RemoteTerminalLeaseDescriptor {
  terminalId: string;
  workspaceId: string;
  kind: RemoteTerminalLeaseKind;
  phase: RemoteTerminalLeasePhase;
  profile: RemoteTerminalCreateRequest["profile"];
  desktopTabId?: string;
  title?: string;
  cols: number;
  rows: number;
  createdAt: number;
  sequence: number;
  nextInputSequence: number;
  expiresAt?: number;
  /** Studio terminals are borrowed: closing the phone view never kills them. */
  origin?: "phone" | "studio";
  closeable?: boolean;
}

export interface RemoteTerminalReplayChunk {
  sequence: number;
  data: string;
}

export interface RemoteTerminalLeaseAttachResult {
  terminal: RemoteTerminalLeaseDescriptor;
  replay: RemoteTerminalReplayChunk[];
  truncated: boolean;
  attachmentId: string;
}

export interface RemoteTerminalLeaseSubscriber {
  onData(event: {
    terminalId: string;
    sequence: number;
    data: string;
  }): void;
  onExit(event: { terminalId: string; sequence: number }): void;
}

export interface RemoteTerminalLeaseStore {
  createInteractive(
    ownerKey: string,
    requestId: string,
    request: Omit<RemoteTerminalCreateRequest, "onData" | "onExit">,
  ): Promise<RemoteTerminalLeaseDescriptor>;
  list(
    ownerKey: string,
  ): RemoteTerminalLeaseDescriptor[] | Promise<RemoteTerminalLeaseDescriptor[]>;
  attach(
    ownerKey: string,
    terminalId: string,
    afterSequence: number,
    subscriberId: string,
    subscriber: RemoteTerminalLeaseSubscriber,
  ): RemoteTerminalLeaseAttachResult;
  detach(
    ownerKey: string,
    terminalId: string,
    subscriberId: string,
    attachmentId: string,
  ): void;
  detachSubscriber(subscriberId: string): void;
  write(
    ownerKey: string,
    terminalId: string,
    subscriberId: string,
    attachmentId: string,
    inputSequence: number,
    data: string,
  ): void;
  resize(
    ownerKey: string,
    terminalId: string,
    subscriberId: string,
    attachmentId: string,
    cols: number,
    rows: number,
  ): void | Promise<void>;
  close(
    ownerKey: string,
    terminalId: string,
    subscriberId: string,
    attachmentId: string,
    requestId: string,
  ): void;
  revokeOwner(ownerKey: string): void;
  shutdown(): void;
}

interface ReplayEntry {
  sequence: number;
  data: string;
  bytes: number;
}

interface TerminalLease {
  descriptor: RemoteTerminalLeaseDescriptor;
  ownerKey: string;
  handle: RemoteTerminalHandle | null;
  replay: ReplayEntry[];
  replayBytes: number;
  subscriber: {
    subscriberId: string;
    attachmentId: string;
    callbacks: RemoteTerminalLeaseSubscriber;
  } | null;
  acceptedInputs: Map<number, string>;
  resizeTail: Promise<void>;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  removed: boolean;
}

export interface RemoteTerminalLeaseRegistryOptions {
  createTerminal(
    request: RemoteTerminalCreateRequest,
  ): Promise<RemoteTerminalHandle>;
  now?: () => number;
  log?: (line: string) => void;
  detachedTtlMs?: number;
  endedTtlMs?: number;
  maxReplayBytes?: number;
  maxPerOwner?: number;
  maxTotal?: number;
}

interface TerminalCreateReceipt {
  fingerprint: string;
  promise: Promise<RemoteTerminalLeaseDescriptor>;
  terminalId: string | null;
  expiresAt: number;
}

interface TerminalCloseReceipt {
  terminalId: string;
  expiresAt: number;
}

// A mobile connection may disappear during a LAN/relay handoff without a FIN.
// Keep its PTY alive long enough for the authenticated device to reconnect,
// while bounding both retained output and process count.
export const REMOTE_TERMINAL_DETACHED_TTL_MS = 30 * 60 * 1_000;
export const REMOTE_TERMINAL_ENDED_TTL_MS = 5 * 60 * 1_000;
export const MAX_REMOTE_TERMINAL_REPLAY_BYTES = 256 * 1024;
export const MAX_REMOTE_TERMINALS_PER_DEVICE = 8;
export const MAX_REMOTE_TERMINALS_TOTAL = 64;
const MAX_REPLAY_CHUNK_BYTES = 64 * 1024;
const TERMINAL_CREATE_RECEIPT_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_TERMINAL_CREATE_RECEIPTS_PER_OWNER = 256;

export class RemoteTerminalLeaseRegistry
  implements RemoteTerminalLeaseStore
{
  private readonly leases = new Map<string, TerminalLease>();
  private readonly createReceipts = new Map<
    string,
    Map<string, TerminalCreateReceipt>
  >();
  private readonly closeReceipts = new Map<
    string,
    Map<string, TerminalCloseReceipt>
  >();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly detachedTtlMs: number;
  private readonly endedTtlMs: number;
  private readonly maxReplayBytes: number;
  private readonly maxPerOwner: number;
  private readonly maxTotal: number;

  constructor(private readonly options: RemoteTerminalLeaseRegistryOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.detachedTtlMs =
      options.detachedTtlMs ?? REMOTE_TERMINAL_DETACHED_TTL_MS;
    this.endedTtlMs = options.endedTtlMs ?? REMOTE_TERMINAL_ENDED_TTL_MS;
    this.maxReplayBytes = Math.max(
      1,
      options.maxReplayBytes ?? MAX_REMOTE_TERMINAL_REPLAY_BYTES,
    );
    this.maxPerOwner =
      options.maxPerOwner ?? MAX_REMOTE_TERMINALS_PER_DEVICE;
    this.maxTotal = options.maxTotal ?? MAX_REMOTE_TERMINALS_TOTAL;
  }

  async createInteractive(
    ownerKey: string,
    requestId: string,
    request: Omit<RemoteTerminalCreateRequest, "onData" | "onExit">,
  ): Promise<RemoteTerminalLeaseDescriptor> {
    if (!isRequestId(requestId)) {
      throw terminalLeaseError(
        "INVALID_TERMINAL_CREATE_REQUEST",
        "A valid terminal create request id is required.",
      );
    }
    const fingerprint = createFingerprint(request);
    const receipts = this.receiptsFor(ownerKey);
    this.pruneReceipts(receipts);
    const existing = receipts.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw terminalLeaseError(
          "TERMINAL_CREATE_CONFLICT",
          "That terminal create request id was already used for different input.",
        );
      }
      await existing.promise;
      if (!existing.terminalId || !this.leases.has(existing.terminalId)) {
        throw terminalLeaseError(
          "TERMINAL_CREATE_GONE",
          "That terminal create request already completed, but its terminal is no longer available.",
        );
      }
      return copyDescriptor(
        this.leases.get(existing.terminalId)!.descriptor,
      );
    }
    if (receipts.size >= MAX_TERMINAL_CREATE_RECEIPTS_PER_OWNER) {
      throw terminalLeaseError(
        "TERMINAL_CREATE_RECEIPT_CAP",
        "This phone has created too many terminals recently. Wait for older retry receipts to expire.",
      );
    }
    this.assertCreateCapacity(ownerKey);
    const lease = this.insertLease(ownerKey, {
      terminalId: `rt-${randomUUID()}`,
      workspaceId: request.workspaceId,
      kind: "interactive",
      phase: "starting",
      profile: request.profile,
      title: request.title,
      cols: request.cols,
      rows: request.rows,
      createdAt: this.now(),
      sequence: 0,
      nextInputSequence: 1,
    });
    const promise = (async () => {
      try {
        const handle = await this.options.createTerminal({
          ...request,
          onData: (data) => this.recordData(lease, data),
          onExit: () => this.recordExit(lease),
        });
        if (lease.removed || lease.descriptor.phase === "ended") {
          try {
            handle.close();
          } catch {
            // The lease was revoked or exited while the renderer was spawning.
          }
          throw new Error("The terminal lease ended before it was ready.");
        }
        const desktopTabId = boundedMetadata(handle.desktopTabId, 256);
        const title = boundedMetadata(handle.title, 240);
        lease.handle = handle;
        lease.descriptor = {
          ...lease.descriptor,
          phase: "live",
          ...(desktopTabId ? { desktopTabId } : {}),
          ...(title ? { title } : {}),
        };
        this.scheduleExpiryIfDetached(lease);
        return copyDescriptor(lease.descriptor);
      } catch (cause) {
        this.removeLease(lease, false);
        // Validation and a confirmed spawn failure have no retained PTY, so
        // the same stable request id is safe to try again. A create timeout
        // after the renderer may have acted is different: retain that rejected
        // receipt so a retry can never spawn a second shell.
        if (
          (cause as { code?: unknown }).code !==
          "REMOTE_TERMINAL_CREATE_OUTCOME_UNKNOWN"
        ) {
          const current = receipts.get(requestId);
          if (
            current?.terminalId === lease.descriptor.terminalId
          ) {
            receipts.delete(requestId);
          }
        }
        throw cause;
      }
    })();
    const receipt: TerminalCreateReceipt = {
      fingerprint,
      promise,
      terminalId: lease.descriptor.terminalId,
      expiresAt: this.now() + TERMINAL_CREATE_RECEIPT_TTL_MS,
    };
    receipts.set(requestId, receipt);
    this.pruneReceipts(receipts);
    return promise;
  }

  list(ownerKey: string): RemoteTerminalLeaseDescriptor[] {
    return [...this.leases.values()]
      .filter((lease) => lease.ownerKey === ownerKey && !lease.removed)
      .sort(
        (left, right) =>
          left.descriptor.createdAt - right.descriptor.createdAt ||
          left.descriptor.terminalId.localeCompare(right.descriptor.terminalId),
      )
      .map((lease) => copyDescriptor(lease.descriptor));
  }

  attach(
    ownerKey: string,
    terminalId: string,
    afterSequence: number,
    subscriberId: string,
    subscriber: RemoteTerminalLeaseSubscriber,
  ): RemoteTerminalLeaseAttachResult {
    const lease = this.requireOwned(ownerKey, terminalId);
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      afterSequence > lease.descriptor.sequence
    ) {
      throw terminalLeaseError(
        "INVALID_TERMINAL_CURSOR",
        "That terminal resume cursor is not valid.",
      );
    }
    if (lease.expiryTimer && lease.descriptor.phase !== "ended") {
      clearTimeout(lease.expiryTimer);
      lease.expiryTimer = null;
      lease.descriptor = { ...lease.descriptor, expiresAt: undefined };
    }
    const attachmentId = `ta-${randomUUID()}`;
    lease.subscriber = {
      subscriberId,
      attachmentId,
      callbacks: subscriber,
    };
    const oldestSequence = lease.replay[0]?.sequence;
    const truncated =
      oldestSequence !== undefined && afterSequence < oldestSequence - 1;
    return {
      terminal: copyDescriptor(lease.descriptor),
      replay: lease.replay
        .filter((entry) => entry.sequence > afterSequence)
        .map((entry) => ({ sequence: entry.sequence, data: entry.data })),
      truncated,
      attachmentId,
    };
  }

  detach(
    ownerKey: string,
    terminalId: string,
    subscriberId: string,
    attachmentId: string,
  ): void {
    const lease = this.requireOwned(ownerKey, terminalId);
    if (
      lease.subscriber?.subscriberId === subscriberId &&
      lease.subscriber.attachmentId === attachmentId
    ) {
      lease.subscriber = null;
    }
    this.scheduleExpiryIfDetached(lease);
  }

  detachSubscriber(subscriberId: string): void {
    for (const lease of this.leases.values()) {
      if (lease.subscriber?.subscriberId !== subscriberId) continue;
      lease.subscriber = null;
      this.scheduleExpiryIfDetached(lease);
    }
  }

  write(
    ownerKey: string,
    terminalId: string,
    subscriberId: string,
    attachmentId: string,
    inputSequence: number,
    data: string,
  ): void {
    const lease = this.requireAttached(
      ownerKey,
      terminalId,
      subscriberId,
      attachmentId,
      true,
    );
    if (!Number.isSafeInteger(inputSequence) || inputSequence <= 0) {
      throw terminalLeaseError(
        "INVALID_TERMINAL_INPUT_SEQUENCE",
        "That terminal input sequence is not valid.",
      );
    }
    const fingerprint = createHash("sha256")
      .update(data)
      .digest("base64url");
    if (inputSequence < lease.descriptor.nextInputSequence) {
      const accepted = lease.acceptedInputs.get(inputSequence);
      if (accepted !== undefined && accepted !== fingerprint) {
        throw terminalLeaseError(
          "TERMINAL_INPUT_CONFLICT",
          "That terminal input sequence was already used for different data.",
        );
      }
      return;
    }
    if (inputSequence > lease.descriptor.nextInputSequence) {
      throw terminalLeaseError(
        "TERMINAL_INPUT_GAP",
        "Terminal input arrived out of order. Reattach before retrying.",
      );
    }
    lease.descriptor = {
      ...lease.descriptor,
      nextInputSequence: inputSequence + 1,
    };
    lease.acceptedInputs.set(inputSequence, fingerprint);
    while (lease.acceptedInputs.size > 256) {
      const oldest = lease.acceptedInputs.keys().next().value;
      if (typeof oldest !== "number") break;
      lease.acceptedInputs.delete(oldest);
    }
    try {
      lease.handle!.write(data);
    } catch {
      throw terminalLeaseError(
        "TERMINAL_INPUT_OUTCOME_UNKNOWN",
        "Terminal input may have been delivered. Reattach before sending more input.",
      );
    }
  }

  async resize(
    ownerKey: string,
    terminalId: string,
    subscriberId: string,
    attachmentId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    const lease = this.requireAttached(
      ownerKey,
      terminalId,
      subscriberId,
      attachmentId,
      true,
    );
    const operation = lease.resizeTail
      .catch(() => undefined)
      .then(async () => {
        // Revalidate immediately before touching the PTY. An attachment can
        // be superseded while this request is waiting behind an older resize.
        const current = this.requireAttached(
          ownerKey,
          terminalId,
          subscriberId,
          attachmentId,
          true,
        );
        await current.handle!.resize(cols, rows);
        if (current.removed || current.descriptor.phase !== "live") return;
        if (
          current.subscriber?.subscriberId !== subscriberId ||
          current.subscriber.attachmentId !== attachmentId
        ) {
          // The handoff happened while the native resize was in flight. Put
          // the real PTY back at the last published geometry; any resize from
          // the newer attachment is serialized behind this restoration.
          await current.handle?.resize(
            current.descriptor.cols,
            current.descriptor.rows,
          );
          throw terminalLeaseError(
            "STALE_TERMINAL_ATTACHMENT",
            "This terminal moved to a newer connection. Reattach before continuing.",
          );
        }
        current.descriptor = { ...current.descriptor, cols, rows };
      });
    lease.resizeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  close(
    ownerKey: string,
    terminalId: string,
    subscriberId: string,
    attachmentId: string,
    requestId: string,
  ): void {
    if (!isRequestId(requestId)) {
      throw terminalLeaseError(
        "INVALID_TERMINAL_CLOSE_REQUEST",
        "A valid terminal close request id is required.",
      );
    }
    const receipts = this.closeReceiptsFor(ownerKey);
    this.pruneCloseReceipts(receipts);
    const existing = receipts.get(requestId);
    if (existing) {
      if (existing.terminalId !== terminalId) {
        throw terminalLeaseError(
          "TERMINAL_CLOSE_CONFLICT",
          "That terminal close request id was already used for another terminal.",
        );
      }
      return;
    }
    if (receipts.size >= MAX_TERMINAL_CREATE_RECEIPTS_PER_OWNER) {
      throw terminalLeaseError(
        "TERMINAL_CLOSE_RECEIPT_CAP",
        "This phone has closed too many terminals recently. Wait for older retry receipts to expire.",
      );
    }
    const lease = this.requireAttached(
      ownerKey,
      terminalId,
      subscriberId,
      attachmentId,
      false,
    );
    receipts.set(requestId, {
      terminalId,
      expiresAt: this.now() + TERMINAL_CREATE_RECEIPT_TTL_MS,
    });
    if (lease.descriptor.phase !== "ended") this.recordExit(lease);
    this.removeLease(lease, true);
  }

  revokeOwner(ownerKey: string): void {
    for (const lease of [...this.leases.values()]) {
      if (lease.ownerKey === ownerKey) this.removeLease(lease, true);
    }
    this.createReceipts.delete(ownerKey);
    this.closeReceipts.delete(ownerKey);
  }

  shutdown(): void {
    for (const lease of [...this.leases.values()]) {
      this.removeLease(lease, true);
    }
    this.createReceipts.clear();
    this.closeReceipts.clear();
  }

  private insertLease(
    ownerKey: string,
    descriptor: RemoteTerminalLeaseDescriptor,
  ): TerminalLease {
    const lease: TerminalLease = {
      descriptor,
      ownerKey,
      handle: null,
      replay: [],
      replayBytes: 0,
      subscriber: null,
      acceptedInputs: new Map(),
      resizeTail: Promise.resolve(),
      expiryTimer: null,
      removed: false,
    };
    this.leases.set(descriptor.terminalId, lease);
    return lease;
  }

  private recordData(lease: TerminalLease, data: string): void {
    // Some PTY adapters can deliver a queued data callback after their exit
    // callback. Exit is the terminal's final sequence boundary; accepting
    // bytes after it would make an ended descriptor impossible to replay
    // contiguously on the phone.
    if (lease.removed || lease.descriptor.phase === "ended" || !data) return;
    for (const chunk of utf8Chunks(
      data,
      Math.min(MAX_REPLAY_CHUNK_BYTES, this.maxReplayBytes),
    )) {
      const bytes = Buffer.byteLength(chunk, "utf8");
      const sequence = lease.descriptor.sequence + 1;
      lease.descriptor = { ...lease.descriptor, sequence };
      lease.replay.push({ sequence, data: chunk, bytes });
      lease.replayBytes += bytes;
      while (
        lease.replayBytes > this.maxReplayBytes &&
        lease.replay.length > 1
      ) {
        const removed = lease.replay.shift();
        if (removed) lease.replayBytes -= removed.bytes;
      }
      const subscriber = lease.subscriber?.callbacks;
      if (subscriber) {
        try {
          subscriber.onData({
            terminalId: lease.descriptor.terminalId,
            sequence,
            data: chunk,
          });
        } catch {
          // A dead RPC session detaches on teardown; one subscriber may not
          // interrupt delivery to the others.
        }
      }
    }
  }

  private recordExit(lease: TerminalLease): void {
    if (lease.removed || lease.descriptor.phase === "ended") return;
    const sequence = lease.descriptor.sequence + 1;
    lease.descriptor = { ...lease.descriptor, phase: "ended", sequence };
    const subscriber = lease.subscriber?.callbacks;
    if (subscriber) {
      try {
        subscriber.onExit({
          terminalId: lease.descriptor.terminalId,
          sequence,
        });
      } catch {
        // See recordData.
      }
    }
    if (lease.expiryTimer) {
      clearTimeout(lease.expiryTimer);
      lease.expiryTimer = null;
    }
    this.scheduleExpiryIfDetached(lease);
  }

  private scheduleExpiryIfDetached(lease: TerminalLease): void {
    if (
      lease.removed ||
      (lease.subscriber && lease.descriptor.phase !== "ended") ||
      lease.expiryTimer
    ) {
      return;
    }
    const ttl =
      lease.descriptor.phase === "ended"
        ? this.endedTtlMs
        : this.detachedTtlMs;
    const expiresAt = this.now() + ttl;
    lease.descriptor = { ...lease.descriptor, expiresAt };
    lease.expiryTimer = setTimeout(() => {
      lease.expiryTimer = null;
      if (
        (lease.subscriber && lease.descriptor.phase !== "ended") ||
        lease.removed
      ) {
        return;
      }
      this.log(
        `expired detached remote terminal ${lease.descriptor.terminalId}`,
      );
      this.removeLease(lease, true);
    }, ttl);
    lease.expiryTimer.unref?.();
  }

  private removeLease(lease: TerminalLease, closeHandle: boolean): void {
    if (lease.removed) return;
    lease.removed = true;
    this.leases.delete(lease.descriptor.terminalId);
    if (lease.expiryTimer) clearTimeout(lease.expiryTimer);
    lease.expiryTimer = null;
    lease.subscriber = null;
    const handle = lease.handle;
    lease.handle = null;
    if (closeHandle && handle) {
      try {
        handle.close();
      } catch {
        // Best effort during expiry/revoke/shutdown.
      }
    }
  }

  private requireOwned(ownerKey: string, terminalId: string): TerminalLease {
    const lease = this.leases.get(terminalId);
    if (!lease || lease.removed || lease.ownerKey !== ownerKey) {
      throw terminalLeaseError(
        "UNKNOWN_REMOTE_TERMINAL",
        "That remote terminal is no longer available.",
      );
    }
    return lease;
  }

  private requireLive(ownerKey: string, terminalId: string): TerminalLease {
    const lease = this.requireOwned(ownerKey, terminalId);
    if (lease.descriptor.phase !== "live" || !lease.handle) {
      throw terminalLeaseError(
        "REMOTE_TERMINAL_ENDED",
        "That remote terminal has already ended.",
      );
    }
    return lease;
  }

  private requireAttached(
    ownerKey: string,
    terminalId: string,
    subscriberId: string,
    attachmentId: string,
    requireLive: boolean,
  ): TerminalLease {
    const lease = requireLive
      ? this.requireLive(ownerKey, terminalId)
      : this.requireOwned(ownerKey, terminalId);
    if (
      lease.subscriber?.subscriberId !== subscriberId ||
      lease.subscriber.attachmentId !== attachmentId
    ) {
      throw terminalLeaseError(
        "STALE_TERMINAL_ATTACHMENT",
        "This terminal moved to a newer connection. Reattach before continuing.",
      );
    }
    return lease;
  }

  private assertCreateCapacity(ownerKey: string): void {
    let ownerLive = 0;
    let totalLive = 0;
    for (const lease of this.leases.values()) {
      totalLive += 1;
      if (lease.ownerKey === ownerKey) ownerLive += 1;
    }
    if (ownerLive >= this.maxPerOwner) {
      throw terminalLeaseError(
        "REMOTE_TERMINAL_DEVICE_CAP",
        `This phone already has ${this.maxPerOwner} remote terminals open.`,
      );
    }
    if (totalLive >= this.maxTotal) {
      throw terminalLeaseError(
        "REMOTE_TERMINAL_GLOBAL_CAP",
        "Codara has reached its remote terminal limit.",
      );
    }
  }

  private receiptsFor(ownerKey: string): Map<string, TerminalCreateReceipt> {
    let receipts = this.createReceipts.get(ownerKey);
    if (!receipts) {
      receipts = new Map();
      this.createReceipts.set(ownerKey, receipts);
    }
    return receipts;
  }

  private pruneReceipts(
    receipts: Map<string, TerminalCreateReceipt>,
  ): void {
    const now = this.now();
    for (const [requestId, receipt] of receipts) {
      if (
        receipt.expiresAt <= now &&
        (!receipt.terminalId || !this.leases.has(receipt.terminalId))
      ) {
        receipts.delete(requestId);
      }
    }
  }

  private closeReceiptsFor(
    ownerKey: string,
  ): Map<string, TerminalCloseReceipt> {
    let receipts = this.closeReceipts.get(ownerKey);
    if (!receipts) {
      receipts = new Map();
      this.closeReceipts.set(ownerKey, receipts);
    }
    return receipts;
  }

  private pruneCloseReceipts(
    receipts: Map<string, TerminalCloseReceipt>,
  ): void {
    const now = this.now();
    for (const [requestId, receipt] of receipts) {
      if (receipt.expiresAt <= now) receipts.delete(requestId);
    }
  }
}

function terminalLeaseError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function copyDescriptor(
  descriptor: RemoteTerminalLeaseDescriptor,
): RemoteTerminalLeaseDescriptor {
  return { ...descriptor };
}

function isRequestId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(value);
}

function boundedMetadata(
  value: string | undefined,
  maxLength: number,
): string | null {
  if (!value) return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean ? clean.slice(0, maxLength) : null;
}

function createFingerprint(
  request: Omit<RemoteTerminalCreateRequest, "onData" | "onExit">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: request.workspaceId,
        cols: request.cols,
        rows: request.rows,
        cwd: request.cwd ?? null,
        profile: request.profile,
        resumeSessionId: request.resumeSessionId ?? null,
        title: request.title ?? null,
      }),
    )
    .digest("base64url");
}

function utf8Chunks(value: string, maxBytes: number): string[] {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return [value];
  const chunks: string[] = [];
  const decoder = new StringDecoder("utf8");
  for (let offset = 0; offset < bytes.length; offset += maxBytes) {
    const chunk = decoder.write(
      bytes.subarray(offset, Math.min(bytes.length, offset + maxBytes)),
    );
    if (chunk) chunks.push(chunk);
  }
  const final = decoder.end();
  if (final) chunks.push(final);
  return chunks;
}
