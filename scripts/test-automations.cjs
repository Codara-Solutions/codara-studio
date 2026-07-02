// Runtime test for the automation scheduler (cron / interval / folder triggers).
//
// Mirrors scripts/test-worktrees.cjs: esbuild-bundles the real scheduler.ts and
// exercises it, but STUBS the lazily-imported ./run-queue, ./run-store and
// ./event-log so we can observe firing without booting the whole orchestrator.
// Verifies that arming a job actually fires it: interval loop, folder-add watch,
// and a per-second cron all reach the (stubbed) enqueue path.
//
//   node scripts/test-automations.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const SCHEDULER_TS = path.join(ROOT, "src", "main", "orchestration", "scheduler.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stub the three modules scheduler.ts dynamically imports, plus resolve the
// @shared/* path alias to the real source.
const harnessPlugin = {
  name: "automation-test-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve(
      { filter: /^(\.\/(run-queue|run-store|event-log)|\.\.\/(spark-home|fs-atomic|agent-runtimes|pty-manager|notify))$/ },
      (args) => ({ path: args.path.replace(/^\.\.?\//, ""), namespace: "stub" }),
    );
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      // Triggers start a loop iteration via the LoopDriver, which launches a
      // DIRECT worker run through run-store.startDirectWorkerRun (Looms v2 —
      // no manager LLM, no queue). We stub run-store + event-log so a fired
      // trigger is observable as a launch record, and the launched run simply
      // HOLDS (never completes) so the loop doesn't advance further — exactly
      // what these arming tests want.
      const init =
        "globalThis.__SPARK_TEST ??= { fired: [], launches: 0, events: [] };\n";
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
        // No longer used by the scheduler/loop path; kept as a harmless stub.
        return {
          contents:
            init +
            "export async function enqueue(){ return { id: 'q', status: 'queued' }; }\n" +
            "export async function burnDown(){ return {}; }\n",
          loader: "js",
        };
      }
      if (args.path === "agent-runtimes") {
        return {
          contents:
            "export async function detectAgentRuntimes(){ return [ { kind: 'claude', installed: true, disabledBySettings: false, models: [] }, { kind: 'codex', installed: true, disabledBySettings: false, models: [] } ]; }\n",
          loader: "js",
        };
      }
      if (args.path === "pty-manager") {
        return {
          contents: "export function exists(){ return false; }\nexport function killImmediate(){}\nexport function dispose(){}\n",
          loader: "js",
        };
      }
      if (args.path === "run-store") {
        return {
          contents:
            init +
            "export async function startDirectWorkerRun(input){ const n = ++globalThis.__SPARK_TEST.launches; const id = 'run-' + n; globalThis.__SPARK_TEST.fired.push({ title: input.title, prompt: input.prompt, engine: input.engine, automationId: input.automationId }); globalThis.__SPARK_TEST[id] = { id, status: 'running', humanMessages: [], workerAttempts: [] }; return globalThis.__SPARK_TEST[id]; }\n" +
            "export async function addDirectIteration(input){ return { id: input.runId, status: 'running', humanMessages: [], workerAttempts: [] }; }\n" +
            "export async function failWorkerAttempt(){ return null; }\n" +
            "export async function getRun(id){ return globalThis.__SPARK_TEST[id] ?? { id, status: 'running', humanMessages: [], workerAttempts: [] }; }\n" +
            "export async function forcePauseRun(id){ return { id, status: 'cancelled', humanMessages: [] }; }\n",
          loader: "js",
        };
      }
      // event-log: appendEvent records; subscribeToEvents never fires (runs hold).
      return {
        contents:
          init +
          "export async function appendEvent(e){ globalThis.__SPARK_TEST.events.push(e); return e; }\n" +
          "export function subscribeToEvents(){ return () => {}; }\n",
        loader: "js",
      };
    });
  },
};

