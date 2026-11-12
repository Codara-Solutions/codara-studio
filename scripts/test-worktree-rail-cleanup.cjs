// Integration test for merged and missing copy-branch workspaces in the rail:
// removeCopyWorktree treating a branch that is already gone as deleted and
// keeping an unmerged one with a note, and src/main/worktree-cleanup/rail.ts
// (the rail's merge state, one-click Clean up, Remove from rail and the
// automatic cleanup of a missing folder). Bundled with esbuild like
// test-worktree-cleanup.cjs and driven against throwaway git repositories with
// an in-memory AppState and fake terminals. A fake home and git config:
// nothing reads or writes the user's own.
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

function branchExists(cwd, name) {
  try {
    git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

function registered(repo, dir) {
  return git(repo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .some((line) => line === `worktree ${dir}`);
}

async function bundle(entry, name) {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `spark-worktree-rail-${name}-${process.pid}.cjs`);
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

function copyWorkspace(id, cwd, repo, branch, extra = {}) {
  return {
    id,
    name: id,
    cwd,
    color: "#123456",
    workers: [],
    copyBranch: {
      repoCwd: repo,
      branch,
      baseBranch: "main",
      city: path.basename(cwd),
      mode: "fork",
      createdAt: CREATED_AT,
      createdBy: { kind: "agent", client: "claude-code", paneId: "pane-gone" },
      ...extra,
    },
  };
}

async function main() {
  const bundles = await Promise.all([
    bundle("src/main/git-worktrees.ts", "git"),
    bundle("src/main/worktree-cleanup/rail.ts", "rail"),
    bundle("src/main/agent-worktrees.ts", "agent"),
    bundle("src/main/worktree-cleanup/remove.ts", "remove"),
  ]);
  const [wt, rail, agent, remove] = bundles.map((entry) => entry.mod);

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-wt-rail-")));
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

    // ── removeCopyWorktree ────────────────────────────────────────────────
    await check("a branch that is already gone counts as deleted", async () => {
      const dir = add("gone-branch", "fix/alert-email-digest");
      // A GitHub merge or an agent's cleanup deleted the branch: here the
      // worktree is detached first, as git refuses to delete a checked-out one.
      git(dir, ["checkout", "-q", "--detach"]);
      git(repo, ["branch", "-D", "fix/alert-email-digest"]);
      const result = await wt.removeCopyWorktree({
        repoCwd: repo,
        worktreePath: dir,
        branch: "fix/alert-email-digest",
        deleteBranch: true,
      });
      assert.deepEqual(result, { ok: true });
      assert.equal(fs.existsSync(dir), false);
      assert.equal(registered(repo, dir), false);
    });

    await check("an unmerged branch is kept with a note, and the removal still succeeds", async () => {
      const dir = add("unmerged-delete", "feature/unmerged-delete");
      commitFile(dir, "work.txt", "work\n", "unmerged work");
      const result = await wt.removeCopyWorktree({
        repoCwd: repo,
        worktreePath: dir,
        branch: "feature/unmerged-delete",
        deleteBranch: true,
      });
      assert.equal(result.ok, true);
      assert.equal(result.branchKept, "it has unmerged commits");
      assert.equal(fs.existsSync(dir), false);
      assert.equal(branchExists(repo, "feature/unmerged-delete"), true, "git -d kept the unmerged branch");
    });

    await check("a folder that is already gone only loses its registration", async () => {
      const dir = add("missing-delete", "feature/missing-delete");
      fs.rmSync(dir, { recursive: true, force: true });
      assert.equal(registered(repo, dir), true);
      const result = await wt.removeCopyWorktree({
        repoCwd: repo,
        worktreePath: dir,
        branch: "feature/missing-delete",
        deleteBranch: true,
      });
      assert.deepEqual(result, { ok: true });
      assert.equal(registered(repo, dir), false);
      assert.equal(branchExists(repo, "feature/missing-delete"), false, "the branch had no commits of its own");
    });

    await check("Delete refuses a missing folder whose worktree is locked or detached", async () => {
      const locked = add("locked-delete", "feature/locked-delete");
      git(repo, ["worktree", "lock", locked]);
      fs.rmSync(locked, { recursive: true, force: true });
      const lockedResult = await wt.removeCopyWorktree({
        repoCwd: repo,
        worktreePath: locked,
        branch: "feature/locked-delete",
        deleteBranch: true,
      });
      assert.equal(lockedResult.ok, false);
      assert.match(lockedResult.error, /locked/);
      assert.equal(registered(repo, locked), true);
      assert.equal(branchExists(repo, "feature/locked-delete"), true);

      const detached = path.join(trees, "detached-delete");
      git(repo, ["worktree", "add", "-q", "--detach", detached]);
      commitFile(detached, "orphan.txt", "orphan\n", "commit on no branch");
      fs.rmSync(detached, { recursive: true, force: true });
      const detachedResult = await wt.removeCopyWorktree({ repoCwd: repo, worktreePath: detached, branch: "" });
      assert.equal(detachedResult.ok, false);
      assert.match(detachedResult.error, /detached/);
      assert.equal(registered(repo, detached), true, "the only record of that commit stays");
    });

    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await check("a folder that cannot be read is not taken for a missing one", async () => {
        const holder = path.join(scratch, "unreadable");
        fs.mkdirSync(holder);
        const dir = path.join(holder, "wt");
        git(repo, ["worktree", "add", "-q", dir, "-b", "feature/unreadable"]);
        fs.writeFileSync(path.join(dir, "work.txt"), "uncommitted\n");
        fs.chmodSync(holder, 0o000);
        try {
          const result = await wt.removeCopyWorktree({
            repoCwd: repo,
            worktreePath: dir,
            branch: "feature/unreadable",
            deleteBranch: true,
          });
          assert.equal(result.ok, false);
        } finally {
          fs.chmodSync(holder, 0o755);
        }
        assert.equal(fs.readFileSync(path.join(dir, "work.txt"), "utf8"), "uncommitted\n");
        assert.equal(registered(repo, dir), true);
        git(repo, ["worktree", "remove", "--force", dir]);
      });
    }

    // ── The rail ──────────────────────────────────────────────────────────
    // Merged and clean, folder present.
    const merged = add("merged", "feature/merged");
    commitFile(merged, "merged.txt", "merged\n", "merged work");
    mergeIntoMain("feature/merged");
    // Merged and clean, but busy with the workspace's own terminal.
    const mergedBusy = add("merged-busy", "feature/merged-busy");
    commitFile(mergedBusy, "busy.txt", "busy\n", "busy work");
    mergeIntoMain("feature/merged-busy");
    // Merged, with uncommitted changes.
    const mergedDirty = add("merged-dirty", "feature/merged-dirty");
    commitFile(mergedDirty, "dirty.txt", "dirty\n", "dirty work");
    mergeIntoMain("feature/merged-dirty");
    fs.writeFileSync(path.join(mergedDirty, "notes.txt"), "not committed\n");
    // Unmerged, folder present.
    const unmerged = add("unmerged", "feature/unmerged");
    commitFile(unmerged, "u.txt", "u\n", "unmerged work");
    // Missing folder, still registered, merged.
    const missingMerged = add("missing-merged", "feature/missing-merged");
    commitFile(missingMerged, "mm.txt", "mm\n", "missing merged work");
    mergeIntoMain("feature/missing-merged");
    fs.rmSync(missingMerged, { recursive: true, force: true });
    // Missing folder, registered, merged, but a terminal of the workspace is open.
    const missingBusy = add("missing-busy", "feature/missing-busy");
    commitFile(missingBusy, "mb.txt", "mb\n", "missing busy work");
    mergeIntoMain("feature/missing-busy");
    fs.rmSync(missingBusy, { recursive: true, force: true });
    // Missing folder, registered, locked (a drive that is only away).
    const missingLocked = add("missing-locked", "feature/missing-locked");
    commitFile(missingLocked, "ml.txt", "ml\n", "missing locked work");
    mergeIntoMain("feature/missing-locked");
    git(repo, ["worktree", "lock", missingLocked]);
    fs.rmSync(missingLocked, { recursive: true, force: true });
    // Missing folder and registration (an agent ran git worktree remove), branch deleted.
    const goneAll = add("gone-all", "feature/gone-all");
    commitFile(goneAll, "ga.txt", "ga\n", "gone all work");
    mergeIntoMain("feature/gone-all");
    git(repo, ["worktree", "remove", goneAll]);
    git(repo, ["branch", "-d", "feature/gone-all"]);
    // Missing folder and registration, branch still there and merged.
    const goneMerged = add("gone-merged", "feature/gone-merged");
    commitFile(goneMerged, "gm.txt", "gm\n", "gone merged work");
    mergeIntoMain("feature/gone-merged");
    git(repo, ["worktree", "remove", goneMerged]);
    // Missing folder and registration, branch with unmerged commits.
    const goneUnmerged = add("gone-unmerged", "feature/gone-unmerged");
    commitFile(goneUnmerged, "gu.txt", "gu\n", "gone unmerged work");
    git(repo, ["worktree", "remove", goneUnmerged]);
    // Missing folder and registration, merged by squash, with a commit its
    // upstream lacks.
    const goneUnpushed = add("gone-unpushed", "feature/gone-unpushed");
    commitFile(goneUnpushed, "gp.txt", "one\n", "pushed part");
    git(goneUnpushed, ["push", "-q", "-u", "origin", "feature/gone-unpushed"]);
    commitFile(goneUnpushed, "gp.txt", "one\ntwo\n", "unpushed part");
    commitFile(repo, "gp.txt", "one\ntwo\n", "squash feature/gone-unpushed");
    git(repo, ["push", "-q", "origin", "main"]);
    git(repo, ["worktree", "remove", goneUnpushed]);
    // Missing folder whose parent folder is gone too (an unmounted drive).
    const awayRoot = path.join(scratch, "away");
    fs.mkdirSync(awayRoot);
    const away = path.join(awayRoot, "wt");
    git(repo, ["worktree", "add", "-q", away, "-b", "feature/away"]);
    commitFile(away, "away.txt", "away\n", "away work");
    mergeIntoMain("feature/away");
    git(repo, ["worktree", "remove", away]);
    fs.rmSync(awayRoot, { recursive: true, force: true });
    // Missing folder right under a mount point: the drive is away and its
    // mount point is left empty.
    const mountPoint = path.join(scratch, "mnt-usb");
    fs.mkdirSync(mountPoint);
    const onDrive = path.join(mountPoint, "wt");
    git(repo, ["worktree", "add", "-q", onDrive, "-b", "feature/on-drive"]);
    commitFile(onDrive, "drive.txt", "drive\n", "drive work");
    mergeIntoMain("feature/on-drive");
    fs.rmSync(onDrive, { recursive: true, force: true });
    // An unrelated worktree no rail action may touch.
    const bystander = add("bystander", "feature/bystander");
    fs.writeFileSync(path.join(bystander, "keep.txt"), "keep\n");

    const auditFile = path.join(home, "logs", "worktree-audit.jsonl");
    const h = {
      state: {
        workspaces: [
          { id: "ws-repo", name: "repo", cwd: repo, color: "#123456", workers: [] },
          copyWorkspace("ws-merged", merged, repo, "feature/merged"),
          copyWorkspace("ws-merged-busy", mergedBusy, repo, "feature/merged-busy"),
          copyWorkspace("ws-merged-dirty", mergedDirty, repo, "feature/merged-dirty"),
          copyWorkspace("ws-unmerged", unmerged, repo, "feature/unmerged"),
          copyWorkspace("ws-missing-merged", missingMerged, repo, "feature/missing-merged"),
          copyWorkspace("ws-missing-busy", missingBusy, repo, "feature/missing-busy"),
          copyWorkspace("ws-missing-locked", missingLocked, repo, "feature/missing-locked"),
          copyWorkspace("ws-gone-all", goneAll, repo, "feature/gone-all"),
          copyWorkspace("ws-gone-merged", goneMerged, repo, "feature/gone-merged"),
          copyWorkspace("ws-gone-unmerged", goneUnmerged, repo, "feature/gone-unmerged"),
          copyWorkspace("ws-gone-unpushed", goneUnpushed, repo, "feature/gone-unpushed"),
          copyWorkspace("ws-away", away, repo, "feature/away"),
          copyWorkspace("ws-on-drive", onDrive, repo, "feature/on-drive"),
          // Made after its base commit and never committed to.
          copyWorkspace("ws-bystander", bystander, repo, "feature/bystander", {
            createdAt: new Date(Date.now() + 5_000).toISOString(),
          }),
        ],
        activeWorkspaceId: "ws-merged",
      },
      published: 0,
      terminals: [
        { paneId: "pane-merged-busy", workspaceId: "ws-merged-busy", cwd: mergedBusy },
        { paneId: "pane-missing-busy", workspaceId: "ws-missing-busy", cwd: missingBusy },
      ],
      now: new Date("2026-10-23T10:00:00Z"),
    };
    h.state.workspaceRailOrder = h.state.workspaces.map((workspace) => workspace.id);
    const deps = {
      loadState: async () => structuredClone(h.state),
      updateState: async (mutator) => {
        h.state = await mutator(structuredClone(h.state));
        return h.state;
      },
      publishState: () => {
        h.published += 1;
      },
      invalidateGitCache: () => undefined,
      listRuns: async () => [],
      sessionCwd: () => null,
      sessionsUnderCwd: () => [],
      listRendererTerminals: async () => h.terminals,
      processesUnderCwds: async (dirs) => new Map(dirs.map((dir) => [dir, []])),
      runningServers: () => 0,
      pullRequests: async () => ({ open: [], merged: [] }),
      regenerableIgnored: async () => [],
      appPaths: () => [path.join(scratch, "app-not-here")],
      isProtectedPath: () => false,
      audit: agent.createWorktreeAuditLog(auditFile),
      now: () => h.now,
    };
    const has = (id) => h.state.workspaces.some((workspace) => workspace.id === id);

    // Worktrees made with plain `git worktree add`, which no rail row shows.
    const outside = add("outside", "feat/outside");
    const pruned = add("pruned", "feat/pruned");
    fs.rmSync(pruned, { recursive: true, force: true });
    const overview = await rail.railWorktreeOverview(deps);
    git(repo, ["worktree", "remove", "--force", outside]);
    // Only this one: other rows' missing folders must stay registered.
    fs.rmSync(path.join(repo, ".git", "worktrees", "pruned"), { recursive: true, force: true });
    git(repo, ["branch", "-D", "feat/outside", "feat/pruned"]);
    await check("the rail lists the worktrees made outside Codara under their project, and only those", async () => {
      const listed = overview.external.find((entry) => entry.path === outside);
      assert.deepEqual([listed?.projectId, listed?.branch], ["ws-repo", "feat/outside"]);
      assert.ok(listed.headAt > 0, "with when its commit was made");
      const shown = new Set(h.state.workspaces.map((workspace) => workspace.cwd));
      for (const entry of overview.external) {
        assert.notEqual(entry.path, repo, "not the main checkout");
        assert.notEqual(entry.path, pruned, "not a pruned one");
        assert.ok(!shown.has(entry.path), `not a row the rail has: ${entry.path}`);
      }
      assert.ok(overview.states.length > 0);
      assert.ok(
        overview.states.filter((entry) => entry.merge !== "gone").every((entry) => entry.headAt > 0),
        "every row with a commit says when it was made",
      );
    });

    const states = Object.fromEntries((await rail.railWorktreeStates(deps)).map((entry) => [entry.workspaceId, entry]));
    await check("the rail reads merge and folder state for every copy-branch workspace", async () => {
      assert.equal(states["ws-repo"], undefined, "the main checkout is not a copy-branch row");
      assert.equal(states["ws-merged"].merge, "merged");
      assert.equal(states["ws-merged"].missing, false);
      assert.equal(states["ws-merged"].autoCandidate, false, "a folder that is there is never removed on its own");
      assert.equal(states["ws-unmerged"].merge, "unmerged");
      assert.equal(states["ws-missing-merged"].missing, true);
      assert.equal(states["ws-missing-merged"].merge, "merged");
      assert.equal(states["ws-missing-merged"].autoCandidate, true);
      assert.equal(states["ws-gone-all"].merge, "gone");
      assert.equal(states["ws-gone-all"].branchGone, true);
      assert.equal(states["ws-gone-all"].autoCandidate, true);
      assert.equal(states["ws-gone-merged"].merge, "merged");
      assert.equal(states["ws-gone-unmerged"].merge, "unmerged");
      assert.equal(states["ws-gone-unmerged"].autoCandidate, false);
      assert.equal(states["ws-gone-unpushed"].merge, "merged", "squash-merged content counts as merged");
      assert.equal(states["ws-bystander"].merge, "empty", "no commits of its own is not merged work");
      assert.equal(states["ws-bystander"].autoCandidate, false);
    });

    await check("auto never removes a worktree whose folder is still there, dirty or clean", async () => {
      for (const id of ["ws-merged", "ws-merged-dirty", "ws-bystander"]) {
        const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: id, mode: "auto" });
        assert.equal(result.status, "refused", id);
        assert.equal(has(id), true, id);
      }
      assert.equal(fs.existsSync(merged), true);
      assert.equal(fs.existsSync(path.join(mergedDirty, "notes.txt")), true);
    });

    await check("Clean up refuses a merged worktree with uncommitted changes", async () => {
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-merged-dirty", mode: "manual" });
      assert.equal(result.status, "refused");
      assert.match(result.message, /uncommitted work \(notes.txt\)/);
      assert.equal(fs.existsSync(path.join(mergedDirty, "notes.txt")), true);
      assert.equal(branchExists(repo, "feature/merged-dirty"), true);
      assert.equal(has("ws-merged-dirty"), true);
    });

    await check("Clean up refuses a branch that is not merged", async () => {
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-unmerged", mode: "manual" });
      assert.equal(result.status, "refused");
      assert.match(result.message, /not merged/);
      assert.equal(fs.existsSync(unmerged), true);
      assert.equal(has("ws-unmerged"), true);
    });

    await check("every press Clean up turns down before the removal is in the audit log, with what it said", async () => {
      const rows = fs
        .readFileSync(auditFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((row) => row.caller.client === "workspace-rail");
      const dirty = rows.find((row) => row.workspaceId === "ws-merged-dirty");
      assert.deepEqual([dirty?.outcome, dirty?.code, dirty?.branch], ["refused", "DIRTY", "feature/merged-dirty"]);
      assert.match(dirty.message, /uncommitted work/);
      const notMerged = rows.find((row) => row.workspaceId === "ws-unmerged");
      assert.deepEqual([notMerged?.outcome, notMerged?.code], ["refused", "UNMERGED"]);
      assert.equal(
        rows.filter((row) => row.workspaceId === "ws-merged" || row.workspaceId === "ws-bystander").length,
        0,
        "the automatic mode logs only what reached the removal",
      );
    });

    await check("the worktree Codara runs from is never offered as merged", async () => {
      const running = Object.fromEntries(
        (await rail.railWorktreeStates({ ...deps, appPaths: () => [path.join(merged, "out")] })).map((entry) => [entry.workspaceId, entry]),
      );
      assert.equal(running["ws-merged"].merge, "merged");
      assert.equal(running["ws-merged"].appRunsHere, true);
      assert.equal(running["ws-merged-busy"].appRunsHere, undefined);
      assert.equal(states["ws-merged"].appRunsHere, undefined, "nor anything when it runs from elsewhere");
    });

    await check("auto refuses a missing folder while a terminal of the workspace is open", async () => {
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-missing-busy", mode: "auto" });
      assert.equal(result.status, "refused");
      assert.match(result.message, /open terminal/);
      assert.equal(has("ws-missing-busy"), true);
      assert.equal(registered(repo, missingBusy), true);
      assert.equal(branchExists(repo, "feature/missing-busy"), true);
    });

    await check("auto refuses a branch with unpushed commits, even when its content is merged", async () => {
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-gone-unpushed", mode: "auto" });
      assert.equal(result.status, "refused");
      assert.match(result.message, /unpushed/);
      assert.equal(has("ws-gone-unpushed"), true);
      assert.equal(branchExists(repo, "feature/gone-unpushed"), true);
    });

    await check("auto refuses a locked worktree and one whose parent folder is gone or an empty mount point", async () => {
      const locked = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-missing-locked", mode: "auto" });
      assert.equal(locked.status, "refused");
      assert.match(locked.message, /Locked/);
      assert.equal(registered(repo, missingLocked), true);
      const unmounted = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-away", mode: "auto" });
      assert.equal(unmounted.status, "refused");
      assert.match(unmounted.message, /unmounted/);
      assert.equal(branchExists(repo, "feature/away"), true);
      assert.equal(has("ws-missing-locked"), true);
      assert.equal(has("ws-away"), true);
      const emptyMount = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-on-drive", mode: "auto" });
      assert.equal(emptyMount.status, "refused");
      assert.match(emptyMount.message, /unmounted/);
      assert.equal(registered(repo, onDrive), true);
      assert.equal(branchExists(repo, "feature/on-drive"), true);
      assert.equal(has("ws-on-drive"), true);
    });

    await check("auto refuses a missing folder whose branch has unmerged commits", async () => {
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-gone-unmerged", mode: "auto" });
      assert.equal(result.status, "refused");
      assert.equal(has("ws-gone-unmerged"), true);
      assert.equal(branchExists(repo, "feature/gone-unmerged"), true);
    });

    await check("auto removes a missing, merged, registered worktree: registration, branch and row", async () => {
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-missing-merged", mode: "auto" });
      assert.equal(result.status, "removed", result.message);
      assert.equal(result.branchDeleted, true);
      assert.equal(registered(repo, missingMerged), false);
      assert.equal(branchExists(repo, "feature/missing-merged"), false);
      assert.equal(has("ws-missing-merged"), false);
    });

    await check("auto removes a row whose folder, registration and branch are all gone", async () => {
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-gone-all", mode: "auto" });
      assert.equal(result.status, "removed", result.message);
      assert.equal(has("ws-gone-all"), false);
    });

    await check("auto deletes a merged branch left behind by a removed worktree", async () => {
      const tip = git(repo, ["rev-parse", "feature/gone-merged"]);
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-gone-merged", mode: "auto" });
      assert.equal(result.status, "removed", result.message);
      assert.equal(result.branchDeleted, true);
      assert.equal(branchExists(repo, "feature/gone-merged"), false);
      const saved = git(repo, ["for-each-ref", "--format=%(objectname)", "refs/codara/removed-worktrees/"]);
      assert.ok(saved.split("\n").includes(tip), "a recovery ref keeps the deleted branch's tip");
      assert.equal(has("ws-gone-merged"), false);
    });

    await check("Remove from rail keeps an unmerged branch and says why", async () => {
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-gone-unmerged", mode: "manual" });
      assert.equal(result.status, "removed", result.message);
      assert.equal(result.branchDeleted, false);
      assert.equal(result.branchKept, "it has unmerged commits");
      assert.equal(branchExists(repo, "feature/gone-unmerged"), true);
      assert.equal(has("ws-gone-unmerged"), false);
    });

    await check("Remove from rail works with the workspace's own terminal still open", async () => {
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-missing-busy", mode: "manual" });
      assert.equal(result.status, "removed", result.message);
      assert.equal(registered(repo, missingBusy), false);
      assert.equal(branchExists(repo, "feature/missing-busy"), false);
      assert.equal(has("ws-missing-busy"), false);
    });

    await check("Clean up removes a merged clean worktree with an idle shell open", async () => {
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-merged-busy", mode: "manual" });
      assert.equal(result.status, "removed", result.message);
      assert.equal(result.branchDeleted, true);
      assert.equal(fs.existsSync(mergedBusy), false);
      assert.equal(branchExists(repo, "feature/merged-busy"), false);
      assert.equal(has("ws-merged-busy"), false);
    });

    await check("Clean up refuses while a process runs in the worktree", async () => {
      const original = deps.processesUnderCwds;
      deps.processesUnderCwds = async (dirs) =>
        new Map(dirs.map((dir) => [dir, dir === merged ? [{ pid: 4242, command: "claude" }] : []]));
      try {
        const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-merged", mode: "manual" });
        assert.equal(result.status, "refused");
        assert.equal(result.message, "Stop 1 running process (claude, pid 4242) in it first.");
        assert.equal(fs.existsSync(merged), true);
        // Several are named by program and pid only: arguments can hold a token.
        deps.processesUnderCwds = async (dirs) =>
          new Map(
            dirs.map((dir) => [
              dir,
              dir === merged
                ? [
                    { pid: 1, command: "/usr/bin/node server.js --token=FAKE_SECRET" },
                    { pid: 2, command: "node worker.js" },
                    { pid: 3, command: "vite" },
                  ]
                : [],
            ]),
          );
        const several = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-merged", mode: "manual" });
        assert.equal(several.message, "Stop 3 running processes (node, pid 1; node, pid 2; vite, pid 3) in it first.");
        assert.doesNotMatch(several.message, /FAKE_SECRET/);
      } finally {
        deps.processesUnderCwds = original;
      }
    });

    await check("Clean up removes a merged clean worktree and makes another workspace active", async () => {
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-merged", mode: "manual" });
      assert.equal(result.status, "removed", result.message);
      assert.equal(fs.existsSync(merged), false);
      assert.equal(branchExists(repo, "feature/merged"), false);
      assert.equal(has("ws-merged"), false);
      assert.equal(h.state.activeWorkspaceId, "ws-repo");
    });

    // Merged worktrees that hold only ignored files.
    commitFile(repo, ".gitignore", "node_modules/\ntest-results/\nplaywright-report/\n.ruff_cache/\n.env\n", "ignore output");
    git(repo, ["push", "-q", "origin", "main"]);
    const mergedWith = (name, branch) => {
      const dir = add(name, branch);
      commitFile(dir, `${name}.txt`, `${name}\n`, `${name} work`);
      mergeIntoMain(branch);
      h.state.workspaces.push(copyWorkspace(`ws-${name}`, dir, repo, branch));
      return dir;
    };
    const output = mergedWith("merged-output", "feature/merged-output");
    fs.mkdirSync(path.join(output, "test-results", "run-1"), { recursive: true });
    fs.writeFileSync(path.join(output, "test-results", "run-1", "trace.zip"), "trace");
    fs.mkdirSync(path.join(output, "playwright-report"));
    fs.writeFileSync(path.join(output, "playwright-report", "index.html"), "<html></html>");
    fs.mkdirSync(path.join(output, ".ruff_cache"));
    fs.writeFileSync(path.join(output, ".ruff_cache", "CACHEDIR.TAG"), "tag");
    const secrets = mergedWith("merged-secrets", "feature/merged-secrets");
    fs.writeFileSync(path.join(secrets, ".env"), "LOCAL_ONLY=1\n");

    await check("Clean up removes a merged worktree that holds only test and lint output", async () => {
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-merged-output", mode: "manual" });
      assert.equal(result.status, "removed", result.message);
      assert.equal(fs.existsSync(output), false);
      assert.equal(branchExists(repo, "feature/merged-output"), false);
      assert.equal(has("ws-merged-output"), false);
    });

    await check("Clean up asks before deleting an ignored .env, and only the answer it asked for removes it", async () => {
      const asked = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-merged-secrets", mode: "manual" });
      assert.equal(asked.status, "confirm", asked.message);
      assert.deepEqual(asked.holds, [".env"]);
      assert.ok(asked.fingerprint);
      assert.equal(fs.existsSync(path.join(secrets, ".env")), true);

      const wrong = await rail.cleanUpRailWorkspace(deps, {
        workspaceId: "ws-merged-secrets",
        mode: "manual",
        confirmIgnored: "not-the-fingerprint",
      });
      assert.equal(wrong.status, "confirm");
      assert.match(wrong.message, /changed/);
      const auto = await rail.cleanUpRailWorkspace(deps, {
        workspaceId: "ws-merged-secrets",
        mode: "auto",
        confirmIgnored: asked.fingerprint,
      });
      assert.equal(auto.status, "refused", "the automatic cleanup never takes a confirmation");

      // A file that appeared after the question is not what was confirmed.
      fs.writeFileSync(path.join(secrets, ".env.extra"), "x\n");
      fs.writeFileSync(path.join(repo, ".git", "info", "exclude"), ".env.extra\n");
      const changed = await rail.cleanUpRailWorkspace(deps, {
        workspaceId: "ws-merged-secrets",
        mode: "manual",
        confirmIgnored: asked.fingerprint,
      });
      assert.equal(changed.status, "confirm");
      assert.deepEqual(changed.holds, [".env", ".env.extra"]);
      assert.equal(fs.existsSync(path.join(secrets, ".env")), true);

      const removed = await rail.cleanUpRailWorkspace(deps, {
        workspaceId: "ws-merged-secrets",
        mode: "manual",
        confirmIgnored: changed.fingerprint,
      });
      assert.equal(removed.status, "removed", removed.message);
      assert.equal(fs.existsSync(secrets), false);
      assert.equal(has("ws-merged-secrets"), false);
      fs.rmSync(path.join(repo, ".git", "info", "exclude"), { force: true });
    });

    await check("Clean up refuses a worktree whose ignored folders could not all be looked through", async () => {
      const big = mergedWith("merged-big", "feature/merged-big");
      fs.mkdirSync(path.join(big, "node_modules", "a", "b", "c", "d"), { recursive: true });
      deps.nestedScanMaxDirs = 2;
      try {
        const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-merged-big", mode: "manual" });
        assert.equal(result.status, "refused", "an unchecked folder is not offered as an ignored file to confirm");
        assert.match(result.message, /could not be fully checked: node_modules\//);
        assert.doesNotMatch(result.message, /Use Delete/, "the cleanup screen refuses it too, so the rail does not send the user there");
        assert.equal(result.fingerprint, undefined);
        // The cleanup screen and the agent tool remove through the same
        // check: ticking the item does not get past it.
        const [screen] = await remove.checkCleanupTargets(deps, [{ repoRoot: repo, path: big }]);
        assert.ok(screen.blockers.some((entry) => entry.code === "UNCHECKED"), JSON.stringify(screen.blockers));
        const { outcomes } = await remove.removeCleanupWorktrees(deps, {
          items: [{ repoRoot: repo, path: big, fingerprint: screen.fingerprint, confirmDirty: true, confirmUnmerged: true }],
          deleteMergedBranches: true,
        });
        assert.equal(outcomes[0].status, "refused");
        assert.equal(outcomes[0].code, "UNCHECKED");
        assert.equal(fs.existsSync(path.join(big, "node_modules", "a", "b", "c", "d")), true);
        assert.equal(has("ws-merged-big"), true);
      } finally {
        delete deps.nestedScanMaxDirs;
      }
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-merged-big", mode: "manual" });
      assert.equal(result.status, "removed", result.message);
    });

    await check("output folders go only at the root or a package root, and never take a .env with them", async () => {
      const nested = mergedWith("merged-nested", "feature/merged-nested");
      fs.mkdirSync(path.join(nested, "test-results"));
      fs.writeFileSync(path.join(nested, "test-results", ".env"), "LOCAL_ONLY=1\n");
      fs.mkdirSync(path.join(nested, "docs", "test-results"), { recursive: true });
      fs.writeFileSync(path.join(nested, "docs", "test-results", "notes.md"), "kept\n");
      fs.mkdirSync(path.join(nested, "packages", "web", "test-results"), { recursive: true });
      fs.writeFileSync(path.join(nested, "packages", "web", "package.json"), "{}\n");
      git(nested, ["add", "packages/web/package.json"]);
      git(nested, ["commit", "-q", "-m", "web package"]);
      mergeIntoMain("feature/merged-nested");
      fs.writeFileSync(path.join(nested, "packages", "web", "test-results", "trace.zip"), "trace");
      const asked = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-merged-nested", mode: "manual" });
      assert.equal(asked.status, "confirm", asked.message);
      // git also lists docs/ itself, as a folder that holds only ignored files.
      assert.deepEqual([...asked.holds].sort(), ["docs/", "docs/test-results/", "test-results/.env"]);
      assert.equal(fs.existsSync(path.join(nested, "test-results", ".env")), true);
      const removed = await rail.cleanUpRailWorkspace(deps, {
        workspaceId: "ws-merged-nested",
        mode: "manual",
        confirmIgnored: asked.fingerprint,
      });
      assert.equal(removed.status, "removed", removed.message);
    });

    await check("a confirmation covers every ignored file, not only the twenty it names", async () => {
      fs.writeFileSync(path.join(repo, ".git", "info", "exclude"), "*.local-data\nscratch/\n");
      const many = mergedWith("merged-many", "feature/merged-many");
      for (let i = 1; i <= 25; i += 1) fs.writeFileSync(path.join(many, `a${String(i).padStart(2, "0")}.local-data`), `${i}\n`);
      fs.mkdirSync(path.join(many, "scratch"));
      fs.writeFileSync(path.join(many, "scratch", "notes.txt"), "notes\n");
      const ask = (confirmIgnored) =>
        rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-merged-many", mode: "manual", ...(confirmIgnored ? { confirmIgnored } : {}) });
      let answer = await ask();
      assert.equal(answer.status, "confirm", answer.message);
      assert.equal(answer.holds.length, 20, "twenty are named");
      const stale = async (change, why) => {
        const before = answer.fingerprint;
        change();
        answer = await ask(before);
        assert.equal(answer.status, "confirm", `${why}: removed on the old yes`);
        assert.match(answer.message, /changed/, why);
        assert.notEqual(answer.fingerprint, before, why);
        assert.equal(fs.existsSync(many), true, why);
      };
      await stale(() => fs.writeFileSync(path.join(many, "a26.local-data"), "26\n"), "an entry past the twentieth");
      await stale(() => fs.writeFileSync(path.join(many, "scratch", "new-key"), "k\n"), "a file inside a named folder");
      await stale(() => fs.writeFileSync(path.join(many, "scratch", "notes.txt"), "notes, longer now\n"), "a file that changed inside a named folder");
      await stale(() => {
        fs.mkdirSync(path.join(many, "test-results"));
        fs.writeFileSync(path.join(many, "test-results", "id_ed25519"), "k\n");
      }, "a key inside an output folder");
      assert.equal(answer.holds[0], "test-results/id_ed25519", "secrets are named first");
      const removed = await ask(answer.fingerprint);
      assert.equal(removed.status, "removed", removed.message);
      fs.rmSync(path.join(repo, ".git", "info", "exclude"), { force: true });
    });

    await check("keys and .env files inside installed packages are the packages' own", async () => {
      const deps2 = mergedWith("merged-deps", "feature/merged-deps");
      fs.mkdirSync(path.join(deps2, "node_modules", "tls-lib", "test"), { recursive: true });
      fs.writeFileSync(path.join(deps2, "node_modules", "tls-lib", "test", "server.key"), "k\n");
      fs.writeFileSync(path.join(deps2, "node_modules", "tls-lib", ".env"), "x\n");
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-merged-deps", mode: "manual" });
      assert.equal(result.status, "removed", JSON.stringify(result));
    });

    // The agent that made a worktree, a coordinator chat in another
    // workspace, keeps its tab open long after its subagent finished.
    const coordinator = path.join(scratch, "coordinator");
    fs.mkdirSync(coordinator);
    h.state.workspaces.push({ id: "ws-coord", name: "AI Continous Improvment", cwd: coordinator, color: "#123456", workers: [] });
    const madeBy = (id) => {
      const workspace = h.state.workspaces.find((entry) => entry.id === id);
      workspace.copyBranch.createdBy = {
        kind: "agent",
        client: "claude-code",
        paneId: "pane-coord",
        fromWorkspaceId: "ws-coord",
        fromWorkspaceName: "AI Continous Improvment",
      };
    };
    const withTab = async (tab, fn) => {
      h.terminals.push({ paneId: "pane-coord", workspaceId: "ws-coord", ...tab });
      try {
        return await fn();
      } finally {
        h.terminals = h.terminals.filter((entry) => entry.paneId !== "pane-coord");
      }
    };

    await check("the maker's tab open in another workspace does not hold a merged, clean, idle worktree", async () => {
      const done = mergedWith("merged-made", "feature/merged-made");
      madeBy("ws-merged-made");
      const result = await withTab({ title: "coordinator", cwd: coordinator }, () =>
        rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-merged-made", mode: "manual" }),
      );
      assert.equal(result.status, "removed", result.message);
      assert.equal(fs.existsSync(done), false);
      assert.equal(branchExists(repo, "feature/merged-made"), false);
      assert.equal(has("ws-merged-made"), false);
    });

    await check("the maker's tab with its folder inside still holds it, and the refusal names the tab", async () => {
      const held = mergedWith("merged-held", "feature/merged-held");
      madeBy("ws-merged-held");
      const result = await withTab({ title: "usage agent", cwd: path.join(held, "src") }, () =>
        rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-merged-held", mode: "manual" }),
      );
      assert.equal(result.status, "refused");
      assert.equal(
        result.message,
        "The agent in the tab “usage agent” in AI Continous Improvment works in it. Close that tab first.",
      );
      assert.equal(fs.existsSync(held), true);
      const after = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-merged-held", mode: "manual" });
      assert.equal(after.status, "removed", after.message);
    });

    await check("the maker's shell moved in with cd, seen only by the process scan, is named as its tab", async () => {
      const cdIn = mergedWith("merged-cd", "feature/merged-cd");
      madeBy("ws-merged-cd");
      const scanned = {
        ...deps,
        sessionPid: (pane) => (pane === "pane-coord" ? 7777 : null),
        processesUnderCwds: async (dirs) =>
          new Map(dirs.map((dir) => [dir, dir === cdIn ? [{ pid: 7777, command: "zsh" }] : []])),
      };
      const result = await withTab({ title: "usage agent", cwd: coordinator }, () =>
        rail.cleanUpRailWorkspace(scanned, { workspaceId: "ws-merged-cd", mode: "manual" }),
      );
      assert.equal(result.status, "refused");
      assert.equal(
        result.message,
        "The agent in the tab “usage agent” in AI Continous Improvment works in it. Close that tab first.",
      );
      assert.equal(fs.existsSync(cdIn), true);
      const after = await withTab({ title: "usage agent", cwd: coordinator }, () =>
        rail.cleanUpRailWorkspace({ ...scanned, processesUnderCwds: async (dirs) => new Map(dirs.map((dir) => [dir, []])) }, {
          workspaceId: "ws-merged-cd",
          mode: "manual",
        }),
      );
      assert.equal(after.status, "removed", after.message);
    });

    await check("a tab named after its runtime is named by its session and group instead", async () => {
      const busy = mergedWith("merged-runtime-tab", "feature/merged-runtime-tab");
      madeBy("ws-merged-runtime-tab");
      const named = { ...deps, agentSessionName: async (pane) => (pane === "pane-coord" ? "Rail cleanup fixes" : null) };
      for (const title of ["Claude Code", "", "terminals 2"]) {
        const result = await withTab({ title, group: "Cleanup", cwd: busy }, () =>
          rail.cleanUpRailWorkspace(named, { workspaceId: "ws-merged-runtime-tab", mode: "manual" }),
        );
        assert.equal(result.status, "refused", title);
        assert.equal(
          result.message,
          "The agent in the Claude Code tab for “Rail cleanup fixes” in the group “Cleanup” in AI Continous Improvment works in it. Close that tab first.",
          title,
        );
      }
      // A session name it cannot read leaves the runtime, group and workspace.
      const unnamed = await withTab({ title: "Claude Code", cwd: busy }, () =>
        rail.cleanUpRailWorkspace({ ...deps, agentSessionName: async () => { throw new Error("unreadable"); } }, {
          workspaceId: "ws-merged-runtime-tab",
          mode: "manual",
        }),
      );
      assert.equal(unnamed.message, "The agent in the Claude Code tab in AI Continous Improvment works in it. Close that tab first.");
      const done = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-merged-runtime-tab", mode: "manual" });
      assert.equal(done.status, "removed", done.message);
    });

    await check("the maker's tab elsewhere does not stand in for what Clean up refuses itself", async () => {
      const open = mergedWith("merged-open", "feature/merged-open");
      madeBy("ws-merged-open");
      commitFile(open, "more.txt", "more\n", "work after the merge");
      const unmergedResult = await withTab({ title: "coordinator", cwd: coordinator }, () =>
        rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-merged-open", mode: "manual" }),
      );
      assert.equal(unmergedResult.status, "refused");
      assert.equal(unmergedResult.message, "Its branch is not merged yet.");
      git(open, ["reset", "-q", "--hard", "HEAD~1"]);
      fs.writeFileSync(path.join(open, "draft.txt"), "not committed\n");
      const live = { ...deps, sessionCwd: (pane) => (pane === "pane-coord" ? coordinator : null) };
      const dirtyResult = await rail.cleanUpRailWorkspace(live, { workspaceId: "ws-merged-open", mode: "manual" });
      assert.equal(dirtyResult.status, "refused");
      assert.match(dirtyResult.message, /^It has uncommitted work \(draft\.txt\)/);
      assert.equal(fs.existsSync(path.join(open, "draft.txt")), true);
      // The cleanup screen, where uncommitted work can be confirmed away,
      // still keeps it while the maker is open.
      const [screen] = await remove.checkCleanupTargets(live, [{ repoRoot: repo, path: open }]);
      assert.ok(screen.inUse?.some((use) => use.kind === "agent" && use.elsewhere), JSON.stringify(screen.inUse));
      fs.rmSync(path.join(open, "draft.txt"));
      const done = await rail.cleanUpRailWorkspace(live, { workspaceId: "ws-merged-open", mode: "manual" });
      assert.equal(done.status, "removed", done.message);
    });

    await check("ignored files alone do not make the maker's tab elsewhere a hold: they are asked about", async () => {
      // A coordinator's worktree with local data its tests wrote: the rail
      // offered Clean up, then refused it until the coordinator's tab closed.
      fs.writeFileSync(path.join(repo, ".git", "info", "exclude"), "data/\n");
      try {
        const kept = mergedWith("merged-kept", "feature/merged-kept");
        madeBy("ws-merged-kept");
        fs.mkdirSync(path.join(kept, "data", "ledger"), { recursive: true });
        fs.writeFileSync(path.join(kept, "data", "ledger", "entries.jsonl"), "{}\n");
        const live = { ...deps, sessionCwd: (pane) => (pane === "pane-coord" ? coordinator : null) };
        // The cleanup screen's check, which the rail's Clean up shares.
        const [screen] = await remove.checkCleanupTargets(live, [{ repoRoot: repo, path: kept }]);
        assert.deepEqual(screen.blockers, [], JSON.stringify(screen.blockers));
        assert.equal(screen.inUse, undefined);
        const asked = await withTab({ title: "coordinator", cwd: coordinator }, () =>
          rail.cleanUpRailWorkspace(live, { workspaceId: "ws-merged-kept", mode: "manual" }),
        );
        assert.equal(asked.status, "confirm", asked.message);
        assert.deepEqual(asked.holds, ["data/"]);
        const removed = await withTab({ title: "coordinator", cwd: coordinator }, () =>
          rail.cleanUpRailWorkspace(live, { workspaceId: "ws-merged-kept", mode: "manual", confirmIgnored: asked.fingerprint }),
        );
        assert.equal(removed.status, "removed", removed.message);
        assert.equal(fs.existsSync(kept), false);
        assert.equal(has("ws-merged-kept"), false);
      } finally {
        fs.rmSync(path.join(repo, ".git", "info", "exclude"), { force: true });
      }
    });

    await check("the maker's tab elsewhere holds a worktree it has not committed to yet, until it is stale", async () => {
      const fresh = add("fresh-made", "feature/fresh-made");
      // Made half a second after its base commit, in the same second: an
      // ancestor of main with nothing of its own.
      const based = Number(git(repo, ["log", "-1", "--format=%ct", "HEAD"])) * 1000;
      h.state.workspaces.push(
        copyWorkspace("ws-fresh-made", fresh, repo, "feature/fresh-made", { createdAt: new Date(based + 500).toISOString() }),
      );
      madeBy("ws-fresh-made");
      const result = await withTab({ title: "coordinator", cwd: coordinator }, () =>
        rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-fresh-made", mode: "manual" }),
      );
      assert.equal(result.status, "refused", result.message);
      assert.equal(
        result.message,
        "The agent in the tab “coordinator” in AI Continous Improvment made it and has not finished with it. Close that tab first if it is done.",
      );
      // No tab listed, only a live session: named by its agent and the
      // workspace it called from.
      const live = { ...deps, sessionCwd: (pane) => (pane === "pane-coord" ? coordinator : null) };
      const untitled = await rail.cleanUpRailWorkspace(live, { workspaceId: "ws-fresh-made", mode: "manual" });
      assert.equal(
        untitled.message,
        "The agent in the Claude Code tab in AI Continous Improvment made it and has not finished with it. Close that tab first if it is done.",
      );
      assert.equal(fs.existsSync(fresh), true);
      assert.equal(branchExists(repo, "feature/fresh-made"), true);
      // A week on with nothing done in it, the rail offers it as stale, and
      // its maker's tab, open all along, no longer holds it.
      const later = { ...live, now: () => new Date(Date.now() + 8 * 24 * 60 * 60_000) };
      const stale = await withTab({ title: "coordinator", cwd: coordinator }, () =>
        rail.cleanUpRailWorkspace(later, { workspaceId: "ws-fresh-made", mode: "manual" }),
      );
      assert.equal(stale.status, "removed", stale.message);
      assert.equal(fs.existsSync(fresh), false);
    });

    await check("work committed in the same second the worktree was made is its own", async () => {
      const quick = add("quick-commit", "feature/quick-commit");
      const tip = commitFile(quick, "quick.txt", "quick\n", "quick work");
      mergeIntoMain("feature/quick-commit");
      // Made late in the second its own commit was made in.
      const second = Number(git(repo, ["log", "-1", "--format=%ct", tip])) * 1000;
      h.state.workspaces.push(
        copyWorkspace("ws-quick-commit", quick, repo, "feature/quick-commit", { createdAt: new Date(second + 900).toISOString() }),
      );
      madeBy("ws-quick-commit");
      const result = await withTab({ title: "coordinator", cwd: coordinator }, () =>
        rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-quick-commit", mode: "manual" }),
      );
      assert.equal(result.status, "removed", result.message);
      assert.equal(fs.existsSync(quick), false);
    });

    await check("a folder removed by hand leaves the rail on its own while the maker's tab is open", async () => {
      // git worktree remove + branch -D, as an agent or the user does by hand.
      const byHand = mergedWith("by-hand", "feature/by-hand");
      madeBy("ws-by-hand");
      git(repo, ["worktree", "remove", byHand]);
      git(repo, ["branch", "-D", "feature/by-hand"]);
      // Only the folder deleted: git still lists it.
      const rmOnly = mergedWith("rm-only", "feature/rm-only");
      madeBy("ws-rm-only");
      fs.rmSync(rmOnly, { recursive: true, force: true });
      // Only the folder deleted, with no commit of its own: nothing is lost.
      const rmEmpty = add("rm-empty", "feature/rm-empty");
      h.state.workspaces.push(
        copyWorkspace("ws-rm-empty", rmEmpty, repo, "feature/rm-empty", { createdAt: new Date(Date.now() + 5_000).toISOString() }),
      );
      madeBy("ws-rm-empty");
      fs.rmSync(rmEmpty, { recursive: true, force: true });
      // Branch kept and merged.
      const kept = mergedWith("kept-branch", "feature/kept-branch");
      madeBy("ws-kept-branch");
      git(repo, ["worktree", "remove", kept]);
      // Branch kept with commits not merged: it stays.
      const unfinished = add("unfinished", "feature/unfinished");
      commitFile(unfinished, "u2.txt", "u2\n", "unfinished work");
      h.state.workspaces.push(copyWorkspace("ws-unfinished", unfinished, repo, "feature/unfinished"));
      madeBy("ws-unfinished");
      git(repo, ["worktree", "remove", unfinished]);
      await withTab({ title: "coordinator", cwd: coordinator }, async () => {
        const rows = Object.fromEntries((await rail.railWorktreeStates(deps)).map((entry) => [entry.workspaceId, entry]));
        for (const id of ["ws-by-hand", "ws-rm-only", "ws-rm-empty", "ws-kept-branch"]) {
          assert.equal(rows[id].autoCandidate, true, id);
          const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: id, mode: "auto" });
          assert.equal(result.status, "removed", `${id}: ${result.message}`);
          assert.equal(has(id), false, id);
        }
        assert.equal(rows["ws-unfinished"].autoCandidate, false);
        const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-unfinished", mode: "auto" });
        assert.equal(result.status, "refused");
        assert.equal(has("ws-unfinished"), true);
        assert.equal(branchExists(repo, "feature/unfinished"), true);
      });
      assert.equal(registered(repo, rmOnly), false);
      assert.equal(branchExists(repo, "feature/kept-branch"), false);
    });

    await check("a branch git could not read never drops the row", async () => {
      if (process.platform === "win32") return; // The failing git is a shell script.
      const gone = mergedWith("git-away-row", "feature/git-away-row");
      git(repo, ["worktree", "remove", gone]);
      git(repo, ["branch", "-D", "feature/git-away-row"]);
      // Folder gone, still registered.
      const stillListed = mergedWith("git-away-reg", "feature/git-away-reg");
      fs.rmSync(stillListed, { recursive: true, force: true });
      // git fails to answer for this branch (a lock, a timeout): a git on
      // PATH that exits 128 for that one read.
      const bin = path.join(scratch, "failing-git");
      fs.mkdirSync(bin, { recursive: true });
      const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
      fs.writeFileSync(
        path.join(bin, "git"),
        `#!/bin/sh\ncase "$*" in *refs/heads/feature/git-away-*) echo "fatal: unable to read" >&2; exit 128;; esac\nexec ${realGit} "$@"\n`,
        { mode: 0o755 },
      );
      const pathBefore = process.env.PATH;
      process.env.PATH = `${bin}${path.delimiter}${pathBefore}`;
      try {
        const rows = Object.fromEntries((await rail.railWorktreeStates(deps)).map((entry) => [entry.workspaceId, entry]));
        for (const id of ["ws-git-away-row", "ws-git-away-reg"]) {
          assert.equal(rows[id].autoCandidate, false, `${id}: not offered on a failed read`);
          const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: id, mode: "auto" });
          assert.equal(result.status, "refused", `${id}: ${JSON.stringify(result)}`);
          assert.match(result.message, /could not read the branch/, id);
          assert.equal(has(id), true, id);
        }
        assert.equal(registered(repo, stillListed), true);
      } finally {
        process.env.PATH = pathBefore;
      }
      for (const id of ["ws-git-away-row", "ws-git-away-reg"]) {
        const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: id, mode: "auto" });
        assert.equal(result.status, "removed", `${id}: ${result.message}`);
      }
    });

    await check("a branch whose commit is missing is not a gone branch", async () => {
      const dir = mergedWith("bad-ref", "feature/bad-ref");
      git(repo, ["worktree", "remove", dir]);
      git(repo, ["branch", "-D", "feature/bad-ref"]);
      // A ref left pointing at a commit git does not have.
      const refFile = path.join(repo, ".git", "refs", "heads", "feature", "bad-ref");
      fs.mkdirSync(path.dirname(refFile), { recursive: true });
      fs.writeFileSync(refFile, `${"1".repeat(40)}\n`);
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-bad-ref", mode: "auto" });
      assert.equal(result.status, "refused", JSON.stringify(result));
      assert.match(result.message, /could not read the commit of the branch/);
      assert.equal(has("ws-bad-ref"), true);
      // A symbolic ref that leads nowhere.
      fs.rmSync(refFile);
      git(repo, ["symbolic-ref", "refs/heads/feature/bad-ref", "refs/heads/feature/nowhere"]);
      const dangling = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-bad-ref", mode: "auto" });
      assert.equal(dangling.status, "refused", JSON.stringify(dangling));
      assert.equal(has("ws-bad-ref"), true);
      fs.rmSync(refFile);
      const after = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-bad-ref", mode: "auto" });
      assert.equal(after.status, "removed", after.message);
    });

    await check("the maker's tab opening elsewhere during a removal of unfinished work puts it back", async () => {
      const open = add("late-maker", "feature/late-maker");
      commitFile(open, "late.txt", "late\n", "unmerged work");
      h.state.workspaces.push(copyWorkspace("ws-late-maker", open, repo, "feature/late-maker"));
      madeBy("ws-late-maker");
      // Checked with no maker tab, then removed with the unmerged commits confirmed.
      const [checked] = await remove.checkCleanupTargets(deps, [{ repoRoot: repo, path: open }]);
      assert.deepEqual(checked.blockers, []);
      assert.ok(checked.unmerged);
      try {
        const { outcomes } = await remove.removeCleanupWorktrees(
          deps,
          {
            items: [{ repoRoot: repo, path: open, fingerprint: checked.fingerprint, confirmDirty: false, confirmUnmerged: true }],
            deleteMergedBranches: true,
          },
          {
            beforeRemove: async () => {
              if (!h.terminals.some((entry) => entry.paneId === "pane-coord")) {
                h.terminals.push({ paneId: "pane-coord", workspaceId: "ws-coord", title: "coordinator", cwd: coordinator });
              }
              return null;
            },
          },
        );
        assert.equal(outcomes[0].status, "refused", JSON.stringify(outcomes[0]));
        assert.match(outcomes[0].message, /coordinator/);
      } finally {
        h.terminals = h.terminals.filter((entry) => entry.paneId !== "pane-coord");
      }
      assert.equal(fs.existsSync(path.join(open, "late.txt")), true);
      assert.equal(branchExists(repo, "feature/late-maker"), true);
    });

    await check("a rail removal is bound to its row: a second row at the folder stops it", async () => {
      const shared = mergedWith("two-rows", "feature/two-rows");
      // A new worktree's row made in the folder of one removed outside Studio.
      h.state.workspaces.push(copyWorkspace("ws-two-rows-new", shared, repo, "feature/two-rows"));
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-two-rows", mode: "manual" });
      assert.equal(result.status, "refused", JSON.stringify(result));
      assert.match(result.message, /Another workspace row uses this folder/);
      assert.equal(fs.existsSync(shared), true);
      assert.equal(has("ws-two-rows-new"), true);
      h.state.workspaces = h.state.workspaces.filter((workspace) => workspace.id !== "ws-two-rows-new");
      const alone = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-two-rows", mode: "manual" });
      assert.equal(alone.status, "removed", alone.message);
    });

    await check("a missing folder whose row spells it through a linked parent is still its row's", async () => {
      if (process.platform === "win32") return; // Links need privileges there.
      const dir = mergedWith("via-link", "feature/via-link");
      const alias = path.join(scratch, "trees-alias");
      fs.symlinkSync(trees, alias);
      const row = h.state.workspaces.find((workspace) => workspace.id === "ws-via-link");
      row.cwd = path.join(alias, "via-link");
      fs.rmSync(dir, { recursive: true, force: true });
      try {
        const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-via-link", mode: "auto" });
        assert.equal(result.status, "removed", JSON.stringify(result));
        assert.equal(registered(repo, dir), false);
        assert.equal(has("ws-via-link"), false);
      } finally {
        fs.rmSync(alias);
      }
    });

    await check("a missing folder whose row is a link to it is still its row's", async () => {
      if (process.platform === "win32") return; // Links need privileges there.
      const dir = mergedWith("own-link", "feature/own-link");
      const link = path.join(scratch, "own-link-alias");
      fs.symlinkSync(dir, link);
      const row = h.state.workspaces.find((workspace) => workspace.id === "ws-own-link");
      row.cwd = link;
      fs.rmSync(dir, { recursive: true, force: true });
      try {
        // The link itself is still there, so only Clean up removes it.
        const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-own-link", mode: "manual" });
        assert.equal(result.status, "removed", JSON.stringify(result));
        assert.equal(registered(repo, dir), false);
        assert.equal(has("ws-own-link"), false);
      } finally {
        fs.rmSync(link, { force: true });
      }
    });

    await check("a missing folder a second row names in other case is not removed for one of them", async () => {
      const dir = mergedWith("cased-rows", "feature/cased-rows");
      h.state.workspaces.push(
        copyWorkspace("ws-cased-rows-other", path.join(path.dirname(dir), "Cased-Rows"), repo, "feature/cased-rows"),
      );
      fs.rmSync(dir, { recursive: true, force: true });
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-cased-rows", mode: "manual" });
      assert.equal(result.status, "refused", JSON.stringify(result));
      assert.match(result.message, /Another workspace row uses this folder/);
      assert.equal(has("ws-cased-rows"), true);
      h.state.workspaces = h.state.workspaces.filter((workspace) => workspace.id !== "ws-cased-rows-other");
      const alone = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-cased-rows", mode: "manual" });
      assert.equal(alone.status, "removed", alone.message);
    });

    await check("a worktree removed with plain git is not cleaned up for one of two rows that name it", async () => {
      const dir = mergedWith("plain-two", "feature/plain-two");
      h.state.workspaces.push(copyWorkspace("ws-plain-two-other", dir, repo, "feature/plain-two"));
      git(repo, ["worktree", "remove", dir]);
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-plain-two", mode: "manual" });
      assert.equal(result.status, "refused", JSON.stringify(result));
      assert.match(result.message, /Another workspace row uses this folder/);
      assert.equal(branchExists(repo, "feature/plain-two"), true);
      assert.equal(has("ws-plain-two"), true);
      h.state.workspaces = h.state.workspaces.filter((workspace) => workspace.id !== "ws-plain-two-other");
      const alone = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-plain-two", mode: "manual" });
      assert.equal(alone.status, "removed", alone.message);
    });

    await check("a row naming the folder in other case, made while the removal waited, stops it", async () => {
      const dir = mergedWith("late-case", "feature/late-case");
      fs.rmSync(dir, { recursive: true, force: true });
      const other = copyWorkspace("ws-late-case-other", path.join(path.dirname(dir), "Late-Case"), repo, "feature/late-case");
      let added = false;
      const late = {
        ...deps,
        async loadState() {
          const state = await deps.loadState();
          // Not there when the rail and the removal first look; there when the
          // rows are read again under the lock.
          if (/refreshRows/.test(new Error().stack ?? "")) {
            state.workspaces.push(structuredClone(other));
            added = true;
          }
          return state;
        },
      };
      const result = await rail.cleanUpRailWorkspace(late, { workspaceId: "ws-late-case", mode: "manual" });
      assert.equal(added, true, "the row was added while the removal held the lock");
      assert.equal(result.status, "refused", JSON.stringify(result));
      assert.match(result.message, /Another workspace row uses this folder/);
      assert.equal(has("ws-late-case"), true);
      const alone = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-late-case", mode: "manual" });
      assert.equal(alone.status, "removed", alone.message);
    });

    await check("a stale row naming a folder that is there in other case stops its removal", async () => {
      const dir = mergedWith("live-case", "feature/live-case");
      h.state.workspaces.push(
        copyWorkspace("ws-live-case-other", path.join(path.dirname(dir), "Live-Case"), repo, "feature/live-case"),
      );
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-live-case", mode: "manual" });
      assert.equal(result.status, "refused", JSON.stringify(result));
      assert.match(result.message, /Another workspace row uses this folder/);
      assert.equal(fs.existsSync(dir), true);
      h.state.workspaces = h.state.workspaces.filter((workspace) => workspace.id !== "ws-live-case-other");
      const alone = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-live-case", mode: "manual" });
      assert.equal(alone.status, "removed", alone.message);
    });

    await check("no rail action touched another worktree or the main checkout", async () => {
      assert.equal(fs.readFileSync(path.join(bystander, "keep.txt"), "utf8"), "keep\n");
      assert.equal(registered(repo, bystander), true);
      assert.equal(fs.existsSync(path.join(mergedDirty, "notes.txt")), true);
      assert.equal(fs.existsSync(unmerged), true);
      assert.equal(fs.existsSync(path.join(repo, "README.md")), true);
      assert.equal(has("ws-repo"), true);
      assert.ok(h.published > 0);
      const audit = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(audit.some((entry) => entry.caller.client === "workspace-rail-auto" && entry.outcome === "removed"));
      assert.ok(audit.some((entry) => entry.caller.client === "workspace-rail" && entry.outcome === "removed"));
    });

    await check("a workspace that is not a local worktree is refused", async () => {
      const result = await rail.cleanUpRailWorkspace(deps, { workspaceId: "ws-repo", mode: "manual" });
      assert.equal(result.status, "refused");
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
