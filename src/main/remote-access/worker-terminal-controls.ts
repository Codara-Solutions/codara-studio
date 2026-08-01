import { createHash, randomUUID } from "node:crypto";

import type { RemoteTerminalHandle } from "./rpc";

export const WORKER_TERMINAL_CONTROL_TTL_MS = 45_000;
const MAX_INPUT_RECEIPTS = 128;

export interface WorkerTerminalControlLease {
  controlLeaseId: string;
  nextInputSequence: number;
  expiresAt: number;
}

export interface RemoteWorkerTerminalControlStore {
  acquire(
    ownerKey: string,
    holderId: string,
    targetId: string,
  ): WorkerTerminalControlLease;
  write(
    ownerKey: string,
    holderId: string,
    targetId: string,
    controlLeaseId: string,
    inputSequence: number,
    data: string,
    handle: RemoteTerminalHandle,
  ): WorkerTerminalControlLease;
  resize(
    ownerKey: string,
    holderId: string,
    targetId: string,
    controlLeaseId: string,
    cols: number,
    rows: number,
    handle: RemoteTerminalHandle,
  ): Promise<WorkerTerminalControlLease>;
  release(
    ownerKey: string,
    holderId: string,
    targetId: string,
    controlLeaseId: string,
  ): void;
  releaseHolder(holderId: string): void;
  revokeOwner(ownerKey: string): void;
  shutdown(): void;
}

interface ActiveControlLease extends WorkerTerminalControlLease {
  ownerKey: string;
  holderId: string;
  targetId: string;
  receipts: Map<
    number,
    { digest: string; outcome: "pending" | "done" | "unknown" }
  >;
  timer: NodeJS.Timeout;
}

function controlError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function digestInput(data: string): string {
  return createHash("sha256").update(data).digest("base64url");
}

/**
 * Process-scoped, authenticated single-controller fencing for automation
 * worker PTYs. A mirror remains readable without a lease; only the session
 * holding this short, renewable lease may send input or resize the worker.
 */
