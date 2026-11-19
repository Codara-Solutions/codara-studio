// The browser tools whose Codara-tab handler lives in the renderer or works
// on the webview's webContents, written once more against BrowserTarget so
// they run on a tab of the user's browser. The page work uses the very same
// probes the Codara tabs run (domSnapshot.ts, domActions.ts, preview-dom.ts),
// so a snapshot's @references, a click or a typed value behave the same in
// both; input goes through the DevTools protocol, which needs neither focus
// nor a visible tab, or, in a browser whose extension has no debugger
// (Firefox), is played as a script in the page (scripted-input.ts).

import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { Script } from "node:vm";

import {
  CHANGES_STOP_EXPRESSION,
  describeAlreadyThere,
  describeChange,
  describePage,
  describeTyped,
  pageAnsweredFine,
  PAGE_LOAD_CHECK_EXPRESSION,
  sameUrl,
  type PageState,
} from "../../../shared/browser-change";
import { createPreviewDOM } from "../../../shared/preview-dom";
import { createPreviewNames } from "../../../shared/preview-names";
import { snapshotProbe } from "../../../renderer/src/components/Preview/domSnapshot";
import { clickProbe, typeProbe } from "../../../renderer/src/components/Preview/domActions";
import { parseKeyChord, previewKeyEvents } from "../../preview-keyboard";
import { applyEmulation } from "../emulation";
import { consoleRing } from "../recorders/console";
import { clearNetwork, networkRing } from "../recorders/network";
import { captureScreenshot, normalizeScreenshotRequest, type ImageCodec } from "../screenshot";
import {
  SCRIPTED_INPUT_NOTE,
  SCRIPTED_UPLOAD_MAX_BYTES,
  SCRIPTED_UPLOAD_PIN_KEY,
  scriptedInputProbe,
  scriptedUploadPinProbe,
  scriptedUploadProbe,
  uploadMimeType,
  type InputStep,
} from "../scripted-input";
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

// Each tab's last navigate by an agent, so a repeated one can say what changed since.
const lastNavigates = new Map<string, { title: string; at: number; failed?: boolean }>();
const LAST_NAVIGATES_MAX = 200;
const LOAD_CHECK_MS = 400;

async function pageLoadedFine(target: BrowserTarget, url: string): Promise<boolean> {
  const page = await Promise.race([
    target.evaluate(PAGE_LOAD_CHECK_EXPRESSION).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), LOAD_CHECK_MS)),
  ]);
  return pageAnsweredFine(page, url);
}

function rememberNavigate(ref: string, title: string, failed = false): void {
  lastNavigates.delete(ref);
  lastNavigates.set(ref, { title, at: Date.now(), ...(failed ? { failed } : {}) });
  if (lastNavigates.size > LAST_NAVIGATES_MAX) lastNavigates.delete(lastNavigates.keys().next().value as string);
}

export async function navigate(target: BrowserTarget, params: Params): Promise<unknown> {
  const url = str(params, "url");
  if (!url) throw new Error("navigate requires 'url'");
  // The page the tab already shows is not loaded again, as on Codara tabs,
  // unless its last load failed or answered with an error status.
  if (params.reload !== true && lastNavigates.get(target.ref)?.failed !== true) {
    const shown = await target.info().catch(() => null);
    if (shown && sameUrl(shown.url, url) && (await pageLoadedFine(target, url))) {
      return {
        url: shown.url,
        title: shown.title,
        tabId: target.ref,
        opened: false,
        alreadyThere: true,
        change: describeAlreadyThere(shown, lastNavigates.get(target.ref) ?? null),
      };
    }
  }
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
    if (result.errorText) {
      rememberNavigate(target.ref, "", true);
      throw new Error(`The browser could not load ${url}: ${result.errorText}`);
    }
    // A same-document navigation (a #hash change) fires no load event.
    if (result.loaderId) await loaded;
  } finally {
    void releasePage().catch(() => {});
  }
  const info = await target.info();
  rememberNavigate(target.ref, info.title);
  return { url: info.url, title: info.title, tabId: target.ref, opened: false, change: `Loaded ${describePage(info)}.` };
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
 * Whether a snippet parses as one expression. Decided here, compiled and
 * never run: a page whose policy forbids `new Function` would make every
 * snippet look like an expression and a statement body fail to parse.
 */
