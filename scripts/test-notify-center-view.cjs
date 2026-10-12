#!/usr/bin/env node
"use strict";

// Unit tests for the notification-center panel's view model
// (src/renderer/src/notifications/center-view.ts) and the click routing it
// relies on (routing.ts): display text, relative times, the pinned "Needs
// you" section, day and workspace sections, stacks, filter counts, and what a
// click on a closed pane, deleted run or removed workspace does.
//
//   node scripts/test-notify-center-view.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const NOTIFY_DIR = path.join(ROOT, "src", "renderer", "src", "notifications");

async function load(entry) {
  const out = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "view-test-harness",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
          }));
          // routing.ts imports useEffect for its focus listener only.
          build.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "stub" }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents: "export function useEffect() {}",
            loader: "js",
          }));
        },
      },
    ],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const HOUR = 3_600_000;
// Local noon, so day buckets do not depend on the machine's time zone.
const NOW = new Date(2026, 9, 12, 12, 0, 0).getTime();
const iso = (ms) => new Date(ms).toISOString();

let seq = 0;
function row(fields) {
  seq += 1;
  return {
    id: `n${seq}`,
    kind: "terminal.agent.done",
    sourceKey: `pane:p${seq}`,
    title: "Claude Code finished · server",
    body: "",
    tone: "success",
    target: { type: "terminal", workspaceId: "w1", tabId: "t1", paneId: `p${seq}` },
    createdAt: iso(NOW - seq * 60_000),
    read: false,
    ...fields,
  };
}
const question = (fields) =>
  row({ kind: "run.blocked", title: "Codara Studio \u2014 needs you", target: { type: "run", runId: `r${seq + 1}`, workspaceId: "w1" }, ...fields });

const WORKSPACES = new Map([
  ["w1", { id: "w1", name: "api", color: "#f00" }],
  ["w2", { id: "w2", name: "web" }],
]);

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

let V;
let R;
let S;

const build = (entries, extra = {}) =>
  V.buildSections(entries, { filter: "all", grouping: "time", now: NOW, mutes: [], workspaces: WORKSPACES, ...extra });

test("display text drops the brand prefix and moves the tab to the context", () => {
  assert.deepEqual(V.displayText(row({})), { title: "Claude Code finished", context: "server" });
  assert.deepEqual(V.displayText(question({})), { title: "Cora needs you", context: null });
  assert.deepEqual(V.displayText(row({ title: "" })), { title: "Agent finished", context: null });
  assert.deepEqual(V.displayText(row({ title: "Deploy done" })), { title: "Deploy done", context: null });
  assert.deepEqual(V.displayText(row({ title: "Claude Code \u2014 finished" })), { title: "Claude Code finished", context: null });
});

test("a terminal body drops the filler its title already says", () => {
  assert.equal(V.displayBody(row({ body: "Finished its turn. · took 15m" })), "Took 15m");
  assert.equal(V.displayBody(row({ body: "Finished its turn." })), null);
  assert.equal(V.displayBody(row({ body: "Refactored the parser · took 3m" })), "Refactored the parser · took 3m");
  assert.equal(
    V.displayBody(row({ body: "Finished after 9m in “terminals”. Click to jump to the terminal." })),
    "Finished after 9m in “terminals”.",
  );
  assert.equal(V.displayBody(row({ kind: "terminal.agent.needs-input", body: "Waiting for your answer." })), null);
  assert.equal(V.displayBody(question({ body: "Finished its turn." })), "Finished its turn.");
  assert.equal(V.displayBody(question({ body: "Updated 14 tests \u2014 ran 18m" })), "Updated 14 tests · ran 18m");
  assert.equal(V.displayBody(question({ body: "well-known pre-release" })), "well-known pre-release");
});

