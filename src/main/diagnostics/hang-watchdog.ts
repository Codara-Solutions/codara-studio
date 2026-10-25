// Main-process side of the freeze watchdog: starts the watchdog thread
// (hang-watchdog-worker.ts), sends it a heartbeat every second and mirrors
// breadcrumbs to it, and writes each freeze it reports to main.log once the
// main thread is answering again. A freeze the app never came back from (it
// was force quit or killed) is still on disk as the marker file, and is
// logged on the next start.
//
// Environment, for tests and troubleshooting:
//   CODARA_HANG_WATCHDOG=0                     no watchdog
//   CODARA_HANG_WATCHDOG_THRESHOLD_MS=5000     silence that counts as a freeze
//   CODARA_HANG_WATCHDOG_HEARTBEAT_MS=1000
//   CODARA_HANG_WATCHDOG_STACKS=0|1            stack capture off, or on even
//                                              while a debugger is attached

import { readFileSync, rmSync, appendFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { HangRecord } from "@shared/diagnostics";
import { formatDuration } from "@shared/diagnostics";
import { logMain } from "../file-log";
import { onBreadcrumb, recentBreadcrumbs } from "./breadcrumbs";
import {
  hangWatchdogWorkerSource,
  type HangWatchdogWorkerData,
  type MainToWatchdogMessage,
  type WatchdogToMainMessage,
} from "./hang-watchdog-worker";

export interface HangWatchdogSettings {
  enabled: boolean;
  thresholdMs: number;
  heartbeatMs: number;
  checkIntervalMs: number;
  captureStack: boolean;
  stackTimeoutMs: number;
}

const MAX_LOG_BYTES = 512 * 1024;
const BREADCRUMBS_PER_HANG = 25;

function positive(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min ? Math.round(parsed) : fallback;
}

/**
 * `debuggerAttached`: the main process was started with --inspect. Pausing it
 * from the watchdog would then resume a developer's own breakpoint stop, so
 * stacks stay off unless CODARA_HANG_WATCHDOG_STACKS=1 says otherwise (the
 * e2e suite, whose Playwright driver attaches without breakpoints).
 */
export function hangWatchdogSettings(env: NodeJS.ProcessEnv, debuggerAttached: boolean): HangWatchdogSettings {
  const heartbeatMs = positive(env.CODARA_HANG_WATCHDOG_HEARTBEAT_MS, 1_000, 50);
  const thresholdMs = Math.max(positive(env.CODARA_HANG_WATCHDOG_THRESHOLD_MS, 5_000, 200), heartbeatMs * 2);
  const stacks = env.CODARA_HANG_WATCHDOG_STACKS?.trim();
  return {
    enabled: env.CODARA_HANG_WATCHDOG?.trim() !== "0",
    thresholdMs,
    heartbeatMs,
    checkIntervalMs: Math.max(25, Math.min(500, Math.round(heartbeatMs / 2))),
    captureStack: stacks === "1" || (stacks !== "0" && !debuggerAttached),
    stackTimeoutMs: Math.max(250, Math.min(2_000, Math.round(thresholdMs / 2))),
  };
}

export function hangLogFile(dir: string): string {
  return join(dir, "hangs.jsonl");
}

export function hangMarkerFile(dir: string): string {
  return join(dir, "hang-pending.json");
}

function isHangRecord(value: unknown): value is HangRecord {
  const record = value as Partial<HangRecord> | null;
  return (
    !!record &&
    typeof record === "object" &&
    typeof record.id === "string" &&
    typeof record.detectedAt === "number" &&
    Number.isFinite(record.detectedAt) &&
    typeof record.durationMs === "number" &&
    Number.isFinite(record.durationMs)
  );
}

/**
 * Moves a freeze the last session never recovered from into hangs.jsonl.
 * Runs before the new watchdog starts, which would otherwise overwrite it.
 */
export function consumeUnfinishedHang(dir: string): HangRecord | null {
  const marker = hangMarkerFile(dir);
  let raw: string;
  try {
    if (statSync(marker).size > 1024 * 1024) {
      rmSync(marker, { force: true });
      return null;
    }
    raw = readFileSync(marker, "utf8");
  } catch {
    return null;
  }
  let record: HangRecord | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isHangRecord(parsed)) record = { ...parsed, recovered: false };
  } catch {
    record = null;
  }
  if (record) {
    try {
      appendFileSync(hangLogFile(dir), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      // Keep going: the log line below still tells the story.
    }
  }
  try {
    rmSync(marker, { force: true });
  } catch {
    // A marker that cannot be removed is read again next start; harmless.
  }
  return record;
}

function frameLabel(frame: { fn: string; url: string; line: number; column: number }): string {
  const file = frame.url.split(/[\\/]/).pop() || frame.url || "?";
  return `${frame.fn} (${file}:${frame.line}:${frame.column})`;
}

