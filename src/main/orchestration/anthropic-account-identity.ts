import {
  anthropicAccountFingerprint,
  normalizeAccountEmail,
  type NativeCliAccountIdentity,
} from "./native-cli-account-identity";

/**
 * Which Anthropic account a freshly connected Cora sign-in belongs to.
 *
 * Pi's Anthropic OAuth credential is tokens only — an opaque `sk-ant-oat…`
 * access token, a refresh token, and an expiry — so unlike Codex there is no
 * account id in the stored credential to hash. The account uuid is available
 * exactly once, at the moment the browser login finishes: Anthropic's OAuth
 * profile endpoint answers the just-issued access token with the same uuid
 * Claude Code stores as `oauthAccount.accountUuid` after its own login. Hashing
 * it here puts a Cora connection and a Claude Code sign-in into one id space,
 * which is what lets Settings show them as a single account card.
 *
 * Rules this module exists to keep:
 *  - Called only from the connect flow, with the credential that flow just
 *    received. It never reads a stored credential and never refreshes one.
 *  - One request, short timeout, no retries. A failure means no fingerprint,
 *    which means the account stays on its own card — never a guessed match.
 *  - Only `account.uuid` and `account.email_address` are read. The display
 *    name, organization, and plan fields in the response are discarded, the
 *    access token is never stored or logged, and the digest and the email are
 *    the only values that leave this module. The email is shown on the Settings
 *    card so one account is tellable from another; it is stripped from every
 *    remote projection, so a paired phone never receives it.
 */

export const ANTHROPIC_OAUTH_PROFILE_URL =
  "https://api.anthropic.com/api/oauth/profile";

export const ANTHROPIC_OAUTH_PROFILE_TIMEOUT_MS = 8_000;

/** Enough for the profile document; anything larger is not one. */
const PROFILE_MAX_BYTES = 64 * 1024;

type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; text(): Promise<string> }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function accountUuidFrom(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined;
  const account = parsed.account;
  const raw = isRecord(account) ? account.uuid : undefined;
  return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}

/**
 * Anthropic reports the address as `account.email_address`; older responses
 * have used `account.email`, so both spellings are accepted.
 */
function accountEmailFrom(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined;
  const account = parsed.account;
  if (!isRecord(account)) return undefined;
  return (
    normalizeAccountEmail(account.email_address) ??
    normalizeAccountEmail(account.email)
  );
}

/**
 * The sha256 of the Anthropic account uuid behind an access token, plus that
 * account's email address, or an empty identity when the account cannot be
 * identified. Never throws, and never surfaces the uuid, the token, or the
 * response body.
 */
export async function readAnthropicAccountIdentity(
  accessToken: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<NativeCliAccountIdentity> {
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    return {};
  }
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof fetchImpl !== "function") return {};
  const timeoutMs = options.timeoutMs ?? ANTHROPIC_OAUTH_PROFILE_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetchImpl(ANTHROPIC_OAUTH_PROFILE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Cache-Control": "no-cache",
      },
      signal: abort.signal,
    });
    if (!response.ok) return {};
    const body = await response.text();
    if (body.length > PROFILE_MAX_BYTES) return {};
    const parsed = JSON.parse(body) as unknown;
    const accountUuid = accountUuidFrom(parsed);
    const email = accountEmailFrom(parsed);
    return {
      ...(accountUuid
        ? { fingerprint: anthropicAccountFingerprint(accountUuid) }
        : {}),
      ...(email ? { email } : {}),
    };
  } catch {
    // Offline, timed out, rejected, or an unexpected body: the connection is
    // still perfectly usable, it just cannot be paired with a CLI sign-in.
    // JSON.parse quotes the text it failed on, so this catch also keeps
    // response bytes out of anything that could escape.
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/** Fingerprint-only view of the above, kept for callers that pair accounts. */
export async function readAnthropicAccountFingerprint(
  accessToken: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<string | undefined> {
  return (await readAnthropicAccountIdentity(accessToken, options)).fingerprint;
}
