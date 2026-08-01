// LAN pairing and the paired-device store for phone Remote Access
// (docs/remote-access.md, "Identity and pairing"). Pairing is the security
// boundary of the whole feature: a paired phone can create terminals, which
// is remote code execution by design, so everything here favors refusing
// over recovering.
//
// Flow: opening the pairing modal creates a PairingWindow (32-byte one-time
// secret, 2 minute expiry, single use) and the QR payload below. The phone
// scans it, dials the listed LAN endpoint, and completes the Noise IK
// handshake pinned to our public key (so the channel is encrypted and the
// computer is authenticated before any application byte flows). Over that
// channel it sends one pairing frame proving knowledge of the secret; we pin
// its static key from the handshake, persist it, and reply with our display
// name. Anything else - wrong secret, second use, expired window, malformed
// frame - tears the stream down without a reply, per the silent-listener
// rule.
//
// The QR payload is a hard interop contract: it must parse with the phone
// app's parser (codara-mobile src/lib/remote/pairing-payload.ts). That
// parser requires `pk` to be exactly 32 base64 bytes, `secret` to decode to
// at least 16 bytes, plain host strings in `addrs`, and rejects payloads
// whose `iat` is older than 2 minutes (30s clock skew tolerance).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fsp, readFileSync, renameSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { RemotePairedDevice } from "@shared/remote-access";
import {
  ensureRemoteDir,
  fsyncDirSync,
  fsyncFile,
  O_EXCL_NOFOLLOW,
  shortKey,
  stagingPath,
  writeStagingFileSync,
} from "./identity";

export const PAIRING_TTL_MS = 2 * 60 * 1000;
export const PAIRING_SECRET_BYTES = 32;
export const PAIRED_DEVICES_FILE = "paired-devices.json";
// Matches the phone parser's cap on the optional display name.
const MAX_DEVICE_NAME_CHARS = 64;
// How long last-seen updates coalesce before one async write. Long enough
// that a reconnect storm collapses into a single flush.
const LAST_SEEN_FLUSH_DELAY_MS = 5_000;

/* -------------------------------------------------------------------------- */
/* Paired-device store                                                        */
/* -------------------------------------------------------------------------- */

export interface PairedDeviceRecord {
  // Canonical padded standard base64 of the device's 32-byte Ed25519 key.
  // Canonical spelling matters: this string is the identity we compare on
  // every connection and on revoke, so two spellings of one key must never
  // exist. addDevice re-encodes from bytes to guarantee it.
  publicKey: string;
  name: string;
  // Epoch milliseconds.
  addedAt: number;
  lastSeenAt: number | null;
}

interface DevicesFileShape {
  version: 1;
  devices: PairedDeviceRecord[];
}

// The firewall decision. Pure so tests can hit it directly: given the raw
// 32-byte key a transport handshake produced, is this a device the user
// paired? Unknown and revoked keys both land on `false`; the caller drops
// the connection without a response either way.
export function isAuthorizedKey(
  publicKey: Buffer | Uint8Array,
  devices: ReadonlyArray<Pick<PairedDeviceRecord, "publicKey">>,
): boolean {
  if (publicKey.length !== 32) return false;
  const b64 = Buffer.from(publicKey).toString("base64");
  return devices.some((device) => device.publicKey === b64);
}

// On-disk store for paired devices, one JSON file under <spark-home>/remote.
// Reads are cached; every mutation writes through atomically (tmp + rename)
// so a crash never leaves a truncated trust list. A corrupt file loads as
// empty: failing CLOSED (no devices trusted) is the only safe reading of an
// unreadable trust store.
export class PairedDeviceStore {
  private readonly file: string;
  private cache: PairedDeviceRecord[] | null = null;
  private lastSeenFlushTimer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  // Bumped by every authoritative write (pair, revoke). An async last-seen
  // flush carries the generation it started under and refuses to be the
  // last word once that number has moved. See saveAsync.
  private generation = 0;
  // The in-flight last-seen flush RENAME, or null. A revoke that lands while
  // a rename is on the threadpool awaits exactly this before its own write,
  // so its clean write is provably the last one to touch the file and a
  // stale rename can never land after the revoke resolves. Set synchronously
  // in the same tick as the pre-rename generation check, with no await
  // between, so the revoke's generation bump cannot slip in unseen.
  private renameInFlight: Promise<void> | null = null;

