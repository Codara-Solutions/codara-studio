import { createHash, createHmac, createPublicKey, verify, type KeyObject } from "node:crypto";

// Host keys a connection meets for the first time. Studio keeps its own
// fingerprints (connections.ts, spark-known-hosts.json); before trusting a
// new one it looks in the user's OpenSSH known_hosts, read only, so a machine
// the user already reaches with `ssh` connects without a question. Anything
// else is shown to the user to confirm.

/** `SHA256:<base64, no padding>`, the way `ssh-keygen -lf` and `ssh` print it. */
export function sshFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/** Studio's stored form: the padded base64 of the key's SHA-256. */
export function storedFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("base64");
}

/** Shows a stored fingerprint the way `sshFingerprint` does. */
export function displayFingerprint(stored: string): string {
  return stored.startsWith("SHA256:") ? stored : `SHA256:${stored.replace(/=+$/, "")}`;
}

/** The key's algorithm, read from the wire format (`ssh-ed25519`...). */
export function hostKeyType(key: Buffer): string {
  if (key.length < 4) return "unknown";
  const length = key.readUInt32BE(0);
  if (length <= 0 || length > 64 || key.length < 4 + length) return "unknown";
  return key.subarray(4, 4 + length).toString("latin1");
}

export type KnownHostsVerdict =
  | { kind: "match" }
  | { kind: "revoked" }
  /**
   * Nothing lists the host. `certAuthority`: a `@cert-authority` line covers
   * it, so ssh would have trusted a certificate this connection cannot check.
   */
  | { kind: "none"; certAuthority?: true }
  /**
   * The host is listed, but never with this key: OpenSSH refuses another key
   * of a listed type as changed, and a key of an unlisted type is how a man
   * in the middle would dodge that, so it is a change too.
   */
  | { kind: "mismatch"; listedKey: Buffer };

/**
 * Whether known_hosts text lists `key` for this host. `[host]:port` entries
 * apply to other ports, plain ones to 22; hashed names (`|1|salt|hash`) and
 * `*` / `?` patterns match as OpenSSH matches them. A `@revoked` key wins
 * over everything; `@cert-authority` lines are not host keys, and a marker
 * OpenSSH does not know makes it skip the line, as here.
 * `host` is hashed as given: callers lowercase it first, as OpenSSH does
 * for a host name and a HostKeyAlias alike.
 */
export function knownHostsVerdict(text: string, host: string, port: number, key: Buffer): KnownHostsVerdict {
  const wanted = key.toString("base64");
  const type = hostKeyType(key);
  let matched = false;
  let certAuthority = false;
  let sameType: Buffer | null = null;
  let otherType: Buffer | null = null;
  for (const entry of hostEntries(text, host, port)) {
    if (entry.marker === "@cert-authority") {
      certAuthority = true;
    } else if (entry.blob === wanted) {
      if (entry.marker === "@revoked") return { kind: "revoked" };
      matched = true;
    } else if (entry.marker === null) {
      const listed = Buffer.from(entry.blob, "base64");
      if (hostKeyType(listed) === type) sameType ??= listed;
      else otherType ??= listed;
    }
  }
  if (matched) return { kind: "match" };
  const listedKey = sameType ?? otherType;
  if (listedKey) return { kind: "mismatch", listedKey };
  return certAuthority ? { kind: "none", certAuthority: true } : { kind: "none" };
}

/** The key types known_hosts lists for this host, in file order. */
export function knownHostTypes(text: string, host: string, port: number): string[] {
  const types: string[] = [];
  for (const entry of hostEntries(text, host, port)) {
    if (entry.marker !== null) continue;
    const type = hostKeyType(Buffer.from(entry.blob, "base64"));
    if (type !== "unknown" && !types.includes(type)) types.push(type);
  }
  return types;
}

/**
 * ssh2's `algorithms.serverHostKey`: `available` (ssh2's own default list,
 * which an exact list replaces, since its `prepend` skips algorithms already
 * in the list) with the listed key types first, so a server offers a key
 * known_hosts can vouch for. As OpenSSH does, the listed ones keep the
 * default order among themselves: which line of the file came first never
 * changes the key negotiated.
 */
