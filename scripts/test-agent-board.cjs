// Unit tests for the rail's Agents view.
//
//   1. The pure board builder (src/shared/agent-board.ts): which bucket each
//      terminal agent and Cora run lands in, the order inside a bucket, the
//      Done window, the card text and the reply each card offers.
//   2. The renderer helpers (useAgentBoard.ts): which layout panes count as
//      agents, how a Cora tool call reads, and that unchanged cards keep their
//      identity across rebuilds (what keeps a busy board cheap to render).
//   3. Main's side: the terminal notifier's per-pane activity (prompt, tool,
//      question, last message) driven by real hook events and OSC 7501
//      program status, and the coalesced "changed" signal.
//   4. The new UI files keep plain words: no em or en dashes.
//
//   node scripts/test-agent-board.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "codara-agent-board-test-"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? `\n       ${JSON.stringify(detail)}` : ""}`);
  }
}

const sharedAlias = {
  name: "shared-alias",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

async function bundle(entry, name, plugins = [sharedAlias]) {
  const outfile = path.join(OUT_DIR, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins,
    logLevel: "silent",
    jsx: "automatic",
  });
  return require(outfile);
}

// ── fixtures ────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function run(overrides) {
  return {
    id: "r",
    workspaceId: "ws-a",
    title: "A chat",
    status: "running",
    createdAt: iso(NOW - 2 * HOUR),
    updatedAt: iso(NOW - 5 * MIN),
    humanMessages: [],
    workerTasks: [],
    sparkCalls: [],
    ...overrides,
  };
}

function question(id, text, at, options) {
  return {
    id,
    author: "spark",
    kind: "question",
    message: text,
    createdAt: iso(at),
    ...(options ? { questionOptions: options } : {}),
  };
}

const WORKSPACES = [
  { id: "ws-a", name: "Alpha", color: "#3366ff" },
  { id: "ws-b", name: "Beta" },
];

function activity(overrides) {
  return {
    paneId: "p",
    workspaceId: "ws-a",
    tabId: "t",
    tabTitle: "Terminal",
    runtime: "claude",
    state: "working",
    stateSince: NOW - 10 * MIN,
    sessionSince: NOW - HOUR,
    turnStartedAt: null,
    tool: null,
    prompt: null,
    message: null,
    question: null,
    accountProfileId: null,
    ...overrides,
  };
}

