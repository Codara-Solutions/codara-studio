// Guards the worker prompt's ownership-based cleanup contract.
//
// The regression this prevents is a prompt that told workers to erase any
// unexpected file with repository cleanup commands, even when the file
// predated the attempt or belonged to the user or another worker.
//
//   node scripts/test-worker-cleanup-safety.cjs
//
// Exits non-zero on any failed assertion.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PROFILE_PATH = path.join(
  ROOT,
  "resources",
  "orchestration",
  "manager-profile.json",
);

// These sources directly define or assemble policy a Cora worker reads.
const WORKER_POLICY_SURFACES = [
  "resources/orchestration/manager-profile.json",
  "src/main/orchestration/prompt-profile.ts",
  "src/main/orchestration/worker-prompt.ts",
  "resources/pi-cora/worker.ts",
];

const FORBIDDEN_DESTRUCTIVE_LANGUAGE = [
  { label: "repository clean command", pattern: /\bgit\s+clean\b/i },
  { label: "recursive force-removal command", pattern: /\brm\s+-rf\b/i },
  {
    label: "delete-any-unexpected-file instruction",
    pattern: /\bdelete\b[^\n]{0,160}\b(?:anything|everything|files?)\b[^\n]{0,160}\b(?:unexpected|did not intentionally write)\b/i,
  },
];

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function check(message, condition) {
  if (!condition) fail(message);
  console.log(`PASS ${message}`);
}

const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, "utf8"));
const opening = profile?.workerPrompt?.opening;
check("bundled worker opening is an array", Array.isArray(opening));

const cleanupRule = opening.find(
  (line) => typeof line === "string" && line.startsWith("DIFF HYGIENE:"),
);
check("bundled worker opening contains DIFF HYGIENE", typeof cleanupRule === "string");

const requiredOwnershipRules = [
  "capture a baseline with `git status -s`",
  "record every exact temporary path and Codara terminal pane ID this attempt creates",
  "close only the exact temporary pane IDs this attempt opened",
  "delete only exact, workspace-contained temporary paths this attempt created",
  "Preserve every pre-existing path and every path whose ownership is uncertain",
  "leave uncertain files in place and report them",
  "Never use broad cleanup commands, recursive wildcards or globs, or any repository-wide clean",
];

for (const rule of requiredOwnershipRules) {
  check(`cleanup contract requires: ${rule}`, cleanupRule.includes(rule));
}

for (const relativePath of WORKER_POLICY_SURFACES) {
  const absolutePath = path.join(ROOT, relativePath);
  check(`${relativePath} exists`, fs.existsSync(absolutePath));
  const source = fs.readFileSync(absolutePath, "utf8");
  for (const forbidden of FORBIDDEN_DESTRUCTIVE_LANGUAGE) {
    check(
      `${relativePath} contains no ${forbidden.label}`,
      !forbidden.pattern.test(source),
    );
  }
}

console.log("\nAll worker cleanup-safety checks passed.");
