#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(
  ROOT,
  "src",
  "main",
  "remote-access",
  "worker-terminal-controls.ts",
);

async function loadRegistry() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codara-worker-controls-"),
  );
  const outfile = path.join(temporaryRoot, "worker-terminal-controls.cjs");
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  return require(outfile);
}

function fakeHandle() {
  return {
    writes: [],
    throwAfterWrite: false,
    write(data) {
      this.writes.push(data);
      if (this.throwAfterWrite) throw new Error("ambiguous adapter failure");
    },
    resize() {},
    close() {},
  };
}

function expectCode(action, code) {
  let thrown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `expected ${code}`);
  assert.equal(thrown.code, code);
  return thrown;
}

async function main() {
  const { WorkerTerminalControlRegistry } = await loadRegistry();
  let passed = 0;
  const test = (name, fn) => {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  test("same authenticated session renews one opaque lease", () => {
    const registry = new WorkerTerminalControlRegistry();
    try {
      const first = registry.acquire("phone-a", "socket-a", "worker-a");
      const renewed = registry.acquire("phone-a", "socket-a", "worker-a");
      assert.equal(renewed.controlLeaseId, first.controlLeaseId);
      assert.equal(renewed.nextInputSequence, 1);
      assert.ok(renewed.expiresAt >= first.expiresAt);
    } finally {
      registry.shutdown();
    }
  });

  test("a second phone or socket cannot take an active worker", () => {
    const registry = new WorkerTerminalControlRegistry();
    try {
      registry.acquire("phone-a", "socket-a", "worker-a");
      expectCode(
        () => registry.acquire("phone-b", "socket-b", "worker-a"),
        "WORKER_TERMINAL_CONTROL_BUSY",
      );
      expectCode(
        () => registry.acquire("phone-a", "socket-new", "worker-a"),
        "WORKER_TERMINAL_CONTROL_BUSY",
      );
    } finally {
      registry.shutdown();
    }
  });

  test("input sequence retries are exactly once and changed data conflicts", () => {
    const registry = new WorkerTerminalControlRegistry();
    const handle = fakeHandle();
    try {
      const lease = registry.acquire("phone-a", "socket-a", "worker-a");
      const accepted = registry.write(
        "phone-a",
        "socket-a",
        "worker-a",
        lease.controlLeaseId,
        1,
        "inspect\r",
        handle,
      );
      assert.equal(accepted.nextInputSequence, 2);
      registry.write(
        "phone-a",
        "socket-a",
        "worker-a",
        lease.controlLeaseId,
        1,
        "inspect\r",
        handle,
      );
      assert.deepEqual(handle.writes, ["inspect\r"]);
      expectCode(
        () =>
          registry.write(
            "phone-a",
            "socket-a",
            "worker-a",
            lease.controlLeaseId,
            1,
            "different\r",
            handle,
          ),
        "WORKER_TERMINAL_INPUT_CONFLICT",
      );
      expectCode(
        () =>
          registry.write(
            "phone-a",
            "socket-a",
            "worker-a",
            lease.controlLeaseId,
            3,
            "gap\r",
            handle,
          ),
        "WORKER_TERMINAL_INPUT_GAP",
      );
    } finally {
      registry.shutdown();
    }
  });

  test("deliver-then-throw is sticky outcome-unknown and never duplicates", () => {
    const registry = new WorkerTerminalControlRegistry();
    const handle = fakeHandle();
    handle.throwAfterWrite = true;
    try {
      const lease = registry.acquire("phone-a", "socket-a", "worker-a");
      expectCode(
        () =>
          registry.write(
            "phone-a",
            "socket-a",
            "worker-a",
            lease.controlLeaseId,
            1,
            "ambiguous\r",
            handle,
          ),
        "WORKER_TERMINAL_INPUT_OUTCOME_UNKNOWN",
      );
      expectCode(
        () =>
          registry.write(
            "phone-a",
            "socket-a",
            "worker-a",
            lease.controlLeaseId,
            1,
            "ambiguous\r",
            handle,
          ),
        "WORKER_TERMINAL_INPUT_OUTCOME_UNKNOWN",
      );
      assert.deepEqual(handle.writes, ["ambiguous\r"]);
    } finally {
      registry.shutdown();
    }
  });

  test("expiry, disconnect and revocation fence later writes", () => {
    let now = 1_000;
    const registry = new WorkerTerminalControlRegistry({
      now: () => now,
      ttlMs: 100,
    });
    const handle = fakeHandle();
    try {
      const expired = registry.acquire("phone-a", "socket-a", "worker-a");
      now = 1_101;
      expectCode(
        () =>
          registry.write(
            "phone-a",
            "socket-a",
            "worker-a",
            expired.controlLeaseId,
            1,
            "late",
            handle,
          ),
        "WORKER_TERMINAL_CONTROL_LOST",
      );

      const disconnected = registry.acquire(
        "phone-a",
        "socket-a",
        "worker-a",
      );
      registry.releaseHolder("socket-a");
      expectCode(
        () =>
          registry.write(
            "phone-a",
            "socket-a",
            "worker-a",
            disconnected.controlLeaseId,
            1,
            "late",
            handle,
          ),
        "WORKER_TERMINAL_CONTROL_LOST",
      );

      const revoked = registry.acquire("phone-a", "socket-b", "worker-a");
      registry.revokeOwner("phone-a");
      expectCode(
        () =>
          registry.write(
            "phone-a",
            "socket-b",
            "worker-a",
            revoked.controlLeaseId,
            1,
            "late",
            handle,
          ),
        "WORKER_TERMINAL_CONTROL_LOST",
      );
      assert.deepEqual(handle.writes, []);
    } finally {
      registry.shutdown();
    }
  });

  console.log(`\n${passed} worker terminal control tests passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
