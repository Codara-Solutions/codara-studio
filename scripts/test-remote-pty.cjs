#!/usr/bin/env node
"use strict";

// The terminal of a remote pane (src/main/remote/remote-pty.ts) against
// fake ssh2 channels and a fake connection. Guards:
//
//   - a plain shell ends with its channel; so does an agent pane whose shell
//     exits (the channel reports an exit status first)
//   - an agent pane survives a dropped connection: it says so, reconnects,
//     checks the agent's session is alive and attaches to it on a new
//     channel, and input, output and resizes follow the new channel
//   - failed reconnects retry with the backoff, the last delay repeating
//   - the pane ends when the agent's session is gone, or when the user
//     disconnected the host, and never reconnects then
//   - closing the pane ends its agent's session only when the user closed
//     it on purpose, never on a disconnected host, and a close during a
//     reconnect stops the loop and ends the pane exactly once
//   - reconnecting on its own never asks for a password or passphrase and
//     never wakes a stopped Codara box (every call is quiet); when the host
//     needs the user, or the retries run out, the loop stops and the pane
//     waits for a key, and only that key may prompt; a write (text Studio
//     sends on its own) never reconnects
//   - a plain shell reports exit 0 unless asked for the real status (the
//     Machines setting off keeps the old behaviour)
//   - a channel that closed before the handle existed (during the session
//     probe) still ends the pane, or reconnects an agent pane
//
// The real sshd and tmux are covered by tests/e2e/remote-agent.spec.ts.
//
//   node scripts/test-remote-pty.cjs

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

async function load() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/remote/remote-pty.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [
      {
        name: "stubs",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
          build.onResolve({ filter: /^\.\/connections$/ }, () => ({ path: "connections", namespace: "stub" }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents: "exports.shQuote = (v) => `'${v.replace(/'/g, \"'\\\\''\")}'`;",
            loader: "js",
          }));
        },
      },
    ],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

class FakeChannel extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.stderr = new EventEmitter();
    this.written = [];
    this.windows = [];
    this.closed = false;
  }
  write(data) {
    if (this.closed) throw new Error("closed");
    this.written.push(data);
  }
  setWindow(rows, cols) {
    this.windows.push([cols, rows]);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    setImmediate(() => this.emit("close"));
  }
  /** The remote shell exits on its own (the user typed `exit`). */
  exitShell(code = 0) {
    this.emit("exit", code);
    this.closed = true;
    this.emit("close");
  }
  /** sshd reports a signal death, as ssh2 passes it on: no code, then the name. */
  dieBySignal(signal = "SIGTERM") {
    this.emit("exit", null, signal, false, "");
    this.closed = true;
    this.emit("close");
  }
  /** The connection under it dropped: close without an exit status. */
  drop() {
    this.closed = true;
    this.emit("close");
  }
}

