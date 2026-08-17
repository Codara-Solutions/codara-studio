// Unit tests for the spawn-time batch shape guard
// (src/main/orchestration/spawn-batch-guard.ts): the all-verifier batch with no
// implementation worker is rejected, every legitimate shape is accepted.
//
// The module imports nothing at runtime, so this harness bundles it with no
// stubs (same approach as scripts/test-worker-model-hint.cjs) and exercises the
// REAL evaluateSpawnBatchShape that agent-socket's codara_spawn_workers handler
// calls through getRunStore().
//
//   node scripts/test-spawn-batch-guard.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const MODULE_TS = path.join(ROOT, "src", "main", "orchestration", "spawn-batch-guard.ts");
const AGENT_SOCKET_TS = path.join(ROOT, "src", "main", "agent-socket.ts");
const RUN_STORE_TS = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
const MCP_SERVER_JS = path.join(ROOT, "resources", "codara-studio-mcp", "server.js");
const PI_PROMPT_TS = path.join(ROOT, "resources", "pi-cora", "prompt.ts");

const verifier = (title) => ({ title, taskClass: "verifier" });
const feature = (title) => ({ title, taskClass: "feature" });

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cora-spawn-guard-"));
  const outfile = path.join(tmp, "spawn-batch-guard.bundle.cjs");
  await esbuild.build({
    entryPoints: [MODULE_TS],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  const { evaluateSpawnBatchShape, runHasImplementationTask } = require(outfile);

  let pass = 0;
  const check = (name, cond, detail) => {
    if (!cond) {
      console.error(`FAIL ${name}${detail === undefined ? "" : ` - ${detail}`}`);
      process.exit(1);
    }
    pass += 1;
    console.log(`PASS ${name}`);
  };

  // ── the bug: run-ms09mf9h-axfjeo's first batch ──
  // Five research briefs, every one taskClass=verifier, on a run with no worker
  // tasks at all. Nothing to verify and read-only tools, so the batch could not
  // produce the deliverable; all five workers detected it themselves.
  const emptyRun = { workerTasks: [] };
  const fiveVerifiers = [
    verifier("Global markets news"),
    verifier("Macro and central banks"),
    verifier("Companies and deals"),
    verifier("Currencies and commodities"),
    verifier("Crypto and financial tech"),
  ];
  const rejected = evaluateSpawnBatchShape(emptyRun, fiveVerifiers);
  check("all-verifier batch on an empty run is rejected", rejected !== null);
  check(
    "rejection carries the structural code",
    rejected.code === "verifier_batch_without_implementer",
    JSON.stringify(rejected && rejected.code),
  );
  check("rejection reports the batch size", rejected.verifierCount === 5, String(rejected && rejected.verifierCount));
  // The message is the only channel that reaches the manager, so it must name
  // the problem AND the fix, not just refuse.
  check("rejection message names taskClass verifier", /taskClass "verifier"/.test(rejected.message));
  check("rejection message names the missing implementer", /no implementation/i.test(rejected.message));
  check("rejection message names leaf as the research class", /"leaf"/.test(rejected.message));
  check("rejection message stays dash-free", !/[\u2013\u2014]/.test(rejected.message));

  // A solo verifier is the same error, just cheaper.
  check(
    "single-verifier batch on an empty run is rejected",
    evaluateSpawnBatchShape(emptyRun, [verifier("Check the work")]) !== null,
  );
  // Class comparison is normalized: casing must not smuggle the batch through.
  check(
    "casing/whitespace variants are still recognized as verifier",
    evaluateSpawnBatchShape(emptyRun, [{ taskClass: " Verifier " }, { taskClass: "VERIFIER" }]) !== null,
  );

  // ── mixed batch: the implementers are in the batch itself ──
  check(
    "mixed implementer + verifier batch is accepted",
    evaluateSpawnBatchShape(emptyRun, [feature("Implement the parser"), verifier("Check the parser")]) === null,
  );
  check(
    "all-implementer batch is accepted",
    evaluateSpawnBatchShape(emptyRun, [feature("Slice A"), { title: "Slice B", taskClass: "leaf" }]) === null,
  );
  // An omitted taskClass is an implementation task (run-store's own default),
  // so a batch containing one is never all-verifier.
  check(
    "batch with an unclassed worker is accepted",
    evaluateSpawnBatchShape(emptyRun, [{ title: "Unclassed" }, verifier("Check it")]) === null,
  );
  check("empty batch is not this guard's business", evaluateSpawnBatchShape(emptyRun, []) === null);

  // ── verifier after an implementer: the legitimate follow-up ──
  const runWithFinishedImplementer = {
    workerTasks: [
      { taskClass: "feature", status: "succeeded" },
      { taskClass: "verifier", status: "succeeded" },
    ],
  };
  check(
    "verifier batch after a completed implementer is accepted",
    evaluateSpawnBatchShape(runWithFinishedImplementer, [verifier("Re-derive ground truth")]) === null,
  );
  // COMPLEX tier queues two peer verifiers in parallel; that batch is all
  // verifier and must survive.
  check(
    "two peer verifiers after an implementer are accepted",
    evaluateSpawnBatchShape(runWithFinishedImplementer, [verifier("Claude peer"), verifier("Codex peer")]) === null,
  );
  // A verifier queued alongside a still-running implementer is the normal
  // review shape, not the bug.
  check(
    "verifier batch alongside a running implementer is accepted",
    evaluateSpawnBatchShape({ workerTasks: [{ taskClass: "feature", status: "running" }] }, [verifier("Check")]) === null,
  );
  // A run whose only implementer was cancelled has no artifact either.
  check(
    "verifier batch after a cancelled-only implementer is rejected",
    evaluateSpawnBatchShape({ workerTasks: [{ taskClass: "feature", status: "cancelled" }] }, [verifier("Check")]) !== null,
  );
  check(
    "a run of prior verifiers alone does not count as an implementer",
    evaluateSpawnBatchShape({ workerTasks: [{ taskClass: "verifier", status: "succeeded" }] }, [verifier("Check")]) !== null,
  );

  check("runHasImplementationTask is false on an empty run", runHasImplementationTask(emptyRun) === false);
  check("runHasImplementationTask is true with a feature task", runHasImplementationTask(runWithFinishedImplementer) === true);

  // ── wiring: the guard must actually be reachable from the spawn RPC ──
  const runStoreSrc = fs.readFileSync(RUN_STORE_TS, "utf8");
  check(
    "run-store re-exports the guard for getRunStore() callers",
    /export \{[^}]*evaluateSpawnBatchShape[^}]*\} from "\.\/spawn-batch-guard"/s.test(runStoreSrc),
  );
  const socketSrc = fs.readFileSync(AGENT_SOCKET_TS, "utf8");
  check(
    "spawn_workers handler calls the guard",
    socketSrc.includes("runStore.evaluateSpawnBatchShape(run, workerEntries)"),
  );
  check(
    "the guard rejects with a protocol error instead of coercing",
    /batchRejection\)\s*\{[\s\S]{0,400}errorResponse\(id, ERR_INVALID_PARAMS, batchRejection\.message\)/.test(socketSrc),
  );
  // The guard must run before the verifier round cap, otherwise a bogus batch
  // still burns the run's verification budget on its way to being refused.
  check(
    "the guard runs before the verifier round cap",
    socketSrc.indexOf("evaluateSpawnBatchShape") < socketSrc.indexOf("const verifierRoundCap = verifierRoundCapForRun"),
  );

  // ── manager guidance: taskClass must read as a role, not a price tier ──
  const mcpSrc = fs.readFileSync(MCP_SERVER_JS, "utf8");
  check("MCP schema no longer calls taskClass a pricing dial", !mcpSrc.includes("tier/pricing selection"));
  check(
    "MCP schema defines verifier as a follow-up re-check",
    /'verifier' = READ-ONLY follow-up that re-checks an artifact an implementation worker already produced/.test(mcpSrc),
  );
  check(
    "MCP schema routes research to leaf",
    /read-only research or investigation task is 'leaf' or 'feature', not 'verifier'/.test(mcpSrc),
  );
  const piPromptSrc = fs.readFileSync(PI_PROMPT_TS, "utf8");
  check("pi Cora prompt carries a taskClass contract", piPromptSrc.includes("Worker taskClass contract:"));
  // The contract rides the shared `orchestrating` assembly that both auto and
  // execute modes join (talk and automation never touch it).
  check(
    "pi Cora prompt is wired into auto and execute modes",
    /const orchestrating = \[[\s\S]*?WORKER_TASK_CLASS_CONTRACT/.test(piPromptSrc) &&
      piPromptSrc.includes('mode === "auto"') &&
      /orchestrating\.slice/.test(piPromptSrc),
  );

  console.log(`\nAll ${pass} spawn-batch-guard checks passed.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
