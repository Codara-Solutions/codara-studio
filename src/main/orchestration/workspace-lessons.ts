import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sparkHome } from "../spark-home";
import type { RunState, WorkerAttempt, WorkerReport, WorkerRuntime } from "@shared/types";

// Per-workspace operational lessons: one sentence each, written at run
// completion from what the run ACTUALLY hit, replayed into later manager turns.
//
// Deliberately narrow. This is not a second run-memory ledger (run-memory.ts
// already stores the outcome-conditioned fingerprint of every finished run).
// A lesson is a single behavioral correction the orchestrator should carry into
// the next run of the same workspace, and only two are derived today:
//   (a) the provider web_search tool was rate limited during the run,
//   (b) a runtime fallback fired (one runtime failed environmentally and the
//       run was re-queued on the other one).
//
// Storage is one JSON file, ~/.Codara/lessons.json, keyed by workspaceId.
// Newest-first, deduped by normalized text (newest wins), capped per workspace,
// and expired after LESSON_TTL_MS so a heuristic that fired wrongly fades out.
// Every entry point is best-effort: a corrupt or unreadable file reads as "no
// lessons" and the next write replaces it, and nothing here ever throws into
// the run-completion path.
//
// This module imports only spark-home + shared types, never run-store or
// manager-protocol, so there is no import cycle.

const STORE_VERSION = 1;
/** Ledger cap per workspace. Oldest entries fall off the tail. */
const MAX_LESSONS_PER_WORKSPACE = 20;
/** One noisy run must not be able to flood the ledger. */
const MAX_LESSONS_PER_RUN = 4;
/** How many lessons the manager prompt section is allowed to carry. */
const PROMPT_LESSON_LIMIT = 5;
/** Lessons are one sentence. Anything longer is truncated on the way in. */
const MAX_LESSON_TEXT_LENGTH = 240;
/**
 * Lessons expire. The derivations are heuristics over free text, so a wrong one
 * must not steer a workspace forever, and even a correct one ("codex was rate
 * limited") goes stale as providers and machines change. The per-workspace cap
 * cannot do this job on its own: the derived vocabulary is small enough that a
 * workspace rarely reaches 20 distinct lessons, so nothing would ever evict.
 */
const LESSON_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A single learned sentence plus the run it was learned from. */
export interface WorkspaceLesson {
  /** One sentence, whitespace-collapsed, length-capped. */
  text: string;
  /** Run that produced the lesson. */
  runId: string;
  /** ISO timestamp of the producing run's completion. */
  createdAt: string;
}

/** On-disk shape of ~/.Codara/lessons.json. Records are newest-first. */
export interface WorkspaceLessonsStore {
  version: number;
  workspaces: Record<string, WorkspaceLesson[]>;
}

/** One attempt paired with its final report, the raw material for derivation. */
export interface RunLessonEvidence {
  attempt: WorkerAttempt;
  report: WorkerReport | null;
}

export function workspaceLessonsPath(): string {
  return join(sparkHome(), "lessons.json");
}

// The workspace map is keyed by caller-supplied workspace ids, so it is built
// with a null prototype: a "__proto__" key from a parsed file or an exotic
// workspace id then lands as an ordinary own property instead of mutating a
// prototype. JSON.stringify is unaffected.
function emptyWorkspaceMap(): Record<string, WorkspaceLesson[]> {
  return Object.create(null) as Record<string, WorkspaceLesson[]>;
}

function emptyStore(): WorkspaceLessonsStore {
  return { version: STORE_VERSION, workspaces: emptyWorkspaceMap() };
}

/** Collapse whitespace and cap length so stored lessons stay one short line. */
function cleanLessonText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > MAX_LESSON_TEXT_LENGTH
    ? `${collapsed.slice(0, MAX_LESSON_TEXT_LENGTH - 1)}…`
    : collapsed;
}

/**
 * Expiry check. A missing or unparseable timestamp is treated as fresh: we
 * cannot prove such an entry is stale, and dropping it would quietly delete
 * hand-written or older-format lessons.
 */
function isLessonFresh(lesson: WorkspaceLesson, now: number): boolean {
  const created = Date.parse(lesson.createdAt);
  if (!Number.isFinite(created)) return true;
  return now - created <= LESSON_TTL_MS;
}

function pruneExpired(lessons: WorkspaceLesson[], now: number = Date.now()): WorkspaceLesson[] {
  return lessons.filter((lesson) => isLessonFresh(lesson, now));
}

/** Dedup key: case, spacing, and trailing sentence punctuation are noise. */
function normalizeLessonText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
}

function coerceLesson(value: unknown): WorkspaceLesson | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<WorkspaceLesson>;
  const text = cleanLessonText(raw.text);
  if (!text) return null;
  return {
    text,
    runId: typeof raw.runId === "string" ? raw.runId : "",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
  };
}

/**
 * Loose validation of whatever JSON.parse produced. Anything unexpected is
 * dropped rather than thrown: a half-written or hand-edited file must degrade
 * to "no lessons", never break a run.
 */
