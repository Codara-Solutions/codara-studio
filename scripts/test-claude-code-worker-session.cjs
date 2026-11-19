#!/usr/bin/env node
"use strict";

// How run-store.ts runs a `claude-code/` worker (runClaudeCodeWorkerSession).
// The runner itself is driven against a fake CLI in
// test-claude-code-worker-boundary.cjs; this pins the wiring:
//   - the session never starts the account service's login sync (no
//     reconcile on launch, nothing on the release of the account hold);
//   - Studio's own provider and launch arguments are used, nothing else;
//   - the launch takes the worker arguments only after the settings files
//     were read back (stale or missing ones stop it);
//   - one owner (ClaudeCodeWorkerAttempt) starts every turn, a Stop reaches
//     every turn's processes, and the verdict is settled once, after all of
//     them are torn down, with the account hold kept unless that teardown
//     was confirmed; the finish path never turns a recorded Stop into a
//     success;
//   - everything painted or logged is redacted with the run's known keys,
//     and only Studio's fixed messages are saved with the run.
//
//   node scripts/test-claude-code-worker-session.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const runStore = fs.readFileSync(path.join(ROOT, "src", "main", "orchestration", "run-store.ts"), "utf8");
const start = runStore.indexOf("async function runClaudeCodeWorkerSession(");
assert.ok(start > 0, "runClaudeCodeWorkerSession is missing");
const body = runStore.slice(start, runStore.indexOf("\nasync function ", start + 10));

for (const banned of [
  "notifyNativeClaudeProfileLeaseReleased",
  "resolveNewNativeClaudeProfile",
  "reconcile",
  "credential-mirror",
  "unified-account",
  "pi-auth-storage",
  "readClaudeProfileLogin",
]) {
  assert.ok(!body.includes(banned), `runClaudeCodeWorkerSession mentions ${banned}`);
}
assert.match(body, /acquireLease: \(profileId\) => acquireNativeClaudeProfileLease\(profileId, attemptId\)/);
console.log("PASS no login sync on launch or release");

