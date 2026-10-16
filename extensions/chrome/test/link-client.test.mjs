import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { createServer } from "node:net";
import { WebSocketServer } from "ws";

import { LinkClient, linkProof, pairCommitment, pairedToken, pairingCode, sessionSealer, sha256Hex } from "../lib/link-client.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await wait(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function freePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function listen(onConnection) {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/codara-chrome" });
    server.on("connection", onConnection);
    server.on("listening", () => resolve(server));
  });
}

export async function run() {
  // Some other program on the first port answers a hello with nonsense.
  const stranger = await listen((socket) => socket.on("message", () => socket.send(JSON.stringify({ hello: "world" }))));
  const hellos = [];
  const answers = [];
  const heard = [];
  const codes = [];
  const shown = [];
  let codaraSocket = null;
  let issued = null;
  let mode = "pair";
  // Sealed frames carry their place in the stream, so each side seals and
  // opens one frame at a time.
  const toBrowser = (socket, message) => {
    socket.outbox = (socket.outbox ?? Promise.resolve()).then(async () => socket.send(await socket.sealer.seal(message)));
    return socket.outbox;
  };
  const codara = await listen((socket) => {
    codaraSocket = socket;
    let inbox = Promise.resolve();
    socket.on("message", (raw) => {
      heard.push(String(raw));
      inbox = inbox.then(() => receive(JSON.parse(String(raw)))).catch(() => socket.close());
    });
    const receive = async (frame) => {
      const message = socket.sealer ? await socket.sealer.open(frame) : frame;
      if (message.type === "hello") {
        hellos.push(message);
        if (mode === "deny") {
          socket.send(JSON.stringify({ type: "denied", message: "The user declined." }));
        } else if (message.linkId === "chrome-ab12" && message.nonce && issued) {
          const secret = await sha256Hex(issued);
          const nonce = "c".repeat(32);
          socket.challenge = { secret, nonce, theirs: message.nonce };
          socket.send(JSON.stringify({ type: "challenge", nonce, proof: await linkProof(secret, "codara", message.nonce, nonce) }));
        } else if (message.pair) {
          const ecdh = createECDH("prime256v1");
          socket.pairing = { ecdh, key: ecdh.generateKeys("hex"), commit: message.pairCommit };
          socket.send(JSON.stringify({ type: "pairing", key: socket.pairing.key }));
        } else {
          socket.send(JSON.stringify({ type: "unpaired" }));
        }
      } else if (message.type === "pair_key") {
        const { ecdh, key, commit } = socket.pairing;
        assert.equal(await pairCommitment(message.key), commit, "the key is the one the hello committed to");
        issued = await pairedToken(ecdh.computeSecret(message.key, "hex", "hex"), message.key, key);
        codes.push(await pairingCode(message.key, key));
        const sealer = await sessionSealer(await sha256Hex(issued), message.key, key, "codara");
        setTimeout(() => {
          socket.send(JSON.stringify({ type: "paired", linkId: "chrome-ab12" }));
          socket.sealer = sealer;
        }, 50);
      } else if (message.type === "auth") {
        const { secret, nonce, theirs } = socket.challenge;
        const ok = message.proof === (await linkProof(secret, "browser", nonce, theirs));
        const sealer = ok ? await sessionSealer(secret, theirs, nonce, "codara") : null;
        socket.send(JSON.stringify(ok ? { type: "welcome", protocol: 2, linkId: "chrome-ab12", app: { name: "Codara", version: "9.9.9" } } : { type: "unpaired" }));
        socket.sealer = sealer;
      } else if (message.id !== undefined) {
        answers.push(message);
      }
    };
  });
  // A second Codara (another install, a test run) that never paired this browser.
  const otherHellos = [];
  const other = await listen((socket) => socket.on("message", (raw) => {
    otherHellos.push(JSON.parse(String(raw)));
    socket.send(JSON.stringify({ type: "unpaired" }));
  }));
  // Programs that took a Codara port first: one says welcome without proving
  // anything, one sends a challenge it cannot back. Neither gets an answer.
  const impostorHeard = [];
  const impostor = (reply) => listen((socket) => socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    impostorHeard.push(message);
    if (message.type === "hello") socket.send(JSON.stringify(reply(message)));
  }));
  const eager = await impostor(() => ({ type: "welcome", protocol: 1, linkId: "chrome-ab12" }));
  const bluffer = await impostor(() => ({ type: "challenge", nonce: "d".repeat(32), proof: "0".repeat(64) }));
  // One offers a new pairing, hands over a token of its own and asks for a
  // tab; one refuses, which must not stop the search for the real Codara.
  const hijacker = await listen((socket) => socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    impostorHeard.push(message);
    if (message.type !== "hello") return;
    socket.send(JSON.stringify({ type: "pairing", code: "000 000" }));
    socket.send(JSON.stringify({ type: "paired", token: "e".repeat(64), linkId: "evil-0001" }));
    socket.send(JSON.stringify({ id: 99, type: "cdp", tabId: 5, method: "Runtime.evaluate", params: {} }));
  }));
  const refuser = await impostor(() => ({ type: "error", message: "Update the Codara extension." }));
  const unused = await freePort();
  let ports = [unused, stranger.address().port, codara.address().port];
  let token = null;
  const statuses = [];
  const requests = [];
  const reloads = [];
  const client = new LinkClient({
    WebSocket,
    ports: async () => ports,
    hello: async () => ({ browser: { name: "Chromium", version: "141" }, extension: { id: "a".repeat(32), version: "1.0.0" } }),
    loadPairing: async () => (token ? { token, linkId: "chrome-ab12" } : null),
    savePairing: async (next) => {
      token = next;
    },
    clearPairing: async () => {
      token = null;
    },
    onRequest: async (request) => {
      requests.push(request);
      if (request.method === "Boom.fail") throw new Error("refused by the user's choice");
      return { echoed: request.method };
    },
    onReload: (message) => reloads.push(message),
    onStatus: (status) => {
      statuses.push(status.state);
      if (status.code) shown.push(status.code);
    },
  });

  await client.connect();
  assert.equal(client.status.state, "idle", "without a token nothing connects until the user presses Connect");
  assert.equal(hellos.length, 0);

  await client.connect({ pair: true });
  await until(() => client.status.state === "connected", "pairing");
  assert.ok(statuses.includes("pairing"), "the code was shown while Codara waited for Allow");
  assert.equal(codes.length, 1);
  assert.deepEqual(shown, codes, "the browser shows the code Codara derived from both keys");
  assert.match(issued, /^[0-9a-f]{64}$/);
  assert.equal(token, issued, "both sides derived the same token");
  assert.equal(client.status.port, codara.address().port, "the closed port and the stranger were skipped");
  assert.match(hellos[0].pairCommit, /^[0-9a-f]{64}$/);
  assert.deepEqual({ ...hellos[0], protocol: undefined, pairCommit: undefined }, {
    type: "hello", protocol: undefined, browser: { name: "Chromium", version: "141" }, extension: { id: "a".repeat(32), version: "1.0.0" }, pair: true, pairCommit: undefined,
  });

  await toBrowser(codaraSocket, { id: 1, type: "cdp", tabId: 5, method: "Runtime.evaluate", params: {} });
  await toBrowser(codaraSocket, { id: 2, type: "cdp", tabId: 5, method: "Boom.fail" });
  await until(() => answers.length === 2, "two answers");
  assert.deepEqual(answers.find((a) => a.id === 1), { id: 1, result: { echoed: "Runtime.evaluate" } });
  assert.deepEqual(answers.find((a) => a.id === 2), { id: 2, error: { message: "refused by the user's choice" } });
  assert.equal(client.send({ type: "tabs", tabs: [] }), true);
  const answerFrames = heard.slice(-2).map((raw) => JSON.parse(raw));
  assert.ok(answerFrames.every((frame) => typeof frame.sealed === "string" && Object.keys(frame).length === 1), "answers leave sealed");

  // Codara asks for a reload over the sealed session; the same frame
  // unsealed is dropped with the link and never reloads anything.
  await toBrowser(codaraSocket, { type: "reload", version: "1.1.0" });
  await until(() => reloads.length === 1, "the sealed reload");
  assert.deepEqual(reloads[0], { type: "reload", version: "1.1.0" });
  codaraSocket.send(JSON.stringify({ type: "reload", version: "9.9.9" }));
  await until(() => client.status.state === "offline", "the drop on an unsealed reload");
  assert.equal(reloads.length, 1, "an unsealed reload never reaches the extension");
  await until(() => client.status.state === "connected", "the reconnect after the unsealed reload", 8000);

  // Something on the path injects a request of its own, then replays one of
  // Codara's frames: neither reaches a tab, and each ends the link.
  const before = requests.length;
  codaraSocket.send(JSON.stringify({ id: 7, type: "cdp", tabId: 5, method: "Runtime.evaluate", params: {} }));
  await until(() => client.status.state === "offline", "the drop on an unsealed frame");
  await until(() => client.status.state === "connected", "the reconnect after the drop", 8000);
  const replayed = await codaraSocket.sealer.seal({ id: 8, type: "cdp", tabId: 5, method: "Runtime.evaluate", params: {} });
  codaraSocket.send(replayed);
  await until(() => requests.length === before + 1, "the sealed request");
  codaraSocket.send(replayed);
  await until(() => client.status.state === "offline", "the drop on a replayed frame");
  assert.equal(requests.length, before + 1, "the injected and replayed requests never reached a tab");
  await until(() => client.status.state === "connected", "the reconnect after the replay", 8000);

  // Codara restarts: the client reconnects on its own with the token, past
  // the Codara that does not know it.
  ports = [
    unused,
    stranger.address().port,
    eager.address().port,
    bluffer.address().port,
    hijacker.address().port,
    refuser.address().port,
    other.address().port,
    codara.address().port,
  ];
  codaraSocket.close();
  await until(() => client.status.state === "offline", "the loss");
  const hellosBefore = hellos.length;
  await until(() => client.status.state === "connected" && hellos.length === hellosBefore + 1, "the reconnect", 8000);
  assert.equal(hellos.at(-1).linkId, "chrome-ab12");
  assert.match(hellos.at(-1).nonce, /^[0-9a-f]{32}$/);
  assert.equal(hellos.at(-1).pair, false);
  assert.equal(client.status.port, codara.address().port, "only the Codara that proved the pairing is used");
  assert.equal(client.status.app.version, "9.9.9");
  assert.equal(otherHellos.at(-1).linkId, "chrome-ab12", "the other Codara was asked first");
  assert.equal(token, issued, "and its unpaired answer did not cost the token");
  assert.deepEqual(impostorHeard.map((message) => message.type), ["hello", "hello", "hello", "hello"], "the impostors got a hello and nothing more");
  assert.equal(requests.filter((request) => request.id === 99).length, 0, "an unproven pairing offer never reaches a tab");
  assert.ok(!JSON.stringify([...heard, ...otherHellos, ...impostorHeard]).includes(issued), "the token never crosses the socket");

  // Connect pressed again while paired: the Codara that proves the pairing
  // wins over a program offering a new pairing on an earlier port.
  ports = [hijacker.address().port, codara.address().port];
  codaraSocket.close();
  await until(() => client.status.state === "offline", "the second loss");
  client.disconnect();
  await client.connect({ pair: true });
  await until(() => client.status.state === "connected", "the proven reconnect");
  assert.equal(client.status.port, codara.address().port);
  assert.equal(client.status.linkId, "chrome-ab12");
  assert.equal(token, issued, "the hijacker's token was never stored");

  // A refusal from a program on the only port is shown, and retried later.
  ports = [refuser.address().port];
  codaraSocket.close();
  await until(() => client.status.state === "error", "the refusal");
  assert.match(client.status.error, /Update the Codara extension/);
  ports = [codara.address().port];
  await until(() => client.status.state === "connected", "the retry after a refusal", 8000);

  // Only the other Codara is up: the popup says so and the token waits for its own Codara.
  ports = [other.address().port];
  codaraSocket.close();
  await until(() => client.status.state === "unpaired", "the unknown answer");
  assert.equal(token, issued);
  ports = [codara.address().port];
  await until(() => client.status.state === "connected", "the reconnect to the right Codara", 8000);

  // Disconnect in Codara revokes the token; nothing reconnects.
  await toBrowser(codaraSocket, { type: "revoked" });
  await until(() => client.status.state === "unpaired", "the revoke");
  assert.equal(token, null);
  const hellosAtRevoke = hellos.length;
  await wait(1300);
  assert.equal(hellos.length, hellosAtRevoke, "a revoked browser does not reconnect");

  mode = "deny";
  await client.connect({ pair: true });
  await until(() => client.status.state === "denied", "the denial");
  assert.match(client.status.error, /declined/);

  client.disconnect();
  stranger.close();
  eager.close();
  bluffer.close();
  hijacker.close();
  refuser.close();
  other.close();
  codara.close();
  return "link client: skips closed and foreign ports, pairs, answers requests, reconnects, tries past a Codara that does not know it, answers only a Codara that proves the pairing (never an unproven pairing offer), honors revoke and deny, pairs over ECDH without sending the token, reloads only when the sealed session asks, and drops the link on an unsealed or replayed frame";
}