function coerceStore(value: unknown): WorkspaceLessonsStore {
  if (!value || typeof value !== "object") return emptyStore();
  const raw = value as { version?: unknown; workspaces?: unknown };
  const rawWorkspaces = raw.workspaces;
  if (!rawWorkspaces || typeof rawWorkspaces !== "object" || Array.isArray(rawWorkspaces)) {
    return emptyStore();
  }
  const workspaces = emptyWorkspaceMap();
  for (const [workspaceId, entries] of Object.entries(rawWorkspaces as Record<string, unknown>)) {
    if (!workspaceId || !Array.isArray(entries)) continue;
    const lessons: WorkspaceLesson[] = [];
    for (const entry of entries) {
      const lesson = coerceLesson(entry);
      if (!lesson) continue;
      lessons.push(lesson);
      if (lessons.length >= MAX_LESSONS_PER_WORKSPACE) break;
    }
    if (lessons.length > 0) workspaces[workspaceId] = lessons;
  }
  return {
    version: typeof raw.version === "number" ? raw.version : STORE_VERSION,
    workspaces,
  };
}

function readLessonsStore(): WorkspaceLessonsStore {
  const path = workspaceLessonsPath();
  if (!existsSync(path)) return emptyStore();
  try {
    return coerceStore(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return emptyStore();
  }
}

/**
 * Temp file plus rename so a crashed write can never leave a torn store. The
 * temp name carries the pid and a random suffix so two processes sharing one
 * ~/.Codara (a CODARA_HOME_DIR override, a headless harness, a second install)
 * cannot interleave into the same scratch file and rename half a document over
 * the ledger. A failed write removes its own temp file rather than leaving it.
 */
function writeLessonsStore(store: WorkspaceLessonsStore): void {
  const path = workspaceLessonsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort cleanup only
    }
    throw err;
  }
}

/**
 * Synchronous newest-first read for one workspace, expired entries removed.
 * Returns an empty array for a missing file, a corrupt file, or an unknown
 * workspace: callers treat "no lessons" and "lessons unavailable" identically.
 */
export function readWorkspaceLessons(workspaceId: string): WorkspaceLesson[] {
  if (!workspaceId) return [];
  return pruneExpired(readLessonsStore().workspaces[workspaceId] ?? []);
}

/**
 * Merge incoming lessons over the existing ones. Newest wins: an incoming
 * lesson whose normalized text already exists replaces the old entry and moves
 * to the front. Returns null when nothing new survives cleaning, so the caller
 * can skip the write entirely.
 */
function mergeLessons(
  existing: WorkspaceLesson[],
  incoming: Array<{ text: string; runId: string; createdAt?: string }>,
): WorkspaceLesson[] | null {
  const additions: WorkspaceLesson[] = [];
  const incomingKeys = new Set<string>();
  for (const entry of incoming) {
    const text = cleanLessonText(entry.text);
    if (!text) continue;
    const key = normalizeLessonText(text);
    if (!key || incomingKeys.has(key)) continue;
    incomingKeys.add(key);
    additions.push({
      text,
      runId: typeof entry.runId === "string" ? entry.runId : "",
      createdAt: entry.createdAt ?? new Date().toISOString(),
    });
  }
  if (additions.length === 0) return null;
  const kept = existing.filter((lesson) => !incomingKeys.has(normalizeLessonText(lesson.text)));
  return [...additions, ...kept].slice(0, MAX_LESSONS_PER_WORKSPACE);
}

/**
 * Best-effort writer. Never throws. Returns the workspace's lessons after the
 * merge (or the unchanged list when there was nothing to add).
 */
export function recordWorkspaceLessons(
  workspaceId: string,
  entries: Array<{ text: string; runId: string; createdAt?: string }>,
): WorkspaceLesson[] {
  if (!workspaceId || entries.length === 0) return [];
  try {
    const store = readLessonsStore();
    // Prune on the write path too, so expired entries actually leave the file
    // instead of only being filtered out of every read.
    const existing = pruneExpired(store.workspaces[workspaceId] ?? []);
    const merged = mergeLessons(existing, entries);
    if (!merged) return existing;
    store.version = STORE_VERSION;
    store.workspaces[workspaceId] = merged;
    writeLessonsStore(store);
    return merged;
  } catch (err) {
    console.warn("[workspace-lessons] failed to record lessons:", err);
    return [];
  }
}

/**
 * The manager-prompt section. Lives in the per-turn dynamic tail (the user
 * message), never in the cacheable system-prompt prefix. Returns null when the
 * workspace has no lessons yet, so an empty ledger costs zero tokens.
 */
export function formatWorkspaceLessonsSection(
  workspaceId: string,
  limit: number = PROMPT_LESSON_LIMIT,
): string | null {
  const lessons = readWorkspaceLessons(workspaceId).slice(0, Math.max(0, limit));
  if (lessons.length === 0) return null;
  return [
    "WORKSPACE LESSONS (learned from earlier runs in this workspace; apply them unless this run's own evidence contradicts them)",
    ...lessons.map((lesson) => `- ${lesson.text}`),
  ].join("\n");
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
 * finished attempt's report, derives the run's lessons, and merges them into the
 * workspace ledger. Wrapped end to end and NEVER throws: a failed lessons write
 * must not break run completion.
 */
export async function recordRunLessons(
  run: RunState,
  readReport: (path: string) => Promise<WorkerReport | null>,
): Promise<void> {
  try {
    const evidence = await gatherAttemptEvidence(run, readReport);
    const texts = deriveRunLessons(run, evidence);
    if (texts.length === 0) return;
    const createdAt = run.completedAt ?? run.updatedAt ?? new Date().toISOString();
    recordWorkspaceLessons(
      run.workspaceId,
      texts.map((text) => ({ text, runId: run.id, createdAt })),
    );
  } catch (err) {
    console.warn("[workspace-lessons] failed to record run lessons:", err);
  }
}
