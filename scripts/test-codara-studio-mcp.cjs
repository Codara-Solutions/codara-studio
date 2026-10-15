#!/usr/bin/env node
// Smoke test for the merged codara-studio MCP server. Spawns the stdio server
// with a fabricated SPARK_HOME_DIR (so readHandshake has a target) and asserts
// the tools/list roster per SPARK_MCP_MODE. Zero deps; mirrors the style of the
// other scripts/test-*.cjs. Does NOT need Codara running — tools/list never
// dials the agent socket.

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");
const http = require("node:http");

const SERVER = path.join(__dirname, "..", "resources", "codara-studio-mcp", "server.js");

// A throwaway codara-home with a valid-looking handshake file (unused by
// tools/list, but keeps the server from complaining if a call slips through).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codara-studio-mcp-"));
fs.writeFileSync(
  path.join(HOME, "agent-socket.json"),
  JSON.stringify({ url: "http://127.0.0.1:1", token: "f".repeat(64) }),
);

// The browser tools ship from the modules in resources/codara-studio-mcp/tools/
// (test-mcp-tool-manifest.cjs checks their contract), so every roster below
// takes the browser list from that registry. These are the tools that must
// never disappear from it.
const CORE_PREVIEW_TOOLS = [
  "codara_preview_list",
  "codara_preview_navigate",
  "codara_preview_snapshot",
  "codara_preview_click",
  "codara_preview_type",
  "codara_preview_press_key",
  "codara_preview_evaluate",
  "codara_preview_wait_for",
  "codara_preview_screenshot",
  "codara_preview_mouse",
  "codara_preview_scroll",
  "codara_preview_hover",
  "codara_preview_drag",
  "codara_preview_key",
  "codara_preview_upload",
  "codara_preview_console",
  "codara_preview_network",
  "codara_preview_resize",
  "codara_preview_run",
];
const PREVIEW_TOOLS = require(path.join(__dirname, "..", "resources", "codara-studio-mcp", "tools", "index.cjs"))
  .toolRegistry()
  .tools.map((tool) => tool.name);
for (const name of CORE_PREVIEW_TOOLS) assert.ok(PREVIEW_TOOLS.includes(name), `${name} is missing from the browser tool modules`);
const TERMINAL_TOOLS = [
  "codara_terminal_run",
  "codara_terminal_create",
  "codara_terminal_write",
  "codara_terminal_read",
  "codara_terminal_list",
  "codara_terminal_close",
];
const WHITEBOARD_TOOLS = ["codara_whiteboard_get", "codara_whiteboard_update", "codara_whiteboard_arrange", "codara_whiteboard_inspect", "codara_whiteboard_review"];
const BOARD_TOOLS = ["codara_board_get", "codara_board_update"];
const WORKTREE_TOOLS = ["codara_worktree_create", "codara_worktree_list", "codara_worktree_remove"];
const WORKFLOW_TOOLS = [
  "codara_workflow_list",
  "codara_workflow_get",
  "codara_workflow_check",
  "codara_workflow_run",
  "codara_workflow_status",
  "codara_workflow_wait",
  "codara_workflow_stop",
  "codara_workflow_resume",
  "codara_workflow_save",
];
// A Cora chat (SPARK_RUN_ID set) also gets its whiteboard and board; a user's
// own terminal agent gets the explicit notification, the workspace status and
// the worktree tools instead.
const STUDIO_TOOLS = [...PREVIEW_TOOLS, ...TERMINAL_TOOLS, ...WHITEBOARD_TOOLS, ...BOARD_TOOLS];
const TERMINAL_STUDIO_TOOLS = [
  ...PREVIEW_TOOLS,
  ...TERMINAL_TOOLS,
  "codara_notify_user",
  "codara_workspace_status",
  ...WORKTREE_TOOLS,
];
const RUN = { SPARK_RUN_ID: "run-roster" };
// tools/list budgets in JSON characters. The studio list is what every Claude
// Code, Codex and Grok session pays for on every request. Each roster carries
// every tool module, so these move with TOOL_MODULES_BUDGET in
// test-mcp-tool-manifest.cjs (raised by 9,000 for the browser tools of the
// round that added the Chrome extension, audits and captures; the studio
// one by 300 for codara_workspace_status, whose guidance rides on initialize;
// execute by 1,000 for the automation precheck and missed-run fields, about 520).
const LIST_BUDGET = { studio: 29_300, run: 39_000, worker: 35_000, execute: 95_000, automation: 69_000 };
const EXECUTE_TOOLS = [
  "codara_spawn_terminals",
  "codara_spawn_workers",
  "codara_ask_user",
  "codara_complete",
  "codara_name_chat",
  "codara_plan_update",
  "codara_remember",
  "codara_recall",
  "codara_request_next_iteration",
  "codara_get_worker_status",
  "codara_wait_for_workers",
  "codara_message_workers",
  "codara_check_messages",
];
const AUTOMATION_TOOLS = [
  "codara_list_automations",
  "codara_get_automation",
  "codara_create_automation",
  "codara_update_automation",
  "codara_run_automation",
  "codara_wait_for_automation",
  "codara_set_automation_enabled",
  "codara_pause_automation",
  "codara_resume_automation",
  "codara_stop_automation",
  "codara_delete_automation",
  "codara_name_chat",
  "codara_ask_user",
];

