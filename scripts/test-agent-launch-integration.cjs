#!/usr/bin/env node
"use strict";

// Codara's hooks, its codara-studio MCP server and Codex's notify program
// reach only the sessions Codara starts, as flags on their command line
// (agent-launch-integration.ts). This suite pins what those flags are, what
// the per-launch files under <codaraHome>/integrations contain, and that
// building them writes nothing outside Codara's home.
//
// SAFETY: HOME, CODARA_HOME_DIR and CODEX_HOME point into a throwaway
// directory before the module loads; the real configs are hashed before and
// after.

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
];
const digest = (file) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "<absent>";
  }
};
const REAL_DIGESTS = REAL_FILES.map(digest);

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-agent-launch-")));
const HOME = path.join(TMP, "home");
const CODARA = path.join(TMP, "codara home.d");
fs.mkdirSync(path.join(HOME, ".codex"), { recursive: true });
fs.mkdirSync(path.join(HOME, ".claude"), { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CODARA_HOME_DIR = CODARA;
process.env.CODEX_HOME = path.join(HOME, ".codex");
for (const key of ["SPARK_HOME_DIR", "SPARK_USER_DATA_DIR", "CLAUDE_CONFIG_DIR", "GROK_HOME"]) delete process.env[key];

let passes = 0;
async function check(name, fn) {
  await fn();
  passes += 1;
  console.log(`PASS ${name}`);
}

async function load() {
  const outfile = path.join(TMP, "agent-launch-integration.cjs");
  await build({
    entryPoints: [path.join(ROOT, "src", "main", "agent-launch-integration.ts")],
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

function tree(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

async function main() {
  console.warn = () => {};
  const { parse: parseToml } = require("smol-toml");
  const launch = await load();
  const userCodex = 'notify = ["notify-send", "Codex"]\nmodel = "gpt-6"\n';
  fs.writeFileSync(path.join(HOME, ".codex", "config.toml"), userCodex);
  const userHomeBefore = tree(HOME);

  const options = {
    home: CODARA,
    python: "python3",
    pythonAvailable: true,
    hookScriptSource: path.join(ROOT, "resources", "claude-hooks", "codara-hook.py"),
    notifyScriptSource: path.join(ROOT, "resources", "codex-hooks", "codara-codex-notify.py"),
  };
  const dir = path.join(CODARA, "integrations");

  await check("before boot writes the files, nothing is injected", async () => {
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: [] }), []);
    assert.deepEqual(launch.codexLaunchArgs({ userArgs: [], trustCwd: "/x" }), []);
    assert.equal(launch.agentArgsDir(), null);
  });

  const summary = await launch.writeIntegrationFiles(options);

  await check("boot writes the per-launch files under Codara's home only", async () => {
    assert.deepEqual(summary, { dir, claudeHooks: true, codexNotify: true });
    assert.equal(launch.agentArgsDir(), dir);
    assert.deepEqual(tree(HOME), userHomeBefore, "boot wrote into the user's home");
    const settings = JSON.parse(fs.readFileSync(path.join(dir, "claude", "settings.json"), "utf8"));
    assert.deepEqual(Object.keys(settings), ["hooks"]);
    assert.match(settings.hooks.Stop[0].hooks[0].command, /claude-hooks\/codara-hook\.py" Stop$/);
    assert.ok(fs.existsSync(path.join(CODARA, "claude-hooks", "codara-hook.py")));
    assert.ok(fs.existsSync(path.join(CODARA, "codex-hooks", "codara-codex-notify.py")));
    for (const mode of ["studio", "execute", "automation", "worker"]) {
      const config = JSON.parse(fs.readFileSync(path.join(dir, "claude", `mcp-${mode}.json`), "utf8"));
      const server = config.mcpServers["codara-studio"];
      assert.equal(server.type, "stdio");
      assert.match(server.args[0], /codara-studio-mcp[\\/]server\.js$/);
      assert.equal(server.env.SPARK_HOME_DIR, CODARA);
      assert.equal(server.env.SPARK_MCP_MODE, mode === "studio" ? undefined : mode, `${mode} roster`);
    }
    assert.equal((fs.statSync(path.join(dir, "claude", "settings.json")).mode & 0o777), 0o600);
  });

  const settingsPath = path.join(dir, "claude", "settings.json");
  const studioMcp = path.join(dir, "claude", "mcp-studio.json");

  await check("Claude: hooks and the server, with the user's own flags respected", async () => {
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: ["--model", "opus"] }), ["--settings", settingsPath, "--mcp-config", studioMcp]);
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: [], mode: "execute" }), [
      "--settings",
      settingsPath,
      "--mcp-config",
      path.join(dir, "claude", "mcp-execute.json"),
    ]);
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: ["--settings", "mine.json"] }), ["--mcp-config", studioMcp]);
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: ["--settings=mine.json"] }), ["--mcp-config", studioMcp]);
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: ["--strict-mcp-config"] }), ["--settings", settingsPath]);
    for (const first of ["mcp", "auth", "doctor", "--version", "-h"]) {
      assert.deepEqual(launch.claudeLaunchArgs({ userArgs: [first] }), [], `claude ${first}`);
    }
  });

  await check("Codex: server, chained notify and tui.notifications, and no trust unless asked", async () => {
    const args = launch.codexLaunchArgs({ userArgs: ["resume", "abc"] });
    assert.equal(args.length, 6);
    assert.deepEqual([args[0], args[2], args[4]], ["-c", "-c", "-c"]);
    const server = parseToml(args[1]).mcp_servers["codara-studio"];
    assert.match(server.args[0], /codara-studio-mcp[\\/]server\.js$/);
    assert.equal(server.env.SPARK_HOME_DIR, CODARA);
    assert.equal(server.tool_timeout_sec, 660);
    const notifyArgv = parseToml(args[3]).notify;
    assert.equal(notifyArgv[0], "python3");
    assert.equal(notifyArgv[3], path.join(CODARA, "codex-hooks", "codara-codex-notify.py"));
    assert.deepEqual(notifyArgv.slice(4), ["--", "notify-send", "Codex"], "the user's notify is not chained");
    assert.equal(args[5], "tui.notifications=true");
    assert.equal(launch.codexNotifyInjected(), true);
    for (const first of ["login", "logout", "mcp", "--version"]) {
      assert.deepEqual(launch.codexLaunchArgs({ userArgs: [first] }), [], `codex ${first}`);
    }
    const workerArgs = launch.codexLaunchArgs({ userArgs: [], mode: "worker" });
    assert.equal(parseToml(workerArgs[1]).mcp_servers["codara-studio"].env.SPARK_MCP_MODE, "worker");
  });

  await check("Codex trust is per launch and survives dots, quotes and non-ASCII in the path", async () => {
    const cwd = '/tmp/a.b/c "q"/café \u{1F600}';
    const args = launch.codexLaunchArgs({ userArgs: [], trustCwd: cwd });
    const trust = args[args.length - 1];
    assert.ok(/^[\x20-\x7e]+$/.test(trust), "the override must be plain ASCII");
    assert.equal(JSON.stringify(parseToml(trust).projects), JSON.stringify({ [cwd]: { trust_level: "trusted" } }));
    assert.equal(launch.codexTrustOverride("/a\nb"), null, "a control character cannot be passed");
    assert.throws(() => launch.tomlBasicString("\u0007"));
  });

  await check("the args files hold the typed-command defaults, one element per line", async () => {
    const claude = fs.readFileSync(path.join(dir, "claude", "args.txt"), "utf8").split("\n");
    assert.deepEqual(claude, ["--settings", settingsPath, "--mcp-config", studioMcp, ""]);
    const codex = fs.readFileSync(path.join(dir, "codex", "args.txt"), "utf8").split("\n");
    assert.equal(codex.filter((line) => line.startsWith("projects=")).length, 0, "a typed codex was pre-trusted");
    assert.ok(codex.includes("tui.notifications=true"));
  });

  await check("switching the server off for a CLI drops it from launches and the args files", async () => {
    fs.writeFileSync(path.join(CODARA, "builtin-mcp.json"), JSON.stringify({ version: 1, removedFrom: ["claude", "codex"] }));
    await launch.writeShellArgsFiles();
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: [] }), ["--settings", settingsPath]);
    assert.ok(!launch.codexLaunchArgs({ userArgs: [] }).some((arg) => arg.startsWith("mcp_servers.")));
    assert.ok(!fs.readFileSync(path.join(dir, "claude", "args.txt"), "utf8").includes("--mcp-config"));
    fs.rmSync(path.join(CODARA, "builtin-mcp.json"));
    await launch.writeShellArgsFiles();
  });

  await check("a user who set tui.notifications keeps it; no python means no hooks or notify", async () => {
    launch.resetAgentLaunchIntegrationForTests();
    const result = await launch.writeIntegrationFiles({
      ...options,
      pythonAvailable: false,
      codexConfigText: '[tui]\nnotifications = ["agent-turn-complete"]\n',
    });
    assert.deepEqual([result.claudeHooks, result.codexNotify], [false, false]);
    assert.equal(fs.existsSync(settingsPath), false, "a stale hooks file was left for --settings");
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: [] }), ["--mcp-config", studioMcp]);
    const args = launch.codexLaunchArgs({ userArgs: [] });
    assert.equal(args.length, 2, args.join(" "));
    assert.equal(launch.codexNotifyInjected(), false);
    assert.equal(
      (await launch.writeIntegrationFiles({ ...options, codexNotify: false })).codexNotify,
      false,
      "SPARK_CODEX_NOTIFY=0 still injected notify",
    );
  });

  await check("a pane never waits on boot for more than the bound", async () => {
    // The bound's timer is unref'd so it never holds the app open; keep this
    // process alive while it runs.
    const keepAlive = setInterval(() => {}, 1000);
    launch.setIntegrationBootPass(new Promise(() => {}));
    const started = Date.now();
    await launch.integrationFilesReady(50);
    assert.ok(Date.now() - started < 1000);
    launch.setIntegrationBootPass(Promise.reject(new Error("boot failed")));
    await launch.integrationFilesReady(1000);
    clearInterval(keepAlive);
  });

  assert.deepEqual(REAL_FILES.map(digest), REAL_DIGESTS, "a real config changed");
  console.log(`\nPASS agent launch integration: ${passes} checks`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
