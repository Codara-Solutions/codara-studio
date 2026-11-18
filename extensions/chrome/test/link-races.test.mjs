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

/** Hold the next call of a WebCrypto step (that `matches`) until the test releases it. */
function hold(name, matches = () => true) {
  const subtle = globalThis.crypto.subtle;
  const real = subtle[name];
  let reached;
  let release;
  const gate = { reached: new Promise((resolve) => (reached = resolve)), release: () => release() };
  const released = new Promise((resolve) => (release = resolve));
  subtle[name] = async (...args) => {
    if (!matches(args)) return real.apply(subtle, args);
    delete subtle[name];
    reached();
    await released;
    return real.apply(subtle, args);
  };
  gate.restore = () => delete subtle[name];
  return gate;
}

/**
 * The browser's session key: in a handshake Codara imports its AES key
 * before it answers "welcome", and the browser imports its own after.
 */
function browserSessionKey() {
  let seen = 0;
  return (args) => args[2] === "AES-GCM" && ++seen === 2;
}

/** Hold the store's next `key` step (beforeSave, beforeClear, beforeScanSave). */
function holdStore(store, key) {
  let reached;
  let release;
  const gate = { reached: new Promise((resolve) => (reached = resolve)), release: () => release() };
  const released = new Promise((resolve) => (release = resolve));
  store[key] = async () => {
    store[key] = null;
    reached();
    await released;
  };
  return gate;
}

async function step(store, key) {
  if (store[key]) await store[key]();
}

/**
 * A Codara on a fake socket: answers hellos with a challenge (when it knows
 * the token) or a pairing (when asked), and seals what it sends once the
 * session starts. `answer: false` leaves hellos for the test to answer;
 * `allow: false` leaves a pairing waiting for the user's Allow.
 */
