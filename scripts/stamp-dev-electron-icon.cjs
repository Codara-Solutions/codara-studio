#!/usr/bin/env node
// Stamp the Codara Studio icon + version strings onto the dev Electron binary.
//
// Why this exists: in a packaged build Windows resolves the taskbar button's
// icon through the AppUserModelID ("com.codara.app"), which the NSIS installer
// registers against a Start-Menu shortcut pointing at "Codara Studio.exe" —
// and that exe carries build/icon.ico, so the button looks right.
//
// In an unpackaged dev run there is no registered shortcut, so main/index.ts
// falls back to `app.setAppUserModelId(process.execPath)` (required, or Windows
// silently drops every dev Notification.show()). Windows then draws the taskbar
// button from node_modules/electron/dist/electron.exe — Electron's default atom
// — no matter what BrowserWindow({ icon }) sets. The window icon IS ours
// (WM_GETICON returns it); only the exe-derived taskbar/Task-Manager icon is
// stale. Patching the dev exe's resources is the only thing that fixes it.
//
// Runs from `predev` and `postinstall`. It must NEVER fail the caller: a locked
// exe (an instance is already running) or a missing rcedit is a warning, not an
// error, so `npm run dev` and `npm install` still go through.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const crypto = require("crypto");

const REPO = path.resolve(__dirname, "..");
const ICON = path.join(REPO, "build", "icon.ico");
const ELECTRON_EXE = path.join(REPO, "node_modules", "electron", "dist", "electron.exe");
// Lives beside the exe so an electron reinstall (which wipes dist/) also drops
// the marker and re-arms the stamp.
const MARKER = path.join(REPO, "node_modules", "electron", "dist", ".codara-icon-stamp");

// Bump when the arguments below change, so an existing stamp is redone even
// though build/icon.ico itself is unchanged.
const STAMP_VERSION = "1";

const PRODUCT_NAME = "Codara Studio";

function log(msg) {
  console.log(`[dev-icon] ${msg}`);
}

function warn(msg) {
  console.warn(`[dev-icon] ${msg}`);
}

/**
 * rcedit ships vendored inside a couple of electron-builder's transitive deps.
 * Probe the known locations rather than pinning one, since which of them exists
 * moves around between electron-builder releases.
 */
function findRcedit() {
  const candidates = [
    // Direct devDependency, if anyone ever adds it.
    path.join(REPO, "node_modules", "rcedit", "bin", "rcedit-x64.exe"),
    path.join(REPO, "node_modules", "rcedit", "bin", "rcedit.exe"),
    // electron-builder -> app-builder-lib -> electron-builder-squirrel-windows.
    path.join(REPO, "node_modules", "electron-winstaller", "vendor", "rcedit.exe"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function iconFingerprint() {
  const hash = crypto.createHash("sha256");
  hash.update(STAMP_VERSION);
  hash.update(fs.readFileSync(ICON));
  return hash.digest("hex");
}

function main() {
  // The dev taskbar icon is a Windows-only problem: macOS reads the Dock icon
  // from BrowserWindow/app icon, and Linux from the .desktop entry + window.
  if (process.platform !== "win32") return;

  if (!fs.existsSync(ICON)) {
    warn(`icon not found at ${ICON} — skipping`);
    return;
  }
  if (!fs.existsSync(ELECTRON_EXE)) {
    // Normal on a fresh clone before electron's own postinstall has run, or in
    // a CI job that installed with --ignore-scripts.
    warn("node_modules/electron/dist/electron.exe not found — skipping");
    return;
  }

  const fingerprint = iconFingerprint();
  let existing = null;
  try {
    existing = fs.readFileSync(MARKER, "utf8").trim();
  } catch {
    // No marker: first run after install, or the icon changed. Fall through.
  }
  if (existing === fingerprint) return; // Already stamped — keep `predev` instant.

  const rcedit = findRcedit();
  if (!rcedit) {
    warn("rcedit.exe not found in node_modules — dev taskbar icon left as Electron's default");
    warn("  fix: npm i -D rcedit   (packaged builds are unaffected)");
    return;
  }

  const result = spawnSync(
    rcedit,
    [
      ELECTRON_EXE,
      "--set-icon",
      ICON,
      // Task Manager / the taskbar tooltip read these, so a dev run stops
      // presenting itself as a generic "Electron" process.
      "--set-version-string",
      "FileDescription",
      PRODUCT_NAME,
      "--set-version-string",
      "ProductName",
      PRODUCT_NAME,
      "--set-version-string",
      "CompanyName",
      "Codara",
    ],
    { encoding: "utf8" },
  );

  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "unknown error")
      .toString()
      .trim();
    // Overwhelmingly this is a running instance holding the exe open. Not worth
    // failing `npm run dev` over — the stamp lands on the next clean start.
    warn(`could not stamp the dev Electron binary: ${detail}`);
    warn("  this is usually another Codara Studio / electron instance holding the exe open.");
    warn("  close every instance and re-run `npm run icon:dev` to apply it.");
    return;
  }

  try {
    fs.writeFileSync(MARKER, `${fingerprint}\n`);
  } catch (err) {
    // The stamp itself succeeded; a missing marker only costs a redundant
    // re-stamp next time.
    warn(`stamped the exe but could not write the marker: ${err.message}`);
  }

  log(`stamped ${PRODUCT_NAME} icon onto node_modules/electron/dist/electron.exe`);
}

main();
