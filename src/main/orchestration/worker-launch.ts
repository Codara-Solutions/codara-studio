// Worker launch: paste/submit and fatal-error detection.
//
// pasteAndSubmit sends the prompt as one bracketed paste and confirms the turn
// started. detectFatalWorkerRuntimeError scans a pty ring buffer for runtime
// API failures, and writeAutoFailureReport emits a synthetic failed report so
// the review loop can consume the failure. Extracted from run-store.ts
// (move-only, aside from a local copy of the trivial delay helper to avoid a
// circular import back into run-store).

import { promises as fs } from "node:fs";
import type { WorkerArtifactPaths, WorkerReport, WorkerTask } from "@shared/types";
import { stripAnsiWorkerTap, workerSubmitTurnStarted } from "@shared/agent-patterns";
import * as pty from "../pty-manager";

// Local copy of run-store's delay — replicated here rather than imported to
// avoid a circular import (run-store imports this module's launch helpers).
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Hoisted to module scope: the per-attempt pty tap in run-store calls
// detectFatalWorkerRuntimeError on every data chunk, and rebuilding this
// array of regex literals per call was measurable across N concurrent
// workers. None are /g, so sharing them carries no lastIndex state.
const FATAL_RUNTIME_ERROR_CHECKS: ReadonlyArray<[RegExp, string]> = [
  [/API Error:.*socket connection was closed unexpectedly/i, "runtime API error: socket connection closed unexpectedly"],
  // Auth rejections must not collapse into the generic "runtime API error"
  // reason: the taxonomy classifies that as a transient provider failure and
  // buys a doomed same-runtime retry on an expired credential. The reason
  // wording here deliberately matches the taxonomy's auth pattern so the
  // retry plan goes straight to the opposite runtime.
  [
    /API Error:.{0,160}?(?:\b401\b|\b403\b|unauthori[sz]ed|forbidden|authentication|invalid api key|no api key|missing api key|oauth|token (?:has )?expired|please (?:run )?\/?login)/i,
    "runtime authentication failed before final report",
  ],
  [/API Error:.{0,160}?(?:\b429\b|rate ?limit|too many requests)/i, "runtime rate limit before final report"],
  [/API Error:/i, "runtime API error before final report"],
  [/socket connection was closed unexpectedly/i, "runtime API error: socket connection closed unexpectedly"],
  [/fetch\(\)/i, "runtime network fetch failure before final report"],
  [/rate limit/i, "runtime rate limit before final report"],
  [/overloaded|temporarily unavailable/i, "runtime temporarily unavailable before final report"],
];

// Cheap per-chunk pre-filter for the tap: every regex above is /i and every
// one of its alternations contains at least one of these lowercase literals
// ("error" covers the four API Error: forms; the rest are verbatim). A chunk
// window whose lowercased, ANSI-stripped text contains none of them cannot
// make the full scan match, so the tap skips the 8 KB strip + 8-regex pass.
// Keep this list in sync with FATAL_RUNTIME_ERROR_CHECKS: a new check whose
// match text contains no hint here would be silently undetectable from the
// live tap (the gate sees only the fresh window, never the whole carry).
const FATAL_RUNTIME_ERROR_HINTS = [
  "error",
  "socket connection",
  "fetch(",
  "rate limit",
  "ratelimit",
  "overloaded",
  "temporarily unavailable",
] as const;

// Chars of already-seen carry a gating caller must prepend to the fresh chunk
// so a fatal banner split across a chunk boundary still trips a hint. Sizing:
// the widest same-match span a hint must bridge is the auth/rate-limit checks'
// `API Error:.{0,160}?` — "API Error:" (the "error" hint) up to 160 visible
// chars before the qualifying keyword, where only the keyword lands in the
// fresh chunk. `.` excludes newlines, so that span is one printed line; 1024
// raw chars cover it with ample headroom for interleaved escapes. ACCEPTED
// EDGE: a match whose only fresh evidence is hint-free (e.g. a bare "401"
// arriving > overlap raw bytes after its "API Error:" line) is missed by the
// live tap — unobserved in practice, the CLIs print these as one line.
export const FATAL_ERROR_GATE_OVERLAP = 1_024;

// True when `window` (fresh tap bytes + FATAL_ERROR_GATE_OVERLAP of carry)
// could possibly contain a fatal-error match. Strips the small window first:
// the hints, like the regexes, only match on visible text, and Ink can weave
// escapes through a phrase. A window that starts mid-escape leaves partial-
// escape residue behind, which can only ADD text — a false "maybe" costs one
// full scan, never a missed detection.
export function mayContainFatalWorkerRuntimeError(window: string): boolean {
  const visible = stripAnsiWorkerTap(window).toLowerCase();
  for (const hint of FATAL_RUNTIME_ERROR_HINTS) {
    if (visible.includes(hint)) return true;
  }
  return false;
}

export function detectFatalWorkerRuntimeError(
  buffer: string,
  runtime: WorkerTask["runtimePreference"],
): string | null {
  if (runtime !== "claude" && runtime !== "codex" && runtime !== "grok") return null;
  const visible = stripAnsiWorkerTap(buffer);
  for (const [pattern, reason] of FATAL_RUNTIME_ERROR_CHECKS) {
    if (pattern.test(visible)) return reason;
  }
  return null;
}

