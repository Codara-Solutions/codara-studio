// Integration test for src/main/git-worktrees.ts. There is no unit runner in
// this repo, so we bundle the TS module with esbuild (a vite dependency, so
// already in node_modules) into a temp CJS file and exercise it against a
// throwaway git repo. The module's only runtime import is ./git-exec (node
// child_process); the @shared/types import is type-only and erased by esbuild.
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function main() {
  const esbuild = require("esbuild");
  const outFile = path.join(os.tmpdir(), `spark-worktrees-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", "main", "git-worktrees.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    external: ["electron"],
    logLevel: "silent",
  });
  const wt = require(outFile);

  const repo = mkdtempSync(path.join(os.tmpdir(), "spark-repo-"));
  const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), "spark-wts-"));
  try {
    execFileSync("git", ["init", "-b", "main", repo]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(path.join(repo, "README.md"), "# test\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);

    assert.strictEqual(
      await wt.resolveDefaultBranch(repo),
      "main",
      "default branch should be main",
    );

    const r = await wt.createCopyWorktree({ repoCwd: repo, worktreesRoot });
    assert.ok(r.ok, `create failed: ${r.ok ? "" : r.error}`);
    assert.ok(existsSync(r.path), "worktree path should exist");
    assert.strictEqual(
      git(r.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
      r.branch,
      "worktree HEAD should be the city branch",
    );
    assert.strictEqual(
      git(r.path, ["status", "--porcelain"]),
      "",
      "fresh worktree should be clean",
    );
    assert.strictEqual(r.baseBranch, "main", "baseBranch should be main");

    const city2 = await wt.pickCity(repo, worktreesRoot);
    assert.notStrictEqual(city2, r.city, "pickCity should not reuse the created city");

    const rm = await wt.removeCopyWorktree({
      repoCwd: repo,
      worktreePath: r.path,
      branch: r.branch,
      deleteBranch: true,
    });
    assert.ok(rm.ok, `remove failed: ${rm.ok ? "" : rm.error}`);
    assert.ok(!existsSync(r.path), "worktree path should be gone after remove");
    const branches = git(repo, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ]).split("\n");
    assert.ok(!branches.includes(r.branch), "branch should be deleted");

    console.log("PASS: git-worktrees");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktreesRoot, { recursive: true, force: true });
    try {
      rmSync(outFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
