// Minimal ambient typings for the Hyperswarm stack, which ships no
// TypeScript declarations. Only the surface listener.ts and the pairing
// path actually touch is declared; anything else stays deliberately
// unavailable rather than typed as any at the import site.

declare module "sodium-native" {
  interface SodiumNative {
    readonly crypto_sign_PUBLICKEYBYTES: number;
    readonly crypto_sign_SECRETKEYBYTES: number;
    crypto_sign_keypair(publicKey: Buffer, secretKey: Buffer): void;
  }
  const sodium: SodiumNative;
  export = sodium;
}

declare module "@hyperswarm/secret-stream" {
  import type { Duplex } from "node:stream";

  interface NoiseSecretStreamOptions {
    keyPair?: { publicKey: Buffer; secretKey: Buffer };
    remotePublicKey?: Buffer;
    // Noise handshake pattern. Default "XX"; we always pass "IK" so the
    // initiator pins the responder's static key.
    pattern?: "XX" | "IK";
  }

  class NoiseSecretStream extends Duplex {
    constructor(isInitiator: boolean, rawStream?: Duplex | null, opts?: NoiseSecretStreamOptions);
    readonly publicKey: Buffer;
    readonly remotePublicKey: Buffer;
    on(event: "open", handler: () => void): this;
    on(event: "data", handler: (chunk: Buffer) => void): this;
    on(event: "close", handler: () => void): this;
    on(event: "error", handler: (err: Error) => void): this;
    on(event: string, handler: (...args: unknown[]) => void): this;
  }

  export = NoiseSecretStream;
}

declare module "hyperdht" {
  import type { Duplex } from "node:stream";

  interface HyperDHTOptions {
    bootstrap?: Array<{ host: string; port: number }>;
  }

  interface HyperDHTServerOptions {
    // Return true to BLOCK the remote key from completing a connection.
    firewall?: (remotePublicKey: Buffer, payload?: unknown) => boolean;
  }

  interface HyperDHTConnection extends Duplex {
    readonly remotePublicKey: Buffer;
  }

  interface HyperDHTServer {
    listen(keyPair: { publicKey: Buffer; secretKey: Buffer }): Promise<void>;
    close(): Promise<void>;
  }

  class HyperDHT {
    constructor(opts?: HyperDHTOptions);
    static keyPair(seed?: Buffer): { publicKey: Buffer; secretKey: Buffer };
    createServer(
      opts: HyperDHTServerOptions,
      onconnection: (conn: HyperDHTConnection) => void,
    ): HyperDHTServer;
    connect(
      remotePublicKey: Buffer,
      opts?: { keyPair?: { publicKey: Buffer; secretKey: Buffer } },
    ): HyperDHTConnection;
    destroy(): Promise<void>;
  }

  export = HyperDHT;
}
