import * as nodePty from "node-pty";
import { spawn as spawnChild } from "node:child_process";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { WebContents } from "electron";
import type { ShellInfo } from "@shared/types";
import { injectEnrichedPath } from "./path-reconstruction";

interface Session {
  id: string;
  pty: nodePty.IPty;
  // Renderer sink for live output. Null in headless eval mode — orchestration
  // drives workers without a BrowserWindow, so pty bytes go only to main-process
  // taps (the agent-TUI sniffer) and the writer writes/exit waiters.
  webContents: WebContents | null;
  dataChannel: string;
  exitChannel: string;
  pendingChunks: Buffer[];
  pendingBytes: number;
  flushTimer: NodeJS.Timeout | null;
  resizedAt: number;
  exited: boolean;
}

const sessions = new Map<string, Session>();
// Listeners for "session id became available" — orchestration uses this to
// wait until the renderer-side TerminalView has called pty:spawn before we
// start typing into the pwsh shell.
const spawnWaiters = new Map<string, Array<() => void>>();
// Listeners for pty exit — orchestration uses this to release the run loop
// when the user closes the worker pane mid-task.
const exitWaiters = new Map<string, Array<(info: { exitCode: number; signal?: number }) => void>>();
// Main-process taps on a session's output stream. Orchestration uses this to
// sniff for agent-TUI banners (so we know the launch command actually started
// the agent rather than failing back to a pwsh prompt).
const dataTaps = new Map<string, Array<(chunk: Buffer) => void>>();

const pendingKills = new Map<string, NodeJS.Timeout>();
const GRACE_MS = 250;

const FLUSH_MS = 16;
const MAX_BUFFER_BYTES = 96_000;

// Some shells run user-profile work that writes shared on-disk caches at
// startup (Terminal-Icons calls Export-Clixml on its theme files every time
// `Import-Module Terminal-Icons` runs, in $PROFILE). Spawning two pwsh
// processes in parallel — which Spark does on app launch when restoring
// multiple terminals — makes them race those writes and corrupt the file,
// after which the next pwsh start fails Import-Clixml. Serialize spawns
// per shell-family so each shell's $PROFILE completes before the next starts.
// Timeout is generous: $PROFILE with Terminal-Icons + Oh-My-Posh routinely
// takes 3–5s, and the lock is released early on the OSC 633;A prompt marker,
// so the timeout only kicks in when shell integration didn't load.
const FAMILIES_WITH_SHARED_PROFILE_WRITES = new Set(["pwsh", "powershell"]);
const SPAWN_LOCK_TIMEOUT_MS = 10_000;
const PROMPT_READY_BYTES = Buffer.from([0x1b, 0x5d, 0x36, 0x33, 0x33, 0x3b, 0x41]); // ESC ] 6 3 3 ; A
const spawnLocks = new Map<string, Promise<void>>();

const TERMINAL_ICONS_CACHE_DIR =
  process.platform === "win32" && process.env.APPDATA
    ? join(process.env.APPDATA, "powershell", "Community", "Terminal-Icons")
    : null;
let profileCacheRepairPromise: Promise<void> | null = null;

export interface SpawnOptions {
  id: string;
  shell: ShellInfo;
  cwd: string;
  cols: number;
  rows: number;
  // Optional. Pass null/undefined to spawn a pty without a renderer sink
  // (headless eval mode — orchestration drives the worker via main-process
  // taps and writes only).
  webContents?: WebContents | null;
  // Optional per-spawn env overrides layered on top of the inherited
  // process env and the shell's own env block. Use this to flip per-pane
  // flags like SPARK_NO_SHELL_INTEGRATION=1 for panes that auto-launch a
  // TUI (claude / codex worker panes) — spark.ps1 reads that var and
  // returns early, so its PSReadLine Enter hook can't echo the autorun
  // command as an OSC 633;E marker that the TUI then reads as input.
  env?: Record<string, string>;
  // Optional command to run as the shell's first action. Used by manual
  // Claude/Codex panes so they don't have to wait for the renderer to type a
  // command after the prompt appears.
  startupCommand?: string;
}

