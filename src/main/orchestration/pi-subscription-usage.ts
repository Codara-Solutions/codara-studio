// Subscription usage limits for the connected Cora subscriptions.
//
// Both Anthropic and OpenAI expose the same quota data their own CLIs show, to
// the same OAuth credential Codara already holds in Pi's auth store. Reading it
// turns "why did Cora suddenly get slow / refuse" into something visible before
// it happens: how much of the 5-hour and 7-day window is gone, and when it
// resets.
//
// Design notes:
//   * Credentials are read from Pi's own auth.json and never leave this module.
//     Nothing here logs, returns, or embeds token material, only percentages,
//     labels, and reset times cross the IPC boundary.
//   * An expired access token is refreshed through Pi's OWN oauth module and
//     written back through Pi's OWN AuthStorage, so Codara never implements a
//     second, divergent refresh path. Access tokens live about an hour, so
//     without this the panel would spend most of its life saying "reconnect".
//   * Every failure is per-account and non-fatal. An account that is not
//     connected, is rate-limited, or whose endpoint changes shape degrades to a
//     status the UI can render; it never breaks another account's card.
//
// Shapes are those of the vendor endpoints as of 2026-07:
//   Anthropic  GET https://api.anthropic.com/api/oauth/usage
//              -> { five_hour, seven_day, seven_day_opus } each { utilization, resets_at }
//                 plus limits: [{ kind, percent, resets_at, scope: { model } }]
//, the per-model weekly caps (Fable, Sonnet, …). These
//                 supersede seven_day_opus; the response also carries
//                 cinder_cove and extra_usage, which are CREDIT balances, not
//                 rate limits, and are deliberately not shown as windows.
//   OpenAI     GET https://chatgpt.com/backend-api/wham/usage
//              -> { plan_type, limit_reached, rate_limit: { primary_window, secondary_window },
//                   code_review_rate_limit: { primary_window },
//                   credits: { has_credits, unlimited, balance },
//                   rate_limit_reset_credits: { available_count } }
//                 each window { used_percent, limit_window_seconds, reset_after_seconds }
//              GET .../wham/rate-limit-reset-credits
//              -> { available_count, applicable_available_count,
//                   credits: [{ id, status, reset_type, granted_at, expires_at }] }
//                 read only when the summary reports a reset to spend, for the
//                 list. Spending POSTs .../consume with { redeem_request_id, credit_id }
//                 (the shape t3code sends, github.com/pingdotgg/t3code).
// Both are read defensively: every field is optional and a missing window is
// simply omitted rather than rendered as a confident zero.
//
// The credit and reset fields follow the shapes the Codex CLI's own backend
// client decodes and Orca (github.com/stablyai/orca, MIT) reads. Claude's
// extra_usage amounts are minor units of its currency, as Claude Code's own
// schema for this endpoint documents; the newer `spend` object follows Orca.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { logMain } from "../file-log";
import { familyForSubscription, PI_SUBSCRIPTION_PROVIDERS } from "../../shared/agent-families";
import type {
  PiCodexResetOutcome,
  PiSubscriptionProvider,
  PiUsageCredits,
  PiUsageOverview,
  PiUsageProfile,
  PiUsageProvider,
  PiUsageResetCredits,
  PiUsageWindow,
} from "@shared/types";
import { isPiResetCreditId } from "@shared/types";

import {
  inspectPiAccountProfileAuthStore,
  resolvePiAccountRuntimeProfile,
  type PiAccountProfileAuthStatus,
} from "./pi-account-auth-store";
import type { PiAccountProfile } from "./pi-account-profiles";

const REQUEST_TIMEOUT_MS = 15_000;
/** Spending a reset waits longer than a read: the provider resets every
 * window before it answers. */
const RESET_REQUEST_TIMEOUT_MS = 30_000;
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const DEFAULT_CACHE_TTL_MS = 60_000;
/** Anthropic's informational OAuth endpoint has a much tighter request budget
 * than an actual Claude session, so timer-driven reads stay at five minutes.
 * The numbers still move promptly because usage-activity-refresh.ts forces a
 * live read whenever an agent finishes a turn, which is the only time the
 * quota actually changes. */
const ANTHROPIC_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_ANTHROPIC_BACKOFF_MS = 5 * 60_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.0";

const PROVIDER_LABELS: Record<PiSubscriptionProvider, string> = {
  anthropic: familyForSubscription("anthropic").planLabel,
  "openai-codex": familyForSubscription("openai-codex").planLabel,
  xai: familyForSubscription("xai").planLabel,
};

interface StoredCredential {
  access: string;
  refresh: string | null;
  expires: number | null;
  accountId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percentValue(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim().length === 0)
  ) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed)
    ? Math.min(100, Math.max(0, parsed))
    : null;
}

function remainingPercent(usedPercent: number): number {
  return Math.max(0, Math.round((100 - usedPercent) * 10) / 10);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** "2d 4h" / "3h 12m" / "45m": the coarsest useful precision, matching how
 * both vendors' own CLIs phrase a reset countdown. */
function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatResetTime(value: string | null): string | undefined {
  if (!value) return undefined;
  const resetDate = new Date(value);
  if (Number.isNaN(resetDate.getTime())) return undefined;
  const seconds = Math.max(0, Math.floor((resetDate.getTime() - Date.now()) / 1000));
  return seconds === 0 ? "now" : formatDuration(seconds);
}

/** Window length -> human label ("5-hour", "7-day"). Rounds, because the
 * vendors report approximate lengths (~18000s, ~604800s). */
function formatWindowLabel(seconds: number): string | null {
  if (!seconds || seconds <= 0) return null;
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}-day`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}-hour`;
  return `${Math.max(1, Math.round(seconds / 60))}-minute`;
}

