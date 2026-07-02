import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { WorkerTask } from "@shared/types";

// Three-channel stuck detector. A worker is declared stuck only when ALL of:
//  - pty byte stream (TUI spinner repaints)
//  - CLI session jsonl file (Codex / Claude record per-turn events here)
//  - workspace filesystem (the worker is editing files / git index)
// have been silent for the same window. Long thinks paint spinner frames; long
// tool work writes to the session log or workspace; only a true wedge silences
// all three. Conservative on purpose — false positives kill a legit run.
const WORKSPACE_SCAN_DEPTH = 2;
const WORKSPACE_SKIP = new Set([
  ".git",
  ".next",
  ".turbo",
  ".Cora", ".SparkAgent",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

export interface StuckSignal {
  silentForMs: number;
  ptyIdleMs: number;
  sessionLogIdleMs: number;
  workspaceIdleMs: number;
  sessionLogPath: string | null;
}

export interface StuckWatchdogOptions {
  task: WorkerTask;
  cwd: string;
  launchTimestampMs: number;
  idleThresholdMs: number;
  pollIntervalMs?: number;
  onStuck: (info: StuckSignal) => void;
}

export interface StuckWatchdog {
  bumpPtyActivity: () => void;
  stop: () => void;
}

export function installStuckWatchdog(opts: StuckWatchdogOptions): StuckWatchdog {
  const pollMs = opts.pollIntervalMs ?? Math.max(15_000, Math.floor(opts.idleThresholdMs / 6));
  let lastPtyAt = Date.now();
  let stopped = false;
  let firing = false;
  let sessionLogPath: string | null = null;

  const interval = setInterval(() => {
    if (stopped || firing) return;
    firing = true;
    void check().finally(() => {
      firing = false;
    });
  }, pollMs);

  async function check(): Promise<void> {
    const now = Date.now();
    const ptyIdleMs = now - lastPtyAt;
    if (ptyIdleMs < opts.idleThresholdMs) return;

    if (!sessionLogPath) {
      sessionLogPath = await resolveSessionLogPath(opts.task.runtimePreference, opts.cwd, opts.launchTimestampMs);
    }
    const sessionMtime = sessionLogPath
      ? await fs.stat(sessionLogPath).then((s) => s.mtimeMs).catch(() => 0)
      : 0;
    const sessionLogIdleMs = now - Math.max(sessionMtime, opts.launchTimestampMs);
    if (sessionLogPath && sessionLogIdleMs < opts.idleThresholdMs) return;

    const wsMtime = await newestWorkspaceMtime(opts.cwd, WORKSPACE_SCAN_DEPTH).catch(() => 0);
    const workspaceIdleMs = now - Math.max(wsMtime, opts.launchTimestampMs);
    if (workspaceIdleMs < opts.idleThresholdMs) return;

    stopped = true;
    clearInterval(interval);
    opts.onStuck({
      silentForMs: Math.min(ptyIdleMs, sessionLogPath ? sessionLogIdleMs : ptyIdleMs, workspaceIdleMs),
      ptyIdleMs,
      sessionLogIdleMs,
      workspaceIdleMs,
      sessionLogPath,
    });
  }

  return {
    bumpPtyActivity: () => { lastPtyAt = Date.now(); },
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}

async function resolveSessionLogPath(
  runtime: WorkerTask["runtimePreference"],
  cwd: string,
  launchTimestampMs: number,
): Promise<string | null> {
  const candidates = await listSessionLogCandidates(runtime, cwd);
  const fresh = candidates
    .filter((c) => c.mtimeMs >= launchTimestampMs - 5_000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return fresh[0]?.path ?? null;
}

async function listSessionLogCandidates(
  runtime: WorkerTask["runtimePreference"],
  cwd: string,
): Promise<Array<{ path: string; mtimeMs: number }>> {
  if (runtime === "codex") {
    return findRecentJsonlsUnder(path.join(homedir(), ".codex", "sessions"), 4);
  }
  if (runtime === "claude") {
    return findRecentJsonlsUnder(path.join(homedir(), ".claude", "projects", encodeClaudeCwd(cwd)), 2);
  }
  return [];
}

// Claude Code maps a project cwd onto its log folder by replacing /, \, and :
// with `-`. Mirror that so we land in the right directory on Windows + POSIX.
function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/[\\/:]/g, "-");
}

async function findRecentJsonlsUnder(
  dir: string,
  maxDepth: number,
): Promise<Array<{ path: string; mtimeMs: number }>> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  await walk(dir, maxDepth);
  return out;

  async function walk(d: string, depth: number): Promise<void> {
    if (depth < 0) return;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full, depth - 1);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        const st = await fs.stat(full).catch(() => null);
        if (st) out.push({ path: full, mtimeMs: st.mtimeMs });
      }
    }
  }
}

async function newestWorkspaceMtime(root: string, maxDepth: number): Promise<number> {
  let newest = 0;
  await walk(root, maxDepth);
  return newest;

  async function walk(d: string, depth: number): Promise<void> {
    if (depth < 0) return;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (WORKSPACE_SKIP.has(e.name)) continue;
      const full = path.join(d, e.name);
      const st = await fs.stat(full).catch(() => null);
      if (!st) continue;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      if (e.isDirectory()) await walk(full, depth - 1);
    }
  }
}

export const STUCK_REASON_PREFIX = "worker stuck:";

export function formatStuckReason(info: StuckSignal): string {
  const parts = [
    `pty silent ${secs(info.ptyIdleMs)}s`,
    info.sessionLogPath
      ? `session-log silent ${secs(info.sessionLogIdleMs)}s`
      : "session-log unresolved",
    `workspace silent ${secs(info.workspaceIdleMs)}s`,
  ];
  return `${STUCK_REASON_PREFIX} no activity for ${secs(info.silentForMs)}s across all three channels (${parts.join("; ")})`;
}

function secs(ms: number): number {
  return Math.round(ms / 1000);
}
