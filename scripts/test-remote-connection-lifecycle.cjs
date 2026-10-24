#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-ssh-lifecycle-"));

function createHarness() {
  return {
    clients: [],
    hostGates: [],
    deferredHosts: new Set(),
    statuses: [],
    wakes: [],
    freshKeyBudget: new Map(),
    clearedFreshKeys: [],
    hostOverrides: {},
    getHost(hostId) {
      const host = {
        id: hostId,
        label: hostId,
        host: `${hostId}.example`,
        port: 22,
        username: "codara",
        source: "manual",
        ...this.hostOverrides[hostId],
      };
      if (!this.deferredHosts.has(hostId)) return Promise.resolve(host);
      return new Promise((resolve) => {
        this.hostGates.push({ hostId, resolve: () => resolve(host) });
      });
    },
    takeHostGate(hostId, index = 0) {
      const matches = this.hostGates
        .map((gate, gateIndex) => ({ gate, gateIndex }))
        .filter(({ gate }) => gate.hostId === hostId);
      assert(matches[index], `expected host lookup gate ${index} for ${hostId}`);
      const { gate, gateIndex } = matches[index];
      this.hostGates.splice(gateIndex, 1);
      return gate;
    },
  };
}

function stubPlugin() {
  const sources = {
    ssh2: `
      import { EventEmitter } from "node:events";
      export class Client extends EventEmitter {
        constructor() {
          super();
          this.endCalls = 0;
          this.destroyCalls = 0;
          this.connectConfig = null;
          globalThis.__codaraSshLifecycleHarness.clients.push(this);
        }
        connect(config) {
          this.connectConfig = config;
          globalThis.__codaraSshLifecycleHarness.onConnect?.(this);
        }
        end() {
          this.endCalls += 1;
          // Like ssh2, ending the client ends its socket (a ProxyCommand's stdin).
          this.connectConfig?.sock?.end?.();
          return this;
        }
        destroy() {
          this.destroyCalls += 1;
          // Like ssh2, destroying the client destroys its socket, which for a
          // ProxyCommand host kills the proxy process.
          this.connectConfig?.sock?.destroy?.();
          return this;
        }
      }
      export const utils = {
        parseKey() {
          return {};
        },
      };
    `,
    "./ssh-hosts": `
      export function getHost(hostId) {
        return globalThis.__codaraSshLifecycleHarness.getHost(hostId);
      }
    `,
    "./codara-boxes": `
      export async function wakeCodaraBox(boxId, opts) {
        const harness = globalThis.__codaraSshLifecycleHarness;
        harness.wakes.push(boxId);
        opts.onPhase("Waking dev: starting the box");
      }
    `,
    "./box-key-retry": `
      export function nextFreshKeyDelayMs(hostId, attempt) {
        const h = globalThis.__codaraSshLifecycleHarness;
        const left = h.freshKeyBudget.get(hostId) ?? 0;
        if (attempt >= left) return null;
        return 1;
      }
      export function clearFreshBoxKey(hostId) {
        globalThis.__codaraSshLifecycleHarness.clearedFreshKeys.push(hostId);
      }
      export function abortableDelay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }
    `,
    "./secret-store": `
      export async function getSecret(key) {
        return key.startsWith("password:") ? "test-password" : null;
      }
      export async function setSecret() {}
      export async function deleteSecret() {}
    `,
    "../fs-atomic": "export async function writeFileAtomic() {}",
    "../codara-home": "export function codaraHome() { return '/tmp/codara-ssh-test'; }",
    "node:fs": `
      export const existsSync = () => false;
      export const promises = {
        async readFile() {
          const error = new Error("ENOENT");
          error.code = "ENOENT";
          throw error;
        },
      };
    `,
    "node:os": "export function homedir() { return '/missing-home'; }",
  };

  return {
    name: "remote-connection-lifecycle-stubs",
    setup(build) {
      for (const specifier of Object.keys(sources)) {
        const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({
          path: specifier,
          namespace: "ssh-lifecycle",
        }));
      }
      build.onLoad({ filter: /.*/, namespace: "ssh-lifecycle" }, (args) => ({
        contents: sources[args.path],
        loader: "js",
      }));
    },
  };
}

async function loadConnections(harness) {
  const outfile = path.join(TMP, "connections.cjs");
  globalThis.__codaraSshLifecycleHarness = harness;
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/remote/connections.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins: [stubPlugin()],
    logLevel: "silent",
  });
  return require(outfile);
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function waitForClientCount(harness, count) {
  for (let i = 0; i < 20 && harness.clients.length < count; i += 1) {
    await nextTurn();
  }
  assert.equal(harness.clients.length, count, `expected ${count} SSH client(s)`);
}

function observe(promise) {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
}

