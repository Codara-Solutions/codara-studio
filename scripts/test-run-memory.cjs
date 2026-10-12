// Coverage for the outcome-conditioned prior-runs ledger
// (src/main/orchestration/run-memory.ts): which runs are recorded, which are
// injected into a first manager turn, the memory switches, and concurrent
// writers in one workspace.
//
//   node scripts/test-run-memory.cjs
//
// Exits non-zero on any failed assertion.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codara-run-memory-"));

let failures = 0;
function check(name, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : `: ${detail}`}`);
  if (!condition) failures += 1;
}

const harness = {
  name: "run-memory-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /\/codara-home$/ }, () => ({
      path: "codara-home-stub",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: `export const codaraHome = () => ${JSON.stringify(TMP_HOME)};`,
      loader: "js",
    }));
  },
};

async function load(entry) {
  const out = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    plugins: [harness],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function makeRun(id, title, extra = {}) {
  return {
    id,
    title,
    workspaceId: "ws-ledger",
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [],
    workerTasks: [{ id: `${id}-task`, title, allowedPaths: [], status: "accepted" }],
    workerAttempts: [{
      id: `${id}-attempt`,
      workerTaskId: `${id}-task`,
      attemptNumber: 1,
      runtime: "codex",
      finalReportPath: `/reports/${id}.json`,
    }],
    ...extra,
  };
}

const report = {
  status: "complete",
  summary: "done",
  filesChanged: [{ path: "src/main/thing.ts" }],
  commandsRun: [],
  tests: [],
};
const readReport = async () => report;

async function main() {
  const runMemory = await load(path.join(ROOT, "src/main/orchestration/run-memory.ts"));
  const coraMemory = await load(path.join(ROOT, "src/main/orchestration/cora-memory.ts"));

  // ── which runs are recorded ───────────────────────────────────────────────
  await runMemory.recordRunMemory(
    makeRun("run-automation", "Loom: Release Codara Studio pass 1", { automationId: "auto-1" }),
    readReport,
  );
  await runMemory.recordRunMemory(
    makeRun("run-talk", "Reply with exactly the word OK", { workerTasks: [], workerAttempts: [] }),
    readReport,
  );
  check(
    "automation passes and worker-less chats are not recorded",
    runMemory.readWorkspaceMemory("ws-ledger") === null,
    JSON.stringify(runMemory.readWorkspaceMemory("ws-ledger")),
  );

  // ── concurrent completions in one workspace both land ─────────────────────
  await Promise.all([
    runMemory.recordRunMemory(makeRun("run-a", "Refactor terminal renderer scrollback buffer"), readReport),
    runMemory.recordRunMemory(makeRun("run-b", "Add billing invoice export endpoint"), readReport),
    runMemory.recordRunMemory(makeRun("run-c", "Speed up terminal renderer resize handling"), readReport),
  ]);
  const ledger = runMemory.readWorkspaceMemory("ws-ledger");
  const ids = new Set((ledger?.records ?? []).map((record) => record.runId));
  check(
    "concurrent recordRunMemory calls in one workspace all land",
    ids.has("run-a") && ids.has("run-b") && ids.has("run-c") && ids.size === 3,
    JSON.stringify([...ids]),
  );

  // ── only similar prior runs are injected ──────────────────────────────────
  const similar = runMemory.formatPriorRunsSection(
    makeRun("run-new", "Fix terminal renderer scrollback flicker", { workerTasks: [], workerAttempts: [] }),
  );
  check(
    "a similar prior run is injected and an unrelated one is not",
    similar !== null &&
      similar.includes("Refactor terminal renderer scrollback buffer") &&
      !similar.includes("billing invoice"),
    String(similar),
  );
  const unrelated = runMemory.formatPriorRunsSection(
    makeRun("run-other", "Translate onboarding copy into Japanese", { workerTasks: [], workerAttempts: [] }),
  );
  check("a plan with no overlap gets no prior-runs section", unrelated === null, String(unrelated));

  // ── the memory switches hide the history ──────────────────────────────────
  await coraMemory.setMemoryEnabled("workspace", "ws-ledger", false);
  const hiddenByWorkspace = runMemory.formatPriorRunsSection(
    makeRun("run-new", "Fix terminal renderer scrollback flicker", { workerTasks: [], workerAttempts: [] }),
  );
  check("workspace memory off hides prior runs", hiddenByWorkspace === null, String(hiddenByWorkspace));
  await coraMemory.setMemoryEnabled("workspace", "ws-ledger", true);
  await coraMemory.setMemoryEnabled("global", null, false);
  const hiddenByGlobal = runMemory.formatPriorRunsSection(
    makeRun("run-new", "Fix terminal renderer scrollback flicker", { workerTasks: [], workerAttempts: [] }),
  );
  check("the global master switch hides prior runs too", hiddenByGlobal === null, String(hiddenByGlobal));
  await runMemory.recordRunMemory(makeRun("run-d", "Terminal renderer cursor blink fix"), readReport);
  check(
    "nothing is recorded while memory is off",
    !(runMemory.readWorkspaceMemory("ws-ledger")?.records ?? []).some((record) => record.runId === "run-d"),
    "run-d was recorded while memory was off",
  );
  await coraMemory.setMemoryEnabled("global", null, true);

  // ── trivial chats, direct keywords, profiles, deletion ────────────────────
  await runMemory.recordRunMemory(
    makeRun("run-hello", "hola"),
    async () => ({ status: "complete", summary: "hi", filesChanged: [], commandsRun: [], tests: [] }),
  );
  check(
    "a chat whose worker changed and ran nothing is not recorded",
    !(runMemory.readWorkspaceMemory("ws-ledger")?.records ?? []).some((record) => record.runId === "run-hello"),
    "run-hello recorded",
  );
  await runMemory.recordRunMemory(
    makeRun("run-direct", "Chat", {
      executionMode: "direct",
      steps: [{
        title: "Chat",
        goal: "Execute the instruction directly and write an evidence-backed final report.",
        acceptanceCriteria: ["The direct worker completed the instruction and reported its real results in final-report.json."],
      }],
      humanMessages: [{ author: "user", message: "Speed up the sqlite migration runner" }],
    }),
    readReport,
  );
  const directRecord = (runMemory.readWorkspaceMemory("ws-ledger")?.records ?? []).find((record) => record.runId === "run-direct");
  check(
    "a direct chat is fingerprinted by the user's words, not the synthetic step",
    Boolean(directRecord) &&
      directRecord.planKeywords.includes("sqlite") &&
      !directRecord.planKeywords.some((word) => ["execute", "instruction", "directly", "evidence", "backed"].includes(word)),
    JSON.stringify(directRecord?.planKeywords),
  );
  await runMemory.recordRunMemory(
    makeRun("run-profile", "Refactor terminal renderer scrollback buffer again", { coraProfileId: "work" }),
    readReport,
  );
  check(
    "a named profile keeps its own ledger",
    (runMemory.readWorkspaceMemory("ws-ledger", "work")?.records ?? []).length === 1 &&
      !(runMemory.readWorkspaceMemory("ws-ledger")?.records ?? []).some((record) => record.runId === "run-profile"),
    JSON.stringify(runMemory.readWorkspaceMemory("ws-ledger", "work")),
  );
  check(
    "the default profile's history is not injected into a named profile's chat",
    runMemory.formatPriorRunsSection(
      makeRun("run-new-2", "Fix terminal renderer scrollback flicker", { workerTasks: [], workerAttempts: [], coraProfileId: "work" }),
    )?.includes("Refactor terminal renderer scrollback buffer\n") !== true,
    "default history leaked",
  );
  await runMemory.forgetRunMemory({ id: "run-a", workspaceId: "ws-ledger" });
  check(
    "deleting a chat removes its record",
    !(runMemory.readWorkspaceMemory("ws-ledger")?.records ?? []).some((record) => record.runId === "run-a"),
    "run-a still recorded",
  );
  check("the run history count reports the remaining records", runMemory.countRunHistory("ws-ledger") === 3, String(runMemory.countRunHistory("ws-ledger")));
  await runMemory.clearRunHistory("ws-ledger");
  check("clearing the run history empties it", runMemory.countRunHistory("ws-ledger") === 0, String(runMemory.countRunHistory("ws-ledger")));

  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll run-memory checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
