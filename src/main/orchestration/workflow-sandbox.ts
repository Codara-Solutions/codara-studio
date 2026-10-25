// Main-side handle of one workflow sandbox thread. A crash, a heap blow-up or
// a terminate() ends only that thread, never main's event loop.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

import {
  DEFAULT_SANDBOX_LIMITS,
  type MainToSandbox,
  type SandboxAgentCall,
  type SandboxChildScript,
  type SandboxLimits,
  type SandboxToMain,
} from "./workflow-sandbox-protocol";

export interface WorkflowSandboxHandlers {
  onCall(id: number, ctx: string, call: SandboxAgentCall): void;
  onNote(ctx: string, op: "log" | "phase", value: string): void;
  onChild(name: string): void;
  onIdle(): void;
  onDone(result: { ok: boolean; value?: unknown; error?: string }): void;
}

export interface WorkflowSandboxOptions {
  body: string;
  args: unknown;
  children?: Record<string, SandboxChildScript>;
  budget?: { total: number | null; totalUsd: number | null };
  limits?: Partial<SandboxLimits>;
  handlers: WorkflowSandboxHandlers;
}

export interface WorkflowSandbox {
  reply(id: number, reply: { ok: boolean; value?: unknown; error?: string; usage?: { tokens: number; usd: number } }): void;
  terminate(): Promise<void>;
  readonly done: boolean;
}

// The thread's whole V8 heap, including the WebAssembly memory QuickJS
// allocates its 64 MB guest heap from.
const THREAD_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 };

let workerCodeOverride: string | null = null;
let cachedWorkerCode: string | null = null;

/** Test seam: the bundled sandbox worker source to run instead of the build's. */
export function setWorkflowSandboxWorkerCode(code: string | null): void {
  workerCodeOverride = code;
}

// The worker runs from source text (`eval: true`), so loading it never
// depends on the thread resolving a path inside the packaged app's asar. The
// build writes it to out/main; this module may itself land in out/main/chunks.
function sandboxWorkerCode(): string {
  if (workerCodeOverride) return workerCodeOverride;
  if (cachedWorkerCode) return cachedWorkerCode;
  const candidates = [__dirname, dirname(__dirname)].map((dir) => join(dir, "workflow-sandbox-worker.js"));
  for (const candidate of candidates) {
    try {
      cachedWorkerCode = readFileSync(candidate, "utf8");
      return cachedWorkerCode;
    } catch {
      // Not here; try the parent of a chunk directory.
    }
  }
  throw new Error(`the workflow sandbox is missing from this build (looked in ${candidates.join(", ")})`);
}

export function startWorkflowSandbox(options: WorkflowSandboxOptions): WorkflowSandbox {
  const limits: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, ...options.limits };
  const worker = new Worker(sandboxWorkerCode(), {
    eval: true,
    resourceLimits: THREAD_RESOURCE_LIMITS,
    env: {},
  });
  let done = false;
  const settle = (result: { ok: boolean; value?: unknown; error?: string }) => {
    if (done) return;
    done = true;
    try {
      options.handlers.onDone(result);
    } finally {
      void worker.terminate().catch(() => undefined);
    }
  };
  worker.on("message", (message: SandboxToMain) => {
    if (done) return;
    switch (message.type) {
      case "call":
        options.handlers.onCall(message.id, message.ctx, message.call);
        return;
      case "note":
        options.handlers.onNote(message.ctx, message.op, message.value);
        return;
      case "child":
        options.handlers.onChild(message.name);
        return;
      case "idle":
        options.handlers.onIdle();
        return;
      case "done":
        settle({ ok: message.ok, value: message.value, error: message.error });
        return;
      default:
        return;
    }
  });
  worker.on("error", (err) => {
    const text = err instanceof Error ? err.message : String(err);
    settle({
      ok: false,
      error: /heap|memory/i.test(text)
        ? `the workflow script ran out of memory (${text})`
        : `the workflow sandbox stopped: ${text}`,
    });
  });
  worker.on("exit", (code) => {
    settle({ ok: false, error: `the workflow sandbox exited unexpectedly (code ${code})` });
  });
  const start: MainToSandbox = {
    type: "start",
    body: options.body,
    args: options.args === undefined ? null : options.args,
    children: options.children ?? {},
    budget: options.budget ?? { total: null, totalUsd: null },
    limits,
  };
  worker.postMessage(start);
  return {
    reply(id, reply) {
      if (done) return;
      const message: MainToSandbox = { type: "reply", id, ...reply };
      worker.postMessage(message);
    },
    async terminate() {
      done = true;
      await worker.terminate().catch(() => undefined);
    },
    get done() {
      return done;
    },
  };
}
