// window.spark.workerFeed: a Cora worker's own conversation (src/shared/
// worker-feed.ts, written by src/main/orchestration/worker-feed.ts) and the
// one way the chat talks to a running worker.

import { ipcRenderer } from "electron";

import type { WorkerFeedSnapshot, WorkerFeedUpdate } from "@shared/worker-feed";
import { subscribe } from "../subscribe";

export const workerFeedApi = {
  /** Subscribe with onUpdate first, then read, and merge: records carry ids. */
  read: (runId: string, attemptId: string): Promise<WorkerFeedSnapshot> =>
    ipcRenderer.invoke("orchestration:readWorkerFeed", { runId, attemptId }),
  /** Steers a running Pi worker; `delivered` is false when it no longer takes messages. */
  message: (runId: string, attemptId: string, text: string): Promise<{ delivered: boolean }> =>
    ipcRenderer.invoke("orchestration:messageWorker", { runId, attemptId, text }),
  onUpdate: subscribe<WorkerFeedUpdate>("orchestration:workerFeed"),
};
