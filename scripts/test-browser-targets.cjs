"use strict";
// Tab ids and the browser target registry (src/main/browser/tab-ref.ts,
// targets.ts): the formats agents pass as tabId, and how a call reaches the
// Codara or Chrome backend.
//
//   node scripts/test-browser-targets.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

(async () => {
  const out = await esbuild.build({
    stdin: { contents: `export * from "./tab-ref"; export * from "./targets";`, resolveDir: path.join(ROOT, "src/main/browser"), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  const lib = mod.exports;

  assert.equal(lib.parseTabRef(undefined), null);
  assert.equal(lib.parseTabRef("  "), null);
  assert.deepEqual(lib.parseTabRef("tab-1"), { kind: "preview", tabId: "tab-1" });
  assert.deepEqual(lib.parseTabRef("preview:tab-1"), { kind: "preview", tabId: "tab-1" });
  assert.deepEqual(lib.parseTabRef("chrome:42"), { kind: "chrome", tabId: 42, linkId: null });
  assert.deepEqual(lib.parseTabRef("Chrome:Edge-2/42"), { kind: "chrome", tabId: 42, linkId: "edge-2" });
  for (const bad of ["chrome:", "chrome:abc", "chrome:1/2/3", "chrome:-x/5", "chrome:42abc"]) {
    assert.throws(() => lib.parseTabRef(bad), lib.BrowserTabRefError, bad);
  }
  for (const ref of [{ kind: "preview", tabId: "tab-1" }, { kind: "chrome", tabId: 42, linkId: null }, { kind: "chrome", tabId: 7, linkId: "brave" }]) {
    assert.deepEqual(lib.parseTabRef(lib.formatTabRef(ref)), ref, "ids round-trip");
  }
  assert.equal(lib.isChromeTabRef(" chrome:1"), true);
  assert.equal(lib.isChromeTabRef("tab-1"), false);

  await assert.rejects(lib.resolveBrowserTarget({ tabId: "chrome:5" }), /No Chrome browser is connected/);
  await assert.rejects(lib.resolveBrowserTarget({}), /not ready/);
  const resolved = [];
  const fakeTarget = (kind, ref) => ({ kind, ref, session: null, workspaceId: null });
  const offPreview = lib.registerBrowserBackend({ kind: "preview", resolve: async (ref, params) => { resolved.push(["preview", ref, params.workspaceId]); return fakeTarget("preview", ref ? ref.tabId : "default"); } });
  const offChrome = lib.registerBrowserBackend({ kind: "chrome", resolve: async (ref) => { resolved.push(["chrome", ref]); return fakeTarget("chrome", lib.formatTabRef(ref)); } });
  assert.equal((await lib.resolveBrowserTarget({ workspaceId: "ws" })).ref, "default", "no tabId is the caller's own Codara tab, never Chrome");
  assert.equal((await lib.resolveBrowserTarget({ tabId: "tab-3" })).ref, "tab-3");
  assert.equal((await lib.resolveBrowserTarget({ tabId: "chrome:9" })).ref, "chrome:9");
  assert.deepEqual(resolved.map(([kind]) => kind), ["preview", "preview", "chrome"]);
  offChrome();
  await assert.rejects(lib.resolveBrowserTarget({ tabId: "chrome:9" }), /No Chrome browser is connected/, "a disconnected link unregisters");
  offPreview();

  const session = {
    sent: [],
    async send(method, params) {
      session.sent.push([method, params]);
      if (params.expression === "boom") return { exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom\n    at <anonymous>:1:1" } } };
      if (params.expression === "reject") return { exceptionDetails: { text: "Uncaught (in promise)", exception: { value: "nope" } } };
      return { result: { value: { answer: 42 } } };
    },
  };
  assert.deepEqual(await lib.evaluateOverCdp(session, "x", { awaitPromise: true }), { answer: 42 });
  assert.deepEqual(session.sent[0], ["Runtime.evaluate", { expression: "x", returnByValue: true, awaitPromise: true, userGesture: true }]);
  await assert.rejects(lib.evaluateOverCdp(session, "boom"), /^Error: Error: boom$/);
  await assert.rejects(lib.evaluateOverCdp(session, "reject"), /nope/);
  console.log("browser targets: tab ids round-trip, no tabId never reaches Chrome, backends register and unregister");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
