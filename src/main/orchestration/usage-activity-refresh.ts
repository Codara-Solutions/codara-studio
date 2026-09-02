import { BrowserWindow } from "electron";
import type { PiSubscriptionAuthEvent } from "@shared/types";
import { inspectPiSubscriptionUsage } from "./pi-subscription-usage";

// Subscription quota only moves when an agent works, so the usage surfaces
// refresh on that signal instead of on a wall clock: every time a terminal
// agent finishes a turn the main process re-reads usage live and tells every
// window to pick up the fresh numbers. A burst of turns (a run finishing ten
// workers at once) collapses into one read, and reads are spaced so a busy
// afternoon still stays well inside Anthropic's informational-endpoint budget.

export const USAGE_NUDGE_SETTLE_MS = 15_000;
export const USAGE_NUDGE_MIN_GAP_MS = 3 * 60_000;

let settleTimer: NodeJS.Timeout | null = null;
let lastRefreshAt = 0;
let inflight: Promise<void> | null = null;

function broadcast(event: PiSubscriptionAuthEvent): void {
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed())
        window.webContents.send("pi-subscriptions:event", event);
    }
  } catch {
    /* best-effort: a window closing mid-send is not an error */
  }
}

async function refreshNow(): Promise<void> {
  lastRefreshAt = Date.now();
  try {
    await inspectPiSubscriptionUsage(true);
    broadcast({ type: "usage" });
  } catch {
    /* the next nudge tries again */
  }
}

/** Ask for a live usage read soon. Safe to call on every turn boundary. */
export function nudgeUsageRefresh(): void {
  if (settleTimer) return;
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (inflight) return;
    const wait = lastRefreshAt + USAGE_NUDGE_MIN_GAP_MS - Date.now();
    if (wait > 0) {
      // Too soon after the last read: one deferred read covers everything
      // that happened in between.
      settleTimer = setTimeout(() => {
        settleTimer = null;
        nudgeUsageRefresh();
      }, wait);
      settleTimer.unref();
      return;
    }
    inflight = refreshNow().finally(() => {
      inflight = null;
    });
  }, USAGE_NUDGE_SETTLE_MS);
  settleTimer.unref();
}

/** Test/maintenance hook: forget pending nudges and the spacing clock. */
export function resetUsageRefreshNudges(): void {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = null;
  lastRefreshAt = 0;
  inflight = null;
}
