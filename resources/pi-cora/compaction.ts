// Early context compaction for Cora's Pi sessions (manager and workers).
//
// Pi compacts on its own at contextWindow - 16384 tokens. On the 1M-window
// Anthropic models that lands near 984k, which is far past the point where a
// Cora session is still cheap, fast, and recoverable. Codara compacts at the
// user's limit (Settings > Behavior): a percentage of the window Pi reports
// for the running model, or ~256k on Auto.
//
// This trigger is ADDITIVE. Pi's built-in threshold compaction still runs as
// the backstop, and the effective trigger is min(Codara's threshold, Pi's own),
// so the extension can only ever compact EARLIER, never later. Nothing here
// touches Pi's CompactionSettings or a repo-local .pi/settings.json: that file
// is untrusted project input and stays out of the loop entirely.
//
// Hosted sessions pause at a tool-round boundary (turn_end, after every tool
// result of the round is in the transcript), so a compaction never lands in
// the middle of a tool call or a worker handoff, and never before the model
// has read the round that crossed the limit. The host then compacts and
// resumes the same task. Managers pause mid-turn the same way, so a long tool
// loop cannot outgrow the limit before its answer.
//
// Every compaction also folds the discarded turns into Codara's durable
// ledger (compaction-ledger.ts) and re-injects it right after, so the user's
// instructions, file states, errors and worker results survive any number of
// compactions word for word.
//
// The decision is a pure function so scripts/test-pi-cora-extension.cjs can
// exercise it outside Pi's jiti loader, the same shape worker-policy.ts uses.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DURABLE_STATE_CUSTOM_TYPE,
  deterministicCompactionSummary,
  latestLedgerIn,
  renderLedger,
  updateLedger,
  type DurableLedger,
  type LedgerMessage,
} from "./compaction-ledger";

export type CompactionEnv = Record<string, string | undefined>;

/** Codara's default early-compaction trigger, in context tokens. The launcher
 *  stamps the effective value into CODARA_PI_COMPACT_AT_TOKENS; this constant
 *  is the fallback when a session is started without it. */
export const DEFAULT_COMPACT_AT_TOKENS = 256000;

/** Pi 0.85.1 fires its own threshold compaction at contextWindow minus this. */
export const PI_BUILTIN_COMPACT_HEADROOM_TOKENS = 16384;

/** Copies of @shared/context-compaction's bounds; the extension test asserts
 *  they agree. */
export const MIN_COMPACT_AT_TOKENS = 48000;
export const MIN_AUTO_COMPACT_PERCENT = 30;
export const MAX_AUTO_COMPACT_PERCENT = 95;

/**
 * After a compaction the next one waits until the context has grown by this
 * much past its post-compaction size. Without it, a context whose kept turns
 * alone exceed the limit would compact on every tool round forever.
 */
export const MIN_REARM_GROWTH_TOKENS = 8000;
export const REARM_GROWTH_FRACTION = 0.1;

/** customInstructions carrying this marker ask the extension for a summary
 *  built without a model. The host sends it only after the summarizer failed
 *  twice; pi-compaction-pipeline.ts holds the same string. */
export const DETERMINISTIC_COMPACTION_MARKER = "[codara:deterministic-compaction]";

/** Tools whose round ends the manager's turn. Pausing after one would hand
 *  the turn a "continue the work" prompt: after a question to the user, a
 *  handed-off iteration or opened terminals, that invites work the user has
 *  not approved yet. agent_end compacts these turns once they settle. */
export const MANAGER_TURN_ENDING_TOOLS = new Set([
  "codara_complete",
  "codara_ask_user",
  "codara_request_next_iteration",
  "codara_spawn_terminals",
]);

/** Guidance appended to Pi's summary prompt (after Pi's own structured
 * format). The host sends the same text for the compactions it drives
 * (pi-compaction-pipeline.ts); this copy covers direct sessions. */
