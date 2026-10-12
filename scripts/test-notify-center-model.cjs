#!/usr/bin/env node
"use strict";

// Unit tests for the notification center's pure list operations
// (src/main/notify/center-model.ts) and the shared vocabulary they use
// (src/shared/notify-center.ts): folding repeats per source, eviction that
// protects questions, age limits, settling, view acknowledgement, the badge
// summary, and the one-time coalescing of a history written by older builds.
//
//   node scripts/test-notify-center-model.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");

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
        name: "shared-alias",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
          }));
        },
      },
    ],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let M;
let S;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

let seq = 0;
function event(fields) {
  seq += 1;
  return {
    id: `n${seq}`,
    kind: "terminal.agent.done",
    sourceKey: "pane:p1",
    title: "Claude Code finished",
    body: "Finished its turn.",
    tone: "success",
    soundKind: "done",
    target: { type: "terminal", workspaceId: "w1", tabId: "t1", paneId: "p1" },
    createdAt: iso(NOW),
    ...fields,
  };
}
function row(fields) {
  return { read: false, ...event(fields) };
}
const push = (fields) =>
  event({
    kind: "git.teammate-push",
    sourceKey: "github-push:acme/api",
    title: "release-bot pushed to api",
    silent: true,
    target: { type: "workspace", workspaceId: "w1", panel: "git" },
    ...fields,
  });

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("repeats from one pane fold into one row that counts them", () => {
  const list = [];
  M.insertEntry(list, event({ createdAt: iso(NOW - 30 * MIN) }), { read: false }, NOW - 30 * MIN);
  M.insertEntry(list, event({ createdAt: iso(NOW - 20 * MIN) }), { read: false }, NOW - 20 * MIN);
  M.insertEntry(list, event({ createdAt: iso(NOW) }), { read: false }, NOW);
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 3);
  assert.equal(list[0].firstAt, iso(NOW - 30 * MIN));
});

test("a new state replaces the pane's stale question without losing the count", () => {
  const list = [];
  M.insertEntry(list, event({ createdAt: iso(NOW - 40 * MIN) }), { read: false }, NOW - 40 * MIN);
  M.insertEntry(list, event({ createdAt: iso(NOW - 30 * MIN) }), { read: false }, NOW - 30 * MIN);
  M.insertEntry(list, event({ kind: "terminal.agent.needs-input", createdAt: iso(NOW - 20 * MIN) }), { read: false }, NOW - 20 * MIN);
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "terminal.agent.needs-input");
  assert.equal(list[0].count, undefined);
  assert.deepEqual(list[0].kindCounts, {
    "terminal.agent.done": { count: 2, firstAt: iso(NOW - 40 * MIN), earlier: ["Finished its turn."] },
  });
  M.insertEntry(list, event({}), { read: false }, NOW);
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "terminal.agent.done");
  assert.equal(list[0].count, 3, "finished 3 times, the prompt in between does not reset it");
  assert.equal(list[0].firstAt, iso(NOW - 40 * MIN));
  assert.deepEqual(list[0].kindCounts, {
    "terminal.agent.needs-input": { count: 1, firstAt: iso(NOW - 20 * MIN), earlier: ["Finished its turn."] },
  });
});

test("a folded row keeps its last three distinct bodies, newest first", () => {
  const list = [];
  const bodies = [
    "6 commits to main \u2014 Merge pull request #64",
    "New commits to memory/hooks",
    "New commits to memory/hooks",
    "9 commits to memory/review \u2014 Merge origin/main",
    "10 commits to main \u2014 Merge pull request #65",
    "New commits to memory/review",
  ];
  bodies.forEach((body, i) => M.insertEntry(list, push({ body }), { read: false }, NOW + i));
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 6);
  assert.equal(list[0].body, "New commits to memory/review");
  assert.deepEqual(list[0].earlier, [
    "10 commits to main \u2014 Merge pull request #65",
    "9 commits to memory/review \u2014 Merge origin/main",
    "New commits to memory/hooks",
  ]);
});

test("earlier bodies come only from the same kind", () => {
  const list = [];
  M.insertEntry(list, event({ body: "Refactored the parser" }), { read: false }, NOW);
  M.insertEntry(list, event({ kind: "terminal.agent.needs-input", body: "Allow npm test?" }), { read: false }, NOW);
  M.insertEntry(list, event({ body: "Fixed the flaky test" }), { read: false }, NOW);
  assert.deepEqual(list[0].earlier, ["Refactored the parser"]);
});

