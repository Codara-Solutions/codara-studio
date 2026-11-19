#!/usr/bin/env node
"use strict";

// The Claude Code worker's boundary (src/main/orchestration/claude-code-worker.ts):
//   1. a launch and the release of its account hold never reach a login
//      record or the account service's credential sync: import graph, module
//      spies and a file-system spy;
//   2. the child environment comes from an allowlist: no provider keys, no
//      inherited Claude Code session markers;
//   3. a key passed inline in a Bash call never reaches the worker log (only
//      a command's program is kept, never its arguments or a tool's output);
//   4. Stop ends every process Claude Code started, and a Stop during the
//      launch or the report read never starts a turn.
// How run-store wires it is checked with the route
// (scripts/test-claude-code-worker-session.cjs).
// Runs against a fake `claude`: no model is called, no real login is read.
//
//   node scripts/test-claude-code-worker-boundary.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "src", "main", "orchestration", "claude-code-worker.ts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-claude-code-boundary-"));

// Modules that hold, copy or reconcile logins. The worker must not reach any.
const FORBIDDEN = /(credential-mirror|unified-account|pi-auth-storage|pi-account-auth-store|claude-cli-live-login|claude-cli-credentials|claude-login-keeper|claude-cli-account-profiles|native-claude-profile-runtime|system-cli-login)\.ts$/;

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${String(error && error.message).split("\n")[0]}`);
  }
}

const loadedForbidden = [];
async function load() {
  const outfile = path.join(TMP, "claude-code-worker.cjs");
  const result = await esbuild.build({
    entryPoints: [SOURCE],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    metafile: true,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
    packages: "external",
    external: ["electron"],
    plugins: [{
      // Runtime spy: should the worker ever import one of them, the stub
      // records it the moment it loads.
      name: "forbidden-spy",
      setup(build) {
        build.onLoad({ filter: FORBIDDEN }, (args) => ({
          contents: `globalThis.__loadedForbidden.push(${JSON.stringify(path.basename(args.path))});`,
          loader: "js",
        }));
      },
    }],
  });
  globalThis.__loadedForbidden = loadedForbidden;
  return { worker: require(outfile), inputs: Object.keys(result.metafile.inputs) };
}

// A stand-in for the Claude Code CLI. `auth status --json` answers from
// FAKE_SIGNED_IN; a turn records its environment and acts on the prompt.
const FAKE = path.join(TMP, "claude");
const steerStatus = (out, signedIn) =>
  fs.writeFileSync(path.join(TMP, "status-control.json"), JSON.stringify({ out, signedIn }));
fs.writeFileSync(FAKE, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
if (argv[0] === "auth" && argv[1] === "status") {
  // The worker's allowlisted environment drops test variables, so the test
  // steers this answer through a file beside the fake.
  const control = JSON.parse(fs.readFileSync(path.join(__dirname, "status-control.json"), "utf8"));
  fs.appendFileSync(path.join(control.out, "status-calls.jsonl"), JSON.stringify({ argv, configDir: process.env.CLAUDE_CONFIG_DIR ?? null }) + "\\n");
  const signedIn = control.signedIn;
  process.stdout.write(JSON.stringify({ loggedIn: signedIn, authMethod: "claude.ai" }));
  process.exit(signedIn ? 0 : 1);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { prompt += c; });
process.stdin.on("end", () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  if (process.env.FAKE_OUT) fs.writeFileSync(path.join(process.env.FAKE_OUT, "env.json"), JSON.stringify(process.env));
  if (prompt.includes("TREE")) {
    // A tool that runs a dev server, one that leaves the group, and a
    // grandchild: all must end on Stop.
    const sleeper = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const child = sleeper();
    const escaped = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
    const parent = spawn(process.execPath, ["-e", "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(process.argv[1], String(c.pid)); setInterval(() => {}, 1000);", path.join(process.env.FAKE_OUT, "grandchild.pid")], { stdio: "ignore" });
    fs.writeFileSync(path.join(process.env.FAKE_OUT, "tree.json"), JSON.stringify([child.pid, escaped.pid, parent.pid]));
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes("ESCAPE")) {
    // A tool that starts a detached daemon and exits at once: the daemon
    // leaves the group and is no longer below Claude Code when Stop comes.
    const starter = spawn(process.execPath, ["-e", "const d = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true }); d.unref(); require('node:fs').writeFileSync(process.argv[1], String(d.pid));", path.join(process.env.FAKE_OUT, "daemon.pid")], { stdio: "ignore" });
    starter.on("exit", () => fs.writeFileSync(path.join(process.env.FAKE_OUT, "starter.done"), "1"));
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes("LEAVE")) {
    // A background process that keeps Claude Code's output open after it exits.
    const bg = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
    fs.writeFileSync(path.join(process.env.FAKE_OUT, "bg.pid"), String(bg.pid));
    out({ type: "result", subtype: "success", is_error: false, usage: {} });
    process.exit(0);
  }
  out({ type: "system", subtype: "init", session_id: "sess-1" });
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "curl -H 'x-api-key: sk-ant-api03-InlineKeyAbc123Def456Ghi789Jkl' https://api.example.com && OPENAI_API_KEY=sk-proj-InlineOpenAi0123456789abcdef npm test" } }] } });
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "deploy-tool push 9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928" } }] } });
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "Hex48SecretPattern9f8e7d6c5b4a3928" } }] } });
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo violetwordgarden" } }, { type: "tool_use", name: "Read", input: { file_path: "/srv/secrets/violetwordgarden.txt" } }, { type: "text", text: "the key is violetwordgarden" }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: [{ type: "text", text: "401 for key sk-ant-api03-InlineKeyAbc123Def456Ghi789Jkl" }] }] } });
  out({ type: "result", subtype: "success", is_error: false, session_id: "sess-1", usage: {} });
});
`, { mode: 0o755 });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(file, ms = 5_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").trim()) return fs.readFileSync(file, "utf8");
    await sleep(25);
  }
  throw new Error(`${path.basename(file)} never appeared`);
}