test("relative times: now, minutes, hours, then a day or a clock time", () => {
  assert.equal(V.rowTime(iso(NOW - 10_000), NOW, true), "now");
  assert.equal(V.rowTime(iso(NOW - 5 * 60_000), NOW, true), "5m");
  assert.equal(V.rowTime(iso(NOW - 3 * HOUR), NOW, true), "3h");
  assert.equal(V.rowTime(iso(NOW - 24 * HOUR), NOW, true), "Yesterday");
  assert.match(V.rowTime(iso(NOW - 24 * HOUR), NOW, false), /\d/);
  assert.equal(V.rowTime("garbage", NOW, true), "");
});

test("only unseen open questions are pinned; seen ones stay in their day", () => {
  const seen = question({ read: true });
  const entries = [row({}), seen, question({}), row({ createdAt: iso(NOW - 30 * HOUR) })];
  const sections = build(entries);
  assert.deepEqual(sections.map((s) => s.key), ["needs-you", "d0", "d1"]);
  assert.equal(sections[0].rows, 1);
  assert.equal(sections[0].note, "1 seen");
  assert.ok(sections[1].items.some((item) => item.type === "row" && item.entry.id === seen.id));
});

test("a muted question is not pinned and the header says so", () => {
  const muted = question({ target: { type: "run", runId: "rm", workspaceId: "w2" } });
  const sections = build([question({}), muted], { mutes: [{ key: "workspace:w2", label: "web", until: NOW + HOUR }] });
  assert.equal(sections[0].key, "needs-you");
  assert.equal(sections[0].rows, 1);
  assert.equal(sections[0].note, "1 muted");
});

test("a settled question or one whose target is gone is not pinned", () => {
  const settled = question({ settled: true });
  const gone = question({});
  const isGone = (e) => e.id === gone.id;
  const sections = build([settled, gone], { isGone });
  assert.deepEqual(sections.map((s) => s.key), ["d0"]);
  assert.deepEqual(V.filterCounts([settled, gone], { now: NOW, mutes: [], isGone }), { "needs-you": 0, unread: 2 });
});

test("the badge, the Needs you tab and the pinned header always agree", () => {
  const mutes = [{ key: "workspace:w2", label: "web", until: NOW + HOUR }];
  const goneId = "gone-q";
  const entries = [
    question({}),
    question({}),
    question({ read: true }),
    question({ target: { type: "run", runId: "rm", workspaceId: "w2" } }),
    question({ id: goneId }),
    question({ settled: true }),
    row({ kind: "terminal.agent.needs-input", title: "Codex needs you · tests" }),
    row({}),
    row({ kind: "git.teammate-push", title: "bot pushed" }),
  ];
  const isGone = (e) => e.id === goneId;
  const badge = S.countCenter(entries, mutes, NOW, isGone).needsYou;
  const tab = V.filterCounts(entries, { now: NOW, mutes, isGone })["needs-you"];
  for (const filter of ["all", "needs-you", "unread"]) {
    for (const grouping of ["time", "workspace"]) {
      const pinned = build(entries, { filter, grouping, mutes, isGone }).find((s) => s.key === "needs-you");
      assert.equal(pinned.rows, badge, `${filter}/${grouping}`);
    }
  }
  assert.equal(badge, 3);
  assert.equal(tab, badge);
  // Main has no view of panes; without the gone row it counts the same.
  assert.equal(S.summarizeCenter(entries.filter((e) => !isGone(e)), mutes, NOW).needsYou, badge);
});

test("an answered question keeps its pinned place while the panel is open", () => {
  const answered = question({ read: true });
  const waiting = question({});
  const entries = [row({}), answered, waiting];
  const sections = build(entries, { held: new Set([answered.id]) });
  assert.equal(sections[0].key, "needs-you");
  assert.deepEqual(sections[0].items.map((i) => i.entry.id), [answered.id, waiting.id]);
  // It does not count: the header says how many still need the user.
  assert.equal(sections[0].rows, 1);
  assert.ok(!sections[1].items.some((i) => i.type === "row" && i.entry.id === answered.id));
  const settled = { ...answered, settled: true };
  const alone = build([settled], { held: new Set([settled.id]) });
  assert.deepEqual(alone.map((s) => [s.key, s.rows, s.showCount, s.note]), [["needs-you", 0, false, "All answered"]]);
  const filtered = build([settled, question({ read: true })], { filter: "needs-you", held: new Set([settled.id]) });
  assert.deepEqual(filtered.map((s) => [s.key, s.items.length]), [["needs-you", 1], ["seen", 1]]);
});

