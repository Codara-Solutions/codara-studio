// The black box's flight recorder: a ring of the last notable events in the
// main process (every logMain line, process deaths, uncaught errors, freezes).
// A freeze record carries its tail, and the ring is saved to
// <codaraHome>/diagnostics/breadcrumbs.json shortly after each event, so a
// session that dies outright still leaves its last moments behind. The file
// of the session before is kept as breadcrumbs.previous.json at boot.
//
// Recording must never throw or block: it runs inside logMain, which is
// called from error paths.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Breadcrumb } from "@shared/diagnostics";
import { writeFileAtomic } from "../fs-atomic";

export const BREADCRUMB_CAPACITY = 200;
const MAX_CATEGORY_CHARS = 40;
const MAX_MESSAGE_CHARS = 500;
const PERSIST_DELAY_MS = 1_500;

export interface BreadcrumbRing {
  push(crumb: Breadcrumb): void;
  /** Oldest first. */
  list(): Breadcrumb[];
  size(): number;
}

export function createBreadcrumbRing(capacity: number): BreadcrumbRing {
  const size = Math.max(1, Math.floor(capacity));
  const slots: Array<Breadcrumb | undefined> = new Array(size);
  let next = 0;
  let count = 0;
  return {
    push(crumb) {
      slots[next] = crumb;
      next = (next + 1) % size;
      count = Math.min(count + 1, size);
    },
    list() {
      const out: Breadcrumb[] = [];
      for (let back = count; back > 0; back -= 1) {
        const crumb = slots[(next - back + size) % size];
        if (crumb) out.push(crumb);
      }
      return out;
    },
    size: () => count,
  };
}

/** One line, bounded, so a stack trace or a pasted blob cannot flood the ring. */
export function makeBreadcrumb(category: string, message: string, now: number): Breadcrumb {
  const flat = (value: string, max: number): string => {
    const line = String(value).replace(/\s+/g, " ").trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  };
  return { t: now, category: flat(category, MAX_CATEGORY_CHARS) || "event", message: flat(message, MAX_MESSAGE_CHARS) };
}

let ring = createBreadcrumbRing(BREADCRUMB_CAPACITY);
const listeners = new Set<(crumb: Breadcrumb) => void>();
let persistDir: string | null = null;
let persistTimer: NodeJS.Timeout | null = null;
let writing: Promise<void> = Promise.resolve();
const sessionStartedAt = Date.now();

export function recordBreadcrumb(category: string, message: string): void {
  try {
    const crumb = makeBreadcrumb(category, message, Date.now());
    ring.push(crumb);
    for (const listener of listeners) {
      try {
        listener(crumb);
      } catch {
        // A listener (the watchdog relay) must not break the logger.
      }
    }
    schedulePersist();
  } catch {
    // Diagnostics are best effort.
  }
}

/** Oldest first; the last `limit` when given. */
export function recentBreadcrumbs(limit?: number): Breadcrumb[] {
  const all = ring.list();
  return limit !== undefined && limit >= 0 ? all.slice(Math.max(0, all.length - limit)) : all;
}

export function onBreadcrumb(listener: (crumb: Breadcrumb) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function breadcrumbsFile(dir: string): string {
  return join(dir, "breadcrumbs.json");
}

export function previousBreadcrumbsFile(dir: string): string {
  return join(dir, "breadcrumbs.previous.json");
}

function sessionBody(): string {
  return JSON.stringify({
    pid: process.pid,
    startedAt: sessionStartedAt,
    savedAt: Date.now(),
    breadcrumbs: ring.list(),
  });
}

/**
 * Starts saving the ring to `dir`. Synchronous, so the last session's file is
 * moved aside before this session's first write can replace it. Must run
 * after the Codara home exists (creating it earlier would defeat the legacy
 * home rename in codara-home.ts).
 */
export function startBreadcrumbPersistence(dir: string): void {
  persistDir = dir;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // The write below reports nothing either; the ring still works in memory.
  }
  try {
    renameSync(breadcrumbsFile(dir), previousBreadcrumbsFile(dir));
  } catch {
    // First run, or nothing left by the last one.
  }
  schedulePersist();
}

function schedulePersist(): void {
  if (!persistDir || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistBreadcrumbsNow();
  }, PERSIST_DELAY_MS);
  persistTimer.unref?.();
}

export function persistBreadcrumbsNow(): Promise<void> {
  const dir = persistDir;
  if (!dir) return Promise.resolve();
  writing = writing
    .then(() => writeFileAtomic(breadcrumbsFile(dir), sessionBody(), { mode: 0o600 }))
    .catch(() => undefined);
  return writing;
}

/** For the quit path, where an async write would be cut off. */
export function flushBreadcrumbsSync(): void {
  const dir = persistDir;
  if (!dir) return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    writeFileSync(breadcrumbsFile(dir), sessionBody(), { mode: 0o600 });
  } catch {
    // Best effort.
  }
}

/** Test seam: forget everything recorded so far and stop saving. */
export function _resetBreadcrumbsForTest(): void {
  ring = createBreadcrumbRing(BREADCRUMB_CAPACITY);
  persistDir = null;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  listeners.clear();
}
