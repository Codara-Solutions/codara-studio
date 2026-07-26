// Focused executable coverage for trustworthy result-manifest collection.
// Verifies run-start Git deltas, untracked files, worker-reported-only files,
// provenance, checks/evidence, shared prose, and the non-Git fallback.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "main", "orchestration", "result-manifest.ts");
const SHARED_DIR = path.join(ROOT, "src", "shared");

async function loadContract() {
  const out = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    plugins: [{
      name: "shared-alias",
      setup(build) {
        build.onResolve({ filter: /^@shared\// }, (args) => ({
          path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
        }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function main() {
  const { collectRunResultManifest, renderRunResultManifestSummary } = await loadContract();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codara-result-manifest-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Codara Test");
  git(repo, "config", "user.email", "codara@example.invalid");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "before\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-qm", "baseline");
  const baseline = git(repo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "after\n");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "new\n");

  const reportPath = path.join(root, "final-report.json");
  fs.writeFileSync(reportPath, JSON.stringify({
    status: "complete",
    summary: "Implemented the requested behavior.",
    filesChanged: [
      { path: "tracked.txt", reason: "Updated behavior" },
      { path: "reported-only.txt", reason: "Worker claim not visible in Git" },
    ],
    commandsRun: [
      { command: "npm run typecheck", exitCode: 0, summary: "clean" },
      { command: "npm test", exitCode: 1, summary: "one failure" },
    ],
    tests: [{ command: "node focused-test.cjs", result: "passed", details: "2 passed" }],
    proof: ["Observed the new state."],
    risks: ["A known warning remains."],
    followups: ["Review the warning later."],
    verifier: {
      status: "verified",
      confidence: "VERIFIED",
      atomicClaims: [{ claim: "The change works", verdict: "verified", evidence: "Focused test passed" }],
    },
  }));

  const run = {
    id: "run-manifest",
    title: "Manifest probe",
    status: "complete",
    settingsSnapshot: { workspaceCwd: repo },
    checkpoints: [{ kind: "run-start", sha: baseline }],
    workerTasks: [{ id: "task-1" }],
    workerAttempts: [{ id: "attempt-1", workerTaskId: "task-1", finalReportPath: reportPath }],
    humanMessages: [
      { author: "user", message: "Implement the behavior." },
      { author: "spark", message: "Manager-verified run outcome." },
    ],
  };
  const manifest = await collectRunResultManifest(run, () => { throw new Error("unexpected path fallback"); });
  const byPath = new Map(manifest.workspaceDelta.map((item) => [item.path, item]));
  assert.equal(manifest.workspace.mode, "git");
  assert.equal(manifest.workspace.baselineSha, baseline);
  assert.deepEqual(byPath.get("tracked.txt"), {
    path: "tracked.txt", status: "modified", provenance: "observed", reason: "Updated behavior",
  });
  assert.equal(byPath.get("untracked.txt").status, "untracked");
  assert.equal(byPath.get("untracked.txt").provenance, "observed");
  assert.equal(byPath.get("reported-only.txt").status, "reported");
  assert.equal(byPath.get("reported-only.txt").provenance, "reported");
  assert.equal(manifest.checks.find((item) => item.command === "npm run typecheck").provenance, "verified");
  assert.equal(manifest.checks.find((item) => item.command === "npm test").provenance, "reported");
  assert.equal(manifest.evidence.find((item) => item.text.startsWith("The change works")).provenance, "verified");
  assert.equal(manifest.summary, "Manager-verified run outcome.");
  assert.equal(manifest.outcomes[0].text, "Implemented the requested behavior.");
  const prose = renderRunResultManifestSummary(manifest);
  assert.match(prose, /tracked\.txt.*observed/);
  assert.match(prose, /npm run typecheck.*passed.*verified/);
  console.log("  PASS Git delta, untracked files, provenance, evidence, and shared prose");

  const nonGit = path.join(root, "not-a-repo");
  fs.mkdirSync(nonGit);
  const fallback = await collectRunResultManifest({
    id: "run-non-git",
    title: "Non-Git probe",
    status: "complete",
    settingsSnapshot: { workspaceCwd: nonGit },
    checkpoints: [],
    workerTasks: [],
    workerAttempts: [],
  }, () => { throw new Error("unexpected path fallback"); });
  assert.equal(fallback.workspace.mode, "non_git");
  assert.match(fallback.workspace.note, /not independently diffed/i);
  console.log("  PASS honest non-Git fallback");
  console.log("2 result-manifest contract tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