  // `log` carries durability failures that the user would otherwise never
  // hear about. Never pass anything key-bearing to it.
  constructor(
    private readonly remoteDir: string,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.file = join(remoteDir, PAIRED_DEVICES_FILE);
  }

  list(): PairedDeviceRecord[] {
    if (this.cache) return this.cache;
    this.cache = this.readFromDisk();
    return this.cache;
  }

  listForUi(): RemotePairedDevice[] {
    return this.list().map((device) => ({
      publicKey: device.publicKey,
      shortKey: shortKey(device.publicKey),
      name: device.name,
      addedAt: device.addedAt,
      lastSeenAt: device.lastSeenAt,
    }));
  }

  isAuthorized(publicKey: Buffer | Uint8Array): boolean {
    return isAuthorizedKey(publicKey, this.list());
  }

  // Adds (or re-pairs) a device keyed by its raw public key. Re-pairing an
  // existing key updates the name and keeps the original addedAt, so a phone
  // that re-scans after a reinstall does not show up twice.
  addDevice(publicKey: Buffer | Uint8Array, name: string, now = Date.now()): PairedDeviceRecord {
    const b64 = Buffer.from(publicKey).toString("base64");
    const cleanName = sanitizeDeviceName(name);
    const devices = this.list();
    const existing = devices.find((device) => device.publicKey === b64);
    let record: PairedDeviceRecord;
    if (existing) {
      existing.name = cleanName;
      existing.lastSeenAt = now;
      record = existing;
    } else {
      record = { publicKey: b64, name: cleanName, addedAt: now, lastSeenAt: now };
      devices.push(record);
    }
    this.save(devices);
    return record;
  }

  // Removes a device by its canonical base64 key. Returns whether anything
  // was removed; the caller (index.ts) kills the device's live sessions the
  // moment the in-memory list stops trusting it, which happens synchronously
  // below, before this function's first await.
  //
  // Async because of the durability guarantee it carries: when the returned
  // promise resolves, the revocation is on disk AND no other write to the
  // trust file can still land, so a crash at any instant from then on cannot
  // bring the device back.
  //
  // This is enforced by ordering, with no repair-after-the-fact. The
  // generation bump below is synchronous and happens-before it awaits, so any
  // flush that has not yet reached its pre-rename generation check will see
  // the bump and abandon its staging file rather than rename it. The only
  // flush that can still rename is one whose rename was ALREADY dispatched to
  // the threadpool; that rename is tracked as renameInFlight and this method
  // waits for it to land before doing its own synchronous write, so the clean
  // write is unconditionally last. There is deliberately no bounded-wait
  // fallback that writes concurrently with an in-flight rename, because that
  // was exactly the window where a stalled rename could clobber the clean
  // state after the revoke had returned.
  async revokeDevice(publicKeyB64: string): Promise<boolean> {
    const devices = this.list();
    const next = devices.filter((device) => device.publicKey !== publicKeyB64);
    if (next.length === devices.length) return false;

    // Synchronous half: memory stops trusting the device immediately, the
    // generation bump tells any not-yet-committed flush it is stale (so it
    // abandons its staging file rather than renaming it), and the pending
    // timer is cancelled so no NEW flush can start.
    this.cache = next;
    this.generation += 1;
    if (this.lastSeenFlushTimer) {
      clearTimeout(this.lastSeenFlushTimer);
      this.lastSeenFlushTimer = null;
    }

    // A flush whose rename is already on the threadpool is the one case the
    // generation bump cannot head off. Wait for that rename to land (it
    // carries pre-revoke content), then write clean strictly after it. A
    // flush stalled anywhere BEFORE its rename has renameInFlight === null
    // and will skip its rename once it sees the bumped generation, so there
    // is nothing to wait for and this returns at once.
    if (this.renameInFlight) {
      await this.renameInFlight.catch(() => undefined);
    }

    this.writeSync(next);
    return true;
  }

