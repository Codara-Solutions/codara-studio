import { app, BrowserWindow } from "electron";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fsp } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as pty from "./pty-manager";
import { codaraHome } from "./codara-home";
import { writeFileAtomic } from "./fs-atomic";
import { requestPreviewOp, type PreviewOpName, type PreviewOpParams } from "./preview-bridge";
import { waitForLoopbackPreviewServer } from "./preview-navigation";
import { requestTerminalOp } from "./terminal-bridge";
import {
  AgentTerminalOwnershipError,
  type AgentTerminalRegistration,
} from "./agent-terminal-registry";
import {
  agentTerminals,
  canRegisterAgentTerminal,
  quarantineLateAgentTerminal,
  registerAgentTerminal,
} from "./agent-terminal-lifecycle";
import { handlePreviewInputOp, type PreviewInputOp } from "./preview-input";
import { loadPreferences, setPreference } from "./preferences-store";
import { loadState, saveState } from "./storage";
import { setAllowedRoots } from "./fs-sandbox";
import {
  detectWorkerAssignableRuntimes,
  isWorkerAssignable,
} from "./orchestration/pi-worker-providers";
import { broadcastPreferencesChanged } from "./ipc";
import { publish } from "./notify";
import {
  appendEvent,
  listEvents,
  subscribeToEvents,
} from "./orchestration/event-log";
import { validateWorkerAccessFields } from "./orchestration/worker-access";
import {
  dependencyIdsForSpawnedStep,
  findLiveVerifierFeedbackRetry,
} from "./orchestration/step-lifecycle";
import {
  MAX_BULLETS_ADDED_PER_RUN,
  MAX_REMEMBER_CALLS_PER_RUN,
  rememberAdd,
  rememberReplace,
  type MemoryScope,
} from "./orchestration/cora-memory";
import { effectiveRunExecutionPolicy } from "./orchestration/execution-policy";
import {
  blindApprovalAskProblem,
  parsePlanValidation,
  planValidationAskProblem,
} from "./orchestration/run-question-policy";
import { runProjectPolicyMode } from "./orchestration/project-policy";
import {
  evaluateWorkerSessionReuse,
  type WorkerSessionReuseDecision,
} from "./orchestration/worker-session-reuse";
import { normalizePiAccountProfileId } from "./orchestration/pi-account-execution";
import { effectiveChatMode } from "@shared/chat-policy";
import { DEFAULT_PREFERENCES } from "@shared/types";
import {
  authorizeAgentSocketCapability,
  setAgentSocketCapabilityEndpoint,
  type AgentSocketCapabilityClaim,
} from "./agent-socket-capabilities";
import {
  CODEX_MODEL_CATALOG,
  normalizeCodexModelId,
} from "@shared/model-catalog";
import { ALLOWED_WORKER_MODELS, rosterModelFor } from "./orchestration/worker-model-hint";
import {
  headroomForRuntime,
  preferredRuntimeForHeadroom,
  readSubscriptionHeadroomSummary,
  runtimeLimitReached,
} from "./orchestration/subscription-headroom";
import type {
  AppPreferences,
  AppState,
  AgentEffortLevel,
  BoardCard,
  BoardCardStatus,
  ChatBackendKind,
  ChatMode,
  InAppNotificationTone,
  NotificationSoundKind,
  NotifyKind,
  PrefKey,
  AutomationLoop,
  AutomationTrigger,
  CreateScheduledJobInput,
  LoomGraph,
  LoomWorkerConfig,
  RunQuestionCategory,
  RunState,
  SparkEvent,
  ScheduledJob,
  UpdateScheduledJobInput,
  UpdateCoraWhiteboardInput,
  WorkerTask,
  Workspace,
} from "@shared/types";

const HANDSHAKE_FILE = "agent-socket.json";

// JSON-RPC server hosted by main, exposed to sub-agents via SPARK_AGENT_SOCKET +
// SPARK_AGENT_TOKEN env vars. Sub-agents POST {jsonrpc:"2.0",method,params,id}
// to /rpc with Authorization: Bearer <token> and get the matching response back.
//
// The server only binds 127.0.0.1 and uses a constant-time token comparison so a
// hostile process on the local machine still cannot trivially shape Codara's
// workspace without knowing the per-launch secret.

// JSON-RPC 2.0 error codes per https://www.jsonrpc.org/specification#error_object.
const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;
// Custom code reserved for "verb exists in the spec but not wired up yet" -
// distinct from ERR_METHOD_NOT_FOUND so clients can branch on
// "implementable today" vs "typo in method name".
const ERR_NOT_IMPLEMENTED = -32004;
// Custom code for "method exists but is disabled in this build" (the app.*
// dev-tools gate). Not ERR_INVALID_REQUEST - the envelope is well-formed -
// so clients can branch without string-matching the message.
const ERR_FORBIDDEN = -32003;
// Custom code for "terminal.create's PTY failed to come online" (usually a bad
// cwd). Server-defined (-32000 range) so a client can branch on "the shell
// didn't start" distinctly from a malformed request.
const ERR_TERMINAL_SPAWN = -32000;

const MAX_REQUEST_BYTES = 64 * 1024;
const TERMINAL_READ_MAX_BYTES = 32 * 1024;
const TERMINAL_READ_DEFAULT_LINES = 200;
const TERMINAL_READ_MAX_LINES = 2000;
// How long terminal.create waits for the renderer-spawned PTY to come online
// before returning, so the paneId it hands back is immediately writable.
const TERMINAL_SPAWN_WAIT_MS = 10_000;
// Grace after the PTY comes online before terminal.create trusts it - long
// enough for a bad-cwd shell to have exited (chdir failure is near-instant),
// short enough not to add noticeable latency to a healthy create.
const TERMINAL_SPAWN_SETTLE_MS = 750;
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

// Same lazy-load trick for the scheduler - the Automation-mode architect's
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
 * mints a fresh per-process token. Idempotent - repeated calls return the
 * existing handle.
 */
