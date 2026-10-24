// Codara's durable compaction ledger (resources/pi-cora/compaction-ledger.ts):
// the state the extension rebuilds from the transcript and re-injects after
// every compaction so it never depends on a summary.
//
//   node scripts/test-compaction-ledger.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const file = path.join(__dirname, "..", "resources", "pi-cora", "compaction-ledger.ts");
const ledgerModule = {};
vm.runInNewContext(
  ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  { exports: ledgerModule },
);
const L = ledgerModule;
// Values built inside the vm realm carry its prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

const user = (text) => ({ role: "user", content: text });
const call = (id, name, args, text) => ({
  role: "assistant",
  content: [...(text ? [{ type: "text", text }] : []), { type: "toolCall", id, name, arguments: args }],
});
const result = (id, name, text, isError = false) => ({
  role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text }],
});

// Codara's own bracketed sections and tails are not the user's words.
assert.equal(
  L.stripCodaraSections([
    "[CORA RUN STATE: Codara's record]",
    "Plan: x",
    "[END CORA RUN STATE]",
    "[NEW USER INPUT FOR THIS TURN]",
    "Ship the ledger. Never touch vendor/.",
    "CORA MEMORY",
    "- remembered thing",
  ].join("\n")),
  "Ship the ledger. Never touch vendor/.",
);

// A turn that carries only the learned block (the core memory was unchanged)
// must not leave it in the ledger as the user's words: a memory the user
// later deletes would outlive the deletion there.
assert.equal(
  L.stripCodaraSections([
    "Rename the export.",
    "",
    "CORA LEARNED MEMORY (learned from this user's earlier chats and runs)",
    "- Always answer in Spanish. [m1]",
    "[END CORA LEARNED MEMORY]",
  ].join("\n")),
  "Rename the export.",
);

const transcript = [
  user("Ship the ledger. Never touch vendor/."),
  call("c1", "read", { path: "src/a.ts" }),
  result("c1", "read", "contents"),
  call("c2", "edit", { path: "src/a.ts" }, "Decision: keep a.ts synchronous."),
  result("c2", "edit", "ok"),
  call("c3", "write", { path: "docs/notes.md" }),
  result("c3", "write", "wrote docs/notes.md"),
  call("c4", "bash", { command: "pnpm test" }),
  result("c4", "bash", "E_TIMEOUT in a.spec.ts\nstack", true),
  call("c5", "codara_plan_update", { goal: "Ship", milestones: [{ title: "Remove adapter", status: "pending" }] }),
  result("c5", "codara_plan_update", "ok"),
  call("c6", "codara_spawn_workers", { tasks: [] }),
  result("c6", "codara_spawn_workers", "Spawned w-1 for: port refunds"),
  user("Continue the original task from the compacted context under the same user constraints."),
];
let ledger = L.updateLedger(null, transcript);
assert.deepEqual(plain(ledger.instructions), ["Ship the ledger. Never touch vendor/."], "continuations are not instructions");
assert.deepEqual(plain(ledger.files.map((f) => [f.path, f.state])), [["src/a.ts", "modified"], ["docs/notes.md", "created"]]);
assert.equal(ledger.errors.length, 1);
assert.equal(ledger.errors[0].fixed, false);
assert.match(ledger.errors[0].error, /E_TIMEOUT in a\.spec\.ts/);
assert.match(ledger.plan, /Remove adapter/);
assert.match(ledger.workers.spawned, /w-1/);
assert.ok(ledger.artifacts.includes("docs/notes.md"), "a created document is an artifact");
assert.ok(ledger.conclusions.some((c) => c.includes("keep a.ts synchronous")));

// The same command succeeding later marks the error fixed.
ledger = L.updateLedger(ledger, [call("c7", "bash", { command: "pnpm test" }), result("c7", "bash", "1 passed")]);
assert.equal(ledger.errors[0].fixed, true);
// A read never downgrades a changed file.
ledger = L.updateLedger(ledger, [call("c8", "read", { path: "src/a.ts" }), result("c8", "read", "x")]);
assert.equal(ledger.files.find((f) => f.path === "src/a.ts").state, "modified");
// Workers: the instruction list skips the task prompt they get back anyway.
assert.deepEqual(plain(L.updateLedger(null, transcript, { includeInstructions: false }).instructions), []);

