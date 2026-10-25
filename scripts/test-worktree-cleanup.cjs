// Integration test for src/main/worktree-cleanup/, the worktree cleanup
// screen's scan, full removal check and removal, plus the pure filters in
// src/shared/worktree-cleanup.ts. Every module is bundled with esbuild (like
// test-agent-worktrees.cjs) and driven against throwaway git repositories
// with an in-memory AppState and fake terminals, runs, servers and GitHub.
// A fake home and git config: nothing reads or writes the user's own.
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
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

function refExists(cwd, ref) {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

async function bundle(entry, name) {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `spark-worktree-cleanup-${name}-${process.pid}.cjs`);
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

async function main() {
  const bundles = await Promise.all([
    bundle("src/main/worktree-cleanup/scan.ts", "scan"),
    bundle("src/main/worktree-cleanup/remove.ts", "remove"),
    bundle("src/main/worktree-cleanup/space.ts", "space"),
    bundle("src/shared/worktree-cleanup.ts", "shared"),
    bundle("src/main/agent-worktrees.ts", "agent"),
  ]);
  const [scanMod, removeMod, space, shared, agent] = bundles.map((entry) => entry.mod);

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-wt-cleanup-")));
  const home = path.join(scratch, "home");
  fs.mkdirSync(home, { recursive: true });
  const gitConfig = path.join(scratch, "gitconfig");
  fs.writeFileSync(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.HOME = home;

  const children = [];
  try {
    const origin = path.join(scratch, "origin.git");
    const repo = path.join(scratch, "repo");
    const trees = path.join(scratch, "trees");
    fs.mkdirSync(trees);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    commitFile(repo, ".gitignore", "node_modules/\n.env.local\nvendor/\n", "ignore");
    commitFile(repo, "README.md", "# test\n", "init");
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);

    const add = (name, branch, extra = []) => {
      const dir = path.join(trees, name);
      git(repo, ["worktree", "add", "-q", ...extra, dir, ...(branch ? ["-b", branch] : [])]);
      return dir;
    };
    // Merged with a merge commit.
    const merged = add("merged", "feature/merged");
    commitFile(merged, "merged.txt", "merged\n", "merged work");
    git(repo, ["merge", "-q", "--no-ff", "-m", "merge feature/merged", "feature/merged"]);
    // Squash-merged: the same change landed as one new commit.
    const squash = add("squash", "feature/squash");
    commitFile(squash, "squash.txt", "one\n", "squash 1");
    commitFile(squash, "squash.txt", "one\ntwo\n", "squash 2");
    commitFile(repo, "squash.txt", "one\ntwo\n", "squash feature/squash");
    git(repo, ["push", "-q", "origin", "main"]);
    // Unmerged: two commits main lacks.
    const unmerged = add("unmerged", "feature/unmerged");
    commitFile(unmerged, "a.txt", "a\n", "unmerged a");
    commitFile(unmerged, "b.txt", "b\n", "unmerged b");
    // Merged on GitHub by rebase: only the pull request proves it.
    const prMerged = add("pr-merged", "feature/pr-merged");
    const prTip = commitFile(prMerged, "pr.txt", "pr\n", "pr work");
    // No commits of its own, but local edits.
    const dirty = add("dirty", "feature/dirty");
    fs.writeFileSync(path.join(dirty, "README.md"), "# changed\n");
    fs.writeFileSync(path.join(dirty, "notes.txt"), "untracked notes\n");
    // Clean, but holds an ignored file a fresh checkout would not bring back.
    const envfile = add("envfile", "feature/envfile");
    fs.writeFileSync(path.join(envfile, ".env.local"), "SECRET=1\n");
    fs.mkdirSync(path.join(envfile, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(envfile, "node_modules", "pkg", "index.js"), "x\n");
    // In use by a terminal.
    const busy = add("busy", "feature/busy");
    // Locked.
    const locked = add("locked", "feature/locked");
    git(repo, ["worktree", "lock", locked]);
    // Detached with a commit no ref holds.
    const detached = add("detached", null, ["--detach"]);
    const orphan = commitFile(detached, "orphan.txt", "orphan\n", "orphan work");
    // Gone from disk.
    const missing = add("missing", "feature/missing");
    fs.rmSync(missing, { recursive: true, force: true });
    // A nested checkout inside an ignored folder.
    const nested = add("nested", "feature/nested");
    execFileSync("git", ["init", "-q", path.join(nested, "vendor", "lib")]);
    // A long-lived branch, merged, checked out in a worktree.
    const develop = add("develop", "develop");
    // A Codara copy-branch workspace made by an agent, for the merged one.
    const mergedHead = git(merged, ["rev-parse", "HEAD"]);

    const auditFile = path.join(home, "logs", "worktree-audit.jsonl");
    const h = {
      state: {
        workspaces: [
          { id: "ws-repo", name: "repo", cwd: repo, color: "#123456", workers: [] },
          {
            id: "ws-merged",
            name: "merged copy",
            cwd: merged,
            color: "#123456",
            workers: [],
            copyBranch: {
              repoCwd: repo,
              branch: "feature/merged",
              baseBranch: "main",
              city: "merged",
              mode: "fork",
              createdAt: "2026-10-01T00:00:00Z",
              createdBy: { kind: "agent", client: "claude-code", paneId: "pane-gone" },
            },
          },
          { id: "ws-remote", name: "remote", cwd: "ssh://host/srv/app", color: "#123456", workers: [], remote: { hostId: "host" } },
          { id: "ws-plain", name: "plain folder", cwd: scratch, color: "#123456", workers: [] },
        ],
        workspaceRailOrder: ["ws-repo", "ws-merged", "ws-remote", "ws-plain"],
        activeWorkspaceId: "ws-merged",
      },
      published: 0,
      runs: [],
      sessionsUnder: {},
      sessionCwds: {},
      terminals: [],
      processes: new Map(),
      servers: {},
      pulls: {
        open: [{ number: 7, url: "https://example.invalid/pull/7", title: "Unmerged work", headBranch: "feature/unmerged", isDraft: true }],
        merged: [
          {
            number: 5,
            url: "https://example.invalid/pull/5",
            headRefName: "feature/pr-merged",
            headRefOid: prTip,
            baseRefName: "main",
            isCrossRepository: false,
          },
        ],
      },
      prFails: false,
      now: new Date("2026-10-12T10:00:00Z"),
      invalidated: [],
    };
    const deps = {
      loadState: async () => structuredClone(h.state),
      updateState: async (mutator) => {
        h.state = await mutator(structuredClone(h.state));
        return h.state;
      },
      publishState: () => {
        h.published += 1;
      },
      invalidateGitCache: (cwd) => h.invalidated.push(cwd),
      listRuns: async () => h.runs,
      sessionCwd: (paneId) => h.sessionCwds[paneId] ?? null,
      sessionsUnderCwd: (dir) => h.sessionsUnder[dir] ?? [],
      listRendererTerminals: async () => h.terminals,
      processesUnderCwds: async (dirs) => new Map(dirs.map((dir) => [dir, h.processes.get(dir) ?? []])),
      runningServers: (id) => h.servers[id] ?? 0,
      pullRequests: async () => {
        if (h.prFails) throw new Error("gh missing");
        return h.pulls;
      },
      regenerableIgnored: async () => [],
      appPaths: () => [path.join(scratch, "app-not-here")],
      isProtectedPath: () => false,
      audit: agent.createWorktreeAuditLog(auditFile),
      now: () => h.now,
    };
    h.sessionsUnder[busy] = ["pane-busy"];

    // ── Scan ───────────────────────────────────────────────────────────────
    const { scan, worktrees } = await scanMod.scanWorktreeCleanup(deps, {
      sizeOf: (id) => (id === squash ? { bytes: 2048, complete: true, measuredAt: 1 } : null),
    });
    const row = (dir) => scan.rows.find((entry) => entry.id === dir);
    await check("the scan lists every worktree of the repository once", async () => {
      assert.equal(scan.repos.length, 1, "the plain folder and the SSH workspace add no repository");
      assert.equal(scan.repos[0].root, repo);
      assert.equal(scan.repos[0].base, "origin/main");
      assert.deepEqual(scan.repos[0].workspaceIds.sort(), ["ws-merged", "ws-repo"]);
      assert.equal(scan.repos[0].pullRequests, "known");
      assert.equal(scan.rows.length, 13);
      assert.equal(worktrees.length, 13);
      assert.equal(row(repo).isMain, true);
      assert.equal(scan.rows.filter((entry) => entry.isMain).length, 1);
      assert.equal(row(repo).merge.state, "base");
      assert.equal(row(repo).workspace.id, "ws-repo");
      assert.equal(scan.processScan, true);
    });
    await check("the scan reads git state, activity, links and cached sizes", async () => {
      assert.equal(row(merged).merge.state, "merged");
      assert.equal(row(merged).merge.proof, "ancestor");
      assert.equal(row(merged).workspace.id, "ws-merged");
      assert.equal(row(merged).workspace.createdBy, "agent");
      assert.equal(row(squash).merge.proof, "content-in-target");
      assert.deepEqual(row(squash).size, { bytes: 2048, complete: true, measuredAt: 1 });
      assert.equal(row(unmerged).merge.state, "unmerged");
      assert.equal(row(unmerged).base.ahead, 2);
      assert.equal(row(unmerged).base.name, "origin/main");
      assert.deepEqual(
        { number: row(unmerged).pullRequest.number, state: row(unmerged).pullRequest.state },
        { number: 7, state: "draft" },
      );
      assert.equal(row(prMerged).merge.proof, "pull-request");
      assert.equal(row(prMerged).pullRequest.state, "merged");
      assert.deepEqual(row(dirty).dirty, { tracked: 1, untracked: 1, inProgress: null });
      assert.deepEqual(row(merged).dirty, { tracked: 0, untracked: 0, inProgress: null });
      assert.equal(row(busy).inUse[0].kind, "terminal");
      assert.equal(row(locked).locked, true);
      assert.equal(row(detached).branch, null);
      assert.equal(row(detached).merge.state, "unmerged");
      assert.equal(row(missing).missing, true);
      assert.equal(row(repo).upstream.name, "origin/main");
      assert.ok(row(unmerged).lastActivityAt > Date.now() - 10 * 60 * 1000, "fresh commits count as activity");
    });
    await check("a scan without GitHub still lists everything", async () => {
      h.prFails = true;
      const offline = (await scanMod.scanWorktreeCleanup(deps)).scan;
      h.prFails = false;
      assert.equal(offline.repos[0].pullRequests, "unavailable");
      const pr = offline.rows.find((entry) => entry.id === prMerged);
      assert.equal(pr.merge.state, "unmerged", "without the pull request nothing proves the rebase merge");
      assert.equal(pr.pullRequest, null);
    });

    // ── Filters (shared) ───────────────────────────────────────────────────
    await check("filters, sorting and the removal outlook", async () => {
      const now = Date.now();
      const rows = scan.rows;
      const base = { query: "", repo: null, merged: false, staleDays: null, largeBytes: null };
      const mergedOnly = shared.filterWorktreeRows(rows, { ...base, merged: true }, now).map((entry) => entry.id);
      assert.ok(mergedOnly.includes(merged) && mergedOnly.includes(squash) && mergedOnly.includes(prMerged));
      assert.ok(!mergedOnly.includes(unmerged) && !mergedOnly.includes(repo));
      assert.deepEqual(
        shared.filterWorktreeRows(rows, { ...base, query: "SQUASH" }, now).map((entry) => entry.id),
        [squash],
      );
      assert.deepEqual(
        shared.filterWorktreeRows(rows, { ...base, query: "#7" }, now).map((entry) => entry.id),
        [unmerged],
        "a pull request number finds its worktree",
      );
      assert.deepEqual(
        shared.filterWorktreeRows(rows, { ...base, largeBytes: 1024 }, now).map((entry) => entry.id),
        [squash],
        "an unmeasured worktree is never large",
      );
      assert.equal(shared.filterWorktreeRows(rows, { ...base, staleDays: 14 }, now).length, 0);
      assert.equal(shared.filterWorktreeRows(rows, { ...base, staleDays: 14 }, now + 30 * 86_400_000).length, rows.length);
      assert.equal(shared.filterWorktreeRows(rows, { ...base, repo: "/elsewhere" }, now).length, 0);
      const bySize = shared.sortWorktreeRows(rows, "size");
      assert.equal(bySize[0].id, squash);
      const byName = shared.sortWorktreeRows(rows, "name");
      assert.equal(byName[0].id, repo, "the main checkout heads its repository");
      // Two repositories with the same folder name stay apart, each under its main checkout.
      const twin = (repoRoot, branch, isMain) => ({ ...row(merged), id: `${repoRoot}/${branch}`, repoRoot, repoName: "app", branch, isMain });
      const twins = [
        twin("/b/app", "zeta", false),
        twin("/a/app", "beta", false),
        twin("/b/app", "main", true),
        twin("/a/app", "main", true),
        twin("/b/app", "alpha", false),
        twin("/a/app", "omega", false),
      ];
      for (const order of [twins, [...twins].reverse()]) {
        assert.deepEqual(
          shared.sortWorktreeRows(order, "name").map((entry) => entry.id),
          ["/a/app/main", "/a/app/beta", "/a/app/omega", "/b/app/main", "/b/app/alpha", "/b/app/zeta"],
        );
      }
      assert.equal(shared.removalOutlook(row(repo)).blocked, "The main checkout is never removed.");
      assert.match(shared.removalOutlook(row(busy)).blocked, /In use: 1 open terminal/);
      assert.match(shared.removalOutlook(row(locked)).blocked, /Locked/);
      assert.deepEqual(shared.removalOutlook(row(merged)), { blocked: null, needsDirtyConfirm: false, needsUnmergedConfirm: false });
      assert.equal(shared.removalOutlook(row(dirty)).needsDirtyConfirm, true);
      assert.equal(shared.removalOutlook(row(unmerged)).needsUnmergedConfirm, true);
      assert.equal(shared.removalOutlook(row(missing)).needsUnmergedConfirm, false);
      assert.equal(shared.formatBytes(1536), "2 KB");
      assert.equal(shared.formatBytes(1.5 * 1024 * 1024), "1.5 MB");
      assert.equal(shared.formatBytes(500 * 1024 * 1024), "500 MB");
      assert.equal(shared.formatAge(now - 3 * 86_400_000, now), "3 days ago");
    });

    await check("rows keep their place while sizes land, until the user sorts again", async () => {
      const a = { id: "/a", size: { bytes: 10 } };
      const b = { id: "/b", size: { bytes: 20 } };
      const c = { id: "/c", size: null };
      const positions = shared.rowPositions([b, a, c]);
      // /c measures largest: a fresh sort would move it to the top.
      const bigC = { ...c, size: { bytes: 99 } };
      const live = [bigC, b, a];
      const kept = shared.keepRowOrder(live, positions);
      assert.deepEqual(kept.map((entry) => entry.id), ["/b", "/a", "/c"], "the row under the pointer stays put");
      assert.equal(kept[2], bigC, "the kept order carries the new size");
      assert.equal(shared.orderDrifted(kept, live), true, "the header offers to sort again");
      assert.equal(shared.orderDrifted(live, live), false);
      const withNew = shared.keepRowOrder([{ id: "/d" }, ...live], positions);
      assert.deepEqual(withNew.map((entry) => entry.id), ["/b", "/a", "/c", "/d"], "a row the order does not know goes last");
    });

    await check("the kept-branch log command pastes safely into a shell", async () => {
      assert.equal(
        shared.keptBranchLogCommand({ repoRoot: "/r", branch: "feature/x", target: "origin/main" }),
        'git -C "/r" log --oneline origin/main..feature/x --',
      );
      assert.equal(shared.keptBranchLogCommand({ repoRoot: "/r", branch: "wip", target: null }), 'git -C "/r" log --oneline wip --');
      // Git allows $, ;, & and backticks in branch names; none may run.
      assert.equal(
        shared.keptBranchLogCommand({ repoRoot: "/r", branch: "x;$(touch pwned)`id`&", target: "main" }),
        "git -C \"/r\" log --oneline 'main..x;$(touch pwned)`id`&' --",
      );
      assert.equal(shared.shellArg("it's"), "'it'\\''s'");
      const out = execFileSync("sh", ["-c", `printf %s ${shared.shellArg("a'b $(echo no) `echo no`")}`], { encoding: "utf8" });
      assert.equal(out, "a'b $(echo no) `echo no`");
    });

    // ── The full check ─────────────────────────────────────────────────────
    const checks = await removeMod.checkCleanupTargets(
      deps,
      [repo, merged, unmerged, dirty, envfile, busy, locked, detached, missing, nested, develop, path.join(scratch, "home")].map(
        (dir) => ({ repoRoot: repo, path: dir }),
      ).concat([{ repoRoot: "/not/a/repo", path: merged }, { repoRoot: repo, path: "relative/path" }]),
    );
    const checkOf = (dir) => checks.find((entry) => entry.path === dir);
    await check("the full check sorts what can be confirmed from what cannot", async () => {
      assert.equal(checks.length, 13, "a relative path is dropped");
      assert.equal(checkOf(repo).blockers[0].code, "MAIN_CHECKOUT");
      assert.equal(checkOf(busy).blockers[0].code, "IN_USE");
      assert.equal(checkOf(locked).blockers[0].code, "LOCKED");
      assert.equal(checkOf(nested).blockers[0].code, "NESTED_CHECKOUT");
      assert.equal(checkOf(path.join(scratch, "home")).blockers[0].code, "NOT_REGISTERED");
      assert.equal(checks.find((entry) => entry.repoRoot === "/not/a/repo").blockers[0].code, "NOT_REGISTERED");
      assert.deepEqual(checkOf(merged).blockers, []);
      assert.equal(checkOf(merged).localWork, null);
      assert.equal(checkOf(merged).unmerged, null);
      assert.equal(checkOf(merged).branchDeletable, true);
      assert.equal(checkOf(develop).branchDeletable, false, "a long-lived branch is kept");
      assert.equal(checkOf(dirty).localWork.tracked, 1);
      assert.equal(checkOf(dirty).localWork.untracked, 1);
      assert.deepEqual(checkOf(envfile).localWork.ignored, [".env.local"], "node_modules is regenerable");
      assert.equal(checkOf(unmerged).unmerged.ahead, 2);
      assert.equal(checkOf(unmerged).unmerged.orphaned, false);
      assert.deepEqual(checkOf(unmerged).unmerged.commits, ["unmerged b", "unmerged a"]);
      assert.equal(checkOf(detached).unmerged.orphaned, true);
      assert.equal(checkOf(missing).alreadyRemoved, true);
      assert.match(checkOf(merged).fingerprint, /^[0-9a-f]{32}$/);
    });

    const item = (dir, extra = {}) => ({
      repoRoot: repo,
      path: dir,
      fingerprint: checkOf(dir)?.fingerprint ?? "none",
      confirmDirty: false,
      confirmUnmerged: false,
      ...extra,
    });

    // ── Removal ────────────────────────────────────────────────────────────
    await check("a merged worktree goes, with its branch and its rail row", async () => {
      const forgotten = [];
      const result = await removeMod.removeCleanupWorktrees(
        deps,
        { items: [item(merged)], deleteMergedBranches: true },
        { sizeOf: () => ({ bytes: 4096, complete: true, measuredAt: 1 }), forgetSize: (id) => forgotten.push(id) },
      );
      const [outcome] = result.outcomes;
      assert.equal(outcome.status, "removed", JSON.stringify(outcome));
      assert.equal(outcome.branchDeleted, true);
      assert.equal(outcome.reclaimedBytes, 4096);
      assert.equal(outcome.workspaceRemoved, "merged copy");
      assert.ok(!fs.existsSync(merged));
      assert.ok(!refExists(repo, "refs/heads/feature/merged"));
      assert.equal(outcome.recoveryRef, "refs/codara/removed-worktrees/2026-10-12/ws-merged");
      assert.equal(git(repo, ["rev-parse", outcome.recoveryRef]), mergedHead);
      assert.deepEqual(forgotten, [merged]);
      assert.ok(!h.state.workspaces.some((workspace) => workspace.id === "ws-merged"));
      assert.equal(h.state.activeWorkspaceId, "ws-repo", "the active row falls back to its repository");
      assert.deepEqual(h.state.workspaceRailOrder, ["ws-repo", "ws-remote", "ws-plain"]);
      assert.equal(h.published, 1);
      assert.ok(h.invalidated.includes(repo));
      const audit = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(audit.at(-1).outcome, "removed");
      assert.equal(audit.at(-1).caller.client, "cleanup-screen");
    });

    await check("what cannot be confirmed away is refused", async () => {
      const result = await removeMod.removeCleanupWorktrees(
        deps,
        {
          items: [
            item(repo, { confirmDirty: true, confirmUnmerged: true }),
            item(busy, { confirmDirty: true, confirmUnmerged: true }),
            item(locked, { confirmDirty: true, confirmUnmerged: true }),
            item(nested, { confirmDirty: true, confirmUnmerged: true }),
          ],
          deleteMergedBranches: true,
        },
      );
      assert.deepEqual(
        result.outcomes.map((outcome) => [outcome.status, outcome.code]),
        [
          ["refused", "MAIN_CHECKOUT"],
          ["refused", "IN_USE"],
          ["refused", "LOCKED"],
          ["refused", "NESTED_CHECKOUT"],
        ],
      );
      for (const dir of [repo, busy, locked, nested]) assert.ok(fs.existsSync(dir));
    });

    await check("dirty and unmerged work needs its own confirmation", async () => {
      let result = await removeMod.removeCleanupWorktrees(deps, {
        items: [item(dirty), item(unmerged), item(envfile)],
        deleteMergedBranches: true,
      });
      assert.deepEqual(
        result.outcomes.map((outcome) => outcome.code),
        ["DIRTY_NOT_CONFIRMED", "UNMERGED_NOT_CONFIRMED", "DIRTY_NOT_CONFIRMED"],
      );
      assert.ok(fs.existsSync(dirty) && fs.existsSync(unmerged) && fs.existsSync(envfile));
      // Confirming the wrong half is not enough either.
      result = await removeMod.removeCleanupWorktrees(deps, {
        items: [item(unmerged, { confirmDirty: true })],
        deleteMergedBranches: true,
      });
      assert.equal(result.outcomes[0].code, "UNMERGED_NOT_CONFIRMED");
      // Only a literal true confirms.
      result = await removeMod.removeCleanupWorktrees(deps, {
        items: [item(dirty, { confirmDirty: "true" }), item(unmerged, { confirmUnmerged: 1 })],
        deleteMergedBranches: true,
      });
      assert.deepEqual(
        result.outcomes.map((outcome) => outcome.code),
        ["DIRTY_NOT_CONFIRMED", "UNMERGED_NOT_CONFIRMED"],
      );
      assert.ok(fs.existsSync(dirty) && fs.existsSync(unmerged));
    });

    await check("a worktree that changed since the review is refused", async () => {
      fs.writeFileSync(path.join(dirty, "more.txt"), "more\n");
      const result = await removeMod.removeCleanupWorktrees(deps, {
        items: [item(dirty, { confirmDirty: true })],
        deleteMergedBranches: true,
      });
      assert.equal(result.outcomes[0].code, "CHANGED");
      assert.ok(fs.existsSync(dirty));
      fs.rmSync(path.join(dirty, "more.txt"));
    });

    await check("confirmed local work is removed and saved under a recovery ref", async () => {
      const result = await removeMod.removeCleanupWorktrees(deps, {
        items: [item(dirty, { confirmDirty: true }), item(envfile, { confirmDirty: true })],
        deleteMergedBranches: true,
      });
      const [dirtyOutcome, envOutcome] = result.outcomes;
      assert.equal(dirtyOutcome.status, "removed", JSON.stringify(dirtyOutcome));
      assert.ok(!fs.existsSync(dirty));
      assert.ok(dirtyOutcome.changesRef.endsWith("-changes"));
      assert.equal(git(repo, ["show", `${dirtyOutcome.changesRef}:notes.txt`]), "untracked notes");
      assert.equal(git(repo, ["show", `${dirtyOutcome.changesRef}:README.md`]), "# changed");
      assert.equal(dirtyOutcome.branchDeleted, true, "its branch had no commits of its own");
      assert.equal(envOutcome.status, "removed");
      assert.ok(!fs.existsSync(envfile));
      assert.throws(() => git(repo, ["show", `${envOutcome.changesRef}:.env.local`]), "ignored files are never copied into git");
    });

    await check("an unmerged branch is kept and listed for review", async () => {
      const result = await removeMod.removeCleanupWorktrees(deps, {
        items: [item(unmerged, { confirmUnmerged: true }), item(detached, { confirmUnmerged: true })],
        deleteMergedBranches: true,
      });
      const [branchOutcome, detachedOutcome] = result.outcomes;
      assert.equal(branchOutcome.status, "removed", JSON.stringify(branchOutcome));
      assert.equal(branchOutcome.branchDeleted, false);
      assert.equal(branchOutcome.branchKept, "unmerged");
      assert.ok(refExists(repo, "refs/heads/feature/unmerged"));
      assert.deepEqual(result.keptBranches, [{ repoRoot: repo, branch: "feature/unmerged", ahead: 2, target: "origin/main" }]);
      assert.equal(detachedOutcome.status, "removed");
      assert.equal(git(repo, ["rev-parse", detachedOutcome.recoveryRef]), orphan, "the orphan commit stays reachable");
    });

    await check("squash and pull request merges delete the branch; long-lived ones stay", async () => {
      const again = await removeMod.checkCleanupTargets(deps, [squash, prMerged, develop].map((dir) => ({ repoRoot: repo, path: dir })));
      const result = await removeMod.removeCleanupWorktrees(deps, {
        items: again.map((entry) => ({ ...item(entry.path), fingerprint: entry.fingerprint })),
        deleteMergedBranches: true,
      });
      assert.deepEqual(
        result.outcomes.map((outcome) => [outcome.status, outcome.branchDeleted, outcome.branchKept ?? null]),
        [
          ["removed", true, null],
          ["removed", true, null],
          ["removed", false, "protected"],
        ],
      );
      assert.ok(refExists(repo, "refs/heads/develop"));
      assert.equal(git(repo, ["rev-parse", result.outcomes[1].recoveryRef]), prTip);
    });

    await check("a folder that is already gone loses only its registration", async () => {
      const result = await removeMod.removeCleanupWorktrees(deps, { items: [item(missing)], deleteMergedBranches: false });
      assert.equal(result.outcomes[0].status, "already-removed");
      assert.equal(result.outcomes[0].branchKept, "not-requested");
      assert.ok(!git(repo, ["worktree", "list", "--porcelain"]).includes(missing));
      assert.ok(refExists(repo, "refs/heads/feature/missing"));
    });

    const confirmedItems = (list) =>
      list.map((entry) => ({
        repoRoot: repo,
        path: entry.path,
        fingerprint: entry.fingerprint,
        confirmDirty: true,
        confirmUnmerged: true,
      }));

    await check("a locked worktree whose folder is away stays registered", async () => {
      const away = add("away", "feature/away");
      git(repo, ["worktree", "lock", "--reason", "on a drive that is not mounted", away]);
      fs.rmSync(away, { recursive: true, force: true });
      const [awayCheck] = await removeMod.checkCleanupTargets(deps, [{ repoRoot: repo, path: away }]);
      assert.equal(awayCheck.blockers[0]?.code, "LOCKED", JSON.stringify(awayCheck));
      const result = await removeMod.removeCleanupWorktrees(deps, { items: confirmedItems([awayCheck]), deleteMergedBranches: true });
      assert.equal(result.outcomes[0].code, "LOCKED");
      assert.ok(git(repo, ["worktree", "list", "--porcelain"]).includes(away), "the registration stays");
      git(repo, ["worktree", "unlock", away]);
      git(repo, ["worktree", "prune"]);
    });

    await check("a gone detached worktree keeps its commit under a recovery ref", async () => {
      const goneDetached = add("gone-detached", null, ["--detach"]);
      const lonely = commitFile(goneDetached, "lonely.txt", "lonely\n", "lonely work");
      fs.rmSync(goneDetached, { recursive: true, force: true });
      const [goneCheck] = await removeMod.checkCleanupTargets(deps, [{ repoRoot: repo, path: goneDetached }]);
      assert.equal(goneCheck.alreadyRemoved, true);
      assert.equal(goneCheck.unmerged.orphaned, true);
      const result = await removeMod.removeCleanupWorktrees(deps, { items: confirmedItems([goneCheck]), deleteMergedBranches: true });
      const [outcome] = result.outcomes;
      assert.equal(outcome.status, "already-removed", JSON.stringify(outcome));
      assert.ok(!git(repo, ["worktree", "list", "--porcelain"]).includes(goneDetached));
      assert.ok(outcome.recoveryRef, "the registration was all that held the commit");
      assert.equal(git(repo, ["rev-parse", outcome.recoveryRef]), lonely);
    });

    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await check("a removal git gives up on partway keeps its recovery refs", async () => {
        // git deletes what it can, then drops the registration even though a
        // folder it could not delete is left: the refs are all that remain.
        const stuck = add("stuck", null, ["--detach"]);
        const stuckTip = commitFile(stuck, "stuck.txt", "stuck\n", "stuck work");
        fs.writeFileSync(path.join(stuck, "draft.txt"), "draft\n");
        fs.mkdirSync(path.join(stuck, "readonly"));
        fs.writeFileSync(path.join(stuck, "readonly", "pinned.txt"), "pinned\n");
        fs.chmodSync(path.join(stuck, "readonly"), 0o555);
        try {
          const [stuckCheck] = await removeMod.checkCleanupTargets(deps, [{ repoRoot: repo, path: stuck }]);
          assert.deepEqual(stuckCheck.blockers, []);
          const result = await removeMod.removeCleanupWorktrees(deps, {
            items: confirmedItems([stuckCheck]),
            deleteMergedBranches: true,
          });
          const [outcome] = result.outcomes;
          assert.equal(outcome.status, "failed", JSON.stringify(outcome));
          // Which files go before git stops depends on the directory order;
          // the registration is gone either way.
          assert.ok(fs.existsSync(stuck));
          assert.ok(!git(repo, ["worktree", "list", "--porcelain"]).includes(stuck), "git dropped its registration");
          assert.match(outcome.message, /part of the folder/);
          assert.equal(git(repo, ["rev-parse", outcome.recoveryRef]), stuckTip, "the last commit is still saved");
          assert.equal(git(repo, ["show", `${outcome.changesRef}:draft.txt`]), "draft", "the uncommitted work too");
          const audit = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
          assert.equal(audit.at(-1).recoveryRef, outcome.recoveryRef);
        } finally {
          fs.chmodSync(path.join(stuck, "readonly"), 0o755);
          git(repo, ["worktree", "prune"]);
        }
      });
    }

    await check("a terminal opened in a waiting worktree mid-batch keeps it", async () => {
      const first = add("batch-first", "feature/batch-first");
      const second = add("batch-second", "feature/batch-second");
      const [checkA, checkB] = await removeMod.checkCleanupTargets(deps, [
        { repoRoot: repo, path: first },
        { repoRoot: repo, path: second },
      ]);
      assert.equal(checkA.blockers.length + checkB.blockers.length, 0);
      // While the first worktree is being removed, the user opens a terminal
      // in the second one.
      const lateDeps = {
        ...deps,
        audit: async (entry) => {
          if (entry.path === first && entry.outcome === "removed") h.sessionsUnder[second] = ["pane-late"];
          return deps.audit(entry);
        },
      };
      const result = await removeMod.removeCleanupWorktrees(
        lateDeps,
        {
          items: [first, second].map((dir, index) => ({
            repoRoot: repo,
            path: dir,
            fingerprint: [checkA, checkB][index].fingerprint,
            confirmDirty: false,
            confirmUnmerged: false,
          })),
          deleteMergedBranches: true,
        },
        { usageFreshMs: -1 },
      );
      delete h.sessionsUnder[second];
      assert.equal(result.outcomes[0].status, "removed", JSON.stringify(result.outcomes[0]));
      assert.equal(result.outcomes[1].code, "IN_USE", JSON.stringify(result.outcomes[1]));
      assert.ok(fs.existsSync(second));
      git(repo, ["worktree", "remove", second]);
      git(repo, ["branch", "-D", "feature/batch-second"]);
    });

    await check("an edited file too large to copy skips the snapshot, not the removal", async () => {
      const big = add("big", "feature/big");
      // Sparse: 60 MB by size, almost nothing on disk.
      fs.truncateSync(path.join(big, "README.md"), 60 * 1024 * 1024);
      const [bigCheck] = await removeMod.checkCleanupTargets(deps, [{ repoRoot: repo, path: big }]);
      assert.equal(bigCheck.localWork.tracked, 1);
      const result = await removeMod.removeCleanupWorktrees(deps, { items: confirmedItems([bigCheck]), deleteMergedBranches: true });
      const [outcome] = result.outcomes;
      assert.equal(outcome.status, "removed", JSON.stringify(outcome));
      assert.equal(outcome.changesRef, undefined);
      assert.match(outcome.message, /not saved: the changed files are too large/);
      assert.ok(outcome.recoveryRef);
    });

    await check("in use covers runs, dev servers, the creating agent and processes", async () => {
      const fresh = add("fresh", "feature/fresh");
      h.state.workspaces.push({
        id: "ws-fresh",
        name: "fresh",
        cwd: fresh,
        color: "#123456",
        workers: [],
        copyBranch: {
          repoCwd: repo,
          branch: "feature/fresh",
          city: "fresh",
          createdAt: "2026-10-01T00:00:00Z",
          createdBy: { kind: "agent", paneId: "pane-agent" },
        },
      });
      const usesOf = async () =>
        (await scanMod.scanWorktreeCleanup(deps)).scan.rows.find((entry) => entry.id === fresh).inUse.map((use) => use.kind);
      assert.deepEqual(await usesOf(), []);
      h.runs = [{ id: "run-1", workspaceId: "ws-fresh", status: "running", workerAttempts: [] }];
      h.servers["ws-fresh"] = 1;
      h.sessionCwds["pane-agent"] = repo;
      h.processes.set(fresh, [{ pid: 4242, command: "node server.js" }]);
      assert.deepEqual(await usesOf(), ["run", "server", "agent", "process"]);
      h.runs = [{ id: "run-1", workspaceId: "ws-fresh", status: "complete", workerAttempts: [] }];
      h.servers = {};
      delete h.sessionCwds["pane-agent"];
      h.processes.clear();
      h.terminals = [{ paneId: "pane-r", workspaceId: "ws-other", cwd: path.join(fresh, "src") }];
      assert.deepEqual(await usesOf(), ["terminal"], "a renderer pane whose folder is inside counts");
      h.terminals = [];
      // A pane's own shell is that open terminal, not a second use. A shell
      // whose pane opened elsewhere and moved in with cd is seen only by the
      // process scan, and must still keep the worktree.
      const pids = { "pane-shell": 5151, "pane-elsewhere": 6161 };
      const shellDeps = { ...deps, sessionPid: (pane) => pids[pane] ?? null };
      const shellUses = async () =>
        (await scanMod.scanWorktreeCleanup(shellDeps)).scan.rows.find((entry) => entry.id === fresh).inUse.map((use) => use.kind);
      h.sessionsUnder[fresh] = ["pane-shell"];
      h.processes.set(fresh, [{ pid: 5151, command: "/bin/zsh" }]);
      assert.deepEqual(await shellUses(), ["terminal"], "the pane's shell is not counted twice");
      delete h.sessionsUnder[fresh];
      h.processes.set(fresh, [{ pid: 6161, command: "/bin/zsh" }]);
      assert.deepEqual(await shellUses(), ["process"], "a shell that moved in keeps the worktree");
      const moved = await removeMod.checkCleanupTargets(shellDeps, [{ repoRoot: repo, path: fresh }]);
      assert.equal(moved[0].blockers[0].code, "IN_USE");
      h.processes.clear();
      const appDeps = { ...deps, appPaths: () => [path.join(fresh, "out")] };
      assert.deepEqual(
        (await scanMod.scanWorktreeCleanup(appDeps)).scan.rows.find((entry) => entry.id === fresh).inUse.map((use) => use.kind),
        ["app"],
        "Codara never removes the worktree it runs from",
      );
    });

    await check("removal never touches a path outside the repository's worktrees", async () => {
      const stray = path.join(scratch, "stray");
      fs.mkdirSync(stray);
      fs.writeFileSync(path.join(stray, "keep.txt"), "keep\n");
      const result = await removeMod.removeCleanupWorktrees(deps, {
        items: [{ repoRoot: repo, path: stray, fingerprint: "x", confirmDirty: true, confirmUnmerged: true }],
        deleteMergedBranches: true,
      });
      assert.equal(result.outcomes[0].code, "NOT_REGISTERED");
      assert.ok(fs.existsSync(path.join(stray, "keep.txt")));
      const protectedDeps = { ...deps, isProtectedPath: () => true };
      const checked = await removeMod.checkCleanupTargets(protectedDeps, [{ repoRoot: repo, path: path.join(trees, "fresh") }]);
      assert.equal(checked[0].blockers[0].code, "PROTECTED_PATH");
      // A worktree that holds another tool's home (or the user's) stays too.
      const holdingDeps = { ...deps, protectedRoots: () => [path.join(trees, "fresh", "dot-claude")] };
      const holding = await removeMod.checkCleanupTargets(holdingDeps, [{ repoRoot: repo, path: path.join(trees, "fresh") }]);
      assert.equal(holding[0].blockers[0].code, "PROTECTED_PATH");
      const elsewhereDeps = { ...deps, protectedRoots: () => [path.join(scratch, "home", ".claude")] };
      const elsewhere = await removeMod.checkCleanupTargets(elsewhereDeps, [{ repoRoot: repo, path: path.join(trees, "fresh") }]);
      assert.ok(!elsewhere[0].blockers.some((entry) => entry.code === "PROTECTED_PATH"), "a home outside it is no reason");
    });

    // ── Sizes ──────────────────────────────────────────────────────────────
    await check("sizes: du, the budgeted walk and its lower bound", async () => {
      const sized = path.join(scratch, "sized");
      fs.mkdirSync(path.join(sized, "a", "b"), { recursive: true });
      fs.writeFileSync(path.join(sized, "a", "one.bin"), Buffer.alloc(10_000));
      fs.writeFileSync(path.join(sized, "a", "b", "two.bin"), Buffer.alloc(20_000));
      const walked = await space.measureDirectory(sized, { platform: "win32", now: () => 5 });
      assert.equal(walked.complete, true);
      assert.ok(walked.bytes >= 30_000, `${walked.bytes}`);
      assert.equal(walked.measuredAt, 5);
      const capped = await space.measureDirectory(sized, { platform: "win32", walkMaxEntries: 1 });
      assert.equal(capped.complete, false, "a walk out of budget is a lower bound");
      const fakeDu = await space.measureDirectory(sized, { platform: "linux", du: async () => ({ bytes: 7, complete: true }) });
      assert.equal(fakeDu.bytes, 7);
      const fallback = await space.measureDirectory(sized, { platform: "darwin", du: async () => null });
      assert.equal(fallback.complete, true, "no du falls back to the walk");
      if (process.platform !== "win32") {
        const real = await space.measureDirectory(sized);
        assert.equal(real.complete, true);
        assert.ok(real.bytes >= 30_000, `du counted ${real.bytes}`);
      }
      const gone = await space.measureDirectory(path.join(scratch, "nope"), { platform: "win32" });
      assert.equal(gone.complete, false);
      assert.ok(gone.error);
    });

    await check("sizes: the cache survives a restart and the queue keeps its budget", async () => {
      const file = path.join(home, "worktree-sizes.json");
      const store = space.createSizeStore(file, { saveDelayMs: 1 });
      await store.load();
      store.set("/a", { bytes: 1, complete: true, measuredAt: 100 });
      await store.flush();
      const reread = space.createSizeStore(file);
      await reread.load();
      assert.deepEqual(reread.get("/a"), { bytes: 1, complete: true, measuredAt: 100 });

      let clock = 1_000;
      const events = [];
      const measured = [];
      let release;
      const gate = new Promise((done) => {
        release = done;
      });
      const queue = space.createSizeMeasurer({
        store: reread,
        now: () => clock,
        maxAgeMs: 10_000,
        totalBudgetMs: 5_000,
        measure: async (dir) => {
          measured.push(dir);
          await gate;
          return { bytes: dir.length, complete: true, measuredAt: clock };
        },
        onEvent: (event) => events.push(event),
      });
      reread.set("/fresh", { bytes: 3, complete: true, measuredAt: 900 });
      const added = queue.enqueue([
        { id: "/fresh", path: "/fresh" },
        { id: "/main", path: "/main", priority: -1 },
        { id: "/x", path: "/x" },
        { id: "/y", path: "/y" },
      ]);
      assert.equal(added, 3, "a fresh size is not measured again");
      assert.equal(queue.enqueue([{ id: "/x", path: "/x" }]), 0, "a queued one is not queued twice");
      assert.equal(queue.pending(), 3);
      assert.deepEqual(measured, ["/x"], "one at a time, the main checkout last");
      clock += 6_000;
      release();
      await new Promise((done) => setTimeout(done, 20));
      assert.equal(events[0].measured.id, "/x");
      assert.equal(events.at(-1).budgetSpent, true, "the budget stops the rest");
      assert.equal(queue.pending(), 0);
      assert.deepEqual(reread.get("/x"), { bytes: 2, complete: true, measuredAt: 7_000 });
      assert.equal(queue.enqueue([{ id: "/fresh", path: "/fresh" }], { force: true }), 1, "force measures again");
      queue.cancel();
      assert.equal(queue.pending(), 0);

      // A cancelled measurement that fails late leaves the next one of the
      // same worktree alone.
      const gates = [];
      const restart = space.createSizeMeasurer({
        store: space.createSizeStore(path.join(home, "sizes-restart.json")),
        measure: () =>
          new Promise((resolve, reject) => {
            gates.push({ resolve, reject });
          }),
        onEvent: () => undefined,
      });
      restart.enqueue([{ id: "/z", path: "/z" }]);
      restart.cancel();
      restart.enqueue([{ id: "/z", path: "/z" }]);
      assert.equal(gates.length, 2);
      gates[0].reject(new Error("aborted"));
      await new Promise((done) => setTimeout(done, 10));
      assert.equal(restart.pending(), 1, "the second measurement still counts");
      restart.enqueue([{ id: "/w", path: "/w" }]);
      assert.equal(gates.length, 2, "one at a time: /w waits for /z");
      gates[1].resolve({ bytes: 1, complete: true, measuredAt: 1 });
      await new Promise((done) => setTimeout(done, 10));
      assert.equal(gates.length, 3, "/w starts once /z is done");
      restart.cancel();
    });

    await check("sizes: a removal waits for a cancelled measurement to end", async () => {
      let finish;
      const slow = space.createSizeMeasurer({
        store: space.createSizeStore(path.join(home, "sizes-settle.json")),
        measure: () =>
          new Promise((resolve) => {
            finish = () => resolve({ bytes: 1, complete: true, measuredAt: 1 });
          }),
        onEvent: () => undefined,
      });
      await slow.settled(10);
      slow.enqueue([{ id: "/s", path: "/s" }]);
      slow.cancel();
      assert.equal(slow.pending(), 0);
      let ended = false;
      const waiting = slow.settled(5_000).then(() => {
        ended = true;
      });
      await new Promise((done) => setTimeout(done, 20));
      assert.equal(ended, false, "the cancelled du or walk may still read the folder");
      finish();
      await waiting;
      assert.equal(ended, true);
      slow.enqueue([{ id: "/t", path: "/t" }]);
      const started = Date.now();
      await slow.settled(30);
      assert.ok(Date.now() - started < 2_000, "the wait is bounded");
      slow.cancel();
      finish();
    });

    if (process.platform !== "win32") {
      await check("what worktree setup put in a worktree is not local work, and its links survive removal", async () => {
        // Worktree setup (src/main/worktree-setup/) copied .env.local and
        // linked a folder from the main checkout into this worktree, and
        // recorded both in the worktree's setup manifest.
        const setupTree = add("with-setup", "feature/with-setup");
        fs.writeFileSync(path.join(repo, ".git", "info", "exclude"), "linked-cache\n");
        const shared = path.join(repo, "linked-cache");
        fs.mkdirSync(shared, { recursive: true });
        fs.writeFileSync(path.join(shared, "keep.txt"), "the main checkout's own\n");
        fs.symlinkSync(shared, path.join(setupTree, "linked-cache"), "dir");
        fs.writeFileSync(path.join(setupTree, ".env.local"), "COPIED=1\n");
        const copied = fs.statSync(path.join(setupTree, ".env.local"));
        const adminDir = path.join(repo, ".git", "worktrees", "with-setup", "codara-setup");
        fs.mkdirSync(adminDir, { recursive: true });
        fs.writeFileSync(
          path.join(adminDir, "manifest.json"),
          JSON.stringify({
            version: 1,
            sourceRoot: repo,
            copies: [{ path: ".env.local", size: copied.size, mtimeMs: copied.mtimeMs }],
            links: [{ path: "linked-cache", target: shared }],
          }),
        );
        const [setupCheck] = await removeMod.checkCleanupTargets(deps, [{ repoRoot: repo, path: setupTree }]);
        assert.deepEqual(setupCheck.blockers, [], JSON.stringify(setupCheck.blockers));
        assert.equal(setupCheck.localWork, null, "a copied, unchanged file and a linked folder lose nothing");
        const result = await removeMod.removeCleanupWorktrees(deps, {
          items: [{ repoRoot: repo, path: setupTree, fingerprint: setupCheck.fingerprint, confirmDirty: false, confirmUnmerged: false }],
          deleteMergedBranches: true,
        });
        assert.equal(result.outcomes[0].status, "removed", JSON.stringify(result.outcomes[0]));
        assert.ok(!fs.existsSync(setupTree));
        assert.equal(
          fs.readFileSync(path.join(shared, "keep.txt"), "utf8"),
          "the main checkout's own\n",
          "removal released the link instead of reaching through it",
        );
      });

      await check("the batch process scan finds a process inside one worktree only", async () => {
        const inside = path.join(trees, "fresh");
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { cwd: inside, stdio: "ignore" });
        children.push(child);
        await new Promise((done) => setTimeout(done, 300));
        const found = await agent.scanProcessesUnderCwds([inside, busy], {
          appPid: 2 ** 22 + 7,
          sessionPids: [],
          timeoutMs: 10_000,
        });
        assert.ok(found, "the scan runs on this platform");
        assert.ok(found.get(inside).some((entry) => entry.pid === child.pid));
        assert.ok(!found.get(busy).some((entry) => entry.pid === child.pid));
        const single = await agent.scanProcessesUnderCwd(inside, { appPid: 2 ** 22 + 7, sessionPids: [], timeoutMs: 10_000 });
        assert.ok(single.some((entry) => entry.pid === child.pid), "the one-directory scan answers the same");
      });
    }

    console.log(`PASS worktree cleanup (${passed} checks)`);
  } finally {
    for (const child of children) child.kill();
    for (const { outfile } of bundles) fs.rmSync(outfile, { force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
