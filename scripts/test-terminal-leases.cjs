#!/usr/bin/env node
"use strict";

// Focused, Electron-free coverage for device-owned remote terminal leases.
//
//   node scripts/test-terminal-leases.cjs

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
  "terminal-leases.ts",
);

async function loadRegistry() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codara-terminal-leases-"),
  );
  const outfile = path.join(temporaryRoot, "terminal-leases.cjs");
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  return require(outfile);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function terminalRequest(overrides = {}) {
  return {
    workspaceId: "workspace-one",
    cols: 80,
    rows: 24,
    cwd: "/tmp/workspace-one",
    profile: "shell",
    title: "Phone terminal",
    origin: { kind: "phone", deviceName: "Test phone" },
    ...overrides,
  };
}

function fakeTerminal(request, overrides = {}) {
  const terminal = {
    request,
    writes: [],
    resizes: [],
    closeCalls: 0,
    writeError: null,
    resizeImpl: null,
    desktopTabId: overrides.desktopTabId ?? "tab-test",
    title: overrides.title ?? "Test terminal",
    write(data) {
      this.writes.push(data);
      if (this.writeError) throw this.writeError;
    },
    resize(cols, rows) {
      this.resizes.push({ cols, rows });
      return this.resizeImpl?.(cols, rows);
    },
    close() {
      this.closeCalls += 1;
    },
    emitData(data) {
      request.onData(data);
    },
    emitExit() {
      request.onExit();
    },
  };
  return terminal;
}

function registryHarness(RemoteTerminalLeaseRegistry, options = {}) {
  const terminals = [];
  const createTerminal =
    options.createTerminal ??
    (async (request) => {
      const terminal = fakeTerminal(request);
      terminals.push(terminal);
      return terminal;
    });
  const registry = new RemoteTerminalLeaseRegistry({
    createTerminal,
    detachedTtlMs: options.detachedTtlMs,
    endedTtlMs: options.endedTtlMs,
    maxReplayBytes: options.maxReplayBytes,
    maxPerOwner: options.maxPerOwner,
    maxTotal: options.maxTotal,
    log: options.log,
  });
  return { registry, terminals };
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

function attach(registry, ownerKey, terminalId, subscriberId, afterSequence = 0) {
  const sink = subscriber();
  const result = registry.attach(
    ownerKey,
    terminalId,
    afterSequence,
    subscriberId,
    sink.callbacks,
  );
  return { ...result, sink };
}

async function expectCode(action, code) {
  let thrown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `expected ${code} to be thrown`);
  assert.equal(thrown.code, code);
  return thrown;
}

