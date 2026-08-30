#!/usr/bin/env node
"use strict";

// Run EVERY scripts/test-*.cjs — the glob is the registry, so a test can never
// be silently orphaned by a missing package.json entry again (73 were, once).
//
//   npm run test:all             run everything, summary at the end
//   npm run test:all -- <regex>  only tests whose filename matches
//
// Exit code 1 when anything fails. Each test runs in its own process; a test
// that cannot even parse counts as a failure, not a crash of the runner.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const dir = __dirname;
const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;
const tests = fs
  .readdirSync(dir)
  .filter((f) => /^test-.*\.(cjs|mjs)$/.test(f))
  .filter((f) => !filter || filter.test(f))
  .sort();

const failed = [];
const started = Date.now();
for (const file of tests) {
  process.stdout.write(`${file.padEnd(52)}`);
  const t0 = Date.now();
  try {
    execFileSync("node", [path.join(dir, file)], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
    });
    console.log(`ok  ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (err) {
    // Keep enough of the tail to include the actual error MESSAGE, not just
    // the stack frames (an esbuild BuildFailure's message alone can be
    // hundreds of chars; 400 showed only frames and hid the cause on CI).
    failed.push({ file, out: `${err.stdout ?? ""}${err.stderr ?? ""}`.slice(-6000) });
    console.log(`FAIL${err.killed ? " (timeout)" : ""}`);
  }
}

console.log(`\n${tests.length - failed.length}/${tests.length} passed in ${Math.round((Date.now() - started) / 1000)}s`);
for (const f of failed) {
  console.log(`\n--- ${f.file}\n${f.out}`);
}
if (failed.length > 0) process.exit(1);
