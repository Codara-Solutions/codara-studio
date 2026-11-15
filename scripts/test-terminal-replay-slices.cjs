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
// headless xterm: the same screen, live output after the backlog, and a
// remount while slices are still queued (the unmount drains them) that ends
// on the screen one write leaves. WRITE_SLICES_TS=<path> runs part 2 against
// another writeSlices.ts (the one at 90781d8b, which handed the queued bytes
// to the next mount instead, fails Sol's round-3 cases).
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
const TERMINAL_DIR = path.join(__dirname, "..", "src", "renderer", "src", "components", "Terminal");
const SLICES_TS = process.env.WRITE_SLICES_TS ? path.resolve(process.env.WRITE_SLICES_TS) : path.join(TERMINAL_DIR, "writeSlices.ts");
const SESSION_TS = path.join(TERMINAL_DIR, "useTerminalSession.ts");
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
  assert.ok(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength).equals(expected), `${name}: the bytes and their order are main's`);
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

// The writer as the pane builds it: sliced only when xterm's queue can be
// drained. An older writeSlices.ts (WRITE_SLICES_TS) takes one argument.
const writerFor = (term, write = (slice, done) => term.write(slice, done)) =>
  slices.createSliceWriter(write, slices.xtermQueueDrainer?.(term) ?? null);

