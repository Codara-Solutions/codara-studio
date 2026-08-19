#!/usr/bin/env node
"use strict";

// Offline tests for the Cora CLI (cli/). Builds a throwaway Codara home with
// synthetic runs, drives the CLI as a child process, and asserts on output.
// Nothing here needs the app running.
//
//   node scripts/test-cora-cli.cjs

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "cli", "cora.cjs");

// ── synthetic home ──────────────────────────────────────────────────────────

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cora-cli-test-"));

function writeRun(run, events = []) {
  const dir = path.join(home, "runs", run.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run));
  if (events.length > 0) {
    fs.writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
}

const now = new Date().toISOString();
writeRun(
  {
    id: "run-alpha-000001",
    status: "working",
    title: "Build the widget",
    updatedAt: now,
    cwd: "/tmp/widget",
    humanMessages: [
      { author: "user", kind: "note", message: "build it", createdAt: now },
    ],
    steps: [{ id: "s1", status: "running", title: "Implement widget" }],
    workerTasks: [
      { id: "task-a1", status: "claimed", runtimePreference: "claude", title: "Widget core" },
      { id: "task-a2", status: "claimed", runtimePreference: "codex", title: "Widget tests" },
    ],
    workerAttempts: [
      { id: "att-1", workerTaskId: "task-a1", status: "running", model: "claude-opus-5", startedAt: now },
      { id: "att-2", workerTaskId: "task-a2", status: "running", model: "gpt-5.6-sol", startedAt: now },
    ],
    sparkCalls: [],
  },
  [{ timestamp: now, sequence: 1, type: "worker_attempt.running", message: "Worker attempt running: Widget core" }],
);
writeRun({
  id: "run-beta-00000002",
  status: "blocked",
  title: "Ship it",
  updatedAt: now,
  humanMessages: [
    { author: "cora", kind: "question", message: "Deploy to prod?", questionOptions: [{ label: "Yes" }, { label: "No", recommended: true }], createdAt: now },
  ],
  steps: [],
  workerTasks: [],
  workerAttempts: [],
  sparkCalls: [],
});

