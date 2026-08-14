// The ceiling a Cora conversation actually reaches before something compacts
// it. Shared by main and the renderer so the composer's context meter, the
// manager-level auto-compaction trigger, and the Pi launch plan cannot drift
// apart.
//
// Cora's Pi sessions compact far earlier than Pi's own trigger. Pi compacts at
// contextWindow - 16384, which is ~984k on the 1M-window models; the bundled
// extension (resources/pi-cora/compaction.ts) adds an earlier trigger at
// ~256k. The effective trigger is the SMALLER of the two, so the extension can
// only ever compact earlier, never later.
//
// resources/pi-cora cannot import from src, so the extension keeps its own
// copy of these two numbers. scripts/test-pi-cora-extension.cjs asserts all
// three copies (here, orchestration/pi-runtime.ts, and the extension) agree.

import type { ChatBackendKind } from "./types";

/** Codara's default early-compaction trigger, in context tokens. */
export const DEFAULT_PI_COMPACT_AT_TOKENS = 256_000;

/** Pi 0.84.2 fires its own threshold compaction at contextWindow minus this. */
export const PI_BUILTIN_COMPACT_HEADROOM_TOKENS = 16_384;

/**
 * Read a configured trigger (the CODARA_PI_COMPACT_AT_TOKENS override).
 * Absurd values (empty, 0, negative, NaN, non-numeric) fall back to the
 * default rather than disabling compaction or compacting on every turn.
 */
export function resolveCompactAtTokens(raw: string | number | undefined | null): number {
  const value = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_PI_COMPACT_AT_TOKENS;
  }
  return Math.floor(value);
}

/**
 * min(Codara's threshold, Pi's own trigger): never claim a ceiling later than
 * the one Pi would enforce itself. A context window at or below the headroom
 * has no meaningful Pi trigger, so the threshold stands alone.
 */
export function effectiveCompactionCapTokens(
  contextWindowTokens: number | null | undefined,
  thresholdTokens: number = DEFAULT_PI_COMPACT_AT_TOKENS,
): number {
  const piTrigger =
    typeof contextWindowTokens === "number" && Number.isFinite(contextWindowTokens)
      ? contextWindowTokens - PI_BUILTIN_COMPACT_HEADROOM_TOKENS
      : 0;
  return piTrigger > 0 ? Math.min(thresholdTokens, piTrigger) : thresholdTokens;
}

/**
 * The capacity a chat's context meter and auto-compaction trigger both measure
 * against.
 *
 * Only Pi-backed chats load Codara's compaction extension. The claude and
 * codex manager backends drive the real CLIs, which compact on their own terms,
 * so those chats keep reading against the model's full window.
 */
export function chatContextCapacityTokens(input: {
  contextWindowTokens: number;
  backend: ChatBackendKind;
  /** The stamped CODARA_PI_COMPACT_AT_TOKENS for this session, when known. */
  compactAtTokens?: number | null;
}): number {
  if (input.backend !== "pi") return input.contextWindowTokens;
  const threshold =
    typeof input.compactAtTokens === "number" && input.compactAtTokens > 0
      ? input.compactAtTokens
      : DEFAULT_PI_COMPACT_AT_TOKENS;
  const cap = effectiveCompactionCapTokens(input.contextWindowTokens, threshold);
  // A model whose whole window is smaller than the cap can never reach it.
  return Math.min(cap, input.contextWindowTokens);
}
