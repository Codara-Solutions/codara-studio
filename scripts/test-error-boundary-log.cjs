#!/usr/bin/env node
"use strict";

// What the renderer's crash screen says about a crash
// (src/shared/error-boundary.ts):
//
// - the one console string it writes carries the message, the stack and the
//   component stack
// - only that string, at error level, is what main keeps for main.log, and it
//   is bounded
// - the errors no Reload can fix are told apart from an ordinary render bug
//
// The wiring from the boundary through the console to main.log is covered by
// tests/e2e/error-boundary-log.spec.ts.
//
//   node scripts/test-error-boundary-log.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-error-boundary-"));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));

const outfile = path.join(TMP, "error-boundary.cjs");
esbuild.buildSync({
  entryPoints: [path.join(ROOT, "src/shared/error-boundary.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  logLevel: "silent",
});
const { errorBoundaryConsoleLine, errorBoundaryLogEntry, cannotRecoverByReload } = require(outfile);

const stale = new TypeError("window.spark.windowControls.onDesktopNewTerminal is not a function");
stale.stack = `TypeError: ${stale.message}\n    at App (App.tsx:6217:5)`;

// One string, because a second console argument reaches main as "[object Object]".
const line = errorBoundaryConsoleLine(stale, "\n    at App\n    at ErrorBoundary");
assert.ok(line.startsWith("[error-boundary] "), line);
assert.ok(line.includes("onDesktopNewTerminal is not a function"), "message");
assert.ok(line.includes("App.tsx:6217:5"), "stack");
assert.ok(line.includes("at ErrorBoundary"), "component stack");

for (const thrown of ["a thrown string", null, undefined, { message: "no stack" }]) {
  const text = errorBoundaryConsoleLine(thrown, null);
  assert.ok(text.startsWith("[error-boundary] "), `thrown ${String(thrown)} still logs`);
}
assert.ok(errorBoundaryConsoleLine("a thrown string", null).includes("a thrown string"));
assert.ok(errorBoundaryConsoleLine({ message: "no stack" }, null).includes("no stack"));

// Main keeps the boundary's line and nothing else the console says.
assert.equal(errorBoundaryLogEntry("error", line), line.slice("[error-boundary] ".length));
assert.equal(errorBoundaryLogEntry("error", "[renderer] something else failed"), null);
assert.equal(errorBoundaryLogEntry("error", "Warning: [error-boundary] quoted later in a message"), null);
assert.equal(errorBoundaryLogEntry("info", line), null, "the prefix at info level");
assert.equal(errorBoundaryLogEntry("warning", line), null, "the prefix at warning level");

const huge = errorBoundaryLogEntry("error", `[error-boundary] ${"x".repeat(5_000_000)}`);
assert.ok(huge.length <= 20_000, `a giant message is bounded, got ${huge.length}`);

assert.equal(cannotRecoverByReload(stale), true, "a preload call that is missing");
assert.equal(
  cannotRecoverByReload(new TypeError("Failed to fetch dynamically imported module: http://localhost:5173/src/x.tsx")),
  true,
  "a chunk the dev server lost",
);
assert.equal(cannotRecoverByReload(new TypeError("Cannot read properties of undefined (reading 'id')")), false);
assert.equal(cannotRecoverByReload(new Error("render blew up")), false);
assert.equal(cannotRecoverByReload(null), false);
assert.equal(cannotRecoverByReload("window.spark is gone"), true, "a thrown string counts too");

console.log("all error boundary log checks passed");
