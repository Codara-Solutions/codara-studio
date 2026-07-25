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
//     Nothing here logs, returns, or embeds token material — only percentages,
//     labels, and reset times cross the IPC boundary.
//   * An expired access token is refreshed through Pi's OWN oauth module and
//     written back through Pi's OWN AuthStorage, so Codara never implements a
//     second, divergent refresh path. Access tokens live about an hour, so
//     without this the panel would spend most of its life saying "reconnect".
//   * Every failure is per-provider and non-fatal. A provider that is not
//     connected, is rate-limited, or whose endpoint changes shape degrades to a
//     status the UI can render; it never breaks the other provider's card.
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
//                   code_review_rate_limit: { primary_window } }
//                 each window { used_percent, limit_window_seconds, reset_after_seconds }
// Both are read defensively: every field is optional and a missing window is
// simply omitted rather than rendered as a confident zero.

import { readFile, stat } from "node:fs/promises";
import type {
  PiSubscriptionProvider,
  PiUsageOverview,
  PiUsageProvider,
  PiUsageWindow,
} from "@shared/types";

import { codaraPiPaths } from "./pi-runtime-electron";

const REQUEST_TIMEOUT_MS = 15_000;
/** Usage moves slowly and both endpoints are rate-limited; a short cache keeps
 * an open Settings panel from hammering them on every re-render. */
const CACHE_TTL_MS = 60_000;

