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
  // Node's Writable contract: false means the peer is not draining and the
  // caller should back off until "drain". RPC sessions rely on this.
  write(data: Buffer): boolean;
  end(): void;
  destroy(): void;
  on(event: "data", handler: (chunk: Buffer) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (err: Error) => void): void;
  on(event: "drain", handler: () => void): void;
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

// Pre-authentication resource limits. These exist because an accepted
// socket costs real memory BEFORE anyone has proved anything: the Noise
// layer allocates a buffer sized by a length the peer declares in its
// first three bytes (up to ~16 MiB), so an unauthenticated peer can turn 4
// bytes into megabytes. Nothing downstream can undo that, so the defence is
// to keep the number of unauthenticated sockets small and their lifetime
// short.
//
// Worst case with these numbers is roughly MAX_PENDING_HANDSHAKES x 16 MiB
// held for at most HANDSHAKE_DEADLINE_MS, which is survivable and transient
// rather than unbounded. The cost is that eight simultaneous hostile
// sockets can delay a legitimate pairing by a few seconds; the short
// deadline is what keeps that from becoming a lasting lockout.
const MAX_PENDING_HANDSHAKES = 8;
const HANDSHAKE_DEADLINE_MS = 5_000;
// Sockets that completed IK but are NOT authorized get their own, smaller
// budget with their own short deadline. Completing IK proves only that the
// peer holds SOME keypair: our responder key is not secret (it is in every
// QR and derivable from the DHT topic), so anyone can complete IK with a
// self-generated key. Such a stream is only ever a pairing candidate, and
// only while a pairing window is open, so beyond this small budget it is
// refused. This is what keeps IK-complete-but-unauthorized streams, each of
// which can pin a ~16 MiB secret-stream receive buffer, from accumulating up
// to the 64-socket server cap (~1 GiB) during a pairing window.
const MAX_IK_UNAUTHORIZED = 4;
const IK_UNAUTH_DEADLINE_MS = 10_000;
// DHT rung backpressure. hyperdht's firewall hook is the only point on this
// rung where we can refuse a peer before its handshake, and it is the only
// place any of this is enforceable: everything before the hook (the
// holepunch coordination, the ~10s of timers a rejected attempt leaves) lives
// inside hyperdht and cannot be bounded from above. See docs/remote-access.md.
// So we do what we can: rate-limit the connection attempts we ACCEPT (an
// unknown key is already blocked outright), and cap the number of concurrent
// established DHT connections, as a backstop under the per-device/global
// session caps in index.ts.
const DHT_ACCEPT_MAX = 20;
const DHT_ACCEPT_WINDOW_MS = 10_000;
const MAX_DHT_CONNECTIONS = 32;

// A fixed-window rate limiter over a stream of event timestamps. Pure and
// injectable-now so it can be unit-tested without a live DHT.
export class DhtRateLimiter {
  private readonly hits: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  // Records an event at `now` and returns whether it is within the budget.
  allow(now: number): boolean {
    while (this.hits.length > 0 && now - this.hits[0] >= this.windowMs) this.hits.shift();
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}
// Total accepted sockets, authenticated or not. Node destroys anything past
// this itself.
const MAX_CONNECTIONS = 64;
// Applied to established sessions instead of the handshake deadline: a
// paired phone may legitimately sit idle for a long time with a terminal
// open, so we reap dead peers with TCP keepalive rather than by wall clock.
const KEEPALIVE_DELAY_MS = 60_000;
// stop() must always settle. server.close() only fires its callback once
// every accepted connection has ended, so we destroy sockets first and then
// bound the wait regardless.
const STOP_CLOSE_TIMEOUT_MS = 2_000;
// Same reasoning for the DHT half of shutdown: a hang in the transport
// library must not be able to wedge the lifecycle.
const DHT_CLOSE_TIMEOUT_MS = 3_000;

export class RemoteListener {
  private tcpServer: Server | null = null;
  private dht: HyperDHT | null = null;
  private dhtServer: ReturnType<HyperDHT["createServer"]> | null = null;
  private pairingOpen = false;
  private stopped = false;
  // DHT rung accounting (see startDht). The rate limiter bounds accepted
  // connection attempts; dhtConnections caps concurrent established ones.
  private readonly dhtAccepts = new DhtRateLimiter(DHT_ACCEPT_MAX, DHT_ACCEPT_WINDOW_MS);
  private dhtConnections = 0;
  // Every accepted socket, authenticated or not, so stop() can destroy them
  // instead of waiting on peers that may never disconnect.
  private readonly sockets = new Set<Socket>();
  // Sockets that have not completed a handshake yet, with their deadline
  // timers. Kept separate from `sockets` because the pre-auth cap and the
  // deadline apply only to this set.
  private readonly pendingHandshakes = new Map<Socket, NodeJS.Timeout>();
  // Sockets that completed IK but are not yet authorized: pairing candidates
  // held under MAX_IK_UNAUTHORIZED with their own IK_UNAUTH_DEADLINE_MS. Only
  // ever populated while a pairing window is open.
  private readonly ikUnauthorized = new Map<Socket, NodeJS.Timeout>();

