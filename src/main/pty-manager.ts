import * as nodePty from "node-pty";
import type { WebContents } from "electron";
import type { ShellInfo } from "@shared/types";

interface Session {
  id: string;
  pty: nodePty.IPty;
  webContents: WebContents;
  dataChannel: string;
  exitChannel: string;
  pendingChunks: Buffer[];
  pendingBytes: number;
  flushTimer: NodeJS.Timeout | null;
}

const sessions = new Map<string, Session>();

const pendingKills = new Map<string, NodeJS.Timeout>();
const GRACE_MS = 250;

const FLUSH_MS = 16;
const MAX_BUFFER_BYTES = 96_000;

export interface SpawnOptions {
  id: string;
  shell: ShellInfo;
  cwd: string;
  cols: number;
  rows: number;
  webContents: WebContents;
}

export function spawn(opts: SpawnOptions): { id: string; pid: number } {
  const pending = pendingKills.get(opts.id);
  if (pending) {
    clearTimeout(pending);
    pendingKills.delete(opts.id);
  }

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

  const cols = Math.max(1, opts.cols | 0);
  const rows = Math.max(1, opts.rows | 0);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  // Ink/React-CLI (Claude Code, Codex) inspects these to pick interactive/colour
  // mode. Inheriting CI=true or NO_COLOR from a parent shell silently disables
  // ANSI cursor sequences and produces visually corrupt redraws.
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.FORCE_COLOR = "3";
  env.COLUMNS = String(cols);
  env.LINES = String(rows);
  delete env.CI;
  delete env.NO_COLOR;
  delete env.NODE_DISABLE_COLORS;
  delete env.NODE_NO_READLINE;

  const cwd =
    opts.cwd && opts.cwd.trim().length > 0
      ? opts.cwd
      : process.env.UserProfile || process.env.HOME || process.cwd();

  // encoding:null asks node-pty for raw Buffers so we can preserve byte
  // boundaries for ANSI/UTF-8 across IPC. xterm.js's parser/decoder reassembles
  // partial sequences across writes when fed Uint8Array.
  const pty = nodePty.spawn(opts.shell.exe, opts.shell.args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
    encoding: null as unknown as string,
    useConpty: process.platform === "win32" ? true : undefined,
  } as nodePty.IPtyForkOptions);

  const session: Session = {
    id: opts.id,
    pty,
    webContents: opts.webContents,
    dataChannel: `pty:data:${opts.id}`,
    exitChannel: `pty:exit:${opts.id}`,
    pendingChunks: [],
    pendingBytes: 0,
    flushTimer: null,
  };

  pty.onData((data: string | Buffer) => enqueueData(opts.id, data));

  pty.onExit(({ exitCode, signal }) => {
    const s = sessions.get(opts.id);
    if (s) {
      flushDataNow(s);
      if (!s.webContents.isDestroyed()) {
        s.webContents.send(s.exitChannel, { exitCode, signal });
      }
      if (s.flushTimer) clearTimeout(s.flushTimer);
    }
    sessions.delete(opts.id);
    const t = pendingKills.get(opts.id);
    if (t) {
      clearTimeout(t);
      pendingKills.delete(opts.id);
    }
  });

  sessions.set(opts.id, session);
  return { id: opts.id, pid: pty.pid };
}

function enqueueData(id: string, data: string | Buffer): void {
  const s = sessions.get(id);
  if (!s) return;

  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  s.pendingChunks.push(chunk);
  s.pendingBytes += chunk.length;

  if (s.pendingBytes >= MAX_BUFFER_BYTES) {
    flushDataNow(s);
    return;
  }

  if (s.flushTimer) return;
  s.flushTimer = setTimeout(() => {
    s.flushTimer = null;
    flushDataNow(s);
  }, FLUSH_MS);
}

function flushDataNow(s: Session): void {
  if (s.flushTimer) {
    clearTimeout(s.flushTimer);
    s.flushTimer = null;
  }
  if (s.pendingChunks.length === 0) return;
  if (s.webContents.isDestroyed()) {
    s.pendingChunks = [];
    s.pendingBytes = 0;
    return;
  }
  const merged = s.pendingChunks.length === 1 ? s.pendingChunks[0] : Buffer.concat(s.pendingChunks, s.pendingBytes);
  s.pendingChunks = [];
  s.pendingBytes = 0;
  // Ship as Uint8Array so the renderer can hand it directly to xterm.js
  // without going through a string round-trip.
  s.webContents.send(s.dataChannel, new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength));
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
    flushDataNow(s);
    s.pty.kill();
  } catch {
    /* ignore */
  }
  if (s.flushTimer) clearTimeout(s.flushTimer);
  sessions.delete(id);
}
