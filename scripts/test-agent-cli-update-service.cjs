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
        'export * from "./src/main/agent-cli-updates/launch-guard";',
        'export { relinkLauncher } from "./src/main/agent-cli-updates/relink";',
        'export { acquireUpdateLock, LOCK_MAX_HOLD_MS } from "./src/main/agent-cli-updates/update-lock";',
        'export { reinstallCommand, nativeBuildPath } from "./src/main/agent-cli-updates/reinstall";',
        'export { commandRunsAgent } from "./src/main/agent-hibernation-census";',
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
    await launchGuard(m);
    await crashSafety(m);
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
  const busyCalls = [];
  const held = [];
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
    // The file on disk: what was saved last, else the starting state.
    loadState: async () => JSON.parse(JSON.stringify(saved ?? overrides.state ?? { failed: {}, notOffered: {} })),
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
    toolBusy: (id, isBusy) => busyCalls.push(`${id}:${isBusy}`),
    holdVendorUpdates: (tools) => held.push([...tools]),
    platform: overrides.platform ?? "linux",
    ...(overrides.relink ? { relink: overrides.relink } : {}),
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
    busyCalls,
    held,
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

  // The previous build is gone from disk: the launcher now runs the broken
  // build, so nothing runs and the vendor's installer command is shown.
  {
    const w = world({
      exists: () => false,
      onRun: (command, tools) => {
        if (command.args[0] === "update") tools.claude = { ...tools.claude, version: null, realPath: "/home/u/.local/share/claude/versions/2.1.327" };
        if (command.args[0] === "install") tools.claude = { ...tools.claude, version: command.args[1] };
        return "ok";
      },
    });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.settled();
    assert.equal(w.commands.length, 1, "only the update ran; the broken build never runs");
    const claude = tool(service.snapshot(), "claude");
    assert.equal(claude.phase, "failed");
    assert.match(claude.message, /removed 2\.1\.325 on disk\. Put 2\.1\.325 back with: curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash -s 2\.1\.325/);
  }

  // The roll back fails too: the user gets the exact command.
  {
    const w = world({
      onRun: (command, tools) => {
        if (command.args[0] === "update") tools.claude = { ...tools.claude, version: null, realPath: "/home/u/.local/share/claude/versions/2.1.327" };
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

  // A saved failed version from an earlier launch is respected, and a
  // version that broke keeps its tool's own updater off from launch.
  {
    const w = world({ state: { failed: { claude: "2.1.327" }, notOffered: {}, broken: { claude: "2.1.327" } } });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.prime();
    assert.deepEqual(w.held.at(-1), ["claude"]);
    await service.check();
    await service.settled();
    assert.equal(w.commands.length, 0);
    assert.deepEqual(w.held.at(-1), ["claude"]);
    // The user got that version another way, and it works: the hold lifts.
    w.tools.claude = { ...w.tools.claude, version: "2.1.327" };
    await service.check();
    assert.deepEqual(w.held.at(-1), [], "installed at or above the broken version");
  }

  // An installer that errored (network down) rolled nothing back: the
  // tool's own updater stays on.
  {
    const w = world({
      onRun: () => {
        throw new Error("network down");
      },
    });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.settled();
    assert.equal(tool(service.snapshot(), "claude").phase, "failed");
    assert.deepEqual(w.saved.failed, { claude: "2.1.327" }, "not tried again by itself");
    assert.deepEqual(w.held.at(-1), [], "no updater held off without a broken build");
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

  // Sessions are counted again right before the installer runs: one that
  // started after the first count holds the update back.
  {
    let calls = 0;
    const w = world({ auto: false, live: () => (calls++ === 0 ? 0 : 1) });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.update("claude");
    await service.settled();
    const claude = tool(service.snapshot(), "claude");
    assert.equal(claude.phase, "waiting", "a session that started meanwhile holds the update");
    assert.equal(w.commands.length, 0);
    assert.ok(calls >= 2, "counted again before the installer");
  }

  // The tool is marked busy before that second count, so no launch slips in
  // between the count and the installer; it is cleared when the update waits.
  {
    const events = [];
    let calls = 0;
    const w = world({
      auto: false,
      live: () => {
        events.push("count");
        return calls++ === 0 ? 0 : 1;
      },
    });
    w.deps.toolBusy = (id, isBusy) => events.push(`${id}:${isBusy}`);
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    events.length = 0;
    calls = 0;
    await service.update("claude");
    await service.settled();
    assert.deepEqual(events.slice(0, 3), ["count", "claude:true", "count"], "busy before the second count");
    assert.equal(events.at(-1), "claude:false", "cleared when the update goes back to waiting");
    assert.equal(tool(service.snapshot(), "claude").phase, "waiting");
  }

  // A launch that began but has no process yet counts as a session.
  {
    const w = world({ auto: false });
    let starting = 0;
    w.deps.launchesStarting = () => starting;
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    starting = 1;
    await service.update("claude");
    await service.settled();
    assert.equal(w.commands.length, 0, "the installer waits for the launch");
    assert.match(tool(service.snapshot(), "claude").message, /a Claude Code session is running/);
    // Its process now runs too: still one session, not two.
    w.setLive(() => 1);
    await service.pollWaiting();
    assert.match(tool(service.snapshot(), "claude").message, /a Claude Code session is running/, "a launch is not counted twice");
  }

  // While a tool is swapped, Codara does not start it (launch-guard.ts).
  {
    const w = world({ auto: false });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.update("claude");
    assert.deepEqual(w.busyCalls, ["claude:true", "claude:false"]);
  }

  // A double click, or a manual request for a tool already queued, runs once;
  // a request whose tool is up to date by its turn does nothing.
  {
    const w = world({ auto: false });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await Promise.all([service.update("claude"), service.update("claude"), service.update("claude")]);
    await service.settled();
    assert.equal(w.commands.length, 1, "one update for three clicks");
    await service.update("claude");
    assert.equal(w.commands.length, 1, "nothing to do once it is up to date");
    assert.equal(tool(service.snapshot(), "claude").phase, "updated");
  }

  // A check that started before an update finished never writes its old
  // reading over the new one.
  {
    const w = world({ auto: false });
    const inspect = w.deps.inspect;
    let hold = null;
    w.deps.inspect = async (id) => {
      const reading = await inspect(id);
      if (id === "claude" && hold) await hold;
      return reading;
    };
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    let release;
    hold = new Promise((resolve) => (release = resolve));
    const second = service.check();
    await new Promise((resolve) => setImmediate(resolve));
    hold = null;
    await service.update("claude");
    assert.equal(tool(service.snapshot(), "claude").version, "2.1.327");
    release();
    await second;
    assert.equal(tool(service.snapshot(), "claude").version, "2.1.327", "the finished update's reading stays");
  }

  // A process list that never reads backs off instead of polling every two minutes.
  {
    const w = world({ live: () => null });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.settled();
    const delays = [];
    for (let round = 0; round < 6; round += 1) {
      const poll = w.scheduled.filter((entry) => !entry.cancelled && entry.delayMs !== m.CHECK_INTERVAL_MS).at(-1);
      delays.push(poll.delayMs);
      poll.cancelled = true;
      poll.task();
      await service.settled();
    }
    assert.equal(delays[0], m.WAITING_POLL_MS);
    assert.ok(delays[1] > delays[0] && delays[2] > delays[1], `the wait grows: ${delays.join(", ")}`);
    assert.ok(delays.at(-1) <= 30 * 60 * 1000, "up to half an hour");
  }

  // After a roll back the tool's own updater stays off in Codara's terminals
  // until a newer version is out; Codex, which has no such switch, says so.
  {
    const w = world({
      latest: { codex: "0.171.0" },
      onRun: (command, tools) => {
        const id = ["claude", "codex", "grok"].find((name) => command.display.includes(`${name} `));
        if (command.args[0] === "update" && !command.env) tools[id] = { ...tools[id], version: null, realPath: `${tools[id].realPath}-new` };
        else tools[id] = { ...tools[id], version: command.args[1] ?? command.env.CODEX_RELEASE };
        return "ok";
      },
    });
    w.tools.codex.plan = {
      ...nativePlan("codex"),
      rollback: (version, binary) => ({ executable: binary, args: ["update"], env: { CODEX_RELEASE: version }, display: `CODEX_RELEASE=${version} codex update` }),
    };
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.settled();
    assert.equal(tool(service.snapshot(), "claude").phase, "rolled-back");
    assert.match(tool(service.snapshot(), "claude").message, /own updater stays off in the terminals Codara opens until a newer version is out/);
    assert.equal(tool(service.snapshot(), "codex").phase, "rolled-back");
    assert.match(tool(service.snapshot(), "codex").message, /Codex has no switch for its own updater/);
    assert.deepEqual(w.held.at(-1), ["claude", "codex"]);
    w.latest.claude = "2.1.328";
    w.setAuto(false);
    await service.check();
    assert.deepEqual(w.held.at(-1), ["codex"], "a newer version lifts the hold");
  }

  // No earlier build on disk (Claude on Windows copies claude.exe over
  // itself): the broken build never runs; the vendor's installer command for
  // the previous version is shown.
  {
    const w = world({
      platform: "win32",
      onRun: (command, tools) => {
        tools.claude = { ...tools.claude, version: null };
        return "ok";
      },
    });
    w.tools.claude.realPath = "C:\\Users\\u\\.local\\bin\\claude.exe";
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.settled();
    const claude = tool(service.snapshot(), "claude");
    assert.equal(w.commands.length, 1, "the broken build did not run a roll back");
    assert.equal(claude.phase, "failed");
    assert.match(claude.message, /irm https:\/\/claude\.ai\/install\.ps1\)\)\) 2\.1\.325/);
  }

  // Claude's native install on Linux and macOS: the launcher is pointed back
  // at the previous build still on disk, with no network.
  {
    const relinked = [];
    const w = world({
      relink: async (link, target) => {
        relinked.push([link, target]);
        w.tools.claude = { ...w.tools.claude, version: "2.1.325", realPath: target };
      },
      onRun: (command, tools) => {
        tools.claude = { ...tools.claude, version: null, realPath: "/home/u/.local/share/claude/versions/2.1.327" };
        return "ok";
      },
    });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.settled();
    assert.deepEqual(relinked, [["/home/u/.local/bin/claude", "/home/u/.local/share/claude/versions/2.1.325"]]);
    assert.equal(w.commands.length, 1, "no installer run for the roll back");
    assert.equal(tool(service.snapshot(), "claude").phase, "rolled-back");
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

  // The real matcher on the command lines each install method really shows.
  const real = [
    // Claude from npm: node runs the package's launcher link.
    { pid: 100, parentPid: 1, startMs: 0, command: "node /home/u/.npm-global/bin/claude --resume" },
    // Claude's native build: the versions/ file itself.
    { pid: 110, parentPid: 1, startMs: 0, command: "/home/u/.local/share/claude/versions/2.1.325 --dangerously-skip-permissions" },
    // Codex from npm: node runs codex.js, which starts the native binary.
    { pid: 120, parentPid: 1, startMs: 0, command: "node /home/u/.npm-global/lib/node_modules/@openai/codex/bin/codex.js" },
    { pid: 121, parentPid: 120, startMs: 0, command: "/home/u/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex" },
    // Codex's standalone install.
    { pid: 130, parentPid: 1, startMs: 0, command: "/home/u/.codex/packages/standalone/releases/0.170.0-x86_64-unknown-linux-musl/bin/codex --yolo" },
    // Grok's native build.
    { pid: 140, parentPid: 1, startMs: 0, command: "/home/u/.grok/downloads/grok-1.0.89-linux-x86_64" },
    // An installer: not a session. Two Codara windows are kept apart by the
    // update lock, not by the session count.
    { pid: 150, parentPid: 1, startMs: 0, command: "/usr/bin/node /usr/lib/node_modules/npm/bin/npm-cli.js install -g --prefix /home/u/.npm-global @openai/codex@latest" },
  ];
  const count = (id) => m.countToolSessions(real, (command) => m.commandRunsAgent(command, id), 99);
  assert.equal(count("claude"), 2, "npm and native Claude");
  assert.equal(count("codex"), 2, "npm Codex once with its native child, plus the standalone one");
  assert.equal(count("grok"), 1, "native Grok");
}

// ── An update cut short, and two Codara windows ──────────────────────────

async function crashSafety(m) {
  // Before the installer runs, what is there is on disk; afterwards it is gone.
  {
    const w = world({ auto: false });
    const states = [];
    w.deps.saveState = async (state) => states.push(JSON.parse(JSON.stringify(state)));
    const run = w.deps.run;
    let recordAtRun = null;
    w.deps.run = async (command) => {
      recordAtRun = states.at(-1)?.inProgress ?? null;
      return run(command);
    };
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.update("claude");
    assert.deepEqual(recordAtRun, {
      tool: "claude",
      fromVersion: "2.1.325",
      fromRealPath: "/home/u/.local/share/claude/versions/2.1.325",
      fromBinaryPath: "/home/u/.local/bin/claude",
      toVersion: "2.1.327",
    }, "the record is saved before the installer starts");
    assert.equal(states.at(-1).inProgress, undefined, "and cleared once the update is over");
  }

  // The record cannot be written: the installer does not start.
  {
    const w = world({ auto: false });
    w.deps.saveState = async () => {
      throw new Error("disk full");
    };
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.update("claude");
    assert.equal(w.commands.length, 0, "no installer without its record on disk");
    const claude = tool(service.snapshot(), "claude");
    assert.equal(claude.phase, "failed");
    assert.match(claude.message, /could not save its note of the update \(disk full\), so it did not start it/);
    assert.deepEqual(w.busyCalls.at(-1), "claude:false");
  }

  // The next start finds the record and a broken tool: it rolls back.
  {
    const record = { tool: "claude", fromVersion: "2.1.325", fromRealPath: "/home/u/.local/share/claude/versions/2.1.325", fromBinaryPath: "/home/u/.local/bin/claude", toVersion: "2.1.327" };
    const w = world({
      auto: false,
      state: { failed: {}, notOffered: {}, inProgress: record },
      tools: { claude: { version: null, realPath: "/home/u/.local/share/claude/versions/2.1.327", plan: nativePlan("claude") } },
      onRun: (command, tools) => {
        tools.claude = { ...tools.claude, version: command.args[1], realPath: "/home/u/.local/share/claude/versions/2.1.325" };
        return "ok";
      },
    });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.start();
    const claude = tool(service.snapshot(), "claude");
    assert.equal(claude.phase, "rolled-back", claude.message);
    assert.match(claude.message, /^Codara closed during the last update\. Claude Code 2\.1\.327 failed its version check, so Codara put 2\.1\.325 back/);
    assert.deepEqual([w.commands[0].executable, ...w.commands[0].args], ["/home/u/.local/share/claude/versions/2.1.325", "install", "2.1.325", "--force"]);
    assert.equal(w.saved.inProgress, undefined);
    assert.deepEqual(w.saved.failed, { claude: "2.1.327" });
    service.stop();
  }

  // A record from disk is never run as it stands: a tampered or stale one
  // runs nothing, and the user gets the vendor's installer command.
  {
    const good = { tool: "claude", fromVersion: "2.1.325", fromRealPath: "/home/u/.local/share/claude/versions/2.1.325", fromBinaryPath: "/home/u/.local/bin/claude", toVersion: "2.1.327" };
    const tampered = [
      ["another program as the previous build", { ...good, fromRealPath: "/tmp/evil" }],
      ["another launcher to relink", { ...good, fromBinaryPath: "/home/u/.bashrc" }],
      ["a quote for cmd.exe", { ...good, fromVersion: '2.1.325" & calc & "' }],
      ["a path in the version", { ...good, fromVersion: "../../../../tmp/evil" }],
      ["a bad target version", { ...good, toVersion: "x; rm -rf ~" }],
      ["an unknown tool", { ...good, tool: "sh" }],
    ];
    for (const [name, record] of tampered) {
      const w = world({
        auto: false,
        state: { failed: {}, notOffered: {}, inProgress: record },
        tools: { claude: { version: null, realPath: "/home/u/.local/share/claude/versions/2.1.327", plan: nativePlan("claude") } },
      });
      const relinked = [];
      w.deps.relink = async (link, target) => relinked.push([link, target]);
      const service = m.createAgentCliUpdateService(w.deps);
      await service.start();
      assert.equal(w.commands.length, 0, `${name}: nothing runs`);
      assert.deepEqual(relinked, [], `${name}: nothing is relinked`);
      assert.equal(w.saved?.inProgress, undefined, `${name}: the record is dropped`);
      service.stop();
    }
    const w = world({
      auto: false,
      state: { failed: {}, notOffered: {}, inProgress: { ...good, fromRealPath: "/tmp/evil" } },
      tools: { claude: { version: null, realPath: "/home/u/.local/share/claude/versions/2.1.327", plan: nativePlan("claude") } },
    });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.start();
    assert.match(tool(service.snapshot(), "claude").message, /Put 2\.1\.325 back with: curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash -s 2\.1\.325/);
    service.stop();
    assert.equal(m.nativeBuildPath("codex", "/h/.codex/packages/standalone/releases/0.171.0-x86_64-unknown-linux-musl/bin/codex", "0.170.0"), "/h/.codex/packages/standalone/releases/0.170.0-x86_64-unknown-linux-musl/bin/codex");
    assert.equal(m.nativeBuildPath("claude", "/h/.local/share/claude/versions/2.1.327", "2.1.325"), "/h/.local/share/claude/versions/2.1.325");
    assert.equal(m.nativeBuildPath("claude", "/h/.local/share/claude/versions/2.1.327", "../x"), null);
    assert.equal(m.nativeBuildPath("claude", "/opt/claude", "2.1.325"), null);
  }

  // Cut off after the installer removed the launcher (or the tool cannot be
  // read right now): the record stays for the next start and the user is told.
  {
    const record = { tool: "claude", fromVersion: "2.1.325", fromRealPath: "/home/u/.local/share/claude/versions/2.1.325", fromBinaryPath: "/home/u/.local/bin/claude", toVersion: "2.1.327" };
    const w = world({ auto: false, state: { failed: {}, notOffered: {}, inProgress: record } });
    delete w.tools.claude;
    const service = m.createAgentCliUpdateService(w.deps);
    await service.start();
    assert.equal(w.commands.length, 0);
    assert.ok(w.saved === null || w.saved.inProgress, "the record is kept");
    assert.match(tool(service.snapshot(), "claude").message, /^Codara closed during the last update\. Claude Code cannot be found now\. Put 2\.1\.325 back with:/);
    service.stop();
  }

  // The record but a tool that works: nothing is run, the record goes.
  {
    const record = { tool: "claude", fromVersion: "2.1.325", fromRealPath: "/x/2.1.325", fromBinaryPath: "/home/u/.local/bin/claude", toVersion: "2.1.327" };
    const w = world({ auto: false, state: { failed: {}, notOffered: {}, inProgress: record } });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.start();
    assert.equal(w.commands.length, 0);
    assert.equal(w.saved.inProgress, undefined);
    service.stop();
  }

  // Another Codara holds the lock: its update is still running, so this one
  // neither recovers it nor starts its own.
  {
    const record = { tool: "claude", fromVersion: "2.1.325", fromRealPath: "/x/2.1.325", fromBinaryPath: "/home/u/.local/bin/claude", toVersion: "2.1.327" };
    const w = world({
      auto: false,
      state: { failed: {}, notOffered: {}, inProgress: record },
      tools: { claude: { version: null, realPath: "/x/2.1.327", plan: nativePlan("claude") } },
    });
    w.deps.lock = async () => null;
    const service = m.createAgentCliUpdateService(w.deps);
    await service.start();
    assert.equal(w.commands.length, 0, "no recovery under another window's lock");
    w.tools.claude = { ...w.tools.claude, version: "2.1.325" };
    await service.check();
    await service.update("claude");
    assert.equal(w.commands.length, 0);
    assert.match(tool(service.snapshot(), "claude").message, /another Codara window is updating/);
    service.stop();
  }

  // The lock file: exclusive, released by its owner, taken over when stale.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cli-lock-"));
    try {
      const file = path.join(dir, "agent-cli-update.lock");
      const opts = (pid, over = {}) => ({ pid, host: "here", alive: () => true, installerAlive: () => false, ...over });
      const first = await m.acquireUpdateLock(file, opts(111));
      assert.ok(first);
      assert.equal(await m.acquireUpdateLock(file, opts(222)), null, "held by a live Codara");
      const stale = await m.acquireUpdateLock(file, opts(222, { alive: (pid) => pid !== 111 }));
      assert.ok(stale, "a dead owner's lock is taken over");
      await first.release();
      assert.ok(fs.existsSync(file), "a former owner does not remove the new owner's lock");
      await stale.release();
      assert.ok(!fs.existsSync(file));

      // The installer outlives its Codara: the lock stays held while it runs.
      const owner = await m.acquireUpdateLock(file, opts(111));
      await owner.installerStarted(4242);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).installer, 4242);
      const ownerDead = { alive: (pid) => pid !== 111 };
      assert.equal(await m.acquireUpdateLock(file, opts(222, { ...ownerDead, installerAlive: (pid) => pid === 4242 })), null, "held while the installer runs");
      const after = await m.acquireUpdateLock(file, opts(222, { ...ownerDead, installerAlive: () => false }));
      assert.ok(after, "taken over once the installer is gone too");
      await after.release();

      // Codaras taking over the same stale lock at once: exactly one gets it.
      for (let round = 0; round < 25; round += 1) {
        fs.writeFileSync(file, JSON.stringify({ pid: 111, host: "here", since: new Date().toISOString() }));
        const pids = [201, 202, 203, 204, 205, 206];
        const got = await Promise.all(pids.map((pid) => m.acquireUpdateLock(file, opts(pid, { alive: (other) => other !== 111 }))));
        const owners = got.filter(Boolean);
        assert.equal(owners.length, 1, `round ${round}: ${owners.length} holders`);
        assert.ok(pids.includes(JSON.parse(fs.readFileSync(file, "utf8")).pid), "the lock on disk is the winner's");
        await owners[0].release();
        assert.deepEqual(fs.readdirSync(dir), [], "nothing left aside");
      }

      // A pid reused after a reboot keeps nothing forever.
      const t0 = Date.parse("2026-11-18T12:00:00Z");
      const old = await m.acquireUpdateLock(file, opts(111, { now: () => t0 }));
      assert.ok(old);
      assert.equal(await m.acquireUpdateLock(file, opts(222, { now: () => t0 + 10 * 60 * 1000 })), null);
      const late = await m.acquireUpdateLock(file, opts(222, { now: () => t0 + m.LOCK_MAX_HOLD_MS + 1000 }));
      assert.ok(late, "stale once older than the longest update");
      await late.release();

      // Another machine's lock (a shared home folder): its pids mean nothing here.
      const there = await m.acquireUpdateLock(file, opts(111, { host: "there" }));
      assert.ok(there);
      assert.equal(await m.acquireUpdateLock(file, opts(222, { alive: () => false })), null, "not taken over from another host");
      fs.rmSync(file, { force: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Under the lock the file is read again: what another Codara wrote since
  // this one read it is kept, not overwritten.
  {
    let disk = { failed: {}, notOffered: {} };
    const w = world({ auto: false });
    w.deps.loadState = async () => JSON.parse(JSON.stringify(disk));
    w.deps.saveState = async (state) => {
      disk = JSON.parse(JSON.stringify(state));
    };
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    disk.failed.codex = "0.171.0";
    disk.broken = { codex: "0.171.0" };
    await service.update("claude");
    assert.equal(tool(service.snapshot(), "claude").phase, "updated");
    assert.deepEqual(disk.failed, { codex: "0.171.0" }, "another window's failed version survives");
    assert.deepEqual(disk.broken, { codex: "0.171.0" });

    // A record another window cleared is not recovered.
    const record = { tool: "claude", fromVersion: "2.1.325", fromRealPath: "/home/u/.local/share/claude/versions/2.1.325", fromBinaryPath: "/home/u/.local/bin/claude", toVersion: "2.1.327" };
    let second = { failed: {}, notOffered: {}, inProgress: record };
    const w2 = world({ auto: false, tools: { claude: { version: null, realPath: "/home/u/.local/share/claude/versions/2.1.327", plan: nativePlan("claude") } } });
    let reads = 0;
    w2.deps.loadState = async () => (reads++ === 0 ? second : { failed: {}, notOffered: {} });
    w2.deps.saveState = async (state) => {
      second = state;
    };
    const recovering = m.createAgentCliUpdateService(w2.deps);
    await recovering.start();
    assert.equal(w2.commands.length, 0, "the record was gone from disk under the lock");
    recovering.stop();
  }

  // The service writes the installer's pid into the lock as it starts.
  {
    const w = world({ auto: false });
    const noted = [];
    w.deps.lock = async () => ({ release: async () => {}, installerStarted: async (pid) => noted.push(pid) });
    const run = w.deps.run;
    w.deps.run = async (command, timeoutMs, onStart) => {
      onStart?.(4242);
      return run(command, timeoutMs);
    };
    const service = m.createAgentCliUpdateService(w.deps);
    await service.check();
    await service.update("claude");
    assert.deepEqual(noted, [4242]);
  }

  // The real runner reports the installer's pid.
  if (process.platform !== "win32") {
    let started = null;
    await m.runSetupCommand({ executable: "/bin/sh", args: ["-c", "exit 0"] }, 5000, undefined, (pid) => (started = pid));
    assert.ok(Number.isInteger(started) && started > 0, "the runner reports the pid");
  }

  // Another tool's update gets the lock before the recovery retry is due:
  // the earlier update is finished first, not overwritten.
  {
    const record = {
      tool: "codex",
      fromVersion: "0.170.0",
      fromRealPath: "/home/u/.codex/packages/standalone/releases/0.170.0/bin/codex",
      fromBinaryPath: "/home/u/.local/bin/codex",
      toVersion: "0.171.0",
    };
    const w = world({
      auto: false,
      state: { failed: {}, notOffered: {}, inProgress: record },
      tools: { codex: { version: null, realPath: "/home/u/.codex/packages/standalone/releases/0.171.0/bin/codex", plan: nativePlan("codex") } },
      onRun: (command, tools) => {
        const [id] = command.display.split(" ");
        if (id === "codex") tools.codex = { ...tools.codex, version: command.args[1], realPath: record.fromRealPath };
        else tools[id] = { ...tools[id], version: w.latest[id], realPath: `${tools[id].realPath}-new` };
        return "ok";
      },
    });
    let held = true;
    w.deps.lock = async () => (held ? null : { release: async () => {}, installerStarted: async () => {} });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.start();
    assert.equal(w.commands.length, 0, "the installer the last run left still holds the lock");
    held = false;
    await service.update("claude");
    await service.settled();
    const codex = tool(service.snapshot(), "codex");
    assert.equal(codex.phase, "rolled-back", `the Codex update cut short is finished first: ${codex.message}`);
    assert.equal(w.commands[0].display.split(" ")[0], "codex");
    assert.equal(tool(service.snapshot(), "claude").phase, "updated");
    assert.equal(w.saved.inProgress, undefined);
    service.stop();

    // A record whose tool cannot be found is kept, and other updates wait for it.
    const w2 = world({ auto: false, state: { failed: {}, notOffered: {}, inProgress: record } });
    delete w2.tools.codex;
    const service2 = m.createAgentCliUpdateService(w2.deps);
    await service2.start();
    await service2.update("claude");
    assert.equal(w2.commands.length, 0, "no update writes over the record");
    assert.ok(w2.saved === null || w2.saved.inProgress?.tool === "codex", "the Codex record survives");
    assert.match(tool(service2.snapshot(), "claude").message, /the Codex update Codara was running when it closed is not finished yet/);
    service2.stop();
  }

  // A held lock at start: recovery is tried again later, not given up.
  {
    const record = { tool: "claude", fromVersion: "2.1.325", fromRealPath: "/home/u/.local/share/claude/versions/2.1.325", fromBinaryPath: "/home/u/.local/bin/claude", toVersion: "2.1.327" };
    const w = world({
      auto: false,
      state: { failed: {}, notOffered: {}, inProgress: record },
      tools: { claude: { version: null, realPath: "/home/u/.local/share/claude/versions/2.1.327", plan: nativePlan("claude") } },
      onRun: (command, tools) => {
        tools.claude = { ...tools.claude, version: command.args[1], realPath: "/home/u/.local/share/claude/versions/2.1.325" };
        return "ok";
      },
    });
    let held = true;
    w.deps.lock = async () => (held ? null : { release: async () => {}, installerStarted: async () => {} });
    const service = m.createAgentCliUpdateService(w.deps);
    await service.start();
    assert.equal(w.commands.length, 0);
    const retry = w.scheduled.find((entry) => entry.delayMs === m.WAITING_POLL_MS && !entry.cancelled);
    assert.ok(retry, "recovery is tried again later");
    held = false;
    retry.task();
    await service.settled();
    assert.equal(tool(service.snapshot(), "claude").phase, "rolled-back");
    service.stop();
  }
}

// ── What the terminal launcher reads ───────────────────────────────────────

async function launchGuard(m) {
  m.holdVendorUpdates(["claude", "codex", "grok"]);
  assert.deepEqual(m.vendorUpdaterEnv(), { DISABLE_AUTOUPDATER: "1", GROK_DISABLE_AUTOUPDATER: "1" });
  m.holdVendorUpdates([]);
  assert.deepEqual(m.vendorUpdaterEnv(), {});
  // A launch while the tool is swapped is refused at once: pane openers give
  // up after seconds, so a held launch would start late and unseen.
  const end = m.beginToolLaunch("claude");
  assert.equal(m.launchesStarting("claude"), 1, "a launch counts before its process exists");
  end();
  end();
  assert.equal(m.launchesStarting("claude"), 0, "ending twice ends once");
  m.setToolBusy("claude", true, "Claude Code");
  assert.throws(() => m.beginToolLaunch("claude"), /Claude Code is updating\. Try again in a few minutes\./);
  assert.equal(m.launchesStarting("claude"), 0);
  assert.deepEqual(m.busyTools(), ["claude"], "the quit prompt sees the tool being swapped");
  m.beginToolLaunch("codex")();
  m.setToolBusy("claude", false);
  m.beginToolLaunch("claude")();
  // The terminal launcher takes that path before any wait, profile or spawn.
  const pty = fs.readFileSync(path.join(__dirname, "..", "src", "main", "pty-manager.ts"), "utf8");
  assert.ok(!/waitUntilToolIdle/.test(pty), "no launch is held for minutes");
  const begin = pty.indexOf("beginToolLaunch(launching)");
  assert.ok(!/from "@shared\/agent-cli-updates"/.test(pty), "the terminal launcher's tests bundle it with stubs for @shared/remote only");
  assert.ok(begin > 0 && begin < pty.indexOf("return await spawnWithSessionLock(opts)"), "refused before the launch starts");
  assert.match(pty, /setTimeout\(endLaunch, LAUNCH_SETTLE_MS\)/, "counted until its command had time to start");
  assert.equal(m.reinstallCommand("codex", "0.169.0", "linux"), "curl -fsSL https://chatgpt.com/codex/install.sh | sh -s -- --release 0.169.0");
  assert.equal(m.reinstallCommand("grok", "1.0.46", "win32"), null);
  assert.equal(m.reinstallCommand("claude", "2.1.325; rm -rf ~", "linux"), null, "only a plain version reaches a command line");
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
  await realBinariesOnce(m, false);
  await realBinariesOnce(m, true);
}

// withRelink: Codara points the launcher back itself (offline); without it the
// previous build's own installer does.
async function realBinariesOnce(m, withRelink) {
  process.env.SHELL = "/bin/sh";
  // Real path: macOS's temp folder is a link (/var -> /private/var), and the
  // service reads every path through its links.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-cli-updates-")));
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
      ...(withRelink ? { relink: m.relinkLauncher } : {}),
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
    if (withRelink) {
      assert.ok(!calls.some((line) => line.includes(" install ")), "no installer ran:\n" + calls.join("\n"));
      assert.ok(fs.lstatSync(launcher).isSymbolicLink(), "the launcher is still a link");
    } else {
      assert.ok(calls.includes(`${path.join(versions, "1.0.0")} install 1.0.0 --force`), "the previous build ran the roll back:\n" + calls.join("\n"));
    }
    assert.ok(!calls.some((line) => line.startsWith(`${path.join(versions, "2.0.0")} install`)), "the broken build never ran its own roll back");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
