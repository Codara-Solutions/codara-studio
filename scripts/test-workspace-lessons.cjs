// Focused coverage for the per-workspace lessons memory.
//
// Three halves (sic):
//   1. the store (src/main/orchestration/workspace-lessons.ts): cap, newest-wins
//      dedup, expiry, corrupt-file recovery, and the two auto-lesson
//      derivations including the false positives they must NOT fire on.
//   2. the LIVE injection (spark-agent-backend's buildManagerTurnPrompt, the one
//      function every shipping CLI backend's per-turn user text comes from, fed
//      by run-store's prepareManagerTurn): the lessons block must land in the
//      dynamic half and must never reach the cacheable stable prefix. The
//      run-store wiring itself is pinned by source assertion, since that module
//      cannot be bundled standalone.
//   3. the hosted-API mirror (manager-protocol's buildManagerRequest), which
//      nothing dispatches today but must stay in step if it is ever wired up.
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
const SHARED_DIR = path.join(ROOT, "src", "shared");
const PROFILE_JSON = path.join(ROOT, "resources", "orchestration", "manager-profile.json");
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codara-lessons-home-"));
const LESSONS_FILE = path.join(TMP_HOME, "lessons.json");

// Lessons expire, so every fixture timestamp is relative to now. Hardcoded
// calendar dates would quietly turn this suite into a time bomb the day they
// aged past the TTL.
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
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    // spark-home pulls in electron; the store only needs a home directory.
    build.onResolve({ filter: /\/spark-home$/ }, () => ({
      path: "spark-home-stub",
      namespace: "stub",
    }));
    // Point the profile loader at the real bundled JSON that ships.
    build.onResolve({ filter: /bundled-resources/ }, () => ({
      path: "bundled-resources-stub",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      if (args.path === "spark-home-stub") {
        return { contents: `export const sparkHome = () => ${JSON.stringify(TMP_HOME)};`, loader: "js" };
      }
      return {
        contents: `export const resolveBundledResourcePath = () => ${JSON.stringify(PROFILE_JSON)};`,
        loader: "js",
      };
    });
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

function resetStore() {
  if (fs.existsSync(LESSONS_FILE)) fs.rmSync(LESSONS_FILE);
}

// Minimal RunState the derivation and the manager prompt builder both accept.
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
  const {
    readWorkspaceLessons,
    recordWorkspaceLessons,
    formatWorkspaceLessonsSection,
    deriveRunLessons,
    recordRunLessons,
  } = store;

  // --- store: cap at 20, newest first -------------------------------------
  resetStore();
  for (let i = 1; i <= 25; i += 1) {
    recordWorkspaceLessons("/tmp/workspace-a", [
      { text: `Lesson number ${i} about this workspace.`, runId: `run-${i}`, createdAt: daysAgo(1, i) },
    ]);
  }
  const capped = readWorkspaceLessons("/tmp/workspace-a");
  check("ledger is capped at 20 entries", capped.length === 20, `got ${capped.length}`);
  check(
    "newest lesson is first",
    capped[0].text === "Lesson number 25 about this workspace." && capped[0].runId === "run-25",
    JSON.stringify(capped[0]),
  );
  check(
    "oldest surviving entry is lesson 6 (1 to 5 fell off the tail)",
    capped[19].text === "Lesson number 6 about this workspace.",
    capped[19].text,
  );

  // --- store: dedup by normalized text, newest wins -------------------------
  resetStore();
  const newestDedupAt = daysAgo(1);
  recordWorkspaceLessons("/tmp/workspace-a", [
    { text: "Stagger web searches across workers.", runId: "run-old", createdAt: daysAgo(3) },
  ]);
  recordWorkspaceLessons("/tmp/workspace-a", [
    { text: "Another unrelated lesson.", runId: "run-mid", createdAt: daysAgo(2) },
  ]);
  recordWorkspaceLessons("/tmp/workspace-a", [
    { text: "  STAGGER   web Searches   across workers  ", runId: "run-new", createdAt: newestDedupAt },
  ]);
  const deduped = readWorkspaceLessons("/tmp/workspace-a");
  check("dedup keeps a single copy", deduped.length === 2, JSON.stringify(deduped.map((l) => l.text)));
  check(
    "newest duplicate wins and moves to the front",
    deduped[0].runId === "run-new" && deduped[0].createdAt === newestDedupAt,
    JSON.stringify(deduped[0]),
  );
  check(
    "duplicate text is stored whitespace-collapsed",
    deduped[0].text === "STAGGER web Searches across workers",
    JSON.stringify(deduped[0].text),
  );
  check("unrelated lesson survives dedup", deduped[1].runId === "run-mid", JSON.stringify(deduped[1]));

  // A same-batch duplicate collapses too.
  resetStore();
  recordWorkspaceLessons("/tmp/workspace-a", [
    { text: "One sentence lesson.", runId: "run-a", createdAt: daysAgo(1) },
    { text: "one sentence lesson", runId: "run-a", createdAt: daysAgo(1) },
  ]);
  check(
    "duplicates inside one batch collapse",
    readWorkspaceLessons("/tmp/workspace-a").length === 1,
    JSON.stringify(readWorkspaceLessons("/tmp/workspace-a")),
  );

  // --- store: per-workspace isolation ---------------------------------------
  recordWorkspaceLessons("/tmp/workspace-b", [
    { text: "Workspace B only lesson.", runId: "run-b", createdAt: daysAgo(1) },
  ]);
  check(
    "lessons are keyed per workspace",
    readWorkspaceLessons("/tmp/workspace-a").length === 1 &&
      readWorkspaceLessons("/tmp/workspace-b").length === 1 &&
      readWorkspaceLessons("/tmp/workspace-unknown").length === 0,
    JSON.stringify(JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"))),
  );

  // --- store: corrupt file recovery ----------------------------------------
  fs.writeFileSync(LESSONS_FILE, "{ this is not json", "utf8");
  check(
    "corrupt file reads as no lessons",
    readWorkspaceLessons("/tmp/workspace-a").length === 0,
    "expected empty",
  );
  check("corrupt file renders no prompt section", formatWorkspaceLessonsSection("/tmp/workspace-a") === null, "expected null");
  recordWorkspaceLessons("/tmp/workspace-a", [
    { text: "Recovered after corruption.", runId: "run-fix", createdAt: daysAgo(1) },
  ]);
  const recovered = readWorkspaceLessons("/tmp/workspace-a");
  check(
    "a write after corruption rebuilds a valid store",
    recovered.length === 1 && recovered[0].text === "Recovered after corruption.",
    JSON.stringify(recovered),
  );
  check(
    "rebuilt store parses as JSON",
    (() => {
      try {
        return typeof JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8")).workspaces === "object";
      } catch {
        return false;
      }
    })(),
    fs.readFileSync(LESSONS_FILE, "utf8"),
  );

  // Structurally wrong shapes degrade rather than throw.
  fs.writeFileSync(LESSONS_FILE, JSON.stringify({ version: 1, workspaces: [1, 2, 3] }), "utf8");
  check("array-shaped workspaces map reads as empty", readWorkspaceLessons("/tmp/workspace-a").length === 0, "expected empty");
  fs.writeFileSync(
    LESSONS_FILE,
    JSON.stringify({ version: 1, workspaces: { "/tmp/workspace-a": [{ runId: "x" }, 7, { text: "  " }, { text: "Good one.", runId: "r", createdAt: "t" }] } }),
    "utf8",
  );
  const salvaged = readWorkspaceLessons("/tmp/workspace-a");
  check(
    "malformed entries are dropped and good ones survive",
    salvaged.length === 1 && salvaged[0].text === "Good one.",
    JSON.stringify(salvaged),
  );

  // --- store: expiry --------------------------------------------------------
  // A heuristic that fired wrongly must fade instead of steering the workspace
  // forever. The cap alone cannot do it: the derived vocabulary is small enough
  // that a workspace rarely reaches 20 distinct lessons, so nothing evicts.
  resetStore();
  recordWorkspaceLessons("/tmp/workspace-ttl", [
    { text: "Stale lesson from months ago.", runId: "run-stale", createdAt: daysAgo(120) },
    { text: "Fresh lesson from this week.", runId: "run-fresh", createdAt: daysAgo(3) },
  ]);
  const afterTtl = readWorkspaceLessons("/tmp/workspace-ttl");
  check(
    "an expired lesson is not returned",
    afterTtl.length === 1 && afterTtl[0].runId === "run-fresh",
    JSON.stringify(afterTtl),
  );
  check(
    "an expired lesson is not rendered into the prompt",
    !String(formatWorkspaceLessonsSection("/tmp/workspace-ttl")).includes("Stale lesson"),
    String(formatWorkspaceLessonsSection("/tmp/workspace-ttl")),
  );
  const onTheEdge = readWorkspaceLessons("/tmp/workspace-edge");
  recordWorkspaceLessons("/tmp/workspace-edge", [
    { text: "Just inside the window.", runId: "run-edge", createdAt: daysAgo(29) },
  ]);
  check(
    "a lesson inside the window survives",
    onTheEdge.length === 0 && readWorkspaceLessons("/tmp/workspace-edge").length === 1,
    JSON.stringify(readWorkspaceLessons("/tmp/workspace-edge")),
  );
  // The next write to the workspace must physically drop the expired entry,
  // not merely filter it out of reads.
  recordWorkspaceLessons("/tmp/workspace-ttl", [
    { text: "Newest lesson of all.", runId: "run-newest", createdAt: daysAgo(0) },
  ]);
  check(
    "a write prunes expired entries off disk",
    !fs.readFileSync(LESSONS_FILE, "utf8").includes("Stale lesson"),
    fs.readFileSync(LESSONS_FILE, "utf8"),
  );
  // An entry whose timestamp cannot be parsed is kept: we cannot prove it stale.
  fs.writeFileSync(
    LESSONS_FILE,
    JSON.stringify({ version: 1, workspaces: { "/tmp/workspace-ttl": [{ text: "No timestamp here.", runId: "r", createdAt: "" }] } }),
    "utf8",
  );
  check(
    "an unparseable timestamp is treated as fresh",
    readWorkspaceLessons("/tmp/workspace-ttl").length === 1,
    JSON.stringify(readWorkspaceLessons("/tmp/workspace-ttl")),
  );

  // --- store: temp files are per writer -------------------------------------
  // A fixed "lessons.json.tmp" lets two processes sharing one Codara home
  // interleave into the same scratch file and rename half a document over the
  // ledger. Squatting on that exact name proves the writer no longer wants it:
  // the old fixed-name write would fail with EISDIR and silently drop the
  // lesson, a per-writer name is unaffected.
  resetStore();
  const squatted = `${LESSONS_FILE}.tmp`;
  fs.mkdirSync(squatted, { recursive: true });
  recordWorkspaceLessons("/tmp/workspace-tmp", [
    { text: "Any lesson at all.", runId: "run-tmp", createdAt: daysAgo(1) },
  ]);
  check(
    "the writer does not depend on one shared temp filename",
    readWorkspaceLessons("/tmp/workspace-tmp").length === 1,
    JSON.stringify(readWorkspaceLessons("/tmp/workspace-tmp")),
  );
  fs.rmSync(squatted, { recursive: true, force: true });
  check(
    "no temp file is left behind after a successful write",
    fs.readdirSync(TMP_HOME).filter((entry) => entry.endsWith(".tmp")).length === 0,
    fs.readdirSync(TMP_HOME).join(", "),
  );

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

  // --- end to end: recordRunLessons at the completion seam -------------------
  resetStore();
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
  const persisted = readWorkspaceLessons("/tmp/workspace-e2e");
  check(
    "recordRunLessons persists a lesson with its source run and timestamp",
    persisted.length === 1 && persisted[0].runId === "run-e2e" && persisted[0].createdAt === e2eRun.completedAt,
    JSON.stringify(persisted),
  );
  // Re-running the same completion must not duplicate.
  await recordRunLessons(e2eRun, readReport);
  check(
    "re-recording the same run does not duplicate",
    readWorkspaceLessons("/tmp/workspace-e2e").length === 1,
    JSON.stringify(readWorkspaceLessons("/tmp/workspace-e2e")),
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

  // --- prompt section -------------------------------------------------------
  resetStore();
  for (let i = 1; i <= 7; i += 1) {
    recordWorkspaceLessons("/tmp/workspace-prompt", [
      { text: `Prompt lesson ${i} for this workspace.`, runId: `run-${i}`, createdAt: daysAgo(1, i) },
    ]);
  }
  const section = formatWorkspaceLessonsSection("/tmp/workspace-prompt");
  check("section header is present", /^WORKSPACE LESSONS /.test(section ?? ""), String(section));
  check(
    "section carries at most 5 lessons",
    (section ?? "").split("\n").filter((line) => line.startsWith("- ")).length === 5,
    String(section),
  );
  check(
    "section carries the newest lessons",
    (section ?? "").includes("Prompt lesson 7") && !(section ?? "").includes("Prompt lesson 2"),
    String(section),
  );
  check(
    "an empty workspace renders nothing",
    formatWorkspaceLessonsSection("/tmp/workspace-none") === null,
    "expected null",
  );

  // --- LIVE injection: the prompt every shipping backend actually sends ------
  // run-store's prepareManagerTurn is the single seam that builds per-turn
  // manager text for Claude, Codex and Pi alike; it renders the section and
  // hands it to buildManagerTurnPrompt. Testing buildManagerRequest alone would
  // prove nothing: nothing dispatches it.
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-lessons-ws-"));
  fs.writeFileSync(path.join(workspaceDir, "index.ts"), "export const x = 1;\n", "utf8");
  resetStore();
  const LESSON_TEXT = "Runtime claude fell back to codex after a provider rate limit.";
  recordWorkspaceLessons("/tmp/workspace-inject", [
    { text: LESSON_TEXT, runId: "run-1", createdAt: daysAgo(1) },
  ]);

  const backend = await load(path.join(ROOT, "src", "main", "orchestration", "spark-agent-backend.ts"));
  const { buildManagerTurnPrompt, assembleManagerPrompt, MANAGER_PROMPT_DYNAMIC_MARKER } = backend;

  function humanMessage(id, text) {
    return {
      id,
      runId: "run-inject",
      author: "user",
      kind: "note",
      intent: "turn",
      deliveryState: "queued",
      conversationEpoch: 0,
      message: text,
      createdAt: daysAgo(0),
    };
  }

  const liveRun = makeRun({
    id: "run-inject",
    workspaceId: "/tmp/workspace-inject",
    humanMessages: [humanMessage("u-1", "Ship the lessons ledger")],
  });
  const liveSection = formatWorkspaceLessonsSection(liveRun.workspaceId);
  const liveTurn = buildManagerTurnPrompt(liveRun, [liveRun.humanMessages[0]], {
    workspaceLessons: liveSection,
  });
  check(
    "the live turn prompt carries the lessons block",
    liveTurn.includes("WORKSPACE LESSONS") && liveTurn.includes(LESSON_TEXT),
    liveTurn,
  );
  check(
    "the lessons block sits at the tail, after this turn's user input",
    liveTurn.indexOf("WORKSPACE LESSONS") > liveTurn.indexOf("Ship the lessons ledger") &&
      liveTurn.trimEnd().endsWith("[END WORKSPACE LESSONS]"),
    liveTurn,
  );

  const guidance = "MANAGER GUIDANCE FIXTURE\nDo the work.";
  const assembled = assembleManagerPrompt({
    guidance,
    cwd: workspaceDir,
    turnPrompt: liveTurn,
  });
  check(
    "lessons never reach the cacheable stable prefix",
    !assembled.stablePrefix.includes("WORKSPACE LESSONS") && !assembled.stablePrefix.includes(LESSON_TEXT),
    assembled.stablePrefix,
  );
  check(
    "lessons land in the dynamic half, after the marker",
    assembled.dynamic.includes("WORKSPACE LESSONS") &&
      assembled.text.indexOf("WORKSPACE LESSONS") > assembled.text.indexOf(MANAGER_PROMPT_DYNAMIC_MARKER),
    assembled.text,
  );

  // A workspace with no lessons must leave the prompt byte-identical.
  const emptySection = formatWorkspaceLessonsSection("/tmp/workspace-bare");
  check(
    "an empty ledger leaves the live turn prompt untouched",
    buildManagerTurnPrompt(liveRun, [liveRun.humanMessages[0]], { workspaceLessons: emptySection }) ===
      buildManagerTurnPrompt(liveRun, [liveRun.humanMessages[0]]),
    "empty ledger changed the prompt",
  );

  // The rewind path wraps the turn input in a replay envelope; lessons must
  // still land after it rather than inside the replayed dialogue.
  const replayRun = makeRun({
    id: "run-inject",
    workspaceId: "/tmp/workspace-inject",
    humanMessages: [
      humanMessage("u-0", "Earlier canonical turn"),
      humanMessage("u-1", "Ship the lessons ledger"),
    ],
  });
  const replayTurn = buildManagerTurnPrompt(replayRun, [replayRun.humanMessages[1]], {
    includeCanonicalReplay: true,
    workspaceLessons: liveSection,
  });
  check(
    "lessons follow the canonical replay envelope",
    replayTurn.includes("CORA CONVERSATION REPLAY") &&
      replayTurn.indexOf("WORKSPACE LESSONS") > replayTurn.indexOf("[NEW USER INPUT FOR THIS TURN]"),
    replayTurn,
  );

  // run-store cannot be bundled standalone (it reaches Electron), so the wiring
  // that feeds the section into the live builder is pinned at source level. If
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
    "run-store feeds the rendered lessons section into the live turn prompt",
    /buildManagerTurnPrompt\(\s*prepared,\s*inputMessages,\s*\{[^}]*workspaceLessons:\s*formatWorkspaceLessonsSection\(\s*prepared\.workspaceId\s*\)/s.test(
      runStoreSrc,
    ),
    "prepareManagerTurn no longer passes the lessons section",
  );
  check(
    "run-store imports the section renderer",
    /import \{[^}]*formatWorkspaceLessonsSection[^}]*\} from "\.\/workspace-lessons"/s.test(runStoreSrc),
    "missing formatWorkspaceLessonsSection import",
  );
  // Both distillers walk every finished attempt's final report. They must share
  // one memoized reader, or a completed run reads and parses each report twice.
  check(
    "the completion seam shares one memoized report reader",
    /recordRunMemory\(completed, readReportOnce\)/.test(runStoreSrc) &&
      /recordRunLessons\(completed, readReportOnce\)/.test(runStoreSrc),
    "recordRunMemory and recordRunLessons no longer share a reader",
  );

  // --- hosted-API mirror (buildManagerRequest, not dispatched today) ---------
  const protocol = await load(path.join(ROOT, "src", "main", "orchestration", "manager-protocol.ts"));
  const injectRun = makeRun({ id: "run-inject", workspaceId: "/tmp/workspace-inject" });
  for (const mode of ["plan_analysis", "step_planning", "worker_result_review", "chat"]) {
    const request = protocol.buildManagerRequest({
      run: injectRun,
      cwd: workspaceDir,
      model: "test-model",
      mode,
    });
    const system = request.messages[0].content;
    const user = request.messages[1].content;
    const userText = typeof user === "string" ? user : user.map((part) => part.text ?? "").join("\n");
    check(
      `lessons reach the ${mode} user message`,
      userText.includes("WORKSPACE LESSONS") && userText.includes(LESSON_TEXT),
      `mode ${mode} user message missing the lessons block`,
    );
    check(
      `lessons stay out of the ${mode} system prompt (stable prefix)`,
      !String(system).includes("WORKSPACE LESSONS"),
      `mode ${mode} system prompt contains the lessons block`,
    );
    const tailIndex = userText.indexOf("WORKSPACE LESSONS");
    check(
      `lessons sit in the ${mode} dynamic tail, after the run state`,
      tailIndex > userText.indexOf("RUN STATE"),
      `lessons at ${tailIndex}, RUN STATE at ${userText.indexOf("RUN STATE")}`,
    );
  }

  // A workspace with no lessons must not grow a section.
  const bareRequest = protocol.buildManagerRequest({
    run: makeRun({ id: "run-bare", workspaceId: "/tmp/workspace-bare" }),
    cwd: workspaceDir,
    model: "test-model",
    mode: "plan_analysis",
  });
  const bareUser = bareRequest.messages[1].content;
  check(
    "a workspace with no lessons costs no tokens",
    !String(typeof bareUser === "string" ? bareUser : JSON.stringify(bareUser)).includes("WORKSPACE LESSONS"),
    "unexpected lessons block",
  );

  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  fs.rmSync(workspaceDir, { recursive: true, force: true });
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
