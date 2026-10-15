#!/usr/bin/env node
"use strict";

// The freeze watchdog of the crash and freeze black box
// (src/main/diagnostics/hang-*.ts).
//
// - the detector: a freeze is reported once, after the threshold, then as
//   ongoing; heartbeats end it with its full length; a stalled watchdog clock
//   (system sleep) restarts the count instead of reporting a freeze
// - settings from the environment, and no stack capture while a debugger is
//   attached unless asked for
// - the real worker program, minified the way the app bundle is, against a
//   main loop deliberately blocked in a child process:
//     a busy JavaScript loop: recorded with the blocking function on top of
//       the stack, high CPU and the mirrored breadcrumbs, after it recovers
//     a block in native code (a synchronous child process): no stack, a note
//       that says why, low CPU, and the main thread is not left paused
//     a block while a synchronous dialog holds the watchdog, and a healthy
//       stretch: nothing recorded
//     a process that exits mid-freeze: the marker survives, and the next
//       start moves it into hangs.jsonl as not recovered and logs it
// - the main-process side: heartbeats and breadcrumbs reach the worker and a
//   freeze lands in main.log with its stack; a wrapped synchronous dialog
//   holds the watchdog while it is open, whatever it returns or throws
//
//   node scripts/test-diagnostics-hang-watchdog.cjs

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-hang-watchdog-"));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));

const HOME = path.join(TMP, "codara-home");
fs.mkdirSync(HOME, { recursive: true });

// esbuild's synchronous API takes no plugins, so electron is aliased to a file.
const ELECTRON_STUB = path.join(TMP, "electron-stub.cjs");
fs.writeFileSync(
  ELECTRON_STUB,
  "module.exports = { app: { getPath: () => process.env.CODARA_HOME_DIR, isPackaged: false, on() {}, once() {} } };\n",
);

