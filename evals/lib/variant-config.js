// Variant config loader, resolver, and Spark-settings verifier.
//
// The variant config (evals/configs/<id>.json) declares the pipeline a
// run should be measured against:
//
//   * For claude_best_single: model + effort the claude CLI is launched with.
//   * For spark_full: manager model/effort/profile + the worker pool.
//
// Spark in MANUAL mode is driven by the operator through the desktop UI;
// we don't reach in and mutate Spark's settings. Instead we VERIFY that
// the live Spark settings + manager profile match the variant config at
// kickoff. Mismatches are aborts (with --skip-config-check to override).
//
// We also extract `pipeline.routing` from a finished Spark run.json by
// walking each WorkerTask and resolving the runtime/model that actually
// ran it — that's recorded data, not config.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");

// Per-adapter default config when --config is omitted on the CLI. The
// chosen Spark default is `spark_full-grok43.json` because workers
// (Claude Code + Codex CLI) are subscription-flat, so the manager is the
// only variable Spark cost — Grok-4.3 is the cheapest credible manager
// among the four candidates we compare.
const DEFAULT_CONFIGS = {
  claude_best_single: "claude_best_single-opus47-max.json",
  spark_full: "spark_full-grok43.json",
  // noop intentionally has no default config — config is optional for it.
};

/**
 * Resolve the variant-config path for a given adapter id, applying the
 * --config override or the per-adapter default. Returns the absolute path
 * or null when no config is required (noop / unknown adapter without
 * explicit --config).
 */
function resolveConfigPath({ adapterId, override, evalsRoot }) {
  if (override) {
    if (path.isAbsolute(override)) return override;
    // Allow relative to evalsRoot or to cwd.
    const fromEvals = path.resolve(evalsRoot, override);
    if (fs.existsSync(fromEvals)) return fromEvals;
    return path.resolve(process.cwd(), override);
  }
  const def = DEFAULT_CONFIGS[adapterId];
  if (!def) return null;
  return path.resolve(evalsRoot, "configs", def);
}

function loadConfig(configPath) {
  if (!configPath) return null;
  if (!fs.existsSync(configPath)) {
    const err = new Error(`Variant config not found: ${configPath}`);
    err.code = "CONFIG_NOT_FOUND";
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new Error(`Variant config is not valid JSON (${configPath}): ${e.message}`);
  }
  if (!parsed.variantId || typeof parsed.variantId !== "string") {
    throw new Error(`Variant config missing variantId: ${configPath}`);
  }
  if (!parsed.agent || typeof parsed.agent !== "string") {
    throw new Error(`Variant config missing agent: ${configPath}`);
  }
  return { ...parsed, _sourcePath: configPath };
}

/**
 * Compute sha256 of a file's contents (used for manager profile hash).
 * Returns "sha256:<hex>" or null when the file does not exist.
 */
function sha256File(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return `sha256:${h.digest("hex")}`;
}

function sparkHomeDir() {
  const override = process.env.SPARK_HOME_DIR || process.env.SPARK_USER_DATA_DIR;
  if (override && override.trim()) return override;
  return path.join(os.homedir(), ".SparkAgent");
}

function sparkSettingsPath() {
  return path.join(sparkHomeDir(), "spark-settings.json");
}

