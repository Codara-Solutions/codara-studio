import { createHash } from "node:crypto";

export const PI_FRONTIER_ADMISSION_POLICY = "frontier-admission-v12" as const;
export const PI_FRONTIER_ADMISSION_CACHE_LIMIT = 64;

export interface PiFrontierAdmissionManifestScope {
  trackedTreeSha256: string;
  contractTreeSha256: string | null;
  cacheEligible: boolean;
  cacheIneligibilityReasons: string[];
  contractPaths: string[];
  contractObligations: Array<{
    id: string;
    kind: string;
    proofMode: "paired" | "positive";
    contentSha256: string;
  }>;
  frontierPolicy: {
    schemaVersion: 3;
    targetCuts: number;
    minFamilies: number;
    minOperations: number;
    minDeepFamilies: number;
    minCriticalFamilies: number;
    maxObligationsPerCut: number;
    maxObligationsPerProbe: number;
    minCounterfactualFamilies: number;
  };
  commands: Array<{
    id: string;
    command: string;
    args: string[];
    cwdRelative: string;
    timeoutMs: number;
    source: string;
    sourcePath: string;
  }>;
}

export interface PiFrontierAdmissionScope {
  mode: typeof PI_FRONTIER_ADMISSION_POLICY;
  contractTreeSha256: string;
  trackedTreeSha256: string;
  verificationConfigSha256: string;
}

export interface PiFrontierAdmissionProvenance {
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
}

export interface PiFrontierAdmissionCacheEntry {
  cacheEntryId: string;
  scope: PiFrontierAdmissionScope;
  auditorReport: string;
  reportSha256: string;
  provenance: PiFrontierAdmissionProvenance;
  createdAt: string;
  lastUsedAt: string;
}

export interface PiFrontierAdmissionCache {
  schemaVersion: 1;
  entries: PiFrontierAdmissionCacheEntry[];
}

export interface PiFrontierAdmissionArtifact {
  schemaVersion: 1;
  scope: PiFrontierAdmissionScope;
  auditorReport: string;
  reportSha256: string;
  provenance: PiFrontierAdmissionProvenance;
}

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/;
const FORBIDDEN_REPORT_CONTENT = /\b(?:hidden[_ -]?grader|sealed[_ -]?(?:grader|tests?)|benchmark[_ -]?(?:score|outcome)|grader[_ -]?id)\b/i;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function semanticTemplate(value: string): string {
  return value.trim().toLowerCase()
    .replace(/obligation-[a-f0-9]{20}/g, "obligation-<id>")
    .replace(/\b[a-f0-9]{16,64}\b/g, "<hash>")
    .replace(/\b\d+\b/g, "<number>")
    .replace(/\s+/g, " ");
}

function numberedPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return /^op[:._-]/.test(normalized) ||
    /^(?:frontier|slice|cut|family|operation|contract)(?:[ ._-]*(?:slice|cut|family|operation))?[ ._:-]*\d+$/.test(normalized);
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
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys must be exactly ${wanted.join(", ")}`);
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

function timestamp(value: unknown, label: string): string {
  const text = bounded(value, label, 20, 40);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) throw new Error(`${label} must be an ISO timestamp`);
  return text;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return Number(value);
}

function parseScope(value: unknown, label: string): PiFrontierAdmissionScope {
  exactKeys(value, ["mode", "contractTreeSha256", "trackedTreeSha256", "verificationConfigSha256"], label);
  if (value.mode !== PI_FRONTIER_ADMISSION_POLICY) throw new Error(`${label}.mode is unsupported`);
  return {
    mode: PI_FRONTIER_ADMISSION_POLICY,
    contractTreeSha256: sha(value.contractTreeSha256, `${label}.contractTreeSha256`),
    trackedTreeSha256: sha(value.trackedTreeSha256, `${label}.trackedTreeSha256`),
    verificationConfigSha256: sha(value.verificationConfigSha256, `${label}.verificationConfigSha256`),
  };
}

function parseProvenance(value: unknown, label: string): PiFrontierAdmissionProvenance {
  exactKeys(value, [
    "runId", "manifestSha256", "baselineVerified", "admissionVerified", "finalCommandsPassed",
    "finalSafetyVerdict", "finalDiffSha256", "finalChangedHunks", "safetyProbes", "completedAt",
  ], label);
  if (typeof value.runId !== "string" || !ID.test(value.runId)) throw new Error(`${label}.runId is invalid`);
  if (value.baselineVerified !== true || value.admissionVerified !== true || value.finalCommandsPassed !== true ||
    value.finalSafetyVerdict !== "SAFE") {
    throw new Error(`${label} requires verified baseline, admission, final commands, and SAFE review`);
  }
  const finalChangedHunks = nonNegativeInteger(value.finalChangedHunks, `${label}.finalChangedHunks`);
  const safetyProbes = nonNegativeInteger(value.safetyProbes, `${label}.safetyProbes`);
  if (finalChangedHunks > 0 && safetyProbes < finalChangedHunks * 2) {
    throw new Error(`${label}.safetyProbes must cover every final hunk twice`);
  }
  return {
    runId: value.runId,
    manifestSha256: sha(value.manifestSha256, `${label}.manifestSha256`),
    baselineVerified: true,
    admissionVerified: true,
    finalCommandsPassed: true,
    finalSafetyVerdict: "SAFE",
    finalDiffSha256: sha(value.finalDiffSha256, `${label}.finalDiffSha256`),
    finalChangedHunks,
    safetyProbes,
    completedAt: timestamp(value.completedAt, `${label}.completedAt`),
  };
}

function parseReport(value: unknown, reportSha256: unknown, label: string): { auditorReport: string; reportSha256: string } {
  const auditorReport = bounded(value, `${label}.auditorReport`, 128, 512_000);
  const reportHash = sha(reportSha256, `${label}.reportSha256`);
  if (hash(auditorReport) !== reportHash) throw new Error(`${label}.auditorReport hash mismatch`);
  for (const marker of ["TOTAL_CUTS=", "TOTAL_FAMILIES=", "TOTAL_OPERATIONS=", "ADMISSION_CUTS_JSON="]) {
    if (!auditorReport.includes(marker)) throw new Error(`${label}.auditorReport is missing ${marker}`);
  }
  if (FORBIDDEN_REPORT_CONTENT.test(auditorReport)) throw new Error(`${label}.auditorReport contains forbidden evaluation data`);
  return { auditorReport, reportSha256: reportHash };
}

export function piFrontierVerificationConfigSha256(manifest: PiFrontierAdmissionManifestScope): string {
  return hash(canonicalJson({
    policy: PI_FRONTIER_ADMISSION_POLICY,
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

export function piFrontierAdmissionScope(manifest: PiFrontierAdmissionManifestScope): PiFrontierAdmissionScope | null {
  if (!manifest.cacheEligible || manifest.cacheIneligibilityReasons.length || !manifest.contractTreeSha256 || !manifest.commands.length) return null;
  if (!SHA256.test(manifest.trackedTreeSha256) || !SHA256.test(manifest.contractTreeSha256)) return null;
  return {
    mode: PI_FRONTIER_ADMISSION_POLICY,
    contractTreeSha256: manifest.contractTreeSha256,
    trackedTreeSha256: manifest.trackedTreeSha256,
    verificationConfigSha256: piFrontierVerificationConfigSha256(manifest),
  };
}

function parseEntry(value: unknown, index: number): PiFrontierAdmissionCacheEntry {
  const label = `entries[${index}]`;
  exactKeys(value, ["cacheEntryId", "scope", "auditorReport", "reportSha256", "provenance", "createdAt", "lastUsedAt"], label);
  if (typeof value.cacheEntryId !== "string" || !/^[a-f0-9]{32}$/.test(value.cacheEntryId)) throw new Error(`${label}.cacheEntryId is invalid`);
  const report = parseReport(value.auditorReport, value.reportSha256, label);
  return {
    cacheEntryId: value.cacheEntryId,
    scope: parseScope(value.scope, `${label}.scope`),
    ...report,
    provenance: parseProvenance(value.provenance, `${label}.provenance`),
    createdAt: timestamp(value.createdAt, `${label}.createdAt`),
    lastUsedAt: timestamp(value.lastUsedAt, `${label}.lastUsedAt`),
  };
}

export function parsePiFrontierAdmissionCache(value: unknown): PiFrontierAdmissionCache {
  exactKeys(value, ["schemaVersion", "entries"], "cache");
  if (value.schemaVersion !== 1) throw new Error("cache.schemaVersion must be 1");
  if (!Array.isArray(value.entries) || value.entries.length > PI_FRONTIER_ADMISSION_CACHE_LIMIT) {
    throw new Error(`cache.entries must contain at most ${PI_FRONTIER_ADMISSION_CACHE_LIMIT} entries`);
  }
  const entries = value.entries.map(parseEntry);
  if (new Set(entries.map((entry) => entry.cacheEntryId)).size !== entries.length) throw new Error("cache entry ids must be unique");
  if (new Set(entries.map((entry) => canonicalJson(entry.scope))).size !== entries.length) throw new Error("cache entry scopes must be unique");
  return { schemaVersion: 1, entries };
}

export function parsePiFrontierAdmissionArtifact(value: unknown): PiFrontierAdmissionArtifact {
  exactKeys(value, ["schemaVersion", "scope", "auditorReport", "reportSha256", "provenance"], "artifact");
  if (value.schemaVersion !== 1) throw new Error("artifact.schemaVersion must be 1");
  const report = parseReport(value.auditorReport, value.reportSha256, "artifact");
  return {
    schemaVersion: 1,
    scope: parseScope(value.scope, "artifact.scope"),
    ...report,
    provenance: parseProvenance(value.provenance, "artifact.provenance"),
  };
}

export function admissionArtifactSha256(artifact: PiFrontierAdmissionArtifact): string {
  return hash(JSON.stringify(artifact));
}

export function recallPiFrontierAdmission(
  cache: PiFrontierAdmissionCache,
  manifest: PiFrontierAdmissionManifestScope,
): PiFrontierAdmissionCacheEntry | null {
  const scope = piFrontierAdmissionScope(manifest);
  if (!scope) return null;
  const key = canonicalJson(scope);
  return cache.entries.find((entry) => canonicalJson(entry.scope) === key) ?? null;
}

export function artifactFromPiFrontierAdmission(entry: PiFrontierAdmissionCacheEntry): PiFrontierAdmissionArtifact {
  return {
    schemaVersion: 1,
    scope: entry.scope,
    auditorReport: entry.auditorReport,
    reportSha256: entry.reportSha256,
    provenance: entry.provenance,
  };
}

export function createPiFrontierAdmissionEntry(input: {
  scope: PiFrontierAdmissionScope;
  auditorReport: string;
  provenance: PiFrontierAdmissionProvenance;
  now?: string;
}): PiFrontierAdmissionCacheEntry {
  const now = input.now ?? new Date().toISOString();
  const reportSha256 = hash(input.auditorReport);
  const parsed = parsePiFrontierAdmissionArtifact({
    schemaVersion: 1,
    scope: input.scope,
    auditorReport: input.auditorReport,
    reportSha256,
    provenance: input.provenance,
  });
  return {
    cacheEntryId: hash(`${canonicalJson(parsed.scope)}\0${reportSha256}`).slice(0, 32),
    scope: parsed.scope,
    auditorReport: parsed.auditorReport,
    reportSha256,
    provenance: parsed.provenance,
    createdAt: timestamp(now, "entry.createdAt"),
    lastUsedAt: timestamp(now, "entry.lastUsedAt"),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function evidenceFingerprint(value: unknown, label: string): { sha256: string; changedHunks: number; untrackedFiles: number; hunks: unknown[] } {
  exactKeys(value, ["sha256", "changedHunks", "untrackedFiles", "hunks"], label);
  if (!Array.isArray(value.hunks) || value.hunks.length !== value.changedHunks) throw new Error(`${label}.hunks must match changedHunks`);
  const ids = new Set<string>();
  const hunks = value.hunks.map((hunk, index) => {
    exactKeys(hunk, ["id", "kind", "locator"], `${label}.hunks[${index}]`);
    const id = bounded(hunk.id, `${label}.hunks[${index}].id`, 3, 160);
    if (!/^[a-z0-9-]+$/.test(id) || ids.has(id)) throw new Error(`${label}.hunks[${index}].id is invalid or duplicated`);
    ids.add(id);
    if (hunk.kind !== "tracked" && hunk.kind !== "untracked") throw new Error(`${label}.hunks[${index}].kind is invalid`);
    return { id, kind: hunk.kind, locator: bounded(hunk.locator, `${label}.hunks[${index}].locator`, 1, 500) };
  });
  return {
    sha256: sha(value.sha256, `${label}.sha256`),
    changedHunks: nonNegativeInteger(value.changedHunks, `${label}.changedHunks`),
    untrackedFiles: nonNegativeInteger(value.untrackedFiles, `${label}.untrackedFiles`),
    hunks,
  };
}

function commandEvidencePassed(value: unknown, manifest: PiFrontierAdmissionManifestScope): boolean {
  if (!Array.isArray(value) || value.length !== manifest.commands.length) return false;
  return value.every((entry, index) => {
    const item = record(entry);
    const expected = manifest.commands[index];
    return item?.id === expected.id && item.exitCode === 0 && item.command === expected.command &&
      canonicalJson(item.args) === canonicalJson(expected.args) && item.cwdRelative === expected.cwdRelative;
  });
}

export function createPiFrontierAdmissionEntryFromEvidence(input: {
  manifest: PiFrontierAdmissionManifestScope;
  manifestSha256: string;
  runId: string;
  evidence: unknown;
  now?: string;
}): PiFrontierAdmissionCacheEntry {
  const scope = piFrontierAdmissionScope(input.manifest);
  if (!scope) throw new Error("manifest is not cache eligible");
  const manifestSha256 = sha(input.manifestSha256, "manifestSha256");
  if (!ID.test(input.runId)) throw new Error("runId is invalid");
  const evidence = record(input.evidence);
  if (!evidence) throw new Error("Frontier evidence must be an object");
  if (evidence.stage !== "final-safe" && evidence.stage !== "final-safe-no-change") {
    throw new Error("Frontier evidence does not have a final SAFE stage");
  }
  if (evidence.runId !== input.runId || evidence.manifestSha256 !== manifestSha256 ||
    evidence.baselineVerified !== true || evidence.admissionVerified !== true ||
    evidence.admissionSource !== "managed-review") {
    throw new Error("Frontier evidence lacks fresh managed baseline and admission provenance");
  }
  if (!commandEvidencePassed(evidence.baselineCommands, input.manifest) ||
    !commandEvidencePassed(evidence.finalCommands, input.manifest)) {
    throw new Error("Frontier evidence does not prove every current verification command");
  }
  const report = bounded(evidence.admissionReport, "evidence.admissionReport", 128, 512_000);
  if (hash(report) !== evidence.admissionReportSha256) throw new Error("Frontier evidence admission report hash mismatch");
  const cutMatches = [...report.matchAll(/^ADMISSION_CUTS_JSON=(.*)$/gm)];
  if (cutMatches.length !== 1) throw new Error("Frontier evidence admission report lacks one exact cut portfolio");
  let reportCuts: unknown;
  try { reportCuts = JSON.parse(cutMatches[0][1].trim()); }
  catch { throw new Error("Frontier evidence admission cut portfolio is invalid JSON"); }
  if (!Array.isArray(reportCuts) || !Array.isArray(evidence.admissionCuts) ||
    canonicalJson(reportCuts) !== canonicalJson(evidence.admissionCuts)) {
    throw new Error("Frontier evidence admission cuts do not match the managed report");
  }
  const expectedCutCount = input.manifest.frontierPolicy.targetCuts;
  if (reportCuts.length !== expectedCutCount) throw new Error(`Frontier evidence requires exactly ${expectedCutCount} adaptive admission cuts`);
  const cutIds = new Set<string>();
  const cutFamilies = new Map<string, string>();
  const cutObligations = new Map<string, Set<string>>();
  const familyCounts = new Map<string, number>();
  const operations = new Set<string>();
  const exactObligationIds = new Set(input.manifest.contractObligations.map((obligation) => obligation.id));
  const admittedObligationIds = new Set<string>();
  reportCuts.forEach((cut, index) => {
    const item = record(cut);
    if (!item) throw new Error(`Frontier evidence admissionCuts[${index}] is invalid`);
    exactKeys(item, ["id", "family", "operations", "obligationIds", "contractCitations", "implementationRoots", "failureMode", "positiveProbe", "negativeProbe"], `evidence.admissionCuts[${index}]`);
    if (typeof item.id !== "string" || !ID.test(item.id) || cutIds.has(item.id)) throw new Error(`evidence.admissionCuts[${index}].id is invalid`);
    cutIds.add(item.id);
    if (typeof item.family !== "string" || !item.family.trim()) throw new Error(`evidence.admissionCuts[${index}].family is invalid`);
    if (numberedPlaceholder(item.family)) throw new Error(`evidence.admissionCuts[${index}].family is a numbered placeholder alias`);
    const family = semanticTemplate(item.family);
    cutFamilies.set(item.id, family);
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
    if (!Array.isArray(item.operations)) throw new Error(`evidence.admissionCuts[${index}].operations is invalid`);
    for (const operation of item.operations) {
      if (typeof operation !== "string" || !operation.trim()) throw new Error(`evidence.admissionCuts[${index}].operations is invalid`);
      if (numberedPlaceholder(operation)) throw new Error(`evidence.admissionCuts[${index}].operations contains a placeholder alias`);
      operations.add(semanticTemplate(operation));
    }
    if (!Array.isArray(item.obligationIds) || !item.obligationIds.length ||
      item.obligationIds.length > input.manifest.frontierPolicy.maxObligationsPerCut) {
      throw new Error(`evidence.admissionCuts[${index}].obligationIds is invalid`);
    }
    const obligationIds = new Set<string>();
    for (const obligationId of item.obligationIds) {
      if (typeof obligationId !== "string" || !exactObligationIds.has(obligationId) || obligationIds.has(obligationId)) {
        throw new Error(`evidence.admissionCuts[${index}].obligationIds is invalid`);
      }
      obligationIds.add(obligationId);
      admittedObligationIds.add(obligationId);
    }
    cutObligations.set(item.id, obligationIds);
  });
  const failureTemplates = new Set(reportCuts.map((cut) => semanticTemplate(String(record(cut)?.failureMode ?? ""))));
  const positiveTemplates = new Set(reportCuts.map((cut) => semanticTemplate(String(record(cut)?.positiveProbe ?? ""))));
  const negativeTemplates = new Set(reportCuts.map((cut) => semanticTemplate(String(record(cut)?.negativeProbe ?? ""))));
  if (failureTemplates.size !== reportCuts.length || positiveTemplates.size !== reportCuts.length || negativeTemplates.size !== reportCuts.length) {
    throw new Error("Frontier evidence admission portfolio uses numeric/hash-only failure or probe aliases");
  }
  if (admittedObligationIds.size !== exactObligationIds.size) {
    throw new Error("Frontier evidence admission portfolio does not cover the exact contract obligation atlas");
  }
  const deepFamilies = [...familyCounts.values()].filter((count) => count >= 2).length;
  const criticalFamilies = [...familyCounts.values()].filter((count) => count >= 3).length;
  if (familyCounts.size < input.manifest.frontierPolicy.minFamilies || operations.size < input.manifest.frontierPolicy.minOperations ||
    deepFamilies < input.manifest.frontierPolicy.minDeepFamilies || criticalFamilies < input.manifest.frontierPolicy.minCriticalFamilies) {
    throw new Error("Frontier evidence admission portfolio lacks required risk-weighted family depth");
  }
  const finalFingerprint = evidenceFingerprint(evidence.finalFingerprint, "evidence.finalFingerprint");
  const safeFingerprint = evidenceFingerprint(evidence.finalSafeFingerprint, "evidence.finalSafeFingerprint");
  if (finalFingerprint.sha256 !== safeFingerprint.sha256 || finalFingerprint.changedHunks !== safeFingerprint.changedHunks ||
    finalFingerprint.untrackedFiles !== safeFingerprint.untrackedFiles || canonicalJson(finalFingerprint.hunks) !== canonicalJson(safeFingerprint.hunks)) {
    throw new Error("Frontier evidence SAFE fingerprint does not match final verification");
  }
  const safety = record(evidence.safetyAssessment);
  if (!safety || safety.verdict !== "SAFE" || safety.regressions !== 0 ||
    safety.changedHunks !== finalFingerprint.changedHunks || safety.reviewedHunks !== finalFingerprint.changedHunks ||
    !Number.isSafeInteger(safety.probes) || Number(safety.probes) < (finalFingerprint.changedHunks > 0
      ? Math.max(
        finalFingerprint.changedHunks * 2,
        Math.ceil(input.manifest.contractObligations.filter((obligation) => obligation.proofMode === "paired").length /
          input.manifest.frontierPolicy.maxObligationsPerProbe) * 2 +
          Math.ceil(input.manifest.contractObligations.filter((obligation) => obligation.proofMode === "positive").length /
            input.manifest.frontierPolicy.maxObligationsPerProbe),
        cutIds.size * 2 + [...familyCounts.values()]
          .reduce((total, count) => total + (count >= 3 ? 2 : count >= 2 ? 1 : 0), 0) +
          input.manifest.frontierPolicy.minCounterfactualFamilies +
          (Array.isArray(evidence.regressionLedger) ? evidence.regressionLedger.length : 0),
      )
      : 0)) {
    throw new Error("Frontier evidence lacks complete zero-regression safety coverage");
  }
  if (!Array.isArray(evidence.safetyEvidence) || evidence.safetyEvidence.length !== Number(safety.probes)) {
    throw new Error("Frontier evidence structured safety records do not match the probe total");
  }
  if (!Array.isArray(evidence.regressionLedger) || evidence.regressionLedger.length > 512) {
    throw new Error("Frontier evidence regression ledger is invalid");
  }
  const regressionLedger = evidence.regressionLedger.map((entry, index) => {
    exactKeys(entry, ["id", "cutId", "command", "contractCitation", "expected", "firstObserved"], `evidence.regressionLedger[${index}]`);
    if (typeof entry.id !== "string" || !ID.test(entry.id) || typeof entry.cutId !== "string" || !cutIds.has(entry.cutId) ||
      typeof entry.command !== "string" || !entry.command.trim() || typeof entry.contractCitation !== "string" || !entry.contractCitation.trim() ||
      typeof entry.expected !== "string" || !entry.expected.trim() || typeof entry.firstObserved !== "string" || !entry.firstObserved.trim()) {
      throw new Error(`evidence.regressionLedger[${index}] is invalid`);
    }
    return entry;
  });
  if (new Set(regressionLedger.map((entry) => entry.id)).size !== regressionLedger.length) {
    throw new Error("Frontier evidence regression replay ids must be unique");
  }
  const exactHunkIds = new Set(finalFingerprint.hunks.map((hunk) => {
    const item = record(hunk);
    return typeof item?.id === "string" ? item.id : "";
  }));
  const hunkKinds = new Map<string, Set<string>>();
  const cutKinds = new Map<string, Set<string>>();
  const familyInteractions = new Map<string, number>();
  const counterfactualFamilies = new Set<string>();
  const safetyObligationKinds = new Map<string, Set<string>>();
  let structuredRegressions = 0;
  evidence.safetyEvidence.forEach((probe, index) => {
    exactKeys(probe, ["id", "cutId", "hunkId", "kind", "command", "obligationIds", "contractCitation", "expected", "observed", "verdict"], `evidence.safetyEvidence[${index}]`);
    if (typeof probe.cutId !== "string" || !cutIds.has(probe.cutId)) throw new Error(`evidence.safetyEvidence[${index}].cutId is not exact`);
    const probeCutId = probe.cutId;
    if (typeof probe.hunkId !== "string" || !exactHunkIds.has(probe.hunkId)) throw new Error(`evidence.safetyEvidence[${index}].hunkId is not exact`);
    if (probe.kind !== "intended" && probe.kind !== "non-regression" && probe.kind !== "interaction" && probe.kind !== "counterfactual" && probe.kind !== "regression-replay") throw new Error(`evidence.safetyEvidence[${index}].kind is invalid`);
    if (!Array.isArray(probe.obligationIds) || !probe.obligationIds.length ||
      probe.obligationIds.length > input.manifest.frontierPolicy.maxObligationsPerProbe ||
      new Set(probe.obligationIds).size !== probe.obligationIds.length ||
      probe.obligationIds.some((obligationId) => typeof obligationId !== "string" || !cutObligations.get(probeCutId)?.has(obligationId))) {
      throw new Error(`evidence.safetyEvidence[${index}].obligationIds is invalid`);
    }
    if (probe.kind === "intended" || probe.kind === "non-regression" || probe.kind === "interaction") {
      (probe.obligationIds as string[]).forEach((obligationId) => {
        const kinds = safetyObligationKinds.get(obligationId) ?? new Set<string>();
        kinds.add(probe.kind as string);
        safetyObligationKinds.set(obligationId, kinds);
      });
    }
    if (probe.kind === "counterfactual") {
      if (typeof probe.observed !== "string" || !probe.observed.includes("ORIGINAL_PASS_MUTANT_FAIL")) {
        throw new Error(`evidence.safetyEvidence[${index}] lacks an attested counterfactual mutation kill`);
      }
      const family = cutFamilies.get(probeCutId);
      if (family) counterfactualFamilies.add(family);
    }
    if (probe.verdict !== "PASS" && probe.verdict !== "REGRESSION") throw new Error(`evidence.safetyEvidence[${index}].verdict is invalid`);
    if (probe.verdict === "REGRESSION") structuredRegressions += 1;
    const kinds = hunkKinds.get(probe.hunkId) ?? new Set<string>();
    kinds.add(probe.kind);
    hunkKinds.set(probe.hunkId, kinds);
    const admittedKinds = cutKinds.get(probe.cutId) ?? new Set<string>();
    admittedKinds.add(probe.kind);
    cutKinds.set(probe.cutId, admittedKinds);
    if (probe.kind === "interaction") {
      const family = cutFamilies.get(probe.cutId);
      if (family) familyInteractions.set(family, (familyInteractions.get(family) ?? 0) + 1);
    }
  });
  for (const hunkId of exactHunkIds) {
    const kinds = hunkKinds.get(hunkId);
    if (!kinds?.has("intended") || !kinds.has("non-regression")) {
      throw new Error(`Frontier evidence hunk ${hunkId} lacks both structured probe kinds`);
    }
  }
  if (finalFingerprint.changedHunks > 0) {
    for (const cutId of cutIds) {
      const kinds = cutKinds.get(cutId);
      if (!kinds?.has("intended") || !kinds.has("non-regression")) {
        throw new Error(`Frontier evidence cut ${cutId} lacks both structured probe kinds`);
      }
    }
    for (const [family, count] of familyCounts) {
      const required = count >= 3 ? 2 : count >= 2 ? 1 : 0;
      if ((familyInteractions.get(family) ?? 0) < required) {
        throw new Error(`Frontier evidence family ${family} lacks required cross-cut interaction probes`);
      }
    }
    for (const obligation of input.manifest.contractObligations) {
      const kinds = safetyObligationKinds.get(obligation.id);
      if (obligation.proofMode === "paired") {
        if (!kinds?.has("intended") || !kinds.has("non-regression")) {
          throw new Error(`Frontier evidence paired contract atom ${obligation.id} lacks intended and non-regression coverage`);
        }
      } else if (!kinds?.has("intended") && !kinds?.has("non-regression") && !kinds?.has("interaction")) {
        throw new Error(`Frontier evidence positive contract atom ${obligation.id} lacks executable coverage`);
      }
    }
    if (counterfactualFamilies.size < input.manifest.frontierPolicy.minCounterfactualFamilies) {
      throw new Error("Frontier evidence lacks required counterfactual family coverage");
    }
    for (const replay of regressionLedger) {
      const matches = evidence.safetyEvidence.filter((probe) => probe.kind === "regression-replay" && probe.verdict === "PASS" &&
        probe.cutId === replay.cutId && probe.command === replay.command &&
        probe.contractCitation === replay.contractCitation && probe.expected === replay.expected);
      if (matches.length !== 1) {
        throw new Error(`Frontier evidence mandatory regression replay ${replay.id} did not pass exactly once`);
      }
    }
  }
  if (structuredRegressions !== safety.regressions) throw new Error("Frontier evidence structured regression count does not match safety totals");
  const completedAt = timestamp(evidence.updatedAt, "evidence.updatedAt");
  return createPiFrontierAdmissionEntry({
    scope,
    auditorReport: report,
    provenance: {
      runId: input.runId,
      manifestSha256,
      baselineVerified: true,
      admissionVerified: true,
      finalCommandsPassed: true,
      finalSafetyVerdict: "SAFE",
      finalDiffSha256: finalFingerprint.sha256,
      finalChangedHunks: finalFingerprint.changedHunks,
      safetyProbes: Number(safety.probes),
      completedAt,
    },
    now: input.now,
  });
}

export function upsertPiFrontierAdmission(
  cache: PiFrontierAdmissionCache,
  entry: PiFrontierAdmissionCacheEntry,
): PiFrontierAdmissionCache {
  const parsedCache = parsePiFrontierAdmissionCache(cache);
  const parsedEntry = parseEntry(entry, 0);
  const scopeKey = canonicalJson(parsedEntry.scope);
  const entries = parsedCache.entries.filter((existing) => canonicalJson(existing.scope) !== scopeKey);
  entries.unshift(parsedEntry);
  entries.sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt));
  return { schemaVersion: 1, entries: entries.slice(0, PI_FRONTIER_ADMISSION_CACHE_LIMIT) };
}

export function emptyPiFrontierAdmissionCache(): PiFrontierAdmissionCache {
  return { schemaVersion: 1, entries: [] };
}
