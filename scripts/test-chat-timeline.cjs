// Contract tests for the chat timeline's retry lineage: how a worker whose
// attempt died environmentally reads while its replacement is still queued.
// Bundles the real renderer module with esbuild, so no React runtime, no
// Electron, and no main-process orchestration is involved.
//
//   node scripts/test-chat-timeline.cjs
//
// The fixture mirrors run-ms0lod1m-h3pqoo: five Claude workers whose OAuth
// refresh failed, each cancelled and superseded by a Codex replacement on
// gpt-5.6-sol, with the replacements in every stage (accepted, in review,
// attempt in flight, still queued).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const CHAT_CONVERSATION = path.join(
  ROOT, "src", "renderer", "src", "components", "chat", "ChatConversation.tsx",
);
const TIMELINE = path.join(ROOT, "src", "renderer", "src", "components", "chat", "timeline.ts");
const TOOL_LABELS = path.join(ROOT, "src", "renderer", "src", "components", "chat", "tool-labels.ts");
const RUN_FORMAT = path.join(ROOT, "src", "renderer", "src", "components", "runs", "run-format.ts");

async function loadContract() {
  const out = await esbuild.build({
    stdin: {
      contents:
        `export * from ${JSON.stringify(TIMELINE)};\n` +
        `export { waitForWorkersTaskIds } from ${JSON.stringify(TOOL_LABELS)};\n` +
        // The run graph's own projection: the chip, the chat row and the graph
        // node must agree on what counts as a running worker.
        `export { deriveAgentStatus, attemptStatusColor } from ${JSON.stringify(RUN_FORMAT)};`,
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

const at = (second) => `2026-07-25T16:45:${String(second).padStart(2, "0")}.000Z`;

function task(id, extra = {}) {
  return {
    id,
    runId: "run-1",
    stepId: "step-1",
    title: "Untitled",
    description: "",
    runtimePreference: "claude",
    status: "queued",
    allowedPaths: [],
    forbiddenPaths: [],
    expectedOutputs: [],
    verificationCommands: [],
    canRunParallel: true,
    conflictsWith: [],
    createdBy: "spark",
    createdAt: at(50),
    updatedAt: at(50),
    ...extra,
  };
}

function attempt(id, workerTaskId, extra = {}) {
  return {
    id,
    runId: "run-1",
    workerTaskId,
    attemptNumber: 1,
    runtime: "claude",
    cwd: "/tmp/ws",
    status: "failed",
    startedAt: at(50),
    ...extra,
  };
}

// One lineage: a Claude task cancelled after an environmental failure, plus a
// Codex replacement in the given state.
function lineage(title, key, replacement, replacementAttempt) {
  const deadId = `task-${key}-dead`;
  const liveId = `task-${key}-live`;
  const tasks = [
    task(deadId, { title, status: "cancelled", updatedAt: at(53) }),
    task(liveId, {
      title,
      supersedesTaskId: deadId,
      runtimePreference: "codex",
      modelHint: "gpt-5.6-sol",
      createdBy: "system",
      createdAt: at(53),
      updatedAt: at(53),
      ...replacement,
    }),
  ];
  const attempts = [
    attempt(`attempt-${key}-1`, deadId, {
      model: "claude-opus-5",
      exitCode: 1,
      error: "OAuth refresh failed for anthropic",
      finishedAt: at(52),
    }),
  ];
  if (replacementAttempt) {
    attempts.push(
      attempt(`attempt-${key}-2`, liveId, {
        runtime: "codex",
        model: "gpt-5.6-sol",
        startedAt: at(56),
        ...replacementAttempt,
      }),
    );
  }
  return { tasks, attempts, deadId, liveId };
}

function run(parts, extra = {}) {
  const workerTasks = parts.flatMap((part) => part.tasks);
  const workerAttempts = parts.flatMap((part) => part.attempts);
  return {
    id: "run-1",
    workspaceId: "ws-1",
    title: "Research",
    status: "running",
    artifactDir: "/tmp/run-1",
    createdAt: at(24),
    updatedAt: at(56),
    plans: [],
    steps: [
      {
        id: "step-1",
        runId: "run-1",
        index: 1,
        title: "Cora workers (5)",
        goal: "Research the news",
        kind: "worker_batch",
        status: "running",
        plannedAgents: [],
        acceptanceCriteria: [],
        verificationCommands: [],
        workerTaskIds: workerTasks.map((entry) => entry.id),
        createdAt: at(49),
        updatedAt: at(56),
      },
    ],
    workerTasks,
    workerAttempts,
    sparkCalls: [],
    humanMessages: [],
    autopilot: { status: "running", updatedAt: at(56) },
    ...extra,
  };
}

// The five-worker wave, exactly as the evidence run left it.
function wave() {
  return {
    accepted: lineage("Global markets news", "markets", { status: "accepted" }, {
      status: "succeeded",
      exitCode: 0,
      finishedAt: at(59),
    }),
    review: lineage("Central banks and rates", "banks", { status: "needs_review" }, {
      status: "failed",
      exitCode: 1,
      error: "Pi worker runtime stopped.",
      finishedAt: at(59),
    }),
    // An attempt that has been prepared but not launched: no model, no clock.
    inFlight: lineage("Currencies and commodities", "fx", { status: "queued" }, {
      status: "prompt_ready",
      model: undefined,
      startedAt: undefined,
    }),
    queuedA: lineage("Crypto and financial risk", "crypto", { status: "queued" }, null),
    queuedB: lineage("Companies and sectors", "companies", { status: "queued" }, null),
  };
}

function step(id, index, title, status, workerTaskIds) {
  return {
    id,
    runId: "run-1",
    index,
    title,
    goal: title,
    kind: "worker_batch",
    status,
    plannedAgents: [],
    acceptanceCriteria: [],
    verificationCommands: [],
    workerTaskIds,
    createdAt: at(49),
    updatedAt: at(56),
  };
}

function workerRows(timeline) {
  return timeline.filter((item) => item.kind === "tool" && item.activity === "worker");
}

function rowFor(timeline, title) {
  const match = workerRows(timeline).filter((item) => item.title === title);
  assert.equal(match.length, 1, `expected exactly one row titled "${title}", got ${match.length}`);
  return match[0];
}

async function main() {
  const T = await loadContract();
  let passed = 0;
  const test = (name, fn) => {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  const digestRun = (id, status, extra = {}) =>
    run([], { id, title: id, status, steps: [], seen: true, ...extra });

  test("a direct message with a matching worker is delivered, not queued", () => {
    const message = {
      id: "msg-direct",
      runId: "run-direct",
      author: "user",
      kind: "note",
      message: "hello",
      intent: "steer",
      deliveryState: "queued",
      createdAt: at(25),
    };
    const state = run([], {
      id: "run-direct",
      executionMode: "direct",
      humanMessages: [message],
      workerTasks: [task("task-direct", {
        description: "hello",
        status: "running",
        createdAt: at(26),
      })],
    });
    assert.equal(T.effectiveMessageDeliveryState(state, message), "acknowledged");
    const rendered = T.buildChatTimeline(state).find((item) => item.id === message.id);
    assert.equal(rendered.deliveryState, "acknowledged");
  });

  test("a direct message without a worker remains genuinely queued", () => {
    const message = {
      id: "msg-waiting",
      runId: "run-direct",
      author: "user",
      kind: "note",
      message: "follow up",
      intent: "steer",
      deliveryState: "queued",
      createdAt: at(25),
    };
    const state = run([], {
      id: "run-direct",
      executionMode: "direct",
      humanMessages: [message],
      workerTasks: [],
    });
    assert.equal(T.effectiveMessageDeliveryState(state, message), "queued");
  });

  test("away digest includes only attention states that changed after baseline", () => {
    const blockedBefore = digestRun("blocked-before", "blocked");
    const changedToBlocked = digestRun("changed", "running");
    const newlyFinished = digestRun("finished", "running");
    const baseline = T.captureAwayDigestBaseline([
      blockedBefore,
      changedToBlocked,
      newlyFinished,
    ]);
    changedToBlocked.status = "blocked";
    newlyFinished.status = "complete";
    newlyFinished.seen = false;

    const digest = T.buildAwayDigest(
      [blockedBefore, changedToBlocked, newlyFinished],
      baseline,
      null,
    );
    assert.deepEqual(digest.needsYou.map((entry) => entry.id), ["changed"]);
    assert.deepEqual(digest.doneUnseen.map((entry) => entry.id), ["finished"]);
    assert.equal(digest.total, 2);
  });

  test("away digest does not open for a working-only transition", () => {
    const working = digestRun("working", "queued");
    const baseline = T.captureAwayDigestBaseline([working]);
    working.status = "running";
    const digest = T.buildAwayDigest([working], baseline, null);
    assert.equal(digest.total, 0);
    assert.deepEqual(digest.needsYou, []);
    assert.deepEqual(digest.doneUnseen, []);
    assert.deepEqual(digest.working.map((entry) => entry.id), ["working"]);
  });

  test("away digest excludes the run surface visible on focus", () => {
    const visible = digestRun("visible", "running");
    const background = digestRun("background", "running");
    const baseline = T.captureAwayDigestBaseline([visible, background]);
    visible.status = "blocked";
    background.status = "blocked";
    const digest = T.buildAwayDigest([visible, background], baseline, "visible");
    assert.deepEqual(digest.needsYou.map((entry) => entry.id), ["background"]);
    assert.equal(digest.total, 1);
  });

  test("away digest pruning preserves unvisited origins and closes when empty", () => {
    const first = digestRun("first", "blocked");
    const second = digestRun("second", "complete", { seen: false });
    const third = digestRun("third", "running");
    const digest = {
      total: 2,
      needsYou: [first],
      doneUnseen: [second],
      working: [third],
    };
    const withoutWorking = T.pruneAwayDigest(digest, "third");
    assert.equal(withoutWorking.total, 2);
    assert.deepEqual(withoutWorking.working, []);
    const afterFirst = T.pruneAwayDigest(digest, "first");
    assert.equal(afterFirst.total, 1);
    assert.deepEqual(afterFirst.doneUnseen.map((entry) => entry.id), ["second"]);
    assert.deepEqual(afterFirst.working.map((entry) => entry.id), ["third"]);
    assert.equal(T.pruneAwayDigest(afterFirst, "second"), null);
  });

  test("a superseded failure reads as a retry, not a dead end", () => {
    const parts = wave();
    const timeline = T.buildChatTimeline(run(Object.values(parts)));
    const row = rowFor(timeline, "Crypto and financial risk");
    assert.equal(row.status, "queued");
    assert.equal(row.tone, "queued");
    assert.deepEqual(row.pending, { state: "queued", model: "Sol", number: 2 });
    assert.match(row.detail, /^retrying on Sol · attempt 2 of 3/);
    // The cause of the failure survives as history, not as the row's verdict.
    assert.match(row.detail, /OAuth refresh failed for anthropic/);
    // Nothing is running, so the row must not tick or claim a duration.
    assert.equal(row.startedAt, undefined);
    assert.equal(T.isToolRowTicking(row), false);
    assert.equal(row.meta.some((meta) => meta.label === "Duration"), false);
  });

  test("the queued replacement's own beat is in the attempt lineage", () => {
    const parts = wave();
    const timeline = T.buildChatTimeline(run(Object.values(parts)));
    const row = rowFor(timeline, "Companies and sectors");
    assert.deepEqual(
      row.attempts.map((entry) => [entry.number, entry.outcome, entry.failed, entry.pending === true]),
      [
        [1, "failed", true, false],
        [2, "queued on Sol", false, true],
      ],
    );
  });

  test("one lineage row per title, keyed on the root task so supersedes never churns the key", () => {
    const parts = wave();
    const timeline = T.buildChatTimeline(run(Object.values(parts)));
    const rows = workerRows(timeline);
    assert.equal(rows.length, 5);
    assert.deepEqual(
      [...new Set(rows.map((item) => item.title))].sort(),
      [
        "Central banks and rates",
        "Companies and sectors",
        "Crypto and financial risk",
        "Currencies and commodities",
        "Global markets news",
      ],
    );
    assert.equal(rowFor(timeline, "Crypto and financial risk").id, "worker:task-crypto-dead");

    // The same worker before its replacement existed: still the same row id.
    const beforeFallback = run([
      {
        tasks: [parts.queuedA.tasks[0]],
        attempts: parts.queuedA.attempts,
      },
    ]);
    const earlier = T.buildChatTimeline(beforeFallback);
    assert.equal(rowFor(earlier, "Crypto and financial risk").id, "worker:task-crypto-dead");
  });

  test("attempt denominators match the run inspector's cap", () => {
    const timeline = T.buildChatTimeline(run(Object.values(wave())));
    // The replacement's attempt is prompt_ready: prepared, never spawned. It
    // reads queued, not live — the row must not paint an agent that does not
    // exist (the terminal behind it would be an empty shell).
    const inFlight = rowFor(timeline, "Currencies and commodities");
    assert.equal(inFlight.status, "queued");
    assert.equal(inFlight.tone, "queued");
    assert.equal(T.isToolRowTicking(inFlight), false);
    // The attempt has not launched and reports no model; the row names what
    // its task will run rather than falling back to the runtime ("Codex").
    assert.equal(inFlight.detail, "Sol · attempt 2 of 3");
    const accepted = rowFor(timeline, "Global markets news");
    assert.equal(accepted.status, "completed");
    assert.equal(accepted.detail, "Sol · attempt 2 of 3");
    assert.equal(T.workerAttemptDenominator(2), 3);
    // A lineage that somehow ran past the cap widens rather than lying.
    assert.equal(T.workerAttemptDenominator(4), 4);
  });

  test("a worker that has never run still gets a queued row", () => {
    const fresh = {
      tasks: [
        task("task-fresh", {
          title: "Crypto and financial risk",
          runtimePreference: "codex",
          modelHint: "gpt-5.6-sol",
          status: "queued",
        }),
      ],
      attempts: [],
    };
    const timeline = T.buildChatTimeline(run([fresh]));
    const row = rowFor(timeline, "Crypto and financial risk");
    assert.equal(row.status, "queued");
    assert.deepEqual(row.pending, { state: "queued", model: "Sol", number: 1 });
    assert.equal(row.detail, "Sol · queued");
    // A first attempt is not a retry, so no lineage list is offered.
    assert.equal(row.attempts.length, 1);
  });

  test("a claimed task reads as starting rather than queued", () => {
    const claimed = {
      tasks: [
        task("task-claimed", {
          title: "Global markets news",
          runtimePreference: "codex",
          modelHint: "gpt-5.6-sol",
          status: "claimed",
        }),
      ],
      attempts: [],
    };
    const row = rowFor(T.buildChatTimeline(run([claimed])), "Global markets news");
    assert.deepEqual(row.pending, { state: "starting", model: "Sol", number: 1 });
    assert.equal(row.detail, "Sol · starting");
  });

  test("a terminal worker keeps its failed row", () => {
    const dead = {
      tasks: [task("task-dead", { title: "Central banks and rates", status: "failed" })],
      attempts: [
        attempt("attempt-dead", "task-dead", {
          model: "claude-opus-5",
          exitCode: 1,
          error: "OAuth refresh failed for anthropic",
          finishedAt: at(52),
        }),
      ],
    };
    const row = rowFor(T.buildChatTimeline(run([dead])), "Central banks and rates");
    assert.equal(row.status, "failed");
    assert.equal(row.tone, "failed");
    assert.equal(row.pending, undefined);
  });

  test("a provider help page never becomes the row's detail", () => {
    const sprawling = [
      "No API key found for anthropic.",
      "",
      "Use /login to log into a provider via OAuth or API key. See:",
      "  /very/long/path/to/node_modules/@earendil-works/pi-coding-agent/docs/providers.md",
      "  /very/long/path/to/node_modules/@earendil-works/pi-coding-agent/docs/models.md",
    ].join("\n");
    const parts = wave();
    parts.queuedA.attempts[0].error = sprawling;
    parts.review.attempts[1].error = sprawling;
    const timeline = T.buildChatTimeline(run(Object.values(parts)));
    for (const title of ["Crypto and financial risk", "Central banks and rates"]) {
      const detail = rowFor(timeline, title).detail;
      assert.equal(detail.includes("\n"), false, `${title} detail must stay one line`);
      assert.ok(detail.length <= 180, `${title} detail must stay short, got ${detail.length}`);
      assert.match(detail, /No API key found for anthropic\./);
      assert.match(detail, /\.\.\.$/);
    }
  });

  test("step worker chips follow the replacement's model, never the dead attempt's", () => {
    const timeline = T.buildChatTimeline(run(Object.values(wave())));
    const step = timeline.find((item) => item.kind === "step");
    assert.equal(step.workers.length, 5);
    const crypto = step.workers.find((worker) => worker.title === "Crypto and financial risk");
    assert.equal(crypto.model, "gpt-5.6-sol");
    assert.equal(crypto.status, "queued");
    assert.equal(crypto.pending.number, 2);
    assert.equal(crypto.id, "task-crypto-dead");
  });

  test("step worker rows carry measured file and line changes", () => {
    const parts = wave();
    parts.accepted.attempts[1].diffSummary = {
      fileCount: 2,
      additions: 18,
      deletions: 4,
      files: [
        { path: "src/App.tsx", additions: 12, deletions: 3 },
        { path: "src/styles.css", additions: 6, deletions: 1 },
      ],
    };
    const timeline = T.buildChatTimeline(run(Object.values(parts)));
    const stepItem = timeline.find((item) => item.kind === "step");
    const worker = stepItem.workers.find((item) => item.title === "Global markets news");
    assert.deepEqual(worker.diff, parts.accepted.attempts[1].diffSummary);
  });

  test("a wait row counts replacements, not the dead tasks it was handed", () => {
    const parts = wave();
    const state = run(Object.values(parts));
    // Cora waits on the ids it spawned; every one of them is now cancelled and
    // superseded, so a naive count would report five failures.
    const requested = Object.values(parts).map((part) => part.deadId);
    const summary = T.summarizeWorkerWait(state, requested);
    assert.deepEqual(
      {
        total: summary.total,
        running: summary.running,
        queued: summary.queued,
        retrying: summary.retrying,
        settled: summary.settled,
        failed: summary.failed,
      },
      { total: 5, running: 1, queued: 0, retrying: 2, settled: 2, failed: 0 },
    );
    assert.equal(summary.label, "1 running · 2 queued for retry · 2 done");
    // Asking by the replacement id resolves to the same logical worker, so a
    // mixed id list never double-counts.
    const mixed = T.summarizeWorkerWait(state, [parts.queuedA.deadId, parts.queuedA.liveId]);
    assert.equal(mixed.total, 1);
    assert.equal(mixed.label, "1 queued for retry");
    assert.equal(T.summarizeWorkerWait(state, ["task-unknown"]), null);
  });

  // Fixture distilled from run-ms61c4lt-5bmkjt: one manager turn spans a
  // blocking question (asked 16:45:30, answered 16:45:34), keeps working
  // (workers at :40/:44), and dies at :50 with a provider overload. Rendered
  // as a single row anchored at the turn's start, everything after the answer
  // sat ABOVE the question and answer bubbles.
  function questionSpanningRun() {
    const call = {
      id: "spark-1",
      runId: "run-1",
      mode: "chat",
      model: "gpt-5.6-sol",
      status: "failed",
      error: "Codex error: Our servers are currently overloaded. Please try again later.",
      durationMs: 391_849,
      promptTokens: 26_971,
      createdAt: at(26),
      completedAt: at(50),
      conversationEpoch: 0,
    };
    const messages = [
      {
        id: "msg-user",
        runId: "run-1",
        author: "user",
        kind: "note",
        message: "make the translation automation",
        // The turn below was started BY this message, so the run store has
        // claimed it: backendTurnId names the call and delivery has settled.
        // Left "queued" it would be an undelivered note, which the timeline
        // now (correctly) files at the bottom instead of at its timestamp.
        deliveryState: "acknowledged",
        intent: "turn",
        targetTurnId: "spark-1",
        backendTurnId: "spark-1",
        conversationEpoch: 0,
        createdAt: at(25),
      },
      {
        id: "msg-question",
        runId: "run-1",
        author: "spark",
        kind: "question",
        message: "Approve this folder translation automation?",
        questionOptions: [],
        intent: "answer",
        deliveryState: "acknowledged",
        conversationEpoch: 0,
        createdAt: at(30),
      },
      {
        id: "msg-answer",
        runId: "run-1",
        author: "user",
        kind: "answer",
        message: "Approve and create.",
        answersMessageId: "msg-question",
        targetTurnId: "question:msg-question",
        intent: "answer",
        deliveryState: "acknowledged",
        conversationEpoch: 0,
        createdAt: at(34),
      },
      {
        id: "msg-final",
        runId: "run-1",
        author: "spark",
        kind: "note",
        message: "Automation created and enabled.",
        intent: "answer",
        deliveryState: "acknowledged",
        targetTurnId: "spark-1",
        backendTurnId: "spark-1",
        conversationEpoch: 0,
        createdAt: at(50),
      },
    ];
    return run([], { sparkCalls: [call], humanMessages: messages, steps: [] });
  }

  test("a mid-turn question splits the manager turn at the answer", () => {
    const timeline = T.buildChatTimeline(questionSpanningRun());
    const order = timeline.map((item) => item.id);
    // True chronology: the question renders where it was asked, the answer
    // right after it, and the turn's post-answer slice below them both.
    assert.deepEqual(order, [
      "msg-user",
      "spark-call:spark-1",
      "msg-question",
      "msg-answer",
      "spark-call:spark-1:seg1",
      "msg-final",
    ]);

    const head = timeline.find((item) => item.id === "spark-call:spark-1");
    assert.equal(head.sparkCallId, "spark-1");
    // The pre-question slice is settled history, not the turn's failure.
    assert.equal(head.status, "completed");
    assert.equal(head.tone, "done");
    assert.equal(head.title, "Worked");
    assert.deepEqual(head.traceWindow, { from: undefined, to: at(30) });
    // Whole-turn gauges ride the final slice only.
    assert.equal(head.meta.some((meta) => meta.label === "Duration"), false);

    const tail = timeline.find((item) => item.id === "spark-call:spark-1:seg1");
    assert.equal(tail.sparkCallId, "spark-1");
    assert.equal(tail.status, "failed");
    assert.equal(tail.tone, "failed");
    assert.equal(tail.title, "Turn failed");
    assert.match(tail.detail, /currently overloaded/);
    assert.deepEqual(tail.traceWindow, { from: at(30) });
    assert.equal(tail.at, at(34), "the continuation re-anchors at the answer");
    assert.equal(tail.meta.some((meta) => meta.label === "Duration"), true);
  });

  test("an open question still holds the turn's continuation below it", () => {
    const state = questionSpanningRun();
    // The user has not answered yet and the turn is still streaming.
    state.humanMessages = state.humanMessages.filter((message) => message.id !== "msg-answer" && message.id !== "msg-final");
    state.sparkCalls[0].status = "started";
    delete state.sparkCalls[0].completedAt;
    delete state.sparkCalls[0].error;
    const timeline = T.buildChatTimeline(state);
    assert.deepEqual(
      timeline.map((item) => item.id),
      ["msg-user", "spark-call:spark-1", "msg-question", "spark-call:spark-1:seg1"],
    );
    const head = timeline.find((item) => item.id === "spark-call:spark-1");
    assert.equal(head.status, "completed", "the pre-question slice reads settled while the turn lives on");
    const tail = timeline.find((item) => item.id === "spark-call:spark-1:seg1");
    assert.equal(tail.status, "started");
    assert.equal(tail.tone, "live");
    assert.equal(tail.at, at(30), "unanswered questions anchor the continuation at the ask");
  });

  test("a turn without questions stays one unsplit row", () => {
    const state = questionSpanningRun();
    state.humanMessages = state.humanMessages.filter(
      (message) => message.id === "msg-user" || message.id === "msg-final",
    );
    const timeline = T.buildChatTimeline(state);
    const rows = timeline.filter((item) => item.kind === "tool" && item.activity === "manager");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "spark-call:spark-1");
    assert.equal(rows[0].sparkCallId, "spark-1");
    assert.equal(rows[0].traceWindow, undefined);
    assert.equal(rows[0].title, "Turn failed");
  });

  // Synthetic notes (the board nudge, the pause-resume note) are authored
  // "user" only so the next manager turn consumes them as its input. Their
  // bodies are never rendered as user prose: board notes get a system row;
  // standalone Resume gets a compact action; message-triggered Resume folds
  // into the real message.
  function syntheticNoteRun(id, flag, message, noteOverrides = {}, userOverrides = {}) {
    return run([], {
      steps: [],
      humanMessages: [
        {
          id: "msg-user",
          runId: "run-1",
          author: "user",
          kind: "note",
          message: "build the parser",
          deliveryState: "acknowledged",
          intent: "turn",
          conversationEpoch: 0,
          createdAt: at(25),
          ...userOverrides,
        },
        {
          id,
          runId: "run-1",
          author: "user",
          kind: "note",
          [flag]: true,
          message,
          deliveryState: "queued",
          intent: "turn",
          conversationEpoch: 0,
          createdAt: at(30),
          ...noteOverrides,
        },
      ],
    });
  }

  const RESUME_NOTE_BODY = [
    "[Cora resume — worker attempts interrupted by the pause]",
    "Resume this run. The pause stopped the attempts below before they finished, and nothing is running now:",
    '- Step 3 "Wire the parser" · Implement the tokenizer — task task-parser, attempt attempt-a (attempt #1, interrupted)',
    '- Step 3 "Wire the parser" · Wire the lexer — task task-lexer, attempt attempt-b (attempt #2, interrupted)',
    "Re-issue the work that is still needed (relaunch those tasks, or replace them if the plan changed), then carry on.",
  ].join("\n");

  test("the resume note renders as the user's own Resume bubble (undoable turn)", () => {
    const timeline = T.buildChatTimeline(
      syntheticNoteRun("msg-resume", "resumeNote", RESUME_NOTE_BODY),
    );
    // The resume is a first-class user turn: id kept as the MESSAGE id so the
    // user-message checkpoint recorded at resume time attaches the standard
    // Undo control. The technical note body never leaks into the bubble —
    // display text is the compact Resume summary.
    const bubble = timeline.find((item) => item.kind === "message" && item.id === "msg-resume");
    assert.ok(bubble, "the resume note must render as a chat message");
    assert.equal(bubble.author, "user");
    assert.equal(bubble.text, "Resume — hand 2 interrupted attempts back to Cora");
    assert.equal(bubble.at, at(30));
    assert.equal(
      timeline.some((item) => item.id === "resume-note:msg-resume"),
      false,
      "the old system row must not render alongside the bubble",
    );
    // The real user turn beside it is untouched.
    const user = timeline.find((item) => item.kind === "message" && item.id === "msg-user");
    assert.equal(user.author, "user");
    assert.equal(user.text, "build the parser");
  });

  test("the resume note counts the attempts its cap collapsed", () => {
    const capped = [
      "[Cora resume — worker attempts interrupted by the pause]",
      "Resume this run. The pause stopped the attempts below before they finished, and nothing is running now:",
      "- Step 1 \"A\" · one — task task-a, attempt attempt-a (attempt #1, interrupted)",
      "- …and 4 more interrupted attempt(s).",
      "Re-issue the work that is still needed, then carry on.",
    ].join("\n");
    const timeline = T.buildChatTimeline(syntheticNoteRun("msg-capped", "resumeNote", capped));
    const bubble = timeline.find((item) => item.kind === "message" && item.id === "msg-capped");
    assert.equal(bubble.text, "Resume — hand 5 interrupted attempts back to Cora");
  });

  test("a plain resume note (no interrupted attempts) renders as a bare Resume bubble", () => {
    const timeline = T.buildChatTimeline(
      syntheticNoteRun(
        "msg-plain-resume",
        "resumeNote",
        "The user resumed this run. Continue from the current durable state of the plan and conversation.",
      ),
    );
    const bubble = timeline.find(
      (item) => item.kind === "message" && item.id === "msg-plain-resume",
    );
    assert.ok(bubble, "the plain resume note must render as a chat message");
    assert.equal(bubble.author, "user");
    assert.equal(bubble.text, "Resume");
  });

  test("sending into a paused run does not add a second Resume bubble", () => {
    const timeline = T.buildChatTimeline(
      syntheticNoteRun(
        "msg-linked-resume",
        "resumeNote",
        "The user resumed this run. Continue from the current durable state of the plan and conversation.",
        { resumesMessageId: "msg-user" },
      ),
    );
    assert.equal(
      timeline.some((item) => item.kind === "message" && item.id === "msg-linked-resume"),
      false,
      "the internal recovery note must fold into the message that resumed the run",
    );
    assert.equal(
      timeline.find((item) => item.kind === "message" && item.id === "msg-user")?.text,
      "build the parser",
    );
  });

  test("old linked resume notes are recognized by their shared backend turn", () => {
    const timeline = T.buildChatTimeline(
      syntheticNoteRun(
        "msg-legacy-linked-resume",
        "resumeNote",
        "The user resumed this run. Continue from the current durable state of the plan and conversation.",
        { backendTurnId: "spark-shared" },
        { backendTurnId: "spark-shared" },
      ),
    );
    assert.equal(
      timeline.some(
        (item) => item.kind === "message" && item.id === "msg-legacy-linked-resume",
      ),
      false,
    );
  });

  test("the board note keeps its own system row (the pattern resume notes copy)", () => {
    const body = [
      "[Cora Board — queued cards waiting for you]",
      "- Card one",
      "- Card two",
      "- Card three",
    ].join("\n");
    const timeline = T.buildChatTimeline(syntheticNoteRun("msg-board", "boardNote", body));
    assert.equal(
      timeline.some((item) => item.kind === "message" && item.id === "msg-board"),
      false,
    );
    const row = timeline.find((item) => item.id === "board-note:msg-board");
    assert.ok(row, "the board note must render as its own system row");
    assert.equal(row.title, "Cora Board");
    assert.equal(row.detail, "3 queued cards handed to Cora");
  });

  // ── Queued messages stay strictly chronological ───────────────────────────
  //
  // The Claude Code model: a message typed mid-turn renders in place, marked
  // "Queued", with the work that continued after it appearing below. The chip
  // is what says "Cora has not read this yet"; position never lies about when
  // it was said.
  function steeringRun(messageOverrides = {}) {
    return run([], {
      steps: [
        {
          id: "step-2",
          runId: "run-1",
          index: 2,
          title: "Wire the parser",
          goal: "Parse the feed",
          kind: "worker_batch",
          status: "running",
          plannedAgents: [],
          acceptanceCriteria: [],
          verificationCommands: [],
          workerTaskIds: [],
          createdAt: at(40),
          updatedAt: at(40),
        },
      ],
      sparkCalls: [
        {
          id: "spark-2",
          runId: "run-1",
          mode: "chat",
          model: "claude-opus-5",
          status: "completed",
          prompt: "carry on",
          createdAt: at(45),
          completedAt: at(48),
          conversationEpoch: 0,
        },
      ],
      humanMessages: [
        {
          id: "msg-first",
          runId: "run-1",
          author: "user",
          kind: "note",
          message: "build the parser",
          intent: "turn",
          deliveryState: "acknowledged",
          targetTurnId: "spark-2",
          backendTurnId: "spark-2",
          conversationEpoch: 0,
          createdAt: at(25),
        },
        {
          id: "msg-steer",
          runId: "run-1",
          author: "user",
          kind: "note",
          message: "use the streaming lexer",
          intent: "steer",
          deliveryState: "queued",
          conversationEpoch: 0,
          createdAt: at(30),
          ...messageOverrides,
        },
      ],
    });
  }

  const idsOf = (timeline) => timeline.map((item) => item.id);

  test("queued steering keeps its chronological place while undelivered", () => {
    const order = idsOf(T.buildChatTimeline(steeringRun()));
    assert.deepEqual(order, [
      "msg-first",
      "msg-steer",
      "step-2",
      "spark-call:spark-2",
    ]);
  });

  test("delivery never moves the bubble", () => {
    // Claim and delivery-state changes alter the chip, not the position, so
    // the bubble never jumps when the turn picks the message up.
    const claimed = idsOf(
      T.buildChatTimeline(
        steeringRun({ backendTurnId: "spark-2", targetTurnId: "spark-2" }),
      ),
    );
    assert.deepEqual(claimed, [
      "msg-first",
      "msg-steer",
      "step-2",
      "spark-call:spark-2",
    ]);
    for (const deliveryState of ["submitted", "acknowledged"]) {
      assert.equal(
        idsOf(T.buildChatTimeline(steeringRun({ deliveryState })))[1],
        "msg-steer",
        `a ${deliveryState} message stays in its chronological place`,
      );
    }
  });

  test("a cancelled message keeps its chronological place", () => {
    // Audit trail: a rewind or a stranded epoch undid it, and WHEN it was said
    // is the whole reason the row is still there. Pinning it to the bottom
    // would put undone history under live activity.
    const order = idsOf(
      T.buildChatTimeline(steeringRun({ deliveryState: "cancelled" })),
    );
    assert.deepEqual(order, [
      "msg-first",
      "msg-steer",
      "step-2",
      "spark-call:spark-2",
    ]);
  });

  test("several queued messages stay in the order they were typed", () => {
    const state = steeringRun();
    state.humanMessages.push({
      id: "msg-steer-2",
      runId: "run-1",
      author: "user",
      kind: "note",
      message: "and cache the tokens",
      intent: "steer",
      deliveryState: "queued",
      conversationEpoch: 0,
      createdAt: at(35),
    });
    assert.deepEqual(idsOf(T.buildChatTimeline(state)), [
      "msg-first",
      "msg-steer",
      "msg-steer-2",
      "step-2",
      "spark-call:spark-2",
    ]);
  });

  test("a queued message from a spent epoch keeps its chronological place", () => {
    // markConversationRewindFailed re-queues the interrupted input after the
    // epoch has already moved, so the store will never drain it again. It
    // renders where it was said, like everything else.
    const state = steeringRun({ conversationEpoch: 0 });
    state.conversationEpoch = 1;
    for (const message of state.humanMessages) {
      if (message.id === "msg-first") message.conversationEpoch = 1;
    }
    assert.deepEqual(idsOf(T.buildChatTimeline(state)), [
      "msg-first",
      "msg-steer",
      "step-2",
      "spark-call:spark-2",
    ]);
  });

  test("a legacy queued message with no epoch of its own stays in place too", () => {
    const state = steeringRun({ conversationEpoch: undefined });
    state.conversationEpoch = 2;
    for (const message of state.humanMessages) {
      if (message.id === "msg-first") message.conversationEpoch = 2;
    }
    assert.deepEqual(idsOf(T.buildChatTimeline(state)), [
      "msg-first",
      "msg-steer",
      "step-2",
      "spark-call:spark-2",
    ]);
  });

  test("two identical queued messages minutes apart stay two bubbles", () => {
    // Cora receives two [Queued message] sections, so the chat must show two;
    // a "×2" badge would under-report what she was told.
    const state = steeringRun();
    state.humanMessages.push({
      id: "msg-steer-again",
      runId: "run-1",
      author: "user",
      kind: "note",
      message: "use the streaming lexer",
      intent: "steer",
      deliveryState: "queued",
      conversationEpoch: 0,
      // Five minutes after the first copy, well past the 90s duplicate window.
      createdAt: "2026-07-25T16:50:30.000Z",
    });
    const timeline = T.buildChatTimeline(state);
    assert.deepEqual(idsOf(timeline), [
      "msg-first",
      "msg-steer",
      "step-2",
      "spark-call:spark-2",
      "msg-steer-again",
    ]);
    for (const item of timeline) {
      if (item.kind === "message") assert.equal(item.repeatCount, 1);
    }
  });

  test("a delivered message never merges with its still-queued twin", () => {
    const state = steeringRun();
    // Same words, same second: the first was delivered, the second is waiting.
    state.humanMessages[0] = {
      ...state.humanMessages[0],
      message: "use the streaming lexer",
    };
    state.humanMessages[1] = {
      ...state.humanMessages[1],
      createdAt: at(25),
    };
    const timeline = T.buildChatTimeline(state);
    const messages = timeline.filter((item) => item.kind === "message");
    assert.deepEqual(
      messages.map((item) => [item.id, item.repeatCount]),
      [
        ["msg-first", 1],
        ["msg-steer", 1],
      ],
    );
  });

  test("a burst of the same message inside the window still collapses", () => {
    // The pre-sort pass owns the ordinary case; this only proves the bounded
    // post-sort pass did not switch collapsing off altogether.
    const state = steeringRun();
    state.humanMessages.push({
      id: "msg-steer-burst",
      runId: "run-1",
      author: "user",
      kind: "note",
      message: "use the streaming lexer",
      intent: "steer",
      deliveryState: "queued",
      conversationEpoch: 0,
      createdAt: at(31),
    });
    const timeline = T.buildChatTimeline(state);
    const steer = timeline.filter(
      (item) => item.kind === "message" && item.text === "use the streaming lexer",
    );
    assert.equal(steer.length, 1);
    assert.equal(steer[0].repeatCount, 2);
  });

  test("a queued synthetic note keeps its system row in place", () => {
    // Board and resume notes are authored "user" for delivery only and are
    // born queued. They render as system rows at their own timestamps, like
    // every other timeline item.
    const state = steeringRun();
    state.humanMessages.push({
      id: "msg-board",
      runId: "run-1",
      author: "user",
      kind: "note",
      boardNote: true,
      message: "[Cora Board — queued cards waiting for you]\n- Card one",
      intent: "turn",
      deliveryState: "queued",
      conversationEpoch: 0,
      createdAt: at(38),
    });
    assert.deepEqual(idsOf(T.buildChatTimeline(state)), [
      "msg-first",
      "msg-steer",
      "board-note:msg-board",
      "step-2",
      "spark-call:spark-2",
    ]);
  });

  test("wait task ids are read only off the wait tool", () => {
    assert.deepEqual(
      T.waitForWorkersTaskIds("mcp__codara-studio__codara_wait_for_workers", {
        worker_task_ids: ["task-a", "task-b"],
        mode: "all",
      }),
      ["task-a", "task-b"],
    );
    assert.equal(T.waitForWorkersTaskIds("codara_spawn_workers", { workers: [] }), null);
    assert.equal(T.waitForWorkersTaskIds("codara_wait_for_workers", {}), null);
    assert.equal(T.waitForWorkersTaskIds("codara_wait_for_workers", { worker_task_ids: [] }), null);
  });

  // ── The composer's worker status strip ────────────────────────────────────
  //
  // Fixture distilled from run-ms9ikoef-mnucvq: step 1's worker failed on a
  // billing rejection, its Codex replacement was aborted by a steering
  // message, the run force-paused for a note, and step 2's worker was planned
  // with its prompt written but never spawned. The strip announced
  // "Sonnet 5 working · Research Spain ... · steering queues" beside a header
  // that read "Paused · step 1 of 2", and the user opened an empty worker
  // terminal looking for the agent it promised.
  function pausedRunWithQueuedWorker(extra = {}) {
    const state = run(
      [
        {
          tasks: [
            task("task-s1-dead", { title: "Research today's Spain news", status: "cancelled" }),
            task("task-s1-live", {
              title: "Research today's Spain news",
              supersedesTaskId: "task-s1-dead",
              runtimePreference: "codex",
              modelHint: "gpt-5.6-sol",
              status: "needs_review",
            }),
          ],
          attempts: [
            attempt("attempt-s1-1", "task-s1-dead", {
              model: "claude-opus-5",
              error: "400 invalid_request_error: third-party apps draw from extra usage",
              finishedAt: at(2),
            }),
            attempt("attempt-s1-2", "task-s1-live", {
              runtime: "codex",
              model: "gpt-5.6-sol",
              error: "Pi worker was interrupted.",
              finishedAt: at(33),
            }),
          ],
        },
        {
          tasks: [
            task("task-s2", {
              title: "Research Spain news today",
              stepId: "step-2",
              modelHint: "claude-sonnet-5",
              status: "queued",
            }),
          ],
          // Prepared, never launched: no model, no clock, no process.
          attempts: [
            attempt("attempt-s2", "task-s2", {
              status: "prompt_ready",
              model: undefined,
              startedAt: undefined,
            }),
          ],
        },
      ],
      {
        status: "paused",
        autopilot: { status: "paused", updatedAt: at(33) },
        steps: [
          step("step-1", 1, "Research today's Spain news", "reviewing", [
            "task-s1-dead",
            "task-s1-live",
          ]),
          step("step-2", 2, "Research Spain news today", "ready", ["task-s2"]),
        ],
        ...extra,
      },
    );
    return state;
  }

  test("a prepared-but-never-spawned worker in a paused run reads as queued", () => {
    const activity = T.deriveComposerWorkerActivity(pausedRunWithQueuedWorker());
    assert.deepEqual(activity, {
      state: "queued",
      // The task asked for Sonnet; the spawn chokepoint coerces it onto the
      // roster, so the strip names the model that will actually run.
      engines: ["Opus 5"],
      titles: ["Research Spain news today"],
      runPaused: true,
    });
  });

  test("a launched worker is the only thing that reads as live", () => {
    for (const status of ["launching", "running", "finishing"]) {
      const state = pausedRunWithQueuedWorker();
      const live = state.workerAttempts.find((entry) => entry.id === "attempt-s2");
      live.status = status;
      live.model = "claude-opus-5";
      live.startedAt = at(40);
      const activity = T.deriveComposerWorkerActivity(state);
      assert.equal(activity.state, "live", `${status} must read as live`);
      assert.deepEqual(activity.engines, ["Opus 5"]);
      assert.equal(activity.runPaused, true, "a live worker does not un-pause the run");
    }
    for (const status of ["preparing", "prompt_ready"]) {
      const state = pausedRunWithQueuedWorker();
      state.workerAttempts.find((entry) => entry.id === "attempt-s2").status = status;
      assert.equal(
        T.deriveComposerWorkerActivity(state).state,
        "queued",
        `${status} means a prompt on disk, not a process`,
      );
    }
  });

  test("a claimed task reads as live before its attempt row lands", () => {
    const state = pausedRunWithQueuedWorker();
    state.workerTasks.find((entry) => entry.id === "task-s2").status = "claimed";
    assert.equal(T.deriveComposerWorkerActivity(state).state, "live");
  });

  test("a worker between attempts is queued, never working", () => {
    const state = pausedRunWithQueuedWorker();
    // The prepared attempt died and the store owes a retry.
    const attemptRow = state.workerAttempts.find((entry) => entry.id === "attempt-s2");
    attemptRow.status = "failed";
    attemptRow.error = "Pi worker runtime stopped.";
    state.workerTasks.find((entry) => entry.id === "task-s2").status = "retry_queued";
    const activity = T.deriveComposerWorkerActivity(state);
    assert.equal(activity.state, "queued");
    assert.deepEqual(activity.engines, ["Opus 5"]);
  });

  test("a finished run stops advertising work it will never launch", () => {
    for (const status of ["complete", "failed", "cancelled"]) {
      const state = pausedRunWithQueuedWorker({ status });
      assert.equal(
        T.deriveComposerWorkerActivity(state),
        null,
        `a ${status} run has no queued worker to promise`,
      );
    }
  });

  test("a settled run says nothing about workers", () => {
    const state = pausedRunWithQueuedWorker();
    state.workerTasks = state.workerTasks.filter((entry) => entry.id !== "task-s2");
    state.workerAttempts = state.workerAttempts.filter((entry) => entry.id !== "attempt-s2");
    assert.equal(T.deriveComposerWorkerActivity(state), null);
    assert.equal(T.deriveComposerWorkerActivity(undefined), null);
  });

  test("a fleet reports its real mix and every live worker", () => {
    const state = run([
      {
        tasks: [
          task("task-a", { title: "A", status: "running" }),
          task("task-b", { title: "B", status: "running" }),
          task("task-c", { title: "C", runtimePreference: "codex", status: "running" }),
        ],
        attempts: [
          attempt("attempt-a", "task-a", { status: "running", model: "claude-opus-5" }),
          attempt("attempt-b", "task-b", { status: "running", model: "claude-fable-5" }),
          attempt("attempt-c", "task-c", { status: "running", runtime: "codex", model: "gpt-5.6-sol" }),
        ],
      },
    ]);
    const activity = T.deriveComposerWorkerActivity(state);
    assert.equal(activity.state, "live");
    assert.deepEqual(activity.engines, ["Opus 5", "Fable 5", "Sol"]);
    assert.equal(activity.runPaused, false);
  });

  test("a loom worker keeps the model its automation pinned", () => {
    const state = pausedRunWithQueuedWorker({
      executionMode: "direct",
      automationId: "auto-1",
    });
    // Automations vet their own model, so the roster coercion must not rewrite
    // it — the strip shows what the loom will really launch.
    assert.deepEqual(T.deriveComposerWorkerActivity(state).engines, ["Sonnet 5"]);
  });

  test("chip, chat row and graph node agree that a prepared attempt is not running", () => {
    const state = pausedRunWithQueuedWorker();
    const task = state.workerTasks.find((entry) => entry.id === "task-s2");
    const prepared = state.workerAttempts.find((entry) => entry.id === "attempt-s2");

    // 1. the composer chip
    assert.equal(T.deriveComposerWorkerActivity(state).state, "queued");
    // 2. the chat row
    const row = rowFor(T.buildChatTimeline(state), "Research Spain news today");
    assert.equal(row.status, "queued");
    assert.equal(row.tone, "queued");
    assert.equal(row.detail, "Opus 5 · queued");
    assert.equal(T.isToolRowTicking(row), false);
    // 3. the graph node + the inspector's attempt dot
    assert.equal(T.deriveAgentStatus(task, prepared, "ready"), "queued");
    assert.equal(T.attemptStatusColor("prompt_ready"), "var(--muted)");
    assert.equal(T.attemptStatusColor("preparing"), "var(--muted)");

    // And all three flip together the moment a process exists.
    prepared.status = "running";
    prepared.model = "claude-opus-5";
    prepared.startedAt = at(40);
    assert.equal(T.deriveComposerWorkerActivity(state).state, "live");
    const liveRow = rowFor(T.buildChatTimeline(state), "Research Spain news today");
    assert.equal(liveRow.status, "started");
    assert.equal(liveRow.tone, "live");
    assert.equal(T.deriveAgentStatus(task, prepared, "running"), "running");
    assert.equal(T.attemptStatusColor("running"), "var(--accent)");
    assert.equal(T.attemptStatusColor("launching"), "var(--accent)");
    assert.equal(T.attemptStatusColor("finishing"), "var(--accent)");
  });

  test("a queued worker row names the model the spawn will coerce it onto", () => {
    const state = pausedRunWithQueuedWorker();
    const timeline = T.buildChatTimeline(state);
    const row = rowFor(timeline, "Research Spain news today");
    assert.equal(row.meta.find((meta) => meta.label === "Model").value, "Opus 5");
    const step = timeline.filter((item) => item.kind === "step").find((item) => item.id === "step-2");
    assert.equal(step.workers[0].model, "claude-opus-5");
  });

  // ── Awaiting-answer manager turns (run-msafk7yu-zkudx6) ───────────────────
  // A live CLI manager holds its RPC turn open while suspended inside
  // ask_user, so the SparkCall stays "started" while the run is "blocked".
  // The header says "Needs you"; the timeline's final live segment must not
  // simultaneously claim Cora is working.

  const managerCall = (extra = {}) => ({
    id: "spark-live",
    runId: "run-1",
    mode: "chat",
    model: "claude-opus-5",
    status: "started",
    createdAt: at(30),
    ...extra,
  });
  const askQuestion = (extra = {}) => ({
    id: "q-1",
    runId: "run-1",
    author: "spark",
    kind: "question",
    message: "Please approve the plan: 1. fix timeline (timeline.ts) 2. validate asks",
    questionOptions: [],
    attachments: [],
    createdAt: at(40),
    ...extra,
  });
  const managerRows = (timeline) =>
    timeline.filter((item) => item.kind === "tool" && item.activity === "manager");

  test("an open question turns the live manager segment into a waiting row", () => {
    const state = run([], {
      status: "blocked",
      blockedOn: {
        questionMessageId: "q-1",
        category: "plan_approval",
        previousStatus: "reviewing",
        resumeStatus: "reviewing",
        source: "live_manager_rpc",
        resumeStrategy: "active_rpc",
        managerMode: "chat",
        blockedAt: at(40),
      },
      sparkCalls: [managerCall()],
      humanMessages: [askQuestion()],
      steps: [],
    });
    // Both status surfaces must agree: the header says "Needs you"...
    assert.equal(T.describeRunStatus(state).label, "Needs you");
    // ...and the timeline's final live segment says waiting, not working.
    const rows = managerRows(T.buildChatTimeline(state));
    assert.equal(rows.length, 2, "the question splits the turn into two segments");
    const final = rows[rows.length - 1];
    assert.equal(final.tone, "live");
    assert.equal(final.awaitingReply, true);
    assert.equal(final.title, "Waiting on your reply");
    assert.doesNotMatch(final.detail, /Following the thread/);
    assert.doesNotMatch(`${final.title} ${final.detail}`, /[Ww]orking/);
    assert.equal(T.isToolRowTicking(final), false);
    // The pre-question slice is settled history and never claims to wait.
    assert.equal(rows[0].awaitingReply, undefined);
  });

  test("the working ticker returns once the answer lands", () => {
    const state = run([], {
      status: "running",
      sparkCalls: [managerCall()],
      humanMessages: [
        askQuestion(),
        {
          id: "a-1",
          runId: "run-1",
          author: "user",
          kind: "answer",
          answersMessageId: "q-1",
          message: "Approve all of it.",
          questionOptions: [],
          attachments: [],
          createdAt: at(45),
        },
      ],
      steps: [],
    });
    const rows = managerRows(T.buildChatTimeline(state));
    const final = rows[rows.length - 1];
    assert.equal(final.awaitingReply, undefined);
    assert.equal(final.title, "Cora is working");
    assert.match(final.detail, /Following the thread/);
  });

  test("a blocked run whose call already completed never marks awaiting", () => {
    const state = run([], {
      status: "blocked",
      blockedOn: {
        questionMessageId: "q-1",
        category: "plan_approval",
        previousStatus: "reviewing",
        resumeStatus: "reviewing",
        source: "manager_decision",
        resumeStrategy: "schedule_manager",
        managerMode: "chat",
        blockedAt: at(40),
      },
      sparkCalls: [managerCall({ status: "completed", completedAt: at(41), durationMs: 11000 })],
      humanMessages: [askQuestion()],
      steps: [],
    });
    const rows = managerRows(T.buildChatTimeline(state));
    for (const row of rows) {
      assert.equal(row.awaitingReply, undefined);
      assert.notEqual(row.tone, "live");
    }
  });

  test("compaction renders as maintenance and never as a Cora answer", () => {
    const state = run([], {
      status: "complete",
      conversationEpoch: 1,
      steps: [],
      sparkCalls: [
        managerCall({
          id: "spark-compact",
          purpose: "compaction",
          status: "completed",
          completedAt: at(55),
          durationMs: 25_000,
        }),
      ],
      humanMessages: [
        {
          id: "answer-real",
          runId: "run-1",
          author: "spark",
          kind: "note",
          message: "The durable final answer.",
          attachments: [],
          conversationEpoch: 0,
          createdAt: at(29),
        },
        {
          id: "summary-internal",
          runId: "run-1",
          author: "spark",
          kind: "note",
          compaction: true,
          message: "Internal workspace summary that must stay hidden.",
          attachments: [],
          conversationEpoch: 1,
          createdAt: at(55),
        },
      ],
    });
    const timeline = T.buildChatTimeline(state);
    assert.ok(timeline.some((item) => item.kind === "message" && item.id === "answer-real"));
    assert.ok(!timeline.some((item) => item.kind === "message" && item.id === "summary-internal"));
    const maintenance = managerRows(timeline)[0];
    assert.equal(maintenance.title, "Compacted conversation");
    assert.equal(maintenance.maintenance, "compaction");
  });

  test("live compaction has an explicit compacting title", () => {
    const state = run([], {
      steps: [],
      sparkCalls: [managerCall({ id: "spark-compact-live", purpose: "compaction" })],
    });
    const maintenance = managerRows(T.buildChatTimeline(state))[0];
    assert.equal(maintenance.title, "Compacting conversation");
    assert.equal(maintenance.maintenance, "compaction");
  });

  // The component-side wiring the projection cannot see: AssistantLiveTurn
  // must gate the pulsing "Working for Ns" header on awaitingReply, so the
  // waiting row renders without a ticker (no WorkingDots, no ElapsedSince).
  test("AssistantLiveTurn suppresses the working ticker for awaiting-reply rows", () => {
    const source = fs.readFileSync(CHAT_CONVERSATION, "utf8");
    const start = source.indexOf("function AssistantLiveTurn");
    const end = source.indexOf("function liveTurnSegments", start);
    assert.notEqual(start, -1, "AssistantLiveTurn must exist");
    assert.notEqual(end, -1, "AssistantLiveTurn boundary must exist");
    const component = source.slice(start, end);
    assert.match(component, /item\.awaitingReply \? \(/, "the header must branch on awaitingReply");
    const awaitingBranch = component.slice(
      component.indexOf("item.awaitingReply ? ("),
      component.indexOf(") : compaction ? ("),
    );
    assert.doesNotMatch(awaitingBranch, /WorkingDots|ElapsedSince|Working</,
      "the awaiting branch must not render the working ticker");
    assert.match(component, /Working<ElapsedSince/, "the ordinary live branch keeps its ticker");
    assert.match(component, /compaction \? \(/, "compaction gets its own live header");
    assert.match(component, /\{item\.title\}<ElapsedSince/, "the compaction header uses the explicit title");
  });

  // A failed manager turn the user already retried must vanish once the
  // replacement call (same frozen inputMessageIds, same epoch) is running or
  // done; a retry that itself failed keeps its own failed row.
  test("a retried turn's failure row is superseded by the replacement call", () => {
    const source = fs.readFileSync(CHAT_CONVERSATION, "utf8");
    assert.match(source, /!isSupersededFailedManagerTurn\(item, run\) &&/,
      "the timeline filter must drop superseded failures");
    const start = source.indexOf("function isSupersededFailedManagerTurn");
    const end = source.indexOf("function groupCompletedActivity", start);
    assert.notEqual(start, -1, "isSupersededFailedManagerTurn must exist");
    const body = source.slice(start, end);
    assert.match(body, /call\.status !== "failed"/,
      "a failed retry must not supersede the original failure");
    assert.match(body, /call\.purpose !== "compaction"/,
      "compaction calls never supersede a conversational failure");
    assert.match(body, /inputMessageIds\.every\(\(id, index\) => id === inputs\[index\]\)/,
      "supersession must match the exact frozen input messages");
  });

  console.log(`\n${passed} chat timeline contract tests passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
