#!/usr/bin/env node
"use strict";

// Unit tests for src/main/agent-turn-ledger.ts, the agent turn times the
// worktree idle clock reads: per workspace and folder, written at each turn
// edge, kept across restarts, and never forgetting in a way that makes a
// folder look idle (the floor). Temporary files only.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const DAY = 24 * 60 * 60_000;

const TESTS = [];
function test(name, fn) {
  TESTS.push({ name, fn });
}

const inFolder = (dir) => (_workspaceId, cwd) => cwd === dir;
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("a turn's edge is on disk at once; a stamp inside a turn at most once a minute", ({ mod, temp }) => {
  const file = path.join(temp, "edges", "agent-turns.json");
  mod.persistAgentTurns(file, 1_000_000);
  mod.noteAgentTurn("ws-1", ["/work/a"], 1_000_000, true);
  // No flush: a forced restart right after the edge keeps it.
  assert.deepEqual(read(file).entries, [{ at: 1_000_000, workspaceId: "ws-1", cwd: "/work/a" }]);
  mod.noteAgentTurn("ws-1", ["/work/a"], 1_010_000, false);
  assert.equal(read(file).entries[0].at, 1_000_000, "a stamp inside the turn waits");
  // The turn ends five seconds later: on disk at once, not after a minute.
  mod.noteAgentTurn("ws-1", ["/work/a"], 1_015_000, true);
  assert.equal(read(file).entries[0].at, 1_015_000, "the end of a turn right after its start");
  mod.noteAgentTurn("ws-1", ["/work/a"], 1_020_000, false);
  assert.equal(read(file).entries[0].at, 1_015_000, "a stamp inside the next turn waits");
  mod.noteAgentTurn("ws-1", ["/work/a"], 1_080_000, false);
  assert.equal(read(file).entries[0].at, 1_080_000, "and is written a minute on");
  mod.noteAgentTurn("ws-1", ["/work/a"], 1_090_000, false);
  mod.flushAgentTurns();
  assert.equal(read(file).entries[0].at, 1_090_000, "the quit writes what is left");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("times come back after a restart; an old time never replaces a newer one", ({ mod, temp }) => {
  const file = path.join(temp, "restart.json");
  mod.persistAgentTurns(file, DAY);
  mod.noteAgentTurn("ws-1", ["/work/a", "/work/b"], 2 * DAY, true);
  mod.__resetAgentTurnsForTests();
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/a")), null, "a restart without the file forgets");
  mod.noteAgentTurn("ws-1", ["/work/b"], 3 * DAY, false);
  mod.persistAgentTurns(file, 5 * DAY);
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/a")), 2 * DAY);
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/b")), 3 * DAY, "the newer time this run saw stays");
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/c")), DAY, "the floor of the file's first run, not the restart's");
  assert.equal(mod.lastAgentTurnAt((workspaceId) => workspaceId === "ws-1"), 3 * DAY);
});

test("panes share their folder's entry: however many write, a folder's recent time stays", ({ mod }) => {
  mod.noteAgentTurn("ws-1", ["/work/keep"], 10 * DAY, true);
  // Thousands of turns in a few other folders, later.
  for (let i = 0; i < 5000; i += 1) mod.noteAgentTurn("ws-2", [`/work/other-${i % 3}`], 10 * DAY + i, false);
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/keep")), 10 * DAY);
});

test("a time dropped for room raises the floor: no folder reads idle before it", ({ mod }) => {
  mod.noteAgentTurn("ws-1", ["/work/first"], DAY, false);
  for (let i = 1; i <= mod.AGENT_TURNS_MAX; i += 1) mod.noteAgentTurn("ws-1", [`/work/f-${i}`], DAY + i, false);
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/first")), DAY, "dropped, but the floor still answers for it");
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/never")), DAY, "a folder it cannot tell about is not idle before the floor either");
  assert.equal(mod.lastAgentTurnAt(inFolder(`/work/f-${mod.AGENT_TURNS_MAX}`)), DAY + mod.AGENT_TURNS_MAX);
});

test("a saved file that cannot be read: nothing reads idle before it was last written", ({ mod, temp }) => {
  const file = path.join(temp, "broken.json");
  fs.writeFileSync(file, "{ not json");
  const written = new Date(4 * DAY);
  fs.utimesSync(file, written, written);
  mod.persistAgentTurns(file, 9 * DAY);
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/any")), 4 * DAY);
  mod.__resetAgentTurnsForTests();
  fs.writeFileSync(file, JSON.stringify({ version: 1, floor: 0, entries: "nope" }));
  fs.utimesSync(file, written, written);
  mod.persistAgentTurns(file, 9 * DAY);
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/any")), 4 * DAY, "a file of the wrong shape too");
});

test("no file yet: nothing reads idle before it began, and that start is kept once", ({ mod, temp }) => {
  const file = path.join(temp, "first-run", "agent-turns.json");
  // The first run of a build that keeps the times: agents worked before.
  mod.persistAgentTurns(file, 9 * DAY);
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/any")), 9 * DAY, "before the file began is not known");
  assert.equal(read(file).floor, 9 * DAY, "saved at once, before any turn");
  mod.__resetAgentTurnsForTests();
  mod.persistAgentTurns(file, 20 * DAY);
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/any")), 9 * DAY, "a later start reads it back, not its own time");
});

test("an entry ages out only past the longest idle span anyone asks about", ({ mod, temp }) => {
  assert.ok(mod.AGENT_TURNS_MAX_AGE_MS > 365 * DAY);
  const file = path.join(temp, "aged.json");
  const now = 1000 * DAY;
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      floor: 0,
      entries: [
        { at: now - 366 * DAY, workspaceId: "ws-1", cwd: "/work/year" },
        { at: now - 500 * DAY, workspaceId: "ws-1", cwd: "/work/ancient" },
        { at: now + DAY, workspaceId: "ws-1", cwd: "/work/future" },
      ],
    }),
  );
  mod.persistAgentTurns(file, now);
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/year")), now - 366 * DAY);
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/ancient")), null);
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/future")), now, "a time ahead of the clock is now");
});