  // Last-seen is cosmetic (it renders in the Settings list), so unlike
  // pairing and revocation it must never cost the main thread a synchronous
  // write. The in-memory value updates immediately; the file catches up on
  // a coalesced async flush, so a device reconnecting in a tight loop
  // cannot turn accept() into disk I/O.
  touchLastSeen(publicKey: Buffer | Uint8Array, now = Date.now()): void {
    const b64 = Buffer.from(publicKey).toString("base64");
    const devices = this.list();
    const record = devices.find((device) => device.publicKey === b64);
    if (!record) return;
    record.lastSeenAt = now;
    this.scheduleLastSeenFlush();
  }

  private scheduleLastSeenFlush(): void {
    if (this.lastSeenFlushTimer) return;
    this.lastSeenFlushTimer = setTimeout(() => {
      this.lastSeenFlushTimer = null;
      void this.saveAsync().catch(() => {
        // Losing a last-seen timestamp is not worth surfacing; the trust
        // list itself is written synchronously elsewhere.
      });
    }, LAST_SEEN_FLUSH_DELAY_MS);
    // Never hold the process open for a cosmetic write.
    this.lastSeenFlushTimer.unref?.();
  }

  // Flush any pending last-seen write now. Called on shutdown so the final
  // timestamps are not lost, and by tests that assert persistence.
  async flushPendingWrites(): Promise<void> {
    if (this.lastSeenFlushTimer) {
      clearTimeout(this.lastSeenFlushTimer);
      this.lastSeenFlushTimer = null;
      await this.saveAsync().catch(() => undefined);
      return;
    }
    // No timer pending, but a flush dispatched earlier may still be in the
    // air; callers use this to mean "all writes have landed".
    await this.writing;
  }

