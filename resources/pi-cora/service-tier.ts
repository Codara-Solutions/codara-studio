// Fast-mode policy for every Cora Pi session (manager and worker).
//
// Pi 0.85.1 exposes no CLI flag, env var, or settings key for a provider's
// speed or service tier, and Codara deliberately stays away from a repo-local
// .pi/settings.json (untrusted project input). The one seam Codara owns is the
// bundled extension's `before_provider_request` hook: pi-ai assembles the
// request body, then hands it to that hook and uses whatever comes back
// (pi-ai/dist/api/openai-codex-responses.js and anthropic-messages.js both call
// options.onPayload right after buildRequestBody/buildParams). That makes this
// the LAST code to touch the body before it goes out, and therefore the only
// place that both sets and removes fast mode.
//
// Policy: one opt-in setting, default off, the same for every provider that
// has a fast mode, and inherited by every worker because each process reads
// the launch-time stamp (CODARA_PI_FAST_MODE) Codara gives it.
//
//   OpenAI    - `service_tier: "priority"` (OpenAI's Fast mode, 2x price).
//   Anthropic - `speed: "fast"` plus the `fast-mode-2026-02-01` beta, and only
//               on the models in ANTHROPIC_FAST_MODE_MODELS: every other
//               Claude model answers fast mode with an error. The SDK pi-ai
//               uses moves `betas` from the body into the anthropic-beta
//               header. On a Claude subscription this bills usage credits
//               (extra usage), on an API key the premium per-token rate.
//               Anthropic's `service_tier` (Priority Tier) is never sent: it
//               is a different product and fast mode excludes it.
//   Others    - untouched; nothing is ever added for them.
//
// With the setting off, anything fast-mode shaped is stripped, so fast mode
// cannot reach a request any other way.
//
// Fallback: when a request that carried fast mode fails with what looks like
// a refusal of it (unsupported model, fast rate limit or capacity, no usage
// credits), the model is marked declined, and the failed message's error text
// is rewritten so Pi's own auto-retry runs the request again, this time
// without fast mode. Exactly one retry pays for the probe; the marker prefix
// lets the host show a plain note instead of a provider error. Only a refusal
// whose text names fast mode (speed, tier, usage credits) lasts for the
// process. Rate-limit and capacity refusals, and errors that match on status
// alone and so may have nothing to do with fast mode, expire after
// FAST_MODE_COOLDOWN_MS, the way Claude Code's own fast mode cools down.
//
// Pure and import-free so scripts/test-pi-cora-extension.cjs can drive it
// outside Pi's jiti loader, matching worker-policy.ts and compaction.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ServiceTierEnv = Record<string, string | undefined>;

/**
 * The faster OpenAI tier.
 *
 * NOT AMBIGUOUS, AND NOT A BUG: OpenAI renamed "Priority processing" to "Fast
 * mode" on 2026-07-30, and the API accepts `service_tier` "priority" and
 * "fast" as aliases for the same tier (OpenAI's priority-processing guide).
 * Codex CLI's `service_tier = "fast"` in ~/.codex/config.toml is simply the
 * newer spelling. Codara sends "priority" because that is the spelling pi-ai
 * types (OpenAI Responses' service_tier union has no "fast" member) and the
 * one its cost table prices, at 2x input/output and 2.5x on gpt-5.5. Do not
 * "correct" this to "fast": it would buy nothing and would fall outside the
 * union pi-ai type-checks against.
 */
export const OPENAI_FAST_SERVICE_TIER = "priority";

/** Mirrors src/shared/fast-mode.ts; the extension test pins them equal. */
export const ANTHROPIC_FAST_MODE_MODELS: readonly string[] = [
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
];
export const ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01";
export const FAST_MODE_FALLBACK_MARKER = "[codara-fast-fallback]";
export const FAST_MODE_COOLDOWN_MS = 10 * 60_000;

/** Field names a provider payload might carry a tier under. */
const SERVICE_TIER_KEYS = ["service_tier", "serviceTier"] as const;

