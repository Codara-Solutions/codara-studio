// src/main/preferences-store.ts: early callers share one read of the
// preferences file, and a value set while that read is in flight is not put
// back by it. Any boolean preference stands in for the one that needs it:
// Codara turns the graphics-card switch off at startup while other modules
// are still loading preferences, and a late read used to restore the old
// value, which the next save then wrote to disk.
//
// The startup reads (readPreferenceFromDiskSync, getPreferenceSync) give the
// defaults when the file is a named pipe or a link to one, instead of
// blocking the process for good; each runs in a child with a deadline, so a
// regression fails instead of hanging the suite (Linux and macOS only).
//
//   node scripts/test-preferences-load.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const MODULE_TS = path.join(ROOT, "src", "main", "preferences-store.ts");

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "  PASS" : "  FAIL"} ${name}${cond || detail === undefined ? "" : ` (${detail})`}`);
  if (!cond) failures += 1;
}

const sharedAlias = {
  name: "preferences-load-test",
  setup(build) {
    // Only reached through imports this test never calls.
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "module.exports = { app: { getPath: () => process.env.CODARA_HOME_DIR, isPackaged: false } };",
      loader: "js",
    }));
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

(async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "preferences-load-test-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "preferences-load-home-"));
  const savedHome = process.env.CODARA_HOME_DIR;
  try {
    const outfile = path.join(outDir, "preferences-store.cjs");
    await esbuild.build({ entryPoints: [MODULE_TS], bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent", plugins: [sharedAlias] });
    process.env.CODARA_HOME_DIR = home;
    fs.writeFileSync(path.join(home, "spark-preferences.json"), JSON.stringify({ remoteAccessEnabled: true }));
    const prefs = require(fs.realpathSync(outfile));

    const first = prefs.loadPreferences();
    const second = prefs.loadPreferences();
    const turnedOff = prefs.setPreference("remoteAccessEnabled", false);
    const late = prefs.loadPreferences();
    const [a, b, , c] = await Promise.all([first, second, turnedOff, late]);
    check("early callers share one read", a === b && b === c);
    check("once all of them settle, the cache holds the value that was set", prefs.getPreferenceCached("remoteAccessEnabled") === false);
    await prefs.flushPreferences();
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, "spark-preferences.json"), "utf8"));
    check("and what is on disk", onDisk.remoteAccessEnabled === false);
    const again = await prefs.loadPreferences();
    check("a load after that returns the cache", again.remoteAccessEnabled === false);
    if (process.platform !== "win32") {
      for (const kind of ["a named pipe", "a link to a named pipe"]) {
        const pipeHome = fs.mkdtempSync(path.join(outDir, "pipe-home-"));
        const file = path.join(pipeHome, "spark-preferences.json");
        const pipe = kind === "a named pipe" ? file : path.join(pipeHome, "pipe");
        if (spawnSync("mkfifo", [pipe]).status !== 0) {
          check(`mkfifo works (${kind})`, false);
          continue;
        }
        if (pipe !== file) fs.symlinkSync(pipe, file);
        const child = `
          const prefs = require(process.argv[1]);
          const fromDisk = prefs.readPreferenceFromDiskSync("remoteAccessEnabled");
          const cached = prefs.getPreferenceSync("remoteAccessEnabled");
          process.stdout.write(JSON.stringify({ fromDisk, cached }));
        `;
        const run = spawnSync(process.execPath, ["-e", child, fs.realpathSync(outfile)], {
          env: { ...process.env, CODARA_HOME_DIR: pipeHome },
          encoding: "utf8",
          timeout: 15_000,
        });
        check(`${kind}: the startup reads return instead of blocking`, run.status === 0 && run.signal === null, `status ${run.status}, signal ${run.signal}`);
        check(`${kind}: with the defaults`, run.stdout === JSON.stringify({ fromDisk: false, cached: false }), run.stdout);
      }
    }
  } finally {
    if (savedHome === undefined) delete process.env.CODARA_HOME_DIR;
    else process.env.CODARA_HOME_DIR = savedHome;
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall preferences-load checks passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
