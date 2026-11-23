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
  const notifyStub = path.join(temporaryRoot, "terminal-agent-notify-stub.js");
  fs.writeFileSync(
    notifyStub,
    "exports.noteTerminalUserInput = (...args) => (globalThis.__studioShareInputs ??= []).push(args);\n",
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
          build.onResolve({ filter: /^\.\.\/terminal-agent-notify$/ }, () => ({
            path: notifyStub,
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
    open(id, tail = [], opts = {}) {
      sessions.set(id, {
        createdAt: Date.now(),
        remote: opts.remote === true,
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
        remote: session.remote,
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
  const { StudioTerminalShareStore, studioPaneWatchedFromPhone } = await loadStore();
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
      assert.equal(first[0].desktopPaneId, "pane-1");
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

      globalThis.__studioShareInputs = [];
      store.write("phone-a", "studio-pane-1", "phone-a-sub", attached.attachmentId, 1, "ls\r");
      assert.deepEqual(pty.session("pane-1").writes, ["ls\r"]);
      // The phone's keys count as the user's input, so a relayed answer
      // never lands on a line typed there.
      assert.deepEqual(globalThis.__studioShareInputs, [["pane-1", "ls\r"]]);
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
    "an incomplete inventory cannot end a live terminal when an agent starts",
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

      const sink = subscriber();
      const attached = store.attach("phone-a", "studio-pane-1", 0, "phone-a-sub", sink.callbacks);
      inventory = [];
      assert.equal((await store.list("phone-a")).length, 1);
      assert.equal(changedPings.length, 0);
      pty.emitData("pane-1", "Codex ready");
      store.write("phone-a", "studio-pane-1", "phone-a-sub", attached.attachmentId, 1, "hello\r");
      assert.equal(sink.events.at(-1).type, "data");
      assert.deepEqual(pty.session("pane-1").writes, ["hello\r"]);
      inventory = [inventoryItem("pane-1", { profile: "codex" })];
      assert.equal((await store.list("phone-a"))[0].profile, "codex");
      assert.equal(sink.events.some((event) => event.type === "exit"), false);
      pty.emitExit("pane-1");
      assert.equal((await store.list("phone-a")).length, 0);
      assert.equal(changedPings.length, 1);
      store.shutdown();
    },
  );

  await test(
    "agent hibernation sees a pane a phone has open, and only while it does",
    async () => {
      const pty = fakePtyManager();
      globalThis.__studioSharePty = pty;
      const inventory = [inventoryItem("pane-1"), inventoryItem("pane-2")];
      globalThis.__studioShareBridge = {
        requestTerminalOp: async () => inventory,
      };
      pty.open("pane-1", ["boot"]);
      pty.open("pane-2", ["boot"]);
      const store = new StudioTerminalShareStore();
      await store.list("phone-a");
      // Listed for the phone, but nobody has it open yet.
      assert.equal(studioPaneWatchedFromPhone("pane-1"), false);
      const sink = subscriber();
      const attached = store.attach("phone-a", "studio-pane-1", 0, "phone-a-sub", sink.callbacks);
      assert.equal(studioPaneWatchedFromPhone("pane-1"), true);
      assert.equal(studioPaneWatchedFromPhone("pane-2"), false);
      store.detach("phone-a", "studio-pane-1", "phone-a-sub", attached.attachmentId);
      assert.equal(studioPaneWatchedFromPhone("pane-1"), false);
      store.attach("phone-a", "studio-pane-2", 0, "phone-b-sub", subscriber().callbacks);
      assert.equal(studioPaneWatchedFromPhone("pane-2"), true);
      store.detachSubscriber("phone-b-sub");
      assert.equal(studioPaneWatchedFromPhone("pane-2"), false);
      store.attach("phone-a", "studio-pane-1", 0, "phone-c-sub", subscriber().callbacks);
      pty.emitExit("pane-1");
      assert.equal(studioPaneWatchedFromPhone("pane-1"), false, "an ended terminal is watched by nobody");
      store.shutdown();
    },
  );

  await test(
    "preserves pi and antigravity profiles and normalizes malformed profiles to shell",
    async () => {
      const pty = fakePtyManager();
      globalThis.__studioSharePty = pty;
      let inventory = [
        inventoryItem("pane-pi", { profile: "pi" }),
        inventoryItem("pane-agy", { profile: "antigravity" }),
        inventoryItem("pane-bad", { profile: "bash" }),
      ];
      globalThis.__studioShareBridge = {
        requestTerminalOp: async () => inventory,
      };
      pty.open("pane-pi");
      pty.open("pane-agy");
      pty.open("pane-bad");
      const store = new StudioTerminalShareStore();
      const listed = await store.list("phone-a");
      const byPane = new Map(listed.map((item) => [item.desktopPaneId, item.profile]));
      assert.equal(byPane.get("pane-pi"), "pi");
      assert.equal(byPane.get("pane-agy"), "antigravity");
      assert.equal(byPane.get("pane-bad"), "shell");

      // Updating an existing record with an invalid profile also normalizes.
      inventory = [
        inventoryItem("pane-pi", { profile: "antigravity" }),
        inventoryItem("pane-agy", { profile: "unknown-cli" }),
      ];
      const updated = await store.list("phone-a");
      const updatedByPane = new Map(updated.map((item) => [item.desktopPaneId, item.profile]));
      assert.equal(updatedByPane.get("pane-pi"), "antigravity");
      assert.equal(updatedByPane.get("pane-agy"), "shell");
      store.shutdown();
    },
  );

  await test(
    "closeDesktopTab marks descriptors closeable, requires live attachment, and closes cleanly",
    async () => {
      const pty = fakePtyManager();
      globalThis.__studioSharePty = pty;
      const inventory = [inventoryItem("pane-close", { tabId: "tab-close", workspaceId: "ws-close", profile: "claude" })];
      globalThis.__studioShareBridge = {
        requestTerminalOp: async () => inventory,
      };
      pty.open("pane-close", ["ready"]);
      const closedCalls = [];
      const changedPings = [];
      const logs = [];
      let releaseClose;
      const store = new StudioTerminalShareStore({
        onTerminalsChanged: () => changedPings.push("ping"),
        closeDesktopTab: async (descriptor) => {
          closedCalls.push(descriptor);
          await new Promise((resolve) => {
            releaseClose = resolve;
          });
        },
        log: (line) => logs.push(line),
      });

      const listed = await store.list("phone-a");
      assert.equal(listed.length, 1);
      assert.equal(listed[0].closeable, true);

      const sinkA = subscriber();
      const sinkB = subscriber();
      const attachedA = store.attach("phone-a", "studio-pane-close", 0, "sub-a", sinkA.callbacks);
      store.attach("phone-b", "studio-pane-close", 0, "sub-b", sinkB.callbacks);

      // Unattached caller or stale attachment must be rejected without closing.
      await assert.rejects(
        () => store.close("phone-a", "studio-pane-close", "sub-unknown", attachedA.attachmentId, "req-bad-1"),
        /attachment is no longer current/i,
      );
      await assert.rejects(
        () => store.close("phone-a", "studio-pane-close", "sub-a", "wrong-attachment", "req-bad-2"),
        /attachment is no longer current/i,
      );
      assert.equal(closedCalls.length, 0);
      assert.equal(changedPings.length, 0);

      // Valid attached close awaits desktop close, detaches caller, ends record,
      // notifies other subscribers, and blocks resurrection while PTY winds down.
      const closingPromise = store.close("phone-a", "studio-pane-close", "sub-a", attachedA.attachmentId, "req-close-1");
      await new Promise((resolve) => setImmediate(resolve));
      releaseClose();
      await closingPromise;
      assert.deepEqual(closedCalls, [
        { workspaceId: "ws-close", desktopTabId: "tab-close", desktopPaneId: "pane-close" },
      ]);
      assert.equal(changedPings.length, 1);
      assert.equal(sinkA.events.some((event) => event.type === "exit"), false);
      assert.equal(sinkB.events.some((event) => event.type === "exit"), true);
      assert.equal(studioPaneWatchedFromPhone("pane-close"), false);
      // Even if the PTY is still tearing down and renderer lists the pane,
      // synchronize() must not resurrect it.
      assert.equal((await store.list("phone-a")).length, 0);
      pty.emitExit("pane-close");

      // Failing closeDesktopTab while PTY is still alive rejects and preserves record.
      pty.open("pane-fail");
      const failStore = new StudioTerminalShareStore({
        closeDesktopTab: async () => {
          throw new Error("desktop bridge unavailable");
        },
        log: (line) => logs.push(line),
      });
      globalThis.__studioShareBridge = {
        requestTerminalOp: async () => [inventoryItem("pane-fail")],
      };
      await failStore.list("phone-a");
      const failSink = subscriber();
      const attFail = failStore.attach("phone-a", "studio-pane-fail", 0, "sub-fail", failSink.callbacks);
      await assert.rejects(
        () => failStore.close("phone-a", "studio-pane-fail", "sub-fail", attFail.attachmentId, "req-fail"),
        /desktop bridge unavailable/i,
      );
      assert.equal(failSink.events.some((event) => event.type === "exit"), false);
      assert.equal(studioPaneWatchedFromPhone("pane-fail"), true);
      assert.equal((await failStore.list("phone-a")).length, 1);

      // SSH/remote PTYs and ssh:// cwd panes are never shared remotely.
      pty.open("pane-ssh-flag", [], { remote: true });
      pty.open("pane-ssh-cwd");
      pty.open("pane-local-ok");
      globalThis.__studioShareBridge = {
        requestTerminalOp: async () => [
          inventoryItem("pane-ssh-flag", { cwd: "/tmp/local" }),
          inventoryItem("pane-ssh-cwd", { cwd: "ssh://prod/srv/app" }),
          inventoryItem("pane-local-ok", { cwd: "/tmp/local" }),
        ],
      };
      const sshStore = new StudioTerminalShareStore();
      const sshListed = await sshStore.list("phone-a");
      assert.deepEqual(sshListed.map((d) => d.desktopPaneId), ["pane-local-ok"]);

      store.shutdown();
      failStore.shutdown();
      sshStore.shutdown();
    },
  );

  console.log(`${passed} studio-terminal-share tests passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
