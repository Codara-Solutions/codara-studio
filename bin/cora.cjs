#!/usr/bin/env node
// cora — talk to the running Codara Studio app from a terminal.
//
// Discovers the app the same way the MCP servers do: read
// $CODARA_HOME_DIR/agent-socket.json (default ~/.Codara) for the loopback URL +
// bearer token, then speak JSON-RPC. Zero dependencies; works against
// a running Codara Studio app (or `npm run dev` for contributors)
// (the app.* commands are dev-gated in packaged builds; preview.* always work).
//
// Install it from Settings → General → Command line. Contributors can also
// run it directly with `node bin/cora.cjs status`.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

// Hidden RUN_AS_NODE mode used only by pty-manager for Studio-created manual
// Claude/Codex startup commands. The constitution and complete parsed child
// argv arrive through the process environment; neither is reconstructed into
// a shell command.
const MANUAL_AGENT_WRAPPER_MODE_ENV = "CODARA_MANUAL_AGENT_WRAPPER";
const MANUAL_AGENT_WRAPPER_ARGV_ENV = "CODARA_MANUAL_AGENT_ARGV";
const MANUAL_AGENT_WRAPPER_CONSTITUTION_ENV =
  "CODARA_MANUAL_AGENT_CONSTITUTION";

async function runManualAgentWrapper() {
  if (process.env.ELECTRON_RUN_AS_NODE !== "1") {
    throw new Error("manual agent wrapper requires Electron RUN_AS_NODE mode");
  }
  const rawArgv = process.env[MANUAL_AGENT_WRAPPER_ARGV_ENV] ?? "";
  const constitution =
    process.env[MANUAL_AGENT_WRAPPER_CONSTITUTION_ENV] ?? "";
  if (
    !rawArgv ||
    rawArgv.length > 16_384 ||
    !constitution ||
    Buffer.byteLength(constitution, "utf8") > 32 * 1024 ||
    constitution.includes("\u0000")
  ) {
    throw new Error("manual agent wrapper received an invalid launch envelope");
  }

  let childArgv;
  try {
    childArgv = JSON.parse(rawArgv);
  } catch {
    throw new Error("manual agent wrapper received invalid child argv");
  }
  if (
    !Array.isArray(childArgv) ||
    childArgv.length < 2 ||
    childArgv.length > 48 ||
    childArgv.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 8_192 ||
        /[\u0000\r\n]/.test(value),
    )
  ) {
    throw new Error("manual agent wrapper received invalid child argv");
  }

  const [program, ...originalArgs] = childArgv;
  let args;
  if (program === "claude") {
    args = [
      ...originalArgs,
      "--append-system-prompt",
      constitution,
    ];
  } else if (program === "codex") {
    args = [
      ...originalArgs,
      "-c",
      `developer_instructions=${JSON.stringify(constitution)}`,
    ];
  } else {
    throw new Error("manual agent wrapper only launches claude or codex");
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env[MANUAL_AGENT_WRAPPER_MODE_ENV];
  delete env[MANUAL_AGENT_WRAPPER_ARGV_ENV];
  delete env[MANUAL_AGENT_WRAPPER_CONSTITUTION_ENV];

  await new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      env,
      stdio: "inherit",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.exitCode =
        typeof code === "number" ? code : signal ? 1 : 0;
      resolve();
    });
  });
}

const HELP = `cora — drive the running Codara Studio app from your terminal

USAGE
  cora <command> [args] [--json]

APP (dev-gated in packaged builds: launch with CODARA_DEV_TOOLS=1)
  status                              is Codara running? version, home dir, windows
  shot [file.png]                     screenshot the app window   (default cora-shot.png)
  eval <js>                           run JS in the app renderer, print the result
  notify [kind] [--title --body --tone --sound --source --run-id]
                [--workspace-id --tab-id --pane-id | --job-id]
                                      fire a notification through the real pipeline
                                      kinds: run.blocked run.complete run.failed
                                             terminal.agent.needs-input terminal.agent.done
                                             terminal.agent.failed automation.finished
                                             automation.failed automation.blocked
  prefs                               print all preferences
  prefs <key>                         print one preference
  prefs <key> <value>                 set one (value parsed as JSON, else string)
  glass                               show liquid-glass tuning (veil/blur/refraction/chroma)
  glass <param> <0-200>               tune it live, e.g. cora glass refraction 140
  glass reset                         all four back to 100

PREVIEW (the in-app browser tab; navigate opens one if none exists)
  open <url>                          navigate the preview tab
  pshot [file.png]                    screenshot the preview tab (default cora-preview.png)
  snapshot                            DOM/text snapshot of the page
  click <selector> | click --at x,y   trusted click
  type <selector> <text>              focus + type
  press <key>                         e.g. Enter, Tab, Meta+A
  peval <js>                          run JS in the previewed page
  scroll <dx> <dy>                    wheel scroll the page
  console [--pattern <re>]            read the page's console messages
  network                             recent network requests
  url                                 current page URL

CORA SESSIONS
  start <prompt> [--cwd DIR] [--title TITLE] [--backend ENGINE]
                 [--model MODEL] [--effort LEVEL] [--wait]
                                      create and run a Cora session; creates the
                                      Codara workspace when DIR is not registered
  accounts                            list sanitized Cora subscription accounts
  resume <runId> [profileId] [--wait] retry the exact parked Cora manager turn;
                 [--timeout SECONDS]  optionally on a specific connected account
  send <runId> <message> [--wait]     continue a session or answer its question
                                      (a bare number picks a numbered option)
  wait <runId> [--timeout SECONDS]    follow live output until it stops or needs you
  tail <runId> [--all]                stream a session as it happens (--all replays
                                      from the start; --timeout SECONDS to bound it)
  cancel <runId> [reason]             stop a session and its active workers

WORKER AGENTS (the running Cora orchestrator; run/task prefixes are accepted)
  agent spawn <run> <brief> --title TITLE
                 [--runtime claude|codex|shell|manual] [--model MODEL]
                 [--effort minimal|low|medium|high|xhigh]
                 [--class skeleton|feature|leaf|verifier]
                 [--complexity trivial|standard|complex]
                 [--allowed-paths JSON] [--forbidden-paths JSON]
                 [--expected-outputs JSON] [--verification-commands JSON]
                                      spawn one typed worker through the run
  agent status <run> <task>           show one worker task's live status
  agent message <run> <task|all> <message> [--subject SUBJECT]
                                      steer one worker or broadcast to the fleet
  agent wait <run> <task>... [--mode all|any] [--timeout SECONDS]
                                      wait for selected worker tasks to settle

RUNS & TERMINALS
  runs                                list runs (reads run.json files; works offline)
  run <id>                            one run's summary (id prefix ok)
  agents [id]                         current worker-agent overview from durable
                                      run.json data (id prefix ok; works offline)
  log <id>                            full transcript of a run (works offline)
  read <paneId> [--lines N]           tail a terminal pane
  say <runId> <message>               append an internal/system note to a run

TERMINAL CLI ACCOUNTS (read-only; add and remove them in Settings → Accounts)
  accounts cli                        list your Claude Code and Codex accounts and
                                      show which one is Active for each CLI
                                      (works offline; reads nothing but the list)
  accounts claude | accounts codex    the same list for one CLI only

ESCAPE HATCH
  rpc <method> [params-json]          raw JSON-RPC, e.g. cora rpc preview.list '{}'

FLAGS
  --json          print the raw JSON-RPC result
  --home <dir>    override the Codara home dir (else $CODARA_HOME_DIR or ~/.Codara)
`;

// ── plumbing ────────────────────────────────────────────────────────────────

function homeDir(flags) {
  return (
    flags.home ||
    process.env.CODARA_HOME_DIR ||
    process.env.SPARK_HOME_DIR ||
    process.env.SPARK_USER_DATA_DIR ||
    path.join(os.homedir(), ".Codara")
  );
}

function readHandshake(flags) {
  const file = path.join(homeDir(flags), "agent-socket.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    fail(
      `Codara isn't running — no handshake at ${file}\n` +
        `Open Codara Studio (contributors can run \`npm run dev\`), or point --home / $CODARA_HOME_DIR at its home dir.`,
    );
  }
  let handshake;
  try {
    handshake = JSON.parse(raw);
  } catch {
    fail(`Malformed handshake file: ${file}`);
  }
  if (!handshake || typeof handshake !== "object") {
    fail(`Malformed handshake file: ${file}`);
  }
  const url = typeof handshake.url === "string" ? handshake.url : "";
  const token = typeof handshake.token === "string" ? handshake.token : "";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(`Malformed handshake file: ${file}`);
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^[a-f0-9]{64}$/i.test(token)
  ) {
    fail(`Unsafe or malformed handshake file: ${file}`);
  }
  return { ...handshake, url: `http://127.0.0.1:${port}`, token };
}

