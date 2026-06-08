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
    assert.ok(r.fileCount >= 1, `fileCount should be >= 1, got ${r.fileCount}`);

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

    // --- Regression: an orphaned/broken copy must still be removable -------
    // Reproduces the "is not a working tree" dead-end seen in the app: a copy
    // whose git linkage is gone (admin entry pruned) but whose directory
    // lingers. The resilient removeCopyWorktree should clear it off disk
    // instead of dead-ending on git's error.
    const orphan = await wt.createCopyWorktree({ repoCwd: repo, worktreesRoot });
    assert.ok(orphan.ok, `orphan create failed: ${orphan.ok ? "" : orphan.error}`);
    // Deregister it: drop the parent repo's admin entry so `git worktree
    // remove` rejects the path as "not a working tree", while the directory
    // stays on disk — exactly the observed broken state.
    rmSync(path.join(repo, ".git", "worktrees", orphan.city), { recursive: true, force: true });
    const listing = git(repo, ["worktree", "list", "--porcelain"]).replace(/\\/g, "/").toLowerCase();
    assert.ok(
      !listing.includes(orphan.path.replace(/\\/g, "/").toLowerCase()),
      "orphan should no longer be a registered worktree",
    );
    assert.ok(existsSync(orphan.path), "orphan dir should still be on disk before cleanup");

    const orphanRm = await wt.removeCopyWorktree({
      repoCwd: repo,
      worktreePath: orphan.path,
      branch: orphan.branch,
      deleteBranch: true,
    });
    assert.ok(orphanRm.ok, `orphan remove failed: ${orphanRm.ok ? "" : orphanRm.error}`);
    assert.ok(!existsSync(orphan.path), "orphan dir should be gone after resilient remove");
    assert.ok(
      !git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
        .split("\n")
        .includes(orphan.branch),
      "orphan branch should be deleted",
    );

    // --- Safety: a LIVE worktree git declines must NOT be silently nuked ----
    // A real worktree with uncommitted files should surface git's refusal and
    // stay on disk, not get force-deleted by the orphan fallback.
    const live = await wt.createCopyWorktree({ repoCwd: repo, worktreesRoot });
    assert.ok(live.ok, `live create failed: ${live.ok ? "" : live.error}`);
    writeFileSync(path.join(live.path, "dirty.txt"), "uncommitted\n");
    const liveRm = await wt.removeCopyWorktree({
      repoCwd: repo,
      worktreePath: live.path,
      branch: live.branch,
    });
    assert.ok(!liveRm.ok, "removing a dirty live worktree (no force) should fail, not delete it");
    assert.ok(existsSync(live.path), "dirty live worktree must remain on disk");
    // Tidy up the live worktree for real so the temp dirs clean cleanly.
    await wt.removeCopyWorktree({
      repoCwd: repo,
      worktreePath: live.path,
      branch: live.branch,
      force: true,
      deleteBranch: true,
    });

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
