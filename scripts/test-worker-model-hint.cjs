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
  const {
    sanitizeWorkerModelHint,
    WORKER_DEFAULT_CLAUDE_MODEL,
    ALLOWED_WORKER_MODELS,
    coerceWorkerModelToRoster,
    rosterModelFor,
  } = mod;

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
  check("WORKER_DEFAULT_CLAUDE_MODEL is claude-opus-5", WORKER_DEFAULT_CLAUDE_MODEL === "claude-opus-5");

  // ── explicit hints pass through unchanged, fable included ──
  for (const hint of ["claude-fable-5", "claude-fable-5@high", "claude-opus-5", "claude-sonnet-5"]) {
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

  // ── the worker roster ──
  // Three models, and only three. If this count changes, the planner prompts
  // in prompt-profile.ts / claude-backend.ts / manager-protocol.ts enumerate
  // the roster verbatim and must be updated in the same change.
  eq("roster exposes four models including Grok", ALLOWED_WORKER_MODELS.length, 4);
  for (const id of ["claude-opus-5", "gpt-5.6-sol", "claude-fable-5"]) {
    check(`roster contains ${id}`, ALLOWED_WORKER_MODELS.includes(id));
  }
  eq("claude standard tier is Opus", rosterModelFor("claude", "standard"), "claude-opus-5");
  eq("claude premium tier is Fable", rosterModelFor("claude", "premium"), "claude-fable-5");
  eq("codex has a single allowed model", rosterModelFor("codex", "premium"), "gpt-5.6-sol");

  // Coercion never rejects, an off-roster hint lands on the nearest allowed
  // model so a bad planner hint degrades instead of failing the spawn.
  eq("sonnet coerces to Opus", coerceWorkerModelToRoster("claude", "claude-sonnet-5"), "claude-opus-5");
  eq("terra coerces to Sol", coerceWorkerModelToRoster("codex", "gpt-5.6-terra"), "gpt-5.6-sol");
  eq("luna coerces to Sol", coerceWorkerModelToRoster("codex", "gpt-5.6-luna"), "gpt-5.6-sol");
  eq("haiku coerces to Opus", coerceWorkerModelToRoster("claude", "claude-haiku-4-5"), "claude-opus-5");
  eq("an omitted hint pins the standard tier", coerceWorkerModelToRoster("claude", undefined), "claude-opus-5");
  eq("an omitted codex hint pins Sol", coerceWorkerModelToRoster("codex", undefined), "gpt-5.6-sol");
  eq("an unknown id falls back to standard", coerceWorkerModelToRoster("claude", "claude-zeta-9"), "claude-opus-5");

  // Roster members survive coercion, @effort suffix intact.
  eq("fable survives coercion", coerceWorkerModelToRoster("claude", "claude-fable-5"), "claude-fable-5");
  eq("fable keeps @effort", coerceWorkerModelToRoster("claude", "claude-fable-5@max"), "claude-fable-5@max");
  eq("sol keeps @effort", coerceWorkerModelToRoster("codex", "gpt-5.6-sol@high"), "gpt-5.6-sol@high");
  eq("a coerced hint keeps @effort", coerceWorkerModelToRoster("claude", "claude-sonnet-5@low"), "claude-opus-5@low");
  // A bare "fable" ask is honoured on claude; codex has no premium tier to
  // honour it with, so it lands on the frontier model rather than failing.
  eq("bare fable ask resolves to Fable 5", coerceWorkerModelToRoster("claude", "fable"), "claude-fable-5");
  eq("fable asked of codex lands on Sol", coerceWorkerModelToRoster("codex", "claude-fable-5"), "gpt-5.6-sol");
  // Legacy ids normalize BEFORE coercion, so a stale session's id still lands
  // on the roster rather than being treated as unknown.
  eq("legacy gpt-5.5 coerces to Sol", coerceWorkerModelToRoster("codex", "gpt-5.5"), "gpt-5.6-sol");
  eq("superseded sonnet coerces to Opus", coerceWorkerModelToRoster("claude", "sonnet-4-6"), "claude-opus-5");
  // The previous standard tier must still land on the roster: runs and configs
  // persisted before the roster moved to Opus 5 still carry the old id.
  eq("the superseded Opus id coerces onto the current roster", coerceWorkerModelToRoster("claude", "claude-opus-4-8"), "claude-opus-5");
  // Runtimes with no model roster (shell/manual) pass through untouched.
  eq("shell runtime passes its hint through", coerceWorkerModelToRoster("shell", "whatever"), "whatever");

  console.log(`\nAll ${pass} worker-model-hint checks passed.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
