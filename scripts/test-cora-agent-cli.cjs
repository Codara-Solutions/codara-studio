#!/usr/bin/env node
// Contract test for the typed `cora agent ...` wrappers. A tiny authenticated
// JSON-RPC server records the exact request envelopes; no Electron process,
// worker runtime, shell command, or real Codara home is touched.

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-agent-cli-test-"));
const TOKEN = "c".repeat(64);
const RUN_ID = "run-agent-contract-1234567890";
const TASK_ONE = "task-alpha-one-1234567890";
const TASK_TWO = "task-alpha-two-1234567890";
const TASK_BETA = "task-beta-1234567890";
const requests = [];
let failures = 0;

function check(name, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition || !detail ? "" : ` — ${detail}`}`);
  if (!condition) failures += 1;
}

function writeRun(run) {
  const directory = path.join(TEST_HOME, "runs", run.id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "run.json"), JSON.stringify(run));
}

writeRun({
  id: RUN_ID,
  status: "running",
  workerTasks: [
    { id: TASK_ONE, status: "running", runtimePreference: "claude" },
    { id: TASK_TWO, status: "queued", runtimePreference: "codex" },
    { id: TASK_BETA, status: "accepted", runtimePreference: "codex" },
  ],
  workerAttempts: [],
});
writeRun({ id: "run-ambiguous-one", status: "running", workerTasks: [], workerAttempts: [] });
writeRun({ id: "run-ambiguous-two", status: "running", workerTasks: [], workerAttempts: [] });

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    requests.push(parsed);
    let result;
    if (parsed.method === "orchestrator.spawn_workers") {
      result = {
        worker_task_ids: ["task-spawned-1234567890"],
        note: "Worker queued.",
      };
    } else if (parsed.method === "orchestrator.get_worker_status") {
      result = {
        worker_task_id: parsed.params.worker_task_id,
        task_status: "running",
        attempt_status: "running",
        runtime: "codex",
        started_at: "2026-07-31T10:00:00.000Z",
        finished_at: null,
        final_report_path: null,
      };
    } else if (parsed.method === "orchestrator.message_workers") {
      result = {
        ok: true,
        message_id: "message-agent-cli-1",
        to: parsed.params.to,
      };
    } else if (parsed.method === "orchestrator.wait_for_workers") {
      result = {
        workers: parsed.params.worker_task_ids.map((workerTaskId) => ({
          worker_task_id: workerTaskId,
          task_status: "accepted",
          attempt_status: "succeeded",
          runtime: "codex",
          started_at: "2026-07-31T10:00:00.000Z",
          finished_at: "2026-07-31T10:00:01.000Z",
          final_report_path: `/reports/${workerTaskId}.json`,
          final_report: { summary: `Completed ${workerTaskId}` },
        })),
        manager_messages: [],
        reason: parsed.params.mode === "any" ? "any_terminal" : "all_terminal",
      };
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          error: { code: -32601, message: "unknown method" },
        }),
      );
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
      cwd: ROOT,
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

  const shellMarker = path.join(TEST_HOME, "shell-interpolation-must-not-run");
  const literalBrief = `Inspect literally $(touch ${shellMarker}); do not execute it`;
  const spawned = await runCli([
    "agent",
    "spawn",
    "run-agent-contract",
    literalBrief,
    "--title",
    "Typed CLI audit",
    "--runtime",
    "codex",
    "--model",
    "gpt-5.6-sol",
    "--effort",
    "high",
    "--class",
    "feature",
    "--complexity",
    "standard",
    "--allowed-paths",
    '["src/main","scripts/test-cora-agent-cli.cjs"]',
    "--forbidden-paths",
    '["dist"]',
    "--expected-outputs",
    '["bin/cora.cjs"]',
    "--verification-commands",
    '["node --check bin/cora.cjs"]',
    "--json",
  ]);
  check("spawn exits successfully", spawned.code === 0, spawned.stderr);
  const spawnRequest = requests.at(-1);
  check(
    "spawn resolves the run prefix and calls only the orchestrator RPC",
    spawnRequest?.method === "orchestrator.spawn_workers" &&
      spawnRequest?.params?.runId === RUN_ID,
    JSON.stringify(spawnRequest),
  );
  check(
    "spawn sends one typed worker with strict option mappings",
    spawnRequest?.params?.taskComplexity === "standard" &&
      spawnRequest?.params?.workers?.length === 1 &&
      spawnRequest.params.workers[0].title === "Typed CLI audit" &&
      spawnRequest.params.workers[0].description === literalBrief &&
      spawnRequest.params.workers[0].runtimePreference === "codex" &&
      spawnRequest.params.workers[0].modelHint === "gpt-5.6-sol" &&
      spawnRequest.params.workers[0].effortHint === "high" &&
      spawnRequest.params.workers[0].taskClass === "feature" &&
      spawnRequest.params.workers[0].allowedPaths?.[0] === "src/main" &&
      spawnRequest.params.workers[0].verificationCommands?.[0] ===
        "node --check bin/cora.cjs",
    JSON.stringify(spawnRequest?.params),
  );
  check("spawn JSON output is machine-readable", JSON.parse(spawned.stdout).worker_task_ids?.length === 1);
  check("spawn never evaluates task text through a shell", !fs.existsSync(shellMarker));

  let requestCount = requests.length;
  const badRuntime = await runCli([
    "agent",
    "spawn",
    RUN_ID,
    "No request",
    "--title",
    "Bad runtime",
    "--runtime",
    "python",
  ]);
  check(
    "spawn rejects an invalid runtime before RPC",
    badRuntime.code === 1 &&
      /invalid --runtime/i.test(badRuntime.stderr) &&
      requests.length === requestCount,
    badRuntime.stderr,
  );
  const badPaths = await runCli([
    "agent",
    "spawn",
    RUN_ID,
    "No request",
    "--title",
    "Bad paths",
    "--allowed-paths",
    "src/main",
  ]);
  check(
    "spawn rejects non-JSON path arrays before RPC",
    badPaths.code === 1 &&
      /allowed-paths must be valid JSON/i.test(badPaths.stderr) &&
      requests.length === requestCount,
    badPaths.stderr,
  );
  const unknownSpawnFlag = await runCli([
    "agent",
    "spawn",
    RUN_ID,
    "No request",
    "--title",
    "Unknown flag",
    "--command",
    "touch nope",
  ]);
  check(
    "spawn rejects unsupported flags before RPC",
    unknownSpawnFlag.code === 1 &&
      /unsupported flag.*--command/i.test(unknownSpawnFlag.stderr) &&
      requests.length === requestCount,
    unknownSpawnFlag.stderr,
  );

  const status = await runCli([
    "agent",
    "status",
    "run-agent-contract",
    "task-beta",
    "--json",
  ]);
  check("status exits successfully", status.code === 0, status.stderr);
  const statusRequest = requests.at(-1);
  check(
    "status resolves run and task prefixes to canonical ids",
    statusRequest?.method === "orchestrator.get_worker_status" &&
      statusRequest.params.runId === RUN_ID &&
      statusRequest.params.worker_task_id === TASK_BETA,
    JSON.stringify(statusRequest),
  );
  check("status JSON output is machine-readable", JSON.parse(status.stdout).task_status === "running");

  requestCount = requests.length;
  const ambiguousTask = await runCli([
    "agent",
    "status",
    RUN_ID,
    "task-alpha",
  ]);
  check(
    "status rejects an ambiguous task prefix before RPC",
    ambiguousTask.code === 1 &&
      /task prefix.*ambiguous/i.test(ambiguousTask.stderr) &&
      requests.length === requestCount,
    ambiguousTask.stderr,
  );
  const ambiguousRun = await runCli([
    "agent",
    "status",
    "run-ambiguous",
    "task-any",
  ]);
  check(
    "status rejects an ambiguous run prefix before RPC",
    ambiguousRun.code === 1 &&
      /run prefix.*ambiguous/i.test(ambiguousRun.stderr) &&
      requests.length === requestCount,
    ambiguousRun.stderr,
  );

  const messaged = await runCli([
    "agent",
    "message",
    "run-agent-contract",
    "task-beta",
    "Please",
    "verify",
    "the",
    "boundary",
    "--subject",
    "Contract",
    "--json",
  ]);
  check("message exits successfully", messaged.code === 0, messaged.stderr);
  const messageRequest = requests.at(-1);
  check(
    "message resolves the recipient and preserves joined text",
    messageRequest?.method === "orchestrator.message_workers" &&
      messageRequest.params.runId === RUN_ID &&
      messageRequest.params.to === TASK_BETA &&
      messageRequest.params.subject === "Contract" &&
      messageRequest.params.body === "Please verify the boundary",
    JSON.stringify(messageRequest),
  );
  check("message JSON output is machine-readable", JSON.parse(messaged.stdout).ok === true);

  const broadcast = await runCli([
    "agent",
    "message",
    RUN_ID,
    "all",
    "Shared",
    "contract",
  ]);
  check("broadcast exits successfully", broadcast.code === 0, broadcast.stderr);
  check(
    "message preserves the server's all-recipient",
    requests.at(-1)?.params?.to === "all",
    JSON.stringify(requests.at(-1)),
  );
  check("message has sensible human output", /sent\s+message-agent-cli-1\s+to all/.test(broadcast.stdout));

  const waited = await runCli([
    "agent",
    "wait",
    "run-agent-contract",
    "task-alpha-one",
    "task-beta",
    "--mode",
    "any",
    "--timeout",
    "1.25",
    "--json",
  ]);
  check("wait exits successfully", waited.code === 0, waited.stderr);
  const waitRequest = requests.at(-1);
  check(
    "wait resolves every task prefix and maps timeout seconds to milliseconds",
    waitRequest?.method === "orchestrator.wait_for_workers" &&
      waitRequest.params.runId === RUN_ID &&
      JSON.stringify(waitRequest.params.worker_task_ids) === JSON.stringify([TASK_ONE, TASK_BETA]) &&
      waitRequest.params.mode === "any" &&
      waitRequest.params.timeout_ms === 1250,
    JSON.stringify(waitRequest),
  );
  check("wait JSON output is machine-readable", JSON.parse(waited.stdout).reason === "any_terminal");

  const humanWait = await runCli([
    "agent",
    "wait",
    RUN_ID,
    TASK_BETA,
    "--timeout",
    "1",
  ]);
  check("wait has sensible human output", humanWait.code === 0 && /all_terminal/.test(humanWait.stdout), humanWait.stderr);
  check("wait human output includes the report summary", humanWait.stdout.includes(`Completed ${TASK_BETA}`));

  requestCount = requests.length;
  const duplicateWait = await runCli([
    "agent",
    "wait",
    RUN_ID,
    "task-beta",
    TASK_BETA,
  ]);
  check(
    "wait rejects duplicate resolved tasks before RPC",
    duplicateWait.code === 1 &&
      /duplicate tasks/i.test(duplicateWait.stderr) &&
      requests.length === requestCount,
    duplicateWait.stderr,
  );
  const badMode = await runCli([
    "agent",
    "wait",
    RUN_ID,
    TASK_BETA,
    "--mode",
    "first",
  ]);
  check(
    "wait rejects an invalid mode before RPC",
    badMode.code === 1 &&
      /invalid --mode/i.test(badMode.stderr) &&
      requests.length === requestCount,
    badMode.stderr,
  );
  const badTimeout = await runCli([
    "agent",
    "wait",
    RUN_ID,
    TASK_BETA,
    "--timeout",
    "1201",
  ]);
  check(
    "wait rejects a timeout beyond the socket cap before RPC",
    badTimeout.code === 1 &&
      /invalid --timeout/i.test(badTimeout.stderr) &&
      requests.length === requestCount,
    badTimeout.stderr,
  );

  server.close();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} cora agent CLI check(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll cora agent CLI checks PASSED.");
}

main().catch((error) => {
  server.close();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