function bundle(entry, name, minify) {
  const outfile = path.join(TMP, `${name}.cjs`);
  esbuild.buildSync({
    entryPoints: [path.isAbsolute(entry) ? entry : path.join(ROOT, entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    minify,
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared"), electron: ELECTRON_STUB },
  });
  return outfile;
}

// The app bundle is minified (electron.vite.config.ts); the worker source is
// built from Function.prototype.toString, so it is tested the same way.
const workerBundle = bundle("src/main/diagnostics/hang-watchdog-worker.ts", "hang-watchdog-worker", true);
const detectionBundle = bundle("src/main/diagnostics/hang-detection.ts", "hang-detection", false);
// One bundle for the watchdog and logMain, so they share one breadcrumb ring
// as they do in the app.
const MAIN_ENTRY = path.join(TMP, "main-entry.ts");
fs.writeFileSync(
  MAIN_ENTRY,
  [
    `export * from ${JSON.stringify(path.join(ROOT, "src/main/diagnostics/hang-watchdog.ts"))};`,
    `export { logMain } from ${JSON.stringify(path.join(ROOT, "src/main/file-log.ts"))};`,
  ].join("\n"),
);
const mainBundle = bundle(MAIN_ENTRY, "hang-watchdog", false);

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

// ── The detector, on a fake clock ──────────────────────────────────────────
const { createHangDetector } = require(detectionBundle);

check("a freeze is reported once after the threshold, then as ongoing, and ends with its length", () => {
  let now = 1_000;
  const detector = createHangDetector({ thresholdMs: 5_000, checkIntervalMs: 500, now: () => now });
  for (let i = 0; i < 9; i += 1) {
    now += 500;
    assert.equal(detector.tick(), null, `no freeze at ${now}`);
  }
  now += 500;
  assert.deepEqual(detector.tick(), { kind: "detected", startedAt: 1_000, unresponsiveMs: 5_000 });
  now += 500;
  assert.deepEqual(detector.tick(), { kind: "ongoing", unresponsiveMs: 5_500 });
  now += 250;
  assert.deepEqual(detector.heartbeat(), { kind: "recovered", durationMs: 5_750 });
  assert.equal(detector.heartbeat(), null, "a second heartbeat ends nothing");
  now += 500;
  assert.equal(detector.tick(), null, "the count restarted at the heartbeat");
});

check("heartbeats keep the detector quiet", () => {
  let now = 0;
  const detector = createHangDetector({ thresholdMs: 2_000, checkIntervalMs: 500, now: () => now });
  for (let i = 0; i < 40; i += 1) {
    now += 500;
    assert.equal(detector.tick(), null);
    if (i % 2 === 0) assert.equal(detector.heartbeat(), null);
  }
});

check("a stalled watchdog clock (system sleep) restarts the count instead of reporting a freeze", () => {
  let now = 0;
  const detector = createHangDetector({ thresholdMs: 5_000, checkIntervalMs: 500, now: () => now });
  now += 500;
  detector.tick();
  now += 60 * 60 * 1000;
  assert.equal(detector.tick(), null, "an hour asleep is not a freeze");
  now += 4_500;
  for (let i = 0; i < 9; i += 1) {
    now += 500;
    const event = detector.tick();
    if (event) {
      assert.equal(event.kind, "detected");
      assert.ok(now - (60 * 60 * 1000 + 500) >= 5_000, "only a real silence after waking counts");
      return;
    }
  }
});

// ── Settings and the main.log line ─────────────────────────────────────────
const main = require(mainBundle);

check("settings come from the environment with safe floors", () => {
  const defaults = main.hangWatchdogSettings({}, false);
  assert.deepEqual(defaults, {
    enabled: true,
    thresholdMs: 5_000,
    heartbeatMs: 1_000,
    checkIntervalMs: 500,
    captureStack: true,
    stackTimeoutMs: 2_000,
  });
  assert.equal(main.hangWatchdogSettings({ CODARA_HANG_WATCHDOG: "0" }, false).enabled, false);
  const fast = main.hangWatchdogSettings(
    { CODARA_HANG_WATCHDOG_THRESHOLD_MS: "1500", CODARA_HANG_WATCHDOG_HEARTBEAT_MS: "200" },
    false,
  );
  assert.equal(fast.thresholdMs, 1_500);
  assert.equal(fast.heartbeatMs, 200);
  assert.equal(fast.checkIntervalMs, 100);
  assert.equal(fast.stackTimeoutMs, 750);
  const silly = main.hangWatchdogSettings({ CODARA_HANG_WATCHDOG_THRESHOLD_MS: "5", CODARA_HANG_WATCHDOG_HEARTBEAT_MS: "-1" }, false);
  assert.equal(silly.thresholdMs, 5_000, "a threshold below the floor falls back");
  assert.equal(silly.heartbeatMs, 1_000);
});

check("no stack capture while a debugger is attached, unless asked for", () => {
  assert.equal(main.hangWatchdogSettings({}, true).captureStack, false);
  assert.equal(main.hangWatchdogSettings({ CODARA_HANG_WATCHDOG_STACKS: "1" }, true).captureStack, true);
  assert.equal(main.hangWatchdogSettings({ CODARA_HANG_WATCHDOG_STACKS: "0" }, false).captureStack, false);
});

check("the main.log line names the length, CPU, memory and the top of the stack by file name", () => {
  const line = main.formatHangLine({
    id: "1",
    startedAt: 0,
    detectedAt: 5_000,
    unresponsiveMs: 5_000,
    durationMs: 7_400,
    recovered: true,
    pid: 1,
    cpuPercent: 98,
    rssBytes: 300 * 1024 * 1024,
    loadAverage: null,
    freeMemoryBytes: null,
    totalMemoryBytes: null,
    stack: [
      { fn: "scanEverything", url: "file:///home/someone/app/out/main/index.js", line: 12, column: 3 },
      { fn: "listOnTimeout", url: "node:internal/timers", line: 581, column: 17 },
    ],
    stackNote: null,
    breadcrumbs: [],
  });
  assert.equal(
    line,
    "main process did not respond for 7.4 s and recovered; cpu 98%, rss 300 MB; stack: scanEverything (index.js:12:3) < listOnTimeout (timers:581:17)",
  );
  assert.ok(!line.includes("/home/someone"), "no full paths in main.log");
});

// ── The real worker against a blocked main loop ────────────────────────────
const SCENARIO = path.join(TMP, "scenario.cjs");
fs.writeFileSync(
  SCENARIO,
  `"use strict";
const { Worker } = require("node:worker_threads");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { hangWatchdogWorkerSource } = require(${JSON.stringify(workerBundle)});
const dir = process.argv[2];
const mode = process.argv[3];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, ms) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) return false;
    await sleep(20);
  }
  return true;
}
function deliberatelyBlockTheMainLoop(ms) {
  const end = Date.now() + ms;
  let spins = 0;
  while (Date.now() < end) spins += 1;
  return spins;
}
function blockThenDie(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
  process.exit(0);
}
(async () => {
  const worker = new Worker(hangWatchdogWorkerSource(), {
    eval: true,
    workerData: {
      pid: process.pid,
      thresholdMs: 700,
      checkIntervalMs: 50,
      logPath: path.join(dir, "hangs.jsonl"),
      markerPath: path.join(dir, "hang-pending.json"),
      maxLogBytes: 1024 * 1024,
      captureStack: true,
      stackTimeoutMs: 400,
      breadcrumbLimit: 5,
    },
  });
  const records = [];
  let ready = false;
  worker.on("message", (message) => {
    if (message.type === "ready") ready = true;
    if (message.type === "hang") records.push(message.record);
  });
  const beat = setInterval(() => worker.postMessage({ type: "heartbeat" }), 100);
  if (!(await waitFor(() => ready, 5000))) throw new Error("the watchdog never started");
  for (let i = 0; i < 7; i += 1) {
    worker.postMessage({ type: "breadcrumb", crumb: { t: Date.now(), category: "test", message: "crumb " + i } });
  }
  await sleep(300);
  if (mode === "die") {
    blockThenDie(2000);
    return;
  }
  deliberatelyBlockTheMainLoop(2000);
  const busyRecorded = await waitFor(() => records.length >= 1, 5000);

  const started = Date.now();
  execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 2000)"]);
  const nativeBlockMs = Date.now() - started;
  const tick = Date.now();
  await sleep(10);
  const timerLatencyMs = Date.now() - tick;
  const nativeRecorded = await waitFor(() => records.length >= 2, 5000);

  // What a synchronous dialog does: the main thread waits on the user.
  worker.postMessage({ type: "hold" });
  deliberatelyBlockTheMainLoop(1500);
  worker.postMessage({ type: "release" });
  await sleep(1500);
  const afterHealthy = records.length;
  clearInterval(beat);
  worker.postMessage({ type: "shutdown" });
  console.log(JSON.stringify({ busyRecorded, nativeRecorded, nativeBlockMs, timerLatencyMs, afterHealthy, records }));
})().catch((error) => {
  console.error(error);
  process.exit(2);
});
`,
);

function runScenario(mode) {
  const dir = fs.mkdtempSync(path.join(TMP, `${mode}-`));
  const result = spawnSync(process.execPath, [SCENARIO, dir, mode], { encoding: "utf8", timeout: 60_000 });
  return { dir, result };
}

const live = runScenario("live");
check("the scenario process finished on its own (the main thread was never left paused)", () => {
  assert.equal(live.result.error, undefined, String(live.result.error));
  assert.equal(live.result.status, 0, live.result.stderr);
});
let outcome = null;
try {
  outcome = JSON.parse(live.result.stdout.trim().split("\n").pop());
} catch {
  outcome = null;
}

check("a busy JavaScript loop is recorded with the blocking function, high CPU and breadcrumbs", () => {
  assert.ok(outcome && outcome.busyRecorded, "a freeze record arrived after the loop ended");
  const record = outcome.records[0];
  assert.equal(record.recovered, true);
  assert.ok(record.unresponsiveMs >= 700, `noticed after the threshold (${record.unresponsiveMs} ms)`);
  assert.ok(record.durationMs >= 1_800 && record.durationMs < 4_000, `lasted about 2 s (${record.durationMs} ms)`);
  assert.ok(Array.isArray(record.stack) && record.stack.length > 0, `a stack (${record.stackNote})`);
  assert.equal(record.stack[0].fn, "deliberatelyBlockTheMainLoop");
  assert.match(record.stack[0].url, /scenario\.cjs$/);
  assert.ok(record.stack[0].line > 1);
  assert.equal(record.stackNote, null);
  assert.ok(record.cpuPercent >= 25, `the main thread was computing (${record.cpuPercent}%)`);
  assert.ok(record.rssBytes > 0);
  assert.deepEqual(
    record.breadcrumbs.map((crumb) => crumb.message),
    ["crumb 2", "crumb 3", "crumb 4", "crumb 5", "crumb 6"],
    "the last breadcrumbs, capped",
  );
});

check("a block in native code is recorded without a stack, says why, and leaves the main thread running", () => {
  assert.ok(outcome && outcome.nativeRecorded, "a freeze record arrived after the native block");
  assert.ok(outcome.nativeBlockMs >= 1_800, `the block lasted (${outcome.nativeBlockMs} ms)`);
  const record = outcome.records[1];
  assert.equal(record.recovered, true);
  assert.ok(record.durationMs >= 1_500, `${record.durationMs} ms`);
  assert.equal(record.stack, null);
  assert.match(record.stackNote, /native code/);
  assert.ok(record.cpuPercent < outcome.records[0].cpuPercent, `waiting used less CPU (${record.cpuPercent}%)`);
  assert.ok(outcome.timerLatencyMs < 250, `timers run right after the block (${outcome.timerLatencyMs} ms)`);
});

check("a held wait and a healthy stretch record nothing, and hangs.jsonl holds one line per freeze", () => {
  assert.equal(outcome && outcome.afterHealthy, 2);
  const lines = fs.readFileSync(path.join(live.dir, "hangs.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => JSON.parse(line).id), outcome.records.map((record) => record.id));
  assert.equal(fs.existsSync(path.join(live.dir, "hang-pending.json")), false, "no freeze left pending");
});

const died = runScenario("die");
check("a process that exits mid-freeze leaves the marker, with the stack", () => {
  assert.equal(died.result.status, 0, died.result.stderr);
  const marker = JSON.parse(fs.readFileSync(path.join(died.dir, "hang-pending.json"), "utf8"));
  assert.equal(marker.recovered, false);
  assert.equal(marker.stack && marker.stack[0].fn, "blockThenDie");
  assert.equal(fs.existsSync(path.join(died.dir, "hangs.jsonl")), false);
});

check("the next start moves the unfinished freeze into hangs.jsonl as not recovered", () => {
  const record = main.consumeUnfinishedHang(died.dir);
  assert.ok(record);
  assert.equal(record.recovered, false);
  assert.equal(fs.existsSync(path.join(died.dir, "hang-pending.json")), false);
  const lines = fs.readFileSync(path.join(died.dir, "hangs.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).recovered, false);
  assert.match(main.formatHangLine(record, true), /^the previous session stopped responding for at least \d/);
  assert.equal(main.consumeUnfinishedHang(died.dir), null, "consumed once");
  fs.writeFileSync(path.join(died.dir, "hang-pending.json"), "{not json");
  assert.equal(main.consumeUnfinishedHang(died.dir), null, "a torn marker is dropped");
  assert.equal(fs.existsSync(path.join(died.dir, "hang-pending.json")), false);
});

// ── The main-process side, wired as the app wires it ───────────────────────
const MAIN_SCENARIO = path.join(TMP, "main-scenario.cjs");
fs.writeFileSync(
  MAIN_SCENARIO,
  `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const watchdog = require(${JSON.stringify(mainBundle)});
const { logMain } = watchdog;
const dir = process.argv[2];
function blockedByATestOnPurpose(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  const settings = watchdog.hangWatchdogSettings(
    { CODARA_HANG_WATCHDOG_THRESHOLD_MS: "600", CODARA_HANG_WATCHDOG_HEARTBEAT_MS: "100" },
    false,
  );
  const started = watchdog.startHangWatchdog(dir, settings);
  const records = [];
  watchdog.onHangRecorded((record) => { records.push(record); });
  await sleep(400);
  logMain("test", "about to block the main loop");
  await sleep(200);
  blockedByATestOnPurpose(1500);
  const end = Date.now() + 5000;
  while (records.length === 0 && Date.now() < end) await sleep(20);
  await sleep(200);
  // A dialog the user takes 1.5 s to answer, opened through the wrapper.
  const dialog = { showMessageBoxSync(ms) { blockedByATestOnPurpose(ms); return 1; } };
  const wrapped = watchdog.holdDuringSyncDialogs(dialog);
  const answer = dialog.showMessageBoxSync(1500);
  await sleep(1500);
  watchdog.stopHangWatchdog();
  console.log(JSON.stringify({ started, running: watchdog.hangWatchdogRunning(), recorded: records[0] ?? null, records: records.length, wrapped, answer }));
})();
`,
);

const wired = (() => {
  const dir = fs.mkdtempSync(path.join(TMP, "wired-"));
  const result = spawnSync(process.execPath, [MAIN_SCENARIO, dir], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, CODARA_HOME_DIR: HOME },
  });
  return { dir, result };
})();

check("the app-side watchdog relays breadcrumbs, logs the freeze to main.log, and stops cleanly", () => {
  assert.equal(wired.result.status, 0, wired.result.stderr);
  const out = JSON.parse(wired.result.stdout.trim().split("\n").pop());
  assert.equal(out.started, true);
  assert.equal(out.running, false, "stopped");
  assert.ok(out.recorded, "a freeze was recorded");
  assert.equal(out.recorded.stack[0].fn, "blockedByATestOnPurpose");
  assert.ok(
    out.recorded.breadcrumbs.some((crumb) => crumb.category === "test" && crumb.message === "about to block the main loop"),
    "logMain lines reach the watchdog as breadcrumbs",
  );
  const log = fs.readFileSync(path.join(HOME, "logs", "main.log"), "utf8");
  assert.match(log, /\[hang\] main process did not respond for \d+\.\d s and recovered; cpu \d+%.*stack: blockedByATestOnPurpose \(main-scenario\.cjs:\d+:\d+\)/);
  assert.deepEqual(out.wrapped, ["showMessageBoxSync"]);
  assert.equal(out.answer, 1, "the dialog's answer comes through");
  assert.equal(out.records, 1, "the wait on a synchronous dialog is not a freeze");
});

check("a wrapped synchronous dialog holds while open and releases whatever happens", () => {
  const events = [];
  const hold = () => {
    events.push("hold");
    return () => events.push("release");
  };
  const dialog = {
    title: "owner",
    showMessageBoxSync(value) {
      events.push(`open ${this.title}`);
      return value * 2;
    },
    showErrorBox() {
      events.push("error box");
      throw new Error("no display");
    },
    showOpenDialog: async () => "not wrapped",
  };
  const asyncOriginal = dialog.showOpenDialog;
  assert.deepEqual(main.holdDuringSyncDialogs(dialog, hold), ["showMessageBoxSync", "showErrorBox"]);
  assert.equal(dialog.showMessageBoxSync(21), 42);
  assert.throws(() => dialog.showErrorBox("t", "c"), /no display/);
  assert.deepEqual(events, ["hold", "open owner", "release", "hold", "error box", "release"]);
  assert.equal(dialog.showOpenDialog, asyncOriginal, "asynchronous dialogs leave the main thread free");
  const release = main.holdHangWatchdog();
  release();
  release();
});

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall hang watchdog checks passed");
