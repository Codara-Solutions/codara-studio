// test-runner: heavy (launches Chromium through Playwright)
"use strict";
// The page console an agent reads holds what the page logged (feedback round
// 5, item 5): src/main/browser/recorders/console-filter.ts drops Electron's
// security and deprecation warnings and anything logged from an isolated
// world (a preload, an extension), and keeps the page's own logs and errors.
// Checked as rules and through the console recorder on a real Chromium page.
//
//   node scripts/test-preview-console-filter.cjs

const assert = require("node:assert/strict");
const { startCdpChromium } = require("./fixtures/cdp-chromium.cjs");
const { bundleBrowser, startPageServer, openPage, sleep } = require("./fixtures/browser-page-target.cjs");

const lib = bundleBrowser(`export { keepConsoleEntry, isElectronNoise } from "./recorders/console-filter";`);

function rules() {
  const { keepConsoleEntry, isElectronNoise } = lib;
  assert.equal(isElectronNoise("%cElectron Security Warning (Insecure Content-Security-Policy) font-weight: bold;"), true);
  assert.equal(isElectronNoise("Electron Deprecation Warning (contextIsolation default change)"), true);
  assert.equal(isElectronNoise("My Electron Security Warning test page"), false, "only the prefix Electron prints");
  const entry = (message) => ({ level: "warning", message, line: null, source: null, at: "" });
  const main = new Set([1]);
  assert.equal(keepConsoleEntry(entry("hello"), { method: "Runtime.consoleAPICalled", contextId: 1, defaultContexts: main }), true);
  assert.equal(keepConsoleEntry(entry("from a preload"), { method: "Runtime.consoleAPICalled", contextId: 7, defaultContexts: main }), false);
  assert.equal(keepConsoleEntry(entry("boom"), { method: "Runtime.exceptionThrown", contextId: 7, defaultContexts: main }), false);
  assert.equal(keepConsoleEntry(entry("early"), { method: "Runtime.consoleAPICalled", contextId: 3, defaultContexts: new Set() }), true, "before the main world is known, keep");
  assert.equal(keepConsoleEntry(entry("Failed to load resource"), { method: "Log.entryAdded", defaultContexts: main }), true);
  assert.equal(keepConsoleEntry(entry("%cElectron Security Warning (Insecure CSP)"), { method: "Runtime.consoleAPICalled", contextId: 1, defaultContexts: main }), false);
}

async function inChromium() {
  const chromium = await startCdpChromium();
  if (!chromium) {
    console.log("SKIP real Chromium console checks: no Chromium installed (npx playwright install chromium)");
    return;
  }
  const server = await startPageServer({ "/": "<!doctype html><title>Console</title><h1>Console</h1>" });
  const page = await openPage(chromium, lib, server.url("/"));
  const { target, session } = page;
  try {
    const { frameTree } = await session.send("Page.getFrameTree");
    const { executionContextId } = await session.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "preload" });
    await session.send("Runtime.evaluate", { expression: "console.log('isolated world says hi'); setTimeout(() => { throw new Error('isolated failure'); })", contextId: executionContextId });
    await target.evaluate(`
      console.warn('%cElectron Security Warning (Insecure Content-Security-Policy)', 'font-weight: bold;', 'This renderer process has either no Content Security Policy set');
      console.log('page log');
      setTimeout(() => { throw new Error('page failure'); });
    `);
    await sleep(300);
    const messages = lib.consoleRing(session).toArray().map((entry) => entry.message);
    assert.ok(messages.includes("page log"), JSON.stringify(messages));
    assert.ok(messages.some((message) => /page failure/.test(message)), "the page's own errors stay");
    assert.ok(!messages.some((message) => /Electron Security Warning/.test(message)), "Electron's warning is dropped");
    assert.ok(!messages.some((message) => /isolated/.test(message)), "isolated-world logs and errors are dropped");
  } finally {
    page.close();
    server.close();
    await chromium.close();
  }
}

(async () => {
  rules();
  await inChromium();
  console.log("preview console filter: Electron warnings and isolated worlds dropped, page logs kept");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
