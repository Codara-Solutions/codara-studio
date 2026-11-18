export type ContextWindowSource = "known" | "default";

export interface ContextWindowInfo {
  tokens: number;
  source: ContextWindowSource;
}

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

const KNOWN_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  // Sourced from the pinned Pi runtime's model catalog (@earendil-works/pi-ai
  // providers/data/anthropic.json: claude-fable-5 contextWindow 1000000).
  [/claude-fable/i, 1_000_000],
  [/claude-(opus|sonnet|haiku)/i, 200_000],
  [/anthropic\/claude/i, 200_000],
  // Codara runs GPT-6.2 through Codex on the ChatGPT subscription, where
  // OpenAI's Codex model list serves 500K for Sol and 272K for Astra (the API
  // pages list 1.05M, a window the Codex route does not offer), as does the
  // pi.dev catalog Pi reads: https://pi.dev/api/models/providers/openai-codex
  [/gpt-6\.2-sol/i, 500_000],
  [/gpt-6\.2-astra/i, 272_000],
  [/gpt-5/i, 400_000],
  [/openai\/gpt-5/i, 400_000],
  [/gpt-4\.1/i, 1_000_000],
  [/openai\/gpt-4\.1/i, 1_000_000],
  [/gpt-4o/i, 128_000],
  [/openai\/gpt-4o/i, 128_000],
  [/gemini-.*(1m|pro)/i, 1_000_000],
  [/google\/gemini/i, 1_000_000],
  [/grok-4/i, 256_000],
  [/x-ai\/grok/i, 256_000],
];

export function contextWindowForModel(model: string | undefined | null): ContextWindowInfo {
  const id = (model ?? "").trim();
  for (const [pattern, tokens] of KNOWN_CONTEXT_WINDOWS) {
    if (pattern.test(id)) return { tokens, source: "known" };
  }
  return { tokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: "default" };
}
