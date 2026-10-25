"use strict";
// The browser pane's pure rules (DESIGN.md, "Browser pane (2026-10)"):
// - which tabs may sleep (src/renderer/src/components/Preview/tabs-memory/
//   sleepPolicy.ts): never one on screen, recording, used by an agent in the
//   last 10 minutes, or logged out; auto-sleep after 30 minutes unseen, and
//   nothing when it is off;
// - the words of the tabs view: memory, "asleep 25 min", short URLs;
// - full screen steps: the button and F11 fill the window, F11 again takes
//   the display, Esc always leaves;
// - the address pill (toolbar/address.ts): a port alone opens localhost, and
//   the dev server chip names the server a URL is on.
// The real window path is tests/e2e/browser-pane-toolbar.spec.ts.
//
//   node scripts/test-browser-pane.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const PREVIEW = path.join(ROOT, "src/renderer/src/components/Preview");

function bundle(contents) {
  const out = esbuild.buildSync({
    stdin: { contents, resolveDir: PREVIEW, loader: "ts" },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const lib = bundle(`
  export * from "./tabs-memory/sleepPolicy";
  export { normalizeUrl, serverForUrl, serverUrl } from "./toolbar/address";
`);

const MIN = 60_000;
const NOW = 1_800_000_000_000;

function tab(id, extra = {}) {
  return { id, asleep: false, visible: false, lastSeenAt: NOW - 31 * MIN, isolated: false, recording: false, agentActiveAt: null, ...extra };
}

function blockers() {
  const { sleepBlocker, sleepBlockerText } = lib;
  assert.equal(sleepBlocker(tab("a"), NOW), null);
  assert.equal(sleepBlocker(tab("a", { visible: true }), NOW), "visible");
  assert.equal(sleepBlocker(tab("a", { recording: true }), NOW), "recording");
  assert.equal(sleepBlocker(tab("a", { agentActiveAt: NOW - 9 * MIN }), NOW), "agent");
  assert.equal(sleepBlocker(tab("a", { agentActiveAt: NOW - 11 * MIN }), NOW), null, "an agent that left 11 minutes ago no longer holds the tab");
  assert.equal(sleepBlocker(tab("a", { isolated: true }), NOW), "isolated");
  assert.equal(sleepBlocker(tab("a", { visible: true, recording: true }), NOW), "visible", "the first reason wins");
  for (const reason of ["visible", "recording", "agent", "isolated"]) assert.ok(sleepBlockerText(reason).length > 0);
}

function autoSleep() {
  const { tabsToAutoSleep, AUTO_SLEEP_AFTER_MS } = lib;
  assert.equal(AUTO_SLEEP_AFTER_MS, 30 * MIN);
  const tabs = [
    tab("old"),
    tab("recent", { lastSeenAt: NOW - 29 * MIN }),
    tab("exactly", { lastSeenAt: NOW - 30 * MIN }),
    tab("shown", { visible: true, lastSeenAt: NOW - 90 * MIN }),
    tab("rec", { recording: true }),
    tab("agent", { agentActiveAt: NOW - MIN }),
    tab("logged-out", { isolated: true }),
    tab("already", { asleep: true }),
  ];
  assert.deepEqual(tabsToAutoSleep(tabs, NOW, { enabled: true }), ["old", "exactly"]);
  assert.deepEqual(tabsToAutoSleep(tabs, NOW, { enabled: false }), [], "off means off");
  assert.deepEqual(tabsToAutoSleep(tabs, NOW, { enabled: true, afterMs: 10 * MIN }), ["old", "recent", "exactly"]);
  assert.deepEqual(tabsToAutoSleep([], NOW, { enabled: true }), []);
}

function words() {
  const { formatMemory, formatAsleepFor, shortUrl } = lib;
  assert.equal(formatMemory(null), "");
  assert.equal(formatMemory(undefined), "");
  assert.equal(formatMemory(NaN), "");
  assert.equal(formatMemory(0), "0 MB");
  assert.equal(formatMemory(24 * 1024 * 1024 + 300_000), "24 MB");
  assert.equal(formatMemory(1536 * 1024 * 1024), "1.5 GB");
  assert.equal(formatAsleepFor(20_000), "asleep");
  assert.equal(formatAsleepFor(25 * MIN), "asleep 25 min");
  assert.equal(formatAsleepFor(3 * 60 * MIN), "asleep 3 h");
  assert.equal(formatAsleepFor(50 * 60 * MIN), "asleep 2 d");
  assert.equal(formatAsleepFor(-5), "asleep");
  assert.equal(shortUrl("http://localhost:5173/dashboard?x=1"), "localhost:5173/dashboard");
  assert.equal(shortUrl("https://vercel.com/"), "vercel.com");
  assert.equal(shortUrl("file:///tmp/a.html"), "file:///tmp/a.html");
  assert.equal(shortUrl("not a url"), "not a url");
}

function fullScreen() {
  const { nextFullScreenMode } = lib;
  assert.equal(nextFullScreenMode("off", "button"), "window");
  assert.equal(nextFullScreenMode("window", "button"), "off");
  assert.equal(nextFullScreenMode("display", "button"), "off");
  assert.equal(nextFullScreenMode("off", "F11"), "window");
  assert.equal(nextFullScreenMode("window", "F11"), "display");
  assert.equal(nextFullScreenMode("display", "F11"), "off");
  for (const mode of ["off", "window", "display"]) assert.equal(nextFullScreenMode(mode, "Escape"), "off", `Esc leaves ${mode}`);
}

function address() {
  const { normalizeUrl, serverForUrl, serverUrl } = lib;
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl("  "), null);
  assert.equal(normalizeUrl("5173"), "http://localhost:5173");
  assert.equal(normalizeUrl(":3000"), "http://localhost:3000");
  assert.equal(normalizeUrl("3000/admin"), "http://localhost:3000/admin");
  assert.equal(normalizeUrl("99999"), "99999", "not a port");
  assert.equal(normalizeUrl("localhost:8080"), "http://localhost:8080");
  assert.equal(normalizeUrl("127.0.0.1:4000/x"), "http://127.0.0.1:4000/x");
  assert.equal(normalizeUrl("vercel.com"), "https://vercel.com");
  assert.equal(normalizeUrl("https://example.com/a"), "https://example.com/a");

  const servers = [
    { id: "web", url: "http://localhost:5173/", port: 5173 },
    { id: "api", url: null, port: 8000 },
    { id: "docs", url: null, port: null },
  ];
  assert.equal(serverUrl(servers[1]), "http://localhost:8000");
  assert.equal(serverUrl(servers[2]), null);
  assert.equal(serverForUrl(servers, "http://localhost:5173/dashboard")?.id, "web");
  assert.equal(serverForUrl(servers, "http://127.0.0.1:8000/docs")?.id, "api", "127.0.0.1 is localhost");
  assert.equal(serverForUrl(servers, "http://localhost:9999/"), null);
  assert.equal(serverForUrl(servers, "https://example.com:5173/"), null, "a remote host on the same port is not the dev server");
  assert.equal(serverForUrl(servers, "garbage"), null);
}

blockers();
autoSleep();
words();
fullScreen();
address();
console.log("browser pane: sleep blockers, auto-sleep after 30 min, tabs view words, full screen steps, ports and dev servers in the address pill");
