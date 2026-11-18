"use strict";
// Codara's side of the Firefox extension link (src/main/browser/chrome/):
// a moz-extension:// origin may connect and pair, the pairing binds to that
// profile's extension uuid, and the protocol commands the extension's hello
// lists are the only ones relayed; any other is refused with the reason
// before it is sent. The extension's real link client (shared with Chrome,
// extensions/chrome/lib/link-client.js) speaks to the real server here; the
// extension in a real Firefox is covered by tests/e2e/firefox-extension.spec.ts.
//
//   node scripts/test-firefox-link.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const { pathToFileURL } = require("node:url");
const { WebSocket } = require("ws");
const { unusedPort } = require("./unused-port.cjs");

const ROOT = path.resolve(__dirname, "..");
const UUID = "0d0d0d0d-1111-4222-8333-444444444444";
const OTHER_UUID = "9e9e9e9e-5555-4666-8777-888888888888";

async function load() {
  const out = await esbuild.build({
    stdin: {
      contents: [
        `export * from "./link-server";`,
        `export * from "./link-store";`,
        `export * from "./chrome-target";`,
        `export * from "./protocol";`,
        `export { registerBrowserBackend, resolveBrowserTarget } from "../targets";`,
      ].join("\n"),
      resolveDir: path.join(ROOT, "src/main/browser/chrome"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["electron", "ws"],
    alias: { "@shared": path.join(ROOT, "src/shared") },
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** The WebSocket a Firefox extension page opens: its Origin is moz-extension://<uuid>. */
function socketFrom(origin) {
  return class extends WebSocket {
    constructor(url) {
      super(url, { origin });
    }
  };
}

/** The upgrade's HTTP status for an origin, or 101 when it was accepted. */
function upgradeStatus(port, origin) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/codara-chrome`, { origin });
    socket.on("open", () => {
      socket.close();
      resolve(101);
    });
    socket.on("unexpected-response", (_req, res) => resolve(res.statusCode));
    socket.on("error", () => resolve(0));
  });
}

/** The extension's real link client, as the Firefox event page builds it. */
function firefoxClient(LinkClient, port, { uuid = UUID, capabilities = { cdp: ["Runtime.enable", "Runtime.disable", "Network.enable", "Network.disable", "Page.enable", "Page.disable", "Log.enable", "Log.disable"] }, browser = { name: "Firefox", version: "158.0" } } = {}) {
  let pairing = null;
  const requests = [];
  const client = new LinkClient({
    WebSocket: socketFrom(`moz-extension://${uuid}`),
    ports: async () => [port],
    hello: async () => ({ browser, extension: { id: "@codara-firefox", version: "0.1.0", features: [], ...(capabilities ? { capabilities } : {}) } }),
    loadPairing: async () => pairing,
    savePairing: async (token, linkId) => {
      pairing = { token, linkId };
    },
    clearPairing: async () => {
      pairing = null;
    },
    onRequest: async (request) => {
      requests.push(request);
      return request.type === "cdp" && request.method === "Runtime.evaluate" ? { result: { value: 42 } } : {};
    },
  });
  return { client, requests, pairing: () => pairing, setPairing: (next) => (pairing = next) };
}

(async () => {
  const lib = await load();
  const { LinkClient } = await import(pathToFileURL(path.join(ROOT, "extensions/chrome/lib/link-client.js")).href);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codara-firefox-link-"));
  const store = new lib.ChromeLinkStore(path.join(home, "chrome-link", "links.json"));
  const port = await unusedPort();
  const server = new lib.ChromeLinkServer({ store, app: { name: "Codara", version: "9.0.0" }, ports: [port], pairingTimeoutMs: 2000, helloTimeoutMs: 1000 });
  assert.equal(await server.start(), port);

  // Who may connect: a Firefox extension's origin, never anything shaped like one.
  assert.deepEqual(lib.extensionOrigin(`moz-extension://${UUID}`), { id: UUID, kind: "firefox" });
  assert.deepEqual(lib.extensionOrigin(`chrome-extension://${"a".repeat(32)}`), { id: "a".repeat(32), kind: "chromium" });
  for (const origin of [
    "moz-extension://not-a-uuid",
    `moz-extension://${UUID.toUpperCase()}`,
    `moz-extension://${UUID}/`,
    `moz-extension://${UUID}.evil.example`,
    `https://${UUID}`,
    "null",
  ]) {
    assert.equal(lib.extensionOrigin(origin), null, origin);
    assert.equal(await upgradeStatus(port, origin), 403, origin);
  }

  // Pairing, with the code both sides show and Allow in Codara.
  const firefox = firefoxClient(LinkClient, port);
  void firefox.client.connect({ pair: true });
  await until(() => firefox.client.status.state === "pairing", "the pairing code");
  const [pending] = await until(() => server.pendingPairings().length === 1 && server.pendingPairings(), "the pairing request");
  assert.equal(pending.code, firefox.client.status.code, "Codara shows the code the extension shows");
  assert.equal(pending.extensionId, UUID, "the pairing names the profile's extension uuid");
  assert.equal(pending.browser.name, "Firefox");
  server.approve(pending.id);
  await until(() => firefox.client.status.state === "connected", "connected after Allow");
  assert.equal(store.list()[0].extensionId, UUID, "the token is bound to that uuid");
  let link = await until(() => server.links()[0], "the link");
  assert.equal(link.extensionKind, "firefox");
  assert.equal(link.answers("Runtime.enable"), true);
  assert.equal(link.answers("Runtime.evaluate"), false, "only the commands the hello listed");

  // The protocol: listed commands are relayed, any other is refused with the
  // reason and never reaches the extension.
  const backend = new lib.ChromeTargetBackend(server);
  const unregister = lib.registerBrowserBackend(backend);
  firefox.client.send({ type: "tabs", allowOpen: false, tabs: [{ tabId: 5, windowId: 1, url: "https://mail.example/", title: "Mail", active: true, attached: false, blocked: false, storage: false, openedByAgent: false }] });
  await until(() => link.tabs.size === 1, "the tab list");
  assert.deepEqual((await backend.list()).map((tab) => [tab.id, tab.browser]), [["chrome:5", "Firefox"]]);
  const target = await lib.resolveBrowserTarget({ tabId: "chrome:5" });
  await assert.rejects(target.evaluate("6 * 7"), /Runtime\.evaluate is not available in Firefox/);
  await assert.rejects(target.session.send("Tracing.start", {}), /Tracing\.start is not available in Firefox/);
  await until(() => firefox.requests.some((request) => request.type === "cdp" && request.method === "Runtime.enable"), "the recorders' domains");
  assert.deepEqual(firefox.requests[0], { id: firefox.requests[0].id, type: "attach", tabId: 5 }, "the tab is attached on first use");
  assert.ok(!firefox.requests.some((request) => request.method === "Runtime.evaluate" || request.method === "Tracing.start"), "a refused command never reaches the extension");

  // A later connection proves the pairing both ways, from the same profile only.
  firefox.client.disconnect("idle");
  await until(() => server.links().length === 0, "the link dropped");
  void firefox.client.connect();
  await until(() => firefox.client.status.state === "connected", "connected again with its token");
  link = await until(() => server.links()[0], "the link again");
  assert.equal(link.extensionKind, "firefox");
  const elsewhere = firefoxClient(LinkClient, port, { uuid: OTHER_UUID });
  elsewhere.setPairing(firefox.pairing());
  await elsewhere.client.connect();
  assert.equal(elsewhere.client.status.state, "unpaired", "a token copied to another profile is not accepted");
  assert.equal(server.links().length, 1);

  // A Firefox extension that lists nothing gets nothing relayed; a Chromium
  // extension cannot narrow its own commands by listing them.
  firefox.client.disconnect("idle");
  await until(() => server.links().length === 0, "the link dropped again");
  const silent = firefoxClient(LinkClient, port, { uuid: OTHER_UUID, capabilities: null, browser: { name: "Firefox", version: "153.0" } });
  void silent.client.connect({ pair: true });
  server.approve((await until(() => server.pendingPairings()[0], "the second pairing")).id);
  await until(() => silent.client.status.state === "connected", "the second browser connected");
  const silentLink = await until(() => server.links()[0], "the second link");
  assert.equal(silentLink.answers("Runtime.enable"), false);
  silent.client.disconnect("idle");
  await until(() => server.links().length === 0, "the second link dropped");
  const chromium = new LinkClient({
    WebSocket: socketFrom(`chrome-extension://${"c".repeat(32)}`),
    ports: async () => [port],
    hello: async () => ({ browser: { name: "Google Chrome", version: "141.0" }, extension: { id: "c".repeat(32), version: "1.4.0", capabilities: { cdp: ["Runtime.enable"] } } }),
    loadPairing: async () => null,
    savePairing: async () => {},
    clearPairing: async () => {},
    onRequest: async () => ({}),
  });
  void chromium.connect({ pair: true });
  server.approve((await until(() => server.pendingPairings()[0], "the Chrome pairing")).id);
  const chromeLink = await until(() => server.links()[0], "the Chrome link");
  assert.equal(chromeLink.extensionKind, "chromium");
  assert.equal(chromeLink.answers("Tracing.start"), true, "a Chromium extension relays every command");
  chromium.disconnect("idle");

  unregister();
  await server.stop();
  fs.rmSync(home, { recursive: true, force: true });
  console.log("firefox link: moz-extension origins and nothing shaped like one, pairing bound to the profile's uuid, only the commands the hello lists relayed, the rest refused with the reason");
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
