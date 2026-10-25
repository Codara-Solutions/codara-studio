import { createHash, createHmac } from "node:crypto";

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
// read before that is an error, one after it never read.
function keyListRevokes(text: string, key: Buffer): boolean {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").replace(/^[ \t]+/, "");
    if (!line || line.startsWith("#")) continue;
    const [type, b64] = line.split(/[ \t]+/);
    const blob = b64 ? Buffer.from(b64, "base64") : null;
    if (!KEY_TYPES.has(type) || !blob || blob.toString("base64") !== b64 || hostKeyType(blob) !== type) {
      throw new RevokedKeysFormatError("has a line ssh cannot read as a key");
    }
    if (blob.equals(key) || certifiedKey(blob)?.equals(key)) return true;
  }
  return false;
}

/** Public-key fields after the nonce in each certificate type (PROTOCOL.certkeys). */
const CERT_KEY_FIELDS: Record<string, number> = {
  "ssh-rsa": 2,
  "ssh-dss": 4,
  "ecdsa-sha2-nistp256": 2,
  "ecdsa-sha2-nistp384": 2,
  "ecdsa-sha2-nistp521": 2,
  "ssh-ed25519": 1,
  "sk-ecdsa-sha2-nistp256@openssh.com": 3,
  "sk-ssh-ed25519@openssh.com": 2,
};

/**
 * The plain key a certificate certifies, in the wire form ssh2 presents.
 * ssh compares a key list's certificate line by this key, not the whole
 * certificate.
 */
function certifiedKey(cert: Buffer): Buffer | null {
  const certType = hostKeyType(cert);
  if (!certType.endsWith("-cert-v01@openssh.com")) return null;
  // `sk-ssh-ed25519-cert-v01@openssh.com` certifies `sk-ssh-ed25519@openssh.com`.
  const base = certType.slice(0, -"-cert-v01@openssh.com".length);
  const plainType = base.startsWith("sk-") ? `${base}@openssh.com` : base;
  const fields = CERT_KEY_FIELDS[plainType];
  if (!fields) return null;
  const reader = new WireReader(cert);
  reader.string();
  reader.string();
  const start = reader.position();
  for (let i = 0; i < fields; i++) reader.string();
  const typeName = Buffer.from(plainType, "latin1");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(typeName.length);
  return Buffer.concat([head, typeName, cert.subarray(start, reader.position())]);
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
  constructor(private readonly data: Buffer) {}

  done(): boolean {
    return this.offset >= this.data.length;
  }

  position(): number {
    return this.offset;
  }

  skip(length: number): void {
    if (this.offset + length > this.data.length) throw new RevokedKeysFormatError("is a truncated KRL");
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
}
