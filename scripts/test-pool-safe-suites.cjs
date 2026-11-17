#!/usr/bin/env node
"use strict";

// Suites run two or more at a time (scripts/run-all-tests.cjs), so a suite
// must not hold anything its neighbour could also take. This checks the two
// that can be seen in the source:
//
// - a server listening on a fixed port: the neighbour that picks the same
//   port fails with EADDRINUSE, or worse, talks to the wrong server. Listen on
//   port 0 and read the port back.
// - a write under a literal /tmp path: the runner gives each suite its own
//   TMPDIR, and a literal path skips it. Use os.tmpdir().
//
// The timing rules (no wall-clock bounds across a child process, wait for a
// state instead of a fixed sleep) are in scripts/README.md, "Pool-safe suites".
//
//   node scripts/test-pool-safe-suites.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DIR = __dirname;
const SELF = path.basename(__filename);

const FIXED_PORT = /\.listen\(\s*(?:\{\s*port:\s*)?([1-9]\d{1,4})\b/g;
const LITERAL_TMP_WRITE =
  /\b(?:writeFile|appendFile|mkdir|mkdtemp|copyFile|rename|rm|rmdir|symlink|createWriteStream)(?:Sync)?\(\s*["'`]\/tmp\//g;

function findings(source, pattern) {
  const found = [];
  for (const match of source.matchAll(pattern)) {
    const line = source.slice(0, match.index).split("\n").length;
    found.push(`${line}: ${match[0]}`);
  }
  return found;
}

function scan(sources) {
  const problems = [];
  for (const [file, source] of sources) {
    for (const hit of findings(source, FIXED_PORT)) problems.push(`${file}:${hit} (listen on port 0 instead)`);
    for (const hit of findings(source, LITERAL_TMP_WRITE)) problems.push(`${file}:${hit} (write under os.tmpdir() instead)`);
  }
  return problems;
}

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}`);
    console.log(error && error.stack ? error.stack : String(error));
  }
}

check("the check sees a fixed port and a literal /tmp write", () => {
  const problems = scan([
    ["a.cjs", "server.listen(4317, '127.0.0.1');\nserver.listen({ port: 8080 });"],
    ["b.cjs", "fs.writeFileSync('/tmp/codara-fixed.json', '{}');\nfs.mkdirSync(`/tmp/x`);"],
  ]);
  assert.equal(problems.length, 4, problems.join("\n"));
});

check("port 0, a variable port and os.tmpdir() pass", () => {
  const problems = scan([
    ["c.cjs", "server.listen(0, '127.0.0.1');\nserver.listen({ port: 0 });\nserver.listen(port);"],
    ["d.cjs", "fs.writeFileSync(path.join(os.tmpdir(), 'x'), '');\nconst stub = { home: '/tmp/cora-stub' };"],
  ]);
  assert.deepEqual(problems, []);
});

check("no suite listens on a fixed port or writes under a literal /tmp", () => {
  const sources = fs
    .readdirSync(DIR)
    .filter((f) => /^test-.*\.(cjs|mjs)$/.test(f) && f !== SELF)
    .map((f) => [f, fs.readFileSync(path.join(DIR, f), "utf8")]);
  assert.ok(sources.length > 100, `only ${sources.length} suites found`);
  const problems = scan(sources);
  assert.deepEqual(problems, [], `Not safe to run next to another suite:\n${problems.join("\n")}`);
});

if (failed > 0) process.exit(1);
console.log("pool-safe suites: all passed");
