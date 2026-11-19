#!/usr/bin/env node
"use strict";

// Managed Cora workers on the `claude-code/` route
// (src/main/orchestration/claude-code-worker.ts). Runs against a fake
// `claude` that prints stream-json: no model is called.
//
//   node scripts/test-claude-code-worker.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "src", "main", "orchestration", "claude-code-worker.ts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-claude-code-worker-"));

async function load() {
  const outfile = path.join(TMP, "claude-code-worker.cjs");
  await esbuild.build({
    entryPoints: [SOURCE],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
    packages: "external",
    external: ["electron"],
  });
  return require(outfile);
}

// A stand-in for the Claude Code CLI: reads the prompt on stdin, prints the
// stream-json Claude Code prints, writes the report the prompt asks for.
const FAKE = path.join(TMP, "claude");
fs.writeFileSync(FAKE, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { prompt += c; });
process.stdin.on("end", () => {
  fs.writeFileSync(path.join(process.env.FAKE_OUT, "argv.json"), JSON.stringify(argv));
  fs.writeFileSync(path.join(process.env.FAKE_OUT, "prompt.txt"), prompt);
  fs.writeFileSync(path.join(process.env.FAKE_OUT, "env.json"), JSON.stringify({
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    SPARK_AGENT_TOKEN: process.env.SPARK_AGENT_TOKEN,
    SPARK_PANE_ID: process.env.SPARK_PANE_ID,
    SPARK_RUN_ID: process.env.SPARK_RUN_ID,
  }));
  if (prompt.includes("HANG")) { setInterval(() => {}, 1000); return; }
  if (prompt.includes("FAIL")) { process.stderr.write("Not logged in. Run /login\\n"); process.exit(1); }
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  out({ type: "system", subtype: "init", session_id: "sess-1", model: "claude-opus-5" });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Looking at the repo." }, { type: "tool_use", name: "Bash", input: { command: "npm test" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: [{ type: "text", text: "1 failing" }] }] } });
  const add = argv[argv.indexOf("--add-dir") + 1];
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: path.join(add, "final-report.json") } }] } });
  fs.writeFileSync(path.join(add, "final-report.json"), JSON.stringify({ status: "complete", summary: "done" }));
  // A line split across writes still parses.
  const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "sess-1",
    total_cost_usd: 1.5, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } });
  process.stdout.write(result.slice(0, 25));
  setTimeout(() => { process.stdout.write(result.slice(25) + "\\n"); }, 20);
});
`, { mode: 0o755 });

async function main() {
  const worker = await load();

  // Arguments: Studio's launch args first, then the same permission, model and
  // effort flags as Studio's Claude sessions, then headless stream-json and
  // the attempt folder for the report. Never --bare (API-key only).
  const argv = worker.claudeCodeWorkerArgv({
    launchArgs: ["--settings", "/h/settings.json", "--mcp-config=/h/mcp.json"],
    providerArgs: ["--dangerously-skip-permissions", "--model", "claude-opus-5", "--effort", "high"],
    attemptDir: "/runs/a1",
  });
  assert.deepEqual(argv, [
    "--settings", "/h/settings.json", "--mcp-config=/h/mcp.json",
    "--dangerously-skip-permissions", "--model", "claude-opus-5", "--effort", "high",
    "-p", "--output-format", "stream-json", "--verbose", "--add-dir", "/runs/a1",
  ]);
  assert.ok(!argv.includes("--bare"));
  assert.deepEqual(worker.claudeCodeModelAndEffort("claude-opus-5@xhigh", "high"), { model: "claude-opus-5", effort: "xhigh" });
  assert.deepEqual(worker.claudeCodeModelAndEffort("claude-opus-5", "high"), { model: "claude-opus-5", effort: "high" });
  console.log("PASS argv and model/effort");

  // Environment: an allowlist (test-claude-code-worker-boundary.cjs covers
  // what it drops), the account's CLAUDE_CONFIG_DIR, and the hook and run ids
  // a worker pane carries.
  const env = worker.claudeCodeWorkerEnv({
    baseEnv: { PATH: "/bin", SPARK_AGENT_TOKEN: "x", SPARK_AGENT_SOCKET: "y", SPARK_PANE_TOKEN: "z" },
    configDirEnv: "/acct",
    hookEnv: { SPARK_HOOK_URL: "http://127.0.0.1:1", SPARK_HOOK_TOKEN: "t", SPARK_PANE_ID: "att-1" },
    codaraHome: "/home/x/.codarastudio",
    runId: "run-1",
  });
  assert.equal(env.CLAUDE_CONFIG_DIR, "/acct");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.SPARK_AGENT_TOKEN, undefined);
  assert.equal(env.SPARK_AGENT_SOCKET, undefined);
  assert.equal(env.SPARK_PANE_TOKEN, undefined);
  assert.equal(env.SPARK_PANE_ID, "att-1");
  assert.equal(env.SPARK_RUN_ID, "run-1");
  assert.equal(env.SPARK_HOME_DIR, "/home/x/.codarastudio");
  console.log("PASS environment");

  // Parsing.
  assert.deepEqual(worker.parseClaudeCodeStreamLine("not json"), []);
  assert.deepEqual(worker.parseClaudeCodeStreamLine('{"type":"stream_event"}'), []);
  assert.deepEqual(
    worker.parseClaudeCodeStreamLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "foo\nbar" } }] } })),
    [{ kind: "tool", name: "Grep", detail: "foo bar" }],
  );
  assert.deepEqual(
    worker.parseClaudeCodeStreamLine(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, usage: {} })),
    [{ kind: "result", ok: false, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  );
  console.log("PASS stream-json parsing");

  // A full run against the fake CLI: prompt on stdin, every tool call seen,
  // usage read, the report written where the prompt says.
  const out = fs.mkdtempSync(path.join(TMP, "out-"));
  const attemptDir = fs.mkdtempSync(path.join(TMP, "attempt-"));
  const events = [];
  const run = worker.startClaudeCodeWorker({
    binary: FAKE,
    argv: [...argv.slice(0, -1), attemptDir],
    env: { ...process.env, FAKE_OUT: out, CLAUDE_CONFIG_DIR: "/acct", SPARK_PANE_ID: "att-1", SPARK_RUN_ID: "run-1" },
    cwd: TMP,
    prompt: "Do the task. When done, write valid JSON to the report.",
    onEvent: (event) => events.push(event),
  });
  const exit = await run.done;
  assert.equal(exit.exitCode, 0);
  assert.equal(fs.readFileSync(path.join(out, "prompt.txt"), "utf8"), "Do the task. When done, write valid JSON to the report.");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "env.json"), "utf8")), {
    CLAUDE_CONFIG_DIR: "/acct", SPARK_PANE_ID: "att-1", SPARK_RUN_ID: "run-1",
  });
  assert.deepEqual(events.map((event) => event.kind), ["session", "text", "tool", "tool_failed", "tool", "result"]);
  assert.deepEqual(events[2], { kind: "tool", name: "Bash", detail: "npm test" });
  assert.equal(events[3].detail, "1 failing");
  assert.deepEqual(events[5].usage, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
  assert.equal(events[5].ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(attemptDir, "final-report.json"), "utf8")).status, "complete");
  console.log("PASS fake Claude Code run: prompt, tool calls, usage, report");

  // A failure keeps the CLI's own words; a missing binary does not throw.
  const failed = worker.startClaudeCodeWorker({
    binary: FAKE, argv: [], env: { ...process.env, FAKE_OUT: out }, cwd: TMP, prompt: "FAIL", onEvent: () => undefined,
  });
  const failedExit = await failed.done;
  assert.equal(failedExit.exitCode, 1);
  assert.match(failedExit.stderrTail, /Not logged in/);
  const missing = worker.startClaudeCodeWorker({
    binary: path.join(TMP, "no-such-claude"), argv: [], env: process.env, cwd: TMP, prompt: "x", onEvent: () => undefined,
  });
  assert.equal((await missing.done).exitCode, 127);
  // Stop ends a running worker.
  const hanging = worker.startClaudeCodeWorker({
    binary: FAKE, argv: [], env: { ...process.env, FAKE_OUT: out }, cwd: TMP, prompt: "HANG", onEvent: () => undefined,
  });
  setTimeout(() => void hanging.kill(), 300);
  assert.notEqual((await hanging.done).exitCode, 0);
  console.log("PASS failure, missing binary and Stop");

  // The launch adds no identity: Studio's own launch and provider arguments
  // (run-store passes them in), never --bare or a key or base URL.
  const source = fs.readFileSync(SOURCE, "utf8");
  const runStore = fs.readFileSync(path.join(ROOT, "src", "main", "orchestration", "run-store.ts"), "utf8");
  assert.match(runStore, /getProvider\("claude"\)\.buildArgs\(/);
  assert.match(runStore, /launchArgs: claudeLaunchArgs\(\{ userArgs: providerArgs \}\)/);
  for (const banned of ["--bare", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "user-agent", "x-app"]) {
    assert.ok(!source.includes(banned), `claude-code-worker.ts does not touch ${banned}`);
  }
  console.log("PASS launch uses the selected account as Claude Code ships");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
