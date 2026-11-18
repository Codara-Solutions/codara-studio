"use strict";
// Codara never changes the browser extension by itself
// (src/main/browser/chrome/index.ts, extension-update.ts): starting with a
// newer extension shipped leaves the folder the browser loads from as it is,
// a browser that connects with an older extension is not asked to reload,
// and only Update extension in Settings copies the new files and asks that
// browser's extension to reload. The real startChromeLink runs against a
// fake Electron and a fake extension that speaks the sealed wire protocol
// with the extension's own crypto (extensions/chrome/lib/link-client.js).
//
//   node scripts/test-chrome-extension-update.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const { pathToFileURL } = require("node:url");
const { WebSocket } = require("ws");
const { unusedPort } = require("./unused-port.cjs");

const ROOT = path.resolve(__dirname, "..");
const SHIPPED = path.join(ROOT, "extensions", "chrome");
const extensionCrypto = import(pathToFileURL(path.join(ROOT, "extensions/chrome/lib/link-client.js")).href);

// Enough of Electron for the Chrome link's boot and IPC: no window, no shell.
const FAKE_ELECTRON = `
  const listeners = {};
  module.exports = {
    app: {
      isPackaged: false,
      getAppPath: () => ${JSON.stringify(ROOT)},
      getVersion: () => "9.0.0",
      getPath: () => require("node:os").tmpdir(),
      once: (event, fn) => { listeners[event] = fn; },
      __quit: () => listeners["will-quit"]?.(),
    },
    BrowserWindow: { getAllWindows: () => [] },
    shell: { openPath: async () => "", showItemInFolder: () => {} },
  };
`;