export function hostKeyAlgorithms(listedTypes: readonly string[], available: readonly string[]): string[] {
  const listed = (algorithm: string) => listedTypes.includes(algorithm.startsWith("rsa-sha2-") ? "ssh-rsa" : algorithm);
  return [...available.filter(listed), ...available.filter((algorithm) => !listed(algorithm))];
}

type HostEntry = { blob: string; marker: "@revoked" | "@cert-authority" | null };

function* hostEntries(text: string, host: string, port: number): Generator<HostEntry> {
  const name = port === 22 ? host : `[${host}]:${port}`;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    let marker: HostEntry["marker"] = null;
    if (fields[0].startsWith("@")) {
      const word = fields.shift();
      if (word !== "@revoked" && word !== "@cert-authority") continue;
      marker = word;
    }
    if (fields.length < 3) continue;
    const [patterns, , blob] = fields;
    if (hostPatternsMatch(patterns, name)) yield { blob, marker };
  }
}

function hostPatternsMatch(patterns: string, name: string): boolean {
  if (patterns.startsWith("|1|")) {
    const [, , salt, hash] = patterns.split("|");
    if (!salt || !hash) return false;
    const digest = createHmac("sha1", Buffer.from(salt, "base64")).update(name).digest("base64");
    return digest === hash;
  }
  let matched = false;
  const lowered = name.toLowerCase();
  for (const pattern of patterns.split(",")) {
    const negated = pattern.startsWith("!");
    const body = (negated ? pattern.slice(1) : pattern).toLowerCase();
    if (!globMatch(body, lowered)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

function globMatch(pattern: string, value: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(value);
}

// ── RevokedHostKeys ──────────────────────────────────────────────────────────
//
// The file is a KRL (ssh-keygen -k) or a list of public keys, one per line.
// ssh refuses to connect when it cannot read either, so this throws and the
// caller refuses too.

export class RevokedKeysFormatError extends Error {}

const KRL_MAGIC = Buffer.from("SSHKRL\n\0", "latin1");
const KEY_TYPES = new Set(
  [
    "ssh-ed25519",
    "sk-ssh-ed25519@openssh.com",
    "ssh-rsa",
    "ssh-dss",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ecdsa-sha2-nistp256@openssh.com",
  ].flatMap((type) => [type, type.replace(/(@openssh\.com)?$/, "-cert-v01@openssh.com")]),
);

/** Whether a RevokedHostKeys file revokes `key` (a plain key, as ssh2 presents it). */
export function revokedByFile(data: Buffer, key: Buffer): boolean {
  if (data.subarray(0, KRL_MAGIC.length).equals(KRL_MAGIC)) return krlRevokes(data, key);
  return keyListRevokes(data.toString("utf8"), key);
}

// ssh reads line by line and stops at the first match: a line it cannot
// read before that is an error, one after it never read. It reads a line in
// full (sshkey_from_blob): a point off its curve, a key of the wrong size,
// trailing bytes or a certificate whose signature fails make the whole file
// an error, so every host is refused, not only the ones the line names.
function keyListRevokes(text: string, key: Buffer): boolean {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "").replace(/^[ \t]+/, "");
    if (!line || line.startsWith("#")) continue;
    const unreadable = (reason?: string) =>
      new RevokedKeysFormatError(`has a line ssh cannot read as a key (line ${i + 1}${reason ? `: ${reason}` : ""})`);
    const [type, b64] = line.split(/[ \t]+/);
    const blob = b64 ? Buffer.from(b64, "base64") : null;
    if (!KEY_TYPES.has(type) || !blob || blob.toString("base64") !== b64 || hostKeyType(blob) !== type) {
      throw unreadable();
    }
    let plain: Buffer;
    try {
      plain = readKeyLine(blob);
    } catch (err) {
      if (err instanceof RevokedKeysFormatError) throw unreadable(err.message.replace(/^(has|is) /, ""));
      throw err;
    }
    if (blob.equals(key) || plain.equals(key)) return true;
  }
  return false;
}

const CERT_SUFFIX = "-cert-v01@openssh.com";
const CURVES: Record<string, { name: string; jwk: string; bytes: number; hash: string }> = {
  "ecdsa-sha2-nistp256": { name: "nistp256", jwk: "P-256", bytes: 32, hash: "sha256" },
  "ecdsa-sha2-nistp384": { name: "nistp384", jwk: "P-384", bytes: 48, hash: "sha384" },
  "ecdsa-sha2-nistp521": { name: "nistp521", jwk: "P-521", bytes: 66, hash: "sha512" },
  "sk-ecdsa-sha2-nistp256@openssh.com": { name: "nistp256", jwk: "P-256", bytes: 32, hash: "sha256" },
};
const MAX_PRINCIPALS = 256;
const TRUNCATED_KEY = "is cut short";

/** A plain public key as ssh reads it, with what checking its signatures needs. */
interface PlainKey {
  type: string;
  /** null where Codara does not check signatures (DSA). */
  verifier: KeyObject | null;
  curve?: (typeof CURVES)[string];
  application?: Buffer;
  rsaBytes?: number;
}

/**
 * Reads a key list line's blob as sshkey_from_blob does, throwing
 * RevokedKeysFormatError where ssh fails. Returns the plain key it stands
 * for: itself, or for a certificate the key it certifies, which is what ssh
 * compares it by.
 */
function readKeyLine(blob: Buffer): Buffer {
  const reader = new WireReader(blob, TRUNCATED_KEY);
  const type = reader.string().toString("latin1");
  if (!type.endsWith(CERT_SUFFIX)) {
    readPlainKey(type, reader);
    reader.end();
    return blob;
  }
  // `sk-ssh-ed25519-cert-v01@openssh.com` certifies `sk-ssh-ed25519@openssh.com`.
  const base = type.slice(0, -CERT_SUFFIX.length);
  const plainType = base.startsWith("sk-") ? `${base}@openssh.com` : base;
  reader.string();
  const keyStart = reader.position();
  readPlainKey(plainType, reader);
  const keyEnd = reader.position();
  reader.skip(8);
  const certType = reader.uint32();
  if (certType !== 1 && certType !== 2) throw new RevokedKeysFormatError("has a certificate of an unknown type");
  cString(reader.string());
  const principals = new WireReader(reader.string(), TRUNCATED_KEY);
  for (let count = 0; !principals.done(); count++) {
    if (count >= MAX_PRINCIPALS) throw new RevokedKeysFormatError("has a certificate with too many principals");
    cString(principals.string());
  }
  reader.skip(16);
  for (let i = 0; i < 2; i++) {
    const options = new WireReader(reader.string(), TRUNCATED_KEY);
    while (!options.done()) {
      options.string();
      options.string();
    }
  }
  reader.string();
  const caReader = new WireReader(reader.string(), TRUNCATED_KEY);
  const caType = caReader.string().toString("latin1");
  if (caType.endsWith(CERT_SUFFIX)) throw new RevokedKeysFormatError("has a certificate signed by a certificate");
  const ca = readPlainKey(caType, caReader);
  caReader.end();
  const signedLength = reader.position();
  const signature = reader.string();
  reader.end();
  checkSignature(ca, signature, blob.subarray(0, signedLength));
  const head = Buffer.alloc(4);
  const name = Buffer.from(plainType, "latin1");
  head.writeUInt32BE(name.length);
  return Buffer.concat([head, name, blob.subarray(keyStart, keyEnd)]);
}

function cString(value: Buffer): string {
  if (value.includes(0)) throw new RevokedKeysFormatError("has a certificate string with a NUL byte");
  return value.toString("utf8");
}

/** An mpint ssh accepts: never negative, at most 16384 bits. Returns its bytes without leading zeros. */
function mpint(value: Buffer): Buffer {
  if (value.length > 0 && value[0] & 0x80) throw new RevokedKeysFormatError("has a negative number");
  if (value.length > 2049 || (value.length === 2049 && value[0] !== 0)) {
    throw new RevokedKeysFormatError("has a number too large");
  }
  let start = 0;
  while (start < value.length && value[start] === 0) start++;
  return value.subarray(start);
}

function readPlainKey(type: string, reader: WireReader): PlainKey {
  const curve = CURVES[type];
  switch (type) {
    case "ssh-ed25519":
    case "sk-ssh-ed25519@openssh.com": {
      const pk = reader.string();
      if (pk.length !== 32) throw new RevokedKeysFormatError("has an Ed25519 key of the wrong size");
      const verifier = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pk.toString("base64url") }, format: "jwk" });
      if (type === "ssh-ed25519") return { type, verifier };
      return { type, verifier, application: Buffer.from(cString(reader.string()), "utf8") };
    }
    case "ecdsa-sha2-nistp256":
    case "ecdsa-sha2-nistp384":
    case "ecdsa-sha2-nistp521":
    case "sk-ecdsa-sha2-nistp256@openssh.com": {
      if (reader.string().toString("latin1") !== curve.name) {
        throw new RevokedKeysFormatError("has an elliptic curve that does not match its type");
      }
      const point = reader.string();
      if (point.length !== 1 + 2 * curve.bytes || point[0] !== 4) {
        throw new RevokedKeysFormatError("has an elliptic curve point ssh does not read");
      }
      let verifier: KeyObject;
      try {
        verifier = createPublicKey({
          key: {
            kty: "EC",
            crv: curve.jwk,
            x: point.subarray(1, 1 + curve.bytes).toString("base64url"),
            y: point.subarray(1 + curve.bytes).toString("base64url"),
          },
          format: "jwk",
        });
      } catch {
        throw new RevokedKeysFormatError("has a point that is not on its elliptic curve");
      }
      if (!type.startsWith("sk-")) return { type, verifier, curve };
      return { type, verifier, curve, application: Buffer.from(cString(reader.string()), "utf8") };
    }
    case "ssh-rsa": {
      const e = mpint(reader.string());
      const n = mpint(reader.string());
      if (e.length === 0 || n.length === 0) throw new RevokedKeysFormatError("has an RSA key ssh does not read");
      const verifier = createPublicKey({
        key: { kty: "RSA", n: n.toString("base64url"), e: e.toString("base64url") },
        format: "jwk",
      });
      return { type, verifier, rsaBytes: n.length };
    }
    case "ssh-dss":
      for (let i = 0; i < 4; i++) mpint(reader.string());
      return { type, verifier: null };
    default:
      throw new RevokedKeysFormatError("has a key type ssh does not read");
  }
}

