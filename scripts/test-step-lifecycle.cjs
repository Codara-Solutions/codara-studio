const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function loadContract() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "step-lifecycle.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function runFixture(step, tasks) {
  return {
    id: "run-step-lifecycle",
    status: "running",
    updatedAt: "2026-07-23T10:00:00.000Z",
    currentStepId: step.id,
    steps: [step],
    workerTasks: tasks,
  };
}

async function main() {
  const {
    dependencyIdsForSpawnedStep,
    findLiveVerifierFeedbackRetry,
    reconcileAcceptedVerifierOnlySteps,
  } = await loadContract();

  assert.deepEqual(dependencyIdsForSpawnedStep({ steps: [] }), []);
  assert.deepEqual(
    dependencyIdsForSpawnedStep({ steps: [{ id: "done", status: "complete" }] }),
    ["done"],
  );
  assert.deepEqual(
    dependencyIdsForSpawnedStep({
      steps: [
        { id: "root", status: "complete" },
        { id: "live-legacy", status: "running" },
      ],
    }),
    ["root"],
    "a branch beside a live legacy step inherits its effective predecessor",
  );
  assert.deepEqual(
    dependencyIdsForSpawnedStep({
      steps: [
        { id: "root", status: "complete" },
        { id: "live-explicit", status: "running", dependsOnStepIds: [] },
      ],
    }),
    [],
    "an explicit root dependency is preserved",
  );

  const standalone = runFixture(
    { id: "verify", status: "reviewing", updatedAt: "old" },
    [{ id: "v1", stepId: "verify", taskClass: "verifier", status: "accepted" }],
  );
  assert.deepEqual(
    reconcileAcceptedVerifierOnlySteps(standalone, "new"),
    ["verify"],
  );
  assert.equal(standalone.steps[0].status, "complete");
  assert.equal(standalone.steps[0].updatedAt, "new");
  assert.equal(standalone.currentStepId, undefined);

  const sameStepRetry = runFixture(
    { id: "mixed", status: "queued", updatedAt: "old" },
    [
      { id: "impl", stepId: "mixed", taskClass: "feature", status: "retry_queued" },
      { id: "v1", stepId: "mixed", taskClass: "verifier", status: "accepted" },
    ],
  );
  assert.deepEqual(reconcileAcceptedVerifierOnlySteps(sameStepRetry), []);
  assert.equal(sameStepRetry.steps[0].status, "queued");

  const fallbackPending = runFixture(
    { id: "verify", status: "queued", updatedAt: "old" },
    [
      { id: "v1", stepId: "verify", taskClass: "verifier", status: "cancelled" },
      { id: "v2", stepId: "verify", taskClass: "verifier", status: "queued" },
    ],
  );
  assert.deepEqual(reconcileAcceptedVerifierOnlySteps(fallbackPending), []);
  assert.equal(fallbackPending.steps[0].status, "queued");

  const implementation = runFixture(
    { id: "impl", status: "reviewing", updatedAt: "old" },
    [{ id: "i1", stepId: "impl", taskClass: "feature", status: "accepted" }],
  );
  assert.deepEqual(reconcileAcceptedVerifierOnlySteps(implementation), []);
  assert.equal(implementation.steps[0].status, "reviewing");

  const feedbackRetry = {
    id: "feedback-retry",
    title: "Create calculator",
    description: "Original brief\n\n## VERIFIER FEEDBACK\nFix repeat equals.",
    taskClass: "feature",
    status: "running",
    allowedPaths: ["./index.html"],
    expectedOutputs: [],
  };
  const feedbackRun = {
    workerTasks: [
      feedbackRetry,
      {
        ...feedbackRetry,
        id: "old-feedback-retry",
        status: "accepted",
        allowedPaths: ["old.html"],
      },
    ],
  };
  assert.equal(
    findLiveVerifierFeedbackRetry(feedbackRun, {
      title: "Fix calculator regressions",
      taskClass: "feature",
      allowedPaths: ["index.html"],
    })?.id,
    "feedback-retry",
  );
  assert.equal(
    findLiveVerifierFeedbackRetry(feedbackRun, {
      title: "Unrelated work",
      taskClass: "feature",
      expectedOutputs: ["README.md"],
    }),
    undefined,
  );
  assert.equal(
    findLiveVerifierFeedbackRetry(feedbackRun, {
      title: "Complete the remaining settings surfaces",
      taskClass: "feature",
      allowedPaths: [],
      expectedOutputs: [],
    })?.id,
    "feedback-retry",
    "an unscoped manager corrective conservatively reuses the live automatic retry",
  );
  assert.equal(
    findLiveVerifierFeedbackRetry(feedbackRun, {
      title: "Verify calculator",
      taskClass: "verifier",
      allowedPaths: ["index.html"],
    }),
    undefined,
  );

  console.log("  PASS verifier lifecycle repair and corrective-spawn deduplication");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
