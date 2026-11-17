import type { PiRpcEvent } from "./pi-rpc-client";

/**
 * A cache warm Pi sent on its own (settings `cacheWarming`): Pi records it as
 * a `usage` entry of kind `cache_warm` and streams it as `entry_appended`.
 * It is a billed request like any other, so Codara counts it in the run's
 * tokens and cost. Null for every other event.
 */
export function cacheWarmEntry(event: PiRpcEvent): Record<string, unknown> | null {
  if (event.type !== "entry_appended") return null;
  const entry = event.entry;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  return record.type === "usage" && record.kind === "cache_warm" ? record : null;
}

export function piWorkerMessageUsage(
  event: PiRpcEvent,
): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } | null {
  const warm = cacheWarmEntry(event);
  if (event.type !== "message_end" && event.type !== "compaction_end" && !warm) return null;
  const payload = warm ?? (event.type === "compaction_end" ? event.result : event.message);
  const message = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const usage = message?.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
    ? message.usage as Record<string, unknown>
    : null;
  if (!usage) return null;
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  const cost = usage.cost && typeof usage.cost === "object" && !Array.isArray(usage.cost)
    ? usage.cost as Record<string, unknown>
    : null;
  return {
    input: count(usage.input ?? usage.inputTokens ?? usage.input_tokens),
    output: count(usage.output ?? usage.outputTokens ?? usage.output_tokens),
    cacheRead: count(usage.cacheRead ?? usage.cache_read ?? usage.cached),
    cacheWrite: count(usage.cacheWrite ?? usage.cache_write ?? usage.cacheCreation),
    // Pi prices each request from its model catalog. The caller accepts this
    // field only for OpenRouter sessions; native subscription catalog prices
    // are API-equivalent estimates, not charges on the user's plan.
    cost: count(cost?.total),
  };
}