export async function spawn(
  opts: SpawnOptions,
): Promise<{ id: string; pid: number; startupCommandHandled?: boolean }> {
  const pending = pendingKills.get(opts.id);
  if (pending) {
    clearTimeout(pending);
    pendingKills.delete(opts.id);
  }

  const existing = sessions.get(opts.id);
  if (existing) {
    if (opts.webContents) existing.webContents = opts.webContents;
    try {
      existing.pty.resize(Math.max(1, opts.cols | 0), Math.max(1, opts.rows | 0));
      existing.resizedAt = Date.now();
    } catch {
      /* may have exited */
    }
    return { id: opts.id, pid: existing.pty.pid, startupCommandHandled: false };
  }

  const launch = withStartupCommand(opts.shell, opts.startupCommand);
  const spawnOpts: SpawnOptions = launch.shell === opts.shell ? opts : { ...opts, shell: launch.shell };

  // See FAMILIES_WITH_SHARED_PROFILE_WRITES — wait for the previous spawn of
  // this family to finish $PROFILE before starting the next one.
  const family = spawnOpts.shell.family;
  if (FAMILIES_WITH_SHARED_PROFILE_WRITES.has(family) && !launch.skipsProfile) {
    await repairProfileCachesOnce();
  }
  const releaseLock = FAMILIES_WITH_SHARED_PROFILE_WRITES.has(family) && !launch.skipsProfile
    ? await acquireSpawnLock(family)
    : null;

  try {
    return doSpawn(spawnOpts, releaseLock, launch.handled);
  } catch (err) {
    releaseLock?.();
    throw err;
  }
}

function withStartupCommand(
  shell: ShellInfo,
  command: string | undefined,
): { shell: ShellInfo; handled: boolean; skipsProfile: boolean } {
  const startup = command?.trim();
  if (!startup) return { shell, handled: false, skipsProfile: false };

  if (shell.family === "pwsh" || shell.family === "powershell") {
    // We deliberately do NOT take over the shell args here. The default
    // pwsh launch loads spark.ps1 (OSC 633 boundary markers), and our
    // chip-detection signals (OSC 633;E for launch, OSC 633;A for exit)
    // rely on that. The renderer's useTerminalSession types the startup
    // command into the live shell after 1500ms instead — see the autorun
    // block in src/renderer/src/components/Terminal/useTerminalSession.ts.
    return { shell, handled: false, skipsProfile: false };
  }

  if (shell.family === "cmd") {
    // /K = run then stay open (vs /C = run then exit), same reasoning as
    // pwsh -NoExit above.
    return {
      shell: { ...shell, args: ["/K", startup] },
      handled: true,
      skipsProfile: false,
    };
  }

  if (shell.family === "bash" || shell.family === "zsh") {
    // `<cmd>; exec <shell> -i` runs the agent then replaces the spawned
    // shell with a fresh interactive one so Ctrl+C from the TUI lands at
    // a prompt instead of exiting the pane.
    const exe = shell.family === "zsh" ? "zsh" : "bash";
    return {
      shell: { ...shell, args: ["-ic", `${startup}; exec ${exe} -i`] },
      handled: true,
      skipsProfile: false,
    };
  }

  if (shell.family === "sh") {
    return {
      shell: { ...shell, args: ["-ic", `${startup}; exec sh -i`] },
      handled: true,
      skipsProfile: false,
    };
  }

  return { shell, handled: false, skipsProfile: false };
}

