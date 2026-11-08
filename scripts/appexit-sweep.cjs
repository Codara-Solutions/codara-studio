// Temporary (issue 170): SIGTERM a healthy instance at a sweep of delays
// around the old 3 s signal re-install and time each exit. Removed before
// the pull request is marked ready.
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { useVirtualDisplay } = require("./virtual-display.cjs");

const MAIN = path.join(__dirname, "..", "out", "main", "index.js");
const electron = require("electron");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function once(delay, samples) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "appexit-sweep-"));
  fs.mkdirSync(path.join(home, "user-home"));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SPARK_|CODARA_(?!E2E_DISPLAY$)|DBUS_SESSION_BUS_ADDRESS$|ELECTRON_RENDERER_URL$)/.test(k))),
    HOME: path.join(home, "user-home"),
    CODARA_HOME_DIR: home,
    SPARK_HOME_DIR: home,
    SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1",
    SPARK_NO_SHELL_INTEGRATION: "1",
    SPARK_E2E_BACKGROUND: "1",
  };
  const child = spawn(electron, [MAIN], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const log = () => {
    try {
      return fs.readFileSync(path.join(home, "logs", "main.log"), "utf8");
    } catch {
      return "";
    }
  };
  const bootBy = Date.now() + 60_000;
  while (!log().includes("app start pid=") && Date.now() < bootBy) await sleep(10);
  await sleep(delay);
  const termAt = Date.now();
  child.kill("SIGTERM");
  const result = await Promise.race([exited, sleep(15_000).then(() => null)]);
  const took = Date.now() - termAt;
  const received = /received SIGTERM/.test(log());
  const forced = /forcing/.test(stderr);
  let stack = "";
  if (!result) {
    if (process.platform === "darwin" && samples.left > 0) {
      samples.left -= 1;
      try {
        const out = execFileSync("sample", [String(child.pid), "1", "-mayDie"], { encoding: "utf8", timeout: 30_000 });
        const start = out.indexOf("Call graph:");
        stack = `\n${out.slice(start, start + 5000)}`;
      } catch (error) {
        stack = `\nsample failed: ${error.message}`;
      }
    }
    child.kill("SIGKILL");
    await exited;
  }
  fs.rmSync(home, { recursive: true, force: true });
  return { delay, took, exited: Boolean(result), received, forced, stack };
}

(async () => {
  if (process.platform === "linux" && !useVirtualDisplay()) throw new Error("no private display");
  const delays = [];
  for (let round = 0; round < 3; round += 1) for (let d = 2400; d <= 3600; d += 100) delays.push(d);
  const samples = { left: 2 };
  let stuck = 0;
  for (const delay of delays) {
    const r = await once(delay, samples);
    if (!r.exited || r.took > 8000) stuck += 1;
    console.log(`delay=${r.delay} took=${r.took} exited=${r.exited} receivedSIGTERM=${r.received} forced=${r.forced}${r.stack}`);
  }
  console.log(`STUCK ${stuck}/${delays.length}`);
})();