async function testBuilder() {
  console.log("board builder");
  const board = await bundle(path.join(SHARED_DIR, "agent-board.ts"), "agent-board");

  check("blocked terminal needs you", board.terminalAgentPlacement("blocked").bucket === "needs-you");
  check("errored terminal needs you as Stopped", board.terminalAgentPlacement("error").status === "Stopped");
  check("working terminal is working", board.terminalAgentPlacement("working").bucket === "working");
  check("stalled terminal is still working", board.terminalAgentPlacement("stalled").bucket === "working");
  check("idle terminal is done", board.terminalAgentPlacement("idle").bucket === "done");
  check("launching terminal shows as starting", board.terminalAgentPlacement("launching").status === "Starting");

  check("elapsed under a minute reads now", board.formatAgentElapsed(30_000) === "now");
  check("elapsed minutes", board.formatAgentElapsed(4 * MIN + 10_000) === "4m");
  check("elapsed hours and minutes", board.formatAgentElapsed(2 * HOUR + 5 * MIN) === "2h 5m");
  check("elapsed whole hours", board.formatAgentElapsed(3 * HOUR) === "3h");
  check("elapsed days", board.formatAgentElapsed(50 * HOUR) === "2d");
  check(
    "a message becomes one plain line",
    board.agentBoardLine("**Done.** Fixed `parse()`.\n\n```ts\nconst x = 1;\n```\n- [docs](https://x.y)") ===
      "Done. Fixed parse(). docs",
  );
  check("a long line is cut with an ellipsis", board.agentBoardLine("x".repeat(500), 20).length === 20);
  check("an empty message is no line", board.agentBoardLine("  \n ") === null);

  const options = [
    { id: "o1", label: "Ship it", description: "", answer: "Ship it", recommended: true },
    { id: "o2", label: "Wait", description: "", answer: "Wait" },
  ];
  const runs = [
    run({
      id: "r-blocked",
      status: "blocked",
      title: "Pick a database",
      humanMessages: [question("q1", "Postgres or SQLite?", NOW - 30 * MIN, options)],
    }),
    run({
      id: "r-running",
      workspaceId: "ws-b",
      status: "running",
      title: "Refactor auth",
      chatAccountProfileId: "pi-work",
      sparkCalls: [{ id: "c1", status: "started", createdAt: iso(NOW - 3 * MIN) }],
      workerTasks: [{ id: "w1", status: "running" }, { id: "w2", status: "done" }],
    }),
    run({ id: "r-unseen-old", status: "complete", seen: false, completedAt: iso(NOW - 72 * HOUR), updatedAt: iso(NOW - 72 * HOUR) }),
    run({ id: "r-seen-old", status: "complete", seen: true, completedAt: iso(NOW - 72 * HOUR), updatedAt: iso(NOW - 72 * HOUR) }),
    run({
      id: "r-seen-recent",
      status: "complete",
      seen: true,
      completedAt: iso(NOW - HOUR),
      humanMessages: [
        { id: "m1", author: "spark", kind: "note", message: "First reply", createdAt: iso(NOW - 2 * HOUR) },
        { id: "m2", author: "spark", kind: "note", message: "## All done\nThe **tests** pass.", createdAt: iso(NOW - HOUR) },
      ],
    }),
    run({ id: "r-failed-recent", status: "failed", completedAt: iso(NOW - 2 * HOUR) }),
    run({ id: "r-failed-old", status: "failed", completedAt: iso(NOW - 48 * HOUR), updatedAt: iso(NOW - 48 * HOUR) }),
    run({ id: "r-loom-running", status: "running", automationId: "job-1" }),
    run({ id: "r-loom-done", status: "complete", automationId: "job-1", completedAt: iso(NOW - MIN) }),
    run({ id: "r-board-card", status: "running", boardCardId: "card-1" }),
    run({
      id: "r-backend-park",
      status: "blocked",
      blockedOn: { questionMessageId: "q9", backendFailure: true },
      humanMessages: [question("q9", "The Cora manager backend could not complete the turn.", NOW - 20 * MIN)],
    }),
    run({ id: "r-paused", status: "paused", updatedAt: iso(NOW - 50 * MIN) }),
    run({ id: "r-gone-ws", workspaceId: "ws-removed", status: "blocked" }),
  ];

  const layoutPanes = [
    { paneId: "p-blocked", workspaceId: "ws-a", tabId: "t1", tabTitle: "Claude 1", runtime: "claude", state: "blocked", accountProfileId: "claude-work" },
    { paneId: "p-working", workspaceId: "ws-b", tabId: "t2", tabTitle: "Codex", runtime: "codex", state: "working" },
    { paneId: "p-idle", workspaceId: "ws-a", tabId: "t3", tabTitle: "Grok", runtime: "grok", state: "idle" },
    { paneId: "p-moved", workspaceId: "ws-b", tabId: "t9", tabTitle: "Moved", runtime: "claude", state: "working" },
  ];
  const activities = [
    activity({
      paneId: "p-blocked",
      tabId: "t1",
      state: "blocked",
      stateSince: NOW - 45 * MIN,
      question: "Allow Bash: rm -rf build?",
      tool: "Bash: rm -rf build",
      prompt: "clean the build",
    }),
    activity({
      paneId: "p-working",
      workspaceId: "ws-b",
      runtime: "codex",
      state: "working",
      turnStartedAt: NOW - 2 * MIN,
      tool: "Edit: src/a.ts",
      prompt: "fix the parser",
      message: "Earlier answer",
    }),
    activity({ paneId: "p-idle", runtime: "grok", state: "idle", stateSince: NOW - 20 * MIN, message: "All **tests** pass." }),
    // Main still has the pane in ws-a; the layout already moved it to ws-b.
    activity({ paneId: "p-moved", workspaceId: "ws-a", state: "working", turnStartedAt: NOW - MIN }),
    // A Claude typed at a plain prompt: no chip in the layouts, main sees it.
    activity({ paneId: "p-plain", tabId: "t5", tabTitle: "zsh", state: "working", turnStartedAt: NOW - 8 * MIN }),
    activity({ paneId: "p-elsewhere", workspaceId: "ws-removed", state: "blocked" }),
  ];

  const model = board.buildAgentBoard({
    now: NOW,
    workspaces: WORKSPACES,
    layoutPanes,
    activity: activities,
    runs,
    runLive: { "r-running": { tool: "Bash: npm test", text: "Running the suite now." } },
    unseenPanes: { "p-idle": "complete" },
    accountLabels: { "claude-work": "Work", "pi-work": "Team plan" },
  });
  const keys = (cards) => cards.map((card) => card.key);
  const find = (key) => [...model.needsYou, ...model.working, ...model.done].find((card) => card.key === key);

  check(
    "needs you holds the blocked pane, the open question and the paused chat, longest wait first",
    JSON.stringify(keys(model.needsYou)) === JSON.stringify(["run:r-paused", "pane:p-blocked", "run:r-blocked"]),
    keys(model.needsYou),
  );
  check(
    "working holds the running chat, Loom pass, board card and terminals, latest start first",
    JSON.stringify(keys(model.working)) ===
      JSON.stringify(["pane:p-moved", "pane:p-working", "run:r-running", "run:r-board-card", "run:r-loom-running", "pane:p-plain"]),
    keys(model.working),
  );
  check(
    "done puts unseen first, then the latest",
    JSON.stringify(keys(model.done)) ===
      JSON.stringify(["pane:p-idle", "run:r-unseen-old", "run:r-backend-park", "run:r-seen-recent", "run:r-failed-recent"]),
    keys(model.done),
  );
  check("total counts every card", model.total === model.needsYou.length + model.working.length + model.done.length);
  check("a seen run finished days ago drops off", !find("run:r-seen-old"));
  check("a failed run outside the window drops off", !find("run:r-failed-old"));
  check("a finished Loom pass stays in the Automations hub", !find("run:r-loom-done"));
  check("cards of a removed workspace are left out", !find("run:r-gone-ws") && !find("pane:p-elsewhere"));

  const blocked = find("pane:p-blocked");
  check("a blocked pane shows its question", blocked.message === "Allow Bash: rm -rf build?");
  check("a blocked pane shows the tool it asks to run", blocked.tool === "Bash: rm -rf build");
  check("a pane card is titled by the user's prompt", blocked.title === "clean the build");
  check("a pane card names its account", blocked.account === "Work");
  check("a pane card names the agent", blocked.agentLabel === "Claude Code");
  check("a pane card carries the workspace", blocked.workspaceName === "Alpha" && blocked.workspaceColor === "#3366ff");
  // Its prompt is a menu: pasted text and Enter would pick the highlighted
  // answer (usually Yes), so the card opens the pane instead of pasting.
  check(
    "a blocked pane is answered in its pane, never pasted into",
    blocked.reply && blocked.reply.kind === "pane-dialog" && blocked.reply.paneId === "p-blocked",
    blocked.reply,
  );
  const stopped = board.buildAgentBoard({
    now: NOW,
    workspaces: WORKSPACES,
    layoutPanes: [],
    activity: [activity({ paneId: "p-error", state: "error", message: "Rate limited." })],
    runs: [],
  }).needsYou[0];
  check(
    "a pane stopped by an error is back at its prompt and takes a pasted reply",
    stopped && stopped.status === "Stopped" && stopped.reply && stopped.reply.kind === "pane" && stopped.reply.paneId === "p-error",
    stopped,
  );
  check("a stopped pane says why", stopped && stopped.message === "Rate limited.");
  check(
    "a pane card opens its terminal",
    blocked.target.type === "terminal" && blocked.target.paneId === "p-blocked" && blocked.target.tabId === "t1",
  );
  check("needs you measures from when it started waiting", blocked.since === NOW - 45 * MIN);

  const working = find("pane:p-working");
  check("working measures from the turn start", working.since === NOW - 2 * MIN);
  check("working shows the current tool", working.tool === "Edit: src/a.ts");
  check("a working card has no reply box", working.reply === null);
  const moved = find("pane:p-moved");
  check("the layout decides where a moved pane lives", moved.workspaceId === "ws-b" && moved.target.workspaceId === "ws-b");
  const plain = find("pane:p-plain");
  check("a pane only main knows about is still on the board", plain && plain.workspaceId === "ws-a" && plain.title === "zsh");

  const idle = find("pane:p-idle");
  check("an unseen finished pane says Finished", idle.status === "Finished" && idle.unseen === true);
  check("a finished pane shows its last message in plain words", idle.message === "All tests pass.");
  check("a finished pane shows no tool", idle.tool === null);

  const coraQuestion = find("run:r-blocked");
  check("a Cora question offers its options", coraQuestion.reply.kind === "question" && coraQuestion.reply.options.length === 2);
  check("a Cora question replies to that question", coraQuestion.reply.questionMessageId === "q1");
  check("a Cora question shows the question", coraQuestion.message === "Postgres or SQLite?");
  check("a Cora question measures from when it was asked", coraQuestion.since === NOW - 30 * MIN);
  check("a Cora card opens its chat", coraQuestion.target.type === "run" && coraQuestion.target.runId === "r-blocked");
  check("a Cora card is Cora", coraQuestion.runtime === "cora" && coraQuestion.agentLabel === "Cora");

  const paused = find("run:r-paused");
  check("a paused chat takes a message", paused.reply.kind === "message" && paused.status === "Paused");

  const running = find("run:r-running");
  check("a running chat shows the live tool", running.tool === "Bash: npm test");
  check("a running chat shows the live text", running.message === "Running the suite now.");
  check("a running chat names its account", running.account === "Team plan");
  check("a running chat counts its running workers", running.detail === "1 worker running");
  check("a running chat measures from the current call", running.since === NOW - 3 * MIN);

  const loom = find("run:r-loom-running");
  check("a Loom pass opens in the Automations hub", loom.target.type === "automation" && loom.target.jobId === "job-1");
  check("a Loom pass says it is an automation", loom.detail === "Automation");
  check("a board card run opens as a chat", find("run:r-board-card").target.type === "run");

  const park = find("run:r-backend-park");
  check("a backend failure park is a failed turn, not a question", park.bucket === "done" && park.status === "Turn failed");
  check("a failed turn offers no reply", park.reply === null);

  const recent = find("run:r-seen-recent");
  check("a finished chat shows Cora's last message", recent.message === "All done The tests pass.", recent.message);
  check("an unseen finished chat is unseen", find("run:r-unseen-old").unseen === true);

  const empty = board.buildAgentBoard({ now: NOW, workspaces: WORKSPACES, layoutPanes: [], activity: null, runs: [] });
  check("no agents, empty board", empty.total === 0 && empty.needsYou.length === 0);

  const closed = board.buildAgentBoard({ now: NOW, workspaces: WORKSPACES, layoutPanes, activity: null, runs: [] });
  check("before main answers, layout chips still place panes", closed.needsYou.length === 1 && closed.working.length === 2);
  check("before main answers, a blocked pane still has a message", closed.needsYou[0].message === "Waiting for your answer.");

  return board;
}

