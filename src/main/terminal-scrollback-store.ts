import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
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
};

export interface TerminalScrollbackStoreDeps {
  dir: string;
  tap(paneId: string, handler: (chunk: Buffer) => void): () => void;
  hasSession(paneId: string): boolean;
  dimensions(paneId: string): { cols: number; rows: number } | null;
  readTail(paneId: string, maxBytes: number): Buffer | null;
  enabled(): boolean;
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
  // write into any xterm: no cursor movement, modes, OSC or queries.
  text: string;
  savedAt: string;
}

export interface TerminalScrollbackReplayOptions {
  maxLines?: number;
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
export const RESTORED_OUTPUT_MARKER = "\x1b[0m\x1b[2m[Restored from before Codara restarted]\x1b[0m\r\n";

interface PaneState {
  paneId: string;
  untap: (() => void) | null;
  history: string;
  raw: Buffer[];
  rawBytes: number;
  folding: { history: string; raw: Buffer[] } | null;
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
  private readonly replayed = new Set<string>();
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
    if (!this.deps.enabled()) return;
    this.wipedWhileDisabled = false;
    for (const paneId of paneIds) {
      if (typeof paneId !== "string" || paneId.length === 0) continue;
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
    this.replayed.delete(paneId);
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
   * resumed agent draws. Only once per pane per app session, and only while
   * the pane has no live PTY, unless `force` is set.
   */
  async restoreReplay(
    paneId: string,
    options: TerminalScrollbackReplayOptions = {},
  ): Promise<TerminalScrollbackReplay | null> {
    await this.init();
    if (!this.deps.enabled()) return null;
    if (!options.force) {
      if (this.replayed.has(paneId)) return null;
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
    this.replayed.add(paneId);
    const text = body + RESTORED_OUTPUT_MARKER;
    // The renderer writes exactly this before the new session's bytes, so it
    // becomes the start of the pane's next record: a second restart still
    // shows the first one's output, in order.
    const state = this.panes.get(paneId) ?? this.ensureState(paneId);
    if (!state.live) {
      state.history = text;
      state.raw = [];
      state.rawBytes = 0;
      state.cols = record.cols;
      state.rows = record.rows;
    }
    return { text, savedAt: record.savedAt };
  }

  /** The setting changed. Off stops recording and deletes every file. */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.init();
    if (enabled) return;
    await this.wipe();
  }

  /** Test hook: wait for folds and writes in flight. */
  async idle(): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
      const busy = [...this.panes.values()].filter((s) => s.folding || s.foldQueued);
      await Promise.all([...this.panes.values()].map((s) => s.writing.catch(() => undefined)));
      if (busy.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
      // A fold is still running and this much arrived meanwhile: keep the
      // newest bytes in one buffer. What is lost is output that came after
      // the fold took its bytes, never the history before it.
      const kept = Buffer.from(trimRawFront(concat(state.raw), this.limits.rawHardCapBytes));
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
    // Take the bytes now, not when the fold runs: a burst arriving in the
    // same tick would otherwise push them past the hard cap before they are
    // folded, and the history they hold would be lost.
    const job = { history: state.history, raw: state.raw };
    state.folding = job;
    state.raw = [];
    state.rawBytes = 0;
    const generation = state.generation;
    state.foldQueued = true;
    setImmediate(() => {
      state.foldQueued = false;
      void this.fold(state, job, generation);
    });
  }

  private async fold(state: PaneState, job: { history: string; raw: Buffer[] }, generation: number): Promise<void> {
    if (state.generation !== generation || this.panes.get(state.paneId) !== state) {
      if (state.folding === job) state.folding = null;
      return;
    }
    try {
      const next = await compactScrollback(job.history, job.raw, state.cols, state.rows, this.renderLimits());
      if (state.generation === generation) state.history = next;
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
    const history = state.folding ? state.folding.history : state.history;
    const rawParts = state.folding ? [...state.folding.raw, ...state.raw] : state.raw;
    const raw = trimRawFront(concat(rawParts.length > 0 ? rawParts : [Buffer.alloc(0)]), this.limits.rawHardCapBytes);
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
      await fs.rename(tmp, file);
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
    for (const state of this.panes.values()) {
      state.generation += 1;
      if (state.timer) clearTimeout(state.timer);
      state.untap?.();
    }
    this.panes.clear();
    this.replayed.clear();
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
