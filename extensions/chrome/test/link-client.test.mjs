import assert from "node:assert/strict";
import { createServer } from "node:net";
import { WebSocketServer } from "ws";

import { LinkClient } from "../lib/link-client.js";

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
  let codaraSocket = null;
  let mode = "pair";
  const codara = await listen((socket) => {
    codaraSocket = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "hello") {
        hellos.push(message);
        if (mode === "deny") {
          socket.send(JSON.stringify({ type: "denied", message: "The user declined." }));
        } else if (message.token === "t".repeat(64)) {
          socket.send(JSON.stringify({ type: "welcome", protocol: 1, linkId: "chrome-ab12", app: { name: "Codara", version: "9.9.9" } }));
        } else if (message.pair) {
          socket.send(JSON.stringify({ type: "pairing", code: "483 921" }));
          setTimeout(() => socket.send(JSON.stringify({ type: "paired", token: "t".repeat(64), linkId: "chrome-ab12" })), 50);
        } else {
          socket.send(JSON.stringify({ type: "unpaired" }));
        }
      } else if (message.id !== undefined) {
        answers.push(message);
      }
    });
  });
  // A second Codara (another install, a test run) that never paired this browser.
  const otherHellos = [];
  const other = await listen((socket) => socket.on("message", (raw) => {
    otherHellos.push(JSON.parse(String(raw)));
    socket.send(JSON.stringify({ type: "unpaired" }));
  }));
  const unused = await freePort();
  let ports = [unused, stranger.address().port, codara.address().port];
  let token = null;
  const statuses = [];
  const requests = [];
  const client = new LinkClient({
    WebSocket,
    ports: async () => ports,
    hello: async () => ({ browser: { name: "Chromium", version: "141" }, extension: { id: "a".repeat(32), version: "1.0.0" } }),
    loadToken: async () => token,
    saveToken: async (next) => {
      token = next;
    },
    clearToken: async () => {
      token = null;
    },
    onRequest: async (request) => {
      requests.push(request);
      if (request.method === "Boom.fail") throw new Error("refused by the user's choice");
      return { echoed: request.method };
    },
    onStatus: (status) => statuses.push(status.state),
  });

  await client.connect();
  assert.equal(client.status.state, "idle", "without a token nothing connects until the user presses Connect");
  assert.equal(hellos.length, 0);

  await client.connect({ pair: true });
  await until(() => client.status.state === "connected", "pairing");
  assert.ok(statuses.includes("pairing"), "the code was shown while Codara waited for Allow");
  assert.equal(token, "t".repeat(64), "the token Codara issued is stored");
  assert.equal(client.status.port, codara.address().port, "the closed port and the stranger were skipped");
  assert.deepEqual({ ...hellos[0], protocol: undefined }, {
    type: "hello", protocol: undefined, browser: { name: "Chromium", version: "141" }, extension: { id: "a".repeat(32), version: "1.0.0" }, pair: true,
  });

  codaraSocket.send(JSON.stringify({ id: 1, type: "cdp", tabId: 5, method: "Runtime.evaluate", params: {} }));
  codaraSocket.send(JSON.stringify({ id: 2, type: "cdp", tabId: 5, method: "Boom.fail" }));
  await until(() => answers.length === 2, "two answers");
  assert.deepEqual(answers.find((a) => a.id === 1), { id: 1, result: { echoed: "Runtime.evaluate" } });
  assert.deepEqual(answers.find((a) => a.id === 2), { id: 2, error: { message: "refused by the user's choice" } });
  assert.equal(client.send({ type: "tabs", tabs: [] }), true);

  // Codara restarts: the client reconnects on its own with the token, past
  // the Codara that does not know it.
  ports = [unused, stranger.address().port, other.address().port, codara.address().port];
  codaraSocket.close();
  await until(() => client.status.state === "offline", "the loss");
  await until(() => client.status.state === "connected" && hellos.length === 2, "the reconnect", 8000);
  assert.equal(hellos[1].token, "t".repeat(64));
  assert.equal(hellos[1].pair, false);
  assert.equal(client.status.app.version, "9.9.9");
  assert.equal(otherHellos.at(-1).token, "t".repeat(64), "the other Codara was asked first");
  assert.equal(token, "t".repeat(64), "and its unpaired answer did not cost the token");

  // Only the other Codara is up: the popup says so and the token waits for its own Codara.
  ports = [other.address().port];
  codaraSocket.close();
  await until(() => client.status.state === "unpaired", "the unknown answer");
  assert.equal(token, "t".repeat(64));
  ports = [codara.address().port];
  await until(() => client.status.state === "connected", "the reconnect to the right Codara", 8000);

  // Disconnect in Codara revokes the token; nothing reconnects.
  codaraSocket.send(JSON.stringify({ type: "revoked" }));
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
  other.close();
  codara.close();
  return "link client: skips closed and foreign ports, pairs, answers requests, reconnects, tries past a Codara that does not know it, honors revoke and deny";
}
