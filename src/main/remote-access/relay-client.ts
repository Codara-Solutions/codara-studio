// Outbound Codara relay transport. Studio keeps one authenticated WSS control
// connection open and receives virtual byte streams only for phone identities
// that are already present in its local paired-device store. Each virtual
// stream is wrapped in the same end-to-end Noise IK responder used by the LAN
// listener, so the relay routes ciphertext and never becomes a trust anchor.

import { randomBytes } from "node:crypto";
import { Duplex } from "node:stream";
import NoiseSecretStream from "@hyperswarm/secret-stream";
import sodium from "sodium-native";
import WebSocket from "ws";

export const DEFAULT_REMOTE_RELAY_URL = "wss://relay.codarasolutions.com/v1/relay";

const AUTH_NONCE_BYTES = 24;
const AUTH_SIGNATURE_BYTES = 64;
const STREAM_ID_BYTES = 16;
const CONTROL_MAX_BYTES = 4_096;
const RELAY_HANDSHAKE_TIMEOUT_MS = 5_000;
const RELAY_INITIAL_RESULT_TIMEOUT_MS = 6_000;
const MAX_RELAY_HANDSHAKES = 4;
const MAX_TUNNEL_READ_BUFFER = 4 * 1024 * 1024;
const MAX_WS_BUFFERED_BYTES = 4 * 1024 * 1024;
const RECONNECT_MAX_MS = 30_000;

export interface EncryptedPeerStream {
  remotePublicKey: Buffer;
  write(data: Buffer): boolean;
  end(): void;
  destroy(): void;
  on(event: "data", handler: (chunk: Buffer) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (err: Error) => void): void;
  on(event: "drain", handler: () => void): void;
}

export interface RemoteRelayClientOptions {
  url: string;
  keyPair: { publicKey: Buffer; secretKey: Buffer };
  isAuthorized(publicKey: Buffer): boolean;
  onAuthorizedStream(stream: EncryptedPeerStream): void;
  onReadyChanged(ready: boolean): void;
  log(line: string): void;
}

interface RelayControl {
  type: string;
  streamId?: string;
  peer?: string;
}

