// Decides when the main thread has frozen, from heartbeats it sends and the
// watchdog thread's own clock ticks. Runs inside the watchdog thread.
//
// Self-contained on purpose: hang-watchdog-worker.ts ships this function's
// source text into the worker (Function.prototype.toString), so it may use
// nothing from outside its own body.

export interface HangDetectorConfig {
  /** Silence after which the main thread counts as frozen. */
  thresholdMs: number;
  /** How often the watchdog thread calls tick(). */
  checkIntervalMs: number;
  now: () => number;
}

export type HangDetectorEvent =
  | { kind: "detected"; startedAt: number; unresponsiveMs: number }
  | { kind: "ongoing"; unresponsiveMs: number }
  | { kind: "recovered"; durationMs: number };

export interface HangDetector {
  /** The main thread answered. Returns "recovered" when it ends a freeze. */
  heartbeat(): HangDetectorEvent | null;
  /** The watchdog's own clock. Returns "detected" once per freeze, then "ongoing". */
  tick(): HangDetectorEvent | null;
}

export function createHangDetector(config: HangDetectorConfig): HangDetector {
  let lastHeartbeatAt = config.now();
  let lastTickAt = lastHeartbeatAt;
  let frozen = false;
  return {
    heartbeat() {
      const now = config.now();
      const silence = now - lastHeartbeatAt;
      lastHeartbeatAt = now;
      if (!frozen) return null;
      frozen = false;
      return { kind: "recovered", durationMs: silence };
    },
    tick() {
      const now = config.now();
      const tickGap = now - lastTickAt;
      lastTickAt = now;
      if (frozen) return { kind: "ongoing", unresponsiveMs: now - lastHeartbeatAt };
      // The watchdog's own timer stalled as well, so the whole process was
      // suspended (system sleep, App Nap, a stopped process). The silence says
      // nothing about the main thread; start counting again from now.
      if (tickGap > config.checkIntervalMs * 4) {
        lastHeartbeatAt = now;
        return null;
      }
      const silence = now - lastHeartbeatAt;
      if (silence < config.thresholdMs) return null;
      frozen = true;
      return { kind: "detected", startedAt: lastHeartbeatAt, unresponsiveMs: silence };
    },
  };
}
