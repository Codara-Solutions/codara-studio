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
//      concurrent calls of one requester (Allow once lets only one of them
//      through; Always and Deny answer all), and still allows when saving the
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
  const { processCwds } = await bundle("src/main/pi-session-tracker.ts", "pi-session-tracker");
  const { processChain } = await bundle("src/main/owned-process-tree.ts", "owned-process-tree");
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
  assert.match(gate({ callerTrust: "untrusted-pull-request" }), /imported pull-request workspace/);
  assert.match(gate({ callerTrust: "unknown" }), /could not read which folder/);
  assert.equal(gate({ callerTrust: "trusted" }), null);

  const prOrigin = { kind: "github-pull-request", repo: "o/r", number: 7 };
  const prRoot = mkdir("pr-import");
  const prWorkspace = {
    id: "ws-pr",
    name: "PR #7",
    cwd: prRoot,
    copyBranch: { repoCwd: repo, branch: "pr-7", city: "pr-7", createdAt: "now", origin: prOrigin },
  };
  const railWithPr = [...workspaces, prWorkspace];
  const trust = (callerWs, processCwds, rail = railWithPr) =>
    cross.callerPullRequestTrust({ caller: callerWs, processCwds, workspaces: rail });
  assert.equal(await trust(prWorkspace, []), "untrusted-pull-request", "an agent in an imported PR workspace");
  assert.equal(
    await trust({ id: "ws-loose", name: "Loose", cwd: path.join(prRoot, "sub") }, []),
    "untrusted-pull-request",
    "a workspace whose folder lies inside an imported PR",
  );
  // `cd <pr checkout> && claude` in a trusted workspace's shell: the pane's
  // start folder is still the trusted one; only the processes moved.
  assert.equal(
    await trust(local, [path.join(OUT_DIR, "elsewhere"), path.join(prRoot, "src"), repo]),
    "untrusted-pull-request",
    "a hand-started agent whose process sits in an imported PR checkout is refused",
  );
  const prLink = path.join(OUT_DIR, "pr-link");
  fs.symlinkSync(prRoot, prLink);
  assert.equal(await trust(local, [prLink]), "untrusted-pull-request", "also through a symlink");
  assert.equal(await trust(local, [repo, sub]), "trusted", "an ordinary workspace and processes are trusted");
  assert.equal(await trust(local, null), "unknown", "unreadable folders with an imported PR open are unknown");
  assert.equal(await trust(local, null, workspaces), "trusted", "with no imported PR open nothing can be untrusted");

  // Which processes count: MCP server, agent, shell; not Codara or above.
  const inspect = (chain) =>
    cross.callerProcessesToInspect(chain, { isPaneShell: (pid) => pid === 30, appPid: 40 });
  assert.deepEqual(inspect([10, 20, 30, 40, 1]), [10, 20, 30], "from the MCP server up to the pane's shell");
  assert.deepEqual(inspect([10, 20, 40, 1]), [10, 20], "never Codara itself or its parents");

  if (process.platform === "linux" || process.platform === "darwin") {
    // Live: a shell started in a trusted folder that then `cd`s into the
    // imported PR checkout and runs an agent there, read the way
    // agent-socket reads the caller.
    const { spawn } = require("node:child_process");
    const shell = spawn("/bin/sh", ["-c", `cd "${prRoot}" && exec sleep 30`], { cwd: repo, stdio: "ignore" });
    try {
      // Wait for the shell to have run its `cd`.
      for (let i = 0; i < 50; i++) {
        if ((await processCwds([shell.pid]))?.get(shell.pid)?.includes("pr-import")) break;
        await new Promise((done) => setTimeout(done, 100));
      }
      const chain = await processChain(shell.pid);
      const pids = cross.callerProcessesToInspect(chain, { isPaneShell: () => false, appPid: process.pid });
      assert.deepEqual(pids, [shell.pid], "the agent's chain stops below the process that asks (here: this test)");
      const live = await processCwds(pids);
      assert.equal(await trust(local, [...live.values()]), "untrusted-pull-request", "the real current folder is read");
    } finally {
      shell.kill("SIGKILL");
    }
  }
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
  const onceResults = [await first, await second];
  assert.equal(onceResults.filter((d) => d.ok).length, 1, "Allow once lets exactly one waiting call through");
  const leftOver = onceResults.find((d) => !d.ok);
  assert.match(leftOver.message, /call again/);
  assert.equal((await stranger).ok, false, "another requester's answer is its own");

  // Always and Deny answer every call waiting on the card.
  for (const [answer, ok] of [["always", true], ["deny", false]]) {
    const waiting = [];
    const card = cross.createCrossWorkspaceApprover({
      store: memoryStore(),
      ask: async () => new Promise((done) => waiting.push(done)),
    });
    const calls = [1, 2, 3].map(() => card.authorize({ caller, target: other, agent: null, requester: "pane:p1" }));
    await new Promise((done) => setImmediate(done));
    assert.equal(waiting.length, 1, "one card for the three calls");
    waiting[0](answer);
    const results = await Promise.all(calls);
    assert.deepEqual(results.map((d) => d.ok), [ok, ok, ok], `${answer} answers all three`);
  }

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
  const ceo = { paneId: "p-ceo", sessionId: null };
  const otherPane = { paneId: "p-other", sessionId: null };
  registry.register({ paneId: "p-cross", tabId: "t-cross", runId: null, ownerPaneId: "p-ceo" });
  registry.register({ paneId: "p-plain", tabId: "t-plain", runId: null });
  registry.register({ paneId: "p-run", tabId: "t-run", runId: "run-1", ownerPaneId: "p-ceo" });

  assert.equal(registry.isActiveOwnedBy("p-cross", null, ceo), true, "the opening pane may write");
  assert.equal(registry.isActiveOwnedBy("p-cross", null, otherPane), false, "another agent's pane may not");
  assert.equal(registry.isActiveOwnedBy("p-cross", null, null), false, "an unplaced caller may not");
  assert.equal(registry.isActiveOwnedBy("p-cross", null), false);
  assert.equal(registry.isActiveOwnedBy("p-cross", "run-1", ceo), false, "a run may not");
  assert.equal(registry.isActiveOwnedBy("p-plain", null), true, "a terminal opened outside any pane belongs to such callers");
  assert.equal(registry.isActiveOwnedBy("p-plain", null, { paneId: "p-anyone" }), false, "and not to an agent in a pane");
  assert.equal(registry.isActiveOwnedBy("p-run", "run-1", null), true, "a run-owned terminal follows its run");
  assert.equal(registry.isActiveOwnedBy("p-run", "run-2", ceo), false);
  assert.deepEqual(registry.openerOf("p-cross"), { paneId: "p-ceo", sessionId: null });
  assert.equal(registry.openerOf("p-plain"), null);
  assert.equal(registry.openerOf("p-run"), null, "a run's terminal is steered by the run, not a pane");
  assert.deepEqual(
    registry.listOpenedBy(ceo).map((t) => t.paneId),
    ["p-cross"],
    "the caller lists the terminals it opened",
  );
  assert.deepEqual(registry.listOpenedBy(otherPane), []);

  let destroyed = 0;
  const close = (caller) =>
    registry.close({
      paneId: "p-cross",
      runId: null,
      caller,
      stop: () => undefined,
      destroyTab: () => {
        destroyed += 1;
      },
    });
  await assert.rejects(close(otherPane), AgentTerminalOwnershipError);
  await assert.rejects(close(null), AgentTerminalOwnershipError);
  assert.equal(destroyed, 0);
  assert.deepEqual(await close(ceo), { paneId: "p-cross", alreadyClosed: false });
  assert.equal(destroyed, 1);
  assert.deepEqual(await close(ceo), { paneId: "p-cross", alreadyClosed: true }, "a retry is idempotent");

  registry.register({ paneId: "p-exit", tabId: "t-exit", runId: null, ownerPaneId: "p-ceo" });
  registry.markExited({ paneId: "p-exit", tabId: "t-exit" });
  assert.deepEqual(registry.openerOf("p-exit"), { paneId: "p-ceo", sessionId: null }, "an exited terminal keeps its owner for close");
  await assert.rejects(
    registry.close({ paneId: "p-exit", runId: null, caller: { paneId: "p-x" }, stop() {}, destroyTab() {} }),
    AgentTerminalOwnershipError,
  );

  registry.register({ paneId: "p-dev", tabId: "t-dev", runId: null, ownerPaneId: "p-ceo" });
  assert.equal(registry.transferToWorkspace("p-dev"), true);
  assert.equal(registry.openerOf("p-dev"), null);
  assert.equal(registry.isActiveOwnedBy("p-dev", null, { paneId: "p-anyone" }), true, "a kept dev server belongs to its workspace");

  // Pane ids are never reused, so an opener whose pane closed leaves its
  // terminal to its session, or to the user, never to whichever agent asks.
  registry.register({ paneId: "p-orphan", tabId: "t-orphan", runId: null, ownerPaneId: "p-gone" });
  assert.equal(registry.isActiveOwnedBy("p-orphan", null, otherPane), false);
  registry.register({ paneId: "p-resumed", tabId: "t-resumed", runId: null, ownerPaneId: "p-gone", ownerSessionId: "s-1" });
  assert.equal(registry.isActiveOwnedBy("p-resumed", null, { paneId: "p-new", sessionId: "s-1" }), true, "the opener's session resumed elsewhere");
  console.log("ok 5 a terminal is steered only by the agent that opened it");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
