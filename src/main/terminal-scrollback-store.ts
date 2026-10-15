import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { RESTORED_OUTPUT_MARKER_TEXT } from "@shared/terminal-scrollback";
import {
  clampGeometry,
  compactScrollback,
  renderScrollbackForDisplay,
  type ScrollbackRenderLimits,
} from "./terminal-scrollback-render";

// Each terminal pane's output, kept on disk in Codara's own folder so a pane
// restored after a quit, an update or a crash shows what happened before.
//
// Recording is cheap on the hot path: the store taps the pane's PTY bytes and
// only appends them. Once enough raw bytes pile up they are folded through a
// headless terminal into the screen and history they produced (see
// terminal-scrollback-render.ts), so a TUI that repaints its footer ten times
// a second cannot push the real history out. A save writes that folded text
// plus the raw bytes since, debounced, to one 0600 file per pane.
//
// Folding runs on the main process, which also carries every pane's output to
// the window. Folds therefore run one at a time across all panes and leave the
// thread alone between them (foldMaxDuty), so a pane streaming a huge log
// costs a bounded share of the main thread. Output that arrives faster than
// that is cut from the front at rawHardCapBytes: only the newest part of such
// a flood can survive the line budget anyway.
//
// Lifetime: a file goes away when the user closes its pane (forget), when the
// setting is turned off, when it has not been written for maxAgeMs, or when
// the total budget evicts it, oldest first. Nothing here is synced anywhere.
//
// Kept dependency-injected (no electron, no pty-manager import) so
// scripts/test-terminal-scrollback-store.cjs drives it in plain Node.

export interface TerminalScrollbackLimits {
  // Raw bytes that trigger a fold into the history text.
  rawCompactBytes: number;
  // Raw bytes kept if folding falls behind or fails.
  rawHardCapBytes: number;
  // Rows of history kept per pane (screen included).
  historyMaxLines: number;
  // Characters of folded history kept per pane.
  historyMaxChars: number;
  // Larger files are ignored on read.
  fileMaxBytes: number;
  // All panes together.
  totalMaxBytes: number;
  saveDebounceMs: number;
  saveMaxWaitMs: number;
  maxAgeMs: number;
  // Characters a restore hands the renderer.
  replayMaxChars: number;
  // Share of the main thread folding may take while output floods in (each
  // fold is followed by a pause of took * (1 / duty - 1)), and the shortest
  // pause between two folds.
  foldMaxDuty: number;
  foldMinGapMs: number;
}

export const DEFAULT_TERMINAL_SCROLLBACK_LIMITS: TerminalScrollbackLimits = {
  rawCompactBytes: 256 * 1024,
  rawHardCapBytes: 1024 * 1024,
  historyMaxLines: 3_000,
  historyMaxChars: 512 * 1024,
  fileMaxBytes: 6 * 1024 * 1024,
  totalMaxBytes: 64 * 1024 * 1024,
  saveDebounceMs: 2_000,
  saveMaxWaitMs: 15_000,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  replayMaxChars: 1024 * 1024,
  foldMaxDuty: 0.1,
  foldMinGapMs: 50,
};

export interface TerminalScrollbackStoreDeps {
  dir: string;
  tap(paneId: string, handler: (chunk: Buffer) => void): () => void;
  hasSession(paneId: string): boolean;
  dimensions(paneId: string): { cols: number; rows: number } | null;
  readTail(paneId: string, maxBytes: number): Buffer | null;
  enabled(): boolean;
  // Windows: every pane runs under ConPTY, which owns the screen of the
  // session it starts (see handOverScreen). False elsewhere.
  newSessionOwnsScreen?: boolean;
  limits?: Partial<TerminalScrollbackLimits>;
  now?: () => number;
  log?: (line: string) => void;
}

/** A pane's saved output as stored: folded history text, then raw bytes. */
export interface TerminalScrollbackRecord {
  paneId: string;
  cols: number;
  rows: number;
  savedAt: string;
  history: string;
  raw: Buffer;
}

export interface TerminalScrollbackReplay {
  // Lines with SGR colors and CRLF endings, then a dim marker line. Safe to
  // write into any xterm: no modes, OSC or queries. On Windows it ends by
  // moving those lines up into the scrollback and the cursor to the top left
  // of a blank screen (handOverScreen); elsewhere it has no cursor movement.
  text: string;
  savedAt: string;
}

