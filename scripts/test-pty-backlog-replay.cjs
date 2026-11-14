#!/usr/bin/env node
"use strict";

// The output a paused pane misses (src/main/pty-manager.ts pause/resume and
// src/main/pty-backlog.ts): how much main keeps, how it goes back to the
// window, and that the window then shows what it would have shown had it
// seen every byte. A headless xterm stands in for the window: one terminal
// gets the whole stream, another what the pane had before the pause plus the
// replay, and the two must agree.
//
//   node scripts/test-pty-backlog-replay.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const { Terminal } = require("@xterm/headless");
const { createController, stubPlugin, localOptions, MODULE_TS, CACHE_ROOT } = require("./test-pty-spawn-serialization.cjs");

const MB = 1024 * 1024;
const SLICE = 128 * 1024;
const COLS = 80;
const ROWS = 24;
const LINES = 1_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let pty;
let controller;

async function open(id) {
  const sent = [];
  const wc = { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) };
  await pty.spawn({ ...localOptions(id), cols: COLS, rows: ROWS, webContents: wc });
  const handle = controller.localSpawnCalls.at(-1).handle;
  await sleep(30);
  const data = () => sent.filter((m) => m.channel === `pty:data:${id}`).map((m) => Buffer.from(m.payload));
  return { id, sent, wc, handle, data };
}

function session(id) {
  return pty.resourceSnapshot().sessions.find((s) => s.id === id);
}

async function replayed(id) {
  for (let waited = 0; !session(id).attached; waited += 5) {
    assert.ok(waited < 5_000, "the replay finishes");
    await sleep(5);
  }
}

// Splits text into chunks of `size` bytes, so escape sequences and UTF-8
// characters straddle chunk boundaries.
function chunks(text, size) {
  const bytes = Buffer.from(text);
  const out = [];
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size));
  return out;
}

function line(i) {
  return `\x1b[3${i % 8}m${String(i).padStart(7, "0")} é ✓ \x1b[0m${"x".repeat(40 + (i % 17))}\r\n`;
}

function terminal() {
  return new Terminal({ cols: COLS, rows: ROWS, scrollback: LINES, allowProposedApi: true });
}

function write(term, bytes) {
  return new Promise((resolve) => term.write(bytes, resolve));
}

function text(buffer) {
  const rows = [];
  for (let row = 0; row < buffer.length; row += 1) rows.push(buffer.getLine(row)?.translateToString(true) ?? "");
  return rows.join("\n");
}

