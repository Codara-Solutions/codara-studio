// Entry of the workflow sandbox thread. The workflow script runs in QuickJS
// (WebAssembly) here: no fs, network, require, timers, process or host
// objects, a heap limit, a stack limit and an interrupt for synchronous code
// that never yields. Main starts this file as one self-contained bundle with
// `eval: true`, so it must import nothing but node builtins, QuickJS and the
// prelude.

import { parentPort } from "node:worker_threads";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";

import { WORKFLOW_PRELUDE, WORKFLOW_SCRIPT_FILENAME, wrapWorkflowBody } from "./workflow-prelude";
import type {
  MainToSandbox,
  SandboxChildScript,
  SandboxLimits,
  SandboxToMain,
} from "./workflow-sandbox-protocol";

const port = parentPort;
if (!port) throw new Error("workflow-sandbox-worker must run in a worker thread");

interface GuestContext {
  name: string;
  ctx: QuickJSContext;
  onFinish: (text: string) => void;
}

let runtime: QuickJSRuntime | null = null;
let limits: SandboxLimits;
let children: Record<string, SandboxChildScript> = {};
let budgetTotals = { total: null as number | null, totalUsd: null as number | null };
const spent = { tokens: 0, usd: 0 };
let busySince = 0;
let busyExceeded = false;
let finished = false;
let nextCallId = 1;
const pendingCalls = new Map<number, { guest: GuestContext; deferred: QuickJSDeferredPromise }>();
const pendingChildStarts: Array<() => void> = [];
const contexts: GuestContext[] = [];

function post(message: SandboxToMain): void {
  port!.postMessage(message);
}

// The interrupt surfaces in the guest as a rejected promise, which the
// script's own async wrapper would otherwise report as an ordinary error or
// even swallow. Once it fired, the run failed for being busy, whatever the
// guest did with it.
function finish(message: Extract<SandboxToMain, { type: "done" }>): void {
  if (finished) return;
  finished = true;
  post(busyExceeded ? { type: "done", ok: false, error: busyMessage() } : message);
}

function errorFromHandle(ctx: QuickJSContext, handle: QuickJSHandle): string {
  try {
    const dumped = ctx.dump(handle) as unknown;
    if (dumped && typeof dumped === "object") {
      const record = dumped as { name?: unknown; message?: unknown; stack?: unknown };
      const name = typeof record.name === "string" && record.name !== "Error" ? `${record.name}: ` : "";
      const message = typeof record.message === "string" ? record.message : JSON.stringify(dumped);
      const line = typeof record.stack === "string" ? /workflow\.js:(\d+)/.exec(record.stack)?.[1] : undefined;
      return `${name}${message}${line ? ` (line ${line})` : ""}`.slice(0, 2_000);
    }
    return String(dumped).slice(0, 2_000);
  } catch {
    return "the workflow script threw an error that could not be read";
  }
}

function busyMessage(): string {
  return `script busy too long: it ran ${Math.round(limits.busyMs / 1000)} seconds without awaiting (a loop without await?)`;
}

function enterGuest(): void {
  busySince = Date.now();
}

// Runs every queued guest job, then any child workflow whose start was
// requested while those jobs ran, until both are empty. Everything happens in
// this one synchronous turn, so the order of guest effects never depends on
// when a message from main happens to arrive.
function drain(): void {
  if (!runtime || finished) return;
  for (;;) {
    enterGuest();
    const result = runtime.executePendingJobs(-1);
    if (result.error) {
      const text = busyExceeded ? busyMessage() : errorFromHandle(result.error.context, result.error);
      result.error.dispose();
      finish({ type: "done", ok: false, error: text });
      return;
    }
    if (busyExceeded) {
      finish({ type: "done", ok: false, error: busyMessage() });
      return;
    }
    const start = pendingChildStarts.shift();
    if (!start) return;
    start();
    if (finished) return;
  }
}

function evalOrThrow(ctx: QuickJSContext, code: string, filename: string): void {
  enterGuest();
  const result = ctx.evalCode(code, filename);
  if (result.error) {
    const text = busyExceeded ? busyMessage() : errorFromHandle(ctx, result.error);
    result.error.dispose();
    throw new Error(text);
  }
  result.value.dispose();
}

