"use strict";
// Each agent's line in the rail and its workspace's summary line.
//
//   1. src/shared/agent-status.ts on cards the real board builder makes:
//      each agent's state (working, needs you, done, idle), notes on their
//      own agent's line only, a note that leaves with its pane, and the one
//      summary line that merges agent states with the task list's counts.
//   2. Seeing a tab clears its "done" and "needs you" (clearSeenAttention,
//      what App runs when a tab is focused).
//   3. Main's side of "a note dies with its tab": the terminal notifier
//      reports a removed pane (closed, or disposed) and not a sleeping one,
//      and the note book drops that pane's note.
//
//   node scripts/test-agent-status.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "codara-agent-status-test-"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sharedAlias = {
  name: "shared-alias",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

async function bundle(contents, name, plugins = [sharedAlias], resolveDir = SHARED_DIR) {
  const outfile = path.join(OUT_DIR, `${name}.cjs`);
  await esbuild.build({
    stdin: { contents, resolveDir, loader: "ts" },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins,
    logLevel: "silent",
  });
  return require(outfile);
}

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const MIN = 60_000;

const WORKSPACES = [
  { id: "ws-a", name: "Alpha" },
  { id: "ws-b", name: "Beta" },
];

function activity(paneId, state, extra = {}) {
  return {
    paneId,
    workspaceId: "ws-a",
    tabId: `tab-${paneId}`,
    tabTitle: paneId,
    runtime: "claude",
    state,
    stateSince: NOW - 5 * MIN,
    sessionSince: NOW - 60 * MIN,
    turnStartedAt: null,
    tool: null,
    prompt: null,
    message: null,
    question: null,
    accountProfileId: null,
    ...extra,
  };
}

function note(key, workspaceId, text, at = NOW - MIN) {
  return {
    key,
    workspaceId,
    entry: { status: null, note: text, updatedAt: at, by: { kind: "agent", label: "Claude Code" }, checkpoints: [] },
  };
}

function lines(mod, input) {
  const board = mod.buildAgentBoard({
    now: NOW,
    workspaces: WORKSPACES,
    layoutPanes: [],
    activity: input.activity,
    runs: input.runs ?? [],
    unseenPanes: input.unseen ?? {},
  });
  return mod.buildAgentLines({ board, notes: input.notes ?? {}, unseenPanes: input.unseen ?? {}, panes: input.panes ?? {} });
}

function perAgentState(mod) {
  const { agentLineState: state } = mod;
  assert.equal(state({ bucket: "working", unseen: false }), "working");
  assert.equal(state({ bucket: "needs-you", unseen: false }), "needs-you");
  assert.equal(state({ bucket: "done", unseen: true }), "done", "a finished turn not opened yet is done");
  assert.equal(state({ bucket: "done", unseen: false }), "idle", "a finished turn the user has seen is idle");
  assert.equal(state({ bucket: "done", unseen: false }, "complete"), "done");
  assert.equal(state({ bucket: "working", unseen: false }, "blocked"), "needs-you", "a prompt stays until its tab is opened");

  // Two working agents, one waiting on a permission, one finished, one idle.
  const byWorkspace = lines(mod, {
    activity: [
      activity("w1", "working", { workingSince: NOW - 4 * MIN }),
      activity("w2", "working", { workingSince: NOW - 2 * MIN }),
      activity("n1", "blocked", { question: "Allow npm test?" }),
      activity("d1", "idle", { message: "All green." }),
      activity("i1", "idle"),
      activity("b1", "working", { workspaceId: "ws-b" }),
    ],
    unseen: { d1: "complete" },
  });
  const a = byWorkspace["ws-a"];
  assert.deepEqual(
    a.map((line) => [line.key, line.state]),
    [
      ["pane:n1", "needs-you"],
      ["pane:w2", "working"],
      ["pane:w1", "working"],
      ["pane:d1", "done"],
      ["pane:i1", "idle"],
    ],
    "needs you first, then working (latest first), done and idle",
  );
  assert.equal(a[0].text, "Allow npm test?", "a waiting agent shows what it asks");
  assert.equal(a[0].name, "Claude Code · n1", "the name says which tab");
  assert.deepEqual(a[0].target, { type: "terminal", workspaceId: "ws-a", tabId: "tab-n1", paneId: "n1" });
  assert.equal(byWorkspace["ws-b"].length, 1, "each workspace has its own lines");
  const split = lines(mod, {
    activity: [activity("s1", "working", { tabId: "t", tabTitle: "api" }), activity("s2", "working", { tabId: "t", tabTitle: "api" })],
  })["ws-a"];
  assert.deepEqual(split.map((line) => line.name), ["Claude Code", "Claude Code"], "a tab title two agents share names neither");

  // A Cora chat is an agent too.
  const withRun = lines(mod, {
    activity: [],
    runs: [{ id: "r1", workspaceId: "ws-a", title: "Fix login", status: "running", workerTasks: [], updatedAt: new Date(NOW).toISOString() }],
  });
  assert.equal(withRun["ws-a"][0].key, "run:r1");
  assert.equal(withRun["ws-a"][0].name, "Cora · Fix login");
  assert.equal(withRun["ws-a"][0].state, "working");
}

