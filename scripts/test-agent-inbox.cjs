// Unit tests for the Agents tab as an inbox (src/shared/agent-inbox.ts):
//
//   1. Grouping: the sections in their order (Needs you, Working, Done,
//      Settled), pinned first, the status word and the age, read titles, the
//      agent mark only for a non-default agent, +/- only on a finished pull
//      request, Merge only when ready.
//   2. Sections over time: a settled agent comes back when it acts.
//   3. Snooze is gone: nothing exports it, and stored prefs that still carry
//      a `snoozed` map load, show those agents in their normal section and
//      drop the map on the next save.
//   4. A merged pull request settles finished agents once, never twice, and
//      never a pinned or working one.
//   5. Undo puts a key back as it was, and an undone auto-settle stays put.
//   6. Stored prefs are cleaned on load; merge asks first into main.
//   7. Subagents: a background agent whose parent is on the board sits behind
//      a count chip on the parent's row, not as a row; an orphan stays a row,
//      and every section counts main agents only.
//
//   node scripts/test-agent-inbox.cjs

process.env.TZ = "UTC";

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "codara-agent-inbox-test-"));

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

async function load() {
  const outfile = path.join(OUT_DIR, "agent-inbox.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "shared", "agent-inbox.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  return require(outfile);
}

// Thursday 2026-10-29 15:00 UTC.
const NOW = Date.parse("2026-10-29T15:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

function card(key, overrides = {}) {
  return {
    key,
    source: key.startsWith("run:") ? "cora" : "terminal",
    bucket: "done",
    status: "Ready",
    tone: "ok",
    workspaceId: "ws-a",
    workspaceName: "alpha",
    workspaceColor: "#34D3C3",
    workspaceIcon: null,
    runtime: "claude",
    agentLabel: "Claude Code",
    account: null,
    title: `title ${key}`,
    tabTitle: null,
    message: null,
    tool: null,
    detail: null,
    since: NOW - 10 * MIN,
    unseen: false,
    sleeping: false,
    target: { type: "terminal", workspaceId: "ws-a", tabId: "t", paneId: key },
    reply: null,
    ...overrides,
  };
}

function model(cards) {
  return {
    needsYou: cards.filter((c) => c.bucket === "needs-you"),
    working: cards.filter((c) => c.bucket === "working"),
    done: cards.filter((c) => c.bucket === "done"),
    total: cards.length,
  };
}

function pr(overrides = {}) {
  return {
    workspaceId: "ws-a",
    repository: "codara-solutions/codara-studio",
    number: 61,
    url: "https://github.com/Codara-Solutions/codara-studio/pull/61",
    title: "Usage panel",
    phase: "open",
    checks: "passing",
    failed: [],
    headOid: "abc",
    ...overrides,
  };
}

const keys = (rows) => rows.map((row) => row.key);
const SECTIONS = ["needs", "working", "done", "settled"];
// What sat in the old unlabelled list on top, now two headed sections.
const top = (view) => [...view.needs, ...view.done];

function testGrouping(I) {
  console.log("grouping");
  const cards = [
    card("pane:ask", { bucket: "needs-you", status: "Needs you", tone: "warn", since: NOW - 2 * MIN }),
    card("pane:stopped", { bucket: "needs-you", status: "Stopped", tone: "danger", since: NOW - 5 * MIN, workspaceId: "ws-b" }),
    card("pane:fresh", { unseen: true, status: "Finished", since: NOW - 6 * MIN }),
    card("pane:old", { since: NOW - 3 * HOUR - 20 * MIN, runtime: "codex", workspaceId: "ws-c" }),
    card("pane:busy", { bucket: "working", status: "Working", tone: "info", since: NOW - 18 * MIN }),
    card("run:plan", { bucket: "working", status: "Planning", tone: "info", since: NOW - MIN / 2, runtime: "cora" }),
    card("pane:settled", {}),
  ];
  const prefs = I.emptyAgentInboxPrefs();
  prefs.settled["pane:settled"] = { at: NOW - MIN };
  prefs.pinned["pane:old"] = NOW - HOUR;
  const context = {
    now: NOW,
    pullRequests: { "ws-a": pr(), "ws-b": pr({ number: 30, checks: "failing", workspaceId: "ws-b" }) },
    branches: { "ws-a": "usage-panel-hairlines", "ws-b": "fix/model", "ws-c": null },
  };
  const view = I.buildAgentInbox(model(cards), prefs, context);
  check("the sections run Needs you, Working, Done, Settled", JSON.stringify(I.AGENT_INBOX_SECTIONS.map((section) => section.id)) === JSON.stringify(SECTIONS), I.AGENT_INBOX_SECTIONS);
  check("their headings read so", JSON.stringify(I.AGENT_INBOX_SECTIONS.map((section) => section.label)) === JSON.stringify(["Needs you", "Working", "Done", "Settled"]));
  check("the view lists its sections in that order", JSON.stringify(Object.keys(view).filter((field) => Array.isArray(view[field]))) === JSON.stringify(SECTIONS), Object.keys(view));
  check("Needs you holds the agents that ask or stopped", JSON.stringify(keys(view.needs)) === JSON.stringify(["pane:ask", "pane:stopped"]), keys(view.needs));
  check("Done holds the finished agents, pinned first", JSON.stringify(keys(view.done)) === JSON.stringify(["pane:old", "pane:fresh"]), keys(view.done));
  const placed = SECTIONS.flatMap((section) => keys(view[section]));
  check("every agent sits in exactly one headed section", placed.length === cards.length && new Set(placed).size === cards.length && cards.every((c) => placed.includes(c.key)), placed);
  check("the sections hold nothing outside a heading", Object.keys(view).every((field) => SECTIONS.includes(field) || !Array.isArray(view[field])), Object.keys(view));
  check("working agents sit on the Working shelf", JSON.stringify(keys(view.working)) === JSON.stringify(["pane:busy", "run:plan"]), keys(view.working));
  check("a settled agent sits on the Settled shelf", JSON.stringify(keys(view.settled)) === JSON.stringify(["pane:settled"]));
  check("the badge counts the agents that wait on you, the Needs you heading's count", view.needsYou === 2 && view.needsYou === view.needs.length, view.needsYou);
  const by = Object.fromEntries([...top(view), ...view.working].map((row) => [row.key, row]));
  check("a question reads Input", by["pane:ask"].statusWord === "Input" && by["pane:ask"].status === "input");
  check("an agent stopped by an error reads Failed", by["pane:stopped"].statusWord === "Failed");
  check("an unseen finish reads Done", by["pane:fresh"].statusWord === "Done" && !by["pane:fresh"].read);
  check("a seen finish shows its age and a dimmed title", by["pane:old"].statusWord === null && by["pane:old"].time === "3h" && by["pane:old"].read, by["pane:old"]);
  check("working shows a live timer", by["pane:busy"].statusWord === "Working" && by["pane:busy"].time === "18m");
  check("under a minute reads now", by["run:plan"].time === "now");
  check("the default agent shows no mark", by["pane:ask"].showAgent === false);
  check("another agent shows its mark", by["pane:old"].showAgent === true && by["run:plan"].showAgent === true);
  check("the row carries its workspace branch", by["pane:fresh"].branch === "usage-panel-hairlines" && by["pane:old"].branch === null);
  check("+/- only on a finished agent's pull request", by["pane:fresh"].showDiff && !by["pane:ask"].showDiff && !by["pane:busy"].showDiff);
  check("Merge only for an open pull request whose checks pass", by["pane:fresh"].mergeReady && !by["pane:stopped"].mergeReady);
  check("a draft or pending pull request is not ready", !I.isMergeReady(pr({ phase: "draft" })) && !I.isMergeReady(pr({ checks: "pending" })) && !I.isMergeReady(null));
  check("a pinned row says so", by["pane:old"].pinned && !by["pane:ask"].pinned);

  const renamed = I.renameAgent(prefs, "pane:fresh", "  Usage\npanel ");
  const again = I.buildAgentInbox(model(cards), renamed, context);
  const fresh = top(again).find((row) => row.key === "pane:fresh");
  check("a rename is one clean line", fresh.title === "Usage panel" && fresh.renamed, fresh.title);
  check("an empty rename restores the agent's title", I.renameAgent(renamed, "pane:fresh", "  ").names["pane:fresh"] === undefined);

  const unread = I.setAgentUnread(prefs, "pane:old", true, NOW);
  const old = top(I.buildAgentInbox(model(cards), unread, context)).find((row) => row.key === "pane:old");
  check("mark unread brightens the title and says Done", !old.read && old.statusWord === "Done");
  check("mark read on a row that is not unread changes nothing", I.setAgentUnread(prefs, "pane:old", false, NOW) === prefs);
}

function testShelvesOverTime(I) {
  console.log("sections over time");
  const empty = { now: NOW, pullRequests: {} };
  let prefs = I.settleAgent(I.emptyAgentInboxPrefs(), "pane:a", NOW);
  const same = I.reconcileAgentInbox(model([card("pane:a", { since: NOW - MIN })]), prefs, empty);
  check("a settled agent that did nothing new stays settled", !same.changed && same.prefs === prefs);
  const flip = I.reconcileAgentInbox(model([card("pane:a", { since: NOW + MIN })]), prefs, { ...empty, now: NOW + 2 * MIN });
  check("a quiet move between ready and idle does not bring it back", !flip.changed);
  const back = I.reconcileAgentInbox(model([card("pane:a", { since: NOW + MIN, unseen: true })]), prefs, { ...empty, now: NOW + 2 * MIN });
  check("a new finished turn brings it back", back.changed && !back.prefs.settled["pane:a"]);
  const working = I.reconcileAgentInbox(model([card("pane:a", { bucket: "working", tone: "info", since: NOW + MIN })]), prefs, { ...empty, now: NOW + 2 * MIN });
  check("starting work again brings it back", working.changed && !working.prefs.settled["pane:a"]);
  const asks = I.settleAgent(I.emptyAgentInboxPrefs(), "pane:q", NOW);
  const stillAsks = I.reconcileAgentInbox(model([card("pane:q", { bucket: "needs-you", tone: "warn", since: NOW - MIN })]), asks, empty);
  check("a question it already asked when settled keeps it settled", !stillAsks.changed);
}

function testNoSnooze(I) {
  console.log("no snooze");
  const gone = Object.keys(I).filter((name) => /snooz|wake/i.test(name));
  check("nothing about snooze is exported", gone.length === 0, gone);
  check("fresh prefs have no snoozed map", !("snoozed" in I.emptyAgentInboxPrefs()));
  const stored = {
    settled: { "pane:s": { at: NOW - HOUR } },
    snoozed: { "pane:z": { at: NOW - HOUR, until: NOW + HOUR }, "pane:s": { at: NOW - 2 * HOUR, until: NOW + HOUR } },
    pinned: {},
    names: {},
    unread: {},
    autoSettled: {},
  };
  let prefs;
  let threw = null;
  try {
    prefs = I.parseAgentInboxPrefs(JSON.parse(JSON.stringify(stored)), NOW);
  } catch (err) {
    threw = String(err);
  }
  check("prefs saved with a snoozed map load without error", threw === null && Boolean(prefs), threw);
  check("the snoozed map is not loaded", !("snoozed" in prefs), Object.keys(prefs));
  check("the rest of what was saved still loads", Boolean(prefs.settled["pane:s"]));
  const saved = JSON.parse(JSON.stringify(I.setAgentPinned(prefs, "pane:p", true, NOW)));
  check("the next save drops the snoozed map", !("snoozed" in saved), Object.keys(saved));
  const reconciled = I.reconcileAgentInbox(model([card("pane:z", { unseen: true })]), prefs, { now: NOW, pullRequests: {} });
  check("a reconcile never brings it back", !("snoozed" in reconciled.prefs));
  const view = I.buildAgentInbox(
    model([card("pane:z", { unseen: true }), card("pane:w", { bucket: "working", tone: "info" }), card("pane:s")]),
    prefs,
    { now: NOW, pullRequests: {} },
  );
  check("a card that was snoozed shows again in its normal section", keys(view.done).includes("pane:z"), keys(view.done));
  check("a card that was settled and snoozed stays settled", keys(view.settled).includes("pane:s"), keys(view.settled));
  check("no row carries a snooze time", SECTIONS.flatMap((section) => view[section]).every((row) => !("snoozedUntil" in row)));
}

function testAutoSettle(I) {
  console.log("auto-settle on merge");
  const merged = { now: NOW, pullRequests: { "ws-a": pr({ phase: "merged" }) } };
  const cards = [
    card("pane:done"),
    card("pane:busy", { bucket: "working", tone: "info" }),
    card("pane:pinned"),
    card("pane:asks", { bucket: "needs-you", tone: "warn" }),
    card("pane:elsewhere", { workspaceId: "ws-b" }),
  ];
  const prefs = I.setAgentPinned(I.emptyAgentInboxPrefs(), "pane:pinned", true, NOW);
  const r = I.reconcileAgentInbox(model(cards), prefs, merged);
  const settled = Object.keys(r.prefs.settled).sort();
  check("a merged pull request settles its finished agents", JSON.stringify(settled) === JSON.stringify(["pane:done"]), settled);
  check("the settle says which pull request", r.prefs.settled["pane:done"].auto === "codara-solutions/codara-studio#61");
  check("it reports what it settled for the undo line", r.autoSettled.length === 1 && r.autoSettled[0].number === 61);
  check("a working, waiting, pinned or other agent is left alone", !r.prefs.settled["pane:busy"] && !r.prefs.settled["pane:asks"] && !r.prefs.settled["pane:pinned"] && !r.prefs.settled["pane:elsewhere"]);
  check("an open pull request settles nothing", !I.reconcileAgentInbox(model(cards), I.emptyAgentInboxPrefs(), { now: NOW, pullRequests: { "ws-a": pr() } }).changed);
  const view = I.buildAgentInbox(model(cards), r.prefs, merged);
  check("the settled agents leave the inbox", !keys(top(view)).includes("pane:done") && keys(view.settled).includes("pane:done"));

  const failed = I.reconcileAgentInbox(model([card("run:failed", { tone: "danger", status: "Failed" })]), I.emptyAgentInboxPrefs(), merged);
  check("a failure is never auto-settled", !failed.changed);

  const twice = I.reconcileAgentInbox(model(cards), r.prefs, { ...merged, now: NOW + MIN });
  check("a second look settles nothing new", !twice.changed);

  // New work after the merge brings it back, and the same merge does not hide it again.
  const later = [card("pane:done", { since: NOW + 5 * MIN, unseen: true })];
  const backAgain = I.reconcileAgentInbox(model(later), r.prefs, { ...merged, now: NOW + 6 * MIN });
  check("a new finish after the merge comes back", !backAgain.prefs.settled["pane:done"]);
  const stays = I.reconcileAgentInbox(model(later), backAgain.prefs, { ...merged, now: NOW + 7 * MIN });
  check("and the same merge never settles it again", !stays.prefs.settled["pane:done"] && !stays.changed);
  const nextPr = I.reconcileAgentInbox(model(later), backAgain.prefs, { now: NOW + 8 * MIN, pullRequests: { "ws-a": pr({ phase: "merged", number: 62 }) } });
  check("a later merged pull request settles it again", Boolean(nextPr.prefs.settled["pane:done"]));
}

function testUndo(I) {
  console.log("undo");
  const merged = { now: NOW, pullRequests: { "ws-a": pr({ phase: "merged" }) } };
  const cards = [card("pane:done")];
  const before = I.emptyAgentInboxPrefs();
  const r = I.reconcileAgentInbox(model(cards), before, merged);
  const snap = I.snapshotAgentInbox(before, ["pane:done"]);
  const undone = I.restoreAgentInbox(r.prefs, snap);
  check("undo brings an auto-settled agent back", !undone.settled["pane:done"]);
  const after = I.reconcileAgentInbox(model(cards), undone, { ...merged, now: NOW + MIN });
  check("an undone auto-settle is not settled again by the same merge", !after.changed && !after.prefs.settled["pane:done"]);

  // Merged from the inbox, then the watcher says merged, then the user undoes.
  const mergedHere = I.settleMergedAgent(before, "pane:done", "codara-solutions/codara-studio#61", NOW);
  check("a merge from the inbox settles the row for that merge", mergedHere.settled["pane:done"].auto === "codara-solutions/codara-studio#61" && mergedHere.autoSettled["pane:done"] === "codara-solutions/codara-studio#61");
  const watcher = I.reconcileAgentInbox(model(cards), mergedHere, { ...merged, now: NOW + MIN });
  const undoMerge = I.restoreAgentInbox(watcher.prefs, I.snapshotAgentInbox(before, ["pane:done"]));
  const afterUndo = I.reconcileAgentInbox(model(cards), undoMerge, { ...merged, now: NOW + 2 * MIN });
  check("undoing it is not followed by the watcher settling it again", !afterUndo.prefs.settled["pane:done"]);

  // The watcher sees the merge before the inbox's merge call returns.
  const watcherFirst = I.reconcileAgentInbox(model(cards), before, merged).prefs;
  check("the watcher settles the row first", !!watcherFirst.settled["pane:done"]);
  check("the inbox's merge then changes nothing", I.settleMergedAgent(watcherFirst, "pane:done", "codara-solutions/codara-studio#61", NOW + MIN) === watcherFirst);
  const undoneWatcher = I.restoreAgentInbox(watcherFirst, I.snapshotAgentInbox(before, ["pane:done"]));
  const lateMerge = I.settleMergedAgent(undoneWatcher, "pane:done", "codara-solutions/codara-studio#61", NOW + MIN);
  check("undoing the watcher while the merge runs is not taken back by it", !lateMerge.settled["pane:done"]);

  // What a merge from the inbox may settle once GitHub answers.
  check("a finished agent settles on its merge", I.settlesOnMerge(card("pane:ok", { bucket: "done" })));
  check("one that failed while the merge ran does not", !I.settlesOnMerge(card("pane:bad", { bucket: "done", tone: "danger", status: "Failed" })));
  check("one asking for input does not", !I.settlesOnMerge(card("pane:ask", { bucket: "needs-you" })));
  check("one back at work does not", !I.settlesOnMerge(card("pane:busy", { bucket: "working" })));

  const pinned = I.setAgentPinned(I.emptyAgentInboxPrefs(), "pane:a", true, NOW);
  const restored = I.restoreAgentInbox(I.settleAgent(pinned, "pane:a", NOW), I.snapshotAgentInbox(pinned, ["pane:a"]));
  check("undo of a settle leaves the rest of the row as it was", !restored.settled["pane:a"] && restored.pinned["pane:a"] === NOW);
  const unread = I.setAgentUnread(I.emptyAgentInboxPrefs(), "pane:b", true, NOW);
  const settledUnread = I.settleAgent(unread, "pane:b", NOW);
  check("settling clears a manual unread", settledUnread.unread["pane:b"] === undefined);
  check("and undo restores it", I.restoreAgentInbox(settledUnread, I.snapshotAgentInbox(unread, ["pane:b"])).unread["pane:b"] === NOW);
  const many = I.restoreAgentInbox(
    I.settleAgent(I.settleAgent(I.emptyAgentInboxPrefs(), "pane:c", NOW), "pane:d", NOW),
    I.snapshotAgentInbox(I.emptyAgentInboxPrefs(), ["pane:c", "pane:d"]),
  );
  check("one undo covers every key of the action", Object.keys(many.settled).length === 0);
}

function testStoredAndMerge(I) {
  console.log("stored prefs and merge");
  const raw = {
    settled: { "pane:a": { at: NOW - HOUR, auto: "x#1" }, "pane:old": { at: NOW - 40 * 24 * HOUR }, "bad key": { at: NOW }, "pane:nan": { at: "x" } },
    pinned: { "pane:p": NOW, "pane:q": -1 },
    names: { "pane:n": " Named\n", "pane:e": "   " },
    unread: { "pane:u": NOW },
    autoSettled: { "pane:a": "x#1", "pane:z": 5 },
  };
  const prefs = I.parseAgentInboxPrefs(raw, NOW);
  check("valid records load", prefs.settled["pane:a"].auto === "x#1" && prefs.pinned["pane:p"] === NOW && prefs.unread["pane:u"] === NOW && prefs.autoSettled["pane:a"] === "x#1");
  check("records older than the TTL are dropped", !prefs.settled["pane:old"]);
  check("malformed keys and values are dropped", !prefs.settled["bad key"] && !prefs.settled["pane:nan"] && prefs.pinned["pane:q"] === undefined && prefs.autoSettled["pane:z"] === undefined);
  check("names are cleaned, empty ones dropped", prefs.names["pane:n"] === "Named" && prefs.names["pane:e"] === undefined);
  check("garbage loads as empty", JSON.stringify(I.parseAgentInboxPrefs("nope", NOW)) === JSON.stringify(I.emptyAgentInboxPrefs()));
  const big = { settled: {} };
  for (let i = 0; i < 700; i += 1) big.settled[`pane:p${i}`] = { at: NOW - i * MIN };
  const capped = I.parseAgentInboxPrefs(big, NOW);
  check("at most 500 records, the newest kept", Object.keys(capped.settled).length === 500 && capped.settled["pane:p0"] && !capped.settled["pane:p699"]);

  check("merging into main asks first", I.mergeNeedsConfirmation("main") && I.mergeNeedsConfirmation("master"));
  check("merging into the default branch asks first", I.mergeNeedsConfirmation("trunk", "trunk"));
  check("merging into another base does not", !I.mergeNeedsConfirmation("Cora", "main"));
  check("an unknown base asks first", I.mergeNeedsConfirmation(""));
}

function testSubagents(I) {
  console.log("subagents");
  const kid = (key, parentKey, overrides = {}) =>
    card(key, { source: "background", workspaceId: `wt-${key}`, parentKey, ...overrides });
  const working = { bucket: "working", status: "Working", tone: "info" };
  const cards = [
    card("pane:alone", { ...working, since: NOW - 3 * MIN }),
    card("pane:one", { ...working, since: NOW - 18 * MIN }),
    card("pane:three", { since: NOW - 40 * MIN }),
    kid("worktree:a", "pane:one", { ...working, since: NOW - 4 * MIN }),
    kid("worktree:b", "pane:three", { ...working, since: NOW - 9 * MIN }),
    kid("worktree:c", "pane:three", { bucket: "needs-you", status: "Blocked", tone: "warn" }),
    kid("worktree:d", "pane:three", { status: "In review" }),
    kid("worktree:orphan", "pane:closed", { ...working, since: NOW - 7 * MIN }),
  ];
  const context = { now: NOW, pullRequests: {}, branches: { "wt-worktree:a": "feat/zoom-viewers" } };
  const view = I.buildAgentInbox(model(cards), I.emptyAgentInboxPrefs(), context);
  const rowOf = (key) => SECTIONS.flatMap((section) => view[section]).find((entry) => entry.key === key);
  const placed = SECTIONS.flatMap((section) => keys(view[section]));
  check("a subagent with its parent on the board is not a row", !placed.includes("worktree:a") && !placed.includes("worktree:b"), placed);
  check("an orphan subagent (parent closed) stays a row", keys(view.working).includes("worktree:orphan"), keys(view.working));
  check("a parent with no subagents has none", rowOf("pane:alone").subagents.length === 0);
  check("a parent with one subagent carries it", JSON.stringify(keys(rowOf("pane:one").subagents)) === JSON.stringify(["worktree:a"]));
  check("a parent with three carries all three, in board order", JSON.stringify(keys(rowOf("pane:three").subagents)) === JSON.stringify(["worktree:c", "worktree:b", "worktree:d"]), keys(rowOf("pane:three").subagents));
  const a = rowOf("pane:one").subagents[0];
  check("a subagent row has its title, time and branch", a.title === "title worktree:a" && a.time === "4m" && a.branch === "feat/zoom-viewers", a);
  check("Working counts main agents only", view.working.length === 3, keys(view.working));
  check("a subagent waiting on the user lifts its finished parent into Needs you", JSON.stringify(keys(view.needs)) === JSON.stringify(["pane:three"]), keys(view.needs));
  check("the badge counts that parent once", view.needsYou === 1, view.needsYou);
  check("the lifted parent keeps its own status word", rowOf("pane:three").status === "age", rowOf("pane:three").status);
  check("Done no longer holds it", view.done.length === 0, keys(view.done));
  check("total counts main agents only", view.total === 4, view.total);

  check("no chip without subagents", I.agentInboxSubagentChip([]) === null);
  const one = I.agentInboxSubagentChip(rowOf("pane:one").subagents);
  check("one working subagent: '1 subagent' with a working dot", one.label === "1 subagent" && one.tone === "info", one);
  const three = I.agentInboxSubagentChip(rowOf("pane:three").subagents);
  check("three, one waiting: '3 subagents' with a warn dot", three.label === "3 subagents" && three.tone === "warn", three);
  check("the chip says what its dot means", three.spoken === "3 subagents, 1 waiting for you, 1 working" && one.spoken === "1 subagent, 1 working", [three.spoken, one.spoken]);
  const quiet = I.agentInboxSubagentChip([rowOf("pane:three").subagents[2]]);
  check("nothing running: no dot", quiet.tone === null, quiet);

  const prefs = I.emptyAgentInboxPrefs();
  prefs.settled["pane:one"] = { at: NOW };
  prefs.settled["worktree:b"] = { at: NOW };
  const later = I.buildAgentInbox(model(cards), prefs, context);
  check("a subagent follows its settled parent", JSON.stringify(keys(later.settled[0].subagents)) === JSON.stringify(["worktree:a"]));
  const three2 = SECTIONS.flatMap((section) => later[section]).find((entry) => entry.key === "pane:three");
  check("settling a subagent itself does not move it off its parent", keys(three2.subagents).includes("worktree:b"));

  const settledAt = NOW - 30 * MIN;
  const quietPrefs = I.emptyAgentInboxPrefs();
  quietPrefs.settled["pane:three"] = { at: settledAt };
  const quiet2 = I.reconcileAgentInbox(model(cards), quietPrefs, { now: NOW, pullRequests: {} });
  check("a subagent that starts work brings its settled parent back", !quiet2.prefs.settled["pane:three"], quiet2.prefs.settled);
  const stillPrefs = I.emptyAgentInboxPrefs();
  stillPrefs.settled["pane:three"] = { at: NOW };
  const still = I.reconcileAgentInbox(model(cards), stillPrefs, { now: NOW, pullRequests: {} });
  check("subagents with nothing new keep their parent settled", Boolean(still.prefs.settled["pane:three"]));
  const settledView = I.buildAgentInbox(model(cards), stillPrefs, context);
  const settledThree = settledView.settled.find((entry) => entry.key === "pane:three");
  check(
    "settled parent, subagent already waiting: the parent stays settled, the subagent is its own Needs you row",
    Boolean(settledThree) && JSON.stringify(keys(settledView.needs)) === JSON.stringify(["worktree:c"]) &&
      !keys(settledThree.subagents).includes("worktree:c") && keys(settledThree.subagents).includes("worktree:b") &&
      settledView.needsYou === 1,
    { needs: keys(settledView.needs), kids: settledThree && keys(settledThree.subagents) },
  );

  const chained = I.buildAgentInbox(
    model([card("pane:p", working), kid("worktree:x", "pane:p"), kid("worktree:y", "worktree:x"), kid("worktree:self", "worktree:self")]),
    I.emptyAgentInboxPrefs(),
    context,
  );
  const all = SECTIONS.flatMap((section) => chained[section]);
  const listed = [...keys(all), ...all.flatMap((entry) => keys(entry.subagents))].sort();
  check("no card is lost: one under a subagent, or under itself, stays a row", JSON.stringify(listed) === JSON.stringify(["pane:p", "worktree:self", "worktree:x", "worktree:y"]), listed);
}

function testPlainWords() {
  console.log("plain words");
  const files = [path.join(ROOT, "src", "shared", "agent-inbox.ts")];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    check(`${path.relative(ROOT, file)} has no em or en dash`, !/[\u2013\u2014]/.test(text));
  }
}

async function main() {
  const I = await load();
  testGrouping(I);
  testShelvesOverTime(I);
  testNoSnooze(I);
  testAutoSettle(I);
  testUndo(I);
  testStoredAndMerge(I);
  testSubagents(I);
  testPlainWords();
  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
