#!/usr/bin/env node
"use strict";

// Pins worker ASSIGNABILITY: which providers Cora may send workers to.
//
// The bug this locks out: `AgentRuntimeDiagnostic.installed` means "the claude
// or codex CLI binary resolves on PATH", and worker routing used to gate on
// it. But every autonomous worker runs on the bundled Pi harness, so what a
// worker actually needs is a connected Pi SUBSCRIPTION for the provider its
// runtimePreference selects. A user with two live subscriptions and no CLIs
// installed had every worker rerouted to `manual`; a user with both CLIs on
// PATH and no subscription was told the provider was ready.
//
// src/main/orchestration/pi-worker-providers.ts owns the split, so this bundles
// it with its two edges (the runtime detector and the auth store) stubbed and
// drives the real code with fabricated CLI/subscription combinations.
//
//   node scripts/test-pi-worker-providers.cjs
//
// Exits non-zero on any failed assertion.

const assert = require("node:assert/strict");
const esbuild = require("esbuild");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// The harness feeds the module through globals so one bundle can be re-driven
// with different CLI/subscription combinations.
async function loadWorkerProviders(outDirectory) {
  const stub = (contents) => ({ contents, loader: "js" });
  const stubs = {
    "agent-runtimes": `module.exports = {
      detectAgentRuntimes: async () => {
        if (globalThis.__runtimeDetectionThrows) throw new Error("detection failed");
        return globalThis.__diagnostics;
      },
    };`,
    "pi-account-auth-store": `module.exports = {
      inspectPiAccountProfileAuthStore: async () => {
        if (globalThis.__authStoreThrows) throw new Error("auth store unreadable");
        globalThis.__authStoreReads += 1;
        return { statuses: globalThis.__statuses, snapshot: { profiles: [], defaults: {} } };
      },
    };`,
  };
  const outfile = path.join(outDirectory, "pi-worker-providers.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "pi-worker-providers.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [{
      name: "pi-worker-providers-harness",
      setup(build) {
        build.onResolve({ filter: /^@shared\// }, (args) => ({
          path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
        }));
        build.onResolve({ filter: /(agent-runtimes|pi-account-auth-store)$/ }, (args) => ({
          path: args.path.replace(/^.*[/\\]/, ""),
          namespace: "stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => stub(stubs[args.path]));
      },
    }],
  });
  return require(outfile);
}

const diagnostic = (kind, installed) => ({
  kind,
  label: kind,
  installed,
  executablePath: installed ? `/usr/local/bin/${kind}` : null,
  version: installed ? "1.0.0" : null,
  versionError: null,
  models: [],
  recommendedWorkerCommand: null,
  installHint: "",
  lastCheckedAt: new Date().toISOString(),
  capabilities: {},
});

const profile = (provider, overrides = {}) => ({
  profileId: `${provider}-1`,
  provider,
  connected: true,
  expired: false,
  canRefresh: false,
  expiresAt: null,
  ...overrides,
});

async function main() {
  const outDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codara-worker-providers-"));
  try {
    const mod = await loadWorkerProviders(outDirectory);

    // ── The provider selector ────────────────────────────────────────────
    assert.equal(mod.piProviderForWorkerRuntime("claude"), "anthropic");
    assert.equal(mod.piProviderForWorkerRuntime("codex"), "openai-codex");
    for (const escapeHatch of ["shell", "manual"]) {
      assert.equal(
        mod.piProviderForWorkerRuntime(escapeHatch),
        null,
        `${escapeHatch} is a human-assisted escape hatch, not a provider`,
      );
    }

    // ── The usable-profile predicate ─────────────────────────────────────
    // Must match the predicate the accounts surfaces already use, so a
    // provider cannot look assignable here and unusable at account selection.
    assert.equal(mod.isUsablePiProfileStatus(profile("anthropic")), true);
    assert.equal(
      mod.isUsablePiProfileStatus(profile("anthropic", { connected: false })),
      false,
      "a profile with no stored credential is not usable",
    );
    assert.equal(
      mod.isUsablePiProfileStatus(profile("anthropic", { expired: true, canRefresh: true })),
      true,
      "an expired but refreshable credential still launches, Pi refreshes it at session start",
    );
    assert.equal(
      mod.isUsablePiProfileStatus(profile("anthropic", { expired: true, canRefresh: false })),
      false,
      "an expired credential with no refresh token needs reconnecting",
    );

    const usable = mod.usablePiProviders([
      profile("anthropic"),
      profile("openai-codex", { connected: false }),
    ]);
    assert.equal(usable.has("anthropic"), true);
    assert.equal(usable.has("openai-codex"), false);

    // ── End to end: the CLI binary is irrelevant ─────────────────────────
    const drive = async ({ diagnostics, statuses, authThrows = false }) => {
      globalThis.__diagnostics = diagnostics;
      globalThis.__statuses = statuses;
      globalThis.__authStoreThrows = authThrows;
      globalThis.__runtimeDetectionThrows = false;
      globalThis.__authStoreReads = 0;
      return await mod.detectWorkerAssignableRuntimes();
    };

    // Subscription but no CLI binary: workers ARE assignable. This is the
    // exact combination the old `installed` gate got wrong.
    {
      const decorated = await drive({
        diagnostics: [diagnostic("claude", false), diagnostic("codex", false)],
        statuses: [profile("anthropic"), profile("openai-codex")],
      });
      assert.equal(mod.isWorkerAssignable(decorated, "claude"), true);
      assert.equal(mod.isWorkerAssignable(decorated, "codex"), true);
      // `installed` itself must NOT be rewritten: the manager chat backends,
      // agent terminals, and the MCP builtin installer still spawn real
      // binaries and depend on its original meaning.
      assert.equal(
        decorated.every((entry) => entry.installed === false),
        true,
        "installed must keep meaning CLI presence",
      );
    }

    // CLI binary but no subscription: NOT assignable for Pi workers.
    {
      const decorated = await drive({
        diagnostics: [diagnostic("claude", true), diagnostic("codex", true)],
        statuses: [],
      });
      assert.equal(mod.isWorkerAssignable(decorated, "claude"), false);
      assert.equal(mod.isWorkerAssignable(decorated, "codex"), false);
      assert.equal(
        decorated.every((entry) => entry.installed === true),
        true,
        "installed must keep meaning CLI presence",
      );
    }

    // Mixed: one connected subscription, and the CLIs are the wrong way round.
    {
      const decorated = await drive({
        diagnostics: [diagnostic("claude", false), diagnostic("codex", true)],
        statuses: [profile("anthropic"), profile("openai-codex", { connected: false })],
      });
      assert.equal(mod.isWorkerAssignable(decorated, "claude"), true);
      assert.equal(mod.isWorkerAssignable(decorated, "codex"), false);
    }

    // An expired-but-refreshable subscription stays assignable.
    {
      const decorated = await drive({
        diagnostics: [diagnostic("claude", false)],
        statuses: [profile("anthropic", { expired: true, canRefresh: true })],
      });
      assert.equal(mod.isWorkerAssignable(decorated, "claude"), true);
    }

    // A failed auth read degrades to the historical CLI-presence behaviour.
    // Reporting nothing assignable would reroute every worker to `manual`.
    {
      const decorated = await drive({
        diagnostics: [diagnostic("claude", true), diagnostic("codex", false)],
        statuses: [],
        authThrows: true,
      });
      assert.equal(mod.isWorkerAssignable(decorated, "claude"), true);
      assert.equal(mod.isWorkerAssignable(decorated, "codex"), false);
    }

    // A failed runtime detection yields nothing rather than throwing into the
    // caller's routing decision.
    {
      globalThis.__runtimeDetectionThrows = true;
      assert.deepEqual(await mod.detectWorkerAssignableRuntimes(), []);
      globalThis.__runtimeDetectionThrows = false;
    }

    // ── The routing call sites must consult the new signal ───────────────
    // Source-level, because these live in modules that reach Electron.
    const runStore = fs.readFileSync(
      path.join(ROOT, "src", "main", "orchestration", "run-store.ts"),
      "utf8",
    );
    assert.match(
      runStore,
      /async function detectConfiguredAgentRuntimes\(\): Promise<AgentRuntimeDiagnostic\[\]> \{\s*return detectWorkerAssignableRuntimes\(\);/,
      "run-store's worker-routing detector must return decorated diagnostics",
    );
    assert.equal(
      /runtime\.installed/.test(runStore),
      false,
      "no worker-routing site in run-store may still gate on CLI presence",
    );
    const agentSocket = fs.readFileSync(path.join(ROOT, "src", "main", "agent-socket.ts"), "utf8");
    assert.equal(
      /runtime\.installed|\.kind === headroomPreferredRuntime && runtime\.installed/.test(agentSocket),
      false,
      "agent-socket's verifier and headroom reroutes may not gate on CLI presence",
    );
    assert.equal(
      (agentSocket.match(/detectWorkerAssignableRuntimes\(\)/g) ?? []).length,
      2,
      "both agent-socket reroutes must read worker assignability",
    );

    // Surfaces that genuinely spawn the binaries must KEEP reading `installed`.
    const ipc = fs.readFileSync(path.join(ROOT, "src", "main", "ipc.ts"), "utf8");
    assert.match(
      ipc,
      /runtimes\.some\(\(r\) => r\.kind === kind && r\.installed\)/,
      "the MCP builtin installer writes into the CLIs' own config and must stay CLI-gated",
    );

    console.log("pi worker providers (subscription-based assignability): ok");
  } finally {
    fs.rmSync(outDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
