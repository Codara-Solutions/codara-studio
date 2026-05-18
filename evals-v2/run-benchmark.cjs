#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { buildResult, validateResult, VARIANTS } = require("./lib/schema.cjs");

const ROOT = __dirname;
const TASKS_DIR = path.join(ROOT, "tasks");
const RESULTS_DIR = path.join(ROOT, "results");

function parseArgs(argv) {
  const out = { repetitions: 3, adapter: null, variants: VARIANTS, tasks: null, resultsDir: RESULTS_DIR };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repetitions") out.repetitions = Number(argv[++i] || 3);
    else if (arg === "--adapter") out.adapter = argv[++i] || null;
    else if (arg === "--variants") out.variants = (argv[++i] || "").split(",").filter(Boolean);
    else if (arg === "--tasks") out.tasks = (argv[++i] || "").split(",").filter(Boolean);
    else if (arg === "--results-dir") out.resultsDir = path.resolve(argv[++i] || RESULTS_DIR);
    else if (!arg.startsWith("-")) out.resultsDir = path.resolve(arg);
  }
  return out;
}

function loadTasks() {
  return fs
    .readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const taskDir = path.join(TASKS_DIR, entry.name);
      const task = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
      const prompt = fs.readFileSync(path.join(taskDir, "prompt.md"), "utf8");
      return { ...task, id: task.id || entry.name, dir: taskDir, prompt };
    });
}

function loadAdapter(variantId, forcedAdapter) {
  const adapterId = forcedAdapter || variantId;
  return require(path.join(ROOT, "adapters", `${adapterId}.cjs`));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.resultsDir, { recursive: true });
  const allTasks = loadTasks();
  const tasks = args.tasks
    ? allTasks.filter((task) => args.tasks.includes(task.id))
    : allTasks;
  if (args.tasks && tasks.length !== args.tasks.length) {
    const found = new Set(tasks.map((task) => task.id));
    const missing = args.tasks.filter((id) => !found.has(id));
    throw new Error(`unknown task id(s): ${missing.join(", ")}`);
  }
  const written = [];
  for (const task of tasks) {
    for (const variantId of args.variants) {
      const adapter = loadAdapter(variantId, args.adapter);
      for (let repetition = 1; repetition <= args.repetitions; repetition++) {
        const startedAt = new Date().toISOString();
        const runId = `${variantId}-${task.id}-${Date.now().toString(36)}-${repetition}`;
        const adapterResult = await adapter.run({ task, variantId, runId, repetition, root: ROOT });
        const finishedAt = new Date().toISOString();
        const result = buildResult({
          taskId: task.id,
          taskCategory: task.category,
          prompt: task.prompt,
          variantId,
          runId,
          repetition,
          startedAt,
          finishedAt,
          ...adapterResult,
        });
        const validation = validateResult(result);
        if (!validation.ok) throw new Error(`invalid result ${runId}: ${validation.errors.join("; ")}`);
        const outPath = path.join(args.resultsDir, `${variantId}-${task.id}-${runId}.json`);
        fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n", "utf8");
        written.push(outPath);
      }
    }
  }
  console.log(JSON.stringify({ written }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
