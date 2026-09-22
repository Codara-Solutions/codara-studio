#!/usr/bin/env node
"use strict";

// The Capability Center switches the built-in codara-studio server per CLI.
// A removal used to last only until the next launch: the boot installer wrote
// the entry straight back into every config. This drives the real
// main-process mcp-installer and agent-sync against a throwaway fake home, so
// nothing here can reach the user's real ~/.claude.json, ~/.codex or ~/.grok.
//
// Proven here:
//   1. Launch installs the entry into all three personal configs.
//   2. A removal records the CLI, and the next launch leaves it out while the
//      other CLIs keep theirs.
//   3. Two removals issued together are both recorded.
//   4. Once every CLI is switched off, worker prompts stop advertising the
//      tools.
//   5. Adding it back clears the record, so launch keeps it current again.
//   6. A removal aimed at a caller-supplied Codex home is not recorded as the
//      user switching off their own Codex.
//   7. A Claude/Codex sync never copies the built-in into a project .mcp.json.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const FAKE_HOME = fs.mkdtempSync(path.join(TMP_ROOT, "codara-builtin-opt-out-"));

const realHomedir = os.homedir;
const ISOLATED_ENV = [
  "HOME",
  "CODARA_HOME_DIR",
  "SPARK_HOME_DIR",
  "SPARK_USER_DATA_DIR",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GROK_HOME",
];
const previousEnv = Object.fromEntries(ISOLATED_ENV.map((key) => [key, process.env[key]]));
os.homedir = () => FAKE_HOME;
// A temp-dir home override makes the installer treat itself as sandboxed and
// refuse every write, and an inherited CLI home would point it at the user's
// real config; drop them all so every path resolves under FAKE_HOME.
for (const key of ISOLATED_ENV) delete process.env[key];
process.env.HOME = FAKE_HOME;
process.on("exit", () => {
  os.homedir = realHomedir;
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

// electron is stubbed for codara-home/bundled-resources, and binary lookup is
// stubbed so launch never spawns the user's login shell to enrich PATH.
const stubPlugin = {
  name: "codara-test-stubs",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "codara-test" }));
    pluginBuild.onResolve({ filter: /binary-resolver$/ }, () => ({
      path: "binary-resolver",
      namespace: "codara-test",
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "codara-test" }, (args) => ({
      contents:
        args.path === "electron"
          ? `export const app = {
              isPackaged: false,
              getAppPath: () => ${JSON.stringify(ROOT)},
              getPath: () => ${JSON.stringify(FAKE_HOME)}
            };`
          : "export async function resolveBinary() { return null; }",
      loader: "js",
    }));
  },
};

