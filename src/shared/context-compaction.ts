// The ceiling a Cora conversation actually reaches before something compacts
// it. Shared by the operational auto-compaction paths so the manager-level
// trigger and the Pi launch plan cannot drift apart.
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

/** Codara's default early-compaction trigger, in context tokens. */
export const DEFAULT_PI_COMPACT_AT_TOKENS = 256_000;

/** Pi 0.84.4 fires its own threshold compaction at contextWindow minus this. */
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
 * The operational capacity an auto-compaction trigger measures against. Every
 * chat is Pi-backed and loads Codara's compaction extension, so the ceiling is
 * always the compaction cap, never the raw model window.
 */
export function chatContextCapacityTokens(input: {
  contextWindowTokens: number;
  /** The CODARA_PI_COMPACT_AT_TOKENS override for this session, when set. */
  compactAtTokens?: number | null;
  /** The user's auto-compact percentage; null or absent is Auto. */
  percent?: number | null;
}): number {
  const cap = autoCompactLimitTokens({
    contextWindowTokens: input.contextWindowTokens,
    percent: input.percent,
    overrideTokens: input.compactAtTokens,
  });
  // A model whose whole window is smaller than the cap can never reach it.
  return Math.min(cap, input.contextWindowTokens);
}

// ---------------------------------------------------------------------------
// The user's auto-compact limit (Settings > Behavior).
//
// Stored as a percentage of the model's context window so one choice fits a
// 128k model and a 1M model alike. null is Auto: the 256k-capped default
// above, which keeps the previous behaviour for everyone who never opens the
// setting. The same percentage reaches every runtime per launch: Pi sessions
// (manager and workers) through CODARA_PI_COMPACT_PERCENT, Claude Code
// terminals through CLAUDE_AUTOCOMPACT_PCT_OVERRIDE and Codex terminals
// through `-c model_auto_compact_token_limit`. Nothing is ever written to a
// CLI's own config.

/** The choices Settings offers. Anything else in the file is normalized. */
export const AUTO_COMPACT_PERCENT_CHOICES = [50, 60, 70, 75, 80, 85, 90] as const;
export const MIN_AUTO_COMPACT_PERCENT = 30;
export const MAX_AUTO_COMPACT_PERCENT = 95;

/**
 * No limit goes below this. Pi keeps about 20k tokens of recent turns verbatim
 * through every compaction, so a smaller ceiling would compact again on the
 * very next tool round and never make progress.
 */
export const MIN_COMPACT_AT_TOKENS = 48_000;

/** null (Auto) for anything that is not a whole percentage Codara supports. */
export function normalizeAutoCompactPercent(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() ? Number(value.trim()) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed);
  if (rounded < MIN_AUTO_COMPACT_PERCENT || rounded > MAX_AUTO_COMPACT_PERCENT) return null;
  return rounded;
}

/**
 * The developer override CODARA_PI_COMPACT_AT_TOKENS, or null when it is not
 * set. Unlike resolveCompactAtTokens this keeps "unset" distinguishable from
 * "set to the default", which is what lets the user's percentage apply.
 */
export function compactAtOverrideTokens(raw: string | number | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string" && !raw.trim()) return null;
  const value = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

/**
 * Context tokens at which a session on this model compacts. Precedence: the
 * developer token override, then the user's percentage, then Auto. Never later
 * than Pi's own trigger and never below MIN_COMPACT_AT_TOKENS (unless the
 * window itself is smaller).
 */
export function autoCompactLimitTokens(input: {
  contextWindowTokens: number | null | undefined;
  percent?: number | null;
  overrideTokens?: number | null;
}): number {
  const window =
    typeof input.contextWindowTokens === "number" &&
    Number.isFinite(input.contextWindowTokens) &&
    input.contextWindowTokens > 0
      ? input.contextWindowTokens
      : null;
  const override = compactAtOverrideTokens(input.overrideTokens);
  if (override !== null) return effectiveCompactionCapTokens(window, override);
  const percent = normalizeAutoCompactPercent(input.percent);
  if (percent === null || window === null) {
    return effectiveCompactionCapTokens(window, DEFAULT_PI_COMPACT_AT_TOKENS);
  }
  const piTrigger = window - PI_BUILTIN_COMPACT_HEADROOM_TOKENS;
  const ceiling = piTrigger > 0 ? piTrigger : window;
  const floor = Math.min(MIN_COMPACT_AT_TOKENS, ceiling);
  return Math.min(Math.max(Math.floor((window * percent) / 100), floor), ceiling);
}

/**
 * The context_window Codex CLI 0.162 ships for its GPT-5 family. The API
 * window in context-window.ts is larger, and a token limit priced off it
 * would sit past the point where Codex compacts on its own.
 */
export const CODEX_CLI_CONTEXT_WINDOW_TOKENS = 272_000;

/**
 * Value for CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (Claude Code reads it as a
 * percentage of its own effective window), or null to leave Claude on its own
 * default. Claude ignores values above its default threshold, so a high
 * percentage cannot delay compaction.
 */
export function claudeAutoCompactPercentEnv(percent: number | null | undefined): string | null {
  const normalized = normalizeAutoCompactPercent(percent);
  return normalized === null ? null : String(normalized);
}

/**
 * Value for Codex's `-c model_auto_compact_token_limit=<tokens>`, or null to
 * leave Codex on its own default.
 */
export function codexAutoCompactTokenLimit(
  percent: number | null | undefined,
  contextWindowTokens?: number | null,
): number | null {
  const normalized = normalizeAutoCompactPercent(percent);
  if (normalized === null) return null;
  const window = Math.min(
    typeof contextWindowTokens === "number" && contextWindowTokens > 0
      ? contextWindowTokens
      : CODEX_CLI_CONTEXT_WINDOW_TOKENS,
    CODEX_CLI_CONTEXT_WINDOW_TOKENS,
  );
  return Math.max(
    Math.floor((window * normalized) / 100),
    Math.min(MIN_COMPACT_AT_TOKENS, window),
  );
}