/**
 * Read one account's provider OAuth record straight out of its Pi auth store. This is the
 * only function that touches token material; everything downstream sees
 * percentages. Mirrors inspectPiSubscriptionAuth's permission check so a
 * world-readable auth file is refused here too.
 */
async function readStoredCredential(
  provider: PiSubscriptionProvider,
  authFile: string,
): Promise<StoredCredential | null> {
  const authStat = await stat(authFile).catch(() => null);
  if (!authStat) return null;
  if (process.platform !== "win32" && (authStat.mode & 0o077) !== 0) {
    throw new Error("Pi subscription auth must not be readable by group or other users");
  }
  const raw = await readFile(authFile, "utf8"); // fs errors carry paths only, never content
  // A fixed message, never JSON.parse's own: V8's SyntaxError quotes the text
  // around the error position, so a corrupt auth.json would otherwise embed a
  // token fragment in an error that crosses the IPC boundary via providerUsage.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Pi's auth store is not valid JSON. Reconnect the subscription.");
  }
  if (!isRecord(parsed)) return null;
  const record = parsed[provider];
  if (!isRecord(record) || record.type !== "oauth") return null;
  const access = stringValue(record.access);
  if (!access) return null;
  return {
    access,
    refresh: stringValue(record.refresh),
    expires: typeof record.expires === "number" && Number.isFinite(record.expires)
      ? record.expires
      : null,
    accountId: stringValue(record.accountId) ?? stringValue(record.account_id),
  };
}

/**
 * The ChatGPT usage endpoint needs the account id as a header. Pi normally
 * stores it, but it is also a claim inside the access token, so derive it as a
 * fallback rather than failing the whole card. Decoding is local and the claim
 * value is an account identifier, not a secret.
 */
