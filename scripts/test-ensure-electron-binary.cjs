#!/usr/bin/env node
"use strict";

// scripts/ensure-electron-binary.cjs: a tree without the Electron program gets
// one before `npm run dev` needs it (issue #206), and both hooks still call it.
// The download itself is a stand-in: nothing here touches the network.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(__dirname, "ensure-electron-binary.cjs");
const { ensureElectronBinary, installedBinary } = require(SCRIPT);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-electron-"));
let made = 0;

/** A stand-in electron package folder. `installer` is the body of its install.js. */
function electronDir({ pathTxt, binary, installer = "" } = {}) {
  const dir = path.join(scratch, `electron-${++made}`);
  fs.mkdirSync(dir, { recursive: true });
  if (installer !== null) fs.writeFileSync(path.join(dir, "install.js"), installer);
  if (pathTxt !== undefined) fs.writeFileSync(path.join(dir, "path.txt"), pathTxt);
  if (binary) {
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", binary), "");
  }
  return dir;
}

/** What the real install.js leaves behind. */
function fakeDownload(dir) {
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "electron"), "");
  fs.writeFileSync(path.join(dir, "path.txt"), "electron");
  return { ok: true };
}

function counted(install) {
  const calls = [];
  const options = [];
  return { calls, options, install: (dir, opts) => (calls.push(dir), options.push(opts), install(dir)) };
}

// The variables this script reads must not leak in from whoever runs the test.
const NO_ENV = {};
const CHILD_ENV = { ...process.env };
delete CHILD_ENV.ELECTRON_EXEC_PATH;
delete CHILD_ENV.ELECTRON_SKIP_BINARY_DOWNLOAD;

