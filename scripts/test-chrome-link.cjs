"use strict";
// The Chrome extension link in main (src/main/browser/chrome/): who may
// connect, pairing over ECDH with a code from both keys and Allow, tokens
// bound to one extension and proven both ways without crossing the socket,
// sealed frames after the handshake,
// shared and blocked tabs, the DevTools protocol relayed to a shared tab, the
// activity log with the agent's name, codara_preview_chrome, and unpairing.
// A fake extension speaks the wire protocol; the real one, in a real
// Chromium, is covered by tests/e2e/chrome-extension.spec.ts.
//
//   node scripts/test-chrome-link.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const { pathToFileURL } = require("node:url");
const { WebSocket } = require("ws");

const ROOT = path.resolve(__dirname, "..");
const EXT_A = "a".repeat(32);
const EXT_B = "b".repeat(32);

const extensionCrypto = import(pathToFileURL(path.join(ROOT, "extensions/chrome/lib/link-client.js")).href);

async function load() {
  const out = await esbuild.build({
    stdin: {
      contents: [
        `export * from "./link-server";`,
        `export * from "./link-store";`,
        `export * from "./chrome-target";`,
        `export * from "./activity";`,
        `export * from "./runtime";`,
        `export * from "./protocol";`,
        `export { chromeLinkTool } from "./link-tool";`,
        `export { registerBrowserBackend, resolveBrowserTarget } from "../targets";`,
        `export { consoleRing } from "../recorders/console";`,
        `export { navigate } from "./tab-ops";`,
        `export { chromeTargetTools } from "../../preview-tools/chrome";`,
        `export { pageActivity } from "../page-activity";`,
        `export { currentEmulation, resetEmulation } from "../emulation";`,
        `export { MARK_BASELINE_EXPRESSION } from "../wait";`,
      ].join("\n"),
      resolveDir: path.join(ROOT, "src/main/browser/chrome"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["electron", "ws"],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const host0 = () => ({ mayUseUserBrowser: async () => true });

async function until(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * A fake extension: records what Codara sends and answers requests with
 * `answer`. It speaks the sealed wire protocol with the extension's own
 * crypto (extensions/chrome/lib/link-client.js), so both ends are checked
 * against each other.
 */
function extension(port, { id = EXT_A, origin, host, path: urlPath = "/codara-chrome", answer } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`, {
    origin: origin === undefined ? `chrome-extension://${id}` : origin,
    headers: host ? { host } : {},
  });
  const ext = { socket, received: [], frames: [], closed: false, closeCode: null, status: null, sealer: null, token: null, failure: null };
  let inbox = Promise.resolve();
  let outbox = Promise.resolve();
  const receive = async (frame) => {
    const { pairedToken, sessionSealer, sha256Hex, sharedSecret } = await extensionCrypto;
    const message = ext.sealer ? await ext.sealer.open(frame) : frame;
    // The sealer is in place before anything waiting on this frame runs, so
    // whatever the test sends next leaves sealed.
    if (message.type === "paired" && ext.pairing) {
      const { privateKey, extensionKey, codaraKey } = ext.pairing;
      ext.token = await pairedToken(await sharedSecret(privateKey, codaraKey), extensionKey, codaraKey);
      ext.sealer = await sessionSealer(await sha256Hex(ext.token), extensionKey, codaraKey);
    }
    if (message.type === "welcome" && ext.session) {
      ext.sealer = await sessionSealer(ext.session.secret, ext.session.first, ext.session.second);
    }
    ext.received.push(message);
    if (message.id !== undefined && answer) {
      void (async () => {
        try {
          ext.send({ id: message.id, result: (await answer(message)) ?? {} });
        } catch (error) {
          ext.send({ id: message.id, error: { message: error.message } });
        }
      })();
    }
  };
  socket.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    ext.frames.push(frame);
    inbox = inbox.then(() => receive(frame)).catch((error) => {
      ext.failure = error;
      socket.close();
    });
  });
  socket.on("close", (code) => {
    ext.closed = true;
    ext.closeCode = code;
  });
  socket.on("unexpected-response", (_req, res) => {
    ext.status = res.statusCode;
    ext.closed = true;
  });
  socket.on("error", () => (ext.closed = true));
  ext.opened = new Promise((resolve) => {
    socket.on("open", () => resolve(true));
    socket.on("close", () => resolve(false));
    socket.on("unexpected-response", () => resolve(false));
  });
  ext.send = (message) => {
    const sealer = ext.sealer;
    outbox = outbox.then(async () => socket.send(sealer ? await sealer.seal(message) : JSON.stringify(message)));
    return outbox;
  };
  ext.raw = (text) => socket.send(text);
  ext.hello = (extra = {}) => ext.send({ type: "hello", protocol: 2, browser: { name: "Google Chrome", version: "141.0" }, extension: { id, version: "1.0.0" }, ...extra });
  ext.next = (type) => until(() => ext.received.find((message) => message.type === type), type);
  // The extension's side of pairing: commit to a key, reveal it after
  // Codara's, and show the code derived from both.
  ext.pair = async (extra = {}, { reveal } = {}) => {
    const { pairCommitment, pairKeys, pairingCode } = await extensionCrypto;
    const own = await pairKeys();
    ext.hello({ pair: true, pairCommit: await pairCommitment(own.key), ...extra });
    const offer = await ext.next("pairing");
    assert.match(offer.key, /^04[0-9a-f]{128}$/);
    assert.equal(offer.code, undefined, "Codara does not send a code; both sides derive it");
    const key = reveal ?? own.key;
    ext.pairing = { privateKey: own.privateKey, extensionKey: key, codaraKey: offer.key };
    ext.send({ type: "pair_key", key });
    return pairingCode(key, offer.key);
  };
  // The extension's side of the handshake, with the extension's own proof code.
  ext.login = async ({ token, linkId }, { lie = false } = {}) => {
    const { linkProof, sha256Hex } = await extensionCrypto;
    const nonce = "e".repeat(32);
    ext.hello({ linkId, nonce });
    const challenge = await ext.next("challenge");
    const secret = await sha256Hex(token);
    assert.equal(challenge.proof, await linkProof(secret, "codara", nonce, challenge.nonce), "Codara proves it holds the pairing");
    ext.session = { secret, first: nonce, second: challenge.nonce };
    ext.send({ type: "auth", proof: lie ? "0".repeat(64) : await linkProof(secret, "browser", challenge.nonce, nonce) });
  };
  return ext;
}

(async () => {
  const lib = await load();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codara-chrome-link-"));
  const storeFile = path.join(home, "chrome-link", "links.json");
  const activityFile = path.join(home, "chrome-link", "activity.jsonl");

  // Who may connect.
  const blocker = net.createServer();
  const busy = await new Promise((resolve) => blocker.listen(0, "127.0.0.1", () => resolve(blocker.address().port)));
  const port = await freePort();
  const store = new lib.ChromeLinkStore(storeFile);
  const server = new lib.ChromeLinkServer({ store, app: { name: "Codara", version: "9.0.0" }, ports: [busy, port], pairingTimeoutMs: 400, helloTimeoutMs: 300 });
  assert.equal(await server.start(), port, "a busy port is skipped");
  blocker.close();
  for (const [label, options, status] of [
    ["a web page", { origin: "https://evil.example" }, 403],
    ["no origin", { origin: "" }, 403],
    ["a rebound host name", { host: `evil.example:${port}` }, 403],
    ["another path", { path: "/other" }, 404],
  ]) {
    const ext = extension(port, options);
    assert.equal(await ext.opened, false, label);
    assert.equal(ext.status, status, label);
  }

  const silent = extension(port);
  await silent.opened;
  await until(() => silent.closed, "the hello timeout");

  const old = extension(port);
  await old.opened;
  old.hello({ protocol: 0 });
  assert.match((await old.next("error")).message, /update the Codara extension/);

  const stranger = extension(port);
  await stranger.opened;
  stranger.hello();
  await stranger.next("unpaired");
  await until(() => stranger.closed, "an unpaired hello closing");
  assert.equal(server.pendingPairings().length, 0, "only a Connect press asks the user");

  // Pairing: the code shows in both places; Deny and a timeout both refuse.
  const pairingRequests = [];
  server.onPairingRequest((pairing) => pairingRequests.push(pairing));
  const denied = extension(port);
  await denied.opened;
  const code = await denied.pair();
  assert.match(code, /^\d{3} \d{3}$/);
  await until(() => pairingRequests.length === 1, "the pairing request");
  assert.equal(pairingRequests[0].code, code, "Codara shows the code the extension shows");
  assert.equal(pairingRequests[0].browser.name, "Google Chrome");
  server.deny(server.pendingPairings()[0].id);
  assert.match((await denied.next("denied")).message, /declined/);

  const late = extension(port);
  await late.opened;
  await late.pair();
  assert.match((await late.next("denied")).message, /in time/, "nobody answered");

  // A relay that swaps in its own key cannot reveal one the browser committed
  // to, and a hello without a commitment is not a pairing request.
  const swapped = extension(port);
  await swapped.opened;
  const { pairKeys } = await extensionCrypto;
  await swapped.pair({}, { reveal: (await pairKeys()).key });
  assert.match((await swapped.next("denied")).message, /did not match/);
  const uncommitted = extension(port);
  await uncommitted.opened;
  uncommitted.hello({ pair: true });
  assert.match((await uncommitted.next("denied")).message, /incomplete/);
  assert.equal(server.pendingPairings().length, 0, "neither reached the user");

  const ups = [];
  const downs = [];
  server.onLinkUp((link) => ups.push(link.linkId));
  server.onLinkDown((link) => downs.push(link.linkId));
  const answers = [];
  const answer = async (message) => {
    answers.push(message);
    if (message.type === "cdp" && message.method === "Runtime.evaluate") {
      if (String(message.params.expression).includes("innerWidth")) return { result: { value: { url: "https://mail.example/", title: "Mail", width: 800, height: 600, dpr: 2 } } };
      return { result: { value: 42 } };
    }
    if (message.type === "open" && message.url.includes("redirects-to-bank")) return { tabId: 98, url: "", title: "", blocked: true };
    if (message.type === "open") return { tabId: 99, url: message.url, title: "Opened" };
    return {};
  };
  const chrome = extension(port, { answer });
  await chrome.opened;
  const chromeCode = await chrome.pair();
  await until(() => server.pendingPairings()[0]?.code === chromeCode, "the matching code in Codara");
  assert.equal(server.approve(server.pendingPairings()[0].id), true);
  const paired = await chrome.next("paired");
  assert.equal(paired.token, undefined, "the token never crosses the socket");
  const token = chrome.token;
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.match(paired.linkId, /^chrome-[0-9a-f]{4}$/);
  assert.deepEqual(ups, [paired.linkId]);
  const saved = fs.readFileSync(storeFile, "utf8");
  assert.ok(!saved.includes(token), "only a hash of the token is stored");
  assert.ok(saved.includes(lib.hashToken(token)), "Codara derived the same token");
  assert.equal((fs.statSync(storeFile).mode & 0o777).toString(8), "600");

  // The pairing works only for the extension it was issued to, and only with its secret.
  const thief = extension(port, { id: EXT_B });
  await thief.opened;
  thief.hello({ linkId: paired.linkId, nonce: "f".repeat(32) });
  await thief.next("unpaired");
  assert.ok(!thief.received.some((message) => message.type === "challenge"), "another extension gets no challenge");
  const guesser = extension(port);
  await guesser.opened;
  await assert.rejects(guesser.login({ token: "0".repeat(64), linkId: paired.linkId }), /proves it holds the pairing/, "a wrong secret cannot check Codara's proof");
  const liar = extension(port);
  await liar.opened;
  await liar.login({ token, linkId: paired.linkId }, { lie: true });
  await liar.next("unpaired");
  assert.ok(!liar.received.some((message) => message.type === "welcome"), "a wrong proof is refused");

  // Shared tabs and the backend.
  const backend = new lib.ChromeTargetBackend(server);
  const unregister = lib.registerBrowserBackend(backend);
  lib.setChromeLinkRuntime({ server, backend });
  chrome.send({
    type: "tabs",
    allowOpen: false,
    tabs: [
      { tabId: 12, windowId: 1, url: "https://mail.example/", title: "Mail", active: true, attached: false, blocked: false, storage: false, openedByAgent: false },
      { tabId: 13, windowId: 1, url: "", title: "", active: false, attached: false, blocked: true, storage: false, openedByAgent: false },
      { tabId: "bad" },
    ],
  });
  const link = await until(() => server.links()[0]?.tabs.size === 2 && server.links()[0], "the tab list");
  assert.deepEqual(await backend.list(), [
    { id: "chrome:12", kind: "chrome", title: "Mail", url: "https://mail.example/", isActive: true, browser: "Google Chrome", attached: false, storage: false, openedByAgent: false },
  ], "a blocked tab is never listed");
  await assert.rejects(lib.resolveBrowserTarget({ tabId: "chrome:14" }), /chrome:14 is not shared with agents/);
  await assert.rejects(lib.resolveBrowserTarget({ tabId: "chrome:13" }), /blocked for agents/);
  await assert.rejects(lib.resolveBrowserTarget({ tabId: "chrome:nope-1/12" }), /No connected browser has the id nope-1/);

  // The protocol, relayed: attach on first use, the recorders' domains, then commands and events.
  const target = await lib.resolveBrowserTarget({ tabId: "chrome:12", workspaceId: "ws-1" });
  assert.equal(target.kind, "chrome");
  assert.equal(target.ref, "chrome:12");
  assert.equal(target.workspaceId, "ws-1");
  assert.equal(target.storageAllowed(), false, "page storage follows the tab's storage permission");
  assert.equal(await target.evaluate("6 * 7"), 42);
  assert.deepEqual(answers[0], { id: answers[0].id, type: "attach", tabId: 12 }, "the tab is attached on first use");
  const enabled = answers.filter((m) => m.type === "cdp" && /\.enable$/.test(m.method)).map((m) => m.method);
  assert.ok(enabled.includes("Network.enable") && enabled.includes("Runtime.enable"), "console and network record from attach");
  const info = await target.info();
  assert.deepEqual(info, { ref: "chrome:12", kind: "chrome", url: "https://mail.example/", title: "Mail", viewport: { width: 800, height: 600 }, devicePixelRatio: 2 });
  chrome.send({ type: "cdp_event", tabId: 12, method: "Runtime.consoleAPICalled", params: { type: "warning", args: [{ type: "string", value: "careful" }] } });
  chrome.send({ type: "cdp_event", tabId: 77, method: "Runtime.consoleAPICalled", params: { type: "log", args: [{ type: "string", value: "other tab" }] } });
  await until(() => lib.consoleRing(target.session).size === 1, "the console entry");
  assert.equal(lib.consoleRing(target.session).toArray()[0].message, "careful");
  assert.equal((await lib.resolveBrowserTarget({ tabId: "chrome:12" })).session, target.session, "one session per tab");

  // An agent action on a Chrome tab is stamped first, as on a Codara tab, so
  // a fresh wait or one for the navigation a click started has its baseline.
  const tools = lib.chromeTargetTools;
  const sentFrom = (start) => answers.slice(start).filter((m) => m.type === "cdp").map((m) => m.method);
  const beforeAction = answers.length;
  await tools["preview.evaluate"]({ tabId: "chrome:12", code: "6 * 7" }, "preview.evaluate", host0());
  assert.ok(lib.pageActivity(target.session).lastActionAt > 0, "the action is stamped on the tab");
  const evaluated = answers.slice(beforeAction).filter((m) => m.method === "Runtime.evaluate");
  assert.equal(evaluated[0].params.expression, lib.MARK_BASELINE_EXPRESSION, "the baseline is taken before the action runs");

  // resize is the tab's emulated viewport: emulate reset clears it.
  const beforeResize = answers.length;
  assert.deepEqual(await tools["preview.resize"]({ tabId: "chrome:12", width: 500, height: 400 }, "preview.resize", host0()), { ok: true, width: 500, height: 400, tabId: "chrome:12", emulated: true });
  assert.deepEqual(lib.currentEmulation(target).viewport, { width: 500, height: 400 });
  await lib.resetEmulation(target);
  assert.deepEqual(sentFrom(beforeResize), ["Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride"], "reset takes the resize back");

  // Focus is emulated only while keys are sent.
  const beforeKey = answers.length;
  await tools["preview.press_key"]({ tabId: "chrome:12", key: "Enter" }, "preview.press_key", host0());
  const keyed = sentFrom(beforeKey).filter((method) => method.startsWith("Emulation.") || method.startsWith("Input."));
  assert.equal(keyed[0], "Emulation.setFocusEmulationEnabled");
  assert.equal(keyed.at(-1), "Emulation.setFocusEmulationEnabled");
  assert.ok(keyed.slice(1, -1).length > 0 && keyed.slice(1, -1).every((method) => method === "Input.dispatchKeyEvent"));
  const focusFlags = answers.slice(beforeKey).filter((m) => m.method === "Emulation.setFocusEmulationEnabled").map((m) => m.params.enabled);
  assert.deepEqual(focusFlags, [true, false], "the user's tab stops reporting focus once the keys are sent");

  // Activity: every call is logged with its agent, and the extension hears who used the tab.
  lib.setChromeActivityFile(activityFile);
  lib.setChromeAgentLabeler((params) => `Codex in pane ${params.callerPaneId}`);
  lib.setChromeUsageSink((entry, ref) => server.links()[0].send({ type: "usage", tabId: ref.tabId, agent: entry.agent, tool: entry.tool, at: Date.parse(entry.at) }));
  assert.equal(lib.noteChromeToolCall("preview.click", { tabId: "tab-3" }), null, "Codara tabs are not logged here");
  lib.noteChromeToolCall("preview.click", { tabId: "chrome:12", callerPaneId: "p1", workspaceId: "ws-1" });
  const usage = await chrome.next("usage");
  assert.deepEqual({ ...usage, at: 0 }, { type: "usage", tabId: 12, agent: "Codex in pane p1", tool: "codara_preview_click", at: 0 });
  await lib.flushChromeActivity();
  const logged = fs.readFileSync(activityFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual({ ...logged[0], at: 0 }, { at: 0, tool: "codara_preview_click", tab: "chrome:12", agent: "Codex in pane p1", workspaceId: "ws-1" });
  assert.equal(lib.recentChromeActivity()[0].tool, "codara_preview_click");
  lib.noteChromeToolCall("preview.navigate", { tabId: "chrome:12", url: "https://a.example/next" });
  assert.equal(lib.recentChromeActivity()[0].detail, "to https://a.example/next", "the log says where an agent took the tab");
  lib.noteChromeToolCall("preview.type", { tabId: "chrome:12", selector: "#pw", text: "hunter2" });
  assert.ok(!JSON.stringify(lib.recentChromeActivity()).includes("hunter2"), "typed text stays out of the log");

  // codara_preview_chrome.
  const host = { mayUseUserBrowser: async (params) => params.runId !== "untrusted" };
  await assert.rejects(lib.chromeLinkTool({ action: "status", runId: "untrusted" }, "preview.chrome", host), /may not use tabs of your own browser/);
  const status = await lib.chromeLinkTool({ action: "status" }, "preview.chrome", host);
  assert.equal(status.connected, true);
  assert.deepEqual(status.browsers, [{ linkId: paired.linkId, browser: "Google Chrome 141.0", sharedTabs: 1, mayOpenTabs: false }]);
  await assert.rejects(lib.chromeLinkTool({ action: "open", url: "https://a.example/" }, "preview.chrome", host), /has not let agents open tabs/);
  await assert.rejects(lib.chromeLinkTool({ action: "open", url: "javascript:alert(1)" }, "preview.chrome", host), /http or https/);
  chrome.send({ type: "tabs", allowOpen: true, tabs: [...link.tabs.values()] });
  await until(() => link.allowOpen, "allowOpen");
  assert.deepEqual(await lib.chromeLinkTool({ action: "open", url: "https://a.example/" }, "preview.chrome", host), { ok: true, tabId: "chrome:99", url: "https://a.example/", title: "Opened" });
  assert.deepEqual(answers.at(-1), { id: answers.at(-1).id, type: "open", url: "https://a.example/", group: "Codara" }, "an opened tab never lands loose");
  assert.equal(lib.recentChromeActivity()[0].detail, "opened https://a.example/");
  // Without a group the tab joins its workspace's, named like the workspace
  // and cleaned like every group name; an agent's own group wins.
  const asked = [];
  const named = {
    ...host,
    workspaceName: async (workspaceId) => {
      asked.push(workspaceId);
      return workspaceId === "ws-1" ? "  My\tApp \n  " : null;
    },
  };
  await lib.chromeLinkTool({ action: "open", url: "https://a.example/", workspaceId: "ws-1" }, "preview.chrome", named);
  assert.equal(answers.at(-1).group, "My App");
  await lib.chromeLinkTool({ action: "open", url: "https://a.example/" }, "preview.chrome", named);
  assert.deepEqual(asked, ["ws-1", null], "a caller outside a workspace asks for the one on screen");
  assert.equal(answers.at(-1).group, "Codara", "no workspace name");
  await lib.chromeLinkTool({ action: "open", url: "https://a.example/", workspaceId: "ws-1", group: " Login  flow " }, "preview.chrome", named);
  assert.equal(answers.at(-1).group, "Login flow");
  await lib.chromeLinkTool({ action: "open", url: "https://a.example/", workspaceId: "ws-1", group: "   " }, "preview.chrome", named);
  assert.equal(answers.at(-1).group, "My App", "a blank group is no group");
  const failing = { ...host, workspaceName: async () => { throw new Error("state unreadable"); } };
  await lib.chromeLinkTool({ action: "open", url: "https://a.example/", workspaceId: "ws-1" }, "preview.chrome", failing);
  assert.equal(answers.at(-1).group, "Codara");
  const toBank = await lib.chromeLinkTool({ action: "open", url: "https://a.example/redirects-to-bank" }, "preview.chrome", host);
  assert.deepEqual({ ...toBank, note: undefined }, { ok: true, tabId: "chrome:98", url: "", title: "", blocked: true, note: undefined }, "a tab that ended on a blocked site is not described");
  assert.match(toBank.note, /blocked for agents/);
  await lib.chromeLinkTool({ action: "activate", tabId: "chrome:12" }, "preview.chrome", host);
  assert.deepEqual(answers.at(-1), { id: answers.at(-1).id, type: "activate", tabId: 12 });
  await assert.rejects(lib.chromeLinkTool({ action: "close", tabId: "tab-3" }, "preview.chrome", host), /tabId of a Chrome tab/);

  // The extension refuses: the error reaches the agent as is.
  const refusing = extension(port, { answer: async () => { throw new Error("Cookies and site storage of chrome:5 need the user's permission"); } });
  await refusing.opened;
  await refusing.login({ token, linkId: paired.linkId });
  await refusing.next("welcome");
  await until(() => downs.length === 1, "the replaced link going down");
  refusing.send({ type: "tabs", tabs: [{ tabId: 5, windowId: 1, url: "https://shop.example/", title: "Shop", active: true }] });
  const second = await until(() => server.links()[0]?.tabs.has(5) && server.links()[0], "the new socket's tabs");
  assert.notEqual(second, link, "the reconnected browser replaces its old socket");
  const reconnected = await lib.resolveBrowserTarget({ tabId: "chrome:5" });
  await assert.rejects(reconnected.session.send("Network.getCookies"), /need the user's permission/);

  // Cancel on the browser's debugging bar: the next call says the user stopped it.
  refusing.send({ type: "detached", tabId: 5, reason: "canceled_by_user" });
  refusing.send({ type: "tabs", tabs: [] });
  await until(() => second.tabs.size === 0, "the stop");
  await assert.rejects(lib.resolveBrowserTarget({ tabId: "chrome:5" }), /stopped agents in chrome:5 from the browser's debugging bar/);

  // The link outlives the tab's session: dropping the session takes its listeners off the link.
  assert.equal(second.detachListeners.size, 1);
  assert.equal(second.closeListeners.size, 1);
  backend.syncTabs(second);
  assert.equal(second.detachListeners.size, 0, "a stopped tab's session leaves no detach listener behind");
  assert.equal(second.closeListeners.size, 0, "nor a close listener");
  await assert.rejects(lib.resolveBrowserTarget({ tabId: "chrome:5" }), /stopped agents in chrome:5/, "the reason survives the session");

  // Two browsers: ids carry the browser, and a bare id that both have is ambiguous.
  const edge = extension(port, { id: EXT_B, answer });
  await edge.opened;
  await edge.pair({ browser: { name: "Microsoft Edge", version: "141" } });
  await until(() => server.pendingPairings().length === 1, "the second pairing request");
  server.approve(server.pendingPairings()[0].id);
  const edgePaired = await edge.next("paired");
  assert.match(edgePaired.linkId, /^edge-[0-9a-f]{4}$/);
  edge.send({ type: "tabs", tabs: [{ tabId: 7, windowId: 1, url: "https://x.example/", title: "X", active: true }] });
  refusing.send({ type: "tabs", tabs: [{ tabId: 7, windowId: 1, url: "https://y.example/", title: "Y", active: true }] });
  await until(() => server.links().every((l) => l.tabs.has(7)), "both tab lists");
  assert.deepEqual((await backend.list()).map((tab) => tab.id).sort(), [`chrome:${edgePaired.linkId}/7`, `chrome:${paired.linkId}/7`].sort());
  await assert.rejects(lib.resolveBrowserTarget({ tabId: "chrome:7" }), /Several connected browsers have a tab 7/);
  assert.equal((await lib.resolveBrowserTarget({ tabId: `chrome:${edgePaired.linkId}/7` })).ref, `chrome:${edgePaired.linkId}/7`);

  // Unpair: the browser is told, its token stops working, its tabs are gone.
  assert.equal(server.unpair(edgePaired.linkId), true);
  await edge.next("revoked");
  await until(() => edge.closed, "the revoked socket closing");
  assert.ok(!fs.readFileSync(storeFile, "utf8").includes(edgePaired.linkId));
  const again = extension(port, { id: EXT_B });
  await again.opened;
  again.hello({ linkId: edgePaired.linkId, nonce: "f".repeat(32) });
  await again.next("unpaired");
  assert.deepEqual((await backend.list()).map((tab) => tab.id), ["chrome:7"], "one browser left: bare ids again");

  // The extension's own Disconnect forgets the pairing too.
  refusing.send({ type: "unpair" });
  await until(() => server.links().length === 0, "the extension's unpair");
  assert.deepEqual(store.list(), []);
  const persisted = new lib.ChromeLinkStore(storeFile);
  assert.deepEqual(persisted.list(), [], "a restarted Codara knows no browser");

  // Past the handshake every frame is sealed. Something on the path that
  // relayed the handshake can read nothing, and a frame it adds or replays
  // ends the link before Codara acts on it.
  const sealedExt = extension(port, { answer });
  await sealedExt.opened;
  await sealedExt.pair();
  await until(() => server.pendingPairings().length === 1, "the pairing to seal");
  server.approve(server.pendingPairings()[0].id);
  const sealedPaired = await sealedExt.next("paired");
  sealedExt.send({ type: "tabs", tabs: [{ tabId: 21, windowId: 1, url: "https://z.example/", title: "Z", active: true }] });
  const sealedLink = await until(() => server.link(sealedPaired.linkId)?.tabs.has(21) && server.link(sealedPaired.linkId), "the sealed tab list");
  await (await lib.resolveBrowserTarget({ tabId: "chrome:21" })).evaluate("1");
  const afterPaired = sealedExt.frames.slice(sealedExt.frames.findIndex((frame) => frame.type === "paired") + 1);
  assert.ok(afterPaired.length > 0 && afterPaired.every((frame) => typeof frame.sealed === "string" && Object.keys(frame).length === 1), "Codara's frames after paired are sealed");
  sealedExt.raw(JSON.stringify({ type: "tabs", tabs: [{ tabId: 22, windowId: 1, url: "https://evil.example/", title: "Evil", active: true }] }));
  await until(() => sealedExt.closed, "the drop on an unsealed frame");
  assert.equal(sealedExt.closeCode, 4005);
  assert.ok(!sealedLink.tabs.has(22), "the injected frame was not acted on");
  assert.equal(server.link(sealedPaired.linkId), null);
  const replay = extension(port, { answer });
  await replay.opened;
  await replay.login({ token: sealedExt.token, linkId: sealedPaired.linkId });
  await replay.next("welcome");
  const frame = await replay.sealer.seal({ type: "tabs", tabs: [{ tabId: 23, windowId: 1, url: "https://z.example/", title: "Z", active: true }] });
  replay.raw(frame);
  await until(() => server.link(sealedPaired.linkId)?.tabs.has(23), "the sealed frame");
  replay.raw(frame);
  await until(() => replay.closed, "the drop on a replayed frame");
  assert.equal(replay.closeCode, 4005);

  unregister();
  await server.stop();
  fs.rmSync(home, { recursive: true, force: true });

  // A navigation on a Chrome tab answers when the page loaded. The load
  // event comes only with the Page domain on, so navigate turns it on
  // itself instead of waiting out its 15 second timeout.
  const pageDomains = new Set();
  const pageListeners = new Map();
  const pageSession = {
    async enable(domain) {
      pageDomains.add(domain);
      return async () => {};
    },
    on(method, listener) {
      pageListeners.set(method, listener);
      return () => pageListeners.delete(method);
    },
    async send(method) {
      assert.equal(method, "Page.navigate");
      setTimeout(() => pageDomains.has("Page") && pageListeners.get("Page.loadEventFired")?.({}), 20);
      return { frameId: "F", loaderId: "L" };
    },
  };
  const navigateStarted = Date.now();
  const navigated = await lib.navigate({ ref: "chrome:12", session: pageSession, info: async () => ({ url: "https://a.example/next", title: "Next" }) }, { url: "https://a.example/next" });
  assert.deepEqual(navigated, { url: "https://a.example/next", title: "Next", tabId: "chrome:12", opened: false });
  assert.ok(Date.now() - navigateStarted < 2_000, "navigate waited for the load event, not its timeout");
  console.log("chrome link: origin and host checks, pairing over ECDH with code and Allow, a swapped key refused, bound tokens never sent, sealed frames with injected and replayed ones dropping the link, shared and blocked tabs, relayed protocol, activity, codara_preview_chrome, unpair");
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
