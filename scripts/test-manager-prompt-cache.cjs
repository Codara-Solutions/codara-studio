// Pins the prompt-cache contract for Cora manager turns.
//
//   node scripts/test-manager-prompt-cache.cjs
//
// A manager turn is assembled as
//
//   <stable prefix>  MANAGER_PROMPT_DYNAMIC_MARKER  <per-turn dynamic suffix>
//
// The stable prefix is the only half a provider can cache, and it is only
// cacheable while it stays byte-identical from one turn of a run to the next.
// So the checks below assemble the same run's prompt twice with a different
// clock, different worker tasks, different attempts, different spark calls, new
// assumptions, and new chat messages, and demand that everything up to the
// marker is byte-for-byte the same. Anything that moved run state, a timestamp,
// or a worker digest into the prefix fails here.
//
// Exits non-zero on any failed assertion.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-manager-prompt-cache-"));
const SHARED_DIR = path.join(ROOT, "src", "shared");

const aliasPlugin = {
  name: "manager-prompt-cache-test-aliases",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

async function bundle(name, entry) {
  const outfile = path.join(TMP, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins: [aliasPlugin],
    logLevel: "silent",
  });
  return require(outfile);
}

let passed = 0;
function check(name, condition, detail) {
  if (!condition) throw new Error(`FAIL ${name}${detail ? ` · ${detail}` : ""}`);
  passed += 1;
  console.log(`PASS ${name}`);
}

function message(id, author, text, createdAt, deliveryState) {
  return {
    id,
    runId: "run-cache",
    author,
    kind: "note",
    intent: "turn",
    deliveryState,
    conversationEpoch: 0,
    message: text,
    createdAt,
  };
}

// Turn 1: a young run, one queued user message, nothing has executed yet.
function runAtTurnOne() {
  return {
    id: "run-cache",
    title: "cache pinning",
    status: "running",
    workspaceId: "ws-cache",
    cwd: "/tmp/workspace",
    artifactDir: "/tmp/workspace/.artifacts",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:01.000Z",
    conversationEpoch: 0,
    plans: [],
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    sparkCalls: [],
    assumptions: [],
    humanMessages: [
      message("u-1", "user", "Build the thing", "2026-07-24T00:00:01.000Z", "queued"),
    ],
  };
}

// Turn N of the SAME run: later clock, workers spawned and finished, a verifier
// report in hand, spark calls accumulated, an autonomous assumption resolved,
// and a fresh queued user message. Every field a "put the run state in the
// prompt" refactor would reach for is different here.
function runAtTurnN() {
  return {
    ...runAtTurnOne(),
    status: "reviewing",
    updatedAt: "2026-07-24T04:17:33.812Z",
    completedAt: "2026-07-24T04:17:33.812Z",
    taskComplexity: "standard",
    steps: [
      {
        id: "step-1",
        runId: "run-cache",
        index: 0,
        title: "Implement",
        status: "reviewing",
        acceptanceCriteria: ["It works"],
        createdAt: "2026-07-24T00:01:00.000Z",
        updatedAt: "2026-07-24T04:00:00.000Z",
      },
    ],
    workerTasks: [
      {
        id: "task-1",
        runId: "run-cache",
        stepId: "step-1",
        title: "Implement the thing",
        status: "accepted",
        taskClass: "feature",
        createdAt: "2026-07-24T00:01:00.000Z",
        updatedAt: "2026-07-24T04:00:00.000Z",
      },
      {
        id: "task-2",
        runId: "run-cache",
        stepId: "step-1",
        title: "Verify: Implement",
        status: "accepted",
        taskClass: "verifier",
        createdAt: "2026-07-24T02:00:00.000Z",
        updatedAt: "2026-07-24T04:10:00.000Z",
      },
    ],
    workerAttempts: [
      {
        id: "att-1",
        workerTaskId: "task-1",
        status: "succeeded",
        runtime: "claude",
        finalReportPath: "/tmp/workspace/.artifacts/att-1/final-report.json",
        createdAt: "2026-07-24T00:02:00.000Z",
        updatedAt: "2026-07-24T04:00:00.000Z",
      },
    ],
    sparkCalls: [
      {
        id: "spark-1",
        runId: "run-cache",
        mode: "chat",
        model: "claude-opus-5",
        status: "succeeded",
        conversationEpoch: 0,
        createdAt: "2026-07-24T00:00:02.000Z",
        completedAt: "2026-07-24T00:00:40.000Z",
      },
    ],
    assumptions: [
      { question: "Which package manager?", selectedAnswer: "npm" },
    ],
    humanMessages: [
      message("u-1", "user", "Build the thing", "2026-07-24T00:00:01.000Z", "acknowledged"),
      message("s-1", "spark", "Spawned two workers.", "2026-07-24T00:00:41.000Z", "acknowledged"),
      message("u-2", "user", "Also add a test", "2026-07-24T04:17:33.000Z", "queued"),
    ],
  };
}

