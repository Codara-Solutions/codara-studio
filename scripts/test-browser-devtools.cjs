// test-runner: heavy (launches Chromium through Playwright)
"use strict";
// The agent's DevTools for a browser tab: emulation (src/main/browser/
// emulation.ts), network detail and HAR export (recorders/network.ts,
// network-detail.ts, har.ts) and origin storage (storage.ts). Option parsing
// and protocol bookkeeping run against fakes; the behaviour an agent relies
// on (dark mode, a phone's viewport, offline, headers, bodies, cookies,
// IndexedDB) runs in a real Chromium page served from a local fixture.
//
//   node scripts/test-browser-devtools.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const { startCdpChromium } = require("./fixtures/cdp-chromium.cjs");
const { startDevtoolsSite, SESSION_COOKIE, BEARER, PIXEL_BYTES } = require("../tests/e2e/fixtures/devtools-site.cjs");

const ROOT = path.resolve(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codara-devtools-home-"));

async function loadModules() {
  const out = await esbuild.build({
    stdin: {
      contents: `
        export * from "./cdp-session";
        export * from "./emulation";
        export * from "./har";
        export * from "./network-detail";
        export * from "./recorders/console";
        export * from "./recorders/network";
        export * from "./storage";
        export { evaluateOverCdp } from "./targets";
      `,
      resolveDir: path.join(ROOT, "src/main/browser"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    plugins: [{
      name: "home",
      setup(build) {
        build.onResolve({ filter: /codara-home$/ }, () => ({ path: "codara-home", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: `module.exports = { codaraHome: () => ${JSON.stringify(HOME)} };`,
          loader: "js",
        }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await tick(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function fakeSession() {
  const sent = [];
  const detachListeners = new Set();
  const listeners = new Map();
  const session = {
    sent,
    attached: true,
    isDisposed: false,
    held: [],
    // What the page reports as [screen.width, devicePixelRatio].
    pageMetrics: [0, 1],
    visibility: "visible",
    async send(method, params) {
      if (method === "Runtime.evaluate") {
        return { result: { value: params.expression === "document.visibilityState" ? session.visibility : session.pageMetrics } };
      }
      if (method === "Page.captureScreenshot") {
        sent.push([method, params]);
        return { data: Buffer.from("png").toString("base64") };
      }
      sent.push([method, params]);
      return {};
    },
    isAttached: () => session.attached,
    hold(domain) { session.held.push(domain); },
    on(method, listener) { listeners.set(method, listener); return () => listeners.delete(method); },
    emit(method, params = {}) { listeners.get(method)?.(params, method); },
    onDetach(listener) { detachListeners.add(listener); return () => detachListeners.delete(listener); },
    drop() { session.attached = false; for (const listener of detachListeners) listener("target_crashed"); },
  };
  return session;
}

function emulationLogic(lib) {
  const parse = lib.normalizeEmulationRequest;
  assert.deepEqual(parse({}), { reset: false, changes: {} }, "nothing passed changes nothing");
  assert.deepEqual(parse({ colorScheme: "dark", reducedMotion: true }).changes, { colorScheme: "dark", reducedMotion: true });
  assert.deepEqual(parse({ colorScheme: "none" }).changes, { colorScheme: null });
  assert.throws(() => parse({ colorScheme: "sepia" }), /colorScheme must be light, dark or none/);
  assert.deepEqual(parse({ network: "Slow3G" }).changes.network, { preset: "slow3g", offline: false, latency: 2000, download: 400, upload: 400 });
  assert.deepEqual(parse({ network: "fast-3g" }).changes.network.preset, "fast3g");
  assert.equal(parse({ network: "offline" }).changes.network.offline, true);
  assert.equal(parse({ network: "none" }).changes.network, null);
  assert.deepEqual(parse({ network: "300/1600/750" }).changes.network, { preset: "custom", offline: false, latency: 300, download: 1600, upload: 750 });
  assert.deepEqual(parse({ network: { latency: 50, download: 1000 } }).changes.network, { preset: "custom", offline: false, latency: 50, download: 1000, upload: -1 });
  assert.throws(() => parse({ network: "dialup" }), /Unknown network "dialup".*slow3g/);
  assert.equal(parse({ cpu: 4 }).changes.cpu, 4);
  assert.equal(parse({ cpu: 1 }).changes.cpu, null, "a factor of 1 is off");
  assert.throws(() => parse({ cpu: 0.5 }), /cpu must be a number from 1 to 20/);
  const phone = parse({ device: "Phone" }).changes;
  assert.deepEqual(
    { device: phone.device, viewport: phone.viewport, dpr: phone.deviceScaleFactor, mobile: phone.mobile, touch: phone.touch },
    { device: "phone", viewport: { width: 390, height: 844 }, dpr: 3, mobile: true, touch: true },
  );
  assert.match(phone.userAgent, /iPhone/);
  assert.throws(() => parse({ device: "nokia" }), /Unknown device "nokia". Use one of phone, tablet, desktop/);
  assert.deepEqual(parse({ device: "none" }).changes, { device: null, viewport: null, deviceScaleFactor: null, mobile: null, touch: null, userAgent: null });
  assert.deepEqual(parse({ device: "phone", deviceScaleFactor: 2 }).changes.deviceScaleFactor, 2, "single fields refine a device in the same call");
  assert.throws(() => parse({ width: 300 }), /width and height together/);
  assert.throws(() => parse({ deviceScaleFactor: 9 }), /deviceScaleFactor must be a number from 0.25 to 5/);
  assert.throws(() => parse({ touch: "yes" }), /touch must be true or false/);
  assert.equal(parse({ reset: true }).reset, true);

  // A 3x2 view capture fitted to a 2x3 viewport: the top-left corner stays,
  // the unpainted row past the view's bottom edge is white.
  const pixel = (n) => [n, n, n, 255];
  const view = Buffer.from([1, 2, 3, 4, 5, 6].flatMap(pixel));
  assert.deepEqual([...lib.fitBitmap(view, { width: 3, height: 2 }, { width: 2, height: 3 })], [1, 2, 4, 5, 255, 255].flatMap(pixel));
}

async function emulationBookkeeping(lib) {
  const session = fakeSession();
  const target = { session };
  let state = await lib.applyEmulation(target, { colorScheme: "dark" });
  assert.deepEqual(session.sent.map(([method]) => method), ["Emulation.setEmulatedMedia"], "only the changed group is sent");
  assert.deepEqual(session.sent[0][1].features, [
    { name: "prefers-color-scheme", value: "dark" },
    { name: "prefers-reduced-motion", value: "" },
  ]);
  session.sent.length = 0;
  state = await lib.applyEmulation(target, lib.normalizeEmulationRequest({ network: "slow3g", cpu: 4 }).changes);
  assert.equal(state.colorScheme, "dark", "a partial call keeps what it does not name");
  assert.deepEqual(session.sent, [
    ["Network.emulateNetworkConditions", { offline: false, latency: 2000, downloadThroughput: 50000, uploadThroughput: 50000 }],
    ["Emulation.setCPUThrottlingRate", { rate: 4 }],
  ]);
  session.sent.length = 0;
  state = await lib.applyEmulation(target, lib.normalizeEmulationRequest({ device: "pixel-8" }).changes);
  assert.equal(state.device, "pixel-8");
  assert.deepEqual(session.sent.map(([method]) => method), [
    "Emulation.setDeviceMetricsOverride",
    "Emulation.setTouchEmulationEnabled",
    "Emulation.setEmitTouchEventsForMouse",
    "Emulation.setUserAgentOverride",
  ]);
  assert.deepEqual(session.sent[0][1], { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });

  // A resized or re-shown guest loses its device metrics; they come back.
  assert.ok(session.held.includes("Page"), "frame resizes are watched");
  session.sent.length = 0;
  session.pageMetrics = [412, 2.625];
  session.emit("Page.frameResized");
  await tick(250);
  assert.equal(session.sent.length, 0, "metrics that still hold are not sent again");
  session.pageMetrics = [2560, 1];
  session.emit("Page.frameResized");
  session.emit("Page.frameResized");
  await tick(250);
  assert.deepEqual(session.sent, [["Emulation.clearDeviceMetricsOverride", undefined], ["Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true }]], "lost metrics are restored once per burst of resizes");

  // An emulated viewport is captured over the protocol while the tab shows.
  session.sent.length = 0;
  assert.deepEqual(lib.emulatedViewport(session), { width: 412, height: 915 });
  assert.equal(String(await lib.captureEmulatedViewport(session)), "png");
  assert.deepEqual(session.sent.map(([method]) => method), ["Page.captureScreenshot"]);
  session.visibility = "hidden";
  assert.equal(await lib.captureEmulatedViewport(session), null, "a hidden tab paints no protocol frame");
  session.visibility = "visible";
  assert.equal(await lib.captureEmulatedViewport(fakeSession()), null, "nothing emulated, nothing captured here");
  session.sent.length = 0;

  state = await lib.applyEmulation(target, { deviceScaleFactor: 1 });
  assert.equal(state.device, null, "a device name goes once one of its fields is overridden");
  assert.deepEqual(lib.describeEmulation(state).network, "slow3g");
  assert.deepEqual(Object.keys(lib.describeEmulation(state)).sort(), ["colorScheme", "cpu", "deviceScaleFactor", "mobile", "network", "touch", "userAgent", "viewport"]);

  // Overrides last as long as the protocol client: they come back after a re-attach.
  session.sent.length = 0;
  session.drop();
  await tick(150);
  assert.equal(session.sent.length, 0, "nothing is sent while detached; the session decides when to attach");
  session.attached = true;
  await until(() => session.sent.length >= 6, "emulation sent again after a re-attach", 2_000);
  assert.ok(session.sent.some(([method, params]) => method === "Emulation.setEmulatedMedia" && params.features[0].value === "dark"));

  session.sent.length = 0;
  state = await lib.applyEmulation(target, {}, { reset: true });
  assert.deepEqual(lib.describeEmulation(state), {}, "reset clears everything");
  const methods = session.sent.map(([method]) => method);
  for (const method of [
    "Emulation.setEmulatedMedia",
    "Network.emulateNetworkConditions",
    "Emulation.setCPUThrottlingRate",
    "Emulation.clearDeviceMetricsOverride",
    "Emulation.setTouchEmulationEnabled",
    "Emulation.setUserAgentOverride",
  ]) assert.ok(methods.includes(method), `reset sends ${method}`);
  assert.deepEqual(session.sent.find(([method]) => method === "Network.emulateNetworkConditions")[1], { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  assert.deepEqual(session.sent.find(([method]) => method === "Emulation.setUserAgentOverride")[1], { userAgent: "" });
  assert.deepEqual(lib.currentEmulation(target), lib.emptyEmulation());
}

function fakeNetSession(lib) {
  const listeners = new Set();
  const transport = {
    attached: false,
    attach() { transport.attached = true; },
    isAttached: () => transport.attached,
    detach() { transport.attached = false; },
    async send() { return {}; },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onDetach() { return () => {}; },
  };
  const session = new lib.CdpSession("tab-net", transport);
  lib.startNetworkRecorder(session);
  const emit = (method, params) => { for (const listener of listeners) listener(method, params); };
  return { session, emit };
}

function networkLogic(lib) {
  const { session, emit } = fakeNetSession(lib);
  // Raw request headers can arrive before the request itself.
  emit("Network.requestWillBeSentExtraInfo", { requestId: "1", headers: { Cookie: "sid=abc", "User-Agent": "UA" } });
  emit("Network.requestWillBeSent", {
    requestId: "1",
    type: "Document",
    timestamp: 100,
    wallTime: 1_700_000_000,
    initiator: { type: "script", stack: { callFrames: [{ url: "http://x/app.js", lineNumber: 9 }] } },
    request: { url: "http://x/start", method: "GET", headers: { "User-Agent": "parsed" } },
  });
  emit("Network.responseReceivedExtraInfo", { requestId: "1", headers: { Location: "/final", "Set-Cookie": "hop=0" } });
  // The next hop's raw headers can come before the hop itself.
  emit("Network.requestWillBeSentExtraInfo", { requestId: "1", headers: { Cookie: "sid=abc; hop=0" } });
  emit("Network.requestWillBeSent", {
    requestId: "1",
    timestamp: 100.05,
    request: { url: "http://x/final", method: "GET", headers: {} },
    redirectResponse: { status: 302, statusText: "Found", headers: { Location: "/final" }, mimeType: "text/html" },
  });
  emit("Network.responseReceived", {
    requestId: "1",
    type: "Document",
    response: {
      status: 200, statusText: "OK", mimeType: "application/json", protocol: "http/1.1", remoteIPAddress: "127.0.0.1", remotePort: 80,
      headers: { "Content-Type": "application/json" },
      timing: { requestTime: 100.06, dnsStart: -1, dnsEnd: -1, connectStart: 1, connectEnd: 3, sslStart: -1, sslEnd: -1, sendStart: 4, sendEnd: 5, receiveHeadersEnd: 25 },
    },
  });
  emit("Network.responseReceivedExtraInfo", { requestId: "1", headers: { "Set-Cookie": "a=1\nb=2", "Content-Type": "application/json" } });
  emit("Network.loadingFinished", { requestId: "1", timestamp: 100.1, encodedDataLength: 321 });
  emit("Network.requestWillBeSent", { requestId: "2", type: "Fetch", timestamp: 101, request: { url: "http://x/api", method: "POST", headers: { Authorization: "Bearer t" }, postData: "{\"a\":1}", hasPostData: true } });
  // Raw headers can also come after everything else about the request.
  emit("Network.requestWillBeSentExtraInfo", { requestId: "2", headers: { Cookie: "sid=abc" } });
  emit("Network.loadingFailed", { requestId: "2", timestamp: 101.2, errorText: "net::ERR_CONNECTION_REFUSED", type: "Fetch" });
  emit("Network.requestWillBeSent", { requestId: "3", type: "Image", timestamp: 102, request: { url: "http://x/missing.png", method: "GET" } });
  emit("Network.responseReceived", { requestId: "3", response: { status: 404, mimeType: "text/plain", headers: {} } });
  emit("Network.requestWillBeSentExtraInfo", { requestId: "3", headers: { Cookie: "sid=abc" } });

  const rows = lib.networkRing(session).toArray();
  assert.deepEqual(rows.map((row) => [row.id, row.url, row.status]), [
    ["1", "http://x/start", 302],
    ["1~1", "http://x/final", 200],
    ["2", "http://x/api", null],
    ["3", "http://x/missing.png", 404],
  ], "each redirect hop is its own row with its own id and status");
  const [hop, final, post, missing] = rows;
  assert.equal(hop.redirectedTo, "http://x/final");
  assert.equal(hop.requestHeaders.Cookie, "sid=abc", "raw request headers that came first are merged");
  assert.equal(final.requestHeaders.Cookie, "sid=abc; hop=0", "a hop's raw headers that came before it are its own");
  assert.equal(hop.responseHeaders["Set-Cookie"], "hop=0", "each hop keeps its own raw response headers");
  assert.equal(post.requestHeaders.Cookie, "sid=abc", "raw request headers that came late are merged");
  assert.equal(missing.requestHeaders.Cookie, "sid=abc", "raw request headers that came after the response are merged");
  assert.equal(hop.requestHeaders["User-Agent"], "UA", "raw headers win over parsed ones");
  assert.deepEqual(hop.initiator, { type: "script", url: "http://x/app.js", line: 10 });
  assert.equal(hop.at, new Date(1_700_000_000_000).toISOString());
  assert.equal(final.responseHeaders["Set-Cookie"], "a=1\nb=2", "raw response headers are merged");
  assert.equal(final.encodedBytes, 321);
  assert.equal(final.remoteAddress, "127.0.0.1:80");
  assert.ok(lib.isFinalHop(session, final) && !lib.isFinalHop(session, hop));
  assert.equal(post.failed, true);
  assert.equal(post.errorText, "net::ERR_CONNECTION_REFUSED");
  assert.equal(post.postData, "{\"a\":1}");
  assert.equal(lib.findNetworkEntry(session, "1~1"), final);
  assert.equal(lib.findNetworkEntry(session, "1"), hop, "a row id finds its own row");
  assert.equal(lib.findNetworkEntry(session, 1), hop, "an id a command line read as a number still matches");

  const pick = (params) => rows.filter((row) => lib.matchesNetworkFilter(row, lib.parseNetworkFilter(params))).map((row) => row.id);
  assert.deepEqual(pick({ failed: true }), ["2", "3"], "failed keeps network errors and HTTP errors");
  assert.deepEqual(pick({ status: "3xx" }), ["1"]);
  assert.deepEqual(pick({ status: ">=300" }), ["1", "3"]);
  assert.deepEqual(pick({ status: 404 }), ["3"]);
  assert.deepEqual(pick({ status: "200-299" }), ["1~1"]);
  assert.deepEqual(pick({ type: "fetch,image" }), ["2", "3"]);
  assert.deepEqual(pick({ filter: "final" }), ["1~1"]);
  assert.throws(() => lib.parseStatusFilter("teapot"), /status must be a code/);

  assert.deepEqual(lib.networkRow(final), { id: "1~1", method: "GET", status: 200, type: "Document", url: "http://x/final", ms: 50, bytes: 321 });
  assert.deepEqual(lib.networkRow(post), { id: "2", method: "POST", type: "Fetch", url: "http://x/api", ms: 200, error: "net::ERR_CONNECTION_REFUSED" });
  assert.deepEqual(lib.networkRow(missing), { id: "3", method: "GET", status: 404, type: "Image", url: "http://x/missing.png", pending: true });

  const timings = lib.harTimings(final);
  assert.deepEqual(timings, { blocked: 11, dns: -1, connect: 2, ssl: -1, send: 1, wait: 20, receive: 15 }, "HAR phases from the resource timing");
  lib.clearNetwork(session);
  assert.equal(lib.networkRing(session).size, 0);
  assert.equal(lib.findNetworkEntry(session, "1"), null);
  session.dispose();
  return rows;
}

function navigationAbandons(lib) {
  const { session, emit } = fakeNetSession(lib);
  const request = (requestId, loaderId, type, url, frameId = "main") =>
    emit("Network.requestWillBeSent", { requestId, loaderId, frameId, type, timestamp: 1, request: { url, method: "GET", headers: {} } });
  request("L1", "L1", "Document", "http://x/");
  emit("Network.responseReceived", { requestId: "L1", type: "Document", response: { status: 200, headers: {} } });
  emit("Network.loadingFinished", { requestId: "L1", timestamp: 2 });
  request("a", "L1", "Fetch", "http://x/slow");
  request("b", "L1", "Fetch", "http://x/late");
  request("c", "F1", "Fetch", "http://x/frame", "child");
  // The page navigates while its fetches are in flight.
  request("L2", "L2", "Document", "http://x/next");
  const pendingBefore = lib.networkRing(session).toArray().filter((row) => !row.finished).map((row) => row.id);
  assert.deepEqual(pendingBefore, ["a", "b", "c", "L2"], "nothing is abandoned before the new document answers");
  emit("Network.responseReceived", { requestId: "L2", type: "Document", response: { status: 200, headers: {} } });
  const row = (id) => lib.findNetworkEntry(session, id);
  assert.equal(row("a").errorText, lib.ABANDONED_BY_NAVIGATION, "the old document's unfinished fetch ends with it");
  assert.deepEqual(lib.networkRow(row("a")).error, lib.ABANDONED_BY_NAVIGATION);
  assert.equal(row("c").finished, false, "another frame's request is not touched");
  assert.equal(row("L2").failed, false, "the new document's own request is not touched");
  // A fetch the old document still completed is reported as finished after all.
  emit("Network.loadingFinished", { requestId: "b", timestamp: 3, encodedDataLength: 10 });
  assert.equal(row("b").failed, false);
  assert.equal(row("b").errorText, null);
  assert.deepEqual(
    lib.networkRing(session).toArray().filter((entry) => lib.isFailedRequest(entry)).map((entry) => entry.id),
    ["a"],
  );
  session.dispose();
}

async function harLogic(lib, rows) {
  const har = await lib.buildHar(rows, {
    pageUrl: "http://x/start",
    pageTitle: "Fixture",
    redact: true,
    body: async (row) => (row.id === "1~1" ? { text: "{\"ok\":true}", base64: null, bytes: 11 } : null),
  });
  assert.equal(har.log.version, "1.2");
  assert.equal(har.log.entries.length, 4);
  const [hop, final, post] = har.log.entries;
  assert.equal(hop.response.status, 302);
  assert.equal(hop.response.redirectURL, "http://x/final");
  assert.equal(final.response.content.text, "{\"ok\":true}");
  assert.equal(final.response.content.mimeType, "application/json");
  assert.equal(final.time, 49, "total time is the sum of the phases, ssl being part of connect");
  assert.deepEqual(final.response.cookies, [{ name: "a", value: "[redacted]" }, { name: "b", value: "[redacted]" }]);
  assert.equal(final.response.headers.find((header) => header.name === "Set-Cookie").value, "[redacted]");
  assert.equal(hop.request.headers.find((header) => header.name === "Cookie").value, "[redacted]");
  assert.deepEqual(hop.request.cookies, [{ name: "sid", value: "[redacted]" }]);
  assert.equal(post.request.headers.find((header) => header.name === "Authorization").value, "[redacted]");
  assert.deepEqual(post.request.postData, { mimeType: "application/octet-stream", text: "{\"a\":1}" });
  assert.equal(post._error, "net::ERR_CONNECTION_REFUSED");
  assert.equal(final.serverIPAddress, "127.0.0.1");
  assert.equal(final.request.httpVersion, "HTTP/1.1");
  assert.ok(!JSON.stringify(har).includes("sid=abc") && !JSON.stringify(har).includes("Bearer t"), "no credential survives redaction");
  const open = await lib.buildHar(rows, { pageUrl: null, pageTitle: null, redact: false, body: null });
  assert.equal(open.log.entries[2].request.headers.find((header) => header.name === "Authorization").value, "Bearer t", "redact=false keeps credentials");
  assert.equal(open.log.entries[1].response.content.text, undefined, "no body reader, no bodies");
}

function storageLogic(lib) {
  assert.equal(lib.parseStorageArea(undefined), null);
  assert.equal(lib.parseStorageArea("localStorage"), "local");
  assert.equal(lib.parseStorageArea("Cookies"), "cookies");
  assert.equal(lib.parseStorageArea("IndexedDB"), "indexeddb");
  assert.throws(() => lib.parseStorageArea("disk"), /area must be one of cookies, local, session, indexeddb, cache/);
}

async function storageOnUserBrowser(lib) {
  const target = {
    kind: "chrome",
    ref: "chrome:7",
    workspaceId: "ws",
    session: { async send() { throw new Error("must not reach the browser"); } },
    async info() { return { url: "https://mail.example/", title: "Mail" }; },
    async evaluate() { return { removed: 2 }; },
  };
  await assert.rejects(lib.setStorageItem(target, { area: "cookies", name: "a", value: "b" }), /does not change cookies in your own browser/);
  await assert.rejects(lib.clearStorage(target, { area: null }), /does not clear cookies, IndexedDB or caches in your own browser/);
  await assert.rejects(lib.clearStorage(target, { area: "indexeddb" }), /own browser/);
  const local = await lib.clearStorage(target, { area: "local" });
  assert.deepEqual(local.removed, { localStorage: 2 }, "the page's own local storage may be cleared on a shared tab");

  // Page storage goes through script in the page, which the extension cannot
  // gate, so the tab's storage permission is checked here: without it the
  // page's storage is neither read in full nor changed.
  let allowed = false;
  const unshared = {
    ...target,
    storageAllowed: () => allowed,
    async evaluate() {
      throw new Error("must not reach the page");
    },
  };
  for (const [label, call] of [
    ["get redact=false", () => lib.readStorage(unshared, { area: "local", redact: false })],
    ["set local", () => lib.setStorageItem(unshared, { area: "local", name: "a", value: "b" })],
    ["set session", () => lib.setStorageItem(unshared, { area: "session", name: "a", value: "b" })],
    ["clear local", () => lib.clearStorage(unshared, { area: "local" })],
    ["remove one", () => lib.clearStorage(unshared, { area: "session", name: "a" })],
  ]) {
    await assert.rejects(call(), /chrome:7 need the user's permission/, label);
  }
  allowed = true;
  const permitted = { ...unshared, async evaluate() { return { removed: 1 }; } };
  assert.deepEqual((await lib.clearStorage(permitted, { area: "local" })).removed, { localStorage: 1 }, "allowed once the user turns it on");

  // redact=false never hands out the live sign-ins of the user's own browser.
  const reader = {
    ...target,
    session: {
      async send(method) {
        assert.equal(method, "Network.getCookies");
        return { cookies: [
          { name: "SID", value: "live-session", domain: "mail.example", path: "/", expires: -1, httpOnly: true, secure: true },
          { name: "theme", value: "dark", domain: "mail.example", path: "/", expires: -1, httpOnly: false, secure: false },
        ] };
      },
    },
  };
  const cookies = await lib.readStorage(reader, { area: "cookies", redact: false });
  assert.deepEqual(cookies.cookies.map((cookie) => [cookie.name, cookie.value]), [["SID", "[redacted] (12 chars)"], ["theme", "dark"]]);
  assert.match(cookies.note, /HttpOnly/);
  const { session, emit } = fakeNetSession(lib);
  emit("Network.requestWillBeSent", { requestId: "9", type: "Fetch", timestamp: 1, request: { url: "https://mail.example/api", method: "GET", headers: { Authorization: "Bearer live", Cookie: "SID=live-session" } } });
  const shared = { ...target, session };
  const detail = await lib.networkTool(shared, { id: "9", redact: false, body: false });
  assert.equal(detail.request.requestHeaders.Authorization, "[redacted]");
  assert.equal(detail.request.requestHeaders.Cookie, "[redacted]");
  const own = await lib.networkTool({ ...shared, kind: "preview" }, { id: "9", redact: false, body: false });
  assert.equal(own.request.requestHeaders.Authorization, "Bearer live", "a Codara tab's own requests may be read in full");
  session.dispose();
}

function targetFor(lib, session, ref = "tab-1") {
  const target = {
    kind: "preview",
    ref,
    session,
    workspaceId: "ws-devtools",
    async info() {
      const page = await lib.evaluateOverCdp(session, "({ url: location.href, title: document.title, width: innerWidth, height: innerHeight, dpr: devicePixelRatio })");
      return { ref, kind: "preview", url: page.url, title: page.title, viewport: { width: page.width, height: page.height }, devicePixelRatio: page.dpr };
    },
    evaluate: (expression, options) => lib.evaluateOverCdp(session, expression, options),
    async captureViewport() { throw new Error("not used"); },
    async showActivity() {},
  };
  return target;
}

async function againstChromium(lib) {
  const chromium = await startCdpChromium();
  if (!chromium) {
    console.log("SKIP real Chromium checks: no Chromium installed (npx playwright install chromium)");
    return;
  }
  const site = await startDevtoolsSite();
  const origin = site.origin;
  const sessions = [];
  try {
    const { targetId } = await chromium.newPage("about:blank");
    const session = new lib.CdpSession(`chrome:${targetId}`, chromium.transportFor(targetId), { reattachDelayMs: 20 });
    sessions.push(session);
    lib.startConsoleRecorder(session);
    lib.startNetworkRecorder(session);
    await session.enable("Page");
    const target = targetFor(lib, session);
    const load = async (url) => {
      const loaded = new Promise((resolve) => { const off = session.on("Page.loadEventFired", () => { off(); resolve(); }); });
      await session.send("Page.navigate", { url });
      await loaded;
    };
    await load(`${origin}/`);
    await target.evaluate("window.__done", { awaitPromise: true });
    await until(() => {
      const rows = lib.networkRing(session).toArray();
      return rows.length >= 7 && rows.filter((row) => row.url.startsWith(origin) || row.failed).every((row) => row.finished);
    }, "every fixture request to finish");

    // List, filters and compact rows.
    const list = await lib.networkTool(target, {});
    const byPath = (part) => list.requests.find((row) => row.url.includes(part));
    assert.equal(byPath(`${origin}/`).status, 200);
    assert.equal(byPath("/api/data.json").type, "Fetch");
    assert.equal(byPath("/api/missing").status, 404);
    assert.equal(byPath("/redirect").status, 302);
    assert.equal(byPath("/redirect").redirectedTo, `${origin}/api/data.json?via=redirect`);
    assert.equal(byPath("/pixel.png").type, "Image");
    assert.match(byPath("/unreachable").error, /ERR_/);
    assert.ok(list.requests.every((row) => !("requestHeaders" in row)), "the list stays compact");
    const failed = await lib.networkTool(target, { failed: true });
    assert.deepEqual(failed.requests.map((row) => new URL(row.url).pathname).sort(), ["/api/missing", "/unreachable"]);
    assert.deepEqual((await lib.networkTool(target, { status: "3xx" })).requests.map((row) => new URL(row.url).pathname), ["/redirect"]);
    assert.ok((await lib.networkTool(target, { type: "image" })).requests.every((row) => row.type === "Image"));

    // One request in detail: headers (redacted), timings, body.
    const data = await lib.networkTool(target, { id: byPath("/api/data.json").id });
    assert.equal(data.request.mimeType, "application/json");
    assert.equal(data.request.requestHeaders.Cookie, "[redacted]", "the cookie the page sent is recorded and redacted");
    assert.ok(data.request.timings && data.request.timings.wait >= 0, "timings are broken down");
    assert.equal(data.request.initiator.type, "script");
    assert.equal(typeof data.request.body, "object", "a long body is cut");
    assert.ok(data.request.body.totalChars > 6000);
    assert.ok(fs.existsSync(data.request.body.path), "and saved whole to a file");
    assert.ok(data.request.body.path.startsWith(path.join(HOME, "workspace-data", "ws-devtools", "browser", "network")), "under Codara's workspace data, never the repository");
    assert.deepEqual(JSON.parse(fs.readFileSync(data.request.body.path, "utf8")).items, [1, 2, 3]);
    const echo = await lib.networkTool(target, { id: byPath("/api/echo").id, redact: false });
    assert.equal(echo.request.status, 201);
    assert.equal(echo.request.requestBody, "{\"hello\":\"world\"}");
    assert.equal(echo.request.requestHeaders.authorization, `Bearer ${BEARER}`, "redact=false shows credentials");
    assert.deepEqual(JSON.parse(echo.request.body), { received: "{\"hello\":\"world\"}" });
    // A detail read while the response is still arriving waits for its body.
    await target.evaluate(`void fetch("${origin}/api/late")`);
    const late = await until(() => lib.networkRing(session).toArray().find((row) => row.url.endsWith("/api/late") && row.status !== null && !row.finished), "the late response's status");
    const lateDetail = await lib.networkTool(target, { id: late.id });
    assert.equal(lateDetail.request.body, "{\"error\":\"late boom\"}");
    const pixel = await lib.networkTool(target, { id: byPath("/pixel.png").id });
    assert.equal(pixel.request.body.binary, "image/png");
    assert.equal(pixel.request.body.bytes, PIXEL_BYTES);
    assert.ok(pixel.request.body.path.endsWith(".png") && fs.statSync(pixel.request.body.path).size === PIXEL_BYTES, "a binary body is summarized and saved as a file");
    const page = await lib.networkTool(target, { id: byPath(`${origin}/`).id, body: false });
    assert.equal(page.request.responseHeaders["Set-Cookie"] ?? page.request.responseHeaders["set-cookie"], "[redacted]");
    assert.equal(page.request.body, undefined);
    const redirect = await lib.networkTool(target, { id: byPath("/redirect").id });
    assert.deepEqual(redirect.request.body, { unavailable: "a redirect has no body" });
    await assert.rejects(lib.networkTool(target, { id: "nope" }), /No recorded request has id nope/);

    // HAR export.
    const harResult = await lib.networkTool(target, { har: true });
    assert.ok(harResult.har.endsWith(".har") && fs.existsSync(harResult.har));
    const har = JSON.parse(fs.readFileSync(harResult.har, "utf8"));
    assert.equal(har.log.version, "1.2");
    assert.equal(har.log.entries.length, (await lib.networkTool(target, {})).matching);
    assert.ok(harResult.bodies >= 3, "text bodies are included");
    const harText = fs.readFileSync(harResult.har, "utf8");
    for (const secret of [SESSION_COOKIE, BEARER]) { const at = harText.indexOf(secret); assert.equal(at, -1, `the HAR carries no cookie or token by default: ${harText.slice(Math.max(0, at - 300), at + 50)}`); }
    const echoEntry = har.log.entries.find((entry) => entry.request.url.endsWith("/api/echo"));
    assert.equal(echoEntry.request.method, "POST");
    assert.equal(echoEntry.request.postData.text, "{\"hello\":\"world\"}");
    assert.ok(echoEntry.time > 0 && Object.values(echoEntry.timings).every((value) => typeof value === "number"));
    const openHar = await lib.networkTool(target, { har: true, redact: false, filter: "/api/echo" });
    assert.equal(openHar.entries, 1, "filters apply to the export");
    assert.ok(fs.readFileSync(openHar.har, "utf8").includes(BEARER));

    // Emulation in a real page.
    const media = () => target.evaluate("({ dark: matchMedia('(prefers-color-scheme: dark)').matches, light: matchMedia('(prefers-color-scheme: light)').matches, reduce: matchMedia('(prefers-reduced-motion: reduce)').matches })");
    await lib.applyEmulation(target, { colorScheme: "dark", reducedMotion: true });
    assert.deepEqual(await media(), { dark: true, light: false, reduce: true });
    await lib.applyEmulation(target, { colorScheme: "light" });
    assert.deepEqual(await media(), { dark: false, light: true, reduce: true });
    await lib.applyEmulation(target, lib.normalizeEmulationRequest({ device: "phone" }).changes);
    await load(`${origin}/ua`);
    const phone = await target.evaluate("({ width: innerWidth, dpr: devicePixelRatio, touch: navigator.maxTouchPoints, coarse: matchMedia('(pointer: coarse)').matches, ua: navigator.userAgent, sent: document.body.innerText })");
    assert.equal(phone.width, 390);
    assert.equal(phone.dpr, 3);
    assert.ok(phone.touch > 0, "touch is emulated");
    assert.match(phone.ua, /iPhone/);
    assert.match(phone.sent, /iPhone/, "the server sees the mobile user agent");
    assert.deepEqual(await media(), { dark: false, light: true, reduce: true }, "media emulation survives a navigation");
    await lib.applyEmulation(target, lib.normalizeEmulationRequest({ network: "offline" }).changes);
    const offline = await target.evaluate(`fetch("${origin}/ua?offline").then(() => "loaded", (error) => "failed")`, { awaitPromise: true });
    assert.equal(offline, "failed", "offline blocks requests");
    await lib.applyEmulation(target, lib.normalizeEmulationRequest({ network: "400/100000/100000" }).changes);
    const slow = await target.evaluate(`(async () => { const t = performance.now(); await fetch("${origin}/ua?slow"); return performance.now() - t; })()`, { awaitPromise: true });
    assert.ok(slow >= 380, `added latency slows requests (${Math.round(slow)} ms)`);
    await lib.applyEmulation(target, { cpu: 4 });
    await lib.applyEmulation(target, {}, { reset: true });
    await load(`${origin}/ua`);
    const plain = await target.evaluate("({ width: innerWidth, dpr: devicePixelRatio, ua: navigator.userAgent, reduce: matchMedia('(prefers-reduced-motion: reduce)').matches })");
    assert.notEqual(plain.width, 390, "reset restores the viewport");
    assert.doesNotMatch(plain.ua, /iPhone/, "reset restores the user agent");
    assert.equal(plain.reduce, false);
    assert.equal(await target.evaluate(`fetch("${origin}/ua?online").then(() => "loaded", () => "failed")`, { awaitPromise: true }), "loaded");

    // Storage of the tab's origin.
    await load(`${origin}/`);
    await target.evaluate(`(async () => {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open("notes", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("items", { autoIncrement: true });
        request.onsuccess = () => { const db = request.result; const tx = db.transaction("items", "readwrite"); tx.objectStore("items").add({ a: 1 }); tx.objectStore("items").add({ a: 2 }); tx.oncomplete = () => { window.__db = db; resolve(); }; };
        request.onerror = () => reject(request.error);
      });
      const cache = await caches.open("assets-v1");
      await cache.put("/a.css", new Response("body{}"));
    })()`, { awaitPromise: true });
    await lib.setStorageItem(target, { area: "cookies", name: "theme", value: "dark" });
    await lib.setStorageItem(target, { area: "local", name: "draft", value: "hello" });
    await lib.setStorageItem(target, { area: "local", name: "authToken", value: "eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl" });
    await lib.setStorageItem(target, { area: "session", name: "step", value: "2" });
    await assert.rejects(lib.setStorageItem(target, { area: "indexeddb", name: "x", value: "y" }), /set needs area cookies, local or session/);
    const read = await lib.readStorage(target, { area: null, redact: true });
    assert.equal(read.origin, origin);
    const cookieNames = read.cookies.map((cookie) => cookie.name).sort();
    assert.deepEqual(cookieNames, ["sid", "theme"]);
    const sid = read.cookies.find((cookie) => cookie.name === "sid");
    assert.equal(sid.httpOnly, true, "HttpOnly cookies are listed too");
    assert.match(sid.value, /^\[redacted\]/);
    assert.equal(read.localStorage.items.draft, "hello");
    assert.match(read.localStorage.items.authToken, /^\[redacted\]/, "credential-like stored values are redacted");
    assert.deepEqual(read.sessionStorage, { count: 1, items: { step: "2" } });
    assert.deepEqual(read.indexedDB, [{ name: "notes", version: 1, stores: [{ name: "items", count: 2 }] }]);
    assert.equal(read.cacheStorage[0].name, "assets-v1");
    assert.equal(read.cacheStorage[0].entries, 1);
    const open = await lib.readStorage(target, { area: "cookies", redact: false });
    assert.equal(open.cookies.find((cookie) => cookie.name === "sid").value, SESSION_COOKIE);
    assert.equal(open.localStorage, undefined, "one area reads only that area");

    const one = await lib.clearStorage(target, { area: "local", name: "draft" });
    assert.deepEqual(one.removed, { localStorage: 1 });
    const cleared = await lib.clearStorage(target, { area: null });
    assert.deepEqual(cleared.removed, { cookies: 2, localStorage: 1, sessionStorage: 1, indexedDB: 1, cacheStorage: 1 });
    const empty = await lib.readStorage(target, { area: null, redact: true });
    assert.deepEqual(empty.cookies, []);
    assert.equal(empty.localStorage.count, 0);
    assert.equal(empty.sessionStorage.count, 0);
    assert.deepEqual(empty.indexedDB, [], "an open IndexedDB connection does not block the clear");
    assert.deepEqual(empty.cacheStorage, []);
  } finally {
    for (const session of sessions) session.dispose();
    await site.close();
    await chromium.close();
  }
}

(async () => {
  const lib = await loadModules();
  try {
    emulationLogic(lib);
    await emulationBookkeeping(lib);
    const rows = networkLogic(lib);
    await harLogic(lib, rows);
    navigationAbandons(lib);
    storageLogic(lib);
    await storageOnUserBrowser(lib);
    await againstChromium(lib);
  } finally {
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log("browser devtools: emulation, network detail, HAR and storage ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
