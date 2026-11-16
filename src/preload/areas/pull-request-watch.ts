// window.spark.pullRequestWatch: the renderer side of the pull request
// watcher (src/main/github-ci-watch.ts, src/main/pull-request-watch-ipc.ts).

import { ipcRenderer } from "electron";

import {
  PULL_REQUEST_WATCH_CHANGED_CHANNEL,
  type PullRequestWatchChange,
  type PullRequestWatchEntry,
} from "@shared/pull-request-watch";
import { subscribe } from "../subscribe";

export const pullRequestWatchApi = {
  list: (): Promise<PullRequestWatchEntry[]> => ipcRenderer.invoke("pullRequestWatch:list"),
  setRepositoryWatched: (repository: string, watched: boolean): Promise<boolean> =>
    ipcRenderer.invoke("pullRequestWatch:setRepositoryWatched", repository, watched),
  onChanged: subscribe<PullRequestWatchChange>(PULL_REQUEST_WATCH_CHANGED_CHANNEL),
};
