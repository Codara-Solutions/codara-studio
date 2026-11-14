// Output a paused pane has not received yet (pty-manager pause/resume), kept
// as small as the pane's own view allows.
//
// What may be dropped, and why the view still comes out right:
// - Output drawn while the alternate screen is on. That screen has no
//   scrollback, and the program repaints it on the redraw resume() requests
//   whenever `lossy` is set.
// - Main-screen output followed by `need` (scrollback + 2 x rows) line feeds
//   with no upward or absolute cursor move between them. Each of those line
//   feeds moves the cursor down (at most rows - 1 times) or scrolls one line
//   up, so by the last one the older output sits above the kept scrollback.
// - Anything past BACKLOG_HARD_BYTES, oldest first, as before the soft cap.
// Pieces start and end where the escape parser is in its ground state and
// outside a UTF-8 sequence. The modes, SGR attributes and full resets that
// dropped bytes carried are written in their place, so a cut never prints
// half an escape sequence or leaves the view on the wrong screen.

export const BACKLOG_TARGET_BYTES = 2 * 1024 * 1024;
export const BACKLOG_HARD_BYTES = 16 * 1024 * 1024;
const PIECE_BYTES = 64 * 1024;
// Rows of the view that replays the backlog: it may be taller than the pty
// the bytes were written for.
const ROWS_BOUND = 500;
const SGR_KEEP = 8;
const EMPTY = Buffer.alloc(0);

// Mode and attribute changes, in the order they were last made.
interface Delta {
  ris: boolean;
  modes: Map<string, "h" | "l">;
  sgr: string[];
}

const newDelta = (): Delta => ({ ris: false, modes: new Map(), sgr: [] });
const sgrResets = (params: string): boolean => /^0*(?:[;:]|$)/.test(params);

function setMode(delta: Delta, key: string, value: "h" | "l"): void {
  delta.modes.delete(key);
  delta.modes.set(key, value);
}

function addSgr(sgr: string[], params: string): void {
  if (sgrResets(params)) sgr.length = 0;
  sgr.push(params);
  if (sgr.length > SGR_KEEP) sgr.splice(0, sgr.length - SGR_KEEP);
}

function foldDelta(into: Delta, delta: Delta): void {
  if (delta.ris) {
    into.ris = true;
    into.modes.clear();
    into.sgr.length = 0;
  }
  for (const [key, value] of delta.modes) setMode(into, key, value);
  for (const params of delta.sgr) addSgr(into.sgr, params);
}

function encodeDelta(delta: Delta): Buffer {
  let text = delta.ris ? "\x1bc" : "";
  for (const [key, value] of delta.modes) text += `\x1b[${key}${value}`;
  for (const params of delta.sgr) text += `\x1b[${params}m`;
  return Buffer.from(text, "latin1");
}

// Missing continuation bytes of a UTF-8 sequence that `buf[start..end)` ends inside.
function utf8Missing(buf: Buffer, start: number, end: number): number {
  for (let i = end - 1; i >= Math.max(start, end - 3); i -= 1) {
    const b = buf[i];
    if (b < 0x80) return 0;
    if (b >= 0xc0) return Math.max(0, (b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2) - (end - i));
  }
  return 0;
}

const GROUND = 0;
const ESC = 1;
const ESC_INTER = 2;
const CSI = 3;
const STRING = 4;

// Just enough of a VT parser to know the parser state, the screen in use, the
// modes, and how far main-screen output has provably scrolled.
export class VtScanner {
  alt = false;
  need = Infinity;
  // Main-screen line feeds counted, and the count before which output is out of view.
  lf = 0;
  horizon = -1;
  private runStart = 0;
  private state = GROUND;
  private utf8 = 0;
  private prefix = 0;
  private params = "";
  private inter = 0;

  atGround(): boolean {
    return this.state === GROUND && this.utf8 === 0;
  }