async function waitFor(predicate, label, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function withRegistry(harness, fn) {
  try {
    await fn(harness.registry, harness.terminals);
  } finally {
    harness.registry.shutdown();
  }
}

async function main() {
  const { RemoteTerminalLeaseRegistry } = await loadRegistry();
  let passed = 0;
  const test = async (name, fn) => {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  await test("create request receipts spawn once and return current state", async () => {
    await withRegistry(
      registryHarness(RemoteTerminalLeaseRegistry),
      async (registry, terminals) => {
        const request = terminalRequest();
        const [first, joined] = await Promise.all([
          registry.createInteractive("phone-a", "create-once-001", request),
          registry.createInteractive("phone-a", "create-once-001", {
            ...request,
            origin: { kind: "phone", deviceName: "Renamed phone" },
          }),
        ]);
        assert.equal(terminals.length, 1);
        assert.equal(joined.terminalId, first.terminalId);

        const connection = attach(
          registry,
          "phone-a",
          first.terminalId,
          "socket-a",
        );
        await registry.resize(
          "phone-a",
          first.terminalId,
          "socket-a",
          connection.attachmentId,
          120,
          40,
        );
        const retried = await registry.createInteractive(
          "phone-a",
          "create-once-001",
          request,
        );
        assert.equal(terminals.length, 1);
        assert.equal(retried.terminalId, first.terminalId);
        assert.equal(retried.cols, 120);
        assert.equal(retried.rows, 40);
      },
    );
  });

  await test("reusing a create request id for different input conflicts", async () => {
    await withRegistry(
      registryHarness(RemoteTerminalLeaseRegistry),
      async (registry) => {
        await registry.createInteractive(
          "phone-a",
          "create-conflict-001",
          terminalRequest(),
        );
        await expectCode(
          () =>
            registry.createInteractive(
              "phone-a",
              "create-conflict-001",
              terminalRequest({ rows: 42 }),
            ),
          "TERMINAL_CREATE_CONFLICT",
        );
      },
    );
  });

  await test("a definite create failure drops its receipt and may retry safely", async () => {
    let attempts = 0;
    const createdTerminals = [];
    await withRegistry(
      registryHarness(RemoteTerminalLeaseRegistry, {
        createTerminal: async (request) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("renderer rejected the spawn before creating a PTY");
          }
          const terminal = fakeTerminal(request);
          createdTerminals.push(terminal);
          return terminal;
        },
      }),
      async (registry) => {
        const request = terminalRequest();
        await assert.rejects(
          registry.createInteractive(
            "phone-a",
            "retryable-create-001",
            request,
          ),
          /rejected the spawn/,
        );
        assert.equal(registry.list("phone-a").length, 0);
        assert.equal(attempts, 1);

        const retried = await registry.createInteractive(
          "phone-a",
          "retryable-create-001",
          request,
        );
        assert.equal(attempts, 2);
        assert.equal(createdTerminals.length, 1);
        assert.equal(retried.phase, "live");
        assert.equal(registry.list("phone-a")[0].terminalId, retried.terminalId);
      },
    );
  });

  await test("an ambiguous create failure stays sticky and never respawns", async () => {
    let attempts = 0;
    const outcomeUnknown = Object.assign(
      new Error("the renderer may already have created the PTY"),
      { code: "REMOTE_TERMINAL_CREATE_OUTCOME_UNKNOWN" },
    );
    await withRegistry(
      registryHarness(RemoteTerminalLeaseRegistry, {
        createTerminal: async () => {
          attempts += 1;
          throw outcomeUnknown;
        },
      }),
      async (registry) => {
        const request = terminalRequest();
        const first = await expectCode(
          () =>
            registry.createInteractive(
              "phone-a",
              "unknown-create-001",
              request,
            ),
          "REMOTE_TERMINAL_CREATE_OUTCOME_UNKNOWN",
        );
        const retried = await expectCode(
          () =>
            registry.createInteractive(
              "phone-a",
              "unknown-create-001",
              request,
            ),
          "REMOTE_TERMINAL_CREATE_OUTCOME_UNKNOWN",
        );
        assert.equal(attempts, 1);
        assert.equal(first, outcomeUnknown);
        assert.equal(retried, outcomeUnknown);
        assert.equal(registry.list("phone-a").length, 0);
      },
    );
  });

  await test("terminal ids reveal nothing across authenticated owners", async () => {
    await withRegistry(
      registryHarness(RemoteTerminalLeaseRegistry),
      async (registry) => {
        const created = await registry.createInteractive(
          "phone-a",
          "owner-isolation-001",
          terminalRequest(),
        );
        assert.equal(registry.list("phone-b").length, 0);
        const wrongOwner = await expectCode(
          () =>
            Promise.resolve(
              registry.attach(
                "phone-b",
                created.terminalId,
                0,
                "socket-b",
                subscriber().callbacks,
              ),
            ),
          "UNKNOWN_REMOTE_TERMINAL",
        );
        const nonexistent = await expectCode(
          () =>
            Promise.resolve(
              registry.attach(
                "phone-b",
                "rt-does-not-exist",
                0,
                "socket-b",
                subscriber().callbacks,
              ),
            ),
          "UNKNOWN_REMOTE_TERMINAL",
        );
        assert.equal(wrongOwner.message, nonexistent.message);
      },
    );
  });

  await test("only the latest attachment may mutate or receive output", async () => {
    await withRegistry(
      registryHarness(RemoteTerminalLeaseRegistry),
      async (registry, terminals) => {
        const created = await registry.createInteractive(
          "phone-a",
          "attachment-fence-001",
          terminalRequest(),
        );
        const oldConnection = attach(
          registry,
          "phone-a",
          created.terminalId,
          "socket-old",
        );
        const current = attach(
          registry,
          "phone-a",
          created.terminalId,
          "socket-new",
        );

        terminals[0].emitData("new owner only");
        assert.deepEqual(oldConnection.sink.events, []);
        assert.deepEqual(current.sink.events, [
          {
            type: "data",
            terminalId: created.terminalId,
            sequence: 1,
            data: "new owner only",
          },
        ]);
        await expectCode(
          () =>
            Promise.resolve(
              registry.write(
                "phone-a",
                created.terminalId,
                "socket-old",
                oldConnection.attachmentId,
                1,
                "stale write",
              ),
            ),
          "STALE_TERMINAL_ATTACHMENT",
        );
        await expectCode(
          () =>
            registry.resize(
              "phone-a",
              created.terminalId,
              "socket-old",
              oldConnection.attachmentId,
              100,
              30,
            ),
          "STALE_TERMINAL_ATTACHMENT",
        );
        await expectCode(
          () =>
            Promise.resolve(
              registry.close(
                "phone-a",
                created.terminalId,
                "socket-old",
                oldConnection.attachmentId,
                "close-stale-001",
              ),
            ),
          "STALE_TERMINAL_ATTACHMENT",
        );

        registry.write(
          "phone-a",
          created.terminalId,
          "socket-new",
          current.attachmentId,
          1,
          "current write",
        );
        assert.deepEqual(terminals[0].writes, ["current write"]);
      },
    );
  });

  await test("input sequencing is exact-once, gap-safe, and outcome-safe", async () => {
    await withRegistry(
      registryHarness(RemoteTerminalLeaseRegistry),
      async (registry, terminals) => {
        const created = await registry.createInteractive(
          "phone-a",
          "input-sequence-001",
          terminalRequest(),
        );
        const connection = attach(
          registry,
          "phone-a",
          created.terminalId,
          "socket-a",
        );
        const write = (inputSequence, data) =>
          registry.write(
            "phone-a",
            created.terminalId,
            "socket-a",
            connection.attachmentId,
            inputSequence,
            data,
          );

        write(1, "first");
        write(1, "first");
        assert.deepEqual(terminals[0].writes, ["first"]);
        await expectCode(
          () => Promise.resolve(write(1, "different")),
          "TERMINAL_INPUT_CONFLICT",
        );
        await expectCode(
          () => Promise.resolve(write(3, "gap")),
          "TERMINAL_INPUT_GAP",
        );

        terminals[0].writeError = new Error("PTY write result unknown");
        await expectCode(
          () => Promise.resolve(write(2, "may have arrived")),
          "TERMINAL_INPUT_OUTCOME_UNKNOWN",
        );
        assert.deepEqual(terminals[0].writes, ["first", "may have arrived"]);
        terminals[0].writeError = null;
        write(2, "may have arrived");
        assert.deepEqual(
          terminals[0].writes,
          ["first", "may have arrived"],
          "retrying an ambiguous accepted input must never write twice",
        );
        await expectCode(
          () => Promise.resolve(write(2, "changed retry")),
          "TERMINAL_INPUT_CONFLICT",
        );
        write(3, "after ambiguity");
        assert.deepEqual(terminals[0].writes, [
          "first",
          "may have arrived",
          "after ambiguity",
        ]);
        assert.equal(registry.list("phone-a")[0].nextInputSequence, 4);
      },
    );
  });

  await test("detach preserves the PTY and reattach reports bounded replay gaps", async () => {
    await withRegistry(
      registryHarness(RemoteTerminalLeaseRegistry, {
        maxReplayBytes: 8,
        detachedTtlMs: 1_000,
      }),
      async (registry, terminals) => {
        const created = await registry.createInteractive(
          "phone-a",
          "replay-window-001",
          terminalRequest(),
        );
        const first = attach(
          registry,
          "phone-a",
          created.terminalId,
          "socket-a",
        );
        terminals[0].emitData("aaaa");
        registry.detach(
          "phone-a",
          created.terminalId,
          "socket-a",
          first.attachmentId,
        );
        assert.equal(terminals[0].closeCalls, 0);
        terminals[0].emitData("bbbb");
        terminals[0].emitData("cccc");

        const resumed = attach(
          registry,
          "phone-a",
          created.terminalId,
          "socket-b",
          0,
        );
        assert.equal(resumed.truncated, true);
        assert.deepEqual(resumed.replay, [
          { sequence: 2, data: "bbbb" },
          { sequence: 3, data: "cccc" },
        ]);
        const fromLastKnown = attach(
          registry,
          "phone-a",
          created.terminalId,
          "socket-c",
          1,
        );
        assert.equal(fromLastKnown.truncated, false);
        assert.deepEqual(fromLastKnown.replay, resumed.replay);
      },
    );
  });

  await test("small replay budgets remain byte-bounded and UTF-8 safe", async () => {
    await withRegistry(
      registryHarness(RemoteTerminalLeaseRegistry, {
        maxReplayBytes: 5,
      }),
      async (registry, terminals) => {
        const created = await registry.createInteractive(
          "phone-a",
          "unicode-replay-001",
          terminalRequest(),
        );
        terminals[0].emitData("🙂🙂🙂");
        const resumed = attach(
          registry,
          "phone-a",
          created.terminalId,
          "socket-a",
          0,
        );
        const replayText = resumed.replay.map((entry) => entry.data).join("");
        assert(
          Buffer.byteLength(replayText, "utf8") <= 5,
          "replay must never exceed its byte budget",
        );
        assert(!replayText.includes("\uFFFD"), "UTF-8 must not be split badly");
        assert.equal(replayText, "🙂");
        assert.equal(resumed.truncated, true);
      },
    );
  });

  await test("close receipts are idempotent and conflict across terminals", async () => {
    await withRegistry(
      registryHarness(RemoteTerminalLeaseRegistry),
      async (registry, terminals) => {
        const first = await registry.createInteractive(
          "phone-a",
          "close-create-001",
          terminalRequest(),
        );
        const firstConnection = attach(
          registry,
          "phone-a",
          first.terminalId,
          "socket-a",
        );
        registry.close(
          "phone-a",
          first.terminalId,
          "socket-a",
          firstConnection.attachmentId,
          "close-request-001",
        );
        assert.equal(terminals[0].closeCalls, 1);
        assert.equal(registry.list("phone-a").length, 0);
        assert.doesNotThrow(() =>
          registry.close(
            "phone-a",
            first.terminalId,
            "socket-a",
            firstConnection.attachmentId,
            "close-request-001",
          ),
        );
        assert.equal(terminals[0].closeCalls, 1);

        const second = await registry.createInteractive(
          "phone-a",
          "close-create-002",
          terminalRequest({ title: "Second terminal" }),
        );
        const secondConnection = attach(
          registry,
          "phone-a",
          second.terminalId,
          "socket-a",
        );
        await expectCode(
          () =>
            Promise.resolve(
              registry.close(
                "phone-a",
                second.terminalId,
                "socket-a",
                secondConnection.attachmentId,
                "close-request-001",
              ),
            ),
          "TERMINAL_CLOSE_CONFLICT",
        );
        assert.equal(terminals[1].closeCalls, 0);
      },
    );
  });

  await test("natural exit is sequenced and ended leases expire", async () => {
    await withRegistry(
      registryHarness(RemoteTerminalLeaseRegistry, {
        endedTtlMs: 15,
        detachedTtlMs: 1_000,
      }),
      async (registry, terminals) => {
        const created = await registry.createInteractive(
          "phone-a",
          "natural-exit-001",
          terminalRequest(),
        );
        const connection = attach(
          registry,
          "phone-a",
          created.terminalId,
          "socket-a",
        );
        terminals[0].emitData("last output");
        terminals[0].emitExit();
        assert.deepEqual(connection.sink.events, [
          {
            type: "data",
            terminalId: created.terminalId,
            sequence: 1,
            data: "last output",
          },
          {
            type: "exit",
            terminalId: created.terminalId,
            sequence: 2,
          },
        ]);
        assert.equal(registry.list("phone-a")[0].phase, "ended");
        await waitFor(
          () => registry.list("phone-a").length === 0,
          "ended lease expiry",
        );
        assert.equal(terminals[0].closeCalls, 1);
      },
    );
  });

  await test("reattach cancels detached expiry until the next detach", async () => {
    await withRegistry(
      registryHarness(RemoteTerminalLeaseRegistry, {
        detachedTtlMs: 20,
        endedTtlMs: 1_000,
      }),
      async (registry, terminals) => {
        const created = await registry.createInteractive(
          "phone-a",
          "detach-expiry-001",
          terminalRequest(),
        );
        const first = attach(
          registry,
          "phone-a",
          created.terminalId,
          "socket-a",
        );
        registry.detach(
          "phone-a",
          created.terminalId,
          "socket-a",
          first.attachmentId,
        );
        await new Promise((resolve) => setTimeout(resolve, 8));
        const second = attach(
          registry,
          "phone-a",
          created.terminalId,
          "socket-b",
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(registry.list("phone-a").length, 1);
        assert.equal(terminals[0].closeCalls, 0);
        registry.detach(
          "phone-a",
          created.terminalId,
          "socket-b",
          second.attachmentId,
        );
        await waitFor(
          () => registry.list("phone-a").length === 0,
          "detached lease expiry after the final detach",
        );
        assert.equal(terminals[0].closeCalls, 1);
      },
    );
  });

  await test("owner revocation wins a pending spawn and closes the late handle", async () => {
    const spawn = deferred();
    const terminals = [];
    const harness = registryHarness(RemoteTerminalLeaseRegistry, {
      createTerminal: async (request) => {
        const terminal = await spawn.promise;
        terminal.request = request;
        return terminal;
      },
    });
    await withRegistry(harness, async (registry) => {
      const creation = registry.createInteractive(
        "phone-a",
        "revoke-spawn-001",
        terminalRequest(),
      );
      await waitFor(
        () => registry.list("phone-a")[0]?.phase === "starting",
        "pending terminal lease",
      );
      registry.revokeOwner("phone-a");
      assert.equal(registry.list("phone-a").length, 0);
      const late = fakeTerminal({
        onData() {},
        onExit() {},
      });
      terminals.push(late);
      spawn.resolve(late);
      await assert.rejects(creation, /ended before it was ready/i);
      assert.equal(late.closeCalls, 1);
      assert.equal(registry.list("phone-a").length, 0);
    });
  });

  await test("retained ended leases count against device and global caps", async () => {
    await withRegistry(
      registryHarness(RemoteTerminalLeaseRegistry, {
        maxPerOwner: 2,
        maxTotal: 3,
        endedTtlMs: 10_000,
      }),
      async (registry, terminals) => {
        const first = await registry.createInteractive(
          "phone-a",
          "cap-owner-a-001",
          terminalRequest({ title: "A one" }),
        );
        await registry.createInteractive(
          "phone-a",
          "cap-owner-a-002",
          terminalRequest({ title: "A two" }),
        );
        terminals[0].emitExit();
        terminals[1].emitExit();
        assert.equal(registry.list("phone-a").length, 2);
        await expectCode(
          () =>
            registry.createInteractive(
              "phone-a",
              "cap-owner-a-003",
              terminalRequest({ title: "A three" }),
            ),
          "REMOTE_TERMINAL_DEVICE_CAP",
        );

        await registry.createInteractive(
          "phone-b",
          "cap-owner-b-001",
          terminalRequest({ workspaceId: "workspace-two" }),
        );
        await expectCode(
          () =>
            registry.createInteractive(
              "phone-b",
              "cap-owner-b-002",
              terminalRequest({
                workspaceId: "workspace-two",
                title: "Global overflow",
              }),
            ),
          "REMOTE_TERMINAL_GLOBAL_CAP",
        );
        registry.revokeOwner("phone-a");
        assert.equal(registry.list("phone-a").length, 0);
        const admitted = await registry.createInteractive(
          "phone-b",
          "cap-owner-b-002",
          terminalRequest({
            workspaceId: "workspace-two",
            title: "Admitted after revoke",
          }),
        );
        assert.ok(admitted.terminalId);
        assert.equal(registry.list("phone-b").length, 2);
        assert.ok(first.terminalId);
      },
    );
  });

  await test("rejected and superseded async resizes never publish false geometry", async () => {
    await withRegistry(
      registryHarness(RemoteTerminalLeaseRegistry),
      async (registry, terminals) => {
        const created = await registry.createInteractive(
          "phone-a",
          "async-resize-001",
          terminalRequest(),
        );
        const first = attach(
          registry,
          "phone-a",
          created.terminalId,
          "socket-a",
        );

        terminals[0].resizeImpl = async () => {
          throw new Error("resize transport failed");
        };
        await assert.rejects(
          registry.resize(
            "phone-a",
            created.terminalId,
            "socket-a",
            first.attachmentId,
            132,
            43,
          ),
          /resize transport failed/,
        );
        assert.equal(registry.list("phone-a")[0].cols, 80);
        assert.equal(registry.list("phone-a")[0].rows, 24);

        const resizeGate = deferred();
        terminals[0].resizeImpl = () => resizeGate.promise;
        const pending = registry.resize(
          "phone-a",
          created.terminalId,
          "socket-a",
          first.attachmentId,
          140,
          50,
        );
        attach(
          registry,
          "phone-a",
          created.terminalId,
          "socket-b",
        );
        resizeGate.resolve();
        await expectCode(
          () => pending,
          "STALE_TERMINAL_ATTACHMENT",
        );
        assert.equal(
          registry.list("phone-a")[0].cols,
          80,
          "a superseded resize completion must not update the descriptor",
        );
        assert.equal(registry.list("phone-a")[0].rows, 24);
      },
    );
  });

  await test("handoff serialization leaves the physical PTY at the newest geometry", async () => {
    await withRegistry(
      registryHarness(RemoteTerminalLeaseRegistry),
      async (registry, terminals) => {
        const created = await registry.createInteractive(
          "phone-a",
          "physical-resize-001",
          terminalRequest(),
        );
        const oldConnection = attach(
          registry,
          "phone-a",
          created.terminalId,
          "socket-old",
        );
        const oldResizeGate = deferred();
        let physicalGeometry = { cols: 80, rows: 24 };
        terminals[0].resizeImpl = async (cols, rows) => {
          // Hold the old owner's native resize in flight until after the new
          // owner has attached and requested its own geometry.
          if (terminals[0].resizes.length === 1) {
            await oldResizeGate.promise;
          }
          physicalGeometry = { cols, rows };
        };

        const oldResize = registry.resize(
          "phone-a",
          created.terminalId,
          "socket-old",
          oldConnection.attachmentId,
          120,
          40,
        );
        await waitFor(
          () => terminals[0].resizes.length === 1,
          "the old native resize to enter flight",
        );

        const newConnection = attach(
          registry,
          "phone-a",
          created.terminalId,
          "socket-new",
        );
        const newResize = registry.resize(
          "phone-a",
          created.terminalId,
          "socket-new",
          newConnection.attachmentId,
          160,
          55,
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(
          terminals[0].resizes,
          [{ cols: 120, rows: 40 }],
          "the new owner must wait instead of racing the in-flight native resize",
        );

        oldResizeGate.resolve();
        await Promise.all([
          expectCode(
            () => oldResize,
            "STALE_TERMINAL_ATTACHMENT",
          ),
          newResize,
        ]);

        assert.deepEqual(
          terminals[0].resizes,
          [
            { cols: 120, rows: 40 },
            { cols: 80, rows: 24 },
            { cols: 160, rows: 55 },
          ],
          "the stale completion must restore published geometry before applying the new owner's resize",
        );
        assert.deepEqual(
          physicalGeometry,
          { cols: 160, rows: 55 },
          "the physical PTY must finish at the newest owner's geometry",
        );
        assert.equal(registry.list("phone-a")[0].cols, 160);
        assert.equal(registry.list("phone-a")[0].rows, 55);
      },
    );
  });

  console.log(`${passed} terminal-lease tests passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
