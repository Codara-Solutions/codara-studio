// Headless CLI session wrapper.
//
// Both Talk-mode backends (Claude Code, Codex) need to spawn the CLI binary
// under a PTY without a renderer pane, find the per-session JSONL transcript
// the CLI writes to disk, and tail it for chat output. The lifecycle is the
// same across backends — only (a) which binary to spawn, (b) which args, and
// (c) where to find the JSONL differ. That's what this module abstracts.
//
// The actual translation of JSONL entries into ChatStreamEvents lives in each
// backend, because the schemas differ (CC: `type` enum with assistant/user/
// tool_use entries; Codex: `type` envelope wrapping `session_meta`/`turn_context`
// /`event_msg`/`response_item`). cli-session is intentionally schema-agnostic.

import { extname } from "node:path";

import type { ShellInfo } from "@shared/types";
import * as pty from "../pty-manager";
import { tailJsonl, type Disposable } from "./jsonl-tail";

// DECSET 2004 — the CLI asking the terminal to enable bracketed-paste mode.
// Ink (claude) and ratatui (codex) both emit this when their interactive
// input widget mounts, which is the earliest reliable "the REPL can accept
// pasted input" signal. See CliSession.waitForInputReady.
const INPUT_READY_SEQUENCE = "\x1b[?2004h";

// node-pty spawns via CreateProcess on Windows, which can only launch real PE
// images (`.exe`/`.com`). npm-installed CLIs like `codex` ship as a `.cmd`
// batch shim (and a bare `sh` shim) with no `.exe`, so handing the resolved
// path straight to node-pty fails with "Cannot create process, error code:
// 193" (ERROR_BAD_EXE_FORMAT) — which is exactly why Codex-as-engine never
// launched on Windows while Claude (a native `claude.exe`) did. Route batch
// shims through cmd.exe and PowerShell shims through pwsh, the same way an
// interactive shell would — and the same way the worker launch path already
// gets for free by running the CLI inside pwsh. A real `.exe` is returned
// unchanged, so this is a no-op for the Claude path. POSIX is untouched.
export function resolveLaunchTarget(exe: string, args: string[]): { exe: string; args: string[] } {
  if (process.platform !== "win32") return { exe, args };
  const ext = extname(exe).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
    // /d skips any AutoRun command, /c runs-then-exits. node-pty quotes each
    // argv entry, so cmd.exe sees the shim path and every flag as its own
    // token. (We avoid /s, whose whole-string quote-stripping mangles a
    // space-containing shim path.)
    return { exe: comspec, args: ["/d", "/c", exe, ...args] };
  }
  if (ext === ".ps1") {
    const pwsh = process.platform === "win32" ? "pwsh.exe" : "pwsh";
    return {
      exe: pwsh,
      args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", exe, ...args],
    };
  }
  return { exe, args };
}

export interface CliSessionOptions {
  /** Pty session id. Caller picks (e.g. `spark-cc-talk-${runId}`). */
  sessionId: string;
  cwd: string;
  /** Resolved absolute path to the CLI binary. */
  exe: string;
  args: string[];
  /**
   * Env overrides layered on top of pty-manager's base env (which already
   * includes SPARK_AGENT_SOCKET/TOKEN/PANE_ID — orchestrator MCP needs no
   * extra env to find its way home).
   */
  env?: Record<string, string>;
  /**
   * Provider-specific function that locates the JSONL transcript file. Called
   * after spawn with no args; returns the resolved path or null if not yet
   * created. cli-session polls until it returns non-null or `jsonlReadyTimeoutMs`
   * elapses. Implementations:
   *   - CC:    scan `~/.claude/projects/<encoded-cwd>/` for the newest file
   *            whose mtime > spawnTime; pick its name as session UUID.
   *   - Codex: scan `~/.codex/sessions/YYYY/MM/DD/` for the newest
   *            `rollout-*.jsonl`.
   *
   * Ignored when `fixedJsonlPath` is provided.
   */
  discoverJsonlPath?: () => Promise<string | null>;
  /**
   * Pre-determined JSONL transcript path. When set, cli-session skips
   * discovery entirely and tails this path immediately (tailJsonl tolerates
   * the file not existing yet — it'll pick up entries when the CLI eventually
   * creates the file). Preferred for backends that can pre-determine the path
   * via a session-id flag (e.g. CC's `--session-id <uuid>`), avoiding the
   * chicken-and-egg of needing the CLI to create the JSONL before we can
   * send it any input that would cause it to write to the JSONL.
   */
  fixedJsonlPath?: string;
  /**
   * When true, the JSONL tailer seeks to end-of-file on first poll instead of
   * replaying every existing line. Use when resuming an existing session (CC
   * `-r <uuid>`, Codex `resume <uuid>`) — without this, prior turns'
   * assistant text is re-delivered as fresh `assistant_block` events and
   * pollutes the current turn's accumulator.
   */
  skipExistingJsonl?: boolean;
  /** Default 200ms. */
  discoverPollMs?: number;
  /** Default 10s. */
  jsonlReadyTimeoutMs?: number;
  /**
   * Terminal size for the synthetic PTY. Most TUI CLIs render fine at any
   * reasonable size; Claude/Codex both inspect COLUMNS/LINES on first render.
   */
  cols?: number;
  rows?: number;
}

