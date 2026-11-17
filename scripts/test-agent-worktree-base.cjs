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
  }
  console.log(`agent-worktree-base: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
