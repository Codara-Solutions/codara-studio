import { jwtNumericClaim } from "./native-cli-account-identity";

/**
 * One refresh grant against OpenAI's token endpoint, the way codex-rs does
 * it. It exists for a single reason: pi-ai's exchange discards the id_token
 * it is issued and Codara only ever calls oauth.login, while Codex CLI
 * refuses an auth.json without one (it reads the account's email and id out
 * of it). A refresh grant answers with a fresh id_token, so a Cora sign-in
 * can grow a Codex half.
 *
 * The grant rotates the refresh token. The caller (the Codex adapter) must
 * persist the rotated triple to Pi under Pi's own lock before anything else
 * uses it; this module performs the request and nothing more. No token is
 * logged and none reaches an error message.
 */

export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_REFRESH_SCOPE = "openid profile email";
export const CODEX_OAUTH_REFRESH_TIMEOUT_MS = 15_000;
/** A token response is a few kilobytes; anything larger is not one. */
const RESPONSE_MAX_BYTES = 256 * 1024;

export type CodexRefreshFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface CodexRefreshedCredential {
  access: string;
  refresh: string;
  idToken: string;
  /** The access JWT's exp in epoch ms, else now plus expires_in. */
  expiresAt: number;
  issuedAt?: number;
}

export interface CodexRefreshOptions {
  fetchImpl?: CodexRefreshFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export async function refreshCodexCredential(
  refreshToken: string,
  options: CodexRefreshOptions = {},
): Promise<CodexRefreshedCredential> {
  if (!nonEmpty(refreshToken)) throw new Error("Codex refresh requires a refresh token");
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as CodexRefreshFetch);
  if (typeof fetchImpl !== "function") throw new Error("Codex refresh has no fetch available");
  const timeoutMs = options.timeoutMs ?? CODEX_OAUTH_REFRESH_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Awaited<ReturnType<CodexRefreshFetch>>;
  try {
    response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: CODEX_OAUTH_REFRESH_SCOPE,
      }),
      signal,
    });
  } catch (error) {
    throw new Error(
      `Codex token refresh could not reach OpenAI: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    // The body of a refusal can echo the request; only the status is kept.
    throw new Error(`Codex token refresh was refused (${response.status})`);
  }
  const text = await response.text();
  if (text.length > RESPONSE_MAX_BYTES) throw new Error("Codex token refresh response is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Codex token refresh response is not JSON");
  }
  if (
    !isRecord(parsed) ||
    !nonEmpty(parsed.access_token) ||
    !nonEmpty(parsed.refresh_token) ||
    !nonEmpty(parsed.id_token)
  ) {
    throw new Error("Codex token refresh response is missing a token");
  }
  const now = options.now?.() ?? Date.now();
  const exp = jwtNumericClaim(parsed.access_token, "exp");
  const iat = jwtNumericClaim(parsed.access_token, "iat");
  const expiresIn =
    typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in)
      ? parsed.expires_in
      : undefined;
  return {
    access: parsed.access_token,
    refresh: parsed.refresh_token,
    idToken: parsed.id_token,
    expiresAt: exp !== undefined ? exp * 1000 : now + (expiresIn ?? 0) * 1000,
    ...(iat !== undefined ? { issuedAt: iat * 1000 } : {}),
  };
}
