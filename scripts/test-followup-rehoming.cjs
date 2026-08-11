#!/usr/bin/env node
"use strict";

// Regression harness for follow-up re-homing (run-msojtvqk-qjklvo).
//
//   node scripts/test-followup-rehoming.cjs
//
// Shape of the bug: step 1 finished with both its workers accepted, then the
// step-2 verifier returned FEEDBACK on one of them. maybeQueueVerifierFeedbackRetry
// re-queued that finished task IN PLACE and reopened its completed step, so 80 ms
// after the verifier exited the graph showed step 1 as "1/2 workers, 1 running,
// attempt 2" beside a running step 3. Product rule: Cora may follow up with a
// finished agent, but a completed step never shows running workers again - the
// follow-up attempt belongs to the CURRENT step.
//
// Four layers are pinned here:
//   1. placement - the real rehomeSettledStepFeedbackRetry (bundled from
//      step-lifecycle.ts) mints a follow-up copy in the current step, appends a
//      worker_batch step when every step has settled, and returns null (i.e.
//      "retry in place, unchanged behaviour") while the target's step is live;
//   2. immutability - the settled step's status, workerTaskIds and every task
//      and attempt under it are byte-identical after the re-homing;
//   3. warm sessions - the copy carries resumeSessionId, so the REAL
//      evaluateWorkerSessionReuse still resumes the session after re-homing:
//      cold while the copy is the live writer, resume once it settles;
//   4. wiring - source pins that run-store routes the retry through the helper,
//      no longer resurrects a terminal step, and counts the attempt cap over
//      the follow-up lineage, plus the grouping pins that let both graphs
//      render the copy under its new step with zero renderer changes.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), "utf8");
// JSON round-trip so `undefined`-valued keys compare equal on both sides.
const snapshot = (value) => JSON.parse(JSON.stringify(value));