export interface TerminalScrollbackReplayOptions {
  maxLines?: number;
  // Rows of the terminal the text is written into, for handOverScreen.
  rows?: number;
  // Replay even though the pane already ran this app session. For a caller
  // that stopped the pane's process on purpose (agent hibernation) and is
  // about to start it again.
  force?: boolean;
}

const FILE_MAGIC = "CODARA-SCROLLBACK 1";
const FILE_EXT = ".bin";
const MAX_HEADER_BYTES = 4096;

// Plain words, dim, on its own line. Written by main so the line is also part
// of the record and survives the next restart in the right place.
export const RESTORED_OUTPUT_MARKER = `\x1b[0m\x1b[2m${RESTORED_OUTPUT_MARKER_TEXT}\x1b[0m\r\n`;

interface PaneState {
  paneId: string;
  untap: (() => void) | null;
  history: string;
  // `history` is a replay a new ConPTY session starts below: it is parsed
  // followed by handOverScreen at the rows of that parse (Windows only).
  handOver: boolean;
  raw: Buffer[];
  rawBytes: number;
  folding: FoldJob | null;
  foldQueued: boolean;
  cols: number;
  rows: number;
  dirty: boolean;
  dirtySince: number;
  lastChunkAt: number;
  timer: NodeJS.Timeout | null;
  // Produced output or had a live PTY in this app session: its record is no
  // longer the one from before the restart.
  live: boolean;
  generation: number;
  writing: Promise<void>;
}

interface FoldJob {
  history: string;
  handOver: boolean;
  raw: Buffer[];
}

interface QueuedFold {
  state: PaneState;
  job: FoldJob;
  generation: number;
}

interface IndexEntry {
  size: number;
  mtimeMs: number;
}

export function scrollbackFileName(paneId: string): string {
  return `${createHash("sha256").update(paneId).digest("hex").slice(0, 40)}${FILE_EXT}`;
}

function concat(chunks: readonly Buffer[]): Buffer {
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
}

// The last `max` bytes, starting after a line break when one is near, so the
// kept part never opens inside an escape sequence or a UTF-8 character.
export function trimRawFront(raw: Buffer, max: number): Buffer {
  if (raw.length <= max) return raw;
  let start = raw.length - max;
  const newline = raw.indexOf(0x0a, start);
  if (newline !== -1 && newline - start < 64 * 1024) return raw.subarray(newline + 1);
  while (start < raw.length && (raw[start] & 0xc0) === 0x80) start += 1;
  return raw.subarray(start);
}

export class TerminalScrollbackStore {
  private readonly deps: TerminalScrollbackStoreDeps;
  private readonly limits: TerminalScrollbackLimits;
  private readonly now: () => number;
  private readonly panes = new Map<string, PaneState>();
  private readonly index = new Map<string, IndexEntry>();
  // Every pane the renderer reported, also while the setting is off, so
  // turning it back on records them at once instead of at the next layout
  // change.
  private readonly known = new Set<string>();
  private readonly foldQueue: QueuedFold[] = [];
  private foldTimer: NodeJS.Timeout | null = null;
  private foldRunning = false;
  private foldNotBefore = 0;
  private folds = 0;
  private ready: Promise<void> | null = null;
  private wipedWhileDisabled = false;

  constructor(deps: TerminalScrollbackStoreDeps) {
    this.deps = deps;
    this.limits = { ...DEFAULT_TERMINAL_SCROLLBACK_LIMITS, ...(deps.limits ?? {}) };
    this.now = deps.now ?? Date.now;
  }

