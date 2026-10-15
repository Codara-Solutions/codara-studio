// The watchdog thread. The main process posts a heartbeat every second; when
// they stop for longer than the threshold, this thread (whose event loop is
// still free) writes down what it can about the freeze:
//
// - the main thread's JavaScript stack, by pausing it for a moment through
//   the V8 inspector (inspector.Session.connectToMainThread) and resuming it
//   at once. A pause only lands when the main thread runs JavaScript; one
//   blocked in native code (a synchronous read on a dead disk, a lock) never
//   reaches it, and the note says so;
// - CPU time over the silence (busy computing or waiting), memory and load;
// - the last breadcrumbs the main process mirrored here.
//
// The record is written to a marker file at once (it survives a force quit)
// and moved to hangs.jsonl when heartbeats come back. Observation only:
// nothing here ever kills or restarts anything.
//
// The functions below are shipped to the thread as source text, like
// browser/record/gif-worker.ts, so the worker needs no file inside the asar
// and no build entry of its own. Each one must be self-contained: everything
// it uses comes in through its parameters.

import type { Breadcrumb, HangRecord, HangStackFrame } from "@shared/diagnostics";
import { createHangDetector, type HangDetector, type HangDetectorConfig, type HangDetectorEvent } from "./hang-detection";

export interface HangWatchdogWorkerData {
  pid: number;
  thresholdMs: number;
  checkIntervalMs: number;
  /** diagnostics/hangs.jsonl */
  logPath: string;
  /** diagnostics/hang-pending.json: the freeze in progress. */
  markerPath: string;
  maxLogBytes: number;
  captureStack: boolean;
  stackTimeoutMs: number;
  breadcrumbLimit: number;
}

export type MainToWatchdogMessage =
  | { type: "heartbeat" }
  // The main thread is about to wait on the user in a synchronous dialog, and
  // has stopped waiting. Holds nest; silence while one is held is no freeze.
  | { type: "hold" }
  | { type: "release" }
  | { type: "breadcrumb"; crumb: Breadcrumb }
  | { type: "breadcrumbs"; crumbs: Breadcrumb[] }
  | { type: "shutdown" };

export type WatchdogToMainMessage = { type: "ready" } | { type: "hang"; record: HangRecord };

export interface StackCaptureResult {
  frames: HangStackFrame[] | null;
  note: string | null;
}

/** The slice of node:inspector the capture uses. */
export interface InspectorLike {
  Session: new () => {
    connectToMainThread(): void;
    post(method: string, callback?: (error: Error | null, result?: unknown) => void): void;
    on(event: string, listener: (message: { params?: Record<string, unknown> }) => void): unknown;
    once(event: string, listener: (message: { params?: Record<string, unknown> }) => void): unknown;
    disconnect(): void;
  };
}

export interface StackCaptureOptions {
  inspector: InspectorLike;
  timeoutMs: number;
  maxFrames: number;
}

/**
 * Pauses the main thread, reads its stack and resumes it. Resolves, never
 * rejects. Disabling the debugger on every exit path matters: it resumes a
 * pause that landed and cancels one still pending, so a capture that times
 * out cannot leave the main thread stopped later.
 */
