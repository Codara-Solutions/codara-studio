#!/usr/bin/env node
"use strict";

// Pins the worker-launch gate in src/main/orchestration/run-store.ts.
//
// Every autonomous Cora worker runs on the bundled Pi harness. The
// runtimePreference the manager sets ("claude" or "codex") selects the model
// PROVIDER (anthropic / openai-codex), not a command-line tool, and only the
// SPARK_E2E_LEGACY_WORKER_HARNESS=1 escape hatch reaches the legacy CLI path.
// resources/orchestration/manager-profile.json tells the manager exactly that,
// so a silent flip back to CLI-conditional routing would make the prompt lie.
//
// run-store.ts pulls in Electron and the whole orchestration graph, so this
// harness lifts the two decision expressions out of the source and evaluates
// them directly. That keeps the assertion behavioral (a real truth table)
// instead of a regex over prose, while staying loadable outside Electron.
//
//   node scripts/test-pi-worker-harness-gate.cjs
//
// Exits non-zero on any failed assertion.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const RUN_STORE = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
const source = fs.readFileSync(RUN_STORE, "utf8");

/** Lift `const <name> = <expression>;` out of the source. */
function declarationExpression(name) {
  const marker = `const ${name} =`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} is gone from run-store.ts`);
  assert.equal(
    source.indexOf(marker, start + marker.length),
    -1,
    `${name} is declared more than once; this harness pins a single gate`,
  );
  const end = source.indexOf(";", start + marker.length);
  assert.notEqual(end, -1, `${name} has no terminating semicolon`);
  return source.slice(start + marker.length, end).trim();
}

// ── The harness gate ────────────────────────────────────────────────────────
const gateExpression = declarationExpression("usePiWorkerHarness");
const evaluateGate = new Function(
  "process",
  "task",
  "untrustedPullRequest",
  `return Boolean(${gateExpression});`,
);
const usePiWorkerHarness = ({ runtimePreference, legacyEnv, untrustedPullRequest = false }) =>
  evaluateGate(
    { env: legacyEnv === undefined ? {} : { SPARK_E2E_LEGACY_WORKER_HARNESS: legacyEnv } },
    { runtimePreference },
    untrustedPullRequest,
  );

// Default: both provider selectors land on the Pi harness.
for (const runtimePreference of ["claude", "codex"]) {
  assert.equal(
    usePiWorkerHarness({ runtimePreference }),
    true,
    `runtimePreference "${runtimePreference}" must launch on the Pi worker harness by default`,
  );
}

// shell and manual are human-assisted escape hatches, never Pi workers.
for (const runtimePreference of ["shell", "manual", "", undefined]) {
  assert.equal(
    usePiWorkerHarness({ runtimePreference }),
    false,
    `runtimePreference "${String(runtimePreference)}" is not an autonomous provider`,
  );
}

// Only the exact "1" opt-in reaches the legacy CLI harness.
for (const runtimePreference of ["claude", "codex"]) {
  assert.equal(
    usePiWorkerHarness({ runtimePreference, legacyEnv: "1" }),
    false,
    `SPARK_E2E_LEGACY_WORKER_HARNESS=1 must select the legacy harness for "${runtimePreference}"`,
  );
  for (const nearMiss of ["", "0", "true", "yes", "2", " 1"]) {
    assert.equal(
      usePiWorkerHarness({ runtimePreference, legacyEnv: nearMiss }),
      true,
      `SPARK_E2E_LEGACY_WORKER_HARNESS=${JSON.stringify(nearMiss)} must not select the legacy harness`,
    );
  }
  // An imported pull request is fenced by the Pi harness; the escape hatch
  // cannot lower it back onto the legacy CLI path.
  assert.equal(
    usePiWorkerHarness({ runtimePreference, legacyEnv: "1", untrustedPullRequest: true }),
    true,
    "an untrusted pull-request run stays on the Pi harness regardless of the escape hatch",
  );
}

// ── The provider selector ───────────────────────────────────────────────────
// "claude"/"codex" pick a subscription, which is what makes the manager
// profile's cross-provider verifier policy real.
const providerMatch = source.match(
  /function piProviderForWorker\(task: WorkerTask\): PiSubscriptionProvider \{\s*return ([^;]+);/,
);
assert.ok(providerMatch, "piProviderForWorker is gone from run-store.ts");
const evaluateProvider = new Function("task", `return ${providerMatch[1]};`);
assert.equal(evaluateProvider({ runtimePreference: "claude" }), "anthropic");
assert.equal(evaluateProvider({ runtimePreference: "codex" }), "openai-codex");

// ── The prompt must match the routing ───────────────────────────────────────
// The manager profile is the text Cora reads. It may no longer describe
// workers as separate command-line tools or condition routing on an installed
// CLI, because neither is true of the Pi harness.
//
// BOTH copies are checked. prompt-profile.ts's DEFAULT_MANAGER_PROMPT_PROFILE
// is the fallback whenever the bundled JSON is missing or unparseable, and
// test-prompt-punctuation's own header records that this exact JSON-vs-
// TypeScript split silently killed a rule once already.
const PROFILE_SURFACES = [
  ["manager-profile.json", path.join(ROOT, "resources", "orchestration", "manager-profile.json")],
  ["prompt-profile.ts", path.join(ROOT, "src", "main", "orchestration", "prompt-profile.ts")],
];
const STALE_CLI_PHRASES = [
  "Claude Code and Codex CLI are local subscription-backed workers",
  "local Claude Code, Codex CLI, shell, or manual workers",
  "parallel CLI workers",
  "runtimePreference must be INSTALLED",
  "Only shell/manual installed",
  "when both runtimes are installed",
  "autonomous runtime is installed",
  "runtimes listed as INSTALLED",
  "installed runtimes only",
  "Runtime selection from INSTALLED",
  "on the other installed runtime",
];
const profiles = new Map(
  PROFILE_SURFACES.map(([label, file]) => [label, fs.readFileSync(file, "utf8")]),
);
for (const [label, text] of profiles) {
  for (const stale of STALE_CLI_PHRASES) {
    assert.equal(
      text.toLowerCase().includes(stale.toLowerCase()),
      false,
      `${label} still conditions worker routing on an installed CLI: ${stale}`,
    );
  }
  assert.match(
    text,
    /Every autonomous worker runs on Codara's (own )?built-in agent runtime/,
    `${label} must state that workers run on the built-in runtime`,
  );
  assert.match(
    text,
    /'claude' selects the Anthropic provider and 'codex' selects the OpenAI provider/,
    `${label} must name what the runtimePreference actually selects`,
  );
}

const profile = profiles.get("manager-profile.json");
// The cross-provider verifier policy is still real (two model families, two
// subscriptions) and must survive the rewrite.
for (const [mode, needle] of [
  ["worker_result_review override", "USER PROVIDER MANDATE: apply BEFORE any other routing rule"],
  ["worker_result_review rules", "USER PROVIDER MANDATE: HARDEST RULE IN THIS MODE"],
  ["cross-provider verifier", "Claude implementation → Codex verifier; Codex implementation → Claude verifier"],
]) {
  assert.equal(
    profile.includes(needle),
    true,
    `manager-profile.json lost its ${mode} policy`,
  );
}

// ── The markdown manager prompts ────────────────────────────────────────────
// The claude and codex manager backends read these files verbatim, and those
// managers spawn Pi workers exactly like the Pi manager does. So they may not
// condition worker routing on an installed CLI either, and may not describe a
// worker as a CLI process. The header line ("You are Cora (Claude Code: Auto
// mode)") and the spawn_terminals contract are deliberately exempt: the
// MANAGER really is that CLI, and those terminals really are CLI panes.
const MARKDOWN_MANAGER_PROMPTS = [
  "cc-auto-prompt.md",
  "cc-execute-prompt.md",
  "cc-automation-prompt.md",
  "codex-auto-prompt.md",
  "codex-execute-prompt.md",
];
const STALE_WORKER_PHRASES = [
  "are installed",
  "is installed",
  "runtimes are installed",
  "when both are installed",
  "opposite runtime",
  "OPPOSITE runtime",
  "mixed-runtime",
  "single-runtime fleet",
  "CLI process",
  "CLI processes",
  "Split across runtimes",
];
for (const name of MARKDOWN_MANAGER_PROMPTS) {
  const text = fs.readFileSync(path.join(ROOT, "resources", "orchestration", name), "utf8");
  for (const stale of STALE_WORKER_PHRASES) {
    assert.equal(
      text.toLowerCase().includes(stale.toLowerCase()),
      false,
      `${name} still describes workers as CLIs or gates them on an installed CLI: ${stale}`,
    );
  }
}
// The policies the rewrite had to preserve: spread work across both providers,
// and verify cross-provider. Auto and Execute carry them; the automation prompt
// drives a single looping worker and has neither.
for (const name of ["cc-auto-prompt.md", "codex-auto-prompt.md"]) {
  const text = fs.readFileSync(path.join(ROOT, "resources", "orchestration", name), "utf8");
  assert.match(text, /Split across providers/, `${name} lost its spread-across-providers policy`);
  assert.match(
    text,
    /Verifiers always take the OPPOSITE provider from the implementer/,
    `${name} lost its cross-provider verifier policy`,
  );
}
for (const name of ["cc-execute-prompt.md", "codex-execute-prompt.md"]) {
  const text = fs.readFileSync(path.join(ROOT, "resources", "orchestration", name), "utf8");
  assert.match(
    text,
    /When both the `claude` and `codex` subscriptions are connected and the slices are independent, mix them by fit/,
    `${name} lost its mix-by-fit policy`,
  );
}

// ── Self-contained approval asks ────────────────────────────────────────────
// An ask that requests approval of a plan/list/change set must itself contain
// the enumerated content being approved; pointing at collapsed worker reports
// or prior tool output ("shown above") asks the user to sign off blind
// (run-msafk7yu-zkudx6: "approve the six-agent consensus plan shown above"
// with zero rendered commits). Every manager surface must carry the rule, and
// agent-socket enforces it on plan_approval RPC asks.
const SELF_CONTAINED_ASK_NEEDLES = [
  "must itself contain the concrete content being approved",
  "summarized-but-complete enumeration, never a bare count",
];
const SELF_CONTAINED_ASK_SURFACES = [
  ["manager-profile.json", path.join(ROOT, "resources", "orchestration", "manager-profile.json")],
  ["prompt-profile.ts", path.join(ROOT, "src", "main", "orchestration", "prompt-profile.ts")],
  ["cc-auto-prompt.md", path.join(ROOT, "resources", "orchestration", "cc-auto-prompt.md")],
  ["cc-execute-prompt.md", path.join(ROOT, "resources", "orchestration", "cc-execute-prompt.md")],
  ["codex-auto-prompt.md", path.join(ROOT, "resources", "orchestration", "codex-auto-prompt.md")],
  ["codex-execute-prompt.md", path.join(ROOT, "resources", "orchestration", "codex-execute-prompt.md")],
  ["pi-cora/prompt.ts", path.join(ROOT, "resources", "pi-cora", "prompt.ts")],
];
for (const [label, file] of SELF_CONTAINED_ASK_SURFACES) {
  const text = fs.readFileSync(file, "utf8").replace(/\s+/g, " ");
  for (const needle of SELF_CONTAINED_ASK_NEEDLES) {
    assert.equal(
      text.includes(needle),
      true,
      `${label} lost the self-contained approval-ask rule: ${needle}`,
    );
  }
}
// The enforcement seam: the ask_user RPC handler rejects a blind
// plan_approval ask before it can be posted as a question.
const agentSocketSource = fs.readFileSync(
  path.join(ROOT, "src", "main", "agent-socket.ts"),
  "utf8",
);
assert.match(
  agentSocketSource,
  /blindApprovalAskProblem\(question, category\)/,
  "agent-socket.ts no longer validates plan_approval asks for unrendered-content references",
);

console.log("pi worker harness gate (run-store routing + manager prompt surfaces): ok");
