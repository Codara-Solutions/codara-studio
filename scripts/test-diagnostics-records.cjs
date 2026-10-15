#!/usr/bin/env node
"use strict";

// The records the crash and freeze black box keeps on disk and in memory
// (src/main/diagnostics/):
//
// - breadcrumbs: a ring of the last 200 events, one bounded line each, saved
//   to breadcrumbs.json with the last session's file kept beside it
// - crash dumps: listed newest first wherever Crashpad put them, and pruned
//   to the size and count caps, oldest first, with their .meta and
//   attachments; the newest dump always stays
// - the AppImage Crashpad handler: only this launch's handler is matched,
//   and only a real mount point counts
// - the event-loop probe: window maths, which windows reach main.log, and a
//   real stall of the loop showing up in the next window
//
//   node scripts/test-diagnostics-records.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-diagnostics-records-"));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));

function bundle(entry, name) {
  const outfile = path.join(TMP, `${name}.cjs`);
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
  });
  return require(outfile);
}

const crumbs = bundle("src/main/diagnostics/breadcrumbs.ts", "breadcrumbs");
const dumps = bundle("src/main/diagnostics/crash-dumps.ts", "crash-dumps");
const appimage = bundle("src/main/diagnostics/appimage-crashpad.ts", "appimage-crashpad");
const probe = bundle("src/main/diagnostics/event-loop-probe.ts", "event-loop-probe");

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // ── Breadcrumbs ────────────────────────────────────────────────────────────
  await check("the ring keeps the newest entries in order", () => {
    const ring = crumbs.createBreadcrumbRing(5);
    for (let i = 0; i < 12; i += 1) ring.push({ t: i, category: "c", message: String(i) });
    assert.equal(ring.size(), 5);
    assert.deepEqual(ring.list().map((crumb) => crumb.message), ["7", "8", "9", "10", "11"]);
    const small = crumbs.createBreadcrumbRing(3);
    small.push({ t: 1, category: "c", message: "only" });
    assert.deepEqual(small.list().map((crumb) => crumb.message), ["only"]);
  });

  await check("a breadcrumb is one bounded line", () => {
    const crumb = crumbs.makeBreadcrumb("  ", `first line\n  second\tline ${"x".repeat(1000)}`, 42);
    assert.equal(crumb.t, 42);
    assert.equal(crumb.category, "event");
    assert.ok(!crumb.message.includes("\n"));
    assert.ok(crumb.message.startsWith("first line second line x"));
    assert.equal(crumb.message.length, 500);
    assert.ok(crumb.message.endsWith("…"));
  });

  await check("recorded events reach listeners, a failing listener harms nothing, the ring caps at 200", () => {
    crumbs._resetBreadcrumbsForTest();
    const seen = [];
    const off = crumbs.onBreadcrumb((crumb) => seen.push(crumb.message));
    crumbs.onBreadcrumb(() => {
      throw new Error("listener bug");
    });
    for (let i = 0; i < 230; i += 1) crumbs.recordBreadcrumb("test", `event ${i}`);
    off();
    crumbs.recordBreadcrumb("test", "after unsubscribe");
    assert.equal(seen.length, 230);
    const all = crumbs.recentBreadcrumbs();
    assert.equal(all.length, crumbs.BREADCRUMB_CAPACITY);
    assert.equal(all[0].message, "event 31");
    assert.equal(all[all.length - 1].message, "after unsubscribe");
    assert.deepEqual(crumbs.recentBreadcrumbs(2).map((crumb) => crumb.message), ["event 229", "after unsubscribe"]);
  });

  await check("the ring is saved to disk, and the last session's file is kept as .previous", async () => {
    crumbs._resetBreadcrumbsForTest();
    const dir = path.join(TMP, "crumbs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(crumbs.breadcrumbsFile(dir), JSON.stringify({ pid: 1, breadcrumbs: [{ t: 1, category: "old", message: "last session" }] }));
    crumbs.recordBreadcrumb("boot", "before persistence started");
    crumbs.startBreadcrumbPersistence(dir);
    const previous = JSON.parse(fs.readFileSync(crumbs.previousBreadcrumbsFile(dir), "utf8"));
    assert.equal(previous.breadcrumbs[0].message, "last session");
    crumbs.recordBreadcrumb("hang", "main process did not respond");
    await crumbs.persistBreadcrumbsNow();
    const saved = JSON.parse(fs.readFileSync(crumbs.breadcrumbsFile(dir), "utf8"));
    assert.equal(saved.pid, process.pid);
    assert.deepEqual(saved.breadcrumbs.map((crumb) => crumb.message), ["before persistence started", "main process did not respond"]);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(crumbs.breadcrumbsFile(dir)).mode & 0o777, 0o600);
    }
    crumbs.recordBreadcrumb("quit", "flushed on quit");
    crumbs.flushBreadcrumbsSync();
    const flushed = JSON.parse(fs.readFileSync(crumbs.breadcrumbsFile(dir), "utf8"));
    assert.equal(flushed.breadcrumbs.at(-1).message, "flushed on quit");
    crumbs._resetBreadcrumbsForTest();
  });

  // ── Crash dumps ────────────────────────────────────────────────────────────
  const dumpRoot = path.join(TMP, "crash-dumps");
  const MB = 1024 * 1024;
  const base = Date.now() - 100 * 60 * 1000;
  for (let i = 0; i < 25; i += 1) {
    const folder = i % 2 === 0 ? "completed" : "pending";
    const id = `dump-${String(i).padStart(2, "0")}`;
    fs.mkdirSync(path.join(dumpRoot, folder), { recursive: true });
    const file = path.join(dumpRoot, folder, `${id}.dmp`);
    fs.writeFileSync(file, Buffer.alloc(i === 24 ? 12 * MB : MB, 1));
    fs.writeFileSync(path.join(dumpRoot, folder, `${id}.meta`), "meta");
    fs.mkdirSync(path.join(dumpRoot, "attachments", id), { recursive: true });
    fs.writeFileSync(path.join(dumpRoot, "attachments", id, "log.txt"), "attachment");
    const when = new Date(base + i * 60 * 1000);
    fs.utimesSync(file, when, when);
  }
  fs.writeFileSync(path.join(dumpRoot, "settings.dat"), "crashpad");
  fs.writeFileSync(path.join(dumpRoot, "attachments", "dump-03", "decoy.dmp"), "not a report");

  await check("dumps are listed newest first wherever Crashpad put them", async () => {
    const listed = await dumps.listCrashDumps(dumpRoot);
    assert.equal(listed.length, 25, "attachments are not reports");
    assert.equal(listed[0].path, "completed/dump-24.dmp");
    assert.equal(listed[0].bytes, 12 * MB);
    assert.equal(listed[1].path, "pending/dump-23.dmp");
    assert.ok(listed.every((dump, i) => i === 0 || dump.modifiedAt <= listed[i - 1].modifiedAt));
    assert.deepEqual(await dumps.listCrashDumps(path.join(TMP, "missing")), []);
  });

  await check("pruning keeps the newest dump even over the cap, then fills the caps oldest last", async () => {
    const removed = await dumps.pruneCrashDumps(dumpRoot, { maxBytes: 16 * MB, maxCount: 20 });
    const left = await dumps.listCrashDumps(dumpRoot);
    assert.deepEqual(
      left.map((dump) => dump.path),
      ["completed/dump-24.dmp", "pending/dump-23.dmp", "completed/dump-22.dmp", "pending/dump-21.dmp", "completed/dump-20.dmp"],
      "12 MB newest + four 1 MB dumps fit 16 MB",
    );
    assert.equal(removed.length, 20);
    assert.ok(!fs.existsSync(path.join(dumpRoot, "pending", "dump-19.meta")), "the .meta goes with its dump");
    assert.ok(!fs.existsSync(path.join(dumpRoot, "attachments", "dump-19")), "and its attachments");
    assert.ok(fs.existsSync(path.join(dumpRoot, "completed", "dump-22.meta")), "kept dumps keep theirs");
    assert.ok(fs.existsSync(path.join(dumpRoot, "settings.dat")), "Crashpad's own files stay");
    const count = await dumps.pruneCrashDumps(dumpRoot, { maxBytes: 1024 * MB, maxCount: 2 });
    assert.deepEqual(count, ["completed/dump-22.dmp", "pending/dump-21.dmp", "completed/dump-20.dmp"]);
  });

  // ── AppImage Crashpad handler ─────────────────────────────────────────────
  await check("only this launch's Crashpad handler is matched", () => {
    const exes = {
      10: "/tmp/.mount_CodaraAbc/chrome_crashpad_handler",
      11: "/tmp/.mount_CodaraXyz/chrome_crashpad_handler",
      12: "/tmp/.mount_CodaraAbc/codara-studio",
      13: "/opt/Codara/chrome_crashpad_handler",
      14: null,
    };
    const pids = appimage.crashpadHandlersOfLaunch({
      execPath: "/tmp/.mount_CodaraAbc/codara-studio",
      listPids: () => Object.keys(exes).map(Number),
      readExecutable: (pid) => exes[pid],
    });
    assert.deepEqual(pids, [10]);
  });

  await check("only a real mount point counts as the AppImage's mount", () => {
    const devs = { "/tmp/.mount_x": 51, "/tmp": 50, "/tmp/appimage_extracted_1": 50 };
    const stat = (p) => {
      if (!(p in devs)) throw new Error("missing");
      return { dev: devs[p] };
    };
    assert.equal(appimage.isMountRoot("/tmp/.mount_x", stat), true);
    assert.equal(appimage.isMountRoot("/tmp/appimage_extracted_1", stat), false);
    assert.equal(appimage.isMountRoot("/nowhere/x", stat), false);
  });

  await check("outside an AppImage nothing is installed", () => {
    assert.equal(appimage.stopCrashpadHandlerOnAppImageExit({}), false);
    assert.equal(
      appimage.stopCrashpadHandlerOnAppImageExit({ APPIMAGE: path.join(TMP, "x.AppImage"), APPDIR: TMP }),
      false,
      "an inherited AppImage launch is not this process",
    );
  });

  // ── Event-loop probe ──────────────────────────────────────────────────────
  await check("a window reports delay beyond the sampling interval", () => {
    const histogram = {
      percentile: (p) => (p === 50 ? 50.4e6 : 62e6),
      max: 1_290e6,
    };
    assert.deepEqual(probe.summarizeEventLoopWindow(histogram, 60_000, 5), {
      t: 5,
      windowMs: 60_000,
      p50Ms: 0.4,
      p99Ms: 12,
      maxMs: 1_240,
    });
    const empty = { percentile: () => Number.NaN, max: 0 };
    assert.deepEqual(probe.summarizeEventLoopWindow(empty, 1_000, 1), { t: 1, windowMs: 1_000, p50Ms: 0, p99Ms: 0, maxMs: 0 });
  });

  await check("main.log hears about stalls always, delays at most every 10 minutes, and once an hour", () => {
    const state = probe.createEventLoopLogState();
    const minute = 60_000;
    const win = (i, maxMs, p99Ms = 5) => ({ t: i * minute, windowMs: minute, p50Ms: 0.3, p99Ms, maxMs });
    assert.deepEqual(probe.eventLoopLogLines(win(1, 40), state, 60), []);
    assert.deepEqual(probe.eventLoopLogLines(win(2, 300, 40), state, 60), [
      "main event loop delay in the last 1 min: p50 0.3 ms, p99 40 ms, max 300 ms",
    ]);
    assert.deepEqual(probe.eventLoopLogLines(win(3, 400), state, 60), [], "quiet for 10 minutes");
    assert.deepEqual(probe.eventLoopLogLines(win(4, 1_500, 900), state, 60), [
      "main event loop stalled for up to 1.5 s in the last 1 min (p50 0.3 ms, p99 900 ms, max 1.5 s)",
    ]);
    assert.deepEqual(probe.eventLoopLogLines(win(5, 1_100), state, 60).length, 1, "every stall is logged");
    assert.deepEqual(probe.eventLoopLogLines(win(15, 260), state, 60).length, 1, "a delay after 10 quiet minutes is");
    const hourly = probe.createEventLoopLogState();
    let lines = [];
    for (let i = 1; i <= 60; i += 1) lines = lines.concat(probe.eventLoopLogLines(win(i, i === 30 ? 200 : 20, i), hourly, 60));
    assert.deepEqual(lines, ["main event loop over the last 60 min: worst p99 60 ms, worst max 200 ms"]);
  });

  await check("a real stall of the loop shows up in the next window", async () => {
    const lines = [];
    assert.equal(probe.startEventLoopProbe((line) => lines.push(line), { CODARA_EVENT_LOOP_WINDOW_MS: "300" }), true);
    assert.equal(probe.eventLoopProbeRunning(), true);
    await sleep(350);
    const end = Date.now() + 1_200;
    while (Date.now() < end) {
      // The stall under test.
    }
    await sleep(700);
    probe.stopEventLoopProbe();
    assert.equal(probe.eventLoopProbeRunning(), false);
    const windows = probe.recentEventLoopWindows();
    assert.ok(windows.length >= 2);
    assert.ok(windows.some((window) => window.maxMs >= 1_000), JSON.stringify(windows));
    assert.ok(lines.some((line) => /^main event loop stalled for up to 1\.\d s/.test(line)), lines.join("\n"));
    assert.equal(probe.startEventLoopProbe(() => undefined, { CODARA_EVENT_LOOP_PROBE: "0" }), false, "can be switched off");
  });

  await check("a paused probe records no window and sees no stall", async () => {
    const lines = [];
    const before = probe.recentEventLoopWindows().length;
    assert.equal(probe.startEventLoopProbe((line) => lines.push(line), { CODARA_EVENT_LOOP_WINDOW_MS: "200" }), true);
    probe.setEventLoopProbeSampling(false);
    await sleep(250);
    const end = Date.now() + 400;
    while (Date.now() < end) {
      // Unfocused: nobody feels this one.
    }
    await sleep(500);
    const paused = probe.recentEventLoopWindows().length;
    // The window that was open when sampling paused still counts once.
    assert.ok(paused - before <= 1, `windows while paused: ${paused - before}`);
    assert.deepEqual(lines, []);
    probe.setEventLoopProbeSampling(true);
    await sleep(450);
    probe.stopEventLoopProbe();
    assert.ok(probe.recentEventLoopWindows().length > paused, "sampling again records windows again");
    probe.setEventLoopProbeSampling(false);
    assert.equal(probe.eventLoopProbeRunning(), false, "a pause after stop is a no-op");
  });

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall diagnostics record checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