// The unmount snapshot and the next mount, as useTerminalSession does them:
// the parsed normal buffer as text (captureXtermBuffer), wrapped rows joined
// and trailing blank rows dropped; the next mount writes that text, CRLF, then
// the snapshot's pending bytes.
const SCROLLBACK = 2000;
function captureText(term) {
  const buffer = term.buffer.normal;
  const lines = [];
  for (let row = Math.max(0, buffer.length - SCROLLBACK); row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

async function remount(text, pendingBytes) {
  const next = terminal();
  const replay = text.trimEnd();
  if (replay) next.write(`${replay.replace(/\r\n|\r|\n/g, "\r\n")}\r\n`);
  if (pendingBytes && pendingBytes.length > 0) next.write(pendingBytes);
  await parsed(next);
  return next;
}

// What main's renderer leaves after a remount: the message in one write,
// parsed, then the snapshot.
async function remountedAfterOneWrite(message) {
  const term = terminal();
  term.write(message);
  await parsed(term);
  const before = screen(term);
  const next = await remount(captureText(term), null);
  term.dispose();
  return { before, after: next };
}

// The sliced pane unmounts after xterm parsed `parsedSlices` slices of
// `message`, the others still queued in xterm. With the old writer
// (WRITE_SLICES_TS at 90781d8b) the snapshot carried the unparsed slices as
// pending bytes, capped at 1 MB from a resumable point.
async function remountedMidReplay(message, parsedSlices) {
  const term = terminal();
  const held = [];
  let written = 0;
  const writer = writerFor(term, (slice, done) => {
    if (written++ < parsedSlices) term.write(slice, done);
    else held.push([slice, done]);
  });
  let sliceCallbacks = 0;
  writer.write(message, () => (sliceCallbacks += 1));
  await parsed(term);
  assert.equal(sliceCallbacks, parsedSlices, "the pane unmounts with slices still waiting");
  for (const [slice, done] of held) term.write(slice, done);
  let pendingBytes = null;
  if (typeof writer.drain === "function") {
    writer.drain();
    assert.equal(writer.unparsed().length, 0, "nothing waits in xterm's queue after the drain");
  } else {
    pendingBytes = slices.handoffBytes(writer.unparsed(), [], SCROLLBACK);
    if (pendingBytes && pendingBytes.length > MB) pendingBytes = slices.resumableTail(pendingBytes, MB);
  }
  const before = screen(term);
  const next = await remount(captureText(term), pendingBytes);
  term.dispose();
  return { before, after: next, sliceCallbacks };
}

const lastText = (term) => captureText(term).split("\n").at(-1);

async function part2() {
  for (const name of ["log lines", "full-screen program", "inline agent"]) {
    const backlog = workload(name);
    const live = Buffer.from("\x1b[0mlive output after the backlog ✓\r\n");
    const old = terminal();
    old.write(backlog);
    old.write(live);
    await parsed(old);
    const sliced = terminal();
    const writer = writerFor(sliced);
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

  // Sol round 3: a remount while slices are still queued. The snapshot is
  // text, so neither queued bytes nor a sequence the parser is inside can
  // cross into it; the unmount drains the queue first, and the remounted pane
  // equals main's, which parsed the message in one write.
  const pad = (n) => Buffer.alloc(n);
  const cases = [
    {
      // An OSC title whose line feed falls before the first slice's end (LF
      // does not end an OSC string), and whose terminator comes after it.
      name: "an OSC title across the first slice edge, a line feed inside it",
      message: Buffer.concat([pad(60_000), Buffer.from(`\x1b]0;${"x".repeat(71_060)}\nPRIVATE\x07Z`)]),
      check: (term) => assert.equal(lastText(term), "Z", "shows Z, the title is not printed"),
    },
    {
      // More than the 1 MB the snapshot keeps of pending bytes, after KEEP.
      name: "128 KB, KEEP, 2 MB, END",
      message: Buffer.concat([pad(128 * 1024), Buffer.from("KEEP"), pad(2 * MB), Buffer.from("END")]),
      check: (term) => assert.equal(lastText(term), "KEEPEND", "nothing is dropped"),
    },
    {
      // A plain line the first slice ends in the middle of.
      name: "131,071 bytes, then AZ",
      message: Buffer.concat([pad(131_071), Buffer.from("AZ")]),
      check: (term) => assert.equal(lastText(term), "AZ", "AZ on one line, no newline added"),
    },
  ];
  for (const { name, message, check } of cases) {
    const main = await remountedAfterOneWrite(message);
    const sliced = await remountedMidReplay(message, 1);
    check(main.after);
    check(sliced.after);
    assert.equal(sliced.before, main.before, `${name}: the unmounting pane shows what one write left`);
    assert.equal(screen(sliced.after), screen(main.after), `${name}: the remounted pane equals main's`);
    main.after.dispose();
    sliced.after.dispose();
  }

  // The class, not only those three: random output (colors, cursor moves,
  // OSC strings with line feeds inside, UTF-8, alternate screen) unmounted
  // after any number of slices leaves the screen one write leaves.
  const pool = [
    "\x1b[31m", "\x1b[0m", "\x1b[2K", "\x1b[1A", "\r\n", "\n", "é", "✓", "€", "\x1b]0;title\nmore", "\x07",
    "\x1b]8;;https://example.com\x1b\\", "\x1b[?1049h", "\x1b[?1049l", "\x1b[5;3H", "\x1bP+q544e\x1b\\", "\t",
  ];
  let seed = 7;
  const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  for (let round = 0; round < 12; round += 1) {
    const parts = [];
    let size = 0;
    const target = 300_000 + Math.floor(random() * 400_000);
    while (size < target) {
      const part = random() < 0.7 ? "abcdefghij ".repeat(1 + Math.floor(random() * 12)) : pool[Math.floor(random() * pool.length)];
      parts.push(part);
      size += Buffer.byteLength(part);
    }
    const message = Buffer.from(parts.join(""));
    const count = slices.sliceForWrite(message).length;
    const parsedSlices = 1 + Math.floor(random() * (count - 1));
    const main = await remountedAfterOneWrite(message);
    const sliced = await remountedMidReplay(message, parsedSlices);
    assert.equal(sliced.before, main.before, `random round ${round}: the unmounting pane after ${parsedSlices} of ${count} slices`);
    assert.equal(screen(sliced.after), screen(main.after), `random round ${round}: the remounted pane`);
    main.after.dispose();
    sliced.after.dispose();
  }
  console.log("PASS a remount with slices still queued equals main's: OSC across the edge, past the 1 MB cap, a split line, random output");

  // The drain on both xterm builds the app uses (the browser one constructs
  // without a page as long as it is not opened): every queued write parsed in
  // order, callbacks run, and xterm's own timer later finds nothing to do.
  for (const [build, Term] of [["@xterm/headless", Terminal], ["@xterm/xterm", require("@xterm/xterm").Terminal]]) {
    const term = new Term({ cols: 40, rows: 5, allowProposedApi: true });
    const drain = slices.xtermQueueDrainer(term);
    assert.ok(drain, `${build}: the write queue can be drained`);
    const order = [];
    term.write(Buffer.from("one\r\n"), () => order.push(1));
    term.write(Buffer.from("\x1b]0;t"), () => order.push(2));
    term.write(Buffer.from("itle\x07two"), () => order.push(3));
    drain();
    assert.deepEqual(order, [1, 2, 3], `${build}: callbacks in order, inside the drain`);
    assert.equal(term.buffer.active.getLine(1).translateToString(true), "two", `${build}: parsed, the OSC across writes intact`);
    await sleep(30);
    assert.deepEqual(order, [1, 2, 3], `${build}: nothing parsed twice`);
    term.write("", () => order.push(4));
    await sleep(30);
    assert.deepEqual(order, [1, 2, 3, 4], `${build}: later writes still parse`);
    term.dispose();
  }
  // No queue to drain: the writer writes each message whole, as main's
  // renderer did, so nothing can be left behind a snapshot.
  {
    const writes = [];
    const writer = slices.createSliceWriter((slice) => writes.push(slice.length), null);
    writer.write(Buffer.alloc(3 * slices.WRITE_SLICE_BYTES));
    assert.deepEqual(writes, [3 * slices.WRITE_SLICE_BYTES]);
    writer.drain();
  }

  // Slices of random bytes: none empty or oversized, nothing lost.
  for (let round = 0; round < 50; round += 1) {
    const size = 1 + Math.floor(Math.random() * 600_000);
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    const pieces = slices.sliceForWrite(bytes);
    for (const piece of pieces) assert.ok(piece.length > 0 && piece.length <= slices.WRITE_SLICE_BYTES);
    sameBytes("random slices", Buffer.concat(pieces), bytes);
  }

  // xterm refuses a write past its discard mark: slices it took before are
  // reported, so the caller acknowledges only the rest.
  for (const [refused, sync] of [[3, false], [3, true], [1, false]]) {
    let calls = 0;
    const callbacks = [];
    const writer = slices.createSliceWriter((slice, done) => {
      calls += 1;
      if (calls === refused) throw new Error("write data discarded");
      if (sync) done();
      else callbacks.push(done);
    }, () => {});
    let acked = 0;
    let doneCalls = 0;
    let error = null;
    try {
      writer.write(Buffer.alloc(5 * slices.WRITE_SLICE_BYTES), (n) => (acked += n), () => (doneCalls += 1));
    } catch (caught) {
      error = caught;
    }
    for (const done of callbacks) done();
    const taken = (refused - 1) * slices.WRITE_SLICE_BYTES;
    const label = `slice ${refused} refused${sync ? ", earlier ones parsed at once" : ""}`;
    assert.ok(error, `${label}: the failure reaches the caller`);
    assert.equal(slices.bytesAcceptedBefore(error), taken, label);
    assert.equal(acked, taken, label);
    assert.equal(doneCalls, refused > 1 ? 1 : 0, `${label}: onDone runs once after the last slice taken, never when none was`);
    assert.equal(writer.unparsed().length, 0, `${label}: the refused slice is not counted as waiting`);
  }
  console.log("PASS the drain on both xterm builds; whole writes without one; slice sizes; a refused slice");

  // The pane drains before anything else in its unmount, and its snapshot
  // carries only the hidden-era bytes, as on main.
  const session = fs.readFileSync(SESSION_TS, "utf8");
  const unmount = session.slice(session.indexOf("    return () => {\n      // The snapshot below"));
  assert.match(unmount, /^    return \(\) => \{\n(?:\s*\/\/.*\n)+\s*if \(!rawTailReattachRef\.current && !readOnlyRef\.current\) \{\n\s*try \{\n\s*sliceWriterRef\.current\?\.drain\(\);/);
  assert.ok(unmount.indexOf("drain()") < unmount.indexOf("captureXtermBuffer(dyingTerm"), "drained before the snapshot");
  assert.match(unmount, /const pendingBytes = mergeHiddenBuffer\(\n\s*hiddenBufferRef\.current,/);
  assert.match(session, /createSliceWriter\(\n\s*\(slice, parsed\) => term\.write\(slice, parsed\),\n\s*xtermQueueDrainer\(term\),\n\s*\)/);
  console.log("PASS the pane drains first in its unmount; its snapshot holds the hidden-era bytes as before");
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
