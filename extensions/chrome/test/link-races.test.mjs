// Races between one connection and the next: a reply, a pairing being saved
// or a revocation that was still on its way when the link closed and another
// began. Fake sockets and held crypto steps put each race at a fixed point.

import assert from "node:assert/strict";
import { createECDH } from "node:crypto";

import { LinkClient, linkProof, pairCommitment, pairedToken, sessionSealer, sha256Hex } from "../lib/link-client.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await wait(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Hold the next call of a WebCrypto step until the test releases it. */
function hold(name) {
  const subtle = globalThis.crypto.subtle;
  const real = subtle[name];
  let reached;
  let release;
  const gate = { reached: new Promise((resolve) => (reached = resolve)), release: () => release() };
  const released = new Promise((resolve) => (release = resolve));
  subtle[name] = async (...args) => {
    delete subtle[name];
    reached();
    await released;
    return real.apply(subtle, args);
  };
  gate.restore = () => delete subtle[name];
  return gate;
}

/**
 * A Codara on a fake socket: answers hellos with a challenge (when it knows
 * the token) or a pairing (when asked), and seals what it sends once the
 * session starts. `answer: false` leaves hellos for the test to answer;
 * `allow: false` leaves a pairing waiting for the user's Allow.
 */
function fakeCodara() {
  const codara = { known: null, answer: true, allow: true, sockets: [] };
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.frames = [];
      this.codaraInbox = Promise.resolve();
      this.codaraOutbox = Promise.resolve();
      codara.sockets.push(this);
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.();
      }, 0);
    }

    send(data) {
      if (this.readyState !== 1) throw new Error("not open");
      this.codaraInbox = this.codaraInbox.then(() => this.receive(JSON.parse(data))).catch(() => {});
    }

    close() {
      if (this.readyState >= 2) return;
      this.readyState = 3;
      setTimeout(() => this.onclose?.(), 0);
    }

    /** Codara closes its end, as it does right after "revoked". */
    hangUp() {
      this.readyState = 3;
      this.onclose?.();
    }

    deliver(message) {
      setTimeout(() => this.readyState === 1 && this.onmessage?.({ data: JSON.stringify(message) }), 0);
    }

    /** Sealed, in order, as Codara's LinkSealer does. */
    sealed(message) {
      this.codaraOutbox = this.codaraOutbox.then(async () => {
        const frame = JSON.parse(await this.codaraSealer.seal(message));
        if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(frame) });
      });
      return this.codaraOutbox;
    }

    async receive(frame) {
      const message = this.codaraSealer ? await this.codaraSealer.open(frame) : frame;
      this.frames.push(message);
      if (message.type === "hello") {
        this.hello = message;
        if (codara.answer) await this.answerHello();
      } else if (message.type === "pair_key") {
        const { ecdh, key, commit } = this.codaraPairing;
        assert.equal(await pairCommitment(message.key), commit);
        if (!codara.allow) return;
        this.token = await pairedToken(ecdh.computeSecret(message.key, "hex", "hex"), message.key, key);
        codara.known = this.token;
        this.deliver({ type: "paired", linkId: "chrome-ab12" });
        this.codaraSealer = await sessionSealer(await sha256Hex(this.token), message.key, key, "codara");
      } else if (message.type === "auth") {
        const { secret, nonce, theirs } = this.codaraChallenge;
        assert.equal(message.proof, await linkProof(secret, "browser", nonce, theirs));
        this.deliver({ type: "welcome", protocol: 2, linkId: "chrome-ab12", app: { name: "Codara", version: "9.9.9" } });
        this.codaraSealer = await sessionSealer(secret, theirs, nonce, "codara");
      }
    }

    async answerHello() {
      const message = this.hello;
      if (message.linkId && message.nonce && codara.known) {
        const secret = await sha256Hex(codara.known);
        const nonce = "c".repeat(32);
        this.codaraChallenge = { secret, nonce, theirs: message.nonce };
        this.deliver({ type: "challenge", nonce, proof: await linkProof(secret, "codara", message.nonce, nonce) });
      } else if (message.pair) {
        const ecdh = createECDH("prime256v1");
        this.codaraPairing = { ecdh, key: ecdh.generateKeys("hex"), commit: message.pairCommit };
        this.deliver({ type: "pairing", key: this.codaraPairing.key });
      } else {
        this.deliver({ type: "unpaired" });
      }
    }
  }
  codara.WebSocket = FakeSocket;
  codara.last = () => codara.sockets.at(-1);
  return codara;
}

function makeClient(codara, store, onRequest = async () => ({})) {
  return new LinkClient({
    WebSocket: codara.WebSocket,
    ports: async () => [43117],
    hello: async () => ({ browser: { name: "Chromium", version: "141" }, extension: { id: "a".repeat(32), version: "1.4.1" } }),
    loadPairing: async () => (store.token ? { token: store.token, linkId: "chrome-ab12" } : null),
    savePairing: async (token) => {
      store.token = token;
      store.saves.push(token);
    },
    clearPairing: async () => {
      store.token = null;
      store.clears += 1;
    },
    onRequest,
    loadScan: async () => null,
    saveScan: async () => {},
  });
}

const newStore = (token = null) => ({ token, saves: [], clears: 0 });

/** Pair once, so the store holds a token this Codara knows. */
async function paired(codara, store) {
  const client = makeClient(codara, store);
  await client.connect({ pair: true });
  await until(() => client.status.state === "connected", "the first pairing");
  client.disconnect();
  return store.token;
}

