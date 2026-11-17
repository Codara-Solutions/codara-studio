// Which commit codara_worktree_create forks from when `base` names a local
// branch that tracks a remote one (issue #184): the freshly fetched remote
// branch, not a local copy that may be far behind; offline, the last fetched
// remote branch; with fetch:false, the local branch as it is. base "HEAD",
// a remote-tracking base and checkout:true keep their behaviour. Driven
// against throwaway repositories with a fake git config, like
// test-agent-worktrees.cjs.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFile(cwd, name, content, message) {
  fs.writeFileSync(path.join(cwd, name), content);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

async function main() {
  const esbuild = require("esbuild");
  const cacheDir = path.join(__dirname, "..", "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outFile = path.join(cacheDir, `spark-agent-worktree-base-${process.pid}.cjs`);
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
  const reviewOut = path.join(cacheDir, `spark-agent-worktree-base-review-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", "main", "review", "review-diff.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: reviewOut,
    alias: { "@shared": path.join(__dirname, "..", "src", "shared") },
    external: ["electron", "ssh2", "cpu-features"],
    logLevel: "silent",
  });
  const review = require(reviewOut);

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-agent-wt-base-")));
  const home = path.join(scratch, "home");
  fs.mkdirSync(home, { recursive: true });
  const gitConfig = path.join(scratch, "gitconfig");
  fs.writeFileSync(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.HOME = home;

  let passed = 0;
  const check = async (name, fn) => {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  try {
    const origin = path.join(scratch, "origin.git");
    const repo = path.join(scratch, "repo");
    const other = path.join(scratch, "other");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    commitFile(repo, "README.md", "# test\n", "init");
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);
    execFileSync("git", ["clone", "-q", origin, other]);
    // Another machine moves origin/main on: the primary checkout's main,
    // never pulled, falls behind.
    const pushMain = (count) => {
      for (let i = 0; i < count; i += 1) commitFile(other, `f${Date.now()}-${i}.txt`, `${i}\n`, `remote ${i}`);
      git(other, ["push", "-q", "origin", "main"]);
      return git(other, ["rev-parse", "HEAD"]);
    };

    let ids = 0;
    const h = {
      state: {
        workspaces: [{ id: "ws-repo", name: "repo", cwd: repo, color: "#123456", workers: [] }],
        workspaceRailOrder: ["ws-repo"],
        activeWorkspaceId: "ws-repo",
      },
    };
    const deps = {
      loadState: async () => structuredClone(h.state),
      updateState: async (mutator) => {
        h.state = await mutator(structuredClone(h.state));
        return h.state;
      },
      loadPreferences: async () => ({ agentWorktreesEnabled: true, agentsMayRemoveUserWorktrees: false }),
      publishState: () => {},
      invalidateGitCache: () => {},
      getRun: async () => null,
      listRuns: async () => [],
      paneWorkspaceId: async (paneId) => (paneId === "pane-1" ? "ws-repo" : null),
      sessionCwd: () => null,
      sessionsUnderCwd: () => [],
      listRendererTerminals: async () => [],
      workspaceHeld: async () => false,
      processesUnderCwd: async () => [],
      github: {
        listPullRequestsForHead: async () => [],
        listMergedPullRequests: async () => [],
        listPullRequestsForCommit: async () => [],
      },
      sendAgentEvent: () => {},
      audit: async () => {},
      worktreesRoot: (repoCwd) => path.join(home, "worktrees", path.basename(repoCwd)),
      now: () => new Date("2026-11-17T10:00:00Z"),
      randomId: () => (++ids).toString(16).padStart(8, "a"),
      afterVerify: async () => {},
    };
    const agent = { role: "studio", client: "claude-code", paneId: "pane-1" };
    const create = async (input) => {
      // Only the newest row is read; dropping the rest keeps the suite under
      // the 20 agent worktrees a repository may have.
      h.state.workspaces = h.state.workspaces.filter((workspace) => workspace.id === "ws-repo");
      const made = await aw.createAgentWorktree(agent, input, deps);
      assert.equal(made.ok, true, JSON.stringify(made));
      return made;
    };
    const headOf = (made) => git(made.path, ["rev-parse", "HEAD"]);

    const localMain = git(repo, ["rev-parse", "main"]);
    let remoteMain = pushMain(3);

    await check("base main forks from the fetched origin/main when the local main is behind", async () => {
      assert.equal(git(repo, ["rev-parse", "origin/main"]), localMain, "the primary checkout has not fetched yet");
      const made = await create({ branch: "fix/behind", base: "main" });
      assert.equal(headOf(made), remoteMain);
      assert.equal(made.baseCommit, remoteMain);
      assert.equal(made.base, "main");
      assert.equal(made.baseRef, "origin/main");
      assert.equal(made.fetch, "ok");
      assert.equal(made.baseBehindRemote, 3);
      assert.equal(made.baseAheadOfRemote, undefined);
      assert.equal(made.warnings, undefined, JSON.stringify(made.warnings));
      assert.equal(git(repo, ["rev-parse", "main"]), localMain, "the local main is left alone");
      const stored = h.state.workspaces.find((workspace) => workspace.id === made.workspaceId).copyBranch.baseBranch;
      assert.equal(stored, "origin/main", "the recorded base is the ref it forked from");
      // The review panel diffs against the recorded base: none of origin's
      // commits may show as the agent's own.
      const diff = await review.getReviewDiff({ cwd: made.path, mode: "base" }, { workspaceBase: async () => stored });
      assert.equal(diff.base, "origin/main");
      assert.deepEqual(diff.files.map((file) => file.path), []);
    });

    await check("base main without an upstream still means origin's default branch", async () => {
      git(repo, ["branch", "--unset-upstream", "main"]);
      remoteMain = pushMain(1);
      const made = await create({ branch: "fix/no-upstream", base: "main" });
      assert.equal(headOf(made), remoteMain);
      assert.equal(made.baseRef, "origin/main");
      assert.equal(made.baseBehindRemote, 4);
      git(repo, ["branch", "-q", "--set-upstream-to", "origin/main", "main"]);
    });

    await check("a feature branch with an upstream forks from its fetched remote branch", async () => {
      git(other, ["checkout", "-q", "-b", "feat/shared"]);
      const first = commitFile(other, "shared.txt", "1\n", "shared 1");
      git(other, ["push", "-q", "-u", "origin", "feat/shared"]);
      git(repo, ["fetch", "-q", "origin"]);
      git(repo, ["branch", "-q", "--track", "feat/shared", "origin/feat/shared"]);
      const second = commitFile(other, "shared.txt", "2\n", "shared 2");
      git(other, ["push", "-q", "origin", "feat/shared"]);
      git(other, ["checkout", "-q", "main"]);
      const made = await create({ branch: "fix/on-shared", base: "feat/shared" });
      assert.equal(git(repo, ["rev-parse", "feat/shared"]), first);
      assert.equal(headOf(made), second);
      assert.equal(made.baseRef, "origin/feat/shared");
      assert.equal(made.baseBehindRemote, 1);
    });

    await check("a local branch that tracks nothing forks from itself, unfetched", async () => {
      git(repo, ["branch", "-q", "local-only", localMain]);
      const made = await create({ branch: "fix/local-only", base: "local-only" });
      assert.equal(headOf(made), localMain);
      assert.equal(made.baseRef, "local-only");
      assert.equal(made.fetch, "skipped");
      assert.equal(made.baseBehindRemote, undefined);
    });

    await check("local commits origin lacks are named, and the fork still starts at origin", async () => {
      git(repo, ["fetch", "-q", "origin"]);
      git(repo, ["checkout", "-q", "main"]);
      git(repo, ["merge", "-q", "--ff-only", "origin/main"]);
      const unpushed = commitFile(repo, "local.txt", "local\n", "unpushed");
      remoteMain = pushMain(2);
      const made = await create({ branch: "fix/diverged", base: "main" });
      assert.equal(headOf(made), remoteMain);
      assert.equal(made.baseBehindRemote, 2);
      assert.equal(made.baseAheadOfRemote, 1);
      assert.ok(made.warnings.some((w) => /1 commit .*origin\/main does not have.*fetch: ?false/i.test(w)), JSON.stringify(made.warnings));
      const local = await create({ branch: "fix/local-main", base: "main", fetch: false });
      assert.equal(headOf(local), unpushed, "fetch:false forks from the local main as it is");
      assert.equal(local.baseRef, "main");
      assert.equal(local.fetch, "skipped");
      git(repo, ["reset", "-q", "--hard", "origin/main"]);
    });

    await check("offline, base main falls back to the last fetched origin/main", async () => {
      git(repo, ["fetch", "-q", "origin"]);
      const lastFetched = git(repo, ["rev-parse", "origin/main"]);
      git(repo, ["reset", "-q", "--hard", localMain]);
      pushMain(1);
      git(repo, ["remote", "set-url", "origin", path.join(scratch, "unreachable.git")]);
      try {
        const made = await create({ branch: "fix/offline", base: "main" });
        assert.equal(headOf(made), lastFetched);
        assert.equal(made.baseRef, "origin/main");
        assert.match(made.fetch, /^failed: /);
        assert.ok(made.warnings.some((w) => /fetch failed: .*last fetched origin\/main/.test(w)), JSON.stringify(made.warnings));
        assert.equal(made.baseBehindRemote, git(repo, ["rev-list", "--count", `${localMain}..${lastFetched}`]) * 1);
      } finally {
        git(repo, ["remote", "set-url", "origin", origin]);
      }
    });

    await check("an upstream never fetched leaves the local branch, with a warning", async () => {
      git(repo, ["branch", "-q", "orphan-upstream", localMain]);
      git(repo, ["config", "branch.orphan-upstream.remote", "origin"]);
      git(repo, ["config", "branch.orphan-upstream.merge", "refs/heads/never-pushed"]);
      const made = await create({ branch: "fix/orphan-upstream", base: "orphan-upstream" });
      assert.equal(headOf(made), localMain);
      assert.equal(made.baseRef, "orphan-upstream");
      assert.match(made.fetch, /^failed: /);
      assert.ok(made.warnings.some((w) => /forked from the local orphan-upstream/.test(w)), JSON.stringify(made.warnings));
    });

    await check("base HEAD, a remote-tracking base and the default are unchanged", async () => {
      git(repo, ["reset", "-q", "--hard", localMain]);
      const fromHead = await create({ branch: "fix/head", base: "HEAD" });
      assert.equal(headOf(fromHead), localMain);
      assert.equal(fromHead.baseRef, "HEAD");
      assert.equal(fromHead.fetch, "skipped");
      remoteMain = pushMain(1);
      const fromRemote = await create({ branch: "fix/remote", base: "origin/main" });
      assert.equal(headOf(fromRemote), remoteMain);
      assert.equal(fromRemote.baseRef, "origin/main");
      assert.equal(fromRemote.baseBehindRemote, undefined);
      remoteMain = pushMain(1);
      const fromDefault = await create({ branch: "fix/default" });
      assert.equal(headOf(fromDefault), remoteMain);
      assert.equal(fromDefault.base, "origin/main");
      assert.equal(fromDefault.baseRef, "origin/main");
    });

    await check("a base is classified by the ref git resolves it to", async () => {
      remoteMain = pushMain(1);
      const full = await create({ branch: "fix/full-name", base: "refs/heads/main" });
      assert.equal(headOf(full), remoteMain, "refs/heads/main is the local main, so origin/main is fetched");
      assert.equal(full.baseRef, "origin/main");
      assert.equal(full.base, "refs/heads/main");
      remoteMain = pushMain(1);
      const short = await create({ branch: "fix/heads-name", base: "heads/main" });
      assert.equal(headOf(short), remoteMain, "heads/main is the local main too");
      assert.equal(short.baseRef, "origin/main");

      git(repo, ["branch", "-q", "origin/local-base", localMain]);
      git(repo, ["branch", "-q", "--set-upstream-to", "refs/remotes/origin/main", "origin/local-base"]);
      remoteMain = pushMain(1);
      const named = await create({ branch: "fix/remote-like-name", base: "origin/local-base" });
      assert.equal(headOf(named), remoteMain, "a local branch named like a remote one follows its upstream");
      assert.equal(named.baseRef, "origin/main");
      assert.equal(named.fetch, "ok");

      git(repo, ["fetch", "-q", "origin"]);
      assert.notEqual(git(repo, ["rev-parse", "main"]), git(repo, ["rev-parse", "origin/main"]));
      const fromAt = await create({ branch: "fix/at", base: "@" });
      assert.equal(headOf(fromAt), localMain, "@ is HEAD's commit, never its branch's remote");
      assert.equal(fromAt.fetch, "skipped");

      const tagged = git(repo, ["rev-parse", "origin/main~1"]);
      git(repo, ["tag", "main", tagged]);
      try {
        const fromTag = await create({ branch: "fix/tag-main", base: "main" });
        assert.equal(headOf(fromTag), tagged, "git picks the tag main, and so does the worktree");
        assert.equal(fromTag.baseRef, "main");
        assert.equal(fromTag.fetch, "skipped");
      } finally {
        git(repo, ["tag", "-d", "main"]);
      }
    });

    await check("a remote-tracking base is fetched however it is spelled", async () => {
      for (const [name, spelled] of [["fix/remotes-name", "remotes/origin/main"], ["fix/full-remote", "refs/remotes/origin/main"]]) {
        remoteMain = pushMain(1);
        const made = await create({ branch: name, base: spelled });
        assert.equal(headOf(made), remoteMain, spelled);
        assert.equal(made.baseRef, "origin/main");
        assert.equal(made.fetch, "ok");
        assert.equal(h.state.workspaces.find((workspace) => workspace.id === made.workspaceId).copyBranch.baseBranch, "origin/main");
      }
    });

    await check("an upstream deleted on the remote, not pruned here, leaves the local branch", async () => {
      git(other, ["push", "-q", "origin", "main:refs/heads/short-lived"]);
      git(repo, ["fetch", "-q", "origin"]);
      git(repo, ["branch", "-q", "--track", "short-lived", "origin/short-lived"]);
      git(repo, ["branch", "-q", "-f", "short-lived", localMain]);
      git(repo, ["branch", "-q", "--set-upstream-to", "origin/short-lived", "short-lived"]);
      git(other, ["push", "-q", "origin", "--delete", "short-lived"]);
      const made = await create({ branch: "fix/gone-upstream", base: "short-lived" });
      assert.equal(headOf(made), localMain, "the stale origin/short-lived is not used");
      assert.equal(made.baseRef, "short-lived");
      assert.ok(made.warnings.some((w) => /origin no longer has the branch short-lived/.test(w)), JSON.stringify(made.warnings));
    });

    await check("an upstream kept outside refs/remotes is still fetched", async () => {
      git(repo, ["remote", "add", "vendor", origin]);
      git(repo, ["config", "--replace-all", "remote.vendor.fetch", "+refs/heads/*:refs/vendor/*"]);
      git(repo, ["fetch", "-q", "vendor"]);
      git(repo, ["branch", "-q", "vend", localMain]);
      git(repo, ["config", "branch.vend.remote", "vendor"]);
      git(repo, ["config", "branch.vend.merge", "refs/heads/main"]);
      remoteMain = pushMain(1);
      const made = await create({ branch: "fix/vendor", base: "vend" });
      assert.equal(headOf(made), remoteMain);
      assert.equal(made.baseRef, "vendor/main");
      assert.equal(made.fetch, "ok");

      // Even a refspec that writes into refs/heads/ is a remote's branch.
      git(repo, ["config", "--replace-all", "remote.vendor.fetch", "+refs/heads/*:refs/heads/mirror/*"]);
      git(repo, ["fetch", "-q", "vendor"]);
      git(repo, ["branch", "-q", "mirrored", localMain]);
      git(repo, ["config", "branch.mirrored.remote", "vendor"]);
      git(repo, ["config", "branch.mirrored.merge", "refs/heads/main"]);
      remoteMain = pushMain(1);
      const mirrored = await create({ branch: "fix/mirrored", base: "mirrored" });
      assert.equal(headOf(mirrored), remoteMain);
      assert.equal(mirrored.baseRef, "mirror/main");
      assert.equal(mirrored.fetch, "ok");
    });

    await check("checkout:true is unchanged", async () => {
      git(repo, ["branch", "-q", "feat/existing", localMain]);
      const made = await create({ branch: "feat/existing", checkout: true });
      assert.equal(headOf(made), localMain);
      assert.equal(made.baseRef, undefined);
      assert.equal(made.baseCommit, undefined);
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(outFile, { force: true });
    fs.rmSync(reviewOut, { force: true });
  }
  console.log(`agent-worktree-base: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