class FakeConn {
  constructor() {
    this.isDisposed = false;
    this.execs = [];
    this.shells = [];
    this.probe = [];
    this.execOpts = [];
    this.shellOpts = [];
  }
  async exec(command, opts = {}) {
    this.execs.push(command);
    this.execOpts.push(opts);
    if (command.includes("has-session")) {
      const next = this.probe.length ? this.probe.shift() : 0;
      if (next instanceof Error) throw next;
      return { code: next };
    }
    return { code: 0 };
  }
  async shell(opts = {}) {
    this.shellOpts.push(opts);
    const ch = new FakeChannel(`shell-${this.shells.length + 2}`);
    this.shells.push(ch);
    return ch;
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(what, check) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

function harness(lib, overrides = {}) {
  const conn = overrides.conn ?? new FakeConn();
  const first = new FakeChannel("shell-1");
  const sleeps = [];
  let endAgent = overrides.endAgent ?? false;
  const handle = lib.createRemotePtyHandle({
    conn,
    channel: first,
    paneId: "pane-1",
    hostLabel: "homeserver",
    cwd: "/home/dev/project",
    cols: 100,
    rows: 30,
    agentPane: overrides.agentPane ?? true,
    endAgentOnKill: () => endAgent,
    retryDelaysMs: [10, 20, 30],
    ...(overrides.maxAttempts ? { maxAttempts: overrides.maxAttempts } : {}),
    ...(overrides.closedBeforeBind ? { closedBeforeBind: overrides.closedBeforeBind } : {}),
    ...(overrides.reportExitStatus !== undefined ? { reportExitStatus: overrides.reportExitStatus } : {}),
    sleep: async (ms) => {
      sleeps.push(ms);
      if (overrides.sleep) await overrides.sleep(ms);
    },
  });
  const data = [];
  const exits = [];
  handle.onData((d) => data.push(String(d)));
  handle.onExit((e) => exits.push(e));
  return { conn, first, handle, data, exits, sleeps, setEndAgent: (v) => (endAgent = v) };
}

(async () => {
  const lib = await load();

  {
    const h = harness(lib, { agentPane: false });
    h.first.emit("data", Buffer.from("$ "));
    h.first.drop();
    assert.deepEqual(h.exits, [{ exitCode: -1 }], "a dropped connection is no clean exit, so the pane stays");
    assert.equal(h.conn.execs.length, 0, "a plain shell never reconnects");
    assert.deepEqual(h.data, ["$ "]);
    const h2 = harness(lib);
    h2.first.exitShell(3);
    assert.deepEqual(h2.exits, [{ exitCode: 3 }], "the shell's own exit ends an agent pane too");
    assert.equal(h2.conn.shells.length, 0);
    ok("a plain shell ends with its channel, and so does an agent pane whose shell exits");
  }

  {
    const h = harness(lib);
    h.first.drop();
    await until("a new channel", () => h.conn.shells.length === 1);
    assert.deepEqual(h.exits, [], "the pane stays open");
    assert.match(h.data.join(""), /lost the connection to homeserver; the agent keeps running there\. Reconnecting/);
    assert.ok(h.conn.execs[0].includes("has-session"), "it checks the session before attaching");
    const next = h.conn.shells[0];
    await until("the attach line", () => next.written.length === 1);
    assert.match(next.written[0], /^cd '\/home\/dev\/project' && .*attach-session -t '=codara-pane-1'\n$/);
    next.emit("data", Buffer.from("agent screen"));
    assert.ok(h.data.includes("agent screen"));
    h.handle.write("hello\r");
    assert.deepEqual(next.written.slice(1), ["hello\r"]);
    assert.equal(h.first.written.length, 0, "the dead channel gets nothing");
    h.handle.resize(140, 50);
    assert.deepEqual(next.windows, [[140, 50]]);
    // A second drop is handled the same way.
    next.drop();
    await until("a third channel", () => h.conn.shells.length === 2);
    assert.deepEqual(h.exits, []);
    ok("an agent pane survives a drop: it reconnects, attaches to the same session, and the new channel carries everything");
  }

  {
    const h = harness(lib);
    h.conn.probe = [new Error("ECONNREFUSED"), new Error("ETIMEDOUT"), new Error("EHOSTUNREACH"), new Error("x"), 0];
    h.first.drop();
    await until("a new channel", () => h.conn.shells.length === 1);
    assert.deepEqual(h.sleeps, [10, 20, 30, 30], "backoff, then the last delay repeats");
    assert.deepEqual(h.exits, []);
    ok("failed reconnects retry with backoff");
  }

  {
    const h = harness(lib);
    h.conn.probe = [1];
    h.first.drop();
    await until("the exit", () => h.exits.length === 1);
    assert.match(h.data.join(""), /the agent on homeserver has ended/);
    assert.equal(h.conn.shells.length, 0, "nothing to attach to");
    const h2 = harness(lib);
    h2.conn.isDisposed = true;
    h2.first.drop();
    assert.deepEqual(h2.exits, [{ exitCode: -1 }], "a host the user disconnected is never reconnected");
    assert.equal(h2.conn.execs.length, 0);
    const h3 = harness(lib);
    // The user disconnects the host while a reconnect is failing.
    h3.conn.exec = async () => {
      h3.conn.isDisposed = true;
      throw new Error("down");
    };
    h3.first.drop();
    await until("the exit", () => h3.exits.length === 1);
    assert.equal(h3.conn.shells.length, 0);
    assert.match(h3.data.join(""), /disconnected from homeserver; the agent keeps running there/);
    ok("the pane ends when the agent's session is gone or the user disconnected the host");
  }

  {
    const h = harness(lib, { endAgent: true });
    h.handle.kill();
    await until("the exit", () => h.exits.length === 1);
    assert.equal(h.conn.execs.filter((c) => c.includes("kill-session")).length, 1, "closing the pane ends its agent");
    assert.ok(h.conn.execs[0].includes("'=codara-pane-1'"));

    const keep = harness(lib, { endAgent: false });
    keep.handle.kill();
    await until("the exit", () => keep.exits.length === 1);
    assert.equal(keep.conn.execs.length, 0, "quitting Studio leaves the agent running");
    assert.equal(keep.conn.shells.length, 0, "and a kill never reconnects");

    const plain = harness(lib, { agentPane: false, endAgent: true });
    plain.handle.kill();
    await until("the exit", () => plain.exits.length === 1);
    assert.equal(plain.conn.execs.length, 0, "a plain shell has no session to end");

    const gone = harness(lib, { endAgent: true });
    gone.conn.isDisposed = true;
    gone.handle.kill();
    await until("the exit", () => gone.exits.length === 1);
    assert.equal(gone.conn.execs.length, 0, "a disconnected host is not reconnected to end it");
    ok("closing the pane ends its agent only when the user closed it, on a host still connected");
  }

  {
    let wake;
    const h = harness(lib, { endAgent: true, sleep: () => new Promise((resolve) => (wake = resolve)) });
    h.conn.probe = [new Error("down"), 0];
    h.first.drop();
    await until("a retry", () => h.sleeps.length === 1);
    h.handle.kill();
    wake();
    assert.deepEqual(h.exits, [{ exitCode: 0 }]);
    for (let i = 0; i < 20; i += 1) await tick();
    assert.equal(h.conn.shells.length, 0, "the loop stops: no channel opens after the close");
    assert.equal(h.exits.length, 1, "the pane ends exactly once");
    ok("a close during a reconnect stops the loop and ends the pane once");
  }

  {
    const h = harness(lib);
    h.first.drop();
    await until("a new channel", () => h.conn.shells.length === 1);
    assert.ok(h.conn.execOpts.every((o) => o.quiet === true), "the probe never prompts or wakes");
    assert.ok(h.conn.shellOpts.every((o) => o.quiet === true), "nor does the new channel");
    ok("reconnecting on its own is quiet: no password prompt, no box wake");
  }

  {
    const needsUser = Object.assign(new Error("needs a password"), { needsUser: true });
    const h = harness(lib);
    h.conn.probe = [needsUser, 0];
    h.first.drop();
    await until("the wait for a key", () => /press any key to reconnect/i.test(h.data.join("")));
    for (let i = 0; i < 20; i += 1) await tick();
    assert.equal(h.conn.execs.length, 1, "a host that needs the user is not retried in the background");
    assert.deepEqual(h.sleeps, []);
    assert.deepEqual(h.exits, [], "the pane stays open");
    assert.equal(h.handle.waitingForKey(), true);
    h.handle.write("text Studio sends on its own");
    for (let i = 0; i < 20; i += 1) await tick();
    assert.equal(h.conn.execs.length, 1, "a write is not a key: it never reconnects");
    h.handle.reconnectByUser();
    await until("a new channel", () => h.conn.shells.length === 1);
    assert.equal(h.handle.waitingForKey(), false);
    assert.equal(h.conn.execOpts[1].quiet, false, "the user's key may prompt");
    assert.equal(h.conn.shellOpts[0].quiet, false);
    const next = h.conn.shells[0];
    await until("the attach line", () => next.written.length === 1);
    assert.match(next.written[0], /attach-session/);
    ok("a host that needs a password waits for a key, and only that key may prompt");
  }

  {
    const h = harness(lib, { maxAttempts: 4 });
    h.conn.probe = Array.from({ length: 20 }, () => new Error("ETIMEDOUT"));
    h.first.drop();
    await until("the wait for a key", () => /press any key to reconnect/i.test(h.data.join("")));
    for (let i = 0; i < 20; i += 1) await tick();
    assert.equal(h.conn.execs.length, 4, "retries stop at the cap");
    assert.deepEqual(h.exits, []);
    h.conn.probe = [0];
    h.handle.reconnectByUser();
    await until("a new channel", () => h.conn.shells.length === 1);
    ok("retries are capped, then a key starts a new round");
  }

  {
    const off = harness(lib, { agentPane: false, reportExitStatus: false });
    off.first.exitShell(3);
    assert.deepEqual(off.exits, [{ exitCode: 3 }], "Machines off keeps a failure: 0 would close the pane");
    const clean = harness(lib, { agentPane: false, reportExitStatus: false });
    clean.first.exitShell(0);
    assert.deepEqual(clean.exits, [{ exitCode: 0 }]);
    const dropped = harness(lib, { agentPane: false, reportExitStatus: false });
    dropped.first.drop();
    assert.deepEqual(dropped.exits, [{ exitCode: -1 }]);
    const on = harness(lib, { agentPane: false });
    on.first.exitShell(130);
    assert.deepEqual(on.exits, [{ exitCode: 130 }]);
    ok("a plain shell reports its own status with Machines on or off");
  }

  {
    const off = harness(lib, { agentPane: false, reportExitStatus: false });
    off.handle.kill();
    off.first.exitShell(129);
    assert.deepEqual(off.exits, [{ exitCode: 0 }], "the hangup of a kill is no crash");
    const on = harness(lib, { agentPane: false });
    on.handle.kill();
    on.first.exitShell(129);
    assert.deepEqual(on.exits, [{ exitCode: 129 }]);
    ok("a pane Studio killed reports 0 with Machines off");
  }

  {
    for (const overrides of [{ agentPane: false }, { agentPane: false, reportExitStatus: false }, { agentPane: true }]) {
      const h = harness(lib, overrides);
      h.first.dieBySignal("SIGKILL");
      assert.deepEqual(h.exits, [{ exitCode: -1 }], "a signal death is no clean exit");
      assert.equal(h.conn.execs.length, 0, "a shell that died on the machine is not reconnected");
    }
    assert.equal(lib.remoteExitStatus(0), 0);
    assert.equal(lib.remoteExitStatus(3), 3);
    assert.equal(lib.remoteExitStatus(null), -1, "the early listener in pty-manager reads the same way");
    const early = harness(lib, { agentPane: false, closedBeforeBind: { exitCode: lib.remoteExitStatus(null) } });
    await until("the exit", () => early.exits.length === 1);
    assert.deepEqual(early.exits, [{ exitCode: -1 }]);
    ok("an ssh signal death reports -1, never 0");
  }

  {
    const h = harness(lib, { agentPane: false, closedBeforeBind: { exitCode: 2 } });
    await until("the exit", () => h.exits.length === 1);
    assert.deepEqual(h.exits, [{ exitCode: 2 }]);
    const h2 = harness(lib, { closedBeforeBind: { exitCode: null } });
    await until("a new channel", () => h2.conn.shells.length === 1);
    assert.deepEqual(h2.exits, []);
    ok("a close before the handle existed is not lost");
  }

  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
