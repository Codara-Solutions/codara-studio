#!/usr/bin/env node
"use strict";

// The event-loop probe (src/main/diagnostics/event-loop-probe.ts) keeps a
// stall that crosses a window boundary. When the loop comes back, the window
// timer can run before the sampler; with perf_hooks' monitorEventLoopDelay the
// window's reset() also forgot the last sample, so the stall showed in
// neither window. Runs on scripts/fake-clock.cjs, whose stall() blocks the
// loop without firing timers, so the order is exact and no real time passes.
//
// It also guards what is not a stall: a wall-clock jump (the probe measures
// on the monotonic clock) and a system sleep (macOS's and Windows' monotonic
// clocks keep counting through it, so the probe pauses on powerMonitor's
// 'suspend' and, should that event be missed, drops a sample too long to be
// anything but a sleep).
//
// What this suite can and cannot prove: main's old probe used perf_hooks'
// native histogram, which this fake clock cannot drive, so its failure there
// says nothing about the boundary bug. The boundary fix itself was shown
// with real-time runs (see the pull request).
//
//   node scripts/test-event-loop-probe-boundary.cjs

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`not ok - ${name}`);
    console.log(error && error.stack ? error.stack : String(error));
  }
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-event-loop-boundary-"));
  const outfile = path.join(temp, "event-loop-probe.cjs");
  try {
    esbuild.buildSync({
      entryPoints: [path.join(ROOT, "src", "main", "diagnostics", "event-loop-probe.ts")],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
      alias: { "@shared": path.join(ROOT, "src", "shared") },
    });
    const clock = require("./fake-clock.cjs").installFakeClock({ start: 1_800_000_000_000, performance: true });
    const probe = require(outfile);
    // 325 ms windows against the 50 ms sampler: a boundary at +325 while the
    // sampler last ran at +300, so after a stall the window timer is due first.
    const env = { CODARA_EVENT_LOOP_WINDOW_MS: "325" };

    await check("a stall that crosses a window boundary shows in the next window", async () => {
      const lines = [];
      assert.equal(probe.startEventLoopProbe((line) => lines.push(line), env), true);
      await clock.advance(310);
      clock.stall(1_200);
      await clock.advance(400);
      probe.stopEventLoopProbe();
      const windows = probe.recentEventLoopWindows();
      assert.ok(windows.length >= 2, JSON.stringify(windows));
      assert.ok(windows[0].maxMs < 100, `the window before the stall: ${JSON.stringify(windows[0])}`);
      assert.ok(windows.some((window) => window.maxMs >= 1_100), JSON.stringify(windows));
      assert.ok(lines.some((line) => /^main event loop stalled for up to 1\.\d s/.test(line)), lines.join("\n"));
    });

    await check("a stall inside a window shows in that window", async () => {
      const before = probe.recentEventLoopWindows().length;
      assert.equal(probe.startEventLoopProbe(() => undefined, env), true);
      await clock.advance(120);
      clock.stall(1_000);
      await clock.advance(300);
      probe.stopEventLoopProbe();
      const windows = probe.recentEventLoopWindows().slice(before);
      assert.ok(windows.some((window) => window.maxMs >= 900), JSON.stringify(windows));
    });

    await check("time spent paused is not a stall", async () => {
      const before = probe.recentEventLoopWindows().length;
      assert.equal(probe.startEventLoopProbe(() => undefined, env), true);
      await clock.advance(100);
      probe.setEventLoopProbeSampling(false);
      await clock.advance(2_000);
      probe.setEventLoopProbeSampling(true);
      await clock.advance(700);
      probe.stopEventLoopProbe();
      const windows = probe.recentEventLoopWindows().slice(before);
      assert.ok(windows.length >= 1, JSON.stringify(windows));
      assert.ok(windows.every((window) => window.maxMs < 100), JSON.stringify(windows));
    });

    const EIGHT_HOURS = 8 * 60 * 60 * 1000;
    const smooth = (windows) => windows.length >= 1 && windows.every((window) => window.maxMs < 100);

    await check("the wall clock jumping 8 hours forward is not a stall", async () => {
      const before = probe.recentEventLoopWindows().length;
      const lines = [];
      assert.equal(probe.startEventLoopProbe((line) => lines.push(line), env), true);
      await clock.advance(120);
      clock.jumpWall(EIGHT_HOURS);
      await clock.advance(700);
      probe.stopEventLoopProbe();
      const windows = probe.recentEventLoopWindows().slice(before);
      assert.ok(smooth(windows), JSON.stringify(windows));
      assert.ok(!lines.some((line) => /stalled/.test(line)), lines.join("\n"));
    });

    // A sleep as macOS and Windows see it: the monotonic clock counts it and no
    // timer fires until the machine is back. 30 s is under the probe's sleep
    // ceiling, so only the pause on 'suspend' keeps it out.
    const SHORT_SLEEP = 30_000;
    await check("a 30 s system sleep between suspend and resume is not a stall", async () => {
      const before = probe.recentEventLoopWindows().length;
      const power = new EventEmitter();
      const lines = [];
      assert.equal(probe.startEventLoopProbe((line) => lines.push(line), env, power), true);
      await clock.advance(120);
      power.emit("suspend");
      clock.stall(SHORT_SLEEP);
      power.emit("resume");
      await clock.advance(700);
      probe.stopEventLoopProbe();
      assert.equal(power.listenerCount("suspend") + power.listenerCount("resume"), 0, "listeners left after stop");
      const windows = probe.recentEventLoopWindows().slice(before);
      assert.ok(smooth(windows), JSON.stringify(windows));
      assert.ok(!lines.some((line) => /stalled/.test(line)), lines.join("\n"));
    });

    await check("a sleep whose resume event comes after the overdue timers is not a stall", async () => {
      const before = probe.recentEventLoopWindows().length;
      const power = new EventEmitter();
      assert.equal(probe.startEventLoopProbe(() => undefined, env, power), true);
      await clock.advance(120);
      power.emit("suspend");
      clock.stall(SHORT_SLEEP);
      await clock.advance(100);
      power.emit("resume");
      await clock.advance(700);
      probe.stopEventLoopProbe();
      const windows = probe.recentEventLoopWindows().slice(before);
      assert.ok(smooth(windows), JSON.stringify(windows));
    });

    await check("a sleep whose suspend event was missed is not a stall", async () => {
      const before = probe.recentEventLoopWindows().length;
      assert.equal(probe.startEventLoopProbe(() => undefined, env, new EventEmitter()), true);
      await clock.advance(120);
      clock.stall(EIGHT_HOURS);
      await clock.advance(700);
      probe.stopEventLoopProbe();
      const windows = probe.recentEventLoopWindows().slice(before);
      assert.ok(smooth(windows), JSON.stringify(windows));
    });

    await check("a stall after a resume still shows", async () => {
      const before = probe.recentEventLoopWindows().length;
      const power = new EventEmitter();
      assert.equal(probe.startEventLoopProbe(() => undefined, env, power), true);
      await clock.advance(120);
      power.emit("suspend");
      clock.stall(SHORT_SLEEP);
      power.emit("resume");
      await clock.advance(120);
      clock.stall(1_500);
      await clock.advance(700);
      probe.stopEventLoopProbe();
      const windows = probe.recentEventLoopWindows().slice(before);
      assert.ok(windows.some((window) => window.maxMs >= 1_400), JSON.stringify(windows));
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  if (failures > 0) process.exit(1);
  console.log("event loop probe boundary: all passed");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
