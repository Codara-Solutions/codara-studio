"use strict";
// The dead ends agents hit most with the browser tools, on Codara's own tabs
// (renderer previewRpc.ts and registry.ts, with the presence, sleep and
// group modules stubbed): a missing or closed tab's error lists the tabs the
// caller can use, a navigate with a closed tab's id loads where a plain one
// would, the URL a tab already shows is not reloaded unless asked, a second
// close succeeds, click and type say what changed, a window that is still
// starting is waited for, and a capture that times out once is tried again.
//
//   node scripts/test-browser-agent-friction.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const esbuild = require("esbuild");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const PREVIEW = path.join(ROOT, "src/renderer/src/components/Preview");

const STUBS = {
  "agent-presence/store": `
    export function readDriver(value) { return value ?? null; }
    export function assertDriverAllowed() {}
    export function noteDriving() {}
    export async function moveAgentCursor() {}
    export function clearDriver() {}
    export function forgetPresenceTab() {}`,
  "tabs-memory/browserTabs": `
    export function isTabAsleep() { return false; }
    export function isTabWaking() { return false; }
    export function takeWakeUrl() { return null; }
    export function wakeTab() {}`,
  isolatedTabs: `export async function openIsolatedTab() {} export async function closeIsolatedTab() {}`,
  pageDialogs: `export function showPageDialog() {} export function closePageDialog() {}`,
  tabGroupBridge: `export function assignTabToGroup() { return null; } export function tabGroupNameOf() { return null; }`,
  "whiteboard/inspect-whiteboard": `export function inspectWhiteboard() { return null; }`,
};

