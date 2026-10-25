// Which Cora models can run fast, and what the composer says about it.
//
// Fast mode is one global setting (AppSettings.openAiFastMode; the key predates
// Anthropic support and is kept so existing settings files carry over). It
// applies to the manager and to every worker it launches, on whichever of
// these models each process runs. The request shaping lives in
// resources/pi-cora/service-tier.ts, which cannot import from here (it is
// loaded by Pi, outside the app bundle); scripts/test-pi-cora-extension.cjs
// pins the two model lists equal.

/**
 * Anthropic models the API accepts `speed: "fast"` for (Anthropic's fast-mode
 * docs, 2026-10). Opus 4.7 and every Sonnet, Haiku and Fable reject it with an
 * error, so the list is an allowlist: a model missing here simply runs at
 * standard speed.
 */
export const ANTHROPIC_FAST_MODE_MODELS: readonly string[] = [
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
];

/** The beta header value Anthropic requires alongside `speed: "fast"`. */
export const ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01";

/**
 * Prefix of the error text the Pi extension writes when a provider declines
 * fast mode and the request is retried at standard speed. pi-turn.ts and the
 * worker pane recognize it to show a plain note instead of a provider error.
 */
export const FAST_MODE_FALLBACK_MARKER = "[codara-fast-fallback]";

export const FAST_MODE_COST_NOTE =
  "Fast costs more: OpenAI bills it at 2x, Claude bills it as extra usage at premium rates.";

function baseModelId(model: string | undefined): string {
  return (model ?? "").trim().toLowerCase().replace(/:1m$/, "");
}

export function modelIsOpenAi(model: string | undefined): boolean {
  return baseModelId(model).startsWith("gpt-");
}

export function anthropicModelSupportsFastMode(model: string | undefined): boolean {
  const id = baseModelId(model).replace(/-\d{8}$/, "");
  return ANTHROPIC_FAST_MODE_MODELS.includes(id);
}

export type FastModeSupport =
  | { supported: true }
  | { supported: false; reason: string };

/** Whether a Cora chat model can run fast, with the reason when it cannot. */
export function fastModeSupportFor(model: string | undefined): FastModeSupport {
  if (modelIsOpenAi(model) || anthropicModelSupportsFastMode(model)) {
    return { supported: true };
  }
  if (baseModelId(model).startsWith("claude-")) {
    return {
      supported: false,
      reason: "Fast mode runs only on Claude Opus 5.5, Opus 5 and Opus 4.8.",
    };
  }
  return { supported: false, reason: "This model has no fast mode." };
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
