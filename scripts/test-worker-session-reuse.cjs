#!/usr/bin/env node
"use strict";

// Contracts for warm worker-session reuse (codara_spawn_workers follow_up_of).
//
//   node scripts/test-worker-session-reuse.cjs
//
// 1. Gate logic (real source, bundled): evaluateWorkerSessionReuse resumes
//    only an accepted task whose latest attempt succeeded on the same runtime
//    with a captured Pi session, no other live task already continuing that
//    session, and the session's NEWEST attempt gauge below the named threshold
//    of the effective (compaction-capped) context ceiling. Every other shape
//    degrades to a cold decision with a reason; an unknown task id is invalid.
// 2. Source contracts: schema exposure of follow_up_of in server.js, the
//    spawn handler's verifier rejection + resumed_session result, run-store's
//    session/context capture and first-attempt-only resume, and the launch
//    plan's resumeSessionId seam.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), "utf8");

// Effective ceilings the gate measures against: min(model window, Codara's
// 256k compaction trigger, window minus Pi's 16384 built-in headroom).
const SONNET_CEILING = 200_000 - 16_384; // 183,616: raw window binds via Pi headroom
const FABLE_CEILING = 256_000; // 1M raw window; Codara's compaction trigger binds

async function bundleGate() {
  const esbuild = require(path.join(ROOT, "node_modules", "esbuild"));
  const outfile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "codara-session-reuse-test-")),
    "worker-session-reuse.cjs",
  );
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "worker-session-reuse.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [{
      name: "shared-alias",
      setup(build) {
        build.onResolve({ filter: /^@shared\// }, (args) => ({
          path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
        }));
      },
    }],
  });
  return require(outfile);
}

function baseRun() {
  const task = {
    id: "task-src",
    status: "accepted",
    taskClass: "feature",
    modelHint: "claude-sonnet-5",
  };
  const attempt = {
    id: "attempt-src",
    workerTaskId: "task-src",
    attemptNumber: 1,
    status: "succeeded",
    runtime: "claude",
    model: "claude-sonnet-5",
    piSessionId: "run-1-attempt-src",
    contextTokens: 30_000, // ~16% of the 183,616 sonnet ceiling, under the 20% cap
    finishedAt: "2026-08-06T10:00:00.000Z",
  };
  return { workerTasks: [task], workerAttempts: [attempt], task, attempt };
}

