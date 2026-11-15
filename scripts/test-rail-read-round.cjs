#!/usr/bin/env node
"use strict";

// The rail's read round (src/renderer/src/git/railReadRound.ts), without a
// browser: which project it reads next and when.
//   - nothing while unfocused or with nothing left; a background read running
//     waits for its end;
//   - a turn needs a pace since the last one and settled focus, and wakes at
//     the later of the two (not on a fixed poll);
//   - news takes every other turn; the rest go least recently read first;
//   - a project being read is not picked again;
//   - the first turn can run at once.
//
//   node scripts/test-rail-read-round.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const PACE = 30_000;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-rail-round-"));
  try {
    const outfile = path.join(dir, "round.cjs");
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "renderer", "src", "git", "railReadRound.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      logLevel: "silent",
    });
    const { createRailRound, roundStep, takeTurn } = require(outfile);
    const fresh = (left, now = 0) => {
      const round = createRailRound(now);
      for (const project of left) round.left.add(project);
      return round;
    };

    {
      const round = fresh(["/a"]);
      assert.equal(roundStep(round, 60_000, null, PACE), null, "unfocused: nothing, a focus asks again");
      assert.equal(roundStep(fresh([]), 60_000, 0, PACE), null, "nothing left: nothing");
      round.backgroundBusy = true;
      assert.equal(roundStep(round, 60_000, 0, PACE), null, "a background read running: its end asks again");
      console.log("PASS nothing while unfocused, empty or busy");
    }
    {
      const round = fresh(["/a"]);
      assert.deepEqual(roundStep(round, 10_000, 5_000, PACE), { wakeAt: PACE }, "a pace after the last turn");
      assert.deepEqual(roundStep(round, 10_000, 45_000, PACE), { wakeAt: 45_000 }, "or when focus settles, if later");
      assert.deepEqual(roundStep(round, 45_000, 45_000, PACE), { read: "/a", news: false }, "then the read");
      // Focus 31-71 s, out of step with a 30 s poll: due at 61 s.
      assert.deepEqual(roundStep(round, 40_000, 61_000, PACE), { wakeAt: 61_000 });
      assert.deepEqual(roundStep(round, 61_000, 61_000, PACE), { read: "/a", news: false });
      console.log("PASS a turn wakes at the later of the pace and settled focus");
    }
    {
      const round = fresh(["/old", "/new1", "/new2", "/older"]);
      round.readAt.set("/old", 2_000);
      round.readAt.set("/older", 1_000);
      round.readAt.set("/new1", 3_000);
      round.readAt.set("/new2", 4_000);
      round.dirty.add("/new1");
      round.dirty.add("/new2");
      const order = [];
      let now = 0;
      for (let turn = 0; turn < 4; turn++) {
        now += PACE;
        const step = roundStep(round, now, 0, PACE);
        order.push(step.read);
        takeTurn(round, step.read, step.news, now);
        round.left.delete(step.read);
        round.dirty.delete(step.read);
      }
      assert.deepEqual(order, ["/new1", "/older", "/new2", "/old"], "news every other turn, the rest oldest first");
      console.log("PASS news takes every other turn; the rest go least recently read first");
    }
    {
      const round = fresh(["/a", "/b"]);
      round.reading.set("/a", { again: null });
      assert.deepEqual(roundStep(round, PACE, 0, PACE), { read: "/b", news: false }, "a project being read is skipped");
      round.reading.set("/b", { again: null });
      assert.equal(roundStep(round, PACE, 0, PACE), null);
      console.log("PASS a project being read is not picked again");
    }
    {
      const round = fresh(["/a"], 1_000);
      round.startNow = true;
      assert.deepEqual(roundStep(round, 1_000, null, PACE), { read: "/a", news: false }, "the first turn at once");
      takeTurn(round, "/a", false, 1_000);
      assert.equal(round.startNow, false);
      assert.equal(round.lastTurnAt, 1_000);
      console.log("PASS the first turn can run at once, unfocused or not");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("FAIL the rail's read round");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
