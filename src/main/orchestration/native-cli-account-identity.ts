import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

/**
 * Account identity for native CLI sign-ins: an anonymous fingerprint, plus the
 * account's email address for display.
 *
 * Settings shows one card per account, so a Cora subscription connection and a
 * local CLI sign-in for the same human have to be recognisable as one account.
 * Pairing is done on an unsalted sha256 of the vendor account id, the same
 * digest Pi's account store records for its own connection (see
 * identityFingerprint in pi-account-auth-store.ts and the connect-time lookup
 * in anthropic-account-identity.ts). Equal digests mean the same vendor
 * account; the digest itself reveals nothing.
 *
 * The email is the one deliberate exception to "no account identity crosses
 * IPC": a card that says only "Work" cannot tell the user which login it is, so
 * the address the provider itself displays is shown under the card name. It is
 * a local-window value only; the remote projections in
 * src/main/remote-access strip it, so a paired phone never receives it.
 *
 * Codex CLI stores the ChatGPT account id it was issued (`tokens.account_id`),
 * which is exactly the id Pi stores as `accountId` for an openai-codex
 * credential. Claude Code stores the Anthropic account uuid it was issued
 * (`oauthAccount.accountUuid`), which is the same uuid Anthropic's OAuth
 * profile endpoint reports for a Cora connection. Grok Build writes a
 * keyed-by-issuer `auth.json` whose `user_id` (and the access token's `sub`)
 * is the same uuid Pi hashes from an xAI Cora credential. All three hash
 * into one id space per provider.
 *
 * Everything here is read-only. The credential and config files are opened for
 * reading, are never written, moved, refreshed, or copied, and only the
 * account-id and email fields are looked at. Any failure (missing file, wrong
 * permissions, unparseable JSON, API-key auth with no account id) yields
 * undefined rather than an error.
 */

/** What a sign-in can be identified by. Both fields are independently optional. */
export interface NativeCliAccountIdentity {
  /** sha256 of the vendor account id. Used only to pair two sign-ins. */
  fingerprint?: string;
  /** The address the provider shows for this account, for display only. */
  email?: string;
}

/** Credential files are a few kilobytes; refuse to read anything larger. */
export const NATIVE_CLI_CREDENTIAL_MAX_BYTES = 256 * 1024;

/**
 * Claude Code keeps per-project history in the same file as its account
 * metadata, so this one is routinely hundreds of kilobytes. The cap only has
 * to stop an unbounded read.
 */
export const CLAUDE_CLI_CONFIG_MAX_BYTES = 16 * 1024 * 1024;

/** RFC 5321 caps an address at 254 characters; anything longer is not one. */
export const ACCOUNT_EMAIL_MAX_LENGTH = 254;

// No whitespace, no control characters, exactly one @, and a dot in the
// domain. This is a display filter, not an address validator.
const ACCOUNT_EMAIL_PATTERN =
  /^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/;

/** A claims payload is well under this; the cap only stops unbounded decoding. */
const JWT_PAYLOAD_MAX_CHARS = 32 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function codexAccountIdFrom(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined;
  const tokens = parsed.tokens;
  const raw = isRecord(tokens) ? tokens.account_id : undefined;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * An address is only worth showing if it looks like the one the provider would
 * show. Anything else (a display name, an id, a padded blob, something with a
 * newline in it) is dropped rather than rendered.
 */
export function normalizeAccountEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim();
  if (email.length < 3 || email.length > ACCOUNT_EMAIL_MAX_LENGTH) return undefined;
  if (!ACCOUNT_EMAIL_PATTERN.test(email)) return undefined;
  return email;
}

/**
 * The `email` claim of a JWT, read without verifying the signature and without
 * keeping any other claim. Nothing here trusts the token: it is already a
 * credential this process was handed, the claim is used for display only, and
 * no authorization decision is made from it. The token itself never leaves this
 * function, and a malformed one yields undefined rather than throwing.
 */
