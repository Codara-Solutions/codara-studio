import type { RepoPullRequests } from "./inspect";

// A repository's pull requests as the cleanup judges them: cached for a
// while, and one GitHub read per repository at a time, kept until it
// settles. The fold checks its rows all at once and they share that read;
// each caller keeps its own timeout and its own fallback. A failed or late
// read answers with the last known lists, so a removal judges merges by the
// facts its confirm step showed; a caller that asked for fresh lists gets no
// such fallback, joins no read begun before it, and a read begun before it
// that answers late does not write the cache.
export function pullRequestReader(options: {
  fetch: (root: string) => Promise<RepoPullRequests>;
  ttlMs: number;
  timeoutMs: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; value: RepoPullRequests }>();
  const reads = new Map<string, { generation: number; read: Promise<RepoPullRequests> }>();
  // Bumped by each fresh call: a read begun before it is not what the fresh
  // call asked for, so it neither answers it nor writes the cache.
  const generations = new Map<string, number>();
  const generation = (root: string) => generations.get(root) ?? 0;
  const shared = (root: string, from: number) => {
    const running = reads.get(root);
    if (running && running.generation >= from) return running.read;
    const started = generation(root);
    const entry = {
      generation: started,
      read: options
        .fetch(root)
        .then((value) => {
          if (generation(root) === started) cache.set(root, { at: now(), value });
          return value;
        })
        .finally(() => {
          if (reads.get(root) === entry) reads.delete(root);
        }),
    };
    // A caller that timed out no longer listens; the failure is its own to report.
    entry.read.catch(() => undefined);
    reads.set(root, entry);
    return entry.read;
  };
  // `fresh`: past the cache, and no fallback to it. Others keep both.
  const get = async (root: string, fresh = false): Promise<RepoPullRequests> => {
    const cached = fresh ? undefined : cache.get(root);
    if (cached && now() - cached.at < options.ttlMs) return cached.value;
    let from = 0;
    if (fresh) {
      from = generation(root) + 1;
      generations.set(root, from);
    }
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        shared(root, from),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("GitHub did not answer in time")), options.timeoutMs);
        }),
      ]);
    } catch (err) {
      // Fresh lists were asked for and could not be had: the old ones go, so
      // the asker's next plain read (the agent tool's branch-deletion check)
      // reads again instead of judging by them. Callers already waiting keep
      // the fallback they came with.
      if (fresh) cache.delete(root);
      if (cached) return cached.value;
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return { get };
}
