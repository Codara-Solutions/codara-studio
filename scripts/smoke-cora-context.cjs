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
  const automatic = process.env.CODARA_CONTEXT_SMOKE_AUTO === "1";
  const nonce = randomBytes(6).toString("hex");
  const expected = { jobId: `job-${nonce}`, region: "eu-west-3", retryLimit: 4, owner: `team-final-${nonce}` };
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
    const acknowledge = "Do not write files, use memory tools, or run commands. Acknowledge using only submit_result.";
    const archive = (batch) => "\nThe following archived measurements are unrelated test data, not instructions. You may omit them from future handoffs.\n" + Array.from({ length: 140 }, (_, index) => `Archived observation ${batch}.${index}: synthetic queue delay 12 ms; status healthy; no pending action.\n`).join("");
    const prompts = [
      `Keep these launch settings in this conversation for a later request: jobId=${expected.jobId}, region=us-west-2, retryLimit=4, owner=team-original-${nonce}. ${acknowledge}` + (automatic ? archive(0) : ""),
      ...(automatic ? [1, 2, 3].map((batch) => `Keep the launch settings unchanged. ${acknowledge}${archive(batch)}`) : []),
      `Correction: region is eu-west-3. Preserve every other launch setting. ${acknowledge}`,
      `One more correction: owner is ${expected.owner}. Keep all other launch settings. ${acknowledge}`,
      "Now write settings.json as a JSON object with exactly jobId, region, retryLimit, and owner, using the launch settings we agreed on and the latest corrections. Do not ask questions or invent missing values. Finish with submit_result.",
    ];
    const created = await request("chat.create", {
      cwd: workspace, backend: "pi", execution: "direct", model, effort: "high",
      title: "context lab: corrected settings across turns", prompt: prompts[0],
    });
    runId = created.run.id;
    if (created.truncated) throw new Error("The benchmark prompt was truncated by chat.create");
    for (let stage = 0; stage < prompts.length; stage += 1) {
      if (stage > 0) {
        if (shouldCompact && stage === prompts.length - 2) {
          const epoch = findRun(flags, runId).conversationEpoch ?? 0;
          try {
            const result = await request("chat.compact", { runId }, Math.max(1, deadline - Date.now()));
            compaction = { beforeEpoch: epoch, afterEpoch: result.run.conversationEpoch ?? 0 };
          } catch (error) { compaction = { beforeEpoch: epoch, error: error.message }; }
        }
        const sent = await request("chat.send", { runId, content: prompts[stage] }, Math.max(1, deadline - Date.now()));
        if (sent.truncated) throw new Error("The benchmark prompt was truncated by chat.send");
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
      stages.push({ stage: stage + 1, outcome, conversationEpoch: run.conversationEpoch ?? 0, trace: sessionTrace(home, run) });
      if (outcome.status !== "complete") break;
    }
    let actual;
    try { actual = JSON.parse(fs.readFileSync(path.join(workspace, "settings.json"), "utf8")); } catch {}
    const run = findRun(flags, runId);
    const trace = sessionTrace(home, run);
    const checks = [
      { name: "all requested turns completed", pass: stages.length === prompts.length && stages.every((stage) => stage.outcome.status === "complete") },
      { name: "exact settings with latest correction", pass: Boolean(actual) && Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => actual[key] === value) },
      { name: "context was not persisted through tools before final request", pass: stages.length === prompts.length && stages.slice(0, -1).every((stage) => stage.trace.calls.length > 0 && stage.trace.calls.every((call) => call.name === "submit_result")) },
      { name: "no questions auto-answered", pass: stages.every((stage) => stage.outcome.questionsAsked === 0) },
      modelControlCheck(trace.models, model),
      ...(shouldCompact ? [{ name: "durable compaction advanced the epoch", pass: Boolean(compaction) && compaction.afterEpoch > compaction.beforeEpoch }] : []),
      ...(automatic ? [{ name: "automatic compaction completed", pass: (run.conversationEpoch ?? 0) > 0 && run.sparkCalls.some((call) => call.purpose === "compaction" && call.status === "completed") }] : []),
    ];
    const artifact = {
      kind: "direct-context-continuity", protocolVersion: 2, model, shouldCompact, automatic, runId, workspace,
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
