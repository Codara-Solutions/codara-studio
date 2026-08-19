// Focused coverage for the workspace-lessons DERIVATION half
// (src/main/orchestration/workspace-lessons.ts): the two auto-lesson
// heuristics including the false positives they must NOT fire on, plus the
// run-completion seam that writes derived lessons into Cora memory v2 as
// [auto] bullets (storage, dedup, TTL, and injection now live in
// cora-memory.ts; see scripts/test-cora-memory.cjs for that coverage).
//
//   node scripts/test-workspace-lessons.cjs
//
// Exits non-zero on any failed assertion.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codara-lessons-home-"));

const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgo(days, seconds = 0) {
  return new Date(Date.now() - days * DAY_MS + seconds * 1000).toISOString();
}

let failures = 0;
function check(name, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : `: ${detail}`}`);
  if (!condition) failures += 1;
}

const harness = {
  name: "workspace-lessons-harness",
  setup(build) {
    // codara-home pulls in electron; the modules only need a home directory.
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

// Minimal RunState the derivation accepts.
function makeRun(overrides = {}) {
  return {
    id: "run-lessons-1",
    workspaceId: "/tmp/workspace-a",
    title: "Add a lessons ledger",
    status: "complete",
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1, 3600),
    completedAt: daysAgo(1, 3600),
    artifactDir: path.join(TMP_HOME, "runs", "run-lessons-1"),
    plans: [],
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    humanMessages: [],
    sparkCalls: [],
    ...overrides,
  };
}

function makeAttempt(overrides = {}) {
  return {
    id: "attempt-1",
    runId: "run-lessons-1",
    workerTaskId: "task-1",
    attemptNumber: 1,
    runtime: "claude",
    cwd: "/tmp/workspace-a",
    status: "finished",
    ...overrides,
  };
}

function makeReport(overrides = {}) {
  return {
    status: "complete",
    summary: "Did the work.",
    filesChanged: [],
    commandsRun: [],
    tests: [],
    proof: [],
    risks: [],
    followups: [],
    ...overrides,
  };
}

async function main() {
  const store = await load(path.join(ROOT, "src", "main", "orchestration", "workspace-lessons.ts"));
  const { deriveRunLessons, recordRunLessons } = store;
  const mem = await load(path.join(ROOT, "src", "main", "orchestration", "cora-memory.ts"));

  // --- derivation: web_search rate limit ------------------------------------
  const searchRun = makeRun({
    workerAttempts: [makeAttempt({ finalReportPath: "/does/not/matter.json" })],
  });
  const searchLessons = deriveRunLessons(searchRun, [
    {
      attempt: searchRun.workerAttempts[0],
      report: makeReport({
        risks: ["The web_search tool returned a rate limit error twice, so coverage is thinner than planned."],
      }),
    },
  ]);
  check(
    "web_search rate limit yields exactly one lesson",
    searchLessons.length === 1 && /web_search was rate limited/i.test(searchLessons[0]),
    JSON.stringify(searchLessons),
  );
  check(
    "search lesson tells the manager to stagger and prefer feeds",
    /stagger/i.test(searchLessons[0]) && /feeds/i.test(searchLessons[0]),
    searchLessons[0],
  );

  const splitRun = makeRun({ workerAttempts: [makeAttempt({ finalReportPath: "/x.json" })] });
  check(
    "web_search and rate limit in unrelated strings do not fire",
    deriveRunLessons(splitRun, [
      {
        attempt: splitRun.workerAttempts[0],
        report: makeReport({
          risks: ["Used web_search for the docs."],
          followups: ["The build server enforces a rate limit on uploads."],
        }),
      },
    ]).length === 0,
    "expected no lesson",
  );

  check(
    "a clean run derives no lessons",
    deriveRunLessons(makeRun(), []).length === 0,
    "expected no lesson",
  );

  // False positives are the expensive failure here: a wrong lesson persists and
  // steers every later turn in the workspace, so the detector has to insist on
  // the provider TOOL plus an unambiguous throttle, in one string.
  const falsePositives = [
    // "web search" in prose plus a bare number that is a count, not a status.
    { risks: ["The web search returned 429 results across the docs."] },
    // A count of files, next to prose about searching.
    { summary: "Ran a web search and touched 429 lines." },
    // A different tool being throttled does not indict web_search.
    { risks: ["The code search tool hit a rate limit."] },
    // A curl against some search endpoint that 429s is not the provider's own
    // web_search tool. command and summary must not pair up across fields.
    {
      commandsRun: [
        { command: "curl https://example.com/api/websearch?q=x", summary: "Fetched the docs page." },
        { command: "npm test", summary: "Server replied 429 too many requests." },
      ],
    },
  ];
  for (const [index, overrides] of falsePositives.entries()) {
    const fpRun = makeRun({ workerAttempts: [makeAttempt({ finalReportPath: "/fp.json" })] });
    check(
      `false positive ${index + 1} does not mint a search lesson`,
      deriveRunLessons(fpRun, [
        { attempt: fpRun.workerAttempts[0], report: makeReport(overrides) },
      ]).length === 0,
      JSON.stringify(overrides),
    );
  }

  // True positives the tightened detector must still catch.
  const truePositives = [
    { risks: ["web_search: 429 too many requests from the provider."] },
    { summary: "The web search tool was rate limited halfway through." },
    { followups: ["websearch quota exceeded, so research is incomplete."] },
  ];
  for (const [index, overrides] of truePositives.entries()) {
    const tpRun = makeRun({ workerAttempts: [makeAttempt({ finalReportPath: "/tp.json" })] });
    const derived = deriveRunLessons(tpRun, [
      { attempt: tpRun.workerAttempts[0], report: makeReport(overrides) },
    ]);
    check(
      `true positive ${index + 1} still mints the search lesson`,
      derived.length === 1 && /web_search was rate limited/i.test(derived[0]),
      JSON.stringify(overrides),
    );
  }

  // --- derivation: runtime fallback -----------------------------------------
  const fallbackRun = makeRun({
    id: "run-fallback",
    workerTasks: [
      { id: "task-1", runId: "run-fallback", title: "Build it", runtimePreference: "claude", status: "cancelled" },
      {
        id: "task-2",
        runId: "run-fallback",
        title: "Build it",
        runtimePreference: "codex",
        status: "accepted",
        supersedesTaskId: "task-1",
      },
    ],
    workerAttempts: [
      makeAttempt({ id: "attempt-1", workerTaskId: "task-1", runtime: "claude", finalReportPath: "/a.json" }),
    ],
  });
  const fallbackLessons = deriveRunLessons(fallbackRun, [
    {
      attempt: fallbackRun.workerAttempts[0],
      report: makeReport({
        status: "failed",
        summary: "Cora could not complete the claude CLI worker for this task.",
        risks: ["claude CLI failed before producing a final report: runtime API error: socket connection was closed unexpectedly."],
      }),
    },
  ]);
  check(
    "a runtime fallback yields one lesson naming the failing runtime",
    fallbackLessons.length === 1 && /Runtime claude fell back to codex/.test(fallbackLessons[0]),
    JSON.stringify(fallbackLessons),
  );
  check(
    "the fallback lesson names the error class",
    /closed socket connection/.test(fallbackLessons[0]),
    fallbackLessons[0],
  );

  const rateLimitedFallback = makeRun({
    workerTasks: fallbackRun.workerTasks,
    workerAttempts: [
      makeAttempt({
        workerTaskId: "task-1",
        runtime: "claude",
        error: "runtime rate limit before final report",
      }),
    ],
  });
  const rateLimitedLessons = deriveRunLessons(rateLimitedFallback, [
    { attempt: rateLimitedFallback.workerAttempts[0], report: null },
  ]);
  check(
    "a rate-limited runtime fallback classifies as a provider rate limit",
    rateLimitedLessons.length === 1 && /a provider rate limit/.test(rateLimitedLessons[0]),
    JSON.stringify(rateLimitedLessons),
  );

  const sameRuntimeRetry = makeRun({
    workerTasks: [
      { id: "task-1", runId: "r", title: "Build it", runtimePreference: "claude", status: "cancelled" },
      { id: "task-2", runId: "r", title: "Build it", runtimePreference: "claude", status: "accepted", supersedesTaskId: "task-1" },
    ],
    workerAttempts: [],
  });
  check(
    "a same-runtime retry is not a fallback",
    deriveRunLessons(sameRuntimeRetry, []).length === 0,
    "expected no lesson",
  );

  // --- end to end: recordRunLessons writes [auto] bullets into Cora memory --
  const reportPath = path.join(TMP_HOME, "final-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(makeReport({ risks: ["web_search hit a 429 rate limit while researching."] })),
    "utf8",
  );
  const e2eRun = makeRun({
    id: "run-e2e",
    workspaceId: "/tmp/workspace-e2e",
    workerAttempts: [makeAttempt({ finalReportPath: reportPath })],
  });
  const readReport = async (p) => JSON.parse(fs.readFileSync(p, "utf8"));
  await recordRunLessons(e2eRun, readReport);
  const memoryPath = mem.workspaceMemoryPath("/tmp/workspace-e2e");
  const today = new Date().toISOString().slice(0, 10);
  const persisted = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, "utf8") : "";
  check(
    "recordRunLessons persists an [auto] bullet with its source run id",
    persisted.includes(`- [auto ${today} run:run-e2e]`) && /web_search was rate limited/.test(persisted),
    persisted,
  );
  // Re-running the same completion must not duplicate.
  await recordRunLessons(e2eRun, readReport);
  const rerecorded = fs.readFileSync(memoryPath, "utf8");
  check(
    "re-recording the same run does not duplicate",
    (rerecorded.match(/web_search was rate limited/g) ?? []).length === 1,
    rerecorded,
  );
  // An unreadable report must not throw out of the completion seam.
  const brokenRun = makeRun({
    id: "run-broken",
    workspaceId: "/tmp/workspace-broken",
    workerAttempts: [makeAttempt({ finalReportPath: path.join(TMP_HOME, "missing.json") })],
  });
  let threw = false;
  try {
    await recordRunLessons(brokenRun, async () => {
      throw new Error("report unreadable");
    });
  } catch {
    threw = true;
  }
  check("an unreadable report never throws into run completion", !threw, "recordRunLessons threw");

  // --- source pins: the live wiring in run-store ----------------------------
  // run-store cannot be bundled standalone (it reaches Electron), so the wiring
  // that feeds Cora memory into the live builder is pinned at source level. If
  // someone drops the option, this fails instead of the feature going quiet.
  const runStoreSrc = fs.readFileSync(
    path.join(ROOT, "src", "main", "orchestration", "run-store.ts"),
    "utf8",
  );
  const turnCallSites = runStoreSrc.split("buildManagerTurnPrompt(").length - 1;
  check(
    "run-store has exactly one manager turn prompt call site",
    turnCallSites === 1,
    `found ${turnCallSites}`,
  );
  check(
    "run-store renders Cora memory through the hash-gated per-run seam",
    /formatCoraMemoryForTurn\(\s*prepared\.workspaceId,\s*prepared\.id,\s*\{\s*force:\s*includeCanonicalReplay,\s*profileId:\s*prepared\.coraProfileId,?\s*\}/s.test(
      runStoreSrc,
    ),
    "prepareManagerTurn no longer calls formatCoraMemoryForTurn",
  );
  check(
    "run-store feeds the rendered memory into the live turn prompt",
    /buildManagerTurnPrompt\(\s*prepared,\s*inputMessages,\s*\{[^}]*coraMemory/s.test(runStoreSrc),
    "prepareManagerTurn no longer passes coraMemory",
  );
  check(
    "run-store imports the memory renderer",
    /import \{[^}]*formatCoraMemoryForTurn[^}]*\} from "\.\/cora-memory"/s.test(runStoreSrc),
    "missing formatCoraMemoryForTurn import",
  );
  check(
    "run-store still records lessons at the completion seam",
    /import \{[^}]*recordRunLessons[^}]*\} from "\.\/workspace-lessons"/s.test(runStoreSrc),
    "missing recordRunLessons import",
  );
  // Both distillers walk every finished attempt's final report. They must share
  // one memoized reader, or a completed run reads and parses each report twice.
  check(
    "the completion seam shares one memoized report reader",
    /recordRunMemory\(completed, readReportOnce\)/.test(runStoreSrc) &&
      /recordRunLessons\(completed, readReportOnce\)/.test(runStoreSrc),
    "recordRunMemory and recordRunLessons no longer share a reader",
  );

  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll workspace-lessons checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
