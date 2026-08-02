#!/usr/bin/env node
"use strict";

// Regression tests for scoped re-verification (PriorVerifierRound).
//
// The freshness invariant requires a NEWER passing verifier verdict after every
// files-changing implementation, so even a two-line correction mandates a fresh
// verifier. Nothing told that verifier what the previous round had already
// settled, so each one re-derived the whole accumulated surface. Measured on
// run-msc4glpk-tmgkfr, where verification was 87% of spend and every round cost
// MORE than the last while the fixes it checked got smaller:
//
//   fix  $1.56 (7.8m)  -> verify $7.64 (10.1m)
//   fix  $0.46 (2.4m)  -> verify $9.81 (12.2m)
//   fix  $1.75 (6.6m)  -> verify $11.19 (13.0m)
//   fix  $0.55 (2.2m)  -> verify ...
//
// collectPriorVerifierRound hands the next verifier the settled claims plus the
// exact files that moved since, so it can spend its turn on the delta and on
// whatever was left open.
//
//   node scripts/test-verifier-scoping.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const results = [];
const check = (name, fn) => {
  fn();
  results.push(name);
};

function extract(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `could not find ${signature}`);
  let depth = 0;
  let seen = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") {
      depth += 1;
      seen = true;
    } else if (source[i] === "}") {
      depth -= 1;
      if (seen && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${signature}`);
}

function compile(tsSource, deps, exportName) {
  const js = ts.transpileModule(tsSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // eslint-disable-next-line no-new-func
  return new Function(...deps, `${js}\nreturn ${exportName};`);
}

const RUN_STORE = read("src/main/orchestration/run-store.ts");
const WORKER_PROMPT = read("src/main/orchestration/worker-prompt.ts");

// Rebuild the collector with its caps and only readWorkerReport injected.
const SHIM = "type RunState = any; type WorkerTask = any; type VerifierVerdict = any; type PriorVerifierRound = any;\n";
const CONSTS = RUN_STORE.slice(
  RUN_STORE.indexOf("const MAX_ESTABLISHED_CLAIMS"),
  RUN_STORE.indexOf("async function collectPriorVerifierRound"),
);
const collectPriorVerifierRound = compile(
  SHIM + CONSTS + extract(RUN_STORE, "async function collectPriorVerifierRound"),
  ["readWorkerReport"],
  "collectPriorVerifierRound",
)(async (p) => reports.get(p) ?? null);

const renderPriorVerifierRoundSection = compile(
  "type PriorVerifierRound = any;\n" +
    extract(WORKER_PROMPT, "function renderPriorVerifierRoundSection"),
  [],
  "renderPriorVerifierRoundSection",
)();

const reports = new Map();

// The shape of the real incident: an implementation, a verifier that failed one
// claim of many, a tiny corrective fix, and now a second verifier.
function incidentRun() {
  reports.set("/r/impl1.json", { filesChanged: [{ path: "src/App.tsx", reason: "x" }], handoff: [] });
  reports.set("/r/verify1.json", {
    verifier: {
      status: "failed",
      confidence: "FEEDBACK",
      atomicClaims: [
        { claim: "glass material applied via wrapper", verdict: "verified", evidence: "styles.css:2819" },
        { claim: "baseline captured on blur", verdict: "verified", evidence: "App.tsx:1655" },
        { claim: "visible run excluded", verdict: "verified", evidence: "timeline.ts:1450" },
        { claim: "digest opening contract keeps working runs actionable", verdict: "failed", evidence: "total counts working" },
        { claim: "pruning closes the card on last origin", verdict: "unsure", evidence: "no coverage" },
      ],
    },
  });
  reports.set("/r/fix2.json", {
    filesChanged: [{ path: "src/renderer/src/components/chat/timeline.ts", reason: "opening contract" }],
  });
  return {
    workerTasks: [
      { id: "t-impl1", taskClass: "feature", title: "Fix away notification behavior" },
      { id: "t-verify1", taskClass: "verifier", title: "Verify notification lifecycle fix" },
      { id: "t-fix2", taskClass: "feature", title: "Corrective fix" },
      { id: "t-verify2", taskClass: "verifier", title: "Reverify corrected digest behavior" },
    ],
    workerAttempts: [
      { workerTaskId: "t-impl1", finalReportPath: "/r/impl1.json", finishedAt: "2026-08-02T21:41:34Z" },
      { workerTaskId: "t-verify1", finalReportPath: "/r/verify1.json", finishedAt: "2026-08-02T21:52:16Z" },
      { workerTaskId: "t-fix2", finalReportPath: "/r/fix2.json", finishedAt: "2026-08-02T21:54:39Z" },
    ],
  };
}

const verifierTask = { id: "t-verify2", taskClass: "verifier" };

async function main() {
  {
    const round = await collectPriorVerifierRound(incidentRun(), verifierTask);
    assert.ok(round, "a re-verification must inherit the previous round");
    assert.equal(round.confidence, "FEEDBACK");
    assert.deepEqual(
      round.established,
      [
        "glass material applied via wrapper",
        "baseline captured on blur",
        "visible run excluded",
      ],
      "only verified claims are handed over as settled",
    );
    assert.equal(round.outstanding.length, 2, "failed AND unsure claims stay open");
    assert.deepEqual(
      round.outstanding.map((o) => o.verdict).sort(),
      ["failed", "unsure"],
      "an unsure claim is not silently promoted to settled",
    );
    // The delta is what makes trusting the settled claims safe, so it must be
    // exactly the files changed AFTER the verdict, not every file in the run.
    assert.deepEqual(round.changedSince, ["src/renderer/src/components/chat/timeline.ts"]);
    assert.ok(
      !round.changedSince.includes("src/App.tsx"),
      "files changed BEFORE the verdict were already covered by it",
    );
    results.push("a re-verification inherits settled claims, open claims, and the exact delta");
  }
  {
    // An implementation worker must never receive this: it is verifier-only.
    const round = await collectPriorVerifierRound(incidentRun(), { id: "t-x", taskClass: "feature" });
    assert.equal(round, null);
    results.push("only verifier-class tasks inherit a prior round");
  }
  {
    // First verification of a run has nothing to inherit and must do the full job.
    const run = incidentRun();
    run.workerAttempts = run.workerAttempts.filter((a) => a.workerTaskId !== "t-verify1");
    assert.equal(await collectPriorVerifierRound(run, verifierTask), null);
    results.push("the first verifier in a run inherits nothing and verifies everything");
  }
  {
    // A round that settled NOTHING gives the next one no shortcut.
    const run = incidentRun();
    reports.set("/r/verify1.json", {
      verifier: {
        status: "failed",
        confidence: "FAILED",
        atomicClaims: [{ claim: "everything", verdict: "failed", evidence: "no" }],
      },
    });
    assert.equal(await collectPriorVerifierRound(run, verifierTask), null);
    results.push("a round with no settled claims grants no shortcut");
  }
  {
    // A verifier must not be handed its OWN earlier attempt as settled ground.
    const run = incidentRun();
    reports.set("/r/verify1.json", {
      verifier: {
        status: "verified",
        confidence: "VERIFIED",
        atomicClaims: [{ claim: "c", verdict: "verified", evidence: "e" }],
      },
    });
    run.workerAttempts = run.workerAttempts.map((a) =>
      a.workerTaskId === "t-verify1" ? { ...a, workerTaskId: "t-verify2" } : a,
    );
    assert.equal(
      await collectPriorVerifierRound(run, verifierTask),
      null,
      "its own lineage is the thing under review, not evidence about it",
    );
    results.push("a verifier never inherits its own prior attempt");
  }

  check("the rendered section scopes the turn without licensing blind trust", () => {
    const text = renderPriorVerifierRoundSection({
      verifiedAt: "2026-08-02T21:52:16.000Z",
      confidence: "FEEDBACK",
      established: ["glass material applied via wrapper", "baseline captured on blur"],
      outstanding: [{ claim: "digest opening contract", verdict: "failed", evidence: "total counts working" }],
      changedSince: ["src/renderer/src/components/chat/timeline.ts"],
    }).join("\n");

    assert.match(text, /ALREADY SETTLED BY THE PREVIOUS VERIFIER/);
    assert.match(text, /do NOT re-derive these from scratch/);
    assert.match(text, /glass material applied via wrapper/);
    // The delta must be named. Without it "take the rest as established" is
    // blind trust rather than a scoped decision.
    assert.match(text, /src\/renderer\/src\/components\/chat\/timeline\.ts/);
    assert.match(text, /Re-check a settled claim ONLY when one of the changed files above could plausibly affect it/);
    // Skipped claims still have to appear in the ledger, so scoping never
    // shrinks the verdict's coverage, only its cost.
    assert.match(text, /Carry every claim you did not re-check into your own atomic_claims/);
    assert.match(text, /digest opening contract/);
    assert.match(text, /spend it here/);
  });

  check("nothing is rendered when there is nothing to inherit", () => {
    assert.deepEqual(renderPriorVerifierRoundSection(null), []);
    assert.deepEqual(renderPriorVerifierRoundSection(undefined), []);
    assert.deepEqual(
      renderPriorVerifierRoundSection({ established: [], outstanding: [], changedSince: [] }),
      [],
    );
  });

  check("a clean prior round still points the turn at the delta", () => {
    const text = renderPriorVerifierRoundSection({
      verifiedAt: "2026-08-02T22:07:21.000Z",
      confidence: "VERIFIED",
      established: ["everything held"],
      outstanding: [],
      changedSince: ["src/renderer/src/App.tsx"],
    }).join("\n");
    assert.match(text, /your turn is about the changes since/);
    assert.match(text, /src\/renderer\/src\/App\.tsx/);
  });

  // ── Scope-split rounds ──────────────────────────────────────────────────
  //
  // Splitting a round into disjoint scopes makes "one shard fails while its
  // siblings pass" the EXPECTED case. The gate used to take the newest passing
  // verdict alone, so a green shard could carry a red one over the line.
  const describeVerificationFreshness = compile(
    "type RunState = any; type RunVerificationFreshness = any;\n" +
      "const PASSING_VERIFIER_CONFIDENCES = new Set([\"PERFECT\", \"VERIFIED\", \"PARTIAL\"]);\n" +
      extract(RUN_STORE, "export async function describeVerificationFreshness").replace(
        "export async function",
        "async function",
      ),
    ["readWorkerReport"],
    "describeVerificationFreshness",
  )(async (p) => reports.get(p) ?? null);

  const at = (mins) => new Date(Date.UTC(2026, 7, 2, 21, mins)).toISOString();
  function splitRound(shardConfidences) {
    reports.clear();
    reports.set("/s/impl.json", { filesChanged: [{ path: "src/App.tsx", reason: "fix" }], verifier: undefined });
    const tasks = [{ id: "impl", taskClass: "feature", title: "Fix" }];
    const attempts = [{ workerTaskId: "impl", finalReportPath: "/s/impl.json", finishedAt: at(0) }];
    shardConfidences.forEach((confidence, i) => {
      reports.set(`/s/v${i}.json`, {
        filesChanged: [],
        verifier: { status: "verified", confidence, atomicClaims: [] },
      });
      tasks.push({ id: `v${i}`, taskClass: "verifier", title: `Verify scope ${i}` });
      attempts.push({ workerTaskId: `v${i}`, finalReportPath: `/s/v${i}.json`, finishedAt: at(10 + i) });
    });
    return { workerTasks: tasks, workerAttempts: attempts };
  }

  {
    const all = await describeVerificationFreshness(splitRound(["VERIFIED", "VERIFIED", "VERIFIED"]));
    assert.equal(all.ok, true, "a fully green split round completes");
    assert.equal(all.blockingVerifier, null);
    results.push("a split round where every scope passes completes");
  }
  {
    // The regression: shard 0 green, shard 1 red, shard 2 green. The newest
    // PASSING verdict postdates the implementation, which is exactly what the
    // old rule checked, so this used to complete with a failed verifier.
    const mixed = await describeVerificationFreshness(splitRound(["VERIFIED", "FEEDBACK", "PERFECT"]));
    assert.equal(mixed.ok, false, "a green sibling must not carry a failed scope over the line");
    assert.equal(mixed.blockingVerifier.confidence, "FEEDBACK");
    assert.equal(mixed.blockingVerifier.title, "Verify scope 1");
    results.push("a failing scope blocks completion even when its siblings pass");
  }
  {
    // The normal ping-pong must still terminate: an old FEEDBACK answered by a
    // newer corrective edit is superseded, not permanently blocking.
    reports.clear();
    reports.set("/p/impl1.json", { filesChanged: [{ path: "a.ts", reason: "x" }] });
    reports.set("/p/v1.json", { filesChanged: [], verifier: { status: "failed", confidence: "FEEDBACK", atomicClaims: [] } });
    reports.set("/p/impl2.json", { filesChanged: [{ path: "a.ts", reason: "fix" }] });
    reports.set("/p/v2.json", { filesChanged: [], verifier: { status: "verified", confidence: "VERIFIED", atomicClaims: [] } });
    const pingpong = await describeVerificationFreshness({
      workerTasks: [
        { id: "i1", taskClass: "feature", title: "Fix" },
        { id: "x1", taskClass: "verifier", title: "Verify" },
        { id: "i2", taskClass: "feature", title: "Corrective fix" },
        { id: "x2", taskClass: "verifier", title: "Reverify" },
      ],
      workerAttempts: [
        { workerTaskId: "i1", finalReportPath: "/p/impl1.json", finishedAt: at(0) },
        { workerTaskId: "x1", finalReportPath: "/p/v1.json", finishedAt: at(10) },
        { workerTaskId: "i2", finalReportPath: "/p/impl2.json", finishedAt: at(20) },
        { workerTaskId: "x2", finalReportPath: "/p/v2.json", finishedAt: at(30) },
      ],
    });
    assert.equal(pingpong.ok, true, "an old FEEDBACK superseded by a newer fix must not block forever");
    assert.equal(pingpong.blockingVerifier, null);
    results.push("a superseded FEEDBACK does not block the next round");
  }

  check("the split policy reaches every complexity tier", () => {
    const protocol = read("src/main/orchestration/manager-protocol.ts");
    assert.equal((protocol.match(/VERIFIER_SCOPE_SPLIT_POLICY/g) ?? []).length, 4);
    assert.match(protocol, /spawn 2-4 verifiers in ONE batch with canRunParallel true/);
    assert.match(protocol, /Split by scope, never by duplicating the same brief/);
    // It must not read as a way to dodge a hard verdict.
    assert.match(protocol, /Every shard must pass/);
  });

  check("the collector is actually wired into the verifier prompt", () => {
    assert.match(RUN_STORE, /const priorVerifierRound = await collectPriorVerifierRound\(run, task\)/);
    assert.match(RUN_STORE, /priorVerifierRound,\n\s+\}\);/);
    assert.match(WORKER_PROMPT, /\.\.\.renderPriorVerifierRoundSection\(priorVerifierRound\)/);
    // Implementation workers must not be handed a verifier ledger.
    const impl = extract(WORKER_PROMPT, "function renderImplementationWorkerPrompt");
    assert.ok(!impl.includes("priorVerifierRound"), "implementation prompts stay unchanged");
  });

  for (const name of results) console.log(`PASS ${name}`);
  console.log(`\n${results.length} verifier scoping checks passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
