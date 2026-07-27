// The computer's long-lived Ed25519 identity for phone Remote Access
// (docs/remote-access.md, "Identity and pairing"). Created lazily on first
// use and stored at <spark-home>/remote/identity.json with mode 0600 inside
// a 0700 directory. The same keypair authenticates the outbound relay and
// drives the end-to-end Noise IK handshake on both transport rungs.
//
// Handling rules, enforced here and by every caller:
//   * The secret key never crosses IPC, never reaches the renderer, and is
//     never logged. Log sites that need to name this identity use
//     shortKey() (first 8 chars of the base64 public key) only.
//   * The fs sandbox must never allowlist the remote/ directory (see the
//     note in src/main/fs-sandbox.ts).

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  promises as fsp,
  readFileSync,
  renameSync,
  writeSync as fsWriteSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import sodium from "sodium-native";

// Exclusive, no-follow create flags for staging files. O_EXCL fails if the
// path already exists (a pre-planted symlink at the predictable tmp name
// included, which is why staging names are also randomized), and O_NOFOLLOW
// refuses to follow a final-component symlink. O_NOFOLLOW is POSIX only, so
// it degrades to 0 where the platform lacks it.
export const O_EXCL_NOFOLLOW =
  fsConstants.O_CREAT |
  fsConstants.O_WRONLY |
  fsConstants.O_EXCL |
  ((fsConstants.O_NOFOLLOW as number | undefined) ?? 0);
const O_RD_NOFOLLOW =
  fsConstants.O_RDONLY | ((fsConstants.O_NOFOLLOW as number | undefined) ?? 0);

let stagingCounter = 0;

// A unique staging path for a target file: pid + counter + random suffix, so
// two writers (a synchronous authoritative write and an async cosmetic
// flush) can never collide, and an attacker cannot pre-plant a symlink at a
// predictable tmp name.
export function stagingPath(target: string): string {
  stagingCounter += 1;
  return `${target}.${process.pid}.${stagingCounter}.${randomBytes(6).toString("hex")}.tmp`;
}

// Writes a staging file with exclusive/no-follow create semantics and fsyncs
// it, so its contents are on disk before the caller renames it into place.
export function writeStagingFileSync(tmp: string, data: string, mode: number): void {
  const fd = openSync(tmp, O_EXCL_NOFOLLOW, mode);
  try {
    fsWriteSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, mode);
  } catch {
    // Windows: no POSIX modes.
  }
}

// fsync a file by path, without following a symlink at that path. Used to
// make an already-written staging file durable before it is renamed.
export async function fsyncFile(path: string): Promise<void> {
  const fh = await fsp.open(path, O_RD_NOFOLLOW);
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// fsync a directory so a rename that published a file into it is itself
// durable across a power loss. Opening a directory for fsync is POSIX
// behaviour; on Windows it is unsupported, so failures are ignored.
export function fsyncDirSync(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, fsConstants.O_RDONLY);
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // Windows / filesystem without directory fsync.
  } finally {
    closeSync(fd);
  }
}

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

// The pairing-confirmation fingerprint of a public key: its leading eight
// bytes as uppercase hex in groups of four, e.g. "7F3A 91C2 5E08 4B6D". This
// is byte-for-byte the short form the phone shows on its confirm screen
// (codara-mobile src/lib/remote/format.ts formatKeyShortForm), so the user
// can compare the desktop and phone screens by eye during pairing. Returns
// an empty string for anything that is not a decodable 8+ byte key, so a
// caller never renders half a fingerprint.
export function keyFingerprint(publicKeyB64: string): string {
  const bytes = Buffer.from(publicKeyB64, "base64");
  if (bytes.length < 8) return "";
  const hex = bytes.subarray(0, 8).toString("hex").toUpperCase();
  return (hex.match(/.{4}/g) ?? []).join(" ");
}

// Ensures the remote/ dir exists with owner-only access. chmod is applied
// even when the dir pre-exists so a copied-over home (which may have lost
// its mode bits, see the spawn-helper saga in pty-manager) heals itself.
export function ensureRemoteDir(remoteDir: string): void {
  mkdirSync(remoteDir, { recursive: true });
  // Fail closed if the remote dir is a symlink: everything under it is key
  // material and trust state, and a symlinked directory could redirect those
  // writes somewhere an attacker controls. mkdir with recursive is a no-op
  // when the path already exists (as a real dir or a symlink to one), so this
  // lstat is what actually catches the symlink case.
  if (lstatSync(remoteDir).isSymbolicLink()) {
    throw new Error(`remote directory ${remoteDir} is a symlink; refusing to use it`);
  }
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
  // Exclusive/no-follow create plus a randomized staging name so a symlink
  // pre-planted at the tmp path cannot redirect the write, and fsync of the
  // file and directory so the identity survives a power loss.
  const tmp = stagingPath(file);
  writeStagingFileSync(tmp, JSON.stringify(payload, null, 2), 0o600);
  renameSync(tmp, file);
  fsyncDirSync(remoteDir);

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
