#!/usr/bin/env node
"use strict";

// How a paused pane's backlog goes back to the window (src/main/pty-manager.ts
// pause/resume/replaySlice/ackReplay and the renderer's replayTracker): in
// slices of at most 128 KB, one per turn, in order, before live output, and
// without losing or repeating a byte when the pane goes away mid-replay.
//
// IPC is simulated in both directions with one message per turn, so a pane
// can unmount while slices are still on their way to it, and its pause call
// reaches main after main has sent more. Panes use the real replay tracker.
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
    for (let waited = 0; pumping || toWindow.length > 0 || toMain.length > 0; waited += 1) {
      assert.ok(waited < 100_000, "the simulated IPC drains");
      await turn();
    }
  };

  // A TerminalPane as useTerminalSession wires it.
  function mount() {
    const tracker = createReplayTracker();
    const pane = { received: [], tracker };
    const offData = on(`pty:data:${id}`, (data) => {
      tracker.consume(data.length);
      pane.received.push(Buffer.from(data));
    });
    const offReplay = on(`pty:replay:${id}`, ({ bytes, end, data }) => {
      if (!data || typeof end !== "number") {
        tracker.announce(bytes);
        return;
      }
      const fresh = tracker.slice(data, end);
      if (fresh && fresh.length > 0) pane.received.push(Buffer.from(fresh));
      call(() => pty.ackReplay(id, end));
    });
    call(() => pty.resume(id));
    pane.unmount = () => {
      const replayedTo = tracker.replayedTo();
      call(() => pty.pause(id, replayedTo));
      offData();
      offReplay();
    };
    return pane;
  }

  return { wc, log, mount, idle, call };
}

function session(id) {
  return pty.resourceSnapshot().sessions.find((s) => s.id === id);
}

async function open(id) {
  const win = createWindow(id);
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

// Sol's probe: 1.32 MB missed while away, the pane comes back and leaves
// again after `after` replay messages reached it, with its pause still on
// the way to main. A later pane must end up with exactly the rest.
async function leaveMidReplay(name, after, replaceAtOnce) {
  const id = `replay-${name}`;
  const { win, handle } = await open(id);
  const first = win.mount();
  await win.idle();
  first.unmount();
  await win.idle();
  const history = Buffer.from(("0123456789".repeat(13) + "\r\n").repeat(10_000));
  emitInChunks(handle, history);

  const second = win.mount();
  for (let seen = 0; seen < after; ) {
    await turn();
    seen = win.log.filter((m) => m.channel === `pty:replay:${id}` && m.payload.data).length;
  }
  let third;
  second.unmount();
  if (replaceAtOnce) third = win.mount();
  await win.idle();
  if (!replaceAtOnce) third = win.mount();
  await win.idle();
  assert.equal(session(id).attached, true, `${name}: the replay finishes`);
  const got = all(first, second, third);
  assert.equal(got.length, history.length, `${name}: ${history.length - got.length} bytes lost or repeated`);
  assert.ok(got.equals(history), `${name}: the panes together show the history once, in order`);
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
      const { win, handle } = await open(id);
      const pane = win.mount();
      await win.idle();
      pane.unmount();
      await win.idle();
      const missed = Buffer.alloc(3 * 1024 * 1024 + 123);
      for (let i = 0; i < missed.length; i += 1) missed[i] = 33 + (i % 90);
      emitInChunks(handle, missed, 5000);
      assert.equal(session(id).detachedBacklogBytes, missed.length);
      const before = win.log.length;
      pty.resume(id);
      const firstSlice = win.log.slice(before).filter((m) => m.channel === `pty:replay:${id}`);
      assert.equal(firstSlice.length, 1, "the first slice goes before resume returns");
      assert.equal(firstSlice[0].payload.bytes, SLICE);
      assert.equal(session(id).attached, false, "live output waits while the replay runs");
      handle.emit(Buffer.from("LIVE"));
      const back = win.mount();
      await win.idle();
      await sleep(40);
      await win.idle();
      const slices = win.log.slice(before).filter((m) => m.channel === `pty:replay:${id}` && m.payload.data);
      assert.ok(slices.every((m) => m.payload.data.length <= SLICE), "no slice is larger than 128 KB");
      assert.equal(slices.length, Math.ceil((missed.length + 4) / SLICE));
      const got = Buffer.concat(back.received);
      assert.ok(got.equals(Buffer.concat([missed, Buffer.from("LIVE")])), "slices then live output, in order");
      assert.equal(session(id).attached, true);
      assert.equal(session(id).detachedBacklogBytes, 0);
      pty.killImmediate(id);
      console.log("PASS slices are bounded, in order, and live output follows them");
    }

    // The pane leaves mid-replay and comes back later, or is replaced at once.
    for (const after of [0, 1, 2, 5]) {
      await leaveMidReplay(`later-${after}`, after, false);
      await leaveMidReplay(`replaced-${after}`, after, true);
    }
    console.log("PASS a pane leaving mid-replay loses and repeats nothing");

    // A hidden window pauses without unmounting: the listener stays, so what
    // was sent still arrives and the rest follows on the next resume.
    {
      const id = "replay-hidden";
      const { win, handle } = await open(id);
      const pane = win.mount();
      await win.idle();
      pane.unmount();
      await win.idle();
      const history = Buffer.from("hidden window line\r\n".repeat(30_000));
      emitInChunks(handle, history);
      const back = win.mount();
      await turn();
      await turn();
      win.call(() => pty.pause(id));
      await win.idle();
      assert.equal(session(id).attached, false);
      win.call(() => pty.resume(id));
      await win.idle();
      assert.ok(Buffer.concat(back.received).equals(history), "a hidden window gets every byte once");
      pty.killImmediate(id);
      console.log("PASS a hidden-window pause mid-replay keeps every byte");
    }

    // The program exits mid-replay: the rest of the backlog reaches the
    // window before the exit does.
    {
      const id = "replay-exit";
      const { win, handle } = await open(id);
      const pane = win.mount();
      await win.idle();
      pane.unmount();
      await win.idle();
      const history = Buffer.from("last words\r\n".repeat(60_000));
      emitInChunks(handle, history);
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
      assert.ok(Buffer.concat(back.received).equals(history), "the backlog is complete when the exit arrives");
      console.log("PASS an exit mid-replay comes after the whole backlog");
    }

    // A reload drops the window's sessions mid-replay: nothing more is sent.
    {
      const id = "replay-reload";
      const { win, handle } = await open(id);
      const pane = win.mount();
      await win.idle();
      pane.unmount();
      await win.idle();
      emitInChunks(handle, Buffer.alloc(2 * 1024 * 1024, 65));
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
