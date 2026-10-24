#!/usr/bin/env node
"use strict";

// Remote agent panes in pty-manager (Machines phase 1): the real
// pty-manager bundled with the harness of test-pty-spawn-serialization and
// a fake SSH connection (the harness quotes pty-manager's own `cd` with
// JSON.stringify). Guards:
//
//   - preference off: a remote pane types exactly what it typed before, and
//     never probes the machine
//   - preference on: an agent startup becomes the tmux launch line of
//     remote/remote-agents.ts; a plain shell pane attaches when its agent
//     session is alive and stays a plain shell when it is not
//   - closing the pane (dispose), Cora stopping it (killImmediate) and a
//     deleted folder (disposeUnderCwd) end the agent's session on the
//     machine; quitting (disposeAll) and a closed window
//     (disposeForWebContents) leave it running; a pane that comes back
//     before its close takes effect keeps its agent
//
//   node scripts/test-pty-remote-agents.cjs

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const { createController, stubPlugin, MODULE_TS, CACHE_ROOT } = require("./test-pty-spawn-serialization.cjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

function fakeConnection(state) {
  return {
    isDisposed: false,
    async shell() {
      const channel = new EventEmitter();
      channel.stderr = new EventEmitter();
      channel.writes = [];
      channel.write = (data) => channel.writes.push(data);
      channel.setWindow = () => undefined;
      channel.close = () => setImmediate(() => channel.emit("close"));
      state.channels.push(channel);
      return channel;
    },
    async exec(command) {
      state.execs.push(command);
      if (command.includes("has-session")) return { code: state.alive ? 0 : 1 };
      return { code: 0 };
    },
  };
}

const options = (id, startupCommand, webContents = null) => ({
  id,
  shell: { id: "remote-test", label: "Remote test shell", exe: "unused", args: [], family: "other" },
  cwd: "ssh://homeserver/home/dev/project",
  cols: 100,
  rows: 30,
  webContents,
  startupCommand,
});

const CLAUDE = "claude --dangerously-skip-permissions --session-id 3f2c9a1e-0000-4000-8000-000000000001";

async function main() {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(CACHE_ROOT, "pty-remote-agents-"));
  const outfile = path.join(tmp, "pty-manager.bundle.cjs");
  const state = { channels: [], execs: [], alive: false };
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
    const conn = fakeConnection(state);
    controller.getConnection = async () => conn;
    globalThis.__codaraPtySpawnHarness = controller;
    const pty = require(outfile);
    const kills = () => state.execs.filter((c) => c.includes("kill-session"));
    const reset = () => {
      state.channels.length = 0;
      state.execs.length = 0;
      state.alive = false;
    };

    controller.preferences = { machinesEnabled: false };
    await pty.spawn(options("off-agent", CLAUDE));
    await pty.spawn(options("off-shell"));
    assert.equal(
      state.channels[0].writes[0],
      `cd "/home/dev/project" && export SPARK_TERMINAL=1 SPARK_REMOTE=1 && clear && ${CLAUDE}\n`,
    );
    assert.equal(state.channels[1].writes[0], 'cd "/home/dev/project" && export SPARK_TERMINAL=1 SPARK_REMOTE=1 && clear\n');
    assert.deepEqual(state.execs, [], "the machine is never probed");
    pty.dispose("off-agent");
    await sleep(400);
    assert.deepEqual(kills(), []);
    pty.disposeAll();
    ok("preference off: remote panes behave as before");

    reset();
    controller.preferences = { machinesEnabled: true };
    await pty.spawn(options("agent-1", CLAUDE));
    const launch = state.channels[0].writes[0];
    assert.match(launch, /^cd "\/home\/dev\/project" && export SPARK_TERMINAL=1 SPARK_REMOTE=1 && clear && sh -c '/);
    assert.ok(launch.includes("new-session -A -s"));
    assert.ok(launch.includes("codara-agent-1"));
    assert.ok(launch.includes(CLAUDE));
    assert.deepEqual(state.execs, [], "an agent launch needs no probe: its own line attaches or starts");

    await pty.spawn(options("shell-dead"));
    assert.equal(state.channels[1].writes[0], 'cd "/home/dev/project" && export SPARK_TERMINAL=1 SPARK_REMOTE=1 && clear\n');
    assert.equal(state.execs.filter((c) => c.includes("has-session") && c.includes("codara-shell-dead")).length, 1);
    state.alive = true;
    await pty.spawn(options("shell-alive"));
    assert.match(state.channels[2].writes[0], /&& clear && tmux -L codara -f \/dev\/null .*attach-session -t '=codara-shell-alive'\n$/);
    ok("preference on: agents start in tmux, a restored plain pane attaches only to a live session");

    reset();
    for (const id of ["close-me", "stop-me", "quit-me", "window-me", "back-again"]) {
      await pty.spawn(options(id, CLAUDE, id === "window-me" ? { isDestroyed: () => false, send() {} } : null));
    }
    await pty.spawn({ ...options("under-folder", CLAUDE), cwd: "ssh://homeserver/home/dev/project/sub" });

    pty.dispose("close-me");
    pty.killImmediate("stop-me");
    pty.disposeUnderCwd("ssh://homeserver/home/dev/project/sub");
    await sleep(400);
    const ended = kills().map((c) => /codara-([a-z-]+)/.exec(c)[1]).sort();
    assert.deepEqual(ended, ["close-me", "stop-me", "under-folder"]);

    // The pane comes back within the close's grace: its agent stays.
    pty.dispose("back-again");
    await pty.spawn(options("back-again", CLAUDE));
    await sleep(400);
    assert.equal(kills().some((c) => c.includes("codara-back-again")), false);

    const wc = { isDestroyed: () => false, send() {} };
    await pty.spawn(options("window-me-2", CLAUDE, wc));
    pty.disposeForWebContents(wc);
    pty.disposeAll();
    await sleep(100);
    assert.equal(kills().some((c) => /codara-(quit-me|window-me|back-again)/.test(c)), false, "quitting leaves agents running");
    ok("closing, stopping or deleting ends the agent; quitting, a closed window or a quick reopen does not");
  } finally {
    delete globalThis.__codaraPtySpawnHarness;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
