// Worker final-report parsing, normalization, and the accept/retry decision.
//
// readWorkerReport loads a worker's final-report.json off disk and coerces the
// untrusted JSON into a well-typed WorkerReport (normalizeWorkerReport and its
// per-field helpers). decideWorkerReport maps a normalized report's status onto
// a ReviewDecision. Extracted from run-store.ts (move-only).

import { promises as fs } from "node:fs";
import type { ReviewDecision, VerifierVerdict, WorkerReport } from "@shared/types";

export async function readWorkerReport(path: string): Promise<WorkerReport | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  try {
    return normalizeWorkerReport(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return null;
  }
}

function normalizeWorkerReport(raw: Record<string, unknown>): WorkerReport {
  const status = raw.status;
  if (status !== "complete" && status !== "partial" && status !== "blocked" && status !== "failed") {
    throw new Error("Invalid worker report status.");
  }

  return {
    status,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    filesChanged: normalizeReportItems(raw.filesChanged ?? raw.files_changed, ["path", "reason"]),
    commandsRun: normalizeCommandReports(raw.commandsRun ?? raw.commands_run),
    tests: normalizeTestReports(raw.tests),
    proof: normalizeStringList(raw.proof),
    risks: normalizeStringList(raw.risks),
    followups: normalizeStringList(raw.followups),
    verifier: normalizeVerifierVerdict(raw.verifier),
  };
}

function normalizeVerifierVerdict(value: unknown): VerifierVerdict | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const status = raw.status;
  const confidenceRaw = raw.confidence;
  const okStatus = status === "verified" || status === "failed" || status === "unsure";
  const okConfidence =
    confidenceRaw === "PERFECT" ||
    confidenceRaw === "VERIFIED" ||
    confidenceRaw === "PARTIAL" ||
    confidenceRaw === "FEEDBACK" ||
    confidenceRaw === "FAILED";
  if (!okStatus || !okConfidence) return undefined;
  const claimsRaw = Array.isArray(raw.atomic_claims)
    ? raw.atomic_claims
    : Array.isArray(raw.atomicClaims)
      ? raw.atomicClaims
      : [];
  const atomicClaims = claimsRaw
    .filter((item: unknown): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item: Record<string, unknown>) => {
      const v = item.verdict;
      const verdict: "verified" | "failed" | "unsure" =
        v === "verified" || v === "failed" || v === "unsure" ? v : "unsure";
      return {
        claim: typeof item.claim === "string" ? item.claim : "",
        verdict,
        evidence: typeof item.evidence === "string" ? item.evidence : "",
      };
    });
  const correctivePrompt =
    typeof raw.corrective_prompt === "string"
      ? raw.corrective_prompt
      : typeof raw.correctivePrompt === "string"
        ? raw.correctivePrompt
        : undefined;
  const missingOracle =
    typeof raw.missing_oracle === "string"
      ? raw.missing_oracle
      : typeof raw.missingOracle === "string"
        ? raw.missingOracle
        : undefined;
  return {
    status,
    confidence: confidenceRaw,
    atomicClaims,
    correctivePrompt: correctivePrompt && correctivePrompt.trim().length > 0 ? correctivePrompt : undefined,
    missingOracle: missingOracle && missingOracle.trim().length > 0 ? missingOracle : undefined,
  };
}

function normalizeReportItems(value: unknown, keys: ["path", "reason"]): WorkerReport["filesChanged"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => {
      const path = item[keys[0]];
      const reason = item[keys[1]];
      return {
        path: typeof path === "string" ? path : "",
        reason: typeof reason === "string" ? reason : "",
      };
    });
}

function normalizeCommandReports(value: unknown): WorkerReport["commandsRun"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      command: typeof item.command === "string" ? item.command : "",
      exitCode: typeof item.exitCode === "number" ? item.exitCode : typeof item.exit_code === "number" ? item.exit_code : undefined,
      summary: typeof item.summary === "string" ? item.summary : "",
    }));
}

function normalizeTestReports(value: unknown): WorkerReport["tests"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => {
      const result = item.result;
      return {
        command: typeof item.command === "string" ? item.command : "",
        result: result === "passed" || result === "failed" || result === "not_run" ? result : "not_run",
        details: typeof item.details === "string" ? item.details : undefined,
      };
    });
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function decideWorkerReport(report: WorkerReport): ReviewDecision {
  if (report.status === "complete") {
    // Trust complete-status reports. Workers are full Claude/Codex/Cursor harnesses
    // and can run their own verification — risks/followups are advisory, not
    // blockers. The manager loop reviews them when planning the next step.
    return {
      decision: "accept",
      confidence: 0.7,
      reason: report.summary || "Worker reported completion.",
      issues: [...report.risks, ...report.followups],
      acceptedEvidence: report.proof,
      nextStepAllowed: true,
    };
  }

  if (report.status === "failed") {
    return {
      decision: "retry_same_worker",
      confidence: 0.65,
      reason: report.summary || "Worker reported failure.",
      issues: [...report.risks, ...report.followups],
      acceptedEvidence: report.proof,
      nextStepAllowed: false,
    };
  }

  if (report.status === "blocked") {
    return {
      decision: "escalate_to_user",
      confidence: 0.75,
      reason: report.summary || "Worker reported a blocker.",
      issues: [...report.risks, ...report.followups],
      acceptedEvidence: report.proof,
      nextStepAllowed: false,
    };
  }

  return {
    decision: "escalate_to_user",
    confidence: 0.55,
    reason: report.summary || "Worker produced a partial report that needs review.",
    issues: [...report.risks, ...report.followups],
    acceptedEvidence: report.proof,
    nextStepAllowed: false,
  };
}