const PROVIDER_LABELS: Record<PiSubscriptionProvider, string> = {
  anthropic: "Claude Pro / Max",
  "openai-codex": "ChatGPT Plus / Pro",
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

function percentValue(value: unknown): number {
  return Math.min(100, Math.max(0, numberValue(value)));
}

function remainingPercent(usedPercent: number): number {
  return Math.max(0, Math.round((100 - usedPercent) * 10) / 10);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** "2d 4h" / "3h 12m" / "45m" — the coarsest useful precision, matching how
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
 * Read one provider's OAuth record straight out of Pi's auth store. This is the
 * only function that touches token material; everything downstream sees
 * percentages. Mirrors inspectPiSubscriptionAuth's permission check so a
 * world-readable auth file is refused here too.
 */
async function readStoredCredential(
  provider: PiSubscriptionProvider,
): Promise<StoredCredential | null> {
  const authFile = codaraPiPaths().authFile;
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
 * (lock-safe — see refreshPiSubscriptionCredential). Returns the fresh access
 * token, or null when the credential cannot be refreshed, in which case the
 * caller reports "reconnect needed" rather than firing a request that would
 * 401 anyway. Imported lazily so this module stays cheap to load.
 */
async function refreshCredential(provider: PiSubscriptionProvider): Promise<string | null> {
  const { refreshPiSubscriptionCredential } = await import("./pi-subscription-auth");
  return refreshPiSubscriptionCredential(provider).catch(() => null);
}

async function fetchJsonRecord(
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; status: number }> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return { ok: false, status: response.status };
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const record = recordValue(json);
  if (!record) return { ok: false, status: 502 };
  return { ok: true, data: record };
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
    const name = stringValue(model?.display_name)?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const usedPercent = percentValue(record.percent);
    const resetsAt = resetsAtValue(record.resets_at);
    windows.push({
      id: `limit_${key}`,
      label: `${name} 7-day`,
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
    return new Date(value * 1000).toISOString();
  }
  return stringValue(value);
}

function anthropicWindow(id: string, label: string, value: unknown): PiUsageWindow | null {
  const record = recordValue(value);
  if (!record) return null;
  const usedPercent = percentValue(record.utilization);
  const resetsAt = stringValue(record.resets_at);
  return {
    id,
    label,
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
): PiUsageWindow | null {
  const record = recordValue(value);
  if (!record) return null;
  const usedPercent = percentValue(record.used_percent);
  const derived = formatWindowLabel(numberValue(record.limit_window_seconds));
  // Prefer the real window length so Codex cards read like Claude's ("5-hour",
  // "7-day") instead of the opaque "primary"/"secondary". The qualifier keeps
  // the code-review quota distinct when its duration collides with another.
  const base = derived ?? fallbackLabel;
  const resetSeconds = numberValue(record.reset_after_seconds);
  return {
    id,
    label: qualifier ? `${qualifier} ${base}` : base,
    usedPercent,
    remainingPercent: remainingPercent(usedPercent),
    ...(resetSeconds > 0 ? { resetsIn: formatDuration(resetSeconds) } : {}),
  };
}

function notConnected(provider: PiSubscriptionProvider, checkedAt: string): PiUsageProvider {
  return {
    provider,
    label: PROVIDER_LABELS[provider],
    status: "not_connected",
    windows: [],
    checkedAt,
  };
}

function problem(
  provider: PiSubscriptionProvider,
  checkedAt: string,
  status: PiUsageProvider["status"],
  message: string,
): PiUsageProvider {
  return { provider, label: PROVIDER_LABELS[provider], status, windows: [], checkedAt, message };
}

/**
 * Resolve a usable access token, refreshing first when the stored one has
 * expired. Returns null when the provider is not connected at all.
 */
async function usableAccessToken(
  provider: PiSubscriptionProvider,
): Promise<{ credential: StoredCredential; access: string } | null> {
  const credential = await readStoredCredential(provider);
  if (!credential) return null;
  // Same 60s headroom as the in-lock re-check in refreshPiSubscriptionCredential:
  // a token expiring in a few seconds would 401 mid-request and the card would
  // wrongly demand a reconnect, so treat it as already expired and refresh now.
  const expired = credential.expires !== null && credential.expires <= Date.now() + 60_000;
  if (!expired) return { credential, access: credential.access };
  const refreshed = await refreshCredential(provider);
  if (!refreshed) return { credential, access: "" };
  return { credential, access: refreshed };
}

async function anthropicUsage(checkedAt: string): Promise<PiUsageProvider> {
  const resolved = await usableAccessToken("anthropic");
  if (!resolved) return notConnected("anthropic", checkedAt);
  if (!resolved.access) {
    return problem("anthropic", checkedAt, "expired", "Session expired. Reconnect Claude Pro / Max.");
  }
  const result = await fetchJsonRecord("https://api.anthropic.com/api/oauth/usage", {
    authorization: `Bearer ${resolved.access}`,
    "anthropic-beta": "oauth-2025-04-20",
    "content-type": "application/json",
  });
  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      return problem("anthropic", checkedAt, "expired", "Claude rejected the stored session. Reconnect.");
    }
    return problem("anthropic", checkedAt, "error", `Claude usage check failed (HTTP ${result.status}).`);
  }
  // Per-model weekly caps (Fable, Sonnet, …) arrive in a `limits[]` array
  // rather than as top-level keys, which is why they were invisible here: the
  // parser only ever read three fixed fields. Each entry carries its own
  // percent, reset time, and the model's display name straight from the
  // server, so a new tier appears without a code change.
  const modelWindows = modelScopedWindows(result.data.limits);
  const windows = [
    anthropicWindow("five_hour", "5-hour", result.data.five_hour),
    anthropicWindow("seven_day", "7-day", result.data.seven_day),
    // Legacy premium-tier key, superseded by the limits[] entries above. Kept
    // only when the server sends no model-scoped windows, so a plan that still
    // reports the old shape keeps its premium row, and one that reports both
    // never renders two bars for the same quota.
    ...(modelWindows.length === 0
      ? [anthropicWindow("seven_day_opus", "Opus 7-day", result.data.seven_day_opus)]
      : []),
    ...modelWindows,
    // Deliberately NOT mapped: `cinder_cove` is a one-off credit grant and
    // `extra_usage` is a credit balance. Both carry a `utilization` and would
    // pass a naive "looks like a window" test, but neither is a rate limit and
    // showing them as one would misreport how much headroom is left.
  ].filter((window): window is PiUsageWindow => window !== null);
  return {
    provider: "anthropic",
    label: PROVIDER_LABELS.anthropic,
    status: "ok",
    windows,
    checkedAt,
    limitReached: windows.some((window) => window.usedPercent >= 100),
  };
}

async function codexUsage(checkedAt: string): Promise<PiUsageProvider> {
  const resolved = await usableAccessToken("openai-codex");
  if (!resolved) return notConnected("openai-codex", checkedAt);
  if (!resolved.access) {
    return problem("openai-codex", checkedAt, "expired", "Session expired. Reconnect ChatGPT Plus / Pro.");
  }
  const accountId = resolved.credential.accountId ?? accountIdFromAccessToken(resolved.access);
  if (!accountId) {
    return problem(
      "openai-codex",
      checkedAt,
      "error",
      "ChatGPT usage needs an account id that this session did not provide. Reconnect.",
    );
  }
  const result = await fetchJsonRecord("https://chatgpt.com/backend-api/wham/usage", {
    authorization: `Bearer ${resolved.access}`,
    "chatgpt-account-id": accountId,
    "content-type": "application/json",
    "user-agent": "codex-cli",
  });
  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      return problem("openai-codex", checkedAt, "expired", "ChatGPT rejected the stored session. Reconnect.");
    }
    return problem("openai-codex", checkedAt, "error", `ChatGPT usage check failed (HTTP ${result.status}).`);
  }
  const rateLimit = recordValue(result.data.rate_limit);
  const reviewLimit = recordValue(result.data.code_review_rate_limit);
  const windows = [
    codexWindow("primary", "Primary", rateLimit?.primary_window),
    codexWindow("secondary", "Secondary", rateLimit?.secondary_window),
    codexWindow("code_review", "Code review", reviewLimit?.primary_window, "Code review"),
  ].filter((window): window is PiUsageWindow => window !== null);
  return {
    provider: "openai-codex",
    label: PROVIDER_LABELS["openai-codex"],
    status: "ok",
    windows,
    checkedAt,
    ...(stringValue(result.data.plan_type) ? { plan: stringValue(result.data.plan_type)! } : {}),
    limitReached:
      result.data.limit_reached === true ||
      rateLimit?.limit_reached === true ||
      windows.some((window) => window.usedPercent >= 100),
  };
}

