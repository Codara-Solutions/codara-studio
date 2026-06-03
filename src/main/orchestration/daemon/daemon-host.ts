import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { SparkEvent } from "@shared/types";
import { sparkHome } from "../../spark-home";
import { writeFileAtomic } from "../../fs-atomic";
import { subscribeToEvents } from "../event-log";
import {
  DAEMON_HANDSHAKE_FILE,
  ERR_INTERNAL,
  ERR_INVALID_PARAMS,
  ERR_INVALID_REQUEST,
  ERR_NOT_IMPLEMENTED,
  LOOPBACK_HOST,
  RPC_PATH,
  makeDaemonError,
  parseDaemonRequest,
  type DaemonEventFrame,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonResponseFor,
} from "./daemon-ipc";

// ── Daemon host (SCAFFOLD) ──────────────────────────────────────────────────
//
// This is the headless process shape that COULD one day own the RunState +
// worker PTYs out-of-process, the way agent-socket.ts already hosts a loopback
// JSON-RPC server for sub-agents. It is modelled line-for-line on
// agent-socket.ts (loopback HTTP bind on 127.0.0.1:0, per-launch bearer token,
// handshake JSON written to sparkHome() so out-of-process clients can find the
// url+token), but with one deliberate difference: nothing here is auto-started.
//
// startDaemonHostServer() exists and works, but the integration point in
// index.ts calls only the inert registerDaemonHostScaffold() no-op below — it
// binds no socket and spawns no process, so cold startup stays exactly as cheap
// as it is today. Flipping the daemon on is a later phase (see
// docs/daemon-split-PLAN.md); until then this module is reachable, compiles
// against the real run-store entry points, and documents the seam.

// Bind loopback-only and use a constant-time token check so a hostile local
// process still cannot drive the daemon without the per-launch secret. Same
// posture as agent-socket.ts.
const MAX_REQUEST_BYTES = 256 * 1024;
const SOCKET_IDLE_TIMEOUT_MS = 30_000;

// Late-binding handle on run-store so this module — like agent-socket.ts:67-71
// — does NOT pull the orchestrator dependency tree into cold startup. The
// dynamic import only resolves the first time dispatch() actually handles a
// request, which (given the inert integration point) is "never" until a future
// phase wires the host on.
let runStoreMod: typeof import("../run-store") | undefined;
async function getRunStore(): Promise<typeof import("../run-store")> {
  runStoreMod ??= await import("../run-store");
  return runStoreMod;
}

interface DaemonHostHandle {
  server: Server;
  url: string;
  token: string;
}

let currentHandle: DaemonHostHandle | null = null;

/**
 * Start the daemon host JSON-RPC server. Binds 127.0.0.1 on a random ephemeral
 * port, mints a fresh per-process token, and writes the handshake file so an
 * out-of-process {@link DaemonClient} can discover the url+token (the same way
 * agent-socket.ts persists agent-socket.json for MCP children).
 *
 * Idempotent — repeated calls return the existing handle.
 *
 * GUARD: this is intentionally NOT invoked by the integration point in
 * index.ts. registerDaemonHostScaffold() is the inert seam that ships today;
 * starting a real socket is a later phase. Keeping startup a no-op is the whole
 * point of the scaffold-only split.
 */
export async function startDaemonHostServer(): Promise<DaemonHostHandle> {
  if (currentHandle) return currentHandle;

  const token = randomBytes(32).toString("hex");
  const server = createServer((req, res) => {
    handleRequest(req, res, token).catch((err) => {
      // handleRequest only rejects on unexpected errors — log and emit a
      // generic 500 so the client doesn't hang on a half-open response.
      console.error("[daemon-host] unhandled handler error", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      try {
        res.end(JSON.stringify(makeDaemonError(ERR_INTERNAL, "internal error")));
      } catch {
        /* socket may already be torn down */
      }
    });
  });

  // Don't leak handles on idle sockets.
  server.on("connection", (socket) => {
    socket.setKeepAlive(false);
    socket.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => {
      socket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("error", onError);
      reject(err);
    };
    server.on("error", onError);
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("[daemon-host] failed to determine listening address");
  }
  const url = `http://${LOOPBACK_HOST}:${address.port}`;
  currentHandle = { server, url, token };
  // Persist the handshake so an out-of-process daemon-client (or a relaunched
  // renderer) can pick up the current url+token without inheriting env. Best
  // effort: a failed write only means a client has to back off and retry.
  void writeHandshakeFile({ url, token }).catch((err) =>
    console.warn("[daemon-host] failed to write handshake file:", err),
  );
  return currentHandle;
}

/** Stop the host. Symmetric to stopAgentSocket() — safe to call repeatedly. */
export async function stopDaemonHost(): Promise<void> {
  const handle = currentHandle;
  if (!handle) return;
  currentHandle = null;
  // Remove the handshake so a surviving client returns "daemon offline" on its
  // next call instead of dialing a closed port.
  await fsp.rm(handshakeFilePath(), { force: true }).catch(() => undefined);
  await new Promise<void>((resolve) => {
    handle.server.close(() => resolve());
    // close() waits for open connections — force the issue so quit doesn't hang
    // behind a stuck long-poll, same as agent-socket.ts.
    handle.server.closeAllConnections?.();
  });
}

function handshakeFilePath(): string {
  return join(sparkHome(), DAEMON_HANDSHAKE_FILE);
}

async function writeHandshakeFile(input: { url: string; token: string }): Promise<void> {
  const payload = JSON.stringify(
    {
      url: input.url,
      token: input.token,
      pid: process.pid,
      writtenAt: new Date().toISOString(),
    },
    null,
    2,
  );
  await writeFileAtomic(handshakeFilePath(), payload);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedToken: string,
): Promise<void> {
  // We only speak POST <RPC_PATH>, exactly like agent-socket.ts.
  if (req.method !== "POST" || req.url !== RPC_PATH) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(makeDaemonError(ERR_INVALID_REQUEST, "not found")));
    return;
  }
  if (!verifyAuthHeader(req, expectedToken)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify(makeDaemonError(ERR_INVALID_REQUEST, "unauthorized")));
    return;
  }

  const body = await readBody(req);
  if (body === null) {
    writeJson(res, makeDaemonError(ERR_INVALID_REQUEST, "request body too large or unreadable"));
    return;
  }
  // parseDaemonRequest (from the types-only seam) validates the JSON-RPC
  // envelope + method and rejects batches/unknown verbs, returning null so the
  // host picks the error code — same split agent-socket.ts uses.
  const reqObj = parseDaemonRequest(body);
  if (!reqObj) {
    writeJson(res, makeDaemonError(ERR_INVALID_REQUEST, "invalid daemon request envelope"));
    return;
  }

  const response = await dispatch(reqObj);
  writeJson(res, response);
}