export function isExpressionSnippet(code: string): boolean {
  try {
    new Script(`(function () { return (${code}\n); })`);
    return true;
  } catch (error) {
    return !(error instanceof SyntaxError);
  }
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
  const isExpression = isExpressionSnippet(code);
  const inner = isExpression ? `(${code}\n)` : `{ ${code}\n}`;
  const expression = awaitPromise
    ? `Promise.resolve((async () => ${inner})()).then((__r) => JSON.parse(JSON.stringify(__r ?? null)))`
    : `(() => { const __r = (() => ${inner})(); return JSON.parse(JSON.stringify(__r ?? null)); })()`;
  return { value: await run(target, expression) };
}

/** Point the agent's cursor on the page at the element it acts on; never fails the action. */
async function pointAt(target: BrowserTarget, selector: string, action: string): Promise<void> {
  const spot = await point(target, { selector }).catch(() => null);
  if (spot) await target.showActivity(action, spot).catch(() => {});
}

// How long a click's page gets to react before the result describes it, and
// how long reading that may take before the page counts as still loading.
const CLICK_SETTLE_MS = 150;
const CLICK_READ_MS = 400;

async function pageState(target: BrowserTarget): Promise<PageState | null> {
  return target.info().then((info) => ({ url: info.url, title: info.title }), () => null);
}

export async function click(target: BrowserTarget, params: Params): Promise<unknown> {
  const selector = str(params, "selector");
  if (!selector) throw new Error("click requires 'selector'");
  await pointAt(target, selector, "click");
  const before = await pageState(target);
  const result = checked(await run<{ ok?: boolean; error?: string }>(target, probe(clickProbe, { selector, watch: true })));
  if (!before) return result;
  await new Promise((resolve) => setTimeout(resolve, CLICK_SETTLE_MS));
  const read = await Promise.race([
    target.evaluate<{ changes?: unknown }>(CHANGES_STOP_EXPRESSION).catch(() => null),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), CLICK_READ_MS)),
  ]);
  const after = await Promise.race([pageState(target), new Promise<null>((resolve) => setTimeout(() => resolve(null), CLICK_READ_MS))]);
  if (!after) return { ...result, change: "The page is still loading after the click." };
  const changes = read && typeof read.changes === "number" ? read.changes : null;
  return { ...result, change: describeChange(before, { ...after, loading: read === undefined }, changes) };
}

