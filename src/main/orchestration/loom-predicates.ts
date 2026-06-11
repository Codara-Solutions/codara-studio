// ── Loom guard-predicate evaluation (impure) ─────────────────────────────────
// The shared, side-effecting predicate primitives a loom uses to decide flow:
//   • runShellCheck / gitClean — bounded shell probes (never hang a loop);
//   • scanLoopSentinel        — the SPARK_LOOP_CONTINUE/DONE trailing-line scan;
//   • evaluateGuardPredicate  — the GuardPredicate dispatcher used by guard
//                               nodes AND a worker node's retry-until clause.
//
// WHY THIS MODULE EXISTS (import-cycle break): both automation-loop.ts and
// run-store.ts need the SAME shell-check / git-clean / sentinel logic to settle
// a guard the SAME way the loop's StopConditions settle. automation-loop imports
// run-store (lazily), so run-store importing automation-loop would close a
// static cycle. Extracting the primitives here — a leaf module that imports only
// node:child_process + @shared/types (the latter type-only, erased) — lets BOTH
// import them with no cycle. automation-loop delegates its StopConditions checks
// to runShellCheck/gitClean/scanLoopSentinel here so the two code paths stay
// byte-identical and the 55 automation-loop checks stay green.

import { exec } from "node:child_process";
import type { GuardPredicate } from "@shared/types";
import { SHELL_CHECK_TIMEOUT_MS, SPARK_LOOP_CONTINUE, SPARK_LOOP_DONE } from "@shared/types";

/** Run a shell command in `cwd` with the bounded loop timeout; resolve true iff
 *  it exits 0 (a check passed). Never rejects/hangs — a spawn throw or a timeout
 *  resolves false, exactly like automation-loop's StopConditions probe. The
 *  default command for a `tests` predicate matches automation-loop's
 *  `stop.testCommand || "npm test"` default. */
export function runShellCheck(cwd: string, cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      exec(cmd, { cwd, timeout: SHELL_CHECK_TIMEOUT_MS, windowsHide: true }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

/** True iff `git status --porcelain` in `cwd` exits 0 with empty output (the
 *  working tree is clean). Same bounded probe automation-loop uses. */
export function gitClean(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      exec(
        "git status --porcelain",
        { cwd, timeout: SHELL_CHECK_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => resolve(!err && stdout.trim() === ""),
      );
    } catch {
      resolve(false);
    }
  });
}

/** The default command a `tests` predicate runs when it omits one — kept here so
 *  the guard path and automation-loop's untilTestsPass share the same default. */
export const DEFAULT_TEST_COMMAND = "npm test";

/** Scan the TRAILING lines of an agent's final summary for a loop sentinel,
 *  returning whether SPARK_LOOP_CONTINUE / SPARK_LOOP_DONE was emitted. Matches
 *  automation-loop.readAgentSignal's sentinel rung EXACTLY: the sentinel is
 *  honored anywhere in the last dozen non-empty lines (the literal last lines
 *  are often TUI chrome), but matched strictly — an exact line, trailing
 *  `.`/`!` tolerated, or `CONTINUE:"prompt"` — so the loop-instructions echo can
 *  never count. A guard with `want:"continue"` passes on a CONTINUE sentinel;
 *  `want:"done"` passes on a DONE sentinel. */
export function scanLoopSentinel(summary: string | undefined, want: "continue" | "done"): boolean {
  const lines = (summary ?? "")
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 12; i -= 1) {
    const line = lines[i].replace(/[.!]+$/, "");
    if (line === SPARK_LOOP_DONE) return want === "done";
    if (line === SPARK_LOOP_CONTINUE || line.startsWith(`${SPARK_LOOP_CONTINUE}:`)) {
      return want === "continue";
    }
  }
  return false;
}

/** Evaluate a guard predicate against a node's context, returning whether the
 *  guard PASSES (the "pass" branch is taken; false routes the "fail" branch).
 *
 *  ctx.sourceOutput is the guard's single forward parent's output (for a worker
 *  retry-until clause, the worker's own just-produced output). ctx.incomingOutputs
 *  maps every forward-parent nodeId → its output, so a `phrase` predicate can
 *  target a SPECIFIC upstream node via predicate.source.
 *
 *  Each branch reuses the SAME primitives automation-loop's StopConditions use:
 *   • phrase     — case-insensitive substring of sourceOutput, or of
 *                  incomingOutputs[source] when predicate.source names a node
 *                  (mirrors untilPhrase's `.toLowerCase().includes(...)`).
 *   • tests      — runShellCheck(predicate.command || DEFAULT_TEST_COMMAND).
 *   • gitClean   — gitClean(cwd).
 *   • command    — runShellCheck(predicate.command).
 *   • agentSignal— scanLoopSentinel(sourceOutput, predicate.want). */
export async function evaluateGuardPredicate(
  predicate: GuardPredicate,
  ctx: { cwd: string; sourceOutput: string; incomingOutputs: Record<string, string> },
): Promise<boolean> {
  switch (predicate.type) {
    case "phrase": {
      const haystack =
        predicate.source !== undefined
          ? (ctx.incomingOutputs[predicate.source] ?? "")
          : ctx.sourceOutput;
      return haystack.toLowerCase().includes(predicate.phrase.toLowerCase());
    }
    case "tests":
      return runShellCheck(ctx.cwd, predicate.command || DEFAULT_TEST_COMMAND);
    case "gitClean":
      return gitClean(ctx.cwd);
    case "command":
      return runShellCheck(ctx.cwd, predicate.command);
    case "agentSignal":
      return scanLoopSentinel(ctx.sourceOutput, predicate.want);
  }
}