export function captureMainThreadStack(options: StackCaptureOptions): Promise<StackCaptureResult> {
  return new Promise((resolve) => {
    const describe = (error: unknown): string =>
      error && typeof error === "object" && "message" in error ? String((error as Error).message) : String(error);
    let session: InstanceType<InspectorLike["Session"]>;
    try {
      session = new options.inspector.Session();
      session.connectToMainThread();
    } catch (error) {
      resolve({ frames: null, note: `The inspector is not available: ${describe(error)}` });
      return;
    }
    const scripts = new Map<string, string>();
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const close = (): void => {
      try {
        session.post("Debugger.disable", () => {
          try {
            session.disconnect();
          } catch {
            // Already gone.
          }
        });
      } catch {
        try {
          session.disconnect();
        } catch {
          // Already gone.
        }
      }
    };
    const finish = (frames: HangStackFrame[] | null, note: string | null): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      close();
      resolve({ frames, note });
    };
    session.on("Debugger.scriptParsed", (message) => {
      const params = message?.params;
      if (params && typeof params.url === "string" && params.url && typeof params.scriptId === "string") {
        scripts.set(params.scriptId, params.url);
      }
    });
    session.once("Debugger.paused", (message) => {
      const callFrames = Array.isArray(message?.params?.callFrames) ? (message.params!.callFrames as unknown[]) : [];
      const frames: HangStackFrame[] = callFrames.slice(0, options.maxFrames).map((raw) => {
        const frame = raw as {
          functionName?: string;
          url?: string;
          location?: { scriptId?: string; lineNumber?: number; columnNumber?: number };
        };
        const location = frame.location ?? {};
        return {
          fn: frame.functionName || "(anonymous)",
          url: (location.scriptId && scripts.get(location.scriptId)) || frame.url || "",
          line: (location.lineNumber ?? 0) + 1,
          column: (location.columnNumber ?? 0) + 1,
        };
      });
      if (done) {
        close();
        return;
      }
      try {
        session.post("Debugger.resume", () => finish(frames, frames.length > 0 ? null : "The pause landed outside JavaScript."));
      } catch {
        finish(frames, null);
      }
    });
    session.post("Debugger.enable", (error) => {
      if (error) {
        finish(null, `Could not attach to the main thread: ${describe(error)}`);
        return;
      }
      session.post("Debugger.pause", (pauseError) => {
        if (pauseError) finish(null, `Could not pause the main thread: ${describe(pauseError)}`);
      });
    });
    timer = setTimeout(() => {
      finish(
        null,
        `The main thread ran no JavaScript within ${options.timeoutMs} ms, so it was most likely blocked in native code (disk, a lock or a synchronous call).`,
      );
    }, options.timeoutMs);
  });
}

export interface WatchdogPort {
  on(event: "message", listener: (message: MainToWatchdogMessage) => void): unknown;
  postMessage(message: WatchdogToMainMessage): void;
  close(): void;
}

export interface WatchdogDeps {
  port: WatchdogPort | null;
  config: HangWatchdogWorkerData;
  fs: {
    appendFileSync(path: string, data: string, options?: { mode?: number }): void;
    writeFileSync(path: string, data: string, options?: { mode?: number }): void;
    rmSync(path: string, options?: { force?: boolean }): void;
    statSync(path: string): { size: number };
    renameSync(from: string, to: string): void;
  };
  os: { loadavg(): number[]; freemem(): number; totalmem(): number };
  inspector: InspectorLike | null;
  createHangDetector: (config: HangDetectorConfig) => HangDetector;
  captureMainThreadStack: (options: StackCaptureOptions) => Promise<StackCaptureResult>;
  now: () => number;
  cpuUsage: () => { user: number; system: number };
  memoryUsage: () => { rss: number };
}

