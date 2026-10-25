#!/usr/bin/env node
"use strict";

// pane.open lets a program in a Codara terminal (the `codara-pane` helper)
// open a terminal over its own pane or in a new tab beside it. It exists so
// tools built for WezTerm's zoomed split, such as a session picker, stay in
// the same window inside Codara instead of opening a new one. Guards:
// - the pane credential: minted per pane, names only that pane, replaced on a
//   same-id respawn without the old process's revoke touching the new token,
//   and dispatch lets it reach pane.open and nothing else;
// - parameter checks (mode, a one-line command, an absolute existing cwd);
// - the overlay bookkeeping: one overlay per pane, none over an overlay, an
//   overlay ends with the pane it covers, and a tab asked for from inside an
//   overlay opens beside the pane underneath.
//
//   node scripts/test-agent-socket-pane-open.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");

function loadTypeScriptModule(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(output, sourcePath);
  return loaded.exports;
}

const capabilities = loadTypeScriptModule(path.join(ROOT, "src", "main", "agent-socket-capabilities.ts"));
const paneOpen = loadTypeScriptModule(path.join(ROOT, "src", "main", "pane-open.ts"));

function fakeDeps() {
  const alive = new Set();
  const exitHandlers = new Map();
  const deps = {
    alive,
    calls: [],
    killed: [],
    spawnOk: true,
    // Per-call answers for waitForSpawn, used before spawnOk.
    spawnResults: [],
    nextOverlay: 1,
    nextTab: 1,
    directories: new Set(["/work", "/work/sub"]),
    paneAlive: (paneId) => alive.has(paneId),
    waitForSpawn: async (paneId) => {
      const answer = deps.spawnResults.length > 0 ? deps.spawnResults.shift() : deps.spawnOk;
      if (!answer) return false;
      alive.add(paneId);
      return true;
    },
    onExit: (paneId, handler) => {
      const list = exitHandlers.get(paneId) ?? [];
      list.push(handler);
      exitHandlers.set(paneId, list);
      return () => {
        const current = exitHandlers.get(paneId) ?? [];
        exitHandlers.set(paneId, current.filter((entry) => entry !== handler));
      };
    },
    kill: (paneId) => {
      deps.killed.push(paneId);
      deps.exit(paneId);
    },
    isDirectory: async (dir) => deps.directories.has(dir),
    requestTerminalOp: async (op, params) => {
      deps.calls.push({ op, params });
      if (op === "overlay") return { paneId: `overlay-${deps.nextOverlay++}`, hostPaneId: params.hostPaneId };
      if (op === "create") {
        const n = deps.nextTab++;
        return { tabId: `term-${n}`, paneId: `pane-new-${n}`, cwd: params.cwd ?? "/work" };
      }
      return { ok: true };
    },
    exit(paneId) {
      alive.delete(paneId);
      const handlers = exitHandlers.get(paneId) ?? [];
      exitHandlers.delete(paneId);
      for (const handler of handlers) handler();
    },
  };
  return deps;
}

async function rejectsWith(promise, kind, pattern) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof paneOpen.PaneOpenError, `expected PaneOpenError, got ${err}`);
    assert.equal(err.kind, kind);
    assert.match(err.message, pattern);
    return true;
  });
}

