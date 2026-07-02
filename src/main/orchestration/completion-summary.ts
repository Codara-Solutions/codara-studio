// Completion-summary derivation.
//
// buildCompletionSummaryMessage renders the templated "Run complete." digest
// (completed items, changed files, verification, notes) posted as a spark
// decision message when a run finishes. It reads each succeeded worker's final
// report and dedups/compacts the fields. workerArtifactPaths is injected by the
// caller (run-store) to avoid a circular import. Extracted from run-store.ts
// (move-only, aside from that dependency injection).

import { basename } from "node:path";
import type {
  RunState,
  WorkerArtifactPaths,
  WorkerAttempt,
  WorkerReport,
} from "@shared/types";
import { readWorkerReport } from "./worker-report";

type WorkerArtifactPathsResolver = (
  runId: string,
  stepId: string | undefined,
  workerTaskId: string,
  attemptId: string,
) => WorkerArtifactPaths;

export const COMPLETION_SUMMARY_PREFIX = "Run complete.";
const COMPLETION_SUMMARY_ITEM_LIMIT = 5;

interface CompletionReportSummary {
  taskTitle: string;
  stepTitle?: string;
  report: WorkerReport;
  attempt: WorkerAttempt;
}

export async function buildCompletionSummaryMessage(
  run: RunState,
  workerArtifactPaths: WorkerArtifactPathsResolver,
): Promise<string> {
  const reports = await collectCompletionReportSummaries(run, workerArtifactPaths);
  const lines: string[] = [COMPLETION_SUMMARY_PREFIX, ""];

  const completed = completionCompletedItems(run, reports);
  if (completed.length > 0) {
    lines.push("Completed:");
    for (const item of completed.slice(0, COMPLETION_SUMMARY_ITEM_LIMIT)) {
      lines.push(`- ${item}`);
    }
    if (completed.length > COMPLETION_SUMMARY_ITEM_LIMIT) {
      lines.push(`- ${completed.length - COMPLETION_SUMMARY_ITEM_LIMIT} more completed item(s).`);
    }
  }

  const files = completionChangedFiles(reports);
  if (files.length > 0) {
    if (lines[lines.length - 1] !== "") lines.push("");
    lines.push("Changed files:");
    for (const file of files.slice(0, COMPLETION_SUMMARY_ITEM_LIMIT)) {
      const reason = file.reason ? `: ${compactCompletionText(file.reason, 140)}` : "";
      lines.push(`- ${inlineCode(displayCompletionPath(file.path))}${reason}`);
    }
    if (files.length > COMPLETION_SUMMARY_ITEM_LIMIT) {
      lines.push(`- ${files.length - COMPLETION_SUMMARY_ITEM_LIMIT} more file(s).`);
    }
  }

  const checks = completionVerificationItems(reports);
  if (checks.length > 0) {
    if (lines[lines.length - 1] !== "") lines.push("");
    lines.push("Verification:");
    for (const check of checks.slice(0, COMPLETION_SUMMARY_ITEM_LIMIT)) {
      lines.push(`- ${check}`);
    }
    if (checks.length > COMPLETION_SUMMARY_ITEM_LIMIT) {
      lines.push(`- ${checks.length - COMPLETION_SUMMARY_ITEM_LIMIT} more check(s).`);
    }
  }

  const notes = completionNotes(reports);
  if (notes.length > 0) {
    if (lines[lines.length - 1] !== "") lines.push("");
    lines.push("Notes:");
    for (const note of notes.slice(0, 3)) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function collectCompletionReportSummaries(
  run: RunState,
  workerArtifactPaths: WorkerArtifactPathsResolver,
): Promise<CompletionReportSummary[]> {
  const byTaskId = new Map<string, CompletionReportSummary>();
  for (const attempt of run.workerAttempts) {
    if (attempt.status !== "succeeded") continue;
    const task = run.workerTasks.find((item) => item.id === attempt.workerTaskId);
    if (!task || task.status === "cancelled") continue;
    const reportPath =
      attempt.finalReportPath ??
      workerArtifactPaths(run.id, task.stepId, task.id, attempt.id).finalReportJson;
    const report = await readWorkerReport(reportPath);
    if (!report || report.status !== "complete") continue;
    const step = task.stepId ? run.steps.find((item) => item.id === task.stepId) : undefined;
    const existing = byTaskId.get(task.id);
    if (existing && existing.attempt.attemptNumber > attempt.attemptNumber) continue;
    byTaskId.set(task.id, {
      taskTitle: task.title,
      stepTitle: step?.title,
      report,
      attempt,
    });
  }
  return [...byTaskId.values()].sort((a, b) =>
    completionAttemptTime(a.attempt).localeCompare(completionAttemptTime(b.attempt)),
  );
}

function completionAttemptTime(attempt: WorkerAttempt): string {
  return attempt.finishedAt ?? attempt.startedAt ?? "";
}

function completionCompletedItems(
  run: RunState,
  reports: CompletionReportSummary[],
): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const entry of reports) {
    const summary = compactCompletionText(entry.report.summary, 180);
    const fallback = [entry.stepTitle, entry.taskTitle].filter(Boolean).join(": ");
    const text = summary || fallback;
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(text);
  }
  if (items.length > 0) return items;

  if (run.autopilot?.spawnedTerminals && run.autopilot.spawnedTerminals > 0) {
    const noun = run.autopilot.spawnedTerminals === 1 ? "terminal" : "terminals";
    return [`Opened ${run.autopilot.spawnedTerminals} standing ${noun}.`];
  }

  const completedSteps = run.steps.filter(
    (step) => step.status === "complete" || step.status === "completed_unverified",
  ).length;
  if (run.steps.length > 0) {
    return [`Finished ${completedSteps}/${run.steps.length} planned step(s).`];
  }

  return ["Spark answered the chat."];
}

