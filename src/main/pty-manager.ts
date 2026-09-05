import * as nodePty from "node-pty";
import { spawn as spawnChild } from "node:child_process";
import { promises as fsp, chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { WebContents } from "electron";
import type {
  PtyExitInfo,
  PtyResourceSnapshot,
  PtySessionResourceDiagnostic,
  ProjectPolicyMode,
  ShellInfo,
} from "@shared/types";
import { isRemotePath, parseRemotePath } from "@shared/remote";
import { sanitizeNestedAgentEnv } from "./env-sanitize";
import { injectEnrichedPath } from "./path-reconstruction";
import { resolveBinary } from "./binary-resolver";
import { getHookRpcEnvSafe } from "./hook-rpc";
import { codaraHome } from "./codara-home";
import { logMain } from "./file-log";
import { getConnection, shQuote } from "./remote/connections";
import { formatManualAgentStartup, parseManualAgentStartupCommand } from "./manual-agent-startup";
import { assertManualAgentLaunchAllowed } from "./orchestration/project-policy";
import { buildCodexCliSharedEnvironment } from "./orchestration/codex-cli-profile-execution";
import { isCodaraManagedCliPath } from "./orchestration/codara-managed-cli-roots";
import { buildGrokCliProfileEnvironment } from "./orchestration/grok-cli-profile-execution";
import { buildClaudeCliProfileEnvironment } from "./orchestration/claude-cli-profile-environment";
import {
  acquireNativeCodexProfileLease,
  resolveFrozenNativeCodexProfile,
  notifyNativeCodexProfileLeaseReleased,
  resolveNewNativeCodexProfile,
} from "./orchestration/native-codex-profile-runtime";
import {
  acquireNativeGrokProfileLease,
  notifyNativeGrokProfileLeaseReleased,
  resolveFrozenNativeGrokProfile,
  resolveNewNativeGrokProfile,
} from "./orchestration/native-grok-profile-runtime";
import {
  acquireNativeClaudeProfileLease,
  notifyNativeClaudeProfileLeaseReleased,
  resolveFrozenNativeClaudeProfile,
  resolveNewNativeClaudeProfile,
} from "./orchestration/native-claude-profile-runtime";
import { resolvePlainShellAccountSelectors } from "./orchestration/native-cli-shell-defaults";
import { ensureCodexProjectTrust } from "./orchestration/codex-trust";
import { installClaudeHooks } from "./hook-installer";
import {
  beginPosixPtyTreeTeardown,
  capturePosixPtyTree,
  isPosixPtyTreeAlive,
  signalPosixPtyTree,
  type PosixPtyTreeTarget,
} from "./posix-pty-tree";

// The subset of node-pty's IPty that pty-manager actually drives. Local
// sessions hand in the real IPty; REMOTE sessions (ssh:// cwd) hand in an
// adapter over an ssh2 shell channel with the same shape — everything
// downstream (tail buffers, pause/resume, taps, kill bookkeeping) is
// transport-agnostic. Remote handles report pid 0, which the Windows
// taskkill reaping paths already skip via their `pid > 0` guards.
type PtyHandle = Pick<nodePty.IPty, "pid" | "write" | "resize" | "kill" | "onData" | "onExit"> &
  // Real OS-level read flow control, present on node-pty's IPty but not on
  // the ssh2 remote adapter, hence optional. Distinct from this module's
  // pause()/resume(), which only divert the RENDERER sink and leave the
  // child producing at full speed. See pauseFlow below.
  Partial<Pick<nodePty.IPty, "pause" | "resume">>;

interface Session {
  id: string;
  // Process-generation fence. A same-id respawn receives a new value so a
  // diagnostic sweep can never act on a replacement process using stale data.
  generationId: string;
  createdAt: number;
  lastInputAt: number;
  lastOutputAt: number;
  lastAttachAt: number;
  // Working directory the pty was spawned in. Lets disposeUnderCwd find and
  // kill the shells / agent panes holding a worktree open when it's deleted.
  cwd: string;
  pty: PtyHandle;
  // Renderer sink for live output. Null in headless eval mode — orchestration
  // drives workers without a BrowserWindow, so pty bytes go only to main-process
  // taps (the agent-TUI sniffer) and the writer writes/exit waiters.
  webContents: WebContents | null;
  dataChannel: string;
  // Out-of-band "the next N bytes on dataChannel are HISTORY, not live output"
  // marker. Replayed bytes (the raw-tail reattach frame, the post-sleep backlog
  // drain) deliberately travel the live data channel so the renderer's onData
  // listener applies them in arrival order — but the renderer also runs
  // heuristics on that stream (the dev-server URL sniffer), and those must not
  // treat hours-old output as something that just happened. See announceReplay.
  replayChannel: string;
  exitChannel: string;
  pendingChunks: Buffer[];
  pendingBytes: number;
  flushTimer: NodeJS.Timeout | null;
  // OS-level read flow control is shared by two independent consumers: the
  // remote-access socket (reason "remote") and the local renderer's xterm
  // (reason "render"). The pty is paused while ANY hold is present and
  // resumed only when the last one is released, so neither consumer can
  // silently undo the other's pause. See holdFlow / releaseFlow.
  flowHolds: Set<FlowHoldReason>;
  // Renderer backpressure accounting (reason "render"). Bytes shipped on
  // dataChannel that xterm has not yet reported parsed. Accounting starts at
  // the first pty:ack from this renderer (older or foreign consumers that
  // never ack are never throttled), and a watchdog releases a hold that sees
  // no ack progress so a renderer bug can never freeze a child for good.
  renderUnackedBytes: number;
  renderAckSeen: boolean;
  renderHoldWatchdog: NodeJS.Timeout | null;
  renderUnackedAtHold: number;
  resizedAt: number;
  cols: number;
  rows: number;
  exited: boolean;
  // Ring buffer of the most recent raw pty bytes for this session, used by
  // the agent-socket terminal.read RPC so a sibling sub-agent can peek at
  // another worker's output without going through the renderer's xterm
  // scrollback. Capped at TAIL_BUFFER_BYTES to keep RAM bounded.
  //
  // Eviction is head-index based, not shift() based: with ~44-byte pty chunks
  // the array holds ~95k entries at the 4 MB cap, and Array.prototype.shift()
  // re-indexes all of them on EVERY chunk once the cap is reached (measured
  // 18-73 µs per chunk — the single largest per-chunk main-thread cost).
  // Instead, entries below tailHead are consumed: they are nulled (releasing
  // the Buffer) and skipped by every reader, and the array is compacted in one
  // O(live) slice once tailHead grows past TAIL_COMPACT_HEAD. Invariants:
  //   - live entries are exactly tail[tailHead .. tail.length-1], all non-null;
  //   - tailBytes is the exact byte sum of the live entries;
  //   - eviction never drops the newest chunk, so live count >= 1 after a push.
  tail: Array<Buffer | null>;
  tailBytes: number;
  tailHead: number;
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
  // Set true the first time an exit is emitted on exitChannel — by node-pty's
  // real onExit OR by sweepDeadSessions synthesizing one on wake-from-sleep.
  // Guards against a double exit event when the OS severed the ConPTY (sweep
  // fires) and node-pty then fires its own onExit late for the same session.
  exitEmitted: boolean;
  // Set true before the kill whenever CODARA asked for this teardown: an
  // orchestration killImmediate/dispose, or the app-quit sweep. Carried out on
  // the exit payload as PtyExitInfo.sanctioned so the branding layers can tell
  // "Cora ended this pane" from "the process died on its own". pty.kill() is a
  // SIGHUP, which surfaces as exitCode 0 + signal 1, so exit status alone can
  // never make that distinction.
  sanctioned: boolean;
  nativeCodexProfileId?: string;
  releaseNativeCodexProfileLease?: () => void;
  nativeClaudeProfileId?: string;
  releaseNativeClaudeProfileLease?: () => void;
  nativeGrokProfileId?: string;
  releaseNativeGrokProfileLease?: () => void;
}

const sessions = new Map<string, Session>();
/** Session ids between native account resolution and `sessions.set`. */
const pendingSpawns = new Set<string>();
let nextSessionGeneration = 0;

function createSessionGeneration(id: string): string {
  nextSessionGeneration += 1;
  return `${id}:${Date.now().toString(36)}:${nextSessionGeneration.toString(36)}`;
}

function releaseNativeProfileSessionLeases(session: Session): void {
  const release = session.releaseNativeCodexProfileLease;
  session.releaseNativeCodexProfileLease = undefined;
  release?.();
  if (release && session.nativeCodexProfileId) {
    notifyNativeCodexProfileLeaseReleased(session.nativeCodexProfileId);
  }
  const releaseClaude = session.releaseNativeClaudeProfileLease;
  session.releaseNativeClaudeProfileLease = undefined;
  releaseClaude?.();
  if (releaseClaude && session.nativeClaudeProfileId) {
    // A terminal exit is the moment Claude Code most likely rotated the
    // account's token; the unified account service folds it back into Cora's
    // copy now rather than at the next poll. Best effort, off the teardown path.
    notifyNativeClaudeProfileLeaseReleased(session.nativeClaudeProfileId);
  }
  const releaseGrok = session.releaseNativeGrokProfileLease;
  session.releaseNativeGrokProfileLease = undefined;
  releaseGrok?.();
  if (releaseGrok && session.nativeGrokProfileId) {
    notifyNativeGrokProfileLeaseReleased(session.nativeGrokProfileId);
  }
}
// Listeners for "session id became available" — orchestration uses this to
// wait until the renderer-side TerminalView has called pty:spawn before we
// start typing into the pwsh shell.
const spawnWaiters = new Map<string, Array<() => void>>();
// Listeners for pty exit — orchestration uses this to release the run loop
// when the user closes the worker pane mid-task.
const exitWaiters = new Map<string, Array<(info: PtyExitInfo) => void>>();
// Main-process taps on a session's output stream. Orchestration uses this to
// sniff for agent-TUI banners (so we know the launch command actually started
// the agent rather than failing back to a pwsh prompt).
const dataTaps = new Map<string, Array<(chunk: Buffer) => void>>();

const pendingKills = new Map<string, NodeJS.Timeout>();
const GRACE_MS = 250;

// Serialize the complete "does this id already exist? otherwise create it"
// transaction per session id. Several spawn paths await before the OS process
// becomes visible in `sessions` (remote SSH connection/shell creation and
// PowerShell profile-cache repair/locking). Without an id-scoped queue, two
// callers entering during that window both observe "missing" and each create
// a process; the second sessions.set(id, ...) then strands the first process.
//
// This is intentionally separate from `spawnLocks` below: those locks protect
// shared PowerShell profile files across DIFFERENT session ids, while this map
// protects process identity for the SAME session id across every transport and
// shell family.
const sessionSpawnLocks = new Map<string, Promise<void>>();

// When a PTY is killed while a renderer's webContents is bound to its
// sessionId — and a fresh PTY spawns at the same id within a short window —
// preserve the renderer binding across the gap so the xterm in the UI follows
// the new process instead of going silent. A kill + respawn at the same
// sessionId ~150ms apart is a real flow; without
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
  const snapshot = tailSnapshot(s);
  strandedBindings.set(id, {
    webContents: wc,
    expiresAt: Date.now() + STRANDED_BINDING_TTL_MS,
    tailSnapshot: snapshot,
  });
  const sweep = setTimeout(() => {
    const entry = strandedBindings.get(id);
    if (entry && entry.expiresAt <= Date.now()) strandedBindings.delete(id);
  }, STRANDED_BINDING_TTL_MS + 250);
  sweep.unref();
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
// Renderer backpressure watermarks. xterm.js parses 5 to 35 MB/s while an
// agent TUI can emit far more, so once the renderer is a quarter megabyte
// behind the pty is paused at the OS level and the child blocks on its own
// write until xterm catches up to the low mark. Bounded lag keeps Ctrl+C,
// scrolling and typing responsive under a flood, and memory flat, instead of
// running into xterm's 50 MB write-buffer cliff where bytes are dropped.
const RENDER_HIGH_WATER_BYTES = 256_000;
const RENDER_LOW_WATER_BYTES = 64_000;
const RENDER_HOLD_WATCHDOG_MS = 2_000;

type FlowHoldReason = "remote" | "render";
// Per-session tail buffer cap. Keep enough raw terminal history to reconstruct
// a full-screen Claude/Codex TUI after a renderer/GPU restart on wake. This is
// intentionally generous: a raw tail is the only lossless recovery source for
// cursor-relative TUI frames, and the user explicitly prefers durability over
// the few extra megabytes of RAM per busy terminal.
const TAIL_BUFFER_BYTES = 4 * 1024 * 1024;
// How far the tail's consumed-prefix head index may grow before the array is
// compacted (one slice dropping the nulled prefix). 4096 amortizes the O(live)
// copy down to a few array-slot moves per chunk while keeping at most ~4k dead
// slots (the Buffers themselves are already nulled at eviction time).
const TAIL_COMPACT_HEAD = 4096;

// Number of live (unevicted) chunks in the session's tail ring.
function tailLiveCount(s: Session): number {
  return s.tail.length - s.tailHead;
}

// Full snapshot of the live tail bytes as one Buffer, or null when empty.
// Only for the rare reattach/stash paths — per-chunk code must never call
// this (it concats up to TAIL_BUFFER_BYTES).
function tailSnapshot(s: Session): Buffer | null {
  const live = tailLiveCount(s);
  if (live === 0) return null;
  if (live === 1) return s.tail[s.tailHead] ?? null;
  // Live entries are non-null by the tail invariant; the filter only narrows
  // the type. tailBytes is their exact sum.
  return Buffer.concat(
    s.tail.slice(s.tailHead).filter((c): c is Buffer => c !== null),
    s.tailBytes,
  );
}

// Tell the renderer that the NEXT `byteLength` bytes on this session's data
// channel are replayed history (a reattach frame or a post-sleep backlog),
// not output the child just produced. Sent immediately before the replay
// itself; Electron delivers a single sender's messages to a webContents in
// send order, so the marker always lands first and the renderer can attribute
// exactly that many bytes to the replay.
//
// Why this exists: the renderer sniffs the byte stream for dev-server URLs and
// (when the user opted in) auto-opens a preview tab for one. Without the
// marker, a `Local: http://localhost:3000` line that a dev server printed
// hours before the laptop slept re-arrives verbatim on wake and reads exactly
// like a server that just came up — so Studio opens a preview onto a port
// nothing is listening on any more.
function announceReplay(s: Session, byteLength: number): void {
  if (byteLength <= 0) return;
  if (!s.webContents || s.webContents.isDestroyed()) return;
  try {
    s.webContents.send(s.replayChannel, { bytes: byteLength });
  } catch {
    /* webContents may die between the guard and the send; the replay below
       is still correct, it just isn't tagged. */
  }
}
// Per-session cap for bytes held while the renderer is detached (workspace
// switched away or the host is locked/asleep). 16 MB covers long tool output
// accumulated over an extended laptop sleep while remaining bounded. The
// backlog is FIFO-trimmed past the cap.
const DETACHED_BACKLOG_BYTES = 16 * 1024 * 1024;

// Env vars that agent-socket asks pty-manager to inject into every spawned
// pty. Populated from src/main/index.ts via setAgentSocketEnv() once the
// socket server is listening; sub-agent CLIs running inside the pty read
// these to dial back into Codara over JSON-RPC.
let agentSocketEnv: { url: string; token: string } | null = null;

/** Called by agent-socket once its HTTP server is listening. */
export function setAgentSocketEnv(env: { url: string; token: string } | null): void {
  agentSocketEnv = env;
}

// Some shells run user-profile work that writes shared on-disk caches at
// startup (Terminal-Icons calls Export-Clixml on its theme files every time
// `Import-Module Terminal-Icons` runs, in $PROFILE). Spawning two pwsh
// processes in parallel — which Codara does on app launch when restoring
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
  /**
   * Main-process-only policy derived from persisted workspace provenance.
   * Renderer IPC deliberately never accepts this field.
   */
  projectPolicyMode?: ProjectPolicyMode;
  // Mirror attach: a SECONDARY renderer xterm observing an EXISTING session
  // whose canonical pane lives elsewhere (TerminalPane's readOnly mode — the
  // Automations live-board dock). A mirror attach must be a pure no-op on
  // session state: no webContents reassignment, no tail replay (the replay is
  // broadcast on the shared data channel and would double-paint the canonical
  // xterm), and crucially NO resize — the existing-session branch below
  // otherwise resizes the pty to the caller's cols/rows, which would SIGWINCH
  // the live TUI at the mirror's dimensions and garble the canonical pane.
  // A mirror can never CREATE a session; attaching to a missing id throws so
  // the mirror pane surfaces the error locally instead of spawning a shell.
  mirror?: boolean;
  // Keep the dimensions of an EXISTING PTY when a renderer pane reattaches.
  // Phone-origin terminals use this because the phone's measured grid owns
  // canonical geometry while the Studio pane remains a fully interactive
  // desktop view. Unlike `mirror`, this may create a missing session and does
  // not suppress the renderer sink, input, tail replay, or lifecycle duties.
  preserveSizeOnAttach?: boolean;
  /** Frozen native Codex account for a resume/worker pane. */
  nativeCodexProfileId?: string;
  /** Main-process-only resolved home; never accepted directly over IPC. */
  nativeCodexHome?: string;
  /** Main-process-only lease ownership transferred to the spawned session. */
  releaseNativeCodexProfileLease?: () => void;
  /** Frozen native Grok Build account for a resume/worker pane. */
  nativeGrokProfileId?: string;
  nativeGrokHome?: string;
  releaseNativeGrokProfileLease?: () => void;
  /** Frozen native Claude account for a resume/worker/manual pane. */
  nativeClaudeProfileId?: string;
  /** Main-process-only exact selector. Null preserves legacy unset. */
  nativeClaudeConfigDirEnv?: string | null;
  /** Main-process-only lease ownership transferred to the spawned session. */
  releaseNativeClaudeProfileLease?: () => void;
  /**
   * Main-process-only Active-account homes for a PLAIN shell (no Studio
   * startup command), so a hand-typed `claude`/`codex` follows the account
   * switch. Environment-only: unlike the native*ProfileId fields these take
   * no lease and are never persisted — a restored shell re-resolves whatever
   * account is Active at restore time. Set by spawn() itself, never accepted
   * over IPC.
   */
  plainShellClaudeConfigDir?: string;
  plainShellGrokHome?: string;
  /**
   * A plain user shell exports SPARK_FOLLOW_ACTIVE_ACCOUNT=1 so the bundled
   * prompt hooks re-read <codaraHome>/shell/active-cli-env and follow later
   * account switches. Set by spawn() itself, never accepted over IPC; frozen,
   * worker, agent and caller-selected panes never carry it.
   */
  plainShellFollowsActiveAccount?: boolean;
  /**
   * A user-launched agent pane (a Claude/Codex/Grok autorun, a restore, or a
   * frozen account picked for this pane) also exports
   * SPARK_FOLLOW_ACTIVE_ACCOUNT=1. The agent itself still runs under the
   * frozen selector: the startup form is `<agent>; exec <shell> -i`, and the
   * hooks only exist in the interactive shell that replaces it once the agent
   * exits. From then on the pane follows the Active account like a plain
   * shell, so a hand-typed `claude` after a switch lands on the new account.
   * Cora workers (SPARK_RUN_ID) never carry it. Set by spawn() itself.
   */
  agentShellFollowsActiveAccount?: boolean;
  /**
   * Main-process-only exact child environment. When present, pty-manager does
   * not inherit, enrich, or append Studio/provider variables. Renderer IPC
   * deliberately never forwards this field.
   */
  exactEnvironment?: NodeJS.ProcessEnv;
  /** Main-process-only: a prepared login must never attach to another PTY. */
  requireFreshSession?: boolean;
}

