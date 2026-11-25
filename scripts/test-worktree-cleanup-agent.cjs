// Unit and integration test for codara_worktree_cleanup: the recommendation
// rules in src/shared/worktree-cleanup-agent.ts, and the scan and the
// approval-gated removal in src/main/worktree-cleanup/agent-tool.ts, driven
// against throwaway git repositories with a fake GitHub, fake processes and a
// fake remote (ls-remote and push are never run, GitHub is never contacted).
// A fake home and git config: nothing reads or writes the user's own.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DAY = 24 * 60 * 60 * 1000;

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

async function bundle(entry, name) {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `spark-worktree-cleanup-agent-${name}-${process.pid}.cjs`);
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
  return { mod: require(outfile), outfile };
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

function baseFacts(overrides = {}) {
  return {
    missing: false,
    locked: false,
    inUse: [],
    hardBlockers: [],
    dirty: { tracked: 0, untracked: 0, inProgress: null },
    localWork: null,
    merge: { state: "merged", proof: "ancestor", target: "origin/main" },
    ahead: 0,
    pullRequest: null,
    onRemote: true,
    unpushed: 0,
    lastActivityAt: Date.parse("2026-10-01T00:00:00Z"),
    ...overrides,
  };
}

function ignoredWork(ignored) {
  return { tracked: 0, untracked: 0, hidden: 0, ignored, submodules: [], inProgress: null, unscanned: null, paths: [] };
}

