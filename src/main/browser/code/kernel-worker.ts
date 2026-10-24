// Entry of a browser code kernel thread. The agent's snippets run in QuickJS
// (WebAssembly) here: no fs, network, require, process or host objects, a heap
// limit, a stack limit and an interrupt for synchronous code that never
// yields. The only way out is a browser call, which main checks and runs like
// any codara_preview_* call. Unlike a workflow, the context lives on between
// snippets: that is the session. Main starts this file as one self-contained
// bundle with `eval: true`, so it imports nothing but node builtins, QuickJS
// and the prelude.

import { parentPort } from "node:worker_threads";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";

import { BROWSER_PRELUDE } from "./prelude";
import type { BrowserKernelLimits, KernelToMain, KernelValue, MainToKernel } from "./kernel-protocol";

const port = parentPort;
if (!port) throw new Error("browser code kernel must run in a worker thread");

let runtime: QuickJSRuntime | null = null;
let ctx: QuickJSContext | null = null;
let settleHandle: QuickJSHandle | null = null;
let limits: BrowserKernelLimits;
let busySince = 0;
let busyExceeded = false;
let activeExec: number | null = null;
let logs: string[] = [];
let logChars = 0;
let nextCallId = 1;
const pendingCalls = new Map<number, QuickJSDeferredPromise>();
const queue: MainToKernel[] = [];

function post(message: KernelToMain): void {
  port!.postMessage(message);
}

function busyMessage(): string {
  return `the snippet ran ${Math.round(limits.busyMs / 1000)} seconds without awaiting (a loop without await?) and was interrupted`;
}

function errorText(context: QuickJSContext, handle: QuickJSHandle): string {
  try {
    const dumped = context.dump(handle) as unknown;
    if (dumped && typeof dumped === "object") {
      const record = dumped as { name?: unknown; message?: unknown; stack?: unknown };
      const name = typeof record.name === "string" ? `${record.name}: ` : "";
      const message = typeof record.message === "string" ? record.message : JSON.stringify(dumped);
      const line = typeof record.stack === "string" ? /snippet\.js:(\d+)/.exec(record.stack)?.[1] : undefined;
      return `${name}${message}${line ? ` (line ${line})` : ""}`.slice(0, 2_000);
    }
    return String(dumped).slice(0, 2_000);
  } catch {
    return "the snippet threw an error that could not be read";
  }
}

// The interrupt reaches the guest as a rejected promise that the prelude
// reports as an ordinary InternalError; once it fired, the snippet failed for
// being busy, whatever the guest made of it.
function finish(id: number, result: { ok: boolean; value?: KernelValue; error?: string }): void {
  if (busyExceeded) {
    busyExceeded = false;
    result = { ok: false, error: busyMessage() };
  }
  if (activeExec !== id) return;
  activeExec = null;
  post({ type: "done", id, ...result, logs });
  logs = [];
  logChars = 0;
}

// Runs every queued guest job. A job that throws stops executePendingJobs
// with the rest still queued, so the loop goes on until the queue is empty;
// each pass consumes at least one job.
function drain(): void {
  if (!runtime) return;
  for (;;) {
    busySince = Date.now();
    const result = runtime.executePendingJobs(-1);
    if (result.error) {
      const text = busyExceeded ? busyMessage() : errorText(result.error.context, result.error);
      result.error.dispose();
      if (activeExec !== null) finish(activeExec, { ok: false, error: text });
      busyExceeded = false;
      continue;
    }
    if (busyExceeded && activeExec !== null) finish(activeExec, { ok: false, error: busyMessage() });
    busyExceeded = false;
    return;
  }
}

function resolveWith(deferred: QuickJSDeferredPromise, text: string): void {
  if (!ctx || !deferred.alive) return;
  const value = ctx.newString(text);
  deferred.resolve(value);
  value.dispose();
  deferred.dispose();
}

