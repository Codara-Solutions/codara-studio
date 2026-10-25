import {
  lidBatteryLow,
  NO_KEEP_AWAKE_ACTIVITY,
  shouldHoldAwake,
  type KeepAwakeActivity,
  type KeepAwakeBattery,
  type KeepAwakeMode,
  type KeepAwakeStatus,
} from "@shared/keep-awake";

// Decides, on every refresh, whether Codara holds the computer out of idle
// sleep, and keeps exactly one OS hold in step with that decision. It has no
// Electron import: index.ts hands it powerSaveBlocker, the lid hold and the
// activity readers, so scripts/test-keep-awake.cjs drives it with fakes.
//
// Invariants:
//   - at most one blocker id is ever held; a release always clears it, even
//     when the OS throws;
//   - after dispose() nothing is ever acquired again, whatever calls refresh;
//   - the lid hold is only taken while the blocker decision is "hold" and the
//     user opted in, and never on a low battery: the lock blocks the
//     hibernate a critical battery triggers too.

/** Electron's powerSaveBlocker, narrowed to the one blocker type Codara takes. */
export interface SleepBlocker {
  start(): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

/** A platform hold that stops a closed lid from suspending the computer. */
export interface LidHold {
  /** Idempotent; a hold refused a moment ago waits for its retry. */
  start(): void;
  stop(): void;
  dispose(): void;
  readonly active: boolean;
  readonly error: string | null;
}

type IntervalHandle = { unref?: () => void } | number;

export interface KeepAwakeControllerDeps {
  blocker: SleepBlocker;
  /** null where a closed lid cannot be held awake without admin rights. */
  lid: LidHold | null;
  readMode(): KeepAwakeMode;
  readLidEnabled(): boolean;
  readActivity(): KeepAwakeActivity;
  /** The battery, where there is one; null on mains-only machines. */
  readBattery?(): KeepAwakeBattery | null;
  /** Called with every status that differs from the last one published. */
  onStatus(status: KeepAwakeStatus): void;
  log?: (message: string) => void;
  pollMs?: number;
  setInterval?: (fn: () => void, ms: number) => IntervalHandle;
  clearInterval?: (handle: IntervalHandle) => void;
}

/**
 * How often "While agents work" re-reads activity on its own. Terminal agent
 * state changes and Cora's events refresh it as they happen (index.ts); the
 * poll catches what has no event, such as a pane that went silent past
 * TERMINAL_AGENT_SILENT_STALE_MS, and half a minute of lag is far below any
 * OS idle timeout.
 */
export const KEEP_AWAKE_POLL_MS = 30_000;

const BLOCKER_REFUSED = "The system refused the request to stay awake.";

export class KeepAwakeController {
  private blockerId: number | null = null;
  private blockerError: string | null = null;
  private poll: IntervalHandle | null = null;
  private disposed = false;
  private last: KeepAwakeStatus | null = null;
  private lastKey = "";
  private lastActivityError = "";
  private lidLowBattery = false;
  private batteryLevel: number | null = null;

  constructor(private readonly deps: KeepAwakeControllerDeps) {}