export function isAnthropicProvider(provider: string | undefined): boolean {
  return (provider ?? "").trim().toLowerCase() === "anthropic";
}

export function isOpenAiProvider(provider: string | undefined): boolean {
  const id = (provider ?? "").trim().toLowerCase();
  return id === "openai-codex" || id === "openai" || id.startsWith("openai");
}

export function anthropicModelSupportsFastMode(model: unknown): boolean {
  if (typeof model !== "string") return false;
  const id = model.trim().toLowerCase().replace(/:1m$/, "").replace(/-\d{8}$/, "");
  return ANTHROPIC_FAST_MODE_MODELS.includes(id);
}

/** Whether Settings enabled fast mode for this process. */
export function fastModeEnabled(env: ServiceTierEnv = process.env): boolean {
  return env.CODARA_PI_FAST_MODE === "1";
}

export function activeProvider(env: ServiceTierEnv = process.env): string {
  return (env.CODARA_PI_PROVIDER ?? "").trim();
}

function stripServiceTier(payload: Record<string, unknown>): void {
  for (const key of SERVICE_TIER_KEYS) {
    if (key in payload) delete payload[key];
  }
}

function stripAnthropicFastMode(payload: Record<string, unknown>): void {
  delete payload.speed;
  if (!Array.isArray(payload.betas)) return;
  const betas = payload.betas.filter((beta) => beta !== ANTHROPIC_FAST_MODE_BETA);
  if (betas.length > 0) payload.betas = betas;
  else delete payload.betas;
}

function addAnthropicFastMode(payload: Record<string, unknown>): void {
  payload.speed = "fast";
  const betas = Array.isArray(payload.betas) ? payload.betas : [];
  payload.betas = betas.includes(ANTHROPIC_FAST_MODE_BETA)
    ? betas
    : [...betas, ANTHROPIC_FAST_MODE_BETA];
}

/**
 * Apply the policy to one assembled provider request body. Mutates and returns
 * the payload; a non-object payload is passed through untouched so an
 * unexpected shape can never fail a turn. `declined` lists models fast mode
 * must skip because the provider refused it earlier in this process.
 */
export function applyServiceTierPolicy(
  payload: unknown,
  provider: string,
  fastMode: boolean,
  declined: (model: string) => boolean = () => false,
): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const body = payload as Record<string, unknown>;
  const model = typeof body.model === "string" ? body.model : "";

  if (isAnthropicProvider(provider)) {
    stripServiceTier(body);
    if (fastMode && anthropicModelSupportsFastMode(model) && !declined(model)) {
      addAnthropicFastMode(body);
    } else {
      stripAnthropicFastMode(body);
    }
    return body;
  }

  if (isOpenAiProvider(provider)) {
    if (fastMode && !declined(model)) body.service_tier = OPENAI_FAST_SERVICE_TIER;
    else stripServiceTier(body);
    return body;
  }

  // An unrecognized provider never gains anything from Codara. Anything
  // already on the body is left alone: Pi sets none of these itself.
  return body;
}

/** Whether a shaped body asks for fast mode, under either provider's spelling. */
export function requestsFastMode(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const body = payload as Record<string, unknown>;
  return body.speed === "fast" || body.service_tier === OPENAI_FAST_SERVICE_TIER;
}

// Failures that say nothing about fast mode. Retrying them without fast mode
// would only turn fast mode off for no reason.
const NOT_A_FAST_MODE_REFUSAL =
  /\b401\b|unauthori[sz]ed|authentication_error|invalid (?:x-)?api.?key|token (?:has )?expired|prompt is too long|request_too_large|context (?:window|length|size)|maximum context/i;
const FAST_MODE_REFUSAL =
  /\b(?:400|403|404|422|429|529)\b|speed|fast.?mode|service.?tier|priority|usage credits|extra usage|rate.?limit|too many requests|overloaded|invalid_request|not supported|unsupported/i;
