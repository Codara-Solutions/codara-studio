"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function stageFiles(task, stageIndex = (task.stages ?? []).length) {
  return Object.assign({}, task.files, ...(task.stages ?? []).slice(0, stageIndex).map((stage) => stage.files ?? {}));
}

function visibleSource(task, stageIndex = 0) {
  return stageFiles(task, stageIndex)["test.js"];
}

function runCheck(dir, source) {
  try {
    // The evaluator owns the source. Running it as CommonJS eval preserves
    // workspace-relative require() without trusting an editable test file or
    // writing hidden answers into a directory the agent can still observe.
    const out = execFileSync(process.execPath, ["--input-type=commonjs", "-e", source], {
      cwd: dir,
      timeout: 15_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out };
  } catch (err) {
    const raw = `${err.stdout ?? ""}${err.stderr ?? ""}` || err.message;
    const at = raw.indexOf("AssertionError");
    return { ok: false, out: (at === -1 ? raw : raw.slice(at)).replace(/\n\s+at [^\n]+/g, "").slice(0, 400) };
  }
}

function gradeChecks(task, dir, metrics) {
  const expected = stageFiles(task);
  const visible = runCheck(dir, expected["test.js"]);
  const checks = [{ name: "visible tests pass", pass: visible.ok, weight: 5, detail: visible.ok ? "" : visible.out }];
  for (const group of task.hidden ?? []) {
    const res = runCheck(dir, group.source);
    checks.push({ name: `contract: ${group.name}`, pass: res.ok, weight: group.weight ?? 2, hidden: true, detail: res.ok ? "" : res.out });
  }
  for (const file of task.protectedFiles ?? []) {
    let pass = false;
    try {
      pass = fs.lstatSync(path.join(dir, file)).isFile() && fs.readFileSync(path.join(dir, file), "utf8") === expected[file];
    } catch {}
    checks.push({ name: `${file} untouched`, pass, weight: 1 });
  }
  if (task.extraChecks) checks.push(...task.extraChecks(dir, metrics));
  return checks;
}

module.exports = { gradeChecks, visibleSource };
