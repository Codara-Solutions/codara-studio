"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const source = fs.readFileSync(require.resolve("../src/main/orchestration/pi-worker-compaction.ts"), "utf8");
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: exportsObject });
const usageExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve("../src/main/orchestration/pi-worker-usage.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: usageExports });
for (const [type, key] of [["message_end", "message"], ["compaction_end", "result"]]) {
  const usage = usageExports.piWorkerMessageUsage({ type, [key]: { usage: { input: 50, output: 10, cacheRead: 100, cacheWrite: 30, cost: { total: 0.25 } } } });
  assert.equal(usage.input + usage.output + usage.cacheRead + usage.cacheWrite, 190);
  assert.equal(usage.cost, 0.25);
}
assert.equal(usageExports.piWorkerMessageUsage({ type: "compaction_end", aborted: true }), null);
const runStore = fs.readFileSync(require.resolve("../src/main/orchestration/run-store.ts"), "utf8");
assert.match(runStore, /event.type === "message_end" \|\| event.type === "compaction_end"/);
const { PiWorkerCompaction } = exportsObject;
const pause = { type: "entry_appended", entry: { type: "custom", customType: "codara-context-pause", data: { reason: "threshold" } } };
const settled = { type: "agent_settled" };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness() {
  const calls = [], errors = [];
  let finish, reject, interrupted = false;
  const coordinator = new PiWorkerCompaction({
    request(command) { calls.push(command.type); return new Promise((resolve, fail) => { finish = resolve; reject = fail; }); },
    async prompt(message) { calls.push("prompt"); assert.match(message, /do not repeat successful actions/); },
  }, { interrupted: () => interrupted, onError: (error) => errors.push(error.message) });
  return { coordinator, calls, errors, finish: () => finish({}), reject: () => reject(new Error("summary failed")), interrupt: () => { interrupted = true; } };
}
(async () => {
  const h = harness();
  assert.equal(h.coordinator.consume(settled), false);
  h.coordinator.consume(pause);
  assert.deepEqual(h.calls, [], "a pause marker cannot compact while tools are still active");
  assert.equal(h.coordinator.consume(settled), true);
  assert.deepEqual(h.calls, ["compact"]);
  assert.equal(h.coordinator.consume(settled), true, "duplicate settlements cannot finish the outer task during compaction");
  h.finish(); await tick();
  assert.deepEqual(h.calls, ["compact", "prompt"]);
  assert.equal(h.coordinator.consume(settled), false, "the resumed task may settle normally");
  h.coordinator.consume(pause); h.coordinator.consume(settled); h.finish(); await tick();
  assert.deepEqual(h.calls, ["compact", "prompt", "compact", "prompt"], "later context pressure may compact again");
  for (const method of ["interrupt", "dispose", "reject"]) {
    const h = harness(); h.coordinator.consume(pause); h.coordinator.consume(settled);
    if (method === "interrupt") h.interrupt();
    if (method === "dispose") h.coordinator.dispose();
    if (method === "reject") h.reject(); else h.finish();
    await tick();
    assert.deepEqual(h.calls, ["compact"], `${method} must prevent continuation`);
    assert.equal(h.errors.length, method === "dispose" ? 0 : 1);
  }
  const h2 = harness(); h2.interrupt(); h2.coordinator.consume(pause); h2.coordinator.consume(settled); await tick();
  assert.deepEqual(h2.calls, [], "a cancelled task cannot start compaction");
  console.log("Pi worker pause/compact/resume lifecycle passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