  /** Create the folder, drop stale and stray files, and index the rest. Idempotent. */
  init(): Promise<void> {
    this.ready ??= this.load().catch((err) => {
      this.log(`init failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.ready;
  }

  /** Start recording these panes. Unknown ids are added; nothing is removed. */
  track(paneIds: Iterable<string>): void {
    const ids = [...paneIds].filter((paneId) => typeof paneId === "string" && paneId.length > 0);
    for (const paneId of ids) this.known.add(paneId);
    if (!this.deps.enabled()) return;
    this.wipedWhileDisabled = false;
    for (const paneId of ids) {
      const state = this.ensureState(paneId);
      if (state.untap) continue;
      // Tap first, then read what the session already printed: nothing can
      // run between the two, so every byte is seen exactly once.
      state.untap = this.deps.tap(paneId, (chunk) => this.onChunk(state, chunk));
      if (this.deps.hasSession(paneId)) {
        state.live = true;
        const tail = this.deps.readTail(paneId, this.limits.rawHardCapBytes);
        if (tail && tail.length > 0) this.onChunk(state, Buffer.from(tail));
      }
    }
  }

  isTracked(paneId: string): boolean {
    return this.panes.get(paneId)?.untap != null;
  }

  /** The pane was closed for good: stop recording and delete its file. */
  async forget(paneId: string): Promise<void> {
    await this.init();
    const state = this.panes.get(paneId);
    if (state) {
      state.generation += 1;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.untap?.();
      this.panes.delete(paneId);
      await state.writing.catch(() => undefined);
    }
    this.known.delete(paneId);
    await this.removeFile(scrollbackFileName(paneId));
  }

  /** Write every pane with unsaved output now (or just `paneId`). */
  async flush(paneId?: string): Promise<void> {
    await this.init();
    const targets = paneId ? [this.panes.get(paneId)].filter((s): s is PaneState => !!s) : [...this.panes.values()];
    await Promise.all(targets.map((state) => this.save(state)));
  }

  /** The stored record, as written. Null when there is none or it is unreadable. */
  async read(paneId: string): Promise<TerminalScrollbackRecord | null> {
    await this.init();
    const file = join(this.deps.dir, scrollbackFileName(paneId));
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > this.limits.fileMaxBytes) return null;
      return parseRecord(await fs.readFile(file), paneId);
    } catch {
      return null;
    }
  }

  /**
   * What a pane restored after a restart shows before its new shell or its
   * resumed agent draws. Only until the pane's process starts in this app
   * session, unless `force` is set.
   *
   * Not "once per pane": a pane can unmount between asking and spawning (a
   * workspace switch or a layout swap while the app opens), and the xterm the
   * replay went to is then gone. The next mount asks again and gets the same
   * text, since the record cannot change before the pane prints anything.
   */
  async restoreReplay(
    paneId: string,
    options: TerminalScrollbackReplayOptions = {},
  ): Promise<TerminalScrollbackReplay | null> {
    await this.init();
    if (!this.deps.enabled()) return null;
    if (!options.force) {
      if (this.deps.hasSession(paneId) || this.panes.get(paneId)?.live) return null;
    }
    const record = await this.read(paneId);
    if (!record) return null;
    const maxLines = Math.max(
      1,
      Math.min(this.limits.historyMaxLines, Math.trunc(options.maxLines ?? this.limits.historyMaxLines)),
    );
    let body: string;
    try {
      body = await renderScrollbackForDisplay([record.history, record.raw], record.cols, record.rows, {
        maxLines,
        maxChars: this.limits.replayMaxChars,
      });
    } catch (err) {
      this.log(`render failed for ${paneId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    if (body.trim().length === 0) return null;
    const handOver = this.deps.newSessionOwnsScreen === true;
    const rows = clampGeometry(record.cols, typeof options.rows === "number" ? options.rows : record.rows).rows;
    const history = body + RESTORED_OUTPUT_MARKER;
    // The renderer writes exactly this before the new session's bytes, so it
    // becomes the start of the pane's next record: a second restart still
    // shows the first one's output, in order. The hand-over is added again
    // at the rows each later parse uses, since the pane may be resized
    // before then (a pane restored in a hidden workspace is fitted when
    // shown) and rows - 1 line feeds only clear a screen of that height.
    const state = this.panes.get(paneId) ?? this.ensureState(paneId);
    if (!state.live) {
      state.history = history;
      state.handOver = handOver;
      state.raw = [];
      state.rawBytes = 0;
      state.cols = record.cols;
      state.rows = rows;
    }
    return { text: handOver ? history + handOverScreen(rows) : history, savedAt: record.savedAt };
  }

  /** The setting changed. Off stops recording and deletes every file. */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.init();
    if (enabled) {
      // Panes already open start recording now, seeded with what their
      // session still holds, so a quit right after this keeps their output.
      this.track([...this.known]);
      return;
    }
    await this.wipe();
  }

  /** Test hook: wait for folds and writes in flight. */
  async idle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const busy =
        this.foldRunning ||
        this.foldQueue.length > 0 ||
        [...this.panes.values()].some((s) => s.folding || s.foldQueued);
      await Promise.all([...this.panes.values()].map((s) => s.writing.catch(() => undefined)));
      if (!busy || Date.now() > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Test hook: folds run so far. */
  foldCount(): number {
    return this.folds;
  }

  totalBytes(): number {
    let total = 0;
    for (const entry of this.index.values()) total += entry.size;
    return total;
  }

  dispose(): void {
    for (const state of this.panes.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.untap?.();
      state.untap = null;
    }
    if (this.foldTimer) clearTimeout(this.foldTimer);
    this.foldTimer = null;
    for (const queued of this.foldQueue.splice(0)) {
      queued.state.foldQueued = false;
      if (queued.state.folding === queued.job) queued.state.folding = null;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private log(line: string): void {
    this.deps.log?.(line);
  }

  private async load(): Promise<void> {
    const dir = this.deps.dir;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(dir, 0o700).catch(() => undefined);
    if (!this.deps.enabled()) {
      await this.wipe();
      return;
    }
    const cutoff = this.now() - this.limits.maxAgeMs;
    for (const name of await fs.readdir(dir)) {
      const file = join(dir, name);
      if (!name.endsWith(FILE_EXT)) {
        if (name.endsWith(".tmp")) await fs.rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) continue;
        if (stat.mtimeMs < cutoff || stat.size > this.limits.fileMaxBytes) {
          await fs.rm(file, { force: true });
          continue;
        }
        this.index.set(name, { size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        /* vanished meanwhile */
      }
    }
    await this.enforceTotal(null);
  }

  private ensureState(paneId: string): PaneState {
    let state = this.panes.get(paneId);
    if (!state) {
      state = {
        paneId,
        untap: null,
        history: "",
        handOver: false,
        raw: [],
        rawBytes: 0,
        folding: null,
        foldQueued: false,
        cols: 80,
        rows: 24,
        dirty: false,
        dirtySince: 0,
        lastChunkAt: 0,
        timer: null,
        live: false,
        generation: 0,
        writing: Promise.resolve(),
      };
      this.panes.set(paneId, state);
    }
    return state;
  }

  private onChunk(state: PaneState, chunk: Buffer): void {
    if (chunk.length === 0) return;
    state.live = true;
    state.raw.push(chunk);
    state.rawBytes += chunk.length;
    const size = this.deps.dimensions(state.paneId);
    if (size) {
      state.cols = size.cols;
      state.rows = size.rows;
    }
    if (state.rawBytes > this.limits.rawHardCapBytes) {
      // A fold is still running or waiting its turn and this much arrived
      // meanwhile: keep the newest bytes in one buffer. What is lost is output
      // that came after the fold took its bytes, never the history before it.
      // Cut to three quarters of the cap, so a flood copies once per quarter
      // cap of output instead of on every chunk.
      const kept = trimRawFront(concat(state.raw), Math.floor((this.limits.rawHardCapBytes * 3) / 4));
      state.raw = [kept];
      state.rawBytes = kept.length;
    }
    if (state.rawBytes >= this.limits.rawCompactBytes) this.queueFold(state);
    this.markDirty(state);
  }

  private markDirty(state: PaneState): void {
    const now = this.now();
    state.lastChunkAt = now;
    if (!state.dirty) {
      state.dirty = true;
      state.dirtySince = now;
    }
    if (!state.timer) this.armSave(state, this.limits.saveDebounceMs);
  }

  private armSave(state: PaneState, delay: number): void {
    const generation = state.generation;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (state.generation !== generation || !state.dirty) return;
      const now = this.now();
      const quietFor = now - state.lastChunkAt;
      const dirtyFor = now - state.dirtySince;
      if (quietFor < this.limits.saveDebounceMs && dirtyFor < this.limits.saveMaxWaitMs) {
        const wait = Math.min(
          this.limits.saveDebounceMs - quietFor,
          this.limits.saveMaxWaitMs - dirtyFor,
        );
        this.armSave(state, Math.max(10, wait));
        return;
      }
      void this.save(state);
    }, delay);
    state.timer.unref?.();
  }

  private queueFold(state: PaneState): void {
    if (state.folding || state.raw.length === 0 || this.panes.get(state.paneId) !== state) return;
    // Take the bytes now, not when the fold runs: a burst arriving before it
    // runs would otherwise push them past the hard cap before they are
    // folded, and the history they hold would be lost.
    const job: FoldJob = { history: state.history, handOver: state.handOver, raw: state.raw };
    state.folding = job;
    state.raw = [];
    state.rawBytes = 0;
    state.foldQueued = true;
    this.foldQueue.push({ state, job, generation: state.generation });
    this.pumpFolds();
  }

  // One fold at a time, across every pane, each followed by a pause in
  // proportion to how long it took (see foldMaxDuty).
  private pumpFolds(): void {
    if (this.foldRunning || this.foldTimer || this.foldQueue.length === 0) return;
    const wait = Math.max(0, this.foldNotBefore - performance.now());
    this.foldTimer = setTimeout(() => {
      this.foldTimer = null;
      const next = this.foldQueue.shift();
      if (!next) return;
      next.state.foldQueued = false;
      this.foldRunning = true;
      const started = performance.now();
      void this.fold(next.state, next.job, next.generation)
        .then((worked) => {
          if (!worked) return;
          const took = performance.now() - started;
          const duty = Math.min(1, Math.max(0.01, this.limits.foldMaxDuty));
          this.foldNotBefore = performance.now() + Math.max(this.limits.foldMinGapMs, took * (1 / duty - 1));
        })
        .finally(() => {
          this.foldRunning = false;
          this.pumpFolds();
        });
    }, wait);
    this.foldTimer.unref?.();
  }

  // True when it folded, false when the pane was gone or reset meanwhile.
  private async fold(state: PaneState, job: FoldJob, generation: number): Promise<boolean> {
    if (state.generation !== generation || this.panes.get(state.paneId) !== state) {
      if (state.folding === job) state.folding = null;
      return false;
    }
    this.folds += 1;
    try {
      const prefix = job.handOver ? job.history + handOverScreen(state.rows) : job.history;
      const next = await compactScrollback(prefix, job.raw, state.cols, state.rows, this.renderLimits());
      if (state.generation === generation) {
        state.history = next;
        state.handOver = false;
      }
    } catch (err) {
      this.log(`fold failed for ${state.paneId}: ${err instanceof Error ? err.message : String(err)}`);
      if (state.generation === generation) {
        const merged = Buffer.from(trimRawFront(concat([...job.raw, ...state.raw]), this.limits.rawHardCapBytes));
        state.raw = [merged];
        state.rawBytes = merged.length;
      }
    } finally {
      if (state.folding === job) state.folding = null;
    }
    if (state.rawBytes >= this.limits.rawCompactBytes) this.queueFold(state);
    return true;
  }

  private renderLimits(): ScrollbackRenderLimits {
    return { maxLines: this.limits.historyMaxLines, maxChars: this.limits.historyMaxChars };
  }

  private save(state: PaneState): Promise<void> {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    if (!state.dirty || !this.deps.enabled()) return state.writing;
    state.dirty = false;
    const generation = state.generation;
    const base = state.folding ?? state;
    // The rows in the header are the ones this hand-over is made for, and the
    // ones the next restart parses the record at.
    const history = base.handOver ? base.history + handOverScreen(state.rows) : base.history;
    const rawParts = state.folding ? [...state.folding.raw, ...state.raw] : state.raw;
    // A fold waiting its turn holds up to a cap of bytes and the pane up to
    // another: keep both, so a save (the one at quit included) never drops
    // the bytes the fold took.
    const raw = trimRawFront(concat(rawParts.length > 0 ? rawParts : [Buffer.alloc(0)]), 2 * this.limits.rawHardCapBytes);
    const header = {
      paneId: state.paneId,
      cols: state.cols,
      rows: state.rows,
      savedAt: new Date(this.now()).toISOString(),
      historyBytes: Buffer.byteLength(history, "utf8"),
    };
    const body = Buffer.concat([
      Buffer.from(`${FILE_MAGIC}\n${JSON.stringify(header)}\n`, "utf8"),
      Buffer.from(history, "utf8"),
      raw,
    ]);
    const name = scrollbackFileName(state.paneId);
    state.writing = state.writing
      .catch(() => undefined)
      .then(async () => {
        if (state.generation !== generation || this.panes.get(state.paneId) !== state) return;
        await this.writeFile(name, body);
        await this.enforceTotal(name);
      })
      .catch((err) => {
        this.log(`save failed for ${state.paneId}: ${err instanceof Error ? err.message : String(err)}`);
        // Try again at the next save or flush (the one at quit included)
        // instead of losing what this one held.
        if (state.generation === generation && this.panes.get(state.paneId) === state) state.dirty = true;
      });
    return state.writing;
  }

  private async writeFile(name: string, data: Buffer): Promise<void> {
    const file = join(this.deps.dir, name);
    const tmp = join(this.deps.dir, `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await fs.writeFile(tmp, data, { mode: 0o600 });
      // umask can loosen the mode open(2) applied.
      if (process.platform !== "win32") await fs.chmod(tmp, 0o600);
      await renameWithRetry(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    this.index.set(name, { size: data.length, mtimeMs: this.now() });
  }

  private async removeFile(name: string): Promise<void> {
    this.index.delete(name);
    await fs.rm(join(this.deps.dir, name), { force: true }).catch(() => undefined);
  }

  // Oldest files go first; the one just written stays.
  private async enforceTotal(keep: string | null): Promise<void> {
    let total = this.totalBytes();
    if (total <= this.limits.totalMaxBytes) return;
    const oldest = [...this.index.entries()]
      .filter(([name]) => name !== keep)
      .sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);
    for (const [name, entry] of oldest) {
      if (total <= this.limits.totalMaxBytes) break;
      total -= entry.size;
      await this.removeFile(name);
    }
  }

  private async wipe(): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const state of this.panes.values()) {
      state.generation += 1;
      if (state.timer) clearTimeout(state.timer);
      state.untap?.();
      writes.push(state.writing.catch(() => undefined));
    }
    this.panes.clear();
    // A write already past its checks would otherwise land after the files
    // below were listed and outlive the setting being turned off.
    await Promise.all(writes);
    if (this.wipedWhileDisabled) return;
    this.wipedWhileDisabled = true;
    this.index.clear();
    let names: string[] = [];
    try {
      names = await fs.readdir(this.deps.dir);
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((name) => name.endsWith(FILE_EXT) || name.endsWith(".tmp"))
        .map((name) => fs.rm(join(this.deps.dir, name), { force: true }).catch(() => undefined)),
    );
  }
}

// What follows the replay on Windows. ConPTY owns the screen of the session
// it starts: its first paint clears it, and it positions the shell's output
// (PSReadLine redraws its input line with absolute cursor moves) as if the
// session began at the top left. Replayed rows left on screen would be wiped
// or written over, so they move up into the scrollback (rows - 1 line feeds
// from anywhere on screen scroll every row above the cursor out) and the
// cursor goes home, to the blank row right after the marker line, where
// ConPTY believes it is.
export function handOverScreen(rows: number): string {
  return `${"\n".repeat(Math.max(0, Math.trunc(rows) - 1))}\x1b[H`;
}

// Windows: an antivirus or indexer scan can hold the target for a moment, and
// rename then fails with EPERM, EACCES or EBUSY. Retry briefly before giving up.
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

export function parseRecord(data: Buffer, expectedPaneId: string): TerminalScrollbackRecord | null {
  const magicEnd = data.indexOf(0x0a);
  if (magicEnd <= 0 || data.subarray(0, magicEnd).toString("utf8") !== FILE_MAGIC) return null;
  const headerEnd = data.indexOf(0x0a, magicEnd + 1);
  if (headerEnd === -1 || headerEnd - magicEnd > MAX_HEADER_BYTES) return null;
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(data.subarray(magicEnd + 1, headerEnd).toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!header || header.paneId !== expectedPaneId) return null;
  const cols = Number(header.cols);
  const rows = Number(header.rows);
  const historyBytes = Number(header.historyBytes);
  const body = data.subarray(headerEnd + 1);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return null;
  if (!Number.isInteger(historyBytes) || historyBytes < 0 || historyBytes > body.length) return null;
  return {
    paneId: expectedPaneId,
    cols,
    rows,
    savedAt: typeof header.savedAt === "string" ? header.savedAt : "",
    history: body.subarray(0, historyBytes).toString("utf8"),
    raw: Buffer.from(body.subarray(historyBytes)),
  };
}
