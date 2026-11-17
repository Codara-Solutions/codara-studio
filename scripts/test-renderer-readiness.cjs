#!/usr/bin/env node
"use strict";

// A terminal op sent while the app window is still starting waits for React
// to mount (src/main/renderer-readiness.ts) instead of going into a renderer
// that cannot hear it and timing out: once the window is ready it is sent and
// answered within the same time budget, and a window that never gets ready
// fails with a message that says so. Before the app starts tracking, nothing
// is held back. Runs src/main/terminal-bridge.ts against an Electron stub, on
// scripts/fake-clock.cjs.
//
//   node scripts/test-renderer-readiness.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

const stubs = {
  name: "renderer-readiness-stubs",
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "ready-stub" }));
    build.onResolve({ filter: /^\.\/main-window-trust$/ }, () => ({ path: "trust", namespace: "ready-stub" }));
    build.onLoad({ filter: /^electron$/, namespace: "ready-stub" }, () => ({
      loader: "js",
      contents: `
        const stub = globalThis.__readyStub;
        export const ipcMain = { on: (channel, listener) => stub.listeners.set(channel, listener) };
        export const BrowserWindow = { getFocusedWindow: () => null, getAllWindows: () => [stub.window] };
      `,
    }));
    build.onLoad({ filter: /^trust$/, namespace: "ready-stub" }, () => ({
      loader: "js",
      contents: `
        export const getTrustedMainWindow = () => globalThis.__readyStub.window;
        export const isTrustedOnSender = () => true;
      `,
    }));
  },
};

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}`);
    console.log(error && error.stack ? error.stack : String(error));
  }
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-renderer-readiness-"));
  try {
    const sent = [];
    globalThis.__readyStub = {
      listeners: new Map(),
      window: { webContents: { isDestroyed: () => false, isLoading: () => false, send: (_channel, request) => sent.push(request) } },
    };
    const entry = path.join(temp, "entry.ts");
    fs.writeFileSync(
      entry,
      `export * from ${JSON.stringify(path.join(ROOT, "src", "main", "terminal-bridge.ts"))};\n` +
        `export * from ${JSON.stringify(path.join(ROOT, "src", "main", "renderer-readiness.ts"))};\n`,
    );
    const outfile = path.join(temp, "bridge.cjs");
    await esbuild.build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "cjs", plugins: [stubs], logLevel: "silent" });
    const clock = require("./fake-clock.cjs").installFakeClock();
    const bridge = require(outfile);
    bridge.registerTerminalBridge();
    const respond = (reqId, result) =>
      globalThis.__readyStub.listeners.get("terminal-bridge:response")({}, { reqId, ok: true, result });

    await check("before the app tracks the window, an op is sent at once", async () => {
      const op = bridge.requestTerminalOp("list", {}, { timeoutMs: 5_000 });
      assert.equal(sent.length, 1);
      respond(sent[0].reqId, { panes: [] });
      assert.deepEqual(await op, { panes: [] });
    });

    await check("an op sent while the window starts waits, then goes once it is ready", async () => {
      bridge.markRendererNotReady();
      const before = sent.length;
      const op = bridge.requestTerminalOp("list", {}, { timeoutMs: 5_000 });
      await clock.advance(3_000);
      assert.equal(sent.length, before, "nothing is sent into a window that cannot hear it");
      bridge.markRendererReady();
      await clock.advance(0);
      assert.equal(sent.length, before + 1);
      respond(sent[before].reqId, { panes: ["p"] });
      assert.deepEqual(await op, { panes: ["p"] });
    });

    await check("the wait counts against the op's own time budget", async () => {
      bridge.markRendererNotReady();
      const before = sent.length;
      const op = bridge.requestTerminalOp("list", {}, { timeoutMs: 5_000 });
      const outcome = op.then(() => "answered", (error) => error.message);
      await clock.advance(3_000);
      bridge.markRendererReady();
      await clock.advance(0);
      assert.equal(sent.length, before + 1);
      await clock.advance(2_000);
      assert.equal(await outcome, "terminal op 'list' timed out after 5000ms");
    });

    await check("a window that never gets ready fails with a message that says so", async () => {
      bridge.markRendererNotReady();
      const before = sent.length;
      const outcome = bridge.requestTerminalOp("list", {}, { timeoutMs: 5_000 }).then(() => "answered", (error) => error.message);
      await clock.advance(5_000);
      assert.equal(await outcome, bridge.RENDERER_STARTING_MESSAGE);
      assert.equal(sent.length, before, "nothing was sent");
    });

    await check("a reload makes ops wait again", async () => {
      bridge.markRendererReady();
      bridge.markRendererNotReady();
      assert.equal(bridge.isRendererReady(), false);
      bridge.markRendererReady();
      assert.equal(bridge.isRendererReady(), true);
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  if (failures > 0) process.exit(1);
  console.log("renderer readiness: all passed");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
