#!/usr/bin/env node
"use strict";

// An AppImage's APPIMAGE and APPDIR reach every child of it: a Codara pane, a
// terminal emulator that is itself an AppImage, and an unpacked build started
// from either (`npm run package:linux` output reports isPackaged). Such a
// build must not take the user's installed AppImage for its own. Its boot
// cleanup would rewrite the user's real CLI configs, and electron-updater,
// which picks the file to delete and replace from APPIMAGE alone, would
// overwrite the installed .AppImage on update.
//
// Drives the real predicate and boot scrub on throwaway layouts that copy
// what the runtime makes, and the real electron-updater AppImageUpdater with
// a fake app. Every file it could delete is inside its own temp directory.
//
//   node scripts/test-appimage-launch.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-appimage-launch-")));
const LAUNCH_KEYS = ["APPIMAGE", "APPDIR", "OWD", "ARGV0", "APPIMAGE_SILENT_INSTALL", "APPIMAGE_EXIT_AFTER_INSTALL"];

let passes = 0;
async function check(name, fn) {
  await fn();
  passes += 1;
  console.log(`PASS ${name}`);
}

function layout(dir) {
  const exe = path.join(dir, "codara-studio");
  fs.mkdirSync(path.join(dir, "resources"), { recursive: true });
  fs.writeFileSync(exe, "");
  return exe;
}

async function main() {
  const outfile = path.join(TMP, "appimage-launch.cjs");
  await build({
    entryPoints: [path.join(ROOT, "src", "main", "appimage-launch.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    logLevel: "silent",
  });
  const launch = require(outfile);

  // The user's installed AppImage. In TMP so nothing real can be deleted; the
  // predicate does not ask where the file is kept, only the cleanup gate does.
  const installed = path.join(TMP, "Applications", "Codara.AppImage");
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, "installed");
  // What the runtime makes: straight in the temp folder, as mkdtemp names it.
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), ".mount_Codara"));
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "appimage_extracted_"));
  const mountedExe = layout(mount);
  const extractedExe = layout(extracted);
  const unpackedExe = layout(path.join(TMP, "wt", "dist", "linux-unpacked"));
  const nestedMount = path.join(TMP, ".mount_Nested");
  const nestedExe = layout(nestedMount);
  const inherited = {
    APPIMAGE: installed,
    APPDIR: mount,
    OWD: "/home/user",
    ARGV0: "Codara.AppImage",
    APPIMAGE_SILENT_INSTALL: "true",
    APPIMAGE_EXIT_AFTER_INSTALL: "true",
  };

  try {
    await check("only the process running from the runtime's directory is the AppImage", async () => {
      const running = { appImage: installed, appDir: mount, execPath: mountedExe };
      assert.equal(launch.runsFromAppImage(running), true, "from its mount");
      assert.equal(launch.runsFromAppImage({ ...running, appDir: extracted, execPath: extractedExe }), true, "extracted");
      assert.equal(launch.runsFromAppImage({ ...running, appDir: `${mount}/` }), true, "APPDIR with a trailing slash");
      assert.equal(launch.runsFromAppImage({ ...running, execPath: unpackedExe }), false, "an unpacked build in its pane");
      assert.equal(launch.runsFromAppImage({ ...running, execPath: process.execPath }), false, "any other executable");
      assert.equal(launch.runsFromAppImage({ ...running, appDir: extracted }), false, "another AppImage's directory");
      assert.equal(launch.runsFromAppImage({ ...running, appDir: undefined }), false, "APPIMAGE without APPDIR");
      assert.equal(launch.runsFromAppImage({ ...running, appImage: undefined }), false, "APPDIR without APPIMAGE");
      assert.equal(launch.runsFromAppImage({ ...running, appImage: mount }), false, "APPIMAGE is a directory");
      assert.equal(launch.runsFromAppImage({ ...running, appDir: "relative/.mount_Codara" }), false);
      assert.equal(launch.runsFromAppImage({ ...running, appDir: mountedExe }), false, "APPDIR is the executable");
      assert.equal(
        launch.runsFromAppImage({ ...running, appDir: path.dirname(unpackedExe), execPath: unpackedExe }),
        false,
        "an APPDIR that is not the runtime's own directory",
      );
      assert.equal(
        launch.runsFromAppImage({ ...running, appDir: nestedMount, execPath: nestedExe }),
        false,
        "a .mount_ folder deeper in a temporary folder",
      );
    });

    await check("boot drops an inherited AppImage launch and keeps everything else", async () => {
      const env = { ...inherited, APPIMAGE_EXTRACT_AND_RUN: "1", HOME: "/home/user", PATH: "/usr/bin" };
      launch.clearInheritedAppImageLaunch(env, unpackedExe);
      assert.deepEqual(
        LAUNCH_KEYS.filter((key) => key in env),
        [],
        "the unpacked build still names the installed AppImage",
      );
      assert.deepEqual(env, { APPIMAGE_EXTRACT_AND_RUN: "1", HOME: "/home/user", PATH: "/usr/bin" });
    });

    await check("boot keeps the launch of the AppImage it really is", async () => {
      const env = { ...inherited };
      launch.clearInheritedAppImageLaunch(env, mountedExe);
      assert.deepEqual(env, inherited);
    });

    await check("index.ts runs the boot scrub before any other module", async () => {
      const index = fs.readFileSync(path.join(ROOT, "src", "main", "index.ts"), "utf8");
      const first = /^\s*import\s+(?:[^"']*from\s+)?["']([^"']+)["']/m.exec(index);
      assert.equal(first?.[1], "./appimage-launch-boot");
      const boot = fs.readFileSync(path.join(ROOT, "src", "main", "appimage-launch-boot.ts"), "utf8");
      assert.match(boot, /^clearInheritedAppImageLaunch\(process\.env, process\.execPath\);$/m);
    });

    await check("electron-updater leaves the installed AppImage alone once the launch is dropped", async () => {
      const { AppImageUpdater } = require("electron-updater/out/AppImageUpdater");
      const fakeApp = {
        version: "1.0.0",
        name: "codara-studio",
        isPackaged: true,
        appUpdateConfigPath: path.join(TMP, "app-update.yml"),
        userDataPath: TMP,
        baseCachePath: TMP,
        whenReady: () => Promise.resolve(),
        quit() {},
        relaunch() {},
        onQuit() {},
      };
      const saved = Object.fromEntries(LAUNCH_KEYS.map((key) => [key, process.env[key]]));
      try {
        const updater = new AppImageUpdater(null, fakeApp);
        updater.logger = null;
        Object.assign(process.env, inherited);
        // This test process stands in for the unpacked build: its executable
        // is outside the mount.
        launch.clearInheritedAppImageLaunch(process.env, process.execPath);
        assert.equal(updater.isUpdaterActive(), false, "the updater still takes this build for the AppImage");
        assert.throws(() => updater.doInstall({ isSilent: true, isForceRunAfter: false }), /APPIMAGE env is not defined/);
        assert.equal(fs.readFileSync(installed, "utf8"), "installed", "the installed AppImage was touched");

        Object.assign(process.env, inherited);
        launch.clearInheritedAppImageLaunch(process.env, mountedExe);
        assert.equal(updater.isUpdaterActive(), true, "the AppImage itself still updates");
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  } finally {
    fs.rmSync(mount, { recursive: true, force: true });
    fs.rmSync(extracted, { recursive: true, force: true });
  }
  console.log(`\nPASS appimage launch: ${passes} checks`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