test("a pinned list shows whole unless at least three would hide", () => {
  const five = Array.from({ length: 5 }, () => question({}));
  assert.equal(build(five)[0].limit, undefined);
  const six = Array.from({ length: 6 }, () => question({}));
  assert.equal(build(six)[0].limit, 3);
});

test("the Needs you filter lists unseen questions, then the seen ones", () => {
  const entries = [row({}), question({}), question({ read: true }), question({ settled: true })];
  const sections = build(entries, { filter: "needs-you" });
  assert.deepEqual(sections.map((s) => [s.key, s.rows]), [["needs-you", 1], ["seen", 1]]);
});

test("the Unread filter hides read rows", () => {
  const entries = [row({ read: true }), row({})];
  const sections = build(entries, { filter: "unread" });
  assert.equal(sections[0].rows, 1);
});

test("the same agent finishing in several panes stacks under the newest", () => {
  const entries = [row({ count: 4 }), row({}), row({ count: 2 }), row({ title: "Codex finished" })];
  const [today] = build(entries);
  assert.equal(today.items.length, 2);
  assert.equal(today.items[0].type, "stack");
  assert.equal(today.items[0].entries.length, 3);
  assert.equal(today.rows, 4);
  assert.equal(V.stackTitle(today.items[0].entries, "api"), "Claude Code finished 7× in api");
  assert.equal(V.stackTitle(today.items[0].entries, null), "Claude Code finished 7×");
  // The control counts rows in their own unit, so "7×" and "3 panes" agree.
  assert.equal(V.stackMoreLabel(today.items[0].entries), "Show 3 panes");
  assert.equal(V.stackMoreLabel(today.items[0].entries.slice(0, 2)), "Show both panes");
  const samePane = [row({ sourceKey: "pane:x" }), row({ sourceKey: "pane:x" }), row({})];
  assert.equal(V.stackMoreLabel(samePane), "Show 3 notifications");
});

test("a stack of pull requests names them", () => {
  const pr = (n) => row({ kind: "git.pull-request", sourceKey: `github-pr:acme/api#${n}`, title: `sam opened PR #${n}` });
  assert.equal(V.stackTitle([pr(42), pr(41)], "api"), "Pull requests #41, #42 in api");
  assert.equal(V.stackTitle([pr(5), pr(4), pr(3), pr(2), pr(1)], null), "Pull requests #1, #2, #3 +2");
  assert.equal(V.stackMoreLabel([pr(42), pr(41)]), "Show both pull requests");
});

test("pushes from different people or repositories do not stack under one title", () => {
  const pushRow = (title, sourceKey) =>
    row({ kind: "git.teammate-push", title, sourceKey, target: { type: "workspace", workspaceId: "w1", panel: "git" } });
  const [today] = build([
    pushRow("alice pushed to api", "github-push:acme/api"),
    pushRow("bob pushed to web", "github-push:acme/web"),
    pushRow("alice pushed to api", "github-push:acme/api"),
  ]);
  assert.deepEqual(
    today.items.map((item) => (item.type === "stack" ? item.entries.length : 1)),
    [2, 1],
  );
  assert.equal(V.stackTitle(today.items[0].entries, "api"), "alice pushed to api 2× in api");
});

