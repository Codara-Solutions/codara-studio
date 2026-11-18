// Agent CLI updates, part two: the service that checks, updates only while no
// session of the tool runs, verifies the new version and puts the old one
// back when it fails. The first half drives the service with fakes; the
// second runs real fake binaries (shell scripts in a native-installer layout)
// through the real command runner, so the roll back is proven on disk.
// No network and no real agent CLI is touched.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

async function main() {
  const root = path.resolve(__dirname, "..");
  const cache = path.join(root, "node_modules", ".cache");
  fs.mkdirSync(cache, { recursive: true });
  const outfile = path.join(cache, `agent-cli-update-service-test-${process.pid}.cjs`);
  await esbuild.build({
    stdin: {
      contents: [
        'export * from "./src/main/agent-cli-updates/service";',
        'export * from "./src/main/agent-cli-updates/live-sessions";',
        'export * from "./src/main/agent-cli-updates/launch-gate";',
        'export { inspectInstalledTool } from "./src/main/agent-cli-updates/inspect";',
        'export { spawnableCommand } from "./src/main/agent-cli-updates/install-plan";',
        'export { runSetupCommand } from "./src/main/onboarding";',
      ].join("\n"),
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    alias: { "@shared": path.join(root, "src/shared") },
    external: ["electron"],
    logLevel: "silent",
  });
  try {
    const m = require(outfile);
    launchGate(m);
    await fakeService(m);
    await liveSessionCount(m);
    await realBinaries(m);
  } finally {
    fs.rmSync(outfile, { force: true });
  }
  console.log("agent CLI update service: ok");
}

// ── Test launches never update the machine's tools ───────────────────────

function launchGate(m) {
  const home = path.join(os.homedir(), ".codarastudio");
  const allowed = (env) => m.agentCliUpdatesAllowed(env, home);
  assert.equal(allowed({}), true, "the app a person runs");
  assert.equal(allowed({ SPARK_HOME_DIR: home }), true, "started from a Studio terminal, which exports the real home");
  assert.equal(allowed({ CODARA_HOME_DIR: path.join(os.tmpdir(), "suite-home") }), false, "a suite booting the built app");
  assert.equal(allowed({ SPARK_HOME_DIR: path.join(os.tmpdir(), "x") }), false);
  assert.equal(allowed({ SPARK_USER_DATA_DIR: path.join(os.tmpdir(), "x") }), false);
  assert.equal(allowed({ SPARK_E2E_BACKGROUND: "0" }), false, "the e2e suite, visible windows included");
  assert.equal(allowed({ CODARA_DISABLE_AGENT_CLI_UPDATES: "1" }), false);
  assert.equal(allowed({ CODARA_HOME_DIR: "  " }), true);
}

// ── A world of fake tools ──────────────────────────────────────────────────

function nativePlan(tool) {
  const run = (binary, args, env) => ({ executable: binary, args, ...(env ? { env } : {}), display: [tool, ...args].join(" ") });
  return {
    method: "native",
    source: "native installer",
    update: run(`/home/u/.local/bin/${tool}`, ["update"]),
    manualCommand: `${tool} update`,
    rollback: (version, binary) => run(binary, ["install", version, "--force"]),
  };
}

function world(overrides = {}) {
  const tools = {
    claude: { version: "2.1.325", realPath: "/home/u/.local/share/claude/versions/2.1.325", plan: nativePlan("claude") },
    codex: { version: "0.170.0", realPath: "/home/u/.codex/packages/standalone/releases/0.170.0/bin/codex", plan: nativePlan("codex") },
    grok: {
      version: "1.0.46",
      realPath: "/opt/homebrew/Cellar/grok/1.0.46/bin/grok",
      plan: { method: "manual", source: "Homebrew", update: null, manualCommand: "brew upgrade grok", rollback: null },
    },
    ...overrides.tools,
  };
  const latest = { claude: "2.1.327", codex: "0.170.0", grok: "1.0.89", ...overrides.latest };
  const commands = [];
  const scheduled = [];
  const emitted = [];
  const logs = [];
  let saved = null;
  let live = overrides.live ?? (() => 0);
  let auto = overrides.auto ?? true;
  let running = 0;
  let maxRunning = 0;
  const onRun = overrides.onRun ?? ((command, tools) => {
    // Default installer: the update installs the newest version and it works.
    const [tool] = command.display.split(" ");
    if (command.args[0] === "update") tools[tool] = { ...tools[tool], version: latest[tool], realPath: `${tools[tool].realPath}-new` };
    if (command.args[0] === "install") tools[tool] = { ...tools[tool], version: command.args[1] };
    return "ok";
  });
  const deps = {
    inspect: async (tool) => {
      const entry = tools[tool];
      if (!entry) return null;
      return {
        tool,
        binaryPath: `/home/u/.local/bin/${tool}`,
        realPath: entry.realPath,
        version: entry.version,
        versionError: entry.version ? null : "Command exited with code 132.",
        plan: entry.plan,
      };
    },
    latest: async (tool) => {
      if (latest[tool] instanceof Error) throw latest[tool];
      return latest[tool];
    },
    run: async (command) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      commands.push(command);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        return await onRun(command, tools);
      } finally {
        running -= 1;
      }
    },
    liveSessions: async (tool) => live(tool),
    exists: async (file) => (overrides.exists ? overrides.exists(file) : true),
    pi: async () => ({ version: "1.5.3", pinnedVersion: "1.5.2", source: "user" }),
    autoUpdate: () => auto,
    loadState: async () => overrides.state ?? { failed: {}, notOffered: {} },
    saveState: async (state) => {
      saved = JSON.parse(JSON.stringify(state));
    },
    emit: (snapshot) => emitted.push(snapshot),
    schedule: (task, delayMs) => {
      const entry = { task, delayMs, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    now: () => Date.parse("2026-11-18T12:00:00Z"),
    log: (line) => logs.push(line),
  };
  return {
    deps,
    tools,
    latest,
    commands,
    scheduled,
    emitted,
    logs,
    get saved() {
      return saved;
    },
    get maxRunning() {
      return maxRunning;
    },
    setLive(fn) {
      live = fn;
    },
    setAuto(value) {
      auto = value;
    },
  };
}

const tool = (snapshot, id) => snapshot.tools.find((entry) => entry.id === id);

async function fakeService(m) {
  // A check reads every tool; auto-update updates what Codara may update.
  {
    const w = world();
    const service = m.createAgentCliUpdateService(w.deps);
    const first = await service.check();
    assert.equal(first.lastCheckedAt, "2026-11-18T12:00:00.000Z");
    assert.equal(first.checkError, null);
    const claude = tool(first, "claude");
    assert.equal(claude.version, "2.1.325");
    assert.equal(claude.latestVersion, "2.1.327");
    assert.equal(claude.updateAvailable, true);
    assert.equal(claude.canUpdate, true);
    const codex = tool(first, "codex");
    assert.equal(codex.updateAvailable, false, "an up-to-date tool has no mark");
    const grok = tool(first, "grok");
    assert.equal(grok.updateAvailable, true, "a manual install still gets the mark");
    assert.equal(grok.canUpdate, false);
    assert.equal(grok.manualCommand, "brew upgrade grok");
    const pi = tool(first, "pi");
    assert.equal(pi.installMethod, "pinned");
    assert.equal(pi.pinnedVersion, "1.5.2");
    assert.equal(pi.updateAvailable, false, "Pi is never offered an update");
    assert.match(pi.message, /tested with Pi 1\.5\.2/);
    await service.settled();
    const after = service.snapshot();
    assert.equal(tool(after, "claude").phase, "updated");
    assert.equal(tool(after, "claude").version, "2.1.327");
    assert.equal(tool(after, "claude").updateAvailable, false);
    assert.match(tool(after, "claude").message, /Updated from 2\.1\.325 to 2\.1\.327/);
    assert.deepEqual(w.commands.map((command) => command.display), ["claude update"], "only the tool that needs it, and never the Homebrew one");
    assert.equal(tool(after, "grok").phase, "idle");
    const phases = w.emitted.map((snapshot) => tool(snapshot, "claude").phase);
    for (const phase of ["updating", "verifying", "updated"]) assert.ok(phases.includes(phase), `the UI sees ${phase}`);
    await assert.rejects(service.update("pi"), /Pi stays on the version Codara is tested with/);
  }

  // The switch off: a check marks, nothing runs; the Update button still works.
  {
    const w = world({ auto: false });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    assert.equal(w.commands.length, 0);
    assert.equal(service.snapshot().autoUpdate, false);
    const result = await service.update("claude");
    assert.equal(tool(result, "claude").phase, "updated");
    assert.equal(w.commands.length, 1);
  }

  // Running sessions hold the update back until they end.
  {
    const w = world({ live: (id) => (id === "claude" ? 2 : 0) });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.settled();
    let claude = tool(service.snapshot(), "claude");
    assert.equal(claude.phase, "waiting");
    assert.equal(claude.liveSessions, 2);
    assert.match(claude.message, /2 Claude Code sessions are running/);
    assert.equal(w.commands.length, 0, "a tool is never swapped under a live session");
    const poll = w.scheduled.find((entry) => entry.delayMs === m.WAITING_POLL_MS && !entry.cancelled);
    assert.ok(poll, "a retry is scheduled");
    w.setLive(() => 1);
    poll.task();
    await service.settled();
    assert.match(tool(service.snapshot(), "claude").message, /a Claude Code session is running/);
    w.setLive(() => 0);
    await service.pollWaiting();
    claude = tool(service.snapshot(), "claude");
    assert.equal(claude.phase, "updated");
    assert.equal(w.commands.length, 1);
  }

  // A process list that cannot be read counts as a running session.
  {
    const w = world({ live: () => null });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.update("claude");
    const claude = tool(service.snapshot(), "claude");
    assert.equal(claude.phase, "waiting");
    assert.match(claude.message, /cannot tell whether Claude Code is running/);
    assert.equal(w.commands.length, 0);
  }

  // Turning the switch off forgets automatic waits but keeps a requested one.
  {
    const w = world({
      live: () => 1,
      latest: { codex: "0.171.0" },
    });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.update("codex");
    await service.settled();
    assert.equal(tool(service.snapshot(), "claude").phase, "waiting");
    assert.equal(tool(service.snapshot(), "codex").phase, "waiting");
    w.setAuto(false);
    service.autoUpdateChanged();
    assert.equal(tool(service.snapshot(), "claude").phase, "idle", "the automatic wait is dropped");
    assert.equal(tool(service.snapshot(), "codex").phase, "waiting", "the button's wait stays");
    service.cancel("codex");
    assert.equal(tool(service.snapshot(), "codex").phase, "idle");
  }

  // The new build fails its version check: the previous build puts itself back.
  {
    const w = world({
      onRun: (command, tools) => {
        if (command.args[0] === "update") tools.claude = { ...tools.claude, version: null, realPath: "/home/u/.local/share/claude/versions/2.1.327" };
        if (command.args[0] === "install") tools.claude = { ...tools.claude, version: command.args[1], realPath: "/home/u/.local/share/claude/versions/2.1.325" };
        return "ok";
      },
    });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.settled();
    const claude = tool(service.snapshot(), "claude");
    assert.equal(claude.phase, "rolled-back");
    assert.equal(claude.version, "2.1.325");
    assert.match(claude.message, /Claude Code 2\.1\.327 failed its version check, so Codara put 2\.1\.325 back/);
    const rollback = w.commands[1];
    assert.equal(rollback.executable, "/home/u/.local/share/claude/versions/2.1.325", "the previous build runs the roll back");
    assert.deepEqual(rollback.args, ["install", "2.1.325", "--force"]);
    assert.deepEqual(w.saved.failed, { claude: "2.1.327" });
    assert.ok(w.emitted.some((snapshot) => tool(snapshot, "claude").phase === "rolling-back"));
    // The next check does not try that version again by itself.
    await service.check();
    await service.settled();
    assert.equal(w.commands.length, 2);
    assert.equal(tool(service.snapshot(), "claude").updateAvailable, true, "the mark stays, so the user can retry by hand");
    // A newer version is tried again.
    w.latest.claude = "2.1.328";
    w.deps.run = async (command) => {
      w.commands.push(command);
      w.tools.claude = { ...w.tools.claude, version: "2.1.328" };
      return "ok";
    };
    await service.check();
    await service.settled();
    assert.equal(tool(service.snapshot(), "claude").phase, "updated");
    assert.deepEqual(w.saved.failed, {}, "a good update clears the failed version");
  }

  // The previous build is gone from disk: the launcher runs the roll back.
  {
    const w = world({
      exists: () => false,
      onRun: (command, tools) => {
        if (command.args[0] === "update") tools.claude = { ...tools.claude, version: null };
        if (command.args[0] === "install") tools.claude = { ...tools.claude, version: command.args[1] };
        return "ok";
      },
    });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.settled();
    assert.equal(w.commands[1].executable, "/home/u/.local/bin/claude");
    assert.equal(tool(service.snapshot(), "claude").phase, "rolled-back");
  }

  // The roll back fails too: the user gets the exact command.
  {
    const w = world({
      onRun: (command, tools) => {
        if (command.args[0] === "update") tools.claude = { ...tools.claude, version: null };
        if (command.args[0] === "install") throw new Error("network down");
        return "ok";
      },
    });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.settled();
    const claude = tool(service.snapshot(), "claude");
    assert.equal(claude.phase, "failed");
    assert.match(claude.message, /putting 2\.1\.325 back did not work \(network down\)\. Run: claude install 2\.1\.325 --force/);
  }

  // The installer fails but the tool still works: say so, do not roll back.
  {
    const w = world({
      onRun: () => {
        throw new Error("npm ERR! code EACCES");
      },
    });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.settled();
    const claude = tool(service.snapshot(), "claude");
    assert.equal(claude.phase, "failed");
    assert.match(claude.message, /did not finish \(npm ERR! code EACCES\)\. Claude Code 2\.1\.325 still works/);
    assert.equal(w.commands.length, 1, "no roll back for a tool that still works");
  }

  // The installer has nothing newer yet: stop offering that version.
  {
    const w = world({ onRun: () => "Claude Code is up to date (2.1.325)" });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.settled();
    const claude = tool(service.snapshot(), "claude");
    assert.equal(claude.phase, "idle");
    assert.equal(claude.updateAvailable, false);
    assert.match(claude.message, /newest it has for now/);
    assert.deepEqual(w.saved.notOffered, { claude: "2.1.327" });
    await service.check();
    await service.settled();
    assert.equal(w.commands.length, 1, "no update loop");
  }

  // A saved failed version from an earlier launch is respected.
  {
    const w = world({ state: { failed: { claude: "2.1.327" }, notOffered: {} } });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.settled();
    assert.equal(w.commands.length, 0);
  }

  // One update at a time, across tools.
  {
    const w = world({ latest: { codex: "0.171.0" }, auto: false });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await Promise.all([service.update("claude"), service.update("codex")]);
    assert.equal(w.maxRunning, 1);
    assert.equal(w.commands.length, 2);
  }

  // A lookup that fails keeps the tool's row and says why.
  {
    const w = world({ latest: { codex: new Error("registry.npmjs.org answered 503") } });
    const service = m.createAgentCliUpdateService(w.deps);
    const result = await service.check();
    assert.match(result.checkError, /Codex: registry\.npmjs\.org answered 503/);
    assert.equal(tool(result, "codex").latestVersion, null);
    assert.equal(tool(result, "codex").version, "0.170.0");
  }

  // Not installed: no mark, and the button explains.
  {
    const w = world({ tools: { grok: undefined } });
    delete w.tools.grok;
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    const grok = tool(service.snapshot(), "grok");
    assert.equal(grok.installed, false);
    assert.equal(grok.updateAvailable, false);
    await service.update("grok");
    assert.match(tool(service.snapshot(), "grok").message, /Grok is not installed/);
  }

  // start() checks now and schedules the daily check; stop() cancels it.
  {
    const w = world({ auto: false });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.start();
    const daily = w.scheduled.find((entry) => entry.delayMs === m.CHECK_INTERVAL_MS);
    assert.ok(daily, "a daily check is scheduled");
    service.stop();
    assert.equal(daily.cancelled, true);
  }
}

// ── Counting sessions ──────────────────────────────────────────────────────

async function liveSessionCount(m) {
  const processes = [
    { pid: 10, parentPid: 1, startMs: 0, command: "/bin/zsh" },
    { pid: 11, parentPid: 10, startMs: 0, command: "claude --dangerously-skip-permissions" },
    { pid: 12, parentPid: 11, startMs: 0, command: "claude mcp serve" },
    { pid: 20, parentPid: 1, startMs: 0, command: "/home/u/.local/bin/claude" },
    { pid: 30, parentPid: 1, startMs: 0, command: "codex --yolo" },
    { pid: 99, parentPid: 1, startMs: 0, command: "claude --version" },
  ];
  const runsClaude = (command) => /(^|\/)claude(\s|$)/.test(command);
  assert.equal(m.countToolSessions(processes, runsClaude, 99), 2, "a session's own children count once; Codara itself is left out");
  assert.equal(m.countToolSessions(processes, () => false, 99), 0);
}

// ── Real fake binaries through the real runner ─────────────────────────────

function writeScript(file, body) {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

async function realBinaries(m) {
  if (process.platform === "win32") {
    console.log("SKIP real-binary roll back: the fake native layout uses POSIX links");
    return;
  }
  process.env.SHELL = "/bin/sh";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cli-updates-"));
  try {
    const versions = path.join(home, ".local", "share", "claude", "versions");
    const bin = path.join(home, ".local", "bin");
    fs.mkdirSync(versions, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    const launcher = path.join(bin, "claude");
    const log = path.join(home, "calls.log");
    // A miniature of Claude's native installer: `update` writes the new build
    // and repoints the launcher, `install <v> --force` repoints it back.
    const installer = (version, works) => `
echo "$0 $*" >> "${log}"
case "$1" in
  --version) ${works ? `echo "${version} (Claude Code)"` : 'echo "Illegal instruction" >&2; exit 132'} ;;
  update)
    cat > "${versions}/2.0.0" <<'EOF'
#!/bin/sh
echo "$0 $*" >> "${log}"
case "$1" in
  --version) echo "Illegal instruction" >&2; exit 132 ;;
esac
EOF
    chmod +x "${versions}/2.0.0"
    ln -sfn "${versions}/2.0.0" "${launcher}"
    echo "Successfully updated to 2.0.0" ;;
  install)
    [ "$3" = "--force" ] || { echo "already installed"; exit 0; }
    ln -sfn "${versions}/$2" "${launcher}"
    echo "installed $2" ;;
esac`;
    writeScript(path.join(versions, "1.0.0"), installer("1.0.0", true));
    fs.symlinkSync(path.join(versions, "1.0.0"), launcher);

    const inspectDeps = {
      platform: process.platform,
      resolve: async (name) => (name === "claude" ? launcher : null),
      realpath: (file) => fs.promises.realpath(file),
      exists: (file) => fs.promises.stat(file).then(() => true, () => false),
      writable: async () => true,
      run: (command, timeoutMs) => m.runSetupCommand(command, timeoutMs),
    };
    const emitted = [];
    const service = m.createAgentCliUpdateService({
      inspect: async (id) => (id === "claude" ? m.inspectInstalledTool(id, inspectDeps) : null),
      latest: async () => "2.0.0",
      run: (command, timeoutMs) => m.runSetupCommand(m.spawnableCommand(command, process.platform), timeoutMs),
      liveSessions: async () => 0,
      exists: inspectDeps.exists,
      pi: async () => ({ version: null, pinnedVersion: "1.5.2", source: null }),
      autoUpdate: () => true,
      loadState: async () => ({ failed: {}, notOffered: {} }),
      saveState: async () => {},
      emit: (snapshot) => emitted.push(snapshot),
      schedule: () => () => {},
      now: () => Date.now(),
      log: () => {},
    });
    const checked = await service.check();
    assert.equal(tool(checked, "claude").version, "1.0.0");
    assert.equal(tool(checked, "claude").installMethod, "native", "the real path is recognised as Claude's native layout");
    await service.settled();
    const claude = tool(service.snapshot(), "claude");
    assert.equal(claude.phase, "rolled-back", claude.message);
    assert.equal(claude.version, "1.0.0");
    assert.equal(fs.realpathSync(launcher), path.join(versions, "1.0.0"), "the launcher points at the previous build again");
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.ok(calls.includes(`${launcher} update`) || calls.some((line) => line.endsWith("/1.0.0 update")), calls.join("\n"));
    assert.ok(calls.includes(`${path.join(versions, "1.0.0")} install 1.0.0 --force`), "the previous build ran the roll back:\n" + calls.join("\n"));
    assert.ok(!calls.some((line) => line.startsWith(`${path.join(versions, "2.0.0")} install`)), "the broken build never ran its own roll back");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