export async function type(target: BrowserTarget, params: Params): Promise<unknown> {
  const selector = str(params, "selector");
  const text = str(params, "text");
  if (!selector) throw new Error("type requires 'selector'");
  if (text === null) throw new Error("type requires 'text'");
  await pointAt(target, selector, "type");
  const result = checked(await run<{ ok?: boolean; error?: string }>(target, probe(typeProbe, { selector, text, clearFirst: params.clearFirst === true })));
  return { ...result, change: describeTyped(result) };
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

/**
 * Whether the tab's browser takes the protocol's trusted input. A Chromium
 * extension relays it; Firefox's has no debugger and refuses it, so the
 * input is scripted in the page instead (scripted-input.ts) and the answer
 * says so.
 */
function scriptsInput(target: BrowserTarget, method: string): boolean {
  return target.session.refuses(method) !== null;
}

/**
 * Plays mouse events: trusted through the protocol, or scripted in the
 * page in one go where the browser has no trusted input. What a scripted
 * run adds to the answer (what it acted on, that it was scripted) is
 * returned.
 */
async function mouseEvents(target: BrowserTarget, steps: InputStep[]): Promise<Record<string, unknown>> {
  if (scriptsInput(target, "Input.dispatchMouseEvent")) return scripted(target, steps);
  for (const step of steps) await target.session.send("Input.dispatchMouseEvent", step);
  return {};
}

async function scripted(target: BrowserTarget, steps: InputStep[]): Promise<Record<string, unknown>> {
  const { ok: _ok, ...result } = checked(
    await run<{ ok?: boolean; error?: string }>(target, `(${scriptedInputProbe.toString()})(${JSON.stringify(steps)}, ${createPreviewDOM.toString()})`),
  );
  return { ...result, trusted: false, note: SCRIPTED_INPUT_NOTE };
}

export async function mouse(target: BrowserTarget, params: Params): Promise<unknown> {
  const action = str(params, "action") ?? "click";
  const { x, y } = await point(target, params);
  const modifiers = modifierBits(params.modifiers);
  const button = action === "rightclick" ? "right" : "left";
  const press = (clickCount: number): InputStep => ({ type: "mousePressed", x, y, button, clickCount, modifiers });
  const release = (clickCount: number): InputStep => ({ type: "mouseReleased", x, y, button, clickCount, modifiers });
  const steps: InputStep[] = [{ type: "mouseMoved", x, y, modifiers }];
  switch (action) {
    case "down":
      steps.push(press(1));
      break;
    case "up":
      steps.push(release(1));
      break;
    case "click":
    case "rightclick":
      steps.push(press(1), release(1));
      break;
    case "dblclick":
      steps.push(press(1), release(1), press(2), release(2));
      break;
    default:
      throw new Error(`unknown mouse action '${action}' (expected down|up|click|dblclick|rightclick)`);
  }
  return { ok: true, action, x, y, button, ...(await mouseEvents(target, steps)) };
}

export async function hover(target: BrowserTarget, params: Params): Promise<unknown> {
  const { x, y } = await point(target, params);
  return { ok: true, x, y, ...(await mouseEvents(target, [{ type: "mouseMoved", x, y }])) };
}

export async function scroll(target: BrowserTarget, params: Params): Promise<unknown> {
  const deltaX = num(params, "deltaX") ?? 0;
  const deltaY = num(params, "deltaY") ?? 0;
  if (deltaX === 0 && deltaY === 0) throw new Error("scroll requires a non-zero deltaX or deltaY");
  // The point is only where the wheel turns: centering it would fight the scroll.
  const at = typeof params.selector === "string" || typeof params.x === "number"
    ? await point(target, params, false)
    : await run<{ x: number; y: number }>(target, "({ x: innerWidth / 2, y: innerHeight / 2 })");
  const played = await mouseEvents(target, [{ type: "mouseWheel", x: at.x, y: at.y, deltaX, deltaY }]);
  return { ok: true, x: at.x, y: at.y, deltaX, deltaY, ...played };
}

export async function drag(target: BrowserTarget, params: Params): Promise<unknown> {
  const from = await point(target, (params.from && typeof params.from === "object" ? params.from : {}) as Params);
  const to = await point(target, (params.to && typeof params.to === "object" ? params.to : {}) as Params);
  const steps = Math.max(1, Math.min(typeof params.steps === "number" ? params.steps | 0 : 12, 100));
  const events: InputStep[] = [
    { type: "mouseMoved", x: from.x, y: from.y },
    { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 },
  ];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    events.push({ type: "mouseMoved", x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, button: "left", buttons: 1 });
  }
  events.push({ type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });
  return { ok: true, from, to, steps, ...(await mouseEvents(target, events)) };
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

async function dispatchKey(target: BrowserTarget, key: string, modifiers: string[], text: string | null): Promise<Record<string, unknown>> {
  const events = previewKeyEvents(key, modifiers, text) as InputStep[];
  if (scriptsInput(target, "Input.dispatchKeyEvent")) return scripted(target, events);
  await withFocusEmulated(target, async () => {
    for (const event of events) await target.session.send("Input.dispatchKeyEvent", event);
  });
  return {};
}

export async function key(target: BrowserTarget, params: Params): Promise<unknown> {
  const raw = str(params, "key");
  if (!raw) throw new Error("key requires 'key'");
  // "Control+K" and key "k" with modifiers ["control"] are the same chord, as on Codara tabs.
  const { key: name, modifiers } = parseKeyChord(raw, params.modifiers);
  const played = await dispatchKey(target, name, modifiers, str(params, "text"));
  return { ok: true, key: name, modifiers, ...played };
}

export async function pressKey(target: BrowserTarget, params: Params): Promise<unknown> {
  const name = str(params, "key");
  if (!name) throw new Error("press_key requires 'key'");
  const selector = str(params, "selector");
  // Scripted keys focus their target in the same script that plays them, so nothing can move focus in between.
  if (scriptsInput(target, "Input.dispatchKeyEvent")) {
    const steps = [...(selector ? [{ type: "focus", selector }] : []), ...(previewKeyEvents(name, [], null) as InputStep[])];
    return { ok: true, key: name, ...(await scripted(target, steps)) };
  }
  if (selector) {
    const focused = await run<boolean>(
      target,
      `(async () => { const el = await (${createPreviewDOM.toString()})().ready(${JSON.stringify(selector)});
        if (!el || typeof el.focus !== "function") return false;
        el.focus(); return document.activeElement === el || el.contains(document.activeElement); })()`,
    );
    if (!focused) throw new Error(`key target is missing or not focusable: ${selector}`);
  }
  const played = await dispatchKey(target, name, [], null);
  return { ok: true, key: name, trusted: true, ...played };
}

export async function upload(target: BrowserTarget, params: Params): Promise<unknown> {
  const selector = str(params, "selector");
  if (!selector) throw new Error("upload requires 'selector' (a file input)");
  const paths = Array.isArray(params.paths) ? params.paths.filter((p): p is string => typeof p === "string" && p.length > 0) : [];
  if (paths.length === 0) throw new Error("upload requires a non-empty 'paths' array");
  if (scriptsInput(target, "DOM.setFileInputFiles")) return scriptedUpload(target, selector, paths);
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

/**
 * Upload where the browser cannot set a file input's files (Firefox): Codara
 * reads the files and the page gets them as File objects set on the input,
 * as a drop from the desktop would. The input is found and pinned in its
 * page first; the bytes go only to that page, never to one that replaced it
 * while the files were read. Each file is read from one open handle, within
 * what is left of the limit, so a file that grows meanwhile cannot pass it.
 */
async function scriptedUpload(target: BrowserTarget, selector: string, paths: string[]): Promise<unknown> {
  const pin = randomUUID();
  checked(await run<{ ok?: boolean; error?: string }>(target, `(${scriptedUploadPinProbe.toString()})(${JSON.stringify({ selector, count: paths.length, pin, key: SCRIPTED_UPLOAD_PIN_KEY })}, ${createPreviewDOM.toString()})`));
  const tooLarge = () => new Error(`upload: in this browser the files go through the page, at most ${SCRIPTED_UPLOAD_MAX_BYTES / 1_000_000} MB in all; these are larger.`);
  let left = SCRIPTED_UPLOAD_MAX_BYTES;
  const files: { name: string; type: string; lastModified: number; data: string }[] = [];
  for (const path of paths) {
    const handle = await open(path, "r").catch(() => null);
    if (!handle) throw new Error(`upload: ${path} is not a file.`);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error(`upload: ${path} is not a file.`);
      if (info.size > left) throw tooLarge();
      // One byte more than its size tells a file that grew while it was read.
      const buffer = Buffer.alloc(info.size + 1);
      let read = 0;
      while (read < buffer.length) {
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      if (read > info.size) throw new Error(`upload: ${path} changed while it was read; nothing was uploaded.`);
      left -= read;
      files.push({ name: basename(path), type: uploadMimeType(path), lastModified: Math.round(info.mtimeMs), data: buffer.subarray(0, read).toString("base64") });
    } finally {
      await handle.close();
    }
  }
  const result = checked(await run<{ ok?: boolean; error?: string }>(target, `(${scriptedUploadProbe.toString()})(${JSON.stringify({ pin, key: SCRIPTED_UPLOAD_PIN_KEY, files })})`));
  return { ...result, ok: true, selector, files: paths, trusted: false, note: SCRIPTED_INPUT_NOTE };
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
  if (!width || !height || width < 0 || height < 0) throw new Error("resize needs width and height in CSS pixels above 0, such as 375 and 667.");
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
