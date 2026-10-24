// The browser tools whose Codara-tab handler lives in the renderer or works
// on the webview's webContents, written once more against BrowserTarget so
// they run on a tab of the user's browser. The page work uses the very same
// probes the Codara tabs run (domSnapshot.ts, domActions.ts, preview-dom.ts),
// so a snapshot's @references, a click or a typed value behave the same in
// both; input goes through the DevTools protocol, which needs neither focus
// nor a visible tab.

import { createPreviewDOM } from "../../../shared/preview-dom";
import { createPreviewNames } from "../../../shared/preview-names";
import { snapshotProbe } from "../../../renderer/src/components/Preview/domSnapshot";
import { clickProbe, typeProbe } from "../../../renderer/src/components/Preview/domActions";
import { parseKeyChord, previewKeyEvents } from "../../preview-keyboard";
import { applyEmulation } from "../emulation";
import { consoleRing } from "../recorders/console";
import { clearNetwork, networkRing } from "../recorders/network";
import { captureScreenshot, normalizeScreenshotRequest, type ImageCodec } from "../screenshot";
import type { BrowserTarget } from "../targets";

type Params = Record<string, unknown>;

const NAVIGATE_TIMEOUT_MS = 15_000;
const RING_CAP = 500;

const str = (params: Params, key: string): string | null => (typeof params[key] === "string" ? (params[key] as string) : null);
const num = (params: Params, key: string): number | null =>
  typeof params[key] === "number" && Number.isFinite(params[key]) ? (params[key] as number) : null;

/** A page expression calling one of the shared probes with the DOM factory. */
function probe(fn: (...args: never[]) => unknown, options: unknown): string {
  return `(${fn.toString()})(${JSON.stringify(options)}, ${createPreviewDOM.toString()})`;
}

function run<T>(target: BrowserTarget, expression: string): Promise<T> {
  return target.evaluate<T>(expression, { awaitPromise: true });
}

/** A probe answer that reports failure as { ok: false, error } becomes a thrown error, as on Codara tabs. */
function checked<T extends { ok?: boolean; error?: string }>(value: T): T {
  if (value && value.ok === false) throw new Error(value.error ?? "The page refused the action.");
  return value;
}

export async function navigate(target: BrowserTarget, params: Params): Promise<unknown> {
  const url = str(params, "url");
  if (!url) throw new Error("navigate requires 'url'");
  const session = target.session;
  // The load events below arrive only with the Page domain on; without it
  // every navigation would wait out the whole timeout.
  const releasePage = await session.enable("Page");
  try {
    const loaded = new Promise<void>((resolve) => {
      const offLoad = session.on("Page.loadEventFired", () => done());
      const offDom = session.on("Page.domContentEventFired", () => done());
      const timer = setTimeout(() => done(), NAVIGATE_TIMEOUT_MS);
      function done() {
        clearTimeout(timer);
        offLoad();
        offDom();
        resolve();
      }
    });
    const result = await session.send<{ errorText?: string; loaderId?: string }>("Page.navigate", { url });
    if (result.errorText) throw new Error(`The browser could not load ${url}: ${result.errorText}`);
    // A same-document navigation (a #hash change) fires no load event.
    if (result.loaderId) await loaded;
  } finally {
    void releasePage().catch(() => {});
  }
  const info = await target.info();
  return { url: info.url, title: info.title, tabId: target.ref, opened: false };
}

export async function url(target: BrowserTarget): Promise<unknown> {
  const info = await target.info();
  return { url: info.url, title: info.title, tabId: target.ref };
}

export function snapshot(target: BrowserTarget, params: Params): Promise<unknown> {
  const options = {
    mode: str(params, "mode") ?? "outline",
    maxBytes: num(params, "maxBytes") ?? 12_000,
    selector: str(params, "selector"),
    since: str(params, "since"),
  };
  // The snapshot also takes the icon-name factory, as on Codara tabs (previewRpc.ts).
  return run(target, `(${snapshotProbe.toString()})(${JSON.stringify(options)}, ${createPreviewDOM.toString()}, ${createPreviewNames.toString()})`);
}