// It renders the facts verbatim, priority first.
const rendered = L.renderLedger(ledger);
assert.ok(rendered.startsWith(L.DURABLE_STATE_OPEN));
assert.ok(rendered.endsWith(L.DURABLE_STATE_CLOSE));
for (const needle of ["Never touch vendor/.", "modified: src/a.ts", "created: docs/notes.md", "fixed: bash `pnpm test`", "Remove adapter", "w-1"]) {
  assert.ok(rendered.includes(needle), `rendered ledger keeps ${needle}`);
}

// Round trip through a message's details, as a restarted process reads it.
const restored = L.ledgerFromDetails({ ledger: plain(ledger) });
assert.deepEqual(plain(restored), plain(ledger));
assert.equal(L.ledgerFromDetails({ version: 2 }), null);
assert.deepEqual(
  plain(L.latestLedgerIn([{ role: "custom", customType: L.DURABLE_STATE_CUSTOM_TYPE, details: { ledger: plain(ledger) } }])),
  plain(ledger),
);

// Merging keeps both sides; newer scalars win; fixes stick.
const newer = L.updateLedger(null, [user("Also keep chargeCustomer."), call("d1", "codara_plan_update", { goal: "v2" }), result("d1", "codara_plan_update", "ok")]);
const merged = L.mergeLedgers(ledger, newer);
assert.deepEqual(plain(merged.instructions), ["Ship the ledger. Never touch vendor/.", "Also keep chargeCustomer."]);
assert.match(merged.plan, /v2/);
assert.equal(merged.errors[0].fixed, true);

// Caps: the original request is never the instruction dropped, and a tight
// render keeps the first and the newest.
let many = null;
for (let index = 0; index < 40; index++) many = L.updateLedger(many, [user(`Instruction ${index}: ${"x".repeat(600)}`)]);
assert.equal(many.instructions.length, 24);
assert.match(many.instructions[0], /^Instruction 0:/);
assert.match(many.instructions.at(-1), /^Instruction 39:/);
const tight = L.renderLedger(many, 4_000);
assert.ok(tight.length <= 6_000, `tight render is bounded (${tight.length})`);
assert.match(tight, /Instruction 0:/);
assert.match(tight, /Instruction 39:/);

// The model-free summary carries the previous summary forward verbatim.
const summary = L.deterministicCompactionSummary({
  previousSummary: "## Goal\nShip the ledger, phase 1 done.",
  ledger,
  messages: transcript,
});
assert.match(summary, /Ship the ledger, phase 1 done\./);
assert.match(summary, /FAILED bash pnpm test/);
assert.match(summary, /without a model summary/);
assert.ok(summary.length <= 24_000);

// A long request keeps its end: the requirements that close a pasted spec
// are what the ledger exists to carry.
const spec = `Migrate the importer. ${"Context about the old format. ".repeat(200)}Never modify files under vendor/.`;
const specLedger = L.updateLedger(null, [user(spec)]);
assert.match(specLedger.instructions[0], /^Migrate the importer\./);
assert.match(specLedger.instructions[0], /Never modify files under vendor\/\.$/);
assert.ok(specLedger.instructions[0].length <= 3_000, `clipped to ${specLedger.instructions[0].length}`);
assert.match(L.renderLedger(specLedger), /Never modify files under vendor\//);
assert.equal(L.clipMiddle("short", 100), "short");
const clipped = L.clipMiddle(`head ${"m".repeat(500)} tail`, 120);
assert.ok(clipped.length <= 120, `clipMiddle stays within its budget (${clipped.length})`);
assert.match(clipped, /^head m/);
assert.match(clipped, /m tail$/);
assert.match(clipped, /chars trimmed/);

console.log("Compaction ledger checks passed.");
