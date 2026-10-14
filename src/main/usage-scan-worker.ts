// The usage scan thread. It owns the parsed-record memo, so the main process
// never holds a year of transcripts in its heap or blocks on the memo's JSON.
// Built to out/main/usage-scan-worker.js beside the main bundle (see
// electron.vite.config.ts) and started from source text by usage-analytics.ts.

import { parentPort } from "node:worker_threads";

import { scanUsage, type UsageScanRequest } from "./usage-scan";

export interface UsageScanJob {
  id: number;
  request: UsageScanRequest;
}

export type UsageScanReply =
  | { id: number; ok: true; summary: Awaited<ReturnType<typeof scanUsage>> }
  | { id: number; ok: false; error: string };

parentPort?.on("message", (job: UsageScanJob) => {
  scanUsage(job.request).then(
    (summary) => parentPort?.postMessage({ id: job.id, ok: true, summary } satisfies UsageScanReply),
    (err: unknown) =>
      parentPort?.postMessage({
        id: job.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies UsageScanReply),
  );
});