export interface ExactExecutablePtyOptions {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  webContents: WebContents | null;
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

export interface ExactExecutablePtyLaunch {
  spawn: {
    id: string;
    pid: number;
    startupCommandHandled?: boolean;
    attached?: boolean;
  };
  exit: Promise<PtyExitInfo>;
}

/**
 * Main-only direct-executable seam for interactive native-account login.
 * Register the exit waiter before spawning so even an immediately exiting CLI
 * keeps the account mutation guard alive through its complete PTY lifetime.
 */
export async function spawnExactExecutable(
  opts: ExactExecutablePtyOptions,
): Promise<ExactExecutablePtyLaunch> {
  let resolveExit!: (info: PtyExitInfo) => void;
  const exit = new Promise<PtyExitInfo>((resolve) => {
    resolveExit = resolve;
  });
  const offExit = onExit(opts.id, (info) => {
    offExit();
    resolveExit(info);
  });
  try {
    const spawned = await spawn({
      id: opts.id,
      shell: {
        id: "native-cli-account-login",
        label: "Native CLI account sign-in",
        exe: opts.executable,
        args: [...opts.args],
        family: "other",
      },
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      webContents: opts.webContents,
      exactEnvironment: { ...opts.env },
      requireFreshSession: true,
    });
    return { spawn: spawned, exit };
  } catch (error) {
    offExit();
    throw error;
  }
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
): Promise<{
  id: string;
  pid: number;
  startupCommandHandled?: boolean;
  attached?: boolean;
  nativeCodexProfileId?: string;
  nativeClaudeProfileId?: string;
  nativeGrokProfileId?: string;
}> {
  ensureSpawnHelperExecutable();
  // Mirror attach (see SpawnOptions.mirror): observe-only. Checked FIRST so a
  // mirror can never clear a pending kill, mutate session sinks, resize the
  // pty, or fall through into a real spawn of the placeholder shell.
  if (opts.mirror) {
    const target = sessions.get(opts.id);
    if (!target) {
      throw new Error(`mirror attach: no pty session '${opts.id}'`);
    }
    if (
      opts.nativeCodexProfileId !== undefined &&
      opts.nativeCodexProfileId !== target.nativeCodexProfileId
    ) {
      throw new Error(
        `mirror attach: pty session '${opts.id}' is pinned to another native Codex account`,
      );
    }
    if (
      opts.nativeClaudeProfileId !== undefined &&
      opts.nativeClaudeProfileId !== target.nativeClaudeProfileId
    ) {
      throw new Error(
        `mirror attach: pty session '${opts.id}' is pinned to another native Claude account`,
      );
    }
    if (
      opts.nativeGrokProfileId !== undefined &&
      opts.nativeGrokProfileId !== target.nativeGrokProfileId
    ) {
      throw new Error(
        `mirror attach: pty session '${opts.id}' is pinned to another native Grok account`,
      );
    }
    // attached: the session pre-existed, so an unhandled startupCommand here
    // means "a live shell/TUI already owns this pty", not "shell can't take
    // startup commands" — callers use the distinction to decide whether a
    // dropped resume deserves a manual-run notice.
    return {
      id: opts.id,
      pid: target.pty.pid,
      startupCommandHandled: false,
      attached: true,
      nativeCodexProfileId: target.nativeCodexProfileId,
      nativeClaudeProfileId: target.nativeClaudeProfileId,
      nativeGrokProfileId: target.nativeGrokProfileId,
    };
  }

  // `serializeSessionSpawn` records this caller in the per-id queue
  // synchronously, before this function reaches any await. Once inside the
  // critical section we re-check sessions, so queued callers attach to the
  // process the winner created instead of spawning another one.
  return serializeSessionSpawn(opts.id, async () => {
    pendingSpawns.add(opts.id);
    try {
      return await spawnWithSessionLock(opts);
    } finally {
      pendingSpawns.delete(opts.id);
    }
  });
}

async function spawnWithSessionLock(
  opts: SpawnOptions,
): Promise<{
  id: string;
  pid: number;
  startupCommandHandled?: boolean;
  attached?: boolean;
  nativeCodexProfileId?: string;
  nativeClaudeProfileId?: string;
  nativeGrokProfileId?: string;
}> {
  const pending = pendingKills.get(opts.id);
  if (pending) {
    clearTimeout(pending);
    pendingKills.delete(opts.id);
  }

  const existing = sessions.get(opts.id);
  if (existing) {
    if (opts.requireFreshSession) {
      throw new Error(`pty session '${opts.id}' already exists`);
    }
    if (
      opts.nativeCodexProfileId !== undefined &&
      opts.nativeCodexProfileId !== existing.nativeCodexProfileId
    ) {
      throw new Error(
        `pty session '${opts.id}' is already pinned to another native Codex account`,
      );
    }
    if (
      opts.nativeClaudeProfileId !== undefined &&
      opts.nativeClaudeProfileId !== existing.nativeClaudeProfileId
    ) {
      throw new Error(
        `pty session '${opts.id}' is already pinned to another native Claude account`,
      );
    }
    if (
      opts.nativeGrokProfileId !== undefined &&
      opts.nativeGrokProfileId !== existing.nativeGrokProfileId
    ) {
      throw new Error(
        `pty session '${opts.id}' is already pinned to another native Grok account`,
      );
    }
    // A late-attaching webContents (e.g. ChatPanel's backend-terminal tab
    // mounting after the cli-session already spawned the PTY) needs the
    // recent scrollback or it sees a blank xterm — historical bytes only
    // went to dataTaps before, never to webContents.send. Replay the tail
    // buffer once, before attach, so the user sees CC's banner + recent
    // turn instead of a black hole.
    const previouslyDetached = !existing.webContents && Boolean(opts.webContents);
    if (opts.webContents) {
      existing.webContents = opts.webContents;
      existing.lastAttachAt = Date.now();
    }
    if (previouslyDetached && opts.webContents) {
      // The tail replay below is the AUTHORITATIVE re-attach frame for a session
      // whose renderer sink was absent (a headless cli-session, or a raw-tail
      // detach()). Anything still sitting in pendingChunks is a strict SUBSET of
      // the tail — enqueueData appends every chunk to s.tail unconditionally
      // (line ~711) BEFORE queueing it for the renderer flush — and while
      // webContents was null those pending bytes were only ever dropped at flush
      // (see flushDataNow's no-webContents guard), never delivered. If we left
      // the pending queue + its 16 ms flushTimer armed, reassigning webContents
      // just above would let that timer fire right AFTER this tail send and
      // re-deliver the same trailing bytes a second time. For a live Ink TUI a
      // duplicated fragment applied on top of the freshly replayed frame desyncs
      // the cursor — the exact garble raw-tail reattach exists to prevent. Drop
      // the pending queue + timer here so the tail snapshot is the sole delivery.
      if (existing.flushTimer) {
        clearTimeout(existing.flushTimer);
        existing.flushTimer = null;
      }
      existing.pendingChunks = [];
      existing.pendingBytes = 0;
      // A renderer can disappear while the session is host-sleep-paused. The
      // raw tail below is authoritative on the replacement renderer, so reset
      // both pause state and its backlog before live delivery resumes. Without
      // this, `attached=false` survives the reattach and every future byte is
      // silently accumulated in a backlog that nobody drains.
      existing.attached = true;
      existing.detachedBacklog = [];
      existing.detachedBacklogBytes = 0;
      const snapshot = tailSnapshot(existing);
      if (snapshot) {
        try {
          announceReplay(existing, snapshot.byteLength);
          opts.webContents.send(existing.dataChannel, snapshot);
        } catch {
          /* webContents may have been destroyed before we got here; OK */
        }
      }
    }
    if (!opts.preserveSizeOnAttach) {
      try {
        existing.pty.resize(Math.max(1, opts.cols | 0), Math.max(1, opts.rows | 0));
        existing.resizedAt = Date.now();
      } catch {
        /* may have exited */
      }
    }
    return {
      id: opts.id,
      pid: existing.pty.pid,
      startupCommandHandled: false,
      attached: true,
      nativeCodexProfileId: existing.nativeCodexProfileId,
      nativeClaudeProfileId: existing.nativeClaudeProfileId,
      nativeGrokProfileId: existing.nativeGrokProfileId,
    };
  }

  // Recognize only Studio's finite fresh/resume command forms. Imported PR
  // refusal is transport-independent and must happen before local account
  // setup or a remote shell can start.
  const parsedStartup = parseManualAgentStartupCommand(opts.startupCommand);
  if (parsedStartup) {
    // Imported PR checkouts can provide AGENTS.md, CLAUDE.md, hooks, skills,
    // and other repository context that native agent CLIs discover before
    // Studio can reliably suppress it. Refuse this Studio-managed autorun
    // before profile resolution, Codex trust writes, hook installation, or
    // process spawn. Plain shells have no parsed startup and remain available;
    // fenced Pi PR reviews run in main and use display-only PTYs.
    assertManualAgentLaunchAllowed(opts.projectPolicyMode);
  }

  // Remote workspace pane: the cwd is a ssh://<hostId>/<path> virtual path.
  // Everything local below (shell detection, $PROFILE locks, node-pty) is
  // irrelevant — the host's own login shell runs on an ssh2 PTY channel.
  if (isRemotePath(opts.cwd)) {
    if (
      opts.nativeCodexProfileId !== undefined ||
      opts.nativeClaudeProfileId !== undefined ||
      opts.nativeGrokProfileId !== undefined
    ) {
      throw new Error("Native agent account profiles are only available in local terminals.");
    }
    return doSpawnRemote(opts);
  }

  // Prepared native-account login is already fully resolved and sanitized by
  // native-cli-accounts. It launches the executable directly, with no shell,
  // account re-resolution, hook install, or environment augmentation at this
  // layer.
  if (opts.exactEnvironment !== undefined) {
    return doSpawn(opts, null, false);
  }

  let preparedOpts = opts;
  let resolvedStartup = opts.startupCommand;
  if (parsedStartup) {
    const binary = await resolveBinary(parsedStartup.runtime);
    if (!binary) {
      throw new Error(`Cannot find ${parsedStartup.runtime}. Install its CLI, restart Codara, and try again.`);
    }
    resolvedStartup = formatManualAgentStartup(parsedStartup, binary, opts.shell.family);
    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    const launchEnv = { ...opts.shell.env, ...opts.env };
    const inheritedPath = Object.entries(launchEnv).find(([key]) => key.toLowerCase() === "path")?.[1];
    // npm shims may need a sibling node binary even when argv[0] is absolute.
    const baseEnv: Record<string, string> = {};
    injectEnrichedPath(baseEnv);
    for (const key of Object.keys(launchEnv)) {
      if (key.toLowerCase() === "path") delete launchEnv[key];
    }
    launchEnv[pathKey] = [dirname(binary), inheritedPath ?? baseEnv[pathKey]].filter(Boolean).join(delimiter);
    preparedOpts = { ...preparedOpts, env: launchEnv };
  }
  if (
    opts.nativeCodexProfileId !== undefined ||
    parsedStartup?.runtime === "codex"
  ) {
    const execution =
      opts.nativeCodexProfileId === undefined
        ? await resolveNewNativeCodexProfile()
        : await resolveFrozenNativeCodexProfile(opts.nativeCodexProfileId);
    const nativeCodexHome = execution.stateHome;
    const releaseNativeCodexProfileLease = acquireNativeCodexProfileLease(
      execution.profileId,
      `terminal:${opts.id}`,
    );
    await ensureCodexProjectTrust(opts.cwd, nativeCodexHome).catch(
      () => undefined,
    );
    preparedOpts = {
      ...preparedOpts,
      nativeCodexProfileId: execution.profileId,
      nativeCodexHome,
      releaseNativeCodexProfileLease,
    };
  }
  if (
    opts.nativeClaudeProfileId !== undefined ||
    parsedStartup?.runtime === "claude"
  ) {
    const execution =
      opts.nativeClaudeProfileId === undefined
        ? await resolveNewNativeClaudeProfile()
        : await resolveFrozenNativeClaudeProfile(opts.nativeClaudeProfileId);
    const releaseNativeClaudeProfileLease = acquireNativeClaudeProfileLease(
      execution.profileId,
      `terminal:${opts.id}`,
    );
    const claudeStateDir =
      execution.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    await installClaudeHooks({
      settingsPath: join(claudeStateDir, "settings.json"),
    }).catch(() => undefined);
    preparedOpts = {
      ...preparedOpts,
      nativeClaudeProfileId: execution.profileId,
      nativeClaudeConfigDirEnv: execution.env.CLAUDE_CONFIG_DIR ?? null,
      releaseNativeClaudeProfileLease,
    };
  }
  if (
    opts.nativeGrokProfileId !== undefined ||
    parsedStartup?.runtime === "grok"
  ) {
    const execution =
      opts.nativeGrokProfileId === undefined
        ? await resolveNewNativeGrokProfile()
        : await resolveFrozenNativeGrokProfile(opts.nativeGrokProfileId);
    const nativeGrokHome = execution.env.GROK_HOME;
    if (!nativeGrokHome) {
      throw new Error("Resolved native Grok profile has no GROK_HOME.");
    }
    const releaseNativeGrokProfileLease = acquireNativeGrokProfileLease(
      execution.profileId,
      `terminal:${opts.id}`,
    );
    preparedOpts = {
      ...preparedOpts,
      nativeGrokProfileId: execution.profileId,
      nativeGrokHome,
      releaseNativeGrokProfileLease,
    };
  }
  // A plain user shell, with no Studio startup command, no worker run, no
  // frozen account and no caller-selected home, follows the Active Claude
  // and Grok accounts: the spawn-time selector makes the first prompt right
  // (and serves shells without the bundled hooks, such as fish), and the
  // follow flag lets the bundled prompt hooks track later switches, even
  // from a personal default that becomes managed. Codex is intentionally
  // omitted because its account selector swaps auth.json in one shared state
  // home. Best-effort because a shell must always open. Deliberately no lease
  // and no persistence: an idle shell tab must not block account operations,
  // and a restored shell should follow the account that is Active at restore
  // time.
  if (
    parsedStartup === null &&
    !opts.startupCommand &&
    opts.nativeCodexProfileId === undefined &&
    opts.nativeClaudeProfileId === undefined &&
    opts.nativeGrokProfileId === undefined &&
    !Object.prototype.hasOwnProperty.call(opts.env ?? {}, "SPARK_RUN_ID") &&
    !Object.prototype.hasOwnProperty.call(opts.env ?? {}, "CLAUDE_CONFIG_DIR") &&
    !Object.prototype.hasOwnProperty.call(opts.env ?? {}, "CODEX_HOME") &&
    !Object.prototype.hasOwnProperty.call(opts.env ?? {}, "GROK_HOME")
  ) {
    const selectors = await resolvePlainShellAccountSelectors().catch(() => null);
    preparedOpts = {
      ...preparedOpts,
      plainShellFollowsActiveAccount: true,
      ...(selectors?.claudeConfigDir
        ? { plainShellClaudeConfigDir: selectors.claudeConfigDir }
        : {}),
      ...(selectors?.grokHome ? { plainShellGrokHome: selectors.grokHome } : {}),
    };
  } else if (
    !Object.prototype.hasOwnProperty.call(opts.env ?? {}, "SPARK_RUN_ID") &&
    !Object.prototype.hasOwnProperty.call(opts.env ?? {}, "CLAUDE_CONFIG_DIR") &&
    !Object.prototype.hasOwnProperty.call(opts.env ?? {}, "GROK_HOME") &&
    (parsedStartup !== null ||
      !!opts.startupCommand ||
      opts.nativeClaudeProfileId !== undefined ||
      opts.nativeGrokProfileId !== undefined)
  ) {
    // A user's agent pane: frozen for the agent, following once it exits.
    preparedOpts = { ...preparedOpts, agentShellFollowsActiveAccount: true };
  }
  const noShellIntegration =
    preparedOpts.env?.SPARK_NO_SHELL_INTEGRATION === "1";
  const launch = withStartupCommand(
    preparedOpts.shell,
    resolvedStartup,
    noShellIntegration,
  );
  const spawnOpts: SpawnOptions =
    launch.shell === preparedOpts.shell
      ? preparedOpts
      : { ...preparedOpts, shell: launch.shell };

  // See FAMILIES_WITH_SHARED_PROFILE_WRITES — wait for the previous spawn of
  // this family to finish $PROFILE before starting the next one. Panes that
  // run -NoProfile (SPARK_NO_SHELL_INTEGRATION=1 worker/agent panes — doSpawn
  // injects the flag) never touch the shared profile caches, so they neither
  // need the repair pass nor the serializing lock.
  const family = spawnOpts.shell.family;
  const skipsProfile = launch.skipsProfile || noShellIntegration;
  if (FAMILIES_WITH_SHARED_PROFILE_WRITES.has(family) && !skipsProfile) {
    await repairProfileCachesOnce();
  }
  const releaseLock = FAMILIES_WITH_SHARED_PROFILE_WRITES.has(family) && !skipsProfile
    ? await acquireSpawnLock(family)
    : null;

  try {
    return doSpawn(spawnOpts, releaseLock, launch.handled);
  } catch (err) {
    releaseLock?.();
    spawnOpts.releaseNativeCodexProfileLease?.();
    spawnOpts.releaseNativeClaudeProfileLease?.();
    spawnOpts.releaseNativeGrokProfileLease?.();
    throw err;
  }
}

function serializeSessionSpawn<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionSpawnLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });

  // This set is the crucial synchronous claim: a same-tick caller sees
  // `current` here and queues behind it even though `previous.then(...)` has
  // not begun running yet.
  sessionSpawnLocks.set(id, current);

  return previous
    .then(operation)
    .finally(() => {
      // A later caller may already have installed its own tail promise. Only
      // the current tail removes the map entry; every predecessor still
      // releases its successor. The release runs on success and failure, so a
      // rejected remote connection cannot permanently poison this id.
      if (sessionSpawnLocks.get(id) === current) {
        sessionSpawnLocks.delete(id);
      }
      release();
    });
}

