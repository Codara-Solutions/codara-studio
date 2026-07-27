// Test client for phone Remote Access, standing in for the mobile app until
// it ships. It speaks the same wire protocol the phone does: Noise IK over
// TCP for the LAN rung, hyperdht for the off-LAN rung, then length-prefixed
// JSON RPC v0.
//
// First run (pairing) takes the QR payload the Settings modal shows:
//
//   node scripts/remote-test-client.mjs pair '<qr payload json>'
//
// Later runs need no arguments; the client reuses the identity and the
// pinned computer key it stored beside itself:
//
//   node scripts/remote-test-client.mjs connect
//
// `connect` climbs the ladder (LAN addresses first, then the DHT), runs
// hello + workspaces.list, opens a terminal, echoes a line through it,
// prints what the pty sent back, and closes cleanly. State lives in
// ./remote-test-client-state.json relative to the CURRENT WORKING
// DIRECTORY, so running this from a scratch dir keeps a test identity out
// of the repo.

import { createRequire } from "node:module";
import { connect as tcpConnect } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

const require = createRequire(import.meta.url);
const NoiseSecretStream = require("@hyperswarm/secret-stream");
const HyperDHT = require("hyperdht");

const STATE_FILE = resolve(process.cwd(), "remote-test-client-state.json");
const PROTOCOL_VERSION = 0;
const CLIENT_NAME = "remote-test-client";
const LAN_DIAL_TIMEOUT_MS = 4000;
const DHT_DIAL_TIMEOUT_MS = 15_000;

/* ----------------------------------------------------------------- framing */

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

class FrameDecoder {
  #buffered = Buffer.alloc(0);

  push(chunk) {
    this.#buffered = Buffer.concat([this.#buffered, Buffer.from(chunk)]);
    const frames = [];
    for (;;) {
      if (this.#buffered.length < 4) break;
      const declared = this.#buffered.readUInt32BE(0);
      if (this.#buffered.length < 4 + declared) break;
      frames.push(JSON.parse(this.#buffered.subarray(4, 4 + declared).toString("utf8")));
      this.#buffered = this.#buffered.subarray(4 + declared);
    }
    return frames;
  }
}

/* ------------------------------------------------------------------- state */

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

// This client's own device identity. Generated on first pair and reused
// afterwards, exactly like the phone's keychain-backed identity.
function loadOrCreateIdentity(state) {
  if (state?.identity) {
    return {
      publicKey: Buffer.from(state.identity.publicKey, "base64"),
      secretKey: Buffer.from(state.identity.secretKey, "base64"),
    };
  }
  return HyperDHT.keyPair();
}

/* --------------------------------------------------------------- transport */

// Noise IK over a plain TCP socket, pinned to the computer's public key.
function dialLan(host, port, keyPair, remotePublicKey, timeoutMs = LAN_DIAL_TIMEOUT_MS) {
  return new Promise((resolvePromise, reject) => {
    const socket = tcpConnect({ host, port });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error(`timeout dialing ${host}:${port}`)), timeoutMs);
    socket.on("error", fail);
    const stream = new NoiseSecretStream(true, socket, {
      keyPair,
      remotePublicKey,
      pattern: "IK",
    });
    stream.on("error", fail);
    stream.on("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(stream);
    });
  });
}

function dialDht(dht, remotePublicKey, keyPair, timeoutMs = DHT_DIAL_TIMEOUT_MS) {
  return new Promise((resolvePromise, reject) => {
    const stream = dht.connect(remotePublicKey, { keyPair });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(new Error("timeout dialing over the dht"));
    }, timeoutMs);
    stream.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    stream.on("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(stream);
    });
  });
}

// The connection ladder: every LAN address in the QR's preferred order,
// then the DHT. First rung that completes a handshake wins.
async function climbLadder(computer, keyPair, { skipDht = false } = {}) {
  const remotePublicKey = Buffer.from(computer.publicKey, "base64");
  for (const host of computer.addrs) {
    try {
      const stream = await dialLan(host, computer.port, keyPair, remotePublicKey);
      return { stream, rung: `lan ${host}:${computer.port}`, dht: null };
    } catch (err) {
      console.log(`  rung lan ${host}:${computer.port} failed: ${err.message}`);
    }
  }
  if (skipDht) throw new Error("no LAN rung answered and the dht rung is disabled");
  console.log("  trying the dht rung");
  const dht = new HyperDHT();
  try {
    const stream = await dialDht(dht, remotePublicKey, keyPair);
    return { stream, rung: "dht", dht };
  } catch (err) {
    await dht.destroy();
    throw new Error(`no rung of the ladder answered (last: ${err.message})`);
  }
}

/* --------------------------------------------------------------- rpc client */

class RpcClient {
  #stream;
  #decoder = new FrameDecoder();
  #pending = new Map();
  #nextId = 1;
  #eventHandlers = [];

  constructor(stream) {
    this.#stream = stream;
    stream.on("data", (chunk) => {
      for (const frame of this.#decoder.push(chunk)) this.#onFrame(frame);
    });
  }

  #onFrame(frame) {
    if (frame && typeof frame.event === "string") {
      for (const handler of this.#eventHandlers) handler(frame);
      return;
    }
    const entry = this.#pending.get(frame?.id);
    if (!entry) return;
    this.#pending.delete(frame.id);
    if (frame.ok) entry.resolve(frame.result);
    else entry.reject(new Error(`${frame.error?.code}: ${frame.error?.message}`));
  }

  onEvent(handler) {
    this.#eventHandlers.push(handler);
  }

  request(method, params) {
    const id = this.#nextId++;
    return new Promise((resolvePromise, reject) => {
      this.#pending.set(id, { resolve: resolvePromise, reject });
      this.#stream.write(encodeFrame({ id, method, params }));
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 15_000);
    });
  }
}

