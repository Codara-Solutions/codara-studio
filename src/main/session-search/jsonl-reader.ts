// A bounded JSONL reader for the session index. It reads a transcript from a
// byte offset in fixed-size chunks and hands over one complete line at a
// time, so memory stays at one chunk plus the longest line it keeps, never
// the file. A line longer than the cap is skipped without being collected:
// those are pasted images and giant tool outputs, never prose worth finding.

import { promises as fs } from "node:fs";

export const READ_CHUNK_BYTES = 256 * 1024;
export const MAX_LINE_BYTES = 1024 * 1024;

export interface JsonlReadResult {
  /** The offset just after the last complete line: where the next read resumes. */
  offset: number;
  lines: number;
  skippedLines: number;
}

export interface JsonlReadOptions {
  /** Read no further than this, even if the file has grown since it was measured. */
  end: number;
  maxLineBytes?: number;
  /**
   * Called with each line and the offset just past it. A promise lets the
   * caller yield (or pause) without the reader holding more than the current
   * chunk; returning false stops the read at the line just handed over.
   */
  onLine: (line: string, endOffset: number) => void | boolean | Promise<void | boolean>;
}

/**
 * Reads complete lines in [start, end). A trailing line with no newline yet
 * is left unread: the writer is still appending it, and the next read picks it
 * up whole from the returned offset.
 */
export async function readJsonlLines(
  path: string,
  start: number,
  options: JsonlReadOptions,
): Promise<JsonlReadResult> {
  const maxLine = options.maxLineBytes ?? MAX_LINE_BYTES;
  const handle = await fs.open(path, "r");
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  // Pieces of the line being assembled, and their total size.
  let pieces: Buffer[] = [];
  let pieceBytes = 0;
  // True while dropping the rest of an over-long line.
  let skipping = false;
  let position = start;
  let committed = start;
  let lines = 0;
  let skippedLines = 0;
  try {
    outer: while (position < options.end) {
      const want = Math.min(chunk.length, options.end - position);
      const { bytesRead } = await handle.read(chunk, 0, want, position);
      if (bytesRead <= 0) break;
      let from = 0;
      while (from < bytesRead) {
        const newline = chunk.indexOf(0x0a, from);
        const stop = newline === -1 || newline >= bytesRead ? bytesRead : newline;
        if (!skipping) {
          const size = stop - from;
          if (pieceBytes + size > maxLine) {
            skipping = true;
            pieces = [];
            pieceBytes = 0;
          } else if (size > 0) {
            // Copy: the chunk buffer is reused by the next read.
            pieces.push(Buffer.from(chunk.subarray(from, stop)));
            pieceBytes += size;
          }
        }
        if (stop === bytesRead) break;
        // A complete line ends at `newline`.
        const lineEnd = position + newline + 1;
        if (skipping) {
          skippedLines += 1;
          skipping = false;
        } else if (pieceBytes > 0) {
          const text = (pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, pieceBytes)).toString("utf8");
          pieces = [];
          pieceBytes = 0;
          lines += 1;
          committed = lineEnd;
          const verdict = await options.onLine(text.endsWith("\r") ? text.slice(0, -1) : text, lineEnd);
          if (verdict === false) break outer;
        }
        committed = lineEnd;
        from = newline + 1;
      }
      position += bytesRead;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { offset: committed, lines, skippedLines };
}

/** True when the byte just before `offset` is a newline (or offset is 0). */
export async function endsWithNewlineAt(path: string, offset: number): Promise<boolean> {
  if (offset <= 0) return true;
  const handle = await fs.open(path, "r");
  try {
    const byte = Buffer.alloc(1);
    const { bytesRead } = await handle.read(byte, 0, 1, offset - 1);
    return bytesRead === 1 && byte[0] === 0x0a;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
