// Unit tests for the worker model-hint sanitizer + the Fable 5 explicit-request
// gate (src/main/orchestration/worker-model-hint.ts).
//
// That module imports ONLY types (@shared/types), all erased by esbuild, so
// this harness bundles it with no stubs (same approach as
// scripts/test-loom-model.cjs) and exercises the REAL sanitizeWorkerModelHint /
// runUserRequestedFable. workerFableAllowed(run) in run-store.ts combines the
// live "fableEnabled" preference with explicit user intent. We reproduce that
// conjunction here and cover the worker gate:
// user-requested/not × setting on/off × fable hint → pass/downgrade.
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
    // @shared/* is a type-only import here (RunState), erased by esbuild —
    // resolve defensively so a future value import never breaks the bundle.
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

// A user-authored chat message (author "user", kind note/answer is what a human
// types). Everything else — spark/system authors, question cards — must NOT
// count toward the explicit request.
const userMsg = (message, kind = "note") => ({ author: "user", kind, message });
const sparkMsg = (message, kind = "note") => ({ author: "spark", kind, message });
const runWith = (messages) => ({ humanMessages: messages });

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
  const { sanitizeWorkerModelHint, runUserRequestedFable, SPARK_WORKER_FABLE_FALLBACK } = mod;

  // The worker gate as it lives in run-store.ts (workerFableAllowed): both the
  // preference and the user's own explicit request are required.
  const workerFableAllowed = (run, fableEnabled) => fableEnabled === true && runUserRequestedFable(run);

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

  check("SPARK_WORKER_FABLE_FALLBACK is claude-opus-4-8", SPARK_WORKER_FABLE_FALLBACK === "claude-opus-4-8");

  // ── runUserRequestedFable: only USER-authored note/answer text counts ──
  eq("no messages → not requested", runUserRequestedFable(runWith([])), false);
  eq("user note mentions fable → requested", runUserRequestedFable(runWith([userMsg("please use Fable 5 for this")])), true);
  eq("user note case-insensitive → requested", runUserRequestedFable(runWith([userMsg("run the worker on FABLE")])), true);
  eq("user answer mentions fable → requested", runUserRequestedFable(runWith([userMsg("yes, fable", "answer")])), true);
  eq(
    "manager (spark) echoing fable → NOT requested (no self-authorization)",
    runUserRequestedFable(runWith([sparkMsg("Downgraded fable worker to opus")])),
    false,
  );
  eq(
    "user message without fable → not requested",
    runUserRequestedFable(runWith([userMsg("build me a login page")])),
    false,
  );
  eq(
    "mixed: user unrelated + spark fable → not requested",
    runUserRequestedFable(runWith([userMsg("add a button"), sparkMsg("fable reserved")])),
    false,
  );
  eq(
    "mixed: later user turn asks for fable → requested (latches on)",
    runUserRequestedFable(runWith([userMsg("add a button"), userMsg("actually redo it with fable 5")])),
    true,
  );

  // ── sanitizeWorkerModelHint: fable downgrade unless allowFable ──
  for (const hint of ["claude-fable-5", "Claude-Fable-5", "claude-fable-5@high", "fable"]) {
    const off = sanitizeWorkerModelHint(hint);
    check(`"${hint}" downgraded when allowFable omitted`, off.downgraded === true && off.hint === "claude-opus-4-8");
    const denied = sanitizeWorkerModelHint(hint, { allowFable: false });
    check(`"${hint}" downgraded when allowFable=false`, denied.downgraded === true && denied.hint === "claude-opus-4-8");
    const allowed = sanitizeWorkerModelHint(hint, { allowFable: true });
    check(`"${hint}" passes through unchanged when allowFable=true`, allowed.downgraded === false && allowed.hint === hint);
  }

  // ── non-fable hints + Codex catalog migration ──
  const opus = sanitizeWorkerModelHint("claude-opus-4-8", { allowFable: true });
  check("opus untouched", opus.downgraded === false && opus.hint === "claude-opus-4-8");
  const gpt = sanitizeWorkerModelHint("gpt-5.5", { allowFable: false });
  check("legacy gpt-5.5 migrates to GPT-5.6 Sol", gpt.downgraded === false && gpt.hint === "gpt-5.6-sol");
  const terra = sanitizeWorkerModelHint("gpt-5.6-terra", { allowFable: false });
  check("GPT-5.6 Terra stays concrete", terra.downgraded === false && terra.hint === "gpt-5.6-terra");
  const lunaEffort = sanitizeWorkerModelHint("gpt-5.6-luna@low", { allowFable: false });
  check("GPT-5.6 Luna keeps @effort", lunaEffort.downgraded === false && lunaEffort.hint === "gpt-5.6-luna@low");
  const undef = sanitizeWorkerModelHint(undefined, { allowFable: false });
  check("undefined hint stays undefined", undef.downgraded === false && undef.hint === undefined);

  // ── superseded-Sonnet remap still works (not a fable/downgrade path) ──
  const sonnet = sanitizeWorkerModelHint("claude-sonnet-4-6");
  check("superseded sonnet remapped to claude-sonnet-5", sonnet.downgraded === false && sonnet.hint === "claude-sonnet-5");
  const sonnetEffort = sanitizeWorkerModelHint("sonnet-4-6@medium");
  check("superseded sonnet keeps @effort suffix", sonnetEffort.hint === "claude-sonnet-5@medium");

  // ── The end-to-end worker gate: setting × request × fable hint ──
  const requested = runWith([userMsg("use fable 5 for the worker")]);
  const notRequested = runWith([userMsg("just build it")]);

  // (1) fable hint + no explicit request → downgraded
  {
    const allow = workerFableAllowed(notRequested, true);
    const res = sanitizeWorkerModelHint("claude-fable-5", { allowFable: allow });
    check("gate: fable hint + no request → downgraded", allow === false && res.downgraded === true && res.hint === "claude-opus-4-8");
  }
  // (2) fable hint + explicit request → passes through
  {
    const allow = workerFableAllowed(requested, true);
    const res = sanitizeWorkerModelHint("claude-fable-5", { allowFable: allow });
    check("gate: fable hint + request → passes", allow === true && res.downgraded === false && res.hint === "claude-fable-5");
  }
  // (3) Explicit request + setting OFF → still downgraded.
  {
    const allow = workerFableAllowed(requested, false);
    const res = sanitizeWorkerModelHint("claude-fable-5", { allowFable: allow });
    check("gate: fable hint + request + setting off → downgraded", allow === false && res.downgraded === true && res.hint === "claude-opus-4-8");
  }

  console.log(`\nAll ${pass} worker-model-hint checks passed.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
