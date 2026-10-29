// Unit tests for the Agents tab as an inbox (src/shared/agent-inbox.ts):
//
//   1. Grouping: which agents sit in the inbox and which on the Working,
//      Snoozed and Settled shelves, pinned first, the status word and the
//      age, read titles, the agent mark only for a non-default agent, +/-
//      only on a finished pull request, Merge only when ready.
//   2. Shelves over time: a settled agent comes back when it acts, a snooze
//      wakes on time or when the agent asks something, never for a finished
//      turn.
//   3. Snooze presets in local time: 1 h, 3 h, this evening, tomorrow and
//      next week, with this evening gone once 18:00 has passed.
//   4. A merged pull request settles finished agents once, never twice, and
//      never a pinned or working one.
//   5. Undo puts a key back as it was, and an undone auto-settle stays put.
//   6. Stored prefs are cleaned on load; merge asks first into main.
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

function testGrouping(I) {
  console.log("grouping");
  const cards = [
    card("pane:ask", { bucket: "needs-you", status: "Needs you", tone: "warn", since: NOW - 2 * MIN }),
    card("pane:stopped", { bucket: "needs-you", status: "Stopped", tone: "danger", since: NOW - 5 * MIN, workspaceId: "ws-b" }),
    card("pane:fresh", { unseen: true, status: "Finished", since: NOW - 6 * MIN }),
    card("pane:old", { since: NOW - 3 * HOUR - 20 * MIN, runtime: "codex", workspaceId: "ws-c" }),
    card("pane:busy", { bucket: "working", status: "Working", tone: "info", since: NOW - 18 * MIN }),
    card("run:plan", { bucket: "working", status: "Planning", tone: "info", since: NOW - MIN / 2, runtime: "cora" }),
    card("pane:snoozed", { unseen: true }),
    card("pane:settled", {}),
  ];
  const prefs = I.emptyAgentInboxPrefs();
  prefs.snoozed["pane:snoozed"] = { at: NOW - HOUR, until: NOW + HOUR };
  prefs.settled["pane:settled"] = { at: NOW - MIN };
  prefs.pinned["pane:old"] = NOW - HOUR;
  const context = {
    now: NOW,
    pullRequests: { "ws-a": pr(), "ws-b": pr({ number: 30, checks: "failing", workspaceId: "ws-b" }) },
    branches: { "ws-a": "usage-panel-hairlines", "ws-b": "fix/model", "ws-c": null },
  };
  const view = I.buildAgentInbox(model(cards), prefs, context);
  check("the inbox holds needs-you and finished agents, pinned first", JSON.stringify(keys(view.inbox)) === JSON.stringify(["pane:old", "pane:ask", "pane:stopped", "pane:fresh"]), keys(view.inbox));
  check("working agents sit on the Working shelf", JSON.stringify(keys(view.working)) === JSON.stringify(["pane:busy", "run:plan"]), keys(view.working));
  check("a snoozed agent sits on the Snoozed shelf until it wakes", JSON.stringify(keys(view.snoozed)) === JSON.stringify(["pane:snoozed"]));
  check("a settled agent sits on the Settled shelf", JSON.stringify(keys(view.settled)) === JSON.stringify(["pane:settled"]));
  check("the badge counts the agents that wait on you", view.needsYou === 2, view.needsYou);
  const by = Object.fromEntries([...view.inbox, ...view.working].map((row) => [row.key, row]));
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
  const fresh = again.inbox.find((row) => row.key === "pane:fresh");
  check("a rename is one clean line", fresh.title === "Usage panel" && fresh.renamed, fresh.title);
  check("an empty rename restores the agent's title", I.renameAgent(renamed, "pane:fresh", "  ").names["pane:fresh"] === undefined);

  const unread = I.setAgentUnread(prefs, "pane:old", true, NOW);
  const old = I.buildAgentInbox(model(cards), unread, context).inbox.find((row) => row.key === "pane:old");
  check("mark unread brightens the title and says Done", !old.read && old.statusWord === "Done");
  check("mark read on a row that is not unread changes nothing", I.setAgentUnread(prefs, "pane:old", false, NOW) === prefs);
}