async function bundle(entry, name) {
  const outfile = path.join(FAKE_HOME, `${name}.bundle.cjs`);
  await build({
    entryPoints: [path.join(ROOT, "src", "main", entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    plugins: [stubPlugin],
    logLevel: "silent",
  });
  return require(outfile);
}

const CLAUDE_JSON = path.join(FAKE_HOME, ".claude.json");
const CODEX_HOME = path.join(FAKE_HOME, ".codex");
const GROK_HOME = path.join(FAKE_HOME, ".grok");
const CODEX_TOML = path.join(CODEX_HOME, "config.toml");
const GROK_TOML = path.join(GROK_HOME, "config.toml");
const OPT_OUT_FILE = path.join(FAKE_HOME, ".codarastudio", "builtin-mcp.json");

function claudeHasBuiltin() {
  const parsed = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8"));
  return Boolean(parsed.mcpServers && parsed.mcpServers["codara-studio"]);
}

function tomlHasBuiltin(file) {
  return fs.existsSync(file) && fs.readFileSync(file, "utf8").includes('[mcp_servers."codara-studio"]');
}

function present() {
  return {
    claude: claudeHasBuiltin(),
    codex: tomlHasBuiltin(CODEX_TOML),
    grok: tomlHasBuiltin(GROK_TOML),
  };
}

function optedOut() {
  if (!fs.existsSync(OPT_OUT_FILE)) return [];
  return JSON.parse(fs.readFileSync(OPT_OUT_FILE, "utf8")).removedFrom;
}

async function main() {
  fs.writeFileSync(CLAUDE_JSON, JSON.stringify({ mcpServers: { mine: { command: "mine" } } }, null, 2));
  fs.mkdirSync(CODEX_HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(GROK_HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CODEX_TOML, '[mcp_servers.hand-written]\ncommand = "my-server"\n', { mode: 0o600 });
  fs.writeFileSync(GROK_TOML, 'model = "grok-4"\n', { mode: 0o600 });

  const mcp = await bundle("mcp-installer.ts", "mcp-installer");
  const available = () => mcp.isSparkPreviewMcpAvailable({ cwd: null, autoInstallEnabled: true });

  await mcp.installSparkPreviewMcpAtBoot();
  assert.deepEqual(present(), { claude: true, codex: true, grok: true });
  assert.deepEqual(optedOut(), []);
  console.log("ok 1 launch installs the built-in into all three personal configs");

  const removed = await mcp.uninstallSparkBuiltin("codara-studio", "claude");
  assert.deepEqual(removed, { ok: true });
  assert.deepEqual(optedOut(), ["claude"]);
  await mcp.installSparkPreviewMcpAtBoot();
  assert.deepEqual(present(), { claude: false, codex: true, grok: true });
  const claudeConfig = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8"));
  assert.deepEqual(Object.keys(claudeConfig.mcpServers), ["mine"], "the user's own server is untouched");
  console.log("ok 2 a removed CLI stays removed across a launch; the others keep theirs");

  const both = await Promise.all([
    mcp.uninstallSparkBuiltin("codara-studio", "codex"),
    mcp.uninstallSparkBuiltin("codara-studio", "grok"),
  ]);
  assert.deepEqual(both, [{ ok: true }, { ok: true }]);
  assert.deepEqual(optedOut(), ["claude", "codex", "grok"]);
  await mcp.installSparkPreviewMcpAtBoot();
  assert.deepEqual(present(), { claude: false, codex: false, grok: false });
  assert.match(fs.readFileSync(CODEX_TOML, "utf8"), /\[mcp_servers\.hand-written\]/);
  console.log("ok 3 removals issued together are both recorded");

  assert.equal(available(), false);
  console.log("ok 4 worker prompts stop advertising the tools once every CLI is off");

  assert.deepEqual(await mcp.installSparkBuiltin("codara-studio", "claude"), { ok: true });
  assert.deepEqual(optedOut(), ["codex", "grok"]);
  assert.equal(available(), true);
  await mcp.installSparkPreviewMcpAtBoot();
  assert.deepEqual(present(), { claude: true, codex: false, grok: false });
  const status = await mcp.getSparkBuiltinStatus({
    claudeRuntimeAvailable: true,
    codexRuntimeAvailable: true,
    grokRuntimeAvailable: true,
    autoInstallEnabled: true,
  });
  assert.deepEqual(
    [status[0].claude.state, status[0].codex.state, status[0].grok.state],
    ["installed", "available", "available"],
  );
  console.log("ok 5 adding it back clears the record and launch keeps it current");

  const otherCodexHome = path.join(FAKE_HOME, "other-codex");
  fs.mkdirSync(otherCodexHome, { recursive: true, mode: 0o700 });
  await mcp.installSparkBuiltin("codara-studio", "codex");
  assert.deepEqual(optedOut(), ["grok"]);
  assert.deepEqual(
    await mcp.uninstallSparkBuiltin("codara-studio", "codex", { codexHome: otherCodexHome }),
    { ok: true },
  );
  assert.deepEqual(optedOut(), ["grok"]);
  assert.equal(tomlHasBuiltin(CODEX_TOML), true);
  console.log("ok 6 a removal from a caller-supplied Codex home is not the user's switch");

  const workspace = path.join(FAKE_HOME, "workspace");
  fs.mkdirSync(workspace);
  const sync = await bundle("agent-sync.ts", "agent-sync");
  const result = await sync.syncAgentAssets({ cwd: workspace });
  const projectServers = Object.keys(
    JSON.parse(fs.readFileSync(path.join(workspace, ".mcp.json"), "utf8")).mcpServers,
  );
  assert.deepEqual(projectServers, ["hand-written"]);
  assert.equal(result.mcp.toClaude.includes("codara-studio"), false);
  console.log("ok 7 a sync never copies the built-in into a project .mcp.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
