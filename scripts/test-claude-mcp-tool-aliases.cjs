#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-claude-aliases-"));

async function main() {
  const outfile = path.join(TMP, "aliases.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/orchestration/claude-mcp-tool-aliases.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  const { buildClaudeMcpToolAliases } = require(outfile);

  const automation = buildClaudeMcpToolAliases("automation");
  assert.strictEqual(Object.keys(automation).length, 36, "automation aliases must cover its full MCP roster");
  assert.strictEqual(
    automation.codara_list_automations,
    "mcp__codara-studio__codara_list_automations",
  );
  assert.strictEqual(
    automation.codara_name_chat,
    "mcp__codara-studio__codara_name_chat",
  );
  assert.strictEqual(
    automation.codara_ask_user,
    "mcp__codara-studio__codara_ask_user",
  );

  const execute = buildClaudeMcpToolAliases("execute");
  assert.strictEqual(Object.keys(execute).length, 33, "execute aliases must cover its full MCP roster");
  assert.strictEqual(
    execute.codara_spawn_workers,
    "mcp__codara-studio__codara_spawn_workers",
  );
  assert.deepStrictEqual(buildClaudeMcpToolAliases("chat"), {});

  console.log("PASS: Claude MCP tool aliases cover automation and execute rosters");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
