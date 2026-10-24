// A box's sshd only sees a key added to the account after the kubelet
// refreshes the authorized_keys Secret (about 1 to 2 minutes). When the CLI
// reports it added the key just now (`key_added` in `boxes ssh-config`),
// Studio retries the first connection's authentication for that long. Any
// other authentication failure is final. The state is in memory on purpose:
// it only describes the minutes right after the key was added.

export const timing = {
  /** How long after the key was added a refusal may still be propagation. */
  windowMs: 2 * 60_000,
  /** Waits between attempts: backoff, then the last value repeats. */
  delaysMs: [2_000, 4_000, 8_000, 10_000],
};

const freshKeyAt = new Map<string, number>();

export function markFreshBoxKey(hostId: string, now = Date.now()): void {
  freshKeyAt.set(hostId, now);
}

export function clearFreshBoxKey(hostId: string): void {
  freshKeyAt.delete(hostId);
}

/**
 * The wait before retry number `attempt` (0-based), or null when the host has
 * no freshly added key or the propagation window is over.
 */
export function nextFreshKeyDelayMs(hostId: string, attempt: number, now = Date.now()): number | null {
  const added = freshKeyAt.get(hostId);
  if (added === undefined) return null;
  const left = added + timing.windowMs - now;
  if (left <= 0) {
    freshKeyAt.delete(hostId);
    return null;
  }
  const step = timing.delaysMs[Math.min(attempt, timing.delaysMs.length - 1)];
  return Math.min(step, left);
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