/**
 * In-process request dispatch. THE explicit headless reuse lives here: a
 * 'daemon.start' delegates to runStore.startAutopilot() — the exact same entry
 * point at run-store.ts:411 that runHeadlessEval drives for evals — so the
 * daemon host launches a run through the existing, battle-tested path rather
 * than a parallel one. run-store is pulled in lazily (getRunStore above) so the
 * orchestrator tree never loads unless a real request arrives.
 */
async function dispatch(req: DaemonRequest): Promise<DaemonResponse<unknown>> {
  try {
    switch (req.method) {
      case "daemon.start": {
        const runStore = await getRunStore();
        // run-store.ts:411 — same entry runHeadlessEval drives. Scaffold-only:
        // run-store wiring is NOT rewired; the daemon merely references it.
        const run = await runStore.startAutopilot(req.params.input);
        const result: DaemonResponseFor<"daemon.start"> = { ok: true, result: { runId: run.id } };
        return result;
      }
      case "daemon.attach": {
        const runStore = await getRunStore();
        const run = await runStore.getRun(req.params.runId);
        if (!run) {
          return makeDaemonError(ERR_INVALID_PARAMS, `Run not found: ${req.params.runId}`);
        }
        const result: DaemonResponseFor<"daemon.attach"> = {
          ok: true,
          result: { runId: run.id, attached: true },
        };
        return result;
      }
      case "daemon.streamEvents": {
        // Event streaming over the wire (the DaemonEventFrame push channel on
        // EVENTS_PATH) is a later phase; the in-process seam is
        // subscribeDaemonEvents() below, which is what a co-located host would
        // actually use. Return a structured NOT_IMPLEMENTED so a client branches
        // cleanly on "spec'd but not wired over HTTP yet" rather than crashing.
        return makeDaemonError(
          ERR_NOT_IMPLEMENTED,
          "daemon.streamEvents is not wired over HTTP yet; use subscribeDaemonEvents in-process",
        );
      }
      case "daemon.stop": {
        const runStore = await getRunStore();
        // Reuse the existing cancel/pause path rather than inventing a new
        // teardown. cancelRun is idempotent on already-terminal runs.
        const run = await runStore.cancelRun({
          runId: req.params.runId,
          reason: req.params.reason,
        });
        const result: DaemonResponseFor<"daemon.stop"> = {
          ok: true,
          result: { runId: run.id, stopped: true },
        };
        return result;
      }
      default: {
        // Exhaustiveness guard — a new DaemonRequest variant added to
        // daemon-ipc.ts surfaces here as a compile error via _exhaustive.
        const _exhaustive: never = req;
        void _exhaustive;
        return makeDaemonError(
          ERR_INVALID_REQUEST,
          `unknown daemon method: ${(req as DaemonRequest).method}`,
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeDaemonError(ERR_INTERNAL, message);
  }
}

/**
 * Real in-process event seam: subscribe to a single run's events. Wraps
 * event-log's subscribeToEvents (which event-log.ts already exports for the
 * headless eval runner) and filters the global fan-out down to one runId,
 * handing the caller a typed {@link DaemonEventFrame} per matching event. This
 * is the streaming primitive a co-located host gives the renderer; the
 * over-the-wire 'daemon.streamEvents' verb will be built on top of it later.
 *
 * Returns an unsubscribe fn, mirroring subscribeToEvents.
 */
export function subscribeDaemonEvents(
  runId: string,
  cb: (frame: DaemonEventFrame) => void,
): () => void {
  return subscribeToEvents((event: SparkEvent) => {
    if (event.runId === runId) cb({ type: "event", runId, event });
  });
}

/**
 * Inert integration seam. index.ts calls THIS (and only this) to "wire" the
 * daemon, mirroring how main calls startAgentSocket() at boot — except this one
 * starts nothing: it binds no socket, mints no token, and writes no handshake.
 * It exists so the integration point is a single, obvious, reversible line and
 * so a future phase can swap the body for `await startDaemonHostServer()`
 * without touching the call site.
 */
export function registerDaemonHostScaffold(): void {
  // No-op on purpose. See docs/daemon-split-PLAN.md for the phased plan that
  // turns this into a real startDaemonHostServer() call.
  console.debug("[daemon-host] scaffold registered (inert; daemon host not started)");
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

function writeJson(res: ServerResponse, payload: DaemonResponse<unknown>): void {
  const body = JSON.stringify(payload);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body, "utf8"),
  });
  res.end(body);
}
