"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

// Loads an orchestration module and the TypeScript siblings it imports, with
// nothing else in scope: the coordinators must stay free of Electron and disk.
function loadTs(file, cache = new Map()) {
  if (cache.has(file)) return cache.get(file);
  const exportsObject = {};
  cache.set(file, exportsObject);
  const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const localRequire = (id) => {
    if (!id.startsWith("./")) throw new Error(`unexpected import ${id} from ${file}`);
    return loadTs(path.join(path.dirname(file), `${id}.ts`), cache);
  };
  vm.runInNewContext(output, { exports: exportsObject, require: localRequire, Error, console: { info() {}, warn() {} } });
  return exportsObject;
}

const orchestration = path.join(__dirname, "..", "src", "main", "orchestration");
const cache = new Map();
const { PiManagerCompaction, MANAGER_CONTINUE } = loadTs(path.join(orchestration, "pi-manager-compaction.ts"), cache);
const pipeline = loadTs(path.join(orchestration, "pi-compaction-pipeline.ts"), cache);

const pauseEvent = (phase, tokens = 300_000) => ({
  type: "entry_appended",
  entry: { type: "custom", customType: "codara-context-pause", data: { reason: "threshold", ...(phase ? { phase } : {}), tokens } },
});
const pause = pauseEvent(undefined);
const settled = { type: "agent_settled" };
// Values built inside the vm realm carry its prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

