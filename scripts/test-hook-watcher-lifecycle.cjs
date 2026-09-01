#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-hook-watcher-"));
const CODARA_HOME = path.join(TMP, "home");
const OUTFILE = path.join(TMP, "hook-watcher.cjs");

process.env.CODARA_HOME_DIR = CODARA_HOME;
process.env.SPARK_SKIP_LEGACY_MIGRATION = "1";

function lifecycleStubs() {
  const modules = new Map([
    [
      "electron",
      "export const app = { getPath: () => " + JSON.stringify(path.join(TMP, "electron")) + " };",
    ],
    [
      "./agent-session-registry",
      "export function recordSessionStart() { globalThis.__hookSessionStarts++; }",
    ],
    [
      "./pty-manager",
      "export function nativeClaudeProfileId() { return undefined; }",
    ],
    [
      "./terminal-agent-notify",
      "export function noteTerminalHookEvent() {}",
    ],
    [
      "./orchestration/run-store",
      [
        "export function applyHookStateReport() { globalThis.__hookDispatches++; }",
        "export function applyHookEvent() { globalThis.__hookDispatches++; }",
      ].join("\n"),
    ],
  ]);
  return {
    name: "hook-watcher-lifecycle-stubs",
    setup(build) {
      for (const [specifier, contents] of modules) {
        build.onResolve({ filter: new RegExp(`^${escapeRegExp(specifier)}$`) }, () => ({
          path: specifier,
          namespace: "hook-watcher-stub",
          pluginData: { contents },
        }));
      }
      build.onLoad({ filter: /.*/, namespace: "hook-watcher-stub" }, (args) => ({
        contents: args.pluginData.contents,
        loader: "js",
      }));
    },
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitFor(label, predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${label} timed out (last=${JSON.stringify(last)})`);
}

function envelope(name) {
  return JSON.stringify({
    hookName: "PreToolUse",
    timestamp: new Date().toISOString(),
    paneId: "",
    payload: { tool_name: name },
  });
}

async function assertExactlyOneRearm(watcher, trigger, label) {
  const before = watcher.__test.diagnostics().armCount;
  assert.equal(trigger(), true, `${label} trigger should reach the active watcher`);
  await waitFor(`${label} re-arm`, () => {
    const state = watcher.__test.diagnostics();
    return state && state.watcherArmed && state.armCount === before + 1;
  });
  await new Promise((resolve) =>
    setTimeout(resolve, watcher.__test.rearmBaseDelayMs * 3),
  );
  assert.equal(
    watcher.__test.diagnostics().armCount,
    before + 1,
    `${label} must not publish duplicate watchers`,
  );
}

async function main() {
  globalThis.__hookSessionStarts = 0;
  globalThis.__hookDispatches = 0;
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "hook-watcher.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: OUTFILE,
    plugins: [lifecycleStubs()],
    logLevel: "silent",
  });

  const watcher = require(OUTFILE);
  const hooksDir = path.join(CODARA_HOME, "hooks");
  const processedDir = path.join(hooksDir, "processed");

  // Native watcher errors can be delivered repeatedly for one underlying
  // failure. Only the first callback owns invalidation/re-arm.
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    await Promise.all([
      watcher.startHookWatcher(),
      watcher.startHookWatcher(),
      watcher.startHookWatcher(),
    ]);
    assert.equal(watcher.isHookWatcherActive(), true);
    assert.equal(
      watcher.__test.diagnostics().armCount,
      1,
      "concurrent starts must publish only one watcher",
    );

    await assertExactlyOneRearm(
      watcher,
      () => watcher.__test.emitWatcherError(3),
      "error burst",
    );
    await assertExactlyOneRearm(
      watcher,
      () => watcher.__test.emitWatcherClose(),
      "unexpected close",
    );

    // Replace the directory while the native watcher remains attached to its
    // old inode. The identity-aware rescan must close it and bind the new path.
    const beforeReplacement = watcher.__test.diagnostics().armCount;
    const oldHooksDir = path.join(CODARA_HOME, "hooks-replaced");
    fs.renameSync(hooksDir, oldHooksDir);
    fs.mkdirSync(processedDir, { recursive: true });
    await watcher.__test.rescanNow();
    await waitFor("directory replacement re-arm", () => {
      const state = watcher.__test.diagnostics();
      return state && state.watcherArmed && state.armCount === beforeReplacement + 1;
    });
    await new Promise((resolve) =>
      setTimeout(resolve, watcher.__test.rearmBaseDelayMs * 3),
    );
    assert.equal(
      watcher.__test.diagnostics().armCount,
      beforeReplacement + 1,
      "directory replacement must retain one watcher owner",
    );

    const liveFile = "live-after-replacement.json";
    fs.writeFileSync(path.join(hooksDir, liveFile), envelope("Read"), "utf8");
    await waitFor("new directory event", () =>
      fs.existsSync(path.join(processedDir, liveFile)),
    );
    assert.equal(
      fs.existsSync(path.join(hooksDir, liveFile)),
      false,
      "the re-armed watcher must consume files from the replacement directory",
    );
    fs.rmSync(oldHooksDir, { recursive: true, force: true });

    // Retention runs after startup as well as at boot, keeps fresh entries,
    // and advances through its bounded directory-cursor sweep.
    const oldFile = path.join(processedDir, "old.json");
    const freshFile = path.join(processedDir, "fresh.json");
    fs.writeFileSync(oldFile, "{}", "utf8");
    fs.writeFileSync(freshFile, "{}", "utf8");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, eightDaysAgo, eightDaysAgo);
    const pruneBefore = watcher.__test.diagnostics().pruneSweepCount;
    watcher.__test.pruneNow();
    await waitFor("processed retention prune", () => {
      const state = watcher.__test.diagnostics();
      return state && state.pruneSweepCount > pruneBefore;
    });
    assert.equal(fs.existsSync(oldFile), false, "expired processed files must be pruned");
    assert.equal(fs.existsSync(freshFile), true, "fresh processed files must be retained");

    // A stop wins the generation race against an already-scheduled re-arm.
    assert.equal(watcher.__test.emitWatcherError(), true);
    assert.equal(watcher.__test.diagnostics().rearmPending, true);
    await watcher.stopHookWatcher();
    assert.equal(watcher.isHookWatcherActive(), false);
    await new Promise((resolve) =>
      setTimeout(resolve, watcher.__test.rearmBaseDelayMs * 3),
    );
    assert.equal(watcher.__test.diagnostics(), null, "stop must retire lifecycle state");
    const afterStop = path.join(hooksDir, "after-stop.json");
    fs.writeFileSync(afterStop, envelope("Bash"), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      fs.existsSync(afterStop),
      true,
      "stop-during-rearm must not resurrect a watcher",
    );
  } finally {
    console.warn = realWarn;
    await watcher.stopHookWatcher();
  }

  console.log("PASS concurrent starts, error bursts, and close events retain one watcher");
  console.log("PASS directory replacement rebinds the native watcher");
  console.log("PASS processed retention prunes after startup in bounded chunks");
  console.log("PASS stop cancels timers and wins pending re-arm races");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    delete globalThis.__hookSessionStarts;
    delete globalThis.__hookDispatches;
    delete process.env.CODARA_HOME_DIR;
    delete process.env.SPARK_SKIP_LEGACY_MIGRATION;
    fs.rmSync(TMP, { recursive: true, force: true });
  });
