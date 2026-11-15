#!/usr/bin/env node
"use strict";

// A paused pane's backlog (up to 16 MB) comes back from main as one message,
// exactly as before; the renderer writes it to xterm in slices of at most
// 128 KB (src/renderer/src/components/Terminal/writeSlices.ts), because xterm
// parses one write in a single task and yields only between writes.
//
// Part 1 runs Sol's review schedules against main's pty-manager.ts through a
// simulated Electron window (IPC one message per turn each way, listeners as
// registered at delivery) and checks the bytes that reach the window are what
// main has always delivered: the slicing must not need main to change.
// PTY_MANAGER_TS=<path> runs the same schedules against another pty-manager
// (an earlier attempt that sliced in main fails several of them).
//
// Part 2 compares a pane that writes each message in one go (the old
// renderer) with one that writes it through the slice writer, on real
// headless xterm: the same screen, live output after the backlog, nothing
// dropped when the pane unmounts mid-parse, and slice edges a fresh parser
// can resume from (a remount writes the unparsed rest into a new xterm).
//
//   node scripts/test-terminal-replay-slices.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const v8 = require("node:v8");
const vm = require("node:vm");
const esbuild = require("esbuild");
const { Terminal } = require("@xterm/headless");
const { createController, stubPlugin, localOptions, MODULE_TS, CACHE_ROOT } = require("./test-pty-spawn-serialization.cjs");

const MB = 1024 * 1024;
const SLICES_TS = path.join(__dirname, "..", "src", "renderer", "src", "components", "Terminal", "writeSlices.ts");
const PTY_TS = process.env.PTY_MANAGER_TS ? path.resolve(process.env.PTY_MANAGER_TS) : MODULE_TS;
const turn = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");

let pty;
let controller;
let slices;
let nextToken = 1;

// One Electron window. `frozen` drops what main sends (a renderer that stopped
// responding) while its own calls still reach main.
function createWindow(id) {
  const listeners = new Map();
  const toWindow = [];
  const toMain = [];
  let pumping = false;
  const win = { frozen: false };
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
  win.wc = {
    isDestroyed: () => false,
    send: (channel, payload) => {
      if (win.frozen) return;
      toWindow.push({ channel, payload });
      pump();
    },
  };
  const on = (channel, fn) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
    return () => listeners.get(channel).delete(fn);
  };
  win.call = (fn) => {
    toMain.push(fn);
    pump();
  };
  win.idle = async () => {
    for (let quiet = 0; quiet < 3; ) {
      await turn();
      quiet = pumping || toWindow.length > 0 || toMain.length > 0 ? 0 : quiet + 1;
    }
  };
  // A pane: collects every pty byte it is sent. It also speaks the protocol
  // of the earlier main-side attempt (token, replay slices, acks) so that
  // PTY_MANAGER_TS can point at it; main ignores the extra arguments.
  win.mount = ({ resume = true } = {}) => {
    const token = nextToken++;
    const pane = { received: [], token };
    let taken = 0;
    const offs = [
      on(`pty:data:${id}`, (data) => pane.received.push(Buffer.from(data))),
      on(`pty:replay:${id}`, ({ end, data, token: to }) => {
        if (!data || (to !== undefined && to !== token)) return;
        pane.received.push(Buffer.from(data));
        taken = end;
        if (!win.frozen) win.call(() => pty.ackReplay?.(id, end));
      }),
    ];
    pane.resume = () => win.call(() => pty.resume(id, false, token));
    // A hidden window: pause without unmounting.
    pane.hide = () => win.call(() => pty.pause(id));
    pane.unmount = () => {
      const replayedTo = taken;
      win.call(() => pty.pause(id, replayedTo, token));
      for (const off of offs) off();
    };
    if (resume) pane.resume();
    return pane;
  };
  return win;
}

const session = (id) => pty.resourceSnapshot().sessions.find((s) => s.id === id);
const got = (...panes) => Buffer.concat(panes.flatMap((pane) => pane.received));

async function open(id) {
  const win = createWindow(id);
  await pty.spawn({ ...localOptions(id), webContents: win.wc });
  const handle = controller.localSpawnCalls.at(-1).handle;
  await win.idle();
  await sleep(30);
  return { win, handle };
}

// A pane that leaves at once, then `history` while away.
async function away(id, history) {
  const { win, handle } = await open(id);
  const first = win.mount();
  await win.idle();
  first.unmount();
  await win.idle();
  for (let at = 0; at < history.length; at += 4096) handle.emit(history.subarray(at, at + 4096));
  return { win, handle };
}

const lines = (n, label) => Buffer.from(`${label} ${"0123456789".repeat(12)}\r\n`.repeat(n));

function sameBytes(name, actual, expected) {
  assert.equal(actual.length, expected.length, `${name}: ${expected.length - actual.length} bytes missing (negative: repeated)`);
  assert.ok(actual.equals(expected), `${name}: the bytes and their order are main's`);
}