function harness(pinnedContext) {
  const calls = [], prompts = [], errors = [], reports = [];
  const pending = [];
  let interrupted = false, settlements = 0;
  const coordinator = new PiManagerCompaction({
    request(command) {
      calls.push(command);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    prompt(message) { prompts.push(message); return Promise.resolve(); },
  }, {
    interrupted: () => interrupted,
    onSettled: () => { settlements++; },
    onError: (error) => errors.push(error.message),
    onReport: (report) => reports.push(report),
    ...(pinnedContext ? { pinnedContext } : {}),
  });
  return {
    coordinator, calls, prompts, errors, reports,
    count: () => settlements,
    finish: (result = { tokensBefore: 300_000, estimatedTokensAfter: 30_000 }) => pending.shift().resolve(result),
    reject: (message = "summary failed") => pending.shift().reject(new Error(message)),
    interrupt: () => { interrupted = true; },
  };
}

(async () => {
  // Settled pause: compact after the answer, then release the turn.
  const h = harness();
  assert.equal(h.coordinator.consume(settled), false);
  h.coordinator.consume(pause);
  assert.deepEqual(h.calls, [], "compaction waits for every agent event to settle");
  assert.equal(h.coordinator.consume(settled), true);
  assert.equal(h.coordinator.consume(settled), true, "duplicate settlements wait for the same summary");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].type, "compact");
  assert.equal(h.calls[0].customInstructions, pipeline.CODARA_COMPACTION_INSTRUCTIONS);
  assert.equal(h.count(), 0);
  h.finish(); await tick();
  assert.equal(h.count(), 1);
  assert.deepEqual(h.prompts, [], "a completed manager answer must not be prompted again");
  assert.equal(h.reports[0].outcome, "compacted");
  assert.equal(h.reports[0].phase, "settled");
  assert.equal(h.reports[0].tokensBefore, 300_000);
  assert.equal(h.reports[0].tokensAfter, 30_000);
  assert.equal(pipeline.describeCompaction(h.reports[0]), "Context compacted: 300k -> 30k tokens.");
  assert.equal(h.coordinator.consume(settled), false);
  h.coordinator.consume(pause); h.coordinator.consume(settled); h.finish(); await tick();
  assert.equal(h.count(), 2, "later manager turns may compact too");

  // Native compaction satisfies a settled request.
  for (const result of [{ result: {} }, { aborted: true }, { errorMessage: "native failure" }]) {
    const native = harness(); native.coordinator.consume(pause);
    native.coordinator.consume({ type: "compaction_end", ...result });
    assert.equal(native.coordinator.consume(settled), false);
    assert.deepEqual(native.calls, [], "native compaction must not cause another immediate summary request");
  }
  const cancelled = harness(); cancelled.coordinator.consume(pause); cancelled.interrupt();
  assert.equal(cancelled.coordinator.consume(settled), false);
  assert.deepEqual(cancelled.calls, []);
  const disposed = harness(); disposed.coordinator.consume(pause); disposed.coordinator.consume(settled); disposed.coordinator.dispose(); disposed.finish(); await tick();
  assert.equal(disposed.count(), 0);

  // Failure ladder: the model summary, one shorter retry, then the
  // extension's model-free summary. Only when all three fail is it an error.
  const ladder = harness(); ladder.coordinator.consume(pause); ladder.coordinator.consume(settled);
  ladder.reject("overloaded"); await tick();
  assert.equal(ladder.calls[1].customInstructions, pipeline.CODARA_COMPACTION_RETRY_INSTRUCTIONS);
  ladder.reject("overloaded again"); await tick();
  assert.equal(ladder.calls[2].customInstructions, pipeline.DETERMINISTIC_COMPACTION_MARKER);
  ladder.finish(); await tick();
  assert.equal(ladder.count(), 1);
  assert.deepEqual(ladder.errors, [], "a deterministic compaction is a success");
  assert.equal(ladder.reports[0].mode, "deterministic");
  assert.match(pipeline.describeCompaction(ladder.reports[0]), /without a model summary/);

  const failed = harness(); failed.coordinator.consume(pause); failed.coordinator.consume(settled);
  failed.reject("a"); await tick(); failed.reject("b"); await tick(); failed.reject("summary failed"); await tick();
  assert.equal(failed.calls.length, 3, "the ladder stops after three rungs");
  assert.equal(failed.count(), 1, "failure releases the completed answer to its caller");
  assert.deepEqual(failed.errors, ["deterministic: summary failed"]);
  assert.equal(failed.reports[0].outcome, "failed");

  const nothing = harness(); nothing.coordinator.consume(pause); nothing.coordinator.consume(settled);
  nothing.reject("Already compacted"); await tick();
  assert.equal(nothing.calls.length, 1, "nothing to compact is not a failure to retry");
  assert.deepEqual(nothing.errors, []);
  assert.equal(nothing.count(), 1);

  // Mid-turn pause: compact, then resume the same task with a continuation;
  // the continuation's own settlement is the end of the user's turn.
  const mid = harness();
  mid.coordinator.consume(pauseEvent("mid-turn", 250_000));
  assert.equal(mid.coordinator.holdsTurnOpen(), true, "a mid-turn pause owns the next settlement");
  assert.equal(mid.coordinator.consume(settled), true);
  mid.finish({ tokensBefore: 250_000, estimatedTokensAfter: 40_000 }); await tick();
  assert.deepEqual(mid.prompts, [MANAGER_CONTINUE]);
  assert.match(MANAGER_CONTINUE, /^Continue the user's request from the compacted context/);
  assert.equal(mid.count(), 0, "the resumed turn is still running");
  assert.equal(mid.coordinator.holdsTurnOpen(), false);
  assert.equal(mid.coordinator.consume(settled), false, "the continuation's settlement goes to the caller");
  assert.equal(pipeline.describeCompaction(mid.reports[0]), "Context compacted mid-task: 250k -> 40k tokens.");

  const midFailed = harness();
  midFailed.coordinator.consume(pauseEvent("mid-turn"));
  midFailed.coordinator.consume(settled);
  midFailed.reject(); await tick(); midFailed.reject(); await tick(); midFailed.reject(); await tick();
  assert.deepEqual(midFailed.prompts, [MANAGER_CONTINUE], "a failed compaction still resumes the task");
  assert.deepEqual(midFailed.errors, []);
  assert.equal(midFailed.reports[0].outcome, "failed");

  // Pi's own mid-turn compaction already folded the context: resume without
  // another summary.
  const nativeMid = harness();
  nativeMid.coordinator.consume(pauseEvent("mid-turn"));
  nativeMid.coordinator.consume({ type: "compaction_end", result: { tokensBefore: 1, estimatedTokensAfter: 1 } });
  nativeMid.coordinator.consume(settled); await tick();
  assert.deepEqual(nativeMid.calls, []);
  assert.deepEqual(nativeMid.prompts, [MANAGER_CONTINUE]);

  // The summary leaves the memory sections out, so a turn resumed mid-task
  // carries a fresh copy; one that did not compact still has them.
  const MEMORY = "CORA MEMORY, GLOBAL (file)\n- Answer in Spanish.\n[END CORA MEMORY GLOBAL]";
  const pinned = harness(async () => `${MEMORY}\n`);
  pinned.coordinator.consume(pauseEvent("mid-turn"));
  pinned.coordinator.consume(settled);
  pinned.finish(); await tick();
  assert.deepEqual(pinned.prompts, [`${MANAGER_CONTINUE}\n\n${MEMORY}`]);
  const pinnedNative = harness(async () => MEMORY);
  pinnedNative.coordinator.consume(pauseEvent("mid-turn"));
  pinnedNative.coordinator.consume({ type: "compaction_end", result: {} });
  pinnedNative.coordinator.consume(settled); await tick();
  assert.deepEqual(pinnedNative.prompts, [`${MANAGER_CONTINUE}\n\n${MEMORY}`]);
  const pinnedFailed = harness(async () => MEMORY);
  pinnedFailed.coordinator.consume(pauseEvent("mid-turn"));
  pinnedFailed.coordinator.consume(settled);
  pinnedFailed.reject(); await tick(); pinnedFailed.reject(); await tick(); pinnedFailed.reject(); await tick();
  assert.deepEqual(pinnedFailed.prompts, [MANAGER_CONTINUE], "an uncompacted context still holds the memory");
  const pinnedBroken = harness(async () => { throw new Error("memory unreadable"); });
  pinnedBroken.coordinator.consume(pauseEvent("mid-turn"));
  pinnedBroken.coordinator.consume(settled);
  pinnedBroken.finish(); await tick();
  assert.deepEqual(pinnedBroken.prompts, [MANAGER_CONTINUE], "a memory read failure never costs the turn");
  assert.deepEqual(pinnedBroken.errors, []);
  assert.match(pipeline.CODARA_COMPACTION_INSTRUCTIONS, /Leave the CORA PROFILE, CORA MEMORY and CORA LEARNED MEMORY sections out/);

  // Interrupts stop the ladder between rungs.
  let live = true;
  const outcome = pipeline.compactWithRecovery(
    { request: () => { live = false; return Promise.reject(new Error("boom")); } },
    { current: () => live },
  );
  assert.deepEqual(plain((await outcome).errors), ["model: boom", "interrupted"]);

  assert.equal(pipeline.contextPause({ type: "agent_settled" }), null);
  assert.deepEqual(plain(pipeline.contextPause(pauseEvent("mid-turn", 12))), { phase: "mid-turn", tokens: 12 });
  assert.deepEqual(plain(pipeline.contextPause(pauseEvent(undefined, 0))), { phase: null, tokens: null });
  console.log("Pi manager settlement compaction lifecycle passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
