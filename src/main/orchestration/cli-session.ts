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

import type { ShellInfo } from "@shared/types";
import * as pty from "../pty-manager";
import { tailJsonl, type Disposable } from "./jsonl-tail";

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
   */
  discoverJsonlPath: () => Promise<string | null>;
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
  /** Subscribe to PTY raw stdout (for diagnostics; mostly unused). */
  onStdout(handler: (chunk: Buffer) => void): () => void;
  /** Subscribe to process exit. */
  onExit(handler: (info: { exitCode: number; signal?: number }) => void): () => void;
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
  const shell: ShellInfo = {
    id: `spark-cli-session-${opts.sessionId}`,
    label: "Spark CLI session",
    exe: opts.exe,
    args: opts.args,
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
    for (const h of stdoutHandlers) {
      try {
        h(chunk);
      } catch {
        // swallow
      }
    }
  });
  const detachExit = pty.onExit(opts.sessionId, (info) => {
    for (const h of exitHandlers) {
      try {
        h(info);
      } catch {
        // swallow
      }
    }
  });

  // JSONL discovery loop runs concurrently with the PTY's startup; once a
  // path is found we hand it to tailJsonl and stop polling.
  void (async () => {
    const startedAt = Date.now();
    while (!disposed) {
      let found: string | null = null;
      try {
        found = await opts.discoverJsonlPath();
      } catch {
        found = null;
      }
      if (found) {
        jsonlPath = found;
        tail = tailJsonl(found, (entry) => dispatchEntry(entry));
        return;
      }
      if (Date.now() - startedAt > jsonlReadyTimeoutMs) {
        // Surface a synthetic error so the backend can react (typically by
        // appending a system note to the chat and disposing the session).
        await dispatchEntry({
          __spark_cli_session_error: true,
          message: `CLI session JSONL not found within ${jsonlReadyTimeoutMs}ms`,
        });
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, discoverPollMs));
    }
  })();

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
    onStdout: (handler) => {
      stdoutHandlers.add(handler);
      return () => stdoutHandlers.delete(handler);
    },
    onExit: (handler) => {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      tail?.dispose();
      detachStdout();
      detachExit();
      pty.dispose(opts.sessionId);
    },
  };
}