  constructor(private readonly options: RemoteListenerOptions) {}

  // While true, post-handshake strangers on the TCP rung are routed to the
  // pairing exchange instead of being dropped. The DHT rung never accepts
  // strangers regardless: pairing is a same-LAN ceremony by design.
  setPairingOpen(open: boolean): void {
    this.pairingOpen = open;
  }

  // Whether this listener still holds DHT objects. False after a completed
  // stop(), including one whose TCP half timed out, which is exactly the
  // property the hostile-peer suite asserts: a wedged TCP close must never
  // leave this computer announced on the DHT.
  isDhtActive(): boolean {
    return this.dht !== null || this.dhtServer !== null;
  }

  async start(): Promise<RemoteListenerStartResult> {
    if (this.tcpServer) throw new Error("listener already started");
    this.stopped = false;
    const port = await this.startTcp();
    const dhtReady = await this.startDht();
    return { port, dhtReady };
  }

  // Always settles, and always tears the DHT down. The TCP half is best
  // effort by construction: server.close() waits for every accepted
  // connection to end, so a peer that connects and then goes silent could
  // otherwise hold the whole shutdown (and with it the DHT announce, the
  // status update, and any future enable) open forever.
  async stop(): Promise<void> {
    this.stopped = true;
    const tcp = this.tcpServer;
    this.tcpServer = null;
    try {
      for (const timer of this.pendingHandshakes.values()) clearTimeout(timer);
      this.pendingHandshakes.clear();
      for (const timer of this.ikUnauthorized.values()) clearTimeout(timer);
      this.ikUnauthorized.clear();
      for (const socket of [...this.sockets]) {
        try {
          socket.destroy();
        } catch {
          // Already gone.
        }
      }
      this.sockets.clear();
      if (tcp) {
        // net.Server has no closeAllConnections (that is http.Server), so
        // the destroy loop above IS the mechanism. It is complete because
        // every accepted socket is tracked, and `stopped` was set first, so
        // anything accepted from here on is destroyed on arrival. The
        // bounded wait is the backstop for a socket that resists teardown.
        await withTimeout(
          new Promise<void>((resolve) => tcp.close(() => resolve())),
          STOP_CLOSE_TIMEOUT_MS,
        );
      }
    } catch (err) {
      this.options.log(`tcp teardown did not complete cleanly: ${(err as Error).message}`);
    } finally {
      // The DHT announce is the part that must not survive a disable: it is
      // what makes this computer findable by key. Run it whatever the TCP
      // path did.
      // Both steps are time-bounded for the same reason the TCP close is: a
      // hang anywhere in shutdown reintroduces the wedge where the status
      // never returns to disabled and the feature cannot be re-enabled. The
      // references are cleared FIRST, so isDhtActive reports the teardown as
      // done even if one of these calls never settles.
      const dhtServer = this.dhtServer;
      this.dhtServer = null;
      if (dhtServer) {
        await withTimeout(
          dhtServer.close().catch(() => undefined),
          DHT_CLOSE_TIMEOUT_MS,
        );
      }
      const dht = this.dht;
      this.dht = null;
      if (dht) {
        await withTimeout(
          dht.destroy().catch(() => undefined),
          DHT_CLOSE_TIMEOUT_MS,
        );
      }
    }
  }