// Write a synthetic final-report so the autopilot review loop can consume the
// failure as worker evidence (the manager will see status=failed and decide
// whether to retry, route to a different runtime, or ask the user).
//
// A worker's own non-failed report always wins: a provider error that lands
// AFTER the worker already wrote a complete/partial/blocked final report
// (observed live: a Codex "servers overloaded" during session shutdown, 97s
// after the validated report) must not replace the finished work with a
// synthetic failure. In that case the late error is appended to the existing
// report's risks and `preservedExisting: true` tells the caller the worker's
// verdict still stands.
export async function writeAutoFailureReport(
  paths: WorkerArtifactPaths,
  task: WorkerTask,
  reason: string,
  options?: { interrupted?: boolean },
): Promise<{ preservedExisting: boolean }> {
  const interrupted = options?.interrupted === true;
  try {
    const raw = await fs.readFile(paths.finalReportJson, "utf8");
    const existing = JSON.parse(raw) as Record<string, unknown>;
    const status = existing?.status;
    if (status === "complete" || status === "partial" || status === "blocked") {
      const risks = Array.isArray(existing.risks)
        ? existing.risks.filter((item): item is string => typeof item === "string")
        : [];
      risks.push(
        interrupted
          ? `A stop arrived after this report was written: ${reason}.`
          : `A late ${task.runtimePreference} runtime error arrived after this report was written and was ignored: ${reason}.`,
      );
      existing.risks = risks;
      try {
        await fs.writeFile(paths.finalReportJson, JSON.stringify(existing, null, 2), "utf8");
      } catch {
        /* the untouched on-disk report still stands */
      }
      return { preservedExisting: true };
    }
  } catch {
    /* absent, unreadable, or unparseable: write the synthetic failure below */
  }
  const report: WorkerReport = {
    status: "failed",
    summary: interrupted
      ? `The ${task.runtimePreference} worker was stopped before it could finish: ${reason}.`
      : `Cora could not complete the ${task.runtimePreference} CLI worker for this task: ${reason}.`,
    filesChanged: [],
    commandsRun: [],
    tests: [],
    proof: [],
    risks: interrupted
      ? [`The worker was interrupted by a user stop or run pause before producing a final report: ${reason}.`]
      : [
          `${task.runtimePreference} CLI failed before producing a final report: ${reason}. Verify it is installed, logged in, reachable, and the model id is valid.`,
        ],
    followups: interrupted
      ? ["Resume the run or retry the worker when you want it to continue."]
      : ["Verify the CLI is installed, on PATH, and logged in, then re-run."],
  };
  try {
    await fs.writeFile(paths.finalReportJson, JSON.stringify(report, null, 2), "utf8");
  } catch {
    /* if we can't write the report the watchdog still resolves on pty exit */
  }
  return { preservedExisting: false };
}

// Send a multi-line prompt as a single bracketed paste (so Ink-based TUIs
// don't treat each newline as Enter), then submit with \r. Empty prompt =>
// no-op (manual runtime: user drives the shell themselves).
export async function pasteAndSubmit(
  attemptId: string,
  handle: { write: (input: string) => void },
  promptText: string,
  runtime: WorkerTask["runtimePreference"],
): Promise<boolean> {
  const body = promptText.replace(/\r\n?/g, "\n").trim();
  if (!body) return true;
  if (runtime === "claude" || runtime === "codex") {
    const PASTE_BEGIN = "\x1b[200~";
    const PASTE_END = "\x1b[201~";

    // Watch the worker's pty so we can CONFIRM the prompt was submitted
    // instead of firing a fixed number of Enters and hoping. Codex drops the
    // submit keystroke when a large bracketed paste lands while its TUI is
    // still settling, leaving the prompt visible-but-unsent — that hangs the
    // whole run until the 90-minute watchdog. The agent has started its turn
    // once it paints a working/interrupt indicator or its context usage
    // moves off 0%. The tap is installed now
    // (input is idle post-startup) so no stale "esc to interrupt" from the
    // startup phase is captured.
    let visible = "";
    const offTap = pty.tap(attemptId, (chunk) => {
      visible = (visible + stripAnsiWorkerTap(chunk.toString("utf8"))).slice(-6000);
    });
    const startedTurn = (): boolean => {
      return workerSubmitTurnStarted(runtime, visible);
    };

    try {
      handle.write(PASTE_BEGIN);
      await delay(25);
      handle.write(body);
      await delay(25);
      handle.write(PASTE_END);
      // Let the TUI commit the bracketed paste into its input box before the
      // first Enter — submitting mid-commit leaves the prompt unsent.
      await delay(promptSubmitSettleMs(runtime, body.length));

      // Press Enter, then verify the agent actually started a turn. If it
      // didn't, the keystroke was dropped (paste still settling, TUI busy) —
      // press again. Extra Enters once the agent is already working are
      // harmless newlines typed into an empty input box.
      const maxAttempts = 22;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        handle.write("\r");
        const deadline = Date.now() + 2200;
        while (Date.now() < deadline) {
          if (startedTurn()) return true;
          await delay(150);
        }
      }
      // Codex is the runtime with the known dropped-submit failure mode, so
      // surface a never-started turn as a hard failure (fast watchdog)
      // rather than hanging. Claude's submit path has been reliable; if our
      // detector simply did not recognise its working banner, don't
      // false-fail the worker — proceed and let the report watchdog decide.
      return runtime === "codex" ? startedTurn() : true;
    } finally {
      offTap();
    }
  }
  // Manual / shell runtimes: just dump the prompt as text into pwsh as a
  // here-string comment so the user can read it. They drive the work
  // themselves and write the final-report.json by hand.
  handle.write(`# Prompt:\r`);
  for (const line of body.split("\n")) {
    handle.write(`# ${line}\r`);
  }
  return true;
}

function promptSubmitSettleMs(
  runtime: WorkerTask["runtimePreference"],
  promptLength: number,
): number {
  const sizeCost = Math.ceil(promptLength / 2048) * 150;
  if (runtime === "claude") return clamp(1800 + sizeCost, 1800, 5000);
  if (runtime === "codex") return clamp(1200 + sizeCost, 1200, 4500);
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
