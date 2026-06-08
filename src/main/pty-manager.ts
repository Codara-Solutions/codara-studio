import * as nodePty from "node-pty";
import { spawn as spawnChild } from "node:child_process";
import { promises as fsp, chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { WebContents } from "electron";
import type { ShellInfo } from "@shared/types";
import { injectEnrichedPath } from "./path-reconstruction";
import { getHookRpcEnvSafe } from "./hook-rpc";

interface Session {
  id: string;
  // Working directory the pty was spawned in. Lets disposeUnderCwd find and
  // kill the shells / agent panes holding a worktree open when it's deleted.
  cwd: string;
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
  // Ring buffer of the most recent raw pty bytes for this session, used by
  // the agent-socket terminal.read RPC so a sibling sub-agent can peek at
  // another worker's output without going through the renderer's xterm
  // scrollback. Capped at TAIL_BUFFER_BYTES to keep RAM bounded.
  tail: Buffer[];
  tailBytes: number;
  // Whether the renderer has a live IPC listener bound to this session. When
  // the renderer-side TerminalPane unmounts during a workspace switch, it
  // calls pause(id), which flips this to false. enqueueData then diverts
  // bytes into detachedBacklog instead of webContents.send (which would be
  // dropped on receipt with no listener). On reattach the renderer calls
  // resume(id), which drains the backlog through webContents.send first and
  // flips back to true so live data resumes normally. Default true — fresh
  // sessions are always attached at spawn time.
  attached: boolean;
  // Bytes emitted by the pty while attached=false. Replayed once on resume
  // so the user sees everything the agent printed during the detached window
  // (typical case: a Claude run that kept streaming while the user was in
  // another workspace). Capped at DETACHED_BACKLOG_BYTES with FIFO trim —
  // worst case the very oldest bytes of a long detachment fall off, which
  // is fine since the in-memory xterm snapshot covers the pre-unmount era.
  detachedBacklog: Buffer[];
  detachedBacklogBytes: number;
  // Set true synchronously by killNow before the underlying pty.kill() runs.
  // Gates the pty.onData closure: on Windows ConPTY drains stdout for up to
  // ~1 second after kill (FLUSH_DATA_INTERVAL in node-pty's windowsConoutConnection),
  // and that delayed drain would otherwise reach enqueueData → sessions.get(id),
  // which after killNow's sessions.delete + a same-id respawn returns the NEW
  // session. The old pty's drain bytes would interleave into the new pty's
  // output stream on the same dataChannel and corrupt xterm rendering (the
  // mode-flip Talk↔Execute symptom: characters from the old assistant text
  // appear injected into the new turn's frames).
  disposed: boolean;
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

// When a PTY is killed while a renderer's webContents is bound to its
// sessionId — and a fresh PTY spawns at the same id within a short window —
// preserve the renderer binding across the gap so the xterm in the UI follows
// the new process instead of going silent. The mode-flip respawn flow in
// claude-backend kills + respawns at the same sessionId ~150ms apart; without
// this stash the new PTY would be created with webContents:null (headless
// cli-session passes null) and the renderer's Terminal tab would stay
// attached to a dead pid forever. 10-second TTL means a delayed respawn (e.g.
// app coming back from a hang) still picks up the binding; a permanent
// dispose (deleteRun, app quit) leaves the entry to expire naturally.
interface StrandedBinding {
  webContents: WebContents;
  expiresAt: number;
  tailSnapshot: Buffer | null;
}
const strandedBindings = new Map<string, StrandedBinding>();
const STRANDED_BINDING_TTL_MS = 10_000;

function stashWebContents(id: string, s: Session): void {
  const wc = s.webContents;
  if (!wc || wc.isDestroyed()) return;
  let snapshot: Buffer | null = null;
  if (s.tail.length > 0) {
    snapshot = s.tail.length === 1 ? s.tail[0] : Buffer.concat(s.tail, s.tailBytes);
  }
  strandedBindings.set(id, {
    webContents: wc,
    expiresAt: Date.now() + STRANDED_BINDING_TTL_MS,
    tailSnapshot: snapshot,
  });
}

function consumeStrandedBinding(id: string): StrandedBinding | null {
  const entry = strandedBindings.get(id);
  if (!entry) return null;
  strandedBindings.delete(id);
  if (entry.expiresAt < Date.now()) return null;
  if (entry.webContents.isDestroyed()) return null;
  return entry;
}

const FLUSH_MS = 16;
const MAX_BUFFER_BYTES = 96_000;
// Per-session tail buffer cap. 64 KB is enough for a few thousand text-mode
// terminal lines (well past the 40-line agent-state-detection window) while
// staying cheap in idle RAM even with many concurrent worker panes.
const TAIL_BUFFER_BYTES = 64 * 1024;
// Per-session cap for bytes held while the renderer is detached (workspace
// switched away). 2 MB covers a long Claude streaming response plus its
// tool output without putting an unbounded amount of dead PTY data into
// process memory. FIFO-trimmed past the cap.
const DETACHED_BACKLOG_BYTES = 2 * 1024 * 1024;

// Env vars that agent-socket asks pty-manager to inject into every spawned
// pty. Populated from src/main/index.ts via setAgentSocketEnv() once the
// socket server is listening; sub-agent CLIs running inside the pty read
// these to dial back into Spark over JSON-RPC.
let agentSocketEnv: { url: string; token: string } | null = null;

/** Called by agent-socket once its HTTP server is listening. */
export function setAgentSocketEnv(env: { url: string; token: string } | null): void {
  agentSocketEnv = env;
}

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

// node-pty on POSIX (macOS/Linux) never execs the target program directly.
// Every spawn goes through a bundled `spawn-helper` executable: node-pty
// posix_spawn()s the helper, which chdir()s into the cwd, claims the slave
// PTY as its controlling terminal, then execvp()s the real program (see
// node-pty src/unix/pty.cc — argv[0] is the helper, argv[2] the program).
// If the prebuilt `spawn-helper` is missing its execute bit, posix_spawn
// fails with EACCES and node-pty surfaces it as the opaque error
// "posix_spawnp failed." — which kills EVERY pty (user terminals, worker
// panes, and the Claude/Codex chat backends), leaving a black terminal.
//
// The bit goes missing whenever node_modules is materialised without
// preserving POSIX mode bits: a tree copied from Windows, a perms-stripping
// archive restore, or an npm cache that didn't keep +x. node-pty's own
// loader (lib/utils.js) does NOT chmod the helper at runtime, so nothing
// self-corrects. Windows is immune — ConPTY has no spawn-helper — which is
// exactly why "works on Windows, black on Mac" is the signature symptom.
//
// This guard restores the bit once per process, before the first spawn. It's
// a no-op on Windows and on the common case where the bit is already set.
let helperExecChecked = false;
function ensureSpawnHelperExecutable(): void {
  if (helperExecChecked) return;
  helperExecChecked = true;
  if (process.platform === "win32") return;
  try {
    const req = createRequire(__filename);
    const ptyRoot = dirname(req.resolve("node-pty/package.json"));
    // Cover both the unbundled dev tree and a packaged app where node-pty is
    // relocated under app.asar.unpacked (node-pty itself does the same
    // app.asar → app.asar.unpacked rewrite when resolving helperPath). chmod
    // on the virtual app.asar copy fails harmlessly and is ignored.
    const roots = new Set<string>([
      ptyRoot,
      ptyRoot.replace("app.asar", "app.asar.unpacked"),
    ]);
    for (const root of roots) {
      for (const helper of [
        join(root, "build", "Release", "spawn-helper"),
        join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
      ]) {
        let mode: number;
        try {
          mode = statSync(helper).mode;
        } catch {
          continue; // not this layout / not present
        }
        // The app runs as the file owner, so owner-execute (S_IXUSR, 0o100) is
        // what posix_spawn actually needs. If it's missing, restore the
        // canonical 0755 the prebuild ships with.
        if ((mode & 0o100) === 0) {
          try {
            chmodSync(helper, mode | 0o755);
            console.warn(
              `[pty-manager] restored missing execute bit on node-pty spawn-helper: ${helper}`,
            );
          } catch (err) {
            console.error(
              `[pty-manager] could not mark spawn-helper executable (${helper}):`,
              err,
            );
          }
        }
      }
    }
  } catch (err) {
    console.error("[pty-manager] spawn-helper executable check failed:", err);
  }
}

export async function spawn(
  opts: SpawnOptions,
): Promise<{ id: string; pid: number; startupCommandHandled?: boolean }> {
  ensureSpawnHelperExecutable();
  const pending = pendingKills.get(opts.id);
  if (pending) {
    clearTimeout(pending);
    pendingKills.delete(opts.id);
  }

  const existing = sessions.get(opts.id);
  if (existing) {
    // A late-attaching webContents (e.g. ChatPanel's backend-terminal tab
    // mounting after the cli-session already spawned the PTY) needs the
    // recent scrollback or it sees a blank xterm — historical bytes only
    // went to dataTaps before, never to webContents.send. Replay the tail
    // buffer once, before attach, so the user sees CC's banner + recent
    // turn instead of a black hole.
    const previouslyDetached = !existing.webContents && Boolean(opts.webContents);
    if (opts.webContents) existing.webContents = opts.webContents;
    if (previouslyDetached && opts.webContents && existing.tail.length > 0) {
      const snapshot = existing.tail.length === 1
        ? existing.tail[0]
        : Buffer.concat(existing.tail, existing.tailBytes);
      try {
        opts.webContents.send(existing.dataChannel, snapshot);
      } catch {
        /* webContents may have been destroyed before we got here; OK */
      }
    }
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
  // Hook RPC env (big-bet "Hook contract for sub-agents to self-report").
  // Layered LAST so the values main process owns (URL, token) can't be
  // accidentally overridden by a caller — every worker pty sees the same
  // URL + token, and a per-pane SPARK_PANE_ID equal to the pty's session id.
  // getHookRpcEnvSafe returns null in headless eval mode or before
  // startHookRpc has run, in which case workers spawn without the env block
  // and the regex-tail fallback (big bet A) takes over.
  const hookEnv = getHookRpcEnvSafe(opts.id);
  if (hookEnv) {
    env.SPARK_HOOK_URL = hookEnv.SPARK_HOOK_URL;
    env.SPARK_HOOK_TOKEN = hookEnv.SPARK_HOOK_TOKEN;
    env.SPARK_PANE_ID = hookEnv.SPARK_PANE_ID;
  }

  // Agent-socket handshake. Every pty we spawn — user panes and worker panes
  // alike — gets SPARK_AGENT_SOCKET + SPARK_AGENT_TOKEN so any sub-agent CLI
  // running inside the pty can dial back into Spark over JSON-RPC. The
  // socket is localhost-only and token-protected (see src/main/agent-socket.ts),
  // so exposing the env vars to user panes does not widen the trust surface
  // beyond "any local process the user already trusted with a shell prompt".
  if (agentSocketEnv) {
    env.SPARK_AGENT_SOCKET = agentSocketEnv.url;
    env.SPARK_AGENT_TOKEN = agentSocketEnv.token;
    // Best-effort hint to sub-agents about which pty they're running in.
    // Lets terminal.read RPC default to "read my own tail" if a CLI ever
    // wants that, without forcing the caller to know its own attemptId.
    env.SPARK_AGENT_PANE_ID = opts.id;
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

  // If a renderer's xterm was bound to this sessionId on a just-killed PTY
  // (mode-flip respawn), re-adopt that webContents so the UI follows the new
  // process. A headless cli-session passes webContents:null; the renderer
  // never re-spawns on its own. Without this adoption the xterm tab keeps
  // listening on `pty:data:<sessionId>` but the new pty has no sink.
  const stranded = opts.webContents ? null : consumeStrandedBinding(opts.id);
  const session: Session = {
    id: opts.id,
    cwd,
    pty,
    webContents: opts.webContents ?? stranded?.webContents ?? null,
    dataChannel: `pty:data:${opts.id}`,
    exitChannel: `pty:exit:${opts.id}`,
    pendingChunks: [],
    pendingBytes: 0,
    flushTimer: null,
    resizedAt: 0,
    exited: false,
    tail: [],
    tailBytes: 0,
    attached: true,
    detachedBacklog: [],
    detachedBacklogBytes: 0,
    disposed: false,
  };

  // Capture the local session reference so we can identity-gate this closure.
  // On a same-id respawn, the OLD pty's drain bytes call this callback for
  // up to ~1s after kill (ConPTY's FLUSH_DATA_INTERVAL); without the gate they
  // would land in the NEW session and corrupt xterm output. See Session.disposed.
  pty.onData((data: string | Buffer) => {
    if (session.disposed) return;
    enqueueData(opts.id, data);
  });

  // On a stranded-binding adoption (mode-flip respawn), push a hard terminal
  // reset to the adopted webContents BEFORE the new pty emits anything. The
  // killed pty's last partial Ink frame left the xterm in an inconsistent
  // state (alt-screen on, cursor parked mid-line, scroll region set, SGR
  // colors active). Without this reset, the new pty's Ink frames paint over
  // a dirty cell grid and characters/whole rows from the old frame remain
  // visible (the visible "prompt twice side-by-side" symptom).
  //
  // Sequence ORDER matters: \x1bc (RIS, full reset) MUST come first. If we
  // sent \x1b[?1049l first to exit alt-screen, the terminal would restore
  // the saved main-screen content that the old CC stamped there (banner,
  // partial transcript, etc.) — the subsequent reset clears the live screen
  // but xterm.js in practice leaves the just-restored content visible
  // alongside the new CC's redraw. By full-resetting first, alt-screen mode
  // is dropped as part of the reset and the saved main-screen is discarded
  // before anything else runs.
  // Order: \x1bc (RIS) → \x1b[H (home) → \x1b[2J (clear viewport) →
  // \x1b[3J (clear scrollback) → \x1b[?1049l (idempotent alt-screen-off as
  // a final belt-and-braces against renderers that ignore the alt-screen
  // bit in RIS).
  if (stranded && session.webContents && !session.webContents.isDestroyed()) {
    const reset = Buffer.from("\x1bc\x1b[H\x1b[2J\x1b[3J\x1b[?1049l", "utf8");
    try {
      session.webContents.send(
        session.dataChannel,
        new Uint8Array(reset.buffer, reset.byteOffset, reset.byteLength),
      );
    } catch {
      /* destroyed mid-send; harmless */
    }
  }

  pty.onExit(({ exitCode, signal }) => {
    const current = sessions.get(opts.id);
    if (current && current !== session) return;
    const s = current ?? session;
    if (s) {
      s.exited = true;
      flushDataNow(s);
      if (s.webContents && !s.webContents.isDestroyed()) {
        s.webContents.send(s.exitChannel, { exitCode, signal });
      }
      // Stash for a potential same-id respawn (mode-flip flow). If the kill
      // path already stashed, that wins — overwriting with stale tail would
      // duplicate replay. Only stash here for natural exits that didn't go
      // through killNow.
      if (!strandedBindings.has(opts.id)) {
        stashWebContents(opts.id, s);
      }
      if (s.flushTimer) clearTimeout(s.flushTimer);
    }
    if (current === session) sessions.delete(opts.id);
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
  // Tail ring buffer for agent-socket terminal.read. Append, then trim from
  // the head until total bytes fit under TAIL_BUFFER_BYTES. Whole chunks are
  // dropped at a time to keep this O(1) per write — we accept a small amount
  // of slop above the cap until the next write trims it again.
  s.tail.push(chunk);
  s.tailBytes += chunk.length;
  while (s.tail.length > 1 && s.tailBytes - (s.tail[0]?.length ?? 0) > TAIL_BUFFER_BYTES) {
    const dropped = s.tail.shift();
    if (dropped) s.tailBytes -= dropped.length;
  }
  // Renderer is detached (workspace switched away) — divert into the backlog
  // instead of the pending flush queue. The backlog is replayed in one shot
  // when the renderer reattaches; sending via webContents.send while the
  // renderer-side IPC listener is unbound would drop the bytes on the floor.
  if (!s.attached) {
    s.detachedBacklog.push(chunk);
    s.detachedBacklogBytes += chunk.length;
    while (
      s.detachedBacklog.length > 1 &&
      s.detachedBacklogBytes - (s.detachedBacklog[0]?.length ?? 0) > DETACHED_BACKLOG_BYTES
    ) {
      const dropped = s.detachedBacklog.shift();
      if (dropped) s.detachedBacklogBytes -= dropped.length;
    }
    return;
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

// Called by the renderer when a TerminalPane unmounts (workspace switch). Any
// pty bytes that arrive while paused are diverted into detachedBacklog and
// replayed on resume. Idempotent: re-pausing an already-paused session is a
// no-op. Pending chunks queued for the next 16 ms flush are absorbed into the
// backlog so the small window between cleanup and pause is not lost.
export function pause(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  if (!s.attached) return;
  s.attached = false;
  if (s.pendingChunks.length > 0) {
    for (const chunk of s.pendingChunks) {
      s.detachedBacklog.push(chunk);
      s.detachedBacklogBytes += chunk.length;
    }
    s.pendingChunks = [];
    s.pendingBytes = 0;
    while (
      s.detachedBacklog.length > 1 &&
      s.detachedBacklogBytes - (s.detachedBacklog[0]?.length ?? 0) > DETACHED_BACKLOG_BYTES
    ) {
      const dropped = s.detachedBacklog.shift();
      if (dropped) s.detachedBacklogBytes -= dropped.length;
    }
  }
  if (s.flushTimer) {
    clearTimeout(s.flushTimer);
    s.flushTimer = null;
  }
}

// Called by the renderer when a TerminalPane (re)mounts. Drains the
// detachedBacklog through the same webContents.send channel as live data so
// the onData listener receives the missed bytes in arrival order, then flips
// `attached` back to true so subsequent pty output resumes the normal flush
// path. Safe to call on a fresh session (no backlog, attached already true).
export function resume(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  if (
    s.detachedBacklog.length > 0 &&
    s.webContents &&
    !s.webContents.isDestroyed()
  ) {
    const total = s.detachedBacklogBytes;
    const merged =
      s.detachedBacklog.length === 1
        ? s.detachedBacklog[0]
        : Buffer.concat(s.detachedBacklog, total);
    s.webContents.send(
      s.dataChannel,
      new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength),
    );
  }
  s.detachedBacklog = [];
  s.detachedBacklogBytes = 0;
  s.attached = true;
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

/** True iff a PTY with this id is currently registered. Used by the
 *  renderer-side backend-terminal tab to decide whether to mount its
 *  xterm — mounting too early triggers a spawn attempt for the placeholder
 *  shell, which fails with ENOENT and surfaces as "File not found". */
export function exists(id: string): boolean {
  return sessions.has(id);
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

// Snapshot the recent raw bytes of a session's tail buffer. Used by the
// agent-socket terminal.read RPC so a sibling sub-agent can sample another
// worker's output. Returns up to maxBytes from the end (clamped to the
// per-session ring buffer size — see TAIL_BUFFER_BYTES). Returns null when
// the session doesn't exist so the caller can distinguish "no data yet" from
// "unknown pane".
export function readTail(id: string, maxBytes: number): Buffer | null {
  const s = sessions.get(id);
  if (!s) return null;
  const cap = Math.max(0, Math.min(maxBytes | 0, TAIL_BUFFER_BYTES));
  if (cap === 0 || s.tail.length === 0) return Buffer.alloc(0);
  const merged = s.tail.length === 1 ? s.tail[0] : Buffer.concat(s.tail, s.tailBytes);
  if (merged.length <= cap) return merged;
  return merged.subarray(merged.length - cap);
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

// Normalize a path for prefix comparison: forward slashes, no trailing slash,
// lower case (Windows paths are case-insensitive and Node / git can disagree
// on drive-letter case).
function normalizeCwd(p: string): string {
  return (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// Hard-kill every session whose working directory is at or under `dir`. Used
// when deleting a worktree/workspace: on Windows a shell or agent pane whose
// cwd is inside the directory holds it open, so the rmdir fails with EBUSY
// until the process tree is reaped. Returns the number of sessions killed.
export function disposeUnderCwd(dir: string): number {
  const target = normalizeCwd(dir);
  if (!target) return 0;
  let killed = 0;
  // Snapshot keys first — killNow mutates the sessions map.
  for (const id of [...sessions.keys()]) {
    const s = sessions.get(id);
    if (!s) continue;
    const c = normalizeCwd(s.cwd);
    if (c === target || c.startsWith(`${target}/`)) {
      killNow(id);
      killed += 1;
    }
  }
  return killed;
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
  // Synchronously mark the session disposed BEFORE kill() so the pty.onData
  // gate (above in doSpawn) drops any late drain bytes. Without this, ConPTY
  // can keep firing onData for ~1s after kill, and those bytes would route
  // through enqueueData → sessions.get(id) → land in the next same-id session.
  s.disposed = true;
  // Stash the renderer-attached webContents so a fast respawn at the same id
  // (mode-flip in claude-backend) can re-bind it; otherwise the xterm tab in
  // the UI silently goes deaf to the new process.
  stashWebContents(id, s);
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
  s.tail = [];
  s.tailBytes = 0;
  s.detachedBacklog = [];
  s.detachedBacklogBytes = 0;
  sessions.delete(id);
}
