#!/usr/bin/env node
// What a terminal in a background workspace costs: the memory main keeps for
// it after 20 MB of output, and the longest single task the window spends on
// one message of the replay when the user switches back. Bundles the real
// pty-manager.ts against the spawn harness stubs, so it measures whatever the
// working tree holds. Not part of the test registry; run it by hand:
//
//   node --expose-gc scripts/measure-terminal-backlog.cjs [megabytes]
//
// The window's work is approximated with @xterm/headless, which parses with
// the same code as the renderer's xterm: each message's structured clone (what
// IPC does) and text decode (the agent sniffer reads every chunk) as one task,
// then the xterm parse, both as one write (xterm parses a write in one go) and
// as the renderer's 128 KB slices (writeSlices.ts), with the longest stretch
// the event loop was blocked.

const fs = require("node:fs");
const path = require("node:path");
const v8 = require("node:v8");
const esbuild = require("esbuild");
const { Terminal } = require("@xterm/headless");
const { createController, stubPlugin, localOptions, MODULE_TS, CACHE_ROOT } = require("./test-pty-spawn-serialization.cjs");

const WRITE_SLICES_TS = path.join(__dirname, "..", "src", "renderer", "src", "components", "Terminal", "writeSlices.ts");

const MB = 1024 * 1024;
const COLS = 200;
const ROWS = 50;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function line(index) {
  const text = `${String(index).padStart(6, "0")} `.padEnd(COLS, "abcdefghij klmnopqrst uvwxyz 0123456789 ");
  return `\x1b[3${index % 8}m${text.slice(0, 40)}\x1b[0m${text.slice(40, COLS)}\r\n`;
}

// Each workload yields the pty's output as strings, the way node-pty hands
// them to pty-manager, until `total` bytes.
const WORKLOADS = {
  // A build or a dev server: colored lines that scroll.
  "log lines": function* (total) {
    let bytes = 0;
    for (let i = 0; bytes < total; i += 1) {
      let chunk = "";
      while (chunk.length < 4096) chunk += line(i++);
      bytes += chunk.length;
      yield chunk;
    }
  },
  // A full-screen program (htop, an agent CLI) started while the pane was hidden.
  "full-screen program": function* (total) {
    yield "$ top\r\n\x1b[?1049h\x1b[?1h\x1b[?25l";
    let bytes = 0;
    for (let frame = 0; bytes < total; frame += 1) {
      let chunk = "\x1b[H";
      for (let row = 1; row <= ROWS; row += 1) chunk += `\x1b[${row};1H\x1b[3${(frame + row) % 8}m${line(frame + row).slice(5, 150)}`;
      bytes += chunk.length;
      yield chunk;
    }
  },
  // An agent that draws inline: a status block redrawn with cursor-up moves,
  // with a finished transcript line printed above it now and then.
  "inline agent": function* (total) {
    let bytes = 0;
    for (let frame = 0; bytes < total; frame += 1) {
      let chunk = frame === 0 ? "" : "\x1b[2K\x1b[1A".repeat(4) + "\x1b[2K\r";
      if (frame % 10 === 0) chunk += line(frame).slice(5);
      for (let row = 0; row < 4; row += 1) chunk += `\x1b[2m${"-\\|/"[(frame + row) % 4]} working ${frame}\x1b[0m\r\n`;
      bytes += chunk.length;
      yield chunk;
    }
  },
};

// Buffers' memory is released a turn after the collection that frees them.
async function used() {
  for (let i = 0; i < 3; i += 1) {
    globalThis.gc();
    await sleep(20);
  }
  const usage = process.memoryUsage();
  return { heap: usage.heapUsed, buffers: usage.arrayBuffers };
}

// Longest stretch the event loop is blocked between start and stop, sampled
// with a 1 ms timer chain.
function blockMonitor() {
  let last = performance.now();
  let longest = 0;
  let stopped = false;
  const tick = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    if (!stopped) setTimeout(tick, 1);
  };
  setTimeout(tick, 1);
  return async () => {
    // The monitor sees the last stretch on its next tick.
    await sleep(5);
    stopped = true;
    return longest;
  };
}

