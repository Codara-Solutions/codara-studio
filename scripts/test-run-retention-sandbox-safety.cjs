#!/usr/bin/env node
// Regression guard for a data-loss edge: retention and ordinary run deletion
// must not force-remove a sandbox whose edits were never confirmed merged.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.resolve(__dirname, "../src/main/orchestration/run-store.ts"),
  "utf8",
);
let failures = 0;

function check(name, condition) {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
  if (!condition) failures += 1;
}

const helper = source.match(
  /function unreconciledSandboxAttempts[\s\S]*?\n}\n/,
)?.[0] ?? "";
const retention = source.match(
  /async function purgeTerminalRunForRetention[\s\S]*?\n}\n\nfunction unreconciledSandboxAttempts/,
)?.[0] ?? "";
const deletion = source.match(
  /export async function deleteRun[\s\S]*?const timestamp = new Date\(\)\.toISOString\(\);/,
)?.[0] ?? "";

check("sandbox guard requires a persisted worktree identity", /sandboxWorktreePath/.test(helper) && /sandboxBranch/.test(helper) && /sandboxBaseRepo/.test(helper));
check("only explicitly merged-back sandboxes are reconciled", /sandboxMergedBack !== true/.test(helper));
check("retention skips runs with unreconciled sandboxes", /unreconciledSandboxAttempts\(latest\)\.length > 0\) return/.test(retention));
check("ordinary deletion checks before destructive work", /const sandboxBlockers = unreconciledSandboxAttempts\(run\)/.test(deletion));
check("ordinary deletion explains how to recover", /Open or recover those worktrees before deleting/.test(deletion));
check("guard runs before the run.deleted event", source.indexOf("const sandboxBlockers = unreconciledSandboxAttempts(run)") < source.indexOf('type: "run.deleted"'));
check("guard runs before sandbox force-removal", source.indexOf("const sandboxBlockers = unreconciledSandboxAttempts(run)") < source.indexOf("await removeSandboxWorktree({", source.indexOf("export async function deleteRun")));

if (failures) {
  console.error(`\n${failures} sandbox-retention safety check(s) failed.`);
  process.exit(1);
}
console.log("\nAll sandbox-retention safety checks passed.");
