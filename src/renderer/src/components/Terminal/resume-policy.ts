// Pure decision helpers for Claude/Codex/Grok/Pi terminal-session resume.
// Kept in a dep-free module (no xterm / React imports) so scripts/test-transcript-repair
// and scripts/test-session-restore can bundle and unit-test the branch logic
// without pulling the whole terminal stack. useTerminalSession consumes these
// for BOTH the boot-once restore path and the in-place death re-arm path.

// Shape of the `agentSession:probe` IPC result the decision reads.
export interface ResumeProbe {
  exists: boolean;
  // false → the transcript is present but not resumable (stillborn / no user
  // message); undefined/true → resumable.
  resumable?: boolean;
  // Claude only: the transcript is resumable in principle but its LAST line is a
  // truncated partial JSON record (a mid-write kill — the classic sleep/crash
  // corruption). Repair the tail before `claude --resume` instead of silently
  // starting a fresh session and losing the conversation.
  repairable?: boolean;
  transcriptPath?: string;
  // Claude only: the transcript was found in another project folder than the
  // pointer's cwd names, and this is the directory that maps to it (the
  // session's start cwd). Present only when it differs from the probed cwd.
  cwd?: string;
}

export type ResumeDecision =
  // Transcript healthy → resume as-is.
  | { kind: "resume" }
  // Claude transcript tail truncated → repair in place, then resume.
  | { kind: "repair-resume" }
  // Claude, Grok or Pi, not resumable → self-heal by launching a FRESH
  // session (Claude and Grok with a forced id, Pi plain).
  | { kind: "fresh" }
  // Codex, not resumable → clear the pointer, leave a plain shell (Codex can't
  // force a session id, so there's nothing deterministic to relaunch).
  | { kind: "clear" };

// Map a probe result to the action to take. Split out of computeResumePlan so
// the branch choice is unit-testable against synthetic probe results with no
// PTY, no IPC, and no filesystem.
export function decideResume(
  probe: ResumeProbe,
  runtime: "claude" | "codex" | "grok" | "pi",
): ResumeDecision {
  const resumable = probe.exists && probe.resumable !== false;
  if (resumable) {
    if (runtime === "claude" && probe.repairable === true) return { kind: "repair-resume" };
    return { kind: "resume" };
  }
  return runtime === "codex" ? { kind: "clear" } : { kind: "fresh" };
}

/**
 * Move a restore pointer to the directory its transcript was actually found
 * under. A pointer that saved a directory the agent later cd'ed into names the
 * wrong project folder; the probe finds the transcript by id and reports the
 * start cwd, and resuming (and persisting) from there keeps the conversation
 * and puts the pane back in its own folder. Returns null when nothing moves.
 */
export function relocateResumePointer<P extends AgentSessionPointer>(
  pointer: P,
  probe: ResumeProbe,
): P | null {
  if (!probe.exists || !probe.cwd || probe.cwd === pointer.cwd) return null;
  return {
    ...pointer,
    cwd: probe.cwd,
    transcriptPath: probe.transcriptPath ?? pointer.transcriptPath,
  };
}

// Structural twin of tabs/types.ts TerminalAgentSession, redeclared here so
// this module stays dep-free for the node test harnesses.
export interface AgentSessionPointer {
  runtime: "claude" | "codex" | "grok" | "pi";
  nativeClaudeProfileId?: string;
  nativeCodexProfileId?: string;
  nativeGrokProfileId?: string;
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
  capturedAt: string;
  active?: boolean;
}

// One SessionStart hook record from main's pane → session-identity registry
// (src/main/agent-session-registry.ts).
export interface SessionStartRecord {
  paneId?: string;
  runtime: "claude" | "codex" | "pi";
  active?: boolean;
  restoreOnBoot?: boolean;
  nativeClaudeProfileId?: string;
  nativeCodexProfileId?: string;
  sessionId: string;
  transcriptPath?: string;
  cwd?: string;
  source?: string;
  timestamp: string;
}

function parseTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Reconcile a pane's persisted restore pointer with the newest SessionStart
 * hook record for that pane. The hook is ground truth for *identity* — it
 * fires with the real session id on startup, `--resume`, in-TUI `/resume`,
 * and `/clear`, all of which are invisible to filesystem discovery (they
 * append to an old transcript or swap ids without creating a file). The
 * pointer keeps restore eligibility for ordinary hooks. Process tracking and
 * the shutdown census can explicitly replace that eligibility via `active`.
 *
 * Returns the healed pointer when the record is strictly newer and changes
 * something, or null for "keep the pointer as-is" (no record, stale record,
 * same identity, or a record too incomplete to act on).
 */
