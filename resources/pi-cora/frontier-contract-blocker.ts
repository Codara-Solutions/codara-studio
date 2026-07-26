import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { FrontierVerificationManifest } from "./frontier-core";

export type ContractBlocker = {
  id: string;
  class: "contradiction" | "underdetermined" | "unobservable";
  obligationIds: string[];
  contractCitations: string[];
  claim: string;
  lostWitness: string;
  indistinguishableWorlds: [string, string];
  incompatibleOutcomes: [string, string];
  witnessCommand: string;
  minimalResolutions: string[];
};

export type ContractBlockerExecution = { command: string; output: string };

export const CONTRACT_BLOCKER_KEYS = [
  "id", "class", "obligationIds", "contractCitations", "claim", "lostWitness",
  "indistinguishableWorlds", "incompatibleOutcomes", "witnessCommand", "minimalResolutions",
] as const;

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function bounded(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.trim().length >= min && value.length <= max;
}

function boundedList(value: unknown, min: number, max: number, limit: number): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= limit &&
    value.every((item) => bounded(item, min, max)) && new Set(value).size === value.length;
}

function contractPathForCitation(citation: unknown, contractPaths: string[]): string | null {
  if (typeof citation !== "string") return null;
  return contractPaths.find((contractPath) => citation === contractPath ||
    citation.startsWith(`${contractPath}:`) || citation.startsWith(`${contractPath}#`) || citation.startsWith(`${contractPath} `)) ?? null;
}

