// Preview-input — main-side computer-use executor for the built-in <preview>
// tab. Where previewRpc.ts (renderer) synthesizes DOM events with
// executeJavaScript, this module drives the guest webContents directly with
// Electron's trusted input pipeline (sendInputEvent) and the Chrome DevTools
// Protocol (webContents.debugger). Trusted input is indistinguishable from a
// real user's mouse/keyboard to the page, which matters for drag/hover/native
// file pickers and for pages that gate on event.isTrusted.
//
// How main reaches the guest webContents
// --------------------------------------
// A <webview> guest is a separate WebContents. The renderer can name it via
// webview.getWebContentsId(); we resolve that id through the existing
// preview-bridge (the renderer's registry owns "which tab" — active vs a given
// tabId vs first-open fallback), then grab the live guest with
// webContents.fromId(). Every coordinate op resolves the point in the guest's
// CSS-pixel viewport space, which is exactly what sendInputEvent expects and
// what capturePage screenshots are captured in (before devicePixelRatio
// scaling) — so an agent can click what it sees in a screenshot.
//
// Ring buffers (console + network) are keyed by webContentsId. Console capture
// is wired the moment a preview tab announces itself (dom-ready); network
// capture attaches the CDP Network domain lazily on first use.

import { ipcMain, webContents, type WebContents } from "electron";

import { requestPreviewOp } from "./preview-bridge";

// ---------------------------------------------------------------------------
// Op surface
// ---------------------------------------------------------------------------

export type PreviewInputOp =
  | "scroll"
  | "hover"
  | "mouse"
  | "drag"
  | "upload"
  | "console"
  | "network"
  | "key"
  | "press_key";

const RING_CAP = 500;
const MODIFIER_SET = new Set([
  "shift",
  "control",
  "ctrl",
  "alt",
  "meta",
  "cmd",
  "command",
  "capsLock",
]);

interface ConsoleEntry {
  level: string;
  message: string;
  line: number | null;
  source: string | null;
  at: string;
}

interface NetworkEntry {
  requestId: string;
  url: string;
  method: string | null;
  status: number | null;
  mimeType: string | null;
  failed: boolean;
  errorText: string | null;
  at: string;
}

interface GuestState {
  wcId: number;
  consoleAttached: boolean;
  console: ConsoleEntry[];
  debuggerAttached: boolean;
  networkEnabled: boolean;
  network: NetworkEntry[];
  networkIndex: Map<string, NetworkEntry>;
}

const guests = new Map<number, GuestState>();