  // Scans buf[pos..end), recording mode changes into `delta`. Stops just after
  // a sequence that switches between the main and the alternate screen, so the
  // caller can route the bytes on either side differently.
  scan(buf: Buffer, pos: number, end: number, delta: Delta): number {
    let i = pos;
    while (i < end) {
      if (this.state === GROUND) {
        while (this.utf8 > 0 && i < end && (buf[i] & 0xc0) === 0x80) {
          this.utf8 -= 1;
          i += 1;
        }
        // A character split over more than two chunks is still open.
        if (i === end) return end;
        this.utf8 = 0;
        const found = buf.indexOf(0x1b, i);
        const stop = found === -1 || found >= end ? end : found;
        if (!this.alt) this.countLineFeeds(buf, i, stop);
        if (stop === end) {
          this.utf8 = utf8Missing(buf, i, end);
          return end;
        }
        i = stop + 1;
        this.state = ESC;
        continue;
      }
      const b = buf[i++];
      if (b === 0x1b) {
        this.state = ESC;
      } else if (b === 0x18 || b === 0x1a) {
        this.state = GROUND;
      } else if (this.state === STRING) {
        if (b === 0x07) this.state = GROUND;
      } else if (b < 0x20 || b === 0x7f) {
        // C0 controls run inside a sequence without ending it.
      } else if (this.state === ESC) {
        if (b === 0x5b) {
          this.state = CSI;
          this.prefix = 0;
          this.params = "";
          this.inter = 0;
        } else if (b === 0x5d || b === 0x50 || b === 0x58 || b === 0x5e || b === 0x5f) {
          this.state = STRING;
        } else if (b <= 0x2f) {
          this.state = ESC_INTER;
        } else {
          this.state = GROUND;
          if (b === 0x63) {
            delta.ris = true;
            delta.modes.clear();
            delta.sgr.length = 0;
            this.breakRun();
            if (this.alt) {
              this.alt = false;
              return i;
            }
          } else if (b === 0x4d || b === 0x38) {
            // RI and DECRC move the cursor up.
            if (!this.alt) this.breakRun();
          }
        }
      } else if (this.state === ESC_INTER) {
        if (b >= 0x30) {
          this.state = GROUND;
          // DECALN (ESC # 8) homes the cursor.
          if (b === 0x38 && !this.alt) this.breakRun();
        }
      } else if (b >= 0x40) {
        this.state = GROUND;
        if (this.csi(b, delta)) return i;
      } else if (b >= 0x30) {
        if (b >= 0x3c && this.params === "" && this.prefix === 0) this.prefix = b;
        else if (this.params.length < 64) this.params += String.fromCharCode(b);
      } else {
        this.inter = b;
      }
    }
    return i;
  }

  // Returns true when the sequence switched screens.
  private csi(final: number, delta: Delta): boolean {
    if (this.inter !== 0) return false;
    const prefix = this.prefix;
    if ((final === 0x68 || final === 0x6c) && (prefix === 0 || prefix === 0x3f)) {
      const value = final === 0x68 ? "h" : "l";
      let switched = false;
      for (const part of this.params.split(";")) {
        if (!/^\d+$/.test(part)) continue;
        const mode = Number(part);
        setMode(delta, `${prefix ? "?" : ""}${mode}`, value);
        if (prefix === 0) continue;
        if (mode === 47 || mode === 1047 || mode === 1049) {
          if ((value === "h") !== this.alt) {
            // Leaving the alternate screen puts the main cursor back where
            // the program left it, which may be higher up.
            if (this.alt) this.breakRun();
            this.alt = value === "h";
            switched = true;
          }
        } else if (!this.alt && (mode === 3 || mode === 6 || (mode === 1048 && value === "l"))) {
          this.breakRun();
        }
      }
      return switched;
    }
    if (prefix !== 0) return false;
    if (final === 0x6d) {
      addSgr(delta.sgr, this.params);
    } else if (
      !this.alt &&
      // CUU, CPL, CUP, HVP, VPA, DECSTBM, SCORC
      (final === 0x41 || final === 0x46 || final === 0x48 || final === 0x66 || final === 0x64 || final === 0x72 || final === 0x75)
    ) {
      this.breakRun();
    }
    return false;
  }

