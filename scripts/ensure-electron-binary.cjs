#!/usr/bin/env node
"use strict";

// Makes sure the Electron program is on disk before anything needs it.
//
// The electron package has no install script: it downloads its program the
// first time `require("electron")` asks for the path. electron-vite does not
// go through that. It reads node_modules/electron/path.txt itself and stops
// with "Electron uninstall" when the file is missing, so `npm run dev` right
// after `npm install` or `npm ci` could not start (issue #206).
//
//   postinstall   node scripts/ensure-electron-binary.cjs
//                 downloads when missing; a failed download (offline, a proxy)
//                 is a warning, so the install itself still finishes.
//   predev        node scripts/ensure-electron-binary.cjs --strict
//                 same, but a failed download ends with exit code 1 and says
//                 how to get it, instead of electron-vite's two words.
//
// The download is the package's own install.js: it knows the version, the
// platform, the checksums and the cache.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ELECTRON_DIR = path.join(__dirname, "..", "node_modules", "electron");

/** The program's path when it is installed, null when it is not. */
function installedBinary(electronDir) {
  let name;
  try {
    name = fs.readFileSync(path.join(electronDir, "path.txt"), "utf8").trim();
  } catch {
    return null;
  }
  if (!name) return null;
  const binary = path.join(electronDir, "dist", name);
  return fs.existsSync(binary) ? binary : null;
}

function runInstaller(electronDir) {
  const result = spawnSync(process.execPath, [path.join(electronDir, "install.js")], { stdio: "inherit" });
  if (result.error) return { ok: false, reason: result.error.message };
  if (result.status !== 0) return { ok: false, reason: `install.js ended with ${result.signal ?? `exit code ${result.status}`}` };
  return { ok: true };
}

/**
 * @returns {{ status: "present" | "downloaded" | "missing-package" | "failed", binary?: string, reason?: string }}
 */
function ensureElectronBinary({ electronDir = ELECTRON_DIR, install = runInstaller, log = () => {} } = {}) {
  if (!fs.existsSync(path.join(electronDir, "install.js"))) {
    return { status: "missing-package", reason: `${electronDir} has no install.js` };
  }
  const present = installedBinary(electronDir);
  if (present) return { status: "present", binary: present };

  log("the Electron program is not downloaded yet, downloading it");
  const installed = install(electronDir);
  if (!installed.ok) return { status: "failed", reason: installed.reason };
  const binary = installedBinary(electronDir);
  if (!binary) return { status: "failed", reason: "install.js finished but the program is still missing" };
  return { status: "downloaded", binary };
}

function main(argv) {
  const strict = argv.includes("--strict");
  const say = (text) => console.log(`[electron] ${text}`);
  const result = ensureElectronBinary({ log: say });
  if (result.status === "present") return 0;
  if (result.status === "downloaded") {
    say("downloaded");
    return 0;
  }
  const problem =
    result.status === "missing-package"
      ? "the electron package is not installed. Run: npm install"
      : `could not download the Electron program (${result.reason}). Run: node node_modules/electron/install.js`;
  if (strict) {
    console.error(`[electron] ${problem}`);
    return 1;
  }
  console.warn(`[electron] ${problem}`);
  return 0;
}

module.exports = { ensureElectronBinary, installedBinary };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