async function testRendererHelpers(board) {
  console.log("renderer helpers");
  const helpers = await bundle(
    path.join(ROOT, "src", "renderer", "src", "components", "agent-board", "useAgentBoard.ts"),
    "use-agent-board",
  );
  const leaf = (paneId, worker, extra = {}) => ({ kind: "leaf", paneId, worker, ...extra });
  const manual = (runtime, runtimeState = "working") => ({
    runtime,
    runId: "manual",
    workerTaskId: `manual-x`,
    attemptId: "x",
    source: "manual",
    state: "running",
    agentRunning: true,
    runtimeState,
  });
  const layouts = [
    {
      workspaceId: "ws-a",
      tabs: [
        {
          id: "t1",
          kind: "terminal",
          title: "Split",
          activePaneId: "a1",
          root: {
            kind: "split",
            direction: "row",
            ratio: 0.5,
            a: leaf("a1", manual("claude", "blocked"), { agentSession: { runtime: "claude", nativeClaudeProfileId: "claude-work" } }),
            b: leaf("a2", null),
          },
        },
        { id: "t2", kind: "terminal", title: "Worker", activePaneId: "a3", root: leaf("a3", { ...manual("codex"), source: "spark" }) },
        {
          id: "t3",
          kind: "terminal",
          title: "Workers",
          activePaneId: "a4",
          scope: { kind: "workers", runId: "r1" },
          root: leaf("a4", manual("claude")),
        },
        { id: "t4", kind: "terminal", title: "Gone", activePaneId: "a5", root: leaf("a5", { ...manual("claude"), agentRunning: false }) },
        { id: "t5", kind: "chat", title: "Chat" },
      ],
    },
    { workspaceId: "ws-b", tabs: [{ id: "t6", kind: "terminal", title: "Grok", activePaneId: "b1", root: leaf("b1", manual("grok", "idle")) }] },
  ];
  const panes = helpers.layoutAgentPanes(layouts);
  check(
    "only live user agent panes count",
    JSON.stringify(panes.map((pane) => pane.paneId)) === JSON.stringify(["a1", "b1"]),
    panes.map((pane) => pane.paneId),
  );
  check("a pane keeps its tab, state and account", panes[0].tabId === "t1" && panes[0].state === "blocked" && panes[0].accountProfileId === "claude-work");
  check("a pane in another workspace keeps its workspace", panes[1].workspaceId === "ws-b" && panes[1].runtime === "grok");

  // Agent hibernation: a sleeping pane has no live chip, but still counts,
  // under Done, as the agent its leaf names.
  const sleptAt = NOW - 40 * MIN;
  const sleepingLayouts = [
    {
      workspaceId: "ws-b",
      tabs: [
        {
          id: "t7",
          kind: "terminal",
          title: "Codex",
          activePaneId: "s1",
          root: leaf("s1", null, { hibernation: { runtime: "codex", sleptAt } }),
        },
      ],
    },
  ];
  const sleepingPanes = helpers.layoutAgentPanes(sleepingLayouts);
  check(
    "a sleeping pane counts as its agent without a live chip",
    sleepingPanes.length === 1 && sleepingPanes[0].runtime === "codex" && sleepingPanes[0].sleepingSince === sleptAt,
    sleepingPanes,
  );
  const sleepingBoard = board.buildAgentBoard({
    now: NOW,
    workspaces: WORKSPACES,
    layoutPanes: sleepingPanes,
    // Main still reports the state it saw before Codara stopped the agent.
    activity: [activity({ paneId: "s1", workspaceId: "ws-b", tabId: "t7", runtime: "codex", state: "working" })],
    runs: [],
  });
  const sleepingCard = sleepingBoard.done.find((card) => card.key === "pane:s1");
  check("a sleeping agent sits under Done, whatever main last saw", Boolean(sleepingCard) && sleepingBoard.working.length === 0);
  check(
    "a sleeping card says so, quietly, with no reply",
    sleepingCard?.sleeping === true && sleepingCard.status === "Sleeping" && sleepingCard.tone === "muted" && sleepingCard.reply === null,
    sleepingCard,
  );
  check("a sleeping card counts from when it fell asleep", sleepingCard?.since === sleptAt);
  check("opening a sleeping card goes to its pane", sleepingCard?.target.type === "terminal" && sleepingCard.target.paneId === "s1");

  check("a Cora tool reads name and target", helpers.describeCoraTool("Bash", { command: "npm test" }) === "Bash: npm test");
  check("an MCP tool loses its server prefix", helpers.describeCoraTool("mcp__codara-studio__codara_terminal_run", {}) === "terminal_run");
  check("a file tool shows its path", helpers.describeCoraTool("Read", { file_path: "/x/y.ts" }) === "Read: /x/y.ts");
  check("no tool name, no tool", helpers.describeCoraTool(undefined, {}) === null);

  const input = {
    now: NOW,
    workspaces: WORKSPACES,
    layoutPanes: [
      { paneId: "a1", workspaceId: "ws-a", tabId: "t1", tabTitle: "One", runtime: "claude", state: "working" },
      { paneId: "a2", workspaceId: "ws-a", tabId: "t1", tabTitle: "Two", runtime: "codex", state: "working" },
    ],
    activity: null,
    runs: [],
  };
  const cache = new Map();
  const first = helpers.stabilizeAgentBoard(board.buildAgentBoard(input), cache);
  const second = helpers.stabilizeAgentBoard(board.buildAgentBoard(input), cache);
  check("an unchanged card keeps its identity across rebuilds", first.working[0] === second.working[0] && first.working[1] === second.working[1]);
  const changed = helpers.stabilizeAgentBoard(
    board.buildAgentBoard({ ...input, layoutPanes: [{ ...input.layoutPanes[0], state: "blocked" }, input.layoutPanes[1]] }),
    cache,
  );
  check("a changed card is a new object", changed.needsYou[0] !== first.working.find((card) => card.key === "pane:a1"));
  check("its unchanged neighbour is not", changed.working[0] === first.working.find((card) => card.key === "pane:a2"));
  check("the cache forgets cards that left", cache.size === 2);
}

