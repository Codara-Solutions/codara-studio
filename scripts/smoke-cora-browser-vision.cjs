"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { rpcRaw } = require("../cli/lib/rpc.cjs");
const { findRun } = require("../cli/lib/store.cjs");
const { driveToCompletion, runMetrics } = require("../cli/commands/bench.cjs");
const { modelControlCheck, trialPassed } = require("../cli/bench/metrics.cjs");
const { startVisionFixture } = require("../cli/bench/browser/vision-fixture.cjs");
const { sessionTrace } = require("./smoke-cora-browser.cjs");

async function main() {
  const home = process.env.CODARA_VISION_SMOKE_HOME;
  const output = process.env.CODARA_VISION_SMOKE_OUTPUT;
  if (!home || !output || fs.existsSync(output)) throw new Error("Set CODARA_VISION_SMOKE_HOME and a new CODARA_VISION_SMOKE_OUTPUT");
  const flags = { home: path.resolve(home) };
  const model = process.env.CODARA_VISION_SMOKE_MODEL ?? "gpt-5.6-sol";
  const request = async (method, params = {}) => {
    const response = await rpcRaw(flags, method, params, { timeoutMs: 15_000 });
    if (response.error) throw new Error(`${method}: ${response.error.message}`);
    return response.result;
  };
  const app = await request("app.info");
  if (path.resolve(app.homeDir) !== flags.home) throw new Error("Connected app is not the requested vision lab");
  const fixture = await startVisionFixture();
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cora-browser-vision-")));
  execFileSync("git", ["init", "-q"], { cwd });
  const prompt = [
    `Open ${fixture.url} in Codara Studio's integrated browser.`,
    "Use a browser screenshot to read the canvas chart visually. Select the stream with the lowest displayed p95 latency and click Confirm selection once.",
    "Reload the page and verify that the correct stream remains confirmed. The save is authorized in this isolated test application.",
    "Use only integrated codara_preview_* browser interaction tools and submit_result. Do not use JavaScript evaluation, shell, files, direct HTTP, console/network inspection, or source inspection to obtain the chart data.",
    "Use the screenshot to obtain the values; they are not available in the text snapshot. Finish without asking questions.",
  ].join(" ");
  fs.writeFileSync(path.join(cwd, "README.md"), "# Browser vision validation\n");
  let runId;
  const startedAt = Date.now();
  try {
    runId = (await request("chat.create", { cwd, prompt, backend: "pi", model, effort: "high", execution: "direct", title: "browser lab: canvas chart grounding" })).run.id;
    const outcome = await driveToCompletion(flags, runId, startedAt + 8 * 60_000, model);
    if (outcome.status !== "complete") await request("chat.cancel", { runId, reason: `Vision smoke ended: ${outcome.status}` });
    const run = findRun(flags, runId);
    const trace = sessionTrace(flags.home, run);
    const allowed = new Set(["list", "url", "navigate", "snapshot", "click", "type", "press_key", "key", "mouse", "scroll", "hover", "resize", "screenshot", "wait_for", "run"].map(action => `codara_preview_${action}`));
    allowed.add("submit_result");
    const names = trace.calls.flatMap(call => {
      const name = call.name.replace(/^mcp__codara-studio__/, "");
      return name === "codara_preview_run" ? [name, ...(call.arguments.steps ?? []).map(step => `codara_preview_${step.action}`)] : [name];
    });
    let imageResults = 0, imageBeforeConfirmation = false;
    const { confirmedAt } = fixture.snapshot();
    for (const file of trace.sessionFiles) {
      const screenshotCalls = new Set();
      for (const line of fs.readFileSync(path.join(flags.home, "pi-agent", "sessions", file), "utf8").split("\n").filter(Boolean)) {
        const event = JSON.parse(line);
        const message = event.message;
        if (message?.role === "assistant") {
          for (const block of message.content ?? []) {
            if (block.type !== "toolCall") continue;
            const name = block.name.replace(/^mcp__codara-studio__/, "");
            if (name === "codara_preview_screenshot" || (name === "codara_preview_run" && block.arguments.steps?.some(step => step.action === "screenshot"))) screenshotCalls.add(block.id);
          }
        }
        if (message?.role === "toolResult" && screenshotCalls.has(message.toolCallId)) {
          const count = (message.content ?? []).filter(block => block.type === "image" && typeof block.data === "string" && block.data.length > 0).length;
          imageResults += count;
          const receivedAt = Date.parse(event.timestamp);
          if (count > 0 && confirmedAt !== null && Number.isFinite(receivedAt) && receivedAt < confirmedAt) imageBeforeConfirmation = true;
        }
      }
    }
    const checks = [
      ...fixture.grade(), modelControlCheck(trace.models, model),
      { name: "screenshot invoked and image returned to the model", pass: names.includes("codara_preview_screenshot") && imageResults > 0 },
      { name: "screenshot image received before confirmation", pass: imageBeforeConfirmation },
      { name: "only permitted browser interaction tools used", pass: names.length > 0 && names.every(name => allowed.has(name)), detail: names.filter(name => !allowed.has(name)).join(", ") },
      { name: "no user intervention", pass: outcome.questionsAsked === 0 },
    ];
    const result = { runStatus: outcome.status, checks, wallMs: Date.now() - startedAt, questionsAsked: outcome.questionsAsked, ...await runMetrics(flags, runId, null, outcome.status) };
    const artifact = { kind: "integrated-browser-canvas-vision", protocolVersion: 1, startedAt: new Date(startedAt).toISOString(), appVersion: app.version, appPid: app.pid, sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), runtimeBuildCommit: process.env.CODARA_VISION_RUNTIME_COMMIT ?? null, model, runId, cwd, imageResults, passed: trialPassed(result), ...result, state: fixture.snapshot(), trace };
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(artifact, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ passed: artifact.passed, model, runId, checks, output }, null, 2));
    if (!artifact.passed) process.exitCode = 1;
  } finally {
    if (runId) await request("chat.cancel", { runId, reason: "Vision smoke finished" }).catch(() => {});
    await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