export const CORA_COMPACTION_INSTRUCTIONS = [
  "Write a dense continuation handoff for a long agentic task. Codara re-injects a durable state block",
  "(user instructions verbatim, files changed, errors, plan, workers) after this compaction, so make the",
  "summary carry the reasoning that block cannot. Under Constraints & Preferences quote every user",
  "requirement, explicit prohibition, and permitted tool or path word for word. Under Progress keep the plan",
  "with each step's status. Under Key Decisions give each decision with its reason. Add these sections:",
  "## Files (each file touched and its current state), ## Workers (each worker id, task, status, result),",
  "## Errors and fixes (each error with what fixed it, or unresolved), ## Open todos, ## Artifacts (exact",
  "paths, URLs, IDs). When updating a previous summary, carry every unresolved item forward unchanged and move",
  "items to Done only when the new messages show them done; never merge or paraphrase constraints. Preserve",
  "exact files, symbols, commands, IDs and error text. Remove repetition and stale exploration. Do not invent",
  "requirements or broaden permissions. Keep the newest CORA PROFILE and CORA MEMORY sections verbatim.",
].join(" ");

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

/** The user's percentage (CODARA_PI_COMPACT_PERCENT), or null for Auto. */
export function resolveCompactPercent(env: CompactionEnv = process.env): number | null {
  const raw = env.CODARA_PI_COMPACT_PERCENT?.trim();
  if (!raw) return null;
  const parsed = Math.round(Number(raw));
  if (!Number.isFinite(parsed) || parsed < MIN_AUTO_COMPACT_PERCENT || parsed > MAX_AUTO_COMPACT_PERCENT) return null;
  return parsed;
}

/** min(Codara's threshold, Pi's own trigger): never delay Pi's compaction.
 *  With a percentage the threshold is priced off the reported window. */
export function effectiveCompactAtTokens(
  contextWindow: number | null | undefined,
  thresholdTokens: number,
  percent: number | null = null,
): number {
  const window =
    typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : null;
  const piTrigger = window !== null ? window - PI_BUILTIN_COMPACT_HEADROOM_TOKENS : 0;
  if (percent !== null && window !== null) {
    const ceiling = piTrigger > 0 ? piTrigger : window;
    const floor = Math.min(MIN_COMPACT_AT_TOKENS, ceiling);
    return Math.min(Math.max(Math.floor((window * percent) / 100), floor), ceiling);
  }
  return piTrigger > 0 ? Math.min(thresholdTokens, piTrigger) : thresholdTokens;
}

/** Context tokens the next compaction waits for after one ran (or failed)
 *  with the context at `tokensAfter`. */
export function rearmAtTokens(tokensAfter: number, limitTokens: number): number {
  return tokensAfter + Math.max(MIN_REARM_GROWTH_TOKENS, Math.floor(limitTokens * REARM_GROWTH_FRACTION));
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
  percent?: number | null;
  /** Set after a compaction or a failed attempt: wait for growth past it. */
  rearmAt?: number | null;
  /** Tokens of the tool results the model has not read yet (the round that
   *  just finished). */
  unreadTokens?: number;
}): boolean {
  if (input.compactionInFlight) return false;
  const usage = input.usage;
  if (!usage) return false;
  const { tokens } = usage;
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) return false;
  if (typeof input.rearmAt === "number" && tokens < input.rearmAt) return false;
  const limit = effectiveCompactAtTokens(usage.contextWindow, input.thresholdTokens, input.percent ?? null);
  if (tokens <= limit) return false;
  // Pi keeps only a recent tail verbatim. When the limit was crossed by
  // results the model has not read, compacting now would fold output it never
  // saw into the summary, and a model that still needs it reruns the tool
  // straight into the same compaction. It reads them first; that request runs
  // one round past the limit.
  const unread = input.unreadTokens ?? 0;
  return !(unread > 0 && tokens - unread <= limit);
}

