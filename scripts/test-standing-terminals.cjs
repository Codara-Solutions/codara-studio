// Harness for codara_spawn_terminals' main-side pieces: the manager decision
// built from the tool call (src/main/orchestration/cli-terminal-decision.ts)
// and the launch commands and labels of the panes it opens
// (src/main/orchestration/standing-terminals.ts). Guards that every agent
// the + menu offers (Claude Code, Codex, Grok, Pi) survives the decision and
// launches the way the + menu launches it, and that Claude and Codex
// commands keep their exact shape.
//
//   node scripts/test-standing-terminals.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function bundle(entry, name) {
  const outfile = path.join(os.tmpdir(), "codara-standing-terminals-test", name);
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    outfile, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src/shared") },
  });
  return require(outfile);
}

(async () => {
  const standing = await bundle("src/main/orchestration/standing-terminals.ts", "standing-terminals.cjs");
  const decision = await bundle("src/main/orchestration/cli-terminal-decision.ts", "cli-terminal-decision.cjs");
  const launches = await bundle("src/renderer/src/workers/launch-commands.ts", "launch-commands.cjs");

  // With no model or effort, a standing pane is exactly the + menu's pane.
  assert.equal(standing.buildStandingTerminalCommand("claude"), launches.CLAUDE_LAUNCH_COMMAND);
  assert.equal(standing.buildStandingTerminalCommand("codex"), launches.CODEX_LAUNCH_COMMAND);
  assert.equal(standing.buildStandingTerminalCommand("grok"), launches.GROK_LAUNCH_COMMAND);
  assert.equal(standing.buildStandingTerminalCommand("pi"), launches.PI_LAUNCH_COMMAND);

  assert.equal(
    standing.buildStandingTerminalCommand("claude", "opus", "high"),
    "claude --dangerously-skip-permissions --model opus --effort high",
  );
  assert.equal(
    standing.buildStandingTerminalCommand("grok", "grok-5", "max"),
    "grok --yolo -m grok-5 --effort max",
  );
  assert.equal(
    standing.buildStandingTerminalCommand("pi", "anthropic/claude-sonnet-4-5", "high"),
    "pi --model anthropic/claude-sonnet-4-5 --thinking high",
    "Pi takes a model pattern and its thinking level",
  );
  assert.equal(standing.buildStandingTerminalCommand("pi", " ", "turbo"), "pi", "blank models and unknown efforts are dropped");

  assert.equal(standing.standingTerminalTitle("pi"), "Pi");
  assert.equal(standing.standingTerminalTitle("grok", "grok-5"), "Grok grok-5");
  const batch = [{ runtime: "claude" }, { runtime: "pi" }, { runtime: "pi" }];
  assert.equal(
    standing.describeSpawnedTerminals(batch),
    "Opened 1 Claude and 2 Pi standing terminals in the workbench, yours to prompt and drive directly.",
  );
  assert.equal(standing.spawnedTerminalsTitle(batch), "Claude x1 + Pi x2 terminals");

  assert.deepEqual(
    decision.normalizeCliTerminalRequests([
      { runtime: "grok", count: 1 },
      { runtime: "pi", count: 2, model: "openai/gpt-6", effort: "low" },
      { runtime: "aider", count: 1 },
      { runtime: "codex", count: 9 },
    ]),
    [
      { runtime: "grok", count: 1, model: undefined, effort: undefined },
      { runtime: "pi", count: 2, model: "openai/gpt-6", effort: "low" },
      { runtime: "codex", count: 5, model: undefined, effort: undefined },
    ],
    "Grok and Pi requests survive; unknown runtimes drop; the pane cap holds",
  );
  const piDecision = decision.buildSpawnTerminalsDecisionFromToolCalls(
    [{ toolName: "mcp__codara-studio__codara_spawn_terminals", input: { terminals: [{ runtime: "pi", count: 1 }] } }],
    "",
  );
  assert.equal(piDecision?.status, "spawn_terminals", "a Pi-only request is a terminal decision, not a silent no-op");
  assert.deepEqual(piDecision.terminals.map((t) => t.runtime), ["pi"]);

  console.log("Standing terminal decision and launch checks passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
