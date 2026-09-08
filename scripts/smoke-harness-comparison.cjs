#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { bench } = require("../cli/commands/bench.cjs");
const { rpcRaw } = require("../cli/lib/rpc.cjs");

async function main() {
  const home = process.env.CODARA_COMPARISON_HOME;
  const output = process.env.CODARA_COMPARISON_OUTPUT;
  if (!home || !output) throw new Error("Set CODARA_COMPARISON_HOME and CODARA_COMPARISON_OUTPUT to dedicated lab paths");
  const flags = { home: path.resolve(home) };
  const info = await rpcRaw(flags, "app.info", {});
  if (info.error || path.resolve(info.result.homeDir) !== flags.home) throw new Error("The live app is not the requested comparison lab");
  const root = path.resolve(output);
  fs.mkdirSync(root);
  const manifest = {
    status: "running",
    startedAt: new Date().toISOString(),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    model: "gpt-5.6-sol",
    effort: "high",
    tasks: "patch-atomic,async-pool,holdout-lru",
    order: [["cora", "codex", "hermes"], ["codex", "hermes", "cora"], ["hermes", "cora", "codex"]],
    conditions: "Sequential crossover schedule on one machine. Each agent occupies each position once. Run no other lab provider calls, builds, or Electron tests during this schedule. User activity, provider load, and cache warmth are not controlled.",
    entries: [],
  };
  const persist = () => {
    const file = path.join(root, "comparison.json");
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(`${file}.tmp`, file);
  };
  persist();
  try {
    for (const [round, agents] of manifest.order.entries()) {
      for (const agent of agents) {
        const file = `${round + 1}-${agent}.json`;
        console.log(`\nComparison round ${round + 1}/3: ${agent}`);
        await bench([], { ...flags, agent, model: manifest.model, effort: manifest.effort, task: manifest.tasks,
          repeat: 1, keep: true, output: path.join(root, file) });
        const entry = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
        manifest.entries.push({ round: round + 1, agent, file, acceptance: entry.acceptance });
        persist();
      }
    }
    manifest.status = "complete";
  } catch (error) {
    manifest.status = "error";
    manifest.error = error.message;
    throw error;
  } finally {
    manifest.finishedAt = new Date().toISOString();
    persist();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
