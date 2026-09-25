// A token bucket per paired device. It is keyed by the Noise-authenticated
// public key and owned by the service rather than a session, so a phone
// cannot refill its budget by reconnecting.

export interface DeviceRateLimitOptions {
  /** Requests a device may make at once after a quiet period. */
  burst: number;
  /** One more request becomes available every refillMs. */
  refillMs: number;
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class DeviceRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly options: DeviceRateLimitOptions) {}

  /** Spends one request for `deviceKey`; false when its budget is empty. */
  take(deviceKey: string): boolean {
    const now = this.options.now?.() ?? Date.now();
    const current = this.buckets.get(deviceKey);
    const tokens = current
      ? Math.min(
          this.options.burst,
          current.tokens +
            Math.max(0, now - current.updatedAt) / this.options.refillMs,
        )
      : this.options.burst;
    if (tokens < 1) {
      this.buckets.set(deviceKey, { tokens, updatedAt: now });
      return false;
    }
    this.buckets.set(deviceKey, { tokens: tokens - 1, updatedAt: now });
    return true;
  }

  forget(deviceKey: string): void {
    this.buckets.delete(deviceKey);
  }
}
