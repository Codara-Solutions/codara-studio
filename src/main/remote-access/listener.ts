// The always-on Remote Access listener, active only while the "Remote
// access" setting is enabled.
//
// Transport choice (per docs/remote-access.md, "Transport security"):
// we use the Hyperswarm stack, and it proved workable inside Electron's
// main process with no rebuild step: sodium-native and udx-native ship
// N-API prebuilds that load unchanged under Electron 43 (verified against
// this repo's Electron before this module was written). Two rungs share one
// identity keypair and one connection-routing path:
//
//   1. Direct TCP (LAN, and WAN when the router cooperates): a plain
//      net.Server wrapped per-connection in @hyperswarm/secret-stream's
//      NoiseSecretStream with the IK pattern, the exact Noise construction
//      hyperdht itself uses. IK means the initiating phone must already
//      know our public key (it pinned it at pairing), and we learn the
//      phone's static key from the handshake. The QR payload's addrs/port
//      point here, and the phone keeps dialing this port for the LAN rung
//      after pairing, so the port stays stable for the listener's lifetime.
//   2. DHT (hole punch, works from any network): a hyperdht server listening
//      under the same keypair. Paired devices resolve us by public key with
//      no infrastructure of ours; hyperdht performs the hole punching.
//
// The silent-listener rule is enforced structurally in both rungs. On the
// DHT rung, hyperdht's firewall hook rejects unknown keys before the
// connection completes. On the TCP rung, Noise IK's responder never speaks
// first, so a port scanner reads zero bytes; after the handshake, streams
// from unknown keys are either handed to the pairing exchange (only while a
// pairing window is open) or destroyed without a single byte written.
//
// UPnP/NAT-PMP port mapping (the "direct WAN" rung between LAN and DHT) is
// deliberately not in phase 1: the DHT rung already covers off-LAN
// reachability, and a port mapping only widens the exposed surface. The
// ladder position is documented in docs/remote-access.md.

import { createServer, type Server, type Socket } from "node:net";
import NoiseSecretStream from "@hyperswarm/secret-stream";
import HyperDHT from "hyperdht";

// The duplex both rungs hand to the router: a NoiseSecretStream from the
// TCP rung or a hyperdht connection (which is also a NoiseSecretStream).
export interface EncryptedPeerStream {
  remotePublicKey: Buffer;
  write(data: Buffer): void;
  end(): void;
  destroy(): void;
  on(event: "data", handler: (chunk: Buffer) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (err: Error) => void): void;
}

export interface RemoteListenerOptions {
  keyPair: { publicKey: Buffer; secretKey: Buffer };
  // The firewall decision, consulted on every completed handshake and, on
  // the DHT rung, before the handshake is even acknowledged.
  isAuthorized(publicKey: Buffer): boolean;
  // Streams from paired devices land here.
  onAuthorizedStream(stream: EncryptedPeerStream): void;
  // Streams from unknown keys land here ONLY while a pairing window is
  // open (listener.setPairingOpen(true)); the pairing exchange decides
  // their fate. Closed-window strangers never reach any callback.
  onPairingCandidateStream(stream: EncryptedPeerStream): void;
  log(line: string): void;
  // TCP bind host. Default 0.0.0.0; the e2e harness narrows it to loopback.
  host?: string;
  // Preferred TCP port; 0 lets the OS pick. The chosen port is reported by
  // start() and baked into pairing QR payloads.
  port?: number;
  // hyperdht bootstrap override for tests (hyperdht/testnet). `false`
  // disables the DHT rung entirely (e2e harness on localhost).
  dhtBootstrap?: Array<{ host: string; port: number }> | false;
}

export interface RemoteListenerStartResult {
  port: number;
  dhtReady: boolean;
}

export class RemoteListener {
  private tcpServer: Server | null = null;
  private dht: HyperDHT | null = null;
  private dhtServer: ReturnType<HyperDHT["createServer"]> | null = null;
  private pairingOpen = false;
  private stopped = false;

  constructor(private readonly options: RemoteListenerOptions) {}

  // While true, post-handshake strangers on the TCP rung are routed to the
  // pairing exchange instead of being dropped. The DHT rung never accepts
  // strangers regardless: pairing is a same-LAN ceremony by design.
  setPairingOpen(open: boolean): void {
    this.pairingOpen = open;
  }