/**
 * The last expression's value, like evaluate on a Codara tab: a snippet that
 * parses as one expression is returned as is, anything else runs as a
 * function body where `return` yields the value. The parse check compiles
 * without running, so side effects never run twice.
 */
export async function evaluate(target: BrowserTarget, params: Params): Promise<unknown> {
  const code = str(params, "code");
  if (!code) throw new Error("evaluate requires 'code'");
  const awaitPromise = params.awaitPromise === true;
  const isExpression = await run<boolean>(
    target,
    `(() => { try { new Function(${JSON.stringify(`return (${code}\n)`)}); return true; } catch (e) { if (e instanceof SyntaxError) return false; return true; } })()`,
  ).catch(() => true);
  const inner = isExpression ? `(${code}\n)` : `{ ${code}\n}`;
  const expression = awaitPromise
    ? `Promise.resolve((async () => ${inner})()).then((__r) => JSON.parse(JSON.stringify(__r ?? null)))`
    : `(() => { const __r = (() => ${inner})(); return JSON.parse(JSON.stringify(__r ?? null)); })()`;
  return { value: await run(target, expression) };
}

export async function click(target: BrowserTarget, params: Params): Promise<unknown> {
  const selector = str(params, "selector");
  if (!selector) throw new Error("click requires 'selector'");
  return checked(await run<{ ok?: boolean; error?: string }>(target, probe(clickProbe, { selector })));
}

export async function type(target: BrowserTarget, params: Params): Promise<unknown> {
  const selector = str(params, "selector");
  const text = str(params, "text");
  if (!selector) throw new Error("type requires 'selector'");
  if (text === null) throw new Error("type requires 'text'");
  return checked(await run<{ ok?: boolean; error?: string }>(target, probe(typeProbe, { selector, text, clearFirst: params.clearFirst === true })));
}

// Stringified into the page: the element's viewport center, scrolled into view first unless asked not to.
async function centerProbe(options: { selector: string; scrollIntoView: boolean }, createDOM: typeof createPreviewDOM) {
  const dom = createDOM();
  const el = options.scrollIntoView ? await dom.ready(options.selector) : dom.find(options.selector);
  if (!el) return { ok: false, error: `selector not found: ${options.selector}` };
  return { ok: true, ...dom.point(el) };
}

async function point(target: BrowserTarget, spec: Params, scrollIntoView = true): Promise<{ x: number; y: number }> {
  if (typeof spec.x === "number" && typeof spec.y === "number") return { x: spec.x, y: spec.y };
  const selector = typeof spec.selector === "string" ? spec.selector : null;
  if (!selector) throw new Error("provide either { selector } or explicit { x, y }");
  const found = checked(await run<{ ok?: boolean; error?: string; x: number; y: number }>(target, probe(centerProbe, { selector, scrollIntoView })));
  return { x: found.x, y: found.y };
}

const MODIFIER_BITS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

function modifierBits(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  return raw.reduce((mask: number, name) => mask | (typeof name === "string" ? MODIFIER_BITS[name.toLowerCase()] ?? 0 : 0), 0);
}

async function mouseEvent(target: BrowserTarget, event: Record<string, unknown>): Promise<void> {
  await target.session.send("Input.dispatchMouseEvent", event);
}

export async function mouse(target: BrowserTarget, params: Params): Promise<unknown> {
  const action = str(params, "action") ?? "click";
  const { x, y } = await point(target, params);
  const modifiers = modifierBits(params.modifiers);
  const button = action === "rightclick" ? "right" : "left";
  const press = (clickCount: number) => mouseEvent(target, { type: "mousePressed", x, y, button, clickCount, modifiers });
  const release = (clickCount: number) => mouseEvent(target, { type: "mouseReleased", x, y, button, clickCount, modifiers });
  await mouseEvent(target, { type: "mouseMoved", x, y, modifiers });
  switch (action) {
    case "down":
      await press(1);
      break;
    case "up":
      await release(1);
      break;
    case "click":
    case "rightclick":
      await press(1);
      await release(1);
      break;
    case "dblclick":
      await press(1);
      await release(1);
      await press(2);
      await release(2);
      break;
    default:
      throw new Error(`unknown mouse action '${action}' (expected down|up|click|dblclick|rightclick)`);
  }
  return { ok: true, action, x, y, button };
}

