#!/usr/bin/env node
"use strict";

// Renderer backpressure for src/main/pty-manager.ts.
//
// Main counts every byte it ships to the renderer once that renderer has
// acked at least once; past RENDER_HIGH_WATER_BYTES of unacked bytes the pty
// is paused at the OS level (reason "render") and resumed when acks bring
// the backlog under RENDER_LOW_WATER_BYTES. Holds are reason-keyed so the
// remote-access socket's pause (reason "remote") and the renderer's never
// undo each other. A watchdog releases a hold that sees no ack progress and
// switches accounting off again, so a renderer that stops acking can never
// freeze a child. Detach and pause (workspace switch) drop the accounting.
//
//   node scripts/test-pty-render-backpressure.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const {
  createController,
  stubPlugin,
  localOptions,
  MODULE_TS,
  CACHE_ROOT,
  nextTurn,
} = require("./test-pty-spawn-serialization.cjs");

const HIGH = 256_000;
const LOW = 64_000;
const WATCHDOG_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeWebContents() {
  const wc = {
    sent: [],
    destroyed: false,
    send(channel, payload) {
      wc.sent.push({ channel, payload });
    },
    isDestroyed() {
      return wc.destroyed;
    },
  };
  return wc;
}

function sentBytes(wc, channel) {
  return wc.sent
    .filter((m) => m.channel === channel && m.payload instanceof Uint8Array)
    .reduce((n, m) => n + m.payload.byteLength, 0);
}

async function main() {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(CACHE_ROOT, "pty-render-backpressure-"));
  const outfile = path.join(tmp, "pty-manager.bundle.cjs");
  try {
    await esbuild.build({
      entryPoints: [MODULE_TS],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      plugins: [stubPlugin()],
      logLevel: "silent",
    });
    const controller = createController();
    globalThis.__codaraPtySpawnHarness = controller;
    const pty = require(outfile);

    const wc = fakeWebContents();
    const id = "bp-local";
    await pty.spawn({ ...localOptions(id), webContents: wc });
    const call = controller.localSpawnCalls.find((c) => c.exe === "pwsh-test");
    assert.ok(call, "local pty spawned");
    const handle = call.handle;
    const channel = `pty:data:${id}`;
    const chunk = Buffer.alloc(4096, 0x61);
    const flood = (bytes) => {
      for (let sent = 0; sent < bytes; sent += chunk.length) handle.emit(chunk);
    };

    // 1. A renderer that never acks is never throttled.
    flood(HIGH * 4);
    await sleep(40);
    assert.equal(handle.pauseCalls, 0, "no ack seen: the pty must never be paused");
    assert.deepEqual(pty.flowState(id), { holds: [], unackedBytes: 0 });
    assert.ok(sentBytes(wc, channel) >= HIGH * 4, "everything was shipped to the renderer");
    console.log("PASS a renderer that never acks is never throttled");

    // 2. First ack switches accounting on; the high mark pauses the child.
    pty.ackRenderBytes(id, 1);
    wc.sent.length = 0;
    flood(HIGH + 8192);
    await sleep(40);
    assert.equal(handle.pauseCalls, 1, "the high mark pauses the pty once");
    assert.equal(handle.paused, true);
    const held = pty.flowState(id);
    assert.deepEqual(held.holds, ["render"]);
    assert.ok(held.unackedBytes >= HIGH, `unacked ${held.unackedBytes} >= ${HIGH}`);
    console.log("PASS the high mark pauses the child at the OS level");

    // 3. Acks above the low mark keep it paused; crossing it resumes.
    pty.ackRenderBytes(id, held.unackedBytes - LOW - 1);
    assert.equal(handle.resumeCalls, 0, "still above the low mark: no resume");
    pty.ackRenderBytes(id, 2);
    assert.equal(handle.resumeCalls, 1, "crossing the low mark resumes the pty");
    assert.equal(handle.paused, false);
    assert.deepEqual(pty.flowState(id).holds, []);
    console.log("PASS draining to the low mark resumes the child");

    // 4. A remote hold and a render hold never undo each other.
    assert.equal(pty.pauseFlow(id), true);
    assert.equal(handle.pauseCalls, 2);
    flood(HIGH + 8192);
    await sleep(40);
    assert.equal(handle.pauseCalls, 2, "already paused by remote: no second OS pause");
    assert.deepEqual(pty.flowState(id).holds.sort(), ["remote", "render"]);
    pty.ackRenderBytes(id, HIGH * 2);
    assert.equal(handle.resumeCalls, 1, "remote hold still present: no resume");
    assert.deepEqual(pty.flowState(id).holds, ["remote"]);
    assert.equal(pty.resumeFlow(id), true);
    assert.equal(handle.resumeCalls, 2, "last hold released: the pty resumes");
    assert.equal(pty.resumeFlow(id), true);
    assert.equal(handle.resumeCalls, 2, "a repeated release is a no-op");
    console.log("PASS remote and render holds are independent and the last release resumes");

    // 5. Watchdog: no ack progress releases the hold and disables accounting.
    flood(HIGH + 8192);
    await sleep(40);
    assert.equal(handle.paused, true);
    await sleep(WATCHDOG_MS + 200);
    assert.equal(handle.paused, false, "watchdog released the hold");
    assert.deepEqual(pty.flowState(id), { holds: [], unackedBytes: 0 });
    flood(HIGH * 2);
    await sleep(40);
    assert.equal(handle.paused, false, "accounting is off until the renderer acks again");
    console.log("PASS a silent renderer never freezes the child");

    // 6. Progress keeps the watchdog patient.
    pty.ackRenderBytes(id, 1);
    flood(HIGH + 8192);
    await sleep(40);
    assert.equal(handle.paused, true);
    await sleep(WATCHDOG_MS / 2);
    pty.ackRenderBytes(id, 1000);
    await sleep(WATCHDOG_MS / 2 + 200);
    assert.equal(handle.paused, true, "an ack within the window re-arms instead of releasing");
    pty.ackRenderBytes(id, HIGH * 2);
    assert.equal(handle.paused, false);
    console.log("PASS ack progress re-arms the watchdog");

    // 7. Workspace switch (pause) drops the hold and the accounting.
    flood(HIGH + 8192);
    await sleep(40);
    assert.equal(handle.paused, true);
    pty.pause(id);
    assert.equal(handle.paused, false, "detaching the renderer releases the render hold");
    assert.deepEqual(pty.flowState(id), { holds: [], unackedBytes: 0 });
    flood(HIGH * 2);
    pty.resume(id);
    await sleep(40);
    assert.equal(handle.paused, false, "the backlog replay is not counted before the next ack");
    console.log("PASS pause/resume clears the accounting and never leaves a hold behind");

    // 8. Teardown while held never leaves the child paused.
    pty.ackRenderBytes(id, 1);
    flood(HIGH + 8192);
    await sleep(40);
    assert.equal(handle.paused, true);
    pty.detach(id);
    assert.equal(handle.paused, false, "detach releases the render hold");
    pty.disposeAll();
    await nextTurn();
    console.log("PASS detach releases the hold");

    console.log("\nPASS pty render backpressure");
  } finally {
    delete globalThis.__codaraPtySpawnHarness;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
