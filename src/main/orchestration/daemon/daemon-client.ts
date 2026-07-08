import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sparkHome } from "../../spark-home";
import {
  DAEMON_HANDSHAKE_FILE,
  RPC_PATH,
  EVENTS_PATH,
  type DaemonMethod,
  type DaemonRequest,
  type DaemonResultMap,
  type DaemonResponseFor,
  type DaemonStartResult,
  type DaemonAttachResult,
  type DaemonStopResult,
  type DaemonEventFrame,
} from "./daemon-ipc";
import type { StartAutopilotInput } from "@shared/types";

// ── DaemonClient ────────────────────────────────────────────────────────────
// The renderer-side (or any in-Codara caller's) view of the detached
// orchestration daemon. It is the *remote* half of the seam: it speaks the
// loopback HTTP + bearer-token JSON contract that daemon-host.ts serves, and
// deliberately imports NOTHING from run-store/event-log — all orchestration
// state lives on the host's side of the socket. The only cross-module imports
// are the contract types from ./daemon-ipc, StartAutopilotInput from
// @shared/types, and sparkHome() to locate the handshake file.
//
// This mirrors how out-of-process MCP children (the codara-studio
// server) reach the main process today: they read agent-socket.json out
// of sparkHome() and POST to `${url}/rpc` with `Authorization: Bearer <token>`.
// DaemonClient does the same against the daemon's handshake file
// (DAEMON_HANDSHAKE_FILE) instead.
//
// SCAFFOLD STATUS: the request/response RPC methods are wired end-to-end against
// the daemon-ipc contract, but no renderer code consumes this yet, and
// streamEvents() is intentionally a no-op (see the method doc). A later phase of
// docs/daemon-split-PLAN.md replaces the renderer's direct run-store calls with
// a DaemonClient instance.

// What we need off the handshake file daemon-host.ts writes via writeFileAtomic.
// Only url + token are required to talk to it; the host also stamps protocol,
// pid, and writtenAt, which we tolerate but ignore.
interface DaemonHandshake {
  url: string;
  token: string;
}

/** Cancels an active event subscription started by {@link DaemonClient.streamEvents}. */
export type DaemonUnsubscribe = () => void;

/** Tag attached to the error {@link DaemonClient.fromHandshake} throws when the daemon is down. */
export const DAEMON_OFFLINE_CODE = "SPARK_DAEMON_OFFLINE";

export class DaemonClient {
  readonly url: string;
  readonly token: string;

  constructor(init: { url: string; token: string }) {
    this.url = init.url;
    this.token = init.token;
  }

  /**
   * Build a client from the daemon's on-disk handshake file, the same way
   * out-of-process MCP children read agent-socket.json. Throws a tagged error
   * (`code === DAEMON_OFFLINE_CODE`) when the file is absent or malformed so
   * callers can branch on "daemon not running" instead of a generic failure.
   */
  static fromHandshake(): DaemonClient {
    const file = join(sparkHome(), DAEMON_HANDSHAKE_FILE);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      throw offlineError(file, err);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw offlineError(file, err);
    }
    const handshake = parseHandshake(parsed);
    if (!handshake) {
      throw offlineError(file, new Error("handshake file is malformed"));
    }
    return new DaemonClient(handshake);
  }

  /**
   * Ask the daemon to start (or adopt) an autopilot run. The host delegates to
   * the existing in-process `startAutopilot()` (run-store.ts:411, the same entry
   * runHeadlessEval drives) and reports back the run identity.
   */
  async start(input: StartAutopilotInput): Promise<DaemonStartResult> {
    return this.rpc("daemon.start", { input });
  }

  /**
   * Attach to an already-running run by id. In the migrated design this lets a
   * freshly (re)opened renderer re-bind to a run the daemon is already driving;
   * `attached` reports whether the host actually found the run.
   */
  async attach(runId: string): Promise<DaemonAttachResult> {
    return this.rpc("daemon.attach", { runId });
  }

  /** Request the daemon stop a run (user pressed Stop / cancelled the chat). */
  async stop(runId: string, reason?: string): Promise<DaemonStopResult> {
    return this.rpc("daemon.stop", { runId, reason });
  }

  /**
   * Subscribe to the daemon's {@link DaemonEventFrame} stream for a single run.
   *
   * INTENDED DESIGN: open a long-lived GET `${url}${EVENTS_PATH}?runId=...` with
   * `Authorization: Bearer <token>` and decode an SSE / newline-delimited stream
   * of {@link DaemonEventFrame}s, invoking `onFrame` for each. The returned
   * function aborts the request. Filtering by runId happens on the host
   * (subscribeDaemonEvents wraps event-log's subscribeToEvents, filtered by
   * runId); the client just relays frames whose `.runId` already matches.
   *
   * SCAFFOLD STATUS: not wired yet — the host serves no EVENTS_PATH endpoint in
   * this phase (its `daemon.streamEvents` RPC returns notImplemented). We return
   * a no-op unsubscribe so call-sites can already adopt the final signature. The
   * params are referenced (not invoked) so the intended types flow through
   * without an unused-binding error.
   *
   * @returns an unsubscribe function (currently a no-op).
   */
  streamEvents(runId: string, onFrame: (frame: DaemonEventFrame) => void): DaemonUnsubscribe {
    // The endpoint a later phase will GET (with `Authorization: Bearer <token>`)
    // to receive an SSE/long-poll body of DaemonEventFrame values, forwarding
    // each to `onFrame`. Filtering by runId happens on the host
    // (subscribeDaemonEvents wraps event-log's subscribeToEvents); the client
    // just relays frames whose `.runId` already matches. Computed here so the
    // wire shape is pinned to the contract today even though no request opens.
    // TODO(daemon-split): open this stream — see docs/daemon-split-PLAN.md.
    const eventsEndpoint = `${this.url}${EVENTS_PATH}?runId=${encodeURIComponent(runId)}`;
    void eventsEndpoint;
    void onFrame;
    return () => {
      /* no-op until the EVENTS_PATH channel exists */
    };
  }

  /**
   * POST one typed {@link DaemonRequest} to the host's RPC endpoint and return
   * the method's success payload, throwing on transport errors or an
   * `{ ok: false }` response. The generic ties the returned result to the method
   * via {@link DaemonResultMap}; the wire body is still parsed defensively
   * (strict-null-safe) before that type is asserted.
   */
  private async rpc<M extends DaemonMethod>(
    method: M,
    params: ParamsFor<M>,
  ): Promise<DaemonResultMap[M]> {
    const request = { jsonrpc: "2.0", id: nextRequestId(), method, params } as DaemonRequest;
    const response = await postJson<M>(this.url, this.token, request);
    return unwrap<M>(response);
  }
}

