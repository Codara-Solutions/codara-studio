// Logged-out browser tabs: a Codara tab whose <webview> runs in its own
// in-memory partition, so it starts with no cookies or storage and never
// reads or writes the session the user's other tabs share. Nothing it
// stores reaches disk; its data is wiped when an agent discards it, when
// its last page closes, and in any case when Codara quits.

import { randomBytes } from "node:crypto";

import { app, session, webContents, type Session, type WebContents } from "electron";

import { FRESH_PARTITION_PREFIX, isFreshPartition } from "../../shared/browser-partition";

// A tab whose webview is re-created gets a new guest a moment later.
const WIPE_GRACE_MS = 5_000;

export function newFreshPartition(): string {
  return `${FRESH_PARTITION_PREFIX}${randomBytes(6).toString("hex")}`;
}

const known = new Map<string, Session>();
let watching = false;

function partitionOf(ses: Session): string | null {
  for (const [partition, candidate] of known) if (candidate === ses) return partition;
  return null;
}

function inUse(ses: Session): boolean {
  return webContents.getAllWebContents().some((wc) => !wc.isDestroyed() && wc.session === ses);
}

function scheduleWipeWhenUnused(partition: string, ses: Session): void {
  setTimeout(() => {
    if (known.get(partition) === ses && !inUse(ses)) void wipeFreshPartition(partition);
  }, WIPE_GRACE_MS).unref?.();
}

function watchGuest(wc: WebContents): void {
  const ses = wc.session;
  const partition = partitionOf(ses);
  if (!partition) return;
  wc.once("destroyed", () => scheduleWipeWhenUnused(partition, ses));
}

/** Remember a partition a fresh tab will use, so its data is wiped once nothing shows it. */
export function trackFreshPartition(partition: string): void {
  if (!isFreshPartition(partition)) throw new Error(`not a fresh-tab partition: ${partition}`);
  known.set(partition, session.fromPartition(partition));
  if (watching) return;
  watching = true;
  app.on("web-contents-created", (_event, wc) => watchGuest(wc));
  for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed()) watchGuest(wc);
}

/** Clear everything a fresh tab stored: cookies, storage, caches and HTTP auth. */
export async function wipeFreshPartition(partition: string): Promise<void> {
  if (!isFreshPartition(partition)) throw new Error(`not a fresh-tab partition: ${partition}`);
  const ses = known.get(partition) ?? session.fromPartition(partition);
  known.delete(partition);
  await Promise.allSettled([ses.clearStorageData(), ses.clearCache(), ses.clearAuthCache()]);
}