test("a folded push names its branches", () => {
  const pushRow = row({
    kind: "git.teammate-push",
    count: 52,
    body: "1 commit to feature/sync \u2014 Retry once",
    earlier: ["10 commits to main \u2014 Merge #65", "New commits to memory/review", "3 commits to main \u2014 Bump"],
  });
  assert.equal(V.foldSummary(pushRow), "52 pushes to feature/sync, main, memory/review");
  assert.equal(V.foldSummary({ ...pushRow, count: undefined }), null);
  assert.equal(V.foldSummary(row({ count: 3 })), null);
});

test("rows older than six days start folded under Older", () => {
  const entries = [row({}), row({ createdAt: iso(NOW - 9 * 24 * HOUR) })];
  const sections = build(entries);
  assert.equal(sections[1].key, "older");
  assert.equal(sections[1].collapsed, true);
  const alone = build([entries[1]]);
  assert.equal(alone[0].collapsed, false);
});

test("grouping by workspace makes one section per workspace with its name", () => {
  const entries = [
    row({}),
    row({ target: { type: "workspace", workspaceId: "w2" }, kind: "git.teammate-push", title: "bob pushed" }),
    row({ target: { type: "automation", jobId: "j" }, kind: "automation.finished", title: "Nightly", workspaceName: "ops" }),
  ];
  const sections = build(entries, { grouping: "workspace" });
  assert.deepEqual(sections.map((s) => s.label), ["api", "web", "ops"]);
  assert.equal(sections[0].color, "#f00");
  const many = Array.from({ length: 7 }, (_, i) => row({ title: `Agent ${i} finished` }));
  assert.equal(build(many, { grouping: "workspace" })[0].limit, 4);
});

test("clear all keeps open questions unless their target is gone", () => {
  const open = question({});
  const seen = question({ read: true });
  const goneQ = question({});
  const done = row({});
  const ids = V.clearableIds([open, seen, goneQ, done], (e) => e.id === goneQ.id);
  assert.deepEqual(ids, [goneQ.id, done.id]);
});

test("undo labels count what one Undo puts back", () => {
  assert.equal(V.undoLabel("Dismissed", 1), "Dismissed");
  assert.equal(V.undoLabel("Dismissed", 2), "Dismissed 2 notifications");
  assert.equal(V.undoLabel("Removed", 5), "Removed 5 notifications");
});

test("mute labels name what would go quiet", () => {
  assert.equal(V.sourceLabel(row({})), "Claude Code in server");
  assert.equal(V.sourceLabel(row({ kind: "git.teammate-push", sourceKey: "github-push:acme/api" })), "Pushes to api");
  assert.equal(V.sourceLabel(row({ kind: "git.pull-request", sourceKey: "github-pr:acme/api#12" })), "Pull request #12");
  assert.equal(V.sourceLabel(question({})), "This Cora run");
  assert.equal(
    V.sourceLabel(row({ kind: "automation.finished", body: "\u201cNightly sweep\u201d finished after 3 iterations." })),
    "Nightly sweep",
  );
});

test("the mute menu offers the source, the agent everywhere, then the workspace", () => {
  const ws = { id: "w1", name: "api" };
  const keys = (entry, gone = false) => V.muteChoices(entry, ws, gone).map((c) => [c.key, c.label]);
  assert.deepEqual(keys(row({ sourceKey: "pane:p7" })), [
    ["source:pane:p7", "Claude Code in server"],
    ["agent:claude-code", "Claude Code everywhere"],
    ["workspace:w1", "Everything in api"],
  ]);
  // A closed pane will never notify again: nothing to mute at the source.
  assert.deepEqual(keys(row({ sourceKey: "pane:p7" }), true).map(([k]) => k), ["agent:claude-code", "workspace:w1"]);
  // A finished run will not either; a blocked one still can.
  const done = row({ kind: "run.complete", title: "Codara Studio \u2014 done", sourceKey: "run:r1", target: { type: "run", runId: "r1", workspaceId: "w1" } });
  assert.deepEqual(keys(done).map(([k]) => k), ["agent:cora", "workspace:w1"]);
  assert.deepEqual(keys(question({ sourceKey: "run:r2" })).map(([, l]) => l), ["This Cora run", "All Cora runs", "Everything in api"]);
  // An automation mutes by job, so every run it starts goes quiet.
  const loom = row({ kind: "automation.blocked", title: "Automation \u2014 needs you", sourceKey: "run:r3", target: { type: "automation", jobId: "j1", runId: "r3" } });
  assert.deepEqual(V.muteChoices(loom, { id: null, name: null }, false).map((c) => c.key), ["job:j1", "agent:automations"]);
});

