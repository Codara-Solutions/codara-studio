#!/usr/bin/env node
"use strict";

// How a paused pane's backlog goes back to the window (src/main/pty-manager.ts
// pause/resume/replaySlice/ackReplay and the renderer's replayTracker): in
// slices of at most 128 KB, one per turn, in order, before live output, and
// without losing or repeating a byte however panes come and go mid-replay.
//
// IPC is simulated in both directions with one message per turn, so a pane
// can unmount while slices are still on their way to it, its pause can reach
// main after main has sent more, and a new pane's listener can come a few
// turns after the old one left. A pane takes a slice in a turn after it
// arrives (xterm parses asynchronously), and loses what it had not taken in
// when it unmounts. Panes use the real replay tracker.
//
//   node scripts/test-pty-backlog-replay.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const { createController, stubPlugin, localOptions, MODULE_TS, CACHE_ROOT } = require("./test-pty-spawn-serialization.cjs");

const SLICE = 128 * 1024;
const TRACKER_TS = path.join(__dirname, "..", "src", "renderer", "src", "components", "Terminal", "replayTracker.ts");
const turn = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let pty;
let controller;
let createReplayTracker;

// One Electron window: messages from main reach the listeners registered at
// delivery time, one per turn; calls from the window reach main in order, one
// per turn after they are made.
function createWindow(id) {
  const listeners = new Map();
  const toWindow = [];
  const toMain = [];
  const log = [];
  let pumping = false;
  const pump = () => {
    if (pumping) return;
    pumping = true;
    setImmediate(function step() {
      if (toWindow.length > 0) {
        const { channel, payload } = toWindow.shift();
        for (const fn of [...(listeners.get(channel) ?? [])]) fn(payload);
      }
      if (toMain.length > 0) toMain.shift()();
      if (toWindow.length > 0 || toMain.length > 0) setImmediate(step);
      else pumping = false;
    });
  };
  const wc = {
    isDestroyed: () => false,
    send: (channel, payload) => {
      log.push({ channel, payload });
      toWindow.push({ channel, payload });
      pump();
    },
  };
  const on = (channel, fn) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
    return () => listeners.get(channel).delete(fn);
  };
  const call = (fn) => {
    toMain.push(fn);
    pump();
  };
  const idle = async () => {
    for (let quiet = 0; quiet < 3; ) {
      await turn();
      quiet = pumping || toWindow.length > 0 || toMain.length > 0 ? 0 : quiet + 1;
    }
  };

  // A TerminalPane as useTerminalSession wires it. `late` delays its
  // listeners (and the resume that follows them) by that many turns, as
  // start() runs from a timer after the commit. A watch-only pane is a
  // read-only mirror: it never resumes, pauses or acknowledges.
  function mount({ late = 0, watchOnly = false } = {}) {
    const tracker = createReplayTracker();
    const pane = { received: [], tracker, mounted: true, registered: false };
    const offs = [];
    const takeIn = (fn) => setImmediate(() => pane.mounted && fn());
    const register = () => {
      if (!pane.mounted) return;
      offs.push(
        on(`pty:data:${id}`, (data) => {
          tracker.consume(data.length);
          takeIn(() => pane.received.push(Buffer.from(data)));
        }),
        on(`pty:replay:${id}`, ({ bytes, end, token, data }) => {
          if (!data || typeof end !== "number") {
            tracker.announce(bytes);
            return;
          }
          const fresh = tracker.slice(data, end, token, watchOnly);
          const own = token !== undefined && token === tracker.token;
          takeIn(() => {
            if (fresh && fresh.length > 0) pane.received.push(Buffer.from(fresh));
            if (!own) return;
            tracker.tookIn(end);
            call(() => pty.ackReplay(id, end));
          });
        }),
      );
      pane.registered = true;
      if (!watchOnly) call(() => pty.resume(id, false, tracker.token));
    };
    if (late === 0) register();
    else {
      let left = late;
      setImmediate(function wait() {
        if ((left -= 1) > 0) setImmediate(wait);
        else register();
      });
    }
    pane.hide = () => call(() => pty.pause(id));
    pane.show = () => pane.registered && call(() => pty.resume(id, false, tracker.token));
    pane.unmount = () => {
      pane.mounted = false;
      if (!watchOnly) {
        const replayedTo = tracker.replayedTo();
        call(() => pty.pause(id, replayedTo));
      }
      for (const off of offs) off();
    };
    return pane;
  }

  return { wc, log, mount, idle, call };
}

