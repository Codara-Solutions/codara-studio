// Differential test for the merge proofs of codara_worktree_remove
// (src/main/agent-worktrees.ts). Every scenario runs in its own throwaway
// repository against this checkout's code, and its verdict is compared with
// what the code before the proof through another branch name's pull request
// decided (the MAIN column, recorded by running this same file against that
// commit with RECORD=1).
//
// Invariant: a worktree removable here is removable on main, or it is
// removed through the new proof (a merged pull request whose head is exactly
// the tip, landed in a commit the remote gave in this check).
//
//   node scripts/test-agent-worktree-differential.cjs
//   RECORD=1 node scripts/test-agent-worktree-differential.cjs   # print verdicts
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Recorded on main at fa1d2fbb (see the file header): per scenario, per
// attempt until one removes it, whether the worktree was removed.
const MAIN = {
  "goal shape": [false],
  "goal shape, no upstream": [false],
  "commit after the merged head": [false],
  "pull request without merge commit": [false],
  "fork's pull request": [false],
  "pull request of an earlier head": [false],
  "gh failing": [false],
  "merge commit not in the target": [false],
  "merged into release, named": [true],
  "pushed copy named as target": [true],
  "local base suffix equals pushed copy": [true],
  "local branch holds a dropped merge": [false],
  "refspec excludes target, rewrite after merge": [false],
  "refspec excludes target, stale ref at squash": [true],
  "refspec excludes target, online then offline": [true],
  "origin/HEAD behind the squash": [false],
  "force-pushed target, online then offline": [false, false],
  "origin/HEAD names the worktree's branch": [false],
  "HEAD names the worktree's branch": [false],
  "goal shape offline": [false],
  "fast-forward merged, offline": [true],
};

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commitFile = (cwd, name, content, message) => {
  fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
  fs.writeFileSync(path.join(cwd, name), content);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
};

