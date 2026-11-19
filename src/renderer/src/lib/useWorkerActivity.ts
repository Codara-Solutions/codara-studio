import { useEffect, useState } from "react";
import type { WorkerActivity } from "@shared/worker-feed";

const EMPTY: ReadonlyMap<string, WorkerActivity> = new Map();

/**
 * Keeps the newer of two copies of one attempt's activity (`seq` only rises).
 * An ended attempt stays as its `step: null` entry, so a read that lands after
 * the "ended" push never brings a finished worker back. Pure, for the tests.
 */
export function mergeWorkerActivity(
  current: ReadonlyMap<string, WorkerActivity>,
  incoming: readonly WorkerActivity[],
): ReadonlyMap<string, WorkerActivity> {
  let next: Map<string, WorkerActivity> | null = null;
  for (const activity of incoming) {
    const held = (next ?? current).get(activity.attemptId);
    if (held && held.seq >= activity.seq) continue;
    next ??= new Map(current);
    next.set(activity.attemptId, activity);
  }
  return next ?? current;
}

/**
 * What each live worker of one run is doing now, by attempt id. One push
 * subscription for the whole chat, and one read when the run changes: the
 * main process keeps the summaries, so no worker's feed is read for this.
 */
export function useWorkerActivity(runId: string | null, enabled = true): ReadonlyMap<string, WorkerActivity> {
  const [activity, setActivity] = useState<ReadonlyMap<string, WorkerActivity>>(EMPTY);
  useEffect(() => {
    setActivity(EMPTY);
    const api = window.spark?.workerFeed;
    if (!runId || !enabled || !api?.onActivity || !api.readActivity) return undefined;
    let disposed = false;
    const unsubscribe = api.onActivity((update) => {
      if (disposed || update.runId !== runId) return;
      setActivity((current) => mergeWorkerActivity(current, [update]));
    });
    api
      .readActivity(runId)
      .then((snapshot) => {
        if (!disposed) setActivity((current) => mergeWorkerActivity(current, snapshot));
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [runId, enabled]);
  return activity;
}
