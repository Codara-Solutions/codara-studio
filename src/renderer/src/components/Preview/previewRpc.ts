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

import { ensurePreviewTab, listPreviewTabs, pickPreviewTab } from "./registry";

type PreviewOpName =
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
  | "resize"
  | "get_web_contents_id";

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
      const result = await dispatch(req);
      previewBridge.sendResponse({ reqId: req.reqId, ok: true, result } satisfies BridgeResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      previewBridge.sendResponse({ reqId: req.reqId, ok: false, error: message } satisfies BridgeResponse);
    }
  });
}

async function dispatch(req: BridgeRequest): Promise<unknown> {
  switch (req.op) {
    case "list":
      return { tabs: listPreviewTabs() };
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
    case "wait_for":
      return waitFor(req.params);
    case "screenshot":
      return screenshot(req.params);
    case "resize":
      return resize(req.params);
    case "get_web_contents_id":
      return getWebContentsId(req.params);
    default:
      throw new Error(`unknown preview op: ${(req.op as string) ?? "?"}`);
  }
}

// Implicit tab picking is scoped to the calling run: params.runId is stamped by
// the MCP server from SPARK_RUN_ID, so an agent op with no explicit tabId only
// ever lands on a tab that run opened. An explicit tabId is still honored.
function requireTab(params: { tabId?: string | null; runId?: unknown }) {
  const runId = typeof params.runId === "string" && params.runId ? params.runId : null;
  const tab = pickPreviewTab(params.tabId ?? null, runId);
  if (!tab) {
    if (runId && !params.tabId) {
      throw new Error(
        "No preview tab belongs to this run — call codara_preview_navigate first to open one (or pass an explicit tabId).",
      );
    }
    throw new Error(
      "No browser tab is open. Open a Browser tab in Codara (right-click a file → Open in Browser, or open a localhost URL) before calling preview tools.",
    );
  }
  return tab;
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
  if (!url) throw new Error("navigate requires 'url'");
  let tab;
  let opened = false;
  if (params.tabId) {
    tab = pickPreviewTab(typeof params.tabId === "string" ? params.tabId : null);
    if (!tab) throw new Error(`preview tab not found: ${String(params.tabId)}`);
  } else {
    // runId is the calling run's identity, stamped by the MCP server; the
    // reused-or-opened tab must belong to that run, not the selected one and
    // never one the user opened.
    const runId = readString(params, "runId");
    const before = pickPreviewTab(null, runId);
    tab = await ensurePreviewTab(url, runId);
    opened = !before;
  }
  // ensurePreviewTab created the tab with the target URL, so loadURL is a
  // redundant nav in that case but cheap. For an existing tab it's the real
  // navigation.
  tab.handle.loadURL(url);
  await waitDomReady(tab.handle, 15_000);
  return { url: tab.handle.getURL(), tabId: tab.id, opened };
}

async function urlOf(params: Record<string, unknown>): Promise<unknown> {
  const tab = requireTab(params);
  return { url: tab.handle.getURL(), title: tab.handle.getTitle() };
}

async function snapshot(params: Record<string, unknown>): Promise<unknown> {
  const mode = readString(params, "mode") ?? "outline";
  const maxBytes = readNumber(params, "maxBytes") ?? 12_000;
  const tab = requireTab(params);
  const code = `(${snapshotProbe.toString()})(${JSON.stringify({ mode, maxBytes })})`;
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
  const code = `(${clickProbe.toString()})(${JSON.stringify({ selector })})`;
  return runGuestScript(tab.handle, code);
}

async function typeText(params: Record<string, unknown>): Promise<unknown> {
  const selector = readString(params, "selector");
  const text = readString(params, "text");
  if (!selector) throw new Error("type requires 'selector'");
  if (text === null) throw new Error("type requires 'text'");
  const clearFirst = readBool(params, "clearFirst") ?? false;
  const tab = requireTab(params);
  const code = `(${typeProbe.toString()})(${JSON.stringify({ selector, text, clearFirst })})`;
  return runGuestScript(tab.handle, code);
}

