// Unit tests for the worker model-hint sanitizer
// (src/main/orchestration/worker-model-hint.ts): the superseded-Sonnet remap,
// legacy-Codex id normalization, and the pinned no-hint Claude default.
//
// That module imports ONLY types (@shared/types), all erased by esbuild, so
// this harness bundles it with no stubs (same approach as
// scripts/test-loom-model.cjs) and exercises the REAL sanitizeWorkerModelHint.
//
//   node scripts/test-worker-model-hint.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const MODULE_TS = path.join(ROOT, "src", "main", "orchestration", "worker-model-hint.ts");

const harnessPlugin = {
  name: "worker-model-hint-test-harness",
  setup(build) {
    // @shared/* is a type-only import here, erased by esbuild — resolve
    // defensively so a future value import never breaks the bundle.
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spark-wmh-"));
  const outfile = path.join(tmp, "worker-model-hint.bundle.cjs");
  await esbuild.build({
    entryPoints: [MODULE_TS],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins: [harnessPlugin],
    logLevel: "silent",
  });
  const mod = require(outfile);
  const { sanitizeWorkerModelHint, WORKER_DEFAULT_CLAUDE_MODEL } = mod;

  let pass = 0;
  const check = (name, cond) => {
    if (!cond) {
      console.error(`FAIL ${name}`);
      process.exit(1);
    }
    pass += 1;
    console.log(`PASS ${name}`);
  };
  const eq = (name, actual, expected) =>
    check(`${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`, actual === expected);

  // The no-hint pin: a task with NO modelHint must launch on Opus, never on
  // the CLI/subscription default (which can be the premium Fable 5 tier).
  check("WORKER_DEFAULT_CLAUDE_MODEL is claude-opus-4-8", WORKER_DEFAULT_CLAUDE_MODEL === "claude-opus-4-8");

  // ── explicit hints pass through unchanged, fable included ──
  for (const hint of ["claude-fable-5", "claude-fable-5@high", "claude-opus-4-8", "claude-sonnet-5"]) {
    eq(`"${hint}" passes through unchanged`, sanitizeWorkerModelHint(hint), hint);
  }
  eq("undefined hint stays undefined", sanitizeWorkerModelHint(undefined), undefined);

  // ── legacy Codex ids migrate through the shared catalog ──
  eq("legacy gpt-5.5 migrates to GPT-5.6 Sol", sanitizeWorkerModelHint("gpt-5.5"), "gpt-5.6-sol");
  eq("GPT-5.6 Terra stays concrete", sanitizeWorkerModelHint("gpt-5.6-terra"), "gpt-5.6-terra");
  eq("GPT-5.6 Luna keeps @effort", sanitizeWorkerModelHint("gpt-5.6-luna@low"), "gpt-5.6-luna@low");

  // ── superseded-Sonnet remap ──
  eq("superseded sonnet remapped to claude-sonnet-5", sanitizeWorkerModelHint("claude-sonnet-4-6"), "claude-sonnet-5");
  eq("superseded sonnet keeps @effort suffix", sanitizeWorkerModelHint("sonnet-4-6@medium"), "claude-sonnet-5@medium");
  eq("suffixed -legacy sonnet id stays untouched", sanitizeWorkerModelHint("claude-sonnet-4-6-legacy"), "claude-sonnet-4-6-legacy");

  console.log(`\nAll ${pass} worker-model-hint checks passed.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
