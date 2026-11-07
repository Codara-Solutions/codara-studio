#!/usr/bin/env node
// isKeptBranch: cleanup never deletes a long-lived branch or the worktree's base.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

async function bundle(entry, name) {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `spark-kept-branches-${name}-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    external: ["electron"],
    logLevel: "silent",
  });
  try {
    return require(outfile);
  } finally {
    fs.rmSync(outfile, { force: true });
  }
}

async function main() {
  const kept = await bundle("src/main/worktree-cleanup/kept-branches.ts", "kept");
  const shared = await bundle("src/shared/worktree-cleanup-agent.ts", "shared");

  // Local and remote cleanup agree on which names are long-lived.
  assert.deepEqual([...kept.PROTECTED_BRANCHES].sort(), [...shared.PROTECTED_REMOTE_BRANCHES].sort());
  for (const name of ["release", "gh-pages", "main", "staging"]) {
    assert.equal(kept.isKeptBranch(name, "origin/main"), true, `${name} is kept`);
  }

  // The base itself is kept, spelled locally or with its remote.
  assert.equal(kept.isKeptBranch("feat/foo", "feat/foo"), true, "local base with a slash is kept");
  assert.equal(kept.isKeptBranch("feat/foo", "origin/feat/foo"), true, "remote base is kept");
  assert.equal(kept.isKeptBranch("Cora", "origin/Cora"), true, "remote base without a slash is kept");

  // Ordinary branches are not kept.
  assert.equal(kept.isKeptBranch("fix/bar", "origin/main"), false);
  assert.equal(kept.isKeptBranch("fix/bar", null), false);
  assert.equal(kept.isKeptBranch("fix/bar", ""), false);
  console.log("ok - kept branches");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