async function main() {
  const esbuild = require("esbuild");
  const cacheDir = path.join(__dirname, "..", "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outFile = path.join(cacheDir, `spark-agent-worktree-differential-${process.pid}.cjs`);
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

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-wt-differential-")));
  const home = path.join(scratch, "home");
  fs.mkdirSync(home, { recursive: true });
  const gitConfig = path.join(scratch, "gitconfig");
  fs.writeFileSync(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.HOME = home;
  const caller = { role: "studio", client: "claude-code", paneId: "pane-1" };

  // One repository and app state per scenario.
  let count = 0;
  const environment = () => {
    count += 1;
    const origin = path.join(scratch, `origin-${count}.git`);
    const repo = path.join(scratch, `repo-${count}`);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    commitFile(repo, ".gitignore", "node_modules/\n", "ignore");
    commitFile(repo, "README.md", "# test\n", "init");
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);
    let ids = 0;
    const h = {
      state: { workspaces: [{ id: "ws-repo", name: "repo", cwd: repo, color: "#123456", workers: [] }], workspaceRailOrder: ["ws-repo"], activeWorkspaceId: "ws-repo" },
      pulls: [],
      commitPulls: [],
      pullsError: null,
    };
    const lookup = (list) => async () => {
      if (h.pullsError) throw h.pullsError;
      return list();
    };
    const deps = {
      loadState: async () => structuredClone(h.state),
      updateState: async (mutator) => (h.state = await mutator(structuredClone(h.state))),
      loadPreferences: async () => ({ agentWorktreesEnabled: true, agentWorktreeRegenerableIgnoredByRepo: {} }),
      publishState: () => {},
      invalidateGitCache: () => {},
      getRun: async () => null,
      listRuns: async () => [],
      paneWorkspaceId: async () => "ws-repo",
      sessionCwd: () => null,
      sessionsUnderCwd: () => [],
      listRendererTerminals: async () => [],
      workspaceHeld: async () => false,
      processesUnderCwd: async () => [],
      github: {
        listPullRequestsForHead: lookup(() => h.pulls),
        listMergedPullRequests: lookup(() => h.pulls),
        listPullRequestsForCommit: lookup(() => h.commitPulls),
      },
      sendAgentEvent: () => {},
      audit: async () => {},
      worktreesRoot: (repoCwd) => path.join(home, "worktrees", path.basename(repoCwd)),
      now: () => new Date("2026-11-14T10:00:00Z"),
      randomId: () => (++ids).toString(16).padStart(8, "a"),
    };
    const offline = () => git(repo, ["remote", "set-url", "origin", path.join(scratch, "unreachable.git")]);
    return { origin, repo, h, deps, offline };
  };

  // The agent's branch pushed as feat/<name> (its upstream unless told
  // otherwise), squash-merged into `into` by a pull request, and that
  // branch then moved on rewriting the same file unless told otherwise.
  const shape = async (env, { name = "x", into = "main", upstream = true, moveOn = true, deleteHead = true } = {}) => {
    const { repo } = env;
    const remoteBranch = `feat/${name}`;
    git(repo, ["push", "-q", "origin", `main:refs/heads/${remoteBranch}`]);
    git(repo, ["fetch", "-q", "origin"]);
    const made = await aw.createAgentWorktree(caller, { branch: `fix/${name}`, base: `origin/${remoteBranch}` }, env.deps);
    assert.equal(made.ok, true, JSON.stringify(made));
    if (upstream) git(made.path, ["branch", "-q", "--set-upstream-to", `origin/${remoteBranch}`]);
    commitFile(made.path, `${name}.txt`, "first\n", "work");
    const head = commitFile(made.path, `${name}.txt`, "first\nsecond\n", "more work");
    git(made.path, ["push", "-q", "origin", `HEAD:${remoteBranch}`]);
    if (into !== "main") git(repo, ["push", "-q", "origin", `main:refs/heads/${into}`]);
    git(repo, ["checkout", "-q", "-B", `land-${into}`, into === "main" ? "main" : `origin/main`]);
    git(repo, ["merge", "-q", "--squash", `fix/${name}`]);
    git(repo, ["commit", "-q", "-m", `squash ${remoteBranch}`]);
    const squash = git(repo, ["rev-parse", "HEAD"]);
    if (moveOn) commitFile(repo, `${name}.txt`, "rewritten\n", "moves on");
    git(repo, ["push", "-q", "origin", `HEAD:refs/heads/${into}`]);
    git(repo, ["checkout", "-q", "main"]);
    if (into === "main") git(repo, ["merge", "-q", "--ff-only", "land-main"]);
    git(repo, ["branch", "-q", "-D", `land-${into}`]);
    if (deleteHead) git(repo, ["push", "-q", "origin", "--delete", remoteBranch]);
    git(repo, ["fetch", "-q", "--prune", "origin"]);
    const pr = { number: 7, url: "https://github.com/o/r/pull/7", headRefName: remoteBranch, headRefOid: head, baseRefName: into, isCrossRepository: false, mergeCommitOid: squash };
    env.h.pulls = [pr];
    return { made, head, squash, pr };
  };
  // An agent worktree with one unmerged commit.
  const unmerged = async (env, name, base) => {
    const made = await aw.createAgentWorktree(caller, { branch: `fix/${name}`, ...(base ? { base } : {}) }, env.deps);
    assert.equal(made.ok, true, JSON.stringify(made));
    const head = commitFile(made.path, `${name}.txt`, "unmerged\n", "unmerged work");
    return { made, head };
  };
  const narrowRefspec = (env) => git(env.repo, ["config", "--replace-all", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"]);
  // The remote drops the merge on `branch` (force-push back to before it);
  // the local tracking ref keeps the old commit.
  const dropMerge = (env, branch, to, staleAt) => {
    git(env.repo, ["push", "-q", "-f", "origin", `${to}:refs/heads/${branch}`]);
    git(env.repo, ["update-ref", `refs/remotes/origin/${branch}`, staleAt]);
  };

  // Each scenario returns its worktree, the target to name, and steps to
  // run between attempts (one attempt per entry of MAIN).
  const scenarios = {
    "goal shape": async (env) => ({ ...(await shape(env)) }),
    "goal shape, no upstream": async (env) => {
      const s = await shape(env, { upstream: false });
      env.h.commitPulls = env.h.pulls;
      env.h.pulls = [];
      return s;
    },
    "commit after the merged head": async (env) => {
      const s = await shape(env);
      commitFile(s.made.path, "late.txt", "late\n", "after the merge");
      return s;
    },
    "pull request without merge commit": async (env) => {
      const s = await shape(env);
      env.h.pulls = [{ ...s.pr, mergeCommitOid: null }];
      return s;
    },
    "fork's pull request": async (env) => {
      const s = await shape(env);
      env.h.pulls = [{ ...s.pr, isCrossRepository: true }];
      env.h.commitPulls = env.h.pulls;
      return s;
    },
    "pull request of an earlier head": async (env) => {
      const s = await shape(env);
      env.h.pulls = [{ ...s.pr, headRefOid: git(s.made.path, ["rev-parse", "HEAD~1"]) }];
      return s;
    },
    "gh failing": async (env) => {
      const s = await shape(env);
      env.h.pullsError = new Error("gh: API rate limit exceeded");
      return s;
    },
    "merge commit not in the target": async (env) => {
      const s = await shape(env, { into: "release" });
      env.h.pulls = [{ ...s.pr, baseRefName: "main" }];
      return s;
    },
    "merged into release, named": async (env) => ({ ...(await shape(env, { into: "release", moveOn: false })), target: "release" }),
    "pushed copy named as target": async (env) => {
      const s = await unmerged(env, "copy");
      git(s.made.path, ["push", "-q", "-u", "origin", "HEAD:feat/copy"]);
      return { ...s, target: "feat/copy" };
    },
    "local base suffix equals pushed copy": async (env) => {
      git(env.repo, ["branch", "-q", "feature/base", "main"]);
      const s = await unmerged(env, "suffix", "feature/base");
      git(s.made.path, ["push", "-q", "-u", "origin", "HEAD:base"]);
      return { ...s, target: "base" };
    },
    "local branch holds a dropped merge": async (env) => {
      const s = await shape(env, { into: "release" });
      const tip = git(env.repo, ["rev-parse", "origin/release"]);
      git(env.repo, ["branch", "-q", "release-local", tip]);
      dropMerge(env, "release", `${s.squash}~1`, tip);
      return { ...s, target: "release-local" };
    },
    "refspec excludes target, rewrite after merge": async (env) => {
      const s = await shape(env, { into: "release" });
      dropMerge(env, "release", `${s.squash}~1`, git(env.repo, ["rev-parse", "origin/release"]));
      narrowRefspec(env);
      return { ...s, target: "origin/release" };
    },
    "refspec excludes target, stale ref at squash": async (env) => {
      const s = await shape(env, { into: "release", moveOn: false });
      dropMerge(env, "release", `${s.squash}~1`, s.squash);
      narrowRefspec(env);
      return { ...s, target: "origin/release" };
    },
    // Offline, the target's last known commit is judged as on main.
    "refspec excludes target, online then offline": async (env) => {
      const s = await shape(env, { into: "release", moveOn: false });
      dropMerge(env, "release", `${s.squash}~1`, s.squash);
      narrowRefspec(env);
      return { ...s, target: "origin/release", between: [env.offline] };
    },
    "origin/HEAD behind the squash": async (env) => {
      const s = await shape(env);
      dropMerge(env, "main", `${s.squash}~1`, git(env.repo, ["rev-parse", "main"]));
      return { ...s, target: "origin/HEAD" };
    },
    "force-pushed target, online then offline": async (env) => {
      const s = await shape(env, { into: "release", moveOn: false });
      dropMerge(env, "release", `${s.squash}~1`, s.squash);
      return { ...s, target: "origin/release", between: [env.offline] };
    },
    "origin/HEAD names the worktree's branch": async (env) => {
      const s = await unmerged(env, "topic");
      git(s.made.path, ["push", "-q", "origin", "HEAD:fix/topic"]);
      git(env.origin, ["symbolic-ref", "HEAD", "refs/heads/fix/topic"]);
      return { ...s, target: "origin/HEAD" };
    },
    "HEAD names the worktree's branch": async (env) => {
      const s = await unmerged(env, "topic");
      git(s.made.path, ["push", "-q", "origin", "HEAD:fix/topic"]);
      git(env.origin, ["symbolic-ref", "HEAD", "refs/heads/fix/topic"]);
      return { ...s, target: "HEAD" };
    },
    "goal shape offline": async (env) => {
      const s = await shape(env);
      env.offline();
      return s;
    },
    "fast-forward merged, offline": async (env) => {
      const s = await unmerged(env, "ff");
      git(env.repo, ["merge", "-q", "--ff-only", "fix/ff"]);
      git(env.repo, ["push", "-q", "origin", "main"]);
      env.offline();
      return s;
    },
  };
  assert.deepEqual(Object.keys(scenarios).sort(), Object.keys(MAIN).sort(), "every scenario has a recorded main verdict");

  const recorded = {};
  const failures = [];
  try {
    for (const [name, build] of Object.entries(scenarios)) {
      const env = environment();
      const s = await build(env);
      const tip = git(s.made.path, ["rev-parse", "HEAD"]);
      const attempts = [];
      for (let attempt = 0; attempt < 1 + (s.between ? 1 : 0); attempt += 1) {
        if (attempt > 0) for (const step of s.between ?? []) step();
        const input = { workspaceId: s.made.workspaceId, ...(s.target ? { target: s.target } : {}) };
        const dry = await aw.removeAgentWorktree(caller, { ...input, dryRun: true }, env.deps);
        const result = dry.wouldRemove ? await aw.removeAgentWorktree(caller, input, env.deps) : dry;
        const removed = result.ok === true && result.removed === true;
        const branchLeft = (() => {
          try {
            return git(env.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${s.made.branch}`]);
          } catch {
            return null;
          }
        })();
        attempts.push({ removed, proof: dry.merge?.proof ?? null, headProof: Boolean(dry.details?.headProof), branchLeft, blockers: dry.blockers });
        if (removed) break;
      }
      recorded[name] = attempts.map((entry) => entry.removed);
      if (process.env.RECORD) continue;
      attempts.forEach((entry, index) => {
        // Main removed it at this attempt or an earlier one.
        const mainRemoved = MAIN[name].slice(0, index + 1).some(Boolean);
        const ok = !entry.removed || mainRemoved || (entry.proof === "pull-request" && entry.headProof);
        if (!ok) failures.push(`${name} (attempt ${index + 1}): removed with proof ${entry.proof}, main kept it`);
        if (!entry.removed && entry.branchLeft !== tip) failures.push(`${name} (attempt ${index + 1}): kept, but its branch is not at its tip`);
      });
      const removedHere = attempts.some((entry) => entry.removed);
      console.log(`  ${removedHere ? "removed" : "kept   "}  main ${MAIN[name].some(Boolean) ? "removed" : "kept   "}  ${name}`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(outFile, { force: true });
  }
  if (process.env.RECORD) {
    console.log(JSON.stringify(recorded, null, 2));
    return;
  }
  assert.deepEqual(failures, []);
  // What this change is for, and the refusals review asked to pin.
  const expect = (name, removed) => assert.equal(recorded[name].some(Boolean), removed, name);
  expect("goal shape", true);
  expect("goal shape, no upstream", true);
  for (const name of [
    "pushed copy named as target",
    "local base suffix equals pushed copy",
    "refspec excludes target, stale ref at squash",
    "origin/HEAD behind the squash",
    "force-pushed target, online then offline",
    "origin/HEAD names the worktree's branch",
    "HEAD names the worktree's branch",
    "goal shape offline",
  ]) {
    expect(name, false);
  }
  console.log(`agent-worktree-differential: ${Object.keys(scenarios).length} scenarios, none removable here that main keeps except through the new proof`);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
