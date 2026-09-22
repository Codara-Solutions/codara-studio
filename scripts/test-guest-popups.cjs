#!/usr/bin/env node
"use strict";

// A page in the in-app browser that opens a new window used to get Electron's
// default: a full, unparented BrowserWindow (full screen when Codara was). The
// handler on the app window never saw it, because a <webview> guest is its own
// webContents. This drives the real routing in src/main/guest-popups.ts with
// fake webContents.
//
// Proven here:
//   1. target=_blank links, cmd-click, shift-click and window.open without
//      popup features become in-app browser tabs (background for cmd-click).
//   2. A sized scripted popup (sign-in windows) and a blank popup its opener
//      fills keep a real window, parented to the app window, never full screen.
//   3. Non-web schemes, and file: from a web page, open nothing.
//   4. A popup window's own links follow the same rules.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codara-guest-popups-"));
process.on("exit", () => fs.rmSync(OUT_DIR, { recursive: true, force: true }));

const electronStubPlugin = {
  name: "electron-stub",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "codara-test" }));
    pluginBuild.onLoad({ filter: /^electron$/, namespace: "codara-test" }, () => ({
      contents: `export const BrowserWindow = {
          fromWebContents: (contents) => (contents && contents.ownerWindow) || null,
        };`,
      loader: "js",
    }));
  },
};

async function load() {
  const outfile = path.join(OUT_DIR, "guest-popups.bundle.cjs");
  await build({
    entryPoints: [path.join(ROOT, "src", "main", "guest-popups.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    plugins: [electronStubPlugin],
    logLevel: "silent",
  });
  return require(outfile);
}

function fakeContents(type, url, ownerWindow = null) {
  const listeners = new Map();
  return {
    ownerWindow,
    handler: null,
    sent: [],
    getType: () => type,
    getURL: () => url,
    isDestroyed: () => false,
    send(...args) {
      this.sent.push(args);
    },
    setWindowOpenHandler(fn) {
      this.handler = fn;
    },
    on(event, fn) {
      listeners.set(event, fn);
    },
    emit(event, ...args) {
      listeners.get(event)?.(...args);
    },
  };
}

async function main() {
  const { decideGuestPopup, routeGuestPopups } = await load();
  const opener = "https://app.example.com/page";
  const decide = (url, disposition, features = "", openerUrl = opener) =>
    decideGuestPopup({ url, disposition, features, openerUrl });

  assert.deepEqual(decide("https://docs.example.com/", "foreground-tab"), { kind: "tab", background: false });
  assert.deepEqual(decide("https://docs.example.com/", "background-tab"), { kind: "tab", background: true });
  assert.deepEqual(decide("https://docs.example.com/", "new-window"), { kind: "tab", background: false });
  assert.deepEqual(
    decide("https://docs.example.com/", "foreground-tab", "noopener,noreferrer"),
    { kind: "tab", background: false },
  );
  assert.deepEqual(decide("http://localhost:5173/next", "foreground-tab"), { kind: "tab", background: false });
  console.log("ok 1 links and plain window.open calls become tabs");

  assert.deepEqual(decide("https://accounts.example.com/signin", "new-window", "width=500,height=600"), { kind: "window" });
  assert.deepEqual(decide("https://accounts.example.com/signin", "new-window", "popup"), { kind: "window" });
  assert.deepEqual(decide("https://accounts.example.com/signin", "new-window", " Left=10 , top=10"), { kind: "window" });
  assert.deepEqual(decide("about:blank", "foreground-tab"), { kind: "window" });
  assert.deepEqual(decide("", "new-window", "width=400"), { kind: "window" });
  console.log("ok 2 sized and blank scripted popups keep a real window");

  assert.deepEqual(decide("javascript:alert(1)", "foreground-tab"), { kind: "deny" });
  assert.deepEqual(decide("mailto:someone@example.com", "foreground-tab"), { kind: "deny" });
  assert.deepEqual(decide("file:///etc/passwd", "foreground-tab"), { kind: "deny" });
  assert.deepEqual(decide("not a url", "foreground-tab"), { kind: "deny" });
  assert.deepEqual(
    decide("file:///Users/me/site/b.html", "foreground-tab", "", "file:///Users/me/site/a.html"),
    { kind: "tab", background: false },
  );
  console.log("ok 3 non-web schemes and file: from a web page open nothing");

  const appWindow = { id: "app-window" };
  const host = fakeContents("window", "app://index.html", appWindow);
  const guest = fakeContents("webview", opener);
  routeGuestPopups(guest, () => host);

  const link = guest.handler({ url: "https://docs.example.com/", disposition: "foreground-tab", features: "" });
  assert.deepEqual(link, { action: "deny" });
  assert.deepEqual(host.sent, [
    ["app:open-browser-url", "https://docs.example.com/", { forceNew: true, background: false }],
  ]);

  const signin = guest.handler({
    url: "https://accounts.example.com/signin",
    disposition: "new-window",
    features: "width=500,height=600",
  });
  assert.deepEqual(signin, {
    action: "allow",
    overrideBrowserWindowOptions: {
      parent: appWindow,
      useContentSize: true,
      fullscreen: false,
      fullscreenable: false,
      autoHideMenuBar: true,
    },
  });
  assert.equal(host.sent.length, 1, "a real popup is not also opened as a tab");
  assert.deepEqual(guest.handler({ url: "javascript:void 0", disposition: "foreground-tab", features: "" }), {
    action: "deny",
  });
  assert.equal(host.sent.length, 1);

  const popupWindow = { id: "popup-window" };
  const popupContents = fakeContents("window", "https://accounts.example.com/signin", popupWindow);
  guest.emit("did-create-window", { webContents: popupContents });
  assert.equal(typeof popupContents.handler, "function", "the popup window gets the same routing");
  popupContents.handler({ url: "https://accounts.example.com/help", disposition: "foreground-tab", features: "" });
  assert.deepEqual(host.sent.at(-1), [
    "app:open-browser-url",
    "https://accounts.example.com/help",
    { forceNew: true, background: false },
  ]);
  const nested = popupContents.handler({ url: "about:blank", disposition: "new-window", features: "width=300" });
  assert.equal(nested.overrideBrowserWindowOptions.parent, popupWindow);
  console.log("ok 4 a popup window's own links follow the same rules");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
