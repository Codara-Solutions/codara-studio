#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const HELP = `Usage: node evals-v3/run-slice.cjs [options]

Options:
  --slice <path>             Slice JSON path (default: slices/swebench-verified-10.json)
  --budget <seconds>         Per-instance wall-clock budget (default: 1800)
  --max-concurrent <n>       Concurrent instances (default: 1)
  --results-dir <path>       Output dir (default: evals-v3/results/swebench-<runId>)
  --skip-scoring             Run Spark only; skip score.py
  --only <instance_id>       Run a single instance
  --help                     Show this help and exit
`;

function parseArgv(argv) {
  const opts = { slice: null, budget: 1800, maxConcurrent: 1, resultsDir: null, skipScoring: false, only: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--slice") opts.slice = argv[++i];
    else if (a === "--budget") opts.budget = Number(argv[++i]);
    else if (a === "--max-concurrent") opts.maxConcurrent = Number(argv[++i]);
    else if (a === "--results-dir") opts.resultsDir = argv[++i];
    else if (a === "--skip-scoring") opts.skipScoring = true;
    else if (a === "--only") opts.only = argv[++i];
    else throw new Error(`Unknown arg: ${a}`);
  }
  return opts;
}

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

function loadJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

function writeJson(p, obj) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function fmtRow(cells) { return "| " + cells.join(" | ") + " |"; }

async function runSerial(instances, fn) {
  const out = [];
  for (let i = 0; i < instances.length; i++) {
    out.push(await fn(instances[i], i));
  }
  return out;
}

async function runConcurrent(instances, n, fn) {
  const out = new Array(instances.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(n, instances.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= instances.length) return;
      out[i] = await fn(instances[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function spawnScorer(scriptPath, predictionsPath, runId) {
  return new Promise((resolve) => {
    const py = process.platform === "win32" ? "python" : "python3";
    const child = spawn(py, [scriptPath, "--predictions", predictionsPath, "--run-id", runId], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("exit", (code) => resolve(code ?? -1));
    child.on("error", () => resolve(-1));
  });
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); process.exit(0); }

  const scriptDir = __dirname;
  const repoRoot = path.resolve(scriptDir, "..");
  const reposCacheDir = path.join(repoRoot, "evals-v3", ".repos-cache");
  mkdirp(reposCacheDir);

  const slicePath = path.resolve(scriptDir, opts.slice || path.join("slices", "swebench-verified-10.json"));
  const slice = loadJson(slicePath);
  const sliceName = slice.name || path.basename(slicePath, ".json");

  const runId = "swebench-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + crypto.randomBytes(3).toString("hex");
  const resultsDir = opts.resultsDir
    ? path.resolve(opts.resultsDir)
    : path.join(scriptDir, "results", `swebench-${runId}`);
  mkdirp(resultsDir);

  let entries = slice.instances || [];
  if (opts.only) entries = entries.filter((e) => e.instance_id === opts.only);
  if (entries.length === 0) {
    console.error(`No instances to run (only=${opts.only}).`);
    process.exit(2);
  }

  const instancesDir = path.join(scriptDir, "datasets", "swe-bench-verified", "instances");
  const instances = entries.map((e) => {
    const p = path.join(instancesDir, `${e.instance_id}.json`);
    return { meta: e, full: loadJson(p) };
  });

  const adapterPath = path.join(scriptDir, "adapters", "spark_swebench.cjs");
  const { runSparkOnInstance } = require(adapterPath);

  const startedAt = new Date().toISOString();
  console.log(`Run ID: ${runId}`);
  console.log(`Slice: ${sliceName} (${instances.length} instances)`);
  console.log(`Results: ${resultsDir}`);
  console.log(`Budget: ${opts.budget}s per instance, concurrency=${opts.maxConcurrent}`);
  console.log("");

  const N = instances.length;
  const summaryInstances = [];
  let activeChild = null;
  let interrupted = false;
  let scoreTotals = null;

  const writePartialSummary = (finishedAt) => {
    const totals = { resolved: 0, unresolved: 0, errored: 0, adapter_errors: 0, total: summaryInstances.length };
    for (const s of summaryInstances) {
      if (s.scoreStatus === "resolved") totals.resolved++;
      else if (s.scoreStatus === "unresolved") totals.unresolved++;
      else if (s.scoreStatus === "errored") totals.errored++;
      else if (s.exitReason === "adapter_error") totals.adapter_errors++;
      else if (s.exitReason && s.exitReason !== "ok") totals.errored++;
    }
    // If the scorer ran and produced top-level counts, prefer them for the headline totals
    // (per-instance scoreStatus is still authoritative for the per-row "score" column).
    if (scoreTotals) {
      totals.resolved = scoreTotals.resolved;
      totals.unresolved = scoreTotals.unresolved;
      totals.errored = scoreTotals.errored;
    }
    writeJson(path.join(resultsDir, "summary.json"), {
      runId, slice: sliceName, startedAt, finishedAt,
      budgetSeconds: opts.budget, instances: summaryInstances, totals, interrupted,
    });
    return totals;
  };

  process.on("SIGINT", () => {
    interrupted = true;
    console.error("\n[SIGINT] interrupting...");
    if (activeChild) { try { activeChild.kill("SIGINT"); } catch (_) {} }
    writePartialSummary(new Date().toISOString());
    process.exit(130);
  });

  const runOne = async (item, i) => {
    const { meta, full } = item;
    const id = meta.instance_id;
    const workRoot = path.join(resultsDir, id);
    mkdirp(workRoot);
    const t0 = Date.now();
    let res;
    try {
      res = await runSparkOnInstance({
        instance: full,
        workRoot,
        budgetSeconds: opts.budget,
        repoRoot,
        reposCacheDir,
        env: process.env,
      });
    } catch (err) {
      res = {
        instance_id: id,
        patch: "",
        exitReason: "adapter_error",
        error: (err && err.message) || String(err),
        durationSeconds: (Date.now() - t0) / 1000,
      };
    }
    if (!res || typeof res !== "object") {
      res = { instance_id: id, patch: "", exitReason: "adapter_error", error: "adapter returned no result", durationSeconds: (Date.now() - t0) / 1000 };
    }
    if (!res.instance_id) res.instance_id = id;
    if (typeof res.patch !== "string") res.patch = res.patch ? String(res.patch) : "";
    writeJson(path.join(workRoot, "result.json"), res);

    const patchBytes = Buffer.byteLength(res.patch || "", "utf8");
    const dur = (res.durationSeconds ?? (Date.now() - t0) / 1000).toFixed(1);
    console.log(`[${i + 1}/${N}] ${id} — ${dur}s — patch=${patchBytes}B — ${res.exitReason || "unknown"}`);

    summaryInstances.push({
      instance_id: id,
      repo: meta.repo || full.repo,
      durationSeconds: Number(dur),
      patchSizeBytes: patchBytes,
      exitReason: res.exitReason || "unknown",
      scoreStatus: null,
    });
    return res;
  };

  const results = opts.maxConcurrent > 1
    ? await runConcurrent(instances, opts.maxConcurrent, runOne)
    : await runSerial(instances, runOne);

  const predictionsPath = path.join(resultsDir, "predictions.jsonl");
  const lines = results.map((r) => JSON.stringify({
    instance_id: r.instance_id,
    model_name_or_path: "spark-agent",
    model_patch: r.patch || "",
  }));
  fs.writeFileSync(predictionsPath, lines.join("\n") + "\n");
  console.log(`\nPredictions: ${predictionsPath}`);

  if (!opts.skipScoring) {
    const scorer = path.join(scriptDir, "score.py");
    if (fs.existsSync(scorer)) {
      console.log(`\nRunning scorer: ${scorer}`);
      const code = await spawnScorer(scorer, predictionsPath, runId);
      console.log(`Scorer exited with code ${code}`);
      // score.py writes to <repoRoot>/evals-v3/results/<runId>/score.json by default,
      // which is NOT the same as the orchestrator's resultsDir (evals-v3/results/swebench-<runId>).
      const reportPath = path.join(repoRoot, "evals-v3", "results", runId, "score.json");
      if (fs.existsSync(reportPath)) {
        try {
          const rep = loadJson(reportPath);
          const perInstance = (rep && rep.per_instance) || {};
          for (const s of summaryInstances) {
            const info = perInstance[s.instance_id];
            if (info && typeof info.status === "string") {
              s.scoreStatus = info.status; // "resolved" | "unresolved" | "errored"
            }
          }
          // Stash top-level counts so the final Totals reflect the scorer's view.
          scoreTotals = {
            resolved: Number(rep.resolved) || 0,
            unresolved: Number(rep.unresolved) || 0,
            errored: Number(rep.errored) || 0,
          };
          console.log(`Score report: ${reportPath}`);
        } catch (err) {
          console.warn(`Failed to parse score report at ${reportPath}: ${err && err.message || err}`);
        }
      } else {
        console.warn(`Score report not found at ${reportPath}; leaving scoreStatus null.`);
      }
    } else {
      console.warn(`Scorer not found at ${scorer}; skipping.`);
    }
  }

  const finishedAt = new Date().toISOString();
  const totals = writePartialSummary(finishedAt);

  console.log("\n## Results\n");
  console.log(fmtRow(["instance_id", "repo", "duration(s)", "patch(B)", "exitReason", "score"]));
  console.log(fmtRow(["---", "---", "---:", "---:", "---", "---"]));
  for (const s of summaryInstances) {
    console.log(fmtRow([s.instance_id, s.repo || "", String(s.durationSeconds), String(s.patchSizeBytes), s.exitReason, s.scoreStatus || ""]));
  }
  console.log(`\nTotals: resolved=${totals.resolved} unresolved=${totals.unresolved} errored=${totals.errored} adapter_errors=${totals.adapter_errors} total=${totals.total}`);
  console.log(`Summary: ${path.join(resultsDir, "summary.json")}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("FATAL:", err && err.stack || err);
    process.exit(1);
  });
}

module.exports = { parseArgv };