async function testDisconnectDuringConnect(api, harness) {
  const hostId = "disconnect-during-connect";
  const connection = await api.getConnection(hostId);
  const resultPromise = observe(connection.ensure());
  await waitForClientCount(harness, 1);
  const client = harness.clients[0];

  api.disconnectHost(hostId);
  const result = await resultPromise;
  assert.equal(result.ok, false, "disconnect must reject the pending ensure");
  assert.match(result.error.message, /cancelled|superseded/i);
  assert(client.endCalls >= 1, "disconnect must close the pending SSH client");
  assert(client.destroyCalls >= 1, "disconnect must destroy the pending SSH client");
  assert.deepEqual(api.getConnectionStatus(hostId), { hostId, state: "disconnected" });
  const verifierResult = await new Promise((resolve) => {
    client.connectConfig.hostVerifier(Buffer.from("late-key"), resolve);
  });
  assert.equal(verifierResult, false, "a stale host verifier must reject after disconnect");

  client.emit("ready");
  await nextTurn();
  assert.deepEqual(
    api.getConnectionStatus(hostId),
    { hostId, state: "disconnected" },
    "a late ready event must not resurrect the disconnected host",
  );
  await assert.rejects(connection.ensure(), /cancelled|superseded/i);
}

async function testNewerAttemptWins(api, harness) {
  const hostId = "newer-attempt-wins";
  const first = await api.getConnection(hostId);
  const firstResultPromise = observe(first.ensure());
  await waitForClientCount(harness, 2);
  const staleClient = harness.clients[1];

  // Resolve the transport, but supersede it before connect()'s continuation
  // can adopt the now-ready client.
  staleClient.emit("ready");
  assert.doesNotThrow(
    () => staleClient.emit("error", new Error("ready-to-adopt handoff error")),
    "the ready-to-adopt gap must retain an inert error listener",
  );
  api.disconnectHost(hostId);

  const second = await api.getConnection(hostId);
  assert.notEqual(second, first, "a post-disconnect request needs a fresh connection owner");
  const secondResultPromise = observe(second.ensure());
  await waitForClientCount(harness, 3);
  const winningClient = harness.clients[2];
  winningClient.emit("ready");

  const [firstResult, secondResult] = await Promise.all([
    firstResultPromise,
    secondResultPromise,
  ]);
  assert.equal(firstResult.ok, false, "the superseded ready client must be rejected");
  assert.match(firstResult.error.message, /cancelled|superseded/i);
  assert.equal(secondResult.ok, true, "the newer connection must win");
  assert.equal(secondResult.value, winningClient);
  assert(staleClient.endCalls >= 1, "a stale successfully-opened client must be closed");
  assert(staleClient.destroyCalls >= 1, "a stale successfully-opened client must be destroyed");
  assert.deepEqual(api.getConnectionStatus(hostId), { hostId, state: "connected" });
}

async function testHostLookupCannotRecreateAfterDisconnect(api, harness) {
  const hostId = "host-lookup-race";
  harness.deferredHosts.add(hostId);
  const staleLookup = observe(api.getConnection(hostId));
  await nextTurn();
  api.disconnectHost(hostId);
  harness.takeHostGate(hostId).resolve();
  const result = await staleLookup;
  assert.equal(result.ok, false, "a stale host lookup must not recreate the manager entry");
  assert.match(result.error.message, /cancelled|superseded/i);
  assert.deepEqual(api.getConnectionStatus(hostId), { hostId, state: "disconnected" });
}

async function testNoUnhandledRejectionOrListenerLeak(api, harness) {
  const hostId = "no-rejection-leak";
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const connection = await api.getConnection(hostId);
    const resultPromise = observe(connection.ensure());
    await waitForClientCount(harness, 4);
    const client = harness.clients[3];
    api.disconnectHost(hostId);
    await resultPromise;
    client.emit("error", new Error("late synthetic transport error"));
    client.emit("ready");
    await nextTurn();
    await nextTurn();
    assert.deepEqual(unhandled, [], "cancellation must not create an unhandled rejection");
    assert.equal(client.listenerCount("ready"), 0);
    assert.equal(
      client.listenerCount("error"),
      1,
      "a disposed client keeps exactly one inert sink for late transport errors",
    );
    assert.equal(client.listenerCount("close"), 0);
    assert.equal(client.listenerCount("end"), 0);
    assert.equal(client.listenerCount("keyboard-interactive"), 0);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
}

