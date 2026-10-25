// The usage scan thread. It owns the parsed-record memo, so the main process
// never holds a year of transcripts in its heap or blocks on the memo's JSON.
// Built to out/main/usage-scan-worker.js beside the main bundle (see
// electron.vite.config.ts) and started from source text by usage-analytics.ts.

import { parentPort } from "node:worker_threads";

import {
  scanUsage,
  scanUsageTimeline,
  type UsageScanRequest,
  type UsageTimeline,
  type UsageTimelineRequest,
} from "./usage-scan";
import {
  scanForecastSignals,
  type ForecastSignals,
  type ForecastSignalsRequest,
} from "./usage-forecast-signals";

/** What the usage forecast reads: spend over time and the CLIs' own limit readings. */
export interface ForecastScan {
  timeline: UsageTimeline;
  signals: ForecastSignals;
}

export type UsageScanWork =
  | { request: UsageScanRequest }
  | { timeline: UsageTimelineRequest; signals: ForecastSignalsRequest };

export type UsageScanJob = { id: number } & UsageScanWork;

export type UsageScanResult = Awaited<ReturnType<typeof scanUsage>> | ForecastScan;

export type UsageScanReply =
  | { id: number; ok: true; summary: UsageScanResult }
  | { id: number; ok: false; error: string };

export async function runForecastScan(
  timeline: UsageTimelineRequest,
  signals: ForecastSignalsRequest,
): Promise<ForecastScan> {
  return { timeline: await scanUsageTimeline(timeline), signals: await scanForecastSignals(signals) };
}

parentPort?.on("message", (job: UsageScanJob) => {
  const work: Promise<UsageScanResult> =
    "timeline" in job ? runForecastScan(job.timeline, job.signals) : scanUsage(job.request);
  work.then(
    (summary) => parentPort?.postMessage({ id: job.id, ok: true, summary } satisfies UsageScanReply),
    (err: unknown) =>
      parentPort?.postMessage({
        id: job.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies UsageScanReply),
  );
});