export class WorkerTerminalControlRegistry
  implements RemoteWorkerTerminalControlStore
{
  private readonly leases = new Map<string, ActiveControlLease>();

  constructor(
    private readonly options: {
      now?: () => number;
      ttlMs?: number;
      log?: (line: string) => void;
    } = {},
  ) {}

  acquire(
    ownerKey: string,
    holderId: string,
    targetId: string,
  ): WorkerTerminalControlLease {
    this.pruneExpired(targetId);
    const current = this.leases.get(targetId);
    if (current) {
      if (current.ownerKey !== ownerKey || current.holderId !== holderId) {
        throw controlError(
          "WORKER_TERMINAL_CONTROL_BUSY",
          "This worker terminal is already controlled from another phone.",
        );
      }
      this.touch(current);
      return this.describe(current);
    }

    const lease: ActiveControlLease = {
      ownerKey,
      holderId,
      targetId,
      controlLeaseId: `wtc-${randomUUID()}`,
      nextInputSequence: 1,
      expiresAt: 0,
      receipts: new Map(),
      timer: setTimeout(() => undefined, 1),
    };
    clearTimeout(lease.timer);
    this.touch(lease);
    this.leases.set(targetId, lease);
    this.options.log?.(`worker terminal control acquired for ${targetId}`);
    return this.describe(lease);
  }

  write(
    ownerKey: string,
    holderId: string,
    targetId: string,
    controlLeaseId: string,
    inputSequence: number,
    data: string,
    handle: RemoteTerminalHandle,
  ): WorkerTerminalControlLease {
    const lease = this.requireLease(
      ownerKey,
      holderId,
      targetId,
      controlLeaseId,
    );
    const digest = digestInput(data);
    if (inputSequence < lease.nextInputSequence) {
      const receipt = lease.receipts.get(inputSequence);
      if (!receipt || receipt.digest !== digest) {
        throw controlError(
          "WORKER_TERMINAL_INPUT_CONFLICT",
          "That worker input sequence was already used for different data.",
        );
      }
      if (receipt.outcome !== "done") {
        throw controlError(
          "WORKER_TERMINAL_INPUT_OUTCOME_UNKNOWN",
          "That worker input may have been delivered. Check its output before sending more.",
        );
      }
      this.touch(lease);
      return this.describe(lease);
    }
    if (inputSequence !== lease.nextInputSequence) {
      throw controlError(
        "WORKER_TERMINAL_INPUT_GAP",
        `Worker input ${inputSequence} cannot follow ${lease.nextInputSequence - 1}.`,
      );
    }

    // Consume and fingerprint the sequence before delivery. If an adapter
    // accepts the input and then throws, a retry must never type it twice.
    const receipt = { digest, outcome: "pending" as const };
    lease.receipts.set(inputSequence, receipt);
    lease.nextInputSequence += 1;
    try {
      handle.write(data);
      lease.receipts.set(inputSequence, { digest, outcome: "done" });
    } catch {
      lease.receipts.set(inputSequence, { digest, outcome: "unknown" });
      this.touch(lease);
      throw controlError(
        "WORKER_TERMINAL_INPUT_OUTCOME_UNKNOWN",
        "That worker input may have been delivered. Check its output before sending more.",
      );
    }
    while (lease.receipts.size > MAX_INPUT_RECEIPTS) {
      const oldest = lease.receipts.keys().next().value;
      if (typeof oldest !== "number") break;
      lease.receipts.delete(oldest);
    }
    this.touch(lease);
    return this.describe(lease);
  }

  async resize(
    ownerKey: string,
    holderId: string,
    targetId: string,
    controlLeaseId: string,
    cols: number,
    rows: number,
    handle: RemoteTerminalHandle,
  ): Promise<WorkerTerminalControlLease> {
    const lease = this.requireLease(
      ownerKey,
      holderId,
      targetId,
      controlLeaseId,
    );
    await handle.resize(cols, rows);
    this.touch(lease);
    return this.describe(lease);
  }

  release(
    ownerKey: string,
    holderId: string,
    targetId: string,
    controlLeaseId: string,
  ): void {
    const lease = this.leases.get(targetId);
    if (!lease) return;
    if (
      lease.ownerKey !== ownerKey ||
      lease.holderId !== holderId ||
      lease.controlLeaseId !== controlLeaseId
    ) {
      throw controlError(
        "WORKER_TERMINAL_CONTROL_LOST",
        "Worker terminal control has moved to another session.",
      );
    }
    this.drop(targetId, lease);
  }

  releaseHolder(holderId: string): void {
    for (const [targetId, lease] of this.leases) {
      if (lease.holderId === holderId) this.drop(targetId, lease);
    }
  }

  revokeOwner(ownerKey: string): void {
    for (const [targetId, lease] of this.leases) {
      if (lease.ownerKey === ownerKey) this.drop(targetId, lease);
    }
  }

  shutdown(): void {
    for (const [targetId, lease] of this.leases) this.drop(targetId, lease);
  }

  private requireLease(
    ownerKey: string,
    holderId: string,
    targetId: string,
    controlLeaseId: string,
  ): ActiveControlLease {
    this.pruneExpired(targetId);
    const lease = this.leases.get(targetId);
    if (
      !lease ||
      lease.ownerKey !== ownerKey ||
      lease.holderId !== holderId ||
      lease.controlLeaseId !== controlLeaseId
    ) {
      throw controlError(
        "WORKER_TERMINAL_CONTROL_LOST",
        "Worker terminal control expired or moved to another session.",
      );
    }
    return lease;
  }

  private touch(lease: ActiveControlLease): void {
    clearTimeout(lease.timer);
    lease.expiresAt = this.now() + this.ttlMs();
    lease.timer = setTimeout(() => {
      if (this.leases.get(lease.targetId) === lease) {
        this.drop(lease.targetId, lease);
      }
    }, this.ttlMs());
    lease.timer.unref?.();
  }

  private pruneExpired(targetId: string): void {
    const lease = this.leases.get(targetId);
    if (lease && lease.expiresAt <= this.now()) this.drop(targetId, lease);
  }

  private drop(targetId: string, lease: ActiveControlLease): void {
    if (this.leases.get(targetId) !== lease) return;
    clearTimeout(lease.timer);
    this.leases.delete(targetId);
    this.options.log?.(`worker terminal control released for ${targetId}`);
  }

  private describe(lease: ActiveControlLease): WorkerTerminalControlLease {
    return {
      controlLeaseId: lease.controlLeaseId,
      nextInputSequence: lease.nextInputSequence,
      expiresAt: lease.expiresAt,
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private ttlMs(): number {
    return this.options.ttlMs ?? WORKER_TERMINAL_CONTROL_TTL_MS;
  }
}
