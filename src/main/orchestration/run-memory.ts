import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sparkHome } from "../spark-home";
import { writeFileAtomic } from "../fs-atomic";
import type {
  RunState,
  WorkerReport,
  WorkspaceMemoryLedger,
  WorkspaceRunMemoryRecord,
  WorkspaceRunMemoryRuntimeOutcome,
} from "@shared/types";
import { classifyOutcomeMemory } from "@shared/outcome-memory";

// Per-workspace persistent orchestration memory. One distilled JSON ledger per
// workspaceId under ~/.SparkAgent/memory. The writer (recordRunMemory) runs
// best-effort on a run's non-complete -> complete transition; the synchronous
// reader (formatPriorRunsSection) is folded into the manager's plan_analysis
// prompt so it can learn this repo's task shapes, which runtimes survived
// verification, and which build/test commands actually worked. This module
// imports only spark-home, fs-atomic + shared types, never run-store or manager-protocol
// — so there is no import cycle.

const LEDGER_VERSION = 2;
// Writer trims the ledger to this many newest-first records.
const MAX_RECORDS = 50;
// Reader returns at most this many records, ranked by similarity.
const TOP_K = 5;

// Distillation caps. Kept small so the ledger stays a compact fingerprint and
// the injected prompt block respects the manager's compaction budget.
const MAX_PLAN_KEYWORDS = 24;
const MAX_TOUCHED_GLOBS = 16;
const MAX_RUNTIME_OUTCOMES = 8;
const MAX_VERIFIED_COMMANDS = 6;
const MAX_ORACLE_EVIDENCE = 6;
const VERIFIED_COMMAND_MAX_LENGTH = 120;

// Common English + code stopwords dropped from the keyword fingerprint so the
// Jaccard ranker scores on meaningful task vocabulary, not boilerplate.
const STOPWORDS = new Set<string>([
  "the", "and", "for", "with", "that", "this", "from", "into", "onto", "over",
  "under", "your", "you", "are", "was", "were", "has", "have", "had", "but",
  "not", "all", "any", "can", "should", "must", "will", "would", "could", "may",
  "use", "using", "used", "add", "added", "adding", "make", "made", "making",
  "ensure", "ensures", "ensured", "via", "per", "out", "off", "its", "their",
  "them", "then", "than", "when", "where", "which", "while", "who", "whom",
  "what", "how", "why", "new", "old", "set", "get", "run", "runs", "running",
  "ran", "step", "task", "goal", "work", "file", "files", "code", "test",
  "tests", "build", "fix", "fixes", "fixed", "change", "changes", "changed",
  "update", "updates", "updated", "implement", "implements", "implementing",
  "create", "creates", "creating", "support", "supports", "supported",
]);

function memoryRoot(): string {
  return join(sparkHome(), "memory");
}

// Strip path separators and other unsafe characters so a workspaceId can never
// escape the memory dir or collide with a control character. Falls back to a
// stable placeholder when sanitizing empties the value.
function sanitize(workspaceId: string): string {
  const cleaned = workspaceId.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "_unknown";
}

function ledgerPath(workspaceId: string): string {
  return join(memoryRoot(), `${sanitize(workspaceId)}.json`);
}

// Lowercase, split on non-alphanumerics, drop stopwords + short tokens, dedupe.
function tokenizeKeywords(parts: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const raw of part.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 3) continue;
      if (STOPWORDS.has(raw)) continue;
      seen.add(raw);
    }
  }
  return [...seen];
}

// Generalize a concrete file path to a "dir/*.ext" glob so the ranker matches
// by area touched without storing exact file lists. Paths are normalized to
// forward slashes (the report writer may emit Windows separators).
function generalizeGlob(path: string): string | null {
  const normalized = path.replace(/\\/g, "/").trim();
  if (!normalized) return null;
  const slash = normalized.lastIndexOf("/");
  const dir = slash >= 0 ? normalized.slice(0, slash) : "";
  const base = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1) : "";
  const leaf = ext ? `*.${ext}` : "*";
  return dir ? `${dir}/${leaf}` : leaf;
}

function dedupeCap(values: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= cap) break;
  }
  return out;
}

// Jaccard overlap of two token sets: |A ∩ B| / |A ∪ B|. 0 when either is empty.
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}

