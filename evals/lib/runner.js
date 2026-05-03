// Runner adapter contract.
//
// Every agent / CLI / SDK that the eval harness scores implements this
// interface. The harness only ever talks to adapters — it has no idea whether
// the agent under test is Claude Code, Codex CLI, raw OpenRouter, Aider,
// Cline, or Spark itself.
//
// To add a new agent: drop a file under `evals/adapters/` that exports a
// function `createRunner(opts)` returning an object satisfying the shape
// below. Then list its name in the suite manifest. No harness change required.
//
//
// Runner contract
// ----------------
//
//   runner.id          : string  // stable, machine-friendly key, e.g. "claude_best_single"
//   runner.label       : string  // human label for transcripts/reports
//   runner.run({ seedRepoPath, planFile, env, budgetSeconds, taskId, runId })
//                      : Promise<RunnerResult>
//
// RunnerResult fields:
//
//   finalRepoPath      : string                       // absolute path of the working tree after the run
//   transcript         : Array<TranscriptEvent>       // structured log of agent activity (see below)
//   artifacts          : Array<{ name, path, kind }>  // any extra files (run.json, events.jsonl, screenshots, ...)
//   attemptCount       : number                       // 1 for single-shot CLI; n for multi-attempt orchestrators
//   humanInterventions : number                       // number of times a human had to intervene (0 for headless)
//   durationSeconds    : number                       // wall-clock seconds the agent ran
//   exitReason         : string                       // 'completed' | 'budget_exhausted' | 'crashed' | 'aborted' | ...
//   errorMessage?      : string                       // populated when exitReason !== 'completed'
//
// TranscriptEvent shape (kept minimal so any adapter can produce it):
//
//   { ts: ISO8601 string, kind: string, message?: string, data?: object }
//
// Adapters MUST:
//   * Treat seedRepoPath as a working tree they can mutate. They must NOT
//     touch any other path on the host filesystem unless explicitly opted in
//     via env. The harness clones the seed repo to a fresh temp dir before
//     each call and deletes it after recording the diff, so adapters do not
//     need to clean up.
//   * Never block the main process — every call returns a Promise.
//   * Surface launch failures (binary missing, login required, etc.) by
//     rejecting the promise with a clear, actionable Error. The harness will
//     surface that to the user verbatim. Do NOT swallow errors and return a
//     bogus success.
//
// Adapters SHOULD:
//   * Pass through env entries that look meaningful to the underlying CLI
//     (HOME, PATH, ANTHROPIC_API_KEY, etc.).
//   * Capture stdout/stderr into the transcript so the judge has context if
//     a diff alone is ambiguous.
//   * Write any natively-produced artifacts (Spark's run.json + events.jsonl,
//     Codex's session log, etc.) into the artifacts array so reviewers can
//     replay the run.
//
// This module is plain CJS so it can be required from any Node script
// (electron-vite is irrelevant to standalone tooling).

"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * @typedef {Object} TranscriptEvent
 * @property {string} ts          ISO8601 timestamp
 * @property {string} kind        Short tag, e.g. "stdout", "stderr", "spawn", "shutdown"
 * @property {string} [message]   Free-form line/notice
 * @property {Object} [data]      Optional structured payload
 */

/**
 * @typedef {Object} RunnerArtifact
 * @property {string} name        Display name, e.g. "run.json"
 * @property {string} path        Absolute path on disk
 * @property {string} kind        Free-form bucket, e.g. "spark-state", "agent-log", "screenshot"
 */

/**
 * @typedef {Object} RunnerResult
 * @property {string} finalRepoPath
 * @property {TranscriptEvent[]} transcript
 * @property {RunnerArtifact[]} artifacts
 * @property {number} attemptCount
 * @property {number} humanInterventions
 * @property {number} durationSeconds
 * @property {"completed"|"budget_exhausted"|"crashed"|"aborted"|"launch_failed"} exitReason
 * @property {string} [errorMessage]
 */

/**
 * @typedef {Object} VariantConfig
 * Loaded from evals/configs/<id>.json. Pinning the pipeline a run is
 * measured against — model/effort for a single agent, manager+pool for
 * Spark. See evals/lib/variant-config.js for shape + helpers.
 *
 * @property {string} variantId
 * @property {string} agent          "claude_code" | "spark" | ...
 * @property {Object} [manager]      Spark only: { model, effort, profilePath }
 * @property {Array}  [pool]         Spark only: allowed runtimes/models
 * @property {Object} [perRoleOverrides]
 * @property {string} [model]        Single-agent variants
 * @property {string} [effort]       Single-agent variants
 * @property {string} [_sourcePath]  Internal — resolved absolute path of the file
 */