const SHARED_ALIAS = {
  name: "shared-alias",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

async function bundle(relativeEntry, outName) {
  const esbuild = require(path.join(ROOT, "node_modules", "esbuild"));
  const outfile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "codara-followup-rehoming-")),
    outName,
  );
  await esbuild.build({
    entryPoints: [path.join(ROOT, ...relativeEntry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [SHARED_ALIAS],
  });
  return require(outfile);
}

const T0 = "2026-08-11T11:04:00.000Z";
const NOW = "2026-08-11T11:11:00.568Z";
const SESSION = "run-msojtvqk-qjklvo-attempt-msojysx5-76rumq";

// The reference run at the instant the verifier's FEEDBACK verdict landed:
// step 1 complete with both its workers accepted, step 2 the verifier's own
// step. `liveTail` adds the later step the manager was already running.
function referenceRun(options = {}) {
  const steps = [
    {
      id: "step-1",
      runId: "run-ref",
      index: 1,
      title: "Cora workers (2)",
      goal: "OpenAI primary source news; OpenAI independent coverage",
      kind: "worker_batch",
      plannedAgents: [],
      status: "complete",
      acceptanceCriteria: [],
      verificationCommands: [],
      workerTaskIds: ["task-primary", "task-coverage"],
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: "step-2",
      runId: "run-ref",
      index: 2,
      title: "Verify OpenAI news brief",
      goal: "Verify OpenAI news brief",
      kind: "worker_batch",
      plannedAgents: [],
      status: options.verifierStepStatus ?? "complete",
      acceptanceCriteria: [],
      verificationCommands: [],
      workerTaskIds: ["task-verify"],
      createdAt: T0,
      updatedAt: T0,
    },
  ];
  if (options.liveTail) {
    steps.push({
      id: "step-3",
      runId: "run-ref",
      index: 3,
      title: "Correct OpenAI coverage brief",
      goal: "Correct OpenAI coverage brief",
      kind: "worker_batch",
      plannedAgents: [],
      status: options.liveTail,
      acceptanceCriteria: [],
      verificationCommands: [],
      workerTaskIds: [],
      createdAt: T0,
      updatedAt: T0,
    });
  }
  const workerTasks = [
    {
      id: "task-primary",
      runId: "run-ref",
      stepId: "step-1",
      title: "OpenAI primary source news",
      description: "Research OpenAI news from first party sources only.",
      runtimePreference: "claude",
      modelHint: "claude-sonnet-5",
      effortHint: "medium",
      status: "accepted",
      allowedPaths: ["research/openai-primary.md"],
      forbiddenPaths: ["src/"],
      expectedOutputs: ["research/openai-primary.md"],
      verificationCommands: ["npm run lint"],
      canRunParallel: true,
      conflictsWith: [],
      taskClass: "leaf",
      writeScopeSource: "derived",
      parallelTrust: "manager_batch",
      peers: true,
      peerComms: true,
      accessHint: "edits",
      blockedToolsHint: ["Bash"],
      collabMailDirHint: "/runs/run-ref/mail",
      loomNodeId: "w0",
      resumeSessionId: options.warmSession ? SESSION : undefined,
      followUpOfTaskId: options.warmSession ? "task-warm-source" : undefined,
      verifierFeedbackRounds: options.priorRounds,
      createdBy: "spark",
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: "task-coverage",
      runId: "run-ref",
      stepId: "step-1",
      title: "OpenAI independent coverage",
      description: "Independent coverage brief.",
      runtimePreference: "codex",
      status: "accepted",
      allowedPaths: [],
      forbiddenPaths: [],
      expectedOutputs: [],
      verificationCommands: [],
      canRunParallel: true,
      conflictsWith: [],
      taskClass: "leaf",
      createdBy: "spark",
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: "task-verify",
      runId: "run-ref",
      stepId: "step-2",
      title: "Verify OpenAI news brief",
      description: "Read-only re-derivation.",
      runtimePreference: "codex",
      status: "accepted",
      allowedPaths: [],
      forbiddenPaths: [],
      expectedOutputs: [],
      verificationCommands: [],
      canRunParallel: false,
      conflictsWith: [],
      taskClass: "verifier",
      createdBy: "spark",
      createdAt: T0,
      updatedAt: T0,
    },
  ];
  const workerAttempts = [
    {
      id: "attempt-primary",
      runId: "run-ref",
      workerTaskId: "task-primary",
      attemptNumber: 1,
      runtime: "claude",
      model: "claude-sonnet-5",
      cwd: "/repo",
      status: "succeeded",
      piSessionId: SESSION,
      contextTokens: 30_000,
      startedAt: T0,
      finishedAt: "2026-08-11T11:05:52.518Z",
    },
    {
      id: "attempt-verify",
      runId: "run-ref",
      workerTaskId: "task-verify",
      attemptNumber: 1,
      runtime: "codex",
      cwd: "/repo",
      status: "succeeded",
      startedAt: T0,
      finishedAt: "2026-08-11T11:11:00.488Z",
    },
  ];
  return {
    id: "run-ref",
    status: "running",
    updatedAt: T0,
    currentStepId: undefined,
    steps,
    workerTasks,
    workerAttempts,
  };
}

const FEEDBACK_DESCRIPTION =
  "Research OpenAI news from first party sources only.\n\n## VERIFIER FEEDBACK\n\nFix the stale section header.";

const rehomeInput = (overrides = {}) => ({
  targetTaskId: "task-primary",
  description: FEEDBACK_DESCRIPTION,
  followUpTaskId: "task-followup",
  followUpStepId: "step-followup",
  timestamp: NOW,
  ...overrides,
});

async function main() {
  const lifecycle = await bundle(
    ["src", "main", "orchestration", "step-lifecycle.ts"],
    "step-lifecycle.cjs",
  );
  const { rehomeSettledStepFeedbackRetry, isSettledStepStatus } = lifecycle;
  const { evaluateWorkerSessionReuse } = await bundle(
    ["src", "main", "orchestration", "worker-session-reuse.ts"],
    "worker-session-reuse.cjs",
  );

  // ── 1. the settled-step definition the caller and the helper share ──
  for (const settled of ["complete", "completed_unverified", "failed", "skipped"]) {
    assert.equal(isSettledStepStatus(settled), true, `${settled} is settled`);
  }
  for (const live of ["queued", "ready", "running", "reviewing"]) {
    assert.equal(isSettledStepStatus(live), false, `${live} is not settled`);
  }
  console.log("PASS settled-step statuses match run-store's terminal set");

  // ── 2. re-home into the step that is already current ──
  {
    const run = referenceRun({ liveTail: "running", warmSession: true });
    const completedBefore = snapshot(run.steps[0]);
    const attemptsBefore = snapshot(run.workerAttempts);

    const rehomed = rehomeSettledStepFeedbackRetry(run, rehomeInput());
    assert.ok(rehomed, "a target in a complete step re-homes");
    assert.equal(rehomed.stepId, "step-3", "the copy lands in the current step");
    assert.equal(rehomed.createdStep, false, "an existing current step is reused");
    assert.equal(rehomed.taskId, "task-followup");

    const copy = run.workerTasks.find((task) => task.id === "task-followup");
    assert.ok(copy, "the follow-up task exists");
    assert.equal(copy.stepId, "step-3", "task.stepId points at the current step");
    assert.deepEqual(
      run.steps[2].workerTaskIds,
      ["task-followup"],
      "the current step's workerTaskIds carry the copy - what the desktop graph groups by",
    );

    // The completed step is untouched history.
    assert.deepEqual(snapshot(run.steps[0]), completedBefore, "the completed step is byte-identical");
    assert.equal(run.steps[0].status, "complete", "the completed step is never reopened");
    assert.deepEqual(
      run.steps[0].workerTaskIds,
      ["task-primary", "task-coverage"],
      "the completed step's counters are unchanged",
    );
    assert.deepEqual(snapshot(run.workerAttempts), attemptsBefore, "no attempt is added under the completed step");
    const original = run.workerTasks.find((task) => task.id === "task-primary");
    assert.equal(original.status, "accepted", "the original task keeps its accepted status");
    assert.equal(
      original.description,
      "Research OpenAI news from first party sources only.",
      "the original task's brief is not rewritten",
    );

    // Linkage + copied fields.
    assert.equal(copy.followUpOfTaskId, "task-primary", "the copy links back to the original");
    assert.equal(copy.title, original.title, "title is copied verbatim (runtime-fallback idiom)");
    assert.equal(copy.description, FEEDBACK_DESCRIPTION, "the copy carries the corrective brief");
    assert.equal(copy.status, "queued", "the copy is queueable");
    assert.equal(copy.createdBy, "system", "the copy is marked machine-minted");
    assert.equal(copy.taskClass, "leaf");
    assert.equal(copy.runtimePreference, "claude");
    assert.equal(copy.modelHint, "claude-sonnet-5");
    assert.equal(copy.effortHint, "medium");
    assert.deepEqual(copy.allowedPaths, ["research/openai-primary.md"]);
    assert.deepEqual(copy.forbiddenPaths, ["src/"]);
    assert.deepEqual(copy.expectedOutputs, ["research/openai-primary.md"]);
    assert.deepEqual(copy.verificationCommands, ["npm run lint"]);
    assert.equal(copy.canRunParallel, true);
    assert.equal(copy.parallelTrust, "manager_batch");
    assert.equal(copy.writeScopeSource, "derived");
    assert.equal(copy.loomNodeId, "w0", "loom identity survives the re-homing");
    assert.equal(copy.accessHint, "edits", "the node-derived tool fence travels with the copy");
    assert.deepEqual(copy.blockedToolsHint, ["Bash"]);
    assert.equal(copy.collabMailDirHint, "/runs/run-ref/mail");
    assert.equal(copy.verifierFeedbackRounds, 1, "the rework round counter advances on the copy");

    // Peer semantics: the INTENT flag travels, the outcome flag does not -
    // prepareWorkerTask re-derives group membership against the new step.
    assert.equal(copy.peers, true, "the peers opt-in travels with the copy");
    assert.equal(copy.peerComms, undefined, "the outcome flag is re-derived, never copied");
    console.log("PASS follow-up on a completed step's task lands in the current step");
  }

  // ── 3. isolated beats everything, and rounds accumulate ──
  {
    const run = referenceRun({ liveTail: "queued", priorRounds: 1 });
    const target = run.workerTasks.find((task) => task.id === "task-primary");
    target.isolated = true;
    rehomeSettledStepFeedbackRetry(run, rehomeInput());
    const copy = run.workerTasks.find((task) => task.id === "task-followup");
    assert.equal(copy.isolated, true, "an independent worker cannot rejoin peer traffic by re-homing");
    assert.equal(copy.verifierFeedbackRounds, 2, "feedback rounds are cumulative across the lineage");
    console.log("PASS isolated and the rework round counter carry across the re-homing");
  }

  // ── 4. no current step: append one, never reopen a settled one ──
  {
    const run = referenceRun();
    const rehomed = rehomeSettledStepFeedbackRetry(run, rehomeInput());
    assert.ok(rehomed);
    assert.equal(rehomed.createdStep, true, "a step is appended when every step has settled");
    assert.equal(rehomed.stepId, "step-followup");
    const created = run.steps.at(-1);
    assert.equal(created.id, "step-followup");
    assert.equal(created.index, 3, "the appended step continues the plan's numbering");
    assert.equal(created.status, "queued");
    assert.equal(created.kind, "worker_batch", "manager-spawn shape: work of its own gets a worker_batch step");
    assert.deepEqual(created.workerTaskIds, ["task-followup"]);
    assert.match(created.title, /Corrective rework: OpenAI primary source news/);
    assert.equal(run.steps[0].status, "complete", "the completed step stays complete");
    assert.equal(run.steps[1].status, "complete", "the verifier's settled step stays complete");
    assert.equal(
      run.steps.filter((step) => step.status !== "complete").length,
      1,
      "exactly one live step exists afterwards - the picker's active step",
    );
    console.log("PASS a run with no current step gets a fresh worker_batch step");
  }

  // ── 5. the target's step is still live: unchanged in-place behaviour ──
  {
    for (const status of ["queued", "ready", "running", "reviewing"]) {
      const run = referenceRun();
      run.steps[0].status = status;
      const before = snapshot(run);
      assert.equal(
        rehomeSettledStepFeedbackRetry(run, rehomeInput()),
        null,
        `a ${status} step retries in place`,
      );
      assert.deepEqual(snapshot(run), before, `a ${status} step's run state is untouched`);
    }
    // A target with no step at all cannot be re-homed either.
    const orphan = referenceRun();
    orphan.workerTasks.find((task) => task.id === "task-primary").stepId = undefined;
    assert.equal(rehomeSettledStepFeedbackRetry(orphan, rehomeInput()), null, "a step-less task retries in place");
    // An unknown target id is a no-op rather than a throw.
    assert.equal(
      rehomeSettledStepFeedbackRetry(referenceRun(), rehomeInput({ targetTaskId: "task-gone" })),
      null,
      "an unknown target id is a no-op",
    );
    console.log("PASS a live step keeps the existing in-place retry");
  }

  // ── 6. warm session reuse still engages for the re-homed task ──
  {
    const run = referenceRun({ liveTail: "running", warmSession: true });
    rehomeSettledStepFeedbackRetry(run, rehomeInput());
    const copy = run.workerTasks.find((task) => task.id === "task-followup");
    assert.equal(copy.resumeSessionId, SESSION, "the copy continues the same runtime session");

    // While the copy is the live writer, the gate refuses a second claim on
    // that session - the one-live-writer rule, unchanged by the re-homing.
    const contested = evaluateWorkerSessionReuse({
      run,
      followUpOfTaskId: "task-primary",
      requestedRuntime: "claude",
    });
    assert.equal(contested.kind, "cold", "a second claim on the live session spawns cold");
    assert.match(contested.reason, /task-followup already continues that session/);

    // Once the copy settles, the gate resumes it from its new step exactly as
    // it would have from the old one: the gate is run-scoped, never step-scoped.
    copy.status = "accepted";
    run.workerAttempts.push({
      id: "attempt-followup",
      runId: "run-ref",
      workerTaskId: "task-followup",
      attemptNumber: 1,
      runtime: "claude",
      model: "claude-sonnet-5",
      cwd: "/repo",
      status: "succeeded",
      piSessionId: SESSION,
      contextTokens: 32_000,
      startedAt: NOW,
      finishedAt: "2026-08-11T11:11:53.408Z",
    });
    const resumed = evaluateWorkerSessionReuse({
      run,
      followUpOfTaskId: "task-followup",
      requestedRuntime: "claude",
    });
    assert.equal(resumed.kind, "resume", "the re-homed task is itself resumable");
    assert.equal(resumed.sessionId, SESSION);
    assert.equal(resumed.contextTokens, 32_000, "the gauge reads the session's newest attempt");
    console.log("PASS warm session reuse survives the re-homing");
  }

  // ── 7. run-store wiring ──
  {
    const runStore = read("src", "main", "orchestration", "run-store.ts");
    const retry = runStore.slice(
      runStore.indexOf("async function maybeQueueVerifierFeedbackRetry"),
      runStore.indexOf("async function recordGreenClaims"),
    );
    assert.ok(retry.length > 0, "the verifier feedback retry still exists");
    assert.match(
      retry,
      /rehomeSettledStepFeedbackRetry\(draft, \{/,
      "the retry routes a settled-step target through the re-homing helper",
    );
    assert.ok(
      retry.indexOf("reconcileAcceptedVerifierOnlySteps(draft, timestamp)") <
        retry.indexOf("rehomeSettledStepFeedbackRetry(draft, {"),
      "verifier-only steps settle BEFORE the destination step is picked",
    );
    assert.doesNotMatch(
      retry,
      /isTerminalStepStatus\(step\.status\) \|\| step\.status === "reviewing"/,
      "a settled step is never reopened to queued any more",
    );
    assert.match(
      retry,
      /countFollowUpLineageAttempts\(run, target\)/,
      "the attempt cap counts the whole follow-up lineage when re-homing",
    );
    assert.match(
      runStore,
      /function countFollowUpLineageAttempts\([\s\S]{0,600}followUpOfTaskId/,
      "the lineage walk follows followUpOfTaskId",
    );
    console.log("PASS run-store routes the settled-step retry through the helper");
  }

  // ── 8. grouping pins: no renderer change is needed ──
  {
    const runFormat = read("src", "renderer", "src", "components", "runs", "run-format.ts");
    assert.match(
      runFormat,
      /const tasks = step\.workerTaskIds/,
      "the desktop graph groups workers by step.workerTaskIds",
    );
    const production = read("src", "main", "remote-access", "production.ts");
    assert.match(
      production,
      /isRemoteCoraIdentity\(task\.stepId\)\s*\n?\s*\?\s*\{ stepId: task\.stepId \}/,
      "the phone roster groups workers by task.stepId",
    );
    console.log("PASS both graphs group by fields the re-homing already sets");
  }

  console.log("\nfollow-up re-homing: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
