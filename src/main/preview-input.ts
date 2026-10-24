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
// The DevTools protocol session, and the console and network recordings it
// keeps, belong to the tab (browser/preview-cdp.ts): they start when Chromium
// attaches the guest, before the agent's first call.

import { ipcMain, webContents, type WebContents } from "electron";

import { createPreviewDOM } from "../shared/preview-dom";
import type { CdpSession } from "./browser/cdp-session";
import { registerGuestChordReports, withAgentKeys } from "./browser/guest-chords";
import { registerPreviewDialogs } from "./browser/preview-dialogs";
import { bindPreviewTabGuest, previewCdpSession } from "./browser/preview-cdp";
import { resolvePreviewGuest, type PreviewGuestInfo } from "./browser/preview-guest";
import { consoleRing } from "./browser/recorders/console";
import { clearNetwork, networkRing } from "./browser/recorders/network";
import { normalizeKeyModifiers, parseKeyChord, previewKeyEvents } from "./preview-keyboard";
import { requestPreviewOp } from "./preview-bridge";
import { isTrustedOnSender, isTrustedPreviewGuest } from "./main-window-trust";

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

// ---------------------------------------------------------------------------
// Registration: a tab announces its guest at dom-ready, which binds the guest
// to the tab so its recordings survive a re-created webview.
// ---------------------------------------------------------------------------

let registered = false;
export function registerPreviewInput(): void {
  if (registered) return;
  registered = true;
  registerGuestChordReports();
  registerPreviewDialogs();
  ipcMain.on(
    "preview-bridge:announce",
    (event, payload: { tabId?: string; webContentsId?: number }) => {
      // Only the trusted main frame announces preview tabs; a navigated-away
      // document or a preview guest must not be able to steer console capture at
      // an arbitrary webContents by supplying its id.
      if (!isTrustedOnSender(event, "preview-bridge:announce")) return;
      const wcId = payload?.webContentsId;
      if (typeof wcId !== "number") return;
      const wc = webContents.fromId(wcId);
      if (!wc || wc.isDestroyed()) return;
      // Defense in depth: even from the trusted frame, only attach to a real
      // <webview> guest of the main window, never to some other webContents id.
      if (!isTrustedPreviewGuest(wc)) return;
      if (typeof payload.tabId === "string" && payload.tabId) bindPreviewTabGuest(payload.tabId, wc);
      else previewCdpSession(wc);
    },
  );
}

// ---------------------------------------------------------------------------
// Guest resolution
// ---------------------------------------------------------------------------

