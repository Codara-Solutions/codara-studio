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
import { getTrustedMainWindow, isTrustedOnSender } from "./main-window-trust";
import { holdUntilRendererReady, isRendererReady, onRendererNotReady, RENDERER_HOLD_MS } from "./renderer-readiness";

// "create" mints a renderer-owned terminal tab, "destroy" closes it by id,
// and "resize" keeps a phone-owned xterm grid in lockstep with its PTY. The
// caller can supply trusted phone-origin metadata or use the default tint.
// "overlay" covers an existing pane with a temporary terminal (pane.open) and
// "closeOverlay" drops one whose PTY never started. "panes" lists every
// terminal pane with its workspace, the agents in them or not. "group" moves
// the tab of an existing pane into a named tab group. "tabs" resolves a tab
// or group link and "tabAct" focuses, closes, splits or unsplits what one
// names (codara_tab).
export type TerminalOpName =
  | "create"
  | "destroy"
  | "resize"
  | "list"
  | "agentCounts"
  | "workspaceHeld"
  | "tabFiles"
  | "overlay"
  | "closeOverlay"
  | "panes"
  | "group"
  | "tabs"
  | "tabAct"
  | "openFile";

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
const INVENTORY_CHANNEL = "terminal-bridge:inventory-changed";
const DEFAULT_TIMEOUT_MS = 30_000;

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingEntry>();
// Requests that timed out with an onLate: the renderer may still carry them
// out (a tab added after the caller gave up), and the caller cleans up then.
const LATE_WINDOW_MS = 5 * 60_000;
const late = new Map<string, { onLate: (result: unknown) => void; timer: NodeJS.Timeout }>();
// Tab/pane state lives in the renderer, so main cannot see a Studio terminal
// open, close, or retitle on its own. The renderer sends a bare content-free
// ping whenever its shareable inventory changes; interested main-side services
// (remote access pushes a terminal-list invalidation to paired phones) register
// here. The ping deliberately carries no payload — the authoritative inventory
// is always re-read through the "list" op, so a spoofed or stale ping can at
// worst trigger one redundant read.
const inventoryListeners = new Set<() => void>();
let listenerRegistered = false;

export function registerTerminalBridge(): void {
  if (listenerRegistered) return;
  listenerRegistered = true;
  // A new document or a dead renderer has none of the panes it listed.
  onRendererNotReady(forgetInventory);
  ipcMain.on(RESPONSE_CHANNEL, (event, payload: BridgeResponse) => {
    // Gate the sender like preview-bridge:response. Only the trusted main
    // frame's terminalRpc legitimately answers a tab-create/destroy request; a
    // navigated-away document or a preview guest must not resolve a pending op.
    // The real renderer always answers from the committed, allowlisted document.
    if (!isTrustedOnSender(event, RESPONSE_CHANNEL)) return;
    if (!payload || typeof payload.reqId !== "string") return;
    // A create or destroy that timed out may still have been carried out:
    // only now has the renderer answered it.
    const lateMutation = lateMutations.get(payload.reqId);
    if (lateMutation) {
      lateMutations.delete(payload.reqId);
      unansweredMutations.delete(lateMutation);
    }
    const entry = pending.get(payload.reqId);
    if (!entry) {
      const gaveUp = late.get(payload.reqId);
      if (!gaveUp) return;
      late.delete(payload.reqId);
      clearTimeout(gaveUp.timer);
      if (payload.ok) {
        try {
          gaveUp.onLate(payload.result);
        } catch (err) {
          console.error("[terminal-bridge] late answer handler failed:", err);
        }
      }
      return;
    }
    pending.delete(payload.reqId);
    clearTimeout(entry.timer);
    if (payload.ok) {
      entry.resolve(payload.result);
    } else {
      entry.reject(new Error(payload.error || "terminal op failed"));
    }
  });
  ipcMain.on(INVENTORY_CHANNEL, (event, payload?: unknown) => {
    if (!isTrustedOnSender(event, INVENTORY_CHANNEL)) return;
    // A renderer that sends the inventory with the ping keeps main's copy
    // current; listeners hear only changes to what a phone shows.
    if (payload !== undefined && !acceptInventory(payload)) return;
    for (const listener of inventoryListeners) {
      try {
        listener();
      } catch (err) {
        console.error("[terminal-bridge] inventory listener failed:", err);
      }
    }
  });
}

