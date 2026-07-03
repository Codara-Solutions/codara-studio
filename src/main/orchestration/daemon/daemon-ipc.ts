// Daemon IPC contract — the typed request/response + event-stream wire shape
// for the detached orchestration host.
//
// Modeled on src/main/agent-socket.ts: a loopback (127.0.0.1) HTTP server that
// speaks bearer-token-authenticated JSON over POST. agent-socket.ts exposes a
// JSON-RPC 2.0 surface to sub-agent MCP children; this daemon seam mirrors that
// envelope/error-code/handshake-file shape but with daemon-lifecycle verbs
// (start/attach/streamEvents/stop) instead of the orchestrator.* tool verbs.
//
// SCAFFOLD-ONLY: this module is a *types-only* seam. It defines the contract
// and PURE helpers (parse/validate/error-construct) and nothing else. It MUST
// NOT import run-store, event-log, or pty — keeping it free of the orchestrator
// dependency tree so both the host (daemon-host.ts) and the out-of-process
// client (daemon-client.ts) can depend on it without dragging in cold-startup
// weight. The only imports are pure `type` imports from @shared/types.

import type { SparkEvent, StartAutopilotInput } from "@shared/types";

// ── Handshake / transport constants ─────────────────────────────────────────
// agent-socket.ts persists agent-socket.json under sparkHome() so MCP children
// that don't inherit Codara's pty env can discover the live url + token. The
// daemon host writes its own handshake file in the same spot; daemon-client.ts
// reads it the way out-of-process MCP children read agent-socket.json.
export const DAEMON_HANDSHAKE_FILE = "daemon-host.json";
export const LOOPBACK_HOST = "127.0.0.1";
// JSON-RPC request half is POSTed to RPC_PATH (cf. agent-socket's "/rpc").
export const RPC_PATH = "/rpc";
// The streamed event half (DaemonEventFrame) flows over EVENTS_PATH — separate
// from /rpc because it is a long-lived push channel, not a request/response.
export const EVENTS_PATH = "/events";

// ── Error codes ─────────────────────────────────────────────────────────────
// Mirrored from agent-socket.ts so a client can branch on the same numeric
// space regardless of which loopback server it is talking to. The first five
// are the JSON-RPC 2.0 reserved codes
// (https://www.jsonrpc.org/specification#error_object); NOT_IMPLEMENTED is the
// same custom "spec'd but not wired up yet" code agent-socket.ts uses, distinct
// from METHOD_NOT_FOUND so callers can tell "implementable today" from "typo".
export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_INTERNAL = -32603;
export const ERR_NOT_IMPLEMENTED = -32004;

// ── Methods ─────────────────────────────────────────────────────────────────
// The daemon lifecycle verbs. `daemon.start` boots a headless run (delegating
// to startAutopilot in the host), `daemon.attach` re-binds a caller to an
// existing run, `daemon.streamEvents` opens the SparkEvent push channel for a
// run, and `daemon.stop` requests teardown.
export type DaemonMethod =
  | "daemon.start"
  | "daemon.attach"
  | "daemon.streamEvents"
  | "daemon.stop";

const DAEMON_METHODS: ReadonlySet<DaemonMethod> = new Set<DaemonMethod>([
  "daemon.start",
  "daemon.attach",
  "daemon.streamEvents",
  "daemon.stop",
]);

// ── Per-method params ───────────────────────────────────────────────────────

/**
 * `daemon.start` — boot a fresh headless run. Wraps the existing
 * StartAutopilotInput verbatim (@shared/types) so the host can hand it straight
 * to startAutopilot(); the daemon adds no run-shaping of its own.
 */
export interface DaemonStartParams {
  input: StartAutopilotInput;
}

/** `daemon.attach` — bind to an already-running run by id. */
export interface DaemonAttachParams {
  runId: string;
}

/**
 * `daemon.streamEvents` — open the SparkEvent push channel for a run.
 * `sinceEventId`, when present, asks the host to replay events emitted after
 * that id so a reconnecting client can resume without a gap.
 */
export interface DaemonStreamEventsParams {
  runId: string;
  sinceEventId?: string;
}

/** `daemon.stop` — request teardown of a run; `reason` is for the audit log. */
export interface DaemonStopParams {
  runId: string;
  reason?: string;
}

// ── Per-method results ──────────────────────────────────────────────────────

export interface DaemonStartResult {
  runId: string;
}

export interface DaemonAttachResult {
  runId: string;
  attached: boolean;
}

export interface DaemonStreamEventsResult {
  runId: string;
  // Streaming is established out-of-band over EVENTS_PATH; the RPC result just
  // acknowledges the subscription and echoes the resume cursor the host honored.
  streaming: boolean;
  sinceEventId?: string;
}