  private readFromDisk(): PairedDeviceRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as Partial<DevicesFileShape>;
      if (parsed.version !== 1 || !Array.isArray(parsed.devices)) return [];
      return parsed.devices.filter(isPlausibleRecord);
    } catch {
      return [];
    }
  }

  // Synchronous, for the security-relevant mutations (pairing a device,
  // revoking one). Those must be durable before the caller proceeds, and
  // they are AUTHORITATIVE: bumping the generation here is what tells an
  // in-flight cosmetic flush that whatever it is carrying is now stale.
  // Cancelling the pending timer stops a scheduled flush from resurrecting
  // the state we just replaced.
  private save(devices: PairedDeviceRecord[]): void {
    this.cache = devices;
    this.generation += 1;
    if (this.lastSeenFlushTimer) {
      clearTimeout(this.lastSeenFlushTimer);
      this.lastSeenFlushTimer = null;
    }
    this.writeSync(devices);
  }

  private writeSync(devices: PairedDeviceRecord[]): void {
    ensureRemoteDir(this.remoteDir);
    const payload: DevicesFileShape = { version: 1, devices };
    // Randomized, exclusive/no-follow staging file, fsynced before the
    // rename, and the directory fsynced after it, so a revoke or a pairing is
    // durable across a power loss and cannot be redirected through a
    // pre-planted symlink.
    const tmp = stagingPath(this.file);
    writeStagingFileSync(tmp, JSON.stringify(payload, null, 2), 0o600);
    renameSync(tmp, this.file);
    fsyncDirSync(this.remoteDir);
  }

  // Async twin of save() for the cosmetic last-seen flush, serialized behind
  // `writing` so two flushes cannot interleave their renames.
  //
  // This write is NEVER allowed to survive a revoke. The defences, in order:
  //
  //   1. Superseded BEFORE the write starts. The payload is read from
  //      this.list() at execution time rather than captured at scheduling
  //      time, so it already reflects the revoke.
  //   2. Superseded DURING the write, before the rename. The generation is
  //      re-checked immediately before the rename, in the same synchronous
  //      tick that publishes the rename (no await between the check and the
  //      dispatch), so a revoke's synchronous generation bump cannot slip in
  //      unseen: the flush either sees the bump and abandons its staging file
  //      or it publishes the rename and records it as renameInFlight.
  //   3. Superseded DURING the rename itself. This is the only window the
  //      check cannot see, because the rename is already on the threadpool.
  //      A revoke landing here finds renameInFlight set and waits for it
  //      before writing (see revokeDevice), so the revoke's clean write is
  //      strictly last. There is no repair-after-the-fact: nothing stale is
  //      ever left behind for a later write to correct.
  private async saveAsync(): Promise<void> {
    const run = this.writing.then(async () => {
      const generation = this.generation;
      const devices = this.list();
      ensureRemoteDir(this.remoteDir);
      const payload: DevicesFileShape = { version: 1, devices };
      const tmp = stagingPath(this.file);
      // fsp.writeFile with an exclusive/no-follow flag: exclusive create so a
      // pre-planted symlink at the staging path fails the write instead of
      // being followed.
      await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), {
        flag: O_EXCL_NOFOLLOW,
        mode: 0o600,
      });
      try {
        await fsp.chmod(tmp, 0o600);
      } catch {
        // Windows: no POSIX modes.
      }
      await fsyncFile(tmp);
      // Superseded before we publish: drop the staging file rather than
      // rename it. No clobber happens at all. This check and the rename
      // dispatch below run with no await between them, so a concurrent
      // revoke's generation bump is either seen here or waited on via
      // renameInFlight, never lost.
      if (this.generation !== generation) {
        await fsp.unlink(tmp).catch(() => undefined);
        return;
      }
      const renamePromise = fsp.rename(tmp, this.file).then(() => {
        fsyncDirSync(this.remoteDir);
      });
      this.renameInFlight = renamePromise;
      try {
        await renamePromise;
      } finally {
        if (this.renameInFlight === renamePromise) this.renameInFlight = null;
      }
    });
    // Settles rather than rejects, so a failed flush can never wedge a later
    // revoke or flush waiting on `writing`.
    const settled: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    this.writing = settled;
    await run;
  }
}

function isPlausibleRecord(value: unknown): value is PairedDeviceRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PairedDeviceRecord>;
  if (typeof candidate.publicKey !== "string") return false;
  const decoded = Buffer.from(candidate.publicKey, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== candidate.publicKey) return false;
  if (typeof candidate.name !== "string") return false;
  if (typeof candidate.addedAt !== "number") return false;
  return candidate.lastSeenAt === null || typeof candidate.lastSeenAt === "number";
}

// Device names render in the Settings list and in logs; strip control
// characters so a hostile name can never smuggle escape sequences there.
export function sanitizeDeviceName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_DEVICE_NAME_CHARS);
  return clean.length > 0 ? clean : "Unnamed device";
}

/* -------------------------------------------------------------------------- */
/* Pairing window                                                             */
/* -------------------------------------------------------------------------- */

// One open pairing opportunity: a secret that is minted when the modal
// opens and dies on first use, on expiry, or when the modal closes -
// whichever comes first. The secret itself never leaves this object except
// inside the QR payload string; consume() only ever answers yes or no.
export class PairingWindow {
  private readonly secret: Buffer;
  readonly createdAt: number;
  readonly expiresAt: number;
  private used = false;

  constructor(now = Date.now(), ttlMs = PAIRING_TTL_MS) {
    this.secret = randomBytes(PAIRING_SECRET_BYTES);
    this.createdAt = now;
    this.expiresAt = now + ttlMs;
  }

  secretB64(): string {
    return this.secret.toString("base64");
  }

  isExpired(now = Date.now()): boolean {
    return now >= this.expiresAt;
  }

  isUsed(): boolean {
    return this.used;
  }