export async function startAgentSocket(): Promise<ServerHandle> {
  if (currentHandle) return currentHandle;

  const token = randomBytes(32).toString("hex");
  const server = createServer((req, res) => {
    handleRequest(req, res, token).catch((err) => {
      // handleRequest only rejects on unexpected errors - log so we can see
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
  setAgentSocketCapabilityEndpoint(url);
  pty.setAgentSocketEnv({ url, token });
  // Persist a handshake file so MCP servers spawned by external runtimes
  // (Claude Code, Codex) - which do not inherit Codara's pty env - can pick
  // up the current URL + token. Best-effort: a failed write only means the
  // codara-studio MCP server has to back off and retry.
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
  setAgentSocketCapabilityEndpoint(null);
  pty.setAgentSocketEnv(null);
  // Remove the handshake file so any MCP server child that survived Codara's
  // shutdown returns "Codara offline" on next call instead of speaking to a
  // closed port.
  await fsp.rm(handshakeFilePath(), { force: true }).catch(() => undefined);
  await new Promise<void>((resolve) => {
    handle.server.close(() => resolve());
    // close() waits for all open connections - force the issue so quit
    // doesn't hang behind a long-poll from a stuck sub-agent.
    handle.server.closeAllConnections?.();
  });
}

function handshakeFilePath(): string {
  return join(codaraHome(), HANDSHAKE_FILE);
}

async function writeHandshakeFile(input: { url: string; token: string }): Promise<void> {
  const payload = JSON.stringify({
    url: input.url,
    token: input.token,
    pid: process.pid,
    writtenAt: new Date().toISOString(),
  }, null, 2);
  await writeFileAtomic(handshakeFilePath(), payload, { mode: 0o600 });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, expectedToken: string): Promise<void> {
  // Method/path gate before any work - we only speak POST /rpc.
  if (req.method !== "POST" || req.url !== "/rpc") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const auth = authenticateRequest(req, expectedToken);
  if (!auth) {
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
  // initial set of verbs - keep the surface small until a real caller asks.
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

  const response = await dispatch(reqObj.method, reqObj.params, id, res, auth);
  writeJsonRpc(res, response);
}

type AgentSocketAuth =
  | { kind: "root" }
  | { kind: "scoped"; claim: AgentSocketCapabilityClaim };

function authenticateRequest(
  req: IncomingMessage,
  expectedToken: string,
): AgentSocketAuth | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return null;
  const presented = match[1].trim();
  const expectedBuf = Buffer.from(expectedToken, "utf8");
  const presentedBuf = Buffer.from(presented, "utf8");
  if (presentedBuf.length === expectedBuf.length) {
    try {
      if (timingSafeEqual(presentedBuf, expectedBuf)) {
        return { kind: "root" };
      }
    } catch {
      // Fall through to a scoped-token lookup.
    }
  }
  const claim = authorizeAgentSocketCapability(presented);
  return claim ? { kind: "scoped", claim } : null;
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

// Orchestrator RPCs that mutate the run. While auto-compaction is summarizing
// a run's conversation (run-store's isRunMidAutoCompaction window), these are
// rejected: the summarize turn runs against the live manager session with its
// MCP tools attached, and only a prompt instruction stops the model from
// calling them - a stray codara_spawn_workers / codara_complete / codara_ask_user
// mid-compaction would mutate a run whose conversation is about to cut over.
// Read-only methods (get_worker_status, wait_for_workers, check_messages,
// whiteboard_get, board_get) and codara_remember (writes memory files, not run
// state) stay available. spawn_terminals is absent because it carries no runId
// and opens desktop terminals via the terminal bridge without touching RunState.
// The automation.* mutators join them for the same reason, now that an ordinary
// auto/execute chat carries the automation roster: creating, editing, firing, or
// deleting a loom mid-compaction would mutate durable scheduler state (and the
// consent gate would post a blocking question) against a conversation that is
// about to cut over. The read-only verbs (list/get/wait) stay available.
const MID_COMPACTION_BLOCKED_METHODS = new Set<string>([
  "orchestrator.spawn_workers",
  "orchestrator.ask_user",
  "orchestrator.complete",
  "orchestrator.request_next_iteration",
  "orchestrator.message_workers",
  "orchestrator.name_chat",
  "orchestrator.whiteboard_update",
  "orchestrator.board_update",
  "automation.create",
  "automation.update",
  "automation.run_now",
  "automation.set_enabled",
  "automation.pause",
  "automation.resume",
  "automation.stop",
  "automation.delete",
  "automation.name_chat",
]);

// The in-process Pi extension and MCP roster both hide these capabilities for
// imported PR runs. Enforce the same boundary at the authenticated socket so a
// stale extension, hand-crafted request, or future roster regression cannot
// turn adversarial repository content into terminal execution, durable memory,
// or an automation that later runs with trusted policy.
const UNTRUSTED_PULL_REQUEST_BLOCKED_METHODS = new Set<string>([
  "terminal.read",
  "terminal.create",
  "terminal.write",
  "terminal.close",
  "orchestrator.spawn_terminals",
  "orchestrator.remember",
]);

function isUntrustedPullRequestBlockedMethod(method: string): boolean {
  return UNTRUSTED_PULL_REQUEST_BLOCKED_METHODS.has(method) || method.startsWith("automation.");
}

async function dispatch(
  method: string,
  rawParams: unknown,
  id: JsonRpcId,
  res: ServerResponse,
  auth: AgentSocketAuth,
): Promise<JsonRpcResponse> {
  const params =
    rawParams && typeof rawParams === "object"
      ? { ...(rawParams as Record<string, unknown>) }
      : {};

  try {
    if (auth.kind === "scoped") {
      if (!auth.claim.allowedMethods.includes(method)) {
        return errorResponse(
          id,
          ERR_FORBIDDEN,
          "this capability is unavailable to the calling agent process",
        );
      }
      // The claim, never model-authored JSON, owns run routing. This closes the
      // global-bearer substitution hole where an imported-PR process could
      // otherwise name a trusted sibling run in an allowed method.
      params.runId = auth.claim.runId;
    }
    if (isUntrustedPullRequestBlockedMethod(method)) {
      const runId = stringParam(params, "runId");
      if (runId) {
        const run = await (await getRunStore()).getRun(runId);
        if (run && runProjectPolicyMode(run) === "untrusted-pull-request") {
          return errorResponse(
            id,
            ERR_FORBIDDEN,
            "this capability is unavailable for an imported pull-request run",
          );
        }
      }
    }
    if (MID_COMPACTION_BLOCKED_METHODS.has(method)) {
      const runId = stringParam(params, "runId");
      if (runId && (await getRunStore()).isRunMidAutoCompaction(runId)) {
        return errorResponse(
          id,
          ERR_INVALID_PARAMS,
          "conversation compaction is in progress for this run; retry shortly",
        );
      }
    }
    switch (method) {
      case "terminal.read":
        return await handleTerminalRead(params, id);
      case "terminal.create":
        return await handleTerminalCreate(params, id);
      case "terminal.write":
        return await handleTerminalWrite(params, id);
      case "terminal.close":
        return await handleTerminalClose(params, id);
      case "chat.append":
        return await handleChatAppend(params, id);
      case "chat.create":
        return await handleChatCreate(params, id);
      case "chat.send":
        return await handleChatSend(params, id);
      case "chat.wait":
        return await handleChatWait(params, id, res);
      case "chat.events":
        return await handleChatEvents(params, id, res);
      case "chat.cancel":
        return await handleChatCancel(params, id);
      case "chat.resume":
        if (auth.kind !== "root") {
          return errorResponse(
            id,
            ERR_FORBIDDEN,
            "manager turn recovery is available only to the user-owned Cora CLI",
          );
        }
        return await handleChatResume(params, id);
      case "accounts.list":
        return await handleAccountsList(id);
      case "app.info":
        return handleAppInfo(id);
      case "app.screenshot":
        return await handleAppScreenshot(params, id);
      case "app.evaluate":
        return await handleAppEvaluate(params, id);
      case "app.notify":
        return await handleAppNotify(params, id);
      case "app.prefs.get":
        return await handleAppPrefsGet(params, id);
      case "app.prefs.set":
        return await handleAppPrefsSet(params, id);
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
      case "orchestrator.spawn_terminals":
        return handleOrchestratorSpawnTerminals(params, id);
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
      case "orchestrator.message_workers":
        return await handleOrchestratorMessageWorkers(params, id);
      case "orchestrator.check_messages":
        return await handleOrchestratorCheckMessages(params, id);
      case "orchestrator.name_chat":
        return await handleOrchestratorNameChat(params, id);
      case "orchestrator.whiteboard_get":
        return await handleOrchestratorWhiteboardGet(params, id);
      case "orchestrator.whiteboard_update":
        return await handleOrchestratorWhiteboardUpdate(params, id);
      case "orchestrator.board_get":
        return await handleOrchestratorBoardGet(params, id);
      case "orchestrator.board_update":
        return await handleOrchestratorBoardUpdate(params, id);
      case "orchestrator.remember":
        return await handleOrchestratorRemember(params, id);
      case "automation.list":
        return await handleAutomationList(params, id);
      case "automation.get":
        return await handleAutomationGet(params, id);
      case "automation.create":
        return await handleAutomationCreate(params, id);
      case "automation.update":
        // res threads through so the server-side consent gate can long-poll for
        // the user's Allow/Deny and abort cleanly if the MCP client hangs up.
        return await handleAutomationUpdate(params, id, res);
      case "automation.run_now":
        return await handleAutomationRunNow(params, id);
      case "automation.wait":
        return await handleAutomationWait(params, id, res);
      case "automation.set_enabled":
        return await handleAutomationSetEnabled(params, id, res);
      case "automation.pause":
        return await handleAutomationPause(params, id);
      case "automation.resume":
        return await handleAutomationResume(params, id);
      case "automation.stop":
        return await handleAutomationStop(params, id);
      case "automation.delete":
        // res threads through for the same consent gate as update (deletes are
        // destructive and require explicit user approval).
        return await handleAutomationDelete(params, id, res);
      case "automation.name_chat":
        return await handleAutomationNameChat(params, id);
      case "pane.split":
        // Splitting a pane in an EXISTING tab still needs active-tab/active-pane
        // selection semantics we haven't designed yet. terminal.create (above)
        // now covers the "give the agent its own terminal" case via the
        // terminal-bridge roundtrip; pane.split stays a structured stub so a
        // sub-agent can branch cleanly on "verb spec'd but not yet implemented".
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

  // Decode raw bytes as UTF-8 (lossy on partial code points at the head -
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

// Create a new terminal tab on the user's behalf. Tab/pane state is owned by
// the renderer, so we round-trip through the terminal-bridge; the renderer
// mints an agent-tinted, UNFOCUSED tab and returns the tabId + paneId (the PTY
// session id the agent then drives via terminal.write / terminal.read).
async function handleTerminalCreate(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const cwd = stringParam(params, "cwd");
  const command = stringParam(params, "command");
  const title = stringParam(params, "title");
  const rawRetention = params.retention;
  if (
    rawRetention !== undefined &&
    rawRetention !== "temporary" &&
    rawRetention !== "service"
  ) {
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      "retention must be temporary or service",
    );
  }
  // The MCP server stamps SPARK_RUN_ID onto terminal.create so a background
  // run's terminal lands in - and defaults its cwd to - the RUN's workspace,
  // not whichever workspace the user happens to be viewing. A run-owned pane
  // must have a live owner: accepting a stale/missing/settled run here would
  // create it after that run's one-shot cleanup snapshot and leak it forever.
  // Null ownership remains the user-facing/manual-agent path.
  const runId = stringParam(params, "runId");
  let workspaceId: string | null = null;
  let workspaceCwd: string | null = null;
  if (runId) {
    let run: RunState | null;
    try {
      run = await (await getRunStore()).getRun(runId);
    } catch (error) {
      return errorResponse(
        id,
        ERR_INTERNAL,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!run) {
      return errorResponse(id, ERR_INVALID_PARAMS, "terminal owner run was not found");
    }
    if (
      run.status === "complete" ||
      run.status === "failed" ||
      run.status === "cancelled" ||
      !canRegisterAgentTerminal(runId)
    ) {
      return errorResponse(
        id,
        ERR_INVALID_PARAMS,
        "terminal owner run is no longer accepting new auxiliary terminals",
      );
    }
    workspaceId = run.workspaceId ?? null;
    workspaceCwd =
      typeof run.settingsSnapshot?.workspaceCwd === "string"
        ? run.settingsSnapshot.workspaceCwd
        : null;
    if (workspaceId && !workspaceCwd) {
      try {
        const state = await loadState();
        workspaceCwd = state.workspaces.find((w) => w.id === workspaceId)?.cwd ?? null;
      } catch {
        /* the run's snapshotted cwd remains the preferred source */
      }
    }
  }
  try {
    const result = await requestTerminalOp<{ tabId: string; paneId: string; cwd: string }>(
      "create",
      {
        ...(cwd ? { cwd } : {}),
        ...(command ? { command } : {}),
        ...(title ? { title } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceCwd ? { workspaceCwd } : {}),
      },
    );
    // The renderer resolves as soon as the tab is added to state, but the PTY
    // spawns a beat later when TerminalPane mounts and calls pty:spawn. Wait for
    // the session to come online so the returned paneId is immediately usable by
    // terminal.write / terminal.read (otherwise a create→write burst races the
    // spawn and fails with "unknown pane").
    let alive = result?.paneId
      ? await pty.waitForSpawn(result.paneId, TERMINAL_SPAWN_WAIT_MS)
      : false;
    // A bad cwd (or unusable shell) doesn't always fail the spawn outright: the
    // session can register and then the shell exits within a few ms when it
    // can't chdir, so waitForSpawn returns true for a pane that's already dead.
    // Re-check after a short settle so "started then immediately died" is caught
    // too. A healthy shell stays alive well past this window even when a startup
    // `command` runs (the command executes IN the shell; the shell persists).
    if (alive && result?.paneId) {
      await new Promise((resolve) => setTimeout(resolve, TERMINAL_SPAWN_SETTLE_MS));
      alive = pty.exists(result.paneId);
    }
    if (!alive) {
      // The PTY never came online, or came online and immediately exited -
      // almost always a nonexistent/permission-denied cwd. Don't report success
      // with a dead paneId, and don't leave the orphan amber tab behind: ask the
      // renderer to close the tab we just created, then surface a clear error.
      if (result?.tabId) {
        try {
          await requestTerminalOp("destroy", { tabId: result.tabId });
        } catch {
          /* best-effort cleanup; still return the error below */
        }
      }
      return errorResponse(
        id,
        ERR_TERMINAL_SPAWN,
        "terminal failed to start (check that cwd exists and is accessible)",
      );
    }
    // Record both process-level agent ownership (terminal.write) and run
    // ownership (terminal.close). The MCP server injects runId from the
    // caller's SPARK_RUN_ID; a user-facing studio agent has no run and owns a
    // null-scoped terminal.
    const registration: AgentTerminalRegistration = {
      paneId: result.paneId,
      tabId: result.tabId,
      runId,
      retention: rawRetention === "service" ? "service" : "temporary",
    };
    if (!registerAgentTerminal(registration)) {
      // The run settled/deleted while its renderer tab was spawning. The
      // synchronous lifecycle fence closes this check/register race. Adopt the
      // pane into a forced-fresh cleanup pass so a renderer timeout remains
      // retryable instead of orphaning an untracked visual tab.
      if (runId) {
        quarantineLateAgentTerminal({
          ...registration,
          runId,
        });
      }
      return errorResponse(
        id,
        ERR_INVALID_PARAMS,
        "terminal owner run settled while the terminal was starting",
      );
    }
    const offExit = pty.onExit(result.paneId, () => {
      offExit();
      // A naturally completed one-shot command should no longer count as a
      // writable/live agent terminal. Retain only bounded ownership metadata
      // so terminal.close can still remove its dead renderer tab later.
      agentTerminals.markExited(registration);
    });
    // onExit only observes future exits. Cover the narrow gap between the
    // alive settle check above and listener registration without closing the
    // renderer tab or otherwise changing the existing dead-pane UI.
    if (!pty.exists(result.paneId)) {
      offExit();
      agentTerminals.markExited(registration);
    }
    return successResponse(id, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(id, ERR_INTERNAL, message);
  }
}

// Deliver text to a terminal pane's PTY. paneId is the pty session id, so this
// writes straight to node-pty in main (no renderer round-trip) via the same
// bracketed-paste inject path user input, drag-drop, and slash commands use.
async function handleTerminalWrite(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const paneId = stringParam(params, "paneId");
  if (!paneId) return errorResponse(id, ERR_INVALID_PARAMS, "paneId is required");
  const runId = stringParam(params, "runId");
  // text may legitimately be "" (submit a bare newline), so accept any string
  // rather than going through stringParam (which rejects empty).
  const text = params.text;
  if (typeof text !== "string") return errorResponse(id, ERR_INVALID_PARAMS, "text is required");
  // Ownership gate: writing INJECTS keystrokes (and, by default, Enter) into a
  // live PTY. terminal.read intentionally lets an agent sample sibling worker
  // panes, so their paneIds are discoverable. The bridge stamps SPARK_RUN_ID
  // onto writes; require the same run that created this terminal so one Cora
  // run cannot type into another run's agent-owned shell.
  if (!agentTerminals.isActiveOwnedBy(paneId, runId)) {
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      "terminal.write is only permitted on active panes owned by this Cora run",
    );
  }
  if (!pty.exists(paneId)) return errorResponse(id, ERR_INVALID_PARAMS, `unknown pane: ${paneId}`);
  const submit = typeof params.submit === "boolean" ? params.submit : true;
  pty.inject(paneId, text, { submit });
  return successResponse(id, { ok: true });
}

// Stop an auxiliary terminal created through terminal.create and remove its
// renderer-owned tab. Ownership is run-scoped: one Cora run cannot close a
// sibling run's watcher/dev server even though both share the app-local socket
// token. Successful closes leave a bounded tombstone, so a client that lost
// the first JSON-RPC response can retry and receive alreadyClosed=true.
async function handleTerminalClose(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const paneId = stringParam(params, "paneId");
  if (!paneId) return errorResponse(id, ERR_INVALID_PARAMS, "paneId is required");
  const runId = stringParam(params, "runId");

  try {
    const result = await agentTerminals.close({
      paneId,
      runId,
      stop: () => pty.killImmediate(paneId),
      destroyTab: (registration) =>
        requestTerminalOp("destroy", {
          tabId: registration.tabId,
          paneId: registration.paneId,
        }),
    });
    return successResponse(id, { ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AgentTerminalOwnershipError) {
      return errorResponse(id, ERR_INVALID_PARAMS, message);
    }
    return errorResponse(id, ERR_INTERNAL, message);
  }
}

async function handlePreviewOp(
  method: string,
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const op = method.replace(/^preview\./, "") as PreviewOpName;
  const previewParams: PreviewOpParams = { ...params };
  try {
    if (op === "navigate" && typeof previewParams.url === "string") {
      const reachable = await waitForLoopbackPreviewServer(previewParams.url);
      if (!reachable) {
        throw new Error(
          `Preview server is not accepting connections at ${previewParams.url}. ` +
          "Start the server (or keep it running) before navigating the Electron preview.",
        );
      }
    }
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

  // chat.append posts on behalf of the sub-agent itself, not the user - record
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

// Pi is the only manager backend; an explicit legacy "claude"/"codex" is
// rejected loudly rather than silently coerced.
const CLI_CHAT_BACKENDS = new Set<ChatBackendKind>(["pi"]);
// Auto is the only chat mode a user-facing chat can be started in. Rejecting an
// old `--mode plan` loudly beats silently coercing it to something else.
const CLI_CHAT_MODES = new Set<ChatMode>(["auto"]);
const CLI_CHAT_EFFORTS = new Set<AgentEffortLevel>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const CLI_WAIT_STOP_STATUSES = new Set<RunState["status"]>([
  "blocked",
  "paused",
  "complete",
  "failed",
  "cancelled",
]);

function enumParam<T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<T>,
): T | null | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !allowed.has(value as T)) return null;
  return value as T;
}

async function canonicalWorkspaceDirectory(rawCwd: string): Promise<string> {
  const requested = resolve(rawCwd);
  let cwd: string;
  try {
    cwd = await fsp.realpath(requested);
  } catch {
    throw new Error(`Workspace directory does not exist: ${requested}`);
  }
  const stat = await fsp.stat(cwd).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Workspace path is not a directory: ${cwd}`);
  return cwd;
}

async function workspacePathMatches(candidate: string, cwd: string): Promise<boolean> {
  try {
    return (await fsp.realpath(resolve(candidate))) === cwd;
  } catch {
    return resolve(candidate) === cwd;
  }
}

function broadcastStateChanged(state: AppState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    const wc = window.webContents;
    if (wc.isDestroyed()) continue;
    try {
      wc.send("state:changed", state);
    } catch {
      /* A window may disappear between enumeration and send. */
    }
  }
}

async function ensureCliWorkspace(
  rawCwd: string,
  requestedName?: string,
): Promise<{ workspace: Workspace; created: boolean }> {
  const cwd = await canonicalWorkspaceDirectory(rawCwd);
  const state = await loadState();
  for (const workspace of state.workspaces) {
    if (await workspacePathMatches(workspace.cwd, cwd)) {
      return { workspace, created: false };
    }
  }

  const workspace: Workspace = {
    id: `ws-cli-${randomBytes(8).toString("hex")}`,
    name: requestedName?.trim() || basename(cwd) || "workspace",
    cwd,
    color: "#2AA298",
    workers: [],
  };
  const next: AppState = {
    workspaces: [...state.workspaces, workspace],
    workspaceGroups: state.workspaceGroups,
    workspaceRailOrder: [...(state.workspaceRailOrder ?? []), workspace.id],
    activeWorkspaceId: state.activeWorkspaceId ?? workspace.id,
  };
  await saveState(next);
  setAllowedRoots(next.workspaces.map((item) => item.cwd));
  broadcastStateChanged(next);
  return { workspace, created: true };
}

async function activateCliWorkspace(workspaceId: string): Promise<void> {
  const state = await loadState();
  if (state.activeWorkspaceId === workspaceId) return;
  const next: AppState = { ...state, activeWorkspaceId: workspaceId };
  await saveState(next);
  broadcastStateChanged(next);
}

async function resolveCliRun(runIdOrPrefix: string): Promise<RunState | null> {
  const runStore = await getRunStore();
  const exact = await runStore.getRun(runIdOrPrefix);
  if (exact) return exact;
  const matches = (await runStore.listRuns()).filter((run) => run.id.startsWith(runIdOrPrefix));
  return matches.length === 1 ? matches[0] : null;
}

// Public headless Cora lifecycle used by cli/cora.cjs. Unlike orchestrator.*,
// these methods represent the human at the top of a chat: create starts a real
// managed run, send appends a user turn (or answers the current question), and
// wait blocks without consuming manager tokens until the run needs attention.
async function handleChatCreate(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const rawCwd = stringParam(params, "cwd");
  if (!rawCwd) return errorResponse(id, ERR_INVALID_PARAMS, "cwd is required");
  const rawPrompt = stringParam(params, "prompt");
  if (!rawPrompt) return errorResponse(id, ERR_INVALID_PARAMS, "prompt is required");

  const backend = enumParam(params, "backend", CLI_CHAT_BACKENDS);
  if (backend === null) {
    return errorResponse(id, ERR_INVALID_PARAMS, "backend must be claude, codex, or pi");
  }
  const mode = enumParam(params, "mode", CLI_CHAT_MODES);
  if (mode === null) {
    return errorResponse(id, ERR_INVALID_PARAMS, "mode must be auto");
  }
  const effort = enumParam(params, "effort", CLI_CHAT_EFFORTS);
  if (effort === null) {
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      "effort must be minimal, low, medium, high, xhigh, or max",
    );
  }
  let binding: { workspace: Workspace; created: boolean };
  try {
    binding = await ensureCliWorkspace(rawCwd, stringParam(params, "workspaceName") ?? undefined);
  } catch (err) {
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Visible Claude/Codex worker panes are owned by the renderer workspace
  // store. A run left in a background workspace can create task envelopes, but
  // the renderer correctly refuses to put their PTYs in the currently active
  // project's tab store, so activate the workspace for any mode that can spawn
  // workers.
  if (effectiveChatMode(mode) === "auto") {
    await activateCliWorkspace(binding.workspace.id);
  }

  const prompt = rawPrompt.slice(0, CHAT_APPEND_MAX_CHARS);
  const title = stringParam(params, "title")?.trim();
  const model = stringParam(params, "model")?.trim();
  const runStore = await getRunStore();
  try {
    let runId: string | undefined;
    if (title) {
      const seeded = await runStore.createRun({
        workspaceId: binding.workspace.id,
        workspaceName: binding.workspace.name,
        cwd: binding.workspace.cwd,
        title,
        chatBackend: backend,
        chatModel: model,
        chatMode: mode,
        chatEffort: effort,
      });
      runId = seeded.id;
    }
    const run = await runStore.startAutopilot({
      runId,
      workspaceId: binding.workspace.id,
      workspaceName: binding.workspace.name,
      cwd: binding.workspace.cwd,
      initialUserNote: prompt,
      initialUserNoteClientMessageId: `cli-${randomBytes(8).toString("hex")}`,
      chatBackend: backend,
      chatModel: model,
      chatMode: mode,
      chatEffort: effort,
    });
    return successResponse(id, {
      run,
      workspace: binding.workspace,
      workspaceCreated: binding.created,
      truncated: prompt.length < rawPrompt.length,
    });
  } catch (err) {
    return errorResponse(id, ERR_INTERNAL, err instanceof Error ? err.message : String(err));
  }
}

async function handleAccountsList(id: JsonRpcId): Promise<JsonRpcResponse> {
  try {
    const [
      { inspectPiAccountProfileAuthStore },
      { inspectCachedPiSubscriptionUsageProfiles },
      { projectRemoteSubscriptionProfiles },
    ] = await Promise.all([
      import("./orchestration/pi-account-auth-store"),
      import("./orchestration/pi-subscription-usage"),
      import("./remote-access/subscription-profile-projection"),
    ]);
    const inspection = await inspectPiAccountProfileAuthStore();
    const cachedUsage = inspectCachedPiSubscriptionUsageProfiles();
    const projected = projectRemoteSubscriptionProfiles(inspection, cachedUsage);
    const windowsByProfile = new Map(
      cachedUsage.map((usage) => [
        usage.profileId,
        (usage.windows ?? []).map((window) => ({
          label: window.label,
          remainingPercent: window.remainingPercent,
          resetsIn: window.resetsIn ?? null,
        })),
      ]),
    );
    return successResponse(id, {
      accounts: projected.map((profile) => ({
        id: profile.id,
        provider: profile.provider,
        label: profile.label,
        status: profile.status,
        isDefault: profile.isDefault,
        remainingPercent: profile.usage?.remainingPercent ?? null,
        // Every quota clock the provider reported (Anthropic has three:
        // 5-hour, 7-day, and the Fable-specific 7-day), so clients can show
        // more than the collapsed number above.
        windows: windowsByProfile.get(profile.id) ?? [],
      })),
    });
  } catch (err) {
    return errorResponse(id, ERR_INTERNAL, err instanceof Error ? err.message : String(err));
  }
}

async function handleChatSend(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const runIdOrPrefix = stringParam(params, "runId");
  if (!runIdOrPrefix) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  const rawContent = stringParam(params, "content");
  if (!rawContent) return errorResponse(id, ERR_INVALID_PARAMS, "content is required");
  const run = await resolveCliRun(runIdOrPrefix);
  if (!run) return errorResponse(id, ERR_INVALID_PARAMS, `Run not found or prefix is ambiguous: ${runIdOrPrefix}`);

  const content = rawContent.slice(0, CHAT_APPEND_MAX_CHARS);
  const runStore = await getRunStore();
  try {
    const questionMessageId = run.blockedOn?.questionMessageId;
    const updated = questionMessageId
      ? await runStore.answerRunQuestion({
          runId: run.id,
          questionMessageId,
          clientMessageId: `cli-${randomBytes(8).toString("hex")}`,
          message: content,
        })
      : await runStore.addRunMessage({
          runId: run.id,
          clientMessageId: `cli-${randomBytes(8).toString("hex")}`,
          author: "user",
          kind: "note",
          message: content,
        });
    return successResponse(id, {
      run: updated,
      answeredQuestion: Boolean(questionMessageId),
      truncated: content.length < rawContent.length,
    });
  } catch (err) {
    return errorResponse(id, ERR_INTERNAL, err instanceof Error ? err.message : String(err));
  }
}

async function handleChatWait(
  params: Record<string, unknown>,
  id: JsonRpcId,
  res: ServerResponse,
): Promise<JsonRpcResponse> {
  const runIdOrPrefix = stringParam(params, "runId");
  if (!runIdOrPrefix) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  const requestedTimeout = optionalNumberParam(params, "timeoutMs");
  const timeoutMs = Math.max(0, Math.min(requestedTimeout ?? 20 * 60_000, 60 * 60_000));
  const deadline = Date.now() + timeoutMs;
  let run = await resolveCliRun(runIdOrPrefix);
  if (!run) return errorResponse(id, ERR_INVALID_PARAMS, `Run not found or prefix is ambiguous: ${runIdOrPrefix}`);

  while (!CLI_WAIT_STOP_STATUSES.has(run.status) && Date.now() < deadline) {
    if (res.destroyed) {
      return errorResponse(id, ERR_INTERNAL, "client disconnected while waiting");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    const fresh = await (await getRunStore()).getRun(run.id);
    if (!fresh) return errorResponse(id, ERR_INVALID_PARAMS, `Run disappeared while waiting: ${run.id}`);
    run = fresh;
  }
  return successResponse(id, {
    run,
    timedOut: !CLI_WAIT_STOP_STATUSES.has(run.status),
    needsAttention: run.status === "blocked" || run.status === "paused",
  });
}

// Cap on events per chat.events response. A large backlog pages: the response
// carries hasMore=true so the client re-polls with the advanced cursor and
// drains the remainder before honoring a terminal status.
const CHAT_EVENTS_MAX_BATCH = 500;
const CHAT_EVENTS_DEFAULT_WAIT_MS = 25_000;
// Kept under a minute so the long poll returns well before any socket idle
// policy could sever it mid-response; the client simply re-polls.
const CHAT_EVENTS_MAX_WAIT_MS = 55_000;

// Cursor-based long-poll over a run's event journal - the CLI's substitute for
// the renderer's live push channel (mirrors daemon-host's subscribeDaemonEvents
// seam, but over the wire). Without afterSequence it answers immediately with
// the current cursor ("follow from now" bootstrap); with one it returns journal
// events past the cursor, long-polling up to waitMs when already caught up.
// Streams everything the journal carries: chat.assistant_block deltas,
// chat.tool_use/tool_result, step.* transitions, worker_attempt.* status.
async function handleChatEvents(
  params: Record<string, unknown>,
  id: JsonRpcId,
  res: ServerResponse,
): Promise<JsonRpcResponse> {
  const runIdOrPrefix = stringParam(params, "runId");
  if (!runIdOrPrefix) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  const run = await resolveCliRun(runIdOrPrefix);
  if (!run) {
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      `Run not found or prefix is ambiguous: ${runIdOrPrefix}`,
    );
  }
  const afterSequence = optionalNumberParam(params, "afterSequence");
  const waitMs = Math.max(
    0,
    Math.min(
      optionalNumberParam(params, "waitMs") ?? CHAT_EVENTS_DEFAULT_WAIT_MS,
      CHAT_EVENTS_MAX_WAIT_MS,
    ),
  );

  // Subscribe before reading the journal so an event landing between the read
  // and the wait loop arrives via the live feed instead of being lost until
  // the client's next poll.
  const live: SparkEvent[] = [];
  const unsubscribe = subscribeToEvents((event) => {
    if (event.runId === run.id) live.push(event);
  });
  try {
    const journal = await listEvents(run.id);
    const highWater = journal.reduce((max, event) => Math.max(max, event.sequence ?? 0), 0);
    if (afterSequence === null) {
      return successResponse(id, { runId: run.id, cursor: highWater, events: [], status: run.status });
    }

    const events = journal.filter((event) => (event.sequence ?? 0) > afterSequence);
    if (events.length === 0 && waitMs > 0) {
      const deadline = Date.now() + waitMs;
      while (live.length === 0 && Date.now() < deadline && !res.destroyed) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      const seen = new Set(events.map((event) => event.id));
      for (const event of live) {
        if ((event.sequence ?? 0) > afterSequence && !seen.has(event.id)) events.push(event);
      }
      events.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    }

    const batch = events.slice(0, CHAT_EVENTS_MAX_BATCH);
    const cursor = batch.length > 0 ? (batch[batch.length - 1].sequence ?? afterSequence) : afterSequence;
    const fresh = await (await getRunStore()).getRun(run.id);
    return successResponse(id, {
      runId: run.id,
      cursor,
      events: batch,
      // Truncation signal: the journal held more events past the cursor than
      // this batch carries. Clients must keep draining before treating a
      // terminal status as the end of the stream, or the transcript tail is
      // silently dropped.
      hasMore: events.length > batch.length,
      status: (fresh ?? run).status,
    });
  } finally {
    unsubscribe();
  }
}

async function handleChatCancel(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const runIdOrPrefix = stringParam(params, "runId");
  if (!runIdOrPrefix) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  const run = await resolveCliRun(runIdOrPrefix);
  if (!run) {
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      `Run not found or prefix is ambiguous: ${runIdOrPrefix}`,
    );
  }
  const reason = stringParam(params, "reason")?.slice(0, CHAT_APPEND_MAX_CHARS);
  try {
    const updated = await (await getRunStore()).cancelRun({ runId: run.id, reason });
    return successResponse(id, { run: updated });
  } catch (err) {
    return errorResponse(id, ERR_INTERNAL, err instanceof Error ? err.message : String(err));
  }
}

type PublicManagerTurnResumeOutcome =
  | "accepted"
  | "already-resuming"
  | "stale"
  | "account-unavailable"
  | "account-incompatible";

const CHAT_RESUME_REASON_MAX_CHARS = 320;

function publicManagerTurnResumeReason(
  outcome: PublicManagerTurnResumeOutcome,
  context?: "automation" | "missing-recovery",
): string | undefined {
  const reason =
    context === "automation"
      ? "Automation runs do not have resumable Cora manager turns."
      : context === "missing-recovery"
        ? "No current parked Cora manager turn is available to resume."
        : outcome === "stale"
          ? "The parked Cora manager turn is no longer resumable."
          : outcome === "account-unavailable"
            ? "The selected subscription account is unavailable or needs to be reconnected."
            : outcome === "account-incompatible"
              ? "The selected subscription account is incompatible with this manager turn."
              : undefined;
  return reason
    ? stripVTControlCharacters(reason).replace(/[\r\n\t]+/g, " ").slice(0, CHAT_RESUME_REASON_MAX_CHARS)
    : undefined;
}

/**
 * User-owned recovery for the exact durable manager turn currently parked on
 * a Cora conversation. Account selection is intentionally passed into the
 * same run-store claim; changing the account in a preceding mutation would
 * leave the conversation switched even if another caller won the recovery.
 */
async function handleChatResume(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const runIdOrPrefix = stringParam(params, "runId");
  if (!runIdOrPrefix) {
    return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  }

  let profileId: string | undefined;
  try {
    profileId = normalizePiAccountProfileId(
      stringParam(params, "profileId"),
      "profileId",
    );
  } catch (err) {
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      err instanceof Error ? err.message : String(err),
    );
  }

  const run = await resolveCliRun(runIdOrPrefix);
  if (!run) {
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      `Run not found or prefix is ambiguous: ${runIdOrPrefix}`,
    );
  }

  if (run.automationId || run.chatMode === "automation") {
    const outcome: PublicManagerTurnResumeOutcome = "stale";
    return successResponse(id, {
      runId: run.id,
      recoveryId: null,
      outcome,
      reason: publicManagerTurnResumeReason(outcome, "automation"),
    });
  }

  const recovery = run.managerTurnRecovery;
  if (!recovery) {
    const outcome: PublicManagerTurnResumeOutcome = "stale";
    return successResponse(id, {
      runId: run.id,
      recoveryId: null,
      outcome,
      reason: publicManagerTurnResumeReason(outcome, "missing-recovery"),
    });
  }

  try {
    const result = await (await getRunStore()).resumeManagerTurnRecovery({
      runId: run.id,
      recoveryId: recovery.id,
      ...(profileId
        ? { account: { kind: "subscription" as const, profileId } }
        : {}),
    });
    const reason = publicManagerTurnResumeReason(result.outcome);
    return successResponse(id, {
      runId: result.run.id,
      recoveryId: recovery.id,
      outcome: result.outcome,
      ...(reason ? { reason } : {}),
    });
  } catch {
    return errorResponse(
      id,
      ERR_INTERNAL,
      "Could not claim the parked Cora manager turn.",
    );
  }
}

// ── app.* - dev/test surface for the `cora` CLI (cli/cora.cjs) ──────────────
//
// These drive the APP ITSELF (main window pixels, renderer JS, preferences,
// the notify pipeline) rather than a preview tab, so a feature can be
// exercised and observed from a terminal without a Playwright harness.
// Everything except app.info is dev-gated: always available in unpackaged
// builds (npm run dev / npm start), and in packaged builds only when
// CODARA_DEV_TOOLS=1 - a shipped app's socket must not let another local
// process screenshot the user's terminals or rewrite their preferences.

function devToolsEnabled(): boolean {
  return !app.isPackaged || process.env.CODARA_DEV_TOOLS === "1";
}

function requireDevTools(id: JsonRpcId): JsonRpcResponse | null {
  if (devToolsEnabled()) return null;
  return errorResponse(
    id,
    ERR_FORBIDDEN,
    "app.* dev tools are disabled in packaged builds (launch with CODARA_DEV_TOOLS=1 to enable)",
  );
}

function pickAppWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.webContents.isDestroyed()) return focused;
  return BrowserWindow.getAllWindows().find((w) => !w.webContents.isDestroyed()) ?? null;
}

function handleAppInfo(id: JsonRpcId): JsonRpcResponse {
  return successResponse(id, {
    name: app.getName(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    devTools: devToolsEnabled(),
    pid: process.pid,
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    homeDir: codaraHome(),
    uptimeSec: Math.round(process.uptime()),
    windows: BrowserWindow.getAllWindows()
      .filter((w) => !w.webContents.isDestroyed())
      .map((w) => ({ id: w.id, title: w.getTitle(), focused: w.isFocused(), bounds: w.getBounds() })),
  });
}

async function handleAppScreenshot(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const gated = requireDevTools(id);
  if (gated) return gated;
  const win = pickAppWindow();
  if (!win) return errorResponse(id, ERR_INTERNAL, "no live app window to capture");
  const image = await win.webContents.capturePage();
  const { width, height } = image.getSize();
  // Same result shape as preview.screenshot so clients share one image path.
  return successResponse(id, {
    width,
    height,
    dataUrl: `data:image/png;base64,${image.toPNG().toString("base64")}`,
  });
}

const APP_EVALUATE_DEFAULT_TIMEOUT_MS = 15_000;
const APP_EVALUATE_MAX_TIMEOUT_MS = 60_000;

async function handleAppEvaluate(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const gated = requireDevTools(id);
  if (gated) return gated;
  const code = stringParam(params, "code");
  if (!code) return errorResponse(id, ERR_INVALID_PARAMS, "code is required");
  const win = pickAppWindow();
  if (!win) return errorResponse(id, ERR_INTERNAL, "no live app window");
  const requested = optionalNumberParam(params, "timeout_ms");
  const timeoutMs =
    requested === null
      ? APP_EVALUATE_DEFAULT_TIMEOUT_MS
      : Math.max(100, Math.min(requested | 0, APP_EVALUATE_MAX_TIMEOUT_MS));
  let timer: NodeJS.Timeout | undefined;
  try {
    // executeJavaScript resolves with structured-clonable values only; DOM
    // nodes/functions reject inside Electron before reaching us. The race
    // guards against user code that never settles (e.g. a pending promise).
    const value = await Promise.race([
      win.webContents.executeJavaScript(code, true),
      new Promise<never>((_, rejectTimeout) => {
        timer = setTimeout(
          () => rejectTimeout(new Error(`app.evaluate timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return successResponse(id, { value: value === undefined ? null : (value as unknown) });
  } finally {
    clearTimeout(timer);
  }
}

const NOTIFY_KINDS: ReadonlySet<string> = new Set<NotifyKind>([
  "run.blocked",
  "run.complete",
  "run.failed",
  "terminal.agent.needs-input",
  "terminal.agent.done",
  "terminal.agent.failed",
  "automation.finished",
  "automation.failed",
  "automation.blocked",
  "app.update-ready",
]);
const NOTIFY_TONES: ReadonlySet<string> = new Set<InAppNotificationTone>([
  "success",
  "warning",
  "danger",
]);
const NOTIFY_SOUNDS: ReadonlySet<string> = new Set<NotificationSoundKind>(["needs-you", "done"]);

async function handleAppNotify(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const gated = requireDevTools(id);
  if (gated) return gated;
  const kind = stringParam(params, "kind") ?? "run.complete";
  if (!NOTIFY_KINDS.has(kind)) {
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      `unknown kind: ${kind} (expected one of ${[...NOTIFY_KINDS].join(", ")})`,
    );
  }
  const defaultTone: InAppNotificationTone = kind.endsWith(".failed")
    ? "danger"
    : kind === "run.blocked" || kind === "terminal.agent.needs-input"
      ? "warning"
      : "success";
  const tone = stringParam(params, "tone") ?? defaultTone;
  if (!NOTIFY_TONES.has(tone)) {
    return errorResponse(id, ERR_INVALID_PARAMS, `unknown tone: ${tone}`);
  }
  const sound = stringParam(params, "sound") ?? (tone === "success" ? "done" : "needs-you");
  if (!NOTIFY_SOUNDS.has(sound)) {
    return errorResponse(id, ERR_INVALID_PARAMS, `unknown sound: ${sound}`);
  }
  // Unique sourceKey per call unless the caller pins one - the policy dedupes
  // repeated same-kind alerts per source, which a "fire a test notification"
  // command must not silently hit. Pass an explicit sourceKey to exercise the
  // dedup/rearm behavior itself.
  const sourceKey =
    stringParam(params, "sourceKey") ??
    `cli:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const workspaceId = stringParam(params, "workspaceId");
  const tabId = stringParam(params, "tabId");
  const paneId = stringParam(params, "paneId");
  const jobId = stringParam(params, "jobId");
  const target =
    workspaceId && tabId && paneId
      ? ({ type: "terminal", workspaceId, tabId, paneId } as const)
      : jobId
        ? ({ type: "automation", jobId, workspaceId: workspaceId ?? undefined } as const)
        : ({ type: "run", runId: stringParam(params, "runId") ?? "cli-test" } as const);
  publish({
    kind: kind as NotifyKind,
    sourceKey,
    title: stringParam(params, "title") ?? "Test notification",
    body: stringParam(params, "body") ?? "Fired via app.notify (cora CLI).",
    tone: tone as InAppNotificationTone,
    soundKind: sound as NotificationSoundKind,
    target,
  });
  return successResponse(id, { published: true, kind, sourceKey });
}

async function handleAppPrefsGet(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const gated = requireDevTools(id);
  if (gated) return gated;
  const key = stringParam(params, "key");
  const prefs = await loadPreferences();
  if (!key) return successResponse(id, { preferences: prefs });
  // hasOwn, not `in`: `in` also passes prototype keys ("toString"), whose
  // "value" would then be a function and blow up response serialization.
  if (!Object.hasOwn(DEFAULT_PREFERENCES, key)) {
    return errorResponse(id, ERR_INVALID_PARAMS, `unknown preference: ${key}`);
  }
  const prefKey = key as PrefKey;
  return successResponse(id, { key, value: prefs[prefKey] ?? DEFAULT_PREFERENCES[prefKey] });
}

async function handleAppPrefsSet(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const gated = requireDevTools(id);
  if (gated) return gated;
  const key = stringParam(params, "key");
  if (!key || !Object.hasOwn(DEFAULT_PREFERENCES, key)) {
    return errorResponse(id, ERR_INVALID_PARAMS, `unknown preference: ${key ?? "(missing)"}`);
  }
  if (!("value" in params)) {
    return errorResponse(id, ERR_INVALID_PARAMS, "value is required");
  }
  const prefKey = key as PrefKey;
  // setPreference runs the same normalize() the settings UI goes through, so
  // out-of-range values are clamped, not stored raw. The broadcast makes the
  // renderer apply it live (glass sliders, theme, notification prefs). The one
  // side effect not replayed here is ipc.ts's tray ensure/destroy hook for
  // keepRunningInBackground - a dev-only gap; the tray catches up on restart.
  const next = await setPreference(prefKey, params.value as AppPreferences[PrefKey]);
  broadcastPreferencesChanged({ key: prefKey, value: next[prefKey] });
  return successResponse(id, { key, value: next[prefKey] });
}

// ── orchestrator.* - Execute-mode tools called by Claude/Codex via the
// codara-studio MCP server (orchestration roster). The CLI is acting as Codara's manager; these
// tools let it spawn Cora workers, ask the user a clarifying question, and
// mark the run complete. Each call carries `runId` (the MCP server forwards
// `process.env.SPARK_RUN_ID` that pty-manager injected at spawn time).
//
// Workers are queued via createWorkerTask + prepareWorkerTask and launched
// end-to-end from this call site through scheduleAutopilotCycles; the manager
// can `await` completion via codara_wait_for_workers.

/**
 * The ceiling every server-side orchestrator long poll must return under.
 *
 * The MCP client aborts every orchestrator.* RPC at its own
 * ORCHESTRATION_TIMEOUT_MS (resources/codara-studio-mcp/server.js), which is
 * this ceiling PLUS a one-minute response margin. A long poll that runs to a
 * deadline at or past the client's deadline does NOT buy the caller more time:
 * the socket dies first, clientGone releases the blocker, and the manager gets
 * a transport error instead of the graceful documented payload. Keep every
 * long-poll bound at or under this number, and keep the two files' numbers in
 * step - scripts/test-orchestration-timeout-margin.cjs asserts they agree.
 */
const ORCHESTRATION_LONG_POLL_CEILING_MS = 20 * 60 * 1000;

const ASK_USER_POLL_MS = 500;
const ASK_USER_TIMEOUT_MS = 15 * 60 * 1000; // 15 min - covers the user being AFK
// A plan approval is read-then-decide: the user reads a whole proposed plan
// before answering, so the manager waits longer than for a one-line blocker.
// Still under ORCHESTRATION_LONG_POLL_CEILING_MS, like ASK_USER_TIMEOUT_MS.
const PLAN_APPROVAL_TIMEOUT_MS = 18 * 60 * 1000;
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
  /** No peer-to-peer mailbox for this worker. See WorkerTask.isolated. */
  isolated?: boolean;
  /** Opt in to the step's worker group chat (default off). See WorkerTask.peers. */
  peers?: boolean;
  /** Accepted worker task whose runtime session this worker should continue.
   *  Gated by evaluateWorkerSessionReuse; falls back to a cold spawn with an
   *  explanatory note when the gate fails. Never valid on a verifier. */
  follow_up_of?: string;
}

// Map a requested model onto its counterpart on the OTHER provider, for a
// cross-provider peer (an independent verifier, usually). The worker roster
// has one standard tier per provider, so the only distinction that can survive
// the hop is premium vs standard, and premium exists on Anthropic alone, so a
// premium Claude worker's Codex peer lands on the frontier model.
function crossProviderPeerModel(
  runtime: "claude" | "codex",
  requestedModel?: string,
): string {
  const model = requestedModel?.trim().toLowerCase() ?? "";
  return rosterModelFor(runtime, /fable/.test(model) ? "premium" : "standard");
}

function runtimeHadEnvironmentalFailure(
  run: RunState,
  runtime: "claude" | "codex",
): boolean {
  return run.workerAttempts.some((attempt) =>
    attempt.runtime === runtime &&
    attempt.status === "failed" &&
    /oauth|auth(?:entication|orization)?|subscription|provider|cli|failed to launch|parseable final-report/i
      .test(attempt.error ?? ""),
  );
}

// Declarative counterpart to orchestrator.spawn_workers. This RPC validates
// and acknowledges the requested standing-terminal groups, but deliberately
// does not mutate the run here. The active Claude/Codex backend records the
// tool call and converts it to a SparkManagerDecision after the turn ends;
// run-store then emits spark.spawn_terminals, and the renderer opens one real
// split-grid terminal tab. Keeping application at the decision boundary avoids
// a tool-side tab plus a second decision-side tab.
function handleOrchestratorSpawnTerminals(
  params: Record<string, unknown>,
  id: JsonRpcId,
): JsonRpcResponse {
  const rawTerminals = params.terminals;
  if (!Array.isArray(rawTerminals) || rawTerminals.length === 0) {
    return errorResponse(id, ERR_INVALID_PARAMS, "terminals array is required and non-empty");
  }

  let terminalCount = 0;
  for (const raw of rawTerminals) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return errorResponse(id, ERR_INVALID_PARAMS, "each terminal entry must be an object");
    }
    const terminal = raw as Record<string, unknown>;
    if (terminal.runtime !== "claude" && terminal.runtime !== "codex") {
      return errorResponse(id, ERR_INVALID_PARAMS, "terminal runtime must be claude or codex");
    }
    if (
      typeof terminal.count !== "number" ||
      !Number.isInteger(terminal.count) ||
      terminal.count < 1 ||
      terminal.count > 8
    ) {
      return errorResponse(id, ERR_INVALID_PARAMS, "terminal count must be an integer from 1 to 8");
    }
    terminalCount += terminal.count;
    if (terminalCount > 8) {
      return errorResponse(id, ERR_INVALID_PARAMS, "at most 8 terminal panes may be opened at once");
    }
  }

  return successResponse(id, {
    ok: true,
    terminal_count: terminalCount,
    message:
      "Standing terminal request accepted. End this turn now; Codara will open the persistent terminal grid.",
  });
}

// ── Verification-round hard cap ─────────────────────────────────────────────
// The manager LLM is the only thing that mints verification steps for
// execute-mode runs, and prose policy alone does not stop a hedging verifier
// from being re-requested forever (run-mrz25z39-9ffs4w chained Build → Verify
// → Reverify → Final verification → DOM regression verifier on a one-file
// task). The cap is enforced here - the spawn chokepoint shared by
// Claude/Codex/Pi managers - as an actual limit, extending the reuse guards
// below which only dedupe.

function normalizeScopePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

// How many verifier tasks already ran (or are live) against the requested
// scope. Overlap is deliberately permissive: an unscoped verifier counts
// against every scope, because manager-spawned verifiers usually target "the
// implementation so far" rather than named files. Only FRESH rounds count:
// a verifier that began before the most recent finished implementation
// attempt examined code that has since changed (same finishedAt >
// verifierBeganAt idiom as the live-verifier reuse guard below), so it must
// not consume the budget for verifying the new work - otherwise turn 1's
// verifier would starve turn 2's first-ever verification in a long-lived
// chat run.
function countVerifierRoundsForScope(
  run: RunState,
  requested: Array<Record<string, unknown>>,
): number {
  const requestedPaths = new Set<string>();
  for (const worker of requested) {
    const raw = [
      ...(Array.isArray(worker.allowedPaths) ? worker.allowedPaths : []),
      ...(Array.isArray(worker.expectedOutputs) ? worker.expectedOutputs : []),
    ];
    for (const path of raw) {
      if (typeof path === "string" && path.trim()) requestedPaths.add(normalizeScopePath(path));
    }
  }
  let rounds = 0;
  for (const task of run.workerTasks) {
    if (task.taskClass !== "verifier" || task.status === "cancelled") continue;
    const verifierBeganAt = Date.parse(task.createdAt);
    const supersededByNewerWork = run.workerAttempts.some((attempt) => {
      const implementation = run.workerTasks.find(
        (candidate) => candidate.id === attempt.workerTaskId && candidate.taskClass !== "verifier",
      );
      const finishedAt = attempt.finishedAt ? Date.parse(attempt.finishedAt) : Number.NaN;
      return Boolean(implementation) && Number.isFinite(finishedAt) && finishedAt > verifierBeganAt;
    });
    if (supersededByNewerWork) continue;
    const taskPaths = [...task.allowedPaths, ...task.expectedOutputs]
      .map(normalizeScopePath)
      .filter((path) => path.length > 0);
    const overlaps =
      requestedPaths.size === 0 ||
      taskPaths.length === 0 ||
      taskPaths.some((path) => requestedPaths.has(path));
    if (overlaps) rounds += 1;
  }
  return rounds;
}

// Verifier rounds allowed per implementation scope, derived from the run's
// execution policy (itself derived from the manager's complexity call): fast
// gets a single independent verification, deep two.
function verifierRoundCapForRun(run: RunState): number {
  const policy = effectiveRunExecutionPolicy(run);
  const base = policy === "deep" ? 2 : 1;
  return run.taskComplexity === "complex" ? Math.max(base, 2) : base;
}

// Backstop on manager-minted steps: every spawn RPC creates one synthetic
// worker_batch step, and a runaway manager can chain them without limit -
// chat autopilot has no automation-loop hardCap. Generous on purpose: it
// bounds pathological loops, not normal runs. Scoped to the current user
// turn (batches minted since the latest user-authored message) because chat
// runs are long-lived - legitimate batches spread across many turns must
// never accumulate into a force-land.
const SYNTHETIC_STEP_CEILING = 20;
const UNTRUSTED_PR_MAX_WORKERS_PER_BATCH = 4;

function untrustedPullRequestWorkerPathError(
  raw: unknown,
  field: string,
): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return `${field} entries must be non-empty relative paths`;
  }
  if (raw.length > 1_024 || raw.includes("\0")) {
    return `${field} contains an invalid or oversized path`;
  }
  const normalized = raw.trim().replace(/\\/g, "/");
  if (
    isAbsolute(raw) ||
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    return `${field} must stay relative to the imported pull-request workspace`;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    return `${field} may not traverse outside the imported pull-request workspace`;
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) {
    return `${field} may not address Git administrative data`;
  }
  return null;
}

function validateUntrustedPullRequestWorkers(
  run: RunState,
  workers: unknown[],
): string | null {
  if (run.automationId || run.executionMode === "direct") {
    return "an imported pull-request run cannot delegate through an automation or direct-worker run";
  }
  if (workers.length > UNTRUSTED_PR_MAX_WORKERS_PER_BATCH) {
    return `an imported pull-request run may start at most ${UNTRUSTED_PR_MAX_WORKERS_PER_BATCH} workers per batch`;
  }
  for (const raw of workers) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return "each imported pull-request worker must be an object";
    }
    const worker = raw as Record<string, unknown>;
    if (worker.runtimePreference !== "claude" && worker.runtimePreference !== "codex") {
      return "imported pull-request workers must explicitly select claude or codex";
    }
    if (worker.verificationCommands !== undefined) {
      if (
        !Array.isArray(worker.verificationCommands) ||
        worker.verificationCommands.some(
          (command) => typeof command !== "string" || command.trim().length > 0,
        )
      ) {
        return "verification commands are unavailable for imported pull-request workers";
      }
    }
    for (const field of ["allowedPaths", "forbiddenPaths", "expectedOutputs"] as const) {
      const paths = worker[field];
      if (paths === undefined) continue;
      if (!Array.isArray(paths) || paths.length > 64) {
        return `${field} must be an array of at most 64 relative paths`;
      }
      for (const path of paths) {
        const error = untrustedPullRequestWorkerPathError(path, field);
        if (error) return error;
      }
    }
  }
  return null;
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
  let run = await runStore.getRun(runId);
  if (!run) {
    return errorResponse(id, ERR_INVALID_PARAMS, `Run not found: ${runId}`);
  }
  const blocked = rejectIfAutomationRun(run, id, "codara_spawn_workers");
  if (blocked) return blocked;
  const untrustedPullRequest =
    runProjectPolicyMode(run) === "untrusted-pull-request";
  if (untrustedPullRequest) {
    const untrustedError = validateUntrustedPullRequestWorkers(run, rawWorkers);
    if (untrustedError) {
      return errorResponse(id, ERR_FORBIDDEN, untrustedError);
    }
  }
  // The MCP orchestrator has no plan_analysis JSON decision to carry its
  // complexity call, so this is its only channel. Persist before the verifier
  // cap below is computed: the classification is what the cap derives from.
  const declaredComplexity = params.taskComplexity;
  if (
    declaredComplexity === "trivial" ||
    declaredComplexity === "standard" ||
    declaredComplexity === "complex"
  ) {
    const reclassified = await runStore
      .recordTaskComplexity(runId, declaredComplexity)
      .catch(() => null);
    if (reclassified) run = reclassified;
  }
  const cwd = typeof run.settingsSnapshot?.workspaceCwd === "string"
    ? run.settingsSnapshot.workspaceCwd
    : process.cwd();

  // A wait on a failed worker may unblock just as run-store queues its
  // opposite-runtime fallback. The manager can then immediately request a
  // semantically identical verifier while the fallback is already queued or
  // running. Reuse that live verifier instead of creating a second step and
  // spending twice for the same evidence. Multi-verifier batches remain
  // supported: this guard only handles a later, single-verifier spawn.
  const onlyRequestedWorker = rawWorkers.length === 1 && rawWorkers[0] && typeof rawWorkers[0] === "object"
    ? rawWorkers[0] as Record<string, unknown> & OrchestratorWorkerInput
    : null;
  if (onlyRequestedWorker?.taskClass === "verifier") {
    const liveVerifier = [...run.workerTasks].reverse().find((task) => {
      if (task.taskClass !== "verifier" || TERMINAL_WORKER_TASK_STATUSES.has(task.status)) return false;
      const verifierBeganAt = Date.parse(task.createdAt);
      return !run.workerAttempts.some((attempt) => {
        const implementation = run.workerTasks.find(
          (candidate) => candidate.id === attempt.workerTaskId && candidate.taskClass !== "verifier",
        );
        const finishedAt = attempt.finishedAt ? Date.parse(attempt.finishedAt) : Number.NaN;
        return Boolean(implementation) && Number.isFinite(finishedAt) && finishedAt > verifierBeganAt;
      });
    });
    if (liveVerifier) {
      return successResponse(id, {
        worker_task_ids: [liveVerifier.id],
        reused_existing_verifier: true,
        note:
          `Reused live verifier ${liveVerifier.id} (${liveVerifier.status}) instead of creating duplicate ` +
          "verification work. Wait for this worker before deciding whether another verifier is needed.",
      });
    }
  }

  const workerEntries = rawWorkers.filter(
    (raw): raw is Record<string, unknown> & OrchestratorWorkerInput =>
      Boolean(raw) && typeof raw === "object" && !Array.isArray(raw),
  );
  const liveFeedbackRetries = [
    ...new Map(
      workerEntries
        .filter((worker) => worker.taskClass !== "verifier")
        .map((worker) => findLiveVerifierFeedbackRetry(run, worker))
        .filter((task): task is WorkerTask => Boolean(task))
        .map((task) => [task.id, task]),
    ).values(),
  ];
  if (liveFeedbackRetries.length > 0) {
    return successResponse(id, {
      worker_task_ids: liveFeedbackRetries.map((task) => task.id),
      reused_feedback_retry: true,
      note:
        `Reused ${liveFeedbackRetries.length} verifier-feedback corrective ` +
        `${liveFeedbackRetries.length === 1 ? "worker" : "workers"} already queued by the verifier instead of ` +
        "starting another manager-owned corrective wave. Wait for this work before deciding " +
        "whether more implementation work is needed.",
    });
  }

  // Structural shape guard, before anything is created and before the round cap
  // can spend budget on it: an all-verifier batch on a run with no
  // implementation worker has nothing to verify and, being read-only, cannot
  // produce the deliverable either. Rejected rather than coerced so the manager
  // reclassifies and rewrites the briefs (a brief written as an audit is wrong
  // even once the class is fixed).
  const batchRejection = runStore.evaluateSpawnBatchShape(run, workerEntries);
  if (batchRejection) {
    console.warn(
      `[agent-socket] rejected ${batchRejection.verifierCount}-worker all-verifier batch on run ${runId}: ` +
        "no implementation worker exists to verify",
    );
    return errorResponse(id, ERR_INVALID_PARAMS, batchRejection.message);
  }

  // Hard follow_up_of rejections, checked over EVERY requested entry before
  // any filtering: a verifier asking to inherit context must hit this explicit
  // error even when the verifier-round cap below would have dropped it, and an
  // untrusted PR run gets no session reuse at all.
  for (const worker of workerEntries) {
    if (typeof worker.follow_up_of !== "string" || !worker.follow_up_of.trim()) continue;
    if (worker.taskClass === "verifier") {
      return errorResponse(
        id,
        ERR_INVALID_PARAMS,
        "follow_up_of is not allowed on a verifier: a verifier must re-check the work in a fresh " +
          "session and can never inherit the context of the work it is judging. Spawn the verifier " +
          "without follow_up_of.",
      );
    }
    if (untrustedPullRequest) {
      return errorResponse(
        id,
        ERR_FORBIDDEN,
        "session reuse is unavailable for imported pull-request runs",
      );
    }
  }

  // Hard verification-round cap: past the policy's budget, refuse to mint
  // another verification step. The manager must either accept the work (it
  // lands via the completed_unverified path with the existing caveats) or ask
  // the user, more verifier rounds cannot produce new evidence.
  let workersToCreate = workerEntries;
  const guardrailNotes: string[] = [];
  const requestedVerifiers = workerEntries.filter((worker) => worker.taskClass === "verifier");
  if (requestedVerifiers.length > 0) {
    const verifierRoundCap = verifierRoundCapForRun(run);
    const verifierRoundsUsed = countVerifierRoundsForScope(run, requestedVerifiers);
    if (verifierRoundsUsed >= verifierRoundCap) {
      const policy = effectiveRunExecutionPolicy(run);
      const capNote =
        `Verification cap reached: ${verifierRoundsUsed} verifier round(s) already ran against this scope ` +
        `(cap ${verifierRoundCap} for the ${policy} policy). Do not spawn another verifier. Either accept ` +
        "the implementation now (it lands as completed_unverified carrying the existing verifier caveats) " +
        "or ask the user one concrete question. If a verifier could not run because tooling was unavailable, " +
        "treat that as an environmental caveat, not a code failure.";
      if (requestedVerifiers.length === workerEntries.length) {
        return successResponse(id, {
          worker_task_ids: [],
          verification_cap_reached: true,
          verifier_rounds_used: verifierRoundsUsed,
          verifier_round_cap: verifierRoundCap,
          note: capNote,
        });
      }
      workersToCreate = workerEntries.filter((worker) => worker.taskClass !== "verifier");
      guardrailNotes.push(capNote);
    }
  }

  // Warm follow-up session reuse (follow_up_of). Decided per entry BEFORE any
  // task is created: an invalid pointer fails the whole batch (the hard
  // verifier/untrusted rejections already ran above, pre-filtering), and a
  // merely-failed gate degrades to a cold spawn whose reason reaches the
  // manager through the result note. Entries with empty titles are skipped
  // here exactly as the create loop drops them: a note about a worker that
  // will never exist only confuses the manager.
  const sessionResumePlans = new Map<
    Record<string, unknown>,
    Extract<WorkerSessionReuseDecision, { kind: "resume" }>
  >();
  for (const worker of workersToCreate) {
    const followUpOf = typeof worker.follow_up_of === "string" ? worker.follow_up_of.trim() : "";
    if (!followUpOf) continue;
    if (typeof worker.title !== "string" || !worker.title.trim()) continue;
    const decision = evaluateWorkerSessionReuse({
      run,
      followUpOfTaskId: followUpOf,
      requestedRuntime: worker.runtimePreference ?? ORCHESTRATOR_RUNTIME_FALLBACK,
    });
    if (decision.kind === "invalid") {
      return errorResponse(id, ERR_INVALID_PARAMS, decision.reason);
    }
    if (decision.kind === "cold") {
      guardrailNotes.push(`follow_up_of ${followUpOf}: ${decision.reason}`);
    } else if (
      [...sessionResumePlans.values()].some((plan) => plan.sessionId === decision.sessionId)
    ) {
      // Two workers of one batch launch simultaneously; letting both continue
      // the same transcript would have two Pi processes writing one session
      // file. First claim wins, the duplicate spawns cold.
      guardrailNotes.push(
        `follow_up_of ${followUpOf}: another worker in this batch already resumed that session; ` +
          "a session can only be continued by one worker at a time. Spawned cold instead.",
      );
    } else {
      sessionResumePlans.set(worker, decision);
    }
  }

  // Subscription-quota headroom, read once per spawn batch, after the
  // early-return reuse guards above so their fast paths never wait on it (the
  // read hits pi-subscription-usage's 60s cache, usually warmed by the manager
  // turn that issued this RPC). Consulted by the cross-provider verifier
  // reroute below (never send the verifier into a provider that already hit
  // its limit) and by the headroom reroute at task creation. A failed read
  // degrades to null, which every consumer treats as "no signal", so a usage
  // hiccup can never fail a spawn.
  const headroomSummary = await readSubscriptionHeadroomSummary();

  // Cross-provider verification is a control-plane invariant, not merely a
  // prompt suggestion. For the common single-verifier follow-up, reroute a
  // same-provider request to the installed/enabled peer and translate the
  // requested model to the equivalent tier. Multi-verifier batches are left
  // untouched so complex work can deliberately request one peer from each
  // provider.
  let verifierPeerOverride: {
    runtime: "claude" | "codex";
    modelHint: string;
    note: string;
  } | null = null;
  if (
    onlyRequestedWorker?.taskClass === "verifier" &&
    (onlyRequestedWorker.runtimePreference === "claude" || onlyRequestedWorker.runtimePreference === "codex")
  ) {
    const latestImplementation = [...run.workerTasks].reverse().find(
      (task) =>
        task.taskClass !== "verifier" &&
        (task.runtimePreference === "claude" || task.runtimePreference === "codex"),
    );
    if (latestImplementation?.runtimePreference === onlyRequestedWorker.runtimePreference) {
      const opposite = latestImplementation.runtimePreference === "claude" ? "codex" : "claude";
      const runtimes = await detectWorkerAssignableRuntimes();
      // Cross-provider verification is valuable only when that provider is
      // healthy: it needs a connected Pi subscription (the worker runs on the
      // bundled Pi harness, so a CLI binary is beside the point) and must not
      // have already failed
      // environmentally in this run (expired OAuth, launch failure, etc.) -
      // rerouting into a provider that just failed sent workers into the same
      // broken subscription twice in run-mrwp6vfh-wkticw. The sign-in probe is
      // deliberately NOT consulted: `authenticated === false` is advisory (the
      // probe misses env/helper credentials), and an actual sign-out shows up
      // as an environmental failure on first use anyway.
      // A limit-reached subscription is the quota flavor of the same problem:
      // the reroute would send the verifier into a provider guaranteed to
      // refuse it. Only the explicit limitReached flag blocks the reroute; a
      // failed or missing usage read stays permissive.
      const oppositeAvailable =
        isWorkerAssignable(runtimes, opposite) &&
        !runtimeHadEnvironmentalFailure(run, opposite) &&
        !runtimeLimitReached(headroomSummary, opposite);
      if (oppositeAvailable) {
        verifierPeerOverride = {
          runtime: opposite,
          modelHint: crossProviderPeerModel(opposite, onlyRequestedWorker.modelHint),
          note:
            `Rerouted the verifier from ${latestImplementation.runtimePreference} to ${opposite} so the ` +
            "implementation is checked by an independent provider family.",
        };
      }
    }
  }

  // Quota-aware routing enforcement. When one subscription is nearly exhausted
  // while the other has clear room (thresholds in subscription-headroom.ts:
  // tight means limitReached or under 10% left, comfortable means at least 35%
  // left), workers the manager pointed at the constrained provider are
  // rerouted to the roomy one at the equivalent roster tier. Two deliberate
  // exemptions: an explicit claude-fable-5 hint is a premium pin and is never
  // rerouted, and the single-verifier cross-provider override above always
  // wins, since that reroute is an independence invariant rather than a
  // load-balancing choice. The reroute only arms when the preferred runtime is
  // actually usable here: installed, and without an environmental failure this
  // run (mirroring the verifier reroute's health check).
  const headroomPreferredRuntime = preferredRuntimeForHeadroom(headroomSummary);
  let headroomReroute: { from: "claude" | "codex"; to: "claude" | "codex" } | null = null;
  if (headroomPreferredRuntime) {
    const constrainedRuntime = headroomPreferredRuntime === "claude" ? "codex" : "claude";
    const anyReroutableWorker = workersToCreate.some(
      (worker) =>
        (worker.runtimePreference ?? ORCHESTRATOR_RUNTIME_FALLBACK) === constrainedRuntime &&
        !/fable/i.test(typeof worker.modelHint === "string" ? worker.modelHint : ""),
    );
    if (anyReroutableWorker) {
      const detected = await detectWorkerAssignableRuntimes();
      const preferredUsable =
        isWorkerAssignable(detected, headroomPreferredRuntime) &&
        !runtimeHadEnvironmentalFailure(run, headroomPreferredRuntime);
      if (preferredUsable) {
        headroomReroute = { from: constrainedRuntime, to: headroomPreferredRuntime };
      }
    }
  }

  // Execute-mode workers don't belong to a planned step; the manager
  // spawns them ad-hoc. RunGraph.tsx renders FROM run.steps, so without a
  // step entry the graph falls through to OutcomeGraph's "No steps run"
  // card and the worker is invisible - observed in run-mpodz3i7-fs8o7f
  // even though the worker actually ran and edited files. Create one
  // synthetic worker_batch step per spawn_workers RPC call so the graph
  // can render the worker rows via the existing agentRowsForStep path.
  // Only batches minted during the current user turn count toward the
  // ceiling: a fresh user message resets the budget, so the brake catches a
  // runaway single-turn spawn loop without ever tripping on a multi-turn
  // chat run's accumulated history.
  const latestUserTurnAt = run.humanMessages.reduce((max, message) => {
    if (message.author !== "user") return max;
    const at = Date.parse(message.createdAt);
    return Number.isFinite(at) && at > max ? at : max;
  }, Number.NEGATIVE_INFINITY);
  const syntheticStepCount = run.steps.filter(
    (step) =>
      (step.kind ?? "worker_batch") === "worker_batch" &&
      Date.parse(step.createdAt) >= latestUserTurnAt,
  ).length;
  if (syntheticStepCount >= SYNTHETIC_STEP_CEILING) {
    await runStore
      .forceLandRunUnverified(runId, {
        trigger: "synthetic_step_ceiling",
        note:
          `This run reached the ceiling of ${SYNTHETIC_STEP_CEILING} manager-spawned worker batches in one turn. ` +
          "Codara accepted the remaining reviewed work and landed the run as unverified rather than keep spawning.",
      })
      .catch(() => undefined);
    return successResponse(id, {
      worker_task_ids: [],
      step_ceiling_reached: true,
      note:
        `Step ceiling reached: this turn already spawned ${syntheticStepCount} worker batches ` +
        `(cap ${SYNTHETIC_STEP_CEILING}). Codara has landed the run with the work completed so far. ` +
        "Summarize the outcome for the user and end the turn. Do not spawn more workers.",
    });
  }
  const workerTitles = workersToCreate
    .map((r) => (typeof r.title === "string" ? r.title.trim() : ""))
    .filter((t) => t.length > 0);
  const stepTitle = workerTitles.length === 1
    ? workerTitles[0]
    : workerTitles.length > 1
      ? `Cora workers (${workerTitles.length})`
      : "Cora workers";
  const stepRunState = await runStore.createStep({
    runId,
    title: stepTitle,
    goal: workerTitles.length > 0 ? workerTitles.join("; ") : "Workers spawned via execute-mode manager.",
    kind: "worker_batch",
    plannedAgents: [],
    acceptanceCriteria: ["All spawned worker tasks complete."],
    dependsOnStepIds: dependencyIdsForSpawnedStep(run),
  });
  const synthStep = stepRunState.steps.at(-1);
  const synthStepId = synthStep?.id;

  // A batch of ≥2 workers shares the mailbox (the manager channel always, the
  // peer group chat for whichever workers were flagged `peers`), so mark every
  // task in a multi-worker spawn parallel. Both mailbox gates require
  // canRunParallel, so this is what lets them fire at all for manager-spawned
  // fleets. Single-worker spawns stay sequential (no peers to coordinate with,
  // and nothing to steer around).
  const isParallelBatch = workerTitles.length >= 2;

  const workerTaskIds: string[] = [];
  // taskClass of each task actually created, index-aligned with workerTaskIds
  // (raw entries with empty titles are dropped, so rawWorkers can't be used to
  // find the surviving worker's class for the solo-spawn advisory below).
  const createdTaskClasses: (string | undefined)[] = [];
  // Titles of workers the headroom reroute actually moved, for the note below.
  const headroomReroutedTitles: string[] = [];
  // Workers actually created with a warm session resume, for the result flag.
  let resumedSessionCount = 0;
  const attemptIdsToLaunch: string[] = [];
  // Create every task BEFORE preparing any: prepareWorkerTask renders the
  // worker prompt and evaluates shouldUsePeerComms against the run snapshot at
  // that instant. If we interleaved create+prepare, the first worker's prompt
  // would be rendered before its peers exist on the step, so it would miss the
  // mailbox + peer-comms guidance (the synthetic step has no plannedAgents to
  // compensate). Two passes guarantee each worker's prompt sees the full batch.
  for (const w of workersToCreate) {
    const title = typeof w.title === "string" ? w.title.trim() : "";
    if (!title) continue;
    const description = typeof w.description === "string" ? w.description : "";
    const resumePlan = sessionResumePlans.get(w);
    let effectiveRuntime = verifierPeerOverride?.runtime ?? w.runtimePreference ?? ORCHESTRATOR_RUNTIME_FALLBACK;
    let effectiveModelHint = verifierPeerOverride?.modelHint ??
      (typeof w.modelHint === "string" ? w.modelHint : undefined);
    // A resumed session must continue on the exact runtime and model that
    // produced its transcript, so the source attempt's resolution wins over
    // any hint and the headroom reroute below is skipped.
    if (resumePlan) {
      effectiveRuntime = resumePlan.sourceAttempt.runtime;
      effectiveModelHint = resumePlan.sourceAttempt.model ?? resumePlan.sourceTask.modelHint;
    }
    // Headroom reroute, per worker: skipped for the verifier peer override
    // (independence invariant), for a warm session resume (pinned to its
    // source runtime), and for an explicit fable pin (deliberate premium ask,
    // honored even while the Claude quota is tight).
    if (
      headroomReroute &&
      !verifierPeerOverride &&
      !resumePlan &&
      effectiveRuntime === headroomReroute.from &&
      !/fable/i.test(effectiveModelHint ?? "")
    ) {
      effectiveRuntime = headroomReroute.to;
      effectiveModelHint = crossProviderPeerModel(headroomReroute.to, effectiveModelHint);
      headroomReroutedTitles.push(title);
    }
    const sanitizedModel = untrustedPullRequest
      ? rosterModelFor(
          effectiveRuntime === "codex" ? "codex" : "claude",
          "standard",
        )
      : runStore.sanitizeWorkerModelHint(effectiveModelHint);
    const updated = await runStore.createWorkerTask({
      runId,
      stepId: synthStepId,
      title,
      description,
      runtimePreference: effectiveRuntime as
        | "claude" | "codex" | "shell" | "manual",
      modelHint: sanitizedModel,
      effortHint:
        untrustedPullRequest && w.effortHint === "xhigh"
          ? "high"
          : w.effortHint,
      allowedPaths: Array.isArray(w.allowedPaths) ? w.allowedPaths.filter((p): p is string => typeof p === "string") : [],
      forbiddenPaths: Array.isArray(w.forbiddenPaths) ? w.forbiddenPaths.filter((p): p is string => typeof p === "string") : [],
      expectedOutputs: Array.isArray(w.expectedOutputs) ? w.expectedOutputs.filter((p): p is string => typeof p === "string") : [],
      verificationCommands: Array.isArray(w.verificationCommands)
        ? w.verificationCommands.filter((p): p is string => typeof p === "string")
        : [],
      taskClass: w.taskClass,
      canRunParallel: isParallelBatch,
      // Opt-in independence. Only meaningful inside a parallel batch, and it
      // suppresses peer-to-peer traffic ONLY: the manager can still reach an
      // isolated worker, so asking for independence never costs steering.
      isolated: isParallelBatch && w.isolated === true ? true : undefined,
      // Opt-in group chat, default off. Also only meaningful inside a parallel
      // batch (a solo worker has nobody to talk to) and it never widens what
      // the manager can reach, only what this worker's peers can.
      peers: isParallelBatch && w.peers === true ? true : undefined,
      // Every attempt of a multi-worker spawn launches simultaneously below
      // (scheduleAutopilotCycles), bypassing pickAutopilotTasks. Mark the
      // tasks so retry/fallback waves keep that concurrency: without the
      // marker the picker's fan-out guard reads their empty allowedPaths as
      // "no concrete scope" and relaunches the batch one task at a time.
      parallelTrust: isParallelBatch ? "manager_batch" : undefined,
      // Warm follow-up: the launch path resumes this exact session instead of
      // minting a fresh one. Stamped only when the reuse gate passed above.
      followUpOfTaskId: resumePlan?.sourceTask.id,
      resumeSessionId: resumePlan?.sessionId,
      createdBy: "spark",
    });
    // The just-created task is the LAST entry on updated.workerTasks.
    const created = updated.workerTasks.at(-1);
    if (!created) continue;
    workerTaskIds.push(created.id);
    createdTaskClasses.push(typeof w.taskClass === "string" ? w.taskClass : undefined);
    if (resumePlan) {
      resumedSessionCount += 1;
      guardrailNotes.push(
        `Resumed session: worker "${title}" continues task ${resumePlan.sourceTask.id} ` +
          `(attempt ${resumePlan.sourceAttempt.attemptNumber}, ` +
          `${Math.round((resumePlan.contextTokens / resumePlan.contextWindowTokens) * 100)}% of its ` +
          `${resumePlan.contextWindowTokens}-token context window used). The new prompt lands as the ` +
          "next turn of that worker's session, with its prior context intact.",
      );
    }
  }
  for (const workerTaskId of workerTaskIds) {
    try {
      const envelope = await runStore.prepareWorkerTask({ runId, workerTaskId, cwd });
      // The prepared attempt is sitting at prompt_ready; schedule the
      // autopilot cycle that flips it to launching + actually spawns the
      // worker CLI. Before the execute-mode autopilot-review-skip landed
      // (run-store.ts:741+), this happened indirectly via the eventual
      // worker_result_review pickup. Now nobody calls launchWorkerAttempt
      // unless we do it here - without this, CC's manager turn spawns
      // workers that sit forever in prompt_ready, blocks on
      // codara_wait_for_workers until the 90s turn timeout fires, and
      // reports back "Worker was cancelled before execution."
      attemptIdsToLaunch.push(envelope.attemptId);
    } catch (err) {
      // prepareWorkerTask failures shouldn't block subsequent queueings; the
      // worker stays in 'created' state and the autopilot will retry. Not
      // silent though - a stuck-in-created worker is otherwise undiagnosable.
      console.warn(
        `[agent-socket] prepareWorkerTask failed for ${workerTaskId} (run ${runId}); autopilot will retry:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (attemptIdsToLaunch.length > 0) {
    runStore.scheduleAutopilotCycles(runId, attemptIdsToLaunch);
  }
  // Echo policy back to the manager LLM through the tool result - it never
  // sees run system notes, and its system prompt is frozen at run start, so
  // this response is the ONLY channel that reaches managers of long-lived
  // runs when fleet/model policy evolves underneath them.
  const notes: string[] = [...guardrailNotes];
  if (verifierPeerOverride) notes.push(verifierPeerOverride.note);
  if (headroomReroute && headroomReroutedTitles.length > 0) {
    const constrainedInfo = headroomForRuntime(headroomSummary, headroomReroute.from);
    const preferredInfo = headroomForRuntime(headroomSummary, headroomReroute.to);
    const constrainedLabel = constrainedInfo?.label ?? headroomReroute.from;
    const constrainedState = constrainedInfo?.limitReached
      ? "has hit its subscription limit"
      : `has only ${constrainedInfo?.headroomPercent ?? 0}% of its ${
          constrainedInfo?.tightestWindowLabel ?? "quota"
        } window left`;
    const constrainedReset = constrainedInfo?.tightestWindowResetsIn
      ? ` (resets in ${constrainedInfo.tightestWindowResetsIn})`
      : "";
    notes.push(
      `Subscription headroom reroute: moved ${headroomReroutedTitles.length} worker(s) ` +
        `(${headroomReroutedTitles.join(", ")}) from ${headroomReroute.from} to ${headroomReroute.to} ` +
        `at the equivalent model tier. The ${constrainedLabel} subscription ${constrainedState}` +
        `${constrainedReset}, while ${preferredInfo?.label ?? headroomReroute.to} has ` +
        `${preferredInfo?.headroomPercent != null ? `${preferredInfo.headroomPercent}% left` : "more headroom"}. ` +
        "Route follow-up workers to " +
        `${headroomReroute.to} until the quota resets; an explicit claude-fable-5 modelHint is treated ` +
        "as a deliberate premium pin and is never rerouted.",
    );
  }
  // Solo-spawn advisory. Legitimate solo spawns exist - a lone verifier or
  // leaf, a skeleton before a fan-out (the prompts' own endorsed pattern), a
  // targeted corrective fix after a failed verify - so the note names them as
  // fine and only nudges the under-decomposed-build case. Derive the class
  // from the tasks actually CREATED (rawWorkers entries can be silently
  // dropped above, so rawWorkers[0] may not be the surviving worker).
  const soloTaskClass = workerTaskIds.length === 1 && createdTaskClasses.length === 1
    ? createdTaskClasses[0]?.toLowerCase()
    : undefined;
  const soloIsExpected =
    soloTaskClass === "verifier" || soloTaskClass === "leaf" || soloTaskClass === "skeleton";
  if (workerTaskIds.length === 1 && !soloIsExpected) {
    notes.push(
      "Note: this batch spawned a single worker. That is right for a cohesive same-file or sequential " +
        "change, a targeted corrective fix, or a deliberate skeleton before a fan-out. For a feature with " +
        "genuinely independent slices, prefer 2-4 workers on DISJOINT allowedPaths plus a verifier, mixing " +
        "Claude and Codex so two model families cover each other's blind spots. Do not split a cohesive " +
        "change or invent files just to manufacture parallelism, but do not default to one worker out of " +
        "caution either: independent slices run together should run together.",
    );
  }
  return successResponse(id, {
    worker_task_ids: workerTaskIds,
    ...(resumedSessionCount > 0 ? { resumed_session: true } : {}),
    ...(notes.length > 0 ? { note: notes.join("\n") } : {}),
  });
}

// A long-poll loop should give up the moment the MCP client hangs up -
// otherwise a dropped connection keeps the main-process loop polling blind
// for the full 15-20 min deadline.
function clientGone(res: ServerResponse): boolean {
  return res.writableEnded || res.socket === null || res.socket.destroyed;
}

function runQuestionWasAbandoned(status: RunState["status"]): boolean {
  return status === "paused" || status === "cancelled" || status === "complete" || status === "failed";
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
  const beforeAsk = await runStore.getRun(runId);
  if (!beforeAsk) return errorResponse(id, ERR_INVALID_PARAMS, `Run not found: ${runId}`);
  const requestedCategory = stringParam(params, "category");
  const validCategories: ReadonlySet<RunQuestionCategory> = new Set([
    "credentials_access",
    "destructive_irreversible",
    "safety_policy",
    "irreducible_product_scope",
    "plan_approval",
  ]);
  const category =
    requestedCategory && validCategories.has(requestedCategory as RunQuestionCategory)
      ? (requestedCategory as RunQuestionCategory)
      : undefined;
  if (requestedCategory && !category) {
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      `Unsupported human-blocker category: ${requestedCategory}`,
    );
  }
  // An approval ask must carry the content being approved. Rejecting here,
  // before any question is posted, hands the manager a retry instruction on
  // the still-open turn instead of blocking the run on a question the user
  // cannot judge ("approve the plan shown above" over collapsed reports).
  const blindAsk = blindApprovalAskProblem(question, category);
  if (blindAsk) {
    return errorResponse(id, ERR_INVALID_PARAMS, blindAsk);
  }
  // Same shape as the blind-ask guard: reject before posting so the manager
  // gets a retry instruction on its still-open turn rather than the user
  // getting a plan whose buildability nobody claims either way.
  const planValidation = parsePlanValidation(params.planValidation) ?? undefined;
  const planValidationProblem = planValidationAskProblem(category, planValidation);
  if (planValidationProblem) {
    return errorResponse(id, ERR_INVALID_PARAMS, planValidationProblem);
  }
  const source = beforeAsk.executionMode === "direct" ? "direct_worker" : "live_manager_rpc";
  const managerMode = [...beforeAsk.sparkCalls]
    .reverse()
    .find((call) => call.status === "started" && !call.completedAt)?.mode;
  let questionMessageId: string;
  try {
    const resolved = await runStore.resolveManagerQuestion({
      runId,
      message: question,
      questionOptions: options,
      category,
      reason: stringParam(params, "reason") ?? undefined,
      recommendedOptionId: stringParam(params, "recommendedOptionId") ?? undefined,
      planValidation,
      source,
      resumeStrategy: "active_rpc",
      managerMode,
      conversationEpoch: beforeAsk.conversationEpoch ?? 0,
    });
    if (resolved.action === "assumed") {
      return successResponse(id, {
        answer: resolved.assumption.selectedAnswer,
        kind: "assumption",
        assumptionId: resolved.assumption.id,
      });
    }
    questionMessageId = resolved.questionMessageId;
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }

  const releaseQuestion = async (): Promise<void> => {
    try {
      await runStore.releaseRunQuestion(runId, questionMessageId);
    } catch {
      /* a concurrent answer may already have cleared this blocker */
    }
  };

  const deadline =
    Date.now() +
    (category === "plan_approval" ? PLAN_APPROVAL_TIMEOUT_MS : ASK_USER_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, ASK_USER_POLL_MS));
    // Client hung up - stop polling; writeJsonRpc on a dead socket is a no-op.
    if (clientGone(res)) {
      await releaseQuestion();
      return errorResponse(id, ERR_INTERNAL, "ask_user aborted: client disconnected");
    }
    const run = await runStore.getRun(runId);
    if (!run) {
      return errorResponse(id, ERR_INVALID_PARAMS, `Run vanished mid-ask: ${runId}`);
    }
    if (runQuestionWasAbandoned(run.status)) {
      return errorResponse(id, ERR_INTERNAL, "ask_user ended because the run was paused or terminated");
    }
    const answer = [...run.humanMessages]
      .reverse()
      .find(
        (m) =>
          m.author === "user" &&
          m.kind === "answer" &&
          m.answersMessageId === questionMessageId,
      );
    if (answer) {
      return successResponse(id, { answer: answer.message, kind: answer.kind });
    }
    if (
      run.status !== "blocked" ||
      run.blockedOn?.questionMessageId !== questionMessageId
    ) {
      return errorResponse(id, ERR_INTERNAL, "ask_user ended because question ownership was released");
    }
  }
  await releaseQuestion();
  return errorResponse(id, ERR_INTERNAL, "ask_user timed out waiting for human response");
}

// A worker task is "done" only in these three states. Used by
// wait_for_workers to report is_terminal.
const TERMINAL_WORKER_TASK_STATUSES = new Set<string>(["accepted", "failed", "cancelled"]);

// Worker task statuses that represent REAL in-flight work - an attempt is
// scheduled, running, awaiting review, or queued to retry - so completing the
// run now would strand it (the reproduced bug: a QUEUED corrective worker was
// cancelled when codara_complete landed early). This is what gates codara_complete.
//
// Deliberately a positive "in-flight" allowlist rather than "everything not
// terminal", so the guard fails OPEN (allows completion) on statuses that are
// NOT live work and must never deadlock the coordinator:
//   - `created`: a task only lingers here when prepareWorkerTask never
//     succeeded (codara_spawn_workers' prepare threw - see ~L859) or a user
//     hand-added a task via the UI that was never launched. Such a task never
//     reaches a terminal state on its own, and NO coordinator RPC can launch,
//     retry, or cancel it - so blocking on it would make the run permanently
//     uncompletable (codara_wait_for_workers on a `created` task can only time
//     out). createWorkerTask stamps `created`; prepareWorkerTask advances to
//     `queued`, so a healthy just-spawned task is already past `created` by the
//     time the model can call codara_complete.
//   - `blocked`: only ever set on the loom-pass path (run-store), and
//     loom/automation runs are rejected by rejectIfAutomationRun before this
//     guard - so it cannot legitimately reach here.
//   - any future/unknown status: fail-open beats a mystery deadlock.
const IN_FLIGHT_WORKER_TASK_STATUSES = new Set<string>([
  "queued",
  "claimed",
  "running",
  "needs_review",
  "retry_queued",
]);

/**
 * Did the completion summary actually own up to removing `path`?
 *
 * Matched on the path as written and on its basename, because a manager that
 * discloses a deletion writes "removed research/codex-fast-mode/claude.md", not
 * the absolute path the final report happened to record. Deliberately generous:
 * the gate exists to end SILENT deletion, and a summary that names the file has
 * already achieved that. A false positive here costs a disclosure the user can
 * read; a false negative would wedge a run over phrasing.
 */
function summaryDisclosesPath(summary: string, path: string): boolean {
  const haystack = summary.toLowerCase();
  if (!haystack.trim() || !path) return false;
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  if (haystack.includes(normalized)) return true;
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base.length > 2 && haystack.includes(base);
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
  const blocked = rejectIfAutomationRun(run, id, "codara_complete");
  if (blocked) return blocked;
  // `codara_complete` is the terminal half of the managed execution protocol,
  // not a substitute for spawning work. Rejecting it before any worker has
  // existed prevents a manager from turning a prose-only "I'll spawn..."
  // response into a successful zero-edit run. Read-only chat answers do not
  // call this tool, and completed managed runs always retain worker history.
  if (
    effectiveChatMode(run.chatMode) === "auto" &&
    (run.workerTasks ?? []).length === 0
  ) {
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      "Cannot complete a run before any worker task exists. " +
        "Call codara_spawn_workers for the active user request, wait for the workers, verify their reports, then call codara_complete.",
    );
  }
  // Guard: never complete the run while a worker task the coordinator spawned is
  // still in-flight. Completing here flips the run to `complete`, which fires the
  // "done" toast and tears the run down mid-flight - observed live: a corrective
  // worker was QUEUED after a failed attempt, then codara_complete landed and the
  // queued worker was left stranded/cancelled. Reject with an instructive,
  // structured error so the CLI coordinator waits on the stragglers first
  // (codara_wait_for_workers) and only then completes. The MCP server relays a
  // JSON-RPC error `message` back to the model as an isError tool result
  // (server.js callTool), so this reaches the model and course-corrects it. We
  // deliberately do NOT auto-cancel the stragglers here. Only genuinely in-flight
  // statuses block (see IN_FLIGHT_WORKER_TASK_STATUSES) - a never-launched
  // `created` task must not deadlock completion.
  const pendingTasks = (run.workerTasks ?? []).filter(
    (wt) => IN_FLIGHT_WORKER_TASK_STATUSES.has(wt.status),
  );
  if (pendingTasks.length > 0) {
    // A MANUAL task at needs_review deliberately still blocks completion (its
    // report is unreviewed, and only the human-review escalation question can
    // settle it), but sending the model back to codara_wait_for_workers for it
    // would be a lie: waiting can never terminalize a manual task. Name the
    // real dependency - the user's accept/fail answer - so the coordinator
    // stops burning its turn on a wait that cannot succeed.
    const manualAwaitingUser = pendingTasks.filter(
      (wt) => wt.runtimePreference === "manual" && wt.status === "needs_review",
    );
    const waitableTasks = pendingTasks.filter((wt) => !manualAwaitingUser.includes(wt));
    const manualDetail = manualAwaitingUser
      .map((wt) => `"${wt.title}" (${wt.id})`)
      .join(", ");
    if (waitableTasks.length === 0) {
      return errorResponse(
        id,
        ERR_INVALID_PARAMS,
        `Cannot complete: ${manualAwaitingUser.length} manual worker report(s) await the user's accept/fail answer: ${manualDetail}. ` +
          "Manual reports are reviewed by the user through the human-review question, not by waiting on workers. " +
          "The task leaves needs_review when the user answers; if the decision is urgent, surface it via codara_ask_user.",
      );
    }
    const detail = waitableTasks
      .map((wt) => `"${wt.title}" (${wt.id}, ${wt.status})`)
      .join(", ");
    const ids = waitableTasks.map((wt) => wt.id).join(", ");
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      `Cannot complete: ${waitableTasks.length} worker task(s) still pending/running: ${detail}. ` +
      `Call codara_wait_for_workers with worker_task_ids [${ids}] first, then read each report and call ` +
        `codara_complete once every worker has reached a terminal state (accepted/failed/cancelled).` +
        (manualAwaitingUser.length > 0
          ? ` Additionally, ${manualAwaitingUser.length} manual worker report(s) await the user's accept/fail answer and will not settle via waiting: ${manualDetail}.`
          : ""),
    );
  }
  // Verification freshness invariant: an earlier green verifier does not cover
  // a later corrective edit. One implementation (run-store), shared with the
  // orchestrator-side terminal hops that complete a run when this tool never
  // arrives, so a manager that skips codara_complete cannot skip the rule.
  const verification = await runStore.describeVerificationFreshness(run);
  if (!verification.ok) {
    // A failing verifier over the current tree is named explicitly, because
    // with a scope-split round the manager may be looking at one or more GREEN
    // sibling reports and reasonably believe the round passed.
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      verification.blockingVerifier
        ? `Cannot complete: "${verification.blockingVerifier.title}" returned ` +
            `${verification.blockingVerifier.confidence} over the current workspace. A passing verdict from ` +
            "another verifier in the same round does not cover its scope. Address its FEEDBACK/FAILED claims, " +
            "then re-verify the corrected workspace before calling codara_complete."
        : "Cannot complete: the latest files-changing implementation does not have a newer passing verifier verdict. " +
            `Latest verifier confidence: ${verification.latestVerifierConfidence ?? "none"}. ` +
            "Spawn a read-only verifier for the corrected workspace, wait for it, and address any FEEDBACK/FAILED claims before calling codara_complete.",
    );
  }
  // Deliverable-preservation invariant: a worker's handoff[] artifacts are
  // output the run is accountable for, not scratch to tidy away before the
  // final diff looks clean. See describeMissingHandoffArtifacts for the
  // incident. Disclosure clears the gate - naming the path in the summary is
  // always a legal way forward, so a genuinely intended removal can never wedge
  // a run; only a SILENT one is refused.
  const handoffAudit = await runStore.describeMissingHandoffArtifacts(run);
  const undisclosed = handoffAudit.missing.filter(
    (artifact) => !summaryDisclosesPath(summary, artifact.path),
  );
  if (undisclosed.length > 0) {
    const detail = undisclosed
      .map((artifact) => `${artifact.path} (declared by "${artifact.taskTitle}")`)
      .join(", ");
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      `Cannot complete: ${undisclosed.length} artifact(s) a worker declared as reusable output no longer exist: ${detail}. ` +
        "A handoff artifact is a deliverable - the worker wrote it on purpose and it may be the only thing this run produced for the user. " +
        "Restore it (every pre-worker checkpoint for this run still contains it) and call codara_complete again. " +
        "If deleting it was genuinely intended, name the exact path in your completion summary and say why, then call codara_complete again.",
    );
  }
  try {
    const applied = await runStore.applyCodaraCompleteFromManagerCall({
      runId,
      summary,
    });
    return successResponse(id, applied.result);
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

// Agent-driven automation loops: the orchestrator records whether the loop
// should run another iteration. The loop driver reads this in onTerminal. Has
// no effect on a normal (non-automation) run - the signal is simply unread.
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

  // Looms-on-Pi handoff: the agent may steer the NEXT pass's model/effort.
  // Invalid fields are dropped (never an error response - the continue/stop
  // signal must always be recorded; killing the loop over a typo'd model id
  // would be worse than ignoring the steering). Whatever survives validation
  // is honored by the loop driver for the next pass. A legacy `nextEngine`
  // from an old transcript is tolerated and ignored - the model id alone
  // selects the Pi provider.
  const requestedEngine = stringParam(params, "nextEngine") ?? undefined;
  const requestedModel = stringParam(params, "nextModel") ?? undefined;
  const requestedEffort = stringParam(params, "nextEffort") ?? undefined;
  let nextModel: string | undefined;
  let nextEffort: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  let warning: string | undefined;
  if (requestedEngine !== undefined || requestedModel !== undefined || requestedEffort !== undefined) {
    try {
      if (requestedModel) {
        // Trim + lowercase both families: Pi's provider gate is
        // case-sensitive, so a mixed-case handoff id would throw at the next
        // launch instead of steering it.
        const trimmed = /^gpt-/i.test(requestedModel)
          ? normalizeCodexModelId(requestedModel.trim()).toLowerCase()
          : requestedModel.trim().toLowerCase();
        if (/^(claude|gpt)-[a-z0-9.\-]+$/.test(trimmed)) {
          nextModel = trimmed;
        } else {
          warning = `nextModel "${requestedModel}" is not a claude-* or gpt-* model id; keeping the loom's own model.`;
        }
      }
      if (requestedEngine !== undefined && !nextModel) {
        warning = warning ?? "nextEngine is no longer supported: automations run on Pi; steer with nextModel instead.";
      }
      if (["minimal", "low", "medium", "high", "xhigh", "max"].includes(requestedEffort ?? "")) {
        nextEffort = requestedEffort as typeof nextEffort;
      } else if (requestedEffort !== undefined) {
        warning = warning ?? `nextEffort "${requestedEffort}" is not a valid effort level; ignored.`;
      }
      if (warning) {
        await appendEvent({
          workspaceId: "",
          type: "automation.handoff_rejected",
          payload: { runId, requestedEngine, requestedModel, requestedEffort, warning },
        }).catch(() => undefined);
      }
    } catch {
      // Validation failing must never block the continue signal.
      nextModel = undefined;
      nextEffort = undefined;
    }
  }

  try {
    const { recordAgentSignal } = await import("./orchestration/automation-loop");
    recordAgentSignal(runId, { continue: !done, prompt, nextModel, nextEffort, nodeId });
    const accepted = nextModel || nextEffort ? { nextModel, nextEffort } : undefined;
    return successResponse(id, { ok: true, continue: !done, accepted, warning });
  } catch (err) {
    return errorResponse(id, ERR_INTERNAL, (err as Error).message);
  }
}

