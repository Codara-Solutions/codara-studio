// An agent cleans up after itself: codara_worktree_remove removes a worktree
// the asking agent made and gave up (its last pull request closed without
// merging, the remote branch holding the exact tip, the tree clean and
// idle), with no dialog, keeping the branch and a recovery ref. Anything
// else stays the user's call: another agent's worktree, a dirty tree, a
// commit that exists only here, an open pull request, a deleted remote
// branch, an old closed pull request of a reused name, a GitHub that cannot
// be asked, or any of these changing while the removal waits for the lock.
// origin's URL is a GitHub one that git rewrites to a local bare repository,
// so GitHub is never contacted.
//
//   node scripts/test-agent-worktree-given-up.cjs
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFile(cwd, name, content, message) {
  fs.writeFileSync(path.join(cwd, name), content);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

async function main() {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outFile = path.join(cacheDir, `spark-agent-worktree-given-up-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "agent-worktrees.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    external: ["electron", "ssh2", "cpu-features"],
    logLevel: "silent",
  });
  const aw = require(outFile);

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-agent-wt-given-up-")));
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
    commitFile(repo, "README.md", "# test\n", "init");
    const GITHUB_URL = "https://github.com/acme/widgets.git";
    git(repo, ["config", `url.${origin}.insteadOf`, GITHUB_URL]);
    git(repo, ["remote", "add", "origin", GITHUB_URL]);
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
      paneWorkspace: { "pane-maker": "ws-repo", "pane-other": "ws-repo" },
      // The repository each lookup named.
      asked: [],
      // GitHub's pull requests by head branch, any state.
      headPulls: new Map(),
      headPullsError: null,
      events: [],
    };
    const deps = {
      loadState: async () => structuredClone(h.state),
      updateState: async (mutator) => {
        h.state = await mutator(structuredClone(h.state));
        return h.state;
      },
      loadPreferences: async () => h.prefs,
      publishState: () => undefined,
      invalidateGitCache: () => undefined,
      getRun: async () => null,
      listRuns: async () => [],
      paneWorkspaceId: async (paneId) => h.paneWorkspace[paneId] ?? null,
      // No tab is open: the maker's own tab is the caller's, judged as such.
      sessionCwd: () => null,
      sessionsUnderCwd: () => [],
      listRendererTerminals: async () => [],
      workspaceHeld: async () => false,
      processesUnderCwd: async () => [],
      github: {
        listPullRequestsForHead: async () => [],
        listMergedPullRequests: async () => [],
        listPullRequestsForCommit: async () => [],
        listPullRequestStatesForHead: async (_cwd, branch, repository) => {
          h.asked.push(repository);
          if (h.headPullsError) throw h.headPullsError;
          return h.headPulls.get(branch) ?? [];
        },
      },
      sendAgentEvent: (event) => h.events.push(event),
      audit: aw.createWorktreeAuditLog(path.join(home, "logs", "worktree-audit.jsonl")),
      worktreesRoot: (repoCwd) => path.join(home, "worktrees", path.basename(repoCwd)),
      now: () => new Date("2026-11-18T10:00:00Z"),
      randomId: () => (++ids).toString(16).padStart(8, "a"),
    };
    const maker = { role: "studio", client: "claude-code", paneId: "pane-maker" };
    const otherAgent = { role: "studio", client: "codex", paneId: "pane-other" };
    const pull = (number, branch, tip, state) => ({
      number,
      url: `https://example.invalid/pull/${number}`,
      headRefName: branch,
      headRefOid: tip,
      baseRefName: "main",
      isCrossRepository: false,
      state,
    });

    // A worktree the maker made, with work pushed and its pull request closed.
    const givenUp = async (branch, { push = true, closed = true } = {}) => {
      const made = await aw.createAgentWorktree(maker, { branch }, deps);
      assert.equal(made.ok, true, JSON.stringify(made));
      const tip = commitFile(made.path, `${branch.replace(/\W/g, "-")}.txt`, "work\n", `work on ${branch}`);
      if (push) git(made.path, ["push", "-q", "-u", "origin", branch]);
      if (closed) h.headPulls.set(branch, [pull(40 + ids, branch, tip, "closed")]);
      return { ...made, tip };
    };

    await check("the maker removes its own given-up worktree with no dialog, keeping the branch and a recovery ref", async () => {
      const wt = await givenUp("agent/abandoned");
      const dry = await aw.removeAgentWorktree(maker, { workspaceId: wt.workspaceId, dryRun: true }, deps);
      assert.equal(dry.wouldRemove, true, JSON.stringify(dry));
      assert.equal(dry.merge.givenUp.remoteBranch, "origin/agent/abandoned");
      const result = await aw.removeAgentWorktree(maker, { workspaceId: wt.workspaceId }, deps);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.removed, true);
      assert.equal(fs.existsSync(wt.path), false, "the folder is gone");
      assert.equal(result.givenUp.closedPullRequest.number, h.headPulls.get("agent/abandoned")[0].number);
      assert.equal(result.branchDeleted, false);
      assert.equal(result.branchKeptReason, "NOT_MERGED");
      assert.equal(git(repo, ["rev-parse", "refs/heads/agent/abandoned"]), wt.tip, "the local branch stays");
      assert.equal(git(origin, ["rev-parse", "refs/heads/agent/abandoned"]), wt.tip, "the remote branch stays");
      assert.equal(git(repo, ["rev-parse", result.recoveryRef]), wt.tip, "a recovery ref holds the tip");
      assert.equal(h.state.workspaces.some((workspace) => workspace.id === wt.workspaceId), false, "its rail row is gone");
      assert.equal(h.events.at(-1).kind, "removed");
      assert.equal(h.events.at(-1).pullRequest, undefined, "a closed pull request is not reported as merged");
      assert.equal(h.asked.at(-1), "github.com/acme/widgets", "GitHub is asked about origin's repository by name");
      const audit = fs
        .readFileSync(path.join(home, "logs", "worktree-audit.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((line) => line.workspaceId === wt.workspaceId && line.outcome === "removed");
      assert.equal(audit.length, 1);
      assert.equal(audit[0].proof, null);
      assert.deepEqual(audit[0].givenUp, { pr: result.givenUp.closedPullRequest.number, remoteCommit: wt.tip }, "the audit names why no dialog was needed");
    });

    await check("an origin that is not on GitHub keeps it", async () => {
      const wt = await givenUp("agent/not-github");
      git(repo, ["remote", "set-url", "origin", origin]);
      try {
        assert.equal((await aw.removeAgentWorktree(maker, { workspaceId: wt.workspaceId }, deps)).code, "WORKTREE_NOT_MERGED");
      } finally {
        git(repo, ["remote", "set-url", "origin", GITHUB_URL]);
      }
      assert.ok(fs.existsSync(wt.path));
    });

    await check("an old closed pull request of a reused branch name does not count", async () => {
      const wt = await givenUp("agent/reused");
      // The name is reused for new work: the old pull request's head is not in it.
      git(wt.path, ["reset", "-q", "--hard", "HEAD~1"]);
      commitFile(wt.path, "fresh.txt", "fresh\n", "new work under the old name");
      git(wt.path, ["push", "-q", "-f", "origin", "agent/reused"]);
      assert.equal((await aw.removeAgentWorktree(maker, { workspaceId: wt.workspaceId }, deps)).code, "WORKTREE_NOT_MERGED");
      assert.ok(fs.existsSync(wt.path));
    });

    await check("another agent's given-up worktree still needs the user", async () => {
      const wt = await givenUp("agent/not-yours");
      const refused = await aw.removeAgentWorktree(otherAgent, { workspaceId: wt.workspaceId }, deps);
      assert.equal(refused.ok, false);
      assert.equal(refused.code, "WORKTREE_NOT_MERGED", JSON.stringify(refused));
      assert.ok(fs.existsSync(wt.path));
    });

    await check("a dirty tree stays, also for its maker", async () => {
      const wt = await givenUp("agent/dirty");
      fs.writeFileSync(path.join(wt.path, "draft.txt"), "unsaved\n");
      const refused = await aw.removeAgentWorktree(maker, { workspaceId: wt.workspaceId }, deps);
      assert.equal(refused.ok, false);
      assert.ok(refused.blockers.includes("WORKTREE_DIRTY"), JSON.stringify(refused));
      assert.ok(fs.existsSync(path.join(wt.path, "draft.txt")));
    });

    await check("a commit that is only local stays, also for its maker", async () => {
      const wt = await givenUp("agent/unpushed");
      commitFile(wt.path, "later.txt", "later\n", "not pushed");
      const refused = await aw.removeAgentWorktree(maker, { workspaceId: wt.workspaceId }, deps);
      assert.equal(refused.code, "WORKTREE_NOT_MERGED", JSON.stringify(refused));
      assert.ok(fs.existsSync(wt.path));
      const never = await givenUp("agent/never-pushed", { push: false });
      assert.equal((await aw.removeAgentWorktree(maker, { workspaceId: never.workspaceId }, deps)).code, "WORKTREE_NOT_MERGED");
      assert.ok(fs.existsSync(never.path));
    });

    await check("an open pull request, or none closed, keeps it", async () => {
      const reopened = await givenUp("agent/reopened");
      h.headPulls.get("agent/reopened").push(pull(90, "agent/reopened", reopened.tip, "open"));
      assert.equal((await aw.removeAgentWorktree(maker, { workspaceId: reopened.workspaceId }, deps)).code, "WORKTREE_NOT_MERGED");
      assert.ok(fs.existsSync(reopened.path));
      const none = await givenUp("agent/no-pull", { closed: false });
      assert.equal((await aw.removeAgentWorktree(maker, { workspaceId: none.workspaceId }, deps)).code, "WORKTREE_NOT_MERGED");
      assert.ok(fs.existsSync(none.path));
      // From a fork: not this repository's pull request.
      const fork = await givenUp("agent/fork");
      h.headPulls.set("agent/fork", [{ ...pull(91, "agent/fork", fork.tip, "closed"), isCrossRepository: true }]);
      assert.equal((await aw.removeAgentWorktree(maker, { workspaceId: fork.workspaceId }, deps)).code, "WORKTREE_NOT_MERGED");
      assert.ok(fs.existsSync(fork.path));
    });

    await check("a remote branch deleted since, or moved off the tip, keeps it", async () => {
      const gone = await givenUp("agent/gone");
      git(origin, ["update-ref", "-d", "refs/heads/agent/gone"]);
      assert.equal((await aw.removeAgentWorktree(maker, { workspaceId: gone.workspaceId }, deps)).code, "WORKTREE_NOT_MERGED");
      assert.ok(fs.existsSync(gone.path), "the tracking ref alone proves nothing");
      const forced = await givenUp("agent/forced");
      git(origin, ["update-ref", "refs/heads/agent/forced", git(repo, ["rev-parse", "main"])]);
      assert.equal((await aw.removeAgentWorktree(maker, { workspaceId: forced.workspaceId }, deps)).code, "WORKTREE_NOT_MERGED");
      assert.ok(fs.existsSync(forced.path));
    });

    await check("GitHub that cannot be asked keeps it", async () => {
      const wt = await givenUp("agent/offline");
      h.headPullsError = new Error("gh: not logged in");
      try {
        assert.equal((await aw.removeAgentWorktree(maker, { workspaceId: wt.workspaceId }, deps)).code, "WORKTREE_NOT_MERGED");
      } finally {
        h.headPullsError = null;
      }
      assert.ok(fs.existsSync(wt.path));
    });

    await check("a pull request reopened, or a push, while the removal waits keeps it", async () => {
      const reopened = await givenUp("agent/reopened-late");
      deps.afterVerify = async () => {
        h.headPulls.get("agent/reopened-late")[0].state = "open";
      };
      try {
        const refused = await aw.removeAgentWorktree(maker, { workspaceId: reopened.workspaceId }, deps);
        assert.equal(refused.code, "WORKTREE_CHANGED", JSON.stringify(refused));
      } finally {
        delete deps.afterVerify;
      }
      assert.ok(fs.existsSync(reopened.path));
      const pushed = await givenUp("agent/pushed-late");
      deps.afterVerify = async () => {
        // Someone else pushes on top: the tip is still in it, but the branch moved.
        const tree = git(repo, ["rev-parse", `${pushed.tip}^{tree}`]);
        const child = execFileSync("git", ["-C", repo, "commit-tree", tree, "-p", pushed.tip, "-m", "pushed elsewhere"], { encoding: "utf8" }).trim();
        git(repo, ["push", "-q", "origin", `${child}:refs/heads/agent/pushed-late`]);
      };
      try {
        const refused = await aw.removeAgentWorktree(maker, { workspaceId: pushed.workspaceId }, deps);
        assert.equal(refused.code, "WORKTREE_CHANGED", JSON.stringify(refused));
      } finally {
        delete deps.afterVerify;
      }
      assert.ok(fs.existsSync(pushed.path));
    });

    await check("a commit made between the check and the removal keeps it", async () => {
      const wt = await givenUp("agent/raced");
      deps.afterVerify = async () => {
        commitFile(wt.path, "race.txt", "race\n", "landed during the removal");
      };
      try {
        const refused = await aw.removeAgentWorktree(maker, { workspaceId: wt.workspaceId }, deps);
        assert.equal(refused.ok, false, JSON.stringify(refused));
        assert.equal(refused.code, "WORKTREE_CHANGED");
      } finally {
        delete deps.afterVerify;
      }
      assert.ok(fs.existsSync(path.join(wt.path, "race.txt")));
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(outFile, { force: true });
  }
  console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
