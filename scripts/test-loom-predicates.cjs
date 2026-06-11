// Pure-ish unit tests for the loom guard-predicate module (src/main/orchestration/
// loom-predicates.ts). loom-predicates touches the shell (node:child_process.exec)
// for tests/command/gitClean, so this harness STUBS node:child_process via an
// esbuild plugin: a fake `exec(cmd, opts, cb)` consults globalThis.__LP for the
// command's scripted outcome (exit code + stdout), so every probe is deterministic
// and no real process is spawned. @shared/types is resolved to the real source so
// the SPARK_LOOP_* sentinels + SHELL_CHECK_TIMEOUT_MS come from one place.
//
//   node scripts/test-loom-predicates.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const LOOM_PREDICATES_TS = path.join(ROOT, "src", "main", "orchestration", "loom-predicates.ts");

const harnessPlugin = {
  name: "loom-predicates-test-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    // Stub node:child_process.exec — the only impure dependency. The fake exec
    // looks the command up in globalThis.__LP.shell (cmd -> { code, stdout }),
    // defaulting to a non-zero exit (check fails) for an unscripted command.
    build.onResolve({ filter: /^node:child_process$/ }, () => ({
      path: "child_process",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents:
        "globalThis.__LP ??= { shell: {}, calls: [] };\n" +
        "export function exec(cmd, opts, cb){\n" +
        "  const L = globalThis.__LP; L.calls.push({ cmd, cwd: opts && opts.cwd });\n" +
        "  const scripted = L.shell[cmd];\n" +
        "  const code = scripted ? scripted.code : 1;\n" +
        "  const stdout = scripted ? (scripted.stdout ?? '') : '';\n" +
        "  const err = code === 0 ? null : Object.assign(new Error('exit ' + code), { code });\n" +
        "  setTimeout(() => cb(err, stdout, ''), 0);\n" +
        "  return {};\n" +
        "}\n",
      loader: "js",
    }));
  },
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spark-loompred-"));
  const outfile = path.join(tmp, "loom-predicates.bundle.cjs");
  await esbuild.build({
    entryPoints: [LOOM_PREDICATES_TS],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    resolveExtensions: [".ts", ".js", ".cjs", ".mjs", ".json"],
    plugins: [harnessPlugin],
  });

  // Seed the scripted shell BEFORE requiring the bundle (the stub `??=`s it).
  globalThis.__LP = { shell: {}, calls: [] };
  const P = require(outfile);
  const L = globalThis.__LP;

  let passed = 0;
  const ok = (name, cond) => {
    if (!cond) throw new Error(`FAIL: ${name}`);
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  const ctx = (over = {}) => ({ cwd: "/repo", sourceOutput: "", incomingOutputs: {}, ...over });

  // ── phrase: case-insensitive substring of sourceOutput, or incoming[source] ──
  {
    ok(
      "phrase: substring of sourceOutput (case-insensitive) → pass",
      (await P.evaluateGuardPredicate({ type: "phrase", phrase: "DONE" }, ctx({ sourceOutput: "all done here" }))) === true,
    );
    ok(
      "phrase: absent substring → fail",
      (await P.evaluateGuardPredicate({ type: "phrase", phrase: "nope" }, ctx({ sourceOutput: "all done here" }))) === false,
    );
    // predicate.source names an upstream node → scan THAT node's output.
    ok(
      "phrase: source nodeId targets incomingOutputs[source]",
      (await P.evaluateGuardPredicate(
        { type: "phrase", phrase: "ship it", source: "A" },
        ctx({ sourceOutput: "irrelevant", incomingOutputs: { A: "please SHIP IT now", B: "no" } }),
      )) === true,
    );
    ok(
      "phrase: source nodeId missing from incoming → fail (empty haystack)",
      (await P.evaluateGuardPredicate(
        { type: "phrase", phrase: "x", source: "ZZ" },
        ctx({ sourceOutput: "x is here", incomingOutputs: {} }),
      )) === false,
    );
  }

  // ── agentSignal: SPARK_LOOP_CONTINUE / DONE trailing-line scan ───────────────
  {
    ok(
      "agentSignal(continue): CONTINUE sentinel on last line → pass",
      (await P.evaluateGuardPredicate({ type: "agentSignal", want: "continue" }, ctx({ sourceOutput: "work\nSPARK_LOOP_CONTINUE" }))) === true,
    );
    ok(
      "agentSignal(continue): DONE sentinel → fail (wanted continue)",
      (await P.evaluateGuardPredicate({ type: "agentSignal", want: "continue" }, ctx({ sourceOutput: "work\nSPARK_LOOP_DONE" }))) === false,
    );
    ok(
      "agentSignal(done): DONE sentinel → pass",
      (await P.evaluateGuardPredicate({ type: "agentSignal", want: "done" }, ctx({ sourceOutput: "work\nSPARK_LOOP_DONE." }))) === true,
    );
    ok(
      "agentSignal(done): no sentinel → fail",
      (await P.evaluateGuardPredicate({ type: "agentSignal", want: "done" }, ctx({ sourceOutput: "just a summary" }))) === false,
    );
    ok(
      "agentSignal(continue): CONTINUE:\"prompt\" form counts",
      (await P.evaluateGuardPredicate({ type: "agentSignal", want: "continue" }, ctx({ sourceOutput: 'done\nSPARK_LOOP_CONTINUE: do more' }))) === true,
    );
  }

  // ── tests: default command + exit-code mapping ───────────────────────────────
  {
    L.shell = { "npm test": { code: 0 }, "yarn verify": { code: 0 }, "npm run broken": { code: 1 } };
    ok("tests: default command (npm test) exit 0 → pass", (await P.evaluateGuardPredicate({ type: "tests" }, ctx())) === true);
    ok("tests: explicit command exit 0 → pass", (await P.evaluateGuardPredicate({ type: "tests", command: "yarn verify" }, ctx())) === true);
    ok("tests: command exit !=0 → fail", (await P.evaluateGuardPredicate({ type: "tests", command: "npm run broken" }, ctx())) === false);
    // The default-command fallback uses DEFAULT_TEST_COMMAND.
    L.calls = [];
    await P.evaluateGuardPredicate({ type: "tests" }, ctx({ cwd: "/somewhere" }));
    ok("tests: ran the default command in the given cwd", L.calls.some((c) => c.cmd === "npm test" && c.cwd === "/somewhere"));
  }

  // ── command: arbitrary command exit-code mapping ─────────────────────────────
  {
    L.shell = { "test -f flag": { code: 0 }, "grep TODO src": { code: 1 } };
    ok("command: exit 0 → pass", (await P.evaluateGuardPredicate({ type: "command", command: "test -f flag" }, ctx())) === true);
    ok("command: exit !=0 → fail", (await P.evaluateGuardPredicate({ type: "command", command: "grep TODO src" }, ctx())) === false);
    ok("command: unscripted command → fail (default non-zero)", (await P.evaluateGuardPredicate({ type: "command", command: "never-scripted" }, ctx())) === false);
  }

  // ── gitClean: porcelain empty/non-empty mapping ──────────────────────────────
  {
    L.shell = { "git status --porcelain": { code: 0, stdout: "" } };
    ok("gitClean: clean tree (exit 0, empty stdout) → pass", (await P.evaluateGuardPredicate({ type: "gitClean" }, ctx())) === true);
    L.shell = { "git status --porcelain": { code: 0, stdout: " M file.ts\n" } };
    ok("gitClean: dirty tree (non-empty stdout) → fail", (await P.evaluateGuardPredicate({ type: "gitClean" }, ctx())) === false);
    L.shell = { "git status --porcelain": { code: 128, stdout: "" } };
    ok("gitClean: git error (exit !=0) → fail", (await P.evaluateGuardPredicate({ type: "gitClean" }, ctx())) === false);
  }

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  assert.ok(passed >= 10, `expected >= 10 checks, ran ${passed}`);
  console.log(`\nAll ${passed} loom-predicates checks PASSED.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\nLOOM-PREDICATES TEST FAILED:\n", err);
    process.exit(1);
  },
);
