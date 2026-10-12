#!/usr/bin/env node
"use strict";

// The one-time cleanup of what earlier Codara builds wrote into the user's
// Claude Code, Codex and Grok configs (spec section 10). It may remove only
// what a Codara build generated, byte for byte, must back the original up
// first, must leave a file it cannot parse or that changed under it alone,
// and must keep every other byte of the user's files.
//
// SAFETY: every path is inside a throwaway fake home; the real configs are
// hashed before and after.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const REAL_FILES = [
  path.join(os.homedir(), ".claude", "settings.json"),
  path.join(os.homedir(), ".claude.json"),
  path.join(os.homedir(), ".codex", "config.toml"),
  path.join(os.homedir(), ".grok", "config.toml"),
];
const digest = (file) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "<absent>";
  }
};
const REAL_DIGESTS = REAL_FILES.map(digest);

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-global-cleanup-")));
const HOME = path.join(TMP, "home");
const CODARA = path.join(HOME, ".codarastudio");
fs.mkdirSync(CODARA, { recursive: true });
process.env.HOME = HOME;
process.env.CODARA_HOME_DIR = CODARA;
for (const key of ["SPARK_HOME_DIR", "SPARK_USER_DATA_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"]) delete process.env[key];

let passes = 0;
async function check(name, fn) {
  await fn();
  passes += 1;
  console.log(`PASS ${name}`);
}

async function bundle(entry, name) {
  const outfile = path.join(TMP, `${name}.cjs`);
  await build({
    entryPoints: [path.join(ROOT, "src", "main", entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    logLevel: "silent",
    plugins: [
      {
        name: "electron-stub",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
          pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents: `export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(ROOT)}, getPath: () => ${JSON.stringify(TMP)} };`,
            loader: "js",
          }));
        },
      },
    ],
  });
  return require(outfile);
}

let caseNo = 0;
function makeCase(files) {
  caseNo += 1;
  const dir = path.join(TMP, `case-${caseNo}`);
  const paths = {
    home: path.join(dir, "codara"),
    claudeSettingsPath: path.join(dir, ".claude", "settings.json"),
    claudeConfigPath: path.join(dir, ".claude.json"),
    codexConfigPath: path.join(dir, ".codex", "config.toml"),
    grokConfigPath: path.join(dir, ".grok", "config.toml"),
  };
  paths.managedClaudeRoot = path.join(paths.home, "claude-cli");
  // The fake home is a temp dir, so the installer's gate would refuse; the
  // cases that test that gate pass their own.
  paths.blockedReason = async () => null;
  // Every fake config sits in a temp dir; the gate cases say which are real.
  paths.isThrowawayPath = async () => false;
  // Each case's home stands for the user's own install.
  paths.defaultHome = paths.home;
  fs.mkdirSync(paths.home, { recursive: true });
  for (const [key, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(paths[key]), { recursive: true });
    fs.writeFileSync(paths[key], text, { mode: 0o640 });
  }
  return paths;
}
const read = (file) => fs.readFileSync(file, "utf8");