export class RemoteRelayClient {
  private socket: WebSocket | null = null;
  private stopped = true;
  private ready = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 1_000;
  private initialResult: ((ready: boolean) => void) | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private readonly tunnels = new Map<string, RelayTunnel>();
  private readonly handshakeTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: RemoteRelayClientOptions) {}

  async start(): Promise<boolean> {
    if (!this.stopped) return this.ready;
    this.stopped = false;
    const initial = new Promise<boolean>((resolve) => {
      this.initialResult = resolve;
      this.initialTimer = setTimeout(
        () => this.resolveInitial(false),
        RELAY_INITIAL_RESULT_TIMEOUT_MS,
      );
      this.initialTimer.unref?.();
    });
    this.connect();
    return initial;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.resolveInitial(false);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.setReady(false);
    this.closeAllTunnels();
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 1_000);
      timer.unref?.();
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        socket.close(1000, "remote access disabled");
      } catch {
        socket.terminate();
      }
    });
  }

  isActive(): boolean {
    return this.socket !== null || this.reconnectTimer !== null;
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url, {
        perMessageDeflate: false,
        followRedirects: false,
        handshakeTimeout: 10_000,
        maxPayload: 1_100_000 + STREAM_ID_BYTES,
        rejectUnauthorized: true,
      });
    } catch (err) {
      this.options.log(`relay connection could not start: ${safeError(err)}`);
      this.resolveInitial(false);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    let authenticated = false;

    socket.on("open", () => {
      if (this.stopped || socket !== this.socket) {
        socket.close();
        return;
      }
      try {
        socket.send(this.buildAuthentication(), { binary: false });
      } catch (err) {
        this.options.log(`relay authentication could not be sent: ${safeError(err)}`);
        socket.terminate();
      }
    });
    socket.on("message", (data, isBinary) => {
      if (socket !== this.socket || this.stopped) return;
      const buffer = toBuffer(data);
      if (!authenticated) {
        if (isBinary) {
          socket.close(1002, "expected relay control");
          return;
        }
        const control = parseControl(buffer);
        if (control?.type !== "ready") {
          socket.close(1002, "invalid relay ready");
          return;
        }
        authenticated = true;
        this.reconnectDelayMs = 1_000;
        this.setReady(true);
        this.resolveInitial(true);
        return;
      }
      if (isBinary) this.onTunnelData(buffer);
      else this.onControl(buffer);
    });
    socket.on("error", (err) => {
      if (!this.stopped) this.options.log(`relay connection error: ${safeError(err)}`);
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.setReady(false);
      this.closeAllTunnels();
      if (!authenticated) this.resolveInitial(false);
      this.scheduleReconnect();
    });
  }

  private buildAuthentication(): string {
    const self = this.options.keyPair.publicKey.toString("base64");
    const timestamp = Date.now();
    const nonceBytes = randomBytes(AUTH_NONCE_BYTES);
    const nonce = nonceBytes.toString("base64");
    const message = Buffer.from(
      ["codara-relay-auth-v1", "studio", self, "", String(timestamp), nonce].join("\n"),
      "utf8",
    );
    const signature = Buffer.alloc(AUTH_SIGNATURE_BYTES);
    sodium.crypto_sign_detached(signature, message, this.options.keyPair.secretKey);
    return JSON.stringify({
      type: "auth",
      v: 1,
      role: "studio",
      self,
      timestamp,
      nonce,
      signature: signature.toString("base64"),
    });
  }

  private onControl(data: Buffer): void {
    const control = parseControl(data);
    if (!control) {
      this.socket?.close(1002, "invalid relay control");
      return;
    }
    if (control.type === "incoming") {
      this.onIncoming(control);
      return;
    }
    if (control.type === "closed" && validStreamId(control.streamId)) {
      this.tunnels.get(control.streamId)?.remoteClose();
      return;
    }
    this.socket?.close(1002, "unknown relay control");
  }

  private onIncoming(control: RelayControl): void {
    if (!validStreamId(control.streamId) || typeof control.peer !== "string") {
      this.socket?.close(1002, "invalid relay incoming");
      return;
    }
    const peer = canonicalPublicKey(control.peer);
    if (
      !peer ||
      !this.options.isAuthorized(peer) ||
      this.tunnels.size >= MAX_RELAY_HANDSHAKES ||
      this.tunnels.has(control.streamId)
    ) {
      this.sendControl({ type: "reject", v: 1, streamId: control.streamId });
      return;
    }

    const tunnel = new RelayTunnel(control.streamId, this);
    this.tunnels.set(control.streamId, tunnel);
    const deadline = setTimeout(() => {
      this.handshakeTimers.delete(control.streamId!);
      tunnel.destroy(new Error("relay Noise handshake timed out"));
    }, RELAY_HANDSHAKE_TIMEOUT_MS);
    deadline.unref?.();
    this.handshakeTimers.set(control.streamId, deadline);

    const stream = new NoiseSecretStream(false, tunnel, {
      keyPair: this.options.keyPair,
      pattern: "IK",
    }) as unknown as EncryptedPeerStream & {
      on(event: "open", handler: () => void): void;
    };
    stream.on("error", () => {
      // Failed authentication is deliberately silent.
    });
    stream.on("open", () => {
      const timer = this.handshakeTimers.get(control.streamId!);
      if (timer) clearTimeout(timer);
      this.handshakeTimers.delete(control.streamId!);
      if (
        !stream.remotePublicKey.equals(peer) ||
        !this.options.isAuthorized(stream.remotePublicKey)
      ) {
        stream.destroy();
        return;
      }
      this.options.onAuthorizedStream(stream);
    });
    this.sendControl({ type: "accept", v: 1, streamId: control.streamId });
  }

  private onTunnelData(data: Buffer): void {
    if (data.byteLength <= STREAM_ID_BYTES) {
      this.socket?.close(1002, "invalid relay data");
      return;
    }
    const id = data.subarray(0, STREAM_ID_BYTES).toString("hex");
    const tunnel = this.tunnels.get(id);
    if (!tunnel) {
      this.sendControl({ type: "close", v: 1, streamId: id });
      return;
    }
    tunnel.receive(data.subarray(STREAM_ID_BYTES));
  }

  sendTunnelData(id: string, data: Buffer, callback: (err?: Error | null) => void): void {
    const socket = this.socket;
    if (!this.ready || !socket || socket.readyState !== WebSocket.OPEN) {
      callback(new Error("relay is disconnected"));
      return;
    }
    const idBytes = Buffer.from(id, "hex");
    if (
      idBytes.byteLength !== STREAM_ID_BYTES ||
      socket.bufferedAmount + idBytes.byteLength + data.byteLength > MAX_WS_BUFFERED_BYTES
    ) {
      callback(new Error("relay output buffer limit reached"));
      return;
    }
    socket.send(Buffer.concat([idBytes, data]), { binary: true }, callback);
  }

  tunnelClosed(id: string, notifyRelay = true): void {
    const timer = this.handshakeTimers.get(id);
    if (timer) clearTimeout(timer);
    this.handshakeTimers.delete(id);
    if (!this.tunnels.delete(id)) return;
    if (this.ready && notifyRelay) this.sendControl({ type: "close", v: 1, streamId: id });
  }

  private sendControl(value: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify(value);
    if (socket.bufferedAmount + Buffer.byteLength(data) > MAX_WS_BUFFERED_BYTES) {
      socket.close(1013, "relay output buffer limit reached");
      return;
    }
    socket.send(data, { binary: false }, (err) => {
      if (err) socket.terminate();
    });
  }

  private closeAllTunnels(): void {
    for (const timer of this.handshakeTimers.values()) clearTimeout(timer);
    this.handshakeTimers.clear();
    const tunnels = [...this.tunnels.values()];
    this.tunnels.clear();
    for (const tunnel of tunnels) tunnel.remoteClose();
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    this.options.onReadyChanged(ready);
  }

  private resolveInitial(ready: boolean): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    this.initialTimer = null;
    const resolve = this.initialResult;
    this.initialResult = null;
    resolve?.(ready);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const jitter = Math.floor(Math.random() * Math.max(1, this.reconnectDelayMs / 4));
    const delay = this.reconnectDelayMs + jitter;
    this.reconnectDelayMs = Math.min(RECONNECT_MAX_MS, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}

