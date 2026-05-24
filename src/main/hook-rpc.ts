// Hook RPC — a tiny HTTP server that sub-agents (Claude Code, Codex, Cursor,
// etc.) can POST to in order to self-report their state ("working / blocked /
// idle / done"). This is the authoritative state source per the big-bet:
// regex-tail detection (big bet A) is the FALLBACK for CLIs that can't or
// don't speak this protocol.
//
// Wire format:
//   POST 127.0.0.1:<port>/state
//   Authorization: Bearer <token>
//   Content-Type: application/json
//   { "paneId": "<attemptId>", "state": "working|blocked|idle|done", "note?": "..." }
//
// The server is bound to 127.0.0.1 ONLY (never externally reachable), and a
// per-process random token is required on every request. The token + URL are
// surfaced to the worker via env vars set on its PTY (see pty-manager.ts):
//   SPARK_HOOK_URL   = http://127.0.0.1:<port>
//   SPARK_HOOK_TOKEN = <32 hex chars>
//   SPARK_PANE_ID    = <attemptId> (PTY session id == attemptId)
//
// No new dependencies, no Express, no body-parser — just node:http and manual
// JSON validation, because the surface area is intentionally tiny.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { WorkerRuntimeState } from "@shared/types";

// Cap on body bytes we'll buffer before rejecting. The legitimate payload is
// ~120 bytes; anything past 4 KiB is either a misuse or a probe.
const MAX_BODY_BYTES = 4 * 1024;
// Reasonable per-request socket timeout so a stalled writer can't hold a
// connection forever.
const REQUEST_TIMEOUT_MS = 10_000;

const VALID_STATES: ReadonlySet<WorkerRuntimeState> = new Set([
  "working",
  "blocked",
  "idle",
  "done",
]);

interface HookRpcState {
  server: Server;
  port: number;
  token: string;
  // Callback resolved by startHookRpc — wired to run-store.applyHookStateReport
  // so the server doesn't need to know about run-store at compile time
  // (avoids a circular import: run-store imports pty-manager which doesn't
  // need to know about run-store back).
  apply: (report: HookStateReport) => void;
}

export interface HookStateReport {
  paneId: string;
  state: WorkerRuntimeState;
  note?: string;
}

let active: HookRpcState | null = null;

// Public env shape that pty-manager interpolates into a worker's environment.
// Caller fills paneId because the same RPC endpoint is shared across all
// workers and the env block is per-PTY.
export interface HookRpcEnv {
  SPARK_HOOK_URL: string;
  SPARK_HOOK_TOKEN: string;
  SPARK_PANE_ID: string;
}

export interface StartHookRpcOptions {
  // Receives every validated hook report. Wired to run-store from index.ts.
  // Synchronous because the server's only side-effect is updating in-memory
  // worker state + queuing an event — both fast.
  onStateReport: (report: HookStateReport) => void;
}

// Start the server. Returns once it's bound to a port. Idempotent: a second
// call with the server already running is a no-op (returns the existing
// state's port). The non-zero port number is logged by the caller.
export async function startHookRpc(opts: StartHookRpcOptions): Promise<{ port: number; token: string }> {
  if (active) {
    return { port: active.port, token: active.token };
  }

  const token = randomBytes(24).toString("hex");
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      // Last-ditch — handleRequest should always send a response itself, but
      // belt-and-braces so we never leak a hung socket.
      try {
        if (!res.headersSent) {
          sendJson(res, 500, { error: "internal_error" });
        } else {
          res.end();
        }
      } catch {
        /* socket already gone */
      }
      console.warn("[hook-rpc] request handler threw:", err);
    });
  });

  server.on("clientError", (_err, socket) => {
    // Bad HTTP framing from a confused client. Don't crash, just close.
    try {
      socket.destroy();
    } catch {
      /* socket already gone */
    }
  });

  // 127.0.0.1 ONLY — never bind 0.0.0.0. The token is the only credential and
  // we don't want it brute-forceable from the LAN.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: unknown) => {
      server.off("listening", onListening);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const addr = server.address();
  const port = isAddressInfo(addr) ? addr.port : 0;
  if (port <= 0) {
    server.close();
    throw new Error("[hook-rpc] failed to bind a port");
  }

  active = {
    server,
    port,
    token,
    apply: opts.onStateReport,
  };

  return { port, token };
}

export async function stopHookRpc(): Promise<void> {
  if (!active) return;
  const current = active;
  active = null;
  await new Promise<void>((resolve) => {
    current.server.close(() => resolve());
    // Force-close any still-attached sockets so a slow client can't keep us
    // alive past app quit.
    current.server.closeAllConnections?.();
  });
}

// Returns the env block to layer onto a worker pty. Throws if startHookRpc
// hasn't been called yet — calling pty-manager.spawn before the RPC is up is
// a startup-ordering bug and we want to surface it loudly.
export function getHookRpcEnv(paneId: string): HookRpcEnv {
  if (!active) {
    throw new Error("[hook-rpc] getHookRpcEnv called before startHookRpc");
  }
  return {
    SPARK_HOOK_URL: `http://127.0.0.1:${active.port}`,
    SPARK_HOOK_TOKEN: active.token,
    SPARK_PANE_ID: paneId,
  };
}