// The keyword half of a run's similarity fingerprint, derived from the plan
// text (run title + every step's title/goal/acceptanceCriteria). Available to
// both the writer (from the run) and the reader (which has no reports, so it
// leans on the plan + allowedPaths only).
function planKeywordsFromRun(run: RunState): string[] {
  const parts: Array<string | undefined> = [run.title];
  for (const step of run.steps) {
    parts.push(step.title, step.goal);
    for (const criterion of step.acceptanceCriteria) parts.push(criterion);
  }
  return dedupeCap(tokenizeKeywords(parts), MAX_PLAN_KEYWORDS);
}

// The glob half of the CURRENT run's fingerprint, used only by the reader. The
// reader has no worker reports, so it approximates touched areas from each
// worker task's declared allowedPaths instead of report.filesChanged.
function currentGlobsFromRun(run: RunState): string[] {
  const globs: string[] = [];
  for (const task of run.workerTasks) {
    for (const allowed of task.allowedPaths) {
      const glob = generalizeGlob(allowed);
      if (glob) globs.push(glob);
    }
  }
  return dedupeCap(globs, MAX_TOUCHED_GLOBS);
}

function fingerprintTokens(planKeywords: string[], touchedGlobs: string[]): Set<string> {
  return new Set<string>([...planKeywords, ...touchedGlobs]);
}

function coerceLedger(value: unknown, workspaceId: string): WorkspaceMemoryLedger | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<WorkspaceMemoryLedger>;
  if (!Array.isArray(candidate.records)) return null;
  return {
    version: typeof candidate.version === "number" ? candidate.version : LEDGER_VERSION,
    workspaceId: typeof candidate.workspaceId === "string" ? candidate.workspaceId : workspaceId,
    records: candidate.records as WorkspaceRunMemoryRecord[],
  };
}

/**
 * Synchronous ledger read for the workspace. Returns null on a missing file or
 * any parse/shape failure (the caller treats "no memory" identically to "memory
 * unavailable"). Validates loosely — records must be an array — and coerces the
 * rest to the ledger type.
 */
export function readWorkspaceMemory(workspaceId: string): WorkspaceMemoryLedger | null {
  const path = ledgerPath(workspaceId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return coerceLedger(JSON.parse(raw), workspaceId);
  } catch {
    return null;
  }
}

function formatRuntimeOutcomes(outcomes: WorkspaceRunMemoryRuntimeOutcome[]): string {
  return outcomes
    .slice(0, 4)
    .map((o) => `${o.runtime}:${o.role}=${o.outcome}`)
    .join(", ");
}

function renderRecordEntry(record: WorkspaceRunMemoryRecord): string {
  const lines = [`- ${truncate(record.title || "(untitled run)", 120)}`];
  const meta: string[] = [];
  if (record.complexity) meta.push(`complexity=${record.complexity}`);
  const verificationStatus = record.verificationStatus ?? "unverified";
  meta.push(`outcome=${verificationStatus}`);
  if (typeof record.verifiedClaimCount === "number") {
    meta.push(`verifiedClaims=${record.verifiedClaimCount}`);
  }
  if (typeof record.failedClaimCount === "number" && record.failedClaimCount > 0) {
    meta.push(`failedClaims=${record.failedClaimCount}`);
  }
  lines.push(`  ${meta.join(", ")}`);
  if (verificationStatus !== "verified") {
    lines.push("  caution: not a reusable recipe; use only as failure/uncertainty evidence");
  }
  if (record.touchedGlobs.length > 0) {
    lines.push(`  touched: ${record.touchedGlobs.slice(0, 4).join(", ")}`);
  }
  if (record.runtimeOutcomes.length > 0) {
    lines.push(`  runtimes: ${formatRuntimeOutcomes(record.runtimeOutcomes)}`);
  }
  if (record.verifiedCommands.length > 0) {
    const cmds = record.verifiedCommands.slice(0, 3).map((c) => truncate(c, 80));
    lines.push(`  verified cmds: ${cmds.join(" | ")}`);
  }
  if ((record.oracleEvidence?.length ?? 0) > 0) {
    lines.push(`  oracle evidence: ${record.oracleEvidence!.slice(0, 2).map((item) => truncate(item, 100)).join(" | ")}`);
  }
  return lines.join("\n");
}

/**
 * Synchronous reader + formatter folded into the manager's plan_analysis user
 * message. Loads the workspace ledger, excludes the current run, ranks the rest
 * by similarity to the current plan's fingerprint (Jaccard over planKeywords ∪
 * touchedGlobs, tie-broken by newer completedAt), takes the top few, and renders
 * a compact, budget-bounded block. Returns null when there is no usable prior
 * memory; the caller owns surrounding blank-line spacing.
 */
