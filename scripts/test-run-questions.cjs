// Focused contract tests for linked run questions. Bundles the real shared
// resolver/normalizer and the pure main-process blocker policy with esbuild, so
// no Electron or run-store dependency graph is involved.
//
//   node scripts/test-run-questions.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED = path.join(ROOT, "src", "shared", "run-questions.ts");
const POLICY = path.join(ROOT, "src", "main", "orchestration", "run-question-policy.ts");
const TIMELINE = path.join(ROOT, "src", "renderer", "src", "components", "chat", "timeline.ts");
const WORKER_INVENTORY = path.join(
  ROOT,
  "src",
  "renderer",
  "src",
  "components",
  "automations",
  "useAutomationWorkers.ts",
);

async function loadContract() {
  const out = await esbuild.build({
    stdin: {
      contents:
        `export * from ${JSON.stringify(SHARED)};\n` +
        `export * from ${JSON.stringify(POLICY)};\n` +
        `export { buildChatTimeline } from ${JSON.stringify(TIMELINE)};\n` +
        `export { toLingeringAutomationWorker } from ${JSON.stringify(WORKER_INVENTORY)};`,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const at = (second) => `2026-07-13T12:00:${String(second).padStart(2, "0")}.000Z`;
const question = (id, second, extra = {}) => ({
  id,
  runId: "run-1",
  author: "spark",
  kind: "question",
  message: `Question ${id}`,
  createdAt: at(second),
  attachments: [],
  ...extra,
});
const answer = (id, questionMessageId, text, second, extra = {}) => ({
  id,
  runId: "run-1",
  author: "user",
  kind: "answer",
  message: text,
  answersMessageId: questionMessageId,
  createdAt: at(second),
  attachments: [],
  ...extra,
});
const note = (id, text, second, extra = {}) => ({
  id,
  runId: "run-1",
  author: "user",
  kind: "note",
  message: text,
  createdAt: at(second),
  attachments: [],
  ...extra,
});

function run(messages, extra = {}) {
  return {
    id: "run-1",
    workspaceId: "ws-1",
    title: "Question contract",
    status: "blocked",
    artifactDir: "/tmp/run-1",
    createdAt: at(0),
    updatedAt: at(0),
    plans: [],
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    sparkCalls: [],
    humanMessages: messages,
    autopilot: { status: "blocked", updatedAt: at(0) },
    ...extra,
  };
}

async function main() {
  const Q = await loadContract();
  let passed = 0;
  const test = (name, fn) => {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  test("answer draft scope changes on run, question, and external resolution", () => {
    const current = Q.runQuestionDraftScopeKey("run-1", "q1");
    assert.notEqual(Q.runQuestionDraftScopeKey("run-2", "q1"), current);
    assert.notEqual(Q.runQuestionDraftScopeKey("run-1", "q2"), current);
    assert.notEqual(Q.runQuestionDraftScopeKey("run-1", undefined), current);
  });

  test("lingering terminal workers cannot retain a resolved actionable question", () => {
    const lingering = Q.toLingeringAutomationWorker({
      attemptId: "attempt-owner",
      status: "succeeded",
      blocked: true,
      question: "Which target?",
      questionMessageId: "question-owner",
    });
    assert.equal(lingering.status, "succeeded");
    assert.equal(lingering.blocked, false);
    assert.equal(lingering.question, undefined);
    assert.equal(lingering.questionMessageId, undefined);
  });

  test("linked answer closes only its own question; notes close none", () => {
    const q1 = question("q1", 1);
    const q2 = question("q2", 2);
    const messages = [q1, q2, note("n1", "unrelated update", 3), answer("a1", "q1", "Allow", 4)];
    assert.deepEqual(Q.unresolvedRunQuestions(messages).map((m) => m.id), ["q2"]);
    const state = run(messages, {
      blockedOn: {
        questionMessageId: "q2",
        category: "irreducible_product_scope",
        previousStatus: "running",
        resumeStatus: "running",
        source: "manager_decision",
        resumeStrategy: "schedule_manager",
        blockedAt: at(2),
      },
    });
    assert.equal(Q.resolveOpenRunQuestion(state)?.id, "q2");
  });

  test("same text survives for different question ids and dedupes for one id", () => {
    const messages = [
      answer("a1", "q1", "Allow", 1),
      answer("a2", "q2", "Allow", 2),
      answer("a3", "q2", "Allow", 3),
    ];
    const deduped = Q.dedupeHumanRunMessages(messages);
    assert.deepEqual(deduped.map((m) => m.id), ["a1", "a2"]);
  });

  test("equal question text survives with distinct blocker identities", () => {
    const messages = [
      question("q1", 1, { message: "Choose a scope", clientMessageId: "question-1", loomNodeId: "A" }),
      question("q2", 2, { message: "Choose a scope", clientMessageId: "question-2", loomNodeId: "B" }),
    ];
    assert.deepEqual(Q.dedupeHumanRunMessages(messages).map((m) => m.id), ["q1", "q2"]);
    const timeline = Q.buildChatTimeline(run(messages));
    assert.deepEqual(
      timeline.filter((item) => item.kind === "message").map((item) => [item.id, item.repeatCount]),
      [["q1", 1], ["q2", 1]],
    );
  });

  test("timeline dedupe includes intent, target turn, and conversation epoch", () => {
    const messages = [
      note("s1", "Keep the API stable", 1, { intent: "steer", deliveryState: "queued", targetTurnId: "after:call-1", conversationEpoch: 0 }),
      note("s2", "Keep the API stable", 2, { intent: "steer", deliveryState: "submitted", targetTurnId: "after:call-1", conversationEpoch: 0 }),
      note("s3", "Keep the API stable", 3, { intent: "steer", deliveryState: "queued", targetTurnId: "after:call-2", conversationEpoch: 0 }),
      note("s4", "Keep the API stable", 4, { intent: "steer", deliveryState: "queued", targetTurnId: "after:call-2", conversationEpoch: 1 }),
      note("t1", "Keep the API stable", 5, { intent: "turn", deliveryState: "queued", conversationEpoch: 1 }),
    ];
    const timeline = Q.buildChatTimeline(run(messages, { conversationEpoch: 1 }));
    const rendered = timeline.filter((item) => item.kind === "message");
    assert.deepEqual(rendered.map((item) => [item.id, item.repeatCount]), [
      ["s1", 2],
      ["s3", 1],
      ["s4", 1],
      ["t1", 1],
    ]);
    assert.equal(rendered[0].intent, "steer");
    assert.equal(rendered[0].targetTurnId, "after:call-1");
    assert.equal(rendered[2].conversationEpoch, 1);
  });

  test("duplicate client message ids are idempotent", () => {
    const messages = [
      answer("a1", "q1", "Allow", 1, { clientMessageId: "client-1" }),
      answer("a2", "q2", "Allow", 2, { clientMessageId: "client-1" }),
    ];
    assert.deepEqual(Q.dedupeHumanRunMessages(messages).map((m) => m.id), ["a1"]);
  });

  test("legacy inference links only one unambiguous prior question", () => {
    const unlinked = { ...answer("a1", undefined, "Yes", 2) };
    delete unlinked.answersMessageId;
    const inferred = Q.inferLegacyRunAnswerLinks([question("q1", 1), unlinked]);
    assert.equal(inferred[1].answersMessageId, "q1");

    const ambiguous = { ...answer("a2", undefined, "Yes", 4) };
    delete ambiguous.answersMessageId;
    const notInferred = Q.inferLegacyRunAnswerLinks([
      question("q1", 1),
      question("q2", 2),
      note("n1", "still not an answer", 3),
      ambiguous,
    ]);
    assert.equal(notInferred[3].answersMessageId, undefined);
    assert.deepEqual(Q.unresolvedRunQuestions(notInferred).map((m) => m.id), ["q1", "q2"]);
  });

  test("legacy records dedupe before inference and direct Loom notes migrate narrowly", () => {
    const duplicateOne = { ...answer("a1", undefined, "Yes", 2) };
    const duplicateTwo = { ...answer("a2", undefined, "Yes", 3) };
    delete duplicateOne.answersMessageId;
    delete duplicateTwo.answersMessageId;
    const normalized = Q.normalizeHumanRunQuestionMessages([
      question("q1", 1),
      duplicateOne,
      duplicateTwo,
    ]);
    assert.deepEqual(normalized.map((m) => m.id), ["q1", "a1"]);
    assert.equal(normalized[1].answersMessageId, "q1");

    const loomMessages = Q.normalizeHumanRunQuestionMessages([
      question("lq1", 4, { message: "Which target?", loomNodeId: "A" }),
      note("ln1", "Allow", 5),
      question("lq2", 6, { message: "Which target?", loomNodeId: "B" }),
      note("ln2", "Allow", 7),
    ], { migrateLegacyDirectLoomNotes: true });
    assert.deepEqual(
      loomMessages
        .filter((m) => m.author === "user")
        .map((m) => [m.id, m.kind, m.answersMessageId, m.message]),
      [
        ["ln1", "answer", "lq1", "Allow"],
        ["ln2", "answer", "lq2", "Allow"],
      ],
    );

    const ambiguousLoom = Q.normalizeHumanRunQuestionMessages([
      question("lq1", 4, { loomNodeId: "A" }),
      question("lq2", 5, { loomNodeId: "B" }),
      note("ln1", "Use config.ts", 6),
    ], { migrateLegacyDirectLoomNotes: true });
    assert.equal(ambiguousLoom[2].kind, "note");
    assert.equal(ambiguousLoom[2].answersMessageId, undefined);

    const currentLoom = Q.normalizeHumanRunQuestionMessages([
      question("nq1", 8, { loomNodeId: "A", clientMessageId: "loom-question-run-1-A-att-1" }),
      note("nn1", "Unrelated note", 9),
    ], { migrateLegacyDirectLoomNotes: true });
    assert.equal(currentLoom[1].kind, "note");

    const consentLike = Q.normalizeHumanRunQuestionMessages([
      question("cq1", 10, { questionContext: { category: "destructive_irreversible", reason: "approval", source: "consent_gate" } }),
      note("cn1", "Allow", 11),
    ]);
    assert.equal(consentLike[1].kind, "note");
  });

  test("blocker retains source, status, manager stage, and resume strategy", () => {
    const state = run([question("q1", 1)], {
      status: "reviewing",
      autopilot: { status: "running", updatedAt: at(0) },
    });
    const blocker = Q.createRunBlocker({
      questionMessageId: "q1",
      category: "credentials_access",
      currentStatus: "reviewing",
      source: "manager_decision",
      resumeStrategy: "schedule_manager",
      managerMode: "worker_result_review",
      blockedAt: at(1),
    });
    Q.applyRunQuestionBlocker(state, blocker, "credentials required", at(1));
    assert.equal(state.status, "blocked");
    assert.equal(state.blockedOn.resumeStatus, "reviewing");
    assert.equal(state.blockedOn.source, "manager_decision");
    assert.equal(state.blockedOn.resumeStrategy, "schedule_manager");
    assert.equal(state.blockedOn.managerMode, "worker_result_review");

    const applied = Q.applyRunQuestionAnswer(
      state,
      answer("a1", "q1", "Use configured access", 2),
      at(2),
    );
    assert.equal(applied.blocker.resumeStrategy, "schedule_manager");
    assert.equal(state.blockedOn, undefined);
    assert.equal(state.status, "reviewing");
    assert.equal(state.autopilot.status, "running");
    assert.deepEqual(state.pendingManagerResume, {
      questionMessageId: "q1",
      managerMode: "worker_result_review",
      requestedAt: at(2),
      state: "pending",
    });
    assert.equal(
      Q.claimPendingManagerResume(state, "q1", "chat", "claim-wrong", at(3)),
      false,
    );
    assert.ok(state.pendingManagerResume);
    assert.equal(
      Q.claimPendingManagerResume(
        state,
        "q1",
        "worker_result_review",
        "claim-1",
        at(3),
      ),
      true,
    );
    assert.deepEqual(state.pendingManagerResume, {
      questionMessageId: "q1",
      managerMode: "worker_result_review",
      requestedAt: at(2),
      state: "launching",
      launchClaimId: "claim-1",
      launchClaimedAt: at(3),
    });
    assert.equal(
      Q.claimPendingManagerResume(
        state,
        "q1",
        "worker_result_review",
        "claim-2",
        at(4),
      ),
      false,
    );
  });

  test("manager resume survives every launch crash boundary without duplicate registration", () => {
    const makePending = () => {
      const state = run([question("q1", 1)], {
        status: "reviewing",
        autopilot: { status: "running", updatedAt: at(0) },
      });
      Q.applyRunQuestionBlocker(
        state,
        Q.createRunBlocker({
          questionMessageId: "q1",
          category: "credentials_access",
          currentStatus: "reviewing",
          source: "manager_decision",
          resumeStrategy: "schedule_manager",
          managerMode: "worker_result_review",
          blockedAt: at(1),
        }),
        "credentials required",
        at(1),
      );
      Q.applyRunQuestionAnswer(state, answer("a1", "q1", "Use configured access", 2), at(2));
      return state;
    };

    // Exit before claim: the pending record remains schedulable.
    const beforeClaim = makePending();
    assert.equal(Q.recoverPendingManagerResumeLease(beforeClaim), "pending");
    assert.equal(beforeClaim.pendingManagerResume.state, "pending");

    // Exit after pending -> launching but before any manager call registration:
    // startup returns the abandoned lease to pending for a safe retry.
    const beforeRegistration = makePending();
    assert.equal(
      Q.claimPendingManagerResume(
        beforeRegistration,
        "q1",
        "worker_result_review",
        "claim-abandoned",
        at(3),
      ),
      true,
    );
    assert.equal(Q.recoverPendingManagerResumeLease(beforeRegistration), "pending");
    assert.deepEqual(beforeRegistration.pendingManagerResume, {
      questionMessageId: "q1",
      managerMode: "worker_result_review",
      requestedAt: at(2),
      state: "pending",
    });

    // Exit after the manager SparkCall registered but before it completed:
    // registration alone is not proof the continuation landed. Startup returns
    // the lease to pending after orphan recovery so the answer is not lost.
    const afterRegistration = makePending();
    assert.equal(
      Q.claimPendingManagerResume(
        afterRegistration,
        "q1",
        "worker_result_review",
        "claim-registered",
        at(3),
      ),
      true,
    );
    afterRegistration.sparkCalls.push({
      id: "spark-1",
      runId: afterRegistration.id,
      mode: "worker_result_review",
      model: "test-manager",
      status: "started",
      managerResumeClaimId: "claim-registered",
      createdAt: at(4),
    });
    assert.equal(Q.recoverPendingManagerResumeLease(afterRegistration), "pending");
    assert.equal(afterRegistration.pendingManagerResume.state, "pending");

    // A completed call is durable proof that the resumed continuation landed.
    const afterCompletion = makePending();
    Q.claimPendingManagerResume(
      afterCompletion,
      "q1",
      "worker_result_review",
      "claim-completed",
      at(3),
    );
    afterCompletion.sparkCalls.push({
      id: "spark-complete",
      runId: afterCompletion.id,
      mode: "worker_result_review",
      model: "test-manager",
      status: "completed",
      managerResumeClaimId: "claim-completed",
      createdAt: at(4),
      completedAt: at(5),
    });
    assert.equal(Q.recoverPendingManagerResumeLease(afterCompletion), "registered");
    assert.equal(afterCompletion.pendingManagerResume, undefined);

    // Normal live path uses the same registration proof before clearing.
    const normal = makePending();
    Q.claimPendingManagerResume(normal, "q1", "worker_result_review", "claim-live", at(3));
    assert.equal(Q.clearRegisteredPendingManagerResume(normal, "claim-live"), false);
    normal.sparkCalls.push({
      id: "spark-2",
      runId: normal.id,
      mode: "worker_result_review",
      model: "test-manager",
      status: "started",
      managerResumeClaimId: "claim-live",
      createdAt: at(4),
    });
    assert.equal(Q.clearRegisteredPendingManagerResume(normal, "claim-live"), true);
    assert.equal(normal.pendingManagerResume, undefined);
  });

  test("mismatched and consumed question ids cannot change the answer", () => {
    const q1 = question("q1", 1);
    const q2 = question("q2", 2);
    const state = run([q1, q2], {
      blockedOn: {
        questionMessageId: "q2",
        category: "irreducible_product_scope",
        previousStatus: "running",
        resumeStatus: "running",
        source: "live_manager_rpc",
        resumeStrategy: "active_rpc",
        blockedAt: at(2),
      },
    });
    assert.throws(
      () => Q.applyRunQuestionAnswer(state, answer("a1", "q1", "one", 3), at(3)),
      /blocked on question q2/,
    );
    const first = Q.applyRunQuestionAnswer(state, answer("a2", "q2", "two", 4), at(4));
    assert.equal(first.blocker.resumeStrategy, "active_rpc");
    assert.equal(state.status, "running");
    const duplicate = Q.applyRunQuestionAnswer(state, answer("a3", "q2", "two", 5), at(5));
    assert.equal(duplicate.duplicate, true);
    assert.equal(state.humanMessages.filter((m) => m.kind === "answer").length, 1);
    assert.throws(
      () => Q.applyRunQuestionAnswer(state, answer("a4", "q2", "different", 6), at(6)),
      /already been answered/,
    );
  });

  test("pause/cancel own the run and stale release or answer cannot resurrect it", () => {
    const makeBlocked = () => run([question("q1", 1)], {
      blockedOn: {
        questionMessageId: "q1",
        category: "irreducible_product_scope",
        previousStatus: "running",
        resumeStatus: "running",
        source: "live_manager_rpc",
        resumeStrategy: "active_rpc",
        blockedAt: at(1),
      },
    });

    const paused = makeBlocked();
    Q.abandonRunQuestionOwnership(paused);
    paused.status = "paused";
    assert.equal(Q.releaseRunQuestionBlocker(paused, "q1", at(2)), false);
    assert.equal(paused.status, "paused");
    assert.throws(
      () => Q.applyRunQuestionAnswer(paused, answer("a1", "q1", "yes", 3), at(3)),
      /no longer active/,
    );

    const cancelled = makeBlocked();
    Q.abandonRunQuestionOwnership(cancelled);
    cancelled.status = "cancelled";
    assert.equal(Q.releaseRunQuestionBlocker(cancelled, "q1", at(2)), false);
    assert.throws(
      () => Q.applyRunQuestionAnswer(cancelled, answer("a2", "q1", "Allow", 3), at(3)),
      /no longer active/,
    );

    const wrongOwner = makeBlocked();
    assert.equal(Q.releaseRunQuestionBlocker(wrongOwner, "old-q", at(2)), false);
    assert.equal(wrongOwner.status, "blocked");
    assert.equal(Q.releaseRunQuestionBlocker(wrongOwner, "q1", at(3)), true);
    assert.equal(wrongOwner.status, "running");
  });

  test("direct Loom report blocker stays blocked for the loop answer seam", () => {
    const state = run([question("q1", 1)], {
      executionMode: "direct",
      automationId: "loom-1",
    });
    const applied = Q.applyRunQuestionAnswer(state, answer("a1", "q1", "continue", 2), at(2));
    assert.equal(applied.blocker, undefined);
    assert.equal(state.status, "blocked");
  });

  test("legacy managed blocker restores and requests manager scheduling", () => {
    const state = run([question("q1", 1)]);
    const applied = Q.applyRunQuestionAnswer(state, answer("a1", "q1", "continue", 2), at(2));
    assert.equal(applied.blocker.resumeStrategy, "schedule_manager");
    assert.equal(state.status, "running");
    assert.equal(state.pendingManagerResume.managerMode, "plan_analysis");
  });

  console.log(`\n${passed} run-question contract tests passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
