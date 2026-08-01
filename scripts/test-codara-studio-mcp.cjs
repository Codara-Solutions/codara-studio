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

// A throwaway spark-home with a valid-looking handshake file (unused by
// tools/list, but keeps the server from complaining if a call slips through).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codara-studio-mcp-"));
fs.writeFileSync(
  path.join(HOME, "agent-socket.json"),
  JSON.stringify({ url: "http://127.0.0.1:1", token: "f".repeat(64) }),
);

const PREVIEW_TOOLS = [
  "codara_preview_list",
  "codara_preview_url",
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
const TERMINAL_TOOLS = [
  "codara_terminal_create",
  "codara_terminal_write",
  "codara_terminal_read",
  "codara_terminal_close",
];
const WHITEBOARD_TOOLS = ["codara_whiteboard_get", "codara_whiteboard_update"];
const BOARD_TOOLS = ["codara_board_get", "codara_board_update"];
const STUDIO_TOOLS = [...PREVIEW_TOOLS, ...TERMINAL_TOOLS, ...WHITEBOARD_TOOLS, ...BOARD_TOOLS];
const EXECUTE_TOOLS = [
  "codara_spawn_terminals",
  "codara_spawn_workers",
  "codara_ask_user",
  "codara_complete",
  "codara_name_chat",
  "codara_remember",
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
// names it reports plus the serverInfo.name from initialize.
function listTools(mode) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, SPARK_HOME_DIR: HOME };
    if (mode) env.SPARK_MCP_MODE = mode;
    else delete env.SPARK_MCP_MODE;
    const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    let serverName = null;
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
        if (msg.id === 1 && msg.result) serverName = msg.result.serverInfo && msg.result.serverInfo.name;
        if (msg.id === 2 && msg.result) {
          const definitions = msg.result.tools;
          tools = definitions.map((t) => t.name);
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          resolve({ serverName, tools, definitions });
        }
      }
    });
    child.on("error", reject);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  });
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
    // Studio mode (unset).
    const studio = await listTools(undefined);
    assert.strictEqual(studio.serverName, "codara-studio", "serverInfo.name must be codara-studio");
    sortedEqual(studio.tools, STUDIO_TOOLS, "studio (unset SPARK_MCP_MODE) roster mismatch");

    // Studio mode (explicit "studio").
    const studio2 = await listTools("studio");
    sortedEqual(studio2.tools, STUDIO_TOOLS, "studio ('studio') roster mismatch");

    // Execute mode. Carries the automation-management tools too (Cora creates
    // and manages looms from an ordinary auto/execute chat), minus
    // codara_name_chat, which the execute roster already owns and maps to
    // orchestrator.name_chat.
    const execute = await listTools("execute");
    sortedEqual(
      execute.tools,
      [
        ...STUDIO_TOOLS,
        ...EXECUTE_TOOLS,
        ...AUTOMATION_TOOLS.filter((name) => !EXECUTE_TOOLS.includes(name)),
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
    assert.match(
      remember.description,
      /Workers do NOT see memory/,
      "codara_remember must tell the manager to copy relevant memory into worker descriptions",
    );

    // Automation mode: memory is a manager-of-a-coding-run concept, an
    // automation loop has no user conversation to learn a durable fact from.
    const automation = await listTools("automation");
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
      /bundled Pi runtime/,
      "worker schema must state that automation workers run on the bundled Pi runtime",
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
    const worker = await listTools("worker");
    assert.ok(
      !worker.tools.includes("codara_remember"),
      "worker roster must not expose codara_remember",
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

    // The JSON schema hides runId, but the bridge must also treat the
    // launch-time env stamp as authoritative. callToolByName is used by Pi and
    // can be invoked directly, so discard a spoofed argument before it reaches
    // the shared local socket.
    const received = [];
    const receivedAuthorization = [];
    mockAgentSocket = http.createServer((req, res) => {
      receivedAuthorization.push(req.headers.authorization);
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
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

    await directBridge.callToolByName("codara_terminal_close", {
      paneId: "pane-owned",
      runId: "run-spoofed",
    });
    assert.strictEqual(received.at(-1).method, "terminal.close");
    assert.strictEqual(
      received.at(-1).params.runId,
      "run-trusted",
      "terminal.close must use the trusted launch-time run identity",
    );
    await directBridge.callToolByName("codara_terminal_create", {
      cwd: HOME,
      retention: "service",
      runId: "run-spoofed",
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
    await directBridge.callToolByName("codara_terminal_write", {
      paneId: "pane-owned",
      text: "npm test",
      runId: "run-spoofed",
    });
    assert.strictEqual(received.at(-1).method, "terminal.write");
    assert.strictEqual(
      received.at(-1).params.runId,
      "run-trusted",
      "terminal.write must use the trusted launch-time run identity",
    );
    delete process.env.SPARK_RUN_ID;
    await directBridge.callToolByName("codara_terminal_close", {
      paneId: "pane-null-scoped",
      runId: "run-spoofed",
    });
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(received.at(-1).params, "runId"),
      false,
      "a null-scoped terminal caller must not be able to supply another run id",
    );
    await directBridge.callToolByName("codara_terminal_write", {
      paneId: "pane-null-scoped",
      text: "pwd",
      runId: "run-spoofed",
    });
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(received.at(-1).params, "runId"),
      false,
      "a null-scoped terminal write must not be able to supply another run id",
    );
    const batch = await directBridge.callToolByName("codara_preview_run", {
      steps: [{ action: "navigate", url: "http://127.0.0.1:4173/" }],
    });
    assert.strictEqual(batch.isError, false, "the preview batch run-id helper must remain wired");
    assert.strictEqual(received.at(-1).method, "preview.navigate");

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