async function testProxyHost(api, harness) {
  const hostId = "codara-proxy-host";
  harness.hostOverrides[hostId] = {
    source: "codara-cloud",
    proxyCommand: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    hostKeyAlias: "codara-box.test",
    codaraBoxId: "6f1c2d3e-0000-4000-8000-00000000abcd",
  };
  const statusesBefore = harness.statuses.length;
  const connection = await api.getConnection(hostId);
  const resultPromise = observe(connection.ensure());
  await waitForClientCount(harness, 5);
  const client = harness.clients[4];
  assert.deepEqual(harness.wakes, ["6f1c2d3e-0000-4000-8000-00000000abcd"], "the box is woken first");
  assert(
    harness.statuses.slice(statusesBefore).some((s) => s.progress === "Waking dev: starting the box"),
    "wake phases are reported as progress",
  );
  const sock = client.connectConfig.sock;
  assert(sock, "a proxy host connects over the proxy's stdio");
  assert.equal(client.connectConfig.readyTimeout, 120000);
  const pid = sock.child.pid;
  client.emit("ready");
  assert.equal((await resultPromise).ok, true);
  client.emit("close");
  await new Promise((resolve) => sock.child.once("close", resolve));
  assert.throws(() => process.kill(pid, 0), "closing the client must kill the proxy child");
}

async function testFreshKeyRetry(api, harness) {
  const boxId = "6f1c2d3e-0000-4000-8000-00000000abcd";
  const authError = () => new Error("All configured authentication methods failed");
  const base = {
    source: "codara-cloud",
    proxyCommand: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    hostKeyAlias: "codara-box.fresh",
    codaraBoxId: boxId,
  };
  // One round is every auth method in turn (agent, then the stored password
  // here); a round ends at the attempt that carries the password.
  const run = async (hostId, { budget, acceptRound, error = authError }) => {
    harness.hostOverrides[hostId] = base;
    if (budget) harness.freshKeyBudget.set(hostId, budget);
    const first = harness.clients.length;
    let rounds = 0;
    harness.onConnect = (client) => {
      const endsRound = typeof client.connectConfig.password === "string";
      if (endsRound) rounds += 1;
      setImmediate(() => {
        if (endsRound && rounds === acceptRound) client.emit("ready");
        else client.emit("error", error());
      });
    };
    const statusesBefore = harness.statuses.length;
    try {
      const result = await observe((await api.getConnection(hostId)).ensure());
      return { result, rounds, clients: harness.clients.length - first, statusesBefore };
    } finally {
      harness.onConnect = null;
    }
  };

  // A freshly added key: refused twice, then it reaches the box.
  const fresh = await run("codara-fresh-key", { budget: 5, acceptRound: 3 });
  assert.equal(fresh.result.ok, true);
  assert.equal(fresh.rounds, 3);
  assert(
    harness.statuses.slice(fresh.statusesBefore).some((s) => /new SSH key/.test(s.progress ?? "")),
    "the wait is reported as progress",
  );
  assert(harness.clearedFreshKeys.includes("codara-fresh-key"), "success clears the fresh-key state");
  const freshClient = harness.clients[harness.clients.length - 1];
  api.disconnectHost("codara-fresh-key");
  // This proxy ignores the end of its input; dispose still closes it.
  await new Promise((resolve) => setTimeout(resolve, 2_200));
  assert(freshClient.destroyCalls >= 1, "a disposed client that stays open is force-closed");

  // The window ends: the authentication failure is reported.
  const spent = await run("codara-fresh-budget", { budget: 1, acceptRound: 99 });
  assert.equal(spent.result.ok, false);
  assert.match(spent.result.error.message, /authentication/i);
  assert.equal(spent.rounds, 2, "one retry, then stop");

  // No freshly added key: an authentication failure is final.
  const plain = await run("codara-plain-key", { acceptRound: 99 });
  assert.equal(plain.result.ok, false);
  assert.equal(plain.rounds, 1, "an ordinary auth failure is not retried");

  // A fresh key does not excuse other errors.
  const net = await run("codara-fresh-network", {
    budget: 5,
    acceptRound: 99,
    error: () => new Error("connect ECONNREFUSED"),
  });
  assert.equal(net.result.ok, false);
  assert.equal(net.clients, 1, "a network error stops at the first attempt");
}

async function main() {
  const harness = createHarness();
  const api = await loadConnections(harness);
  api.setStatusSender((status) => harness.statuses.push(status));

  try {
    await testDisconnectDuringConnect(api, harness);
    await testNewerAttemptWins(api, harness);
    await testHostLookupCannotRecreateAfterDisconnect(api, harness);
    await testNoUnhandledRejectionOrListenerLeak(api, harness);
    await testProxyHost(api, harness);
    await testFreshKeyRetry(api, harness);
  } finally {
    api.disposeAllConnections();
    delete globalThis.__codaraSshLifecycleHarness;
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log("remote SSH connection lifecycle tests passed");
}

main().catch((error) => {
  delete globalThis.__codaraSshLifecycleHarness;
  fs.rmSync(TMP, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