// Soft variant used by callers that may spawn ptys before the RPC has had a
// chance to start (e.g. headless eval boot). Returns null when the server
// isn't up yet so the caller can spawn without hook env injection instead of
// crashing.
export function getHookRpcEnvSafe(paneId: string): HookRpcEnv | null {
  if (!active) return null;
  return {
    SPARK_HOOK_URL: `http://127.0.0.1:${active.port}`,
    SPARK_HOOK_TOKEN: active.token,
    SPARK_PANE_ID: paneId,
  };
}

// Test/diagnostic helper. Returns the bound port + token so renderer dev tools
// (or a future "what's my hook url" IPC) can show them.
export function getHookRpcInfo(): { port: number; token: string } | null {
  if (!active) return null;
  return { port: active.port, token: active.token };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Drop any request that takes too long; node-http otherwise keeps a stalled
  // socket open until the OS kills it.
  req.setTimeout(REQUEST_TIMEOUT_MS, () => {
    try {
      sendJson(res, 408, { error: "request_timeout" });
    } catch {
      /* already responded */
    }
    req.destroy();
  });

  if (!active) {
    // Server is being shut down mid-flight.
    sendJson(res, 503, { error: "server_unavailable" });
    return;
  }

  const method = (req.method ?? "GET").toUpperCase();
  const url = req.url ?? "/";

  // Health/probe endpoint. No auth — purely "is the server alive" with no
  // state info disclosed. Useful for dev tooling.
  if (method === "GET" && url === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method !== "POST" || url !== "/state") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  // Bearer token check. Reject hard with 401 on any mismatch.
  const auth = req.headers["authorization"] ?? req.headers["Authorization"];
  const authValue = Array.isArray(auth) ? auth[0] : auth;
  if (typeof authValue !== "string" || !authValue.startsWith("Bearer ")) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  const provided = authValue.slice("Bearer ".length).trim();
  if (!timingSafeStringEquals(provided, active.token)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  // Read body up to the cap. Anything larger is a hostile/buggy client.
  let body: string;
  try {
    body = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    if ((err as Error).message === "body_too_large") {
      sendJson(res, 413, { error: "body_too_large" });
    } else {
      sendJson(res, 400, { error: "body_read_failed" });
    }
    return;
  }

  let parsed: unknown;
  try {
    parsed = body.length === 0 ? null : JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }

  const report = validateStateReport(parsed);
  if (!report.ok) {
    sendJson(res, 400, { error: report.reason });
    return;
  }

  try {
    active.apply(report.value);
  } catch (err) {
    // The apply callback should never throw under normal operation, but if a
    // future run-store bug surfaces here we want a real diagnostic instead of
    // returning 200.
    console.warn("[hook-rpc] apply callback threw:", err);
    sendJson(res, 500, { error: "apply_failed" });
    return;
  }

  sendJson(res, 200, { ok: true });
}

function validateStateReport(
  raw: unknown,
): { ok: true; value: HookStateReport } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, reason: "body_not_object" };
  }
  const obj = raw as Record<string, unknown>;
  const paneId = obj.paneId;
  const state = obj.state;
  const note = obj.note;

  if (typeof paneId !== "string" || paneId.length === 0 || paneId.length > 256) {
    return { ok: false, reason: "invalid_paneId" };
  }
  if (typeof state !== "string" || !VALID_STATES.has(state as WorkerRuntimeState)) {
    return { ok: false, reason: "invalid_state" };
  }
  let safeNote: string | undefined;
  if (note !== undefined) {
    if (typeof note !== "string") {
      return { ok: false, reason: "invalid_note" };
    }
    // Cap note length so a misbehaving worker can't fill memory by posting
    // megabyte-sized stack traces. 2 KiB is generous for a state explanation.
    safeNote = note.slice(0, 2048);
  }

  return {
    ok: true,
    value: {
      paneId,
      state: state as WorkerRuntimeState,
      ...(safeNote !== undefined ? { note: safeNote } : {}),
    },
  };
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        // Pause and reject — node-http will discard the rest of the body.
        req.pause();
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(Buffer.concat(chunks).toString("utf8"));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* socket already gone */
    }
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload).toString(),
    // No keepalive — workers post one state at a time, no benefit from
    // pooling, and it makes shutdown cleaner.
    Connection: "close",
    // Defense-in-depth: this endpoint is bound to loopback only, but make it
    // explicit that nothing should treat it as a public resource.
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

// Constant-time string comparison. The Bearer token is a 48-char hex string,
// well under the 1KiB cap timingSafeEqual is happy with; we still implement
// our own here so a length-mismatch doesn't leak through Buffer.from.
function timingSafeStringEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAddressInfo(addr: string | AddressInfo | null): addr is AddressInfo {
  return typeof addr === "object" && addr !== null && typeof (addr as AddressInfo).port === "number";
}