test("until morning means the next 08:00", () => {
  const ms = V.untilMorningMs(NOW);
  const at = new Date(NOW + ms);
  assert.equal(at.getHours(), 8);
  assert.equal(at.getDate(), 13);
  // Muting at 01:30 means this morning, not a day and a half.
  const night = new Date(2026, 9, 13, 1, 30, 0).getTime();
  const wake = new Date(night + V.untilMorningMs(night));
  assert.equal(wake.getDate(), 13);
  assert.equal(wake.getHours(), 8);
  const eight = new Date(2026, 9, 13, 8, 0, 0).getTime();
  assert.equal(new Date(eight + V.untilMorningMs(eight)).getDate(), 14);
  assert.equal(V.remainingLabel(NOW + 30 * 60_000, NOW), "30m left");
  assert.equal(V.remainingLabel(NOW + 5 * HOUR, NOW), "5h left");
});

function harness(statusFor) {
  const calls = [];
  const navigate = R.createNavigateTo({
    selectRun: (runId, ws) => calls.push(["run", runId, ws]),
    focusTerminal: (t) => calls.push(["terminal", t.paneId]),
    openAutomations: () => calls.push(["automations"]),
    openWorkspace: (ws, panel) => calls.push(["workspace", ws, panel]),
    describeTarget: statusFor,
    explain: (title) => calls.push(["explain", title]),
  });
  return { navigate, calls };
}

test("a live target opens exactly", () => {
  const { navigate, calls } = harness(() => ({ state: "live" }));
  assert.equal(navigate({ type: "terminal", workspaceId: "w1", tabId: "t", paneId: "p1" }), "opened");
  assert.deepEqual(calls, [["terminal", "p1"]]);
});

test("a closed pane opens its workspace and says so", () => {
  const { navigate, calls } = harness(() => ({ state: "gone", reason: "pane" }));
  assert.equal(navigate({ type: "terminal", workspaceId: "w1", tabId: "t", paneId: "p1" }), "fallback");
  assert.deepEqual(calls, [["workspace", "w1", undefined], ["explain", "That pane was closed"]]);
});

test("a deleted run opens its workspace", () => {
  const { navigate, calls } = harness(() => ({ state: "gone", reason: "run" }));
  assert.equal(navigate({ type: "run", runId: "r1", workspaceId: "w1" }), "fallback");
  assert.equal(calls[0][0], "workspace");
});

test("a removed workspace opens nothing and explains", () => {
  const { navigate, calls } = harness(() => ({ state: "gone", reason: "workspace" }));
  assert.equal(navigate({ type: "workspace", workspaceId: "w9" }), "gone");
  assert.deepEqual(calls, [["explain", "Can't open this notification"]]);
});

test("a malformed target is gone without calling anything", () => {
  const { navigate, calls } = harness(() => ({ state: "live" }));
  assert.equal(navigate(null), "gone");
  assert.deepEqual(calls, []);
});

(async () => {
  V = await load(path.join(NOTIFY_DIR, "center-view.ts"));
  R = await load(path.join(NOTIFY_DIR, "routing.ts"));
  S = await load(path.join(SHARED_DIR, "notify-center.ts"));
  for (const { name, fn } of tests) {
    fn();
    console.log(`  PASS ${name}`);
  }
  console.log(`notify-center-view: ${tests.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