async function part1() {
  // Sol round 1: the pane leaves after the backlog reached it, its pause
  // still on the way; an acknowledgement claiming more than it got.
  {
    const id = "s1-leave";
    const history = lines(10_000, "leave");
    const { win } = await away(id, history);
    const b = win.mount();
    for (let waited = 0; b.received.length === 0; waited += 1) {
      assert.ok(waited < 1000);
      await turn();
    }
    win.call(() => pty.ackReplay?.(id, Number.MAX_SAFE_INTEGER));
    b.unmount();
    const c = win.mount();
    await win.idle();
    sameBytes("listener removed before its pause arrives", got(b, c), history);
    pty.killImmediate(id);
  }
  console.log("PASS a pane leaving with its pause in flight, or over-acknowledging, loses nothing");

  // Sol round 2: kill, exit, hibernate and close right after the resume.
  for (const how of ["kill", "exit", "hibernate", "close"]) {
    const id = `s2-${how}`;
    const history = lines(10_000, how);
    const { win, handle } = await away(id, history);
    const generation = pty.hibernationSessionInfo(id).generationId;
    const b = win.mount({ resume: false });
    win.call(() => {
      pty.resume(id, false, b.token);
      if (how === "kill") pty.killImmediate(id);
      else if (how === "exit") handle.kill();
      else if (how === "hibernate") void pty.hibernate(id, generation, 0);
      else pty.dispose(id);
    });
    await win.idle();
    await sleep(30);
    await win.idle();
    sameBytes(`${how} right after the resume`, got(b), history);
    if (pty.hasSession(id)) pty.killImmediate(id);
  }
  console.log("PASS kill, exit, hibernate and close right after the resume deliver the whole backlog");

  // Sol round 2: a pane moves to a new owner, whose resume arrives before or
  // after the old owner's pause; output printed after that comes on the next
  // resume.
  for (const newFirst of [true, false]) {
    const id = `s3-transfer-${newFirst}`;
    const history = lines(10_000, "transfer");
    const { win, handle } = await away(id, history);
    const a = win.mount();
    await turn();
    let b;
    if (newFirst) {
      b = win.mount();
      a.unmount();
    } else {
      a.unmount();
      b = win.mount();
    }
    await win.idle();
    handle.emit(Buffer.from("AFTER\r\n"));
    await sleep(30);
    b.resume();
    await win.idle();
    await sleep(30);
    await win.idle();
    sameBytes(`transfer, new owner ${newFirst ? "first" : "second"}`, got(a, b), Buffer.concat([history, Buffer.from("AFTER\r\n")]));
    pty.killImmediate(id);
  }
  console.log("PASS a transfer to a new owner in either order delivers everything in order");

  // Sol round 2: a renderer that stopped responding, three rounds of pause,
  // 16 MB of output and resume: main holds at most its tail and one backlog.
  {
    const id = "s4-frozen";
    const { win, handle } = await open(id);
    const pane = win.mount();
    await win.idle();
    win.frozen = true;
    gc();
    await sleep(20);
    const before = process.memoryUsage().arrayBuffers;
    const out = lines(130_000, "frozen");
    for (let cycle = 0; cycle < 3; cycle += 1) {
      pane.hide();
      await win.idle();
      for (let at = 0; at < out.length; at += 4096) handle.emit(out.subarray(at, at + 4096));
      pane.resume();
      await win.idle();
      await sleep(30);
    }
    gc();
    await sleep(20);
    gc();
    const held = process.memoryUsage().arrayBuffers - before - out.length;
    assert.ok(session(id).detachedBacklogBytes <= 16 * MB + 4096);
    assert.ok(held < 24 * MB, `main holds ${(held / MB).toFixed(1)} MB for a frozen renderer after three rounds`);
    pty.killImmediate(id);
  }
  console.log("PASS a renderer that stopped responding costs main at most its tail and one backlog");
}

// --- Part 2: the renderer's writes -----------------------------------------

function terminal() {
  return new Terminal({ cols: 120, rows: 30, scrollback: 2000, allowProposedApi: true });
}

function screen(term) {
  const buffer = term.buffer.active;
  const rows = [];
  for (let row = 0; row < buffer.length; row += 1) rows.push(buffer.getLine(row)?.translateToString(true) ?? "");
  return `${term.buffer.active.type} ${buffer.cursorX},${buffer.cursorY}\n${rows.join("\n")}`;
}

const parsed = (term) => new Promise((resolve) => term.write("", resolve));

function workload(name) {
  let text = "";
  if (name === "log lines") {
    for (let i = 0; text.length < 2 * MB; i += 1) text += `\x1b[3${i % 8}m${String(i).padStart(6, "0")} é ✓\x1b[0m ${"abcdefghij ".repeat(8)}\r\n`;
  } else if (name === "full-screen program") {
    text = "\x1b[?1049h";
    for (let f = 0; text.length < 2 * MB; f += 1) {
      text += "\x1b[H";
      for (let row = 1; row <= 30; row += 1) text += `\x1b[${row};1H\x1b[3${(f + row) % 8}m frame ${f} row ${row} ✓ ${"x".repeat(60)}`;
    }
  } else {
    for (let f = 0; text.length < 2 * MB; f += 1) {
      if (f > 0) text += "\x1b[2K\x1b[1A".repeat(3) + "\x1b[2K\r";
      if (f % 10 === 0) text += `done ${f} €\r\n`;
      for (let row = 0; row < 3; row += 1) text += `\x1b[2m${"-\\|/"[(f + row) % 4]} working ${f}\x1b[0m\r\n`;
    }
  }
  return Buffer.from(text);
}

