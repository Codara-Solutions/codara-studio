// The renderer side of the pull request watcher (github-ci-watch.ts): what
// each workspace's row shows, and the per-repository switch in the row menu.
// ipc.ts registers these channels once; the renderer reads them through
// window.spark.pullRequestWatch (src/preload/areas/pull-request-watch.ts).

import { normalizeRepository, type PullRequestWatchEntry } from "@shared/pull-request-watch";
import { pullRequestWatchEntries } from "./github-ci-watch";
import type { IpcHandle } from "./ipc";
import { getPreferenceCached, setPreference } from "./preferences-store";

export function registerPullRequestWatchIpc(handle: IpcHandle): void {
  handle("pullRequestWatch:list", (): PullRequestWatchEntry[] => pullRequestWatchEntries());
  handle("pullRequestWatch:setRepositoryWatched", async (_event, rawRepository: unknown, watched: unknown): Promise<boolean> => {
    const repository = normalizeRepository(rawRepository);
    if (!repository || typeof watched !== "boolean") throw new TypeError("A repository (owner/name) and on or off are required.");
    const off = new Set(getPreferenceCached("pullRequestWatchOffRepos") ?? []);
    if (watched) off.delete(repository);
    else off.add(repository);
    // The watcher hears the preference change and runs a pass at once.
    await setPreference("pullRequestWatchOffRepos", [...off]);
    return watched;
  });
}
