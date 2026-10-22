#!/usr/bin/env node
"use strict";

// codara_terminal_create can open a terminal in another workspace of the rail
// (`workspace`), for example a coordinator dispatching a worker pane under the
// worktree it works on.
//
// Proven here:
//   1. `workspace` resolves by id, by a workspace's folder, by a worktree's
//      folder (its own workspace, also when nested in its repository), and by
//      a subfolder (which becomes the default cwd); symlinks are followed.
//      Unknown ids, relative paths, folders outside every workspace and SSH
//      paths are refused; no workspace is ever created.
//   2. Only the user's own authority may target another workspace: a pane or
//      scoped credential, an imported pull-request run, an agent the user
//      started by hand in an imported pull-request workspace (or in a folder
//      inside one), an unknown caller workspace and SSH workspaces on either
//      side are refused.
//   3. "Always" grants persist per caller and target pair in a mode-600 file,
//      survive a new store, read a broken file as none, and revoke.
//   4. The approver asks only across workspaces and only without a grant,
//      remembers "always" and not "once", refuses silence, refuses a denied
//      pair without asking again for a while, shares one prompt only between
//      concurrent calls of one requester, and still allows when saving the
//      grant fails. A cross-workspace cwd must be a local folder inside the
//      target.
//   5. A terminal opened across workspaces by a run-less agent is written to,
//      run in and closed only from the pane that opened it; run-owned and
//      ordinary terminals keep their old rules, and a dev-server handoff or
//      the opening pane closing drops the pane owner. A pane that is asleep
//      (hibernated) or respawning has no process but is still in the layout,
//      so it keeps its terminals; so does a pane whose layout cannot be read.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codara-cross-workspace-"));
process.on("exit", () => fs.rmSync(OUT_DIR, { recursive: true, force: true }));

async function bundle(entry, name) {
  const outfile = path.join(OUT_DIR, `${name}.cjs`);
  await build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
  });
  return require(outfile);
}