async function testRailView() {
  console.log("rail view memory");
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
  };
  const first = await bundle(path.join(ROOT, "src", "renderer", "src", "components", "agent-board", "railView.ts"), "rail-view-1");
  check("the rail opens on Workspaces by default", first.getRailView() === "workspaces");
  first.setRailView("agents");
  check("choosing Agents is remembered", store.get(first.RAIL_VIEW_STORAGE_KEY) === "agents");
  const second = await bundle(path.join(ROOT, "src", "renderer", "src", "components", "agent-board", "railView.ts"), "rail-view-2");
  check("a restart opens on the remembered view", second.getRailView() === "agents");
  globalThis.window = {
    localStorage: {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    },
  };
  const third = await bundle(path.join(ROOT, "src", "renderer", "src", "components", "agent-board", "railView.ts"), "rail-view-3");
  check("blocked storage falls back to Workspaces", third.getRailView() === "workspaces");
  third.setRailView("agents");
  check("blocked storage still switches for the session", third.getRailView() === "agents");
  delete globalThis.window;
}

async function testSignal() {
  console.log("changed signal");
  const signal = await bundle(path.join(ROOT, "src", "main", "agent-board-signal.ts"), "agent-board-signal");
  let calls = 0;
  signal.onAgentBoardChanged(() => {
    calls += 1;
  });
  for (let i = 0; i < 20; i += 1) signal.signalAgentBoardChanged();
  check("a burst is not sent at once", calls === 0);
  await sleep(signal.AGENT_BOARD_SIGNAL_WINDOW_MS + 100);
  check("a burst of changes is one ping", calls === 1);
  signal.signalAgentBoardChanged();
  await sleep(signal.AGENT_BOARD_SIGNAL_WINDOW_MS + 100);
  check("a later change is another ping", calls === 2);
  signal.onAgentBoardChanged(null);
  signal.signalAgentBoardChanged();
  await sleep(signal.AGENT_BOARD_SIGNAL_WINDOW_MS + 100);
  check("no listener, no ping", calls === 2);
  let heard = 0;
  const off = signal.subscribeAgentBoardChanged(() => {
    heard += 1;
  });
  signal.signalAgentBoardChanged();
  signal.signalAgentBoardChanged();
  await sleep(signal.AGENT_BOARD_SIGNAL_WINDOW_MS + 100);
  check("a subscriber hears one ping without the view's listener", heard === 1 && calls === 2);
  off();
  signal.signalAgentBoardChanged();
  await sleep(signal.AGENT_BOARD_SIGNAL_WINDOW_MS + 100);
  check("an unsubscribed reader hears nothing", heard === 1);
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
      const init = "globalThis.__AB ??= { taps: new Map(), exits: new Map(), alerts: [], chips: [], signals: 0 };\n";
      const stubs = {
        electron: "export const BrowserWindow = { getFocusedWindow: () => null };\n",
        "./agent-session-registry": "export function latestSessionStart(){ return null; }\n",
        "./orchestration/usage-activity-refresh": "export function nudgeUsageRefresh() {}\n",
        "./owned-process-tree":
          "export function descendantsStartedAfter(){ return []; }\n" +
          "export function aliveProcesses(){ return []; }\n" +
          "export async function descendantProcessesWithCommands(){ return null; }\n",
        "./agent-board-signal": "export function signalAgentBoardChanged(){ globalThis.__AB.signals += 1; }\n",
        "./pty-manager":
          "export function hasSession(){ return true; }\n" +
          "export function sessionAgentFlagsReachCli(){ return true; }\n" +
          "export function tap(id, h){ globalThis.__AB.taps.set(id, h); return () => globalThis.__AB.taps.delete(id); }\n" +
          "export function onExit(id, h){ globalThis.__AB.exits.set(id, h); return () => globalThis.__AB.exits.delete(id); }\n" +
          "export function readTailChunks(){ return []; }\n" +
          "export function sessionPid(){ return null; }\n" +
          "export function sessionDimensions(){ return null; }\n" +
          "export function waitForSpawn(){ return Promise.resolve(true); }\n" +
          "export function write(){}\n",
        "./notify":
          "export const paneSourceKey = (paneId) => `pane:${paneId}`;\n" +
          "export function rearm(){}\n" +
          "export function emitTerminalAgentState(payload){ globalThis.__AB.chips.push(payload); }\n" +
          "export function publish(event){ globalThis.__AB.alerts.push(event); }\n",
      };
      return { contents: init + stubs[args.path], loader: "js" };
    });
  },
};

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

