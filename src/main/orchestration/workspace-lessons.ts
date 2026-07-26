import type { RunState, WorkerAttempt, WorkerReport, WorkerRuntime } from "@shared/types";
import { appendAutoMemories } from "./cora-memory";

// Per-workspace operational lessons: one sentence each, derived at run
// completion from what the run ACTUALLY hit.
//
// Deliberately narrow. This is not a second run-memory ledger (run-memory.ts
// already stores the outcome-conditioned fingerprint of every finished run).
// A lesson is a single behavioral correction the orchestrator should carry into
// the next run of the same workspace, and only two are derived today:
//   (a) the provider web_search tool was rate limited during the run,
//   (b) a runtime fallback fired (one runtime failed environmentally and the
//       run was re-queued on the other one).
//
// This module is the DERIVATION half only. Storage and replay moved to Cora
// memory v2 (cora-memory.ts): recordRunLessons writes each derived sentence as
// an [auto <date> run:<id>] bullet into the workspace's memory markdown, where
// dedup, the 30-day auto TTL, and byte-cap eviction live. The old
// ~/.Codara/lessons.json ledger is migrated and retired by cora-memory on its
// first use. Every entry point stays best-effort: nothing here ever throws
// into the run-completion path.
//
// This module imports only cora-memory + shared types, never run-store or
// manager-protocol, so there is no import cycle.

/** One noisy run must not be able to flood the memory file. */
const MAX_LESSONS_PER_RUN = 4;

/** One attempt paired with its final report, the raw material for derivation. */
export interface RunLessonEvidence {
  attempt: WorkerAttempt;
  report: WorkerReport | null;
}

// Lesson (a). The provider-native web_search tool refused work mid-run.
const SEARCH_RATE_LIMIT_LESSON =
  "Provider web_search was rate limited in this workspace, so stagger searches across workers, reuse results already gathered, and prefer public feeds or endpoints over repeat queries.";

// Only the provider tool counts, not the words "web search" in prose. A worker
// writing "the web search returned 429 results" is describing a result count,
// not a throttled tool, so the spaced form is deliberately not accepted on its
// own: it must read as a tool name (web_search, web-search, websearch) or say
// "web search tool" outright.
const SEARCH_TOOL_PATTERN = /\bweb[_-]search\b|\bwebsearch\b|\bweb search tool\b/i;
/** Unambiguous throttle wording. */
const RATE_LIMIT_PHRASE =
  /\brate[\s_-]?limit(?:ed|ing|s)?\b|\btoo many requests\b|\bquota (?:exceeded|exhausted|reached)\b/i;
/**
 * A bare 429 is only evidence when it reads as a status code. "429 results",
 * "429 files changed" and "line 429" are counts, so the number has to sit next
 * to status wording on one side or throttle wording on the other.
 */
const HTTP_429_PATTERN =
  /\b(?:http|https|status|statuscode|status_code|code|error|err|response|responded)\b[^\n]{0,24}?\b429\b|\b429\b[^\n]{0,24}?\b(?:too many requests|rate limit)\b/i;
const RATE_LIMIT_PATTERN = new RegExp(
  `${RATE_LIMIT_PHRASE.source}|${HTTP_429_PATTERN.source}`,
  "i",
);

/** Every free-text field of one attempt that a worker could have reported a
 *  provider failure in. Defensive against reports missing array fields. */
function evidenceStrings(item: RunLessonEvidence): string[] {
  const out: string[] = [];
  if (item.attempt.error) out.push(item.attempt.error);
  const report = item.report;
  if (report) {
    if (report.summary) out.push(report.summary);
    for (const risk of report.risks ?? []) out.push(risk);
    for (const followup of report.followups ?? []) out.push(followup);
    // Command and summary stay separate strings. Joining them would let a curl
    // against some search endpoint in one field pair up with an unrelated 429 in
    // the other and read as the provider's own search tool being throttled.
    for (const cmd of report.commandsRun ?? []) {
      if (cmd.command) out.push(cmd.command);
      if (cmd.summary) out.push(cmd.summary);
    }
    for (const test of report.tests ?? []) if (test.details) out.push(test.details);
  }
  return out.filter((value) => typeof value === "string" && value.length > 0);
}

/**
 * Both halves of the signal must appear in the SAME reported string. A run that
 * mentions web_search in one risk and a rate limit in an unrelated one is not
 * evidence that search itself was throttled.
 */
function sawSearchRateLimit(evidence: RunLessonEvidence[]): boolean {
  for (const item of evidence) {
    for (const text of evidenceStrings(item)) {
      if (SEARCH_TOOL_PATTERN.test(text) && RATE_LIMIT_PATTERN.test(text)) return true;
    }
  }
  return false;
}