export function formatPriorRunsSection(run: RunState): string | null {
  const ledger = readWorkspaceMemory(run.workspaceId);
  if (!ledger) return null;
  const others = ledger.records.filter((record) => record.runId !== run.id);
  if (others.length === 0) return null;

  const currentFingerprint = fingerprintTokens(
    planKeywordsFromRun(run),
    currentGlobsFromRun(run),
  );

  const ranked = others
    .map((record) => ({
      record,
      score: jaccard(
        currentFingerprint,
        fingerprintTokens(record.planKeywords ?? [], record.touchedGlobs ?? []),
      ),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const verifiedDelta = Number(b.record.verificationStatus === "verified") -
        Number(a.record.verificationStatus === "verified");
      if (verifiedDelta !== 0) return verifiedDelta;
      return (b.record.completedAt ?? "").localeCompare(a.record.completedAt ?? "");
    })
    .slice(0, TOP_K);

  const lines = [
    "OUTCOME-CONDITIONED PRIOR RUNS (most similar first; only outcome=verified is reusable; mixed/unverified entries are cautions, never recipes)",
    ...ranked.map(({ record }) => renderRecordEntry(record)),
  ];
  return lines.join("\n");
}

interface AttemptReport {
  attempt: RunState["workerAttempts"][number];
  task: RunState["workerTasks"][number] | undefined;
  report: WorkerReport;
}

// (a) Resolve and read every finished attempt's report. The caller persists
// finalReportPath on finished attempts, so we read straight from it and skip
// attempts that never produced one — no workerArtifactPaths import needed.
async function gatherAttemptReports(
  run: RunState,
  readReport: (path: string) => Promise<WorkerReport | null>,
): Promise<AttemptReport[]> {
  const out: AttemptReport[] = [];
  for (const attempt of run.workerAttempts) {
    const path = attempt.finalReportPath;
    if (!path) continue;
    const report = await readReport(path);
    if (!report) continue;
    const task = run.workerTasks.find((t) => t.id === attempt.workerTaskId);
    out.push({ attempt, task, report });
  }
  return out;
}

function distillTouchedGlobs(attemptReports: AttemptReport[]): string[] {
  const globs: string[] = [];
  for (const { report } of attemptReports) {
    for (const change of report.filesChanged) {
      const glob = generalizeGlob(change.path);
      if (glob) globs.push(glob);
    }
  }
  return dedupeCap(globs, MAX_TOUCHED_GLOBS);
}

function outcomeForReport(ar: AttemptReport): WorkspaceRunMemoryRuntimeOutcome["outcome"] {
  const verifier = ar.report.verifier;
  if (verifier) {
    if (verifier.status === "verified") return "passed";
    if (verifier.status === "failed") return "failed";
    return "unknown";
  }
  if (ar.report.status === "complete") return "passed";
  if (ar.report.status === "failed" || ar.report.status === "blocked") return "failed";
  return "unknown";
}

// Rank for "the worst wins" dedupe: failed beats unknown beats passed so a
// single failed outcome for a runtime+role is never masked by a passing one.
function outcomeSeverity(outcome: WorkspaceRunMemoryRuntimeOutcome["outcome"]): number {
  if (outcome === "failed") return 2;
  if (outcome === "unknown") return 1;
  return 0;
}

function distillRuntimeOutcomes(attemptReports: AttemptReport[]): WorkspaceRunMemoryRuntimeOutcome[] {
  const byKey = new Map<string, WorkspaceRunMemoryRuntimeOutcome>();
  for (const ar of attemptReports) {
    const role: WorkspaceRunMemoryRuntimeOutcome["role"] =
      ar.task?.taskClass === "verifier" ? "verifier" : "impl";
    const runtime = ar.attempt.runtime;
    const outcome = outcomeForReport(ar);
    const key = `${runtime}:${role}`;
    const existing = byKey.get(key);
    // Keep the worst outcome seen for this runtime+role pairing.
    if (!existing || outcomeSeverity(outcome) >= outcomeSeverity(existing.outcome)) {
      byKey.set(key, { runtime, role, outcome });
    }
  }
  return [...byKey.values()].slice(0, MAX_RUNTIME_OUTCOMES);
}

// A passing command we can trust to reproduce: prefer test/build-shaped verbs so
// the most useful reproduction commands survive the cap.
function looksLikeBuildOrTest(command: string): boolean {
  return /\b(npm|pnpm|yarn|tsc|jest|vitest|pytest|cargo|go|make|gradle|mvn|test|build|lint|typecheck)\b/i.test(
    command,
  );
}

function distillVerifiedCommands(attemptReports: AttemptReport[], reusable: boolean): string[] {
  if (!reusable) return [];
  const preferred: string[] = [];
  const rest: string[] = [];
  const push = (command: string): void => {
    const trimmed = command.trim();
    if (!trimmed) return;
    (looksLikeBuildOrTest(trimmed) ? preferred : rest).push(trimmed);
  };
  for (const { report } of attemptReports) {
    for (const cmd of report.commandsRun) {
      const ok = cmd.exitCode === 0 || (cmd.exitCode === undefined && /\b(pass|ok|success)/i.test(cmd.summary));
      if (ok) push(cmd.command);
    }
    for (const test of report.tests) {
      if (test.result === "passed") push(test.command);
    }
  }
  return dedupeCap([...preferred, ...rest], MAX_VERIFIED_COMMANDS).map((c) =>
    truncate(c, VERIFIED_COMMAND_MAX_LENGTH),
  );
}

function distillRecord(run: RunState, attemptReports: AttemptReport[]): WorkspaceRunMemoryRecord {
  const classification = classifyOutcomeMemory(
    attemptReports.flatMap((ar) => ar.report.verifier
      ? [{
          taskId: ar.task?.id ?? ar.attempt.workerTaskId,
          attemptNumber: ar.attempt.attemptNumber,
          accepted: ar.task?.status === "accepted",
          status: ar.report.verifier.status,
          claims: ar.report.verifier.atomicClaims,
        }]
      : []),
  );
  const oracleEvidence = dedupeCap(
    (run.resultManifest?.evidence ?? [])
      .filter((item) => item.provenance === "verified")
      .map((item) => truncate(item.text, 180)),
    MAX_ORACLE_EVIDENCE,
  );
  return {
    runId: run.id,
    title: truncate(run.title, 160),
    completedAt: run.completedAt ?? run.updatedAt,
    planKeywords: planKeywordsFromRun(run),
    touchedGlobs: distillTouchedGlobs(attemptReports),
    complexity: run.taskComplexity,
    verificationSurvived: classification.reusable,
    verificationStatus: classification.status,
    verifiedClaimCount: classification.verifiedClaimCount,
    failedClaimCount: classification.failedClaimCount,
    oracleEvidence,
    runtimeOutcomes: distillRuntimeOutcomes(attemptReports),
    verifiedCommands: distillVerifiedCommands(attemptReports, classification.reusable),
  };
}

/**
 * Best-effort writer for the non-complete -> complete transition. Gathers every
 * finished attempt's report, distills a single compact WorkspaceRunMemoryRecord
 * (capped keyword/glob/command lists, per-runtime outcomes), and unshifts it
 * newest-first into the workspace ledger (replacing any record for the same
 * runId, then trimming to MAX_RECORDS). Wrapped end-to-end in try/catch and
 * NEVER throws — a failed memory write must not break run completion.
 */
export async function recordRunMemory(
  run: RunState,
  readReport: (path: string) => Promise<WorkerReport | null>,
): Promise<void> {
  try {
    const attemptReports = await gatherAttemptReports(run, readReport);
    const record = distillRecord(run, attemptReports);

    const existing = readWorkspaceMemory(run.workspaceId);
    const ledger: WorkspaceMemoryLedger = existing ?? {
      version: LEDGER_VERSION,
      workspaceId: run.workspaceId,
      records: [],
    };
    const records = ledger.records.filter((r) => r.runId !== run.id);
    records.unshift(record);
    ledger.records = records.slice(0, MAX_RECORDS);
    ledger.workspaceId = run.workspaceId;
    ledger.version = LEDGER_VERSION;

    // Async + atomic. The old writeFileSync blocked the event loop for the size
    // of the whole ledger, and a plain async write would let this module's
    // synchronous reader observe a half-written file; the tmp+rename in
    // fs-atomic hands the reader the old ledger or the new one, never a torn one.
    await mkdir(memoryRoot(), { recursive: true });
    await writeFileAtomic(ledgerPath(run.workspaceId), JSON.stringify(ledger));
  } catch (err) {
    console.warn("[run-memory] failed to record run memory:", err);
  }
}
