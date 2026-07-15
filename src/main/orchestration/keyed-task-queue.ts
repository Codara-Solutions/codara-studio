export interface KeyedTaskQueue {
  <T>(key: string, task: () => Promise<T>): Promise<T>;
  wait(key: string): Promise<void>;
}

/** Build a self-pruning FIFO promise chain per key. A failed task keeps its own
 * rejection for the caller but never poisons the next task in that key. */
export function createKeyedTaskQueue(): KeyedTaskQueue {
  const tails = new Map<string, Promise<void>>();

  const run = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const prior = tails.get(key) ?? Promise.resolve();
    const body = prior.catch(() => undefined).then(() => task());
    const tail = body.catch(() => undefined).then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    tails.set(key, tail);
    return body;
  };
  run.wait = (key: string) => tails.get(key) ?? Promise.resolve();
  return run;
}
