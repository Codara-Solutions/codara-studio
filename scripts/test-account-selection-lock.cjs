#!/usr/bin/env node
"use strict";

// The account selection lock (account-selection-lock.ts) serializes every
// change of a CLI's live login, inside one process and across two Codara
// builds running side by side. Two separately loaded copies of the module
// stand in for two processes: they share nothing but the lock file.
//
//   node scripts/test-account-selection-lock.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-selection-lock-"));

async function loadCopy() {
  const output = await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "account-selection-lock.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    packages: "external",
    write: false,
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const [first, second] = await Promise.all([loadCopy(), loadCopy()]);
  const rootDir = path.join(TMP, "claude-cli");
  const order = [];
  const holder = (copy, name, ms) =>
    copy.withAccountSelectionLock(rootDir, async () => {
      order.push(`${name}:start`);
      await sleep(ms);
      order.push(`${name}:end`);
      return name;
    });

  // Two processes: the second waits for the first to finish.
  const results = await Promise.all([holder(first, "a", 150), sleep(20).then(() => holder(second, "b", 10))]);
  assert.deepEqual(results, ["a", "b"]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
  assert.equal(fs.existsSync(path.join(rootDir, ".selection.lock")), false, "the lock is released");

  // One process: callers queue in order, and a failure releases the lock.
  order.length = 0;
  await assert.rejects(
    first.withAccountSelectionLock(rootDir, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  await Promise.all([holder(first, "c", 30), holder(first, "d", 0)]);
  assert.deepEqual(order, ["c:start", "c:end", "d:start", "d:end"]);

  // A lock left by a crashed process goes stale and is taken over.
  fs.mkdirSync(path.join(rootDir, ".selection.lock"));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(rootDir, ".selection.lock"), old, old);
  assert.equal(await holder(second, "e", 0), "e");

  console.log("PASS account selection lock: in-process order, across processes, stale takeover");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