test("teammate pushes and pull-request updates fold per source too", () => {
  const list = [];
  for (let i = 0; i < 40; i += 1) M.insertEntry(list, push({}), { read: false }, NOW);
  M.insertEntry(list, push({ sourceKey: "github-pr:acme/api#7", kind: "git.pull-request" }), { read: false }, NOW);
  M.insertEntry(list, push({ sourceKey: "github-pr:acme/api#7", kind: "git.pull-request" }), { read: false }, NOW);
  assert.equal(list.length, 2);
  assert.equal(list.find((e) => e.kind === "git.teammate-push").count, 40);
  assert.equal(list.find((e) => e.kind === "git.pull-request").count, 2);
});

test("an old read row stays as history and a new event starts a fresh row", () => {
  const list = [];
  M.insertEntry(list, push({ createdAt: iso(NOW - 2 * DAY) }), { read: true }, NOW - 2 * DAY);
  M.insertEntry(list, push({}), { read: false }, NOW);
  assert.equal(list.length, 2);
  assert.equal(list[0].read, false);
  assert.equal(list[0].count, undefined);
});

test("a recent read row still folds, and the folded row is unread again", () => {
  const list = [];
  M.insertEntry(list, push({ createdAt: iso(NOW - HOUR) }), { read: true }, NOW - HOUR);
  M.insertEntry(list, push({}), { read: false }, NOW);
  assert.equal(list.length, 1);
  assert.equal(list[0].read, false);
  assert.equal(list[0].count, 2);
});

test("loom Notify steps fold only when the message is the same", () => {
  const list = [];
  const step = (body) =>
    event({ kind: "automation.step", sourceKey: "automation:j1", body, target: { type: "automation", jobId: "j1" } });
  M.insertEntry(list, step("Opened 2 PRs"), { read: false }, NOW);
  M.insertEntry(list, step("All green"), { read: false }, NOW);
  M.insertEntry(list, step("All green"), { read: false }, NOW);
  assert.equal(list.length, 2);
  assert.equal(list[0].count, 2);
});

test("folding removes every earlier copy, not just the first", () => {
  const list = [row({ id: "a" }), row({ id: "b" }), row({ id: "c", sourceKey: "pane:other" })];
  M.insertEntry(list, event({ id: "d" }), { read: false }, NOW);
  assert.deepEqual(list.map((e) => e.id), ["d", "c"]);
  assert.equal(list[0].count, 3);
});

test("over the cap, read rows go first and questions go last", () => {
  const list = [
    row({ id: "q", kind: "run.blocked", sourceKey: "run:r1", createdAt: iso(NOW - 3 * HOUR) }),
    row({ id: "info", kind: "git.teammate-push", sourceKey: "s2", createdAt: iso(NOW - 2 * HOUR) }),
    { ...row({ id: "old-read", sourceKey: "s3", createdAt: iso(NOW - HOUR) }), read: true },
    row({ id: "new", sourceKey: "s4" }),
  ].reverse();
  M.evictToCap(list, 3);
  assert.deepEqual(list.map((e) => e.id).sort(), ["info", "new", "q"]);
  M.evictToCap(list, 2);
  assert.deepEqual(list.map((e) => e.id).sort(), ["new", "q"]);
});

test("over the cap, a question read but still open outlives unread history", () => {
  const list = [
    { ...row({ id: "seen-q", kind: "run.blocked", sourceKey: "run:r1", createdAt: iso(NOW - 3 * HOUR) }), read: true },
    row({ id: "push-a", kind: "git.teammate-push", sourceKey: "s2", createdAt: iso(NOW - 2 * HOUR) }),
    row({ id: "push-b", kind: "git.teammate-push", sourceKey: "s3", createdAt: iso(NOW - HOUR) }),
  ].reverse();
  M.evictToCap(list, 2);
  assert.deepEqual(list.map((e) => e.id).sort(), ["push-b", "seen-q"]);
});

