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
  return { calls, install: (dir) => (calls.push(dir), install(dir)) };
}

try {
  // Already there: nothing is downloaded.
  {
    const dir = electronDir({ pathTxt: "electron", binary: "electron" });
    const spy = counted(fakeDownload);
    const result = ensureElectronBinary({ electronDir: dir, install: spy.install });
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
    const result = ensureElectronBinary({ electronDir: dir, install: spy.install, log: (line) => lines.push(line) });
    assert.equal(result.status, "downloaded");
    assert.deepEqual(spy.calls, [dir]);
    assert.equal(lines.length, 1);
    assert.equal(installedBinary(dir), path.join(dir, "dist", "electron"));
  }

  // path.txt is left over but dist was wiped, and an empty path.txt: both count as missing.
  for (const pathTxt of ["electron", "", "  \n"]) {
    const dir = electronDir({ pathTxt });
    const spy = counted(fakeDownload);
    assert.equal(ensureElectronBinary({ electronDir: dir, install: spy.install }).status, "downloaded");
    assert.equal(spy.calls.length, 1);
  }

  // The download fails, or says it worked and left nothing.
  {
    const dir = electronDir();
    const result = ensureElectronBinary({ electronDir: dir, install: () => ({ ok: false, reason: "no network" }) });
    assert.deepEqual(result, { status: "failed", reason: "no network" });
  }
  {
    const dir = electronDir();
    const result = ensureElectronBinary({ electronDir: dir, install: () => ({ ok: true }) });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /still missing/);
  }

  // The electron package itself is not there.
  {
    const dir = electronDir({ installer: null });
    const spy = counted(fakeDownload);
    assert.equal(ensureElectronBinary({ electronDir: dir, install: spy.install }).status, "missing-package");
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
    assert.equal(ensureElectronBinary({ electronDir: dir }).status, "downloaded");
  }
  {
    const dir = electronDir({ installer: "process.exit(3);" });
    const result = ensureElectronBinary({ electronDir: dir });
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
    const run = (...args) =>
      spawnSync(process.execPath, [path.join(repo, "scripts", "ensure-electron-binary.cjs"), ...args], { encoding: "utf8" });

    fs.writeFileSync(installer, "process.exit(1);");
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
