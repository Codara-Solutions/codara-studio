// Runtime test for the Looms v2 direct-worker plumbing (src/main/orchestration/
// direct-worker.ts): the headless pty spawn handler, the boot-recovery decision
// table (report-first), and the live-worker inventory. esbuild bundles the REAL
// direct-worker.ts and stubs pty-manager / shells / event-log / run-store /
// scheduler so every decision is observable.
//
//   node scripts/test-direct-worker.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const DIRECT_WORKER_TS = path.join(ROOT, "src", "main", "orchestration", "direct-worker.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const harnessPlugin = {
  name: "direct-worker-test-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve(
      { filter: /^(\.\/(run-store|event-log|scheduler)|\.\.\/(pty-manager|shells))$/ },
      (args) => ({ path: args.path.replace(/^\.\.?\//, ""), namespace: "stub" }),
    );
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      const init =
        "globalThis.__DW ??= { runs: new Map(), subs: new Set(), spawned: [], failed: [], relaunched: [], settled: [], statusUpdates: [], ptys: new Set(), events: [], spawnThrows: false };\n";
      if (args.path === "pty-manager") {
        return {
          contents:
            init +
            "export async function spawn(opts){ const D = globalThis.__DW; if (D.spawnThrows) throw new Error('boom'); D.spawned.push(opts); D.ptys.add(opts.id); return { id: opts.id, pid: 1 }; }\n" +
            "export function resize(){}\n" +
            "export function exists(id){ return globalThis.__DW.ptys.has(id); }\n" +
            "export function onExit(){ return () => {}; }\n" +
            "export function dispose(){}\n",
          loader: "js",
        };
      }
      if (args.path === "shells") {
        return {
          contents:
            "export async function defaultShell(){ return { id: 'pwsh', label: 'pwsh', exe: 'pwsh', args: [], family: 'pwsh' }; }\n",
          loader: "js",
        };
      }
      if (args.path === "scheduler") {
        return {
          contents:
            init +
            "export async function listJobs(){ return globalThis.__DW.jobs ?? [{ id: 'loom-1', name: 'My Loom' }]; }\n" +
            "export async function getJob(id){ return (await listJobs()).find((j) => j.id === id); }\n",
          loader: "js",
        };
      }
      if (args.path === "run-store") {
        return {
          contents:
            init +
            "export async function getRun(id){ return globalThis.__DW.runs.get(id) ?? null; }\n" +
            "export async function listRuns(){ return [...globalThis.__DW.runs.values()]; }\n" +
            "export async function failWorkerAttempt(runId, attemptId, error){ globalThis.__DW.failed.push({ runId, attemptId, error }); const run = globalThis.__DW.runs.get(runId); if (run) run.status = 'failed'; return run; }\n" +
            "export async function relaunchDirectAttempt(runId, attemptId){ globalThis.__DW.relaunched.push({ runId, attemptId }); return 'attempt-fresh'; }\n" +
            "export async function settleRecoveredDirectAttempt(runId, attemptId){ globalThis.__DW.settled.push({ runId, attemptId }); }\n" +
            "export async function updateRunStatus(input){ globalThis.__DW.statusUpdates.push(input); const run = globalThis.__DW.runs.get(input.runId); if (run) run.status = input.status; return run; }\n",
          loader: "js",
        };
      }
      // event-log
      return {
        contents:
          init +
          "export async function appendEvent(e){ globalThis.__DW.events.push(e); return e; }\n" +
          "export function subscribeToEvents(h){ const D = globalThis.__DW; D.subs.add(h); return () => D.subs.delete(h); }\n",
        loader: "js",
      };
    });
  },
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spark-dw-"));
  const outfile = path.join(tmp, "direct-worker.bundle.cjs");
  await esbuild.build({
    entryPoints: [DIRECT_WORKER_TS],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    resolveExtensions: [".ts", ".js", ".cjs", ".mjs", ".json"],
    plugins: [harnessPlugin],
  });
  globalThis.__DW = {
    runs: new Map(),
    subs: new Set(),
    spawned: [],
    failed: [],
    relaunched: [],
    settled: [],
    statusUpdates: [],
    ptys: new Set(),
    events: [],
    spawnThrows: false,
  };
  const D = globalThis.__DW;
  const dw = require(outfile);

  let passed = 0;
  const ok = (name, cond) => {
    if (!cond) throw new Error(`FAIL: ${name}`);
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  const mkRun = (id, over = {}) => {
    const run = {
      id,
      workspaceId: "ws",
      title: `run ${id}`,
      status: "running",
      executionMode: "direct",
      automationId: "loom-1",
      humanMessages: [],
      steps: [{ id: "s1" }],
      workerTasks: [{ id: "t1", runtimePreference: "claude", modelHint: "claude-opus-4-8", effortHint: "high" }],
      workerAttempts: [],
      ...over,
    };
    D.runs.set(id, run);
    return run;
  };
  const fireEnvelope = async (runId, attemptId, payload = {}) => {
    for (const h of [...D.subs]) {
      h({ type: "worker_task.envelope_prepared", runId, attemptId, workerTaskId: "t1", workspaceId: "ws", payload });
    }
    await sleep(60);
  };

  // ── 1) spawn handler claims direct-run envelopes with the loom env ──
  {
    dw.installAutomationWorkerSpawnHandler();
    const run = mkRun("run-a");
    run.workerAttempts.push({ id: "att-a", workerTaskId: "t1", attemptNumber: 1, status: "prompt_ready", cwd: tmp });
    await fireEnvelope("run-a", "att-a", { executionMode: "direct", automationId: "loom-1" });
    const spawn = D.spawned.find((s) => s.id === "att-a");
    ok("direct envelope spawns a headless pty (webContents null)", spawn && spawn.webContents === null);
    ok(
      "worker env carries SPARK_RUN_ID + SPARK_AUTOMATION_ID + no-shell-integration",
      spawn.env.SPARK_RUN_ID === "run-a" &&
        spawn.env.SPARK_AUTOMATION_ID === "loom-1" &&
        spawn.env.SPARK_NO_SHELL_INTEGRATION === "1",
    );
    // Slice 7: a pre-graph task (no loomNodeId) omits SPARK_NODE_ID — parity.
    ok("pre-graph attempt (no node) omits SPARK_NODE_ID", spawn.env.SPARK_NODE_ID === undefined);
    ok(
      "spawn emits the automation.worker 'spawned' ping",
      D.events.some((e) => e.type === "automation.worker" && e.payload?.phase === "spawned"),
    );
  }

  // ── 1b) SLICE 7: a node-stamped attempt exports SPARK_NODE_ID ──
  {
    const run = mkRun("run-node", {
      workerTasks: [{ id: "tN", loomNodeId: "B", runtimePreference: "claude" }],
    });
    run.workerAttempts.push({ id: "att-n", workerTaskId: "tN", attemptNumber: 1, status: "prompt_ready", cwd: tmp });
    await fireEnvelope("run-node", "att-n", { executionMode: "direct", automationId: "loom-1" });
    const spawn = D.spawned.find((s) => s.id === "att-n");
    ok(
      "node-stamped attempt exports SPARK_NODE_ID for tool attribution",
      spawn && spawn.env.SPARK_NODE_ID === "B" && spawn.env.SPARK_RUN_ID === "run-node",
    );
  }

  // ── 2) managed-run envelopes are ignored ──
  {
    const before = D.spawned.length;
    mkRun("run-b", { executionMode: undefined, automationId: undefined });
    D.runs.get("run-b").workerAttempts.push({ id: "att-b", workerTaskId: "t1", attemptNumber: 1, status: "prompt_ready", cwd: tmp });
    await fireEnvelope("run-b", "att-b", {});
    ok("managed-run envelope is left for the renderer", D.spawned.length === before);
  }

  // ── 3) pty spawn failure fails the attempt fast (no 30s timeout) ──
  {
    D.spawnThrows = true;
    const run = mkRun("run-c");
    run.workerAttempts.push({ id: "att-c", workerTaskId: "t1", attemptNumber: 1, status: "prompt_ready", cwd: tmp });
    await fireEnvelope("run-c", "att-c", { executionMode: "direct", automationId: "loom-1" });
    D.spawnThrows = false;
    const failure = D.failed.find((f) => f.attemptId === "att-c");
    ok("pty spawn failure force-fails the attempt", failure && failure.error.startsWith("pty-spawn-failed"));
  }

  // ── 4) recovery decision table ──
  {
    D.runs.clear();
    D.failed.length = 0;
    D.relaunched.length = 0;
    D.settled.length = 0;
    D.statusUpdates.length = 0;

    // (a) report on disk → settle, never re-run.
    const reportPath = path.join(tmp, "final-report.json");
    fs.writeFileSync(reportPath, JSON.stringify({ status: "complete", summary: "done" }));
    mkRun("rec-report").workerAttempts.push({
      id: "att-r1", workerTaskId: "t1", attemptNumber: 1, status: "running", cwd: tmp, finalReportPath: reportPath,
    });
    // (b) first attempt, no report → one free relaunch.
    mkRun("rec-relaunch").workerAttempts.push({
      id: "att-r2", workerTaskId: "t1", attemptNumber: 1, status: "running", cwd: tmp,
      finalReportPath: path.join(tmp, "missing-1.json"),
    });
    // (c) second attempt, no report → fail.
    mkRun("rec-fail").workerAttempts.push({
      id: "att-r3", workerTaskId: "t1", attemptNumber: 2, status: "running", cwd: tmp,
      finalReportPath: path.join(tmp, "missing-2.json"),
    });
    // (d) attempt already terminal but the run never finalized → settle.
    mkRun("rec-settle").workerAttempts.push({
      id: "att-r4", workerTaskId: "t1", attemptNumber: 1, status: "succeeded", cwd: tmp,
    });
    // (e) no attempts at all → run failed.
    mkRun("rec-empty");
    // (f) paused runs are user-owned → untouched.
    mkRun("rec-paused", { status: "paused" }).workerAttempts.push({
      id: "att-r5", workerTaskId: "t1", attemptNumber: 1, status: "running", cwd: tmp,
    });
    // (g) terminal runs are done → untouched.
    mkRun("rec-done", { status: "complete" });

    // Relaunch is ownership-gated: the loom must still claim the run.
    D.jobs = [{ id: "loom-1", name: "My Loom", state: { currentRunId: "rec-relaunch" } }];
    await dw.recoverDirectRuns();

    ok("recovery settles a run whose report landed before quit", D.settled.some((s) => s.runId === "rec-report"));
    ok("recovery relaunches a first attempt with no report", D.relaunched.some((r) => r.runId === "rec-relaunch"));
    ok("recovery fails a second attempt with no report", D.failed.some((f) => f.runId === "rec-fail"));
    ok("recovery finalizes a terminal attempt the review missed", D.settled.some((s) => s.runId === "rec-settle"));
    ok("recovery fails a direct run with no attempts", D.statusUpdates.some((u) => u.runId === "rec-empty" && u.status === "failed"));
    ok(
      "recovery leaves paused + terminal runs untouched",
      !D.settled.some((s) => s.runId === "rec-paused" || s.runId === "rec-done") &&
        !D.failed.some((f) => f.runId === "rec-paused" || f.runId === "rec-done") &&
        !D.relaunched.some((r) => r.runId === "rec-paused" || r.runId === "rec-done"),
    );
  }

  // ── 4b) blocked-run recovery splits by what blocked the run ──
  {
    D.runs.clear();
    D.failed.length = 0;
    D.relaunched.length = 0;
    D.settled.length = 0;
    D.statusUpdates.length = 0;

    // (h) report-blocked: the worker EXITED declaring blocked (attempt is
    // terminal) — the question is still answerable; recovery leaves it for
    // the loop driver's answer seam (resumeLoops re-attaches it).
    mkRun("rec-ask-done", { status: "blocked" }).workerAttempts.push({
      id: "att-b1", workerTaskId: "t1", attemptNumber: 1, status: "succeeded", cwd: tmp,
    });
    // (i) ask-blocked: the worker died MID-question (attempt still active,
    // its pty gone with the old process) — nobody can ever consume the
    // answer, so recovery unblocks the run and applies the normal table
    // (attempt 1, no report → relaunch).
    mkRun("rec-ask-dead", { status: "blocked" }).workerAttempts.push({
      id: "att-b2", workerTaskId: "t1", attemptNumber: 1, status: "running", cwd: tmp,
      finalReportPath: path.join(tmp, "missing-ask.json"),
    });
    D.jobs = [{ id: "loom-1", name: "My Loom", state: { currentRunId: "rec-ask-dead" } }];

    await dw.recoverDirectRuns();

    ok(
      "report-blocked run is left untouched (answer seam owns it)",
      !D.settled.some((s) => s.runId === "rec-ask-done") &&
        !D.failed.some((f) => f.runId === "rec-ask-done") &&
        !D.relaunched.some((r) => r.runId === "rec-ask-done") &&
        !D.statusUpdates.some((u) => u.runId === "rec-ask-done"),
    );
    ok(
      "dead mid-ask worker is unblocked then relaunched",
      D.statusUpdates.some((u) => u.runId === "rec-ask-dead" && u.status === "running") &&
        D.relaunched.some((r) => r.runId === "rec-ask-dead"),
    );
  }

  // ── 4c) relaunch never spends on a loom that no longer claims the run ──
  {
    D.runs.clear();
    D.failed.length = 0;
    D.relaunched.length = 0;
    D.statusUpdates.length = 0;
    mkRun("rec-unclaimed").workerAttempts.push({
      id: "att-u1", workerTaskId: "t1", attemptNumber: 1, status: "running", cwd: tmp,
      finalReportPath: path.join(tmp, "missing-unclaimed.json"),
    });
    D.jobs = [{ id: "loom-1", name: "My Loom", state: { currentRunId: "some-other-run" } }];

    await dw.recoverDirectRuns();

    ok(
      "recovery fails (never relaunches) a run its loom no longer claims",
      !D.relaunched.some((r) => r.runId === "rec-unclaimed") &&
        D.failed.some((f) => f.runId === "rec-unclaimed" && f.error.includes("no longer claims")),
    );
    D.jobs = undefined; // restore the default stub set for the inventory join
  }

  // ── 4d) partial wave: TWO non-terminal attempts decided independently ──
  // Looms parallel fan-out can strand several siblings unmerged/non-terminal at
  // once. Recovery now iterates ALL non-terminal attempts per run: one with a
  // report on disk settles; the other (attempt 1, no report, claimed) relaunches.
  {
    D.runs.clear();
    D.failed.length = 0;
    D.relaunched.length = 0;
    D.settled.length = 0;
    D.statusUpdates.length = 0;

    const reportPath = path.join(tmp, "wave-report.json");
    fs.writeFileSync(reportPath, JSON.stringify({ status: "complete", summary: "node A done" }));
    const run = mkRun("rec-wave", {
      // two graph nodes → two tasks, one attempt each (a parallel wave).
      workerTasks: [
        { id: "tA", loomNodeId: "A", runtimePreference: "claude" },
        { id: "tB", loomNodeId: "B", runtimePreference: "claude" },
      ],
    });
    run.workerAttempts.push(
      // node A: report landed before quit → settle.
      { id: "att-wA", workerTaskId: "tA", attemptNumber: 1, status: "running", cwd: tmp, finalReportPath: reportPath },
      // node B: first attempt, no report → relaunch (run is claimed).
      { id: "att-wB", workerTaskId: "tB", attemptNumber: 1, status: "running", cwd: tmp, finalReportPath: path.join(tmp, "missing-wave-B.json") },
    );
    D.jobs = [{ id: "loom-1", name: "My Loom", state: { currentRunId: "rec-wave" } }];

    await dw.recoverDirectRuns();

    ok("partial wave: the attempt with a report settles", D.settled.some((s) => s.runId === "rec-wave" && s.attemptId === "att-wA"));
    ok("partial wave: the reportless first attempt relaunches", D.relaunched.some((r) => r.runId === "rec-wave" && r.attemptId === "att-wB"));
    ok("partial wave: neither sibling is failed (conservative, no double-launch)", !D.failed.some((f) => f.runId === "rec-wave"));
    D.jobs = undefined; // restore the default stub set for the inventory join
  }

  // ── 5) live inventory joins run + task + loom name ──
  {
    D.runs.clear();
    const run = mkRun("inv-1", { status: "blocked" });
    run.humanMessages.push({ id: "m1", author: "spark", kind: "question", message: "Which file?", createdAt: new Date().toISOString() });
    run.workerAttempts.push({ id: "att-i1", workerTaskId: "t1", attemptNumber: 1, status: "running", cwd: tmp, startedAt: new Date().toISOString() });
    mkRun("inv-skip", { status: "complete" }); // terminal: excluded

    const list = await dw.listActiveAutomationWorkers();
    ok("inventory lists only live direct runs", list.length === 1 && list[0].runId === "inv-1");
    const w = list[0];
    ok(
      "inventory joins engine/model/effort from the task + name from the loom",
      w.engine === "claude" && w.model === "claude-opus-4-8" && w.effort === "high" && w.automationName === "My Loom",
    );
    ok("inventory surfaces the blocked question", w.blocked === true && w.question === "Which file?");
    ok("inventory attemptId doubles as the pty session id", w.attemptId === "att-i1");
  }

  // ── 6) SLICE 7: an N-attempt parallel wave shows N workers, each with its ───
  //        own nodeId/nodeLabel; iteration comes from the loom pass counter. ────
  {
    D.runs.clear();
    // Owning loom carries a 2-node graph (with labels) + a pass counter.
    D.jobs = [
      {
        id: "loom-1",
        name: "My Loom",
        state: { iteration: 3, currentRunId: "wave-run" },
        graph: {
          version: 1,
          nodes: [
            { id: "A", kind: "worker", label: "Builder", worker: { engine: "claude" }, prompt: "" },
            { id: "B", kind: "worker", label: "Tester", worker: { engine: "codex" }, prompt: "" },
          ],
          edges: [],
          entryNodeIds: ["A", "B"],
        },
      },
    ];
    const run = mkRun("wave-run", {
      workerTasks: [
        { id: "tA", loomNodeId: "A", runtimePreference: "claude", modelHint: "claude-opus-4-8", effortHint: "high" },
        { id: "tB", loomNodeId: "B", runtimePreference: "codex", modelHint: "gpt-5.5", effortHint: "medium" },
      ],
      steps: [{ id: "s1" }, { id: "s2" }, { id: "s3" }], // multi-wave: steps.length over-counts
    });
    run.workerAttempts.push(
      { id: "att-wA", workerTaskId: "tA", attemptNumber: 1, status: "running", cwd: tmp, startedAt: new Date().toISOString() },
      { id: "att-wB", workerTaskId: "tB", attemptNumber: 1, status: "running", cwd: tmp, startedAt: new Date().toISOString() },
    );

    const list = await dw.listActiveAutomationWorkers();
    ok("N-attempt wave lists N distinct workers", list.length === 2 && list.every((x) => x.runId === "wave-run"));
    const byNode = Object.fromEntries(list.map((x) => [x.nodeId, x]));
    ok(
      "each worker carries its graph nodeId + nodeLabel",
      byNode.A && byNode.A.nodeLabel === "Builder" && byNode.B && byNode.B.nodeLabel === "Tester",
    );
    ok(
      "each worker's attemptId/engine/model come from its own node task",
      byNode.A.attemptId === "att-wA" && byNode.A.engine === "claude" && byNode.A.model === "claude-opus-4-8" &&
        byNode.B.attemptId === "att-wB" && byNode.B.engine === "codex" && byNode.B.model === "gpt-5.5",
    );
    ok(
      "iteration is derived from the loom pass counter (NOT steps.length-1)",
      byNode.A.iteration === 2 && byNode.B.iteration === 2,
    );

    // A single-node run still yields exactly ONE worker entry (parity).
    const solo = mkRun("solo-run", {
      workerTasks: [{ id: "t1", loomNodeId: "w0", runtimePreference: "claude" }],
    });
    solo.workerAttempts.push({ id: "att-solo", workerTaskId: "t1", attemptNumber: 1, status: "running", cwd: tmp });
    const list2 = await dw.listActiveAutomationWorkers();
    const soloEntries = list2.filter((x) => x.runId === "solo-run");
    ok("single-node run still shows exactly one worker (parity)", soloEntries.length === 1 && soloEntries[0].nodeId === "w0");
    D.jobs = undefined;
  }

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  console.log(`\nAll ${passed} direct-worker checks PASSED.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\nDIRECT-WORKER TEST FAILED:\n", err);
    process.exit(1);
  },
);