const WAIT_FOR_WORKERS_POLL_MS = 500;
const WAIT_FOR_WORKERS_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min default
// The documented cap, and the one a manager asking for "as long as possible"
// actually requests. It equals the long-poll ceiling exactly, which is safe
// only because the MCP client's own deadline sits a full minute above it.
const WAIT_FOR_WORKERS_MAX_TIMEOUT_MS = ORCHESTRATION_LONG_POLL_CEILING_MS;
// Composing the timeout response is not free: it re-reads every worker's final
// report off disk and peeks the manager inbox. Returning at exactly the
// requested deadline therefore puts the WRITE after it. Stop polling slightly
// early so the response is serialized inside the caller's budget.
const WAIT_FOR_WORKERS_RESPONSE_RESERVE_MS = 2_000;

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
  const deadline =
    Date.now() + Math.max(WAIT_FOR_WORKERS_POLL_MS, requestedTimeout - WAIT_FOR_WORKERS_RESPONSE_RESERVE_MS);
  const resolveLatestReplacement = (run: RunState, requestedTaskId: string) => {
    let current = run.workerTasks.find((task) => task.id === requestedTaskId) ?? null;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      const replacement = [...run.workerTasks]
        .reverse()
        .find((task) => task.supersedesTaskId === current?.id);
      if (!replacement) break;
      current = replacement;
    }
    return current;
  };
  const snapshotWorkers = async (run: RunState): Promise<{
    worker_task_id: string;
    requested_worker_task_id?: string;
    task_status: string | null;
    attempt_status: string | null;
    runtime: string | null;
    started_at: string | null;
    finished_at: string | null;
    final_report_path: string | null;
    final_report: unknown;
    is_terminal: boolean;
  }[]> =>
    Promise.all(workerTaskIds.map(async (wtid) => {
      const task = resolveLatestReplacement(run, wtid);
      const lastAttempt = task
        ? [...run.workerAttempts].reverse().find((a) => a.workerTaskId === task.id)
        : null;
      const taskStatus = task ? task.status : null;
      const report = lastAttempt?.finalReportPath
        ? await runStore.readWorkerReport(lastAttempt.finalReportPath).catch(() => null)
        : null;
      return {
        worker_task_id: task?.id ?? wtid,
        ...(task && task.id !== wtid ? { requested_worker_task_id: wtid } : {}),
        task_status: taskStatus,
        attempt_status: lastAttempt?.status ?? null,
        runtime: lastAttempt?.runtime ?? task?.runtimePreference ?? null,
        started_at: lastAttempt?.startedAt ?? null,
        finished_at: lastAttempt?.finishedAt ?? null,
        final_report_path: lastAttempt?.finalReportPath ?? null,
        final_report: report
          ? {
              status: report.status,
              summary: report.summary,
              files_changed: report.filesChanged,
              proof: report.proof.slice(0, 8),
              risks: report.risks.slice(0, 6),
              followups: report.followups.slice(0, 6),
              // Reusable work this attempt left on disk. Codara already injects
              // it into the next worker's prompt; surfacing it here lets the
              // manager see WHY a follow-up will be cheap instead of assuming
              // it must re-plan from scratch.
              ...(report.handoff?.length ? { handoff: report.handoff } : {}),
              verifier: report.verifier
                ? {
                    status: report.verifier.status,
                    confidence: report.verifier.confidence,
                    failed_claims: report.verifier.atomicClaims
                      .filter((claim) => claim.verdict === "failed")
                      .slice(0, 8),
                    unsure_claims: report.verifier.atomicClaims
                      .filter((claim) => claim.verdict === "unsure")
                      .slice(0, 8),
                    corrective_prompt: report.verifier.correctivePrompt ?? null,
                    missing_oracle: report.verifier.missingOracle ?? null,
                  }
                : null,
            }
          : null,
        // A MANUAL task never advances past needs_review on its own: no
        // manager session reviews it, and its resolution comes from the
        // human-review escalation question (run-store's cycle completion). A
        // waiting coordinator must not hold to the timeout ceiling on a state
        // only the user can move; return with the report and the honest
        // needs_review status so the manager can read it and act.
        is_terminal:
          taskStatus !== null &&
          (TERMINAL_WORKER_TASK_STATUSES.has(taskStatus) ||
            (taskStatus === "needs_review" && task?.runtimePreference === "manual")),
      };
    }));
  const firstRun = await runStore.getRun(runId);
  if (!firstRun) return errorResponse(id, ERR_INVALID_PARAMS, `Run not found: ${runId}`);
  const blocked = rejectIfAutomationRun(firstRun, id, "codara_wait_for_workers");
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
  // User messages typed during this wait are NEVER delivered into the live
  // turn: they stay queued and the steering-followup scheduler starts a fresh
  // manager turn once this one settles. The wait therefore only reports worker
  // state and the manager inbox.
  const waitResult = async (
    snapshot: Awaited<ReturnType<typeof snapshotWorkers>>,
    reason: string,
  ): Promise<JsonRpcResponse> =>
    successResponse(id, {
      workers: snapshot.map(({ is_terminal: _t, ...rest }) => rest),
      manager_messages: await peekManagerInbox(runStore, runId),
      reason,
    });
  while (Date.now() < deadline) {
    // Client hung up - stop polling rather than block the loop for ~20 min.
    // Queued user messages are untouched by this return: the follow-up
    // scheduler and the next turn start own their delivery.
    if (clientGone(res)) {
      return errorResponse(id, ERR_INTERNAL, "wait_for_workers aborted: client disconnected");
    }
    const run = await runStore.getRun(runId);
    if (!run) return errorResponse(id, ERR_INVALID_PARAMS, `Run vanished mid-wait: ${runId}`);
    const snapshot = await snapshotWorkers(run);
    const terminalCount = snapshot.filter((w) => w.is_terminal).length;
    if (mode === "any" && terminalCount > 0) {
      return await waitResult(snapshot, "any_terminal");
    }
    if (mode === "all" && terminalCount === snapshot.length) {
      return await waitResult(snapshot, "all_terminal");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, WAIT_FOR_WORKERS_POLL_MS));
  }
  const finalRun = await runStore.getRun(runId);
  const finalSnapshot = await snapshotWorkers(finalRun ?? firstRun);
  return await waitResult(finalSnapshot, "timeout");
}