function getState(wcId: number): GuestState {
  let state = guests.get(wcId);
  if (!state) {
    state = {
      wcId,
      consoleAttached: false,
      console: [],
      debuggerAttached: false,
      networkEnabled: false,
      network: [],
      networkIndex: new Map(),
    };
    guests.set(wcId, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Registration — wire the announce channel so console capture can begin at the
// moment a preview tab becomes dom-ready (before the agent's first op).
// ---------------------------------------------------------------------------

let registered = false;
export function registerPreviewInput(): void {
  if (registered) return;
  registered = true;
  ipcMain.on(
    "preview-bridge:announce",
    (_event, payload: { tabId?: string; webContentsId?: number }) => {
      const wcId = payload?.webContentsId;
      if (typeof wcId !== "number") return;
      const wc = webContents.fromId(wcId);
      if (!wc || wc.isDestroyed()) return;
      ensureConsoleAttached(wc);
    },
  );
}

// ---------------------------------------------------------------------------
// Guest resolution
// ---------------------------------------------------------------------------

interface GuestInfo {
  webContentsId: number;
  tabId: string;
  url: string | null;
  viewport: { width: number; height: number } | null;
  devicePixelRatio: number;
}

async function resolveGuest(
  params: Record<string, unknown>,
): Promise<{ wc: WebContents; info: GuestInfo }> {
  const tabId = typeof params.tabId === "string" ? params.tabId : null;
  const info = (await requestPreviewOp("get_web_contents_id", { tabId })) as GuestInfo;
  const wcId = info?.webContentsId;
  if (typeof wcId !== "number") {
    throw new Error("preview tab is not ready (no web contents id yet)");
  }
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) {
    throw new Error("preview tab web contents is gone; reopen the preview tab and retry");
  }
  // Opportunistically wire console capture in case the tab never announced
  // (e.g. it was already open before this build attached listeners).
  ensureConsoleAttached(wc);
  return { wc, info };
}

// Resolve a click point in the guest's CSS-pixel viewport space. Accepts
// explicit { x, y } or a CSS { selector } whose on-screen center we probe.
async function resolvePoint(
  wc: WebContents,
  spec: { x?: unknown; y?: unknown; selector?: unknown },
  opts: { scrollIntoView: boolean } = { scrollIntoView: true },
): Promise<{ x: number; y: number }> {
  if (typeof spec.x === "number" && typeof spec.y === "number") {
    return { x: spec.x, y: spec.y };
  }
  const selector = typeof spec.selector === "string" ? spec.selector : null;
  if (!selector) throw new Error("provide either { selector } or explicit { x, y }");
  const probe = `(${centerProbe.toString()})(${JSON.stringify({
    selector,
    scrollIntoView: opts.scrollIntoView,
  })})`;
  const rect = (await wc.executeJavaScript(probe, false)) as
    | { ok: true; x: number; y: number }
    | { ok: false; error: string }
    | null;
  if (!rect || rect.ok === false) {
    throw new Error(rect && "error" in rect ? rect.error : `selector not found: ${selector}`);
  }
  return { x: rect.x, y: rect.y };
}

// Stringified and run in the guest. Returns the element's viewport-relative
// center in CSS pixels — the coordinate space sendInputEvent consumes.
function centerProbe(opts: { selector: string; scrollIntoView: boolean }) {
  const el = document.querySelector(opts.selector) as HTMLElement | null;
  if (!el) return { ok: false, error: `selector not found: ${opts.selector}` };
  if (opts.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" });
  const rect = el.getBoundingClientRect();
  return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function normalizeModifiers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const m of raw) {
    if (typeof m !== "string") continue;
    const key = m.toLowerCase();
    if (!MODIFIER_SET.has(key)) continue;
    // Electron's sendInputEvent modifiers use 'control'/'meta'; fold aliases.
    if (key === "ctrl") out.push("control");
    else if (key === "cmd" || key === "command") out.push("meta");
    else out.push(key);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Console capture — wired at tab announce (dom-ready). Ring buffer cap 500.
// ---------------------------------------------------------------------------

function ensureConsoleAttached(wc: WebContents): void {
  const state = getState(wc.id);
  if (state.consoleAttached) return;
  state.consoleAttached = true;
  // Modern params-object signature (Electron ≥ 30) — reading the legacy
  // positional args triggers a deprecation warning on every message.
  wc.on("console-message", (event) => {
    pushConsole(state, {
      level: typeof event.level === "string" ? event.level : "log",
      message: typeof event.message === "string" ? event.message : String(event.message),
      line: typeof event.lineNumber === "number" ? event.lineNumber : null,
      source: typeof event.sourceId === "string" && event.sourceId ? event.sourceId : null,
      at: new Date().toISOString(),
    });
  });
  wc.once("destroyed", () => {
    guests.delete(wc.id);
  });
}

function pushConsole(state: GuestState, entry: ConsoleEntry): void {
  state.console.push(entry);
  if (state.console.length > RING_CAP) state.console.splice(0, state.console.length - RING_CAP);
}

// ---------------------------------------------------------------------------
// CDP debugger — shared by network capture and file upload. Attached lazily.
// ---------------------------------------------------------------------------

function ensureDebugger(wc: WebContents): void {
  const state = getState(wc.id);
  if (state.debuggerAttached) return;
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
  } catch (err) {
    throw new Error(
      `could not attach the DevTools protocol to the preview tab (${
        (err as Error).message
      }). Close the preview tab's DevTools if they're open, then retry.`,
    );
  }
  state.debuggerAttached = true;
  wc.debugger.on("message", (_event, method: string, params: Record<string, unknown>) => {
    handleCdpMessage(state, method, params);
  });
  wc.debugger.on("detach", () => {
    state.debuggerAttached = false;
    state.networkEnabled = false;
  });
  wc.once("destroyed", () => {
    guests.delete(wc.id);
  });
}

function handleCdpMessage(
  state: GuestState,
  method: string,
  params: Record<string, unknown>,
): void {
  if (method === "Network.requestWillBeSent") {
    const requestId = String((params as { requestId?: unknown }).requestId ?? "");
    const request = (params as { request?: { url?: string; method?: string } }).request ?? {};
    const entry: NetworkEntry = {
      requestId,
      url: typeof request.url === "string" ? request.url : "",
      method: typeof request.method === "string" ? request.method : null,
      status: null,
      mimeType: null,
      failed: false,
      errorText: null,
      at: new Date().toISOString(),
    };
    state.networkIndex.set(requestId, entry);
    pushNetwork(state, entry);
  } else if (method === "Network.responseReceived") {
    const requestId = String((params as { requestId?: unknown }).requestId ?? "");
    const response = (params as { response?: { status?: number; mimeType?: string } }).response ?? {};
    const entry = state.networkIndex.get(requestId);
    if (entry) {
      entry.status = typeof response.status === "number" ? response.status : entry.status;
      entry.mimeType = typeof response.mimeType === "string" ? response.mimeType : entry.mimeType;
    }
  } else if (method === "Network.loadingFailed") {
    const requestId = String((params as { requestId?: unknown }).requestId ?? "");
    const entry = state.networkIndex.get(requestId);
    if (entry) {
      entry.failed = true;
      entry.errorText =
        typeof (params as { errorText?: unknown }).errorText === "string"
          ? (params as { errorText: string }).errorText
          : "failed";
    }
  }
}

function pushNetwork(state: GuestState, entry: NetworkEntry): void {
  state.network.push(entry);
  if (state.network.length > RING_CAP) {
    const dropped = state.network.splice(0, state.network.length - RING_CAP);
    for (const d of dropped) state.networkIndex.delete(d.requestId);
  }
}

async function ensureNetworkEnabled(wc: WebContents): Promise<void> {
  ensureDebugger(wc);
  const state = getState(wc.id);
  if (state.networkEnabled) return;
  await wc.debugger.sendCommand("Network.enable");
  state.networkEnabled = true;
}

// ---------------------------------------------------------------------------
// Op dispatch
// ---------------------------------------------------------------------------

export async function handlePreviewInputOp(
  op: PreviewInputOp,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (op) {
    case "scroll":
      return opScroll(params);
    case "hover":
      return opHover(params);
    case "mouse":
      return opMouse(params);
    case "drag":
      return opDrag(params);
    case "upload":
      return opUpload(params);
    case "console":
      return opConsole(params);
    case "network":
      return opNetwork(params);
    case "key":
      return opKey(params);
    case "press_key":
      return opPressKey(params);
    default:
      throw new Error(`unknown preview input op: ${op as string}`);
  }
}

async function opScroll(params: Record<string, unknown>): Promise<unknown> {
  const { wc } = await resolveGuest(params);
  const deltaX = typeof params.deltaX === "number" ? params.deltaX : 0;
  const deltaY = typeof params.deltaY === "number" ? params.deltaY : 0;
  if (deltaX === 0 && deltaY === 0) throw new Error("scroll requires a non-zero deltaX or deltaY");
  // For scroll, do NOT scrollIntoView the selector — the point is only the
  // wheel origin; centering it would fight the scroll the caller asked for.
  const { x, y } = await resolvePoint(wc, params, { scrollIntoView: false });
  wc.sendInputEvent({
    type: "mouseWheel",
    x: Math.round(x),
    y: Math.round(y),
    deltaX: Math.round(deltaX),
    deltaY: Math.round(deltaY),
    canScroll: true,
  } as Parameters<WebContents["sendInputEvent"]>[0]);
  return { ok: true, x, y, deltaX, deltaY };
}

async function opHover(params: Record<string, unknown>): Promise<unknown> {
  const { wc } = await resolveGuest(params);
  const { x, y } = await resolvePoint(wc, params);
  wc.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
  return { ok: true, x, y };
}

async function opMouse(params: Record<string, unknown>): Promise<unknown> {
  const action = typeof params.action === "string" ? params.action : "click";
  const { wc } = await resolveGuest(params);
  const { x, y } = await resolvePoint(wc, params);
  const modifiers = normalizeModifiers(params.modifiers);
  const px = Math.round(x);
  const py = Math.round(y);
  const button: "left" | "right" = action === "rightclick" ? "right" : "left";
  const down = (clickCount: number) =>
    wc.sendInputEvent({ type: "mouseDown", x: px, y: py, button, clickCount, modifiers } as Parameters<
      WebContents["sendInputEvent"]
    >[0]);
  const up = (clickCount: number) =>
    wc.sendInputEvent({ type: "mouseUp", x: px, y: py, button, clickCount, modifiers } as Parameters<
      WebContents["sendInputEvent"]
    >[0]);
  wc.sendInputEvent({ type: "mouseMove", x: px, y: py, modifiers } as Parameters<
    WebContents["sendInputEvent"]
  >[0]);
  switch (action) {
    case "down":
      down(1);
      break;
    case "up":
      up(1);
      break;
    case "click":
    case "rightclick":
      down(1);
      up(1);
      break;
    case "dblclick":
      down(1);
      up(1);
      down(2);
      up(2);
      break;
    default:
      throw new Error(`unknown mouse action '${action}' (expected down|up|click|dblclick|rightclick)`);
  }
  return { ok: true, action, x, y, button };
}

async function opDrag(params: Record<string, unknown>): Promise<unknown> {
  const { wc } = await resolveGuest(params);
  const from = (params.from && typeof params.from === "object" ? params.from : {}) as Record<
    string,
    unknown
  >;
  const to = (params.to && typeof params.to === "object" ? params.to : {}) as Record<string, unknown>;
  const start = await resolvePoint(wc, from);
  const end = await resolvePoint(wc, to);
  const steps = Math.max(1, Math.min(typeof params.steps === "number" ? params.steps | 0 : 12, 100));
  const sx = Math.round(start.x);
  const sy = Math.round(start.y);
  wc.sendInputEvent({ type: "mouseMove", x: sx, y: sy });
  wc.sendInputEvent({ type: "mouseDown", x: sx, y: sy, button: "left", clickCount: 1 } as Parameters<
    WebContents["sendInputEvent"]
  >[0]);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mx = Math.round(start.x + (end.x - start.x) * t);
    const my = Math.round(start.y + (end.y - start.y) * t);
    wc.sendInputEvent({ type: "mouseMove", x: mx, y: my, button: "left" } as Parameters<
      WebContents["sendInputEvent"]
    >[0]);
  }
  const ex = Math.round(end.x);
  const ey = Math.round(end.y);
  wc.sendInputEvent({ type: "mouseUp", x: ex, y: ey, button: "left", clickCount: 1 } as Parameters<
    WebContents["sendInputEvent"]
  >[0]);
  return { ok: true, from: start, to: end, steps };
}

async function opUpload(params: Record<string, unknown>): Promise<unknown> {
  const selector = typeof params.selector === "string" ? params.selector : null;
  if (!selector) throw new Error("upload requires 'selector' (a file input)");
  const paths = Array.isArray(params.paths)
    ? params.paths.filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  if (paths.length === 0) throw new Error("upload requires a non-empty 'paths' array");
  const { wc } = await resolveGuest(params);
  ensureDebugger(wc);
  const doc = (await wc.debugger.sendCommand("DOM.getDocument", { depth: 0 })) as {
    root?: { nodeId?: number };
  };
  const rootId = doc?.root?.nodeId;
  if (typeof rootId !== "number") throw new Error("could not read the preview DOM root");
  const found = (await wc.debugger.sendCommand("DOM.querySelector", {
    nodeId: rootId,
    selector,
  })) as { nodeId?: number };
  if (!found?.nodeId) throw new Error(`file input not found: ${selector}`);
  await wc.debugger.sendCommand("DOM.setFileInputFiles", { files: paths, nodeId: found.nodeId });
  return { ok: true, selector, files: paths };
}

function opConsole(params: Record<string, unknown>): unknown {
  return withGuestState(params, (state) => {
    if (params.clear === true) {
      state.console = [];
      return { ok: true, cleared: true, entries: [] };
    }
    const level = typeof params.level === "string" ? params.level.toLowerCase() : null;
    const limit = clampLimit(params.limit);
    let entries = state.console;
    if (level) entries = entries.filter((e) => e.level === level);
    const sliced = entries.slice(-limit);
    return { ok: true, count: sliced.length, total: state.console.length, entries: sliced };
  });
}

async function opNetwork(params: Record<string, unknown>): Promise<unknown> {
  const { wc } = await resolveGuest(params);
  await ensureNetworkEnabled(wc);
  const state = getState(wc.id);
  if (params.clear === true) {
    state.network = [];
    state.networkIndex.clear();
    return { ok: true, cleared: true, entries: [] };
  }
  const filter = typeof params.filter === "string" ? params.filter : null;
  const limit = clampLimit(params.limit);
  let entries = state.network;
  if (filter) entries = entries.filter((e) => e.url.includes(filter));
  const sliced = entries.slice(-limit);
  return { ok: true, count: sliced.length, total: state.network.length, entries: sliced };
}

async function opKey(params: Record<string, unknown>): Promise<unknown> {
  const key = typeof params.key === "string" ? params.key : null;
  if (!key) throw new Error("key requires 'key'");
  const { wc } = await resolveGuest(params);
  const text = typeof params.text === "string" ? params.text : null;
  const modifiers = normalizeModifiers(params.modifiers);
  dispatchKey(wc, key, modifiers, text);
  return { ok: true, key, modifiers };
}

// press_key keeps the original tool alive but upgrades it to trusted input
// whenever we can resolve a live guest webContents. Only when resolution fails
// (no preview tab, not dom-ready) do we fall back to the renderer's synthetic
// KeyboardEvent probe so the tool never regresses.
async function opPressKey(params: Record<string, unknown>): Promise<unknown> {
  const key = typeof params.key === "string" ? params.key : null;
  if (!key) throw new Error("press_key requires 'key'");
  let wc: WebContents;
  try {
    ({ wc } = await resolveGuest(params));
  } catch {
    return requestPreviewOp("press_key", {
      tabId: (params.tabId as string) ?? null,
      key,
      selector: (params.selector as string) ?? null,
    });
  }
  // If a selector was supplied, focus it first so the trusted key lands there.
  if (typeof params.selector === "string" && params.selector) {
    try {
      await wc.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(
          params.selector,
        )}); if (el && el.focus) el.focus(); return !!el; })()`,
        false,
      );
    } catch {
      /* focus is best-effort */
    }
  }
  dispatchKey(wc, key, [], null);
  return { ok: true, key, trusted: true };
}

// Electron sendInputEvent accepts a key string for `keyCode` (named keys like
// Enter/Tab/Escape/Backspace/ArrowUp or a single character). For printable
// input we also emit a `char` event so the character is inserted.
function dispatchKey(
  wc: WebContents,
  key: string,
  modifiers: string[],
  text: string | null,
): void {
  const printable = text ?? (key.length === 1 ? key : null);
  wc.sendInputEvent({ type: "keyDown", keyCode: key, modifiers } as Parameters<
    WebContents["sendInputEvent"]
  >[0]);
  if (printable) {
    wc.sendInputEvent({ type: "char", keyCode: printable, modifiers } as Parameters<
      WebContents["sendInputEvent"]
    >[0]);
  }
  wc.sendInputEvent({ type: "keyUp", keyCode: key, modifiers } as Parameters<
    WebContents["sendInputEvent"]
  >[0]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw | 0 : 100;
  return Math.max(1, Math.min(n, RING_CAP));
}

// Console reads must not fabricate a fresh guest just to answer; but they do
// need the ring buffer for the resolved tab. Resolve the guest (which also
// wires console capture), then hand its state to the reader.
async function withGuestState<T>(
  params: Record<string, unknown>,
  fn: (state: GuestState) => T,
): Promise<T> {
  const { wc } = await resolveGuest(params);
  return fn(getState(wc.id));
}