export interface DaemonStopResult {
  runId: string;
  stopped: boolean;
}

/** Maps each DaemonMethod to its result payload type. */
export interface DaemonResultMap {
  "daemon.start": DaemonStartResult;
  "daemon.attach": DaemonAttachResult;
  "daemon.streamEvents": DaemonStreamEventsResult;
  "daemon.stop": DaemonStopResult;
}

// ── Request / response envelopes ────────────────────────────────────────────
// Like agent-socket.ts's JsonRpcRequest/Response but the method is the closed
// DaemonMethod union and params are statically tied to it via the discriminated
// union below.

type DaemonId = string | number | null;

interface DaemonRequestBase {
  jsonrpc: "2.0";
  id?: DaemonId;
}

export interface DaemonStartRequest extends DaemonRequestBase {
  method: "daemon.start";
  params: DaemonStartParams;
}

export interface DaemonAttachRequest extends DaemonRequestBase {
  method: "daemon.attach";
  params: DaemonAttachParams;
}

export interface DaemonStreamEventsRequest extends DaemonRequestBase {
  method: "daemon.streamEvents";
  params: DaemonStreamEventsParams;
}

export interface DaemonStopRequest extends DaemonRequestBase {
  method: "daemon.stop";
  params: DaemonStopParams;
}

/** Discriminated union over `method` — narrowing the method narrows params. */
export type DaemonRequest =
  | DaemonStartRequest
  | DaemonAttachRequest
  | DaemonStreamEventsRequest
  | DaemonStopRequest;

/**
 * Result-or-error envelope. Shaped as a flat tagged union on `ok` rather than
 * JSON-RPC's nested {result?}|{error?} so a client can `if (res.ok)` and get
 * `result: T` narrowed directly. The error arm carries the same numeric `code`
 * space as agent-socket.ts plus a human `message`.
 */
export type DaemonResponse<T> =
  | { ok: true; result: T }
  | { ok: false; code: number; message: string };

/** Per-method response alias for call sites that know the method statically. */
export type DaemonResponseFor<M extends DaemonMethod> = DaemonResponse<DaemonResultMap[M]>;

// ── Event-stream frame ──────────────────────────────────────────────────────
/**
 * One framed item on the EVENTS_PATH push channel. Carries a SparkEvent
 * (@shared/types — the same type event-log.ts's subscribeToEvents emits) plus
 * the owning runId so a client multiplexing several runs over one connection
 * can route. `type` discriminates from any future control frames (e.g. a
 * heartbeat) sharing the channel.
 */
export interface DaemonEventFrame {
  type: "event";
  runId: string;
  event: SparkEvent;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────
// No I/O, no module-level side effects — safe to call from anywhere.

/**
 * Type guard for the DaemonMethod union. Lets the host's dispatcher reject an
 * unknown method with ERR_METHOD_NOT_FOUND before touching params.
 */
export function isDaemonMethod(x: unknown): x is DaemonMethod {
  return typeof x === "string" && DAEMON_METHODS.has(x as DaemonMethod);
}

/**
 * Construct the error arm of a DaemonResponse. Mirrors agent-socket.ts's
 * errorResponse() but in this seam's flat {ok:false,...} shape.
 */
export function makeDaemonError(code: number, message: string): DaemonResponse<never> {
  return { ok: false, code, message };
}

/**
 * Parse a raw request body into a well-formed DaemonRequest, or null if it is
 * not valid JSON, not a JSON-RPC 2.0 envelope, or carries an unknown method.
 *
 * This is deliberately conservative — it validates the envelope and method but
 * does NOT deeply validate per-method params (the host applies ERR_INVALID_PARAMS
 * checks at dispatch, exactly as agent-socket.ts does). Returning null lets the
 * caller answer with ERR_PARSE / ERR_INVALID_REQUEST without this pure helper
 * having to pick a code.
 */
export function parseDaemonRequest(raw: string): DaemonRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // Batch requests are intentionally unsupported, matching agent-socket.ts.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  if (obj.jsonrpc !== "2.0") return null;
  if (!isDaemonMethod(obj.method)) return null;
  if (obj.params === undefined || obj.params === null || typeof obj.params !== "object") {
    return null;
  }
  if (
    obj.id !== undefined &&
    obj.id !== null &&
    typeof obj.id !== "string" &&
    typeof obj.id !== "number"
  ) {
    return null;
  }

  // Envelope + method validated; params is trusted to the per-method shape and
  // deep-checked by the host. The cast is safe because `method` has been
  // narrowed to DaemonMethod and the union is keyed solely on `method`.
  return obj as unknown as DaemonRequest;
}
