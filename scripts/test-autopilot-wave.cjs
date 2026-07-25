// Unit tests for the pure autopilot wave selector
// (src/main/orchestration/autopilot-wave.ts): manager-batch parallel trust,
// the fan-out no-concrete-scope serial downgrade, and scope/explicit conflict
// handling.
//
// The regression this pins down (run-ms0lod1m-h3pqoo): a manager spawned 5
// research leaf workers in one codara_spawn_workers batch. All 5 claude
// attempts launched simultaneously and failed environmentally; the runtime
// fallback created 5 replacement tasks (createdBy "system", empty
// allowedPaths). The picker then read "wants parallel, no concrete scope" as
// the fan-out anti-pattern and relaunched them ONE AT A TIME, turning a
// parallel research batch into a serial chain. Tasks minted by a multi-worker
// spawn batch now carry parallelTrust="manager_batch" (inherited by their
// fallback replacements), which the selector honors: the whole retry wave
// launches together, while planner-created writer tasks with no concrete
// scope still downgrade to serial.
//
// Bundled with esbuild like scripts/test-spawn-batch-guard.cjs; @shared/* is
// resolved via the alias option (the module pulls in @shared/parallel-wave).
//
//   node scripts/test-autopilot-wave.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const MODULE_TS = path.join(ROOT, "src", "main", "orchestration", "autopilot-wave.ts");
const RUN_STORE_TS = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");
const AGENT_SOCKET_TS = path.join(ROOT, "src", "main", "agent-socket.ts");
const TYPES_TS = path.join(ROOT, "src", "shared", "types.ts");

let taskCounter = 0;
function task(overrides = {}) {
  taskCounter += 1;
  return {
    id: overrides.id ?? `task-${taskCounter}`,
    allowedPaths: [],
    canRunParallel: true,
    conflictsWith: [],
    taskClass: "feature",
    runtimePreference: "claude",
    ...overrides,
  };
}

// The observed batch shape: spark-created leaf research workers, no write
// scopes, marked parallel-trusted by the spawn handler.
function sparkLeaf(id) {
  return task({
    id,
    taskClass: "leaf",
    parallelTrust: "manager_batch",
    createdBy: "spark",
  });
}

