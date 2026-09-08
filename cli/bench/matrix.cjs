"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { rpc } = require("../lib/rpc.cjs");

function selectModels(catalog, requested, effort) {
  const names = requested === "all" ? catalog.map((model) => model.id) : String(requested ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  if (!names.length) throw new Error("Use --models all or a comma-separated list of live model IDs");
  return [...new Set(names)].map((name) => {
    const model = catalog.find((candidate) => candidate.id === name);
    if (!model) throw new Error(`Model is absent from the live Studio catalog: ${name}`);
    if (effort && model.thinkingLevels?.length && !model.thinkingLevels.includes(effort)) {
      throw new Error(`${name} does not support effort ${effort}`);
    }
    return model;
  });
}

async function matrix(flags) {
  if (flags.agent && flags.agent !== "cora") throw new Error("The live catalog matrix currently supports --agent cora");
  if (!flags.output) throw new Error("Use --output DIR for the matrix artifacts");
  const catalog = await rpc(flags, "models.list", {});
  const models = selectModels(catalog.models, flags.models, flags.effort ?? "high");
  const root = path.resolve(flags.output);
  // Each model's full artifact is durable before the next subscription call.
  // A fresh directory prevents accidental replacement of a paid baseline.
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.mkdirSync(root);
  const manifest = {
    startedAt: new Date().toISOString(),
    status: "running",
    models,
    task: flags.task ?? null,
    split: flags.split ?? "train",
    repeat: flags.repeat ?? 1,
    effort: flags.effort ?? "high",
    entries: [],
  };
  const persist = () => {
    const file = path.join(root, "matrix.json");
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(`${file}.tmp`, file);
  };
  persist();
  try {
    const { bench } = require("../commands/bench.cjs");
    for (const [index, model] of models.entries()) {
      const output = path.join(root, `${String(index + 1).padStart(2, "0")}.json`);
      console.log(`\nModel ${index + 1}/${models.length}: ${model.id} (${model.provider})`);
      await bench([], { ...flags, model: model.id, output, json: false });
      const entry = JSON.parse(fs.readFileSync(output, "utf8"));
      manifest.entries.push({ model: model.id, file: path.basename(output), acceptance: entry.acceptance });
      persist();
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

module.exports = { matrix, selectModels };