export function onStudioTerminalInventoryChanged(
  listener: () => void,
): () => void {
  inventoryListeners.add(listener);
  return () => inventoryListeners.delete(listener);
}

// Ops held for a starting window are rare (boot and reloads) and worth a line
// in main.log (index.ts): when one was held, and whether it then went to the
// window or was answered from main's copy of the panes.
export type HeldTerminalOpEvent =
  | { op: TerminalOpName; phase: "held" }
  | { op: TerminalOpName; phase: "sent" | "copy" | "failed"; heldMs: number };
const heldListeners = new Set<(event: HeldTerminalOpEvent) => void>();

export function onHeldTerminalOp(listener: (event: HeldTerminalOpEvent) => void): () => void {
  heldListeners.add(listener);
  return () => heldListeners.delete(listener);
}

function reportHeld(event: HeldTerminalOpEvent): void {
  for (const listener of heldListeners) {
    try {
      listener(event);
    } catch (err) {
      console.error("[terminal-bridge] held-op listener failed:", err);
    }
  }
}

export async function requestTerminalOp<T = unknown>(
  op: TerminalOpName,
  params: TerminalOpParams = {},
  opts?: {
    timeoutMs?: number;
    onLate?: (result: T) => void;
    signal?: AbortSignal;
    // The hold for a starting window comes out of timeoutMs instead of
    // preceding it, for a caller with one deadline for the whole call.
    holdWithinTimeout?: boolean;
  },
): Promise<T> {
  let win = pickTargetWindow();
  if (!win) {
    throw new Error(
      "No Codara window is open. Open Codara before calling terminal.create.",
    );
  }
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let opTimeoutMs = timeoutMs;
  // Until React has mounted, nothing in the renderer hears the request. The
  // hold has its own limit, and the op's timeout starts once it is over.
  let heldSince: number | null = null;
  if (!isRendererReady()) {
    heldSince = Date.now();
    reportHeld({ op, phase: "held" });
    try {
      await holdUntilRendererReady(opts?.signal, opts?.holdWithinTimeout ? Math.min(RENDERER_HOLD_MS, timeoutMs) : RENDERER_HOLD_MS);
    } catch (error) {
      reportHeld({ op, phase: "failed", heldMs: Date.now() - heldSince });
      throw error;
    }
    if (opts?.holdWithinTimeout) opTimeoutMs = Math.max(0, timeoutMs - (Date.now() - heldSince));
    win = pickTargetWindow() ?? win;
  }
  // A window that has just got ready sent its panes first (App.tsx), so a
  // list held for it needs no round trip into the renderer at its busiest.
  if (op === "list") {
    const cached = cachedStudioTerminalInventory();
    if (cached) {
      if (heldSince !== null) reportHeld({ op, phase: "copy", heldMs: Date.now() - heldSince });
      return cached as T;
    }
  }
  if (heldSince !== null) reportHeld({ op, phase: "sent", heldMs: Date.now() - heldSince });
  if (win.webContents.isDestroyed() || win.webContents.isLoading()) {
    // wait briefly for the renderer to be ready
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  const reqId = randomBytes(8).toString("hex");
  const request: BridgeRequest = { reqId, op, params };
  const target = win;
  const mutation = MUTATING_OPS.has(op) ? beginMutation() : null;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      // The renderer may still carry it out: the copy stays unused until it
      // answers and its next inventory arrives.
      mutation?.timedOut(reqId);
      const onLate = opts?.onLate;
      if (onLate) {
        const lateTimer = setTimeout(() => late.delete(reqId), LATE_WINDOW_MS);
        lateTimer.unref?.();
        late.set(reqId, { onLate: (result) => onLate(result as T), timer: lateTimer });
      }
      reject(new Error(`terminal op '${op}' timed out after ${timeoutMs}ms`));
    }, opTimeoutMs);
    pending.set(reqId, {
      resolve: (value) => {
        mutation?.answered();
        resolve(value as T);
      },
      reject: (error) => {
        mutation?.answered();
        reject(error);
      },
      timer,
    });
    try {
      target.webContents.send(REQUEST_CHANNEL, request);
    } catch (err) {
      pending.delete(reqId);
      clearTimeout(timer);
      mutation?.answered();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ── The panes' inventory, kept in main ──────────────────────────────────────
// The renderer sends its shareable panes with every change, and before it
// tells main it is ready (App.tsx), so terminal.list and the ownership checks
// built on it answer from here without a round trip into a renderer that may
// be busy for seconds on a loaded machine. The copy is only trusted while it
// can be as current as a round trip would be: while the window is ready, and
// not from the moment main sends a create, destroy, group or tab action until
// the renderer has answered every one of them (a timed-out one included, up
// to LATE_WINDOW_MS) and then sent its panes again. Until then callers fall
// back to the round trip.
const MUTATING_OPS: ReadonlySet<TerminalOpName> = new Set(["create", "destroy", "group", "tabAct"]);
const MAX_INVENTORY_ENTRIES = 5_000;
export interface StudioTerminalInventoryEntry {
  paneId: string;
  tabId: string;
  workspaceId: string;
  [key: string]: unknown;
}
let inventory: StudioTerminalInventoryEntry[] | null = null;
let phoneFingerprint: string | null = null;
// Mutations the renderer has not answered yet; timed-out ones stay until a
// late answer arrives (lateMutations, by request id) or LATE_WINDOW_MS ends.
const unansweredMutations = new Set<symbol>();
const lateMutations = new Map<string, symbol>();
let awaitingInventoryAfterMutation = false;

function isInventoryEntry(value: unknown): value is StudioTerminalInventoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.paneId === "string" && typeof entry.tabId === "string" && typeof entry.workspaceId === "string";
}