export async function hover(target: BrowserTarget, params: Params): Promise<unknown> {
  const { x, y } = await point(target, params);
  await mouseEvent(target, { type: "mouseMoved", x, y });
  return { ok: true, x, y };
}

export async function scroll(target: BrowserTarget, params: Params): Promise<unknown> {
  const deltaX = num(params, "deltaX") ?? 0;
  const deltaY = num(params, "deltaY") ?? 0;
  if (deltaX === 0 && deltaY === 0) throw new Error("scroll requires a non-zero deltaX or deltaY");
  // The point is only where the wheel turns: centering it would fight the scroll.
  const at = typeof params.selector === "string" || typeof params.x === "number"
    ? await point(target, params, false)
    : await run<{ x: number; y: number }>(target, "({ x: innerWidth / 2, y: innerHeight / 2 })");
  await mouseEvent(target, { type: "mouseWheel", x: at.x, y: at.y, deltaX, deltaY });
  return { ok: true, x: at.x, y: at.y, deltaX, deltaY };
}

export async function drag(target: BrowserTarget, params: Params): Promise<unknown> {
  const from = await point(target, (params.from && typeof params.from === "object" ? params.from : {}) as Params);
  const to = await point(target, (params.to && typeof params.to === "object" ? params.to : {}) as Params);
  const steps = Math.max(1, Math.min(typeof params.steps === "number" ? params.steps | 0 : 12, 100));
  await mouseEvent(target, { type: "mouseMoved", x: from.x, y: from.y });
  await mouseEvent(target, { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await mouseEvent(target, { type: "mouseMoved", x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, button: "left", buttons: 1 });
  }
  await mouseEvent(target, { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });
  return { ok: true, from, to, steps };
}

// Keys reach a page in a background tab or an unfocused window only with
// focus emulated. It is on only while keys are sent: left on, the user's own
// tab would report focus (and keep :focus) while they work elsewhere, and a
// mail or chat app would hold back its notifications. Overlapping calls share
// one enable.
const focusHolds = new WeakMap<object, { count: number; ready: Promise<unknown> }>();

async function withFocusEmulated<T>(target: BrowserTarget, run: () => Promise<T>): Promise<T> {
  const session = target.session;
  let hold = focusHolds.get(session);
  if (hold) hold.count += 1;
  else {
    hold = { count: 1, ready: session.send("Emulation.setFocusEmulationEnabled", { enabled: true }) };
    focusHolds.set(session, hold);
  }
  try {
    await hold.ready;
    return await run();
  } finally {
    hold.count -= 1;
    if (hold.count === 0 && focusHolds.get(session) === hold) {
      focusHolds.delete(session);
      await session.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
    }
  }
}

async function dispatchKey(target: BrowserTarget, key: string, modifiers: string[], text: string | null): Promise<void> {
  const events = previewKeyEvents(key, modifiers, text);
  await withFocusEmulated(target, async () => {
    for (const event of events) await target.session.send("Input.dispatchKeyEvent", event);
  });
}

export async function key(target: BrowserTarget, params: Params): Promise<unknown> {
  const raw = str(params, "key");
  if (!raw) throw new Error("key requires 'key'");
  // "Control+K" and key "k" with modifiers ["control"] are the same chord, as on Codara tabs.
  const { key: name, modifiers } = parseKeyChord(raw, params.modifiers);
  await dispatchKey(target, name, modifiers, str(params, "text"));
  return { ok: true, key: name, modifiers };
}

export async function pressKey(target: BrowserTarget, params: Params): Promise<unknown> {
  const name = str(params, "key");
  if (!name) throw new Error("press_key requires 'key'");
  const selector = str(params, "selector");
  if (selector) {
    const focused = await run<boolean>(
      target,
      `(async () => { const el = await (${createPreviewDOM.toString()})().ready(${JSON.stringify(selector)});
        if (!el || typeof el.focus !== "function") return false;
        el.focus(); return document.activeElement === el || el.contains(document.activeElement); })()`,
    );
    if (!focused) throw new Error(`key target is missing or not focusable: ${selector}`);
  }
  await dispatchKey(target, name, [], null);
  return { ok: true, key: name, trusted: true };
}

export async function upload(target: BrowserTarget, params: Params): Promise<unknown> {
  const selector = str(params, "selector");
  if (!selector) throw new Error("upload requires 'selector' (a file input)");
  const paths = Array.isArray(params.paths) ? params.paths.filter((p): p is string => typeof p === "string" && p.length > 0) : [];
  if (paths.length === 0) throw new Error("upload requires a non-empty 'paths' array");
  const found = await target.session.send<{ result?: { objectId?: string; subtype?: string }; exceptionDetails?: { exception?: { description?: string } } }>(
    "Runtime.evaluate",
    { expression: `(${createPreviewDOM.toString()})().find(${JSON.stringify(selector)})`, returnByValue: false },
  );
  if (found.exceptionDetails) throw new Error(found.exceptionDetails.exception?.description?.split("\n")[0] ?? `file input not found: ${selector}`);
  const objectId = found.result?.objectId;
  if (!objectId || found.result?.subtype === "null") throw new Error(`file input not found: ${selector}`);
  try {
    await target.session.send("DOM.setFileInputFiles", { files: paths, objectId });
  } finally {
    await target.session.send("Runtime.releaseObject", { objectId }).catch(() => {});
  }
  return { ok: true, selector, files: paths };
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw | 0 : 100;
  return Math.max(1, Math.min(n, RING_CAP));
}

export async function consoleEntries(target: BrowserTarget, params: Params): Promise<unknown> {
  // Recording starts when the session attaches; make sure it has.
  await target.session.send("Runtime.enable").catch(() => {});
  const ring = consoleRing(target.session);
  if (params.clear === true) {
    ring.clear();
    return { ok: true, cleared: true, entries: [] };
  }
  const level = str(params, "level")?.toLowerCase() ?? null;
  let entries = ring.toArray();
  if (level) entries = entries.filter((entry) => entry.level === level);
  const sliced = entries.slice(-clampLimit(params.limit));
  return { ok: true, count: sliced.length, total: ring.size, entries: sliced, recordedSince: "attach" };
}

export async function networkEntries(target: BrowserTarget, params: Params): Promise<unknown> {
  await target.session.send("Runtime.enable").catch(() => {});
  if (params.clear === true) {
    clearNetwork(target.session);
    return { ok: true, cleared: true, entries: [] };
  }
  const filter = str(params, "filter");
  let entries = networkRing(target.session).toArray();
  if (filter) entries = entries.filter((entry) => entry.url.includes(filter));
  const sliced = entries.slice(-clampLimit(params.limit));
  return { ok: true, count: sliced.length, total: networkRing(target.session).size, entries: sliced, recordedSince: "attach" };
}

export async function resize(target: BrowserTarget, params: Params): Promise<unknown> {
  const width = num(params, "width");
  const height = num(params, "height");
  if (!width || !height) throw new Error("resize requires numeric 'width' and 'height'");
  // The user's window keeps its size; the page lays out at the asked size.
  // It is the tab's emulated viewport, so emulate reset clears it and the
  // emulation state no longer names a device it replaced.
  const viewport = { width: Math.round(width), height: Math.round(height) };
  await applyEmulation(target, { viewport, mobile: false });
  return { ok: true, ...viewport, tabId: target.ref, emulated: true };
}

let codec: ImageCodec | undefined;

/** Tests without Electron pass their own image codec. */
export function setTabOpsImageCodec(next: ImageCodec | undefined): void {
  codec = next;
}

export async function screenshot(target: BrowserTarget, params: Params): Promise<unknown> {
  const shot = await captureScreenshot(target, normalizeScreenshotRequest(params), codec ? { codec } : {});
  const { data, mimeType, ...rest } = shot;
  return { ...rest, mimeType, dataUrl: `data:${mimeType};base64,${data}` };
}
