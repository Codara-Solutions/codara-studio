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
      { filter: /^(\.\/(run-queue|run-store|event-log)|\.\.\/(spark-home|fs-atomic))$/ },
      (args) => ({ path: args.path.replace(/^\.\.?\//, ""), namespace: "stub" }),
    );
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      const init = "globalThis.__SPARK_TEST ??= { enqueue: [], burnDown: 0, startAutopilot: 0, events: [] };\n";
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
      if (args.path === "run-queue") {
        return {
          contents:
            init +
            "export async function enqueue(input){ globalThis.__SPARK_TEST.enqueue.push(input); return { id: 'q', status: 'queued' }; }\n" +
            "export async function burnDown(){ globalThis.__SPARK_TEST.burnDown++; return {}; }\n",
          loader: "js",
        };
      }
      if (args.path === "run-store") {
        return {
          contents:
            init +
            "export async function startAutopilot(input){ globalThis.__SPARK_TEST.startAutopilot++; return { id: 'run-' + globalThis.__SPARK_TEST.startAutopilot }; }\n",
          loader: "js",
        };
      }
      return {
        contents: init + "export async function appendEvent(e){ globalThis.__SPARK_TEST.events.push(e); return e; }\n",
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
  const calls = () => globalThis.__SPARK_TEST ?? { enqueue: [], burnDown: 0 };
  const fakeInput = { workspaceId: "ws", workspaceName: "test", cwd: watchDir, initialUserNote: "do the thing" };

  let passed = 0;

  // 1) Interval trigger fires within its period.
  await sched.createJob({ name: "iv", trigger: { kind: "interval", everyMs: 1000 }, input: fakeInput });
  await sched.startScheduler();
  await sleep(1300);
  assert.ok(calls().enqueue.some((e) => e.title === "iv"), "interval trigger should have fired");
  console.log("  PASS interval trigger fired");
  passed++;

  // 2) Folder trigger fires on a new file (add).
  if (globalThis.__SPARK_TEST) globalThis.__SPARK_TEST.enqueue = [];
  await sched.createJob({
    name: "fld",
    trigger: { kind: "folder", path: watchDir, events: ["add"], debounceMs: 120 },
    input: fakeInput,
  });
  sched.stopScheduler();
  await sched.startScheduler(); // re-arm with the folder job present
  await sleep(250); // let the baseline snapshot + watcher arm
  fs.writeFileSync(path.join(watchDir, "dropped.txt"), "hello");
  await sleep(900);
  assert.ok(calls().enqueue.some((e) => e.title === "fld"), "folder add trigger should have fired");
  const fired = calls().enqueue.find((e) => e.title === "fld");
  assert.ok(
    typeof fired.input.initialUserNote === "string" && fired.input.initialUserNote.includes("dropped.txt"),
    "folder trigger should inject the changed path into the run note",
  );
  console.log("  PASS folder add trigger fired + injected path");
  passed++;

  // 3) Per-second cron fires.
  if (globalThis.__SPARK_TEST) globalThis.__SPARK_TEST.enqueue = [];
  await sched.createJob({ name: "cr", trigger: { kind: "cron", expr: "* * * * * *" }, input: fakeInput });
  sched.stopScheduler();
  await sched.startScheduler();
  await sleep(1600);
  assert.ok(calls().enqueue.some((e) => e.title === "cr"), "per-second cron trigger should have fired");
  console.log("  PASS cron trigger fired");
  passed++;

  // 4) Disabling a job disarms it (no further fires).
  const jobs = await sched.listJobs();
  const cron = jobs.find((j) => j.name === "cr");
  await sched.setEnabled(cron.id, false);
  if (globalThis.__SPARK_TEST) globalThis.__SPARK_TEST.enqueue = [];
  await sleep(1500);
  assert.ok(!calls().enqueue.some((e) => e.title === "cr"), "disabled cron should not fire");
  console.log("  PASS disabling a job disarms it");
  passed++;

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
