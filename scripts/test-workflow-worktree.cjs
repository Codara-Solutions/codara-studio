// Guards worktree isolation for workflow agents
// (src/main/orchestration/workflow-worktree.ts) against throwaway git
// repositories: an unchanged agent leaves nothing behind, a changed one
// leaves exactly one commit on its branch and no checkout, parallel creation
// does not race git, a branch an earlier agent committed to is never reset,
// a non-git workspace refuses isolation, run cleanup
// deletes only merged branches, and checkouts an app restart left behind are
// removed with their edits kept on their branches.
//
//   node scripts/test-workflow-worktree.cjs

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { bundleModule, check, finish, tempDir } = require("./workflow-test-harness.cjs");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

function makeRepo(name) {
  const repo = path.join(tempDir(), name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

async function main() {
  // Keep the suite's git away from the user's global config.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const wt = await bundleModule("workflow-worktree.ts", { external: ["electron", "ssh2", "cpu-features"] });
  const repo = makeRepo("repo");
  const root = path.join(tempDir(), "wt-root");
  const runId = "run-abcdef123456";
  const base = await wt.workflowBaseCommit(repo);
  check("the base is the workspace HEAD", base === git(repo, "rev-parse", "HEAD"));

  {
    const created = await wt.createWorkflowWorktree({ repoCwd: repo, root, runId, label: "Read only: look", seq: 0, base });
    check("the branch is named after run, label and seq", created.branch === "codara/wf/abcdef12/read-only-look-0", created.branch);
    check("the checkout exists", fs.existsSync(path.join(created.path, "a.txt")));
    const done = await wt.finishWorkflowWorktree(created, "workflow test: look");
    check("an unchanged agent reports no change", done.changed === false, done);
    check("an unchanged agent's checkout is removed", !fs.existsSync(created.path));
    check("an unchanged agent's branch is deleted", git(repo, "branch", "--list", created.branch) === "");
  }
  {
    const created = await wt.createWorkflowWorktree({ repoCwd: repo, root, runId, label: "fix", seq: 1, base });
    fs.writeFileSync(path.join(created.path, "a.txt"), "two\n");
    fs.writeFileSync(path.join(created.path, "b.txt"), "new\n");
    const done = await wt.finishWorkflowWorktree(created, "workflow test: fix");
    check("a changed agent reports its commit", done.changed === true && /^[0-9a-f]{40}$/.test(done.commit), done);
    check("the change count is right", done.filesChanged === 2, done);
    check("the checkout is removed after commit", !fs.existsSync(created.path));
    check("the branch keeps exactly one commit on the base", git(repo, "rev-list", "--count", `${base}..${created.branch}`) === "1");
    check("the user's working tree is untouched", fs.readFileSync(path.join(repo, "a.txt"), "utf8") === "one\n");
  }
  {
    const created = await Promise.all(
      [2, 3, 4, 5, 6].map((seq) => wt.createWorkflowWorktree({ repoCwd: repo, root, runId, label: "par", seq, base })),
    );
    check("parallel creation gives every agent its checkout", created.every((c) => fs.existsSync(c.path)));
    await Promise.all(created.map((c) => wt.finishWorkflowWorktree(c, "par")));
    check("parallel finish removes every checkout", created.every((c) => !fs.existsSync(c.path)));
  }
  {
    // A resume renumbers calls from 0, so an edited script can reach a
    // label and seq whose branch an earlier agent already committed to.
    const reused = await wt.createWorkflowWorktree({ repoCwd: repo, root, runId, label: "fix", seq: 1, base });
    const earlier = git(repo, "rev-parse", "codara/wf/abcdef12/fix-1");
    check("a branch with an earlier agent's commits is not reset", earlier !== base && reused.branch !== "codara/wf/abcdef12/fix-1", reused.branch);
    check("the new agent takes the next free name", reused.branch === "codara/wf/abcdef12/fix-1-2", reused.branch);
    check("the earlier agent's commit is still on its branch", git(repo, "show", "codara/wf/abcdef12/fix-1:b.txt") === "new");
    await wt.finishWorkflowWorktree(reused, "workflow test: reused");
    const again = await wt.createWorkflowWorktree({ repoCwd: repo, root, runId, label: "read only: look", seq: 0, base });
    check("a free name is used as is", again.branch === "codara/wf/abcdef12/read-only-look-0", again.branch);
    await wt.finishWorkflowWorktree(again, "workflow test: look again");
  }
  {
    const plain = path.join(tempDir(), "plain");
    fs.mkdirSync(plain, { recursive: true });
    let error = "";
    try {
      await wt.workflowBaseCommit(plain);
    } catch (err) {
      error = err.message;
    }
    check("a non-git workspace refuses isolation with a clear error", /needs a git repository/.test(error), error);
  }
  {
    // One merged branch, one not.
    const merged = await wt.createWorkflowWorktree({ repoCwd: repo, root, runId, label: "merged", seq: 7, base });
    fs.writeFileSync(path.join(merged.path, "c.txt"), "c\n");
    const mergedDone = await wt.finishWorkflowWorktree(merged, "merged");
    git(repo, "merge", "-q", "--ff-only", mergedDone.branch);
    const cleaned = await wt.cleanupWorkflowBranches(repo, runId);
    check("cleanup deletes merged branches", cleaned.deleted.includes(mergedDone.branch), cleaned);
    check("cleanup keeps unmerged branches", cleaned.kept.includes("codara/wf/abcdef12/fix-1"), cleaned);
    check("the unmerged branch still exists", git(repo, "branch", "--list", "codara/wf/abcdef12/fix-1") !== "");
  }
  {
    // An app restart cut two isolated agents off: their checkouts were never
    // finished. Cancel or Delete must not leave them registered in the repo.
    const edited = await wt.createWorkflowWorktree({ repoCwd: repo, root, runId, label: "cut off", seq: 8, base });
    const clean = await wt.createWorkflowWorktree({ repoCwd: repo, root, runId, label: "idle", seq: 9, base });
    fs.writeFileSync(path.join(edited.path, "d.txt"), "half done\n");
    const elsewhere = path.join(tempDir(), "user-worktree");
    git(repo, "worktree", "add", "-q", "-b", "user-branch", elsewhere, base);
    const removed = await wt.removeWorkflowWorktrees(repo, root, "workflow test: interrupted agent");
    check("leftover checkouts are removed", removed.length === 2 && !fs.existsSync(edited.path) && !fs.existsSync(clean.path), removed);
    const listed = git(repo, "worktree", "list", "--porcelain");
    check("git no longer lists the leftovers", !listed.includes(edited.path) && !listed.includes(clean.path), listed);
    check("a worktree outside the run's folder is left alone", listed.includes(elsewhere) && fs.existsSync(elsewhere), listed);
    check(
      "an interrupted agent's edits are kept on its branch",
      git(repo, "show", `${edited.branch}:d.txt`) === "half done",
    );
  }
}

main()
  .catch((err) => {
    check("suite crashed", false, err && err.stack ? err.stack : String(err));
  })
  .finally(finish);
