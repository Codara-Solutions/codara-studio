"use strict";
// The per-tab DevTools protocol session (src/main/browser/cdp-session.ts) and
// the console and network recorders built on it: ref-counted domains shared
// by several consumers, re-enable after a re-attach, bounded buffers, and
// recording from the first request of a real Chromium page.
//
//   node scripts/test-browser-cdp-session.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const http = require("node:http");
const esbuild = require("esbuild");
const { startCdpChromium } = require("./fixtures/cdp-chromium.cjs");

const ROOT = path.resolve(__dirname, "..");

async function loadBrowserModules() {
  const out = await esbuild.build({
    stdin: {
      contents: `
        export * from "./cdp-session";
        export * from "./recorders/console";
        export * from "./recorders/network";
      `,
      resolveDir: path.join(ROOT, "src/main/browser"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function fakeTransport() {
  const sent = [];
  const eventListeners = new Set();
  const detachListeners = new Set();
  const transport = {
    sent,
    attached: false,
    failAttach: null,
    attach() {
      if (transport.failAttach) throw new Error(transport.failAttach);
      transport.attached = true;
    },
    isAttached: () => transport.attached,
    detach() { transport.attached = false; },
    async send(method, params) {
      if (!transport.attached) throw new Error("not attached");
      sent.push([method, params]);
      return {};
    },
    onEvent(listener) { eventListeners.add(listener); return () => eventListeners.delete(listener); },
    onDetach(listener) { detachListeners.add(listener); return () => detachListeners.delete(listener); },
    emit(method, params) { for (const listener of eventListeners) listener(method, params); },
    drop(reason) { transport.attached = false; for (const listener of detachListeners) listener(reason); },
  };
  return transport;
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function sessionLogic(lib) {
  const transport = fakeTransport();
  const session = new lib.CdpSession("tab-1", transport, { reattachDelayMs: 5 });
  await tick();
  assert.ok(session.isAttached(), "a session attaches as it is created");

  const releaseA = await session.enable("Overlay", { mode: "a" });
  const releaseB = await session.enable("Overlay", { mode: "b" });
  assert.deepEqual(transport.sent.filter(([m]) => m === "Overlay.enable"), [["Overlay.enable", { mode: "a" }]], "two consumers, one enable");
  await releaseA();
  await releaseA();
  assert.equal(transport.sent.filter(([m]) => m === "Overlay.disable").length, 0, "still held by B; a double release counts once");
  await releaseB();
  assert.equal(transport.sent.filter(([m]) => m === "Overlay.disable").length, 1, "the last release disables");
  const releaseNetwork = await session.enable("Network");
  await releaseNetwork();
  assert.equal(transport.sent.filter(([m]) => m === "Network.disable").length, 0, "Network is sticky");

  const seen = [];
  session.on("Page.loadEventFired", () => { throw new Error("one bad listener"); });
  session.on("Page.loadEventFired", (params) => seen.push(params.timestamp));
  const originalWarn = console.warn;
  console.warn = () => {};
  transport.emit("Page.loadEventFired", { timestamp: 1 });
  console.warn = originalWarn;
  assert.deepEqual(seen, [1], "a throwing listener does not starve the others");

  const held = await session.enable("Emulation", { keep: true });
  transport.sent.length = 0;
  const detached = [];
  session.onDetach((reason) => detached.push(reason));
  transport.drop("Render process gone.");
  await tick(30);
  assert.deepEqual(detached, ["Render process gone."]);
  assert.ok(transport.attached, "re-attached after an unexpected detach");
  const reenabled = transport.sent.map(([m]) => m);
  assert.ok(reenabled.includes("Emulation.enable") && reenabled.includes("Network.enable"), "held domains come back");
  assert.ok(!reenabled.includes("Overlay.enable"), "released domains stay off");
  assert.deepEqual(transport.sent.find(([m]) => m === "Emulation.enable")[1], { keep: true });
  await held();

  transport.detach();
  transport.failAttach = "Another debugger is already attached";
  await assert.rejects(session.send("Runtime.evaluate", {}), /could not attach the DevTools protocol to this tab \(Another debugger is already attached\)/);
  assert.match(session.unavailableReason, /Another debugger/);
  transport.failAttach = null;
  await session.send("Runtime.evaluate", { expression: "1" });
  assert.equal(session.unavailableReason, null, "the next call attaches again");

  const ring = session.ring("console", 3);
  for (const n of [1, 2, 3, 4, 5]) ring.push(n);
  assert.deepEqual(ring.toArray(), [3, 4, 5]);
  assert.equal(ring.dropped, 2);
  const other = new lib.CdpSession("tab-1-next", fakeTransport());
  other.ring("console", 3).push(0);
  other.adoptRings(session.ringsSnapshot());
  assert.deepEqual(other.ring("console", 3).toArray(), [4, 5, 0], "a replaced guest keeps the tab's history before its own entries, still bounded");
  assert.equal(other.ring("console", 3).dropped, 3);

  session.dispose();
  assert.equal(transport.attached, false, "disposing detaches");
  await assert.rejects(session.send("Runtime.evaluate", {}), /tab closed/);
  transport.emit("Page.loadEventFired", { timestamp: 2 });
  assert.deepEqual(seen, [1], "no events after dispose");
}

async function attachRecovery(lib) {
  // The first attach fails (another client holds the tab): the recorders'
  // domains fail with it, and the call that finally attaches brings them back.
  const transport = fakeTransport();
  transport.failAttach = "Another debugger is already attached";
  const session = new lib.CdpSession("tab-2", transport, { reattachDelayMs: 5 });
  lib.startNetworkRecorder(session);
  lib.startConsoleRecorder(session);
  await tick(10);
  assert.equal(transport.sent.length, 0);
  transport.failAttach = null;
  await session.send("Runtime.evaluate", { expression: "1" });
  await tick(10);
  const enabled = transport.sent.map(([m]) => m).filter((m) => m.endsWith(".enable")).sort();
  assert.deepEqual(enabled, ["Log.enable", "Network.enable", "Runtime.enable"], "held domains come back once a later call attaches");
  assert.deepEqual(transport.sent.find(([m]) => m === "Network.enable")[1], { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: 5_000_000 });

  // The user dismissed the browser's debugging bar: no attaching behind their back.
  transport.reattachAfter = (reason) => reason !== "canceled_by_user";
  transport.sent.length = 0;
  transport.drop("canceled_by_user");
  await tick(30);
  assert.equal(transport.attached, false, "no automatic re-attach after the user cancelled");
  await session.send("Runtime.evaluate", { expression: "2" });
  assert.ok(transport.sent.some(([m]) => m === "Network.enable"), "the next call attaches and restores what is held");
  transport.drop("target crashed");
  await tick(30);
  assert.equal(transport.attached, true, "other detaches still re-attach on their own");
  session.dispose();

  // Redirect hops share a request id; evicting the first hop keeps the last one indexed.
  const netTransport = fakeTransport();
  const net = new lib.CdpSession("tab-3", netTransport);
  lib.startNetworkRecorder(net);
  const request = (requestId, url) => netTransport.emit("Network.requestWillBeSent", { requestId, request: { url, method: "GET" } });
  request("r", "http://x/old");
  for (let i = 0; i < lib.NETWORK_RING_CAP - 2; i++) request(`f${i}`, `http://x/${i}`);
  request("r", "http://x/new");
  request("last", "http://x/last");
  netTransport.emit("Network.responseReceived", { requestId: "r", response: { status: 200, mimeType: "text/html" } });
  const hops = lib.networkRing(net).toArray().filter((entry) => entry.requestId === "r");
  assert.deepEqual(hops.map((entry) => [entry.url, entry.status]), [["http://x/new", 200]], "the surviving hop still gets its response");
  net.dispose();
}

async function recordersAgainstChromium(lib) {
  const chromium = await startCdpChromium();
  if (!chromium) {
    console.log("SKIP real Chromium checks: no Chromium installed (npx playwright install chromium)");
    return;
  }
  const server = http.createServer((req, res) => {
    if (req.url === "/missing.js") { res.writeHead(404); res.end("nope"); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>fixture</title><script>console.log("boot", 42, {a:1, b:"x"}, [1, 2]); console.warn("careful"); fetch("/missing.js").catch(()=>{}); setTimeout(() => { throw new Error("late failure"); }, 0);</script>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const { targetId } = await chromium.newPage("about:blank");
    const transport = chromium.transportFor(targetId);
    const session = new lib.CdpSession(`chrome:${targetId}`, transport, { reattachDelayMs: 20 });
    lib.startConsoleRecorder(session);
    lib.startNetworkRecorder(session);
    lib.startConsoleRecorder(session);
    await session.enable("Page");
    await session.send("Page.navigate", { url });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const failing = lib.networkRing(session).toArray().find((entry) => entry.url.endsWith("/missing.js"));
      if (failing?.status === 404 && lib.consoleRing(session).toArray().some((entry) => /late failure/.test(entry.message))) break;
      await tick(50);
    }
    const consoleEntries = lib.consoleRing(session).toArray();
    const boot = consoleEntries.find((entry) => entry.message.startsWith("boot"));
    assert.ok(boot, `the first console call is recorded: ${JSON.stringify(consoleEntries)}`);
    assert.equal(boot.message, 'boot 42 {a: 1, b: "x"} [1, 2]');
    assert.equal(boot.level, "info");
    assert.equal(consoleEntries.filter((entry) => entry.message.startsWith("boot")).length, 1, "starting twice records once");
    assert.ok(consoleEntries.some((entry) => entry.level === "warning" && entry.message === "careful"));
    assert.ok(consoleEntries.some((entry) => entry.level === "error" && /late failure/.test(entry.message)), "uncaught errors are recorded");
    const network = lib.networkRing(session).toArray();
    const page = network.find((entry) => entry.url === url);
    assert.equal(page?.status, 200, "the document request is recorded from the first navigation");
    assert.equal(page.mimeType, "text/html");
    assert.equal(network.find((entry) => entry.url.endsWith("/missing.js")).status, 404);

    lib.clearNetwork(session);
    assert.equal(lib.networkRing(session).size, 0);

    // Another client takes the tab away; the session comes back and keeps recording.
    transport.forceDetach();
    await tick(300);
    assert.ok(session.isAttached(), "re-attached after losing the tab");
    await session.send("Runtime.evaluate", { expression: "console.log('after reattach')" });
    const after = Date.now() + 5_000;
    while (Date.now() < after && !lib.consoleRing(session).toArray().some((entry) => entry.message === "after reattach")) await tick(50);
    assert.ok(lib.consoleRing(session).toArray().some((entry) => entry.message === "after reattach"), "recording resumes after a re-attach");
    session.dispose();
  } finally {
    server.close();
    await chromium.close();
  }
}

(async () => {
  const lib = await loadBrowserModules();
  await sessionLogic(lib);
  await attachRecovery(lib);
  await recordersAgainstChromium(lib);
  console.log("browser cdp session: shared domains, re-attach, bounded buffers, console and network from the first request");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
