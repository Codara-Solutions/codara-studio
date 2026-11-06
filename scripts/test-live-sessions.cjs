"use strict";
// session.list_all (codara_session_list_all): every agent session in a
// terminal pane, across workspaces, read the way the rail's Agents view
// reads it (src/shared/live-sessions.ts).
//
//   1. Each runtime state lands in the rail's bucket: blocked and error are
//      needs_you, every working kind is working, a finished turn is done and a
//      quiet prompt is idle.
//   2. The list names the workspace, drops panes of a removed workspace, falls
//      back to the runtime's name for an untitled tab, and sorts needs_you,
//      working, done, idle, the latest first.
//   3. The socket dispatches the method, and an imported pull request cannot
//      call it.
//
//   node scripts/test-live-sessions.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");

async function load() {
  const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codara-live-sessions-")), "live.cjs");
  await esbuild.build({
    entryPoints: [path.join(SHARED_DIR, "live-sessions.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  return require(outfile);
}

function pane(paneId, workspaceId, state, stateSince, extra = {}) {
  return {
    paneId,
    workspaceId,
    tabId: `tab-${paneId}`,
    tabTitle: `Tab ${paneId}`,
    runtime: "claude",
    state,
    stateSince,
    sessionSince: 1,
    turnStartedAt: null,
    tool: null,
    prompt: null,
    message: null,
    question: null,
    accountProfileId: null,
    ...extra,
  };
}

(async () => {
  const { liveSessionState, buildLiveSessions } = await load();

  const expected = {
    blocked: "needs_you",
    error: "needs_you",
    working: "working",
    background: "working",
    stalled: "working",
    launching: "working",
    done: "done",
    idle: "idle",
  };
  for (const [state, want] of Object.entries(expected)) {
    assert.equal(liveSessionState(state), want, `${state} reads ${want}`);
  }

  const workspaces = [
    { id: "ws-a", name: "api" },
    { id: "ws-b", name: "web" },
  ];
  const t = Date.UTC(2026, 10, 6, 12, 0, 0);
  const list = buildLiveSessions(
    [
      pane("idle-old", "ws-a", "idle", t - 9_000),
      pane("work-old", "ws-b", "working", t - 5_000, { runtime: "codex" }),
      pane("gone", "ws-removed", "blocked", t),
      pane("done", "ws-a", "done", t - 1_000),
      pane("work-new", "ws-a", "working", t - 2_000, { tabTitle: "" }),
      pane("ask", "ws-b", "blocked", t - 8_000),
    ],
    workspaces,
  );
  assert.deepEqual(
    list.map((entry) => entry.id),
    ["ask", "work-new", "work-old", "done", "idle-old"],
    "needs_you, working, done, idle; latest first; a removed workspace's pane is left out",
  );
  const ask = list[0];
  assert.deepEqual(ask, {
    id: "ask",
    title: "Tab ask",
    workspaceId: "ws-b",
    workspace: "web",
    runtime: "claude",
    state: "needs_you",
    lastActivity: new Date(t - 8_000).toISOString(),
  });
  assert.equal(list[1].title, "Claude Code", "an untitled tab reads as its runtime");
  assert.equal(list[2].runtime, "codex");
  assert.equal(
    buildLiveSessions([pane("unknown", "ws-a", "idle", 0)], workspaces)[0].lastActivity,
    null,
    "an unknown time is null, not the epoch",
  );
  const many = Array.from({ length: 130 }, (_, i) => pane(`p${i}`, "ws-a", "idle", t - i));
  assert.equal(buildLiveSessions(many, workspaces).length, 100, "the list is capped");

  const socket = fs.readFileSync(path.join(ROOT, "src", "main", "agent-socket.ts"), "utf8");
  assert.match(socket, /case "session\.list_all":\s*\n\s*return await handleSessionListAll/, "the socket dispatches session.list_all");
  const blocked = socket.slice(socket.indexOf("UNTRUSTED_PULL_REQUEST_BLOCKED_METHODS = new Set"));
  assert.match(blocked.slice(0, blocked.indexOf("]);")), /"session\.list_all"/, "an imported pull request cannot list sessions");

  const handler = socket.slice(socket.indexOf("async function handleSessionListAll"));
  assert.match(handler.slice(0, 600), /agentSessionCallerRefusal/, "a caller in an imported pull request is refused even without a runId");

  console.log("live-sessions: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
