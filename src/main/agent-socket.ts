import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as pty from "./pty-manager";
import { sparkHome } from "./spark-home";
import { writeFileAtomic } from "./fs-atomic";
import { requestPreviewOp, type PreviewOpName, type PreviewOpParams } from "./preview-bridge";

const HANDSHAKE_FILE = "agent-socket.json";

// JSON-RPC server hosted by main, exposed to sub-agents via SPARK_AGENT_SOCKET +
// SPARK_AGENT_TOKEN env vars. Sub-agents POST {jsonrpc:"2.0",method,params,id}
// to /rpc with Authorization: Bearer <token> and get the matching response back.
//
// The server only binds 127.0.0.1 and uses a constant-time token comparison so a
// hostile process on the local machine still cannot trivially shape Spark's
// workspace without knowing the per-launch secret.

// JSON-RPC 2.0 error codes per https://www.jsonrpc.org/specification#error_object.
const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;
// Custom code reserved for "verb exists in the spec but not wired up yet" —
// distinct from ERR_METHOD_NOT_FOUND so clients can branch on
// "implementable today" vs "typo in method name".
const ERR_NOT_IMPLEMENTED = -32004;

const MAX_REQUEST_BYTES = 64 * 1024;
const TERMINAL_READ_MAX_BYTES = 32 * 1024;
const TERMINAL_READ_DEFAULT_LINES = 200;
const TERMINAL_READ_MAX_LINES = 2000;
// Cap on chat.append message length. Big enough for a verifier verdict
// summary or a multi-paragraph status update, small enough that a buggy
// sub-agent can't DoS the run-store by sending a megabyte at a time.
const CHAT_APPEND_MAX_CHARS = 16_000;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

// Late-binding handle on run-store so the agent-socket module doesn't pull
// the orchestrator dependency tree into cold startup. The same lazy-load
// trick ipc.ts uses for git-ops / inline-ai.
let runStoreMod: typeof import("./orchestration/run-store") | undefined;
async function getRunStore(): Promise<typeof import("./orchestration/run-store")> {
  runStoreMod ??= await import("./orchestration/run-store");
  return runStoreMod;
}

interface ServerHandle {
  server: Server;
  url: string;
  token: string;
}

let currentHandle: ServerHandle | null = null;

/**
 * Start the JSON-RPC server. Binds 127.0.0.1 on a random ephemeral port and
 * mints a fresh per-process token. Idempotent — repeated calls return the
 * existing handle.
 */
