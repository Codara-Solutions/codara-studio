#!/usr/bin/env node
// CI runs the macOS pool on two machines, one suite at a time on each
// (CODARA_TEST_SHARD=1/2 and 2/2). Between them the shards must run every
// suite exactly once, agree on the split without sharing any state, and
// refuse a malformed setting instead of silently running nothing.
//
//   node scripts/test-run-all-tests-shard.cjs
const assert = require("node:assert/strict");
const { selectShard, shardFromEnv, listTests, selectPart } = require("./run-all-tests.cjs");

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
    for (const shard of shards) assert.ok(Math.abs(shard.length - pool.length / count) <= 1, "sizes differ by at most one");
  }
});

check("the split does not depend on the order the suites come in", () => {
  const tests = ["test-c.cjs", "test-a.cjs", "test-d.cjs", "test-b.cjs"];
  assert.deepEqual(selectShard(tests, { index: 0, count: 2 }), ["test-a.cjs", "test-c.cjs"]);
  assert.deepEqual(selectShard([...tests].reverse(), { index: 0, count: 2 }), ["test-a.cjs", "test-c.cjs"]);
});

if (failed > 0) process.exit(1);
console.log("run-all-tests shards: all passed");
