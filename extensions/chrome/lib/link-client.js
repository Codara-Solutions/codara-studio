// The extension's end of the Codara link: finds Codara on its loopback
// ports, proves it holds the pairing secret (or pairs over ECDH when the user
// pressed Connect), answers Codara's requests and keeps the socket busy
// enough that the MV3 service worker is not suspended while connected.
// Every frame after the handshake is sealed (Sealer), so a program relaying
// the handshake from an earlier port can neither read nor drive the session.
// src/main/browser/chrome/protocol.ts describes the wire format.
// Everything browser-specific is passed in, so the tests drive it in Node.

import { DEFAULT_PORTS, LINK_PATH, PROTOCOL } from "./policy.js";

const PROBE_TIMEOUT_MS = 1500;
const PING_INTERVAL_MS = 20_000;
// Two missed pongs: the socket is dead even though it never closed.
const PONG_DEADLINE_MS = 2 * PING_INTERVAL_MS + 5_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
// While no Codara answers on any port. A lost link climbs the quick
// RECONNECT_DELAYS_MS first, since Codara restarting for an update is the
// usual reason; a worker that wakes up to find nothing starts here.
const OFFLINE_DELAYS_MS = [30_000, 60_000, 120_000, 300_000];
const REQUEST_TYPES = new Set(["attach", "detach", "cdp", "open", "close", "activate"]);

export class LinkClient {
  /**
   * @param {object} deps
   * @param {typeof WebSocket} deps.WebSocket
   * @param {() => Promise<number[]>} [deps.ports]
   * @param {() => Promise<object>} deps.hello  browser and extension identity
   * @param {() => Promise<{ token: string, linkId: string } | null>} deps.loadPairing
   * @param {(token: string, linkId: string) => Promise<void>} deps.savePairing
   * @param {() => Promise<void>} deps.clearPairing
   * @param {(request: object) => Promise<unknown>} deps.onRequest
   * @param {(message: object) => void} [deps.onMessage]
   * @param {(message: object) => void} [deps.onReload]  Codara ships a newer extension
   * @param {(status: object) => void} [deps.onStatus]
   * @param {() => void} [deps.onConnected]
   * @param {() => void} [deps.onDisconnected]
   * @param {(port: number) => Promise<boolean>} [deps.probe]  whether anything listens on the port, without a WebSocket
   * @param {() => Promise<object | null>} [deps.loadScan]  the scan memo that outlives a suspended worker
   * @param {(scan: object) => Promise<void>} [deps.saveScan]
   * @param {() => number} [deps.now]
   */
  constructor(deps) {
    this.deps = deps;
    this.socket = null;
    this.connecting = null;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.attempt = 0;
    this.lastPong = 0;
    // lastPort: where Codara last answered. misses and retryAt: the offline
    // backoff; recovering: the misses count from a lost link.
    this.scan = null;
    this.status = { state: "idle", code: null, port: null, linkId: null, app: null, error: null };
  }

  get connected() {
    return this.status.state === "connected" && this.socket !== null;
  }

