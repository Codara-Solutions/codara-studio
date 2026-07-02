import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as pty from "./pty-manager";
import { sparkHome } from "./spark-home";
import { writeFileAtomic } from "./fs-atomic";
import { requestPreviewOp, type PreviewOpName, type PreviewOpParams } from "./preview-bridge";
import { handlePreviewInputOp, type PreviewInputOp } from "./preview-input";
import type {
  AutomationLoop,
  AutomationTrigger,
  CreateScheduledJobInput,
  LoomGraph,
  LoomWorkerConfig,
  RunState,
  ScheduledJob,
  UpdateScheduledJobInput,
} from "@shared/types";

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

// Same lazy-load trick for the scheduler — the Automation-mode architect's
// automation.* RPCs proxy straight into these. createJob/updateJob/deleteJob/
// setEnabled already emit the `automation.updated` event from inside scheduler,
// so the Automations Hub refreshes live without us re-emitting here.
let schedulerMod: typeof import("./orchestration/scheduler") | undefined;
async function getScheduler(): Promise<typeof import("./orchestration/scheduler")> {
  schedulerMod ??= await import("./orchestration/scheduler");
  return schedulerMod;
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

  // We have an authenticated, well-formed dispatch. The 30s idle timeout
  // installed per-connection exists only to reap stalled handshakes; the
  // orchestrator long-poll methods (ask_user / wait_for_workers) hold this
  // connection open for up to 20 min with zero socket traffic, so leaving
  // the timer armed would destroy the socket mid-poll and hand the one-shot
  // MCP client a spurious ECONNRESET. Disarm it now that real work begins.
  req.socket.setTimeout(0);

  const response = await dispatch(reqObj.method, reqObj.params, id, res);
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
  res: ServerResponse,
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
      case "preview.wait_for":
      case "preview.screenshot":
      case "preview.resize":
        // Renderer-side ops: DOM probes, capture, and the webview-element
        // resize all run in the renderer against the picked preview tab.
        return await handlePreviewOp(method, params, id);
      case "preview.scroll":
      case "preview.hover":
      case "preview.mouse":
      case "preview.drag":
      case "preview.upload":
      case "preview.console":
      case "preview.network":
      case "preview.key":
      case "preview.press_key":
        // Computer-use ops: main drives the guest webContents directly with
        // trusted input (sendInputEvent) + CDP. press_key lives here too so it
        // uses trusted input when a guest resolves (and falls back to the
        // renderer probe when it can't).
        return await handlePreviewInputRpc(method, params, id);
      case "orchestrator.spawn_workers":
        return await handleOrchestratorSpawnWorkers(params, id);
      case "orchestrator.ask_user":
        return await handleOrchestratorAskUser(params, id, res);
      case "orchestrator.complete":
        return await handleOrchestratorComplete(params, id);
      case "orchestrator.request_next_iteration":
        return await handleOrchestratorRequestNextIteration(params, id);
      case "orchestrator.get_worker_status":
        return await handleOrchestratorGetWorkerStatus(params, id);
      case "orchestrator.wait_for_workers":
        return await handleOrchestratorWaitForWorkers(params, id, res);
      case "automation.list":
        return await handleAutomationList(params, id);
      case "automation.get":
        return await handleAutomationGet(params, id);
      case "automation.create":
        return await handleAutomationCreate(params, id);
      case "automation.update":
        return await handleAutomationUpdate(params, id);
      case "automation.run_now":
        return await handleAutomationRunNow(params, id);
      case "automation.wait":
        return await handleAutomationWait(params, id, res);
      case "automation.set_enabled":
        return await handleAutomationSetEnabled(params, id);
      case "automation.pause":
        return await handleAutomationPause(params, id);
      case "automation.resume":
        return await handleAutomationResume(params, id);
      case "automation.stop":
        return await handleAutomationStop(params, id);
      case "automation.delete":
        return await handleAutomationDelete(params, id);
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

async function handlePreviewInputRpc(
  method: string,
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const op = method.replace(/^preview\./, "") as PreviewInputOp;
  try {
    const result = await handlePreviewInputOp(op, params);
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
// Workers are queued via createWorkerTask + prepareWorkerTask and launched
// end-to-end from this call site through scheduleAutopilotCycles; the manager
// can `await` completion via spark_wait_for_workers.

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
  const blocked = rejectIfAutomationRun(run, id, "spark_spawn_workers");
  if (blocked) return blocked;
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
  // Fable 5 is reserved for the main chat and automations — Spark-spawned
  // workers must never run it. Downgrade any fable modelHint the manager emits
  // to Opus 4.8 here (the spawn chokepoint) and remember the titles so we can
  // surface ONE visible system note after the loop.
  const downgradedFableTitles: string[] = [];
  for (const raw of rawWorkers) {
    if (!raw || typeof raw !== "object") continue;
    const w = raw as Record<string, unknown> & OrchestratorWorkerInput;
    const title = typeof w.title === "string" ? w.title.trim() : "";
    if (!title) continue;
    const description = typeof w.description === "string" ? w.description : "";
    const sanitizedModel = runStore.sanitizeWorkerModelHint(
      typeof w.modelHint === "string" ? w.modelHint : undefined,
    );
    if (sanitizedModel.downgraded) downgradedFableTitles.push(title);
    const updated = await runStore.createWorkerTask({
      runId,
      stepId: synthStepId,
      title,
      description,
      runtimePreference: (w.runtimePreference ?? ORCHESTRATOR_RUNTIME_FALLBACK) as
        | "claude" | "codex" | "shell" | "manual",
      modelHint: sanitizedModel.hint,
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
    } catch (err) {
      // prepareWorkerTask failures shouldn't block subsequent queueings; the
      // worker stays in 'created' state and the autopilot will retry. Not
      // silent though — a stuck-in-created worker is otherwise undiagnosable.
      console.warn(
        `[agent-socket] prepareWorkerTask failed for ${created.id} (run ${runId}); autopilot will retry:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (downgradedFableTitles.length > 0) {
    const list = downgradedFableTitles.map((t) => `"${t}"`).join(", ");
    const note =
      `Fable 5 (claude-fable-5) is reserved for the main chat session and automations — ` +
      `it is not available to Spark-spawned workers. ` +
      `Downgraded ${downgradedFableTitles.length === 1 ? "worker" : "workers"} ${list} to Opus 4.8 (claude-opus-4-8).`;
    try {
      await runStore.addRunMessage({
        runId,
        author: "system",
        kind: "note",
        message: note,
      });
    } catch {
      /* the note is advisory — never block the spawn on it */
    }
  }
  if (attemptIdsToLaunch.length > 0) {
    runStore.scheduleAutopilotCycles(runId, attemptIdsToLaunch);
  }
  // Echo the downgrade back to the manager LLM so it doesn't try to re-pin
  // fable on the next turn (it never sees the run's system note).
  return successResponse(
    id,
    downgradedFableTitles.length > 0
      ? {
          worker_task_ids: workerTaskIds,
          note: `Fable 5 is reserved for the main chat and automations; ${downgradedFableTitles.length} worker model hint(s) were downgraded to claude-opus-4-8. Do not request claude-fable-5 for workers.`,
        }
      : { worker_task_ids: workerTaskIds },
  );
}

// A long-poll loop should give up the moment the MCP client hangs up —
// otherwise a dropped connection keeps the main-process loop polling blind
// for the full 15-20 min deadline.
function clientGone(res: ServerResponse): boolean {
  return res.writableEnded || res.socket === null || res.socket.destroyed;
}

async function handleOrchestratorAskUser(
  params: Record<string, unknown>,
  id: JsonRpcId,
  res: ServerResponse,
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

  // Looms v2: a direct worker asking mid-session surfaces as a BLOCKED run.
  // That one status flip drives everything downstream — the Hub's question
  // card + "needs you" badge, the loop driver's blocked HOLD, and the desktop
  // notification (run.status_updated is the notifier's canonical signal).
  // Managed runs are untouched: their manager pipeline owns blocked status.
  let flippedBlocked = false;
  try {
    const run = await runStore.getRun(runId);
    if (run?.executionMode === "direct" && run.status === "running") {
      await runStore.updateRunStatus({ runId, status: "blocked" });
      flippedBlocked = true;
    }
  } catch {
    /* the ask still works without the status cue */
  }
  const restoreRunning = async (): Promise<void> => {
    if (!flippedBlocked) return;
    try {
      const run = await runStore.getRun(runId);
      if (run?.status === "blocked") {
        await runStore.updateRunStatus({ runId, status: "running" });
      }
    } catch {
      /* watchTerminal's non-terminal reset clears any stale blocked cue */
    }
  };

  const askedAt = Date.now();
  const deadline = askedAt + ASK_USER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, ASK_USER_POLL_MS));
    // Client hung up — stop polling; writeJsonRpc on a dead socket is a no-op.
    if (clientGone(res)) {
      await restoreRunning();
      return errorResponse(id, ERR_INTERNAL, "ask_user aborted: client disconnected");
    }
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
      await restoreRunning();
      return successResponse(id, { answer: answer.message, kind: answer.kind });
    }
  }
  await restoreRunning();
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
  const run = await runStore.getRun(runId);
  if (!run) return errorResponse(id, ERR_INVALID_PARAMS, `Run not found: ${runId}`);
  const blocked = rejectIfAutomationRun(run, id, "spark_complete");
  if (blocked) return blocked;
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

// Agent-driven automation loops: the orchestrator records whether the loop
// should run another iteration. The loop driver reads this in onTerminal. Has
// no effect on a normal (non-automation) run — the signal is simply unread.
async function handleOrchestratorRequestNextIteration(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const runId = stringParam(params, "runId");
  if (!runId) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  const done = params.done === true;
  const prompt = stringParam(params, "prompt") ?? undefined;
  // Slice 7: which loom node this worker executes (SPARK_NODE_ID, auto-injected
  // by the MCP server). Used by the loop driver to read only the SINK node's
  // signal in a multi-node wave; undefined for single-node looms.
  const nodeId = stringParam(params, "nodeId") ?? undefined;

  // Looms v2 auto-handoff: the agent may steer the NEXT pass's worker. Invalid
  // fields are dropped (never an error response — the continue/stop signal must
  // always be recorded; killing the loop over a typo'd model id would be worse
  // than ignoring the steering). Whatever survives validation is honored only
  // by auto-engine looms; the loop driver re-checks the pin.
  const requestedEngine = stringParam(params, "nextEngine") ?? undefined;
  const requestedModel = stringParam(params, "nextModel") ?? undefined;
  const requestedEffort = stringParam(params, "nextEffort") ?? undefined;
  let nextEngine: "claude" | "codex" | undefined;
  let nextModel: string | undefined;
  let nextEffort: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  let warning: string | undefined;
  if (requestedEngine !== undefined || requestedModel !== undefined || requestedEffort !== undefined) {
    try {
      const { detectAgentRuntimes } = await import("./agent-runtimes");
      const runtimes = await detectAgentRuntimes();
      if (requestedEngine === "claude" || requestedEngine === "codex") {
        const runtime = runtimes.find((r) => r.kind === requestedEngine);
        if (runtime?.installed && !runtime.disabledBySettings) {
          nextEngine = requestedEngine;
          if (requestedModel) {
            const known = runtime.models.map((m) => m.id);
            if (known.length === 0 || known.includes(requestedModel)) {
              nextModel = requestedModel;
            } else {
              warning = `nextModel "${requestedModel}" is not a known ${requestedEngine} model id — the CLI default will be used.`;
            }
          }
        } else {
          warning = `nextEngine "${requestedEngine}" is not installed/enabled — keeping the current engine.`;
        }
      } else if (requestedEngine !== undefined) {
        warning = `nextEngine must be "claude" or "codex" — got "${requestedEngine}".`;
      } else if (requestedModel) {
        warning = "nextModel requires nextEngine — ignored.";
      }
      if (["minimal", "low", "medium", "high", "xhigh", "max"].includes(requestedEffort ?? "")) {
        nextEffort = requestedEffort as typeof nextEffort;
      } else if (requestedEffort !== undefined) {
        warning = warning ?? `nextEffort "${requestedEffort}" is not a valid effort level — ignored.`;
      }
      if (warning) {
        const { appendEvent } = await import("./orchestration/event-log");
        await appendEvent({
          workspaceId: "",
          type: "automation.handoff_rejected",
          payload: { runId, requestedEngine, requestedModel, requestedEffort, warning },
        }).catch(() => undefined);
      }
    } catch {
      // Validation failing must never block the continue signal.
      nextEngine = undefined;
      nextModel = undefined;
      nextEffort = undefined;
    }
  }

  try {
    const { recordAgentSignal } = await import("./orchestration/automation-loop");
    recordAgentSignal(runId, { continue: !done, prompt, nextEngine, nextModel, nextEffort, nodeId });
    const accepted =
      nextEngine || nextModel || nextEffort ? { nextEngine, nextModel, nextEffort } : undefined;
    return successResponse(id, { ok: true, continue: !done, accepted, warning });
  } catch (err) {
    return errorResponse(id, ERR_INTERNAL, (err as Error).message);
  }
}

const WAIT_FOR_WORKERS_POLL_MS = 500;
const WAIT_FOR_WORKERS_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min default
const WAIT_FOR_WORKERS_MAX_TIMEOUT_MS = 20 * 60 * 1000; // 20 min cap (req.setTimeout in MCP client is also 20 min)
const TERMINAL_WORKER_TASK_STATUSES = new Set<string>(["accepted", "failed", "cancelled"]);

async function handleOrchestratorWaitForWorkers(
  params: Record<string, unknown>,
  id: JsonRpcId,
  res: ServerResponse,
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
  const blocked = rejectIfAutomationRun(firstRun, id, "spark_wait_for_workers");
  if (blocked) return blocked;
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
    // Client hung up — stop polling rather than block the loop for ~20 min.
    if (clientGone(res)) {
      return errorResponse(id, ERR_INTERNAL, "wait_for_workers aborted: client disconnected");
    }
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
  const blocked = rejectIfAutomationRun(run, id, "spark_get_worker_status");
  if (blocked) return blocked;
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

// ---------------------------------------------------------------------------
// Automation (loom) architect handlers — reachable only from an Automation-mode
// chat. The MCP server proxies spark_*_automation tools to these automation.*
// RPCs. Defense in depth: EVERY handler loads the run by runId and rejects
// unless run.chatMode === "automation", so even if a stray socket caller hits
// these verbs they can't mutate the scheduler from a non-automation chat.
// ---------------------------------------------------------------------------

const AUTOMATION_WAIT_POLL_MS = 2000;
const AUTOMATION_WAIT_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
// 19 min, deliberately UNDER the MCP server's 20-min transport timeout in
// postJsonRpc — so a max-length wait still returns a clean reason:"timeout"
// snapshot instead of the client tearing the socket down first.
const AUTOMATION_WAIT_MAX_TIMEOUT_MS = 19 * 60 * 1000;

/**
 * Whether an automation has reached a state worth returning to a waiting
 * architect. "stopped"/"blocked" are unambiguously terminal. "idle" is
 * overloaded — it is BOTH the pre-run resting state (iteration 0, never fired)
 * AND the between-iterations parking state of a cadence loop (nextFireAt
 * armed). We must only treat "idle" as "this run settled" when at least one
 * iteration has completed AND the loop is not waiting to fire again, otherwise
 * the waiter would report a not-yet-started automation, or a mid-cadence pause,
 * as a finished run.
 */
function isAutomationSettled(job: ScheduledJob): boolean {
  const status = job.state?.status ?? "idle";
  if (status === "stopped" || status === "blocked") return true;
  if (status === "idle") {
    const ranAtLeastOnce = (job.state?.iteration ?? 0) > 0;
    const waitingToFireAgain = Boolean(job.state?.nextFireAt);
    // currentRunId is cleared by finalize() but still set during the brief
    // resumeJob() paused→idle flip that precedes resumeLoop's re-decide, so
    // requiring it absent avoids reporting an about-to-relaunch loop as done.
    const hasLiveRun = Boolean(job.state?.currentRunId);
    return ranAtLeastOnce && !waitingToFireAgain && !hasLiveRun;
  }
  return false;
}

/**
 * Symmetric guard for the worker-orchestration RPCs (spawn/complete/wait/
 * get_status). Automation mode is sold as read-only on the workspace — it may
 * only manage automations — so a chat in that mode must not be able to spawn,
 * complete, or steer execute-mode workers. On the Codex backend the globally-
 * installed MCP has no per-run env, so a Codex automation chat still SEES the
 * execute roster; this is the enforcement boundary for it (Claude automation
 * chats never see these tools — their per-run MCP config is mode-scoped).
 * Returns an error response to short-circuit, or null when the run may proceed.
 */
function rejectIfAutomationRun(
  run: RunState,
  id: JsonRpcId,
  toolName: string,
): JsonRpcResponse | null {
  if (run.chatMode !== "automation") return null;
  return errorResponse(
    id,
    ERR_INVALID_PARAMS,
    `${toolName} is not available in Automation mode (this chat is read-only on the workspace and may only manage automations). Switch the chat to Execute mode to drive workers.`,
  );
}

/**
 * Shared guard for every automation.* handler. Resolves the run and enforces
 * that the calling chat is in Automation mode. Returns the loaded run on
 * success, or a ready-to-return error response.
 */
async function requireAutomationRun(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<{ run: RunState } | { error: JsonRpcResponse }> {
  const runId = stringParam(params, "runId");
  if (!runId) return { error: errorResponse(id, ERR_INVALID_PARAMS, "runId is required") };
  const runStore = await getRunStore();
  const run = await runStore.getRun(runId);
  if (!run) return { error: errorResponse(id, ERR_INVALID_PARAMS, `Run not found: ${runId}`) };
  if (run.chatMode !== "automation") {
    return {
      error: errorResponse(
        id,
        ERR_INVALID_PARAMS,
        "Automation tools are only available when the chat is in Automation mode. Ask the user to switch the composer mode pill to \"Automation\" and try again.",
      ),
    };
  }
  return { run };
}

function summarizeTrigger(t: AutomationTrigger): string {
  switch (t.kind) {
    case "cron":
      return `cron(${t.expr}${t.tz ? ` ${t.tz}` : ""})`;
    case "interval":
      return `interval(${t.everyMs}ms)`;
    case "folder":
      return `folder(${t.path}${t.glob ? ` ${t.glob}` : ""} [${(t.events ?? []).join(",")}])`;
    case "manual":
      return "manual";
    case "continuous":
      return "continuous";
    case "onFinishOf":
      return `onFinishOf(${t.automationId})`;
    default:
      return "unknown";
  }
}

function summarizeLoop(l: AutomationLoop): string {
  const caps: string[] = [];
  const s = l.stop ?? {};
  if (typeof s.maxIterations === "number") caps.push(`max=${s.maxIterations}`);
  if (typeof s.budgetUsd === "number") caps.push(`budget=$${s.budgetUsd}`);
  if (s.untilTestsPass) caps.push("untilTestsPass");
  if (s.untilGitClean) caps.push("untilGitClean");
  if (s.untilPhrase) caps.push(`untilPhrase="${s.untilPhrase}"`);
  if (s.untilCommand) caps.push("untilCommand");
  const cadence = l.kind === "cadence" && typeof l.everyMs === "number" ? ` every ${l.everyMs}ms` : "";
  return `${l.kind}${cadence}${caps.length ? ` [${caps.join(", ")}]` : ""}`;
}

function summarizeJob(job: ScheduledJob): Record<string, unknown> {
  const history = Array.isArray(job.history) ? job.history : [];
  return {
    id: job.id,
    name: job.name,
    enabled: job.enabled,
    trigger: summarizeTrigger(job.trigger),
    loop: summarizeLoop(job.loop),
    worker: job.worker,
    nodeCount: job.graph?.nodes?.length ?? 0,
    edgeCount: job.graph?.edges?.length ?? 0,
    status: job.state?.status ?? "idle",
    iteration: job.state?.iteration ?? 0,
    lastRunAt: job.lastRunAt ?? null,
    history: history.slice(-3).map((h) => ({
      iteration: h.iteration,
      status: h.status,
      stopReason: h.stopReason ?? null,
      costUsd: h.costUsd ?? null,
    })),
  };
}

/**
 * Structural validation of an architect-supplied graph BEFORE it reaches the
 * scheduler, so a malformed graph comes back as a fixable error message rather
 * than crashing the loop driver later. Returns null when valid, or an error
 * string the LLM can act on.
 */
function validateGraph(graph: LoomGraph): string | null {
  if (!graph || typeof graph !== "object") return "graph must be an object";
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    return "graph.nodes must be a non-empty array";
  }
  if (!Array.isArray(graph.edges)) return "graph.edges must be an array";
  if (!Array.isArray(graph.entryNodeIds) || graph.entryNodeIds.length === 0) {
    return "graph.entryNodeIds must be a non-empty array when a graph is provided";
  }
  const GUARD_PREDICATE_TYPES = new Set(["phrase", "tests", "gitClean", "command", "agentSignal"]);
  const ENGINES = new Set(["auto", "claude", "codex"]);
  const ids = new Set<string>();
  const guardIds = new Set<string>();
  for (const rawNode of graph.nodes) {
    // The graph arrives from an untrusted LLM, so validate against a loose
    // shape rather than the LoomNodeDef union (which TS would treat as already
    // exhaustive and narrow `kind` to never after the checks below).
    const node = rawNode as {
      id?: unknown;
      kind?: unknown;
      predicate?: { type?: unknown; phrase?: unknown; command?: unknown; want?: unknown };
      prompt?: unknown;
      worker?: { engine?: unknown };
    };
    if (!node || typeof node.id !== "string" || node.id.trim().length === 0) {
      return "every graph node needs a non-empty string id";
    }
    if (ids.has(node.id)) return `duplicate node id: ${node.id}`;
    ids.add(node.id);
    if (node.kind !== "worker" && node.kind !== "guard" && node.kind !== "merge") {
      return `node ${node.id} has invalid kind '${String(node.kind)}' (expected worker|guard|merge)`;
    }
    if (node.kind === "guard") {
      guardIds.add(node.id);
      if (!node.predicate || typeof node.predicate !== "object") {
        return `guard node ${node.id} requires a predicate`;
      }
      const ptype = node.predicate.type;
      if (typeof ptype !== "string" || !GUARD_PREDICATE_TYPES.has(ptype)) {
        return `guard node ${node.id} has invalid predicate.type '${String(ptype)}' (expected phrase|tests|gitClean|command|agentSignal)`;
      }
      // Per-type required payload — the engine dereferences these directly, so a
      // missing field (e.g. a "phrase" predicate with no `phrase`) crashes guard
      // evaluation mid-pass. Catch it here as a fixable error instead.
      if (ptype === "phrase" && (typeof node.predicate.phrase !== "string" || node.predicate.phrase.length === 0)) {
        return `guard node ${node.id}: predicate type 'phrase' requires a non-empty 'phrase' string`;
      }
      if (ptype === "command" && (typeof node.predicate.command !== "string" || node.predicate.command.length === 0)) {
        return `guard node ${node.id}: predicate type 'command' requires a non-empty 'command' string`;
      }
      if (ptype === "agentSignal" && node.predicate.want !== "continue" && node.predicate.want !== "done") {
        return `guard node ${node.id}: predicate type 'agentSignal' requires want to be 'continue' or 'done'`;
      }
    }
    if (node.kind === "worker") {
      if (typeof node.prompt !== "string" || node.prompt.trim().length === 0) {
        // Graph worker nodes run node.prompt verbatim (the job's prompt_template
        // is NOT inherited per-node), so an empty prompt is a real defect.
        return `worker node ${node.id} requires a non-empty prompt`;
      }
      // node.worker is dereferenced (n.worker.engine) by advance/relaunch waves;
      // a missing/garbage worker crashes the pass mid-flight. Require it.
      if (!node.worker || typeof node.worker !== "object") {
        return `worker node ${node.id} requires a worker config (with an 'engine')`;
      }
      if (typeof node.worker.engine !== "string" || !ENGINES.has(node.worker.engine)) {
        return `worker node ${node.id} has invalid worker.engine '${String(node.worker.engine)}' (expected auto|claude|codex)`;
      }
    }
  }
  for (const entry of graph.entryNodeIds) {
    if (!ids.has(entry)) return `entryNodeIds references unknown node: ${entry}`;
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (!edge || typeof edge.id !== "string" || edge.id.trim().length === 0) {
      return "every graph edge needs a non-empty string id";
    }
    if (edgeIds.has(edge.id)) return `duplicate edge id: ${edge.id} (back-edge visit counters key off edge id)`;
    edgeIds.add(edge.id);
    if (!ids.has(edge.from)) return `edge ${edge.id} 'from' references unknown node: ${edge.from}`;
    if (!ids.has(edge.to)) return `edge ${edge.id} 'to' references unknown node: ${edge.to}`;
    if (edge.branch !== undefined) {
      if (edge.branch !== "pass" && edge.branch !== "fail") {
        return `edge ${edge.id} has invalid branch '${edge.branch}' (expected pass|fail)`;
      }
      // A pass/fail branch is only meaningful leaving a guard node.
      if (!guardIds.has(edge.from)) {
        return `edge ${edge.id} sets branch '${edge.branch}' but its source node ${edge.from} is not a guard`;
      }
    }
    if (edge.backEdge) {
      if (typeof edge.visitCap !== "number" || !Number.isInteger(edge.visitCap) || edge.visitCap < 1) {
        return `edge ${edge.id} is a backEdge and must declare a positive integer visitCap`;
      }
      // A back-edge leaving a guard can only ever arm on a pass/fail branch;
      // without one it is a dead loop edge that never fires.
      if (guardIds.has(edge.from) && edge.branch === undefined) {
        return `edge ${edge.id} is a backEdge from guard ${edge.from} and must set branch 'pass' or 'fail'`;
      }
    }
  }
  return null;
}

// Floor the scheduler enforces on interval/cadence (setInterval is armed with
// Math.max(1000, ...)). We reject anything below it (or non-finite) up front so
// a NaN everyMs can't become setInterval(fn, NaN) ≈ a 1ms hot loop persisted
// across reboots (scheduler.ts arms `Math.max(1000, Math.floor(everyMs))`,
// and Math.floor(NaN) is NaN, which Math.max passes straight through).
const MIN_TRIGGER_EVERY_MS = 1000;

/**
 * Structural validation of an architect-supplied trigger/loop/worker. Shared by
 * create (where all three are required) and update (where each is optional, so
 * the caller only validates the fields actually present). Async because the
 * onFinishOf check and cron-expr parse touch the scheduler. Returns null when
 * valid (or absent), or a fixable error string.
 */
async function validateTriggerLoopWorker(opts: {
  trigger?: AutomationTrigger;
  loop?: AutomationLoop;
  worker?: LoomWorkerConfig;
}): Promise<string | null> {
  const TRIGGER_KINDS = new Set(["cron", "interval", "folder", "manual", "continuous", "onFinishOf"]);
  const LOOP_KINDS = new Set(["once", "count", "cadence", "until", "continuous", "agent"]);
  const ENGINES = new Set(["auto", "claude", "codex"]);
  if (opts.trigger !== undefined) {
    const t = opts.trigger as AutomationTrigger & {
      kind?: unknown;
      expr?: unknown;
      everyMs?: unknown;
      path?: unknown;
      automationId?: unknown;
    };
    if (typeof t.kind !== "string" || !TRIGGER_KINDS.has(t.kind)) {
      return `trigger.kind '${String(t.kind)}' is invalid (expected cron|interval|folder|manual|continuous|onFinishOf)`;
    }
    // Per-kind required payload — the scheduler arms these directly, so a bad
    // payload becomes a hot loop / crash at arm time rather than a fixable error.
    if (t.kind === "interval") {
      if (typeof t.everyMs !== "number" || !Number.isFinite(t.everyMs) || t.everyMs < MIN_TRIGGER_EVERY_MS) {
        return `trigger kind 'interval' requires a finite numeric everyMs >= ${MIN_TRIGGER_EVERY_MS} (got ${String(t.everyMs)})`;
      }
    } else if (t.kind === "cron") {
      if (typeof t.expr !== "string" || t.expr.trim().length === 0) {
        return "trigger kind 'cron' requires a non-empty 'expr' (a cron expression)";
      }
      // Validate the expression actually parses with the same library the
      // scheduler arms with (croner). An unparseable expr would throw at arm
      // time inside scheduler.armJob's try/catch and silently never fire.
      try {
        const { Cron } = await import("croner");
        // paused:true so constructing it doesn't schedule anything; we only want
        // the parse/validation side effect.
        new Cron(t.expr, { paused: true });
      } catch (err) {
        return `trigger.expr is not a valid cron expression: ${(err as Error).message}`;
      }
    } else if (t.kind === "folder") {
      if (typeof t.path !== "string" || t.path.trim().length === 0) {
        return "trigger kind 'folder' requires a non-empty 'path' to watch";
      }
    } else if (t.kind === "onFinishOf") {
      if (typeof t.automationId !== "string" || t.automationId.trim().length === 0) {
        return "trigger kind 'onFinishOf' requires an 'automationId' to chain after";
      }
      const { listJobs } = await getScheduler();
      const jobs = await listJobs();
      if (!jobs.some((j) => j.id === t.automationId)) {
        return `trigger.automationId '${t.automationId}' does not match any existing automation (call spark_list_automations to find a valid id)`;
      }
    }
  }
  if (opts.loop !== undefined) {
    const l = opts.loop as AutomationLoop & { kind?: unknown; everyMs?: unknown };
    if (typeof l.kind !== "string" || !LOOP_KINDS.has(l.kind)) {
      return `loop.kind '${String(l.kind)}' is invalid (expected once|count|cadence|until|continuous|agent)`;
    }
    if (!l.stop || typeof l.stop !== "object") {
      return "loop.stop is required (use {} to rely on engine defaults)";
    }
    // cadence floors everyMs the same way the interval trigger does.
    if (l.kind === "cadence") {
      if (typeof l.everyMs !== "number" || !Number.isFinite(l.everyMs) || l.everyMs < MIN_TRIGGER_EVERY_MS) {
        return `loop kind 'cadence' requires a finite numeric everyMs >= ${MIN_TRIGGER_EVERY_MS} (got ${String(l.everyMs)})`;
      }
    }
    // A count loop's iteration target IS stop.maxIterations; without it the
    // engine's hardCap silently collapses the loop to a single pass — reject
    // instead so the architect fixes the config rather than shipping a
    // one-shot "loop".
    if (l.kind === "count") {
      const m = (l.stop as { maxIterations?: unknown }).maxIterations;
      if (typeof m !== "number" || !Number.isFinite(m) || m < 1) {
        return "loop kind 'count' requires stop.maxIterations >= 1 (that number IS the loop count; without it the loop would run exactly once)";
      }
    }
  }
  if (opts.worker !== undefined) {
    if (typeof opts.worker.engine !== "string" || !ENGINES.has(opts.worker.engine)) {
      return `worker.engine '${String(opts.worker.engine)}' is invalid (expected auto|claude|codex)`;
    }
  }
  return null;
}

/** Coerce the loosely-typed RPC params into a CreateScheduledJobInput field. */
function paramTrigger(params: Record<string, unknown>): AutomationTrigger | undefined {
  const t = params.trigger;
  return t && typeof t === "object" ? (t as AutomationTrigger) : undefined;
}
function paramLoop(params: Record<string, unknown>): AutomationLoop | undefined {
  const l = params.loop;
  return l && typeof l === "object" ? (l as AutomationLoop) : undefined;
}
function paramWorker(params: Record<string, unknown>): LoomWorkerConfig | undefined {
  const w = params.worker;
  return w && typeof w === "object" ? (w as LoomWorkerConfig) : undefined;
}
function paramGraph(params: Record<string, unknown>): LoomGraph | undefined {
  const g = params.graph;
  return g && typeof g === "object" ? (g as LoomGraph) : undefined;
}

async function handleAutomationList(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const guard = await requireAutomationRun(params, id);
  if ("error" in guard) return guard.error;
  try {
    const { listJobs } = await getScheduler();
    const jobs = await listJobs();
    return successResponse(id, { automations: jobs.map(summarizeJob) });
  } catch (err) {
    return errorResponse(id, ERR_INTERNAL, (err as Error).message);
  }
}

async function handleAutomationGet(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const guard = await requireAutomationRun(params, id);
  if ("error" in guard) return guard.error;
  const automationId = stringParam(params, "automation_id");
  if (!automationId) return errorResponse(id, ERR_INVALID_PARAMS, "automation_id is required");
  try {
    const { getJob } = await getScheduler();
    const job = await getJob(automationId);
    if (!job) return errorResponse(id, ERR_INVALID_PARAMS, `automation not found: ${automationId}`);
    // Return the full job (trigger/loop/prompt/worker/graph/state) plus the
    // history tail so the architect can patch precisely.
    return successResponse(id, {
      ...job,
      history: (Array.isArray(job.history) ? job.history : []).slice(-5),
    });
  } catch (err) {
    return errorResponse(id, ERR_INTERNAL, (err as Error).message);
  }
}

async function handleAutomationCreate(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const guard = await requireAutomationRun(params, id);
  if ("error" in guard) return guard.error;
  const { run } = guard;
  const name = stringParam(params, "name");
  if (!name) return errorResponse(id, ERR_INVALID_PARAMS, "name is required");
  const trigger = paramTrigger(params);
  if (!trigger) return errorResponse(id, ERR_INVALID_PARAMS, "trigger (with a 'kind') is required");
  const loop = paramLoop(params);
  if (!loop) return errorResponse(id, ERR_INVALID_PARAMS, "loop (with a 'kind' and 'stop') is required");
  if (!loop.stop || typeof loop.stop !== "object") {
    // Normalize a missing stop block to an empty cap set rather than rejecting —
    // the scheduler treats {} as "rely on engine defaults".
    loop.stop = {};
  }
  const worker = paramWorker(params);
  if (!worker) return errorResponse(id, ERR_INVALID_PARAMS, "worker (with an 'engine') is required");
  const tlwErr = await validateTriggerLoopWorker({ trigger, loop, worker });
  if (tlwErr) return errorResponse(id, ERR_INVALID_PARAMS, tlwErr);
  const promptTemplate = stringParam(params, "prompt_template");
  if (!promptTemplate) return errorResponse(id, ERR_INVALID_PARAMS, "prompt_template is required");
  const graph = paramGraph(params);
  if (graph) {
    const graphErr = validateGraph(graph);
    if (graphErr) return errorResponse(id, ERR_INVALID_PARAMS, `invalid graph: ${graphErr}`);
  }
  // Resolve workspace binding server-side from the calling run. The architect
  // never supplies paths — the automation runs in the same workspace as the
  // chat that created it. Unlike the one-shot spawn_workers analog we do NOT
  // fall back to process.cwd(): this cwd is persisted into a RECURRING job, and
  // a guessed path (process.cwd() is "/" in a packaged macOS app) would silently
  // bind the loom to the wrong directory. createRun always stamps
  // settingsSnapshot.workspaceCwd, so a missing value is a real anomaly — fail
  // loudly with a message the architect can relay.
  const cwd =
    typeof run.settingsSnapshot?.workspaceCwd === "string"
      ? (run.settingsSnapshot.workspaceCwd as string)
      : null;
  if (!cwd) {
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      "Could not resolve this chat's workspace directory; cannot bind an automation. The chat may be missing its workspace context.",
    );
  }
  // Prefer an explicit snapshot name; otherwise strip the run-title prefix the
  // run-store adds ("Autopilot - <ws>" / "Run - <ws>").
  const snapshotName =
    typeof run.settingsSnapshot?.workspaceName === "string"
      ? (run.settingsSnapshot.workspaceName as string).trim()
      : "";
  const workspaceName =
    snapshotName || run.title.replace(/^(Autopilot|Run)\s*-\s*/i, "").trim() || "workspace";
  const createInput: CreateScheduledJobInput = {
    name,
    trigger,
    loop,
    prompt: { template: promptTemplate },
    worker,
    graph,
    input: {
      workspaceId: run.workspaceId,
      workspaceName,
      cwd,
      initialUserNote: promptTemplate,
    },
  };
  try {
    const { createJob } = await getScheduler();
    const job = await createJob(createInput);
    return successResponse(id, { created: summarizeJob(job) });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

async function handleAutomationUpdate(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const guard = await requireAutomationRun(params, id);
  if ("error" in guard) return guard.error;
  const automationId = stringParam(params, "automation_id");
  if (!automationId) return errorResponse(id, ERR_INVALID_PARAMS, "automation_id is required");
  const graph = paramGraph(params);
  if (graph) {
    const graphErr = validateGraph(graph);
    if (graphErr) return errorResponse(id, ERR_INVALID_PARAMS, `invalid graph: ${graphErr}`);
  }
  // Validate ONLY the structural fields actually supplied — update is a patch,
  // so an omitted trigger/loop/worker keeps the existing one. This matches the
  // strictness create applies, so a bad patch is rejected, not persisted.
  const tlwErr = await validateTriggerLoopWorker({
    trigger: paramTrigger(params),
    loop: paramLoop(params),
    worker: paramWorker(params),
  });
  if (tlwErr) return errorResponse(id, ERR_INVALID_PARAMS, tlwErr);
  const name = stringParam(params, "name");
  const promptTemplate = stringParam(params, "prompt_template");
  const update: UpdateScheduledJobInput = {
    id: automationId,
    ...(name ? { name } : {}),
    ...(paramTrigger(params) ? { trigger: paramTrigger(params) } : {}),
    ...(paramLoop(params) ? { loop: paramLoop(params) } : {}),
    ...(promptTemplate ? { prompt: { template: promptTemplate } } : {}),
    ...(paramWorker(params) ? { worker: paramWorker(params) } : {}),
    ...(graph ? { graph } : {}),
  };
  try {
    const { getJob, updateJob } = await getScheduler();
    if (!(await getJob(automationId))) {
      return errorResponse(id, ERR_INVALID_PARAMS, `automation not found: ${automationId}`);
    }
    const job = await updateJob(update);
    return successResponse(id, { updated: summarizeJob(job) });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

async function handleAutomationRunNow(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const guard = await requireAutomationRun(params, id);
  if ("error" in guard) return guard.error;
  const automationId = stringParam(params, "automation_id");
  if (!automationId) return errorResponse(id, ERR_INVALID_PARAMS, "automation_id is required");
  try {
    const { getJob, runJobNow } = await getScheduler();
    if (!(await getJob(automationId))) {
      return errorResponse(id, ERR_INVALID_PARAMS, `automation not found: ${automationId}`);
    }
    const runState = await runJobNow(automationId);
    return successResponse(id, { run_id: runState.id, status: runState.status });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

async function handleAutomationWait(
  params: Record<string, unknown>,
  id: JsonRpcId,
  res: ServerResponse,
): Promise<JsonRpcResponse> {
  const guard = await requireAutomationRun(params, id);
  if ("error" in guard) return guard.error;
  const automationId = stringParam(params, "automation_id");
  if (!automationId) return errorResponse(id, ERR_INVALID_PARAMS, "automation_id is required");
  const requested = optionalNumberParam(params, "timeout_ms");
  const timeoutMs =
    requested && requested > 0
      ? Math.min(requested, AUTOMATION_WAIT_MAX_TIMEOUT_MS)
      : AUTOMATION_WAIT_DEFAULT_TIMEOUT_MS;
  const { getJob } = await getScheduler();
  if (!(await getJob(automationId))) {
    return errorResponse(id, ERR_INVALID_PARAMS, `automation not found: ${automationId}`);
  }
  const deadline = Date.now() + timeoutMs;
  const snapshot = (job: ScheduledJob, reason: string): JsonRpcResponse => {
    const history = Array.isArray(job.history) ? job.history : [];
    const last = history.length > 0 ? history[history.length - 1] : undefined;
    const summary = last?.summary ?? job.state?.pendingNextPrompt ?? null;
    return successResponse(id, {
      automation_id: job.id,
      reason,
      status: job.state?.status ?? "idle",
      stop_reason: last?.stopReason ?? job.state?.lastStopReason ?? null,
      iteration: job.state?.iteration ?? 0,
      cost_usd: last?.costUsd ?? job.state?.spentUsd ?? null,
      // next_fire_at distinguishes a still-armed cadence/cron loop (the loop
      // continues) from a fully-finalized run, and lastRunAt gives the model a
      // concrete "did it ever run" signal.
      next_fire_at: job.state?.nextFireAt ?? null,
      last_run_at: job.lastRunAt ?? null,
      last_output: typeof summary === "string" ? summary.slice(0, 2000) : null,
    });
  };
  while (Date.now() < deadline) {
    if (clientGone(res)) {
      return errorResponse(id, ERR_INTERNAL, "wait_for_automation aborted: client disconnected");
    }
    const job = await getJob(automationId);
    if (!job) return errorResponse(id, ERR_INVALID_PARAMS, `automation vanished mid-wait: ${automationId}`);
    if (isAutomationSettled(job)) {
      return snapshot(job, (job.state?.status ?? "idle") === "blocked" ? "blocked" : "terminal");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, AUTOMATION_WAIT_POLL_MS));
  }
  const finalJob = await getJob(automationId);
  if (!finalJob) return errorResponse(id, ERR_INVALID_PARAMS, `automation vanished mid-wait: ${automationId}`);
  return snapshot(finalJob, "timeout");
}

async function handleAutomationSetEnabled(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const guard = await requireAutomationRun(params, id);
  if ("error" in guard) return guard.error;
  const automationId = stringParam(params, "automation_id");
  if (!automationId) return errorResponse(id, ERR_INVALID_PARAMS, "automation_id is required");
  if (typeof params.enabled !== "boolean") {
    return errorResponse(id, ERR_INVALID_PARAMS, "enabled (boolean) is required");
  }
  try {
    const { setEnabled } = await getScheduler();
    const job = await setEnabled(automationId, params.enabled);
    return successResponse(id, { updated: summarizeJob(job) });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

async function handleAutomationPause(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const guard = await requireAutomationRun(params, id);
  if ("error" in guard) return guard.error;
  const automationId = stringParam(params, "automation_id");
  if (!automationId) return errorResponse(id, ERR_INVALID_PARAMS, "automation_id is required");
  try {
    const { getJob, pauseJob } = await getScheduler();
    if (!(await getJob(automationId))) {
      return errorResponse(id, ERR_INVALID_PARAMS, `automation not found: ${automationId}`);
    }
    const job = await pauseJob(automationId);
    return successResponse(id, { updated: job ? summarizeJob(job) : null });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

async function handleAutomationResume(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const guard = await requireAutomationRun(params, id);
  if ("error" in guard) return guard.error;
  const automationId = stringParam(params, "automation_id");
  if (!automationId) return errorResponse(id, ERR_INVALID_PARAMS, "automation_id is required");
  try {
    const { getJob, resumeJob } = await getScheduler();
    if (!(await getJob(automationId))) {
      return errorResponse(id, ERR_INVALID_PARAMS, `automation not found: ${automationId}`);
    }
    const job = await resumeJob(automationId);
    return successResponse(id, { updated: job ? summarizeJob(job) : null });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

async function handleAutomationStop(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const guard = await requireAutomationRun(params, id);
  if ("error" in guard) return guard.error;
  const automationId = stringParam(params, "automation_id");
  if (!automationId) return errorResponse(id, ERR_INVALID_PARAMS, "automation_id is required");
  try {
    const { getJob, stopJob } = await getScheduler();
    if (!(await getJob(automationId))) {
      return errorResponse(id, ERR_INVALID_PARAMS, `automation not found: ${automationId}`);
    }
    const job = await stopJob(automationId);
    return successResponse(id, { updated: job ? summarizeJob(job) : null });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

async function handleAutomationDelete(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const guard = await requireAutomationRun(params, id);
  if ("error" in guard) return guard.error;
  const automationId = stringParam(params, "automation_id");
  if (!automationId) return errorResponse(id, ERR_INVALID_PARAMS, "automation_id is required");
  try {
    const { getJob, deleteJob } = await getScheduler();
    const existing = await getJob(automationId);
    if (!existing) return errorResponse(id, ERR_INVALID_PARAMS, `automation not found: ${automationId}`);
    await deleteJob(automationId);
    return successResponse(id, { deleted: true, id: automationId, name: existing.name });
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
