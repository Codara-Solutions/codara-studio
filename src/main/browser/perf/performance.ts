// The performance tool's actions: vitals now, a traced page load, a traced
// interaction (start, then stop), and memory. Each result leads with one
// summary line and keeps the rest small; trace and heap files are paths.

import { mainFrameId } from "../audit/world";
import type { BrowserTarget } from "../targets";
import { sampleHeap, takeHeapSnapshot, type HeapSamples } from "./heap";
import { summarizeHeapSnapshotFile, type HeapSummary } from "./heap-summary";
import { discardTrace, startTrace, stopTrace, waitForEvent, TRACE_MAX_MS, type TraceFile } from "./trace";
import { summarizeTraceFile, type TraceSummary } from "./trace-summary";
import { awaitPresentation, ensureVitalsObserver, markVitals, readVitals, vitalsSummary, type Vitals } from "./vitals";
import { runInWorker } from "./worker";

/** Every action answers within this, under the MCP client's 60 s call limit. */
export const PERFORMANCE_DEADLINE_MS = 50_000;
export const LOAD_WAIT_DEFAULT_MS = 15_000;
export const SAMPLE_MAX_MS = 30_000;
const SETTLE_QUIET_MS = 500;
const SETTLE_MAX_MS = 3_000;
const PRESENTATION_MAX_MS = 3_000;
const TRACE_SUMMARY_MAX_BYTES = 200 * 1024 * 1024;
const HEAP_SUMMARY_MAX_BYTES = 768 * 1024 * 1024;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const BACKGROUND_PAINT_NOTE = "The tab is in the background; it was made to render for this measurement, so paint times can run later than in a foreground tab.";

interface PaintHold {
  background: boolean;
  release: () => Promise<void>;
}

/** Interaction traces in progress hold their tab's paint lease until stop. */
const interactionPaint = new Map<string, PaintHold>();

async function holdPaint(target: BrowserTarget, ms: number): Promise<PaintHold> {
  const none: PaintHold = { background: false, release: async () => {} };
  if (!target.keepPainting) return none;
  return target.keepPainting(ms).catch(() => none);
}

async function releaseInteractionPaint(target: BrowserTarget): Promise<PaintHold | null> {
  const hold = interactionPaint.get(target.ref) ?? null;
  interactionPaint.delete(target.ref);
  await hold?.release();
  return hold;
}

function mb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

async function pageUrl(target: BrowserTarget, fallback = ""): Promise<string> {
  return (await target.info().catch(() => null))?.url || fallback;
}

/** Wait until the network has been idle a moment, or maxMs passed. */
async function settle(target: BrowserTarget, maxMs: number): Promise<void> {
  let inflight = 0;
  let lastActivity = Date.now();
  const started = Date.now();
  const offs = [
    target.session.on("Network.requestWillBeSent", () => {
      inflight += 1;
      lastActivity = Date.now();
    }),
    target.session.on("Network.loadingFinished", () => {
      inflight = Math.max(0, inflight - 1);
      lastActivity = Date.now();
    }),
    target.session.on("Network.loadingFailed", () => {
      inflight = Math.max(0, inflight - 1);
      lastActivity = Date.now();
    }),
  ];
  try {
    while (Date.now() - started < maxMs) {
      if (inflight === 0 && Date.now() - lastActivity >= SETTLE_QUIET_MS) return;
      await sleep(100);
    }
  } finally {
    for (const off of offs) off();
  }
}

async function summarizeTrace(file: TraceFile, deadline: number): Promise<TraceSummary | { note: string }> {
  const timeoutMs = Math.max(2_000, deadline - Date.now());
  try {
    return await runInWorker(summarizeTraceFile, { path: file.path, frameId: file.frameId, maxBytes: TRACE_SUMMARY_MAX_BYTES }, { timeoutMs, maxOldGenerationSizeMb: 1536 });
  } catch (error) {
    return { note: `The trace summary failed (${error instanceof Error ? error.message : String(error)}); open the file in DevTools.` };
  }
}