function notesStayOnTheirOwnLine(mod) {
  const notes = {
    "pane:w1": note("pane:w1", "ws-a", "Wiring the store"),
    "pane:w2": note("pane:w2", "ws-a", "Reviewing PR 45"),
  };
  const a = lines(mod, { activity: [activity("w1", "working"), activity("w2", "idle", { message: "Done." })], notes })["ws-a"];
  const byKey = Object.fromEntries(a.map((line) => [line.key, line]));
  assert.equal(byKey["pane:w1"].text, "Wiring the store");
  assert.equal(byKey["pane:w2"].text, "Reviewing PR 45", "two agents in one workspace keep separate lines");
  assert.equal(byKey["pane:w2"].fromNote, true);

  // A finished turn shows done with its last note; once seen it is idle and keeps the note.
  const done = lines(mod, { activity: [activity("w2", "idle", { message: "Done." })], notes, unseen: { w2: "complete" } })["ws-a"][0];
  assert.deepEqual([done.state, done.text], ["done", "Reviewing PR 45"]);

  // The tab closed: the pane is in neither main's activity nor the layouts,
  // so its note has no line, even before main drops it.
  assert.equal(lines(mod, { activity: [], notes, panes: {} })["ws-a"], undefined, "a closed tab's note shows nowhere");

  // A shell pane that wrote a note through `cora tool` shows it while the pane is open.
  const shell = lines(mod, {
    activity: [],
    notes: { "pane:sh": note("pane:sh", "ws-a", "Nightly import ran") },
    panes: { sh: { paneId: "sh", workspaceId: "ws-a", tabId: "t-sh", tabTitle: "shell" } },
  })["ws-a"];
  assert.deepEqual(shell.map((line) => [line.name, line.state, line.text]), [["shell", "idle", "Nightly import ran"]]);
}

function summaryMergesAgentsAndTasks(mod) {
  const { summarizeWorkspace: summarize } = mod;
  const a = lines(mod, {
    activity: [
      activity("w1", "working"),
      activity("w2", "working"),
      activity("n1", "blocked", { question: "Allow npm test?" }),
      activity("i1", "idle"),
    ],
  })["ws-a"];
  const agentsOnly = summarize(a, null);
  assert.equal(agentsOnly.line, "2 working · 1 needs you");
  assert.equal(agentsOnly.needsYou, 1);
  assert.match(agentsOnly.description, /4 agents: 1 needs you, 2 working, 1 idle\./);
  assert.match(agentsOnly.description, /Claude Code · n1 needs you: Allow npm test\?/);

  const tasks = {
    counts: { inbox: 1, ready: 0, running: 1, needsYou: 1, doneToday: 3 },
    line: "1 running · 1 needs you · 1 in inbox · 3 done today",
    needsYou: { taskId: "T4", title: "Ship it", reason: "Approve the deploy" },
    updatedAt: NOW,
  };
  const merged = summarize(a, tasks);
  assert.equal(merged.line, "3 working · 2 needs you · 1 in inbox · 3 done today", "one line, not two");
  assert.deepEqual(merged.parts.map((part) => part.kind), ["working", "needs-you", "inbox", "done"]);
  assert.match(merged.description, /T4 Ship it needs you: Approve the deploy/);

  const idle = summarize(lines(mod, { activity: [activity("i1", "idle"), activity("i2", "idle")] })["ws-a"], null);
  assert.equal(idle.line, "2 agents idle", "a workspace of idle agents says so");
  const doneAgent = summarize(lines(mod, { activity: [activity("d1", "idle")], unseen: { d1: "complete" } })["ws-a"], null);
  assert.equal(doneAgent.line, "1 done");
  assert.equal(summarize([], { ...tasks, counts: { inbox: 0, ready: 0, running: 0, needsYou: 0, doneToday: 0 } }).line, "Nothing on the list");
  assert.equal(summarize([], null), null, "no agents and no task list, no line");
  assert.equal(mod.agentLineAge({ since: NOW - 4 * MIN }, NOW), "4m");
  assert.equal(mod.agentLineAge({ since: 0 }, NOW), null);
}

