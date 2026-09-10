#!/usr/bin/env node
"use strict";

// All discovery roots are injected into the module loader. These tests can
// exercise real config mutations without reaching the developer's dotfiles.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

const tsModuleCache = new Map();
function loadTypeScriptModule(sourcePath) {
  const resolved = path.resolve(sourcePath);
  const cached = tsModuleCache.get(resolved);
  if (cached) return cached;
  const source = fs.readFileSync(resolved, "utf8");
  const output = ts.transpileModule(source, {
    fileName: resolved,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = new Module(resolved, module);
  loaded.filename = resolved;
  loaded.paths = Module._nodeModulePaths(path.dirname(resolved));
  const nativeRequire = loaded.require.bind(loaded);
  loaded.require = (specifier) => {
    if (specifier === "node:os") return { ...os, homedir: () => FAKE_HOME };
    if (specifier.endsWith("/claude-paths")) return {
      claudeConfigDir: () => path.join(FAKE_HOME, ".claude"),
      claudeUserConfigFile: () => path.join(FAKE_HOME, ".claude.json"),
    };
    if (specifier.endsWith("/codex-cli-account-profiles")) return { defaultPersonalCodexHomeDir: () => path.join(FAKE_HOME, ".codex") };
    if (specifier.endsWith("/grok-cli-account-profiles")) return { defaultPersonalGrokHomeDir: () => path.join(FAKE_HOME, ".grok") };
    if (specifier.startsWith("@shared/")) {
      return loadTypeScriptModule(
        path.join(__dirname, "..", "src", "shared", `${specifier.slice("@shared/".length)}.ts`),
      );
    }
    if (specifier.startsWith(".")) {
      return loadTypeScriptModule(path.join(path.dirname(resolved), `${specifier}.ts`));
    }
    return nativeRequire(specifier);
  };
  tsModuleCache.set(resolved, loaded.exports);
  loaded._compile(output, resolved);
  tsModuleCache.set(resolved, loaded.exports);
  return loaded.exports;
}


const FAKE_HOME = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "remote-assets-"));
const FAKE_CWD = path.join(FAKE_HOME, "workspace");
fs.mkdirSync(FAKE_CWD);
process.on("exit", () => fs.rmSync(FAKE_HOME, { recursive: true, force: true }));
const core = loadTypeScriptModule(path.join(__dirname, "../src/main/agent-sync.ts"));
const remote = loadTypeScriptModule(path.join(__dirname, "../src/main/remote-capabilities.ts"));
const context = { cwd: FAKE_CWD, settings: {
  agentDisabledMcpIds: [], agentDisabledSkillIds: [], agentMcpCoraManagerIds: [], agentMcpPiWorkerIds: [],
} };
const inventory = () => core.listAgentAssets(context);
const assetId = (name, kind = "mcp", runtime = "shared") => {
  const asset = inventory()[kind === "mcp" ? "mcp" : "skills"].find((item) => item.name === name && item.runtime === runtime);
  assert.ok(asset, `${kind} ${name} is discoverable for ${runtime}`);
  return remote.remoteCapabilityId(asset.id);
};
const configPath = path.join(FAKE_CWD, ".mcp.json");
const config = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
async function main() {
  const editor = remote.readRemoteMcpEditor(context);
  assert.ok(editor.targets.some((target) => target.runtime === "grok"));
  assert.ok(editor.targets.every((target) => /^[a-f0-9]{64}$/.test(target.id) && !("path" in target)));
  const targetId = editor.targets.find((target) => target.runtime === "shared" && target.scope === "workspace").id;
  const server = { name: "exact", transport: "stdio", command: "node", args: ["", "  spaced  ", "line\nbreak"], env: { TOKEN: "  exact value  ", EMPTY: "" } };
  await remote.updateRemoteAgentAsset(context, { action: "saveMcp", targetId, server });
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.deepEqual(config().mcpServers.exact.args, server.args);
  assert.deepEqual(config().mcpServers.exact.env, server.env);
  const initial = remote.readRemoteMcpEditor(context, assetId("exact"));
  assert.deepEqual(initial.detail.server.args, server.args);
  assert.equal(initial.detail.targetId, targetId);
  assert.ok(!JSON.stringify(initial).includes(FAKE_HOME));

  const physical = path.join(FAKE_HOME, "dotfiles.json");
  fs.renameSync(configPath, physical);
  fs.symlinkSync(physical, configPath);
  fs.chmodSync(physical, 0o640);
  const before = config();
  before.custom = { preserved: true };
  fs.writeFileSync(physical, JSON.stringify(before));
  const change = { action: "saveMcp", targetId, replaceId: initial.detail.assetId, revision: initial.detail.revision, server: { ...server, command: "bun" } };
  const race = await Promise.allSettled([remote.updateRemoteAgentAsset(context, change), remote.updateRemoteAgentAsset(context, { ...change, server: { ...server, command: "deno" } })]);
  assert.equal(race.filter((item) => item.status === "fulfilled").length, 1);
  assert.match(race.find((item) => item.status === "rejected").reason.message, /changed in Studio/);
  assert.ok(fs.lstatSync(configPath).isSymbolicLink());
  assert.equal(fs.statSync(physical).mode & 0o777, 0o640);
  assert.deepEqual(config().custom, { preserved: true });
  assert.equal(config().mcpServers.exact.command, "bun");

  await Promise.all(["first", "second"].map((name) => remote.updateRemoteAgentAsset(context, { action: "saveMcp", targetId, server: { ...server, name } })));
  assert.ok(config().mcpServers.first && config().mcpServers.second);
  await assert.rejects(remote.updateRemoteAgentAsset(context, { action: "saveMcp", targetId: "f".repeat(64), server }), /location/);
  assert.throws(() => remote.readRemoteMcpEditor(context, "f".repeat(64)), /available/);
  await assert.rejects(remote.updateRemoteAgentAsset(context, { action: "saveMcp", targetId, server: { ...server, name: "codara-studio" } }), /built-in/);
  await assert.rejects(remote.updateRemoteAgentAsset(context, { action: "remove", assetId: "f".repeat(64) }), /available/);
  const http = { name: "web", transport: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer fixture" } };
  const grokTarget = editor.targets.find((target) => target.runtime === "grok").id;
  await assert.rejects(remote.updateRemoteAgentAsset(context, { action: "saveMcp", targetId: grokTarget, server: http }), /cannot carry request headers/);
  await remote.updateRemoteAgentAsset(context, { action: "saveMcp", targetId, server: http });
  assert.deepEqual(remote.readRemoteMcpEditor(context, assetId("web")).detail.server.headers, http.headers);
  await remote.updateRemoteAgentAsset(context, { action: "install", assetId: assetId("first"), runtime: "grok" });
  assert.match(fs.readFileSync(path.join(FAKE_HOME, ".grok/config.toml"), "utf8"), /mcp_servers.first/);
  await remote.updateRemoteAgentAsset(context, { action: "remove", assetId: assetId("second") });
  assert.equal(config().mcpServers.second, undefined);
  assert.ok(config().mcpServers.first);

  const skill = path.join(FAKE_CWD, ".agents/skills/review");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: review\ndescription: Review code\n---\nRead the diff.\n");
  const skillId = assetId("review", "skill");
  await assert.rejects(remote.updateRemoteAgentAsset(context, { action: "install", assetId: skillId, runtime: "grok" }), /cannot be copied/);
  await remote.updateRemoteAgentAsset(context, { action: "install", assetId: skillId, runtime: "claude" });
  assert.ok(inventory().skills.some((item) => item.name === "review" && item.runtime === "claude"));
  await remote.updateRemoteAgentAsset(context, { action: "remove", assetId: skillId });
  assert.ok(!fs.existsSync(skill));
  assert.ok(inventory().skills.some((item) => item.name === "review" && item.runtime === "claude"));

  const protectedSkill = path.join(FAKE_HOME, ".codex/skills/.system/bundled");
  fs.mkdirSync(protectedSkill, { recursive: true });
  fs.writeFileSync(path.join(protectedSkill, "SKILL.md"), "---\nname: bundled\ndescription: Bundled skill\n---\nInstructions.\n");
  await assert.rejects(remote.updateRemoteAgentAsset(context, { action: "remove", assetId: assetId("bundled", "skill", "codex") }), /managed by its plugin/);
  assert.ok(fs.existsSync(protectedSkill));
  const validConfig = fs.readFileSync(physical, "utf8");
  for (const invalid of ["[]", "null", "{broken"]) {
    fs.writeFileSync(physical, invalid);
    await assert.rejects(remote.updateRemoteAgentAsset(context, { action: "saveMcp", targetId, server: { ...server, name: "invalid" } }), /Could not read/);
    assert.equal(fs.readFileSync(physical, "utf8"), invalid);
  }
  fs.writeFileSync(physical, validConfig);

  const manyMcp = Array.from({ length: 230 }, (_, index) => `mcp-${index}`);
  const manySkills = Array.from({ length: 230 }, (_, index) => `skill-${index}`);
  const pages = [0, 200, 400].map((offset) => remote.remoteCapabilityPage(manyMcp, manySkills, offset));
  assert.deepEqual(pages.flatMap((page) => page.mcp), manyMcp);
  assert.deepEqual(pages.flatMap((page) => page.skills), manySkills);
  assert.deepEqual(pages.map((page) => page.nextAssetOffset), [200, 400, undefined]);
}

main().then(() => console.log("Remote capability config tests passed.")).catch((error) => { console.error(error); process.exitCode = 1; });
