// The owner's auto-compact limit (Settings > Behavior), from the stored
// percentage to every runtime that receives it per launch:
//
// - thresholds per model, priced off the model catalog's window
// - the Codex `-c model_auto_compact_token_limit=<tokens>` value
// - the Claude `--settings` file carrying CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
//   written only inside Codara's own home
// - the standing terminal commands that carry both
// - the Behavior row offering the choices
//
//   node scripts/test-autocompact-limits.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-autocompact-limits-")));

async function bundle(entry, name) {
  const outfile = path.join(TMP, name);
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    outfile, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src/shared") },
    plugins: [{
      // codara-home reads app paths only when CODARA_HOME_DIR is unset; every
      // call here passes its home explicitly.
      name: "electron-stub",
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "electron-stub" }));
        build.onLoad({ filter: /.*/, namespace: "electron-stub" }, () => ({ contents: "module.exports = { app: undefined };", loader: "js" }));
      },
    }],
  });
  return require(outfile);
}

(async () => {
  const shared = await bundle("src/shared/context-compaction.ts", "context-compaction.cjs");
  const windows = await bundle("src/shared/context-window.ts", "context-window.cjs");
  const cli = await bundle("src/main/orchestration/cli-autocompact.ts", "cli-autocompact.cjs");
  const standing = await bundle("src/main/orchestration/standing-terminals.ts", "standing-terminals.cjs");

  // Normalization: only whole percentages Codara supports; anything else is Auto.
  assert.equal(shared.normalizeAutoCompactPercent(70), 70);
  assert.equal(shared.normalizeAutoCompactPercent("85"), 85);
  assert.equal(shared.normalizeAutoCompactPercent(74.6), 75);
  for (const value of [null, undefined, "", "abc", 0, 29, 96, 150, -5, NaN, Infinity, {}]) {
    assert.equal(shared.normalizeAutoCompactPercent(value), null, `${String(value)} is Auto`);
  }
  for (const choice of shared.AUTO_COMPACT_PERCENT_CHOICES) {
    assert.equal(shared.normalizeAutoCompactPercent(choice), choice, `every offered choice survives storage (${choice})`);
  }

  // Thresholds per model: the percentage of each model's own window, never
  // later than Pi's trigger, never below the floor.
  const limitFor = (model, percent) =>
    shared.autoCompactLimitTokens({ contextWindowTokens: windows.contextWindowForModel(model).tokens, percent });
  const cases = [
    ["claude-fable-5", 70, 700_000],
    ["claude-sonnet-4-5", 70, 140_000],
    ["claude-opus-4-1", 95, 200_000 - shared.PI_BUILTIN_COMPACT_HEADROOM_TOKENS],
    ["gpt-5.2-codex", 50, 200_000],
    ["grok-4", 80, 204_800],
    ["some-new-model", 60, 76_800],
    ["some-new-model", 30, 48_000],
  ];
  for (const [model, percent, expected] of cases) {
    assert.equal(limitFor(model, percent), expected, `${model} at ${percent}%`);
  }
  assert.equal(limitFor("claude-fable-5", null), 256_000, "Auto keeps the 256k default on a 1M model");
  assert.equal(limitFor("claude-sonnet-4-5", null), 200_000 - 16_384, "Auto never exceeds Pi's own trigger");
  assert.equal(
    shared.autoCompactLimitTokens({ contextWindowTokens: 1_000_000, percent: 70, overrideTokens: 90_000 }),
    90_000,
    "a developer token override outranks the percentage",
  );
  assert.equal(
    shared.autoCompactLimitTokens({ contextWindowTokens: null, percent: 70 }),
    256_000,
    "an unknown window falls back to Auto",
  );
  assert.equal(shared.compactAtOverrideTokens(undefined), null);
  assert.equal(shared.compactAtOverrideTokens(" "), null);
  assert.equal(shared.compactAtOverrideTokens("0"), null);
  assert.equal(shared.compactAtOverrideTokens("120000.7"), 120_000);

  // Codex: an integer token limit (a string value makes codex 0.162 refuse
  // to start), priced off the CLI's own 272k window.
  assert.equal(shared.codexAutoCompactTokenLimit(null), null);
  assert.equal(shared.codexAutoCompactTokenLimit(50), 136_000);
  assert.equal(shared.codexAutoCompactTokenLimit(90), 244_800);
  assert.equal(shared.codexAutoCompactTokenLimit(50, 1_000_000), 136_000, "never past Codex's own window");
  assert.equal(shared.codexAutoCompactTokenLimit(30, 128_000), 48_000, "never below the floor");

  // Claude: the env value Claude Code reads as a percentage of its window.
  assert.equal(shared.claudeAutoCompactPercentEnv(null), null);
  assert.equal(shared.claudeAutoCompactPercentEnv(63), "63");
  assert.deepEqual(cli.claudeAutoCompactSettings(75), { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "75" } });
  assert.equal(cli.claudeAutoCompactSettings(null), null);

  const home = path.join(TMP, "codara-home");
  assert.equal(await cli.ensureClaudeAutoCompactSettingsFile(null, home), null, "Auto writes nothing");
  assert.equal(fs.existsSync(home), false);
  const file = await cli.ensureClaudeAutoCompactSettingsFile(75, home);
  assert.equal(file, path.join(home, "cli-launch", "claude-autocompact-75.json"));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "75" } });
  assert.equal(await cli.ensureClaudeAutoCompactSettingsFile(75, home), file, "the same limit reuses its file");
  // The settings file lives in Codara's home, never in a CLI home.
  const guard = await bundle("src/main/outside-write-guard.ts", "outside-write-guard.cjs");
  for (const cliHome of [".claude", ".codex"]) {
    assert.throws(
      () => guard.assertCodaraOwnedWrite(path.join(os.homedir(), cliHome, "settings.json")),
      undefined,
      `${cliHome} stays read-only to Codara`,
    );
  }

  // Standing terminals: the limit rides the command line only.
  const codex = standing.buildStandingTerminalCommand("codex", undefined, undefined, { codexTokenLimit: 136_000 });
  assert.match(codex, /^codex .*-c model_auto_compact_token_limit=136000$/);
  const claude = standing.buildStandingTerminalCommand("claude", undefined, undefined, { claudeSettingsPath: file });
  assert.ok(claude.startsWith("claude "), claude);
  assert.ok(claude.endsWith(`--settings ${file.includes(" ") ? `'${file}'` : file}`), claude);
  assert.equal(
    standing.buildStandingTerminalCommand("codex", undefined, undefined, { codexTokenLimit: null }),
    standing.buildStandingTerminalCommand("codex"),
    "Auto leaves the Codex command untouched",
  );
  assert.equal(
    standing.buildStandingTerminalCommand("claude", undefined, undefined, { codexTokenLimit: 136_000 }),
    standing.buildStandingTerminalCommand("claude"),
    "a Codex limit never reaches a Claude pane",
  );
  for (const runtime of ["grok", "pi"]) {
    assert.equal(
      standing.buildStandingTerminalCommand(runtime, undefined, undefined, { codexTokenLimit: 136_000, claudeSettingsPath: file }),
      standing.buildStandingTerminalCommand(runtime),
      `${runtime} panes run their own configuration`,
    );
  }
  assert.doesNotMatch(
    standing.buildStandingTerminalCommand("codex", undefined, undefined, { codexTokenLimit: 1.5 }),
    /model_auto_compact_token_limit/,
    "a non-integer limit is never sent",
  );

  // The run store hands the standing panes the owner's percentage.
  const runStore = fs.readFileSync(path.join(ROOT, "src/main/orchestration/run-store.ts"), "utf8");
  assert.match(runStore, /standingTerminalCompaction\(/);
  // Pi workers and the manager both launch with it.
  const electronRuntime = fs.readFileSync(path.join(ROOT, "src/main/orchestration/pi-runtime-electron.ts"), "utf8");
  assert.match(electronRuntime, /autoCompactPercent: settings\.coraAutoCompactPercent/);
  assert.match(electronRuntime, /autoCompactPercent: await autoCompactPercentSetting\(\)/);

  // Settings > Behavior offers Auto plus each choice and stores the number.
  const behavior = fs.readFileSync(path.join(ROOT, "src/renderer/src/components/capabilities/BehaviorSection.tsx"), "utf8");
  assert.match(behavior, /<option value="auto">Auto<\/option>/);
  assert.match(behavior, /AUTO_COMPACT_PERCENT_CHOICES\.map/);
  assert.match(behavior, /coraAutoCompactPercent/);
  const storage = fs.readFileSync(path.join(ROOT, "src/main/storage.ts"), "utf8");
  assert.match(storage, /coraAutoCompactPercent: normalizeAutoCompactPercent\(settings\.coraAutoCompactPercent\)/);

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("Auto-compact limit checks passed.");
})().catch((error) => {
  console.error(error);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