async function main() {
  const backend = await bundle(
    "spark-agent-backend",
    path.join(ROOT, "src", "main", "orchestration", "spark-agent-backend.ts"),
  );
  const {
    MANAGER_PROMPT_DYNAMIC_MARKER,
    assembleManagerPrompt,
    buildManagerStablePrefix,
    buildManagerTurnPrompt,
    forgetRunManagerGuidance,
    loadRunManagerGuidance,
  } = backend;

  // The real shipped guidance, not a fixture: if a resource file ever grows a
  // per-turn interpolation this test should be the thing that notices.
  const guidance = fs.readFileSync(
    path.join(ROOT, "resources", "orchestration", "cc-auto-prompt.md"),
    "utf8",
  );
  const cwd = "/tmp/workspace";

  const turnOne = runAtTurnOne();
  const turnN = runAtTurnN();

  const promptOne = assembleManagerPrompt({
    guidance,
    cwd,
    turnPrompt: buildManagerTurnPrompt(turnOne, [turnOne.humanMessages[0]]),
  });
  const promptN = assembleManagerPrompt({
    guidance,
    cwd,
    turnPrompt: buildManagerTurnPrompt(turnN, [turnN.humanMessages[2]]),
  });

  const prefixOf = (parts) => parts.text.slice(0, parts.text.indexOf(MANAGER_PROMPT_DYNAMIC_MARKER));
  check(
    "the dynamic marker is present in both assemblies",
    promptOne.text.includes(MANAGER_PROMPT_DYNAMIC_MARKER) &&
      promptN.text.includes(MANAGER_PROMPT_DYNAMIC_MARKER),
  );
  check(
    "everything up to the marker is byte-identical across turns of one run",
    prefixOf(promptOne) === prefixOf(promptN),
  );
  check(
    "the cacheable half is exactly the stable prefix",
    promptOne.stablePrefix === promptN.stablePrefix &&
      prefixOf(promptOne) === `${promptOne.stablePrefix}\n`,
  );
  check("the stable prefix carries the workspace cwd", promptOne.stablePrefix.includes(`Workspace cwd: ${cwd}`));

  // Negative side: the run state that changed HAS to show up, just after the
  // marker. Otherwise this test would also pass on a build that dropped it.
  check(
    "the turn's new user message lands in the dynamic half",
    promptN.dynamic.includes("Also add a test") && !promptN.stablePrefix.includes("Also add a test"),
  );
  check(
    "resolved assumptions land in the dynamic half",
    promptN.dynamic.includes("Which package manager?") &&
      !promptN.stablePrefix.includes("Which package manager?"),
  );

  // Anything clock- or progress-shaped must be absent from the prefix. These
  // are the exact strings a future "give the manager fresh context" change
  // would be tempted to interpolate into the system prompt.
  const forbidden = [
    turnN.updatedAt,
    turnN.completedAt,
    "task-1",
    "task-2",
    "att-1",
    "spark-1",
    "Verify: Implement",
    "reviewing",
  ];
  for (const needle of forbidden) {
    check(
      `the stable prefix carries no run state (${needle})`,
      !promptOne.stablePrefix.includes(needle) && !promptN.stablePrefix.includes(needle),
    );
  }

  // buildManagerStablePrefix takes primitives on purpose: a builder that cannot
  // see the RunState cannot leak a timestamp into the cached half.
  check(
    "the stable prefix builder is a pure function of guidance + cwd",
    buildManagerStablePrefix({ guidance, cwd }) === promptOne.stablePrefix &&
      buildManagerStablePrefix({ guidance, cwd }) === buildManagerStablePrefix({ guidance, cwd }),
  );

  // Guidance is pinned per run: a resource file edited mid-conversation must
  // not split the live prompt cache between turn N and turn N+1.
  let reads = 0;
  const readV1 = async () => {
    reads += 1;
    return "GUIDANCE V1";
  };
  const readV2 = async () => {
    reads += 1;
    return "GUIDANCE V2";
  };
  const first = await loadRunManagerGuidance("run-cache", "auto:/p/cc-auto-prompt.md", readV1);
  const second = await loadRunManagerGuidance("run-cache", "auto:/p/cc-auto-prompt.md", readV2);
  check("guidance is read once per run", reads === 1, `reads=${reads}`);
  check("a mid-run file edit cannot change the pinned bytes", first === second && second === "GUIDANCE V1");

  const afterModeFlip = await loadRunManagerGuidance(
    "run-cache",
    "execute:/p/cc-execute-prompt.md",
    readV2,
  );
  check("a different mode re-reads its own guidance", afterModeFlip === "GUIDANCE V2" && reads === 2);

  const otherRun = await loadRunManagerGuidance("run-other", "auto:/p/cc-auto-prompt.md", readV2);
  check("a different run reads the file again", otherRun === "GUIDANCE V2" && reads === 3);

  forgetRunManagerGuidance("run-cache");
  const afterDispose = await loadRunManagerGuidance("run-cache", "auto:/p/cc-auto-prompt.md", readV2);
  check("disposing a chat drops its pinned guidance", afterDispose === "GUIDANCE V2" && reads === 4);

  // The pin is bounded, so a long-lived app cannot hold every prompt file it
  // ever read. Eviction is least-recently-used: pin 200 idle runs, then confirm
  // the oldest was dropped (it re-reads) while the newest is still pinned.
  const key = "auto:/p/cc-auto-prompt.md";
  const readMarker = async () => {
    reads += 1;
    return "GUIDANCE EVICTED";
  };
  for (let i = 0; i < 200; i += 1) {
    await loadRunManagerGuidance(`run-bulk-${i}`, key, async () => `GUIDANCE ${i}`);
  }
  const evictedReads = reads;
  const oldest = await loadRunManagerGuidance("run-bulk-0", key, readMarker);
  check("the pin evicts the least recently used run", oldest === "GUIDANCE EVICTED" && reads === evictedReads + 1);
  const newest = await loadRunManagerGuidance("run-bulk-199", key, readMarker);
  check("the pin keeps the most recently used run", newest === "GUIDANCE 199" && reads === evictedReads + 1);

  console.log(`\nAll ${passed} manager prompt-cache checks passed.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
