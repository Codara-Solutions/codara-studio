// Integration test for the automatic removal of merged worktrees
// (src/main/worktree-cleanup/rail.ts, mode "auto-merged"): a worktree whose
// work is provably merged and that nothing holds goes on its own, and every
// other case stays. Bundled with esbuild like test-worktree-rail-cleanup.cjs
// and driven against throwaway git repositories with a bare remote, an
// in-memory AppState and fake terminals. A fake home and git config: nothing
// reads or writes the user's own.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function branchExists(repo, name) {
  try {
    git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

function commitFile(dir, name, content, message) {
  fs.writeFileSync(path.join(dir, name), content);
  git(dir, ["add", name]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

async function bundle(entry, name) {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `spark-worktree-auto-merged-${name}-${process.pid}.cjs`);
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

// Before every commit the test makes, so those count as the worktree's own.
const CREATED_AT = new Date(Date.now() - 60_000).toISOString();
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

async function main() {
  const bundles = await Promise.all([
    bundle("src/main/worktree-cleanup/rail.ts", "rail"),
    bundle("src/main/agent-worktrees.ts", "agent"),
  ]);
  const [rail, agent] = bundles.map((entry) => entry.mod);

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-wt-auto-")));
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
    commitFile(repo, "README.md", "# test\n", "init");
    commitFile(repo, ".gitignore", "node_modules/\n.env\n", "ignore output");
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);

    const h = {
      state: {
        workspaces: [{ id: "ws-repo", name: "Repo", cwd: repo, color: "#123456", workers: [] }],
        activeWorkspaceId: "ws-repo",
        workspaceRailOrder: ["ws-repo"],
      },
      terminals: [],
      runs: [],
      pullRequests: { open: [], merged: [] },
      processes: {},
      servers: {},
      sessions: {},
      held: {},
      // An hour ahead, so everything made here reads as quiet.
      now: new Date(Date.now() + HOUR),
    };
    const auditFile = path.join(scratch, "audit.jsonl");
    const deps = {
      loadState: async () => structuredClone(h.state),
      updateState: async (mutator) => {
        h.state = await mutator(structuredClone(h.state));
        return h.state;
      },
      publishState: () => undefined,
      invalidateGitCache: () => undefined,
      listRuns: async () => h.runs,
      sessionCwd: (paneId) => h.sessions[paneId] ?? null,
      sessionsUnderCwd: () => [],
      listRendererTerminals: async () => h.terminals,
      workspaceHeld: async (id) => h.held[id] ?? false,
      processesUnderCwds: async (dirs) => new Map(dirs.map((dir) => [dir, h.processes[dir] ?? []])),
      runningServers: (id) => h.servers[id] ?? 0,
      pullRequests: async () => h.pullRequests,
      regenerableIgnored: async () => [],
      appPaths: () => [path.join(scratch, "app-not-here")],
      isProtectedPath: () => false,
      audit: agent.createWorktreeAuditLog(auditFile),
      now: () => h.now,
    };
    const ON = { autoRemoveMerged: { enabled: true, minUptimeMs: 0 } };
    const has = (id) => h.state.workspaces.some((workspace) => workspace.id === id);
    const auto = (id, options = ON, depsToUse = deps) =>
      rail.cleanUpRailWorkspace(depsToUse, { workspaceId: id, mode: "auto-merged" }, options);
    const stateOf = async (id, options = ON) =>
      (await rail.railWorktreeOverview(deps, { external: false, ...options })).states.find((entry) => entry.workspaceId === id);

    const addWorkspace = (id, dir, branch, extra = {}) => {
      h.state.workspaces.push({
        id,
        name: id,
        cwd: dir,
        color: "#123456",
        workers: [],
        copyBranch: {
          repoCwd: repo,
          branch,
          baseBranch: "main",
          city: path.basename(dir),
          mode: "fork",
          createdAt: CREATED_AT,
          createdBy: { kind: "user" },
          ...extra,
        },
      });
      h.state.workspaceRailOrder.push(id);
    };
    const worktree = (id, extra) => {
      const branch = `feature/${id}`;
      const dir = path.join(trees, id);
      git(repo, ["worktree", "add", "-q", dir, "-b", branch]);
      addWorkspace(id, dir, branch, extra);
      return { id, dir, branch };
    };
    const landOnMain = (branch) => {
      git(repo, ["merge", "-q", "--no-ff", "-m", `merge ${branch}`, branch]);
      git(repo, ["push", "-q", "origin", "main"]);
    };
    // Merged, pushed to the remote base, clean: passes every rule.
    const mergedWorktree = (id, extra) => {
      const entry = worktree(id, extra);
      commitFile(entry.dir, `${id}.txt`, `${id}\n`, `${id} work`);
      landOnMain(entry.branch);
      return entry;
    };
    const assertStays = async ({ id, dir, branch }, why, options) => {
      const result = await auto(id, options);
      assert.equal(result.status, "refused", `${id}: ${result.message}`);
      if (why) assert.match(result.message, why);
      assert.equal(has(id), true, `${id}: the row stays`);
      assert.equal(fs.existsSync(dir), true, `${id}: the folder stays`);
      if (branch) assert.equal(branchExists(repo, branch), true, `${id}: the branch stays`);
      return result;
    };
    const assertGone = async ({ id, dir, branch }, options) => {
      const result = await auto(id, options);
      assert.equal(result.status, "removed", `${id}: ${result.message}`);
      assert.equal(result.branchDeleted, true);
      assert.equal(has(id), false);
      assert.equal(fs.existsSync(dir), false);
      assert.equal(branchExists(repo, branch), false);
    };

    // ── What goes ─────────────────────────────────────────────────────────
    await check("a merged, clean, quiet worktree is offered, and goes with its branch and a recovery ref", async () => {
      const entry = mergedWorktree("plain");
      const tip = git(entry.dir, ["rev-parse", "HEAD"]);
      const state = await stateOf(entry.id);
      assert.equal(state.merge, "merged");
      assert.equal(state.autoRemoveMerged, true);
      await assertGone(entry);
      const refs = git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/codara/removed-worktrees"]);
      assert.ok(refs.split("\n").some((line) => line.endsWith(tip) && line.includes(entry.id)), "its last commit stays recoverable");
      assert.equal(git(repo, ["merge-base", "--is-ancestor", tip, "origin/main"]) === "", true);
      const audit = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(audit.some((line) => line.caller.client === "workspace-rail-auto-merged" && line.outcome === "removed" && line.branch === entry.branch));
    });

    await check("a branch git could not read is not offered", async () => {
      if (process.platform === "win32") return; // The failing git is a shell script.
      const entry = mergedWorktree("unread-branch");
      const bin = path.join(scratch, "failing-git");
      fs.mkdirSync(bin, { recursive: true });
      const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
      fs.writeFileSync(
        path.join(bin, "git"),
        `#!/bin/sh\ncase "$*" in *refs/heads/${entry.branch}*) echo "fatal: unable to read" >&2; exit 128;; esac\nexec ${realGit} "$@"\n`,
        { mode: 0o755 },
      );
      const pathBefore = process.env.PATH;
      process.env.PATH = `${bin}${path.delimiter}${pathBefore}`;
      try {
        assert.equal((await stateOf(entry.id)).autoRemoveMerged, undefined);
        // A request queued while it was offered does not go ahead either.
        // (The test's own git reads go through the failing git too.)
        await assertStays({ ...entry, branch: undefined }, /could not read the branch/);
      } finally {
        process.env.PATH = pathBefore;
      }
      assert.equal(branchExists(repo, entry.branch), true);
      assert.equal((await stateOf(entry.id)).autoRemoveMerged, true);
      await assertGone(entry);
    });

    await check("regenerable ignored output does not hold a worktree back", async () => {
      const entry = mergedWorktree("with-output");
      fs.mkdirSync(path.join(entry.dir, "node_modules", "left-pad"), { recursive: true });
      fs.writeFileSync(path.join(entry.dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
      await assertGone(entry);
    });

    await check("a merged pull request whose head is exactly this commit proves it", async () => {
      const entry = worktree("squashed-pr");
      const tip = commitFile(entry.dir, "pr.txt", "pr\n", "pr work");
      git(entry.dir, ["push", "-q", "-u", "origin", entry.branch]);
      h.pullRequests = {
        open: [],
        merged: [{ number: 7, url: "https://example.invalid/7", headRefName: entry.branch, headRefOid: tip, isCrossRepository: false }],
      };
      assert.equal((await stateOf(entry.id)).proof, "pull-request");
      await assertGone(entry);
      h.pullRequests = { open: [], merged: [] };
    });

    await check("a squash goes on its content while its remote branch still holds this exact commit", async () => {
      const entry = worktree("squash-pushed");
      commitFile(entry.dir, "sq.txt", "sq\n", "squash work");
      git(entry.dir, ["push", "-q", "-u", "origin", entry.branch]);
      git(repo, ["merge", "-q", "--squash", entry.branch]);
      git(repo, ["commit", "-q", "-m", "squash"]);
      git(repo, ["push", "-q", "origin", "main"]);
      assert.equal((await stateOf(entry.id)).proof, "content-in-target");
      await assertGone(entry);
    });

    await check("once its remote branch is deleted, content alone cannot show the last commit was pushed", async () => {
      const entry = worktree("squash-gone");
      commitFile(entry.dir, "sg.txt", "sg\n", "squash work");
      git(entry.dir, ["push", "-q", "-u", "origin", entry.branch]);
      git(repo, ["merge", "-q", "--squash", entry.branch]);
      git(repo, ["commit", "-q", "-m", "squash"]);
      git(repo, ["push", "-q", "origin", "main"]);
      git(repo, ["push", "-q", "origin", "--delete", entry.branch]);
      git(repo, ["fetch", "-q", "--prune", "origin"]);
      // Two commits after the last push that net out to the same files.
      commitFile(entry.dir, "sg.txt", "experiment\n", "never pushed");
      commitFile(entry.dir, "sg.txt", "sg\n", "never pushed either");
      const state = await stateOf(entry.id);
      assert.equal(state.proof, "content-in-target");
      assert.equal(state.autoRemoveMerged, undefined);
      await assertStays(entry, /cannot be shown to have been pushed/);
    });

    await check("an upstream that is a local branch shows nothing either", async () => {
      const entry = worktree("local-upstream");
      commitFile(entry.dir, "lu.txt", "lu\n", "local upstream work");
      git(entry.dir, ["branch", "--set-upstream-to=main"]);
      git(repo, ["merge", "-q", "--squash", entry.branch]);
      git(repo, ["commit", "-q", "-m", "squash"]);
      git(repo, ["push", "-q", "origin", "main"]);
      assert.equal((await stateOf(entry.id)).autoRemoveMerged, undefined);
      await assertStays(entry, /unpushed|cannot be shown to have been pushed/);
    });

    // ── Local work ────────────────────────────────────────────────────────
    await check("uncommitted, untracked and kept ignored files all hold it, and survive", async () => {
      const tracked = mergedWorktree("dirty-tracked");
      fs.writeFileSync(path.join(tracked.dir, "dirty-tracked.txt"), "edited\n");
      await assertStays(tracked, /uncommitted or kept/);
      assert.equal(fs.readFileSync(path.join(tracked.dir, "dirty-tracked.txt"), "utf8"), "edited\n");

      const untracked = mergedWorktree("untracked");
      fs.writeFileSync(path.join(untracked.dir, "notes.txt"), "mine\n");
      await assertStays(untracked, /uncommitted or kept/);
      assert.equal(fs.readFileSync(path.join(untracked.dir, "notes.txt"), "utf8"), "mine\n");

      const secret = mergedWorktree("ignored-env");
      fs.writeFileSync(path.join(secret.dir, ".env"), "KEY=sample\n");
      await assertStays(secret, /uncommitted or kept/);
      assert.equal(fs.readFileSync(path.join(secret.dir, ".env"), "utf8"), "KEY=sample\n");

      for (const entry of [tracked, untracked, secret]) {
        const state = await stateOf(entry.id);
        assert.equal(state.merge, "merged", "still in the merged fold, one click away");
      }
    });

    await check("a file that appears between the check and the removal stops it, and is not forced away", async () => {
      const entry = mergedWorktree("appears");
      let calls = 0;
      const racing = {
        ...deps,
        // Called by the check, then again by the removal under the lock.
        listRendererTerminals: async () => {
          calls += 1;
          if (calls === 2) fs.writeFileSync(path.join(entry.dir, "late.txt"), "just written\n");
          return [];
        },
      };
      const result = await auto(entry.id, ON, racing);
      assert.equal(calls, 2);
      assert.equal(result.status, "refused", result.message);
      assert.equal(fs.readFileSync(path.join(entry.dir, "late.txt"), "utf8"), "just written\n");
      assert.equal(has(entry.id), true);
      assert.equal(branchExists(repo, entry.branch), true);
    });

    // ── Merge proof ───────────────────────────────────────────────────────
    await check("unmerged work stays and is not offered", async () => {
      const entry = worktree("unmerged");
      commitFile(entry.dir, "u.txt", "u\n", "unmerged work");
      assert.equal((await stateOf(entry.id)).autoRemoveMerged, undefined);
      await assertStays(entry, /not merged|not one a cleanup deletes/);
    });

    await check("commits the branch's upstream lacks hold it, even when the base has them", async () => {
      const entry = worktree("unpushed");
      commitFile(entry.dir, "a.txt", "a\n", "pushed");
      git(entry.dir, ["push", "-q", "-u", "origin", entry.branch]);
      commitFile(entry.dir, "b.txt", "b\n", "not pushed to its upstream");
      landOnMain(entry.branch);
      assert.equal((await stateOf(entry.id)).autoRemoveMerged, undefined);
      await assertStays(entry, /unpushed/);
    });

    await check("content in the base without ever having been pushed stays", async () => {
      const entry = worktree("content-only");
      commitFile(entry.dir, "c.txt", "c\n", "content");
      git(repo, ["merge", "-q", "--squash", entry.branch]);
      git(repo, ["commit", "-q", "-m", "squash content"]);
      git(repo, ["push", "-q", "origin", "main"]);
      const state = await stateOf(entry.id);
      assert.equal(state.proof, "content-in-target");
      assert.equal(state.autoRemoveMerged, undefined);
      await assertStays(entry, /cannot be shown to have been pushed/);
    });

    await check("a pull request for another commit proves nothing", async () => {
      const entry = worktree("moved-after-pr");
      const old = commitFile(entry.dir, "m.txt", "m\n", "before");
      git(entry.dir, ["push", "-q", "-u", "origin", entry.branch]);
      commitFile(entry.dir, "m2.txt", "m2\n", "after the merge");
      git(entry.dir, ["push", "-q", "origin", entry.branch]);
      h.pullRequests = {
        open: [],
        merged: [{ number: 8, url: "https://example.invalid/8", headRefName: entry.branch, headRefOid: old, isCrossRepository: false }],
      };
      await assertStays(entry);
      h.pullRequests = { open: [], merged: [] };
    });

    await check("a worktree with no commit of its own is not merged work: never on its own", async () => {
      const entry = worktree("empty", { createdAt: new Date(Date.now() + 5_000).toISOString() });
      const state = await stateOf(entry.id);
      assert.equal(state.merge, "empty");
      assert.equal(state.autoRemoveMerged, undefined);
      assert.equal(state.stale, undefined, "too new to offer");
      await assertStays(entry, /Nothing was ever committed/);
    });

    await check("after a week untouched an empty worktree is offered for a click, still never on its own", async () => {
      const entry = worktree("old-empty", { createdAt: new Date(Date.now() + 5_000).toISOString() });
      const realNow = h.now;
      h.now = new Date(Date.now() + 8 * DAY);
      try {
        const state = await stateOf(entry.id);
        assert.equal(state.merge, "empty");
        assert.equal(state.stale, true);
        assert.equal(state.autoRemoveMerged, undefined);
        await assertStays(entry, /Nothing was ever committed/);
        fs.writeFileSync(path.join(entry.dir, "started.txt"), "work\n");
        const refused = await rail.cleanUpRailWorkspace(deps, { workspaceId: entry.id, mode: "manual" });
        assert.equal(refused.status, "refused", "the click keeps every guard");
        fs.rmSync(path.join(entry.dir, "started.txt"));
        const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: entry.id, mode: "manual" });
        assert.equal(result.status, "removed", result.message);
        assert.equal(fs.existsSync(entry.dir), false);
      } finally {
        h.now = realNow;
      }
      const recent = worktree("recently-used", { createdAt: new Date(Date.now() + 5_000).toISOString() });
      h.now = new Date(Date.now() + 8 * DAY);
      try {
        fs.utimesSync(path.join(repo, ".git", "worktrees", "recently-used", "HEAD"), h.now, h.now);
        assert.equal((await stateOf(recent.id)).stale, undefined, "used lately is not stale");
      } finally {
        h.now = realNow;
      }
    });

    await check("a merge only into a local base stays: nothing outside this computer has it", async () => {
      const entry = worktree("local-base", { baseBranch: "local-trunk" });
      git(repo, ["branch", "local-trunk"]);
      commitFile(entry.dir, "l.txt", "l\n", "local work");
      git(repo, ["checkout", "-q", "local-trunk"]);
      git(repo, ["merge", "-q", "--no-ff", "-m", "local merge", entry.branch]);
      git(repo, ["checkout", "-q", "main"]);
      const state = await stateOf(entry.id);
      assert.equal(state.merge, "merged");
      assert.equal(state.autoRemoveMerged, undefined);
      await assertStays(entry, /only locally/);
    });

    await check("a long-lived branch and a detached worktree stay", async () => {
      const dir = path.join(trees, "develop");
      git(repo, ["worktree", "add", "-q", dir, "-b", "develop"]);
      addWorkspace("develop", dir, "develop");
      commitFile(dir, "d.txt", "d\n", "develop work");
      landOnMain("develop");
      assert.equal((await stateOf("develop")).autoRemoveMerged, undefined);
      await assertStays({ id: "develop", dir, branch: "develop" });

      const detached = path.join(trees, "detached");
      git(repo, ["worktree", "add", "-q", "--detach", detached]);
      addWorkspace("detached", detached, "feature/detached");
      assert.equal((await stateOf("detached")).autoRemoveMerged, undefined);
      await assertStays({ id: "detached", dir: detached });
    });

    await check("a locked worktree stays", async () => {
      const entry = mergedWorktree("locked");
      git(repo, ["worktree", "lock", entry.dir]);
      assert.equal((await stateOf(entry.id)).autoRemoveMerged, undefined);
      await assertStays(entry, /Locked/);
    });

    // ── In use ────────────────────────────────────────────────────────────
    await check("each thing using it holds it, and it goes on its own once that is gone", async () => {
      const terminal = mergedWorktree("busy-terminal");
      h.terminals = [{ paneId: "p1", workspaceId: terminal.id, cwd: terminal.dir, title: "shell" }];
      await assertStays(terminal, /terminal/);
      h.terminals = [];
      await assertGone(terminal);

      const running = mergedWorktree("busy-run");
      h.runs = [{ id: "r1", status: "running", workspaceId: running.id }];
      await assertStays(running, /Cora run/);
      h.runs = [];
      await assertGone(running);

      const server = mergedWorktree("busy-server");
      h.servers[server.id] = 1;
      await assertStays(server, /dev server/);
      delete h.servers[server.id];
      await assertGone(server);

      const process_ = mergedWorktree("busy-process");
      h.processes[process_.dir] = [{ pid: 4242, command: "node" }];
      await assertStays(process_, /running process/);
      delete h.processes[process_.dir];
      await assertGone(process_);

      const owned = mergedWorktree("busy-creator", { createdBy: { kind: "agent", client: "claude-code", paneId: "pane-open" } });
      h.sessions["pane-open"] = repo;
      await assertStays(owned, /agent|tab/i);
      delete h.sessions["pane-open"];
      await assertGone(owned);
    });

    await check("Codara running from it holds it", async () => {
      const entry = mergedWorktree("runs-app");
      const fromHere = { ...deps, appPaths: () => [entry.dir] };
      const result = await auto(entry.id, ON, fromHere);
      assert.equal(result.status, "refused");
      assert.match(result.message, /Codara/);
      assert.equal(fs.existsSync(entry.dir), true);
    });

    await check("what could not be read counts as in use, at the check and again under the lock", async () => {
      const entry = mergedWorktree("unknown-usage");
      for (const [name, broken] of [
        ["terminals", { listRendererTerminals: async () => null }],
        ["processes", { processesUnderCwds: async () => null }],
        ["runs", { listRuns: async () => { throw new Error("no store"); } }],
      ]) {
        const result = await auto(entry.id, ON, { ...deps, ...broken });
        assert.equal(result.status, "refused", name);
        assert.match(result.message, /could not be read/, name);
        assert.equal(fs.existsSync(entry.dir), true, name);
      }
      let calls = 0;
      const lateFailure = {
        ...deps,
        listRendererTerminals: async () => {
          calls += 1;
          return calls === 1 ? [] : null;
        },
      };
      const result = await auto(entry.id, ON, lateFailure);
      assert.equal(calls, 2, "the removal read them again");
      assert.equal(result.status, "refused");
      assert.equal(fs.existsSync(entry.dir), true);
      assert.equal(has(entry.id), true);
    });

    await check("a click still treats an unreadable terminal list as before", async () => {
      const entry = mergedWorktree("manual-unknown");
      const result = await rail.cleanUpRailWorkspace(
        { ...deps, listRendererTerminals: async () => null },
        { workspaceId: entry.id, mode: "manual" },
      );
      assert.equal(result.status, "removed", result.message);
    });

    await check("the workspace on screen, and one with another workspace inside it, stay", async () => {
      const active = mergedWorktree("on-screen");
      h.state.activeWorkspaceId = active.id;
      assert.equal((await stateOf(active.id)).autoRemoveMerged, undefined);
      await assertStays(active, /on screen/);
      h.state.activeWorkspaceId = "ws-repo";
      await assertGone(active);

      const holder = mergedWorktree("holds-row");
      fs.mkdirSync(path.join(holder.dir, "packages"));
      h.state.workspaces.push({ id: "ws-inside", name: "inside", cwd: path.join(holder.dir, "packages"), color: "#123456", workers: [] });
      await assertStays(holder, /Another workspace/);
      h.state.workspaces = h.state.workspaces.filter((workspace) => workspace.id !== "ws-inside");
    });

    // ── When ──────────────────────────────────────────────────────────────
    await check("recent activity holds it, and the wait is measured from the last touch", async () => {
      const entry = mergedWorktree("recent");
      const realNow = h.now;
      h.now = new Date();
      try {
        assert.equal((await stateOf(entry.id)).autoRemoveMerged, undefined);
        await assertStays(entry, /too recently/);
      } finally {
        h.now = realNow;
      }
      assert.equal((await stateOf(entry.id)).autoRemoveMerged, true);
      const shorter = { autoRemoveMerged: { enabled: true, minUptimeMs: 0, quietMs: 2 * HOUR } };
      assert.equal((await stateOf(entry.id, shorter)).autoRemoveMerged, undefined, "a longer window holds it");
      await assertStays(entry, /too recently/, shorter);
      await assertGone(entry);
    });

    await check("right after launch nothing goes: the terminal list may not be hydrated", async () => {
      const entry = mergedWorktree("just-launched");
      const early = { autoRemoveMerged: { enabled: true, minUptimeMs: 24 * HOUR } };
      assert.equal((await stateOf(entry.id, early)).autoRemoveMerged, undefined);
      await assertStays(entry, /only just started/, early);
      await assertGone(entry);
    });

    await check("the setting off, or no setting passed at all, refuses and offers nothing", async () => {
      const entry = mergedWorktree("setting-off");
      const off = { autoRemoveMerged: { enabled: false, minUptimeMs: 0 } };
      assert.equal((await stateOf(entry.id, off)).autoRemoveMerged, undefined);
      await assertStays(entry, /is off/, off);
      assert.equal((await stateOf(entry.id, {})).autoRemoveMerged, undefined);
      await assertStays(entry, /is off/, {});
      assert.equal((await stateOf(entry.id)).merge, "merged");
      await assertGone(entry);
    });

    await check("a folder already gone is the other cleanup's, not this one's", async () => {
      const entry = mergedWorktree("folder-gone");
      fs.rmSync(entry.dir, { recursive: true, force: true });
      assert.equal((await stateOf(entry.id)).autoRemoveMerged, undefined);
      const result = await auto(entry.id);
      assert.equal(result.status, "refused");
      assert.match(result.message, /folder is gone/);
      assert.equal(has(entry.id), true);
    });

    await check("the window is asked again at the last moment, and only a plain no lets it go", async () => {
      const opened = mergedWorktree("opened-late");
      h.held[opened.id] = true;
      await assertStays(opened, /open tabs/);
      assert.equal(fs.existsSync(path.join(opened.dir, "opened-late.txt")), true);
      assert.ok(
        !git(repo, ["for-each-ref", "--format=%(refname)", "refs/codara/removed-worktrees"]).includes(opened.id),
        "stopped before anything changed",
      );
      for (const [name, answer] of [
        ["no answer", async () => null],
        ["a failed question", async () => { throw new Error("no window"); }],
      ]) {
        const result = await auto(opened.id, ON, { ...deps, workspaceHeld: answer });
        assert.equal(result.status, "refused", name);
        assert.equal(fs.existsSync(opened.dir), true, name);
      }
      const { workspaceHeld: _unused, ...noProbe } = deps;
      assert.equal((await auto(opened.id, ON, noProbe)).status, "refused", "no way to ask counts as held");
      delete h.held[opened.id];
      await assertGone(opened);
    });

    await check("a tab of another workspace on a file inside it holds it, asked by folder", async () => {
      const shown = mergedWorktree("shown-elsewhere");
      const asked = [];
      const elsewhere = {
        ...deps,
        workspaceHeld: async (id, paths = []) => {
          asked.push({ id, paths });
          return paths.includes(shown.dir);
        },
      };
      const result = await auto(shown.id, ON, elsewhere);
      assert.equal(result.status, "refused");
      assert.match(result.message, /a tab shows a file in it/);
      assert.equal(fs.existsSync(shown.dir), true);
      assert.ok(asked.some((entry) => entry.id === shown.id && entry.paths.includes(shown.dir)), JSON.stringify(asked));
      await assertGone(shown);
    });

    await check("switching to the workspace while the checks run stops the removal", async () => {
      const entry = mergedWorktree("switched-to");
      let calls = 0;
      const racing = {
        ...deps,
        listRendererTerminals: async () => {
          calls += 1;
          if (calls === 2) h.state.activeWorkspaceId = entry.id;
          return [];
        },
      };
      const result = await auto(entry.id, ON, racing);
      h.state.activeWorkspaceId = "ws-repo";
      assert.equal(result.status, "refused");
      assert.match(result.message, /on screen/);
      assert.equal(fs.existsSync(entry.dir), true);
      assert.equal(has(entry.id), true);
    });

    await check("a local branch spelled like the remote's base is not the remote", async () => {
      const entry = worktree("shadowed-base");
      commitFile(entry.dir, "s.txt", "s\n", "never left this computer");
      git(repo, ["branch", "origin/main", "main"]);
      git(repo, ["branch", "--no-track", "shadow-tmp", "main"]);
      try {
        git(repo, ["checkout", "-q", "origin/main"]);
        git(repo, ["merge", "-q", "--no-ff", "-m", "local merge", entry.branch]);
        git(repo, ["checkout", "-q", "main"]);
        const state = await stateOf(entry.id);
        assert.equal(state.merge, "merged", "merged into what the name resolves to");
        assert.equal(state.autoRemoveMerged, undefined);
        await assertStays(entry, /only locally/);
      } finally {
        git(repo, ["checkout", "-q", "main"]);
        git(repo, ["branch", "-D", "origin/main", "shadow-tmp"]);
      }
    });

    await check("a request from the rail cannot widen the mode", async () => {
      const entry = mergedWorktree("odd-mode");
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: entry.id, mode: "auto", confirmIgnored: "x" }, ON);
      assert.equal(result.status, "refused");
      assert.match(result.message, /still there/);
      assert.equal(fs.existsSync(entry.dir), true);
    });

    await check("the main checkout and a plain workspace are never in play", async () => {
      const result = await auto("ws-repo");
      assert.equal(result.status, "refused");
      assert.equal(fs.existsSync(path.join(repo, "README.md")), true);
      assert.equal(has("ws-repo"), true);
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    for (const { outfile } of bundles) fs.rmSync(outfile, { force: true });
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