/** Pi's own estimate (characters / 4) of the tool results a round produced. */
export function unreadToolResultTokens(results: ReadonlyArray<{ content?: unknown }>): number {
  let chars = 0;
  for (const result of results) {
    if (typeof result.content === "string") {
      chars += result.content.length;
      continue;
    }
    if (!Array.isArray(result.content)) continue;
    for (const block of result.content) {
      const record = block as { type?: unknown; text?: unknown };
      if (record?.type === "text" && typeof record.text === "string") chars += record.text.length;
    }
  }
  return Math.ceil(chars / 4);
}

interface PreparationLike {
  firstKeptEntryId?: string;
  messagesToSummarize?: LedgerMessage[];
  turnPrefixMessages?: LedgerMessage[];
  previousSummary?: string;
  tokensBefore?: number;
  fileOps?: { edited?: Set<string>; written?: Set<string> };
}

/** Durable-state messages already in the session, for a restarted process. */
function ledgerMessagesFromEntries(entries: unknown): LedgerMessage[] {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const record = entry as { type?: string; customType?: string; details?: unknown; message?: LedgerMessage };
    if (record?.type === "custom_message" && record.customType === DURABLE_STATE_CUSTOM_TYPE) {
      return [{ role: "custom", customType: record.customType, details: record.details }];
    }
    if (record?.type === "message" && record.message?.role === "custom") return [record.message];
    return [];
  });
}

/** Hosted workers pause after a tool round; managers pause after a tool round
 *  too and otherwise finish their answer first. The host waits for
 *  settlement before compacting either kind of session. Standalone extension
 *  sessions retain the end-of-loop fallback. */
