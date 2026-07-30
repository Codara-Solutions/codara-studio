// Runtime test for the automation LOOP DRIVER (src/main/orchestration/
// automation-loop.ts) — the engine behind "Looms": trigger + loop automations,
// including agent-driven loops. Mirrors scripts/test-automations.cjs: esbuild
// bundles the REAL scheduler.ts + automation-loop.ts and stubs run-store /
// event-log / spark-home / fs-atomic so we can drive iterations deterministically
// and assert the SAFETY properties (caps always win, agent loops escapable,
// blocked holds, pause/stop work, state persists).
//
//   node scripts/test-automation-loop.cjs
//
// Completion is driven by the test: each launched run HOLDS until the test calls
// completeRun(runId, {...}), which sets the stubbed run + fires the event the
// driver's watcher is listening for. Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const ORCH_DIR = path.join(ROOT, "src", "main", "orchestration");
const SCHEDULER_TS = path.join(ORCH_DIR, "scheduler.ts");
const AUTOMATION_LOOP_TS = path.join(ORCH_DIR, "automation-loop.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const harnessPlugin = {
  name: "automation-loop-test-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve(
      { filter: /^(\.\/(run-queue|run-store|event-log)|\.\.\/(spark-home|fs-atomic|agent-runtimes|pty-manager|notify))$/ },
      (args) => ({ path: args.path.replace(/^\.\.?\//, ""), namespace: "stub" }),
    );
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      const init =
        "globalThis.__LOOP ??= { runs: new Map(), subs: new Set(), launches: [], pending: [], seq: 0, runtimes: null };\n";
      if (args.path === "spark-home") {
        return {
          contents:
            "export function sparkHome(){ return process.env.SPARK_HOME_DIR || require('node:os').tmpdir(); }\nexport function ensureSparkHomeSync(){}\n",
          loader: "js",
        };
      }
      if (args.path === "fs-atomic") {
        return {
          contents: "const fs = require('node:fs');\nexport async function writeFileAtomic(p, c){ fs.writeFileSync(p, c); }\n",
          loader: "js",
        };
      }
      if (args.path === "notify") {
        // Unified notify pipeline: record publishes/rearms for assertions.
        return {
          contents:
            "globalThis.__NOTIFY ??= { published: [], rearms: [] };\n" +
            "export const automationSourceKey = (id) => `automation:${id}`;\n" +
            "export function publish(e){ globalThis.__NOTIFY.published.push(e); }\n" +
            "export function rearm(k){ globalThis.__NOTIFY.rearms.push(k); }\n",
          loader: "js",
        };
      }
      if (args.path === "run-queue") {
        return {
          contents: "export async function enqueue(){ return { id: 'q' }; }\nexport async function burnDown(){ return {}; }\n",
          loader: "js",
        };
      }
      if (args.path === "agent-runtimes") {
        // Configurable installed-runtimes set: tests assign L.runtimes.
        return {
          contents:
            init +
            "export async function detectAgentRuntimes(){ const L = globalThis.__LOOP; return L.runtimes ?? [ { kind: 'claude', installed: true, disabledBySettings: false, models: [{ id: 'claude-opus-4-8' }, { id: 'claude-sonnet-4-6' }] }, { kind: 'codex', installed: true, disabledBySettings: false, models: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-terra' }, { id: 'gpt-5.6-luna' }] } ]; }\n",
          loader: "js",
        };
      }
      if (args.path === "pty-manager") {
        return {
          contents:
            init +
            // exists() is true for attempt ids the test marked alive (L.ptyAlive);
            // killImmediate counts kills + drops the id from the alive set.
            "export function exists(id){ const L = globalThis.__LOOP; return Boolean(L.ptyAlive && L.ptyAlive.has(id)); }\nexport function killImmediate(id){ const L = globalThis.__LOOP; L.ptyKills = (L.ptyKills||0)+1; if (L.ptyAlive) L.ptyAlive.delete(id); }\nexport function dispose(){}\n",
          loader: "js",
        };
      }
      if (args.path === "run-store") {
        return {
          contents:
            init +
            // Looms v2: the loop driver launches DIRECT worker runs. Each one
            // HOLDS until the test calls completeRun(). The launch record
            // captures the resolved engine/model/effort for assertions.
            "export async function startDirectWorkerRun(input){ const L = globalThis.__LOOP; const id = 'run-' + (++L.seq); const run = { id, status: 'running', executionMode: 'direct', humanMessages: [], workerAttempts: [], totalCostUsd: 0, estimatedWorkerCostUsd: 0 }; L.runs.set(id, run); L.launches.push({ kind: 'start', id, note: input.prompt, model: input.model, effort: input.effort, automationId: input.automationId, title: input.title, nodes: input.nodes, freshPass: input.freshPass }); L.pending.push(id); return run; }\n" +
            // Same-run chain: a fresh task on the existing run (back to non-terminal).
            // Append a fresh LIVE attempt for the chained node (reusing the node's
            // existing task when present so newestAttemptForNode picks it up) and flip
            // the node's loomPass state to running — mirroring run-store's real
            // launchDirectNodeTasks so the per-node answer-resume + watchdog seams see
            // a coherent attempt set (the resumed node is no longer a blocked candidate).
            "export async function addDirectIteration(input){ const L = globalThis.__LOOP; const run = L.runs.get(input.runId) || { id: input.runId, humanMessages: [], workerAttempts: [], workerTasks: [] }; run.status = 'running'; run.workerTasks = run.workerTasks || []; const node = input.loomNodeId || 'w0'; let task = run.workerTasks.find((t) => t.loomNodeId === node); if (!task) { task = { id: 't-' + node, loomNodeId: node }; run.workerTasks.push(task); } const aid = 'att-c' + (run.workerAttempts.length + 1); run.workerAttempts = [...(run.workerAttempts||[]), { id: aid, workerTaskId: task.id, status: 'running' }]; if (run.loomPass && run.loomPass.nodeStates[node]) { run.loomPass.nodeStates[node] = { ...run.loomPass.nodeStates[node], status: 'running', attemptIds: [...(run.loomPass.nodeStates[node].attemptIds||[]), aid] }; } L.runs.set(run.id, run); L.launches.push({ kind: 'chain', id: run.id, note: input.prompt, model: input.model, effort: input.effort, clientMessageId: input.clientMessageId, loomNodeId: input.loomNodeId, access: input.access, blockedTools: input.blockedTools, nodes: input.nodes, freshPass: input.freshPass }); L.pending.push(run.id); return run; }\n" +
            // Per-attempt force-fail: mark ONLY the named attempt failed (slice 7).
            // The run terminalizes (status=failed) only when NO live attempt remains —
            // mirroring finalizeDirectRun's wave join: a hung sibling failing while
            // another is still live must not fail the whole run.
            "export async function failWorkerAttempt(runId, attemptId, error){ const L = globalThis.__LOOP; L.failedAttempts = (L.failedAttempts||0)+1; (L.failedAttemptIds ??= []).push(attemptId); const run = L.runs.get(runId); if (run) { const a = (run.workerAttempts||[]).find((x) => x.id === attemptId); if (a) { a.status = 'failed'; a.error = error; } const live = (run.workerAttempts||[]).some((x) => !['succeeded','failed','timed_out','cancelled'].includes(x.status)); if (!live) run.status = 'failed'; } return run; }\n" +
            // newestAttemptForNode (slice 7): newest attempt of the task carrying nodeId.
            "export function newestAttemptForNode(run, nodeId){ const taskIds = new Set((run.workerTasks||[]).filter((t) => t.loomNodeId === nodeId).map((t) => t.id)); if (taskIds.size === 0) return (run.workerAttempts||[]).at(-1); for (let i = (run.workerAttempts||[]).length - 1; i >= 0; i -= 1) { if (taskIds.has(run.workerAttempts[i].workerTaskId)) return run.workerAttempts[i]; } return undefined; }\n" +
            "export async function getRun(id){ return globalThis.__LOOP.runs.get(id) ?? null; }\n" +
            "export async function forcePauseRun(id){ const L = globalThis.__LOOP; const run = L.runs.get(id); if (run) run.status = 'cancelled'; L.forcePaused = (L.forcePaused||0)+1; return run; }\n",
          loader: "js",
        };
      }
      // event-log: appendEvent records; subscribeToEvents registers a handler the
      // test fires via completeRun.
      return {
        contents:
          init +
          "export async function appendEvent(e){ const L = globalThis.__LOOP; (L.events ??= []).push(e); return e; }\n" +
          "export function subscribeToEvents(h){ const L = globalThis.__LOOP; L.subs.add(h); return () => L.subs.delete(h); }\n",
        loader: "js",
      };
    });
  },
};

