import { useEffect, useState } from "react";
import {
  mergeWorkerFeedRecords,
  type WorkerFeedSnapshot,
  type WorkerFeedUpdate,
} from "@shared/worker-feed";

export interface WorkerFeedState extends WorkerFeedSnapshot {
  /** The first read has landed. */
  loaded: boolean;
  error: string | null;
}

const EMPTY: WorkerFeedState = {
  available: false,
  live: false,
  records: [],
  partial: null,
  loaded: false,
  error: null,
};

/**
 * One worker attempt's feed, live. Subscribes before it reads and merges by
 * record id, so nothing pushed during the read is lost; a reset (a new
 * session, or the writer dropped its oldest records) reads it again.
 */
export function useWorkerFeed(runId: string, attemptId: string | null): WorkerFeedState {
  const [state, setState] = useState<WorkerFeedState>(EMPTY);
  useEffect(() => {
    setState(EMPTY);
    if (!attemptId) return undefined;
    let disposed = false;
    let generation = 0;
    let pending: WorkerFeedUpdate[] = [];
    let reading = false;

    const apply = (base: WorkerFeedState, update: WorkerFeedUpdate): WorkerFeedState => ({
      ...base,
      ...(update.records ? { records: mergeWorkerFeedRecords(base.records, update.records), available: true } : {}),
      ...(update.partial !== undefined ? { partial: update.partial } : {}),
      ...(update.ended ? { live: false, partial: null } : {}),
    });

    const read = () => {
      const mine = (generation += 1);
      reading = true;
      pending = [];
      window.spark.workerFeed
        .read(runId, attemptId)
        .then((snapshot) => {
          if (disposed || mine !== generation) return;
          reading = false;
          const buffered = pending;
          pending = [];
          setState(() =>
            buffered.reduce<WorkerFeedState>(apply, { ...snapshot, loaded: true, error: null }),
          );
        })
        .catch((error: unknown) => {
          if (disposed || mine !== generation) return;
          reading = false;
          setState((current) => ({
            ...current,
            loaded: true,
            error: error instanceof Error ? error.message : String(error),
          }));
        });
    };

    const unsubscribe = window.spark.workerFeed.onUpdate((update) => {
      if (disposed || update.runId !== runId || update.attemptId !== attemptId) return;
      if (update.reset) {
        read();
        return;
      }
      if (reading) {
        pending.push(update);
        return;
      }
      setState((current) => apply(current, update));
      // A finished session's file is the record that lasts; read it once so
      // what is on screen is exactly what a reopen would show.
      if (update.ended) read();
    });
    read();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [runId, attemptId]);
  return state;
}
