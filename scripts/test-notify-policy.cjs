// Unit tests for the pure notification policy (src/main/notify/policy.ts).
// The module has no Electron/node dependencies, so the harness just
// esbuild-bundles it (the @shared/types import is type-only) and drives
// table-driven scenarios: each case is a sequence of decide/rearm steps
// against one fresh PolicyState, with expectations on the decision fields.
//
//   node scripts/test-notify-policy.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const POLICY_TS = path.join(ROOT, "src", "main", "notify", "policy.ts");

const sharedAliasPlugin = {
  name: "notify-policy-test-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

// Each case runs against a fresh PolicyState. Steps:
//   { kind, sourceKey?, watching?, dnd?, expect: { deliver, record?, read?, reason? } }
//   { rearm: sourceKey } | { clearLastAlerted: sourceKey }
// sourceKey defaults to "run:r1"; watching/dnd default false.
const CASES = [
  {
    name: "blocked always delivers, even while watching",
    steps: [
      {
        kind: "run.blocked",
        watching: true,
        expect: { deliver: true, record: true, read: false, reason: "deliver" },
      },
    ],
  },
  {
    name: "complete while watching is suppressed but recorded pre-read",
    steps: [
      {
        kind: "run.complete",
        watching: true,
        expect: { deliver: false, record: true, read: true, reason: "watching" },
      },
    ],
  },
  {
    name: "complete while away delivers",
    steps: [{ kind: "run.complete", expect: { deliver: true } }],
  },
  {
    name: "duplicate kind for the same source is suppressed and not recorded",
    steps: [
      { kind: "run.blocked", expect: { deliver: true } },
      {
        kind: "run.blocked",
        expect: { deliver: false, record: false, reason: "duplicate" },
      },
    ],
  },
  {
    name: "duplicate suppression is per-source",
    steps: [
      { kind: "terminal.agent.done", sourceKey: "pane:a", expect: { deliver: true } },
      { kind: "terminal.agent.done", sourceKey: "pane:b", expect: { deliver: true } },
      {
        kind: "terminal.agent.done",
        sourceKey: "pane:a",
        expect: { deliver: false, reason: "duplicate" },
      },
    ],
  },
  {
    name: "rearm allows the same kind to re-alert",
    steps: [
      { kind: "run.blocked", expect: { deliver: true } },
      { kind: "run.blocked", expect: { deliver: false, reason: "duplicate" } },
      { rearm: "run:r1" },
      { kind: "run.blocked", expect: { deliver: true } },
    ],
  },
  {
    name: "terminal-completion guard: complete → blocked suppressed → rearm → blocked delivers",
    steps: [
      { kind: "run.complete", expect: { deliver: true } },
      {
        kind: "run.blocked",
        expect: { deliver: false, record: false, reason: "completion-guard" },
      },
      // Run re-enters an active status (running/planning/reviewing).
      { rearm: "run:r1" },
      { kind: "run.blocked", expect: { deliver: true } },
    ],
  },
  {
    name: "completion guard also arms from a watching-suppressed completion",
    steps: [
      { kind: "run.complete", watching: true, expect: { deliver: false, reason: "watching" } },
      {
        kind: "run.blocked",
        expect: { deliver: false, reason: "completion-guard" },
      },
    ],
  },
  {
    name: "terminal guard sequence: done → needs-input suppressed → working rearm → needs-input delivers",
    steps: [
      { kind: "terminal.agent.done", sourceKey: "pane:p1", expect: { deliver: true } },
      {
        kind: "terminal.agent.needs-input",
        sourceKey: "pane:p1",
        expect: { deliver: false, reason: "completion-guard" },
      },
      { rearm: "pane:p1" },
      {
        kind: "terminal.agent.needs-input",
        sourceKey: "pane:p1",
        expect: { deliver: true },
      },
    ],
  },
  {
    name: "clearLastAlerted (paused/idle) re-allows the kind but keeps the completion guard",
    steps: [
      { kind: "run.complete", expect: { deliver: true } },
      { clearLastAlerted: "run:r1" },
      // Same completion may alert again after a pause-driven clear…
      { kind: "run.complete", expect: { deliver: true } },
      // …but a blocked re-emit is still the finished turn's tail.
      { kind: "run.blocked", expect: { deliver: false, reason: "completion-guard" } },
    ],
  },
  {
    name: "failed arms the completion guard too",
    steps: [
      { kind: "run.failed", expect: { deliver: true } },
      { kind: "run.blocked", expect: { deliver: false, reason: "completion-guard" } },
    ],
  },
  {
    name: "DND mutes delivery but records unread",
    steps: [
      {
        kind: "run.complete",
        dnd: true,
        expect: { deliver: false, record: true, read: false, reason: "dnd" },
      },
    ],
  },
  {
    name: "DND + watching records pre-read (watching wins)",
    steps: [
      {
        kind: "run.complete",
        watching: true,
        dnd: true,
        expect: { deliver: false, record: true, read: true, reason: "watching" },
      },
    ],
  },
  {
    name: "DND-muted event still sets the dedup state",
    steps: [
      { kind: "run.blocked", dnd: true, expect: { deliver: false, reason: "dnd" } },
      { kind: "run.blocked", expect: { deliver: false, reason: "duplicate" } },
    ],
  },
  {
    name: "automation kinds dedup until rearm",
    steps: [
      { kind: "automation.finished", sourceKey: "automation:j1", expect: { deliver: true } },
      {
        kind: "automation.finished",
        sourceKey: "automation:j1",
        expect: { deliver: false, reason: "duplicate" },
      },
      { rearm: "automation:j1" },
      { kind: "automation.failed", sourceKey: "automation:j1", expect: { deliver: true } },
    ],
  },
  {
    name: "status change (complete → failed) is not a duplicate",
    steps: [
      { kind: "run.complete", expect: { deliver: true } },
      { kind: "run.failed", expect: { deliver: true } },
    ],
  },
];

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spark-notify-policy-"));
  const outfile = path.join(tmp, "policy.bundle.cjs");
  await esbuild.build({
    entryPoints: [POLICY_TS],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [sharedAliasPlugin],
  });
  const P = require(outfile);

  let passed = 0;
  let failed = 0;

  for (const testCase of CASES) {
    const state = P.createPolicyState();
    let stepIndex = 0;
    let caseOk = true;
    for (const step of testCase.steps) {
      stepIndex += 1;
      if (step.rearm) {
        P.rearm(state, step.rearm);
        continue;
      }
      if (step.clearLastAlerted) {
        P.clearLastAlerted(state, step.clearLastAlerted);
        continue;
      }
      const decision = P.decide(
        { kind: step.kind, sourceKey: step.sourceKey ?? "run:r1" },
        { watching: step.watching === true, dnd: step.dnd === true },
        state,
      );
      for (const [key, want] of Object.entries(step.expect)) {
        if (decision[key] !== want) {
          console.error(
            `  FAIL ${testCase.name} — step ${stepIndex}: ${key}=${decision[key]}, want ${want} (reason=${decision.reason})`,
          );
          caseOk = false;
        }
      }
    }
    if (caseOk) {
      passed += 1;
      console.log(`  PASS ${testCase.name}`);
    } else {
      failed += 1;
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} notify-policy case(s) FAILED.`);
    process.exit(1);
  }
  console.log(`\nAll ${passed} notify-policy cases PASSED.`);
}

main().catch((err) => {
  console.error("NOTIFY-POLICY TEST FAILED:\n", err);
  process.exit(1);
});
