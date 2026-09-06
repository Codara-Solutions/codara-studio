#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-custom-homes-"));
const userHome = path.join(TMP, "user");
const cwd = path.join(TMP, "workspace");
const codexHome = path.join(userHome, "relocated", "codex");
const claudeHome = path.join(userHome, "relocated", "claude");
const grokHome = path.join(userHome, "relocated", "grok");
Object.assign(process.env, {
  CODEX_HOME: codexHome,
  CLAUDE_CONFIG_DIR: claudeHome,
  GROK_HOME: grokHome,
  CODARA_HOME_DIR: path.join(TMP, "codara"),
  SPARK_DISABLE_RUNTIMES: "",
});
for (const key of ["OPENAI_API_KEY", "XAI_API_KEY"]) delete process.env[key];

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function skill(root, name) {
  write(path.join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill\n---\nFixture.\n`);
}

async function main() {
  const output = path.join(TMP, "audit.cjs");
  await build({
    stdin: {
      contents: [
        'export * as assets from "./src/main/agent-sync";',
        'export * as runtimes from "./src/main/agent-runtimes";',
        'export * as roots from "./src/main/orchestration/codara-managed-cli-roots";',
        'export { codexProvider } from "./src/main/providers/codex";',
        'export { grokProvider } from "./src/main/providers/grok";',
      ].join("\n"),
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
    outfile: output,
    logLevel: "silent",
    plugins: [{
      name: "fixture-environment",
      setup(builder) {
        builder.onResolve({ filter: /^node:os$/ }, () => ({ path: "os", namespace: "fixture" }));
        builder.onResolve({ filter: /\/binary-resolver$/ }, () => ({ path: "binary", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: name }) => ({
          contents: name === "os"
            ? `export * from "os"; export function homedir() { return ${JSON.stringify(userHome)}; }`
            : `export async function resolveBinary() { return ${JSON.stringify(process.execPath)}; }`,
          resolveDir: ROOT,
          loader: "js",
        }));
      },
    }],
  });
  const { assets, runtimes, roots, codexProvider, grokProvider } = require(output);
  const settings = { agentDisabledMcpIds: [], agentDisabledSkillIds: [] };
  const inventory = () => assets.listAgentAssets({ cwd, settings });

  write(path.join(codexHome, "config.toml"), '[mcp_servers.custom-codex]\ncommand = "codex-tool"\n');
  write(path.join(grokHome, "config.toml"), '[mcp_servers.custom-grok]\ncommand = "grok-tool"\n');
  write(path.join(userHome, ".codex", "config.toml"), '[mcp_servers.wrong-home]\ncommand = "wrong"\n');
  write(path.join(cwd, ".mcp.json"), '{"mcpServers":{"workspace-tool":{"command":"workspace-tool"}}}');
  write(path.join(codexHome, "auth.json"), '{"tokens":{"access_token":"fixture"}}');
  write(path.join(grokHome, "auth.json"), '{}');
  write(path.join(claudeHome, ".credentials.json"), '{}');
  skill(path.join(codexHome, "skills"), "codex-user");
  skill(path.join(codexHome, "skills", ".system"), "bundled");
  skill(path.join(claudeHome, "skills"), "claude-user");
  skill(path.join(cwd, ".agents", "skills"), "shared-workspace");

  assert.deepEqual(inventory().mcp.map((item) => item.name).sort(), ["custom-codex", "custom-grok", "workspace-tool"]);
  const codexTarget = assets.listMcpWriteTargets({ cwd }).find((item) => item.runtime === "codex" && item.scope === "user");
  assert.equal(codexTarget.path, path.join(codexHome, "config.toml"));
  assert.equal(codexProvider.hookConfigPath, codexTarget.path);
  assert.equal(grokProvider.hookConfigPath, path.join(grokHome, "config.toml"));

  const bundled = inventory().skills.find((item) => item.name === "bundled");
  assert.equal(bundled.canDelete, false);
  assert.equal(bundled.syncable, false);
  for (const [name, target, destination] of [
    ["codex-user", "claude", path.join(claudeHome, "skills")],
    ["claude-user", "codex", path.join(codexHome, "skills")],
    ["shared-workspace", "codex", path.join(cwd, ".codex", "skills")],
  ]) {
    const item = inventory().skills.find((entry) => entry.name === name);
    const result = await assets.installAgentAssetToRuntime({ id: item.id, target });
    assert.equal(result.ok, true, result.error);
    assert.ok(fs.existsSync(path.join(destination, name, "SKILL.md")));
  }

  const tool = inventory().mcp.find((item) => item.name === "workspace-tool");
  for (const target of ["codex", "grok"]) {
    const result = await assets.installAgentAssetToRuntime({ id: tool.id, target });
    assert.equal(result.ok, true, result.error);
    assert.ok(inventory().mcp.some((item) => item.runtime === target && item.name === "workspace-tool"));
  }
  skill(path.join(claudeHome, "skills"), "bulk-user");
  const synced = await assets.syncAgentAssets({ cwd });
  assert.deepEqual(synced.mcp.errors, []);
  assert.deepEqual(synced.skills.errors, []);
  assert.ok(fs.existsSync(path.join(codexHome, "skills", "bulk-user", "SKILL.md")));
  assert.equal(fs.existsSync(path.join(claudeHome, "skills", "bundled")), false);
  assert.equal(fs.existsSync(path.join(userHome, ".codex", "skills")), false);
  assert.match(fs.readFileSync(path.join(userHome, ".codex", "config.toml"), "utf8"), /wrong-home/);
  assert.doesNotMatch(fs.readFileSync(path.join(userHome, ".codex", "config.toml"), "utf8"), /workspace-tool/);

  const signedIn = await runtimes.detectAgentRuntimes(true);
  for (const runtime of ["codex", "grok"]) {
    assert.equal(signedIn.find((item) => item.kind === runtime).authenticated, true);
    const configuredHome = runtime === "codex" ? codexHome : grokHome;
    fs.unlinkSync(path.join(configuredHome, "auth.json"));
    write(path.join(userHome, `.${runtime}`, "auth.json"), '{"tokens":{"access_token":"stale"}}');
  }
  const signedOut = await runtimes.detectAgentRuntimes(true);
  for (const runtime of ["codex", "grok"]) {
    assert.equal(signedOut.find((item) => item.kind === runtime).authenticated, false);
  }

  const managed = path.join(process.env.CODARA_HOME_DIR, "codex-cli", "accounts", "account");
  assert.equal(roots.isCodaraManagedCliPath(managed), true);
  assert.equal(roots.isCodaraManagedCliPath(path.join(process.env.CODARA_HOME_DIR, "codex-cli-other")), false);
  if (process.platform === "win32") {
    assert.equal(roots.isCodaraManagedCliPath(managed.toUpperCase()), true);
  }
  console.log("PASS custom CLI homes: discovery, MCP writes, skill copy/sync, system-skill protection, sign-in checks, and managed-root matching");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
