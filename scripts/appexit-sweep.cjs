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
    ...(process.env.SWEEP_E2E === "0" ? { SPARK_ALLOW_MULTI: "1" } : { SPARK_E2E_BACKGROUND: "1" }),
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
  let result = await Promise.race([exited, sleep(12_000).then(() => null)]);
  let stack = "";
  if (!result && process.platform === "darwin" && samples.left > 0) {
    samples.left -= 1;
    try {
      const out = execFileSync("sample", [String(child.pid), "2", "-mayDie"], { encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
      const start = out.indexOf("Call graph:");
      const end = out.indexOf("Total number in stack");
      const base = /^\s*(0x[0-9a-f]+) - .*com\.github\.Electron\.framework/m.exec(out)?.[1] ?? "?";
      stack = `\nELECTRON_FRAMEWORK_BASE ${base}\n${out.slice(start, end)}`;
    } catch (error) {
      stack = `\nsample failed: ${error.message}`;
    }
  }
  if (!result) result = await Promise.race([exited, sleep(48_000).then(() => null)]);
  const took = Date.now() - termAt;
  const received = /received SIGTERM/.test(log());
  const forced = /forcing/.test(stderr);
  if (!result) {
    child.kill("SIGKILL");
    await exited;
  }
  fs.rmSync(home, { recursive: true, force: true });
  const traces = [...stderr.matchAll(/TRACE (\S+) (\d+)/g)].map((m) => `${m[1]}@${Number(m[2]) - termAt}`).join(" ");
  return { delay, took, exited: Boolean(result), received, forced, stack, traces };
}

(async () => {
  if (process.platform === "linux" && !useVirtualDisplay()) throw new Error("no private display");
  const delays = [];
  for (let round = 0; round < Number(process.env.SWEEP_ROUNDS || 3); round += 1) for (let d = 2400; d <= 3600; d += 100) delays.push(d);
  const samples = { left: 2 };
  let stuck = 0;
  for (const delay of delays) {
    const r = await once(delay, samples);
    if (!r.exited || r.took > 8000) stuck += 1;
    console.log(`delay=${r.delay} took=${r.took} exited=${r.exited} receivedSIGTERM=${r.received} forced=${r.forced}${r.traces && (r.took > 3000 || !r.exited || delay === 2400) ? ` traces: ${r.traces}` : ""}${r.stack}`);
  }
  console.log(`STUCK ${stuck}/${delays.length}`);
})();