// An account root as Studio keeps it: the profile list, and login records
// beside it that the worker must never open.
const PROFILE_ID = "3f9a1c72-6b0e-4a2d-9c11-5e7d8a4b2f10";
function accountRoot() {
  const root = fs.mkdtempSync(path.join(TMP, "claude-cli-"));
  fs.writeFileSync(path.join(root, "account-profiles.json"), JSON.stringify({
    version: 1,
    defaultProfileId: PROFILE_ID,
    profiles: [{ id: PROFILE_ID, label: "Work", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" }],
  }));
  fs.writeFileSync(path.join(root, "live-login.json"), "{}");
  fs.mkdirSync(path.join(root, "accounts", PROFILE_ID), { recursive: true });
  fs.writeFileSync(path.join(root, "accounts", PROFILE_ID, "login.json"), "{}");
  fs.mkdirSync(path.join(root, "live", "home"), { recursive: true });
  fs.writeFileSync(path.join(root, "live", "home", ".credentials.json"), "{}");
  return root;
}
const LOGIN_RECORD = /(login\.json|\.credentials\.json|auth\.json|auth-profiles|keychain)/i;

// Every path this process opens, whatever API opens it.
const opened = [];
function spyOnFiles() {
  const wrap = (owner, name) => {
    const original = owner[name];
    if (typeof original !== "function") return;
    owner[name] = function (target, ...rest) {
      opened.push(String(target));
      return original.call(this, target, ...rest);
    };
  };
  for (const name of ["readFile", "open", "copyFile", "cp", "lstat", "stat", "readdir"]) wrap(fs.promises, name);
  for (const name of ["readFileSync", "openSync", "copyFileSync", "readFile", "open", "createReadStream"]) wrap(fs, name);
}

async function main() {
  const { worker, inputs } = await load();
  spyOnFiles();

  // ── 1. no login record, no credential sync ───────────────────────────────
  await check("the worker module's import graph reaches no credential module", () => {
    const reached = inputs.filter((input) => FORBIDDEN.test(input));
    assert.deepEqual(reached, []);
  });

  await check("a launch and its release open no login record and load no credential module", async () => {
    assert.equal(typeof worker.claudeCodeWorkerAccount, "function", "claudeCodeWorkerAccount is missing");
    const root = accountRoot();
    const out = fs.mkdtempSync(path.join(TMP, "out-"));
    const account = await worker.claudeCodeWorkerAccount({ accountRoot: root, baseEnv: {} });
    assert.deepEqual(account, { profileId: PROFILE_ID, label: "Work", configDirEnv: path.join(root, "live", "home") });
    const leases = [];
    steerStatus(out, true);
    opened.length = 0;
    const launch = await worker.prepareClaudeCodeWorkerLaunch({
      runId: "run-1",
      attemptDir: path.join(TMP, "attempt"),
      launchArgs: ["--settings", "/h/settings.json"],
      providerArgs: ["--dangerously-skip-permissions", "--model", "claude-opus-5"],
      hookEnv: { SPARK_HOOK_URL: "http://127.0.0.1:1", SPARK_HOOK_TOKEN: "t", SPARK_PANE_ID: "att-1" },
      codaraHome: "/home/x/.codarastudio",
      acquireLease: (profileId) => {
        leases.push(`acquire ${profileId}`);
        return () => leases.push(`release ${profileId}`);
      },
      binary: FAKE,
      account,
      baseEnv: { PATH: process.env.PATH, HOME: os.homedir() },
    });
    launch.release();
    launch.release();
    assert.deepEqual(leases, [`acquire ${PROFILE_ID}`, `release ${PROFILE_ID}`]);
    assert.equal(launch.accountLabel, "Work");
    assert.deepEqual(opened.filter((file) => LOGIN_RECORD.test(file)), [], "opened a login record");
    assert.deepEqual(loadedForbidden, []);
    // Signed in or not came from Claude Code itself, in that account's home.
    const status = fs.readFileSync(path.join(out, "status-calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(status, [{ argv: ["auth", "status", "--json"], configDir: path.join(root, "live", "home") }]);
  });

  await check("a signed-out account stops the launch with 'sign in in a Claude terminal' and takes no hold", async () => {
    const root = accountRoot();
    const account = await worker.claudeCodeWorkerAccount({ accountRoot: root, baseEnv: {} });
    const leases = [];
    steerStatus(fs.mkdtempSync(path.join(TMP, "out-")), false);
    opened.length = 0;
    await assert.rejects(
      worker.prepareClaudeCodeWorkerLaunch({
        runId: "run-1", attemptDir: TMP, launchArgs: [], providerArgs: [], hookEnv: null, codaraHome: "/h",
        acquireLease: () => { leases.push("acquire"); return () => undefined; },
        binary: FAKE, account, baseEnv: { PATH: process.env.PATH },
      }),
      /Sign in to this account in a Claude terminal/,
    );
    assert.deepEqual(leases, []);
    assert.deepEqual(opened.filter((file) => LOGIN_RECORD.test(file)), []);
  });

  await check("with no managed account the worker runs on the user's own login", async () => {
    const root = fs.mkdtempSync(path.join(TMP, "claude-cli-empty-"));
    assert.deepEqual(await worker.claudeCodeWorkerAccount({ accountRoot: root, baseEnv: {} }), {
      profileId: "personal", label: "Claude Code login", configDirEnv: null,
    });
  });

  // ── 2. child environment ──────────────────────────────────────────────────
  await check("the child environment is an allowlist: no provider keys, no inherited session markers", () => {
    const env = worker.claudeCodeWorkerEnv({
      baseEnv: {
        PATH: "/bin", HOME: "/home/x", LANG: "en_US.UTF-8", LC_ALL: "C",
        OPENAI_API_KEY: "a", OPENROUTER_API_KEY: "b", ANTHROPIC_API_KEY: "c", ANTHROPIC_BASE_URL: "d",
        GEMINI_API_KEY: "e", CLAUDE_CODE_OAUTH_TOKEN: "f", AWS_SECRET_ACCESS_KEY: "g", NODE_OPTIONS: "--require x",
        CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CONFIG_DIR: "/elsewhere",
        SPARK_AGENT_TOKEN: "x", SPARK_PANE_TOKEN: "z",
      },
      configDirEnv: "/acct",
      hookEnv: { SPARK_HOOK_URL: "http://127.0.0.1:1", SPARK_HOOK_TOKEN: "t", SPARK_PANE_ID: "att-1", CLAUDECODE: "1" },
      codaraHome: "/home/x/.codarastudio",
      runId: "run-1",
    });
    assert.deepEqual(env, {
      PATH: "/bin", HOME: "/home/x", LANG: "en_US.UTF-8", LC_ALL: "C",
      CLAUDE_CONFIG_DIR: "/acct",
      SPARK_HOOK_URL: "http://127.0.0.1:1", SPARK_HOOK_TOKEN: "t", SPARK_PANE_ID: "att-1",
      SPARK_HOME_DIR: "/home/x/.codarastudio", SPARK_RUN_ID: "run-1",
    });
  });

  await check("the process Claude Code runs as sees none of them either", async () => {
    const out = fs.mkdtempSync(path.join(TMP, "out-"));
    const env = worker.claudeCodeWorkerEnv({
      baseEnv: { ...process.env, OPENAI_API_KEY: "a", OPENROUTER_API_KEY: "b", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" },
      configDirEnv: "/acct", hookEnv: null, codaraHome: "/h", runId: "run-1",
    });
    const run = worker.startClaudeCodeWorker({ binary: FAKE, argv: [], env: { ...env, FAKE_OUT: out }, cwd: TMP, prompt: "x", onEvent: () => undefined });
    await run.done;
    const seen = JSON.parse(fs.readFileSync(path.join(out, "env.json"), "utf8"));
    const leaked = Object.keys(seen).filter((key) => /API_KEY|^CLAUDECODE$|^CLAUDE_CODE_/.test(key) && !/^CLAUDE_CODE_(EXECPATH)$/.test(key));
    assert.deepEqual(leaked, []);
  });

  // ── 3. worker log ─────────────────────────────────────────────────────────
  await check("a key passed inline in a Bash call never reaches the worker log", async () => {
    const out = fs.mkdtempSync(path.join(TMP, "out-"));
    const log = path.join(out, "stdout.log");
    // What run-store appends to the worker log for each event: a tool's
    // name and Studio's fixed line for a failed tool. Assistant text goes to
    // the pane only.
    const lineOf = (event) =>
      event.kind === "tool" ? (worker.claudeCodeToolLine?.(event) ?? `${event.name} ${event.detail}`)
        : event.kind === "tool_failed" ? "! the tool reported an error" : null;
    const run = worker.startClaudeCodeWorker({
      binary: FAKE, argv: [], env: { ...process.env, FAKE_OUT: out }, cwd: TMP, prompt: "do it",
      onEvent: (event) => {
        const line = lineOf(event);
        if (line !== null) fs.appendFileSync(log, `${line}\n`);
      },
    });
    await run.done;
    const written = fs.readFileSync(log, "utf8");
    assert.deepEqual(written.trim().split("\n"), ["Bash", "Bash", "Grep", "Bash", "Read", "! the tool reported an error"]);
    for (const secret of ["InlineKeyAbc123Def456Ghi789Jkl", "InlineOpenAi0123456789abcdef", "9f8e7d6c5b4a39281706f5e4d3c2b1a0", "Hex48SecretPattern", "violetwordgarden"]) {
      assert.ok(!written.includes(secret), `the log holds ${secret.slice(0, 10)}…`);
    }
  });

  // ── 4. Stop ──────────────────────────────────────────────────────────────
  await check("Stop ends every process Claude Code started", async () => {
    const out = fs.mkdtempSync(path.join(TMP, "out-"));
    const run = worker.startClaudeCodeWorker({ binary: FAKE, argv: [], env: { ...process.env, FAKE_OUT: out }, cwd: TMP, prompt: "TREE", onEvent: () => undefined });
    const pids = JSON.parse(await waitFor(path.join(out, "tree.json")));
    pids.push(Number(await waitFor(path.join(out, "grandchild.pid"))));
    assert.ok(pids.every(alive), "the tree is running before Stop");
    await run.kill();
    await run.done;
    await sleep(100);
    const survivors = pids.filter(alive);
    for (const pid of survivors) process.kill(pid, "SIGKILL");
    assert.deepEqual(survivors, []);
  });

  await check("Stop never reads another process's environment", async () => {
    const out = fs.mkdtempSync(path.join(TMP, "out-"));
    const run = worker.startClaudeCodeWorker({ binary: FAKE, argv: [], env: { ...process.env, FAKE_OUT: out }, cwd: TMP, prompt: "TREE", onEvent: () => undefined });
    const pids = JSON.parse(await waitFor(path.join(out, "tree.json")));
    opened.length = 0;
    await run.kill();
    await run.done;
    for (const pid of pids.filter(alive)) process.kill(pid, "SIGKILL");
    assert.deepEqual(opened.filter((file) => /\/environ$/.test(file)), []);
  });

  await check("a background process left holding the output neither hangs the turn nor outlives it", async () => {
    const out = fs.mkdtempSync(path.join(TMP, "out-"));
    const run = worker.startClaudeCodeWorker({ binary: FAKE, argv: [], env: { ...process.env, FAKE_OUT: out }, cwd: TMP, prompt: "LEAVE", onEvent: () => undefined });
    const timeout = sleep(8_000).then(() => "hung");
    const result = await Promise.race([run.done.then(() => "done"), timeout]);
    const bg = Number(await waitFor(path.join(out, "bg.pid")));
    const survived = alive(bg);
    if (survived) process.kill(bg, "SIGKILL");
    assert.equal(result, "done");
    assert.equal(survived, false);
  });

  await check("a Stop during the launch never starts a turn", async () => {
    assert.equal(typeof worker.runClaudeCodeWorkerTurns, "function", "runClaudeCodeWorkerTurns is missing");
    const turns = [];
    await assert.rejects(
      worker.runClaudeCodeWorkerTurns({
        prompt: "task", stopped: () => true, turn: async (prompt) => { turns.push(prompt); return 0; },
        sessionId: () => "sess-1", readReport: async () => null, finalizePrompt: async () => "finalize",
      }),
      /stopped/,
    );
    assert.deepEqual(turns, []);
  });

  await check("a Stop while a finished report is read never ends as a success", async () => {
    let stopped = false;
    await assert.rejects(
      worker.runClaudeCodeWorkerTurns({
        prompt: "task", stopped: () => stopped, turn: async () => 0, sessionId: () => "sess-1",
        readReport: async () => { stopped = true; return { status: "complete" }; },
        finalizePrompt: async () => "finalize",
      }),
      /stopped/,
    );
  });

  await check("a Stop while the report is read never starts the finalizing turn", async () => {
    for (const during of ["readReport", "finalizePrompt"]) {
      let stopped = false;
      const turns = [];
      await assert.rejects(
        worker.runClaudeCodeWorkerTurns({
          prompt: "task",
          stopped: () => stopped,
          turn: async (prompt) => { turns.push(prompt); return 0; },
          sessionId: () => "sess-1",
          readReport: async () => { if (during === "readReport") stopped = true; return null; },
          finalizePrompt: async () => { if (during === "finalizePrompt") stopped = true; return "finalize"; },
        }),
        /stopped/,
      );
      assert.deepEqual(turns, ["task"], during);
    }
  });
}

main()
  .catch((error) => {
    failures += 1;
    console.error(error);
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    if (failures > 0) {
      console.log(`${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("Claude Code worker boundary: all checks passed");
    process.exit(0);
  });