export interface CliSession {
  /** Pty session id (same value as opts.sessionId). */
  id: string;
  pid: number;
  /** Path to the JSONL transcript once discovered; null until then. */
  jsonlPath(): string | null;
  /** Send raw bytes to the PTY stdin (e.g. ESC for interrupt, /clear, etc.). */
  writeRaw(text: string): void;
  /** Send ESC (interrupt the current turn). */
  interrupt(): void;
  /**
   * Subscribe to parsed JSONL entries. Returns an unsubscribe function. Each
   * handler runs to completion before the next entry — preserves source
   * order across async work.
   */
  onJsonlEntry(handler: (entry: unknown) => void | Promise<void>): () => void;
  /** Immediately consume transcript entries already written to disk. */
  flushJsonl(): Promise<void>;
  /** Subscribe to PTY raw stdout (for diagnostics; mostly unused). */
  onStdout(handler: (chunk: Buffer) => void): () => void;
  /** Subscribe to process exit. */
  onExit(handler: (info: { exitCode: number; signal?: number }) => void): () => void;
  /**
   * Resolves once the PTY has emitted any stdout — a coarse readiness signal
   * for backends that need to know "the CLI's TUI has rendered, it's safe to
   * write input". Rejects after timeoutMs with an Error. Idempotent: returns
   * an already-resolved promise if stdout has already arrived.
   */
  waitForFirstStdout(timeoutMs: number): Promise<void>;
  /**
   * Resolves once the CLI has enabled bracketed-paste mode (`ESC[?2004h`),
   * which both the claude and codex TUIs emit when their input box mounts —
   * a much stronger "safe to paste input" signal than first stdout (CC
   * 2.1.201 answers terminal probes ~0.4s after spawn but mounts the input
   * box seconds later; a paste into that gap is silently swallowed). Rejects
   * after timeoutMs so callers can fall back to best-effort pasting against
   * a CLI that never emits the sequence. Idempotent once seen.
   */
  waitForInputReady(timeoutMs: number): Promise<void>;
  /** Dispose pty + tail. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Spawn a CLI under a headless PTY and start tailing its JSONL transcript.
 * Resolves once the PTY is up; JSONL discovery races in the background and
 * its entries become observable via `onJsonlEntry` whenever it lands. If the
 * JSONL never appears within `jsonlReadyTimeoutMs`, listeners receive a
 * synthetic `__spark_cli_session_error` entry instead of hanging.
 */
export async function startCliSession(opts: CliSessionOptions): Promise<CliSession> {
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 40;
  const discoverPollMs = opts.discoverPollMs ?? 200;
  const jsonlReadyTimeoutMs = opts.jsonlReadyTimeoutMs ?? 10_000;

  // Synthetic ShellInfo — pty-manager spawns whatever we hand it as exe + args.
  // family: "other" skips PowerShell-specific spawn-lock + profile probing.
  // resolveLaunchTarget rewrites Windows `.cmd`/`.bat`/`.ps1` shims into a
  // cmd.exe/pwsh invocation so CreateProcess can actually launch them.
  const launch = resolveLaunchTarget(opts.exe, opts.args);
  const shell: ShellInfo = {
    id: `spark-cli-session-${opts.sessionId}`,
    label: "Codara CLI session",
    exe: launch.exe,
    args: launch.args,
    family: "other",
  };

  const spawnInfo = await pty.spawn({
    id: opts.sessionId,
    shell,
    cwd: opts.cwd,
    cols,
    rows,
    env: opts.env,
    webContents: null, // headless — main-process drives directly
  });

  let jsonlPath: string | null = null;
  let tail: Disposable | null = null;
  let disposed = false;
  // Distinct from `disposed`: an exited process may still have a tail attached
  // long enough to flush its final JSONL lines, but a process that exited
  // before discovery found any file must never keep polling and attach to an
  // unrelated CLI session later.
  let processExited = false;
  let firstStdoutSeen = false;
  interface ReadinessWaiter {
    ready: () => void;
    exited: () => void;
  }
  const firstStdoutWaiters = new Set<ReadinessWaiter>();
  let inputReadySeen = false;
  let inputReadyCarry = "";
  const inputReadyWaiters = new Set<ReadinessWaiter>();

  const entryHandlers = new Set<(entry: unknown) => void | Promise<void>>();
  const stdoutHandlers = new Set<(chunk: Buffer) => void>();
  const exitHandlers = new Set<(info: { exitCode: number; signal?: number }) => void>();

  // Serialize JSONL entry handler calls per the tailJsonl contract. We
  // fan out to N subscribers but await each subscriber's promise so a slow
  // listener can't reorder events relative to a fast one.
  async function dispatchEntry(entry: unknown): Promise<void> {
    for (const h of entryHandlers) {
      try {
        await h(entry);
      } catch {
        // swallow handler errors; we don't want one bad subscriber to break
        // the tail for the others. cli-session has no logger of its own.
      }
    }
  }

  const detachStdout = pty.tap(opts.sessionId, (chunk) => {
    if (!inputReadySeen) {
      // Watch the raw output stream for DECSET 2004 (`ESC [ ? 2004 h`) — the
      // CLI enabling bracketed-paste mode. Both the claude and codex TUIs
      // emit it when their input box mounts, which makes it the earliest
      // reliable "safe to paste" signal. First-stdout alone is NOT enough:
      // CC 2.1.201 answers terminal probes ~0.4s after spawn but mounts the
      // input box seconds later (what's-new panel, self-update check), and a
      // paste into that gap is silently swallowed. Carry the tail of the
      // previous chunk so a sequence split across chunk boundaries still
      // matches.
      const text = inputReadyCarry + chunk.toString("utf8");
      if (text.includes(INPUT_READY_SEQUENCE)) {
        inputReadySeen = true;
        for (const waiter of inputReadyWaiters) {
          try {
            waiter.ready();
          } catch {
            // swallow — never let a waiter's resolve callback break the tap
          }
        }
        inputReadyWaiters.clear();
      } else {
        inputReadyCarry = text.slice(-(INPUT_READY_SEQUENCE.length - 1));
      }
    }
    if (!firstStdoutSeen) {
      firstStdoutSeen = true;
      for (const waiter of firstStdoutWaiters) {
        try {
          waiter.ready();
        } catch {
          // swallow — never let a waiter's resolve callback break the tap
        }
      }
      firstStdoutWaiters.clear();
    }
    for (const h of stdoutHandlers) {
      try {
        h(chunk);
      } catch {
        // swallow
      }
    }
  });
  const detachExit = pty.onExit(opts.sessionId, (info) => {
    processExited = true;
    for (const waiter of firstStdoutWaiters) waiter.exited();
    firstStdoutWaiters.clear();
    for (const waiter of inputReadyWaiters) waiter.exited();
    inputReadyWaiters.clear();
    for (const h of exitHandlers) {
      try {
        h(info);
      } catch {
        // swallow
      }
    }
  });

  // JSONL acquisition. Two paths:
  //   - fixedJsonlPath: tail it immediately. tailJsonl tolerates the file not
  //     existing yet — it'll pick up entries when the CLI eventually creates
  //     the file. Preferred whenever the backend can pre-determine the path
  //     (e.g. CC's --session-id <uuid>), because it avoids a chicken-and-egg
  //     where we'd otherwise need the CLI to write the JSONL before we send
  //     any input that would cause it to write to the JSONL.
  //   - discoverJsonlPath: legacy poll-and-discover. Surfaces a synthetic
  //     error after jsonlReadyTimeoutMs so the backend can react instead of
  //     hanging forever.
  if (opts.fixedJsonlPath) {
    jsonlPath = opts.fixedJsonlPath;
    tail = tailJsonl(
      opts.fixedJsonlPath,
      (entry) => dispatchEntry(entry),
      undefined,
      { startFromEnd: opts.skipExistingJsonl ?? false },
    );
  } else if (opts.discoverJsonlPath) {
    const discover = opts.discoverJsonlPath;
    void (async () => {
      const startedAt = Date.now();
      while (!disposed && !processExited) {
        let found: string | null = null;
        try {
          found = await discover();
        } catch {
          found = null;
        }
        if (found) {
          if (disposed || processExited) return;
          jsonlPath = found;
          tail = tailJsonl(
            found,
            (entry) => dispatchEntry(entry),
            undefined,
            { startFromEnd: opts.skipExistingJsonl ?? false },
          );
          return;
        }
        if (Date.now() - startedAt > jsonlReadyTimeoutMs) {
          await dispatchEntry({
            __spark_cli_session_error: true,
            message: `CLI session JSONL not found within ${jsonlReadyTimeoutMs}ms`,
          });
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, discoverPollMs));
      }
    })();
  }