export async function startAgentSocket(): Promise<ServerHandle> {
  if (currentHandle) return currentHandle;

  const token = randomBytes(32).toString("hex");
  const server = createServer((req, res) => {
    handleRequest(req, res, token).catch((err) => {
      // handleRequest only rejects on unexpected errors — log so we can see
      // them and respond with a generic 500 so the client doesn't hang.
      console.error("[agent-socket] unhandled handler error", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      try {
        res.end(JSON.stringify({ error: "internal error" }));
      } catch {
        /* socket may already be torn down */
      }
    });
  });

  // Stop the server from leaking handles when sockets idle.
  server.on("connection", (socket) => {
    socket.setKeepAlive(false);
    socket.setTimeout(30_000, () => {
      socket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("error", onError);
      reject(err);
    };
    server.on("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("[agent-socket] failed to determine listening address");
  }
  const url = `http://127.0.0.1:${address.port}`;
  currentHandle = { server, url, token };
  pty.setAgentSocketEnv({ url, token });
  // Persist a handshake file so MCP servers spawned by external runtimes
  // (Claude Code, Codex) — which do not inherit Spark's pty env — can pick
  // up the current URL + token. Best-effort: a failed write only means the
  // spark-preview MCP server has to back off and retry.
  void writeHandshakeFile({ url, token }).catch((err) =>
    console.warn("[agent-socket] failed to write handshake file:", err),
  );
  return currentHandle;
}

/** Stop the server. Safe to call multiple times. */
export async function stopAgentSocket(): Promise<void> {
  const handle = currentHandle;
  if (!handle) return;
  currentHandle = null;
  pty.setAgentSocketEnv(null);
  // Remove the handshake file so any MCP server child that survived Spark's
  // shutdown returns "Spark offline" on next call instead of speaking to a
  // closed port.
  await fsp.rm(handshakeFilePath(), { force: true }).catch(() => undefined);
  await new Promise<void>((resolve) => {
    handle.server.close(() => resolve());
    // close() waits for all open connections — force the issue so quit
    // doesn't hang behind a long-poll from a stuck sub-agent.
    handle.server.closeAllConnections?.();
  });
}

function handshakeFilePath(): string {
  return join(sparkHome(), HANDSHAKE_FILE);
}

async function writeHandshakeFile(input: { url: string; token: string }): Promise<void> {
  const payload = JSON.stringify({
    url: input.url,
    token: input.token,
    pid: process.pid,
    writtenAt: new Date().toISOString(),
  }, null, 2);
  await writeFileAtomic(handshakeFilePath(), payload);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, expectedToken: string): Promise<void> {
  // Method/path gate before any work — we only speak POST /rpc.
  if (req.method !== "POST" || req.url !== "/rpc") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  if (!verifyAuthHeader(req, expectedToken)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const body = await readBody(req);
  if (body === null) {
    writeJsonRpc(res, errorResponse(null, ERR_INVALID_REQUEST, "request body too large or unreadable"));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    writeJsonRpc(res, errorResponse(null, ERR_PARSE, "invalid JSON"));
    return;
  }

  // Batch requests are part of JSON-RPC 2.0 but we don't need them for the
  // initial set of verbs — keep the surface small until a real caller asks.
  if (Array.isArray(parsed)) {
    writeJsonRpc(res, errorResponse(null, ERR_INVALID_REQUEST, "batch requests are not supported"));
    return;
  }

  const reqObj = parsed as Partial<JsonRpcRequest> | null;
  const id: JsonRpcId =
    reqObj && (typeof reqObj.id === "string" || typeof reqObj.id === "number")
      ? reqObj.id
      : null;

  if (!reqObj || reqObj.jsonrpc !== "2.0" || typeof reqObj.method !== "string") {
    writeJsonRpc(res, errorResponse(id, ERR_INVALID_REQUEST, "invalid JSON-RPC envelope"));
    return;
  }

  const response = await dispatch(reqObj.method, reqObj.params, id);
  writeJsonRpc(res, response);
}

function verifyAuthHeader(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return false;
  const presented = match[1].trim();
  const expectedBuf = Buffer.from(expectedToken, "utf8");
  const presentedBuf = Buffer.from(presented, "utf8");
  if (presentedBuf.length !== expectedBuf.length) return false;
  try {
    return timingSafeEqual(presentedBuf, expectedBuf);
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let total = 0;
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > MAX_REQUEST_BYTES) {
        finish(null);
        try {
          req.destroy();
        } catch {
          /* best-effort */
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(Buffer.concat(chunks, total).toString("utf8")));
    req.on("error", () => finish(null));
  });
}

async function dispatch(
  method: string,
  rawParams: unknown,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const params = rawParams && typeof rawParams === "object" ? (rawParams as Record<string, unknown>) : {};

  try {
    switch (method) {
      case "terminal.read":
        return await handleTerminalRead(params, id);
      case "chat.append":
        return await handleChatAppend(params, id);
      case "preview.list":
      case "preview.navigate":
      case "preview.url":
      case "preview.snapshot":
      case "preview.evaluate":
      case "preview.click":
      case "preview.type":
      case "preview.press_key":
      case "preview.wait_for":
      case "preview.screenshot":
        return await handlePreviewOp(method, params, id);
      case "tab.create":
      case "pane.split":
        // The renderer owns tab/pane state and reaching it from main requires
        // a request/response IPC roundtrip plus active-workspace selection
        // semantics we haven't designed yet. Returning a structured error so
        // a sub-agent's harness can branch cleanly on "verb spec'd but not
        // yet implemented" without crashing.
        return errorResponse(id, ERR_NOT_IMPLEMENTED, `${method} is not implemented yet`);
      default:
        return errorResponse(id, ERR_METHOD_NOT_FOUND, `unknown method: ${method}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(id, ERR_INTERNAL, message);
  }
}

async function handleTerminalRead(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const paneId = stringParam(params, "paneId");
  if (!paneId) return errorResponse(id, ERR_INVALID_PARAMS, "paneId is required");

  const requestedLines = optionalNumberParam(params, "lines");
  const lines =
    requestedLines === null
      ? TERMINAL_READ_DEFAULT_LINES
      : Math.max(1, Math.min(requestedLines | 0, TERMINAL_READ_MAX_LINES));

  const tail = pty.readTail(paneId, TERMINAL_READ_MAX_BYTES);
  if (tail === null) {
    return errorResponse(id, ERR_INVALID_PARAMS, `unknown pane: ${paneId}`);
  }

  // Decode raw bytes as UTF-8 (lossy on partial code points at the head —
  // acceptable for a tail read), then strip ANSI/VT control sequences so a
  // grader sub-agent gets clean text instead of escape codes.
  const text = stripVTControlCharacters(tail.toString("utf8"));
  const allLines = text.split(/\r\n|\r|\n/);
  // Drop a trailing empty line that comes from a final newline so callers
  // don't get a phantom blank row when n=lines.
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
  const slice = allLines.slice(-lines);
  const output = slice.join("\n");

  return successResponse(id, {
    paneId,
    lines: slice.length,
    truncatedBytes: tail.length >= TERMINAL_READ_MAX_BYTES,
    text: output,
  });
}

async function handlePreviewOp(
  method: string,
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const op = method.replace(/^preview\./, "") as PreviewOpName;
  const previewParams: PreviewOpParams = { ...params };
  try {
    const result = await requestPreviewOp(op, previewParams);
    return successResponse(id, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(id, ERR_INTERNAL, message);
  }
}

async function handleChatAppend(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const runId = stringParam(params, "runId");
  if (!runId) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  const rawContent = stringParam(params, "content");
  if (!rawContent) return errorResponse(id, ERR_INVALID_PARAMS, "content is required");

  const content = rawContent.length > CHAT_APPEND_MAX_CHARS
    ? rawContent.slice(0, CHAT_APPEND_MAX_CHARS)
    : rawContent;

  // chat.append posts on behalf of the sub-agent itself, not the user — record
  // it as a system note so the manager's replanning logic doesn't treat it as
  // a fresh user follow-up that should re-engage the autopilot loop.
  const runStore = await getRunStore();
  try {
    const run = await runStore.addRunMessage({
      runId,
      author: "system",
      kind: "note",
      message: content,
    });
    return successResponse(id, {
      runId: run.id,
      truncated: rawContent.length > content.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // requireRun throws "Run not found: <id>"; surface as invalid-params so
    // the caller can tell user-error apart from server-error.
    if (/run not found/i.test(message)) {
      return errorResponse(id, ERR_INVALID_PARAMS, message);
    }
    return errorResponse(id, ERR_INTERNAL, message);
  }
}

function successResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function stringParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalNumberParam(params: Record<string, unknown>, key: string): number | null {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function writeJsonRpc(res: ServerResponse, payload: JsonRpcResponse): void {
  const body = JSON.stringify(payload);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body, "utf8"),
  });
  res.end(body);
}
