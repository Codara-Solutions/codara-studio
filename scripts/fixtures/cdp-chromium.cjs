"use strict";
// A real Chromium for unit suites that need the DevTools protocol: launched
// headless with --remote-debugging-port, driven over one browser WebSocket
// with flat sessions, the way the Chrome extension link relays
// chrome.debugger. transportFor() returns the same CdpTransport shape
// src/main/browser/cdp-session.ts expects.
//
//   const chromium = await startCdpChromium();   // null when none is installed
//   const { targetId } = await chromium.newPage("data:text/html,...");
//   const transport = chromium.transportFor(targetId);
//   ...
//   await chromium.close();

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const HEADLESS_SHELLS = [
  "chrome-headless-shell-linux64/chrome-headless-shell",
  "chrome-linux/headless_shell",
  "chrome-headless-shell-mac-arm64/chrome-headless-shell",
  "chrome-headless-shell-mac-x64/chrome-headless-shell",
];
const FULL_BROWSERS = ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"];

function inPlaywrightCache(binaries) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  const candidates = [];
  for (const directory of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    for (const binary of binaries) {
      const candidate = path.join(cache, directory, binary);
      if (fs.existsSync(candidate)) candidates.push(candidate);
    }
  }
  return candidates.sort().pop() ?? null;
}

// The headless shell first, as Playwright itself runs headless: it draws
// without any window. Full Chromium in --headless=new opens real windows,
// and macOS stops painting the ones it counts as hidden, so a page there
// can stay unpainted (no FCP, LCP or layout shifts).
function findChromium() {
  const shell = inPlaywrightCache(HEADLESS_SHELLS);
  if (shell) return shell;
  try {
    const expected = require("playwright").chromium.executablePath();
    if (fs.existsSync(expected)) return expected;
  } catch {
    /* fall through to the cache scan */
  }
  return inPlaywrightCache(FULL_BROWSERS);
}

async function startCdpChromium() {
  const executable = findChromium();
  if (!executable) return null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "codara-cdp-chromium-"));
  const child = spawn(executable, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "about:blank",
  ], {
    stdio: ["ignore", "ignore", "pipe"],
    // Its own process group, so close() also ends the helper processes.
    detached: process.platform !== "win32",
  });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error("Chromium did not print its DevTools endpoint")), 15_000);
    child.stderr.on("data", (chunk) => {
      buffered += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffered);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited early (${code})`));
    });
  });
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const eventListeners = new Set();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    for (const listener of eventListeners) listener(message);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  return {
    send,
    async newPage(url = "about:blank") {
      const { targetId } = await send("Target.createTarget", { url });
      return { targetId };
    },
    transportFor(targetId) {
      let sessionId = null;
      const detachListeners = new Set();
      const onBrowserEvent = (message) => {
        if (message.method === "Target.detachedFromTarget" && message.params.sessionId === sessionId) {
          sessionId = null;
          for (const listener of detachListeners) listener(message.params.reason ?? "detached");
        }
      };
      eventListeners.add(onBrowserEvent);
      return {
        async attach() {
          if (sessionId) return;
          const result = await send("Target.attachToTarget", { targetId, flatten: true });
          sessionId = result.sessionId;
        },
        isAttached: () => sessionId !== null,
        detach() {
          if (!sessionId) return;
          void send("Target.detachFromTarget", { sessionId }).catch(() => {});
          sessionId = null;
        },
        send(method, params) {
          if (!sessionId) return Promise.reject(new Error("not attached"));
          return send(method, params ?? {}, sessionId);
        },
        onEvent(listener) {
          const filtered = (message) => {
            if (message.sessionId && message.sessionId === sessionId) listener(message.method, message.params ?? {});
          };
          eventListeners.add(filtered);
          return () => eventListeners.delete(filtered);
        },
        onDetach(listener) {
          detachListeners.add(listener);
          return () => detachListeners.delete(listener);
        },
        /** For tests: drop the session as if another client took the tab. */
        forceDetach() {
          const id = sessionId;
          if (id) void send("Target.detachFromTarget", { sessionId: id }).catch(() => {});
        },
      };
    },
    async close() {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      // Killing the browser alone leaves its helpers running on macOS, and
      // they hold the stderr pipe (and keep-alive sockets to test servers)
      // open, so the suite finishes but its process never exits.
      const exited = new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve)));
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      await exited;
      child.stderr.destroy();
      // Chromium's helper processes outlive the browser by a moment and can
      // still be writing the profile; a busy machine made rmSync race them.
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      } catch {
        /* a leftover temp profile must not fail the suite */
      }
    },
  };
}

module.exports = { startCdpChromium };