function rpc(flags, method, params, opts = {}) {
  const handshake = readHandshake(flags);
  const target = new URL(handshake.url + "/rpc");
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? {} });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${handshake.token}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`non-JSON response (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
          }
        });
      },
    );
    if (opts.timeoutMs) {
      req.setTimeout(opts.timeoutMs, () => {
        req.destroy(new Error(`${method} got no response after ${Math.round(opts.timeoutMs / 1000)}s`));
      });
    }
    req.on("error", (err) => {
      if (err.code === "ECONNREFUSED") {
        reject(
          new Error(
            `Codara's socket at ${handshake.url} is not answering — stale handshake? Restart the app.`,
          ),
        );
      } else reject(err);
    });
    req.end(payload);
  });
}

async function call(flags, method, params) {
  const res = await rpc(flags, method, params);
  if (res.error) fail(`${method} failed: ${res.error.message}`);
  return res.result;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Transport-level retry: the handshake is re-read on every attempt, so a
// dropped socket or an app restart resumes instead of losing the wait.
// RPC-level errors still fail immediately.
async function callWithRetry(flags, method, params, opts = {}) {
  const retries = opts.retries ?? 3;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(attempt, 5) * 1000);
    try {
      const res = await rpc(flags, method, params, opts);
      if (res.error) fail(`${method} failed: ${res.error.message}`);
      return res.result;
    } catch (err) {
      lastErr = err;
    }
  }
  fail(lastErr?.message ?? String(lastErr));
}

// Mirrors the server's chat.wait default so client deadlines line up.
const DEFAULT_WAIT_MS = 20 * 60_000;
const WAIT_STOP_STATUSES = new Set(["blocked", "paused", "complete", "failed", "cancelled"]);
// Mirrors the server's CHAT_EVENTS_MAX_BATCH: a batch this full may have been
// truncated by an older app build that sends no hasMore flag.
const EVENTS_MAX_BATCH = 500;

function waitCall(flags, params) {
  return callWithRetry(flags, "chat.wait", params, {
    timeoutMs: (params.timeoutMs ?? DEFAULT_WAIT_MS) + 30_000,
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Split argv into positionals + --flags (--key value or --key=value; a flag
// followed by another flag or end-of-args is boolean true).
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[camel(arg.slice(2, eq))] = arg.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[camel(arg.slice(2))] = argv[++i];
    } else {
      flags[camel(arg.slice(2))] = true;
    }
  }
  return { positional, flags };
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // bare strings don't need quoting: cora prefs theme codara-classic
  }
}

function output(flags, result, pretty) {
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  pretty(result);
}

function flagText(flags, key) {
  return typeof flags[key] === "string" && flags[key].trim() ? flags[key].trim() : undefined;
}

function copyTextFlag(flags, target, key) {
  const value = flagText(flags, key);
  if (value !== undefined) target[key] = value;
}

