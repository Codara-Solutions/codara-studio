import * as nodePty from "node-pty";
import type { WebContents } from "electron";
import type { ShellInfo } from "@shared/types";

interface Session {
  id: string;
  pty: nodePty.IPty;
  webContents: WebContents;
}

const sessions = new Map<string, Session>();

// Kills are delayed by GRACE_MS so a same-id spawn arriving in the same tick
// can cancel them. This keeps PTYs alive across React StrictMode's dev
// mount→unmount→mount dry-cycle without requiring the renderer to know
// anything about it.
const pendingKills = new Map<string, NodeJS.Timeout>();
const GRACE_MS = 50;

export interface SpawnOptions {
  id: string;
  shell: ShellInfo;
  cwd: string;
  cols: number;
  rows: number;
  webContents: WebContents;
}

export function spawn(opts: SpawnOptions): { id: string; pid: number } {
  // Cancel a pending kill for this id (same-id remount within grace window).
  const pending = pendingKills.get(opts.id);
  if (pending) {
    clearTimeout(pending);
    pendingKills.delete(opts.id);
  }

  // If a session is already alive for this id, rebind it to the (possibly
  // refreshed) renderer and resize. This is the path StrictMode hits.
  const existing = sessions.get(opts.id);
  if (existing) {
    existing.webContents = opts.webContents;
    try {
      existing.pty.resize(Math.max(1, opts.cols | 0), Math.max(1, opts.rows | 0));
    } catch {
      /* may have exited */
    }
    return { id: opts.id, pid: existing.pty.pid };
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  // Strip Anthropic API key per project policy when spawning workers.
  delete env.ANTHROPIC_API_KEY;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";

  // node-pty on Windows fails silently with an empty cwd — the PTY looks
  // alive but never echoes input. Fall back to home/cwd.
  const cwd =
    opts.cwd && opts.cwd.trim().length > 0
      ? opts.cwd
      : process.env.UserProfile || process.env.HOME || process.cwd();

  const pty = nodePty.spawn(opts.shell.exe, opts.shell.args, {
    name: "xterm-256color",
    cols: Math.max(1, opts.cols | 0),
    rows: Math.max(1, opts.rows | 0),
    cwd,
    env,
  });

  const dataChannel = `pty:data:${opts.id}`;
  const exitChannel = `pty:exit:${opts.id}`;

  // Look up webContents on every send instead of capturing in the closure, so
  // a rebind via the existing-session path above takes effect immediately.
  pty.onData((data) => {
    const s = sessions.get(opts.id);
    if (s && !s.webContents.isDestroyed()) s.webContents.send(dataChannel, data);
  });

  pty.onExit(({ exitCode, signal }) => {
    const s = sessions.get(opts.id);
    if (s && !s.webContents.isDestroyed()) {
      s.webContents.send(exitChannel, { exitCode, signal });
    }
    sessions.delete(opts.id);
    const t = pendingKills.get(opts.id);
    if (t) {
      clearTimeout(t);
      pendingKills.delete(opts.id);
    }
  });

  sessions.set(opts.id, { id: opts.id, pty, webContents: opts.webContents });
  return { id: opts.id, pid: pty.pid };
}

export function write(id: string, data: string): void {
  const s = sessions.get(id);
  if (!s) return;
  s.pty.write(data);
}

export function resize(id: string, cols: number, rows: number): void {
  const s = sessions.get(id);
  if (!s) return;
  try {
    s.pty.resize(Math.max(1, cols | 0), Math.max(1, rows | 0));
  } catch {
    /* pty may have exited */
  }
}

export function dispose(id: string): void {
  if (!sessions.has(id) || pendingKills.has(id)) return;
  const timer = setTimeout(() => {
    pendingKills.delete(id);
    killNow(id);
  }, GRACE_MS);
  pendingKills.set(id, timer);
}

export function disposeForWebContents(wc: WebContents): void {
  for (const [id, s] of sessions) {
    if (s.webContents === wc) killNow(id);
  }
}

export function disposeAll(): void {
  for (const t of pendingKills.values()) clearTimeout(t);
  pendingKills.clear();
  for (const id of [...sessions.keys()]) killNow(id);
}

function killNow(id: string): void {
  const pending = pendingKills.get(id);
  if (pending) {
    clearTimeout(pending);
    pendingKills.delete(id);
  }
  const s = sessions.get(id);
  if (!s) return;
  try {
    s.pty.kill();
  } catch {
    /* ignore */
  }
  sessions.delete(id);
}
