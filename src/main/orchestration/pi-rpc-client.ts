import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { PiManagerLaunchPlan } from "./pi-runtime";
import {
  captureOwnedProcessTree,
  isOwnedProcessTreeAlive,
  signalOwnedProcessTree,
} from "../owned-process-tree";

export type PiRpcPhase = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";

export interface PiRpcEvent {
  type: string;
  [key: string]: unknown;
}

export interface PiRpcState {
  phase: PiRpcPhase;
  pid: number | null;
  pendingCount: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  failure: { code: string; message: string } | null;
}

export interface PiRpcDiagnostics {
  stderr: string;
  droppedStderrBytes: number;
  listenerErrors: string[];
}

export interface PiRpcClientOptions {
  requestTimeoutMs?: number;
  maxLineBytes?: number;
  maxStderrBytes?: number;
  shutdownGraceMs?: number;
}

export interface PiRpcRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface PendingRequest {
  id: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
  settled: boolean;
}

interface QueuedWrite {
  id: string | null;
  line: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const MAX_TOMBSTONES = 4_096;
const MAX_LISTENER_ERRORS = 100;

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < minimum || actual > maximum) {
    throw new TypeError(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return actual;
}

function ownedJson(value: unknown, label: string, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must contain finite JSON numbers`);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`${label} must be JSON`);
  if (seen.has(value)) throw new TypeError(`${label} must not contain cycles`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string")) throw new TypeError(`${label} must not contain symbol keys`);
      const stringKeys = keys as string[];
      if (stringKeys.some((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key))) {
        throw new TypeError(`${label} arrays must contain only dense indices`);
      }
      if (keys.length - 1 !== value.length) throw new TypeError(`${label} arrays must be dense`);
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) throw new TypeError(`${label} must not contain accessors`);
        result.push(ownedJson(descriptor.value, `${label}[${index}]`, seen));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} objects must be plain`);
    }
    const result: Record<string, unknown> = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError(`${label} must not contain symbol keys`);
      const descriptor = descriptors[key];
      if (!("value" in descriptor)) throw new TypeError(`${label} must not contain accessors`);
      Object.defineProperty(result, key, {
        value: ownedJson(descriptor.value, `${label}.${key}`, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function snapshotRequestOptions(value: unknown): PiRpcRequestOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Pi RPC request options must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Pi RPC request options must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: PiRpcRequestOptions = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (key !== "timeoutMs" && key !== "signal")) {
      throw new TypeError(`Unknown Pi RPC request option: ${typeof key === "string" ? key : "symbol"}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("Pi RPC request options must not contain accessors");
    }
    if (key === "timeoutMs") result.timeoutMs = descriptor.value as number | undefined;
    else result.signal = descriptor.value as AbortSignal | undefined;
  }
  if (result.signal !== undefined) {
    let validSignal = false;
    try { validSignal = result.signal instanceof AbortSignal; } catch {}
    if (!validSignal) throw new TypeError("Pi RPC request signal must be an AbortSignal");
  }
  return result;
}

function completeUtf8Text(value: Buffer): string {
  let start = 0;
  while (start < value.length && (value[start] & 0xc0) === 0x80) start += 1;
  let end = value.length;
  const searchStart = Math.max(start, end - 4);
  for (let index = end - 1; index >= searchStart; index -= 1) {
    const byte = value[index];
    if ((byte & 0xc0) === 0x80) continue;
    const expected = byte < 0x80
      ? 1
      : byte >= 0xc2 && byte <= 0xdf
        ? 2
        : byte >= 0xe0 && byte <= 0xef
          ? 3
          : byte >= 0xf0 && byte <= 0xf4
            ? 4
            : 1;
    if (index + expected > end) end = index;
    break;
  }
  return value.subarray(start, end).toString("utf8");
}

export class PiRpcClient {
  private readonly plan: PiManagerLaunchPlan;
  private readonly requestTimeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly maxStderrBytes: number;
  private readonly shutdownGraceMs: number;
  private phase: PiRpcPhase = "idle";
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private stderrBytes = Buffer.alloc(0);
  private totalStderrBytes = 0;
  private nextRequestId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly tombstones = new Set<string>();
  private readonly tombstoneOrder: string[] = [];
  private readonly listeners = new Set<(event: PiRpcEvent) => void>();
  private readonly listenerErrors: string[] = [];
  private writes: QueuedWrite[] = [];
  private waitingForDrain = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private failure: { code: string; message: string } | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(plan: PiManagerLaunchPlan, options: PiRpcClientOptions = {}) {
    this.plan = {
      ...plan,
      args: [...plan.args],
      env: { ...plan.env },
    };
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      1,
      2_147_483_647,
      "Pi RPC request timeout",
    );
    this.maxLineBytes = boundedInteger(
      options.maxLineBytes,
      DEFAULT_MAX_LINE_BYTES,
      64,
      64 * 1024 * 1024,
      "Pi RPC maximum line bytes",
    );
    this.maxStderrBytes = boundedInteger(
      options.maxStderrBytes,
      DEFAULT_MAX_STDERR_BYTES,
      0,
      4 * 1024 * 1024,
      "Pi RPC maximum stderr bytes",
    );
    this.shutdownGraceMs = boundedInteger(
      options.shutdownGraceMs,
      DEFAULT_SHUTDOWN_GRACE_MS,
      0,
      60_000,
      "Pi RPC shutdown grace",
    );
  }

  state(): PiRpcState {
    return {
      phase: this.phase,
      pid: this.child?.pid ?? null,
      pendingCount: this.pending.size,
      exitCode: this.exitCode,
      signal: this.exitSignal,
      failure: this.failure ? { ...this.failure } : null,
    };
  }

  diagnostics(): PiRpcDiagnostics {
    return {
      stderr: completeUtf8Text(this.stderrBytes),
      droppedStderrBytes: this.totalStderrBytes - this.stderrBytes.length,
      listenerErrors: [...this.listenerErrors],
    };
  }

  onEvent(listener: (event: PiRpcEvent) => void): () => void {
    if (typeof listener !== "function") throw new TypeError("Pi RPC event listener must be a function");
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  async start(): Promise<Record<string, unknown>> {
    if (this.phase !== "idle") throw new Error("Pi RPC client can only be started once");
    this.phase = "starting";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.plan.command, this.plan.args, {
        cwd: this.plan.cwd,
        env: this.plan.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.fail("PROCESS_ERROR", `Pi RPC failed to spawn: ${detail}`);
      throw codedError("PROCESS_ERROR", this.failure?.message ?? detail);
    }
    this.child = child;
    this.attachChild(child);
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        this.phase = "running";
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    }).catch((error: Error) => {
      this.fail("PROCESS_ERROR", `Pi RPC failed to spawn: ${error.message}`);
      throw codedError("PROCESS_ERROR", this.failure?.message ?? error.message);
    });
    try {
      const state = await this.request<Record<string, unknown>>({ type: "get_state" });
      if (!asRecord(state)) {
        this.fail("STARTUP_ERROR", "Pi RPC startup handshake returned invalid state");
        throw codedError("STARTUP_ERROR", "Pi RPC startup handshake returned invalid state");
      }
      return state;
    } catch (error) {
      if (this.isRunning()) {
        const detail = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: unknown })?.code === "TIMEOUT" ? "STARTUP_TIMEOUT" : "STARTUP_ERROR";
        this.fail(code, `Pi RPC startup handshake failed: ${detail}`);
      }
      throw error;
    }
  }

  request<T = unknown>(
    commandValue: Record<string, unknown>,
    options: PiRpcRequestOptions = {},
  ): Promise<T> {
    if (this.phase !== "running") return Promise.reject(codedError("NOT_RUNNING", "Pi RPC client is not running"));
    let command: Record<string, unknown>;
    let requestOptions: PiRpcRequestOptions;
    let timeoutMs: number;
    try {
      command = ownedJson(commandValue, "Pi RPC command") as Record<string, unknown>;
      if (typeof command.type !== "string" || command.type.length === 0) {
        throw new TypeError("Pi RPC command.type must be a non-empty string");
      }
      if (Object.hasOwn(command, "id")) throw new TypeError("Pi RPC command.id is reserved");
      requestOptions = snapshotRequestOptions(options);
      timeoutMs = boundedInteger(requestOptions.timeoutMs, this.requestTimeoutMs, 1, 2_147_483_647, "Pi RPC timeout");
    } catch (error) {
      return Promise.reject(error);
    }
    if (requestOptions.signal?.aborted) return Promise.reject(codedError("ABORTED", "Pi RPC request was aborted"));
    const id = `codara-${++this.nextRequestId}`;
    const line = `${JSON.stringify({ ...command, id })}\n`;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        id,
        resolve: (value) => resolve(value as T),
        reject,
        timer: setTimeout(
          () => this.settleRequest(id, codedError("TIMEOUT", `Pi RPC request ${id} timed out`), undefined, true),
          timeoutMs,
        ),
        signal: requestOptions.signal,
        settled: false,
      };
      if (requestOptions.signal) {
        pending.abortListener = () => this.settleRequest(
          id,
          codedError("ABORTED", `Pi RPC request ${id} was aborted`),
          undefined,
          true,
        );
        requestOptions.signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.pending.set(id, pending);
      if (requestOptions.signal?.aborted) {
        this.settleRequest(id, codedError("ABORTED", `Pi RPC request ${id} was aborted`), undefined, true);
        return;
      }
      this.writes.push({ id, line });
      this.flushWrites();
    });
  }

  prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<unknown> {
    return this.request({ type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) });
  }

  abort(): Promise<unknown> {
    return this.request({ type: "abort" });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.phase === "idle" || this.phase === "stopped") {
      this.phase = "stopped";
      this.stopPromise = Promise.resolve();
      return this.stopPromise;
    }
    this.phase = "stopping";
    this.rejectPending(codedError("STOPPED", "Pi RPC client stopped"));
    this.writes = [];
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      this.phase = "stopped";
      this.stopPromise = Promise.resolve();
      return this.stopPromise;
    }
    this.stopPromise = new Promise<void>((resolve) => {
      let finished = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const ownedTree = captureOwnedProcessTree(child.pid ?? 0);
      const finish = () => {
        if (finished) return;
        finished = true;
        if (killTimer) clearTimeout(killTimer);
        this.child = null;
        this.phase = "stopped";
        resolve();
      };
      const signalTree = (signal: NodeJS.Signals) => {
        const signaled = signalOwnedProcessTree(ownedTree, signal);
        if (signaled === 0) {
          try { child.kill(signal); } catch {}
        }
      };
      child.once("close", () => {
        // Pi's bash tool starts its own process group. The Pi parent can exit
        // first while that group keeps Chrome, dev servers, or tests alive.
        // Keep the force timer until every identity captured below Pi is gone.
        if (!isOwnedProcessTreeAlive(ownedTree)) finish();
      });
      try { child.stdin.end(); } catch {}
      if (this.shutdownGraceMs === 0) {
        signalTree("SIGKILL");
        killTimer = setTimeout(finish, 250);
      } else {
        signalTree("SIGTERM");
        killTimer = setTimeout(() => {
          signalTree("SIGKILL");
          setTimeout(finish, 250).unref();
        }, this.shutdownGraceMs);
      }
      killTimer.unref();
    });
    return this.stopPromise;
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
    child.stdout.on("end", () => this.finishStdout());
    child.stderr.on("data", (chunk: Buffer) => this.appendStderr(chunk));
    child.stdin.on("error", (error) => {
      if (this.phase === "running" || this.phase === "starting") {
        this.fail("STDIN_ERROR", `Pi RPC stdin failed: ${error.message}`);
      }
    });
    child.once("error", (error) => {
      if (this.phase === "running" || this.phase === "starting") {
        this.fail("PROCESS_ERROR", `Pi RPC process failed: ${error.message}`);
      }
    });
    child.once("exit", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
    });
    child.once("close", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      if (this.phase === "running" || this.phase === "starting") {
        this.finishStdout();
        this.fail("PROCESS_EXIT", `Pi RPC process exited (${code ?? signal ?? "unknown"})`);
      }
    });
  }

  private consumeStdout(chunk: Buffer): void {
    if (this.phase === "failed" || this.phase === "stopped") return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    for (;;) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      let record = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (record.length > 0 && record[record.length - 1] === 0x0d) record = record.subarray(0, -1);
      if (record.length > this.maxLineBytes) {
        this.fail("PROTOCOL_ERROR", "Pi RPC output exceeded the line limit");
        return;
      }
      this.processRecord(record);
      if (this.hasFailed()) return;
    }
    if (this.stdoutBuffer.length > this.maxLineBytes + 1 ||
        (this.stdoutBuffer.length > this.maxLineBytes && this.stdoutBuffer.at(-1) !== 0x0d)) {
      this.fail("PROTOCOL_ERROR", "Pi RPC output exceeded the line limit");
    }
  }

  private finishStdout(): void {
    if (this.stdoutBuffer.length === 0 || this.phase === "failed" || this.phase === "stopping" || this.phase === "stopped") return;
    let record = this.stdoutBuffer;
    this.stdoutBuffer = Buffer.alloc(0);
    if (record.at(-1) === 0x0d) record = record.subarray(0, -1);
    if (record.length > this.maxLineBytes) {
      this.fail("PROTOCOL_ERROR", "Pi RPC output exceeded the line limit");
      return;
    }
    this.processRecord(record);
  }

  private hasFailed(): boolean {
    return this.phase === "failed";
  }

  private isRunning(): boolean {
    return this.phase === "running";
  }

  private processRecord(record: Buffer): void {
    let text: string;
    let parsed: unknown;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(record);
      if (/^[\x20\t\r]*$/.test(text)) return;
      parsed = JSON.parse(text);
    } catch {
      this.fail("PROTOCOL_ERROR", "Pi RPC emitted invalid UTF-8 or JSON");
      return;
    }
    const message = asRecord(parsed);
    if (!message) {
      this.fail("PROTOCOL_ERROR", "Pi RPC emitted a non-object record");
      return;
    }
    if (message.type === "response") {
      const id = typeof message.id === "string" ? message.id : null;
      if (!id || typeof message.success !== "boolean") {
        this.fail("PROTOCOL_ERROR", "Pi RPC emitted a malformed response");
        return;
      }
      const pending = this.pending.get(id);
      if (!pending) {
        if (this.tombstones.has(id)) return;
        this.fail("PROTOCOL_ERROR", `Pi RPC emitted an unknown response id: ${id}`);
        return;
      }
      if (message.success) {
        const data = Object.hasOwn(message, "data") ? ownedJson(message.data, "Pi RPC response") : null;
        this.settleRequest(id, null, data);
      } else {
        if (typeof message.error !== "string" || message.error.length === 0) {
          this.fail("PROTOCOL_ERROR", "Pi RPC emitted a failed response without an error message");
          return;
        }
        this.settleRequest(id, codedError("REMOTE_ERROR", message.error));
      }
      return;
    }
    if (typeof message.type !== "string" || message.type.length === 0) {
      this.fail("PROTOCOL_ERROR", "Pi RPC emitted an event without a string type");
      return;
    }
    const event = ownedJson(message, "Pi RPC event") as PiRpcEvent;
    for (const listener of [...this.listeners]) {
      try { listener(ownedJson(event, "Pi RPC event") as PiRpcEvent); }
      catch {
        this.listenerErrors.push(`Pi RPC listener threw while handling ${event.type}`);
        if (this.listenerErrors.length > MAX_LISTENER_ERRORS) this.listenerErrors.shift();
      }
    }
  }

  private settleRequest(id: string, error: Error | null, value?: unknown, tombstone = false): void {
    const pending = this.pending.get(id);
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) pending.signal.removeEventListener("abort", pending.abortListener);
    if (error) {
      if (tombstone) this.rememberTombstone(id);
      this.writes = this.writes.filter((write) => write.id !== id);
      pending.reject(error);
    } else {
      pending.resolve(value);
    }
  }

  private rejectPending(error: Error): void {
    for (const id of [...this.pending.keys()]) this.settleRequest(id, error);
  }

  private rememberTombstone(id: string): void {
    if (this.tombstones.has(id)) return;
    this.tombstones.add(id);
    this.tombstoneOrder.push(id);
    while (this.tombstoneOrder.length > MAX_TOMBSTONES) {
      const oldest = this.tombstoneOrder.shift();
      if (oldest) this.tombstones.delete(oldest);
    }
  }

  private flushWrites(): void {
    const child = this.child;
    if (this.phase !== "running" || !child || this.waitingForDrain) return;
    while (this.writes.length > 0) {
      const write = this.writes.shift()!;
      if (write.id && !this.pending.has(write.id)) continue;
      let accepted: boolean;
      try { accepted = child.stdin.write(write.line); }
      catch (error) {
        this.fail("STDIN_ERROR", `Pi RPC write failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (!accepted) {
        this.waitingForDrain = true;
        child.stdin.once("drain", () => {
          this.waitingForDrain = false;
          this.flushWrites();
        });
        return;
      }
    }
  }

  private appendStderr(incoming: Buffer): void {
    if (incoming.length === 0) return;
    this.totalStderrBytes += incoming.length;
    if (this.maxStderrBytes === 0) {
      this.stderrBytes = Buffer.alloc(0);
      return;
    }
    let combined = Buffer.concat([this.stderrBytes, incoming]);
    if (combined.length > this.maxStderrBytes) combined = combined.subarray(combined.length - this.maxStderrBytes);
    while (combined.length > 0 && (combined[0] & 0xc0) === 0x80) combined = combined.subarray(1);
    this.stderrBytes = Buffer.from(combined);
  }

  private fail(code: string, message: string): void {
    if (this.phase === "failed" || this.phase === "stopping" || this.phase === "stopped") return;
    this.phase = "failed";
    this.failure = { code, message };
    this.rejectPending(codedError(code, message));
    this.writes = [];
    const child = this.child;
    if (!child) return;
    const signaled = signalOwnedProcessTree(
      captureOwnedProcessTree(child.pid ?? 0),
      "SIGKILL",
    );
    if (signaled === 0) {
      try { child.kill("SIGKILL"); } catch {}
    }
  }
}
