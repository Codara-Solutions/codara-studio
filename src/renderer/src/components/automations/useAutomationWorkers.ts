import { useEffect, useRef, useState } from "react";
import type { AutomationWorkerInfo } from "@shared/types";

// Live inventory behind the Hub's Workers sub-tab. Sources, in order of
// freshness: the automation.worker spawn/exit pings, the loop's
// automation.iteration / automation.updated events, and a 5s safety poll
// while the view is active. Workers that exited stay listed for a minute
// (with their terminal pane still readable) before dropping off.

const LINGER_MS = 60_000;
const POLL_MS = 5_000;

const TERMINAL_ATTEMPT = new Set(["succeeded", "failed", "timed_out", "cancelled"]);

/** A worker that disappeared from the authoritative inventory may linger only as
 * terminal history. Any blocked question it used to own is resolved/released now;
 * retaining that payload would keep LiveBoard's answer strip actionable for 60s. */
export function toLingeringAutomationWorker(
  worker: AutomationWorkerInfo,
): AutomationWorkerInfo {
  return {
    ...worker,
    status: TERMINAL_ATTEMPT.has(worker.status) ? worker.status : "succeeded",
    blocked: false,
    question: undefined,
    questionMessageId: undefined,
  };
}

interface Lingering {
  worker: AutomationWorkerInfo;
  exitedAt: number;
}

export function useAutomationWorkers(active: boolean): AutomationWorkerInfo[] {
  const [workers, setWorkers] = useState<AutomationWorkerInfo[]>([]);
  const lingeringRef = useRef<Map<string, Lingering>>(new Map());
  // Previous-list source for the linger reconciliation. All map mutation
  // happens HERE in refresh(), never inside the setWorkers updater — React
  // state updaters must be pure (StrictMode double-invokes them in dev, which
  // would resurrect just-expired entries and ghost-renew exited panes).
  const workersRef = useRef<AutomationWorkerInfo[]>([]);

  useEffect(() => {
    if (!active) return;
    let disposed = false;

    const refresh = async (): Promise<void> => {
      try {
        const live = await window.spark.scheduler.listActiveWorkers();
        if (disposed) return;
        const linger = lingeringRef.current;
        const liveIds = new Set(live.map((w) => w.attemptId));
        const now = Date.now();
        // Anything we knew about that is no longer live moves to the linger
        // set; expired lingerers drop.
        for (const w of workersRef.current) {
          if (!liveIds.has(w.attemptId) && !linger.has(w.attemptId)) {
            linger.set(w.attemptId, {
              worker: toLingeringAutomationWorker(w),
              exitedAt: now,
            });
          }
        }
        for (const [id, item] of linger) {
          if (liveIds.has(id) || now - item.exitedAt > LINGER_MS) linger.delete(id);
        }
        const next = [...live, ...[...linger.values()].map((l) => l.worker)];
        workersRef.current = next;
        setWorkers(next);
      } catch {
        /* keep the last good list; the next event/poll retries */
      }
    };

    void refresh();
    const unsubscribe = window.spark.orchestration.onEvent((event) => {
      if (
        event.type === "automation.worker" ||
        event.type === "automation.iteration" ||
        event.type === "automation.updated"
      ) {
        void refresh();
      }
    });
    const interval = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      disposed = true;
      unsubscribe();
      window.clearInterval(interval);
    };
  }, [active]);

  return workers;
}