export function mergeSessionStart(
  pointer: AgentSessionPointer | null | undefined,
  start: SessionStartRecord | null | undefined,
): AgentSessionPointer | null {
  if (!start?.sessionId) return null;
  const startTs = parseTimestamp(start.timestamp);
  if (startTs <= 0) return null;
  if (!pointer?.sessionId) {
    // Adopting a pointer out of thin air still needs a cwd — Claude resume is
    // scoped to the launch directory's project bucket.
    if (!start.cwd) return null;
    return {
      runtime: start.runtime,
      nativeCodexProfileId: start.nativeCodexProfileId,
      nativeClaudeProfileId: start.nativeClaudeProfileId,
      sessionId: start.sessionId,
      cwd: start.cwd,
      transcriptPath: start.transcriptPath,
      capturedAt: new Date(startTs).toISOString(),
      active: start.active === true,
    };
  }
  if (startTs <= parseTimestamp(pointer.capturedAt)) return null;
  if (pointer.runtime === start.runtime && pointer.sessionId === start.sessionId) {
    // Same session re-announced (our own `--resume`, or a compact). Identity
    // is unchanged; only fill a missing transcript path.
    if ((pointer.transcriptPath || !start.transcriptPath) &&
        (start.active === undefined || start.active === pointer.active)) return null;
    return {
      ...pointer,
      nativeClaudeProfileId:
        start.runtime === "claude" ? start.nativeClaudeProfileId ?? pointer.nativeClaudeProfileId : undefined,
      transcriptPath: start.transcriptPath ?? pointer.transcriptPath,
      active: start.active ?? pointer.active,
      capturedAt: new Date(startTs).toISOString(),
    };
  }
  return {
    runtime: start.runtime,
    nativeCodexProfileId: start.nativeCodexProfileId,
    nativeClaudeProfileId:
      start.runtime === "claude" ? start.nativeClaudeProfileId ?? pointer.nativeClaudeProfileId : undefined,
    sessionId: start.sessionId,
    cwd: start.cwd ?? pointer.cwd,
    transcriptPath: start.transcriptPath,
    capturedAt: new Date(startTs).toISOString(),
    // Ordinary hooks preserve eligibility; a process census can replace it.
    active: start.active ?? pointer.active,
  };
}

// The accounts pty:spawn reports for the session it created or attached to.
export interface LiveSessionAccounts {
  nativeClaudeProfileId?: string;
  nativeCodexProfileId?: string;
  nativeGrokProfileId?: string;
}

/**
 * Point a pane's restore pointer at the account its live process actually
 * runs on. A Claude restore lands on the Active account whatever the pointer
 * named, and a pane re-attached after an account switch keeps the account it
 * started on; leaving the pointer behind would show the wrong account and
 * send the stale one into every later attach. Only a reported account
 * replaces the pointer's: a plain shell reports none and keeps the account
 * its typed agent was captured with.
 *
 * Returns the updated pointer, or null when nothing changes.
 */
export function adoptLiveSessionAccount<P extends AgentSessionPointer>(
  pointer: P | null | undefined,
  live: LiveSessionAccounts | null | undefined,
): P | null {
  if (!pointer?.sessionId || !live) return null;
  const key =
    pointer.runtime === "claude"
      ? "nativeClaudeProfileId"
      : pointer.runtime === "codex"
        ? "nativeCodexProfileId"
        : pointer.runtime === "grok"
          ? "nativeGrokProfileId"
          : null;
  if (!key) return null;
  const reported = live[key];
  if (!reported || reported === pointer[key]) return null;
  return { ...pointer, [key]: reported };
}

const AUTO_RESUME_WINDOW_MS = 300_000; // 5 minutes
const AUTO_RESUME_MAX = 2;

// Drop attempt timestamps older than the rolling window.
export function pruneAttempts(
  attempts: readonly number[],
  now: number,
  windowMs: number = AUTO_RESUME_WINDOW_MS,
): number[] {
  return attempts.filter((t) => now - t < windowMs);
}

// Crash-loop guard for in-place auto-resume after an unexpected pty death.
// Allow at most `max` attempts within a rolling `windowMs`; beyond that leave
// the pane dead with a manual-resume notice so a session that dies on every
// launch (bad cwd, broken CLI) can't spin forever.
export function canAutoResume(
  attempts: readonly number[],
  now: number,
  windowMs: number = AUTO_RESUME_WINDOW_MS,
  max: number = AUTO_RESUME_MAX,
): boolean {
  return pruneAttempts(attempts, now, windowMs).length < max;
}