function accountIdFromAccessToken(access: string): string | null {
  const segments = access.split(".");
  if (segments.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(segments[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    if (!isRecord(payload)) return null;
    const direct = stringValue(payload.chatgpt_account_id);
    if (direct) return direct;
    // Newer tokens nest it under the ChatGPT auth namespace claim.
    for (const value of Object.values(payload)) {
      if (isRecord(value)) {
        const nested = stringValue(value.chatgpt_account_id);
        if (nested) return nested;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Refresh an expired credential through Pi's own OAuth module and auth store
 * (lock-safe; see refreshPiSubscriptionCredential). Returns the fresh access
 * token, or null when the credential cannot be refreshed, in which case the
 * caller reports "reconnect needed" rather than firing a request that would
 * 401 anyway. Imported lazily so this module stays cheap to load.
 */
async function refreshCredential(
  profileId: string,
  provider: PiSubscriptionProvider,
): Promise<string | null> {
  const { refreshPiSubscriptionProfileCredential } = await import("./pi-subscription-auth");
  return refreshPiSubscriptionProfileCredential(profileId, provider).catch(() => null);
}

async function fetchJsonRecord(
  url: string,
  headers: Record<string, string>,
): Promise<
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; retryAfterMs: number | null }
> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      retryAfterMs: response.status === 429 ? parseRetryAfterMs(response.headers.get("retry-after")) : null,
    };
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const record = recordValue(json);
  if (!record) return { ok: false, status: 502, retryAfterMs: null };
  return { ok: true, data: record };
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const rawMs = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  if (!Number.isFinite(rawMs) || rawMs <= 0) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(rawMs));
}

/**
 * Per-model weekly windows from the Anthropic usage endpoint's `limits[]`.
 *
 * This is where a Pro/Max plan reports its Fable cap, the limit that actually
 * binds first when Cora routes premium work, and the one the title-bar pill
 * should reflect once it is the tightest window.
 *
 * Only `weekly_scoped` entries that name a model are taken: the same array also
 * carries surface-scoped entries, which are a different thing entirely.
 */
export function modelScopedWindows(value: unknown): PiUsageWindow[] {
  if (!Array.isArray(value)) return [];
  const windows: PiUsageWindow[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = recordValue(entry);
    if (!record || stringValue(record.kind) !== "weekly_scoped") continue;
    const scope = recordValue(record.scope);
    const model = recordValue(scope?.model);
    const name = stringValue(model?.display_name)?.trim().slice(0, 120);
    if (!name) continue;
    const usedPercent = percentValue(record.percent);
    if (usedPercent === null) continue;
    const resetsAt = resetsAtValue(record.resets_at);
    const rawModelId =
      stringValue(model?.id) ??
      stringValue(model?.model) ??
      stringValue(model?.name);
    const modelId = rawModelId?.trim().slice(0, 200);
    const key = modelId
      ? `id:${modelId.toLowerCase()}`
      : `label:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const safeId = name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "model";
    windows.push({
      id: `limit_${safeId}`,
      label: `${name} 7-day`,
      scope: {
        kind: "model",
        ...(modelId ? { modelId } : {}),
        modelLabel: name,
      },
      usedPercent,
      remainingPercent: remainingPercent(usedPercent),
      ...(resetsAt ? { resetsAt } : {}),
      ...(formatResetTime(resetsAt) ? { resetsIn: formatResetTime(resetsAt) } : {}),
    });
  }
  return windows;
}

/**
 * `resets_at` is an ISO string on the top-level windows but can arrive as epoch
 * SECONDS inside limits[]. Reading it as a string only would silently drop the
 * countdown, the row would render with no reset time and look broken.
 */
export function resetsAtValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value * 1000);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  const raw = stringValue(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? raw.trim() : null;
}

function anthropicWindow(
  id: string,
  label: string,
  value: unknown,
  scope: PiUsageWindow["scope"] = { kind: "general" },
): PiUsageWindow | null {
  const record = recordValue(value);
  if (!record) return null;
  const usedPercent = percentValue(record.utilization);
  if (usedPercent === null) return null;
  const resetsAt = resetsAtValue(record.resets_at);
  return {
    id,
    label,
    scope,
    usedPercent,
    remainingPercent: remainingPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
    ...(formatResetTime(resetsAt) ? { resetsIn: formatResetTime(resetsAt) } : {}),
  };
}

function codexWindow(
  id: string,
  fallbackLabel: string,
  value: unknown,
  qualifier?: string,
  scope: PiUsageWindow["scope"] = { kind: "general" },
): PiUsageWindow | null {
  const record = recordValue(value);
  if (!record) return null;
  const usedPercent = percentValue(record.used_percent);
  if (usedPercent === null) return null;
  const derived = formatWindowLabel(numberValue(record.limit_window_seconds));
  // Prefer the real window length so Codex cards read like Claude's ("5-hour",
  // "7-day") instead of the opaque "primary"/"secondary". The qualifier keeps
  // the code-review quota distinct when its duration collides with another.
  const base = derived ?? fallbackLabel;
  const resetSeconds = numberValue(record.reset_after_seconds);
  const absoluteReset = resetsAtValue(record.reset_at);
  const resetsAt =
    absoluteReset ??
    (resetSeconds > 0
      ? new Date(Date.now() + resetSeconds * 1000).toISOString()
      : null);
  return {
    id,
    label: qualifier ? `${qualifier} ${base}` : base,
    scope,
    usedPercent,
    remainingPercent: remainingPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
    ...(formatResetTime(resetsAt) ? { resetsIn: formatResetTime(resetsAt) } : {}),
  };
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Epoch milliseconds from an ISO string, epoch seconds or epoch milliseconds. */
function epochMs(value: unknown): number | null {
  const numeric = finiteNumber(value);
  if (numeric !== null) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const raw = stringValue(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Codex credits: a unitless balance the plan spends into once its windows are
 * used up. An account that never bought any reports `has_credits: false`, and
 * a "0 credits" line for it would only be noise.
 */
export function codexCreditsValue(value: unknown): PiUsageCredits | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const unlimited = record.unlimited === true;
  if (record.has_credits !== true && !unlimited) return undefined;
  const balance = finiteNumber(record.balance);
  if (balance === null && !unlimited) return undefined;
  return { kind: "balance", balance: Math.max(0, balance ?? 0), unlimited };
}

/** The reset count `wham/usage` carries, without expiries. */
export function codexResetCreditsValue(value: unknown): PiUsageResetCredits | undefined {
  const record = recordValue(value);
  const count = finiteNumber(record?.available_count);
  if (count === null) return undefined;
  const applicable = finiteNumber(record?.applicable_available_count);
  return {
    available: Math.max(0, Math.floor(count)),
    ...(applicable === null ? {} : { applicable: Math.max(0, Math.floor(applicable)) }),
  };
}

/**
 * The reset list from `wham/rate-limit-reset-credits`: the count, how many
 * can be spent now, and every unspent reset with its id and expiry, soonest
 * first. Spent and expired entries are left out; when entries carry no
 * status at all, only future expiries count. Entries of another reset type
 * (the field is `codex_rate_limits` for these) are left out too.
 */
export function codexResetCreditDetails(
  value: unknown,
  nowMs = Date.now(),
): PiUsageResetCredits | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const entries = (Array.isArray(record.credits) ? record.credits : [])
    .map(recordValue)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .filter((entry) => {
      const type = stringValue(entry.reset_type);
      return type === null || type === "codex_rate_limits";
    });
  const reportsStatus = entries.some((entry) => typeof entry.status === "string");
  const unspent = (
    reportsStatus
      ? entries.filter((entry) => String(entry.status).toLowerCase() === "available")
      : entries
  )
    .map((entry) => ({ entry, expires: epochMs(entry.expires_at) }))
    .filter(({ expires }) => expires === null || expires > nowMs)
    .sort((left, right) => (left.expires ?? Infinity) - (right.expires ?? Infinity));
  const count =
    finiteNumber(record.available_count) ?? (reportsStatus ? unspent.length : null);
  if (count === null) return undefined;
  const available = Math.max(0, Math.floor(count));
  const applicable = finiteNumber(record.applicable_available_count);
  const soonest = unspent.find(({ expires }) => expires !== null)?.expires;
  const credits = unspent.map(({ entry, expires }) => {
    const id = stringValue(entry.id) ?? stringValue(entry.credit_id);
    const granted = epochMs(entry.granted_at);
    return {
      ...(id ? { id } : {}),
      ...(expires !== null ? { expiresAt: new Date(expires).toISOString() } : {}),
      ...(granted !== null ? { grantedAt: new Date(granted).toISOString() } : {}),
    };
  });
  return {
    available,
    ...(applicable === null ? {} : { applicable: Math.max(0, Math.floor(applicable)) }),
    ...(available > 0 && soonest !== undefined && soonest !== null
      ? { nextExpiresAt: new Date(soonest).toISOString() }
      : {}),
    ...(available > 0 && credits.length > 0 ? { credits } : {}),
  };
}

function currencyCode(value: unknown): string | null {
  const raw = stringValue(value)?.trim().toUpperCase();
  return raw && /^[A-Z]{3}$/.test(raw) ? raw : null;
}

/** Minor units and an exponent (200000 at 2 is 2000.00), or a plain amount. */
function moneyValue(value: unknown): { amount: number; currency: string | null } | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? { amount: value, currency: null } : null;
  }
  const record = recordValue(value);
  const minor = finiteNumber(record?.amount_minor);
  if (!record || minor === null) return null;
  const exponent = record.exponent === undefined ? 2 : finiteNumber(record.exponent);
  if (exponent === null || !Number.isInteger(exponent) || exponent < 0 || exponent > 6) {
    return null;
  }
  return { amount: minor / 10 ** exponent, currency: currencyCode(record.currency) };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Claude extra usage: what the account spent past its plan this period
 * against the cap the user set. `extra_usage` is the shape Claude Code's own
 * schema for this endpoint documents, so it wins; the `spend` object Orca
 * also reads is used only when it is absent. Shown only while extra usage is
 * on, since a cap on a feature that is off spends nothing.
 */
export function claudeExtraUsageValue(data: Record<string, unknown>): PiUsageCredits | undefined {
  const legacy = recordValue(data.extra_usage);
  if (legacy) return claudeExtraUsageRecord(legacy);
  const spend = recordValue(data.spend);
  if (!spend || spend.enabled !== true) return undefined;
  const used = moneyValue(spend.used);
  const limit = moneyValue(spend.limit) ?? moneyValue(recordValue(spend.cap)?.money);
  if (!used && !limit) return undefined;
  const percent = finiteNumber(spend.percent);
  return {
    kind: "spend",
    currency: used?.currency ?? limit?.currency ?? "USD",
    spent: used?.amount ?? null,
    limit: limit?.amount ?? null,
    usedPercent: !limit
      ? null
      : percent !== null
        ? clampPercent(percent)
        : used && limit.amount > 0
          ? clampPercent((used.amount / limit.amount) * 100)
          : null,
  };
}

function claudeExtraUsageRecord(legacy: Record<string, unknown>): PiUsageCredits | undefined {
  if (legacy.is_enabled !== true) return undefined;
  const decimals = legacy.decimal_places === undefined ? 2 : finiteNumber(legacy.decimal_places);
  if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 6) {
    return undefined;
  }
  // Minor units of the currency (cents for USD); a null monthly_limit is a
  // plan without a cap, so there is nothing to draw a bar against.
  const limitMinor = finiteNumber(legacy.monthly_limit);
  const spentMinor = finiteNumber(legacy.used_credits);
  if (limitMinor === null && spentMinor === null) return undefined;
  const limit = limitMinor === null ? null : limitMinor / 10 ** decimals;
  const spent = spentMinor === null ? null : spentMinor / 10 ** decimals;
  const utilization = finiteNumber(legacy.utilization);
  return {
    kind: "spend",
    currency: currencyCode(legacy.currency) ?? "USD",
    spent,
    limit,
    usedPercent:
      limit === null
        ? null
        : utilization !== null
          ? clampPercent(utilization)
          : spent !== null && limit > 0
            ? clampPercent((spent / limit) * 100)
            : null,
  };
}

function notConnectedProfile(
  profile: PiAccountProfile,
  checkedAt: string,
  message?: string,
): PiUsageProfile {
  return {
    profileId: profile.id,
    provider: profile.provider,
    label: profile.label,
    isDefault: false,
    status: "not_connected",
    windows: [],
    checkedAt,
    ...(message ? { message } : {}),
  };
}

function profileProblem(
  profile: PiAccountProfile,
  checkedAt: string,
  status: PiUsageProfile["status"],
  message: string,
): PiUsageProfile {
  return {
    profileId: profile.id,
    provider: profile.provider,
    label: profile.label,
    isDefault: false,
    status,
    windows: [],
    checkedAt,
    message,
  };
}

/**
 * Resolve a usable access token, refreshing first when the stored one has
 * expired. Returns null when the provider is not connected at all.
 */
async function usableAccessToken(
  profileId: string,
  provider: PiSubscriptionProvider,
): Promise<{ credential: StoredCredential; access: string } | null> {
  // Cheap, and it catches a rotation by the CLI (a Keychain-only one for
  // Claude Code) before the probe would report a needless "session expired".
  const { unifiedAccountsFor } = await import("./unified-account-registry");
  await unifiedAccountsFor(provider).reconcileProfile(profileId).catch(() => null);
  const selected = await resolvePiAccountRuntimeProfile({
    provider,
    preferredAccountProfileId: profileId,
    requirePreferred: true,
  });
  const credential = await readStoredCredential(provider, selected.authFile);
  if (!credential) return null;
  // Same 60s headroom as the in-lock re-check in refreshPiSubscriptionCredential:
  // a token expiring in a few seconds would 401 mid-request and the card would
  // wrongly demand a reconnect, so treat it as already expired and refresh now.
  const expired = credential.expires !== null && credential.expires <= Date.now() + 60_000;
  if (!expired) return { credential, access: credential.access };
  const refreshed = await refreshCredential(profileId, provider);
  if (!refreshed) return { credential, access: "" };
  return { credential, access: refreshed };
}

async function anthropicUsage(
  profile: PiAccountProfile,
  checkedAt: string,
): Promise<PiUsageProfile> {
  const retryAt = anthropicBackoffUntil.get(profile.id) ?? 0;
  if (retryAt > Date.now()) {
    return profileProblem(
      profile,
      checkedAt,
      "error",
      `Claude temporarily throttled usage checks. The account is still connected; retry in ${formatDuration(Math.ceil((retryAt - Date.now()) / 1000))}.`,
    );
  }
  anthropicBackoffUntil.delete(profile.id);
  const resolved = await usableAccessToken(profile.id, "anthropic");
  if (!resolved) return notConnectedProfile(profile, checkedAt);
  if (!resolved.access) {
    return profileProblem(profile, checkedAt, "expired", "Session expired. Reconnect this Claude account.");
  }
  const result = await fetchJsonRecord("https://api.anthropic.com/api/oauth/usage", {
    authorization: `Bearer ${resolved.access}`,
    "anthropic-beta": "oauth-2025-04-20",
    "content-type": "application/json",
    // The OAuth usage endpoint is part of Claude Code's contract and applies a
    // tight budget. Identify as the CLI instead of Node/undici, which the
    // endpoint can throttle even while the same bearer works for Claude runs.
    "user-agent": CLAUDE_CODE_USER_AGENT,
  });
  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      return profileProblem(profile, checkedAt, "expired", "Claude rejected the stored session. Reconnect.");
    }
    if (result.status === 429) {
      const waitMs = result.retryAfterMs ?? DEFAULT_ANTHROPIC_BACKOFF_MS;
      anthropicBackoffUntil.set(profile.id, Date.now() + waitMs);
      return profileProblem(
        profile,
        checkedAt,
        "error",
        `Claude temporarily throttled usage checks. The account is still connected; retry in ${formatDuration(Math.ceil(waitMs / 1000))}.`,
      );
    }
    return profileProblem(profile, checkedAt, "error", `Claude usage check failed (HTTP ${result.status}).`);
  }
  anthropicBackoffUntil.delete(profile.id);
  // Per-model weekly caps (Fable, Sonnet, …) arrive in a `limits[]` array
  // rather than as top-level keys, which is why they were invisible here: the
  // parser only ever read three fixed fields. Each entry carries its own
  // percent, reset time, and the model's display name straight from the
  // server, so a new tier appears without a code change.
  const modelWindows = modelScopedWindows(result.data.limits);
  const generalWindows = [
    anthropicWindow("five_hour", "5-hour", result.data.five_hour),
    anthropicWindow("seven_day", "7-day", result.data.seven_day),
  ].filter((window): window is PiUsageWindow => window !== null);
  const windows = [
    ...generalWindows,
    // Legacy premium-tier key, superseded by the limits[] entries above. Kept
    // only when the server sends no model-scoped windows, so a plan that still
    // reports the old shape keeps its premium row, and one that reports both
    // never renders two bars for the same quota.
    ...(modelWindows.length === 0
      ? [
          anthropicWindow(
            "seven_day_opus",
            "Opus 7-day",
            result.data.seven_day_opus,
            { kind: "model", modelLabel: "Opus" },
          ),
        ]
      : []),
    ...modelWindows,
    // Deliberately NOT mapped as windows: `cinder_cove` is a one-off credit
    // grant and `extra_usage` is a credit balance. Both carry a `utilization`
    // and would pass a naive "looks like a window" test, but neither is a rate
    // limit and showing them as one would misreport how much headroom is left.
    // Extra usage is reported beside the windows as `credits` instead.
  ].filter((window): window is PiUsageWindow => window !== null);
  const credits = claudeExtraUsageValue(result.data);
  return {
    profileId: profile.id,
    provider: "anthropic",
    label: profile.label,
    isDefault: false,
    status: "ok",
    windows,
    checkedAt,
    generalLimitReached: generalWindows.some(
      (window) => window.usedPercent >= 100,
    ),
    limitReached: windows.some((window) => window.usedPercent >= 100),
    ...(credits ? { credits } : {}),
  };
}

function codexHeaders(access: string, accountId: string): Record<string, string> {
  return {
    authorization: `Bearer ${access}`,
    "chatgpt-account-id": accountId,
    "content-type": "application/json",
    "user-agent": "codex-cli",
  };
}

/**
 * The expiry of the soonest unspent reset. Best effort: the count from
 * `wham/usage` stands on its own, so any failure here keeps it without one.
 */
async function codexResetCreditsWithExpiry(
  summary: PiUsageResetCredits,
  headers: Record<string, string>,
): Promise<PiUsageResetCredits> {
  try {
    const result = await fetchJsonRecord(CODEX_RESET_CREDITS_URL, headers);
    if (!result.ok) return summary;
    const details = codexResetCreditDetails(result.data);
    if (!details) return summary;
    // The summary's applicable count stands when the list does not repeat it.
    return details.applicable === undefined && summary.applicable !== undefined
      ? { ...details, applicable: summary.applicable }
      : details;
  } catch {
    return summary;
  }
}

async function codexUsage(
  profile: PiAccountProfile,
  checkedAt: string,
): Promise<PiUsageProfile> {
  const resolved = await usableAccessToken(profile.id, "openai-codex");
  if (!resolved) return notConnectedProfile(profile, checkedAt);
  if (!resolved.access) {
    return profileProblem(profile, checkedAt, "expired", "Session expired. Reconnect this ChatGPT account.");
  }
  const accountId = resolved.credential.accountId ?? accountIdFromAccessToken(resolved.access);
  if (!accountId) {
    return profileProblem(
      profile,
      checkedAt,
      "error",
      "ChatGPT usage needs an account id that this session did not provide. Reconnect.",
    );
  }
  const headers = codexHeaders(resolved.access, accountId);
  const result = await fetchJsonRecord(CODEX_USAGE_URL, headers);
  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      return profileProblem(profile, checkedAt, "expired", "ChatGPT rejected the stored session. Reconnect.");
    }
    return profileProblem(profile, checkedAt, "error", `ChatGPT usage check failed (HTTP ${result.status}).`);
  }
  const rateLimit = recordValue(result.data.rate_limit);
  const reviewLimit = recordValue(result.data.code_review_rate_limit);
  const generalWindows = [
    codexWindow("primary", "Primary", rateLimit?.primary_window),
    codexWindow("secondary", "Secondary", rateLimit?.secondary_window),
  ].filter((window): window is PiUsageWindow => window !== null);
  const reviewWindows = [
    codexWindow(
      "code_review",
      "Code review",
      reviewLimit?.primary_window,
      "Code review",
      { kind: "code_review" },
    ),
  ].filter((window): window is PiUsageWindow => window !== null);
  const windows = [...generalWindows, ...reviewWindows];
  const generalLimitReached =
    rateLimit?.limit_reached === true ||
    generalWindows.some((window) => window.usedPercent >= 100);
  const credits = codexCreditsValue(result.data.credits);
  const resetSummary = codexResetCreditsValue(result.data.rate_limit_reset_credits);
  const resetCredits =
    resetSummary && resetSummary.available > 0
      ? await codexResetCreditsWithExpiry(resetSummary, headers)
      : resetSummary;
  return {
    profileId: profile.id,
    provider: "openai-codex",
    label: profile.label,
    isDefault: false,
    status: "ok",
    windows,
    checkedAt,
    ...(stringValue(result.data.plan_type) ? { plan: stringValue(result.data.plan_type)! } : {}),
    generalLimitReached,
    limitReached:
      result.data.limit_reached === true ||
      generalLimitReached ||
      reviewLimit?.limit_reached === true ||
      windows.some((window) => window.usedPercent >= 100),
    ...(credits ? { credits } : {}),
    ...(resetCredits ? { resetCredits } : {}),
  };
}

async function profileUsage(
  profile: PiAccountProfile,
  authStatus: PiAccountProfileAuthStatus | undefined,
  checkedAt: string,
): Promise<PiUsageProfile> {
  if (!authStatus?.connected) {
    return notConnectedProfile(
      profile,
      checkedAt,
      authStatus?.error ? "Subscription credentials are unavailable. Reconnect this account." : undefined,
    );
  }
  try {
    if (profile.provider === "anthropic") return await anthropicUsage(profile, checkedAt);
    if (profile.provider === "openai-codex") return await codexUsage(profile, checkedAt);
    // SuperGrok has no client-readable quota window comparable to Claude/ChatGPT.
    return {
      profileId: profile.id,
      provider: profile.provider,
      label: profile.label,
      isDefault: false,
      status: "ok",
      windows: [],
      checkedAt,
    };
  } catch (error) {
    // Fixed copy only: errors from fs/fetch/runtime loading can contain a local
    // credential path or vendor response detail and must not cross IPC. The
    // local log keeps the error class and message (never a token: every
    // message on this path is fixed copy or a Node network error) so a card
    // stuck on this state can be diagnosed from ~/.codarastudio/logs/main.log.
    const providerLabel =
      profile.provider === "anthropic"
        ? "Claude"
        : profile.provider === "openai-codex"
          ? "ChatGPT"
          : "xAI";
    const name = error instanceof Error ? error.name : "Error";
    const detail = error instanceof Error ? error.message : String(error);
    logMain(
      "usage",
      `${profile.provider} ${profile.id.slice(0, 8)} check failed: ${name}: ${detail.slice(0, 300)}`,
    );
    const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    const message =
      name === "TimeoutError" || name === "AbortError"
        ? `${providerLabel} usage check timed out. The account is still connected; retry in a moment.`
        : detail === "fetch failed" || typeof cause === "string"
          ? `${providerLabel} usage could not be reached (network). The account is still connected; retry when online.`
          : `${providerLabel} usage could not be checked. Retry, then reconnect this account if it persists.`;
    return profileProblem(profile, checkedAt, "error", message);
  }
}

const profileCache = new Map<string, { at: number; usage: PiUsageProfile }>();
const profileInflight = new Map<string, Promise<PiUsageProfile>>();
const anthropicBackoffUntil = new Map<string, number>();
let cachedProfileProjection: { profiles: PiUsageProfile[] } | null = null;

function profileCacheTtlMs(provider: PiSubscriptionProvider): number {
  return provider === "anthropic" ? ANTHROPIC_CACHE_TTL_MS : DEFAULT_CACHE_TTL_MS;
}

/**
 * Whether one of the read's windows has reset since it was taken. Such a read
 * still describes the window before the reset, often full and limit-reached,
 * which is the one number that is certainly wrong now, so the TTL alone must
 * not keep serving it. Only a reset after the read counts: a vendor that has
 * not rolled over yet reports a reset already past, and that must not turn
 * every read into a live one.
 */
function windowResetSince(usage: PiUsageProfile, readAtMs: number, nowMs: number): boolean {
  return usage.windows.some((window) => {
    const resetMs = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    return Number.isFinite(resetMs) && resetMs > readAtMs && resetMs <= nowMs;
  });
}

function cacheEntryFresh(
  provider: PiSubscriptionProvider,
  entry: { at: number; usage: PiUsageProfile },
): boolean {
  const now = Date.now();
  return (
    now - entry.at < profileCacheTtlMs(provider) && !windowResetSince(entry.usage, entry.at, now)
  );
}

function refreshUsageProfileCountdowns(
  profile: PiUsageProfile,
): PiUsageProfile {
  return {
    ...profile,
    windows: profile.windows.map((window) => ({
      ...window,
      ...(window.scope ? { scope: { ...window.scope } } : {}),
      ...(window.resetsAt
        ? { resetsIn: formatResetTime(window.resetsAt) ?? "now" }
        : {}),
    })),
    ...(profile.credits ? { credits: { ...profile.credits } } : {}),
    ...(profile.resetCredits ? { resetCredits: cloneResetCredits(profile.resetCredits) } : {}),
  };
}

function compatibilityProvider(
  provider: PiSubscriptionProvider,
  profiles: readonly PiUsageProfile[],
): PiUsageProvider {
  const candidates = profiles.filter((profile) => profile.provider === provider);
  const selected =
    candidates.find((profile) => profile.isDefault && profile.status !== "not_connected") ??
    candidates.find((profile) => profile.status !== "not_connected") ??
    candidates.find((profile) => profile.isDefault) ??
    candidates[0];
  if (!selected) {
    return {
      provider,
      label: PROVIDER_LABELS[provider],
      status: "not_connected",
      windows: [],
      checkedAt: new Date().toISOString(),
    };
  }
  return {
    provider,
    label: PROVIDER_LABELS[provider],
    status: selected.status,
    windows: selected.windows,
    checkedAt: selected.checkedAt,
    ...(selected.plan ? { plan: selected.plan } : {}),
    ...(selected.generalLimitReached !== undefined
      ? { generalLimitReached: selected.generalLimitReached }
      : {}),
    ...(selected.limitReached !== undefined ? { limitReached: selected.limitReached } : {}),
    ...(selected.message ? { message: selected.message } : {}),
    ...(selected.credits ? { credits: selected.credits } : {}),
    ...(selected.resetCredits ? { resetCredits: selected.resetCredits } : {}),
  };
}

function cachedProfileUsage(
  profile: PiAccountProfile,
  authStatus: PiAccountProfileAuthStatus | undefined,
  force: boolean,
): Promise<PiUsageProfile> {
  if (!authStatus?.connected) {
    profileCache.delete(profile.id);
    return profileUsage(profile, authStatus, new Date().toISOString());
  }
  const existing = profileCache.get(profile.id);
  if (!force && existing && cacheEntryFresh(profile.provider, existing)) {
    return Promise.resolve(
      refreshUsageProfileCountdowns({
        ...existing.usage,
        label: profile.label,
      }),
    );
  }
  const pending = profileInflight.get(profile.id);
  // A forced renderer refresh may arrive while the title-bar's automatic read
  // is still in flight. Join it: two simultaneous requests buy no fresher data
  // and are enough to trip Anthropic's tight endpoint budget.
  if (pending) return pending;

  const checkedAt = new Date().toISOString();
  let work: Promise<PiUsageProfile> | null = null;
  work = profileUsage(profile, authStatus, checkedAt).then((usage) => {
    // If an explicit refresh was throttled, preserve the last good bars. The
    // account is healthy and stale quota is more useful than replacing known
    // data with a scary connection-looking error.
    if (
      profile.provider === "anthropic" &&
      usage.status === "error" &&
      existing?.usage.status === "ok" &&
      (anthropicBackoffUntil.get(profile.id) ?? 0) > Date.now()
    ) {
      return refreshUsageProfileCountdowns({ ...existing.usage, label: profile.label });
    }
    if (profileInflight.get(profile.id) === work) {
      profileCache.set(profile.id, { at: Date.now(), usage });
    }
    return usage;
  });
  profileInflight.set(profile.id, work);
  void work.finally(() => {
    if (profileInflight.get(profile.id) === work) profileInflight.delete(profile.id);
  });
  return work;
}

/**
 * Usage for every Cora subscription account. The legacy `providers` projection
 * remains one row per provider for older consumers.
 */
export function inspectPiSubscriptionUsage(force = false): Promise<PiUsageOverview> {
  return (async (): Promise<PiUsageOverview> => {
    const checkedAt = new Date().toISOString();
    try {
      const inspection = await inspectPiAccountProfileAuthStore();
      const knownIds = new Set(inspection.snapshot.profiles.map((profile) => profile.id));
      for (const profileId of profileCache.keys()) {
        if (!knownIds.has(profileId)) profileCache.delete(profileId);
      }
      const statusById = new Map(
        inspection.statuses.map((status) => [status.profileId, status] as const),
      );
      const rawProfiles = await Promise.all(
        inspection.snapshot.profiles.map((profile) =>
          cachedProfileUsage(profile, statusById.get(profile.id), force),
        ),
      );
      const profiles = rawProfiles.map((usage) =>
        refreshUsageProfileCountdowns({
          ...usage,
          isDefault:
            inspection.snapshot.defaults[usage.provider] === usage.profileId,
        }),
      );
      // The synchronous reader below validates each row against its original
      // profile-cache timestamp and provider TTL. Aggregate reads therefore
      // never make an underlying provider response young again.
      cachedProfileProjection = { profiles };
      return {
        checkedAt,
        profiles,
        providers: PI_SUBSCRIPTION_PROVIDERS.map((provider) =>
          compatibilityProvider(provider, profiles),
        ),
      };
    } catch {
      // Registry/auth reconciliation failures are local implementation detail.
      // Keep IPC sanitized and make both compatibility rows explicitly degrade.
      const providers: PiUsageProvider[] = PI_SUBSCRIPTION_PROVIDERS.map(
        (provider) => ({
          provider,
          label: PROVIDER_LABELS[provider],
          status: "error",
          windows: [],
          checkedAt,
          message: "Subscription usage could not be checked. Retry from Settings.",
        }),
      );
      return { checkedAt, providers, profiles: [] };
    }
  })();
}

const CODEX_RESET_OUTCOMES: Readonly<Record<string, PiCodexResetOutcome>> = {
  reset: "reset",
  nothing_to_reset: "nothing_to_reset",
  no_credit: "no_credit",
  already_redeemed: "already_redeemed",
};

/** A failure whose message is fixed copy, safe to show and to cross IPC. */
class CodexResetError extends Error {}

/** The namespace t3code (github.com/pingdotgg/t3code, MIT) derives its
 * request ids in, so a retry from either app spends one reset at most. */
const CODEX_REDEEM_NAMESPACE = Buffer.from([
  0x6f, 0x1c, 0x2a, 0x9e, 0x2d, 0x4b, 0x4c, 0x1e, 0x9a, 0x7f, 0x3b, 0x8d, 0x5e, 0x0c, 0x1a, 0x42,
]);

/** A UUIDv5 of the account and the credit: the same reset always gets the
 * same request id, so ChatGPT answers a repeat with already_redeemed. */
export function codexRedeemRequestId(accountId: string, creditId: string): string {
  const bytes = createHash("sha1")
    .update(CODEX_REDEEM_NAMESPACE)
    .update(`${accountId}:${creditId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Spend one of a Codex account's rate-limit resets. The usage panel asks the
 * user to confirm first: a reset is something the account earned, and using
 * it cannot be undone. The credit id is required: the panel names the reset
 * that expires first, that reset is the one spent, and the request id is
 * derived from account and credit, so a retried request spends at most one
 * reset. A spend without a valid credit id is refused before anything is
 * sent. The account's cached reading is dropped whatever happens, so the
 * next read shows what ChatGPT reports now.
 */
export async function redeemCodexRateLimitReset(
  profileId: string,
  creditId: string,
): Promise<PiCodexResetOutcome> {
  if (!isPiResetCreditId(creditId)) {
    throw new CodexResetError("Codara could not tell which reset to use. Check the limits and try again.");
  }
  const inspection = await inspectPiAccountProfileAuthStore();
  const profile = inspection.snapshot.profiles.find((entry) => entry.id === profileId);
  if (!profile || profile.provider !== "openai-codex") {
    throw new CodexResetError("This Codex account is no longer in Codara.");
  }
  try {
    const resolved = await usableAccessToken(profile.id, "openai-codex");
    if (!resolved?.access) {
      throw new CodexResetError("This Codex account needs to sign in again. Reconnect it in Accounts.");
    }
    const accountId = resolved.credential.accountId ?? accountIdFromAccessToken(resolved.access);
    if (!accountId) {
      throw new CodexResetError("This Codex sign-in has no account id. Reconnect it in Accounts.");
    }
    const response = await fetch(`${CODEX_RESET_CREDITS_URL}/consume`, {
      method: "POST",
      headers: codexHeaders(resolved.access, accountId),
      body: JSON.stringify({ redeem_request_id: codexRedeemRequestId(accountId, creditId), credit_id: creditId }),
      signal: AbortSignal.timeout(RESET_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CodexResetError(`ChatGPT did not reset the limits (HTTP ${response.status}).`);
    }
    let code: unknown;
    try {
      code = recordValue(JSON.parse(await response.text()))?.code;
    } catch {
      code = undefined;
    }
    const outcome = typeof code === "string" ? CODEX_RESET_OUTCOMES[code] : undefined;
    if (!outcome) {
      throw new CodexResetError(
        "ChatGPT answered in a way Codara does not recognize. Check the limits before trying again.",
      );
    }
    return outcome;
  } catch (error) {
    if (error instanceof CodexResetError) throw error;
    // Same rule as profileUsage: fs and fetch errors can carry a credential
    // path or vendor detail, so only fixed copy crosses IPC.
    const name = error instanceof Error ? error.name : "Error";
    const detail = error instanceof Error ? error.message : String(error);
    logMain("usage", `openai-codex ${profile.id.slice(0, 8)} reset failed: ${name}: ${detail.slice(0, 300)}`);
    throw new Error(
      name === "TimeoutError" || name === "AbortError"
        ? "ChatGPT did not answer in time. Check the limits before trying again."
        : "The reset could not be sent. Check your connection and try again.",
    );
  } finally {
    profileCache.delete(profile.id);
    profileInflight.delete(profile.id);
  }
}

function cloneResetCredits(value: PiUsageResetCredits): PiUsageResetCredits {
  return { ...value, ...(value.credits ? { credits: value.credits.map((credit) => ({ ...credit })) } : {}) };
}

/** Drop the cache so the next read is live; used after a connect/disconnect. */
export function invalidatePiSubscriptionUsageCache(): void {
  profileCache.clear();
  profileInflight.clear();
  anthropicBackoffUntil.clear();
  cachedProfileProjection = null;
}

/** Synchronous, read-only view for latency-sensitive surfaces such as mobile
 * fleet projection. It never starts auth or vendor I/O and returns nothing once
 * its provider-specific cache is stale. Every nested object is cloned so a consumer
 * cannot mutate the main-process cache. */
export function inspectCachedPiSubscriptionUsageProfiles(): PiUsageProfile[] {
  if (!cachedProfileProjection) return [];
  return cachedProfileProjection.profiles
    .filter((profile) => {
      const cached = profileCache.get(profile.profileId);
      return cached !== undefined && cacheEntryFresh(profile.provider, cached);
    })
    .map(refreshUsageProfileCountdowns);
}

/** The last usage each account reported, kept while its read is younger than
 * maxAgeMs even after the provider TTL lapsed. For prompt hints that must never
 * wait on a vendor round trip; routing decisions keep reading the live path. */
export function inspectLastKnownPiSubscriptionUsageProfiles(maxAgeMs: number): PiUsageProfile[] {
  if (!cachedProfileProjection) return [];
  return cachedProfileProjection.profiles
    .filter((profile) => {
      const cached = profileCache.get(profile.profileId);
      return cached && Date.now() - cached.at < maxAgeMs;
    })
    .map(refreshUsageProfileCountdowns);
}
