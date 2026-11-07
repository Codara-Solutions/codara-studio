// Merged worktrees leave on their own with their ignored data kept
// (src/main/worktree-cleanup/archive.ts, rail.ts mode "auto-merged", and
// codara_worktree_remove in agent-worktrees.ts): kept ignored files are
// copied to the archive and counted before the folder goes, a copy that
// fails keeps the worktree, the maker's tab holds merged work only while its
// shell is inside and it is not quiet, and nothing unproven is touched.
// Throwaway repositories with a bare remote, fake terminals, a fake home.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MIN = 60_000;

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFile(dir, name, content, message) {
  fs.writeFileSync(path.join(dir, name), content);
  git(dir, ["add", name]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function branchExists(repo, name) {
  try {
    git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

const outfiles = [];
async function bundle(entry, name) {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `spark-worktree-auto-archive-${name}-${process.pid}.cjs`);
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
  outfiles.push(outfile);
  return require(outfile);
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// Ignored data a fresh checkout cannot bring back, and output it can.
function addData(dir) {
  fs.mkdirSync(path.join(dir, "data", "raw"), { recursive: true });
  fs.writeFileSync(path.join(dir, "data", "raw", "rows.csv"), "a,b\n1,2\n");
  fs.writeFileSync(path.join(dir, "data", "model.bin"), Buffer.alloc(4096, 7));
  fs.writeFileSync(path.join(dir, ".env.local"), "TOKEN=FAKE_sample\n");
  fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
}

function filesUnder(dir) {
  const out = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const entry = path.join(rel, name);
      if (fs.lstatSync(path.join(dir, entry)).isDirectory()) walk(entry);
      else out.push(entry.split(path.sep).join("/"));
    }
  };
  if (fs.existsSync(dir)) walk("");
  return out.sort();
}

async function main() {
  const [rail, agent, archive, shared, mounts] = await Promise.all([
    bundle("src/main/worktree-cleanup/rail.ts", "rail"),
    bundle("src/main/agent-worktrees.ts", "agent"),
    bundle("src/main/worktree-cleanup/archive.ts", "archive"),
    bundle("src/shared/worktree-cleanup.ts", "shared"),
    bundle("src/main/worktree-cleanup/mounts.ts", "mounts"),
  ]);

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-wt-archive-")));
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
    const notes = path.join(scratch, "notes");
    fs.mkdirSync(trees);
    fs.mkdirSync(notes);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    commitFile(repo, "README.md", "# test\n", "init");
    commitFile(repo, ".gitignore", "node_modules/\n.env.local\ndata/\n", "ignore");
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);

    const archiveRoot = path.join(scratch, "archive");
    const h = {
      state: {
        workspaces: [
          { id: "ws-repo", name: "Repo", cwd: repo, color: "#123456", workers: [] },
          { id: "ws-notes", name: "Notes", cwd: notes, color: "#654321", workers: [] },
        ],
        activeWorkspaceId: "ws-notes",
        workspaceRailOrder: ["ws-repo", "ws-notes"],
      },
      terminals: [],
      sessions: {},
      idle: {},
      pids: {},
      processes: {},
      pullRequests: { open: [], merged: [] },
      archiveRoot,
      now: new Date(Date.now() + 60 * MIN),
    };
    const day = () => h.now.toISOString().slice(0, 10);
    const deps = {
      loadState: async () => structuredClone(h.state),
      updateState: async (mutator) => {
        h.state = await mutator(structuredClone(h.state));
        return h.state;
      },
      publishState: () => undefined,
      invalidateGitCache: () => undefined,
      listRuns: async () => [],
      sessionCwd: (paneId) => h.sessions[paneId] ?? null,
      sessionsUnderCwd: (dir) => Object.keys(h.sessions).filter((id) => h.sessions[id] === dir),
      sessionPid: (paneId) => h.pids[paneId] ?? null,
      paneIdleMs: (paneId) => h.idle[paneId] ?? 0,
      listRendererTerminals: async () => h.terminals,
      workspaceHeld: async () => false,
      processesUnderCwds: async (dirs) => new Map(dirs.map((dir) => [dir, h.processes[dir] ?? []])),
      runningServers: () => 0,
      pullRequests: async () => h.pullRequests,
      regenerableIgnored: async () => [],
      appPaths: () => [path.join(scratch, "app-not-here")],
      isProtectedPath: () => false,
      audit: agent.createWorktreeAuditLog(path.join(scratch, "audit.jsonl")),
      now: () => {
        // Called once more as the archive starts, the folder aside.
        const hook = h.onNow;
        h.onNow = null;
        hook?.();
        return h.now;
      },
      archiveRoot: () => h.archiveRoot,
    };
    const ON = { autoRemoveMerged: { enabled: true, minUptimeMs: 0 } };
    const auto = (id) => rail.cleanUpRailWorkspace(deps, { workspaceId: id, mode: "auto-merged" }, ON);
    const has = (id) => h.state.workspaces.some((workspace) => workspace.id === id);

    const worktree = (id, extra = {}) => {
      const branch = `feature/${id}`;
      const dir = path.join(trees, id);
      git(repo, ["worktree", "add", "-q", dir, "-b", branch, extra.from ?? "main"]);
      h.state.workspaces.push({
        id,
        name: id,
        cwd: dir,
        color: "#123456",
        workers: [],
        copyBranch: {
          repoCwd: repo,
          branch,
          baseBranch: extra.base ?? "main",
          city: id,
          mode: "fork",
          createdAt: new Date(Date.now() - MIN).toISOString(),
          createdBy: extra.createdBy ?? { kind: "user" },
        },
      });
      commitFile(dir, `${id}.txt`, `${id}\n`, `${id} work`);
      return { id, dir, branch };
    };
    const merged = (id, extra) => {
      const entry = worktree(id, extra);
      git(repo, ["merge", "-q", "--no-ff", "-m", `merge ${entry.branch}`, entry.branch]);
      git(repo, ["push", "-q", "origin", "main"]);
      return entry;
    };
    const assertKept = async (entry, why) => {
      const result = await auto(entry.id);
      assert.equal(result.status, "refused", `${entry.id}: ${JSON.stringify(result)}`);
      if (why) assert.match(result.message, why);
      assert.equal(has(entry.id), true, "the row stays");
      assert.equal(fs.readFileSync(path.join(entry.dir, "data", "raw", "rows.csv"), "utf8"), "a,b\n1,2\n", "its data stays");
      assert.equal(branchExists(repo, entry.branch), true, "the branch stays");
      return result;
    };

    // ── Archive, then remove ─────────────────────────────────────────────
    await check("merged with kept ignored data: archived, counted, then removed with its branch", async () => {
      const entry = merged("data");
      addData(entry.dir);
      const tip = git(entry.dir, ["rev-parse", "HEAD"]);
      const result = await auto(entry.id);
      assert.equal(result.status, "removed", JSON.stringify(result));
      assert.equal(fs.existsSync(entry.dir), false);
      assert.equal(has(entry.id), false);
      assert.equal(branchExists(repo, entry.branch), false);
      const dir = path.join(archiveRoot, day(), "repo--feature-data");
      assert.equal(result.archived.path, dir);
      assert.deepEqual(filesUnder(dir), [".env.local", "data/model.bin", "data/raw/rows.csv"], "node_modules is not kept");
      assert.equal(result.archived.files, 3);
      assert.equal(result.archived.bytes, 4096 + 8 + 18);
      assert.equal(fs.readFileSync(path.join(dir, ".env.local"), "utf8"), "TOKEN=FAKE_sample\n");
      const refs = git(repo, ["for-each-ref", "--format=%(objectname)", "refs/codara/"]);
      assert.ok(refs.split("\n").includes(tip), "the recovery ref holds its last commit");
    });

    await check("a copy that fails keeps the worktree, its data and its branch, and says why", async () => {
      const entry = merged("nocopy");
      addData(entry.dir);
      h.archiveRoot = path.join(scratch, "archive-is-a-file");
      fs.writeFileSync(h.archiveRoot, "");
      try {
        const result = await assertKept(entry, /could not be archived/);
        assert.match(result.message, /kept/);
        assert.equal(fs.existsSync(path.join(entry.dir, ".env.local")), true);
      } finally {
        h.archiveRoot = archiveRoot;
      }
      assert.equal((await auto(entry.id)).status, "removed", "it goes once the archive can be written");
    });

    await check("a file written while the copy runs puts the folder back, and the copy is dropped", async () => {
      const entry = merged("written");
      addData(entry.dir);
      let calls = 0;
      const aside = path.join(trees, ".written.codara-removing");
      const arm = () => {
        h.onNow = () => {
          if (fs.existsSync(aside)) fs.writeFileSync(path.join(aside, "written.txt"), "edited while archiving\n");
          else if (++calls < 20) arm();
        };
      };
      arm();
      const result = await assertKept(entry, /changed/);
      assert.equal(fs.readFileSync(path.join(entry.dir, "written.txt"), "utf8"), "edited while archiving\n");
      assert.equal(fs.existsSync(path.join(archiveRoot, day(), "repo--feature-written")), false, "no stale copy is left");
      h.onNow = null;
    });

    await check("a program started inside while the copy runs puts the folder back too", async () => {
      const entry = merged("started");
      addData(entry.dir);
      const aside = path.join(trees, ".started.codara-removing");
      let calls = 0;
      const arm = () => {
        h.onNow = () => {
          if (fs.existsSync(aside)) h.processes[aside] = [{ pid: 7777, command: "node" }];
          else if (++calls < 20) arm();
        };
      };
      arm();
      try {
        await assertKept(entry, /running process|In use/);
        assert.equal(fs.existsSync(path.join(archiveRoot, day(), "repo--feature-started")), false, "no stale copy is left");
      } finally {
        h.onNow = null;
        h.processes = {};
      }
    });

    await check("a link swapped after it was copied fails the archive, and the copy is dropped", async () => {
      const src = path.join(scratch, "links");
      fs.mkdirSync(path.join(src, "data"), { recursive: true });
      fs.symlinkSync("one", path.join(src, "data", "current"));
      const root = path.join(scratch, "links-archive");
      await assert.rejects(
        archive.archiveIgnoredFiles({
          worktree: src,
          entries: ["data/"],
          root,
          repoName: "repo",
          branch: "x",
          now: h.now,
          afterCopy: async () => {
            fs.rmSync(path.join(src, "data", "current"));
            fs.symlinkSync("two", path.join(src, "data", "current"));
          },
        }),
        /changed while/,
      );
      assert.deepEqual(filesUnder(path.join(root, day())), []);
      const kept = await archive.archiveIgnoredFiles({ worktree: src, entries: ["data/"], root, repoName: "repo", branch: "x", now: h.now });
      assert.equal(fs.readlinkSync(path.join(kept.dir, "data", "current")), "two", "a link is copied as a link");
    });

    await check("names are kept exactly: a backslash in a name is not a folder", async () => {
      const entry = merged("names");
      fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "*.keep\n");
      fs.mkdirSync(path.join(entry.dir, "x"));
      fs.writeFileSync(path.join(entry.dir, "x", "y.keep"), "slash\n");
      fs.writeFileSync(path.join(entry.dir, "x\\y.keep"), "backslash\n");
      const result = await auto(entry.id);
      assert.equal(result.status, "removed", JSON.stringify(result));
      assert.deepEqual(filesUnder(result.archived.path), ["x/y.keep", "x\\y.keep"]);
    });

    await check("without an archive to keep them in, kept ignored files still hold it", async () => {
      const entry = merged("noroot");
      addData(entry.dir);
      const { archiveRoot: _unused, ...without } = deps;
      const result = await rail.cleanUpRailWorkspace(without, { workspaceId: entry.id, mode: "auto-merged" }, ON);
      assert.equal(result.status, "refused");
      assert.match(result.message, /uncommitted or kept/);
      assert.equal(fs.existsSync(path.join(entry.dir, "data", "model.bin")), true);
    });

    // ── The maker's tab ─────────────────────────────────────────────────
    await check("the maker's tab with its shell inside: quiet 5 min keeps it, quiet 31 min lets it go", async () => {
      const entry = merged("owner", { createdBy: { kind: "agent", client: "claude-code", paneId: "pane-owner" } });
      addData(entry.dir);
      h.sessions["pane-owner"] = entry.dir;
      h.terminals = [{ paneId: "pane-owner", workspaceId: "ws-notes", cwd: entry.dir, title: "Coordinator" }];
      h.pids["pane-owner"] = 4242;
      h.processes[entry.dir] = [{ pid: 4242, command: "zsh" }];
      try {
        h.idle["pane-owner"] = 5 * MIN;
        await assertKept(entry, /Coordinator/);
        h.idle["pane-owner"] = 31 * MIN;
        const result = await auto(entry.id);
        assert.equal(result.status, "removed", JSON.stringify(result));
        assert.equal(fs.existsSync(entry.dir), false);
      } finally {
        h.sessions = {};
        h.terminals = [];
        h.processes = {};
        h.idle = {};
      }
    });

    await check("a process of the agent inside still holds it, however quiet the tab", async () => {
      const entry = merged("owner-busy", { createdBy: { kind: "agent", client: "claude-code", paneId: "pane-owner" } });
      addData(entry.dir);
      h.sessions["pane-owner"] = entry.dir;
      h.pids["pane-owner"] = 4242;
      h.processes[entry.dir] = [{ pid: 4242, command: "zsh" }, { pid: 4343, command: "claude" }];
      h.idle["pane-owner"] = 120 * MIN;
      try {
        await assertKept(entry, /running process/);
      } finally {
        h.sessions = {};
        h.processes = {};
        h.idle = {};
      }
    });

    await check("the maker's tab working in another folder does not hold merged work", async () => {
      const entry = merged("owner-away", { createdBy: { kind: "agent", client: "claude-code", paneId: "pane-owner" } });
      h.sessions["pane-owner"] = notes;
      h.terminals = [{ paneId: "pane-owner", workspaceId: "ws-notes", cwd: notes, title: "Coordinator" }];
      try {
        const result = await auto(entry.id);
        assert.equal(result.status, "removed", JSON.stringify(result));
      } finally {
        h.sessions = {};
        h.terminals = [];
      }
    });

    // ── Never touched ───────────────────────────────────────────────────
    await check("unmerged work is never touched, and nothing is archived for it", async () => {
      const entry = worktree("unmerged");
      addData(entry.dir);
      await assertKept(entry, /branch/);
      assert.equal(fs.existsSync(path.join(archiveRoot, day(), "repo--feature-unmerged")), false);
    });

    await check("a merge proved only through the remote's base is never taken while ls-remote fails", async () => {
      git(repo, ["branch", "feat/base", "main"]);
      git(repo, ["push", "-q", "origin", "feat/base"]);
      const entry = worktree("stacked", { from: "feat/base", base: "feat/base" });
      addData(entry.dir);
      const tip = git(entry.dir, ["rev-parse", "HEAD"]);
      // "GitHub" squashes it into feat/base; the base is not merged into main.
      const hub = path.join(scratch, "hub");
      execFileSync("git", ["clone", "-q", "-b", "feat/base", origin, hub]);
      fs.writeFileSync(path.join(hub, "stacked.txt"), "stacked\n");
      git(hub, ["add", "stacked.txt"]);
      git(hub, ["commit", "-q", "-m", "stacked (#7)"]);
      const squash = git(hub, ["rev-parse", "HEAD"]);
      git(hub, ["push", "-q", "origin", "feat/base"]);
      git(repo, ["fetch", "-q", "origin"]);
      h.pullRequests = {
        open: [],
        merged: [
          {
            number: 7,
            url: "https://github.com/acme/app/pull/7",
            headRefName: entry.branch,
            headRefOid: tip,
            baseRefName: "feat/base",
            isCrossRepository: false,
            mergeCommitOid: squash,
          },
        ],
      };
      git(repo, ["remote", "set-url", "origin", path.join(scratch, "unreachable.git")]);
      try {
        await assertKept(entry);
        assert.equal(fs.existsSync(path.join(archiveRoot, day(), "repo--feature-stacked")), false);
      } finally {
        git(repo, ["remote", "set-url", "origin", origin]);
      }
      const result = await auto(entry.id);
      assert.equal(result.status, "removed", `with the remote answering it is proved: ${JSON.stringify(result)}`);
      h.pullRequests = { open: [], merged: [] };
    });

    // ── Archive pruning ─────────────────────────────────────────────────
    await check("archive day folders older than 30 days are pruned, nothing else", async () => {
      const root = path.join(scratch, "prune");
      for (const name of ["2026-09-01", "2026-10-07", "2026-10-30", "not-a-day"]) {
        fs.mkdirSync(path.join(root, name, "repo--x"), { recursive: true });
        fs.writeFileSync(path.join(root, name, "repo--x", "f"), "x");
      }
      fs.writeFileSync(path.join(root, "2026-01-01"), "a file, not a day folder");
      const removed = await archive.pruneWorktreeArchive(root, new Date("2026-11-06T12:00:00Z"));
      assert.equal(removed, 1);
      assert.deepEqual(fs.readdirSync(root).sort(), ["2026-01-01", "2026-10-07", "2026-10-30", "not-a-day"]);
      assert.equal(await archive.pruneWorktreeArchive(path.join(scratch, "no-archive-yet"), new Date()), 0);
    });

    // ── codara_worktree_remove ───────────────────────────────────────────
    let ids = 0;
    const agentState = {
      prefs: { agentWorktreesEnabled: true, agentsMayRemoveUserWorktrees: false, agentWorktreeRegenerableIgnoredByRepo: {} },
      paneWorkspace: { "pane-maker": "ws-repo", "pane-other": "ws-repo" },
    };
    const agentDeps = {
      ...deps,
      loadPreferences: async () => agentState.prefs,
      getRun: async () => null,
      paneWorkspaceId: async (paneId) => agentState.paneWorkspace[paneId] ?? null,
      workspaceHeld: async () => false,
      processesUnderCwd: async (dir) => h.processes[dir] ?? [],
      github: { listPullRequestsForHead: async () => [], listMergedPullRequests: async () => [] },
      sendAgentEvent: () => undefined,
      worktreesRoot: () => path.join(home, "worktrees"),
      randomId: () => (++ids).toString(16).padStart(8, "a"),
      pretrustClaude: async () => undefined,
    };
    const maker = { role: "studio", client: "claude-code", paneId: "pane-maker" };
    const other = { role: "studio", client: "codex", paneId: "pane-other" };
    const agentMerged = async (branch) => {
      const made = await agent.createAgentWorktree(maker, { branch }, agentDeps);
      assert.equal(made.ok, true, JSON.stringify(made));
      commitFile(made.path, "work.txt", `${branch}\n`, branch);
      git(repo, ["merge", "-q", "--no-ff", "-m", `merge ${branch}`, branch]);
      git(repo, ["push", "-q", "origin", "main"]);
      addData(made.path);
      return made;
    };

    await check("codara_worktree_remove: ignored data alone no longer blocks a merged worktree; it is archived", async () => {
      const made = await agentMerged("agent/plain");
      const removed = await agent.removeAgentWorktree(maker, { workspaceId: made.workspaceId }, agentDeps);
      assert.equal(removed.ok, true, JSON.stringify(removed));
      assert.equal(removed.removed, true);
      assert.deepEqual(filesUnder(removed.archived.path), [".env.local", "data/model.bin", "data/raw/rows.csv"]);
      assert.equal(fs.existsSync(made.path), false);
    });

    await check("codara_worktree_remove: discardIgnoredFiles archives instead of deleting", async () => {
      const made = await agentMerged("agent/discard");
      const removed = await agent.removeAgentWorktree(maker, { workspaceId: made.workspaceId, discardIgnoredFiles: true }, agentDeps);
      assert.equal(removed.ok, true, JSON.stringify(removed));
      assert.equal(removed.archived.files, 3);
    });

    await check("codara_worktree_remove: the maker's tab inside holds until it has been quiet 30 minutes", async () => {
      const made = await agentMerged("agent/owned");
      h.sessions["pane-maker"] = made.path;
      h.pids["pane-maker"] = 5151;
      h.processes[made.path] = [{ pid: 5151, command: "zsh" }];
      try {
        h.idle["pane-maker"] = 5 * MIN;
        const refused = await agent.removeAgentWorktree(other, { workspaceId: made.workspaceId }, agentDeps);
        assert.equal(refused.ok, false);
        assert.ok(refused.blockers.includes("WORKTREE_OWNED_BY_LIVE_AGENT"), JSON.stringify(refused));
        assert.equal(fs.existsSync(path.join(made.path, "data", "model.bin")), true);
        h.idle["pane-maker"] = 31 * MIN;
        const removed = await agent.removeAgentWorktree(other, { workspaceId: made.workspaceId }, agentDeps);
        assert.equal(removed.ok, true, JSON.stringify(removed));
        assert.equal(removed.archived.files, 3);
      } finally {
        h.sessions = {};
        h.processes = {};
        h.idle = {};
      }
    });

    await check("codara_worktree_remove: a drive mounted inside keeps it, with its own code", async () => {
      const made = await agentMerged("agent/mounted");
      agentDeps.mountRefusal = async () => "data/remote is a mounted drive or on another disk, so it was kept. Unmount it first.";
      try {
        const refused = await agent.removeAgentWorktree(maker, { workspaceId: made.workspaceId }, agentDeps);
        assert.equal(refused.ok, false);
        assert.equal(refused.code, "WORKTREE_MOUNT_INSIDE", JSON.stringify(refused));
        assert.match(refused.error, /mounted drive/);
        assert.equal(fs.readFileSync(path.join(made.path, ".env.local"), "utf8"), "TOKEN=FAKE_sample\n");
        assert.equal(branchExists(repo, "agent/mounted"), true);
      } finally {
        delete agentDeps.mountRefusal;
      }
    });

    await check("codara_worktree_remove: usage that cannot be read refuses, with a reason to retry", async () => {
      const made = await agentMerged("agent/unknown");
      const original = agentDeps.processesUnderCwd;
      try {
        for (const answer of [null, Object.assign([], { openFilesUnknown: true })]) {
          agentDeps.processesUnderCwd = async () => answer;
          const refused = await agent.removeAgentWorktree(maker, { workspaceId: made.workspaceId }, agentDeps);
          assert.equal(refused.ok, false);
          assert.equal(refused.code, "WORKTREE_USAGE_UNKNOWN", JSON.stringify(refused));
          assert.match(refused.hint, /try again/);
          assert.equal(fs.existsSync(path.join(made.path, "data", "model.bin")), true);
        }
        // Known at the check, unknown at the last look before the delete: put back.
        agentDeps.processesUnderCwd = async (dir) => (dir.includes("codara-removing") ? null : []);
        const late = await agent.removeAgentWorktree(maker, { workspaceId: made.workspaceId }, agentDeps);
        assert.equal(late.ok, false);
        assert.match(late.error, /could not be read, so it was put back/, JSON.stringify(late));
        assert.equal(fs.readFileSync(path.join(made.path, ".env.local"), "utf8"), "TOKEN=FAKE_sample\n");
        assert.equal(branchExists(repo, "agent/unknown"), true);
      } finally {
        agentDeps.processesUnderCwd = original;
      }
      const removed = await agent.removeAgentWorktree(maker, { workspaceId: made.workspaceId }, agentDeps);
      assert.equal(removed.ok, true, JSON.stringify(removed));
    });

    await check("codara_worktree_remove: a copy that fails keeps it, with its own code", async () => {
      const made = await agentMerged("agent/nocopy");
      h.archiveRoot = path.join(scratch, "archive-is-a-file");
      try {
        const refused = await agent.removeAgentWorktree(maker, { workspaceId: made.workspaceId }, agentDeps);
        assert.equal(refused.ok, false);
        assert.equal(refused.code, "WORKTREE_ARCHIVE_FAILED", JSON.stringify(refused));
        assert.equal(fs.readFileSync(path.join(made.path, ".env.local"), "utf8"), "TOKEN=FAKE_sample\n");
        assert.equal(branchExists(repo, "agent/nocopy"), true);
      } finally {
        h.archiveRoot = archiveRoot;
      }
    });

    // ── A drive mounted inside ──────────────────────────────────────────
    // A fake file system: path -> { dev, dir, entries }. The root is on dev 1.
    const fakeReader = (tree, mountPoints = null) => ({
      lstat: async (p) => {
        const node = tree[p];
        if (!node) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
        if (node.denied) throw Object.assign(new Error(`EACCES ${p}`), { code: "EACCES" });
        return { dev: node.dev ?? 1, isDirectory: () => Boolean(node.entries), isSymbolicLink: () => Boolean(node.link) };
      },
      readdir: async (p) => {
        const node = tree[p];
        if (node?.unreadable) throw Object.assign(new Error(`EACCES ${p}`), { code: "EACCES" });
        if (!node?.entries) throw Object.assign(new Error(`ENOTDIR ${p}`), { code: "ENOTDIR" });
        return node.entries;
      },
      mountPoints: async () => mountPoints,
    });

    await check("mounts: a folder or a file on another device inside the worktree is found, links are not followed", async () => {
      const tree = {
        "/w": { entries: ["src", "data", "link"] },
        "/w/src": { entries: ["a.ts"] },
        "/w/src/a.ts": {},
        "/w/link": { link: true, dev: 1 },
        "/w/data": { entries: ["remote"] },
        "/w/data/remote": { dev: 2, entries: ["f"] },
        "/w/data/remote/f": { dev: 2 },
      };
      assert.equal(await mounts.mountInside("/w", fakeReader(tree)), "data/remote");
      const file = { "/w": { entries: ["x"] }, "/w/x": { dev: 9 } };
      assert.equal(await mounts.mountInside("/w", fakeReader(file)), "x", "a file on another device counts");
      const clean = { "/w": { entries: ["src"] }, "/w/src": { entries: ["a"] }, "/w/src/a": {} };
      assert.equal(await mounts.mountInside("/w", fakeReader(clean)), null);
    });

    await check("mounts: a bind mount on the same device is found from the mount list", async () => {
      const tree = { "/w": { entries: ["data"] }, "/w/data": { entries: [] } };
      const listed = mounts.mountPointsFromMountinfo(
        "22 1 8:2 / / rw - ext4 /dev/sda2 rw\n90 22 8:2 /elsewhere /w/data/my\\040drive rw - ext4 /dev/sda2 rw\n",
      );
      assert.deepEqual(listed, ["/", "/w/data/my drive"]);
      assert.equal(await mounts.mountInside("/w", fakeReader(tree, listed)), "data/my drive");
      assert.equal(await mounts.mountInside("/w", fakeReader(tree, ["/", "/w", "/wx/data"])), null, "the root itself and a sibling do not count");
    });

    await check("mounts: a folder that cannot be read refuses (fails closed); real folders here pass", async () => {
      const tree = { "/w": { entries: ["data"] }, "/w/data": { entries: [], unreadable: true } };
      assert.match(await mounts.mountRefusal("/w", fakeReader(tree)), /could not be checked for mounted drives/);
      const mounted = { "/w": { entries: ["m"] }, "/w/m": { dev: 3, entries: [] } };
      assert.match(await mounts.mountRefusal("/w", fakeReader(mounted)), /^m is a mounted drive/);
      const real = path.join(scratch, "no-mounts");
      fs.mkdirSync(path.join(real, "data", "raw"), { recursive: true });
      fs.writeFileSync(path.join(real, "data", "raw", "f"), "x");
      assert.equal(await mounts.mountRefusal(real), null);
    });

    await check("a merged worktree with a drive mounted inside is kept: nothing copied or deleted, and it says why", async () => {
      const entry = merged("mounted");
      addData(entry.dir);
      deps.mountRefusal = async (dir) => (dir === entry.dir ? "data/remote is a mounted drive or on another disk, so it was kept. Unmount it first." : null);
      try {
        await assertKept(entry, /mounted drive/);
        assert.equal(fs.existsSync(path.join(archiveRoot, day(), "repo--feature-mounted")), false, "nothing is copied");
        assert.equal(fs.existsSync(path.join(entry.dir, ".env.local")), true);
        const audited = fs.readFileSync(path.join(scratch, "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
        assert.ok(audited.some((line) => line.code === "MOUNT_INSIDE" && line.path === entry.dir), "the refusal is in the audit log");
      } finally {
        delete deps.mountRefusal;
      }
      assert.equal((await auto(entry.id)).status, "removed", "it goes once the mount is gone");
    });

    await check("usage only partly known (open files unread) keeps a merged worktree on the auto path", async () => {
      const entry = merged("partly");
      addData(entry.dir);
      const original = deps.processesUnderCwds;
      deps.processesUnderCwds = async (dirs) => Object.assign(new Map(dirs.map((dir) => [dir, []])), { openFilesUnknown: true });
      try {
        await assertKept(entry, /could not be read/);
        assert.equal(fs.existsSync(path.join(archiveRoot, day(), "repo--feature-partly")), false, "nothing is copied");
      } finally {
        deps.processesUnderCwds = original;
      }
      assert.equal((await auto(entry.id)).status, "removed", "it goes once the scan sees everything");
    });

    await check("mounts: a walk past its time limit refuses", async () => {
      const slow = {
        "/w": { entries: ["a"] },
        "/w/a": { entries: ["b"] },
        "/w/a/b": { entries: [] },
      };
      const reader = fakeReader(slow);
      const readdir = reader.readdir;
      reader.readdir = async (p) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return readdir(p);
      };
      assert.match(await mounts.mountRefusal("/w", reader, 10), /could not be checked for mounted drives \(the walk took longer/);
      assert.equal(await mounts.mountRefusal("/w", reader, 10_000), null);
    });

    // ── Open files count as use (Linux) ─────────────────────────────────
    const W = "/work/tree";
    const procs = {
      list: async () => [
        { pid: 1, parentPid: 0, command: "init" },
        { pid: 100, parentPid: 1, command: "codara" },
        { pid: 200, parentPid: 1, command: "vim notes.txt" },
        { pid: 300, parentPid: 100, command: "codara helper" },
        { pid: 400, parentPid: 100, command: "zsh" },
        { pid: 401, parentPid: 400, command: "tail -f log" },
        { pid: 500, parentPid: 1, command: "someone else's" },
        { pid: 600, parentPid: 1, command: "sleep" },
      ],
      cwds: async () => new Map([[200, "/home/u"], [300, "/home/u"], [401, "/home/u"], [600, `${W}/src`]]),
      readdir: async (p) => {
        const fds = { 200: ["0", "1", "5"], 300: ["7"], 400: ["0"], 401: ["3", "4"], 600: [] }[p.split("/")[2]];
        if (p.includes("/500/")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        if (!fds) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return fds;
      },
      readlink: async (p) => {
        const links = {
          "/proc/200/fd/0": "/dev/pts/1",
          "/proc/200/fd/1": "socket:[1234]",
          "/proc/200/fd/5": `${W}/.notes.txt.swp (deleted)`,
          "/proc/300/fd/7": `${W}/data/db.sqlite`,
          "/proc/400/fd/0": "/dev/pts/2",
          "/proc/401/fd/3": "pipe:[99]",
          "/proc/401/fd/4": `${W}/server.log`,
        };
        if (!(p in links)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return links[p];
      },
    };
    const pids = (found) => found.get(W).map((use) => use.pid).sort((a, b) => a - b);

    await check("process scan: on Linux a program with a file open inside counts, Codara's own helpers do not", async () => {
      const found = await agent.scanProcessesUnderCwds([W, "/other"], {
        appPid: 100,
        sessionPids: [400],
        readers: { platform: "linux", ...procs },
      });
      assert.deepEqual(pids(found), [200, 401, 600], "the editor, the session's tail and the cwd-inside process");
      assert.deepEqual(found.get("/other"), []);
      const single = await agent.scanProcessesUnderCwd(W, { appPid: 100, sessionPids: [], readers: { platform: "linux", ...procs } });
      assert.deepEqual(single.map((use) => use.pid).sort((a, b) => a - b), [200, 600], "outside a session the helpers are not counted");
    });

    await check("process scan: macOS keeps the working-directory check only; Windows has no scan", async () => {
      const mac = await agent.scanProcessesUnderCwds([W], { appPid: 100, sessionPids: [400], readers: { platform: "darwin", ...procs } });
      assert.deepEqual(pids(mac), [600]);
      assert.equal(await agent.scanProcessesUnderCwds([W], { appPid: 100, sessionPids: [], readers: { platform: "win32", ...procs } }), null);
    });

    await check("process scan: past the open-file cap or the time limit, working-directory hits survive and it says unknown", async () => {
      const capped = await agent.scanProcessesUnderCwds([W], {
        appPid: 100,
        sessionPids: [400],
        openFileBudget: 2,
        readers: { platform: "linux", ...procs },
      });
      assert.deepEqual(pids(capped), [600], "the process whose cwd is inside still counts");
      assert.equal(capped.openFilesUnknown, true);
      assert.equal(agent.processUsageUnknown(capped), true);
      const hung = await agent.scanProcessesUnderCwds([W], {
        appPid: 100,
        sessionPids: [400],
        timeoutMs: 150,
        readers: { platform: "linux", ...procs, readdir: () => new Promise(() => undefined) },
      });
      assert.deepEqual(pids(hung), [600]);
      assert.equal(hung.openFilesUnknown, true);
      const single = await agent.scanProcessesUnderCwd(W, { appPid: 100, sessionPids: [], openFileBudget: 2, readers: { platform: "linux", ...procs } });
      assert.deepEqual(single.map((use) => use.pid), [600]);
      assert.equal(single.openFilesUnknown, true);
      const whole = await agent.scanProcessesUnderCwds([W], { appPid: 100, sessionPids: [400], readers: { platform: "linux", ...procs } });
      assert.equal(agent.processUsageUnknown(whole), false);
      assert.equal(agent.processUsageUnknown(null), true);
    });

    await check("process scan: the open-file read is bounded; past it the answer is unknown", async () => {
      const open = await agent.openPathsOf([200, 401, 500, 999], procs);
      assert.deepEqual([...open.keys()].sort(), [200, 401]);
      assert.deepEqual(open.get(200), ["/dev/pts/1", `${W}/.notes.txt.swp`]);
      assert.equal(await agent.openPathsOf([200, 401], procs, 3), null, "5 descriptors do not fit a budget of 3");
    });

    if (process.platform === "linux") {
      await check("process scan, for real: a program elsewhere with a file open inside counts", async () => {
        const { spawn } = require("node:child_process");
        const held = path.join(scratch, "held");
        fs.mkdirSync(held);
        const out = fs.openSync(path.join(held, "server.log"), "a");
        const child = spawn("sleep", ["30"], { cwd: scratch, stdio: ["ignore", out, "ignore"] });
        fs.closeSync(out);
        try {
          await new Promise((resolve) => setTimeout(resolve, 200));
          const found = await agent.scanProcessesUnderCwd(held, { appPid: 2 ** 22 + 7, sessionPids: [], timeoutMs: 10_000 });
          assert.ok(found && found.some((use) => use.pid === child.pid), JSON.stringify(found));
        } finally {
          child.kill("SIGKILL");
        }
      });
    }

    // ── The rail's one line ─────────────────────────────────────────────
    await check("one quiet line for a pass, with the space freed and a link to the archive", async () => {
      const gb = 1024 * 1024 * 1024;
      const line = shared.autoCleanSummary([
        { mode: "auto-merged", result: { status: "removed", branchDeleted: true, reclaimedBytes: gb, archived: { path: "/a/2026-11-06/r--x", files: 1, bytes: 1 } } },
        { mode: "auto-merged", result: { status: "removed", branchDeleted: true, reclaimedBytes: gb / 2 } },
        { mode: "auto", result: { status: "removed", branchDeleted: true } },
        { mode: "auto-merged", result: { status: "removed", branchDeleted: true } },
      ]);
      assert.equal(line.title, "Removed 4 merged worktrees");
      assert.equal(line.body, "1.5 GB freed, data archived for 30 days (click to open it).");
      assert.equal(line.reveal, "/a/2026-11-06");
      const one = shared.autoCleanSummary([{ mode: "auto-merged", result: { status: "removed", branchDeleted: true, workspaceName: "fix-x" } }]);
      assert.equal(one.title, "Removed fix-x");
      assert.equal(one.reveal, undefined);
    });

    console.log(`\n${passed} passed`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    for (const file of outfiles) fs.rmSync(file, { force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
