import { useSyncExternalStore } from "react";
import type { PullRequestWatchEntry } from "@shared/pull-request-watch";

// What the pull request watcher (src/main/github-ci-watch.ts) says about
// each workspace's branch: its pull request and checks, or that its
// repository is switched off. One subscription for the whole window; rail
// rows read it through the hook below.

let entries: Record<string, PullRequestWatchEntry> = {};
let started = false;
const listeners = new Set<() => void>();

function put(workspaceId: string, entry: PullRequestWatchEntry | null): void {
  const next = { ...entries };
  if (entry) next[workspaceId] = entry;
  else delete next[workspaceId];
  entries = next;
  for (const listener of listeners) listener();
}

function start(): void {
  if (started) return;
  started = true;
  const api = window.spark?.pullRequestWatch;
  if (!api) return;
  // A change that lands while the first list is in flight is newer than it.
  const changedDuringLoad = new Set<string>();
  let loaded = false;
  api.onChanged(({ workspaceId, entry }) => {
    if (!loaded) changedDuringLoad.add(workspaceId);
    put(workspaceId, entry);
  });
  void api
    .list()
    .then((listed) => {
      const next: Record<string, PullRequestWatchEntry> = {};
      for (const entry of listed) next[entry.workspaceId] = entry;
      for (const id of changedDuringLoad) {
        if (entries[id]) next[id] = entries[id];
        else delete next[id];
      }
      entries = next;
      for (const listener of listeners) listener();
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

/** A workspace's pull request watch, or null when its branch has none. */
export function usePullRequestWatch(workspaceId: string | null | undefined): PullRequestWatchEntry | null {
  return useSyncExternalStore(subscribe, () => (workspaceId ? entries[workspaceId] ?? null : null));
}

/** Every workspace's pull request watch, by workspace id. */
export function usePullRequestWatches(): Readonly<Record<string, PullRequestWatchEntry>> {
  return useSyncExternalStore(subscribe, () => entries);
}

/** Switches the watcher on or off for a repository ("owner/name"). */
export function setRepositoryWatched(repository: string, watched: boolean): Promise<boolean> {
  return window.spark.pullRequestWatch.setRepositoryWatched(repository, watched);
}