// Extract the `params` shape for a given method straight off the request union
// so each public method passes exactly the params daemon-ipc declares for it.
type ParamsFor<M extends DaemonMethod> = Extract<DaemonRequest, { method: M }>["params"];

// ── handshake parsing ───────────────────────────────────────────────────────

function parseHandshake(value: unknown): DaemonHandshake | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const url = record.url;
  const token = record.token;
  if (typeof url !== "string" || url.length === 0) return null;
  if (typeof token !== "string" || token.length === 0) return null;
  return { url, token };
}

function offlineError(file: string, cause: unknown): Error & { code: string } {
  const causeMsg = cause instanceof Error ? cause.message : String(cause);
  const err = new Error(
    `Codara daemon appears to be offline (could not read ${file}). Cause: ${causeMsg}`,
  ) as Error & { code: string };
  err.code = DAEMON_OFFLINE_CODE;
  return err;
}

// ── response unwrapping ─────────────────────────────────────────────────────

// The host answers with a DaemonResponse discriminated on `ok` (the error arm
// carries a numeric `code` + `message`, matching agent-socket.ts's code space).
// We accept it as the typed-but-untrusted DaemonResponseFor<M> off the wire and
// narrow defensively so a malformed body throws a clear error rather than
// surfacing `undefined` downstream.
function unwrap<M extends DaemonMethod>(response: DaemonResponseFor<M>): DaemonResultMap[M] {
  if (!response || typeof response !== "object") {
    throw new Error("daemon returned a non-object response");
  }
  const record = response as unknown as Record<string, unknown>;
  if (record.ok === false) {
    const code = typeof record.code === "number" ? record.code : -32603;
    const message = typeof record.message === "string" ? record.message : "daemon request failed";
    throw new Error(`daemon error ${code}: ${message}`);
  }
  if (record.ok !== true) {
    throw new Error("daemon response missing 'ok' discriminant");
  }
  if (!("result" in record)) {
    throw new Error("daemon success response missing 'result'");
  }
  return record.result as DaemonResultMap[M];
}

// ── minimal node:http POST helper ───────────────────────────────────────────
// A dependency-free request against the loopback host. Mirrors the
// codara-studio MCP child's postJsonRpc: build the URL, send the JSON body
// with Bearer auth + Content-Length, collect the response, and JSON-parse it.

const REQUEST_TIMEOUT_MS = 20 * 60_000; // matches the host's long-blocking verbs (e.g. ask_user)

let requestSeq = 0;
function nextRequestId(): number {
  // Monotonic per-process id for the JSON-RPC envelope. The scaffold issues one
  // request per call and awaits it, so a simple counter is enough to correlate.
  requestSeq = (requestSeq + 1) % Number.MAX_SAFE_INTEGER;
  return requestSeq;
}

function postJson<M extends DaemonMethod>(
  baseUrl: string,
  token: string,
  payload: DaemonRequest,
): Promise<DaemonResponseFor<M>> {
  return new Promise<DaemonResponseFor<M>>((resolve, reject) => {
    const body = JSON.stringify(payload);
    let target: URL;
    try {
      // Concatenate exactly like the MCP child (handshake.url + "/rpc") so the
      // host's served path and the client's requested path can't drift.
      target = new URL(`${baseUrl}${RPC_PATH}`);
    } catch (err) {
      reject(new Error(`bad daemon url '${baseUrl}': ${errMessage(err)}`));
      return;
    }
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body, "utf8"),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            reject(new Error(`daemon returned ${res.statusCode ?? "?"}: ${text.slice(0, 200)}`));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch (err) {
            reject(new Error(`daemon returned non-JSON: ${errMessage(err)}`));
            return;
          }
          resolve(parsed as DaemonResponseFor<M>);
        });
      },
    );
    req.on("error", (err) => reject(new Error(`daemon unreachable: ${errMessage(err)}`)));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error("daemon request timed out"));
    });
    req.write(body);
    req.end();
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