async function pureChecks(shared) {
  const now = Date.parse("2026-10-17T00:00:00Z");
  await check("merged, clean and idle is safe to remove", async () => {
    const result = shared.adviseWorktree(baseFacts(), now);
    assert.equal(result.advice, "safe");
    assert.match(result.reason, /merged into origin\/main, clean and idle/i);
  });
  await check("merged but holding ignored files is for review", async () => {
    const result = shared.adviseWorktree(baseFacts({ localWork: ignoredWork([".env.local"]) }), now);
    assert.equal(result.advice, "review");
    assert.match(result.reason, /\.env\.local/);
  });
  await check("unmerged, pushed and stale is for review; recent or unpushed is kept", async () => {
    const stale = baseFacts({ merge: { state: "unmerged", target: "origin/main" }, ahead: 2, lastActivityAt: now - 30 * DAY });
    assert.equal(shared.adviseWorktree(stale, now).advice, "review");
    assert.match(shared.adviseWorktree(stale, now).reason, /30 days/);
    assert.equal(shared.adviseWorktree({ ...stale, lastActivityAt: now - 2 * DAY }, now).advice, "keep");
    assert.equal(shared.adviseWorktree({ ...stale, unpushed: 1 }, now).advice, "keep");
    assert.match(shared.adviseWorktree({ ...stale, unpushed: 1 }, now).reason, /not pushed/);
    assert.equal(shared.adviseWorktree({ ...stale, onRemote: false, unpushed: null }, now).advice, "keep");
    assert.equal(shared.adviseWorktree(stale, now, 60).advice, "keep", "staleDays moves the line");
  });
  await check("unsaved changes, use, an open pull request and locks keep it", async () => {
    assert.equal(shared.adviseWorktree(baseFacts({ dirty: { tracked: 1, untracked: 0, inProgress: null } }), now).advice, "keep");
    assert.equal(shared.adviseWorktree(baseFacts({ dirty: null }), now).advice, "keep");
    assert.equal(
      shared.adviseWorktree(baseFacts({ inUse: [{ kind: "process", label: "1 running process" }] }), now).reason,
      "In use: 1 running process.",
    );
    assert.equal(shared.adviseWorktree(baseFacts({ pullRequest: { number: 4, state: "open" } }), now).advice, "keep");
    assert.equal(shared.adviseWorktree(baseFacts({ locked: true }), now).advice, "keep");
    assert.equal(shared.adviseWorktree(baseFacts({ missing: true }), now).advice, "safe");
    const closed = baseFacts({ merge: { state: "unmerged" }, ahead: 1, pullRequest: { number: 9, state: "closed" } });
    assert.equal(shared.adviseWorktree(closed, now).advice, "review");
  });
  await check("unsaved changes never count ignored files alone", async () => {
    assert.equal(shared.hasUnsavedChanges({ missing: false, dirty: { tracked: 0, untracked: 0, inProgress: null }, localWork: ignoredWork([".env"]) }), false);
    assert.equal(shared.onlyIgnoredWork(ignoredWork([".env"])), true);
    assert.equal(shared.onlyIgnoredWork({ ...ignoredWork([".env"]), hidden: 1 }), false);
    // Nobody saw what a folder too large to check holds: never confirmable.
    assert.equal(shared.onlyIgnoredWork({ ...ignoredWork([]), unscanned: "node_modules/" }), false);
    assert.equal(shared.onlyIgnoredWork({ ...ignoredWork([".env"]), unscanned: "data/" }), false);
    const unchecked = baseFacts({
      hardBlockers: [{ code: "UNCHECKED", message: "It could not be fully checked: data/ is too large or unreadable to look through, so it is not removed. Delete that folder yourself, then try again." }],
      localWork: { ...ignoredWork([".env"]), unscanned: "data/" },
    });
    assert.equal(shared.adviseWorktree(unchecked, now).advice, "keep");
    assert.match(shared.adviseWorktree(unchecked, now).reason, /could not be fully checked/);
  });
  await check("sorting puts safe first, then review, then keep, largest first", async () => {
    const sorted = shared.sortByAdvice([
      { advice: "keep", sizeBytes: 900, path: "/a" },
      { advice: "safe", sizeBytes: 10, path: "/b" },
      { advice: "review", sizeBytes: 50, path: "/c" },
      { advice: "safe", sizeBytes: 500, path: "/d" },
    ]);
    assert.deepEqual(sorted.map((item) => item.path), ["/d", "/b", "/c", "/a"]);
  });
  await check("a remote branch is offered only when its merged pull request covers its tip", async () => {
    const facts = {
      branch: "feature/x",
      remote: "origin",
      remoteTip: "a".repeat(40),
      remoteAsked: true,
      baseBranches: ["main"],
      mergedPullRequest: { number: 3, headRefOid: "a".repeat(40) },
      openPullRequest: null,
      remoteTipInBase: false,
    };
    assert.equal(shared.remoteBranchVerdict(facts).offered, true);
    assert.equal(shared.remoteBranchVerdict({ ...facts, remoteTip: "b".repeat(40) }).offered, false);
    assert.equal(shared.remoteBranchVerdict({ ...facts, remoteTip: "b".repeat(40), remoteTipInBase: true }).offered, true);
    assert.equal(shared.remoteBranchVerdict({ ...facts, openPullRequest: 8 }).offered, false);
    assert.equal(shared.remoteBranchVerdict({ ...facts, mergedPullRequest: null }).offered, false);
    assert.equal(shared.remoteBranchVerdict({ ...facts, branch: "main" }).offered, false);
    assert.equal(shared.remoteBranchVerdict({ ...facts, branch: "release-2", baseBranches: ["release-2"] }).offered, false);
    assert.equal(shared.remoteBranchVerdict({ ...facts, remote: null }).reason, "The repository has no remote.");
    assert.equal(shared.remoteBranchVerdict({ ...facts, remoteAsked: false }).offered, false);
  });
}

