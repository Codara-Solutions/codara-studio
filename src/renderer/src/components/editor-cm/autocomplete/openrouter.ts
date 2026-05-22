// Inline-completion request — proxies through the main process so we
// bypass renderer-side CORS. The actual OpenRouter fetch lives in
// src/main/inline-ai.ts. Keeping this file as a thin renderer adapter
// preserves the existing call site (inlineExtension.ts) without churn.
//
// We pass an AbortSignal in for symmetry with the old direct-fetch API.
// On abort, we fire `inline-ai:abort` IPC so main can cancel its fetch
// — the renderer Promise then rejects with a synthetic AbortError so
// the caller can detect and skip stale work.

export interface CompletionRequest {
  prefix: string;
  suffix: string;
  filename: string | null;
  language: string | null;
}

export interface OpenRouterCompletionDeps {
  modelId: string;
}

let nextId = 1;
function generateRequestId(): string {
  return `inline-${Date.now()}-${nextId++}`;
}

export async function requestOpenRouterCompletion(
  req: CompletionRequest,
  deps: OpenRouterCompletionDeps,
  signal: AbortSignal,
): Promise<string> {
  // The apiKey arg is no longer read here (main reads from settings.json
  // server-side), but we still gate on an empty modelId to keep behaviour
  // identical to the old direct-fetch path.
  if (!deps.modelId) return "";

  // Defensive: a stale preload (Ctrl+R reload after the IPC handler was
  // added but before a full app restart) wouldn't have window.spark.inlineAi.
  // Throw a recognisable error so the inline-ai status badge surfaces it
  // instead of crashing the renderer.
  if (!window.spark.inlineAi || typeof window.spark.inlineAi.complete !== "function") {
    throw new Error("Preload not refreshed — restart Spark Agent");
  }

  const requestId = generateRequestId();
  const onAbort = () => {
    void window.spark.inlineAi.abort(requestId).catch(() => undefined);
  };
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await window.spark.inlineAi.complete({
      prefix: req.prefix,
      suffix: req.suffix,
      filename: req.filename,
      language: req.language,
      modelId: deps.modelId,
      requestId,
    });
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (response.error && response.error !== "aborted") {
      throw new Error(response.error);
    }
    return response.text;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
