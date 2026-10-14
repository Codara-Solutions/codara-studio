#!/usr/bin/env node
"use strict";

// When the title-bar meters re-read subscription usage for a window that
// resets between polls: src/renderer/src/components/usage-reset-timer.ts.

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const result = esbuild.buildSync({
  entryPoints: [path.join(ROOT, "src/renderer/src/components/usage-reset-timer.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
  alias: { "@shared": path.join(ROOT, "src/shared") },
});
const shim = { exports: {} };
new Function("module", "exports", result.outputFiles[0].text)(shim, shim.exports);
const { msUntilUsageReset, RESET_REREAD_GRACE_MS } = shim.exports;

const NOW = Date.parse("2026-10-14T12:00:00.000Z");

function overview(...windowSets) {
  return {
    checkedAt: new Date(NOW).toISOString(),
    providers: [],
    profiles: windowSets.map((windows, index) => ({
      profileId: `profile-${index}`,
      provider: "anthropic",
      label: `Account ${index}`,
      status: "ok",
      checkedAt: new Date(NOW).toISOString(),
      windows: windows.map((resetsAt, slot) => ({
        id: `w${slot}`,
        label: "5-hour",
        usedPercent: 100,
        remainingPercent: 0,
        ...(resetsAt === null ? {} : { resetsAt }),
      })),
    })),
  };
}

const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();

assert.equal(msUntilUsageReset(null, NOW), null);
assert.equal(msUntilUsageReset(overview(), NOW), null);
assert.equal(msUntilUsageReset(overview([null]), NOW), null);
assert.equal(msUntilUsageReset(overview(["not a date"]), NOW), null);
console.log("ok - nothing to wait for without a future reset");

// The soonest reset across every account and window, plus the grace.
assert.equal(
  msUntilUsageReset(overview([at(3_600_000), at(90_000)], [at(120_000)]), NOW),
  90_000 + RESET_REREAD_GRACE_MS,
);
console.log("ok - waits for the soonest reset across accounts, plus a grace");

// A reset already past is the vendor being late to roll over; scheduling for
// it would re-read at once, and again after every read.
assert.equal(msUntilUsageReset(overview([at(-5_000)]), NOW), null);
assert.equal(
  msUntilUsageReset(overview([at(-5_000), at(600_000)]), NOW),
  600_000 + RESET_REREAD_GRACE_MS,
);
assert.equal(msUntilUsageReset(overview([at(0)]), NOW), null);
console.log("ok - resets already past are skipped");

assert.ok(RESET_REREAD_GRACE_MS > 0 && RESET_REREAD_GRACE_MS < 60_000);
console.log("\nAll usage reset timer checks passed.");
