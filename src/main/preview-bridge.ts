// Preview-bridge — main-side half of the request/response IPC that lets the
// agent-socket dispatcher drive any open <preview> tab inside Codara.
//
// Architecture
// ------------
//   sub-agent stdio MCP server
//        │  JSON-RPC over HTTP
//        ▼
//   agent-socket.ts (preview.* dispatch)
//        │  requestPreviewOp(op, params)
//        ▼
//   THIS MODULE — sends "preview-bridge:request" to renderer, awaits matching
//                 "preview-bridge:response" with the same reqId
//        │  ipcRenderer
//        ▼
//   renderer/components/Preview/previewRpc.ts
//        │  picks target preview tab, runs executeJavaScript / capturePage
//        ▼
//   <webview> Chromium guest
//
// The bridge is intentionally tiny: it does NOT know what each op means, it
// only correlates request and response by reqId, enforces a timeout, and
// surfaces a clean error if no main window / no renderer is available. All
// op semantics live in the renderer module.

import { BrowserWindow, ipcMain, type WebContents } from "electron";
import { randomBytes } from "node:crypto";

export type PreviewOpName =
  | "list"
  | "navigate"
  | "snapshot"
  | "evaluate"
  | "click"
  | "type"
  | "press_key"
  | "wait_for"
  | "screenshot"
  | "url"
  // Renderer-side webview-element resize (changes the guest viewport).
  | "resize"
  // Internal: resolve the picked tab's guest webContents id (+ viewport/dpr)
  // so the main-side computer-use executor can drive it directly. Not an MCP
  // tool — only preview-input.ts calls it.
  | "get_web_contents_id";

export interface PreviewOpParams {
  tabId?: string | null;
  [key: string]: unknown;
}

interface BridgeRequest {
  reqId: string;
  op: PreviewOpName;
  params: PreviewOpParams;
}

interface BridgeResponse {
  reqId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const REQUEST_CHANNEL = "preview-bridge:request";
const RESPONSE_CHANNEL = "preview-bridge:response";
const DEFAULT_TIMEOUT_MS = 30_000;

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingEntry>();
let listenerRegistered = false;

export function registerPreviewBridge(): void {
  if (listenerRegistered) return;
  listenerRegistered = true;
  ipcMain.on(RESPONSE_CHANNEL, (_event, payload: BridgeResponse) => {
    if (!payload || typeof payload.reqId !== "string") return;
    const entry = pending.get(payload.reqId);
    if (!entry) return;
    pending.delete(payload.reqId);
    clearTimeout(entry.timer);
    if (payload.ok) {
      entry.resolve(payload.result);
    } else {
      entry.reject(new Error(payload.error || "preview op failed"));
    }
  });
}

export async function requestPreviewOp<T = unknown>(
  op: PreviewOpName,
  params: PreviewOpParams = {},
  opts?: { timeoutMs?: number },
): Promise<T> {
  const win = pickTargetWindow();
  if (!win) {
    throw new Error(
      "No Codara window is open. Open Codara and a preview tab before calling preview tools.",
    );
  }
  if (win.webContents.isDestroyed()) throw new Error("The Codara window closed before the preview request could start.");
  // The agent-socket handshake is written before the renderer bundle has
  // necessarily installed previewBridge.onRequest. Sending during that gap
  // loses the one-shot IPC message and used to produce a misleading 30-second
  // timeout. did-finish-load happens after the renderer module (and its bridge
  // registration) has evaluated, so it is the durable readiness boundary.
  await waitForRendererLoad(win.webContents);

  const reqId = randomBytes(8).toString("hex");
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const request: BridgeRequest = { reqId, op, params };

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error(`preview op '${op}' timed out after ${timeoutMs}ms`));
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

async function waitForRendererLoad(webContents: WebContents): Promise<void> {
  if (!webContents.isLoading()) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      webContents.removeListener("did-finish-load", ready);
      webContents.removeListener("destroyed", destroyed);
      webContents.removeListener("render-process-gone", gone);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const destroyed = () => {
      cleanup();
      reject(new Error("The Codara window closed while the preview bridge was loading."));
    };
    const gone = () => {
      cleanup();
      reject(new Error("The Codara renderer exited while the preview bridge was loading."));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Codara's renderer did not become ready for preview requests within 10 seconds."));
    }, 10_000);
    webContents.once("did-finish-load", ready);
    webContents.once("destroyed", destroyed);
    webContents.once("render-process-gone", gone);
    // Close the race where loading ended between the initial check and the
    // listener registration.
    if (!webContents.isLoading()) ready();
  });
}

function pickTargetWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.webContents.isDestroyed()) return focused;
  const all = BrowserWindow.getAllWindows().filter((w) => !w.webContents.isDestroyed());
  return all[0] ?? null;
}
