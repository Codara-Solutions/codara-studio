"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes, createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { rpcRaw } = require("../cli/lib/rpc.cjs");
const { findRun } = require("../cli/lib/store.cjs");
const { driveToCompletion, runMetrics } = require("../cli/commands/bench.cjs");
const { modelControlCheck } = require("../cli/bench/metrics.cjs");
const { sessionTrace } = require("./smoke-cora-browser.cjs");

async function main() {
  const home = process.env.CODARA_LONG_CONTEXT_HOME;
  const output = process.env.CODARA_LONG_CONTEXT_OUTPUT;
  if (!home || !output) throw new Error("Set CODARA_LONG_CONTEXT_HOME and a new CODARA_LONG_CONTEXT_OUTPUT");
  if (fs.existsSync(output)) throw new Error("Output already exists");
  const flags = { home: path.resolve(home) };
  const model = process.env.CODARA_LONG_CONTEXT_MODEL ?? "gpt-5.6-luna";
  const expectCompaction = process.env.CODARA_LONG_CONTEXT_EXPECT_COMPACTION !== "0";
  const request = async (method, params = {}) => {
    const response = await rpcRaw(flags, method, params, { timeoutMs: 15_000 });
    if (response.error) throw new Error(`${method}: ${response.error.message}`);
    return response.result;
  };
  const info = await request("app.info");
  if (path.resolve(info.homeDir) !== flags.home) throw new Error("Connected app is not the requested long-context lab");
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cora-long-context-")));
  execFileSync("git", ["init", "-q"], { cwd });
  const approvalCode = `release-${randomBytes(6).toString("hex")}`;
  const records = Array.from({ length: 8 }, (_, id) => ({ id, marker: randomBytes(8).toString("hex") }));
  const reader = `"use strict";\nconst fs=require("node:fs");\nconst records=${JSON.stringify(records)};\nconst id=Number(process.argv[2]);\nif(!Number.isInteger(id)||!records[id])throw new Error("invalid record");\nlet counts=Array(8).fill(0);try{counts=JSON.parse(fs.readFileSync("read-counts.json","utf8"));}catch{}\ncounts[id]++;fs.writeFileSync("read-counts.json",JSON.stringify(counts));\nconsole.log("Required evidence:",JSON.stringify(records[id]));\nfor(let row=0;row<400;row++)console.log("Archived telemetry record "+id+"."+row+": queue healthy; latency 12ms; retained only for audit.");\n`;
  fs.writeFileSync(path.join(cwd, "read.js"), reader);
  fs.writeFileSync(path.join(cwd, "README.md"), "# Long-context tool protocol\n");
  const prompt = `The release approval code is ${approvalCode}; retain it until the final result. Collect eight evidence records by running exactly one command per bash tool call: node read.js N, for N=0 through 7 in order, once each. These reads have a side effect, so do not repeat any successful read even after compaction. Keep each required evidence id/marker, ignore archived telemetry in handoffs. After all eight reads, write answers.json with exactly {approvalCode, evidence: [{id,marker}, ...]} in id order. Use only bash for those exact reader commands, then write for answers.json and submit_result. Do not inspect or modify read.js, combine reads in one command, save notes through tools, or write intermediate files yourself. Finish without questions.`;
  const startedAt = Date.now();
  let runId;
  try {
    runId = (await request("chat.create", { cwd, prompt, backend: "pi", execution: "direct", model, effort: "high", title: "context lab: one-shot evidence across tool-round compaction" })).run.id;
    const outcome = await driveToCompletion(flags, runId, Date.now() + 15 * 60_000, model);
    const run = findRun(flags, runId);
    const trace = sessionTrace(flags.home, run);
    const entries = trace.sessionFiles.flatMap((file) => fs.readFileSync(path.join(flags.home, "pi-agent", "sessions", file), "utf8").split("\n").filter(Boolean).map(JSON.parse));
    const compactions = entries.filter((entry) => entry.type === "compaction").map(({ tokensBefore, summary, usage }) => ({ tokensBefore, summaryChars: summary.length, usage }));
    const pauses = entries.filter((entry) => entry.type === "custom" && entry.customType === "codara-context-pause").map((entry) => entry.data);
    let actual = null, counts = null;
    try { actual = JSON.parse(fs.readFileSync(path.join(cwd, "answers.json"), "utf8")); } catch {}
    try { counts = JSON.parse(fs.readFileSync(path.join(cwd, "read-counts.json"), "utf8")); } catch {}
    const expected = { approvalCode, evidence: records };
    const checks = [
      { name: "one-shot completed", pass: outcome.status === "complete" && outcome.questionsAsked === 0 },
      { name: "all original requirements and evidence retained", pass: actual !== null && actual.approvalCode === approvalCode && Array.isArray(actual.evidence) && actual.evidence.length === records.length && records.every((record, index) => actual.evidence[index]?.id === record.id && actual.evidence[index]?.marker === record.marker && Object.keys(actual.evidence[index]).length === 2) && Object.keys(actual).length === 2 },
      { name: "each side effect occurred exactly once", pass: Array.isArray(counts) && counts.length === 8 && counts.every((count) => count === 1) },
      { name: "reader unchanged", pass: fs.readFileSync(path.join(cwd, "read.js"), "utf8") === reader },
      { name: "only permitted tool operations", pass: trace.calls.length > 0 && trace.calls.every((call) => call.name === "submit_result" || (call.name === "write" && typeof call.arguments.path === "string" && path.resolve(cwd, call.arguments.path) === path.join(cwd, "answers.json")) || (call.name === "bash" && /^node read\.js [0-7]$/.test(call.arguments.command?.trim() ?? ""))) },
      modelControlCheck(trace.models, model),
      { name: "host compaction occurred during the task", pass: !expectCompaction || (pauses.length > 0 && compactions.length >= pauses.length) },
    ];
    const artifact = { kind: "long-one-shot-context", sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), runtimeBuildCommit: process.env.CODARA_LONG_CONTEXT_RUNTIME_COMMIT ?? null, wallMs: Date.now() - startedAt, model, runId, cwd, expectCompaction, expected, actual, counts, pauses, compactions, checks, trace, metrics: await runMetrics(flags, runId, null, outcome.status), readerHash: createHash("sha256").update(reader).digest("hex"), passed: checks.every((check) => check.pass) };
    fs.writeFileSync(output, JSON.stringify(artifact, null, 2) + "\n");
    console.log(JSON.stringify({ passed: artifact.passed, checks, pauses, output }, null, 2));
    if (!artifact.passed) process.exitCode = 1;
  } finally {
    if (runId) await request("chat.cancel", { runId, reason: "Long-context smoke finished" }).catch(() => {});
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