  /** Codara holds a blocker right now. */
  get holding(): boolean {
    return this.blockerId !== null;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  start(): KeepAwakeStatus {
    return this.refresh("start");
  }

  refresh(reason: string): KeepAwakeStatus {
    if (this.disposed) return this.status();
    const mode = this.deps.readMode();
    // Activity only decides anything in "agents" mode; the other two neither
    // read it nor poll for it.
    const activity = mode === "agents" ? this.readActivity() : NO_KEEP_AWAKE_ACTIVITY;
    const hold = shouldHoldAwake(mode, activity);
    if (hold) this.acquire(reason);
    else this.release(reason);
    const lidWanted = this.syncLid(hold && this.blockerId !== null);
    this.syncPoll(mode, lidWanted);
    return this.publish(mode, activity);
  }

  status(): KeepAwakeStatus {
    if (this.last) return this.last;
    return this.snapshot(this.deps.readMode(), NO_KEEP_AWAKE_ACTIVITY);
  }

  /** Release every hold and never take one again. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPoll();
    this.release("dispose");
    try {
      this.deps.lid?.dispose();
    } catch (err) {
      this.log(`lid hold dispose failed: ${String(err)}`);
    }
    if (this.last) {
      this.last = { ...this.last, holding: false, lid: { ...this.last.lid, active: false } };
    }
  }

  private readActivity(): KeepAwakeActivity {
    try {
      const activity = this.deps.readActivity();
      this.lastActivityError = "";
      return activity;
    } catch (err) {
      const message = String(err);
      if (message !== this.lastActivityError) this.log(`activity read failed: ${message}`);
      this.lastActivityError = message;
      return NO_KEEP_AWAKE_ACTIVITY;
    }
  }

  private acquire(reason: string): void {
    if (this.blockerId !== null) {
      if (this.blockerStarted(this.blockerId)) return;
      this.log(`the system dropped blocker ${this.blockerId}; taking a new one (${reason})`);
      this.blockerId = null;
    }
    try {
      this.blockerId = this.deps.blocker.start();
      this.blockerError = null;
      this.log(`holding the computer awake (${reason})`);
    } catch (err) {
      this.blockerId = null;
      if (this.blockerError === null) this.log(`could not hold the computer awake (${reason}): ${String(err)}`);
      this.blockerError = BLOCKER_REFUSED;
    }
  }

  private release(reason: string): void {
    this.blockerError = null;
    if (this.blockerId === null) return;
    const id = this.blockerId;
    this.blockerId = null;
    try {
      this.deps.blocker.stop(id);
    } catch (err) {
      this.log(`releasing blocker ${id} failed: ${String(err)}`);
    }
    this.log(`released the computer (${reason})`);
  }

  private blockerStarted(id: number): boolean {
    try {
      return this.deps.blocker.isStarted(id);
    } catch {
      // Unknown is treated as held: taking a second blocker would leak one.
      return true;
    }
  }

  /** True while the user wants the lid held, whether or not the battery lets it. */
  private syncLid(holding: boolean): boolean {
    const lid = this.deps.lid;
    if (!lid) return false;
    const wanted = holding && this.deps.readLidEnabled();
    this.syncBattery(wanted);
    try {
      if (wanted && !this.lidLowBattery) lid.start();
      else lid.stop();
    } catch (err) {
      this.log(`lid hold failed: ${String(err)}`);
    }
    return wanted;
  }

  private syncBattery(lidWanted: boolean): void {
    if (!lidWanted || !this.deps.readBattery) {
      this.lidLowBattery = false;
      this.batteryLevel = null;
      return;
    }
    let battery: KeepAwakeBattery | null = null;
    try {
      battery = this.deps.readBattery();
    } catch (err) {
      this.log(`battery read failed: ${String(err)}`);
    }
    const low = lidBatteryLow(this.lidLowBattery, battery);
    if (low !== this.lidLowBattery) {
      const level = battery?.level === null || battery?.level === undefined ? "unknown" : `${battery.level}%`;
      this.log(
        low
          ? `battery low on battery power (${level}): letting go of the lid hold so the system can hibernate`
          : `battery ${battery?.onBattery ? `back to ${level}` : "charging"}: taking the lid hold again`,
      );
    }
    this.lidLowBattery = low;
    this.batteryLevel = low ? (battery?.level ?? null) : null;
  }

  private syncPoll(mode: KeepAwakeMode, lidWanted: boolean): void {
    // "Always" needs no activity poll, but a lid hold still follows the
    // battery, which has no event for its level.
    if (mode !== "agents" && !(lidWanted && this.deps.readBattery)) {
      this.stopPoll();
      return;
    }
    if (this.poll !== null) return;
    const every = this.deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    const handle = every(() => this.refresh("poll"), this.deps.pollMs ?? KEEP_AWAKE_POLL_MS);
    if (typeof handle === "object" && typeof handle.unref === "function") handle.unref();
    this.poll = handle;
  }

  private stopPoll(): void {
    if (this.poll === null) return;
    const clear = this.deps.clearInterval ?? ((handle: IntervalHandle) => clearInterval(handle as NodeJS.Timeout));
    clear(this.poll);
    this.poll = null;
  }

  private snapshot(mode: KeepAwakeMode, activity: KeepAwakeActivity): KeepAwakeStatus {
    const lid = this.deps.lid;
    return {
      mode,
      holding: this.blockerId !== null,
      activity: { ...activity },
      lid: {
        supported: lid !== null,
        enabled: this.deps.readLidEnabled(),
        active: lid?.active ?? false,
        error: lid?.error ?? null,
        pausedForBattery: this.lidLowBattery,
        batteryLevel: this.batteryLevel,
      },
      error: this.blockerError,
    };
  }

  private publish(mode: KeepAwakeMode, activity: KeepAwakeActivity): KeepAwakeStatus {
    const next = this.snapshot(mode, activity);
    const key = JSON.stringify(next);
    this.last = next;
    if (key !== this.lastKey) {
      this.lastKey = key;
      try {
        this.deps.onStatus(next);
      } catch (err) {
        this.log(`status listener failed: ${String(err)}`);
      }
    }
    return next;
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }
}
