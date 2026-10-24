// JS heap usage over time and heap snapshots. A snapshot streams straight to
// a .heapsnapshot file (DevTools' Memory panel loads it) and is summarized
// in a worker; neither the snapshot nor its parse ever sits in main's heap.

import { createWriteStream } from "node:fs";

import { writeBrowserArtifact } from "../artifacts";
import type { BrowserTarget } from "../targets";

export interface HeapSample {
  atMs: number;
  usedBytes: number;
  totalBytes: number;
}

export interface PageCounters {
  nodes?: number;
  listeners?: number;
  documents?: number;
  frames?: number;
}

export interface HeapSamples {
  samples: HeapSample[];
  before: PageCounters;
  after: PageCounters;
  collectedGarbage: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function counters(target: BrowserTarget): Promise<PageCounters> {
  const result = await target.session.send<{ metrics?: Array<{ name: string; value: number }> }>("Performance.getMetrics").catch(() => null);
  const value = (name: string) => result?.metrics?.find((metric) => metric.name === name)?.value;
  const out: PageCounters = {};
  const nodes = value("Nodes");
  const listeners = value("JSEventListeners");
  const documents = value("Documents");
  const frames = value("Frames");
  if (nodes !== undefined) out.nodes = nodes;
  if (listeners !== undefined) out.listeners = listeners;
  if (documents !== undefined) out.documents = documents;
  if (frames !== undefined) out.frames = frames;
  return out;
}

async function usage(target: BrowserTarget, startedAt: number): Promise<HeapSample> {
  const heap = await target.session.send<{ usedSize?: number; totalSize?: number }>("Runtime.getHeapUsage");
  return { atMs: Date.now() - startedAt, usedBytes: heap.usedSize ?? 0, totalBytes: heap.totalSize ?? 0 };
}

/**
 * Sample the heap for durationMs (one sample when 0). With a duration, the
 * first and last samples follow a garbage collection, so the difference is
 * memory the page kept, not garbage it had not collected yet.
 */
export async function sampleHeap(target: BrowserTarget, durationMs: number): Promise<HeapSamples> {
  const releasePerformance = await target.session.enable("Performance").catch(() => null);
  const releaseHeap = durationMs > 0 ? await target.session.enable("HeapProfiler").catch(() => null) : null;
  const collect = async () => (releaseHeap ? target.session.send("HeapProfiler.collectGarbage").then(() => true, () => false) : false);
  try {
    const startedAt = Date.now();
    const collectedGarbage = await collect();
    const before = await counters(target);
    const samples = [await usage(target, startedAt)];
    if (durationMs > 0) {
      const interval = Math.min(2_000, Math.max(250, Math.round(durationMs / 12)));
      while (Date.now() - startedAt + interval < durationMs) {
        await sleep(interval);
        samples.push(await usage(target, startedAt));
      }
      await sleep(Math.max(0, durationMs - (Date.now() - startedAt)));
      await collect();
      samples.push(await usage(target, startedAt));
    }
    return { samples, before, after: durationMs > 0 ? await counters(target) : before, collectedGarbage };
  } finally {
    await releaseHeap?.();
    await releasePerformance?.();
  }
}

/** Take a heap snapshot into a file; returns its path. */
export async function takeHeapSnapshot(target: BrowserTarget): Promise<string> {
  const path = await writeBrowserArtifact(target.workspaceId, "traces", { label: "heap", ext: "heapsnapshot", data: "" });
  const out = createWriteStream(path);
  let failure: Error | null = null;
  out.once("error", (error) => {
    failure = error;
  });
  const off = target.session.on("HeapProfiler.addHeapSnapshotChunk", (params) => {
    if (typeof params.chunk === "string") out.write(params.chunk);
  });
  const release = await target.session.enable("HeapProfiler");
  try {
    await target.session.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: false });
  } finally {
    off();
    await release();
    await new Promise<void>((resolve) => out.end(resolve));
  }
  if (failure) throw failure;
  return path;
}