class RelayTunnel extends Duplex {
  private remotelyClosed = false;

  constructor(
    readonly id: string,
    private readonly owner: RemoteRelayClient,
  ) {
    super();
  }

  override _read(): void {
    // Incoming relay frames call receive().
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.owner.sendTunnelData(this.id, data, callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.remotelyClosed) this.owner.tunnelClosed(this.id);
    callback(error);
  }

  receive(data: Buffer): void {
    if (this.destroyed) return;
    if (this.readableLength + data.byteLength > MAX_TUNNEL_READ_BUFFER) {
      this.destroy(new Error("relay input buffer limit reached"));
      return;
    }
    this.push(data);
  }

  remoteClose(): void {
    if (this.destroyed) return;
    this.remotelyClosed = true;
    this.owner.tunnelClosed(this.id, false);
    this.push(null);
    this.destroy();
  }
}

function parseControl(data: Buffer): RelayControl | null {
  if (data.byteLength === 0 || data.byteLength > CONTROL_MAX_BYTES) return null;
  try {
    const value = JSON.parse(data.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.type !== "string") return null;
    return {
      type: record.type,
      ...(typeof record.streamId === "string" ? { streamId: record.streamId } : {}),
      ...(typeof record.peer === "string" ? { peer: record.peer } : {}),
    };
  } catch {
    return null;
  }
}

function canonicalPublicKey(value: string): Buffer | null {
  if (value.length > 64) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== 32 || bytes.toString("base64") !== value) return null;
  return bytes;
}

function validStreamId(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function safeError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 160);
}
