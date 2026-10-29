#!/usr/bin/env node
"use strict";

// Unit tests for codara_workspace_status with `worktree`
// (src/main/workspace-status/worktree-notes.ts and agent-notes.ts): which
// worktrees a caller may write a note on, where the note goes (the
// worktree's own row, or its project for one made outside Codara), and that
// the note keeps where it came from. Runs against real repositories.
//
//   node scripts/test-worktree-notes.cjs

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function bundle(entry, name, dir) {
  const outfile = path.join(dir, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
  });
  return require(outfile);
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function repoWithCommit(dir) {
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  fs.writeFileSync(path.join(dir, "README.md"), "# repo\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "init"]);
}

// The listing the app passes in (worktree-cleanup/inspect.ts listWorktrees).
function worktreesOf(cwd) {
  const out = git(cwd, ["worktree", "list", "--porcelain"]);
  const paths = out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  return { main: paths[0], linked: paths.slice(1) };
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

async function main() {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-worktree-notes-")));
  const gitConfig = path.join(scratch, "gitconfig");
  fs.writeFileSync(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    const { resolveWorktreeNoteTarget, externalWorktreeNoteKey } = await bundle(
      "src/main/workspace-status/worktree-notes.ts",
      "worktree-notes",
      scratch,
    );
    const { createAgentNoteBook } = await bundle("src/main/workspace-status/agent-notes.ts", "agent-notes", scratch);

    const cloud = path.join(scratch, "cloud");
    const ai = path.join(scratch, "ai");
    repoWithCommit(cloud);
    repoWithCommit(ai);
    const trees = path.join(scratch, "trees");
    fs.mkdirSync(trees);
    const made = path.join(trees, "cloud-made");
    const plain = path.join(trees, "cloud-plain");
    const someoneElse = path.join(trees, "cloud-other-agent");
    const aiPlain = path.join(trees, "ai-plain");
    git(cloud, ["worktree", "add", "-q", made, "-b", "agent/fix"]);
    git(cloud, ["worktree", "add", "-q", plain, "-b", "feat/plain"]);
    git(cloud, ["worktree", "add", "-q", someoneElse, "-b", "agent/other"]);
    git(ai, ["worktree", "add", "-q", aiPlain, "-b", "feat/ai-plain"]);

    const copy = (id, cwd, repoCwd, createdBy) => ({
      id,
      name: id,
      cwd,
      color: "#000",
      workers: [],
      copyBranch: { repoCwd, branch: id, city: id, createdAt: "2026-10-29T10:00:00Z", ...(createdBy ? { createdBy } : {}) },
    });
    const workspaces = [
      { id: "ws-ai", name: "AI Continous Improvment", cwd: ai, color: "#000", workers: [] },
      { id: "ws-cloud", name: "Cloud platform", cwd: cloud, color: "#000", workers: [] },
      copy("wt-made", made, cloud, { kind: "agent", paneId: "p-coord", fromWorkspaceId: "ws-ai" }),
      copy("wt-other", someoneElse, cloud, { kind: "agent", paneId: "p-someone" }),
    ];
    const deps = { workspaces, realpath: (value) => fs.promises.realpath(value), worktreesOf: async (cwd) => worktreesOf(cwd) };
    const coordinator = { workspaceId: "ws-ai", agentKey: "pane:p-coord" };
    const cloudAgent = { workspaceId: "ws-cloud", agentKey: "pane:p-cloud" };

    await check("a worktree the caller made in another workspace's repository takes its note on its own row", async () => {
      const target = await resolveWorktreeNoteTarget(made, coordinator, deps);
      assert.deepEqual(target, { key: "worktree:wt-made", workspaceId: "wt-made", path: made, worktreeWorkspaceId: "wt-made" });
      // A run that made it (a Cora chat) is the same caller.
      const runMade = copy("wt-run", made, cloud, { kind: "agent", runId: "r1" });
      const viaRun = await resolveWorktreeNoteTarget(made, { workspaceId: "ws-ai", agentKey: "run:r1" }, { ...deps, workspaces: [workspaces[0], workspaces[1], runMade] });
      assert.equal(viaRun.key, "worktree:wt-run");
    });

    await check("another repository's worktree the caller did not make is refused, with the way to do it", async () => {
      for (const target of [someoneElse, plain]) {
        const refused = await resolveWorktreeNoteTarget(target, coordinator, deps);
        assert.equal(refused.refusal?.reason, "worktree_not_yours", target);
        assert.match(refused.refusal.hint, /codara_worktree_create/);
      }
    });

    await check("any worktree of the caller's own repository is allowed, the ones made outside Codara too", async () => {
      const rail = await resolveWorktreeNoteTarget(someoneElse, cloudAgent, deps);
      assert.equal(rail.key, "worktree:wt-other", "a rail worktree of its own repository");
      const external = await resolveWorktreeNoteTarget(`${plain}/`, cloudAgent, deps);
      assert.deepEqual(external, {
        key: externalWorktreeNoteKey(plain),
        workspaceId: "ws-cloud",
        path: plain,
        worktreeWorkspaceId: null,
      });
      assert.match(external.key, /^worktree:path:[0-9a-f]{24}$/);
      // From the AI repository, its own plain worktree hangs under its project.
      const own = await resolveWorktreeNoteTarget(aiPlain, coordinator, deps);
      assert.equal(own.workspaceId, "ws-ai");
    });

    await check("the main checkout, a missing folder, a relative or SSH path and an unplaced caller are refused", async () => {
      assert.equal((await resolveWorktreeNoteTarget(cloud, cloudAgent, deps)).refusal?.reason, "worktree_is_main");
      assert.equal((await resolveWorktreeNoteTarget(path.join(trees, "nope"), cloudAgent, deps)).refusal?.reason, "worktree_not_found");
      assert.equal((await resolveWorktreeNoteTarget("trees/cloud-plain", cloudAgent, deps)).refusal?.reason, "worktree_invalid");
      assert.equal((await resolveWorktreeNoteTarget("ssh://host/x", cloudAgent, deps)).refusal?.reason, "worktree_invalid");
      assert.equal((await resolveWorktreeNoteTarget(plain, { workspaceId: "ws-gone", agentKey: null }, deps)).refusal?.reason, "workspace_unknown");
      // Without a pane Codara cannot tell who made a worktree.
      assert.equal((await resolveWorktreeNoteTarget(made, { workspaceId: "ws-ai", agentKey: null }, deps)).refusal?.reason, "worktree_not_yours");
    });

    await check("a worktree note keeps its folder and who wrote it, and goes with its workspace", async () => {
      const book = createAgentNoteBook({ now: () => 1_000 });
      const by = { kind: "agent", label: "Claude Code" };
      const first = book.update("worktree:wt-made", "wt-made", { note: "Tests pass" }, by, {
        worktreePath: made,
        from: { workspaceId: "ws-ai", workspaceName: "AI Continous Improvment" },
      });
      assert.equal(first.changed, true);
      assert.equal(first.note.worktreePath, made);
      assert.deepEqual(first.note.from, { workspaceId: "ws-ai", workspaceName: "AI Continous Improvment" });
      const again = book.update("worktree:wt-made", "wt-made", { note: "Tests pass" }, by);
      assert.equal(again.changed, false, "the same note twice is no change");
      assert.equal(again.note.worktreePath, made, "and keeps where it came from");
      book.update("worktree:path:abc", "ws-cloud", { note: "External" }, by, { worktreePath: plain });
      book.pruneWorkspaces(new Set(["ws-cloud", "ws-ai"]));
      assert.equal(book.get("worktree:wt-made"), null, "a removed worktree takes its note along");
      assert.equal(book.get("worktree:path:abc").entry.note, "External");
    });
    await check("an external worktree's note moves to the row it is opened as, status and history kept", async () => {
      const book = createAgentNoteBook({ now: () => 2_000 });
      const by = { kind: "agent", label: "Claude Code" };
      const key = externalWorktreeNoteKey(plain);
      book.update(key, "ws-cloud", { status: "blocked", note: "Need the key" }, by, { worktreePath: plain });
      assert.equal(book.move(key, "worktree:wt-plain", "wt-plain"), true);
      assert.equal(book.get(key), null);
      const moved = book.get("worktree:wt-plain");
      assert.equal(moved.workspaceId, "wt-plain");
      assert.equal(moved.entry.status, "blocked");
      assert.equal(moved.entry.note, "Need the key");
      assert.equal(moved.worktreePath, plain);
      // A note already on the row wins; the folder's one goes.
      book.update(key, "ws-cloud", { note: "Older" }, by, { worktreePath: plain });
      assert.equal(book.move(key, "worktree:wt-plain", "wt-plain"), false);
      assert.equal(book.get("worktree:wt-plain").entry.note, "Need the key");
      assert.equal(book.get(key), null);
    });

    await check("folders that differ only in case are different worktrees", async () => {
      assert.notEqual(externalWorktreeNoteKey("/trees/fix"), externalWorktreeNoteKey("/trees/FIX"));
      // On a case-sensitive disk a rail worktree spelled like the caller's in
      // another case is not matched to it.
      const upper = copy("wt-upper", made.toUpperCase(), cloud, { kind: "agent", paneId: "p-someone" });
      const own = copy("wt-own", made, cloud, { kind: "agent", paneId: "p-coord", fromWorkspaceId: "ws-ai" });
      const target = await resolveWorktreeNoteTarget(made, coordinator, {
        ...deps,
        workspaces: [workspaces[0], workspaces[1], upper, own],
        realpath: async (value) => value,
      });
      assert.equal(target.key, "worktree:wt-own");
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