export function registerContextCompaction(
  pi: ExtensionAPI,
  env: CompactionEnv = process.env,
): void {
  const thresholdTokens = resolveCompactAtTokens(env);
  const percent = resolveCompactPercent(env);
  const hostMode = env.CODARA_PI_HOST_COMPACTION;
  // A worker's task contract comes back from the host after every compaction.
  const includeInstructions = hostMode !== "1";
  let compactionInFlight = false;
  let pauseRequested = false;
  let agentRunning = false;
  let awaitingBaseline = false;
  let rearmAt: number | null = null;
  let lastTokens: number | null = null;
  let lastLimit = thresholdTokens;
  let ledger: DurableLedger | null = null;
  let pendingLedger: DurableLedger | null = null;

  const limitFor = (usage: CompactionUsage | undefined): number =>
    effectiveCompactAtTokens(usage?.contextWindow, thresholdTokens, percent);

  // The first reading after a compaction is the context it left behind. Only
  // when that is still over the limit does the next compaction need to wait.
  const observe = (usage: CompactionUsage | undefined): void => {
    if (!usage || typeof usage.tokens !== "number") return;
    lastTokens = usage.tokens;
    lastLimit = limitFor(usage);
    if (!awaitingBaseline) return;
    awaitingBaseline = false;
    rearmAt = usage.tokens > lastLimit ? rearmAtTokens(usage.tokens, lastLimit) : null;
  };

  const decide = (usage: CompactionUsage | undefined, unreadTokens = 0): boolean => {
    observe(usage);
    return shouldCompactNow({ usage, thresholdTokens, compactionInFlight, percent, rearmAt, unreadTokens });
  };

  const requestPause = (usage: CompactionUsage | undefined, phase: "mid-turn" | "settled"): void => {
    compactionInFlight = true;
    pauseRequested = true;
    pi.appendEntry("codara-context-pause", {
      reason: "threshold",
      phase,
      tokens: usage?.tokens,
      thresholdTokens: limitFor(usage),
    });
  };

  pi.on("agent_start", () => {
    agentRunning = true;
    // A pause the host never acted on (an interrupt, a stopped run, nothing
    // left to compact) must not leave the trigger latched for the rest of the
    // process, nor fire again on the resumed turn's first tool round.
    if (pauseRequested) {
      pauseRequested = false;
      compactionInFlight = false;
      if (lastTokens !== null) rearmAt = rearmAtTokens(lastTokens, lastLimit);
    }
  });
  pi.on("agent_end", () => {
    agentRunning = false;
  });

  pi.on("session_before_compact", (event) => {
    compactionInFlight = true;
    pauseRequested = false;
    const preparation = (event as { preparation?: PreparationLike }).preparation ?? {};
    const discarded = [...(preparation.messagesToSummarize ?? []), ...(preparation.turnPrefixMessages ?? [])];
    const seed = ledger ?? latestLedgerIn(ledgerMessagesFromEntries((event as { branchEntries?: unknown }).branchEntries));
    pendingLedger = updateLedger(seed, discarded, { includeInstructions });
    pendingLedger.compactions += 1;
    const instructions = (event as { customInstructions?: string }).customInstructions ?? "";
    if (!instructions.includes(DETERMINISTIC_COMPACTION_MARKER) || !preparation.firstKeptEntryId) return;
    const modified = [...(preparation.fileOps?.edited ?? []), ...(preparation.fileOps?.written ?? [])];
    return {
      compaction: {
        summary: deterministicCompactionSummary({
          previousSummary: preparation.previousSummary,
          ledger: pendingLedger,
          messages: discarded,
        }),
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore ?? 0,
        details: { readFiles: [], modifiedFiles: [...new Set(modified)].sort(), codaraDeterministic: true },
      },
    };
  });

  pi.on("session_compact", () => {
    compactionInFlight = false;
    awaitingBaseline = true;
    rearmAt = null;
    if (!pendingLedger) return;
    ledger = pendingLedger;
    pendingLedger = null;
    // Mid-turn (Pi's own pre-response compaction) the state steers into the
    // very next request; otherwise it rides the next prompt, which for a
    // hosted session is the host's continuation.
    try {
      void Promise.resolve(
        pi.sendMessage(
          {
            customType: DURABLE_STATE_CUSTOM_TYPE,
            content: renderLedger(ledger),
            display: false,
            details: { ledger },
          },
          agentRunning ? undefined : { deliverAs: "nextTurn" },
        ),
      ).catch(() => undefined);
    } catch {
      // A lost injection only costs the reminder; the ledger stays in memory
      // and folds into the next compaction regardless.
    }
  });
  pi.on("session_compact_failed", () => {
    compactionInFlight = false;
    pendingLedger = null;
    // Retrying on the very next round would fail the same way; wait for growth.
    if (lastTokens !== null) rearmAt = rearmAtTokens(lastTokens, lastLimit);
  });

  if (hostMode === "1") {
    pi.on("turn_end", (event, ctx) => {
      if (!event.toolResults.length || event.toolResults.some((result) => result.toolName === "submit_result")) return;
      const usage = ctx.getContextUsage();
      if (!decide(usage, unreadToolResultTokens(event.toolResults))) return;
      // Every tool result is durable at turn_end. The host waits for the
      // resulting agent_settled before compacting and resuming this session.
      requestPause(usage, "mid-turn");
      ctx.abort();
    });
    return;
  }

  if (hostMode === "settled") {
    pi.on("turn_end", (event, ctx) => {
      // A round without tool calls is the answer itself; agent_end handles it.
      if (!event.toolResults.length) return;
      if (event.toolResults.some((result) => MANAGER_TURN_ENDING_TOOLS.has(result.toolName))) return;
      const usage = ctx.getContextUsage();
      if (!decide(usage, unreadToolResultTokens(event.toolResults))) return;
      requestPause(usage, "mid-turn");
      ctx.abort();
    });
    pi.on("agent_end", (_event, ctx) => {
      const usage = ctx.getContextUsage();
      if (!decide(usage)) return;
      requestPause(usage, "settled");
    });
    return;
  }

  pi.on("agent_end", (_event, ctx) => {
    if (!decide(ctx.getContextUsage())) return;
    // Latch before the call: compact() returns immediately and Pi's own
    // session_before_compact arrives asynchronously, so without this a second
    // agent_end could queue a duplicate compaction against the same context.
    compactionInFlight = true;
    try {
      ctx.compact({
        customInstructions: CORA_COMPACTION_INSTRUCTIONS,
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