const RSA_SIGNATURES: Record<string, string> = { "ssh-rsa": "sha1", "rsa-sha2-256": "sha256", "rsa-sha2-512": "sha512" };

/** sshkey_verify for a certificate's CA signature over `data`. */
function checkSignature(ca: PlainKey, signature: Buffer, data: Buffer): void {
  const reader = new WireReader(signature, TRUNCATED_KEY);
  const type = reader.string().toString("latin1");
  const sig = reader.string();
  let valid: boolean;
  if (ca.type === "ssh-rsa") {
    const hash = RSA_SIGNATURES[type];
    if (!hash || !ca.rsaBytes || sig.length > ca.rsaBytes) throw new RevokedKeysFormatError("has a certificate signature ssh does not read");
    reader.end();
    const padded = Buffer.concat([Buffer.alloc(ca.rsaBytes - sig.length), sig]);
    valid = verify(hash, data, ca.verifier as KeyObject, padded);
  } else {
    if (type !== ca.type) throw new RevokedKeysFormatError("has a certificate signature of another type");
    let message = data;
    if (ca.application) {
      // FIDO keys sign sha256(application) || flags || counter || sha256(data).
      const flags = reader.byte();
      const counter = reader.uint32();
      const tail = Buffer.alloc(5);
      tail[0] = flags;
      tail.writeUInt32BE(counter, 1);
      const digest = (b: Buffer) => createHash("sha256").update(b).digest();
      message = Buffer.concat([digest(ca.application), tail, digest(data)]);
    }
    reader.end();
    if (ca.verifier === null) return;
    if (ca.curve) {
      const parts = new WireReader(sig, TRUNCATED_KEY);
      const r = mpint(parts.string());
      const s = mpint(parts.string());
      parts.end();
      const size = ca.curve.bytes;
      if (r.length > size || s.length > size) throw new RevokedKeysFormatError("has a certificate signature ssh does not read");
      const joined = Buffer.concat([Buffer.alloc(size - r.length), r, Buffer.alloc(size - s.length), s]);
      valid = verify(ca.curve.hash, message, { key: ca.verifier, dsaEncoding: "ieee-p1363" }, joined);
    } else {
      if (sig.length !== 64) throw new RevokedKeysFormatError("has a certificate signature ssh does not read");
      valid = verify(null, message, ca.verifier, sig);
    }
  }
  if (!valid) throw new RevokedKeysFormatError("has a certificate whose signature is wrong");
}