async function main() {
  // The pane credential.
  capabilities.resetAgentSocketCapabilitiesForTests();
  assert.equal(capabilities.mintPaneSocketCapability("pane-a"), null, "no credential before the socket listens");
  capabilities.setAgentSocketCapabilityEndpoint("http://127.0.0.1:43123");
  const first = capabilities.mintPaneSocketCapability("pane-a");
  assert.equal(first.environment.SPARK_PANE_SOCKET, "http://127.0.0.1:43123");
  assert.match(first.environment.SPARK_PANE_TOKEN, /^[a-f0-9]{64}$/);
  assert.deepEqual(capabilities.authorizePaneSocketCapability(first.environment.SPARK_PANE_TOKEN), { paneId: "pane-a" });
  assert.equal(
    capabilities.authorizeAgentSocketCapability(first.environment.SPARK_PANE_TOKEN),
    null,
    "a pane token is not a scoped agent capability",
  );
  assert.deepEqual([...capabilities.PANE_SOCKET_METHODS], ["pane.open"], "a pane credential reaches pane.open only");
  const respawned = capabilities.mintPaneSocketCapability("pane-a");
  assert.equal(capabilities.authorizePaneSocketCapability(first.environment.SPARK_PANE_TOKEN), null, "a respawn replaces the old token");
  first.revoke();
  assert.deepEqual(
    capabilities.authorizePaneSocketCapability(respawned.environment.SPARK_PANE_TOKEN),
    { paneId: "pane-a" },
    "the old process's teardown must not revoke its replacement",
  );
  respawned.revoke();
  assert.equal(capabilities.authorizePaneSocketCapability(respawned.environment.SPARK_PANE_TOKEN), null);
  assert.equal(capabilities.mintPaneSocketCapability("../escape"), null, "only well-formed pane ids get a credential");
  const other = capabilities.mintPaneSocketCapability("pane-b");
  capabilities.setAgentSocketCapabilityEndpoint(null);
  assert.equal(capabilities.authorizePaneSocketCapability(other.environment.SPARK_PANE_TOKEN), null, "closing the socket drops every pane token");
  console.log("PASS pane credentials are per pane, replaced on respawn and revoked on exit");

  // Dispatch wiring: the token names the pane, and nothing else is reachable.
  const socketSource = fs.readFileSync(path.join(ROOT, "src", "main", "agent-socket.ts"), "utf8");
  assert.match(
    socketSource,
    /if \(auth\.kind === "pane"\) \{\s*if \(!\(PANE_SOCKET_METHODS as readonly string\[\]\)\.includes\(method\)\)[\s\S]*?ERR_FORBIDDEN[\s\S]*?delete params\.runId;\s*params\.paneId = auth\.paneId;/,
    "dispatch must refuse other methods for a pane credential and stamp the pane id from the token",
  );
  assert.match(socketSource, /case "pane\.open":\s*return await handlePaneOpen\(params, id\);/);
  console.log("PASS dispatch confines a pane credential to pane.open on its own pane");

  // Parameter checks.
  const { parsePaneOpenParams } = paneOpen;
  assert.throws(() => parsePaneOpenParams({ mode: "overlay", command: "x" }), /paneId is required/);
  assert.throws(() => parsePaneOpenParams({ paneId: "p", mode: "window", command: "x" }), /mode must be/);
  assert.throws(() => parsePaneOpenParams({ paneId: "p", mode: "overlay" }), /needs a command/);
  assert.throws(() => parsePaneOpenParams({ paneId: "p", mode: "overlay", command: "a\nb" }), /single line/);
  assert.throws(() => parsePaneOpenParams({ paneId: "p", mode: "tab", cwd: "relative/dir" }), /absolute/);
  assert.throws(() => parsePaneOpenParams({ paneId: "p", mode: "tab", command: "x".repeat(8_193) }), /longer than/);
  assert.deepEqual(parsePaneOpenParams({ paneId: "p", mode: "tab", cwd: "/work", title: "  " }), {
    paneId: "p",
    mode: "tab",
    cwd: "/work",
  });
  console.log("PASS pane.open validates mode, command, cwd and title");

  // Overlay over the calling pane.
  const deps = fakeDeps();
  deps.alive.add("pane-host");
  const opener = paneOpen.createPaneOpener(deps);
  await rejectsWith(
    opener.open({ paneId: "pane-gone", mode: "overlay", command: "fzf" }),
    "invalid",
    /not running/,
  );
  await rejectsWith(
    opener.open({ paneId: "pane-host", mode: "overlay", command: "fzf", cwd: "/missing" }),
    "invalid",
    /not a folder/,
  );
  const overlay = await opener.open({ paneId: "pane-host", mode: "overlay", command: "picker --overlay", cwd: "/work/sub" });
  assert.deepEqual(overlay, { mode: "overlay", paneId: "overlay-1", hostPaneId: "pane-host" });
  assert.deepEqual(deps.calls.at(-1), {
    op: "overlay",
    params: { hostPaneId: "pane-host", command: "picker --overlay", cwd: "/work/sub" },
  });
  assert.equal(opener.hostOf("overlay-1"), "pane-host");
  await rejectsWith(
    opener.open({ paneId: "pane-host", mode: "overlay", command: "again" }),
    "invalid",
    /already has an overlay/,
  );
  await rejectsWith(
    opener.open({ paneId: "overlay-1", mode: "overlay", command: "nested" }),
    "invalid",
    /cannot open another overlay/,
  );

  // A tab asked for from inside the overlay opens beside the pane under it.
  const tab = await opener.open({ paneId: "overlay-1", mode: "tab", command: "claude --resume abc", cwd: "/work" });
  assert.deepEqual(tab, { mode: "tab", paneId: "pane-new-1", tabId: "term-1" });
  assert.deepEqual(deps.calls.at(-1), {
    op: "create",
    params: { cwd: "/work", command: "claude --resume abc", callerPaneId: "pane-host", requestedFromPane: true },
  });

  // The overlay's command exits: it is forgotten and the pane can have another.
  deps.exit("overlay-1");
  assert.equal(opener.hostOf("overlay-1"), null);
  const second = await opener.open({ paneId: "pane-host", mode: "overlay", command: "htop" });
  assert.equal(second.paneId, "overlay-2");

  // The covered pane closes: its overlay goes with it.
  deps.exit("pane-host");
  assert.deepEqual(deps.killed, ["overlay-2"]);
  assert.equal(opener.hostOf("overlay-2"), null);

  // A reloaded window shows no overlays: their programs end and the panes
  // are free again.
  deps.alive.add("pane-host");
  const third = await opener.open({ paneId: "pane-host", mode: "overlay", command: "fzf" });
  opener.closeAll();
  assert.deepEqual(deps.killed, ["overlay-2", third.paneId]);
  assert.equal(opener.hostOf(third.paneId), null);
  assert.equal((await opener.open({ paneId: "pane-host", mode: "overlay", command: "fzf" })).mode, "overlay");
  console.log("PASS overlays cover one pane at a time, end with it or a reload, and route tabs to the pane underneath");

  // Failures to start leave nothing behind.
  const failing = fakeDeps();
  failing.alive.add("pane-x");
  failing.spawnOk = false;
  const failingOpener = paneOpen.createPaneOpener(failing);
  await rejectsWith(failingOpener.open({ paneId: "pane-x", mode: "overlay", command: "x" }), "spawn", /failed to start/);
  assert.deepEqual(failing.calls.map((call) => call.op), ["overlay", "closeOverlay"]);
  assert.deepEqual(failing.killed, ["overlay-1"], "an overlay PTY already asked for is ended with its overlay");
  await rejectsWith(failingOpener.open({ paneId: "pane-x", mode: "tab" }), "spawn", /failed to start/);
  assert.deepEqual(failing.calls.at(-1), { op: "destroy", params: { tabId: "term-1", paneId: "pane-new-1" } });
  failing.spawnOk = true;
  const retried = await failingOpener.open({ paneId: "pane-x", mode: "overlay", command: "x" });
  assert.equal(retried.mode, "overlay", "a failed overlay does not block the next one");

  // The wait runs out, then the renderer's PTY comes up after all: it has no
  // overlay to show in, so it is ended instead of running unseen.
  const late = fakeDeps();
  late.alive.add("pane-y");
  late.spawnResults.push(false, true);
  const lateOpener = paneOpen.createPaneOpener(late);
  await rejectsWith(lateOpener.open({ paneId: "pane-y", mode: "overlay", command: "x" }), "spawn", /failed to start/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(late.killed, ["overlay-1", "overlay-1"], "a late overlay PTY is ended once it appears");
  assert.equal(late.alive.has("overlay-1"), false);
  assert.equal(lateOpener.hostOf("overlay-1"), null);
  console.log("PASS a terminal that never starts is cleaned up and reported as a spawn failure");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
