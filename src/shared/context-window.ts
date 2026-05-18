export type ContextWindowSource = "known" | "default";

export interface ContextWindowInfo {
  tokens: number;
  source: ContextWindowSource;
}

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

const KNOWN_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/claude-(opus|sonnet|haiku)/i, 200_000],
  [/anthropic\/claude/i, 200_000],
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

export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateImageTokens(): number {
  return 1_500;
}
