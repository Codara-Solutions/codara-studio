"use strict";

// Gives a test run its own invisible X display on Linux, so every Electron
// window the run opens lands there instead of on the desktop of whoever is
// using the machine.
//
// Chromium's headless Ozone backend would be the obvious tool, but this
// Electron segfaults as soon as it creates a BrowserWindow on it, and
// selecting it from the app's main script is too late to take effect at all.
// setOpacity, which hides the e2e window on macOS and Windows, is a no-op on
// Linux. A private Xvfb server is the one place a real, compositing window can
// live where nobody sees it.
//
// The first caller in a run starts the server and records it in
// CODARA_E2E_DISPLAY; child processes (Playwright workers, unit tests) inherit
// that and only point their environment at it. Without Xvfb the run still
// works, with its windows on the desktop, and says how to fix that once.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MARKER = "CODARA_E2E_DISPLAY";

function findXvfb(env) {
  const pinned = env.CODARA_XVFB?.trim();
  if (pinned) return isExecutable(pinned) ? pinned : null;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "Xvfb");
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function displayTaken(n) {
  return fs.existsSync(`/tmp/.X11-unix/X${n}`) || fs.existsSync(`/tmp/.X${n}-lock`);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The server runs under a small shell that also watches this process: a
// runner killed with SIGKILL never reaches its exit handler, and an Xvfb left
// behind would hold its display number until the next reboot.
function startXvfb(xvfb, n) {
  const script =
    `"$0" ":${n}" -screen 0 1920x1080x24 -nolisten tcp -noreset >/dev/null 2>&1 & x=$!; ` +
    `trap 'kill $x 2>/dev/null; exit 0' TERM INT HUP; ` +
    `while kill -0 ${process.pid} 2>/dev/null && kill -0 $x 2>/dev/null; do sleep 1; done; ` +
    `kill $x 2>/dev/null`;
  const child = spawn("sh", ["-c", script, xvfb], { stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(`/tmp/.X11-unix/X${n}`)) return child;
    if (child.exitCode !== null || child.signalCode !== null) break;
    sleepSync(50);
  }
  try {
    child.kill("SIGTERM");
  } catch {}
  return null;
}

function pointAt(env, display) {
  env[MARKER] = display;
  env.DISPLAY = display;
  env.XDG_SESSION_TYPE = "x11";
  env.GDK_BACKEND = "x11";
  delete env.WAYLAND_DISPLAY;
  delete env.ELECTRON_OZONE_PLATFORM_HINT;
}

/**
 * Point `env` (default: this process) at the run's private display, starting
 * one if no parent already did. Returns the display name, or null when the
 * run keeps the desktop (not Linux, opted out with SPARK_E2E_BACKGROUND=0, or
 * no Xvfb installed).
 */
function useVirtualDisplay(env = process.env) {
  if (process.platform !== "linux" || env.SPARK_E2E_BACKGROUND === "0") return null;
  const inherited = env[MARKER];
  if (inherited && fs.existsSync(`/tmp/.X11-unix/X${inherited.replace(/^:/, "")}`)) {
    pointAt(env, inherited);
    return inherited;
  }
  const xvfb = findXvfb(env);
  if (!xvfb) {
    console.warn(
      "[virtual-display] No Xvfb found, so test windows will open on your desktop. " +
        "Install it with `sudo apt install xvfb`, or point CODARA_XVFB at an Xvfb binary.",
    );
    return null;
  }
  for (let n = 90; n < 190; n += 1) {
    if (displayTaken(n)) continue;
    const server = startXvfb(xvfb, n);
    if (!server) continue;
    process.on("exit", () => {
      try {
        server.kill("SIGTERM");
      } catch {}
    });
    pointAt(env, `:${n}`);
    return `:${n}`;
  }
  console.warn("[virtual-display] Could not start Xvfb, so test windows will open on your desktop.");
  return null;
}

module.exports = { useVirtualDisplay };