// Collect the manager's unread inbox (worker→manager messages and worker `all`
// broadcasts) at wait return time WITHOUT marking read: the wait response can
// be lost after this point (client socket drop, manager CLI turn timeout), and
// a destructive read there would silently swallow a blocked worker's question
// forever. Messages therefore re-surface on later waits until the manager
// acknowledges them via codara_check_messages (the only mark-read reader).
// Failures are swallowed - a mailbox hiccup must never fail the wait.
async function peekManagerInbox(
  runStore: Awaited<ReturnType<typeof getRunStore>>,
  runId: string,
): Promise<unknown[]> {
  try {
    return await runStore.readManagerInbox(runId, { markRead: false });
  } catch {
    return [];
  }
}

async function handleOrchestratorMessageWorkers(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const runId = stringParam(params, "runId");
  if (!runId) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  const to = stringParam(params, "to");
  if (!to) return errorResponse(id, ERR_INVALID_PARAMS, "to is required (a worker_task_id or \"all\")");
  const body = stringParam(params, "body");
  if (!body) return errorResponse(id, ERR_INVALID_PARAMS, "body is required");
  const subject = stringParam(params, "subject") ?? "";
  const runStore = await getRunStore();
  const run = await runStore.getRun(runId);
  if (!run) return errorResponse(id, ERR_INVALID_PARAMS, `Run not found: ${runId}`);
  const blocked = rejectIfAutomationRun(run, id, "codara_message_workers");
  if (blocked) return blocked;
  // Guard against addressing a worker that isn't in this run; "all" is always
  // valid (broadcast to the whole batch's mailbox).
  const recipient = to === "all" ? undefined : run.workerTasks.find((wt) => wt.id === to);
  if (to !== "all" && !recipient) {
    return errorResponse(id, ERR_INVALID_PARAMS, `unknown worker_task_id: ${to}`);
  }
  // Deliver regardless, but warn when the recipient will likely never read it:
  // solo-spawned workers were never briefed on the mailbox (no peer-comms
  // guidance in their prompt), and terminal workers are gone. Without the
  // warning the ok:true reads as "steering landed" - false confidence.
  let warning: string | undefined;
  if (recipient) {
    if (TERMINAL_WORKER_TASK_STATUSES.has(recipient.status)) {
      warning = `recipient ${to} is already terminal (${recipient.status}); the message will not be read`;
    } else if (!recipient.canRunParallel) {
      warning = `recipient ${to} was spawned solo and is not briefed on the mailbox; it is unlikely to read this (its prompt already contains its full task)`;
    }
  }
  try {
    const { id: messageId } = await runStore.sendManagerMessage(runId, to, subject, body);
    return successResponse(id, warning ? { ok: true, message_id: messageId, to, warning } : { ok: true, message_id: messageId, to });
  } catch (err) {
    return errorResponse(id, ERR_INTERNAL, (err as Error).message);
  }
}