  private breakRun(): void {
    this.runStart = this.lf;
  }

  private countLineFeeds(buf: Buffer, start: number, end: number): void {
    let count = 0;
    for (let at = buf.indexOf(0x0a, start); at !== -1 && at < end; at = buf.indexOf(0x0a, at + 1)) count += 1;
    if (count === 0) return;
    this.lf += count;
    if (this.lf - this.runStart >= this.need) this.horizon = this.lf - this.need;
  }
}

interface Piece {
  bufs: Buffer[];
  bytes: number;
  // Changes made inside the piece; replayed alone for dropped output.
  delta: Delta;
  // Dropped alternate-screen output: only `delta` remains.
  synthetic: boolean;
  closed: boolean;
  // May go as a whole: it starts at a clean boundary and none of it was sent.
  droppable: boolean;
  lfMark: number;
}

export class DetachedBacklog {
  // Bytes of program output held (the replayed deltas are a few bytes more).
  bytes = 0;
  // Screen content was dropped, so the program must repaint after the replay.
  lossy = false;
  private head: Delta | null = null;
  private pieces: Piece[] = [];
  private raw: Buffer[] = [];
  private rawHead = 0;
  private scanner = new VtScanner();
  private need = Infinity;

  setView(scrollbackLines: number, rows: number): void {
    this.need = scrollbackLines + 2 * Math.max(rows, ROWS_BOUND);
    this.scanner.need = this.need;
  }

  isEmpty(): boolean {
    return this.head === null && this.pieces.length === 0 && this.rawHead >= this.raw.length;
  }

  reset(): void {
    this.bytes = 0;
    this.lossy = false;
    this.head = null;
    this.pieces = [];
    this.raw = [];
    this.rawHead = 0;
    this.scanner = new VtScanner();
    this.scanner.need = this.need;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.raw.push(chunk);
    this.bytes += chunk.length;
    if (this.bytes > BACKLOG_TARGET_BYTES) this.trim();
  }

  // Everything held, in order, as whole buffers (for agent hibernation).
  buffers(): Buffer[] {
    const out: Buffer[] = [];
    if (this.head) out.push(encodeDelta(this.head));
    for (const piece of this.pieces) {
      if (piece.synthetic) out.push(encodeDelta(piece.delta));
      else out.push(...piece.bufs);
    }
    for (let i = this.rawHead; i < this.raw.length; i += 1) out.push(this.raw[i]);
    return out.filter((buf) => buf.length > 0);
  }

  // Removes and returns the next at most `max` bytes of the replay, or null.
  take(max: number): Buffer | null {
    const out: Buffer[] = [];
    let n = 0;
    if (this.head) {
      const encoded = encodeDelta(this.head);
      this.head = null;
      out.push(encoded);
      n += encoded.length;
    }
    while (n < max && this.pieces.length > 0) {
      const piece = this.pieces[0];
      if (piece.synthetic) {
        const encoded = encodeDelta(piece.delta);
        out.push(encoded);
        n += encoded.length;
        this.pieces.shift();
        continue;
      }
      while (n < max && piece.bufs.length > 0) {
        let buf = piece.bufs[0];
        if (buf.length > max - n) {
          piece.bufs[0] = buf.subarray(max - n);
          buf = buf.subarray(0, max - n);
        } else {
          piece.bufs.shift();
        }
        out.push(buf);
        n += buf.length;
        piece.bytes -= buf.length;
        this.bytes -= buf.length;
        piece.droppable = false;
      }
      if (piece.bufs.length > 0) break;
      this.pieces.shift();
    }
    while (n < max && this.pieces.length === 0 && this.rawHead < this.raw.length) {
      let buf = this.raw[this.rawHead];
      if (buf.length > max - n) {
        this.raw[this.rawHead] = buf.subarray(max - n);
        buf = buf.subarray(0, max - n);
      } else {
        this.raw[this.rawHead++] = EMPTY;
      }
      // The scanner must stay in step with the first byte not yet sent.
      for (let at = 0; at < buf.length; ) at = this.scanner.scan(buf, at, buf.length, newDelta());
      out.push(buf);
      n += buf.length;
      this.bytes -= buf.length;
    }
    this.compactRaw();
    if (n === 0) return null;
    return out.length === 1 ? out[0] : Buffer.concat(out, n);
  }