// The longest blocked stretch while xterm parses `writes`, queued at once.
async function longestParse(writes) {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 3_000, allowProposedApi: true });
  await new Promise((resolve) => term.write("", resolve));
  const stop = blockMonitor();
  await new Promise((resolve) => writes.forEach((w, i) => term.write(w, i === writes.length - 1 ? resolve : undefined)));
  const longest = await stop();
  term.dispose();
  return longest;
}

async function measure(pty, controller, sliceForWrite, name, total) {
  const sent = [];
  const wc = { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) };
  const id = `measure-${name.replace(/\W+/g, "-")}`;
  await pty.spawn({ ...localOptions(id), cols: COLS, rows: ROWS, webContents: wc });
  const handle = controller.localSpawnCalls.at(-1).handle;
  await sleep(30);
  pty.pause(id);
  const before = await used();
  const output = [...WORKLOADS[name](total)];
  const ingestStart = performance.now();
  for (const chunk of output) handle.emit(chunk);
  const ingest = performance.now() - ingestStart;
  output.length = 0;
  const after = await used();
  const held = { heap: after.heap - before.heap, buffers: after.buffers - before.buffers };
  const snapshot = pty.resourceSnapshot().sessions.find((s) => s.id === id);

  sent.length = 0;
  pty.resume(id);
  let seen = -1;
  while (seen !== sent.length) {
    seen = sent.length;
    await sleep(50);
  }
  // The replay: the whole backlog as one message on the data channel.
  const replay = sent.filter((m) => m.channel === `pty:data:${id}`).map((m) => m.payload);
  const decoder = new TextDecoder();
  let receive = 0;
  const copies = replay.map((payload) => {
    const start = performance.now();
    const copy = v8.deserialize(v8.serialize(payload));
    decoder.decode(copy, { stream: true });
    receive = Math.max(receive, performance.now() - start);
    return copy;
  });
  const oneWrite = await longestParse(copies);
  const sliced = await longestParse(copies.flatMap((copy) => sliceForWrite(copy)));
  pty.killImmediate(id);
  return {
    held,
    ingest,
    backlog: snapshot.detachedBacklogBytes,
    tail: snapshot.tailBytes,
    messages: replay.length,
    largest: Math.max(0, ...replay.map((p) => p.byteLength)),
    receive,
    oneWrite,
    sliced,
  };
}

async function main() {
  if (typeof globalThis.gc !== "function") throw new Error("run with node --expose-gc");
  const total = Number(process.argv[2] || 20) * MB;
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(CACHE_ROOT, "measure-terminal-backlog-"));
  try {
    const outfile = path.join(tmp, "pty.cjs");
    await esbuild.build({ entryPoints: [MODULE_TS], outfile, bundle: true, platform: "node", format: "cjs", plugins: [stubPlugin()], logLevel: "silent" });
    const controller = createController();
    globalThis.__codaraPtySpawnHarness = controller;
    const pty = require(outfile);
    const slicesOut = path.join(tmp, "write-slices.cjs");
    await esbuild.build({ entryPoints: [WRITE_SLICES_TS], outfile: slicesOut, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
    const { sliceForWrite } = require(slicesOut);
    const fmt = (bytes) => `${(bytes / MB).toFixed(1)} MB`;
    console.log(`${total / MB} MB of output into a paused pane, ${COLS}x${ROWS}, 3,000 lines of scrollback`);
    for (const name of Object.keys(WORKLOADS)) {
      const r = await measure(pty, controller, sliceForWrite, name, total);
      console.log(`${name}:`);
      console.log(`  held after the output: ${fmt(r.held.heap + r.held.buffers)}: ${fmt(r.held.buffers)} of buffers and ${fmt(r.held.heap)} of heap (backlog ${fmt(r.backlog)}, tail ${fmt(r.tail)})`);
      console.log(`  main's time to take in the output: ${Math.round(r.ingest)} ms`);
      console.log(`  switch back: ${r.messages} messages, largest ${fmt(r.largest)}; receive and decode ${Math.round(r.receive)} ms`);
      console.log(`  xterm parse, longest block: one write ${Math.round(r.oneWrite)} ms, 128 KB slices ${Math.round(r.sliced)} ms`);
    }
    pty.disposeAll();
  } finally {
    delete globalThis.__codaraPtySpawnHarness;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
