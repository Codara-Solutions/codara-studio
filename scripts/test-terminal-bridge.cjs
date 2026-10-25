#!/usr/bin/env node
"use strict";

// Unit tests for src/main/terminal-bridge.ts against an Electron stub: a
// renderer answer that comes after its request timed out reaches the
// caller's onLate, so a tab nobody waits for any more can be closed.
//
//   node scripts/test-terminal-bridge.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

function stubs() {
  return {
    name: "terminal-bridge-stubs",
    setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "bridge-stub" }));
      build.onResolve({ filter: /^\.\/main-window-trust$/ }, () => ({ path: "trust", namespace: "bridge-stub" }));
      build.onLoad({ filter: /^electron$/, namespace: "bridge-stub" }, () => ({
        loader: "js",
        contents: `
          const stub = globalThis.__bridgeStub;
          export const ipcMain = { on: (channel, listener) => stub.listeners.set(channel, listener) };
          export const BrowserWindow = { getFocusedWindow: () => null, getAllWindows: () => [stub.window] };
        `,
      }));
      build.onLoad({ filter: /^trust$/, namespace: "bridge-stub" }, () => ({
        loader: "js",
        contents: `
          export const getTrustedMainWindow = () => globalThis.__bridgeStub.window;
          export const isTrustedOnSender = () => true;
        `,
      }));
    },
  };
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-terminal-bridge-"));
  const outfile = path.join(temp, "terminal-bridge.cjs");
  try {
    const sent = [];
    globalThis.__bridgeStub = {
      listeners: new Map(),
      window: { webContents: { isDestroyed: () => false, isLoading: () => false, send: (channel, request) => sent.push(request) } },
    };
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "main", "terminal-bridge.ts")],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      plugins: [stubs()],
      logLevel: "silent",
    });
    const bridge = require(outfile);
    bridge.registerTerminalBridge();
    const respond = (reqId, result) =>
      globalThis.__bridgeStub.listeners.get("terminal-bridge:response")({}, { reqId, ok: true, result });

    const late = [];
    await assert.rejects(
      bridge.requestTerminalOp("create", { cwd: "/wt" }, { timeoutMs: 20, onLate: (result) => late.push(result) }),
      /timed out/,
    );
    respond(sent[0].reqId, { tabId: "tab-1", paneId: "pane-1" });
    assert.deepEqual(late, [{ tabId: "tab-1", paneId: "pane-1" }], "the late tab reaches onLate");
    respond(sent[0].reqId, { tabId: "tab-1", paneId: "pane-1" });
    assert.equal(late.length, 1, "once");

    // In time, onLate stays out of it; without one, a late answer is dropped.
    const onTime = bridge.requestTerminalOp("create", {}, { timeoutMs: 1_000, onLate: (result) => late.push(result) });
    respond(sent[1].reqId, { tabId: "tab-2" });
    assert.deepEqual(await onTime, { tabId: "tab-2" });
    await assert.rejects(bridge.requestTerminalOp("create", {}, { timeoutMs: 20 }), /timed out/);
    respond(sent[2].reqId, { tabId: "tab-3" });
    assert.equal(late.length, 1);
    console.log("PASS a terminal op answered after its timeout reaches onLate");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("FAIL a terminal op answered after its timeout reaches onLate");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
