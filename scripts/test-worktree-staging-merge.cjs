// A pull request merged into a long-lived branch other than the default
// (staging) proves a worktree merged, but only for a tip that is exactly its
// head, only while that branch on the remote still holds the merge, and the
// removal asks the remote again right before deleting the folder
// (src/main/worktree-cleanup/inspect.ts mergeFacts and
// longLivedTargetRefusal, merged-pull-request-stack.ts, remove.ts).
// Throwaway repositories with a bare remote, in the system temp folder.
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
  fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
  fs.writeFileSync(path.join(cwd, name), content);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

const outputs = [];
async function bundle(entry, name) {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `spark-staging-merge-${name}-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    external: ["electron", "ssh2", "cpu-features"],
    logLevel: "silent",
  });
  outputs.push(outfile);
  return require(outfile);
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

async function main() {
  const [inspect, removeMod, agent] = await Promise.all([
    bundle("src/main/worktree-cleanup/inspect.ts", "inspect"),
    bundle("src/main/worktree-cleanup/remove.ts", "remove"),
    bundle("src/main/agent-worktrees.ts", "agent"),
  ]);

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-staging-merge-")));
  const home = path.join(scratch, "home");
  fs.mkdirSync(home, { recursive: true });
  const gitConfig = path.join(scratch, "gitconfig");
  fs.writeFileSync(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[protocol \"file\"]\n\tallow = always\n");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.HOME = home;

  try {
    const origin = path.join(scratch, "origin.git");
    const repo = path.join(scratch, "repo");
    const trees = path.join(scratch, "trees");
    fs.mkdirSync(trees);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    commitFile(repo, "readme.md", "docs\n", "docs");
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);
    const main = git(repo, ["rev-parse", "origin/main"]);

    const add = (name, branch) => {
      const dir = path.join(trees, name);
      git(repo, ["worktree", "add", "-q", dir, "-b", branch]);
      return dir;
    };

    const site = add("site", "feat/site");
    const siteFirst = commitFile(site, "page.html", "<p>one</p>\n", "page");
    const siteTip = commitFile(site, "page.html", "<p>two</p>\n", "page two");
    git(site, ["push", "-q", "-u", "origin", "feat/site"]);
    const hub = path.join(scratch, "hub");
    execFileSync("git", ["clone", "-q", origin, hub]);
    git(hub, ["checkout", "-q", "-b", "staging", "origin/main"]);
    git(hub, ["merge", "-q", "--no-ff", "-m", "Merge pull request #21", "origin/feat/site"]);
    const merge21 = git(hub, ["rev-parse", "HEAD"]);
    git(hub, ["push", "-q", "origin", "staging"]);
    git(repo, ["fetch", "-q", "origin"]);
    const rewindStaging = () => git(hub, ["push", "-q", "-f", "origin", `${main}:refs/heads/staging`]);
    const restoreStaging = () => git(hub, ["push", "-q", "-f", "origin", "staging"]);
    const pr21 = {
      number: 21,
      url: "https://example.invalid/pull/21",
      headRefName: "feat/site",
      headRefOid: siteTip,
      baseRefName: "staging",
      isCrossRepository: false,
      mergeCommitOid: merge21,
    };
    const repoContext = (merged) => ({
      root: repo,
      name: "repo",
      registrations: [],
      mainPath: repo,
      workspaces: [],
      base: { name: "origin/main", commit: main },
      tracking: new Map(),
      targets: new Map(),
      pullRequests: { open: [], merged },
    });
    const onMain = { name: "origin/main", commit: main };

    await check("a tip that is the head of a pull request merged into staging reads merged there", async () => {
      const facts = await inspect.mergeFacts(repoContext([pr21]), siteTip, "feat/site", onMain);
      assert.equal(facts.state, "merged", JSON.stringify(facts));
      assert.equal(facts.proof, "pull-request");
      assert.deepEqual(facts.pullRequest, { number: 21, url: pr21.url });
      assert.equal(facts.target, "origin/staging", "judged where it landed");
      assert.equal(facts.targetCommit, merge21);
    });

    await check("a tip with commits past the merged head, or behind it, stays unmerged", async () => {
      const later = commitFile(site, "page.html", "<p>three</p>\n", "after the merge");
      assert.equal((await inspect.mergeFacts(repoContext([pr21]), later, "feat/site", onMain)).state, "unmerged");
      assert.equal((await inspect.mergeFacts(repoContext([pr21]), siteFirst, "feat/site", onMain)).state, "unmerged");
      git(site, ["reset", "-q", "--hard", siteTip]);
    });

    await check("rewound on the remote, or a base that is not long-lived, proves nothing", async () => {
      // Another branch name holding the same merge: not long-lived, not the worktree's base.
      git(hub, ["push", "-q", "origin", "staging:feat/other"]);
      git(repo, ["fetch", "-q", "origin"]);
      const other = { ...pr21, baseRefName: "feat/other" };
      assert.equal((await inspect.mergeFacts(repoContext([other]), siteTip, "feat/site", onMain)).state, "unmerged");
      // GitHub's staging rewound past the merge; the local tracking ref still has it.
      rewindStaging();
      assert.equal(git(repo, ["rev-parse", "origin/staging"]), merge21, "the tracking ref is stale");
      assert.equal((await inspect.mergeFacts(repoContext([pr21]), siteTip, "feat/site", onMain)).state, "unmerged");
      restoreStaging();
      // No merge commit known: nothing to look for.
      assert.equal((await inspect.mergeFacts(repoContext([{ ...pr21, mergeCommitOid: null }]), siteTip, "feat/site", onMain)).state, "unmerged");
      assert.equal((await inspect.mergeFacts(repoContext([pr21]), siteTip, "feat/site", onMain)).state, "merged");
    });

    await check("a worktree based on staging is judged by origin's staging now, never its stale tracking ref", async () => {
      const onStaging = { name: "origin/staging", commit: git(repo, ["rev-parse", "origin/staging"]) };
      assert.equal((await inspect.mergeFacts(repoContext([pr21]), siteTip, "feat/site", onStaging)).state, "merged");
      const behind = await inspect.mergeFacts(repoContext([pr21]), siteFirst, "feat/site", onStaging);
      assert.equal(behind.state, "merged", "an ancestor of staging as origin has it is merged");
      rewindStaging();
      assert.equal((await inspect.mergeFacts(repoContext([pr21]), siteTip, "feat/site", onStaging)).state, "unmerged");
      assert.equal((await inspect.mergeFacts(repoContext([pr21]), siteFirst, "feat/site", onStaging)).state, "unmerged");
      restoreStaging();
    });

    await check("right before deletion, origin's staging must still hold the commit the proof named", async () => {
      const onStaging = { name: "origin/staging", commit: git(repo, ["rev-parse", "origin/staging"]) };
      const facts = await inspect.mergeFacts(repoContext([pr21]), siteTip, "feat/site", onStaging);
      assert.equal(facts.state, "merged");
      const ask = (merge) => inspect.longLivedTargetRefusal(repo, merge, "origin/main");
      assert.equal(await ask(facts), null);
      rewindStaging();
      assert.equal(await ask(facts), "staging on origin no longer holds the merge.", "rewound since the check");
      restoreStaging();
      assert.equal(await ask(facts), null);
      // Judged by the local staging label: origin's staging all the same.
      const local = { state: "merged", proof: "ancestor", target: "staging", targetCommit: facts.targetCommit };
      assert.equal(await ask(local), null);
      assert.match((await ask({ ...local, targetCommit: undefined })) ?? "", /names no commit of origin's/, "no commit to ask about");
      rewindStaging();
      assert.equal(await ask(local), "staging on origin no longer holds the merge.");
      restoreStaging();
      const onMainFacts = { state: "merged", proof: "ancestor", target: "origin/main", targetCommit: main };
      assert.equal(await ask(onMainFacts), null, "the default branch is not asked");
      // Each other reason is said as it is, and keeps the folder all the same.
      const url = git(repo, ["remote", "get-url", "origin"]);
      git(repo, ["remote", "set-url", "origin", path.join(scratch, "no-such-remote.git")]);
      try {
        assert.equal(await ask(facts), "origin did not say where staging is now.");
      } finally {
        git(repo, ["remote", "set-url", "origin", url]);
      }
      const before = git(hub, ["rev-parse", "HEAD"]);
      commitFile(hub, "unfetched.txt", "new\n", "not fetched here");
      git(hub, ["push", "-q", "origin", "staging"]);
      try {
        assert.equal(await ask(facts), "staging on origin has commits not fetched here: fetch, then try again.");
      } finally {
        git(hub, ["reset", "-q", "--hard", before]);
        restoreStaging();
      }
    });

    await check("a squash found in origin's staging names the commit it was found in", async () => {
      const squash = add("squash", "feat/squash");
      const squashTip = commitFile(squash, "squash.txt", "squashed\n", "squash me");
      git(hub, ["fetch", "-q", "origin"]);
      git(hub, ["checkout", "-q", "-B", "staging", "origin/staging"]);
      fs.writeFileSync(path.join(hub, "squash.txt"), "squashed\n");
      git(hub, ["add", "squash.txt"]);
      git(hub, ["commit", "-q", "-m", "Squash (#22)"]);
      git(hub, ["push", "-q", "origin", "staging"]);
      git(repo, ["fetch", "-q", "origin"]);
      const tracked = git(repo, ["rev-parse", "origin/staging"]);
      // origin moves on past what this clone fetched.
      commitFile(hub, "later.txt", "later\n", "later on staging");
      git(hub, ["push", "-q", "origin", "staging"]);
      const live = git(hub, ["rev-parse", "HEAD"]);
      git(repo, ["fetch", "-q", "origin", live]);
      const facts = await inspect.mergeFacts(repoContext([]), squashTip, "feat/squash", { name: "origin/staging", commit: tracked });
      assert.deepEqual([facts.state, facts.proof, facts.targetCommit], ["merged", "content-in-target", live], JSON.stringify(facts));
      rewindStaging();
      assert.match((await inspect.longLivedTargetRefusal(repo, facts, "origin/main")) ?? "", /staging on origin no longer holds the merge/, "rewound past the squash");
      restoreStaging();
      git(repo, ["worktree", "remove", "--force", squash]);
    });

    // ── The removal ────────────────────────────────────────────────────────
    const h = {
      state: {
        workspaces: [{ id: "ws-repo", name: "repo", cwd: repo, color: "#123456", workers: [] }],
        workspaceRailOrder: ["ws-repo"],
        activeWorkspaceId: "ws-repo",
      },
    };
    let beforeMove = async () => null;
    const deps = {
      loadState: async () => structuredClone(h.state),
      updateState: async (mutator) => {
        h.state = await mutator(structuredClone(h.state));
        return h.state;
      },
      publishState: () => {},
      invalidateGitCache: () => {},
      listRuns: async () => [],
      sessionCwd: () => null,
      sessionsUnderCwd: () => [],
      listRendererTerminals: async () => [],
      processesUnderCwds: async (dirs) => new Map(dirs.map((dir) => [dir, []])),
      runningServers: () => 0,
      pullRequests: async () => ({ open: [], merged: [pr21] }),
      regenerableIgnored: async () => [],
      appPaths: () => [path.join(scratch, "app-not-here")],
      isProtectedPath: () => false,
      // Called after the removal's own check and before the folder is moved
      // aside: where a rewind of staging lands between the two.
      mountRefusal: async () => beforeMove(),
      audit: agent.createWorktreeAuditLog(path.join(home, "logs", "worktree-audit.jsonl")),
      now: () => new Date(),
    };
    const checkOf = async (dir) => (await removeMod.checkCleanupTargets(deps, [{ repoRoot: repo, path: dir }]))[0];
    const removeIt = async (dir, fingerprint) =>
      (
        await removeMod.removeCleanupWorktrees(deps, {
          items: [{ repoRoot: repo, path: dir, fingerprint, confirmDirty: false, confirmUnmerged: false }],
          deleteMergedBranches: false,
        })
      ).outcomes[0];

    await check("the full check of a worktree merged through staging names origin's staging commit", async () => {
      const entry = await checkOf(site);
      assert.deepEqual(entry.blockers.map((blocker) => blocker.code), [], JSON.stringify(entry.blockers));
      const live = git(hub, ["rev-parse", "staging"]);
      assert.deepEqual([entry.merge.state, entry.merge.target, entry.merge.targetCommit], ["merged", "origin/staging", live]);
    });

    await check("staging rewound between the check and the deletion puts the folder back", async () => {
      const entry = await checkOf(site);
      beforeMove = async () => {
        rewindStaging();
        return null;
      };
      let outcome;
      try {
        outcome = await removeIt(site, entry.fingerprint);
      } finally {
        beforeMove = async () => null;
        restoreStaging();
      }
      assert.notEqual(outcome.status, "removed", JSON.stringify(outcome));
      assert.equal(outcome.message, "staging on origin no longer holds the merge. So it was put back.", JSON.stringify(outcome));
      assert.equal(fs.readFileSync(path.join(site, "page.html"), "utf8"), "<p>two</p>\n", "the folder is back with its files");
      assert.equal(git(site, ["rev-parse", "HEAD"]), siteTip);
    });

    await check("with staging still holding the merge, the removal goes ahead", async () => {
      const entry = await checkOf(site);
      const outcome = await removeIt(site, entry.fingerprint);
      assert.equal(outcome.status, "removed", JSON.stringify(outcome));
      assert.equal(fs.existsSync(site), false);
    });
    await check("a folder already gone keeps its branch when staging lost the merge right before", async () => {
      const gone = path.join(trees, "site-gone");
      git(repo, ["worktree", "add", "-q", gone, "feat/site"]);
      fs.rmSync(gone, { recursive: true, force: true });
      const entry = await checkOf(gone);
      assert.equal(entry.merge.state, "merged", JSON.stringify(entry.merge));
      let outcome;
      try {
        outcome = (
          await removeMod.removeCleanupWorktrees(
            deps,
            {
              items: [{ repoRoot: repo, path: gone, fingerprint: entry.fingerprint, confirmDirty: false, confirmUnmerged: false }],
              deleteMergedBranches: true,
            },
            // After the last check, before the registration and branch go.
            { beforeRemove: async () => (rewindStaging(), null) },
          )
        ).outcomes[0];
      } finally {
        restoreStaging();
      }
      assert.equal(outcome.status, "already-removed", JSON.stringify(outcome));
      assert.equal(outcome.branchKept, "unmerged", JSON.stringify(outcome));
      assert.equal(git(repo, ["rev-parse", "refs/heads/feat/site"]), siteTip, "the branch stays");
    });
  } finally {
    for (const file of outputs) fs.rmSync(file, { force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
