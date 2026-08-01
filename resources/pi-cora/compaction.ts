// Early context compaction for Cora's Pi sessions (manager and workers).
//
// Pi compacts on its own at contextWindow - 16384 tokens. On the 1M-window
// Anthropic models that lands near 984k, which is far past the point where a
// Cora session is still cheap, fast, and recoverable. Codara wants ~256k.
//
// This trigger is ADDITIVE. Pi's built-in threshold compaction still runs as
// the backstop, and the effective trigger is min(Codara's threshold, Pi's own),
// so the extension can only ever compact EARLIER, never later. Nothing here
// touches Pi's CompactionSettings or a repo-local .pi/settings.json: that file
// is untrusted project input and stays out of the loop entirely.
//
// The decision is a pure function so scripts/test-pi-cora-extension.cjs can
// exercise it outside Pi's jiti loader, the same shape worker-policy.ts uses.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type CompactionEnv = Record<string, string | undefined>;

/** Codara's default early-compaction trigger, in context tokens. The launcher
 *  stamps the effective value into CODARA_PI_COMPACT_AT_TOKENS; this constant
 *  is the fallback when a session is started without it. */
export const DEFAULT_COMPACT_AT_TOKENS = 256000;

/** Pi 0.82.0 fires its own threshold compaction at contextWindow minus this. */
export const PI_BUILTIN_COMPACT_HEADROOM_TOKENS = 16384;

/** Read the configured trigger. Absurd values (empty, 0, negative, NaN, an
 *  overflowing string) fall back to the default rather than disabling
 *  compaction or compacting on every turn. */
export function resolveCompactAtTokens(
  env: CompactionEnv = process.env,
): number {
  const raw = env.CODARA_PI_COMPACT_AT_TOKENS?.trim();
  if (!raw) return DEFAULT_COMPACT_AT_TOKENS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_COMPACT_AT_TOKENS;
  return Math.floor(parsed);
}

/** min(Codara's threshold, Pi's own trigger): never delay Pi's compaction. */
export function effectiveCompactAtTokens(
  contextWindow: number | null | undefined,
  thresholdTokens: number,
): number {
  const piTrigger =
    typeof contextWindow === "number" && Number.isFinite(contextWindow)
      ? contextWindow - PI_BUILTIN_COMPACT_HEADROOM_TOKENS
      : 0;
  return piTrigger > 0 ? Math.min(thresholdTokens, piTrigger) : thresholdTokens;
}

export interface CompactionUsage {
  /** Null right after a compaction, before the next provider response. */
  tokens: number | null;
  contextWindow: number;
}

/** The whole decision: compact this session now, or leave it alone. */
export function shouldCompactNow(input: {
  usage: CompactionUsage | undefined;
  thresholdTokens: number;
  compactionInFlight: boolean;
}): boolean {
  if (input.compactionInFlight) return false;
  const usage = input.usage;
  if (!usage) return false;
  const { tokens } = usage;
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) return false;
  return tokens > effectiveCompactAtTokens(usage.contextWindow, input.thresholdTokens);
}

/** Wire the trigger onto a Pi session. Checked once per agent loop end, so a
 *  compaction is never requested mid-turn and the next check reads the usage
 *  the compaction actually produced instead of looping on a stale number. */
export function registerContextCompaction(
  pi: ExtensionAPI,
  env: CompactionEnv = process.env,
): void {
  const thresholdTokens = resolveCompactAtTokens(env);
  let compactionInFlight = false;

  pi.on("session_before_compact", () => {
    compactionInFlight = true;
  });
  pi.on("session_compact", () => {
    compactionInFlight = false;
  });

  pi.on("agent_end", (_event, ctx) => {
    if (
      !shouldCompactNow({
        usage: ctx.getContextUsage(),
        thresholdTokens,
        compactionInFlight,
      })
    ) {
      return;
    }
    // Latch before the call: compact() returns immediately and Pi's own
    // session_before_compact arrives asynchronously, so without this a second
    // agent_end could queue a duplicate compaction against the same context.
    compactionInFlight = true;
    try {
      ctx.compact({
        onComplete: () => {
          compactionInFlight = false;
        },
        onError: () => {
          compactionInFlight = false;
        },
      });
    } catch {
      // A refused compaction must not wedge the trigger off for the rest of
      // the session; Pi's own threshold remains the backstop either way.
      compactionInFlight = false;
    }
  });
}
