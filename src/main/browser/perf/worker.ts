// Trace and heap snapshot files can be hundreds of megabytes. Reading them in
// the main process would stall every window and could exhaust its heap, so
// the analysis runs in a worker thread with its own heap limit: running out
// of memory there ends the worker, not Codara.

import { Worker } from "node:worker_threads";

export interface WorkerRunOptions {
  timeoutMs: number;
  maxOldGenerationSizeMb?: number;
}

/**
 * Run a function in a worker thread. The function is stringified, so it may
 * use only its argument, node built-ins through require() and globals.
 */
export function runInWorker<I, O>(fn: (input: I) => O | Promise<O>, input: I, options: WorkerRunOptions): Promise<O> {
  const code = `
    const { parentPort, workerData } = require("node:worker_threads");
    Promise.resolve()
      .then(() => (${fn.toString()})(workerData))
      .then(
        (value) => parentPort.postMessage({ ok: true, value }),
        (error) => parentPort.postMessage({ ok: false, message: String((error && error.message) || error) }),
      );
  `;
  return new Promise<O>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(code, {
      eval: true,
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: options.maxOldGenerationSizeMb ?? 1024 },
      env: {},
    });
    const finish = (error: Error | null, value?: O) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(value as O);
    };
    const timer = setTimeout(() => finish(new Error(`analysis took longer than ${Math.round(options.timeoutMs / 1000)} s`)), options.timeoutMs);
    worker.on("message", (message: { ok: boolean; value?: O; message?: string }) => {
      if (message.ok) finish(null, message.value);
      else finish(new Error(message.message ?? "analysis failed"));
    });
    worker.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(code === "ERR_WORKER_OUT_OF_MEMORY" ? new Error("the file is too large to analyze") : error);
    });
    worker.on("exit", (exitCode) => finish(new Error(`analysis stopped (exit ${exitCode})`)));
  });
}
