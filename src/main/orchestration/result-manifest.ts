import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  RunResultManifest,
  RunState,
  WorkerArtifactPaths,
  WorkerReport,
} from "@shared/types";
import { readWorkerReport } from "./worker-report";

const execFileAsync = promisify(execFile);

type PathsResolver = (
  runId: string,
  stepId: string | undefined,
  workerTaskId: string,
  attemptId: string,
) => WorkerArtifactPaths;

interface ReportEntry {
  attemptId: string;
  reportPath: string;
  report: WorkerReport;
}

export async function collectRunResultManifest(
  run: RunState,
  pathsFor: PathsResolver,
): Promise<RunResultManifest> {
  const generatedAt = new Date().toISOString();
  const cwd = typeof run.settingsSnapshot?.workspaceCwd === "string"
    ? run.settingsSnapshot.workspaceCwd
    : undefined;
  const reports = await collectReports(run, pathsFor);
  const baselineSha = (run.checkpoints ?? []).find(
    (checkpoint) => checkpoint.kind === "run-start" && checkpoint.sha,
  )?.sha ?? undefined;
  const workspace = await observeWorkspaceDelta(cwd, baselineSha);

  const reportedFiles = new Map<string, { path: string; reason?: string }>();
  for (const entry of reports) {
    for (const file of entry.report.filesChanged) {
      const path = normalizePath(file.path);
      if (!path) continue;
      const prior = reportedFiles.get(path.toLowerCase());
      reportedFiles.set(path.toLowerCase(), {
        path,
        reason: prior?.reason || file.reason.trim() || undefined,
      });
    }
  }
  const delta = new Map(workspace.delta.map((file) => [file.path.toLowerCase(), file]));
  for (const file of reportedFiles.values()) {
    if (!delta.has(file.path.toLowerCase())) {
      delta.set(file.path.toLowerCase(), {
        path: file.path,
        status: "reported" as const,
        provenance: "reported" as const,
        reason: file.reason,
      });
    } else if (file.reason) {
      delta.get(file.path.toLowerCase())!.reason ??= file.reason;
    }
  }

  const outcomes = reports
    .map((entry) => ({
      text: compact(entry.report.summary),
      provenance: "reported" as const,
      attemptId: entry.attemptId,
    }))
    .filter((item) => item.text);
  const managerSummary = [...(run.humanMessages ?? [])]
    .reverse()
    .find((message) => message.author === "spark" && compact(message.message))?.message;
  const checks: RunResultManifest["checks"] = [];
  const evidence: RunResultManifest["evidence"] = [];
  const risks = new Set<string>();
  const followups = new Set<string>();
  for (const entry of reports) {
    for (const command of entry.report.commandsRun) {
      if (!command.command.trim()) continue;
      checks.push({
        command: command.command.trim(),
        result: command.exitCode === 0 ? "passed" : typeof command.exitCode === "number" ? "failed" : "unknown",
        provenance: command.exitCode === 0 ? "verified" : "reported",
        exitCode: command.exitCode,
        details: compact(command.summary) || undefined,
        attemptId: entry.attemptId,
      });
    }
    for (const test of entry.report.tests) {
      if (!test.command.trim()) continue;
      checks.push({
        command: test.command.trim(),
        result: test.result,
        provenance: test.result === "passed" ? "verified" : "reported",
        details: compact(test.details) || undefined,
        attemptId: entry.attemptId,
      });
    }
    for (const proof of entry.report.proof) {
      if (compact(proof)) evidence.push({ text: compact(proof), provenance: "reported", attemptId: entry.attemptId });
    }
    if (entry.report.verifier) {
      for (const claim of entry.report.verifier.atomicClaims) {
        if (!compact(claim.claim)) continue;
        evidence.push({
          text: `${compact(claim.claim)} — ${claim.verdict}${compact(claim.evidence) ? `: ${compact(claim.evidence)}` : ""}`,
          provenance: claim.verdict === "verified" ? "verified" : "reported",
          attemptId: entry.attemptId,
        });
      }
    }
    entry.report.risks.map(compact).filter(Boolean).forEach((item) => risks.add(item));
    entry.report.followups.map(compact).filter(Boolean).forEach((item) => followups.add(item));
  }

  const artifacts: RunResultManifest["artifacts"] = reports.map((entry) => ({
    path: entry.reportPath,
    kind: "report",
    provenance: "observed",
  }));
  for (const file of delta.values()) {
    artifacts.push({ path: file.path, kind: semanticKind(file.path), provenance: file.provenance });
  }

  return {
    version: 1,
    runId: run.id,
    status: run.status,
    generatedAt,
    // The manager owns the run-level conclusion; worker reports are scoped
    // evidence and remain listed under outcomes. Using a worker summary here
    // can invert perspective (for example, "no workers were spawned" means no
    // subworkers inside that worker, not no workers in the Cora run).
    summary: compact(managerSummary) || outcomes[0]?.text || run.title,
    workspace: {
      cwd,
      mode: workspace.mode,
      baselineSha,
      note: workspace.note,
    },
    workspaceDelta: [...delta.values()].sort((a, b) => a.path.localeCompare(b.path)),
    outcomes: dedupeBy(outcomes, (item) => item.text.toLowerCase()),
    checks: dedupeBy(checks, (item) => `${item.command.toLowerCase()}\0${item.result}`),
    evidence: dedupeBy(evidence, (item) => item.text.toLowerCase()),
    risks: [...risks],
    followups: [...followups],
    artifacts: dedupeBy(artifacts, (item) => `${item.kind}\0${item.path.toLowerCase()}`),
  };
}