try {
  // Already there: nothing is downloaded.
  {
    const dir = electronDir({ pathTxt: "electron", binary: "electron" });
    const spy = counted(fakeDownload);
    const result = ensureElectronBinary({ env: NO_ENV, electronDir: dir, install: spy.install });
    assert.equal(result.status, "present");
    assert.equal(result.binary, path.join(dir, "dist", "electron"));
    assert.equal(spy.calls.length, 0);
  }

  // A clean install: no path.txt, no dist. This is the state #206 was about.
  {
    const dir = electronDir();
    assert.equal(installedBinary(dir), null);
    const spy = counted(fakeDownload);
    const lines = [];
    const result = ensureElectronBinary({ env: NO_ENV, electronDir: dir, install: spy.install, log: (line) => lines.push(line) });
    assert.equal(result.status, "downloaded");
    assert.deepEqual(spy.calls, [dir]);
    assert.equal(lines.length, 1);
    assert.equal(installedBinary(dir), path.join(dir, "dist", "electron"));
  }

  // path.txt is left over but dist was wiped, and an empty path.txt: both count as missing.
  for (const pathTxt of ["electron", "", "  \n"]) {
    const dir = electronDir({ pathTxt });
    const spy = counted(fakeDownload);
    assert.equal(ensureElectronBinary({ env: NO_ENV, electronDir: dir, install: spy.install }).status, "downloaded");
    assert.equal(spy.calls.length, 1);
  }

  // path.txt is read untrimmed, as electron-vite reads it: a name with a
  // trailing newline is not the program that is on disk.
  {
    const dir = electronDir({ pathTxt: "electron\n", binary: "electron" });
    assert.equal(installedBinary(dir), null);
  }

  // ELECTRON_EXEC_PATH: electron-vite starts that program and never looks at
  // path.txt, so nothing is checked or downloaded, strict or not.
  for (const strict of [false, true]) {
    const dir = electronDir({ installer: null });
    const spy = counted(fakeDownload);
    const env = { ELECTRON_EXEC_PATH: "/opt/electron/electron" };
    const result = ensureElectronBinary({ env, strict, electronDir: dir, install: spy.install });
    assert.deepEqual(result, { status: "external", binary: "/opt/electron/electron" });
    assert.equal(spy.calls.length, 0);
  }

  // ELECTRON_SKIP_BINARY_DOWNLOAD: no download during an install, but
  // `npm run dev` (--strict) still gets the program it cannot start without.
  {
    const env = { ELECTRON_SKIP_BINARY_DOWNLOAD: "1" };
    const lenient = counted(fakeDownload);
    assert.equal(ensureElectronBinary({ env, electronDir: electronDir(), install: lenient.install }).status, "skipped");
    assert.equal(lenient.calls.length, 0);
    const strict = counted(fakeDownload);
    assert.equal(ensureElectronBinary({ env, strict: true, electronDir: electronDir(), install: strict.install }).status, "downloaded");
    assert.equal(strict.calls.length, 1);
    const present = electronDir({ pathTxt: "electron", binary: "electron" });
    assert.equal(ensureElectronBinary({ env, electronDir: present, install: lenient.install }).status, "present");
  }

  // Only an install gives the download a time limit.
  {
    const lenient = counted(fakeDownload);
    ensureElectronBinary({ env: NO_ENV, electronDir: electronDir(), install: lenient.install });
    assert.equal(lenient.options[0].timeoutMs, 10 * 60_000);
    const strict = counted(fakeDownload);
    ensureElectronBinary({ env: NO_ENV, strict: true, electronDir: electronDir(), install: strict.install });
    assert.equal(strict.options[0].timeoutMs, undefined);
  }

  // The download fails, or says it worked and left nothing.
  {
    const dir = electronDir();
    const result = ensureElectronBinary({ env: NO_ENV, electronDir: dir, install: () => ({ ok: false, reason: "no network" }) });
    assert.deepEqual(result, { status: "failed", reason: "no network" });
  }
  {
    const dir = electronDir();
    const result = ensureElectronBinary({ env: NO_ENV, electronDir: dir, install: () => ({ ok: true }) });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /still missing/);
  }

  // The electron package itself is not there.
  {
    const dir = electronDir({ installer: null });
    const spy = counted(fakeDownload);
    assert.equal(ensureElectronBinary({ env: NO_ENV, electronDir: dir, install: spy.install }).status, "missing-package");
    assert.equal(spy.calls.length, 0);
  }

  // The default installer runs the package's own install.js with this Node.
  {
    const dir = electronDir({
      installer: `
        const fs = require("node:fs"), path = require("node:path");
        fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
        fs.writeFileSync(path.join(__dirname, "dist", "electron"), "");
        fs.writeFileSync(path.join(__dirname, "path.txt"), "electron");
      `,
    });
    assert.equal(ensureElectronBinary({ env: NO_ENV, electronDir: dir }).status, "downloaded");
  }
  {
    const dir = electronDir({ installer: "process.exit(3);" });
    const result = ensureElectronBinary({ env: NO_ENV, electronDir: dir });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /exit code 3/);
  }

  // As a command, against a copy of the script whose electron package is a
  // stand-in: a failed download is a warning after an install and an error
  // before `npm run dev`.
  {
    const repo = path.join(scratch, "repo");
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(repo, "node_modules", "electron"), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(repo, "scripts", "ensure-electron-binary.cjs"));
    const installer = path.join(repo, "node_modules", "electron", "install.js");
    let extraEnv = {};
    const run = (...args) =>
      spawnSync(process.execPath, [path.join(repo, "scripts", "ensure-electron-binary.cjs"), ...args], {
        encoding: "utf8",
        env: { ...CHILD_ENV, ...extraEnv },
      });

    fs.writeFileSync(installer, "process.exit(1);");
    extraEnv = { ELECTRON_EXEC_PATH: "/opt/electron/electron" };
    const external = run("--strict");
    assert.equal(external.status, 0, external.stderr);
    assert.equal(external.stdout + external.stderr, "");
    extraEnv = { ELECTRON_SKIP_BINARY_DOWNLOAD: "1" };
    const skipped = run();
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.match(skipped.stdout, /ELECTRON_SKIP_BINARY_DOWNLOAD is set/);
    extraEnv = {};

    const lenient = run();
    assert.equal(lenient.status, 0, lenient.stderr);
    assert.match(lenient.stderr, /could not download the Electron program/);
    const strict = run("--strict");
    assert.equal(strict.status, 1);
    assert.match(strict.stderr, /node node_modules\/electron\/install\.js/);

    fs.writeFileSync(
      installer,
      `
        const fs = require("node:fs"), path = require("node:path");
        fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
        fs.writeFileSync(path.join(__dirname, "dist", "electron"), "");
        fs.writeFileSync(path.join(__dirname, "path.txt"), "electron");
      `,
    );
    const fixed = run("--strict");
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.match(fixed.stdout, /downloaded/);
    const again = run("--strict");
    assert.equal(again.status, 0);
    assert.equal(again.stdout, "");

    fs.rmSync(path.join(repo, "node_modules"), { recursive: true });
    const noPackage = run("--strict");
    assert.equal(noPackage.status, 1);
    assert.match(noPackage.stderr, /npm install/);
  }

  // Both hooks call it, and before the steps that need the program.
  {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const call = "node scripts/ensure-electron-binary.cjs";
    assert.ok(scripts.postinstall.startsWith(`${call} && `), `postinstall starts with the check: ${scripts.postinstall}`);
    assert.ok(!scripts.postinstall.includes("--strict"), "a failed download must not fail npm install");
    assert.ok(scripts.predev.startsWith(`${call} --strict && `), `predev starts with the strict check: ${scripts.predev}`);
  }

  console.log("ensure-electron-binary: ok");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
