export interface RunRuntimeWorker {
  runId: string;
  attemptId: string;
  kill: () => void;
}

export interface RunRuntimeShutdownDependencies {
  activeWorkers: () => Iterable<RunRuntimeWorker>;
  activeRunIds: () => Iterable<string>;
  persistedRunIds: () => Promise<Iterable<string>>;
  disposeManagerSessions: (runId: string) => Promise<void>;
  killPty: (attemptId: string) => void;
  releaseWorker: (attemptId: string) => void;
}

const DEFAULT_SHUTDOWN_WAIT_MS = 1_500;
const MAX_SHUTDOWN_WAIT_MS = 2_000;

/**
 * Build the process-lifetime quit drain. The returned function is single-flight:
 * repeated quit signals share the first drain and never stop the same runtime
 * twice.
 */
export function createRunRuntimeShutdown(
  dependencies: RunRuntimeShutdownDependencies,
): (maxWaitMs?: number) => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return (maxWaitMs = DEFAULT_SHUTDOWN_WAIT_MS): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    const waitMs = Math.min(
      MAX_SHUTDOWN_WAIT_MS,
      Math.max(1, Number.isFinite(maxWaitMs) ? maxWaitMs : DEFAULT_SHUTDOWN_WAIT_MS),
    );
    const runIds = new Set<string>();
    const disposeStarted = new Set<string>();

    try {
      for (const runId of dependencies.activeRunIds()) {
        if (runId) runIds.add(runId);
      }
    } catch {
      // A broken active-id source must not prevent worker or provider teardown.
    }

    let workers: RunRuntimeWorker[] = [];
    try {
      // Snapshot before sending any kill signal: process-exit callbacks can
      // mutate the live worker map while this synchronous loop is running.
      workers = [...dependencies.activeWorkers()];
    } catch {
      // A broken worker source must not prevent provider teardown.
    }
    for (const worker of workers) {
      if (worker.runId) runIds.add(worker.runId);
      try {
        worker.kill();
      } catch {
        // Continue through the remaining workers and their backing PTYs.
      }
      try {
        dependencies.killPty(worker.attemptId);
      } catch {
        // The process may already have exited.
      }
      try {
        dependencies.releaseWorker(worker.attemptId);
      } catch {
        // Releasing one handle must not block the rest of the drain.
      }
    }

    const disposeRun = (runId: string): Promise<void> => {
      if (!runId || disposeStarted.has(runId)) return Promise.resolve();
      disposeStarted.add(runId);
      try {
        return Promise.resolve(dependencies.disposeManagerSessions(runId)).catch(
          () => undefined,
        );
      } catch {
        return Promise.resolve();
      }
    };

    // Start known active sessions immediately. Persisted IDs are enumerated in
    // parallel so dormant non-PTY provider sessions are included as well.
    const activeDisposals = Promise.all([...runIds].map(disposeRun));
    const persistedDisposals = Promise.resolve()
      .then(() => dependencies.persistedRunIds())
      .then(async (persistedIds) => {
        const pending: Promise<void>[] = [];
        for (const runId of persistedIds) pending.push(disposeRun(runId));
        await Promise.all(pending);
      })
      .catch(() => undefined);
    const drain = Promise.all([activeDisposals, persistedDisposals]).then(
      () => undefined,
      () => undefined,
    );

    shutdownPromise = new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      timer.unref?.();
      void drain.then(finish, finish);
    });

    return shutdownPromise;
  };
}
