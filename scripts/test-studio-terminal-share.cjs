#!/usr/bin/env node
"use strict";

// Focused, Electron-free coverage for read/write mirrors of terminals the
// user opened in Studio itself (studio-terminal-share.ts): the renderer
// inventory becomes phone-visible lease descriptors, and roster changes the
// renderer cannot report (a PTY dying under a still-mounted pane) surface
// through the onTerminalsChanged hook so paired phones get a list
// invalidation instead of waiting for their next reconnect.
//
//   node scripts/test-studio-terminal-share.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(
  ROOT,
  "src",
  "main",
  "remote-access",
  "studio-terminal-share.ts",
);

// The share store leans on the real pty-manager and terminal-bridge, both of
// which import electron at module scope. The store only touches a narrow
// runtime surface of each, so the bundle swaps them for stubs that delegate
// to per-test fakes installed on globalThis.
async function loadStore() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codara-studio-terminal-share-"),
  );
  const ptyStub = path.join(temporaryRoot, "pty-manager-stub.js");
  // Concrete named exports (a Proxy would lose them in esbuild's ESM interop
  // copy), each forwarding to the fake the running test installed.
  fs.writeFileSync(
    ptyStub,
    ["exists", "resourceSnapshot", "readTailChunks", "tap", "onExit", "write"]
      .map(
        (name) =>
          `exports.${name} = (...args) => globalThis.__studioSharePty.${name}(...args);\n`,
      )
      .join(""),
  );
  const bridgeStub = path.join(temporaryRoot, "terminal-bridge-stub.js");
  fs.writeFileSync(
    bridgeStub,
    "module.exports = {\n" +
      "  requestTerminalOp: (...args) =>\n" +
      "    globalThis.__studioShareBridge.requestTerminalOp(...args),\n" +
      "};\n",
  );
  const outfile = path.join(temporaryRoot, "studio-terminal-share.cjs");
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
    plugins: [
      {
        name: "studio-share-stubs",
        setup(build) {
          build.onResolve({ filter: /^\.\.\/pty-manager$/ }, () => ({
            path: ptyStub,
          }));
          build.onResolve({ filter: /^\.\.\/terminal-bridge$/ }, () => ({
            path: bridgeStub,
          }));
        },
      },
    ],
  });
  return require(outfile);
}

// Minimal PTY registry: enough state to answer exists/resourceSnapshot/
// readTailChunks and to let a test fire tapped output or an exit by hand.
function fakePtyManager() {
  const sessions = new Map();
  const api = {
    open(id, tail = []) {
      sessions.set(id, {
        createdAt: Date.now(),
        tail,
        taps: new Set(),
        exits: new Set(),
        writes: [],
      });
    },
    emitData(id, data) {
      for (const tap of sessions.get(id).taps) tap(Buffer.from(data, "utf8"));
    },
    emitExit(id) {
      const session = sessions.get(id);
      sessions.delete(id);
      for (const exit of session.exits) exit({ exitCode: 0 });
    },
    session(id) {
      return sessions.get(id);
    },
    exists: (id) => sessions.has(id),
    resourceSnapshot: () => ({
      sessions: [...sessions].map(([id, session]) => ({
        id,
        createdAt: session.createdAt,
      })),
    }),
    readTailChunks: (id, _maxBytes) => {
      const session = sessions.get(id);
      return session
        ? session.tail.map((chunk) => Buffer.from(chunk, "utf8"))
        : null;
    },
    tap: (id, handler) => {
      const session = sessions.get(id);
      session.taps.add(handler);
      return () => session.taps.delete(handler);
    },
    onExit: (id, handler) => {
      const session = sessions.get(id);
      session.exits.add(handler);
      return () => session.exits.delete(handler);
    },
    write: (id, data) => {
      sessions.get(id).writes.push(data);
    },
  };
  return api;
}

function inventoryItem(paneId, overrides = {}) {
  return {
    paneId,
    tabId: `tab-${paneId}`,
    workspaceId: "ws-1",
    title: `Terminal ${paneId}`,
    cwd: "/tmp/ws-1",
    profile: "shell",
    ...overrides,
  };
}

function subscriber() {
  const events = [];
  return {
    events,
    callbacks: {
      onData(event) {
        events.push({ type: "data", ...event });
      },
      onExit(event) {
        events.push({ type: "exit", ...event });
      },
    },
  };
}