/** The main.log line for a freeze. Paths are shortened to file names. */
export function formatHangLine(record: HangRecord, previousSession = false): string {
  const length = formatDuration(record.durationMs);
  const head = previousSession
    ? `the previous session stopped responding for at least ${length} and closed before it recovered`
    : `main process did not respond for ${length}${record.recovered ? " and recovered" : ""}`;
  const facts: string[] = [];
  if (record.cpuPercent !== null) facts.push(`cpu ${record.cpuPercent}%`);
  if (record.rssBytes !== null) facts.push(`rss ${Math.round(record.rssBytes / (1024 * 1024))} MB`);
  const stack = record.stack?.length
    ? `stack: ${record.stack.slice(0, 6).map(frameLabel).join(" < ")}`
    : record.stackNote
      ? `no stack: ${record.stackNote}`
      : "";
  return [head, facts.join(", "), stack].filter(Boolean).join("; ");
}

interface ActiveWatchdog {
  worker: Worker;
  heartbeat: NodeJS.Timeout;
  unsubscribe: () => void;
  settings: HangWatchdogSettings;
  post: (message: MainToWatchdogMessage) => void;
}

let active: ActiveWatchdog | null = null;
const hangListeners = new Set<(record: HangRecord) => void>();

export function onHangRecorded(listener: (record: HangRecord) => void): () => void {
  hangListeners.add(listener);
  return () => hangListeners.delete(listener);
}

export function hangWatchdogRunning(): boolean {
  return active !== null;
}

export function startHangWatchdog(dir: string, settings: HangWatchdogSettings): boolean {
  if (active) return true;
  const leftover = consumeUnfinishedHang(dir);
  if (leftover) logMain("hang", formatHangLine(leftover, true));
  if (!settings.enabled) return false;

  const workerData: HangWatchdogWorkerData = {
    pid: process.pid,
    thresholdMs: settings.thresholdMs,
    checkIntervalMs: settings.checkIntervalMs,
    logPath: hangLogFile(dir),
    markerPath: hangMarkerFile(dir),
    maxLogBytes: MAX_LOG_BYTES,
    captureStack: settings.captureStack,
    stackTimeoutMs: settings.stackTimeoutMs,
    breadcrumbLimit: BREADCRUMBS_PER_HANG,
  };
  let worker: Worker;
  try {
    worker = new Worker(hangWatchdogWorkerSource(), {
      eval: true,
      name: "codara-hang-watchdog",
      workerData,
      // The watchdog itself must stay small; it only parses heartbeats.
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 },
    });
  } catch (error) {
    logMain("hang", `freeze watchdog could not start: ${(error as Error).message}`);
    return false;
  }
  const post = (message: MainToWatchdogMessage): void => {
    try {
      worker.postMessage(message);
    } catch {
      // The worker already exited.
    }
  };
  const heartbeat = setInterval(() => post({ type: "heartbeat" }), settings.heartbeatMs);
  heartbeat.unref();
  const unsubscribe = onBreadcrumb((crumb) => post({ type: "breadcrumb", crumb }));
  post({ type: "breadcrumbs", crumbs: recentBreadcrumbs(BREADCRUMBS_PER_HANG) });
  worker.on("message", (message: WatchdogToMainMessage) => {
    if (message?.type !== "hang") return;
    logMain("hang", formatHangLine(message.record));
    for (const listener of hangListeners) {
      try {
        listener(message.record);
      } catch {
        // Listeners are diagnostics too.
      }
    }
  });
  const retire = (): void => {
    if (active?.worker !== worker) return;
    clearInterval(heartbeat);
    unsubscribe();
    active = null;
  };
  worker.on("error", (error) => {
    logMain("hang", `freeze watchdog stopped: ${error.message}`);
    retire();
  });
  worker.once("exit", retire);
  worker.unref();
  active = { worker, heartbeat, unsubscribe, settings, post };
  return true;
}

/**
 * Stands the watchdog down while the main thread waits on the user in a
 * synchronous dialog: a person reading a question is not a freeze. Holds
 * nest; call the returned release once the dialog has closed.
 */
export function holdHangWatchdog(): () => void {
  const current = active;
  if (!current) return () => undefined;
  current.post({ type: "hold" });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (active === current) current.post({ type: "release" });
  };
}

/** The synchronous members of Electron's dialog module. */
export const SYNC_DIALOG_METHODS = ["showMessageBoxSync", "showOpenDialogSync", "showSaveDialogSync", "showErrorBox"] as const;

/**
 * Wraps the synchronous dialogs of `dialogModule` so each one holds the
 * watchdog while it is open, whichever module opens it (index.ts asks before
 * quitting with live Cora work this way). Returns the names it wrapped.
 */
export function holdDuringSyncDialogs(dialogModule: object, hold: () => () => void = holdHangWatchdog): string[] {
  const target = dialogModule as Record<string, unknown>;
  const wrapped: string[] = [];
  for (const name of SYNC_DIALOG_METHODS) {
    const original = target[name];
    if (typeof original !== "function") continue;
    target[name] = function holdWhileOpen(this: unknown, ...args: unknown[]): unknown {
      const release = hold();
      try {
        return (original as (...params: unknown[]) => unknown).apply(this, args);
      } finally {
        release();
      }
    };
    wrapped.push(name);
  }
  return wrapped;
}

export function stopHangWatchdog(): void {
  const current = active;
  if (!current) return;
  active = null;
  clearInterval(current.heartbeat);
  current.unsubscribe();
  try {
    current.worker.postMessage({ type: "shutdown" } satisfies MainToWatchdogMessage);
  } catch {
    // Already gone.
  }
}
