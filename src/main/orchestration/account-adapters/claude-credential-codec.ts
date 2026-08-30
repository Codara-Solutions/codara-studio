import type { ClaudeCredentialRecord } from "../claude-cli-credentials";
import type { CanonicalCredential, CredentialCodec } from "../credential-mirror";
import type { PiOAuthCredential } from "../pi-auth-storage";

/**
 * Anthropic's credential is opaque tokens plus an expiry. Pi stores the
 * expiry minus its own safety padding; Claude Code stores the raw one. The
 * canonical form is the raw expiry, so both sides compare the same number.
 */

export const PI_EXPIRY_PADDING_MS = 5 * 60 * 1000;

/** The scope list pi-ai requests for its Anthropic OAuth login, verbatim. */
export const ANTHROPIC_OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function canonicalFromPi(value: unknown): CanonicalCredential | null {
  if (!isRecord(value) || value.type !== "oauth") return null;
  if (typeof value.access !== "string" || value.access.length === 0) return null;
  if (!finite(value.expires)) return null;
  return {
    access: value.access,
    refresh: typeof value.refresh === "string" ? value.refresh : "",
    expiresAt: value.expires + PI_EXPIRY_PADDING_MS,
  };
}

export function canonicalFromClaude(
  record: ClaudeCredentialRecord | null | undefined,
): CanonicalCredential | null {
  if (!record) return null;
  if (typeof record.accessToken !== "string" || record.accessToken.length === 0) return null;
  return {
    access: record.accessToken,
    refresh: typeof record.refreshToken === "string" ? record.refreshToken : "",
    expiresAt: finite(record.expiresAt) ? record.expiresAt : 0,
  };
}

export function piRecordFromCanonical(credential: CanonicalCredential): PiOAuthCredential {
  return {
    type: "oauth",
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expiresAt - PI_EXPIRY_PADDING_MS,
  };
}

/**
 * Every field the previous Claude record carried survives; only the tokens
 * and expiry change. Scopes are invented solely for a brand-new file, and
 * subscriptionType / rateLimitTier are never invented at all.
 */
export function claudeRecordFromCanonical(
  credential: CanonicalCredential,
  previous?: ClaudeCredentialRecord | null,
): ClaudeCredentialRecord {
  return {
    ...(previous ?? {}),
    accessToken: credential.access,
    refreshToken: credential.refresh,
    expiresAt: credential.expiresAt,
    scopes: previous?.scopes ?? [...ANTHROPIC_OAUTH_SCOPES],
  };
}

export const claudeCredentialCodec: CredentialCodec<ClaudeCredentialRecord> = {
  provider: "anthropic",
  canonicalFromPi,
  piRecordFromCanonical: (canonical) => piRecordFromCanonical(canonical),
  canonicalFromCli: canonicalFromClaude,
  cliRecordFromCanonical: (canonical, previous) => claudeRecordFromCanonical(canonical, previous),
};
