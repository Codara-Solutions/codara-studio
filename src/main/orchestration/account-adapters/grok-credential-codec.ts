import type { CanonicalCredential, CredentialCodec } from "../credential-mirror";
import {
  jwtNumericClaim,
  jwtStringClaim,
  normalizeAccountEmail,
} from "../native-cli-account-identity";
import type { PiOAuthCredential } from "../pi-auth-storage";

/**
 * Grok Build's auth.json is keyed by `<issuer>::<client_id>`; the slot holds
 * the access JWT as `key`, the refresh token, an ISO `expires_at` and the
 * account's profile fields. Pi's xai credential is the same grant with the
 * expiry stored five minutes early (pi-ai's REFRESH_SKEW_MS). The canonical
 * expiry is the JWT's exp, which both sides carry, so neither side's clock
 * decides who is newer.
 *
 * VERIFICATION GATE (grok 1.0.13, this machine, 2026-08-30): a scratch
 * GROK_HOME holding the slot exactly as grokFileFromCanonical synthesizes it
 * with placeholder strings parses (a read-only `grok models` reached the
 * server with the bearer and was refused with 401); a slot missing
 * `auth_mode` or `create_time` is rejected with serde's "missing field" and
 * Grok reports "not authenticated"; `team_id` and `email` may be absent.
 * The fresh-slot path below therefore writes the full shape and never a
 * subset.
 */

export const GROK_OIDC_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_AUTH_SLOT_KEY = `${GROK_OIDC_ISSUER}::${XAI_OAUTH_CLIENT_ID}`;
export const XAI_REFRESH_SKEW_MS = 5 * 60 * 1000;
const SLOT_KEY_PREFIX = `${GROK_OIDC_ISSUER}::`;
/** Fields the credential itself replaces; everything else in a slot is metadata. */
const SLOT_CREDENTIAL_FIELDS = new Set(["key", "refresh_token", "expires_at"]);

export interface GrokAuthSlot {
  key?: string;
  refresh_token?: string;
  expires_at?: string;
  auth_mode?: string;
  create_time?: string;
  user_id?: string;
  email?: string;
  principal_id?: string;
  principal_type?: string;
  team_id?: string;
  [key: string]: unknown;
}

/** The whole auth.json: slots keyed by issuer and client id. */
export type GrokAuthFile = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function jwtMillis(token: unknown, name: string): number | undefined {
  const seconds = jwtNumericClaim(token, name);
  return seconds === undefined ? undefined : seconds * 1000;
}

/** The first xAI slot of a Grok auth file, with its key. */
export function grokAuthSlot(
  raw: GrokAuthFile | null | undefined,
): { slotKey: string; slot: GrokAuthSlot } | null {
  if (!isRecord(raw)) return null;
  for (const [slotKey, value] of Object.entries(raw)) {
    if (slotKey.startsWith(SLOT_KEY_PREFIX) && isRecord(value)) {
      return { slotKey, slot: value as GrokAuthSlot };
    }
  }
  return null;
}

export function canonicalFromGrokFile(
  raw: GrokAuthFile | null | undefined,
): CanonicalCredential | null {
  const found = grokAuthSlot(raw);
  if (!found || !nonEmpty(found.slot.key)) return null;
  const { slotKey, slot } = found;
  const access = found.slot.key;
  const expiresAt =
    jwtMillis(slot.key, "exp") ??
    (typeof slot.expires_at === "string" && Number.isFinite(Date.parse(slot.expires_at))
      ? Date.parse(slot.expires_at)
      : 0);
  const issuedAt = jwtMillis(slot.key, "iat");
  const metadata: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(slot)) {
    if (!SLOT_CREDENTIAL_FIELDS.has(name)) metadata[name] = value;
  }
  return {
    access,
    refresh: nonEmpty(slot.refresh_token) ? slot.refresh_token : "",
    expiresAt,
    ...(issuedAt !== undefined ? { issuedAt } : {}),
    extra: { slotKey, ...metadata },
  };
}