async function main() {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(CACHE_ROOT, "pty-backlog-replay-"));
  try {
    const outfile = path.join(tmp, "pty.cjs");
    await esbuild.build({ entryPoints: [MODULE_TS], outfile, bundle: true, platform: "node", format: "cjs", plugins: [stubPlugin()], logLevel: "silent" });
    controller = createController();
    globalThis.__codaraPtySpawnHarness = controller;
    pty = require(outfile);
    const backlogFile = path.join(tmp, "backlog.cjs");
    await esbuild.build({ entryPoints: [path.join(path.dirname(MODULE_TS), "pty-backlog.ts")], outfile: backlogFile, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
    const { VtScanner } = require(backlogFile);

    let failed = 0;
    const section = async (name, fn) => {
      try {
        await fn();
        console.log(`PASS ${name}`);
      } catch (error) {
        failed += 1;
        console.log(`FAIL ${name}\n  ${error.message.split("\n")[0]}`);
      }
    };

    await section("scrolling output is kept to the view's scrollback and replays the same screen", async () => {
      const pane = await open("scrolling");
      const full = terminal();
      const view = terminal();
      const before = Array.from({ length: 50 }, (_, i) => line(i)).join("");
      pane.handle.emit(before);
      await sleep(40);
      for (const bytes of pane.data()) await write(view, bytes);
      await write(full, before);
      pty.pause(pane.id, LINES);
      let stream = "";
      for (let i = 50; stream.length < 20 * MB; i += 1) stream += line(i);
      for (const chunk of chunks(stream, 4093)) pane.handle.emit(chunk);
      const held = session(pane.id).detachedBacklogBytes;
      assert.ok(held <= 2 * MB, `a paused pane keeps at most 2 MB, kept ${held}`);
      pane.sent.length = 0;
      pty.resume(pane.id, false, LINES);
      assert.ok(pane.data().length >= 1, "the first slice leaves before resume returns");
      await replayed(pane.id);
      const slices = pane.data();
      assert.ok(slices.length > 1, "the replay goes out in slices");
      assert.ok(slices.every((s) => s.length <= SLICE), "no slice is larger than 128 KB");
      const announced = pane.sent.filter((m) => m.channel === `pty:replay:${pane.id}`).reduce((n, m) => n + m.payload.bytes, 0);
      assert.equal(announced, slices.reduce((n, s) => n + s.length, 0), "every replayed byte is announced as history");
      await write(full, stream);
      for (const bytes of slices) await write(view, bytes);
      assert.equal(text(view.buffer.normal), text(full.buffer.normal), "the view shows the same scrollback and screen as one that saw every byte");
      full.dispose();
      view.dispose();
    });

    await section("a full-screen program started while paused keeps its modes and repaints the same screen", async () => {
      const pane = await open("full-screen");
      const frame = (n) => `\x1b[H\x1b[2J${Array.from({ length: ROWS }, (_, r) => `\x1b[${r + 1};1H\x1b[3${(n + r) % 8}mframe ${n} row ${r} ✓`).join("")}\x1b[0m`;
      pane.handle.resize = () => pane.handle.emit(frame(999_999));
      const full = terminal();
      const view = terminal();
      await write(full, "$ ");
      await write(view, "$ ");
      pty.pause(pane.id, LINES);
      let stream = "top\r\n\x1b[?1049h\x1b[?1h\x1b[?2004h\x1b[?25l";
      for (let n = 0; stream.length < 20 * MB; n += 1) {
        stream += `\x1b[${(n % ROWS) + 1};1H\x1b[2K\x1b[3${n % 8}m${n} ${"█".repeat(n % 50)}`;
      }
      for (const chunk of chunks(stream, 3001)) pane.handle.emit(chunk);
      const held = session(pane.id).detachedBacklogBytes;
      pane.sent.length = 0;
      pty.resume(pane.id, false, LINES);
      await replayed(pane.id);
      await sleep(150);
      const delivered = pane.data();
      for (const bytes of delivered) await write(view, bytes);
      await write(full, stream);
      await write(full, frame(999_999));
      await write(full, frame(999_999));
      assert.equal(view.buffer.active.type, "alternate", "the view is on the alternate screen");
      assert.equal(view.modes.applicationCursorKeysMode, true, "arrow keys still reach the program as it asked");
      assert.equal(view.modes.bracketedPasteMode, true, "bracketed paste is still on");
      assert.equal(text(view.buffer.alternate), text(full.buffer.alternate), "the program's repaint gives the same screen");
      assert.equal(text(view.buffer.normal), text(full.buffer.normal), "the shell line under it is kept");
      assert.ok(Buffer.concat(delivered).includes("frame 999999"), "a dropped screen asks the program to repaint");
      assert.ok(held <= 2 * MB, `the full-screen output past the cap is not kept, kept ${held}`);
      full.dispose();
      view.dispose();
    });

    // Output that cannot be proven out of view keeps the old 16 MB cap.
    await section("output kept under the hard cap is cut at a clean boundary", async () => {
      const pane = await open("inline");
      const view = terminal();
      pty.pause(pane.id, LINES);
      let stream = "\x1b[?2004h";
      for (let n = 0; stream.length < 20 * MB; n += 1) {
        stream += `${"\x1b[2K\x1b[1A".repeat(3)}\x1b[2K\r\x1b[2m${"-\\|/"[n % 4]} working ${n} é\x1b[0m\r\n\x1b[1mstatus ✓\x1b[0m\r\n\x1b[7m> \x1b[0m\r\n`;
      }
      const bytes = Buffer.from(stream);
      for (const chunk of chunks(stream, 997)) pane.handle.emit(chunk);
      const held = session(pane.id).detachedBacklogBytes;
      pane.sent.length = 0;
      pty.resume(pane.id, false, LINES);
      await replayed(pane.id);
      const replay = Buffer.concat(pane.data());
      // The replay is a few bytes of restored modes, then the stream's tail
      // byte for byte, starting where no escape sequence or character is open.
      let restored = 0;
      while (restored < 512 && !replay.subarray(restored).equals(bytes.subarray(bytes.length - (replay.length - restored)))) restored += 1;
      assert.ok(restored < 512, "the replay ends with the stream's tail, nothing lost or repeated");
      const cut = bytes.length - (replay.length - restored);
      const inside = new Uint8Array(bytes.length + 1);
      for (const match of bytes.toString("latin1").matchAll(/\x1b\[[0-9;?]*[A-Za-z]|[\xc0-\xff][\x80-\xbf]+/g)) {
        inside.fill(1, match.index + 1, match.index + match[0].length);
      }
      assert.equal(inside[cut], 0, `the cut at ${cut} is not inside an escape sequence or a character`);
      await write(view, replay);
      assert.equal(view.modes.bracketedPasteMode, true, "a mode set in the dropped output survives");
      assert.ok(held > 2 * MB && held <= 16 * MB, `cursor-relative output keeps the old cap, kept ${held}`);
      view.dispose();
    });

    await section("the scanner knows when a sequence or a character is still open across chunks", async () => {
      const scanner = new VtScanner();
      const steps = [
        ["\xf0", false],
        ["\x9f", false],
        ["\x98", false],
        ["\x80 ok", true],
        ["\x1b]0;ti", false],
        ["tle\x07", true],
        ["\x1b[", false],
        ["?1049h", true],
      ];
      for (const [input, ground] of steps) {
        const buf = Buffer.from(input, "latin1");
        for (let at = 0; at < buf.length; ) at = scanner.scan(buf, at, buf.length, { ris: false, modes: new Map(), sgr: [] });
        assert.equal(scanner.atGround(), ground, `after ${JSON.stringify(input)}`);
      }
      assert.equal(scanner.alt, true, "a split switch to the alternate screen is seen");
    });

    const history = Buffer.alloc(SLICE * 5 + 77);
    for (let i = 0; i < history.length; i += 1) history[i] = 0x61 + (i % 26);

    await section("live output and a resize during a replay arrive after it, in order", async () => {
      const pane = await open("order");
      pty.pause(pane.id, 50_000);
      pane.handle.emit(history);
      pane.sent.length = 0;
      pty.resume(pane.id, false, 50_000);
      assert.equal(pane.data().length, 1, "one slice per turn");
      assert.ok(pane.data()[0].length <= SLICE, "the replay is sliced");
      pane.handle.emit("LIVE");
      pty.resize(pane.id, 90, 30);
      pane.handle.emit("AFTER-RESIZE");
      await replayed(pane.id);
      await sleep(40);
      const got = Buffer.concat(pane.data());
      assert.equal(got.toString(), `${history.toString()}LIVEAFTER-RESIZE`, "live output and a resize wait for the replay, nothing is lost or repeated");
    });

    await section("a pause during a replay keeps the rest for the next resume", async () => {
      const pane = await open("second-pause");
      pty.pause(pane.id, 50_000);
      pane.handle.emit(history);
      pane.sent.length = 0;
      pty.resume(pane.id, false, 50_000);
      await new Promise((resolve) => setImmediate(resolve));
      pty.pause(pane.id, 50_000);
      const first = pane.data().length;
      assert.ok(pane.data()[0].length <= SLICE, "the replay is sliced");
      assert.ok(first >= 1 && first < 6, "the pause stopped the replay");
      await sleep(30);
      assert.equal(pane.data().length, first, "nothing is sent while paused");
      pane.handle.emit("NEW");
      pty.resume(pane.id, true, 50_000);
      pty.resume(pane.id, true, 50_000);
      await replayed(pane.id);
      await sleep(40);
      assert.equal(Buffer.concat(pane.data()).toString(), `${history.toString()}NEW`, "the rest arrives once, after what was sent");
    });

    // A reload of the window: main forgets the backlog, the raw tail repaints.
    await section("a reload during a replay stops it and live output resumes", async () => {
      const pane = await open("reload");
      pty.pause(pane.id, 50_000);
      pane.handle.emit(history);
      pane.sent.length = 0;
      pty.resume(pane.id, false, 50_000);
      pty.detachForWebContents(pane.wc);
      await sleep(30);
      assert.equal(pane.data().length, 1, "no slice goes to a reloading window");
      assert.ok(pane.data()[0].length <= SLICE, "the replay was cut short");
      assert.equal(session(pane.id).attached, true);
      assert.equal(session(pane.id).detachedBacklogBytes, 0);
      await pty.spawn({ ...localOptions(pane.id), cols: COLS, rows: ROWS, webContents: pane.wc });
      pane.handle.emit("LIVE-AGAIN");
      await sleep(40);
      assert.ok(Buffer.concat(pane.data()).toString().endsWith("LIVE-AGAIN"), "live output reaches the reloaded window");
    });

    await section("a kill during a replay stops it", async () => {
      const pane = await open("kill");
      pty.pause(pane.id, 50_000);
      pane.handle.emit(history);
      pane.sent.length = 0;
      pty.resume(pane.id, false, 50_000);
      pty.killImmediate(pane.id);
      await sleep(30);
      assert.equal(pane.data().length, 1, "no slice after the kill");
      assert.ok(pane.data()[0].length <= SLICE, "the replay was cut short");
      assert.equal(session(pane.id), undefined);
    });

    pty.disposeAll();
    assert.equal(failed, 0, `${failed} failed`);
    console.log("\nPASS pty backlog replay");
  } finally {
    delete globalThis.__codaraPtySpawnHarness;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
