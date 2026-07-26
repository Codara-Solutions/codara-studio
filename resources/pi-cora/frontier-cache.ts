import { createHash } from "node:crypto";
import fs from "node:fs";

import type { FrontierVerificationManifest } from "./frontier-core";

export const FRONTIER_ADMISSION_POLICY = "frontier-admission-v12" as const;

export type FrontierAdmissionArtifact = {
  schemaVersion: 1;
  scope: {
    mode: typeof FRONTIER_ADMISSION_POLICY;
    contractTreeSha256: string;
    trackedTreeSha256: string;
    verificationConfigSha256: string;
  };
  auditorReport: string;
  reportSha256: string;
  provenance: {
    runId: string;
    manifestSha256: string;
    baselineVerified: true;
    admissionVerified: true;
    finalCommandsPassed: true;
    finalSafetyVerdict: "SAFE";
    finalDiffSha256: string;
    finalChangedHunks: number;
    safetyProbes: number;
    completedAt: string;
  };
};

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/;
const FORBIDDEN = /\b(?:hidden[_ -]?grader|sealed[_ -]?(?:grader|tests?)|benchmark[_ -]?(?:score|outcome)|grader[_ -]?id)\b/i;

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function exactKeys(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} keys must be exactly ${expected.join(", ")}`);
  }
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
  return value;
}

function bounded(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max || value.includes("\0")) {
    throw new Error(`${label} must contain ${min}-${max} characters`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`);
  return Number(value);
}

export function frontierVerificationConfigSha256(manifest: FrontierVerificationManifest): string {
  return hash(canonicalJson({
    policy: FRONTIER_ADMISSION_POLICY,
    frontierPolicy: manifest.frontierPolicy,
    contractObligations: manifest.contractObligations.map((obligation) => ({
      id: obligation.id,
      kind: obligation.kind,
      proofMode: obligation.proofMode,
      contentSha256: obligation.contentSha256,
    })),
    commands: manifest.commands.map((command) => ({
      id: command.id,
      command: command.command,
      args: command.args,
      cwdRelative: command.cwdRelative,
      timeoutMs: command.timeoutMs,
      source: command.source,
      sourcePath: command.sourcePath,
    })),
  }));
}

export function parseFrontierAdmissionArtifact(value: unknown): FrontierAdmissionArtifact {
  exactKeys(value, ["schemaVersion", "scope", "auditorReport", "reportSha256", "provenance"], "artifact");
  if (value.schemaVersion !== 1) throw new Error("artifact.schemaVersion must be 1");
  exactKeys(value.scope, ["mode", "contractTreeSha256", "trackedTreeSha256", "verificationConfigSha256"], "artifact.scope");
  if (value.scope.mode !== FRONTIER_ADMISSION_POLICY) throw new Error("artifact.scope.mode is unsupported");
  const auditorReport = bounded(value.auditorReport, "artifact.auditorReport", 128, 512_000);
  const reportSha256 = sha(value.reportSha256, "artifact.reportSha256");
  if (hash(auditorReport) !== reportSha256) throw new Error("artifact.auditorReport hash mismatch");
  for (const marker of ["TOTAL_CUTS=", "TOTAL_FAMILIES=", "TOTAL_OPERATIONS=", "ADMISSION_CUTS_JSON="]) {
    if (!auditorReport.includes(marker)) throw new Error(`artifact.auditorReport is missing ${marker}`);
  }
  if (FORBIDDEN.test(auditorReport)) throw new Error("artifact.auditorReport contains forbidden evaluation data");
  exactKeys(value.provenance, [
    "runId", "manifestSha256", "baselineVerified", "admissionVerified", "finalCommandsPassed",
    "finalSafetyVerdict", "finalDiffSha256", "finalChangedHunks", "safetyProbes", "completedAt",
  ], "artifact.provenance");
  if (typeof value.provenance.runId !== "string" || !ID.test(value.provenance.runId)) throw new Error("artifact.provenance.runId is invalid");
  if (value.provenance.baselineVerified !== true || value.provenance.admissionVerified !== true ||
    value.provenance.finalCommandsPassed !== true || value.provenance.finalSafetyVerdict !== "SAFE") {
    throw new Error("artifact provenance is not independently SAFE");
  }
  const finalChangedHunks = integer(value.provenance.finalChangedHunks, "artifact.provenance.finalChangedHunks");
  const safetyProbes = integer(value.provenance.safetyProbes, "artifact.provenance.safetyProbes");
  if (finalChangedHunks > 0 && safetyProbes < finalChangedHunks * 2) throw new Error("artifact provenance has insufficient safety probes");
  const completedAt = bounded(value.provenance.completedAt, "artifact.provenance.completedAt", 20, 40);
  if (!Number.isFinite(Date.parse(completedAt)) || new Date(Date.parse(completedAt)).toISOString() !== completedAt) {
    throw new Error("artifact.provenance.completedAt must be an ISO timestamp");
  }
  return {
    schemaVersion: 1,
    scope: {
      mode: FRONTIER_ADMISSION_POLICY,
      contractTreeSha256: sha(value.scope.contractTreeSha256, "artifact.scope.contractTreeSha256"),
      trackedTreeSha256: sha(value.scope.trackedTreeSha256, "artifact.scope.trackedTreeSha256"),
      verificationConfigSha256: sha(value.scope.verificationConfigSha256, "artifact.scope.verificationConfigSha256"),
    },
    auditorReport,
    reportSha256,
    provenance: {
      runId: value.provenance.runId,
      manifestSha256: sha(value.provenance.manifestSha256, "artifact.provenance.manifestSha256"),
      baselineVerified: true,
      admissionVerified: true,
      finalCommandsPassed: true,
      finalSafetyVerdict: "SAFE",
      finalDiffSha256: sha(value.provenance.finalDiffSha256, "artifact.provenance.finalDiffSha256"),
      finalChangedHunks,
      safetyProbes,
      completedAt,
    },
  };
}

export function loadFrontierAdmissionArtifact(
  filePath: string,
  expectedSha256: string,
  manifest: FrontierVerificationManifest,
): FrontierAdmissionArtifact {
  if (!SHA256.test(expectedSha256)) throw new Error("Frontier admission artifact expected SHA-256 is invalid");
  const bytes = fs.readFileSync(filePath);
  if (hash(bytes) !== expectedSha256) throw new Error("Frontier admission artifact hash mismatch");
  const artifact = parseFrontierAdmissionArtifact(JSON.parse(bytes.toString("utf8")));
  if (!manifest.cacheEligible || manifest.cacheIneligibilityReasons.length || !manifest.contractTreeSha256 || !manifest.commands.length) {
    throw new Error("Frontier manifest is not eligible for admission reuse");
  }
  if (artifact.scope.contractTreeSha256 !== manifest.contractTreeSha256 ||
    artifact.scope.trackedTreeSha256 !== manifest.trackedTreeSha256 ||
    artifact.scope.verificationConfigSha256 !== frontierVerificationConfigSha256(manifest)) {
    throw new Error("Frontier admission artifact scope does not match the exact workspace state");
  }
  return artifact;
}