function railSummarySpeaksOnlyWhenNeeded(mod) {
  const { summarizeWorkspace: summarize } = mod;
  const rail = { variant: "rail" };
  const a = lines(mod, {
    activity: [
      activity("w1", "working"),
      activity("w2", "working"),
      activity("n1", "blocked", { question: "Allow npm test?" }),
      activity("i1", "idle"),
    ],
  })["ws-a"];
  // The row's number counts the agents; the line names only what needs the user.
  const agentsOnly = summarize(a, null, rail);
  assert.equal(agentsOnly.line, "1 needs you", "no agent count on the line");
  assert.deepEqual(agentsOnly.parts.map((part) => part.kind), ["needs-you"]);
  assert.equal(agentsOnly.needsYou, 1);
  assert.match(agentsOnly.description, /4 agents: 1 needs you, 2 working, 1 idle\./, "the tooltip keeps the full account");

  const tasks = {
    counts: { inbox: 1, ready: 2, running: 1, needsYou: 1, doneToday: 3 },
    line: "1 running · 1 needs you · 2 ready · 1 in inbox · 3 done today",
    needsYou: { taskId: "T4", title: "Ship it", reason: "Approve the deploy" },
    updatedAt: NOW,
  };
  const merged = summarize(a, tasks, rail);
  assert.equal(merged.line, "2 needs you · 2 ready · 1 in inbox · 3 done today · 1 task running");
  assert.deepEqual(merged.parts.map((part) => part.kind), ["needs-you", "ready", "inbox", "done", "running"]);
  assert.match(merged.description, /Tasks: 1 running/);

  // Working and idle agents alone leave the row on one line.
  const working = lines(mod, { activity: [activity("w1", "working"), activity("i1", "idle")] })["ws-a"];
  assert.equal(summarize(working, null, rail), null, "agents working say nothing under the name");
  const idle = lines(mod, { activity: [activity("i1", "idle"), activity("i2", "idle")] })["ws-a"];
  assert.equal(summarize(idle, null, rail), null, "idle agents say nothing under the name");
  const empty = { ...tasks, counts: { inbox: 0, ready: 0, running: 0, needsYou: 0, doneToday: 0 }, needsYou: undefined };
  assert.equal(summarize([], empty, rail), null, "an empty task list says nothing either");

  // Tasks running are tasks, never read as agents.
  const running = summarize(working, { ...empty, counts: { ...empty.counts, running: 2 } }, rail);
  assert.equal(running.line, "2 tasks running");
  const done = summarize(lines(mod, { activity: [activity("d1", "idle")], unseen: { d1: "complete" } })["ws-a"], null, rail);
  assert.equal(done.line, "1 done", "a finished turn still shows");

  // Without the option the line reads as it always did.
  assert.equal(summarize(a, null).line, "2 working · 1 needs you");
  assert.equal(summarize(idle, null).line, "2 agents idle");
}

function focusClearsDone(mod) {
  const { clearSeenAttention: clear } = mod;
  const attention = {
    "ws-a": {
      d1: { tabId: "tab-d1", kind: "complete" },
      n1: { tabId: "tab-n1", kind: "blocked" },
    },
    "ws-b": { b1: { tabId: "tab-b1", kind: "complete" } },
  };
  const live = new Set(["tab-d1", "tab-n1"]);
  assert.equal(clear(attention, "ws-a", "tab-other", live), attention, "nothing seen, nothing changes");
  const seen = clear(attention, "ws-a", "tab-d1", live);
  assert.deepEqual(Object.keys(seen["ws-a"]), ["n1"], "focusing the tab clears its done");
  assert.equal(seen["ws-b"], attention["ws-b"], "other workspaces keep theirs");

  // The line follows: done before the tab is focused, idle after.
  const unseenOf = (map) => Object.fromEntries(Object.values(map).flatMap((panes) => Object.entries(panes).map(([id, e]) => [id, e.kind])));
  const before = lines(mod, { activity: [activity("d1", "idle", { message: "Done." })], unseen: unseenOf(attention) })["ws-a"][0];
  const after = lines(mod, { activity: [activity("d1", "idle", { message: "Done." })], unseen: unseenOf(seen) })["ws-a"][0];
  assert.deepEqual([before.state, after.state], ["done", "idle"]);

  // Needs you clears once its tab is opened, and a closed tab's alert goes.
  const opened = clear(seen, "ws-a", "tab-n1", live);
  assert.equal(opened["ws-a"], undefined);
  const closed = clear(attention, "ws-a", null, new Set(["tab-n1"]));
  assert.deepEqual(Object.keys(closed["ws-a"]), ["n1"], "the closed tab's done went, the open one's prompt stays");
}

