// The durable conversation cutover's policy and its note (run-store's
// performAutoCompaction): when to summarize a manager conversation into a
// fresh session, what to ask the summarizer for, and the deterministic state
// the note carries next to the summary.
//
// A summary of a summary drifts: each cutover paraphrases the previous one,
// and after a few the user's exact words and the worker results are gone. So
// the note pairs the model's summary with a block built from the run record
// itself (the user's messages verbatim, the newest exchange, worker outcomes
// and their artifacts). That block is rebuilt from the record at every
// cutover, never from the previous note, so it cannot drift however many
// times a run compacts.
//
// Pure: no disk, no Electron, no clock.

import type { HumanRunMessage, RunState, WorkerAttempt, WorkerTask } from "@shared/types";

/** Fraction of the session's compaction limit at which a settled turn cuts
 *  over. Below the limit itself, so the cutover (which keeps the user's words
 *  verbatim) usually wins over the in-session compaction. */
export const CONVERSATION_COMPACTION_RATIO = 0.8;

/** Shorter than this is a refusal, an error string, or a throwaway reply. */
export const MIN_CONVERSATION_SUMMARY_CHARS = 200;

export const CONVERSATION_COMPACTION_PROMPT = [
  "Create a dense handoff for a fresh Cora session that continues this conversation. Codara appends the",
  "user's messages verbatim, the newest exchange, the plan and the worker outcomes after your handoff, so",
  "spend your words on what those records cannot show. Use these Markdown sections:",
  "## Goal (the current objective in the user's terms);",
  "## Constraints (every requirement, prohibition and preference, quoted word for word);",
  "## Plan and status (each step: done, in progress or open);",
  "## Decisions (each with its reason);",
  "## Files (each file touched and its current state);",
  "## Workers (each worker's task, status and result, with ids);",
  "## Errors and fixes (each error with its fix, or unresolved);",
  "## Open todos and next actions;",
  "## Artifacts (exact paths, URLs, IDs, commands).",
  "If the conversation starts from an earlier compaction summary, carry every item that is still open",
  "forward unchanged and move items to done only when later messages show them done. Preserve exact",
  "names, commands and error text. Drop greetings, repetition and dead-end exploration. Do not invent.",
  "Reply only with the handoff; call no tools.",
].join(" ");

const DURABLE_HEADER = "[CODARA DURABLE STATE: built from the run record at this compaction; authoritative where the summary above disagrees.]";
const DURABLE_FOOTER = "[END CODARA DURABLE STATE]";

export const DURABLE_STATE_MAX_CHARS = 24_000;
const USER_MESSAGE_MAX_CHARS = 2_500;
const USER_MESSAGES_MAX_CHARS = 12_000;
const RECENT_MESSAGE_MAX_CHARS = 1_500;
const RECENT_EXCHANGE_MAX_CHARS = 6_000;
const RECENT_EXCHANGE_COUNT = 6;
const WORKERS_MAX = 20;
const WORKER_FILES_MAX = 8;

/** Rough tokens for a prompt text; providers vary, this only sizes logs and
 *  re-arm points. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 20).trimEnd()} [...truncated]`;
}

function oneLine(text: string | undefined, max: number): string {
  return clip((text ?? "").replace(/\s+/g, " "), max);
}

function isDialogue(message: HumanRunMessage): boolean {
  return (
    message.deliveryState !== "cancelled" &&
    message.kind !== "assistant_stream" &&
    !message.compaction &&
    !message.resumeNote &&
    !message.boardNote &&
    message.message.trim().length > 0
  );
}

/**
 * Every user message, verbatim up to a per-message cap. Over the total budget
 * the first message (the original request) and the newest ones are kept and
 * the middle is counted, never silently dropped.
 */
function userMessagesSection(messages: HumanRunMessage[]): string[] {
  const users = messages.filter((message) => message.author === "user" && isDialogue(message));
  if (users.length === 0) return [];
  const render = (message: HumanRunMessage, index: number) =>
    `${index + 1}. ${clip(message.message, USER_MESSAGE_MAX_CHARS)}`;
  const first = render(users[0], 0);
  const kept: string[] = [];
  let used = first.length;
  let index = users.length - 1;
  for (; index >= 1; index -= 1) {
    const line = render(users[index], index);
    if (used + line.length > USER_MESSAGES_MAX_CHARS) break;
    kept.unshift(line);
    used += line.length;
  }
  const elided = index;
  return [
    "User messages, verbatim and in order (later messages supersede earlier ones where they conflict):",
    first,
    ...(elided > 0 ? [`[${elided} earlier message${elided === 1 ? "" : "s"} omitted for length]`] : []),
    ...kept,
  ];
}

