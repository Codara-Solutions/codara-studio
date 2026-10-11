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

test("display text drops the brand prefix and moves the tab to the context", () => {
  assert.deepEqual(V.displayText(row({})), { title: "Claude Code finished", context: "server" });
  assert.deepEqual(V.displayText(question({})), { title: "Cora needs you", context: null });
  assert.deepEqual(V.displayText(row({ title: "" })), { title: "Agent finished", context: null });
  assert.deepEqual(V.displayText(row({ title: "Deploy done" })), { title: "Deploy done", context: null });
});

test("relative times: now, minutes, hours, then a day or a clock time", () => {
  assert.equal(V.rowTime(iso(NOW - 10_000), NOW, true), "now");
  assert.equal(V.rowTime(iso(NOW - 5 * 60_000), NOW, true), "5m");
  assert.equal(V.rowTime(iso(NOW - 3 * HOUR), NOW, true), "3h");
  assert.equal(V.rowTime(iso(NOW - 24 * HOUR), NOW, true), "Yesterday");
  assert.match(V.rowTime(iso(NOW - 24 * HOUR), NOW, false), /\d/);
  assert.equal(V.rowTime("garbage", NOW, true), "");
});

test("open questions are pinned above the days, read or not", () => {
  const entries = [row({}), question({ read: true }), question({}), row({ createdAt: iso(NOW - 30 * HOUR) })];
  const sections = V.buildSections(entries, { filter: "all", grouping: "time", now: NOW, workspaces: WORKSPACES });
  assert.deepEqual(sections.map((s) => s.key), ["needs-you", "d0", "d1"]);
  assert.equal(sections[0].rows, 2);
  assert.equal(sections[0].limit, 3);
});

test("a settled question or one whose target is gone is not pinned", () => {
  const settled = question({ settled: true });
  const gone = question({});
  const sections = V.buildSections([settled, gone], {
    filter: "all",
    grouping: "time",
    now: NOW,
    workspaces: WORKSPACES,
    isGone: (e) => e.id === gone.id,
  });
  assert.deepEqual(sections.map((s) => s.key), ["d0"]);
  assert.deepEqual(V.filterCounts([settled, gone], (e) => e.id === gone.id), { all: 2, "needs-you": 0, unread: 2 });
});

test("the Needs you filter lists only open questions, without a pinned copy", () => {
  const entries = [row({}), question({}), question({ settled: true })];
  const sections = V.buildSections(entries, { filter: "needs-you", grouping: "time", now: NOW, workspaces: WORKSPACES });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].key, "d0");
  assert.equal(sections[0].rows, 1);
});

test("the Unread filter hides read rows", () => {
  const entries = [row({ read: true }), row({})];
  const sections = V.buildSections(entries, { filter: "unread", grouping: "time", now: NOW, workspaces: WORKSPACES });
  assert.equal(sections[0].rows, 1);
});

test("the same agent finishing in several panes stacks under the newest", () => {
  const entries = [row({}), row({}), row({}), row({ title: "Codex finished" })];
  const [today] = V.buildSections(entries, { filter: "all", grouping: "time", now: NOW, workspaces: WORKSPACES });
  assert.equal(today.items.length, 2);
  assert.equal(today.items[0].type, "stack");
  assert.equal(today.items[0].entries.length, 3);
  assert.equal(today.rows, 4);
});

test("rows older than six days start folded under Older", () => {
  const entries = [row({}), row({ createdAt: iso(NOW - 9 * 24 * HOUR) })];
  const sections = V.buildSections(entries, { filter: "all", grouping: "time", now: NOW, workspaces: WORKSPACES });
  assert.equal(sections[1].key, "older");
  assert.equal(sections[1].collapsed, true);
  const alone = V.buildSections([entries[1]], { filter: "all", grouping: "time", now: NOW, workspaces: WORKSPACES });
  assert.equal(alone[0].collapsed, false);
});

test("grouping by workspace makes one section per workspace with its name", () => {
  const entries = [
    row({}),
    row({ target: { type: "workspace", workspaceId: "w2" }, kind: "git.teammate-push", title: "bob pushed" }),
    row({ target: { type: "automation", jobId: "j" }, kind: "automation.finished", title: "Nightly", workspaceName: "ops" }),
  ];
  const sections = V.buildSections(entries, { filter: "all", grouping: "workspace", now: NOW, workspaces: WORKSPACES });
  assert.deepEqual(sections.map((s) => s.label), ["api", "web", "ops"]);
  assert.equal(sections[0].color, "#f00");
  assert.equal(sections[0].limit, 4);
});

test("mute labels name what would go quiet", () => {
  assert.equal(V.sourceLabel(row({})), "Claude Code in server");
  assert.equal(V.sourceLabel(row({ kind: "git.teammate-push", sourceKey: "github-push:acme/api" })), "Pushes to api");
  assert.equal(V.sourceLabel(row({ kind: "git.pull-request", sourceKey: "github-pr:acme/api#12" })), "Pull request #12");
  assert.equal(V.sourceLabel(question({})), "This Cora run");
});

test("until tomorrow morning means the next 08:00", () => {
  const ms = V.untilTomorrowMs(NOW);
  const at = new Date(NOW + ms);
  assert.equal(at.getHours(), 8);
  assert.equal(at.getDate(), 13);
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
  for (const { name, fn } of tests) {
    fn();
    console.log(`  PASS ${name}`);
  }
  console.log(`notify-center-view: ${tests.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