async function main() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "spark-loop-home-"));
  process.env.SPARK_HOME_DIR = tmpHome;
  const outfile = path.join(tmpHome, "scheduler.bundle.cjs");
  // Combined entry: re-export the scheduler's public API (everything the
  // existing checks drive) PLUS automation-loop's fireWatchdog test seam (slice
  // 7). Both modules end up in ONE bundle (automation-loop is also reachable via
  // scheduler's dynamic imports), so they share module state. Absolute import
  // specifiers so esbuild resolves them regardless of the tmp entry's location;
  // the modules' OWN relative imports (./scheduler, ./run-store, …) still hit the
  // stub plugin.
  const entryFile = path.join(tmpHome, "loop-test-entry.ts");
  fs.writeFileSync(
    entryFile,
    `export * from ${JSON.stringify(SCHEDULER_TS)};\n` +
      `export { fireWatchdog } from ${JSON.stringify(AUTOMATION_LOOP_TS)};\n`,
  );
  await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    resolveExtensions: [".ts", ".js", ".cjs", ".mjs", ".json"],
    plugins: [harnessPlugin],
  });
  const sched = require(outfile);
  // Pre-seed the shared test state (the stub modules `??=` it, so they adopt
  // this object once they're lazily imported by the loop driver).
  globalThis.__LOOP = { runs: new Map(), subs: new Set(), launches: [], pending: [], seq: 0, runtimes: null };
  const L = globalThis.__LOOP;

  const baseInput = { workspaceId: "ws", workspaceName: "test", cwd: tmpHome };
  let passed = 0;
  const ok = (name, cond) => {
    if (!cond) throw new Error(`FAIL: ${name}`);
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  // Fire the watcher's completion event for a run, after setting its terminal
  // status / summary / cost. Waits a beat first so the async watcher
  // subscription (await import) is registered.
  const completeRun = async (
    runId,
    { status = "complete", summary, cost = 0, measuredWorkerCost = 0, estimatedWorkerCost = 0 } = {},
  ) => {
    await sleep(40);
    const run = L.runs.get(runId);
    if (!run) throw new Error(`completeRun: unknown run ${runId}`);
    run.status = status;
    run.totalCostUsd = cost;
    run.measuredWorkerCostUsd = measuredWorkerCost;
    run.estimatedWorkerCostUsd = estimatedWorkerCost;
    if (summary !== undefined) run.humanMessages = [{ author: "spark", kind: "note", message: summary, createdAt: new Date().toISOString() }];
    for (const h of [...L.subs]) h({ runId });
    await sleep(40);
  };

  // Fire an event for a run WITHOUT making it terminal (e.g. it left "blocked"
  // back to "running"). Used to test the stale-blocked-status reset.
  const fireRunStatus = async (runId, status) => {
    await sleep(40);
    const run = L.runs.get(runId);
    if (run) run.status = status;
    for (const h of [...L.subs]) h({ runId });
    await sleep(40);
  };

  const nextPending = () => L.pending[L.pending.length - 1];
  const getState = async (id) => (await sched.getJob(id))?.state;

  // ── 0) folder automations create their watch directory before arming ──
  {
    const watchPath = path.join(tmpHome, "new-input-folder");
    ok("folder trigger starts absent", !fs.existsSync(watchPath));
    await sched.createJob({
      name: "folder setup",
      trigger: { kind: "folder", path: watchPath, events: ["add", "change"] },
      loop: { kind: "once", stop: {} },
      input: baseInput,
      prompt: { template: "process {{firedPath}}" },
    });
    ok("folder trigger creates its watch directory", fs.statSync(watchPath).isDirectory());
  }

  // ── 1) count loop runs EXACTLY n iterations, then stops (max-iterations) ──
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const job = await sched.createJob({
      name: "count3",
      trigger: { kind: "manual" },
      loop: { kind: "count", stop: { maxIterations: 3 }, isolate: true },
      input: baseInput,
      prompt: { template: "iter {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    // Drive 3 completions; each completion (if continuing) launches the next.
    for (let i = 0; i < 4; i += 1) {
      const rid = nextPending();
      if (!rid) break;
      L.pending.length = 0;
      await completeRun(rid, { summary: `done ${i}` });
    }
    const st = await getState(job.id);
    ok("count loop ran exactly 3 iterations", st.iteration === 3);
    ok("count loop stopped with max-iterations", st.status === "stopped" && st.lastStopReason === "max-iterations");
  }

  // ── 2) agent loop: continues on CONTINUE, stops on DONE ──
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const job = await sched.createJob({
      name: "agent",
      trigger: { kind: "manual" },
      loop: { kind: "agent", stop: { maxIterations: 10 }, isolate: true },
      input: baseInput,
      prompt: { template: "work {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    // iter 0 -> CONTINUE
    let rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "made progress\nSPARK_LOOP_CONTINUE" });
    let st = await getState(job.id);
    ok("agent loop continued on SPARK_LOOP_CONTINUE", st.status === "running" && st.iteration === 2);
    // iter 1 -> DONE
    rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "all set\nSPARK_LOOP_DONE" });
    st = await getState(job.id);
    ok("agent loop stopped on SPARK_LOOP_DONE", st.status === "stopped" && st.lastStopReason === "agent-done");
  }

  // ── 3) agent loop ALWAYS stops at the hard cap even with no DONE signal ──
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const job = await sched.createJob({
      name: "runaway",
      trigger: { kind: "manual" },
      loop: { kind: "agent", stop: { maxIterations: 4 }, isolate: true },
      input: baseInput,
      prompt: { template: "go {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    for (let i = 0; i < 8; i += 1) {
      const rid = nextPending();
      if (!rid) break;
      L.pending.length = 0;
      await completeRun(rid, { summary: "more work\nSPARK_LOOP_CONTINUE" }); // never says done
    }
    const st = await getState(job.id);
    ok("agent loop never exceeds the hard cap", st.iteration === 4);
    ok("agent loop force-stopped at max-iterations", st.status === "stopped" && st.lastStopReason === "max-iterations");
  }

  // ── 4) budget cap halts the loop ──
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const job = await sched.createJob({
      name: "budget",
      trigger: { kind: "manual" },
      loop: { kind: "continuous", stop: { budgetUsd: 1.0, maxIterations: 100 }, isolate: true },
      input: baseInput,
      prompt: { template: "spend {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    // Each isolate iteration "costs" $0.6 -> crosses $1.0 after the 2nd.
    for (let i = 0; i < 5; i += 1) {
      const rid = nextPending();
      if (!rid) break;
      L.pending.length = 0;
      await completeRun(rid, { summary: `pass ${i}`, cost: 0.6 });
    }
    const st = await getState(job.id);
    ok("budget cap halted the loop", st.status === "stopped" && st.lastStopReason === "budget");
    ok("budget halt counted both cost fields (spent >= cap)", (st.spentUsd ?? 0) >= 1.0);
  }

  // ── 4b) measured vs estimated spend are tallied apart per pass ──
  // The remote payload's honesty contract rides on this split: spentUsd /
  // costUsd on the wire may only carry MEASURED spend (metered manager calls +
  // worker attempts whose transport reported real cost), while the placeholder
  // estimate travels in estimated* fields. The combined figure still feeds the
  // budget cap.
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const job = await sched.createJob({
      name: "split",
      trigger: { kind: "manual" },
      loop: { kind: "count", stop: { maxIterations: 2 }, isolate: true },
      input: baseInput,
      prompt: { template: "split {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    // Pass 0: $0.10 metered manager + $0.25 measured worker + $0.40 estimate-only.
    let rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, {
      summary: "pass 0",
      cost: 0.1,
      measuredWorkerCost: 0.25,
      estimatedWorkerCost: 0.4,
    });
    // Pass 1: estimate only, no measured spend at all.
    rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "pass 1", estimatedWorkerCost: 0.5 });
    const fresh = await sched.getJob(job.id);
    const [rec0, rec1] = fresh.history.slice(-2);
    ok("pass record keeps the combined figure for the budget cap", Math.abs(rec0.costUsd - 0.75) < 1e-9);
    ok("pass record tallies the measured portion apart", Math.abs(rec0.measuredCostUsd - 0.35) < 1e-9);
    ok(
      "an estimate-only pass records no measured figure",
      Math.abs(rec1.costUsd - 0.5) < 1e-9 && rec1.measuredCostUsd === undefined,
    );
    ok(
      "state splits measuredSpentUsd from the combined spentUsd",
      Math.abs(fresh.state.spentUsd - 1.25) < 1e-9 &&
        Math.abs(fresh.state.measuredSpentUsd - 0.35) < 1e-9,
    );
  }

  // ── 5) blocked iteration HOLDS the loop (no advance until it completes) ──
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const job = await sched.createJob({
      name: "blocked",
      trigger: { kind: "manual" },
      loop: { kind: "count", stop: { maxIterations: 3 }, isolate: true },
      input: baseInput,
      prompt: { template: "ask {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    const rid = nextPending();
    const launchesBefore = L.launches.length;
    // Blocked event: must NOT advance.
    await completeRun(rid, { status: "blocked", summary: "need input" });
    let st = await getState(job.id);
    ok("blocked iteration sets status=blocked", st.status === "blocked");
    ok("blocked iteration does not launch the next pass", L.launches.length === launchesBefore);
    // Now it completes -> loop advances.
    L.pending.length = 0;
    await completeRun(rid, { status: "complete", summary: "answered" });
    st = await getState(job.id);
    ok("loop advances after the blocked run completes", st.iteration === 2);
  }

  // ── 6) pause stops advancing; stop force-pauses the live run ──
  {
    L.launches.length = 0;
    L.pending.length = 0;
    L.forcePaused = 0;
    const job = await sched.createJob({
      name: "pausable",
      trigger: { kind: "manual" },
      loop: { kind: "continuous", stop: { maxIterations: 50 }, isolate: true },
      input: baseInput,
      prompt: { template: "loop {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    let rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "one" }); // -> launches iter 1
    rid = nextPending();
    await sched.pauseJob(job.id);
    let st = await getState(job.id);
    ok("pauseJob sets status=paused", st.status === "paused");
    const launchesAtPause = L.launches.length;
    // Completing the in-flight run while paused must NOT launch another.
    L.pending.length = 0;
    await completeRun(rid, { summary: "two" });
    ok("paused loop does not advance on completion", L.launches.length === launchesAtPause);

    // stopJob force-pauses the live run + finalizes.
    await sched.resumeJob(job.id);
    await sched.runJobNow(job.id);
    rid = nextPending();
    await sched.stopJob(job.id);
    st = await getState(job.id);
    ok("stopJob finalizes (user-stop)", st.status === "stopped" && st.lastStopReason === "user-stop");
    ok("stopJob force-paused the live run", (L.forcePaused ?? 0) >= 1);
  }

  // ── 7) state + history persist to scheduler.json; legacy job normalizes ──
  {
    const job = await sched.createJob({
      name: "persisted",
      trigger: { kind: "manual" },
      loop: { kind: "count", stop: { maxIterations: 2 }, isolate: true },
      input: baseInput,
      prompt: { template: "p {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    const rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "first" });
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpHome, "scheduler.json"), "utf8"));
    const persisted = onDisk.jobs.find((j) => j.id === job.id);
    ok("loop + state + history persisted to disk", Boolean(persisted.loop && persisted.state && Array.isArray(persisted.history) && persisted.history.length >= 1));

    // Legacy jobs (no loop/state/history/worker) backfill on read — including
    // the Looms-on-Pi worker migration: the removed API backend (a persisted
    // "openrouter" chatBackend from an older install) lands on the default Pi
    // worker; claude carries model/effort onto the worker config.
    const legacy = { id: "legacy-1", name: "old", trigger: { kind: "manual" }, enabled: true, input: baseInput, createdAt: new Date().toISOString() };
    const legacyOpenrouter = { id: "legacy-or", name: "or", trigger: { kind: "manual" }, enabled: true, input: { ...baseInput, chatBackend: "openrouter", chatModel: "x-ai/grok-4.3" }, createdAt: new Date().toISOString() };
    const legacyClaude = { id: "legacy-cc", name: "cc", trigger: { kind: "manual" }, enabled: true, input: { ...baseInput, chatBackend: "claude", chatModel: "claude-opus-4-8", chatEffort: "high" }, createdAt: new Date().toISOString() };
    onDisk.jobs.push(legacy, legacyOpenrouter, legacyClaude);
    fs.writeFileSync(path.join(tmpHome, "scheduler.json"), JSON.stringify(onDisk, null, 2));
    // Force a fresh read by mutating through the API (createJob reloads cache on
    // next process; here we re-require a fresh bundle to clear the module cache).
    delete require.cache[require.resolve(outfile)];
    const sched2 = require(outfile);
    const jobs2 = await sched2.listJobs();
    const reloaded = jobs2.find((j) => j.id === "legacy-1");
    ok(
      "legacy job backfills loop/state/history on read",
      reloaded && reloaded.loop?.kind === "once" && reloaded.state?.status === "idle" && Array.isArray(reloaded.history),
    );
    const or = jobs2.find((j) => j.id === "legacy-or");
    ok(
      "legacy removed-API-backend loom migrates to the default Pi worker (API model dropped)",
      or && or.worker?.engine === undefined && or.worker?.model === "claude-opus-5" && or.worker?.effort === "medium",
    );
    const cc = jobs2.find((j) => j.id === "legacy-cc");
    ok(
      "legacy claude loom carries model+effort onto the worker config (engine dropped)",
      cc && cc.worker?.engine === undefined && cc.worker?.model === "claude-opus-4-8" && cc.worker?.effort === "high",
    );
  }

  // ── 8) resume RE-DRIVES a paused loop (regression for the review's HIGH) ──
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const job = await sched.createJob({
      name: "resumable",
      trigger: { kind: "manual" },
      loop: { kind: "continuous", stop: { maxIterations: 50 }, isolate: true },
      input: baseInput,
      prompt: { template: "go {{iteration}}" },
    });
    await sched.runJobNow(job.id); // launch R1
    let rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "1" }); // -> launch R2
    rid = nextPending(); // R2, in-flight
    await sched.pauseJob(job.id);
    const launchesAtPause = L.launches.length;
    L.pending.length = 0;
    await completeRun(rid, { summary: "2" }); // completes WHILE paused -> must NOT advance
    ok("paused loop does not advance while paused", L.launches.length === launchesAtPause);
    // Resume ALONE (no runJobNow) must re-drive the loop.
    await sched.resumeJob(job.id);
    await sleep(80);
    const st = await getState(job.id);
    ok("resume re-drives a paused loop", L.launches.length > launchesAtPause && st.status === "running");
  }

  // ── 9) blocked status RESETS when the run leaves blocked (non-terminal) ──
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const job = await sched.createJob({
      name: "unblock",
      trigger: { kind: "manual" },
      loop: { kind: "count", stop: { maxIterations: 3 }, isolate: true },
      input: baseInput,
      prompt: { template: "q {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    const rid = nextPending();
    await completeRun(rid, { status: "blocked", summary: "need input" });
    let st = await getState(job.id);
    ok("status is blocked while the run is blocked", st.status === "blocked");
    await fireRunStatus(rid, "running"); // user answered -> run resumes, still non-terminal
    st = await getState(job.id);
    ok("blocked status resets to running once the run resumes", st.status === "running");
  }

  // ── 10) until loom with NO predicate/cap still stops at the default cap ──
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const job = await sched.createJob({
      name: "unbounded-until",
      trigger: { kind: "manual" },
      loop: { kind: "until", stop: {}, isolate: true }, // no predicate, no cap
      input: baseInput,
      prompt: { template: "u {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    for (let i = 0; i < 30; i += 1) {
      const rid = nextPending();
      if (!rid) break;
      L.pending.length = 0;
      const st = await getState(job.id);
      if (st.status === "stopped") break;
      await completeRun(rid, { summary: `pass ${i}` });
    }
    const st = await getState(job.id);
    ok("blank until loom is NOT unbounded (stops at the default cap)", st.status === "stopped" && st.iteration === 20);
  }

  // ── 11) direct launch: every iteration is a DIRECT worker run ──
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const job = await sched.createJob({
      name: "direct",
      trigger: { kind: "manual" },
      loop: { kind: "once", stop: {}, isolate: true },
      input: baseInput,
      prompt: { template: "do the thing {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    const launch = L.launches[L.launches.length - 1];
    ok("iteration launches a direct worker run (no autopilot)", launch?.kind === "start");
    ok("direct launch carries automationId + rendered prompt", launch.automationId === job.id && launch.note.includes("do the thing 0"));
    ok("a loom with no pinned worker launches on the default Pi model", launch.engine === undefined && launch.model === "claude-opus-5");
    const rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "done" });
  }

  // ── 12) same-run chaining uses addDirectIteration with the dedupe id ──
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const job = await sched.createJob({
      name: "chained",
      trigger: { kind: "manual" },
      loop: { kind: "count", stop: { maxIterations: 2 }, isolate: false }, // same-run
      input: baseInput,
      prompt: { template: "chain {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    const rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "first" });
    const second = L.launches[L.launches.length - 1];
    ok("pass 2 chains in the SAME run via addDirectIteration", second?.kind === "chain" && second.id === rid);
    ok("chained pass carries the loop clientMessageId", second.clientMessageId === `loop-${job.id}-1`);
    L.pending.length = 0;
    await completeRun(rid, { summary: "second" });
  }

  // ── 13) pinned model carried (gpt ids normalized); unknown ids pass through ──
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const job = await sched.createJob({
      name: "pinned",
      trigger: { kind: "manual" },
      loop: { kind: "once", stop: {}, isolate: true },
      input: baseInput,
      prompt: { template: "p" },
      worker: { engine: "codex", model: "gpt-5.5", effort: "high" },
    });
    await sched.runJobNow(job.id);
    const launch = L.launches[L.launches.length - 1];
    ok("legacy pinned Codex model migrates to GPT-5.6 Sol", launch.engine === undefined && launch.model === "gpt-5.6-sol" && launch.effort === "high");
    let rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "ok" });

    const bogus = await sched.createJob({
      name: "bogus-model",
      trigger: { kind: "manual" },
      loop: { kind: "once", stop: {}, isolate: true },
      input: baseInput,
      prompt: { template: "b" },
      worker: { engine: "claude", model: "claude-9000-ultra" },
    });
    await sched.runJobNow(bogus.id);
    const launch2 = L.launches[L.launches.length - 1];
    ok("an unknown claude-* model id passes through verbatim (Pi decides)", launch2.engine === undefined && launch2.model === "claude-9000-ultra");
    rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "ok" });
  }

  // ── 14) no CLI install gating: Pi is bundled, so a loom launches even when ──
  //        no claude/codex CLI is installed on the machine. ──────────────────
  {
    L.launches.length = 0;
    L.pending.length = 0;
    L.runtimes = [
      { kind: "claude", installed: false, disabledBySettings: false, models: [] },
      { kind: "codex", installed: false, disabledBySettings: false, models: [] },
    ];
    const job = await sched.createJob({
      name: "no-clis",
      trigger: { kind: "manual" },
      loop: { kind: "once", stop: {}, isolate: true },
      input: baseInput,
      prompt: { template: "x" },
    });
    await sched.runJobNow(job.id);
    const launch = L.launches[L.launches.length - 1];
    ok(
      "a loom launches on the bundled Pi runtime with zero CLIs installed",
      launch?.kind === "start" && launch.model === "claude-opus-5",
    );
    const rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "ok" });
    L.runtimes = null; // restore the default stub set
  }

  // ── 15) agent handoff: nextModel steers the next pass; legacy nextEngine ignored ──
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const auto = await sched.createJob({
      name: "auto-handoff",
      trigger: { kind: "manual" },
      loop: { kind: "agent", stop: { maxIterations: 5 }, isolate: true },
      input: baseInput,
      prompt: { template: "h {{iteration}}" },
      worker: { engine: "auto" },
    });
    await sched.runJobNow(auto.id);
    let rid = nextPending();
    L.pending.length = 0;
    // The MCP tool's signal (persisted mirror — survives restarts) steers the
    // NEXT pass to a Codex model; a legacy GPT-5.5 handoff migrates to Sol.
    await sched.patchJob(auto.id, (j) => ({
      ...j,
      state: { ...j.state, pendingAgentSignal: { continue: true, nextModel: "gpt-5.5" } },
    }));
    await completeRun(rid, { summary: "no sentinel here" });
    const launch = L.launches[L.launches.length - 1];
    ok("loom honors and migrates the agent's model handoff", launch.model === "gpt-5.6-sol");
    rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "SPARK_LOOP_DONE" });

    // Legacy persisted signal carrying ONLY a nextEngine: the field is dead,
    // so the loom keeps its own model and no rejection event is emitted.
    L.launches.length = 0;
    L.pending.length = 0;
    const pinned = await sched.createJob({
      name: "pinned-handoff",
      trigger: { kind: "manual" },
      loop: { kind: "agent", stop: { maxIterations: 5 }, isolate: true },
      input: baseInput,
      prompt: { template: "ph {{iteration}}" },
      worker: { engine: "claude" },
    });
    await sched.runJobNow(pinned.id);
    rid = nextPending();
    L.pending.length = 0;
    L.events = [];
    await sched.patchJob(pinned.id, (j) => ({
      ...j,
      state: { ...j.state, pendingAgentSignal: { continue: true, nextEngine: "codex" } },
    }));
    await completeRun(rid, { summary: "no sentinel" });
    const launch2 = L.launches[L.launches.length - 1];
    ok("a legacy nextEngine-only handoff is ignored (model unchanged)", launch2.model === "claude-opus-5");
    ok(
      "no handoff_rejected event is emitted anymore",
      !(L.events ?? []).some((e) => e.type === "automation.handoff_rejected"),
    );
    rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "SPARK_LOOP_DONE" });
  }

  // ── 16) persisted agent signal alone (no sentinel) drives continuation ──
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const job = await sched.createJob({
      name: "persisted-signal",
      trigger: { kind: "manual" },
      loop: { kind: "agent", stop: { maxIterations: 5 }, isolate: true },
      input: baseInput,
      prompt: { template: "ps {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    let rid = nextPending();
    L.pending.length = 0;
    await sched.patchJob(job.id, (j) => ({
      ...j,
      state: { ...j.state, pendingAgentSignal: { continue: true, prompt: "next: focus on tests" } },
    }));
    // Summary has NO sentinel — only the persisted signal says continue.
    await completeRun(rid, { summary: "plain summary" });
    let st = await getState(job.id);
    ok("persisted agent signal continues the loop without a sentinel", st.status === "running" && st.iteration === 2);
    const launch = L.launches[L.launches.length - 1];
    // The loop footer (how-to-continue instructions) is appended after the
    // agent's prompt — assert the prompt leads.
    ok("agent-supplied prompt drives the next pass", launch.note.startsWith("next: focus on tests"));
    ok("persisted signal is consumed once", st.pendingAgentSignal === undefined);
    rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "SPARK_LOOP_DONE" });
  }

  // ── 17) a TRIGGER fire on a finished loom starts a fresh cycle ──
  // (Regression: a finalized loom's "stopped" state used to swallow every
  // later cron/interval/folder fire forever — recurring automations ran once.)
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const job = await sched.createJob({
      name: "refire",
      trigger: { kind: "manual" },
      loop: { kind: "once", stop: {}, isolate: true },
      input: baseInput,
      prompt: { template: "nightly {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    const rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "night 1" });
    let st = await getState(job.id);
    ok("once loom finalizes after its pass", st.status === "stopped");

    L.launches.length = 0;
    await sched.fireJob(job.id); // the next cron tick
    await sleep(80);
    st = await getState(job.id);
    ok(
      "trigger fire on a finished loom starts a fresh cycle",
      L.launches.length === 1 && st.status === "running" && st.iteration === 1,
    );
    const rid2 = nextPending();
    L.pending.length = 0;
    await completeRun(rid2, { summary: "night 2" });
    st = await getState(job.id);
    ok("re-fired cycle finalizes cleanly again", st.status === "stopped" && st.lastStopReason === "once");
    const refreshed = await sched.getJob(job.id);
    const iter0recs = refreshed.history.filter((r) => r.iteration === 0);
    ok(
      "history keeps one finished record per cycle (runId+iteration key)",
      iter0recs.length === 2 &&
        iter0recs.every((r) => r.finishedAt) &&
        iter0recs[0].runId !== iter0recs[1].runId,
    );
  }

  // ── 18) "Run now" mid-pass RESTARTS: kills the live worker, no stacking ──
  {
    L.launches.length = 0;
    L.pending.length = 0;
    L.forcePaused = 0;
    const job = await sched.createJob({
      name: "restart",
      trigger: { kind: "manual" },
      loop: { kind: "once", stop: {}, isolate: true },
      input: baseInput,
      prompt: { template: "r {{iteration}}" },
    });
    await sched.runJobNow(job.id); // R1 live
    const r1 = nextPending();
    await sched.runJobNow(job.id); // restart while R1 is mid-flight
    const r2 = nextPending();
    const st = await getState(job.id);
    ok(
      "restart kills the live pass before launching the new one",
      (L.forcePaused ?? 0) >= 1 && r2 !== r1 && st.currentRunId === r2 && st.iteration === 1,
    );
    const refreshed = await sched.getJob(job.id);
    const r1rec = refreshed.history.find((r) => r.runId === r1);
    ok(
      "orphaned pass's history row is closed out as cancelled",
      r1rec && Boolean(r1rec.finishedAt) && r1rec.status === "cancelled",
    );
    // The old run's watcher is gone — its (eventual) completion is inert.
    L.launches.length = 0;
    await completeRun(r1, { summary: "zombie finishing" });
    ok("the killed pass can no longer advance the loop", L.launches.length === 0);
    L.pending.length = 0;
    await completeRun(r2, { summary: "fresh pass done" });
  }

  // ── 19) resume does NOT start a never-fired cadence loom (but re-arms a live cycle) ──
  {
    L.launches.length = 0;
    L.pending.length = 0;
    // NB: scheduleCadence floors everyMs at 1000ms — the waits below must
    // cover a full (floored) period to observe a fire / prove its absence.
    const job = await sched.createJob({
      name: "cadence-hold",
      trigger: { kind: "manual" },
      loop: { kind: "cadence", everyMs: 1000, stop: { maxIterations: 5 }, isolate: true },
      input: baseInput,
      prompt: { template: "c {{iteration}}" },
    });
    await sched.pauseJob(job.id);
    await sched.resumeJob(job.id);
    await sleep(1300); // > everyMs
    ok("resuming a never-fired cadence loom launches nothing", L.launches.length === 0);

    // A cycle in progress (pass 1 done, parked between fires) re-arms on resume.
    await sched.runJobNow(job.id);
    const rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "tick" }); // parks idle + nextFireAt
    await sched.pauseJob(job.id); // clears the timer (and nextFireAt)
    const launchesAtPause = L.launches.length;
    await sched.resumeJob(job.id);
    await sleep(1500);
    ok("resuming a mid-cycle cadence loom re-arms the next fire", L.launches.length > launchesAtPause);
    await sched.stopJob(job.id);
  }

  // ── 20) report-blocked pass resumes when the user's answer lands ──
  // (Regression: the worker EXITED declaring blocked, so no ask_user long-poll
  // exists — answering through the Hub used to be a dead letter forever.)
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const job = await sched.createJob({
      name: "answerable",
      trigger: { kind: "manual" },
      loop: { kind: "count", stop: { maxIterations: 3 }, isolate: false },
      input: baseInput,
      prompt: { template: "a {{iteration}}" },
      // The node pins a tool-access fence: the answer-resume continuation must
      // carry it (a resumed attempt is the SAME node, not a fresh full-access
      // worker).
      graph: {
        version: 1,
        nodes: [
          {
            id: "w0",
            kind: "worker",
            worker: { model: "claude-opus-5", effort: "medium" },
            prompt: "a {{iteration}}",
            access: "readonly",
            blockedTools: ["WebSearch"],
          },
        ],
        edges: [],
        entryNodeIds: ["w0"],
      },
    });
    await sched.runJobNow(job.id);
    const rid = nextPending();
    L.pending.length = 0;

    // The worker exits report-blocked: terminal attempt + spark question.
    await sleep(40);
    const run = L.runs.get(rid);
    run.status = "blocked";
    run.workerAttempts = [{ id: "att-q", status: "succeeded" }];
    run.humanMessages = [
      {
        id: "q-config",
        author: "spark",
        kind: "question",
        message: "Which config file should I edit?",
        createdAt: new Date(Date.now() - 1000).toISOString(),
      },
    ];
    for (const h of [...L.subs]) h({ runId: rid });
    await sleep(60);
    let st = await getState(job.id);
    ok("report-blocked pass parks the loom blocked", st.status === "blocked");
    ok("no continuation launches before the answer", !L.launches.some((l) => l.kind === "chain"));

    // The Hub answer resolves the exact open question by message id.
    run.humanMessages.push({
      id: "a-config",
      author: "user",
      kind: "answer",
      message: "Use config.staging.ts",
      answersMessageId: "q-config",
      createdAt: new Date().toISOString(),
    });
    for (const h of [...L.subs]) h({ runId: rid });
    await sleep(80);
    const chain = L.launches[L.launches.length - 1];
    ok(
      "the answer resumes the pass in the SAME run with question+answer context",
      chain?.kind === "chain" &&
        chain.id === rid &&
        chain.note.includes("Which config file should I edit?") &&
        chain.note.includes("Use config.staging.ts"),
    );
    ok(
      "the answer-resume keeps the node's tool-access fence",
      chain.access === "readonly" && JSON.stringify(chain.blockedTools) === JSON.stringify(["WebSearch"]),
    );
    st = await getState(job.id);
    ok("answer-resume does not advance the iteration counter", st.iteration === 1);
    L.pending.length = 0;
    await completeRun(rid, { summary: "edited the file" });
    st = await getState(job.id);
    ok("the resumed pass completes and the loop advances", st.iteration === 2);
    await sched.stopJob(job.id);
  }

  // ── 21) effort-only handoff is honored on auto looms ──
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const job = await sched.createJob({
      name: "effort-handoff",
      trigger: { kind: "manual" },
      loop: { kind: "agent", stop: { maxIterations: 5 }, isolate: true },
      input: baseInput,
      prompt: { template: "e {{iteration}}" },
      worker: { engine: "auto" },
    });
    await sched.runJobNow(job.id);
    let rid = nextPending();
    L.pending.length = 0;
    await sched.patchJob(job.id, (j) => ({
      ...j,
      state: { ...j.state, pendingAgentSignal: { continue: true, nextEffort: "high" } },
    }));
    await completeRun(rid, { summary: "plain" });
    const launch = L.launches[L.launches.length - 1];
    ok(
      "effort-only handoff steers the next pass (model kept)",
      launch.model === "claude-opus-5" && launch.effort === "high",
    );
    rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "SPARK_LOOP_DONE" });
  }

  // ── 22) sentinel survives trailing TUI chrome; the instructions echo never counts ──
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const job = await sched.createJob({
      name: "sentinel-chrome",
      trigger: { kind: "manual" },
      loop: { kind: "agent", stop: { maxIterations: 5 }, isolate: true },
      input: baseInput,
      prompt: { template: "s {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    let rid = nextPending();
    L.pending.length = 0;
    // Raw-tail summaries end with TUI chrome below the agent's last words.
    await completeRun(rid, {
      summary: "refactored the parser\nSPARK_LOOP_CONTINUE\n? for shortcuts\ntokens: 12.3k",
    });
    let st = await getState(job.id);
    ok("sentinel above trailing TUI chrome still continues the loop", st.status === "running" && st.iteration === 2);
    rid = nextPending();
    L.pending.length = 0;
    // The loop-instructions echo must never read as a signal.
    await completeRun(rid, {
      summary: "did the work\nReminder: end with SPARK_LOOP_CONTINUE or SPARK_LOOP_DONE on its own last line.",
    });
    st = await getState(job.id);
    ok(
      "instructions echo does not count as a sentinel (loop stops, no-signal)",
      st.status === "stopped" && st.lastStopReason === "agent-no-signal",
    );
  }

  // ── 23) SLICE 7 per-attempt watchdog: fail ONLY the hung attempt; the live ──
  //        sibling and the run survive (the wave settles, not the run). ─────────
  {
    L.launches.length = 0;
    L.pending.length = 0;
    L.failedAttempts = 0;
    L.failedAttemptIds = [];
    const job = await sched.createJob({
      name: "wave-watchdog",
      trigger: { kind: "manual" },
      loop: { kind: "once", stop: {}, isolate: true },
      input: baseInput,
      prompt: { template: "w {{iteration}}" },
      worker: { engine: "auto", timeoutMinutes: 5 },
    });
    await sched.runJobNow(job.id);
    const rid = nextPending();
    // Simulate a parallel wave: two live attempts on the current run.
    const run = L.runs.get(rid);
    run.workerAttempts = [
      { id: "wd-A", workerTaskId: "tA", status: "running" },
      { id: "wd-B", workerTaskId: "tB", status: "running" },
    ];
    // The watchdog FIRES for the hung attempt A (extracted seam — no 1-min wait).
    await sched.fireWatchdog(job.id, rid, "wd-A", 5);
    ok(
      "watchdog fails ONLY the hung attempt of the wave",
      L.failedAttemptIds.length === 1 && L.failedAttemptIds[0] === "wd-A",
    );
    ok(
      "the live sibling and the run survive the watchdog (wave settles, not run)",
      run.workerAttempts.find((a) => a.id === "wd-B").status === "running" && run.status !== "failed",
    );
    // Now the sibling B also hangs and fires — with no live attempt left the run
    // terminalizes, the loop records iteration-failed.
    L.pending.length = 0;
    await sched.fireWatchdog(job.id, rid, "wd-B", 5);
    for (const h of [...L.subs]) h({ runId: rid }); // watchTerminal sees the failed run
    await sleep(60);
    const st = await getState(job.id);
    ok("once the whole wave fails, the loop records iteration-failed", st.status === "stopped" && st.lastStopReason === "iteration-failed");
  }

  // ── 24) SLICE 7: a LEAKED watchdog timer for an already-settled pass no-ops ──
  {
    L.failedAttempts = 0;
    L.failedAttemptIds = [];
    const job = await sched.createJob({
      name: "leaked-watchdog",
      trigger: { kind: "manual" },
      loop: { kind: "once", stop: {}, isolate: true },
      input: baseInput,
      prompt: { template: "lw {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    const rid = nextPending();
    L.pending.length = 0;
    // Pass completes + finalizes (currentRunId cleared).
    await completeRun(rid, { summary: "all done" });
    const st = await getState(job.id);
    ok("once loom finalized before the leaked timer", st.status === "stopped" && st.currentRunId === undefined);
    // A timer left over from the settled pass fires: re-verify (currentRunId !==
    // runId AND the run is terminal) must make it a no-op — no attempt failed.
    await sched.fireWatchdog(job.id, rid, "wd-stale", 5);
    ok("leaked watchdog timer is a no-op for a settled pass", (L.failedAttemptIds || []).length === 0);
  }

  // ── 25) SLICE 7: killLiveRun (stop/restart) kills the pty of BOTH live ──────
  //        siblings of a parallel wave — no orphaned worker keeps editing. ──────
  {
    L.launches.length = 0;
    L.pending.length = 0;
    L.forcePaused = 0;
    L.ptyKills = 0;
    L.ptyAlive = new Set(["kl-A", "kl-B"]);
    const job = await sched.createJob({
      name: "wave-kill",
      trigger: { kind: "manual" },
      loop: { kind: "continuous", stop: { maxIterations: 9 }, isolate: true },
      input: baseInput,
      prompt: { template: "k {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    const rid = nextPending();
    const run = L.runs.get(rid);
    run.workerAttempts = [
      { id: "kl-A", workerTaskId: "tA", status: "running" },
      { id: "kl-B", workerTaskId: "tB", status: "running" },
      { id: "kl-done", workerTaskId: "tC", status: "succeeded" }, // terminal: not killed
    ];
    await sched.stopJob(job.id);
    ok("killLiveRun force-paused the run", (L.forcePaused ?? 0) >= 1);
    ok("killLiveRun killed BOTH live siblings' ptys (terminal attempt left alone)", (L.ptyKills ?? 0) === 2);
  }

  // ── 26) SLICE 7: per-NODE answer-resume. A multi-node pass blocks TWO nodes; ─
  //        answering one resumes ONLY that node (answerResumes keyed runId:node);
  //        the second resumes on the next finalize re-entry. ──────────────────
  {
    L.launches.length = 0;
    L.pending.length = 0;
    const job = await sched.createJob({
      name: "multinode-answer",
      trigger: { kind: "manual" },
      loop: { kind: "count", stop: { maxIterations: 3 }, isolate: false },
      input: baseInput,
      prompt: { template: "mn {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    const rid = nextPending();
    L.pending.length = 0;

    // The wave exits with TWO report-blocked nodes (A and B), each a terminal
    // attempt + a loomNodeId-stamped question.
    await sleep(40);
    const run = L.runs.get(rid);
    run.status = "blocked";
    run.workerTasks = [
      { id: "tA", loomNodeId: "A" },
      { id: "tB", loomNodeId: "B" },
    ];
    run.workerAttempts = [
      { id: "att-A", workerTaskId: "tA", status: "succeeded" },
      { id: "att-B", workerTaskId: "tB", status: "succeeded" },
    ];
    run.loomPass = {
      graphVersion: 1,
      layerCursor: 0,
      pendingNodeIds: [],
      nodeStates: {
        A: { status: "blocked", attemptIds: ["att-A"], layer: 0 },
        B: { status: "blocked", attemptIds: ["att-B"], layer: 0 },
      },
    };
    const t0 = Date.now();
    run.humanMessages = [
      { id: "q-A", author: "spark", kind: "question", message: "Which target?", loomNodeId: "A", createdAt: new Date(t0 - 2000).toISOString() },
      { id: "q-B", author: "spark", kind: "question", message: "Which target?", loomNodeId: "B", createdAt: new Date(t0 - 1000).toISOString() },
    ];
    for (const h of [...L.subs]) h({ runId: rid });
    await sleep(60);
    let st = await getState(job.id);
    ok("multi-node report-blocked pass parks the loom blocked", st.status === "blocked");
    ok("no continuation launches before any answer lands", !L.launches.some((l) => l.kind === "chain"));

    // ONLY node A is answered. Both nodes asked IDENTICAL text, so the exact
    // answersMessageId — not content or chronology — must select A.
    run.humanMessages.push({
      id: "a-A",
      author: "user",
      kind: "answer",
      message: "Answer for A: use config.ts",
      answersMessageId: "q-A",
      createdAt: new Date(t0 + 100).toISOString(),
    });
    for (const h of [...L.subs]) h({ runId: rid });
    await sleep(80);
    const chainsAfterA = L.launches.filter((l) => l.kind === "chain");
    ok(
      "answering node A resumes ONLY node A (stamped + carries question/answer)",
      chainsAfterA.length === 1 &&
        chainsAfterA[0].loomNodeId === "A" &&
        chainsAfterA[0].note.includes("Which target?") &&
        chainsAfterA[0].note.includes("Answer for A: use config.ts"),
    );
    st = await getState(job.id);
    ok("per-node answer-resume does not advance the iteration counter", st.iteration === 1);

    // The A-resume appended a live attempt; the resumed worker exits (attempt
    // terminal) and the pass re-settles with node B STILL blocked — so the run
    // re-enters "blocked", driving the watcher back into the answer seam. Now
    // answer node B; this re-entry resumes B (the FIRST blocked node, A, is no
    // longer a candidate — its nodeState is "running").
    run.workerAttempts.at(-1).status = "succeeded";
    run.status = "blocked";
    run.humanMessages.push({
      id: "a-B",
      author: "user",
      kind: "answer",
      message: "Answer for B: port 8080",
      answersMessageId: "q-B",
      createdAt: new Date(t0 + 1000).toISOString(),
    });
    for (const h of [...L.subs]) h({ runId: rid });
    await sleep(80);
    const chainsAfterB = L.launches.filter((l) => l.kind === "chain" && l.loomNodeId === "B");
    ok(
      "the second blocked node resumes on the next finalize re-entry",
      chainsAfterB.length === 1 &&
        chainsAfterB[0].note.includes("Which target?") &&
        chainsAfterB[0].note.includes("Answer for B: port 8080"),
    );
    await sched.stopJob(job.id);
  }

  // ── 27) FIX 1 + FIX 5: a MULTI-ENTRY graph launches the WHOLE layer-0 ───────
  //        frontier as ONE wave, each entry running its OWN prompt + worker. ────
  {
    L.launches.length = 0;
    L.pending.length = 0;
    // Two entry workers (A, B) feeding a shared sink C — A,B are indegree-0, so
    // layers[0] = [A, B]. A pins a Codex-side model (via legacy engine, which
    // the migration maps); B has a legacy auto engine. The degenerate path would
    // run the SINK's mirrored prompt on a single entry; the multi-node path runs
    // each entry's authored prompt + its own worker.
    const graph = {
      version: 1,
      nodes: [
        { id: "A", kind: "worker", label: "Builder", worker: { engine: "codex" }, prompt: "BUILD: {{iteration}}" },
        { id: "B", kind: "worker", label: "Tester", worker: { engine: "auto" }, prompt: "TEST the build" },
        { id: "C", kind: "worker", label: "Ship", worker: { engine: "auto" }, prompt: "ship {{node:A}} {{node:B}}" },
      ],
      edges: [
        { id: "e-a-c", from: "A", to: "C" },
        { id: "e-b-c", from: "B", to: "C" },
      ],
      entryNodeIds: ["A", "B"],
    };
    const job = await sched.createJob({
      name: "multi-entry",
      trigger: { kind: "manual" },
      loop: { kind: "once", stop: {}, isolate: true },
      input: baseInput,
      prompt: { template: "fallback prompt" },
      graph,
    });
    await sched.runJobNow(job.id);
    const launch = L.launches[L.launches.length - 1];
    ok("multi-entry loom launches a fresh direct run (isolate)", launch.kind === "start");
    ok(
      "layer-0 frontier launches as ONE wave with BOTH entry nodes",
      Array.isArray(launch.nodes) &&
        launch.nodes.length === 2 &&
        launch.nodes.map((n) => n.nodeId).slice().sort().join() === "A,B",
    );
    const byId = Object.fromEntries(launch.nodes.map((n) => [n.nodeId, n]));
    ok(
      "each entry renders its OWN node prompt (not the sink's mirror)",
      byId.A.template.includes("BUILD: 0") && byId.B.template.includes("TEST the build") &&
        !byId.A.template.includes("ship") && !byId.B.template.includes("ship"),
    );
    ok(
      "each entry resolves its OWN worker (A migrated to Sol, B to the default)",
      byId.A.worker.engine === undefined && byId.A.worker.model === "gpt-5.6-sol" &&
        byId.B.worker.engine === undefined && byId.B.worker.model === "claude-opus-5",
    );
    const rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "done" });
  }

  // ── 28) FIX 2: the freshPass MATRIX — pass-chaining sets freshPass=true; an ──
  //        answer-resume does NOT (mid-pass, preserves loomPass). ───────────────
  {
    L.launches.length = 0;
    L.pending.length = 0;
    // Same-run (isolate=false) count loom: pass 2 chains in the same run and MUST
    // carry freshPass=true (a new PASS rebuilds loomPass from scratch).
    const job = await sched.createJob({
      name: "freshpass-chain",
      trigger: { kind: "manual" },
      loop: { kind: "count", stop: { maxIterations: 2 }, isolate: false },
      input: baseInput,
      prompt: { template: "fp {{iteration}}" },
    });
    await sched.runJobNow(job.id);
    let rid = nextPending();
    L.pending.length = 0;
    await completeRun(rid, { summary: "first" });
    const chain = L.launches[L.launches.length - 1];
    ok(
      "same-run pass-chaining launch carries freshPass=true",
      chain.kind === "chain" && chain.freshPass === true,
    );
    L.pending.length = 0;
    await completeRun(rid, { summary: "second" });

    // Answer-resume (mid-pass): the worker exits report-blocked, the user answers,
    // and the continuation chains WITHOUT freshPass (loomPass must be preserved).
    L.launches.length = 0;
    L.pending.length = 0;
    const ans = await sched.createJob({
      name: "freshpass-answer",
      trigger: { kind: "manual" },
      loop: { kind: "count", stop: { maxIterations: 3 }, isolate: false },
      input: baseInput,
      prompt: { template: "fa {{iteration}}" },
    });
    await sched.runJobNow(ans.id);
    rid = nextPending();
    L.pending.length = 0;
    await sleep(40);
    const run = L.runs.get(rid);
    run.status = "blocked";
    run.workerAttempts = [{ id: "att-q", status: "succeeded" }];
    run.humanMessages = [
      { id: "q-path", author: "spark", kind: "question", message: "Which path?", createdAt: new Date(Date.now() - 1000).toISOString() },
    ];
    for (const h of [...L.subs]) h({ runId: rid });
    await sleep(60);
    run.humanMessages.push({ id: "a-path", author: "user", kind: "answer", message: "Use /tmp", answersMessageId: "q-path", createdAt: new Date().toISOString() });
    for (const h of [...L.subs]) h({ runId: rid });
    await sleep(80);
    const resume = L.launches[L.launches.length - 1];
    ok(
      "answer-resume continuation does NOT set freshPass (mid-pass preserve)",
      resume.kind === "chain" && resume.note.includes("Which path?") && resume.freshPass === undefined,
    );
    await sched.stopJob(ans.id);
  }

  sched.stopScheduler();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  console.log(`\nAll ${passed} automation-loop checks PASSED.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\nAUTOMATION-LOOP TEST FAILED:\n", err);
    process.exit(1);
  },
);