function testShelvesOverTime(I) {
  console.log("shelves over time");
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

  prefs = I.snoozeAgent(I.emptyAgentInboxPrefs(), "pane:s", NOW + HOUR, NOW);
  const s = card("pane:s", { since: NOW - MIN });
  let r = I.reconcileAgentInbox(model([s]), prefs, { ...empty, now: NOW + 59 * MIN });
  check("a snooze holds until its time", !r.changed);
  check("the view keeps it snoozed before its time", I.buildAgentInbox(model([s]), prefs, { ...empty, now: NOW + 59 * MIN }).snoozed.length === 1);
  r = I.reconcileAgentInbox(model([s]), prefs, { ...empty, now: NOW + HOUR });
  check("a snooze wakes at its time", r.changed && !r.prefs.snoozed["pane:s"]);
  check("the view wakes it at its time even before the reconcile", I.buildAgentInbox(model([s]), prefs, { ...empty, now: NOW + HOUR }).inbox.length === 1);
  r = I.reconcileAgentInbox(model([card("pane:s", { since: NOW + MIN, unseen: true })]), prefs, { ...empty, now: NOW + 2 * MIN });
  check("a finished turn never ends a snooze early", !r.changed);
  r = I.reconcileAgentInbox(model([card("pane:s", { bucket: "needs-you", tone: "warn", since: NOW + MIN })]), prefs, { ...empty, now: NOW + 2 * MIN });
  check("a question ends a snooze early", r.changed && !r.prefs.snoozed["pane:s"]);
  r = I.reconcileAgentInbox(model([card("pane:s", { tone: "danger", since: NOW + MIN })]), prefs, { ...empty, now: NOW + 2 * MIN });
  check("a fresh failure ends a snooze early", r.changed && !r.prefs.snoozed["pane:s"]);
  r = I.reconcileAgentInbox(model([]), prefs, { ...empty, now: NOW + 2 * HOUR });
  check("a spent snooze of an agent not on the board is dropped", r.changed && !r.prefs.snoozed["pane:s"]);
  r = I.reconcileAgentInbox(model([]), prefs, { ...empty, now: NOW + MIN });
  check("a running snooze of an agent not on the board is kept", !r.changed);

  const settledThenSnoozed = I.snoozeAgent(I.settleAgent(I.emptyAgentInboxPrefs(), "pane:x", NOW), "pane:x", NOW + HOUR, NOW);
  check("snoozing a settled agent un-settles it", !settledThenSnoozed.settled["pane:x"] && settledThenSnoozed.snoozed["pane:x"]);
  const snoozedThenSettled = I.settleAgent(settledThenSnoozed, "pane:x", NOW);
  check("settling a snoozed agent ends the snooze", !snoozedThenSettled.snoozed["pane:x"] && snoozedThenSettled.settled["pane:x"]);
}

function testSnoozePresets(I) {
  console.log("snooze presets");
  const at14 = I.agentSnoozePresets(NOW - HOUR);
  const ids = at14.map((p) => p.id);
  check("five presets at 14:00, soonest first", JSON.stringify(ids) === JSON.stringify(["1h", "3h", "evening", "tomorrow", "next-week"]), ids);
  const by = Object.fromEntries(at14.map((p) => [p.id, p]));
  check("1 hour wakes at 15:00", by["1h"].until === NOW && by["1h"].when === "15:00");
  check("3 hours wakes at 17:00", by["3h"].when === "17:00");
  check("this evening is 18:00 today", by.evening.until === Date.parse("2026-10-29T18:00:00.000Z") && by.evening.when === "18:00");
  check("tomorrow is 09:00 on Friday", by.tomorrow.until === Date.parse("2026-10-30T09:00:00.000Z") && by.tomorrow.when === "09:00");
  check("next week is Monday 09:00", by["next-week"].until === Date.parse("2026-11-02T09:00:00.000Z") && by["next-week"].when === "Mon");
  const at15 = I.agentSnoozePresets(NOW).map((p) => p.id);
  check("at 15:00, 3 hours and this evening are one row, named this evening", JSON.stringify(at15) === JSON.stringify(["1h", "evening", "tomorrow", "next-week"]), at15);
  const at16 = I.agentSnoozePresets(Date.parse("2026-10-29T16:00:00.000Z"));
  check("one row per wake minute", at16.length === new Set(at16.map((p) => Math.floor(p.until / MIN))).size);
  const late = I.agentSnoozePresets(Date.parse("2026-10-29T19:30:00.000Z"));
  check("this evening is left out once 18:00 has passed", !late.some((p) => p.id === "evening"));
  const monday = I.agentSnoozePresets(Date.parse("2026-11-02T08:00:00.000Z"));
  check("on a Monday, next week is the Monday after", monday.find((p) => p.id === "next-week").until === Date.parse("2026-11-09T09:00:00.000Z"));
  const sunday = I.agentSnoozePresets(Date.parse("2026-11-01T10:00:00.000Z"));
  check("on a Sunday, tomorrow and next week are one row: Monday 09:00", sunday.filter((p) => p.until === Date.parse("2026-11-02T09:00:00.000Z")).length === 1 && !sunday.some((p) => p.id === "next-week"));
  check("a wake today reads as its time", I.agentSnoozeWakeLabel(Date.parse("2026-10-29T18:00:00.000Z"), NOW) === "18:00");
  check("a wake on another day reads with the weekday", I.agentSnoozeWakeLabel(Date.parse("2026-10-30T09:00:00.000Z"), NOW) === "Fri 09:00");
}

