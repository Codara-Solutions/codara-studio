import type { CanonicalCredential, CredentialCodec } from "../credential-mirror";
import { jwtClaim, jwtNumericClaim } from "../native-cli-account-identity";
import type { PiOAuthCredential } from "../pi-auth-storage";

/**
 * Codex CLI's auth.json and Pi's openai-codex credential hold the same
 * ChatGPT OAuth grant in two shapes:
 *
 *   auth.json: { auth_mode, OPENAI_API_KEY, tokens: { id_token, access_token,
 *               refresh_token, account_id }, last_refresh }
 *   Pi:        { type: "oauth", access, refresh, expires, accountId }
 *
 * Both access tokens are JWTs whose exp (iat + 240h) is the one expiry both
 * sides can agree on; Pi's stored `expires` is a client-clock estimate that
 * drifts from it, so the canonical expiry is always taken from the JWT and
 * every Pi write carries it. Codex reads the account's email and id out of
 * id_token and refuses a file without one (TokenData has four mandatory
 * fields), and pi-ai's exchange discards the id_token it was issued, so a
 * fresh auth.json can only be written once a refresh grant supplied one:
 * cliRecordFromCanonical answers null until then and the account service
 * grows the credential first.
 */

export const CODEX_ACCESS_TOKEN_LIFETIME_MS = 240 * 60 * 60 * 1000;
export const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

export interface CodexAuthTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
  [key: string]: unknown;
}

/** The auth.json shape Codex stores. Unknown keys are preserved. */
export interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: CodexAuthTokens;
  last_refresh?: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parsedTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function jwtMillis(token: unknown, name: string): number | undefined {
  const seconds = jwtNumericClaim(token, name);
  return seconds === undefined ? undefined : seconds * 1000;
}

/** The ChatGPT account id an access token was issued for. */
export function codexAccountIdFromAccessToken(accessToken: unknown): string | undefined {
  const auth = jwtClaim(accessToken, CODEX_AUTH_CLAIM);
  const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined;
  return nonEmpty(accountId) ? accountId : undefined;
}

export function isCodexAuthFile(value: unknown): value is CodexAuthFile {
  return isRecord(value) && (value.tokens === undefined || isRecord(value.tokens));
}

export function canonicalFromCodexFile(
  raw: CodexAuthFile | null | undefined,
): CanonicalCredential | null {
  if (!raw || !isRecord(raw.tokens)) return null;
  const tokens = raw.tokens;
  if (!nonEmpty(tokens.access_token)) return null;
  const lastRefresh = parsedTime(raw.last_refresh);
  const expiresAt =
    jwtMillis(tokens.access_token, "exp") ??
    jwtMillis(tokens.id_token, "exp") ??
    (lastRefresh === undefined ? 0 : lastRefresh + CODEX_ACCESS_TOKEN_LIFETIME_MS);
  const issuedAt = jwtMillis(tokens.access_token, "iat") ?? lastRefresh;
  const accountId = nonEmpty(tokens.account_id)
    ? tokens.account_id
    : codexAccountIdFromAccessToken(tokens.access_token);
  return {
    access: tokens.access_token,
    refresh: nonEmpty(tokens.refresh_token) ? tokens.refresh_token : "",
    expiresAt,
    ...(issuedAt !== undefined ? { issuedAt } : {}),
    extra: {
      ...(nonEmpty(tokens.id_token) ? { idToken: tokens.id_token } : {}),
      ...(accountId ? { accountId } : {}),
      ...(nonEmpty(raw.auth_mode) ? { authMode: raw.auth_mode } : {}),
    },
  };
}

export function canonicalFromCodexPi(value: unknown): CanonicalCredential | null {
  if (!isRecord(value) || value.type !== "oauth") return null;
  if (!nonEmpty(value.access)) return null;
  const expiresAt = jwtMillis(value.access, "exp") ?? (finite(value.expires) ? value.expires : undefined);
  if (expiresAt === undefined) return null;
  const issuedAt = jwtMillis(value.access, "iat");
  const accountId = nonEmpty(value.accountId)
    ? value.accountId
    : codexAccountIdFromAccessToken(value.access);
  return {
    access: value.access,
    refresh: typeof value.refresh === "string" ? value.refresh : "",
    expiresAt,
    ...(issuedAt !== undefined ? { issuedAt } : {}),
    extra: {
      ...(nonEmpty(value.idToken) ? { idToken: value.idToken } : {}),
      ...(accountId ? { accountId } : {}),
    },
  };
}