async function providerUsage(
  provider: PiSubscriptionProvider,
  checkedAt: string,
): Promise<PiUsageProvider> {
  try {
    return provider === "anthropic" ? await anthropicUsage(checkedAt) : await codexUsage(checkedAt);
  } catch (error) {
    // Never let one provider's network hiccup or shape change take down the
    // panel; the other card, and the rest of Settings, must still render.
    const message = error instanceof Error ? error.message : String(error);
    return problem(provider, checkedAt, "error", message.slice(0, 300));
  }
}

let cached: { at: number; overview: PiUsageOverview } | null = null;
let inflight: Promise<PiUsageOverview> | null = null;

/**
 * Usage for every Cora subscription. Providers that are not connected come back
 * as `not_connected` rather than being omitted, so the UI can say so instead of
 * silently showing nothing.
 */
export function inspectPiSubscriptionUsage(force = false): Promise<PiUsageOverview> {
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return Promise.resolve(cached.overview);
  }
  // A forced read (the Refresh button) must not be satisfied by a non-forced
  // read already in flight — it supersedes it, and the superseded promise's
  // late result is discarded via the inflight check below.
  if (inflight && !force) return inflight;
  // `let … = null` (not const): the closure compares against `work` to detect
  // being superseded by a forced re-read, and TS rejects a const IIFE result
  // referenced from its own initializer. The comparison only runs after the
  // first await, by which point the assignment below has completed.
  let work: Promise<PiUsageOverview> | null = null;
  work = (async (): Promise<PiUsageOverview> => {
    const checkedAt = new Date().toISOString();
    const providers = await Promise.all([
      providerUsage("anthropic", checkedAt),
      providerUsage("openai-codex", checkedAt),
    ]);
    const overview: PiUsageOverview = { checkedAt, providers };
    if (inflight === work) cached = { at: Date.now(), overview };
    return overview;
  })();
  inflight = work;
  void work.finally(() => {
    if (inflight === work) inflight = null;
  });
  return work;
}

/** Drop the cache so the next read is live — used after a connect/disconnect. */
export function invalidatePiSubscriptionUsageCache(): void {
  cached = null;
}
