#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-worker-support-"));

async function bundleSupportModule() {
  const outfile = path.join(TMP, "worker-constitution-support.cjs");
  await esbuild.build({
    entryPoints: [
      path.join(
        ROOT,
        "src/main/orchestration/worker-constitution-support.ts",
      ),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  return require(outfile);
}

function runStoreLaunchSection() {
  const source = fs.readFileSync(
    path.join(ROOT, "src/main/orchestration/run-store.ts"),
    "utf8",
  );
  const start = source.indexOf("export async function launchWorkerAttempt(");
  const end = source.indexOf("\nexport async function deleteRun(", start);
  assert.notEqual(start, -1, "launchWorkerAttempt must exist");
  assert.notEqual(end, -1, "launchWorkerAttempt section must have a stable end");
  return source.slice(start, end);
}

async function main() {
  const support = await bundleSupportModule();
  const enabledCapture = {
    enabledAtCapture: true,
    revision: 41,
    sha256: "capture-digest-must-not-appear-in-a-failure",
  };
  const disabledCapture = {
    ...enabledCapture,
    enabledAtCapture: false,
  };

  const route = (runtimePreference, isAutomationRun, usePiWorkerHarness) =>
    support.workerConstitutionLaunchSurface({
      runtimePreference,
      isAutomationRun,
      usePiWorkerHarness,
    });
  const reason = (capture, surface) =>
    support.unsupportedEnabledWorkerConstitutionReason(capture, surface);

  const supportedSurfaces = [
    route("claude", false, true),
    route("codex", false, true),
    route("claude", true, false),
    route("codex", true, false),
    route("claude", false, false),
  ];
  assert.deepEqual(supportedSurfaces, [
    "pi-managed",
    "pi-managed",
    "claude-sdk",
    "codex-app-server",
    "claude-cli",
  ]);
  for (const surface of supportedSurfaces) {
    assert.equal(reason(enabledCapture, surface), null);
  }

  const unsupportedSurfaces = [
    route("codex", false, false),
    route("shell", false, false),
    route("manual", false, false),
    route("cursor", true, false),
    route({ provider: "external" }, false, false),
  ];
  assert.deepEqual(unsupportedSurfaces, [
    "legacy-codex-cli",
    "shell",
    "manual",
    "third-party",
    "third-party",
  ]);
  for (const surface of unsupportedSurfaces) {
    const failure = reason(enabledCapture, surface);
    assert.equal(typeof failure, "string");
    assert.match(failure, /cannot start/);
    assert.match(failure, /cannot consume exact attempt guidance securely/);
    assert.doesNotMatch(failure, /capture-digest-must-not-appear/);
    assert.doesNotMatch(failure, /revision|sha256|body|prompt|argv|environment/i);
  }

  // Legacy attempts and explicitly-disabled captures preserve the old launch
  // decision on every surface, including malformed persisted third parties.
  for (const surface of [...supportedSurfaces, ...unsupportedSurfaces]) {
    assert.equal(reason(undefined, surface), null);
    assert.equal(reason(disabledCapture, surface), null);
  }

  // Runtime-level proof: the caller can decide without resolving content and
  // refuses to invoke its provider callback on every unsupported enabled seam.
  let providerStarts = 0;
  const startIfSupported = (capture, surface) => {
    const failure = reason(capture, surface);
    if (failure) return { failure };
    providerStarts += 1;
    return { failure: null };
  };
  for (const surface of unsupportedSurfaces) {
    assert.ok(startIfSupported(enabledCapture, surface).failure);
  }
  assert.equal(providerStarts, 0);
  startIfSupported(disabledCapture, "legacy-codex-cli");
  startIfSupported(undefined, "manual");
  assert.equal(providerStarts, 2, "legacy/disabled launch behavior is unchanged");

  const launch = runStoreLaunchSection();
  const preflight = launch.indexOf("unsupportedEnabledWorkerConstitutionReason(");
  const rejection = launch.indexOf(
    "rejectWorkerAttemptLaunchForUnsupportedConstitution(",
  );
  assert.ok(preflight >= 0 && rejection > preflight);
  for (const laterLaunchAction of [
    "workerArtifactPaths(",
    "fs.mkdir(paths.attemptDir",
    "readWorkerPromptForLaunch(",
    "ensureCodexProjectTrust(",
    'attempt.status = "launching"',
    'type: "worker_attempt.launch_requested"',
    "runPiWorkerSession({",
    "runStructuredAutomationWorkerSession({",
    "runWorkerSession({",
  ]) {
    const index = launch.indexOf(laterLaunchAction);
    assert.ok(index > rejection, `${laterLaunchAction} must occur after fail-closed preflight`);
  }
  assert.match(
    launch,
    /task\.runtimePreference === "claude"\s*&&\s*attempt\.userConstitution\?\.enabledAtCapture/,
    "only the supported legacy Claude CLI receives an append-only system file",
  );

  console.log("user constitution unsupported worker launch checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