async function main() {
  const { StudioTerminalShareStore } = await loadStore();
  let passed = 0;
  const test = async (name, fn) => {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  };

  await test(
    "list mirrors the renderer inventory and skips panes with no live PTY",
    async () => {
      const pty = fakePtyManager();
      globalThis.__studioSharePty = pty;
      let inventory = [
        inventoryItem("pane-1"),
        // Freshly minted tab whose PTY has not spawned yet: invisible for now,
        // picked up by the next list once the PTY is live.
        inventoryItem("pane-2"),
      ];
      globalThis.__studioShareBridge = {
        requestTerminalOp: async () => inventory,
      };
      pty.open("pane-1", ["boot"]);
      const changedPings = [];
      const store = new StudioTerminalShareStore({
        onTerminalsChanged: () => changedPings.push("ping"),
      });

      const first = await store.list("phone-a");
      assert.equal(first.length, 1);
      assert.equal(first[0].terminalId, "studio-pane-1");
      assert.equal(first[0].origin, "studio");
      assert.equal(first[0].closeable, false);
      assert.equal(first[0].phase, "live");
      // The retained tail was replayed into the ring without notifying anyone.
      assert.equal(first[0].sequence, 1);

      pty.open("pane-2");
      const second = await store.list("phone-a");
      assert.deepEqual(
        second.map((descriptor) => descriptor.terminalId).sort(),
        ["studio-pane-1", "studio-pane-2"],
      );
      assert.equal(changedPings.length, 0);
      store.shutdown();
    },
  );

  await test(
    "an attached phone replays the tail and streams live output",
    async () => {
      const pty = fakePtyManager();
      globalThis.__studioSharePty = pty;
      globalThis.__studioShareBridge = {
        requestTerminalOp: async () => [inventoryItem("pane-1")],
      };
      pty.open("pane-1", ["boot"]);
      const store = new StudioTerminalShareStore();
      await store.list("phone-a");

      const sink = subscriber();
      const attached = store.attach(
        "phone-a",
        "studio-pane-1",
        0,
        "phone-a-sub",
        sink.callbacks,
      );
      assert.deepEqual(attached.replay, [{ sequence: 1, data: "boot" }]);
      assert.equal(attached.truncated, false);

      pty.emitData("pane-1", "live output");
      assert.deepEqual(sink.events, [
        {
          type: "data",
          terminalId: "studio-pane-1",
          sequence: 2,
          data: "live output",
        },
      ]);

      store.write("phone-a", "studio-pane-1", "phone-a-sub", attached.attachmentId, 1, "ls\r");
      assert.deepEqual(pty.session("pane-1").writes, ["ls\r"]);
      store.shutdown();
    },
  );

  await test(
    "a dying desktop PTY notifies subscribers and pings the roster hook",
    async () => {
      const pty = fakePtyManager();
      globalThis.__studioSharePty = pty;
      globalThis.__studioShareBridge = {
        requestTerminalOp: async () => [inventoryItem("pane-1")],
      };
      pty.open("pane-1", ["boot"]);
      const changedPings = [];
      const store = new StudioTerminalShareStore({
        onTerminalsChanged: () => changedPings.push("ping"),
      });
      await store.list("phone-a");
      const sink = subscriber();
      store.attach("phone-a", "studio-pane-1", 0, "phone-a-sub", sink.callbacks);

      // The shell exits under a pane that may well stay mounted in Studio, so
      // the renderer's tab state never changes — this hook is the only path
      // that tells unattached phones their list is stale.
      pty.emitExit("pane-1");
      assert.deepEqual(sink.events.at(-1), {
        type: "exit",
        terminalId: "studio-pane-1",
        sequence: 2,
      });
      assert.equal(changedPings.length, 1);

      const after = await store.list("phone-a");
      assert.equal(after.length, 0);
      store.shutdown();
    },
  );

  await test(
    "a pane closed in Studio ends its mirror on the next synchronize",
    async () => {
      const pty = fakePtyManager();
      globalThis.__studioSharePty = pty;
      let inventory = [inventoryItem("pane-1")];
      globalThis.__studioShareBridge = {
        requestTerminalOp: async () => inventory,
      };
      pty.open("pane-1", ["boot"]);
      const changedPings = [];
      const store = new StudioTerminalShareStore({
        onTerminalsChanged: () => changedPings.push("ping"),
      });
      assert.equal((await store.list("phone-a")).length, 1);

      // Closing the tab removes the pane from the renderer inventory while
      // the PTY teardown may still be in flight; the mirror must not linger.
      inventory = [];
      assert.equal((await store.list("phone-a")).length, 0);
      assert.equal(changedPings.length, 1);
      store.shutdown();
    },
  );

  console.log(`${passed} studio-terminal-share tests passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