async function main() {
  const bundles = await Promise.all([
    bundle("src/shared/worktree-cleanup-agent.ts", "shared"),
    bundle("src/main/worktree-cleanup/agent-tool.ts", "tool"),
    bundle("src/shared/worktree-cleanup-approval.ts", "approval"),
    bundle("src/main/agent-worktrees.ts", "agent"),
  ]);
  const [shared, tool, approval, agent] = bundles.map((entry) => entry.mod);
  await pureChecks(shared);

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-wt-cleanup-agent-")));
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
    const trees = path.join(scratch, "trees");
    fs.mkdirSync(trees);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    commitFile(repo, ".gitignore", ".env.local\n", "ignore");
    commitFile(repo, "README.md", "# test\n", "init");
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);

    const add = (name, branch) => {
      const dir = path.join(trees, name);
      git(repo, ["worktree", "add", "-q", dir, "-b", branch]);
      return dir;
    };
    const mergeIntoMain = (branch) => {
      git(repo, ["merge", "-q", "--no-ff", "-m", `merge ${branch}`, branch]);
      git(repo, ["push", "-q", "origin", "main"]);
    };
    // Merged, clean, pushed, with a merged pull request.
    const merged = add("merged", "feature/merged");
    const mergedTip = commitFile(merged, "merged.txt", "m\n", "merged work");
    git(merged, ["push", "-q", "-u", "origin", "feature/merged"]);
    mergeIntoMain("feature/merged");
    // Merged, but holds an ignored .env.local.
    const envfile = add("envfile", "feature/envfile");
    commitFile(envfile, "env.txt", "e\n", "env work");
    mergeIntoMain("feature/envfile");
    fs.writeFileSync(path.join(envfile, ".env.local"), "SECRET=1\n");
    // Unmerged, pushed, stale.
    const stale = add("stale", "feature/stale");
    commitFile(stale, "stale.txt", "s\n", "stale work");
    git(stale, ["push", "-q", "-u", "origin", "feature/stale"]);
    // Unmerged and never pushed.
    const local = add("local", "feature/local");
    commitFile(local, "local.txt", "l\n", "local work");
    // Unsaved changes.
    const dirty = add("dirty", "feature/dirty");
    fs.writeFileSync(path.join(dirty, "notes.txt"), "draft\n");
    // Merged (no commits of its own) but a process runs in it.
    const busy = add("busy", "feature/busy");
    // An open pull request uses it.
    const openpr = add("openpr", "feature/openpr");
    const openTip = commitFile(openpr, "open.txt", "o\n", "open work");
    git(openpr, ["push", "-q", "-u", "origin", "feature/openpr"]);
    // Merged with a pull request, but the remote branch moves after approval.
    const moved = add("moved", "feature/moved");
    const movedTip = commitFile(moved, "moved.txt", "v\n", "moved work");
    git(moved, ["push", "-q", "-u", "origin", "feature/moved"]);
    mergeIntoMain("feature/moved");

    const h = {
      state: {
        workspaces: [
          { id: "ws-repo", name: "repo", cwd: repo, color: "#123456", workers: [] },
          { id: "ws-ssh", name: "server", cwd: "ssh://host/srv/app", color: "#123456", workers: [], remote: { hostId: "host" } },
        ],
        workspaceRailOrder: ["ws-repo", "ws-ssh"],
        activeWorkspaceId: "ws-repo",
      },
      processes: new Map([[busy, [{ pid: 999_999, command: "node server.js" }]]]),
      pulls: {
        open: [{ number: 12, url: "https://example.invalid/pull/12", title: "Open work", headBranch: "feature/openpr", isDraft: false }],
        merged: [
          { number: 10, url: "https://example.invalid/pull/10", headRefName: "feature/merged", headRefOid: mergedTip, baseRefName: "main", isCrossRepository: false },
          { number: 11, url: "https://example.invalid/pull/11", headRefName: "feature/moved", headRefOid: movedTip, baseRefName: "main", isCrossRepository: false },
        ],
      },
      prCalls: 0,
      heads: null,
      headsCalls: 0,
      deleted: [],
      // Open agent tabs: pane id to the folder their shell is in.
      openPanes: new Map(),
      now: new Date(Date.now() + 40 * DAY),
    };
    const remoteHeads = () =>
      new Map(
        git(origin, ["for-each-ref", "--format=%(refname:lstrip=2) %(objectname)", "refs/heads"])
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split(" ")),
      );
    const cleanup = {
      loadState: async () => structuredClone(h.state),
      updateState: async (mutator) => {
        h.state = await mutator(structuredClone(h.state));
        return h.state;
      },
      publishState: () => undefined,
      invalidateGitCache: () => undefined,
      listRuns: async () => [],
      sessionCwd: (paneId) => h.openPanes.get(paneId) ?? null,
      sessionsUnderCwd: () => [],
      listRendererTerminals: async () => [],
      processesUnderCwds: async (dirs) => new Map(dirs.map((dir) => [dir, h.processes.get(dir) ?? []])),
      runningServers: () => 0,
      pullRequests: async () => {
        h.prCalls += 1;
        return h.pulls;
      },
      regenerableIgnored: async () => [],
      appPaths: () => [path.join(scratch, "app-not-here")],
      isProtectedPath: () => false,
      audit: agent.createWorktreeAuditLog(path.join(home, "logs", "worktree-audit.jsonl")),
      now: () => h.now,
    };
    const sizes = new Map();
    const deps = {
      cleanup,
      sizeOf: (id) => sizes.get(id) ?? null,
      measureSizes: async (items) => {
        for (const item of items) sizes.set(item.id, { bytes: item.path === merged ? 4096 : 1024, complete: true, measuredAt: 1 });
      },
      forgetSize: (id) => sizes.delete(id),
      closedPullRequests: async () => [],
      remote: {
        heads: async () => {
          h.headsCalls += 1;
          return h.heads ? h.heads(h.headsCalls) : remoteHeads();
        },
        deleteBranch: async (root, remote, branch, tip) => {
          h.deleted.push({ root, remote, branch, tip });
          git(origin, ["update-ref", "-d", `refs/heads/${branch}`, tip]);
          return { ok: true };
        },
      },
    };

    // ── Scan ───────────────────────────────────────────────────────────────
    const scan = await tool.scanForAgent(deps, { checkMerge: true });
    const item = (dir) => scan.worktrees.find((entry) => entry.path === dir);
    await check("the scan recommends per worktree and says why", async () => {
      assert.equal(scan.ok, true);
      assert.equal(scan.worktrees.length, 8, "every worktree but the main checkout");
      assert.equal(item(merged).recommendation, "safe to remove");
      assert.equal(item(envfile).recommendation, "review");
      assert.match(item(envfile).reason, /\.env\.local/);
      assert.deepEqual(item(envfile).ignoredFiles, [".env.local"]);
      assert.equal(item(stale).recommendation, "review");
      assert.match(item(stale).reason, /not merged, no activity for \d+ days/);
      assert.equal(item(local).recommendation, "keep");
      assert.match(item(local).reason, /not on the remote/);
      assert.equal(item(dirty).recommendation, "keep");
      assert.match(item(dirty).reason, /Unsaved changes: 1 new file/);
      assert.equal(item(dirty).dirtyFiles, 1);
      assert.equal(item(busy).recommendation, "keep");
      assert.deepEqual(item(busy).inUse, ["1 running process (node, pid 999999)"]);
      assert.equal(item(openpr).recommendation, "keep");
      assert.equal(item(openpr).pullRequest.state, "open");
      assert.equal(item(moved).recommendation, "safe to remove");
    });
    await check("the scan reports the remote branch, its pull request and sizes", async () => {
      assert.deepEqual(
        { exists: item(merged).remoteBranch.exists, deletable: item(merged).remoteBranch.deletable, remote: item(merged).remoteBranch.remote },
        { exists: true, deletable: true, remote: "origin" },
      );
      assert.equal(item(merged).pullRequest.number, 10);
      assert.equal(item(merged).pullRequest.state, "merged");
      assert.equal(item(local).remoteBranch.exists, false);
      assert.equal(item(openpr).remoteBranch.deletable, false);
      assert.match(item(openpr).remoteBranch.why, /Open pull request #12/);
      assert.equal(item(stale).remoteBranch.deletable, false);
      assert.equal(item(merged).sizeBytes, 4096);
      assert.equal(item(merged).size, "4 KB");
      assert.ok(item(merged).lastActivity);
    });
    await check("the scan sorts safe first, totals what safe removals free, and names SSH workspaces", async () => {
      const order = scan.worktrees.map((entry) => entry.recommendation);
      const rank = { "safe to remove": 0, review: 1, keep: 2 };
      assert.deepEqual(order, [...order].sort((a, b) => rank[a] - rank[b]));
      assert.equal(scan.worktrees[0].path, merged, "the largest safe one leads");
      assert.equal(scan.totals.safeToRemove, 2);
      assert.equal(scan.totals.safeRemovalFreesBytes, 4096 + 1024);
      assert.equal(scan.notCovered.length, 1);
      assert.equal(scan.notCovered[0].workspace, "server");
      assert.equal(h.deleted.length, 0, "a scan deletes nothing");
    });

    // ── Approval gate ──────────────────────────────────────────────────────
    const context = { caller: { role: "studio", client: "claude-code" }, agent: { client: "claude-code", workspaceName: "repo" } };
    const asked = [];
    const asker = (answer) => async (request) => {
      asked.push(request);
      return typeof answer === "function" ? answer(request) : answer;
    };
    const allPaths = [merged, envfile, stale, local, dirty, busy, openpr, moved].map((dir) => ({ path: dir }));

    await check("nothing is removed without an answer, or when the user declines", async () => {
      const timedOut = await tool.removeForAgent(
        deps,
        { items: allPaths, reason: "You approved: remove every merged one.\nI recommend the 2 safe ones." },
        context,
        asker(null),
      );
      assert.equal(timedOut.status, "timeout");
      assert.equal(timedOut.removed.length, 0);
      assert.equal(asked[asked.length - 1].reason, "You approved: remove every merged one. I recommend the 2 safe ones.", "the agent's line reaches the dialog on one line");
      assert.equal(timedOut.blockedBeforeAsking, 2, "the dirty and the busy one were blocked before the user was asked");
      assert.match(timedOut.note, /2 of 8 could not be removed before the user was asked/);
      const declined = await tool.removeForAgent(
        deps,
        { items: allPaths },
        context,
        asker((request) => ({ id: "x", approved: false, items: [], deleteMergedBranches: true })),
      );
      assert.equal(declined.status, "declined");
      const noWindow = await tool.removeForAgent(deps, { items: allPaths }, context, asker("no-window"));
      assert.equal(noWindow.status, "no-window");
      for (const dir of [merged, envfile, stale, local, dirty, busy, openpr, moved]) assert.ok(fs.existsSync(dir), `${dir} stays`);
    });
    await check("the request lists every asked worktree with what may be ticked", async () => {
      const request = asked[0];
      assert.equal(request.agent.client, "claude-code");
      assert.equal(asked[1].reason, null, "no reason given, none shown");
      assert.equal(request.agent.workspaceName, "repo");
      const byPath = new Map(request.items.map((entry) => [entry.path, entry]));
      // Nothing starts ticked: the dialog has no per-item default to send.
      for (const entry of request.items) assert.equal("preselected" in entry, false);
      assert.equal(byPath.get(merged).blocked, null);
      assert.equal(byPath.get(merged).remote.offered, true);
      assert.equal(byPath.get(envfile).blocked, null);
      assert.deepEqual(byPath.get(envfile).ignored, [".env.local"]);
      assert.match(byPath.get(dirty).blocked, /unsaved changes/);
      assert.equal(byPath.get(dirty).blockedGroup, "With unsaved changes");
      assert.match(byPath.get(busy).blocked, /In use/);
      assert.equal(byPath.get(busy).blockedGroup, "In use by an open tab or a running program");
      assert.equal(byPath.get(merged).blockedGroup, null);
      assert.equal(byPath.get(merged).merged, true);
      assert.equal(byPath.get(merged).onRemote, true);
      assert.equal(byPath.get(openpr).merged, false);
      assert.equal(byPath.get(openpr).pullRequest.state, "open");
      assert.equal(byPath.get(openpr).blocked, null, "an open pull request may still be ticked explicitly");
      assert.equal(byPath.get(openpr).remote.offered, false);
    });
    await check("unticked items stay, unsaved and busy ones are never removed, and an unoffered remote is never deleted", async () => {
      h.heads = null;
      const result = await tool.removeForAgent(
        deps,
        { items: [{ path: envfile }, { path: dirty }, { path: busy }, { path: openpr, deleteRemoteBranch: true }, { path: local }] },
        context,
        asker((request) => ({
          id: "y",
          approved: true,
          // A forged answer ticks everything, remote branches included.
          items: request.items.map((entry) => ({
            repoRoot: entry.repoRoot,
            path: entry.path,
            remove: entry.path !== local,
            deleteRemoteBranch: true,
          })),
          deleteMergedBranches: true,
        })),
      );
      assert.equal(result.status, "done");
      assert.equal(result.blockedBeforeAsking, 2);
      const removed = result.removed.map((entry) => entry.path).sort();
      assert.deepEqual(removed, [envfile, openpr].sort());
      assert.ok(!fs.existsSync(envfile));
      assert.ok(!fs.existsSync(openpr));
      for (const dir of [dirty, busy, local]) assert.ok(fs.existsSync(dir), `${dir} stays`);
      assert.equal(fs.readFileSync(path.join(dirty, "notes.txt"), "utf8"), "draft\n");
      const reasons = new Map(result.skipped.map((entry) => [entry.path, entry.reason]));
      assert.match(reasons.get(dirty), /unsaved changes/);
      assert.match(reasons.get(busy), /In use/);
      assert.equal(reasons.get(local), "The user left it unticked.");
      assert.equal(h.deleted.length, 0, "no remote branch was offered, so none was deleted");
      assert.ok(git(repo, ["branch", "--list", "feature/openpr"]), "an unmerged branch stays");
      assert.ok(git(origin, ["branch", "--list", "feature/openpr"]), "its remote branch stays");
    });
    await check("a ticked remote branch is deleted with the tip the user saw, and a moved one stays", async () => {
      h.headsCalls = 0;
      // The second ls-remote of the run (the one right before deleting) sees
      // feature/moved at a new commit.
      h.heads = (call) => {
        const heads = remoteHeads();
        if (call >= 2) heads.set("feature/moved", "f".repeat(40));
        return heads;
      };
      const result = await tool.removeForAgent(
        deps,
        { items: [{ path: merged }, { path: moved }], deleteRemoteBranch: true },
        context,
        asker((request) => {
          assert.ok(request.items.every((entry) => entry.remote.suggested));
          return {
            id: "z",
            approved: true,
            items: request.items.map((entry) => ({ repoRoot: entry.repoRoot, path: entry.path, remove: true, deleteRemoteBranch: true })),
            deleteMergedBranches: true,
          };
        }),
      );
      assert.deepEqual(result.removed.map((entry) => entry.path).sort(), [merged, moved].sort());
      assert.deepEqual(h.deleted, [{ root: repo, remote: "origin", branch: "feature/merged", tip: mergedTip }]);
      const outcomes = new Map(result.remoteBranches.map((entry) => [entry.branch, entry]));
      assert.equal(outcomes.get("feature/merged").status, "deleted");
      assert.equal(outcomes.get("feature/moved").status, "skipped");
      assert.match(outcomes.get("feature/moved").message, /moved/);
      assert.equal(git(origin, ["branch", "--list", "feature/merged"]), "");
      assert.ok(git(origin, ["branch", "--list", "feature/moved"]));
      assert.equal(git(repo, ["branch", "--list", "feature/merged"]), "", "the merged local branch went too");
      assert.ok(result.removed.find((entry) => entry.path === merged).recoveryRef);
    });
    await check("the asking agent's own tab elsewhere does not hold a worktree it made; another agent's request still sees it", async () => {
      h.heads = null;
      const mine = add("mine", "feature/mine");
      commitFile(mine, "mine.txt", "x\n", "given up work");
      git(mine, ["push", "-q", "-u", "origin", "feature/mine"]);
      h.state.workspaces.push({
        id: "ws-mine",
        name: "mine",
        cwd: mine,
        color: "#123456",
        workers: [],
        copyBranch: {
          repoCwd: repo,
          branch: "feature/mine",
          city: "mine",
          mode: "fork",
          createdAt: new Date().toISOString(),
          createdBy: { kind: "agent", client: "claude-code", paneId: "pane-maker" },
        },
      });
      // Its maker's tab is open, its shell in another folder.
      h.openPanes.set("pane-maker", scratch);
      const own = { caller: { role: "studio", client: "claude-code", paneId: "pane-maker" }, agent: { client: "claude-code", workspaceName: "repo" } };
      const other = { caller: { role: "studio", client: "codex", paneId: "pane-other" }, agent: { client: "codex", workspaceName: "repo" } };
      const scanned = async (caller) =>
        (await tool.scanForAgent(deps, { checkMerge: true }, caller)).worktrees.find((entry) => entry.path === mine);
      assert.deepEqual((await scanned(own.caller)).inUse, [], "its own tab is not a use");
      assert.match((await scanned(other.caller)).inUse.join(" "), /which made it/);
      assert.match((await scanned(undefined)).inUse.join(" "), /which made it/);

      const before = asked.length;
      const refused = await tool.removeForAgent(deps, { items: [{ path: mine }] }, other, asker(null));
      assert.equal(refused.status, "nothing-to-remove");
      assert.equal(refused.blockedBeforeAsking, 1, "the agent learns every row was blocked");
      assert.match(refused.note, /the user was not asked\. 1 of 1 could not be removed/);
      assert.match(refused.skipped[0].reason, /In use: the agent in .*which made it/);
      assert.equal(asked.length, before, "another agent's request is refused before the user is asked");
      assert.ok(fs.existsSync(mine));

      const result = await tool.removeForAgent(
        deps,
        { items: [{ path: mine }] },
        own,
        asker((request) => {
          assert.equal(request.items[0].blocked, null, "the maker's own request may be ticked");
          return {
            id: "z",
            approved: true,
            items: request.items.map((entry) => ({ repoRoot: entry.repoRoot, path: entry.path, remove: true, deleteRemoteBranch: false })),
            deleteMergedBranches: true,
          };
        }),
      );
      assert.equal(asked.length, before + 1, "the maker's request still goes through the user's dialog");
      assert.deepEqual(result.removed.map((entry) => entry.path), [mine], JSON.stringify(result.skipped));
      assert.equal(fs.existsSync(mine), false);
      assert.ok(git(repo, ["branch", "--list", "feature/mine"]), "a branch that is not merged stays");
      h.openPanes.delete("pane-maker");
    });
    await check("a worktree whose branch changed between the scan and the full check is blocked and never removed", async () => {
      h.heads = null;
      const switcher = add("switcher", "feature/switch-old");
      commitFile(switcher, "switch.txt", "w\n", "switch work");
      mergeIntoMain("feature/switch-old");
      git(repo, ["branch", "feature/switch-new", "feature/switch-old"]);
      // The size measure runs after the scan and before the full check: the
      // branch moves there, as another tab could.
      const measure = deps.measureSizes;
      deps.measureSizes = async (items) => {
        if (items.some((entry) => entry.path === switcher)) git(switcher, ["switch", "-q", "feature/switch-new"]);
        return measure(items);
      };
      try {
        const result = await tool.removeForAgent(
          deps,
          { items: [{ path: switcher }, { path: stale }] },
          context,
          asker((request) => {
            const row = request.items.find((entry) => entry.path === switcher);
            assert.equal(row.blocked, "Its branch changed while this dialog was being prepared. Scan again.");
            assert.equal(row.branch, "feature/switch-new", "the dialog names the branch the removal would act on");
            // Neither the dialog's own answer nor a forged one sends it as remove.
            const ticked = Object.fromEntries(request.items.map((entry) => [`${entry.repoRoot}\u0000${entry.path}`, { remove: true, deleteRemoteBranch: true }]));
            const fromDialog = approval.approvalAnswerItems(request.items, ticked, true).find((entry) => entry.path === switcher);
            assert.equal(fromDialog.remove, false);
            return {
              id: "w",
              approved: true,
              items: request.items.map((entry) => ({ repoRoot: entry.repoRoot, path: entry.path, remove: entry.path === switcher, deleteRemoteBranch: true })),
              deleteMergedBranches: true,
            };
          }),
        );
        assert.equal(result.removed.length, 0, JSON.stringify(result.removed));
        assert.equal(result.blockedBeforeAsking, 1);
        assert.match(new Map(result.skipped.map((entry) => [entry.path, entry.reason])).get(switcher), /branch changed/);
        assert.ok(fs.existsSync(switcher));
        assert.ok(git(repo, ["branch", "--list", "feature/switch-old"]), "the scanned branch stays");
        assert.ok(git(repo, ["branch", "--list", "feature/switch-new"]), "the checked branch stays");
      } finally {
        deps.measureSizes = measure;
      }
    });
    await check("without a remote, no remote branch is offered", async () => {
      git(repo, ["remote", "remove", "origin"]);
      h.heads = null;
      const result = await tool.scanForAgent(deps, { checkMerge: true });
      const staleItem = result.worktrees.find((entry) => entry.path === stale);
      assert.equal(staleItem.remoteBranch.remote, null);
      assert.equal(staleItem.remoteBranch.deletable, false);
      assert.equal(staleItem.remoteBranch.why, "The repository has no remote.");
    });
    await check("paths that are not worktrees are skipped without asking", async () => {
      const before = asked.length;
      const result = await tool.removeForAgent(deps, { items: [{ path: repo }, { path: path.join(scratch, "nowhere") }] }, context, asker(null));
      assert.equal(result.status, "nothing-to-remove");
      assert.equal(result.skipped.length, 2);
      assert.equal(asked.length, before, "the user was not asked");
    });
    await check("the removal audit names the agent", async () => {
      const lines = fs
        .readFileSync(path.join(home, "logs", "worktree-audit.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(lines.some((line) => line.outcome === "removed" && line.caller.client === "claude-code"));
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    for (const entry of bundles) fs.rmSync(entry.outfile, { force: true });
  }
  console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
