// Contract tests for the agent worktree tools (src/main/agent-worktrees.ts):
// what a normal removal or creation must do without the agent guessing, and
// what every refusal must say. Real git in throwaway repositories, in-memory
// app state, no network.
//
// Invariant under test: removal never deletes a file that git does not
// ignore and that is not in the cache allowlist (REGENERABLE_CACHE_DIRS), and
// never removes a worktree with commits that are in neither the target nor a
// merged pull request.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// CASE=3 runs one case only (used to show a case failing on the old code).
const want = (n) => !process.env.CASE || process.env.CASE === String(n);
const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (cwd, name, content = "x\n") => {
  fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
  fs.writeFileSync(path.join(cwd, name), content);
};
const commitFile = (cwd, name, content, message) => {
  write(cwd, name, content);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
};

async function main() {
  const esbuild = require("esbuild");
  const cacheDir = path.join(__dirname, "..", "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outFile = path.join(cacheDir, `spark-agent-worktree-contracts-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", "main", "agent-worktrees.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    alias: { "@shared": path.join(__dirname, "..", "src", "shared") },
    external: ["electron", "ssh2", "cpu-features"],
    logLevel: "silent",
  });
  const aw = require(outFile);

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-wt-contract-")));
  const home = path.join(scratch, "home");
  fs.mkdirSync(home, { recursive: true });
  const gitConfig = path.join(scratch, "gitconfig");
  fs.writeFileSync(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.HOME = home;

  try {
    const origin = path.join(scratch, "origin.git");
    const repo = path.join(scratch, "repo");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    commitFile(repo, ".gitignore", "node_modules/\n.env.local\n__pycache__/\n.pytest_cache/\n.ruff_cache/\n.mypy_cache/\ncoverage/\n.next/\n", "ignore");
    commitFile(repo, "README.md", "# test\n", "init");
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);

    let ids = 0;
    const h = {
      state: {
        workspaces: [{ id: "ws-repo", name: "repo", cwd: repo, color: "#123456", workers: [] }],
        workspaceRailOrder: ["ws-repo"],
        activeWorkspaceId: "ws-repo",
      },
      prefs: { agentWorktreesEnabled: true, agentsMayRemoveUserWorktrees: false, agentWorktreeRegenerableIgnoredByRepo: {} },
      paneWorkspace: { "pane-1": "ws-repo" },
      pulls: [],
      afterVerify: null,
      now: new Date("2026-10-12T10:00:00Z"),
    };
    const deps = {
      loadState: async () => structuredClone(h.state),
      updateState: async (mutator) => {
        h.state = await mutator(structuredClone(h.state));
        return h.state;
      },
      loadPreferences: async () => h.prefs,
      publishState: () => {},
      invalidateGitCache: () => {},
      getRun: async () => null,
      listRuns: async () => [],
      paneWorkspaceId: async (paneId) => h.paneWorkspace[paneId] ?? null,
      sessionCwd: () => null,
      sessionsUnderCwd: () => [],
      listRendererTerminals: async () => [],
      workspaceHeld: async () => false,
      processesUnderCwd: async () => [],
      github: { listPullRequestsForHead: async () => h.pulls, listMergedPullRequests: async () => h.pulls },
      sendAgentEvent: () => {},
      audit: aw.createWorktreeAuditLog(path.join(home, "logs", "worktree-audit.jsonl")),
      worktreesRoot: (repoCwd) => path.join(home, "worktrees", path.basename(repoCwd)),
      now: () => h.now,
      randomId: () => (++ids).toString(16).padStart(8, "a"),
      afterVerify: async () => {
        if (h.afterVerify) await h.afterVerify();
      },
      pretrustClaude: async () => {},
    };
    const agent = { role: "studio", client: "claude-code", paneId: "pane-1" };
    const make = async (branch, extra = {}) => {
      const made = await aw.createAgentWorktree(agent, { branch, ...extra }, deps);
      assert.equal(made.ok, true, JSON.stringify(made));
      return made;
    };
    // A worktree whose branch was pushed and merged into main, as a user would leave it.
    const mergedWorktree = async (branch) => {
      const made = await make(branch);
      commitFile(made.path, `${branch.replace(/\W/g, "-")}.txt`, "work\n", `work on ${branch}`);
      git(made.path, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
      git(repo, ["fetch", "-q", "origin"]);
      git(repo, ["merge", "-q", "--ff-only", `origin/${branch}`]);
      git(repo, ["push", "-q", "origin", "main"]);
      return made;
    };
    const guarded = (refused, code) => {
      assert.equal(refused.ok, false, JSON.stringify(refused));
      assert.equal(refused.code, code, JSON.stringify(refused));
      assert.ok(typeof refused.hint === "string" && refused.hint.length > 0, `${code} carries a hint: ${JSON.stringify(refused)}`);
    };

    // ── Case 1: regenerable caches never block removal ─────────────────────
    if (want(1)) {
    const cacheTree = await mergedWorktree("agent/caches");
    for (const file of [
      "pkg/__pycache__/mod.cpython-312.pyc", // ignored by the repository
      "pkg/sub/__pycache__/other.pyc",
      ".pytest_cache/v/cache/nodeids",
      "tests/.pytest_cache/README.md",
      ".ruff_cache/0.1/x",
      "lib/.mypy_cache/3.12/y.json",
      "coverage/lcov.info",
      "web/.next/cache/webpack/z",
      "node_modules/.vite/deps/a.js",
    ]) write(cacheTree.path, file);
    write(cacheTree.path, ".pytest_cache/.gitignore", "*\n");
    // Ignored caches pass without discardIgnoredFiles: they go through the path that parameter already uses.
    const dry = await aw.removeAgentWorktree(agent, { workspaceId: cacheTree.workspaceId, dryRun: true }, deps);
    assert.equal(dry.wouldRemove, true, `caches do not block: ${JSON.stringify(dry)}`);
    const cacheRemoved = await aw.removeAgentWorktree(agent, { workspaceId: cacheTree.workspaceId }, deps);
    assert.equal(cacheRemoved.removed, true, JSON.stringify(cacheRemoved));
    assert.equal(fs.existsSync(cacheTree.path), false);

    // A cache folder git does not ignore blocks, and the hint names it; no parameter forces it.
    const loose = await mergedWorktree("agent/loose-cache");
    write(loose.path, ".turbo/run.log");
    const looseRefused = await aw.removeAgentWorktree(agent, { workspaceId: loose.workspaceId }, deps);
    guarded(looseRefused, "WORKTREE_DIRTY");
    assert.match(looseRefused.hint, /cache folders git does not ignore: delete them or add them to \.gitignore, then retry \(\.turbo\/\)/);
    assert.equal(looseRefused.retryWith, undefined);
    const looseForced = await aw.removeAgentWorktree(agent, { workspaceId: loose.workspaceId, discardIgnoredFiles: true }, deps);
    assert.equal(looseForced.code, "WORKTREE_DIRTY", "discardIgnoredFiles does not cover untracked files");
    assert.ok(fs.existsSync(path.join(loose.path, ".turbo/run.log")), "nothing was deleted");
    fs.rmSync(path.join(loose.path, ".turbo"), { recursive: true });
    assert.equal((await aw.removeAgentWorktree(agent, { workspaceId: loose.workspaceId }, deps)).removed, true);

    // A source file written after the status check is never deleted: the existing locked re-check refuses and keeps it.
    const late = await mergedWorktree("agent/late-file");
    write(late.path, "pkg/__pycache__/m.pyc");
    h.afterVerify = async () => write(late.path, "late.py", "print(1)\n");
    const lateRefused = await aw.removeAgentWorktree(agent, { workspaceId: late.workspaceId }, deps);
    h.afterVerify = null;
    assert.equal(lateRefused.ok, false, JSON.stringify(lateRefused));
    assert.ok(fs.existsSync(path.join(late.path, "late.py")), "the late file survives");
    fs.rmSync(path.join(late.path, "late.py"));
    assert.equal((await aw.removeAgentWorktree(agent, { workspaceId: late.workspaceId }, deps)).removed, true);

    // Invariant: this change adds no deletion code. git-worktrees.ts is untouched.
    assert.equal(
      execFileSync("git", ["-C", path.join(__dirname, ".."), "diff", "--name-only", "origin/main", "--", "src/main/git-worktrees.ts"], { encoding: "utf8" }).trim(),
      "",
      "src/main/git-worktrees.ts (the deleting code) is unchanged",
    );

    // Real work still blocks, next to the same caches.
    const workTree = await mergedWorktree("agent/real-work");
    write(workTree.path, "pkg/__pycache__/mod.pyc");
    write(workTree.path, "pkg/new_module.py", "print(1)\n");
    guarded(await aw.removeAgentWorktree(agent, { workspaceId: workTree.workspaceId }, deps), "WORKTREE_DIRTY");
    fs.rmSync(path.join(workTree.path, "pkg/new_module.py"));
    // A look-alike is not a cache: a file named like one, a nested coverage folder, notes in a cache-named path elsewhere.
    write(workTree.path, "docs/coverage/report.md");
    guarded(await aw.removeAgentWorktree(agent, { workspaceId: workTree.workspaceId }, deps), "WORKTREE_IGNORED_FILES");
    fs.rmSync(path.join(workTree.path, "docs"), { recursive: true });
    write(workTree.path, "src/__pycache__");
    guarded(await aw.removeAgentWorktree(agent, { workspaceId: workTree.workspaceId }, deps), "WORKTREE_DIRTY");
    fs.rmSync(path.join(workTree.path, "src"), { recursive: true });
    // An ignored secret is kept out of the allowlist too.
    write(workTree.path, ".env.local", "TOKEN=1\n");
    const secret = await aw.removeAgentWorktree(agent, { workspaceId: workTree.workspaceId }, deps);
    guarded(secret, "WORKTREE_IGNORED_FILES");
    assert.deepEqual(secret.retryWith, { discardIgnoredFiles: true });
    assert.ok(fs.existsSync(path.join(workTree.path, ".env.local")), "nothing was deleted");
    fs.rmSync(path.join(workTree.path, ".env.local"));
    // A real (not linked) node_modules at the root is regenerable and does not block.
    write(workTree.path, "node_modules/left-pad/index.js");
    const withModules = await aw.removeAgentWorktree(agent, { workspaceId: workTree.workspaceId }, deps);
    assert.equal(withModules.removed, true, JSON.stringify(withModules));

    }
    // ── Case 2: merged by pull request, by content, and the refusal that names the commits ──
    if (want(2)) {
    // Squash-merged on GitHub: the branch commits are not ancestors of main.
    const squashed = await make("agent/squashed");
    const squashedTip = commitFile(squashed.path, "squash.txt", "s\n", "add squash file");
    git(squashed.path, ["push", "-q", "origin", "HEAD:refs/heads/agent/squashed"]);
    commitFile(repo, "squash.txt", "s\n", "add squash file (#1)");
    git(repo, ["push", "-q", "origin", "main"]);
    const squashRemoved = await aw.removeAgentWorktree(agent, { workspaceId: squashed.workspaceId }, deps);
    assert.equal(squashRemoved.removed, true, `identical content in main counts as merged: ${JSON.stringify(squashRemoved)}`);

    // A merged pull request proves a squash whose content later changed.
    const viaPr = await make("agent/via-pr");
    const prTip = commitFile(viaPr.path, "pr-only.txt", "p\n", "pr work");
    git(viaPr.path, ["push", "-q", "origin", "HEAD:refs/heads/agent/via-pr"]);
    h.pulls = [{ number: 7, url: "https://example.test/pr/7", headRefName: "agent/via-pr", baseRefName: "main", headRefOid: prTip, mergedAt: "2026-10-12T09:00:00Z", isCrossRepository: false }];
    const viaPrRemoved = await aw.removeAgentWorktree(agent, { workspaceId: viaPr.workspaceId }, deps);
    h.pulls = [];
    assert.equal(viaPrRemoved.removed, true, JSON.stringify(viaPrRemoved));

    // Not merged anywhere: the refusal names the commits and the rule.
    const open = await make("agent/open-work");
    commitFile(open.path, "a.txt", "a\n", "first unmerged change");
    commitFile(open.path, "b.txt", "b\n", "second unmerged change");
    const notMerged = await aw.removeAgentWorktree(agent, { workspaceId: open.workspaceId }, deps);
    guarded(notMerged, "WORKTREE_NOT_MERGED");
    assert.match(notMerged.error, /2 commits/);
    assert.match(notMerged.error, /second unmerged change/);
    assert.match(notMerged.error, /first unmerged change/);
    assert.match(notMerged.hint, /target/);
    assert.ok(fs.existsSync(open.path), "unmerged work is never removed");
    // The same work contained in another branch on origin: the exact parameter to pass.
    git(open.path, ["push", "-q", "origin", "HEAD:refs/heads/release/next"]);
    git(repo, ["fetch", "-q", "origin"]);
    const elsewhere = await aw.removeAgentWorktree(agent, { workspaceId: open.workspaceId }, deps);
    guarded(elsewhere, "WORKTREE_NOT_MERGED");
    assert.deepEqual(elsewhere.retryWith, { target: "origin/release/next" }, JSON.stringify(elsewhere));
    const retried = await aw.removeAgentWorktree(agent, { workspaceId: open.workspaceId, ...elsewhere.retryWith }, deps);
    assert.equal(retried.removed, true, JSON.stringify(retried));

    // The agent renamed the branch inside the worktree: the new name is judged, not refused as a mismatch.
    const renamed = await mergedWorktree("agent/before-rename");
    git(renamed.path, ["branch", "-m", "agent/after-rename"]);
    const renamedRemoved = await aw.removeAgentWorktree(agent, { workspaceId: renamed.workspaceId }, deps);
    assert.equal(renamedRemoved.removed, true, JSON.stringify(renamedRemoved));
    // Renamed with unmerged work: the refusal says which branch it is on and what is unmerged.
    const renamedOpen = await make("agent/rename-open");
    commitFile(renamedOpen.path, "r.txt", "r\n", "unmerged after rename");
    git(renamedOpen.path, ["branch", "-m", "agent/renamed-open"]);
    const renamedRefused = await aw.removeAgentWorktree(agent, { workspaceId: renamedOpen.workspaceId }, deps);
    assert.equal(renamedRefused.ok, false);
    assert.match(renamedRefused.error, /unmerged after rename/);
    assert.ok(fs.existsSync(renamedOpen.path));

    // Hints are commands: metacharacters and spaces are quoted.
    const odd = await make("agent/odd;echo>marker");
    git(odd.path, ["checkout", "-q", "--detach"]);
    const oddRefused = await aw.removeAgentWorktree(agent, { workspaceId: odd.workspaceId }, deps);
    assert.match(oddRefused.hint, /switch 'agent\/odd;echo>marker'/, oddRefused.hint);

    // Checked out the default branch inside the worktree: the refusal names it.
    const onMain = await make("agent/on-main");
    git(onMain.path, ["checkout", "-q", "--detach"]);
    const detached = await aw.removeAgentWorktree(agent, { workspaceId: onMain.workspaceId }, deps);
    guarded(detached, "WORKTREE_DETACHED_HEAD");
    assert.match(detached.hint, /git -C .* switch agent\/on-main/);

    }
    // ── Case 3: a worktree that is already gone ────────────────────────────
    if (want(3)) {
    const gone = await make("agent/gone");
    fs.rmSync(gone.path, { recursive: true, force: true });
    const goneRemoved = await aw.removeAgentWorktree(agent, { workspaceId: gone.workspaceId }, deps);
    assert.equal(goneRemoved.ok, true, JSON.stringify(goneRemoved));
    assert.equal(goneRemoved.alreadyRemoved, true);
    const pruned = await make("agent/pruned");
    fs.rmSync(pruned.path, { recursive: true, force: true });
    git(repo, ["worktree", "prune"]);
    const prunedRemoved = await aw.removeAgentWorktree(agent, { workspaceId: pruned.workspaceId }, deps);
    assert.equal(prunedRemoved.ok, true, JSON.stringify(prunedRemoved));
    assert.equal(prunedRemoved.alreadyRemoved, true);
    // By path, after everything about it is gone.
    const byPath = await aw.removeAgentWorktree(agent, { path: pruned.path }, deps);
    assert.equal(byPath.ok, true, JSON.stringify(byPath));
    assert.equal(byPath.alreadyRemoved, true);
    // A path that never was a worktree of this repository is still refused.
    guarded(await aw.removeAgentWorktree(agent, { path: path.join(scratch, "never-existed") }, deps), "WORKTREE_NOT_FOUND");

    }
    // ── Case 4: a workspace folder that holds repositories ─────────────────
    if (want(4)) {
    const folder = path.join(scratch, "folder");
    for (const name of ["api", "web", path.join("deep", "tools")]) {
      fs.mkdirSync(path.join(folder, name), { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main", path.join(folder, name)]);
      commitFile(path.join(folder, name), "README.md", "r\n", "init");
    }
    fs.mkdirSync(path.join(folder, "a", "b", "c", "toodeep"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", path.join(folder, "a", "b", "c", "toodeep")]);
    h.state.workspaces.push({ id: "ws-folder", name: "folder", cwd: folder, color: "#abcdef", workers: [] });
    h.paneWorkspace["pane-folder"] = "ws-folder";
    const folderAgent = { role: "studio", client: "claude-code", paneId: "pane-folder" };
    const notRepo = await aw.createAgentWorktree(folderAgent, { branch: "agent/x" }, deps);
    guarded(notRepo, "WORKTREE_NOT_A_REPO");
    assert.deepEqual(notRepo.nestedRepositories, [path.join(folder, "api"), path.join(folder, "deep", "tools"), path.join(folder, "web")]);
    assert.match(notRepo.hint, /pass workspace=/);
    assert.match(notRepo.hint, new RegExp(path.join(folder, "api").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(notRepo.retryWith, { workspace: path.join(folder, "api") });
    // A folder without any repository says so, and lists nothing.
    const empty = path.join(scratch, "empty");
    fs.mkdirSync(empty);
    h.state.workspaces.push({ id: "ws-empty", name: "empty", cwd: empty, color: "#abcdef", workers: [] });
    h.paneWorkspace["pane-empty"] = "ws-empty";
    const none = await aw.createAgentWorktree({ role: "studio", client: "claude-code", paneId: "pane-empty" }, { branch: "agent/x" }, deps);
    guarded(none, "WORKTREE_NOT_A_REPO");
    assert.equal(none.nestedRepositories, undefined);
    assert.equal(none.retryWith, undefined);

    }
    // ── Case 5: forks from the remote head, and says when the fetch failed ──
    if (want(5)) {
    const other = path.join(scratch, "other");
    execFileSync("git", ["clone", "-q", origin, other]);
    const remoteHead = commitFile(other, "remote-only.txt", "r\n", "landed elsewhere");
    git(other, ["push", "-q", "origin", "main"]);
    assert.notEqual(git(repo, ["rev-parse", "origin/main"]), remoteHead, "the local view of origin is stale");
    const fresh = await make("agent/fresh");
    assert.equal(fresh.base, "origin/main");
    assert.equal(fresh.baseCommit, remoteHead, "forked from the remote head after a fetch");
    assert.equal(git(fresh.path, ["rev-parse", "HEAD"]), remoteHead);
    assert.equal(fresh.fetch, "ok");
    // The remote is unreachable: stale base, and the result says so.
    git(repo, ["remote", "set-url", "origin", path.join(scratch, "missing.git")]);
    const stale = await make("agent/stale");
    assert.equal(stale.baseCommit, remoteHead, "the last fetched head");
    assert.match(stale.fetch, /^failed: .+/, JSON.stringify(stale));
    assert.ok(stale.warnings.some((warning) => /fetch failed/.test(warning)));
    const skipped = await make("agent/no-fetch", { fetch: false });
    assert.equal(skipped.fetch, "skipped");
    git(repo, ["remote", "set-url", "origin", origin]);

    }
    // ── Case 6: refusals carry code, hint and, when a parameter helps, retryWith ──
    if (want(6)) {
    git(repo, ["branch", "topic-exists"]);
    const exists = await aw.createAgentWorktree(agent, { branch: "topic-exists" }, deps);
    guarded(exists, "WORKTREE_BRANCH_EXISTS");
    assert.deepEqual(exists.retryWith, { checkout: true });
    const noBase = await aw.createAgentWorktree(agent, { branch: "agent/nb", base: "no-such-ref" }, deps);
    guarded(noBase, "WORKTREE_BASE_NOT_FOUND");
    const sixth = await make("agent/case6");
    const noTarget = await aw.removeAgentWorktree(agent, { workspaceId: sixth.workspaceId, target: "no-such-branch" }, deps);
    guarded(noTarget, "WORKTREE_TARGET_NOT_FOUND");
    assert.deepEqual(noBase.retryWith, { base: "origin/main" });
    assert.deepEqual(noTarget.retryWith, { target: "origin/main" });
    // Every code has a message and a hint, so no refusal leaves the agent guessing.
    for (const code of Object.keys(aw.WORKTREE_MESSAGES)) {
      assert.ok(aw.WORKTREE_HINTS[code], `${code} has a hint`);
    }
    guarded(await aw.removeAgentWorktree(agent, { workspaceId: "ws-nope" }, deps), "WORKTREE_NOT_FOUND");
    const changedHint = await aw.removeAgentWorktree({ role: "worker", client: "claude-code" }, { workspaceId: sixth.workspaceId }, deps);
    assert.equal(changedHint.ok, false);
    assert.equal(typeof changedHint.code, "string");
    assert.equal(typeof changedHint.hint, "string", JSON.stringify(changedHint));

    }
    console.log("test-agent-worktree-contracts: ok");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(outFile, { force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