  async start(): Promise<RemoteListenerStartResult> {
    if (this.tcpServer) throw new Error("listener already started");
    this.stopped = false;
    const port = await this.startTcp();
    const dhtReady = await this.startDht();
    return { port, dhtReady };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const tcp = this.tcpServer;
    this.tcpServer = null;
    if (tcp) {
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
    }
    const dhtServer = this.dhtServer;
    this.dhtServer = null;
    if (dhtServer) {
      try {
        await dhtServer.close();
      } catch {
        // Already closing.
      }
    }
    const dht = this.dht;
    this.dht = null;
    if (dht) {
      try {
        await dht.destroy();
      } catch {
        // Already destroyed.
      }
    }
  }

  private startTcp(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = createServer((socket) => this.onTcpConnection(socket));
      this.tcpServer = server;
      server.on("error", (err) => {
        if (!server.listening) reject(err);
        else this.options.log(`tcp listener error: ${(err as Error).message}`);
      });
      server.listen(this.options.port ?? 0, this.options.host ?? "0.0.0.0", () => {
        const address = server.address();
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("tcp listener reported no address"));
      });
    });
  }

  private onTcpConnection(socket: Socket): void {
    socket.on("error", () => {
      // A prober resetting mid-handshake is routine, not reportable.
    });
    // Responder side of Noise IK under our identity key. The handshake
    // itself proves the initiator holds a full keypair; whether that key is
    // TRUSTED is decided below, after `open`.
    const stream = new NoiseSecretStream(false, socket, {
      keyPair: this.options.keyPair,
      pattern: "IK",
    }) as unknown as EncryptedPeerStream & { on(event: "open", handler: () => void): void };
    stream.on("error", () => {
      // Handshake failures (wrong server key, garbage bytes) end silently.
    });
    stream.on("open", () => {
      if (this.stopped) {
        stream.destroy();
        return;
      }
      this.route(stream);
    });
  }

  private async startDht(): Promise<boolean> {
    if (this.options.dhtBootstrap === false) return false;
    try {
      const dht = new HyperDHT(
        this.options.dhtBootstrap ? { bootstrap: this.options.dhtBootstrap } : {},
      );
      this.dht = dht;
      // The DHT firewall runs before the connection is acknowledged, so an
      // unknown key cannot even complete a connection on this rung. Return
      // value semantics: true means BLOCK.
      const server = dht.createServer(
        {
          firewall: (remotePublicKey: Buffer) => !this.options.isAuthorized(remotePublicKey),
        },
        (conn: EncryptedPeerStream) => {
          conn.on("error", () => {
            // Peer went away; the session layer handles cleanup.
          });
          if (this.stopped) {
            conn.destroy();
            return;
          }
          // The firewall already vetted the key, but re-check right before
          // handing the stream out: a device revoked between firewall and
          // connect must not get a session.
          if (!this.options.isAuthorized(conn.remotePublicKey)) {
            conn.destroy();
            return;
          }
          this.options.onAuthorizedStream(conn);
        },
      );
      this.dhtServer = server;
      await server.listen(this.options.keyPair);
      return true;
    } catch (err) {
      // DHT failure (offline, blocked UDP) degrades to LAN-only rather than
      // failing the whole feature.
      this.options.log(`dht rung unavailable: ${(err as Error).message}`);
      await this.teardownDhtAfterFailure();
      return false;
    }
  }

  private async teardownDhtAfterFailure(): Promise<void> {
    const dht = this.dht;
    this.dht = null;
    this.dhtServer = null;
    if (dht) {
      try {
        await dht.destroy();
      } catch {
        // Nothing left to clean.
      }
    }
  }

  // Post-handshake routing for the TCP rung.
  private route(stream: EncryptedPeerStream): void {
    const key = stream.remotePublicKey;
    if (this.options.isAuthorized(key)) {
      this.options.onAuthorizedStream(stream);
      return;
    }
    if (this.pairingOpen) {
      this.options.onPairingCandidateStream(stream);
      return;
    }
    // Unknown key, no pairing window: silence. No banner, no error frame.
    stream.destroy();
  }
}
