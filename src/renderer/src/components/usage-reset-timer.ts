import type { PiUsageOverview } from "@shared/types";

// A read right at the reset can still find the vendor reporting the window
// before it, so the re-read waits a little past the moment.
export const RESET_REREAD_GRACE_MS = 15_000;

/**
 * Milliseconds until it is worth re-reading subscription usage because the
 * soonest quota window has reset, or null when no window reports a future
 * reset. Resets already past are skipped: re-reading for them again would
 * loop on a vendor that is late to roll over.
 */
export function msUntilUsageReset(
  overview: PiUsageOverview | null,
  nowMs: number,
): number | null {
  let soonest: number | null = null;
  for (const profile of overview?.profiles ?? []) {
    for (const window of profile.windows) {
      const resetMs = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
      if (!Number.isFinite(resetMs) || resetMs <= nowMs) continue;
      if (soonest === null || resetMs < soonest) soonest = resetMs;
    }
  }
  return soonest === null ? null : soonest - nowMs + RESET_REREAD_GRACE_MS;
}
