"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { rpcRaw, homeDir } = require("../cli/lib/rpc.cjs");
const { findRun } = require("../cli/lib/store.cjs");
const { driveToCompletion, runMetrics } = require("../cli/commands/bench.cjs");
const { modelControlCheck, trialPassed } = require("../cli/bench/metrics.cjs");
const { startTicketFixture, TARGET_ID, EXPECTED_NOTE } = require("../cli/bench/browser/ticket-fixture.cjs");

function sessionTrace(home, run) {
  const root = path.join(home, "pi-agent", "sessions");
  const files = fs.readdirSync(root).filter((file) => file.endsWith(".jsonl") && run.workerAttempts.some((attempt) => file.includes(attempt.id)));
  const calls = [];
  const models = new Set();
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(root, file), "utf8").split("\n").filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.message?.role !== "assistant") continue;
      if (event.message.model) models.add(event.message.model);
      for (const block of event.message.content ?? []) {
        if (block.type === "toolCall") calls.push({ name: block.name, arguments: block.arguments });
      }
    }
  }
  return { sessionFiles: files, calls, models: [...models] };
}

async function main() {
  const flags = { home: process.env.CODARA_BROWSER_SMOKE_HOME ?? homeDir() };
  const model = process.env.CODARA_BROWSER_SMOKE_MODEL ?? "gpt-5.6-sol";
  const output = process.env.CODARA_BROWSER_SMOKE_OUTPUT;
  if (!output) throw new Error("Set CODARA_BROWSER_SMOKE_OUTPUT to a new JSON artifact path");
  if (fs.existsSync(output)) throw new Error("The output artifact already exists");
  const request = async (method, params) => {
    const response = await rpcRaw(flags, method, params, { timeoutMs: 15_000 });
    if (response.error) throw new Error(`${method}: ${response.error.message}`);
    return response.result;
  };
  const app = await request("app.info", {});
  const fixture = await startTicketFixture();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cora-browser-ticket-"));
  const prompt = [
    `Use Codara Studio's integrated browser to open ${fixture.url}`,
    `Find ticket ${TARGET_ID}, Release checklist, on the Platform team. Set its priority to High and its note to exactly: ${EXPECTED_NOTE}`,
    "Save and confirm the change, preserving the ticket's current owner. If another edit conflicts with yours, reload the current ticket and reapply your requested changes.",
    "Verify the saved values by reopening the ticket. Leave every other ticket unchanged.",
    "Use only the integrated codara_preview_* browser interaction tools and submit_result. Do not use shell, filesystem tools, direct HTTP requests, or JavaScript evaluation to operate this task.",
    "This is an isolated test application; the requested save is authorized. Finish without asking questions.",
  ].join(" ");
  fs.writeFileSync(path.join(workspace, "README.md"), "# Browser workflow test workspace\n\n" + prompt + "\n");
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  let runId;
  const started = Date.now();
  try {
    const created = await request("chat.create", { cwd: workspace, prompt, backend: "pi", model, effort: "high", execution: "direct", title: "browser lab: ticket conflict recovery" });
    runId = created.run.id;
    const outcome = await driveToCompletion(flags, runId, started + 8 * 60_000, model);
    if (outcome.status !== "complete") await request("chat.cancel", { runId, reason: `Browser smoke ended: ${outcome.status}` });
    const run = findRun(flags, runId);
    const metrics = await runMetrics(flags, runId, null, outcome.status);
    const trace = sessionTrace(flags.home, run);
    const allowed = new Set([
      "codara_preview_list", "codara_preview_url", "codara_preview_navigate", "codara_preview_snapshot",
      "codara_preview_click", "codara_preview_type", "codara_preview_press_key", "codara_preview_key",
      "codara_preview_mouse", "codara_preview_scroll", "codara_preview_screenshot", "codara_preview_wait_for",
      "codara_preview_run",
      "submit_result",
    ]);
    const names = trace.calls.flatMap((call) => {
      const name = call.name.replace(/^mcp__codara-studio__/, "");
      if (name !== "codara_preview_run") return [name];
      return [name, ...(call.arguments.steps ?? []).map((step) => `codara_preview_${step.action}`)];
    });
    const checks = [
      ...fixture.grade(),
      modelControlCheck(trace.models, model),
      { name: "integrated browser actually used", pass: names.includes("codara_preview_navigate") && names.includes("codara_preview_snapshot") && names.includes("codara_preview_click") },
      { name: "only permitted browser interaction tools used", pass: names.length > 0 && names.every((name) => allowed.has(name)), detail: names.filter((name) => !allowed.has(name)).join(", ") },
      { name: "no user intervention", pass: outcome.questionsAsked === 0 },
    ];
    const result = { runStatus: outcome.status, checks, wallMs: Date.now() - started, questionsAsked: outcome.questionsAsked, ...metrics };
    const artifact = {
      kind: "integrated-browser-ticket-workflow", startedAt: new Date(started).toISOString(),
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      appVersion: app.version, appPid: app.pid, model, runId, workspace, fixtureUrl: fixture.url,
      passed: trialPassed(result), ...result, state: fixture.snapshot(), trace,
    };
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(artifact, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ passed: artifact.passed, model, runId, wallMs: result.wallMs, tokens: result.tokens, checks, output }, null, 2));
    if (!artifact.passed) process.exitCode = 1;
  } finally {
    if (runId) await request("chat.cancel", { runId, reason: "Browser smoke finished; artifacts retained" }).catch(() => {});
    await fixture.close();
  }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { sessionTrace };