  private startTcp(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = createServer((socket) => this.onTcpConnection(socket));
      // Node destroys anything past this itself, so the accept queue cannot
      // be used to hold thousands of sockets open.
      server.maxConnections = MAX_CONNECTIONS;
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
    if (this.stopped) {
      socket.destroy();
      return;
    }
    // Refuse a new unauthenticated socket while the pre-auth slots are
    // full. Silently, like every other refusal on this rung.
    if (this.pendingHandshakes.size >= MAX_PENDING_HANDSHAKES) {
      socket.destroy();
      return;
    }

    this.sockets.add(socket);
    socket.on("close", () => {
      this.sockets.delete(socket);
      const timer = this.pendingHandshakes.get(socket);
      if (timer) {
        clearTimeout(timer);
        this.pendingHandshakes.delete(socket);
      }
      const authTimer = this.ikUnauthorized.get(socket);
      if (authTimer) {
        clearTimeout(authTimer);
        this.ikUnauthorized.delete(socket);
      }
    });

    // Hard deadline on the unauthenticated phase. This is the fix that
    // matters: without it a peer can connect, declare a large Noise frame,
    // and then simply stop sending, holding that allocation forever.
    const deadline = setTimeout(() => {
      this.pendingHandshakes.delete(socket);
      socket.destroy();
    }, HANDSHAKE_DEADLINE_MS);
    this.pendingHandshakes.set(socket, deadline);
    // Covers the peer that dribbles bytes to keep a socket technically
    // active; the deadline above covers the one that sends nothing.
    socket.setTimeout(HANDSHAKE_DEADLINE_MS, () => socket.destroy());

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
      clearTimeout(deadline);
      this.pendingHandshakes.delete(socket);
      if (this.stopped) {
        stream.destroy();
        return;
      }
      this.route(stream, socket);
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
          firewall: (remotePublicKey: Buffer) => {
            // Reject an unknown key as early as we can: before the handshake
            // completes, so a stranger cannot even establish a connection.
            // Returning true means BLOCK.
            if (!this.options.isAuthorized(remotePublicKey)) return true;
            // A paired key is allowed, but rate-limited: a compromised paired
            // device must not be able to drive an unbounded storm of accepted
            // connection attempts. Over the budget we block; a legitimate
            // phone retries and gets in on the next window.
            if (!this.dhtAccepts.allow(Date.now())) {
              this.options.log("dht rung: accepted-connection rate limit hit; deferring a paired peer");
              return true;
            }
            return false;
          },
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
          // Backstop cap on concurrent established DHT connections, under the
          // per-device and global session caps in index.ts.
          if (this.dhtConnections >= MAX_DHT_CONNECTIONS) {
            conn.destroy();
            return;
          }
          this.dhtConnections += 1;
          conn.on("close", () => {
            this.dhtConnections = Math.max(0, this.dhtConnections - 1);
          });
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
  private route(stream: EncryptedPeerStream, socket: Socket): void {
    const key = stream.remotePublicKey;
    if (this.options.isAuthorized(key)) {
      // Proven paired key: promote to an established session. An established
      // session may idle for hours with a terminal open, so swap the
      // handshake deadline for TCP keepalive: dead peers still get reaped,
      // live idle ones are left alone.
      socket.setTimeout(0);
      socket.setKeepAlive(true, KEEPALIVE_DELAY_MS);
      this.options.onAuthorizedStream(stream);
      return;
    }
    // Completing IK proved possession of SOME keypair, nothing more. An
    // unknown key is a pairing candidate only while a window is open.
    if (!this.pairingOpen) {
      // Unknown key, no pairing window: silence. No banner, no error frame.
      stream.destroy();
      return;
    }
    // It is still UNAUTHORIZED until it proves the pairing secret, so it stays
    // inside a small, short-lived budget rather than being promoted to a
    // keepalive session. Beyond the budget it is refused, silently.
    if (this.ikUnauthorized.size >= MAX_IK_UNAUTHORIZED) {
      stream.destroy();
      return;
    }
    const authDeadline = setTimeout(() => {
      this.ikUnauthorized.delete(socket);
      stream.destroy();
    }, IK_UNAUTH_DEADLINE_MS);
    this.ikUnauthorized.set(socket, authDeadline);
    // No keepalive: an unauthenticated pairing candidate is held on the short
    // leash above, not the hours-long idle budget a paired session gets.
    socket.setTimeout(0);
    this.options.onPairingCandidateStream(stream);
  }
}

// Resolves when `promise` settles or when the timeout elapses, whichever is
// first. Used so a shutdown step can never hang the lifecycle chain.
function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, ms);
    void promise.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
