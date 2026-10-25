#!/usr/bin/env node
// Executable coverage for the Pi worker extension's direct lane and scratchpad
// (resources/pi-cora/worker.ts): submit_result keeps the whole user reply up to
// the reply cap (and the loop sentinel on its last line when it must cut), the
// direct prompt names the tools it lacks, and the scratchpad survives a
// process restart through CODARA_PI_SCRATCHPAD_PATH.
//
//   node scripts/test-pi-cora-direct-result.cjs

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pi-direct-"));

async function loadWorker() {
  const entry = path.join(ROOT, "resources", "pi-cora", "worker.ts");
  const output = await esbuild.build({
    entryPoints: [entry],
    // worker.ts resolves the bridge with createRequire(import.meta.url).
    define: { "import.meta.url": JSON.stringify(pathToFileURL(entry).href) },
    bundle: true,
    format: "cjs",
    platform: "node",
    packages: "external",
    write: false,
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function fakePi() {
  const tools = new Map();
  const handlers = new Map();
  return {
    tools,
    handlers,
    registerTool: (tool) => tools.set(tool.name, tool),
    registerProvider: () => {},
    registerCommand: () => {},
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    getActiveTools: () => [...tools.keys()],
    setActiveTools: () => {},
  };
}

function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

async function main() {
  const bridgePath = path.join(TMP, "bridge.cjs");
  fs.writeFileSync(
    bridgePath,
    "module.exports = { listTools: () => [], callToolByName: async () => ({ content: [] }) };\n",
  );
  const reportPath = path.join(TMP, "final-report.json");
  const scratchPath = path.join(TMP, "scratchpad.md");
  Object.assign(process.env, {
    CODARA_PI_BRIDGE_PATH: bridgePath,
    CODARA_PI_DIRECT_TASK: "1",
    CODARA_PI_FINAL_REPORT: reportPath,
    CODARA_PI_SCRATCHPAD_PATH: scratchPath,
  });
  delete process.env.CODARA_PI_DIRECT_STUDIO_TOOLS;

  const worker = await loadWorker();

  // 1. clipReply: short replies pass through untouched; long ones keep the
  // head, say they were cut, and keep a short final sentinel line.
  assert.equal(worker.clipReply("  hello  "), "hello");
  assert.equal(worker.clipReply(42), "");
  const long = `${"word ".repeat(5_000)}\nSPARK_LOOP_CONTINUE`;
  const clipped = worker.clipReply(long, 2_000);
  assert.ok(clipped.length <= 2_000, "the clip respects the cap");
  assert.match(clipped, /\[Reply truncated: it exceeded Cora's reply limit\.\]/);
  assert.match(clipped, /\nSPARK_LOOP_CONTINUE$/, "the loop sentinel stays on the last line");
  const noShortTail = worker.clipReply("x".repeat(5_000), 1_000);
  assert.ok(noShortTail.length <= 1_000);
  assert.match(noShortTail, /limit\.\]$/);

  // 2. A direct session: the reply lands in the report in full, and the
  // prompt tells the model what this lane cannot do.
  const pi = fakePi();
  worker.default(pi);
  const submit = pi.tools.get("submit_result");
  assert.ok(submit, "direct tasks get submit_result");
  assert.match(submit.parameters.properties.summary.description, /complete markdown reply/);
  const reply = `# Answer\n\n${"A full explanation paragraph. ".repeat(300)}`;
  assert.ok(reply.length > 2_000, "longer than the old one-sentence cap");
  await submit.execute("call-1", { status: "complete", summary: reply });
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.summary, reply.trim());

  const [beforeStart] = pi.handlers.get("before_agent_start");
  const { systemPrompt } = await beforeStart({ systemPrompt: "BASE" });
  assert.match(systemPrompt, /shown to the user verbatim as Cora's whole reply/);
  assert.match(systemPrompt, /cannot edit the whiteboard or board, create or change\s+automations/);
  assert.match(systemPrompt, /never fall back\s+to crontab, launchd, schtasks/);
  assert.match(systemPrompt, /fetch_url/);
  assert.doesNotMatch(systemPrompt, /codara_terminal_create/, "no terminal promise without terminal tools");

  // 3. The scratchpad persists and a restarted process reads it back.
  const scratchpad = pi.tools.get("scratchpad");
  await scratchpad.execute("call-2", { action: "write", content: "objective: ship\nnext: run tests" });
  assert.equal(fs.readFileSync(scratchPath, "utf8"), "objective: ship\nnext: run tests");
  const restarted = fakePi();
  worker.default(restarted);
  const read = await restarted.tools.get("scratchpad").execute("call-3", { action: "read" });
  assert.equal(textOf(read), "objective: ship\nnext: run tests");
  await restarted.tools.get("scratchpad").execute("call-4", { action: "clear" });
  assert.equal(fs.readFileSync(scratchPath, "utf8"), "");
  assert.deepEqual(
    fs.readdirSync(TMP).filter((name) => name.endsWith(".tmp")),
    [],
    "the atomic write leaves no temp file behind",
  );

  // 4. With Studio tools on the direct lane, the process rule appears.
  process.env.CODARA_PI_DIRECT_STUDIO_TOOLS = "1";
  const studio = fakePi();
  worker.default(studio);
  const [studioStart] = studio.handlers.get("before_agent_start");
  const studioPrompt = (await studioStart({ systemPrompt: "BASE" })).systemPrompt;
  assert.match(studioPrompt, /codara_terminal_create/);

  console.log("pi worker direct result + scratchpad persistence: ok");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