test("a newer state settles a question the fold left behind as history", () => {
  const list = [];
  M.insertEntry(
    list,
    event({ id: "ask", kind: "run.blocked", sourceKey: "run:r1", createdAt: iso(NOW - 8 * HOUR) }),
    { read: true },
    NOW - 8 * HOUR,
  );
  M.insertEntry(list, event({ id: "fail", kind: "run.failed", sourceKey: "run:r1" }), { read: false }, NOW);
  assert.deepEqual(list.map((e) => e.id), ["fail", "ask"]);
  assert.equal(list[1].settled, true);
  assert.equal(S.isOpenQuestion(list[1]), false);
  // Another source's question is untouched.
  M.insertEntry(list, event({ id: "other", kind: "run.blocked", sourceKey: "run:r2" }), { read: true }, NOW);
  M.insertEntry(list, event({ id: "next", kind: "run.complete", sourceKey: "run:r3" }), { read: false }, NOW);
  assert.equal(list.find((e) => e.id === "other").settled, undefined);
});

test("age limits: read rows after a week, anything after a month", () => {
  const list = [
    { ...row({ id: "read-8d", sourceKey: "a", createdAt: iso(NOW - 8 * DAY) }), read: true },
    row({ id: "unread-8d", sourceKey: "b", createdAt: iso(NOW - 8 * DAY) }),
    row({ id: "unread-31d", sourceKey: "c", createdAt: iso(NOW - 31 * DAY) }),
    { ...row({ id: "read-1d", sourceKey: "d", createdAt: iso(NOW - DAY) }), read: true },
  ];
  assert.equal(M.pruneByAge(list, NOW), true);
  assert.deepEqual(list.map((e) => e.id), ["unread-8d", "read-1d"]);
});

test("a read question still open keeps the month; a settled one goes after a week", () => {
  const ask = (fields) => ({ ...row({ kind: "run.blocked", ...fields }), read: true });
  const list = [
    ask({ id: "open-8d", sourceKey: "run:a", createdAt: iso(NOW - 8 * DAY) }),
    { ...ask({ id: "settled-8d", sourceKey: "run:b", createdAt: iso(NOW - 8 * DAY) }), settled: true },
    ask({ id: "open-31d", sourceKey: "run:c", createdAt: iso(NOW - 31 * DAY) }),
  ];
  assert.equal(M.pruneByAge(list, NOW), true);
  assert.deepEqual(list.map((e) => e.id), ["open-8d"]);
});

test("settling by id touches only open questions among those ids", () => {
  const list = [
    row({ id: "q1", kind: "terminal.agent.needs-input", sourceKey: "pane:a" }),
    row({ id: "q2", kind: "run.blocked", sourceKey: "run:b" }),
    row({ id: "done", sourceKey: "pane:c" }),
  ];
  assert.equal(M.settleIds(list, ["q1", "done"]), true);
  assert.deepEqual(
    list.map((e) => [e.id, e.settled === true, e.read]),
    [["q1", true, true], ["q2", false, false], ["done", false, false]],
  );
  assert.equal(M.settleIds(list, ["q1"]), false);
});

test("sanitize drops rows a renderer could not show and bounds the rest", () => {
  const list = M.sanitizeEntries([
    row({ id: "ok", title: 42, body: null }),
    row({ id: "ok" }),
    row({ id: "bad-date", createdAt: "yesterday" }),
    { ...row({ id: "no-target" }), target: null },
    { ...row({ id: "count" }), count: "7", settled: "yes" },
    "junk",
  ]);
  assert.deepEqual(list.map((e) => e.id), ["ok", "count"]);
  assert.equal(list[0].title, "");
  assert.equal(list[0].body, "");
  assert.equal(list[1].count, undefined);
  assert.equal(list[1].settled, undefined);
});

test("coalescing an old history folds a chatty bot into one row", () => {
  const raw = [];
  for (let i = 0; i < 43; i += 1) raw.push(row({ ...push({}), createdAt: iso(NOW - (43 - i) * 30 * MIN) }));
  raw.push(row({ id: "pane", createdAt: iso(NOW - 10 * MIN) }));
  raw.push(row({ id: "pane-dup", createdAt: iso(NOW - 5 * MIN) }));
  const list = M.sanitizeEntries(raw);
  assert.equal(M.coalesceEntries(list), true);
  assert.equal(list.length, 2);
  const pushes = list.find((e) => e.kind === "git.teammate-push");
  assert.equal(pushes.count, 43);
  assert.equal(pushes.firstAt, iso(NOW - 43 * 30 * MIN));
  assert.equal(list[0].id, "pane-dup");
  assert.equal(list[0].count, 2);
});