interface RuntimeFallbackSignal {
  from: WorkerRuntime;
  to: WorkerRuntime;
  errorClass: string;
}

/**
 * Bucket a failure blob into a short, human-meaningful error class. Mirrors the
 * vocabulary detectFatalWorkerRuntimeError uses in worker-launch.ts, most
 * specific first so a socket close never degrades to the generic API error.
 */
function classifyRuntimeFailure(text: string): string {
  if (/socket connection was closed/i.test(text)) return "a closed socket connection";
  if (RATE_LIMIT_PATTERN.test(text)) return "a provider rate limit";
  if (/overloaded|temporarily unavailable/i.test(text)) return "a provider overload";
  if (/failed to launch|ENOENT|command not found|not installed/i.test(text)) return "a CLI launch failure";
  if (/fetch\(\)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|network/i.test(text)) return "a network failure";
  if (/API Error/i.test(text)) return "a provider API error";
  return "an unclassified runtime failure";
}

/**
 * A runtime fallback is durable in RunState: maybeQueueCliLaunchFallback cancels
 * the failed task and pushes a replacement whose supersedesTaskId points back at
 * it with the opposite runtimePreference. Reading that lineage avoids depending
 * on the event log.
 */
function detectRuntimeFallbacks(run: RunState, evidence: RunLessonEvidence[]): RuntimeFallbackSignal[] {
  const tasksById = new Map(run.workerTasks.map((task) => [task.id, task]));
  const signals: RuntimeFallbackSignal[] = [];
  const seen = new Set<string>();
  for (const task of run.workerTasks) {
    if (!task.supersedesTaskId) continue;
    const previous = tasksById.get(task.supersedesTaskId);
    if (!previous) continue;
    if (previous.runtimePreference === task.runtimePreference) continue;
    const failureText = evidence
      .filter((item) => item.attempt.workerTaskId === previous.id)
      .flatMap((item) => evidenceStrings(item))
      .join("\n");
    const errorClass = classifyRuntimeFailure(failureText);
    const key = `${previous.runtimePreference}>${task.runtimePreference}:${errorClass}`;
    if (seen.has(key)) continue;
    seen.add(key);
    signals.push({ from: previous.runtimePreference, to: task.runtimePreference, errorClass });
  }
  return signals;
}

function runtimeFallbackLesson(signal: RuntimeFallbackSignal): string {
  return `Runtime ${signal.from} fell back to ${signal.to} after ${signal.errorClass}, so expect ${signal.from} to be unreliable for similar work in this workspace and plan the fallback up front.`;
}

/**
 * Pure derivation of a finished run's lessons. Exported so tests can exercise it
 * without touching disk. Returns at most MAX_LESSONS_PER_RUN sentences.
 */
export function deriveRunLessons(run: RunState, evidence: RunLessonEvidence[]): string[] {
  const lessons: string[] = [];
  if (sawSearchRateLimit(evidence)) lessons.push(SEARCH_RATE_LIMIT_LESSON);
  for (const signal of detectRuntimeFallbacks(run, evidence)) {
    lessons.push(runtimeFallbackLesson(signal));
  }
  return lessons.slice(0, MAX_LESSONS_PER_RUN);
}

async function gatherAttemptEvidence(
  run: RunState,
  readReport: (path: string) => Promise<WorkerReport | null>,
): Promise<RunLessonEvidence[]> {
  const evidence: RunLessonEvidence[] = [];
  for (const attempt of run.workerAttempts) {
    let report: WorkerReport | null = null;
    if (attempt.finalReportPath) {
      try {
        report = await readReport(attempt.finalReportPath);
      } catch {
        report = null;
      }
    }
    evidence.push({ attempt, report });
  }
  return evidence;
}

/**
 * Best-effort writer for the non-complete to complete transition. Reads every
 * finished attempt's report, derives the run's lessons, and appends them to the
 * workspace's Cora memory as [auto] bullets (cora-memory handles dedup, TTL,
 * eviction, and the enabled/disabled toggles). Wrapped end to end and NEVER
 * throws: a failed lessons write must not break run completion.
 */
export async function recordRunLessons(
  run: RunState,
  readReport: (path: string) => Promise<WorkerReport | null>,
): Promise<void> {
  try {
    const evidence = await gatherAttemptEvidence(run, readReport);
    const texts = deriveRunLessons(run, evidence);
    if (texts.length === 0) return;
    await appendAutoMemories(run.workspaceId, texts, run.id);
  } catch (err) {
    console.warn("[workspace-lessons] failed to record run lessons:", err);
  }
}
