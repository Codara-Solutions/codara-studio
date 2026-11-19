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
assert.match(body, /launchArgs: withoutStudioHooks\(claudeLaunchArgs\(\{ userArgs: providerArgs, mode: "worker" \}\)\)/);
assert.match(body, /hookEnv: null,/);
console.log("PASS Studio's own provider arguments, the worker tool roster, no hooks");

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
assert.match(body, /await \(current as ClaudeCodeProcess \| null\)\?\.kill\(\)/);
console.log("PASS a Stop is checked before every turn and the tree is awaited");

assert.match(body, /const paint = \(raw: string\) => \{\s*const text = redactPastedSecrets\(run\.id, raw\);/);
assert.match(body, /const line = claudeCodeToolLine\(event\);/);
assert.ok(!/paint\([^)]*stderrTail/.test(body), "Claude Code's error text is never logged");
assert.ok(!/paint\([^)]*event\.detail/.test(body.slice(body.indexOf('event.kind === "tool_failed"'))), "a failed tool's text is never logged");
console.log("PASS painted and logged text is redacted");
console.log("claude code worker session: all checks passed");
