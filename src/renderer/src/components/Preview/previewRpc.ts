// Renderer-side handler for preview-bridge requests. Listens for
// "preview-bridge:request" from main, dispatches the op against the picked
// preview tab's BrowserPaneHandle, and sends back a "preview-bridge:response"
// with the same reqId so main can match it.
//
// All op semantics live in here. The bridge itself is op-agnostic.
//
// All probes are executed via webview.executeJavaScript with a tiny IIFE
// that does the DOM work — this gives us click/type/snapshot without
// pulling in Playwright or a CDP layer.

import type { CoraWhiteboard } from "@shared/types";
import { createPreviewDOM } from "@shared/preview-dom";
import { createPreviewNames } from "@shared/preview-names";
import { snapshotProbe } from "./domSnapshot";
import { clickProbe, locateProbe, typeProbe, pressKeyProbe } from "./domActions";
import { assertDriverAllowed, moveAgentCursor, noteDriving, readDriver, type Box, type CursorMove } from "./agent-presence/store";
import { closeIsolatedTab, openIsolatedTab } from "./isolatedTabs";
import { closePageDialog, showPageDialog, type PageDialogView } from "./pageDialogs";
import {
  closePreviewTab,
  ensurePreviewTab,
  findPreviewTabByWebContentsId,
  findReusablePreviewTab,
  hasPreviewTab,
  listPreviewTabs,
  pickPreviewTab,
} from "./registry";
import { assignTabToGroup, tabGroupNameOf } from "../../tabs/tabGroupBridge";

type PreviewOpName =
  | "whiteboard_inspect"
  | "activity"
  | "list"
  | "navigate"
  | "snapshot"
  | "evaluate"
  | "click"
  | "type"
  | "press_key"
  | "screenshot"
  | "paint"
  | "url"
  | "resize"
  | "get_web_contents_id"
  | "dialog_show"
  | "dialog_hide"
  | "open_isolated"
  | "close_isolated"
  | "close";

interface BridgeRequest {
  reqId: string;
  op: PreviewOpName;
  params: Record<string, unknown> & { tabId?: string | null };
}