  return {
    id: opts.sessionId,
    pid: spawnInfo.pid,
    jsonlPath: () => jsonlPath,
    writeRaw: (text: string) => {
      if (disposed) return;
      pty.write(opts.sessionId, text);
    },
    interrupt: () => {
      if (disposed) return;
      pty.write(opts.sessionId, "\x1b");
    },
    onJsonlEntry: (handler) => {
      entryHandlers.add(handler);
      return () => entryHandlers.delete(handler);
    },
    flushJsonl: async () => {
      await tail?.flush();
    },
    onStdout: (handler) => {
      stdoutHandlers.add(handler);
      return () => stdoutHandlers.delete(handler);
    },
    onExit: (handler) => {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
    waitForFirstStdout: (timeoutMs: number) => {
      if (firstStdoutSeen) return Promise.resolve();
      if (processExited) return Promise.reject(new Error("CLI session exited before first stdout"));
      return new Promise<void>((resolve, reject) => {
        let waiter: ReadinessWaiter;
        const timer = setTimeout(() => {
          firstStdoutWaiters.delete(waiter);
          reject(new Error(`CLI session did not emit any stdout within ${timeoutMs}ms`));
        }, timeoutMs);
        waiter = {
          ready: () => {
            clearTimeout(timer);
            firstStdoutWaiters.delete(waiter);
            resolve();
          },
          exited: () => {
            clearTimeout(timer);
            firstStdoutWaiters.delete(waiter);
            reject(new Error("CLI session exited before first stdout"));
          },
        };
        firstStdoutWaiters.add(waiter);
      });
    },
    waitForInputReady: (timeoutMs: number) => {
      if (inputReadySeen) return Promise.resolve();
      if (processExited) {
        return Promise.reject(new Error("CLI session exited before input became ready"));
      }
      return new Promise<void>((resolve, reject) => {
        let waiter: ReadinessWaiter;
        const timer = setTimeout(() => {
          inputReadyWaiters.delete(waiter);
          reject(
            new Error(
              `CLI session did not enable bracketed paste within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
        waiter = {
          ready: () => {
            clearTimeout(timer);
            inputReadyWaiters.delete(waiter);
            resolve();
          },
          exited: () => {
            clearTimeout(timer);
            inputReadyWaiters.delete(waiter);
            reject(new Error("CLI session exited before input became ready"));
          },
        };
        inputReadyWaiters.add(waiter);
      });
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      tail?.dispose();
      detachStdout();
      // Register an exit waiter BEFORE the kill, then await it. The CLI's
      // file handles (notably CC's JSONL transcript) stay locked by the
      // dying process for tens of ms after killImmediate returns on Windows
      // (taskkill /T /F is async-spawned and node-pty.kill only signals).
      // If a respawn races into that window, the new CC's `-r <uuid>` opens
      // the still-locked JSONL and exits with code 1 ("No conversation
      // found"). Waiting for the actual exit event before returning lets
      // the OS release the file lock.
      let exitFired = false;
      const exitDetach = pty.onExit(opts.sessionId, () => {
        exitFired = true;
      });
      detachExit();
      // killImmediate (not dispose) — dispose() schedules kill via
      // setTimeout(GRACE_MS) and leaves the entry in pty-manager's sessions
      // map. A subsequent pty.spawn({id: opts.sessionId}) would then
      // short-circuit and return the still-dying PTY with its original
      // (stale) args, silently discarding any new args we just built — which
      // is exactly how mode-flip respawns kept reusing the old talk-mode CC
      // subprocess despite Codara intending to relaunch in execute mode. The
      // GRACE_MS soft-dispose is for UI panes that re-attach a webContents;
      // headless CLI sessions have no such re-attach path, so kill now.
      pty.killImmediate(opts.sessionId);
      // Poll for exit up to 2s. On Windows, killImmediate triggers a
      // detached taskkill /T /F that walks the descendant tree — usually
      // settles in <100ms but can stretch when antivirus/Defender is hot.
      const deadlineAt = Date.now() + 2000;
      while (!exitFired && Date.now() < deadlineAt) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      exitDetach();
    },
  };
}
