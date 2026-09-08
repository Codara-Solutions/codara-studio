"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { rpcRaw } = require("../cli/lib/rpc.cjs");
const { findRun } = require("../cli/lib/store.cjs");
const { driveToCompletion, runMetrics } = require("../cli/commands/bench.cjs");
const { modelControlCheck } = require("../cli/bench/metrics.cjs");
const { sessionTrace } = require("./smoke-cora-browser.cjs");

async function main() {
  const home = process.env.CODARA_MEMORY_SMOKE_HOME;
  const output = process.env.CODARA_MEMORY_SMOKE_OUTPUT;
  if (!home || !output) throw new Error("Set CODARA_MEMORY_SMOKE_HOME and a new CODARA_MEMORY_SMOKE_OUTPUT");
  if (fs.existsSync(output)) throw new Error("Output already exists");
  const flags = { home: path.resolve(home) };
  const model = process.env.CODARA_MEMORY_SMOKE_MODEL ?? "gpt-5.6-luna";
  const request = async (method, params = {}) => {
    const response = await rpcRaw(flags, method, params, { timeoutMs: 15_000 });
    if (response.error) throw new Error(`${method}: ${response.error.message}`);
    return response.result;
  };
  const app = await request("app.info");
  if (path.resolve(app.homeDir) !== flags.home) throw new Error("Connected app is not the requested memory lab");
  const nonce = randomBytes(6).toString("hex");
  const original = `pack-${nonce}`;
  const corrected = `dist-${nonce}`;
  const globalStyle = `signature-${nonce}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cora-memory-"));
  const workspaces = ["one", "two"].map((name) => {
    const cwd = path.join(root, name);
    fs.mkdirSync(cwd);
    execFileSync("git", ["init", "-q"], { cwd });
    fs.writeFileSync(path.join(cwd, "README.md"), "# Memory validation workspace\n");
    return cwd;
  });
  const profiles = [];
  for (const name of ["one", "two"]) profiles.push((await request("profiles.create", { name: `Memory ${nonce} ${name}` })).profile.id);
  const artifact = {
    kind: "direct-persistent-memory", sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    model, root, profiles, expected: { original, corrected, globalStyle }, stages: [], checks: [],
  };
  const persist = () => fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
  const stage = async (name, cwd, profile, prompt, allowed) => {
    const created = await request("chat.create", { cwd, coraProfile: profile, prompt, backend: "pi", execution: "direct", model, effort: "high", title: `memory lab: ${name}` });
    const runId = created.run.id;
    let outcome;
    try {
      outcome = await driveToCompletion(flags, runId, Date.now() + 5 * 60_000, model);
      const run = findRun(flags, runId);
      const trace = sessionTrace(flags.home, run);
      const checks = [
        { name: `${name}: completed`, pass: outcome.status === "complete" },
        { name: `${name}: allowed tools only`, pass: trace.calls.length > 0 && trace.calls.every((call) => allowed.includes(call.name)) },
        modelControlCheck(trace.models, model),
      ];
      artifact.checks.push(...checks);
      artifact.stages.push({ name, runId, profile, workspaceId: run.workspaceId, outcome, trace, metrics: await runMetrics(flags, runId, null, outcome.status) });
      persist();
      return run;
    } finally {
      await request("chat.cancel", { runId, reason: "Memory smoke stage finished" }).catch(() => {});
    }
  };
  const recall = async (name, cwd, profile, expectedWorkspace, expectedGlobal) => {
    const file = path.join(cwd, "recall.json");
    fs.rmSync(file, { force: true });
    await stage(name, cwd, profile, 'Using only the Cora memory already supplied to this fresh chat, write recall.json with exactly {"workspacePrefix": the remembered artifact prefix for this repository or null if absent, "globalStyle": my remembered release-note signature or null if absent}. Do not guess missing values. Use only write and submit_result. Do not read files, search other conversations, or call memory tools.', ["write", "submit_result"]);
    let actual = null;
    try { actual = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const expected = { workspacePrefix: expectedWorkspace, globalStyle: expectedGlobal };
    artifact.checks.push({ name: `${name}: exact scoped recall`, pass: actual !== null && Object.keys(actual).length === 2 && Object.entries(expected).every(([key, value]) => actual[key] === value), expected, actual });
    fs.rmSync(file, { force: true });
    persist();
  };
  try {
    const seeded = await stage("save preferences", workspaces[0], profiles[0], `Remember these durable preferences: only for this repository, use artifact prefix ${original}. Across my workspaces, use release-note signature ${globalStyle}. Save them in the appropriate workspace/global memory scopes. Use only codara_remember and submit_result; do not write files or run commands.`, ["codara_remember", "submit_result"]);
    await recall("fresh conversation", workspaces[0], profiles[0], original, globalStyle);
    if (!/^[a-zA-Z0-9._-]+$/.test(seeded.workspaceId)) throw new Error("Unexpected workspace id");
    const memoryFile = path.join(flags.home, "memory", "profiles", profiles[0], "workspaces", `${seeded.workspaceId}.md`);
    const userLine = "- User rule: keep release archives outside the repository.";
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.appendFileSync(memoryFile, `\n${userLine}\n`);
    await stage("correct stale preference", workspaces[0], profiles[0], `Correction for this repository: the durable artifact prefix is now ${corrected}. Replace the old prefix preference, preserve all other valid memories and every user-authored line, and keep the global signature unchanged. Use only codara_remember and submit_result.`, ["codara_remember", "submit_result"]);
    const body = fs.readFileSync(memoryFile, "utf8");
    artifact.checks.push({ name: "stale preference removed and user-authored line retained", pass: body.includes(corrected) && !body.includes(original) && body.includes(userLine) });
    await recall("corrected fresh conversation", workspaces[0], profiles[0], corrected, globalStyle);
    await recall("different workspace", workspaces[1], profiles[0], null, globalStyle);
    await recall("different profile", workspaces[0], profiles[1], null, null);
    artifact.passed = artifact.checks.every((check) => check.pass);
    persist();
    console.log(JSON.stringify({ passed: artifact.passed, checks: artifact.checks, output }, null, 2));
    if (!artifact.passed) process.exitCode = 1;
  } catch (error) {
    artifact.error = error.message;
    artifact.passed = false;
    persist();
    throw error;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