async function testNotifierActivity() {
  console.log("terminal notifier activity");
  const mod = await bundle(path.join(ROOT, "src", "main", "terminal-agent-notify.ts"), "terminal-agent-notify", [notifierStubs]);
  const T = globalThis.__AB;
  const feed = (paneId, text) => T.taps.get(paneId)(Buffer.from(text, "utf8"));
  const pane = (paneId) => mod.terminalAgentActivitySnapshot().find((entry) => entry.paneId === paneId);

  mod.syncTerminalNotifyPanes({
    workspaceId: "ws-a",
    workspaceName: "Alpha",
    panes: [
      { paneId: "h1", tabId: "t1", tabTitle: "Claude hooks", excluded: false },
      { paneId: "s1", tabId: "t2", tabTitle: "Status", excluded: false },
      { paneId: "w1", tabId: "t3", tabTitle: "workers", excluded: true },
      { paneId: "sh", tabId: "t4", tabTitle: "shell", excluded: false },
    ],
  });
  await sleep(30);
  feed("sh", "$ ls\r\nREADME.md\r\n$ ");
  check("a plain shell is not an agent", pane("sh") === undefined);

  // Claude with hooks: prompt, tool, permission prompt, finish.
  const session = { session_id: "11111111-aaaa" };
  feed("h1", "\x1b]633;E;claude\x07Claude Code v2.1.296\r\n");
  mod.noteTerminalHookEvent("h1", "SessionStart", { ...session, source: "startup" });
  check("a launched agent is on the board", pane("h1")?.runtime === "claude");
  const signalsBefore = T.signals;
  mod.noteTerminalUserInput("h1", "deploy it\r");
  mod.noteTerminalHookEvent("h1", "UserPromptSubmit", { ...session, prompt: "deploy it\nto production" });
  feed("h1", "✻ Pondering… (1s · ↓ 3 tokens)");
  mod.noteTerminalHookEvent("h1", "PreToolUse", { ...session, tool_name: "Bash", tool_input: { command: "./deploy.sh --prod" } });
  check("activity changes signal the board", T.signals > signalsBefore);
  let entry = pane("h1");
  check("the prompt is recorded as one line", entry?.prompt === "deploy it to production", entry?.prompt);
  check("the running tool is recorded", entry?.tool === "Bash: ./deploy.sh --prod", entry?.tool);
  check("a turn in progress has a start", typeof entry?.turnStartedAt === "number" && entry.turnStartedAt > 0);
  check("the pane is working", entry?.state === "working", entry?.state);
  feed("h1", "\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n");
  entry = pane("h1");
  check("a permission dialog blocks the pane", entry?.state === "blocked", entry?.state);
  check("a blocked pane carries what it waits on", typeof entry?.question === "string" && entry.question.length > 0, entry?.question);
  check("a blocked pane keeps the tool it asks to run", entry?.tool === "Bash: ./deploy.sh --prod");
  mod.noteTerminalUserInput("h1", "1");
  mod.noteTerminalHookEvent("h1", "PostToolUse", { ...session, tool_name: "Bash" });
  entry = pane("h1");
  check("a tool that finished is no longer the current tool", entry?.tool === null, entry);
  mod.noteTerminalHookEvent("h1", "PreToolUse", { ...session, tool_name: "Read", tool_input: { file_path: "a.ts" } });
  mod.noteTerminalHookEvent("h1", "PreToolUse", { ...session, tool_name: "Read", tool_input: { file_path: "b.ts" } });
  mod.noteTerminalHookEvent("h1", "PostToolUse", { ...session, tool_name: "Read" });
  check("a tool still running stays the current tool", pane("h1")?.tool === "Read: b.ts", pane("h1")?.tool);
  mod.noteTerminalHookEvent("h1", "PostToolUse", { ...session, tool_name: "Read" });
  check("the last tool call done, no current tool", pane("h1")?.tool === null, pane("h1")?.tool);
  mod.noteTerminalHookEvent("h1", "Stop", { ...session, last_assistant_message: "**Deployed** to eu-west.", background_tasks: [] });
  await sleep(1300);
  entry = pane("h1");
  check("a finished pane is idle", entry?.state === "idle", entry?.state);
  check("a finished pane keeps the last message", entry?.message === "Deployed to eu-west." || /Deployed/.test(entry?.message ?? ""), entry?.message);
  check("a finished pane shows no tool", entry?.tool === null);
  check("a finished pane has no open question", entry?.question === null);
  check("a finished turn has no start", entry?.turnStartedAt === null);
  mod.noteTerminalUserInput("h1", "next\r");
  mod.noteTerminalHookEvent("h1", "UserPromptSubmit", { ...session, prompt: "next" });
  check("a new prompt replaces the old one", pane("h1")?.prompt === "next");

  // The first account of a prompt is the specific one: the hook's question
  // text, not the screen's "Permission for AskUserQuestion" painted after it
  // or the generic notification that follows.
  const menu = "\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n";
  mod.noteTerminalHookEvent("h1", "PreToolUse", {
    ...session,
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Which region goes first?" }] },
  });
  feed("h1", menu);
  check("a painted prompt keeps the question it asks", pane("h1")?.question === "Which region goes first?", pane("h1")?.question);
  mod.noteTerminalHookEvent("h1", "Notification", {
    ...session,
    notification_type: "permission_prompt",
    message: "Claude needs your permission",
  });
  check("a later notification of the same prompt keeps the question", pane("h1")?.question === "Which region goes first?", pane("h1")?.question);
  const signalsAtPrompt = T.signals;
  feed("h1", menu);
  feed("h1", menu);
  check("a repainted prompt does not ping the board again", T.signals === signalsAtPrompt, T.signals - signalsAtPrompt);
  mod.noteTerminalUserInput("h1", "1");
  mod.noteTerminalHookEvent("h1", "PostToolUse", { ...session, tool_name: "AskUserQuestion" });
  check("an answered prompt leaves no question", pane("h1")?.question === null, pane("h1"));
  mod.noteTerminalHookEvent("h1", "PreToolUse", { ...session, tool_name: "Bash", tool_input: { command: "rm -rf build" } });
  feed("h1", menu);
  check("the next prompt brings its own question", /rm -rf build/.test(pane("h1")?.question ?? ""), pane("h1")?.question);
  mod.noteTerminalUserInput("h1", "1");
  mod.noteTerminalHookEvent("h1", "PostToolUse", { ...session, tool_name: "Bash" });
  // A hard failure banner is what the card says, not the last good message.
  feed("h1", "\r\n⚠ Credit balance is too low\r\n");
  entry = pane("h1");
  check("a failure banner stops the pane", entry?.state === "error", entry?.state);
  check("a stopped pane says why, not its last good message", /Credit balance/.test(entry?.message ?? ""), entry?.message);
  mod.noteTerminalUserInput("h1", "again\r");
  mod.noteTerminalHookEvent("h1", "UserPromptSubmit", { ...session, prompt: "again" });
  mod.noteTerminalHookEvent("h1", "StopFailure", { ...session, error: "overloaded_error" });
  check("a turn that failed says so", /overloaded_error/.test(pane("h1")?.message ?? ""), pane("h1")?.message);
  // A background task reporting back starts with no tool running, not the
  // one the last turn was in when it ended.
  mod.noteTerminalUserInput("h1", "run the tests\r");
  mod.noteTerminalHookEvent("h1", "UserPromptSubmit", { ...session, prompt: "run the tests" });
  mod.noteTerminalHookEvent("h1", "PreToolUse", { ...session, tool_name: "Bash", tool_input: { command: "npm test" } });
  check("a tool call in flight is the current tool", pane("h1")?.tool === "Bash: npm test", pane("h1")?.tool);
  mod.noteTerminalHookEvent("h1", "UserPromptSubmit", {
    ...session,
    prompt: "<task-notification>tests finished</task-notification>",
  });
  entry = pane("h1");
  check("a follow-up works without the last turn's tool", entry?.state === "working" && entry?.tool === null, entry);
  check("a follow-up keeps the user's prompt as the title", entry?.prompt === "run the tests", entry?.prompt);

  // OSC 7501 program status, no hooks.
  feed("s1", "\x1b]633;E;claude\x07");
  feed("s1", "\x1b]7501;app=claude:state=working\x07");
  check("program status working", pane("s1")?.state === "working", pane("s1")?.state);
  const since = pane("s1")?.stateSince;
  await sleep(20);
  feed("s1", `\x1b]7501;app=claude:state=blocked:kind=question:msg=${b64("Which region?")}\x07`);
  entry = pane("s1");
  check("program status blocked carries the question", entry?.state === "blocked" && entry.question === "Which region?", entry);
  check("a state change moves the state clock", entry?.stateSince > since);
  feed("s1", "\x1b]7501;app=claude:state=working\x07");
  check("answered, the question is gone", pane("s1")?.question === null);
  feed("s1", `\x1b]7501;app=claude:state=done:msg=${b64("Picked eu-west.")}\x07`);
  check("program status done keeps the message", pane("s1")?.message === "Picked eu-west.", pane("s1")?.message);
  feed("s1", `\x1b]7501;app=claude:state=error:msg=${b64("Rate limited.")}\x07`);
  check("program status error keeps why", pane("s1")?.state === "error" && pane("s1")?.message === "Rate limited.", pane("s1"));
  feed("s1", `\x1b]7501;app=claude:state=done:msg=${b64("All green.")}\x07`);
  feed("s1", "\x1b]7501;app=claude:state=error\x07");
  check("an error without a reason drops the last good message", pane("s1")?.state === "error" && pane("s1")?.message === null, pane("s1"));

  check("Cora worker panes stay off the board", pane("w1") === undefined);
  check("main leaves the account to agent-board.ts", pane("h1")?.accountProfileId === null);
  check("every entry names its workspace and tab", pane("h1")?.workspaceId === "ws-a" && pane("h1")?.tabId === "t1");

  // A closed agent pane must leave the board (and the switch's Needs you
  // count) at once, not on the next safety refresh.
  let signalsBeforeClose = T.signals;
  mod.noteTerminalWillDispose("s1");
  check("an agent pane about to close leaves the board", pane("s1") === undefined);
  check("an agent pane about to close pings the board", T.signals > signalsBeforeClose);
  signalsBeforeClose = T.signals;
  mod.syncTerminalNotifyPanes({
    workspaceId: "ws-a",
    workspaceName: "Alpha",
    panes: [
      { paneId: "h1", tabId: "t1", tabTitle: "Claude hooks", excluded: false },
      { paneId: "w1", tabId: "t3", tabTitle: "workers", excluded: true },
      { paneId: "sh", tabId: "t4", tabTitle: "shell", excluded: false },
    ],
  });
  check("a closed agent pane pings the board", T.signals > signalsBeforeClose);
  signalsBeforeClose = T.signals;
  mod.syncTerminalNotifyPanes({
    workspaceId: "ws-a",
    workspaceName: "Alpha",
    panes: [
      { paneId: "h1", tabId: "t1", tabTitle: "Claude hooks", excluded: false },
      { paneId: "w1", tabId: "t3", tabTitle: "workers", excluded: true },
    ],
  });
  check("a closed plain shell does not ping the board", T.signals === signalsBeforeClose);
  mod.disposeAllTerminalAgentWatchers();
  check("disposed panes leave the board", mod.terminalAgentActivitySnapshot().length === 0);
}

function testPlainWords() {
  console.log("plain words");
  const dir = path.join(ROOT, "src", "renderer", "src", "components", "agent-board");
  const files = fs.readdirSync(dir).map((name) => path.join(dir, name));
  files.push(path.join(SHARED_DIR, "agent-board.ts"));
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    check(`${path.relative(ROOT, file)} has no em or en dash`, !/[–—]/.test(text));
  }
}

async function main() {
  const board = await testBuilder();
  await testRendererHelpers(board);
  await testRailView();
  await testSignal();
  await testNotifierActivity();
  testPlainWords();
  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  if (fail > 0) process.exit(1);
  // The notifier keeps sweep timers alive; the verdict is in.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
