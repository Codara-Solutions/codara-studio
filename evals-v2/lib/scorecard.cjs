#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function readResults(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .filter((name) => !["scorecard.json", "judge.json"].includes(name))
    .map((name) => path.join(dir, name))
    .map((file) => {
      const text = fs.readFileSync(file, "utf8").trim();
      if (!text) return null;
      try {
        const parsed = JSON.parse(text);
        return parsed?.schemaVersion && parsed?.task?.id && parsed?.variant?.id && parsed?.run?.id
          ? parsed
          : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  const numeric = values.filter((v) => Number.isFinite(v));
  if (numeric.length === 0) return 0;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function buildScorecard(results) {
  const byVariant = new Map();
  for (const result of results) {
    const id = result.variant.id;
    const list = byVariant.get(id) || [];
    list.push(result);
    byVariant.set(id, list);
  }
  return [...byVariant.entries()].map(([variantId, list]) => ({
    variantId,
    runs: list.length,
    medianDurationSeconds: round(median(list.map((r) => r.run.durationSeconds))),
    passRate: round(mean(list.map((r) => (r.quality.passed ? 1 : 0)))),
    hiddenGateRatio: round(mean(list.map((r) => r.quality.hiddenGateRatio))),
    qualityScore: round(mean(list.map((r) => r.quality.score))),
    parallelEfficiency: round(mean(list.map((r) => r.telemetry.parallelEfficiency))),
    medianMaxConcurrentWorkers: round(median(list.map((r) => r.telemetry.maxConcurrentWorkers))),
    meanParallelLaunchGroups: round(mean(list.map((r) => r.telemetry.parallelLaunchGroups))),
    meanPeerMessages: round(mean(list.map((r) => r.telemetry.peerMessageCount))),
    meanPeerAgents: round(mean(list.map((r) => r.telemetry.peerAgentCount))),
    medianTimeToFirstWorker: round(
      median(list.map((r) => r.telemetry.timeToFirstWorkerSeconds).filter((v) => v !== null)),
    ),
  }));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

if (require.main === module) {
  const dir = process.argv[2] || path.join(__dirname, "..", "results");
  const card = buildScorecard(readResults(dir));
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), scorecard: card }, null, 2));
}

module.exports = { buildScorecard, readResults };