function session(id) {
  return pty.resourceSnapshot().sessions.find((s) => s.id === id);
}

async function open(id, win = createWindow(id)) {
  await pty.spawn({ ...localOptions(id), webContents: win.wc });
  const handle = controller.localSpawnCalls.at(-1).handle;
  await win.idle();
  await sleep(30);
  return { win, handle };
}

function emitInChunks(handle, bytes, size = 4096) {
  for (let at = 0; at < bytes.length; at += size) handle.emit(bytes.subarray(at, at + size));
}

const all = (...panes) => Buffer.concat(panes.flatMap((pane) => pane.received));
const sliceCount = (win, id) => win.log.filter((m) => m.channel === `pty:replay:${id}` && m.payload.data).length;

function assertOnce(name, got, history) {
  assert.equal(got.length, history.length, `${name}: ${history.length - got.length} bytes lost (negative: repeated)`);
  assert.ok(got.equals(history), `${name}: the panes together show the history once, in order`);
}

// A pane that leaves at once, then `missed` bytes of output while away.
async function away(id, missed) {
  const { win, handle } = await open(id);
  const first = win.mount();
  await win.idle();
  first.unmount();
  await win.idle();
  emitInChunks(handle, missed);
  return { win, handle, first };
}

// Sol's probe (1.32 MB missed) and the reviewer's schedules: the pane comes
// back and leaves again after `after` slices were sent, its pause still on
// the way; then a later pane, a replacement mounted in the same step, a
// replacement whose listener comes `late` turns later, or a second
// replacement before the first one's resent slices arrive.
async function leaveMidReplay(name, { after, replace, late = 0, twice = false }) {
  const id = `replay-${name}`;
  const history = Buffer.from(("0123456789".repeat(13) + "\r\n").repeat(10_000));
  const { win, first } = await away(id, history);
  const second = win.mount();
  for (let waited = 0; sliceCount(win, id) < after; waited += 1) {
    assert.ok(waited < 1000);
    await turn();
  }
  second.unmount();
  const panes = [first, second];
  if (replace) panes.push(win.mount({ late }));
  if (twice) {
    await turn();
    await turn();
    panes.at(-1).unmount();
    panes.push(win.mount({ late }));
  }
  await win.idle();
  if (!replace) panes.push(win.mount());
  await win.idle();
  assert.equal(session(id).attached, true, `${name}: the replay finishes`);
  assertOnce(name, all(...panes), history);
  pty.killImmediate(id);
}

// A seeded random walk over mount, late mount, unmount, replace, hide, show
// and output while no pane is attached.
async function fuzz(seed) {
  let state = seed;
  const rand = (n) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % n;
  };
  const id = `replay-fuzz-${seed}`;
  const history = [];
  const { win, handle } = await open(id);
  const panes = [];
  let pane = null;
  let hidden = false;
  const mount = () => {
    pane = win.mount({ late: rand(3) });
    panes.push(pane);
    hidden = false;
  };
  mount();
  await win.idle();
  for (let step = 0; step < 40; step += 1) {
    const op = rand(7);
    if (op === 0 && !session(id).attached) {
      const bytes = Buffer.alloc(SLICE * (1 + rand(4)) + rand(5000));
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = 65 + ((step + i) % 26);
      history.push(bytes);
      emitInChunks(handle, bytes, 3000 + rand(3000));
    } else if (op === 1 && pane) {
      pane.unmount();
      pane = null;
    } else if (op === 2 && !pane) {
      mount();
    } else if (op === 3 && pane) {
      pane.unmount();
      mount();
    } else if (op === 4 && pane && !hidden) {
      pane.hide();
      hidden = true;
    } else if (op === 5 && pane && hidden) {
      pane.show();
      hidden = false;
    }
    for (let t = rand(4); t > 0; t -= 1) await turn();
  }
  if (!pane) mount();
  await win.idle();
  if (hidden) pane.show();
  await win.idle();
  await win.idle();
  assertOnce(`fuzz seed ${seed}`, all(...panes), Buffer.concat(history));
  pty.killImmediate(id);
}