export function parseContractBlocker(
  report: string,
  manifest: FrontierVerificationManifest,
  executions: ContractBlockerExecution[],
): { present: boolean; blocker?: ContractBlocker; errors: string[] } {
  const marker = "CONTRACT_BLOCKER_JSON=";
  const first = report.indexOf(marker);
  if (first < 0) return { present: false, errors: [] };
  const errors: string[] = [];
  if (report.indexOf(marker, first + marker.length) >= 0) errors.push("contract blocker report requires exactly one CONTRACT_BLOCKER_JSON marker");
  if (report.includes("ADMISSION_CUTS_JSON=")) errors.push("contract blocker report cannot also contain ADMISSION_CUTS_JSON");
  let parsed: unknown;
  try { parsed = JSON.parse(report.slice(first + marker.length).trim()); }
  catch { return { present: true, errors: [...errors, "CONTRACT_BLOCKER_JSON must be exact trailing JSON"] }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { present: true, errors: [...errors, "CONTRACT_BLOCKER_JSON must be an object"] };
  }
  const row = parsed as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  const wanted = [...CONTRACT_BLOCKER_KEYS].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    errors.push(`contract blocker keys must be exactly ${wanted.join(", ")}`);
  }
  if (row.class !== "contradiction" && row.class !== "underdetermined" && row.class !== "unobservable") {
    errors.push("contract blocker class is invalid");
  }
  if (!boundedList(row.obligationIds, 12, 96, 32)) errors.push("contract blocker obligationIds are invalid");
  if (!boundedList(row.contractCitations, 3, 500, 16)) errors.push("contract blocker contractCitations are invalid");
  if (!bounded(row.claim, 40, 2_000)) errors.push("contract blocker claim is invalid");
  if (!bounded(row.lostWitness, 20, 2_000)) errors.push("contract blocker lostWitness is invalid");
  if (!Array.isArray(row.indistinguishableWorlds) || row.indistinguishableWorlds.length !== 2 ||
    !row.indistinguishableWorlds.every((item) => bounded(item, 20, 2_000)) || row.indistinguishableWorlds[0] === row.indistinguishableWorlds[1]) {
    errors.push("contract blocker indistinguishableWorlds must contain two distinct bounded descriptions");
  }
  if (!Array.isArray(row.incompatibleOutcomes) || row.incompatibleOutcomes.length !== 2 ||
    !row.incompatibleOutcomes.every((item) => bounded(item, 20, 2_000)) || row.incompatibleOutcomes[0] === row.incompatibleOutcomes[1]) {
    errors.push("contract blocker incompatibleOutcomes must contain two distinct bounded descriptions");
  }
  if (!bounded(row.witnessCommand, 20, 6_000) || /^\s*(?:echo|printf)\b/.test(String(row.witnessCommand))) {
    errors.push("contract blocker witnessCommand must be a nontrivial bounded command");
  }
  if (!boundedList(row.minimalResolutions, 20, 2_000, 4) || (row.minimalResolutions as unknown[])?.length < 2) {
    errors.push("contract blocker minimalResolutions must contain 2-4 distinct bounded resolutions");
  }
  if (errors.length) return { present: true, errors };
  const blocker = row as unknown as ContractBlocker;
  const knownObligations = new Map(manifest.contractObligations.map((obligation) => [obligation.id, obligation]));
  for (const id of blocker.obligationIds) if (!knownObligations.has(id)) errors.push(`contract blocker references unknown obligation ${id}`);
  const contractSources = manifest.requestContract
    ? [...manifest.contractPaths, manifest.requestContract.sourcePath]
    : manifest.contractPaths;
  const citedPaths = blocker.contractCitations.map((citation) => contractPathForCitation(citation, contractSources));
  if (citedPaths.some((value) => !value)) errors.push("contract blocker citation must begin with an exact signed contract source");
  if (manifest.requestContract && !citedPaths.includes(manifest.requestContract.sourcePath)) {
    errors.push("contract blocker must cite and reconcile the signed live user request");
  }
  for (const id of blocker.obligationIds) {
    const obligation = knownObligations.get(id);
    if (obligation && !obligation.sources.some((source) => citedPaths.includes(source.path))) {
      errors.push(`contract blocker obligation ${id} has no matching contract citation`);
    }
  }
  const { id: _reportedId, witnessCommand: _witnessCommand, ...semanticBlocker } = blocker;
  const expectedId = `blocker-${hash(canonicalJson(semanticBlocker)).slice(0, 20)}`;
  if (blocker.id !== expectedId) errors.push(`contract blocker id must equal ${expectedId}`);
  const matchingExecutions = executions.filter((execution) => execution.command === blocker.witnessCommand);
  if (matchingExecutions.length !== 1) errors.push("contract blocker witnessCommand must match exactly one successful admission-auditor Bash execution");
  const witnessOutput = matchingExecutions[0]?.output ?? "";
  if (witnessOutput.length > 64_000) errors.push("contract blocker witness output exceeds 64000 bytes");
  const exactMarkerCount = (marker: string) => [...witnessOutput.matchAll(new RegExp(`^${marker}$`, "gm"))].length;
  if (exactMarkerCount(`CONTRACT_BLOCKER_WITNESS=${blocker.id}`) !== 1 ||
    exactMarkerCount("SAME_OBSERVABLE=true") !== 1 || exactMarkerCount("INCOMPATIBLE_OUTCOMES=true") !== 1) {
    errors.push("contract blocker witness output is missing its exact id and observability markers");
  }
  const markerValues = (name: string) => [...witnessOutput.matchAll(new RegExp(`^${name}=([a-f0-9]{64})$`, "gm"))]
    .map((match) => match[1]);
  const observableA = markerValues("OBSERVABLE_A_SHA256");
  const observableB = markerValues("OBSERVABLE_B_SHA256");
  const outcomeA = markerValues("REQUIRED_OUTCOME_A_SHA256");
  const outcomeB = markerValues("REQUIRED_OUTCOME_B_SHA256");
  if (observableA.length !== 1 || observableB.length !== 1 || observableA[0] !== observableB[0]) {
    errors.push("contract blocker witness must bind two equal observable SHA-256 values");
  }
  if (outcomeA.length !== 1 || outcomeB.length !== 1 || outcomeA[0] === outcomeB[0]) {
    errors.push("contract blocker witness must bind two distinct required-outcome SHA-256 values");
  }
  const derivedDigests = [...observableA, ...observableB, ...outcomeA, ...outcomeB];
  if (derivedDigests.some((digest) => blocker.witnessCommand.includes(digest))) {
    errors.push("contract blocker witnessCommand must derive world and outcome digests at runtime instead of embedding them");
  }
  if (!/\b(?:createHash|sha256sum|openssl\s+dgst)\b/.test(blocker.witnessCommand)) {
    errors.push("contract blocker witnessCommand must visibly perform cryptographic hashing at runtime");
  }
  const uniqueCitedPaths = [...new Set(citedPaths.filter((value): value is string => Boolean(value)))];
  const citationMatches = [...witnessOutput.matchAll(/^CITED_CONTRACT_SHA256=([a-f0-9]{64}) (.+)$/gm)]
    .map((match) => ({ sha256: match[1], path: match[2] }));
  if (citationMatches.length !== uniqueCitedPaths.length || new Set(citationMatches.map((item) => item.path)).size !== citationMatches.length) {
    errors.push("contract blocker witness must bind each cited contract path exactly once");
  }
  for (const citedPath of uniqueCitedPaths) {
    const match = citationMatches.find((item) => item.path === citedPath);
    if (!blocker.witnessCommand.includes(citedPath)) {
      errors.push(`contract blocker witnessCommand does not read cited contract path ${citedPath}`);
      continue;
    }
    try {
      const requestSource = manifest.requestContract?.sourcePath === citedPath ? manifest.requestContract : null;
      if (requestSource && !blocker.witnessCommand.includes("CODARA_PI_FRONTIER_MANIFEST")) {
        errors.push("contract blocker witnessCommand must read the signed live user request from CODARA_PI_FRONTIER_MANIFEST");
      }
      const actualSha256 = requestSource
        ? hash(requestSource.text)
        : hash(fs.readFileSync(path.resolve(manifest.workspaceRoot, ...citedPath.split("/"))));
      if (!match || match.sha256 !== actualSha256) errors.push(`contract blocker witness has stale or forged contract bytes for ${citedPath}`);
      if (match && blocker.witnessCommand.includes(match.sha256)) {
        errors.push(`contract blocker witnessCommand embeds the contract digest for ${citedPath} instead of deriving it`);
      }
    } catch {
      errors.push(`contract blocker witness cannot read cited contract path ${citedPath}`);
    }
  }
  return errors.length ? { present: true, errors } : { present: true, blocker, errors: [] };
}
