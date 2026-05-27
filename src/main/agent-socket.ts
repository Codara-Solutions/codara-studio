import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as pty from "./pty-manager";
import { sparkHome } from "./spark-home";
import { writeFileAtomic } from "./fs-atomic";
import { requestPreviewOp, type PreviewOpName, type PreviewOpParams } from "./preview-bridge";
import type { RunState } from "@shared/types";

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
      case "orchestrator.spawn_workers":
        return await handleOrchestratorSpawnWorkers(params, id);
      case "orchestrator.ask_user":
        return await handleOrchestratorAskUser(params, id);
      case "orchestrator.complete":
        return await handleOrchestratorComplete(params, id);
      case "orchestrator.get_worker_status":
        return await handleOrchestratorGetWorkerStatus(params, id);
      case "orchestrator.wait_for_workers":
        return await handleOrchestratorWaitForWorkers(params, id);
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

// ── orchestrator.* — Execute-mode tools called by Claude/Codex via the
// spark-orchestrator MCP server. The CLI is acting as Spark's manager; these
// tools let it spawn Spark workers, ask the user a clarifying question, and
// mark the run complete. Each call carries `runId` (the MCP server forwards
// `process.env.SPARK_RUN_ID` that pty-manager injected at spawn time).
//
// v0 implementation queues workers via createWorkerTask + prepareWorkerTask
// and relies on the existing autopilot loop (or the next plan_analysis tick)
// to pick them up. Full end-to-end launch from this call site is a Phase 2
// concern — at that point we'll add an explicit launchWorkerAttempt + result
// wait so the LLM can `await` worker completion synchronously.

const ASK_USER_POLL_MS = 500;
const ASK_USER_TIMEOUT_MS = 15 * 60 * 1000; // 15 min — covers the user being AFK
const ORCHESTRATOR_RUNTIME_FALLBACK = "claude" as const;

interface OrchestratorWorkerInput {
  title: string;
  description: string;
  runtimePreference?: "claude" | "codex" | "shell" | "manual";
  modelHint?: string;
  effortHint?: "minimal" | "low" | "medium" | "high" | "xhigh";
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  expectedOutputs?: string[];
  verificationCommands?: string[];
  taskClass?: "skeleton" | "feature" | "leaf" | "verifier";
}

async function handleOrchestratorSpawnWorkers(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const runId = stringParam(params, "runId");
  if (!runId) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  const rawWorkers = params.workers;
  if (!Array.isArray(rawWorkers) || rawWorkers.length === 0) {
    return errorResponse(id, ERR_INVALID_PARAMS, "workers array is required and non-empty");
  }
  const runStore = await getRunStore();
  const run = await runStore.getRun(runId);
  if (!run) {
    return errorResponse(id, ERR_INVALID_PARAMS, `Run not found: ${runId}`);
  }
  const cwd = typeof run.settingsSnapshot?.workspaceCwd === "string"
    ? run.settingsSnapshot.workspaceCwd
    : process.cwd();

  // Execute-mode workers don't belong to a planned step; the manager
  // spawns them ad-hoc. RunGraph.tsx renders FROM run.steps, so without a
  // step entry the graph falls through to OutcomeGraph's "No steps run"
  // card and the worker is invisible — observed in run-mpodz3i7-fs8o7f
  // even though the worker actually ran and edited files. Create one
  // synthetic worker_batch step per spawn_workers RPC call so the graph
  // can render the worker rows via the existing agentRowsForStep path.
  const workerTitles = rawWorkers
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
    .map((r) => (typeof r.title === "string" ? r.title.trim() : ""))
    .filter((t) => t.length > 0);
  const stepTitle = workerTitles.length === 1
    ? workerTitles[0]
    : workerTitles.length > 1
      ? `Spark workers (${workerTitles.length})`
      : "Spark workers";
  const stepRunState = await runStore.createStep({
    runId,
    title: stepTitle,
    goal: workerTitles.length > 0 ? workerTitles.join("; ") : "Workers spawned via execute-mode manager.",
    kind: "worker_batch",
    plannedAgents: [],
    acceptanceCriteria: ["All spawned worker tasks complete."],
  });
  const synthStep = stepRunState.steps.at(-1);
  const synthStepId = synthStep?.id;

  const workerTaskIds: string[] = [];
  const attemptIdsToLaunch: string[] = [];
  for (const raw of rawWorkers) {
    if (!raw || typeof raw !== "object") continue;
    const w = raw as Record<string, unknown> & OrchestratorWorkerInput;
    const title = typeof w.title === "string" ? w.title.trim() : "";
    if (!title) continue;
    const description = typeof w.description === "string" ? w.description : "";
    const updated = await runStore.createWorkerTask({
      runId,
      stepId: synthStepId,
      title,
      description,
      runtimePreference: (w.runtimePreference ?? ORCHESTRATOR_RUNTIME_FALLBACK) as
        | "claude" | "codex" | "shell" | "manual",
      modelHint: typeof w.modelHint === "string" ? w.modelHint : undefined,
      effortHint: w.effortHint,
      allowedPaths: Array.isArray(w.allowedPaths) ? w.allowedPaths.filter((p): p is string => typeof p === "string") : [],
      forbiddenPaths: Array.isArray(w.forbiddenPaths) ? w.forbiddenPaths.filter((p): p is string => typeof p === "string") : [],
      expectedOutputs: Array.isArray(w.expectedOutputs) ? w.expectedOutputs.filter((p): p is string => typeof p === "string") : [],
      verificationCommands: Array.isArray(w.verificationCommands)
        ? w.verificationCommands.filter((p): p is string => typeof p === "string")
        : [],
      taskClass: w.taskClass,
      createdBy: "spark",
    });
    // The just-created task is the LAST entry on updated.workerTasks.
    const created = updated.workerTasks.at(-1);
    if (!created) continue;
    workerTaskIds.push(created.id);
    try {
      const envelope = await runStore.prepareWorkerTask({ runId, workerTaskId: created.id, cwd });
      // The prepared attempt is sitting at prompt_ready; schedule the
      // autopilot cycle that flips it to launching + actually spawns the
      // worker CLI. Before the execute-mode autopilot-review-skip landed
      // (run-store.ts:741+), this happened indirectly via the eventual
      // worker_result_review pickup. Now nobody calls launchWorkerAttempt
      // unless we do it here — without this, CC's manager turn spawns
      // workers that sit forever in prompt_ready, blocks on
      // spark_wait_for_workers until the 90s turn timeout fires, and
      // reports back "Worker was cancelled before execution."
      attemptIdsToLaunch.push(envelope.attemptId);
    } catch {
      // prepareWorkerTask failures shouldn't block subsequent queueings; the
      // worker stays in 'created' state and the autopilot will retry.
    }
  }
  if (attemptIdsToLaunch.length > 0) {
    runStore.scheduleAutopilotCycles(runId, attemptIdsToLaunch);
  }
  return successResponse(id, { worker_task_ids: workerTaskIds });
}

