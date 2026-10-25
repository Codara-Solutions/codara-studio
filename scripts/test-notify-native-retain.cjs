#!/usr/bin/env node
"use strict";

// Unit tests for the native-notification retainer
// (src/main/notify/native-retain.ts): a shown notification stays reachable
// until it is clicked, fails or is closed (a Windows toast that timed out into
// the Action Center stays), the cap withdraws the oldest from the OS, and a
// held notification survives a full garbage collection while a released one
// does not.
//
//   node scripts/test-notify-native-retain.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const v8 = require("node:v8");
const vm = require("node:vm");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load(entry) {
  const out = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

class FakeNotification {
  constructor(name) {
    this.name = name;
    this.listeners = new Map();
    this.closed = 0;
  }
  on(event, listener) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  emit(event, ...args) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  close() {
    this.closed += 1;
  }
}

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");
// A WeakRef target stays alive until the job that created or read it ends.
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
async function collect() {
  await nextTurn();
  gc();
  await nextTurn();
  gc();
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

let M;

test("a click releases the notification and routes once", () => {
  const retainer = M.createNotificationRetainer({ platform: "linux" });
  const n = new FakeNotification("a");
  let clicks = 0;
  retainer.hold(n, () => (clicks += 1));
  assert.deepEqual(retainer.held(), [n]);
  n.emit("click");
  assert.equal(clicks, 1);
  assert.deepEqual(retainer.held(), []);
});

test("closing or failing releases it", () => {
  const retainer = M.createNotificationRetainer({ platform: "linux" });
  const closed = new FakeNotification("closed");
  const failed = new FakeNotification("failed");
  retainer.hold(closed, () => {});
  retainer.hold(failed, () => {});
  closed.emit("close", {});
  failed.emit("failed", {}, "no daemon");
  assert.deepEqual(retainer.held(), []);
});

test("a Windows toast that timed out stays clickable from the Action Center", () => {
  const retainer = M.createNotificationRetainer({ platform: "win32" });
  const timedOut = new FakeNotification("timed out");
  const dismissed = new FakeNotification("dismissed");
  let clicks = 0;
  retainer.hold(timedOut, () => (clicks += 1));
  retainer.hold(dismissed, () => {});
  timedOut.emit("close", { reason: "timedOut" });
  dismissed.emit("close", { reason: "userCanceled" });
  assert.deepEqual(retainer.held(), [timedOut]);
  timedOut.emit("click");
  assert.equal(clicks, 1);
  assert.deepEqual(retainer.held(), []);
});

test("elsewhere a timed-out close is still a close", () => {
  const retainer = M.createNotificationRetainer({ platform: "darwin" });
  const n = new FakeNotification("mac");
  retainer.hold(n, () => {});
  n.emit("close", { reason: "timedOut" });
  assert.deepEqual(retainer.held(), []);
});

test("past the cap the oldest are withdrawn from the OS", () => {
  const retainer = M.createNotificationRetainer({ cap: 3, platform: "linux" });
  const all = Array.from({ length: 5 }, (_, i) => new FakeNotification(`n${i}`));
  for (const n of all) retainer.hold(n, () => {});
  assert.deepEqual(
    retainer.held().map((n) => n.name),
    ["n2", "n3", "n4"],
  );
  assert.deepEqual(
    all.map((n) => n.closed),
    [1, 1, 0, 0, 0],
  );
});

test("the default cap bounds a long session", () => {
  const retainer = M.createNotificationRetainer({ platform: "linux" });
  for (let i = 0; i < M.NATIVE_NOTIFICATION_CAP + 20; i += 1) retainer.hold(new FakeNotification(`n${i}`), () => {});
  assert.equal(retainer.held().length, M.NATIVE_NOTIFICATION_CAP);
});

test("a held notification survives garbage collection, a released one does not", async () => {
  const retainer = M.createNotificationRetainer({ platform: "linux" });
  let clicked = false;
  const refs = (() => {
    const kept = new FakeNotification("kept");
    const loose = new FakeNotification("loose");
    retainer.hold(kept, () => (clicked = true));
    return { kept: new WeakRef(kept), loose: new WeakRef(loose) };
  })();
  await collect();
  assert.equal(refs.loose.deref(), undefined, "an unheld notification is collected");
  (() => {
    const kept = refs.kept.deref();
    assert.ok(kept, "the held notification is still alive");
    kept.emit("click");
  })();
  assert.equal(clicked, true, "its click still routes");
  await collect();
  assert.equal(refs.kept.deref(), undefined, "once clicked it is let go");
});

(async () => {
  M = await load(path.join(ROOT, "src", "main", "notify", "native-retain.ts"));
  for (const { name, fn } of tests) {
    await fn();
    console.log(`  PASS ${name}`);
  }
  console.log(`notify-native-retain: ${tests.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
