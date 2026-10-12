// Messages between main and the workflow sandbox thread. Types only: the
// sandbox worker bundle must not pull in anything main also loads.

export interface SandboxChildScript {
  name: string;
  body: string;
}

export interface SandboxLimits {
  memoryBytes: number;
  stackBytes: number;
  /** Continuous synchronous execution allowed between host calls. */
  busyMs: number;
  maxItems: number;
}

export type MainToSandbox =
  | {
      type: "start";
      body: string;
      args: unknown;
      children: Record<string, SandboxChildScript>;
      budget: { total: number | null; totalUsd: number | null };
      limits: SandboxLimits;
    }
  | {
      type: "reply";
      id: number;
      ok: boolean;
      value?: unknown;
      error?: string;
      /** Usage of the delivered result; budget.spent() advances by it. */
      usage?: { tokens: number; usd: number };
    };

export interface SandboxAgentCall {
  prompt: string;
  opts: Record<string, unknown>;
  phase: string | null;
}

export type SandboxToMain =
  | { type: "ready" }
  | { type: "call"; id: number; ctx: string; op: "agent"; call: SandboxAgentCall }
  | { type: "note"; ctx: string; op: "log" | "phase"; value: string }
  | { type: "child"; name: string }
  | { type: "idle" }
  | { type: "done"; ok: boolean; value?: unknown; error?: string };

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 256 * 1024,
  busyMs: 5_000,
  maxItems: 4096,
};