function createGuest(options: {
  name: string;
  depth: number;
  phasePrefix: string | null;
  defaultPhase: string | null;
  args: unknown;
  body: string;
  onFinish: (text: string) => void;
}): GuestContext {
  if (!runtime) throw new Error("sandbox runtime is not ready");
  const ctx = runtime.newContext();
  const guest: GuestContext = { name: options.name, ctx, onFinish: options.onFinish };
  contexts.push(guest);

  const hostCall = ctx.newFunction("__wfHost", (opHandle, payloadHandle) => {
    const deferred = ctx.newPromise();
    try {
      const op = ctx.getString(opHandle);
      const payload = JSON.parse(ctx.getString(payloadHandle)) as {
        prompt: string;
        opts: Record<string, unknown>;
        phase: string | null;
      };
      if (op !== "agent") throw new Error(`unknown host operation ${op}`);
      const id = nextCallId;
      nextCallId += 1;
      pendingCalls.set(id, { guest, deferred });
      post({ type: "call", id, ctx: guest.name, op: "agent", call: payload });
    } catch (err) {
      const reply = ctx.newString(
        JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
      // Resolving disposes the resolvers; the promise handle itself belongs
      // to QuickJS once it is returned, so it must stay alive until then.
      deferred.resolve(reply);
      reply.dispose();
    }
    return deferred.handle;
  });
  ctx.setProp(ctx.global, "__wfHost", hostCall);
  hostCall.dispose();

  const hostNote = ctx.newFunction("__wfNote", (opHandle, valueHandle) => {
    const op = ctx.getString(opHandle);
    if (op !== "log" && op !== "phase") return;
    let value = "";
    try {
      value = String(JSON.parse(ctx.getString(valueHandle)));
    } catch {
      value = "";
    }
    post({ type: "note", ctx: guest.name, op, value: value.slice(0, 4_000) });
  });
  ctx.setProp(ctx.global, "__wfNote", hostNote);
  hostNote.dispose();

  const hostBudget = ctx.newFunction("__wfBudget", () => ctx.newString(JSON.stringify(spent)));
  ctx.setProp(ctx.global, "__wfBudget", hostBudget);
  hostBudget.dispose();

  const hostFinish = ctx.newFunction("__wfFinish", (textHandle) => {
    const text = ctx.getString(textHandle);
    guest.onFinish(text);
  });
  ctx.setProp(ctx.global, "__wfFinish", hostFinish);
  hostFinish.dispose();

  const hostChild = ctx.newFunction("__wfChild", (nameHandle, argsHandle) => {
    const deferred = ctx.newPromise();
    const resolveWith = (text: string) => {
      if (!deferred.alive) return;
      const value = ctx.newString(text);
      deferred.resolve(value);
      value.dispose();
    };
    try {
      const name = ctx.getString(nameHandle);
      const childArgs = JSON.parse(ctx.getString(argsHandle)) as unknown;
      const script = Object.prototype.hasOwnProperty.call(children, name) ? children[name] : undefined;
      if (!script) {
        resolveWith(JSON.stringify({ ok: false, error: `workflow(): no saved workflow named "${name}"` }));
      } else {
        post({ type: "child", name });
        pendingChildStarts.push(() => {
          try {
            const child = createGuest({
              name: script.name,
              depth: options.depth + 1,
              phasePrefix: `> ${script.name}`,
              defaultPhase: `> ${script.name}`,
              args: childArgs,
              body: script.body,
              onFinish: (text) => resolveWith(text),
            });
            evalOrThrow(child.ctx, "globalThis.__wfStart()", "start.js");
          } catch (err) {
            resolveWith(JSON.stringify({ ok: false, error: `workflow("${name}"): ${err instanceof Error ? err.message : String(err)}` }));
          }
        });
      }
    } catch (err) {
      resolveWith(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
    return deferred.handle;
  });
  ctx.setProp(ctx.global, "__wfChild", hostChild);
  hostChild.dispose();

  const initJson = JSON.stringify({
    maxItems: limits.maxItems,
    defaultPhase: options.defaultPhase,
    phasePrefix: options.phasePrefix,
    depth: options.depth,
    budget: budgetTotals,
    args: options.args === undefined ? null : options.args,
  });
  const init = ctx.newString(initJson);
  ctx.setProp(ctx.global, "__wfInit", init);
  init.dispose();

  evalOrThrow(ctx, WORKFLOW_PRELUDE, "prelude.js");
  evalOrThrow(ctx, wrapWorkflowBody(options.body), WORKFLOW_SCRIPT_FILENAME);
  return guest;
}

async function start(message: Extract<MainToSandbox, { type: "start" }>): Promise<void> {
  limits = message.limits;
  children = message.children ?? {};
  budgetTotals = message.budget;
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
  // A module loader that refuses everything makes import() reject instead of
  // reaching any host file.
  runtime.setModuleLoader(() => ({ error: new Error("imports are not available in workflows") }));
  post({ type: "ready" });
  try {
    const root = createGuest({
      name: "",
      depth: 0,
      phasePrefix: null,
      defaultPhase: null,
      args: message.args,
      body: message.body,
      onFinish: (text) => {
        let parsed: { ok: boolean; value?: unknown; error?: string };
        try {
          parsed = JSON.parse(text) as typeof parsed;
        } catch {
          parsed = { ok: false, error: "the workflow's return value is not plain JSON" };
        }
        finish({ type: "done", ok: parsed.ok === true, value: parsed.value, error: parsed.error });
      },
    });
    evalOrThrow(root.ctx, "globalThis.__wfStart()", "start.js");
  } catch (err) {
    finish({ type: "done", ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  drain();
  if (!finished) post({ type: "idle" });
}

function reply(message: Extract<MainToSandbox, { type: "reply" }>): void {
  const pending = pendingCalls.get(message.id);
  if (!pending || finished) return;
  pendingCalls.delete(message.id);
  if (message.usage) {
    spent.tokens += Math.max(0, message.usage.tokens || 0);
    spent.usd += Math.max(0, message.usage.usd || 0);
  }
  const { ctx } = pending.guest;
  if (pending.deferred.alive) {
    const text = message.ok
      ? JSON.stringify({ ok: true, value: message.value === undefined ? null : message.value })
      : JSON.stringify({ ok: false, error: message.error ?? "agent call failed" });
    const handle = ctx.newString(text);
    pending.deferred.resolve(handle);
    handle.dispose();
    pending.deferred.dispose();
  }
  drain();
  if (!finished) post({ type: "idle" });
}

port.on("message", (message: MainToSandbox) => {
  try {
    if (message.type === "start") {
      void start(message).catch((err: unknown) => {
        finish({ type: "done", ok: false, error: err instanceof Error ? err.message : String(err) });
      });
    } else if (message.type === "reply") {
      reply(message);
    }
  } catch (err) {
    // A host-side failure (a WebAssembly stack overflow, a disposed handle)
    // ends this script only; main sees an ordinary failed run.
    finish({ type: "done", ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
