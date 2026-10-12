#!/usr/bin/env node
"use strict";

// The Capability Center switches the built-in codara-studio server per CLI.
// Codara passes the server on the command line of the sessions it starts, so
// the switch is a record in Codara's home, and only the opt-in "Codara tools
// in other apps" touches the CLIs' own configs. This drives the real
// main-process mcp-installer and agent-sync against a throwaway fake home, so
// nothing here can reach the user's real ~/.claude.json, ~/.codex or ~/.grok.
//
// Proven here:
//   1. Without the opt-in, switching off and on records the choice and leaves
//      all three CLI configs byte for byte as they were.
//   2. Two removals issued together are both recorded.
//   3. Once Claude and Codex are both off, worker prompts stop advertising
//      the tools; switching one back on clears its record.
//   4. The opt-in adds the server to every CLI that is not switched off and
//      whose binary exists, beside the user's own servers.
//   5. While the opt-in is on, a switch also edits that CLI's config, and
//      turning the opt-in off removes exactly Codara's entries.
//   6. A Claude/Codex sync keeps scope: the user's Codex server reaches the
//      user's Claude config, nothing lands in a project .mcp.json, and the
//      built-in is never copied.
//   7. Adding the opt-in entry to a Claude config that cannot be parsed
//      reports a failure and leaves the file as it was.

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

// electron is stubbed for codara-home/bundled-resources; binary lookup answers
// without spawning the user's login shell; and the checkout is not treated as
// a transient build, which the opt-in otherwise refuses to point configs at.
const stubPlugin = {
  name: "codara-test-stubs",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "codara-test" }));
    pluginBuild.onResolve({ filter: /binary-resolver$/ }, () => ({ path: "binary-resolver", namespace: "codara-test" }));
    pluginBuild.onResolve({ filter: /^\.\/hook-installer$/ }, () => ({ path: "hook-installer", namespace: "codara-test" }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "codara-test" }, (args) => ({
      contents:
        args.path === "electron"
          ? `export const app = {
              isPackaged: false,
              getAppPath: () => ${JSON.stringify(ROOT)},
              getPath: () => ${JSON.stringify(FAKE_HOME)}
            };`
          : args.path === "hook-installer"
            ? "export async function isTransientPath() { return false; } export async function isTemporaryRoot() { return false; }"
            : "export async function resolveBinary(name) { return globalThis.__installedClis.has(name) ? '/fake/bin/' + name : null; }",
      loader: "js",
    }));
  },
};
globalThis.__installedClis = new Set(["claude", "codex", "grok"]);

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

function snapshot() {
  return [CLAUDE_JSON, CODEX_TOML, GROK_TOML].map((file) => fs.readFileSync(file, "utf8"));
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
  const available = () => mcp.isSparkPreviewMcpAvailable({ cwd: null });
  const status = async () => {
    const [entry] = await mcp.getSparkBuiltinStatus({
      claudeRuntimeAvailable: true,
      codexRuntimeAvailable: true,
      grokRuntimeAvailable: false,
    });
    return [entry.claude.state, entry.codex.state, entry.grok.state];
  };

  const before = snapshot();
  assert.deepEqual(await status(), ["installed", "installed", "unavailable"]);
  assert.deepEqual(await mcp.uninstallSparkBuiltin("codara-studio", "claude"), { ok: true });
  assert.deepEqual(optedOut(), ["claude"]);
  assert.deepEqual(await status(), ["available", "installed", "unavailable"]);
  assert.deepEqual(await mcp.installSparkBuiltin("codara-studio", "claude"), { ok: true });
  assert.deepEqual(optedOut(), []);
  assert.deepEqual(snapshot(), before, "a switch without the opt-in wrote a CLI config");
  console.log("ok 1 without the opt-in a switch is a record in Codara's home only");

  const both = await Promise.all([
    mcp.uninstallSparkBuiltin("codara-studio", "claude"),
    mcp.uninstallSparkBuiltin("codara-studio", "codex"),
  ]);
  assert.deepEqual(both, [{ ok: true }, { ok: true }]);
  assert.deepEqual(optedOut(), ["claude", "codex"]);
  console.log("ok 2 removals issued together are both recorded");

  assert.equal(available(), false);
  assert.deepEqual(await mcp.installSparkBuiltin("codara-studio", "claude"), { ok: true });
  assert.deepEqual(optedOut(), ["codex"]);
  assert.equal(available(), true);
  assert.deepEqual(snapshot(), before);
  console.log("ok 3 worker prompts follow the switches; switching back on clears the record");

  globalThis.__installedClis = new Set(["claude", "codex"]);
  assert.deepEqual(await mcp.installStudioToolsInOtherApps(), { ok: true });
  assert.deepEqual(present(), { claude: true, codex: false, grok: false }, "an opted-out or missing CLI got the entry");
  const claudeConfig = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8"));
  assert.deepEqual(Object.keys(claudeConfig.mcpServers).sort(), ["codara-studio", "mine"]);
  globalThis.__installedClis = new Set(["claude", "codex", "grok"]);
  console.log("ok 4 the opt-in adds the server only where the switch is on and the CLI exists");

  assert.deepEqual(await mcp.installSparkBuiltin("codara-studio", "codex", { otherApps: true }), { ok: true });
  assert.equal(tomlHasBuiltin(CODEX_TOML), true);
  assert.deepEqual(await mcp.installSparkBuiltin("codara-studio", "grok", { otherApps: true }), { ok: true });
  assert.equal(tomlHasBuiltin(GROK_TOML), true);
  assert.deepEqual(await mcp.uninstallSparkBuiltin("codara-studio", "codex", { otherApps: true }), { ok: true });
  assert.equal(tomlHasBuiltin(CODEX_TOML), false);
  assert.match(fs.readFileSync(CODEX_TOML, "utf8"), /\[mcp_servers\.hand-written\]/);
  assert.deepEqual(await mcp.removeStudioToolsFromOtherApps(), { ok: true });
  assert.deepEqual(present(), { claude: false, codex: false, grok: false });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8")).mcpServers), ["mine"]);
  assert.equal(fs.readFileSync(GROK_TOML, "utf8").trim(), 'model = "grok-4"');
  console.log("ok 5 with the opt-in on the switch edits the CLI config; turning it off removes exactly Codara's entries");

  const workspace = path.join(FAKE_HOME, "workspace");
  fs.mkdirSync(workspace);
  const sync = await bundle("agent-sync.ts", "agent-sync");
  const result = await sync.syncAgentAssets({ cwd: workspace });
  assert.equal(fs.existsSync(path.join(workspace, ".mcp.json")), false, "a user server leaked into the project");
  const userServers = Object.keys(JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8")).mcpServers);
  assert.ok(userServers.includes("hand-written"), "the user's Codex server did not reach the user's Claude config");
  assert.equal(result.mcp.toClaude.includes("codara-studio"), false);
  assert.equal(userServers.includes("codara-studio"), false);
  console.log("ok 6 a sync keeps scope and never copies the built-in");

  fs.writeFileSync(CLAUDE_JSON, "{ not json");
  const failed = await mcp.installSparkBuiltin("codara-studio", "claude", { otherApps: true });
  assert.equal(failed.ok, false, "an unwritable Claude config was reported as updated");
  assert.ok(failed.error, "the failure carries a message");
  assert.equal(fs.readFileSync(CLAUDE_JSON, "utf8"), "{ not json");
  console.log("ok 7 a failed opt-in write reports the failure and leaves the file alone");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