/**
 * The Pi record always carries the JWT-derived expiry so a Pi read and a
 * Codex read compare the same number; accountId is what Pi's own login
 * stores and what the registry fingerprint hashes. An id_token obtained by
 * a refresh grant rides along so a later fresh vault file needs no second
 * grant.
 */
export function codexPiRecordFromCanonical(
  canonical: CanonicalCredential,
  previousPi?: unknown,
): PiOAuthCredential {
  const previous = isRecord(previousPi) ? previousPi : {};
  const accountId =
    (nonEmpty(canonical.extra?.accountId) ? canonical.extra.accountId : undefined) ??
    (nonEmpty(previous.accountId) ? previous.accountId : undefined) ??
    codexAccountIdFromAccessToken(canonical.access);
  const idToken = nonEmpty(canonical.extra?.idToken) ? canonical.extra.idToken : undefined;
  return {
    type: "oauth",
    access: canonical.access,
    refresh: canonical.refresh,
    expires: canonical.expiresAt,
    ...(accountId ? { accountId } : {}),
    ...(idToken ? { idToken } : {}),
  };
}

export interface CodexCodecOptions {
  /** Test seam for the last_refresh stamp. */
  now?: () => Date;
}

/**
 * Previous wins for every field the credential does not replace: id_token
 * and account_id survive a Pi-originated rotation, auth_mode and the API
 * key slot are never invented over an existing file. last_refresh is
 * stamped now so Codex's own refresh timer restarts from this write. With
 * no previous file and no id_token there is nothing Codex would accept.
 */
export function codexFileFromCanonical(
  canonical: CanonicalCredential,
  previous?: CodexAuthFile | null,
  options: CodexCodecOptions = {},
): CodexAuthFile | null {
  const previousTokens = isRecord(previous?.tokens) ? previous.tokens : undefined;
  const idToken =
    (nonEmpty(canonical.extra?.idToken) ? canonical.extra.idToken : undefined) ??
    (nonEmpty(previousTokens?.id_token) ? previousTokens.id_token : undefined);
  if (!idToken) return null;
  const accountId =
    (nonEmpty(previousTokens?.account_id) ? previousTokens.account_id : undefined) ??
    (nonEmpty(canonical.extra?.accountId) ? canonical.extra.accountId : undefined) ??
    codexAccountIdFromAccessToken(canonical.access);
  const authMode =
    (nonEmpty(previous?.auth_mode) ? previous.auth_mode : undefined) ??
    (nonEmpty(canonical.extra?.authMode) ? canonical.extra.authMode : undefined) ??
    "chatgpt";
  return {
    ...(previous ?? {}),
    auth_mode: authMode,
    OPENAI_API_KEY: typeof previous?.OPENAI_API_KEY === "string" ? previous.OPENAI_API_KEY : null,
    tokens: {
      ...(previousTokens ?? {}),
      id_token: idToken,
      access_token: canonical.access,
      refresh_token: canonical.refresh,
      ...(accountId ? { account_id: accountId } : {}),
    },
    last_refresh: (options.now?.() ?? new Date()).toISOString(),
  };
}

export function createCodexCredentialCodec(
  options: CodexCodecOptions = {},
): CredentialCodec<CodexAuthFile> {
  return {
    provider: "openai-codex",
    canonicalFromPi: canonicalFromCodexPi,
    piRecordFromCanonical: codexPiRecordFromCanonical,
    canonicalFromCli: canonicalFromCodexFile,
    cliRecordFromCanonical: (canonical, previous) =>
      codexFileFromCanonical(canonical, previous, options),
  };
}

export const codexCredentialCodec = createCodexCredentialCodec();
