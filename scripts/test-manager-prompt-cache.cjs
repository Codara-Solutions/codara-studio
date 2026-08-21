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
    "agent-backend",
    path.join(ROOT, "src", "main", "orchestration", "agent-backend.ts"),
  );
  const {
    MANAGER_PROMPT_DYNAMIC_MARKER,
    assembleManagerPrompt,
    buildManagerStablePrefix,
    buildManagerTurnPrompt,
  } = backend;

  // A stand-in for the manager's shipped system guidance. The retired CLI
  // backends read markdown resource files; Pi's guidance is bundled in the
  // harness, so the seam contract is what matters here, not the exact bytes.
  const guidance = "You are Cora's manager.\nDelegate the work; do not code yourself.\n";
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

  // Cora memory rides the dynamic half only. The rendered sections change as
  // memory files are written or edited, so a single byte of them in the stable
  // prefix would split the prompt cache on every memory write; and they must
  // sit after the turn's user input, before the subscription-headroom tail.
  const memoryNeedle = [
    "CORA MEMORY, THIS WORKSPACE (user-editable file: /tmp/mem.md; overrides the global section on conflict)",
    "- [cora 2026-07-01] The user prefers tabs over spaces.",
    "[END CORA MEMORY WORKSPACE]",
  ].join("\n");
  const headroomNeedle = "SUBSCRIPTION HEADROOM fixture for ordering";
  const promptWithMemory = assembleManagerPrompt({
    guidance,
    cwd,
    turnPrompt: buildManagerTurnPrompt(turnN, [turnN.humanMessages[2]], {
      coraMemory: memoryNeedle,
      subscriptionHeadroom: headroomNeedle,
    }),
  });
  check(
    "cora memory lands in the dynamic half, never the stable prefix",
    promptWithMemory.dynamic.includes("CORA MEMORY, THIS WORKSPACE") &&
      promptWithMemory.dynamic.includes("The user prefers tabs over spaces.") &&
      !promptWithMemory.stablePrefix.includes("CORA MEMORY") &&
      !promptWithMemory.stablePrefix.includes("prefers tabs"),
    promptWithMemory.stablePrefix.slice(-200),
  );
  check(
    "cora memory sits after the turn input and before the headroom tail",
    promptWithMemory.dynamic.indexOf("CORA MEMORY, THIS WORKSPACE") >
      promptWithMemory.dynamic.indexOf("Also add a test") &&
      promptWithMemory.dynamic.indexOf("CORA MEMORY, THIS WORKSPACE") <
        promptWithMemory.dynamic.indexOf(headroomNeedle),
    promptWithMemory.dynamic,
  );
  check(
    "a memory-carrying turn leaves the cacheable prefix byte-identical",
    prefixOf(promptWithMemory) === prefixOf(promptOne),
  );
  check(
    "a turn with no memory to inject leaves the prompt untouched",
    buildManagerTurnPrompt(turnN, [turnN.humanMessages[2]], { coraMemory: null }) ===
      buildManagerTurnPrompt(turnN, [turnN.humanMessages[2]]),
  );

  // buildManagerStablePrefix takes primitives on purpose: a builder that cannot
  // see the RunState cannot leak a timestamp into the cached half.
  check(
    "the stable prefix builder is a pure function of guidance + cwd",
    buildManagerStablePrefix({ guidance, cwd }) === promptOne.stablePrefix &&
      buildManagerStablePrefix({ guidance, cwd }) === buildManagerStablePrefix({ guidance, cwd }),
  );

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