/** Stores a pushed inventory; true when what a phone shows changed. */
function acceptInventory(payload: unknown): boolean {
  if (!Array.isArray(payload) || payload.length > MAX_INVENTORY_ENTRIES || !payload.every(isInventoryEntry)) return false;
  inventory = payload;
  if (unansweredMutations.size === 0) awaitingInventoryAfterMutation = false;
  const fingerprint = JSON.stringify(
    payload.map((entry) => [entry.paneId, entry.tabId, entry.workspaceId, entry.title ?? null, entry.profile ?? null]),
  );
  const changed = fingerprint !== phoneFingerprint;
  phoneFingerprint = fingerprint;
  return changed;
}

// A new document or a dead renderer: its panes are gone, and so are the
// answers it still owed.
function forgetInventory(): void {
  inventory = null;
  phoneFingerprint = null;
  unansweredMutations.clear();
  lateMutations.clear();
  awaitingInventoryAfterMutation = false;
}

function beginMutation(): { answered: () => void; timedOut: (reqId: string) => void } {
  const token = Symbol("terminal mutation");
  unansweredMutations.add(token);
  awaitingInventoryAfterMutation = true;
  return {
    answered: () => {
      unansweredMutations.delete(token);
    },
    timedOut: (reqId) => {
      if (!unansweredMutations.has(token)) return;
      lateMutations.set(reqId, token);
      const expiry = setTimeout(() => {
        lateMutations.delete(reqId);
        unansweredMutations.delete(token);
      }, LATE_WINDOW_MS);
      expiry.unref?.();
    },
  };
}

/** The renderer's panes as it last sent them, or null when a round trip is needed. */
export function cachedStudioTerminalInventory(): StudioTerminalInventoryEntry[] | null {
  if (!isRendererReady() || !inventory || unansweredMutations.size > 0 || awaitingInventoryAfterMutation) return null;
  return inventory.map((entry) => ({ ...entry }));
}

// The app window first: only its renderer answers these requests, and a
// focused popup opened by a page in the in-app browser would leave them
// waiting for the timeout.
function pickTargetWindow(): BrowserWindow | null {
  const main = getTrustedMainWindow();
  if (main && !main.webContents.isDestroyed()) return main;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.webContents.isDestroyed()) return focused;
  const all = BrowserWindow.getAllWindows().filter((w) => !w.webContents.isDestroyed());
  return all[0] ?? null;
}
