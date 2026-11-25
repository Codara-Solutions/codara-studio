import type { RepoPullRequests } from "./inspect";

// A repository's pull requests as the cleanup judges them: cached for a
// while, and one GitHub read per repository at a time, kept until it
// settles. The fold checks its rows all at once and they share that read;
// each caller keeps its own timeout and its own fallback. A failed or late
// read answers with the last known lists, so a removal judges merges by the
// facts its confirm step showed; a caller that asked for fresh lists gets no
// such fallback.
export function pullRequestReader(options: {
  fetch: (root: string) => Promise<RepoPullRequests>;
  ttlMs: number;
  timeoutMs: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; value: RepoPullRequests }>();
  const reads = new Map<string, Promise<RepoPullRequests>>();
  const shared = (root: string) => {
    let read = reads.get(root);
    if (!read) {
      read = options
        .fetch(root)
        .then((value) => {
          cache.set(root, { at: now(), value });
          return value;
        })
        .finally(() => reads.delete(root));
      // A caller that timed out no longer listens; the failure is its own to report.
      read.catch(() => undefined);
      reads.set(root, read);
    }
    return read;
  };
  // `fresh`: past the cache, and no fallback to it. Others keep both.
  const get = async (root: string, fresh = false): Promise<RepoPullRequests> => {
    const cached = fresh ? undefined : cache.get(root);
    if (cached && now() - cached.at < options.ttlMs) return cached.value;
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        shared(root),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("GitHub did not answer in time")), options.timeoutMs);
        }),
      ]);
    } catch (err) {
      if (cached) return cached.value;
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return { get };
}
