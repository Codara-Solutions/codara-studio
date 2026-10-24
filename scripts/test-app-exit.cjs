// Unit tests for src/main/app-exit.ts: the dev launcher watch (fake pids and
// timers), the single-instance hand-off between a broken holder and a new
// launch (fake clock, a real answer file), and the termination signals that
// quit without the live-work prompt. The source checks at the end pin the
// wiring in index.ts that the module cannot see. The built app is driven by
// test-app-exit-electron.cjs.
//
//   node scripts/test-app-exit.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const MODULE_TS = path.join(ROOT, "src", "main", "app-exit.ts");
const INDEX_TS = path.join(ROOT, "src", "main", "index.ts");

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "  PASS" : "  FAIL"} ${name}${cond || detail === undefined ? "" : ` (${detail})`}`);
  if (!cond) failures += 1;
}

async function load() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-exit-test-"));
  const outfile = path.join(outDir, "app-exit.cjs");
  await esbuild.build({ entryPoints: [MODULE_TS], bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent" });
  return { mod: require(outfile), outDir };
}

function fakeInterval() {
  const timer = { fn: null, ms: null, cleared: false };
  return {
    timer,
    setInterval: (fn, ms) => {
      timer.fn = fn;
      timer.ms = ms;
      return timer;
    },
    clearInterval: (handle) => {
      if (handle === timer) timer.cleared = true;
    },
  };
}

function fakeClock() {
  let now = 1_000;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

async function main() {
  const { mod, outDir } = await load();

  // ── dev launcher watch ──────────────────────────────────────────────────
  check("watches only an unpackaged app on the dev renderer URL", mod.shouldWatchDevParent({ isPackaged: false, rendererUrl: "http://localhost:5173", parentPid: 4242 }));
  check("never watches a packaged app", !mod.shouldWatchDevParent({ isPackaged: true, rendererUrl: "http://localhost:5173", parentPid: 4242 }));
  check("never watches a build that loads its files", !mod.shouldWatchDevParent({ isPackaged: false, rendererUrl: undefined, parentPid: 4242 }));
  check("never watches when launched by init", !mod.shouldWatchDevParent({ isPackaged: false, rendererUrl: "http://localhost:5173", parentPid: 1 }));

  {
    const t = fakeInterval();
    let ppid = 4242;
    const alive = new Set([4242]);
    const gone = [];
    mod.watchParentProcess({ parentPid: 4242, currentParentPid: () => ppid, isAlive: (pid) => alive.has(pid), onGone: (r) => gone.push(r), setInterval: t.setInterval, clearInterval: t.clearInterval });
    check("checks every 2 seconds", t.timer.ms === 2000, t.timer.ms);
    t.timer.fn();
    t.timer.fn();
    check("a live parent is left alone", gone.length === 0);
    ppid = 1;
    t.timer.fn();
    check("a reparent (Linux, macOS) quits", gone.length === 1 && /parent 4242 is gone \(now 1\)/.test(gone[0]), gone.join());
    check("and stops the watch", t.timer.cleared);
    t.timer.fn();
    check("onGone runs once", gone.length === 1);
  }
  {
    const t = fakeInterval();
    const alive = new Set([77]);
    const gone = [];
    mod.watchParentProcess({ parentPid: 77, currentParentPid: () => 77, isAlive: (pid) => alive.has(pid), onGone: (r) => gone.push(r), setInterval: t.setInterval, clearInterval: t.clearInterval, intervalMs: 500 });
    t.timer.fn();
    alive.delete(77);
    t.timer.fn();
    check("a dead parent without a reparent (Windows) quits", gone.length === 1 && gone[0] === "parent 77 is gone", gone.join());
  }
  {
    const t = fakeInterval();
    const gone = [];
    const stop = mod.watchParentProcess({ parentPid: 9, currentParentPid: () => 2, isAlive: () => false, onGone: (r) => gone.push(r), setInterval: t.setInterval, clearInterval: t.clearInterval });
    stop();
    t.timer.fn();
    check("a stopped watch never fires", gone.length === 0 && t.timer.cleared);
  }

  const err = (code) => Object.assign(new Error(code), { code });
  check("a pid that answers signal 0 is alive", mod.isProcessAlive(10, () => {}));
  check("ESRCH is dead", !mod.isProcessAlive(10, () => { throw err("ESRCH"); }));
  check("EPERM is alive (another user's process)", mod.isProcessAlive(10, () => { throw err("EPERM"); }));
  check("pid 0 and negative pids are never probed", !mod.isProcessAlive(0, () => {}) && !mod.isProcessAlive(-5, () => {}));
  check("this process is alive", mod.isProcessAlive(process.pid));
  {
    const { spawnSync } = require("node:child_process");
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    check("an exited child is dead", !mod.isProcessAlive(Number(child.stdout)), child.stdout);
  }

  // ── termination signals ─────────────────────────────────────────────────
  {
    // A process-like target that records when Node would install its OS
    // handler: on the first listener of a signal.
    const listeners = new Map();
    const installs = [];
    const target = {
      listeners: (signal) => [...(listeners.get(signal) ?? [])],
      removeAllListeners: (signal) => listeners.delete(signal),
      on: (signal, fn) => {
        const list = listeners.get(signal) ?? [];
        if (list.length === 0) installs.push(signal);
        listeners.set(signal, [...list, fn]);
      },
    };
    const signalExit = () => {};
    target.on("SIGTERM", signalExit);
    installs.length = 0;
    const seen = [];
    const onSignal = (signal) => seen.push(signal);
    const installed = mod.installQuitSignals(onSignal, { platform: "linux", target });
    check("Linux and macOS quit on SIGTERM, SIGINT and SIGHUP", JSON.stringify(installed) === JSON.stringify(["SIGTERM", "SIGINT", "SIGHUP"]), installed.join());
    check("an earlier listener does not keep Node from installing its handler again (after Chromium's)", installs.join() === "SIGTERM,SIGINT,SIGHUP", installs.join());
    check("the earlier listener stays, after ours", target.listeners("SIGTERM").length === 2 && target.listeners("SIGTERM")[0] === onSignal && target.listeners("SIGTERM")[1] === signalExit);
    mod.installQuitSignals(onSignal, { platform: "linux", target });
    check("installing again re-installs without doubling our listener", target.listeners("SIGTERM").length === 2 && target.listeners("SIGINT").length === 1 && installs.length === 6, `${target.listeners("SIGTERM").length} ${installs.length}`);
    target.listeners("SIGTERM")[0]("SIGTERM");
    target.listeners("SIGHUP")[0]("SIGHUP");
    check("each signal reaches the quit", JSON.stringify(seen) === JSON.stringify(["SIGTERM", "SIGHUP"]), seen.join());
    const win = mod.installQuitSignals(() => {}, { platform: "win32", target });
    check("Windows adds SIGBREAK", win.includes("SIGBREAK") && win.includes("SIGINT"), win.join());
  }

  // ── single-instance hand-off ────────────────────────────────────────────
  const nonce = "0f8e3c2a-1b4d-4e6f-9a7b-5c3d2e1f0a9b";
  check("the nonce is read from additionalData", mod.handoffNonceOf({ codaraHandoff: nonce }) === nonce);
  check("anything else carries no nonce", mod.handoffNonceOf(null) === null && mod.handoffNonceOf({ codaraHandoff: "../../x" }) === null && mod.handoffNonceOf("x") === null);
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"));
    check("no answer before the holder writes one", mod.readHandoffAnswer(dir, nonce) === null);
    mod.writeHandoffAnswer(dir, nonce, "quitting");
    check("the holder's answer is read back", mod.readHandoffAnswer(dir, nonce) === "quitting");
    check("an answer to another launch is not ours", mod.readHandoffAnswer(dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") === null);
    check("no temp file is left", fs.readdirSync(dir).join() === mod.HANDOFF_FILE, fs.readdirSync(dir).join());
    fs.writeFileSync(path.join(dir, mod.HANDOFF_FILE), "{not json");
    check("a torn file is no answer", mod.readHandoffAnswer(dir, nonce) === null);
    mod.writeHandoffAnswer(dir, nonce, "quitting");
    check("the answer names the holder's pid", mod.readHandoffHolderPid(dir, nonce) === process.pid);
    check("but not to another launch", mod.readHandoffHolderPid(dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") === null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const clock = fakeClock();
    let requests = 0;
    const got = await mod.acquireLockAfterHandoff({ ...clock, requestLock: () => (requests += 1, true), readAnswer: () => "focused" });
    check("a healthy holder keeps the lock and is not asked again", got === false && requests === 0, `${got} ${requests}`);
  }
  {
    const clock = fakeClock();
    let requests = 0;
    const start = clock.now();
    const got = await mod.acquireLockAfterHandoff({ ...clock, requestLock: () => (requests += 1, true), readAnswer: () => null });
    check("no answer (an older Codara) quits as before, within a second", got === false && requests === 0 && clock.now() - start <= 1100, `${got} ${requests} ${clock.now() - start}`);
  }
  {
    const clock = fakeClock();
    let requests = 0;
    const got = await mod.acquireLockAfterHandoff({ ...clock, requestLock: () => (requests += 1) >= 3, readAnswer: () => "quitting" });
    check("a broken holder hands over: the lock is retried until it is free", got === true && requests === 3, `${got} ${requests}`);
  }
  {
    const clock = fakeClock();
    let reads = 0;
    let requests = 0;
    const got = await mod.acquireLockAfterHandoff({ ...clock, requestLock: () => (requests += 1) >= 2, readAnswer: () => ((reads += 1) >= 4 ? "quitting" : null) });
    check("an answer that lands a moment later still counts", got === true && reads === 4, `${got} ${reads}`);
  }
  {
    const clock = fakeClock();
    let requests = 0;
    const start = clock.now();
    const got = await mod.acquireLockAfterHandoff({ ...clock, requestLock: () => (requests += 1, false), readAnswer: () => "quitting" });
    const waited = clock.now() - start;
    check("a holder that never lets go is given up on after 15 s", got === false && waited >= 15_000 && waited <= 15_500, `${got} ${waited}`);
    check("retrying every 250 ms", requests >= 55 && requests <= 61, requests);
  }

  {
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { stdio: "ignore" });
    const started = Date.now();
    const gone = await mod.waitForProcessExit(child.pid, 5_000, 20);
    check("the wait ends when the holder's process is gone", gone && Date.now() - started >= 200, `${gone} ${Date.now() - started} ms`);
    const lingering = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
    check("and gives up on one that stays", (await mod.waitForProcessExit(lingering.pid, 200, 20)) === false);
    lingering.kill();
  }

  // ── wiring in index.ts ──────────────────────────────────────────────────
  const index = fs.readFileSync(INDEX_TS, "utf8");
  const ready = index.slice(index.indexOf("app.whenReady().then(async () => {"));
  check("the signal handlers are installed after ready, and again later (Chromium's would win before)", ready.indexOf("installQuitSignals(onQuitSignal);") !== -1 && index.indexOf("installQuitSignals(onQuitSignal)") > index.indexOf("app.whenReady().then(async () => {") && /setTimeout\(\(\) => installQuitSignals\(onQuitSignal\), 3000\)\.unref\(\);/.test(ready));
  check("a signal quits without the prompt", /function onQuitSignal\(signal: NodeJS\.Signals\): void \{\s*quitWithoutPrompt\(`received \$\{signal\}`\);/.test(index));
  const forced = index.slice(index.indexOf("function quitWithoutPrompt("), index.indexOf("function confirmQuitWithLiveWork("));
  check("the forced quit confirms live work and closes an open prompt before it quits", forced.indexOf("quitWithLiveWorkConfirmed = true;") !== -1 && forced.indexOf("quitPrompt?.abort();") !== -1 && forced.indexOf("quitWithLiveWorkConfirmed = true;") < forced.indexOf("app.quit();"));
  check("the forced quit is logged with the live work it skipped", /logMain\("lifecycle", `\$\{reason\}: quitting without the live-work prompt \(live: /.test(forced));
  check("the live-work prompt never blocks the main thread", !/showMessageBoxSync|showErrorBox\(/.test(index));
  check("the dev launcher watch is gated on the dev renderer URL", /shouldWatchDevParent\(\{\s*isPackaged: app\.isPackaged,\s*rendererUrl: process\.env\.ELECTRON_RENDERER_URL,/.test(index));
  check("the boot parent is recorded at load", /const bootParentPid = process\.ppid;/.test(index));
  const handoff = index.slice(index.indexOf("void lockHandoff?.then("), index.indexOf("app.on(\"second-instance\""));
  check("a launch that lost the lock exits without waiting for ready (macOS never sends it)", /if \(!owned\) \{[^}]*app\.exit\(0\);/.test(handoff));
  check("on macOS a launch handed the lock starts over once the holder is gone", handoff.indexOf("waitForProcessExit(holder") < handoff.indexOf("app.releaseSingleInstanceLock();") && handoff.indexOf("app.releaseSingleInstanceLock();") < handoff.indexOf("app.relaunch();"));
  check("a launch before ready (a macOS relaunch wait) never opens the window", /function showMainWindow\(\): void \{[^}]*if \(!app\.isReady\(\)\) return;/.test(index));
  check("the lock carries the hand-off nonce", /app\.requestSingleInstanceLock\(\{ codaraHandoff: handoffNonce \}\)/.test(index));
  check("SPARK_ALLOW_MULTI still skips the lock and the hand-off", /process\.env\.SPARK_ALLOW_MULTI === "1" \|\|\s*app\.requestSingleInstanceLock/.test(index) && /if \(process\.env\.SPARK_ALLOW_MULTI !== "1"\) \{\s*app\.on\("second-instance"/.test(index));
  const second = index.slice(index.indexOf("function onSecondInstance("), index.indexOf("function onSecondInstance(") + 1200);
  check("a broken holder answers quitting before it quits", second.indexOf('writeHandoffAnswer(userData, nonce, "quitting");\n    quitWithoutPrompt(') !== -1);
  check("a healthy holder answers focused and shows its window", /writeHandoffAnswer\(userData, nonce, "focused"\);\s*showMainWindow\(\);/.test(second));
  check("the final close after cleanup is time-boxed", /const lastResort = setTimeout\(\(\) => \{[\s\S]{0,160}app\.exit\(0\);\s*\}, 3000\);/.test(index));

  fs.rmSync(outDir, { recursive: true, force: true });
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\napp-exit: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
