// Provider service-tier policy for every Cora Pi session (manager and worker).
//
// Pi 0.84.2 exposes no CLI flag, env var, or settings key for the OpenAI
// service tier, and Codara deliberately stays away from a repo-local
// .pi/settings.json (untrusted project input). The one seam Codara owns is the
// bundled extension's `before_provider_request` hook: pi-ai assembles the
// request body, then hands it to that hook and uses whatever comes back
// (pi-ai/dist/api/openai-codex-responses.js and anthropic-messages.js both call
// options.onPayload right after buildRequestBody/buildParams). That makes this
// the LAST code to touch the body before it goes out, and therefore the lowest
// chokepoint available for both setting and denying a tier.
//
// Two rules, and they are deliberately asymmetric:
//
//   OpenAI  - opt IN. The tier is applied only when Settings enables it. Pi
//             prices "priority" at 2x input/output (2.5x on gpt-5.5), so this
//             is real money and never a silent default.
//   Anthropic - always OFF, structurally. The guard STRIPS any service tier
//             from the payload rather than asking for a specific one. Stripping
//             cannot enable anything, cannot be flipped on by a prompt or a
//             future UI, and cannot break a request by adding a field the
//             ChatGPT/Claude subscription endpoint might reject. Pi never sets
//             a tier for Anthropic today, so this is a no-op in practice and a
//             standing guarantee in principle.
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

/** Field names a provider payload might carry a tier under. */
const SERVICE_TIER_KEYS = ["service_tier", "serviceTier"] as const;

export function isAnthropicProvider(provider: string | undefined): boolean {
  return (provider ?? "").trim().toLowerCase() === "anthropic";
}

export function isOpenAiProvider(provider: string | undefined): boolean {
  const id = (provider ?? "").trim().toLowerCase();
  return id === "openai-codex" || id === "openai" || id.startsWith("openai");
}

/** Whether Settings enabled the faster OpenAI tier for this session. */
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

/**
 * Apply the policy to one assembled provider request body. Mutates and returns
 * the payload; a non-object payload is passed through untouched so an
 * unexpected shape can never fail a turn.
 */
export function applyServiceTierPolicy(
  payload: unknown,
  provider: string,
  fastMode: boolean,
): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const body = payload as Record<string, unknown>;

  // Anthropic: unconditional. Not gated on fastMode, not gated on Settings,
  // and deliberately placed before the OpenAI branch so no future edit can
  // reach a tier-setting path for this provider.
  if (isAnthropicProvider(provider)) {
    stripServiceTier(body);
    return body;
  }

  if (isOpenAiProvider(provider)) {
    if (fastMode) body.service_tier = OPENAI_FAST_SERVICE_TIER;
    else stripServiceTier(body);
    return body;
  }

  // An unrecognized provider never gains a tier from Codara. Anything already
  // on the body is left alone: this policy only removes what it might have
  // added, and Pi sets none of these itself.
  return body;
}

/** Wire the policy onto a Pi session. */
export function registerServiceTierPolicy(
  pi: ExtensionAPI,
  env: ServiceTierEnv = process.env,
): void {
  const provider = activeProvider(env);
  const fastMode = fastModeEnabled(env);
  pi.on("before_provider_request", (event) =>
    applyServiceTierPolicy(event.payload, provider, fastMode),
  );
}