function doSpawn(
  opts: SpawnOptions,
  releaseLock: (() => void) | null,
  startupCommandHandled: boolean,
): { id: string; pid: number; startupCommandHandled?: boolean } {
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

  // Replace the inherited (potentially sparse — Electron-from-Finder/Dock
  // strips a lot of user PATH entries) PATH with the enriched value built
  // at app startup from the user's login shell / Windows registry. The
  // cache is warmed in src/main/index.ts; on a cold call we just see the
  // process.env PATH fallback, which is no worse than today.
  injectEnrichedPath(env);

  // Per-shell env overrides (e.g. integrated strip shells set ZDOTDIR /
  // SPARK_USER_ZDOTDIR so the bundled zshrc loads the user's existing
  // config, and SPARK_TERMINAL=1 so subprocesses can detect they're in a
  // Spark pane). Kept after the base env so shell config wins.
  if (opts.shell.env) {
    for (const [k, v] of Object.entries(opts.shell.env)) {
      if (typeof v === "string") env[k] = v;
    }
  }
  // Per-spawn env overrides win over both inherited and shell-config env —
  // they're the caller's explicit knob (e.g. SPARK_NO_SHELL_INTEGRATION=1
  // on worker panes).
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (typeof v === "string") env[k] = v;
    }
  }

  const cwd =
    opts.cwd && opts.cwd.trim().length > 0
      ? opts.cwd
      : process.env.UserProfile || process.env.HOME || process.cwd();

  // Worker panes set SPARK_NO_SHELL_INTEGRATION=1 to keep spark.ps1 from
  // injecting OSC 633 markers that the embedded TUI would read as user
  // input. The same panes also do not need the user's $PROFILE — they only
  // host an agent CLI. Loading the user profile inside a worker pty surfaces
  // any module load error (e.g. Terminal-Icons → Import-PowerShellDataFile)
  // as red startup spam before the agent banner. -NoProfile suppresses that
  // entirely while still letting spark.ps1 run from -File. Regular user
  // panes never set this env var, so they keep their full profile.
  const shellArgs = (() => {
    if (env.SPARK_NO_SHELL_INTEGRATION !== "1") return opts.shell.args;
    if (opts.shell.family !== "pwsh" && opts.shell.family !== "powershell") return opts.shell.args;
    if (opts.shell.args.some((arg) => arg === "-NoProfile" || arg === "-noprofile" || arg === "-NOPROFILE")) {
      return opts.shell.args;
    }
    return ["-NoProfile", ...opts.shell.args];
  })();

  // encoding:null asks node-pty for raw Buffers so we can preserve byte
  // boundaries for ANSI/UTF-8 across IPC. xterm.js's parser/decoder reassembles
  // partial sequences across writes when fed Uint8Array.
  const pty = nodePty.spawn(opts.shell.exe, shellArgs, {
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
    webContents: opts.webContents ?? null,
    dataChannel: `pty:data:${opts.id}`,
    exitChannel: `pty:exit:${opts.id}`,
    pendingChunks: [],
    pendingBytes: 0,
    flushTimer: null,
    resizedAt: 0,
    exited: false,
  };

  pty.onData((data: string | Buffer) => enqueueData(opts.id, data));

  pty.onExit(({ exitCode, signal }) => {
    const s = sessions.get(opts.id);
    if (s) {
      s.exited = true;
      flushDataNow(s);
      if (s.webContents && !s.webContents.isDestroyed()) {
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
    const waiters = exitWaiters.get(opts.id) ?? [];
    exitWaiters.delete(opts.id);
    for (const w of waiters) {
      try {
        w({ exitCode, signal });
      } catch {
        /* ignore */
      }
    }
  });

  sessions.set(opts.id, session);
  const waiters = spawnWaiters.get(opts.id) ?? [];
  spawnWaiters.delete(opts.id);
  for (const w of waiters) {
    try {
      w();
    } catch {
      /* ignore */
    }
  }

  if (releaseLock) {
    // Release the family lock once $PROFILE has finished — detected via the
    // OSC 633;A "prompt start" marker that spark.ps1 emits at the first
    // prompt. Falls back to a timeout for shells that don't load the
    // integration (e.g. workers with SPARK_NO_SHELL_INTEGRATION=1).
    waitForPromptReady(opts.id, SPAWN_LOCK_TIMEOUT_MS).finally(releaseLock);
  }

  return { id: opts.id, pid: pty.pid, startupCommandHandled };
}

// Recover from the corruption mode described in FAMILIES_WITH_SHARED_PROFILE_WRITES:
// if a prior race truncated a Terminal-Icons cache file, every subsequent pwsh
// start prints `Import-Clixml: 'Key' is an unexpected token`/`Index operation
// failed` and the module fails to load. We used to bracket-check each cache
// file and delete only the malformed ones, but a half-overwritten file can
// still pass that check (intact <Objs> open and </Objs> close, garbage in the
// middle). Just delete the whole cache once per app session — Terminal-Icons
// regenerates it on next Import-Module, and the spawn lock above guarantees
// the regen is single-writer.
function repairProfileCachesOnce(): Promise<void> {
  if (profileCacheRepairPromise) return profileCacheRepairPromise;
  profileCacheRepairPromise = (async () => {
    if (!TERMINAL_ICONS_CACHE_DIR) return;
    let entries: string[];
    try {
      entries = await fsp.readdir(TERMINAL_ICONS_CACHE_DIR);
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((name) => name.toLowerCase().endsWith(".xml"))
        .map(async (name) => {
          const path = join(TERMINAL_ICONS_CACHE_DIR, name);
          try {
            await fsp.unlink(path);
          } catch {
            /* best-effort */
          }
        }),
    );
  })();
  return profileCacheRepairPromise;
}

function acquireSpawnLock(family: string): Promise<() => void> {
  const prev = spawnLocks.get(family) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = () => {
      if (spawnLocks.get(family) === next) spawnLocks.delete(family);
      resolve();
    };
  });
  spawnLocks.set(family, next);
  return prev.then(() => release);
}

