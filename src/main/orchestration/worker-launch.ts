// Worker launch: agent-TUI sniffing, input-ready gating, paste/submit, and
// fatal-error detection.
//
// waitForAgentTui watches the pty for the CLI's TUI banner (or a hard launch
// failure) after the launch command fires. waitForCodexInputReady holds until
// Codex has finished MCP-server startup so a bracketed paste is not dropped.
// pasteAndSubmit sends the prompt as one bracketed paste and confirms the turn
// started. detectFatalWorkerRuntimeError scans a pty ring buffer for runtime
// API failures, and writeAutoFailureReport emits a synthetic failed report so
// the review loop can consume the failure. Extracted from run-store.ts
// (move-only, aside from a local copy of the trivial delay helper to avoid a
// circular import back into run-store).

import { promises as fs } from "node:fs";
import type { WorkerArtifactPaths, WorkerReport, WorkerTask } from "@shared/types";
import { stripAnsiWorkerTap } from "@shared/agent-patterns";
import * as pty from "../pty-manager";

// Local copy of run-store's delay — replicated here rather than imported to
// avoid a circular import (run-store imports this module's launch helpers).
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sniff the pty output stream for an agent-TUI marker so we know the launch
// command actually became the foreground process. If we don't see one inside
// the budget, the launch failed — pwsh is back at its prompt and pasting the
// worker prompt would just shove it in as command input. Returns the reason
// for failure so we can log + write a fail-report.
export async function waitForAgentTui(
  attemptId: string,
  runtime: WorkerTask["runtimePreference"],
): Promise<{ ok: true } | { ok: false; reason: string; timeoutMs: number }> {
  // Markers that indicate the CLI's TUI is running. Claude and codex each
  // emit their model name on first paint, plus Ink/React-CLI specific
  // frames. We also look for the "bypass permissions" banner claude prints
  // with our launch flag and codex's "/help" or "Pasted Content" hints.
  const claudeMarkers = [
    "bypass permissions",
    "Sonnet",
    "Opus",
    "Haiku",
    "claude-sonnet",
    "claude-opus",
    "claude-haiku",
  ];
  const codexMarkers = [
    "GPT-",
    "gpt-5",
    "/help",
    "Pasted Content",
    "Codex",
    "codex >",
    "Reasoning effort",
  ];
  const markers = runtime === "codex" ? codexMarkers : claudeMarkers;
  // Patterns that signal a hard launch failure — pwsh complaining the binary
  // isn't on PATH, or a CommandNotFoundException, or the CLI rejecting an
  // invalid flag. If we see any of these we bail immediately rather than
  // waiting out the budget.
  const failureMarkers = [
    "is not recognized as the name of a cmdlet",
    "CommandNotFoundException",
    "command not found",
    "ENOENT",
    "error: option",
    "error: unknown option",
    "Unknown option",
    "is invalid. It must be one of",
  ];
  const timeoutMs = runtime === "codex" ? 12_000 : 9_000;

  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    let sawOscC = false;
    const finish = (value: { ok: true } | { ok: false; reason: string; timeoutMs: number }) => {
      if (settled) return;
      settled = true;
      offTap();
      clearTimeout(timer);
      resolve(value);
    };
    const offTap = pty.tap(attemptId, (chunk) => {
      // Keep the ring buffer small; we only need the most recent visible text.
      buffer = (buffer + chunk.toString("utf8")).slice(-4096);

      // Track spark.ps1's OSC 633 markers so we can detect "launch command
      // returned to shell" — the shell integration emits ESC ]633;C right
      // before a command runs and ESC ]633;D;<exit> when it finishes. If we
      // see D after C for our launch command, the agent CLI exited (bad
      // flag, auth error, missing binary) and pwsh is back at its prompt;
      // pasting the worker prompt would just dump it as shell input.
      if (!sawOscC && /\x1b\]633;C/.test(buffer)) sawOscC = true;
      if (sawOscC && /\x1b\]633;D;/.test(buffer)) {
        finish({
          ok: false,
          reason:
            "launch command returned to shell prompt — agent CLI exited before TUI took over (bad flag, auth, or missing binary)",
          timeoutMs,
        });
        return;
      }

      // Strip CSI and OSC escape sequences so the echoed command line in
      // ]633;E;<command> doesn't false-positive against marker text like
      // "claude-haiku" — the model name appears in the typed command and
      // would otherwise look identical to the TUI banner.
      const visible = stripAnsiWorkerTap(buffer);
      for (const marker of markers) {
        if (visible.includes(marker)) {
          finish({ ok: true });
          return;
        }
      }
      for (const marker of failureMarkers) {
        if (visible.includes(marker)) {
          finish({
            ok: false,
            reason: `runtime binary did not start (saw '${marker}')`,
            timeoutMs,
          });
          return;
        }
      }
    });
    const timer = setTimeout(() => {
      finish({ ok: false, reason: "no TUI banner observed", timeoutMs });
    }, timeoutMs);
  });
}