// Drive one server process: send initialize + tools/list, resolve the tool
// names it reports plus the initialize result.
function listTools(mode, extraEnv = {}, initParams = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, SPARK_HOME_DIR: HOME };
    delete env.SPARK_RUN_ID;
    delete env.CODARA_HOME_DIR;
    Object.assign(env, extraEnv);
    if (mode) env.SPARK_MCP_MODE = mode;
    else delete env.SPARK_MCP_MODE;
    const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    let serverName = null;
    let init = null;
    let tools = null;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout waiting for tools/list (mode=${mode || "unset"})`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
      let idx;
      while ((idx = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, idx).trim();
        out = out.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.result) {
          init = msg.result;
          serverName = msg.result.serverInfo && msg.result.serverInfo.name;
        }
        if (msg.id === 2 && msg.result) {
          const definitions = msg.result.tools;
          tools = definitions.map((t) => t.name);
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          resolve({ serverName, init, tools, definitions, listChars: JSON.stringify(msg.result).length });
        }
      }
    });
    child.on("error", reject);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: initParams }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  });
}

// One stdio session for protocol-level checks: send lines, collect replies.
function stdioSession(extraEnv = {}) {
  const env = { ...process.env, SPARK_HOME_DIR: HOME };
  delete env.SPARK_RUN_ID;
  delete env.SPARK_MCP_MODE;
  delete env.CODARA_HOME_DIR;
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "inherit"] });
  const messages = [];
  const waiters = [];
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    out += chunk;
    let idx;
    while ((idx = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, idx).trim();
      out = out.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      messages.push(msg);
      for (const waiter of [...waiters]) {
        if (waiter.match(msg)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(msg);
        }
      }
    }
  });
  return {
    messages,
    send(msg) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    },
    next(match, timeoutMs = 10_000) {
      const found = messages.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
            reject(new Error("timed out waiting for a stdio message"));
          }
        }, timeoutMs);
      });
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

function sortedEqual(actual, expected, label) {
  const a = [...new Set(actual)].sort();
  const e = [...new Set(expected)].sort();
  assert.deepStrictEqual(a, e, `${label}\n  got:      ${a.join(", ")}\n  expected: ${e.join(", ")}`);
}

(async () => {
  let mockAgentSocket = null;
  const previousHome = process.env.CODARA_HOME_DIR;
  const previousRunId = process.env.SPARK_RUN_ID;
  const previousAgentSocket = process.env.SPARK_AGENT_SOCKET;
  const previousAgentToken = process.env.SPARK_AGENT_TOKEN;
  const previousAgentCapability = process.env.SPARK_AGENT_CAPABILITY;
  try {
    delete process.env.SPARK_AGENT_SOCKET;
    delete process.env.SPARK_AGENT_TOKEN;
    delete process.env.SPARK_AGENT_CAPABILITY;
    // Studio mode (unset): a terminal the user opened has no Cora chat, so
    // the whiteboard and board, which can only fail there, are not listed.
    const studio = await listTools(undefined, {}, { protocolVersion: "2025-06-18" });
    assert.strictEqual(studio.serverName, "codara-studio", "serverInfo.name must be codara-studio");
    sortedEqual(studio.tools, TERMINAL_STUDIO_TOOLS, "studio (unset SPARK_MCP_MODE) roster mismatch");
    assert.strictEqual(studio.init.protocolVersion, "2025-06-18", "initialize echoes a supported client version");
    assert.match(studio.init.instructions, /codara_terminal_run/, "initialize carries shared tool guidance");
    assert.match(studio.init.instructions, /codara_notify_user/);
    assert.match(studio.init.instructions, /codara_worktree_remove/, "a terminal agent learns the worktree lifecycle");
    assert.match(
      studio.init.instructions,
      /codara_workspace_status.*note at each milestone.*in_review or done when you finish.*blocked/,
      "a terminal agent learns to post milestones and its final status",
    );
    assert.match(studio.init.instructions, /Dev servers: .*codara_terminal_servers.*keeps them running when you exit or restart/, "dev servers go to the keeper, not the agent's own shell");
    assert.doesNotMatch(studio.init.instructions, /baseRevision/, "chat-only guidance stays out of a terminal session");
    assert.notStrictEqual(studio.init.serverInfo.version, "0.1.0", "serverInfo reports Codara's version");
    const legacyClient = await listTools(undefined, {}, { protocolVersion: "2024-11-05" });
    assert.strictEqual(legacyClient.init.protocolVersion, "2024-11-05");
    const futureClient = await listTools(undefined, {}, { protocolVersion: "2099-01-01" });
    assert.strictEqual(futureClient.init.protocolVersion, "2025-06-18", "an unknown version gets the newest supported one");

    // Studio mode (explicit "studio").
    const studio2 = await listTools("studio");
    sortedEqual(studio2.tools, TERMINAL_STUDIO_TOOLS, "studio ('studio') roster mismatch");

    // Studio tools inside a Cora chat.
    const runStudio = await listTools(undefined, RUN);
    sortedEqual(runStudio.tools, STUDIO_TOOLS, "studio roster inside a Cora chat mismatch");
    assert.match(runStudio.init.instructions, /baseRevision/);
    assert.doesNotMatch(runStudio.init.instructions, /codara_worktree/, "chat workers get no worktree guidance");
    assert.doesNotMatch(runStudio.init.instructions, /codara_workspace_status/, "chat workers leave the workspace status to their chat");

    // Execute mode. Carries the automation-management tools too (Cora creates
    // and manages looms from an ordinary auto/execute chat), minus
    // codara_name_chat, which the execute roster already owns and maps to
    // orchestrator.name_chat.
    const execute = await listTools("execute", RUN);
    sortedEqual(
      execute.tools,
      [
        ...STUDIO_TOOLS,
        ...EXECUTE_TOOLS,
        ...AUTOMATION_TOOLS.filter((name) => !EXECUTE_TOOLS.includes(name)),
        ...WORKTREE_TOOLS,
        ...WORKFLOW_TOOLS,
      ],
      "execute roster mismatch",
    );
    const askUser = execute.definitions.find((tool) => tool.name === "codara_ask_user");
    assert.ok(askUser, "execute roster must expose codara_ask_user");
    sortedEqual(
      askUser.inputSchema.required,
      ["question", "category", "reason"],
      "codara_ask_user required fields mismatch",
    );
    assert.deepStrictEqual(
      askUser.inputSchema.properties.category.enum,
      [
        "credentials_access",
        "destructive_irreversible",
        "safety_policy",
        "irreducible_product_scope",
        "plan_approval",
      ],
      "codara_ask_user category enum mismatch",
    );
    assert.ok(
      askUser.inputSchema.properties.recommendedOptionId,
      "codara_ask_user must expose recommendedOptionId",
    );
    const spawnTerminals = execute.definitions.find((tool) => tool.name === "codara_spawn_terminals");
    assert.deepStrictEqual(
      spawnTerminals?.inputSchema.properties.terminals.items.properties.runtime.enum,
      ["claude", "codex", "grok", "pi"],
      "codara_spawn_terminals must offer every agent the + menu opens",
    );
    const complete = execute.definitions.find((tool) => tool.name === "codara_complete");
    assert.match(
      complete?.description ?? "",
      /Never call it for greetings, conversation, explanations, advice, read-only questions/,
      "codara_complete must not instruct Auto conversations to enter execution completion",
    );
    const terminalCreate = execute.definitions.find(
      (tool) => tool.name === "codara_terminal_create",
    );
    assert.ok(terminalCreate, "execute roster must expose codara_terminal_create");
    assert.deepStrictEqual(
      terminalCreate.inputSchema.properties.retention?.enum,
      ["temporary", "service"],
      "terminal retention must be the closed temporary/service policy",
    );
    assert.equal(
      terminalCreate.inputSchema.required?.includes("retention") ?? false,
      false,
      "terminal retention must remain optional so legacy callers get temporary cleanup",
    );
    assert.match(
      `${terminalCreate.description} ${terminalCreate.inputSchema.properties.retention?.description}`,
      /temporary \(default\)[\s\S]*service/i,
      "terminal.create must document the temporary default and explicit service opt-in",
    );
    const terminalClose = execute.definitions.find(
      (tool) => tool.name === "codara_terminal_close",
    );
    assert.ok(terminalClose, "execute roster must expose codara_terminal_close");
    sortedEqual(
      terminalClose.inputSchema.required,
      ["paneId"],
      "codara_terminal_close required fields mismatch",
    );
    assert.match(
      terminalClose.description,
      /idempotent/,
      "codara_terminal_close must document retry safety",
    );
    assert.match(
      terminalClose.description,
      /another run's terminal/,
      "codara_terminal_close must document run ownership",
    );

    // codara_remember: the two axes a manager has to get right are which file it
    // writes to and whether it is appending or rewriting, so both are required
    // and both are closed enums. `bullets` is capped because a manager that
    // dumps a whole turn into memory blows the file cap in one call.
    const remember = execute.definitions.find((tool) => tool.name === "codara_remember");
    assert.ok(remember, "execute roster must expose codara_remember");
    sortedEqual(
      remember.inputSchema.required,
      ["scope", "action"],
      "codara_remember required fields mismatch",
    );
    assert.deepStrictEqual(
      remember.inputSchema.properties.scope.enum,
      ["workspace", "global"],
      "codara_remember scope enum mismatch",
    );
    assert.deepStrictEqual(
      remember.inputSchema.properties.action.enum,
      ["add", "replace"],
      "codara_remember action enum mismatch",
    );
    assert.strictEqual(
      remember.inputSchema.properties.bullets.maxItems,
      5,
      "codara_remember must cap bullets at 5 per call",
    );
    assert.ok(
      remember.inputSchema.properties.confirm_drop_user_lines,
      "codara_remember must expose confirm_drop_user_lines so a replace cannot silently eat the user's own lines",
    );
    // The description is the only place a manager learns what to do when the
    // file is full. Without it, "memory is full" reads as "skip the write".
    assert.match(
      remember.description,
      /action `replace`/,
      "codara_remember must tell the manager to consolidate with replace when the file is full",
    );
    // worker-prompt.ts renderWorkerMemorySection hands chat workers a
    // read-only copy and skips automation runs; the description must say so.
    assert.match(
      remember.description,
      /Workers in chat runs receive a read-only copy of this memory/,
      "codara_remember must say chat workers already receive memory",
    );
    assert.match(remember.description, /Automation workers do not see memory/);
    assert.doesNotMatch(remember.description, /do NOT see memory/);
    for (const name of ["codara_name_chat"]) {
      const tool = execute.definitions.find((candidate) => candidate.name === name);
      assert.doesNotMatch(tool.description, /Call this EARLY/, `${name} must not demand its own early round trip`);
    }

    const directMemory = await listTools("talk", { ...RUN, CODARA_PI_DIRECT_TASK: "1" });
    sortedEqual(directMemory.tools, [...STUDIO_TOOLS, "codara_remember", "codara_recall", ...WORKTREE_TOOLS], "direct Cora roster mismatch");
    const directDefinition = directMemory.definitions.find((tool) => tool.name === "codara_remember");
    assert.ok(!("runId" in directDefinition.inputSchema.properties), "direct memory cannot choose a different run");
    assert.ok(JSON.stringify(directDefinition).length < 1500, "direct memory keeps a compact tool schema");
    const untrustedDirect = await listTools("talk", { ...RUN, CODARA_PI_DIRECT_TASK: "1", CODARA_PI_PROJECT_POLICY: "untrusted-pull-request" });
    assert.ok(!untrustedDirect.tools.includes("codara_remember"), "untrusted PRs cannot write memory");
    assert.ok(!untrustedDirect.tools.includes("codara_recall"), "untrusted PRs cannot read memory");
    assert.ok(
      !untrustedDirect.tools.some((name) => name.startsWith("codara_worktree_")),
      "untrusted PRs cannot create or remove worktrees",
    );

    // Automation mode: memory is a manager-of-a-coding-run concept, an
    // automation loop has no user conversation to learn a durable fact from.
    const automation = await listTools("automation", RUN);
    sortedEqual(automation.tools, [...STUDIO_TOOLS, ...AUTOMATION_TOOLS], "automation roster mismatch");

    // Looms on Pi: the worker schema is model + effort only. No engine choice
    // exists anywhere in the automation surface.
    const createAutomation = automation.definitions.find(
      (tool) => tool.name === "codara_create_automation",
    );
    assert.ok(createAutomation, "automation roster must expose codara_create_automation");
    const workerSchema = createAutomation.inputSchema.properties.worker;
    sortedEqual(
      workerSchema.required,
      ["model", "effort"],
      "worker schema must require exactly model + effort",
    );
    assert.ok(
      !("engine" in workerSchema.properties),
      "worker schema must not expose an engine property",
    );
    sortedEqual(
      Object.keys(workerSchema.properties),
      ["model", "effort", "timeoutMinutes"],
      "worker schema property set mismatch",
    );
    assert.match(
      workerSchema.description,
      /run on Cora's Pi runtime/,
      "worker schema must state that automation workers run on Cora's Pi runtime",
    );
    for (const modelId of ["claude-opus-5", "claude-fable-5", "gpt-5.6-sol"]) {
      assert.ok(
        workerSchema.properties.model.description.includes(modelId),
        `worker model description must name ${modelId}`,
      );
    }
    assert.deepStrictEqual(
      workerSchema.properties.effort.enum,
      ["minimal", "low", "medium", "high", "xhigh", "max"],
      "worker effort ladder mismatch",
    );

    // Worker mode: workers must NOT be able to write memory. The manager is the
    // only writer, which is what makes "copy the line into the description"
    // load-bearing rather than a convenience.
    const worker = await listTools("worker", RUN);
    assert.ok(
      !worker.tools.includes("codara_remember"),
      "worker roster must not expose codara_remember",
    );
    assert.ok(
      !worker.tools.some((name) => name.startsWith("codara_worktree_")),
      "workers never manage worktrees",
    );
    // The agent-loop handoff steers by model only; nextEngine is gone.
    const nextIteration = worker.definitions.find(
      (tool) => tool.name === "codara_request_next_iteration",
    );
    assert.ok(nextIteration, "worker roster must expose codara_request_next_iteration");
    assert.ok(
      !("nextEngine" in nextIteration.inputSchema.properties),
      "codara_request_next_iteration must not expose nextEngine",
    );
    assert.ok(
      nextIteration.inputSchema.properties.nextModel,
      "codara_request_next_iteration must keep nextModel steering",
    );

    // Every roster stays inside its tools/list budget, every tool carries MCP
    // annotations, and no schema lets the model pick the chat.
    const rosters = { studio, run: runStudio, worker, execute, automation };
    for (const [label, roster] of Object.entries(rosters)) {
      assert.ok(
        roster.listChars <= LIST_BUDGET[label],
        `${label} tools/list is ${roster.listChars} chars, over its ${LIST_BUDGET[label]} budget`,
      );
      for (const tool of roster.definitions) {
        assert.ok(tool.annotations && typeof tool.annotations.title === "string", `${tool.name} has an annotation title`);
        assert.strictEqual(typeof tool.annotations.openWorldHint, "boolean", `${tool.name} declares openWorldHint`);
        assert.ok(
          tool.annotations.readOnlyHint === true || typeof tool.annotations.destructiveHint === "boolean",
          `${tool.name} is either read-only or declares destructiveHint`,
        );
        assert.ok(!("runId" in (tool.inputSchema.properties || {})), `${tool.name} must not expose runId`);
      }
    }
    const byName = (roster, name) => roster.definitions.find((tool) => tool.name === name);
    assert.strictEqual(byName(studio, "codara_terminal_read").annotations.readOnlyHint, true);
    assert.strictEqual(byName(studio, "codara_terminal_close").annotations.destructiveHint, true);
    assert.strictEqual(byName(studio, "codara_preview_navigate").annotations.openWorldHint, true);
    assert.strictEqual(byName(execute, "codara_delete_automation").annotations.destructiveHint, true);
    assert.strictEqual(byName(studio, "codara_worktree_list").annotations.readOnlyHint, true);
    assert.strictEqual(byName(studio, "codara_worktree_create").annotations.destructiveHint, false);
    assert.strictEqual(byName(studio, "codara_worktree_remove").annotations.destructiveHint, true);
    assert.strictEqual(byName(studio, "codara_worktree_remove").annotations.idempotentHint, true);
    for (const name of WORKTREE_TOOLS) {
      const properties = byName(studio, name).inputSchema.properties;
      for (const field of ["repo", "repoCwd", "cwd", "callerRole", "callerClient", "callerPaneId", "force"]) {
        assert.ok(!(field in properties), `${name} must not let the model choose ${field}`);
      }
    }
    // Worktree calls may fetch and wait for the repository lock; the client
    // deadline sits above both.
    const serverSource = fs.readFileSync(SERVER, "utf8");
    const worktreeTimeout = Number(/const WORKTREE_TIMEOUT_MS = ([\d_]+);/.exec(serverSource)[1].replace(/_/g, ""));
    assert.ok(worktreeTimeout >= 120_000, "worktree calls get a long client timeout");
    assert.match(serverSource, /rpc\.startsWith\("worktree\."\)\) return WORKTREE_TIMEOUT_MS/);
    // It marks the returned messages read, so a client must not treat it as a
    // side-effect-free call it may repeat or run in parallel.
    assert.notStrictEqual(byName(execute, "codara_check_messages").annotations.readOnlyHint, true);
    // Tools that run an arbitrary command or script must never tell a client
    // they are safe to auto-approve.
    for (const name of [
      "codara_terminal_run",
      "codara_terminal_create",
      "codara_terminal_write",
      "codara_preview_evaluate",
      "codara_preview_run",
    ]) {
      assert.strictEqual(byName(studio, name).annotations.destructiveHint, true, `${name} is destructive`);
    }
    assert.strictEqual(byName(execute, "codara_spawn_terminals").annotations.destructiveHint, true);
    assert.deepStrictEqual(byName(studio, "codara_terminal_read").inputSchema.properties.mode.enum, ["text", "screen"]);
    assert.match(byName(studio, "codara_terminal_read").inputSchema.properties.lines.description, /default 200/);
    assert.ok(
      byName(studio, "codara_preview_wait_for").inputSchema.properties.timeoutMs.maximum < 60_000,
      "a browser wait must end before the 60 s client timeout",
    );
    // codara_update_automation refers to the create schema instead of repeating it.
    assert.ok(JSON.stringify(byName(execute, "codara_update_automation")).length < 2_500);

    // Protocol errors carry the request id and the JSON-RPC code.
    const session = stdioSession();
    session.send({ id: 7, method: "resources/list", params: {} });
    const unknownMethod = await session.next((msg) => msg.id === 7);
    assert.strictEqual(unknownMethod.error.code, -32601, "unknown method is -32601");
    session.send({ id: "t1", method: "tools/call", params: { name: "codara_nope", arguments: {} } });
    const unknownTool = await session.next((msg) => msg.id === "t1");
    assert.strictEqual(unknownTool.error.code, -32602, "unknown tool is -32602");
    session.close();

    // The JSON schema hides runId, but the bridge must also treat the
    // launch-time env stamp as authoritative. callToolByName is used by Pi and
    // can be invoked directly, so discard a spoofed argument before it reaches
    // the shared local socket.
    const received = [];
    const receivedAuthorization = [];
    let mockResult = { ok: true };
    let mockError = null;
    let mockStatus = 200;
    const heldRequests = [];
    let mockHangs = false;
    let hungUpRequests = 0;
    mockAgentSocket = http.createServer((req, res) => {
      receivedAuthorization.push(req.headers.authorization);
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        received.push(parsed);
        if (mockHangs) {
          res.on("close", () => { hungUpRequests += 1; });
          return;
        }
        // A long poll the test cancels: never answered, closed by the client.
        if (parsed.method === "orchestrator.wait_for_workers") {
          const held = { closed: false };
          res.on("close", () => { held.closed = true; });
          heldRequests.push(held);
          return;
        }
        res.writeHead(mockStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(
          mockStatus !== 200
            ? { error: "unauthorized" }
            : mockError
              ? { jsonrpc: "2.0", id: 1, error: mockError }
              : { jsonrpc: "2.0", id: 1, result: mockResult },
        ));
      });
    });
    await new Promise((resolve, reject) => {
      mockAgentSocket.once("error", reject);
      mockAgentSocket.listen(0, "127.0.0.1", resolve);
    });
    const address = mockAgentSocket.address();
    fs.writeFileSync(
      path.join(HOME, "agent-socket.json"),
      JSON.stringify({
        url: `http://127.0.0.1:${address.port}`,
        token: "f".repeat(64),
      }),
    );
    process.env.CODARA_HOME_DIR = HOME;
    process.env.SPARK_RUN_ID = "run-trusted";
    delete require.cache[require.resolve(SERVER)];
    const directBridge = require(SERVER);
    process.env.SPARK_AGENT_CAPABILITY = "scoped";
    process.env.SPARK_AGENT_SOCKET = `http://127.0.0.1:${address.port}`;
    process.env.SPARK_AGENT_TOKEN = "a".repeat(64);
    const scopedCall = await directBridge.callToolByName("codara_terminal_read", {
      paneId: "pane-owned",
    });
    assert.notStrictEqual(scopedCall.isError, true);
    assert.strictEqual(
      receivedAuthorization.at(-1),
      `Bearer ${"a".repeat(64)}`,
      "a process-scoped token must take precedence over the root handshake",
    );
    delete process.env.SPARK_AGENT_TOKEN;
    const partialScopedCall = await directBridge.callToolByName(
      "codara_terminal_read",
      { paneId: "pane-owned" },
    );
    assert.strictEqual(partialScopedCall.isError, true);
    assert.match(
      partialScopedCall.content[0].text,
      /scoped agent capability is unavailable/i,
      "a partial scoped environment must fail closed instead of reading the root handshake",
    );
    delete process.env.SPARK_AGENT_SOCKET;
    const missingScopedCall = await directBridge.callToolByName(
      "codara_terminal_read",
      { paneId: "pane-owned" },
    );
    assert.strictEqual(missingScopedCall.isError, true);
    assert.match(
      missingScopedCall.content[0].text,
      /scoped agent capability is unavailable/i,
      "a scoped marker with zero credential variables must never fall back to root",
    );

    process.env.SPARK_AGENT_CAPABILITY = "future-capability";
    const unknownCapabilityCall = await directBridge.callToolByName(
      "codara_terminal_read",
      { paneId: "pane-owned" },
    );
    assert.strictEqual(unknownCapabilityCall.isError, true);
    assert.match(
      unknownCapabilityCall.content[0].text,
      /capability marker is unsupported/i,
      "an unknown nonempty capability marker must fail closed",
    );

    // Trusted/global children inherit process-lifetime PTY credentials. The
    // mode-600 handshake is the rotating authority, so it must win without a
    // scoped marker and be re-read after an app restart writes a new token.
    delete process.env.SPARK_AGENT_CAPABILITY;
    process.env.SPARK_AGENT_SOCKET = `http://127.0.0.1:${address.port}`;
    process.env.SPARK_AGENT_TOKEN = "a".repeat(64);
    const trustedCall = await directBridge.callToolByName(
      "codara_terminal_read",
      { paneId: "pane-owned" },
    );
    assert.notStrictEqual(trustedCall.isError, true);
    assert.strictEqual(
      receivedAuthorization.at(-1),
      `Bearer ${"f".repeat(64)}`,
      "an unmarked trusted caller must prefer the current handshake over inherited credentials",
    );
    fs.writeFileSync(
      path.join(HOME, "agent-socket.json"),
      JSON.stringify({
        url: `http://127.0.0.1:${address.port}`,
        token: "b".repeat(64),
      }),
    );
    const rotatedTrustedCall = await directBridge.callToolByName(
      "codara_terminal_read",
      { paneId: "pane-owned" },
    );
    assert.notStrictEqual(rotatedTrustedCall.isError, true);
    assert.strictEqual(
      receivedAuthorization.at(-1),
      `Bearer ${"b".repeat(64)}`,
      "an unmarked trusted caller must adopt a rewritten handshake on its next call",
    );

    // An interrupted Cora turn aborts its waits: the call returns at once and
    // hangs up, so the main process stops polling for a caller that is gone.
    mockHangs = true;
    const waitAbort = new AbortController();
    const receivedBeforeAbort = received.length;
    const abortedWait = directBridge.callToolByName(
      "codara_terminal_read",
      { paneId: "pane-owned" },
      waitAbort.signal,
    );
    for (let tries = 0; received.length === receivedBeforeAbort && tries < 200; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    waitAbort.abort();
    const abortedWaitResult = await abortedWait;
    assert.strictEqual(abortedWaitResult.isError, true, "an aborted wait reports a failed call");
    assert.match(abortedWaitResult.content[0].text, /Cancelled/);
    for (let tries = 0; hungUpRequests === 0 && tries < 200; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.strictEqual(hungUpRequests, 1, "an aborted wait hangs up its socket request");
    mockHangs = false;

    // Panes no longer carry the root token, so the handshake file is a
    // trusted caller's only source. While Codara starts, the file lands just
    // after the socket listens: a call in that moment waits for it, and an
    // inherited env token is never used, even when the file never appears.
    const handshakePath = path.join(HOME, "agent-socket.json");
    const handshakeBody = JSON.stringify({
      url: `http://127.0.0.1:${address.port}`,
      token: "d".repeat(64),
    });
    fs.rmSync(handshakePath, { force: true });
    const callsBeforeWait = receivedAuthorization.length;
    const landing = setTimeout(() => fs.writeFileSync(handshakePath, handshakeBody), 400);
    const waitedCall = await directBridge.callToolByName(
      "codara_terminal_read",
      { paneId: "pane-owned" },
    );
    clearTimeout(landing);
    assert.notStrictEqual(waitedCall.isError, true, "a call in the startup window waits for the handshake");
    assert.deepStrictEqual(
      receivedAuthorization.slice(callsBeforeWait),
      [`Bearer ${"d".repeat(64)}`],
      "the waiting call must use the handshake token, never the inherited one",
    );
    fs.rmSync(handshakePath, { force: true });
    const callsBeforeOffline = receivedAuthorization.length;
    const offlineStartedAt = Date.now();
    const offlineCall = await directBridge.callToolByName(
      "codara_terminal_read",
      { paneId: "pane-owned" },
    );
    assert.strictEqual(offlineCall.isError, true);
    assert.match(offlineCall.content[0].text, /appears to be offline/i);
    assert.ok(Date.now() - offlineStartedAt < 10_000, "the wait for a missing handshake is bounded");
    assert.strictEqual(
      receivedAuthorization.length,
      callsBeforeOffline,
      "a trusted caller must not fall back to an inherited root token",
    );
    fs.writeFileSync(handshakePath, handshakeBody);
    delete process.env.SPARK_AGENT_SOCKET;
    delete process.env.SPARK_AGENT_TOKEN;

    process.env.CODARA_PI_DIRECT_TASK = "1";
    delete require.cache[require.resolve(SERVER)];
    const directMemoryBridge = require(SERVER);
    // A runId the model supplies is refused before anything reaches the
    // socket: the launch-time stamp is the only route to a chat.
    const callsBeforeSpoof = received.length;
    for (const [tool, args] of [
      ["codara_preview_snapshot", { runId: "run-spoofed" }],
      ["codara_remember", { scope: "workspace", action: "add", bullets: ["x"], runId: "run-spoofed" }],
      ["codara_terminal_close", { paneId: "pane-owned", runId: "run-spoofed" }],
      ["codara_terminal_write", { paneId: "pane-owned", text: "pwd", runId: "run-spoofed" }],
      ["codara_whiteboard_get", { runId: "run-spoofed" }],
    ]) {
      const refused = await directMemoryBridge.callToolByName(tool, args);
      assert.strictEqual(refused.isError, true, `${tool} refuses a foreign runId`);
      assert.match(refused.content[0].text, /does not accept runId/);
    }
    const spoofedBatch = await directMemoryBridge.callToolByName("codara_preview_run", {
      steps: [{ action: "navigate", url: "https://example.test", runId: "run-spoofed" }],
    });
    assert.strictEqual(spoofedBatch.isError, true);
    assert.strictEqual(received.length, callsBeforeSpoof, "a refused runId never reaches the socket");
    // Repeating the session's own run id is harmless.
    await directMemoryBridge.callToolByName("codara_preview_snapshot", { runId: "run-trusted", workspaceId: "unrelated" });
    assert.equal(received.at(-1).params.runId, "run-trusted", "browser observations use the calling run");
    assert.equal(received.at(-1).params.workspaceId, undefined, "browser workspace is resolved from the run");
    assert.equal(received.at(-1).params.callerPid, undefined, "a run's browser is scoped by the run, not a pane");
    await directMemoryBridge.callToolByName("codara_preview_run", { steps: [
      { action: "navigate", url: "https://example.test", workspaceId: "unrelated" },
    ] });
    assert.equal(received.at(-1).params.runId, "run-trusted", "batched browser actions use the same owner");
    assert.equal(received.at(-1).params.workspaceId, undefined);
    await directMemoryBridge.callToolByName("codara_remember", { scope: "workspace", action: "add", bullets: ["Verified build fact"] });
    assert.strictEqual(received.at(-1).method, "orchestrator.remember");
    assert.strictEqual(received.at(-1).params.runId, "run-trusted", "direct memory stays in the calling workspace/profile");
    delete process.env.CODARA_PI_DIRECT_TASK;

    await directBridge.callToolByName("codara_terminal_close", { paneId: "pane-owned" });
    assert.strictEqual(received.at(-1).method, "terminal.close");
    assert.strictEqual(
      received.at(-1).params.runId,
      "run-trusted",
      "terminal.close must use the trusted launch-time run identity",
    );
    await directBridge.callToolByName("codara_terminal_create", {
      cwd: HOME,
      retention: "service",
    });
    assert.strictEqual(
      received.at(-1).params.runId,
      "run-trusted",
      "terminal.create must record the same trusted run identity used by close",
    );
    assert.strictEqual(
      received.at(-1).params.retention,
      "service",
      "terminal.create must forward the schema-validated retention policy",
    );
    // Placement follows the process the agent runs in, never tool JSON.
    const previousPaneId = process.env.SPARK_AGENT_PANE_ID;
    process.env.SPARK_AGENT_PANE_ID = "pane-caller";
    await directBridge.callToolByName("codara_terminal_create", {
      cwd: HOME,
      callerPaneId: "pane-spoofed",
      callerPid: 1,
    });
    assert.strictEqual(received.at(-1).params.callerPaneId, "pane-caller");
    assert.strictEqual(received.at(-1).params.callerPid, process.pid);
    delete process.env.SPARK_AGENT_PANE_ID;
    const previousLegacyPaneId = process.env.SPARK_PANE_ID;
    delete process.env.SPARK_PANE_ID;
    await directBridge.callToolByName("codara_terminal_create", { cwd: HOME, callerPaneId: "pane-spoofed" });
    assert.strictEqual(
      received.at(-1).params.callerPaneId,
      undefined,
      "a CLI that cleared the environment sends only its pid",
    );
    assert.strictEqual(received.at(-1).params.callerPid, process.pid);
    await directBridge.callToolByName("codara_terminal_write", {
      paneId: "pane-owned",
      text: "npm test",
    });
    assert.strictEqual(received.at(-1).method, "terminal.write");
    assert.strictEqual(
      received.at(-1).params.runId,
      "run-trusted",
      "terminal.write must use the trusted launch-time run identity",
    );
    await directBridge.callToolByName("codara_terminal_run", { command: "npm test", timeoutMs: 5_000 });
    assert.strictEqual(received.at(-1).method, "terminal.run");
    assert.strictEqual(received.at(-1).params.runId, "run-trusted");
    assert.strictEqual(received.at(-1).params.callerPid, process.pid, "a new run terminal opens beside the caller");
    delete process.env.SPARK_RUN_ID;
    await directBridge.callToolByName("codara_terminal_close", { paneId: "pane-null-scoped" });
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(received.at(-1).params, "runId"),
      false,
      "a null-scoped terminal caller carries no run id",
    );
    const nullScopedSpoof = await directBridge.callToolByName("codara_terminal_write", {
      paneId: "pane-null-scoped",
      text: "pwd",
      runId: "run-spoofed",
    });
    assert.strictEqual(nullScopedSpoof.isError, true, "a null-scoped caller cannot name a run");
    assert.match(nullScopedSpoof.content[0].text, /not part of a Cora chat/);
    // Outside a chat the browser, the terminal list and notifications follow
    // the pane the agent runs in, never the workspace on screen.
    process.env.SPARK_AGENT_PANE_ID = "pane-caller";
    for (const [tool, rpc, args] of [
      ["codara_preview_snapshot", "preview.snapshot", {}],
      ["codara_terminal_list", "terminal.list", {}],
    ]) {
      await directBridge.callToolByName(tool, args);
      assert.strictEqual(received.at(-1).method, rpc);
      assert.strictEqual(received.at(-1).params.callerPaneId, "pane-caller", `${tool} names the caller's pane`);
      assert.strictEqual(received.at(-1).params.callerPid, process.pid);
    }
    const noChat = await directBridge.callToolByName("codara_whiteboard_get", {});
    assert.strictEqual(noChat.isError, true);
    assert.match(noChat.content[0].text, /only works inside a Cora chat/);
    delete require.cache[require.resolve(SERVER)];
    const terminalAgentBridge = require(SERVER);
    assert.ok(
      terminalAgentBridge.listTools().some((tool) => tool.name === "codara_notify_user"),
      "a terminal agent can notify the user",
    );
    await terminalAgentBridge.callToolByName("codara_notify_user", { kind: "done", message: "Tests pass." });
    assert.strictEqual(received.at(-1).method, "agent.notify");
    assert.strictEqual(received.at(-1).params.callerPaneId, "pane-caller");
    assert.strictEqual(received.at(-1).params.kind, "done");
    // The workspace status follows the caller's pane as well: a workspace or
    // client the call names is never the one used.
    await terminalAgentBridge.callToolByName("codara_workspace_status", {
      status: "in_review",
      note: "PR open",
      workspaceId: "ws-other",
      callerClient: "spoofed",
      callerPaneId: "pane-spoofed",
    });
    assert.strictEqual(received.at(-1).method, "workspace.status");
    assert.strictEqual(received.at(-1).params.callerPaneId, "pane-caller");
    assert.strictEqual(received.at(-1).params.callerPid, process.pid);
    assert.strictEqual(received.at(-1).params.callerClient, "cora");
    assert.strictEqual(received.at(-1).params.status, "in_review");
    assert.ok(!("workspaceId" in received.at(-1).params), "the tool never names a workspace");
    assert.ok(!("runId" in received.at(-1).params), "a terminal agent's status call names no run");
    // Worktree calls carry who is asking from the launch environment only:
    // spoofed caller fields are replaced, and a refusal reaches the model as
    // an error result that keeps its code, blockers and hint.
    await terminalAgentBridge.callToolByName("codara_worktree_list", {
      callerRole: "manager",
      callerClient: "spoofed",
      callerPaneId: "pane-spoofed",
      callerPid: 1,
    });
    assert.strictEqual(received.at(-1).method, "worktree.list");
    assert.strictEqual(received.at(-1).params.callerRole, "studio");
    assert.strictEqual(received.at(-1).params.callerClient, "cora");
    assert.strictEqual(received.at(-1).params.callerPaneId, "pane-caller");
    assert.strictEqual(received.at(-1).params.callerPid, process.pid);
    assert.ok(!("runId" in received.at(-1).params), "a terminal agent's worktree call names no run");
    mockResult = {
      ok: false,
      code: "WORKTREE_NOT_MERGED",
      error: "'agent/x' has 2 commits not in origin/main",
      hint: "push and merge it (PR), or ask the user to delete it from the workspace rail",
      blockers: ["WORKTREE_NOT_MERGED"],
    };
    const refusedRemoval = await terminalAgentBridge.callToolByName("codara_worktree_remove", { workspaceId: "ws-1" });
    assert.strictEqual(received.at(-1).method, "worktree.remove");
    assert.strictEqual(refusedRemoval.isError, true, "a worktree refusal is a tool error");
    assert.deepStrictEqual(JSON.parse(refusedRemoval.content[0].text), mockResult, "the refusal keeps every field");
    mockResult = { ok: true };
    const worktreeRunSpoof = await terminalAgentBridge.callToolByName("codara_worktree_create", { runId: "run-spoofed" });
    assert.strictEqual(worktreeRunSpoof.isError, true, "a worktree call cannot name a run");
    // The retired codara_preview_url stays callable for agents that know it.
    await terminalAgentBridge.callToolByName("codara_preview_url", {});
    assert.strictEqual(received.at(-1).method, "preview.url");
    delete process.env.SPARK_AGENT_PANE_ID;
    if (previousPaneId !== undefined) process.env.SPARK_AGENT_PANE_ID = previousPaneId;
    if (previousLegacyPaneId !== undefined) process.env.SPARK_PANE_ID = previousLegacyPaneId;
    // Implicit preview tab picking in the renderer is scoped to the calling
    // run, so EVERY preview op must carry the run stamp — not just navigate.
    process.env.SPARK_RUN_ID = "run-trusted";
    for (const [tool, rpc] of [
      ["codara_preview_navigate", "preview.navigate"],
      ["codara_preview_snapshot", "preview.snapshot"],
      ["codara_preview_resize", "preview.resize"],
      ["codara_preview_scroll", "preview.scroll"],
    ]) {
      await directBridge.callToolByName(tool, {
        url: "http://127.0.0.1:4173/",
        width: 800,
        height: 600,
      });
      assert.strictEqual(received.at(-1).method, rpc);
      assert.strictEqual(
        received.at(-1).params.runId,
        "run-trusted",
        `${tool} must stamp the calling run id so tab picking stays run-scoped`,
      );
    }
    delete process.env.SPARK_RUN_ID;
    // An agent with no run is scoped by the pane it runs in, so its browser
    // calls name that pane (from the environment, never tool JSON) and its pid.
    const previousPreviewPaneId = process.env.SPARK_AGENT_PANE_ID;
    process.env.SPARK_AGENT_PANE_ID = "pane-browser-caller";
    for (const [tool, rpc] of [
      ["codara_preview_navigate", "preview.navigate"],
      ["codara_preview_snapshot", "preview.snapshot"],
      ["codara_preview_scroll", "preview.scroll"],
    ]) {
      await directBridge.callToolByName(tool, {
        url: "http://127.0.0.1:4173/",
        callerPaneId: "pane-spoofed",
        callerPid: 1,
        workspaceId: "ws-spoofed",
      });
      assert.strictEqual(received.at(-1).method, rpc);
      assert.strictEqual(received.at(-1).params.callerPaneId, "pane-browser-caller", `${tool} names the agent's pane`);
      assert.strictEqual(received.at(-1).params.callerPid, process.pid);
      assert.strictEqual(received.at(-1).params.workspaceId, undefined);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(received.at(-1).params, "runId"), false);
    }
    if (previousPreviewPaneId !== undefined) process.env.SPARK_AGENT_PANE_ID = previousPreviewPaneId;
    else delete process.env.SPARK_AGENT_PANE_ID;

    const batch = await directBridge.callToolByName("codara_preview_run", {
      steps: [{ action: "navigate", url: "http://127.0.0.1:4173/" }],
    });
    assert.strictEqual(batch.isError, false, "the preview batch run-id helper must remain wired");
    assert.strictEqual(received.at(-1).method, "preview.navigate");

    const geometry = { url: "http://127.0.0.1:4173/", path: "/codara/workspace-data/ws/browser/screenshots/shot.png", viewport: { width: 600, height: 400 }, imageSize: { width: 1200, height: 800 }, scale: { x: 2, y: 2 } };
    mockResult = { ...geometry, dataUrl: "data:image/png;base64,cGl4ZWxz" };
    const screenshot = await directBridge.callToolByName("codara_preview_screenshot", {});
    assert.strictEqual(screenshot.content[0].type, "image");
    assert.deepStrictEqual(JSON.parse(screenshot.content[1].text), geometry);
    const screenshotBatch = await directBridge.callToolByName("codara_preview_run", { steps: [{ action: "screenshot" }] });
    assert.strictEqual(screenshotBatch.content[0].type, "image");
    assert.deepStrictEqual(JSON.parse(screenshotBatch.content[1].text).steps[0].result, { ...geometry, captured: true });
    // A browser tool's image result keeps every field but the image, so a
    // tool module can add one (a diff's regions) without editing this server.
    mockResult = { ...geometry, dataUrl: "data:image/jpeg;base64,cGl4ZWxz", region: { x: 0, y: 0, width: 600, height: 400 }, changed: [{ x: 1, y: 2 }] };
    const extended = await directBridge.callToolByName("codara_preview_screenshot", {});
    assert.strictEqual(extended.content[0].mimeType, "image/jpeg");
    assert.deepStrictEqual(JSON.parse(extended.content[1].text), { ...geometry, region: mockResult.region, changed: mockResult.changed });
    const imageStep = await directBridge.callToolByName("codara_preview_run", { steps: [{ action: "snapshot" }] });
    assert.strictEqual(imageStep.content[0].type, "image", "any step's image goes out as image content, never as text");
    assert.doesNotMatch(imageStep.content[1].text, /cGl4ZWxz/);

    mockResult = { dataUrl: "data:image/png;base64,cGl4ZWxz", revision: 4, imageSize: { width: 900, height: 600 }, nodeIds: ["entry"], issues: [{ code: "missing-source" }], detailNeeded: false };
    process.env.SPARK_RUN_ID = "run-map";
    const whiteboardImage = await directBridge.callToolByName("codara_whiteboard_inspect", { baseRevision: 4 });
    delete process.env.SPARK_RUN_ID;
    assert.strictEqual(received.at(-1).method, "orchestrator.whiteboard_inspect");
    assert.strictEqual(received.at(-1).params.runId, "run-map");
    assert.strictEqual(whiteboardImage.content[0].type, "image");
    assert.strictEqual(JSON.parse(whiteboardImage.content[1].text).revision, 4);
    assert.deepStrictEqual(JSON.parse(whiteboardImage.content[1].text).issues, [{ code: "missing-source" }]);
    mockResult = { dataUrl: "data:image/png;base64,cGl4ZWxz", revision: 5, layout: { nodes: ["large"] } };
    process.env.SPARK_RUN_ID = "run-map";
    const listedOnly = await directBridge.callToolByName("codara_whiteboard_inspect", { baseRevision: 5 });
    delete process.env.SPARK_RUN_ID;
    assert.deepStrictEqual(JSON.parse(listedOnly.content[1].text), { url: null, revision: 5 }, "other image results keep only the listed fields");

    mockResult = { ok: false, error: "selector did not become visible" };
    const failedSingle = await directBridge.callToolByName("codara_preview_wait_for", { selector: "#missing" });
    assert.strictEqual(failedSingle.isError, true, "DOM failures must become tool errors");
    const beforeBatch = received.length;
    const failedBatch = await directBridge.callToolByName("codara_preview_run", {
      steps: [{ action: "wait_for", selector: "#missing" }, { action: "click", selector: "#submit" }],
    });
    assert.strictEqual(failedBatch.isError, true);
    assert.strictEqual(received.length - beforeBatch, 1, "a failed wait must prevent the following mutation");
    assert.match(failedBatch.content[0].text, /selector did not become visible/);
    const continuedBatch = await directBridge.callToolByName("codara_preview_run", {
      continueOnError: true,
      steps: [{ action: "wait_for", selector: "#missing" }, { action: "snapshot" }],
    });
    assert.strictEqual(continuedBatch.isError, true);
    assert.strictEqual(JSON.parse(continuedBatch.content[0].text).ran, 2);
    mockResult = { ok: true };

    // Socket error codes reach the agent with a readable label.
    mockError = { code: -32003, message: "this capability is unavailable to the calling agent process" };
    const forbidden = await directBridge.callToolByName("codara_terminal_read", { paneId: "pane-owned" });
    assert.strictEqual(forbidden.isError, true);
    assert.match(forbidden.content[0].text, /Codara error -32003: not allowed for this agent/);
    mockError = null;

    // Results are compact JSON.
    mockResult = { ok: true, nested: { a: 1 } };
    const compact = await directBridge.callToolByName("codara_terminal_read", { paneId: "pane-owned" });
    assert.strictEqual(compact.content[0].text, JSON.stringify(mockResult), "results are not pretty-printed");
    mockResult = { ok: true };

    // An oversized payload is refused with a reason before it is sent; the
    // board and whiteboard writes get the larger cap the socket allows them.
    const beforeOversize = received.length;
    const oversized = await directBridge.callToolByName("codara_preview_evaluate", { code: "x".repeat(70 * 1024) });
    assert.strictEqual(oversized.isError, true);
    assert.match(oversized.content[0].text, /Request too large: \d+ KB is over the 64 KB limit/);
    assert.strictEqual(received.length, beforeOversize, "an oversized request never reaches the socket");
    process.env.SPARK_RUN_ID = "run-trusted";
    const bigBoard = await directBridge.callToolByName("codara_board_update", {
      baseRevision: 1,
      cards: Array.from({ length: 200 }, (_, index) => ({
        id: `card-${index}`, title: "Card", status: "idea", order: index, description: "d".repeat(400),
      })),
    });
    delete process.env.SPARK_RUN_ID;
    assert.notStrictEqual(bigBoard.isError, true, "a board write over 64 KB is still delivered");
    assert.strictEqual(received.at(-1).method, "orchestrator.board_update");

    // A stale token reads as Codara having restarted, not as a raw 401.
    mockStatus = 401;
    const staleToken = await directBridge.callToolByName("codara_terminal_read", { paneId: "pane-owned" });
    mockStatus = 200;
    assert.strictEqual(staleToken.isError, true);
    assert.match(staleToken.content[0].text, /rejected this session's credentials/);

    // A crashed app leaves its handshake behind: a dead pid or a refused
    // connection is reported as offline, and once Codara is known to be
    // closed, calls stop waiting for it to start.
    const liveHandshake = fs.readFileSync(handshakePath, "utf8");
    const deadPid = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      child.on("exit", () => resolve(child.pid));
    });
    fs.writeFileSync(handshakePath, JSON.stringify({ ...JSON.parse(liveHandshake), pid: deadPid }));
    const staleStartedAt = Date.now();
    const stalePid = await directBridge.callToolByName("codara_terminal_read", { paneId: "pane-owned" });
    assert.strictEqual(stalePid.isError, true);
    assert.match(stalePid.content[0].text, new RegExp(`appears to be offline.*stale handshake from pid ${deadPid}`));
    assert.ok(Date.now() - staleStartedAt < 10_000);
    const fastStartedAt = Date.now();
    const fastOffline = await directBridge.callToolByName("codara_terminal_read", { paneId: "pane-owned" });
    assert.strictEqual(fastOffline.isError, true);
    assert.ok(Date.now() - fastStartedAt < 1_000, "a repeat call while Codara is closed fails at once");
    // The studio roster also loads in agents started outside Codara; a
    // notification Codara cannot show is not a failure of the agent's task.
    const offlineNotify = await terminalAgentBridge.callToolByName("codara_notify_user", { kind: "done" });
    assert.notStrictEqual(offlineNotify.isError, true, "an offline notification is not a tool error");
    assert.deepStrictEqual(JSON.parse(offlineNotify.content[0].text), { published: false, reason: "codara_offline" });
    const offlineStatus = await terminalAgentBridge.callToolByName("codara_workspace_status", { note: "Tests pass" });
    assert.notStrictEqual(offlineStatus.isError, true, "a status Codara cannot show is not a tool error");
    assert.deepStrictEqual(JSON.parse(offlineStatus.content[0].text), { updated: false, reason: "codara_offline" });
    fs.writeFileSync(handshakePath, JSON.stringify({ url: "http://127.0.0.1:1", token: "f".repeat(64) }));
    const refused = await directBridge.callToolByName("codara_terminal_read", { paneId: "pane-owned" });
    assert.match(refused.content[0].text, /appears to be offline: nothing is listening/);
    fs.writeFileSync(handshakePath, liveHandshake);
    const backOnline = await directBridge.callToolByName("codara_terminal_read", { paneId: "pane-owned" });
    assert.notStrictEqual(backOnline.isError, true, "an app that came back is used at once");

    // Over stdio: a cancelled long poll aborts its HTTP request and gets no
    // reply, and a batch with a progressToken reports each step.
    const executeSession = stdioSession({ SPARK_MCP_MODE: "execute", SPARK_RUN_ID: "run-stdio" });
    executeSession.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await executeSession.next((msg) => msg.id === 1);
    const heldBefore = heldRequests.length;
    executeSession.send({
      id: 9,
      method: "tools/call",
      params: { name: "codara_wait_for_workers", arguments: { worker_task_ids: ["task-1"] } },
    });
    for (let attempt = 0; attempt < 100 && heldRequests.length === heldBefore; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.strictEqual(heldRequests.length, heldBefore + 1, "the long poll reached the socket");
    executeSession.send({ method: "notifications/cancelled", params: { requestId: 9, reason: "user pressed Esc" } });
    for (let attempt = 0; attempt < 100 && !heldRequests.at(-1).closed; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.strictEqual(heldRequests.at(-1).closed, true, "cancelling closes the HTTP request behind the wait");
    executeSession.send({
      id: 10,
      method: "tools/call",
      params: {
        name: "codara_preview_run",
        arguments: { steps: [{ action: "snapshot" }, { action: "snapshot" }] },
        _meta: { progressToken: "batch-1" },
      },
    });
    await executeSession.next((msg) => msg.id === 10);
    const progress = executeSession.messages.filter(
      (msg) => msg.method === "notifications/progress" && msg.params.progressToken === "batch-1",
    );
    assert.deepStrictEqual(progress.map((msg) => [msg.params.progress, msg.params.total]), [[1, 2], [2, 2]]);
    assert.ok(!executeSession.messages.some((msg) => msg.id === 9), "a cancelled request is never answered");
    executeSession.close();

    // A Cora manager's worktree call carries its run and role; a stdio
    // client is named by its initialize clientInfo.
    const managerSession = stdioSession({ SPARK_MCP_MODE: "execute", SPARK_RUN_ID: "run-stdio" });
    managerSession.send({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code\u0007", version: "9" } },
    });
    await managerSession.next((msg) => msg.id === 1);
    managerSession.send({ id: 2, method: "tools/call", params: { name: "codara_worktree_list", arguments: {} } });
    await managerSession.next((msg) => msg.id === 2);
    const managerCall = received.at(-1);
    assert.strictEqual(managerCall.method, "worktree.list");
    assert.strictEqual(managerCall.params.runId, "run-stdio");
    assert.strictEqual(managerCall.params.callerRole, "manager");
    assert.strictEqual(managerCall.params.callerClient, "claude-code");
    managerSession.close();

    // The batched step schema is additionalProperties:false, so every field the
    // single-shot tool accepts must also be spelled out on the step items or a
    // legitimate batched step is rejected outright.
    const runTool = studio.definitions.find((tool) => tool.name === "codara_preview_run");
    const stepProps = runTool.inputSchema.properties.steps.items.properties;
    const snapshotProps = studio.definitions.find((tool) => tool.name === "codara_preview_snapshot")
      .inputSchema.properties;
    for (const field of Object.keys(snapshotProps)) {
      assert.deepStrictEqual(
        stepProps[field],
        snapshotProps[field],
        `codara_preview_run step schema must mirror codara_preview_snapshot's ${field}`,
      );
    }

    console.log("PASS: codara-studio MCP roster matrix");
    console.log(`  studio:     ${studio.tools.length} tools`);
    console.log(`  execute:    ${execute.tools.length} tools`);
    console.log(`  automation: ${automation.tools.length} tools`);
    console.log(`  worker:     ${worker.tools.length} tools`);
  } catch (err) {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  } finally {
    if (previousHome === undefined) delete process.env.CODARA_HOME_DIR;
    else process.env.CODARA_HOME_DIR = previousHome;
    if (previousRunId === undefined) delete process.env.SPARK_RUN_ID;
    else process.env.SPARK_RUN_ID = previousRunId;
    if (previousAgentSocket === undefined) delete process.env.SPARK_AGENT_SOCKET;
    else process.env.SPARK_AGENT_SOCKET = previousAgentSocket;
    if (previousAgentToken === undefined) delete process.env.SPARK_AGENT_TOKEN;
    else process.env.SPARK_AGENT_TOKEN = previousAgentToken;
    if (previousAgentCapability === undefined) delete process.env.SPARK_AGENT_CAPABILITY;
    else process.env.SPARK_AGENT_CAPABILITY = previousAgentCapability;
    if (mockAgentSocket) {
      await new Promise((resolve) => mockAgentSocket.close(resolve));
    }
    try {
      fs.rmSync(HOME, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
})();