async function part2() {
  for (const name of ["log lines", "full-screen program", "inline agent"]) {
    const backlog = workload(name);
    const live = Buffer.from("\x1b[0mlive output after the backlog ✓\r\n");
    const old = terminal();
    old.write(backlog);
    old.write(live);
    await parsed(old);
    const sliced = terminal();
    const writer = slices.createSliceWriter((slice, done) => sliced.write(slice, done));
    writer.write(backlog);
    writer.write(live);
    assert.ok(writer.unparsed().length > 8, "a large backlog waits in xterm's queue as several slices");
    await parsed(sliced);
    assert.equal(writer.unparsed().length, 0);
    assert.equal(screen(sliced), screen(old), `${name}: the sliced backlog draws the same screen`);
    for (const piece of slices.sliceForWrite(backlog)) assert.ok(piece.length <= slices.WRITE_SLICE_BYTES);
    assert.ok(slices.sliceForWrite(backlog).length >= 16);
    old.dispose();
    sliced.dispose();
  }
  console.log("PASS sliced writes draw the same screen as one write, live output after them");

  // The pane unmounts while slices still wait in xterm's queue: what it
  // parsed plus what it hands to the next mount is the whole message. The old
  // single write had nothing parsed at that moment, so its snapshot held none
  // of it.
  {
    const backlog = workload("log lines");
    const term = terminal();
    const pieces = [];
    const writer = slices.createSliceWriter((slice, done) =>
      term.write(slice, () => {
        pieces.push(slice);
        done();
      }),
    );
    let unparsed = null;
    writer.write(backlog, () => {
      if (pieces.length === 3 && !unparsed) unparsed = writer.unparsed();
    });
    await parsed(term);
    sameBytes("unmount mid-parse", Buffer.concat([...pieces.slice(0, 3), ...unparsed]), backlog);
    term.dispose();
  }
  console.log("PASS an unmount mid-parse hands every unparsed byte to the next mount");

  // Sol round 2: the edge between what one xterm parsed and what a fresh one
  // gets falls next to a character or an escape sequence.
  for (const [name, suffix, check] of [
    ["mid-character", "€Z", (term, row) => assert.ok(row.endsWith("€Z"), `the next mount shows ${JSON.stringify(row)}`)],
    ["mid-escape", "\x1b[31mZ", (term, row) => {
      assert.ok(row.endsWith("Z") && !row.includes("[31m"), `the next mount shows ${JSON.stringify(row)}`);
      const buffer = term.buffer.active;
      const cell = buffer.getLine(buffer.baseY + buffer.cursorY).getCell(buffer.cursorX - 1);
      assert.equal(cell.getFgColor(), 1, "and Z is red");
    }],
  ]) {
    const backlog = Buffer.concat([Buffer.alloc(131_071), Buffer.from(suffix), Buffer.alloc(200_000)]);
    const pieces = slices.sliceForWrite(backlog);
    const next = terminal();
    next.write(Buffer.concat(pieces.slice(1)));
    await parsed(next);
    const buffer = next.buffer.active;
    check(next, buffer.getLine(buffer.baseY + buffer.cursorY).translateToString(true));
    next.dispose();
  }
  // The snapshot keeps at most a tail of the unparsed bytes (1 MB); it starts
  // on the same kind of edge, dropping a partial character or sequence.
  {
    const tail = (text, max) => Buffer.from(slices.resumableTail(Buffer.from(text), max)).toString();
    assert.equal(tail(`${"\0".repeat(100)}€Z`, 3), "Z", "a kept tail never starts inside a character");
    assert.equal(tail(`${"x".repeat(100)}\x1b[31mZ more`, 14), "\x1b[31mZ more", "a kept tail starts at an escape sequence");
    assert.equal(tail(`${"x".repeat(100)}\r\nnext line`, 13), "next line", "or after a line feed");
  }
  console.log("PASS slice edges next to a character or an escape sequence resume cleanly in a new xterm");
}

async function main() {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(CACHE_ROOT, "terminal-replay-slices-"));
  try {
    const outfile = path.join(tmp, "pty.cjs");
    await esbuild.build({ entryPoints: [PTY_TS], outfile, bundle: true, platform: "node", format: "cjs", plugins: [stubPlugin()], logLevel: "silent" });
    const slicesFile = path.join(tmp, "slices.cjs");
    await esbuild.build({ entryPoints: [SLICES_TS], outfile: slicesFile, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
    controller = createController();
    globalThis.__codaraPtySpawnHarness = controller;
    pty = require(outfile);
    slices = require(slicesFile);
    await part1();
    await part2();
    console.log("\nPASS terminal replay slices");
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