async function pressKey(params: Record<string, unknown>): Promise<unknown> {
  const key = readString(params, "key");
  if (!key) throw new Error("press_key requires 'key'");
  const selector = readString(params, "selector");
  const tab = requireTab(params);
  const code = `(${pressKeyProbe.toString()})(${JSON.stringify({ key, selector })})`;
  return runGuestScript(tab.handle, code);
}

async function waitFor(params: Record<string, unknown>): Promise<unknown> {
  const selector = readString(params, "selector");
  if (!selector) throw new Error("wait_for requires 'selector'");
  const state = (readString(params, "state") as "attached" | "visible" | "hidden" | null) ?? "visible";
  const timeoutMs = readNumber(params, "timeoutMs") ?? 5_000;
  const tab = requireTab(params);
  const code = `(${waitForProbe.toString()})(${JSON.stringify({ selector, state, timeoutMs })})`;
  return runGuestScript(tab.handle, code);
}

async function screenshot(params: Record<string, unknown>): Promise<unknown> {
  const tab = requireTab(params);
  const dataUrl = await tab.handle.capturePngDataUrl();
  return { dataUrl, url: tab.handle.getURL() };
}

async function resize(params: Record<string, unknown>): Promise<unknown> {
  const width = readNumber(params, "width");
  const height = readNumber(params, "height");
  if (!width || !height) throw new Error("resize requires numeric 'width' and 'height'");
  const tab = requireTab(params);
  const applied = tab.handle.resizeViewport(width, height);
  return { ok: true, ...applied, tabId: tab.id };
}

