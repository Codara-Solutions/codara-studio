// Minimal ambient typings for the Noise/sodium packages, which ship no
// TypeScript declarations. Only the surface listener.ts and the pairing
// path actually touch is declared; anything else stays deliberately
// unavailable rather than typed as any at the import site.

declare module "sodium-native" {
  interface SodiumNative {
    readonly crypto_sign_PUBLICKEYBYTES: number;
    readonly crypto_sign_SECRETKEYBYTES: number;
    crypto_sign_keypair(publicKey: Buffer, secretKey: Buffer): void;
    crypto_sign_detached(signature: Buffer, message: Buffer, secretKey: Buffer): void;
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