// The guest, its tab and viewport metrics (browser/preview-guest.ts).
const resolveGuest = resolvePreviewGuest;
type GuestInfo = PreviewGuestInfo;

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
  })}, ${createPreviewDOM.toString()})`;
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
async function centerProbe(opts: { selector: string; scrollIntoView: boolean }, createDOM: typeof createPreviewDOM) {
  const dom = createDOM();
  const el = opts.scrollIntoView ? await dom.ready(opts.selector) : dom.find(opts.selector);
  if (!el) return { ok: false, error: `selector not found: ${opts.selector}` };
  return { ok: true, ...dom.point(el) };
}

// Electron's sendInputEvent modifiers use 'control'/'meta'; aliases (ctrl,
// cmd, option, Mod) fold to them.
function normalizeModifiers(raw: unknown): string[] {
  return normalizeKeyModifiers(raw);
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

// The renderer answers once the agent's cursor reached the point (it glides
// there in a few hundred milliseconds), so the page gets the input only after
// the user saw where it lands. follow moves it at once, for drag steps.
async function showCursor(
  info: GuestInfo,
  params: Record<string, unknown>,
  action: string,
  point?: { x: number; y: number },
  options: { press?: boolean; follow?: boolean } = {},
): Promise<void> {
  await requestPreviewOp("activity", {
    tabId: info.tabId,
    workspaceId: params.workspaceId,
    runId: params.runId,
    callerPaneId: params.callerPaneId,
    driver: params.driver,
    action,
    ...point,
    ...options,
  });
}

// A selector's point is measured again once the cursor arrived: the page can
// shift during the glide, and input at the old point would land on whatever
// moved under it. The cursor then snaps to the new point.
async function glideToTarget(
  wc: WebContents,
  info: GuestInfo,
  params: Record<string, unknown>,
  spec: { x?: unknown; y?: unknown; selector?: unknown },
  action: string,
  options: { press?: boolean; scrollIntoView?: boolean } = {},
): Promise<{ x: number; y: number }> {
  const { scrollIntoView = true, ...cursor } = options;
  const first = await resolvePoint(wc, spec, { scrollIntoView });
  await showCursor(info, params, action, first, cursor);
  if (typeof spec.selector !== "string" || (typeof spec.x === "number" && typeof spec.y === "number")) return first;
  const settled = await resolvePoint(wc, spec, { scrollIntoView: false });
  if (Math.round(settled.x) !== Math.round(first.x) || Math.round(settled.y) !== Math.round(first.y)) {
    await showCursor(info, params, action, settled, { follow: true });
  }
  return settled;
}

async function opScroll(params: Record<string, unknown>): Promise<unknown> {
  const { wc, info } = await resolveGuest(params);
  const deltaX = typeof params.deltaX === "number" ? params.deltaX : 0;
  const deltaY = typeof params.deltaY === "number" ? params.deltaY : 0;
  if (deltaX === 0 && deltaY === 0) throw new Error("scroll requires a non-zero deltaX or deltaY");
  // For scroll, do NOT scrollIntoView the selector — the point is only the
  // wheel origin; centering it would fight the scroll the caller asked for.
  const { x, y } = await glideToTarget(wc, info, params, params, "Scrolling", { scrollIntoView: false });
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
  const { wc, info } = await resolveGuest(params);
  const { x, y } = await glideToTarget(wc, info, params, params, "Moving");
  wc.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
  return { ok: true, x, y };
}

async function opMouse(params: Record<string, unknown>): Promise<unknown> {
  const action = typeof params.action === "string" ? params.action : "click";
  const { wc, info } = await resolveGuest(params);
  const { x, y } = await glideToTarget(wc, info, params, params, action === "up" ? "Releasing" : "Clicking", { press: action !== "up" });
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
  const { wc, info } = await resolveGuest(params);
  const from = (params.from && typeof params.from === "object" ? params.from : {}) as Record<
    string,
    unknown
  >;
  const to = (params.to && typeof params.to === "object" ? params.to : {}) as Record<string, unknown>;
  const steps = Math.max(1, Math.min(typeof params.steps === "number" ? params.steps | 0 : 12, 100));
  const start = await glideToTarget(wc, info, params, from, "Dragging");
  const end = await resolvePoint(wc, to);
  const sx = Math.round(start.x);
  const sy = Math.round(start.y);
  wc.sendInputEvent({ type: "mouseMove", x: sx, y: sy });
  wc.sendInputEvent({ type: "mouseDown", x: sx, y: sy, button: "left", clickCount: 1 } as Parameters<
    WebContents["sendInputEvent"]
  >[0]);
  let finished = false;
  // A Stop or a closed tab mid-drag throws out of the loop. The page must not
  // be left with its button held down, and releasing it where the drag got to
  // would drop the item there, so the drag is cancelled instead.
  try {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const mx = Math.round(start.x + (end.x - start.x) * t);
      const my = Math.round(start.y + (end.y - start.y) * t);
      await showCursor(info, params, "Dragging", { x: mx, y: my }, { follow: true });
      wc.sendInputEvent({ type: "mouseMove", x: mx, y: my, button: "left" } as Parameters<
        WebContents["sendInputEvent"]
      >[0]);
    }
    finished = true;
  } finally {
    if (!wc.isDestroyed()) {
      const release = finished ? { x: Math.round(end.x), y: Math.round(end.y) } : { x: sx, y: sy };
      if (!finished) await abortDrag(wc, release);
      wc.sendInputEvent({ type: "mouseUp", ...release, button: "left", clickCount: 1 } as Parameters<
        WebContents["sendInputEvent"]
      >[0]);
    }
  }
  return { ok: true, from: start, to: end, steps };
}

// Escape cancels a native drag and most drag libraries' drags while the
// button is still held. For a page that ignores it, the pointer goes back to
// where the drag began, so the release drops the item where it already was.
async function abortDrag(wc: WebContents, origin: { x: number; y: number }): Promise<void> {
  await dispatchKey(wc, "Escape", [], null).catch(() => {});
  if (wc.isDestroyed()) return;
  wc.sendInputEvent({ type: "mouseMove", ...origin, button: "left" } as Parameters<
    WebContents["sendInputEvent"]
  >[0]);
}

async function opUpload(params: Record<string, unknown>): Promise<unknown> {
  const selector = typeof params.selector === "string" ? params.selector : null;
  if (!selector) throw new Error("upload requires 'selector' (a file input)");
  const paths = Array.isArray(params.paths)
    ? params.paths.filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  if (paths.length === 0) throw new Error("upload requires a non-empty 'paths' array");
  const { wc } = await resolveGuest(params);
  const session = previewCdpSession(wc);
  const doc = await session.send<{ root?: { nodeId?: number } }>("DOM.getDocument", { depth: 0 });
  const rootId = doc?.root?.nodeId;
  if (typeof rootId !== "number") throw new Error("could not read the preview DOM root");
  const found = await session.send<{ nodeId?: number }>("DOM.querySelector", {
    nodeId: rootId,
    selector,
  });
  if (!found?.nodeId) throw new Error(`file input not found: ${selector}`);
  await session.send("DOM.setFileInputFiles", { files: paths, nodeId: found.nodeId });
  return { ok: true, selector, files: paths };
}

async function opConsole(params: Record<string, unknown>): Promise<unknown> {
  const ring = consoleRing(await guestSession(params));
  if (params.clear === true) {
    ring.clear();
    return { ok: true, cleared: true, entries: [] };
  }
  const level = typeof params.level === "string" ? params.level.toLowerCase() : null;
  const limit = clampLimit(params.limit);
  let entries = ring.toArray();
  if (level) entries = entries.filter((e) => e.level === level);
  const sliced = entries.slice(-limit);
  return { ok: true, count: sliced.length, total: ring.size, entries: sliced };
}

async function opNetwork(params: Record<string, unknown>): Promise<unknown> {
  const session = await guestSession(params);
  const ring = networkRing(session);
  if (params.clear === true) {
    clearNetwork(session);
    return { ok: true, cleared: true, entries: [] };
  }
  const filter = typeof params.filter === "string" ? params.filter : null;
  const limit = clampLimit(params.limit);
  let entries = ring.toArray();
  if (filter) entries = entries.filter((e) => e.url.includes(filter));
  const sliced = entries.slice(-limit);
  return { ok: true, count: sliced.length, total: ring.size, entries: sliced };
}

async function opKey(params: Record<string, unknown>): Promise<unknown> {
  const raw = typeof params.key === "string" ? params.key : null;
  if (!raw) throw new Error("key requires 'key'");
  // "Control+K" and key "k" with modifiers ["control"] are the same chord.
  const { key, modifiers } = parseKeyChord(raw, params.modifiers);
  const { wc } = await resolveGuest(params, true);
  const text = typeof params.text === "string" ? params.text : null;
  await dispatchKey(wc, key, modifiers, text);
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
  let info: GuestInfo;
  try {
    ({ wc, info } = await resolveGuest(params, true));
  } catch {
    return requestPreviewOp("press_key", {
      tabId: (params.tabId as string) ?? null,
      runId: typeof params.runId === "string" ? params.runId : null,
      workspaceId: params.workspaceId,
      callerPaneId: params.callerPaneId,
      driver: params.driver,
      key,
      selector: (params.selector as string) ?? null,
    });
  }
  if (typeof params.selector === "string" && params.selector) {
    const point = await resolvePoint(wc, { selector: params.selector }).catch(() => null);
    if (point) await showCursor(info, params, "Typing", point);
    const focused = await wc.executeJavaScript(
      `(async () => { const el = await (${createPreviewDOM.toString()})().ready(${JSON.stringify(params.selector)});
        if (!el || typeof el.focus !== "function") return false;
        el.focus(); return document.activeElement === el || el.contains(document.activeElement); })()`,
      false,
    );
    if (!focused) throw new Error(`preview key target is missing or not focusable: ${params.selector}`);
  }
  await dispatchKey(wc, key, [], null);
  return { ok: true, key, trusted: true };
}

// CDP dispatch remains trusted when the app or preview is in the background.
// sendInputEvent silently drops keys when its BrowserWindow lacks OS focus.
async function dispatchKey(
  wc: WebContents,
  key: string,
  modifiers: string[],
  text: string | null,
): Promise<void> {
  const events = previewKeyEvents(key, modifiers, text);
  const session: CdpSession = previewCdpSession(wc);
  await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // The page gets every key an agent sends, chords included; none of them
  // may reach Codara's own shortcuts (browser/guest-chords.ts).
  await withAgentKeys(wc, async () => {
    for (const event of events) await session.send("Input.dispatchKeyEvent", event);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw | 0 : 100;
  return Math.max(1, Math.min(n, RING_CAP));
}

// Recordings belong to the tab's session, which resolving the guest creates
// if this tab has none yet.
async function guestSession(params: Record<string, unknown>): Promise<CdpSession> {
  const { wc } = await resolveGuest(params);
  return previewCdpSession(wc);
}
