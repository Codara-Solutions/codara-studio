#!/usr/bin/env node
"use strict";

// Plain Studio shells follow the Active native CLI accounts: a terminal tab
// with no Studio startup command still hands a hand-typed Claude/Grok CLI the
// default profile's home. Codex is intentionally absent: account switching is
// auth-only inside the one ~/.codex home. This suite drives the remaining
// selector resolution that
// pty-manager consumes, with injected resolvers so no real store, filesystem,
// or CLI is touched. The invariants:
//
//   - a personal default changes NOTHING (the shell keeps its inherited env),
//   - a managed default contributes exactly its home selector,
//   - each CLI resolves independently and best-effort: one failing resolver
//     never blocks the other, and two failures yield null (spawn untouched).

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

const { resolvePlainShellAccountSelectors } = require(OUT);

const personalClaude = {
  profileId: "personal",
  label: "Existing Claude login",
  managed: false,
  connected: true,
  env: { PATH: "/safe/bin" },
};
const managedClaude = {
  profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  label: "Personal 2",
  managed: true,
  connected: true,
  env: { PATH: "/safe/bin", CLAUDE_CONFIG_DIR: "/codara/claude-cli/accounts/a" },
};
const personalGrok = {
  profileId: "personal",
  label: "Existing Grok login",
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
  // Both defaults personal: nothing to apply, the shell stays untouched.
  assert.equal(
    await resolvePlainShellAccountSelectors({
      resolveClaude: async () => personalClaude,
      resolveGrok: async () => personalGrok,
    }),
    null,
    "personal defaults must resolve to null so the shell env is not rebuilt",
  );
  console.log("PASS personal defaults leave the shell untouched");

  // Managed Claude only.
  assert.deepEqual(
    await resolvePlainShellAccountSelectors({
      resolveClaude: async () => managedClaude,
      resolveGrok: async () => personalGrok,
    }),
    { claudeConfigDir: "/codara/claude-cli/accounts/a" },
    "a managed Claude default must contribute exactly its config dir",
  );
  console.log("PASS managed Claude default contributes its config dir");

  // Claude and Grok managed.
  assert.deepEqual(
    await resolvePlainShellAccountSelectors({
      resolveClaude: async () => managedClaude,
      resolveGrok: async () => managedGrok,
    }),
    {
      claudeConfigDir: "/codara/claude-cli/accounts/a",
      grokHome: "/codara/grok-cli/accounts/c",
    },
    "both managed defaults must contribute both selectors",
  );
  console.log("PASS both managed defaults contribute both selectors");

  // One resolver failing never blocks the other.
  assert.deepEqual(
    await resolvePlainShellAccountSelectors({
      resolveClaude: async () => {
        throw new Error("store corrupt");
      },
      resolveGrok: async () => managedGrok,
    }),
    { grokHome: "/codara/grok-cli/accounts/c" },
    "a failing Claude resolver must not block the Grok selector",
  );
  console.log("PASS one failing resolver does not block the other");

  // Both failing: null, the shell must still open untouched.
  assert.equal(
    await resolvePlainShellAccountSelectors({
      resolveClaude: async () => {
        throw new Error("store corrupt");
      },
      resolveGrok: async () => {
        throw new Error("store corrupt");
      },
    }),
    null,
    "two failing resolvers must resolve to null, never throw",
  );
  console.log("PASS two failing resolvers resolve to null");

  // Defensive: a managed profile whose env lost its selector is skipped.
  assert.equal(
    await resolvePlainShellAccountSelectors({
      resolveClaude: async () => ({ ...managedClaude, env: { PATH: "/safe/bin" } }),
      resolveGrok: async () => personalGrok,
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
    "plainShellGrokHome",
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
    "\nPASS native CLI shell defaults: plain Studio shells follow the Active accounts, personal stays untouched, and resolution is best-effort",
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
