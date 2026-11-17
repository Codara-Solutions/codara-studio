#!/usr/bin/env node
"use strict";

// Unit tests for Source Control's compact change lists:
// src/renderer/src/components/git/change-list.ts (which rows a list shows,
// with new folders folded to one row, and what each status letter means).
// No React, no Electron.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const MODULE = path.join(ROOT, "src", "renderer", "src", "components", "git", "change-list.ts");

async function load() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-change-list-"));
  const outfile = path.join(temp, "change-list.cjs");
  await esbuild.build({
    entryPoints: [MODULE],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
  });
  return { mod: require(outfile), cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

const change = (p, status = "modified") => ({ path: p, status, staged: false, untracked: status === "untracked" });
const fresh = (p) => change(p, "untracked");
const rows = (entries) =>
  entries.map((entry) => (entry.kind === "file" ? entry.file.path : `${entry.dir}/ (${entry.files.length})`));

const TESTS = [];
function test(name, fn) {
  TESTS.push({ name, fn });
}

test("tracked changes keep git's order and come before new files", ({ groupChanges }) => {
  const list = [fresh("notes.txt"), change("src/b.ts"), change("README.md", "deleted"), change("src/a.ts")];
  assert.deepEqual(rows(groupChanges(list)), ["src/b.ts", "README.md", "src/a.ts", "notes.txt"]);
});

test("a dropped-in folder folds to its shallowest new folder with a count", ({ groupChanges }) => {
  const list = [
    change("CLAUDE.md"),
    fresh("tui085/package/build.sh"),
    fresh("tui085/package/native/darwin/x.node"),
    fresh("tui085/package/README.md"),
    fresh("tui085/README.md"),
    fresh("earendil.tgz"),
  ];
  const entries = groupChanges(list);
  assert.deepEqual(rows(entries), ["CLAUDE.md", "tui085/ (4)", "earendil.tgz"]);
  assert.equal(entries[1].files[0].path, "tui085/package/build.sh");
});

test("a folder that holds a tracked change is never folded as new", ({ groupChanges }) => {
  const list = [change("src/panel/list.ts"), fresh("src/panel/new-a.ts"), fresh("src/panel/new-b.ts"), fresh("src/fresh/one.ts"), fresh("src/fresh/two.ts")];
  assert.deepEqual(rows(groupChanges(list)), ["src/panel/list.ts", "src/fresh/ (2)", "src/panel/new-a.ts", "src/panel/new-b.ts"]);
});

test("the folder a file was renamed out of holds a change too", ({ groupChanges }) => {
  const moved = { path: "lib/b.ts", oldPath: "src/b.ts", status: "renamed", staged: false, untracked: false };
  const list = [moved, fresh("src/new-1.ts"), fresh("src/new-2.ts")];
  assert.deepEqual(rows(groupChanges(list)), ["lib/b.ts", "src/new-1.ts", "src/new-2.ts"]);
});

test("a folder name that prefixes another is a different folder", ({ groupChanges }) => {
  const list = [change("src2/x.ts"), fresh("src/a.ts"), fresh("src/b.ts")];
  assert.deepEqual(rows(groupChanges(list)), ["src2/x.ts", "src/ (2)"]);
});

test("a lone new file in a new folder keeps its own row", ({ groupChanges }) => {
  assert.deepEqual(rows(groupChanges([fresh("docs/guide.md"), fresh("a.txt")])), ["docs/guide.md", "a.txt"]);
});

test("folders sort by name and an empty list stays empty", ({ groupChanges }) => {
  const list = [fresh("zeta/1"), fresh("zeta/2"), fresh("Alpha/1"), fresh("Alpha/2")];
  assert.deepEqual(rows(groupChanges(list)), ["Alpha/ (2)", "zeta/ (2)"]);
  assert.deepEqual(groupChanges([]), []);
});

test("thousands of new files fold quickly", ({ groupChanges }) => {
  const list = [];
  for (let i = 0; i < 20000; i += 1) list.push(fresh(`node_modules/pkg${i % 400}/lib/f${i}.js`));
  list.push(change("package.json"));
  const started = Date.now();
  const entries = groupChanges(list);
  assert.ok(Date.now() - started < 1000, "grouping 20k files takes under a second");
  assert.deepEqual(rows(entries), ["package.json", "node_modules/ (20000)"]);
});

test("every status letter explains itself in words", ({ statusHint }) => {
  assert.equal(statusHint("untracked"), "U: new file git does not track yet");
  assert.match(statusHint("modified"), /^M: /);
  assert.match(statusHint("added"), /^A: /);
  assert.match(statusHint("deleted"), /^D: /);
  assert.match(statusHint("renamed"), /^R: /);
  assert.match(statusHint("conflicted"), /^!: conflict/);
  assert.match(statusHint("typechange"), /^T: /);
});

(async () => {
  const { mod, cleanup } = await load();
  let failed = 0;
  try {
    for (const { name, fn } of TESTS) {
      try {
        await fn(mod);
        console.log(`ok - ${name}`);
      } catch (error) {
        failed += 1;
        console.error(`not ok - ${name}\n${error && error.stack ? error.stack : error}`);
      }
    }
  } finally {
    cleanup();
  }
  if (failed > 0) process.exit(1);
  console.log(`${TESTS.length} tests passed`);
})();
