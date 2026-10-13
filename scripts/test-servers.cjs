#!/usr/bin/env node
"use strict";

// Dev servers, the status view and per-runtime launch arguments
// (src/main/servers/). Drives the real keeper with real child processes and
// a fixture HTTP server on free ports, so these hold for real:
//
//   - a started server is remembered (command, cwd, port, env NAMES, the URL
//     it printed), never with an env value, and a second start of the same
//     id or command is reported as already running, never a second copy
//   - a busy port is refused with what holds it (another server of the
//     workspace, or a pid)
//   - logs come back plain since a cursor, long output goes to a file in
//     Codara's workspace data folder
//   - a navigation to a local port that does not answer names the saved
//     server for it and how to start it
//   - stop, restart and exit codes; a new keeper (an app restart) knows the
//     server, names the env it misses, and auto-starts it once
//   - a server learned from a pane is not started twice, and stopping it
//     interrupts that pane
//   - the pane learner reads shell reports and URLs, skips agent CLIs and
//     URLs of other processes, and adopts the pane for the workspace
//   - an adopted agent terminal survives its run's cleanup and stays
//     writable by its run and by agents without a run, never by another run
//   - launch arguments: shell syntax and Codara's own flags are refused,
//     the Chrome toggle adds --chrome to Claude Code only, and nothing is
//     written outside Codara's home
//   - `cora server` maps onto codara_terminal_servers with the caller's pane
//
//   node scripts/test-servers.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-servers-")));
const HOME = path.join(TMP, "home");
const CODARA = path.join(TMP, "codara");
const WS_DIR = path.join(TMP, "repo");
for (const dir of [HOME, CODARA, path.join(WS_DIR, "web")]) fs.mkdirSync(dir, { recursive: true });

// ~/.claude.json is left out: a Claude Code session running beside the
// suite rewrites it at any moment.
const REAL_FILES = [
  path.join(os.homedir(), ".claude", "settings.json"),
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

process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CODARA_HOME_DIR = CODARA;
process.env.CODEX_HOME = path.join(HOME, ".codex");
for (const key of ["SPARK_HOME_DIR", "SPARK_USER_DATA_DIR", "CLAUDE_CONFIG_DIR", "GROK_HOME"]) delete process.env[key];

// Prints its URL once listening, a line per request, whether a secret came
// in through the environment (never its value), and a flood on request.
const FIXTURE = path.join(TMP, "fixture-server.cjs");
fs.writeFileSync(
  FIXTURE,
  `const http = require("node:http");
const port = Number(process.argv[2]);
if (process.argv[3] === "flood") process.stdout.write("x".repeat(9000) + "\\n");
http.createServer((req, res) => {
  console.log("GET " + req.url);
  res.end("ok");
}).listen(port, "127.0.0.1", () => {
  console.log("token=" + (process.env.SECRET_TOKEN ? "set" : "missing"));
  console.log("  Local:   http://localhost:" + port + "/");
});
`,
);

const ELECTRON_STUB = {
  name: "electron-stub",
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: `export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(ROOT)}, getPath: () => ${JSON.stringify(TMP)} };`,
      loader: "js",
    }));
  },
};