function completionChangedFiles(
  reports: CompletionReportSummary[],
): Array<{ path: string; reason: string }> {
  const byPath = new Map<string, { path: string; reason: string }>();
  for (const entry of reports) {
    for (const file of entry.report.filesChanged) {
      const path = file.path.trim();
      if (!path) continue;
      const key = path.replace(/\\/g, "/").toLowerCase();
      const existing = byPath.get(key);
      if (existing) {
        if (!existing.reason && file.reason.trim()) existing.reason = file.reason.trim();
        continue;
      }
      byPath.set(key, { path, reason: file.reason.trim() });
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function completionVerificationItems(reports: CompletionReportSummary[]): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const entry of reports) {
    for (const command of entry.report.commandsRun) {
      const commandText = command.command.trim();
      if (!commandText) continue;
      const key = commandText.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const status =
        typeof command.exitCode === "number"
          ? command.exitCode === 0
            ? "passed"
            : `exit ${command.exitCode}`
          : "ran";
      const summary = compactCompletionText(command.summary, 130);
      items.push(`${inlineCode(commandText)} ${status}${summary ? `: ${summary}` : ""}`);
    }
  }
  if (items.length > 0) return items;

  let passed = 0;
  let failed = 0;
  let notRun = 0;
  for (const entry of reports) {
    for (const test of entry.report.tests) {
      if (test.result === "passed") passed += 1;
      else if (test.result === "failed") failed += 1;
      else notRun += 1;
    }
  }
  if (passed > 0 || failed > 0 || notRun > 0) {
    const parts = [
      passed > 0 ? `${passed} passed` : "",
      failed > 0 ? `${failed} failed` : "",
      notRun > 0 ? `${notRun} not run` : "",
    ].filter(Boolean);
    return [`Worker test report: ${parts.join(", ")}.`];
  }
  return [];
}

function completionNotes(reports: CompletionReportSummary[]): string[] {
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const entry of reports) {
    for (const note of [...entry.report.risks, ...entry.report.followups]) {
      const text = compactCompletionText(note, 170);
      if (!isMeaningfulCompletionNote(text)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      notes.push(text);
    }
  }
  return notes;
}

function compactCompletionText(value: string | undefined, maxLength: number): string {
  const compact = (value ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (compact.length <= maxLength) return compact;
  const cut = compact.slice(0, maxLength - 3);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

function displayCompletionPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/");
  if (normalized.length <= 100) return normalized;
  return `.../${basename(normalized)}`;
}

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}

function isMeaningfulCompletionNote(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return ![
    "none",
    "n/a",
    "na",
    "no risks",
    "no risk",
    "no followups",
    "no follow-ups",
    "no follow up",
    "no follow-up",
  ].includes(normalized);
}