function traceLine(trace: TraceSummary | { note: string }): string {
  if (!("mainThread" in trace) || !trace.mainThread) return "";
  const main = trace.mainThread;
  const parts = [`Main thread busy ${Math.round(main.busyMs)} ms (scripting ${Math.round(main.scriptingMs)}, rendering ${Math.round(main.renderingMs)}, painting ${Math.round(main.paintingMs)})`];
  const tasks = trace.longTasks;
  if (tasks.count) {
    const longest = tasks.longest[0];
    parts.push(`${tasks.count} long task${tasks.count === 1 ? "" : "s"} blocking ${Math.round(tasks.blockingMs)} ms${longest ? `, longest ${Math.round(longest.ms)} ms in ${longest.cause}` : ""}`);
  } else {
    parts.push("no long tasks");
  }
  return ` ${parts.join("; ")}.`;
}

/**
 * Fill paint marks the observer could not see (a page that never reported
 * them) from the trace, and let the trace's long tasks, which name their
 * cause, replace the observer's.
 */
function withTraceMarks(vitals: Vitals, trace: TraceSummary | { note: string }): Vitals {
  if (!("marks" in trace)) return vitals;
  const notes = [...(vitals.notes ?? [])];
  const out: Vitals = { ...vitals };
  if (trace.mainThread) {
    delete out.longTasks;
    delete out.slowFrames;
  }
  if (!out.lcp && trace.marks.lcpMs !== undefined) {
    notes.push(`LCP from the trace only: ${trace.marks.lcpMs} ms, element unknown.`);
  }
  if (!out.fcp && trace.marks.fcpMs !== undefined) {
    notes.push(`FCP from the trace only: ${trace.marks.fcpMs} ms.`);
  }
  if (notes.length) out.notes = notes;
  return out;
}

function compactTrace(trace: TraceSummary | { note: string }): Record<string, unknown> {
  if (!("mainThread" in trace)) return trace;
  return {
    durationMs: trace.durationMs,
    ...(trace.mainThread ? { mainThread: trace.mainThread } : {}),
    longTasks: trace.longTasks,
    ...(trace.topScripts.length ? { topScripts: trace.topScripts } : {}),
    ...(Object.keys(trace.marks).length ? { marks: trace.marks } : {}),
    ...(trace.note ? { note: trace.note } : {}),
  };
}

export async function measureVitals(target: BrowserTarget): Promise<Record<string, unknown>> {
  const fresh = await ensureVitalsObserver(target.session);
  if (!fresh) await awaitPresentation(target.session, { maxMs: PRESENTATION_MAX_MS });
  const { url, vitals } = await readVitals(target);
  if (fresh) {
    vitals.notes = [
      ...(vitals.notes ?? []),
      "Measuring started now on a loaded page: interactions faster than 104 ms before this call were not seen. Use action load for a full page load.",
    ];
  }
  return { tabId: target.ref, url, action: "vitals", summary: vitalsSummary(vitals), ...vitals };
}