async function load() {
  const out = await esbuild.build({
    stdin: {
      contents: [
        `export * from "./index";`,
        `export * from "./extension-update";`,
        `export { app as fakeApp } from "electron";`,
      ].join("\n"),
      resolveDir: path.join(ROOT, "src/main/browser/chrome"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    // Native modules deeper in main's import graph stay outside the bundle.
    packages: "external",
    alias: { "@shared": path.join(ROOT, "src/shared") },
    plugins: [
      {
        name: "fake-electron",
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "fake-electron" }));
          build.onLoad({ filter: /.*/, namespace: "fake-electron" }, () => ({ contents: FAKE_ELECTRON, loader: "js" }));
        },
      },
    ],
    logLevel: "silent",
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

/** Every file in `dir` with its contents, to tell whether anything changed. */
function snapshot(dir) {
  const files = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(dir, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return files;
}

/** A paired extension of `version` with the given features: what Codara sent it, opened. */
function extension(port, id, version, features) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/codara-chrome`, { origin: `chrome-extension://${id}` });
  const ext = { received: [], sealer: null, closed: false };
  let inbox = Promise.resolve();
  let outbox = Promise.resolve();
  socket.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    inbox = inbox.then(async () => {
      const { pairedToken, sessionSealer, sha256Hex, sharedSecret } = await extensionCrypto;
      const message = ext.sealer ? await ext.sealer.open(frame) : frame;
      if (message.type === "paired") {
        const { privateKey, extensionKey, codaraKey } = ext.pairing;
        const token = await pairedToken(await sharedSecret(privateKey, codaraKey), extensionKey, codaraKey);
        ext.sealer = await sessionSealer(await sha256Hex(token), extensionKey, codaraKey);
      }
      ext.received.push(message);
    });
  });
  socket.on("close", () => (ext.closed = true));
  ext.opened = new Promise((resolve) => socket.on("open", resolve));
  ext.send = (message) => {
    const sealer = ext.sealer;
    outbox = outbox.then(async () => socket.send(sealer ? await sealer.seal(message) : JSON.stringify(message)));
    return outbox;
  };
  ext.next = (type) => until(() => ext.received.find((message) => message.type === type), type);
  ext.pair = async () => {
    const { pairCommitment, pairKeys } = await extensionCrypto;
    const own = await pairKeys();
    await ext.opened;
    ext.send({
      type: "hello",
      protocol: 2,
      browser: { name: "Google Chrome", version: "141.0" },
      extension: { id, version, features },
      pair: true,
      pairCommit: await pairCommitment(own.key),
    });
    const offer = await ext.next("pairing");
    ext.pairing = { privateKey: own.privateKey, extensionKey: own.key, codaraKey: offer.key };
    ext.send({ type: "pair_key", key: own.key });
  };
  ext.close = () => socket.close();
  return ext;
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codara-ext-update-"));
  process.env.CODARA_HOME_DIR = home;
  process.env.CODARA_CHROME_LINK = "1";
  const port = await unusedPort();
  process.env.CODARA_CHROME_LINK_PORTS = String(port);
  const lib = await load();

  // The extension's id from Chrome's own algorithm: Chromium's id_util test
  // vector for "test", and the Windows form (UTF-16, drive letter in upper case).
  assert.equal(lib.unpackedExtensionId("test", "linux"), "jpignaibiiemhngfjkcpokkamffknabf");
  assert.equal(lib.unpackedExtensionId("c:\\Codara\\chrome-extension", "win32"), lib.unpackedExtensionId("C:\\Codara\\chrome-extension", "win32"), "the drive letter is upper-cased");
  assert.notEqual(lib.unpackedExtensionId("C:\\Codara", "win32"), lib.unpackedExtensionId("C:\\Codara", "linux"), "Windows hashes UTF-16");

  const shipped = lib.extensionManifestVersion(SHIPPED);
  assert.ok(shipped, "the repository ships an extension with a version");

  // The user loaded an older copy from Codara's folder some time ago.
  const folder = path.join(home, "chrome-extension");
  fs.cpSync(SHIPPED, folder, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8"));
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify({ ...manifest, version: "1.0.0" }));
  fs.writeFileSync(path.join(folder, "background.js"), "// the older extension's code\n");
  const before = snapshot(folder);

  // Starting Codara leaves the folder as it is.
  lib.startChromeLink();
  const handlers = new Map();
  lib.registerChromeLinkIpc((channel, fn) => handlers.set(channel, fn));
  const ipc = (channel, ...args) => handlers.get(channel)({}, ...args);
  await until(() => lib.chromeLinkState().port === port, "the link listening");
  assert.deepEqual(snapshot(folder), before, "starting Codara with a newer extension shipped leaves the folder's files untouched");

  // Reveal and Copy path in the Add step do not overwrite a copy the user may have loaded.
  assert.equal(await ipc("chromeLink:prepareExtension"), folder);
  assert.equal(await ipc("chromeLink:revealExtension"), folder);
  assert.deepEqual(snapshot(folder), before, "Reveal folder leaves an existing copy alone");

  // A browser that loaded that folder connects with the older extension:
  // it is told the versions, never asked to reload.
  const extensionId = lib.unpackedExtensionId(fs.realpathSync.native(folder));
  const ext = extension(port, extensionId, "1.0.0", ["reload"]);
  await ext.pair();
  const pending = await until(() => lib.chromeLinkState().pending[0], "the pairing request");
  assert.equal(await ipc("chromeLink:approve", pending.id), true);
  await ext.next("paired");
  const linkId = await until(() => lib.chromeLinkState().browsers.find((browser) => browser.connected)?.linkId, "the connected browser");
  ext.send({ type: "tabs", tabs: [], allowOpen: false, session: "session-1234" });
  await wait(300);
  assert.equal(ext.received.filter((message) => message.type === "reload").length, 0, "no reload is sent without the user's yes");
  assert.deepEqual(snapshot(folder), before, "connecting changes nothing on disk");
  const browserState = lib.chromeLinkState().browsers[0];
  assert.equal(browserState.extensionUpdate, "available", "Settings offers Update extension");
  assert.equal(browserState.extensionVersion, "1.0.0");
  assert.equal(browserState.extensionReloads, true, "its hello said it can reload itself");
  assert.equal(lib.chromeLinkState().shippedExtensionVersion, shipped);

  // The user presses Update extension: the folder gets the shipped files and
  // this browser's extension is asked to reload for that version.
  await ipc("chromeLink:updateExtension", { linkId });
  const reload = await ext.next("reload");
  assert.deepEqual(reload, { type: "reload", version: shipped });
  assert.equal(lib.extensionManifestVersion(folder), shipped, "Update copied the new version into the folder");
  assert.equal(lib.extensionContentHash(folder), lib.extensionContentHash(SHIPPED), "the same files Codara ships");
  assert.equal(lib.chromeLinkState().browsers[0].extensionUpdate, "updating");

  // An extension Chrome did not load from Codara's folder (the Chrome Web
  // Store, or the user's own folder) is never updated from Codara.
  const storeId = "p".repeat(32);
  const store = extension(port, storeId, "1.0.0", ["reload"]);
  await store.pair();
  const storePending = await until(() => lib.chromeLinkState().pending[0], "the second pairing request");
  await ipc("chromeLink:approve", storePending.id);
  await store.next("paired");
  const storeLink = await until(
    () => lib.chromeLinkState().browsers.find((browser) => browser.connected && browser.extensionId === storeId),
    "the store-installed browser",
  );
  assert.equal(storeLink.extensionUpdate, "elsewhere");
  const afterUpdate = snapshot(folder);
  await assert.rejects(ipc("chromeLink:updateExtension", { linkId: storeLink.linkId }), /not loaded from Codara's folder/);
  await wait(200);
  assert.equal(store.received.filter((message) => message.type === "reload").length, 0, "a store install is never asked to reload");
  assert.deepEqual(snapshot(folder), afterUpdate);

  // An extension speaking an older link protocol cannot connect: Settings
  // says so, and only Update extension copies the files.
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify({ ...manifest, version: "0.9.0" }));
  const old = new WebSocket(`ws://127.0.0.1:${port}/codara-chrome`, { origin: `chrome-extension://${extensionId}` });
  const refusal = new Promise((resolve) => old.on("message", (raw) => resolve(JSON.parse(String(raw)))));
  await new Promise((resolve) => old.on("open", resolve));
  old.send(JSON.stringify({ type: "hello", protocol: 1, browser: { name: "Brave", version: "1" }, extension: { id: extensionId, version: "0.9.0" } }));
  assert.match((await refusal).message, /update the Codara extension \(Codara's Settings > Browser says how\)/);
  const incompatible = await until(() => lib.chromeLinkState().incompatible[0], "the refused extension");
  assert.deepEqual(incompatible, { extensionId, version: "0.9.0", browser: { name: "Brave", version: "1" }, update: "extension", fromCodaraFolder: true, copied: false });
  assert.equal(lib.extensionManifestVersion(folder), "0.9.0", "a refused extension changes nothing by itself");
  await ipc("chromeLink:updateExtension", { extensionId });
  assert.equal(lib.extensionManifestVersion(folder), shipped);
  assert.equal(lib.chromeLinkState().incompatible[0].copied, true);

  // The first install: Reveal folder makes the copy when there is none.
  fs.rmSync(folder, { recursive: true, force: true });
  await ipc("chromeLink:revealExtension");
  assert.equal(lib.extensionManifestVersion(folder), shipped, "the first Reveal folder copies the extension");

  // What Settings shows, by case.
  const at = (asked, now = 1_000) => ({ running: "1.0.0", features: ["reload"], shipped: "1.1.0", fromCodaraFolder: true, asked, now, graceMs: 100 });
  assert.equal(lib.extensionUpdateState({ ...at(undefined), running: "1.1.0" }), null, "current");
  assert.equal(lib.extensionUpdateState({ ...at(undefined), running: "1.2.0" }), null, "newer than shipped");
  assert.equal(lib.extensionUpdateState({ ...at(undefined), shipped: null }), null, "nothing shipped to compare");
  assert.equal(lib.extensionUpdateState(at(undefined)), "available");
  assert.equal(lib.extensionUpdateState({ ...at(undefined), fromCodaraFolder: false }), "elsewhere");
  assert.equal(lib.extensionUpdateState(at({ version: "1.1.0", at: 950 })), "updating");
  assert.equal(lib.extensionUpdateState(at({ version: "1.1.0", at: 800 })), "manual", "a reload that did not bring the new version");
  assert.equal(lib.extensionUpdateState({ ...at({ version: "1.1.0", at: 950 }), features: [] }), "manual", "too old to reload itself");
  assert.equal(lib.extensionUpdateState(at({ version: "1.0.5", at: 950 })), "available", "a yes for an earlier version is not a yes for this one");

  ext.close();
  store.close();
  old.close();
  lib.fakeApp.__quit();
  fs.rmSync(home, { recursive: true, force: true });
  console.log("chrome extension update: starting leaves the folder alone, connecting sends no reload, Update extension copies and asks that browser only, store installs and other folders are left alone, older protocols say so, the first Reveal copies");
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