export async function waitForCodexInputReady(attemptId: string): Promise<void> {
  // Codex paints its model banner before it finishes MCP-server startup. If
  // Spark bracket-pastes the worker prompt during that startup window, some
  // Codex TUI builds drop the paste/submit and sit forever at the prompt.
  //
  // The placeholder/suggestion strings rotate and change between Codex
  // releases, so matching them is unreliable on its own (the old fixed list
  // matched nothing on v0.131.0 and this wait silently degraded to a blind
  // 18s timeout). The robust signal is the "Starting MCP servers (N/5)" line:
  // it repaints every spinner frame while servers boot and stops once they
  // are up. We treat Codex as input-ready when that line has gone quiet for
  // QUIET_MS, or when a known input-placeholder marker appears, whichever is
  // first — with a hard cap so a build that prints neither still proceeds.
  const readyMarkers = [
    "Write tests for",
    "Explain this codebase",
    "Summarize recent",
    "Ask about this codebase",
    "What should I work on",
    "Run /review",
    "Fix a bug",
    "/help for",
  ];
  const HARD_CAP_MS = 30_000;
  const QUIET_MS = 2_500;
  const NO_MCP_GRACE_MS = 4_000;
  await new Promise<void>((resolve) => {
    let settled = false;
    let buffer = "";
    let sawMcpStartup = false;
    let lastMcpSeen = 0;
    const startedAt = Date.now();
    const finish = () => {
      if (settled) return;
      settled = true;
      offTap();
      clearInterval(poll);
      clearTimeout(cap);
      resolve();
    };
    const offTap = pty.tap(attemptId, (chunk) => {
      // Check THIS chunk for the MCP line — once it stops being repainted,
      // lastMcpSeen stops advancing and the poll below detects quiescence.
      const text = stripAnsiWorkerTap(chunk.toString("utf8"));
      if (/Starting MCP servers/i.test(text)) {
        sawMcpStartup = true;
        lastMcpSeen = Date.now();
      }
      buffer = (buffer + text).slice(-8192);
      // The placeholder/suggestion strings paint on the banner in the SAME
      // frame as "Starting MCP servers (0/N)", so they are NOT a reliable
      // "input ready" signal once a startup line has appeared — trusting them
      // there short-circuits the MCP-quiet wait and pastes mid-startup, which
      // Codex drops. Only let them resolve early when no MCP startup is
      // happening (no servers configured), where banner ≈ input ready.
      if (!sawMcpStartup && readyMarkers.some((marker) => buffer.includes(marker))) finish();
    });
    const poll = setInterval(() => {
      const now = Date.now();
      if (sawMcpStartup && now - lastMcpSeen >= QUIET_MS) finish();
      // No MCP-startup line ever appeared — Codex has no servers configured
      // or finished before we tapped; give it a short grace then proceed.
      else if (!sawMcpStartup && now - startedAt >= NO_MCP_GRACE_MS) finish();
    }, 250);
    const cap = setTimeout(finish, HARD_CAP_MS);
  });
  await delay(400);
}

export function detectFatalWorkerRuntimeError(
  buffer: string,
  runtime: WorkerTask["runtimePreference"],
): string | null {
  if (runtime !== "claude" && runtime !== "codex") return null;
  const visible = stripAnsiWorkerTap(buffer);
  const checks: Array<[RegExp, string]> = [
    [/API Error:.*socket connection was closed unexpectedly/i, "runtime API error: socket connection closed unexpectedly"],
    [/API Error:/i, "runtime API error before final report"],
    [/socket connection was closed unexpectedly/i, "runtime API error: socket connection closed unexpectedly"],
    [/fetch\(\)/i, "runtime network fetch failure before final report"],
    [/rate limit/i, "runtime rate limit before final report"],
    [/overloaded|temporarily unavailable/i, "runtime temporarily unavailable before final report"],
  ];
  for (const [pattern, reason] of checks) {
    if (pattern.test(visible)) return reason;
  }
  return null;
}

// Write a synthetic final-report so the autopilot review loop can consume the
// failure as worker evidence (the manager will see status=failed and decide
// whether to retry, route to a different runtime, or ask the user).
export async function writeAutoFailureReport(
  paths: WorkerArtifactPaths,
  task: WorkerTask,
  reason: string,
): Promise<void> {
  const report: WorkerReport = {
    status: "failed",
    summary: `Spark could not complete the ${task.runtimePreference} CLI worker for this task: ${reason}.`,
    filesChanged: [],
    commandsRun: [],
    tests: [],
    proof: [],
    risks: [
      `${task.runtimePreference} CLI failed before producing a final report: ${reason}. Verify it is installed, logged in, reachable, and the model id is valid.`,
    ],
    followups: [
      "Verify the CLI is installed, on PATH, and logged in, then re-run.",
    ],
  };
  try {
    await fs.writeFile(paths.finalReportJson, JSON.stringify(report, null, 2), "utf8");
  } catch {
    /* if we can't write the report the watchdog still resolves on pty exit */
  }
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
    // moves off 0%. Cursor's working indicator is the "Composing" line plus
    // "ctrl+c to stop" in the follow-up footer. The tap is installed now
    // (input is idle post-startup) so no stale "esc to interrupt" from the
    // startup phase is captured.
    let visible = "";
    const offTap = pty.tap(attemptId, (chunk) => {
      visible = (visible + stripAnsiWorkerTap(chunk.toString("utf8"))).slice(-6000);
    });
    const startedTurn = (): boolean => {
      // Codex's MCP-startup spinner prints "(Ns • esc to interrupt)" too, so
      // "esc to interrupt" only means a real turn once that startup line is
      // gone. Without this guard a paste dropped during startup is read as a
      // started turn (false positive) and the run hangs at an empty prompt.
      const mcpStarting = /Starting MCP servers/i.test(visible);
      return (
        (!mcpStarting && /esc to interrupt/i.test(visible)) ||
        /Context\s+[1-9][0-9]?%\s+used/i.test(visible) ||
        /\btokens used\b/i.test(visible) ||
        /\bComposing\b/.test(visible) ||
        /ctrl\+c to stop/i.test(visible) ||
        /Composer\s+2\.5\s+Fast\s+·\s+[0-9]+(?:\.[0-9]+)?%/i.test(visible)
      );
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
