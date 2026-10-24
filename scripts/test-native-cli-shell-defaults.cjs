#!/usr/bin/env node
"use strict";

// Plain Studio shells follow the Active accounts: a terminal tab with no
// Studio startup command still hands a hand-typed `claude`, `codex` or `grok`
// the Active managed account's home (Claude's live slot, a Codex or Grok
// home of its own). This suite drives the selector resolution pty-manager
// consumes, with injected resolvers so no real store, filesystem, or CLI is
// touched. The invariants:
//
//   - the System login changes NOTHING (the shell keeps its inherited env),
//   - a managed default contributes exactly its home selector,
//   - resolution is best-effort: a failure yields null (spawn untouched).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(
  path.join(os.tmpdir(), "codara-native-cli-shell-defaults-"),
);
const OUT = path.join(TMP, "native-cli-shell-defaults.cjs");
process.env.HOME = path.join(TMP, "home");
process.env.CODARA_HOME_DIR = path.join(TMP, "codara");

buildSync({
  entryPoints: [
    path.join(ROOT, "src", "main", "orchestration", "native-cli-shell-defaults.ts"),
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: OUT,
});

const { resolvePlainShellAccountSelectors, personalCliShellHomeEnvironment } = require(OUT);

const system = (label) => ({
  profileId: "personal",
  label,
  managed: false,
  connected: true,
  env: { PATH: "/safe/bin" },
});
const SYSTEM = {
  resolveClaude: async () => system("Claude Code login"),
  resolveCodex: async () => system("Codex login"),
  resolveGrok: async () => system("Grok login"),
};
const managedClaude = {
  profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  label: "Claude Work",
  managed: true,
  connected: true,
  env: { PATH: "/safe/bin", CLAUDE_CONFIG_DIR: "/codara/claude-cli/live/home" },
};
const managedCodex = {
  profileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  label: "Codex Work",
  managed: true,
  connected: true,
  env: { PATH: "/safe/bin", CODEX_HOME: "/codara/codex-cli/accounts/b/home" },
};
const managedGrok = {
  profileId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  label: "Grok Work",
  managed: true,
  connected: true,
  env: { PATH: "/safe/bin", GROK_HOME: "/codara/grok-cli/accounts/c" },
};

async function main() {
  const customClaude = path.join(TMP, "custom claude");
  const customCodex = path.join(TMP, "custom codex");
  const customGrok = path.join(TMP, "custom grok");
  assert.deepEqual(personalCliShellHomeEnvironment({
    CLAUDE_CONFIG_DIR: customClaude,
    CODEX_HOME: customCodex,
    GROK_HOME: customGrok,
  }), {
    SPARK_PERSONAL_CLAUDE_CONFIG_DIR: customClaude,
    SPARK_PERSONAL_CODEX_HOME: customCodex,
    SPARK_PERSONAL_GROK_HOME: customGrok,
  });
  assert.deepEqual(personalCliShellHomeEnvironment({}), {
    SPARK_PERSONAL_CLAUDE_CONFIG_DIR: "",
    SPARK_PERSONAL_CODEX_HOME: "",
    SPARK_PERSONAL_GROK_HOME: "",
  });
  const codaraRoot = path.resolve(process.env.CODARA_HOME_DIR);
  const managedSnapshot = personalCliShellHomeEnvironment({
    CLAUDE_CONFIG_DIR: path.join(codaraRoot, "claude-cli", "live", "home"),
    CODEX_HOME: path.join(codaraRoot, "codex-cli", "accounts", "b", "home"),
  });
  assert.equal(managedSnapshot.SPARK_PERSONAL_CLAUDE_CONFIG_DIR, "");
  assert.equal(managedSnapshot.SPARK_PERSONAL_CODEX_HOME, "");
  console.log("PASS personal home snapshots preserve custom paths and exclude managed selectors");

  assert.equal(
    await resolvePlainShellAccountSelectors(SYSTEM),
    null,
    "the System login must resolve to null so the shell env is not rebuilt",
  );
  console.log("PASS the System login leaves the shell untouched");

  assert.deepEqual(
    await resolvePlainShellAccountSelectors({
      resolveClaude: async () => managedClaude,
      resolveCodex: async () => managedCodex,
      resolveGrok: async () => managedGrok,
    }),
    {
      claudeConfigDir: "/codara/claude-cli/live/home",
      codexHome: "/codara/codex-cli/accounts/b/home",
      grokHome: "/codara/grok-cli/accounts/c",
    },
  );
  assert.deepEqual(
    await resolvePlainShellAccountSelectors({ ...SYSTEM, resolveCodex: async () => managedCodex }),
    { codexHome: "/codara/codex-cli/accounts/b/home" },
    "each CLI contributes only its own selector",
  );
  console.log("PASS a managed default contributes exactly its home");

  // A failing resolver costs only its own selector; all failing is null.
  const fail = async () => {
    throw new Error("store corrupt");
  };
  assert.deepEqual(
    await resolvePlainShellAccountSelectors({ resolveClaude: fail, resolveCodex: fail, resolveGrok: async () => managedGrok }),
    { grokHome: "/codara/grok-cli/accounts/c" },
  );
  assert.equal(
    await resolvePlainShellAccountSelectors({ resolveClaude: fail, resolveCodex: fail, resolveGrok: fail }),
    null,
    "a failing resolver must resolve to null, never throw",
  );
  console.log("PASS a failing resolver resolves to null");

  // Defensive: a managed profile whose env lost its selector is skipped.
  assert.equal(
    await resolvePlainShellAccountSelectors({
      ...SYSTEM,
      resolveClaude: async () => ({ ...managedClaude, env: { PATH: "/safe/bin" } }),
      resolveGrok: async () => ({ ...managedGrok, env: { PATH: "/safe/bin" } }),
    }),
    null,
    "a managed profile without its selector must be skipped, not applied empty",
  );
  console.log("PASS managed profile without a selector is skipped");

  // The pty seam: plain-shell injection must be wired, gated, and late-built.
  const pty = fs.readFileSync(
    path.join(ROOT, "src", "main", "pty-manager.ts"),
    "utf8",
  );
  assert.ok(
    pty.includes("resolvePlainShellAccountSelectors"),
    "pty-manager must consult the plain-shell selectors",
  );
  for (const guard of [
    "plainShellClaudeConfigDir",
    "plainShellCodexHome",
    "plainShellGrokHome",
    // The follow flag rides the same gate as the selectors: only a plain
    // user shell gets it, whether or not a selector resolved.
    "plainShellFollowsActiveAccount: true,",
    'env.SPARK_FOLLOW_ACTIVE_ACCOUNT = "1"',
    'hasOwnProperty.call(opts.env ?? {}, "SPARK_RUN_ID")',
    'hasOwnProperty.call(opts.env ?? {}, "CLAUDE_CONFIG_DIR")',
    'hasOwnProperty.call(opts.env ?? {}, "CODEX_HOME")',
    'hasOwnProperty.call(opts.env ?? {}, "GROK_HOME")',
  ]) {
    assert.ok(
      pty.includes(guard),
      `pty-manager plain-shell injection must carry the gate/selector: ${guard}`,
    );
  }
  console.log("PASS pty-manager wires and gates the plain-shell selectors");

  console.log(
    "\nPASS native CLI shell defaults: plain Studio shells follow the Active managed accounts, the System login stays untouched, and resolution is best-effort",
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