/* -------------------------------------------------------------- operations */

async function pair(qrArgument) {
  if (!qrArgument) throw new Error("pair needs the QR payload JSON as its argument");
  const payload = JSON.parse(qrArgument);
  if (payload.v !== 1) throw new Error(`unsupported pairing payload version ${payload.v}`);

  const state = loadState();
  const keyPair = loadOrCreateIdentity(state);
  const computerKey = Buffer.from(payload.pk, "base64");
  if (computerKey.length !== 32) throw new Error("pairing payload has a malformed computer key");

  console.log(`pairing with ${payload.name ?? "computer"} ${payload.pk.slice(0, 8)}`);
  let stream = null;
  for (const host of payload.addrs) {
    try {
      stream = await dialLan(host, payload.port, keyPair, computerKey);
      console.log(`  connected over lan ${host}:${payload.port}`);
      break;
    } catch (err) {
      console.log(`  rung lan ${host}:${payload.port} failed: ${err.message}`);
    }
  }
  if (!stream) throw new Error("could not reach the computer on any address in the QR code");

  const decoder = new FrameDecoder();
  // The desktop now asks its user to approve the device before replying, so
  // the reply can take up to the approval window (about a minute). We keep
  // the pairing stream open and wait; a deny or a timeout closes the stream,
  // which the "close" handler below turns into a clean refusal.
  const response = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("the computer did not answer the pairing request")), 65_000);
    stream.on("data", (chunk) => {
      const frames = decoder.push(chunk);
      if (frames.length === 0) return;
      clearTimeout(timer);
      resolvePromise(frames[0]);
    });
    stream.on("close", () => {
      clearTimeout(timer);
      reject(new Error("the computer closed the connection without pairing"));
    });
    stream.write(encodeFrame({ t: "pair", secret: payload.secret, name: CLIENT_NAME }));
  });
  stream.destroy();

  if (response?.t !== "paired") throw new Error(`unexpected pairing reply: ${JSON.stringify(response)}`);

  saveState({
    identity: {
      publicKey: keyPair.publicKey.toString("base64"),
      secretKey: keyPair.secretKey.toString("base64"),
    },
    computer: {
      publicKey: payload.pk,
      name: response.name,
      addrs: payload.addrs,
      port: payload.port,
      pairedAt: Date.now(),
    },
  });
  console.log(`paired with "${response.name}", state saved to ${STATE_FILE}`);
}

async function connect({ skipDht = false } = {}) {
  const state = loadState();
  if (!state?.computer) throw new Error(`no pairing found in ${STATE_FILE}; run "pair" first`);
  const keyPair = loadOrCreateIdentity(state);

  console.log(`connecting to "${state.computer.name}" ${state.computer.publicKey.slice(0, 8)}`);
  const { stream, rung, dht } = await climbLadder(state.computer, keyPair, { skipDht });
  console.log(`  connected over ${rung}`);

  const client = new RpcClient(stream);
  const terminalOutput = [];
  client.onEvent((frame) => {
    if (frame.event === "terminal.data") terminalOutput.push(frame.payload.data);
  });

  const hello = await client.request("hello", {
    protocol: PROTOCOL_VERSION,
    device: {
      publicKey: keyPair.publicKey.toString("base64"),
      name: CLIENT_NAME,
      role: "phone",
      version: "0.1.0",
    },
  });
  console.log(`  hello: ${hello.device.name} (protocol ${hello.protocol}, version ${hello.device.version})`);

  const nonce = randomBytes(4).toString("hex");
  const pong = await client.request("ping", { nonce });
  console.log(`  ping: nonce ${pong.nonce === nonce ? "matched" : "MISMATCHED"}`);

  const { workspaces } = await client.request("workspaces.list", {});
  console.log(`  workspaces.list: ${workspaces.length} workspace(s)`);
  for (const workspace of workspaces) console.log(`    - ${workspace.name} (${workspace.id})`);
  if (workspaces.length === 0) throw new Error("no workspaces to open a terminal in");

  const { terminalId } = await client.request("terminal.create", {
    workspaceId: workspaces[0].id,
    cols: 80,
    rows: 24,
  });
  console.log(`  terminal.create: ${terminalId}`);

  await client.request("terminal.write", { terminalId, data: "echo hello-from-remote\n" });
  // Give the shell time to start, run the command, and stream it back.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !terminalOutput.join("").includes("hello-from-remote")) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const output = terminalOutput.join("");
  console.log("  terminal output:");
  for (const line of output.split(/\r?\n/).filter((l) => l.trim().length > 0)) {
    console.log(`    | ${line}`);
  }
  const echoed = output.includes("hello-from-remote");

  await client.request("terminal.close", { terminalId });
  console.log("  terminal.close: ok");
  stream.destroy();
  if (dht) await dht.destroy();

  if (!echoed) throw new Error("the terminal never echoed hello-from-remote");
  console.log("round trip complete");
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  const skipDht = process.argv.includes("--no-dht");
  switch (command) {
    case "pair":
      await pair(argument);
      return;
    case "connect":
    case undefined:
      await connect({ skipDht });
      return;
    default:
      throw new Error(`unknown command "${command}"; use "pair <qr>" or "connect"`);
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
