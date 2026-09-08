"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { headlessCommand, parseCodexOutput, parseClaudeOutput, codexSessionModels } = require("../cli/bench/headless.cjs");

const codex = parseCodexOutput([
  { type: "thread.started", thread_id: "12345678-1234-1234-1234-123456789abc" },
  { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 } },
].map(JSON.stringify).join("\n"));
assert.equal(codex.tokens, 1100, "cached input must not be counted twice");
assert.equal(codex.usage.inputTokens, 200);
assert.equal(codex.failed, false);
assert.equal(parseCodexOutput('{"type":"turn.failed"}').failed, true);
assert.equal(parseCodexOutput("non-json progress").failed, true);
const claude = parseClaudeOutput(JSON.stringify({ type: "result", subtype: "success", session_id: "session", num_turns: 3, usage: { input_tokens: 50, output_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 20 }, modelUsage: { "claude-sonnet-5": {} } }));
assert.equal(claude.tokens, 970);
assert.deepEqual(claude.models, ["claude-sonnet-5"]);
assert.equal(claude.failed, false);
assert.equal(parseClaudeOutput('{"type":"result","subtype":"error_max_turns"}').failed, true);
assert.equal(parseClaudeOutput("missing").failed, true);
assert.equal(parseClaudeOutput('{"type":"result","subtype":"success","is_error":true,"result":"Account unavailable"}').errorMessage, "Account unavailable");
assert.equal(headlessCommand("claude", { model: "claude-sonnet-5", effort: "high", prompt: "task" }).args.at(-2), "--", "variadic tool names must not consume the task prompt");
for (const agent of ["codex", "claude"]) {
  const invocation = headlessCommand(agent, { model: "exact-model", effort: "high", prompt: "literal `input` $HOME", resume: "exact-session" });
  assert.ok(invocation.args.includes("exact-model"));
  assert.ok(invocation.args.includes("exact-session"));
  assert.equal(invocation.args.at(-1), "literal `input` $HOME");
  assert.throws(() => headlessCommand(agent, { resume: true }), /exact session ID/);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codara-codex-telemetry-"));
try {
  fs.mkdirSync(path.join(root, "sessions", "day"), { recursive: true });
  fs.writeFileSync(path.join(root, "sessions", "day", `rollout-${codex.sessionId}.jsonl`), [
    { type: "session_meta", payload: {} },
    { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    { type: "turn_context", payload: { model: "unexpected-fallback" } },
  ].map(JSON.stringify).join("\n"));
  assert.deepEqual(codexSessionModels(root, codex.sessionId), ["gpt-5.6-sol", "unexpected-fallback"]);
  assert.deepEqual(codexSessionModels(root, "../../elsewhere"), []);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("headless CLI command and telemetry tests passed");

const { buildRivalCommand } = require("../cli/bench/rivals.cjs");
const hermes = buildRivalCommand("hermes", { dir: "/tmp/assigned workspace", prompt: "task", usageFile: "/tmp/usage.json" });
assert.equal(hermes.args[hermes.args.indexOf("--in") + 1], "/tmp/assigned workspace");
const { workspacePrompt } = require("../cli/commands/bench.cjs");
assert.equal(workspacePrompt("/tmp/assigned", "literal `task` $HOME"), "Assigned workspace: /tmp/assigned\nWork only in this workspace. Do not search other workspaces, prior agent sessions, or benchmark artifacts for solutions.\n\nliteral `task` $HOME");
