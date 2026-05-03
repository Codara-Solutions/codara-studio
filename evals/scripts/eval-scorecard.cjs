#!/usr/bin/env node
// Eval scorecard — reads all eval-result.json files in evals/results/ and
// prints a comparison table grouped by variantId.
//
// We surface a warning when two records share a variantId but differ in
// pipeline.configResolved.profileHash — those runs are not actually
// comparable even though they're nominally the same variant.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

function main() {
  const root = path.resolve(__dirname, "..", "results");
  if (!fs.existsSync(root)) {
    process.stderr.write(`no results dir: ${root}\n`);
    process.exit(1);
  }
  const files = fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".json") && f !== "example-result.json");
  if (files.length === 0) {
    process.stdout.write("No eval-result.json files yet. Run `node evals/run-pilot.cjs` first.\n");
    return;
  }

  const records = [];
  for (const file of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
      records.push({ file, r });
    } catch (err) {
      process.stderr.write(`skipping ${file}: ${err.message}\n`);
    }
  }

  // Group by variantId (or fall back to adapter id when no config was used).
  const groups = new Map();
  for (const { file, r } of records) {
    const variantId =
      (r.pipeline && r.pipeline.config && r.pipeline.config.variantId) ||
      `${(r.adapter && r.adapter.id) || "unknown"}:no-config`;
    if (!groups.has(variantId)) groups.set(variantId, []);
    groups.get(variantId).push({ file, r });
  }

  const cols = ["variant", "task", "passed", "score", "hidden", "public", "duration", "profileHash", "runId"];
  const widths = [28, 36, 8, 8, 8, 8, 10, 16, 24];

  function row(values) {
    return values
      .map((v, i) => String(v).padEnd(widths[i]).slice(0, widths[i]))
      .join("  ");
  }

  process.stdout.write(row(cols) + "\n");
  process.stdout.write(cols.map((_, i) => "".padEnd(widths[i], "-")).join("  ") + "\n");

  for (const [variantId, members] of [...groups.entries()].sort()) {
    // Detect profileHash divergence within the same variantId.
    const hashes = new Set(
      members
        .map(
          (m) =>
            m.r.pipeline &&
            m.r.pipeline.configResolved &&
            m.r.pipeline.configResolved.profileHash,
        )
        .filter(Boolean),
    );
    const hashWarning = hashes.size > 1;

    for (const { r } of members) {
      const score =
        r.headline && typeof r.headline.score === "number"
          ? r.headline.score.toFixed(2)
          : "n/a";
      const hidden =
        r.gates && r.gates.hidden
          ? `${r.gates.hidden.passed}/${r.gates.hidden.total}`
          : "n/a";
      const pubGreen = r.headline && r.headline.publicGatesGreen ? "yes" : "no";
      const duration =
        r.run && typeof r.run.durationSeconds === "number"
          ? r.run.durationSeconds.toFixed(1)
          : "n/a";
      const profileHash =
        (r.pipeline &&
          r.pipeline.configResolved &&
          r.pipeline.configResolved.profileHash) ||
        "(none)";
      const profileShort = profileHash.startsWith("sha256:")
        ? profileHash.slice(7, 7 + 12)
        : profileHash;
      const runId = (r.run && r.run.id) || "?";
      process.stdout.write(
        row([
          variantId,
          r.task && r.task.id,
          r.headline && r.headline.passed,
          score,
          hidden,
          pubGreen,
          duration,
          profileShort,
          runId,
        ]) + "\n",
      );
    }

    if (hashWarning) {
      const list = [...hashes].map((h) => h.slice(7, 7 + 12)).join(", ");
      process.stdout.write(
        `  ! WARNING: variant ${variantId} has runs with divergent profileHash (${list}); these runs are not directly comparable.\n`,
      );
    }
  }
}

main();
