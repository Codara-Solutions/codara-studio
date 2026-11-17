#!/usr/bin/env node
"use strict";

// A terminal op sent while the app window is still starting is held until
// React has mounted (src/main/renderer-readiness.ts) instead of going into a
// renderer that cannot hear it: the hold has its own limit, the op's timeout
// starts once the window is ready, a caller that goes away drops its held op,
// and a window that never gets ready fails with a message that says so.
// Before the app starts tracking, nothing is held back. terminal.list answers
// from the panes the renderer sends main with every change, and only while
// that copy is as current as a round trip; a list held for a starting window
// is answered from it once the window is ready. Runs src/main/terminal-bridge.ts
// against an Electron stub, on scripts/fake-clock.cjs. The end-to-end case (a
// socket client lists before the window is ready) is in test-agent-socket.cjs.
//
//   node scripts/test-renderer-readiness.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

const stubs = {
  name: "renderer-readiness-stubs",
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "ready-stub" }));
    build.onResolve({ filter: /^\.\/main-window-trust$/ }, () => ({ path: "trust", namespace: "ready-stub" }));
    build.onLoad({ filter: /^electron$/, namespace: "ready-stub" }, () => ({
      loader: "js",
      contents: `
        const stub = globalThis.__readyStub;
        export const ipcMain = { on: (channel, listener) => stub.listeners.set(channel, listener) };
        export const BrowserWindow = { getFocusedWindow: () => null, getAllWindows: () => [stub.window] };
      `,
    }));
    build.onLoad({ filter: /^trust$/, namespace: "ready-stub" }, () => ({
      loader: "js",
      contents: `
        export const getTrustedMainWindow = () => globalThis.__readyStub.window;
        export const isTrustedOnSender = () => true;
      `,
    }));
  },
};

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}`);
    console.log(error && error.stack ? error.stack : String(error));
  }
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-renderer-readiness-"));
  try {
    const sent = [];
    globalThis.__readyStub = {
      listeners: new Map(),
      window: { webContents: { isDestroyed: () => false, isLoading: () => false, send: (_channel, request) => sent.push(request) } },
    };
    const entry = path.join(temp, "entry.ts");
    fs.writeFileSync(
      entry,
      `export * from ${JSON.stringify(path.join(ROOT, "src", "main", "terminal-bridge.ts"))};\n` +
        `export * from ${JSON.stringify(path.join(ROOT, "src", "main", "renderer-readiness.ts"))};\n`,
    );
    const outfile = path.join(temp, "bridge.cjs");
    await esbuild.build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "cjs", plugins: [stubs], logLevel: "silent" });
    const clock = require("./fake-clock.cjs").installFakeClock();
    const bridge = require(outfile);
    bridge.registerTerminalBridge();
    const respond = (reqId, result) =>
      globalThis.__readyStub.listeners.get("terminal-bridge:response")({}, { reqId, ok: true, result });

    const settled = (promise) => {
      const state = { outcome: null };
      promise.then((value) => (state.outcome = { value }), (error) => (state.outcome = { error: error.message }));
      return state;
    };

    await check("before the app tracks the window, an op is sent at once", async () => {
      const op = bridge.requestTerminalOp("list", {}, { timeoutMs: 5_000 });
      assert.equal(sent.length, 1, "sent in the same tick");
      respond(sent[0].reqId, { panes: [] });
      assert.deepEqual(await op, { panes: [] });
    });

    await check("an op sent while the window starts is held past its own timeout, then goes once ready", async () => {
      bridge.markRendererNotReady();
      const before = sent.length;
      const op = bridge.requestTerminalOp("list", {}, { timeoutMs: 5_000 });
      const state = settled(op);
      await clock.advance(10_000);
      assert.equal(sent.length, before, "nothing is sent into a window that cannot hear it");
      assert.equal(state.outcome, null, "a 10 s boot does not use up a 5 s op");
      bridge.markRendererReady();
      await clock.advance(0);
      assert.equal(sent.length, before + 1);
      respond(sent[before].reqId, { panes: ["p"] });
      assert.deepEqual(await op, { panes: ["p"] });
    });

    await check("the op's own timeout starts once the window is ready", async () => {
      bridge.markRendererNotReady();
      const before = sent.length;
      const state = settled(bridge.requestTerminalOp("list", {}, { timeoutMs: 5_000 }));
      await clock.advance(12_000);
      bridge.markRendererReady();
      await clock.advance(4_999);
      assert.equal(sent.length, before + 1);
      assert.equal(state.outcome, null, "still within its 5 s after the window got ready");
      await clock.advance(1);
      assert.deepEqual(state.outcome, { error: "terminal op 'list' timed out after 5000ms" });
    });

    await check("a window that never gets ready fails after the hold's own limit, with a message that says so", async () => {
      bridge.markRendererNotReady();
      const before = sent.length;
      const state = settled(bridge.requestTerminalOp("list", {}, { timeoutMs: 5_000 }));
      await clock.advance(bridge.RENDERER_HOLD_MS - 1);
      assert.equal(state.outcome, null);
      await clock.advance(1);
      assert.deepEqual(state.outcome, { error: bridge.RENDERER_STARTING_MESSAGE });
      assert.equal(sent.length, before, "nothing was sent");
    });

    await check("a held op is dropped when its caller goes away, so no tab is opened for nobody", async () => {
      bridge.markRendererNotReady();
      const before = sent.length;
      const callerGone = new AbortController();
      const state = settled(bridge.requestTerminalOp("create", { title: "t" }, { timeoutMs: 5_000, signal: callerGone.signal }));
      await clock.advance(2_000);
      callerGone.abort();
      await clock.advance(0);
      assert.deepEqual(state.outcome, { error: bridge.RENDERER_HOLD_ABORTED_MESSAGE });
      bridge.markRendererReady();
      await clock.advance(0);
      assert.equal(sent.length, before, "the create never reached the renderer");
    });

    await check("a reload makes ops wait again", async () => {
      bridge.markRendererReady();
      bridge.markRendererNotReady();
      assert.equal(bridge.isRendererReady(), false);
      bridge.markRendererReady();
      assert.equal(bridge.isRendererReady(), true);
    });

    const push = (inventory) => globalThis.__readyStub.listeners.get("terminal-bridge:inventory-changed")({}, inventory);
    const pane = (paneId, extra = {}) => ({ paneId, tabId: `tab-${paneId}`, workspaceId: "w1", title: paneId, profile: "shell", ...extra });

    await check("the panes the renderer sends are listed from main, with no round trip", async () => {
      bridge.markRendererNotReady();
      bridge.markRendererReady();
      assert.equal(bridge.cachedStudioTerminalInventory(), null, "nothing before the renderer has sent its panes");
      push([pane("a"), pane("b", { cwd: "/w" })]);
      assert.deepEqual(bridge.cachedStudioTerminalInventory(), [pane("a"), pane("b", { cwd: "/w" })]);
      push([{ paneId: 7 }]);
      assert.deepEqual(bridge.cachedStudioTerminalInventory().map((entry) => entry.paneId), ["a", "b"], "a malformed inventory is ignored");
    });

    await check("after a create or destroy from main, the copy is used again only once the renderer sent its panes after it", async () => {
      push([pane("a")]);
      const before = sent.length;
      const create = bridge.requestTerminalOp("create", { title: "new" }, { timeoutMs: 5_000 });
      await clock.advance(0);
      assert.equal(bridge.cachedStudioTerminalInventory(), null, "a create in flight");
      push([pane("a")]);
      assert.equal(bridge.cachedStudioTerminalInventory(), null, "panes sent before the renderer answered the create");
      respond(sent[before].reqId, { tabId: "tab-n", paneId: "n" });
      await create;
      assert.equal(bridge.cachedStudioTerminalInventory(), null, "answered, but its panes not sent yet");
      push([pane("a"), pane("n")]);
      assert.deepEqual(bridge.cachedStudioTerminalInventory().map((entry) => entry.paneId), ["a", "n"]);
      const destroy = settled(bridge.requestTerminalOp("destroy", { tabId: "tab-n" }, { timeoutMs: 5_000 }));
      await clock.advance(5_000);
      assert.deepEqual(destroy.outcome, { error: "terminal op 'destroy' timed out after 5000ms" });
      assert.equal(bridge.cachedStudioTerminalInventory(), null, "a destroy that timed out may still land");
      push([pane("a")]);
      assert.equal(bridge.cachedStudioTerminalInventory(), null, "not until the renderer answered it");
      respond(sent.at(-1).reqId, { closed: true });
      push([pane("a")]);
      assert.deepEqual(bridge.cachedStudioTerminalInventory().map((entry) => entry.paneId), ["a"]);
      const list = bridge.requestTerminalOp("list", {}, { timeoutMs: 5_000 });
      await clock.advance(0);
      assert.ok(bridge.cachedStudioTerminalInventory(), "a list does not change the panes");
      respond(sent.at(-1).reqId, []);
      await list;
    });

    await check("a reload or a crashed renderer forgets the copy", async () => {
      push([pane("a")]);
      bridge.markRendererNotReady();
      assert.equal(bridge.cachedStudioTerminalInventory(), null);
      bridge.markRendererReady();
      assert.equal(bridge.cachedStudioTerminalInventory(), null, "until the new document sends its panes");
    });

    await check("a list held for a starting window is answered from the panes it sent before getting ready, with no round trip", async () => {
      const events = [];
      const stop = bridge.onHeldTerminalOp((event) => events.push(event.phase));
      bridge.markRendererNotReady();
      const before = sent.length;
      const list = settled(bridge.requestTerminalOp("list", {}, { timeoutMs: 5_000 }));
      await clock.advance(3_000);
      push([pane("a"), pane("b")]); // App.tsx sends its panes before signalReady
      assert.equal(bridge.cachedStudioTerminalInventory(), null, "not used while the window is not ready");
      bridge.markRendererReady();
      await clock.advance(0);
      assert.deepEqual(list.outcome && list.outcome.value.map((entry) => entry.paneId), ["a", "b"]);
      assert.equal(sent.length, before, "no op went to the window");
      assert.deepEqual(events, ["held", "copy"]);
      stop();
    });

    await check("the copy is not used while the window is not ready, so an old document sending after a navigation began cannot refill it", async () => {
      bridge.markRendererReady();
      push([pane("a")]);
      bridge.markRendererNotReady(); // did-start-navigation
      push([pane("old")]);
      assert.equal(bridge.cachedStudioTerminalInventory(), null);
      push([pane("new")]); // the new document, before its signalReady
      bridge.markRendererReady();
      assert.deepEqual(bridge.cachedStudioTerminalInventory().map((entry) => entry.paneId), ["new"]);
    });

    await check("a create that timed out keeps the copy unused until panes sent after its late answer", async () => {
      push([pane("a")]);
      const before = sent.length;
      const create = settled(bridge.requestTerminalOp("create", { title: "late" }, { timeoutMs: 5_000 }));
      await clock.advance(5_000);
      assert.deepEqual(create.outcome, { error: "terminal op 'create' timed out after 5000ms" });
      push([pane("a")]); // rendered before the renderer carried the create out
      assert.equal(bridge.cachedStudioTerminalInventory(), null, "panes sent before the late answer may predate the create");
      respond(sent[before].reqId, { tabId: "tab-late", paneId: "late" });
      assert.equal(bridge.cachedStudioTerminalInventory(), null, "answered late, its panes not sent yet");
      push([pane("a"), pane("late")]);
      assert.deepEqual(bridge.cachedStudioTerminalInventory().map((entry) => entry.paneId), ["a", "late"]);
    });

    await check("a timed-out create that is never answered blocks the copy for the late window only", async () => {
      push([pane("a")]);
      const create = settled(bridge.requestTerminalOp("create", { title: "lost" }, { timeoutMs: 5_000 }));
      await clock.advance(5_000);
      assert.ok(create.outcome && create.outcome.error);
      push([pane("a")]);
      assert.equal(bridge.cachedStudioTerminalInventory(), null);
      await clock.advance(5 * 60_000);
      push([pane("a")]);
      assert.deepEqual(bridge.cachedStudioTerminalInventory().map((entry) => entry.paneId), ["a"]);
    });

    await check("a call with one deadline holds within it: the op gets what the hold left", async () => {
      bridge.markRendererNotReady();
      const before = sent.length;
      const create = settled(bridge.requestTerminalOp("create", { title: "t" }, { timeoutMs: 40_000, holdWithinTimeout: true }));
      await clock.advance(25_000);
      bridge.markRendererReady();
      await clock.advance(0);
      assert.equal(sent.length, before + 1);
      await clock.advance(14_999);
      assert.equal(create.outcome, null);
      await clock.advance(1);
      assert.deepEqual(create.outcome, { error: "terminal op 'create' timed out after 40000ms" }, "40 s in all, hold included");
      bridge.markRendererNotReady();
      const short = settled(bridge.requestTerminalOp("create", { title: "t" }, { timeoutMs: 20_000, holdWithinTimeout: true }));
      await clock.advance(20_000);
      assert.deepEqual(short.outcome, { error: bridge.RENDERER_STARTING_MESSAGE }, "the hold ends with the call's deadline");
      bridge.markRendererReady();
      await clock.advance(5 * 60_000); // let the timed-out create's late window pass
    });

    await check("App.tsx sends its panes before it tells main it is ready", () => {
      const app = fs.readFileSync(path.join(ROOT, "src", "renderer", "src", "App.tsx"), "utf8");
      const component = app.indexOf("export default function App(");
      const panes = app.indexOf("notifyInventoryChanged?.(inventory)");
      const ready = app.indexOf("window.spark.app.signalReady?.()");
      assert.ok(component >= 0 && panes > component && ready > panes, "effects run in order: the pane list's effect must come first");
      assert.equal(app.indexOf("signalReady?.()", ready + "window.spark.app.signalReady?.()".length), -1, "one ready signal");
    });

    await check("paired phones hear only changes to what they show", async () => {
      let pings = 0;
      const stop = bridge.onStudioTerminalInventoryChanged(() => (pings += 1));
      push([pane("a")]);
      push([pane("a", { cwd: "/elsewhere" })]);
      assert.equal(pings, 1, "a cwd change is not shown on a phone");
      push([pane("a", { title: "renamed" })]);
      assert.equal(pings, 2);
      globalThis.__readyStub.listeners.get("terminal-bridge:inventory-changed")({});
      assert.equal(pings, 3, "a bare ping from an older renderer still reaches them");
      stop();
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  if (failures > 0) process.exit(1);
  console.log("renderer readiness: all passed");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
