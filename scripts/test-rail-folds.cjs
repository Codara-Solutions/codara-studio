#!/usr/bin/env node
"use strict";

// Unit tests for src/renderer/src/components/rail/railFolds.ts: reading the
// rail's stored fold choices, and carrying over the old agent-summary toggle.
//
//   node scripts/test-rail-folds.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-rail-folds-"));
  const outfile = path.join(temp, "rail-folds.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "renderer", "src", "components", "rail", "railFolds.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  return { mod: require(outfile), cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

function storage(entries) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

const TESTS = [];
function test(name, fn) {
  TESTS.push({ name, fn });
}

test("an unreadable old entry keeps the stored fold choices", ({ mod }) => {
  const store = storage({ "codara.rail.agentLinesOpen": "{not json", "codara.rail.folds": '{"ws-a":false,"merged:ws-a":true}' });
  assert.deepEqual(mod.readFolds(store), { "ws-a": false, "merged:ws-a": true });
});

test("an unreadable folds entry keeps the old open rows", ({ mod }) => {
  const store = storage({ "codara.rail.agentLinesOpen": '["ws-a"]', "codara.rail.folds": "nope" });
  assert.deepEqual(mod.readFolds(store), { "ws-a": true });
});

test("the old entry is carried over once, then removed", ({ mod }) => {
  const store = storage({ "codara.rail.agentLinesOpen": '["ws-a","ws-b"]', "codara.rail.folds": '{"ws-b":false}' });
  assert.deepEqual(mod.readFolds(store), { "ws-a": true, "ws-b": false });
  assert.equal(store.map.has("codara.rail.agentLinesOpen"), false);
  assert.deepEqual(JSON.parse(store.map.get("codara.rail.folds")), { "ws-a": true, "ws-b": false });
  assert.deepEqual(mod.readFolds(store), { "ws-a": true, "ws-b": false });
});

test("storage that throws leaves every family at its default", ({ mod }) => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  assert.deepEqual(mod.readFolds(broken), {});
});

(async () => {
  const { mod, cleanup } = await load();
  let failed = 0;
  for (const { name, fn } of TESTS) {
    try {
      await fn({ mod });
      console.log(`PASS ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL ${name}`);
      console.error(err && err.stack ? err.stack : err);
    }
  }
  cleanup();
  console.log(`\n${TESTS.length - failed}/${TESTS.length} rail-folds tests passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
