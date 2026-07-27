// The computer's long-lived Ed25519 identity for phone Remote Access
// (docs/remote-access.md, "Identity and pairing"). Created lazily on first
// use and stored at <spark-home>/remote/identity.json with mode 0600 inside
// a 0700 directory. The same keypair drives every transport rung: the Noise
// IK handshake on the direct TCP listener and the hyperdht server announce.
//
// Handling rules, enforced here and by every caller:
//   * The secret key never crosses IPC, never reaches the renderer, and is
//     never logged. Log sites that need to name this identity use
//     shortKey() (first 8 chars of the base64 public key) only.
//   * The fs sandbox must never allowlist the remote/ directory (see the
//     note in src/main/fs-sandbox.ts).

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sodium from "sodium-native";

export interface RemoteIdentity {
  // 32-byte Ed25519 public key.
  publicKey: Buffer;
  // 64-byte Ed25519 secret key. Never serialize outside identity.json.
  secretKey: Buffer;
  // Canonical padded standard base64 of publicKey, the spelling the QR
  // payload and paired-device records use everywhere.
  publicKeyB64: string;
}

interface IdentityFileShape {
  version: 1;
  publicKey: string;
  secretKey: string;
  createdAt: string;
}

export const IDENTITY_FILE = "identity.json";

// Display/log form of any public key: enough to tell devices apart in a
// list, useless for impersonation, and safe to write to logs.
export function shortKey(publicKeyB64: string): string {
  return publicKeyB64.slice(0, 8);
}

// Ensures the remote/ dir exists with owner-only access. chmod is applied
// even when the dir pre-exists so a copied-over home (which may have lost
// its mode bits, see the spawn-helper saga in pty-manager) heals itself.
export function ensureRemoteDir(remoteDir: string): void {
  mkdirSync(remoteDir, { recursive: true });
  try {
    chmodSync(remoteDir, 0o700);
  } catch {
    // Windows has no POSIX modes; the ACL of the user profile dir applies.
  }
}

// Loads the identity, creating it on first use. Corrupt or partially
// written files are treated as absent and regenerated: pairing pins keys on
// the PHONE side too, so silently minting a fresh identity here can never
// let an attacker inherit an old identity's trust; paired devices simply
// stop connecting until re-paired, which is the honest outcome for a
// destroyed key file.
export function loadOrCreateIdentity(remoteDir: string): RemoteIdentity {
  ensureRemoteDir(remoteDir);
  const file = join(remoteDir, IDENTITY_FILE);

  const existing = readIdentityFile(file);
  if (existing) return existing;

  const publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
  const secretKey = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
  sodium.crypto_sign_keypair(publicKey, secretKey);

  const payload: IdentityFileShape = {
    version: 1,
    publicKey: publicKey.toString("base64"),
    secretKey: secretKey.toString("base64"),
    createdAt: new Date().toISOString(),
  };
  // Write-then-rename so a crash mid-write leaves either no file (regenerate
  // next boot) or a complete one, never a half-written key we would discard.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows: no POSIX modes.
  }
  renameSync(tmp, file);

  return { publicKey, secretKey, publicKeyB64: payload.publicKey };
}

function readIdentityFile(file: string): RemoteIdentity | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<IdentityFileShape>;
    if (parsed.version !== 1) return null;
    if (typeof parsed.publicKey !== "string" || typeof parsed.secretKey !== "string") return null;
    const publicKey = Buffer.from(parsed.publicKey, "base64");
    const secretKey = Buffer.from(parsed.secretKey, "base64");
    if (publicKey.length !== sodium.crypto_sign_PUBLICKEYBYTES) return null;
    if (secretKey.length !== sodium.crypto_sign_SECRETKEYBYTES) return null;
    // Re-encode instead of trusting the file's spelling, so a hand-edited
    // URL-safe or unpadded variant cannot produce a second spelling of the
    // same key downstream.
    return { publicKey, secretKey, publicKeyB64: publicKey.toString("base64") };
  } catch {
    return null;
  }
}
