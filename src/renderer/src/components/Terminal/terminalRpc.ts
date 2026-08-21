// Renderer-side handler for terminal-bridge requests. Listens for
// "terminal-bridge:request" from main, dispatches the op against the terminal
// registry (which reaches useTabs via the adapter App.tsx registers), and sends
// back a "terminal-bridge:response" with the same reqId so main can match it.
//
// Mirrors previewRpc.ts. Tab creation/destruction and phone-owned xterm sizing
// route through here because that state is renderer-owned. terminal.write/read
// operate on the PTY session directly in main and never reach the renderer.

import {
  closeAgentTerminal,
  createAgentTerminal,
  forgetExternalTerminalSize,
  listShareableStudioTerminals,
  setExternalTerminalSize,
} from "./terminalRegistry";
import type { TerminalLeafOrigin } from "../../tabs/types";

interface BridgeRequest {
  reqId: string;
  op: string;
  params: Record<string, unknown>;
}

interface BridgeResponse {
  reqId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

let registered = false;

export function registerTerminalRpcHandler(): void {
  if (registered) return;
  registered = true;
  const terminalBridge = window.spark?.terminalBridge;
  if (!terminalBridge) {
    console.warn("[terminalRpc] window.spark.terminalBridge is missing; terminal tools disabled");
    return;
  }
  terminalBridge.onRequest(async (raw) => {
    const req: BridgeRequest = {
      reqId: raw.reqId,
      op: raw.op,
      params: (raw.params as Record<string, unknown>) ?? {},
    };
    try {
      const result = await dispatch(req);
      terminalBridge.sendResponse({ reqId: req.reqId, ok: true, result } satisfies BridgeResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      terminalBridge.sendResponse({ reqId: req.reqId, ok: false, error: message } satisfies BridgeResponse);
    }
  });
}

async function dispatch(req: BridgeRequest): Promise<unknown> {
  switch (req.op) {
    case "list":
      return listShareableStudioTerminals();
    case "create":
      return create(req.params);
    case "destroy":
      return destroy(req.params);
    case "resize":
      return resize(req.params);
    default:
      throw new Error(`unknown terminal op: ${req.op || "?"}`);
  }
}

async function create(params: Record<string, unknown>): Promise<unknown> {
  const cwd = readString(params, "cwd");
  const command = readString(params, "command");
  const title = readString(params, "title");
  const workspaceId = readString(params, "workspaceId");
  const workspaceCwd = readString(params, "workspaceCwd");
  // Main pins the Claude account when it builds a phone-origin create
  // (createRemoteTerminal resolves the Active profile and validates any
  // --resume id against ITS state dir). Dropping the id here would let the
  // pane's spawn re-resolve a default that may have changed since that
  // validation, launching under a different account than main checked.
  const nativeClaudeProfileId = readString(params, "nativeClaudeProfileId");
  const origin = readPhoneOrigin(params.origin);
  return createAgentTerminal({
    cwd: cwd ?? undefined,
    command: command ?? undefined,
    title: title ?? undefined,
    workspaceId: workspaceId ?? undefined,
    workspaceCwd: workspaceCwd ?? undefined,
    nativeClaudeProfileId: nativeClaudeProfileId ?? undefined,
    origin: origin ?? undefined,
  });
}

async function destroy(params: Record<string, unknown>): Promise<unknown> {
  const tabId = readString(params, "tabId");
  if (!tabId) throw new Error("destroy requires 'tabId'");
  const paneId = readString(params, "paneId");
  if (paneId) forgetExternalTerminalSize(paneId);
  closeAgentTerminal(tabId);
  return { ok: true };
}

async function resize(params: Record<string, unknown>): Promise<unknown> {
  const paneId = readString(params, "paneId");
  const cols = readDimension(params.cols);
  const rows = readDimension(params.rows);
  if (!paneId || cols === null || rows === null) {
    throw new Error("resize requires paneId, cols and rows");
  }
  setExternalTerminalSize(paneId, cols, rows);
  return { ok: true };
}

function readString(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readPhoneOrigin(value: unknown): TerminalLeafOrigin | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "phone") return null;
  const deviceName = readString(candidate, "deviceName");
  if (!deviceName) return null;
  const initialCols = readDimension(candidate.initialCols);
  const initialRows = readDimension(candidate.initialRows);
  return {
    kind: "phone",
    deviceName,
    ...(initialCols !== null ? { initialCols } : {}),
    ...(initialRows !== null ? { initialRows } : {}),
  };
}

function readDimension(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const dimension = Math.trunc(value);
  return dimension >= 2 && dimension <= 500 ? dimension : null;
}
