// Hardcoded OpenRouter model price table.
//
// USD cost per 1,000,000 tokens for each pricing dimension. Numbers reflect
// OpenRouter's published listed prices for the manager-model roster Codara
// actually uses today (see `manager-profile.json` + `openrouter-manager.ts`).
// They drift; treat this table as a starting estimate, not a billing source
// of truth. To update:
//   1. Visit https://openrouter.ai/models and find the model slug.
//   2. Replace the {input,output,cacheRead} values below.
//   3. Add new entries when a worker/manager model is introduced.
// Unknown models default to zero cost — the call is still tracked (token
// counts populate the SparkCall record) so we never silently lose data.
//
// `cacheRead` covers Anthropic-style prompt-cache hits. OpenRouter normalizes
// the field name; we read it as `cache_read_input_tokens` (the Anthropic
// shape) and `cache_discount` (their summarized rebate field) when present.

import type { WorkerRuntime } from "@shared/types";

export interface ModelPrice {
  /** USD per 1M input tokens (the prompt). */
  input: number;
  /** USD per 1M output tokens (the completion). */
  output: number;
  /**
   * USD per 1M cache-read input tokens. Optional — only meaningful for models
   * that report a separate cached-prompt rate (Anthropic Sonnet/Opus/Haiku do;
   * many open-weights models don't bill caching separately). When omitted we
   * fall back to billing cached reads at the normal `input` rate.
   */
  cacheRead?: number;
}

// Source: https://openrouter.ai/models (snapshotted 2026-05). Update when a
// vendor changes prices or Codara starts using a new model.
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic — Claude 4.x family.
  "anthropic/claude-opus-4-8": { input: 15, output: 75, cacheRead: 1.5 },
  "anthropic/claude-opus-4-7": { input: 15, output: 75, cacheRead: 1.5 },
  "anthropic/claude-opus-4": { input: 15, output: 75, cacheRead: 1.5 },
  "anthropic/claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "anthropic/claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3 },
  "anthropic/claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3 },
  "anthropic/claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3 },
  "anthropic/claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },

  // OpenAI — GPT-5 / GPT-4o roster.
  "openai/gpt-5.5": { input: 1.25, output: 10 },
  "openai/gpt-5.4": { input: 1.25, output: 10 },
  "openai/gpt-5.4-mini": { input: 0.25, output: 2 },
  "openai/gpt-5.3-codex": { input: 1.25, output: 10 },
  "openai/gpt-4o": { input: 2.5, output: 10 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },

  // Google — Gemini 2.x / 3.x.
  "google/gemini-2.5-pro": { input: 1.25, output: 10 },
  "google/gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "google/gemini-3.5-flash": { input: 0.3, output: 2.5 },
  "google/gemini-3.5-flash:nitro": { input: 0.3, output: 2.5 },
  "google/gemini-3.1-flash-lite": { input: 0.075, output: 0.3 },
  "google/gemini-flash-latest": { input: 0.3, output: 2.5 },

  // x.ai — Grok.
  "x-ai/grok-4": { input: 5, output: 15 },
  "x-ai/grok-4.3": { input: 5, output: 15 },

  // Z.ai — GLM (a popular nitro alias).
  "z-ai/glm-4.7:nitro": { input: 0.5, output: 1.5 },
};

// Shape of the OpenRouter `response.usage` object — we accept several common
// field names because OpenRouter normalizes upstream provider keys at the
// router and the exact spelling drifts (input_tokens vs prompt_tokens, etc.).
export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  cache_creation_input_tokens?: number;
  total_tokens?: number;
}

