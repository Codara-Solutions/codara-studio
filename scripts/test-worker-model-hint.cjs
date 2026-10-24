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
    plannedWorkerModel,
    WORKER_DEFAULT_CLAUDE_MODEL,
    ALLOWED_WORKER_MODELS,
    WORKER_MODEL_ROSTER,
    coerceWorkerModelToRoster,
    enabledWorkerModelFor,
    rosterModelFor,
    runtimeForWorkerModelId,
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
  // The recommended tier mapping stays small, while the picker/launch boundary
  // also offers the providers' current opt-in models.
  eq("roster exposes eight native worker choices", ALLOWED_WORKER_MODELS.length, 8);
  for (const id of [
    "claude-opus-5",
    "claude-fable-5",
    "claude-sonnet-5",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-6-astra",
    "grok-4.6",
  ]) {
    check(`roster contains ${id}`, ALLOWED_WORKER_MODELS.includes(id));
  }
  eq("claude standard tier is Opus", rosterModelFor("claude", "standard"), "claude-opus-5");
  eq("claude premium tier is Fable", rosterModelFor("claude", "premium"), "claude-fable-5");
  eq("codex tier default remains Sol", rosterModelFor("codex", "premium"), "gpt-5.6-sol");
  check("Astra is allowed as an opt-in model", ALLOWED_WORKER_MODELS.includes("gpt-6-astra"));
  check(
    "Astra is not enabled by default",
    !Object.values(WORKER_MODEL_ROSTER).flatMap(Object.values).includes("gpt-6-astra"),
  );

  // Coercion never rejects, an off-roster hint lands on the nearest allowed
  // model so a bad planner hint degrades instead of failing the spawn.
  eq("Sonnet survives opt-in coercion", coerceWorkerModelToRoster("claude", "claude-sonnet-5"), "claude-sonnet-5");
  eq("Terra survives opt-in coercion", coerceWorkerModelToRoster("codex", "gpt-5.6-terra"), "gpt-5.6-terra");
  eq("Luna survives opt-in coercion", coerceWorkerModelToRoster("codex", "gpt-5.6-luna"), "gpt-5.6-luna");
  eq("Astra survives opt-in coercion", coerceWorkerModelToRoster("codex", "gpt-6-astra"), "gpt-6-astra");
  eq("haiku coerces to Opus", coerceWorkerModelToRoster("claude", "claude-haiku-4-5"), "claude-opus-5");
  eq("an omitted hint pins the standard tier", coerceWorkerModelToRoster("claude", undefined), "claude-opus-5");
  eq("an omitted codex hint pins Sol", coerceWorkerModelToRoster("codex", undefined), "gpt-5.6-sol");
  eq("an unknown id falls back to standard", coerceWorkerModelToRoster("claude", "claude-zeta-9"), "claude-opus-5");

  // Roster members survive coercion, @effort suffix intact.
  eq("fable survives coercion", coerceWorkerModelToRoster("claude", "claude-fable-5"), "claude-fable-5");
  eq("fable keeps @effort", coerceWorkerModelToRoster("claude", "claude-fable-5@max"), "claude-fable-5@max");
  eq("sol keeps @effort", coerceWorkerModelToRoster("codex", "gpt-5.6-sol@high"), "gpt-5.6-sol@high");
  eq("an optional hint keeps @effort", coerceWorkerModelToRoster("claude", "claude-sonnet-5@low"), "claude-sonnet-5@low");
  // A bare "fable" ask is honoured on claude; codex has no premium tier to
  // honour it with, so it lands on the frontier model rather than failing.
  eq("bare fable ask resolves to Fable 5", coerceWorkerModelToRoster("claude", "fable"), "claude-fable-5");
  eq("fable asked of codex lands on Sol", coerceWorkerModelToRoster("codex", "claude-fable-5"), "gpt-5.6-sol");
  // Legacy ids normalize BEFORE coercion, so a stale session's id still lands
  // on the roster rather than being treated as unknown.
  eq("legacy gpt-5.5 coerces to Sol", coerceWorkerModelToRoster("codex", "gpt-5.5"), "gpt-5.6-sol");
  eq("superseded sonnet coerces to current Sonnet", coerceWorkerModelToRoster("claude", "sonnet-4-6"), "claude-sonnet-5");
  // The previous standard tier must still land on the roster: runs and configs
  // persisted before the roster moved to Opus 5 still carry the old id.
  eq("the superseded Opus id coerces onto the current roster", coerceWorkerModelToRoster("claude", "claude-opus-4-8"), "claude-opus-5");
  // Runtimes with no model roster (shell/manual) pass through untouched.
  eq("shell runtime passes its hint through", coerceWorkerModelToRoster("shell", "whatever"), "whatever");

  // The user-controlled list is the final launch boundary. Exact favorites
  // win, unavailable native hints stay in-family when possible, and a sole
  // OpenRouter favorite receives every worker regardless of the old hint.
  eq(
    "enabled exact OpenRouter hint survives",
    enabledWorkerModelFor("codex", "google/gemini-2.5-pro", ["google/gemini-2.5-pro"]),
    "google/gemini-2.5-pro",
  );
  eq(
    "OpenRouter favorites do not inherit Pi @effort suffixes",
    enabledWorkerModelFor("codex", "google/gemini-2.5-pro@high", ["google/gemini-2.5-pro"]),
    "google/gemini-2.5-pro",
  );
  eq(
    "disabled Claude hint falls back to enabled Claude model",
    enabledWorkerModelFor("claude", "claude-fable-5", ["claude-opus-5", "gpt-5.6-sol"]),
    "claude-opus-5",
  );
  eq(
    "sole OpenRouter favorite handles a native hint",
    enabledWorkerModelFor("claude", "claude-opus-5", ["google/gemini-flash-latest"]),
    "google/gemini-flash-latest",
  );
  eq("empty enabled list rejects a worker", enabledWorkerModelFor("codex", undefined, []), undefined);

  // A Pi worker's provider follows its model, so the model's family is what
  // must have a connected account.
  eq("claude ids belong to claude", runtimeForWorkerModelId("claude-opus-5@high"), "claude");
  eq("gpt ids belong to codex", runtimeForWorkerModelId("gpt-5.6-sol"), "codex");
  eq("grok ids belong to grok", runtimeForWorkerModelId("grok-5"), "grok");
  eq("OpenRouter ids belong to no native family", runtimeForWorkerModelId("x-ai/grok-5"), undefined);
  eq("unknown ids belong to no native family", runtimeForWorkerModelId("mystery"), undefined);
  // Only Claude is connected and the user left only GPT models enabled plus
  // one Claude model: a codex request lands on the Claude model, not on a GPT
  // model no account can launch.
  const onlyClaude = new Set(["claude"]);
  eq(
    "fallback skips enabled models whose provider has no account",
    enabledWorkerModelFor("codex", "gpt-5.6-luna", ["gpt-5.6-sol", "claude-opus-5"], onlyClaude),
    "claude-opus-5",
  );
  eq(
    "a claude task hinted at a GPT model still lands on a launchable model",
    enabledWorkerModelFor("claude", "gpt-5.6-sol", ["gpt-5.6-sol", "claude-opus-5"], onlyClaude),
    "claude-opus-5",
  );
  eq(
    "OpenRouter favorites are never excluded by account state",
    enabledWorkerModelFor("codex", undefined, ["google/gemini-2.5-pro", "gpt-5.6-sol"], onlyClaude),
    "google/gemini-2.5-pro",
  );
  eq(
    "with no launchable model the enabled list is used as is",
    enabledWorkerModelFor("claude", "claude-opus-5", ["gpt-5.6-sol"], onlyClaude),
    "gpt-5.6-sol",
  );
  eq(
    "without account state the exact enabled hint still wins",
    enabledWorkerModelFor("claude", "gpt-5.6-sol", ["gpt-5.6-sol", "claude-opus-5"]),
    "gpt-5.6-sol",
  );
  eq(
    "plannedWorkerModel passes the account state through",
    plannedWorkerModel({ runtimePreference: "codex", modelHint: "gpt-5.6-sol" }, {
      enabledModels: ["gpt-5.6-sol", "claude-opus-5"],
      usableRuntimes: onlyClaude,
    }),
    "claude-opus-5",
  );
  const runStoreSource = fs.readFileSync(
    path.join(ROOT, "src", "main", "orchestration", "run-store.ts"),
    "utf8",
  );
  check(
    "the worker provider is derived from the resolved model",
    /const runtime = runtimeForWorkerModelId\(model\) \?\? task\.runtimePreference;/.test(runStoreSource),
  );

  for (const model of ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-6-astra", "gpt-5.4", "claude-fable-5-1", "claude-sonnet-4-6"]) {
    const task = { runtimePreference: model.startsWith("claude-") ? "claude" : "codex", modelHint: model };
    eq(`direct selection preserves ${model}`, plannedWorkerModel(task, {
      isDirectRun: true, enabledModels: ["gpt-5.6-sol", "claude-opus-5"],
    }), model);
  }
  eq("managed hints still honor the enabled roster", plannedWorkerModel({ runtimePreference: "codex", modelHint: "gpt-5.6-luna" }, {
    enabledModels: ["gpt-5.6-sol"],
  }), "gpt-5.6-sol");
  eq("automation retains its existing legacy remap", plannedWorkerModel({ runtimePreference: "claude", modelHint: "claude-sonnet-4-6" }, {
    isAutomationRun: true,
  }), "claude-sonnet-5");

  console.log(`\nAll ${pass} worker-model-hint checks passed.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