function waitForPromptReady(id: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      untap();
      clearTimeout(timer);
      offExitFn();
      resolve();
    };
    const untap = tap(id, (chunk) => {
      if (chunk.includes(PROMPT_READY_BYTES)) finish();
    });
    const offExitFn = onExit(id, () => finish());
    const timer = setTimeout(finish, timeoutMs);
  });
}

function enqueueData(id: string, data: string | Buffer): void {
  const s = sessions.get(id);
  if (!s) return;

  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  // Fan out to main-process taps before buffering for the renderer. Taps
  // observe the live byte stream and must not modify it.
  const taps = dataTaps.get(id);
  if (taps && taps.length > 0) {
    for (const tap of taps) {
      try {
        tap(chunk);
      } catch {
        /* tap handlers are best-effort; never let one break IPC */
      }
    }
  }
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
  // Headless eval: no renderer sink, so we just drop the buffered bytes —
  // taps already saw them and that's all main needs.
  if (!s.webContents) {
    s.pendingChunks = [];
    s.pendingBytes = 0;
    return;
  }
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

// Inject text as a bracketed paste (CSI 200~ ... CSI 201~) followed by an
// optional submit (CR). Every "write to a running CLI" feature needs this —
// element inspector, drag-drop file paths, slash commands, persona
// injection — so they all go through the same node-pty path as user input.
//
// Sanitization: ConPTY corrupts NULs in its input stream, so they're stripped.
// vibeyard's helper also gates on the terminal having advertised ?2004h
// (bracketed-paste mode); we skip that subtlety here because every modern
// interactive shell (bash, zsh, fish, pwsh+PSReadLine) enables it by default,
// and TUIs like claude/codex treat the escape pair as a no-op if they ignore
// it. If a future caller targets a non-interactive shell that doesn't honor
// bracketed paste, the escapes will be echoed verbatim and that's the bug to
// fix at the call site, not here.
export function inject(id: string, text: string, opts?: { submit?: boolean }): void {
  if (!sessions.has(id)) return;
  const sanitized = text.replace(/\x00/g, "");
  write(id, `\x1b[200~${sanitized}\x1b[201~`);
  const submit = opts?.submit ?? true;
  if (submit) write(id, "\r");
}

export function resize(id: string, cols: number, rows: number): void {
  const s = sessions.get(id);
  if (!s) return;
  try {
    s.pty.resize(Math.max(1, cols | 0), Math.max(1, rows | 0));
    s.resizedAt = Date.now();
  } catch {
    /* pty may have exited */
  }
}

export function hasSession(id: string): boolean {
  return sessions.has(id);
}

// Wait for a renderer-spawned session to come online. Used by orchestration
// after it emits the "envelope_prepared" event — the renderer adds the pane,
// TerminalView mounts, calls pty:spawn, and main can then start typing into
// the (now-warm) pwsh shell. Resolves false on timeout.
export function waitForSpawn(id: string, timeoutMs: number): Promise<boolean> {
  if (sessions.has(id)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      const list = spawnWaiters.get(id);
      if (list) {
        const idx = list.indexOf(onSpawn);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) spawnWaiters.delete(id);
      }
      resolve(ok);
    };
    const onSpawn = () => finish(true);
    const list = spawnWaiters.get(id) ?? [];
    list.push(onSpawn);
    spawnWaiters.set(id, list);
    setTimeout(() => finish(false), Math.max(0, timeoutMs));
  });
}