async function main() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "spark-auto-home-"));
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), "spark-auto-watch-"));
  process.env.SPARK_HOME_DIR = tmpHome;

  const outfile = path.join(tmpHome, "scheduler.bundle.cjs");
  await esbuild.build({
    entryPoints: [SCHEDULER_TS],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    resolveExtensions: [".ts", ".js", ".cjs", ".mjs", ".json"],
    plugins: [harnessPlugin],
  });

  const sched = require(outfile);
  const calls = () => globalThis.__SPARK_TEST ?? { fired: [] };
  const resetFired = () => {
    if (globalThis.__SPARK_TEST) globalThis.__SPARK_TEST.fired = [];
  };
  const fakeInput = { workspaceId: "ws", workspaceName: "test", cwd: watchDir, initialUserNote: "do the thing" };

  let passed = 0;

  // 1) Interval trigger fires within its period (one loop iteration launches).
  resetFired();
  await sched.createJob({ name: "iv", trigger: { kind: "interval", everyMs: 1000 }, input: fakeInput });
  await sched.startScheduler();
  await sleep(1300);
  assert.ok(calls().fired.length >= 1, "interval trigger should have launched an iteration");
  console.log("  PASS interval trigger fired");
  passed++;

  // 2) Folder trigger fires on a new file (add) and injects the changed path.
  resetFired();
  await sched.createJob({
    name: "fld",
    trigger: { kind: "folder", path: watchDir, events: ["add"], debounceMs: 120 },
    input: fakeInput,
  });
  sched.stopScheduler();
  await sched.startScheduler(); // re-arm with the folder job present
  await sleep(300); // let the baseline snapshot + watcher arm
  fs.writeFileSync(path.join(watchDir, "dropped.txt"), "hello");
  await sleep(900);
  const folderFire = calls().fired.find(
    (e) => typeof e.prompt === "string" && e.prompt.includes("dropped.txt"),
  );
  assert.ok(folderFire, "folder add trigger should fire and inject the changed path into the worker prompt");
  console.log("  PASS folder add trigger fired + injected path");
  passed++;

  // 3) Per-second cron fires.
  resetFired();
  await sched.createJob({ name: "cr", trigger: { kind: "cron", expr: "* * * * * *" }, input: fakeInput });
  sched.stopScheduler();
  await sched.startScheduler();
  await sleep(1600);
  assert.ok(calls().fired.length >= 1, "per-second cron trigger should have launched an iteration");
  console.log("  PASS cron trigger fired");
  passed++;

  // 4) Disabling a job disarms it (no further fires). All other jobs are holding
  // on a never-completing run, so a clean window means the disarm worked.
  const jobs = await sched.listJobs();
  const cron = jobs.find((j) => j.name === "cr");
  await sched.setEnabled(cron.id, false);
  resetFired();
  await sleep(1500);
  assert.strictEqual(calls().fired.length, 0, "disabled cron (and held loops) should not fire");
  console.log("  PASS disabling a job disarms it");
  passed++;

  // 5) Worker config round-trips through create + update.
  {
    const job = await sched.createJob({
      name: "worker-roundtrip",
      trigger: { kind: "manual" },
      input: fakeInput,
      worker: { engine: "codex", model: "gpt-5.5", effort: "high", timeoutMinutes: 30 },
    });
    const created = (await sched.listJobs()).find((j) => j.id === job.id);
    assert.deepStrictEqual(
      created.worker,
      { engine: "codex", model: "gpt-5.5", effort: "high", timeoutMinutes: 30 },
      "createJob should persist the worker config verbatim",
    );
    await sched.updateJob({ id: job.id, worker: { engine: "auto" } });
    const updated = (await sched.listJobs()).find((j) => j.id === job.id);
    assert.deepStrictEqual(updated.worker, { engine: "auto" }, "updateJob should replace the worker config");
    console.log("  PASS worker config round-trips through create/update");
    passed++;
  }

  // 6) Omitted worker defaults from the legacy input mapping (openrouter → auto).
  {
    const job = await sched.createJob({
      name: "worker-default",
      trigger: { kind: "manual" },
      input: { ...fakeInput, chatBackend: "openrouter", chatModel: "x-ai/grok-4.3" },
    });
    const created = (await sched.listJobs()).find((j) => j.id === job.id);
    assert.strictEqual(created.worker.engine, "auto", "openrouter-pinned input should default the worker to auto");
    console.log("  PASS omitted worker defaults to auto (API never a loom engine)");
    passed++;
  }

  // 7) Looms v2.5: normalizeJob backfills a single w0 worker-node graph and
  //    leaves the flat trigger/loop/prompt/worker fields intact (zero behavior
  //    change — the executor's degenerate single-node path mirrors the legacy
  //    linear pipeline).
  {
    const job = await sched.createJob({
      name: "graph-backfill",
      trigger: { kind: "manual" },
      input: fakeInput,
      loop: { kind: "count", stop: { maxIterations: 2 }, isolate: true },
      prompt: { template: "do the {{thing}}" },
      worker: { engine: "codex", model: "gpt-5.5" },
    });
    const created = (await sched.listJobs()).find((j) => j.id === job.id);
    const g = created.graph;
    assert.ok(g && g.version === 1 && g.nodes.length === 1 && g.edges.length === 0, "graph backfilled to a single-node v1 graph");
    const w0 = g.nodes[0];
    assert.ok(
      w0.id === "w0" && w0.kind === "worker" && g.entryNodeIds[0] === "w0",
      "the backfilled node is the w0 worker entry node",
    );
    assert.ok(
      w0.prompt === "do the {{thing}}" && w0.worker.engine === "codex" && w0.worker.model === "gpt-5.5" && w0.isolate === true,
      "w0 mirrors the flat prompt template / worker config / loop.isolate",
    );
    // Flat fields are NOT mutated by the backfill.
    assert.ok(
      created.prompt.template === "do the {{thing}}" && created.worker.engine === "codex" && created.loop.isolate === true,
      "flat prompt/worker/loop fields survive the graph backfill untouched",
    );
    console.log("  PASS normalizeJob backfills a w0 graph + leaves the flat fields intact");
    passed++;
  }

  sched.stopScheduler();

  // Cleanup.
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(watchDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }

  console.log(`\nAll ${passed} automation-engine checks PASSED.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\nAUTOMATION TEST FAILED:\n", err);
    process.exit(1);
  },
);
