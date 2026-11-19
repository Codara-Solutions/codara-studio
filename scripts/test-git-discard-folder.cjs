#!/usr/bin/env node
"use strict";

// Unit tests for discardNewFolder in src/main/git-ops.ts: Source Control's
// Discard on a folded folder of new files. It deletes exactly the files the
// row showed, refuses when the folder changed before the confirm, and keeps
// what appears in a listed file's place while it deletes (a file swapped
// for a folder). Runs real git in a temporary repository; the git runner
// is the real one with a hook after the first listing.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

const GIT_EXEC_STUB = `
  import { execFile } from "node:child_process";
  export const NETWORK_TIMEOUT_MS = 90000;
  export function errorText(err) {
    const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
    return stderr || String(err?.message ?? err);
  }
  export function isNotARepo(message) { return /not a git repository/i.test(message); }
  export function runGit(cwd, args) {
    return new Promise((resolve, reject) => {
      execFile("git", ["-C", cwd, ...args], (err, stdout, stderr) => {
        if (err) { err.stderr = stderr; reject(err); return; }
        const hook = globalThis.__afterGit;
        if (hook) hook(args);
        resolve({ stdout, stderr });
      });
    });
  }
`;

async function load() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-discard-folder-"));
  const outfile = path.join(temp, "git-ops.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "git-ops.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    plugins: [
      {
        name: "git-exec-stub",
        setup(build) {
          build.onResolve({ filter: /^\.\/git-exec$/ }, () => ({ path: "git-exec", namespace: "stub" }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: GIT_EXEC_STUB, loader: "js" }));
        },
      },
    ],
    logLevel: "silent",
  });
  return { mod: require(outfile), cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-discard-repo-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  execFileSync("git", ["init", "-q", dir], { env });
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"], { env });
  return dir;
}

function put(root, file, text = `${file}\n`) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

const TESTS = [];
const test = (name, fn) => TESTS.push({ name, fn });

test("deletes exactly the listed files and the folder they leave empty", async ({ discardNewFolder }, root) => {
  put(root, "dist/a.js");
  put(root, "dist/sub/b.js");
  const result = await discardNewFolder(root, "dist", ["dist/a.js", "dist/sub/b.js"]);
  assert.deepEqual(result, { ok: true });
  assert.equal(fs.existsSync(path.join(root, "dist")), false);
});

test("refuses when the folder changed since the row was drawn", async ({ discardNewFolder }, root) => {
  put(root, "dist/a.js");
  put(root, "dist/b.js");
  put(root, "dist/late.js");
  const result = await discardNewFolder(root, "dist", ["dist/a.js", "dist/b.js"]);
  assert.equal(result.ok, false);
  assert.match(result.error, /changed since it was shown\. Nothing was deleted/);
  for (const file of ["a.js", "b.js", "late.js"]) assert.equal(fs.existsSync(path.join(root, "dist", file)), true, file);
});

test("a listed file swapped for a folder while deleting keeps what is inside it", async ({ discardNewFolder }, root) => {
  put(root, "dist/a.js");
  put(root, "dist/b.js");
  // Right after main lists the folder, a.js becomes a folder with a file in it.
  globalThis.__afterGit = (args) => {
    if (!args.includes("ls-files")) return;
    globalThis.__afterGit = null;
    fs.rmSync(path.join(root, "dist", "a.js"));
    put(root, "dist/a.js/inner.txt", "unseen\n");
  };
  const result = await discardNewFolder(root, "dist", ["dist/a.js", "dist/b.js"]);
  globalThis.__afterGit = null;
  assert.equal(result.ok, false);
  assert.match(result.error, /Deleted 1 of 2 files in dist\/\. Kept dist\/a\.js/);
  assert.equal(fs.readFileSync(path.join(root, "dist", "a.js", "inner.txt"), "utf8"), "unseen\n");
  assert.equal(fs.existsSync(path.join(root, "dist", "b.js")), false);
});

test("names with pattern characters reach only themselves", async ({ discardNewFolder }, root) => {
  put(root, "[ab]/1.txt");
  put(root, "[ab]/2.txt");
  put(root, "a/unrelated");
  const result = await discardNewFolder(root, "[ab]", ["[ab]/1.txt", "[ab]/2.txt"]);
  assert.deepEqual(result, { ok: true });
  assert.equal(fs.existsSync(path.join(root, "a", "unrelated")), true);
});

(async () => {
  const { mod, cleanup } = await load();
  let failed = 0;
  try {
    for (const { name, fn } of TESTS) {
      const root = repo();
      try {
        await fn(mod, root);
        console.log(`ok - ${name}`);
      } catch (err) {
        failed += 1;
        console.error(`not ok - ${name}\n${err.stack ?? err}`);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    cleanup();
  }
  if (failed > 0) {
    console.error(`${failed} of ${TESTS.length} tests failed`);
    process.exit(1);
  }
  console.log(`${TESTS.length} tests passed`);
})();
