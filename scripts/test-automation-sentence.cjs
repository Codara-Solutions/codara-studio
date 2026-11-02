// Pure unit tests for the New automation sentence: what each part of it becomes,
// what stops it being saved, and the next start times beside it.
//
//   node scripts/test-automation-sentence.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const assert = require("node:assert");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const out = path.join(ROOT, "node_modules", ".cache", `automation-sentence-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(ROOT, "src/renderer/src/components/automations/flow/sentence-model.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  alias: { "@shared": path.join(ROOT, "src/shared") },
  logLevel: "silent",
});
const s = require(out);
fs.rmSync(out, { force: true });

const NOW = new Date(2026, 10, 18, 15, 40, 0).getTime(); // Wed Nov 18 2026, 15:40 local
const ctx = { workspaceId: "ws", workspaceName: "sample-repo", cwd: "/tmp/sample-repo" };
const draft = (over = {}) => ({ ...s.emptySentence(), name: "Sample", prompt: "Tidy the readme", ...over });

// When.
assert.deepEqual(s.sentenceTrigger(draft()), { kind: "manual" });
assert.deepEqual(s.sentenceTrigger(draft({ when: "daily", time: "02:00" })), { kind: "cron", expr: "0 2 * * *" });
assert.deepEqual(s.sentenceTrigger(draft({ when: "weekdays", time: "9:30" })), { kind: "cron", expr: "30 9 * * 1-5" });
assert.deepEqual(s.sentenceTrigger(draft({ when: "every", everyMin: "15" })), { kind: "interval", everyMs: 900_000 });
assert.deepEqual(s.sentenceTrigger(draft({ when: "prOpened" })), { kind: "github", events: ["prOpened"] });
assert.deepEqual(s.sentenceTrigger(draft({ when: "ciFailed" })), { kind: "github", events: ["ciFailed"] });
for (const time of ["25:00", "02:60", "2", "", "soon"]) assert.equal(s.sentenceTrigger(draft({ when: "daily", time })), null, time);
for (const everyMin of ["0", "-5", "1.5", "", "x"]) assert.equal(s.sentenceTrigger(draft({ when: "every", everyMin })), null, everyMin);

// Stop.
assert.deepEqual(s.sentenceLoop(draft()), { kind: "once", stop: { budgetUsd: 2 } });
assert.deepEqual(s.sentenceLoop(draft({ budget: "" })), { kind: "once", stop: {} });
assert.deepEqual(s.sentenceLoop(draft({ stop: "agent", maxTries: "9", budget: "5" })), { kind: "agent", stop: { budgetUsd: 5, maxIterations: 9 } });
assert.deepEqual(s.sentenceLoop(draft({ stop: "tests", testCommand: " make test ", maxTries: "" })), {
  kind: "until",
  stop: { budgetUsd: 2, untilTestsPass: true, testCommand: "make test" },
});

// What stops it being saved. A limit goes only when its field is blank.
assert.equal(s.sentenceProblem(draft()), null);
assert.match(s.sentenceProblem(draft({ name: "  " })), /Name the automation/);
assert.match(s.sentenceProblem(draft({ prompt: "" })), /what it should do/);
assert.match(s.sentenceProblem(draft({ when: "daily", time: "26:00" })), /time like 02:00/);
assert.match(s.sentenceProblem(draft({ when: "every", everyMin: "0" })), /how many minutes/);
for (const budget of ["-1", "0", "1e", "two"]) assert.match(s.sentenceProblem(draft({ budget })), /budget must be/, budget);
assert.equal(s.sentenceProblem(draft({ budget: "" })), null, "blank means no budget");
assert.match(s.sentenceProblem(draft({ stop: "agent", maxTries: "1.5" })), /number of tries/);
assert.equal(s.sentenceProblem(draft({ maxTries: "1.5" })), null, "a one-run automation has no tries to get wrong");
assert.match(s.sentenceProblem(draft({ monthlyCap: "1e" })), /monthly cap must be/);
assert.match(s.sentenceProblem(draft({ pauseAfter: "0" })), /Pause after must be/);

// The whole of it, shaped as the flow editor saves one.
{
  const input = s.sentenceToInput(
    draft({ when: "daily", onlyIf: " ./check.sh ", model: "claude-fable-5", monthlyCap: "20", pauseAfter: "3", then: "draftPr" }),
    ctx,
  );
  assert.equal(input.name, "Sample");
  assert.equal(input.enabled, true);
  assert.deepEqual(input.precheck, { command: "./check.sh" });
  assert.deepEqual(input.guard, { monthlyCapUsd: 20, pauseAfterFailures: 3 });
  assert.deepEqual(input.ownBranch, { draftPr: true });
  assert.equal(input.input.cwd, ctx.cwd);
  assert.equal(input.input.initialUserNote, "Tidy the readme");
  assert.equal(input.prompt.template, "Tidy the readme");
  assert.equal(input.worker.model, "claude-fable-5");
  assert.equal(input.graph.nodes.length, 1);
  assert.equal(input.graph.nodes[0].prompt, "Tidy the readme");
  assert.deepEqual(input.graph.entryNodeIds, ["w0"]);
}
{
  const plain = s.sentenceToInput(draft({ onlyIf: "./ignored.sh" }), ctx);
  assert.equal(plain.precheck, undefined, "Run now skips a check, so a by-hand automation has none");
  assert.equal(plain.guard, undefined, "no limits unless asked for");
  assert.equal(plain.ownBranch, undefined, "and it works in the folder, as ever");
  assert.deepEqual(s.sentenceToInput(draft({ then: "branch" }), ctx).ownBranch, { draftPr: false });
  assert.equal(s.sentenceToInput(draft({ when: "daily", time: "nope" }), ctx), null);
}

// Carried over to the flow editor, even half written.
{
  const seed = s.sentenceToSeed(draft({ name: "", prompt: "", when: "daily", time: "nope" }), ctx);
  assert.equal(seed.trigger.kind, "manual");
  assert.equal(seed.name, "");
  assert.equal(seed.state.status, "idle");
  assert.deepEqual(seed.history, []);
}

// Next runs.
assert.deepEqual(
  s.nextStarts({ kind: "cron", expr: "0 2 * * *" }, NOW, 2),
  [new Date(2026, 10, 19, 2, 0, 0).getTime(), new Date(2026, 10, 20, 2, 0, 0).getTime()],
);
assert.deepEqual(s.nextStarts({ kind: "interval", everyMs: 60_000 }, NOW, 2), [NOW + 60_000, NOW + 120_000]);
assert.deepEqual(s.nextStarts({ kind: "manual" }, NOW, 3), []);
assert.deepEqual(s.nextStarts({ kind: "github", events: ["ciFailed"] }, NOW, 3), []);
assert.deepEqual(s.nextStarts(null, NOW, 3), []);
assert.deepEqual(s.nextStarts({ kind: "cron", expr: "not cron" }, NOW, 3), []);

console.log("automation sentence: ok");