const TRANSIENT_REFUSAL = /\b(?:429|529)\b|rate.?limit|too many requests|overloaded|capacity/i;
// A 400 for an oversized image or a malformed tool schema also matches on
// status; turning fast mode off for the whole process over it would cost the
// user the speed they pay for until the next relaunch.
const NAMES_FAST_MODE = /speed|fast.?mode|service.?tier|priority|usage credits|extra usage/i;

export type FastModeRefusal = { transient: boolean; status: string | null };

/** Classify the error of a request that carried fast mode. */
export function classifyFastModeRefusal(errorMessage: unknown): FastModeRefusal | null {
  if (typeof errorMessage !== "string" || !errorMessage.trim()) return null;
  if (errorMessage.startsWith(FAST_MODE_FALLBACK_MARKER)) return null;
  if (NOT_A_FAST_MODE_REFUSAL.test(errorMessage)) return null;
  if (!FAST_MODE_REFUSAL.test(errorMessage)) return null;
  const status = /\b([45]\d\d)\b/.exec(errorMessage)?.[1] ?? null;
  return {
    transient: TRANSIENT_REFUSAL.test(errorMessage) || !NAMES_FAST_MODE.test(errorMessage),
    status,
  };
}

/**
 * The error text that replaces a fast-mode refusal. It must read as retryable
 * to Pi's classifier ("you can retry your request" is one of its phrases) and
 * must not carry the provider's own wording, which may contain words such as
 * "billing" that Pi treats as never retryable.
 */
export function fastModeFallbackError(model: string, refusal: FastModeRefusal): string {
  const status = refusal.status ? ` (HTTP ${refusal.status})` : "";
  const scope = refusal.transient ? "for a few minutes" : "for this session";
  return `${FAST_MODE_FALLBACK_MARKER} ${model || "This model"} declined fast mode${status}; ` +
    `it runs at standard speed ${scope}, so you can retry your request.`;
}

/** Remembers which models refused fast mode in this process, and until when. */
export function createFastModeDeclines(now: () => number = Date.now) {
  const until = new Map<string, number>();
  return {
    declined(model: string): boolean {
      const expiry = until.get(model);
      if (expiry === undefined) return false;
      if (expiry > now()) return true;
      until.delete(model);
      return false;
    },
    decline(model: string, refusal: FastModeRefusal): void {
      until.set(model, refusal.transient ? now() + FAST_MODE_COOLDOWN_MS : Number.POSITIVE_INFINITY);
    },
  };
}

interface FailedAssistantMessage {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

/** Wire the policy and its fallback onto a Pi session. */
export function registerServiceTierPolicy(
  pi: ExtensionAPI,
  env: ServiceTierEnv = process.env,
  now: () => number = Date.now,
): void {
  const provider = activeProvider(env);
  const fastMode = fastModeEnabled(env);
  const declines = createFastModeDeclines(now);
  // Pi sends one provider request at a time per session, so the model of the
  // newest request is the one a following failure belongs to.
  let fastRequestModel: string | null = null;

  pi.on("before_provider_request", (event) => {
    const shaped = applyServiceTierPolicy(event.payload, provider, fastMode, declines.declined);
    const model = (shaped as { model?: unknown } | null)?.model;
    fastRequestModel = requestsFastMode(shaped) ? (typeof model === "string" ? model : "") : null;
    return shaped;
  });

  if (!fastMode) return;
  pi.on("message_end", (event) => {
    const message = event.message as FailedAssistantMessage;
    if (message.role !== "assistant") return;
    const model = fastRequestModel;
    fastRequestModel = null;
    if (model === null || message.stopReason !== "error") return;
    const refusal = classifyFastModeRefusal(message.errorMessage);
    if (!refusal) return;
    declines.decline(model, refusal);
    return {
      message: { ...event.message, errorMessage: fastModeFallbackError(model, refusal) },
    } as { message: typeof event.message };
  });
}
