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
    // node:fs with an injectable readdir failure. A directory that cannot be
    // LISTED but can still be WATCHED is unreachable through permissions (on
    // macOS an unreadable dir cannot be fs.watch'd either), yet it is exactly
    // what a transient EMFILE at arm time produces. Without this seam the
    // arm-time-failure branch of watchFolder has no test.
    build.onResolve({ filter: /^node:fs$/ }, () => ({ path: "node-fs", namespace: "stub" }));
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
      if (args.path === "node-fs") {
        // Pass-through, except readdir fails while __FAIL_READDIR holds a
        // matching directory path. Everything else (watch, stat, mkdir) is the
        // real thing, so the watcher arms for real.
        return {
          // require("fs"), not require("node:fs"): the prefixed specifier is
          // what this stub intercepts, so using it here would resolve straight
          // back into the stub.
          contents:
            "const real = require('fs');\n" +
            "globalThis.__FAIL_READDIR ??= null;\n" +
            // Proxy rather than a spread: fs.promises carries a lot of surface
            // (mkdir, stat, writeFile, ...) that the scheduler uses, and only
            // readdir is being interposed.
            "export const promises = new Proxy(real.promises, {\n" +
            "  get(target, prop, receiver) {\n" +
            "    if (prop !== 'readdir') return Reflect.get(target, prop, receiver);\n" +
            "    return async (dir, opts) => {\n" +
            "      if (globalThis.__FAIL_READDIR && String(dir) === globalThis.__FAIL_READDIR) {\n" +
            "        const err = new Error('EMFILE: too many open files, scandir');\n" +
            "        err.code = 'EMFILE';\n" +
            "        throw err;\n" +
            "      }\n" +
            "      return target.readdir(dir, opts);\n" +
            "    };\n" +
            "  },\n" +
            "});\n" +
            "export const watch = real.watch;\n" +
            "export default real;\n",
          loader: "js",
        };
      }
      if (args.path === "fs-atomic") {
        return {
          // require("fs"): "node:fs" is interposed by the readdir-failure stub.
          contents: "const fs = require('fs');\nexport async function writeFileAtomic(p, c){ fs.writeFileSync(p, c); }\n",
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

  // 2b) A momentarily UNREADABLE folder must not manufacture "add" events for
  // the files already in it. The watcher is live and its baseline is correct;
  // the directory then fails to read for one scan and recovers. Treating that
  // failed read as "the folder is empty" wiped the baseline, so the next scan
  // announced every pre-existing file as new and re-ran the automation on work
  // nobody asked for (observed on a real "translate dropped files" loom, which
  // re-translated a file that had sat untouched for 22 minutes).
  {
    const flaky = fs.mkdtempSync(path.join(os.tmpdir(), "spark-auto-flaky-"));
    fs.writeFileSync(path.join(flaky, "already-here.txt"), "predates the failure");
    fs.chmodSync(flaky, 0o000);
    const permissionsBite = (() => {
      try {
        fs.readdirSync(flaky);
        return false; // root, or a filesystem that ignores mode bits
      } catch {
        return true;
      }
    })();
    fs.chmodSync(flaky, 0o700);

    if (!permissionsBite) {
      console.log("  SKIP unreadable-folder rescan (permissions do not bite here)");
    } else {
      const flakyJob = await sched.createJob({
        name: "flaky",
        trigger: { kind: "folder", path: flaky, events: ["add"], debounceMs: 100 },
        input: { ...fakeInput, cwd: flaky },
      });
      sched.stopScheduler();
      await sched.startScheduler(); // arms while readable: baseline is correct
      await sleep(300);
      resetFired();

      // One scan lands while the directory cannot be read, the next after it
      // recovers. Each chmod plus the poke file guarantees watch events.
      fs.chmodSync(flaky, 0o000);
      await sleep(350);
      fs.chmodSync(flaky, 0o700);
      fs.writeFileSync(path.join(flaky, "poke.tmp"), "x");
      fs.rmSync(path.join(flaky, "poke.tmp"));
      await sleep(700);

      const phantom = calls().fired.find(
        (e) => typeof e.prompt === "string" && e.prompt.includes("already-here.txt"),
      );
      assert.ok(
        !phantom,
        "a pre-existing file must not fire as an add after the folder was briefly unreadable",
      );
      console.log("  PASS a briefly unreadable folder does not manufacture adds");
      passed++;

      // The baseline survived intact, so a genuinely new file still fires.
      resetFired();
      fs.writeFileSync(path.join(flaky, "genuinely-new.txt"), "new");
      await sleep(700);
      const realFire = calls().fired.find(
        (e) => typeof e.prompt === "string" && e.prompt.includes("genuinely-new.txt"),
      );
      assert.ok(realFire, "the watcher must still fire on a real add after recovering");
      console.log("  PASS watcher still fires on a real add after recovering");
      passed++;
      await sched.setEnabled(flakyJob.id, false);
    }
    fs.rmSync(flaky, { recursive: true, force: true });
  }

  // 2c) The other half of the same guarantee: when the ARM-TIME listing fails
  // (a transient EMFILE, say) the watcher still arms, but with no trustworthy
  // baseline. The first successful scan must ADOPT the directory silently —
  // firing on everything already in it would be the same unrequested re-run,
  // just triggered at startup instead of mid-life.
  {
    const dark = fs.mkdtempSync(path.join(os.tmpdir(), "spark-auto-dark-"));
    fs.writeFileSync(path.join(dark, "predates-the-watch.txt"), "was here first");
    globalThis.__FAIL_READDIR = dark; // arm-time listing fails; fs.watch still works
    const darkJob = await sched.createJob({
      name: "dark",
      trigger: { kind: "folder", path: dark, events: ["add"], debounceMs: 100 },
      input: { ...fakeInput, cwd: dark },
    });
    sched.stopScheduler();
    await sched.startScheduler();
    await sleep(300);
    resetFired();

    globalThis.__FAIL_READDIR = null; // listing recovers; poke the watcher
    fs.writeFileSync(path.join(dark, "poke.tmp"), "x");
    fs.rmSync(path.join(dark, "poke.tmp"));
    await sleep(700);
    const startupPhantom = calls().fired.find(
      (e) => typeof e.prompt === "string" && e.prompt.includes("predates-the-watch.txt"),
    );
    assert.ok(
      !startupPhantom,
      "a failed arm-time listing must not turn pre-existing files into adds once listing recovers",
    );
    console.log("  PASS failed arm-time listing adopts the folder instead of firing on it");
    passed++;

    resetFired();
    fs.writeFileSync(path.join(dark, "arrived-after.txt"), "new");
    await sleep(700);
    const afterAdoption = calls().fired.find(
      (e) => typeof e.prompt === "string" && e.prompt.includes("arrived-after.txt"),
    );
    assert.ok(afterAdoption, "after adopting a baseline the watcher must fire on a real add");
    console.log("  PASS watcher fires normally once the adopted baseline is in place");
    passed++;
    await sched.setEnabled(darkJob.id, false);
    fs.rmSync(dark, { recursive: true, force: true });
  }

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

  // 5) Worker config round-trips through create + update, with the Pi
  //    migration applied on every write: a legacy engine field is dropped and
  //    gpt-* ids are normalized onto the current Codex catalog.
  {
    const job = await sched.createJob({
      name: "worker-roundtrip",
      trigger: { kind: "manual" },
      input: fakeInput,
      worker: { model: "claude-fable-5", effort: "high", timeoutMinutes: 30 },
    });
    const created = (await sched.listJobs()).find((j) => j.id === job.id);
    assert.deepStrictEqual(
      created.worker,
      { model: "claude-fable-5", effort: "high", timeoutMinutes: 30 },
      "createJob should persist the worker config verbatim",
    );
    await sched.updateJob({ id: job.id, worker: { engine: "codex", model: "gpt-5.5" } });
    const updated = (await sched.listJobs()).find((j) => j.id === job.id);
    assert.deepStrictEqual(
      updated.worker,
      { model: "gpt-5.6-sol", effort: "medium" },
      "updateJob should migrate a legacy engine spec (engine dropped, gpt id normalized, effort defaulted)",
    );
    console.log("  PASS worker config round-trips through create/update with migration");
    passed++;
  }

  // 6) Omitted worker defaults from the legacy input mapping. The literal
  //    "openrouter" backend id is DEAD as a Cora backend, but it is still
  //    sitting in scheduler.json files written by older installs, so the
  //    migration must keep handling it: it lands on the default Pi worker.
  {
    const job = await sched.createJob({
      name: "worker-default",
      trigger: { kind: "manual" },
      input: { ...fakeInput, chatBackend: "openrouter", chatModel: "x-ai/grok-4.3" },
    });
    const created = (await sched.listJobs()).find((j) => j.id === job.id);
    assert.deepStrictEqual(
      created.worker,
      { model: "claude-opus-5", effort: "medium" },
      "input pinned to the removed API backend should default the worker to claude-opus-5/medium",
    );
    console.log("  PASS omitted worker defaults to the standard Pi worker");
    passed++;
  }

  // 6b) Legacy engine migration matrix: engine claude/codex/auto with and
  //     without a model, plus the pre-worker chatBackend carry-over.
  {
    const cases = [
      [{ engine: "claude" }, { model: "claude-opus-5", effort: "medium" }],
      [{ engine: "codex" }, { model: "gpt-5.6-sol", effort: "medium" }],
      [{ engine: "auto" }, { model: "claude-opus-5", effort: "medium" }],
      [
        { engine: "claude", model: "claude-sonnet-5", effort: "xhigh" },
        { model: "claude-sonnet-5", effort: "xhigh" },
      ],
      // Mixed-case ids self-heal: Pi's provider gate is case-sensitive, so a
      // persisted "Claude-Opus-5" would otherwise brick every launch.
      [
        { model: " Claude-Opus-5 ", effort: "high" },
        { model: "claude-opus-5", effort: "high" },
      ],
      [
        { model: "GPT-5.6-Sol", effort: "low" },
        { model: "gpt-5.6-sol", effort: "low" },
      ],
    ];
    for (const [legacy, expected] of cases) {
      const job = await sched.createJob({
        name: `worker-migrate-${legacy.engine ?? "pi"}-${(legacy.model ?? "none").trim()}`,
        trigger: { kind: "manual" },
        input: fakeInput,
        worker: legacy,
      });
      const created = (await sched.listJobs()).find((j) => j.id === job.id);
      assert.deepStrictEqual(
        created.worker,
        expected,
        `legacy worker ${JSON.stringify(legacy)} should migrate to ${JSON.stringify(expected)}`,
      );
    }
    // Pre-worker jobs pinned via input.chatBackend keep their chat model/effort.
    const legacyChat = await sched.createJob({
      name: "worker-migrate-chatbackend",
      trigger: { kind: "manual" },
      input: { ...fakeInput, chatBackend: "codex", chatModel: "gpt-5.4", chatEffort: "low" },
    });
    const createdChat = (await sched.listJobs()).find((j) => j.id === legacyChat.id);
    assert.deepStrictEqual(
      createdChat.worker,
      { model: "gpt-5.6-terra", effort: "low" },
      "a pre-worker codex chatBackend job should carry chatModel/chatEffort over (normalized)",
    );
    console.log("  PASS legacy engine specs migrate onto the Pi model/effort shape");
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
      w0.prompt === "do the {{thing}}" && w0.worker.model === "gpt-5.6-sol" && w0.worker.engine === undefined && w0.isolate === true,
      "w0 mirrors the flat prompt template / migrated worker config / loop.isolate",
    );
    // Flat fields keep the migrated worker too.
    assert.ok(
      created.prompt.template === "do the {{thing}}" && created.worker.model === "gpt-5.6-sol" && created.worker.engine === undefined && created.loop.isolate === true,
      "flat prompt/worker/loop fields survive the graph backfill (worker migrated)",
    );
    console.log("  PASS normalizeJob backfills a w0 graph + leaves the flat fields intact");
    passed++;
  }

  // 8) blockedTools backstop at the persistence layer: normalizeJob drops
  //    scoped/blank entries on EVERY write, so a raw editor/IPC payload cannot
  //    persist a fence the harness would silently ignore.
  {
    const job = await sched.createJob({
      name: "blocked-tools-backstop",
      trigger: { kind: "manual" },
      input: fakeInput,
      worker: { model: "claude-opus-5", effort: "medium" },
      graph: {
        version: 1,
        nodes: [
          {
            id: "w0",
            kind: "worker",
            worker: { model: "claude-opus-5", effort: "medium" },
            prompt: "p",
            blockedTools: ["Bash(rm *)", "WebSearch", "  "],
          },
        ],
        edges: [],
        entryNodeIds: ["w0"],
      },
    });
    const created = (await sched.listJobs()).find((j) => j.id === job.id);
    const node = created.graph.nodes.find((n) => n.id === "w0");
    assert.deepStrictEqual(
      node.blockedTools,
      ["WebSearch"],
      "normalizeJob should drop scoped and blank blockedTools entries",
    );
    console.log("  PASS blockedTools scoped/blank entries dropped at persist");
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
