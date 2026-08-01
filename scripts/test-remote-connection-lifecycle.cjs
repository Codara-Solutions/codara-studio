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
    getHost(hostId) {
      const host = {
        id: hostId,
        label: hostId,
        host: `${hostId}.example`,
        port: 22,
        username: "codara",
        source: "manual",
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
        }
        end() {
          this.endCalls += 1;
          return this;
        }
        destroy() {
          this.destroyCalls += 1;
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
    "./secret-store": `
      export async function getSecret(key) {
        return key.startsWith("password:") ? "test-password" : null;
      }
      export async function setSecret() {}
      export async function deleteSecret() {}
    `,
    "../fs-atomic": "export async function writeFileAtomic() {}",
    "../spark-home": "export function sparkHome() { return '/tmp/codara-ssh-test'; }",
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

async function main() {
  const harness = createHarness();
  const api = await loadConnections(harness);
  api.setStatusSender((status) => harness.statuses.push(status));

  try {
    await testDisconnectDuringConnect(api, harness);
    await testNewerAttemptWins(api, harness);
    await testHostLookupCannotRecreateAfterDisconnect(api, harness);
    await testNoUnhandledRejectionOrListenerLeak(api, harness);
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
