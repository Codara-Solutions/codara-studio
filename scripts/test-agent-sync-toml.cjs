#!/usr/bin/env node
"use strict";

// The Capability Center reads and edits the real config files of Claude,
// Codex and Grok. This drives agent-sync.ts (and the probe in mcp-probe.ts)
// against a throwaway fake home with every config root injected, so nothing
// here can reach the developer's dotfiles.
//
// Proven here:
//   1. Codex TOML is read with a real parser: multi-line arrays, inline env
//      tables, and trailing [projects]/[features]/[plugins] tables that are
//      not servers; http_headers, env_http_headers and bearer_token_env_var
//      surface as headers.
//   2. Editing a server keeps the keys the form does not model (cwd,
//      startup_timeout_sec, tools.* sub-tables) and every other table.
//   3. Removing the last server of the managed sync block, sub-tables and
//      all, keeps both markers; removing it again reports not found.
//   4. A server copied to Codex survives removal of its source, can be
//      edited, and reaches Cora from the Codex definition.
//   5. ~/.claude.json: top-level servers are user scope, only the active
//      workspace's projects[] entry is listed, and edits/removals touch only
//      that project.
//   6. Sync keeps scope: user servers stay user, project servers stay in the
//      project, and secrets copied into a committable project file become
//      ${VAR} placeholders.
//   7. Write targets default to private user files; a literal secret is
//      refused for a committable file and accepted for the private one.
//   8. Skills are named from frontmatter, so two folders sharing a heading
//      stay distinct, and removing one trashes only its own folder.
//   9. A large ~/.claude.json is still read, and a name collision is refused.
//  10. Pi skill folders honor the Capability Center's switches.
//  11. The Pi delivery preview reports servers past the cap.
//  12. The connection probe lists a real stdio server's tools, and never
//      starts a project server from an imported pull request.
//  13. A server added in the Capability Center lands in Codara's own list
//      (mode 600) without touching any CLI config; SSE and reserved names are
//      validated; importing from the CLI configs only reads them; Codara's
//      servers reach Cora and workers per launch through the Pi roster.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

const FAKE_HOME = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agent-sync-toml-"));
const FAKE_CWD = path.join(FAKE_HOME, "workspace");
const OTHER_PROJECT = path.join(FAKE_HOME, "other-project");
fs.mkdirSync(path.join(FAKE_CWD, ".git"), { recursive: true });
fs.mkdirSync(OTHER_PROJECT);
// codaraHomeDir() prefers these over the home folder, and a shell inside
// Codara exports SPARK_HOME_DIR, so they must point into the fake home.
const FAKE_CODARA_HOME = path.join(FAKE_HOME, ".codarastudio");
process.env.CODARA_HOME_DIR = FAKE_CODARA_HOME;
process.env.SPARK_HOME_DIR = FAKE_CODARA_HOME;
delete process.env.SPARK_USER_DATA_DIR;
process.on("exit", () => fs.rmSync(FAKE_HOME, { recursive: true, force: true }));

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

const sync = loadTypeScriptModule(path.join(__dirname, "..", "src", "main", "agent-sync.ts"));
const probe = loadTypeScriptModule(path.join(__dirname, "..", "src", "main", "mcp-probe.ts"));
const PI_AGENT_DIR = path.join(FAKE_HOME, ".codarastudio", "pi-agent");
const TRASH = path.join(FAKE_HOME, "trash");
fs.mkdirSync(TRASH);
const trashed = [];
sync.configureAgentSync({
  piAgentDir: PI_AGENT_DIR,
  trashItem: async (target) => {
    trashed.push(target);
    fs.renameSync(target, path.join(TRASH, `${trashed.length}-${path.basename(target)}`));
  },
});

const CLAUDE_JSON = path.join(FAKE_HOME, ".claude.json");
const CODEX_TOML = path.join(FAKE_HOME, ".codex", "config.toml");
const PROJECT_CODEX_TOML = path.join(FAKE_CWD, ".codex", "config.toml");
const PROJECT_MCP_JSON = path.join(FAKE_CWD, ".mcp.json");
const settings = (extra = {}) => ({
  agentDisabledMcpIds: [],
  agentDisabledSkillIds: [],
  agentMcpCoraManagerIds: [],
  agentMcpPiWorkerIds: [],
  ...extra,
});
const inventory = (extra) => sync.listAgentAssets({ cwd: FAKE_CWD, settings: settings(extra) });
const mcpItem = (name, runtime, scope) => {
  const item = inventory().mcp.find((entry) => entry.name === name && entry.runtime === runtime && (!scope || entry.scope === scope));
  assert.ok(item, `${name} is listed for ${runtime}${scope ? ` (${scope})` : ""}`);
  return item;
};
const target = (label) => {
  const found = sync.listMcpWriteTargets({ cwd: FAKE_CWD }).find((entry) => entry.label === label);
  assert.ok(found, `write target ${label} exists`);
  return found;
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));

