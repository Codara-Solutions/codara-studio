// Which Cora models can run fast, and what the composer says about it.
//
// Fast mode is one global setting (AppSettings.openAiFastMode; the key is kept
// so existing settings files carry over). It applies only to Codex models
// (OpenAI `gpt-*` on the ChatGPT subscription): the manager and every worker
// it launches on such a model run fast, and every other model, Claude
// included, always runs at standard speed. The request shaping lives in
// resources/pi-cora/service-tier.ts, which cannot import from here (it is
// loaded by Pi, outside the app bundle).

/**
 * Prefix of the error text the Pi extension writes when a provider declines
 * fast mode and the request is retried at standard speed. pi-turn.ts and the
 * worker pane recognize it to show a plain note instead of a provider error.
 */
export const FAST_MODE_FALLBACK_MARKER = "[codara-fast-fallback]";

export const FAST_MODE_COST_NOTE = "Fast costs more: OpenAI bills it at 2x.";

/** Whether a Cora model is a Codex model, the only kind that can run fast. */
export function fastModeAvailableFor(model: string | undefined): boolean {
  return (model ?? "").trim().toLowerCase().startsWith("gpt-");
}

/**
 * The note for a request the Pi extension is retrying at standard speed after
 * the provider declined fast mode, or null for any other retry.
 */
export function fastModeFallbackNote(errorMessage: unknown): string | null {
  if (typeof errorMessage !== "string" || !errorMessage.startsWith(FAST_MODE_FALLBACK_MARKER)) {
    return null;
  }
  const detail = errorMessage.slice(FAST_MODE_FALLBACK_MARKER.length).trim()
    .replace(/,? so you can retry your request\.?$/, ".");
  return `${detail} Retrying now.`;
}
