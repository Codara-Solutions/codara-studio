#!/usr/bin/env node
"use strict";

// A dev app started by `npm run dev` inherits npm's run-script wiring:
// node_modules/.bin for the package directory and every ancestor, npm's
// node-gyp shim, npm_* variables and INIT_CWD. Panes, Cora's Pi processes,
// automation steps and binary lookups must not see it, or `pi` in a pane
// runs the repository's copy instead of the user's install. An app npm did
// not start (no npm_lifecycle_event) keeps its environment untouched,
// including a node_modules/.bin the user put on PATH themselves.
//
//   node scripts/test-npm-run-script-env.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-npm-env-"));
  const outfile = path.join(outDir, "env-sanitize.cjs");
  try {
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "main", "env-sanitize.ts")],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
    });
    const { sanitizeNpmRunScriptEnv, withoutNpmRunScriptPath } = require(outfile);
    const d = path.delimiter;
    const project = path.join(path.sep, "work", "codara-studio");
    const userPath = [
      path.join(path.sep, "opt", "homebrew", "bin"),
      path.join(path.sep, "work", "other", "node_modules", ".bin"),
      path.join(path.sep, "usr", "bin"),
    ];
    const npmPath = [
      path.join(project, "node_modules", ".bin"),
      path.join(path.sep, "work", "node_modules", ".bin"),
      path.join(path.sep, "node_modules", ".bin"),
      path.join(path.sep, "opt", "homebrew", "lib", "node_modules", "npm", "node_modules", "@npmcli", "run-script", "lib", "node-gyp-bin"),
    ];
    const npmEnv = () => ({
      PATH: [...userPath.slice(0, 2), ...npmPath, userPath[2]].join(d),
      npm_lifecycle_event: "dev",
      npm_lifecycle_script: "electron-vite dev",
      npm_package_json: path.join(project, "package.json"),
      npm_config_prefix: "/opt/homebrew",
      INIT_CWD: project,
      HOME: "/Users/someone",
    });

    const env = npmEnv();
    sanitizeNpmRunScriptEnv(env);
    assert.equal(env.PATH, userPath.join(d), "npm's PATH entries go, the user's stay in order");
    assert.equal(Object.keys(env).some((key) => key.startsWith("npm_")), false, "npm_* variables go");
    assert.equal(env.INIT_CWD, undefined, "INIT_CWD goes");
    assert.equal(env.HOME, "/Users/someone", "everything else stays");

    const fallback = npmEnv();
    assert.equal(
      withoutNpmRunScriptPath(fallback.PATH, fallback),
      userPath.join(d),
      "the enriched PATH fallback drops the same entries",
    );

    const plain = { ...npmEnv() };
    delete plain.npm_lifecycle_event;
    const before = { ...plain };
    sanitizeNpmRunScriptEnv(plain);
    assert.deepEqual(plain, before, "an app npm did not start is left alone");
    assert.equal(withoutNpmRunScriptPath(before.PATH, before), before.PATH);

    console.log("PASS: npm run-script wiring stays out of panes, Pi processes and binary lookups");
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
