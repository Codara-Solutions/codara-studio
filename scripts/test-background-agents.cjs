#!/usr/bin/env node
"use strict";

// Unit tests for src/shared/background-agents.ts: which worktrees get a
// "Background agent" card (a coordinator's subagent working in another
// workspace's repository), its state from the note, the creator and the
// worktree's activity, and how the card reaches the worktree's rail row
// (buildAgentLines, buildRailFamily) and the Agents tab's shelves.
//
//   node scripts/test-background-agents.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-background-agents-"));
  const entry = path.join(temp, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(path.join(ROOT, "src", "shared", "background-agents.ts"))};`,
      `export { buildAgentLines } from ${JSON.stringify(path.join(ROOT, "src", "shared", "agent-status.ts"))};`,
      `export { buildRailFamily } from ${JSON.stringify(path.join(ROOT, "src", "shared", "rail-tree.ts"))};`,
      `export { buildAgentInbox, emptyAgentInboxPrefs, parseAgentInboxPrefs } from ${JSON.stringify(path.join(ROOT, "src", "shared", "agent-inbox.ts"))};`,
    ].join("\n"),
  );
  const outfile = path.join(temp, "background-agents.cjs");
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
  });
  return { mod: require(outfile), cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

const WORKSPACES = [
  { id: "ws-ai", name: "AI Continous Improvment" },
  { id: "ws-cloud", name: "Cloud platform" },
  { id: "wt-cloud", name: "fix/mcp-node-path", icon: "branch" },
];

// A Claude Code pane in AI Continous Improvment, the coordinator.
function creatorCard(bucket = "working") {
  return {
    key: "pane:p-coord",
    source: "terminal",
    bucket,
    status: bucket === "working" ? "Working" : "Ready",
    tone: bucket === "working" ? "info" : "ok",
    workspaceId: "ws-ai",
    workspaceName: "AI Continous Improvment",
    workspaceColor: "#888",
    workspaceIcon: null,
    runtime: "claude",
    agentLabel: "Claude Code",
    account: null,
    title: "Coordinate",
    tabTitle: "Claude Code",
    message: null,
    tool: null,
    detail: null,
    since: NOW - 30 * MIN,
    unseen: false,
    sleeping: false,
    target: { type: "terminal", workspaceId: "ws-ai", tabId: "t1", paneId: "p-coord" },
    reply: null,
  };
}

function worktree(overrides = {}) {
  return {
    workspaceId: "wt-cloud",
    projectId: "ws-cloud",
    createdAt: NOW - 12 * MIN,
    creator: {
      paneId: "p-coord",
      client: "claude-code",
      purpose: "Fix the MCP node path",
      fromWorkspaceId: "ws-ai",
      fromWorkspaceName: "AI Continous Improvment",
    },
    merged: false,
    ...overrides,
  };
}

function note(text, overrides = {}) {
  return {
    "worktree:wt-cloud": {
      key: "worktree:wt-cloud",
      workspaceId: "wt-cloud",
      entry: {
        status: overrides.status ?? null,
        note: text,
        updatedAt: overrides.updatedAt ?? NOW - 2 * MIN,
        by: { kind: "agent", label: "Claude Code" },
        checkpoints: [],
      },
      worktreePath: "/wt/cloud",
      from: { workspaceId: "ws-ai", workspaceName: "AI Continous Improvment" },
    },
  };
}

function cards(mod, input) {
  return mod.backgroundAgentCards({
    now: NOW,
    notes: {},
    cards: [creatorCard()],
    workspaces: new Map(WORKSPACES.map((workspace) => [workspace.id, workspace])),
    ...input,
  });
}

const TESTS = [];
function test(name, fn) {
  TESTS.push({ name, fn });
}

test("a worktree made from another workspace gets a working background card under its project", ({ mod }) => {
  const [card] = cards(mod, { worktrees: [worktree()] });
  assert.equal(card.key, "worktree:wt-cloud");
  assert.equal(card.source, "background");
  assert.equal(card.bucket, "working");
  assert.equal(card.workspaceId, "wt-cloud", "the card sits in the worktree's own workspace");
  assert.equal(card.workspaceName, "Cloud platform", "the Agents tab names the project");
  assert.equal(card.agentLabel, "Background agent");
  assert.equal(card.tabTitle, "from AI Continous Improvment");
  assert.equal(card.title, "Fix the MCP node path");
  assert.equal(card.since, NOW - 12 * MIN, "working since the worktree was made");
  assert.deepEqual(card.target, { type: "workspace", workspaceId: "wt-cloud" });
});

test("a worktree made from its own project gets no card: its creator shows on the row already", ({ mod }) => {
  const own = worktree({ creator: { paneId: "p-coord", fromWorkspaceId: "ws-cloud" } });
  const ownCreator = { ...creatorCard(), workspaceId: "ws-cloud" };
  assert.equal(cards(mod, { worktrees: [own], cards: [ownCreator] }).length, 0);
});

test("a user's worktree, a merged one and one with an agent inside get no card", ({ mod }) => {
  assert.equal(cards(mod, { worktrees: [worktree({ creator: undefined })] }).length, 0, "user-made");
  assert.equal(cards(mod, { worktrees: [worktree({ merged: true })], notes: note("PR up") }).length, 0, "merged");
  const inside = { ...creatorCard(), key: "pane:p-in", workspaceId: "wt-cloud" };
  assert.equal(cards(mod, { worktrees: [worktree()], cards: [creatorCard(), inside] }).length, 0, "agent inside");
});

test("a legacy worktree whose creator is gone and never said where it came from gets no card", ({ mod }) => {
  const legacy = worktree({ creator: { paneId: "p-gone", client: "claude-code" } });
  assert.equal(cards(mod, { worktrees: [legacy] }).length, 0);
});

test("a note on the worktree shows a card even for a worktree of the caller's own project", ({ mod }) => {
  const own = worktree({ creator: { paneId: "p-coord", fromWorkspaceId: "ws-cloud" } });
  const [card] = cards(mod, { worktrees: [own], notes: note("Tests pass, opening PR"), cards: [{ ...creatorCard(), workspaceId: "ws-cloud" }] });
  assert.equal(card.message, "Tests pass, opening PR");
});

test("state: blocked note needs you, in_review is done, quiet with the creator gone is idle", ({ mod }) => {
  const blocked = cards(mod, { worktrees: [worktree()], notes: note("Need the API key", { status: "blocked" }) })[0];
  assert.equal(blocked.bucket, "needs-you");
  assert.equal(blocked.status, "Blocked");
  const review = cards(mod, { worktrees: [worktree()], notes: note("PR #12 up", { status: "in_review" }) })[0];
  assert.equal(review.bucket, "done");
  assert.equal(review.unseen, true, "a finished background agent reads as done, not idle");
  const gone = cards(mod, { worktrees: [worktree({ createdAt: NOW - 3 * 60 * MIN })], cards: [] })[0];
  assert.equal(gone.bucket, "done");
  assert.equal(gone.unseen, false, "idle");
  assert.equal(gone.status, "Idle");
});

test("state: working while the creator works or the worktree moved recently, idle once quiet", ({ mod }) => {
  const old = NOW - 3 * 60 * MIN;
  // The creator is open but idle; a commit five minutes ago is recent work.
  const recentCommit = cards(mod, { worktrees: [worktree({ createdAt: old, headAt: NOW - 5 * MIN })], cards: [creatorCard("done")] })[0];
  assert.equal(recentCommit.bucket, "working");
  // The creator works (or runs background tasks) and the last sign of work is under two hours old.
  const creatorBusy = cards(mod, { worktrees: [worktree({ createdAt: NOW - 90 * MIN })] })[0];
  assert.equal(creatorBusy.bucket, "working");
  // Creator idle, nothing for an hour.
  const quiet = cards(mod, { worktrees: [worktree({ createdAt: NOW - 60 * MIN })], cards: [creatorCard("done")] })[0];
  assert.equal(quiet.bucket, "done");
  assert.equal(quiet.unseen, false);
  // A note a minute ago is work going on, whatever Codara sees of the creator.
  const noted = cards(mod, { worktrees: [worktree({ createdAt: old })], cards: [], notes: note("Running the tests", { updatedAt: NOW - MIN }) })[0];
  assert.equal(noted.bucket, "working");
});

test("the card puts a background line on the worktree's row and keeps the creator on its own workspace", ({ mod }) => {
  const model = mod.withBackgroundAgents(
    { needsYou: [], working: [creatorCard()], done: [], total: 1 },
    { now: NOW, worktrees: [worktree()], notes: note("Running the e2e"), workspaces: WORKSPACES },
  );
  assert.equal(model.total, 2);
  const lines = mod.buildAgentLines({ board: model, notes: note("Running the e2e") });
  const [line] = lines["wt-cloud"];
  assert.equal(line.name, "Background agent · from AI Continous Improvment");
  assert.equal(line.state, "working");
  assert.equal(line.text, "Running the e2e");
  assert.equal(line.fromNote, true);
  assert.deepEqual(lines["ws-ai"].map((entry) => entry.key), ["pane:p-coord"]);
  const family = mod.buildRailFamily({
    projectLines: lines["ws-cloud"] ?? [],
    children: [{ workspaceId: "wt-cloud", lines: lines["wt-cloud"], creatorPaneId: "p-coord", merged: false }],
  });
  assert.deepEqual(family.active[0].agents.map((entry) => entry.key), ["worktree:wt-cloud"]);
});

test("the Agents tab lists the background agent, and its settle survives a reload", ({ mod }) => {
  const model = mod.withBackgroundAgents(
    { needsYou: [], working: [], done: [], total: 0 },
    { now: NOW, worktrees: [worktree()], notes: note("PR #12 up", { status: "in_review" }), workspaces: WORKSPACES },
  );
  const inbox = mod.buildAgentInbox(model, mod.emptyAgentInboxPrefs(), { now: NOW, pullRequests: {}, branches: {} });
  const rows = JSON.stringify(inbox);
  assert.ok(rows.includes("worktree:wt-cloud"), "the row is in the inbox view");
  const prefs = mod.parseAgentInboxPrefs({ settled: { "worktree:wt-cloud": { at: NOW } } }, NOW);
  assert.ok(prefs.settled["worktree:wt-cloud"], "a worktree key is a valid inbox key");
});

(async () => {
  const { mod, cleanup } = await load();
  let failed = 0;
  for (const { name, fn } of TESTS) {
    try {
      await fn({ mod });
      console.log(`PASS ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL ${name}`);
      console.error(err && err.stack ? err.stack : err);
    }
  }
  cleanup();
  console.log(`\n${TESTS.length - failed}/${TESTS.length} background-agents tests passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