function readSparkSettings() {
  try {
    return JSON.parse(fs.readFileSync(sparkSettingsPath(), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Verify the live Spark configuration matches the variant config. Returns
 * { ok: true } or { ok: false, mismatches: string[], hint: string }.
 *
 * We're deliberately conservative about what we *require* the operator to
 * align: at minimum, the manager model (resolved from settings or env) and
 * the manager profile hash. The pool is recorded for transparency; we only
 * warn if the configured pool runtimes don't appear available locally.
 */
function verifySparkConfig({ config, repoRoot }) {
  if (!config || config.agent !== "spark") return { ok: true };
  const mismatches = [];

  // Manager profile hash — we hash whatever is on disk at the configured
  // path, relative to the repo root the harness was launched from.
  const profileRel = config.manager && config.manager.profilePath;
  const profileAbs = profileRel
    ? path.resolve(repoRoot, profileRel)
    : null;
  const profileHash = sha256File(profileAbs);
  if (profileRel && !profileHash) {
    mismatches.push(
      `manager.profilePath does not exist on disk: ${profileAbs}`,
    );
  }

  const settings = readSparkSettings();
  const settingsPath = sparkSettingsPath();

  // Manager model — Spark stores it in spark-settings.json under
  // openRouterModel. We only enforce when both sides have an explicit
  // value; an empty live setting means the operator hasn't picked one.
  const cfgModel = config.manager && config.manager.model;
  if (cfgModel && settings) {
    const liveModel = (settings.openRouterModel || "").trim();
    if (liveModel && liveModel !== cfgModel) {
      mismatches.push(
        `manager.model mismatch: variant=${cfgModel} but spark-settings.json openRouterModel=${liveModel}`,
      );
    }
    if (!liveModel) {
      mismatches.push(
        `manager.model is unset in spark-settings.json (variant requires ${cfgModel}). Open Spark settings and pick this model.`,
      );
    }
  }

  // Settings file may be missing on a fresh install; flag that explicitly
  // because the SparkFullRunner needs it later.
  if (!settings) {
    mismatches.push(
      `spark-settings.json not found at ${settingsPath} — launch Spark once to initialize it.`,
    );
  }

  // Pool: we don't enforce that Spark's routing table exactly matches the
  // pool — that's intentionally Spark's job. We simply record the pool
  // and surface a warning hint if the operator has nothing configured.
  const poolHint = (config.pool || [])
    .map((p) => `${p.runtime}:${p.model}@${p.effort}`)
    .join(", ");

  if (mismatches.length === 0) {
    return {
      ok: true,
      profileHash,
      settingsPath,
      poolHint,
    };
  }
  return {
    ok: false,
    profileHash,
    settingsPath,
    poolHint,
    mismatches,
    hint: [
      "Variant config does not match live Spark configuration.",
      "Either align Spark settings/profile with the variant, or re-run with --skip-config-check.",
    ].join(" "),
  };
}

/**
 * Build the `pipeline.config` + `pipeline.configResolved` blob for the
 * eval-result. Suitable for both adapters; `routing` is added by the
 * adapter-specific extractor.
 */
function buildPipelineRecord({ config, repoRoot }) {
  if (!config) return null;
  const profileRel = config.manager && config.manager.profilePath;
  const profileAbs = profileRel ? path.resolve(repoRoot, profileRel) : null;
  const profileHash = sha256File(profileAbs);
  const sparkSettings = config.agent === "spark" ? readSparkSettings() : null;
  return {
    config,
    configResolved: {
      profileHash,
      sparkSettingsSnapshotPath: sparkSettings ? sparkSettingsPath() : null,
      sparkHomeDir: config.agent === "spark" ? sparkHomeDir() : null,
    },
  };
}

/**
 * Extract `pipeline.routing` from a finished Spark run.json. Walks each
 * WorkerTask + WorkerAttempt to record the runtime/model/effort that
 * actually ran. If multiple attempts exist for one task we record each
 * (the run that succeeded ends up last; replans/retries are visible).
 */
function extractRoutingFromSparkRun(runJson) {
  if (!runJson || !Array.isArray(runJson.workerTasks)) return [];
  const attempts = Array.isArray(runJson.workerAttempts) ? runJson.workerAttempts : [];
  const byTask = new Map();
  for (const a of attempts) {
    if (!a || !a.workerTaskId) continue;
    const list = byTask.get(a.workerTaskId) || [];
    list.push(a);
    byTask.set(a.workerTaskId, list);
  }
  const out = [];
  for (const task of runJson.workerTasks) {
    const list = (byTask.get(task.id) || []).slice().sort((a, b) => {
      const ta = (a.startedAt || a.createdAt || "");
      const tb = (b.startedAt || b.createdAt || "");
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    if (list.length === 0) {
      // No attempt yet — record the planned routing.
      out.push({
        subtaskId: task.id,
        title: task.title,
        runtime: task.runtimePreference,
        model: task.modelHint || null,
        effort: task.effortHint || null,
        attempt: null,
        status: task.status,
      });
      continue;
    }
    for (const a of list) {
      out.push({
        subtaskId: task.id,
        title: task.title,
        runtime: a.runtime || task.runtimePreference,
        model: a.modelHint || task.modelHint || null,
        effort: a.effortHint || task.effortHint || null,
        attempt: a.id,
        status: a.status,
      });
    }
  }
  return out;
}

/**
 * Build the single-entry routing record for a Claude baseline run, given
 * the resolved config + the adapter's actual exit reason.
 */
function buildClaudeBaselineRouting({ config, runId, exitReason }) {
  return [
    {
      subtaskId: runId,
      title: "single-shot",
      runtime: "claude_code",
      model: config.model || null,
      effort: config.effort || null,
      attempt: runId,
      status: exitReason,
    },
  ];
}

/**
 * Write a config-resolved.json artifact next to other adapter artifacts.
 * Returns the absolute path written, or null if the write failed (we don't
 * want to crash the pilot for a missing artifact dir).
 */
function writeConfigResolvedArtifact({ artifactsDir, config, configResolved, routing }) {
  if (!artifactsDir) return null;
  try {
    fs.mkdirSync(artifactsDir, { recursive: true });
    const out = path.join(artifactsDir, "config-resolved.json");
    fs.writeFileSync(
      out,
      JSON.stringify({ config, configResolved, routing }, null, 2),
      "utf8",
    );
    return out;
  } catch {
    return null;
  }
}

module.exports = {
  resolveConfigPath,
  loadConfig,
  sha256File,
  sparkHomeDir,
  sparkSettingsPath,
  readSparkSettings,
  verifySparkConfig,
  buildPipelineRecord,
  extractRoutingFromSparkRun,
  buildClaudeBaselineRouting,
  writeConfigResolvedArtifact,
};
