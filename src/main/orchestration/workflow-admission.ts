// Machine-wide admission for workflow agents. Every live workflow run asks
// this one controller before it launches an agent, so the slot count, the
// heavy-work count and the memory gate hold across all runs together: two
// runs with concurrency 6 each still never put more than `machineSlots`
// agents on the machine. Pure apart from the injected memory sampler and
// timer, so the suite drives it with fakes.

import type { WorkflowWaitReason } from "@shared/workflow";

export interface MemorySample {
  totalBytes: number;
  availableBytes: number;
  swapUsedBytes: number;
}

export interface WorkflowAdmissionOptions {
  machineSlots: number;
  heavySlots: number;
  /** Null disables the memory gate (no reading available). */
  sampleMemory?: () => MemorySample | null;
  /** Free memory below this holds new launches. Default max(4 GB, 15% of RAM). */
  reserveBytes?: number;
  /** Swap growth since the controller went busy that holds new launches. */
  swapGrowthBytes?: number;
  recheckMs?: number;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

export interface AdmissionLease {
  release(): void;
}

export interface AdmissionTicket {
  granted: Promise<AdmissionLease>;
  /** Withdraws a waiting request; a granted lease must be released instead. */
  cancel(): void;
}

interface Waiter {
  runId: string;
  heavy: boolean;
  onWait: (reason: WorkflowWaitReason | null) => void;
  resolve: (lease: AdmissionLease) => void;
  reason: WorkflowWaitReason | null;
}

const GB = 1024 * 1024 * 1024;

export function defaultReserveBytes(totalBytes: number): number {
  return Math.max(4 * GB, Math.floor(totalBytes * 0.15));
}

export class WorkflowAdmission {
  private machineSlots: number;
  private heavySlots: number;
  private active = 0;
  private activeHeavy = 0;
  private readonly queue: Waiter[] = [];
  private swapBaseline: number | null = null;
  private cancelTimer: (() => void) | null = null;
  private lastMemory: { freeBytes: number; reserveBytes: number } | null = null;

  constructor(private readonly options: WorkflowAdmissionOptions) {
    this.machineSlots = Math.max(1, Math.floor(options.machineSlots));
    this.heavySlots = Math.max(1, Math.floor(options.heavySlots));
  }

  configure(limits: { machineSlots?: number; heavySlots?: number }): void {
    if (limits.machineSlots !== undefined) this.machineSlots = Math.max(1, Math.floor(limits.machineSlots));
    if (limits.heavySlots !== undefined) this.heavySlots = Math.max(1, Math.floor(limits.heavySlots));
    this.pump();
  }

  get usage(): { active: number; heavy: number; waiting: number } {
    return { active: this.active, heavy: this.activeHeavy, waiting: this.queue.length };
  }

  /** The memory reading that holds launches right now, if it does. */
  get memoryWait(): { freeBytes: number; reserveBytes: number } | null {
    return this.lastMemory;
  }

  request(input: {
    runId: string;
    heavy: boolean;
    onWait?: (reason: WorkflowWaitReason | null) => void;
  }): AdmissionTicket {
    let waiter: Waiter | null = null;
    const granted = new Promise<AdmissionLease>((resolve) => {
      waiter = {
        runId: input.runId,
        heavy: input.heavy,
        onWait: input.onWait ?? (() => undefined),
        resolve,
        reason: null,
      };
    });
    const entry = waiter as unknown as Waiter;
    this.queue.push(entry);
    this.pump();
    return {
      granted,
      cancel: () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) {
          this.queue.splice(index, 1);
          this.pump();
        }
      },
    };
  }

  private memoryOpen(): boolean {
    const sample = this.options.sampleMemory?.() ?? null;
    if (!sample) {
      this.lastMemory = null;
      return true;
    }
    const reserve = this.options.reserveBytes ?? defaultReserveBytes(sample.totalBytes);
    if (this.swapBaseline === null) this.swapBaseline = sample.swapUsedBytes;
    const swapGrowth = sample.swapUsedBytes - this.swapBaseline;
    const swapLimit = this.options.swapGrowthBytes ?? 512 * 1024 * 1024;
    // With nothing of ours running, holding would only wait for someone
    // else's memory to come back; the first agent always goes, so a busy
    // machine slows a run down instead of parking it forever.
    if (this.active === 0) {
      this.lastMemory = null;
      return true;
    }
    if (sample.availableBytes < reserve || swapGrowth > swapLimit) {
      this.lastMemory = { freeBytes: sample.availableBytes, reserveBytes: reserve };
      return false;
    }
    this.lastMemory = null;
    return true;
  }

  private setReason(waiter: Waiter, reason: WorkflowWaitReason | null): void {
    if (waiter.reason === reason) return;
    waiter.reason = reason;
    waiter.onWait(reason);
  }

  private grant(waiter: Waiter): void {
    this.active += 1;
    if (waiter.heavy) this.activeHeavy += 1;
    this.setReason(waiter, null);
    let released = false;
    waiter.resolve({
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        if (waiter.heavy) this.activeHeavy -= 1;
        if (this.active === 0) this.swapBaseline = null;
        this.pump();
      },
    });
  }

  private pump(): void {
    let memoryChecked = false;
    let memoryOpen = true;
    for (let i = 0; i < this.queue.length; ) {
      const waiter = this.queue[i];
      if (this.active >= this.machineSlots) {
        for (const rest of this.queue.slice(i)) this.setReason(rest, "machine");
        break;
      }
      if (waiter.heavy && this.activeHeavy >= this.heavySlots) {
        // A heavy request waits for its own semaphore without blocking the
        // ordinary agents queued behind it.
        this.setReason(waiter, "heavy");
        i += 1;
        continue;
      }
      if (!memoryChecked) {
        memoryChecked = true;
        memoryOpen = this.memoryOpen();
      }
      if (!memoryOpen) {
        for (const rest of this.queue.slice(i)) {
          if (!(rest.heavy && this.activeHeavy >= this.heavySlots)) this.setReason(rest, "memory");
        }
        this.scheduleRecheck();
        break;
      }
      this.queue.splice(i, 1);
      this.grant(waiter);
      memoryChecked = false;
    }
    if (this.queue.length === 0) this.lastMemory = null;
  }

  private scheduleRecheck(): void {
    if (this.cancelTimer) return;
    const setTimer =
      this.options.setTimer ??
      ((fn: () => void, ms: number) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return () => clearTimeout(handle);
      });
    this.cancelTimer = setTimer(() => {
      this.cancelTimer = null;
      this.pump();
    }, this.options.recheckMs ?? 5_000);
  }

  dispose(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }
}
