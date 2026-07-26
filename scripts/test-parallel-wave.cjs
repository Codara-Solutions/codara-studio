#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cora-parallel-wave-"));
const tsc = require.resolve("typescript/bin/tsc", { paths: [ROOT] });
execFileSync(
  process.execPath,
  [
    tsc,
    path.join("src", "shared", "parallel-wave.ts"),
    "--outDir",
    OUT,
    "--module",
    "commonjs",
    "--target",
    "es2020",
    "--skipLibCheck",
  ],
  { cwd: ROOT, stdio: "inherit" },
);

const { selectLargestCompatibleWave } = require(path.join(OUT, "parallel-wave.js"));
let failures = 0;

function check(name, actual, expected) {
  const serializedActual = JSON.stringify(actual);
  const serializedExpected = JSON.stringify(expected);
  const ok = serializedActual === serializedExpected;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} → ${serializedActual}`);
  if (!ok) {
    console.log(`  expected ${serializedExpected}`);
    failures += 1;
  }
}

function select(ids, pairs, cap) {
  const conflictKeys = new Set(pairs.flatMap(([a, b]) => [`${a}:${b}`, `${b}:${a}`]));
  return selectLargestCompatibleWave(ids, {
    cap,
    conflicts: (left, right) => conflictKeys.has(`${left}:${right}`),
  });
}

check(
  "avoids the first-fit greedy trap",
  select(["broad", "one", "two", "three"], [["broad", "one"], ["broad", "two"], ["broad", "three"]]),
  ["one", "two", "three"],
);
check(
  "respects the worker cap while preserving stable order",
  select(["a", "b", "c", "d"], [], 2),
  ["a", "b"],
);
check(
  "chooses the earliest maximum wave on a tie",
  select(["a", "b", "c", "d"], [["a", "b"], ["a", "d"], ["b", "c"], ["c", "d"]]),
  ["a", "c"],
);
check(
  "never returns a conflicting pair",
  select(["a", "b", "c"], [["a", "b"], ["b", "c"], ["a", "c"]]),
  ["a"],
);
check("empty frontier stays empty", select([], []), []);

// The >20 fallback is bounded and prefers low-conflict tasks. Task 0 conflicts
// with every sibling, so it must not collapse a 20-worker-safe frontier to 1.
const large = Array.from({ length: 21 }, (_, index) => `task-${index}`);
const largePairs = large.slice(1).map((id) => [large[0], id]);
check("bounded large-frontier fallback avoids a broad task", select(large, largePairs, 4), large.slice(1, 5));

fs.rmSync(OUT, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} parallel-wave test(s) failed.`);
  process.exit(1);
}
console.log("\nAll parallel-wave tests passed.");