function recentExchangeSection(messages: HumanRunMessage[]): string[] {
  const dialogue = messages.filter(
    (message) => (message.author === "user" || message.author === "spark") && isDialogue(message),
  );
  const recent: string[] = [];
  let used = 0;
  for (const message of dialogue.slice(-RECENT_EXCHANGE_COUNT).reverse()) {
    const who = message.author === "user" ? "User" : "Cora";
    const line = `${who}: ${clip(message.message, RECENT_MESSAGE_MAX_CHARS)}`;
    if (recent.length > 0 && used + line.length > RECENT_EXCHANGE_MAX_CHARS) break;
    recent.unshift(line);
    used += line.length;
  }
  return recent.length ? ["Newest exchange, verbatim:", ...recent] : [];
}

function latestAttempt(task: WorkerTask, attempts: WorkerAttempt[]): WorkerAttempt | undefined {
  let latest: WorkerAttempt | undefined;
  for (const attempt of attempts) {
    if (attempt.workerTaskId !== task.id) continue;
    if (!latest || attempt.attemptNumber > latest.attemptNumber) latest = attempt;
  }
  return latest;
}

function workersSection(tasks: WorkerTask[], attempts: WorkerAttempt[]): string[] {
  if (tasks.length === 0) return [];
  const shown = tasks.slice(-WORKERS_MAX);
  const lines = shown.map((task) => {
    const attempt = latestAttempt(task, attempts);
    const parts = [`- ${task.id} | ${task.status} | ${oneLine(task.title, 140)}`];
    if (attempt) {
      parts.push(`attempt ${attempt.attemptNumber} ${attempt.status}`);
      if (attempt.error) parts.push(`error: ${oneLine(attempt.error, 240)}`);
      const files = attempt.diffSummary?.files ?? [];
      if (files.length) {
        const names = files.slice(0, WORKER_FILES_MAX).map((file) => file.path);
        const more = (attempt.diffSummary?.fileCount ?? files.length) - names.length;
        parts.push(`changed: ${names.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
      }
      if (attempt.finalReportPath) parts.push(`report: ${attempt.finalReportPath}`);
      if (attempt.sandboxBranch) parts.push(`branch: ${attempt.sandboxBranch}`);
    }
    return parts.join(" | ");
  });
  return [
    tasks.length > shown.length ? `Workers (newest ${shown.length} of ${tasks.length}):` : "Workers:",
    ...lines,
  ];
}

/**
 * The deterministic block appended to a cutover note, or null when the run has
 * nothing to record. Sections are dropped from the least to the most important
 * until the block fits.
 */
export function conversationDurableState(
  run: Pick<RunState, "humanMessages" | "workerTasks" | "workerAttempts">,
  maxChars: number = DURABLE_STATE_MAX_CHARS,
): string | null {
  const messages = run.humanMessages ?? [];
  const sections = [
    userMessagesSection(messages),
    workersSection(run.workerTasks ?? [], run.workerAttempts ?? []),
    recentExchangeSection(messages),
  ].filter((section) => section.length > 0);
  if (sections.length === 0) return null;
  while (sections.length > 0) {
    const body = [DURABLE_HEADER, ...sections.map((section) => section.join("\n")), DURABLE_FOOTER].join("\n\n");
    if (body.length <= maxChars) return body;
    if (sections.length === 1) {
      return `${body.slice(0, maxChars - DURABLE_FOOTER.length - 30).trimEnd()}\n[truncated]\n${DURABLE_FOOTER}`;
    }
    sections.pop();
  }
  return null;
}

/** A summary the cutover may replace history with, or the reason it may not. */
export function conversationSummaryProblem(summary: string | undefined | null): string | null {
  const text = summary?.trim() ?? "";
  if (!text) return "Compaction summary turn produced no summary text.";
  if (text.length < MIN_CONVERSATION_SUMMARY_CHARS) {
    return `Compaction summary too short to replace the conversation (${text.length} chars).`;
  }
  return null;
}

/** The note body after its fixed prefix: the summary, then the record. */
export function compactionNoteBody(summary: string, durableState: string | null): string {
  return durableState ? `${summary.trim()}\n\n${durableState}` : summary.trim();
}

// ---------------------------------------------------------------------------
// When to cut over.
//
// A failed summary must not be retried on the very next turn at the same size
// (each attempt is a full model call over the whole conversation), and a
// cutover whose own replay is already near the limit must not cut over again
// on every turn. Both wait for real growth first.

export const MIN_REARM_GROWTH_TOKENS = 8_000;
export const REARM_GROWTH_FRACTION = 0.1;

export interface CutoverGuard {
  /** The conversation epoch the guard belongs to; a new epoch clears it. */
  epoch: number;
  /** No cutover below this many context tokens. */
  rearmAtTokens: number;
  failures: number;
  /** Set by a cutover: the new epoch's first measured turn is its baseline. */
  baselinePending?: boolean;
}

export type CutoverDecision = "compact" | "below-limit" | "waiting-for-growth";

export function rearmAfter(tokens: number, capacityTokens: number): number {
  return Math.max(0, Math.floor(tokens)) + Math.max(MIN_REARM_GROWTH_TOKENS, Math.floor(capacityTokens * REARM_GROWTH_FRACTION));
}

export function cutoverDecision(input: {
  contextTokens: number;
  capacityTokens: number;
  epoch: number;
  guard?: CutoverGuard | null;
  ratio?: number;
}): CutoverDecision {
  const ratio = input.ratio ?? CONVERSATION_COMPACTION_RATIO;
  if (!(input.contextTokens > 0) || !(input.capacityTokens > 0)) return "below-limit";
  if (input.contextTokens / input.capacityTokens < ratio) return "below-limit";
  const guard = input.guard;
  if (guard && guard.epoch === input.epoch && input.contextTokens < guard.rearmAtTokens) {
    return "waiting-for-growth";
  }
  return "compact";
}

/** The guard after a failed attempt in this epoch. */
export function guardAfterFailure(
  previous: CutoverGuard | null | undefined,
  epoch: number,
  contextTokens: number,
  capacityTokens: number,
): CutoverGuard {
  const failures = previous && previous.epoch === epoch ? previous.failures + 1 : 1;
  return { epoch, rearmAtTokens: rearmAfter(contextTokens, capacityTokens), failures };
}

/** The guard for the fresh epoch a cutover opened. Its baseline is the
 *  first turn's real context (system prompt, replay, memory and run state),
 *  which only that turn can measure. */
export function guardAfterCutover(newEpoch: number): CutoverGuard {
  return { epoch: newEpoch, rearmAtTokens: 0, failures: 0, baselinePending: true };
}

/**
 * Settle a pending baseline with the first turn measured in its epoch. A
 * fresh session that already sits near the limit (a large system prompt on a
 * small limit) cannot be helped by another cutover, so it waits for growth
 * instead of cutting over after every turn.
 */
export function observeCutoverBaseline(
  guard: CutoverGuard | null | undefined,
  epoch: number,
  contextTokens: number,
  capacityTokens: number,
  ratio: number = CONVERSATION_COMPACTION_RATIO,
): CutoverGuard | null {
  if (!guard) return null;
  if (guard.epoch !== epoch || !guard.baselinePending) return guard;
  const crowded = capacityTokens > 0 && contextTokens / capacityTokens >= ratio;
  return {
    epoch,
    rearmAtTokens: crowded ? rearmAfter(contextTokens, capacityTokens) : 0,
    failures: guard.failures,
  };
}

function k(tokens: number | null | undefined): string {
  return typeof tokens === "number" && tokens > 0 ? `${Math.round(tokens / 1000)}k` : "?";
}

/** One line for the timeline row and the log. */
export function describeCutover(beforeTokens: number | null | undefined, afterTokens: number | null | undefined): string {
  return `Older history was summarized into a fresh session (${k(beforeTokens)} -> ${k(afterTokens)} tokens)`;
}
