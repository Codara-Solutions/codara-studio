#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { validateRegressionReplayEvidence } = require("./pi-frontier-evidence.cjs");

const replay = {
  id: "replay-0123456789abcdef",
  cutId: "persistence",
  command: "node exact.cjs",
  contractCitation: "docs/persistence.md:12-17",
  expected: "A forged digest is rejected.",
  firstObserved: "REGRESSION accepted",
};
const exact = {
  id: "exact",
  kind: "regression-replay",
  verdict: "PASS",
  cutId: replay.cutId,
  command: replay.command,
  contractCitation: replay.contractCitation,
  expected: replay.expected,
  observed: "PASS exact replay",
};
const generalized = {
  id: "generalized",
  kind: "regression-generalization",
  verdict: "PASS",
  cutId: replay.cutId,
  command: "node sibling.cjs",
  contractCitation: replay.contractCitation,
  expected: replay.expected,
  observed: `GENERALIZATION_PASS:${replay.id}`,
};
const evidence = {
  finalFingerprint: { changedHunks: 1 },
  regressionLedger: [replay],
  safetyEvidence: [exact, generalized],
};

assert.deepEqual(validateRegressionReplayEvidence(evidence), {
  ok: true,
  errors: [],
  exactReplays: 1,
  generalizations: 1,
});
assert.match(validateRegressionReplayEvidence({ ...evidence, safetyEvidence: [exact] }).errors.join("\n"), /metamorphic generalization/);
assert.match(validateRegressionReplayEvidence({ ...evidence, safetyEvidence: [generalized] }).errors.join("\n"), /exact passing replay/);
assert.match(validateRegressionReplayEvidence({
  ...evidence,
  safetyEvidence: [exact, { ...generalized, command: replay.command }],
}).errors.join("\n"), /distinct passing metamorphic generalization/);
assert.match(validateRegressionReplayEvidence({
  ...evidence,
  safetyEvidence: [exact, { ...generalized, observed: `${generalized.observed} GENERALIZATION_PASS:replay-fedcba9876543210` }],
}).errors.join("\n"), /ambiguous generalization marker/);
assert.equal(validateRegressionReplayEvidence({ finalFingerprint: { changedHunks: 0 } }).ok, true);

console.log("Pi Frontier external evidence: exact regression replay and causal generalization pairing verified");
