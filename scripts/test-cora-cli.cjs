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

// Per-scenario overrides: eventBatches is a queue drained one response per
// chat.events call; waitResult/sendResult replace the default canned replies.
const state = {
  eventBatches: [],
  waitResult: null,
  sendResult: null,
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
      result = state.sendResult ?? {
        run: { ...run, humanMessages: [{ author: "user", message: parsed.params.content }] },
      };
    } else if (parsed.method === "chat.wait") {
      result = state.waitResult ?? { run: { ...run, status: "complete" }, timedOut: false, needsAttention: false };
    } else if (parsed.method === "chat.events") {
      result = state.eventBatches.length
        ? state.eventBatches.shift()
        : { runId: run.id, cursor: 0, events: [], status: "complete" };
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

  // tail: bootstrap → cursor-advancing long-polls → footer from a zero wait.
  requests.length = 0;
  state.eventBatches = [
    { runId: run.id, cursor: 3, events: [], status: "running" },
    {
      runId: run.id,
      cursor: 5,
      events: [
        { id: "e4", sequence: 4, type: "chat.assistant_block", payload: { messageId: "m1", text: "Working on it." } },
        { id: "e5", sequence: 5, type: "chat.tool_use", payload: { toolName: "read_file", input: { path: "src/app.ts" } } },
      ],
      status: "running",
    },
    {
      runId: run.id,
      cursor: 6,
      events: [{ id: "e6", sequence: 6, type: "worker_attempt.running", message: "Worker attempt 1 running" }],
      status: "complete",
    },
  ];
  const tailed = await runCli(["tail", "run-cli"]);
  check("tail exits successfully", tailed.code === 0, tailed.stderr);
  const eventCalls = requests.filter((request) => request.method === "chat.events");
  check(
    "tail bootstraps without a cursor",
    eventCalls[0] && eventCalls[0].params.afterSequence === undefined,
    JSON.stringify(eventCalls[0]?.params),
  );
  check(
    "tail advances the cursor across polls",
    eventCalls[1]?.params?.afterSequence === 3 && eventCalls[2]?.params?.afterSequence === 5,
    JSON.stringify(eventCalls.map((request) => request.params?.afterSequence)),
  );
  check("tail streams assistant text", tailed.stdout.includes("Working on it."));
  check("tail prints quiet tool lines", tailed.stdout.includes("read_file"));
  check("tail prints worker status lines", tailed.stdout.includes("Worker attempt 1 running"));
  check(
    "tail fetches the final snapshot with a zero wait",
    requests.some((request) => request.method === "chat.wait" && request.params.timeoutMs === 0),
  );
  check("tail prints the final status footer", tailed.stdout.includes(`${run.id}  complete`));

  // wait consumes the same stream in pretty mode.
  requests.length = 0;
  state.eventBatches = [
    { runId: run.id, cursor: 9, events: [], status: "running" },
    {
      runId: run.id,
      cursor: 10,
      events: [{ id: "e10", sequence: 10, type: "chat.assistant_block", payload: { messageId: "m9", text: "All wrapped up." } }],
      status: "complete",
    },
  ];
  const streamedWait = await runCli(["wait", "run-cli"]);
  check("wait exits successfully", streamedWait.code === 0, streamedWait.stderr);
  check("wait consumes the event stream", requests.some((request) => request.method === "chat.events"));
  check("wait streams assistant text before the footer", streamedWait.stdout.includes("All wrapped up."));

  // Truncated replay: the server caps chat.events batches at 500 and flags
  // the overflow with hasMore. A terminal status on a truncated batch must
  // not stop the tail — the client keeps draining until a batch comes back
  // non-truncated.
  requests.length = 0;
  const backlog = Array.from({ length: 500 }, (_, index) => ({
    id: `t${index + 1}`,
    sequence: index + 1,
    type: "worker_attempt.running",
    message: `Backlog event ${index + 1}`,
  }));
  state.eventBatches = [
    { runId: run.id, cursor: 0, events: [], status: "running" },
    { runId: run.id, cursor: 500, events: backlog, hasMore: true, status: "complete" },
    {
      runId: run.id,
      cursor: 501,
      events: [
        { id: "t501", sequence: 501, type: "chat.assistant_block", payload: { messageId: "mt", text: "Tail end reached." } },
      ],
      hasMore: false,
      status: "complete",
    },
  ];
  const truncatedTail = await runCli(["tail", "run-cli"]);
  check("truncated tail exits successfully", truncatedTail.code === 0, truncatedTail.stderr);
  const truncatedCalls = requests.filter((request) => request.method === "chat.events");
  check(
    "truncated batch keeps polling despite the terminal status",
    truncatedCalls.length === 3 && truncatedCalls[2]?.params?.afterSequence === 500,
    JSON.stringify(truncatedCalls.map((request) => request.params?.afterSequence)),
  );
  check("truncated tail renders the capped batch", truncatedTail.stdout.includes("Backlog event 500"));
  check("truncated tail renders the drained remainder", truncatedTail.stdout.includes("Tail end reached."));

  // A blocked run's option-set question renders numbered, and a bare number answers by index.
  const questionRun = {
    ...run,
    status: "blocked",
    blockedOn: { questionMessageId: "q1" },
    humanMessages: [
      {
        id: "q1",
        author: "spark",
        kind: "question",
        message: "Which database should this use?",
        questionOptions: [
          { id: "opt-a", label: "Postgres", description: "Managed instance", answer: "Use Postgres" },
          { id: "opt-b", label: "SQLite", description: "Local file", answer: "Use SQLite" },
        ],
      },
    ],
  };
  requests.length = 0;
  state.waitResult = { run: questionRun, timedOut: true, needsAttention: true };
  const numbered = await runCli(["send", "run-cli", "2", "--json"]);
  check("numbered send exits successfully", numbered.code === 0, numbered.stderr);
  check(
    "numbered send probes the run with a zero wait",
    requests[0]?.method === "chat.wait" && requests[0]?.params?.timeoutMs === 0,
    JSON.stringify(requests[0]),
  );
  check(
    "numbered send resolves option 2 to its canned answer",
    requests[1]?.method === "chat.send" && requests[1]?.params?.content === "Use SQLite",
    JSON.stringify(requests[1]),
  );
  state.waitResult = null;

  state.sendResult = { run: questionRun };
  const blockedOut = await runCli(["send", "run-cli", "Reply", "please"]);
  check("blocked session prints the question", blockedOut.stdout.includes("Which database should this use?"));
  check(
    "blocked session numbers the options",
    blockedOut.stdout.includes("1. Postgres") && blockedOut.stdout.includes("2. SQLite"),
    blockedOut.stdout,
  );
  check("blocked session suggests a numbered answer", blockedOut.stdout.includes(`cora send ${run.id}`));
  state.sendResult = null;

  // log reads run.json from disk — no server involved.
  const logRunId = "run-log-fixture-1";
  const logDir = path.join(TEST_HOME, "runs", logRunId);
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, "run.json"),
    JSON.stringify({
      id: logRunId,
      status: "complete",
      title: "Log fixture",
      updatedAt: "2026-07-24T10:00:00Z",
      humanMessages: [
        { id: "m1", author: "user", message: "Ship the feature", createdAt: "2026-07-24T09:00:00Z" },
        {
          id: "m2",
          author: "spark",
          message: "Done. Two files changed.",
          createdAt: "2026-07-24T09:05:00Z",
          questionOptions: [{ id: "o1", label: "Looks good" }],
        },
      ],
    }),
  );
  const logged = await runCli(["log", "run-log"]);
  check("log resolves an id prefix offline", logged.code === 0, logged.stderr);
  check(
    "log prints the full transcript",
    logged.stdout.includes("Ship the feature") && logged.stdout.includes("Done. Two files changed."),
    logged.stdout,
  );
  check("log labels authors in sentence case", logged.stdout.includes("you") && logged.stdout.includes("cora"));
  check("log numbers question options", logged.stdout.includes("1. Looks good"));

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
