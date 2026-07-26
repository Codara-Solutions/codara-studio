#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  admissionArtifactSha256,
  artifactFromPiFrontierAdmission,
  createPiFrontierAdmissionEntry,
  createPiFrontierAdmissionEntryFromEvidence,
  emptyPiFrontierAdmissionCache,
  parsePiFrontierAdmissionArtifact,
  parsePiFrontierAdmissionCache,
  piFrontierAdmissionScope,
  piFrontierVerificationConfigSha256,
  recallPiFrontierAdmission,
  upsertPiFrontierAdmission,
} from "../src/main/orchestration/pi-admission-cache.ts";
import {
  frontierVerificationConfigSha256,
  loadFrontierAdmissionArtifact,
  parseFrontierAdmissionArtifact,
} from "../resources/pi-cora/frontier-cache.ts";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const manifest = {
  schemaVersion: 4,
  workspaceRoot: "/synthetic/workspace",
  trackedTreeSha256: "1".repeat(64),
  contractTreeSha256: "2".repeat(64),
  cacheEligible: true,
  cacheIneligibilityReasons: [],
  contractPaths: ["README.md"],
  requestContract: null,
  contractObligations: [{
    id: `obligation-${"a".repeat(20)}`,
    kind: "markdown-atom",
    proofMode: "paired",
    title: "Contract",
    sources: [{ path: "README.md", locator: "L1" }],
    contentSha256: "a".repeat(64),
    excerpt: "The documented behavior remains exact.",
  }],
  frontierPolicy: {
    schemaVersion: 3,
    targetCuts: 5,
    minFamilies: 4,
    minOperations: 3,
    minDeepFamilies: 0,
    minCriticalFamilies: 0,
    maxObligationsPerCut: 8,
    maxObligationsPerProbe: 4,
    minCounterfactualFamilies: 4,
  },
  sourceManifests: ["package.json"],
  commands: [{
    id: "npm-root-test",
    command: "npm",
    args: ["run", "test", "--if-present"],
    cwdRelative: ".",
    timeoutMs: 900_000,
    source: "package-json",
    sourcePath: "package.json",
  }],
};
const familyNames = ["validation boundary", "state lifecycle", "persistence integrity", "recovery semantics", "contract observability"];
const operationNames = ["read", "write", "resume", "recover", "inspect"];
const boundaryNames = ["malformed input", "partial publication", "checksum drift", "stale restoration", "projection leakage"];
const cuts = [0, 1, 2, 3, 4].map((index) => ({
  id: `cut-${index}`,
  family: familyNames[index],
  operations: [operationNames[index]],
  obligationIds: [manifest.contractObligations[0].id],
  contractCitations: ["README.md:1"],
  implementationRoots: [`src/root-${index}.js:1`],
  failureMode: `The ${boundaryNames[index]} boundary violates its documented invariant.`,
  positiveProbe: `Exercise valid ${boundaryNames[index]} behavior and assert its exact observable result.`,
  negativeProbe: `Exercise invalid ${boundaryNames[index]} behavior and assert atomic rejection.`,
}));
const report = [
  "Independent exact-state contract audit.",
  "TOTAL_CUTS=5",
  "TOTAL_FAMILIES=5",
  "TOTAL_OPERATIONS=5",
  `ADMISSION_CUTS_JSON=${JSON.stringify(cuts)}`,
].join("\n");
const scope = piFrontierAdmissionScope(manifest);
assert.ok(scope);
assert.equal(scope.verificationConfigSha256, piFrontierVerificationConfigSha256(manifest));
assert.equal(scope.verificationConfigSha256, frontierVerificationConfigSha256(manifest));

const provenance = {
  runId: "run-cache-source",
  manifestSha256: "3".repeat(64),
  baselineVerified: true,
  admissionVerified: true,
  finalCommandsPassed: true,
  finalSafetyVerdict: "SAFE",
  finalDiffSha256: "4".repeat(64),
  finalChangedHunks: 2,
  safetyProbes: 10,
  completedAt: "2026-07-20T12:00:00.000Z",
};
const entry = createPiFrontierAdmissionEntry({ scope, auditorReport: report, provenance, now: "2026-07-20T12:00:01.000Z" });
const cache = upsertPiFrontierAdmission(emptyPiFrontierAdmissionCache(), entry);
assert.equal(parsePiFrontierAdmissionCache(cache).entries.length, 1);
assert.equal(recallPiFrontierAdmission(cache, manifest)?.cacheEntryId, entry.cacheEntryId);

const changedTree = { ...manifest, trackedTreeSha256: "5".repeat(64) };
assert.equal(recallPiFrontierAdmission(cache, changedTree), null);
const changedContract = { ...manifest, contractTreeSha256: "6".repeat(64) };
assert.equal(recallPiFrontierAdmission(cache, changedContract), null);
const changedCommand = { ...manifest, commands: [{ ...manifest.commands[0], args: ["run", "typecheck"] }] };
assert.equal(recallPiFrontierAdmission(cache, changedCommand), null);
assert.equal(piFrontierAdmissionScope({ ...manifest, cacheEligible: false, cacheIneligibilityReasons: ["untracked"] }), null);