// Internal — only the main-side computer-use executor calls this. Resolves the
// picked tab's guest webContents id plus viewport metrics so trusted-input
// coordinates can be mapped against capturePage screenshots.
async function getWebContentsId(params: Record<string, unknown>): Promise<unknown> {
  const tab = requireTab(params);
  const webContentsId = tab.handle.getWebContentsId();
  if (webContentsId === null) {
    throw new Error("preview tab is not ready (no web contents id yet)");
  }
  let viewport: { width: number; height: number } | null = null;
  let devicePixelRatio = 1;
  try {
    const metrics = (await runGuestScript(
      tab.handle,
      "({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })",
    )) as { width: number; height: number; dpr: number } | null;
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

// ---------------------------------------------------------------------------
// Probes — these functions are stringified and run inside the <webview>'s
// renderer context via executeJavaScript. They MUST be self-contained: no
// closures over the renderer's host module scope, no TypeScript-only syntax.
// Inputs/outputs travel as JSON.
// ---------------------------------------------------------------------------

function snapshotProbe(opts: { mode: string; maxBytes: number }) {
  function describe(el: Element, depth: number): string {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    const name =
      el.getAttribute("aria-label") ||
      el.getAttribute("aria-labelledby") ||
      el.getAttribute("title") ||
      (el as HTMLElement).innerText?.trim().slice(0, 80) ||
      "";
    const id = el.id ? `#${el.id}` : "";
    const cls = el.className && typeof el.className === "string"
      ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
      : "";
    const meta: string[] = [];
    if (role) meta.push(`role=${role}`);
    if (name) meta.push(`name=${JSON.stringify(name)}`);
    const head = `${"  ".repeat(depth)}<${tag}${id}${cls}>${meta.length ? " " + meta.join(" ") : ""}`;
    return head;
  }
  function walk(el: Element, depth: number, lines: string[], budget: { left: number }): void {
    if (budget.left <= 0) return;
    const line = describe(el, depth);
    if (line.length + 1 > budget.left) {
      lines.push(line.slice(0, budget.left));
      budget.left = 0;
      return;
    }
    lines.push(line);
    budget.left -= line.length + 1;
    const children = Array.from(el.children);
    for (const child of children) {
      if (budget.left <= 0) break;
      const skip = ["script", "style", "noscript", "meta", "link"].includes(child.tagName.toLowerCase());
      if (skip) continue;
      walk(child, depth + 1, lines, budget);
    }
  }
  const lines: string[] = [];
  const budget = { left: Math.max(1000, opts.maxBytes) };
  if (document.body) walk(document.body, 0, lines, budget);
  const truncated = budget.left <= 0;
  return {
    url: location.href,
    title: document.title,
    mode: opts.mode,
    snapshot: lines.join("\n"),
    truncated,
  };
}

function clickProbe(opts: { selector: string }) {
  const el = document.querySelector(opts.selector) as HTMLElement | null;
  if (!el) return { ok: false, error: `selector not found: ${opts.selector}` };
  el.scrollIntoView({ block: "center" });
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const opts2 = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 } as MouseEventInit;
  el.dispatchEvent(new PointerEvent("pointerdown", opts2 as PointerEventInit));
  el.dispatchEvent(new MouseEvent("mousedown", opts2));
  el.dispatchEvent(new PointerEvent("pointerup", opts2 as PointerEventInit));
  el.dispatchEvent(new MouseEvent("mouseup", opts2));
  el.click();
  return { ok: true, tag: el.tagName.toLowerCase(), x, y };
}

function typeProbe(opts: { selector: string; text: string; clearFirst: boolean }) {
  const el = document.querySelector(opts.selector) as HTMLElement | null;
  if (!el) return { ok: false, error: `selector not found: ${opts.selector}` };
  const input = el as HTMLInputElement | HTMLTextAreaElement;
  el.focus();
  if (opts.clearFirst && "value" in input) input.value = "";
  if ("value" in input) {
    input.value = (opts.clearFirst ? "" : input.value ?? "") + opts.text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } else if ((el as HTMLElement).isContentEditable) {
    document.execCommand("insertText", false, opts.text);
  } else {
    return { ok: false, error: "element is not an input, textarea, or contentEditable" };
  }
  return { ok: true, value: "value" in input ? input.value : undefined };
}

function pressKeyProbe(opts: { key: string; selector: string | null }) {
  const target = (opts.selector ? document.querySelector(opts.selector) : document.activeElement) as HTMLElement | null;
  const dispatchOn = target ?? document.body;
  const keyName = opts.key;
  const keyCodeMap: Record<string, number> = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32 };
  const keyCode = keyCodeMap[keyName] ?? (keyName.length === 1 ? keyName.charCodeAt(0) : 0);
  const init = { key: keyName === "Space" ? " " : keyName, code: keyName, keyCode, which: keyCode, bubbles: true, cancelable: true } as KeyboardEventInit;
  dispatchOn.dispatchEvent(new KeyboardEvent("keydown", init));
  dispatchOn.dispatchEvent(new KeyboardEvent("keypress", init));
  dispatchOn.dispatchEvent(new KeyboardEvent("keyup", init));
  return { ok: true, target: dispatchOn?.tagName?.toLowerCase?.() ?? null };
}

function waitForProbe(opts: { selector: string; state: string; timeoutMs: number }) {
  return new Promise((resolve) => {
    const deadline = Date.now() + opts.timeoutMs;
    const check = () => {
      const el = document.querySelector(opts.selector) as HTMLElement | null;
      let match = false;
      if (opts.state === "attached") match = el !== null;
      else if (opts.state === "hidden") match = !el || (el.offsetParent === null && el.tagName !== "BODY");
      else match = !!el && el.offsetParent !== null;
      if (match) return resolve({ ok: true, foundAt: new Date().toISOString() });
      if (Date.now() >= deadline) return resolve({ ok: false, error: `timed out waiting for '${opts.selector}' to be ${opts.state}` });
      setTimeout(check, 75);
    };
    check();
  });
}