  /**
   * Connect if a token exists, or pair when `pair` is set (the user pressed
   * Connect). `wake` is a user-facing moment (the popup opened, Chrome
   * started, a tab was shared): it skips the offline backoff.
   */
  connect({ pair = false, wake = false } = {}) {
    if (this.socket) {
      if (pair && this.status.state !== "connected" && this.status.state !== "pairing") this.close();
      else return Promise.resolve(this.status);
    }
    if (this.connecting) return this.connecting;
    this.connecting = this.run(pair, wake).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** Look for Codara now, whatever the backoff says. */
  async wake() {
    await this.updateScan({ misses: 0, retryAt: 0, recovering: false });
    return this.connect({ wake: true });
  }

  /** Stop and stay stopped until connect() is called again. */
  disconnect(state = "idle") {
    this.clearReconnect();
    this.close();
    this.setStatus({ state, code: null, port: null, error: null });
  }

  send(message) {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return false;
    if (!socket.sealer) {
      socket.send(JSON.stringify(message));
      return true;
    }
    // Sealing is asynchronous and each frame's counter is its place in the
    // stream, so frames leave one at a time in the order they were sent.
    socket.outbox = (socket.outbox ?? Promise.resolve()).then(async () => {
      const frame = await socket.sealer.seal(message);
      if (socket.readyState === 1) socket.send(frame);
    }).catch(() => {});
    return true;
  }

  async run(pair, wake) {
    this.clearReconnect();
    const pairing = await this.deps.loadPairing();
    if (!pairing && !pair) {
      this.setStatus({ state: "idle", code: null, error: null });
      return this.status;
    }
    const scan = await this.loadScan();
    const now = this.now();
    if (!pair && !wake && scan.retryAt > now) {
      // The alarm wakes the worker every 30 s; the backoff decides.
      this.scheduleAt(scan.retryAt - now);
      return this.status;
    }
    this.setStatus({ state: "searching", code: null, error: null });
    const configured = (await this.deps.ports?.()) ?? DEFAULT_PORTS;
    // The port that worked last time first: when Codara is there, no other
    // port is touched.
    const ports = configured.includes(scan.lastPort) ? [scan.lastPort, ...configured.filter((port) => port !== scan.lastPort)] : configured;
    // With a pairing, the Codara that can prove it is looked for on every
    // port before any of them may start a new pairing: pressing Connect
    // again must not hand the browser to whatever answers first.
    const rounds = pairing && pair ? [false, true] : [pair];
    // A WebSocket that cannot connect lands in the user's extension Errors
    // list; a failed no-cors fetch does not. So ports are probed first, and
    // only a port something listens on gets a WebSocket.
    const probed = new Map();
    const listening = async (port) => {
      if (!this.deps.probe) return true;
      if (!probed.has(port)) probed.set(port, await this.deps.probe(port).catch(() => false));
      return probed.get(port);
    };
    let result = await this.scanPorts(ports, rounds, pairing, listening);
    if (result.done) return this.status;
    if (!result.reached && this.deps.probe && pair) {
      // Nothing answered the probe. Should a browser ever refuse the probe
      // itself, pressing Connect still reaches Codara: it opens a WebSocket
      // on every port.
      result = await this.scanPorts(ports, rounds, pairing, async () => true);
      if (result.done) return this.status;
    }
    const { unknown, refusal } = result;
    if (refusal && !unknown) {
      this.setStatus({ state: "error", error: refusal.message ?? "Codara refused the connection." });
      this.scheduleReconnect();
      return this.status;
    }
    if (unknown) {
      // Only an explicit revoke forgets the token: the Codara that issued it
      // may be restarting while another one (a second install, a test run)
      // holds an earlier port.
      this.setStatus({ state: "unpaired", error: "The Codara running now does not know this browser. Press Connect to pair it." });
      this.scheduleReconnect();
      return this.status;
    }
    this.setStatus({ state: "offline", error: "Codara is not running, or its Chrome link is off." });
    await this.backOff();
    return this.status;
  }

  async scanPorts(ports, rounds, pairing, listening) {
    let unknown = false;
    let refusal = null;
    let reached = false;
    for (const asking of rounds) {
      for (const port of ports) {
        if (!(await listening(port))) continue;
        const outcome = await this.tryPort(port, pairing, asking);
        if (outcome === "closed") continue;
        reached = true;
        if (outcome === "unknown") unknown = true;
        else if (outcome && typeof outcome === "object") refusal ??= outcome;
        else if (outcome !== "next") {
          if (outcome === "ok") await this.updateScan({ lastPort: port, misses: 0, retryAt: 0, recovering: false });
          return { done: true, unknown, refusal, reached };
        }
      }
    }
    return { done: false, unknown, refusal, reached };
  }

  tryPort(port, pairing, pair) {
    return new Promise((resolve) => {
      let settled = false;
      let socket;
      let opened = false;
      let proven = false;
      let session = null;
      const nonce = pairing ? randomNonce() : null;
      const keys = pair ? pairKeys() : null;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        try {
          socket?.close();
        } catch {
          /* already closed */
        }
        finish(opened ? "next" : "closed");
      }, PROBE_TIMEOUT_MS);
      try {
        socket = new this.deps.WebSocket(`ws://127.0.0.1:${port}${LINK_PATH}`);
      } catch {
        finish("closed");
        return;
      }
      socket.onopen = async () => {
        opened = true;
        const hello = await this.deps.hello();
        const commit = keys ? { pairCommit: await pairCommitment((await keys).key) } : {};
        socket.send(JSON.stringify({ type: "hello", protocol: PROTOCOL, ...hello, ...(pairing ? { linkId: pairing.linkId, nonce } : {}), pair: pair === true, ...commit }));
      };
      socket.onerror = () => finish(opened ? "next" : "closed");
      socket.onclose = () => {
        if (!settled) finish(opened ? "next" : "closed");
        else if (this.socket === socket) this.lost();
      };
      const frame = async (data) => {
        let message = parse(data);
        if (!message) return;
        if (socket.sealer) {
          try {
            message = await socket.sealer.open(message);
          } catch {
            // Not the next frame Codara sealed: the path is not trusted.
            socket.close();
            if (this.socket === socket) this.lost();
            return;
          }
        }
        if (!settled && message.type === "challenge" && pairing && !proven) {
          // Answer only a Codara that proved it holds this pairing's secret:
          // whatever else sits on the port gets nothing it could replay.
          const secret = await sha256Hex(pairing.token);
          const expected = await linkProof(secret, "codara", nonce, String(message.nonce ?? ""));
          if (settled) return;
          if (message.proof !== expected) {
            socket.close();
            finish("unknown");
            return;
          }
          proven = true;
          session = { secret, first: nonce, second: String(message.nonce) };
          socket.send(JSON.stringify({ type: "auth", proof: await linkProof(secret, "browser", String(message.nonce), nonce) }));
          return;
        }
        if (!settled) {
          if (message.type === "welcome" && !proven) {
            socket.close();
            finish("next");
            return;
          }
          // A stored pairing is used only with a Codara that proved it: an
          // unproven "pairing" would take over the browser (and replace the
          // token) without the user asking, and an unproven refusal must not
          // keep the real Codara on a later port from being tried.
          if (pairing && !pair && !proven && message.type !== "unpaired") {
            socket.close();
            finish(message.type === "error" || message.type === "denied" ? { message: typeof message.message === "string" ? message.message : null } : "next");
            return;
          }
          // Only a Codara answers a hello with one of these; anything else on
          // the port is some other program, so try the next one.
          if (!["welcome", "pairing", "denied", "unpaired", "error"].includes(message.type)) {
            socket.close();
            finish("next");
            return;
          }
          if (message.type === "unpaired") {
            socket.close();
            finish("unknown");
            return;
          }
          if (message.type === "pairing") {
            const codaraKey = String(message.key ?? "");
            if (!keys || !PUBLIC_KEY.test(codaraKey)) {
              socket.close();
              finish("next");
              return;
            }
            // Revealed only now, after Codara sent its key: a relay had to
            // pick its keys before it could see this one.
            const own = await keys;
            socket.pairing = { privateKey: own.privateKey, extensionKey: own.key, codaraKey };
            socket.send(JSON.stringify({ type: "pair_key", key: own.key }));
            message = { type: "pairing", code: await pairingCode(own.key, codaraKey) };
          }
          if (message.type === "welcome") socket.sealer = await sessionSealer(session.secret, session.first, session.second);
          this.adopt(socket, port);
          finish(message.type === "welcome" || message.type === "pairing" ? "ok" : "stop");
        }
        // Requests are answered side by side; everything else in order.
        if (message.id !== undefined && REQUEST_TYPES.has(message.type)) void this.handle(message);
        else await this.handle(message);
      };
      // One frame at a time: opening a sealed frame is asynchronous, and a
      // frame opens only after the one before it.
      let frames = Promise.resolve();
      socket.onmessage = (event) => {
        frames = frames.then(() => frame(event.data)).catch(() => {});
      };
    });
  }

  adopt(socket, port) {
    this.socket = socket;
    this.status = { ...this.status, port };
    this.lastPong = Date.now();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPong > PONG_DEADLINE_MS) {
        this.close();
        this.lost();
        return;
      }
      this.send({ type: "ping" });
    }, PING_INTERVAL_MS);
  }

  async handle(message) {
    switch (message.type) {
      case "welcome":
        this.attempt = 0;
        this.setStatus({ state: "connected", code: null, linkId: message.linkId ?? null, app: message.app ?? null, error: null });
        this.deps.onConnected?.();
        return;
      case "pairing":
        this.setStatus({ state: "pairing", code: message.code ?? null, error: null });
        return;
      case "paired": {
        const socket = this.socket;
        const pairing = socket?.pairing;
        if (!pairing || typeof message.linkId !== "string") {
          this.lost();
          return;
        }
        // Both sides derive the token from the exchange; it is never sent.
        const shared = await sharedSecret(pairing.privateKey, pairing.codaraKey);
        const token = await pairedToken(shared, pairing.extensionKey, pairing.codaraKey);
        socket.pairing = null;
        socket.sealer = await sessionSealer(await sha256Hex(token), pairing.extensionKey, pairing.codaraKey);
        await this.deps.savePairing(token, message.linkId);
        this.attempt = 0;
        this.setStatus({ state: "connected", code: null, linkId: message.linkId ?? null, app: message.app ?? null, error: null });
        this.deps.onConnected?.();
        return;
      }
      case "denied":
        this.disconnect("denied");
        this.setStatus({ error: message.message ?? "Codara declined the connection." });
        return;
      case "unpaired":
      case "revoked":
        await this.deps.clearPairing();
        this.disconnect("unpaired");
        this.setStatus({ error: message.type === "revoked" ? "Codara disconnected this browser." : "Codara no longer knows this browser. Connect again." });
        this.deps.onMessage?.(message);
        return;
      case "error":
        this.disconnect("error");
        this.setStatus({ error: message.message ?? "Codara refused the connection." });
        return;
      case "pong":
        this.lastPong = Date.now();
        return;
      case "reload":
        // Only from the sealed session of a proven Codara: anything on the
        // path before that could otherwise restart the extension at will.
        if (this.status.state === "connected" && this.socket?.sealer) this.deps.onReload?.(message);
        return;
      default:
        break;
    }
    if (message.id !== undefined && REQUEST_TYPES.has(message.type)) {
      if (this.status.state !== "connected") {
        this.send({ id: message.id, error: { message: "This browser is not paired with you yet." } });
        return;
      }
      try {
        const result = await this.deps.onRequest(message);
        this.send({ id: message.id, result: result ?? {} });
      } catch (error) {
        this.send({ id: message.id, error: { message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }
    this.deps.onMessage?.(message);
  }

  lost() {
    if (!this.socket) return;
    this.close();
    this.setStatus({ state: "offline", code: null, error: "Lost the connection to Codara." });
    void this.updateScan({ misses: 0, retryAt: 0, recovering: true }).then(() => this.scheduleReconnect());
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (socket) {
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      this.deps.onDisconnected?.();
    }
  }

  async scheduleReconnect() {
    this.clearReconnect();
    if (!(await this.deps.loadPairing())) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)];
    this.attempt += 1;
    this.scheduleAt(delay);
  }

  /** No Codara on any port: wait longer each time, and remember it across worker restarts. */
  async backOff() {
    const scan = await this.loadScan();
    const ladder = scan.recovering ? [...RECONNECT_DELAYS_MS.slice(0, -1), ...OFFLINE_DELAYS_MS] : OFFLINE_DELAYS_MS;
    const delay = ladder[Math.min(scan.misses, ladder.length - 1)];
    await this.updateScan({ misses: scan.misses + 1, retryAt: this.now() + delay });
    this.clearReconnect();
    if (!(await this.deps.loadPairing())) return;
    this.scheduleAt(delay);
  }

  scheduleAt(delay) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  now() {
    return this.deps.now?.() ?? Date.now();
  }

  async loadScan() {
    if (!this.scan) {
      const stored = (await this.deps.loadScan?.().catch(() => null)) ?? {};
      this.scan = {
        lastPort: Number.isInteger(stored.lastPort) ? stored.lastPort : null,
        misses: Number.isInteger(stored.misses) && stored.misses > 0 ? stored.misses : 0,
        retryAt: Number.isFinite(stored.retryAt) ? stored.retryAt : 0,
        recovering: stored.recovering === true,
      };
    }
    return this.scan;
  }

  async updateScan(patch) {
    this.scan = { ...(await this.loadScan()), ...patch };
    await this.deps.saveScan?.(this.scan).catch(() => {});
  }

  clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.deps.onStatus?.(this.status);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PUBLIC_KEY = /^04[0-9a-f]{128}$/;

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(text) {
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmac(keyText, message) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(keyText), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, encoder.encode(message));
}

/** A fresh P-256 key pair for one pairing; the public key as uncompressed hex. */
export async function pairKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { privateKey: pair.privateKey, key: hex(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

export function pairCommitment(extensionKey) {
  return sha256Hex(`codara-pair-commit|${extensionKey}`);
}

/** The code both screens show, from both keys (protocol.ts pairingCode). */
export async function pairingCode(extensionKey, codaraKey) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`codara-pair-code|${extensionKey}|${codaraKey}`));
  const digits = String(new DataView(digest).getUint32(0) % 1_000_000).padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export async function sharedSecret(privateKey, codaraKey) {
  const theirs = await crypto.subtle.importKey("raw", fromHex(codaraKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  return hex(await crypto.subtle.deriveBits({ name: "ECDH", public: theirs }, privateKey, 256));
}

export async function pairedToken(sharedHex, extensionKey, codaraKey) {
  return hex(await hmac(sharedHex, `codara-pair-token|${extensionKey}|${codaraKey}`));
}

/** The sealer for one session, keyed as protocol.ts linkSessionKey. */
export async function sessionSealer(secretHex, first, second, role = "browser") {
  const raw = await hmac(secretHex, `codara-session|${first}|${second}`);
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return new Sealer(key, role);
}

/** AES-256-GCM per frame, the IV being the sender's direction and frame count (protocol.ts LinkSealer). */
export class Sealer {
  constructor(key, role) {
    this.key = key;
    this.role = role;
    this.sent = 0n;
    this.received = 0n;
  }

  iv(role, count) {
    const iv = new Uint8Array(12);
    const view = new DataView(iv.buffer);
    view.setUint32(0, role === "codara" ? 0 : 1);
    view.setBigUint64(4, count);
    return iv;
  }

  async seal(message) {
    const iv = this.iv(this.role, this.sent);
    this.sent += 1n;
    return JSON.stringify({ sealed: base64(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, encoder.encode(JSON.stringify(message)))) });
  }

  async open(frame) {
    if (!frame || typeof frame.sealed !== "string") throw new Error("an unsealed frame");
    const iv = this.iv(this.role === "codara" ? "browser" : "codara", this.received);
    const text = decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, this.key, fromBase64(frame.sealed)));
    this.received += 1n;
    const message = JSON.parse(text);
    if (!message || typeof message !== "object") throw new Error("a frame that is not an object");
    return message;
  }
}

function randomNonce() {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function sha256Hex(text) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/** The HMAC that Codara's protocol.ts linkProof computes, keyed by the hex SHA-256 of the token. */
export async function linkProof(secretHex, role, first, second) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secretHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${role}|${first}|${second}`)));
}

function parse(data) {
  try {
    const value = JSON.parse(typeof data === "string" ? data : String(data));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}