async function handleOrchestratorAskUser(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const runId = stringParam(params, "runId");
  if (!runId) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  const question = stringParam(params, "question");
  if (!question) return errorResponse(id, ERR_INVALID_PARAMS, "question is required");
  const rawOptions = Array.isArray(params.options) ? params.options : [];
  const options = rawOptions
    .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === "object")
    .slice(0, 4)
    .map((o, idx) => ({
      id: typeof o.id === "string" ? o.id : `option_${idx + 1}`,
      label: typeof o.label === "string" ? o.label : `Option ${idx + 1}`,
      description: typeof o.description === "string" ? o.description : "",
      answer: typeof o.answer === "string" ? o.answer : (typeof o.label === "string" ? o.label : `Option ${idx + 1}`),
      recommended: o.recommended === true,
    }));

  const runStore = await getRunStore();
  try {
    await runStore.addRunMessage({
      runId,
      author: "spark",
      kind: "question",
      message: question,
      questionOptions: options,
    });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }

  const askedAt = Date.now();
  const deadline = askedAt + ASK_USER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, ASK_USER_POLL_MS));
    const run = await runStore.getRun(runId);
    if (!run) {
      return errorResponse(id, ERR_INVALID_PARAMS, `Run vanished mid-ask: ${runId}`);
    }
    const answer = [...run.humanMessages]
      .reverse()
      .find((m) =>
        m.author === "user" &&
        (m.kind === "answer" || m.kind === "note") &&
        Date.parse(m.createdAt) > askedAt,
      );
    if (answer) {
      return successResponse(id, { answer: answer.message, kind: answer.kind });
    }
  }
  return errorResponse(id, ERR_INTERNAL, "ask_user timed out waiting for human response");
}

