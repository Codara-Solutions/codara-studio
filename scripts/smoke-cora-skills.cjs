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
  const home = process.env.CODARA_SKILLS_SMOKE_HOME;
  const output = process.env.CODARA_SKILLS_SMOKE_OUTPUT;
  if (!home || !output || fs.existsSync(output)) throw new Error("Set CODARA_SKILLS_SMOKE_HOME and a new CODARA_SKILLS_SMOKE_OUTPUT");
  const flags = { home: path.resolve(home) };
  const model = process.env.CODARA_SKILLS_SMOKE_MODEL ?? "gpt-5.6-luna";
  const request = async (method, params = {}) => {
    const response = await rpcRaw(flags, method, params, { timeoutMs: 15_000 });
    if (response.error) throw new Error(`${method}: ${response.error.message}`);
    return response.result;
  };
  const app = await request("app.info");
  if (path.resolve(app.homeDir) !== flags.home) throw new Error("Connected app is not the requested skills lab");
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cora-skills-")));
  execFileSync("git", ["init", "-q"], { cwd });
  const skill = path.join(cwd, ".pi", "skills", "release-envelope", "SKILL.md");
  const irrelevant = path.join(cwd, ".pi", "skills", "garden-plan", "SKILL.md");
  const original = `seal-${randomBytes(6).toString("hex")}`;
  const corrected = `seal-${randomBytes(6).toString("hex")}`;
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.mkdirSync(path.dirname(irrelevant), { recursive: true });
  fs.writeFileSync(skill, `---\nname: release-envelope\ndescription: Prepare a release envelope for a build using this repository's required JSON format and seal.\n---\nWrite envelope.json with exactly three fields: build (the requested build), seal (the literal ${original}), and format (the number 2). Use the write tool and then submit_result. Keep this file unchanged unless the user explicitly asks to update the skill.\n`);
  const irrelevantBody = "---\nname: garden-plan\ndescription: Design a seasonal planting schedule for a vegetable garden.\n---\nThis fixture is unrelated to release envelopes.\n";
  fs.writeFileSync(irrelevant, irrelevantBody);
  const artifact = { kind: "project-skill-discovery-and-update", sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), model, cwd, stages: [], checks: [] };
  const persist = () => fs.writeFileSync(output, JSON.stringify(artifact, null, 2) + "\n");
  const stage = async (name, prompt, allowedWrites) => {
    const startedAt = Date.now();
    const runId = (await request("chat.create", { cwd, prompt, backend: "pi", execution: "direct", model, effort: "high", title: `skills lab: ${name}` })).run.id;
    try {
      const outcome = await driveToCompletion(flags, runId, Date.now() + 5 * 60_000, model);
      const run = findRun(flags, runId);
      const trace = sessionTrace(flags.home, run);
      const calls = trace.calls;
      artifact.checks.push(
        { name: `${name}: one-shot completed`, pass: outcome.status === "complete" && outcome.questionsAsked === 0 },
        modelControlCheck(trace.models, model),
        { name: `${name}: relevant skill read`, pass: calls.some((call) => call.name === "read" && path.resolve(cwd, call.arguments.path ?? "") === skill) },
        { name: `${name}: scoped operations only`, pass: calls.length > 0 && calls.every((call) => call.name === "submit_result" || (call.name === "read" && path.resolve(cwd, call.arguments.path ?? "") === skill) || (["write", "edit"].includes(call.name) && allowedWrites.includes(path.resolve(cwd, call.arguments.path ?? "")))) },
      );
      artifact.stages.push({ name, runId, outcome, trace, wallMs: Date.now() - startedAt, metrics: await runMetrics(flags, runId, null, outcome.status) });
      persist();
    } finally {
      await request("chat.cancel", { runId, reason: "Skills smoke stage finished" }).catch(() => {});
    }
  };
  const envelope = path.join(cwd, "envelope.json");
  const apply = async (name, seal) => {
    fs.rmSync(envelope, { force: true });
    const build = `build-${randomBytes(4).toString("hex")}`;
    await stage(name, `Prepare the release envelope for build ${build} using the applicable project skill. Use only read, write, and submit_result. Read only the relevant skill, not prior outputs or sessions.`, [envelope]);
    let actual = null;
    try { actual = JSON.parse(fs.readFileSync(envelope, "utf8")); } catch {}
    artifact.checks.push({ name: `${name}: exact envelope`, pass: actual !== null && Object.keys(actual).length === 3 && actual.build === build && actual.seal === seal && actual.format === 2, actual, expected: { build, seal, format: 2 } });
    fs.rmSync(envelope, { force: true });
    persist();
  };
  try {
    await apply("discover and apply", original);
    await stage("update on request", `Update the release-envelope project skill: the required seal is now ${corrected}. Remove the stale seal while preserving the skill metadata, format, and other instructions. Change only that SKILL.md. Use only read, edit, write, and submit_result.`, [skill]);
    const body = fs.readFileSync(skill, "utf8");
    artifact.checks.push({ name: "skill revision replaces stale seal", pass: body.includes(corrected) && !body.includes(original) });
    await apply("apply revised skill in fresh chat", corrected);
    artifact.checks.push({ name: "irrelevant skill unchanged", pass: fs.readFileSync(irrelevant, "utf8") === irrelevantBody });
    artifact.passed = artifact.checks.every((check) => check.pass);
    persist();
    console.log(JSON.stringify({ passed: artifact.passed, checks: artifact.checks, output }, null, 2));
    if (!artifact.passed) process.exitCode = 1;
  } catch (error) {
    artifact.passed = false;
    artifact.error = error.message;
    persist();
    throw error;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