async function load() {
  const out = await esbuild.build({
    stdin: {
      contents: `export * from "./registry"; export { registerPreviewRpcHandler } from "./previewRpc";`,
      resolveDir: PREVIEW,
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src/shared") },
    loader: { ".css": "empty" },
    plugins: [{
      name: "stubs",
      setup(build) {
        for (const [name, contents] of Object.entries(STUBS)) {
          build.onResolve({ filter: new RegExp(`(^|/)${name.replace("/", "\\/")}$`) }, () => ({ path: name, namespace: "stub" }));
          build.onLoad({ filter: new RegExp(`^${name.replace("/", "\\/")}$`), namespace: "stub" }, () => ({ contents, loader: "js" }));
        }
      },
    }],
  });
  let onRequest = null;
  const responses = new Map();
  globalThis.window = { spark: { previewBridge: { onRequest: (fn) => { onRequest = fn; }, sendResponse: (response) => responses.get(response.reqId)?.(response) } } };
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  mod.exports.registerPreviewRpcHandler();
  let next = 0;
  const call = (op, params) =>
    new Promise((resolve, reject) => {
      const reqId = `r${(next += 1)}`;
      responses.set(reqId, (response) => (response.ok ? resolve(response.result) : reject(new Error(response.error))));
      onRequest({ reqId, op, params });
    });
  return { registry: mod.exports, call };
}

/** A tab's page: what it shows, and the scripts it was asked to run. */
function fakeTab(url, title) {
  const page = { url, title, loads: [], scripts: [], changes: 3 };
  page.handle = {
    getURL: () => page.url,
    getTitle: () => page.title,
    isReady: () => true,
    getWebContentsId: () => 7,
    loadURL: async (next) => {
      page.loads.push(next);
      page.url = next;
      return "loaded";
    },
    executeJavaScript: async (code) => {
      page.scripts.push(code);
      if (code.includes("new PointerEvent")) return { __coraOk: true, value: { ok: true, tag: "button" } };
      if (code.includes("__codaraChanges")) return { __coraOk: true, value: { changes: page.changes } };
      if (code.includes("setter.call")) return { __coraOk: true, value: { ok: true, value: "hello" } };
      return { __coraOk: true, value: null };
    },
  };
  return page;
}

async function main() {
  const { registry: r, call } = await load();

  // A closed or missing tab: the error lists the tabs the caller may name,
  // its own marked, and the one call that opens its own.
  const panes = { "pane-1": "ws" };
  r.setLocatePaneWorkspaceFn((paneId) => panes[paneId] ?? null);
  const docs = fakeTab("http://localhost:5173/docs", "Docs");
  const app = fakeTab("http://localhost:5173/", "App");
  r.registerPreviewTab({ id: "tab-docs", workspaceId: "ws", url: docs.url, handle: docs.handle });
  r.setActivePreviewTab("tab-docs", "ws");
  r.setOpenPreviewTabFn((url, runId, workspaceId) => {
    r.registerPreviewTab({ id: "tab-app", workspaceId, url, runId, handle: app.handle });
    return "tab-app";
  });
  const caller = { workspaceId: "ws", callerPaneId: "pane-1" };
  await assert.rejects(
    call("snapshot", { ...caller, tabId: "tab-gone" }),
    (error) => {
      assert.equal(
        error.message,
        'Browser tab tab-gone is closed. Tabs you can pass as tabId: tab-docs "Docs" localhost:5173/docs (current). To open your own, call codara_preview_navigate with a url.',
      );
      return true;
    },
  );
  r.registerPreviewTab({ id: "tab-other", workspaceId: "elsewhere", url: "about:blank", handle: fakeTab("about:blank", "").handle });
  await assert.rejects(call("screenshot", { ...caller, tabId: "tab-other" }), /^Error: Browser tab tab-other is in another workspace\. Tabs you can pass/);
  await assert.rejects(call("snapshot", { workspaceId: "empty-ws" }), /^Error: This session has no browser tab open\. Your workspace has no browser tabs open\. To open your own, call codara_preview_navigate with a url\.$/);
  await assert.rejects(call("snapshot", { workspaceId: "empty-ws", runId: "run-1" }), /^Error: This run has no browser tab open\./);
  console.log("a missing tab's error lists the usable tabs and how to open one");

  // A navigate naming a closed tab with a url loads where a plain navigate
  // would: this agent's own tab, opened here. Another workspace's tab is refused.
  const opened = await call("navigate", { ...caller, tabId: "tab-gone", url: "http://localhost:5173/" });
  assert.equal(opened.tabId, "tab-app");
  assert.equal(opened.opened, true);
  assert.equal(opened.note, "Tab tab-gone is closed, so this opened a new tab.");
  assert.equal(opened.change, 'Loaded localhost:5173 ("App").');
  await assert.rejects(call("navigate", { ...caller, tabId: "tab-other", url: "http://localhost:5173/" }), /tab-other is in another workspace/);
  assert.match(
    (await call("navigate", { ...caller, tabId: "tab-gone2", url: "http://localhost:5173/" })).note,
    /^Tab tab-gone2 is closed, so this used your own tab\.$/,
  );
  console.log("a navigate with a closed tab's id uses the session's own tab");

  // The URL the tab already shows is not loaded again, and the result says
  // what changed since this agent's last navigate; reload true reloads.
  const loadsBefore = app.loads.length;
  app.title = "App (2)";
  const again = await call("navigate", { ...caller, tabId: "tab-app", url: "http://localhost:5173" });
  assert.equal(app.loads.length, loadsBefore, "no reload");
  assert.equal(again.alreadyThere, true);
  assert.equal(again.change, 'Already on localhost:5173 ("App (2)"); title changed from "App". Not reloaded: pass reload true to reload.');
  await call("navigate", { ...caller, tabId: "tab-app", url: "http://localhost:5173/", reload: true });
  assert.equal(app.loads.length, loadsBefore + 1, "reload true loads it again");
  const moved = await call("navigate", { ...caller, tabId: "tab-app", url: "http://localhost:5173/settings" });
  assert.equal(moved.alreadyThere, undefined);
  assert.equal(moved.change, 'Loaded localhost:5173/settings ("App (2)").');
  console.log("a repeated navigate does not reload and says what changed");

  // Click and type say what they did, so the agent need not look again.
  const clicked = await call("click", { ...caller, tabId: "tab-app", selector: "#save" });
  assert.equal(clicked.change, "The page updated (3 DOM changes); same URL and title.");
  assert.ok(app.scripts.some((code) => code.includes('"watch":true')), "the click probe watches the page");
  app.changes = 0;
  assert.equal((await call("click", { ...caller, tabId: "tab-app", selector: "#noop" })).change, "Nothing on the page changed yet; same URL and title.");
  const typed = await call("type", { ...caller, tabId: "tab-app", selector: "#name", text: "hello" });
  assert.equal(typed.change, 'The field now holds "hello".');
  await assert.rejects(call("resize", { ...caller, tabId: "tab-app", width: 0, height: 0 }), /resize needs width and height in CSS pixels above 0, such as 375 and 667/);
  console.log("click and type results say what changed");

  // Closing twice: the second close finds nothing of this session's and succeeds.
  r.setClosePreviewTabFn((id) => r.unregisterPreviewTab(id));
  assert.deepEqual(await call("close", { ...caller }), { ok: true, tabId: "tab-app", closed: true });
  assert.deepEqual(await call("close", { ...caller }), { ok: true, alreadyClosed: true, note: "This session has no browser tab of its own open; nothing was closed." });
  assert.deepEqual(await call("close", { ...caller, tabId: "tab-app" }), { ok: true, tabId: "tab-app", alreadyClosed: true });
  console.log("a repeated close succeeds");

  // A window that is still starting has no tab opener yet: the call waits for it.
  r.setOpenPreviewTabFn(null);
  setTimeout(() => r.setOpenPreviewTabFn((url, runId, workspaceId) => {
    r.registerPreviewTab({ id: "tab-late", workspaceId, url, runId, handle: fakeTab(url, "Late").handle });
    return "tab-late";
  }), 300);
  const late = await r.ensurePreviewTab("http://localhost:5173/", null, "ws-late");
  assert.deepEqual([late.tab.id, late.opened], ["tab-late", true]);
  assert.equal(r.OPEN_TAB_READY_MS, 10_000);
  console.log("a tab opened while the window starts waits for it");

  // A frame capture that times out once is tried again; twice says what to do.
  const capture = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(path.join(PREVIEW, "capturePaint.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports: capture, require: () => ({}), WeakMap, setTimeout, clearTimeout, Promise, Error, Math },
  );
  const frame = { getSize: () => ({ width: 2, height: 2 }), toDataURL: () => `data:image/png;base64,${"A".repeat(300)}` };
  let tries = 0;
  const slowOnce = () => (tries += 1) === 1 ? new Promise(() => {}) : Promise.resolve(frame);
  assert.equal(await capture.captureFrameDataUrl(slowOnce, 30), frame.toDataURL());
  assert.equal(tries, 2);
  await assert.rejects(
    capture.captureFrameDataUrl(() => new Promise(() => {}), 30),
    /^Error: The tab did not paint a frame within 0 s \(it is in the background or busy\)\. Call codara_preview_screenshot once more, or read the page with codara_preview_snapshot, which needs no paint\.$/,
  );
  await assert.rejects(capture.captureFrameDataUrl(() => Promise.reject(new Error("UnknownVizError")), 30), /preview screenshot failed: UnknownVizError/);
  console.log("a capture that timed out once is tried again");
}

main().then(
  () => console.log("browser agent friction ok"),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
