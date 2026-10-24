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

export type KnownHostsVerdict = "match" | "revoked" | "none";

/**
 * Whether known_hosts text lists `key` for this host. `[host]:port` entries
 * apply to other ports, plain ones to 22; hashed names (`|1|salt|hash`) and
 * `*` / `?` patterns match as OpenSSH matches them. A `@revoked` key wins
 * over everything; `@cert-authority` lines are not host keys and are skipped.
 */
export function knownHostsVerdict(text: string, host: string, port: number, key: Buffer): KnownHostsVerdict {
  const name = port === 22 ? host.toLowerCase() : `[${host.toLowerCase()}]:${port}`;
  const wanted = key.toString("base64");
  let verdict: KnownHostsVerdict = "none";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    let marker: string | null = null;
    if (fields[0].startsWith("@")) marker = fields.shift() ?? null;
    if (marker === "@cert-authority" || fields.length < 3) continue;
    const [patterns, , blob] = fields;
    if (blob !== wanted || !hostPatternsMatch(patterns, name)) continue;
    if (marker === "@revoked") return "revoked";
    verdict = "match";
  }
  return verdict;
}

function hostPatternsMatch(patterns: string, name: string): boolean {
  if (patterns.startsWith("|1|")) {
    const [, , salt, hash] = patterns.split("|");
    if (!salt || !hash) return false;
    const digest = createHmac("sha1", Buffer.from(salt, "base64")).update(name).digest("base64");
    return digest === hash;
  }
  let matched = false;
  for (const pattern of patterns.split(",")) {
    const negated = pattern.startsWith("!");
    const body = (negated ? pattern.slice(1) : pattern).toLowerCase();
    if (!globMatch(body, name)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

function globMatch(pattern: string, value: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(value);
}