function installHost(context: QuickJSContext): void {
  const call = context.newFunction("__cbCall", (methodHandle, argsHandle) => {
    const deferred = context.newPromise();
    try {
      const method = context.getString(methodHandle);
      const text = context.getString(argsHandle);
      if (Buffer.byteLength(text, "utf8") > limits.maxCallBytes) {
        throw new RangeError(`the arguments of ${method} are over ${Math.floor(limits.maxCallBytes / 1024)} KB`);
      }
      if (pendingCalls.size >= limits.maxPendingCalls) {
        throw new RangeError(`more than ${limits.maxPendingCalls} browser calls are waiting; await some before starting more`);
      }
      const callId = nextCallId++;
      pendingCalls.set(callId, deferred);
      post({ type: "call", callId, method, args: JSON.parse(text) as Record<string, unknown> });
    } catch (error) {
      resolveWith(deferred, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
    return deferred.handle;
  });
  context.setProp(context.global, "__cbCall", call);
  call.dispose();

  const sleep = context.newFunction("__cbSleep", (msHandle) => {
    const deferred = context.newPromise();
    const ms = Math.min(600_000, Math.max(0, Number(context.getNumber(msHandle)) || 0));
    setTimeout(() => {
      resolveWith(deferred, "");
      drain();
    }, ms);
    return deferred.handle;
  });
  context.setProp(context.global, "__cbSleep", sleep);
  sleep.dispose();

  const log = context.newFunction("__cbLog", (textHandle) => {
    if (activeExec === null || logChars >= limits.maxLogChars) return;
    const text = context.getString(textHandle);
    const room = limits.maxLogChars - logChars;
    const kept = text.length > room ? `${text.slice(0, room)} ... (console output truncated)` : text;
    logs.push(kept);
    logChars += kept.length;
  });
  context.setProp(context.global, "__cbLog", log);
  log.dispose();

  const done = context.newFunction("__cbDone", (idHandle, resultHandle) => {
    const id = context.getNumber(idHandle);
    try {
      const result = JSON.parse(context.getString(resultHandle)) as { ok: boolean; value?: KernelValue; error?: string };
      finish(id, result);
    } catch {
      finish(id, { ok: false, error: "the snippet's result could not be read" });
    }
  });
  context.setProp(context.global, "__cbDone", done);
  done.dispose();
}

async function start(message: Extract<MainToKernel, { type: "start" }>): Promise<void> {
  limits = message.limits;
  const quickjs = await newQuickJSWASMModuleFromVariant(variant);
  runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  runtime.setInterruptHandler(() => {
    if (Date.now() - busySince > limits.busyMs) {
      busyExceeded = true;
      return true;
    }
    return false;
  });
  runtime.setModuleLoader(() => ({ error: new Error("imports are not available in browser code") }));
  ctx = runtime.newContext();
  installHost(ctx);
  const init = ctx.newString(JSON.stringify({ docs: message.docs, maxResultChars: limits.maxResultChars }));
  ctx.setProp(ctx.global, "__cbInit", init);
  init.dispose();
  busySince = Date.now();
  const prelude = ctx.evalCode(BROWSER_PRELUDE, "browser-api.js");
  if (prelude.error) {
    const text = errorText(ctx, prelude.error);
    prelude.error.dispose();
    throw new Error(`the browser API failed to load: ${text}`);
  }
  settleHandle = prelude.value;
  post({ type: "ready" });
}

function exec(message: Extract<MainToKernel, { type: "exec" }>): void {
  if (!ctx || !settleHandle) return;
  activeExec = message.id;
  logs = [];
  logChars = 0;
  busySince = Date.now();
  const evaluated = ctx.evalCode(message.code, "snippet.js");
  if (evaluated.error) {
    const text = busyExceeded ? busyMessage() : errorText(ctx, evaluated.error);
    busyExceeded = false;
    evaluated.error.dispose();
    finish(message.id, { ok: false, error: text });
    return;
  }
  const id = ctx.newNumber(message.id);
  const settled = ctx.callFunction(settleHandle, ctx.undefined, id, evaluated.value);
  id.dispose();
  evaluated.value.dispose();
  if (settled.error) {
    finish(message.id, { ok: false, error: errorText(ctx, settled.error) });
    settled.error.dispose();
  } else {
    settled.value.dispose();
  }
  drain();
}

function reply(message: Extract<MainToKernel, { type: "reply" }>): void {
  const deferred = pendingCalls.get(message.callId);
  if (!deferred) return;
  pendingCalls.delete(message.callId);
  resolveWith(deferred, JSON.stringify(message.ok ? { ok: true, value: message.value ?? null } : { ok: false, error: message.error ?? "browser call failed" }));
  drain();
}

function handle(message: MainToKernel): void {
  try {
    if (message.type === "exec") exec(message);
    else if (message.type === "reply") reply(message);
  } catch (error) {
    // A host-side failure (a WebAssembly stack overflow, a disposed handle)
    // ends the snippet; main decides whether the session survives.
    const text = error instanceof Error ? error.message : String(error);
    if (activeExec !== null) finish(activeExec, { ok: false, error: `the browser code kernel failed: ${text}` });
  }
}

port.on("message", (message: MainToKernel) => {
  if (message.type === "start") {
    void start(message)
      .then(() => {
        for (const queued of queue.splice(0)) handle(queued);
      })
      .catch((error: unknown) => post({ type: "fatal", error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  if (!ctx) queue.push(message);
  else handle(message);
});
