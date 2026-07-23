"use strict";

const REPLAY_ID = /^replay-[a-f0-9]{16}$/;

function validateRegressionReplayEvidence(evidence) {
  const errors = [];
  const changedHunks = evidence?.finalFingerprint?.changedHunks;
  if (!Number.isSafeInteger(changedHunks) || changedHunks < 0) {
    return { ok: false, errors: ["final fingerprint changed-hunk count is invalid"], exactReplays: 0, generalizations: 0 };
  }
  if (changedHunks === 0) return { ok: true, errors: [], exactReplays: 0, generalizations: 0 };
  const ledger = Array.isArray(evidence?.regressionLedger) ? evidence.regressionLedger : null;
  const probes = Array.isArray(evidence?.safetyEvidence) ? evidence.safetyEvidence : null;
  if (!ledger) errors.push("regression ledger is missing or malformed");
  if (!probes) errors.push("structured safety evidence is missing or malformed");
  if (!ledger || !probes) return { ok: false, errors, exactReplays: 0, generalizations: 0 };

  const ids = ledger.map((replay) => replay?.id);
  if (ids.some((id) => typeof id !== "string" || !REPLAY_ID.test(id))) errors.push("regression ledger contains an invalid replay id");
  if (new Set(ids).size !== ids.length) errors.push("regression ledger replay ids are not unique");
  const knownIds = new Set(ids);
  let exactReplays = 0;
  let generalizations = 0;

  for (const replay of ledger) {
    if (!replay || typeof replay !== "object" || typeof replay.cutId !== "string" ||
      typeof replay.command !== "string" || typeof replay.contractCitation !== "string" ||
      typeof replay.expected !== "string") {
      errors.push(`regression replay ${String(replay?.id)} is malformed`);
      continue;
    }
    const exact = probes.filter((probe) => probe?.kind === "regression-replay" && probe?.verdict === "PASS" &&
      probe?.cutId === replay.cutId && probe?.command === replay.command &&
      probe?.contractCitation === replay.contractCitation && probe?.expected === replay.expected);
    if (exact.length !== 1) errors.push(`regression replay ${replay.id} requires exactly one exact passing replay`);
    else exactReplays += 1;

    const marker = `GENERALIZATION_PASS:${replay.id}`;
    const generalized = probes.filter((probe) => probe?.kind === "regression-generalization" && probe?.verdict === "PASS" &&
      probe?.cutId === replay.cutId && probe?.command !== replay.command &&
      probe?.contractCitation === replay.contractCitation && probe?.expected === replay.expected &&
      typeof probe?.observed === "string" && probe.observed.includes(marker));
    if (generalized.length !== 1) {
      errors.push(`regression replay ${replay.id} requires exactly one distinct passing metamorphic generalization`);
    } else {
      const markers = generalized[0].observed.match(/GENERALIZATION_(?:PASS|REGRESSION):replay-[a-f0-9]{16}/g) || [];
      if (markers.length !== 1 || markers[0] !== marker) errors.push(`regression replay ${replay.id} has an ambiguous generalization marker`);
      else generalizations += 1;
    }
  }

  for (const probe of probes) {
    if (probe?.kind === "regression-generalization") {
      const markerId = typeof probe.observed === "string"
        ? /GENERALIZATION_(?:PASS|REGRESSION):(replay-[a-f0-9]{16})/.exec(probe.observed)?.[1]
        : null;
      if (!markerId || !knownIds.has(markerId)) errors.push(`orphan regression generalization ${String(probe?.id)}`);
    }
    if (probe?.kind === "regression-replay" && !ledger.some((replay) => replay?.cutId === probe?.cutId &&
      replay?.command === probe?.command && replay?.contractCitation === probe?.contractCitation && replay?.expected === probe?.expected)) {
      errors.push(`orphan exact regression replay ${String(probe?.id)}`);
    }
  }

  return { ok: errors.length === 0, errors, exactReplays, generalizations };
}

module.exports = { validateRegressionReplayEvidence };
