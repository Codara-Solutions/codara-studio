// The compaction request Codara sends to a Pi session it hosts (the manager's
// mid-turn and post-turn compactions, every worker compaction), with its
// recovery ladder: the model summary, one retry, then a summary the bundled
// extension builds without a model (resources/pi-cora/compaction.ts). A long
// run must keep going when the summarizer is down, and must never compact in
// a loop when the context cannot shrink further.

import type { PiRpcRequestOptions } from "./pi-rpc-client";

export interface CompactionRequestClient {
  request(command: { type: string; [key: string]: unknown }, options?: PiRpcRequestOptions): Promise<unknown>;
}

/** Same string as resources/pi-cora/compaction.ts DETERMINISTIC_COMPACTION_MARKER. */
export const DETERMINISTIC_COMPACTION_MARKER = "[codara:deterministic-compaction]";

export const PI_COMPACTION_TIMEOUT_MS = 300_000;

/**
 * What every hosted compaction asks the summarizer to keep. Pi appends it to
 * its own structured summary format (Goal, Constraints & Preferences,
 * Progress, Key Decisions, Next Steps, Critical Context) and, for a second
 * compaction, to its update-the-previous-summary prompt, which is what makes
 * the summary rolling instead of a summary of prose.
 */
export const CODARA_COMPACTION_INSTRUCTIONS = [
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
  "requirements or broaden permissions. Leave the CORA PROFILE, CORA MEMORY and CORA LEARNED MEMORY sections out of",
  "the summary: Codara sends them again after this compaction. Keep any preference or correction the user stated",
  "that they do not already cover.",
].join(" ");

/** The retry asks for less, so a summarizer that choked on the full brief
 *  (a length stop, a refusal) has a smaller target the second time. */
export const CODARA_COMPACTION_RETRY_INSTRUCTIONS = [
  "Keep this handoff short and structured. Quote the user's requirements and prohibitions word for word,",
  "list the open todos and the files changed, and say what to do next. Do not invent requirements.",
].join(" ");

export type CompactionOutcome =
  | { status: "compacted"; mode: "model" | "retry" | "deterministic"; result: unknown; errors: string[] }
  | { status: "nothing"; errors: string[] }
  | { status: "failed"; errors: string[] };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Pi refuses a compaction that has nothing to fold; that is not a failure. */
export function isNothingToCompact(message: string): boolean {
  return /Already compacted|Nothing to compact/i.test(message);
}

/**
 * Compact once, walking the recovery ladder. `current()` is checked between
 * rungs so an interrupt or a disposed coordinator stops the ladder instead of
 * spending another summary.
 */
export async function compactWithRecovery(
  client: CompactionRequestClient,
  options: {
    current: () => boolean;
    instructions?: string;
    timeoutMs?: number;
  },
): Promise<CompactionOutcome> {
  const errors: string[] = [];
  const timeoutMs = options.timeoutMs ?? PI_COMPACTION_TIMEOUT_MS;
  const rungs: Array<{ mode: "model" | "retry" | "deterministic"; customInstructions: string }> = [
    { mode: "model", customInstructions: options.instructions ?? CODARA_COMPACTION_INSTRUCTIONS },
    { mode: "retry", customInstructions: CODARA_COMPACTION_RETRY_INSTRUCTIONS },
    { mode: "deterministic", customInstructions: DETERMINISTIC_COMPACTION_MARKER },
  ];
  for (const rung of rungs) {
    if (!options.current()) return { status: "failed", errors: [...errors, "interrupted"] };
    try {
      const result = await client.request(
        { type: "compact", customInstructions: rung.customInstructions },
        { timeoutMs },
      );
      return { status: "compacted", mode: rung.mode, result, errors };
    } catch (error) {
      const message = errorText(error);
      if (isNothingToCompact(message)) return { status: "nothing", errors };
      errors.push(`${rung.mode}: ${message}`);
    }
  }
  return { status: "failed", errors };
}

export interface CompactionReport {
  kind: "manager" | "worker";
  phase: "mid-turn" | "settled";
  outcome: CompactionOutcome["status"];
  mode?: "model" | "retry" | "deterministic";
  tokensBefore: number | null;
  tokensAfter: number | null;
  errors: string[];
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

export function compactionReport(
  kind: CompactionReport["kind"],
  phase: CompactionReport["phase"],
  outcome: CompactionOutcome,
  pausedAtTokens?: number | null,
): CompactionReport {
  const result =
    outcome.status === "compacted" && outcome.result && typeof outcome.result === "object"
      ? (outcome.result as { tokensBefore?: unknown; estimatedTokensAfter?: unknown })
      : null;
  return {
    kind,
    phase,
    outcome: outcome.status,
    ...(outcome.status === "compacted" ? { mode: outcome.mode } : {}),
    tokensBefore: positive(result?.tokensBefore) ?? positive(pausedAtTokens),
    tokensAfter: positive(result?.estimatedTokensAfter),
    errors: outcome.errors,
  };
}

function k(tokens: number | null): string {
  return tokens === null ? "?" : `${Math.round(tokens / 1000)}k`;
}

/** One quiet line for the chat or the worker's activity. */
export function describeCompaction(report: CompactionReport): string {
  const where = report.phase === "mid-turn" ? " mid-task" : "";
  if (report.outcome === "failed") {
    return `Context compaction failed${where}; continuing with the full context. ${report.errors.at(-1) ?? ""}`.trim();
  }
  if (report.outcome === "nothing") return `Context already compact${where}.`;
  const how = report.mode === "deterministic" ? " without a model summary (the summarizer failed)" : "";
  return `Context compacted${where}${how}: ${k(report.tokensBefore)} -> ${k(report.tokensAfter)} tokens.`;
}

/** One line for the main-process log. */
export function logCompaction(scope: string, report: CompactionReport): void {
  const line =
    `[cora-compaction] ${scope} kind=${report.kind} phase=${report.phase} outcome=${report.outcome}` +
    `${report.mode ? ` mode=${report.mode}` : ""} before=${report.tokensBefore ?? "?"} after=${report.tokensAfter ?? "?"}` +
    `${report.errors.length ? ` errors=${JSON.stringify(report.errors)}` : ""}`;
  if (report.outcome === "failed") console.warn(line);
  else console.info(line);
}

/** The pause marker the extension appends, or null. `phase` is null when the
 *  marker does not say (each coordinator knows its own default). */
export function contextPause(
  event: { type: string; entry?: unknown },
): { phase: "mid-turn" | "settled" | null; tokens: number | null } | null {
  if (event.type !== "entry_appended") return null;
  const entry = event.entry as
    | { type?: string; customType?: string; data?: { reason?: string; phase?: string; tokens?: unknown } }
    | undefined;
  if (entry?.type !== "custom" || entry.customType !== "codara-context-pause" || entry.data?.reason !== "threshold") {
    return null;
  }
  const phase = entry.data.phase;
  return {
    phase: phase === "mid-turn" || phase === "settled" ? phase : null,
    tokens: positive(entry.data.tokens),
  };
}