async function handleOrchestratorComplete(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const runId = stringParam(params, "runId");
  if (!runId) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  const summary = stringParam(params, "summary") ?? "";
  const runStore = await getRunStore();
  try {
    if (summary) {
      await runStore.addRunMessage({
        runId,
        author: "spark",
        kind: "note",
        message: summary,
      });
    }
    await runStore.updateRunStatus({ runId, status: "complete" });
    return successResponse(id, { ok: true });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

const WAIT_FOR_WORKERS_POLL_MS = 500;
const WAIT_FOR_WORKERS_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min default
const WAIT_FOR_WORKERS_MAX_TIMEOUT_MS = 20 * 60 * 1000; // 20 min cap (req.setTimeout in MCP client is also 20 min)
const TERMINAL_WORKER_TASK_STATUSES = new Set<string>(["accepted", "failed", "cancelled"]);

async function handleOrchestratorWaitForWorkers(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const runId = stringParam(params, "runId");
  if (!runId) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  const rawIds = Array.isArray(params.worker_task_ids) ? params.worker_task_ids : null;
  if (!rawIds || rawIds.length === 0) {
    return errorResponse(id, ERR_INVALID_PARAMS, "worker_task_ids must be a non-empty array");
  }
  const workerTaskIds = rawIds.filter((x): x is string => typeof x === "string" && x.length > 0);
  if (workerTaskIds.length === 0) {
    return errorResponse(id, ERR_INVALID_PARAMS, "worker_task_ids contained no valid string ids");
  }
  const mode = params.mode === "any" ? "any" : "all";
  const requestedTimeout =
    typeof params.timeout_ms === "number" && Number.isFinite(params.timeout_ms) && params.timeout_ms > 0
      ? Math.min(params.timeout_ms, WAIT_FOR_WORKERS_MAX_TIMEOUT_MS)
      : WAIT_FOR_WORKERS_DEFAULT_TIMEOUT_MS;
  const runStore = await getRunStore();
  const deadline = Date.now() + requestedTimeout;
  const snapshotWorkers = (run: RunState): {
    worker_task_id: string;
    task_status: string | null;
    attempt_status: string | null;
    runtime: string | null;
    started_at: string | null;
    finished_at: string | null;
    final_report_path: string | null;
    is_terminal: boolean;
  }[] =>
    workerTaskIds.map((wtid) => {
      const task = run.workerTasks.find((wt) => wt.id === wtid);
      const lastAttempt = task
        ? [...run.workerAttempts].reverse().find((a) => a.workerTaskId === wtid)
        : null;
      const taskStatus = task ? task.status : null;
      return {
        worker_task_id: wtid,
        task_status: taskStatus,
        attempt_status: lastAttempt?.status ?? null,
        runtime: lastAttempt?.runtime ?? task?.runtimePreference ?? null,
        started_at: lastAttempt?.startedAt ?? null,
        finished_at: lastAttempt?.finishedAt ?? null,
        final_report_path: lastAttempt?.finalReportPath ?? null,
        is_terminal: taskStatus !== null && TERMINAL_WORKER_TASK_STATUSES.has(taskStatus),
      };
    });
  const firstRun = await runStore.getRun(runId);
  if (!firstRun) return errorResponse(id, ERR_INVALID_PARAMS, `Run not found: ${runId}`);
  const unknownIds = workerTaskIds.filter(
    (wtid) => !firstRun.workerTasks.some((wt) => wt.id === wtid),
  );
  if (unknownIds.length > 0) {
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      `unknown worker_task_ids: ${unknownIds.join(", ")}`,
    );
  }
  while (Date.now() < deadline) {
    const run = await runStore.getRun(runId);
    if (!run) return errorResponse(id, ERR_INVALID_PARAMS, `Run vanished mid-wait: ${runId}`);
    const snapshot = snapshotWorkers(run);
    const terminalCount = snapshot.filter((w) => w.is_terminal).length;
    if (mode === "any" && terminalCount > 0) {
      return successResponse(id, {
        workers: snapshot.map(({ is_terminal: _t, ...rest }) => rest),
        reason: "any_terminal",
      });
    }
    if (mode === "all" && terminalCount === snapshot.length) {
      return successResponse(id, {
        workers: snapshot.map(({ is_terminal: _t, ...rest }) => rest),
        reason: "all_terminal",
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, WAIT_FOR_WORKERS_POLL_MS));
  }
  const finalRun = await runStore.getRun(runId);
  const finalSnapshot = finalRun ? snapshotWorkers(finalRun) : snapshotWorkers(firstRun);
  return successResponse(id, {
    workers: finalSnapshot.map(({ is_terminal: _t, ...rest }) => rest),
    reason: "timeout",
  });
}

async function handleOrchestratorGetWorkerStatus(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const runId = stringParam(params, "runId");
  if (!runId) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  const workerTaskId = stringParam(params, "worker_task_id");
  if (!workerTaskId) return errorResponse(id, ERR_INVALID_PARAMS, "worker_task_id is required");
  const runStore = await getRunStore();
  const run = await runStore.getRun(runId);
  if (!run) {
    return errorResponse(id, ERR_INVALID_PARAMS, `Run not found: ${runId}`);
  }
  try {
    const task = run.workerTasks.find((wt) => wt.id === workerTaskId);
    if (!task) {
      return errorResponse(id, ERR_INVALID_PARAMS, `unknown worker_task_id: ${workerTaskId}`);
    }
    const lastAttempt = [...run.workerAttempts]
      .reverse()
      .find((a) => a.workerTaskId === workerTaskId);
    return successResponse(id, {
      worker_task_id: workerTaskId,
      task_status: task.status,
      attempt_status: lastAttempt?.status ?? null,
      runtime: lastAttempt?.runtime ?? task.runtimePreference,
      started_at: lastAttempt?.startedAt ?? null,
      finished_at: lastAttempt?.finishedAt ?? null,
      final_report_path: lastAttempt?.finalReportPath ?? null,
    });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
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