function fakeCodara() {
  const codara = { known: null, answer: true, allow: true, down: false, ports: [43117], sockets: [] };
  class FakeSocket {
    constructor(url) {
      if (codara.down) throw new Error("connection refused");
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
        const token = await pairedToken(ecdh.computeSecret(message.key, "hex", "hex"), message.key, key);
        // Codara's own key work is done before it answers, so the only
        // WebCrypto calls after the answer are the browser's.
        this.codaraSealer = await sessionSealer(await sha256Hex(token), message.key, key, "codara");
        this.token = token;
        codara.known = token;
        this.deliver({ type: "paired", linkId: "chrome-ab12" });
      } else if (message.type === "auth") {
        const { secret, nonce, theirs } = this.codaraChallenge;
        assert.equal(message.proof, await linkProof(secret, "browser", nonce, theirs));
        this.codaraSealer = await sessionSealer(secret, theirs, nonce, "codara");
        this.deliver({ type: "welcome", protocol: 2, linkId: "chrome-ab12", app: { name: "Codara", version: "9.9.9" } });
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
    ports: async () => codara.ports,
    hello: async () => ({ browser: { name: "Chromium", version: "141" }, extension: { id: "a".repeat(32), version: "1.4.1" } }),
    loadPairing: async () => (store.token ? { token: store.token, linkId: "chrome-ab12" } : null),
    // Like the extension's save(): the value is in memory at once, the
    // write lands later.
    savePairing: async (token) => {
      store.token = token;
      await step(store, "beforeSave");
      store.saves.push(token);
    },
    clearPairing: async () => {
      await step(store, "beforeClear");
      store.token = null;
      store.clears += 1;
    },
    onRequest,
    loadScan: async () => null,
    saveScan: async () => step(store, "beforeScanSave"),
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
    let link = null;
    const client = makeClient(codara, store, async (request, asking) => {
      link = asking;
      reachedRequest();
      await asked;
      return { stale: true };
    });
    await client.connect();
    await until(() => client.status.state === "connected", "the first link");
    const first = codara.last();
    await first.sealed({ id: 1, type: "cdp", tabId: 5, method: "Runtime.evaluate", params: {} });
    await requested;
    assert.equal(link.live(), true, "the handler is told its link is in use");
    client.disconnect();
    assert.equal(link.live(), false, "and that it is not, once it closed");
    await client.connect();
    await until(() => client.status.state === "connected", "the second link");
    assert.equal(link.live(), false, "a later link is not the one that asked");
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
    await wait(20);
    assert.equal(client.status.state, "connected", "the close waits for the frame before it");
    open.release();
    await until(() => client.status.state !== "connected", "the revocation");
    await wait(20);
    assert.equal(client.status.state, "unpaired", "the revocation was acted on");
    assert.equal(store.token, null);
    client.disconnect();
  }

  // 7. A pairing offer whose handshake resumes after its probe timed out
  // adopts nothing: the next port's Codara stays the link.
  {
    const codara = fakeCodara();
    codara.allow = false;
    codara.ports = [43117, 43118];
    const store = newStore();
    const client = makeClient(codara, store);
    // The browser's digests: its key commitment, then the pairing code.
    let digests = 0;
    const setup = hold("digest", () => ++digests === 2);
    void client.connect({ pair: true });
    await setup.reached;
    const slow = codara.last();
    await until(() => client.status.state === "pairing" && codara.last() !== slow, "the next port's pairing", 5000);
    const next = codara.last();
    setup.release();
    await wait(30);
    assert.equal(client.socket, next, "the late handshake did not take the link");
    assert.equal(client.status.state, "pairing");
    assert.equal(next.readyState, 1);
    client.disconnect();
  }

  // 8. Codara closes while the browser still sets up the session: the link
  // never shows connected on a closed socket.
  {
    const codara = fakeCodara();
    const store = newStore();
    await paired(codara, store);
    const client = makeClient(codara, store);
    const setup = hold("importKey", browserSessionKey());
    void client.connect();
    await setup.reached;
    codara.last().hangUp();
    setup.release();
    await wait(30);
    assert.ok(client.socket === null || client.socket.readyState === 1, "no link on a closed socket");
    client.disconnect();
  }

  // 9. Pairing again, cancelled while the new token was being saved: the
  // pairing saved before comes back.
  {
    const codara = fakeCodara();
    const store = newStore();
    const before = await paired(codara, store);
    codara.known = null;
    const client = makeClient(codara, store);
    const saving = holdStore(store, "beforeSave");
    void client.connect({ pair: true });
    await saving.reached;
    client.disconnect();
    saving.release();
    await wait(30);
    assert.equal(store.token, before, "the earlier pairing is kept");
  }

  // 10. A revocation's clear still pending while the user paired again:
  // it clears only the pairing it revoked, never the new one.
  {
    const codara = fakeCodara();
    const store = newStore();
    await paired(codara, store);
    const client = makeClient(codara, store);
    await client.connect();
    await until(() => client.status.state === "connected", "the proven link");
    const clearing = holdStore(store, "beforeClear");
    await codara.last().sealed({ type: "revoked" });
    await clearing.reached;
    client.disconnect();
    codara.known = null;
    void client.connect({ pair: true });
    await wait(30);
    clearing.release();
    await until(() => client.status.state === "connected", "the new pairing");
    await wait(20);
    assert.equal(store.token, codara.last().token, "the new pairing is saved and kept");
    assert.equal(client.status.state, "connected");
    client.disconnect();
  }

  // 11. A lost link's retry, still saving its scan when a newer search set
  // its own retry, leaves that newer retry alone.
  {
    const codara = fakeCodara();
    const store = newStore();
    await paired(codara, store);
    const client = makeClient(codara, store);
    await client.connect();
    await until(() => client.status.state === "connected", "the proven link");
    const scanSave = holdStore(store, "beforeScanSave");
    codara.last().hangUp();
    await scanSave.reached;
    codara.down = true;
    await client.connect();
    assert.equal(client.status.state, "offline");
    const retry = client.reconnectTimer;
    assert.ok(retry, "the newer search set a retry");
    scanSave.release();
    await wait(30);
    assert.equal(client.reconnectTimer, retry, "the lost link's retry did not replace or clear it");
    client.disconnect();
  }

  // 12. Pairing again, cancelled while saving: a reconnect meanwhile reads
  // the pairing only after the save was taken back, never the new token.
  {
    const codara = fakeCodara();
    const store = newStore();
    const before = await paired(codara, store);
    codara.known = null;
    const client = makeClient(codara, store);
    const saving = holdStore(store, "beforeSave");
    void client.connect({ pair: true });
    await saving.reached;
    client.disconnect();
    const reconnecting = client.connect();
    await wait(30);
    saving.release();
    await reconnecting;
    await wait(30);
    assert.equal(store.token, before, "the earlier pairing is back");
    assert.notEqual(client.status.state, "connected", "and the cancelled token never authenticated a link");
    client.disconnect();
  }

  // 13. Disconnect in the popup while a re-pairing is being saved: the
  // pairing is forgotten, the approval is not kept, nothing reconnects.
  {
    const codara = fakeCodara();
    const store = newStore();
    await paired(codara, store);
    codara.known = null;
    const client = makeClient(codara, store);
    const saving = holdStore(store, "beforeSave");
    void client.connect({ pair: true });
    await saving.reached;
    const forgetting = client.forget({ type: "unpair" });
    saving.release();
    await forgetting;
    await wait(30);
    assert.equal(store.token, null, "Disconnect forgot every pairing");
    assert.equal(client.status.state, "idle");
    assert.equal(client.reconnectTimer, null, "and nothing reconnects");
  }

  // 14. Codara proves the pairing, then revokes and closes while the browser
  // still sets up the session, past the probe's deadline: the revocation
  // still counts.
  {
    const codara = fakeCodara();
    const store = newStore();
    await paired(codara, store);
    const client = makeClient(codara, store);
    const setup = hold("importKey", browserSessionKey());
    void client.connect();
    await setup.reached;
    const socket = codara.last();
    await socket.sealed({ type: "revoked" });
    socket.hangUp();
    await wait(1700);
    setup.release();
    await until(() => client.status.state === "unpaired", "the revocation", 3000);
    assert.equal(store.token, null, "the revoked pairing is forgotten");
    client.disconnect();
  }

  // 15. Disconnect while its "unpair" is still being sealed, the old link
  // drops and the alarm looks for Codara: nothing reconnects with the token
  // Disconnect is forgetting.
  {
    const codara = fakeCodara();
    const store = newStore();
    await paired(codara, store);
    const client = makeClient(codara, store);
    await client.connect();
    await until(() => client.status.state === "connected", "the proven link");
    const old = codara.last();
    const sealing = hold("encrypt");
    const forgetting = client.forget({ type: "unpair" });
    await sealing.reached;
    old.hangUp();
    await wait(10);
    await client.connect();
    sealing.release();
    await forgetting;
    await wait(30);
    assert.equal(store.token, null);
    assert.equal(client.socket, null, "no link was made with the forgotten token");
    assert.equal(client.status.state, "idle");
  }

  // 16. Disconnect, the old link drops while "unpair" leaves, and the user
  // presses Connect again: the end of Disconnect does not cancel that search.
  {
    const codara = fakeCodara();
    const store = newStore();
    await paired(codara, store);
    const client = makeClient(codara, store);
    await client.connect();
    await until(() => client.status.state === "connected", "the proven link");
    const old = codara.last();
    const sealing = hold("encrypt");
    const forgetting = client.forget({ type: "unpair" });
    await sealing.reached;
    old.hangUp();
    await wait(10);
    codara.answer = false;
    codara.allow = false;
    void client.connect({ pair: true });
    await until(() => codara.last() !== old && codara.last().hello, "the new hello");
    sealing.release();
    await forgetting;
    await codara.last().answerHello();
    await until(() => client.status.state === "pairing", "the new pairing code");
    assert.equal(store.token, null, "and the old pairing is forgotten");
    client.disconnect();
  }

  return "link races: a cancelled pairing saves no token, an old revocation never erases a new pairing, an old answer never goes out on a new link, an unsealed revocation keeps the saved pairing, a search cancelled mid-hello adopts nothing, a close never overtakes the frame before it, a timed-out handshake adopts nothing, a cancelled re-pairing keeps the earlier pairing, a revocation clears only its own pairing, an old retry never clears a newer one, a reconnect never reads a save that may be taken back, Disconnect keeps no approval in flight, lets nothing reconnect with the token it forgets and never cancels a Connect pressed after it, and a proven Codara's revocation counts past the probe deadline";
}