export async function measureLoad(target: BrowserTarget, waitMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + PERFORMANCE_DEADLINE_MS;
  const releasePage = await target.session.enable("Page");
  try {
    await ensureVitalsObserver(target.session);
    const frameId = await mainFrameId(target.session).catch(() => null);
    await startTrace(target, { frameId, label: "load" });
    let loadNote: string | null = null;
    const paint = await holdPaint(target, waitMs + SETTLE_MAX_MS + 10_000);
    try {
      const loaded = waitForEvent(target.session, "Page.loadEventFired", waitMs);
      // A browser-initiated Page.reload makes the app re-create a preview
      // <webview>, which detaches the debugger and drops the trace with it; a
      // reload the page itself starts keeps the same guest.
      await target.session.send("Runtime.evaluate", { expression: "location.reload()" });
      await loaded.promise.catch(() => {
        loadNote = `The page did not finish loading within ${Math.round(waitMs / 1000)} s; this covers what happened until then.`;
      });
      await settle(target, Math.min(SETTLE_MAX_MS, Math.max(0, deadline - Date.now() - 15_000)));
      await awaitPresentation(target.session, { paint: true, maxMs: Math.min(PRESENTATION_MAX_MS, Math.max(0, deadline - Date.now() - 15_000)) });
      // Shifts count only against painted content, so what moves the page
      // right after its first paint (late banners, images) needs a moment more.
      await sleep(Math.min(SETTLE_QUIET_MS, Math.max(0, deadline - Date.now() - 15_000)));
    } catch (error) {
      await paint.release();
      await discardTrace(target);
      throw error;
    }
    const file = await stopTrace(target).finally(() => paint.release());
    const [{ url, vitals }, trace] = await Promise.all([readVitals(target), summarizeTrace(file, deadline)]);
    const merged = withTraceMarks(vitals, trace);
    const notes = merged.notes ?? [];
    if (paint.background) notes.push(BACKGROUND_PAINT_NOTE);
    const tracedFcp = "marks" in trace && trace.marks.fcpMs !== undefined;
    if (!merged.fcp && !tracedFcp && !notes.some((note) => note.includes("painted nothing"))) {
      notes.push("The page painted nothing during the load, so there is no LCP or FCP: the tab rendered no frames (a minimized or hidden window, or a background tab in another browser).");
    }
    if (loadNote) notes.push(loadNote);
    if (notes.length) merged.notes = notes;
    if (file.dataLoss) merged.notes = [...(merged.notes ?? []), "The trace buffer filled up; the file is missing its end."];
    return {
      tabId: target.ref,
      url,
      action: "load",
      summary: `Page load: ${vitalsSummary(merged, { traced: "mainThread" in trace && Boolean(trace.mainThread), load: true })}${traceLine(trace)}`,
      ...merged,
      trace: compactTrace(trace),
      path: file.path,
    };
  } finally {
    await releasePage();
  }
}

export async function startInteractionTrace(target: BrowserTarget): Promise<Record<string, unknown>> {
  await ensureVitalsObserver(target.session);
  await markVitals(target.session);
  const frameId = await mainFrameId(target.session).catch(() => null);
  await releaseInteractionPaint(target);
  await startTrace(target, { frameId, label: "interaction" });
  interactionPaint.set(target.ref, await holdPaint(target, TRACE_MAX_MS + 10_000));
  return {
    tabId: target.ref,
    url: await pageUrl(target),
    action: "start",
    tracing: true,
    summary: `Tracing. Interact with the page now (click, type, scroll), then call action stop. It stops by itself after ${TRACE_MAX_MS / 1000} s.`,
  };
}

export async function stopInteractionTrace(target: BrowserTarget): Promise<Record<string, unknown>> {
  const deadline = Date.now() + PERFORMANCE_DEADLINE_MS;
  let paint: PaintHold | null = null;
  let file: TraceFile;
  try {
    await awaitPresentation(target.session, { maxMs: PRESENTATION_MAX_MS }).catch(() => {});
    file = await stopTrace(target);
  } finally {
    paint = await releaseInteractionPaint(target);
  }
  const [read, trace] = await Promise.all([
    readVitals(target).then(async (read) => {
      await markVitals(target.session, true).catch(() => {});
      return read;
    }, () => null),
    summarizeTrace(file, deadline),
  ]);
  const notes: string[] = [];
  if (paint?.background) notes.push(BACKGROUND_PAINT_NOTE);
  if (file.stoppedAutomatically) notes.push(`The trace stopped by itself after ${TRACE_MAX_MS / 1000} s.`);
  if (file.dataLoss) notes.push("The trace buffer filled up; the file is missing its end.");
  if (!read) notes.push("The page navigated or closed; only the trace is available.");
  const vitals = read ? withTraceMarks(read.vitals, trace) : null;
  if (vitals && notes.length) vitals.notes = [...(vitals.notes ?? []), ...notes];
  const head = vitals ? `Interaction (${Math.round(file.durationMs / 1000)} s): ${vitalsSummary(vitals, { traced: "mainThread" in trace && Boolean(trace.mainThread) })}` : `Interaction (${Math.round(file.durationMs / 1000)} s).`;
  return {
    tabId: target.ref,
    url: read?.url ?? (await pageUrl(target)),
    action: "stop",
    summary: `${head}${traceLine(trace)}`,
    ...(vitals ?? { notes }),
    trace: compactTrace(trace),
    path: file.path,
  };
}

