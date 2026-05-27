// JSONL tail utility — shared by claude-backend and codex-backend.
//
// Both CC and Codex write their session transcripts as append-only JSONL:
//
//   CC    : ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
//   Codex : ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
//
// We watch a single path, emit one parsed JSON object per newline as the file
// grows, and survive the file appearing late (CC writes the JSONL after the
// process actually starts producing output, not on spawn). Partial trailing
// lines (no newline yet) are buffered until the next poll completes them.
//
// Implementation uses polling instead of fs.watch for two reasons:
//   1. fs.watch on Windows is flaky for append-only files — events get
//      dropped under load.
//   2. The transcripts grow at human-readable rates (1-10 entries/sec at
//      peak), so a 150ms tick is plenty responsive and cheap.

import { promises as fs } from "node:fs";

export interface Disposable {
  dispose(): void;
}

export interface TailJsonlOptions {
  /**
   * Polling interval in ms. Defaults to 150ms — fast enough that streaming
   * partials feel live, slow enough that the disk/CPU cost is invisible.
   */
  pollMs?: number;
  /**
   * Maximum time in ms to wait for the file to appear after `tailJsonl()`
   * starts. Defaults to 10s — CC sometimes takes a second after spawn to
   * create the JSONL. After this elapses, `onError` is called once with a
   * "file not found" error but the tail keeps polling so a late-arriving
   * file is still picked up.
   */
  startupTimeoutMs?: number;
  /**
   * Skip lines that fail to parse instead of surfacing them to onError.
   * Some CC/Codex builds occasionally write a non-JSON header banner before
   * the real JSONL stream starts; tolerating those prevents log spam.
   * Defaults to true.
   */
  skipUnparsable?: boolean;
  /**
   * When true, seek to the END of the file on first poll instead of replaying
   * everything from offset 0. Lines already in the file are NOT delivered;
   * only newly appended lines fire `onLine`. Use this when tailing a JSONL
   * that an agent (CC, Codex) resumes — the file already contains prior
   * turns' transcript and replaying them would double-count assistant text
   * into the current turn's accumulator. Defaults to false (replay).
   */
  startFromEnd?: boolean;
}

/**
 * Watch a JSONL file; call `onLine` with each parsed JSON object as it
 * appears. Returns a Disposable that stops the watch.
 *
 * `onLine` may be async — the tail awaits each call before processing the
 * next line, so chat events stay in source order even if the handler does
 * I/O (e.g. broadcasting over IPC).
 *
 * `onError` fires on read / parse failures that the user should know about.
 * Transient ENOENT during startup (file not yet created) is NOT reported
 * via `onError` — it just polls until the file appears or `startupTimeoutMs`
 * elapses (one error after that, then quiet polling continues).
 */
export function tailJsonl(
  path: string,
  onLine: (entry: unknown) => void | Promise<void>,
  onError?: (err: Error) => void,
  options: TailJsonlOptions = {},
): Disposable {
  const pollMs = options.pollMs ?? 150;
  const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
  const skipUnparsable = options.skipUnparsable ?? true;
  const startFromEnd = options.startFromEnd ?? false;

  let stopped = false;
  let offset = 0;
  let buffer = "";
  let lastInode: number | null = null;
  let initialSeekDone = false;
  const startedAt = Date.now();
  let startupErrorReported = false;
  let polling: Promise<void> | null = null;

  async function pollOnce(): Promise<void> {
    if (stopped) return;
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        if (!startupErrorReported && Date.now() - startedAt > startupTimeoutMs) {
          startupErrorReported = true;
          onError?.(new Error(`jsonl-tail: ${path} did not appear within ${startupTimeoutMs}ms`));
        }
        return;
      }
      onError?.(err as Error);
      return;
    }
    // Detect atomic-rename / truncate: inode changed or file shrank.
    // Re-open from offset 0 and clear any partial buffer in that case.
    if (lastInode !== null && stat.ino !== lastInode) {
      offset = 0;
      buffer = "";
    } else if (stat.size < offset) {
      offset = 0;
      buffer = "";
    }
    lastInode = stat.ino;
    // First time we see the file with startFromEnd: skip everything already
    // written so we only stream NEW appends. Done once — after this poll the
    // offset advances normally and any future inode/truncate event still
    // resets to 0 (the user wants to see fresh content from a re-created file).
    if (!initialSeekDone) {
      initialSeekDone = true;
      if (startFromEnd) {
        offset = stat.size;
        return;
      }
    }
    if (stat.size <= offset) return;
    const length = stat.size - offset;
    const handle = await fs.open(path, "r");
    try {
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, offset);
      offset = stat.size;
      buffer += buf.toString("utf8");
    } finally {
      await handle.close();
    }
    let newlineIdx = buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const rawLine = buffer.slice(0, newlineIdx).replace(/\r$/, "");
      buffer = buffer.slice(newlineIdx + 1);
      if (rawLine.length > 0) {
        try {
          const parsed = JSON.parse(rawLine);
          // Await onLine to keep events in source order. Swallow handler
          // errors so one bad event doesn't poison the rest of the stream;
          // surface via onError if the caller wants to know.
          try {
            await onLine(parsed);
          } catch (err) {
            onError?.(err as Error);
          }
        } catch (parseErr) {
          if (!skipUnparsable) {
            onError?.(new Error(`jsonl-tail: failed to parse line: ${(parseErr as Error).message}`));
          }
        }
      }
      newlineIdx = buffer.indexOf("\n");
    }
  }

  function tick(): void {
    if (stopped) return;
    if (polling) return; // skip ticks while a previous one is still in flight
    polling = pollOnce()
      .catch((err) => onError?.(err as Error))
      .finally(() => {
        polling = null;
      });
  }

  const interval = setInterval(tick, pollMs);
  // Kick off an immediate first poll so callers don't pay the first tick of
  // latency when the file already has content (e.g. resume case).
  tick();

  return {
    dispose() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
    },
  };
}
