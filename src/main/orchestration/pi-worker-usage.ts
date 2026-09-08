import type { PiRpcEvent } from "./pi-rpc-client";

export function piWorkerMessageUsage(
  event: PiRpcEvent,
): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } | null {
  if (event.type !== "message_end" && event.type !== "compaction_end") return null;
  const payload = event.type === "compaction_end" ? event.result : event.message;
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

