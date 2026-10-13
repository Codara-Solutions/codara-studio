// The extension's end of the Codara link: finds Codara on its loopback
// ports, introduces itself with the paired token (or asks to pair when the
// user pressed Connect), answers Codara's requests and keeps the socket busy
// enough that the MV3 service worker is not suspended while connected.
// Everything browser-specific is passed in, so the tests drive it in Node.

import { DEFAULT_PORTS, LINK_PATH, PROTOCOL } from "./policy.js";

const PROBE_TIMEOUT_MS = 1500;
const PING_INTERVAL_MS = 20_000;
// Two missed pongs: the socket is dead even though it never closed.
const PONG_DEADLINE_MS = 2 * PING_INTERVAL_MS + 5_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const REQUEST_TYPES = new Set(["attach", "detach", "cdp", "open", "close", "activate"]);

export class LinkClient {
  /**
   * @param {object} deps
   * @param {typeof WebSocket} deps.WebSocket
   * @param {() => Promise<number[]>} [deps.ports]
   * @param {() => Promise<object>} deps.hello  browser and extension identity
   * @param {() => Promise<string | null>} deps.loadToken
   * @param {(token: string, linkId: string) => Promise<void>} deps.saveToken
   * @param {() => Promise<void>} deps.clearToken
   * @param {(request: object) => Promise<unknown>} deps.onRequest
   * @param {(message: object) => void} [deps.onMessage]
   * @param {(status: object) => void} [deps.onStatus]
   * @param {() => void} [deps.onConnected]
   * @param {() => void} [deps.onDisconnected]
   */
  constructor(deps) {
    this.deps = deps;
    this.socket = null;
    this.connecting = null;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.attempt = 0;
    this.lastPong = 0;
    this.status = { state: "idle", code: null, port: null, linkId: null, app: null, error: null };
  }

  get connected() {
    return this.status.state === "connected" && this.socket !== null;
  }

  /** Connect if a token exists, or pair when `pair` is set (the user pressed Connect). */
  connect({ pair = false } = {}) {
    if (this.socket) {
      if (pair && this.status.state !== "connected" && this.status.state !== "pairing") this.close();
      else return Promise.resolve(this.status);
    }
    if (this.connecting) return this.connecting;
    this.connecting = this.run(pair).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** Stop and stay stopped until connect() is called again. */
  disconnect(state = "idle") {
    this.clearReconnect();
    this.close();
    this.setStatus({ state, code: null, port: null, error: null });
  }

  send(message) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  async run(pair) {
    this.clearReconnect();
    const token = await this.deps.loadToken();
    if (!token && !pair) {
      this.setStatus({ state: "idle", code: null, error: null });
      return this.status;
    }
    this.setStatus({ state: "searching", code: null, error: null });
    const ports = (await this.deps.ports?.()) ?? DEFAULT_PORTS;
    let unknown = false;
    for (const port of ports) {
      const outcome = await this.tryPort(port, token, pair);
      if (outcome === "unknown") unknown = true;
      else if (outcome !== "next") return this.status;
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
    this.scheduleReconnect();
    return this.status;
  }

  tryPort(port, token, pair) {
    return new Promise((resolve) => {
      let settled = false;
      let socket;
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
        finish("next");
      }, PROBE_TIMEOUT_MS);
      try {
        socket = new this.deps.WebSocket(`ws://127.0.0.1:${port}${LINK_PATH}`);
      } catch {
        finish("next");
        return;
      }
      socket.onopen = async () => {
        const hello = await this.deps.hello();
        socket.send(JSON.stringify({ type: "hello", protocol: PROTOCOL, ...hello, ...(token ? { token } : {}), pair: pair === true }));
      };
      socket.onerror = () => finish("next");
      socket.onclose = () => {
        if (!settled) finish("next");
        else if (this.socket === socket) this.lost();
      };
      socket.onmessage = (event) => {
        const message = parse(event.data);
        if (!message) return;
        if (!settled) {
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
          this.adopt(socket, port);
          finish(message.type === "welcome" || message.type === "pairing" ? "ok" : "stop");
        }
        void this.handle(message);
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
      case "paired":
        await this.deps.saveToken(message.token, message.linkId);
        this.attempt = 0;
        this.setStatus({ state: "connected", code: null, linkId: message.linkId ?? null, app: message.app ?? null, error: null });
        this.deps.onConnected?.();
        return;
      case "denied":
        this.disconnect("denied");
        this.setStatus({ error: message.message ?? "Codara declined the connection." });
        return;
      case "unpaired":
      case "revoked":
        await this.deps.clearToken();
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
      default:
        break;
    }
    if (message.id !== undefined && REQUEST_TYPES.has(message.type)) {
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
    this.scheduleReconnect();
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
    if (!(await this.deps.loadToken())) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)];
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
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

function parse(data) {
  try {
    const value = JSON.parse(typeof data === "string" ? data : String(data));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}