function jwtPayload(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string") return undefined;
  const segments = token.split(".");
  if (segments.length !== 3) return undefined;
  const payload = segments[1];
  if (!payload || payload.length > JWT_PAYLOAD_MAX_CHARS) return undefined;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    if (decoded.length === 0) return undefined;
    const parsed = JSON.parse(decoded) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One named claim of a JWT, unverified. Used for the expiry and issue time
 * the mirror compares by and the account ids the codecs pair by; a missing
 * or malformed token yields undefined.
 */
export function jwtClaim(token: unknown, name: string): unknown {
  return jwtPayload(token)?.[name];
}

/** A numeric claim (`exp`, `iat`), or undefined when absent or not finite. */
export function jwtNumericClaim(token: unknown, name: string): number | undefined {
  const value = jwtClaim(token, name);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A non-empty string claim (`sub`, `email`), trimmed. */
export function jwtStringClaim(token: unknown, name: string): string | undefined {
  const value = jwtClaim(token, name);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function jwtEmailClaim(token: unknown): string | undefined {
  const parsed = jwtPayload(token);
  return parsed ? normalizeAccountEmail(parsed.email) : undefined;
}

/**
 * OpenID `sub` from a JWT, unsigned and display/pairing only. xAI access
 * tokens carry the vendor account id here; a malformed token yields undefined.
 */
export function jwtSubjectClaim(token: unknown): string | undefined {
  const parsed = jwtPayload(token);
  const raw = parsed?.sub;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

/**
 * Codex records the OpenID token it was issued alongside its access token, and
 * that token's `email` claim is the address ChatGPT shows for the account.
 */
function codexAccountEmailFrom(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined;
  const tokens = parsed.tokens;
  if (!isRecord(tokens)) return undefined;
  return jwtEmailClaim(tokens.id_token) ?? jwtEmailClaim(tokens.access_token);
}

function claudeAccountEmailFrom(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined;
  const account = parsed.oauthAccount;
  return isRecord(account) ? normalizeAccountEmail(account.emailAddress) : undefined;
}

function claudeAccountUuidFrom(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined;
  const account = parsed.oauthAccount;
  const raw = isRecord(account) ? account.accountUuid : undefined;
  return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}

export function nativeCliAccountFingerprint(accountId: string): string {
  return createHash("sha256").update(accountId).digest("hex");
}

/**
 * Anthropic reports its account uuid in canonical lowercase, but Claude Code
 * has at least one path that lowercases it defensively, so both sides of the
 * comparison normalise before hashing rather than trusting the casing they
 * were handed.
 */
export function anthropicAccountFingerprint(accountUuid: string): string {
  return nativeCliAccountFingerprint(accountUuid.trim().toLowerCase());
}

async function readJsonUnderCap(
  path: string,
  maxBytes: number,
): Promise<unknown> {
  const stats = await fs.lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > maxBytes) {
    return undefined;
  }
  return JSON.parse(await fs.readFile(path, "utf8")) as unknown;
}

/**
 * Digest of the ChatGPT account id and the account's email address from a Codex
 * CLI credential file, or an empty identity when there is nothing safe to read.
 * Never throws.
 */
export async function readCodexCliAccountIdentity(
  authFile: string,
): Promise<NativeCliAccountIdentity> {
  try {
    const parsed = await readJsonUnderCap(
      authFile,
      NATIVE_CLI_CREDENTIAL_MAX_BYTES,
    );
    const accountId = codexAccountIdFrom(parsed);
    const email = codexAccountEmailFrom(parsed);
    return {
      ...(accountId ? { fingerprint: nativeCliAccountFingerprint(accountId) } : {}),
      ...(email ? { email } : {}),
    };
  } catch {
    // A missing, unreadable, or malformed credential simply has no identity.
    // JSON.parse errors quote the surrounding text, so this catch also keeps
    // token bytes out of any error that could escape.
    return {};
  }
}

/** Fingerprint-only view of the above, kept for callers that pair accounts. */
export async function readCodexCliAccountFingerprint(
  authFile: string,
): Promise<string | undefined> {
  return (await readCodexCliAccountIdentity(authFile)).fingerprint;
}

/**
 * Grok Build's auth.json is keyed by `https://auth.x.ai::<client_id>`, with
 * `user_id`, `email`, and `key` (the access JWT) on that slot, not the
 * Codex-shaped `{ tokens: { account_id, access_token } }` this module first
 * looked for. A slot is any object that carries one of those identity fields.
 * Codex-shaped fixtures still parse because they themselves look like a slot.
 */
function isGrokAuthSlot(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    typeof value.key === "string" ||
    typeof value.access_token === "string" ||
    typeof value.access === "string" ||
    typeof value.refresh_token === "string" ||
    typeof value.user_id === "string" ||
    typeof value.principal_id === "string" ||
    typeof value.email === "string" ||
    isRecord(value.tokens)
  );
}

function grokAuthSlots(parsed: unknown): Record<string, unknown>[] {
  if (!isRecord(parsed)) return [];
  if (isGrokAuthSlot(parsed)) return [parsed];
  const slots: Record<string, unknown>[] = [];
  for (const value of Object.values(parsed)) {
    if (isGrokAuthSlot(value)) slots.push(value);
  }
  return slots;
}

function grokAccountIdFromSlot(slot: Record<string, unknown>): string | undefined {
  const nested = isRecord(slot.tokens) ? slot.tokens : slot;
  const accountId =
    (typeof nested.user_id === "string" && nested.user_id) ||
    (typeof nested.principal_id === "string" && nested.principal_id) ||
    (typeof nested.account_id === "string" && nested.account_id) ||
    (typeof nested.accountId === "string" && nested.accountId) ||
    jwtSubjectClaim(nested.key) ||
    jwtSubjectClaim(nested.access_token) ||
    jwtSubjectClaim(nested.access) ||
    jwtSubjectClaim(slot.key) ||
    jwtSubjectClaim(slot.access);
  return accountId && accountId.length > 0 ? accountId : undefined;
}

function grokAccountEmailFromSlot(
  slot: Record<string, unknown>,
): string | undefined {
  const nested = isRecord(slot.tokens) ? slot.tokens : slot;
  return (
    normalizeAccountEmail(nested.email) ??
    normalizeAccountEmail(slot.email) ??
    jwtEmailClaim(nested.id_token) ??
    jwtEmailClaim(nested.access_token) ??
    jwtEmailClaim(nested.access) ??
    jwtEmailClaim(nested.key) ??
    jwtEmailClaim(slot.access) ??
    jwtEmailClaim(slot.key)
  );
}

function grokAccountIdFrom(parsed: unknown): string | undefined {
  for (const slot of grokAuthSlots(parsed)) {
    const accountId = grokAccountIdFromSlot(slot);
    if (accountId) return accountId;
  }
  return undefined;
}

function grokAccountEmailFrom(parsed: unknown): string | undefined {
  for (const slot of grokAuthSlots(parsed)) {
    const email = grokAccountEmailFromSlot(slot);
    if (email) return email;
  }
  return undefined;
}

/**
 * Digest and email from a Grok Build `auth.json`. Tokens are never returned.
 */
export async function readGrokCliAccountIdentity(
  authFile: string,
): Promise<NativeCliAccountIdentity> {
  try {
    const parsed = await readJsonUnderCap(
      authFile,
      NATIVE_CLI_CREDENTIAL_MAX_BYTES,
    );
    const accountId = grokAccountIdFrom(parsed);
    const email = grokAccountEmailFrom(parsed);
    return {
      ...(accountId ? { fingerprint: nativeCliAccountFingerprint(accountId) } : {}),
      ...(email ? { email } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * The config files a Claude Code sign-in may have written its account metadata
 * into, most specific first. Claude Code prefers a legacy `.config.json` inside
 * its config directory when one exists, and otherwise writes `.claude.json`
 * into CLAUDE_CONFIG_DIR, or into the home directory when that variable is
 * unset, which is the case for the personal profile.
 *
 * `homeDir` is passed in rather than read from the process so that a store
 * pointed at a sandbox directory can never reach the real home directory.
 */
export function claudeCliConfigFileCandidates(
  configDir: string,
  configDirEnv: string | null,
  homeDir: string,
): string[] {
  return [
    join(configDir, ".config.json"),
    join(configDirEnv ?? homeDir, ".claude.json"),
  ];
}

/**
 * The account digest and email a Claude Code sign-in recorded, or an empty
 * identity when there is nothing safe to read. Only `oauthAccount.accountUuid`
 * and `oauthAccount.emailAddress` are looked at; the organization, the project
 * history, and every other field in that file are ignored. Never throws.
 */
export async function readClaudeCliAccountIdentity(
  configDir: string,
  configDirEnv: string | null,
  homeDir: string,
): Promise<NativeCliAccountIdentity> {
  for (const candidate of claudeCliConfigFileCandidates(
    configDir,
    configDirEnv,
    homeDir,
  )) {
    try {
      const parsed = await readJsonUnderCap(candidate, CLAUDE_CLI_CONFIG_MAX_BYTES);
      const accountUuid = claudeAccountUuidFrom(parsed);
      const email = claudeAccountEmailFrom(parsed);
      if (accountUuid || email) {
        return {
          ...(accountUuid
            ? { fingerprint: anthropicAccountFingerprint(accountUuid) }
            : {}),
          ...(email ? { email } : {}),
        };
      }
    } catch {
      // Try the next candidate; a missing or malformed config is not an error.
    }
  }
  return {};
}

/** Fingerprint-only view of the above, kept for callers that pair accounts. */
export async function readClaudeCliAccountFingerprint(
  configDir: string,
  configDirEnv: string | null,
  homeDir: string,
): Promise<string | undefined> {
  return (await readClaudeCliAccountIdentity(configDir, configDirEnv, homeDir))
    .fingerprint;
}