assert.match(body, /getProvider\("claude"\)\.buildArgs\(/);
// The launch reads the worker settings back after any rewrite and refuses
// stale or missing files (agent-launch-integration.ts, tested there).
assert.match(body, /workerArgs = \(\) => claudeWorkerLaunchArgs\(\{ userArgs: providerArgs \}\);\s*launchArgs = await workerArgs\(\);/);
// ...and again right before each turn: a rewrite that failed since stops it.
assert.match(body, /const turn = async \(prompt: string, resume\?: string\): Promise<number> => \{[\s\S]{0,200}?const current = await workerArgs!\(\);[\s\S]{0,300}?throw new Error\([\s\S]{0,200}?const started = attempt\.start\(/);
assert.ok(!/claudeLaunchArgs\(/.test(body), "the launch takes the checked worker arguments only");
assert.match(body, /hookEnv: null,/);
// The hook-free settings keep the browser guard and are rewritten with it.
const integration = fs.readFileSync(path.join(ROOT, "src", "main", "agent-launch-integration.ts"), "utf8");
assert.match(integration, /await writeClaudeSettings\(claudeWorkerSettingsFile, null, separateBrowserTools\);/);
assert.match(integration, /await writeClaudeSettings\(current\.claudeWorkerSettingsFile, null, guard\);/);
assert.match(integration, /const settings = input\.withoutHooks \? state\.claudeWorkerSettingsFile : state\.claudeSettingsPath;/);
console.log("PASS Studio's own provider arguments, the worker tool roster, checked settings without hooks");

// The display shell carries the run id, so pty-manager never takes the
// plain-shell path that resolves and syncs the Active accounts.
assert.match(body, /await ensurePiWorkerDisplayPty\(attemptId, cwd, \{ SPARK_RUN_ID: run\.id \}\);/);
const ptyManager = fs.readFileSync(path.join(ROOT, "src", "main", "pty-manager.ts"), "utf8");
const plainShell = ptyManager.indexOf("const selectors = await resolvePlainShellAccountSelectors()");
assert.ok(plainShell > 0);
assert.match(ptyManager.slice(Math.max(0, plainShell - 900), plainShell), /!Object\.prototype\.hasOwnProperty\.call\(opts\.env \?\? \{\}, "SPARK_RUN_ID"\)/);
console.log("PASS the display shell never syncs accounts");

// One owner for the attempt: every turn's process is started through it, a
// Stop reaches all of them, and a turn whose teardown was not confirmed
// ends the attempt (ClaudeCodeWorkerAttempt, tested in the boundary suite).
assert.match(body, /const attempt = new ClaudeCodeWorkerAttempt\(input\.launchAborted\);/);
assert.match(body, /const started = attempt\.start\(\(\) => startClaudeCodeWorker\(\{/);
assert.match(body, /const exit = await attempt\.end\(started\);/);
assert.match(body, /if \(!exit\.cleanedUp\) throw new Error\(/);
assert.match(body, /kill: \(\) => attempt\.stop\(\),/);
// A launch abort reaches the attempt at once, and the sign-in probe through it.
assert.match(body, /const launching = launchingWorkerAttempts\.get\(attemptId\);\s*if \(launching\) launching\.onAbort = \(\) => attempt\.stop\(\);/);
assert.match(body, /signal: attempt\.signal,/);
assert.match(runStore, /entry\.aborted = true;\s*try \{\s*entry\.onAbort\?\.\(\);/);
assert.match(body, /await runClaudeCodeWorkerTurns\(\{\s*prompt: input\.promptText,\s*stopped: \(\) => attempt\.stopped,/);
assert.ok(!/lastProcess|current\??\.kill/.test(body), "no single 'last process' decides the teardown");
console.log("PASS one owner starts every turn, a Stop reaches all of them");

// The verdict: every turn torn down first, then the Stop's handle removed
// and the Stop read with no wait in between, then the hold released only
// when the teardown was confirmed.
assert.match(body, /const cleanedUp = await attempt\.teardown\(\);\s*activeWorkerProcesses\.delete\(attemptId\);\s*const verdict = claudeCodeWorkerVerdict\(\{ reportReady: report !== null, failure, stopped: attempt\.stopped, cleanedUp \}\);\s*if \(cleanedUp\) launch\?\.release\(\);/);
const success = body.slice(body.indexOf("if (verdict.succeeded) {"), body.indexOf("return { exitCode: 0, ...usage };"));
assert.ok(success.length > 0 && !/await (?!logQueue)/.test(success), "nothing is awaited between the verdict and success except the final log flush");
assert.ok(body.indexOf("if (verdict.succeeded) {") > body.indexOf("const verdict = claudeCodeWorkerVerdict("), "success is painted only after the verdict");
// The finish path keeps a Stop recorded for the attempt.
const finish = runStore.slice(runStore.indexOf("? await runClaudeCodeWorkerSession({"));
assert.match(finish, /claudeCodeWorker &&\s*claudeCodeStopOwnsVerdict\(\{\s*exitCode: result\.exitCode,\s*attemptStatus: finishedAttempt\.status,\s*launchAborted: workerLaunchAborted\(finishedAttempt\.id\),\s*stopInProgress: \(forcePausingRuns\.get\(run\.id\) \?\? 0\) > 0,\s*\}\)/);
assert.ok(finish.indexOf("claudeCodeStopOwnsVerdict(") < finish.indexOf("const pauseInterrupted = workerExitInterruptedByForcePause("), "the Stop check comes before the verdict");
// The diff is measured before that check, and nothing waits between the
// verdict and the save.
assert.match(finish, /const claudeCodeDiffFirst = claudeCodeWorker && result\.exitCode === 0;\s*if \(claudeCodeDiffFirst\) await persistAttemptDiff\(run, finishedAttempt, paths\)/);
assert.ok(finish.indexOf("if (claudeCodeDiffFirst) await persistAttemptDiff(") < finish.indexOf("claudeCodeStopOwnsVerdict("));
const verdictToSave = finish.slice(finish.indexOf("claudeCodeStopOwnsVerdict("), finish.indexOf("await saveRun(run);"));
assert.deepEqual(verdictToSave.match(/await [^\n]*/g), ["await persistAttemptDiff(run, finishedAttempt, paths).catch(() => undefined);"]);
assert.match(verdictToSave, /if \(!claudeCodeDiffFirst\) await persistAttemptDiff\(/);
// A report whose processes may still run is neither reviewed nor retried.
assert.match(finish, /if \(pauseInterrupted\) return run;\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(claudeCodeWorker && result\.cleanupUnconfirmed\) return run;/);
assert.match(body, /\.\.\.\(cleanedUp \? \{\} : \{ cleanupUnconfirmed: true \}\)/);
// Planning keeps a Claude model only Claude Code carries, for a managed worker.
assert.match(finish.length ? runStore : "", /await coraWorkerModelAvailability\(workerSettings, \{ managedWorker \}\)/);
console.log("PASS the verdict is settled once, after teardown, and a recorded Stop wins in the finish path");

assert.match(body, /const paint = \(raw: string\) => \{\s*const text = redactPastedSecrets\(run\.id, raw\);/);
assert.match(body, /const line = claudeCodeToolLine\(event\);/);
assert.ok(!/paint\([^)]*stderrTail/.test(body), "Claude Code's error text is never logged");
assert.match(body, /event\.kind === "tool_failed"\) paint\("[^"]*"\)/, "a failed tool is logged as a fixed line");
assert.match(body, /event\.kind === "text"\) show\(/, "assistant text reaches the pane only");
assert.ok(!/paintPiWorkerReportOutcome\(paint/.test(body), "the report's text is never logged");
// The one logged line with a value in it is a tool's checked name.
assert.deepEqual(
  body.match(/paint\(`[^`]*`\)/g),
  ["paint(`\\x1b[38;2;74;222;208m  ●\\x1b[0m ${piWorkerSafeText(line, 200)}\\r\\n`)"],
  "no other logged line is built from variable text",
);
console.log("PASS painted and logged text is redacted; the log takes fixed lines only");

// What is saved with the run (failure report, attempt record, event
// journal) is one of Studio's fixed messages; the full text goes to the
// pane only.
assert.match(body, /const saved = claudeCodeSavedError\(message\);/);
assert.match(body, /await writeAutoFailureReport\(paths, task, saved, \{ interrupted: stopped \}\)/);
assert.match(body, /return \{ exitCode: stopped \? 130 : 1, error: saved, \.\.\.\(cleanedUp \? \{\} : \{ cleanupUnconfirmed: true \}\), \.\.\.usage \};/);
assert.ok(!/error: (message|failure)\b/.test(body), "the raw error is never returned to be saved");
assert.ok(!/writeAutoFailureReport\(paths, task, (message|failure)\b/.test(body));
console.log("PASS saved errors are fixed messages; the pane shows the full text");
console.log("claude code worker session: all checks passed");
