// Merge proof for worktrees whose pull request was stacked on another one:
// src/main/merged-pull-request-stack.ts, as the agent tools
// (agent-worktrees.ts: codara_worktree_remove) and the cleanup screen and rail
// (worktree-cleanup/inspect.ts: mergeFacts) use it, and the advice the cleanup
// tool gives when the agent that made the worktree still has its tab open.
//
// The shape: feat/roles-api was merged into feat/roles (pull request #454),
// then feat/roles into main (#453), squashed. GitHub then deleted both
// branches. Each worktree tip is an ancestor of its pull request's head (a
// commit was pushed from elsewhere after the worktree's last one), and the
// worktree of feat/roles-api still records feat/roles as its base, which now
// resolves to the stale local branch only. GitHub is stubbed; git is real.
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
  const outfile = path.join(cacheDir, `spark-stacked-merge-${name}-${process.pid}.cjs`);
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
  const [stack, inspect, aw, advice, github] = await Promise.all([
    bundle("src/main/merged-pull-request-stack.ts", "stack"),
    bundle("src/main/worktree-cleanup/inspect.ts", "inspect"),
    bundle("src/main/agent-worktrees.ts", "agent"),
    bundle("src/shared/worktree-cleanup-agent.ts", "advice"),
    bundle("src/main/github-cli.ts", "github"),
  ]);

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-stacked-merge-")));
  const home = path.join(scratch, "home");
  fs.mkdirSync(home, { recursive: true });
  const gitConfig = path.join(scratch, "gitconfig");
  fs.writeFileSync(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.HOME = home;

  try {
    // ── Repositories ───────────────────────────────────────────────────────
    const origin = path.join(scratch, "origin.git");
    const repo = path.join(scratch, "repo");
    const hub = path.join(scratch, "hub"); // where "GitHub" merges
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    commitFile(repo, "README.md", "# test\n", "init");
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);
    const notes = path.join(scratch, "notes");
    fs.mkdirSync(notes);

    // ── Agent-tool harness (as test-agent-worktrees.cjs) ───────────────────
    let ids = 0;
    const h = {
      state: {
        workspaces: [
          { id: "ws-repo", name: "repo", cwd: repo, color: "#123456", workers: [] },
          { id: "ws-notes", name: "notes", cwd: notes, color: "#654321", workers: [] },
        ],
        workspaceRailOrder: ["ws-repo", "ws-notes"],
        activeWorkspaceId: "ws-notes",
      },
      prefs: { agentWorktreesEnabled: true, agentsMayRemoveUserWorktrees: false, agentWorktreeRegenerableIgnoredByRepo: {} },
      paneWorkspace: { "pane-owner": "ws-repo", "pane-other": "ws-repo" },
      sessionCwds: {},
      pulls: [],
      githubDown: false,
      asked: [],
    };
    const lookup = async (_cwd, head) => {
      h.asked.push(head);
      if (h.githubDown) throw new Error("gh: not logged in");
      return h.pulls.filter((pr) => pr.headRefName === head);
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
      sessionCwd: (paneId) => h.sessionCwds[paneId] ?? null,
      sessionsUnderCwd: () => [],
      listRendererTerminals: async () => [],
      workspaceHeld: async () => false,
      processesUnderCwd: async () => [],
      github: {
        listPullRequestsForHead: lookup,
        listMergedPullRequests: async () => {
          if (h.githubDown) throw new Error("gh: not logged in");
          return h.pulls;
        },
      },
      sendAgentEvent: () => {},
      audit: aw.createWorktreeAuditLog(path.join(home, "logs", "worktree-audit.jsonl")),
      worktreesRoot: (repoCwd) => path.join(home, "worktrees", path.basename(repoCwd)),
      now: () => new Date("2026-11-06T10:00:00Z"),
      randomId: () => (++ids).toString(16).padStart(8, "a"),
      pretrustClaude: async () => {},
    };
    const owner = { role: "studio", client: "claude-code", paneId: "pane-owner" };
    const other = { role: "studio", client: "codex", paneId: "pane-other" };

    // ── The stack, as the agents made it ───────────────────────────────────
    const roles = await aw.createAgentWorktree(owner, { branch: "feat/roles" }, deps);
    assert.equal(roles.ok, true, JSON.stringify(roles));
    const rolesTip = commitFile(roles.path, "roles.sql", "create role reader;\n", "add roles");
    git(roles.path, ["push", "-q", "-u", "origin", "feat/roles"]);
    const api = await aw.createAgentWorktree(owner, { branch: "feat/roles-api", base: "feat/roles" }, deps);
    assert.equal(api.ok, true, JSON.stringify(api));
    const apiTip = commitFile(api.path, "api.ts", "export const roles = [];\n", "roles api");
    git(api.path, ["push", "-q", "-u", "origin", "feat/roles-api"]);

    // ── On GitHub: more commits, the stacked merge, the squash into main ───
    execFileSync("git", ["clone", "-q", origin, hub]);
    git(hub, ["checkout", "-q", "feat/roles-api"]);
    const apiHead = commitFile(hub, "api.ts", "export const roles = ['reader'];\n", "review fix");
    git(hub, ["checkout", "-q", "feat/roles"]);
    const rolesHead0 = commitFile(hub, "roles.sql", "create role reader;\ncreate role writer;\n", "review fix roles");
    git(hub, ["merge", "-q", "--no-ff", "-m", "Merge pull request #454", "feat/roles-api"]);
    const merge454 = git(hub, ["rev-parse", "HEAD"]);
    git(hub, ["checkout", "-q", "main"]);
    git(hub, ["merge", "-q", "--squash", "feat/roles"]);
    git(hub, ["commit", "-q", "-m", "Database roles (#453)"]);
    const squash453 = git(hub, ["rev-parse", "HEAD"]);
    git(hub, ["push", "-q", "origin", "main", "feat/roles", "feat/roles-api"]);
    // The user's clone fetched before GitHub deleted the branches.
    git(repo, ["fetch", "-q", "origin"]);
    git(hub, ["push", "-q", "origin", "--delete", "feat/roles", "feat/roles-api"]);
    git(repo, ["fetch", "-q", "--prune", "origin"]);
    assert.throws(() => git(repo, ["merge-base", "--is-ancestor", apiTip, "origin/main"]), "squashed: not in main's history");

    const pr454 = {
      number: 454,
      url: "https://github.com/acme/app/pull/454",
      headRefName: "feat/roles-api",
      headRefOid: apiHead,
      baseRefName: "feat/roles",
      isCrossRepository: false,
      mergeCommitOid: merge454,
    };
    const pr453 = {
      number: 453,
      url: "https://github.com/acme/app/pull/453",
      headRefName: "feat/roles",
      headRefOid: merge454,
      baseRefName: "main",
      isCrossRepository: false,
      mergeCommitOid: squash453,
    };
    const main = git(repo, ["rev-parse", "origin/main"]);
    const prove = (tip, branch, pulls, extra = {}) =>
      stack.proveByMergedPullRequestStack({
        repo,
        tip,
        branch,
        mergedFor: async (head) => pulls.filter((pr) => pr.headRefName === head),
        landedBases: new Set(["main"]),
        defaultCommit: main,
        ...extra,
      });

    // ── The proof itself ───────────────────────────────────────────────────
    await check("a tip behind a merged head, merged into a branch whose own pull request landed, is merged", async () => {
      const proof = await prove(apiTip, "feat/roles-api", [pr454, pr453]);
      assert.deepEqual(proof, { pullRequest: { number: 454, url: pr454.url }, via: [453] });
    });

    await check("a tip behind the head of a pull request merged into the default branch is merged", async () => {
      assert.deepEqual(await prove(rolesTip, "feat/roles", [pr454, pr453]), { pullRequest: { number: 453, url: pr453.url }, via: [] });
    });

    await check("a stacked merge the base's pull request did not take proves nothing", async () => {
      // #453 merged before #454 landed on feat/roles: its head lacks that merge.
      const early = { ...pr453, headRefOid: rolesHead0 };
      assert.equal(await prove(apiTip, "feat/roles-api", [pr454, early]), null);
      // No pull request merged feat/roles at all.
      assert.equal(await prove(apiTip, "feat/roles-api", [pr454]), null);
      // No merge commit known for #454.
      assert.equal(await prove(apiTip, "feat/roles-api", [{ ...pr454, mergeCommitOid: null }, pr453]), null);
    });

    await check("commits past every merged head, forks and unknown commits prove nothing", async () => {
      git(api.path, ["checkout", "-q", "-b", "scratch-extra"]);
      const extra = commitFile(api.path, "later.ts", "x\n", "not pushed");
      git(api.path, ["checkout", "-q", "feat/roles-api"]);
      assert.equal(await prove(extra, "feat/roles-api", [pr454, pr453]), null);
      assert.equal(await prove(apiTip, "feat/roles-api", [{ ...pr454, isCrossRepository: true }, pr453]), null);
      assert.equal(await prove(apiTip, "feat/roles-api", [{ ...pr454, headRefOid: "e".repeat(40) }, pr453]), null);
      assert.equal(await prove(apiTip, "feat/roles-api", [{ ...pr454, headRefName: "other" }, pr453]), null);
      git(repo, ["branch", "-D", "scratch-extra"]);
    });

    await check("a stack that loops back or never lands ends", async () => {
      const loopA = { ...pr454, baseRefName: "feat/b" };
      const loopB = { ...pr453, number: 9, headRefName: "feat/b", baseRefName: "feat/roles-api", headRefOid: merge454, mergeCommitOid: merge454 };
      assert.equal(await prove(apiTip, "feat/roles-api", [loopA, loopB]), null);
      const failing = await stack.proveByMergedPullRequestStack({
        repo,
        tip: apiTip,
        branch: "feat/roles-api",
        mergedFor: async (head) => {
          if (head === "feat/roles") throw new Error("GitHub did not answer");
          return [pr454];
        },
        landedBases: new Set(["main"]),
        defaultCommit: main,
      });
      assert.equal(failing, null, "a lookup that fails proves nothing");
    });

    await check("an exact head merged into a branch that never landed proves nothing", async () => {
      assert.equal(await prove(apiHead, "feat/roles-api", [pr454]), null);
      assert.equal(await prove(apiHead, "feat/roles-api", [pr454, { ...pr453, headRefOid: rolesHead0 }]), null);
      assert.deepEqual(await prove(apiHead, "feat/roles-api", [pr454, pr453]), { pullRequest: { number: 454, url: pr454.url }, via: [453] });
    });

    await check("a base still on the remote lands only while it holds the merge", async () => {
      const holds = await prove(apiTip, "feat/roles-api", [pr454], { remoteCommit: async (name) => (name === "feat/roles" ? merge454 : null) });
      assert.deepEqual(holds, { pullRequest: { number: 454, url: pr454.url }, via: [] });
      // Force-pushed back to before the merge: the merge is no longer in it.
      const lost = await prove(apiTip, "feat/roles-api", [pr454], { remoteCommit: async (name) => (name === "feat/roles" ? rolesHead0 : null) });
      assert.equal(lost, null);
    });

    await check("a merge commit already in the default branch lands without its base's pull request", async () => {
      const hub2 = path.join(scratch, "hub2");
      execFileSync("git", ["clone", "-q", origin, hub2]);
      git(hub2, ["checkout", "-q", "-b", "side", "origin/main"]);
      git(hub2, ["fetch", "-q", path.join(repo), `${merge454}:refs/heads/stack-tip`]);
      git(hub2, ["checkout", "-q", "main"]);
      git(hub2, ["merge", "-q", "--no-ff", "-m", "bring the stack", "stack-tip"]);
      const withMerge = git(hub2, ["rev-parse", "HEAD"]);
      git(repo, ["fetch", "-q", hub2, `${withMerge}:refs/heads/scratch-main`]);
      const proof = await prove(apiTip, "feat/roles-api", [pr454], { defaultCommit: withMerge });
      assert.deepEqual(proof, { pullRequest: { number: 454, url: pr454.url }, via: [] });
      git(repo, ["branch", "-D", "scratch-main"]);
    });

    // ── The cleanup screen and rail (mergeFacts) ───────────────────────────
    const repoContext = (merged) => ({
      root: repo,
      name: "repo",
      registrations: [],
      mainPath: repo,
      workspaces: [],
      base: { name: "origin/main", commit: main },
      tracking: new Map(),
      targets: new Map(),
      pullRequests: merged ? { open: [], merged } : null,
    });
    const apiWorkspace = () => h.state.workspaces.find((workspace) => workspace.id === api.workspaceId);

    await check("cleanup: the stacked worktree reads merged against the default branch, not the stale local base", async () => {
      const ctx = repoContext([pr454, pr453]);
      const target = await inspect.targetFor(ctx, apiWorkspace());
      assert.equal(target.name, "feat/roles", "the recorded base resolves to the stale local branch");
      const facts = await inspect.mergeFacts(ctx, apiTip, "feat/roles-api", target);
      assert.equal(facts.state, "merged", JSON.stringify(facts));
      assert.equal(facts.proof, "pull-request");
      assert.deepEqual(facts.pullRequest, { number: 454, url: pr454.url });
      assert.deepEqual(facts.via, [453]);
      assert.equal(facts.target, "origin/main", "judged where it landed, a remote base");
      assert.equal(facts.ahead, 2, "its own commits do not show in main's history (squash)");
    });

    await check("cleanup: without the base's pull request it stays unmerged", async () => {
      const ctx = repoContext([pr454]);
      const facts = await inspect.mergeFacts(ctx, apiTip, "feat/roles-api", await inspect.targetFor(ctx, apiWorkspace()));
      assert.equal(facts.state, "unmerged", JSON.stringify(facts));
      const offline = repoContext(null);
      assert.equal((await inspect.mergeFacts(offline, apiTip, "feat/roles-api", await inspect.targetFor(offline, apiWorkspace()))).state, "unmerged");
    });

    await check("cleanup: an exact head merged into a branch that never landed is not merged", async () => {
      const ctx = repoContext([pr454]);
      const target = await inspect.targetFor(ctx, apiWorkspace());
      assert.equal((await inspect.mergeFacts(ctx, apiHead, "feat/roles-api", target)).state, "unmerged");
    });

    await check("cleanup: the worktree's remote base counts only while it holds the merge; other tracking refs never", async () => {
      // Recorded as the remote branch, as an agent that forked from origin/feat/roles has it.
      const onRemote = () => ({ ...apiWorkspace(), copyBranch: { ...apiWorkspace().copyBranch, baseBranch: "origin/feat/roles" } });
      try {
        git(repo, ["update-ref", "refs/remotes/origin/feat/roles", rolesHead0]); // force-pushed past the merge
        let ctx = repoContext([pr454]);
        let target = await inspect.targetFor(ctx, onRemote());
        assert.equal(target.name, "origin/feat/roles");
        assert.equal((await inspect.mergeFacts(ctx, apiTip, "feat/roles-api", target)).state, "unmerged");
        git(repo, ["update-ref", "refs/remotes/origin/feat/roles", merge454]);
        ctx = repoContext([pr454]);
        target = await inspect.targetFor(ctx, onRemote());
        assert.equal((await inspect.mergeFacts(ctx, apiTip, "feat/roles-api", target)).state, "merged");
        git(repo, ["update-ref", "-d", "refs/remotes/origin/feat/roles"]);
        // A tracking ref of some other branch may be stale: it proves nothing.
        git(repo, ["update-ref", "refs/remotes/origin/feat/other", merge454]);
        ctx = repoContext([{ ...pr454, baseRefName: "feat/other" }]);
        target = await inspect.targetFor(ctx, apiWorkspace());
        assert.equal((await inspect.mergeFacts(ctx, apiTip, "feat/roles-api", target)).state, "unmerged");
      } finally {
        for (const ref of ["refs/remotes/origin/feat/roles", "refs/remotes/origin/feat/other"]) {
          try {
            git(repo, ["update-ref", "-d", ref]);
          } catch {
            /* already gone */
          }
        }
      }
    });

    // ── The agent tool (codara_worktree_remove) ────────────────────────────
    h.pulls = [pr454, pr453];
    h.sessionCwds["pane-owner"] = notes; // the maker's tab is open, idle elsewhere

    await check("remove: the stacked worktree is merged, and the open maker tab alone holds it", async () => {
      const dry = await aw.removeAgentWorktree(other, { workspaceId: api.workspaceId, dryRun: true }, deps);
      assert.equal(dry.ok, true, JSON.stringify(dry));
      assert.deepEqual(dry.blockers, ["WORKTREE_OWNED_BY_LIVE_AGENT"], JSON.stringify(dry));
      assert.equal(dry.merge.status, "merged", JSON.stringify(dry.merge));
      assert.equal(dry.merge.proof, "pull-request");
      assert.ok(h.asked.includes("feat/roles"), "the base branch's pull requests were looked up");
      const refused = await aw.removeAgentWorktree(other, { workspaceId: api.workspaceId }, deps);
      assert.equal(refused.ok, false);
      assert.equal(refused.code, "WORKTREE_OWNED_BY_LIVE_AGENT");
      assert.match(refused.hint, /codara_worktree_cleanup/, "it points at the approval flow");
      assert.ok(fs.existsSync(api.path), "an agent never removes it while the maker's tab is open");
    });

    await check("remove: an exact head merged into a branch that never landed is not merged", async () => {
      git(api.path, ["merge", "-q", "--ff-only", apiHead]);
      try {
        h.pulls = [pr454];
        const dry = await aw.removeAgentWorktree(other, { workspaceId: api.workspaceId, dryRun: true }, deps);
        assert.ok(dry.blockers.includes("WORKTREE_NOT_MERGED"), JSON.stringify(dry));
        h.pulls = [pr454, pr453];
        const merged = await aw.removeAgentWorktree(other, { workspaceId: api.workspaceId, dryRun: true }, deps);
        assert.equal(merged.merge.status, "merged", JSON.stringify(merged));
      } finally {
        git(api.path, ["reset", "-q", "--hard", apiTip]);
      }
    });

    await check("remove: a named local target is that branch, not one named like its last part", async () => {
      git(repo, ["branch", "feat/release", "origin/main"]);
      try {
        h.pulls = [{ ...pr454, baseRefName: "release", headRefOid: apiTip, mergeCommitOid: null }];
        const dry = await aw.removeAgentWorktree(other, { workspaceId: api.workspaceId, target: "feat/release", dryRun: true }, deps);
        assert.ok(dry.blockers.includes("WORKTREE_NOT_MERGED"), JSON.stringify(dry));
        h.pulls = [{ ...pr454, baseRefName: "feat/release", headRefOid: apiTip, mergeCommitOid: null }];
        const named = await aw.removeAgentWorktree(other, { workspaceId: api.workspaceId, target: "feat/release", dryRun: true }, deps);
        assert.equal(named.merge.status, "merged", JSON.stringify(named));
      } finally {
        h.pulls = [pr454, pr453];
        git(repo, ["branch", "-D", "feat/release"]);
      }
    });

    await check("remove: an owner-held worktree that is not merged keeps the plain hint", async () => {
      h.pulls = [pr454];
      const refused = await aw.removeAgentWorktree(other, { workspaceId: api.workspaceId }, deps);
      assert.deepEqual(refused.blockers, ["WORKTREE_OWNED_BY_LIVE_AGENT", "WORKTREE_NOT_MERGED"], JSON.stringify(refused));
      assert.doesNotMatch(refused.hint, /codara_worktree_cleanup/);
      h.pulls = [pr454, pr453];
    });

    await check("remove: once the maker's tab closes, both worktrees of the stack go, the base first", async () => {
      delete h.sessionCwds["pane-owner"];
      const rolesGone = await aw.removeAgentWorktree(other, { workspaceId: roles.workspaceId }, deps);
      assert.equal(rolesGone.ok, true, JSON.stringify(rolesGone));
      assert.equal(rolesGone.removed, true);
      assert.throws(() => git(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/feat/roles"]), "its branch went too");
      // The child's recorded base is now gone everywhere.
      const apiGone = await aw.removeAgentWorktree(other, { workspaceId: api.workspaceId }, deps);
      assert.equal(apiGone.ok, true, JSON.stringify(apiGone));
      assert.equal(apiGone.removed, true);
      assert.equal(fs.existsSync(api.path), false);
    });

    await check("remove: commits reachable from the default branch count when the recorded base is gone", async () => {
      const base = await aw.createAgentWorktree(owner, { branch: "feat/base" }, deps);
      commitFile(base.path, "base.txt", "base\n", "base");
      git(base.path, ["push", "-q", "-u", "origin", "feat/base"]);
      const top = await aw.createAgentWorktree(owner, { branch: "feat/top", base: "feat/base" }, deps);
      const topTip = commitFile(top.path, "top.txt", "top\n", "top");
      git(top.path, ["push", "-q", "-u", "origin", "feat/top"]);
      // GitHub: feat/top into feat/base, then feat/base into main, merge commits.
      git(hub, ["fetch", "-q", "origin"]);
      git(hub, ["checkout", "-q", "-B", "feat/base", "origin/feat/base"]);
      git(hub, ["merge", "-q", "--no-ff", "-m", "Merge #2", "origin/feat/top"]);
      git(hub, ["checkout", "-q", "main"]);
      git(hub, ["reset", "-q", "--hard", "origin/main"]);
      git(hub, ["merge", "-q", "--no-ff", "-m", "Merge #1", "feat/base"]);
      git(hub, ["push", "-q", "origin", "main"]);
      git(hub, ["push", "-q", "origin", "--delete", "feat/base", "feat/top"]);
      git(repo, ["fetch", "-q", "--prune", "origin"]);
      h.githubDown = true; // no pull request facts at all
      const dry = await aw.removeAgentWorktree(other, { workspaceId: top.workspaceId, dryRun: true }, deps);
      assert.equal(dry.wouldRemove, true, JSON.stringify(dry));
      assert.equal(dry.merge.proof, "ancestor");
      assert.equal(dry.merge.target, "origin/main");
      const gone = await aw.removeAgentWorktree(other, { workspaceId: top.workspaceId }, deps);
      assert.equal(gone.removed, true, JSON.stringify(gone));
      assert.equal(git(repo, ["merge-base", "--is-ancestor", topTip, "origin/main"]), "");
      // Named by the caller, the target is the only one judged.
      const named = await aw.removeAgentWorktree(other, { workspaceId: base.workspaceId, target: "feat/top", dryRun: true }, deps);
      assert.notEqual(named.merge?.proof, "ancestor", JSON.stringify(named));
      h.githubDown = false;
    });

    await check("a base recorded by its local name is judged by the remote's copy, fetched, and not when it is gone", async () => {
      const b1 = await aw.createAgentWorktree(owner, { branch: "feat/b1" }, deps);
      commitFile(b1.path, "b1.txt", "b1\n", "b1");
      git(b1.path, ["push", "-q", "-u", "origin", "feat/b1"]);
      const b2 = await aw.createAgentWorktree(owner, { branch: "feat/b2", base: "feat/b1" }, deps);
      const b2Tip = commitFile(b2.path, "b2.txt", "b2\n", "b2");
      git(b2.path, ["push", "-q", "-u", "origin", "feat/b2"]);
      // GitHub squashes feat/b2 into feat/b1; the local feat/b1 stays behind
      // and feat/b1 is not merged anywhere yet.
      git(hub, ["fetch", "-q", "origin"]);
      git(hub, ["checkout", "-q", "-B", "feat/b1", "origin/feat/b1"]);
      git(hub, ["merge", "-q", "--squash", "origin/feat/b2"]);
      git(hub, ["commit", "-q", "-m", "b2 (#5)"]);
      const squash = git(hub, ["rev-parse", "HEAD"]);
      git(hub, ["push", "-q", "origin", "feat/b1"]);
      git(repo, ["fetch", "-q", "origin"]);
      const pr5 = { number: 5, url: "https://github.com/acme/app/pull/5", headRefName: "feat/b2", headRefOid: b2Tip, baseRefName: "feat/b1", isCrossRepository: false, mergeCommitOid: squash };
      h.pulls = [pr5];
      const dry = await aw.removeAgentWorktree(other, { workspaceId: b2.workspaceId, dryRun: true }, deps);
      assert.equal(dry.merge.status, "merged", JSON.stringify(dry));
      assert.equal(dry.merge.proof, "pull-request");
      const b2Workspace = h.state.workspaces.find((workspace) => workspace.id === b2.workspaceId);
      const ctx = repoContext([pr5]);
      ctx.base = { name: "origin/main", commit: git(repo, ["rev-parse", "origin/main"]) };
      const facts = await inspect.mergeFacts(ctx, b2Tip, "feat/b2", await inspect.targetFor(ctx, b2Workspace));
      assert.equal(facts.state, "merged", JSON.stringify(facts));
      // Deleted on the remote, never merged on: the stale copy proves nothing to a removal.
      git(hub, ["push", "-q", "origin", "--delete", "feat/b1"]);
      const gone = await aw.removeAgentWorktree(other, { workspaceId: b2.workspaceId, dryRun: true }, deps);
      assert.notEqual(gone.merge.status, "merged", JSON.stringify(gone));
      h.pulls = [pr454, pr453];
    });

    // A worktree whose agent switched it to a follow-up branch, both merged
    // by squash on GitHub.
    const switchedWorktree = async (name) => {
      const made = await aw.createAgentWorktree(owner, { branch: `fix/${name}` }, deps);
      const first = commitFile(made.path, `${name}.txt`, "1\n", `${name} 1`);
      git(made.path, ["push", "-q", "-u", "origin", `fix/${name}`]);
      git(made.path, ["switch", "-q", "-c", `fix/${name}-cli`]);
      const second = commitFile(made.path, `${name}-cli.txt`, "2\n", `${name} 2`);
      git(made.path, ["push", "-q", "-u", "origin", `fix/${name}-cli`]);
      git(hub, ["fetch", "-q", "origin"]);
      git(hub, ["checkout", "-q", "main"]);
      git(hub, ["reset", "-q", "--hard", "origin/main"]);
      const squash = (branch, n) => {
        git(hub, ["merge", "-q", "--squash", `origin/${branch}`]);
        git(hub, ["commit", "-q", "-m", `${branch} (#${n})`]);
        return git(hub, ["rev-parse", "HEAD"]);
      };
      const pr = (branch, head, n, merge) => ({ number: n, url: `https://github.com/acme/app/pull/${n}`, headRefName: branch, headRefOid: head, baseRefName: "main", isCrossRepository: false, mergeCommitOid: merge });
      const prFirst = pr(`fix/${name}`, first, 20, squash(`fix/${name}`, 20));
      const prSecond = pr(`fix/${name}-cli`, second, 21, squash(`fix/${name}-cli`, 21));
      git(hub, ["push", "-q", "origin", "main"]);
      git(hub, ["push", "-q", "origin", "--delete", `fix/${name}`, `fix/${name}-cli`]);
      git(repo, ["fetch", "-q", "--prune", "origin"]);
      return { made, first, second, prFirst, prSecond };
    };
    const hasBranch = (name) => {
      try {
        git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
        return true;
      } catch {
        return false;
      }
    };

    await check("switched: a worktree on a merged follow-up branch is removed, and both merged branches go", async () => {
      const { made, second, prFirst, prSecond } = await switchedWorktree("wording");
      h.pulls = [prFirst, prSecond];
      // Unmerged work on the branch checked out: refused as before.
      commitFile(made.path, "later.txt", "later\n", "not merged");
      const unmerged = await aw.removeAgentWorktree(other, { workspaceId: made.workspaceId, dryRun: true }, deps);
      assert.ok(unmerged.blockers.includes("WORKTREE_BRANCH_MISMATCH"), JSON.stringify(unmerged));
      assert.equal(unmerged.wouldRemove, false);
      git(made.path, ["reset", "-q", "--hard", second]);
      const dry = await aw.removeAgentWorktree(other, { workspaceId: made.workspaceId, dryRun: true }, deps);
      assert.equal(dry.wouldRemove, true, JSON.stringify(dry));
      const gone = await aw.removeAgentWorktree(other, { workspaceId: made.workspaceId }, deps);
      assert.equal(gone.removed, true, JSON.stringify(gone));
      assert.equal(gone.checkedOutBranch, "fix/wording-cli");
      assert.deepEqual(gone.branches, [
        { branch: "fix/wording-cli", deleted: true },
        { branch: "fix/wording", deleted: true },
      ]);
      assert.equal(hasBranch("fix/wording-cli") || hasBranch("fix/wording"), false);
    });

    await check("switched: the recorded branch stays when its own tip is not merged", async () => {
      const { made, prFirst, prSecond } = await switchedWorktree("label");
      // A commit on the recorded branch that no pull request merged.
      git(made.path, ["switch", "-q", "fix/label"]);
      const extra = commitFile(made.path, "local.txt", "only here\n", "local only");
      git(made.path, ["switch", "-q", "fix/label-cli"]);
      h.pulls = [prFirst, prSecond];
      const gone = await aw.removeAgentWorktree(other, { workspaceId: made.workspaceId }, deps);
      assert.equal(gone.removed, true, JSON.stringify(gone));
      assert.deepEqual(gone.branches[1], { branch: "fix/label", deleted: false, keptReason: "NOT_MERGED" });
      assert.equal(git(repo, ["rev-parse", "refs/heads/fix/label"]), extra, "its unmerged commit is kept");
      git(repo, ["branch", "-D", "fix/label"]);
    });

    await check("switched: a long-lived branch checked out is never taken for merged work", async () => {
      const made = await aw.createAgentWorktree(owner, { branch: "fix/develop-switch" }, deps);
      git(repo, ["branch", "develop", "origin/main"]);
      git(made.path, ["switch", "-q", "develop"]);
      const dry = await aw.removeAgentWorktree(other, { workspaceId: made.workspaceId, dryRun: true }, deps);
      assert.equal(dry.wouldRemove, false, JSON.stringify(dry));
      assert.ok(dry.blockers.includes("WORKTREE_BRANCH_MISMATCH"));
      git(made.path, ["switch", "-q", "fix/develop-switch"]);
      git(repo, ["branch", "-D", "develop"]);
      h.pulls = [pr454, pr453];
    });

    // ── What the cleanup tool tells the user ───────────────────────────────
    await check("advice: names the stack and the maker's open tab", async () => {
      const result = advice.adviseWorktree(
        {
          missing: false,
          locked: false,
          inUse: [],
          hardBlockers: [],
          dirty: { tracked: 0, untracked: 0, inProgress: null },
          localWork: null,
          merge: { state: "merged", proof: "pull-request", target: "origin/main", via: [453] },
          makerOpen: "the tab “Coordinator” in notes",
          ahead: 2,
          pullRequest: { number: 454, state: "merged" },
          onRemote: false,
          unpushed: null,
          lastActivityAt: Date.parse("2026-11-04T10:00:00Z"),
        },
        Date.parse("2026-11-06T10:00:00Z"),
      );
      assert.equal(result.advice, "safe");
      assert.equal(
        result.reason,
        "Merged through pull request #454, which landed through #453, clean and idle. The agent that made it still has the tab “Coordinator” in notes open, but none of its work is left here.",
      );
    });

    // ── GitHub: the merge commit is read ───────────────────────────────────
    await check("github: merged pull requests carry their merge commit", async () => {
      const calls = [];
      const adapter = github.createGitHubCliAdapter({
        resolveBinary: async () => "/usr/bin/gh",
        runCommand: async (command) => {
          calls.push(command);
          return {
            stdout: JSON.stringify([
              { ...pr454, mergeCommitOid: undefined, mergeCommit: { oid: merge454.toUpperCase() } },
              { ...pr453, mergeCommitOid: undefined, mergeCommit: null },
            ]),
            stderr: "",
          };
        },
      });
      const listed = await adapter.listMergedPullRequests("/repo", 100);
      assert.equal(listed[0].mergeCommitOid, merge454);
      assert.equal(listed[1].mergeCommitOid, null);
      assert.match(calls[0].args.join(" "), /(^|,)mergeCommit(,|\s|$)/);
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    for (const file of outputs) fs.rmSync(file, { force: true });
  }
  console.log(`${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