interface BridgeResponse {
  reqId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

let registered = false;

// The tab each request acted on, keyed by its params object, so the response
// names it even when the op's own result does not.
const actedTabs = new WeakMap<object, string>();

function stampActedTab(result: unknown, tabId: string | undefined): unknown {
  if (!tabId || !result || typeof result !== "object" || Array.isArray(result)) return result;
  if (Object.getPrototypeOf(result) !== Object.prototype) return result;
  const record = result as Record<string, unknown>;
  if ("tabId" in record || "tabs" in record) return result;
  return { tabId, ...record };
}

export function registerPreviewRpcHandler(): void {
  if (registered) return;
  registered = true;
  const previewBridge = window.spark?.previewBridge;
  if (!previewBridge) {
    console.warn("[previewRpc] window.spark.previewBridge is missing; preview tools disabled");
    return;
  }
  previewBridge.onRequest(async (raw) => {
    const req: BridgeRequest = {
      reqId: raw.reqId,
      op: raw.op as PreviewOpName,
      params: raw.params as BridgeRequest["params"],
    };
    try {
      const result = stampActedTab(await dispatch(req), req.params ? actedTabs.get(req.params) : undefined);
      previewBridge.sendResponse({ reqId: req.reqId, ok: true, result } satisfies BridgeResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      previewBridge.sendResponse({ reqId: req.reqId, ok: false, error: message } satisfies BridgeResponse);
    }
  });
}

async function dispatch(req: BridgeRequest): Promise<unknown> {
  switch (req.op) {
    case "whiteboard_inspect": {
      const { inspectWhiteboard } = await import("../whiteboard/inspect-whiteboard");
      return inspectWhiteboard(req.params.board as CoraWhiteboard, req.params.nodeIds as string[] | undefined);
    }
    case "list":
      return { tabs: listPreviewTabs(readString(req.params, "workspaceId"), readString(req.params, "callerPaneId")) };
    case "activity": {
      // Answers once the cursor arrived, so main sends its input after the glide.
      const tab = requireTab(req.params);
      const point = typeof req.params.x === "number" && typeof req.params.y === "number" ? { x: req.params.x, y: req.params.y } : undefined;
      await moveAgentCursor(tab.id, readDriver(req.params.driver), {
        action: readString(req.params, "action") ?? "Working",
        point,
        press: req.params.press === true,
        follow: req.params.follow === true,
      });
      return { ok: true };
    }
    case "navigate":
      return navigate(req.params);
    case "url":
      return urlOf(req.params);
    case "snapshot":
      return snapshot(req.params);
    case "evaluate":
      return evaluate(req.params);
    case "click":
      return click(req.params);
    case "type":
      return typeText(req.params);
    case "press_key":
      return pressKey(req.params);
    case "screenshot":
      return screenshot(req.params);
    case "paint":
      return paint(req.params);
    case "resize":
      return resize(req.params);
    case "get_web_contents_id":
      return getWebContentsId(req.params);
    case "dialog_show": {
      // A dialog during a tab's first load arrives before the tab announced
      // its guest, so main may not know the tab id yet.
      const dialog = req.params.dialog as PageDialogView & { webContentsId?: number };
      const tabId = dialog?.tabId || (typeof dialog?.webContentsId === "number" ? findPreviewTabByWebContentsId(dialog.webContentsId)?.id : undefined);
      return tabId ? showPageDialog({ ...dialog, tabId }) : null;
    }
    case "dialog_hide":
      closePageDialog(readString(req.params, "id") ?? "");
      return { ok: true };
    case "open_isolated":
      return openIsolatedTab(req.params);
    case "close_isolated":
      return closeIsolatedTab(req.params);
    case "close":
      return closeTab(req.params);
    default:
      throw new Error(`unknown preview op: ${(req.op as string) ?? "?"}`);
  }
}

// Implicit tab picking is scoped to the calling run: params.runId is stamped by
// the MCP server from SPARK_RUN_ID, so an agent op with no explicit tabId only
// ever lands on a tab that run opened. An agent with no run is scoped to the
// workspace of the pane it runs in (params.callerPaneId, resolved by main). An
// explicit tabId is still honored inside that workspace.
function requireTab(params: Record<string, unknown>) {
  const runId = typeof params.runId === "string" && params.runId ? params.runId : null;
  const tab = pickPreviewTab(
    readString(params, "tabId"),
    runId,
    readString(params, "workspaceId"),
    readString(params, "callerPaneId"),
  );
  if (!tab) {
    if (runId && !params.tabId) {
      throw new Error(
        "No preview tab belongs to this run. Call codara_preview_navigate first to open one (or pass an explicit tabId).",
      );
    }
    throw new Error(
      "No browser tab is open. Open a Browser tab in Codara (right-click a file → Open in Browser, or open a localhost URL) before calling preview tools.",
    );
  }
  // A driver the user stopped on this tab is refused before anything runs.
  const driver = readDriver(params.driver);
  assertDriverAllowed(tab.id, driver);
  noteDriving(tab.id, driver);
  actedTabs.set(params, tab.id);
  return tab;
}

/** Glide the agent's cursor to where an action on selector will land, before it lands. */
async function approach(tab: ReturnType<typeof requireTab>, params: Record<string, unknown>, selector: string, move: Omit<CursorMove, "point" | "box">, withBox = false): Promise<void> {
  const driver = readDriver(params.driver);
  if (!driver) return;
  const code = `(${locateProbe.toString()})(${JSON.stringify({ selector })}, ${createPreviewDOM.toString()})`;
  const spot = await runGuestScript(tab.handle, code).catch(() => null) as { x: number; y: number; box: Box } | null;
  if (!spot) return;
  await moveAgentCursor(tab.id, driver, { ...move, point: { x: spot.x, y: spot.y }, ...(withBox ? { box: spot.box } : {}) });
}

// codara_preview_close. A named tab must be in the caller's workspace; with
// no tabId only a tab this run or agent opened is closed, never the user's.
// It closes like the user's close button, so groups, history and the layout
// follow, and a logged-out tab's data is wiped once its last page is gone.
function closeTab(params: Record<string, unknown>) {
  const runId = readString(params, "runId");
  const workspaceId = readString(params, "workspaceId");
  const callerPaneId = readString(params, "callerPaneId");
  const tabId = readString(params, "tabId");
  if (tabId) {
    const tab = pickPreviewTab(tabId, runId, workspaceId, callerPaneId);
    if (!tab) {
      if (!hasPreviewTab(tabId)) return { ok: true, tabId, alreadyClosed: true };
      throw new Error(`Browser tab ${tabId} is not in your workspace, so you cannot close it.`);
    }
    assertDriverAllowed(tab.id, readDriver(params.driver));
    closePreviewTab(tab.id);
    return { ok: true, tabId: tab.id, closed: true };
  }
  const own = findReusablePreviewTab(runId, workspaceId, callerPaneId);
  if (!own) {
    throw new Error("This session has no browser tab of its own open. Pass the tabId from codara_preview_list to close another tab of your workspace.");
  }
  assertDriverAllowed(own.id, readDriver(params.driver));
  closePreviewTab(own.id);
  return { ok: true, tabId: own.id, closed: true };
}

// Electron logs EVERY rejected webview.executeJavaScript to the dev terminal as
// "Error occurred in handler for 'GUEST_VIEW_MANAGER_CALL': Script failed to
// execute" — one stack per throw. Agent-driven probes throw routinely (missing
// selectors, JSON.parse on bad input, evaluate()'s expression-ness parse probe),
// so raw rejections turn `npm run dev` into an error firehose for what is
// perfectly normal control flow here. runGuestScript keeps the failure INSIDE
// the guest page: the injected script never rejects — errors come back as a
// sentinel object and are rethrown here with the same message the RPC caller
// would have seen before.
async function runGuestScript(
  handle: { executeJavaScript: (code: string) => Promise<unknown> },
  expr: string,
): Promise<unknown> {
  const wrapped = `(async () => { try { return { __coraOk: true, value: await (${expr}\n) }; } catch (err) { return { __coraOk: false, error: String((err && err.message) || err) }; } })()`;
  const outcome = (await handle.executeJavaScript(wrapped)) as
    | { __coraOk: true; value: unknown }
    | { __coraOk: false; error: string }
    | null;
  if (outcome && typeof outcome === "object" && "__coraOk" in outcome) {
    if (outcome.__coraOk) return outcome.value;
    throw new Error(outcome.error);
  }
  return outcome;
}

async function navigate(params: Record<string, unknown>): Promise<unknown> {
  const url = readString(params, "url");
  const group = readString(params, "group");
  if (!url && !(params.tabId && group)) throw new Error("navigate requires 'url'");
  let tab;
  let opened = false;
  // The store's own answer: the bridge reads committed state, which lags a
  // move made in this same call.
  let joined: string | null = null;
  const driver = readDriver(params.driver);
  if (params.tabId) {
    tab = pickPreviewTab(
      typeof params.tabId === "string" ? params.tabId : null,
      null,
      readString(params, "workspaceId"),
      readString(params, "callerPaneId"),
    );
    if (!tab) throw new Error(`preview tab not found: ${String(params.tabId)}`);
    assertDriverAllowed(tab.id, driver);
    // A tab the call names joins the group; with no url that is all it does.
    if (group) joined = assignTabToGroup(tab.id, tab.workspaceId, group);
    if (!url) {
      return { url: tab.handle.getURL(), tabId: tab.id, opened, group: joined ?? tabGroupNameOf(tab.id) };
    }
  } else if (url) {
    // runId is the calling run's identity, stamped by the MCP server; the
    // reused-or-opened tab must belong to that run (or, with no run, to the
    // calling agent's pane), not the selected one and never one the user
    // opened.
    const runId = readString(params, "runId");
    const workspaceId = readString(params, "workspaceId");
    const callerPaneId = readString(params, "callerPaneId");
    const reusable = findReusablePreviewTab(runId, workspaceId, callerPaneId);
    if (reusable) assertDriverAllowed(reusable.id, driver);
    ({ tab, opened } = await ensurePreviewTab(url, runId, workspaceId, callerPaneId, group, readString(params, "callerSessionId")));
  } else {
    throw new Error("navigate requires 'url'");
  }
  // A tab ensurePreviewTab just opened is already loading the URL. Loading
  // it again would abort or repeat that first load, which runs the page's
  // requests twice and records the first load's as never finished.
  noteDriving(tab.id, driver, "Navigating");
  if (!opened) tab.handle.loadURL(url);
  await waitDomReady(tab.handle, 15_000);
  joined ??= tabGroupNameOf(tab.id);
  return { url: tab.handle.getURL(), tabId: tab.id, opened, ...(joined ? { group: joined } : {}) };
}

async function urlOf(params: Record<string, unknown>): Promise<unknown> {
  const tab = requireTab(params);
  return { url: tab.handle.getURL(), title: tab.handle.getTitle() };
}

async function snapshot(params: Record<string, unknown>): Promise<unknown> {
  const mode = readString(params, "mode") ?? "outline";
  const maxBytes = readNumber(params, "maxBytes") ?? 12_000;
  const tab = requireTab(params);
  const code = `(${snapshotProbe.toString()})(${JSON.stringify({ mode, maxBytes, selector: readString(params, "selector"), since: readString(params, "since") })}, ${createPreviewDOM.toString()}, ${createPreviewNames.toString()})`;
  const value = await runGuestScript(tab.handle, code);
  return value;
}

async function evaluate(params: Record<string, unknown>): Promise<unknown> {
  const code = readString(params, "code");
  if (!code) throw new Error("evaluate requires 'code'");
  const awaitPromise = readBool(params, "awaitPromise") ?? false;
  const tab = requireTab(params);
  // The documented contract is "last expression's value is returned", so run
  // the snippet as a single expression when it parses as one — `1+1`,
  // `document.title` — which covers virtually every real call. (The old
  // body-only wrap made every expression evaluate to undefined unless the
  // caller wrote `return`.) Multi-statement snippets get the function-body
  // wrap, where an explicit `return` still yields the value.
  //
  // Expression-ness is decided by a compile-only probe: DEFINING an arrow
  // whose body is the snippet parses it without executing it, so the choice
  // never runs the code twice (a naive try-expression-then-fallback would
  // re-execute side effects when the snippet itself throws a runtime
  // SyntaxError, e.g. JSON.parse on bad input). Trailing newline guards a
  // `// comment` on the snippet's last line.
  const wrap = (inner: string) =>
    awaitPromise
      ? `Promise.resolve((async () => ${inner})()).then((__r) => JSON.parse(JSON.stringify(__r ?? null)))`
      : `(() => { const __r = (() => ${inner})(); return JSON.parse(JSON.stringify(__r ?? null)); })()`;
  let isExpression = true;
  try {
    // In-page new Function parse: SyntaxError => statement snippet. Runs inside
    // runGuestScript so a non-expression never rejects the GUEST_VIEW call
    // (the old `void (() => ...)` probe logged a scary main-terminal error for
    // every multi-statement evaluate).
    const parses = await runGuestScript(
      tab.handle,
      `(() => { try { new Function(${JSON.stringify(`return (${code}\n)`)}); return true; } catch (e) { if (e instanceof SyntaxError) return false; throw e; } })()`,
    );
    isExpression = parses === true;
  } catch {
    // new Function unavailable (page CSP blocks eval) — fall back to the old
    // definition probe. Its rejection logs once, but only on CSP pages.
    try {
      await tab.handle.executeJavaScript(`void (() => (${code}\n)); "cora-parse-ok"`);
      isExpression = true;
    } catch {
      isExpression = false;
    }
  }
  const result: unknown = await runGuestScript(
    tab.handle,
    wrap(isExpression ? `(${code}\n)` : `{ ${code} }`),
  );
  return { value: result };
}

async function click(params: Record<string, unknown>): Promise<unknown> {
  const selector = readString(params, "selector");
  if (!selector) throw new Error("click requires 'selector'");
  const tab = requireTab(params);
  await approach(tab, params, selector, { action: "Clicking", press: true });
  const code = `(${clickProbe.toString()})(${JSON.stringify({ selector })}, ${createPreviewDOM.toString()})`;
  return runGuestScript(tab.handle, code);
}

async function typeText(params: Record<string, unknown>): Promise<unknown> {
  const selector = readString(params, "selector");
  const text = readString(params, "text");
  if (!selector) throw new Error("type requires 'selector'");
  if (text === null) throw new Error("type requires 'text'");
  const clearFirst = readBool(params, "clearFirst") ?? false;
  const tab = requireTab(params);
  await approach(tab, params, selector, { action: "Typing" }, true);
  const code = `(${typeProbe.toString()})(${JSON.stringify({ selector, text, clearFirst })}, ${createPreviewDOM.toString()})`;
  return runGuestScript(tab.handle, code);
}

async function pressKey(params: Record<string, unknown>): Promise<unknown> {
  const key = readString(params, "key");
  if (!key) throw new Error("press_key requires 'key'");
  const selector = readString(params, "selector");
  const tab = requireTab(params);
  if (selector) await approach(tab, params, selector, { action: "Typing" }, true);
  const code = `(${pressKeyProbe.toString()})(${JSON.stringify({ key, selector })}, ${createPreviewDOM.toString()})`;
  return runGuestScript(tab.handle, code);
}

async function screenshot(params: Record<string, unknown>): Promise<unknown> {
  const tab = requireTab(params);
  const [dataUrl, viewport] = await Promise.all([
    tab.handle.capturePngDataUrl(),
    runGuestScript(tab.handle, "({ width: window.innerWidth, height: window.innerHeight })")
      .catch(() => null) as Promise<{ width: number; height: number } | null>,
  ]);
  // PNG dimensions describe the returned pixels; devicePixelRatio alone can
  // differ from the encoded image scale under zoom or display changes.
  const header = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1, dataUrl.indexOf(",") + 33)), (char) => char.charCodeAt(0));
  const dimensions = new DataView(header.buffer);
  const imageSize = { width: dimensions.getUint32(16), height: dimensions.getUint32(20) };
  const scale = viewport && viewport.width > 0 && viewport.height > 0
    ? { x: imageSize.width / viewport.width, y: imageSize.height / viewport.height } : null;
  return { dataUrl, tabId: tab.id, url: tab.handle.getURL(), title: tab.handle.getTitle(), viewport, imageSize, scale };
}

