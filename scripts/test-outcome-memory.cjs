#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cora-outcome-memory-"));
const tsc = require.resolve("typescript/bin/tsc", { paths: [ROOT] });
execFileSync(
  process.execPath,
  [
    tsc,
    path.join("src", "shared", "outcome-memory.ts"),
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
const { classifyOutcomeMemory } = require(path.join(OUT, "outcome-memory.js"));
let failures = 0;

function check(name, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
  if (!condition) failures += 1;
}

const none = classifyOutcomeMemory([]);
check("completion without a verifier is unverified", none.status === "unverified" && !none.reusable, JSON.stringify(none));

const verified = classifyOutcomeMemory([
  {
    taskId: "verify-api",
    attemptNumber: 1,
    accepted: true,
    status: "verified",
    claims: [{ verdict: "verified" }, { verdict: "verified" }],
  },
]);
check(
  "accepted verified evidence is reusable",
  verified.status === "verified" && verified.reusable && verified.verifiedClaimCount === 2,
  JSON.stringify(verified),
);

const retry = classifyOutcomeMemory([
  {
    taskId: "verify-api",
    attemptNumber: 1,
    accepted: false,
    status: "failed",
    claims: [{ verdict: "failed" }],
  },
  {
    taskId: "verify-api",
    attemptNumber: 2,
    accepted: true,
    status: "verified",
    claims: [{ verdict: "verified" }],
  },
]);
check(
  "latest accepted retry replaces a failed attempt",
  retry.status === "verified" && retry.failedClaimCount === 0,
  JSON.stringify(retry),
);

const mixed = classifyOutcomeMemory([
  {
    taskId: "verify-api",
    attemptNumber: 1,
    accepted: true,
    status: "verified",
    claims: [{ verdict: "verified" }],
  },
  {
    taskId: "verify-portability",
    attemptNumber: 1,
    accepted: true,
    status: "failed",
    claims: [{ verdict: "failed" }],
  },
]);
check(
  "one accepted failed verifier prevents recipe reuse",
  mixed.status === "mixed" && !mixed.reusable && mixed.failedClaimCount === 1,
  JSON.stringify(mixed),
);

const rejected = classifyOutcomeMemory([
  {
    taskId: "verify-api",
    attemptNumber: 1,
    accepted: false,
    status: "verified",
    claims: [{ verdict: "verified" }],
  },
]);
check("unaccepted evidence cannot bless memory", rejected.status === "unverified", JSON.stringify(rejected));

fs.rmSync(OUT, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} outcome-memory test(s) failed.`);
  process.exit(1);
}
console.log("\nAll outcome-memory tests passed.");
