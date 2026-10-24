// The loopback WebSocket the browser extension connects to. It listens on
// 127.0.0.1 only, on the first free port of CHROME_LINK_PORTS (the extension
// probes them in order), and accepts an upgrade only from a browser
// extension's origin with a loopback Host, so neither a web page nor a DNS
// rebinding can open it. A new browser pairs only after the user allowed it
// in Codara with the code both sides show; the token it then keeps is bound
// to that extension id. protocol.ts describes the handshake.

import { createECDH, randomBytes } from "node:crypto";
import { createServer, STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import { ChromeLink } from "./link";
import { hashToken, type ChromeLinkStore } from "./link-store";
import {
  CHROME_LINK_PATH,
  CHROME_LINK_PORTS,
  CHROME_LINK_PROTOCOL,
  EXTENSION_ORIGIN,
  LINK_COMMIT,
  LINK_NONCE,
  LINK_PUBLIC_KEY,
  LOOPBACK_HOST,
  LinkSealer,
  linkIdFor,
  linkProof,
  linkSessionKey,
  pairCommitment,
  pairedToken,
  pairingCode,
  proofMatches,
  sanitizeBrowserInfo,
  sanitizeExtensionFeatures,
  type ChromeBrowserInfo,
} from "./protocol";

export interface PendingPairing {
  id: string;
  code: string;
  browser: ChromeBrowserInfo;
  extensionId: string;
  requestedAt: string;
  expiresAt: string;
}

export interface ChromeLinkServerOptions {
  store: ChromeLinkStore;
  app: { name: string; version: string };
  ports?: readonly number[];
  pairingTimeoutMs?: number;
  helloTimeoutMs?: number;
  heartbeatMs?: number;
}

interface PairingEntry {
  pending: PendingPairing;
  socket: WebSocket;
  timer: ReturnType<typeof setTimeout>;
  version: string;
  features: string[];
  /** Derived on both sides from the ECDH exchange; never sent. */
  token: string;
  sessionKey: Buffer;
  adopt(link: ChromeLink): void;
}

const MAX_PENDING_PAIRINGS = 3;

export class ChromeLinkServer {
  port: number | null = null;
  error: string | null = null;
  private http: Server | null = null;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 * 1024 });
  private readonly live = new Map<string, ChromeLink>();
  private readonly pairings = new Map<string, PairingEntry>();
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly changeListeners = new Set<() => void>();
  private readonly upListeners = new Set<(link: ChromeLink) => void>();
  private readonly downListeners = new Set<(link: ChromeLink) => void>();
  private readonly pairingListeners = new Set<(pairing: PendingPairing) => void>();

  constructor(private readonly options: ChromeLinkServerOptions) {}

  /** Listen on the first free port; null (with `error` set) when none is. */
  async start(): Promise<number | null> {
    const ports = this.options.ports ?? CHROME_LINK_PORTS;
    for (const port of ports) {
      const server = createServer((_req, res) => {
        res.writeHead(404).end();
      });
      server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head));
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE" && code !== "EACCES") this.error = (error as Error).message;
        continue;
      }
      this.http = server;
      this.port = (server.address() as { port: number }).port;
      this.error = null;
      this.startHeartbeat();
      this.emitChange();
      return this.port;
    }
    this.error = `Ports ${ports.join(", ")} are all in use, so browsers cannot connect.`;
    this.emitChange();
    return null;
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const entry of this.pairings.values()) clearTimeout(entry.timer);
    this.pairings.clear();
    for (const link of [...this.live.values()]) this.drop(link);
    for (const client of this.wss.clients) client.terminate();
    const server = this.http;
    this.http = null;
    this.port = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  links(): ChromeLink[] {
    return [...this.live.values()];
  }

  link(linkId: string): ChromeLink | null {
    return this.live.get(linkId) ?? null;
  }

  pendingPairings(): PendingPairing[] {
    return [...this.pairings.values()].map((entry) => ({ ...entry.pending }));
  }

  approve(id: string): boolean {
    const entry = this.pairings.get(id);
    if (!entry) return false;
    this.pairings.delete(id);
    clearTimeout(entry.timer);
    const taken = new Set(this.options.store.list().map((link) => link.linkId));
    const linkId = linkIdFor(entry.pending.browser.name, taken);
    const now = new Date().toISOString();
    this.options.store.add({
      linkId,
      tokenSha256: hashToken(entry.token),
      extensionId: entry.pending.extensionId,
      browser: entry.pending.browser,
      pairedAt: now,
      lastSeenAt: now,
    });
    entry.socket.send(JSON.stringify({ type: "paired", linkId, app: this.options.app }));
    entry.adopt(this.open(entry.socket, linkId, entry.pending.browser, entry.pending.extensionId, entry.version, new LinkSealer(entry.sessionKey, "codara"), entry.features));
    this.emitChange();
    return true;
  }

  deny(id: string, message = "Codara declined the connection."): boolean {
    const entry = this.pairings.get(id);
    if (!entry) return false;
    this.pairings.delete(id);
    clearTimeout(entry.timer);
    this.refuse(entry.socket, { type: "denied", message });
    this.emitChange();
    return true;
  }

  /** Forget a paired browser: its token stops working and a connected one is told and closed. */
  unpair(linkId: string): boolean {
    const removed = this.options.store.remove(linkId);
    const link = this.live.get(linkId);
    if (link) {
      link.send({ type: "revoked" });
      this.drop(link, 4003, "revoked");
    }
    if (removed || link) this.emitChange();
    return removed || Boolean(link);
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onLinkUp(listener: (link: ChromeLink) => void): () => void {
    this.upListeners.add(listener);
    return () => this.upListeners.delete(listener);
  }

  onLinkDown(listener: (link: ChromeLink) => void): () => void {
    this.downListeners.add(listener);
    return () => this.downListeners.delete(listener);
  }

  onPairingRequest(listener: (pairing: PendingPairing) => void): () => void {
    this.pairingListeners.add(listener);
    return () => this.pairingListeners.delete(listener);
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number) => {
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    let path = "";
    try {
      path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      refuse(400);
      return;
    }
    if (path !== CHROME_LINK_PATH) return refuse(404);
    if (!LOOPBACK_HOST.test(String(req.headers.host ?? ""))) return refuse(403);
    const origin = EXTENSION_ORIGIN.exec(String(req.headers.origin ?? ""));
    if (!origin) return refuse(403);
    const extensionId = origin[1];
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, extensionId));
  }

  private accept(ws: WebSocket, extensionId: string): void {
    let link: ChromeLink | null = null;
    let greeted = false;
    let onAuth: ((answer: Record<string, unknown>) => void) | null = null;
    this.alive.set(ws, true);
    ws.on("pong", () => this.alive.set(ws, true));
    const helloTimeoutMs = this.options.helloTimeoutMs ?? 10_000;
    let helloTimer = setTimeout(() => ws.close(4000, "no hello"), helloTimeoutMs);
    helloTimer.unref?.();
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let message: Record<string, unknown>;
      try {
        const parsed = JSON.parse(String(data));
        if (!parsed || typeof parsed !== "object") return;
        message = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      this.alive.set(ws, true);
      if (link) {
        let opened: Record<string, unknown>;
        try {
          opened = link.open(message);
        } catch {
          // Not the next frame the extension sealed: something on the path
          // added, dropped or changed one, so this socket is not trusted.
          this.drop(link, 4005, "unsealed frame");
          return;
        }
        if (opened.type === "unpair") this.unpair(link.linkId);
        else link.handle(opened);
        return;
      }
      if (message.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (onAuth) {
        const handler = onAuth;
        onAuth = null;
        clearTimeout(helloTimer);
        handler(message);
        return;
      }
      if (greeted) return;
      if (message.type !== "hello") {
        ws.close(4001, "expected hello");
        return;
      }
      greeted = true;
      clearTimeout(helloTimer);
      this.hello(
        ws,
        extensionId,
        message,
        (adopted) => {
          link = adopted;
        },
        (handler) => {
          onAuth = handler;
          helloTimer = setTimeout(() => ws.close(4000, "no auth"), helloTimeoutMs);
          helloTimer.unref?.();
        },
      );
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      for (const [id, entry] of this.pairings) {
        if (entry.socket !== ws) continue;
        clearTimeout(entry.timer);
        this.pairings.delete(id);
        this.emitChange();
      }
      if (link) this.drop(link);
    });
    ws.on("error", () => {});
  }

  private hello(
    ws: WebSocket,
    extensionId: string,
    message: Record<string, unknown>,
    adopt: (link: ChromeLink) => void,
    expectAuth: (handler: (answer: Record<string, unknown>) => void) => void,
  ): void {
    if (message.protocol !== CHROME_LINK_PROTOCOL) {
      this.refuse(ws, {
        type: "error",
        message: `This Codara speaks link protocol ${CHROME_LINK_PROTOCOL}; update ${Number(message.protocol) > CHROME_LINK_PROTOCOL ? "Codara" : "the Codara extension (Reload it in your browser's extensions page)"}.`,
      });
      return;
    }
    const browser = sanitizeBrowserInfo(message.browser);
    const extension = message.extension && typeof message.extension === "object" ? (message.extension as Record<string, unknown>) : {};
    const version = typeof extension.version === "string" ? extension.version.slice(0, 24) : "";
    const features = sanitizeExtensionFeatures(extension.features);
    const linkId = typeof message.linkId === "string" ? message.linkId : "";
    const clientNonce = typeof message.nonce === "string" && LINK_NONCE.test(message.nonce) ? message.nonce : "";
    const paired = linkId && clientNonce ? this.options.store.find(linkId, extensionId) : null;
    if (paired) {
      const serverNonce = randomBytes(16).toString("hex");
      expectAuth((answer) => {
        if (answer.type !== "auth" || !proofMatches(linkProof(paired.tokenSha256, "browser", serverNonce, clientNonce), answer.proof)) {
          this.refuse(ws, { type: "unpaired" });
          return;
        }
        this.options.store.add({ ...paired, browser, lastSeenAt: new Date().toISOString() });
        ws.send(JSON.stringify({ type: "welcome", protocol: CHROME_LINK_PROTOCOL, linkId: paired.linkId, app: this.options.app }));
        const sealer = new LinkSealer(linkSessionKey(paired.tokenSha256, clientNonce, serverNonce), "codara");
        adopt(this.open(ws, paired.linkId, browser, extensionId, version, sealer, features));
      });
      ws.send(JSON.stringify({ type: "challenge", nonce: serverNonce, proof: linkProof(paired.tokenSha256, "codara", clientNonce, serverNonce) }));
      return;
    }
    if (message.pair !== true) {
      this.refuse(ws, { type: "unpaired" });
      return;
    }
    const busy = () => this.pairings.size >= MAX_PENDING_PAIRINGS;
    if (busy()) {
      this.refuse(ws, { type: "denied", message: "Codara already has pairing requests waiting. Answer them first." });
      return;
    }
    const commit = typeof message.pairCommit === "string" && LINK_COMMIT.test(message.pairCommit) ? message.pairCommit : "";
    if (!commit) {
      this.refuse(ws, { type: "denied", message: "The pairing request was incomplete. Update the Codara extension." });
      return;
    }
    const ecdh = createECDH("prime256v1");
    const codaraKey = ecdh.generateKeys("hex");
    expectAuth((answer) => {
      const extensionKey = typeof answer.key === "string" ? answer.key : "";
      let shared = "";
      if (answer.type === "pair_key" && LINK_PUBLIC_KEY.test(extensionKey) && pairCommitment(extensionKey) === commit) {
        try {
          shared = ecdh.computeSecret(extensionKey, "hex", "hex");
        } catch {
          shared = "";
        }
      }
      if (!shared) {
        this.refuse(ws, { type: "denied", message: "The pairing request did not match what the browser announced." });
        return;
      }
      if (busy()) {
        this.refuse(ws, { type: "denied", message: "Codara already has pairing requests waiting. Answer them first." });
        return;
      }
      const token = pairedToken(shared, extensionKey, codaraKey);
      this.awaitApproval(ws, {
        browser,
        extensionId,
        version,
        features,
        adopt,
        code: pairingCode(extensionKey, codaraKey),
        token,
        sessionKey: linkSessionKey(hashToken(token), extensionKey, codaraKey),
      });
    });
    ws.send(JSON.stringify({ type: "pairing", key: codaraKey }));
  }

  private awaitApproval(
    ws: WebSocket,
    request: Pick<PairingEntry, "version" | "features" | "token" | "sessionKey" | "adopt"> & { browser: ChromeBrowserInfo; extensionId: string; code: string },
  ): void {
    const { browser, extensionId, version, features, adopt, code, token, sessionKey } = request;
    const timeoutMs = this.options.pairingTimeoutMs ?? 120_000;
    const now = Date.now();
    const pending: PendingPairing = {
      id: randomBytes(8).toString("hex"),
      code,
      browser,
      extensionId,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + timeoutMs).toISOString(),
    };
    const timer = setTimeout(() => this.deny(pending.id, "Nobody allowed the connection in Codara in time."), timeoutMs);
    timer.unref?.();
    this.pairings.set(pending.id, { pending, socket: ws, timer, version, features, token, sessionKey, adopt });
    for (const listener of this.pairingListeners) listener({ ...pending });
    this.emitChange();
  }

  private open(
    ws: WebSocket,
    linkId: string,
    browser: ChromeBrowserInfo,
    extensionId: string,
    version: string,
    sealer: LinkSealer,
    features: string[],
  ): ChromeLink {
    const previous = this.live.get(linkId);
    // The same browser reconnected (its service worker restarted): the new
    // socket replaces the old one.
    if (previous) this.drop(previous, 4002, "replaced");
    const link = new ChromeLink(linkId, browser, extensionId, version, ws, sealer, features);
    this.live.set(linkId, link);
    link.onTabs(() => this.emitChange());
    for (const listener of this.upListeners) listener(link);
    this.emitChange();
    return link;
  }

  private drop(link: ChromeLink, code = 1000, reason = ""): void {
    const current = this.live.get(link.linkId) === link;
    if (current) this.live.delete(link.linkId);
    link.close(code, reason);
    if (!current) return;
    this.options.store.touch(link.linkId);
    for (const listener of this.downListeners) listener(link);
    this.emitChange();
  }

  private refuse(ws: WebSocket, message: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      /* closing anyway */
    }
    ws.close(4004, String(message.type));
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    // A browser that went away without closing (a sleeping laptop, a killed
    // process) stops answering pings; its link is dropped.
    this.heartbeat = setInterval(() => {
      for (const client of this.wss.clients) {
        if (this.alive.get(client) === false) {
          client.terminate();
          continue;
        }
        this.alive.set(client, false);
        try {
          client.ping();
        } catch {
          /* closing */
        }
      }
    }, this.options.heartbeatMs ?? 30_000);
    this.heartbeat.unref?.();
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) listener();
  }
}