// A lease outlives no measurement: main releases it when a trace ends, and
// the timer releases it when main never does (a crash, a lost reply).
const PAINT_LEASE_MAX_MS = 90_000;
const paintLeases = new Map<string, () => void>();

function paint(params: Record<string, unknown>): unknown {
  const leaseId = readString(params, "leaseId");
  if (params.hold === false) {
    if (leaseId) paintLeases.get(leaseId)?.();
    return { ok: true };
  }
  const tab = requireTab(params);
  const { background, release } = tab.handle.holdPaint();
  const id = `paint-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const timer = setTimeout(() => end(), Math.min(readNumber(params, "ms") ?? PAINT_LEASE_MAX_MS, PAINT_LEASE_MAX_MS));
  const end = () => {
    clearTimeout(timer);
    paintLeases.delete(id);
    release();
  };
  paintLeases.set(id, end);
  return { leaseId: id, tabId: tab.id, background };
}

async function resize(params: Record<string, unknown>): Promise<unknown> {
  const width = readNumber(params, "width");
  const height = readNumber(params, "height");
  if (!width || !height) throw new Error("resize requires numeric 'width' and 'height'");
  const tab = requireTab(params);
  const applied = tab.handle.resizeViewport(width, height);
  return { ok: true, ...applied, tabId: tab.id };
}

const METRICS_TIMEOUT_MS = 400;

// Internal — only the main-side computer-use executor calls this. Resolves the
// picked tab's guest webContents id plus viewport metrics so trusted-input
// coordinates can be mapped against capturePage screenshots.
async function getWebContentsId(params: Record<string, unknown>): Promise<unknown> {
  const tab = requireTab(params);
  // Keyboard dispatch needs the embedder iframe focused as well as its guest field.
  if (params.focus === true) tab.handle.focusContent();
  const webContentsId = tab.handle.getWebContentsId();
  if (webContentsId === null) {
    throw new Error("preview tab is not ready (no web contents id yet)");
  }
  let viewport: { width: number; height: number } | null = null;
  let devicePixelRatio = 1;
  try {
    // Bounded: a page held by an open alert or confirm answers no script, and
    // resolving the tab must not hang with it (main reports the dialog).
    const metrics = (await Promise.race([
      runGuestScript(
        tab.handle,
        "({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })",
      ),
      new Promise((resolve) => setTimeout(() => resolve(null), METRICS_TIMEOUT_MS)),
    ])) as { width: number; height: number; dpr: number } | null;
    if (metrics) {
      viewport = { width: metrics.width, height: metrics.height };
      devicePixelRatio = metrics.dpr || 1;
    }
  } catch {
    /* viewport metrics are best-effort; trusted input works without them */
  }
  return {
    webContentsId,
    tabId: tab.id,
    workspaceId: tab.workspaceId,
    url: tab.handle.getURL(),
    viewport,
    devicePixelRatio,
  };
}

async function waitDomReady(handle: { isReady: () => boolean }, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!handle.isReady()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for preview dom-ready");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function readString(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === "string" ? value : null;
}
function readNumber(params: Record<string, unknown>, key: string): number | null {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function readBool(params: Record<string, unknown>, key: string): boolean | null {
  const value = params[key];
  return typeof value === "boolean" ? value : null;
}
