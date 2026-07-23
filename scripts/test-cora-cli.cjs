#!/usr/bin/env node
// Parser/wire-contract test for bin/cora.cjs's public Cora session commands.
// A tiny authenticated JSON-RPC server records requests; no Electron process,
// model call, or real Codara home is touched.

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-cli-test-"));
const WORKSPACE = path.join(TEST_HOME, "workspace");
const TOKEN = "cli-test-token";
fs.mkdirSync(WORKSPACE, { recursive: true });

let failures = 0;
function check(name, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition || !detail ? "" : ` — ${detail}`}`);
  if (!condition) failures += 1;
}

const requests = [];
const run = {
  id: "run-cli-contract-1234567890",
  workspaceId: "ws-cli-contract",
  title: "CLI contract",
  status: "running",
  settingsSnapshot: { workspaceCwd: WORKSPACE },
  humanMessages: [],
};

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    requests.push(parsed);
    let result;
    if (parsed.method === "chat.create") {
      result = { run, workspaceCreated: true, workspace: { id: run.workspaceId, cwd: WORKSPACE } };
    } else if (parsed.method === "chat.send") {
      result = { run: { ...run, humanMessages: [{ author: "user", message: parsed.params.content }] } };
    } else if (parsed.method === "chat.wait") {
      result = { run: { ...run, status: "complete" }, timedOut: false, needsAttention: false };
    } else if (parsed.method === "chat.cancel") {
      result = { run: { ...run, status: "cancelled", autopilot: { stopReason: parsed.params.reason } } };
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, error: { code: -32601, message: "unknown" } }));
      return;
    }
    const payload = JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  });
});

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "bin", "cora.cjs"), ...args], {
      cwd: WORKSPACE,
      env: { ...process.env, CODARA_HOME_DIR: TEST_HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  fs.writeFileSync(
    path.join(TEST_HOME, "agent-socket.json"),
    JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token: TOKEN }),
  );

  const started = await runCli([
    "start",
    "Build",
    "the",
    "fixture",
    "--backend",
    "codex",
    "--model",
    "gpt-test",
    "--mode",
    "execute",
    "--effort",
    "high",
    "--wait",
    "--timeout",
    "0",
    "--json",
  ]);
  check("start --wait exits successfully", started.code === 0, started.stderr);
  const create = requests.find((request) => request.method === "chat.create");
  check("start sends chat.create", Boolean(create));
  check("start defaults cwd to the invoking directory", create?.params?.cwd === WORKSPACE, create?.params?.cwd);
  check("start joins positional prompt words", create?.params?.prompt === "Build the fixture", create?.params?.prompt);
  check(
    "start forwards backend/model/mode/effort",
    create?.params?.backend === "codex" &&
      create?.params?.model === "gpt-test" &&
      create?.params?.mode === "execute" &&
      create?.params?.effort === "high",
    JSON.stringify(create?.params),
  );
  const firstWait = requests.find((request) => request.method === "chat.wait");
  check("start --wait follows the created run", firstWait?.params?.runId === run.id);
  check("timeout seconds are converted to milliseconds", firstWait?.params?.timeoutMs === 0);
  check("--json prints the terminal wait result", JSON.parse(started.stdout).run.status === "complete");

  requests.length = 0;
  const sent = await runCli(["send", "run-cli", "Continue", "carefully", "--wait", "--json"]);
  check("send --wait exits successfully", sent.code === 0, sent.stderr);
  check(
    "send forwards the run prefix and joined message",
    requests[0]?.method === "chat.send" &&
      requests[0]?.params?.runId === "run-cli" &&
      requests[0]?.params?.content === "Continue carefully",
    JSON.stringify(requests[0]),
  );
  check(
    "send --wait waits on the canonical returned id",
    requests[1]?.method === "chat.wait" && requests[1]?.params?.runId === run.id,
    JSON.stringify(requests[1]),
  );

  const invalid = await runCli(["wait", run.id, "--timeout", "later"]);
  check("invalid timeout fails before RPC", invalid.code === 1 && /invalid --timeout/i.test(invalid.stderr));

  requests.length = 0;
  const cancelled = await runCli(["cancel", "run-cli", "Benchmark", "timeout", "--json"]);
  check("cancel exits successfully", cancelled.code === 0, cancelled.stderr);
  check(
    "cancel forwards prefix and joined reason",
    requests[0]?.method === "chat.cancel" &&
      requests[0]?.params?.runId === "run-cli" &&
      requests[0]?.params?.reason === "Benchmark timeout",
    JSON.stringify(requests[0]),
  );
  check("cancel prints the cancelled run", JSON.parse(cancelled.stdout).run.status === "cancelled");

  if (failures) {
    console.error(`\n${failures} Cora CLI check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll Cora CLI checks passed.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    server.close();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });
