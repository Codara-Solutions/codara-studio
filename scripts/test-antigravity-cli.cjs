// src/main/antigravity-cli.ts: what main knows about the user's own `agy`.
// Bundles the real module with the pane, process and binary lookups stubbed,
// and checks the install lookup (no npm, a miss kept 30 s, a fresh ask on
// click), the agy process check that gates a restore pointer, the one
// pane per run that may reopen agy's latest conversation, and what agent
// hibernation reads of agy: the conversation its process holds open (the
// presence lock's file name) and agy's own busy flag for it and its subagents.
//
//   node scripts/test-antigravity-cli.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-antigravity-cli-"));
  try {
    const outfile = path.join(dir, "antigravity-cli.cjs");
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "main", "antigravity-cli.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      logLevel: "silent",
      plugins: [
        {
          name: "stubs",
          setup(build) {
            build.onResolve({ filter: /^\.\/(pty-manager|owned-process-tree|binary-resolver)$/ }, (args) => ({
              path: args.path,
              namespace: "stub",
            }));
            build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
              const init = "globalThis.__AGY ??= { found: null, lookups: 0, pids: new Map(), processes: new Map() };\n";
              const contents = {
                "./pty-manager": "export function sessionPid(id){ return globalThis.__AGY.pids.get(id) ?? null; }\n",
                "./owned-process-tree":
                  "export async function descendantProcessesWithCommands(pid){ return globalThis.__AGY.processes.get(pid) ?? null; }\n" +
                  "export async function listProcessesWithCommands(){ return null; }\n",
                "./binary-resolver":
                  "export async function findBinaryOutsideNpm(name){ globalThis.__AGY.lookups += 1; return name === 'agy' ? globalThis.__AGY.found : null; }\n",
              }[args.path];
              return { contents: init + contents, loader: "js" };
            });
          },
        },
      ],
    });
    const cli = require(outfile);
    const A = globalThis.__AGY;

    // ── Install lookup ──
    assert.deepEqual(await cli.antigravityStatus(), { installed: false, onPath: false, dir: null });
    assert.equal(A.lookups, 1);
    await cli.antigravityStatus();
    assert.equal(A.lookups, 1, "a miss is searched again within 30 s");
    A.found = { path: "/home/u/.local/bin/agy", onPath: false };
    assert.deepEqual(await cli.antigravityStatus(true), { installed: true, onPath: false, dir: "/home/u/.local/bin" });
    assert.equal(A.lookups, 2, "a click did not ask afresh");
    A.found = { path: "/usr/bin/agy", onPath: true };
    assert.deepEqual(await cli.antigravityStatus(), { installed: true, onPath: true, dir: "/usr/bin" });
    assert.equal(A.lookups, 3, "a found agy is looked up each time");

    // ── Only a real agy process gates a restore pointer ──
    assert.equal(await cli.antigravityRunsInPane("no-such-pane"), false);
    A.pids.set("p1", 100);
    A.processes.set(100, [{ pid: 101, depth: 1, command: "bash -c printf '\\033]633;E;agy\\007'" }]);
    assert.equal(await cli.antigravityRunsInPane("p1"), false, "a printed marker counted as agy");
    A.processes.set(100, [{ pid: 102, depth: 1, command: "node /home/u/.local/bin/agy --mode=plan" }]);
    assert.equal(await cli.antigravityRunsInPane("p1"), true);
    A.processes.set(100, [{ pid: 103, depth: 1, command: "/home/u/.local/bin/agy --continue" }]);
    assert.equal(await cli.antigravityRunsInPane("p1"), true);

    // ── One pane per run reopens the latest conversation ──
    assert.equal(cli.claimAntigravityContinue("pane-a"), true);
    assert.equal(cli.claimAntigravityContinue("pane-b"), false, "two panes reopen the same conversation");
    assert.equal(cli.claimAntigravityContinue("pane-a"), true, "the first pane lost it on its own restart");
    // A restart after a pane's process died only checks the claim.
    assert.equal(cli.claimAntigravityContinue("pane-b", false), false, "pane B's restart reopens pane A's conversation");
    assert.equal(cli.claimAntigravityContinue("pane-a", false), true);
    // A pane closed before it ran agy gives the claim back; only its holder can.
    cli.releaseAntigravityContinue("pane-b");
    assert.equal(cli.claimAntigravityContinue("pane-a", false), true, "another pane released the holder's claim");
    cli.releaseAntigravityContinue("pane-a");
    assert.equal(cli.claimAntigravityContinue("pane-c", false), false, "a check took the free claim");
    assert.equal(cli.claimAntigravityContinue("pane-c"), true, "a released claim was not free again");

    // Never --continue onto a conversation another pane names by id: agy's
    // latest, overall or in the pane's folder, read from its summary table.
    const home = path.join(dir, "home");
    const agyDir = path.join(home, ".gemini", "antigravity-cli");
    fs.mkdirSync(agyDir, { recursive: true });
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(agyDir, "conversation_summaries.db"));
    db.exec(
      "CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text, preview text, step_count integer, last_modified_time datetime, workspace_uris text, parent_conversation_id text, nesting_depth integer)",
    );
    const add = db.prepare("INSERT INTO conversation_summaries VALUES (?, '', '', 1, ?, ?, '', 0)");
    add.run("conv-latest", "2026-11-22 10:00:00+00:00", JSON.stringify(["file:///w"]));
    add.run("conv-older", "2026-11-21 10:00:00+00:00", JSON.stringify(["file:///w"]));
    db.close();
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      assert.equal(cli.claimAntigravityContinue("pane-c", false, ["conv-latest"], "/w"), false, "the restart after the process died reopened a named conversation");
      assert.equal(cli.claimAntigravityContinue("pane-c", true, ["conv-older"], "/w"), true);
      cli.releaseAntigravityContinue("pane-c");
      assert.equal(cli.claimAntigravityContinue("pane-d", true, ["conv-latest"], "/w"), false, "the restore reopened a named conversation");
      assert.equal(cli.claimAntigravityContinue("pane-e"), false, "a refused take left the claim free for a later pane");
      assert.equal(cli.claimAntigravityContinue("pane-d", false, ["conv-latest"], "/w"), false, "the refused pane continued into a named conversation");
      assert.equal(cli.claimAntigravityContinue("pane-d", false, ["conv-older"], "/w"), true, "the refused pane lost its own later restart");
      cli.releaseAntigravityContinue("pane-d");
      assert.equal(cli.claimAntigravityContinue("pane-e"), true, "a released claim was not free again");
      cli.releaseAntigravityContinue("pane-e");
    } finally {
      process.env.HOME = realHome;
    }

    // The window takes the claim only for the restore after a restart, and
    // gives it back when that pane never runs agy.
    const session = fs.readFileSync(path.join(ROOT, "src/renderer/src/components/Terminal/useTerminalSession.ts"), "utf8");
    const plans = [...session.matchAll(/await computeResumePlan\(([^)]*)\)/g)].map((match) => match[1]);
    assert.deepEqual(
      plans.filter((args) => args.includes('"take"')),
      ['restore, sessionId, "take"'],
      "only the restore after a restart may take the claim",
    );
    assert.equal(plans.length, 3, "a new resume path must decide whether it takes the claim");
    const releases = session.match(/releaseAntigravityClaim\(\);/g) ?? [];
    assert.ok(releases.length >= 4, "the claim is released when the pane closes first, the spawn fails or nothing ran");

    console.log("PASS antigravity-cli: install lookup, agy process check, one --continue per run");

    // ── The conversation an agy process holds open (agent hibernation) ──
    const presenceOut = path.join(dir, "antigravity-presence.cjs");
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "main", "antigravity-presence.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: presenceOut,
      logLevel: "silent",
    });
    const presence = require(presenceOut);
    const presenceDir = "/home/u/.gemini/antigravity-cli/presence";
    assert.deepEqual(
      presence.presenceIdsFromPaths(
        [
          "/dev/pts/3",
          `${presenceDir}/d1ce7d89-2c5a-4284-aa28-c9e1eaa1dc6a.lock`,
          `${presenceDir}/continue.lock`,
          `${presenceDir}/../presence/abc.lock`,
          `${presenceDir}/sub/other.lock`,
          "/tmp/presence/fake.lock",
          `${presenceDir}/no-lock-suffix`,
          "socket:[123]",
        ],
        presenceDir,
      ),
      ["d1ce7d89-2c5a-4284-aa28-c9e1eaa1dc6a", "abc"],
      "only <agy dir>/presence/<id>.lock names a conversation",
    );
    assert.deepEqual(presence.lsofPaths("p42\nfcwd\nn/home/u\nf7\nn/x/presence/a.lock\n"), ["/home/u", "/x/presence/a.lock"]);
    assert.equal(await presence.antigravityOpenConversations(123, "win32"), null, "Windows has no way to read it: unknown");
    assert.deepEqual(await presence.antigravityOpenConversations(2 ** 31, "linux"), [], "a process gone since the listing holds nothing");

    // The pane's one agy, holding one conversation, names it; anything else is unknown.
    A.pids.set("p2", 200);
    const openBy = new Map([[202, ["conv-a"]], [203, ["conv-a", "conv-sub"]]]);
    const openOf = async (pid) => openBy.get(pid) ?? null;
    A.processes.set(200, [{ pid: 202, depth: 1, command: "/home/u/.local/bin/agy" }]);
    assert.equal(await cli.antigravityPaneConversation("p2", openOf), "conv-a");
    A.processes.set(200, [{ pid: 203, depth: 1, command: "agy --continue" }]);
    assert.equal(await cli.antigravityPaneConversation("p2", openOf), null, "two open conversations named one");
    A.processes.set(200, [
      { pid: 202, depth: 1, command: "agy" },
      { pid: 204, depth: 1, command: "agy" },
    ]);
    assert.equal(await cli.antigravityPaneConversation("p2", openOf), null, "two agy processes named one");
    A.processes.set(200, [{ pid: 205, depth: 1, command: "agy" }]);
    assert.equal(await cli.antigravityPaneConversation("p2", openOf), null, "an unreadable process named one");
    assert.equal(await cli.antigravityPaneConversation("no-such-pane", openOf), null);

    // agy's busy flag, for the conversation and every subagent under it.
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "main", "session-search", "antigravity-summaries.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: path.join(dir, "summaries.cjs"),
      logLevel: "silent",
    });
    const summaries = require(path.join(dir, "summaries.cjs"));
    const busyDb = path.join(dir, "busy.db");
    const bdb = new DatabaseSync(busyDb);
    bdb.exec(
      "CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, parent_conversation_id text, nesting_depth integer, not_fully_idle integer)",
    );
    const row = bdb.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)");
    row.run("idle", "", 0, 0);
    row.run("idle-sub", "idle", 1, 0);
    row.run("busy", "", 0, 1);
    row.run("parent", "", 0, 0);
    row.run("child", "parent", 1, 0);
    row.run("grandchild", "child", 2, 1);
    row.run("loop-a", "loop-b", 1, 0);
    row.run("loop-b", "loop-a", 1, 0);
    bdb.close();
    const activity = (id) => summaries.readAntigravityConversationActivity(busyDb, id);
    assert.deepEqual(activity("idle"), { known: true, busy: null });
    assert.deepEqual(activity("busy"), { known: true, busy: "conversation" });
    assert.deepEqual(activity("parent"), { known: true, busy: "subagent" }, "a working subagent two levels down was missed");
    assert.deepEqual(activity("idle-sub"), { known: false, busy: null }, "a subagent conversation is not one a pane reopens");
    assert.deepEqual(activity("nope"), { known: false, busy: null });
    assert.deepEqual(activity("loop-a"), { known: false, busy: null }, "a parent loop must end the walk");
    const oldDb = path.join(dir, "old.db");
    const odb = new DatabaseSync(oldDb);
    odb.exec("CREATE TABLE conversation_summaries (conversation_id text, parent_conversation_id text, nesting_depth integer)");
    odb.close();
    assert.equal(summaries.readAntigravityConversationActivity(oldDb, "idle"), null, "no busy flag must read as unknown, not idle");
    assert.throws(() => summaries.readAntigravityConversationActivity(path.join(dir, "missing.db"), "idle"));
    console.log("PASS antigravity-presence: open conversation from the lock's name, agy's busy flag down the subagent tree");

    // ── Antigravity stays the user's own CLI: never a managed agent family,
    // a worker runtime or a session Codara tracks. It sleeps like the other
    // terminal agents (agent hibernation). ──
    const listsOut = path.join(dir, "lists.cjs");
    await esbuild.build({
      stdin: {
        contents:
          'export { AGENT_FAMILIES, isAgentRuntimeKind } from "./agent-families";\n' +
          'export { isAgentHibernationRuntime } from "./agent-hibernation";\n' +
          'export { AGENT_SESSION_RUNTIMES } from "./agent-sessions";\n',
        resolveDir: path.join(ROOT, "src", "shared"),
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: listsOut,
      logLevel: "silent",
    });
    const lists = require(listsOut);
    assert.ok(!Object.keys(lists.AGENT_FAMILIES).includes("antigravity"), "antigravity became a managed agent family");
    assert.equal(lists.isAgentRuntimeKind("antigravity"), false);
    assert.equal(lists.isAgentHibernationRuntime("antigravity"), true);
    assert.ok(!lists.AGENT_SESSION_RUNTIMES.includes("antigravity"));
    assert.equal(lists.isAgentRuntimeKind("claude"), true, "the check reads the real lists");
    console.log("PASS antigravity is in none of the managed agent lists");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
