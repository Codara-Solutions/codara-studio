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
const fs = require("node:fs");
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
const PROVIDER_CAPACITY_VARIANTS = [
  OVERLOADED,
  'Claude API Error: 529 {"type":"error","error":{"type":"overloaded_error"},"request_id":"req_secret"}',
  "Claude is experiencing high demand; servers are too busy",
];

async function main() {
  const P = await loadContract();
  const runStoreSource = fs.readFileSync(
    path.join(ROOT, "src", "main", "orchestration", "run-store.ts"),
    "utf8",
  );
  let passed = 0;
  const test = (name, fn) => {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  test("provider overload on a live run earns a retry, not a failure", () => {
    for (const error of PROVIDER_CAPACITY_VARIANTS) {
      const plan = P.planManagerTurnFailure({
        error,
        runStatus: "running",
        mode: "chat",
        transientRetryCount: 0,
      });
      assert.equal(plan.action, "retry", error);
      assert.equal(plan.kind, "provider", error);
      assert.equal(plan.attempt, 1, error);
    }
  });

  test("Pi owns provider retries, so an exhausted Pi turn parks without full-turn replay", () => {
    for (const error of [OVERLOADED, "fetch failed: socket hang up (ECONNRESET)"]) {
      const plan = P.planManagerTurnFailure({
        error,
        runStatus: "running",
        mode: "chat",
        transientRetryCount: 0,
        backend: "pi",
      });
      assert.equal(plan.action, "park");
      assert.match(plan.reason, /Pi exhausted its own automatic provider retries/);
      assert.equal(
        plan.parkReason,
        error === OVERLOADED
          ? "Cora's provider is temporarily unavailable or at capacity. Retry the saved turn or switch accounts."
          : "Cora lost its connection to the provider. Retry when the connection is stable.",
      );
    }
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
    assert.equal(
      exhausted.parkReason,
      "Cora's provider is temporarily unavailable or at capacity. Retry the saved turn or switch accounts.",
    );
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
    assert.equal(
      plan.parkReason,
      "The selected provider account reached its usage limit. Switch accounts or retry after quota resets.",
    );
  });

  test("a subscription/billing decline fails the turn and never parks the run", () => {
    // The exact 400 recorded on run-ms9ikoef-mnucvq: Anthropic bills
    // third-party harness use against Extra Usage and this account had none.
    // It is classified so the failure card can explain the billing cause, but a
    // manager/chat turn must fail visibly like any other provider turn failure:
    // parking paused the run and took over the composer with a recovery banner
    // for something the user never asked to have handled.
    const EXTRA_USAGE_DECLINE =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_011Cdavbsxnm5vP5ZkjLrM3t"}';
    for (const backend of [undefined, "pi"]) {
      const plan = P.planManagerTurnFailure({
        error: EXTRA_USAGE_DECLINE,
        runStatus: "running",
        mode: "chat",
        transientRetryCount: 0,
        ...(backend ? { backend } : {}),
      });
      assert.equal(plan.action, "fail", `expected fail for backend=${backend}`);
      assert.equal(plan.kind, "subscription");
      // Nothing that could pause the run or drive the composer placeholder.
      assert.equal(plan.parkReason, undefined);
      assert.equal(plan.lastAction, undefined);
    }
    // Still never a quiet same-account retry: a doomed account must not burn
    // automatic attempts, on any mode.
    for (const mode of ["chat", "worker_result_review"]) {
      assert.notEqual(
        P.planManagerTurnFailure({
          error: EXTRA_USAGE_DECLINE,
          runStatus: "running",
          mode,
          transientRetryCount: 0,
        }).action,
        "retry",
      );
    }
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
    const parked = P.planManagerTurnFailure({
      error: "fetch failed: socket hang up (ECONNRESET)",
      runStatus: "running",
      mode: "chat",
      transientRetryCount: 2,
    });
    assert.equal(
      parked.parkReason,
      "Cora lost its connection to the provider. Retry when the connection is stable.",
    );
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

  test("provider park labels never become worker instructions", () => {
    const resumePrompt = runStoreSource.slice(
      runStoreSource.indexOf("function buildResumePrompt"),
      runStoreSource.indexOf("const HOOK_TRUST_MS"),
    );
    assert.match(resumePrompt, /const promptText = userUpdate\?\.message/);
    assert.doesNotMatch(
      resumePrompt,
      /stopReason\?\.trim\(\)|pauseReason/,
      "operational stop reasons must not be replayed as user prompts",
    );
    const parkMutation = runStoreSource.slice(
      runStoreSource.indexOf('if (failurePlan.action === "park")'),
      runStoreSource.indexOf('type: "run.chat_turn_failed"'),
    );
    assert.match(parkMutation, /pausedAt: timestamp/);
    assert.equal(
      (parkMutation.match(/draft\.managerTurnRecovery\s*=/g) ?? []).length,
      1,
      "retry exhaustion must create exactly one recovery token",
    );
    assert.doesNotMatch(
      parkMutation,
      /humanMessages\.(?:push|splice)|addRunMessage/,
      "a parked provider failure must not become duplicate Cora dialogue",
    );
  });

  console.log(`\n${passed} manager turn policy contract tests passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