async function load(contents, name) {
  const outfile = path.join(TMP, `${name}.cjs`);
  await esbuild.build({
    stdin: { contents, resolveDir: path.join(ROOT, "src", "main"), loader: "ts" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    plugins: [ELECTRON_STUB],
  });
  return require(outfile);
}

let passes = 0;
async function check(name, fn) {
  await fn();
  passes += 1;
  console.log(`PASS ${name}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition, ms = 8_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(50);
  }
  return false;
}

function get(port, route) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: route }, (res) => {
      res.resume();
      res.on("end", resolve);
    }).on("error", reject);
  });
}

// Sessions are plain child processes here; in Codara they are main-owned
// PTYs. The keeper sees only this interface either way, and like the pty
// manager's taps, a listener may subscribe before its session exists.
function fakeSessions() {
  const sessions = new Map();
  const outs = new Map();
  const exits = new Map();
  const listeners = (map, paneId) => {
    if (!map.has(paneId)) map.set(paneId, new Set());
    return map.get(paneId);
  };
  return {
    sessions,
    spawn({ paneId, cwd, command, env }) {
      const child = spawn("/bin/sh", ["-c", command], { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const session = { child, alive: true, command };
      sessions.set(paneId, session);
      const emit = (chunk) => {
        for (const listener of listeners(outs, paneId)) listener(chunk.toString("utf8"));
      };
      child.stdout.on("data", emit);
      child.stderr.on("data", emit);
      child.on("exit", (code) => {
        session.alive = false;
        for (const listener of listeners(exits, paneId)) listener(code);
      });
      return Promise.resolve();
    },
    kill(paneId) {
      const session = sessions.get(paneId);
      if (!session?.alive) return;
      try {
        process.kill(-session.child.pid, "SIGTERM");
      } catch {
        session.child.kill("SIGTERM");
      }
    },
    exists: (paneId) => sessions.get(paneId)?.alive === true,
    onOutput(paneId, listener) {
      listeners(outs, paneId).add(listener);
      return () => listeners(outs, paneId).delete(listener);
    },
    onExit(paneId, listener) {
      listeners(exits, paneId).add(listener);
      return () => listeners(exits, paneId).delete(listener);
    },
    killAll() {
      for (const [paneId] of sessions) this.kill(paneId);
    },
  };
}

function keeperWith(lib, store, sessions, extra = {}) {
  const changes = [];
  const stopped = [];
  const logWrites = [];
  const keeper = lib.createServerKeeper({
    store,
    spawn: (input) => sessions.spawn(input),
    kill: (paneId) => sessions.kill(paneId),
    exists: (paneId) => sessions.exists(paneId),
    onOutput: (paneId, listener) => sessions.onOutput(paneId, listener),
    onExit: (paneId, listener) => sessions.onExit(paneId, listener),
    portAnswers: (port) => lib.portAnswers(port, 300),
    portOwner: (port) => lib.portOwner(port),
    async paneOfPid(pid) {
      for (const [paneId, session] of sessions.sessions) if (session.child.pid === pid && session.alive) return paneId;
      return null;
    },
    async isDirectory(dir) {
      return fs.promises.stat(dir).then((stat) => stat.isDirectory(), () => false);
    },
    async workspaceCwd(workspaceId) {
      return workspaceId === "ws-remote" ? null : WS_DIR;
    },
    async writeLog(workspaceId, id, text) {
      const file = path.join(CODARA, "workspace-data", workspaceId, "servers", `${id}.log`);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, text);
      logWrites.push(file);
      return file;
    },
    async stopPane(paneId, pid) {
      stopped.push([paneId, pid]);
    },
    changed: (workspaceId) => changes.push(workspaceId),
    now: () => Date.now(),
    sleep,
    env: {},
    ...extra,
  });
  return { keeper, changes, stopped, logWrites };
}

async function main() {
  const lib = await load(
    `
      export * from "./servers/detect";
      export * from "./servers/keeper";
      export { createServerStore, serversFile } from "./servers/store";
      export { portAnswers, portOwner, processCommand, shellWord } from "./servers/health";
      export { createPaneLearner } from "./servers/pane-learner";
      export { createStatusRegistry } from "./servers/status";
      export { AgentTerminalRegistry } from "./agent-terminal-registry";
      export { savedServerHint } from "./servers/navigate-hint";
      export { provideServersService } from "./servers/service";
    `,
    "servers",
  );

  await check("detect: local URLs, shell reports and ids", async () => {
    assert.deepEqual(lib.findLocalUrls("\x1b[32m  ➜  Local:\x1b[0m   http://localhost:\x1b[1m5173\x1b[22m/\r\n"), [
      { url: "http://localhost:5173/", port: 5173 },
    ]);
    assert.deepEqual(lib.findLocalUrls("ready on http://0.0.0.0:3000, also http://127.0.0.1:3000."), [
      { url: "http://localhost:3000", port: 3000 },
      { url: "http://127.0.0.1:3000", port: 3000 },
    ]);
    assert.deepEqual(lib.findLocalUrls("  Local:   http://localhost:5173/\n  Network: http://192.168.1.4:5173/"), [
      { url: "http://localhost:5173/", port: 5173 },
    ]);
    assert.deepEqual(lib.findLocalUrls("see https://example.com and http://app.localhost:8080/x"), [
      { url: "http://app.localhost:8080/x", port: 8080 },
    ]);
    assert.deepEqual(
      lib.shellReports("\x1b]633;P;Cwd=/a\\x3bb\x07\x1b]633;E;pnpm dev\\x3b echo hi;nonce\x07"),
      { commands: ["pnpm dev; echo hi"], cwds: ["/a;b"] },
    );
    assert.equal(lib.completeLines("a http://localhost:5"), "");
    assert.equal(lib.completeLines("one\r\ntwo http://localhost:5"), "one\r\n");
    assert.equal(lib.suggestServerId("pnpm dev", "/r"), "dev");
    assert.equal(lib.suggestServerId("PORT=3 npm run storybook -- -p 6006", "/r"), "storybook");
    assert.equal(lib.suggestServerId("python3 -m http.server 8000", "/r"), "python3");
    assert.equal(lib.suggestServerId("./bin/serve", "/repo/my app"), "serve");
    assert.throws(() => lib.checkCommand("a\nb"), /one line/);
    assert.throws(() => lib.checkPort(70000), /1 to 65535/);
    assert.throws(() => lib.checkUrl("file:///etc/passwd"), /http or https/);
    assert.throws(() => lib.checkEnv({ "BAD NAME": "x" }), /not a variable name/);
    assert.deepEqual(lib.serverShellArgs("bash", ["--rcfile", "/i/bashrc", "-i"], "pnpm dev"), ["--rcfile", "/i/bashrc", "-ic", "pnpm dev"]);
    assert.deepEqual(lib.serverShellArgs("pwsh", ["-NoLogo"], "pnpm dev"), ["-NoLogo", "-Command", "pnpm dev"]);
    assert.deepEqual(lib.serverShellArgs("cmd", [], "pnpm dev"), ["/D", "/S", "/C", "pnpm dev"]);
    assert.match(lib.serverPaneId("ws-1", "web", 1000), /^server-ws-1-web-rs$/);
    assert.deepEqual(lib.shellReports("\x1b]7;file://host/Users/a%20b/app\x1b\\"), { commands: [], cwds: ["/Users/a b/app"] });
    assert.equal(lib.shellWord("it's"), `'it'\\''s'`);
    assert.equal(lib.shellWord("--port=3000"), "--port=3000");
    assert.deepEqual(lib.splitEnvPrefix(`API_KEY=sk-1 B='x y' C="z" pnpm dev -- --port 3`), {
      command: "pnpm dev -- --port 3",
      env: { API_KEY: "sk-1", B: "x y", C: "z" },
    });
    assert.deepEqual(lib.splitEnvPrefix("PORT=$P pnpm dev"), { command: "PORT=$P pnpm dev", env: {} }, "a value the shell expands stays");
    assert.deepEqual(lib.splitEnvPrefix("X=~/a node s"), { command: "X=~/a node s", env: {} });
    assert.deepEqual(lib.splitEnvPrefix("ONLY=1"), { command: "ONLY=1", env: {} });
    assert.deepEqual(lib.splitEnvPrefix("pnpm dev FOO=bar"), { command: "pnpm dev FOO=bar", env: {} });
  });

  await check("the command line and folder of a running process, to start it again", async () => {
    if (process.platform === "win32") return;
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)", "a b"], { cwd: WS_DIR, stdio: "ignore" });
    try {
      await sleep(200);
      const info = await lib.processCommand(child.pid);
      assert.equal(info.command, `${lib.shellWord(process.execPath)} -e 'setTimeout(() => {}, 5000)' 'a b'`);
      assert.equal(info.cwd, WS_DIR);
      assert.equal(await lib.processCommand(-1), null);
    } finally {
      child.kill();
    }
  });

  const sessions = fakeSessions();
  const external = http.createServer((_req, res) => res.end("held"));
  try {
    const store = lib.createServerStore();
    const { keeper, stopped, logWrites } = keeperWith(lib, store, sessions);
    const port = await freePort();
    const command = `exec node ${JSON.stringify(FIXTURE)} ${port}`;
    let first;

    await check("start: runs apart from any agent, waits for ready, learns the URL", async () => {
      first = await keeper.start({ workspaceId: "ws-1", id: "web", command, cwd: "web", env: { SECRET_TOKEN: "s3cret-value" } });
      assert.equal(first.alreadyRunning, false);
      assert.equal(first.ready, true, JSON.stringify(first));
      assert.equal(first.server.state, "running");
      assert.equal(first.server.health, "up");
      assert.equal(first.server.cwd, path.join(WS_DIR, "web"));
      assert.match(first.server.paneId, /^server-ws-1-web-/);
      assert.ok(await until(async () => (await keeper.list("ws-1"))[0].url !== null));
      const [listed] = await keeper.list("ws-1");
      assert.equal(listed.url, `http://localhost:${port}/`);
      assert.equal(listed.port, port);
    });

    await check("only env names are stored, in Codara's workspace data folder", async () => {
      const file = lib.serversFile("ws-1");
      assert.ok(file.startsWith(path.join(CODARA, "workspace-data")), file);
      const text = fs.readFileSync(file, "utf8");
      assert.ok(!text.includes("s3cret-value"), "an env value reached disk");
      assert.deepEqual(JSON.parse(text).servers[0].envNames, ["SECRET_TOKEN"]);
      assert.ok(!fs.existsSync(path.join(WS_DIR, ".codara")), "wrote into the repository");
    });

    await check("a value typed before the command is passed to it but never saved", async () => {
      const inlinePort = await freePort();
      const typed = await keeper.start({ workspaceId: "ws-1", command: `SECRET_TOKEN=inline-s3cret exec node ${JSON.stringify(FIXTURE)} ${inlinePort}` });
      assert.equal(typed.ready, true);
      assert.equal(typed.server.command, `exec node ${JSON.stringify(FIXTURE)} ${inlinePort}`);
      assert.deepEqual(typed.server.envNames, ["SECRET_TOKEN"]);
      assert.match((await keeper.logs("ws-1", typed.server.id)).text, /token=set/);
      assert.ok(!fs.readFileSync(lib.serversFile("ws-1"), "utf8").includes("inline-s3cret"), "an inline env value reached disk");
      const again = await keeper.start({ workspaceId: "ws-1", command: `exec node ${JSON.stringify(FIXTURE)} ${inlinePort}` });
      assert.equal(again.alreadyRunning, true, "the same command without its prefix is the same server");
      await keeper.forget("ws-1", typed.server.id);
      sessions.sessions.delete(typed.server.paneId);
      const learned = await keeper.learn({
        workspaceId: "ws-1",
        paneId: "pane-inline",
        command: "API_KEY=sk-live-123 pnpm dev",
        cwd: WS_DIR,
        url: "http://localhost:1/",
        port: 1,
        source: "user",
      });
      const spec = (await keeper.list("ws-1", { probe: false })).find((server) => server.id === learned);
      assert.equal(spec.command, "pnpm dev");
      assert.deepEqual(spec.envNames, ["API_KEY"]);
      assert.deepEqual(spec.missingEnv, [], "this app session still has the value");
      assert.ok(!fs.readFileSync(lib.serversFile("ws-1"), "utf8").includes("sk-live-123"), "a learned env value reached disk");
      await keeper.forget("ws-1", learned);
      assert.deepEqual(stopped.splice(0), [["pane-inline", null]]);
    });

    await check("never two copies: the same id or the same command is already running", async () => {
      const again = await keeper.start({ workspaceId: "ws-1", id: "web" });
      assert.equal(again.alreadyRunning, true);
      const sameCommand = await keeper.start({ workspaceId: "ws-1", id: "web-two", command, cwd: path.join(WS_DIR, "web") });
      assert.equal(sameCommand.alreadyRunning, true);
      assert.equal(sameCommand.server.id, "web");
      assert.equal(sessions.sessions.size, 1, "a second process was spawned");
    });

    await check("a busy port is refused with what holds it", async () => {
      await assert.rejects(
        keeper.start({ workspaceId: "ws-1", id: "api", command: "exec node -e 0", port }),
        (error) => error instanceof lib.ServerConflictError && /server "web" of this workspace/.test(error.message),
      );
      const held = await freePort();
      await new Promise((resolve) => external.listen(held, "127.0.0.1", resolve));
      await assert.rejects(
        keeper.start({ workspaceId: "ws-1", id: "api", command: "exec node -e 0", port: held }),
        (error) => error instanceof lib.ServerConflictError && /Port \d+ is already in use/.test(error.message),
      );
      const [api] = (await keeper.list("ws-1")).filter((server) => server.id === "api");
      assert.equal(api, undefined, "a refused start saved nothing");
      await keeper.save({ workspaceId: "ws-1", id: "api", command: "exec node -e 0", port: held });
      const saved = (await keeper.list("ws-1")).find((server) => server.id === "api");
      assert.equal(saved.state, "stopped");
      assert.match(saved.conflict ?? "", /already in use/, "the status names the conflict before a start");
      await keeper.forget("ws-1", "api");
    });

    await check("never two copies when two callers start the same server at once", async () => {
      const racePort = await freePort();
      const raceCommand = `exec node ${JSON.stringify(FIXTURE)} ${racePort}`;
      const before = sessions.sessions.size;
      const results = await Promise.all([
        keeper.start({ workspaceId: "ws-1", command: raceCommand, port: racePort }),
        keeper.start({ workspaceId: "ws-1", command: raceCommand, port: racePort }),
        keeper.start({ workspaceId: "ws-1", command: raceCommand, port: racePort, wait: false }),
      ]);
      assert.equal(sessions.sessions.size - before, 1, "two callers spawned two processes");
      assert.equal(results.filter((result) => !result.alreadyRunning).length, 1);
      assert.equal(new Set(results.map((result) => result.server.id)).size, 1, "one server, one id");
      const raced = (await keeper.list("ws-1")).filter((server) => server.command === raceCommand);
      assert.equal(raced.length, 1);
      await keeper.forget("ws-1", raced[0].id);
    });

    await check("logs: plain text since a cursor", async () => {
      const all = await keeper.logs("ws-1", "web");
      assert.match(all.text, /token=set/);
      assert.match(all.text, /Local: {3}http:\/\/localhost:\d+\//);
      assert.equal(all.truncated, false);
      await get(port, "/ping");
      assert.ok(await until(async () => (await keeper.logs("ws-1", "web", all.cursor)).text.includes("GET /ping")));
      const fresh = await keeper.logs("ws-1", "web", all.cursor);
      assert.ok(!fresh.text.includes("token=set"), "since returned old output");
    });

    await check("long output goes to a file under the workspace data folder", async () => {
      const floodPort = await freePort();
      const flood = await keeper.start({ workspaceId: "ws-1", id: "flood", command: `exec node ${JSON.stringify(FIXTURE)} ${floodPort} flood`, port: floodPort });
      assert.equal(flood.ready, true);
      const logs = await keeper.logs("ws-1", "flood");
      assert.equal(logs.truncated, true);
      assert.ok(logs.text.length < 4_200, `${logs.text.length} chars in a reply`);
      assert.ok(logs.fullPath.startsWith(path.join(CODARA, "workspace-data", "ws-1")), logs.fullPath);
      assert.ok(fs.readFileSync(logs.fullPath, "utf8").length > 9_000);
      const writes = logWrites.length;
      const idle = await keeper.logs("ws-1", "flood");
      assert.equal(idle.fullPath, logs.fullPath);
      assert.equal(logWrites.length, writes, "an unchanged log was written again");
      await keeper.stop("ws-1", "flood");
    });

    await check("stop frees the port; stopping twice says so", async () => {
      const result = await keeper.stop("ws-1", "web");
      assert.equal(result.alreadyStopped, false);
      assert.equal(result.server.state, "stopped");
      assert.equal(await lib.portAnswers(port, 300), false);
      assert.equal((await keeper.stop("ws-1", "web")).alreadyStopped, true);
    });

    await check("a browser navigation to a down port names the saved server and how to start it", async () => {
      lib.provideServersService({ keeper: () => keeper, status: () => null, activeWorkspaceId: async () => "ws-1" });
      const hint = await lib.savedServerHint("ws-1", `http://localhost:${port}/app`);
      assert.match(hint, /Server "web" of this workspace serves this port/);
      assert.match(hint, /action "start", id "web"/);
      assert.match(hint, /cora server start web/);
      assert.equal(await lib.savedServerHint(undefined, `http://127.0.0.1:${port}/`), hint, "the workspace on screen when the caller has none");
      assert.match(await lib.savedServerHint("ws-1", "http://localhost:1/"), /start it with codara_terminal_servers/);
      assert.equal(await lib.savedServerHint("ws-1", "https://example.com/"), "");
    });

    await check("restart keeps this session's env values; a crash shows its exit code", async () => {
      await keeper.start({ workspaceId: "ws-1", id: "web" });
      const before = await keeper.logs("ws-1", "web");
      const restarted = await keeper.restart("ws-1", "web");
      assert.equal(restarted.ready, true);
      assert.match((await keeper.logs("ws-1", "web")).text, /token=set/);
      const followed = await keeper.logs("ws-1", "web", before.cursor);
      assert.match(followed.text, /token=set/, "a reader following by cursor missed the restarted process's output");
      assert.ok(followed.cursor > before.cursor);
      assert.match((await keeper.logs("ws-1", "web", followed.cursor + 1_000_000)).text, /token=set/, "a cursor from before an app restart reads it all");
      const session = sessions.sessions.get(restarted.server.paneId);
      process.kill(session.child.pid, "SIGKILL");
      assert.ok(await until(async () => (await keeper.list("ws-1")).find((server) => server.id === "web").state === "exited"));
      const crashed = (await keeper.list("ws-1")).find((server) => server.id === "web");
      assert.equal(crashed.health, "down");
      assert.equal(crashed.exitCode, null, "a signal is not an exit code");
      const quick = await keeper.start({ workspaceId: "ws-1", id: "quick", command: "echo failing on purpose; exit 3" });
      assert.equal(quick.ready, false);
      assert.match(quick.output, /failing on purpose/);
      assert.equal((await keeper.list("ws-1")).find((server) => server.id === "quick").exitCode, 3);
      await keeper.forget("ws-1", "quick");
    });

    await check("after an app restart: the server is known, its missing env is named, auto-start runs once", async () => {
      const second = keeperWith(lib, lib.createServerStore(), sessions).keeper;
      const [web] = (await second.list("ws-1")).filter((server) => server.id === "web");
      assert.equal(web.state, "stopped");
      assert.deepEqual(web.missingEnv, ["SECRET_TOKEN"]);
      await second.save({ workspaceId: "ws-1", id: "web", autoStart: true });
      assert.deepEqual(await second.autoStart("ws-1"), ["web"]);
      assert.deepEqual(await second.autoStart("ws-1"), []);
      assert.ok(await until(async () => /token=missing/.test((await second.logs("ws-1", "web")).text)), "started with the env it had");
      second.stopAll();
      assert.ok(await until(async () => !(await lib.portAnswers(port, 200))));
    });

    await check("a server learned in a pane is not started twice; stop ends its process", async () => {
      const held = external.address().port;
      const id = await keeper.learn({
        workspaceId: "ws-1",
        paneId: "pane-9",
        command: "python3 -m http.server",
        cwd: WS_DIR,
        url: `http://localhost:${held}/`,
        port: held,
        pid: 4321,
        source: "agent",
      });
      assert.equal(id, "python3");
      sessions.sessions.set("pane-9", { alive: true, child: { pid: -1 } });
      const status = (await keeper.list("ws-1")).find((server) => server.id === id);
      assert.equal(status.state, "pane");
      assert.equal(status.health, "up");
      assert.equal(status.source, "agent");
      const again = await keeper.start({ workspaceId: "ws-1", id });
      assert.equal(again.alreadyRunning, true);
      await keeper.stop("ws-1", id);
      assert.deepEqual(stopped, [["pane-9", 4321]], "stopped by its process, not by typing into the pane");
      sessions.sessions.delete("pane-9");
    });

    await check("forget removes it; a remote workspace is refused", async () => {
      assert.deepEqual(await keeper.forget("ws-1", "web"), { id: "web", forgotten: true });
      assert.equal((await keeper.list("ws-1")).some((server) => server.id === "web"), false);
      await assert.rejects(keeper.start({ workspaceId: "ws-remote", command: "pnpm dev" }), /not a local folder/);
    });
  } finally {
    sessions.killAll();
    external.close();
  }

  await check("pane learner: shell reports, split chunks, agent CLIs and other processes", async () => {
    const taps = new Map();
    const learned = [];
    // port -> who listens; a missing port means the platform cannot tell.
    const holders = new Map();
    let withEarly = false;
    const commands = new Map([[7171, { command: "node early.cjs", cwd: "/repo" }], [4242, { command: "node server.cjs 4300", cwd: "/repo/api" }], [5151, { command: "/usr/bin/node /repo/node_modules/.bin/vite", cwd: "/repo" }]]);
    const learner = lib.createPaneLearner({
      async listPanes() {
        return [
          { paneId: "pane-1", workspaceId: "ws-1", profile: "shell" },
          { paneId: "pane-2", workspaceId: "ws-1", profile: "shell" },
          { paneId: "pane-bash", workspaceId: "ws-1", profile: "shell" },
          { paneId: "server-ws-1-web-x", workspaceId: "ws-1", profile: "shell" },
          { paneId: "pane-claude", workspaceId: "ws-1", profile: "claude" },
          ...(withEarly ? [{ paneId: "pane-early", workspaceId: "ws-1", profile: "shell" }] : []),
        ];
      },
      tap(paneId, listener) {
        taps.set(paneId, listener);
        return () => taps.delete(paneId);
      },
      sessionCwd: () => "/fallback",
      recentOutput: (paneId) => (paneId === "pane-early" ? "\x1b]133;D;0\x1b\\\x1b]133;C\x1b\\Listening on http://127.0.0.1:7100\r\n" : ""),
      isKeeperSession: (paneId) => paneId.startsWith("server-"),
      portAnswers: async () => true,
      portHolder: async (port) => holders.get(port),
      processCommand: async (pid) => commands.get(pid) ?? null,
      async learn(input) {
        learned.push(input);
        return "dev";
      },
      adoptAgentPane: (paneId) => paneId === "pane-1",
      sleep: () => Promise.resolve(),
    });
    await learner.sync();
    assert.deepEqual([...taps.keys()].sort(), ["pane-1", "pane-2", "pane-bash", "pane-claude"]);

    // zsh or PowerShell: the shell reports the command, split across chunks.
    holders.set(5173, { pid: 77, paneId: "pane-1" });
    const pane1 = taps.get("pane-1");
    pane1("\x1b]633;P;Cwd=/repo/web\x07\x1b]633;E;pnpm d");
    pane1("ev\x07\r\n  VITE ready\r\n  ➜  Local:   http://localhost:5");
    pane1("173/\r\n");
    await sleep(10);
    assert.deepEqual(learned, [
      { workspaceId: "ws-1", paneId: "pane-1", command: "pnpm dev", cwd: "/repo/web", url: "http://localhost:5173/", port: 5173, pid: 77, source: "agent" },
    ]);
    pane1("GET / 200 http://localhost:5173/x\r\n");
    await sleep(10);
    assert.equal(learned.length, 1, "learned the same server twice");

    const pane2 = taps.get("pane-2");
    holders.set(3000, { pid: 90, paneId: "pane-claude" });
    pane2("\x1b]633;E;cat notes.txt\x07Server was at http://localhost:3000/\r\n");
    await sleep(10);
    assert.equal(learned.length, 1, "a URL another pane's process serves was learned");
    pane2("\x1b]633;E;python3 -m http.server 8000\x07Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...\r\n");
    await sleep(10);
    assert.deepEqual(
      { ...learned[1] },
      { workspaceId: "ws-1", paneId: "pane-2", command: "python3 -m http.server 8000", cwd: "/fallback", url: "http://localhost:8000/", port: 8000, pid: null, source: "user" },
      "with the listener unknown, the shell's own report is enough",
    );

    // bash reports no command line: the listening process's command line and folder are used.
    const bash = taps.get("pane-bash");
    holders.set(4300, { pid: 4242, paneId: "pane-bash" });
    bash("\x1b]7;file://host/repo/api\x1b\\\x1b]133;C\x1b\\  Local:   http://localhost:4300/\n");
    await sleep(10);
    assert.deepEqual(
      { ...learned[2] },
      { workspaceId: "ws-1", paneId: "pane-bash", command: "node server.cjs 4300", cwd: "/repo/api", url: "http://localhost:4300/", port: 4300, pid: 4242, source: "user" },
    );
    // Once it ends, the same pane may start another server on that URL.
    bash("\x1b]133;D;0\x1b\\");
    holders.set(4400, undefined);
    bash("  Local:   http://localhost:4400/\n");
    await sleep(10);
    assert.equal(learned.length, 3, "a URL nobody can tie to the pane was learned without a command report");

    // An agent CLI's own pane: its shell tool's server is learned from the process,
    // and a URL it merely prints is not.
    const agent = taps.get("pane-claude");
    agent("Open http://localhost:8000/ in your browser\n");
    await sleep(10);
    assert.equal(learned.length, 3, "an agent pane learned another pane's server");
    holders.set(5555, { pid: 5151, paneId: "pane-claude" });
    agent("\x1b[2K  ⎿  VITE ready  http://localhost:5555/\n");
    await sleep(10);
    assert.deepEqual(
      { ...learned[3] },
      { workspaceId: "ws-1", paneId: "pane-claude", command: "/usr/bin/node /repo/node_modules/.bin/vite", cwd: "/repo", url: "http://localhost:5555/", port: 5555, pid: 5151, source: "agent" },
    );

    // A pane that printed its URL before the learner first saw it.
    holders.set(7100, { pid: 7171, paneId: "pane-early" });
    withEarly = true;
    await learner.sync();
    await sleep(10);
    assert.deepEqual(
      { ...learned[4] },
      { workspaceId: "ws-1", paneId: "pane-early", command: "node early.cjs", cwd: "/repo", url: "http://127.0.0.1:7100", port: 7100, pid: 7171, source: "user" },
    );

    // An agent CLI typed into a shell: what it prints is not the shell's command.
    pane2("\x1b]633;E;claude --model opus\x07");
    holders.set(6000, undefined);
    pane2("Visit http://localhost:6000/\n");
    await sleep(10);
    assert.equal(learned.length, 5, "an agent CLI's command line was taken for a server's");
    learner.dispose();
    assert.equal(learner.watchedCount(), 0);
  });

  await check("an adopted agent terminal survives its run and stays with its run and runless agents", async () => {
    const registry = new lib.AgentTerminalRegistry();
    registry.register({ paneId: "pane-a", tabId: "tab-a", runId: "run-1", retention: "temporary" });
    assert.equal(registry.isActiveOwnedBy("pane-a", null), false);
    assert.equal(registry.transferToWorkspace("pane-a"), true);
    assert.equal(registry.transferToWorkspace("pane-missing"), false);
    assert.deepEqual(registry.listForRun("run-1"), [], "run cleanup would still close it");
    assert.equal(registry.isActiveOwnedBy("pane-a", "run-1"), true);
    assert.equal(registry.isActiveOwnedBy("pane-a", null), true);
    assert.equal(registry.isActiveOwnedBy("pane-a", "run-2"), false);
    await assert.rejects(registry.close({ paneId: "pane-a", runId: "run-2", stop: async () => undefined, closeTab: async () => undefined }), /another Cora run/);
  });

  await check("status registry: tool hellos, unknown clients, activities", async () => {
    let alive = new Set([111, 222]);
    let clock = 1_000;
    const status = lib.createStatusRegistry({ pidAlive: (pid) => alive.has(pid), now: () => clock });
    status.noteHello({ paneId: "pane-1", workspaceId: "ws-1", runId: null, client: "codex-mcp-client", pid: 111 });
    status.noteHello({ paneId: "pane-x", workspaceId: "ws-1", runId: null, client: "opencode", pid: 222 });
    status.noteHello({ paneId: "pane-y", workspaceId: "ws-2", runId: null, client: "other", pid: 222 });
    const watched = [
      { paneId: "pane-1", workspaceId: "ws-1", tabId: "t1", runtime: "codex", state: "working" },
      { paneId: "pane-2", workspaceId: "ws-1", tabId: "t2", runtime: "claude", state: "idle" },
      { paneId: "pane-3", workspaceId: "ws-2", tabId: "t3", runtime: "grok", state: "idle" },
    ];
    const tools = { claude: true, codex: true, grok: true, pi: false };
    let agents = status.agents("ws-1", watched, tools);
    assert.deepEqual(
      agents.map((agent) => [agent.paneId, agent.runtime, agent.toolsAttached, agent.toolsConnected]),
      [
        ["pane-1", "codex", true, true],
        ["pane-2", "claude", true, false],
        ["pane-x", "opencode", true, true],
      ],
    );
    assert.equal(agents[0].connectedAt, 1_000);
    alive = new Set();
    agents = status.agents("ws-1", watched, tools);
    assert.equal(agents.length, 2, "a hello from an ended process still counts");
    assert.equal(agents[0].toolsConnected, false);
    clock = 5_000;
    const done = status.addActivity({ id: "rec-1", kind: "recording", label: "Screen recording", workspaceId: "ws-1" });
    status.addActivity({ id: "rec-2", kind: "recording", label: "Other", workspaceId: "ws-2" });
    assert.deepEqual(status.snapshotActivities("ws-1").map((entry) => [entry.id, entry.startedAt]), [["rec-1", 5_000]]);
    done();
    assert.deepEqual(status.snapshotActivities("ws-1"), []);
  });

  const launch = await load(
    `
      export * from "./agent-launch-integration";
      export * from "./servers/launch-args";
    `,
    "launch",
  );

  await check("launch arguments: one line of flags, quoted values, nothing a shell would run", async () => {
    assert.deepEqual(launch.checkLaunchArgs("claude", `--model opus --append-system-prompt "be brief; really"`), {
      ok: true,
      argv: ["--model", "opus", "--append-system-prompt", "be brief; really"],
      error: null,
    });
    assert.deepEqual(launch.checkLaunchArgs("codex", "--search -c model_reasoning_effort=high").argv, ["--search", "-c", "model_reasoning_effort=high"]);
    for (const [runtime, text, pattern] of [
      ["claude", "--verbose; rm -rf ~", /shell syntax/],
      ["claude", "--x $(whoami)", /shell syntax/],
      ["claude", '--x "$HOME"', /never expanded/],
      ["claude", "--x 'open", /not closed/],
      ["claude", "--x\n--y", /one line/],
      ["claude", "fix the bug", /Start with a flag/],
      ["claude", "--settings mine.json", /set by Codara/],
      ["claude", "--mcp-config=x.json", /set by Codara/],
      ["codex", "-c mcp_servers.codara-studio.command=x", /set by Codara/],
      ["codex", "--config=notify=[]", /set by Codara/],
      ["grok", "--resume abc", /set by Codara/],
      ["pi", "--mode rpc", /set by Codara/],
    ]) {
      const verdict = launch.checkLaunchArgs(runtime, text);
      assert.equal(verdict.ok, false, `${runtime} ${JSON.stringify(text)}`);
      assert.match(verdict.error, pattern, `${runtime} ${JSON.stringify(text)}`);
    }
    assert.equal(launch.checkLaunchArgs("claude", `--x ${"y".repeat(1_001)}`).ok, false);
  });

  await check("launch arguments reach each launch and the typed-command files, nothing else", async () => {
    await launch.writeIntegrationFiles({
      home: CODARA,
      python: "python3",
      pythonAvailable: true,
      hookScriptSource: path.join(ROOT, "resources", "claude-hooks", "codara-hook.py"),
      notifyScriptSource: path.join(ROOT, "resources", "codex-hooks", "codara-codex-notify.py"),
    });
    const dir = path.join(CODARA, "integrations");
    assert.equal(fs.readFileSync(path.join(dir, "grok", "args.txt"), "utf8"), "");
    const before = launch.claudeLaunchArgs({ userArgs: [] });
    assert.ok(!before.includes("--chrome"));

    await assert.rejects(launch.saveLaunchArgsSettings({ args: { claude: "--verbose && curl x" }, claudeChrome: false }), /claude: /);
    await launch.saveLaunchArgsSettings({
      args: { claude: "--verbose", codex: "--search", grok: "--disable-web-search", pi: "--thinking high" },
      claudeChrome: true,
    });
    await launch.writeShellArgsFiles();
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: [] }).slice(before.length), ["--verbose", "--chrome"]);
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: ["mcp", "list"] }), [], "a management command got flags");
    assert.deepEqual(launch.codexLaunchArgs({ userArgs: [] }).slice(-1), ["--search"]);
    assert.deepEqual(launch.plainAgentLaunchArgs("grok", { userArgs: ["fix the bug"] }), ["--disable-web-search"]);
    assert.deepEqual(launch.plainAgentLaunchArgs("grok", { userArgs: ["login"] }), []);
    assert.deepEqual(launch.plainAgentLaunchArgs("pi", { userArgs: [] }), ["--thinking", "high"]);
    assert.deepEqual(launch.plainAgentLaunchArgs("pi", { userArgs: ["install", "x"] }), []);
    const typed = (cli) => fs.readFileSync(path.join(dir, cli, "args.txt"), "utf8").split("\n").filter(Boolean);
    assert.deepEqual(typed("claude").slice(-2), ["--verbose", "--chrome"]);
    assert.deepEqual(typed("grok"), ["--disable-web-search"]);
    assert.deepEqual(typed("pi"), ["--thinking", "high"]);

    await launch.saveLaunchArgsSettings({ args: { claude: "--no-chrome" }, claudeChrome: true });
    assert.ok(!launch.claudeLaunchArgs({ userArgs: [] }).includes("--chrome"), "--chrome next to --no-chrome");
    await launch.saveLaunchArgsSettings({ args: {}, claudeChrome: false });
    assert.deepEqual(launch.claudeLaunchArgs({ userArgs: [] }), before);
    assert.deepEqual(fs.readdirSync(HOME), [], "something was written into the user's home");
    const saved = JSON.parse(fs.readFileSync(path.join(CODARA, "agent-launch-args.json"), "utf8"));
    assert.deepEqual(saved, { version: 1, args: {}, claudeChrome: false });
  });

  await check("cora server maps onto codara_terminal_servers with the caller's pane", async () => {
    const { serverArgv } = require(path.join(ROOT, "cli", "commands", "servers.cjs"));
    assert.deepEqual(serverArgv(["list"]), ["terminal_servers", "--action", "list"]);
    assert.deepEqual(serverArgv(["start", "web", "--port", "3000"]), ["terminal_servers", "--action", "start", "--id", "web", "--port", "3000"]);
    assert.deepEqual(serverArgv(["start", "--command", "pnpm dev"]), ["terminal_servers", "--action", "start", "--command", "pnpm dev"]);
    assert.equal(serverArgv(["teleport"]), null);

    const home = path.join(TMP, "cora-home");
    fs.mkdirSync(home, { recursive: true });
    const token = "b".repeat(64);
    const calls = [];
    const socket = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { id, method, params } = JSON.parse(body);
        calls.push({ method, params, auth: req.headers.authorization });
        const result =
          params.action === "list"
            ? { servers: [{ id: "web", state: "running", health: "up", url: "http://localhost:3000/", port: 3000, command: "pnpm dev", cwd: "/r" }] }
            : { ok: true };
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      });
    });
    await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
    fs.writeFileSync(path.join(home, "agent-socket.json"), JSON.stringify({ url: `http://127.0.0.1:${socket.address().port}`, token }));
    const env = { PATH: process.env.PATH, HOME: home, CODARA_HOME_DIR: home, SPARK_PANE_ID: "pane-4" };
    const run = (args) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(ROOT, "cli", "cora.cjs"), "server", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    try {
      const listed = await run(["list"]);
      assert.equal(listed.code, 0, listed.stderr);
      assert.match(listed.stdout, /^web\s+running\s+up\s+http:\/\/localhost:3000\//m);
      assert.equal(calls[0].method, "terminal.servers");
      assert.equal(calls[0].auth, `Bearer ${token}`);
      assert.equal(calls[0].params.callerPaneId, "pane-4");
      const started = await run(["start", "web", "--port", "3000"]);
      assert.equal(started.code, 0, started.stderr);
      assert.deepEqual(
        { action: calls[1].params.action, id: calls[1].params.id, port: calls[1].params.port },
        { action: "start", id: "web", port: 3000 },
      );
      const bad = await run(["teleport"]);
      assert.equal(bad.code, 2);
      assert.match(bad.stderr, /unknown action/);
    } finally {
      socket.close();
    }
  });

  assert.deepEqual(REAL_FILES.map(digest), REAL_DIGESTS, "a real CLI config changed");
  console.log(`\nPASS servers: ${passes} checks`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