export function canonicalFromGrokPi(value: unknown): CanonicalCredential | null {
  if (!isRecord(value) || value.type !== "oauth") return null;
  if (!nonEmpty(value.access)) return null;
  const expiresAt =
    jwtMillis(value.access, "exp") ??
    (finite(value.expires) ? value.expires + XAI_REFRESH_SKEW_MS : undefined);
  if (expiresAt === undefined) return null;
  const issuedAt = jwtMillis(value.access, "iat");
  return {
    access: value.access,
    refresh: typeof value.refresh === "string" ? value.refresh : "",
    expiresAt,
    ...(issuedAt !== undefined ? { issuedAt } : {}),
  };
}

export function grokPiRecordFromCanonical(canonical: CanonicalCredential): PiOAuthCredential {
  return {
    type: "oauth",
    access: canonical.access,
    refresh: canonical.refresh,
    expires: canonical.expiresAt - XAI_REFRESH_SKEW_MS,
  };
}

export interface GrokCodecOptions {
  /** Test seam for create_time on a synthesized slot. */
  now?: () => Date;
  /** The account's address when the JWT carries none (the Pi row's email). */
  accountEmail?: string;
}

/**
 * Previous wins for every field but the three the credential replaces. A
 * refresh token the credential lacks is kept from the slot: xAI may not
 * rotate one on refresh, and the slot's is still the valid one. A brand-new
 * file gets the verified full shape; a slot cannot be synthesized without
 * the subject the JWT names, so that answers null.
 */
export function grokFileFromCanonical(
  canonical: CanonicalCredential,
  previous?: GrokAuthFile | null,
  options: GrokCodecOptions = {},
): GrokAuthFile | null {
  const found = grokAuthSlot(previous);
  const expiresAt = new Date(canonical.expiresAt).toISOString();
  if (found) {
    const slot: GrokAuthSlot = {
      ...found.slot,
      key: canonical.access,
      refresh_token: canonical.refresh || found.slot.refresh_token || "",
      expires_at: expiresAt,
    };
    return { ...previous, [found.slotKey]: slot };
  }
  const subject = jwtStringClaim(canonical.access, "sub");
  if (!subject) return null;
  const teamId = jwtStringClaim(canonical.access, "team_id");
  const email =
    normalizeAccountEmail(options.accountEmail) ??
    normalizeAccountEmail(jwtStringClaim(canonical.access, "email"));
  const slotKey =
    typeof canonical.extra?.slotKey === "string" && canonical.extra.slotKey.startsWith(SLOT_KEY_PREFIX)
      ? canonical.extra.slotKey
      : GROK_AUTH_SLOT_KEY;
  const slot: GrokAuthSlot = {
    key: canonical.access,
    auth_mode: "oidc",
    create_time: (options.now?.() ?? new Date()).toISOString(),
    user_id: subject,
    ...(email ? { email } : {}),
    first_name: "",
    last_name: "",
    profile_image_asset_id: "",
    principal_type: "User",
    principal_id: subject,
    ...(teamId ? { team_id: teamId } : {}),
    coding_data_retention_opt_out: false,
    refresh_token: canonical.refresh,
    expires_at: expiresAt,
    oidc_issuer: GROK_OIDC_ISSUER,
    oidc_client_id: XAI_OAUTH_CLIENT_ID,
  };
  return { ...(isRecord(previous) ? previous : {}), [slotKey]: slot };
}

export function createGrokCredentialCodec(
  options: GrokCodecOptions = {},
): CredentialCodec<GrokAuthFile> {
  return {
    provider: "xai",
    canonicalFromPi: canonicalFromGrokPi,
    piRecordFromCanonical: grokPiRecordFromCanonical,
    canonicalFromCli: canonicalFromGrokFile,
    cliRecordFromCanonical: (canonical, previous) =>
      grokFileFromCanonical(canonical, previous, options),
  };
}

export const grokCredentialCodec = createGrokCredentialCodec();
