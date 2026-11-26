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
  mod.persistAgentTurns(file, 5 * DAY);
  mod.noteAgentTurn("ws-1", ["/work/a", "/work/b"], 2 * DAY, true);
  mod.__resetAgentTurnsForTests();
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/a")), null, "a restart without the file forgets");
  mod.noteAgentTurn("ws-1", ["/work/b"], 3 * DAY, false);
  mod.persistAgentTurns(file, 5 * DAY);
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/a")), 2 * DAY);
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/b")), 3 * DAY, "the newer time this run saw stays");
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/c")), null);
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
  mod.__resetAgentTurnsForTests();
  mod.persistAgentTurns(path.join(temp, "missing.json"), 9 * DAY);
  assert.equal(mod.lastAgentTurnAt(inFolder("/work/any")), null, "no file yet is a fresh start");
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
  fs.rmSync(temp, { recursive: true, force: true });
  console.log(`\n${TESTS.length - failed}/${TESTS.length} agent-turn-ledger tests passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
