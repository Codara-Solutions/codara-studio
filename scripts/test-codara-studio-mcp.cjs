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
  "spark_preview_list",
  "spark_preview_url",
  "spark_preview_navigate",
  "spark_preview_snapshot",
  "spark_preview_click",
  "spark_preview_type",
  "spark_preview_press_key",
  "spark_preview_evaluate",
  "spark_preview_wait_for",
  "spark_preview_screenshot",
  "spark_preview_mouse",
  "spark_preview_scroll",
  "spark_preview_hover",
  "spark_preview_drag",
  "spark_preview_key",
  "spark_preview_upload",
  "spark_preview_console",
  "spark_preview_network",
  "spark_preview_resize",
  "spark_preview_run",
];
const TERMINAL_TOOLS = ["spark_terminal_create", "spark_terminal_write", "spark_terminal_read"];
const STUDIO_TOOLS = [...PREVIEW_TOOLS, ...TERMINAL_TOOLS];
const EXECUTE_TOOLS = [
  "spark_spawn_workers",
  "spark_ask_user",
  "spark_complete",
  "spark_name_chat",
  "spark_request_next_iteration",
  "spark_get_worker_status",
  "spark_wait_for_workers",
  "spark_message_workers",
  "spark_check_messages",
];
const AUTOMATION_TOOLS = [
  "spark_list_automations",
  "spark_get_automation",
  "spark_create_automation",
  "spark_update_automation",
  "spark_run_automation",
  "spark_wait_for_automation",
  "spark_set_automation_enabled",
  "spark_pause_automation",
  "spark_resume_automation",
  "spark_stop_automation",
  "spark_delete_automation",
  "spark_name_chat",
  "spark_ask_user",
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
          tools = msg.result.tools.map((t) => t.name);
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          resolve({ serverName, tools });
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