// The runtime-fallback replacement shape: createdBy "system", supersedes the
// failed spark task, inherits scopes/parallel flags/trust, opposite runtime.
function systemFallback(id, supersedesTaskId) {
  return task({
    id,
    taskClass: "leaf",
    parallelTrust: "manager_batch",
    createdBy: "system",
    supersedesTaskId,
    runtimePreference: "codex",
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cora-autopilot-wave-"));
  const outfile = path.join(tmp, "autopilot-wave.bundle.cjs");
  await esbuild.build({
    entryPoints: [MODULE_TS],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
  });
  const {
    selectAutopilotWave,
    hasManagerBatchParallelTrust,
    tasksConflictForParallelLaunch,
    hasConcreteParallelScope,
  } = require(outfile);

  let pass = 0;
  const check = (name, cond, detail) => {
    if (!cond) {
      console.error(`FAIL ${name}${detail === undefined ? "" : ` - ${detail}`}`);
      process.exit(1);
    }
    pass += 1;
    console.log(`PASS ${name}`);
  };
  const ids = (selection) => selection.tasks.map((t) => t.id);

  // ── the regression: the initial 5-worker spark batch relaunches as one wave ──
  const sparkBatch = ["a", "b", "c", "d", "e"].map(sparkLeaf);
  const sparkWave = selectAutopilotWave(sparkBatch, null);
  check(
    "5 spark leaf tasks with empty allowedPaths all selected",
    JSON.stringify(ids(sparkWave)) === JSON.stringify(["a", "b", "c", "d", "e"]),
    JSON.stringify(ids(sparkWave)),
  );
  check("trusted spark batch is not downgraded", sparkWave.downgrade === null);

  // ── the regression proper: the 5 system fallback replacements too ──
  const fallbackBatch = ["a", "b", "c", "d", "e"].map((id) => systemFallback(`${id}2`, id));
  const fallbackWave = selectAutopilotWave(fallbackBatch, null);
  check(
    "5 system fallback tasks superseding the batch all selected",
    JSON.stringify(ids(fallbackWave)) === JSON.stringify(["a2", "b2", "c2", "d2", "e2"]),
    JSON.stringify(ids(fallbackWave)),
  );
  check("fallback wave is not downgraded", fallbackWave.downgrade === null);

  // A direct failed-task retry re-picks the SAME task, which still carries the
  // marker, so a partial retry wave (some originals, some fallbacks) holds too.
  const mixedRetryWave = selectAutopilotWave([sparkLeaf("a"), systemFallback("b2", "b")], null);
  check(
    "mixed original-retry + fallback wave stays parallel",
    JSON.stringify(ids(mixedRetryWave)) === JSON.stringify(["a", "b2"]),
    JSON.stringify(ids(mixedRetryWave)),
  );

  // ── the fan-out guard keeps its target: unscoped planner writer tasks ──
  const plannerWriters = [
    task({ id: "w1", createdBy: "spark" }),
    task({ id: "w2", createdBy: "spark" }),
  ];
  const downgraded = selectAutopilotWave(plannerWriters, null);
  check(
    "planner writer tasks with empty scope downgrade to a single serial task",
    JSON.stringify(ids(downgraded)) === JSON.stringify(["w1"]),
    JSON.stringify(ids(downgraded)),
  );
  check(
    "downgrade carries the no_concrete_scope reason",
    downgraded.downgrade !== null && downgraded.downgrade.reason === "no_concrete_scope",
    JSON.stringify(downgraded.downgrade),
  );
  check(
    "a broad glob scope is still no concrete scope",
    selectAutopilotWave([task({ id: "broad", allowedPaths: ["**"] }), task({ id: "broad2", allowedPaths: ["."] })], null)
      .downgrade?.reason === "no_concrete_scope",
  );

  // ── deliberately-serial tasks stay serial and unreported ──
  const serial = selectAutopilotWave([task({ id: "s1", canRunParallel: false }), sparkLeaf("s2")], null);
  check(
    "a not-parallel first task launches alone with the not_parallel reason",
    JSON.stringify(ids(serial)) === JSON.stringify(["s1"]) && serial.downgrade?.reason === "not_parallel",
    JSON.stringify(serial),
  );

  // ── explicit conflictsWith still binds trusted tasks ──
  const conflicted = [
    sparkLeaf("a"),
    { ...sparkLeaf("b"), conflictsWith: ["a"] },
    sparkLeaf("c"),
  ];
  const conflictWave = selectAutopilotWave(conflicted, null);
  check(
    "conflictsWith is respected between trusted tasks",
    JSON.stringify(ids(conflictWave)) === JSON.stringify(["a", "c"]),
    JSON.stringify(ids(conflictWave)),
  );
  check(
    "trusted pair with explicit conflictsWith conflicts",
    tasksConflictForParallelLaunch(conflicted[0], conflicted[1]) === true,
  );

  // ── the incoherence the fix removes: empty-scope trusted pairs don't conflict ──
  check(
    "trusted empty-scope pair does not conflict",
    tasksConflictForParallelLaunch(sparkLeaf("x"), sparkLeaf("y")) === false,
  );
  check(
    "untrusted empty-scope writer pair still conflicts",
    tasksConflictForParallelLaunch(task({ id: "p" }), task({ id: "q" })) === true,
  );
  check(
    "mixed trusted/untrusted pair keeps the conservative scope conflict",
    tasksConflictForParallelLaunch(sparkLeaf("t"), task({ id: "u", allowedPaths: ["src/a.ts"] })) === true,
  );

  // ── concrete disjoint scopes keep working exactly as before ──
  const scoped = selectAutopilotWave(
    [
      task({ id: "f1", allowedPaths: ["src/a.ts"] }),
      task({ id: "f2", allowedPaths: ["src/b.ts"] }),
      task({ id: "f3", allowedPaths: ["src/a.ts"] }),
    ],
    null,
  );
  check(
    "disjoint concrete scopes run parallel, overlapping ones don't",
    JSON.stringify(ids(scoped)) === JSON.stringify(["f1", "f2"]),
    JSON.stringify(ids(scoped)),
  );

  // ── the parallel cap applies to trusted waves too ──
  const capped = selectAutopilotWave(sparkBatch, 2);
  check("trusted wave respects the worker cap", ids(capped).length === 2, JSON.stringify(ids(capped)));

  // ── trust predicate edges ──
  check("trust requires the manager_batch marker", hasManagerBatchParallelTrust(task({ id: "n" })) === false);
  check(
    "trust requires canRunParallel",
    hasManagerBatchParallelTrust(task({ id: "n2", parallelTrust: "manager_batch", canRunParallel: false })) === false,
  );
  check(
    "verifier/manual tasks never needed trust (non-writing scope passes)",
    hasConcreteParallelScope(task({ id: "v", taskClass: "verifier" })) === true &&
      hasConcreteParallelScope(task({ id: "m", runtimePreference: "manual" })) === true,
  );
  check("empty frontier stays empty", JSON.stringify(selectAutopilotWave([], null).tasks) === "[]");

  // ── wiring: the trust marker must actually flow through the real paths ──
  const socketSrc = fs.readFileSync(AGENT_SOCKET_TS, "utf8");
  check(
    "spawn handler stamps manager-batch trust on multi-worker batches",
    socketSrc.includes('parallelTrust: isParallelBatch ? "manager_batch" : undefined'),
  );
  const runStoreSrc = fs.readFileSync(RUN_STORE_TS, "utf8");
  check(
    "runtime fallback replacement inherits the trust marker",
    /supersedesTaskId: task\.id[\s\S]{0,1500}parallelTrust: task\.parallelTrust/.test(runStoreSrc),
  );
  check(
    "createWorkerTask threads parallelTrust onto the task",
    runStoreSrc.includes("parallelTrust: input.parallelTrust"),
  );
  check(
    "pickAutopilotTasks delegates to the pure selector",
    runStoreSrc.includes("selectAutopilotWave(candidates, evalMaxParallelWorkers())"),
  );
  const typesSrc = fs.readFileSync(TYPES_TS, "utf8");
  check(
    "WorkerTask declares the parallelTrust provenance field",
    typesSrc.includes('parallelTrust?: "manager_batch"'),
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nAll ${pass} autopilot-wave checks passed.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