test("coalescing keeps a row's own count when nothing folds into it", () => {
  const list = [{ ...row({ id: "x" }), count: 5, firstAt: iso(NOW - HOUR) }];
  M.coalesceEntries(list);
  assert.equal(list[0].count, 5);
  assert.equal(list[0].firstAt, iso(NOW - HOUR));
});

test("settling a source marks its questions read and settled, nothing else", () => {
  const list = [
    row({ id: "q", kind: "run.blocked", sourceKey: "run:r1" }),
    row({ id: "done", kind: "run.complete", sourceKey: "run:r1" }),
    row({ id: "other", kind: "run.blocked", sourceKey: "run:r2" }),
  ];
  assert.equal(M.settleSource(list, "run:r1"), true);
  assert.equal(list[0].settled, true);
  assert.equal(list[0].read, true);
  assert.equal(list[1].read, false);
  assert.equal(list[2].settled, undefined);
  assert.equal(M.settleSource(list, "run:r1"), false);
});

test("settling a stopped automation settles its iteration questions, nothing else", () => {
  const loom = (id, jobId, fields = {}) =>
    row({
      id,
      kind: "automation.blocked",
      sourceKey: `run:${id}`,
      target: { type: "automation", jobId, runId: id, workspaceId: "w1" },
      ...fields,
    });
  const list = [
    loom("i1", "job1"),
    loom("i2", "job1"),
    loom("i3", "job2"),
    row({ id: "fin", kind: "automation.finished", sourceKey: "automation:job1", target: { type: "automation", jobId: "job1" } }),
  ];
  assert.equal(M.settleJob(list, "job1"), true);
  assert.deepEqual(
    list.map((e) => [e.id, e.settled === true, e.read]),
    [["i1", true, true], ["i2", true, true], ["i3", false, false], ["fin", false, false]],
  );
  assert.equal(M.settleJob(list, "job1"), false);
});

test("terminal prompts from a previous session are settled at launch", () => {
  const list = [row({ id: "p", kind: "terminal.agent.needs-input" }), row({ id: "r", kind: "run.blocked", sourceKey: "run:r" })];
  assert.equal(M.settleTerminalQuestions(list), true);
  assert.equal(list[0].settled, true);
  assert.equal(list[1].settled, undefined);
});

test("questions from deleted workspaces are settled, others kept", () => {
  const list = [
    row({ id: "gone", kind: "run.blocked", sourceKey: "run:r", target: { type: "run", runId: "r", workspaceId: "w-gone" } }),
    row({ id: "here", kind: "run.blocked", sourceKey: "run:s", target: { type: "run", runId: "s", workspaceId: "w1" } }),
  ];
  assert.equal(M.settleMissingWorkspaces(list, new Set(["w1"])), true);
  assert.equal(list[0].settled, true);
  assert.equal(list[1].settled, undefined);
});

test("removing a deleted workspace drops its rows", () => {
  const list = [row({ id: "a" }), row({ id: "b", target: { type: "workspace", workspaceId: "w2" } })];
  assert.equal(M.removeWorkspaces(list, new Set(["w1"])), true);
  assert.deepEqual(list.map((e) => e.id), ["b"]);
});

test("viewing marks exact targets read and keeps them", () => {
  const list = [
    row({ id: "pane" }),
    row({ id: "other-pane", target: { type: "terminal", workspaceId: "w1", tabId: "t1", paneId: "p2" } }),
    row({ id: "run", kind: "run.complete", target: { type: "run", runId: "r1", workspaceId: "w1" } }),
    row({ id: "loom", kind: "automation.failed", target: { type: "automation", jobId: "j", workspaceId: "w1" } }),
    row({ id: "step", kind: "automation.step", target: { type: "automation", jobId: "j", runId: "r1", workspaceId: "w1" } }),
    row({ id: "push", kind: "git.teammate-push", target: { type: "workspace", workspaceId: "w1" } }),
  ];
  const changed = M.markViewed(list, {
    workspaceId: "w1",
    visibleRunId: "r1",
    terminal: { workspaceId: "w1", tabId: "t1", paneId: "p1" },
  });
  assert.equal(changed, true);
  assert.equal(list.length, 6);
  assert.deepEqual(list.filter((e) => e.read).map((e) => e.id), ["pane", "run"]);
});

