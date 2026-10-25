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
  | { kind: "none" }
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
 * over everything; `@cert-authority` lines are not host keys and are skipped.
 * `host` is hashed as given: callers lowercase a hostname, never an alias.
 */
export function knownHostsVerdict(text: string, host: string, port: number, key: Buffer): KnownHostsVerdict {
  const wanted = key.toString("base64");
  const type = hostKeyType(key);
  let matched = false;
  let sameType: Buffer | null = null;
  let otherType: Buffer | null = null;
  for (const entry of hostEntries(text, host, port)) {
    if (entry.blob === wanted) {
      if (entry.revoked) return { kind: "revoked" };
      matched = true;
    } else if (!entry.revoked) {
      const listed = Buffer.from(entry.blob, "base64");
      if (hostKeyType(listed) === type) sameType ??= listed;
      else otherType ??= listed;
    }
  }
  if (matched) return { kind: "match" };
  const listedKey = sameType ?? otherType;
  return listedKey ? { kind: "mismatch", listedKey } : { kind: "none" };
}

/** The key types known_hosts lists for this host, in file order. */
export function knownHostTypes(text: string, host: string, port: number): string[] {
  const types: string[] = [];
  for (const entry of hostEntries(text, host, port)) {
    if (entry.revoked) continue;
    const type = hostKeyType(Buffer.from(entry.blob, "base64"));
    if (type !== "unknown" && !types.includes(type)) types.push(type);
  }
  return types;
}

// ssh2's own preference order (lib/protocol/constants.js), which an exact
// list replaces: its `prepend` skips algorithms already in the list.
const SERVER_HOST_KEY_ALGORITHMS = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "rsa-sha2-512",
  "rsa-sha2-256",
  "ssh-rsa",
];

/**
 * ssh2's `algorithms.serverHostKey` with the listed key types first, so a
 * server offers a key known_hosts can vouch for. As OpenSSH does, the listed
 * ones keep the default order among themselves: which line of the file came
 * first never changes the key negotiated.
 */
export function hostKeyAlgorithms(listedTypes: readonly string[]): string[] {
  const listed = (algorithm: string) => listedTypes.includes(algorithm.startsWith("rsa-sha2-") ? "ssh-rsa" : algorithm);
  return [
    ...SERVER_HOST_KEY_ALGORITHMS.filter(listed),
    ...SERVER_HOST_KEY_ALGORITHMS.filter((algorithm) => !listed(algorithm)),
  ];
}

function* hostEntries(text: string, host: string, port: number): Generator<{ blob: string; revoked: boolean }> {
  const name = port === 22 ? host : `[${host}]:${port}`;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    let marker: string | null = null;
    if (fields[0].startsWith("@")) marker = fields.shift() ?? null;
    if (marker === "@cert-authority" || fields.length < 3) continue;
    const [patterns, , blob] = fields;
    if (hostPatternsMatch(patterns, name)) yield { blob, revoked: marker === "@revoked" };
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
