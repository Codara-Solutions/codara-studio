"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { buildSync } = require("esbuild");
const path = require("node:path");

(async () => {
  const sockets = [], streams = [], timers = new Set();
  const peer = Buffer.alloc(32, 7);
  class Socket extends EventEmitter {
    static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 1; bufferedAmount = 0; sent = [];
    constructor() { super(); sockets.push(this); }
    send(data, _opts, callback) { this.sent.push(data); callback?.(); }
    close() { this.readyState = 3; this.emit("close"); }
    terminate() { this.close(); }
  }
  class Noise extends EventEmitter {
    remotePublicKey = peer;
    constructor() { super(); streams.push(this); }
    destroy() { this.emit("close"); }
  }
  const output = buildSync({ entryPoints: [path.join(__dirname, "../src/main/remote-access/relay-client.ts")],
    bundle: true, write: false, platform: "node", format: "cjs",
    external: ["ws", "sodium-native", "@hyperswarm/secret-stream"] }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, Buffer, process, console,
    require(name) {
      if (name === "ws") return Socket;
      if (name === "@hyperswarm/secret-stream") return Noise;
      if (name === "sodium-native") return { crypto_sign_detached() {} };
      return require(name);
    },
    setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  });
  const { RemoteRelayClient } = module.exports;
  const ready = [];
  const client = new RemoteRelayClient({ url: "wss://relay.test/v1/relay",
    keyPair: { publicKey: Buffer.alloc(32, 1), secretKey: Buffer.alloc(64, 2) },
    isAuthorized: (key) => key.equals(peer), onAuthorizedStream() {},
    onReadyChanged: (value) => ready.push(value), log() {},
  });
  const control = (socket, value) => socket.emit("message", Buffer.from(JSON.stringify(value)), false);
  const started = client.start();
  const first = sockets[0];
  first.emit("open");
  control(first, { type: "ready" });
  assert.equal(await started, true);
  const deadline = [...timers].find((timer) => timer.ms === 60_000);
  assert(deadline);
  first.emit("ping");
  assert(!timers.has(deadline), "heartbeat renews the client deadline");
  for (let i = 1; i <= 5; i++) {
    control(first, { type: "incoming", streamId: i.toString(16).padStart(32, "0"), peer: peer.toString("base64") });
    streams.at(-1).emit("open");
  }
  assert.equal(first.sent.filter((data) => JSON.parse(data).type === "accept").length, 5,
    "completed handshakes do not consume the four pending-handshake slots");
  [...timers].find((timer) => timer.ms === 60_000).fn();
  assert.equal(first.readyState, Socket.CLOSED);
  const reconnect = [...timers].find((timer) => timer.ms >= 1000 && timer.ms < 1250);
  assert(reconnect);
  reconnect.fn();
  const second = sockets[1];
  second.emit("open");
  control(second, { type: "ready" });
  first.emit("close");
  assert.equal(ready.at(-1), true, "a stale socket cannot disconnect its replacement");
  await client.stop();
  assert.equal(ready.at(-1), false);
  console.log("PASS relay heartbeat deadline, handshake capacity and stale socket isolation");
})().catch((err) => { console.error(err); process.exitCode = 1; });
