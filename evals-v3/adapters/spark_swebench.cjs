"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

function sparkHomeDir() {
  const override = process.env.SPARK_HOME_DIR || process.env.SPARK_USER_DATA_DIR;
  if (override && override.trim()) return override;
  return path.join(os.homedir(), ".SparkAgent");
}

function resolveLaunchCommand({ repoRoot, planFile, outputDir, budgetSeconds }) {
  const electronPkg = require.resolve("electron", { paths: [repoRoot] });
  const electronBin = require(electronPkg);
  if (typeof electronBin !== "string" || !fs.existsSync(electronBin)) {
    throw new Error(`electron did not resolve to a real binary (got ${electronBin}). Run 'npm install' from ${repoRoot}.`);
  }
  const mainBundle = path.join(repoRoot, "out", "main", "index.js");
  if (!fs.existsSync(mainBundle)) {
    throw new Error(`main bundle not found at ${mainBundle} — run 'npm run build' from ${repoRoot}.`);
  }
  return {
    command: electronBin,
    args: [mainBundle, "--eval-plan", planFile, "--eval-budget", String(budgetSeconds), "--eval-output-dir", outputDir],
  };
}

function parseJsonLine(line) {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function git(cwd, args, opts = {}) {
  const fullArgs = ["-c", "core.longpaths=true", ...args];
  const r = spawnSync("git", fullArgs, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 * 256, ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} failed (${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  }
  return r;
}

function materializeRepo({ instance, workRoot, reposCacheDir }) {
  const slug = instance.repo.replace("/", "__");
  const cacheDir = path.join(reposCacheDir, slug);
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(reposCacheDir, { recursive: true });
    const res = spawnSync("git", ["-c", "core.longpaths=true", "clone", `https://github.com/${instance.repo}.git`, cacheDir], {
      stdio: "inherit", windowsHide: true,
    });
    if (res.status !== 0) throw new Error(`failed to clone ${instance.repo} into ${cacheDir}`);
  }
  const repoDir = path.join(workRoot, "repo");
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  fs.cpSync(cacheDir, repoDir, { recursive: true });
  git(repoDir, ["fetch", "--all", "--quiet"], { allowFail: true });
  git(repoDir, ["checkout", "--force", instance.base_commit]);
  git(repoDir, ["clean", "-fdx"]);
  git(repoDir, ["checkout", "-B", "spark-eval-base"]);
  const baseSha = git(repoDir, ["rev-parse", "HEAD"]).stdout.trim();
  return { repoDir, baseSha };
}

function writePrompt({ workRoot, instance }) {
  const promptPath = path.join(workRoot, "prompt.md");
  fs.writeFileSync(promptPath, `# SWE-bench instance: ${instance.instance_id}

## Repository
${instance.repo} @ ${instance.base_commit}

## Problem statement
${instance.problem_statement}

## Your task
Make the minimum code changes needed to satisfy the failing tests described above. Do NOT add or modify test files. Modify only source files in this repository. When done, the diff between your changes and the base commit must:
- Cause the FAIL_TO_PASS tests to pass
- Keep all PASS_TO_PASS tests passing

The grader will run the tests itself — focus on the implementation only.
`, "utf8");
  return promptPath;
}

async function runSparkOnInstance(input) {
  const { instance, workRoot, budgetSeconds, repoRoot, reposCacheDir, env: extraEnv } = input;
  const startedAtMs = Date.now();
  fs.mkdirSync(workRoot, { recursive: true });

  const { repoDir, baseSha } = materializeRepo({ instance, workRoot, reposCacheDir });

  const promptPath = writePrompt({ workRoot, instance });
  const planInRepo = path.join(repoDir, "spark-eval-plan.md");
  fs.copyFileSync(promptPath, planInRepo);

  const artifactsDir = path.join(workRoot, "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  const sparkRunMirror = path.join(artifactsDir, "spark-run");

  const isolatedHome = path.join(artifactsDir, ".SparkAgent");
  fs.mkdirSync(isolatedHome, { recursive: true });
  const userSettings = path.join(sparkHomeDir(), "spark-settings.json");
  if (fs.existsSync(userSettings)) {
    fs.copyFileSync(userSettings, path.join(isolatedHome, "spark-settings.json"));
  }

  const launch = resolveLaunchCommand({ repoRoot, planFile: planInRepo, outputDir: sparkRunMirror, budgetSeconds });
  const managerProfilePath = path.join(repoRoot, "resources", "orchestration", "manager-profile.json");
  const env = {
    ...process.env,
    ...(extraEnv || {}),
    SPARK_HOME_DIR: isolatedHome,
    SPARK_MANAGER_PROFILE_PATH: fs.existsSync(managerProfilePath) ? managerProfilePath : (process.env.SPARK_MANAGER_PROFILE_PATH || ""),
  };

  const stderrLogPath = path.join(artifactsDir, "spark-stderr.jsonl");
  const stderrStream = fs.createWriteStream(stderrLogPath, { flags: "w" });
  const summaryPath = path.join(artifactsDir, "spark-summary.json");

  const child = spawn(launch.command, launch.args, {
    cwd: repoDir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });

  let summary = null;
  let stderrLines = 0;
  let stdoutRemainder = "";
  let stderrRemainder = "";

  child.stdout.on("data", (chunk) => {
    stdoutRemainder += chunk.toString("utf8");
    const lines = stdoutRemainder.split(/\r?\n/);
    stdoutRemainder = lines.pop() || "";
    for (const line of lines) {
      const p = parseJsonLine(line);
      if (p && p.runId && p.status) summary = p;
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrRemainder += chunk.toString("utf8");
    const lines = stderrRemainder.split(/\r?\n/);
    stderrRemainder = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      stderrStream.write(line + "\n");
      stderrLines += 1;
    }
  });

  const budgetMs = Math.max(60_000, budgetSeconds * 1000);
  const exitInfo = await new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(budgetTimer); resolve(v); };
    const budgetTimer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } }, 10_000);
      finish({ code: null, signal: "SIGTERM", budgetExhausted: true });
    }, budgetMs + 30_000);
    child.on("error", (err) => finish({ code: null, signal: null, error: err.message }));
    child.on("exit", (code, signal) => {
      if (stderrRemainder.trim()) { stderrStream.write(stderrRemainder + "\n"); stderrLines += 1; stderrRemainder = ""; }
      if (stdoutRemainder.trim()) {
        const p = parseJsonLine(stdoutRemainder);
        if (p && p.runId && p.status) summary = p;
        stdoutRemainder = "";
      }
      finish({ code, signal });
    });
  });

  await new Promise((resolve) => stderrStream.end(resolve));

  if (summary) await fsp.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  let exitCode, exitReason;
  if (summary) {
    if (summary.status === "completed") { exitCode = 0; exitReason = "completed"; }
    else if (summary.status === "timed_out") { exitCode = 124; exitReason = "timed_out"; }
    else { exitCode = 1; exitReason = summary.status || "failed"; }
  } else if (exitInfo.budgetExhausted) { exitCode = 124; exitReason = "timed_out"; }
  else if (exitInfo.signal && exitInfo.signal !== "SIGTERM") { exitCode = 1; exitReason = `signal:${exitInfo.signal}`; }
  else if (typeof exitInfo.code === "number") {
    exitCode = exitInfo.code;
    exitReason = exitInfo.code === 0 ? "completed" : `exit:${exitInfo.code}`;
  } else { exitCode = 2; exitReason = exitInfo.error || "adapter_error"; }

  git(repoDir, ["add", "-A"]);
  git(repoDir, ["-c", "user.email=spark-eval@example.local", "-c", "user.name=Spark Eval", "commit", "--allow-empty", "-m", "spark-eval-final"]);
  const headSha = git(repoDir, ["rev-parse", "HEAD"]).stdout.trim();

  const diffRes = git(repoDir, ["diff", baseSha, headSha, "--", ".", ":(exclude)spark-eval-plan.md", ":(exclude)prompt.md"]);
  const patch = diffRes.stdout || "";
  await fsp.writeFile(path.join(artifactsDir, "spark.patch"), patch, "utf8");

  return {
    instance_id: instance.instance_id,
    repo: instance.repo,
    base_commit: instance.base_commit,
    exitCode,
    exitReason,
    durationSeconds: (Date.now() - startedAtMs) / 1000,
    patch,
    patchSizeBytes: Buffer.byteLength(patch, "utf8"),
    baseSha,
    headSha,
    summary,
    artifactsDir,
    stderrLines,
  };
}

module.exports = { runSparkOnInstance };
