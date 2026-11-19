#!/usr/bin/env node
"use strict";

// scripts/test-cora-direct-mode.ts is TypeScript, so the runner's glob never
// picks it up, and it once broke unseen when direct-execution.ts gained an
// extensionless import. This suite runs it the way `npm run
// test:cora-direct-mode` does, so CI fails with it.

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const result = spawnSync(
  process.execPath,
  ["--no-warnings", "--experimental-strip-types", path.join(__dirname, "test-cora-direct-mode.ts")],
  { encoding: "utf8", timeout: 120_000 },
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.status !== 0 || !/PASS Cora direct-execution routing/.test(result.stdout ?? "")) {
  console.error(`test-cora-direct-mode.ts failed (exit ${result.status}${result.error ? `, ${result.error.message}` : ""})`);
  process.exit(1);
}
