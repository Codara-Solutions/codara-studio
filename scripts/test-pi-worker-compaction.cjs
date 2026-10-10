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
  const calls = [], errors = [], prompts = [];
  let contract = "Use only read and write. Exact marker: original-42.";
  let finish, reject, interrupted = false;
  const coordinator = new PiWorkerCompaction({
    request(command) { calls.push(command.type); return new Promise((resolve, fail) => { finish = resolve; reject = fail; }); },
    async prompt(message) { calls.push("prompt"); prompts.push(message); assert.match(message, /do not repeat successful actions/); },
  }, { taskContract: () => contract, interrupted: () => interrupted, onError: (error) => errors.push(error.message) });
  return { coordinator, calls, errors, prompts, steer: () => { contract += "\nLater steering: use marker corrected-99."; }, finish: () => finish({}), reject: () => reject(new Error("summary failed")), interrupt: () => { interrupted = true; } };
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
  assert.ok(h.prompts[0].includes("Use only read and write. Exact marker: original-42."));
  h.steer();
  h.coordinator.consume(pause); h.coordinator.consume(settled); h.finish(); await tick();
  assert.ok(h.prompts[1].includes("Later steering: use marker corrected-99."), "each resume retains the newest steering verbatim");
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

  // The worker's persisted scratchpad rides the continuation prompt.
  {
    const prompts = [];
    let finish;
    const withNotes = new PiWorkerCompaction({
      request() { return new Promise((resolve) => { finish = resolve; }); },
      async prompt(message) { prompts.push(message); },
    }, {
      taskContract: () => "contract",
      scratchpad: async () => "objective: ship\nnext: run npm test",
      interrupted: () => false,
      onError: () => {},
    });
    withNotes.consume(pause); withNotes.consume(settled); finish({}); await tick(); await tick();
    assert.match(prompts[0], /Your scratchpad note from before compaction:\nobjective: ship\nnext: run npm test/);
    const failing = new PiWorkerCompaction({
      request() { return new Promise((resolve) => { finish = resolve; }); },
      async prompt(message) { prompts.push(message); },
    }, {
      scratchpad: async () => { throw new Error("gone"); },
      interrupted: () => false,
      onError: (error) => { throw error; },
    });
    failing.consume(pause); failing.consume(settled); finish({}); await tick(); await tick();
    assert.doesNotMatch(prompts[1], /scratchpad/, "an unreadable scratchpad only drops the hint");
  }

  // The contract sections the continuation re-sends come verbatim from the
  // original prompt, report first.
  {
    const sectionsExports = {};
    vm.runInNewContext(
      ts.transpileModule(
        fs.readFileSync(require.resolve("../src/main/orchestration/worker-contract-sections.ts"), "utf8"),
        { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
      ).outputText,
      { exports: sectionsExports },
    );
    const prompt = [
      "# Worker task",
      "## TASK",
      "Fix the parser.",
      "## ACCEPTANCE",
      "- parse(\"1+2\") returns 3",
      "## WEB RESEARCH",
      "Use web_search.",
      "## VERIFICATION COMMANDS",
      "- npm test",
      "## FINAL REPORT (mandatory)",
      "Write /runs/a/final-report.json with keys status, summary, filesChanged, proof.",
    ].join("\n");
    const contract = sectionsExports.workerContractSections(prompt);
    assert.ok(contract.startsWith("## FINAL REPORT (mandatory)\nWrite /runs/a/final-report.json"), contract);
    assert.match(contract, /## ACCEPTANCE\n- parse\("1\+2"\) returns 3/);
    assert.match(contract, /## VERIFICATION COMMANDS\n- npm test/);
    assert.doesNotMatch(contract, /WEB RESEARCH|## TASK/);
    assert.match(sectionsExports.workerReportSection(prompt), /^## FINAL REPORT \(mandatory\)\nWrite \/runs\/a\/final-report\.json/);
    const capped = sectionsExports.workerContractSections(prompt, 120);
    assert.ok(capped.length <= 120 && capped.includes("FINAL REPORT"), "the cap keeps the report section first");
    assert.match(runStore, /workerContractSections\(promptText\)/);
    assert.match(runStore, /plan\.env\.CODARA_PI_SCRATCHPAD_PATH = scratchpadPath/);
  }
  console.log("Pi worker pause/compact/resume lifecycle passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
