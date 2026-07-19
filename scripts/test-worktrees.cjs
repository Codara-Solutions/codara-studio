// Integration test for src/main/git-worktrees.ts. There is no unit runner in
// this repo, so we bundle the TS module with esbuild (a vite dependency, so
// already in node_modules) into a temp CJS file and exercise it against a
// throwaway git repo. The module's only runtime import is ./git-exec (node
// child_process); the @shared/types import is type-only and erased by esbuild.
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function main() {
  const esbuild = require("esbuild");
  // The bundle must live under the repo so its external require("ssh2")
  // resolves against our node_modules (os.tmpdir() has no such ancestor).
  const cacheDir = path.join(__dirname, "..", "node_modules", ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const outFile = path.join(cacheDir, `spark-worktrees-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", "main", "git-worktrees.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    // git-exec routes ssh:// paths through the remote stack, which drags in
    // @shared/remote (tsconfig path alias, unknown to esbuild) and ssh2
    // (native deps). Alias the former, leave the latter a runtime require —
    // these tests only exercise local paths, and ssh2 resolves from
    // node_modules if it ever loads.
    alias: { "@shared": path.join(__dirname, "..", "src", "shared") },
    external: ["electron", "ssh2", "cpu-features"],
    logLevel: "silent",
  });
  const wt = require(outFile);

  const repo = mkdtempSync(path.join(os.tmpdir(), "spark-repo-"));
  const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), "spark-wts-"));
  const origin = mkdtempSync(path.join(os.tmpdir(), "spark-origin-"));
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

    // --- createCheckoutWorktree: open an EXISTING branch as a worktree ------
    assert.strictEqual(r.mode, "fork", "createCopyWorktree result should carry mode fork");

    // Free local branch, slash in the name: real branch checked out, dir slug
    // flattened.
    git(repo, ["branch", "feature/topic"]);
    const co1 = await wt.createCheckoutWorktree({
      repoCwd: repo,
      worktreesRoot,
      branch: "feature/topic",
    });
    assert.ok(co1.ok, `checkout create failed: ${co1.ok ? "" : co1.error}`);
    assert.strictEqual(co1.mode, "checkout", "mode should be checkout");
    assert.strictEqual(co1.branch, "feature/topic", "branch should keep its real name");
    assert.strictEqual(path.basename(co1.path), "feature-topic", "dir should be the flattened slug");
    assert.strictEqual(
      git(co1.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
      "feature/topic",
      "worktree HEAD should be the existing branch",
    );
    assert.strictEqual(co1.baseBranch, undefined, "checkout mode has no baseBranch");

    // Occupied local branch (main is checked out in the main repo): git's own
    // atomic refusal must surface, nothing created.
    const co2 = await wt.createCheckoutWorktree({ repoCwd: repo, worktreesRoot, branch: "main" });
    assert.ok(!co2.ok, "checking out an occupied branch should fail");
    assert.ok(
      /already used by worktree|already checked out/i.test(co2.error),
      `error should name the conflict, got: ${co2.error}`,
    );

    // Remote-tracking cases against a local bare origin.
    execFileSync("git", ["init", "--bare", origin]);
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["push", "origin", "main"]);
    git(repo, ["branch", "shared-free"]);
    git(repo, ["push", "origin", "shared-free"]);
    git(repo, ["push", "origin", "main:remote-only"]);
    git(repo, ["fetch", "origin"]);

    // Remote branch with no local counterpart → new local tracking branch.
    const co3 = await wt.createCheckoutWorktree({
      repoCwd: repo,
      worktreesRoot,
      branch: "origin/remote-only",
      isRemote: true,
    });
    assert.ok(co3.ok, `remote checkout failed: ${co3.ok ? "" : co3.error}`);
    assert.strictEqual(co3.branch, "remote-only", "remote prefix should be stripped");
    assert.strictEqual(
      git(co3.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
      "remote-only",
      "worktree HEAD should be the new local branch",
    );
    assert.strictEqual(
      git(co3.path, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
      "origin/remote-only",
      "new local branch should track the remote",
    );

    // Remote branch whose local counterpart exists and is free → reuse it, no
    // duplicate branch.
    const branchesBefore = git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
      .split("\n")
      .filter(Boolean);
    const co4 = await wt.createCheckoutWorktree({
      repoCwd: repo,
      worktreesRoot,
      branch: "origin/shared-free",
      isRemote: true,
    });
    assert.ok(co4.ok, `remote-with-local checkout failed: ${co4.ok ? "" : co4.error}`);
    assert.strictEqual(co4.branch, "shared-free");
    const branchesAfter = git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
      .split("\n")
      .filter(Boolean);
    assert.strictEqual(
      branchesAfter.length,
      branchesBefore.length,
      "reusing a free local namesake must not create a duplicate branch",
    );

    // Remote branch whose local counterpart is occupied → clear refusal.
    const co5 = await wt.createCheckoutWorktree({
      repoCwd: repo,
      worktreesRoot,
      branch: "origin/main",
      isRemote: true,
    });
    assert.ok(!co5.ok, "remote checkout with occupied local namesake should fail");
    assert.ok(
      /already checked out at/i.test(co5.error),
      `error should name the occupying path, got: ${co5.error}`,
    );

    // Dir slug collision: a branch whose slug matches an existing worktree dir
    // gets a numeric suffix.
    git(repo, ["branch", "feature-topic"]);
    const co6 = await wt.createCheckoutWorktree({
      repoCwd: repo,
      worktreesRoot,
      branch: "feature-topic",
    });
    assert.ok(co6.ok, `slug-collision checkout failed: ${co6.ok ? "" : co6.error}`);
    assert.strictEqual(
      path.basename(co6.path),
      "feature-topic-2",
      "colliding dir slug should get a -2 suffix",
    );

    // Removing a checkout-mode workspace without deleteBranch keeps the
    // pre-existing branch.
    const coRm = await wt.removeCopyWorktree({
      repoCwd: repo,
      worktreePath: co6.path,
      branch: co6.branch,
    });
    assert.ok(coRm.ok, `checkout remove failed: ${coRm.ok ? "" : coRm.error}`);
    assert.ok(
      git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
        .split("\n")
        .includes("feature-topic"),
      "pre-existing branch must survive worktree removal",
    );

    console.log("PASS: git-worktrees");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktreesRoot, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
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
