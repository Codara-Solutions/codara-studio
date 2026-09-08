"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const task = require("../cli/bench/projects/ledger-reconcile.cjs");
const { gradeChecks } = require("../cli/bench/grade.cjs");
function grade(overrides) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cora-ledger-oracle-"));
  try {
    for (const [file, body] of Object.entries({ ...task.files, ...overrides })) fs.writeFileSync(path.join(cwd, file), body);
    return gradeChecks(task, cwd, {});
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}
const referenceChecks = grade(task.reference);
assert.deepEqual(referenceChecks.filter((check) => !check.pass), [], "the complete contract must be satisfiable");
assert.equal(grade({}).find((check) => check.name === "visible tests pass").pass, false);
const cases = [
  ["CSV", "csv.js", 'if (!recordEnded) flushRow();', 'flushRow();', "CSV quoting"],
  ["precision", "ledger.js", 'cents: cents.toString()', 'cents: String(Number(cents))', "arbitrary precision"],
  ["obsolete validation", "ledger.js", 'const row = rows[i];', 'const row = rows[i]; if (latest.has(row[0]) && latest.get(row[0]).revision > Number(row[1])) continue;', "all rows validated"],
  ["duplicate counting", "ledger.js", 'duplicates++;', 'duplicates += 0;', "latest revision"],
  ["CLI output", "cli.js", 'process.exitCode = 2;', 'process.exitCode = 1;', "CLI success"],
];
for (const [name, file, before, after, group] of cases) {
  assert.ok(task.reference[file].includes(before), `${name}: mutation target exists`);
  const checks = grade({ ...task.reference, [file]: task.reference[file].replace(before, after) });
  assert.equal(checks.find((check) => check.name.includes(group)).pass, false, `${name}: hidden oracle detects the defect`);
}
console.log("ledger project reference and defect-detection checks passed");
