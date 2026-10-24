// Messages between main and a browser code kernel thread (kernel-worker.ts).
// Everything crossing is plain JSON: the guest never holds a host object.

export interface BrowserKernelLimits {
  /** QuickJS heap for the session's bindings and values. */
  memoryBytes: number;
  stackBytes: number;
  /** Synchronous guest code that runs this long without awaiting is interrupted. */
  busyMs: number;
  /** One browser call's arguments, as JSON. */
  maxCallBytes: number;
  /** Browser calls waiting for an answer at once. */
  maxPendingCalls: number;
  /** The snippet's result, as text. */
  maxResultChars: number;
  /** console output kept per snippet. */
  maxLogChars: number;
}

export const DEFAULT_KERNEL_LIMITS: BrowserKernelLimits = {
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  busyMs: 5_000,
  maxCallBytes: 256 * 1024,
  maxPendingCalls: 64,
  maxResultChars: 60_000,
  maxLogChars: 20_000,
};

export type MainToKernel =
  | { type: "start"; limits: BrowserKernelLimits; docs: string }
  | { type: "exec"; id: number; code: string }
  | { type: "reply"; callId: number; ok: boolean; value?: unknown; error?: string };

/** A snippet's value: text for a string, JSON text for anything else, nothing for undefined. */
export interface KernelValue {
  text?: string;
  json?: string;
  truncated?: boolean;
}

export type KernelToMain =
  | { type: "ready" }
  | { type: "call"; callId: number; method: string; args: Record<string, unknown> }
  | { type: "done"; id: number; ok: boolean; value?: KernelValue; error?: string; logs: string[] }
  | { type: "fatal"; error: string };
