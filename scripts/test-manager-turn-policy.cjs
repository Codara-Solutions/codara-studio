// Contract tests for the manager-turn failure policy: how a failed manager
// turn is classified and what it earns (settle / retry / park / fail).
// Bundles the real main-process module with esbuild; no Electron involved.
//
//   node scripts/test-manager-turn-policy.cjs
//
// The fixtures mirror run-ms61c4lt-5bmkjt: every step complete, the run
// already marked complete by a mid-turn codara_complete, and the turn's final
// exchange dying with "Codex error: Our servers are currently overloaded.
// Please try again later." — which used to brand the whole run failed.

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const POLICY = path.join(ROOT, "src", "main", "orchestration", "manager-turn-policy.ts");
const SHARED_DIR = path.join(ROOT, "src", "shared");

const aliasPlugin = {
  name: "manager-turn-policy-test-aliases",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

async function loadContract() {
  const out = await esbuild.build({
    entryPoints: [POLICY],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    plugins: [aliasPlugin],
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

// The exact error the user's run recorded (run-ms61c4lt-5bmkjt, sparkCalls[0]).
const OVERLOADED = "Codex error: Our servers are currently overloaded. Please try again later.";

async function main() {
  const P = await loadContract();
  let passed = 0;
  const test = (name, fn) => {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  test("provider overload on a live run earns a retry, not a failure", () => {
    const plan = P.planManagerTurnFailure({
      error: OVERLOADED,
      runStatus: "running",
      mode: "chat",
      transientRetryCount: 0,
    });
    assert.equal(plan.action, "retry");
    assert.equal(plan.kind, "provider");
    assert.equal(plan.attempt, 1);
  });

  test("the second retry is the last; the third failure parks", () => {
    const second = P.planManagerTurnFailure({
      error: OVERLOADED,
      runStatus: "running",
      mode: "chat",
      transientRetryCount: 1,
    });
    assert.equal(second.action, "retry");
    assert.equal(second.attempt, 2);

    const exhausted = P.planManagerTurnFailure({
      error: OVERLOADED,
      runStatus: "running",
      mode: "chat",
      transientRetryCount: 2,
    });
    assert.equal(exhausted.action, "park");
    assert.equal(exhausted.kind, "provider");
    assert.equal(exhausted.parkReason, "Cora's provider is overloaded. Retry runs the turn again.");
    assert.equal(exhausted.lastAction, "chat_turn_parked");
    assert.equal(P.MAX_MANAGER_TRANSIENT_RETRIES, 2);
  });

  test("a run that already completed mid-turn keeps its verdict", () => {
    // run-ms61c4lt-5bmkjt: codara_complete landed at 12:08:58, the turn died
    // at 12:09:10. Under this policy the run stays complete.
    const plan = P.planManagerTurnFailure({
      error: OVERLOADED,
      runStatus: "complete",
      mode: "chat",
      transientRetryCount: 0,
    });
    assert.equal(plan.action, "keep_state");
    // The same holds for a run the user cancelled while the turn streamed,
    // and regardless of what killed the turn.
    assert.equal(
      P.planManagerTurnFailure({
        error: "CLI crashed",
        runStatus: "cancelled",
        mode: "chat",
        transientRetryCount: 0,
      }).action,
      "keep_state",
    );
  });

  test("failed, blocked, and paused runs are never re-branded, retried, or parked", () => {
    // failed: a worker cycle published the failure mid-turn; a park must not
    // overwrite that verdict with an optimistic retry offer.
    // blocked: the open question must stay answerable - answerRunQuestion
    // rejects paused runs, so parking would strand the user's answer.
    // paused: the user holds the run (e.g. Stop mid-turn); a retry under
    // "paused" would only emit a retry notice and then be rejected by the
    // post-sleep driving-state guard, burning budget on a lie.
    for (const runStatus of ["failed", "blocked", "paused"]) {
      for (const error of [OVERLOADED, "rate limit reached", "something inexplicable"]) {
        const plan = P.planManagerTurnFailure({
          error,
          runStatus,
          mode: "chat",
          transientRetryCount: 0,
        });
        assert.equal(
          plan.action,
          "keep_state",
          `expected keep_state for ${runStatus} + ${JSON.stringify(error)}, got ${plan.action}`,
        );
      }
    }
    // Driving states still retry.
    for (const runStatus of ["planning", "running", "reviewing"]) {
      assert.equal(
        P.planManagerTurnFailure({
          error: OVERLOADED,
          runStatus,
          mode: "chat",
          transientRetryCount: 0,
        }).action,
        "retry",
      );
    }
  });

  test("rate limits park immediately: a seconds-scale retry cannot clear a quota window", () => {
    const plan = P.planManagerTurnFailure({
      error: "Codex error: 429 Too Many Requests, rate limit reached",
      runStatus: "running",
      mode: "chat",
      transientRetryCount: 0,
    });
    assert.equal(plan.action, "park");
    assert.equal(plan.kind, "rate_limit");
    assert.equal(plan.parkReason, "Cora's provider is rate limited. Retry runs the turn again.");
  });

  test("transport drops retry like provider errors do", () => {
    const plan = P.planManagerTurnFailure({
      error: "fetch failed: socket hang up (ECONNRESET)",
      runStatus: "running",
      mode: "chat",
      transientRetryCount: 0,
    });
    assert.equal(plan.action, "retry");
    assert.equal(plan.kind, "transport");
  });

  test("non-chat manager turns park under their own lastAction so resume routes correctly", () => {
    const plan = P.planManagerTurnFailure({
      error: OVERLOADED,
      runStatus: "running",
      mode: "worker_result_review",
      transientRetryCount: 2,
    });
    assert.equal(plan.action, "park");
    assert.equal(plan.lastAction, "manager_turn_parked");
    assert.equal(P.isParkedManagerTurnAction("manager_turn_parked"), true);
    assert.equal(P.isParkedManagerTurnAction("chat_turn_parked"), true);
    assert.equal(P.isParkedManagerTurnAction("resumed_by_user"), false);
    assert.equal(P.isParkedManagerTurnAction(undefined), false);
  });

  test("auth, crashes, and unclassified errors keep the honest failed verdict", () => {
    for (const error of [
      // The Pi session-startup auth error. pi-backend now THROWS this before a
      // turn starts (so run-store degrades to the manual fallback / a parked
      // question); if it ever surfaces mid-turn instead, it must never be
      // treated as transient: no retry, no park.
      "Pi provider openai-codex is not authenticated with OAuth",
      "OAuth session expired, please /login",
      "runtime binary did not start",
      "something inexplicable",
      "",
      null,
    ]) {
      const plan = P.planManagerTurnFailure({
        error,
        runStatus: "running",
        mode: "chat",
        transientRetryCount: 0,
      });
      assert.equal(plan.action, "fail", `expected fail for ${JSON.stringify(error)}`);
    }
  });

  test("retry backoff is jittered and seconds-scale", () => {
    assert.equal(P.managerTurnRetryDelayMs(1, () => 0), 2000);
    assert.equal(P.managerTurnRetryDelayMs(2, () => 0), 4000);
    const jittered = P.managerTurnRetryDelayMs(1, () => 0.999);
    assert.ok(jittered > 2000 && jittered < 3500, `jitter out of range: ${jittered}`);
    // Both retries together stay under ten seconds of added wall clock.
    assert.ok(
      P.managerTurnRetryDelayMs(1, () => 1) + P.managerTurnRetryDelayMs(2, () => 1) < 10_000,
    );
  });

  console.log(`\n${passed} manager turn policy contract tests passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
