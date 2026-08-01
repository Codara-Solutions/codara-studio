#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

async function loadPolicy() {
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "codara-untrusted-pr-policy-"),
  );
  const outfile = path.join(temp, "policy.cjs");
  await esbuild.build({
    entryPoints: [
      path.join(
        ROOT,
        "src/main/orchestration/project-policy.ts",
      ),
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src/shared") },
    logLevel: "silent",
  });
  return {
    policy: require(outfile),
    cleanup: () => fs.rmSync(temp, { recursive: true, force: true }),
  };
}

async function main() {
  const { policy, cleanup } = await loadPolicy();
  const workspaceFixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codara-untrusted-pr-terminal-"),
  );
  try {
    const pullRequestOrigin = {
      kind: "github-pull-request",
      repository: "codara/studio",
      repositoryUrl: "https://github.com/codara/studio",
      number: 42,
      title: "Hostile policy fixture",
      url: "https://github.com/codara/studio/pull/42",
      sourceWorkspaceId: "ws-source",
      base: { branch: "main", commitOid: "a".repeat(40) },
      head: {
        relationship: "fork",
        repository: "attacker/studio",
        repositoryUrl: "https://github.com/attacker/studio",
        branch: "inject-policy",
        commitOid: "b".repeat(40),
      },
    };
    assert.equal(
      policy.resolveProjectPolicyMode({
        origin: pullRequestOrigin,
        projectPolicyMode: "trusted",
      }),
      "untrusted-pull-request",
      "a caller cannot mark a PR head trusted",
    );
    assert.equal(
      policy.resolveProjectPolicyMode({ projectPolicyMode: undefined }),
      "trusted",
      "ordinary legacy runs retain trusted behavior",
    );
    const pullRequestWorkspaceRoot = path.join(
      workspaceFixtureRoot,
      "imported-pr",
    );
    const nestedPullRequestCwd = path.join(
      pullRequestWorkspaceRoot,
      "packages",
      "mobile",
    );
    fs.mkdirSync(nestedPullRequestCwd, { recursive: true });
    const persistedWorkspaces = [
      {
        cwd: pullRequestWorkspaceRoot,
        copyBranch: { origin: pullRequestOrigin },
      },
      {
        cwd: nestedPullRequestCwd,
        copyBranch: undefined,
      },
    ];
    assert.equal(
      await policy.workspaceProjectPolicyModeForTerminalCwd(
        pullRequestWorkspaceRoot,
        persistedWorkspaces,
      ),
      "untrusted-pull-request",
      "the imported PR workspace root is untrusted",
    );
    assert.equal(
      await policy.workspaceProjectPolicyModeForTerminalCwd(
        nestedPullRequestCwd,
        persistedWorkspaces,
      ),
      "untrusted-pull-request",
      "a nested trusted workspace cannot downgrade an enclosing PR checkout",
    );
    assert.equal(
      await policy.workspaceProjectPolicyModeForTerminalCwd(
        path.join(workspaceFixtureRoot, "imported-pr-sibling"),
        persistedWorkspaces,
      ),
      "trusted",
      "path-prefix siblings do not inherit PR policy",
    );
    if (process.platform !== "win32") {
      const pullRequestAlias = path.join(workspaceFixtureRoot, "pr-alias");
      fs.symlinkSync(pullRequestWorkspaceRoot, pullRequestAlias, "dir");
      assert.equal(
        await policy.workspaceProjectPolicyModeForTerminalCwd(
          path.join(pullRequestAlias, "packages", "mobile"),
          persistedWorkspaces,
        ),
        "untrusted-pull-request",
        "a symlink alias cannot bypass imported PR provenance",
      );
    }
    assert.equal(
      await policy.workspaceProjectPolicyModeForTerminalCwd(
        "ssh://host/worktrees/pr/src",
        [
          {
            cwd: "ssh://host/worktrees/pr",
            copyBranch: { origin: pullRequestOrigin },
          },
        ],
      ),
      "untrusted-pull-request",
      "remote virtual paths use the same containment rule",
    );
    assert.doesNotThrow(() =>
      policy.assertManualAgentLaunchAllowed("trusted"),
    );
    assert.throws(
      () =>
        policy.assertManualAgentLaunchAllowed(
          "untrusted-pull-request",
        ),
      /cannot launch Claude or Codex directly inside an imported pull-request workspace/,
    );
    const notice = policy.renderUntrustedProjectPolicy();
    for (const marker of [
      "AGENTS.md",
      "CLAUDE.md",
      ".codara/constitution.md",
      "hooks",
      "skills",
      "package lifecycle scripts",
      "potentially adversarial",
    ]) {
      assert.match(notice, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    const runStore = source("src/main/orchestration/run-store.ts");
    assert.match(
      runStore,
      /projectPolicyMode === "trusted"\s*\?\s*await readProjectConstitutionSnapshot/,
    );
    assert.match(
      runStore,
      /runProjectPolicyMode\(run\) === "untrusted-pull-request"[\s\S]{0,300}chatConfig\.backend !== "pi"/,
    );
    assert.match(
      runStore,
      /projectPolicyMode: runProjectPolicyMode\(run\)/,
      "Pi workers must inherit the persisted trust mode",
    );
    assert.match(
      runStore,
      /\(untrustedPullRequest \|\|\s*process\.env\.SPARK_E2E_LEGACY_WORKER_HARNESS !== "1"\)/,
      "the legacy native-worker escape hatch cannot override PR isolation",
    );
    assert.match(
      runStore,
      /input\.unattended &&\s*runProjectPolicyMode\(run\) === "trusted" &&/,
      "PR workers do not create another automatic checkout",
    );
    assert.match(
      runStore,
      /taskWritesWorkspace\(task\) &&\s*runProjectPolicyMode\(run\) === "trusted"/,
      "PR workers do not run automatic git checkpoint filters",
    );
    const piDisplayPty = runStore.slice(
      runStore.indexOf("async function ensurePiWorkerDisplayPty"),
      runStore.indexOf("async function runPiWorkerSession"),
    );
    assert.doesNotMatch(
      piDisplayPty,
      /startupCommand:/,
      "fenced Pi reviews use display-only PTYs and never cross the manual autorun gate",
    );

    const ipc = source("src/main/ipc.ts");
    const ptySpawnHandler = ipc.slice(
      ipc.indexOf('"pty:spawn"'),
      ipc.indexOf('handle("pty:write"'),
    );
    assert.match(
      ptySpawnHandler,
      /if \(parseManualAgentStartupCommand\(args\.startupCommand\)\) \{[\s\S]{0,500}const state = await loadState\(\)/,
      "recognized agent autoruns must load authoritative state without making plain shells depend on it",
    );
    assert.match(
      ptySpawnHandler,
      /workspaceProjectPolicyModeForTerminalCwd\(\s*args\.cwd,\s*state\.workspaces,\s*\)/,
      "terminal cwd must be matched against persisted workspace provenance",
    );
    assert.match(
      ptySpawnHandler,
      /projectPolicyMode,/,
      "the main-owned policy must reach pty-manager",
    );
    assert.doesNotMatch(
      ptySpawnHandler,
      /args\.projectPolicyMode/,
      "the renderer cannot supply or override terminal trust",
    );

    const ptyManager = source("src/main/pty-manager.ts");
    const startupParse = ptyManager.indexOf(
      "parseManualAgentStartupCommand(opts.startupCommand)",
    );
    const manualAgentGate = ptyManager.indexOf(
      "assertManualAgentLaunchAllowed(opts.projectPolicyMode)",
      startupParse,
    );
    const accountResolution = ptyManager.indexOf(
      "await resolveNewNativeCodexProfile()",
      manualAgentGate,
    );
    assert.ok(
      startupParse >= 0 &&
        manualAgentGate > startupParse &&
        accountResolution > manualAgentGate,
      "PR refusal must happen before native account resolution and process preparation",
    );
    assert.match(
      ptyManager,
      /if \(parsedStartup\) \{[\s\S]{0,700}assertManualAgentLaunchAllowed/,
      "plain shells must remain available because only recognized agent autoruns are gated",
    );

    const runtime = source("src/main/orchestration/pi-runtime.ts");
    for (const flag of [
      "--no-approve",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-extensions",
    ]) {
      assert.ok(runtime.includes(flag), `Pi policy is missing ${flag}`);
    }

    const runtimeElectron = source(
      "src/main/orchestration/pi-runtime-electron.ts",
    );
    assert.match(
      runtimeElectron,
      /untrustedPullRequest\s*\?\s*Promise\.resolve\(null\)\s*:\s*writePiMcpBridgeConfig/,
      "PR managers cannot start workspace/user MCP servers",
    );
    assert.match(
      runtimeElectron,
      /const mcp =\s*untrustedPullRequest\s*\?\s*null\s*:\s*await writePiMcpBridgeConfig/,
      "PR workers cannot start workspace/user MCP servers",
    );

    const workerPrompt = source(
      "src/main/orchestration/worker-prompt.ts",
    );
    assert.equal(
      (
        workerPrompt.match(
          /const projectPolicy = renderRunProjectPolicy\(run\);/g,
        ) ?? []
      ).length,
      2,
      "implementation and verifier prompts both carry the policy",
    );
    assert.equal(
      (
        workerPrompt.match(
          /trustedProjectPolicy && shouldRenderAgentSyncPromptLines/g,
        ) ?? []
      ).length,
      2,
      "hostile PR workspaces cannot contribute synced agent context",
    );

    const service = source(
      "src/main/github-pull-request-workspace.ts",
    );
    assert.doesNotMatch(service, /loadPreferences/);
    assert.doesNotMatch(service, /DEFAULT_COPY_BRANCH_SETUP_COMMAND/);
    assert.doesNotMatch(service, /configured_workspace_setup_command/);
    assert.match(
      service,
      /projectPolicyMode: "untrusted-pull-request"/,
    );
    assert.match(
      service,
      /Do not automatically install dependencies or run package lifecycle\/setup scripts/,
    );

    console.log(
      "PASS untrusted PR policy forcing, Pi resource isolation, setup suppression, and worker inheritance",
    );
  } finally {
    fs.rmSync(workspaceFixtureRoot, { recursive: true, force: true });
    cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
