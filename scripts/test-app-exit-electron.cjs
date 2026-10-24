// test-runner: heavy (boots Electron several times)
// The built app's exits that nobody confirms, end to end (npm run build
// first). Each launch gets a throwaway Codara home, HOME and Chromium
// userData:
//
//   1. dev launcher dies: a fake electron-vite parent spawns the app with a
//      dev renderer URL, the parent is SIGKILLed, and the app must exit and
//      say why in main.log.
//   2. SIGTERM while Cora work is live: a chat with a manager turn in flight
//      (the live-work prompt would ask), SIGTERM, and the app must exit
//      within a few seconds after its ordinary quit cleanup.
//   3. a new launch replaces an instance whose window cannot load, and
//   4. still only focuses a healthy one.
//
//   npm run build && node scripts/test-app-exit-electron.cjs
//
// Exits non-zero on any failed assertion.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { useVirtualDisplay } = require("./virtual-display.cjs");

const ROOT = path.resolve(__dirname, "..");
const MAIN = path.join(ROOT, "out", "main", "index.js");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "  PASS" : "  FAIL"} ${name}${cond || detail === undefined ? "" : ` (${detail})`}`);
  if (!cond) failures += 1;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function until(test, timeoutMs, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await test()) return true;
    await sleep(stepMs);
  }
  return Boolean(await test());
}

function closedPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const homes = [];
function freshHome(label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `app-exit-${label}-`));
  fs.mkdirSync(path.join(home, "user-home"), { recursive: true });
  homes.push(home);
  return home;
}

// The live app's pane variables and CLI homes must not reach the test app.
function appEnv(home, extra = {}) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      // No session bus either: no tray icon or notification may reach the desktop.
      ([key]) => !/^(SPARK_|CODARA_(?!E2E_DISPLAY$)|CLAUDE_CONFIG_DIR$|CODEX_HOME$|GROK_HOME$|ZDOTDIR$|ELECTRON_RENDERER_URL$|DBUS_SESSION_BUS_ADDRESS$)/.test(key),
    ),
  );
  return {
    ...inherited,
    HOME: path.join(home, "user-home"),
    CODARA_HOME_DIR: home,
    SPARK_HOME_DIR: home,
    SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1",
    SPARK_NO_SHELL_INTEGRATION: "1",
    ...extra,
  };
}

function mainLog(home) {
  try {
    return fs.readFileSync(path.join(home, "logs", "main.log"), "utf8");
  } catch {
    return "";
  }
}

// Where a process that should have quit or started is stuck: its main
// thread's stack, from macOS's own sampler.
function stackOf(child) {
  if (process.platform !== "darwin" || child.exitCode !== null || child.signalCode !== null) return "";
  try {
    const out = require("node:child_process").execFileSync("sample", [String(child.pid), "1", "-mayDie"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    const start = out.indexOf("Call graph:");
    return `\nstack of ${child.pid}:\n${out.slice(start, start + 6000)}`;
  } catch (error) {
    return `\nsample failed: ${error.message}`;
  }
}

const electron = require("electron");
const launched = new Set();
function launchApp(env) {
  const child = spawn(electron, [MAIN], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  launched.add(child.pid);
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited, stderr: () => stderr };
}

function rpc(handshake, method, params) {
  return new Promise((resolve, reject) => {
    const target = new URL(handshake.url + "/rpc");
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Authorization: `Bearer ${handshake.token}` } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function devLauncherDies() {
  console.log("dev launcher dies");
  const home = freshHome("parent");
  const env = appEnv(home, { SPARK_ALLOW_MULTI: "1", SPARK_E2E_BACKGROUND: "1", ELECTRON_RENDERER_URL: `http://127.0.0.1:${await closedPort()}/` });
  // Stands in for electron-vite: spawns Electron, reports its pid, and stays.
  const launcherScript = `
    const { spawn } = require("node:child_process");
    const app = spawn(process.argv[1], [process.argv[2]], { env: process.env, stdio: "ignore" });
    process.stdout.write(String(app.pid) + "\\n");
    setInterval(() => {}, 60000);
  `;
  const launcher = spawn(process.execPath, ["-e", launcherScript, electron, MAIN], { env, stdio: ["ignore", "pipe", "ignore"] });
  const appPid = await new Promise((resolve) => {
    let out = "";
    launcher.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) resolve(Number(out.trim()));
    });
  });
  launched.add(appPid);
  check("the launcher started the app", Number.isInteger(appPid) && alive(appPid), appPid);
  const watching = await until(() => mainLog(home).includes(`dev mode: watching the launcher (pid ${launcher.pid})`), 60_000);
  check("the app watches its dev launcher", watching, mainLog(home).slice(-600));
  launcher.kill("SIGKILL");
  const startedAt = Date.now();
  const gone = await until(() => !alive(appPid), 15_000);
  check("the app exits once its dev launcher is gone", gone, `still alive after ${Date.now() - startedAt} ms`);
  check("and says why in main.log", new RegExp(`dev launcher parent ${launcher.pid} is gone[^\\n]*: quitting without the live-work prompt`).test(mainLog(home)), mainLog(home).slice(-600));
  if (!gone) process.kill(appPid, "SIGKILL");
}

