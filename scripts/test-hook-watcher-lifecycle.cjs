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
      [
        "export function recordSessionStart(rec) { globalThis.__hookSessionStarts++; globalThis.__hookSessionRecords.push(rec); }",
        "export function latestSessionStart(paneId) { const all = globalThis.__hookSessionRecords.filter((r) => r.paneId === paneId); return all[all.length - 1] ?? null; }",
      ].join("\n"),
    ],
    [
      "./pty-manager",
      [
        "export function nativeClaudeProfileId() { return undefined; }",
        "export function sessionCwd(id) { return globalThis.__hookSpawnCwds?.[id] ?? null; }",
      ].join("\n"),
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
  globalThis.__hookSessionRecords = [];
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

    // A turn-end hook reports the live cwd the agent's Bash tool moved into.
    // The record must keep the start cwd, the one Claude filed the transcript
    // under, or restore probes the wrong project folder.
    const startCwd = path.join(TMP, "Codara SL");
    const movedCwd = path.join(startCwd, "Studio", "codara-studio");
    const sessionId = "0d34e9f6-eaa0-4b77-b80e-11d4c469602b";
    const transcriptPath = path.join(
      TMP,
      "claude",
      "projects",
      startCwd.replace(/[^a-zA-Z0-9]/g, "-"),
      `${sessionId}.jsonl`,
    );
    const stopFile = "stop-after-cd.json";
    fs.writeFileSync(
      path.join(hooksDir, stopFile),
      JSON.stringify({
        hookName: "Stop",
        timestamp: new Date().toISOString(),
        paneId: "pane-moved",
        payload: { session_id: sessionId, cwd: movedCwd, transcript_path: transcriptPath },
      }),
      "utf8",
    );
    await waitFor("stop hook record", () =>
      globalThis.__hookSessionRecords.find((r) => r.paneId === "pane-moved"),
    );
    const stopRecord = globalThis.__hookSessionRecords.find((r) => r.paneId === "pane-moved");
    assert.equal(stopRecord.sessionId, sessionId);
    assert.equal(stopRecord.cwd, startCwd, "hook record keeps the session's start cwd");
    assert.equal(stopRecord.transcriptPath, transcriptPath);

    // `/clear` after the agent left the start directory: a new session id, a
    // live cwd unrelated to the transcript folder. The pane's spawn cwd maps
    // to that folder, so the record still names the start cwd.
    const outsideCwd = path.join(TMP, "elsewhere", "repo");
    const clearedId = "7ff46c48-3293-4866-ae65-00f572fbf618";
    globalThis.__hookSpawnCwds = { "pane-cleared": startCwd };
    fs.writeFileSync(
      path.join(hooksDir, "clear-after-cd.json"),
      JSON.stringify({
        hookName: "SessionStart",
        timestamp: new Date().toISOString(),
        paneId: "pane-cleared",
        payload: {
          session_id: clearedId,
          source: "clear",
          cwd: outsideCwd,
          transcript_path: path.join(path.dirname(transcriptPath), `${clearedId}.jsonl`),
        },
      }),
      "utf8",
    );
    await waitFor("clear hook record", () =>
      globalThis.__hookSessionRecords.find((r) => r.paneId === "pane-cleared"),
    );
    const clearRecord = globalThis.__hookSessionRecords.find((r) => r.paneId === "pane-cleared");
    assert.equal(clearRecord.sessionId, clearedId);
    assert.equal(clearRecord.cwd, startCwd, "a /clear outside the start dir keeps the start cwd");

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
  console.log("PASS a hook after the agent cd'ed records the session's start cwd");
  console.log("PASS a /clear outside the start dir records the start cwd via the spawn cwd");
  console.log("PASS stop cancels timers and wins pending re-arm races");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    delete globalThis.__hookSessionStarts;
    delete globalThis.__hookSessionRecords;
    delete globalThis.__hookSpawnCwds;
    delete globalThis.__hookDispatches;
    delete process.env.CODARA_HOME_DIR;
    delete process.env.SPARK_SKIP_LEGACY_MIGRATION;
    fs.rmSync(TMP, { recursive: true, force: true });
  });