async function handleOrchestratorCheckMessages(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const runId = stringParam(params, "runId");
  if (!runId) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  const runStore = await getRunStore();
  const run = await runStore.getRun(runId);
  if (!run) return errorResponse(id, ERR_INVALID_PARAMS, `Run not found: ${runId}`);
  const blocked = rejectIfAutomationRun(run, id, "codara_check_messages");
  if (blocked) return blocked;
  try {
    const messages = await runStore.readManagerInbox(runId, { markRead: true });
    return successResponse(id, { messages });
  } catch (err) {
    return errorResponse(id, ERR_INTERNAL, (err as Error).message);
  }
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
  const blocked = rejectIfAutomationRun(run, id, "codara_get_worker_status");
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
// Automation (loom) handlers. The MCP server proxies the codara_*_automation
// tools to these automation.* RPCs, and both the Automations Hub assist chat
// (SPARK_MCP_MODE=automation) and an ordinary auto/execute chat carry them, so
// the user can have Cora build and manage a loom in the conversation they are
// already in. What still fences them: the roster keeps them away from workers
// and studio sub-agents, every handler resolves the run by runId, loadJobForRun
// pins each loom to the calling chat's workspace, and requestUserConsent gates
// every mutation of an existing loom on an explicit in-chat approval.
// ---------------------------------------------------------------------------

const AUTOMATION_WAIT_POLL_MS = 2000;
const AUTOMATION_WAIT_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
// 19 min, deliberately UNDER the MCP server's 20-min transport timeout in
// postJsonRpc - so a max-length wait still returns a clean reason:"timeout"
// snapshot instead of the client tearing the socket down first.
const AUTOMATION_WAIT_MAX_TIMEOUT_MS = 19 * 60 * 1000;

/**
 * Whether an automation has reached a state worth returning to a waiting
 * architect. "stopped"/"blocked" are unambiguously terminal. "idle" is
 * overloaded - it is BOTH the pre-run resting state (iteration 0, never fired)
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
 * get_status). Automation mode is sold as read-only on the workspace - it may
 * only manage automations - so a chat in that mode must not be able to spawn,
 * complete, or steer execute-mode workers. On the Codex backend the globally-
 * installed MCP has no per-run env, so a Codex automation chat still SEES the
 * execute roster; this is the enforcement boundary for it (Claude automation
 * chats never see these tools - their per-run MCP config is mode-scoped).
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
 * Shared guard for every automation.* handler. Resolves the calling run.
 *
 * There is deliberately NO chat-mode check here any more: Cora manages
 * automations from an ordinary auto/execute chat, which is the whole point of
 * shipping the automation roster outside Automation mode. The remaining fences
 * are the ones that still mean something:
 *   - the ROSTER: only the automation and execute MCP modes carry these tools,
 *     so a worker (SPARK_MCP_MODE=worker) and a plain studio sub-agent never see
 *     them. Same shape as board_update / whiteboard_update, and it is the only
 *     worker fence available: a structured worker inherits its loom run's
 *     SPARK_RUN_ID, so a worker call is indistinguishable from its manager's
 *     here.
 *   - loadJobForRun: a chat may only touch looms in its OWN workspace.
 *   - requestUserConsent: every mutation of an EXISTING loom needs the user's
 *     explicit in-chat approval.
 * Returns the loaded run on success, or a ready-to-return error response.
 */
async function resolveAutomationCallerRun(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<{ run: RunState } | { error: JsonRpcResponse }> {
  const runId = stringParam(params, "runId");
  if (!runId) return { error: errorResponse(id, ERR_INVALID_PARAMS, "runId is required") };
  const runStore = await getRunStore();
  const run = await runStore.getRun(runId);
  if (!run) return { error: errorResponse(id, ERR_INVALID_PARAMS, `Run not found: ${runId}`) };
  if (runProjectPolicyMode(run) === "untrusted-pull-request") {
    return {
      error: errorResponse(
        id,
        ERR_FORBIDDEN,
        "automations are unavailable for an imported pull-request run",
      ),
    };
  }
  return { run };
}

/**
 * Resolve an automation by id AND enforce that it belongs to the calling
 * chat's workspace. The Automations Hub only ever shows looms whose
 * `input.workspaceId` matches the active workspace (AutomationsHub filters on
 * exactly this field), so an architect chat must see and mutate the same set -
 * otherwise it "sees" (and could edit/delete) looms from other workspaces the
 * user can't even see in the panel, which produced the phantom-duplicate report.
 * Returns the loaded job on success, or a ready-to-return error response
 * (not-found, or a helpful "belongs to a different workspace" message).
 */
async function loadJobForRun(
  automationId: string,
  run: RunState,
  id: JsonRpcId,
): Promise<{ job: ScheduledJob } | { error: JsonRpcResponse }> {
  const { getJob } = await getScheduler();
  const job = await getJob(automationId);
  if (!job) {
    return { error: errorResponse(id, ERR_INVALID_PARAMS, `automation not found: ${automationId}`) };
  }
  if (job.input?.workspaceId !== run.workspaceId) {
    return {
      error: errorResponse(
        id,
        ERR_INVALID_PARAMS,
        `automation "${job.name}" (${automationId}) belongs to a different workspace and can't be accessed or changed from this chat. ` +
          `Only automations in this chat's workspace are available; call codara_list_automations to see them.`,
      ),
    };
  }
  return { job };
}

// ── Consent gate for destructive automation edits ───────────────────────────
// The architect model may freely CREATE looms, but it must not modify or delete
// an EXISTING loom without the user's explicit approval - enforced here on the
// server so the model cannot bypass it via prompt injection. Mechanism mirrors
// handleOrchestratorAskUser: post a blocking `question` message with quick-pick
// options, then long-poll the run's humanMessages for the user's answer, giving
// up if the MCP client disconnects (clientGone) or the deadline passes.
const CONSENT_POLL_MS = 500;
const CONSENT_TIMEOUT_MS = 15 * 60 * 1000; // 15 min - matches ask_user's AFK budget
// Explicit affirmatives only. Anything else (including "Deny", "Not now", a
// stray chat message, or free-form text) FAILS SAFE to a decline - a consent
// gate must never treat ambiguity as approval.
const CONSENT_ALLOW_ANSWERS: ReadonlySet<string> = new Set([
  "allow",
  "approve",
  "approved",
  "yes",
  "confirm",
  "ok",
]);

/**
 * Post a consent question and block until the user answers. Returns
 * `{ approved: true }` only on an explicit affirmative; otherwise returns
 * `{ approved: false, response }` with a ready-to-return response the caller
 * hands straight back to the model:
 *   - decline / timeout → an error-SHAPED SUCCESS `{ approved:false, message }`
 *     so the model can read it and narrate to the user instead of retrying.
 *   - client disconnected / run vanished → a JSON-RPC error (the socket is
 *     usually already dead, so this is a no-op write, same as ask_user).
 *
 * NOTE: the run-store's question normalizer discards option sets with fewer than
 * 3 entries and substitutes generic fallbacks, so we always supply three (one
 * allow + two decline variants) to guarantee the real Allow/Deny buttons render.
 */
// One consent gate per run at a time. Claude/Codex issue parallel tool_use
// blocks, and the MCP server services each tools/call as an independent HTTP
// request - without serialization, two gates could poll concurrently and a
// single Allow click would approve BOTH (the UI only surfaces the latest open
// question, so the user would never even see the second one).
const pendingConsentRuns = new Set<string>();

async function requestUserConsent(opts: {
  runStore: Awaited<ReturnType<typeof getRunStore>>;
  runId: string;
  res: ServerResponse;
  id: JsonRpcId;
  question: string;
  denyMessage: string;
}): Promise<{ approved: true } | { approved: false; response: JsonRpcResponse }> {
  const { runStore, runId, res, id, question, denyMessage } = opts;
  if (pendingConsentRuns.has(runId)) {
    return {
      approved: false,
      response: successResponse(id, {
        approved: false,
        message:
          "Another change is already awaiting the user's approval in this chat. " +
          "Wait for that answer before requesting a new one. Do not retry immediately.",
      }),
    };
  }
  pendingConsentRuns.add(runId);
  try {
    // Unique clientMessageId per ask: identifies the question message we just
    // posted (so answers can be matched to IT), and marks a re-ask with
    // identical diff text as a distinct question for the dedup swallow.
    const askClientId = `consent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let questionMessageId: string | undefined;
    try {
      const posted = await runStore.postRunQuestion({
        runId,
        clientMessageId: askClientId,
        message: question,
        questionOptions: [
          { id: "allow", label: "Allow", description: "Apply this change now", answer: "Allow", recommended: true },
          { id: "deny", label: "Deny", description: "Do not make this change", answer: "Deny" },
          { id: "not_now", label: "Not now", description: "Skip this change for now", answer: "Not now" },
        ],
        category: "destructive_irreversible",
        reason: "Changing an automation requires explicit user approval.",
        recommendedOptionId: "allow",
        source: "consent_gate",
        resumeStrategy: "active_rpc",
      });
      questionMessageId = posted.questionMessageId;
    } catch (err) {
      return { approved: false, response: errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message) };
    }
    if (!questionMessageId) {
      // The ask was swallowed (shouldn't happen with a unique clientMessageId,
      // but a gate polling for an invisible question would hang 15 minutes).
      return {
        approved: false,
        response: errorResponse(id, ERR_INTERNAL, "consent question could not be posted"),
      };
    }

    const deadline = Date.now() + CONSENT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, CONSENT_POLL_MS));
      if (clientGone(res)) {
        await runStore.releaseRunQuestion(runId, questionMessageId).catch(() => undefined);
        return {
          approved: false,
          response: errorResponse(id, ERR_INTERNAL, "consent request aborted: client disconnected"),
        };
      }
      const run = await runStore.getRun(runId);
      if (!run) {
        return {
          approved: false,
          response: errorResponse(id, ERR_INVALID_PARAMS, `Run vanished mid-consent: ${runId}`),
        };
      }
      // Cancellation or an explicit pause always wins over a linked Allow that
      // may have landed just before this poll tick. Never mutate automations from
      // a consent request whose run is no longer active.
      if (runQuestionWasAbandoned(run.status)) {
        return {
          approved: false,
          response: successResponse(id, {
            approved: false,
            message: "The run was paused or cancelled, so this change was NOT applied.",
          }),
        };
      }
      // ONLY answers explicitly linked to THIS question count. An unlinked
      // affirmative - the user answering some other question the model asked
      // in the same turn, or typing a casual "ok" into the chat - must never
      // approve a change. (Without the link, codara_ask_user("…yes/no?") fired
      // alongside the gated call could harvest the user's "yes" - a live
      // bypass found in adversarial review.)
      const answer = [...run.humanMessages]
        .reverse()
        .find(
          (m) =>
            m.author === "user" &&
            m.kind === "answer" &&
            m.answersMessageId === questionMessageId,
        );
      if (answer) {
        const normalized = answer.message.trim().toLowerCase();
        if (CONSENT_ALLOW_ANSWERS.has(normalized)) return { approved: true };
        // Linked but not an affirmative: Deny, Not now, or free-form typed
        // into this question's card - all fail safe to a decline.
        return { approved: false, response: successResponse(id, { approved: false, message: denyMessage }) };
      }
      if (
        run.status !== "blocked" ||
        run.blockedOn?.questionMessageId !== questionMessageId
      ) {
        return {
          approved: false,
          response: successResponse(id, {
            approved: false,
            message: "Question ownership ended before approval, so this change was NOT applied.",
          }),
        };
      }
    }
    await runStore.releaseRunQuestion(runId, questionMessageId).catch(() => undefined);
    return {
      approved: false,
      response: successResponse(id, {
        approved: false,
        message:
          "No response from the user before the request timed out, so the change was NOT applied. " +
          "Ask the user again if they still want it.",
      }),
    };
  } finally {
    pendingConsentRuns.delete(runId);
  }
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
      worker?: { engine?: unknown; model?: unknown; effort?: unknown };
      access?: unknown;
      blockedTools?: unknown;
      collab?: unknown;
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
      // Per-type required payload - the engine dereferences these directly, so a
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
      // node.worker is dereferenced (n.worker.model) by advance/relaunch waves;
      // a missing/garbage worker crashes the pass mid-flight. Require it - and
      // require it CONCRETE (explicit model + effort): the architect must pin
      // both per worker, a blank model/effort no longer exists.
      const werr = validateConcreteWorker(node.worker, `worker node ${node.id}`);
      if (werr) return werr;
      // Optional per-worker tool access + collaboration (Looms v2.5). All absent
      // = full access, no collaboration (the pre-feature default).
      const aerr = validateWorkerAccessFields(node, `worker node ${node.id}`);
      if (aerr) return aerr;
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

// The model/effort an architect-supplied worker MUST pin. Automations run on
// the bundled Pi runtime, so there is no engine choice: the model id alone
// selects the provider (claude-* → anthropic, gpt-* → openai-codex). (Runtime
// resolution still tolerates a legacy spec loaded from disk; this strictness
// is only on the create/update path so the architect corrects itself.)
const WORKER_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/** Reject any worker that fails to pin a non-blank claude-* or gpt-* model and
 *  a valid effort, or that still tries to pick an engine. Returns an
 *  instructive error naming the offending worker (so the architect fixes it),
 *  or null when concrete. */
function validateConcreteWorker(
  worker: { engine?: unknown; model?: unknown; effort?: unknown } | undefined,
  label: string,
): string | null {
  if (!worker || typeof worker !== "object") {
    return `${label} requires a worker config with an explicit model and effort`;
  }
  if (worker.engine !== undefined) {
    return `${label} sets 'engine', but automations run on Pi; pick model and effort only (drop the engine field; claude-* models use the Anthropic subscription, gpt-* models use the Codex subscription)`;
  }
  if (typeof worker.model !== "string" || worker.model.trim().length === 0) {
    return `${label} must set an explicit model (${ALLOWED_WORKER_MODELS.join(", ")}), a blank/default model is not allowed`;
  }
  const trimmed = worker.model.trim();
  if (/^gpt-/i.test(trimmed)) {
    // Lowercase before validating AND persisting: OpenAI model ids are
    // lowercase, so "GPT-5.6-Sol" would otherwise be stored as-is and match no
    // picker row in NodeContextPanel. Also migrates legacy ids from a
    // long-lived architect session onto the current Codex catalog.
    const normalized = normalizeCodexModelId(trimmed).toLowerCase();
    // Shape check, not an allow-list: a typo that breaks the gpt-* shape is
    // caught while a genuinely new GPT model goes through.
    if (!/^gpt-[a-z0-9.\-]+$/.test(normalized)) {
      return `${label} has an invalid model '${worker.model}': expected a gpt-* id such as ${CODEX_MODEL_CATALOG.map((model) => model.id).join(", ")}`;
    }
    worker.model = normalized;
  } else {
    // Lowercase claude ids too: Pi's provider gate (validateProviderModel)
    // does a case-SENSITIVE startsWith("claude-"), so a persisted
    // "Claude-Opus-5" would throw at every launch and permanently brick the
    // loom. Anthropic ids are lowercase-only, so this loses nothing.
    const lowered = trimmed.toLowerCase();
    if (!/^claude-[a-z0-9.\-]+$/.test(lowered)) {
      return `${label} has an invalid model '${worker.model}': expected a claude-* or gpt-* model id (recommended: ${ALLOWED_WORKER_MODELS.join(", ")})`;
    }
    worker.model = lowered;
  }
  if (typeof worker.effort !== "string" || !WORKER_EFFORTS.has(worker.effort)) {
    return `${label} must set an explicit effort: one of minimal, low, medium, high, xhigh, max (a blank/default effort is not allowed)`;
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
    // Per-kind required payload - the scheduler arms these directly, so a bad
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
        return `trigger.automationId '${t.automationId}' does not match any existing automation (call codara_list_automations to find a valid id)`;
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
    // engine's hardCap silently collapses the loop to a single pass - reject
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
    const err = validateConcreteWorker(opts.worker, "worker");
    if (err) return err;
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
  const guard = await resolveAutomationCallerRun(params, id);
  if ("error" in guard) return guard.error;
  const { run } = guard;
  try {
    const { listJobs } = await getScheduler();
    const jobs = await listJobs();
    // Scope to THIS chat's workspace so the architect sees exactly the looms the
    // Automations Hub shows (it filters on the same input.workspaceId). Returning
    // the unfiltered cross-workspace list is what made the architect "see" looms
    // the user had already deleted/hidden in other workspaces (phantom dupes).
    const scoped = jobs.filter((job) => job.input?.workspaceId === run.workspaceId);
    return successResponse(id, { automations: scoped.map(summarizeJob) });
  } catch (err) {
    return errorResponse(id, ERR_INTERNAL, (err as Error).message);
  }
}

async function handleAutomationGet(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const guard = await resolveAutomationCallerRun(params, id);
  if ("error" in guard) return guard.error;
  const automationId = stringParam(params, "automation_id");
  if (!automationId) return errorResponse(id, ERR_INVALID_PARAMS, "automation_id is required");
  try {
    const jobGuard = await loadJobForRun(automationId, guard.run, id);
    if ("error" in jobGuard) return jobGuard.error;
    const { job } = jobGuard;
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
  const guard = await resolveAutomationCallerRun(params, id);
  if ("error" in guard) return guard.error;
  const { run } = guard;
  const name = stringParam(params, "name");
  if (!name) return errorResponse(id, ERR_INVALID_PARAMS, "name is required");
  const trigger = paramTrigger(params);
  if (!trigger) return errorResponse(id, ERR_INVALID_PARAMS, "trigger (with a 'kind') is required");
  const loop = paramLoop(params);
  if (!loop) return errorResponse(id, ERR_INVALID_PARAMS, "loop (with a 'kind' and 'stop') is required");
  if (!loop.stop || typeof loop.stop !== "object") {
    // Normalize a missing stop block to an empty cap set rather than rejecting -
    // the scheduler treats {} as "rely on engine defaults".
    loop.stop = {};
  }
  const worker = paramWorker(params);
  if (!worker) {
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      "worker is required: set an explicit model and effort (automations run on the bundled Pi runtime)",
    );
  }
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
  // never supplies paths - the automation runs in the same workspace as the
  // chat that created it. Unlike the one-shot spawn_workers analog we do NOT
  // fall back to process.cwd(): this cwd is persisted into a RECURRING job, and
  // a guessed path (process.cwd() is "/" in a packaged macOS app) would silently
  // bind the loom to the wrong directory. createRun always stamps
  // settingsSnapshot.workspaceCwd, so a missing value is a real anomaly - fail
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
      ...(run.origin ? { origin: run.origin } : {}),
      projectPolicyMode: runProjectPolicyMode(run),
    },
    // Record the authoring conversation whenever a real chat authored the loom,
    // whether that was the Hub's assist chat or an ordinary auto/execute chat
    // (the Hub's "Open chat" button follows this pointer). run.automationId being
    // set means a loom-owned iteration run, which we don't back-link: that would
    // point the button at a machine run rather than a conversation.
    createdByRunId: run.automationId ? undefined : run.id,
  };
  try {
    const { createJob } = await getScheduler();
    const job = await createJob(createInput);
    return successResponse(id, { created: summarizeJob(job) });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

/**
 * Human-readable one-liners describing what an update patch changes, relative to
 * the loom's current state - fed into the consent question so the user knows
 * exactly what they're approving. Only fields the patch actually carries are
 * listed; unchanged fields are omitted.
 */
function describeUpdate(existing: ScheduledJob, update: UpdateScheduledJobInput): string[] {
  const lines: string[] = [];
  if (update.name !== undefined && update.name !== existing.name) {
    lines.push(`name: "${existing.name}" → "${update.name}"`);
  }
  if (update.trigger !== undefined) {
    lines.push(`trigger: ${summarizeTrigger(existing.trigger)} → ${summarizeTrigger(update.trigger)}`);
  }
  if (update.loop !== undefined) {
    lines.push(`loop: ${summarizeLoop(existing.loop)} → ${summarizeLoop(update.loop)}`);
  }
  if (update.prompt !== undefined) {
    // Show actual content, not just "updated" - the user is approving a
    // prompt rewrite and must be able to see what it becomes (a blind
    // "prompt template updated" line makes malicious rewrites invisible).
    const clip = (s: string | undefined): string => {
      const one = (s ?? "").replace(/\s+/g, " ").trim();
      if (!one) return "(empty)";
      return one.length > 140 ? `${one.slice(0, 137)}...` : one;
    };
    const oldTemplate = existing.prompt?.template;
    const newTemplate = update.prompt?.template;
    lines.push(`prompt: "${clip(oldTemplate)}" → "${clip(newTemplate)}"`);
  }
  if (update.worker !== undefined) {
    const w = update.worker;
    const ew = existing.worker;
    const fmt = (x?: LoomWorkerConfig): string =>
      x ? [x.model, x.effort].filter(Boolean).join("/") : "(unset)";
    lines.push(`worker: ${fmt(ew)} → ${fmt(w)}`);
  }
  if (update.graph !== undefined) {
    const n = update.graph.nodes?.length ?? 0;
    const e = update.graph.edges?.length ?? 0;
    lines.push(`graph updated (${n} node${n === 1 ? "" : "s"}, ${e} edge${e === 1 ? "" : "s"})`);
  }
  return lines;
}

async function handleAutomationUpdate(
  params: Record<string, unknown>,
  id: JsonRpcId,
  res: ServerResponse,
): Promise<JsonRpcResponse> {
  const guard = await resolveAutomationCallerRun(params, id);
  if ("error" in guard) return guard.error;
  const { run } = guard;
  const automationId = stringParam(params, "automation_id");
  if (!automationId) return errorResponse(id, ERR_INVALID_PARAMS, "automation_id is required");
  const graph = paramGraph(params);
  if (graph) {
    const graphErr = validateGraph(graph);
    if (graphErr) return errorResponse(id, ERR_INVALID_PARAMS, `invalid graph: ${graphErr}`);
  }
  // Validate ONLY the structural fields actually supplied - update is a patch,
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
  // Resolve + workspace-scope the target job. loadJobForRun also gives us the
  // pre-edit snapshot for the human-readable change summary.
  const jobGuard = await loadJobForRun(automationId, run, id);
  if ("error" in jobGuard) return jobGuard.error;
  const { job: existing } = jobGuard;

  // Consent gate: editing an EXISTING loom requires explicit user approval,
  // enforced here so the model cannot bypass it.
  const changeLines = describeUpdate(existing, update);
  const changeSummary = changeLines.length > 0 ? changeLines.map((l) => `• ${l}`).join("\n") : "(no field changes detected)";
  const runStore = await getRunStore();
  const consent = await requestUserConsent({
    runStore,
    runId: run.id,
    res,
    id,
    question: `Cora wants to edit automation "${existing.name}". Proposed changes:\n${changeSummary}\n\nAllow this edit?`,
    denyMessage:
      `The user declined the edit, so automation "${existing.name}" was left unchanged. ` +
      "Do not retry the update; ask the user how they'd like to proceed.",
  });
  if (!consent.approved) return consent.response;

  try {
    const { updateJob } = await getScheduler();
    const job = await updateJob(update);
    return successResponse(id, {
      updated: summarizeJob(job),
      approved: true,
      message: "The user approved the edit; the changes were applied.",
    });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

async function handleAutomationRunNow(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const guard = await resolveAutomationCallerRun(params, id);
  if ("error" in guard) return guard.error;
  const automationId = stringParam(params, "automation_id");
  if (!automationId) return errorResponse(id, ERR_INVALID_PARAMS, "automation_id is required");
  const jobGuard = await loadJobForRun(automationId, guard.run, id);
  if ("error" in jobGuard) return jobGuard.error;
  try {
    const { runJobNow } = await getScheduler();
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
  const guard = await resolveAutomationCallerRun(params, id);
  if ("error" in guard) return guard.error;
  const automationId = stringParam(params, "automation_id");
  if (!automationId) return errorResponse(id, ERR_INVALID_PARAMS, "automation_id is required");
  const requested = optionalNumberParam(params, "timeout_ms");
  const timeoutMs =
    requested && requested > 0
      ? Math.min(requested, AUTOMATION_WAIT_MAX_TIMEOUT_MS)
      : AUTOMATION_WAIT_DEFAULT_TIMEOUT_MS;
  const jobGuard = await loadJobForRun(automationId, guard.run, id);
  if ("error" in jobGuard) return jobGuard.error;
  const { getJob } = await getScheduler();
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
  res: ServerResponse,
): Promise<JsonRpcResponse> {
  const guard = await resolveAutomationCallerRun(params, id);
  if ("error" in guard) return guard.error;
  const automationId = stringParam(params, "automation_id");
  if (!automationId) return errorResponse(id, ERR_INVALID_PARAMS, "automation_id is required");
  if (typeof params.enabled !== "boolean") {
    return errorResponse(id, ERR_INVALID_PARAMS, "enabled (boolean) is required");
  }
  const jobGuard = await loadJobForRun(automationId, guard.run, id);
  if ("error" in jobGuard) return jobGuard.error;
  // Enabling/disabling is a state change the user relies on (silently
  // disabling a loom they depend on - or re-arming one they deliberately
  // turned off - is a modification), so it takes the same consent gate as
  // update/delete. No-op toggles skip the ask.
  if (jobGuard.job.enabled !== params.enabled) {
    const runStore = await getRunStore();
    const verb = params.enabled ? "enable" : "disable";
    const consent = await requestUserConsent({
      runStore,
      runId: guard.run.id,
      res,
      id,
      question: `Cora wants to ${verb} automation "${jobGuard.job.name}". Allow?`,
      denyMessage: `The user declined to ${verb} "${jobGuard.job.name}". Do not retry; ask the user how they'd like to proceed.`,
    });
    if (!consent.approved) return consent.response;
  }
  try {
    const { setEnabled } = await getScheduler();
    const job = await setEnabled(automationId, params.enabled);
    return successResponse(id, { updated: summarizeJob(job), approved: true });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

async function handleAutomationPause(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const guard = await resolveAutomationCallerRun(params, id);
  if ("error" in guard) return guard.error;
  const automationId = stringParam(params, "automation_id");
  if (!automationId) return errorResponse(id, ERR_INVALID_PARAMS, "automation_id is required");
  const jobGuard = await loadJobForRun(automationId, guard.run, id);
  if ("error" in jobGuard) return jobGuard.error;
  try {
    const { pauseJob } = await getScheduler();
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
  const guard = await resolveAutomationCallerRun(params, id);
  if ("error" in guard) return guard.error;
  const automationId = stringParam(params, "automation_id");
  if (!automationId) return errorResponse(id, ERR_INVALID_PARAMS, "automation_id is required");
  const jobGuard = await loadJobForRun(automationId, guard.run, id);
  if ("error" in jobGuard) return jobGuard.error;
  try {
    const { resumeJob } = await getScheduler();
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
  const guard = await resolveAutomationCallerRun(params, id);
  if ("error" in guard) return guard.error;
  const automationId = stringParam(params, "automation_id");
  if (!automationId) return errorResponse(id, ERR_INVALID_PARAMS, "automation_id is required");
  const jobGuard = await loadJobForRun(automationId, guard.run, id);
  if ("error" in jobGuard) return jobGuard.error;
  try {
    const { stopJob } = await getScheduler();
    const job = await stopJob(automationId);
    return successResponse(id, { updated: job ? summarizeJob(job) : null });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

async function handleAutomationDelete(
  params: Record<string, unknown>,
  id: JsonRpcId,
  res: ServerResponse,
): Promise<JsonRpcResponse> {
  const guard = await resolveAutomationCallerRun(params, id);
  if ("error" in guard) return guard.error;
  const { run } = guard;
  const automationId = stringParam(params, "automation_id");
  if (!automationId) return errorResponse(id, ERR_INVALID_PARAMS, "automation_id is required");
  const jobGuard = await loadJobForRun(automationId, run, id);
  if ("error" in jobGuard) return jobGuard.error;
  const { job: existing } = jobGuard;

  // Consent gate: deleting an existing loom is destructive and requires explicit
  // user approval, enforced server-side so the model cannot bypass it.
  const runStore = await getRunStore();
  const consent = await requestUserConsent({
    runStore,
    runId: run.id,
    res,
    id,
    question:
      `Cora wants to permanently delete automation "${existing.name}" (${automationId}). ` +
      "This cannot be undone. Allow?",
    denyMessage:
      `The user declined the deletion, so automation "${existing.name}" was NOT deleted. ` +
      "Do not retry the delete; ask the user how they'd like to proceed.",
  });
  if (!consent.approved) return consent.response;

  try {
    const { deleteJob } = await getScheduler();
    await deleteJob(automationId);
    return successResponse(id, {
      deleted: true,
      id: automationId,
      name: existing.name,
      approved: true,
      message: "The user approved the deletion; the automation was removed.",
    });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

// Cap on an AI-generated chat title. The architect is asked for a 3-6 word name;
// this is a hard backstop so a runaway title can't bloat the tab/header label.
const NAME_CHAT_MAX_CHARS = 60;

// Sanitize a proposed chat title from a *_name_chat tool call: strip newlines /
// control chars (they would break the single-line header and history rows) and
// truncate on CODE POINTS - a naive .slice() can bisect a surrogate pair,
// leaving a lone "�" in the UI. renameRun trims + rejects empty as a backstop.
// Shared by handleAutomationNameChat and handleOrchestratorNameChat so both
// name-chat surfaces sanitize identically.
function sanitizeChatTitle(rawTitle: string): string {
  const cleaned = rawTitle.replace(/[\r\n\t]+/g, " ").replace(/\p{C}/gu, "").trim();
  const codePoints = Array.from(cleaned);
  return codePoints.length > NAME_CHAT_MAX_CHARS
    ? codePoints.slice(0, NAME_CHAT_MAX_CHARS).join("").trim()
    : cleaned;
}

// automation.name_chat stays Automation-mode only, unlike the automation
// MANAGEMENT verbs above: it is the architect chat's half of the naming pair and
// orchestrator.name_chat is the auto/execute half, so an ordinary chat renaming
// itself must keep going through that one (it is also the only name_chat the
// execute MCP roster exposes).
async function handleAutomationNameChat(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const guard = await resolveAutomationCallerRun(params, id);
  if ("error" in guard) return guard.error;
  const { run } = guard;
  if (run.chatMode !== "automation") {
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      `automation.name_chat is only available for automation chats (this run's chatMode is "${run.chatMode ?? "unset"}"). Auto and Execute chats use orchestrator.name_chat.`,
    );
  }
  const rawTitle = stringParam(params, "title");
  if (!rawTitle) {
    return errorResponse(id, ERR_INVALID_PARAMS, "title is required (a short 3-6 word chat name)");
  }
  const title = sanitizeChatTitle(rawTitle);
  try {
    const runStore = await getRunStore();
    // renameRun emits a `run.renamed` event stamped with the run's workspaceId,
    // so AssistChat's workspace-scoped orchestration-event subscription refreshes
    // and the new title/short-id render live.
    const updated = await runStore.renameRun({ runId: run.id, title });
    return successResponse(id, { ok: true, run_id: updated.id, title: updated.title });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

// orchestrator.name_chat - the Execute/Auto manager's counterpart to
// automation.name_chat: give an ordinary chat an AI-authored title. Mirrors how
// the other orchestrator.* handlers load the run (getRun + not-found guard) and
// restricts to execute/auto chats: an automation chat must go through
// automation.name_chat (which enforces its own mode), and talk/plan chats have
// no orchestrator manager to call this.
async function handleOrchestratorNameChat(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const runId = stringParam(params, "runId");
  if (!runId) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  const rawTitle = stringParam(params, "title");
  if (!rawTitle) {
    return errorResponse(id, ERR_INVALID_PARAMS, "title is required (a short 3-6 word chat name)");
  }
  const runStore = await getRunStore();
  const run = await runStore.getRun(runId);
  if (!run) return errorResponse(id, ERR_INVALID_PARAMS, `Run not found: ${runId}`);
  if (runProjectPolicyMode(run) === "untrusted-pull-request") {
    return errorResponse(
      id,
      ERR_FORBIDDEN,
      "workspace and global memory are unavailable for an imported pull-request run",
    );
  }
  if (effectiveChatMode(run.chatMode) !== "auto") {
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      `orchestrator.name_chat is only available for auto chats (this run's chatMode is "${run.chatMode ?? "unset"}"). Automation chats use automation.name_chat.`,
    );
  }
  const title = sanitizeChatTitle(rawTitle);
  try {
    // renameRun emits `run.renamed` stamped with the run's workspaceId, so App's
    // orchestration-event refresh re-lists runs and the new title renders live in
    // the chat history popover.
    const updated = await runStore.renameRun({ runId: run.id, title });
    return successResponse(id, { ok: true, run_id: updated.id, title: updated.title });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

async function handleOrchestratorWhiteboardGet(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const runId = stringParam(params, "runId");
  if (!runId) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  const runStore = await getRunStore();
  const run = await runStore.getRun(runId);
  if (!run) return errorResponse(id, ERR_INVALID_PARAMS, `Run not found: ${runId}`);
  return successResponse(id, {
    run_id: run.id,
    whiteboard: run.whiteboard ?? null,
  });
}

async function handleOrchestratorWhiteboardUpdate(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const runId = stringParam(params, "runId");
  if (!runId) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  const rawAction = stringParam(params, "action") ?? "replace";
  if (rawAction !== "replace" && rawAction !== "merge" && rawAction !== "clear") {
    return errorResponse(id, ERR_INVALID_PARAMS, "action must be replace, merge, or clear");
  }
  const input: UpdateCoraWhiteboardInput = {
    runId,
    action: rawAction,
    editor: "cora",
    baseRevision:
      typeof params.baseRevision === "number" && Number.isFinite(params.baseRevision)
        ? Math.max(0, Math.floor(params.baseRevision))
        : undefined,
    title: stringParam(params, "title") ?? undefined,
    summary: stringParam(params, "summary") ?? undefined,
    nodes: Array.isArray(params.nodes)
      ? params.nodes as UpdateCoraWhiteboardInput["nodes"]
      : undefined,
    edges: Array.isArray(params.edges)
      ? params.edges as UpdateCoraWhiteboardInput["edges"]
      : undefined,
    removeNodeIds: Array.isArray(params.removeNodeIds)
      ? params.removeNodeIds.filter((value): value is string => typeof value === "string")
      : undefined,
    removeEdgeIds: Array.isArray(params.removeEdgeIds)
      ? params.removeEdgeIds.filter((value): value is string => typeof value === "string")
      : undefined,
  };
  try {
    const runStore = await getRunStore();
    const updated = await runStore.updateCoraWhiteboard(input);
    return successResponse(id, {
      ok: true,
      run_id: updated.id,
      whiteboard: updated.whiteboard ?? null,
    });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

// orchestrator.board_get / board_update, the Cora Board RPCs. The board
// belongs to the RUN: both handlers resolve the calling run's own board, so a
// run can never reach another chat's board (cross-run access is structurally
// impossible, not just forbidden). Available in every chat mode - a Talk-mode
// conversation about what to do next is exactly when reading and adding cards
// is useful - so unlike the automation RPCs there is no mode gate here.
// board_get also triggers the one-time legacy workspace-board adoption (see
// run-store.getRunBoard).
async function handleOrchestratorBoardGet(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const runId = stringParam(params, "runId");
  if (!runId) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  const runStore = await getRunStore();
  const run = await runStore.getRun(runId);
  if (!run) return errorResponse(id, ERR_INVALID_PARAMS, `Run not found: ${runId}`);
  try {
    const board = await runStore.getRunBoard(run.id);
    return successResponse(id, {
      run_id: run.id,
      board,
    });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

// What an AGENT may do to its own chat's board, enforced here rather than in
// the store - the renderer's board:update IPC is the user acting directly and
// keeps full control, while this path is a model whose input includes whatever
// it just read from the repo, the web, or a tool result.
//
// Under the per-chat model the run's manager WORKS the board, so it holds full
// card powers on its own board:
//   - It may CREATE cards in any lane and MOVE or EDIT any card (title,
//     description, order, status, error note) - moving the user's queued card
//     to "running" when its worker launches is the whole point.
//   - It may stamp workerTaskId, but only with a worker task that actually
//     belongs to this run (context.workerTaskIds) - the card→terminal link
//     must never point into another chat's workers.
//   - It may DELETE only cards it created itself (createdBy "agent"). A card
//     the user wrote is the user's: Cora asks instead of deleting.
//   - runId (the legacy link), createdBy, and imagePaths are never taken from
//     the payload; the stored values are preserved (the store enforces the
//     same carry-over, so this is belt and braces).
//
// Returns the sanitized card list to persist, or a message explaining the
// refusal in terms the model can act on.
type AgentBoardWriteResult = { cards: BoardCard[] } | { error: string };

export interface AgentBoardWriteContext {
  /** Worker-task ids belonging to the calling run - the only values a card's
   * workerTaskId may be set to. */
  workerTaskIds: ReadonlySet<string>;
}

const AGENT_BOARD_STATUSES: ReadonlySet<string> = new Set<BoardCardStatus>([
  "idea",
  "queued",
  "running",
  "blocked",
  "review",
  "done",
  "failed",
]);

// Exported for scripts/test-board-agent-writes.cjs - this is the boundary that
// keeps a prompt-injected model from deleting the user's cards or pointing a
// card at another run's worker, so it is worth testing directly rather than
// only through the socket.
export function authorizeAgentBoardWrite(
  currentCards: BoardCard[],
  incoming: unknown[],
  context: AgentBoardWriteContext,
): AgentBoardWriteResult {
  const currentById = new Map(currentCards.map((card) => [card.id, card]));
  const seen = new Set<string>();
  const cards: BoardCard[] = [];
  const now = new Date().toISOString();

  for (const entry of incoming) {
    if (!entry || typeof entry !== "object") {
      return { error: "Every item in cards must be a card object." };
    }
    const source = entry as Record<string, unknown>;
    const cardId = typeof source.id === "string" ? source.id.trim() : "";
    if (!cardId) return { error: "Every card needs a non-empty string id." };
    if (seen.has(cardId)) return { error: `Duplicate card id in the update: ${cardId}` };
    seen.add(cardId);

    const title = typeof source.title === "string" ? source.title.trim() : "";
    if (!title) return { error: `Card ${cardId} needs a non-empty title.` };
    const status = typeof source.status === "string" ? source.status : "";
    if (status && !AGENT_BOARD_STATUSES.has(status)) {
      return {
        error: `Card ${cardId} has unknown status "${status}". Valid lanes: idea, queued, running, blocked, review, done, failed.`,
      };
    }
    const description =
      typeof source.description === "string" ? source.description.trim() : undefined;
    const order =
      typeof source.order === "number" && Number.isFinite(source.order) ? source.order : undefined;
    const errorNote = typeof source.error === "string" ? source.error.trim() : undefined;

    const workerTaskIdRaw = source.workerTaskId;
    let workerTaskId: string | undefined;
    if (typeof workerTaskIdRaw === "string" && workerTaskIdRaw.trim()) {
      workerTaskId = workerTaskIdRaw.trim();
      const existing = currentById.get(cardId);
      if (workerTaskId !== existing?.workerTaskId && !context.workerTaskIds.has(workerTaskId)) {
        return {
          error: `Card ${cardId} names workerTaskId "${workerTaskId}", which is not a worker task of this run. Use an id returned by codara_spawn_workers.`,
        };
      }
    }

    const existing = currentById.get(cardId);
    if (!existing) {
      const created: BoardCard = {
        id: cardId,
        title,
        status: (status || "idea") as BoardCardStatus,
        createdBy: "agent",
        order: order ?? currentCards.length + cards.length,
        createdAt: now,
        updatedAt: now,
      };
      if (description) created.description = description;
      if (errorNote) created.error = errorNote;
      if (workerTaskId) created.workerTaskId = workerTaskId;
      cards.push(created);
      continue;
    }

    // Server-owned fields (runId, createdBy, imagePaths, createdAt) always
    // come from the stored card; the store's normalize re-enforces this.
    const next: BoardCard = { ...existing };
    next.title = title;
    // Omitted or empty description keeps the stored one: the schema only
    // requires id/title/status/order, so a minimally compliant round-trip
    // must never strip a card's body. Edits send new non-empty text.
    if (description) next.description = description;
    if (order !== undefined) next.order = order;
    const statusChanged = Boolean(status) && status !== existing.status;
    if (status) next.status = status as BoardCardStatus;
    // The error note follows the lane it described: a fresh note wins, an
    // omitted note survives while the lane is unchanged, and a lane change
    // without a fresh note clears the stale one.
    if (errorNote) next.error = errorNote;
    else if (statusChanged) delete next.error;
    if (workerTaskId) next.workerTaskId = workerTaskId;
    next.updatedAt = now;
    cards.push(next);
  }

  // Deletion by omission is allowed only for the agent's own cards. A card the
  // user authored (createdBy "user", or a legacy card with no provenance) can
  // only be removed by the user.
  const removedUserCards = currentCards.filter(
    (card) => !seen.has(card.id) && card.createdBy !== "agent",
  );
  if (removedUserCards.length > 0) {
    return {
      error: `You may not delete cards the user created (missing: ${removedUserCards
        .map((card) => card.title)
        .slice(0, 5)
        .join(", ")}). Send them back unchanged, or ask the user to delete them.`,
    };
  }

  return { cards };
}

async function handleOrchestratorBoardUpdate(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const runId = stringParam(params, "runId");
  if (!runId) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  if (!Array.isArray(params.cards)) {
    return errorResponse(id, ERR_INVALID_PARAMS, "cards must be an array of board cards");
  }
  if (typeof params.baseRevision !== "number" || !Number.isFinite(params.baseRevision)) {
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      "baseRevision is required: call codara_board_get first and pass the revision it returned",
    );
  }
  const runStore = await getRunStore();
  const run = await runStore.getRun(runId);
  if (!run) return errorResponse(id, ERR_INVALID_PARAMS, `Run not found: ${runId}`);

  try {
    // getRunBoard (not run.board) so a first write on a legacy workspace
    // adopts the old cards before the authorization snapshot is taken.
    const current = await runStore.getRunBoard(run.id);
    const authorized = authorizeAgentBoardWrite(current.cards, params.cards, {
      workerTaskIds: new Set(run.workerTasks.map((task) => task.id)),
    });
    if ("error" in authorized) {
      return errorResponse(id, ERR_INVALID_PARAMS, authorized.error);
    }
    // A stale revision means a human drag landed first. updateRunBoardFromAgent
    // throws (mirroring the whiteboard's conflict) so the model re-reads
    // instead of treating a dropped write as success; the current revision
    // travels in the message so the retry can succeed.
    const board = await runStore.updateRunBoardFromAgent({
      runId: run.id,
      baseRevision: Math.max(0, Math.floor(params.baseRevision)),
      cards: authorized.cards,
    });
    return successResponse(id, {
      ok: true,
      run_id: run.id,
      board,
    });
  } catch (err) {
    return errorResponse(id, ERR_INVALID_PARAMS, (err as Error).message);
  }
}

// orchestrator.remember, the codara_remember tool's RPC (the MCP server maps
// the tool name onto this method). Only Cora, the Execute/Auto manager, holds
// this tool; workers never write memory. The heavy lifting (tag grammar,
// dedup, TTL, byte caps, the user-line preservation guardrail) lives in
// cora-memory.ts; this handler owns the per-run write budget, an in-memory
// map that resets on app restart by design.
const rememberBudgetByRun = new Map<string, { calls: number; bulletsAdded: number }>();
const REMEMBER_BUDGET_RUN_LIMIT = 256;

function rememberBudgetFor(runId: string): { calls: number; bulletsAdded: number } {
  let budget = rememberBudgetByRun.get(runId);
  if (!budget) {
    budget = { calls: 0, bulletsAdded: 0 };
    rememberBudgetByRun.set(runId, budget);
    while (rememberBudgetByRun.size > REMEMBER_BUDGET_RUN_LIMIT) {
      const oldest = rememberBudgetByRun.keys().next();
      if (oldest.done) break;
      rememberBudgetByRun.delete(oldest.value);
    }
  }
  return budget;
}

async function handleOrchestratorRemember(
  params: Record<string, unknown>,
  id: JsonRpcId,
): Promise<JsonRpcResponse> {
  const runId = stringParam(params, "runId");
  if (!runId) return errorResponse(id, ERR_INVALID_PARAMS, "runId is required");
  const scope = stringParam(params, "scope");
  if (scope !== "workspace" && scope !== "global") {
    return errorResponse(id, ERR_INVALID_PARAMS, 'scope must be "workspace" or "global"');
  }
  const action = stringParam(params, "action");
  if (action !== "add" && action !== "replace") {
    return errorResponse(id, ERR_INVALID_PARAMS, 'action must be "add" or "replace"');
  }
  const runStore = await getRunStore();
  const run = await runStore.getRun(runId);
  if (!run) return errorResponse(id, ERR_INVALID_PARAMS, `Run not found: ${runId}`);

  const budget = rememberBudgetFor(runId);
  if (budget.calls >= MAX_REMEMBER_CALLS_PER_RUN) {
    return errorResponse(
      id,
      ERR_INVALID_PARAMS,
      `memory write limit reached for this run (${MAX_REMEMBER_CALLS_PER_RUN} codara_remember calls): consolidate what you have, or ask the user to edit the file directly`,
    );
  }

  let bullets: string[] = [];
  if (action === "add") {
    const raw = Array.isArray(params.bullets) ? params.bullets : null;
    bullets = (raw ?? []).filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (!raw || bullets.length === 0 || bullets.length > 5) {
      return errorResponse(
        id,
        ERR_INVALID_PARAMS,
        'action "add" requires bullets: 1-5 plain strings (no tags; the tag is stamped for you)',
      );
    }
    if (budget.bulletsAdded + bullets.length > MAX_BULLETS_ADDED_PER_RUN) {
      return errorResponse(
        id,
        ERR_INVALID_PARAMS,
        `memory bullet limit reached for this run (${MAX_BULLETS_ADDED_PER_RUN} bullets): consolidate with action "replace" instead of adding more`,
      );
    }
  }
  const body = stringParam(params, "body");
  if (action === "replace" && body === null) {
    return errorResponse(id, ERR_INVALID_PARAMS, 'action "replace" requires body: the full new file content');
  }

  // The call consumes budget once it reaches the memory API, whether or not
  // the API accepts it: the budget exists to stop runaway write loops, and a
  // loop of rejected calls is still a loop.
  budget.calls += 1;
  try {
    const result =
      action === "add"
        ? await rememberAdd(scope as MemoryScope, run.workspaceId, bullets, runId)
        : await rememberReplace(
            scope as MemoryScope,
            run.workspaceId,
            body as string,
            params.confirm_drop_user_lines === true,
            runId,
          );
    if (action === "add") budget.bulletsAdded += bullets.length;
    return successResponse(id, {
      ok: true,
      bytes_used: result.bytesUsed,
      bytes_cap: result.bytesCap,
      message: result.message,
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
