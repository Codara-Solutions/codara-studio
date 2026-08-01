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
const TOKEN = "a".repeat(64);
const ACCOUNT_PROFILE_ID = "20000000-0000-4000-8000-000000000001";
const RECOVERY_ID = "recovery-cli-contract-1234567890";
fs.mkdirSync(WORKSPACE, { recursive: true });

// Native CLI account fixtures. They mirror the on-disk layout Studio writes:
// <home>/<runtime>-cli/account-profiles.json plus one state directory per
// account under <home>/<runtime>-cli/accounts/<uuid>.
const CLAUDE_ACCOUNT_ID = "30000000-0000-4000-8000-000000000001";
const CLAUDE_TWIN_A_ID = "30000000-0000-4000-8000-000000000002";
const CLAUDE_TWIN_B_ID = "30000000-0000-4000-8000-000000000003";
const CODEX_ACCOUNT_ID = "40000000-0000-4000-8000-000000000001";
const EMPTY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-cli-empty-"));

function writeAccountStore(runtimeDir, profiles, defaultProfileId) {
  const root = path.join(TEST_HOME, runtimeDir);
  fs.mkdirSync(path.join(root, "accounts"), { recursive: true });
  for (const profile of profiles) {
    fs.mkdirSync(path.join(root, "accounts", profile.id), { recursive: true });
  }
  fs.writeFileSync(
    path.join(root, "account-profiles.json"),
    JSON.stringify({
      version: 1,
      profiles: profiles.map((profile) => ({
        ...profile,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
      defaultProfileId,
    }),
  );
  return root;
}

const claudeStoreRoot = writeAccountStore(
  "claude-cli",
  [
    { id: CLAUDE_ACCOUNT_ID, label: "Work" },
    { id: CLAUDE_TWIN_A_ID, label: "Twin" },
    { id: CLAUDE_TWIN_B_ID, label: "Twin" },
  ],
  CLAUDE_ACCOUNT_ID,
);
const codexStoreRoot = writeAccountStore(
  "codex-cli",
  [{ id: CODEX_ACCOUNT_ID, label: "Side project" }],
  "personal",
);
// Credential material the CLI must never open: unreadable on purpose, so any
// read attempt would fail loudly instead of passing silently.
const CODEX_AUTH_FILE = path.join(codexStoreRoot, "accounts", CODEX_ACCOUNT_ID, "auth.json");
const CLAUDE_CREDENTIALS_FILE = path.join(
  claudeStoreRoot,
  "accounts",
  CLAUDE_ACCOUNT_ID,
  ".credentials.json",
);
fs.writeFileSync(CODEX_AUTH_FILE, '{"tokens":"secret"}');
fs.writeFileSync(CLAUDE_CREDENTIALS_FILE, '{"tokens":"secret"}');
if (process.platform !== "win32") {
  fs.chmodSync(CODEX_AUTH_FILE, 0o000);
  fs.chmodSync(CLAUDE_CREDENTIALS_FILE, 0o000);
}


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
  resumeResult: null,
  dropResumeReplyOnce: false,
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
    } else if (parsed.method === "accounts.list") {
      result = {
        accounts: [
          {
            id: ACCOUNT_PROFILE_ID,
            provider: "anthropic",
            label: "Claude work",
            status: "configured",
            isDefault: true,
            remainingPercent: 42,
          },
        ],
      };
    } else if (parsed.method === "chat.resume") {
      if (state.dropResumeReplyOnce) {
        state.dropResumeReplyOnce = false;
        state.resumeResult = {
          runId: run.id,
          recoveryId: RECOVERY_ID,
          outcome: "already-resuming",
        };
        req.socket.destroy();
        return;
      }
      result = state.resumeResult ?? {
        runId: run.id,
        recoveryId: RECOVERY_ID,
        outcome: "accepted",
      };
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

function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "bin", "cora.cjs"), ...args], {
      cwd: WORKSPACE,
      env: {
        ...process.env,
        CODARA_HOME_DIR: options.home ?? TEST_HOME,
        ...(options.env ?? {}),
      },
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
    "pi",
    "--model",
    "gpt-test",
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
  check(
    "start defaults cwd to the invoking directory",
    fs.realpathSync(create?.params?.cwd ?? "/") === fs.realpathSync(WORKSPACE),
    create?.params?.cwd,
  );
  check("start joins positional prompt words", create?.params?.prompt === "Build the fixture", create?.params?.prompt);
  check(
    "start forwards backend/model/effort without a mode or account pin",
    create?.params?.backend === "pi" &&
      create?.params?.model === "gpt-test" &&
      create?.params?.effort === "high" &&
      create?.params?.accountProfileId === undefined &&
      create?.params?.mode === undefined,
    JSON.stringify(create?.params),
  );
  const firstWait = requests.find((request) => request.method === "chat.wait");
  check("start --wait follows the created run", firstWait?.params?.runId === run.id);
  check("timeout seconds are converted to milliseconds", firstWait?.params?.timeoutMs === 0);
  check("--json prints the terminal wait result", JSON.parse(started.stdout).run.status === "complete");

  requests.length = 0;
  const unsupportedMode = await runCli(["start", "No RPC", "--mode", "execute"]);
  check(
    "start rejects the unsupported --mode flag before RPC",
    unsupportedMode.code === 1 &&
      /unsupported flag.*--mode/i.test(unsupportedMode.stderr) &&
      requests.length === 0,
    `${unsupportedMode.stderr} requests=${JSON.stringify(requests)}`,
  );
  const unknownStartFlag = await runCli(["start", "No RPC", "--mystery", "value"]);
  check(
    "start rejects unknown flags before RPC",
    unknownStartFlag.code === 1 &&
      /unsupported flag.*--mystery/i.test(unknownStartFlag.stderr) &&
      requests.length === 0,
    `${unknownStartFlag.stderr} requests=${JSON.stringify(requests)}`,
  );
  const removedAccountFlag = await runCli([
    "start",
    "No RPC",
    "--account-profile",
    ACCOUNT_PROFILE_ID,
  ]);
  check(
    "start no longer accepts the retired --account-profile flag",
    removedAccountFlag.code === 1 &&
      /unsupported flag.*--account-profile/i.test(removedAccountFlag.stderr) &&
      requests.length === 0,
    `${removedAccountFlag.stderr} requests=${JSON.stringify(requests)}`,
  );

  const accounts = await runCli(["accounts", "--json"]);
  check("accounts exits successfully", accounts.code === 0, accounts.stderr);
  check(
    "accounts prints the sanitized socket contract",
    JSON.parse(accounts.stdout).accounts?.[0]?.id === ACCOUNT_PROFILE_ID &&
      JSON.parse(accounts.stdout).accounts?.[0]?.remainingPercent === 42,
    accounts.stdout,
  );
  const accountsPlain = await runCli(["accounts"]);
  check(
    "accounts labels the provider's active account with the Settings wording",
    accountsPlain.code === 0 &&
      accountsPlain.stdout.includes("  (active)") &&
      !accountsPlain.stdout.includes("(default)"),
    accountsPlain.stderr || accountsPlain.stdout,
  );
  requests.length = 0;
  const unknownAccountsFlag = await runCli(["accounts", "--mystery"]);
  check(
    "accounts rejects unknown flags before RPC",
    unknownAccountsFlag.code === 1 &&
      /unsupported flag.*--mystery/i.test(unknownAccountsFlag.stderr) &&
      requests.length === 0,
    `${unknownAccountsFlag.stderr} requests=${JSON.stringify(requests)}`,
  );
  requests.length = 0;
  state.resumeResult = null;
  const resumed = await runCli(["resume", "run-cli", "--json"]);
  const resumedJson = JSON.parse(resumed.stdout);
  check(
    "resume accepts the current account through one typed recovery RPC",
    resumed.code === 0 &&
      requests.length === 1 &&
      requests[0]?.method === "chat.resume" &&
      requests[0]?.params?.runId === "run-cli" &&
      requests[0]?.params?.profileId === undefined &&
      resumedJson.runId === run.id &&
      resumedJson.recoveryId === RECOVERY_ID &&
      resumedJson.outcome === "accepted",
    `${resumed.stderr} ${JSON.stringify(requests)}`,
  );

  requests.length = 0;
  const rotated = await runCli([
    "resume",
    "run-cli",
    ACCOUNT_PROFILE_ID,
    "--json",
  ]);
  check(
    "resume passes an account switch inside the same atomic recovery call",
    rotated.code === 0 &&
      requests.length === 1 &&
      requests[0]?.method === "chat.resume" &&
      requests[0]?.params?.profileId === ACCOUNT_PROFILE_ID &&
      !requests.some((request) => request.method === "accounts.select"),
    `${rotated.stderr} ${JSON.stringify(requests)}`,
  );

  requests.length = 0;
  state.resumeResult = {
    runId: run.id,
    recoveryId: RECOVERY_ID,
    outcome: "already-resuming",
  };
  const idempotent = await runCli(["resume", "run-cli", "--json"]);
  check(
    "already-resuming is a successful idempotent outcome",
    idempotent.code === 0 && JSON.parse(idempotent.stdout).outcome === "already-resuming",
    idempotent.stderr || idempotent.stdout,
  );

  requests.length = 0;
  state.resumeResult = {
    runId: run.id,
    recoveryId: null,
    outcome: "stale",
    reason: "No current parked Cora manager turn is available to resume.",
  };
  const staleResume = await runCli(["resume", "run-cli", "--wait", "--json"]);
  check(
    "an unsuccessful recovery is explicit, nonzero, and never waits",
    staleResume.code === 1 &&
      JSON.parse(staleResume.stdout).outcome === "stale" &&
      /not resumed/i.test(staleResume.stderr) &&
      requests.length === 1 &&
      requests[0]?.method === "chat.resume",
    `${staleResume.stderr} ${JSON.stringify(requests)}`,
  );

  requests.length = 0;
  const malformedResume = await runCli(["resume", "run-cli", "../../auth.json"]);
  check(
    "resume rejects a malformed profile before RPC",
    malformedResume.code === 1 &&
      /lowercase UUIDv4/i.test(malformedResume.stderr) &&
      requests.length === 0,
    `${malformedResume.stderr} requests=${JSON.stringify(requests)}`,
  );

  requests.length = 0;
  state.resumeResult = null;
  state.dropResumeReplyOnce = true;
  const lostReply = await runCli(["resume", "run-cli", "--json"]);
  check(
    "a lost accepted reply retries the identical claim and succeeds idempotently",
    lostReply.code === 0 &&
      JSON.parse(lostReply.stdout).outcome === "already-resuming" &&
      requests.length === 2 &&
      requests.every((request) =>
        request.method === "chat.resume" &&
        request.params?.runId === "run-cli" &&
        request.params?.profileId === undefined
      ),
    `${lostReply.stderr} ${JSON.stringify(requests)}`,
  );

  requests.length = 0;
  state.resumeResult = null;
  const waitedResume = await runCli([
    "resume",
    "run-cli",
    "--wait",
    "--timeout",
    "0",
    "--json",
  ]);
  const waitedResumeJson = JSON.parse(waitedResume.stdout);
  check(
    "resume --wait follows only an accepted canonical run id",
    waitedResume.code === 0 &&
      requests[0]?.method === "chat.resume" &&
      requests[1]?.method === "chat.wait" &&
      requests[1]?.params?.runId === run.id &&
      requests[1]?.params?.timeoutMs === 0 &&
      waitedResumeJson.resume?.outcome === "accepted" &&
      waitedResumeJson.wait?.run?.id === run.id,
    `${waitedResume.stderr} ${JSON.stringify(requests)}`,
  );
  state.resumeResult = null;

  requests.length = 0;
  state.sendResult = {
    run: {
      ...run,
      status: "paused",
      managerTurnRecovery: {
        id: RECOVERY_ID,
        state: "parked",
        failureKind: "provider",
      },
    },
  };
  const parkedProvider = await runCli(["send", "run-cli", "Continue"]);
  check(
    "paused provider capacity prints truthful resume and account-switch guidance",
    parkedProvider.code === 0 &&
      /temporarily unavailable or at capacity/i.test(parkedProvider.stdout) &&
      /retry shortly or switch accounts/i.test(parkedProvider.stdout) &&
      /cora resume .*\[profileId\] --wait/i.test(parkedProvider.stdout) &&
      !/subscription sign-in|log ?in|reconnect/i.test(parkedProvider.stdout) &&
      !/continue\s+cora send/i.test(parkedProvider.stdout),
    parkedProvider.stdout || parkedProvider.stderr,
  );
  state.sendResult = null;

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

  // agents is a bounded offline projection of current WorkerTask/WorkerAttempt
  // state. Deliberately seed sensitive and path-bearing fields to prove the
  // public JSON contract cannot serialize them by accident.
  const activeAgentRunId = "run-agent-active-1";
  const activeAgentDir = path.join(TEST_HOME, "runs", activeAgentRunId);
  fs.mkdirSync(activeAgentDir, { recursive: true });
  fs.writeFileSync(
    path.join(activeAgentDir, "run.json"),
    JSON.stringify({
      id: activeAgentRunId,
      status: "running",
      title: "Never print SECRET_RUN_TITLE /private/project",
      updatedAt: "2026-07-24T11:00:00Z",
      settingsSnapshot: { workspaceCwd: "/private/project" },
      workerTasks: [
        {
          id: "task-agent-active-1",
          title: "Never print SECRET_TASK_TITLE",
          description: "Never print SECRET_PROMPT",
          taskClass: "verifier",
          runtimePreference: "codex",
          status: "running",
        },
      ],
      workerAttempts: [
        {
          id: "attempt-agent-active-1",
          workerTaskId: "task-agent-active-1",
          attemptNumber: 2,
          runtime: "codex",
          model: "SECRET_MODEL",
          status: "running",
          runtimeState: "working",
          cwd: "/private/project",
          promptPath: "/private/SECRET_PROMPT.md",
          command: "codex --token SECRET_CREDENTIAL",
          accountProfileId: ACCOUNT_PROFILE_ID,
          error: "SECRET_ERROR",
        },
      ],
    }),
  );
  const terminalAgentRunId = "run-agent-terminal-1";
  const terminalAgentDir = path.join(TEST_HOME, "runs", terminalAgentRunId);
  fs.mkdirSync(terminalAgentDir, { recursive: true });
  fs.writeFileSync(
    path.join(terminalAgentDir, "run.json"),
    JSON.stringify({
      id: terminalAgentRunId,
      status: "complete",
      updatedAt: "2026-07-24T10:30:00Z",
      workerTasks: [
        {
          id: "task-agent-terminal-1",
          taskClass: "feature",
          runtimePreference: "claude",
          status: "accepted",
        },
      ],
      workerAttempts: [
        {
          id: "attempt-agent-terminal-1",
          workerTaskId: "task-agent-terminal-1",
          attemptNumber: 1,
          runtime: "claude",
          status: "succeeded",
          runtimeState: "done",
          cwd: "/private/terminal",
        },
      ],
    }),
  );

  requests.length = 0;
  const activeAgentsResult = await runCli(["agents", "--json"]);
  check(
    "agents reads active workers without touching the app socket",
    activeAgentsResult.code === 0 && requests.length === 0,
    `${activeAgentsResult.stderr} requests=${JSON.stringify(requests)}`,
  );
  const activeAgents = JSON.parse(activeAgentsResult.stdout);
  check(
    "agents emits the stable sanitized JSON contract",
    activeAgents.schemaVersion === 1 &&
      activeAgents.scope === "active" &&
      activeAgents.truncated === false &&
      activeAgents.agents?.length === 1 &&
      activeAgents.agents[0]?.runId === activeAgentRunId &&
      activeAgents.agents[0]?.taskId === "task-agent-active-1" &&
      activeAgents.agents[0]?.role === "verifier" &&
      activeAgents.agents[0]?.runtime === "codex" &&
      activeAgents.agents[0]?.taskStatus === "running" &&
      activeAgents.agents[0]?.attemptNumber === 2 &&
      activeAgents.agents[0]?.attemptStatus === "running" &&
      activeAgents.agents[0]?.runtimeState === "working",
    activeAgentRunId,
  );
  check(
    "agents never prints prompts, credentials, models, account ids, errors, titles, or paths",
    !/SECRET_|\/private\/|accountProfile|promptPath|command|cwd|title/i.test(activeAgentsResult.stdout) &&
      !activeAgentsResult.stdout.includes(ACCOUNT_PROFILE_ID),
    activeAgentsResult.stdout,
  );
  const activeAgentsPretty = await runCli(["agents"]);
  check(
    "agents human output is concise and sanitized",
    activeAgentsPretty.code === 0 &&
      activeAgentsPretty.stdout.includes("task-agent-active-1") &&
      activeAgentsPretty.stdout.includes("verifier") &&
      activeAgentsPretty.stdout.includes("running/running/working") &&
      !/SECRET_|\/private\//.test(activeAgentsPretty.stdout),
    activeAgentsPretty.stderr || activeAgentsPretty.stdout,
  );

  const selectedAgentsResult = await runCli(["agents", "run-agent-terminal", "--json"]);
  const selectedAgents = JSON.parse(selectedAgentsResult.stdout);
  check(
    "agents run prefix includes the selected run's terminal current attempt",
    selectedAgentsResult.code === 0 &&
      selectedAgents.scope === "run" &&
      selectedAgents.runId === terminalAgentRunId &&
      selectedAgents.agents?.[0]?.taskStatus === "accepted" &&
      selectedAgents.agents?.[0]?.attemptStatus === "succeeded",
    selectedAgentsResult.stderr || selectedAgentsResult.stdout,
  );

  requests.length = 0;
  const unknownAgentsFlag = await runCli(["agents", "--mystery"]);
  check(
    "agents rejects unknown flags before any RPC",
    unknownAgentsFlag.code === 1 &&
      /unsupported flag.*--mystery/i.test(unknownAgentsFlag.stderr) &&
      requests.length === 0,
    `${unknownAgentsFlag.stderr} requests=${JSON.stringify(requests)}`,
  );

  const boundedAgentRunId = "run-agent-bounded-1";
  const boundedAgentDir = path.join(TEST_HOME, "runs", boundedAgentRunId);
  fs.mkdirSync(boundedAgentDir, { recursive: true });
  fs.writeFileSync(
    path.join(boundedAgentDir, "run.json"),
    JSON.stringify({
      id: boundedAgentRunId,
      status: "running",
      workerTasks: Array.from({ length: 260 }, (_, index) => ({
        id: `task-bounded-${String(index).padStart(3, "0")}`,
        taskClass: "feature",
        runtimePreference: "codex",
        status: "queued",
      })),
      workerAttempts: [],
    }),
  );
  const boundedAgentsResult = await runCli(["agents", boundedAgentRunId, "--json"]);
  const boundedAgents = JSON.parse(boundedAgentsResult.stdout);
  check(
    "agents enforces a deterministic row bound",
    boundedAgentsResult.code === 0 &&
      boundedAgents.agents?.length === 250 &&
      boundedAgents.truncated === true,
    boundedAgentsResult.stderr || boundedAgentsResult.stdout,
  );

  // The handshake holds a bearer token. The CLI must never follow a tampered
  // file to a non-loopback host or accept a weak/malformed token.
  fs.writeFileSync(
    path.join(TEST_HOME, "agent-socket.json"),
    JSON.stringify({ url: `http://example.com:${address.port}`, token: TOKEN }),
  );
  const hostileHost = await runCli(["status"]);
  check(
    "handshake rejects non-loopback hosts",
    hostileHost.code === 1 && /unsafe or malformed handshake/i.test(hostileHost.stderr),
    hostileHost.stderr,
  );

  fs.writeFileSync(
    path.join(TEST_HOME, "agent-socket.json"),
    JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token: "short" }),
  );
  const weakToken = await runCli(["status"]);
  check(
    "handshake rejects weak bearer tokens",
    weakToken.code === 1 && /unsafe or malformed handshake/i.test(weakToken.stderr),
    weakToken.stderr,
  );

  fs.writeFileSync(path.join(TEST_HOME, "agent-socket.json"), "{broken");
  const malformedJson = await runCli(["status"]);
  check(
    "malformed handshake JSON fails cleanly",
    malformedJson.code === 1 && /malformed handshake/i.test(malformedJson.stderr),
    malformedJson.stderr,
  );

  // ── terminal CLI accounts ──
  requests.length = 0;
  const cliAccounts = await runCli(["accounts", "cli", "--json"]);
  const cliAccountRows = JSON.parse(cliAccounts.stdout || "{}").accounts ?? [];
  check(
    "accounts cli lists both runtimes straight from disk, with no RPC",
    cliAccounts.code === 0 && requests.length === 0 && cliAccountRows.length === 6,
    `${cliAccounts.stderr}${cliAccounts.stdout}`,
  );
  check(
    "accounts cli reports label, id, runtime and which account is Active",
    cliAccountRows.some(
      (row) =>
        row.runtime === "claude" &&
        row.id === CLAUDE_ACCOUNT_ID &&
        row.label === "Work" &&
        row.isActive === true,
    ) &&
      cliAccountRows.some(
        (row) =>
          row.runtime === "codex" &&
          row.id === CODEX_ACCOUNT_ID &&
          row.label === "Side project" &&
          row.isActive === false,
      ),
    cliAccounts.stdout,
  );
  check(
    "accounts cli reads Codex sign-in from auth.json presence without opening it",
    cliAccountRows.find((row) => row.id === CODEX_ACCOUNT_ID)?.signedIn === true &&
      cliAccountRows.find((row) => row.id === CLAUDE_ACCOUNT_ID)?.signedIn === null,
    cliAccounts.stdout,
  );
  check(
    "every runtime gets a personal row that cannot be mistaken for a managed one",
    cliAccountRows.filter((row) => row.id === "personal").length === 2 &&
      cliAccountRows.find(
        (row) => row.runtime === "codex" && row.id === "personal",
      )?.isActive === true,
    cliAccounts.stdout,
  );
  const cliAccountsPlain = await runCli(["accounts", "claude"]);
  check(
    "accounts <runtime> marks the Active account and points at Settings",
    cliAccountsPlain.code === 0 &&
      cliAccountsPlain.stdout.includes("Work") &&
      !cliAccountsPlain.stdout.includes("Side project") &&
      /→ marks the Active account/.test(cliAccountsPlain.stdout) &&
      /Settings → Accounts/.test(cliAccountsPlain.stdout),
    cliAccountsPlain.stderr || cliAccountsPlain.stdout,
  );
  const cliAccountsEmpty = await runCli(["accounts", "cli"], { home: EMPTY_HOME });
  check(
    "accounts cli says so and points at Settings when nothing is set up",
    cliAccountsEmpty.code === 0 &&
      /no accounts added yet/.test(cliAccountsEmpty.stdout) &&
      /Settings → Accounts → Add account/.test(cliAccountsEmpty.stdout),
    cliAccountsEmpty.stderr || cliAccountsEmpty.stdout,
  );
  const cliAccountsBadScope = await runCli(["accounts", "pi"]);
  check(
    "accounts rejects an unknown listing scope",
    cliAccountsBadScope.code === 1 &&
      /usage: cora accounts \[cli\|claude\|codex\]/.test(cliAccountsBadScope.stderr),
    cliAccountsBadScope.stderr,
  );


  const cliSource = fs.readFileSync(path.join(ROOT, "bin", "cora.cjs"), "utf8");
  check(
    "the CLI never reads a file inside an account directory",
    !/read(?:File|FileSync)\s*\([^)]*(?:stateDir|accountsDir|authFile|signedInMarker)/.test(
      cliSource,
    ) && !/readFileSync\([^)]*auth/i.test(cliSource),
    "bin/cora.cjs reads inside a managed account directory",
  );
  check(
    "account state is inspected by stat only, and the store is never written",
    /fs\.lstatSync\(target\)/.test(cliSource) &&
      !/writeFileSync\([^)]*(?:listFile|stateDir|accountsDir)/.test(cliSource) &&
      !/(?:mkdirSync|rmSync|unlinkSync)\([^)]*(?:stateDir|accountsDir|rootDir)/.test(cliSource),
    "bin/cora.cjs mutates the native CLI account store",
  );

  const help = await runCli(["help"]);
  check(
    "help documents accounts and agent overview without per-chat account switching",
    help.code === 0 &&
      help.stdout.includes("CORA SESSIONS") &&
      /accounts\s+list sanitized Cora subscription accounts/.test(help.stdout) &&
      /agents \[id\]\s+current worker-agent overview/.test(help.stdout) &&
      help.stdout.includes("works offline") &&
      !help.stdout.includes("--account-profile") &&
      !/^\s*account <runId>/m.test(help.stdout) &&
      !/(?:^|\s)--mode(?:[=\s]|$)/m.test(help.stdout),
    help.stderr || help.stdout,
  );
  check(
    "help documents the read-only account listing and no launcher commands",
    help.code === 0 &&
      /accounts cli\s+list your Claude Code and Codex accounts/.test(help.stdout) &&
      /which one is Active/.test(help.stdout) &&
      !/^\s*claude \[/m.test(help.stdout) &&
      !/^\s*codex\s+\[/m.test(help.stdout) &&
      !help.stdout.includes("--account "),
    help.stderr || help.stdout,
  );

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
    if (process.platform !== "win32") {
      for (const file of [CODEX_AUTH_FILE, CLAUDE_CREDENTIALS_FILE]) {
        try {
          fs.chmodSync(file, 0o600);
        } catch {
          /* already gone */
        }
      }
    }
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.rmSync(EMPTY_HOME, { recursive: true, force: true });
  });
