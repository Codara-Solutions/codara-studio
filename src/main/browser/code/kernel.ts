// Main-side handle of one browser code kernel thread (kernel-worker.ts): one
// agent session's QuickJS context. A crash, a heap blow-up or a terminate()
// ends only that thread, never main's event loop.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

import { BROWSER_CODE_DOCS } from "./docs";
import {
  DEFAULT_KERNEL_LIMITS,
  type BrowserKernelLimits,
  type KernelToMain,
  type KernelValue,
  type MainToKernel,
} from "./kernel-protocol";

export interface KernelRunResult {
  ok: boolean;
  value?: KernelValue;
  error?: string;
  logs: string[];
}

export interface BrowserKernel {
  /** Run one transformed snippet; resolves when it settles or timeoutMs passes. */
  run(code: string, timeoutMs: number): Promise<KernelRunResult>;
  reply(callId: number, reply: { ok: boolean; value?: unknown; error?: string }): void;
  /** The snippet main is waiting for, or null; a call carrying another snippet's id is stale. */
  readonly activeId: number | null;
  terminate(): Promise<void>;
  readonly dead: boolean;
  /** Whether a snippet is running; browser calls are only answered then. */
  readonly busy: boolean;
}

export interface BrowserKernelHandlers {
  /** A browser call from the guest; answer it with reply(). */
  onCall(callId: number, execId: number, method: string, args: Record<string, unknown>): void;
  /** The thread ended on its own (crash, heap limit). */
  onExit(reason: string): void;
}

// The thread's whole V8 heap, including the WebAssembly memory QuickJS
// allocates the guest heap from.
const THREAD_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 };

let workerCodeOverride: string | null = null;
let cachedWorkerCode: string | null = null;

/** Test seam: the bundled kernel worker source to run instead of the build's. */
export function setBrowserKernelWorkerCode(code: string | null): void {
  workerCodeOverride = code;
}

// The worker runs from source text (`eval: true`), so loading it never
// depends on the thread resolving a path inside the packaged app's asar. The
// build writes it to out/main; this module may itself land in out/main/chunks.
function kernelWorkerCode(): string {
  if (workerCodeOverride) return workerCodeOverride;
  if (cachedWorkerCode) return cachedWorkerCode;
  const candidates = [__dirname, dirname(__dirname)].map((dir) => join(dir, "browser-code-worker.js"));
  for (const candidate of candidates) {
    try {
      cachedWorkerCode = readFileSync(candidate, "utf8");
      return cachedWorkerCode;
    } catch {
      // Not here; try the parent of a chunk directory.
    }
  }
  throw new Error(`the browser code kernel is missing from this build (looked in ${candidates.join(", ")})`);
}

export function startBrowserKernel(handlers: BrowserKernelHandlers, limits: Partial<BrowserKernelLimits> = {}): BrowserKernel {
  const worker = new Worker(kernelWorkerCode(), {
    eval: true,
    resourceLimits: THREAD_RESOURCE_LIMITS,
    env: {},
  });
  let dead = false;
  let nextId = 1;
  let active: { id: number; resolve: (result: KernelRunResult) => void; timer: NodeJS.Timeout } | null = null;

  const settle = (id: number, result: KernelRunResult) => {
    if (!active || active.id !== id) return;
    clearTimeout(active.timer);
    const { resolve } = active;
    active = null;
    resolve(result);
  };
  const die = (reason: string) => {
    if (dead) return;
    dead = true;
    if (active) settle(active.id, { ok: false, error: `${reason}. The session was reset, so earlier bindings are gone.`, logs: [] });
    handlers.onExit(reason);
  };

  worker.on("message", (message: KernelToMain) => {
    switch (message.type) {
      case "call":
        handlers.onCall(message.callId, message.execId, message.method, message.args);
        return;
      case "done":
        settle(message.id, { ok: message.ok, value: message.value, error: message.error, logs: message.logs ?? [] });
        return;
      case "fatal":
        die(`the browser code kernel failed to start: ${message.error}`);
        void worker.terminate().catch(() => undefined);
        return;
      default:
        return;
    }
  });
  worker.on("error", (err) => {
    const text = err instanceof Error ? err.message : String(err);
    die(/heap|memory/i.test(text) ? `the snippet ran out of memory (${text})` : `the browser code kernel stopped: ${text}`);
  });
  worker.on("exit", (code) => die(`the browser code kernel exited (code ${code})`));

  const start: MainToKernel = { type: "start", limits: { ...DEFAULT_KERNEL_LIMITS, ...limits }, docs: BROWSER_CODE_DOCS };
  worker.postMessage(start);

  return {
    run(code, timeoutMs) {
      if (dead) return Promise.resolve({ ok: false, error: "the browser code session has ended", logs: [] });
      if (active) return Promise.resolve({ ok: false, error: "another snippet is still running in this session", logs: [] });
      const id = nextId++;
      return new Promise<KernelRunResult>((resolve) => {
        // The kernel drops what the snippet was awaiting, so it never resumes,
        // and main refuses the calls it had already sent; the session and its
        // bindings survive a timeout.
        const timer = setTimeout(() => {
          settle(id, {
            ok: false,
            error: `the snippet did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped. Bindings are kept.`,
            logs: [],
          });
          if (!dead) worker.postMessage({ type: "cancel", id } satisfies MainToKernel);
        }, timeoutMs);
        active = { id, resolve, timer };
        const message: MainToKernel = { type: "exec", id, code };
        worker.postMessage(message);
      });
    },
    reply(callId, reply) {
      if (dead) return;
      const message: MainToKernel = { type: "reply", callId, ...reply };
      worker.postMessage(message);
    },
    async terminate() {
      dead = true;
      if (active) settle(active.id, { ok: false, error: "the browser code session was closed", logs: [] });
      await worker.terminate().catch(() => undefined);
    },
    get dead() {
      return dead;
    },
    get busy() {
      return active !== null;
    },
    get activeId() {
      return active ? active.id : null;
    },
  };
}
