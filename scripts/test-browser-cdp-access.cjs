// test-runner: heavy (launches Chromium through Playwright and QuickJS worker threads)
"use strict";
// DevTools access in codara_browser_use (src/main/browser/cdp-policy.ts,
// src/main/preview-tools/cdp.ts, tab.network and tab.cdp in the prelude):
// - the policy: allowed domains pass, anything that reaches past the tab or
//   the machine is refused with its reason, a method outside the allowlist
//   is refused, navigation stays on http and https, events only from
//   allowed domains;
// - on a real Chromium page, through a snippet: commands return their
//   result, refusals throw a BrowserError, Domain.disable never stops the
//   network recorder, the read-only Debugger never pauses the page, event
//   subscriptions catch what happens after they start and belong to their
//   caller, a huge result is saved to a file, tab.network lists, details
//   and waits for responses, and the user's Chrome never shows sign-in
//   headers.
//
//   node scripts/test-browser-cdp-access.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const { startCdpChromium } = require("./fixtures/cdp-chromium.cjs");
const { bundleBrowser, startPageServer, openPage, ROOT } = require("./fixtures/browser-page-target.cjs");

const ARTIFACTS = fs.mkdtempSync(path.join(os.tmpdir(), "codara-cdp-access-"));

async function bundle(contents, resolveDir, stubs = {}) {
  const out = await esbuild.build({
    stdin: { contents, resolveDir, loader: "ts" },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    logLevel: "silent",
    plugins: [{
      name: "stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => (stubs[args.path] ? { path: args.path, namespace: "stub" } : undefined));
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "ts", resolveDir }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const BROWSER_DIR = path.join(ROOT, "src/main/browser");
const TOOLS_DIR = path.join(ROOT, "src/main/preview-tools");
let policy;

function policyChecks() {
  for (const method of [
    "Runtime.evaluate", "Network.getResponseBody", "Network.setBlockedURLs", "Page.navigate", "Page.captureScreenshot",
    "DOM.getDocument", "CSS.getComputedStyleForNode", "Accessibility.getFullAXTree", "Overlay.highlightNode",
    "Performance.getMetrics", "Emulation.setDeviceMetricsOverride", "Log.enable", "Debugger.getScriptSource",
  ]) {
    assert.deepEqual(policy.checkCdpCommand(method), { ok: true, domain: method.split(".")[0] }, `${method} is allowed`);
  }
  const refused = {
    "Browser.getVersion": /whole browser/,
    "Browser.setDownloadBehavior": /whole browser/,
    "Target.createTarget": /other tabs/,
    "Target.setAutoAttach": /other tabs/,
    "SystemInfo.getInfo": /machine/,
    "IO.read": /files outside the page/,
    "Storage.clearDataForOrigin": /beyond this tab/,
    "Storage.getCookies": /beyond this tab/,
    "Fetch.enable": /hanging once the snippet ends/,
    "Fetch.fulfillRequest": /hanging once the snippet ends/,
    "Input.dispatchMouseEvent": /visible cursor/,
    "Security.setIgnoreCertificateErrors": /certificate/,
    "ServiceWorker.enable": /outlive the tab/,
    "Page.setDownloadBehavior": /downloads at a folder/,
    "Page.addScriptToEvaluateOnNewDocument": /keep running in the tab/,
    "Page.handleJavaScriptDialog": /tab\.dialog/,
    "DOM.setFileInputFiles": /reads files/,
    "DOM.getFileInfo": /file paths/,
    "Network.getAllCookies": /whole profile/,
    "Network.getCookies": /codara_preview_storage/,
    "Network.clearBrowserCache": /whole profile/,
    "Network.loadNetworkResource": /past CORS/,
    "Debugger.setSkipAllPauses": /never freezes/,
    "Debugger.pause": /read-only/,
  };
  for (const [method, reason] of Object.entries(refused)) {
    const decision = policy.checkCdpCommand(method);
    assert.equal(decision.ok, false, `${method} is refused`);
    assert.match(decision.reason, reason, method);
  }
  for (const method of ["Debugger.setBreakpointByUrl", "Animation.enable", "HeapProfiler.takeHeapSnapshot", "Page.printToPDF", "Runtime.terminateExecution"]) {
    assert.equal(policy.checkCdpCommand(method).ok, false, `${method} is not on the allowlist`);
  }
  for (const bad of ["", "evaluate", "runtime.evaluate", "Runtime.", "Runtime.evaluate.x", 42, null]) {
    assert.equal(policy.checkCdpCommand(bad).ok, false, `${JSON.stringify(bad)} is not a method name`);
  }
  assert.equal(policy.cdpParamsError("Page.navigate", { url: "https://example.com/a" }), null);
  assert.equal(policy.cdpParamsError("Page.navigate", { url: "http://127.0.0.1:5173" }), null);
  assert.equal(policy.cdpParamsError("Page.navigate", { url: "about:blank" }), null);
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "devtools://devtools/x", "data:text/html,x", "relative/path", ""]) {
    assert.ok(policy.cdpParamsError("Page.navigate", { url }), `Page.navigate refuses ${url || "an empty url"}`);
  }
  assert.equal(policy.cdpParamsError("Runtime.evaluate", { expression: "1" }), null);
  // Script, URL and access-flag parameters: an allowed command never takes
  // one that makes it stronger.
  assert.match(policy.cdpParamsError("Page.reload", { ignoreCache: true, scriptToEvaluateOnLoad: "steal()" }), /may not take scriptToEvaluateOnLoad: it injects script into every frame/);
  assert.equal(policy.cdpParamsError("Page.reload", { ignoreCache: true }), null);
  assert.equal(policy.cdpParamsError("Page.reload", {}), null);
  assert.match(policy.cdpParamsError("Page.reload", { loaderId: "x" }), /takes only ignoreCache/);
  assert.match(policy.cdpParamsError("Page.createIsolatedWorld", { frameId: "f", grantUniveralAccess: true }), /universal access ignores the same-origin rules/);
  assert.equal(policy.cdpParamsError("Page.createIsolatedWorld", { frameId: "f", grantUniveralAccess: false }), null);
  assert.equal(policy.cdpParamsError("Page.createIsolatedWorld", { frameId: "f", worldName: "probe" }), null);
  assert.match(policy.cdpParamsError("Page.navigate", { url: "https://example.com", somethingNew: 1 }), /takes only url/);
  assert.match(policy.cdpParamsError("Runtime.evaluate", { expression: "1", scriptToEvaluateOnLoad: "x" }), /may not take scriptToEvaluateOnLoad/, "forbidden on every method");
  assert.equal(policy.checkCdpEvent("Network.responseReceived").ok, true);
  assert.equal(policy.checkCdpEvent("Debugger.scriptParsed").ok, true);
  assert.equal(policy.checkCdpEvent("Target.attachedToTarget").ok, false);
  assert.equal(policy.checkCdpEvent("Fetch.requestPaused").ok, false);
  // In the user's Chrome, script and DOM edits stay with tab.evaluate; reads stay open.
  for (const method of ["Runtime.evaluate", "Runtime.callFunctionOn", "Debugger.enable", "Page.createIsolatedWorld", "DOM.resolveNode", "DOM.setOuterHTML", "CSS.addRule"]) {
    const decision = policy.checkCdpCommand(method, { userBrowser: true });
    assert.equal(decision.ok, false, `${method} is refused in the user's Chrome`);
    assert.match(decision.reason, /tab of your own browser.*tab\.evaluate/);
  }
  for (const method of ["Network.getResponseBody", "DOM.getDocument", "CSS.getComputedStyleForNode", "Accessibility.getFullAXTree", "Page.navigate", "Performance.getMetrics"]) {
    assert.equal(policy.checkCdpCommand(method, { userBrowser: true }).ok, true, `${method} stays open in the user's Chrome`);
  }
  assert.equal(policy.checkCdpEvent("Debugger.scriptParsed", { userBrowser: true }).ok, false);
  assert.equal(policy.checkCdpEvent("Network.responseReceived", { userBrowser: true }).ok, true);
  const allowlist = policy.cdpAllowlist();
  for (const domain of ["Browser", "Target", "SystemInfo", "IO", "Storage", "Fetch", "Input"]) {
    assert.equal(domain in allowlist, false, `${domain} has no allowed method`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const APP = `<!doctype html><title>Orders</title>
  <h1 id="title" style="color: rgb(200, 10, 10)">Orders</h1>
  <button id="load" onclick="fetch('/api/orders', { headers: { authorization: 'Bearer live-token' } }).then(r => r.json()).then(d => document.querySelector('#count').textContent = d.orders.length)">Load</button>
  <p id="count">0</p>`;

async function realPage() {
  const chromium = await startCdpChromium();
  if (!chromium) {
    console.log("SKIP real-page checks: no Chromium (npx playwright install chromium)");
    return;
  }
  const lib = bundleBrowser(`export { networkTool } from "./network-detail";`);
  const code = await bundle(`export * from "./sessions"; export * from "./kernel";`, path.join(BROWSER_DIR, "code"));
  code.setBrowserKernelWorkerCode(esbuild.buildSync({
    entryPoints: [path.join(BROWSER_DIR, "code", "kernel-worker.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "silent",
  }).outputFiles[0].text);
  // The tab comes from the test, and big results land in a temporary folder.
  // code.ts is in the same bundle, so the owner symbol it sets is cdp.ts's.
  const cdp = await bundle(`export * from "./cdp"; export { codePreviewTools } from "./code";`, TOOLS_DIR, {
    "../browser/code/sessions": `export async function runBrowserCode(request: any) { (globalThis as any).__codeRequest = request; return { ok: true }; }`,
    "../preview-workspace": `export async function scopePreviewWorkspace() {}`,
    "./core": `export async function requireTarget(params: Record<string, unknown>) { return (globalThis as any).__cdpTargets[String(params.tabId ?? "tab-1")]; }`,
    "../browser/artifacts": `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      export async function writeBrowserArtifact(_ws: unknown, kind: string, input: { label: string; ext: string; data: string }) {
        const file = join(${JSON.stringify(ARTIFACTS)}, kind + "-" + Date.now() + "." + input.ext);
        writeFileSync(file, input.data);
        return file;
      }`,
  });
  const server = await startPageServer({
    "/app": APP,
    "/debugger": `<!doctype html><script>window.reached = false; setTimeout(() => { debugger; window.reached = true; }, 50);</script>`,
    "/api/orders": (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ orders: [1, 2, 3] })),
    "/api/big": (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ blob: "x".repeat(1_200_000) })),
  });
  const page = await openPage(chromium, lib, server.url("/app"));
  const chromePage = await openPage(chromium, lib, server.url("/app"), "chrome:7");
  chromePage.target.kind = "chrome";
  globalThis.__cdpTargets = { "tab-1": page.target, "chrome:7": chromePage.target };
  const tools = cdp.cdpPreviewTools;
  const identity = { callerPaneId: "pane-a", workspaceId: "ws-1" };
  const dispatchAs = (who, owner = "owner-a") => async (method, args) => {
    const params = { ...args, ...who, [cdp.CDP_OWNER]: owner };
    const target = globalThis.__cdpTargets[String(params.tabId ?? "tab-1")];
    switch (method) {
      case "preview.cdp": return tools["preview.cdp"].run(params, method, {});
      case "preview.cdp_events": return tools["preview.cdp_events"].run(params, method, {});
      case "preview.network": return lib.networkTool(target, params);
      case "preview.evaluate": return { value: await target.evaluate(String(args.code)) };
      default: throw new Error(`no fake for ${method}`);
    }
  };
  const run = (snippet, who = identity, key = "cdp", owner = "owner-a") => code.runBrowserCode({ key, ownerPid: null, code: snippet, timeoutMs: 20_000, dispatch: dispatchAs(who, owner) });
  const asOwner = (owner, params) => ({ ...params, ...identity, [cdp.CDP_OWNER]: owner });

  // code.ts stamps every inner call with its session key, on a symbol a
  // snippet's JSON arguments cannot carry or replace.
  const forwarded = [];
  await cdp.codePreviewTools(async (method, params) => { forwarded.push(params); return {}; })["browser.use"].run(
    { code: "1", codeSession: "4242:abcdefgh1234", callerPaneId: "pane-a", workspaceId: "ws-1" },
    "browser.use",
    { scopeToCaller: async () => {} },
  );
  const request = globalThis.__codeRequest;
  await request.dispatch("preview.cdp", { method: "DOM.getDocument", cdpOwner: "someone-else" });
  assert.equal(forwarded[0][cdp.CDP_OWNER], request.key, "the owner is the code session's key");
  assert.match(request.key, /4242:abcdefgh1234/, "the key names the agent's MCP process");
  try {
    let result = await run(`
      const tab = browser.tab("tab-1");
      const sum = await tab.cdp.send("Runtime.evaluate", { expression: "6 * 7", returnByValue: true });
      const doc = await tab.cdp.send("DOM.getDocument", { depth: 1 });
      const { nodeId } = await tab.cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#title" });
      await tab.cdp.send("DOM.enable");
      const styles = await tab.cdp.send("CSS.enable").then(() => tab.cdp.send("CSS.getComputedStyleForNode", { nodeId }));
      const color = styles.computedStyle.find((entry) => entry.name === "color").value;
      const metrics = await tab.cdp.send("Performance.enable").then(() => tab.cdp.send("Performance.getMetrics"));
      const refusals = {};
      for (const [method, params] of [["Browser.getVersion"], ["Target.getTargets"], ["Fetch.enable"], ["Page.navigate", { url: "file:///etc/passwd" }], ["Network.getAllCookies"]]) {
        refusals[method] = await tab.cdp.send(method, params).then(() => "sent", (error) => error.name + ": " + error.message);
      }
      ({ sum: sum.result.value, color, metrics: metrics.metrics.some((m) => m.name === "Nodes"), refusals })
    `);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.sum, 42);
    assert.equal(result.result.color, "rgb(200, 10, 10)");
    assert.equal(result.result.metrics, true);
    for (const [method, message] of Object.entries(result.result.refusals)) {
      assert.match(message, /^BrowserError: /, `${method} throws a BrowserError`);
      assert.doesNotMatch(message, /sent/);
    }
    assert.match(result.result.refusals["Page.navigate"], /http and https pages only/);

    // Disabling Network gives back the snippet's own hold only: the recorder
    // keeps recording.
    result = await run(`
      await tab.cdp.send("Network.enable");
      await tab.cdp.send("Network.disable");
      await tab.network.clear();
      const response = tab.network.waitForResponse("/api/orders", { timeout: 5000 });
      await tab.evaluate("document.querySelector('#load').click()");
      const detail = await response;
      const rows = await tab.network.list({ filter: "/api/" });
      ({ status: detail.status, body: detail.body, auth: detail.requestHeaders.authorization, rows: rows.length })
    `);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.result, { status: 200, body: '{"orders":[1,2,3]}', auth: "[redacted]", rows: 1 });

    // A subscription sees what happens after it starts; next() filters.
    result = await run(`
      const sub = await tab.cdp.on(["Network.responseReceived", "Network.requestWillBeSent"]);
      await tab.evaluate("fetch('/api/orders?again=1')");
      const seen = await sub.next({ filter: (params, method) => method === "Network.responseReceived" && params.response.url.includes("again=1"), timeout: 5000 });
      const none = await sub.next({ filter: () => false, timeout: 300 });
      globalThis.subId = sub.id;
      ({ status: seen.params.response.status, none, id: sub.id })
    `);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.status, 200);
    assert.equal(result.result.none, null, "next() returns null at its timeout");
    const subscriptionId = result.result.id;
    await assert.rejects(
      tools["preview.cdp_events"].run({ action: "read", subscription: subscriptionId, callerPaneId: "pane-b", workspaceId: "ws-1" }, "preview.cdp_events", {}),
      /No such event subscription/,
      "another caller cannot read a subscription",
    );
    // Two MCP processes in one pane (callerPid is gone by now) are two owners.
    await assert.rejects(
      tools["preview.cdp_events"].run(asOwner("owner-b", { action: "read", subscription: subscriptionId }), "preview.cdp_events", {}),
      /No such event subscription/,
      "another agent session in the same pane cannot read it",
    );
    const own = await tools["preview.cdp_events"].run(asOwner("owner-a", { action: "read", subscription: subscriptionId }), "preview.cdp_events", {});
    assert.equal(own.ok, true, "its own session reads it");
    await tools["preview.cdp_events"].run(asOwner("owner-a", { action: "unsubscribe", subscription: subscriptionId }), "preview.cdp_events", {});
    assert.equal(cdp.cdpSubscriptionCount(), 0);

    // Holds are per owner: another session's disable leaves this one's domain on.
    await tools["preview.cdp"].run(asOwner("owner-a", { method: "DOM.enable" }), "preview.cdp", {});
    await tools["preview.cdp"].run(asOwner("owner-b", { method: "DOM.enable" }), "preview.cdp", {});
    await tools["preview.cdp"].run(asOwner("owner-b", { method: "DOM.disable" }), "preview.cdp", {});
    let updates = 0;
    const stopCounting = page.session.on("DOM.documentUpdated", () => { updates += 1; });
    await page.session.send("Page.reload", {});
    await sleep(500);
    stopCounting();
    assert.ok(updates > 0, "owner a's DOM hold survived owner b's disable");
    await tools["preview.cdp"].run(asOwner("owner-a", { method: "DOM.disable" }), "preview.cdp", {});

    // The read-only Debugger never stops the page on a debugger statement.
    result = await run(`
      await tab.cdp.send("Debugger.enable");
      await tab.cdp.send("Page.navigate", { url: ${JSON.stringify(server.url("/debugger"))} });
      await sleep(600);
      const reached = await tab.evaluate("window.reached");
      await tab.cdp.send("Debugger.disable");
      reached
    `);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result, true, "the page ran past its debugger statement");

    // A result over the inline limit is saved to a file.
    result = await run(`
      await tab.cdp.send("Page.navigate", { url: ${JSON.stringify(server.url("/app"))} });
      await sleep(300);
      const big = await tab.cdp.send("Runtime.evaluate", { expression: "fetch('/api/big').then(r => r.text())", awaitPromise: true, returnByValue: true });
      big
    `);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.result.path && fs.existsSync(result.result.path), "the big result is on disk");
    assert.ok(result.result.chars > 1_000_000);

    // In the user's Chrome, events never carry sign-in headers.
    result = await run(`
      const chromeTab = browser.tab("chrome:7");
      const sub = await chromeTab.cdp.on("Network.requestWillBeSent");
      await chromeTab.evaluate("document.querySelector('#load').click()");
      const sent = await sub.next({ filter: (params) => params.request.url.includes("/api/orders"), timeout: 5000 });
      await sub.close();
      const scripted = await chromeTab.cdp.send("Runtime.evaluate", { expression: "1" }).then(() => "ran", (error) => error.message);
      ({ headers: sent.params.request.headers, scripted })
    `, identity, "cdp-chrome");
    assert.equal(result.ok, true, JSON.stringify(result));
    const headers = Object.fromEntries(Object.entries(result.result.headers).map(([name, value]) => [name.toLowerCase(), value]));
    assert.equal(headers.authorization, "[redacted]", "authorization is redacted in Chrome");
    assert.match(result.result.scripted, /not available on a tab of your own browser/);
  } finally {
    cdp.closeCdpSubscriptions();
    await code.closeBrowserCodeSessions();
    page.close();
    chromePage.close();
    server.close();
    await chromium.close();
    fs.rmSync(ARTIFACTS, { recursive: true, force: true });
  }
}

(async () => {
  policy = await bundle(`export * from "./cdp-policy";`, BROWSER_DIR);
  policyChecks();
  await realPage();
  console.log("browser cdp access: policy, commands, events, holds and redaction ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