function fixtureServerSource() {
  const sdkRoot = path.dirname(path.dirname(require.resolve("@modelcontextprotocol/sdk/client/index.js")));
  return `
const { Server } = require(${JSON.stringify(path.join(sdkRoot, "server", "index.js"))});
const { StdioServerTransport } = require(${JSON.stringify(path.join(sdkRoot, "server", "stdio.js"))});
const { ListToolsRequestSchema } = require(${JSON.stringify(path.join(sdkRoot, "types.js"))});
const server = new Server({ name: "fixture", version: "7" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "Echo back", inputSchema: { type: "object", properties: {} } },
    { name: "fail", inputSchema: { type: "object", properties: {} } },
  ],
}));
server.connect(new StdioServerTransport());
`;
}

const results = [];
async function check(name, fn) {
  await fn();
  results.push(name);
}

async function main() {
  fs.mkdirSync(path.dirname(CODEX_TOML), { recursive: true });
  fs.writeFileSync(CODEX_TOML, [
    'model = "gpt-5"',
    "",
    "[mcp_servers.multi]",
    'command = "node"',
    "args = [",
    '  "server.js",',
    '  "--flag",',
    "]",
    'env = { API_KEY = "${API_KEY}", MODE = "x" }',
    'cwd = "/srv"',
    "startup_timeout_sec = 30",
    "",
    "[mcp_servers.multi.tools.search]",
    'approval = "never"',
    "",
    "[mcp_servers.remote]",
    'url = "https://remote.example/mcp"',
    'http_headers = { "X-Team" = "core" }',
    'env_http_headers = { "X-Key" = "REMOTE_KEY" }',
    'bearer_token_env_var = "REMOTE_TOKEN"',
    "",
    "[mcp_servers.off]",
    'command = "x"',
    "enabled = false",
    "",
    '[projects."/home/me/repo"]',
    'trust_level = "trusted"',
    "",
    "[features]",
    "web_search = true",
    "",
    '[plugins."foo"]',
    "enabled = false",
    "",
  ].join("\n"));

  await check("Codex TOML parses arrays, inline tables and header keys", () => {
    const codexUser = inventory().mcp.filter((item) => item.runtime === "codex" && item.scope === "user");
    assert.deepEqual(codexUser.map((item) => item.name).sort(), ["multi", "off", "remote"]);
    const multi = sync.readMcpServerDetail({ id: mcpItem("multi", "codex").id });
    assert.deepEqual(multi.args, ["server.js", "--flag"]);
    assert.deepEqual(multi.env, { API_KEY: "${API_KEY}", MODE: "x" });
    const remote = sync.readMcpServerDetail({ id: mcpItem("remote", "codex").id });
    assert.equal(remote.transport, "http");
    assert.deepEqual(remote.headers, {
      "X-Team": "core",
      "X-Key": "${REMOTE_KEY}",
      Authorization: "Bearer ${REMOTE_TOKEN}",
    });
    const preview = sync.describePiMcpDelivery({ cwd: FAKE_CWD, settings: settings({ agentMcpCoraManagerIds: ["mcp:off"] }) });
    assert.deepEqual(preview.cora.map((entry) => `${entry.name}:${entry.state}`), ["off:turned-off"]);
  });

  await check("an edit keeps unmodeled keys, sub-tables and other tables", async () => {
    const multi = mcpItem("multi", "codex");
    const saved = await sync.saveMcpServer({
      cwd: FAKE_CWD,
      targetId: target("Every workspace, Codex").id,
      replaceId: multi.id,
      server: { name: "multi", transport: "stdio", command: "node", args: ["server.js", "--flag", "--new"], env: { API_KEY: "${API_KEY}", MODE: "y" } },
    });
    assert.equal(saved.ok, true, saved.error);
    const text = fs.readFileSync(CODEX_TOML, "utf8");
    for (const line of [
      'model = "gpt-5"',
      'cwd = "/srv"',
      "startup_timeout_sec = 30",
      "[mcp_servers.multi.tools.search]",
      'approval = "never"',
      '[projects."/home/me/repo"]',
      "[features]",
      '[plugins."foo"]',
      'bearer_token_env_var = "REMOTE_TOKEN"',
    ]) {
      assert.ok(text.split("\n").includes(line), `the edit dropped: ${line}`);
    }
    const detail = sync.readMcpServerDetail({ id: mcpItem("multi", "codex").id });
    assert.deepEqual(detail.args, ["server.js", "--flag", "--new"]);
    assert.equal(detail.env.MODE, "y");

    // ${env:VAR} is not Codex's env_vars spelling, so it stays a literal value
    // instead of failing the post-write check.
    const spelled = await sync.saveMcpServer({
      cwd: FAKE_CWD,
      targetId: target("Every workspace, Codex").id,
      replaceId: mcpItem("multi", "codex").id,
      server: { name: "multi", transport: "stdio", command: "node", args: ["server.js"], env: { API_KEY: "${API_KEY}", OTHER: "${env:OTHER}" } },
    });
    assert.equal(spelled.ok, true, spelled.error);
    assert.equal(sync.readMcpServerDetail({ id: mcpItem("multi", "codex").id }).env.OTHER, "${env:OTHER}");
    assert.ok(fs.readFileSync(CODEX_TOML, "utf8").split("\n").includes('cwd = "/srv"'), "an edit without a cwd keeps the file's own");

    // A copy carries the stdio cwd along with the command.
    const copied = await sync.installAgentAssetToRuntime({ id: mcpItem("multi", "codex").id, target: "grok" });
    assert.deepEqual(copied, { ok: true, installed: ["multi"] });
    const grokText = fs.readFileSync(path.join(FAKE_HOME, ".grok", "config.toml"), "utf8");
    assert.ok(grokText.split("\n").includes('cwd = "/srv"'), `the copy dropped cwd:\n${grokText}`);
    fs.rmSync(path.join(FAKE_HOME, ".grok"), { recursive: true, force: true });
  });

  await check("renaming a server keeps it disabled with its cwd, timeouts and tool approvals", async () => {
    const before = fs.readFileSync(CODEX_TOML, "utf8");
    fs.writeFileSync(CODEX_TOML, [
      before.trimEnd(),
      "",
      "[mcp_servers.old]",
      'command = "npx"',
      'args = ["-y", "deploy-mcp"]',
      'cwd = "/srv/tools"',
      "enabled = false",
      "startup_timeout_sec = 60",
      "tool_timeout_sec = 120",
      "",
      "[mcp_servers.old.tools.deploy]",
      'approval_mode = "approve"',
      "",
    ].join("\n"));
    const saved = await sync.saveMcpServer({
      cwd: FAKE_CWD,
      targetId: target("Every workspace, Codex").id,
      replaceId: mcpItem("old", "codex").id,
      server: { name: "new", transport: "stdio", command: "npx", args: ["-y", "deploy-mcp"] },
    });
    assert.equal(saved.ok, true, saved.error);
    const lines = fs.readFileSync(CODEX_TOML, "utf8").split("\n");
    for (const line of [
      "[mcp_servers.new]",
      'cwd = "/srv/tools"',
      "enabled = false",
      "startup_timeout_sec = 60",
      "tool_timeout_sec = 120",
      "[mcp_servers.new.tools.deploy]",
      'approval_mode = "approve"',
    ]) {
      assert.ok(lines.includes(line), `the rename dropped: ${line}`);
    }
    assert.ok(!lines.some((line) => line.startsWith("[mcp_servers.old")), "the old tables are gone");
    assert.ok(!lines.includes("enabled = true"), "the rename turned the server back on");
    fs.writeFileSync(CODEX_TOML, before);
  });

  await check("removing the last managed server keeps the block markers", async () => {
    fs.mkdirSync(path.dirname(PROJECT_CODEX_TOML), { recursive: true });
    fs.writeFileSync(PROJECT_CODEX_TOML, [
      "[mcp_servers.keep]",
      'command = "a"',
      "",
      "# >>> SPARK_AGENT_MCP_SYNC",
      "[mcp_servers.synced]",
      'command = "b"',
      "",
      "[mcp_servers.synced.env]",
      'K = "v"',
      "# <<< SPARK_AGENT_MCP_SYNC",
      "",
    ].join("\n"));
    const synced = mcpItem("synced", "codex", "workspace");
    const removed = await sync.deleteAgentAsset({ id: synced.id });
    assert.deepEqual(removed, { ok: true, deleted: ["synced"] });
    const text = fs.readFileSync(PROJECT_CODEX_TOML, "utf8");
    assert.match(text, /# >>> SPARK_AGENT_MCP_SYNC/);
    assert.match(text, /# <<< SPARK_AGENT_MCP_SYNC/);
    assert.doesNotMatch(text, /synced|K = "v"/);
    assert.match(text, /^\[mcp_servers\.keep\]$/m);
    const again = await sync.deleteAgentAsset({ id: synced.id });
    assert.equal(again.ok, false, "a second removal must not report success");
    assert.deepEqual(again.deleted, []);
  });

  await check("a copy to Codex survives its source and reaches Cora", async () => {
    writeJson(CLAUDE_JSON, { mcpServers: { copyme: { type: "stdio", command: "old-cmd", args: ["--a"] } } });
    const copied = await sync.installAgentAssetToRuntime({ id: mcpItem("copyme", "claude", "user").id, target: "codex" });
    assert.deepEqual(copied, { ok: true, installed: ["copyme"] });
    const removed = await sync.deleteAgentAsset({ id: mcpItem("copyme", "claude", "user").id });
    assert.equal(removed.ok, true, removed.error);
    assert.equal(readJson(CLAUDE_JSON).mcpServers.copyme, undefined);
    const codexCopy = mcpItem("copyme", "codex", "user");
    const saved = await sync.saveMcpServer({
      cwd: FAKE_CWD,
      targetId: target("Every workspace, Codex").id,
      replaceId: codexCopy.id,
      server: { name: "copyme", transport: "stdio", command: "new-cmd", args: ["--b"] },
    });
    assert.equal(saved.ok, true, saved.error);
    const delivered = sync.listPiMcpServers({ cwd: FAKE_CWD, scope: "cora", settings: settings({ agentMcpCoraManagerIds: ["mcp:copyme"] }) });
    assert.deepEqual(delivered.map((server) => `${server.name}:${server.command}`), ["copyme:new-cmd"]);
    const preview = sync.describePiMcpDelivery({ cwd: FAKE_CWD, settings: settings({ agentMcpCoraManagerIds: ["mcp:copyme"] }) });
    assert.deepEqual(preview.cora.map((entry) => `${entry.name}:${entry.state}`), ["copyme:delivered"]);
  });

  await check("~/.claude.json lists only the active workspace's project servers", async () => {
    writeJson(CLAUDE_JSON, {
      mcpServers: { top: { command: "top" } },
      projects: {
        [FAKE_CWD]: { mcpServers: { same: { command: "mine" } }, allowedTools: ["keep"] },
        [OTHER_PROJECT]: { mcpServers: { same: { command: "theirs" }, otheronly: { command: "x" } } },
      },
    });
    const claude = inventory().mcp.filter((item) => item.runtime === "claude");
    assert.deepEqual(claude.map((item) => `${item.name}@${item.scope}`).sort(), ["same@workspace", "top@user"]);
    const same = mcpItem("same", "claude", "workspace");
    assert.equal(same.claudeLocalScope, true);
    assert.equal(sync.readMcpServerDetail({ id: same.id }).command, "mine");
    const removed = await sync.deleteAgentAsset({ id: same.id });
    assert.equal(removed.ok, true, removed.error);
    const after = readJson(CLAUDE_JSON);
    assert.equal(after.projects[FAKE_CWD].mcpServers.same, undefined);
    assert.deepEqual(after.projects[FAKE_CWD].allowedTools, ["keep"]);
    assert.equal(after.projects[OTHER_PROJECT].mcpServers.same.command, "theirs");
    assert.ok(after.mcpServers.top);
  });

  await check("a server that opens a separate Chrome is marked Off in Codara while the switch is on", async () => {
    const savedClaude = fs.readFileSync(CLAUDE_JSON, "utf8");
    writeJson(CLAUDE_JSON, {
      mcpServers: {
        devtools: { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
        attached: { command: "npx", args: ["chrome-devtools-mcp@latest", "--autoConnect"] },
        plain: { command: "node", args: ["server.js"] },
      },
    });
    const marked = (off) =>
      Object.fromEntries(
        sync
          .listAgentAssets({ cwd: FAKE_CWD, settings: settings(), separateBrowserToolsOff: off })
          .mcp.filter((item) => item.runtime === "claude" && ["devtools", "attached", "plain"].includes(item.name))
          .map((item) => [item.name, Boolean(item.offInCodara)]),
      );
    assert.deepEqual(marked(true), { attached: false, devtools: true, plain: false });
    assert.deepEqual(marked(false), { attached: false, devtools: false, plain: false });
    const reason = sync
      .listAgentAssets({ cwd: FAKE_CWD, settings: settings(), separateBrowserToolsOff: true })
      .mcp.find((item) => item.name === "devtools").offInCodara;
    assert.match(reason, /separate Chrome window/);
    assert.match(reason, /Keep agents in your Chrome/);
    assert.doesNotMatch(reason, /[\u2013\u2014]/);
    fs.writeFileSync(CLAUDE_JSON, savedClaude);
  });

  await check("sync keeps scope and placeholders project secrets", async () => {
    writeJson(CLAUDE_JSON, { mcpServers: {} });
    // The managed block is what older syncs copied out of some project's
    // .mcp.json; it must not become a user server in Claude.
    fs.writeFileSync(CODEX_TOML, [
      "[mcp_servers.usr]",
      'command = "usr-cmd"',
      "",
      "[mcp_servers.off]",
      'command = "off-cmd"',
      "enabled = false",
      "",
      "# >>> SPARK_AGENT_MCP_SYNC",
      "[mcp_servers.legacy]",
      'command = "legacy-cmd"',
      "# <<< SPARK_AGENT_MCP_SYNC",
      "",
    ].join("\n"));
    fs.rmSync(PROJECT_CODEX_TOML, { force: true });
    writeJson(PROJECT_MCP_JSON, { mcpServers: { proj: { command: "proj-cmd", env: { API_TOKEN: "literal-secret-value" } } } });
    const result = await sync.syncAgentAssets({ cwd: FAKE_CWD });
    assert.deepEqual(Object.keys(readJson(CLAUDE_JSON).mcpServers), ["usr"], "only the user's own enabled Codex server reaches Claude");
    assert.ok(result.mcp.skipped.some((note) => /'off' is turned off/.test(note)), "the disabled server is reported");
    assert.deepEqual(Object.keys(readJson(PROJECT_MCP_JSON).mcpServers), ["proj"], "a user server leaked into the project");
    assert.doesNotMatch(fs.readFileSync(CODEX_TOML, "utf8"), /proj/, "a project server leaked into the user Codex config");
    const projectToml = fs.readFileSync(PROJECT_CODEX_TOML, "utf8");
    assert.match(projectToml, /proj-cmd/);
    assert.doesNotMatch(projectToml, /literal-secret-value/, "a literal secret was copied into a committable file");
    assert.match(projectToml, /API_TOKEN/);
    assert.ok(result.mcp.skipped.some((note) => /API_TOKEN/.test(note)), "the placeholder is reported");
  });

  await check("write targets default private and refuse literal secrets in shared files", async () => {
    const targets = sync.listMcpWriteTargets({ cwd: FAKE_CWD });
    assert.equal(targets[0].label, "Codara's own list");
    assert.equal(targets[1].label, "Every workspace, Claude");
    assert.ok(target("This workspace, project .mcp.json (Claude)").hint);
    const leaky = { name: "leaky", transport: "stdio", command: "node", env: { API_TOKEN: "sk-literal-1234" } };
    const refused = await sync.saveMcpServer({ cwd: FAKE_CWD, targetId: target("This workspace, project .mcp.json (Claude)").id, server: leaky });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /looks like a secret/);
    assert.equal(readJson(PROJECT_MCP_JSON).mcpServers.leaky, undefined);
    const accepted = await sync.saveMcpServer({ cwd: FAKE_CWD, targetId: target("This workspace, Claude (private)").id, server: leaky });
    assert.equal(accepted.ok, true, accepted.error);
    assert.equal(readJson(CLAUDE_JSON).projects[FAKE_CWD].mcpServers.leaky.env.API_TOKEN, "sk-literal-1234");
  });

  await check("skills are named from frontmatter and removed one folder at a time", async () => {
    const skillsRoot = path.join(FAKE_HOME, ".claude", "skills");
    for (const [dir, name] of [["a", "alpha"], ["b", "beta"]]) {
      fs.mkdirSync(path.join(skillsRoot, dir), { recursive: true });
      fs.writeFileSync(
        path.join(skillsRoot, dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: The ${name} skill\n---\n# Shared heading\nBody.\n`,
      );
    }
    const claudeSkills = inventory().skills.filter((item) => item.runtime === "claude" && item.scope === "user");
    assert.deepEqual(claudeSkills.map((item) => item.name).sort(), ["alpha", "beta"]);
    const alpha = claudeSkills.find((item) => item.name === "alpha");
    assert.equal(alpha.skillDescription, "The alpha skill");
    const removed = await sync.deleteAgentAsset({ id: alpha.id });
    assert.equal(removed.ok, true, removed.error);
    assert.deepEqual(trashed, [path.join(skillsRoot, "a")]);
    assert.equal(fs.existsSync(path.join(skillsRoot, "a")), false);
    assert.equal(fs.existsSync(path.join(skillsRoot, "b", "SKILL.md")), true);
  });

  await check("a large ~/.claude.json is read and name collisions are refused", async () => {
    writeJson(CLAUDE_JSON, { mcpServers: { big: { command: "big" } }, padding: "x".repeat(12 * 1024 * 1024) });
    mcpItem("big", "claude", "user");
    const collision = await sync.saveMcpServer({
      cwd: FAKE_CWD,
      targetId: target("Every workspace, Claude").id,
      server: { name: "big", transport: "stdio", command: "other" },
    });
    assert.equal(collision.ok, false);
    assert.match(collision.error, /already/);
    assert.equal(readJson(CLAUDE_JSON).mcpServers.big.command, "big");
    writeJson(CLAUDE_JSON, { mcpServers: {} });
  });

  await check("Pi skill folders follow the Capability Center switches", () => {
    fs.mkdirSync(path.join(FAKE_CWD, ".pi", "skills"), { recursive: true });
    fs.writeFileSync(path.join(FAKE_CWD, ".pi", "skills", "quick.md"), "---\nname: quick\ndescription: Quick skill\n---\nDo it.\n");
    const systemSkill = path.join(FAKE_HOME, ".codex", "skills", ".system", "bundled");
    fs.mkdirSync(systemSkill, { recursive: true });
    fs.writeFileSync(path.join(systemSkill, "SKILL.md"), "---\nname: bundled\ndescription: Bundled\n---\n");
    const agentsSkill = path.join(FAKE_HOME, ".agents", "skills", "gamma");
    fs.mkdirSync(agentsSkill, { recursive: true });
    fs.writeFileSync(path.join(agentsSkill, "SKILL.md"), "---\nname: gamma\ndescription: Gamma\n---\n");
    const codaraSkill = path.join(FAKE_CODARA_HOME, "skills", "added-in-codara");
    fs.mkdirSync(codaraSkill, { recursive: true });
    fs.writeFileSync(path.join(codaraSkill, "SKILL.md"), "---\nname: added-in-codara\ndescription: Added\n---\n");
    assert.equal(sync.codaraSkillsDir(), path.join(FAKE_CODARA_HOME, "skills"));
    const paths = sync.listPiSkillPaths({ cwd: FAKE_CWD, settings: settings({ agentDisabledSkillIds: ["skill:gamma"] }) });
    assert.ok(paths.includes(path.join(FAKE_CWD, ".pi", "skills", "quick.md")), "a Pi-native single-file skill is kept");
    assert.ok(paths.includes(codaraSkill), "a skill added in Codara reaches Cora and workers");
    const codaraItem = inventory().skills.find((item) => item.name === "added-in-codara");
    assert.equal(codaraItem.runtime, "codara");
    assert.equal(
      sync.listPiSkillPaths({ cwd: FAKE_CWD, settings: settings({ agentDisabledSkillIds: ["skill:added-in-codara"] }) }).includes(codaraSkill),
      false,
      "switching a Codara skill off keeps it from the next launch",
    );
    return sync.deleteAgentAsset({ id: codaraItem.id }).then((removed) => {
      assert.equal(removed.ok, true, removed.error);
      assert.equal(fs.existsSync(codaraSkill), false);
    });
    assert.ok(paths.includes(path.join(FAKE_HOME, ".claude", "skills", "b")), "a Claude skill reaches Cora");
    assert.equal(paths.some((entry) => entry.includes("gamma")), false, "a switched-off skill stays off");
    assert.equal(paths.some((entry) => entry.includes(".system")), false, "Codex system skills stay Codex-only");
  });

  await check("the Pi delivery preview reports servers past the cap", () => {
    const servers = Object.fromEntries(Array.from({ length: 18 }, (_, index) => [`s${String(index).padStart(2, "0")}`, { command: "node" }]));
    writeJson(CLAUDE_JSON, { mcpServers: servers });
    const preview = sync.describePiMcpDelivery({
      cwd: FAKE_CWD,
      settings: settings({ agentMcpCoraManagerIds: Object.keys(servers).map((name) => `mcp:${name}`) }),
    });
    assert.equal(preview.maxServers, 16);
    assert.equal(preview.cora.filter((entry) => entry.state === "delivered").length, 16);
    assert.equal(preview.cora.filter((entry) => entry.state === "over-cap").length, 2);
    assert.deepEqual(preview.worker, []);
  });

  await check("Codara's own server list: saved privately, validated, imported read-only, delivered per launch", async () => {
    const CODARA_MCP = path.join(FAKE_CODARA_HOME, "mcp-servers.json");
    assert.equal(sync.codaraMcpConfigPath(), CODARA_MCP);
    writeJson(CLAUDE_JSON, {
      mcpServers: {
        github: { command: "npx", args: ["-y", "gh-mcp"], env: { GITHUB_TOKEN: "ghp_literal" } },
        "codara-studio": { command: "should-not-import" },
      },
    });
    const cliFiles = [CLAUDE_JSON, CODEX_TOML, PROJECT_MCP_JSON, PROJECT_CODEX_TOML].filter((file) => fs.existsSync(file));
    const before = new Map(cliFiles.map((file) => [file, fs.readFileSync(file)]));
    const codara = target("Codara's own list");
    assert.equal(codara.path, CODARA_MCP);
    assert.deepEqual(codara.readBy, []);

    const stdio = await sync.saveMcpServer({
      cwd: FAKE_CWD,
      targetId: codara.id,
      server: { name: "fixture", transport: "stdio", command: "node", args: ["server.js"], env: { API_KEY: "sk-literal-9999" } },
    });
    assert.equal(stdio.ok, true, stdio.error);
    const sse = await sync.saveMcpServer({
      cwd: FAKE_CWD,
      targetId: codara.id,
      server: { name: "events", transport: "sse", url: "https://sse.example/sse", headers: { Authorization: "Bearer t" } },
    });
    assert.equal(sse.ok, true, sse.error);
    const saved = readJson(CODARA_MCP).mcpServers;
    assert.deepEqual(saved.fixture, { type: "stdio", command: "node", args: ["server.js"], env: { API_KEY: "sk-literal-9999" } });
    assert.equal(saved.events.type, "sse");
    assert.equal(saved.events.url, "https://sse.example/sse");
    if (process.platform !== "win32") assert.equal(fs.statSync(CODARA_MCP).mode & 0o777, 0o600);
    assert.equal(sync.readMcpServerDetail({ id: mcpItem("events", "codara").id }).transport, "sse");

    for (const [server, pattern] of [
      [{ name: "codara-studio", transport: "stdio", command: "x" }, /reserved/],
      [{ name: "bad", transport: "sse", url: "ftp://nope" }, /http/i],
      [{ name: "bad", transport: "stdio", command: "a\nb" }, /line/i],
      [{ name: "fixture", transport: "stdio", command: "other" }, /already/],
    ]) {
      const refused = await sync.saveMcpServer({ cwd: FAKE_CWD, targetId: codara.id, server });
      assert.equal(refused.ok, false, `${server.name} should be refused`);
      assert.match(refused.error, pattern);
    }
    const sseToCodex = await sync.saveMcpServer({
      cwd: FAKE_CWD,
      targetId: target("Every workspace, Codex").id,
      server: { name: "events2", transport: "sse", url: "https://sse.example/sse" },
    });
    assert.equal(sseToCodex.ok, false);

    const candidates = sync.listMcpImportCandidates({ cwd: FAKE_CWD });
    assert.equal(candidates.some((entry) => entry.name === "codara-studio"), false, "a reserved name is not offered");
    assert.equal(candidates.some((entry) => entry.runtime === "codara"), false);
    const github = candidates.find((entry) => entry.name === "github" && entry.runtime === "claude");
    assert.ok(github, "the Claude server is offered");
    assert.equal(github.alreadyInCodara, false);
    const forged = sync.listMcpImportCandidates({ cwd: FAKE_CWD })[0].id.replace(/"path":"[^"]*"/, '"path":"/etc/passwd"');
    const imported = await sync.importMcpServersToCodara({ cwd: FAKE_CWD, ids: [github.id, github.id, forged] });
    assert.deepEqual(imported.imported, ["github"]);
    assert.ok(imported.skipped.some((note) => /already in Codara/.test(note)));
    assert.deepEqual(readJson(CODARA_MCP).mcpServers.github, { type: "stdio", command: "npx", args: ["-y", "gh-mcp"], env: { GITHUB_TOKEN: "ghp_literal" } });
    assert.equal(sync.listMcpImportCandidates({ cwd: FAKE_CWD }).find((entry) => entry.id === github.id).alreadyInCodara, true);

    for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes, `${file} was modified`);

    const roster = (extra) => ({
      cora: sync.listPiMcpServers({ cwd: FAKE_CWD, scope: "cora", settings: settings(extra) }).map((server) => server.name),
      worker: sync.listPiMcpServers({ cwd: FAKE_CWD, scope: "worker", settings: settings(extra) }).map((server) => server.name),
    });
    assert.deepEqual(roster(), { cora: [], worker: [] }, "nothing reaches Pi until assigned");
    const assigned = { agentMcpCoraManagerIds: ["mcp:fixture", "mcp:events"], agentMcpPiWorkerIds: ["mcp:fixture"] };
    assert.deepEqual(roster(assigned), { cora: ["events", "fixture"], worker: ["fixture"] });
    assert.deepEqual(roster({ ...assigned, agentDisabledMcpIds: ["mcp:fixture"] }), { cora: ["events"], worker: [] });
    const piConfig = loadTypeScriptModule(path.join(__dirname, "..", "src", "main", "orchestration", "pi-mcp-config.ts"));
    const bridge = piConfig.buildPiMcpBridgeConfig(
      piConfig.normalizePiMcpServers(sync.listPiMcpServers({ cwd: FAKE_CWD, scope: "cora", settings: settings(assigned) }), { cwd: FAKE_CWD, env: {} }),
      { audience: "cora" },
    );
    assert.deepEqual(bridge.servers.map((server) => [server.name, server.transport]), [["events", "sse"], ["fixture", "stdio"]]);

    const removed = await sync.deleteAgentAsset({ id: mcpItem("events", "codara").id });
    assert.equal(removed.ok, true, removed.error);
    assert.equal(readJson(CODARA_MCP).mcpServers.events, undefined);
    assert.ok(readJson(CODARA_MCP).mcpServers.fixture);
  });

  await check("the probe lists a stdio server's tools and reports a broken one", async () => {
    const fixture = path.join(FAKE_HOME, "fixture-server.cjs");
    fs.writeFileSync(fixture, fixtureServerSource());
    const ok = await probe.runMcpProbe(
      { cwd: FAKE_CWD, draft: { name: "fixture", transport: "stdio", command: process.execPath, args: [fixture] } },
      { workspaces: [], piAgentDir: PI_AGENT_DIR, timeoutMs: 15_000 },
    );
    assert.equal(ok.ok, true, ok.error);
    assert.deepEqual(ok.tools.map((tool) => tool.name), ["echo", "fail"]);
    assert.equal(ok.tools[0].description, "Echo back");
    assert.equal(ok.serverName, "fixture");
    assert.equal(ok.serverVersion, "7");
    const broken = await probe.runMcpProbe(
      {
        cwd: FAKE_CWD,
        draft: {
          name: "broken",
          transport: "stdio",
          command: process.execPath,
          args: ["-e", "process.stderr.write('token hunter2-secret-value missing\\n'); process.exit(3)"],
          env: { SOME_SECRET: "hunter2-secret-value" },
        },
      },
      { workspaces: [], piAgentDir: PI_AGENT_DIR, timeoutMs: 5_000 },
    );
    assert.equal(broken.ok, false);
    assert.ok(broken.error);
    assert.doesNotMatch(JSON.stringify(broken), /hunter2-secret-value/, "the probe result leaks a configured secret");
    const missing = await probe.runMcpProbe({ cwd: FAKE_CWD }, { workspaces: [], piAgentDir: PI_AGENT_DIR });
    assert.equal(missing.ok, false);

    // A project server inside an imported pull request is repository content:
    // the probe must refuse to start it.
    const marker = path.join(FAKE_HOME, "pr-server-ran");
    writeJson(PROJECT_MCP_JSON, {
      mcpServers: { hostile: { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`] } },
    });
    const hostile = mcpItem("hostile", "shared", "workspace");
    const refused = await probe.runMcpProbe(
      { cwd: FAKE_CWD, id: hostile.id },
      {
        workspaces: [{ cwd: FAKE_CWD, copyBranch: { origin: { kind: "github-pull-request" } } }],
        piAgentDir: PI_AGENT_DIR,
      },
    );
    assert.equal(refused.ok, false);
    assert.match(refused.error, /imported pull request/);
    assert.equal(fs.existsSync(marker), false, "the probe started a server from an imported pull request");
    const noWorkspace = await probe.runMcpProbe({ id: hostile.id }, { workspaces: [], piAgentDir: PI_AGENT_DIR });
    assert.equal(noWorkspace.ok, false);
    assert.equal(fs.existsSync(marker), false);
    const notOpen = await probe.runMcpProbe({ cwd: FAKE_CWD, id: hostile.id }, { workspaces: [], piAgentDir: PI_AGENT_DIR });
    assert.equal(notOpen.ok, false);
    assert.match(notOpen.error, /Open the workspace/);
    assert.equal(fs.existsSync(marker), false, "the probe started a project server for a workspace that is not open");

    // The id comes from the renderer: one naming another folder's .mcp.json
    // (here an imported pull request) is not a server of the open workspace.
    writeJson(path.join(OTHER_PROJECT, ".mcp.json"), {
      mcpServers: { hostile: { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`] } },
    });
    const forged = JSON.stringify({ ...JSON.parse(hostile.id), path: path.join(OTHER_PROJECT, ".mcp.json") });
    const crossed = await probe.runMcpProbe(
      { cwd: FAKE_CWD, id: forged },
      {
        workspaces: [{ cwd: FAKE_CWD }, { cwd: OTHER_PROJECT, copyBranch: { origin: { kind: "github-pull-request" } } }],
        piAgentDir: PI_AGENT_DIR,
      },
    );
    assert.equal(crossed.ok, false);
    assert.equal(fs.existsSync(marker), false, "the probe started another folder's project server");

    // Pi connects no MCP server inside an imported pull request, and a draft
    // started there would resolve its binaries from the repository.
    const prDraft = await probe.runMcpProbe(
      {
        cwd: OTHER_PROJECT,
        draft: { name: "draft", transport: "stdio", command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`] },
      },
      { workspaces: [{ cwd: OTHER_PROJECT, copyBranch: { origin: { kind: "github-pull-request" } } }], piAgentDir: PI_AGENT_DIR },
    );
    assert.equal(prDraft.ok, false);
    assert.match(prDraft.error, /imported pull request/);
    assert.equal(fs.existsSync(marker), false, "the probe started a draft inside an imported pull request");
  });

  console.log(results.map((name) => `  ok  ${name}`).join("\n"));
  console.log(`PASS agent-sync config round trips (${results.length} checks)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