test("a run in another workspace is not acknowledged by a stale view", () => {
  assert.equal(
    S.isTargetViewed({ type: "run", runId: "r1", workspaceId: "w2" }, { workspaceId: "w1", visibleRunId: "r1", terminal: null }),
    false,
  );
  assert.equal(
    S.isTargetViewed({ type: "run", runId: "r1" }, { workspaceId: "w1", visibleRunId: "r1", terminal: null }),
    true,
  );
});

test("restore puts dismissed rows back by date and skips present ids", () => {
  const list = [row({ id: "new", createdAt: iso(NOW) }), row({ id: "old", sourceKey: "x", createdAt: iso(NOW - DAY) })];
  const back = [row({ id: "mid", sourceKey: "y", createdAt: iso(NOW - HOUR) }), row({ id: "new" })];
  assert.equal(M.restoreEntries(list, back), true);
  assert.deepEqual(list.map((e) => e.id), ["new", "mid", "old"]);
  assert.equal(M.restoreEntries(list, back), false);
});

test("the badge counts unread open questions that are not muted", () => {
  const list = [
    row({ id: "q1", kind: "run.blocked", sourceKey: "run:r1", target: { type: "run", runId: "r1", workspaceId: "w1" } }),
    row({ id: "q2", kind: "terminal.agent.needs-input", sourceKey: "pane:p9", target: { type: "terminal", workspaceId: "w2", tabId: "t", paneId: "p9" } }),
    { ...row({ id: "q3", kind: "automation.blocked", sourceKey: "run:r3" }), settled: true },
    { ...row({ id: "q4", kind: "run.blocked", sourceKey: "run:r4" }), read: true },
    row({ id: "push", kind: "git.teammate-push", sourceKey: "github-push:x" }),
    row({ id: "fail", kind: "run.failed", sourceKey: "run:r5" }),
  ];
  // The failure is notable (the bell's dot); the teammate push is not.
  assert.deepEqual(M.summarize(list, [], NOW), { unread: 5, needsYou: 2, notable: 2, mutes: [] });
  const mutes = [
    { key: S.workspaceMuteKey("w2"), label: "w2", until: NOW + HOUR },
    { key: S.sourceMuteKey("run:r1"), label: "lapsed", until: NOW - 1 },
  ];
  const summary = M.summarize(list, mutes, NOW);
  assert.equal(summary.needsYou, 1);
  assert.deepEqual(summary.mutes.map((m) => m.key), ["workspace:w2"]);
});

test("a mute matches the event's source, workspace or agent until it lapses", () => {
  const e = {
    kind: "terminal.agent.done",
    title: "Claude Code finished · server",
    sourceKey: "pane:p1",
    target: { type: "terminal", workspaceId: "w1", tabId: "t", paneId: "p1" },
  };
  assert.ok(S.mutedBy(e, [{ key: "agent:claude-code", label: "", until: NOW + 1 }], NOW));
  assert.equal(S.mutedBy({ ...e, title: "Codex finished" }, [{ key: "agent:claude-code", label: "", until: NOW + 1 }], NOW), null);
  const run = { kind: "run.blocked", title: "Codara Studio \u2014 needs you", sourceKey: "run:r1", target: { type: "run", runId: "r1" } };
  assert.ok(S.mutedBy(run, [{ key: "agent:cora", label: "", until: NOW + 1 }], NOW));
  const loom = {
    kind: "automation.blocked",
    title: "Automation \u2014 needs you",
    sourceKey: "run:r2",
    target: { type: "automation", jobId: "j1", runId: "r2" },
  };
  assert.ok(S.mutedBy(loom, [{ key: "job:j1", label: "", until: NOW + 1 }], NOW));
  assert.ok(S.mutedBy(loom, [{ key: "agent:automations", label: "", until: NOW + 1 }], NOW));
  assert.ok(S.mutedBy(e, [{ key: "source:pane:p1", label: "", until: NOW + 1 }], NOW));
  assert.ok(S.mutedBy(e, [{ key: "workspace:w1", label: "", until: NOW + 1 }], NOW));
  assert.equal(S.mutedBy(e, [{ key: "workspace:w1", label: "", until: NOW }], NOW), null);
  assert.equal(S.mutedBy(e, [{ key: "workspace:w2", label: "", until: NOW + 1 }], NOW), null);
  assert.deepEqual(
    M.sanitizeMutes([{ key: "workspace:w1", until: NOW + 1 }, { key: "", until: NOW + 1 }, { key: "x", until: NOW - 1 }], NOW),
    [{ key: "workspace:w1", label: "workspace:w1", until: NOW + 1 }],
  );
});

