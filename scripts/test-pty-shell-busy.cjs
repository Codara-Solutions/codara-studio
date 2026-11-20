#!/usr/bin/env node
"use strict";

// The rail's busy-shell signal in src/main/pty-manager.ts: each change goes to
// the main-window sink (setShellBusySink), never through the session's own
// webContents, so a renderer recovery that clears those sinks still lets
// hidden workspaces' changes through; a re-attach repeats a busy shell; a
// marker split across two chunks still counts; closing a pane clears it.
//
//   node scripts/test-pty-shell-busy.cjs
//
// Same harness as test-pty-spawn-serialization: the real module with
// node-pty and the OS stubbed, so no process is spawned or signaled.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const { createController, stubPlugin, localOptions, MODULE_TS, CACHE_ROOT } = require("./test-pty-spawn-serialization.cjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const C = "\x1b]133;C\x07";
const D = "\x1b]133;D;0\x07";

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
  const tmp = fs.mkdtempSync(path.join(CACHE_ROOT, "pty-shell-busy-"));
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
    const changes = [];
    pty.setShellBusySink((change) => changes.push(change));

    const wc = fakeWebContents();
    const id = "shell-pane";
    await pty.spawn({ ...localOptions(id), webContents: wc });
    const handle = controller.localSpawnCalls.at(-1).handle;
    await sleep(20);

    handle.emit(Buffer.from(`$ npm run dev${C}listening on 5173\r\n`));
    handle.emit(Buffer.from("more output, no marker\r\n"));
    assert.deepEqual(changes, [{ id, busy: true }], "one event per change, none for plain output");
    assert.deepEqual(pty.shellBusyIds(), [id]);
    assert.equal(wc.sent.some((m) => m.channel === "pty:shell-busy"), false, "never through the session's sink");
    console.log("PASS a command start reaches the sink once");

    // A renderer recovery clears every session's sink; the change still arrives.
    pty.detachForWebContents(wc);
    handle.emit(Buffer.from(`done\r\n${D}$ `));
    assert.deepEqual(changes.at(-1), { id, busy: false });
    console.log("PASS a change after a renderer recovery still reaches the sink");

    // Split across two chunks: "\x1b]13" + "3;C\x07".
    handle.emit(Buffer.from(`$ sleep 20${C.slice(0, 4)}`));
    assert.deepEqual(changes.at(-1), { id, busy: false }, "half a marker says nothing yet");
    handle.emit(Buffer.from(`${C.slice(4)}zzz`));
    assert.deepEqual(changes.at(-1), { id, busy: true }, "the marker across the join counts");
    console.log("PASS a marker split across two chunks counts");

    // The replacement renderer attaches and hears the shell is still busy.
    const before = changes.length;
    await pty.spawn({ ...localOptions(id), webContents: fakeWebContents() });
    assert.deepEqual(changes.slice(before), [{ id, busy: true }]);
    console.log("PASS a re-attach repeats a busy shell");

    pty.killImmediate(id);
    assert.deepEqual(changes.at(-1), { id, busy: false }, "a closed pane is no longer busy");
    assert.deepEqual(pty.shellBusyIds(), []);
    console.log("PASS closing the pane clears it");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