async function main() {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(CACHE_ROOT, "pty-backlog-replay-"));
  try {
    const outfile = path.join(tmp, "pty.cjs");
    await esbuild.build({ entryPoints: [MODULE_TS], outfile, bundle: true, platform: "node", format: "cjs", plugins: [stubPlugin()], logLevel: "silent" });
    const trackerFile = path.join(tmp, "tracker.cjs");
    await esbuild.build({ entryPoints: [TRACKER_TS], outfile: trackerFile, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
    controller = createController();
    globalThis.__codaraPtySpawnHarness = controller;
    pty = require(outfile);
    ({ createReplayTracker } = require(trackerFile));

    // Slices: bounded, in order, the first before resume returns, live
    // output only after the last.
    {
      const id = "replay-order";
      const missed = Buffer.alloc(3 * 1024 * 1024 + 123);
      for (let i = 0; i < missed.length; i += 1) missed[i] = 33 + (i % 90);
      const { win, handle } = await away(id, missed);
      assert.equal(session(id).detachedBacklogBytes, missed.length);
      const back = win.mount();
      const before = win.log.length;
      pty.resume(id, false, back.tracker.token);
      const sent = win.log.slice(before).filter((m) => m.channel === `pty:replay:${id}`);
      assert.equal(sent.length, 1, "the first slice goes before resume returns");
      assert.equal(sent[0].payload.bytes, SLICE);
      assert.equal(session(id).attached, false, "live output waits while the replay runs");
      handle.emit(Buffer.from("LIVE"));
      await win.idle();
      await sleep(40);
      await win.idle();
      const slices = win.log.slice(before).filter((m) => m.channel === `pty:replay:${id}` && m.payload.data);
      assert.ok(slices.every((m) => m.payload.data.length <= SLICE), "no slice is larger than 128 KB");
      assert.equal(slices.length, Math.ceil((missed.length + 4) / SLICE));
      assertOnce("order", Buffer.concat(back.received), Buffer.concat([missed, Buffer.from("LIVE")]));
      assert.equal(session(id).attached, true);
      assert.equal(session(id).detachedBacklogBytes, 0);
      pty.killImmediate(id);
      console.log("PASS slices are bounded, in order, and live output follows them");
    }

    for (const after of [0, 1, 2, 5]) {
      await leaveMidReplay(`later-${after}`, { after, replace: false });
      await leaveMidReplay(`replaced-${after}`, { after, replace: true });
      await leaveMidReplay(`replaced-late-${after}`, { after, replace: true, late: 2 });
      await leaveMidReplay(`replaced-twice-${after}`, { after, replace: true, twice: true });
    }
    console.log("PASS a pane leaving mid-replay loses and repeats nothing (later, replaced, late listener, replaced twice)");

    // A hidden window pauses without unmounting: what was sent still
    // arrives, and the rest follows on show. Unmounting while hidden puts
    // back what the pane had not taken in.
    for (const unmountWhileHidden of [false, true]) {
      const id = `replay-hidden-${unmountWhileHidden}`;
      const history = Buffer.from("hidden window line\r\n".repeat(30_000));
      const { win, first } = await away(id, history);
      const back = win.mount();
      await turn();
      await turn();
      back.hide();
      let next = null;
      if (unmountWhileHidden) {
        await turn();
        back.unmount();
        next = win.mount();
      } else {
        await win.idle();
        assert.equal(session(id).attached, false);
        back.show();
      }
      await win.idle();
      assertOnce(`hidden ${unmountWhileHidden}`, all(first, back, ...(next ? [next] : [])), history);
      pty.killImmediate(id);
    }
    {
      const id = "replay-suspend";
      const history = Buffer.from("host suspend line\r\n".repeat(30_000));
      const { win, first } = await away(id, history);
      const back = win.mount();
      await turn();
      await turn();
      win.call(() => assert.equal(pty.pauseAllForHostSuspend() >= 1, true, "a running replay is paused for a host suspend"));
      await turn();
      back.unmount();
      const next = win.mount();
      await win.idle();
      assertOnce("host suspend", all(first, back, next), history);
      pty.killImmediate(id);
    }
    console.log("PASS a hidden window or host suspend mid-replay keeps every byte, also when the pane then unmounts");

    // A read-only mirror watching throughout writes every replayed byte once,
    // though the owner leaves mid-replay and slices are sent again.
    {
      const id = "replay-mirror";
      const history = Buffer.from("mirror line\r\n".repeat(60_000));
      const { win, handle } = await open(id);
      const owner = win.mount();
      await win.idle();
      owner.unmount();
      await win.idle();
      const mirror = win.mount({ watchOnly: true });
      await win.idle();
      emitInChunks(handle, history);
      const back = win.mount();
      for (let waited = 0; sliceCount(win, id) < 3; waited += 1) {
        assert.ok(waited < 1000);
        await turn();
      }
      back.unmount();
      const next = win.mount();
      await win.idle();
      assertOnce("mirror owner", all(back, next), history);
      assertOnce("mirror", all(mirror), history);
      pty.killImmediate(id);
      console.log("PASS a read-only mirror writes the replay once");
    }

    // The same pane over a respawn at the same id: the new session's replay
    // offsets are above the old one's, so the pane takes in its backlog and,
    // leaving mid-replay, hands back exactly what it had not taken in.
    {
      const id = "replay-respawn";
      const before = Buffer.from("before the respawn\r\n".repeat(30_000));
      const { win, first } = await away(id, before);
      const pane = win.mount();
      await win.idle();
      assertOnce("respawn first", all(first, pane), before);
      pty.killImmediate(id);
      await open(id, win);
      const handle = controller.localSpawnCalls.at(-1).handle;
      pane.hide();
      await win.idle();
      // The old history plus what the new shell printed before the hide.
      const upToHide = all(first, pane);
      assert.ok(upToHide.subarray(0, before.length).equals(before));
      const after = Buffer.from("after the respawn\r\n".repeat(30_000));
      emitInChunks(handle, after);
      const mark = win.log.length;
      pane.show();
      for (let waited = 0; win.log.slice(mark).filter((m) => m.payload?.data).length < 3; waited += 1) {
        assert.ok(waited < 1000);
        await turn();
      }
      assert.equal(session(id).attached, false, "the pane leaves mid-replay");
      pane.unmount();
      const next = win.mount();
      await win.idle();
      assertOnce("respawn", all(first, pane, next), Buffer.concat([upToHide, after]));
      pty.killImmediate(id);
      console.log("PASS a pane keeps taking in replays after a respawn at the same id");
    }

    for (let seed = 1; seed <= 40; seed += 1) await fuzz(seed);
    console.log("PASS 40 random walks of mounts, unmounts, replacements, hides and output lose and repeat nothing");

    // The program exits mid-replay: the rest of the backlog reaches the
    // window before the exit does.
    {
      const id = "replay-exit";
      const history = Buffer.from("last words\r\n".repeat(60_000));
      const { win, handle } = await away(id, history);
      const start = win.log.length;
      const back = win.mount();
      await turn();
      await turn();
      assert.equal(session(id).attached, false, "the replay is still running");
      handle.kill();
      await win.idle();
      await sleep(30);
      const exitAt = win.log.findIndex((m) => m.channel === `pty:exit:${id}`);
      assert.ok(exitAt >= 0, "the exit is reported");
      assert.ok(!win.log.slice(exitAt + 1).some((m) => m.channel === `pty:replay:${id}`), "no slice follows the exit");
      assert.ok(win.log.slice(start).some((m) => m.channel === `pty:replay:${id}`));
      assertOnce("exit", Buffer.concat(back.received), history);
      console.log("PASS an exit mid-replay comes after the whole backlog");
    }

    // A reload drops the window's sessions mid-replay: nothing more is sent.
    {
      const id = "replay-reload";
      const { win } = await away(id, Buffer.alloc(2 * 1024 * 1024, 65));
      pty.resume(id);
      pty.detachForWebContents(win.wc);
      const sent = win.log.length;
      await sleep(30);
      assert.equal(win.log.length, sent, "no slice goes to a reloaded window");
      assert.equal(session(id).detachedBacklogBytes, 0);
      pty.killImmediate(id);
      console.log("PASS a reload mid-replay stops it");
    }

    console.log("\nPASS pty backlog replay");
  } finally {
    pty?.disposeAll();
    delete globalThis.__codaraPtySpawnHarness;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