async function main() {
  const cleanup = await bundle("global-config-cleanup.ts", "cleanup");
  const hooks = await bundle("hook-installer.ts", "hooks");
  const notify = await bundle("codex-notify-installer.ts", "notify");
  const mcp = await bundle("mcp-installer.ts", "mcp");

  const script = path.join(HOME, ".codarastudio", "claude-hooks", "codara-hook.py");
  const hook = (event) => hooks.buildHookCommand("python3", script, event);
  const legacyHook = (event) => ({
    type: "command",
    command: `"python3" "${path.join(HOME, "wt", "resources", "claude-hooks", "spark-hook.py")}" ${event}`,
    _sparkManaged: true,
  });
  const userHook = { type: "command", command: "say done" };
  const serverFor = (home) => ({
    type: "stdio",
    command: "/opt/Codara/codara",
    args: ["/opt/Codara/resources/codara-studio-mcp/server.js"],
    env: { ELECTRON_RUN_AS_NODE: "1", SPARK_HOME_DIR: home },
    _sparkManaged: true,
    _sparkVersion: 7,
  });
  const managedServer = serverFor(CODARA);
  const renderedBlock = mcp.__test.renderCodexBlock({ timeouts: true });
  assert.ok(renderedBlock.includes(`SPARK_HOME_DIR = ${JSON.stringify(CODARA)}`));
  const blockFor = (home) => renderedBlock.replace(`SPARK_HOME_DIR = ${JSON.stringify(CODARA)}`, `SPARK_HOME_DIR = ${JSON.stringify(home)}`);
  const blockWithoutHome = renderedBlock.replace(/^SPARK_HOME_DIR = .*\n/m, "");
  const codexBlock = blockWithoutHome;
  const oldNotify = (previous) =>
    notify.buildCodexNotifyArgv("python3", path.join(CODARA, "codex-hooks", "codara-codex-notify.py"), previous);

  await check("Claude hooks: only Codara's handlers go, the user's stay", async () => {
    const settings = {
      model: "opus",
      hooks: {
        Stop: [{ hooks: [hook("Stop"), userHook] }],
        PreToolUse: [{ hooks: [hook("PreToolUse")] }],
        SessionStart: [{ hooks: [legacyHook("SessionStart")] }],
        Notification: [{ matcher: "", hooks: [hook("Notification")], description: "mine" }],
        PostToolUse: [],
      },
    };
    const original = `${JSON.stringify(settings, null, 4)}\n`;
    const target = makeCase({ claudeSettingsPath: original });
    const report = await cleanup.runGlobalConfigCleanup({ ...target, now: () => new Date("2026-10-12T10:00:00Z") });
    const after = JSON.parse(read(target.claudeSettingsPath));
    assert.deepEqual(after.hooks.Stop, [{ hooks: [userHook] }]);
    assert.equal(after.hooks.PreToolUse, undefined, "an event this pass emptied stays");
    assert.equal(after.hooks.SessionStart, undefined, "a legacy spark-hook.py entry stayed");
    assert.deepEqual(after.hooks.Notification, settings.hooks.Notification, "a group with the user's own key was touched");
    assert.deepEqual(after.hooks.PostToolUse, [], "an event the user left empty was dropped");
    assert.equal(after.model, "opus");
    assert.match(read(target.claudeSettingsPath), /^\{\n {4}"model"/, "the indent changed");
    assert.ok(read(target.claudeSettingsPath).endsWith("}\n"), "the trailing newline was lost");
    assert.equal(fs.statSync(target.claudeSettingsPath).mode & 0o777, 0o640, "the mode changed");

    const file = report.files.find((entry) => entry.path === target.claudeSettingsPath);
    assert.equal(file.result, "cleaned");
    assert.equal(file.removed.length, 3);
    assert.equal(read(file.backup), original, "the backup is not the original");
    assert.ok(file.backup.startsWith(path.join(target.home, "backups", "global-config-cleanup", "2026-10-12T10-00-00-000Z")));
    const manifest = JSON.parse(read(path.join(report.backupDir, "manifest.json")));
    assert.equal(manifest[0].sha256Before, crypto.createHash("sha256").update(original).digest("hex"));
    assert.equal(manifest[0].path, target.claudeSettingsPath);
  });

  await check("Claude hooks: an entry the user edited is left alone", async () => {
    const edited = { ...hook("Stop"), command: hook("Stop").command.replace(" Stop", " --quiet Stop") };
    const original = JSON.stringify({ hooks: { Stop: [{ hooks: [edited] }] } }, null, 2);
    const target = makeCase({ claudeSettingsPath: original });
    const report = await cleanup.runGlobalConfigCleanup(target);
    assert.equal(read(target.claudeSettingsPath), original);
    assert.equal(report.files[0].result, "nothing");
    assert.equal(report.backupDir, null);
    assert.equal(fs.existsSync(path.join(target.home, "backups")), false, "a backup was made for nothing");
  });

  await check("~/.claude.json: only the Codara-managed server goes", async () => {
    const target = makeCase({});
    const config = {
      numStartups: 4,
      mcpServers: {
        "codara-studio": serverFor(target.home),
        "cora-preview": { ...managedServer, args: ["/old/resources/cora-preview-mcp/server.js"], env: { ELECTRON_RUN_AS_NODE: "1" } },
        mine: { command: "mine" },
      },
      projects: { "/x": { allowedTools: [] } },
    };
    fs.writeFileSync(target.claudeConfigPath, JSON.stringify(config, null, 2));
    await cleanup.runGlobalConfigCleanup(target);
    const after = JSON.parse(read(target.claudeConfigPath));
    assert.deepEqual(Object.keys(after.mcpServers), ["mine"]);
    assert.deepEqual(after.projects, config.projects);
    assert.equal(after.numStartups, 4);
    assert.equal(fs.existsSync(`${target.claudeConfigPath}.lock`), false, "Claude's lock was left behind");
  });

  await check("~/.claude.json: a same-named server of the user's is kept", async () => {
    const config = {
      mcpServers: {
        "codara-studio": { command: "node", args: ["/home/me/clone/server.js"] },
        "spark-preview": { ...managedServer, cwd: "/mine" },
      },
    };
    const original = JSON.stringify(config, null, 2);
    const target = makeCase({ claudeConfigPath: original });
    const report = await cleanup.runGlobalConfigCleanup(target);
    assert.equal(read(target.claudeConfigPath), original);
    assert.equal(report.files.find((file) => file.path === target.claudeConfigPath).result, "nothing");
  });

  await check("with Codara tools in other apps on, the MCP entries stay", async () => {
    const claude = JSON.stringify({ mcpServers: { "codara-studio": managedServer } }, null, 2);
    const codex = `model = "gpt-6"\n\n${codexBlock}\n`;
    const target = makeCase({ claudeConfigPath: claude, codexConfigPath: codex, grokConfigPath: codex });
    await cleanup.runGlobalConfigCleanup({ ...target, keepMcpEntries: true });
    assert.equal(read(target.claudeConfigPath), claude);
    assert.equal(read(target.codexConfigPath), codex);
    assert.equal(read(target.grokConfigPath), codex);
  });

  await check("an MCP entry baked for another Codara home is that home's opt-in and stays", async () => {
    const target = makeCase({});
    const other = path.join(TMP, "other-codara-home");
    const claude = {
      mcpServers: {
        "codara-studio": serverFor(other),
        "spark-preview": { ...serverFor(`${target.home}${path.sep}`), args: ["/old/resources/spark-preview-mcp/server.js"] },
        "cora-preview": { ...serverFor(path.join(path.dirname(target.home), ".Cora")), args: ["/old/resources/cora-preview-mcp/server.js"] },
      },
    };
    fs.writeFileSync(target.claudeConfigPath, JSON.stringify(claude, null, 2));
    const otherToml = `model = "gpt-6"\n\n${blockFor(other)}\n`;
    for (const file of [target.codexConfigPath, target.grokConfigPath]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, otherToml);
    }
    const report = await cleanup.runGlobalConfigCleanup(target);
    assert.deepEqual(Object.keys(JSON.parse(read(target.claudeConfigPath)).mcpServers), ["codara-studio"], "this home's and its legacy home's entries go");
    assert.equal(JSON.parse(read(target.claudeConfigPath)).mcpServers["codara-studio"].env.SPARK_HOME_DIR, other);
    assert.equal(read(target.codexConfigPath), otherToml, "another home's Codex block was removed");
    assert.equal(read(target.grokConfigPath), otherToml, "another home's Grok block was removed");
    assert.equal(report.skipped, undefined);

    // A home reached through a link (~/.Codara is left pointing at the
    // renamed home) is the same home.
    const linked = path.join(TMP, `linked-home-${caseNo}`);
    fs.symlinkSync(target.home, linked);
    fs.writeFileSync(target.codexConfigPath, `model = "gpt-6"\n\n${blockFor(linked)}\n`);
    await cleanup.runGlobalConfigCleanup(target);
    assert.doesNotMatch(read(target.codexConfigPath), /codara-studio/, "this home's own block stayed");

    // Entries that carry no home were written by builds that only knew the
    // default one; another home leaves them.
    const unmarkedClaude = JSON.stringify({ mcpServers: { "codara-studio": { ...managedServer, env: { ELECTRON_RUN_AS_NODE: "1" } } } }, null, 2);
    const unmarkedToml = `model = "gpt-6"\n\n${blockWithoutHome}\n`;
    const custom = makeCase({ claudeConfigPath: unmarkedClaude, codexConfigPath: unmarkedToml, grokConfigPath: unmarkedToml });
    await cleanup.runGlobalConfigCleanup({ ...custom, defaultHome: path.join(TMP, "default-home") });
    assert.equal(read(custom.claudeConfigPath), unmarkedClaude, "a custom home removed an unmarked Claude entry");
    assert.equal(read(custom.codexConfigPath), unmarkedToml, "a custom home removed an unmarked Codex block");
    assert.equal(read(custom.grokConfigPath), unmarkedToml, "a custom home removed an unmarked Grok block");
    await cleanup.runGlobalConfigCleanup(custom);
    assert.deepEqual(JSON.parse(read(custom.claudeConfigPath)).mcpServers, {});
    assert.doesNotMatch(read(custom.codexConfigPath), /codara-studio/);
  });

  await check("a temporary home or a transient build leaves the user's own configs alone", async () => {
    const claude = JSON.stringify({ mcpServers: { "codara-studio": serverFor(CODARA) } }, null, 2);
    const codex = `${notify.setTopLevelNotify('model = "gpt-6"\n', oldNotify(["notify-send", "Codex"])).trimEnd()}\n\n${blockFor(CODARA)}\n`;
    const settings = JSON.stringify({ hooks: { Stop: [{ hooks: [hook("Stop")] }] } }, null, 2);
    for (const gate of [async () => "This Codara build runs from a temporary folder or a worktree.", undefined]) {
      const target = makeCase({ claudeSettingsPath: settings, claudeConfigPath: claude, codexConfigPath: codex, grokConfigPath: codex });
      const managedCopy = path.join(target.managedClaudeRoot, "accounts", "a1", "home", ".claude.json");
      fs.mkdirSync(path.dirname(managedCopy), { recursive: true });
      fs.writeFileSync(managedCopy, claude);
      // Without a gate of the test's own, the real one: this test's
      // CODARA_HOME_DIR is a temp dir.
      const report = await cleanup.runGlobalConfigCleanup({ ...target, home: CODARA, blockedReason: gate });
      assert.equal(read(target.claudeConfigPath), claude, "the user's opted-in Claude entry was removed");
      assert.equal(read(target.codexConfigPath), codex, "the user's Codex config was rewritten");
      assert.equal(read(target.grokConfigPath), codex, "the user's opted-in Grok block was removed");
      assert.equal(read(target.claudeSettingsPath), settings, "the user's Claude settings were rewritten");
      assert.ok(report.skipped, "the report does not say why nothing was cleaned");
      assert.deepEqual(JSON.parse(read(managedCopy)).mcpServers, {}, "Codara's own managed copy was not cleaned");
    }
    // A throwaway CLI home (an e2e run's fake HOME) is cleaned all the same.
    const target = makeCase({ claudeSettingsPath: settings, claudeConfigPath: claude, codexConfigPath: codex, grokConfigPath: codex });
    const report = await cleanup.runGlobalConfigCleanup({ ...target, home: CODARA, defaultHome: CODARA, blockedReason: undefined, isThrowawayPath: undefined });
    assert.match(report.skipped, /temporary home/);
    assert.deepEqual(JSON.parse(read(target.claudeConfigPath)).mcpServers, {});
    assert.deepEqual(JSON.parse(read(target.claudeSettingsPath)), { hooks: {} });
    assert.doesNotMatch(read(target.codexConfigPath), /codara-studio/);
    assert.match(read(target.codexConfigPath), /^notify = \["notify-send", "Codex"\]$/m);
    assert.doesNotMatch(read(target.grokConfigPath), /codara-studio/);
  });

  await check("Codex: the marked block goes and the user's notify comes back", async () => {
    const userText = 'model = "gpt-6"\n\n[mcp_servers.hand-written]\ncommand = "my-server"\n';
    const withNotify = notify.setTopLevelNotify(userText, oldNotify(["notify-send", "Codex"]));
    const original = `${withNotify.trimEnd()}\n\n${codexBlock}\n`;
    const target = makeCase({ codexConfigPath: original, grokConfigPath: `${userText}\n${codexBlock}\n` });
    const report = await cleanup.runGlobalConfigCleanup(target);
    const after = read(target.codexConfigPath);
    assert.doesNotMatch(after, /codara-studio|SPARK_AGENT_BUILTIN_MCP|codara-codex-notify/);
    assert.match(after, /^notify = \["notify-send", "Codex"\]$/m);
    assert.match(after, /^\[mcp_servers\.hand-written\]$/m);
    assert.doesNotMatch(read(target.grokConfigPath), /codara-studio/);
    assert.match(read(target.grokConfigPath), /^\[mcp_servers\.hand-written\]$/m);
    const codex = report.files.find((file) => file.path === target.codexConfigPath);
    assert.deepEqual(codex.removed, ["SPARK_AGENT_BUILTIN_MCP", "notify (your own value restored)"]);
  });

  await check("Codex: a block the user edited, and a file that does not parse, are left alone", async () => {
    const edited = codexBlock.replace("enabled = true", "enabled = true\ncwd = \"/mine\"");
    const target = makeCase({ codexConfigPath: `${edited}\n`, grokConfigPath: `${codexBlock}\nnotify = [\n` });
    const report = await cleanup.runGlobalConfigCleanup(target);
    assert.equal(read(target.codexConfigPath), `${edited}\n`);
    assert.equal(read(target.grokConfigPath), `${codexBlock}\nnotify = [\n`);
    assert.equal(report.files.find((file) => file.path === target.grokConfigPath).result, "parse-error-skip");
  });

  await check("a file that changes between read and write is left for the next boot", async () => {
    const original = JSON.stringify({ hooks: { Stop: [{ hooks: [hook("Stop")] }] } }, null, 2);
    const target = makeCase({ claudeSettingsPath: original });
    const userEdit = original.replace("{", '{\n  "model": "opus",');
    let report = await cleanup.runGlobalConfigCleanup({
      ...target,
      beforeReread: async (file) => fs.writeFileSync(file, userEdit),
    });
    assert.equal(report.files[0].result, "conflict-retry");
    assert.equal(read(target.claudeSettingsPath), userEdit, "the user's concurrent edit was lost");
    report = await cleanup.runGlobalConfigCleanup(target);
    assert.equal(report.files[0].result, "cleaned");
    assert.equal(JSON.parse(read(target.claudeSettingsPath)).model, "opus");
  });

  await check("a linked config is written through its link", async () => {
    const target = makeCase({});
    const real = path.join(TMP, `real-settings-${caseNo}.json`);
    fs.writeFileSync(real, JSON.stringify({ hooks: { Stop: [{ hooks: [hook("Stop")] }] } }));
    fs.mkdirSync(path.dirname(target.claudeSettingsPath), { recursive: true });
    fs.symlinkSync(real, target.claudeSettingsPath);
    await cleanup.runGlobalConfigCleanup(target);
    assert.equal(fs.lstatSync(target.claudeSettingsPath).isSymbolicLink(), true, "the link was replaced by a file");
    assert.deepEqual(JSON.parse(read(real)), { hooks: {} });
  });

  await check("Codara's own Claude homes are cleaned, links into ~/.claude are not followed", async () => {
    const original = JSON.stringify({ hooks: { Stop: [{ hooks: [hook("Stop")] }] } }, null, 2);
    const target = makeCase({ claudeSettingsPath: original });
    const privateHome = path.join(target.managedClaudeRoot, "accounts", "a1", "home");
    fs.mkdirSync(privateHome, { recursive: true });
    fs.writeFileSync(path.join(privateHome, "settings.json"), original);
    fs.writeFileSync(path.join(privateHome, ".claude.json"), JSON.stringify({ mcpServers: { "codara-studio": managedServer } }));
    const liveHome = path.join(target.managedClaudeRoot, "live", "home");
    fs.mkdirSync(liveHome, { recursive: true });
    fs.symlinkSync(target.claudeSettingsPath, path.join(liveHome, "settings.json"));
    const report = await cleanup.runGlobalConfigCleanup(target);
    assert.deepEqual(JSON.parse(read(path.join(privateHome, "settings.json"))), { hooks: {} });
    assert.deepEqual(JSON.parse(read(path.join(privateHome, ".claude.json"))), { mcpServers: {} });
    assert.equal(report.files.filter((file) => file.result === "cleaned").length, 3, "the linked file was processed twice");
  });

  await check("a later boot finds nothing; Settings still shows where the backup went", async () => {
    const original = JSON.stringify({ hooks: { Stop: [{ hooks: [hook("Stop")] }] } }, null, 2);
    const target = makeCase({ claudeSettingsPath: original });
    fs.writeFileSync(`${target.claudeSettingsPath}.codara-backup-2026-01-01`, "old");
    const first = await cleanup.runGlobalConfigCleanup(target);
    const second = await cleanup.runGlobalConfigCleanup(target);
    assert.equal(second.backupDir, null);
    assert.ok(second.files.every((file) => file.result === "nothing"));
    assert.deepEqual(second.leftoverBackups, [`${target.claudeSettingsPath}.codara-backup-2026-01-01`]);
    assert.equal(read(`${target.claudeSettingsPath}.codara-backup-2026-01-01`), "old", "a leftover backup was touched");
    const stored = await cleanup.readGlobalConfigCleanupReport(target.home);
    assert.equal(stored.lastCleaned.backupDir, first.backupDir);
    assert.equal(
      await cleanup.globalConfigCleanupNotice(target.home),
      `Removed Codara's old entries from your Claude Code and Codex config. Backup: ${first.backupDir}`,
    );
    assert.equal(await cleanup.globalConfigCleanupNotice(path.join(TMP, "never")), null);
  });

  assert.deepEqual(REAL_FILES.map(digest), REAL_DIGESTS, "a real config changed");
  console.log(`\nPASS global config cleanup: ${passes} checks`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