const GLOBAL_FLAGS = new Set(["home", "json"]);
const START_FLAGS = new Set([
  "backend",
  "cwd",
  "effort",
  "model",
  "timeout",
  "title",
  "wait",
  "workspaceName",
]);
const RESUME_FLAGS = new Set(["timeout", "wait"]);
const AGENT_SPAWN_FLAGS = new Set([
  "allowedPaths",
  "class",
  "complexity",
  "effort",
  "expectedOutputs",
  "forbiddenPaths",
  "model",
  "runtime",
  "title",
  "verificationCommands",
]);
const AGENT_MESSAGE_FLAGS = new Set(["subject"]);
const AGENT_WAIT_FLAGS = new Set(["mode", "timeout"]);
const AGENT_SPAWN_RUNTIMES = new Set(["claude", "codex", "shell", "manual"]);
const AGENT_SPAWN_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const AGENT_SPAWN_CLASSES = new Set(["skeleton", "feature", "leaf", "verifier"]);
const AGENT_TASK_COMPLEXITIES = new Set(["trivial", "standard", "complex"]);
const AGENT_WAIT_MODES = new Set(["all", "any"]);
const AGENT_WAIT_DEFAULT_TIMEOUT_MS = 10 * 60_000;
const AGENT_WAIT_MAX_TIMEOUT_MS = 20 * 60_000;
const AGENT_WAIT_TASKS_MAX = 250;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function kebab(s) {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function rejectUnknownFlags(command, flags, allowed) {
  const unknown = Object.keys(flags).find(
    (key) => !GLOBAL_FLAGS.has(key) && !allowed.has(key),
  );
  if (unknown) fail(`unsupported flag for cora ${command}: --${kebab(unknown)}`);
}

function timeoutParams(flags) {
  if (flags.timeout === undefined) return {};
  const seconds = Number(flags.timeout);
  if (!Number.isFinite(seconds) || seconds < 0) {
    fail(`invalid --timeout ${JSON.stringify(flags.timeout)} (expected non-negative seconds)`);
  }
  return { timeoutMs: Math.round(seconds * 1000) };
}

function requireBoundedText(value, label, maxLength, opts = {}) {
  if (typeof value !== "string") fail(`${label} is required`);
  const text = opts.trim === false ? value : value.trim();
  if (!text) fail(`${label} is required`);
  if (text.length > maxLength) {
    fail(`${label} is too long (maximum ${maxLength} characters)`);
  }
  if (text.includes("\u0000")) fail(`${label} contains a NUL character`);
  if (opts.singleLine && /[\r\n]/.test(text)) fail(`${label} must be a single line`);
  return text;
}

function optionalAgentEnumFlag(flags, key, allowed) {
  if (flags[key] === undefined) return undefined;
  const value = flagText(flags, key);
  if (!value || !allowed.has(value)) {
    fail(`invalid --${kebab(key)} ${JSON.stringify(flags[key])} (expected ${[...allowed].join("|")})`);
  }
  return value;
}

function optionalAgentTextFlag(flags, key, maxLength) {
  if (flags[key] === undefined) return undefined;
  return requireBoundedText(
    flagText(flags, key),
    `--${kebab(key)}`,
    maxLength,
    { singleLine: true },
  );
}

function optionalAgentStringArrayFlag(flags, key, opts = {}) {
  if (flags[key] === undefined) return undefined;
  if (typeof flags[key] !== "string") {
    fail(`--${kebab(key)} must be a JSON array of strings`);
  }
  let parsed;
  try {
    parsed = JSON.parse(flags[key]);
  } catch {
    fail(`--${kebab(key)} must be valid JSON`);
  }
  const maxItems = opts.maxItems ?? 64;
  const maxLength = opts.maxLength ?? 2_000;
  if (
    !Array.isArray(parsed) ||
    parsed.length > maxItems ||
    parsed.some(
      (value) =>
        typeof value !== "string" ||
        !value.trim() ||
        value.length > maxLength ||
        value.includes("\u0000"),
    )
  ) {
    fail(
      `--${kebab(key)} must be a JSON array of at most ${maxItems} non-empty strings ` +
        `(maximum ${maxLength} characters each)`,
    );
  }
  return parsed.map((value) => value.trim());
}

function agentWaitTimeoutMs(flags) {
  if (flags.timeout === undefined) return undefined;
  const seconds = Number(flags.timeout);
  const milliseconds = Math.round(seconds * 1000);
  if (
    !Number.isFinite(seconds) ||
    milliseconds < 1 ||
    milliseconds > AGENT_WAIT_MAX_TIMEOUT_MS
  ) {
    fail(
      `invalid --timeout ${JSON.stringify(flags.timeout)} ` +
        `(expected more than 0 and at most ${AGENT_WAIT_MAX_TIMEOUT_MS / 1000} seconds)`,
    );
  }
  return milliseconds;
}

function agentWaitCall(flags, params) {
  return callWithRetry(flags, "orchestrator.wait_for_workers", params, {
    timeoutMs: (params.timeout_ms ?? AGENT_WAIT_DEFAULT_TIMEOUT_MS) + 30_000,
  });
}

// The run's pending question, resolved from blockedOn to the actual question
// message (text + option set), so the CLI can render choices and map a
// numbered answer back to the option's canned reply.
function blockedQuestion(run) {
  const questionMessageId = run?.blockedOn?.questionMessageId;
  if (!questionMessageId) return null;
  const messages = run.humanMessages ?? run.messages ?? [];
  const question = messages.find((message) => message.id === questionMessageId);
  if (!question?.message) return null;
  return { text: String(question.message), options: question.questionOptions ?? [] };
}

function printBlockedQuestion(run) {
  const question = blockedQuestion(run);
  if (!question) return false;
  console.log(`question   ${question.text.trim().slice(0, 2000)}`);
  question.options.forEach((option, index) => {
    console.log(`  ${index + 1}. ${option.label}${option.recommended ? "  (recommended)" : ""}`);
    if (option.description) console.log(`     ${option.description}`);
  });
  const hint = question.options.length > 0 ? "<number or text>" : '"<your response>"';
  console.log(`answer     cora send ${run.id} ${hint} --wait`);
  return true;
}

function printParkedManagerRecovery(run) {
  const recovery = run?.managerTurnRecovery;
  if (!recovery || run.status !== "paused") return false;
  const guidance =
    recovery.failureKind === "rate_limit"
      ? "selected account reached its usage limit; switch accounts or retry after quota resets"
      : recovery.failureKind === "transport"
        ? "provider connection was lost; retry when the connection is stable"
        : "provider is temporarily unavailable or at capacity; retry shortly or switch accounts";
  console.log(`provider   ${guidance}`);
  console.log(`retry      cora resume ${run.id} [profileId] --wait`);
  return true;
}

function printCoraSession(result) {
  const run = result?.run ?? result;
  if (!run?.id) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${run.id}  ${run.status}`);
  console.log(`title      ${run.title ?? "(untitled)"}`);
  const cwd = run.settingsSnapshot?.workspaceCwd ?? run.cwd ?? "?";
  console.log(`workspace  ${run.workspaceId ?? "?"}  cwd ${cwd}`);
  if (result.workspaceCreated) console.log("registered new Codara workspace");
  if (result.truncated) console.log("warning: message truncated to the CLI safety limit");
  if (result.timedOut) console.log("wait timed out; the session is still running");
  const messages = run.humanMessages ?? run.messages ?? [];
  // Skip the question message itself — it renders structured below.
  const lastCora = [...messages]
    .reverse()
    .find((message) => message.author === "spark" && message.id !== run.blockedOn?.questionMessageId);
  if (lastCora?.message) console.log(`cora       ${String(lastCora.message).slice(0, 1200)}`);
  if (run.status === "blocked" || run.status === "paused") {
    if (!printParkedManagerRecovery(run) && !printBlockedQuestion(run)) {
      console.log(`continue   cora send ${run.id} "<your response>" --wait`);
    }
  } else if (!result.timedOut && run.status !== "complete" && run.status !== "failed" && run.status !== "cancelled") {
    console.log(`follow     cora wait ${run.id}`);
  }
}

// Compact footer after a streamed follow — the transcript already scrolled by,
// so repeat only the status, the open question, and the next command.
function printRunFooter(result) {
  const run = result?.run ?? result;
  if (!run?.id) return;
  console.log("");
  console.log(`${run.id}  ${run.status}`);
  if (result.timedOut) console.log("wait timed out; the session is still running");
  if (run.status === "blocked" || run.status === "paused") {
    if (!printParkedManagerRecovery(run) && !printBlockedQuestion(run)) {
      console.log(`continue   cora send ${run.id} "<your response>" --wait`);
    }
  } else if (run.status !== "complete" && run.status !== "failed" && run.status !== "cancelled") {
    console.log(`follow     cora tail ${run.id}`);
  }
}

// ── event streaming (chat.events) ───────────────────────────────────────────

// Journal event types worth a quiet status line (rendered from the event's own
// human-readable message). Everything else is either streamed specially
// (chat.*) or too internal for terminal output.
const EVENT_LINE_TYPES = new Set([
  "run.status_updated",
  "run.paused",
  "run.resumed",
  "run.cancelled",
  "run.question_posted",
  "run.chat_turn_failed",
  "autopilot.started",
]);
const EVENT_LINE_PREFIXES = ["step.", "worker_attempt.", "worker_task.", "worker_report."];

function toolInputSummary(input) {
  if (input === undefined || input === null) return "";
  const text = typeof input === "string" ? input : JSON.stringify(input);
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return `  ${flat.slice(0, 100)}${flat.length > 100 ? "…" : ""}`;
}

function firstLine(text) {
  return String(text ?? "").split("\n", 1)[0].slice(0, 160);
}

// Incremental renderer: assistant text streams as it arrives, tool calls and
// worker/step transitions become quiet one-liners. Tracks whether stdout is
// mid-paragraph so status lines never splice into assistant text.
function createEventRenderer(json) {
  let midText = false;
  let lastMessageId;
  const breakText = () => {
    if (midText) {
      process.stdout.write("\n");
      midText = false;
    }
  };
  const line = (text) => {
    breakText();
    console.log(text);
  };
  return {
    render(event) {
      if (json) {
        console.log(JSON.stringify(event));
        return;
      }
      const type = event.type ?? "";
      const payload = event.payload ?? {};
      if (type === "chat.assistant_block") {
        const text = typeof payload.text === "string" ? payload.text : "";
        if (!text) return;
        if (payload.messageId !== lastMessageId) {
          breakText();
          if (lastMessageId !== undefined) process.stdout.write("\n");
          lastMessageId = payload.messageId;
        }
        process.stdout.write(text);
        midText = !text.endsWith("\n");
        return;
      }
      if (type === "chat.tool_use") {
        line(`  → ${payload.toolName ?? "tool"}${toolInputSummary(payload.input)}`);
        return;
      }
      if (type === "chat.tool_result") {
        if (payload.isError) line(`  → tool error: ${firstLine(payload.output)}`);
        return;
      }
      if (!event.message) return;
      if (EVENT_LINE_TYPES.has(type) || EVENT_LINE_PREFIXES.some((prefix) => type.startsWith(prefix))) {
        line(`  · ${event.message}`);
      }
    },
    note(text) {
      if (!json) line(`  · ${text}`);
    },
    flush: breakText,
  };
}

// Follow a run over chat.events long-polls, rendering incrementally. Keyed on
// runId + cursor, so a dropped connection retries and resumes exactly where it
// left off. Returns { runId, status } on a stop status, { timedOut } past the
// deadline, or { unsupported } when the app predates chat.events.
async function followRun(flags, runId, opts = {}) {
  const renderer = createEventRenderer(Boolean(opts.json));
  let cursor = opts.startCursor;
  if (cursor === undefined && opts.fromStart) cursor = 0;
  let canonicalId = runId;
  let failures = 0;
  for (;;) {
    const remaining = (opts.deadline ?? Infinity) - Date.now();
    if (remaining <= 0) {
      renderer.flush();
      return { runId: canonicalId, timedOut: true };
    }
    const waitMs = Math.min(25_000, Math.max(1_000, remaining));
    let res;
    try {
      res = await rpc(
        flags,
        "chat.events",
        { runId: canonicalId, ...(cursor === undefined ? {} : { afterSequence: cursor }), waitMs },
        { timeoutMs: waitMs + 15_000 },
      );
      failures = 0;
    } catch (err) {
      failures += 1;
      if (failures > 12) {
        renderer.flush();
        throw err;
      }
      if (failures === 1) renderer.note("connection lost; retrying");
      await sleep(Math.min(failures, 5) * 1000);
      continue;
    }
    if (res.error) {
      renderer.flush();
      // -32601 method-not-found / -32004 not-implemented: app build predates
      // chat.events — callers fall back to the blocking chat.wait.
      if (res.error.code === -32601 || res.error.code === -32004) {
        return { runId: canonicalId, unsupported: true };
      }
      fail(`chat.events failed: ${res.error.message}`);
    }
    const result = res.result ?? {};
    if (typeof result.runId === "string") canonicalId = result.runId;
    for (const event of result.events ?? []) renderer.render(event);
    if (typeof result.cursor === "number") cursor = result.cursor;
    else if (cursor === undefined) cursor = 0;
    // A truncated batch means more journal is waiting behind the cursor: keep
    // draining before honoring a terminal status, or the rest of the
    // transcript is silently dropped. Older app builds send no hasMore flag,
    // so a full batch is treated as possibly truncated too.
    const truncated = result.hasMore === true || (result.events ?? []).length >= EVENTS_MAX_BATCH;
    if (!truncated && WAIT_STOP_STATUSES.has(result.status)) {
      renderer.flush();
      return { runId: canonicalId, status: result.status };
    }
  }
}

// Stream the run to completion (or deadline), then print the footer from a
// fresh snapshot. Falls back to the blocking chat.wait on older app builds.
async function followAndPrint(flags, runId, opts = {}) {
  const followed = await followRun(flags, runId, opts);
  if (followed.unsupported) {
    const waited = await waitCall(flags, { runId: followed.runId, ...timeoutParams(flags) });
    output(flags, waited, printCoraSession);
    return;
  }
  const finalState = await waitCall(flags, { runId: followed.runId, timeoutMs: 0 });
  if (followed.timedOut) finalState.timedOut = true;
  printRunFooter(finalState);
}

// Results carrying a dataUrl (app.screenshot / preview.screenshot) get the
// image written to disk instead of a base64 flood in the terminal.
function saveImage(result, file, fallbackName) {
  const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(result.dataUrl ?? "");
  if (!m) fail("no image in response");
  const target = path.resolve(file || fallbackName);
  fs.writeFileSync(target, Buffer.from(m[2], "base64"));
  // preview.screenshot returns only the dataUrl; app.screenshot adds dims.
  const dims = result.width && result.height ? `  (${result.width}x${result.height})` : "";
  console.log(`${target}${dims}`);
}

// ── native CLI accounts (read-only) ─────────────────────────────────────────
//
// Codara Studio keeps each managed Claude Code / Codex account in its own state
// directory under the Codara home, and marks one per runtime as Active. This
// command only reports that list so a terminal can tell which account the
// "use the Active account in your terminal" setting currently points at.
//
// Nothing here mutates: the account list file is parsed, account directories
// are stat'ed, and no file inside them is ever opened. Accounts are created,
// renamed, signed in, and deleted only in Settings → Accounts.

const NATIVE_CLI_RUNTIMES = {
  claude: {
    id: "claude",
    product: "Claude Code",
    storeDirName: "claude-cli",
    selectorEnv: "CLAUDE_CONFIG_DIR",
    // Claude Code derives its macOS Keychain namespace from the NFC-normalized
    // config-directory path, so Studio stores and passes that spelling.
    normalizePath: (value) => path.resolve(value).normalize("NFC"),
    // Claude's sign-in state needs `claude auth status`, a subprocess this
    // command deliberately does not run.
    signedInMarker: null,
  },
  codex: {
    id: "codex",
    product: "Codex",
    storeDirName: "codex-cli",
    selectorEnv: "CODEX_HOME",
    normalizePath: (value) => path.resolve(value),
    // Presence only — the file is stat'ed, never opened.
    signedInMarker: "auth.json",
  },
};

const NATIVE_CLI_ACCOUNTS_FILE = "account-profiles.json";
const NATIVE_CLI_ACCOUNTS_DIRECTORY = "accounts";
const ADD_ACCOUNT_HINT =
  "Add one in Codara Studio → Settings → Accounts → Add account.";

function nativeCliStorePaths(flags, runtime) {
  const rootDir = runtime.normalizePath(
    path.join(homeDir(flags), runtime.storeDirName),
  );
  return {
    rootDir,
    accountsDir: runtime.normalizePath(
      path.join(rootDir, NATIVE_CLI_ACCOUNTS_DIRECTORY),
    ),
    listFile: path.join(rootDir, NATIVE_CLI_ACCOUNTS_FILE),
  };
}

function nativeCliAccountStateDir(runtime, accountsDir, id) {
  const stateDir = runtime.normalizePath(path.join(accountsDir, id));
  if (path.dirname(stateDir) !== accountsDir || path.basename(stateDir) !== id) {
    fail(`account ${id} points outside ${accountsDir}`);
  }
  return stateDir;
}

function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

// Read-only view of one runtime's account list. Unknown/extra fields in the
// file are ignored; a missing file simply means no accounts have been added.
function listNativeCliAccounts(flags, runtime) {
  const { rootDir, accountsDir, listFile } = nativeCliStorePaths(flags, runtime);
  let raw = null;
  try {
    raw = fs.readFileSync(listFile, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT" && err.code !== "ENOTDIR") {
      fail(`could not read ${listFile}: ${err.message}`);
    }
  }
  let snapshot = null;
  if (raw !== null) {
    try {
      snapshot = JSON.parse(raw);
    } catch {
      fail(
        `${listFile} is not readable JSON — open Codara Studio → Settings → Accounts to repair it.`,
      );
    }
  }
  const rows = Array.isArray(snapshot?.profiles) ? snapshot.profiles : [];
  const activeId =
    typeof snapshot?.defaultProfileId === "string"
      ? snapshot.defaultProfileId
      : "personal";
  const accounts = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const { id, label } = row;
    if (typeof id !== "string" || !UUID_V4_PATTERN.test(id)) continue;
    if (typeof label !== "string" || !label.trim()) continue;
    const stateDir = nativeCliAccountStateDir(runtime, accountsDir, id);
    const ready = pathExists(stateDir);
    accounts.push({
      runtime: runtime.id,
      id,
      label: label.trim(),
      isActive: id === activeId,
      ready,
      signedIn:
        !ready || !runtime.signedInMarker
          ? null
          : pathExists(path.join(stateDir, runtime.signedInMarker)),
    });
  }
  accounts.push({
    runtime: runtime.id,
    id: "personal",
    label: "Existing terminal login",
    isActive: activeId === "personal",
    ready: true,
    signedIn: null,
  });
  return { runtime, rootDir, listFile, accounts };
}

function printNativeCliAccounts(listings) {
  for (const listing of listings) {
    const runtime = listing.runtime;
    console.log(`${runtime.product.toUpperCase()}   (${runtime.selectorEnv})`);
    if (listing.accounts.length === 1) {
      console.log(`  (no accounts added yet under ${listing.rootDir})`);
      console.log(`  ${ADD_ACCOUNT_HINT}`);
    }
    for (const account of listing.accounts) {
      const state =
        account.id === "personal"
          ? "the login this terminal already had"
          : account.signedIn === true
            ? "signed in"
            : account.signedIn === false
              ? "sign-in needed"
              : account.ready
                ? "ready"
                : "not set up yet";
      console.log(
        `  ${account.isActive ? "→" : " "} ${account.label.padEnd(24)} ` +
          `${account.id.padEnd(36)}  ${state}`,
      );
    }
    console.log("");
  }
  console.log("→ marks the Active account for that CLI.");
  console.log(
    "Turn on Settings → Accounts → \"Use the Active account in your terminal\" to make new terminals follow it.",
  );
}

// ── commands ────────────────────────────────────────────────────────────────

const GLASS_KEYS = {
  veil: "glassVeil",
  blur: "glassBlur",
  refraction: "glassRefraction",
  chroma: "glassChroma",
};

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...args] = positional;

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
      console.log(HELP);
      return;

    // ── app ──
    case "status": {
      const info = await call(flags, "app.info", {});
      output(flags, info, (r) => {
        console.log(`${r.name} ${r.version}  pid ${r.pid}  up ${formatUptime(r.uptimeSec)}`);
        console.log(`home      ${r.homeDir}`);
        console.log(`build     ${r.packaged ? "packaged" : "dev"}  (dev tools ${r.devTools ? "on" : "off"})`);
        console.log(`electron  ${r.electron}  chrome ${r.chrome}  node ${r.node}`);
        for (const w of r.windows) {
          console.log(`window    #${w.id} "${w.title}" ${w.bounds.width}x${w.bounds.height}${w.focused ? "  (focused)" : ""}`);
        }
      });
      return;
    }
    case "shot": {
      const result = await call(flags, "app.screenshot", {});
      saveImage(result, args[0], "cora-shot.png");
      return;
    }
    case "eval": {
      if (!args[0]) fail("usage: cora eval '<js>'");
      const result = await call(flags, "app.evaluate", { code: args[0] });
      output(flags, result, (r) => console.log(typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2)));
      return;
    }
    case "notify": {
      const params = { kind: args[0] };
      if (flags.title) params.title = flags.title;
      if (flags.body) params.body = flags.body;
      if (flags.tone) params.tone = flags.tone;
      if (flags.sound) params.sound = flags.sound;
      if (flags.source) params.sourceKey = flags.source;
      if (flags.runId) params.runId = flags.runId;
      if (flags.workspaceId) params.workspaceId = flags.workspaceId;
      if (flags.tabId) params.tabId = flags.tabId;
      if (flags.paneId) params.paneId = flags.paneId;
      if (flags.jobId) params.jobId = flags.jobId;
      const result = await call(flags, "app.notify", params);
      output(flags, result, (r) => console.log(`published ${r.kind}  (source ${r.sourceKey})`));
      return;
    }
    case "prefs": {
      if (args.length >= 2) {
        const result = await call(flags, "app.prefs.set", { key: args[0], value: parseValue(args[1]) });
        output(flags, result, (r) => console.log(`${r.key} = ${JSON.stringify(r.value)}`));
      } else if (args.length === 1) {
        const result = await call(flags, "app.prefs.get", { key: args[0] });
        output(flags, result, (r) => console.log(JSON.stringify(r.value, null, 2)));
      } else {
        const result = await call(flags, "app.prefs.get", {});
        output(flags, result, (r) => console.log(JSON.stringify(r.preferences, null, 2)));
      }
      return;
    }
    case "glass": {
      if (!args[0]) {
        const { preferences } = await call(flags, "app.prefs.get", {});
        output(flags, preferences, (p) => {
          for (const [short, key] of Object.entries(GLASS_KEYS)) {
            console.log(`${short.padEnd(11)} ${p[key] ?? 100}%`);
          }
          console.log(`glass      ${p.glassEffects === false ? "OFF" : "on"}`);
        });
        return;
      }
      if (args[0] === "reset") {
        for (const key of Object.values(GLASS_KEYS)) {
          await call(flags, "app.prefs.set", { key, value: 100 });
        }
        console.log("glass tuning reset to 100/100/100/100");
        return;
      }
      if (args[0] === "on" || args[0] === "off") {
        await call(flags, "app.prefs.set", { key: "glassEffects", value: args[0] === "on" });
        console.log(`glass effects ${args[0]}`);
        return;
      }
      const key = GLASS_KEYS[args[0]];
      if (!key || args[1] === undefined) fail("usage: cora glass [veil|blur|refraction|chroma] <0-200> | reset | on | off");
      const pct = Number(args[1]);
      if (!Number.isFinite(pct)) fail(`"${args[1]}" is not a number (expected 0-200)`);
      const result = await call(flags, "app.prefs.set", { key, value: pct });
      console.log(`${args[0]} = ${result.value}%  (applied live)`);
      return;
    }

    // ── preview ──
    case "open": {
      if (!args[0]) fail("usage: cora open <url>");
      const url = /^[a-z]+:\/\//i.test(args[0]) ? args[0] : `https://${args[0]}`;
      const result = await call(flags, "preview.navigate", { url });
      output(flags, result, (r) => console.log(`preview → ${r.url ?? url}`));
      return;
    }
    case "pshot": {
      const result = await call(flags, "preview.screenshot", {});
      saveImage(result, args[0], "cora-preview.png");
      return;
    }
    case "snapshot": {
      const result = await call(flags, "preview.snapshot", {});
      output(flags, result, (r) => console.log(typeof r === "string" ? r : JSON.stringify(r, null, 2)));
      return;
    }
    case "click": {
      const params = flags.at
        ? { x: Number(String(flags.at).split(",")[0]), y: Number(String(flags.at).split(",")[1]) }
        : { selector: args[0] };
      if (!flags.at && !args[0]) fail("usage: cora click <selector> | cora click --at x,y");
      const result = await call(flags, "preview.mouse", { action: "click", ...params });
      output(flags, result, () => console.log("clicked"));
      return;
    }
    case "type": {
      if (!args[0] || args[1] === undefined) fail("usage: cora type <selector> <text>");
      const result = await call(flags, "preview.type", { selector: args[0], text: args.slice(1).join(" ") });
      output(flags, result, () => console.log("typed"));
      return;
    }
    case "press": {
      if (!args[0]) fail("usage: cora press <key>   (e.g. Enter, Meta+A)");
      const result = await call(flags, "preview.press_key", { key: args[0] });
      output(flags, result, () => console.log(`pressed ${args[0]}`));
      return;
    }
    case "peval": {
      if (!args[0]) fail("usage: cora peval '<js>'");
      const result = await call(flags, "preview.evaluate", { code: args[0] });
      output(flags, result, (r) => {
        const value = r && typeof r === "object" && "value" in r ? r.value : r;
        console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
      });
      return;
    }
    case "scroll": {
      if (args.length < 2) fail("usage: cora scroll <dx> <dy>");
      const result = await call(flags, "preview.scroll", { dx: Number(args[0]), dy: Number(args[1]) });
      output(flags, result, () => console.log("scrolled"));
      return;
    }
    case "console": {
      const params = {};
      if (flags.pattern) params.pattern = flags.pattern;
      const result = await call(flags, "preview.console", params);
      output(flags, result, (r) => {
        const messages = r.messages ?? r;
        if (!Array.isArray(messages) || messages.length === 0) return console.log("(no console messages)");
        for (const m of messages) console.log(`[${m.level ?? "log"}] ${m.text ?? JSON.stringify(m)}`);
      });
      return;
    }
    case "network": {
      const result = await call(flags, "preview.network", {});
      output(flags, result, (r) => {
        const requests = r.requests ?? r;
        if (!Array.isArray(requests) || requests.length === 0) return console.log("(no requests captured)");
        for (const q of requests) console.log(`${String(q.status ?? "…").padEnd(4)} ${q.method ?? "GET"} ${q.url}`);
      });
      return;
    }
    case "url": {
      const result = await call(flags, "preview.url", {});
      output(flags, result, (r) => console.log(r.url ?? JSON.stringify(r)));
      return;
    }

    // ── Cora sessions ──
    case "start": {
      rejectUnknownFlags("start", flags, START_FLAGS);
      if (args.length === 0) {
        fail(
          "usage: cora start <prompt> [--cwd DIR] [--backend ENGINE] [--wait]",
        );
      }
      const params = {
        cwd: path.resolve(flagText(flags, "cwd") || process.cwd()),
        prompt: args.join(" "),
      };
      copyTextFlag(flags, params, "title");
      copyTextFlag(flags, params, "workspaceName");
      copyTextFlag(flags, params, "backend");
      copyTextFlag(flags, params, "model");
      copyTextFlag(flags, params, "effort");
      const started = await call(flags, "chat.create", params);
      if (flags.wait) {
        if (flags.json) {
          const waited = await waitCall(flags, { runId: started.run.id, ...timeoutParams(flags) });
          output(flags, waited, printCoraSession);
        } else {
          console.log(`${started.run.id}  started`);
          if (started.workspaceCreated) console.log("registered new Codara workspace");
          console.log("");
          const timeout = timeoutParams(flags);
          await followAndPrint(flags, started.run.id, {
            fromStart: true,
            deadline: Date.now() + (timeout.timeoutMs ?? DEFAULT_WAIT_MS),
          });
        }
      } else {
        output(flags, started, printCoraSession);
      }
      return;
    }
    case "accounts": {
      rejectUnknownFlags("accounts", flags, new Set());
      if (args.length > 0) {
        // `cora accounts cli` (or a single runtime) lists the terminal CLI
        // accounts. It reads the account list files directly, so it works
        // whether or not Codara Studio is running.
        const scope = args[0];
        if (args.length > 1 || !["cli", "claude", "codex"].includes(scope)) {
          fail("usage: cora accounts [cli|claude|codex]");
        }
        const runtimes =
          scope === "cli"
            ? [NATIVE_CLI_RUNTIMES.claude, NATIVE_CLI_RUNTIMES.codex]
            : [NATIVE_CLI_RUNTIMES[scope]];
        const listings = runtimes.map((runtime) =>
          listNativeCliAccounts(flags, runtime),
        );
        output(
          flags,
          {
            accounts: listings.flatMap((listing) =>
              listing.accounts.map((account) => ({
                runtime: account.runtime,
                id: account.id,
                label: account.label,
                isActive: account.isActive,
                ready: account.ready,
                signedIn: account.signedIn,
              })),
            ),
          },
          () => printNativeCliAccounts(listings),
        );
        return;
      }
      const result = await call(flags, "accounts.list", {});
      output(flags, result, (r) => {
        const accounts = Array.isArray(r?.accounts) ? r.accounts : [];
        if (accounts.length === 0) {
          console.log("(no Cora subscription accounts)");
        }
        for (const account of accounts) {
          const remaining =
            typeof account.remainingPercent === "number"
              ? `  ${account.remainingPercent}% remaining`
              : "";
          console.log(
            `${account.id}  ${account.provider}  ${account.label}  ${account.status}` +
              `${account.isDefault ? "  (active)" : ""}${remaining}`,
          );
        }
        console.log("");
        console.log(
          "(terminal Claude Code / Codex logins: cora accounts cli)",
        );
      });
      return;
    }
    case "resume": {
      rejectUnknownFlags("resume", flags, RESUME_FLAGS);
      if (!args[0] || args.length > 2) {
        fail("usage: cora resume <runId> [profileId] [--wait] [--timeout SECONDS]");
      }
      if (args[1] && !UUID_V4_PATTERN.test(args[1])) {
        fail("profileId must be a lowercase UUIDv4");
      }
      if (flags.timeout !== undefined && !flags.wait) {
        fail("--timeout requires --wait");
      }
      const timeout = timeoutParams(flags);
      const resumed = await callWithRetry(flags, "chat.resume", {
        runId: args[0],
        ...(args[1] ? { profileId: args[1] } : {}),
      });
      const successful =
        resumed?.outcome === "accepted" || resumed?.outcome === "already-resuming";
      if (!successful) {
        output(flags, resumed, (result) => {
          console.log(
            `${result.runId ?? args[0]}  ${result.outcome ?? "not-resumed"}` +
              `${result.recoveryId ? `  ${result.recoveryId}` : ""}`,
          );
          if (result.reason) console.log(`reason     ${result.reason}`);
        });
        console.error(`Cora manager turn was not resumed: ${resumed?.reason ?? resumed?.outcome ?? "unknown outcome"}`);
        process.exitCode = 1;
        return;
      }
      if (!flags.wait) {
        output(flags, resumed, (result) => {
          console.log(`${result.runId}  ${result.outcome}  ${result.recoveryId}`);
        });
        return;
      }
      if (flags.json) {
        const waited = await waitCall(flags, { runId: resumed.runId, ...timeout });
        output(flags, { resume: resumed, wait: waited }, () => undefined);
        return;
      }
      console.log(`${resumed.runId}  ${resumed.outcome}  ${resumed.recoveryId}`);
      console.log("");
      await followAndPrint(flags, resumed.runId, {
        deadline: Date.now() + (timeout.timeoutMs ?? DEFAULT_WAIT_MS),
      });
      return;
    }
    case "send": {
      if (!args[0] || !args[1]) fail("usage: cora send <runId> <message> [--wait]");
      let content = args.slice(1).join(" ");
      // A bare number answers the pending option-set question by index; when no
      // options are pending (or the index is out of range) it stays free text.
      const optionIndex = /^\d+$/.test(content.trim()) ? Number(content.trim()) : null;
      if (optionIndex !== null && optionIndex >= 1) {
        const snapshot = await rpc(flags, "chat.wait", { runId: args[0], timeoutMs: 0 }).catch(() => null);
        const option = blockedQuestion(snapshot?.result?.run)?.options?.[optionIndex - 1];
        if (option) {
          content = option.answer || option.label;
          if (!flags.json) console.log(`option ${optionIndex}: ${option.label}`);
        }
      }
      let startCursor;
      if (flags.wait && !flags.json) {
        // Grab the cursor before sending so the reply streams from its first event.
        const boot = await rpc(flags, "chat.events", { runId: args[0] }).catch(() => null);
        if (typeof boot?.result?.cursor === "number") startCursor = boot.result.cursor;
      }
      const sent = await call(flags, "chat.send", { runId: args[0], content });
      if (flags.wait) {
        if (flags.json) {
          const waited = await waitCall(flags, { runId: sent.run.id, ...timeoutParams(flags) });
          output(flags, waited, printCoraSession);
        } else {
          const timeout = timeoutParams(flags);
          await followAndPrint(flags, sent.run.id, {
            startCursor,
            deadline: Date.now() + (timeout.timeoutMs ?? DEFAULT_WAIT_MS),
          });
        }
      } else {
        output(flags, sent, printCoraSession);
      }
      return;
    }
    case "wait": {
      if (!args[0]) fail("usage: cora wait <runId> [--timeout SECONDS]");
      if (flags.json) {
        const waited = await waitCall(flags, { runId: args[0], ...timeoutParams(flags) });
        output(flags, waited, printCoraSession);
        return;
      }
      const timeout = timeoutParams(flags);
      await followAndPrint(flags, args[0], {
        deadline: Date.now() + (timeout.timeoutMs ?? DEFAULT_WAIT_MS),
      });
      return;
    }
    case "tail": {
      if (!args[0]) fail("usage: cora tail <runId> [--all] [--timeout SECONDS]");
      const timeout = timeoutParams(flags);
      const followed = await followRun(flags, args[0], {
        fromStart: Boolean(flags.all),
        deadline: timeout.timeoutMs === undefined ? Infinity : Date.now() + timeout.timeoutMs,
        json: Boolean(flags.json),
      });
      if (followed.unsupported) fail("this app build has no chat.events — update the app, or use cora wait");
      if (flags.json) return;
      const finalState = await waitCall(flags, { runId: followed.runId, timeoutMs: 0 });
      if (followed.timedOut) finalState.timedOut = true;
      printRunFooter(finalState);
      return;
    }
    case "cancel": {
      if (!args[0]) fail("usage: cora cancel <runId> [reason]");
      const cancelled = await call(flags, "chat.cancel", {
        runId: args[0],
        reason: args.slice(1).join(" ") || undefined,
      });
      output(flags, cancelled, printCoraSession);
      return;
    }

    // ── typed worker-agent control ──
    case "agent": {
      const [agentCommand, ...agentArgs] = args;
      switch (agentCommand) {
        case "spawn": {
          rejectUnknownFlags("agent spawn", flags, AGENT_SPAWN_FLAGS);
          if (!agentArgs[0] || agentArgs.length < 2) {
            fail("usage: cora agent spawn <run-id-or-prefix> <brief> --title TITLE [options]");
          }
          const run = resolveAgentRun(flags, agentArgs[0]);
          const title = requireBoundedText(
            flagText(flags, "title"),
            "--title",
            200,
            { singleLine: true },
          );
          const description = requireBoundedText(
            agentArgs.slice(1).join(" "),
            "worker brief",
            32_000,
            { trim: true },
          );
          const worker = { title, description };
          const runtimePreference = optionalAgentEnumFlag(
            flags,
            "runtime",
            AGENT_SPAWN_RUNTIMES,
          );
          const effortHint = optionalAgentEnumFlag(flags, "effort", AGENT_SPAWN_EFFORTS);
          const taskClass = optionalAgentEnumFlag(flags, "class", AGENT_SPAWN_CLASSES);
          const taskComplexity = optionalAgentEnumFlag(
            flags,
            "complexity",
            AGENT_TASK_COMPLEXITIES,
          );
          const modelHint = optionalAgentTextFlag(flags, "model", 200);
          const allowedPaths = optionalAgentStringArrayFlag(flags, "allowedPaths");
          const forbiddenPaths = optionalAgentStringArrayFlag(flags, "forbiddenPaths");
          const expectedOutputs = optionalAgentStringArrayFlag(flags, "expectedOutputs");
          const verificationCommands = optionalAgentStringArrayFlag(
            flags,
            "verificationCommands",
            { maxItems: 32, maxLength: 8_000 },
          );
          if (runtimePreference !== undefined) worker.runtimePreference = runtimePreference;
          if (modelHint !== undefined) worker.modelHint = modelHint;
          if (effortHint !== undefined) worker.effortHint = effortHint;
          if (taskClass !== undefined) worker.taskClass = taskClass;
          if (allowedPaths !== undefined) worker.allowedPaths = allowedPaths;
          if (forbiddenPaths !== undefined) worker.forbiddenPaths = forbiddenPaths;
          if (expectedOutputs !== undefined) worker.expectedOutputs = expectedOutputs;
          if (verificationCommands !== undefined) {
            worker.verificationCommands = verificationCommands;
          }
          const result = await call(flags, "orchestrator.spawn_workers", {
            runId: run.id,
            ...(taskComplexity === undefined ? {} : { taskComplexity }),
            workers: [worker],
          });
          output(flags, result, (spawned) => {
            const ids = Array.isArray(spawned?.worker_task_ids)
              ? spawned.worker_task_ids.filter((value) => typeof value === "string")
              : [];
            if (ids.length === 0) console.log(`no worker spawned on ${run.id}`);
            for (const taskId of ids) console.log(`spawned  ${taskId}  on ${run.id}`);
            if (typeof spawned?.note === "string" && spawned.note.trim()) {
              console.log(`note     ${spawned.note.trim()}`);
            }
          });
          return;
        }
        case "status": {
          rejectUnknownFlags("agent status", flags, new Set());
          if (agentArgs.length !== 2) {
            fail("usage: cora agent status <run-id-or-prefix> <task-id-or-prefix>");
          }
          const resolved = resolveAgentRunAndTasks(flags, agentArgs[0], [agentArgs[1]]);
          const result = await call(flags, "orchestrator.get_worker_status", {
            runId: resolved.run.id,
            worker_task_id: resolved.taskIds[0],
          });
          output(flags, result, printAgentStatus);
          return;
        }
        case "message": {
          rejectUnknownFlags("agent message", flags, AGENT_MESSAGE_FLAGS);
          if (agentArgs.length < 3) {
            fail(
              "usage: cora agent message <run-id-or-prefix> <task-id-or-prefix|all> <message> [--subject SUBJECT]",
            );
          }
          const run = resolveAgentRun(flags, agentArgs[0]);
          const to =
            agentArgs[1] === "all"
              ? "all"
              : resolveAgentTaskIds(run, [agentArgs[1]])[0];
          const body = requireBoundedText(
            agentArgs.slice(2).join(" "),
            "message",
            16_000,
            { trim: true },
          );
          const subject = optionalAgentTextFlag(flags, "subject", 300);
          const result = await call(flags, "orchestrator.message_workers", {
            runId: run.id,
            to,
            body,
            ...(subject === undefined ? {} : { subject }),
          });
          output(flags, result, (sent) => {
            console.log(`sent     ${sent?.message_id ?? "(unknown)"}  to ${sent?.to ?? to}`);
            if (typeof sent?.warning === "string") console.log(`warning  ${sent.warning}`);
          });
          return;
        }
        case "wait": {
          rejectUnknownFlags("agent wait", flags, AGENT_WAIT_FLAGS);
          if (agentArgs.length < 2) {
            fail(
              "usage: cora agent wait <run-id-or-prefix> <task-id-or-prefix>... [--mode all|any] [--timeout SECONDS]",
            );
          }
          const resolved = resolveAgentRunAndTasks(flags, agentArgs[0], agentArgs.slice(1));
          const mode = optionalAgentEnumFlag(flags, "mode", AGENT_WAIT_MODES) ?? "all";
          const timeoutMs = agentWaitTimeoutMs(flags);
          const result = await agentWaitCall(flags, {
            runId: resolved.run.id,
            worker_task_ids: resolved.taskIds,
            mode,
            ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
          });
          output(flags, result, printAgentWait);
          return;
        }
        case undefined:
          fail("usage: cora agent <spawn|status|message|wait> ...");
          return;
        default:
          fail(`unknown agent command: ${agentCommand}`);
      }
      return;
    }

    // ── runs & terminals ──
    case "runs": {
      const runs = listRuns(flags);
      output(flags, runs, (list) => {
        if (list.length === 0) return console.log(`(no runs in ${homeDir(flags)}/runs)`);
        for (const r of list) {
          console.log(`${r.id.slice(0, 20).padEnd(22)} ${String(r.status).padEnd(10)} ${(r.updatedAt ?? "").slice(0, 16).padEnd(18)} ${r.title ?? ""}`);
        }
      });
      return;
    }
    case "run": {
      if (!args[0]) fail("usage: cora run <id-or-prefix>");
      const match = findRunOffline(flags, args[0]);
      output(flags, match, (r) => {
        console.log(`${r.id}  ${r.status}`);
        console.log(`title     ${r.title ?? "(untitled)"}`);
        console.log(`workspace ${r.workspaceId ?? "?"}  cwd ${r.cwd ?? "?"}`);
        console.log(`steps ${r.steps?.length ?? 0}  tasks ${r.workerTasks?.length ?? 0}  attempts ${r.workerAttempts?.length ?? 0}  messages ${r.messages?.length ?? 0}`);
        const tail = (r.messages ?? []).slice(-5);
        for (const m of tail) console.log(`  [${m.author ?? "?"}] ${String(m.message ?? "").slice(0, 120)}`);
        console.log(`(deep dive: npm run inspect-run -- ${r.id})`);
      });
      return;
    }
    case "agents": {
      rejectUnknownFlags("agents", flags, new Set());
      if (args.length > 1) fail("usage: cora agents [run-id-or-prefix]");
      const overview = buildAgentOverview(flags, args[0]);
      output(flags, overview, printAgentOverview);
      return;
    }
    case "log": {
      if (!args[0]) fail("usage: cora log <id-or-prefix>");
      const match = findRunOffline(flags, args[0]);
      output(flags, match, (r) => {
        console.log(`${r.id}  ${r.status}  ${r.title ?? "(untitled)"}`);
        const messages = r.humanMessages ?? r.messages ?? [];
        if (messages.length === 0) return console.log("(no messages)");
        for (const m of messages) {
          const when = String(m.createdAt ?? "").slice(0, 16).replace("T", " ");
          console.log("");
          console.log(`${authorLabel(m.author)}${when ? `  ${when}` : ""}`);
          for (const text of String(m.message ?? "").split("\n")) console.log(`  ${text}`);
          (m.questionOptions ?? []).forEach((option, index) => {
            console.log(`    ${index + 1}. ${option.label}${option.recommended ? "  (recommended)" : ""}`);
          });
        }
      });
      return;
    }
    case "read": {
      if (!args[0]) fail("usage: cora read <paneId> [--lines N]");
      const params = { paneId: args[0] };
      if (flags.lines) params.lines = Number(flags.lines);
      const result = await call(flags, "terminal.read", params);
      output(flags, result, (r) => console.log(r.text));
      return;
    }
    case "say": {
      if (!args[0] || !args[1]) fail("usage: cora say <runId> <message>");
      const result = await call(flags, "chat.append", { runId: args[0], content: args.slice(1).join(" ") });
      output(flags, result, (r) => console.log(`noted on ${r.runId}${r.truncated ? " (truncated)" : ""}`));
      return;
    }

    // ── escape hatch ──
    case "rpc": {
      if (!args[0]) fail("usage: cora rpc <method> [params-json]");
      const res = await rpc(flags, args[0], args[1] ? JSON.parse(args[1]) : {});
      console.log(JSON.stringify(res.error ?? res.result, null, 2));
      if (res.error) process.exit(1);
      return;
    }

    default:
      fail(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

function listRuns(flags) {
  const runsDir = path.join(homeDir(flags), "runs");
  let entries = [];
  try {
    entries = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of entries) {
    try {
      runs.push(JSON.parse(fs.readFileSync(path.join(runsDir, entry, "run.json"), "utf8")));
    } catch {
      /* half-written or foreign dir — skip */
    }
  }
  return runs.sort((a, b) => String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")));
}

function findRunOffline(flags, idOrPrefix) {
  const runs = listRuns(flags);
  const match = runs.find((r) => r.id === idOrPrefix) ?? runs.find((r) => r.id.startsWith(idOrPrefix));
  if (!match) fail(`no run matching "${idOrPrefix}"`);
  return match;
}

// `cora agents` is deliberately a durable, read-only view. It does not need
// the app socket and it never projects arbitrary run.json strings: titles,
// prompts, commands, model/account identifiers, errors, and every path stay on
// disk. The small allowlists below make its JSON output a stable sanitized
// contract rather than a partial RunState serialization.
const AGENT_RUN_DIRECTORY_SCAN_MAX = 5_000;
const AGENT_RUN_READ_MAX = 250;
const AGENT_RUN_FILE_BYTES_MAX = 8 * 1024 * 1024;
const AGENT_ROWS_MAX = 250;
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AGENT_RUN_STATUSES = new Set([
  "idle",
  "planning",
  "running",
  "reviewing",
  "blocked",
  "paused",
  "complete",
  "failed",
  "cancelled",
]);
const AGENT_TASK_STATUSES = new Set([
  "created",
  "queued",
  "claimed",
  "running",
  "needs_review",
  "accepted",
  "retry_queued",
  "blocked",
  "failed",
  "cancelled",
]);
const ACTIVE_AGENT_TASK_STATUSES = new Set([
  "created",
  "queued",
  "claimed",
  "running",
  "needs_review",
  "retry_queued",
  "blocked",
]);
const AGENT_ATTEMPT_STATUSES = new Set([
  "preparing",
  "prompt_ready",
  "launching",
  "running",
  "finishing",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);
const ACTIVE_AGENT_ATTEMPT_STATUSES = new Set([
  "preparing",
  "prompt_ready",
  "launching",
  "running",
  "finishing",
]);
const AGENT_RUNTIMES = new Set(["claude", "codex", "shell", "manual"]);
const AGENT_ROLES = new Set(["skeleton", "feature", "leaf", "verifier"]);
const AGENT_RUNTIME_STATES = new Set(["launching", "working", "blocked", "idle", "done", "error"]);

function safeAgentId(value) {
  return typeof value === "string" && SAFE_AGENT_ID.test(value) ? value : undefined;
}

function safeAgentEnum(value, allowed, fallback = "unknown") {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function readAgentRunFile(runFile) {
  try {
    const info = fs.lstatSync(runFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > AGENT_RUN_FILE_BYTES_MAX) return null;
    const parsed = JSON.parse(fs.readFileSync(runFile, "utf8"));
    return parsed && typeof parsed === "object" && safeAgentId(parsed.id) ? parsed : null;
  } catch {
    return null;
  }
}

function agentRunFiles(flags, idOrPrefix) {
  const runsDir = path.join(homeDir(flags), "runs");
  let entries;
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    if (idOrPrefix) fail(`no run matching "${idOrPrefix}"`);
    return { runs: [], truncated: false };
  }

  if (idOrPrefix) {
    if (!SAFE_AGENT_ID.test(idOrPrefix)) fail("run id or prefix contains unsupported characters");
    const exact = entries.find((entry) => entry.name === idOrPrefix);
    const matches = exact
      ? [exact]
      : entries.filter((entry) => entry.name.startsWith(idOrPrefix));
    if (matches.length === 0) fail(`no run matching "${idOrPrefix}"`);
    if (matches.length > 1) fail(`run prefix "${idOrPrefix}" is ambiguous`);
    const run = readAgentRunFile(path.join(runsDir, matches[0].name, "run.json"));
    if (!run || (run.id !== idOrPrefix && !run.id.startsWith(idOrPrefix))) {
      fail(`run data unavailable for "${idOrPrefix}"`);
    }
    return { runs: [run], truncated: false };
  }

  // Generated run ids are time-ordered. Sorting before the directory cap keeps
  // the newest durable runs when a long-lived installation has thousands.
  const directoryTruncated = entries.length > AGENT_RUN_DIRECTORY_SCAN_MAX;
  const candidates = entries
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, AGENT_RUN_DIRECTORY_SCAN_MAX)
    .map((entry) => {
      const runFile = path.join(runsDir, entry.name, "run.json");
      try {
        const info = fs.lstatSync(runFile);
        if (!info.isFile() || info.isSymbolicLink()) return null;
        return { runFile, mtimeMs: info.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const readTruncated = candidates.length > AGENT_RUN_READ_MAX;
  const runs = candidates
    .slice(0, AGENT_RUN_READ_MAX)
    .map((candidate) => readAgentRunFile(candidate.runFile))
    .filter(Boolean);
  return { runs, truncated: directoryTruncated || readTruncated };
}

function resolveAgentRun(flags, idOrPrefix) {
  if (typeof idOrPrefix !== "string" || !idOrPrefix) {
    fail("run id or prefix is required");
  }
  return agentRunFiles(flags, idOrPrefix).runs[0];
}

function resolveAgentTaskIds(run, taskPrefixes) {
  if (!Array.isArray(run?.workerTasks)) {
    fail(`run ${run?.id ?? "(unknown)"} has no worker-task data`);
  }
  if (
    !Array.isArray(taskPrefixes) ||
    taskPrefixes.length === 0 ||
    taskPrefixes.length > AGENT_WAIT_TASKS_MAX
  ) {
    fail(`expected between 1 and ${AGENT_WAIT_TASKS_MAX} worker task ids or prefixes`);
  }
  const resolved = taskPrefixes.map((prefix) => {
    if (typeof prefix !== "string" || !SAFE_AGENT_ID.test(prefix)) {
      fail(`worker task id or prefix ${JSON.stringify(prefix)} contains unsupported characters`);
    }
    const tasks = run.workerTasks.filter((task) => safeAgentId(task?.id));
    const exact = tasks.find((task) => task.id === prefix);
    const matches = exact ? [exact] : tasks.filter((task) => task.id.startsWith(prefix));
    if (matches.length === 0) {
      fail(`no worker task matching "${prefix}" in run ${run.id}`);
    }
    if (matches.length > 1) {
      fail(`worker task prefix "${prefix}" is ambiguous in run ${run.id}`);
    }
    return matches[0].id;
  });
  if (new Set(resolved).size !== resolved.length) {
    fail("worker task list resolves to duplicate tasks");
  }
  return resolved;
}

function resolveAgentRunAndTasks(flags, runPrefix, taskPrefixes) {
  const run = resolveAgentRun(flags, runPrefix);
  return { run, taskIds: resolveAgentTaskIds(run, taskPrefixes) };
}

function printAgentStatus(status) {
  if (!status || typeof status !== "object") {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`${status.worker_task_id ?? "(unknown task)"}  ${status.task_status ?? "unknown"}`);
  console.log(
    `runtime   ${status.runtime ?? "unknown"}  attempt ${status.attempt_status ?? "not started"}`,
  );
  if (status.started_at) console.log(`started   ${status.started_at}`);
  if (status.finished_at) console.log(`finished  ${status.finished_at}`);
  if (status.final_report_path) console.log(`report    ${status.final_report_path}`);
}

function printAgentWait(result) {
  const workers = Array.isArray(result?.workers) ? result.workers : [];
  console.log(`wait     ${result?.reason ?? "returned"}  (${workers.length} worker${workers.length === 1 ? "" : "s"})`);
  for (const worker of workers) {
    const requested =
      worker.requested_worker_task_id &&
      worker.requested_worker_task_id !== worker.worker_task_id
        ? `  (replaced ${worker.requested_worker_task_id})`
        : "";
    console.log(
      `${worker.worker_task_id ?? "(unknown task)"}  ` +
        `${worker.task_status ?? "unknown"}/${worker.attempt_status ?? "not-started"}  ` +
        `${worker.runtime ?? "unknown"}${requested}`,
    );
    if (worker.final_report?.summary) {
      console.log(`  report  ${String(worker.final_report.summary).slice(0, 1_200)}`);
    } else if (worker.final_report_path) {
      console.log(`  report  ${worker.final_report_path}`);
    }
  }
  const messages = Array.isArray(result?.manager_messages) ? result.manager_messages : [];
  for (const message of messages) {
    const from = message?.from ?? message?.worker_task_id ?? "worker";
    const body = message?.body ?? message?.message ?? "";
    console.log(`message  ${from}: ${String(body).slice(0, 1_200)}`);
  }
}

function currentAttemptByTask(run) {
  const current = new Map();
  const attempts = Array.isArray(run.workerAttempts) ? run.workerAttempts : [];
  for (const attempt of attempts) {
    const taskId = safeAgentId(attempt?.workerTaskId);
    if (!taskId) continue;
    const attemptNumber =
      Number.isSafeInteger(attempt.attemptNumber) && attempt.attemptNumber > 0
        ? attempt.attemptNumber
        : 0;
    const prior = current.get(taskId);
    const priorNumber =
      Number.isSafeInteger(prior?.attemptNumber) && prior.attemptNumber > 0
        ? prior.attemptNumber
        : 0;
    if (!prior || attemptNumber >= priorNumber) current.set(taskId, attempt);
  }
  return current;
}

function sanitizedAgentRow(run, task, attempt) {
  const runId = safeAgentId(run.id);
  const taskId = safeAgentId(task?.id ?? attempt?.workerTaskId);
  if (!runId || !taskId) return null;
  const attemptId = safeAgentId(attempt?.id);
  const attemptNumber =
    Number.isSafeInteger(attempt?.attemptNumber) && attempt.attemptNumber > 0
      ? attempt.attemptNumber
      : undefined;
  const row = {
    runId,
    runStatus: safeAgentEnum(run.status, AGENT_RUN_STATUSES),
    taskId,
    role: safeAgentEnum(task?.taskClass, AGENT_ROLES, "worker"),
    runtime: safeAgentEnum(attempt?.runtime ?? task?.runtimePreference, AGENT_RUNTIMES),
    taskStatus: safeAgentEnum(task?.status, AGENT_TASK_STATUSES),
  };
  if (attemptId) row.attemptId = attemptId;
  if (attemptNumber !== undefined) row.attemptNumber = attemptNumber;
  if (attempt) {
    row.attemptStatus = safeAgentEnum(attempt.status, AGENT_ATTEMPT_STATUSES);
    const runtimeState =
      typeof attempt.runtimeState === "string" && AGENT_RUNTIME_STATES.has(attempt.runtimeState)
        ? attempt.runtimeState
        : undefined;
    if (runtimeState) row.runtimeState = runtimeState;
  }
  return row;
}

function buildAgentOverview(flags, idOrPrefix) {
  const { runs, truncated: runsTruncated } = agentRunFiles(flags, idOrPrefix);
  const agents = [];
  let rowsTruncated = false;
  for (const run of runs) {
    const tasks = Array.isArray(run.workerTasks) ? run.workerTasks : [];
    const currentAttempts = currentAttemptByTask(run);
    const taskIds = new Set();
    for (const task of tasks) {
      const taskId = safeAgentId(task?.id);
      if (!taskId) continue;
      taskIds.add(taskId);
      const attempt = currentAttempts.get(taskId);
      const isActive =
        ACTIVE_AGENT_TASK_STATUSES.has(task.status) ||
        ACTIVE_AGENT_ATTEMPT_STATUSES.has(attempt?.status);
      // The fleet overview stays useful instead of replaying all history. A
      // selected run is the explicit deep view and includes each task's latest
      // attempt, including terminal tasks.
      if (!idOrPrefix && !isActive) continue;
      const row = sanitizedAgentRow(run, task, attempt);
      if (row) agents.push(row);
      if (agents.length > AGENT_ROWS_MAX) {
        agents.length = AGENT_ROWS_MAX;
        rowsTruncated = true;
        break;
      }
    }
    if (rowsTruncated) break;
    // Preserve visibility of an active/current attempt if an interrupted or
    // legacy run lost its WorkerTask record.
    for (const [taskId, attempt] of currentAttempts) {
      if (taskIds.has(taskId)) continue;
      if (!idOrPrefix && !ACTIVE_AGENT_ATTEMPT_STATUSES.has(attempt?.status)) continue;
      const row = sanitizedAgentRow(run, undefined, attempt);
      if (row) agents.push(row);
      if (agents.length > AGENT_ROWS_MAX) {
        agents.length = AGENT_ROWS_MAX;
        rowsTruncated = true;
        break;
      }
    }
    if (rowsTruncated) break;
  }
  return {
    schemaVersion: 1,
    scope: idOrPrefix ? "run" : "active",
    ...(idOrPrefix && runs[0] ? { runId: runs[0].id } : {}),
    agents,
    truncated: runsTruncated || rowsTruncated,
  };
}

function printAgentOverview(overview) {
  if (overview.agents.length === 0) {
    console.log(overview.scope === "active" ? "(no active worker agents)" : "(no worker agents)");
    if (overview.truncated) console.log("(results truncated by offline safety limits)");
    return;
  }
  console.log(
    `${"RUN".padEnd(22)} ${"TASK".padEnd(23)} ${"ROLE".padEnd(9)} ${"RUNTIME".padEnd(8)} ${"STATUS".padEnd(24)} TRY`,
  );
  for (const agent of overview.agents) {
    const status = agent.attemptStatus
      ? `${agent.taskStatus}/${agent.attemptStatus}`
      : agent.taskStatus;
    const live = agent.runtimeState ? `/${agent.runtimeState}` : "";
    console.log(
      `${agent.runId.slice(0, 20).padEnd(22)} ` +
        `${agent.taskId.slice(0, 21).padEnd(23)} ` +
        `${agent.role.padEnd(9)} ` +
        `${agent.runtime.padEnd(8)} ` +
        `${`${status}${live}`.slice(0, 24).padEnd(24)} ` +
        `${agent.attemptNumber ?? "-"}`,
    );
  }
  if (overview.truncated) console.log("(results truncated by offline safety limits)");
}

function authorLabel(author) {
  if (author === "spark") return "cora";
  if (author === "user") return "you";
  return author ?? "?";
}

function formatUptime(sec) {
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

const entrypoint =
  process.env[MANUAL_AGENT_WRAPPER_MODE_ENV] === "1"
    ? runManualAgentWrapper
    : main;
entrypoint().catch((err) => fail(err.message ?? String(err)));
