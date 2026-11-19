#!/usr/bin/env node
"use strict";

// How run-store.ts runs a `claude-code/` worker (runClaudeCodeWorkerSession).
// The runner itself is driven against a fake CLI in
// test-claude-code-worker-boundary.cjs; this pins the wiring:
//   - the session never starts the account service's login sync (no
//     reconcile on launch, nothing on the release of the account hold);
//   - Studio's own provider and launch arguments are used, nothing else;
//   - a Stop, including one that lands during the launch or the report read
//     (launchAborted), is checked before every turn, and the whole process
//     tree is awaited on the way out;
//   - everything painted or logged is redacted with the run's known keys.
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
assert.match(body, /const launchArgs = claudeLaunchArgs\(\{ userArgs: providerArgs, mode: "worker", withoutHooks: true \}\);/);
assert.match(body, /hookEnv: null,/);
// The hook-free settings keep the browser guard and are rewritten with it.
const integration = fs.readFileSync(path.join(ROOT, "src", "main", "agent-launch-integration.ts"), "utf8");
assert.match(integration, /await writeClaudeSettings\(claudeWorkerSettingsFile, null, separateBrowserTools\);/);
assert.match(integration, /await writeClaudeSettings\(state\.claudeWorkerSettingsFile, null, guard\);/);
assert.match(integration, /const settings = input\.withoutHooks \? state\.claudeWorkerSettingsFile : state\.claudeSettingsPath;/);
console.log("PASS Studio's own provider arguments, the worker tool roster, settings without hooks");

// The display shell carries the run id, so pty-manager never takes the
// plain-shell path that resolves and syncs the Active accounts.
assert.match(body, /await ensurePiWorkerDisplayPty\(attemptId, cwd, \{ SPARK_RUN_ID: run\.id \}\);/);
const ptyManager = fs.readFileSync(path.join(ROOT, "src", "main", "pty-manager.ts"), "utf8");
const plainShell = ptyManager.indexOf("const selectors = await resolvePlainShellAccountSelectors()");
assert.ok(plainShell > 0);
assert.match(ptyManager.slice(Math.max(0, plainShell - 900), plainShell), /!Object\.prototype\.hasOwnProperty\.call\(opts\.env \?\? \{\}, "SPARK_RUN_ID"\)/);
console.log("PASS the display shell never syncs accounts");

assert.match(body, /const stopped = \(\) => interrupted \|\| input\.launchAborted\(\);/);
assert.match(body, /const turn = async \(prompt: string, resume\?: string\): Promise<number> => \{\s*if \(stopped\(\)\) throw/);
assert.match(body, /await runClaudeCodeWorkerTurns\(\{\s*prompt: input\.promptText,\s*stopped,/);
assert.match(body, /await \(lastProcess as ClaudeCodeProcess \| null\)\?\.kill\(\)/);
console.log("PASS a Stop is checked before every turn and the tree is awaited");

assert.match(body, /const paint = \(raw: string\) => \{\s*const text = redactPastedSecrets\(run\.id, raw\);/);
assert.match(body, /const line = claudeCodeToolLine\(event\);/);
assert.ok(!/paint\([^)]*stderrTail/.test(body), "Claude Code's error text is never logged");
assert.match(body, /event\.kind === "tool_failed"\) paint\("[^"]*"\)/, "a failed tool is logged as a fixed line");
assert.match(body, /event\.kind === "text"\) show\(/, "assistant text reaches the pane only");
// Success is published only after the last flush and a final Stop check.
assert.match(body, /await logQueue\.catch\(\(\) => undefined\);\s*\/\/[^\n]*\n\s*if \(stopped\(\)\) throw new Error\("Claude Code worker was stopped\."\);[\s\S]{0,300}?applyHookStateReport\(\{ paneId: attemptId, state: "done"/);
// The log takes only fixed lines: the report's details and an error's text
// go to the pane, after the last Stop check.
assert.match(body, /if \(stopped\(\)\) throw new Error\("Claude Code worker was stopped\."\);\s*paint\("[^"$`]*"\);\s*paintPiWorkerReportOutcome\(show, report\);/);
assert.ok(!/paintPiWorkerReportOutcome\(paint/.test(body), "the report's text is never logged");
// The one logged line with a value in it is a tool's checked name.
assert.deepEqual(
  body.match(/paint\(`[^`]*`\)/g),
  ["paint(`\\x1b[38;2;74;222;208m  ●\\x1b[0m ${piWorkerSafeText(line, 200)}\\r\\n`)"],
  "no other logged line is built from variable text",
);
// Required settings, and the lease kept while anything still runs.
assert.match(body, /if \(!launchArgs\.includes\("--settings"\)\) \{\s*throw new Error/);
assert.match(body, /if \(stoppedCleanly\) launch\?\.release\(\);/);
console.log("PASS painted and logged text is redacted; the log takes fixed lines only");
console.log("claude code worker session: all checks passed");