/**
 * @typedef {Object} RunnerInput
 * @property {string} seedRepoPath   Absolute path to the working tree (already reset to seed commit)
 * @property {string} planFile       Absolute path to the user-facing plan markdown (the prompt)
 * @property {Object} env            Environment variables for the child process
 * @property {number} budgetSeconds  Hard wall-clock budget; adapter must abort by this point
 * @property {string} taskId         Stable id of the task under test
 * @property {string} runId          Unique id for this individual run
 * @property {VariantConfig|null} [config]   Resolved variant config (the pipeline pin).
 *                                            May be null for adapters that don't need one
 *                                            (noop self-test). Adapters that DO need pinning
 *                                            (claude_best_single, spark_full) MUST honor this
 *                                            and reflect it in their behaviour + artifacts.
 */

/**
 * @typedef {Object} Runner
 * @property {string} id
 * @property {string} label
 * @property {(input: RunnerInput) => Promise<RunnerResult>} run
 */

/**
 * Helper: emit a transcript event with a current timestamp.
 * Adapters should use this rather than rolling their own.
 */
function event(kind, message, data) {
  const ev = {
    ts: new Date().toISOString(),
    kind,
  };
  if (message !== undefined) ev.message = message;
  if (data !== undefined) ev.data = data;
  return ev;
}

/**
 * Helper: capture the diff between HEAD and the working tree at finalRepoPath
 * after the agent finishes. Returned as a single unified-diff string.
 */
function captureDiff(repoPath) {
  // We snapshot the working tree (staged + unstaged + untracked) by adding
  // everything to the index without committing, then asking git for a diff
  // against the seed HEAD. Untracked binaries are skipped to avoid polluting
  // the diff with binary blobs.
  const addRes = spawnSync("git", ["add", "-A"], {
    cwd: repoPath,
    encoding: "utf8",
    windowsHide: true,
  });
  if (addRes.status !== 0) {
    throw new Error(`git add -A failed in ${repoPath}: ${addRes.stderr || addRes.stdout}`);
  }
  const diffRes = spawnSync(
    "git",
    ["diff", "--cached", "--no-color", "--no-ext-diff", "HEAD"],
    {
      cwd: repoPath,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (diffRes.status !== 0) {
    throw new Error(
      `git diff failed in ${repoPath}: ${diffRes.stderr || diffRes.stdout}`,
    );
  }
  return diffRes.stdout || "";
}

/**
 * Helper: list files modified vs HEAD (for the result recorder).
 */
function listChangedFiles(repoPath) {
  const res = spawnSync(
    "git",
    ["diff", "--cached", "--name-status", "HEAD"],
    { cwd: repoPath, encoding: "utf8", windowsHide: true },
  );
  if (res.status !== 0) return [];
  return res.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split(/\s+/);
      return { status, path: rest.join(" ") };
    });
}

/**
 * Helper: validate a RunnerResult object. Throws if required fields are
 * missing or the wrong type. Useful for adapters during development.
 */
function validateResult(result) {
  if (!result || typeof result !== "object") {
    throw new Error("Runner returned non-object result.");
  }
  const requiredString = ["finalRepoPath", "exitReason"];
  const requiredArray = ["transcript", "artifacts"];
  const requiredNumber = ["attemptCount", "humanInterventions", "durationSeconds"];
  for (const key of requiredString) {
    if (typeof result[key] !== "string" || !result[key]) {
      throw new Error(`RunnerResult.${key} must be a non-empty string.`);
    }
  }
  for (const key of requiredArray) {
    if (!Array.isArray(result[key])) {
      throw new Error(`RunnerResult.${key} must be an array.`);
    }
  }
  for (const key of requiredNumber) {
    if (typeof result[key] !== "number" || !Number.isFinite(result[key])) {
      throw new Error(`RunnerResult.${key} must be a finite number.`);
    }
  }
  if (!fs.existsSync(result.finalRepoPath)) {
    throw new Error(
      `RunnerResult.finalRepoPath does not exist on disk: ${result.finalRepoPath}`,
    );
  }
}

/**
 * Helper: load an adapter from `evals/adapters/<id>.js`. The id maps to a
 * filename so the suite manifest can list adapters by string.
 */
function loadAdapter(adapterId) {
  if (typeof adapterId !== "string" || !/^[a-z0-9_]+$/i.test(adapterId)) {
    throw new Error(`Invalid adapter id: ${adapterId}`);
  }
  const adapterPath = path.resolve(__dirname, "..", "adapters", `${adapterId}.js`);
  if (!fs.existsSync(adapterPath)) {
    throw new Error(`Adapter not found: ${adapterPath}`);
  }
  const mod = require(adapterPath);
  if (typeof mod.createRunner !== "function") {
    throw new Error(
      `Adapter at ${adapterPath} does not export createRunner({ ... }).`,
    );
  }
  return mod.createRunner;
}

module.exports = {
  event,
  captureDiff,
  listChangedFiles,
  validateResult,
  loadAdapter,
};
