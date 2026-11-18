#!/usr/bin/env node
// CI runs the macOS pool on three machines, one suite at a time on each
// (CODARA_TEST_SHARD=1/3 to 3/3). Between them the shards must run every
// suite exactly once, agree on the split without sharing any state, balance the
// known slow suites' seconds, and refuse a malformed setting instead of silently
// running nothing.
//
//   node scripts/test-run-all-tests-shard.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const { selectShard, shardFromEnv, listTests, selectPart, SLOW_POOL_SUITES } = require("./run-all-tests.cjs");

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}`);
    console.log(error && error.stack ? error.stack : String(error));
  }
}

check("unset means no sharding", () => {
  assert.equal(shardFromEnv({}), null);
  const tests = ["test-b.cjs", "test-a.cjs"];
  assert.deepEqual(selectShard(tests, null), tests);
});

check("k/n is read as a zero-based index", () => {
  assert.deepEqual(shardFromEnv({ CODARA_TEST_SHARD: "1/2" }), { index: 0, count: 2 });
  assert.deepEqual(shardFromEnv({ CODARA_TEST_SHARD: " 2/2 " }), { index: 1, count: 2 });
});

check("a malformed shard is refused", () => {
  for (const raw of ["0/2", "3/2", "1/0", "2", "a/b", "1/2/3"]) {
    assert.throws(() => shardFromEnv({ CODARA_TEST_SHARD: raw }), /CODARA_TEST_SHARD must be/, raw);
  }
});

check("the shards of this repo's pool cover every suite exactly once", () => {
  const pool = selectPart(listTests(null), "pool");
  for (const count of [2, 3]) {
    const shards = Array.from({ length: count }, (_, index) => selectShard(pool, { index, count }));
    const seen = shards.flat();
    assert.equal(seen.length, pool.length);
    assert.deepEqual([...seen].sort(), [...pool].sort());
  }
});

check("the split does not depend on the order the suites come in", () => {
  const tests = ["test-c.cjs", "test-a.cjs", "test-d.cjs", "test-b.cjs"];
  assert.deepEqual(selectShard(tests, { index: 0, count: 2 }, {}), ["test-a.cjs", "test-c.cjs"]);
  assert.deepEqual(selectShard([...tests].reverse(), { index: 0, count: 2 }, {}), ["test-a.cjs", "test-c.cjs"]);
});

check("each slow suite goes to the lightest shard, then the rest by name", () => {
  const tests = ["test-a.cjs", "test-b.cjs", "test-c.cjs", "test-big.cjs", "test-mid1.cjs", "test-mid2.cjs"];
  const slow = { "test-big.cjs": 100, "test-mid1.cjs": 60, "test-mid2.cjs": 50 };
  // big -> 1 (100/0); mid1 -> 2 (100/60); mid2 -> 2 (100/110); the rest start on 1.
  assert.deepEqual(selectShard(tests, { index: 0, count: 2 }, slow), ["test-a.cjs", "test-big.cjs", "test-c.cjs"]);
  assert.deepEqual(selectShard(tests, { index: 1, count: 2 }, slow), ["test-b.cjs", "test-mid1.cjs", "test-mid2.cjs"]);
});

check("every listed slow suite is a pool suite of this repo", () => {
  const pool = selectPart(listTests(null), "pool");
  for (const name of Object.keys(SLOW_POOL_SUITES)) {
    assert.ok(pool.includes(name), `${name} is in SLOW_POOL_SUITES but not in the pool: rename or remove it there`);
  }
});

check("CI's shards get about the same listed seconds", () => {
  // As many shards as the workflow's matrix runs, so the two cannot drift.
  const ci = yaml.load(fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8"));
  const count = ci.jobs["test-pool"].strategy.matrix.shard.length;
  const pool = selectPart(listTests(null), "pool");
  const seconds = Array.from({ length: count }, (_, index) =>
    selectShard(pool, { index, count }).reduce((sum, f) => sum + (SLOW_POOL_SUITES[f] || 0), 0),
  );
  const total = seconds.reduce((a, b) => a + b, 0);
  // Within a fifth of one shard's fair share, whatever the shard count.
  assert.ok(Math.max(...seconds) - Math.min(...seconds) <= (total / count) * 0.2, `listed seconds per shard: ${seconds}`);
});

if (failed > 0) process.exit(1);
console.log("run-all-tests shards: all passed");