const artifact = artifactFromPiFrontierAdmission(entry);
assert.deepEqual(parsePiFrontierAdmissionArtifact(artifact), artifact);
assert.deepEqual(parseFrontierAdmissionArtifact(artifact), artifact);
assert.equal(admissionArtifactSha256(artifact), digest(JSON.stringify(artifact)));
const legacyArtifact = { ...artifact, scope: { ...artifact.scope, mode: "frontier-admission-v9" } };
assert.throws(() => parsePiFrontierAdmissionArtifact(legacyArtifact), /mode is unsupported/);
assert.throws(() => parseFrontierAdmissionArtifact(legacyArtifact), /mode is unsupported/);

const commandEvidence = [{
  id: "npm-root-test",
  command: "npm",
  args: ["run", "test", "--if-present"],
  cwdRelative: ".",
  exitCode: 0,
  durationMs: 10,
  stdoutSha256: "7".repeat(64),
  stderrSha256: "8".repeat(64),
}];
const promotionSafetyEvidence = cuts.flatMap((cut, index) => {
  const hunkId = index % 2 === 0
    ? "tracked-1-hunk-1-aaaaaaaaaaaa"
    : "tracked-2-hunk-1-bbbbbbbbbbbb";
  return ["intended", "non-regression"].map((kind) => ({
    id: `${cut.id}-${kind}`,
    cutId: cut.id,
    hunkId,
    kind,
    command: `node -e ${cut.id}-${kind}`,
    obligationIds: cut.obligationIds,
    contractCitation: "README.md:1",
    expected: "The documented behavior remains exact.",
    observed: "The focused probe passed exactly.",
    verdict: "PASS",
  }));
});
const replaySource = promotionSafetyEvidence[0];
const regressionLedger = [{
  id: "replay-aaaaaaaaaaaaaaaa",
  cutId: replaySource.cutId,
  command: replaySource.command,
  contractCitation: replaySource.contractCitation,
  expected: replaySource.expected,
  firstObserved: "The exact command previously reproduced a regression.",
}];
for (let index = 0; index < 4; index += 1) {
  promotionSafetyEvidence.push({
    ...promotionSafetyEvidence[index * 2],
    id: `counterfactual-${index}`,
    kind: "counterfactual",
    command: `node -e counterfactual-${index}`,
    expected: "A plausible semantic mutant is rejected by the focused oracle.",
    observed: "ORIGINAL_PASS_MUTANT_FAIL was observed in an isolated temporary copy.",
  });
}
promotionSafetyEvidence.push({
  ...replaySource,
  id: "mandatory-replay-pass",
  kind: "regression-replay",
  observed: "The exact previously failing command now passes.",
});
const promotionEvidence = {
  stage: "final-safe",
  runId: "run-cache-source",
  manifestSha256: "3".repeat(64),
  baselineVerified: true,
  baselineCommands: commandEvidence,
  admissionVerified: true,
  admissionSource: "managed-review",
  admissionReport: report,
  admissionReportSha256: digest(report),
  admissionCuts: cuts,
  finalCommands: commandEvidence,
  finalFingerprint: {
    sha256: "4".repeat(64), changedHunks: 2, untrackedFiles: 0,
    hunks: [
      { id: "tracked-1-hunk-1-aaaaaaaaaaaa", kind: "tracked", locator: "src/a.js @@ -1 +1 @@" },
      { id: "tracked-2-hunk-1-bbbbbbbbbbbb", kind: "tracked", locator: "src/b.js @@ -1 +1 @@" },
    ],
  },
  finalSafeFingerprint: {
    sha256: "4".repeat(64), changedHunks: 2, untrackedFiles: 0,
    hunks: [
      { id: "tracked-1-hunk-1-aaaaaaaaaaaa", kind: "tracked", locator: "src/a.js @@ -1 +1 @@" },
      { id: "tracked-2-hunk-1-bbbbbbbbbbbb", kind: "tracked", locator: "src/b.js @@ -1 +1 @@" },
    ],
  },
  safetyAssessment: { changedHunks: 2, reviewedHunks: 2, probes: 15, regressions: 0, verdict: "SAFE" },
  safetyEvidence: promotionSafetyEvidence,
  regressionLedger,
  updatedAt: "2026-07-20T12:00:00.000Z",
};
const promoted = createPiFrontierAdmissionEntryFromEvidence({
  manifest,
  manifestSha256: "3".repeat(64),
  runId: "run-cache-source",
  evidence: promotionEvidence,
  now: "2026-07-20T12:00:02.000Z",
});
assert.equal(promoted.provenance.safetyProbes, 15);
assert.equal(promoted.auditorReport, report);
const reportWithCuts = (portfolio) => [
  "Independent exact-state contract audit.",
  "TOTAL_CUTS=5",
  "TOTAL_FAMILIES=5",
  "TOTAL_OPERATIONS=5",
  `ADMISSION_CUTS_JSON=${JSON.stringify(portfolio)}`,
].join("\n");
const aliasedFamilyCuts = cuts.map((cut, index) => ({ ...cut, family: `surface conformance ${index + 1}` }));
const aliasedFamilyReport = reportWithCuts(aliasedFamilyCuts);
assert.throws(() => createPiFrontierAdmissionEntryFromEvidence({
  manifest,
  manifestSha256: "3".repeat(64),
  runId: "run-cache-source",
  evidence: {
    ...promotionEvidence,
    admissionReport: aliasedFamilyReport,
    admissionReportSha256: digest(aliasedFamilyReport),
    admissionCuts: aliasedFamilyCuts,
  },
}), /risk-weighted family depth/);
const aliasedProbeCuts = cuts.map((cut, index) => ({
  ...cut,
  failureMode: `Failure boundary ${index + 1}`,
  positiveProbe: `Positive boundary probe ${index + 1}`,
  negativeProbe: `Negative boundary probe ${index + 1}`,
}));
const aliasedProbeReport = reportWithCuts(aliasedProbeCuts);
assert.throws(() => createPiFrontierAdmissionEntryFromEvidence({
  manifest,
  manifestSha256: "3".repeat(64),
  runId: "run-cache-source",
  evidence: {
    ...promotionEvidence,
    admissionReport: aliasedProbeReport,
    admissionReportSha256: digest(aliasedProbeReport),
    admissionCuts: aliasedProbeCuts,
  },
}), /numeric\/hash-only failure or probe aliases/);
assert.throws(() => createPiFrontierAdmissionEntryFromEvidence({
  manifest,
  manifestSha256: "3".repeat(64),
  runId: "run-cache-source",
  evidence: { ...promotionEvidence, admissionSource: "cache" },
}), /fresh managed baseline and admission provenance/);
assert.throws(() => createPiFrontierAdmissionEntryFromEvidence({
  manifest,
  manifestSha256: "3".repeat(64),
  runId: "run-cache-source",
  evidence: { ...promotionEvidence, safetyAssessment: { ...promotionEvidence.safetyAssessment, verdict: "UNSAFE", regressions: 1 } },
}), /zero-regression safety coverage/);
assert.throws(() => createPiFrontierAdmissionEntryFromEvidence({
  manifest,
  manifestSha256: "3".repeat(64),
  runId: "run-cache-source",
  evidence: { ...promotionEvidence, finalCommands: [{ ...commandEvidence[0], exitCode: 1 }] },
}), /every current verification command/);
assert.throws(() => createPiFrontierAdmissionEntryFromEvidence({
  manifest,
  manifestSha256: "3".repeat(64),
  runId: "run-cache-source",
  evidence: { ...promotionEvidence, finalSafeFingerprint: { ...promotionEvidence.finalSafeFingerprint, sha256: "9".repeat(64) } },
}), /SAFE fingerprint does not match/);
assert.throws(() => createPiFrontierAdmissionEntryFromEvidence({
  manifest,
  manifestSha256: "3".repeat(64),
  runId: "run-cache-source",
  evidence: {
    ...promotionEvidence,
    safetyEvidence: [
      ...promotionEvidence.safetyEvidence.filter((probe) => probe.kind !== "regression-replay"),
      { ...promotionSafetyEvidence[10], id: "replacement-non-replay", command: "node -e replacement-non-replay" },
    ],
  },
}), /mandatory regression replay/);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codara-admission-cache-"));
try {
  const artifactPath = path.join(temporary, "hit.json");
  fs.writeFileSync(artifactPath, JSON.stringify(artifact), { mode: 0o600 });
  assert.equal(loadFrontierAdmissionArtifact(artifactPath, admissionArtifactSha256(artifact), manifest).reportSha256, entry.reportSha256);
  assert.throws(() => loadFrontierAdmissionArtifact(artifactPath, "f".repeat(64), manifest), /hash mismatch/);
  assert.throws(() => loadFrontierAdmissionArtifact(artifactPath, admissionArtifactSha256(artifact), changedTree), /scope does not match/);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

assert.throws(() => parsePiFrontierAdmissionArtifact({ ...artifact, auditorReport: `${report} tampered` }), /hash mismatch/);
assert.throws(() => parseFrontierAdmissionArtifact({
  ...artifact,
  provenance: { ...artifact.provenance, finalSafetyVerdict: "UNSAFE" },
}), /not independently SAFE/);
assert.throws(() => createPiFrontierAdmissionEntry({
  scope,
  auditorReport: report.replace("Independent exact-state contract audit.", "Independent hidden grader outcome audit."),
  provenance,
}), /forbidden evaluation data/);
assert.throws(() => createPiFrontierAdmissionEntry({
  scope,
  auditorReport: report,
  provenance: { ...provenance, safetyProbes: 3 },
}), /cover every final hunk twice/);
assert.throws(() => parsePiFrontierAdmissionCache({ ...cache, unexpected: true }), /keys must be exactly/);

console.log("Pi Frontier admission cache: independent exact-scope parsing, stale/corrupt refusal, SAFE provenance, and hidden-evaluation exclusion verified");