test("clear all keeps the questions still waiting, read or not", () => {
  const list = [
    row({ id: "open", kind: "run.blocked", sourceKey: "run:r1" }),
    { ...row({ id: "seen", kind: "terminal.agent.needs-input", sourceKey: "pane:p2" }), read: true },
    { ...row({ id: "answered", kind: "run.blocked", sourceKey: "run:r3" }), settled: true },
    row({ id: "done" }),
    push({ id: "push" }),
  ];
  assert.equal(M.clearExceptOpen(list), true);
  assert.deepEqual(list.map((e) => e.id), ["open", "seen"]);
  assert.equal(M.clearExceptOpen(list), false);
});

test("sanitize keeps valid per-kind counts and earlier bodies and drops the rest", () => {
  const entry = M.sanitizeEntry({
    ...row({ body: "latest" }),
    kindCounts: {
      "terminal.agent.needs-input": { count: 2.7, firstAt: iso(NOW) },
      "terminal.agent.done": { count: 4, firstAt: iso(NOW) },
      "run.failed": { count: "x", firstAt: iso(NOW) },
      "run.complete": { count: 1, firstAt: "garbage" },
    },
    earlier: ["latest", "one", 7, "", "one", "two", "three", "four"],
  });
  assert.deepEqual(entry.kindCounts, { "terminal.agent.needs-input": { count: 2, firstAt: iso(NOW) } });
  assert.deepEqual(entry.earlier, ["one", "two", "three"]);
  const bare = M.sanitizeEntry({ ...row({}), kindCounts: [], earlier: "nope" });
  assert.equal("kindCounts" in bare, false);
  assert.equal("earlier" in bare, false);
});

test("the badge rule: unread, open, not muted, not gone", () => {
  const q = row({ id: "q", kind: "run.blocked", sourceKey: "run:r1", target: { type: "run", runId: "r1", workspaceId: "w1" } });
  assert.equal(S.countsAsNeedsYou(q, [], NOW), true);
  assert.equal(S.countsAsNeedsYou({ ...q, read: true }, [], NOW), false);
  assert.equal(S.countsAsNeedsYou({ ...q, settled: true }, [], NOW), false);
  assert.equal(S.countsAsNeedsYou(q, [{ key: "workspace:w1", label: "", until: NOW + 1 }], NOW), false);
  assert.equal(S.countsAsNeedsYou(q, [], NOW, () => true), false);
  assert.equal(S.countsAsNeedsYou(row({}), [], NOW), false);
});

test("the agent behind an event, named the same across panes", () => {
  const term = (title) => S.agentOf({ kind: "terminal.agent.done", title });
  assert.deepEqual(term("Claude Code finished · server"), { id: "claude-code", label: "Claude Code" });
  assert.deepEqual(term("Codex needs you"), { id: "codex", label: "Codex" });
  assert.deepEqual(term("Grok finished background work · tests"), { id: "grok", label: "Grok" });
  assert.deepEqual(term("Claude Code \u2014 finished"), { id: "claude-code", label: "Claude Code" });
  assert.equal(term("Agent finished"), null);
  assert.equal(term("Something else"), null);
  assert.equal(S.agentOf({ kind: "git.teammate-push", title: "bob pushed" }), null);
  assert.equal(S.agentOf({ kind: "run.complete", title: "" }).id, "cora");
  assert.ok(S.MUTE_KEY_PATTERN.test("agent:codex"));
  assert.ok(S.MUTE_KEY_PATTERN.test("job:loom-1"));
  assert.ok(!S.MUTE_KEY_PATTERN.test("everything"));
});

test("state vocabulary: needs-you, failed, done, info", () => {
  assert.equal(S.notifyState("automation.blocked"), "needs-you");
  assert.equal(S.notifyState("terminal.agent.failed"), "failed");
  assert.equal(S.notifyState("automation.finished"), "done");
  assert.equal(S.notifyState("git.pull-request"), "info");
});

(async () => {
  M = await load(path.join(ROOT, "src", "main", "notify", "center-model.ts"));
  S = await load(path.join(SHARED_DIR, "notify-center.ts"));
  for (const { name, fn } of tests) {
    fn();
    console.log(`  PASS ${name}`);
  }
  console.log(`notify-center-model: ${tests.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
