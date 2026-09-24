#!/usr/bin/env node
"use strict";

// Plain Studio shells follow the Active Grok account: a terminal tab with no
// Studio startup command still hands a hand-typed Grok CLI the default
// profile's home. Claude and Codex are intentionally absent: each switches
// the login inside one home, so a shell needs nothing to follow them. This
// suite drives the selector resolution pty-manager consumes, with injected
// resolvers so no real store, filesystem, or CLI is touched. The invariants:
//
//   - a personal default changes NOTHING (the shell keeps its inherited env),
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

const personalGrok = {
  profileId: "personal",
  label: "Account 1",
  managed: false,
  connected: true,
  env: { PATH: "/safe/bin" },
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
  const customGrok = path.join(TMP, "custom grok");
  assert.deepEqual(personalCliShellHomeEnvironment({
    CLAUDE_CONFIG_DIR: customClaude,
    GROK_HOME: customGrok,
  }), {
    SPARK_PERSONAL_CLAUDE_CONFIG_DIR: customClaude,
    SPARK_PERSONAL_GROK_HOME: customGrok,
  });
  assert.deepEqual(personalCliShellHomeEnvironment({}), {
    SPARK_PERSONAL_CLAUDE_CONFIG_DIR: "",
    SPARK_PERSONAL_GROK_HOME: "",
  });
  const codaraRoot = path.resolve(process.env.CODARA_HOME_DIR || process.env.SPARK_HOME_DIR || path.join(os.homedir(), ".codarastudio"));
  assert.equal(personalCliShellHomeEnvironment({
    CLAUDE_CONFIG_DIR: path.join(codaraRoot, "claude-cli", "accounts", "managed"),
  }).SPARK_PERSONAL_CLAUDE_CONFIG_DIR, "");
  console.log("PASS personal home snapshots preserve custom paths and exclude managed selectors");
  // A personal Grok default: nothing to apply, the shell stays untouched.
  assert.equal(
    await resolvePlainShellAccountSelectors({ resolveGrok: async () => personalGrok }),
    null,
    "a personal default must resolve to null so the shell env is not rebuilt",
  );
  console.log("PASS a personal default leaves the shell untouched");

  // A managed Grok default contributes exactly its home. Claude never
  // contributes anything: every Claude account runs in the one home.
  assert.deepEqual(
    await resolvePlainShellAccountSelectors({ resolveGrok: async () => managedGrok }),
    { grokHome: "/codara/grok-cli/accounts/c" },
    "a managed Grok default must contribute exactly its home",
  );
  console.log("PASS a managed Grok default contributes its home, and Claude contributes nothing");

  // A failing resolver: null, the shell must still open untouched.
  assert.equal(
    await resolvePlainShellAccountSelectors({
      resolveGrok: async () => {
        throw new Error("store corrupt");
      },
    }),
    null,
    "a failing resolver must resolve to null, never throw",
  );
  console.log("PASS a failing resolver resolves to null");

  // Defensive: a managed profile whose env lost its selector is skipped.
  assert.equal(
    await resolvePlainShellAccountSelectors({
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
  assert.ok(
    !pty.includes("plainShellClaudeConfigDir"),
    "a plain shell never gets a Claude config directory: every account runs in the one home",
  );
  for (const guard of [
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
    "\nPASS native CLI shell defaults: plain Studio shells follow the Active Grok account, Claude needs no selector, personal stays untouched, and resolution is best-effort",
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
