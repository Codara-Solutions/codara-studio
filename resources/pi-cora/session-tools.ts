// How Cora's manager calls the agent-session tools (codara_session_start and
// codara_session_wait). Pure apart from the injected bridge call, so
// scripts/test-pi-cora-session-tools.cjs can load it outside Pi.
//
// Waiting: the manager's wait loops in code over short Studio waits until a
// session settles or the caller's own timeout passes, so one wait costs one
// model turn, not one per call. Between chunks it ends early when a session
// needs the user or failed (in "all" mode Studio would keep waiting on the
// others) and when the user queued a message, which Pi delivers only after
// the tool returns. The total stays under Pi's long-poll trust window
// (PI_LONG_POLL_TRUST_MS in src/main/orchestration/agent-liveness.ts).

export const SESSION_WAIT_CHUNK_SECONDS = 30;
export const SESSION_WAIT_MANAGER_DEFAULT_SECONDS = 300;
export const SESSION_WAIT_MANAGER_MAX_SECONDS = 1200;

/** What a session runs on when the manager names nothing: Opus at high
 *  effort for Claude Code, the CLI's own model at high effort for Codex. */
export const SESSION_DEFAULTS: Record<"claude" | "codex", { model?: string; effort: string }> = {
  claude: { model: "opus", effort: "high" },
  codex: { effort: "high" },
};

export interface BridgeResultLike {
  content?: Array<Record<string, unknown>>;
  details?: unknown;
  isError?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** codara_session_start arguments with model and effort always set. A blank
 *  model is dropped (Studio refuses one) or replaced by the default. */
export function withSessionDefaults(params: unknown): unknown {
  if (!isRecord(params)) return params;
  const runtime = params.runtime === "codex" ? "codex" : params.runtime === "claude" ? "claude" : null;
  if (!runtime) return params;
  const defaults = SESSION_DEFAULTS[runtime];
  const next: Record<string, unknown> = { ...params };
  const model = typeof params.model === "string" ? params.model.trim() : "";
  if (model) next.model = model;
  else if (defaults.model) next.model = defaults.model;
  else delete next.model;
  const effort = typeof params.effort === "string" ? params.effort.trim() : "";
  if (!effort) next.effort = defaults.effort;
  return next;
}

/** The manager's codara_session_wait schema: its own default and maximum. */
export function managerSessionWaitSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties?.timeoutSeconds) return schema;
  return {
    ...schema,
    properties: {
      ...properties,
      timeoutSeconds: {
        ...properties.timeoutSeconds,
        description: `Default ${SESSION_WAIT_MANAGER_DEFAULT_SECONDS}, max ${SESSION_WAIT_MANAGER_MAX_SECONDS}.`,
      },
    },
  };
}

/** Statuses in a session.wait result. */
function sessionStatuses(result: BridgeResultLike): string[] {
  const text = (result.content ?? []).find((block) => block.type === "text" && typeof block.text === "string");
  if (!text) return [];
  try {
    const parsed = JSON.parse(text.text as string) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) return [];
    return parsed.sessions.map((session) => (isRecord(session) && typeof session.status === "string" ? session.status : ""));
  } catch {
    return [];
  }
}

/** Studio marks a chunk's answer when the user queued a message meanwhile. */
export function userMessageQueued(result: BridgeResultLike): boolean {
  const text = (result.content ?? []).find((block) => block.type === "text" && typeof block.text === "string");
  if (!text) return false;
  try {
    const parsed = JSON.parse(text.text as string) as unknown;
    return isRecord(parsed) && parsed.userMessageQueued === true;
  } catch {
    return false;
  }
}

/** The reason field of a session.wait result, or null when unreadable. */
export function sessionWaitReason(result: BridgeResultLike): string | null {
  const text = (result.content ?? []).find((block) => block.type === "text" && typeof block.text === "string");
  if (!text) return null;
  try {
    const parsed = JSON.parse(text.text as string) as unknown;
    return isRecord(parsed) && typeof parsed.reason === "string" ? parsed.reason : null;
  } catch {
    return null;
  }
}

function requestedWaitSeconds(params: Record<string, unknown>): number {
  const value = params.timeoutSeconds;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return SESSION_WAIT_MANAGER_DEFAULT_SECONDS;
  }
  return Math.min(value, SESSION_WAIT_MANAGER_MAX_SECONDS);
}

/**
 * Wait on sessions in short Studio waits until one answer is not a timeout,
 * a session needs the user or failed, the user queued a message, the total
 * passes, or the turn is aborted. Returns the last answer, so a timeout still
 * reads `reason: "timeout"`; an early end for a queued message says so.
 */
export async function waitForSessionsInChunks(
  call: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<BridgeResultLike>,
  params: unknown,
  options: {
    signal?: AbortSignal;
    now?: () => number;
    onChunk?: (elapsedSeconds: number) => void;
    hasPendingMessages?: () => boolean;
  } = {},
): Promise<BridgeResultLike> {
  const args = isRecord(params) ? params : {};
  const now = options.now ?? Date.now;
  const total = requestedWaitSeconds(args);
  const startedAt = now();
  for (;;) {
    const elapsed = (now() - startedAt) / 1000;
    const remaining = Math.max(0, Math.ceil(total - elapsed));
    const result = await call(
      { ...args, timeoutSeconds: Math.min(remaining, SESSION_WAIT_CHUNK_SECONDS) },
      options.signal,
    );
    if (result.isError === true || sessionWaitReason(result) !== "timeout") return result;
    if (sessionStatuses(result).some((status) => status === "needs_you" || status === "failed")) return result;
    if (options.signal?.aborted) return result;
    if (userMessageQueued(result) || options.hasPendingMessages?.()) {
      return {
        ...result,
        content: [
          ...(result.content ?? []),
          { type: "text", text: "Stopped waiting early: the user sent a message. The sessions keep running." },
        ],
      };
    }
    const after = (now() - startedAt) / 1000;
    if (after >= total - 1) return result;
    options.onChunk?.(Math.round(after));
  }
}

export const MANAGER_SESSION_WAIT_DESCRIPTION =
  "Wait until sessions finish, fail or need the user; returns their status and final messages, " +
  `or reason timeout while they keep running. Waits in code for up to ${SESSION_WAIT_MANAGER_MAX_SECONDS} s ` +
  `(default ${SESSION_WAIT_MANAGER_DEFAULT_SECONDS}), so call it once with a long timeoutSeconds instead of polling.`;
