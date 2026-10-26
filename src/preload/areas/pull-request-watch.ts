// window.spark.pullRequestWatch: the renderer side of the pull request
// watcher (src/main/github-ci-watch.ts, src/main/pull-request-watch-ipc.ts).

import { ipcRenderer } from "electron";

import {
  PULL_REQUEST_WATCH_CHANGED_CHANNEL,
  type PullRequestWatchChange,
  type PullRequestWatchEntry,
} from "@shared/pull-request-watch";

export const pullRequestWatchApi = {
  list: (): Promise<PullRequestWatchEntry[]> => ipcRenderer.invoke("pullRequestWatch:list"),
  setRepositoryWatched: (repository: string, watched: boolean): Promise<boolean> =>
    ipcRenderer.invoke("pullRequestWatch:setRepositoryWatched", repository, watched),
  onChanged: (listener: (change: PullRequestWatchChange) => void): (() => void) => {
    const wrapped = (_event: unknown, change: PullRequestWatchChange): void => listener(change);
    ipcRenderer.on(PULL_REQUEST_WATCH_CHANGED_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(PULL_REQUEST_WATCH_CHANGED_CHANNEL, wrapped);
  },
};
