"use strict";
// Adopt a live bench run whose bench PROCESS was killed (environments that
// cull long shells do this): find the run's still-live workspace, keep polling
// green, drive any remaining checkpoint stages, wait for settle, grade with
// the normal pipeline, and append a history row flagged { adopted: true }.
// Timing caveat: green that happened before adoption is only observed at the
// next probe, so greenAtMs can read late and flatter discipline slightly.
//
//   node cli/bench/adopt.cjs <runId> <taskName> <workspaceDir>
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.join(__dirname, "..", "..");
const { rpcRaw } = require(path.join(ROOT, "cli/lib/rpc.cjs"));
const { TASKS, TIER_CAP_MS } = require(path.join(ROOT, "cli/bench/tasks.cjs"));
const { scoreTask } = require(path.join(ROOT, "cli/bench/score.cjs"));
const { gradeChecks, probeGreen, driveToCompletion, runMetrics, appendHistory, historyMetadata } = require(path.join(ROOT, "cli/commands/bench.cjs"));
const { findRun } = require(path.join(ROOT, "cli/lib/store.cjs"));

const [runId, taskName, dir] = process.argv.slice(2);
const task = TASKS.find((t) => t.name === taskName);
if (!task || !fs.existsSync(dir)) throw new Error("bad args");
const flags = {};
const control = {
  model: "gpt-5.6-sol",
  effort: "high",
  execution: "direct",
  provider: "openai-codex",
};
const { rpc } = require(path.join(ROOT, "cli/lib/rpc.cjs"));

(async () => {
  const run = findRun(flags, runId);
  const startedAt = Date.parse(run.createdAt);
  const capMs = TIER_CAP_MS[task.tier] ?? 10 * 60_000;
  const state = { greenAtMs: null };
  const poller = setInterval(async () => {
    if (state.greenAtMs === null && (await probeGreen(dir, task))) state.greenAtMs = Date.now() - startedAt;
  }, 5_000);
  let outcome = await driveToCompletion(flags, runId, startedAt + capMs);
  // Staged task: figure out which stage the workspace is on and continue.
  const stages = task.stages ?? [];
  const currentTest = fs.readFileSync(path.join(dir, "test.js"), "utf8");
  let startIdx = 0;
  stages.forEach((stage, i) => {
    if (stage.files?.["test.js"] === currentTest) startIdx = i + 1;
  });
  let questionsAsked = outcome.questionsAsked;
  for (const stage of stages.slice(startIdx)) {
    if (outcome.status !== "complete") break;
    for (const [file, content] of Object.entries(stage.files ?? {})) {
      fs.writeFileSync(path.join(dir, file), content);
    }
    state.greenAtMs = null;
    await rpc(flags, "chat.send", { runId, content: stage.prompt });
    outcome = await driveToCompletion(flags, runId, startedAt + capMs);
    questionsAsked += outcome.questionsAsked;
  }
  outcome.questionsAsked = questionsAsked;
  const greenAtMs0 = state.greenAtMs;
  let greenAtMs = greenAtMs0;
  clearInterval(poller);
  const wallMs = Date.now() - startedAt;
  if (outcome.status === "timeout") {
    await rpcRaw(flags, "chat.cancel", { runId, reason: "bench window elapsed" }).catch(() => null);
  }
  if (greenAtMs === null && (await probeGreen(dir, task))) greenAtMs = wallMs;
  const greenAtIso = greenAtMs === null ? null : new Date(startedAt + greenAtMs).toISOString();
  const metrics = await runMetrics(flags, runId, greenAtIso, outcome.status);
  const checks = gradeChecks(task, dir, metrics);
  await rpcRaw(flags, "chat.cancel", { runId, reason: "bench graded" }).catch(() => null);
  const result = { checks, wallMs, greenAtMs, runStatus: outcome.status, questionsAsked: outcome.questionsAsked, ...metrics };
  const score = scoreTask(task, result);
  const row = {
    task: task.name, tier: task.tier, score: score.total, parts: score.parts,
    green: greenAtMs, wallMs, tokens: result.tokens, postGreenTokens: result.postGreenTokens,
    workers: result.workers, maxConcurrent: result.maxConcurrent, questions: result.questionsAsked,
    churn: result.churn, models: result.models, runStatus: result.runStatus, runId,
  };
  appendHistory({
    at: new Date().toISOString(), ...historyMetadata("cora", [task.name], 1, control), agent: "cora",
    split: `task:${task.name}`, score: score.total,
    calibration: { [task.tier]: Math.round((wallMs / 1000 / task.par.wallS) * 10) / 10 },
    tasks: [row], adopted: true,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  await rpcRaw(flags, "workspace.prune", { cwds: [dir] }).catch(() => null);
  console.log(JSON.stringify({ score: score.total, parts: score.parts, greenAtMs, wallMs, checks: checks.map((c) => `${c.pass ? "ok" : "FAIL"} ${c.name}`) }, null, 1));
  console.log("HARNESS SCORE " + score.total);
})();