  // Single-use, constant-time verification. A correct proof consumes the
  // window even if the caller later fails to persist the device, so a
  // network race can never redeem one secret twice.
  consume(proof: Buffer | Uint8Array, now = Date.now()): boolean {
    if (this.used || this.isExpired(now)) return false;
    const candidate = Buffer.from(proof);
    if (candidate.length !== this.secret.length) return false;
    if (!timingSafeEqual(candidate, this.secret)) return false;
    this.used = true;
    return true;
  }
}

/* -------------------------------------------------------------------------- */
/* QR payload                                                                 */
/* -------------------------------------------------------------------------- */

export interface QrPayloadInput {
  publicKeyB64: string;
  addrs: string[];
  port: number;
  window: PairingWindow;
  // Computer display name shown on the phone during pairing.
  name?: string;
  now?: number;
}

// Builds the exact JSON string the phone parser accepts. Field order is not
// part of the contract but is kept stable anyway so two QR renders of one
// window are byte-identical.
export function buildQrPayloadString(input: QrPayloadInput): string {
  const name = input.name ? sanitizeDeviceName(input.name) : undefined;
  return JSON.stringify({
    v: 1,
    pk: input.publicKeyB64,
    addrs: input.addrs,
    port: input.port,
    secret: input.window.secretB64(),
    iat: input.now ?? Date.now(),
    ...(name ? { name } : {}),
  });
}

// LAN endpoints for the QR, in preference order: non-internal IPv4 first
// (phones dial these), loopback last as a same-machine fallback for the
// test client. Hostnames are deliberately not included; mDNS names resolve
// unreliably across phone platforms.
export function lanAddresses(): string[] {
  const addrs: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family !== "IPv4" && (entry.family as unknown) !== 4) continue;
      // Only advertise addresses pairing will actually accept a peer from
      // (loopback, RFC1918 private, link-local). Advertising a public or
      // VPN-public interface would promise reachability the accept-side
      // address check then refuses, which is exactly the "same network"
      // claim we do not want to overstate.
      if (!isPrivateOrLocalAddress(entry.address)) continue;
      addrs.push(entry.address);
    }
  }
  addrs.push("127.0.0.1");
  return addrs;
}

// Whether a peer's remote address is one pairing may accept: IPv4 loopback,
// RFC1918 private, or link-local; IPv6 loopback, link-local (fe80::/10) or
// unique-local (fc00::/7). Everything else (public IPv4/IPv6, including a
// routable VPN address) is refused, so pairing cannot be driven from off the
// local network. IPv4-mapped IPv6 forms and zone ids are normalized first.
export function isPrivateOrLocalAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  let addr = address.trim().toLowerCase();
  if (addr.startsWith("::ffff:")) addr = addr.slice(7);
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  const dotted = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const octets = dotted.slice(1).map((part) => Number(part));
    if (octets.some((n) => n > 255)) return false;
    const [a, b] = octets;
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
    return false;
  }
  if (addr === "::1") return true; // IPv6 loopback
  if (/^fe[89ab]/.test(addr)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(addr)) return true; // fc00::/7 unique-local
  return false;
}

/* -------------------------------------------------------------------------- */
/* Pairing exchange frames                                                    */
/* -------------------------------------------------------------------------- */

// The single request/response pair spoken over the encrypted stream when an
// unknown key connects during an open pairing window. Framed with the same
// length-prefixed JSON as the versioned RPC transport (see rpc.ts). Documented in
// docs/remote-access.md; the phone transport implements the client half.
export interface PairRequestFrame {
  t: "pair";
  // Base64 of the QR secret, proving the sender saw this window's QR.
  secret: string;
  // The device's display name, e.g. "iPhone 17".
  name: string;
}

export interface PairResponseFrame {
  t: "paired";
  // The computer's display name, for the phone's paired-computer record.
  name: string;
}

export function parsePairRequestFrame(value: unknown): PairRequestFrame | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PairRequestFrame>;
  if (candidate.t !== "pair") return null;
  if (typeof candidate.secret !== "string" || candidate.secret.length === 0) return null;
  if (typeof candidate.name !== "string") return null;
  return { t: "pair", secret: candidate.secret, name: candidate.name };
}