function cli(...args) {
  return execFileSync("node", [CLI, ...args], {
    env: { ...process.env, CODARA_HOME_DIR: home, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function cliFails(...args) {
  try {
    execFileSync("node", [CLI, ...args], {
      env: { ...process.env, CODARA_HOME_DIR: home, NO_COLOR: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    return null;
  } catch (err) {
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
}

// ── help + branding ─────────────────────────────────────────────────────────

const help = cli("help");
assert.match(help, /██/, "help shows the Codara logo");
for (const command of ["chat", "start", "send", "watch", "agents", "board", "whiteboard", "auto", "bench", "runs"]) {
  assert.match(help, new RegExp(`\\b${command}\\b`), `help lists ${command}`);
}

// ── full-screen chat's pure view helpers ───────────────────────────────────

const {
  activityText,
  compactTokens,
  conversationMessages,
  resolveReplyContent,
  runStats,
} = require(path.join(ROOT, "cli", "commands", "chat.cjs"));

assert.equal(compactTokens(999), "999");
assert.equal(compactTokens(1_200), "1.2k");
assert.equal(compactTokens(200_000), "200k");

const chatRun = {
  id: "run-chat",
  status: "blocked",
  createdAt: now,
  humanMessages: [
    { id: "m1", author: "user", kind: "note", message: "Build it" },
    { id: "m2", author: "user", kind: "note", message: "Build it" },
    { id: "m3", author: "system", kind: "note", message: "hidden summary", compaction: true },
    { id: "m4", author: "spark", kind: "question", message: "Ship it?", questionOptions: [
      { label: "Yes", answer: "Ship it now" },
      { label: "No", answer: "Do not ship" },
    ] },
  ],
  steps: [{ status: "complete" }, { status: "running" }],
  workerAttempts: [{ status: "running" }, { status: "succeeded" }],
};
assert.deepEqual(conversationMessages(chatRun).map((message) => message.id), ["m1", "m4"]);
assert.deepEqual(resolveReplyContent("1", chatRun), { content: "Ship it now", label: "Yes" });
assert.deepEqual(resolveReplyContent("please wait", chatRun), { content: "please wait" });
assert.deepEqual(runStats(chatRun), { activeAgents: 1, finishedSteps: 1, totalSteps: 2 });
assert.match(activityText(chatRun), /needs your answer/);

// ── offline run inspection ──────────────────────────────────────────────────

const runs = cli("runs");
assert.match(runs, /run-alpha-000001/);
assert.match(runs, /run-beta-00000002/);
assert.match(runs, /Build the widget/);
assert.ok(runs.indexOf("run-alpha") < runs.indexOf("run-beta") || runs.indexOf("run-beta") < runs.indexOf("run-alpha"));

const detail = cli("run", "run-alpha");
assert.match(detail, /Build the widget/);
assert.match(detail, /workers 2/);
assert.match(detail, /Implement widget/);

const log = cli("log", "run-beta");
assert.match(log, /Deploy to prod\?/);
assert.match(log, /2\. No\s+\(recommended\)/);

const agents = cli("agents", "run-alpha");
assert.match(agents, /Widget core/);
assert.match(agents, /Widget tests/);
assert.match(agents, /claude-opus-5/);
assert.match(agents, /gpt-5\.6-sol/);

// prefix resolution: unique prefix works, ambiguous fails clearly
assert.match(cli("run", "run-alpha-0"), /run-alpha-000001/);
const ambiguous = cliFails("run", "run-");
assert.match(ambiguous, /ambiguous/);

// ── json output mode ────────────────────────────────────────────────────────

const json = JSON.parse(cli("runs", "--json"));
assert.equal(json.length, 2);
assert.ok(json.every((run) => typeof run.id === "string"));

// ── live dashboard renderer (direct module call — no TTY loop) ──────────────

const { renderDashboard } = require(path.join(ROOT, "cli", "commands", "agents.cjs"));
const { findRun } = require(path.join(ROOT, "cli", "lib", "store.cjs"));
const flags = { home };
const frame = renderDashboard(flags, findRun(flags, "run-alpha"));
assert.match(frame, /cora watch/);
assert.match(frame, /subagents \(2\)/);
assert.match(frame, /Widget core/);
assert.match(frame, /Worker attempt running/);

const blockedFrame = renderDashboard(flags, findRun(flags, "run-beta"));
assert.match(blockedFrame, /Cora asks: Deploy to prod\?/);
assert.match(blockedFrame, /1\. Yes/);

// ── bench surface (offline parts only) ──────────────────────────────────────

const benchList = cli("bench", "list");
assert.match(benchList, /typo-fix/);
assert.match(benchList, /parallel-slices/);
assert.match(benchList, /interval-merge/);
assert.match(benchList, /patch-atomic/);
assert.match(benchList, /stable-dag/);
assert.match(benchList, /async-pool/);
assert.match(benchList, /holdout/);

const {
  buildRivalCommand,
  readHermesUsage,
} = require(path.join(ROOT, "cli", "bench", "rivals.cjs"));
const hermesCommand = buildRivalCommand("hermes", {
  prompt: "fix",
  resume: "session-1",
  usageFile: "/tmp/hermes-usage.json",
  model: "gpt-5.6-sol",
  effort: "high",
});
assert.ok(hermesCommand.args.includes("terminal,file,code_execution"));
assert.ok(hermesCommand.args.includes("session-1"));
assert.deepEqual(hermesCommand.args.slice(hermesCommand.args.indexOf("--model"), hermesCommand.args.indexOf("--model") + 4), [
  "--model", "gpt-5.6-sol", "--provider", "openai-codex",
]);
assert.deepEqual(hermesCommand.args.slice(hermesCommand.args.indexOf("--reasoning"), hermesCommand.args.indexOf("--reasoning") + 2), [
  "--reasoning", "high",
]);
const hermesUsageFile = path.join(home, "hermes-usage.json");
fs.writeFileSync(hermesUsageFile, JSON.stringify({
  session_id: "session-1",
  api_calls: 4,
  total_tokens: 321,
  model: "test-model",
  provider: "openai-codex",
  failed: false,
}));
assert.deepEqual(readHermesUsage(hermesUsageFile), {
  sessionId: "session-1",
  turns: 4,
  tokens: 321,
  model: "test-model",
  provider: "openai-codex",
  failed: false,
});

const { TASKS } = require(path.join(ROOT, "cli", "bench", "tasks.cjs"));
const { gradeChecks, comparableEntry, totalRunTokens } = require(path.join(ROOT, "cli", "commands", "bench.cjs"));
assert.ok(TASKS.length >= 8, "bench suite has at least 8 tasks");
assert.equal(new Set(TASKS.map((t) => t.name)).size, TASKS.length, "task names unique");
assert.ok(TASKS.some((t) => t.split === "train") && TASKS.some((t) => t.split === "holdout"), "train/holdout split exists");
const benchIdentity = {
  suiteHash: "suite-a",
  scorerHash: "score-a",
  runnerHash: "run-a",
  toolVersions: { cora: "1", hermes: "4" },
  control: { model: "gpt-5.6-sol", effort: "high", execution: "direct", provider: "openai-codex" },
  repeat: 3,
  taskNames: ["a", "b"],
};
assert.equal(comparableEntry({ ...benchIdentity }, benchIdentity), true, "identical benchmark runs compare");
for (const mismatch of [
  { suiteHash: "suite-b" },
  { scorerHash: "score-b" },
  { runnerHash: "run-b" },
  { toolVersions: { ...benchIdentity.toolVersions, hermes: "new" } },
  { control: { ...benchIdentity.control, effort: "medium" } },
  { repeat: 1 },
  { taskNames: ["a"] },
]) {
  assert.equal(comparableEntry({ ...benchIdentity, ...mismatch }, benchIdentity), false, "mismatched runs do not compare");
}
assert.equal(
  totalRunTokens({
    sparkCalls: [{ inputTokens: 10, outputTokens: 5, cacheReadTokens: 20 }],
    workerAttempts: [{ inputTokens: 7, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 1 }],
  }),
  50,
  "benchmark counts manager and worker provider usage",
);

function seedDir(task, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-seed-${task.name}-`));
  for (const [file, content] of Object.entries({ ...task.files, ...overrides })) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

// Metrics that satisfy every routing-style check, so reference grading
// isolates the code checks.
const idealMetrics = { models: ["claude-fable-5"], workers: 1, maxConcurrent: 1 };

for (const task of TASKS) {
  assert.ok(
    task.name && task.prompt && task.files && task.reference &&
      ["trivial", "standard", "hard", "project"].includes(task.tier) &&
      ["train", "holdout"].includes(task.split) &&
      task.par && task.par.wallS > 0 && task.par.tokensK > 0 &&
      Array.isArray(task.hidden) && task.hidden.length > 0,
    `${task.name} is well-formed`,
  );

  // Staged tasks are graded in their FINAL state: every stage's files (the
  // evolved test.js) are on disk by the time grading runs.
  const stageFiles = Object.assign({}, ...(task.stages ?? []).map((stage) => stage.files ?? {}));

  // The unsolved seed must FAIL — a benchmark that grades the seed as done
  // would score Cora for doing nothing.
  const seeded = seedDir(task, stageFiles);
  const seedChecks = gradeChecks(task, seeded, idealMetrics);
  assert.ok(seedChecks.some((check) => !check.pass), `${task.name}: checks fail on the unsolved seed`);
  fs.rmSync(seeded, { recursive: true, force: true });

  // The reference solution must pass EVERYTHING, hidden groups included — the
  // benchmark must never be unwinnable.
  const solved = seedDir(task, { ...stageFiles, ...task.reference });
  const solvedChecks = gradeChecks(task, solved, idealMetrics);
  const failed = solvedChecks.filter((check) => !check.pass);
  assert.equal(failed.length, 0, `${task.name}: reference passes all checks (failed: ${failed.map((f) => `${f.name} ${f.detail ?? ""}`).join("; ")})`);
  fs.rmSync(solved, { recursive: true, force: true });
}

// ── harness scoring math ────────────────────────────────────────────────────

const { scoreTask } = require(path.join(ROOT, "cli", "bench", "score.cjs"));
const sampleTask = { tier: "trivial", par: { wallS: 60, tokensK: 15 } };
const perfect = scoreTask(sampleTask, {
  checks: [{ name: "a", pass: true, weight: 5 }],
  wallMs: 45_000, greenAtMs: 45_000, tokens: 10_000,
  workers: 1, maxConcurrent: 1, questionsAsked: 0, churn: 0, runStatus: "complete",
});
assert.ok(perfect.total >= 95, `clean fast run scores high (got ${perfect.total})`);

const lazy = scoreTask(sampleTask, {
  checks: [{ name: "a", pass: false, weight: 5 }],
  wallMs: 300_000, greenAtMs: null, tokens: 90_000,
  workers: 4, maxConcurrent: 1, questionsAsked: 1, churn: 0, runStatus: "timeout",
});
assert.ok(lazy.total < 15, `failed bloated run scores low (got ${lazy.total})`);

const overshoot = scoreTask(sampleTask, {
  checks: [{ name: "a", pass: true, weight: 5 }],
  wallMs: 180_000, greenAtMs: 60_000, tokens: 15_000,
  workers: 1, maxConcurrent: 1, questionsAsked: 0, churn: 0, runStatus: "complete",
});
assert.ok(overshoot.parts.discipline < perfect.parts.discipline, "post-green time costs discipline");

const parallelTask = { tier: "standard", parallel: true, expectedParallel: 4, par: { wallS: 150, tokensK: 35 } };
const slowSequential = scoreTask(parallelTask, {
  checks: [{ name: "a", pass: true, weight: 5 }],
  wallMs: 240_000, greenAtMs: 240_000, tokens: 35_000,
  workers: 4, maxConcurrent: 1, questionsAsked: 0, churn: 0, runStatus: "complete",
});
assert.equal(slowSequential.parts.orchestration, 0, "slow sequential run of parallel work scores 0 orchestration");
const fastSequential = scoreTask(parallelTask, {
  checks: [{ name: "a", pass: true, weight: 5 }],
  wallMs: 60_000, greenAtMs: 60_000, tokens: 10_000,
  workers: 1, maxConcurrent: 1, questionsAsked: 0, churn: 0, runStatus: "complete",
});
assert.equal(fastSequential.parts.orchestration, 10, "beating par without fan-out earns full orchestration");
const fanned = scoreTask(parallelTask, {
  checks: [{ name: "a", pass: true, weight: 5 }],
  wallMs: 200_000, greenAtMs: 200_000, tokens: 35_000,
  workers: 4, maxConcurrent: 4, questionsAsked: 0, churn: 0, runStatus: "complete",
});
assert.equal(fanned.parts.orchestration, 10, "full fan-out earns full orchestration");

// ── unreachable-app behavior ────────────────────────────────────────────────

// No agent-socket.json in the synthetic home: live commands must fail with a
// clear "not running" message, never a stack trace.
const offline = cliFails("start", "hello");
assert.match(offline, /isn't running/);
assert.doesNotMatch(offline, /at Object/);

// unknown command
assert.match(cliFails("frobnicate") ?? "", /unknown command/);

fs.rmSync(home, { recursive: true, force: true });
console.log("test-cora-cli: all assertions passed");