function mkdir(...parts) {
  const dir = path.join(OUT_DIR, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function memoryStore() {
  const grants = [];
  return {
    grants,
    failGrant: false,
    async list() {
      return [...grants];
    },
    async has(caller, target) {
      return grants.some((g) => g.callerWorkspaceId === caller && g.targetWorkspaceId === target);
    },
    async grant(entry) {
      if (this.failGrant) throw new Error("disk full");
      grants.push({ ...entry, grantedAt: "now" });
    },
    async revoke() {
      return false;
    },
  };
}

async function main() {
  const cross = await bundle("src/main/cross-workspace-terminals.ts", "cross");
  const { AgentTerminalRegistry, AgentTerminalOwnershipError } = await bundle(
    "src/main/agent-terminal-registry.ts",
    "registry",
  );

  // ── 1. Resolution ──────────────────────────────────────────────────────
  const repo = mkdir("repo");
  const nested = mkdir("repo", ".worktrees", "feature");
  const managed = mkdir("home", ".codarastudio", "worktrees", "repo-abc", "fix");
  const sub = mkdir("repo", "packages", "app");
  const outside = mkdir("elsewhere");
  const link = path.join(OUT_DIR, "repo-link");
  fs.symlinkSync(repo, link);
  const workspaces = [
    { id: "ws-repo", name: "Repo", cwd: repo },
    { id: "ws-nested", name: "Feature", cwd: nested },
    { id: "ws-managed", name: "Fix", cwd: managed },
    { id: "ws-ssh", name: "Server", cwd: "ssh://box/home/me/app", remote: { hostId: "box" } },
  ];
  const resolve = (raw) => cross.resolveTargetWorkspace(workspaces, raw);

  let r = await resolve("ws-managed");
  assert.equal(r.ok, true);
  assert.equal(r.workspace.id, "ws-managed");
  assert.equal(r.folder, undefined);
  r = await resolve(repo);
  assert.equal(r.workspace.id, "ws-repo");
  assert.equal(r.folder, undefined);
  r = await resolve(`${repo}/`);
  assert.equal(r.workspace.id, "ws-repo", "a trailing slash names the same folder");
  r = await resolve(managed);
  assert.equal(r.workspace.id, "ws-managed", "a worktree folder resolves to the worktree's workspace");
  r = await resolve(nested);
  assert.equal(r.workspace.id, "ws-nested", "a worktree nested in its repository resolves to the worktree");
  r = await resolve(path.join(nested, "src"));
  assert.equal(r.workspace.id, "ws-nested");
  r = await resolve(sub);
  assert.equal(r.workspace.id, "ws-repo");
  assert.equal(r.folder, fs.realpathSync(sub), "a subfolder becomes the default cwd");
  r = await resolve(link);
  assert.equal(r.workspace.id, "ws-repo", "a symlink resolves to the folder it points at");
  r = await resolve("ws-ssh");
  assert.equal(r.ok, true, "an id resolves even to an SSH workspace; the gate refuses it");

  for (const raw of ["", "   ", "ws-gone", "relative/path", outside, "ssh://box/home/me/app", "x".repeat(5000)]) {
    r = await resolve(raw);
    assert.equal(r.ok, false, `refused: ${raw.slice(0, 40)}`);
    assert.equal(typeof r.message, "string");
  }
  assert.match((await resolve(outside)).message, /does not create workspaces/);
  const before = workspaces.length;
  await resolve(path.join(OUT_DIR, "new-folder"));
  assert.equal(workspaces.length, before, "resolution never adds a workspace");
  const prefixTwin = mkdir("repo-twin");
  r = await resolve(prefixTwin);
  assert.equal(r.ok, false, "a sibling folder sharing a name prefix is not inside the workspace");
  console.log("ok 1 workspace resolves by id, folder, worktree folder and subfolder; nothing else");

  // ── 2. Gate ────────────────────────────────────────────────────────────
  const local = workspaces[0];
  const target = workspaces[2];
  const ssh = workspaces[3];
  const gate = (overrides) =>
    cross.crossWorkspaceRefusal({ authKind: "root", untrustedRun: false, caller: local, target, ...overrides });
  assert.equal(gate({}), null, "the user's own agents may ask");
  assert.match(gate({ authKind: "pane" }), /credential/);
  assert.match(gate({ authKind: "scoped" }), /credential/);
  assert.match(gate({ untrustedRun: true }), /imported pull-request/);
  assert.match(gate({ caller: null }), /could not tell/);
  assert.match(gate({ caller: ssh }), /SSH/);
  assert.match(gate({ target: ssh }), /SSH/);
  assert.match(gate({ target: { id: "x", name: "X", cwd: "ssh://h/p" } }), /SSH/);
  assert.match(
    gate({ authKind: "scoped", untrustedRun: true, caller: null }),
    /credential/,
    "the credential is checked first",
  );
  assert.match(gate({ untrustedCaller: true }), /imported pull-request workspace/);

  const prOrigin = { kind: "github-pull-request", repo: "o/r", number: 7 };
  const prRoot = mkdir("pr-import");
  const prWorkspace = {
    id: "ws-pr",
    name: "PR #7",
    cwd: prRoot,
    copyBranch: { repoCwd: repo, branch: "pr-7", city: "pr-7", createdAt: "now", origin: prOrigin },
  };
  const railWithPr = [...workspaces, prWorkspace];
  const inPr = (callerWs, callerCwd = null) =>
    cross.callerInImportedPullRequest({ caller: callerWs, callerCwd, workspaces: railWithPr });
  assert.equal(await inPr(prWorkspace), true, "a hand-started agent in an imported PR workspace is untrusted");
  assert.equal(
    await inPr({ id: "ws-loose", name: "Loose", cwd: path.join(prRoot, "sub") }),
    true,
    "a workspace whose folder lies inside an imported PR is untrusted too",
  );
  assert.equal(
    await inPr(local, path.join(prRoot, "src")),
    true,
    "a pane that started inside an imported PR checkout is untrusted",
  );
  assert.equal(await inPr(local, repo), false, "an ordinary workspace and pane are trusted");
  assert.equal(await inPr(local), false);
  console.log("ok 2 pane and scoped credentials, imported PR runs and agents, unknown callers and SSH are refused");

  // ── 3. Grants file ─────────────────────────────────────────────────────
  const file = path.join(OUT_DIR, "home", "codara", cross.CROSS_WORKSPACE_GRANTS_FILE);
  let store = cross.fileGrantStore(file);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.has("a", "b"), false);
  await store.grant({ callerWorkspaceId: "a", callerName: "CEO", targetWorkspaceId: "b", targetName: "Cora" });
  await store.grant({ callerWorkspaceId: "a", callerName: "CEO", targetWorkspaceId: "b", targetName: "Cora" });
  await store.grant({ callerWorkspaceId: "b", callerName: "Cora", targetWorkspaceId: "a", targetName: "CEO" });
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  store = cross.fileGrantStore(file);
  assert.equal(await store.has("a", "b"), true);
  assert.equal(await store.has("b", "a"), true, "each direction is its own grant");
  assert.equal(await store.has("a", "c"), false);
  assert.equal((await store.list()).length, 2, "a repeated grant is stored once");
  assert.equal(await store.revoke("a", "b"), true);
  assert.equal(await store.revoke("a", "b"), false);
  assert.equal(await cross.fileGrantStore(file).has("a", "b"), false);
  assert.equal(await cross.fileGrantStore(file).has("b", "a"), true);
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(await cross.fileGrantStore(file).list(), [], "a broken file reads as no grants");
  fs.writeFileSync(file, JSON.stringify({ version: 1, grants: [{ callerWorkspaceId: "a" }, null, 7] }));
  assert.deepEqual(await cross.fileGrantStore(file).list(), [], "malformed entries are dropped");
  console.log("ok 3 always grants persist per pair, survive a new store and revoke");

  // ── 4. Approver ────────────────────────────────────────────────────────
  const caller = { id: "ws-ceo", name: "CEO", cwd: "/ceo" };
  const cora = { id: "ws-cora", name: "Cora", cwd: "/cora" };
  const answers = [];
  let asks = 0;
  const memory = memoryStore();
  let release = null;
  let clock = 1_000_000;
  const approver = cross.createCrossWorkspaceApprover({
    store: memory,
    now: () => clock,
    ask: async () => {
      asks += 1;
      if (release) return new Promise((done) => (release = done));
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  const authorize = () => approver.authorize({ caller, target: cora, agent: "Claude Code", requester: "pane:p1" });

  assert.deepEqual(await approver.authorize({ caller, target: caller, agent: null, requester: "pane:p1" }), {
    ok: true,
    via: "same-workspace",
  });
  assert.equal(asks, 0, "the own workspace never asks");

  answers.push(null);
  let decision = await authorize();
  assert.equal(decision.ok, false);
  assert.match(decision.message, /did not answer/);
  answers.push(new Error("window gone"));
  assert.equal((await authorize()).ok, false, "a failing prompt refuses");

  answers.push("once");
  assert.deepEqual(await authorize(), { ok: true, via: "once" });
  answers.push("deny");
  decision = await authorize();
  assert.equal(decision.ok, false, "once is not remembered");
  assert.match(decision.message, /declined/);
  const before4 = asks;
  decision = await authorize();
  assert.equal(decision.ok, false);
  assert.match(decision.message, /Do not retry/);
  assert.equal(asks, before4, "a denied pair is refused without a new card");
  clock += cross.CROSS_WORKSPACE_DENY_COOLDOWN_MS - 1;
  assert.equal((await authorize()).ok, false);
  assert.equal(asks, before4, "still inside the cooldown");
  clock += 2;
  answers.push(null);
  decision = await authorize();
  assert.equal(asks, before4 + 1, "after the cooldown the user is asked again");
  assert.match(decision.message, /did not answer/);

  answers.push("always");
  assert.deepEqual(await authorize(), { ok: true, via: "always" });
  const asked = asks;
  assert.deepEqual(await authorize(), { ok: true, via: "grant" });
  assert.equal(asks, asked, "a grant answers without asking");
  assert.equal(memory.grants.length, 1);
  assert.equal(memory.grants[0].callerWorkspaceId, "ws-ceo");
  assert.equal(memory.grants[0].targetWorkspaceId, "ws-cora");

  const other = { id: "ws-other", name: "Other", cwd: "/other" };
  const resolvers = [];
  const ask = async () => {
    asks += 1;
    return new Promise((done) => resolvers.push(done));
  };
  const shared = cross.createCrossWorkspaceApprover({ store: memoryStore(), ask });
  const startAsks = asks;
  const first = shared.authorize({ caller, target: other, agent: null, requester: "pane:p1" });
  const second = shared.authorize({ caller, target: other, agent: null, requester: "pane:p1" });
  const stranger = shared.authorize({ caller, target: other, agent: null, requester: "run:r9" });
  await new Promise((done) => setImmediate(done));
  assert.equal(asks - startAsks, 2, "one card per requester, shared by its concurrent calls");
  resolvers[0]("once");
  resolvers[1]("deny");
  assert.deepEqual(await first, { ok: true, via: "once" });
  assert.deepEqual(await second, { ok: true, via: "once" });
  assert.equal((await stranger).ok, false, "another requester's answer is its own");

  memory.failGrant = true;
  answers.push("always");
  const third = { id: "ws-third", name: "Third", cwd: "/third" };
  assert.deepEqual(await approver.authorize({ caller, target: third, agent: null, requester: "pane:p1" }), {
    ok: true,
    via: "always",
  });

  const targetWs = { id: "ws-repo", name: "Repo", cwd: repo };
  assert.equal(await cross.crossWorkspaceCwdRefusal(repo, targetWs), null);
  assert.equal(await cross.crossWorkspaceCwdRefusal(sub, targetWs), null);
  assert.equal(await cross.crossWorkspaceCwdRefusal(link, targetWs), null, "a symlink into the target is inside");
  assert.match(await cross.crossWorkspaceCwdRefusal(outside, targetWs), /inside Repo/);
  assert.match(await cross.crossWorkspaceCwdRefusal(prefixTwin, targetWs), /inside Repo/);
  assert.match(await cross.crossWorkspaceCwdRefusal(`${repo}/../elsewhere`, targetWs), /inside Repo/);
  assert.match(await cross.crossWorkspaceCwdRefusal("ssh://box/home/me", targetWs), /local folder/);
  assert.match(await cross.crossWorkspaceCwdRefusal("relative", targetWs), /absolute/);
  console.log("ok 4 the approver asks once per pair and requester, remembers always and a recent deny; cwd stays in the target");

  // ── 5. Ownership ───────────────────────────────────────────────────────
  const registry = new AgentTerminalRegistry();
  registry.register({ paneId: "p-cross", tabId: "t-cross", runId: null, ownerPaneId: "p-ceo" });
  registry.register({ paneId: "p-plain", tabId: "t-plain", runId: null });
  registry.register({ paneId: "p-run", tabId: "t-run", runId: "run-1", ownerPaneId: "p-ceo" });

  assert.equal(registry.isActiveOwnedBy("p-cross", null, "p-ceo"), true, "the opening pane may write");
  assert.equal(registry.isActiveOwnedBy("p-cross", null, "p-other"), false, "another agent's pane may not");
  assert.equal(registry.isActiveOwnedBy("p-cross", null, null), false, "an unplaced caller may not");
  assert.equal(registry.isActiveOwnedBy("p-cross", null), false);
  assert.equal(registry.isActiveOwnedBy("p-cross", "run-1", "p-ceo"), false, "a run may not");
  assert.equal(registry.isActiveOwnedBy("p-plain", null), true, "ordinary terminals keep their old rule");
  assert.equal(registry.isActiveOwnedBy("p-plain", null, "p-anyone"), true);
  assert.equal(registry.isActiveOwnedBy("p-run", "run-1", null), true, "a run-owned terminal follows its run");
  assert.equal(registry.isActiveOwnedBy("p-run", "run-2", "p-ceo"), false);
  assert.equal(registry.ownerPaneOf("p-cross"), "p-ceo");
  assert.equal(registry.ownerPaneOf("p-plain"), null);
  assert.equal(registry.ownerPaneOf("p-run"), null, "a run's terminal is steered by the run, not a pane");
  assert.deepEqual(
    registry.listOwnedByPane("p-ceo").map((t) => t.paneId),
    ["p-cross"],
    "the caller lists the terminals it opened elsewhere",
  );
  assert.deepEqual(registry.listOwnedByPane("p-other"), []);

  let destroyed = 0;
  const close = (callerPaneId) =>
    registry.close({
      paneId: "p-cross",
      runId: null,
      callerPaneId,
      stop: () => undefined,
      destroyTab: () => {
        destroyed += 1;
      },
    });
  await assert.rejects(close("p-other"), AgentTerminalOwnershipError);
  await assert.rejects(close(null), AgentTerminalOwnershipError);
  assert.equal(destroyed, 0);
  assert.deepEqual(await close("p-ceo"), { paneId: "p-cross", alreadyClosed: false });
  assert.equal(destroyed, 1);
  assert.deepEqual(await close("p-ceo"), { paneId: "p-cross", alreadyClosed: true }, "a retry is idempotent");

  registry.register({ paneId: "p-exit", tabId: "t-exit", runId: null, ownerPaneId: "p-ceo" });
  registry.markExited({ paneId: "p-exit", tabId: "t-exit" });
  assert.equal(registry.ownerPaneOf("p-exit"), "p-ceo", "an exited terminal keeps its owner for close");
  await assert.rejects(
    registry.close({ paneId: "p-exit", runId: null, callerPaneId: "p-x", stop() {}, destroyTab() {} }),
    AgentTerminalOwnershipError,
  );

  registry.register({ paneId: "p-dev", tabId: "t-dev", runId: null, ownerPaneId: "p-ceo" });
  assert.equal(registry.transferToWorkspace("p-dev"), true);
  assert.equal(registry.ownerPaneOf("p-dev"), null);
  assert.equal(registry.isActiveOwnedBy("p-dev", null, "p-anyone"), true, "a kept dev server belongs to its workspace");

  registry.register({ paneId: "p-orphan", tabId: "t-orphan", runId: null, ownerPaneId: "p-gone" });
  assert.equal(registry.isActiveOwnedBy("p-orphan", null, "p-other"), false);
  registry.releasePaneOwner("p-orphan");
  assert.equal(registry.ownerPaneOf("p-orphan"), null);
  assert.equal(
    registry.isActiveOwnedBy("p-orphan", null, "p-other"),
    true,
    "once its opener's pane is gone it follows the rule for every run-less terminal",
  );

  // Whether the opener's pane is really gone (agent-socket releases the owner
  // only then).
  let layoutReads = 0;
  const panes = (sessions, layout) => ({
    hasSession: (id) => sessions.includes(id),
    listPaneIds: async () => {
      layoutReads += 1;
      if (layout instanceof Error) throw layout;
      return layout;
    },
  });
  assert.equal(await cross.paneIsGone("p-ceo", panes(["p-ceo"], ["p-ceo"])), false, "a live pane is there");
  assert.equal(layoutReads, 0, "a live pane needs no layout read");
  assert.equal(
    await cross.paneIsGone("p-ceo", panes([], ["p-ceo", "p-x"])),
    false,
    "a hibernated or respawning pane has no process but is still in the layout",
  );
  assert.equal(
    await cross.paneIsGone("p-ceo", panes([], new Error("no window"))),
    false,
    "an unreadable layout keeps the owner",
  );
  assert.equal(await cross.paneIsGone("p-ceo", panes([], ["p-x"])), true, "a closed pane is gone");

  registry.register({ paneId: "p-sleep", tabId: "t-sleep", runId: null, ownerPaneId: "p-ceo" });
  const steer = async (callerPaneId, sessions, layout) => {
    const owner = registry.ownerPaneOf("p-sleep");
    if (owner && (await cross.paneIsGone(owner, panes(sessions, layout)))) registry.releasePaneOwner("p-sleep");
    return registry.isActiveOwnedBy("p-sleep", null, callerPaneId);
  };
  assert.equal(await steer("p-other", [], ["p-ceo"]), false, "another agent cannot take over while the owner sleeps");
  assert.equal(registry.ownerPaneOf("p-sleep"), "p-ceo", "sleeping keeps the owner");
  assert.equal(await steer("p-ceo", ["p-ceo"], ["p-ceo"]), true, "the owner steers again once it wakes");
  assert.equal(await steer("p-other", [], ["p-other"]), true, "once the owner's pane is closed, the old rule applies");
  assert.equal(registry.ownerPaneOf("p-sleep"), null);
  console.log("ok 5 a cross-workspace terminal is steered only from the pane that opened it, also while it sleeps");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
