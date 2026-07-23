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

const SERVER = path.join(__dirname, "..", "resources", "codara-studio-mcp", "server.js");

// A throwaway spark-home with a valid-looking handshake file (unused by
// tools/list, but keeps the server from complaining if a call slips through).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codara-studio-mcp-"));
fs.writeFileSync(
  path.join(HOME, "agent-socket.json"),
  JSON.stringify({ url: "http://127.0.0.1:1", token: "test" }),
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
const TERMINAL_TOOLS = ["codara_terminal_create", "codara_terminal_write", "codara_terminal_read"];
const WHITEBOARD_TOOLS = ["codara_whiteboard_get", "codara_whiteboard_update"];
const STUDIO_TOOLS = [...PREVIEW_TOOLS, ...TERMINAL_TOOLS, ...WHITEBOARD_TOOLS];
const EXECUTE_TOOLS = [
  "codara_spawn_terminals",
  "codara_spawn_workers",
  "codara_ask_user",
  "codara_complete",
  "codara_name_chat",
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
  try {
    // Studio mode (unset).
    const studio = await listTools(undefined);
    assert.strictEqual(studio.serverName, "codara-studio", "serverInfo.name must be codara-studio");
    sortedEqual(studio.tools, STUDIO_TOOLS, "studio (unset SPARK_MCP_MODE) roster mismatch");

    // Studio mode (explicit "studio").
    const studio2 = await listTools("studio");
    sortedEqual(studio2.tools, STUDIO_TOOLS, "studio ('studio') roster mismatch");

    // Execute mode.
    const execute = await listTools("execute");
    sortedEqual(execute.tools, [...STUDIO_TOOLS, ...EXECUTE_TOOLS], "execute roster mismatch");
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

    // Automation mode.
    const automation = await listTools("automation");
    sortedEqual(automation.tools, [...STUDIO_TOOLS, ...AUTOMATION_TOOLS], "automation roster mismatch");

    console.log("PASS: codara-studio MCP roster matrix");
    console.log(`  studio:     ${studio.tools.length} tools`);
    console.log(`  execute:    ${execute.tools.length} tools`);
    console.log(`  automation: ${automation.tools.length} tools`);
  } catch (err) {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  } finally {
    try {
      fs.rmSync(HOME, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
})();
