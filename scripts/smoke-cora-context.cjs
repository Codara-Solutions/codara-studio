"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { rpcRaw } = require("../cli/lib/rpc.cjs");
const { findRun } = require("../cli/lib/store.cjs");
const { runMetrics } = require("../cli/commands/bench.cjs");
const { modelControlCheck } = require("../cli/bench/metrics.cjs");
const { sessionTrace } = require("./smoke-cora-browser.cjs");

async function main() {
  const home = process.env.CODARA_CONTEXT_SMOKE_HOME;
  const output = process.env.CODARA_CONTEXT_SMOKE_OUTPUT;
  if (!home || !output) throw new Error("Set CODARA_CONTEXT_SMOKE_HOME and a new CODARA_CONTEXT_SMOKE_OUTPUT path");
  if (fs.existsSync(output)) throw new Error("Output already exists");
  const flags = { home };
  const model = process.env.CODARA_CONTEXT_SMOKE_MODEL ?? "gpt-5.6-luna";
  const shouldCompact = process.env.CODARA_CONTEXT_SMOKE_COMPACT === "1";
  const nonce = randomBytes(6).toString("hex");
  const expected = { jobId: `job-${nonce}`, region: "eu-west-3", retryLimit: 4, owner: `team-${nonce}` };
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cora-context-"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "README.md"), "# Context continuity test\n\nFollow the conversation.\n");
  const request = async (method, params, timeoutMs = 15_000) => {
    const response = await rpcRaw(flags, method, params, { timeoutMs });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  const started = Date.now();
  const deadline = started + 10 * 60_000;
  const stages = [];
  let runId;
  let compaction;
  let runStatus = "not_started";
  try {
    const created = await request("chat.create", {
      cwd: workspace, backend: "pi", execution: "direct", model, effort: "high",
      title: "context lab: corrected settings across turns",
      prompt: `Keep these launch settings in this conversation for a later request: jobId=${expected.jobId}, region=us-west-2, retryLimit=4, owner=${expected.owner}. Do not write files, use memory tools, or run commands. Acknowledge using only submit_result.`,
    });
    runId = created.run.id;
    for (let stage = 0; stage < 3; stage += 1) {
      if (stage === 1) await request("chat.send", { runId, content: "Correction: region is eu-west-3. Preserve every other launch setting. Do not write files, use memory tools, or run commands. Acknowledge using only submit_result." });
      if (stage === 2) {
        if (shouldCompact) {
          const epoch = findRun(flags, runId).conversationEpoch ?? 0;
          try {
            const result = await request("chat.compact", { runId }, Math.max(1, deadline - Date.now()));
            compaction = { beforeEpoch: epoch, afterEpoch: result.run.conversationEpoch ?? 0 };
          } catch (error) { compaction = { beforeEpoch: epoch, error: error.message }; }
        }
        await request("chat.send", { runId, content: "Now write settings.json as a JSON object with exactly jobId, region, retryLimit, and owner, using the launch settings we agreed on and the latest correction. Do not ask questions or invent missing values. Finish with submit_result." });
      }
      let outcome;
      for (;;) {
        if (Date.now() >= deadline) { outcome = { status: "timeout", questionsAsked: 0 }; break; }
        const result = await request("chat.wait", { runId, timeoutMs: Math.min(5000, deadline - Date.now()) });
        const status = result.run?.status ?? result.status;
        if (["complete", "blocked", "failed", "cancelled"].includes(status)) {
          outcome = { status, questionsAsked: status === "blocked" ? 1 : 0 };
          break;
        }
      }
      runStatus = outcome.status;
      const run = findRun(flags, runId);
      stages.push({ stage: stage + 1, outcome, trace: sessionTrace(home, run) });
      if (outcome.status !== "complete") break;
    }
    let actual;
    try { actual = JSON.parse(fs.readFileSync(path.join(workspace, "settings.json"), "utf8")); } catch {}
    const run = findRun(flags, runId);
    const trace = sessionTrace(home, run);
    const checks = [
      { name: "three completed turns", pass: stages.length === 3 && stages.every((stage) => stage.outcome.status === "complete") },
      { name: "exact settings with latest correction", pass: Boolean(actual) && Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => actual[key] === value) },
      { name: "context was not persisted through tools before final request", pass: stages.length >= 2 && stages.slice(0, 2).every((stage) => stage.trace.calls.length > 0 && stage.trace.calls.every((call) => call.name === "submit_result")) },
      { name: "no questions auto-answered", pass: stages.every((stage) => stage.outcome.questionsAsked === 0) },
      modelControlCheck(trace.models, model),
      ...(shouldCompact ? [{ name: "durable compaction advanced the epoch", pass: Boolean(compaction) && compaction.afterEpoch > compaction.beforeEpoch }] : []),
    ];
    const artifact = {
      kind: "direct-context-continuity", model, shouldCompact, runId, workspace,
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      startedAt: new Date(started).toISOString(), wallMs: Date.now() - started,
      passed: checks.every((check) => check.pass), checks, expected, actual: actual ?? null,
      compaction: compaction ?? null, stages,
      metrics: await runMetrics(flags, runId, null, runStatus),
    };
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(artifact, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ passed: artifact.passed, runId, checks, output }, null, 2));
    if (!artifact.passed) process.exitCode = 1;
  } finally {
    if (runId && runStatus !== "complete") await request("chat.cancel", { runId, reason: "Context smoke finished" }).catch(() => {});
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
