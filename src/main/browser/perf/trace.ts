// Performance traces over the tab's own DevTools protocol session, saved as
// a JSON trace file the Performance panel of any Chromium DevTools opens.
// Tracing works on a hidden tab and with the window minimized: nothing here
// needs a DevTools window or focus.

import { createWriteStream } from "node:fs";

import { writeBrowserArtifact } from "../artifacts";
import type { CdpSession } from "../cdp-session";
import type { BrowserTarget } from "../targets";

// The Performance panel's own categories, minus screenshots (a hidden tab
// paints none, and they make the file several times larger).
export const TRACE_CATEGORIES = [
  "-*",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "disabled-by-default-devtools.timeline.invalidationTracking",
  "v8.execute",
  "disabled-by-default-v8.cpu_profiler",
  "blink.user_timing",
  "blink.console",
  "loading",
  "latencyInfo",
  "toplevel",
  "__metadata",
];

/** An interaction trace stops by itself after this long, so a forgotten one cannot fill memory. */
export const TRACE_MAX_MS = 60_000;

export interface TraceFile {
  path: string;
  frameId: string | null;
  durationMs: number;
  dataLoss: boolean;
  stoppedAutomatically: boolean;
}

interface ActiveTrace {
  startedAt: number;
  frameId: string | null;
  workspaceId: string | null;
  label: string;
  timer: ReturnType<typeof setTimeout> | null;
  stopping: Promise<TraceFile> | null;
  lost: string | null;
  offDetach: () => void;
}

const active = new WeakMap<CdpSession, ActiveTrace>();

export class TraceStateError extends Error {}

/** Resolve with the event's params, or reject after timeoutMs. */
export function waitForEvent(session: CdpSession, method: string, timeoutMs: number): { promise: Promise<Record<string, unknown>>; cancel: () => void } {
  let off = () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
    off = session.on(method, (params) => {
      cleanup();
      resolve(params);
    });
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${method} did not arrive within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
  });
  const cleanup = () => {
    off();
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return { promise, cancel: cleanup };
}

export async function startTrace(target: BrowserTarget, options: { frameId: string | null; label: string }): Promise<void> {
  const session = target.session;
  const previous = active.get(session);
  // One that stopped by itself and was never collected gives way.
  if (previous?.stopping) active.delete(session);
  else if (previous) throw new TraceStateError("A trace is already running on this tab. Call action stop first.");
  await session.send("Tracing.start", {
    traceConfig: { includedCategories: TRACE_CATEGORIES, recordMode: "recordUntilFull" },
    transferMode: "ReturnAsStream",
    streamFormat: "json",
    streamCompression: "none",
  });
  const trace: ActiveTrace = {
    startedAt: Date.now(),
    frameId: options.frameId,
    workspaceId: target.workspaceId,
    label: options.label,
    timer: null,
    stopping: null,
    lost: null,
    offDetach: () => {},
  };
  trace.offDetach = session.onDetach((reason) => {
    trace.lost = `The tab's DevTools connection closed during the trace (${reason}).`;
  });
  trace.timer = setTimeout(() => {
    trace.timer = null;
    void finishTrace(session, trace, true).catch(() => {});
  }, TRACE_MAX_MS);
  trace.timer.unref?.();
  active.set(session, trace);
}

/** End the tab's trace and save it; a trace that already stopped by itself is returned as is. */
export async function stopTrace(target: BrowserTarget): Promise<TraceFile> {
  const trace = active.get(target.session);
  if (!trace) throw new TraceStateError("No trace is running on this tab. Call action start first, or use action load.");
  try {
    return await finishTrace(target.session, trace, false);
  } finally {
    active.delete(target.session);
  }
}

/** Abandon a running trace (the load that needed it failed). */
export async function discardTrace(target: BrowserTarget): Promise<void> {
  const trace = active.get(target.session);
  if (!trace) return;
  active.delete(target.session);
  if (trace.timer) clearTimeout(trace.timer);
  trace.offDetach();
  if (!trace.stopping) await target.session.send("Tracing.end").catch(() => {});
}

function finishTrace(session: CdpSession, trace: ActiveTrace, automatic: boolean): Promise<TraceFile> {
  trace.stopping ??= (async () => {
    if (trace.timer) clearTimeout(trace.timer);
    trace.timer = null;
    try {
      if (trace.lost) throw new Error(trace.lost);
      const complete = waitForEvent(session, "Tracing.tracingComplete", 30_000);
      try {
        await session.send("Tracing.end");
      } catch (error) {
        complete.cancel();
        throw error;
      }
      const done = await complete.promise;
      const stream = typeof done.stream === "string" ? done.stream : null;
      if (!stream) throw new Error("The browser returned no trace data.");
      const path = await writeBrowserArtifact(trace.workspaceId, "traces", { label: trace.label, ext: "json", data: "" });
      await copyStream(session, stream, path);
      return {
        path,
        frameId: trace.frameId,
        durationMs: Date.now() - trace.startedAt,
        dataLoss: done.dataLossOccurred === true,
        stoppedAutomatically: automatic,
      };
    } finally {
      trace.offDetach();
    }
  })();
  return trace.stopping;
}

/** Copy a protocol IO stream into a file without holding it in memory. */
export async function copyStream(session: CdpSession, handle: string, path: string): Promise<void> {
  const out = createWriteStream(path);
  const failed = new Promise<never>((_, reject) => out.once("error", reject));
  failed.catch(() => {});
  try {
    for (;;) {
      const chunk = await Promise.race([session.send<{ data?: string; eof?: boolean; base64Encoded?: boolean }>("IO.read", { handle, size: 1 << 20 }), failed]);
      if (chunk.data) {
        const data = chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : chunk.data;
        if (!out.write(data)) await Promise.race([new Promise<void>((resolve) => out.once("drain", () => resolve())), failed]);
      }
      if (chunk.eof) break;
    }
  } finally {
    await session.send("IO.close", { handle }).catch(() => {});
    await new Promise<void>((resolve) => out.end(resolve));
  }
}