test("a save that fails is tried again at the next edge, not at every stamp, and leaves no temp file", ({ mod, temp }) => {
  // The target is a folder with something in it: the rename always fails.
  const file = path.join(temp, "broken", "agent-turns.json");
  fs.mkdirSync(path.join(file, "inside"), { recursive: true });
  mod.persistAgentTurns(file, 1_000_000);
  const warn = console.warn;
  let warnings = 0;
  console.warn = () => {
    warnings += 1;
  };
  try {
    mod.noteAgentTurn("ws-1", ["/work/a"], 1_000_000, true);
    assert.equal(warnings, 1, "the edge tried to save");
    for (let at = 1_010_000; at < 1_060_000; at += 10_000) mod.noteAgentTurn("ws-1", ["/work/a"], at, false);
    assert.equal(warnings, 1, "stamps inside the turn do not retry each time");
    mod.noteAgentTurn("ws-1", ["/work/a"], 1_065_000, true);
    assert.equal(warnings, 2, "the next edge does");
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["agent-turns.json"], "no temp file left");
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/a")), 1_065_000, "the time is still known in memory");
});

// The cleanup deps' matcher: a folder is the same however its path is spelled.
async function matcherTests(temp) {
  const outfile = path.join(ROOT, "node_modules", ".cache", `agent-turns-match-${process.pid}.cjs`);
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "worktree-cleanup", "agent-turns.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    external: ["electron", "ssh2", "cpu-features"],
    logLevel: "silent",
  });
  try {
    const { agentTurnIn } = require(outfile);
    const at = agentTurnIn(["ws-a"], ["/wt/a/", "C:/x/wt"]);
    assert.equal(at("ws-z", "/wt/a"), true, "a folder given with a trailing slash");
    assert.equal(at("ws-z", "/wt/a/src/deep"), true, "a folder inside it");
    assert.equal(at("ws-z", "/wt/ab"), false, "a sibling whose name starts the same");
    assert.equal(at("ws-z", "C:\\x\\wt\\src"), true, "backslashes for slashes");
    assert.equal(at("ws-a", "/elsewhere"), false, "a known folder elsewhere, even in the workspace");
    assert.equal(at("ws-a", null), true, "no folder known: by the workspace");
    assert.equal(at("ws-z", null), false);
    // A folder asked about through a link, a turn recorded by its real path.
    const real = fs.mkdtempSync(path.join(temp, "real-"));
    const link = path.join(temp, `link-${process.pid}`);
    fs.symlinkSync(real, link);
    assert.equal(agentTurnIn([], [link])("ws-z", path.join(fs.realpathSync(real), "src")), true, "a folder asked about through a link");
    assert.equal(agentTurnIn([], [path.join(temp, "gone")])("ws-z", path.join(temp, "gone")), true, "a folder that is gone, as spelled");
  } finally {
    fs.rmSync(outfile, { force: true });
  }
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-agent-turns-"));
  const outfile = path.join(temp, "agent-turn-ledger.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "agent-turn-ledger.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const mod = require(outfile);
  const warn = console.warn;
  console.warn = () => undefined;
  let failed = 0;
  for (const { name, fn } of TESTS) {
    mod.__resetAgentTurnsForTests();
    try {
      await fn({ mod, temp });
      console.log(`PASS ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL ${name}`);
      console.error(err && err.stack ? err.stack : err);
    }
  }
  console.warn = warn;
  try {
    await matcherTests(temp);
    console.log("PASS the cleanup deps match a folder however its path is spelled");
  } catch (err) {
    failed += 1;
    console.error("FAIL the cleanup deps match a folder however its path is spelled");
    console.error(err && err.stack ? err.stack : err);
  }
  fs.rmSync(temp, { recursive: true, force: true });
  const total = TESTS.length + 1;
  console.log(`\n${total - failed}/${total} agent-turn-ledger tests passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
