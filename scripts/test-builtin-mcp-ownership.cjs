#!/usr/bin/env node
"use strict";

// Ownership of the built-in codara-studio entry in a TOML config (Codex, Grok)
// cannot rest on the `# >>> SPARK_AGENT_BUILTIN_MCP` comment markers: both CLIs
// rewrite their own config.toml and drop them, after which the Capability
// Center used to demote Codara's own entry to "Set up by you" and refuse to
// remove it. This drives the real main-process mcp-installer functions against
// a throwaway fake home, so nothing here can reach the user's real
// ~/.codex/config.toml or ~/.grok/config.toml.
//
// Proven here:
//   1. A Codara-shaped [mcp_servers."codara-studio"] section with NO markers,
//      whose server.js exists, reports state "installed" for Codex.
//   2. The same for Grok.
//   3. A codara-studio section that is NOT ours still reports "user-managed",
//      and its uninstall is still refused with the unchanged wording, leaving a
//      byte-identical file.
//   4. The pre-existing stranded case (our shape, server.js gone) still
//      classifies as "stale", still reports "available", and is still
//      removable.
//   5. A reclaimed entry is repaired in place: repairSparkBuiltinEntries
//      re-wraps it in fresh markers, keeps the user's own sections, and the
//      result is then removable.
//
// Homedir technique copied from scripts/test-grok-mcp-copy.cjs; the esbuild +
// electron-stub bundling from scripts/test-codex-home-routing.cjs (mcp-installer
// pulls in electron through bundled-resources/codara-home).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
// realpath the tmp root: macOS resolves /var to /private/var, and the installer
// resolves realpath before renaming, so the two must already agree.
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const FAKE_HOME = fs.mkdtempSync(path.join(TMP_ROOT, "codara-builtin-ownership-"));

const realHomedir = os.homedir;
const previousEnv = {
  HOME: process.env.HOME,
  CODARA_HOME_DIR: process.env.CODARA_HOME_DIR,
  SPARK_HOME_DIR: process.env.SPARK_HOME_DIR,
  SPARK_USER_DATA_DIR: process.env.SPARK_USER_DATA_DIR,
};
os.homedir = () => FAKE_HOME;
process.env.HOME = FAKE_HOME;
// A temp-dir home override would make the installer treat itself as sandboxed
// and refuse every write; drop them so codaraHome() resolves under FAKE_HOME.
delete process.env.CODARA_HOME_DIR;
delete process.env.SPARK_HOME_DIR;
delete process.env.SPARK_USER_DATA_DIR;
process.on("exit", () => {
  os.homedir = realHomedir;
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

const electronStubPlugin = {
  name: "electron-stub",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^electron$/ }, () => ({
      path: "electron",
      namespace: "codara-test",
    }));
    pluginBuild.onLoad({ filter: /^electron$/, namespace: "codara-test" }, () => ({
      contents: `export const app = {
          isPackaged: false,
          getAppPath: () => ${JSON.stringify(ROOT)},
          getPath: () => ${JSON.stringify(FAKE_HOME)}
        };`,
      loader: "js",
    }));
  },
};