const KRL_CERTIFICATES = 1;
const KRL_EXPLICIT_KEY = 2;
const KRL_FINGERPRINT_SHA1 = 3;
const KRL_SIGNATURE = 4;
const KRL_FINGERPRINT_SHA256 = 5;
const KRL_EXTENSION = 255;
const KRL_CERT_SERIAL_LIST = 0x20;
const KRL_CERT_KEY_ID = 0x23;
const KRL_CERT_EXTENSION = 0x39;

// PROTOCOL.krl, as the ssh 9.6 client reads it (checked against a real
// sshd). Certificate sections cannot revoke the plain keys ssh2 presents, but
// are still read: anything ssh fails to load must fail here too.
function krlRevokes(data: Buffer, key: Buffer): boolean {
  const krl = new WireReader(data.subarray(KRL_MAGIC.length));
  if (krl.uint32() !== 1) throw new RevokedKeysFormatError("is a KRL of a format ssh does not read");
  krl.skip(8 * 3);
  krl.string();
  krl.string();
  const sha1 = createHash("sha1").update(key).digest();
  const sha256 = createHash("sha256").update(key).digest();
  let revoked = false;
  while (!krl.done()) {
    const type = krl.byte();
    if (type === KRL_SIGNATURE) {
      // Its body is two strings, key and signature; ssh 9.6 loads the KRL
      // without checking it.
      krl.string();
      krl.string();
      continue;
    }
    const section = new WireReader(krl.string());
    switch (type) {
      case KRL_CERTIFICATES:
        readCertificateSection(section);
        break;
      case KRL_EXPLICIT_KEY:
        while (!section.done()) if (section.string().equals(key)) revoked = true;
        break;
      case KRL_FINGERPRINT_SHA1:
      case KRL_FINGERPRINT_SHA256: {
        const wanted = type === KRL_FINGERPRINT_SHA1 ? sha1 : sha256;
        while (!section.done()) {
          const hash = section.string();
          if (hash.length !== wanted.length) throw new RevokedKeysFormatError("has a KRL hash of the wrong length");
          if (hash.equals(wanted)) revoked = true;
        }
        break;
      }
      case KRL_EXTENSION:
        readExtension(section);
        break;
      default:
        throw new RevokedKeysFormatError("has a KRL section ssh does not read");
    }
  }
  return revoked;
}

