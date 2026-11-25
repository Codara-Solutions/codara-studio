// The idle clock of the cleanup screen and the rail
// (src/main/worktree-cleanup/inspect.ts lastWorkAt, scan.ts, rail.ts): "idle
// N days", the 7-day stale rule and the "no activity for N days" advice go by
// the last commit, the newest changed or new file and the last agent turn,
// never by git's own index, logs/HEAD and HEAD, which git rewrites with
// nobody there. The rule that refuses a removal right after a touch keeps
// that cautious clock (lastActivity; test-worktree-auto-merged.cjs drives it).
// Throwaway repositories only.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DAY = 24 * 60 * 60_000;

function git(cwd, args, env = {}) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } }).trim();
}

const outputs = [];
async function bundle(entry, name) {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `spark-idle-clock-${name}-${process.pid}.cjs`);
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
  const [inspect, scanMod, rail, agent, advice] = await Promise.all([
    bundle("src/main/worktree-cleanup/inspect.ts", "inspect"),
    bundle("src/main/worktree-cleanup/scan.ts", "scan"),
    bundle("src/main/worktree-cleanup/rail.ts", "rail"),
    bundle("src/main/agent-worktrees.ts", "agent"),
    bundle("src/shared/worktree-cleanup-agent.ts", "advice"),
  ]);

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-idle-clock-")));
  const home = path.join(scratch, "home");
  fs.mkdirSync(home, { recursive: true });
  const gitConfig = path.join(scratch, "gitconfig");
  fs.writeFileSync(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.HOME = home;

  try {
    const now = Date.now();
    const old = new Date(now - 20 * DAY);
    const dated = { GIT_AUTHOR_DATE: old.toISOString(), GIT_COMMITTER_DATE: old.toISOString() };
    const repo = path.join(scratch, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
    fs.writeFileSync(path.join(repo, "notes.md"), "notes\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "init"], dated);
    const tree = path.join(scratch, "trees", "quiet");
    git(repo, ["worktree", "add", "-q", tree, "-b", "feature/quiet"]);
    const head = git(tree, ["rev-parse", "HEAD"]);
    const admin = path.join(repo, ".git", "worktrees", "quiet");
    // What a status or a fetch does with nobody there.
    const gitTouches = () => {
      git(tree, ["status", "--porcelain"]);
      for (const name of ["index", "HEAD", path.join("logs", "HEAD")]) fs.utimesSync(path.join(admin, name), new Date(), new Date());
    };
    const days = (at) => Math.abs(Math.round((now - at) / DAY));

    await check("git's own files are no work; the cautious clock still sees them", async () => {
      gitTouches();
      assert.equal(days(await inspect.lastWorkAt(tree, head, repo, null)), 20, "the last commit");
      assert.equal(days(await inspect.lastActivity(tree, head, repo)), 0, "the removal's quiet rule keeps git's own files");
    });

    await check("a changed, new or deleted file, or an agent's turn, is work", async () => {
      const at = (file, when) => fs.utimesSync(path.join(tree, file), when, when);
      const twoDays = new Date(now - 2 * DAY);
      fs.writeFileSync(path.join(tree, "README.md"), "# edited\n");
      at("README.md", twoDays);
      assert.equal(days(await inspect.lastWorkAt(tree, head, repo, null)), 2, "an edit");
      git(tree, ["checkout", "-q", "--", "README.md"]);
      fs.writeFileSync(path.join(tree, "draft.txt"), "x\n");
      at("draft.txt", twoDays);
      assert.equal(days(await inspect.lastWorkAt(tree, head, repo, null)), 2, "a new file");
      fs.rmSync(path.join(tree, "draft.txt"));
      fs.rmSync(path.join(tree, "notes.md"));
      assert.equal(days(await inspect.lastWorkAt(tree, head, repo, null)), 0, "a deletion leaves its folder's time");
      git(tree, ["checkout", "-q", "--", "notes.md"]);
      fs.utimesSync(tree, old, old);
      assert.equal(days(await inspect.lastWorkAt(tree, head, repo, now - 3 * DAY)), 3, "an agent's last turn");
      // A status that cannot be read: the cautious clock, never an older one.
      gitTouches();
      assert.equal(days(await inspect.lastWorkAt(tree, head, repo, null, null)), 0);
    });

    // ── The cleanup screen and the advice ──────────────────────────────────
    const h = {
      state: {
        workspaces: [
          { id: "ws-repo", name: "repo", cwd: repo, color: "#123456", workers: [] },
          {
            id: "ws-quiet",
            name: "quiet",
            cwd: tree,
            color: "#123456",
            workers: [],
            copyBranch: { repoCwd: repo, branch: "feature/quiet", baseBranch: "main", city: "quiet", mode: "fork", createdAt: new Date(now - 10 * DAY).toISOString() },
          },
        ],
        workspaceRailOrder: ["ws-repo", "ws-quiet"],
        activeWorkspaceId: "ws-repo",
      },
      turnAt: null,
    };
    const deps = {
      loadState: async () => structuredClone(h.state),
      updateState: async (mutator) => (h.state = await mutator(structuredClone(h.state))),
      publishState: () => {},
      invalidateGitCache: () => {},
      listRuns: async () => [],
      sessionCwd: () => null,
      sessionsUnderCwd: () => [],
      listRendererTerminals: async () => [],
      processesUnderCwds: async (dirs) => new Map(dirs.map((dir) => [dir, []])),
      runningServers: () => 0,
      pullRequests: async () => ({ open: [], merged: [] }),
      regenerableIgnored: async () => [],
      appPaths: () => [path.join(scratch, "app-not-here")],
      isProtectedPath: () => false,
      audit: agent.createWorktreeAuditLog(path.join(home, "logs", "worktree-audit.jsonl")),
      now: () => new Date(now),
      lastAgentTurnAt: (ids) => (ids.includes("ws-quiet") ? h.turnAt : null),
    };

    await check("the cleanup screen: idle since the last commit, or the last agent turn", async () => {
      gitTouches();
      const row = async () => (await scanMod.scanWorktreeCleanup(deps)).scan.rows.find((entry) => entry.id === tree);
      assert.equal(days((await row()).lastActivityAt), 20);
      h.turnAt = now - 4 * DAY;
      assert.equal(days((await row()).lastActivityAt), 4);
      h.turnAt = null;
    });

    await check("the advice says how long nobody worked in it", async () => {
      gitTouches();
      const lastActivityAt = (await scanMod.scanWorktreeCleanup(deps)).scan.rows.find((entry) => entry.id === tree).lastActivityAt;
      const facts = {
        inUse: [],
        missing: false,
        locked: false,
        hardBlockers: [],
        dirty: { tracked: 0, untracked: 0, inProgress: null },
        localWork: null,
        pullRequest: null,
        lastActivityAt,
        merge: { state: "unmerged" },
        ahead: 1,
        unpushed: 0,
        onRemote: true,
      };
      const result = advice.adviseWorktree(facts, now);
      assert.equal(result.advice, "review", JSON.stringify(result));
      assert.match(result.reason, /no activity for 20 days/);
    });

    await check("the rail: stale after a week without work, whatever git did to its own files", async () => {
      gitTouches();
      const stateOf = async () => (await rail.railWorktreeStates(deps)).find((entry) => entry.workspaceId === "ws-quiet");
      let state = await stateOf();
      assert.equal(state.merge, "empty");
      assert.equal(state.stale, true);
      fs.writeFileSync(path.join(tree, "draft.txt"), "started\n");
      state = await stateOf();
      assert.equal(state.stale, undefined, "a file written today is work");
      fs.rmSync(path.join(tree, "draft.txt"));
      h.turnAt = now - DAY;
      assert.equal((await stateOf()).stale, undefined, "an agent's turn yesterday is work");
      h.turnAt = null;
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