// Wait until the renderer has reported a real pane size, so the launch
// command goes into a pty already sized to its actual visible width. Without
// this, claude/codex paint at 80x24 and smear once the renderer reports the
// real size mid-render.
export function waitForResize(id: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      const s = sessions.get(id);
      if (s && s.resizedAt > 0) return resolve(true);
      if (Date.now() - startedAt >= timeoutMs) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

// Subscribe to the raw byte stream of a session. Returns an unsubscribe fn.
// Used by orchestration to detect whether a launch command actually started
// the agent TUI (vs falling back to a pwsh prompt because the binary errored).
export function tap(id: string, handler: (chunk: Buffer) => void): () => void {
  const list = dataTaps.get(id) ?? [];
  list.push(handler);
  dataTaps.set(id, list);
  return () => {
    const cur = dataTaps.get(id);
    if (!cur) return;
    const idx = cur.indexOf(handler);
    if (idx >= 0) cur.splice(idx, 1);
    if (cur.length === 0) dataTaps.delete(id);
  };
}

export function onExit(
  id: string,
  handler: (info: { exitCode: number; signal?: number }) => void,
): () => void {
  const list = exitWaiters.get(id) ?? [];
  list.push(handler);
  exitWaiters.set(id, list);
  return () => {
    const cur = exitWaiters.get(id);
    if (!cur) return;
    const idx = cur.indexOf(handler);
    if (idx >= 0) cur.splice(idx, 1);
    if (cur.length === 0) exitWaiters.delete(id);
  };
}

export function dispose(id: string): void {
  if (!sessions.has(id) || pendingKills.has(id)) return;
  const timer = setTimeout(() => {
    pendingKills.delete(id);
    killNow(id);
  }, GRACE_MS);
  pendingKills.set(id, timer);
}

// Hard, immediate kill — no GRACE_MS wait. Used by force-pause / delete-run
// flows where lingering ConPTY descendants would hold file handles open
// and cause Windows to refuse the directory delete with an "in use" prompt.
export function killImmediate(id: string): void {
  killNow(id);
}

export function disposeForWebContents(wc: WebContents): void {
  for (const [id, s] of sessions) {
    if (s.webContents === wc) killNow(id);
  }
}

export function detachForWebContents(wc: WebContents): void {
  for (const s of sessions.values()) {
    if (s.webContents !== wc) continue;
    s.webContents = null;
    s.pendingChunks = [];
    s.pendingBytes = 0;
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
  // On Windows, ConPTY can leave descendant processes alive (a `cmd /c npm
  // start` started a node + esbuild + nodemon tree, and only the cmd is the
  // direct child of conhost). `taskkill /T /F /PID` walks the descendant
  // tree and SIGKILLs everything, which is what users expect when they
  // close a terminal pane that was running a dev server. We do this in
  // addition to pty.kill() — pty.kill drops the pseudo-console, taskkill
  // reaps the actual process tree.
  if (process.platform === "win32") {
    const pid = s.pty.pid;
    if (typeof pid === "number" && pid > 0) {
      try {
        const child = spawnChild(
          "taskkill",
          ["/T", "/F", "/PID", String(pid)],
          {
            windowsHide: true,
            stdio: "ignore",
            detached: false,
          },
        );
        // The fire-and-forget child can outlive the pty close path; ensure
        // we never let an unhandled error crash the main process.
        child.on("error", () => undefined);
        child.unref();
      } catch {
        /* taskkill missing in PATH should be impossible on Windows; ignore */
      }
    }
  }
  if (s.flushTimer) clearTimeout(s.flushTimer);
  sessions.delete(id);
}