async function bundleMcpInstaller() {
  const outfile = path.join(FAKE_HOME, "mcp-installer.bundle.cjs");
  await build({
    entryPoints: [path.join(ROOT, "src", "main", "mcp-installer.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    plugins: [electronStubPlugin],
    logLevel: "silent",
  });
  return require(outfile);
}

// An install layout that exists on disk, and one that does not. Only the second
// is "stranded"; ownership must not depend on the difference.
const LIVE_RESOURCE_DIR = path.join(FAKE_HOME, "Applications", "Codara.app", "codara-studio-mcp");
const LIVE_SCRIPT = path.join(LIVE_RESOURCE_DIR, "server.js");
const GONE_SCRIPT = path.join(FAKE_HOME, "removed-install", "codara-studio-mcp", "server.js");
fs.mkdirSync(LIVE_RESOURCE_DIR, { recursive: true });
fs.writeFileSync(LIVE_SCRIPT, "// fake bundled MCP server\n");

const USER_SECTION = ["[mcp_servers.hand-written]", 'command = "my-server"', "enabled = true"];

// What Codex/Grok leave behind after rewriting their own config: our entry,
// verbatim, with the marker comments gone.
function codaraShapedConfig(script) {
  return [
    'model = "gpt-5-codex"',
    "",
    ...USER_SECTION,
    "",
    '[mcp_servers."codara-studio"]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(script)}]`,
    "enabled = true",
    "",
    '[mcp_servers."codara-studio".env]',
    'ELECTRON_RUN_AS_NODE = "1"',
    `SPARK_HOME_DIR = ${JSON.stringify(path.join(FAKE_HOME, ".Codara"))}`,
    "",
  ].join("\n");
}

// A genuinely hand-written entry that happens to share the name: another
// command, no ELECTRON_RUN_AS_NODE, args pointing at some other script.
function foreignConfig() {
  return [
    ...USER_SECTION,
    "",
    '[mcp_servers."codara-studio"]',
    'command = "node"',
    'args = ["/opt/my-tools/studio-clone/index.js"]',
    "enabled = true",
    "",
  ].join("\n");
}

let caseCount = 0;
function makeCase({ codex, grok }) {
  caseCount += 1;
  const base = path.join(FAKE_HOME, `case-${caseCount}`);
  const codexHome = path.join(base, ".codex");
  const grokHome = path.join(base, ".grok");
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(grokHome, { recursive: true, mode: 0o700 });
  const codexPath = path.join(codexHome, "config.toml");
  const grokPath = path.join(grokHome, "config.toml");
  if (codex) fs.writeFileSync(codexPath, codex, { mode: 0o600 });
  if (grok) fs.writeFileSync(grokPath, grok, { mode: 0o600 });
  return { codexHome, grokHome, codexPath, grokPath };
}

const results = [];
async function check(name, fn) {
  await fn();
  results.push(name);
}

async function main() {
  const mcp = await bundleMcpInstaller();
  const { CODEX_BLOCK_START, CODEX_BLOCK_END, classifyCodexBuiltinSection } = mcp.__test;

  // Nothing below may name a path outside the fake home.
  const realHome = realHomedir();
  const assertFake = (p) => {
    assert.equal(p.startsWith(FAKE_HOME), true, `${p} escaped the fake home`);
    assert.equal(p.startsWith(path.join(realHome, ".codex")), false);
    assert.equal(p.startsWith(path.join(realHome, ".grok")), false);
  };

  const statusFor = (target) =>
    mcp.getSparkBuiltinStatus({
      claudeRuntimeAvailable: false,
      codexRuntimeAvailable: true,
      grokRuntimeAvailable: true,
      autoInstallEnabled: true,
      codexHome: target.codexHome,
      grokHome: target.grokHome,
    });

  // ── 1. Codex: our shape, markers gone, install alive ───────────────────────
  await check("a marker-less Codara-shaped Codex entry reports installed", async () => {
    const target = makeCase({ codex: codaraShapedConfig(LIVE_SCRIPT) });
    assertFake(target.codexPath);
    const before = fs.readFileSync(target.codexPath);
    const [status] = await statusFor(target);
    assert.equal(status.codex.state, "installed");
    assert.equal(status.codex.configPath, target.codexPath);
    assert.equal(
      classifyCodexBuiltinSection(before.toString("utf8")),
      "reclaimable",
      "a live Codara-shaped section must be classified as ours",
    );
    assert.equal(
      fs.readFileSync(target.codexPath).equals(before),
      true,
      "detection must not rewrite the config",
    );
  });

  // ── 2. Grok: same entry, same verdict ──────────────────────────────────────
  await check("a marker-less Codara-shaped Grok entry reports installed", async () => {
    const target = makeCase({ grok: codaraShapedConfig(LIVE_SCRIPT) });
    assertFake(target.grokPath);
    const [status] = await statusFor(target);
    assert.equal(status.grok.state, "installed");
    assert.equal(status.grok.configPath, target.grokPath);
  });

  // ── 3. A section that is NOT ours stays untouchable ────────────────────────
  await check("a foreign codara-studio section stays user-managed and unremovable", async () => {
    const target = makeCase({ codex: foreignConfig(), grok: foreignConfig() });
    assert.equal(classifyCodexBuiltinSection(foreignConfig()), "user");
    const [status] = await statusFor(target);
    assert.equal(status.codex.state, "user-managed");
    assert.equal(status.grok.state, "user-managed");

    const expectedError =
      "A user-defined codara-studio section exists in config.toml; Codara won't remove it.";
    for (const [runtime, configPath, options] of [
      ["codex", target.codexPath, { codexHome: target.codexHome }],
      ["grok", target.grokPath, { grokHome: target.grokHome }],
    ]) {
      const before = fs.readFileSync(configPath);
      const result = await mcp.uninstallSparkBuiltin("codara-studio", runtime, options);
      assert.deepEqual(result, { ok: false, error: expectedError }, `${runtime} uninstall wording`);
      assert.equal(
        fs.readFileSync(configPath).equals(before),
        true,
        `${runtime} config changed even though the uninstall was refused`,
      );
    }

    // An install pass must leave it alone too.
    const beforeInstall = fs.readFileSync(target.codexPath);
    await mcp.installSparkPreviewMcpForCodex(true, { codexHome: target.codexHome });
    assert.equal(
      fs.readFileSync(target.codexPath).equals(beforeInstall),
      true,
      "install overwrote a user-owned codara-studio section",
    );
  });

  // ── 4. The stranded case behaves exactly as it did before ──────────────────
  await check("a stranded Codara entry stays stale, available and removable", async () => {
    assert.equal(fs.existsSync(GONE_SCRIPT), false, "precondition: the install path is gone");
    const target = makeCase({
      codex: codaraShapedConfig(GONE_SCRIPT),
      grok: codaraShapedConfig(GONE_SCRIPT),
    });
    assert.equal(classifyCodexBuiltinSection(codaraShapedConfig(GONE_SCRIPT)), "stale");
    const [status] = await statusFor(target);
    assert.equal(status.codex.state, "available");
    assert.equal(status.grok.state, "available");

    const repaired = await mcp.repairSparkBuiltinEntries({
      codexHome: target.codexHome,
      grokHome: target.grokHome,
    });
    assert.equal(repaired.codex, true, "a stranded Codex entry must still be repaired in place");
    assert.equal(repaired.grok, true, "a stranded Grok entry must still be repaired in place");
    const repairedText = fs.readFileSync(target.codexPath, "utf8");
    assert.ok(repairedText.includes(CODEX_BLOCK_START) && repairedText.includes(CODEX_BLOCK_END));
    assert.doesNotMatch(repairedText, new RegExp(GONE_SCRIPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const removed = await mcp.uninstallSparkBuiltin("codara-studio", "codex", {
      codexHome: target.codexHome,
    });
    assert.deepEqual(removed, { ok: true });
    assert.doesNotMatch(fs.readFileSync(target.codexPath, "utf8"), /codara-studio/);
    assert.match(fs.readFileSync(target.codexPath, "utf8"), /^\[mcp_servers\.hand-written\]$/m);
  });

  // ── 5. A reclaimed live entry is repaired back inside fresh markers ────────
  await check("a reclaimed entry is re-wrapped in markers and then removable", async () => {
    const target = makeCase({
      codex: codaraShapedConfig(LIVE_SCRIPT),
      grok: codaraShapedConfig(LIVE_SCRIPT),
    });
    const repaired = await mcp.repairSparkBuiltinEntries({
      codexHome: target.codexHome,
      grokHome: target.grokHome,
    });
    assert.equal(repaired.codex, true, "a reclaimed Codex entry must be repairable without a click");
    assert.equal(repaired.grok, true, "a reclaimed Grok entry must be repairable without a click");

    for (const configPath of [target.codexPath, target.grokPath]) {
      const text = fs.readFileSync(configPath, "utf8");
      assert.ok(text.includes(CODEX_BLOCK_START), `${configPath} lost the start marker`);
      assert.ok(text.includes(CODEX_BLOCK_END), `${configPath} lost the end marker`);
      const sections = text.match(/^\[mcp_servers\."codara-studio"\]$/gm) ?? [];
      assert.equal(sections.length, 1, `expected one codara-studio section, got ${sections.length}`);
      assert.match(text, /^model = "gpt-5-codex"$/m, "a top-level key the user wrote was dropped");
      assert.match(text, /^\[mcp_servers\.hand-written\]$/m, "a hand-written section was dropped");
    }

    const [status] = await statusFor(target);
    assert.equal(status.codex.state, "installed");
    assert.equal(status.grok.state, "installed");

    for (const [runtime, configPath, options] of [
      ["codex", target.codexPath, { codexHome: target.codexHome }],
      ["grok", target.grokPath, { grokHome: target.grokHome }],
    ]) {
      const removed = await mcp.uninstallSparkBuiltin("codara-studio", runtime, options);
      assert.deepEqual(removed, { ok: true }, `${runtime} uninstall must be allowed`);
      assert.doesNotMatch(fs.readFileSync(configPath, "utf8"), /codara-studio/);
    }
  });

  console.log(results.map((name) => `  ok  ${name}`).join("\n"));
  console.log(`PASS built-in MCP TOML ownership is decided by shape (${results.length} checks)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
