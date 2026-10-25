// Integration test for src/main/agent-worktrees.ts, the policy behind the
// worktree.* agent-socket methods and the codara_worktree_* MCP tools. The
// module takes every app dependency as an argument, so it is bundled with
// esbuild (like test-worktrees.cjs) and driven against throwaway git
// repositories with an in-memory AppState, fake runs, panes and GitHub.
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

async function main() {
  const esbuild = require("esbuild");
  const cacheDir = path.join(__dirname, "..", "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outFile = path.join(cacheDir, `spark-agent-worktrees-${process.pid}.cjs`);
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
  const branchesOut = path.join(cacheDir, `spark-agent-worktrees-branches-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", "main", "git-branches.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: branchesOut,
    alias: { "@shared": path.join(__dirname, "..", "src", "shared") },
    external: ["electron", "ssh2", "cpu-features"],
    logLevel: "silent",
  });
  const aw = require(outFile);
  const branches = require(branchesOut);

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-agent-wt-")));
  // A fake home and git config: nothing here reads or writes the user's own.
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
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    commitFile(repo, ".gitignore", "node_modules/\n.env.local\ndist/\n", "ignore");
    commitFile(repo, "README.md", "# test\n", "init");
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);

    const auditFile = path.join(home, "logs", "worktree-audit.jsonl");
    let ids = 0;
    const h = {
      state: {
        workspaces: [{ id: "ws-repo", name: "repo", cwd: repo, color: "#123456", workers: [] }],
        workspaceRailOrder: ["ws-repo"],
        activeWorkspaceId: "ws-repo",
      },
      prefs: { agentWorktreesEnabled: true, agentsMayRemoveUserWorktrees: false, agentWorktreeRegenerableIgnoredByRepo: {} },
      runs: new Map(),
      paneWorkspace: { "pane-1": "ws-repo" },
      sessionCwds: {},
      sessionsUnder: () => [],
      terminals: [],
      processes: [],
      pulls: [],
      events: [],
      published: 0,
      now: new Date("2026-10-12T10:00:00Z"),
      afterVerify: null,
    };
    const deps = {
      loadState: async () => structuredClone(h.state),
      updateState: async (mutator) => {
        h.state = await mutator(structuredClone(h.state));
        return h.state;
      },
      loadPreferences: async () => h.prefs,
      publishState: () => {
        h.published += 1;
      },
      invalidateGitCache: () => {},
      getRun: async (id) => h.runs.get(id) ?? null,
      listRuns: async () => [...h.runs.values()],
      paneWorkspaceId: async (paneId) => h.paneWorkspace[paneId] ?? null,
      sessionCwd: (paneId) => h.sessionCwds[paneId] ?? null,
      sessionsUnderCwd: (dir) => h.sessionsUnder(dir),
      listRendererTerminals: async () => h.terminals,
      processesUnderCwd: async () => h.processes,
      github: {
        listPullRequestsForHead: async () => h.pulls,
        listMergedPullRequests: async () => h.pulls,
      },
      sendAgentEvent: (event) => h.events.push(event),
      audit: aw.createWorktreeAuditLog(auditFile),
      worktreesRoot: (repoCwd) => path.join(home, "worktrees", path.basename(repoCwd)),
      now: () => h.now,
      randomId: () => (++ids).toString(16).padStart(8, "a"),
      afterVerify: async () => {
        if (h.afterVerify) await h.afterVerify();
      },
    };
    const terminalAgent = { role: "studio", client: "claude-code", paneId: "pane-1" };
    const workspaceOf = (id) => h.state.workspaces.find((workspace) => workspace.id === id);

    // ── Create ─────────────────────────────────────────────────────────────
    const created = await aw.createAgentWorktree(terminalAgent, { purpose: "Fix the login bug" }, deps);
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.created, true);
    assert.match(created.branch, /^agent\/fix-the-login-bug-[0-9a-f]{4}$/);
    assert.equal(created.base, "origin/main");
    assert.ok(fs.existsSync(path.join(created.path, "README.md")), "the worktree is checked out");
    assert.equal(path.dirname(created.path), deps.worktreesRoot(repo), "it sits directly under the managed root");
    assert.equal(created.sourceWorkspaceId, "ws-repo");
    assert.match(created.next, /codara_worktree_remove/);
    const createdWorkspace = workspaceOf(created.workspaceId);
    assert.deepEqual(createdWorkspace.copyBranch.createdBy, {
      kind: "agent",
      client: "claude-code",
      paneId: "pane-1",
      purpose: "Fix the login bug",
    });
    assert.deepEqual(h.state.workspaceRailOrder, ["ws-repo", created.workspaceId], "nested after its source");
    assert.equal(h.events.at(-1).kind, "created");
    assert.equal(h.published, 1, "the renderer hears about the new workspace once");
    assert.equal(h.state.activeWorkspaceId, "ws-repo", "creating a worktree does not take focus");
    assert.equal(created.setupCommand, null);

    const again = await aw.createAgentWorktree(terminalAgent, { branch: created.branch }, deps);
    assert.equal(again.ok, true);
    assert.equal(again.created, false, "repeating a branch returns its worktree");
    assert.equal(again.workspaceId, created.workspaceId);

    for (const [branch, code] of [
      ["main", "WORKTREE_RESERVED_BRANCH"],
      ["HEAD", "WORKTREE_RESERVED_BRANCH"],
      ["codara/pr/12", "WORKTREE_RESERVED_BRANCH"],
      ["sandbox-2", "WORKTREE_RESERVED_BRANCH"],
      ["-rf", "WORKTREE_INVALID_BRANCH"],
      ["a..b", "WORKTREE_INVALID_BRANCH"],
      ["x@{1}", "WORKTREE_INVALID_BRANCH"],
    ]) {
      const refused = await aw.createAgentWorktree(terminalAgent, { branch }, deps);
      assert.equal(refused.ok, false);
      assert.equal(refused.code, code, `${branch}: ${JSON.stringify(refused)}`);
    }
    git(repo, ["branch", "existing-topic"]);
    assert.equal((await aw.createAgentWorktree(terminalAgent, { branch: "existing-topic" }, deps)).code, "WORKTREE_BRANCH_EXISTS");
    assert.equal((await aw.createAgentWorktree(terminalAgent, { branch: "nope", checkout: true }, deps)).code, "WORKTREE_BRANCH_NOT_FOUND");
    assert.equal((await aw.createAgentWorktree(terminalAgent, { branch: "x1", base: "no-such-ref" }, deps)).code, "WORKTREE_BASE_NOT_FOUND");
    const checkedOut = await aw.createAgentWorktree(terminalAgent, { branch: "existing-topic", checkout: true }, deps);
    assert.equal(checkedOut.ok, true, JSON.stringify(checkedOut));
    assert.equal(checkedOut.mode, "checkout");
    assert.equal((await aw.createAgentWorktree(terminalAgent, { branch: "main", checkout: true }, deps)).code, "WORKTREE_RESERVED_BRANCH");

    // ── In another workspace ───────────────────────────────────────────────
    // A coordinator in a plain folder, once the user allowed it into the
    // repository's workspace (terminal.create's worktree option), makes the
    // worktree there; the workspace never comes from the tool JSON.
    const notes = path.join(scratch, "notes");
    fs.mkdirSync(notes, { recursive: true });
    h.state.workspaces.push({ id: "ws-notes", name: "notes", cwd: notes, color: "#654321", workers: [] });
    h.paneWorkspace["pane-coord"] = "ws-notes";
    const coordinator = { role: "studio", client: "claude-code", paneId: "pane-coord" };
    assert.equal((await aw.createAgentWorktree(coordinator, { branch: "agent/from-notes" }, deps)).code, "WORKTREE_NOT_A_REPO");
    const elsewhere = await aw.createAgentWorktree({ ...coordinator, workspaceId: "ws-repo" }, { branch: "agent/from-notes" }, deps);
    assert.equal(elsewhere.ok, true, JSON.stringify(elsewhere));
    assert.equal(elsewhere.sourceWorkspaceId, "ws-repo");
    assert.equal(workspaceOf(elsewhere.workspaceId).copyBranch.repoCwd, repo);
    assert.equal(workspaceOf(elsewhere.workspaceId).copyBranch.createdBy.paneId, "pane-coord");
    assert.equal((await aw.createAgentWorktree({ ...coordinator, workspaceId: "ws-gone" }, {}, deps)).code, "WORKTREE_NO_WORKSPACE");

    // Its maker finds it again from the plain folder: by workspaceId for
    // setup and remove, and in list under elsewhere. Another agent there
    // does not.
    h.paneWorkspace["pane-other"] = "ws-notes";
    const bystander = { role: "studio", client: "codex", paneId: "pane-other" };
    const setupFromNotes = await aw.getAgentWorktreeSetup(coordinator, { workspaceId: elsewhere.workspaceId }, deps);
    assert.equal(setupFromNotes.ok, true, JSON.stringify(setupFromNotes));
    const dryRemove = await aw.removeAgentWorktree(coordinator, { workspaceId: elsewhere.workspaceId, dryRun: true }, deps);
    assert.equal(dryRemove.ok, true, JSON.stringify(dryRemove));
    assert.equal(dryRemove.wouldRemove, true, JSON.stringify(dryRemove));
    assert.equal((await aw.removeAgentWorktree(bystander, { workspaceId: elsewhere.workspaceId, dryRun: true }, deps)).ok, false);
    const listedFromNotes = await aw.listAgentWorktrees(coordinator, {}, deps);
    assert.equal(listedFromNotes.ok, true, JSON.stringify(listedFromNotes));
    assert.deepEqual(
      listedFromNotes.elsewhere.map((item) => [item.workspaceId, item.branch, item.repoCwd]),
      [[elsewhere.workspaceId, "agent/from-notes", repo]],
    );
    assert.equal((await aw.listAgentWorktrees(bystander, {}, deps)).code, "WORKTREE_NOT_A_REPO");
    assert.equal(
      (await aw.listAgentWorktrees(terminalAgent, {}, deps)).elsewhere,
      undefined,
      "a worktree in the caller's own repository is listed only once, under worktrees",
    );

    // terminal.create's worktree: never waits for setup (its call has 60 s,
    // part of it spent on the approval card), never opens in a checkout
    // another agent made, and goes again when the terminal does not open.
    const waits = [];
    const setupStatus = { id: "setup-1", state: "running", waitForSetup: true };
    const withSetup = {
      ...deps,
      worktreeSetup: {
        start: async () => setupStatus,
        whenPrepared: async () => setupStatus,
        waitFor: async (id, ms) => {
          waits.push(ms);
          return { ...setupStatus, state: "succeeded" };
        },
        get: async () => null,
        tail: async () => "",
        summary: (status) => ({ state: status.state }),
      },
    };
    const forTerminal = await aw.createTerminalWorktree({ ...coordinator, workspaceId: "ws-repo" }, { branch: "agent/term" }, withSetup);
    assert.equal(forTerminal.ok, true, JSON.stringify(forTerminal));
    assert.deepEqual(waits, [], "the setup runs on while the terminal opens");
    assert.equal(forTerminal.setup.state, "running");
    const reused = await aw.createTerminalWorktree({ ...coordinator, workspaceId: "ws-repo" }, { branch: "agent/term" }, deps);
    assert.equal(reused.ok, true, "its maker may open another terminal in it");
    assert.equal(reused.created, false);
    const taken = await aw.createTerminalWorktree({ ...bystander, workspaceId: "ws-repo" }, { branch: "agent/term" }, deps);
    assert.equal(taken.code, "WORKTREE_NOT_YOURS", JSON.stringify(taken));
    assert.ok(
      fs.readFileSync(auditFile, "utf8").trim().split("\n").map((entry) => JSON.parse(entry))
        .some((entry) => entry.outcome === "refused" && entry.code === "WORKTREE_NOT_YOURS" && entry.branch === "agent/term"),
      "a refused shared checkout is on the audit log",
    );
    assert.equal((await aw.rollBackTerminalWorktree(coordinator, reused, deps)).removed, false, "one that was there before stays");
    const rolledBack = await aw.rollBackTerminalWorktree(coordinator, forTerminal, deps);
    assert.equal(rolledBack.removed, true, JSON.stringify(rolledBack));
    assert.equal(fs.existsSync(forTerminal.path), false);
    assert.equal(refExists(repo, "refs/heads/agent/term"), false);
    assert.equal(workspaceOf(forTerminal.workspaceId), undefined);
    // Asked again from the other workspace, the removal answers as removed.
    const retriedElsewhere = await aw.removeAgentWorktree(coordinator, { workspaceId: forTerminal.workspaceId }, deps);
    assert.equal(retriedElsewhere.alreadyRemoved, true, JSON.stringify(retriedElsewhere));
    assert.notEqual(
      (await aw.removeAgentWorktree(bystander, { workspaceId: forTerminal.workspaceId }, deps)).alreadyRemoved,
      true,
      "another agent learns nothing about it",
    );
    // Its setup usually still runs (npm install) when the terminal fails: it
    // is stopped and its card dismissed first, or the process scan would
    // refuse the rollback and leave the worktree behind.
    const stops = [];
    const installing = {
      ...withSetup,
      worktreeSetup: {
        ...withSetup.worktreeSetup,
        stop: async (idOrPath) => {
          stops.push(idOrPath);
          h.processes = [];
          return true;
        },
      },
    };
    const busy = await aw.createTerminalWorktree({ ...coordinator, workspaceId: "ws-repo" }, { branch: "agent/installing" }, installing);
    assert.equal(busy.ok, true, JSON.stringify(busy));
    h.processes = [{ pid: 4343, command: "npm install" }];
    const stoppedFirst = await aw.rollBackTerminalWorktree(coordinator, busy, installing);
    h.processes = [];
    assert.equal(stoppedFirst.removed, true, JSON.stringify(stoppedFirst));
    assert.deepEqual(stops, [busy.path]);
    assert.equal(fs.existsSync(busy.path), false);

    // ── Who may call ───────────────────────────────────────────────────────
    for (const role of ["worker", "automation"]) {
      const refused = await aw.createAgentWorktree({ role, client: "cora" }, {}, deps);
      assert.equal(refused.code, "WORKTREE_FORBIDDEN", `${role} is refused`);
    }
    h.runs.set("run-live", { id: "run-live", workspaceId: "ws-repo", status: "running" });
    h.runs.set("run-done", { id: "run-done", workspaceId: "ws-repo", status: "complete" });
    h.runs.set("run-loom", { id: "run-loom", workspaceId: "ws-repo", status: "running", automationId: "auto-1" });
    assert.equal((await aw.listAgentWorktrees({ role: "talk", client: "cora", runId: "run-live" }, {}, deps)).code, "WORKTREE_FORBIDDEN", "a chat worker inherits its run id but is no manager");
    assert.equal((await aw.listAgentWorktrees({ role: "manager", client: "cora", runId: "run-done" }, {}, deps)).code, "WORKTREE_FORBIDDEN");
    assert.equal((await aw.listAgentWorktrees({ role: "manager", client: "cora", runId: "run-loom" }, {}, deps)).code, "WORKTREE_FORBIDDEN");
    assert.equal((await aw.listAgentWorktrees({ role: "manager", client: "cora", runId: "run-missing" }, {}, deps)).code, "WORKTREE_FORBIDDEN");
    const managerList = await aw.listAgentWorktrees({ role: "manager", client: "cora", runId: "run-live" }, {}, deps);
    assert.equal(managerList.ok, true, "a live manager is placed by its run");
    assert.equal(managerList.repoCwd, repo);
    assert.equal((await aw.listAgentWorktrees({ role: "studio", client: "x", paneId: "pane-unknown" }, {}, deps)).code, "WORKTREE_NO_WORKSPACE");

    h.prefs.agentWorktreesEnabled = false;
    assert.equal((await aw.createAgentWorktree(terminalAgent, {}, deps)).code, "WORKTREE_DISABLED");
    assert.equal((await aw.removeAgentWorktree(terminalAgent, { workspaceId: created.workspaceId }, deps)).code, "WORKTREE_DISABLED");
    assert.equal((await aw.listAgentWorktrees(terminalAgent, {}, deps)).ok, true, "listing survives the kill switch");
    h.prefs.agentWorktreesEnabled = true;

    // A caller inside an agent worktree still acts on the same repository.
    h.paneWorkspace["pane-inside"] = created.workspaceId;
    const fromInside = await aw.listAgentWorktrees({ role: "studio", client: "codex", paneId: "pane-inside" }, {}, deps);
    assert.equal(fromInside.repoCwd, repo);
    assert.equal(fromInside.worktrees.find((item) => item.workspaceId === created.workspaceId).isCaller, true);

    // ── Remove: refusals ───────────────────────────────────────────────────
    const tip = commitFile(created.path, "src/login.ts", "export const fixed = true;\n", "fix login");
    let refused = await aw.removeAgentWorktree(terminalAgent, { workspaceId: created.workspaceId }, deps);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "WORKTREE_NOT_MERGED", JSON.stringify(refused));
    assert.equal(refused.tip, tip);
    assert.equal(refused.details.aheadOfTarget, 1);
    assert.deepEqual(refused.details.commits, ["fix login"]);
    assert.equal(refused.details.pushed, false);
    assert.match(refused.hint, /merge/);
    assert.ok(fs.existsSync(created.path), "an unmerged worktree stays");

    const dry = await aw.removeAgentWorktree(terminalAgent, { workspaceId: created.workspaceId, dryRun: true }, deps);
    assert.equal(dry.ok, true);
    assert.equal(dry.wouldRemove, false);
    assert.deepEqual(dry.blockers, ["WORKTREE_NOT_MERGED"]);

    // Merge it, then make it dirty in each way that must block.
    git(repo, ["merge", "-q", "--ff-only", created.branch]);
    git(repo, ["push", "-q", "origin", "main"]);
    fs.writeFileSync(path.join(created.path, "README.md"), "# edited\n");
    refused = await aw.removeAgentWorktree(terminalAgent, { workspaceId: created.workspaceId }, deps);
    assert.equal(refused.code, "WORKTREE_DIRTY");
    assert.deepEqual(refused.details.dirtyPaths, ["README.md"]);
    git(created.path, ["checkout", "--", "README.md"]);
    fs.writeFileSync(path.join(created.path, "notes.txt"), "scratch\n");
    assert.equal((await aw.removeAgentWorktree(terminalAgent, { workspaceId: created.workspaceId }, deps)).code, "WORKTREE_DIRTY");
    fs.rmSync(path.join(created.path, "notes.txt"));
    fs.writeFileSync(path.join(created.path, ".env.local"), "TOKEN=1\n");
    fs.mkdirSync(path.join(created.path, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(path.join(created.path, "node_modules", "left-pad", "index.js"), "\n");
    refused = await aw.removeAgentWorktree(terminalAgent, { workspaceId: created.workspaceId }, deps);
    assert.equal(refused.code, "WORKTREE_IGNORED_FILES");
    assert.deepEqual(refused.dirty.ignoredBlocking, [".env.local"], "node_modules is regenerable");
    h.prefs.agentWorktreeRegenerableIgnoredByRepo = { [repo]: [".env.local"] };
    assert.notEqual((await aw.removeAgentWorktree(terminalAgent, { workspaceId: created.workspaceId, dryRun: true }, deps)).blockers.includes("WORKTREE_IGNORED_FILES"), true, "a per-repo pattern allows it");
    h.prefs.agentWorktreeRegenerableIgnoredByRepo = {};

    h.sessionsUnder = (dir) => (dir === created.path ? ["pane-shell"] : []);
    refused = await aw.removeAgentWorktree(terminalAgent, { workspaceId: created.workspaceId, discardIgnoredFiles: true }, deps);
    assert.equal(refused.code, "WORKTREE_RUNNING_PANES");
    assert.deepEqual(refused.running.paneIds, ["pane-shell"]);
    h.sessionsUnder = () => [];
    h.terminals = [{ paneId: "pane-in-rail", workspaceId: created.workspaceId }];
    assert.equal((await aw.removeAgentWorktree(terminalAgent, { workspaceId: created.workspaceId, discardIgnoredFiles: true }, deps)).code, "WORKTREE_RUNNING_PANES");
    h.terminals = [];
    h.runs.set("run-inside", { id: "run-inside", workspaceId: created.workspaceId, status: "running" });
    assert.equal((await aw.removeAgentWorktree(terminalAgent, { workspaceId: created.workspaceId, discardIgnoredFiles: true }, deps)).code, "WORKTREE_ACTIVE_RUNS");
    h.runs.delete("run-inside");
    h.processes = [{ pid: 4242, command: "node server.js" }];
    refused = await aw.removeAgentWorktree(terminalAgent, { workspaceId: created.workspaceId, discardIgnoredFiles: true }, deps);
    assert.equal(refused.code, "WORKTREE_RUNNING_PROCESSES");
    assert.equal(refused.running.processes, 1);
    h.processes = [];
    assert.equal(
      (await aw.removeAgentWorktree({ role: "studio", client: "codex", paneId: "pane-inside" }, { workspaceId: created.workspaceId, discardIgnoredFiles: true }, deps)).code,
      "WORKTREE_CALLER_INSIDE",
    );

    // A commit between the check and the locked re-check is caught.
    h.afterVerify = async () => {
      commitFile(created.path, "late.txt", "late\n", "late commit");
    };
    refused = await aw.removeAgentWorktree(terminalAgent, { workspaceId: created.workspaceId, discardIgnoredFiles: true }, deps);
    assert.equal(refused.code, "WORKTREE_CHANGED", JSON.stringify(refused));
    h.afterVerify = null;
    assert.ok(fs.existsSync(created.path));
    git(repo, ["merge", "-q", "--ff-only", created.branch]);
    git(repo, ["push", "-q", "origin", "main"]);
    const mergedTip = git(created.path, ["rev-parse", "HEAD"]);

    // ── Remove: success ────────────────────────────────────────────────────
    git(repo, ["update-ref", "refs/codara/removed-worktrees/2026-08-01/ws-old", mergedTip]);
    git(repo, ["update-ref", "refs/codara/removed-worktrees/2026-10-01/ws-recent", mergedTip]);
    const removed = await aw.removeAgentWorktree(terminalAgent, { workspaceId: created.workspaceId, discardIgnoredFiles: true }, deps);
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.equal(removed.removed, true);
    assert.equal(removed.proof, "ancestor");
    assert.equal(removed.verifiedCommit, mergedTip);
    assert.equal(removed.branchDeleted, true);
    assert.equal(removed.recoveryRef, `refs/codara/removed-worktrees/2026-10-12/${created.workspaceId}`);
    assert.equal(git(repo, ["rev-parse", removed.recoveryRef]), mergedTip, "the tip is kept for recovery");
    assert.match(removed.recoverWith, /worktree add .* -b agent\//);
    assert.ok(!fs.existsSync(created.path), "the directory is gone");
    assert.ok(!refExists(repo, `refs/heads/${created.branch}`), "the branch is gone");
    assert.equal(workspaceOf(created.workspaceId), undefined, "the rail row is gone");
    assert.equal(h.events.at(-1).kind, "removed");
    assert.ok(!refExists(repo, "refs/codara/removed-worktrees/2026-08-01/ws-old"), "recovery refs older than 30 days are pruned");
    assert.ok(refExists(repo, "refs/codara/removed-worktrees/2026-10-01/ws-recent"));

    const retried = await aw.removeAgentWorktree(terminalAgent, { workspaceId: created.workspaceId }, deps);
    assert.equal(retried.ok, true);
    assert.equal(retried.alreadyRemoved, true, "a retried removal succeeds without acting");
    assert.equal((await aw.removeAgentWorktree(terminalAgent, { workspaceId: "ws-nope" }, deps)).code, "WORKTREE_NOT_FOUND");
    assert.equal((await aw.removeAgentWorktree(terminalAgent, { path: repo }, deps)).code, "WORKTREE_NOT_FOUND", "the main checkout is never a target");

    // Squash merge: the content is in the target but the tip is not.
    const squash = await aw.createAgentWorktree(terminalAgent, { branch: "agent/squash" }, deps);
    commitFile(squash.path, "a.txt", "a\n", "a");
    commitFile(squash.path, "b.txt", "b\n", "b");
    git(repo, ["merge", "-q", "--squash", "agent/squash"]);
    git(repo, ["commit", "-q", "-m", "squash agent/squash"]);
    git(repo, ["push", "-q", "origin", "main"]);
    const squashed = await aw.removeAgentWorktree(terminalAgent, { workspaceId: squash.workspaceId }, deps);
    assert.equal(squashed.ok, true, JSON.stringify(squashed));
    assert.equal(squashed.proof, "content-in-target");
    assert.equal(squashed.branchDeleted, true);

    // A merged pull request whose head is exactly the tip.
    const viaPr = await aw.createAgentWorktree(terminalAgent, { branch: "agent/pr" }, deps);
    const prTip = commitFile(viaPr.path, "pr.txt", "pr\n", "pr work");
    commitFile(repo, "other.txt", "moved on\n", "unrelated");
    git(repo, ["push", "-q", "origin", "main"]);
    h.pulls = [{ number: 7, url: "https://github.com/o/r/pull/7", headRefName: "agent/pr", headRefOid: prTip, baseRefName: "main", isCrossRepository: true }];
    assert.equal((await aw.removeAgentWorktree(terminalAgent, { workspaceId: viaPr.workspaceId }, deps)).code, "WORKTREE_NOT_MERGED", "a fork's PR proves nothing");
    h.pulls = [{ number: 7, url: "https://github.com/o/r/pull/7", headRefName: "agent/pr", headRefOid: "0".repeat(40), baseRefName: "main", isCrossRepository: false }];
    assert.equal((await aw.removeAgentWorktree(terminalAgent, { workspaceId: viaPr.workspaceId }, deps)).code, "WORKTREE_NOT_MERGED", "a PR of another head proves nothing");
    h.pulls = [{ number: 7, url: "https://github.com/o/r/pull/7", headRefName: "agent/pr", headRefOid: prTip, baseRefName: "main", isCrossRepository: false }];
    const prRemoved = await aw.removeAgentWorktree(terminalAgent, { workspaceId: viaPr.workspaceId }, deps);
    assert.equal(prRemoved.ok, true, JSON.stringify(prRemoved));
    assert.equal(prRemoved.proof, "pull-request");
    assert.deepEqual(prRemoved.pullRequest, { number: 7, url: "https://github.com/o/r/pull/7" });
    assert.deepEqual(h.events.at(-1).pullRequest, prRemoved.pullRequest);
    h.pulls = [];

    // A worktree the user made is theirs unless they opt in.
    const userMade = await aw.createAgentWorktree(terminalAgent, { branch: "agent/user-owned" }, deps);
    h.state.workspaces = h.state.workspaces.map((workspace) =>
      workspace.id === userMade.workspaceId
        ? { ...workspace, copyBranch: { ...workspace.copyBranch, createdBy: undefined } }
        : workspace,
    );
    assert.equal((await aw.removeAgentWorktree(terminalAgent, { workspaceId: userMade.workspaceId }, deps)).code, "WORKTREE_USER_CREATED");
    h.prefs.agentsMayRemoveUserWorktrees = true;
    assert.equal((await aw.removeAgentWorktree(terminalAgent, { workspaceId: userMade.workspaceId }, deps)).ok, true);
    h.prefs.agentsMayRemoveUserWorktrees = false;

    // Another active run's worktree is off limits.
    const owned = await aw.createAgentWorktree({ role: "manager", client: "cora", runId: "run-live" }, { branch: "agent/owned" }, deps);
    assert.equal(owned.ok, true, JSON.stringify(owned));
    h.runs.set("run-other", { id: "run-other", workspaceId: "ws-repo", status: "running" });
    assert.equal(
      (await aw.removeAgentWorktree({ role: "manager", client: "cora", runId: "run-other" }, { workspaceId: owned.workspaceId }, deps)).code,
      "WORKTREE_OWNED_BY_ACTIVE_RUN",
    );
    assert.equal((await aw.removeAgentWorktree({ role: "manager", client: "cora", runId: "run-live" }, { workspaceId: owned.workspaceId }, deps)).ok, true);

    // So is the worktree of an agent whose pane is still open, even though
    // it works there only through absolute paths.
    const paneOwned = await aw.createAgentWorktree(terminalAgent, { branch: "agent/pane-owned" }, deps);
    assert.equal(paneOwned.ok, true, JSON.stringify(paneOwned));
    const otherPane = { role: "studio", client: "codex", paneId: "pane-2" };
    h.paneWorkspace["pane-2"] = "ws-repo";
    h.sessionCwds["pane-1"] = repo;
    const paneRefused = await aw.removeAgentWorktree(otherPane, { workspaceId: paneOwned.workspaceId }, deps);
    assert.equal(paneRefused.code, "WORKTREE_OWNED_BY_LIVE_AGENT", JSON.stringify(paneRefused));
    assert.equal(paneRefused.details.ownerPaneId, "pane-1");
    assert.match(paneRefused.error, /pane-1/);
    const paneDry = await aw.removeAgentWorktree(otherPane, { workspaceId: paneOwned.workspaceId, dryRun: true }, deps);
    assert.equal(paneDry.wouldRemove, false);
    assert.ok(paneDry.blockers.includes("WORKTREE_OWNED_BY_LIVE_AGENT"));
    const paneListed = (await aw.listAgentWorktrees(otherPane, {}, deps)).worktrees.find((entry) => entry.workspaceId === paneOwned.workspaceId);
    assert.equal(paneListed.removable, false, JSON.stringify(paneListed));
    delete h.sessionCwds["pane-1"];
    h.terminals = [{ paneId: "pane-1", workspaceId: "ws-elsewhere" }];
    assert.equal(
      (await aw.removeAgentWorktree(otherPane, { workspaceId: paneOwned.workspaceId }, deps)).code,
      "WORKTREE_OWNED_BY_LIVE_AGENT",
      "a pane the renderer still shows is open",
    );
    h.terminals = [];
    // A worktree on a drive that is unmounted right now: its folder is
    // missing, but removing some other worktree must not drop its
    // registration, or its branch would look free and its work unlisted.
    const unmounted = path.join(scratch, "unmounted-drive", "wt");
    git(repo, ["worktree", "add", "-q", "-b", "on-unmounted-drive", unmounted]);
    fs.rmSync(path.dirname(unmounted), { recursive: true, force: true });
    const isRegistered = (dir) =>
      git(repo, ["worktree", "list", "--porcelain"]).split("\n").includes(`worktree ${dir}`);
    assert.ok(isRegistered(unmounted));
    const paneClosed = await aw.removeAgentWorktree(otherPane, { workspaceId: paneOwned.workspaceId }, deps);
    assert.equal(paneClosed.ok, true, JSON.stringify(paneClosed));
    assert.ok(isRegistered(unmounted), "a removal keeps another worktree's registration");

    // A worktree deleted from disk behind Codara's back: the row goes, the
    // branch only when its tip is merged.
    const vanished = await aw.createAgentWorktree(terminalAgent, { branch: "agent/vanished" }, deps);
    commitFile(vanished.path, "v.txt", "v\n", "unmerged work");
    fs.rmSync(vanished.path, { recursive: true, force: true });
    const vanishedResult = await aw.removeAgentWorktree(terminalAgent, { workspaceId: vanished.workspaceId }, deps);
    assert.equal(vanishedResult.ok, true, JSON.stringify(vanishedResult));
    assert.equal(vanishedResult.alreadyRemoved, true);
    assert.equal(vanishedResult.branchDeleted, false);
    assert.ok(refExists(repo, "refs/heads/agent/vanished"), "unmerged work on a branch is never deleted");
    assert.equal(workspaceOf(vanished.workspaceId), undefined);
    assert.equal(isRegistered(vanished.path), false, "the vanished worktree's own registration is dropped");
    assert.ok(isRegistered(unmounted), "a missing folder elsewhere keeps its registration");
    git(repo, ["worktree", "remove", unmounted]);
    git(repo, ["branch", "-D", "on-unmounted-drive"]);

    // ── List ───────────────────────────────────────────────────────────────
    const listed = await aw.createAgentWorktree(terminalAgent, { branch: "agent/listed" }, deps);
    const manual = path.join(scratch, "manual-wt");
    git(repo, ["worktree", "add", "-q", manual, "-b", "manual"]);
    const list = await aw.listAgentWorktrees(terminalAgent, { checkMerge: true }, deps);
    assert.equal(list.ok, true);
    const item = list.worktrees.find((entry) => entry.workspaceId === listed.workspaceId);
    assert.equal(item.removable, true, JSON.stringify(item));
    assert.equal(item.merge.status, "merged");
    assert.equal(item.merge.proof, "ancestor");
    assert.ok(list.unmanaged.some((entry) => entry.path === manual && entry.branch === "manual"), "a hand-made worktree is listed as unmanaged");
    assert.ok(!list.unmanaged.some((entry) => entry.path === repo), "the main checkout is not a worktree to manage");

    // ── Scope edges ────────────────────────────────────────────────────────
    // Without the renderer, a pane is placed by its spawn cwd, in the deepest
    // workspace that contains it; the repository is still the git root.
    const nested = path.join(repo, "packages", "app");
    fs.mkdirSync(path.join(nested, "src"), { recursive: true });
    h.state.workspaces.push({ id: "ws-nested", name: "app", cwd: nested, color: "#123456", workers: [] });
    h.sessionCwds["pane-orphan"] = path.join(nested, "src");
    const orphanScope = await aw.resolveWorktreeScope({ role: "studio", client: "codex", paneId: "pane-orphan" }, deps);
    assert.equal(orphanScope.callerWorkspace.id, "ws-nested", "the deepest workspace wins");
    assert.equal(orphanScope.parentWorkspace.id, "ws-repo", "the repository's own workspace is the parent");
    assert.equal(orphanScope.repoCwd, repo);
    h.state.workspaces = h.state.workspaces.filter((workspace) => workspace.id !== "ws-nested");
    h.state.workspaces.push({ id: "ws-ssh", name: "ssh", cwd: "ssh://host-1/srv/app", color: "#123456", workers: [], remote: { hostId: "host-1" } });
    h.paneWorkspace["pane-ssh"] = "ws-ssh";
    assert.equal((await aw.createAgentWorktree({ role: "studio", client: "codex", paneId: "pane-ssh" }, {}, deps)).code, "WORKTREE_REMOTE_UNSUPPORTED");
    const plain = path.join(scratch, "plain");
    fs.mkdirSync(plain);
    h.state.workspaces.push({ id: "ws-plain", name: "plain", cwd: plain, color: "#123456", workers: [] });
    h.paneWorkspace["pane-plain"] = "ws-plain";
    assert.equal((await aw.listAgentWorktrees({ role: "studio", client: "codex", paneId: "pane-plain" }, {}, deps)).code, "WORKTREE_NOT_A_REPO");
    h.state.workspaces = h.state.workspaces.filter((workspace) => workspace.id !== "ws-ssh" && workspace.id !== "ws-plain");

    // ── Create edges ───────────────────────────────────────────────────────
    const rootEntries = () => (fs.existsSync(deps.worktreesRoot(repo)) ? fs.readdirSync(deps.worktreesRoot(repo)) : []);
    const entriesBefore = rootEntries();
    const injected = await aw.createAgentWorktree(terminalAgent, { branch: "agent/inject", base: "--upload-pack=touch pwned" }, deps);
    assert.equal(injected.code, "WORKTREE_BASE_NOT_FOUND", "an option-looking base is just an unknown ref");
    assert.deepEqual(rootEntries(), entriesBefore, "a refused create touches nothing on disk");
    assert.ok(!refExists(repo, "refs/heads/agent/inject"));
    assert.ok(!fs.existsSync(path.join(repo, "pwned")));

    h.prefs.copyBranchSetupCommandByRepo = { [repo]: "npm ci" };
    const twins = await Promise.all([
      aw.createAgentWorktree(terminalAgent, { branch: "agent/twin" }, deps),
      aw.createAgentWorktree(terminalAgent, { branch: "agent/twin" }, deps),
    ]);
    delete h.prefs.copyBranchSetupCommandByRepo;
    assert.deepEqual(twins.map((result) => result.ok), [true, true], JSON.stringify(twins));
    assert.deepEqual(twins.map((result) => result.created).sort(), [false, true], "two concurrent creates make one worktree");
    assert.equal(twins[0].workspaceId, twins[1].workspaceId);
    assert.equal(h.state.workspaces.filter((workspace) => workspace.copyBranch?.branch === "agent/twin").length, 1);
    assert.equal(twins[0].setupCommand, "npm ci", "the repository's setup command comes back to run");
    assert.match(twins[0].next, /codara_terminal_create/);

    const realUpdate = deps.updateState;
    deps.updateState = async () => {
      throw new Error("disk full");
    };
    const unsaved = await aw.createAgentWorktree(terminalAgent, { branch: "agent/unsaved" }, deps);
    deps.updateState = realUpdate;
    assert.equal(unsaved.code, "WORKTREE_STATE_FAILED", JSON.stringify(unsaved));
    assert.equal(unsaved.rolledBack, true);
    assert.ok(!refExists(repo, "refs/heads/agent/unsaved"), "the rollback deletes the new branch");
    assert.ok(!rootEntries().some((entry) => entry.includes("unsaved")), "the rollback deletes the directory");

    const originUrl = git(repo, ["remote", "get-url", "origin"]);
    git(repo, ["remote", "set-url", "origin", path.join(scratch, "offline.git")]);
    const offline = await aw.createAgentWorktree(terminalAgent, { branch: "agent/offline" }, deps);
    git(repo, ["remote", "set-url", "origin", originUrl]);
    assert.equal(offline.ok, true, JSON.stringify(offline));
    assert.match(offline.warnings[0], /^fetch failed/, "an unreachable remote is a warning, not a failure");

    // ── Remove: identity and local-state refusals ──────────────────────────
    const blocked = async (workspaceId, code, message) => {
      const result = await aw.removeAgentWorktree(terminalAgent, { workspaceId, discardIgnoredFiles: true }, deps);
      assert.equal(result.ok, false, `${message}: ${JSON.stringify(result)}`);
      assert.ok(result.blockers.includes(code), `${message}: ${JSON.stringify(result.blockers)}`);
      return result;
    };
    const twin = twins[0];
    git(repo, ["branch", "conflict-base", "main"]);
    const conflictWorktree = path.join(scratch, "conflict-wt");
    git(repo, ["worktree", "add", "-q", conflictWorktree, "conflict-base"]);
    commitFile(conflictWorktree, "README.md", "# theirs\n", "theirs");
    git(repo, ["worktree", "remove", conflictWorktree]);
    commitFile(twin.path, "README.md", "# ours\n", "ours");
    try {
      git(twin.path, ["rebase", "conflict-base"]);
    } catch {
      /* the conflict is the point */
    }
    await blocked(twin.workspaceId, "WORKTREE_OPERATION_IN_PROGRESS", "a rebase in progress");
    git(twin.path, ["rebase", "--abort"]);
    git(twin.path, ["reset", "-q", "--hard", "HEAD~1"]);
    git(repo, ["branch", "-D", "conflict-base"]);

    git(repo, ["worktree", "lock", twin.path]);
    await blocked(twin.workspaceId, "WORKTREE_LOCKED", "a locked worktree");
    git(repo, ["worktree", "unlock", twin.path]);
    git(twin.path, ["checkout", "-q", "--detach"]);
    await blocked(twin.workspaceId, "WORKTREE_DETACHED_HEAD", "a detached HEAD");
    git(twin.path, ["checkout", "-q", "-b", "agent/elsewhere"]);
    const switched = await blocked(twin.workspaceId, "WORKTREE_BRANCH_MISMATCH", "another branch");
    assert.equal(switched.details.checkedOutBranch, "agent/elsewhere");
    git(twin.path, ["checkout", "-q", "agent/twin"]);
    git(repo, ["branch", "-D", "agent/elsewhere"]);

    const fakeRecord = (id, cwd, branch, extra = {}) => ({
      id,
      name: id,
      cwd,
      color: "#123456",
      workers: [],
      copyBranch: {
        repoCwd: repo,
        branch,
        city: id,
        mode: "fork",
        createdAt: "2026-10-12T09:00:00.000Z",
        createdBy: { kind: "agent", client: "test" },
        ...extra,
      },
    });
    const link = path.join(deps.worktreesRoot(repo), "linked");
    fs.symlinkSync(twin.path, link, "dir");
    h.state.workspaces.push(
      fakeRecord("ws-link", link, "agent/twin"),
      fakeRecord("ws-outside", manual, "manual"),
    );
    await blocked("ws-link", "WORKTREE_NOT_MANAGED", "a symlinked path");
    await blocked("ws-outside", "WORKTREE_NOT_MANAGED", "a path outside the managed root");
    assert.ok(fs.existsSync(twin.path) && fs.existsSync(manual), "neither target was touched");
    h.state.workspaces = h.state.workspaces.filter((workspace) => workspace.id !== "ws-link" && workspace.id !== "ws-outside");
    fs.unlinkSync(link);

    h.state.workspaces = h.state.workspaces.map((workspace) =>
      workspace.id === twin.workspaceId
        ? { ...workspace, copyBranch: { ...workspace.copyBranch, origin: { kind: "issue", repository: "o/r", number: 1 } } }
        : workspace,
    );
    await blocked(twin.workspaceId, "WORKTREE_ORIGIN_MANAGED", "an issue workspace");
    h.state.workspaces = h.state.workspaces.map((workspace) => {
      if (workspace.id !== twin.workspaceId) return workspace;
      const { origin: _origin, ...copyBranch } = workspace.copyBranch;
      return { ...workspace, copyBranch };
    });

    // ── Remove: work that git status does not show ─────────────────────────
    // discardIgnoredFiles (passed by blocked()) acknowledges none of these.
    const hidden = await aw.createAgentWorktree(terminalAgent, { branch: "agent/hidden" }, deps);
    git(hidden.path, ["update-index", "--assume-unchanged", "README.md"]);
    fs.writeFileSync(path.join(hidden.path, "README.md"), "# edited where status cannot see\n");
    let unseen = await blocked(hidden.workspaceId, "WORKTREE_DIRTY", "an assume-unchanged edit");
    assert.deepEqual(unseen.details.hiddenChanges, ["README.md"]);
    git(hidden.path, ["update-index", "--no-assume-unchanged", "README.md"]);
    git(hidden.path, ["checkout", "--", "README.md"]);
    git(hidden.path, ["update-index", "--skip-worktree", "README.md"]);
    fs.writeFileSync(path.join(hidden.path, "README.md"), "# edited where status cannot see\n");
    await blocked(hidden.workspaceId, "WORKTREE_DIRTY", "a skip-worktree edit");
    git(hidden.path, ["update-index", "--no-skip-worktree", "README.md"]);
    git(hidden.path, ["checkout", "--", "README.md"]);

    // A linked worktree inside a regenerable ignored folder, and a clone
    // inside node_modules: git worktree remove would delete both with
    // everything they hold.
    const inner = path.join(hidden.path, "dist", "inner");
    git(repo, ["worktree", "add", "-q", "-b", "agent/inner", inner]);
    fs.writeFileSync(path.join(inner, "wip.txt"), "uncommitted\n");
    unseen = await blocked(hidden.workspaceId, "WORKTREE_NESTED_REPOSITORY", "a worktree nested in an ignored folder");
    assert.deepEqual(unseen.details.nestedRepositories, [inner]);
    git(repo, ["worktree", "remove", "--force", inner]);
    git(repo, ["branch", "-D", "agent/inner"]);
    const clone = path.join(hidden.path, "node_modules", "patched-dep");
    execFileSync("git", ["init", "-q", "-b", "main", clone]);
    commitFile(clone, "fix.js", "only here\n", "local patch");
    unseen = await blocked(hidden.workspaceId, "WORKTREE_NESTED_REPOSITORY", "a clone in node_modules");
    assert.deepEqual(unseen.details.nestedRepositories, [clone]);
    fs.rmSync(path.join(hidden.path, "node_modules"), { recursive: true, force: true });

    // The scan has no depth limit: a clone five folders down is still found.
    const deepClone = path.join(hidden.path, "dist", "a", "b", "c", "d", "deep-clone");
    execFileSync("git", ["init", "-q", "-b", "main", deepClone]);
    unseen = await blocked(hidden.workspaceId, "WORKTREE_NESTED_REPOSITORY", "a clone deep in an ignored folder");
    assert.deepEqual(unseen.details.nestedRepositories, [deepClone]);
    fs.rmSync(path.join(hidden.path, "dist"), { recursive: true, force: true });

    // A walk that runs out of budget proves nothing, so it blocks instead of
    // reporting the worktree clean, and names the folder it gave up on.
    for (let i = 0; i < 6; i += 1) fs.mkdirSync(path.join(hidden.path, "node_modules", `pkg-${i}`, "lib"), { recursive: true });
    const tightDeps = { ...deps, nestedScanMaxDirs: 4 };
    const unfinished = await aw.removeAgentWorktree(
      terminalAgent,
      { workspaceId: hidden.workspaceId, discardIgnoredFiles: true },
      tightDeps,
    );
    assert.equal(unfinished.ok, false, JSON.stringify(unfinished));
    assert.ok(unfinished.blockers.includes("WORKTREE_NESTED_SCAN_INCOMPLETE"), JSON.stringify(unfinished.blockers));
    assert.equal(unfinished.code, "WORKTREE_NESTED_SCAN_INCOMPLETE");
    assert.equal(unfinished.details.unscannedFolder, "node_modules/");
    assert.match(unfinished.error, /node_modules\/ is too large or unreadable/);
    assert.ok(fs.existsSync(hidden.path), "the refused removal left the worktree in place");
    const tightList = await aw.listAgentWorktrees(terminalAgent, {}, tightDeps);
    const listedHidden = tightList.worktrees.find((item) => item.workspaceId === hidden.workspaceId);
    assert.equal(listedHidden.removable, false);
    assert.ok(listedHidden.blockers.includes("WORKTREE_NESTED_SCAN_INCOMPLETE"), JSON.stringify(listedHidden.blockers));
    const enough = await aw.removeAgentWorktree(
      terminalAgent,
      { workspaceId: hidden.workspaceId, discardIgnoredFiles: true, dryRun: true },
      { ...deps, nestedScanMaxDirs: 13 },
    );
    assert.equal(enough.dryRun, true);
    assert.ok(!enough.blockers.includes("WORKTREE_NESTED_SCAN_INCOMPLETE"), JSON.stringify(enough.blockers));
    fs.rmSync(path.join(hidden.path, "node_modules"), { recursive: true, force: true });

    // A nested repository committed as a bare gitlink: git refuses to remove
    // the worktree, so list and dry run must not call it removable.
    const vendored = path.join(hidden.path, "vendored");
    execFileSync("git", ["init", "-q", "-b", "main", vendored]);
    commitFile(vendored, "only-copy.txt", "nowhere else\n", "only copy");
    git(hidden.path, ["add", "vendored"]);
    git(hidden.path, ["commit", "-q", "-m", "vendor"]);
    git(repo, ["merge", "-q", "--ff-only", "agent/hidden"]);
    unseen = await blocked(hidden.workspaceId, "WORKTREE_SUBMODULES", "a committed nested repository");
    assert.deepEqual(unseen.details.submodules, ["vendored"]);
    assert.ok(fs.existsSync(path.join(vendored, "only-copy.txt")));
    git(repo, ["reset", "-q", "--hard", "HEAD~1"]);

    // A worktree that cannot be read is not "already removed".
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const managedRoot = deps.worktreesRoot(repo);
      fs.chmodSync(managedRoot, 0o000);
      try {
        unseen = await aw.removeAgentWorktree(terminalAgent, { workspaceId: hidden.workspaceId }, deps);
      } finally {
        fs.chmodSync(managedRoot, 0o755);
      }
      assert.equal(unseen.code, "WORKTREE_NOT_MANAGED", JSON.stringify(unseen));
      assert.ok(workspaceOf(hidden.workspaceId), "the row stays");
      assert.ok(fs.existsSync(path.join(vendored, "only-copy.txt")));
    }

    // A caller-named target must be another branch: the worktree's own
    // branch, its pushed copy, a commit id or a revision expression would
    // prove any tip merged.
    const own = await aw.createAgentWorktree(terminalAgent, { branch: "agent/own-target" }, deps);
    const ownTip = commitFile(own.path, "own.txt", "unmerged\n", "unmerged work");
    git(repo, ["push", "-q", "origin", "agent/own-target"]);
    for (const target of ["agent/own-target", "origin/agent/own-target", ownTip, "agent/own-target~0", "refs/heads/agent/own-target"]) {
      const result = await aw.removeAgentWorktree(terminalAgent, { workspaceId: own.workspaceId, target }, deps);
      assert.equal(result.code, "WORKTREE_TARGET_NOT_FOUND", `${target}: ${JSON.stringify(result)}`);
      assert.ok(result.details.targetProblem, target);
    }
    assert.ok(fs.existsSync(path.join(own.path, "own.txt")) && refExists(repo, "refs/heads/agent/own-target"));
    git(repo, ["branch", "release", ownTip]);
    const intoRelease = await aw.removeAgentWorktree(terminalAgent, { workspaceId: own.workspaceId, target: "release" }, deps);
    assert.equal(intoRelease.ok, true, JSON.stringify(intoRelease));
    assert.equal(intoRelease.target, "release");
    assert.equal(git(repo, ["rev-parse", "release"]), ownTip, "the work lives on in the target");
    git(repo, ["branch", "-D", "release"]);
    git(repo, ["push", "-q", "origin", "--delete", "agent/own-target"]);
    git(repo, ["fetch", "-q", "--prune", "origin"]);
    // The same rule holds when only the branch is left to delete.
    const gone = await aw.createAgentWorktree(terminalAgent, { branch: "agent/gone" }, deps);
    commitFile(gone.path, "gone.txt", "unmerged\n", "unmerged work");
    fs.rmSync(gone.path, { recursive: true, force: true });
    const goneResult = await aw.removeAgentWorktree(terminalAgent, { workspaceId: gone.workspaceId, target: "agent/gone" }, deps);
    assert.equal(goneResult.alreadyRemoved, true, JSON.stringify(goneResult));
    assert.equal(goneResult.branchDeleted, false);
    assert.ok(refExists(repo, "refs/heads/agent/gone"), "an unmerged branch outlives its deleted directory");
    git(repo, ["branch", "-D", "agent/gone"]);

    // list and remove decide alike.
    fs.writeFileSync(path.join(twin.path, "scratch.txt"), "x\n");
    h.terminals = [{ paneId: "pane-twin", workspaceId: twin.workspaceId }];
    const listedTwin = (await aw.listAgentWorktrees(terminalAgent, { checkMerge: true }, deps)).worktrees.find(
      (entry) => entry.workspaceId === twin.workspaceId,
    );
    const removedTwin = await aw.removeAgentWorktree(terminalAgent, { workspaceId: twin.workspaceId }, deps);
    assert.equal(listedTwin.removable, false);
    assert.deepEqual(listedTwin.blockers, removedTwin.blockers, "list reports what remove decides");
    assert.deepEqual(removedTwin.blockers, ["WORKTREE_DIRTY", "WORKTREE_RUNNING_PANES"]);
    h.terminals = [];
    fs.rmSync(path.join(twin.path, "scratch.txt"));

    // ── Remove: edges ──────────────────────────────────────────────────────
    h.state.activeWorkspaceId = twin.workspaceId;
    const removedActive = await aw.removeAgentWorktree(terminalAgent, { workspaceId: twin.workspaceId }, deps);
    assert.equal(removedActive.ok, true, JSON.stringify(removedActive));
    assert.equal(h.state.activeWorkspaceId, "ws-repo", "an active worktree hands focus to its parent");
    assert.ok(!h.state.workspaceRailOrder.includes(twin.workspaceId));

    const keptBranch = await aw.removeAgentWorktree(terminalAgent, { workspaceId: checkedOut.workspaceId }, deps);
    assert.equal(keptBranch.ok, true, JSON.stringify(keptBranch));
    assert.equal(keptBranch.branchDeleted, false, "a checked-out existing branch is kept by default");
    assert.ok(refExists(repo, "refs/heads/existing-topic"));

    const dryBefore = fs.existsSync(offline.path);
    const offlineDry = await aw.removeAgentWorktree(terminalAgent, { workspaceId: offline.workspaceId, dryRun: true }, deps);
    assert.equal(offlineDry.wouldRemove, true, JSON.stringify(offlineDry));
    assert.equal(fs.existsSync(offline.path), dryBefore, "a dry run changes nothing");
    assert.ok(workspaceOf(offline.workspaceId), "a dry run keeps the row");
    assert.ok(refExists(repo, "refs/heads/agent/offline"));

    // ── Limit ──────────────────────────────────────────────────────────────
    const fakes = Array.from({ length: 20 }, (_, index) => ({
      id: `ws-fake-${index}`,
      name: `fake ${index}`,
      cwd: path.join(scratch, `fake-${index}`),
      color: "#000000",
      workers: [],
      copyBranch: {
        repoCwd: repo,
        branch: `agent/fake-${index}`,
        city: `fake-${index}`,
        mode: "fork",
        createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        createdBy: { kind: "agent", client: "test" },
      },
    }));
    h.state.workspaces = [...h.state.workspaces, ...fakes];
    const limited = await aw.createAgentWorktree(terminalAgent, { branch: "agent/one-too-many" }, deps);
    assert.equal(limited.code, "WORKTREE_LIMIT");
    assert.equal(limited.oldest[0].workspaceId, "ws-fake-0");
    h.state.workspaces = h.state.workspaces.filter((workspace) => !workspace.id.startsWith("ws-fake-"));

    // ── Branch compare-and-delete ──────────────────────────────────────────
    git(repo, ["branch", "cad", "HEAD~1"]);
    const moved = await branches.deleteBranchIfAt(repo, "cad", git(repo, ["rev-parse", "HEAD"]));
    assert.deepEqual([moved.ok, moved.reason], [false, "BRANCH_MOVED"]);
    assert.equal((await branches.deleteBranchIfAt(repo, "manual", git(repo, ["rev-parse", "manual"]))).reason, "BRANCH_CHECKED_OUT");
    assert.equal((await branches.deleteBranchIfAt(repo, "cad", git(repo, ["rev-parse", "cad"]))).ok, true);
    assert.ok(!refExists(repo, "refs/heads/cad"));

    // ── Audit log ──────────────────────────────────────────────────────────
    const auditLines = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(auditLines.some((entry) => entry.action === "create" && entry.outcome === "created"));
    assert.ok(auditLines.some((entry) => entry.action === "remove" && entry.outcome === "removed" && entry.recoveryRef));
    assert.ok(auditLines.some((entry) => entry.outcome === "refused" && entry.code === "WORKTREE_NOT_MERGED"));
    assert.ok(auditLines.some((entry) => entry.outcome === "dry-run"));
    assert.equal(fs.statSync(auditFile).mode & 0o777, 0o600, "the audit log is private");
    const rotating = path.join(scratch, "rotate", "audit.jsonl");
    fs.mkdirSync(path.dirname(rotating), { recursive: true });
    fs.writeFileSync(rotating, "x".repeat(5 * 1024 * 1024));
    await aw.createWorktreeAuditLog(rotating)({ action: "create", outcome: "refused", code: "WORKTREE_LIMIT", caller: terminalAgent });
    assert.ok(fs.existsSync(`${rotating}.1`), "a full log rotates");
    assert.equal(fs.readFileSync(rotating, "utf8").trim().split("\n").length, 1);

    // ── Pure helpers ───────────────────────────────────────────────────────
    for (const entry of ["node_modules/", "packages/a/node_modules/", "dist/", "src/x.pyc", ".DS_Store", "tsconfig.tsbuildinfo"]) {
      assert.equal(aw.isRegenerableIgnored(entry), true, `${entry} regenerates`);
    }
    for (const entry of [".env.local", "secrets/", "notes.md", "config/credentials.json"]) {
      assert.equal(aw.isRegenerableIgnored(entry), false, `${entry} is kept`);
    }
    assert.equal(aw.isRegenerableIgnored("generated/", ["generated/"]), true);
    assert.equal(aw.isRegenerableIgnored("out.log", ["*.log"]), true);

    const order = [];
    const first = aw.withRepoLock("k", async () => {
      order.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 80));
      order.push("first:end");
    });
    const timedOut = aw.withRepoLock("k", async () => order.push("never"), { waitMs: 10 });
    const third = aw.withRepoLock("k", async () => order.push("third"));
    await assert.rejects(timedOut, (err) => err instanceof aw.RepoLockTimeoutError);
    await Promise.all([first, third]);
    assert.deepEqual(order, ["first:start", "first:end", "third"], "one at a time, and a timed-out waiter never blocks the next");
    await aw.withRepoLock("other", async () => order.push("parallel"));

    // ── Process scan ───────────────────────────────────────────────────────
    if (process.platform === "linux" || process.platform === "darwin") {
      const busy = path.join(scratch, "busy");
      fs.mkdirSync(busy);
      const child = spawn("sleep", ["30"], { cwd: busy, stdio: "ignore" });
      children.push(child);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const foreign = await aw.scanProcessesUnderCwd(busy, { appPid: 2 ** 22 + 7, sessionPids: [] });
      assert.ok(foreign && foreign.some((entry) => entry.pid === child.pid), "a process in the directory is found");
      const own = await aw.scanProcessesUnderCwd(busy, { appPid: process.pid, sessionPids: [] });
      assert.ok(own && !own.some((entry) => entry.pid === child.pid), "Codara's own helpers are not counted");
      const inSession = await aw.scanProcessesUnderCwd(busy, { appPid: process.pid, sessionPids: [child.pid] });
      assert.ok(inSession && inSession.some((entry) => entry.pid === child.pid), "a terminal session's process is counted");
    }

    console.log("PASS: agent worktrees (create, list, remove, proofs, refusals, audit, lock, scan)");
  } finally {
    for (const child of children) child.kill("SIGKILL");
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(outFile, { force: true });
    fs.rmSync(branchesOut, { force: true });
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
