#!/usr/bin/env node
"use strict";

// Agent hibernation's part of src/main/pty-manager.ts: what main reads about
// a pane before it decides (hibernationSessionInfo), what it keeps of the
// pane's output for the sleeping view (sleepOutput: the newest raw output,
// and what a paused view never received, both bounded), and the stop itself
// (hibernate: fenced on the judged process generation, the exit flagged
// hibernated so the pane is kept as a sleeping one).
//
//   node scripts/test-pty-hibernate.cjs
//
// Same harness as test-pty-spawn-serialization: the real module with
// node-pty and the OS stubbed, so no process is spawned or signaled.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const {
  createController,
  stubPlugin,
  localOptions,
  MODULE_TS,
  CACHE_ROOT,
} = require("./test-pty-spawn-serialization.cjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeWebContents() {
  const wc = {
    sent: [],
    send(channel, payload) {
      wc.sent.push({ channel, payload });
    },
    isDestroyed() {
      return false;
    },
  };
  return wc;
}

async function main() {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(CACHE_ROOT, "pty-hibernate-"));
  const outfile = path.join(tmp, "pty-manager.bundle.cjs");
  try {
    await esbuild.build({
      entryPoints: [MODULE_TS],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      plugins: [stubPlugin()],
      logLevel: "silent",
    });
    const controller = createController();
    globalThis.__codaraPtySpawnHarness = controller;
    const pty = require(outfile);

    const wc = fakeWebContents();
    const id = "sleepy-pane";
    await pty.spawn({ ...localOptions(id), webContents: wc });
    const handle = controller.localSpawnCalls.at(-1).handle;
    await sleep(20);

    // ── What main reads ──
    const info = pty.hibernationSessionInfo(id);
    assert.ok(info, "a live pane has session info");
    assert.equal(info.pid, handle.pid);
    assert.equal(info.remote, false);
    assert.equal(typeof info.generationId, "string");
    assert.equal(info.ttyPath, null, "no tty path is invented when node-pty gives none");
    assert.equal(pty.hibernationSessionInfo("nope"), null);
    console.log("PASS a live pane's generation, pid and terminal are what main judges");

    // ── What is kept of the output ──
    handle.emit(Buffer.from("first frame\r\n"));
    handle.emit(Buffer.from("second frame\r\n"));
    await sleep(30);
    let kept = pty.sleepOutput(id, 1024 * 1024);
    assert.ok(kept.tail.toString().endsWith("first frame\r\nsecond frame\r\n"), "the tail holds the newest output");
    assert.equal(kept.unsent, null, "an attached view already has every byte");
    pty.pause(id);
    handle.emit(Buffer.from("while unmounted\r\n"));
    kept = pty.sleepOutput(id, 1024 * 1024);
    assert.equal(kept.unsent.toString(), "while unmounted\r\n", "a paused view gets only what it missed");
    assert.ok(kept.tail.toString().endsWith("second frame\r\nwhile unmounted\r\n"));
    kept = pty.sleepOutput(id, "while unmounted\r\n".length + 3);
    assert.equal(kept.tail.toString(), "while unmounted\r\n", "the bound keeps the newest whole chunks");
    assert.equal(pty.sleepOutput("nope", 1024), null);
    pty.resume(id);
    console.log("PASS the newest output and a paused view's backlog are kept, bounded");

    // ── The stop ──
    const exits = [];
    pty.onExit(id, (exitInfo) => exits.push(exitInfo));
    assert.equal(await pty.hibernate(id, "another-generation", 0), false, "a respawned pane is never stopped");
    assert.equal(pty.hasSession(id), true);
    assert.equal(exits.length, 0);
    assert.equal(await pty.hibernate(id, info.generationId, 0), true);
    await sleep(20);
    assert.equal(pty.hasSession(id), false, "the stopped pane's session is gone");
    assert.equal(exits.length, 1);
    assert.equal(exits[0].hibernated, true, "the exit says the agent sleeps");
    assert.equal(exits[0].sanctioned, true, "a stop Codara made is never a crash");
    const toRenderer = wc.sent.filter((m) => m.channel === `pty:exit:${id}`);
    assert.equal(toRenderer.length, 1);
    assert.equal(toRenderer[0].payload.hibernated, true, "the renderer keeps the pane as a sleeping one");
    assert.equal(await pty.hibernate(id, info.generationId, 0), false, "a pane already stopped is not stopped twice");
    console.log("PASS the stop is fenced on the generation and its exit is flagged hibernated");

    // An ordinary exit carries no flag.
    const other = "awake-pane";
    await pty.spawn({ ...localOptions(other), webContents: wc });
    const otherHandle = controller.localSpawnCalls.at(-1).handle;
    const otherExits = [];
    pty.onExit(other, (exitInfo) => otherExits.push(exitInfo));
    otherHandle.kill();
    await sleep(20);
    assert.equal(otherExits.length, 1);
    assert.equal("hibernated" in otherExits[0], false, "an ordinary exit is not a sleep");
    console.log("PASS an ordinary exit is not taken for a sleep");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