function fabricateLiveChat(home, runId) {
  const dir = path.join(home, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const callId = "spark-sigterm-live";
  fs.writeFileSync(
    path.join(dir, "run.json"),
    JSON.stringify({
      id: runId,
      title: "a chat mid-turn",
      status: "running",
      createdAt: now,
      updatedAt: now,
      workspaceId: "ws-app-exit",
      cwd: path.join(home, "user-home"),
      steps: [],
      messages: [],
      tasks: [],
      conversationEpoch: 0,
      sparkCalls: [{ id: callId, runId, mode: "chat", model: "gpt-5.6", status: "started", inputMessageIds: ["msg-input-live"], conversationEpoch: 0, createdAt: now }],
      humanMessages: [{ id: "msg-input-live", runId, author: "user", kind: "note", message: "Keep working.", attachments: [], intent: "turn", deliveryState: "submitted", backendTurnId: callId, conversationEpoch: 0, createdAt: now }],
    }),
  );
}

async function sigtermWithLiveWork() {
  console.log("SIGTERM while Cora work is live");
  const home = freshHome("sigterm");
  // No SPARK_E2E_BACKGROUND: under it the live-work prompt never asks, and
  // this case is about a quit that must not ask.
  const app = launchApp(appEnv(home, { SPARK_ALLOW_MULTI: "1" }));
  const handshakeFile = path.join(home, "agent-socket.json");
  const ready = await until(() => fs.existsSync(handshakeFile) && mainLog(home).includes("renderer ready"), 60_000);
  check("the app booted", ready, mainLog(home).slice(-600));
  const handshake = JSON.parse(fs.readFileSync(handshakeFile, "utf8"));
  // Boot recovery is over by now; the run is read on a cache miss, as a
  // chat whose manager turn is still running.
  await sleep(1500);
  fabricateLiveChat(home, "run-app-exit-live");
  await rpc(handshake, "orchestrator.get_worker_status", { runId: "run-app-exit-live", worker_task_id: "wt-none" });
  const startedAt = Date.now();
  app.child.kill("SIGTERM");
  const exited = await Promise.race([app.exited, sleep(10_000).then(() => null)]);
  const took = Date.now() - startedAt;
  check("SIGTERM quits within a few seconds", exited !== null && took < 8_000, `took ${took} ms`);
  check("with the live chat counted, so the prompt was skipped, not empty", /received SIGTERM: quitting without the live-work prompt \(live: 1 chat\(s\)/.test(mainLog(home)), mainLog(home).slice(-800));
  check("after the full quit cleanup (no hard-exit fallback)", !/forcing process\.exit|forcing exit after/.test(app.stderr()), app.stderr().slice(-400));
  if (!exited) app.child.kill("SIGKILL");
}

async function newLaunchReplacesBrokenInstance() {
  console.log("a new launch replaces a broken instance");
  const home = freshHome("handoff");
  const env = appEnv(home, { SPARK_E2E_BACKGROUND: "1", ELECTRON_RENDERER_URL: `http://127.0.0.1:${await closedPort()}/` });
  const first = launchApp(env);
  const broken = await until(() => /renderer failed to boot/.test(mainLog(home)), 60_000);
  check("the first instance cannot load its window", broken, mainLog(home).slice(-600));
  const second = launchApp(env);
  const firstGone = await Promise.race([first.exited.then(() => true), sleep(15_000).then(() => false)]);
  check("the broken instance quits for the new launch", firstGone);
  check("and says why", /a new launch found this instance unable to load its window: quitting/.test(mainLog(home)), mainLog(home).slice(-600));
  const secondStarted = await until(() => mainLog(home).includes(`app start pid=${second.child.pid} `), 20_000);
  check("the new launch takes the lock and starts", secondStarted && second.child.exitCode === null, `${mainLog(home).slice(-600)}\nnew launch: exit=${second.child.exitCode} signal=${second.child.signalCode} stderr=${second.stderr().slice(-1500)}${stackOf(second.child)}`);
  second.child.kill("SIGTERM");
  const secondGone = await Promise.race([second.exited.then(() => true), sleep(10_000).then(() => false)]);
  check("and quits on SIGTERM", secondGone);
  if (!firstGone) first.child.kill("SIGKILL");
  if (!secondGone) second.child.kill("SIGKILL");
}

async function newLaunchFocusesHealthyInstance() {
  console.log("a new launch focuses a healthy instance");
  const home = freshHome("healthy");
  const env = appEnv(home, { SPARK_E2E_BACKGROUND: "1" });
  const first = launchApp(env);
  check("the first instance boots", await until(() => mainLog(home).includes("renderer ready"), 60_000), mainLog(home).slice(-600));
  const startedAt = Date.now();
  const second = launchApp(env);
  const secondGone = await Promise.race([second.exited.then(() => true), sleep(10_000).then(() => false)]);
  check("the new launch quits at once", secondGone && Date.now() - startedAt < 10_000, `${Date.now() - startedAt} ms; main.log ${mainLog(home).slice(-600)}\nnew launch stderr=${second.stderr().slice(-1500)}${stackOf(second.child)}`);
  check("the healthy instance keeps running", first.child.exitCode === null && first.child.signalCode === null);
  check("and started no second app", !mainLog(home).includes(`app start pid=${second.child.pid} `));
  first.child.kill("SIGTERM");
  const firstGone = await Promise.race([first.exited.then(() => true), sleep(10_000).then(() => false)]);
  check("the healthy instance quits on SIGTERM", firstGone);
  if (!secondGone) second.child.kill("SIGKILL");
  if (!firstGone) first.child.kill("SIGKILL");
}

async function main() {
  if (!fs.existsSync(MAIN)) {
    console.error("out/main/index.js is missing: run npm run build first");
    process.exit(1);
  }
  if (process.platform === "linux" && !useVirtualDisplay()) {
    // Case 2 shows a real window; never on the desktop of whoever is here.
    console.log("SKIP no private display (install Xvfb or set CODARA_XVFB)");
    return;
  }
  try {
    await devLauncherDies();
    await sigtermWithLiveWork();
    await newLaunchReplacesBrokenInstance();
    await newLaunchFocusesHealthyInstance();
  } finally {
    for (const pid of launched) {
      if (alive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    await sleep(300);
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
  }
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\napp-exit electron: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
