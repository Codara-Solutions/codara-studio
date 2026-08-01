// Focused regressions for Cora's managed Codex launch + rollout ownership.
//
//   node scripts/test-codex-manager-session.cjs
//   SPARK_LIVE_CODEX_CONFIG_TEST=1 node scripts/test-codex-manager-session.cjs
//
// The optional live check asks the installed Codex CLI to parse the exact
// manager argv via `doctor --summary`; it does not start a model turn.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-codex-manager-"));
const SHARED_DIR = path.join(ROOT, "src", "shared");

const aliasPlugin = {
  name: "codex-manager-test-aliases",
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
function check(name, condition) {
  if (!condition) throw new Error(`FAIL ${name}`);
  passed += 1;
  console.log(`PASS ${name}`);
}

function uuid(seed) {
  return `00000000-0000-4000-8000-${String(seed).padStart(12, "0")}`;
}

async function writeRollout(file, { cwd, startedAt, message }) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const lines = [
    {
      timestamp: startedAt,
      type: "session_meta",
      payload: { id: path.basename(file), timestamp: startedAt, cwd, source: "cli" },
    },
  ];
  if (message) {
    lines.push({
      timestamp: startedAt,
      type: "event_msg",
      payload: { type: "agent_message", message },
    });
  }
  await fsp.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

async function main() {
  const launch = await bundle(
    "launch",
    path.join(ROOT, "src", "main", "orchestration", "codex-manager-launch.ts"),
  );
  const sessions = await bundle(
    "sessions",
    path.join(ROOT, "src", "main", "orchestration", "codex-sessions.ts"),
  );
  const terminalDecision = await bundle(
    "terminal-decision",
    path.join(ROOT, "src", "main", "orchestration", "cli-terminal-decision.ts"),
  );
  const backendContract = await bundle(
    "backend-contract",
    path.join(ROOT, "src", "main", "orchestration", "spark-agent-backend.ts"),
  );

  const promptPath = path.join(ROOT, "resources", "orchestration", "codex-auto-prompt.md");
  const args = launch.buildCodexManagerArgs(
    {
      model: "gpt-5.6-sol",
      effort: "medium",
      fastMode: false,
      mode: "auto",
    },
    promptPath,
    path.join(TMP, "managed-home"),
    "run-managed-test",
  );
  check("manager launches with explicit --yolo", args.includes("--yolo"));
  check(
    "manager does not mix conflicting approval or sandbox flags with --yolo",
    !args.includes("-a") && !args.includes("-s") && !args.includes("read-only"),
  );
  check(
    "MCP dotted override uses the Codex-accepted bare key",
    args.includes('mcp_servers.codara-studio.env.SPARK_MCP_MODE="execute"') &&
      !args.some((arg) => arg.includes('mcp_servers."codara-studio"')),
  );
  check(
    "manager pins the MCP handshake to Codara's active home",
    args.includes(
      `mcp_servers.codara-studio.env.SPARK_HOME_DIR="${path.join(TMP, "managed-home")}"`,
    ),
  );
  check(
    "manager pins orchestration tools to the owning run",
    args.includes('mcp_servers.codara-studio.env.SPARK_RUN_ID="run-managed-test"'),
  );
  const resumeArgs = launch.buildCodexManagerArgs(
    {
      sessionUuid: uuid(9),
      model: "gpt-5.6-sol",
      effort: "max",
      fastMode: true,
      mode: "automation",
    },
    promptPath,
  );
  check("resume binds the explicit session UUID", resumeArgs[0] === "resume" && resumeArgs[1] === uuid(9));
  check(
    "automation selects its own MCP roster",
    resumeArgs.includes('mcp_servers.codara-studio.env.SPARK_MCP_MODE="automation"'),
  );
  check(
    "fresh post-rewind launch cannot resume an old Codex UUID",
    args[0] !== "resume" && !args.includes(uuid(9)),
  );

  const replayRun = {
    id: "run-replay",
    workspaceId: "ws",
    title: "Replay",
    status: "planning",
    artifactDir: TMP,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:04.000Z",
    conversationEpoch: 1,
    plans: [],
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    sparkCalls: [],
    humanMessages: [
      { id: "u-old", runId: "run-replay", author: "user", kind: "note", intent: "turn", deliveryState: "acknowledged", conversationEpoch: 0, message: "Retained user context", createdAt: "2026-07-13T00:00:01.000Z" },
      { id: "s-old", runId: "run-replay", author: "spark", kind: "note", intent: "answer", deliveryState: "acknowledged", conversationEpoch: 0, message: "Retained Cora answer", createdAt: "2026-07-13T00:00:02.000Z" },
      { id: "sys", runId: "run-replay", author: "system", kind: "note", intent: "answer", deliveryState: "acknowledged", conversationEpoch: 0, message: "RAW_TOOL_NOISE", createdAt: "2026-07-13T00:00:03.000Z" },
      { id: "u-new-1", runId: "run-replay", author: "user", kind: "note", intent: "turn", deliveryState: "queued", conversationEpoch: 1, message: "First new instruction", createdAt: "2026-07-13T00:00:04.000Z" },
      { id: "u-new-2", runId: "run-replay", author: "user", kind: "note", intent: "steer", deliveryState: "queued", conversationEpoch: 1, message: "Then preserve this detail", createdAt: "2026-07-13T00:00:05.000Z" },
    ],
  };
  const selectedReplayInput = replayRun.humanMessages.slice(-2);
  const replayPrompt = backendContract.buildManagerTurnPrompt(
    replayRun,
    selectedReplayInput,
    { includeCanonicalReplay: true },
  );
  check(
    "post-rewind prompt replays retained canonical dialogue only",
    replayPrompt.includes("You: Retained user context") &&
      replayPrompt.includes("Cora: Retained Cora answer") &&
      !replayPrompt.includes("RAW_TOOL_NOISE"),
  );
  check(
    "immutable manager bundle preserves ordered exactly-once steering",
    replayPrompt.indexOf("First new instruction") < replayPrompt.indexOf("Then preserve this detail") &&
      replayPrompt.match(/First new instruction/g)?.length === 1 &&
      replayPrompt.match(/Then preserve this detail/g)?.length === 1,
  );
  const currentTurnRun = {
    ...replayRun,
    sparkCalls: [{ id: "spark-new", runId: replayRun.id, mode: "chat", model: "gpt-5.6-sol", status: "started", conversationEpoch: 1, createdAt: "2026-07-13T00:00:06.000Z" }],
  };
  const preSubmissionRetryRun = {
    ...currentTurnRun,
    sparkCalls: [{ ...currentTurnRun.sparkCalls[0], status: "failed", inputMessageIds: ["u-new-1"] }],
  };
  const acceptedTurnRun = {
    ...currentTurnRun,
    humanMessages: currentTurnRun.humanMessages.map((message) =>
      message.id === "u-new-1"
        ? { ...message, deliveryState: "acknowledged", backendTurnId: "spark-new" }
        : message,
    ),
  };
  check(
    "pre-submission retry retains canonical replay ownership",
    backendContract.shouldIncludeCanonicalReplay(preSubmissionRetryRun, 1) &&
      !backendContract.shouldIncludeCanonicalReplay(acceptedTurnRun, 1),
  );
  check(
    "old-epoch manager completion is rejected",
    backendContract.isManagerTurnCurrent(currentTurnRun, "spark-new", 1) &&
      !backendContract.isManagerTurnCurrent(currentTurnRun, "spark-new", 0),
  );
  check(
    "late checkpoint jobs are rejected after epoch change or message removal",
    !backendContract.isCheckpointJobCurrent(currentTurnRun, 0, "u-new-1") &&
      !backendContract.isCheckpointJobCurrent(currentTurnRun, 1, "removed-message") &&
      backendContract.isCheckpointJobCurrent(currentTurnRun, 1, "u-new-1"),
  );

  const twoClaude = terminalDecision.buildSpawnTerminalsDecisionFromToolCalls(
    [
      {
        toolName: "codara_spawn_terminals",
        input: { terminals: [{ runtime: "claude", count: 2 }] },
      },
    ],
    "",
  );
  check(
    "Codex terminal tool becomes one standing-terminal decision",
    twoClaude?.status === "spawn_terminals" &&
      twoClaude.terminals?.length === 1 &&
      twoClaude.terminals[0].runtime === "claude" &&
      twoClaude.terminals[0].count === 2 &&
      twoClaude.steps.length === 0 &&
      twoClaude.tasks.length === 0,
  );
  const mixed = terminalDecision.buildSpawnTerminalsDecisionFromToolCalls(
    [
      {
        toolName: "mcp__codara-studio__codara_spawn_terminals",
        input: {
          terminals: [
            { runtime: "claude", count: 1, model: "claude-opus-4-8", effort: "high" },
            { runtime: "codex", count: 20, model: "gpt-5.6-sol", effort: "max" },
          ],
        },
      },
    ],
    "Opening your sessions.",
  );
  check(
    "Claude-prefixed tool preserves mixed configs and caps the grid at eight panes",
    mixed?.status === "spawn_terminals" &&
      mixed.chatReply === "Opening your sessions." &&
      mixed.terminals?.length === 2 &&
      mixed.terminals[0].model === "claude-opus-4-8" &&
      mixed.terminals[1].model === "gpt-5.6-sol" &&
      mixed.terminals[1].effort === "max" &&
      mixed.terminals.reduce((sum, terminal) => sum + terminal.count, 0) === 8,
  );

  const oldHome = process.env.HOME;
  const fakeHome = path.join(TMP, "home");
  process.env.HOME = fakeHome;
  try {
    const spawnDate = new Date();
    const since = Date.now();
    const cwd = path.join(TMP, "workspace");
    const otherCwd = path.join(TMP, "other-workspace");
    const dir = sessions.sessionsDirFor(spawnDate);
    const preexisting = path.join(dir, `rollout-preexisting-${uuid(1)}.jsonl`);
    await writeRollout(preexisting, {
      cwd,
      startedAt: new Date(since - 60_000).toISOString(),
      message: "private pre-existing transcript",
    });
    const snapshot = await sessions.snapshotRolloutPaths(spawnDate);
    check("pre-spawn snapshot records existing rollouts", snapshot.has(preexisting));

    // Make the old file look newest by mtime, exactly like an active personal
    // Codex window. It must still be ineligible for this fresh Cora spawn.
    await fsp.utimes(preexisting, new Date(since + 8_000), new Date(since + 8_000));
    const foreign = path.join(dir, `rollout-foreign-${uuid(2)}.jsonl`);
    await writeRollout(foreign, {
      cwd: otherCwd,
      startedAt: new Date(since + 100).toISOString(),
      message: "foreign workspace transcript",
    });
    await fsp.utimes(foreign, new Date(since + 7_000), new Date(since + 7_000));

    const noOwner = await sessions.discoverRolloutForCwd(since, spawnDate, cwd, {
      strict: true,
      excludePaths: snapshot,
      createdAfter: since,
    });
    check("fresh discovery rejects pre-existing and cross-workspace transcripts", noOwner === null);

    const owned = path.join(dir, `rollout-owned-${uuid(3)}.jsonl`);
    await writeRollout(owned, {
      cwd,
      startedAt: new Date(since + 200).toISOString(),
      message: "owned Cora transcript",
    });
    await fsp.utimes(owned, new Date(since + 6_000), new Date(since + 6_000));
    const found = await sessions.discoverRolloutForCwd(since, spawnDate, cwd, {
      strict: true,
      excludePaths: snapshot,
      createdAfter: since,
    });
    check("fresh discovery selects the newly-created matching-cwd rollout", found === owned);

    const resumeId = uuid(4);
    const resumed = path.join(dir, `rollout-resume-${resumeId}.jsonl`);
    await writeRollout(resumed, {
      cwd,
      startedAt: new Date(since - 86_400_000).toISOString(),
      message: "old owned session",
    });
    await fsp.utimes(resumed, new Date(since + 9_000), new Date(since + 9_000));
    const resumedFound = await sessions.discoverRolloutForCwd(since, spawnDate, cwd, {
      strict: true,
      sessionUuid: resumeId,
    });
    check("resume discovery binds by exact UUID even for an old session", resumedFound === resumed);

    const accountAHome = path.join(TMP, "codex-account-a");
    const accountBHome = path.join(TMP, "codex-account-b");
    const accountAId = uuid(5);
    const accountBId = uuid(6);
    const accountARollout = path.join(
      sessions.sessionsDirFor(spawnDate, accountAHome),
      `rollout-account-a-${accountAId}.jsonl`,
    );
    const accountBRollout = path.join(
      sessions.sessionsDirFor(spawnDate, accountBHome),
      `rollout-account-b-${accountBId}.jsonl`,
    );
    await writeRollout(accountARollout, {
      cwd,
      startedAt: new Date(since + 300).toISOString(),
      message: "account A",
    });
    await writeRollout(accountBRollout, {
      cwd,
      startedAt: new Date(since + 400).toISOString(),
      message: "account B",
    });
    const accountASnapshot = await sessions.snapshotRolloutPaths(
      spawnDate,
      accountAHome,
    );
    check(
      "Explicit rollout snapshots cannot see another Codex home",
      accountASnapshot.has(accountARollout) &&
        !accountASnapshot.has(accountBRollout),
    );
    const accountBFound = await sessions.discoverRolloutForCwd(
      since,
      spawnDate,
      cwd,
      { strict: true, codexHome: accountBHome },
    );
    check(
      "Explicit rollout discovery stays in the selected Codex home",
      accountBFound === accountBRollout,
    );
    await fsp
      .access(accountARollout)
      .then(async () => {
        let crossHomeRejected = false;
        try {
          await sessions.readRolloutMetadata(accountARollout, accountBHome);
        } catch {
          crossHomeRejected = true;
        }
        check(
          "Transcript metadata reads reject cross-home paths",
          crossHomeRejected,
        );
      });
    if (process.platform !== "win32") {
      const linkedSessionHome = path.join(TMP, "codex-linked-session-home");
      const linkedSessionsRoot = path.join(linkedSessionHome, "sessions");
      await fsp.mkdir(linkedSessionsRoot, { recursive: true });
      await fsp.symlink(
        path.join(accountAHome, "sessions", String(spawnDate.getFullYear())),
        path.join(linkedSessionsRoot, String(spawnDate.getFullYear())),
        "dir",
      );
      let linkedDirectoryRejected = false;
      try {
        await sessions.snapshotRolloutPaths(spawnDate, linkedSessionHome);
      } catch {
        linkedDirectoryRejected = true;
      }
      check(
        "Rollout discovery rejects nested session-directory symlinks",
        linkedDirectoryRejected,
      );
    }
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }

  if (process.env.SPARK_LIVE_CODEX_CONFIG_TEST === "1") {
    const doctor = spawnSync("codex", [...args, "doctor", "--summary"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    check(
      `installed Codex parses exact manager argv (exit ${doctor.status})`,
      doctor.status === 0 &&
        /sandbox\s+unrestricted fs \+ enabled network/i.test(doctor.stdout) &&
        /approval\s+never/i.test(doctor.stdout),
    );
  }

  console.log(`\nAll ${passed} Codex manager-session checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
