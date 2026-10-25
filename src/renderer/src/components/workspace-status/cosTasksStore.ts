import { useSyncExternalStore } from "react";
import type { TaskSummary } from "@shared/cos-tasks";

// Every workspace's task list summary, as main computes it from the tasks
// (src/main/cos/): the count line and the oldest needs_you reason. One
// subscription for the whole window, read through the hook below.

let summaries: Record<string, TaskSummary> = {};
let started = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function put(workspaceId: string, summary: TaskSummary | null): void {
  const next = { ...summaries };
  if (summary) next[workspaceId] = summary;
  else delete next[workspaceId];
  summaries = next;
  emit();
}

// "done today" is counted when main computes a summary; past midnight
// nothing changes on its own, so the summaries are fetched again then.
function refreshAtMidnight(): void {
  const next = new Date();
  next.setHours(24, 0, 5, 0);
  setTimeout(() => {
    void window.spark?.cosTasks
      ?.summaries()
      .then((listed) => {
        summaries = listed;
        emit();
      })
      .catch(() => undefined)
      .finally(refreshAtMidnight);
  }, next.getTime() - Date.now());
}

function start(): void {
  if (started) return;
  started = true;
  const api = window.spark?.cosTasks;
  if (!api) return;
  refreshAtMidnight();
  // A change that lands while the first list is in flight is newer than it.
  const changedDuringLoad = new Set<string>();
  let loaded = false;
  api.onChanged(({ workspaceId, summary }) => {
    if (!loaded) changedDuringLoad.add(workspaceId);
    put(workspaceId, summary);
  });
  void api
    .summaries()
    .then((listed) => {
      const next: Record<string, TaskSummary> = { ...listed };
      for (const id of changedDuringLoad) {
        if (summaries[id]) next[id] = summaries[id];
        else delete next[id];
      }
      summaries = next;
      emit();
    })
    .catch(() => undefined)
    .finally(() => {
      loaded = true;
    });
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A workspace's task summary, or null when it has no task list. */
export function useTaskSummary(workspaceId: string | null | undefined): TaskSummary | null {
  return useSyncExternalStore(subscribe, () => (workspaceId ? summaries[workspaceId] ?? null : null));
}