function readCertificateSection(section: WireReader): void {
  section.string();
  section.string();
  while (!section.done()) {
    const type = section.byte();
    const body = new WireReader(section.string());
    if (type === KRL_CERT_EXTENSION) readExtension(body);
    else if (type < KRL_CERT_SERIAL_LIST || type > KRL_CERT_KEY_ID) {
      throw new RevokedKeysFormatError("has a KRL certificate section ssh does not read");
    }
  }
}

function readExtension(section: WireReader): void {
  section.string();
  const critical = section.byte() !== 0;
  section.string();
  if (critical) throw new RevokedKeysFormatError("has a critical KRL extension ssh does not know");
}

class WireReader {
  private offset = 0;
  constructor(
    private readonly data: Buffer,
    private readonly truncated = "is a truncated KRL",
  ) {}

  done(): boolean {
    return this.offset >= this.data.length;
  }

  position(): number {
    return this.offset;
  }

  skip(length: number): void {
    if (this.offset + length > this.data.length) throw new RevokedKeysFormatError(this.truncated);
    this.offset += length;
  }

  byte(): number {
    this.skip(1);
    return this.data[this.offset - 1];
  }

  uint32(): number {
    this.skip(4);
    return this.data.readUInt32BE(this.offset - 4);
  }

  string(): Buffer {
    const length = this.uint32();
    this.skip(length);
    return this.data.subarray(this.offset - length, this.offset);
  }

  /** ssh refuses trailing bytes after a key or signature. */
  end(): void {
    if (!this.done()) throw new RevokedKeysFormatError("has trailing data");
  }
}