// Spawn a REMOTE pty: an ssh2 shell channel on the workspace's host, wrapped
// in a PtyHandle so every downstream path (enqueueData, tail buffers,
// pause/resume/detach, taps, exit waiters) is shared with local sessions.
// The remote host runs the user's own login shell; we cd into the workspace
// path and optionally fire the startup command as the shell's first input,
// so callers get `startupCommandHandled: true` (no renderer type-after-mount
// race, same as the pwsh args-takeover path locally).
async function doSpawnRemote(
  opts: SpawnOptions,
): Promise<{ id: string; pid: number; startupCommandHandled?: boolean }> {
  const parts = parseRemotePath(opts.cwd);
  if (!parts) throw new Error(`Malformed remote path: ${opts.cwd}`);
  const cols = Math.max(1, opts.cols | 0);
  const rows = Math.max(1, opts.rows | 0);
  const conn = await getConnection(parts.hostId);
  const channel = await conn.shell({ cols, rows });

  const handle: PtyHandle = {
    pid: 0,
    write: (data: string) => {
      try {
        channel.write(data);
      } catch {
        /* channel already closed */
      }
    },
    resize: (c: number, r: number) => {
      try {
        // ssh2 order is (rows, cols, heightPx, widthPx).
        channel.setWindow(r, c, 0, 0);
      } catch {
        /* ignore */
      }
    },
    kill: () => {
      try {
        channel.close();
      } catch {
        /* ignore */
      }
    },
    onData: (cb: (data: string) => void) => {
      const listener = (d: Buffer) => cb(d as unknown as string);
      channel.on("data", listener);
      channel.stderr.on("data", listener);
      return {
        dispose: () => {
          channel.off("data", listener);
          channel.stderr.off("data", listener);
        },
      };
    },
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
      const listener = () => cb({ exitCode: 0 });
      channel.on("close", listener);
      return { dispose: () => channel.off("close", listener) };
    },
  };

  const stranded = opts.webContents ? null : consumeStrandedBinding(opts.id);
  const createdAt = Date.now();
  const session: Session = {
    id: opts.id,
    generationId: createSessionGeneration(opts.id),
    createdAt,
    lastInputAt: createdAt,
    lastOutputAt: createdAt,
    lastAttachAt: createdAt,
    cwd: opts.cwd,
    pty: handle,
    webContents: opts.webContents ?? stranded?.webContents ?? null,
    dataChannel: `pty:data:${opts.id}`,
    replayChannel: `pty:replay:${opts.id}`,
    exitChannel: `pty:exit:${opts.id}`,
    pendingChunks: [],
    pendingBytes: 0,
    flushTimer: null,
    flowHolds: new Set<FlowHoldReason>(),
    renderUnackedBytes: 0,
    renderAckSeen: false,
    renderHoldWatchdog: null,
    renderUnackedAtHold: 0,
    resizedAt: 0,
    cols,
    rows,
    exited: false,
    tail: [],
    tailBytes: 0,
    tailHead: 0,
    attached: true,
    detachedBacklog: [],
    detachedBacklogBytes: 0,
    disposed: false,
    exitEmitted: false,
    sanctioned: false,
  };

  handle.onData((data: string | Buffer) => {
    if (session.disposed) return;
    enqueueData(opts.id, data);
  });

  handle.onExit(({ exitCode, signal }) => {
    const current = sessions.get(opts.id);
    if (current && current !== session) return;
    const s = current ?? session;
    if (s.exitEmitted) {
      if (current === session) sessions.delete(opts.id);
      const t0 = pendingKills.get(opts.id);
      if (t0) {
        clearTimeout(t0);
        pendingKills.delete(opts.id);
      }
      exitWaiters.delete(opts.id);
      return;
    }
    if (s) {
      s.exitEmitted = true;
      s.exited = true;
      flushDataNow(s);
      if (s.webContents && !s.webContents.isDestroyed()) {
        s.webContents.send(s.exitChannel, { exitCode, signal, sanctioned: s.sanctioned });
      }
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
        w({ exitCode, signal, sanctioned: s.sanctioned });
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

  // First input: land in the workspace directory, mark the pane, wipe the
  // banner + echoed setup line, then run the caller's startup command (if
  // any) as the shell's first real action.
  const startup = opts.startupCommand?.trim();
  const setup =
    `cd ${shQuote(parts.path)} && export SPARK_TERMINAL=1 SPARK_REMOTE=1 && clear` +
    (startup ? ` && ${startup}` : "") +
    "\n";
  channel.write(setup);

  return { id: opts.id, pid: 0, startupCommandHandled: Boolean(startup) };
}

function withStartupCommand(
  shell: ShellInfo,
  command: string | undefined,
  noShellIntegration = false,
): { shell: ShellInfo; handled: boolean; skipsProfile: boolean } {
  const startup = command?.trim();
  if (!startup) return { shell, handled: false, skipsProfile: false };

  if (shell.family === "pwsh" || shell.family === "powershell") {
    if (noShellIntegration) {
      // Worker/agent panes (SPARK_NO_SHELL_INTEGRATION=1) never load
      // spark.ps1 — no OSC 633 markers exist to protect — so pwsh CAN take
      // the command over args here. This removes the renderer's 1500ms
      // type-after-mount race entirely: the command is the shell's first
      // action, delivered by pwsh itself, immune to profile-load timing.
      // -NoExit keeps a usable prompt after the agent exits (same reasoning
      // as cmd /K below).
      return {
        shell: { ...shell, args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", startup] },
        handled: true,
        skipsProfile: true,
      };
    }
    // Integrated panes: we deliberately do NOT take over the shell args.
    // The default pwsh launch loads spark.ps1 (OSC 633 boundary markers),
    // and our chip-detection signals (OSC 633;E for launch, OSC 633;A for
    // exit) rely on that. The renderer's useTerminalSession types the
    // startup command into the live shell after 1500ms instead — see the
    // autorun block in src/renderer/src/components/Terminal/useTerminalSession.ts.
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
    const startupArgs =
      noShellIntegration && shell.family === "bash"
        ? ["--noprofile", "--norc", "-ic"]
        : noShellIntegration
          ? ["-f", "-ic"]
          : ["-ic"];
    // The interactive shell that replaces the agent must load the bundled
    // rcfile too: bash only reads --rcfile from its own argv, so without it
    // the post-agent shell would fall back to ~/.bashrc and never install
    // the account-follow hook. zsh finds its rc through ZDOTDIR on its own.
    const rcIndex = shell.family === "bash" ? shell.args.indexOf("--rcfile") : -1;
    const rcfile = rcIndex >= 0 ? shell.args[rcIndex + 1] : undefined;
    const execArgs = rcfile ? `--rcfile ${shQuote(rcfile)} -i` : "-i";
    return {
      shell: { ...shell, args: [...startupArgs, `${startup}; exec ${exe} ${execArgs}`] },
      handled: true,
      skipsProfile: noShellIntegration,
    };
  }

  if (shell.family === "sh") {
    return {
      shell: {
        ...shell,
        args: [noShellIntegration ? "-fic" : "-ic", `${startup}; exec sh -i`],
      },
      handled: true,
      skipsProfile: noShellIntegration,
    };
  }

  if (shell.family === "fish") {
    // fish's -C runs the command after config is read but before its first
    // prompt, then keeps the interactive shell alive. --no-config mirrors the
    // profile-free agent-pane behavior used by bash/zsh/pwsh.
    return {
      shell: {
        ...shell,
        args: [
          ...(noShellIntegration ? ["--no-config"] : []),
          "-i",
          "-C",
          startup,
        ],
      },
      handled: true,
      skipsProfile: noShellIntegration,
    };
  }

  return { shell, handled: false, skipsProfile: false };
}

function doSpawn(
  opts: SpawnOptions,
  releaseLock: (() => void) | null,
  startupCommandHandled: boolean,
): {
  id: string;
  pid: number;
  startupCommandHandled?: boolean;
  nativeCodexProfileId?: string;
  nativeClaudeProfileId?: string;
  nativeGrokProfileId?: string;
} {
  const cols = Math.max(1, opts.cols | 0);
  const rows = Math.max(1, opts.rows | 0);

  const env: Record<string, string> = {};
  const environmentSource = opts.exactEnvironment ?? process.env;
  for (const [k, v] of Object.entries(environmentSource)) {
    if (typeof v === "string") env[k] = v;
  }
  if (opts.exactEnvironment === undefined) {
  // Strip inherited Claude Code nesting markers (CLAUDECODE, CLAUDE_CODE_*…)
  // BEFORE the per-shell / per-spawn override layers below, so callers that
  // deliberately set a CLAUDE_CODE_* var still win. When Codara is launched
  // from inside a CC session (how the dev instance starts), these leak into
  // every pty and make any spawned `claude` CLI believe it's a nested child —
  // CC 2.1.201 then writes NO session JSONL, killing the chat backends'
  // transcript tailing and timing out every turn. See env-sanitize.ts.
  sanitizeNestedAgentEnv(env);
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
  // Codara pane). Kept after the base env so shell config wins.
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
  // Older Codara builds selected accounts by exporting CODEX_HOME. OpenAI
  // treats that variable as the root for every Codex setting and session, so
  // carrying our retired selector into a new shell both split state and made
  // user-level keys appear project-local. Remove only Codara's known values;
  // an unrelated custom CODEX_HOME remains the user's choice.
  const inheritedCodexHome = env.CODEX_HOME?.trim();
  if (
    inheritedCodexHome &&
    (isCodaraManagedCliPath(inheritedCodexHome) ||
      resolve(inheritedCodexHome) === resolve(join(homedir(), ".codex")))
  ) {
    delete env.CODEX_HOME;
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
  // Keep hook scripts and MCP children agreeing with THIS app about where
  // the home dir lives (hooks fall back to ~/.codarastudio when unset). An
  // inherited value is replaced, not kept: Studio launched from a Codara pane
  // of another instance would otherwise hand its panes the outer app's
  // pointer and roots. The follow flag is per pane and only a plain user
  // shell gets it (below); an inherited one must not reach a frozen native
  // pane, whose prompt hook would otherwise move CLAUDE_CONFIG_DIR away
  // from the profile its lease names once the TUI exits.
  if (!Object.prototype.hasOwnProperty.call(opts.env ?? {}, "SPARK_HOME_DIR")) {
    env.SPARK_HOME_DIR = codaraHome();
  }
  if (!Object.prototype.hasOwnProperty.call(opts.env ?? {}, "SPARK_FOLLOW_ACTIVE_ACCOUNT")) {
    delete env.SPARK_FOLLOW_ACTIVE_ACCOUNT;
  }

  // Agent-socket handshake. Every pty we spawn — user panes and worker panes
  // alike — gets SPARK_AGENT_SOCKET + SPARK_AGENT_TOKEN so any sub-agent CLI
  // running inside the pty can dial back into Codara over JSON-RPC. The
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
  if (opts.nativeCodexHome) {
    const selectedEnv = buildCodexCliSharedEnvironment(env);
    for (const key of Object.keys(env)) delete env[key];
    for (const [key, value] of Object.entries(selectedEnv)) {
      if (typeof value === "string") env[key] = value;
    }
  }
  if (opts.nativeClaudeProfileId !== undefined) {
    const selectedEnv = buildClaudeCliProfileEnvironment(
      env,
      opts.nativeClaudeConfigDirEnv ?? null,
    );
    for (const key of Object.keys(env)) delete env[key];
    for (const [key, value] of Object.entries(selectedEnv)) {
      if (typeof value === "string") env[key] = value;
    }
  }
  // Plain-shell Active accounts (set by spawn(); mutually exclusive with the
  // frozen-profile fields above). Same builders, applied late on the enriched
  // env, so the child sees exactly one selected home per CLI with that CLI's
  // credential-override routes stripped while Studio's own variables survive.
  if (opts.nativeGrokHome) {
    const selectedEnv = buildGrokCliProfileEnvironment(env, opts.nativeGrokHome);
    for (const key of Object.keys(env)) delete env[key];
    for (const [key, value] of Object.entries(selectedEnv)) {
      if (typeof value === "string") env[key] = value;
    }
  }
  if (opts.plainShellClaudeConfigDir) {
    const selectedEnv = buildClaudeCliProfileEnvironment(
      env,
      opts.plainShellClaudeConfigDir,
    );
    for (const key of Object.keys(env)) delete env[key];
    for (const [key, value] of Object.entries(selectedEnv)) {
      if (typeof value === "string") env[key] = value;
    }
  }
  if (opts.plainShellGrokHome) {
    const selectedEnv = buildGrokCliProfileEnvironment(env, opts.plainShellGrokHome);
    for (const key of Object.keys(env)) delete env[key];
    for (const [key, value] of Object.entries(selectedEnv)) {
      if (typeof value === "string") env[key] = value;
    }
  }
  if (opts.plainShellFollowsActiveAccount || opts.agentShellFollowsActiveAccount) {
    env.SPARK_FOLLOW_ACTIVE_ACCOUNT = "1";
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
    // Ship node-pty's own conpty.dll instead of whatever the host Windows
    // build carries, so ConPTY behaviour and throughput do not vary by OS
    // build (older builds are markedly slower and buggier under floods).
    useConptyDll: process.platform === "win32" ? true : undefined,
  } as nodePty.IPtyForkOptions);

  // If a renderer's xterm was bound to this sessionId on a just-killed PTY
  // (mode-flip respawn), re-adopt that webContents so the UI follows the new
  // process. A headless cli-session passes webContents:null; the renderer
  // never re-spawns on its own. Without this adoption the xterm tab keeps
  // listening on `pty:data:<sessionId>` but the new pty has no sink.
  const stranded = opts.webContents ? null : consumeStrandedBinding(opts.id);
  const createdAt = Date.now();
  const session: Session = {
    id: opts.id,
    generationId: createSessionGeneration(opts.id),
    createdAt,
    lastInputAt: createdAt,
    lastOutputAt: createdAt,
    lastAttachAt: createdAt,
    cwd,
    pty,
    webContents: opts.webContents ?? stranded?.webContents ?? null,
    dataChannel: `pty:data:${opts.id}`,
    replayChannel: `pty:replay:${opts.id}`,
    exitChannel: `pty:exit:${opts.id}`,
    pendingChunks: [],
    pendingBytes: 0,
    flushTimer: null,
    flowHolds: new Set<FlowHoldReason>(),
    renderUnackedBytes: 0,
    renderAckSeen: false,
    renderHoldWatchdog: null,
    renderUnackedAtHold: 0,
    resizedAt: 0,
    cols,
    rows,
    exited: false,
    tail: [],
    tailBytes: 0,
    tailHead: 0,
    attached: true,
    detachedBacklog: [],
    detachedBacklogBytes: 0,
    disposed: false,
    exitEmitted: false,
    sanctioned: false,
    nativeCodexProfileId: opts.nativeCodexProfileId,
    releaseNativeCodexProfileLease: opts.releaseNativeCodexProfileLease,
    nativeClaudeProfileId: opts.nativeClaudeProfileId,
    releaseNativeClaudeProfileLease: opts.releaseNativeClaudeProfileLease,
    nativeGrokProfileId: opts.nativeGrokProfileId,
    releaseNativeGrokProfileLease: opts.releaseNativeGrokProfileLease,
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
    if (s.exitEmitted) {
      // sweepDeadSessions already synthesized this session's exit on wake (the
      // OS severed the ConPTY during sleep and node-pty fired onExit only now).
      // Don't emit a second exit — the renderer already reacted — just finish
      // the map/waiter teardown idempotently.
      if (current === session) sessions.delete(opts.id);
      const t0 = pendingKills.get(opts.id);
      if (t0) {
        clearTimeout(t0);
        pendingKills.delete(opts.id);
      }
      exitWaiters.delete(opts.id);
      releaseNativeProfileSessionLeases(s);
      return;
    }
    if (s) {
      s.exitEmitted = true;
      s.exited = true;
      flushDataNow(s);
      if (s.webContents && !s.webContents.isDestroyed()) {
        s.webContents.send(s.exitChannel, { exitCode, signal, sanctioned: s.sanctioned });
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
    releaseNativeProfileSessionLeases(s);
    const t = pendingKills.get(opts.id);
    if (t) {
      clearTimeout(t);
      pendingKills.delete(opts.id);
    }
    const waiters = exitWaiters.get(opts.id) ?? [];
    exitWaiters.delete(opts.id);
    for (const w of waiters) {
      try {
        w({ exitCode, signal, sanctioned: s.sanctioned });
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

  return {
    id: opts.id,
    pid: pty.pid,
    startupCommandHandled,
    nativeCodexProfileId: session.nativeCodexProfileId,
    nativeClaudeProfileId: session.nativeClaudeProfileId,
    nativeGrokProfileId: session.nativeGrokProfileId,
  };
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
  s.lastOutputAt = Date.now();
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
  // of slop above the cap until the next write trims it again. Trimming
  // advances tailHead (nulling the slot so the Buffer is released) instead of
  // shift()ing, which would re-index every one of the ~95k live entries; the
  // consumed prefix is compacted away in one slice once it grows large.
  s.tail.push(chunk);
  s.tailBytes += chunk.length;
  while (tailLiveCount(s) > 1) {
    const head = s.tail[s.tailHead];
    const headLen = head ? head.length : 0;
    if (s.tailBytes - headLen <= TAIL_BUFFER_BYTES) break;
    s.tail[s.tailHead] = null;
    s.tailHead += 1;
    s.tailBytes -= headLen;
  }
  if (s.tailHead > TAIL_COMPACT_HEAD) {
    s.tail = s.tail.slice(s.tailHead);
    s.tailHead = 0;
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
  resetRenderFlow(s);
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

// Power events are main-process-owned, while xterm is renderer-owned. Before
// macOS/Windows locks or suspends, stop delivering PTY bytes to Chromium and
// retain them in the bounded detached backlog. On wake the renderer first
// repairs/refits its xterm surface, then calls resume(id) to acknowledge that
// it is ready for the backlog. This avoids racing the first post-wake bytes
// against a sleeping, GPU-reset, or briefly unresponsive renderer.
export function pauseAllForHostSuspend(): number {
  let paused = 0;
  for (const [id, s] of sessions) {
    if (!s.webContents || s.webContents.isDestroyed() || !s.attached) continue;
    pause(id);
    paused += 1;
  }
  return paused;
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
    announceReplay(s, merged.byteLength);
    s.webContents.send(
      s.dataChannel,
      new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength),
    );
    noteRenderBytesSent(s, merged.byteLength);
  }
  s.detachedBacklog = [];
  s.detachedBacklogBytes = 0;
  s.attached = true;
  s.lastAttachAt = Date.now();
}

// Called by the renderer's raw-tail-reattach panes (the ChatPanel backend
// terminal) when their TerminalPane unmounts, INSTEAD of pause(). Unlike
// pause() — which keeps webContents bound and stashes bytes into a replayable
// backlog — detach makes the session look exactly like a never-yet-attached
// one: webContents is nulled and ALL pause/backlog + pending state is
// discarded. The next spawn() at this id then hits the `previouslyDetached`
// branch and replays the RAW tail bytes into the fresh xterm, reproducing a
// live Ink TUI's frame exactly like the known-good first attach (a flattened
// xterm-text snapshot replayed under an incrementally-redrawing TUI garbles it).
//
// Why it's safe to throw the backlog away: enqueueData pushes EVERY chunk into
// s.tail unconditionally (see line ~711, before the attached check), so the
// tail is a strict superset of anything the backlog held. Clearing the backlog
// here — and leaving attached=true so bytes that arrive while detached take the
// normal (webContents===null → dropped at flush) path instead of re-growing a
// backlog — guarantees a later attach can't double-deliver bytes the raw-tail
// replay is already going to send. Incoming bytes keep accumulating in the tail
// while detached, since onData routes through enqueueData regardless of
// webContents (it tolerated webContents===null before the first attach too).
// Safe no-op for unknown ids.
// Stop reading from the pty at the OS level, so a child that floods stdout
// blocks on its own write buffer instead of growing ours. Unlike pause()
// above (which keeps the child running and buffers for the renderer), this
// applies real backpressure to the process.
//
// Added for remote sessions, whose consumer is a network socket that can be
// far slower than a local pty. Returns whether flow control was available:
// the ssh2 remote adapter has no equivalent, so callers must treat a false
// return as "no backpressure possible here" rather than assuming success.
//
// Holds are keyed by reason so the remote socket and the local renderer can
// each pause and resume independently; the pty resumes when the last hold
// goes. The default reason keeps the remote-access call sites unchanged.
export function pauseFlow(id: string, reason: FlowHoldReason = "remote"): boolean {
  const s = sessions.get(id);
  if (!s?.pty.pause) return false;
  holdFlow(s, reason);
  return true;
}

export function resumeFlow(id: string, reason: FlowHoldReason = "remote"): boolean {
  const s = sessions.get(id);
  if (!s?.pty.resume) return false;
  releaseFlow(s, reason);
  return true;
}

function holdFlow(s: Session, reason: FlowHoldReason): void {
  if (s.flowHolds.has(reason)) return;
  const wasPaused = s.flowHolds.size > 0;
  s.flowHolds.add(reason);
  if (wasPaused || !s.pty.pause) return;
  try {
    s.pty.pause();
  } catch {
    s.flowHolds.delete(reason);
  }
}

function releaseFlow(s: Session, reason: FlowHoldReason): void {
  if (!s.flowHolds.delete(reason)) return;
  if (s.flowHolds.size > 0 || !s.pty.resume) return;
  try {
    s.pty.resume();
  } catch {
    /* the handle is gone; nothing left to resume */
  }
}

// Renderer backpressure. Every byte shipped on dataChannel is counted once
// the renderer has proven it acks (first pty:ack); xterm's write callback
// acks bytes as they are parsed. Past the high mark the pty is held under
// reason "render" until the backlog drains to the low mark.
function noteRenderBytesSent(s: Session, bytes: number): void {
  if (!s.renderAckSeen || bytes <= 0) return;
  s.renderUnackedBytes += bytes;
  if (s.renderUnackedBytes < RENDER_HIGH_WATER_BYTES || s.flowHolds.has("render")) return;
  if (!s.pty.pause) return;
  holdFlow(s, "render");
  armRenderHoldWatchdog(s);
}

export function ackRenderBytes(id: string, bytes: number): void {
  const s = sessions.get(id);
  if (!s || !Number.isFinite(bytes) || bytes <= 0) return;
  s.renderAckSeen = true;
  s.renderUnackedBytes = Math.max(0, s.renderUnackedBytes - bytes);
  if (s.flowHolds.has("render") && s.renderUnackedBytes <= RENDER_LOW_WATER_BYTES) {
    clearRenderHoldWatchdog(s);
    releaseFlow(s, "render");
  }
}

// A held pty that sees no ack progress within the window is released and its
// accounting disabled until the renderer acks again: a stuck, reloading or
// disposed xterm must never leave the child frozen.
function armRenderHoldWatchdog(s: Session): void {
  clearRenderHoldWatchdog(s);
  s.renderUnackedAtHold = s.renderUnackedBytes;
  s.renderHoldWatchdog = setTimeout(() => {
    s.renderHoldWatchdog = null;
    if (!s.flowHolds.has("render")) return;
    if (s.renderUnackedBytes < s.renderUnackedAtHold) {
      armRenderHoldWatchdog(s);
      return;
    }
    logMain("pty", `render backpressure watchdog released ${s.id}: no ack progress in ${RENDER_HOLD_WATCHDOG_MS}ms`);
    s.renderAckSeen = false;
    s.renderUnackedBytes = 0;
    releaseFlow(s, "render");
  }, RENDER_HOLD_WATCHDOG_MS);
}

function clearRenderHoldWatchdog(s: Session): void {
  if (!s.renderHoldWatchdog) return;
  clearTimeout(s.renderHoldWatchdog);
  s.renderHoldWatchdog = null;
}

// Drop all renderer accounting and any render hold. Called wherever the
// renderer stops being a live consumer: detach, pause (workspace switch),
// a destroyed webContents, and teardown.
function resetRenderFlow(s: Session): void {
  clearRenderHoldWatchdog(s);
  s.renderUnackedBytes = 0;
  s.renderAckSeen = false;
  releaseFlow(s, "render");
}

/** Test and diagnostics view of the flow-control state for one session. */
export function flowState(id: string): { holds: FlowHoldReason[]; unackedBytes: number } | null {
  const s = sessions.get(id);
  if (!s) return null;
  return { holds: [...s.flowHolds], unackedBytes: s.renderUnackedBytes };
}

export function detach(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  resetRenderFlow(s);
  s.webContents = null;
  s.attached = true;
  s.detachedBacklog = [];
  s.detachedBacklogBytes = 0;
  s.pendingChunks = [];
  s.pendingBytes = 0;
  if (s.flushTimer) {
    clearTimeout(s.flushTimer);
    s.flushTimer = null;
  }
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
    resetRenderFlow(s);
    return;
  }
  const merged = s.pendingChunks.length === 1 ? s.pendingChunks[0] : Buffer.concat(s.pendingChunks, s.pendingBytes);
  s.pendingChunks = [];
  s.pendingBytes = 0;
  // Ship as Uint8Array so the renderer can hand it directly to xterm.js
  // without going through a string round-trip.
  s.webContents.send(s.dataChannel, new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength));
  noteRenderBytesSent(s, merged.byteLength);
}

/** True iff a PTY with this id is currently registered. Used by the
 *  renderer-side backend-terminal tab to decide whether to mount its
 *  xterm — mounting too early triggers a spawn attempt for the placeholder
 *  shell, which fails with ENOENT and surfaces as "File not found". */
export function exists(id: string): boolean {
  return sessions.has(id);
}

export function resourceSnapshot(): PtyResourceSnapshot {
  const sampledAt = Date.now();
  const diagnostics: PtySessionResourceDiagnostic[] = [...sessions.values()]
    .map((session) => {
      const hasRenderer = Boolean(
        session.webContents && !session.webContents.isDestroyed(),
      );
      return {
        id: session.id,
        generationId: session.generationId,
        pid: session.pty.pid,
        cwd: session.cwd,
        createdAt: session.createdAt,
        lastInputAt: session.lastInputAt,
        lastOutputAt: session.lastOutputAt,
        lastAttachAt: session.lastAttachAt,
        attached: session.attached,
        hasRenderer,
        remote: session.pty.pid === 0 || isRemotePath(session.cwd),
        tailBytes: session.tailBytes,
        detachedBacklogBytes: session.detachedBacklogBytes,
        pendingBytes: session.pendingBytes,
      };
    })
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
  const attached = diagnostics.filter(
    (session) => session.hasRenderer && session.attached,
  ).length;
  return {
    sampledAt,
    sessions: diagnostics,
    totals: {
      live: diagnostics.length,
      attached,
      detached: diagnostics.length - attached,
      remote: diagnostics.filter((session) => session.remote).length,
      tailBytes: diagnostics.reduce(
        (total, session) => total + session.tailBytes,
        0,
      ),
      detachedBacklogBytes: diagnostics.reduce(
        (total, session) => total + session.detachedBacklogBytes,
        0,
      ),
      pendingBytes: diagnostics.reduce(
        (total, session) => total + session.pendingBytes,
        0,
      ),
    },
  };
}

/**
 * Exact-generation teardown seam for future proved-orphan reconciliation.
 * Observation alone never calls this: the caller must already hold positive
 * lifecycle proof that this exact session generation is disposable.
 */
export function killIfGeneration(
  id: string,
  generationId: string,
): boolean {
  const session = sessions.get(id);
  if (!session || session.generationId !== generationId) return false;
  markSanctioned(id);
  killNow(id);
  return true;
}

export function nativeCodexProfileId(id: string): string | undefined {
  return sessions.get(id)?.nativeCodexProfileId;
}

export function nativeClaudeProfileId(id: string): string | undefined {
  return sessions.get(id)?.nativeClaudeProfileId;
}

export function nativeGrokProfileId(id: string): string | undefined {
  return sessions.get(id)?.nativeGrokProfileId;
}

export function write(id: string, data: string): void {
  const s = sessions.get(id);
  if (!s) return;
  s.lastInputAt = Date.now();
  s.pty.write(data);
}

/**
 * Paint process-owned status/output into an attached terminal without sending
 * it to the shell as keyboard input. Cora's Pi workers run over structured RPC
 * in main but retain the familiar live Workers terminal; this bridge lets that
 * terminal display their human-readable activity while the idle shell remains
 * only the renderer-owned PTY host.
 */
export function publishOutput(id: string, data: string | Buffer): void {
  enqueueData(id, data);
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
//
// stashDraft: Claude Code binds Ctrl+S (0x13) to `chat:stash`, which parks a
// non-empty prompt aside and clears the input; once the next slash command has
// run Claude Code pops it back on its own ("Draft restored"). Sending that
// keystroke first means a chord that types `/model` or `/effort` at a pane no
// longer glues the command onto whatever the user was mid-way through writing
// and submits the lot as a message. Only callers targeting Claude Code should
// set it — a plain shell reads 0x13 as XOFF and freezes its output.
export function inject(
  id: string,
  text: string,
  opts?: { submit?: boolean; stashDraft?: boolean },
): void {
  if (!sessions.has(id)) return;
  if (opts?.stashDraft) write(id, "\x13");
  // ConPTY corrupts NULs, so strip them. Also strip any bracketed-paste
  // start/end markers (CSI 200~ / CSI 201~) the payload itself contains: this
  // helper OWNS the paste wrap, so a marker inside `text` can only break out of
  // it — a stray CSI 201~ would end the paste early and make the following bytes
  // (a CR, raw CSI) execute as live keystrokes, defeating submit:false and
  // letting injected content force-submit. Neutering them keeps the wrap intact
  // so the single trailing CR below is the only way to submit.
  const sanitized = text.replace(/\x00/g, "").replace(/\x1b\[20[01]~/g, "");
  write(id, `\x1b[200~${sanitized}\x1b[201~`);
  const submit = opts?.submit ?? true;
  if (submit) write(id, "\r");
}

export function resize(id: string, cols: number, rows: number): void {
  const s = sessions.get(id);
  if (!s) return;
  try {
    s.pty.resize(Math.max(1, cols | 0), Math.max(1, rows | 0));
    s.cols = Math.max(1, cols | 0);
    s.rows = Math.max(1, rows | 0);
    s.resizedAt = Date.now();
  } catch {
    /* pty may have exited */
  }
}

// The pty's process id, for callers that reason about the process tree
// below a pane (the terminal-agent notifier's background-task hold). Remote
// panes carry pid 0 and report null.
export function sessionPid(id: string): number | null {
  const pid = sessions.get(id)?.pty.pid;
  return typeof pid === "number" && pid > 0 ? pid : null;
}

export function sessionDimensions(id: string): { cols: number; rows: number } | null {
  const session = sessions.get(id);
  return session ? { cols: session.cols, rows: session.rows } : null;
}

export function hasSession(id: string): boolean {
  return sessions.has(id);
}

// Wait for a renderer-spawned session to come online. Used by orchestration
// after it emits the "worker_attempt.launch_requested" event — the renderer
// adds the pane, TerminalView mounts, calls pty:spawn, and main can then start
// typing into the (now-warm) pwsh shell. Resolves false on timeout.
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
  if (cap === 0 || tailLiveCount(s) === 0) return Buffer.alloc(0);
  // Walk the ring backwards, collecting only the chunks needed to satisfy the
  // cap, then concat that suffix. Concatenating the ENTIRE 4 MB ring to return
  // its last 32-256 KB blocked the main thread for whole milliseconds.
  const parts: Buffer[] = [];
  let total = 0;
  for (let index = s.tail.length - 1; index >= s.tailHead && total < cap; index -= 1) {
    const chunk = s.tail[index];
    if (!chunk) continue;
    if (total + chunk.length <= cap) {
      parts.push(chunk);
      total += chunk.length;
      continue;
    }
    parts.push(chunk.subarray(chunk.length - (cap - total)));
    total = cap;
  }
  if (parts.length === 1) return parts[0];
  parts.reverse();
  return Buffer.concat(parts, total);
}

// Snapshot recent raw output while preserving the PTY's original chunk
// boundaries. The terminal-agent monitor uses this when it attaches after a
// restored pane has already started producing output: replaying the chunks in
// order rebuilds the same runtime state it would have observed live. Returning
// a copied array (rather than the Session's mutable ring) also makes it safe for
// the caller to iterate while future onData callbacks append new chunks.
export function readTailChunks(id: string, maxBytes: number): Buffer[] | null {
  const s = sessions.get(id);
  if (!s) return null;
  const cap = Math.max(0, Math.min(maxBytes | 0, TAIL_BUFFER_BYTES));
  if (cap === 0 || tailLiveCount(s) === 0) return [];

  // Collected newest-first (push is O(1); unshift here was O(n²) across the
  // thousands of small chunks a 256 KB request spans), then reversed once so
  // the caller still receives oldest-first replay order.
  const out: Buffer[] = [];
  let remaining = cap;
  for (let index = s.tail.length - 1; index >= s.tailHead && remaining > 0; index -= 1) {
    const chunk = s.tail[index];
    if (!chunk) continue;
    if (chunk.length <= remaining) {
      out.push(chunk);
      remaining -= chunk.length;
      continue;
    }
    out.push(chunk.subarray(chunk.length - remaining));
    remaining = 0;
  }
  out.reverse();
  return out;
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
  handler: (info: PtyExitInfo) => void,
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

// Flag a session's coming death as one Codara asked for, so its exit is not
// read as a crash. Callers that tear a pane down on behalf of orchestration or
// app quit set this; a pty that dies on its own never does.
function markSanctioned(id: string): void {
  const s = sessions.get(id);
  if (s) s.sanctioned = true;
}

// `sanctioned` marks a Codara-initiated teardown (see PtyExitInfo). Renderer
// pane closes leave it unset: closing a worker's pane kills a worker Cora did
// not stop, which is exactly the unsanctioned death the chip must name.
export function dispose(id: string, opts?: { sanctioned?: boolean }): void {
  if (!sessions.has(id) || pendingKills.has(id)) return;
  if (opts?.sanctioned) markSanctioned(id);
  const timer = setTimeout(() => {
    pendingKills.delete(id);
    killNow(id);
  }, GRACE_MS);
  pendingKills.set(id, timer);
}

// Hard, immediate kill — no GRACE_MS wait. Used by force-pause / delete-run
// flows where lingering ConPTY descendants would hold file handles open
// and cause Windows to refuse the directory delete with an "in use" prompt.
// Every caller is orchestration or a session owner ending a pane deliberately,
// so the exit is sanctioned: Cora disposing a finished worker's idle host shell
// must never repaint that worker as crashed.
export function killImmediate(id: string): void {
  markSanctioned(id);
  killNow(id);
}

export function disposeForWebContents(wc: WebContents): void {
  for (const [id, s] of sessions) {
    if (s.webContents === wc) {
      markSanctioned(id);
      killNow(id);
    }
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
      // Reaping the shells that hold a deleted worktree open is Codara's own
      // teardown, not a process dying on its own.
      markSanctioned(id);
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
    // Match detach(): the next renderer attach replays the raw tail as its
    // single source of truth. Clearing a sleep-era pause/backlog here prevents
    // duplicate replay and, critically, prevents `attached=false` from
    // stranding all future output after a renderer crash/reload.
    s.attached = true;
    s.detachedBacklog = [];
    s.detachedBacklogBytes = 0;
    s.pendingChunks = [];
    s.pendingBytes = 0;
    if (s.flushTimer) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
    }
  }
}

// Wake-from-sleep recovery: the OS can sever a ConPTY across a suspend/resume
// cycle without node-pty ever firing onExit, leaving a Session whose child
// process is already dead but still registered — so the renderer never learns
// its terminal died and (for an agent pane) never auto-resumes. Called on the
// powerMonitor 'resume' event: for every LOCAL session whose pid is no longer
// alive, synthesize the exit the renderer never got, mirroring the tail of the
// real onExit handler. Idempotent with a late real onExit via Session.exitEmitted.
// Returns the ids that were swept. Remote sessions (pid 0, ssh channel) are
// skipped — their liveness isn't a local pid and their exit flows through the
// ssh adapter's own onExit.
export function sweepDeadSessions(): string[] {
  const swept: string[] = [];
  // Snapshot keys — the loop mutates the map.
  for (const id of [...sessions.keys()]) {
    const s = sessions.get(id);
    if (!s) continue;
    if (s.exited || s.exitEmitted || s.disposed) continue;
    const pid = s.pty.pid;
    if (typeof pid !== "number" || pid <= 0) continue;
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) continue;
    // Dead pid, no exit emitted → synthesize one so TerminalPane reacts.
    s.exitEmitted = true;
    s.exited = true;
    flushDataNow(s);
    if (s.webContents && !s.webContents.isDestroyed()) {
      try {
        // exitCode -1 marks a non-clean death (kill/sever), which the renderer's
        // crash-vs-clean chip logic treats as an error — appropriate here.
        s.webContents.send(s.exitChannel, { exitCode: -1 });
      } catch {
        /* webContents destroyed mid-send; harmless */
      }
    }
    if (!strandedBindings.has(id)) stashWebContents(id, s);
    if (s.flushTimer) clearTimeout(s.flushTimer);
    releaseNativeProfileSessionLeases(s);
    sessions.delete(id);
    const waiters = exitWaiters.get(id) ?? [];
    exitWaiters.delete(id);
    for (const w of waiters) {
      try {
        w({ exitCode: -1 });
      } catch {
        /* ignore */
      }
    }
    swept.push(id);
  }
  return swept;
}

export function disposeAll(): void {
  for (const t of pendingKills.values()) clearTimeout(t);
  pendingKills.clear();
  for (const id of [...sessions.keys()]) {
    // Process-wide teardown: every one of these deaths is ours, so none of
    // them may brand an agent crashed.
    markSanctioned(id);
    killNow(id);
  }
}

// Quit-path variant of disposeAll. killNow() taskkill /T /F's the process
// tree the instant it runs, which can cut a Claude/Codex CLI mid-write and
// leave a transcript .jsonl that `claude --resume` refuses on the next
// launch — the root cause of restored panes erroring into fresh sessions.
// Here every session first loses its pseudo-console (pty.kill() → Windows
// delivers CTRL_CLOSE_EVENT to the attached tree, giving the CLIs their
// normal exit path to flush), and only after a bounded grace do the shells
// still alive get the taskkill sledgehammer. The grace polls actual pid
// liveness, so an all-processes-exited quit proceeds in one poll tick; the
// worst case stays well inside index.ts's 5s before-quit hard-exit budget.
type NativeCliSessionRuntime = "claude" | "codex" | "grok";

export interface NativeCliRuntimeDisposeResult {
  closedSessionCount: number;
}

function sessionUsesNativeCliRuntime(
  session: Session,
  runtime: NativeCliSessionRuntime,
): boolean {
  if (runtime === "claude") return session.nativeClaudeProfileId !== undefined;
  if (runtime === "grok") return session.nativeGrokProfileId !== undefined;
  return session.nativeCodexProfileId !== undefined;
}

/**
 * Gracefully closes an exact subset of Codara-owned PTYs. Account switching
 * uses the runtime-filtered variant below; app quit uses the all-session
 * variant. Keeping both on this one teardown path ensures a switch gives the
 * CLI the same transcript-flush grace as a clean Studio quit.
 */
async function disposeSessionsGraceful(
  ids: readonly string[],
  maxWaitMs: number,
): Promise<void> {
  for (const id of ids) {
    const timer = pendingKills.get(id);
    if (!timer) continue;
    clearTimeout(timer);
    pendingKills.delete(id);
  }
  const pids: number[] = [];
  const posixTrees: PosixPtyTreeTarget[] = [];
  for (const id of ids) {
    const s = sessions.get(id);
    if (!s) continue;
    // Same teardown bookkeeping as killNow, minus the immediate taskkill.
    s.disposed = true;
    // A deliberate account switch or app quit is sanctioned teardown: the
    // exit events can reach a still-alive renderer and must not repaint these
    // panes as crashed while they are being closed on purpose.
    s.sanctioned = true;
    stashWebContents(id, s);
    const pid = s.pty.pid;
    if (typeof pid === "number" && pid > 0) pids.push(pid);
    const posixTree = capturePosixPtyTree(s.pty);
    if (posixTree) posixTrees.push(posixTree);
    try {
      flushDataNow(s);
      s.pty.kill();
    } catch {
      /* ignore */
    }
    if (s.flushTimer) clearTimeout(s.flushTimer);
    s.tail = [];
    s.tailBytes = 0;
    s.tailHead = 0;
    s.detachedBacklog = [];
    s.detachedBacklogBytes = 0;
    releaseNativeProfileSessionLeases(s);
    sessions.delete(id);
  }
  if (process.platform !== "win32") {
    // Match an actual terminal hangup for every process that belonged to the
    // exact forkpty tree at capture time. Interactive shells place jobs in
    // separate process groups, so signaling only `-shellPid` misses them.
    for (const tree of posixTrees) signalPosixPtyTree(tree, "SIGHUP");
    const deadline = Date.now() + Math.max(0, maxWaitMs);
    while (
      Date.now() < deadline &&
      posixTrees.some((tree) => isPosixPtyTreeAlive(tree))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const tree of posixTrees) signalPosixPtyTree(tree, "SIGKILL");
    return;
  }
  if (pids.length === 0) return;

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + Math.max(0, maxWaitMs);
  while (Date.now() < deadline && pids.some(alive)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Unconditional reap attempt: for shells that exited cleanly this no-ops
  // (pid gone), for stragglers it walks and kills the descendant tree —
  // preserving killNow's "closing a pane kills its dev server" guarantee.
  for (const pid of pids) {
    if (!alive(pid)) continue;
    try {
      const child = spawnChild("taskkill", ["/T", "/F", "/PID", String(pid)], {
        windowsHide: true,
        stdio: "ignore",
        detached: false,
      });
      child.on("error", () => undefined);
      child.unref();
    } catch {
      /* ignore */
    }
  }
}

/** Lease owner ids of every live Studio PTY, for sweeping stale account leases. */
/**
 * Every session that holds, or is about to hold, a native account lease: the
 * table plus the spawns still between lease acquisition and `sessions.set`.
 * A lease sweep that only trusted the table would release a launching
 * terminal's lease and let an account delete remove the directory it is
 * starting in.
 */
export function liveSessionOwnerIds(): Set<string> {
  return new Set(
    [...sessions.keys(), ...pendingSpawns].map((id) => `terminal:${id}`),
  );
}

/**
 * Close only the Studio PTYs running on one Claude Code account, when the
 * user confirmed that deleting the account may close them.
 */
export async function disposeNativeClaudeProfileSessions(
  profileId: string,
  maxWaitMs = 1500,
): Promise<NativeCliRuntimeDisposeResult> {
  const ids = [...sessions.entries()]
    .filter(([, session]) => session.nativeClaudeProfileId === profileId)
    .map(([id]) => id);
  await disposeSessionsGraceful(ids, maxWaitMs);
  return { closedSessionCount: ids.length };
}

/**
 * Close only the Studio PTYs running on one Grok account, when the user
 * confirmed that deleting the account may close them.
 */
export async function disposeNativeGrokProfileSessions(
  profileId: string,
  maxWaitMs = 1500,
): Promise<NativeCliRuntimeDisposeResult> {
  const ids = [...sessions.entries()]
    .filter(([, session]) => session.nativeGrokProfileId === profileId)
    .map(([id]) => id);
  await disposeSessionsGraceful(ids, maxWaitMs);
  return { closedSessionCount: ids.length };
}

/**
 * Close every Studio PTY pinned to one native CLI runtime before its account
 * selection changes. Other shells and other agent families remain running.
 */
export async function disposeNativeCliRuntimeGraceful(
  runtime: NativeCliSessionRuntime,
  maxWaitMs = 1500,
): Promise<NativeCliRuntimeDisposeResult> {
  const ids = [...sessions.entries()]
    .filter(([, session]) => sessionUsesNativeCliRuntime(session, runtime))
    .map(([id]) => id);
  await disposeSessionsGraceful(ids, maxWaitMs);
  return { closedSessionCount: ids.length };
}

export async function disposeAllGraceful(maxWaitMs = 1500): Promise<void> {
  // Preserve disposeAllGraceful's process-wide timer cleanup even if a stale
  // delayed-kill entry has outlived the session it originally belonged to.
  for (const timer of pendingKills.values()) clearTimeout(timer);
  pendingKills.clear();
  await disposeSessionsGraceful([...sessions.keys()], maxWaitMs);
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
  // can re-bind it; otherwise the xterm tab in
  // the UI silently goes deaf to the new process.
  stashWebContents(id, s);
  // Capture the exact slave tty and its root-descendant identities while the
  // forkpty root is still alive. After pty.kill() the shell can exit and
  // reparent surviving jobs, at which point ownership can no longer be proven.
  const posixTree = capturePosixPtyTree(s.pty);
  clearRenderHoldWatchdog(s);
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
  } else {
    beginPosixPtyTreeTeardown(posixTree);
  }
  if (s.flushTimer) clearTimeout(s.flushTimer);
  s.tail = [];
  s.tailBytes = 0;
  s.tailHead = 0;
  s.detachedBacklog = [];
  s.detachedBacklogBytes = 0;
  releaseNativeProfileSessionLeases(s);
  sessions.delete(id);
}
