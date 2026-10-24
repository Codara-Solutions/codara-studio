// The share key: an Ed25519 keypair that signs every request to the share
// service (docs/share-links.md). It is NOT the Remote Access identity; that key
// has one purpose, phone pairing, and a share upload must never be able to
// stand in for it or the other way round. Stored at <codara-home>/share/
// identity.json with mode 0600 inside a 0700 directory, created on first use.
//
// Handling rules, enforced here and by every caller:
//   * The secret key never crosses IPC, never reaches the renderer, and is
//     never logged.
//   * The fs sandbox must never allowlist the share/ directory (see the note
//     in src/main/fs-sandbox.ts).

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import sodium from "sodium-native";
import { fsyncDirSync, stagingPath, writeStagingFileSync } from "../remote-access/identity";

export interface ShareIdentity {
  /** 32-byte Ed25519 public key. */
  publicKey: Buffer;
  /** 64-byte Ed25519 secret key. Never serialize outside identity.json. */
  secretKey: Buffer;
  /** Canonical padded standard base64 of publicKey, as the service expects it. */
  publicKeyB64: string;
}

interface ShareIdentityFile {
  version: 1;
  purpose: "codara-share";
  publicKey: string;
  secretKey: string;
  createdAt: string;
}

export const SHARE_IDENTITY_FILE = "identity.json";

const O_RD_NOFOLLOW =
  fsConstants.O_RDONLY | ((fsConstants.O_NOFOLLOW as number | undefined) ?? 0);

// Owner-only directory, healed on every use so a copied-over home that lost
// its mode bits fixes itself. A symlinked directory fails closed: everything
// under it is key material.
export function ensureShareDir(shareDir: string): void {
  mkdirSync(shareDir, { recursive: true, mode: 0o700 });
  if (lstatSync(shareDir).isSymbolicLink()) {
    throw new Error(`share directory ${shareDir} is a symlink; refusing to use it`);
  }
  try {
    chmodSync(shareDir, 0o700);
  } catch {
    // Windows has no POSIX modes; the ACL of the user profile dir applies.
  }
}

// Loads the share key, creating it on first use. A corrupt file is replaced
// by a fresh key: links made with the old key keep working until they expire,
// they just can no longer be listed, extended or deleted from this computer.
export function loadOrCreateShareIdentity(shareDir: string): ShareIdentity {
  ensureShareDir(shareDir);
  const file = join(shareDir, SHARE_IDENTITY_FILE);
  const existing = readShareIdentityFile(file);
  if (existing) return existing;

  const publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
  const secretKey = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
  sodium.crypto_sign_keypair(publicKey, secretKey);
  const payload: ShareIdentityFile = {
    version: 1,
    purpose: "codara-share",
    publicKey: publicKey.toString("base64"),
    secretKey: secretKey.toString("base64"),
    createdAt: new Date().toISOString(),
  };
  // Same write discipline as the Remote Access identity: an exclusive,
  // no-follow staging file with a randomized name, fsync, rename into place,
  // fsync the directory. A crash leaves no key or a whole one.
  const tmp = stagingPath(file);
  writeStagingFileSync(tmp, JSON.stringify(payload, null, 2), 0o600);
  renameSync(tmp, file);
  fsyncDirSync(shareDir);
  return { publicKey, secretKey, publicKeyB64: payload.publicKey };
}

function readShareIdentityFile(file: string): ShareIdentity | null {
  let raw: string;
  let fd: number;
  try {
    // No-follow open: a symlink planted at identity.json is treated as no key
    // (and then replaced by the rename above) instead of being read through.
    fd = openSync(file, O_RD_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    raw = readFileSync(fd, "utf8");
    try {
      fchmodSync(fd, 0o600);
    } catch {
      // Windows: no POSIX modes.
    }
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ShareIdentityFile>;
    if (parsed.version !== 1 || parsed.purpose !== "codara-share") return null;
    if (typeof parsed.publicKey !== "string" || typeof parsed.secretKey !== "string") return null;
    const publicKey = Buffer.from(parsed.publicKey, "base64");
    const secretKey = Buffer.from(parsed.secretKey, "base64");
    if (publicKey.length !== sodium.crypto_sign_PUBLICKEYBYTES) return null;
    if (secretKey.length !== sodium.crypto_sign_SECRETKEYBYTES) return null;
    // An Ed25519 secret key carries its public half in its last 32 bytes; a
    // file whose halves disagree was edited or damaged.
    if (!secretKey.subarray(32).equals(publicKey)) return null;
    return { publicKey, secretKey, publicKeyB64: publicKey.toString("base64") };
  } catch {
    return null;
  }
}
