"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const source = fs.readFileSync(require.resolve("../src/main/orchestration/pi-manager-compaction.ts"), "utf8");
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: exportsObject, Error });
const { PiManagerCompaction } = exportsObject;
const pause = { type: "entry_appended", entry: { type: "custom", customType: "codara-context-pause", data: { reason: "threshold" } } };
const settled = { type: "agent_settled" };
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const calls = [], errors = [];
  let finish, reject, interrupted = false, settlements = 0;
  const coordinator = new PiManagerCompaction({
    request(command) { calls.push(command.type); return new Promise((resolve, fail) => { finish = resolve; reject = fail; }); },
  }, { interrupted: () => interrupted, onSettled: () => { settlements++; }, onError: error => errors.push(error.message) });
  return { coordinator, calls, errors, count: () => settlements, finish: () => finish({}), reject: () => reject(new Error("summary failed")), interrupt: () => { interrupted = true; } };
}
(async () => {
  const h = harness();
  assert.equal(h.coordinator.consume(settled), false);
  h.coordinator.consume(pause);
  assert.deepEqual(h.calls, [], "compaction waits for every agent event to settle");
  assert.equal(h.coordinator.consume(settled), true);
  assert.equal(h.coordinator.consume(settled), true, "duplicate settlements wait for the same summary");
  assert.deepEqual(h.calls, ["compact"]);
  assert.equal(h.count(), 0);
  h.finish(); await tick();
  assert.equal(h.count(), 1);
  assert.equal(h.coordinator.consume(settled), false);
  assert.deepEqual(h.calls, ["compact"], "a completed manager answer must not be prompted again");
  h.coordinator.consume(pause); h.coordinator.consume(settled); h.finish(); await tick();
  assert.equal(h.count(), 2, "later manager turns may compact too");
  for (const result of [{result:{}}, {aborted:true}, {errorMessage:"native failure"}]) {
    const native = harness(); native.coordinator.consume(pause);
    native.coordinator.consume({type:"compaction_end",...result});
    assert.equal(native.coordinator.consume(settled), false);
    assert.deepEqual(native.calls, [], "native compaction must not cause another immediate summary request");
  }
  const cancelled = harness(); cancelled.coordinator.consume(pause); cancelled.interrupt();
  assert.equal(cancelled.coordinator.consume(settled), false);
  assert.deepEqual(cancelled.calls, []);
  const disposed = harness(); disposed.coordinator.consume(pause); disposed.coordinator.consume(settled); disposed.coordinator.dispose(); disposed.finish(); await tick();
  assert.equal(disposed.count(), 0);
  const failed = harness(); failed.coordinator.consume(pause); failed.coordinator.consume(settled); failed.reject(); await tick();
  assert.equal(failed.count(), 1, "failure releases the completed answer to its caller");
  assert.deepEqual(failed.errors, ["summary failed"]);
  console.log("Pi manager settlement compaction lifecycle passed");
})().catch(error => {console.error(error);process.exitCode=1;});
