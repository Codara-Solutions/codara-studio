#!/usr/bin/env node
"use strict";

// Suites run two or more at a time (scripts/run-all-tests.cjs), so a suite
// must not hold anything its neighbour could also take. This checks the two
// that can be seen in the source:
//
// - a server listening on a fixed port: the neighbour that picks the same
//   port fails with EADDRINUSE, or worse, talks to the wrong server. Listen on
//   port 0 and read the port back.
// - a write whose path starts with a literal /tmp (a string, or
//   path.join/resolve("/tmp", ...)): the runner gives each suite its own
//   TMPDIR, and a literal path skips it. Use os.tmpdir().
//
// It reads the suites and the helper modules they load from scripts/ (the
// model stub, the fake clock), and follows a port named by a constant
// (const PORT = 4317; server.listen(PORT)).
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
const PORT_BY_NAME = /\.listen\(\s*(?:\{\s*port:\s*)?([A-Za-z_$][\w$]*)\b/g;
const LITERAL_TMP_WRITE =
  /\b(?:writeFile|appendFile|mkdir|mkdtemp|copyFile|rename|rm|rmdir|symlink|createWriteStream)(?:Sync)?\(\s*(?:path\.(?:join|resolve)\(\s*)?["'`]\/tmp(?:\/|["'`])/g;
const HELPER = /(?:require\(|from\s+|import\()\s*["']\.\/([\w.-]+\.(?:cjs|mjs))["']/g;

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
    for (const match of source.matchAll(PORT_BY_NAME)) {
      const value = new RegExp(`\\b(?:const|let|var)\\s+${match[1].replace(/\$/g, "\\$")}\\s*=\\s*([1-9]\\d{1,4})\\b`).exec(source);
      if (value) problems.push(`${file}:${source.slice(0, match.index).split("\n").length}: ${match[0]} (${match[1]} = ${value[1]}; listen on port 0 instead)`);
    }
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
    ["c.cjs", "const PORT = 4317;\nserver.listen(PORT);\nfs.mkdirSync(path.join('/tmp', 'x'));"],
  ]);
  assert.equal(problems.length, 6, problems.join("\n"));
});

check("port 0, a variable port and os.tmpdir() pass", () => {
  const problems = scan([
    ["c.cjs", "const port = 0;\nserver.listen(0, '127.0.0.1');\nserver.listen({ port: 0 });\nserver.listen(port);"],
    ["d.cjs", "fs.writeFileSync(path.join(os.tmpdir(), 'x'), '');\nconst stub = { home: '/tmp/cora-stub' };"],
  ]);
  assert.deepEqual(problems, []);
});

check("no suite or helper it loads listens on a fixed port or writes under a literal /tmp", () => {
  const read = (f) => [f, fs.readFileSync(path.join(DIR, f), "utf8")];
  const suites = fs
    .readdirSync(DIR)
    .filter((f) => /^test-.*\.(cjs|mjs)$/.test(f) && f !== SELF)
    .map(read);
  assert.ok(suites.length > 100, `only ${suites.length} suites found`);
  const helpers = new Set();
  for (const [, source] of suites) {
    for (const match of source.matchAll(HELPER)) {
      if (!match[1].startsWith("test-") && fs.existsSync(path.join(DIR, match[1]))) helpers.add(match[1]);
    }
  }
  assert.ok(helpers.has("cora-stub-model.mjs"), [...helpers].join(", "));
  const sources = [...suites, ...[...helpers].sort().map(read)];
  const problems = scan(sources);
  assert.deepEqual(problems, [], `Not safe to run next to another suite:\n${problems.join("\n")}`);
});

if (failed > 0) process.exit(1);
console.log("pool-safe suites: all passed");
