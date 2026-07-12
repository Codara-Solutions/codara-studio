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
