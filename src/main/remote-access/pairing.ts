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
import { chmodSync, promises as fsp, readFileSync, renameSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { RemotePairedDevice } from "@shared/remote-access";
import { ensureRemoteDir, shortKey } from "./identity";

export const PAIRING_TTL_MS = 2 * 60 * 1000;
export const PAIRING_SECRET_BYTES = 32;
export const PAIRED_DEVICES_FILE = "paired-devices.json";
// Matches the phone parser's cap on the optional display name.
const MAX_DEVICE_NAME_CHARS = 64;
// How long last-seen updates coalesce before one async write. Long enough
// that a reconnect storm collapses into a single flush.
const LAST_SEEN_FLUSH_DELAY_MS = 5_000;
// How long a revoke will wait for an in-flight cosmetic flush to land before
// writing anyway. Only ever reached if the filesystem is pathologically
// slow; a revoke must not hang the UI regardless.
const REVOKE_FLUSH_WAIT_MS = 2_000;

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
  // The last-seen flush whose fs work is currently in the air, or null.
  // revokeDevice awaits this so its own write is provably the last one.
  private flushInFlight: Promise<void> | null = null;

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
  // trust file is outstanding, so a crash at any instant from then on cannot
  // bring the device back. Getting there means ordering this write strictly
  // after any last-seen flush that is already in the air, since that flush
  // may have been carrying the pre-revoke set toward a rename.
  async revokeDevice(publicKeyB64: string): Promise<boolean> {
    const devices = this.list();
    const next = devices.filter((device) => device.publicKey !== publicKeyB64);
    if (next.length === devices.length) return false;

    // Synchronous half: memory stops trusting the device immediately, the
    // generation bump tells an in-flight flush it is stale (so in the usual
    // interleaving it abandons its staging file rather than renaming it),
    // and the pending timer is cancelled so no NEW flush can start.
    this.cache = next;
    this.generation += 1;
    if (this.lastSeenFlushTimer) {
      clearTimeout(this.lastSeenFlushTimer);
      this.lastSeenFlushTimer = null;
    }

    // Let any already-dispatched flush finish before we write, so its rename
    // can never land after ours. Bounded so a pathological fs cannot block a
    // revoke indefinitely; if the bound is hit we write anyway and the
    // flush's own post-rename check is the backstop.
    if (this.flushInFlight) {
      await withWriteTimeout(this.flushInFlight, REVOKE_FLUSH_WAIT_MS);
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
    // Unique tmp name: the async flush must never be able to collide with
    // this write's staging file.
    const tmp = `${this.file}.${process.pid}.${(tmpCounter += 1)}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Windows: no POSIX modes.
    }
    renameSync(tmp, this.file);
  }

  // Async twin of save() for the cosmetic last-seen flush, serialized behind
  // `writing` so two flushes cannot interleave their renames.
  //
  // This write is NEVER allowed to be the last word. A revoke is the
  // security boundary of the whole feature, and it is synchronous, so a
  // flush that was already in flight when the revoke landed must not put the
  // revoked device back on disk. Three windows exist and all three are shut:
  //
  //   1. Superseded BEFORE the write starts. The payload is read from
  //      this.list() at execution time rather than captured at scheduling
  //      time, so it already reflects the revoke.
  //   2. Superseded DURING the write. The generation is re-checked just
  //      before the rename; a stale flush abandons its staging file instead
  //      of publishing it.
  //   3. Superseded DURING the rename itself, which is the only window the
  //      first two cannot see because the rename is already on the
  //      threadpool when the synchronous write runs. Here the rename may
  //      genuinely have clobbered the authoritative file, so we re-assert
  //      the truth with a synchronous write of the current state.
  private async saveAsync(): Promise<void> {
    const run = this.writing.then(async () => {
      const generation = this.generation;
      const devices = this.list();
      ensureRemoteDir(this.remoteDir);
      const payload: DevicesFileShape = { version: 1, devices };
      const tmp = `${this.file}.${process.pid}.${(tmpCounter += 1)}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      try {
        await fsp.chmod(tmp, 0o600);
      } catch {
        // Windows: no POSIX modes.
      }
      // Superseded before we publish: drop the staging file rather than
      // rename it. This is the path that normally fires when a revoke races
      // us, and it means no clobber happens at all.
      if (this.generation !== generation) {
        await fsp.unlink(tmp).catch(() => undefined);
        return;
      }
      await fsp.rename(tmp, this.file);
      // Backstop only. An authoritative write now waits for this flush
      // before writing (see revokeDevice), so it should not be able to
      // supersede us between the check above and this line. If that ever
      // happens anyway (the revoke's bounded wait expired), the rename just
      // published stale content and the repair below is the last defence.
      // It is deliberately loud: a silently failed durable revoke is the
      // worst outcome this file can produce.
      if (this.generation !== generation) {
        try {
          this.writeSync(this.list());
        } catch (err) {
          this.log(
            `URGENT: could not re-assert the paired-device list after a superseded flush; a revoked device may still be on disk: ${(err as Error).message}`,
          );
          throw err;
        }
      }
    });
    // Tracked separately from `writing` so an authoritative write can await
    // exactly the fs work that is in the air. Settles rather than rejects,
    // so a failed flush can never wedge a later revoke.
    const settled: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    this.writing = settled;
    this.flushInFlight = settled;
    void settled.then(() => {
      // Only clear if no newer flush has taken the slot.
      if (this.flushInFlight === settled) this.flushInFlight = null;
    });
    await run;
  }
}

// Process-wide counter for unique staging file names, so a synchronous
// authoritative write and an in-flight async flush can never share a tmp
// path.
let tmpCounter = 0;

// Resolves when `promise` settles or the bound elapses, whichever is first.
// Never rejects: the caller's next step must run either way.
function withWriteTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    void promise.then(finish, finish);
  });
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
function sanitizeDeviceName(name: string): string {
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
      addrs.push(entry.address);
    }
  }
  addrs.push("127.0.0.1");
  return addrs;
}

/* -------------------------------------------------------------------------- */
/* Pairing exchange frames                                                    */
/* -------------------------------------------------------------------------- */

// The single request/response pair spoken over the encrypted stream when an
// unknown key connects during an open pairing window. Framed with the same
// length-prefixed JSON as RPC v0 (see rpc.ts). Documented in
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
