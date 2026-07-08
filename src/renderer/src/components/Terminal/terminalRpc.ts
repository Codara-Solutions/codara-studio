// Renderer-side handler for terminal-bridge requests. Listens for
// "terminal-bridge:request" from main, dispatches the op against the terminal
// registry (which reaches useTabs via the adapter App.tsx registers), and sends
// back a "terminal-bridge:response" with the same reqId so main can match it.
//
// Mirrors previewRpc.ts. Only terminal.create routes through here — the tab
// state it creates is renderer-owned. terminal.write/read operate on the PTY
// session directly in main and never reach the renderer.

import { closeAgentTerminal, createAgentTerminal } from "./terminalRegistry";

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
    case "create":
      return create(req.params);
    case "destroy":
      return destroy(req.params);
    default:
      throw new Error(`unknown terminal op: ${req.op || "?"}`);
  }
}

async function create(params: Record<string, unknown>): Promise<unknown> {
  const cwd = readString(params, "cwd");
  const command = readString(params, "command");
  const title = readString(params, "title");
  return createAgentTerminal({
    cwd: cwd ?? undefined,
    command: command ?? undefined,
    title: title ?? undefined,
  });
}

async function destroy(params: Record<string, unknown>): Promise<unknown> {
  const tabId = readString(params, "tabId");
  if (!tabId) throw new Error("destroy requires 'tabId'");
  closeAgentTerminal(tabId);
  return { ok: true };
}

function readString(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
