// Where a send from a browser tab can go, and where it goes by default
// (src/renderer/src/routing/agent-destinations.ts). Guards that every
// terminal pane is offered whatever CLI runs in it (agents first, the
// focused one leading), that a Cora worker is addressed by its attempt id,
// that an agent which quit is no longer called an agent, that docked browser
// cells are never offered, and the order of the default: the focused agent,
// then the tab's owner, then the only agent, then the open chat, then the
// inbox.
//
//   node scripts/test-agent-destinations.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

(async () => {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/renderer/src/routing/agent-destinations.ts")],
    bundle: true, format: "cjs", platform: "node", write: false, logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  const { paneDestinations, chatDestinations, defaultDestination, INBOX_DESTINATION, runtimeLabel, findPaneLeaf } = mod.exports;

  const manual = (paneId, runtime, agentRunning = true) => ({
    kind: "leaf",
    paneId,
    worker: { runtime, runId: "manual", workerTaskId: `manual-${paneId}`, attemptId: paneId, source: "manual", state: "running", agentRunning },
  });
  const spark = (paneId, runtime, runId, attemptId) => ({
    kind: "leaf",
    paneId,
    worker: { runtime, runId, workerTaskId: "task-1", attemptId, source: "spark", state: "running" },
  });
  const shell = (paneId) => ({ kind: "leaf", paneId });
  const dock = (paneId, tabId) => ({ kind: "leaf", paneId, content: { type: "tab", tabId, tabKind: "preview" } });
  const split = (a, b) => ({ kind: "split", direction: "horizontal", ratio: 0.5, a, b });
  const runs = [{ id: "run-1", title: "Fix the nav" }, { id: "run-2", title: "Owner run" }];
  const tabs = [
    {
      kind: "terminal",
      id: "t1",
      title: "Terminals",
      activePaneId: "p-shell",
      root: split(split(manual("p-codex", "codex"), shell("p-shell")), split(manual("p-gone", "pi", false), dock("dock-1", "tab-1"))),
    },
    { kind: "terminal", id: "t2", title: "Agent", activePaneId: "p-unknown", root: shell("p-unknown") },
    { kind: "terminal", id: "t3", title: "Workers", activePaneId: "p-w", root: spark("p-w", "claude", "run-1", "attempt-9") },
    { kind: "preview", id: "tab-1", title: "localhost", url: "http://localhost:5173" },
  ];

  // An unrecognised agent CLI detected by main, and a full-screen program,
  // both count as agents; a plain shell and a quit agent do not.
  const state = { detected: { "p-unknown": true }, altScreen: new Set() };
  const panes = paneDestinations(tabs, runs, state, "p-shell");
  assert.deepEqual(panes.map((d) => d.paneId), ["p-codex", "p-unknown", "attempt-9", "p-shell", "p-gone"], "agents first, then shells; docked cells are never offered");
  assert.equal(panes.find((d) => d.paneId === "p-codex").label, "Codex · Terminals (pane 1)");
  assert.equal(panes.find((d) => d.paneId === "p-unknown").label, "Agent · Agent");
  assert.equal(panes.find((d) => d.paneId === "attempt-9").label, "Claude Code · Fix the nav", "a Cora worker is named by its run and addressed by its attempt");
  assert.equal(panes.find((d) => d.paneId === "p-gone").agent, false, "an agent that quit is a shell again");
  assert.equal(panes.find((d) => d.paneId === "p-gone").sublabel, "no agent detected");
  assert.equal(panes.find((d) => d.paneId === "p-shell").sublabel, "focused");
  assert.ok(panes.every((d) => d.id === `pane:${d.paneId}` && d.group === "agents"));
  assert.equal(findPaneLeaf(tabs[0].root, "dock-1").content.tabId, "tab-1");

  const focusedAgent = paneDestinations(tabs, runs, state, "p-unknown");
  assert.equal(focusedAgent[0].paneId, "p-unknown", "the focused agent leads its group");

  const chats = chatDestinations(runs, "run-1", ["run-2", "run-1", "missing"], true);
  assert.deepEqual(chats.map((d) => d.id), ["chat:run-1", "chat:run-2", "chat-new"]);
  assert.equal(chats[0].sublabel, "open");
  assert.equal(chatDestinations([], null, [], false).at(-1).disabled, true, "a new chat needs a workspace");

  const all = (focused) => [...paneDestinations(tabs, runs, state, focused), ...chats, INBOX_DESTINATION];
  assert.equal(defaultDestination(all("p-codex"), { runId: "run-2", paneId: null }, "run-1"), "pane:p-codex", "the focused agent wins");
  assert.equal(defaultDestination(all("p-shell"), { runId: null, paneId: "p-unknown" }, "run-1"), "pane:p-unknown", "then the agent that opened the tab");
  assert.equal(defaultDestination(all("p-shell"), { runId: "run-2", paneId: null }, "run-1"), "chat:run-2", "then the run that owns the tab");
  assert.equal(defaultDestination(all("p-shell"), null, "run-1"), "chat:run-1", "several agents and an open chat: the chat");
  assert.equal(defaultDestination(all("p-shell"), null, null), "pane:p-codex", "several agents and no chat: the first agent");
  const oneAgent = [...paneDestinations([tabs[1]], runs, state, null), INBOX_DESTINATION];
  assert.equal(defaultDestination(oneAgent, null, null), "pane:p-unknown", "the only agent");
  assert.equal(defaultDestination([...paneDestinations([tabs[1]], runs, { detected: {}, altScreen: new Set() }, null), INBOX_DESTINATION], null, null), "inbox", "no agent anywhere: the inbox");
  assert.equal(defaultDestination(all("p-shell"), { runId: null, paneId: "p-closed" }, null), "pane:p-codex", "an owner pane that closed is skipped");

  assert.equal(runtimeLabel("claude"), "Claude Code");
  assert.equal(runtimeLabel("opencode"), "Opencode");
  assert.equal(runtimeLabel(null), null);

  console.log("Agent destination checks passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
