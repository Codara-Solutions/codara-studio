#!/usr/bin/env node
"use strict";

// src/main/main-window-teardown.ts: when the main window goes away under the
// app (a lost Wayland connection destroys it before its WebContents), the
// WebContents `destroyed` handler still clears the unresponsive timer,
// detaches the PTYs and disposes the file watchers, all for that WebContents,
// and does not throw. Electron's `win.webContents` getter throws "Object has
// been destroyed" once the window is destroyed; the fake window below does
// the same. The WebContents is read while the window is alive, as
// createWindow does, and the helper is never handed the window.
//
//   node scripts/test-main-window-teardown.cjs

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

function fakeWindow() {
  const contents = new EventEmitter();
  contents.id = 7;
  let destroyed = false;
  const win = {
    isDestroyed: () => destroyed,
    destroy() {
      destroyed = true;
    },
  };
  Object.defineProperty(win, "webContents", {
    get() {
      if (destroyed) throw new TypeError("Object has been destroyed");
      return contents;
    },
  });
  return { win, contents };
}

function recordingCleanup() {
  const calls = [];
  return {
    calls,
    cleanup: {
      clearUnresponsiveTimer: (owner) => calls.push(["clearUnresponsiveTimer", owner]),
      detachTerminals: (owner) => calls.push(["detachTerminals", owner]),
      disposeWatchers: (owner) => calls.push(["disposeWatchers", owner]),
    },
  };
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codara-main-window-teardown-"));
  try {
    const out = path.join(scratch, "main-window-teardown.cjs");
    await esbuild.build({
      entryPoints: [path.join(__dirname, "..", "src", "main", "main-window-teardown.ts")],
      bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "silent",
      external: ["electron"],
    });
    const { onMainWebContentsDestroyed } = require(out);

    {
      const { win, contents } = fakeWindow();
      const { calls, cleanup } = recordingCleanup();
      onMainWebContentsDestroyed(win.webContents, cleanup);
      win.destroy();
      assert.throws(() => win.webContents, /Object has been destroyed/, "the fake window behaves like Electron's");
      assert.doesNotThrow(() => contents.emit("destroyed"), "the destroyed handler must not read the destroyed window");
      assert.deepEqual(
        calls.map(([name]) => name),
        ["clearUnresponsiveTimer", "detachTerminals", "disposeWatchers"],
        "all three clean-ups run",
      );
      for (const [name, owner] of calls) assert.equal(owner, contents, `${name} gets the window's own WebContents`);
    }

    {
      const { win, contents } = fakeWindow();
      const { calls, cleanup } = recordingCleanup();
      onMainWebContentsDestroyed(win.webContents, cleanup);
      contents.emit("destroyed");
      assert.equal(calls.length, 3, "a WebContents destroyed while its window is still alive is cleaned up too");
      for (const [name, owner] of calls) assert.equal(owner, contents, `${name} gets the window's own WebContents`);
    }

    console.log("PASS main-window-teardown");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
