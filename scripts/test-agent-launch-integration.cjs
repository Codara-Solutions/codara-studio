#!/usr/bin/env node
"use strict";

// Codara's hooks, its codara-studio MCP server and Codex's notify program
// reach only the sessions Codara starts, as flags on their command line
// (agent-launch-integration.ts). This suite pins what those flags are, what
// the per-launch files under <codaraHome>/integrations contain, and that
// building them writes nothing outside Codara's home. A session another agent
// starts (codara_session_start, agent-sessions.ts) gets the same flags through
// a real shell, and the server they name offers it the session tools with the
// cleared environment Codex gives its MCP servers.
//
// SAFETY: HOME, CODARA_HOME_DIR and CODEX_HOME point into a throwaway
// directory before the module loads; the real configs are hashed before and
// after.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
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

async function loadSessions() {
  const outfile = path.join(TMP, "agent-sessions.cjs");
  await build({
    entryPoints: [path.join(ROOT, "src", "main", "agent-sessions.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    logLevel: "silent",
    external: ["electron"],
    alias: { "@shared": path.join(ROOT, "src", "shared") },
  });
  return require(outfile);
}

// initialize + tools/list against one server process; resolves the tool names.
function serverTools(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timeout waiting for tools/list"));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
      for (let index = out.indexOf("\n"); index >= 0; index = out.indexOf("\n")) {
        const line = out.slice(0, index).trim();
        out = out.slice(index + 1);
        let message = null;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 2 && message.result) {
          clearTimeout(timer);
          child.kill();
          resolve(message.result.tools.map((tool) => tool.name));
        }
      }
    });
    child.on("error", reject);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  });
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

  await check("before boot writes the files, nothing is injected, but panes already get the folder", async () => {
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: [] }), []);
    assert.deepEqual(launch.codexLaunchArgs({ userArgs: [], trustCwd: "/x" }), []);
    assert.equal(launch.agentArgsDir(), dir, "a pane spawned before the boot pass would never wrap claude or codex");
  });

  const summary = await launch.writeIntegrationFiles(options);

  await check("boot writes the per-launch files under Codara's home only", async () => {
    assert.deepEqual(summary, { dir, claudeHooks: true, codexNotify: true });
    assert.equal(launch.agentArgsDir(), dir);
    assert.deepEqual(tree(HOME), userHomeBefore, "boot wrote into the user's home");
    const settings = JSON.parse(fs.readFileSync(path.join(dir, "claude", "settings.json"), "utf8"));
    assert.deepEqual(Object.keys(settings), ["hooks", "env"]);
    assert.deepEqual(settings.env, { FORCE_HYPERLINK: "1" }, "Claude prints its file links as OSC 8 hyperlinks in Codara's terminal");
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
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: ["--model", "opus"] }), ["--settings", settingsPath, `--mcp-config=${studioMcp}`]);
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: [], mode: "execute" }), [
      "--settings",
      settingsPath,
      `--mcp-config=${path.join(dir, "claude", "mcp-execute.json")}`,
    ]);
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: ["--settings", "mine.json"] }), [`--mcp-config=${studioMcp}`]);
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: ["--settings=mine.json"] }), [`--mcp-config=${studioMcp}`]);
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: ["--strict-mcp-config"] }), ["--settings", settingsPath]);
    for (const first of ["mcp", "auth", "doctor", "--version", "-h", "agents", "attach", "logs", "rm", "stop", "upgrade", "plugins", "purge", "respawn", "ultrareview"]) {
      assert.deepEqual(launch.claudeLaunchArgs({ userArgs: [first] }), [], `claude ${first}`);
    }
  });

  // Claude Code declares `--mcp-config <configs...>` with commander, which
  // keeps feeding a variadic option every following word that is not a flag
  // and ends it only at a flag; `--opt=value` takes exactly one value.
  const variadicValues = (argv, flag) => {
    const values = [];
    let active = false;
    for (const arg of argv) {
      if (arg === "--") break;
      if (active && !arg.startsWith("-")) {
        values.push(arg);
        continue;
      }
      active = arg === flag;
      if (arg.startsWith(`${flag}=`)) values.push(arg.slice(flag.length + 1));
    }
    return values;
  };

  await check("Claude: a prompt or a subcommand after Codara's flags is not read as an MCP config", async () => {
    assert.deepEqual(variadicValues(["--mcp-config", "m.json", "a prompt"], "--mcp-config"), ["m.json", "a prompt"], "the model of commander is wrong");
    for (const userArgs of [["fix the failing test"], ["fix it", "-p"], ["--model", "opus", "fix it"], ["agents"], ["logs", "abc"]]) {
      const argv = [...launch.claudeLaunchArgs({ userArgs }), ...userArgs];
      assert.deepEqual(
        variadicValues(argv, "--mcp-config"),
        launch.claudeLaunchArgs({ userArgs }).length > 0 ? [studioMcp] : [],
        argv.join(" "),
      );
    }
    const typed = fs.readFileSync(path.join(dir, "claude", "args.txt"), "utf8").split("\n").filter(Boolean);
    assert.deepEqual(variadicValues([...typed, "fix the failing test"], "--mcp-config"), [studioMcp]);
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

  await check("Claude and Codex start the same server, with the same environment, for every roster", async () => {
    for (const mode of ["studio", "execute", "automation", "worker"]) {
      const claude = JSON.parse(fs.readFileSync(path.join(dir, "claude", `mcp-${mode}.json`), "utf8")).mcpServers["codara-studio"];
      const codex = JSON.parse(JSON.stringify(parseToml(launch.codexStudioServerOverride(mode)).mcp_servers["codara-studio"]));
      assert.deepEqual(
        { command: codex.command, args: codex.args, env: codex.env },
        { command: claude.command, args: claude.args, env: claude.env },
        `${mode}: the same tools for every runtime`,
      );
    }
  });

  await check("a started session gets the same flags as a Studio tab, through a real shell", async () => {
    const sessions = await loadSessions();
    const bin = path.join(TMP, "bin");
    fs.mkdirSync(bin, { recursive: true });
    for (const name of ["claude", "codex"]) {
      fs.writeFileSync(path.join(bin, name), "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n", { mode: 0o755 });
    }
    const briefPath = path.join(TMP, "it's a brief", "brief.md");
    fs.mkdirSync(path.dirname(briefPath), { recursive: true });
    fs.writeFileSync(briefPath, "Do the thing. $(not run) `nor this`");
    const cwd = path.join(TMP, "work 'tree'");
    const plan = (runtime) => (sessionArgs) =>
      runtime === "codex"
        ? launch.planCodexLaunch({ userArgs: sessionArgs }).argvPrefix
        : launch.planClaudeLaunch({ userArgs: sessionArgs }).argvPrefix;
    const shells = ["bash", ...(fs.existsSync("/usr/bin/zsh") || fs.existsSync("/bin/zsh") ? ["zsh"] : [])];
    const run = (line) =>
      shells.map((shell) =>
        JSON.parse(
          execFileSync(shell, shell === "zsh" ? ["-f", "-c", line] : ["-c", line], {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
            encoding: "utf8",
          }),
        ),
      );
    const codexLine = sessions.agentSessionCommand({
      runtime: "codex",
      model: "gpt-6",
      effort: "high",
      briefPath,
      codexTrust: launch.codexTrustOverride(cwd),
      launchArgs: plan("codex"),
      platform: "linux",
    });
    for (const argv of run(codexLine)) {
      const values = argv.flatMap((arg, index) => (argv[index - 1] === "-c" ? [arg] : []));
      const server = parseToml(values.find((value) => value.startsWith("mcp_servers.")) ?? "").mcp_servers?.["codara-studio"];
      assert.ok(server, "a Codex session gets Codara's current server, not the one the user's config names");
      assert.match(server.args[0], /codara-studio-mcp[\\/]server\.js$/);
      assert.equal(server.env.SPARK_HOME_DIR, CODARA);
      const notify = parseToml(values.find((value) => value.startsWith("notify=")) ?? "").notify;
      assert.equal(notify?.[3], path.join(CODARA, "codex-hooks", "codara-codex-notify.py"), "a Codex session reports its turns");
      assert.deepEqual(JSON.parse(JSON.stringify(parseToml(values.find((value) => value.startsWith("projects=")) ?? "").projects)), {
        [cwd]: { trust_level: "trusted" },
      });
      assert.ok(argv.includes("--yolo") && argv.includes("gpt-6") && values.includes("model_reasoning_effort=high"), "model and effort kept");
      assert.deepEqual(argv.slice(-2), ["--", "Do the thing. $(not run) `nor this`"], "the brief is the last word, unexpanded");
      assert.equal(argv.indexOf("--"), argv.length - 2);
    }
    const claudeLine = sessions.agentSessionCommand({
      runtime: "claude",
      model: "opus",
      effort: "max",
      briefPath,
      codexTrust: null,
      launchArgs: plan("claude"),
      platform: "linux",
    });
    for (const argv of run(claudeLine)) {
      assert.deepEqual(argv.slice(0, 3), ["--settings", settingsPath, `--mcp-config=${studioMcp}`], "a Claude session does not lean on the user's hooks");
      assert.ok(argv.includes("--dangerously-skip-permissions") && argv.includes("opus") && argv.includes("max"));
      assert.deepEqual(argv.slice(-2), ["--", "Do the thing. $(not run) `nor this`"]);
    }
    const compacted = path.join(CODARA, "cli-launch", "claude-autocompact-80.json");
    const compactedLine = sessions.agentSessionCommand({
      runtime: "claude",
      model: null,
      effort: null,
      briefPath,
      codexTrust: null,
      compaction: { claudeSettingsPath: compacted },
      launchArgs: plan("claude"),
      platform: "linux",
    });
    for (const argv of run(compactedLine)) {
      assert.deepEqual(argv.filter((arg) => arg === "--settings").length, 1, "Claude keeps only its last --settings");
      assert.equal(argv[argv.indexOf("--settings") + 1], compacted, "the compaction file, which carries the hooks itself");
      assert.ok(argv.includes(`--mcp-config=${studioMcp}`));
    }
  });

  await check("the server a Codex session is given offers it the session tools, with Codex's cleared environment", async () => {
    const server = parseToml(launch.codexStudioServerOverride("studio")).mcp_servers["codara-studio"];
    const tools = await serverTools(server.command, server.args, { PATH: process.env.PATH, HOME, ...server.env });
    for (const name of ["codara_session_start", "codara_session_wait", "codara_session_status", "codara_session_message"]) {
      assert.ok(tools.includes(name), `${name} missing`);
    }
  });

  await check("Codex trust is per launch and survives dots, quotes and non-ASCII in the path", async () => {
    const quoted = "/tmp/it's/a.b";
    const quotedTrust = launch.codexTrustOverride(quoted);
    assert.equal(JSON.stringify(parseToml(quotedTrust).projects), JSON.stringify({ [quoted]: { trust_level: "trusted" } }));
    const cwd = '/tmp/a.b/c "q"/café \u{1F600}';
    const args = launch.codexLaunchArgs({ userArgs: [], trustCwd: cwd });
    const trust = args[args.length - 1];
    assert.equal(trust, `projects={'${cwd}'={trust_level='trusted'}}`, "the path is passed as written, without escapes");
    assert.equal(JSON.stringify(parseToml(trust).projects), JSON.stringify({ [cwd]: { trust_level: "trusted" } }));
    assert.equal(launch.codexTrustOverride("/a\nb"), null, "a control character cannot be passed");
    assert.throws(() => launch.tomlBasicString("\u0007"));
    assert.throws(() => launch.tomlString("\u0007"));
    for (const value of ["C:\\Program Files\\Codara\\node.exe", "it's", "'quoted'", "a'''b", 'say "hi"']) {
      assert.equal(parseToml(`v = ${launch.tomlString(value)}`).v, value, value);
    }
    assert.equal(launch.tomlString("C:\\x\\node.exe"), "'C:\\x\\node.exe'");
    const notifyValue = launch.codexLaunchArgs({ userArgs: [] }).find((arg) => arg.startsWith("notify="));
    assert.ok(notifyValue && !notifyValue.includes('"'), "the notify launcher needs double quotes");
  });

  await check("the args files hold the typed-command defaults, one element per line", async () => {
    const claude = fs.readFileSync(path.join(dir, "claude", "args.txt"), "utf8").split("\n");
    assert.deepEqual(claude, ["--settings", settingsPath, `--mcp-config=${studioMcp}`, ""]);
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
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), { env: { FORCE_HYPERLINK: "1" } }, "a stale hooks entry was left for --settings");
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: [] }), ["--settings", settingsPath, `--mcp-config=${studioMcp}`]);
    const args = launch.codexLaunchArgs({ userArgs: [] });
    assert.equal(args.length, 2, args.join(" "));
    assert.equal(launch.codexNotifyInjected(), false);
    assert.equal(
      (await launch.writeIntegrationFiles({ ...options, codexNotify: false })).codexNotify,
      false,
      "SPARK_CODEX_NOTIFY=0 still injected notify",
    );
  });

  // What "Keep agents in your Chrome" hands the launch (separate-browser-tools.ts).
  const guard = {
    tools: [],
    claudeSettings: {
      enabledPlugins: {
        "chrome-devtools-mcp@claude-plugins-official": false,
        "playwright@claude-plugins-official": false,
      },
      deniedMcpServers: [{ serverName: "my-chrome" }],
    },
    codexServers: [
      { name: "playwright", command: "npx" },
      { name: "pw2", command: "C:\\tools\\npx.cmd" },
    ],
  };
  const codexDisabled = () =>
    launch
      .codexLaunchArgs({ userArgs: [] })
      .filter((arg) => arg.startsWith("mcp_servers.") && !arg.startsWith("mcp_servers.codara-studio="));

  await check("Keep agents in your Chrome on: Claude's settings file turns the browser tools off next to the hooks", async () => {
    launch.resetAgentLaunchIntegrationForTests();
    await launch.writeIntegrationFiles({ ...options, separateBrowserTools: guard });
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.deepEqual(Object.keys(settings), ["hooks", "enabledPlugins", "deniedMcpServers", "env"]);
    assert.deepEqual(settings.enabledPlugins, guard.claudeSettings.enabledPlugins);
    assert.deepEqual(settings.deniedMcpServers, [{ serverName: "my-chrome" }]);
    assert.match(settings.hooks.Stop[0].hooks[0].command, /codara-hook\.py" Stop$/);
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: [] }), ["--settings", settingsPath, `--mcp-config=${studioMcp}`]);
    assert.deepEqual(tree(HOME), userHomeBefore, "the switch wrote into the user's home");
  });

  await check("Keep agents in your Chrome on: Codex starts each browser server disabled, as a valid server", async () => {
    const disabled = codexDisabled();
    assert.deepEqual(disabled, [
      "mcp_servers.playwright={command='npx',enabled=false}",
      "mcp_servers.pw2={command='C:\\tools\\npx.cmd',enabled=false}",
    ]);
    assert.deepEqual(
      disabled.map((arg) => JSON.parse(JSON.stringify(parseToml(arg).mcp_servers))),
      [{ playwright: { command: "npx", enabled: false } }, { pw2: { command: "C:\\tools\\npx.cmd", enabled: false } }],
    );
    const typed = fs.readFileSync(path.join(dir, "codex", "args.txt"), "utf8").split("\n");
    assert.ok(typed.includes("mcp_servers.playwright={command='npx',enabled=false}"), "a typed codex keeps the server on");
    assert.deepEqual(launch.codexLaunchArgs({ userArgs: ["login"] }), [], "management commands stay untouched");
  });

  await check("switching it off takes the browser entries out of new launches; the hooks stay", async () => {
    await launch.setSeparateBrowserToolsGuard(null);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(settingsPath, "utf8"))), ["hooks", "env"]);
    assert.deepEqual(codexDisabled(), []);
    assert.ok(!fs.readFileSync(path.join(dir, "codex", "args.txt"), "utf8").includes("enabled=false"));
    await launch.setSeparateBrowserToolsGuard(guard);
    assert.ok(fs.readFileSync(path.join(dir, "codex", "args.txt"), "utf8").includes("enabled=false"), "switching back on");
  });

  await check("without Python the switch still reaches the settings file, and off takes its entries out", async () => {
    launch.resetAgentLaunchIntegrationForTests();
    await launch.writeIntegrationFiles({ ...options, pythonAvailable: false, separateBrowserTools: guard });
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(settingsPath, "utf8"))), ["enabledPlugins", "deniedMcpServers", "env"]);
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: [] }), ["--settings", settingsPath, `--mcp-config=${studioMcp}`]);
    await launch.setSeparateBrowserToolsGuard(null);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), { env: { FORCE_HYPERLINK: "1" } }, "the browser entries were left for --settings");
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: [] }), ["--settings", settingsPath, `--mcp-config=${studioMcp}`]);
    assert.deepEqual(fs.readFileSync(path.join(dir, "claude", "args.txt"), "utf8").split("\n"), ["--settings", settingsPath, `--mcp-config=${studioMcp}`, ""]);
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