export async function run() {
  // 1. A pairing cancelled while its token was being derived saves nothing,
  // and does not end the pairing that replaced it.
  {
    const codara = fakeCodara();
    const store = newStore();
    const client = makeClient(codara, store);
    // The first "paired" waits while its token is derived.
    const derive = hold("deriveBits");
    await client.connect({ pair: true });
    await derive.reached;
    const first = codara.last();
    client.disconnect();
    await client.connect({ pair: true });
    await until(() => client.status.state === "connected", "the pairing that replaced it");
    const second = codara.last();
    assert.notEqual(second, first);
    derive.release();
    await wait(30);
    assert.deepEqual(store.saves, [second.token], "the cancelled pairing saved no token");
    assert.equal(client.status.state, "connected");
    assert.equal(second.readyState, 1, "and did not close the pairing that replaced it");
    client.disconnect();
  }

  // 2. A revocation still being opened when the user paired again does not
  // erase the new pairing.
  {
    const codara = fakeCodara();
    const store = newStore();
    const oldToken = await paired(codara, store);
    const client = makeClient(codara, store);
    await client.connect();
    await until(() => client.status.state === "connected", "the proven link");
    const old = codara.last();
    const open = hold("decrypt");
    await old.sealed({ type: "revoked" });
    await open.reached;
    client.disconnect();
    codara.known = null;
    await client.connect({ pair: true });
    await until(() => client.status.state === "connected", "the new pairing");
    const newToken = store.token;
    assert.notEqual(newToken, oldToken);
    open.release();
    await wait(30);
    assert.equal(store.token, newToken, "the old revocation did not erase the new pairing");
    assert.equal(client.status.state, "connected");
    client.disconnect();
  }

  // 3. A request answered after its link closed is not sent on the next one,
  // which numbers its requests from 1 again.
  {
    const codara = fakeCodara();
    const store = newStore();
    await paired(codara, store);
    let answer;
    const asked = new Promise((resolve) => {
      answer = resolve;
    });
    let reachedRequest;
    const requested = new Promise((resolve) => (reachedRequest = resolve));
    const client = makeClient(codara, store, async () => {
      reachedRequest();
      await asked;
      return { stale: true };
    });
    await client.connect();
    await until(() => client.status.state === "connected", "the first link");
    const first = codara.last();
    await first.sealed({ id: 1, type: "cdp", tabId: 5, method: "Runtime.evaluate", params: {} });
    await requested;
    client.disconnect();
    await client.connect();
    await until(() => client.status.state === "connected", "the second link");
    const second = codara.last();
    const heard = second.frames.length;
    answer();
    await wait(30);
    await second.codaraInbox;
    assert.deepEqual(second.frames.slice(heard), [], "the old answer never reached the new link");
    assert.ok(!first.frames.some((m) => m.id === 1), "nor the closed one");
    client.disconnect();
  }

  // 4. An unsealed revocation while pairing again ends that attempt and
  // keeps the saved pairing: Codara revokes only inside the sealed session.
  {
    const codara = fakeCodara();
    const store = newStore();
    const token = await paired(codara, store);
    codara.known = null;
    codara.allow = false;
    const client = makeClient(codara, store);
    await client.connect({ pair: true });
    await until(() => client.status.state === "pairing", "the second pairing code");
    for (const type of ["revoked", "unpaired"]) {
      if (client.status.state !== "pairing") {
        await client.connect({ pair: true });
        await until(() => client.status.state === "pairing", "pairing again");
      }
      const socket = codara.last();
      const messages = [];
      client.deps.onMessage = (message) => messages.push(message);
      socket.deliver({ type });
      await until(() => client.status.state === "error", `the end of the attempt on an unsealed ${type}`);
      assert.equal(store.token, token, `an unsealed ${type} kept the saved pairing`);
      assert.equal(store.clears, 0);
      assert.deepEqual(messages, [], "and was not passed on as Codara's");
      assert.equal(socket.readyState, 3);
    }
    client.disconnect();
  }

  // 5. Disconnect pressed while the hello waits for Codara: the answer that
  // comes later adopts nothing.
  {
    const codara = fakeCodara();
    codara.answer = false;
    const store = newStore();
    const client = makeClient(codara, store);
    const connecting = client.connect({ pair: true });
    await until(() => codara.last()?.hello, "the hello");
    const socket = codara.last();
    client.disconnect();
    await socket.answerHello();
    await connecting;
    await wait(20);
    assert.equal(client.status.state, "idle", "the pairing code is never shown");
    assert.equal(client.socket, null);
    assert.equal(socket.readyState, 3);
    assert.ok(!socket.frames.some((m) => m.type === "pair_key"), "and no key is sent");
  }

  // 6. Codara revokes and closes at once: the close does not overtake the
  // revocation that arrived before it.
  {
    const codara = fakeCodara();
    const store = newStore();
    await paired(codara, store);
    const client = makeClient(codara, store);
    await client.connect();
    await until(() => client.status.state === "connected", "the proven link");
    const socket = codara.last();
    const open = hold("decrypt");
    await socket.sealed({ type: "revoked" });
    await open.reached;
    socket.hangUp();
    open.release();
    await until(() => client.status.state !== "connected", "the revocation");
    await wait(20);
    assert.equal(client.status.state, "unpaired", "the revocation was acted on");
    assert.equal(store.token, null);
    client.disconnect();
  }

  return "link races: a cancelled pairing saves no token, an old revocation never erases a new pairing, an old answer never goes out on a new link, an unsealed revocation keeps the saved pairing, a search cancelled mid-hello adopts nothing, and a close never overtakes the revocation before it";
}
