// What leaves the computer in a diagnostics export goes through here first:
// no tokens or keys, no email addresses, and no home folder paths (the user
// name is in them). The rules are deliberately greedy; a log line that loses
// a harmless id is a better outcome than a bundle that carries a secret.
//
// Git commit hashes (40 or 64 lowercase hex characters) are kept: they name
// versions and are not secrets.

export interface RedactionContext {
  /** The user's home folders, as Codara saw them (os.homedir(), its real path). */
  homeDirs: string[];
}

export const REDACTED = "[redacted]";
export const REDACTED_EMAIL = "[email]";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every spelling a home folder takes in logs: as is, with / or \, JSON-escaped,
 * URL-encoded as a path and as a query value.
 */
function homeSpellings(home: string): string[] {
  const trimmed = home.replace(/[\\/]+$/, "");
  if (trimmed.length < 2) return [];
  const forward = trimmed.replace(/\\/g, "/");
  const back = trimmed.replace(/\//g, "\\");
  const spellings = new Set([
    trimmed,
    forward,
    back,
    back.replace(/\\/g, "\\\\"),
    encodeURI(forward),
    encodeURIComponent(forward),
  ]);
  return [...spellings].filter((value) => value.length >= 2).sort((a, b) => b.length - a.length);
}

// Compiled once per context: redactJson calls redactText for every string.
const compiledHomePatterns = new WeakMap<RedactionContext, RegExp[]>();

function homePatterns(ctx: RedactionContext): RegExp[] {
  const cached = compiledHomePatterns.get(ctx);
  if (cached) return cached;
  const spellings = new Set<string>();
  for (const home of ctx.homeDirs) for (const spelling of homeSpellings(home)) spellings.add(spelling);
  const patterns = [...spellings]
    .sort((a, b) => b.length - a.length)
    // A home path ends anywhere but mid-name: /home/ann must not eat the
    // start of /home/anne, and /home/ann. or /home/ann&x=1 still lose it.
    .map((spelling) => new RegExp(`${escapeRegExp(spelling)}(?![A-Za-z0-9_-])`, "gi"));
  compiledHomePatterns.set(ctx, patterns);
  return patterns;
}

// Shapes of credentials that are recognizable on their own.
const TOKEN_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-(?:or-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bxai-[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
];

// The name prefix and the URL scheme below are bounded: an unbounded run,
// tried again at every word boundary of a long dotted or dashed string, makes
// redaction quadratic, and the export runs on the main thread (400 KB of
// "a.a.a." took a minute).
const SENSITIVE_NAME =
  "[A-Za-z0-9_.-]{0,64}?(?:token|secret|password|passwd|passphrase|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth|authorization|cookie|session[_-]?id|credentials?|signature)";

const RULES: Array<[RegExp, string]> = [
  // https://user:password@host
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:"'<>]+(?::[^\s/@"'<>]*)?@/gi, `$1${REDACTED}@`],
  // Authorization: Bearer abc, token abc
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  // ?access_token=abc&key=abc
  [
    /([?&#](?:access_token|refresh_token|id_token|token|key|api_key|apikey|secret|password|sig|signature|code|auth|client_secret)=)[^&#\s"'<>]+/gi,
    `$1${REDACTED}`,
  ],
  // --token abc, --api-key=abc
  [/(--?(?:token|api-key|apikey|password|secret|auth-token|access-token)(?:=|\s+))[^\s"']+/gi, `$1${REDACTED}`],
  // token=abc, "apiKey": "abc", password: abc
  [
    new RegExp(`(["']?)\\b(${SENSITIVE_NAME}s?)\\1(\\s*[:=]\\s*)(["']?)(?!${escapeRegExp(REDACTED)})[^"'\\s,;&}\\]]+`, "gi"),
    `$1$2$1$3$4${REDACTED}`,
  ],
];

const EMAIL = /(?<![A-Za-z0-9._%+-])(?!git@)[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

// Another user's home on this machine still names a person.
const OTHER_HOMES: Array<[RegExp, string]> = [
  [/(^|[^A-Za-z0-9_~.-])(\/(?:Users|home))\/(?!<user>)[^/\\\s"'`<>:;,)]+/g, "$1$2/<user>"],
  [/\b([A-Za-z]:)(\\\\|\\|\/)(Users|Documents and Settings)\2(?!<user>)[^\\/\s"'`<>:;,)]+/gi, "$1$2$3$2<user>"],
];

// A long run of letters and digits with no other meaning is most likely a
// key, a session id or a signed value.
const OPAQUE = /\b(?=[A-Za-z0-9_]*[0-9])(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}\b/g;
const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function redactText(text: string, ctx: RedactionContext): string {
  let out = String(text);
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED);
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  out = out.replace(EMAIL, REDACTED_EMAIL);
  for (const pattern of homePatterns(ctx)) out = out.replace(pattern, "~");
  for (const [pattern, replacement] of OTHER_HOMES) out = out.replace(pattern, replacement);
  out = out.replace(OPAQUE, (match) => (COMMIT_HASH.test(match) ? match : REDACTED));
  return out;
}

const SENSITIVE_WORDS = new Set([
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwords",
  "passwd",
  "passphrase",
  "key",
  "keys",
  "apikey",
  "auth",
  "authorization",
  "credential",
  "credentials",
  "cookie",
  "cookies",
  "bearer",
  "signature",
  "privatekey",
  "email",
  "emails",
]);

/** Splits camelCase, snake_case, kebab-case and dotted names into lowercase words. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

export function isSensitiveKey(name: string): boolean {
  const words = nameWords(name);
  if (words.some((word) => SENSITIVE_WORDS.has(word))) return true;
  return /(?:api|access|private|secret|session)key|accesstoken|refreshtoken/i.test(name.replace(/[^A-Za-z]/g, ""));
}

/**
 * A JSON value with every sensitive key's value replaced and every string run
 * through redactText. Booleans, numbers and empty values under a sensitive
 * key are kept: "requireAuth": true says nothing secret and helps debugging.
 */
export function redactJson(value: unknown, ctx: RedactionContext, key?: string): unknown {
  const sensitive = key !== undefined && isSensitiveKey(key);
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (sensitive && value.length > 0) return REDACTED;
    return redactText(value, ctx);
  }
  if (typeof value === "number") return sensitive && !/^(?:.*(?:count|length|size|at|ms))$/i.test(key ?? "") ? REDACTED : value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (sensitive && value.length > 0) return REDACTED;
    return value.map((item) => redactJson(item, ctx));
  }
  if (typeof value === "object") {
    if (sensitive) return REDACTED;
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      out[redactText(childKey, ctx)] = redactJson(child, ctx, childKey);
    }
    return out;
  }
  return null;
}