function testAutoSettle(I) {
  console.log("auto-settle on merge");
  const merged = { now: NOW, pullRequests: { "ws-a": pr({ phase: "merged" }) } };
  const cards = [
    card("pane:done"),
    card("pane:busy", { bucket: "working", tone: "info" }),
    card("pane:pinned"),
    card("pane:asks", { bucket: "needs-you", tone: "warn" }),
    card("pane:snoozed"),
    card("pane:elsewhere", { workspaceId: "ws-b" }),
  ];
  let prefs = I.setAgentPinned(I.emptyAgentInboxPrefs(), "pane:pinned", true, NOW);
  prefs = I.snoozeAgent(prefs, "pane:snoozed", NOW + HOUR, NOW);
  const r = I.reconcileAgentInbox(model(cards), prefs, merged);
  const settled = Object.keys(r.prefs.settled).sort();
  check("a merged pull request settles its finished agents, snoozed ones too", JSON.stringify(settled) === JSON.stringify(["pane:done", "pane:snoozed"]), settled);
  check("the settle says which pull request", r.prefs.settled["pane:done"].auto === "codara-solutions/codara-studio#61");
  check("it reports what it settled for the undo line", r.autoSettled.length === 2 && r.autoSettled[0].number === 61);
  check("a working, waiting, pinned or other agent is left alone", !r.prefs.settled["pane:busy"] && !r.prefs.settled["pane:asks"] && !r.prefs.settled["pane:pinned"] && !r.prefs.settled["pane:elsewhere"]);
  check("an open pull request settles nothing", !I.reconcileAgentInbox(model(cards), I.emptyAgentInboxPrefs(), { now: NOW, pullRequests: { "ws-a": pr() } }).changed);
  const view = I.buildAgentInbox(model(cards), r.prefs, merged);
  check("the settled agents leave the inbox", !keys(view.inbox).includes("pane:done") && keys(view.settled).includes("pane:done"));

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

  let prefs = I.snoozeAgent(I.emptyAgentInboxPrefs(), "pane:a", NOW + HOUR, NOW);
  const snapshot = I.snapshotAgentInbox(prefs, ["pane:a"]);
  prefs = I.settleAgent(prefs, "pane:a", NOW);
  const restored = I.restoreAgentInbox(prefs, snapshot);
  check("undo of a settle restores the snooze it replaced", !restored.settled["pane:a"] && restored.snoozed["pane:a"].until === NOW + HOUR);
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
    snoozed: { "run:r1": { at: NOW, until: NOW + HOUR }, "run:r2": { at: NOW } },
    pinned: { "pane:p": NOW, "pane:q": -1 },
    names: { "pane:n": " Named\n", "pane:e": "   " },
    unread: { "pane:u": NOW },
    autoSettled: { "pane:a": "x#1", "pane:z": 5 },
  };
  const prefs = I.parseAgentInboxPrefs(raw, NOW);
  check("valid records load", prefs.settled["pane:a"].auto === "x#1" && prefs.snoozed["run:r1"].until === NOW + HOUR && prefs.pinned["pane:p"] === NOW && prefs.unread["pane:u"] === NOW && prefs.autoSettled["pane:a"] === "x#1");
  check("records older than the TTL are dropped", !prefs.settled["pane:old"]);
  check("malformed keys and values are dropped", !prefs.settled["bad key"] && !prefs.settled["pane:nan"] && !prefs.snoozed["run:r2"] && prefs.pinned["pane:q"] === undefined && prefs.autoSettled["pane:z"] === undefined);
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

function testPlainWords() {
  console.log("plain words");
  const files = [path.join(ROOT, "src", "shared", "agent-inbox.ts")];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    check(`${path.relative(ROOT, file)} has no em or en dash`, !/[–—]/.test(text));
  }
}

async function main() {
  const I = await load();
  testGrouping(I);
  testShelvesOverTime(I);
  testSnoozePresets(I);
  testAutoSettle(I);
  testUndo(I);
  testStoredAndMerge(I);
  testPlainWords();
  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
