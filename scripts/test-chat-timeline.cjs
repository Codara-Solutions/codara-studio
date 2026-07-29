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
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TIMELINE = path.join(ROOT, "src", "renderer", "src", "components", "chat", "timeline.ts");
const TOOL_LABELS = path.join(ROOT, "src", "renderer", "src", "components", "chat", "tool-labels.ts");

async function loadContract() {
  const out = await esbuild.build({
    stdin: {
      contents:
        `export * from ${JSON.stringify(TIMELINE)};\n` +
        `export { waitForWorkersTaskIds } from ${JSON.stringify(TOOL_LABELS)};`,
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
    const inFlight = rowFor(timeline, "Currencies and commodities");
    assert.equal(inFlight.status, "started");
    assert.equal(inFlight.tone, "live");
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
        deliveryState: "queued",
        intent: "turn",
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

  console.log(`\n${passed} chat timeline contract tests passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
