// Integration test for src/main/git-worktrees.ts. There is no unit runner in
// this repo, so we bundle the TS module with esbuild (a vite dependency, so
// already in node_modules) into a temp CJS file and exercise it against a
// throwaway git repo. git-exec also supports remote workspaces now, so keep
// its optional Electron/SSH dependencies external and resolve the same
// @shared alias as the production build.
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} = require("node:fs");
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
  const identityRoot = mkdtempSync(path.join(os.tmpdir(), "spark-root-id-"));
  try {
    const firstSame = path.join(identityRoot, "a", "same");
    const secondSame = path.join(identityRoot, "b", "same");
    mkdirSync(firstSame, { recursive: true });
    mkdirSync(secondSame, { recursive: true });
    const managedHome = path.join(identityRoot, "home");
    const firstManaged = wt.managedWorktreesRoot(managedHome, firstSame);
    const secondManaged = wt.managedWorktreesRoot(managedHome, secondSame);
    assert.notStrictEqual(
      firstManaged,
      secondManaged,
      "same-basename repositories receive distinct managed roots",
    );
    const expectedSuffix = createHash("sha256")
      .update(realpathSync.native(firstSame), "utf8")
      .digest("hex")
      .slice(0, 12);
    assert.strictEqual(
      path.basename(firstManaged),
      `same-${expectedSuffix}`,
      "managed root uses the canonical basename plus a 12-hex SHA-256 suffix",
    );
    const alias = path.join(identityRoot, "renamed-alias");
    symlinkSync(firstSame, alias, "dir");
    assert.strictEqual(
      wt.managedWorktreesRoot(managedHome, alias),
      firstManaged,
      "a symlink alias resolves to the target repository's exact managed root",
    );

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

    const r = await wt.createCopyWorktree({ repoCwd: repo, worktreesRoot, newBranch: "copy-test" });
    assert.ok(r.ok, `create failed: ${r.ok ? "" : r.error}`);
    assert.ok(existsSync(r.path), "worktree path should exist");
    assert.strictEqual(r.branch, "copy-test", "branch should be the given name");
    assert.strictEqual(
      git(r.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
      "copy-test",
      "worktree HEAD should be the new named branch",
    );
    assert.strictEqual(
      git(r.path, ["status", "--porcelain"]),
      "",
      "fresh worktree should be clean",
    );
    assert.strictEqual(r.baseBranch, "main", "baseBranch should be main");
    assert.ok(r.fileCount >= 1, `fileCount should be >= 1, got ${r.fileCount}`);

    // A taken name must surface git's refusal, not silently rename.
    const dup = await wt.createCopyWorktree({ repoCwd: repo, worktreesRoot, newBranch: "main" });
    assert.ok(!dup.ok, "creating a branch that already exists should fail");
    assert.ok(/already exists/i.test(dup.error), `error should say so, got: ${dup.error}`);
    const empty = await wt.createCopyWorktree({ repoCwd: repo, worktreesRoot, newBranch: "  " });
    assert.ok(!empty.ok, "blank branch name should fail");

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
    const orphan = await wt.createCopyWorktree({ repoCwd: repo, worktreesRoot, newBranch: "orphan-test" });
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
    const live = await wt.createCopyWorktree({ repoCwd: repo, worktreesRoot, newBranch: "live-test" });
    assert.ok(live.ok, `live create failed: ${live.ok ? "" : live.error}`);
    writeFileSync(path.join(live.path, "README.md"), "# uncommitted change\n");
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

    await agentWorktreeProbes(wt);

    console.log("PASS: git-worktrees");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktreesRoot, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
    rmSync(identityRoot, { recursive: true, force: true });
    try {
      rmSync(outFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function gitFails(cwd, args) {
  try {
    execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  } catch {
    return;
  }
  throw new Error(`expected git ${args.join(" ")} to fail`);
}

// The read-only probes agent-worktrees.ts combines into a removal verdict:
// start points, merge proofs for every way a branch lands, registrations and
// leftover local work. Its own repository, with a repo-local identity.
async function agentWorktreeProbes(wt) {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "spark-proofs-")));
  try {
    const repo = path.join(scratch, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    const commit = (cwd, name, content, message) => {
      writeFileSync(path.join(cwd, name), content);
      git(cwd, ["add", name]);
      git(cwd, ["commit", "-q", "-m", message]);
      return git(cwd, ["rev-parse", "HEAD"]);
    };
    const main = () => git(repo, ["rev-parse", "main"]);
    commit(repo, ".gitignore", "node_modules/\n.env.local\n", "ignore");
    commit(repo, "shared.txt", "one\ntwo\nthree\n", "init");
    const root = path.join(scratch, "wts");
    const fork = async (branch) => {
      const made = await wt.createCopyWorktree({
        repoCwd: repo,
        worktreesRoot: root,
        baseBranch: "main",
        startPoint: main(),
        newBranch: branch,
      });
      assert.ok(made.ok, `fork ${branch}: ${made.ok ? "" : made.error}`);
      return made;
    };

    // A commit start point records the base name and sets no upstream.
    const started = await fork("agent/start");
    assert.strictEqual(started.baseBranch, "main");
    gitFails(started.path, ["rev-parse", "--abbrev-ref", "@{u}"]);
    // A zero-commit branch is an ancestor of its base already.
    assert.strictEqual(await wt.isAncestor(repo, git(started.path, ["rev-parse", "HEAD"]), main()), true);

    // Merge commit.
    const merged = await fork("agent/merged");
    const mergedTip = commit(merged.path, "m.txt", "m\n", "m");
    assert.strictEqual(await wt.isAncestor(repo, mergedTip, main()), false);
    git(repo, ["merge", "-q", "--no-ff", "-m", "merge m", "agent/merged"]);
    assert.strictEqual(await wt.isAncestor(repo, mergedTip, main()), true);
    assert.strictEqual(await wt.aheadCount(repo, main(), mergedTip), 0);

    // Squash merge: the content is in the target although the tip is not.
    const squash = await fork("agent/squash");
    commit(squash.path, "s1.txt", "s1\n", "s1");
    const squashTip = commit(squash.path, "s2.txt", "s2\n", "s2");
    assert.strictEqual(await wt.contentInTarget(repo, squashTip, main()), false, "unmerged work is not in the target");
    assert.strictEqual(await wt.aheadCount(repo, main(), squashTip), 2);
    assert.deepStrictEqual(await wt.commitSubjectsBetween(repo, main(), squashTip), ["s2", "s1"]);
    git(repo, ["merge", "-q", "--squash", "agent/squash"]);
    git(repo, ["commit", "-q", "-m", "squash s"]);
    assert.strictEqual(await wt.isAncestor(repo, squashTip, main()), false);
    assert.strictEqual(await wt.contentInTarget(repo, squashTip, main()), true, "a squash merge holds the content");

    // Rebase merge: the same change as a new commit on the target.
    const rebased = await fork("agent/rebased");
    const rebasedTip = commit(rebased.path, "r.txt", "r\n", "r");
    git(repo, ["cherry-pick", rebasedTip]);
    assert.strictEqual(await wt.contentInTarget(repo, rebasedTip, main()), true, "a rebase merge holds the content");

    // Squash, then a revert in the target: the proof fails, the safe way.
    const reverted = await fork("agent/reverted");
    const revertedTip = commit(reverted.path, "v.txt", "v\n", "v");
    git(repo, ["merge", "-q", "--squash", "agent/reverted"]);
    git(repo, ["commit", "-q", "-m", "squash v"]);
    git(repo, ["revert", "--no-edit", "HEAD"]);
    assert.strictEqual(await wt.contentInTarget(repo, revertedTip, main()), false, "a revert undoes the proof");

    // Squash, then the target rewrites the same lines: no proof either.
    const rewritten = await fork("agent/rewritten");
    const rewrittenTip = commit(rewritten.path, "shared.txt", "one\nTWO\nthree\n", "upper two");
    git(repo, ["merge", "-q", "--squash", "agent/rewritten"]);
    git(repo, ["commit", "-q", "-m", "squash two"]);
    commit(repo, "shared.txt", "one\nzwei\nthree\n", "rewrite two");
    assert.strictEqual(await wt.contentInTarget(repo, rewrittenTip, main()), false, "a later rewrite undoes the proof");

    // Registrations carry the branch, lock and detached state.
    git(repo, ["worktree", "lock", merged.path]);
    git(started.path, ["checkout", "-q", "--detach"]);
    const registrations = await wt.listWorktreeRegistrations(repo);
    const mergedEntry = registrations.find((entry) => entry.path === merged.path);
    assert.strictEqual(mergedEntry.locked, true);
    assert.strictEqual(mergedEntry.branch, "refs/heads/agent/merged");
    const startedEntry = registrations.find((entry) => entry.path === started.path);
    assert.strictEqual(startedEntry.detached, true);
    assert.strictEqual(startedEntry.branch, undefined);
    git(repo, ["worktree", "unlock", merged.path]);
    assert.strictEqual(await wt.branchWorktreePath(repo, "agent/merged"), merged.path);
    assert.strictEqual(await wt.isRegisteredWorktree(repo, merged.path), true);

    // In-progress operations, read from each worktree's own git dir.
    assert.strictEqual(await wt.inProgressOperation(merged.path), null);
    const midMerge = await fork("agent/mid-merge");
    commit(midMerge.path, "shared.txt", "one\nmine\nthree\n", "mine");
    commit(repo, "shared.txt", "one\ntheirs\nthree\n", "theirs");
    gitFails(midMerge.path, ["merge", "main"]);
    assert.strictEqual(await wt.inProgressOperation(midMerge.path), "merge");
    const midRebase = await fork("agent/mid-rebase");
    git(midRebase.path, ["reset", "-q", "--hard", "HEAD~1"]);
    commit(midRebase.path, "shared.txt", "one\nours\nthree\n", "ours");
    gitFails(midRebase.path, ["rebase", "main"]);
    assert.strictEqual(await wt.inProgressOperation(midRebase.path), "rebase");
    assert.strictEqual(await wt.inProgressOperation(repo), null, "the main checkout has its own git dir");

    // Ignored files: a wholly ignored directory collapses to one entry.
    mkdirSync(path.join(merged.path, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(merged.path, "node_modules", "pkg", "index.js"), "\n");
    writeFileSync(path.join(merged.path, ".env.local"), "TOKEN=1\n");
    assert.deepStrictEqual((await wt.ignoredEntries(merged.path)).sort(), [".env.local", "node_modules/"]);

    // Edits git status hides: assume-unchanged and skip-worktree files that
    // differ from the index. An absent skip-worktree file holds no edit.
    const hidden = await fork("agent/hidden");
    assert.deepStrictEqual(await wt.hiddenLocalChanges(hidden.path), []);
    git(hidden.path, ["update-index", "--assume-unchanged", "shared.txt"]);
    assert.deepStrictEqual(await wt.hiddenLocalChanges(hidden.path), [], "a flag alone is no edit");
    writeFileSync(path.join(hidden.path, "shared.txt"), "edited where status cannot see\n");
    assert.strictEqual(git(hidden.path, ["status", "--porcelain"]), "");
    assert.deepStrictEqual(await wt.hiddenLocalChanges(hidden.path), ["shared.txt"]);
    git(hidden.path, ["update-index", "--no-assume-unchanged", "shared.txt"]);
    git(hidden.path, ["checkout", "--", "shared.txt"]);
    git(hidden.path, ["update-index", "--skip-worktree", "shared.txt"]);
    writeFileSync(path.join(hidden.path, "shared.txt"), "edited where status cannot see\n");
    assert.deepStrictEqual(await wt.hiddenLocalChanges(hidden.path), ["shared.txt"]);
    rmSync(path.join(hidden.path, "shared.txt"));
    assert.deepStrictEqual(await wt.hiddenLocalChanges(hidden.path), [], "a sparse, absent file is no edit");

    // A nested repository committed as a bare gitlink, with no .gitmodules,
    // is a populated submodule to git's worktree removal.
    const vendoring = await fork("agent/vendoring");
    const vendored = path.join(vendoring.path, "vendored");
    execFileSync("git", ["init", "-q", "-b", "main", vendored]);
    git(vendored, ["config", "user.name", "Test"]);
    git(vendored, ["config", "user.email", "test@example.com"]);
    commit(vendored, "only-copy.txt", "nowhere else\n", "only copy");
    git(vendoring.path, ["add", "vendored"]);
    git(vendoring.path, ["commit", "-q", "-m", "vendor"]);
    assert.deepStrictEqual(await wt.populatedSubmodules(vendoring.path), ["vendored"]);
    assert.deepStrictEqual(await wt.populatedSubmodules(merged.path), []);

    // Reached through a symlinked root, the worktree's path does not match
    // git's canonical listing, so it reads as unregistered. git refuses the
    // removal over the submodule; removeOrphanDir:false must keep that a
    // failure rather than delete the tree recursively.
    const linkedRoot = path.join(scratch, "linked-wts");
    symlinkSync(root, linkedRoot, "dir");
    const viaLink = path.join(linkedRoot, path.basename(vendoring.path));
    assert.strictEqual(await wt.isRegisteredWorktree(repo, viaLink), false);
    const refused = await wt.removeCopyWorktree({
      repoCwd: repo,
      worktreePath: viaLink,
      branch: "agent/vendoring",
      removeOrphanDir: false,
    });
    assert.ok(!refused.ok && /submodule/i.test(refused.error), JSON.stringify(refused));
    assert.ok(existsSync(path.join(vendored, "only-copy.txt")), "the nested repository's only copy survives");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
