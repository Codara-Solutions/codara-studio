#!/usr/bin/env node
// Re-pin a task's seed.json to the current main HEAD. Call this only when
// the task fixtures themselves change; otherwise eval results across runs
// remain reproducible against the previously-recorded SHA.
//
// Usage:
//   node evals/scripts/repin-seed.cjs <task-id>

"use strict";

const path = require("node:path");
const seedRepo = require("../lib/seed-repo");

function main() {
  const taskId = process.argv[2];
  if (!taskId) {
    process.stderr.write("Usage: node evals/scripts/repin-seed.cjs <task-id>\n");
    process.exit(2);
  }
  const taskDir = path.resolve(__dirname, "..", "tasks", taskId);
  const seed = seedRepo.repinSeed(taskDir);
  process.stdout.write(
    `Re-pinned ${taskId} -> ${seed.seedCommit} (${seed.repinnedAt})\n`,
  );
}

main();