export function runHangWatchdogWorker(deps: WatchdogDeps): void {
  const { port, config, fs, os } = deps;
  if (!port) return;
  const attempt = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  const detector = deps.createHangDetector({
    thresholdMs: config.thresholdMs,
    checkIntervalMs: config.checkIntervalMs,
    now: deps.now,
  });
  const crumbs: Breadcrumb[] = [];
  let cpuMark = deps.cpuUsage();
  let cpuMarkAt = deps.now();
  let current: { record: HangRecord; capture: Promise<void> } | null = null;
  let markerWrittenAt = 0;
  let sequence = 0;
  let holds = 0;

  const writeMarker = (record: HangRecord): void => {
    markerWrittenAt = deps.now();
    attempt(() => fs.writeFileSync(config.markerPath, JSON.stringify(record), { mode: 0o600 }));
  };
  const appendLog = (record: HangRecord): void => {
    const size = attempt(() => fs.statSync(config.logPath).size) ?? 0;
    if (size > config.maxLogBytes) attempt(() => fs.renameSync(config.logPath, `${config.logPath}.1`));
    attempt(() => fs.appendFileSync(config.logPath, `${JSON.stringify(record)}\n`, { mode: 0o600 }));
  };

  const onDetected = (event: Extract<HangDetectorEvent, { kind: "detected" }>): void => {
    const at = deps.now();
    const cpu = attempt(() => deps.cpuUsage());
    const wallMicros = Math.max(1, at - cpuMarkAt) * 1000;
    const usedMicros = cpu ? cpu.user - cpuMark.user + (cpu.system - cpuMark.system) : null;
    const memory = attempt(() => deps.memoryUsage());
    const loadAverage = attempt(() => os.loadavg().map((value) => Math.round(value * 100) / 100));
    sequence += 1;
    const record: HangRecord = {
      id: `${config.pid}-${at}-${sequence}`,
      startedAt: event.startedAt,
      detectedAt: at,
      unresponsiveMs: event.unresponsiveMs,
      durationMs: event.unresponsiveMs,
      recovered: false,
      pid: config.pid,
      cpuPercent: usedMicros === null ? null : Math.max(0, Math.round((usedMicros / wallMicros) * 100)),
      rssBytes: memory ? memory.rss : null,
      loadAverage: loadAverage ?? null,
      freeMemoryBytes: attempt(() => os.freemem()) ?? null,
      totalMemoryBytes: attempt(() => os.totalmem()) ?? null,
      stack: null,
      stackNote: config.captureStack && deps.inspector ? null : "Stack capture is off.",
      breadcrumbs: crumbs.slice(),
    };
    writeMarker(record);
    const capture =
      config.captureStack && deps.inspector
        ? deps
            .captureMainThreadStack({ inspector: deps.inspector, timeoutMs: config.stackTimeoutMs, maxFrames: 32 })
            .then((result) => {
              record.stack = result.frames;
              record.stackNote = result.note;
              if (current?.record === record) writeMarker(record);
            })
            .catch(() => {
              record.stackNote = "Stack capture failed.";
            })
        : Promise.resolve();
    current = { record, capture };
  };

  const onRecovered = (durationMs: number): void => {
    if (!current) return;
    const { record, capture } = current;
    current = null;
    record.recovered = true;
    record.durationMs = durationMs;
    void capture.then(() => {
      appendLog(record);
      // A newer freeze may already own the marker.
      if (!current) attempt(() => fs.rmSync(config.markerPath, { force: true }));
      attempt(() => port.postMessage({ type: "hang", record }));
    });
  };

  const timer = setInterval(() => {
    // Skipped ticks leave a gap the detector reads as a suspended process,
    // so counting starts afresh once the last hold is released.
    if (holds > 0) return;
    const event = detector.tick();
    if (!event) return;
    if (event.kind === "detected") {
      onDetected(event);
    } else if (event.kind === "ongoing" && current) {
      current.record.durationMs = event.unresponsiveMs;
      // Keep the marker's length current, so a force quit still records
      // roughly how long the freeze lasted.
      if (deps.now() - markerWrittenAt >= 5_000) writeMarker(current.record);
    }
  }, config.checkIntervalMs);

  port.on("message", (message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "heartbeat" || message.type === "hold" || message.type === "release") {
      // Only a running main thread can post, so each of these is a heartbeat.
      const event = detector.heartbeat();
      cpuMark = attempt(() => deps.cpuUsage()) ?? cpuMark;
      cpuMarkAt = deps.now();
      if (event?.kind === "recovered") onRecovered(event.durationMs);
      if (message.type === "hold") holds += 1;
      else if (message.type === "release") holds = Math.max(0, holds - 1);
    } else if (message.type === "breadcrumb") {
      crumbs.push(message.crumb);
      if (crumbs.length > config.breadcrumbLimit) crumbs.splice(0, crumbs.length - config.breadcrumbLimit);
    } else if (message.type === "breadcrumbs") {
      crumbs.splice(0, crumbs.length, ...message.crumbs.slice(-config.breadcrumbLimit));
    } else if (message.type === "shutdown") {
      clearInterval(timer);
      attempt(() => port.close());
    }
  });
  attempt(() => port.postMessage({ type: "ready" }));
}

/** The worker's whole program, for `new Worker(source, { eval: true })`. */
export function hangWatchdogWorkerSource(): string {
  return [
    '"use strict";',
    'const { parentPort, workerData } = require("node:worker_threads");',
    `const createHangDetector = (${createHangDetector.toString()});`,
    `const captureMainThreadStack = (${captureMainThreadStack.toString()});`,
    `const runHangWatchdogWorker = (${runHangWatchdogWorker.toString()});`,
    "let inspector = null;",
    'try { inspector = require("node:inspector"); } catch { inspector = null; }',
    "runHangWatchdogWorker({",
    "  port: parentPort,",
    "  config: workerData,",
    '  fs: require("node:fs"),',
    '  os: require("node:os"),',
    "  inspector,",
    "  createHangDetector,",
    "  captureMainThreadStack,",
    "  now: () => Date.now(),",
    "  cpuUsage: () => process.cpuUsage(),",
    "  memoryUsage: () => process.memoryUsage(),",
    "});",
  ].join("\n");
}