const notifierStubs = {
  name: "terminal-agent-notify-stubs",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve(
      {
        filter:
          /^(electron|\.\/pty-manager|\.\/notify|\.\/owned-process-tree|\.\/agent-session-registry|\.\/orchestration\/usage-activity-refresh|\.\/agent-board-signal)$/,
      },
      (args) => ({ path: args.path, namespace: "stub" }),
    );
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      const init = "globalThis.__AS ??= { taps: new Map(), exits: new Map() };\n";
      const stubs = {
        electron: "export const BrowserWindow = { getFocusedWindow: () => null };\n",
        "./agent-session-registry": "export function latestSessionStart(){ return null; }\n",
        "./orchestration/usage-activity-refresh": "export function nudgeUsageRefresh() {}\n",
        "./owned-process-tree":
          "export function descendantsStartedAfter(){ return []; }\n" +
          "export function aliveProcesses(){ return []; }\n" +
          "export async function descendantProcessesWithCommands(){ return null; }\n",
        "./agent-board-signal": "export function signalAgentBoardChanged(){}\n",
        "./pty-manager":
          "export function hasSession(){ return true; }\n" +
          "export function sessionAgentFlagsReachCli(){ return true; }\n" +
          "export function tap(id, h){ globalThis.__AS.taps.set(id, h); return () => globalThis.__AS.taps.delete(id); }\n" +
          "export function onExit(id, h){ globalThis.__AS.exits.set(id, h); return () => globalThis.__AS.exits.delete(id); }\n" +
          "export function readTailChunks(){ return []; }\n" +
          "export function sessionPid(){ return null; }\n" +
          "export function sessionDimensions(){ return null; }\n" +
          "export function waitForSpawn(){ return Promise.resolve(true); }\n" +
          "export function write(){}\n",
        "./notify":
          "export const paneSourceKey = (paneId) => `pane:${paneId}`;\n" +
          "export function rearm(){}\n" +
          "export function emitTerminalAgentState(){}\n" +
          "export function publish(){}\n",
      };
      return { contents: init + stubs[args.path], loader: "js" };
    });
  },
};

async function closedPaneDropsItsNote(status) {
  const notifier = await bundle(
    `export * from "./terminal-agent-notify";`,
    "terminal-agent-notify",
    [notifierStubs],
    path.join(ROOT, "src", "main"),
  );
  const T = globalThis.__AS;
  const AGENT = { kind: "agent", label: "Claude Code" };
  const book = status.createAgentNoteBook();
  // What src/main/workspace-status/index.ts wires.
  notifier.onTerminalPaneRemoved((paneId) => book.drop(status.paneNoteKey(paneId)));
  const panes = (ids) =>
    notifier.syncTerminalNotifyPanes({
      workspaceId: "ws-a",
      workspaceName: "Alpha",
      panes: ids.map((id) => ({ paneId: id, tabId: `tab-${id}`, tabTitle: id, excluded: false })),
    });
  panes(["p1", "p2", "p3"]);
  await sleep(20);
  for (const id of ["p1", "p2", "p3"]) book.update(status.paneNoteKey(id), "ws-a", { note: `note ${id}` }, AGENT);

  // p1's tab closes: it leaves the layout and its note goes.
  panes(["p2", "p3"]);
  assert.equal(book.get("pane:p1"), null, "a note dies when its tab closes");
  assert.equal(book.get("pane:p2").entry.note, "note p2");

  // p2's agent goes to sleep (agent hibernation): the tab is still open, so the note stays.
  T.exits.get("p2")({ exitCode: 0, signal: 1, hibernated: true });
  assert.equal(book.get("pane:p2").entry.note, "note p2", "a sleeping agent keeps its note");

  // p3's terminal is disposed by Codara (its pane closed): gone once it exits.
  notifier.noteTerminalWillDispose("p3");
  T.exits.get("p3")({ exitCode: 0, signal: 1, sanctioned: true });
  assert.equal(book.get("pane:p3"), null, "a disposed pane's note goes");
  notifier.disposeAllTerminalAgentWatchers();
}

(async () => {
  try {
    const mod = await bundle(
      [`export * from "./agent-status";`, `export { buildAgentBoard } from "./agent-board";`].join("\n"),
      "agent-status",
    );
    perAgentState(mod);
    console.log("per-agent state: ok");
    notesStayOnTheirOwnLine(mod);
    console.log("notes on their own line: ok");
    summaryMergesAgentsAndTasks(mod);
    console.log("workspace summary line: ok");
    railSummarySpeaksOnlyWhenNeeded(mod);
    console.log("rail summary line speaks only when needed: ok");
    focusClearsDone(mod);
    console.log("focus clears done: ok");
    const status = await bundle(
      [
        `export { createAgentNoteBook } from "./workspace-status/agent-notes";`,
        `export { paneNoteKey } from "@shared/agent-status";`,
      ].join("\n"),
      "agent-notes",
      [sharedAlias],
      path.join(ROOT, "src", "main"),
    );
    await closedPaneDropsItsNote(status);
    console.log("closed pane drops its note: ok");
  } finally {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
