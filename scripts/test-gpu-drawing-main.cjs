// The main-process half of drawing with the graphics card
// (src/main/gpu-drawing.ts) with a fake Electron app and preferences store and
// a real state file in a temporary Codara home: the record a guarded run
// writes, a GPU crash, a quit, the preference turned off during the run, the
// start after a fallback (preference turned off, one notice, cleared by
// turning it on by hand), and the row where Codara never turns it off.
//
//   node scripts/test-gpu-drawing-main.cjs
//
// Exits non-zero on any failed assertion.

const { EventEmitter } = require("node:events");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const MODULE_TS = path.join(ROOT, "src", "main", "gpu-drawing.ts");

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "  PASS" : "  FAIL"} ${name}${cond || detail === undefined ? "" : ` (${detail})`}`);
  if (!cond) failures += 1;
}

const STUBS = {
  electron: `module.exports = globalThis.__gpuStubs.electron;`,
  "./file-log": `module.exports = { logMain: (category, message) => globalThis.__gpuStubs.log.push(category + " " + message) };`,
  "./preferences-store": `module.exports = globalThis.__gpuStubs.preferences;`,
  "./ipc": `module.exports = {};`,
};

const stubPlugin = {
  name: "gpu-drawing-main-test",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /^(electron|\.\/file-log|\.\/preferences-store|\.\/ipc)$/ }, (args) => ({
      path: args.path,
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: STUBS[args.path], loader: "js" }));
  },
};

let bundle;
async function build() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-drawing-main-test-"));
  const outfile = path.join(outDir, "gpu-drawing.cjs");
  await esbuild.build({
    entryPoints: [MODULE_TS],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [stubPlugin],
  });
  // require.cache is keyed by the real path; on macOS the temp folder sits
  // behind a symlink (/var -> /private/var), and a cache entry deleted under
  // the other spelling would hand every scenario the first module instance.
  bundle = { outDir, outfile: fs.realpathSync(outfile) };
}

const homes = [];
// A fresh module instance (its plan is module state), Codara home, Electron
// app and preferences store for each scenario.
function fresh({ preference = false, state, gpuCompositing = "enabled" } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-drawing-home-"));
  homes.push(home);
  process.env.CODARA_HOME_DIR = home;
  if (state) fs.writeFileSync(path.join(home, "gpu-drawing.json"), JSON.stringify(state));
  const app = new EventEmitter();
  app.getGPUFeatureStatus = () => ({ gpu_compositing: gpuCompositing });
  const powerMonitor = new EventEmitter();
  const listeners = new Set();
  const prefs = { waylandHardwareAcceleration: preference };
  const preferences = {
    sets: [],
    readPreferenceFromDiskSync: (key) => prefs[key],
    onPreferenceChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setPreference: async (key, value) => {
      prefs[key] = value;
      preferences.sets.push([key, value]);
      for (const listener of listeners) listener(key, { ...prefs });
      return { ...prefs };
    },
  };
  globalThis.__gpuStubs = { electron: { app, powerMonitor }, preferences, log: [] };
  delete require.cache[bundle.outfile];
  const mod = require(bundle.outfile);
  const handlers = new Map();
  mod.registerGpuDrawingIpc((channel, listener) => handlers.set(channel, listener));
  const file = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(home, "gpu-drawing.json"), "utf8"));
    } catch {
      return null;
    }
  };
  return { mod, app, powerMonitor, preferences, handlers, file, log: globalThis.__gpuStubs.log };
}

async function scenarios() {
  console.log("a guarded run");
  {
    const t = fresh({ preference: true });
    const plan = t.mod.decideGpuDrawingAtStartup(true);
    check("the switch on: the graphics card", plan.hardware && plan.guarded);
    check("nothing is written before the lock is owned", t.file() === null);
    t.mod.startGpuDrawingSafetyNet();
    const record = t.file()?.running;
    check("the run records its pid", record?.pid === process.pid && typeof record.startedAt === "string", JSON.stringify(t.file()));
    // The boot id and start time come from /proc, which only Linux has; the
    // record is only ever written on Linux (native Wayland), and elsewhere the
    // pid check alone stands.
    if (process.platform === "linux") {
      check("on Linux it also keeps the boot id and the process start time", typeof record?.bootId === "string" && Number.isInteger(record?.startTicks), JSON.stringify(t.file()));
    }
    t.app.emit("child-process-gone", {}, { type: "Utility", reason: "crashed", exitCode: 1 });
    check("another process dying writes nothing", !t.file()?.fallback);
    t.app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 139 });
    check("a GPU crash writes the marker", t.file()?.fallback?.reason === "gpu-crash" && t.file().fallback.detail === "crashed (exit code 139)");
    t.app.emit("child-process-gone", {}, { type: "GPU", reason: "oom", exitCode: 1 });
    check("a second crash keeps the first marker", t.file()?.fallback?.detail === "crashed (exit code 139)");
    const status = await t.handlers.get("gpuDrawing:status")();
    check("the window that reloads after the crash gets no notice yet", status.notice === null);
    t.app.emit("will-quit");
    check("a clean exit removes the record and keeps the marker", !t.file()?.running && t.file()?.fallback?.reason === "gpu-crash");
  }

  console.log("a lost graphics context Chromium recovers from");
  {
    const t = fresh({ preference: true });
    t.mod.decideGpuDrawingAtStartup(true);
    t.mod.startGpuDrawingSafetyNet();
    t.app.emit("child-process-gone", {}, { type: "GPU", reason: "abnormal-exit", exitCode: 8 });
    check("one GPU exit of that kind leaves no marker", !t.file()?.fallback);
    t.app.emit("child-process-gone", {}, { type: "GPU", reason: "killed", exitCode: 9 });
    check("a second one in the same run does", t.file()?.fallback?.reason === "gpu-crash" && t.file().fallback.detail === "killed (exit code 9)");
    await t.preferences.setPreference("waylandHardwareAcceleration", false);
    check("turned off by hand after that crash: no marker left to say Codara did it", !t.file()?.fallback && t.file()?.running?.pid === process.pid);
  }

  console.log("a quit, a shutdown, the switch turned off during the run");
  {
    const t = fresh({ preference: true });
    t.mod.decideGpuDrawingAtStartup(true);
    t.mod.startGpuDrawingSafetyNet();
    t.app.emit("before-quit");
    check("a quit marks the record", typeof t.file()?.running?.quitAt === "string");
    t.app.emit("child-process-gone", {}, { type: "GPU", reason: "killed", exitCode: 9 });
    check("a GPU exit during the quit is not a crash", !t.file()?.fallback);
  }
  {
    const t = fresh({ preference: true });
    t.mod.decideGpuDrawingAtStartup(true);
    t.mod.startGpuDrawingSafetyNet();
    t.powerMonitor.emit("shutdown");
    check("a system shutdown marks the record", typeof t.file()?.running?.quitAt === "string");
  }
  {
    const t = fresh({ preference: true });
    t.mod.decideGpuDrawingAtStartup(true);
    t.mod.startGpuDrawingSafetyNet();
    await t.preferences.setPreference("waylandHardwareAcceleration", false);
    t.app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 139 });
    check("turned off by hand during the run: a crash leaves no marker", !t.file()?.fallback);
  }
  {
    const t = fresh({ preference: true });
    t.mod.decideGpuDrawingAtStartup(true);
    t.mod.startGpuDrawingSafetyNet();
    // A second instance (SPARK_ALLOW_MULTI) wrote its own record since.
    const theirs = { running: { pid: 1, startedAt: "2026-11-14T10:00:00.000Z" } };
    fs.writeFileSync(path.join(process.env.CODARA_HOME_DIR, "gpu-drawing.json"), JSON.stringify(theirs));
    t.app.emit("will-quit");
    check("a clean exit leaves another instance's record alone", t.file()?.running?.pid === 1);
  }

  console.log("a lock hand-off between the read and the write");
  {
    const old = { running: { pid: process.pid === 1 ? 2 : 1, startedAt: "2026-11-14T10:00:00.000Z" } };
    const t = fresh({ preference: false, state: old });
    t.mod.decideGpuDrawingAtStartup(true);
    // The old instance (pid 1 is always alive) quits cleanly before this one owns the lock.
    fs.rmSync(path.join(process.env.CODARA_HOME_DIR, "gpu-drawing.json"));
    t.mod.startGpuDrawingSafetyNet();
    check("its removed record is not written back", t.file() === null);
  }

  console.log("the start after a fallback");
  {
    const t = fresh({ preference: true, state: { fallback: { reason: "gpu-crash", at: "2026-11-14T10:00:00.000Z", noticeShown: false } } });
    const plan = t.mod.decideGpuDrawingAtStartup(true);
    check("CPU drawing", plan.hardware === false && plan.source === "fallback");
    t.mod.startGpuDrawingSafetyNet();
    await new Promise((resolve) => setImmediate(resolve));
    check("the switch is turned off", JSON.stringify(t.preferences.sets) === JSON.stringify([["waylandHardwareAcceleration", false]]));
    check("no record for a CPU run", !t.file()?.running);
    const status = await t.handlers.get("gpuDrawing:status")();
    check("the status carries the notice and the reason", status.notice !== null && status.turnedOff?.reason === "gpu-crash" && status.activeNow === false);
    await t.handlers.get("gpuDrawing:noticeShown")();
    check("shown once: recorded", t.file()?.fallback?.noticeShown === true);
    const again = await t.handlers.get("gpuDrawing:status")();
    check("then no notice, the reason stays", again.notice === null && again.turnedOff?.reason === "gpu-crash");
    await t.preferences.setPreference("waylandHardwareAcceleration", true);
    check("turned on by hand: the marker is gone", t.file() === null);
    const after = await t.handlers.get("gpuDrawing:status")();
    check("and the row shows no reason, the restart still pending", after.turnedOff === null && after.activeNow === false);
  }
  {
    const t = fresh({ preference: true, state: { running: { pid: 999999999, startedAt: "2026-11-14T10:00:00.000Z" } } });
    const plan = t.mod.decideGpuDrawingAtStartup(true);
    t.mod.startGpuDrawingSafetyNet();
    check("a dead run's record: CPU drawing, unclean-exit marker", !plan.hardware && t.file()?.fallback?.reason === "unclean-exit" && !t.file()?.running);
  }

  console.log("where Codara never turns it off");
  {
    const t = fresh({ preference: true, state: { fallback: { reason: "gpu-crash", at: "2026-11-14T10:00:00.000Z", noticeShown: false } }, gpuCompositing: "disabled_software" });
    const plan = t.mod.decideGpuDrawingAtStartup(false);
    check("the graphics card, whatever the switch or a stray marker say", plan.hardware && plan.availability === "always-on");
    t.mod.startGpuDrawingSafetyNet();
    check("no log, no write, no preference change", t.log.length === 0 && t.file()?.fallback?.noticeShown === false && t.preferences.sets.length === 0);
    const status = await t.handlers.get("gpuDrawing:status")();
    check("the row reports Chromium's own choice, no notice", status.availability === "always-on" && status.activeNow === false && status.notice === null);
    await t.handlers.get("gpuDrawing:noticeShown")();
    check("the notice call writes nothing there", t.file()?.fallback?.noticeShown === false);
  }
}

(async () => {
  const savedHome = process.env.CODARA_HOME_DIR;
  await build();
  try {
    await scenarios();
  } finally {
    if (savedHome === undefined) delete process.env.CODARA_HOME_DIR;
    else process.env.CODARA_HOME_DIR = savedHome;
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bundle.outDir, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall gpu-drawing main checks passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