export function renderRunResultManifestSummary(manifest: RunResultManifest): string {
  const lines = ["Run complete.", "", manifest.summary];
  if (manifest.workspaceDelta.length > 0) {
    lines.push("", "Changed files:");
    for (const file of manifest.workspaceDelta.slice(0, 8)) {
      lines.push(`- \`${file.path.replace(/`/g, "'")}\` (${file.status}, ${file.provenance})${file.reason ? `: ${file.reason}` : ""}`);
    }
    if (manifest.workspaceDelta.length > 8) lines.push(`- ${manifest.workspaceDelta.length - 8} more file(s).`);
  }
  if (manifest.checks.length > 0) {
    lines.push("", "Verification:");
    for (const check of manifest.checks.slice(0, 8)) {
      lines.push(`- \`${check.command.replace(/`/g, "'")}\` — ${check.result} (${check.provenance})${check.details ? `: ${check.details}` : ""}`);
    }
  }
  const notes = [...manifest.risks, ...manifest.followups];
  if (notes.length > 0) {
    lines.push("", "Risks and follow-ups:");
    notes.slice(0, 6).forEach((note) => lines.push(`- ${note}`));
  }
  if (manifest.workspace.note) lines.push("", `Workspace evidence: ${manifest.workspace.note}`);
  return lines.join("\n").trim();
}

async function collectReports(run: RunState, pathsFor: PathsResolver): Promise<ReportEntry[]> {
  const entries: ReportEntry[] = [];
  for (const attempt of run.workerAttempts) {
    const task = run.workerTasks.find((item) => item.id === attempt.workerTaskId);
    if (!task) continue;
    const reportPath = attempt.finalReportPath ?? pathsFor(run.id, task.stepId, task.id, attempt.id).finalReportJson;
    const report = await readWorkerReport(reportPath);
    if (report) entries.push({ attemptId: attempt.id, reportPath, report });
  }
  return entries;
}

async function observeWorkspaceDelta(
  cwd: string | undefined,
  baselineSha: string | undefined,
): Promise<{
  mode: RunResultManifest["workspace"]["mode"];
  note?: string;
  delta: RunResultManifest["workspaceDelta"];
}> {
  if (!cwd) return { mode: "unavailable", note: "Workspace path was not persisted.", delta: [] };
  try {
    await execFileAsync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  } catch {
    return {
      mode: "non_git",
      note: "No Git baseline is available; file changes are reported by workers and are not independently diffed.",
      delta: [],
    };
  }
  const delta = new Map<string, RunResultManifest["workspaceDelta"][number]>();
  if (baselineSha) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", cwd, "diff", "--name-status", "--find-renames", baselineSha, "--"],
        { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      );
      for (const line of stdout.split(/\r?\n/)) {
        const parts = line.split("\t");
        const code = parts[0]?.trim();
        const path = normalizePath(code?.startsWith("R") ? parts[2] : parts[1]);
        if (!code || !path) continue;
        delta.set(path.toLowerCase(), {
          path,
          status: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : code.startsWith("R") ? "renamed" : "modified",
          provenance: "observed",
        });
      }
    } catch {
      // Fall through to status; the manifest remains honest about the missing baseline.
    }
  }
  const { stdout } = await execFileAsync(
    "git",
    ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const rawPath = line.slice(3).split(" -> ").at(-1);
    const path = normalizePath(rawPath);
    if (!path) continue;
    const status = code === "??" ? "untracked" : code.includes("D") ? "deleted" : code.includes("A") ? "added" : "modified";
    delta.set(path.toLowerCase(), { path, status, provenance: "observed" });
  }
  return {
    mode: "git",
    note: baselineSha ? undefined : "Git repository detected, but the run-start snapshot was unavailable; delta uses current status only.",
    delta: [...delta.values()],
  };
}

function semanticKind(path: string): "file" | "semantic" {
  return /(^|\/)(readme|changelog|plan|prd)|\.(md|pdf|docx|pptx|xlsx)$/i.test(path) ? "semantic" : "file";
}

function normalizePath(value: string | undefined): string {
  return (value ?? "").trim().replace(/^"|"$/g, "").replace(/\\/g, "/");
}

function compact(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