export interface PricedCallOutcome {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

/**
 * Price a single OpenRouter completion. Returns zeroed cost (but valid token
 * counts) when the model isn't in the table or the response carried no usage
 * block. Never throws — pricing must not break a working manager call.
 */
export function priceCall(input: {
  model: string;
  usage: OpenRouterUsage | null | undefined;
}): PricedCallOutcome {
  const usage = input.usage ?? {};
  const inputTokens = numberOr(usage.input_tokens, numberOr(usage.prompt_tokens, 0));
  const outputTokens = numberOr(usage.output_tokens, numberOr(usage.completion_tokens, 0));
  // OpenRouter exposes Anthropic's cache-read counter directly when available,
  // and OpenAI's `prompt_tokens_details.cached_tokens` for OpenAI-family
  // models. Prefer whichever the response actually carried; default undefined
  // so we don't fabricate a zero on providers that don't bill caching.
  const cacheReadTokens = pickCacheReadTokens(usage);

  const price = MODEL_PRICES[normalizeModelKey(input.model)];
  if (!price) {
    // Unknown model — surface tokens, leave cost at zero so the UI shows
    // $0.00 instead of a confidently-wrong number. Logged at the call site.
    return {
      costUsd: 0,
      inputTokens,
      outputTokens,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    };
  }

  // Subtract cached input tokens from the billed-at-full-rate count when the
  // model has a dedicated `cacheRead` rate. Without that subtraction we'd
  // double-bill the cache hit at both the input rate and the cacheRead rate.
  const billedInputTokens =
    cacheReadTokens !== undefined && price.cacheRead !== undefined
      ? Math.max(0, inputTokens - cacheReadTokens)
      : inputTokens;
  const cacheReadCost =
    cacheReadTokens !== undefined && price.cacheRead !== undefined
      ? (cacheReadTokens / 1_000_000) * price.cacheRead
      : 0;
  const inputCost = (billedInputTokens / 1_000_000) * price.input;
  const outputCost = (outputTokens / 1_000_000) * price.output;
  const total = inputCost + outputCost + cacheReadCost;

  return {
    // Round to 6 decimals — sub-thousandths-of-a-cent precision is meaningless
    // for users but lets a 100-call aggregate stay accurate to four decimals.
    costUsd: Number.isFinite(total) ? Math.round(total * 1_000_000) / 1_000_000 : 0,
    inputTokens,
    outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pickCacheReadTokens(usage: OpenRouterUsage): number | undefined {
  if (typeof usage.cache_read_input_tokens === "number") return usage.cache_read_input_tokens;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (typeof cached === "number") return cached;
  return undefined;
}

// OpenRouter accepts model ids with optional variant suffixes (`:nitro`,
// `:floor`, `@max`, etc.). The price is keyed off the base slug for most
// variants — strip `@<effort>` first because that's a Codara-internal marker.
// `:nitro` is route-specific and we *do* want to look it up specifically when
// listed in the table, so try the exact id first before falling back.
function normalizeModelKey(model: string): string {
  const trimmed = model.trim();
  if (MODEL_PRICES[trimmed]) return trimmed;
  const withoutEffort = trimmed.replace(/@.+$/, "");
  if (MODEL_PRICES[withoutEffort]) return withoutEffort;
  const withoutVariant = withoutEffort.replace(/:.+$/, "");
  return withoutVariant;
}

// Map a worker runtime (+ optional model hint) to a MODEL_PRICES key. Workers
// run inside the Claude Code / Codex CLIs, so we never see a clean OpenRouter
// slug for them — only a runtime tag and, sometimes, a Codara-internal model
// hint like `claude-sonnet-4-6@medium`. This bridges that gap by reconstructing
// the provider-prefixed slug the price table is keyed on.
//
//   claude -> `anthropic/<base>` (base defaults to 'claude-opus-4-8')
//   codex  -> `openai/<base>`    (base defaults to 'gpt-5.5')
//
// Any `@<effort>` suffix on the hint is stripped first. We return the fully
// reconstructed key only when it exists in MODEL_PRICES; failing that we retry
// the provider-prefixed *default* base; otherwise undefined (unknown runtimes
// like 'shell'/'manual', or a hint we can't price). Like `priceCall`, callers
// treat an undefined/zero result as "untracked", not an error.
export function priceKeyForWorker(
  runtime: WorkerRuntime,
  modelHint?: string,
): string | undefined {
  let provider: string;
  let defaultBase: string;
  if (runtime === "claude") {
    provider = "anthropic";
    defaultBase = "claude-opus-4-8";
  } else if (runtime === "codex") {
    provider = "openai";
    defaultBase = "gpt-5.5";
  } else {
    // 'shell' / 'manual' workers don't bill against a model — nothing to price.
    return undefined;
  }

  // run-store stores hints like 'claude-sonnet-4-6@medium'; the `@effort`
  // suffix is a Codara-internal marker, not part of any OpenRouter slug.
  const base = (modelHint ?? "").trim().replace(/@.+$/, "") || defaultBase;

  const key = `${provider}/${base}`;
  if (MODEL_PRICES[key]) return key;
  // Hint didn't resolve (typo, retired model, or a model we don't list) — fall
  // back to the provider's default base so a known runtime still gets a price.
  const defaultKey = `${provider}/${defaultBase}`;
  if (MODEL_PRICES[defaultKey]) return defaultKey;
  return undefined;
}

// Estimate a single worker attempt's USD cost from the price table.
//
// COARSE ESTIMATE — NOT A BILLING SOURCE. Worker token usage isn't captured
// live (the work happens inside the Claude Code / Codex CLIs, out of band of
// the OpenRouter manager loop), so unless a `usage` block is handed in we can
// only multiply the table rate by caller-supplied token *guesses*. Treat the
// result the same way the rest of this file treats its prices: a directional
// number for the UI, drifting and approximate, never a ledger entry.
//
// When `usage` is present we price it through the exact same
// input/output/cacheRead math as `priceCall` so the two stay consistent.
// Otherwise we fall back to `estimatedInputTokens`/`estimatedOutputTokens`
// (whatever defaults the caller chose). Unknown/unpriceable workers return 0.
// Never throws.
export function estimateWorkerCostUsd(input: {
  runtime: WorkerRuntime;
  modelHint?: string;
  usage?: OpenRouterUsage | null;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}): number {
  const key = priceKeyForWorker(input.runtime, input.modelHint);
  if (!key) return 0;
  const price = MODEL_PRICES[key];
  if (!price) return 0;

  let total: number;
  if (input.usage) {
    // Mirror `priceCall`: same field-name fallbacks and cache-read handling so
    // a measured worker cost lines up with a measured manager cost.
    const usage = input.usage;
    const inputTokens = numberOr(usage.input_tokens, numberOr(usage.prompt_tokens, 0));
    const outputTokens = numberOr(usage.output_tokens, numberOr(usage.completion_tokens, 0));
    const cacheReadTokens = pickCacheReadTokens(usage);
    const billedInputTokens =
      cacheReadTokens !== undefined && price.cacheRead !== undefined
        ? Math.max(0, inputTokens - cacheReadTokens)
        : inputTokens;
    const cacheReadCost =
      cacheReadTokens !== undefined && price.cacheRead !== undefined
        ? (cacheReadTokens / 1_000_000) * price.cacheRead
        : 0;
    const inputCost = (billedInputTokens / 1_000_000) * price.input;
    const outputCost = (outputTokens / 1_000_000) * price.output;
    total = inputCost + outputCost + cacheReadCost;
  } else {
    // No measured usage — fall back to the caller's token estimates times the
    // table rate. No cache-read term: an estimate can't know the cache hit.
    const inputTokens = numberOr(input.estimatedInputTokens, 0);
    const outputTokens = numberOr(input.estimatedOutputTokens, 0);
    const inputCost = (inputTokens / 1_000_000) * price.input;
    const outputCost = (outputTokens / 1_000_000) * price.output;
    total = inputCost + outputCost;
  }

  // Round to 6 decimals, matching `priceCall`'s aggregation precision.
  return Number.isFinite(total) ? Math.round(total * 1_000_000) / 1_000_000 : 0;
}
