// Terminal-bridge — main-side half of the request/response IPC that lets the
// agent-socket dispatcher create terminal tabs inside Codara. Tab/pane state is
// owned by the renderer (useTabs), so main can't mint a tab directly; it sends
// a request to the renderer and awaits the matching response carrying the new
// tabId + paneId.
//
// Architecture (mirrors preview-bridge.ts)
// ----------------------------------------
//   sub-agent stdio MCP server
//        │  JSON-RPC over HTTP
//        ▼
//   agent-socket.ts (terminal.create dispatch)
//        │  requestTerminalOp("create", params)
//        ▼
//   THIS MODULE — sends "terminal-bridge:request" to renderer, awaits matching
//                 "terminal-bridge:response" with the same reqId
//        │  ipcRenderer
//        ▼
//   renderer/components/Terminal/terminalRpc.ts → terminalRegistry → useTabs
//
// terminal.write does NOT go through here: paneId is a PTY session id, so the
// agent-socket handler writes to it directly via pty.inject with no renderer
// round-trip. The bridge is only needed for tab creation (renderer-owned state).
//
// The bridge is intentionally tiny: it does NOT know what each op means, it
// only correlates request and response by reqId, enforces a timeout, and
// surfaces a clean error if no main window / no renderer is available.

import { BrowserWindow, ipcMain } from "electron";
import { randomBytes } from "node:crypto";
import { isTrustedOnSender } from "./main-window-trust";

// "create" mints a renderer-owned terminal tab, "destroy" closes it by id,
// and "resize" keeps a phone-owned xterm grid in lockstep with its PTY. The
// caller can supply trusted phone-origin metadata or use the default tint.
export type TerminalOpName = "create" | "destroy" | "resize" | "list";

export interface TerminalOpParams {
  [key: string]: unknown;
}

interface BridgeRequest {
  reqId: string;
  op: TerminalOpName;
  params: TerminalOpParams;
}

interface BridgeResponse {
  reqId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const REQUEST_CHANNEL = "terminal-bridge:request";
const RESPONSE_CHANNEL = "terminal-bridge:response";
const DEFAULT_TIMEOUT_MS = 30_000;

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingEntry>();
let listenerRegistered = false;

export function registerTerminalBridge(): void {
  if (listenerRegistered) return;
  listenerRegistered = true;
  ipcMain.on(RESPONSE_CHANNEL, (event, payload: BridgeResponse) => {
    // Gate the sender like preview-bridge:response. Only the trusted main
    // frame's terminalRpc legitimately answers a tab-create/destroy request; a
    // navigated-away document or a preview guest must not resolve a pending op.
    // The real renderer always answers from the committed, allowlisted document.
    if (!isTrustedOnSender(event, RESPONSE_CHANNEL)) return;
    if (!payload || typeof payload.reqId !== "string") return;
    const entry = pending.get(payload.reqId);
    if (!entry) return;
    pending.delete(payload.reqId);
    clearTimeout(entry.timer);
    if (payload.ok) {
      entry.resolve(payload.result);
    } else {
      entry.reject(new Error(payload.error || "terminal op failed"));
    }
  });
}

export async function requestTerminalOp<T = unknown>(
  op: TerminalOpName,
  params: TerminalOpParams = {},
  opts?: { timeoutMs?: number },
): Promise<T> {
  const win = pickTargetWindow();
  if (!win) {
    throw new Error(
      "No Codara window is open. Open Codara before calling terminal.create.",
    );
  }
  if (win.webContents.isDestroyed() || win.webContents.isLoading()) {
    // wait briefly for the renderer to be ready
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  const reqId = randomBytes(8).toString("hex");
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const request: BridgeRequest = { reqId, op, params };

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error(`terminal op '${op}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(reqId, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    });
    try {
      win.webContents.send(REQUEST_CHANNEL, request);
    } catch (err) {
      pending.delete(reqId);
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function pickTargetWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.webContents.isDestroyed()) return focused;
  const all = BrowserWindow.getAllWindows().filter((w) => !w.webContents.isDestroyed());
  return all[0] ?? null;
}