async function main() {
  const gate = await bundleGate();
  const { evaluateWorkerSessionReuse, WORKER_SESSION_REUSE_MAX_CONTEXT_FRACTION } = gate;

  assert.equal(WORKER_SESSION_REUSE_MAX_CONTEXT_FRACTION, 0.2, "threshold is the named 20% constant (kept low: context rot)");

  const evaluate = (run, overrides = {}) => evaluateWorkerSessionReuse({
    run,
    followUpOfTaskId: "task-src",
    requestedRuntime: "claude",
    ...overrides,
  });

  // Happy path: below threshold on the same runtime resumes, measured against
  // the compaction-capped ceiling rather than the raw model window.
  {
    const { workerTasks, workerAttempts, attempt } = baseRun();
    const decision = evaluate({ workerTasks, workerAttempts });
    assert.equal(decision.kind, "resume");
    assert.equal(decision.sessionId, attempt.piSessionId);
    assert.equal(decision.contextTokens, 30_000);
    assert.equal(decision.contextWindowTokens, SONNET_CEILING, "sonnet ceiling is window minus Pi headroom");
  }

  // At/above the threshold: cold, and the reason carries the percentage.
  {
    const { workerTasks, workerAttempts, attempt } = baseRun();
    attempt.contextTokens = Math.ceil(SONNET_CEILING * WORKER_SESSION_REUSE_MAX_CONTEXT_FRACTION);
    const decision = evaluate({ workerTasks, workerAttempts });
    assert.equal(decision.kind, "cold");
    assert.match(decision.reason, /effective context ceiling/);
    assert.match(decision.reason, /Spawned cold/);
  }

  // A provider-reported window on the attempt overrides the model default.
  {
    const { workerTasks, workerAttempts, attempt } = baseRun();
    attempt.contextWindowTokens = 50_000; // ceiling 33,616; 30k is ~89% of it
    const decision = evaluate({ workerTasks, workerAttempts });
    assert.equal(decision.kind, "cold");
  }

  // Fable models: the 1M raw window is capped by Codara's 256k compaction
  // trigger, so occupancy is judged against the ceiling a session really hits.
  {
    const { workerTasks, workerAttempts, attempt } = baseRun();
    attempt.model = "claude-fable-5";
    attempt.contextTokens = 40_000; // 15.6% of 256k: resumes
    const below = evaluate({ workerTasks, workerAttempts });
    assert.equal(below.kind, "resume");
    assert.equal(below.contextWindowTokens, FABLE_CEILING, "compaction trigger caps the 1M window");
    attempt.contextTokens = 100_000; // 39% of 256k but only 10% of the raw window: cold
    const above = evaluate({ workerTasks, workerAttempts });
    assert.equal(above.kind, "cold");
  }

  // One live writer per session, across the whole run: a non-terminal task
  // already continuing the session (duplicated spawn RPC, later manager turn)
  // forces cold even though every source-task check passes.
  {
    const { workerTasks, workerAttempts } = baseRun();
    workerTasks.push({
      id: "task-f1",
      status: "running",
      taskClass: "feature",
      resumeSessionId: "run-1-attempt-src",
    });
    const decision = evaluate({ workerTasks, workerAttempts });
    assert.equal(decision.kind, "cold");
    assert.match(decision.reason, /one live writer/);
  }

  // A FINISHED follow-up releases the claim; the gate then gauges from the
  // session's newest attempt, so a chained follow-up of the ORIGINAL task
  // cannot sneak past on the original, smaller context number.
  {
    const { workerTasks, workerAttempts } = baseRun();
    workerTasks.push({
      id: "task-f1",
      status: "accepted",
      taskClass: "feature",
      resumeSessionId: "run-1-attempt-src",
    });
    workerAttempts.push({
      id: "attempt-f1",
      workerTaskId: "task-f1",
      attemptNumber: 1,
      status: "succeeded",
      runtime: "claude",
      model: "claude-sonnet-5",
      piSessionId: "run-1-attempt-src", // resumed the same session and grew it
      contextTokens: 60_000, // ~33% of the ceiling now
      finishedAt: "2026-08-06T11:00:00.000Z",
    });
    const grown = evaluate({ workerTasks, workerAttempts });
    assert.equal(grown.kind, "cold");
    assert.match(grown.reason, /now sits at/);
    // And when the newest attempt is still small, the chain may continue.
    workerAttempts[1].contextTokens = 32_000;
    const stillSmall = evaluate({ workerTasks, workerAttempts });
    assert.equal(stillSmall.kind, "resume");
    assert.equal(stillSmall.contextTokens, 32_000, "gauge comes from the session's newest attempt");
  }

  // The newest attempt on the session missing its gauge blocks reuse even
  // though the source attempt still carries one.
  {
    const { workerTasks, workerAttempts } = baseRun();
    workerTasks.push({
      id: "task-f1",
      status: "accepted",
      taskClass: "feature",
      resumeSessionId: "run-1-attempt-src",
    });
    workerAttempts.push({
      id: "attempt-f1",
      workerTaskId: "task-f1",
      attemptNumber: 1,
      status: "succeeded",
      runtime: "claude",
      piSessionId: "run-1-attempt-src",
      finishedAt: "2026-08-06T11:00:00.000Z",
    });
    const decision = evaluate({ workerTasks, workerAttempts });
    assert.equal(decision.kind, "cold");
    assert.match(decision.reason, /no context usage/);
  }

  // No captured session: cold with an explanation.
  {
    const { workerTasks, workerAttempts, attempt } = baseRun();
    delete attempt.piSessionId;
    const decision = evaluate({ workerTasks, workerAttempts });
    assert.equal(decision.kind, "cold");
    assert.match(decision.reason, /no resumable runtime session/);
  }

  // No captured context usage: cold (the gate cannot verify headroom).
  {
    const { workerTasks, workerAttempts, attempt } = baseRun();
    delete attempt.contextTokens;
    const decision = evaluate({ workerTasks, workerAttempts });
    assert.equal(decision.kind, "cold");
    assert.match(decision.reason, /no context usage/);
  }

  // Cross-runtime mismatch: cold.
  {
    const { workerTasks, workerAttempts } = baseRun();
    const decision = evaluate({ workerTasks, workerAttempts }, { requestedRuntime: "codex" });
    assert.equal(decision.kind, "cold");
    assert.match(decision.reason, /cannot cross runtimes/);
  }

  // Source not terminal-successful: cold.
  {
    const { workerTasks, workerAttempts, task } = baseRun();
    task.status = "needs_review";
    const decision = evaluate({ workerTasks, workerAttempts });
    assert.equal(decision.kind, "cold");
    assert.match(decision.reason, /not terminal-successful/);
  }

  // Latest attempt wins: a failed retry after the success blocks reuse.
  {
    const { workerTasks, workerAttempts } = baseRun();
    workerAttempts.push({
      id: "attempt-retry",
      workerTaskId: "task-src",
      attemptNumber: 2,
      status: "failed",
      runtime: "claude",
    });
    const decision = evaluate({ workerTasks, workerAttempts });
    assert.equal(decision.kind, "cold");
    assert.match(decision.reason, /no successful attempt/);
  }

  // A verifier source is never continued.
  {
    const { workerTasks, workerAttempts, task } = baseRun();
    task.taskClass = "verifier";
    const decision = evaluate({ workerTasks, workerAttempts });
    assert.equal(decision.kind, "cold");
    assert.match(decision.reason, /verifier/);
  }

  // Unknown task id is a malformed request, not a silent cold spawn.
  {
    const { workerTasks, workerAttempts } = baseRun();
    const decision = evaluate({ workerTasks, workerAttempts }, { followUpOfTaskId: "task-missing" });
    assert.equal(decision.kind, "invalid");
  }

  // ── Source contracts ──────────────────────────────────────────────────────
  const serverJs = read("resources", "codara-studio-mcp", "server.js");
  assert.match(serverJs, /follow_up_of:\s*\{\s*type: "string"/, "schema exposes follow_up_of");
  const followUpSchema = serverJs.slice(serverJs.indexOf("follow_up_of:"), serverJs.indexOf("isolated:"));
  assert.match(followUpSchema, /ACCEPTED worker/, "schema names the accepted-worker requirement");
  assert.match(followUpSchema, /Never allowed on taskClass verifier/, "schema warns about verifiers");

  const agentSocket = read("src", "main", "agent-socket.ts");
  assert.match(
    agentSocket,
    /follow_up_of is not allowed on a verifier/,
    "the spawn handler rejects verifier follow-ups outright",
  );
  assert.match(
    agentSocket,
    /for \(const worker of workerEntries\) \{\s*\n\s*if \(typeof worker\.follow_up_of/,
    "the verifier/untrusted rejections scan EVERY requested entry, before any cap filtering",
  );
  assert.match(
    agentSocket,
    /decision\.kind === "cold"[\s\S]{0,120}guardrailNotes\.push\(`follow_up_of \$\{followUpOf\}: \$\{decision\.reason\}`\)/,
    "a failed gate degrades to a cold spawn whose reason reaches the result note",
  );
  assert.match(
    agentSocket,
    /if \(typeof worker\.title !== "string" \|\| !worker\.title\.trim\(\)\) continue;/,
    "entries the create loop will drop for empty titles get no gate notes",
  );
  assert.match(
    agentSocket,
    /resumedSessionCount > 0 \? \{ resumed_session: true \}/,
    "the result flags resumed_session when a warm spawn happened",
  );
  assert.match(
    agentSocket,
    /!resumePlan &&[\s\S]{0,120}headroomReroute\.from\.includes\(effectiveRuntime\)/,
    "the headroom reroute never moves a resumed worker off its source runtime",
  );

  const runStore = read("src", "main", "orchestration", "run-store.ts");
  assert.match(runStore, /piSessionId = plan\.sessionId/, "the Pi session id is captured from the launch plan");
  assert.match(
    runStore,
    /if \(result\.piSessionId\) finishedAttempt\.piSessionId = result\.piSessionId/,
    "the finished attempt persists the session id",
  );
  assert.match(
    runStore,
    /if \(!task\.resumeSessionId \|\| task\.taskClass === "verifier"\) return undefined;/,
    "the launch path re-fences verifiers from resuming a session",
  );
  assert.match(
    runStore,
    /const hasPriorAttempt = run\.workerAttempts\.some\(\s*\n\s*\(attempt\) => attempt\.workerTaskId === task\.id && attempt\.id !== attemptId,\s*\n\s*\);\s*\n\s*return hasPriorAttempt \? undefined : task\.resumeSessionId;/,
    "only the task's FIRST attempt resumes; retries and FEEDBACK rework launch cold",
  );
  assert.match(
    runStore,
    /resumeSessionId: piWorkerResumeSessionId\(run, task, attemptId\)/,
    "the launch site consults the first-attempt guard",
  );

  const piRuntimeElectron = read("src", "main", "orchestration", "pi-runtime-electron.ts");
  assert.match(
    piRuntimeElectron,
    /options\.resumeSessionId\?\.trim\(\) \|\| `\$\{options\.runId\}-\$\{options\.attemptId\}`/,
    "the worker launch plan resumes the vetted session id and derives fresh ids otherwise",
  );

  console.log("worker-session-reuse contracts: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