  private trim(): void {
    while ((this.bytes > BACKLOG_TARGET_BYTES || !this.scanner.atGround()) && this.rawHead < this.raw.length) {
      const chunk = this.raw[this.rawHead];
      this.raw[this.rawHead++] = EMPTY;
      this.process(chunk);
    }
    this.compactRaw();
    while (this.pieces.length > 0) {
      const piece = this.pieces[0];
      if (!piece.closed || !piece.droppable || (!piece.synthetic && piece.lfMark > this.scanner.horizon)) break;
      this.dropFirst();
    }
    while (this.bytes > BACKLOG_HARD_BYTES && this.pieces.length > 0) {
      const piece = this.pieces[0];
      this.lossy = true;
      if (piece.closed && piece.droppable) {
        this.dropFirst();
      } else if (piece.bufs.length > 1) {
        // A piece that never reaches a clean boundary (an escape sequence
        // left open) loses whole chunks, the way the backlog always did.
        const dropped = piece.bufs.shift() ?? EMPTY;
        piece.bytes -= dropped.length;
        this.bytes -= dropped.length;
        piece.droppable = false;
      } else {
        break;
      }
    }
  }

  private process(chunk: Buffer): void {
    for (let pos = 0; pos < chunk.length; ) {
      const alt = this.scanner.alt;
      const piece = this.openPiece(alt);
      const next = this.scanner.scan(chunk, pos, chunk.length, piece.delta);
      if (alt) {
        this.bytes -= next - pos;
        this.lossy = true;
      } else {
        const part = pos === 0 && next === chunk.length ? chunk : Buffer.from(chunk.subarray(pos, next));
        piece.bufs.push(part);
        piece.bytes += part.length;
      }
      if (this.scanner.alt !== alt) this.close(piece);
      pos = next;
    }
    const last = this.pieces[this.pieces.length - 1];
    if (last && !last.closed && !last.synthetic && last.bytes >= PIECE_BYTES && this.scanner.atGround()) this.close(last);
  }

  private openPiece(synthetic: boolean): Piece {
    const last = this.pieces[this.pieces.length - 1];
    if (last && !last.closed && last.synthetic === synthetic) return last;
    if (last && !last.closed) this.close(last);
    const piece: Piece = {
      bufs: [],
      bytes: 0,
      delta: newDelta(),
      synthetic,
      closed: false,
      droppable: this.scanner.atGround(),
      lfMark: 0,
    };
    this.pieces.push(piece);
    return piece;
  }

  private close(piece: Piece): void {
    piece.closed = true;
    piece.lfMark = this.scanner.lf;
  }

  private dropFirst(): void {
    const piece = this.pieces.shift();
    if (!piece) return;
    this.head ??= newDelta();
    foldDelta(this.head, piece.delta);
    this.bytes -= piece.bytes;
  }

  private compactRaw(): void {
    if (this.rawHead >= this.raw.length) {
      this.raw = [];
      this.rawHead = 0;
    } else if (this.rawHead > 1024) {
      this.raw = this.raw.slice(this.rawHead);
      this.rawHead = 0;
    }
  }
}