function heapLine(heap: HeapSamples): string {
  const first = heap.samples[0];
  const last = heap.samples[heap.samples.length - 1];
  let line = `JS heap ${mb(last.usedBytes)} used of ${mb(last.totalBytes)}`;
  if (heap.samples.length > 1) {
    const delta = last.usedBytes - first.usedBytes;
    const seconds = Math.round(last.atMs / 1000);
    const trend = Math.abs(delta) < 256 * 1024 ? "flat" : delta > 0 ? "growing" : "shrinking";
    line += `, ${delta >= 0 ? "+" : "-"}${mb(Math.abs(delta))} over ${seconds} s${heap.collectedGarbage ? " after garbage collection" : ""} (${trend})`;
  }
  const nodes = heap.after.nodes;
  if (nodes !== undefined) {
    const change = heap.before.nodes !== undefined && heap.samples.length > 1 ? nodes - heap.before.nodes : 0;
    line += `; ${nodes} DOM nodes${change ? ` (${change > 0 ? "+" : ""}${change})` : ""}`;
  }
  if (heap.after.listeners !== undefined) line += `, ${heap.after.listeners} event listener${heap.after.listeners === 1 ? "" : "s"}`;
  return `${line}.`;
}

function snapshotLine(summary: HeapSummary): string {
  const top = summary.retainers.slice(0, 3).map((row) => `${row.path} ${mb(row.retainedBytes)}`).join(", ");
  const detached = summary.detached.count ? ` ${summary.detached.count} detached DOM nodes${summary.detached.retainedBytes ? ` retaining ${mb(summary.detached.retainedBytes)}` : ""}.` : "";
  return ` Snapshot: ${mb(summary.totalBytes)} in ${summary.nodes} objects${top ? `; largest retainers ${top}` : ""}.${detached}`;
}

export async function measureMemory(target: BrowserTarget, durationMs: number, snapshot: boolean): Promise<Record<string, unknown>> {
  const deadline = Date.now() + PERFORMANCE_DEADLINE_MS;
  const heap = await sampleHeap(target, durationMs);
  const last = heap.samples[heap.samples.length - 1];
  const result: Record<string, unknown> = {
    tabId: target.ref,
    url: await pageUrl(target),
    action: "memory",
    heap: {
      usedBytes: last.usedBytes,
      totalBytes: last.totalBytes,
      ...(heap.samples.length > 1 ? { samples: heap.samples.map((sample) => [Math.round(sample.atMs), Math.round(sample.usedBytes / 1024)]), samplesAre: "[ms, KB used]" } : {}),
    },
    page: heap.samples.length > 1 ? { before: heap.before, after: heap.after } : heap.after,
  };
  let summary = heapLine(heap);
  if (snapshot) {
    const path = await takeHeapSnapshot(target);
    result.path = path;
    try {
      const timeoutMs = Math.max(3_000, deadline - Date.now());
      const analysis = await runInWorker(summarizeHeapSnapshotFile, { path, maxBytes: HEAP_SUMMARY_MAX_BYTES, maxNodesForRetained: 4_000_000 }, { timeoutMs, maxOldGenerationSizeMb: 1536 });
      summary += snapshotLine(analysis);
      result.snapshot = {
        nodes: analysis.nodes,
        totalBytes: analysis.totalBytes,
        retainers: analysis.retainers,
        classes: analysis.classes.slice(0, 8),
        ...(analysis.detached.count ? { detached: analysis.detached } : {}),
        ...(analysis.note ? { note: analysis.note } : {}),
      };
    } catch (error) {
      result.snapshot = { note: `The snapshot was saved but not summarized (${error instanceof Error ? error.message : String(error)}); open it in DevTools.` };
      summary += " Snapshot saved; open it in DevTools.";
    }
  }
  const { tabId, url, action, ...rest } = result;
  return { tabId, url, action, summary, ...rest };
}
