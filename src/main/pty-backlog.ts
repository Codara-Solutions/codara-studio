// Output a paused pane has not received yet (pty-manager pause/resume), kept
// as small as the pane's own view allows.
//
// What may be dropped, and why the view still comes out right:
// - Output drawn while the alternate screen is on. That screen has no
//   scrollback, and the program repaints it on the redraw resume() requests
//   whenever `lossy` is set.
// - Main-screen output followed by `need` (scrollback + 2 x rows) line feeds
//   with no scroll region and nothing that moves the cursor up or lines down
//   between them. Each of those line feeds moves the cursor down (at most
//   rows - 1 times) or scrolls one line up, so by the last one the older
//   output sits above the kept scrollback. Until the stream shows which
//   screen it is on, such a drop also asks for a repaint.
// - Anything past BACKLOG_HARD_BYTES, oldest first, as before the soft cap.
// Pieces start and end where the escape parser is in its ground state and
// outside a UTF-8 sequence. The modes, character sets, cursor style, SGR
// attributes and resets the dropped bytes carried are written in their place,
// so a cut never prints half an escape sequence or leaves the view in the
// wrong state. C1 controls sent as characters are not parsed here, so a
// stream that carries them is only ever trimmed at the hard cap.

export const BACKLOG_TARGET_BYTES = 2 * 1024 * 1024;
export const BACKLOG_HARD_BYTES = 16 * 1024 * 1024;
const PIECE_BYTES = 64 * 1024;
// A piece's own memory, counted so that many tiny pieces (a program flipping
// screens) still hit the caps.
const PIECE_OVERHEAD = 1024;
// Rows of the view that replays the backlog: it may be taller than the pty
// the bytes were written for.
const ROWS_BOUND = 500;
const EMPTY = Buffer.alloc(0);

// State that dropped bytes changed, in the order it was last changed.
interface Delta {
  ris: boolean;
  seq: Map<string, string>;
  sgrReset: boolean;
  sgr: Map<string, string>;
}

const newDelta = (): Delta => ({ ris: false, seq: new Map(), sgrReset: false, sgr: new Map() });

function setLast(map: Map<string, string>, key: string, value: string): void {
  map.delete(key);
  map.set(key, value);
}

function foldDelta(into: Delta, delta: Delta): void {
  if (delta.ris) {
    into.ris = true;
    into.seq.clear();
    into.sgr.clear();
    into.sgrReset = false;
  }
  for (const [key, value] of delta.seq) setLast(into.seq, key, value);
  if (delta.sgrReset) {
    into.sgr.clear();
    into.sgrReset = true;
  }
  for (const [key, value] of delta.sgr) setLast(into.sgr, key, value);
}

function encodeDelta(delta: Delta): Buffer {
  let text = delta.ris ? "\x1bc" : "";
  for (const value of delta.seq.values()) text += value;
  const sgr = [...(delta.sgrReset ? ["0"] : []), ...delta.sgr.values()];
  if (sgr.length > 0) text += `\x1b[${sgr.join(";")}m`;
  return Buffer.from(text, "latin1");
}

// SGR parameters that set the same attribute share a slot; the last one wins.
const SGR_SLOTS: Record<number, string> = {
  1: "1", 2: "2", 3: "3", 23: "3", 4: "4", 21: "4", 24: "4", 5: "5", 6: "5", 25: "5",
  7: "7", 27: "7", 8: "8", 28: "8", 9: "9", 29: "9", 53: "53", 55: "53", 59: "ul",
};

function applySgr(delta: Delta, params: string): void {
  const parts = params === "" ? ["0"] : params.split(";");
  for (let k = 0; k < parts.length; k += 1) {
    const part = parts[k];
    const n = Number(part.split(":")[0] || "0");
    if (!Number.isInteger(n)) continue;
    if (n === 0) {
      delta.sgr.clear();
      delta.sgrReset = true;
    } else if (n === 22) {
      setLast(delta.sgr, "1", "22");
      setLast(delta.sgr, "2", "22");
    } else if (n === 38 || n === 48 || n === 58) {
      let value = part;
      if (!part.includes(":")) {
        const extra = parts[k + 1] === "5" ? 2 : parts[k + 1] === "2" ? 4 : 0;
        value = parts.slice(k, k + extra + 1).join(";");
        k += extra;
      }
      setLast(delta.sgr, n === 38 ? "fg" : n === 48 ? "bg" : "ul", value);
    } else if ((n >= 30 && n <= 37) || n === 39 || (n >= 90 && n <= 97)) {
      setLast(delta.sgr, "fg", part);
    } else if ((n >= 40 && n <= 47) || n === 49 || (n >= 100 && n <= 107)) {
      setLast(delta.sgr, "bg", part);
    } else {
      setLast(delta.sgr, SGR_SLOTS[n] ?? `x${n}`, part);
    }
  }
}

const GROUND = 0;
const ESC = 1;
const ESC_INTER = 2;
const CSI = 3;
const STRING = 4;

// Just enough of a VT parser to know the parser state, the screen in use, the
// state worth carrying over a cut, and how far main-screen output has
// provably scrolled.
export class VtScanner {
  alt = false;
  // A screen switch or a reset was seen, so `alt` is known rather than assumed.
  screenKnown = false;
  // A C1 control arrived as a character.
  opaque = false;
  need = Infinity;
  // Main-screen line feeds counted, and the count up to which output is out of view.
  lf = 0;
  horizon = -1;
  private runStart = 0;
  private region = false;
  private state = GROUND;
  private utf8 = 0;
  private lead = 0;
  private stringBel = false;
  private prefix = 0;
  private params = "";
  private inter = 0;

  atGround(): boolean {
    return this.state === GROUND && this.utf8 === 0;
  }

  // Scans buf[pos..end), recording state changes into `delta`. Stops just
  // after a sequence that switches between the main and the alternate screen,
  // so the caller can route the bytes on either side differently.
  scan(buf: Buffer, pos: number, end: number, delta: Delta): number {
    let i = pos;
    while (i < end) {
      if (this.state === GROUND) {
        let lineFeeds = 0;
        for (; i < end; i += 1) {
          const b = buf[i];
          if (b === 0x1b) break;
          if (b < 0x80) {
            this.utf8 = 0;
            if (b === 0x0a) lineFeeds += 1;
            else if (b === 0x0e || b === 0x0f) setLast(delta.seq, "shift", String.fromCharCode(b));
          } else if (b >= 0xc0) {
            this.utf8 = b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : 1;
            this.lead = b;
          } else if (this.utf8 > 0) {
            // U+0080..U+009F: xterm reads these as C1 controls.
            if (this.lead === 0xc2 && b <= 0x9f) this.opaque = true;
            this.utf8 -= 1;
            this.lead = 0;
          }
        }
        this.addLineFeeds(lineFeeds);
        if (i >= end) return end;
        i += 1;
        this.utf8 = 0;
        this.state = ESC;
        continue;
      }
      const b = buf[i++];
      if (b === 0x1b) {
        this.state = ESC;
      } else if (b === 0x18 || b === 0x1a) {
        this.state = GROUND;
      } else if (this.state === STRING) {
        if (b === 0x07 && this.stringBel) this.state = GROUND;
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
          this.stringBel = b === 0x5d;
        } else if (b <= 0x2f) {
          this.state = ESC_INTER;
          this.inter = b;
        } else {
          this.state = GROUND;
          if (b === 0x63 && this.reset(delta)) return i;
          // RI and DECRC move the cursor up.
          if (b === 0x4d || b === 0x38) this.breakRun();
        }
      } else if (this.state === ESC_INTER) {
        if (b >= 0x30) {
          this.state = GROUND;
          // Character set designations (SCS).
          if (this.inter >= 0x28 && this.inter <= 0x2f && this.inter !== 0x2c) {
            setLast(delta.seq, `G${this.inter}`, `\x1b${String.fromCharCode(this.inter, b)}`);
          }
          // DECALN (ESC # 8) homes the cursor.
          if (this.inter === 0x23 && b === 0x38) this.breakRun();
        }
      } else if (b >= 0x40) {
        this.state = GROUND;
        if (this.csi(b, delta)) return i;
      } else if (b >= 0x30) {
        if (b >= 0x3c && this.params === "" && this.prefix === 0) this.prefix = b;
        else if (this.params.length < 256) this.params += String.fromCharCode(b);
      } else if (this.inter === 0) {
        this.inter = b;
      }
    }
    return i;
  }

  // RIS. Returns true when it left the alternate screen.
  private reset(delta: Delta): boolean {
    delta.ris = true;
    delta.seq.clear();
    delta.sgr.clear();
    delta.sgrReset = false;
    this.region = false;
    this.screenKnown = true;
    const switched = this.alt;
    this.alt = false;
    this.breakRun();
    return switched;
  }

  // Returns true when the sequence switched screens.
  private csi(final: number, delta: Delta): boolean {
    const { prefix, inter, params } = this;
    if (prefix === 0 && inter === 0x21 && final === 0x70) {
      // DECSTR: a soft reset of modes, margins, character sets and attributes.
      setLast(delta.seq, "DECSTR", "\x1b[!p");
      delta.sgr.clear();
      delta.sgrReset = true;
      if (!this.alt) this.region = false;
      return false;
    }
    if (prefix === 0 && inter === 0x20 && final === 0x71) {
      setLast(delta.seq, "DECSCUSR", `\x1b[${params} q`);
      return false;
    }
    if (inter !== 0) return false;
    if ((final === 0x68 || final === 0x6c) && (prefix === 0 || prefix === 0x3f)) {
      const value = final === 0x68 ? "h" : "l";
      let switched = false;
      for (const part of params.split(";")) {
        if (!/^\d+$/.test(part)) continue;
        const mode = Number(part);
        const key = `${prefix ? "?" : ""}${mode}`;
        setLast(delta.seq, key, `\x1b[${key}${value}`);
        if (prefix === 0) continue;
        if (mode === 47 || mode === 1047 || mode === 1049) {
          this.screenKnown = true;
          if ((value === "h") !== this.alt) {
            // Leaving the alternate screen puts the main cursor back where
            // the program left it, which may be higher up.
            this.alt = value === "h";
            this.breakRun();
            switched = true;
          }
        } else if (mode === 3 || mode === 6 || (mode === 1048 && value === "l")) {
          this.breakRun();
        }
      }
      return switched;
    }
    if (prefix !== 0) return false;
    if (final === 0x6d) {
      applySgr(delta, params);
    } else if (final === 0x72) {
      // DECSTBM. Line feeds inside a region never move the rows outside it.
      if (!this.alt) this.region = /[1-9]/.test(params);
      this.breakRun();
    } else if (
      // CUU, CPL, CUP, HVP, VPA, SCORC move the cursor up; SD, IL, DL and SU
      // move lines; neither can be bounded without the cursor position.
      final === 0x41 || final === 0x46 || final === 0x48 || final === 0x66 || final === 0x64 || final === 0x75 ||
      final === 0x54 || final === 0x4c || final === 0x4d || final === 0x53
    ) {
      this.breakRun();
    }
    return false;
  }

  private breakRun(): void {
    if (!this.alt) this.runStart = this.lf;
  }

  private addLineFeeds(count: number): void {
    if (count === 0 || this.alt) return;
    if (this.region) {
      this.runStart = this.lf;
      return;
    }
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

function observe(scanner: VtScanner, bufs: Buffer[], from: number): void {
  const scratch = newDelta();
  for (let i = from; i < bufs.length; i += 1) {
    const buf = bufs[i];
    for (let at = 0; at < buf.length; ) at = scanner.scan(buf, at, buf.length, scratch);
  }
}

export class DetachedBacklog {
  // Bytes held: program output plus PIECE_OVERHEAD per piece.
  bytes = 0;
  // Screen content was dropped, so the program must repaint after the replay.
  lossy = false;
  private head: Delta | null = null;
  private pieces: Piece[] = [];
  private raw: Buffer[] = [];
  private rawHead = 0;
  private scanner = new VtScanner();
  // Follows what take() handed out, so every slice ends on a clean boundary.
  private sent = new VtScanner();
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
    this.sent = new VtScanner();
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

  // Removes and returns the next slice of the replay, about `max` bytes and
  // ending where no escape sequence or character is open, or null.
  take(max: number): Buffer | null {
    const out: Buffer[] = [];
    let n = this.pull(out, max);
    if (n === 0) return null;
    observe(this.sent, out, 0);
    while (!this.sent.atGround()) {
      const from = out.length;
      const added = this.pull(out, 64);
      if (added === 0) break;
      n += added;
      observe(this.sent, out, from);
    }
    this.compactRaw();
    return out.length === 1 ? out[0] : Buffer.concat(out, n);
  }

  private pull(out: Buffer[], max: number): number {
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
        this.shiftPiece();
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
      this.shiftPiece();
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
      observe(this.scanner, [buf], 0);
      out.push(buf);
      n += buf.length;
      this.bytes -= buf.length;
    }
    return n;
  }

  private trim(): void {
    while ((this.bytes > BACKLOG_TARGET_BYTES || !this.scanner.atGround()) && this.rawHead < this.raw.length) {
      const chunk = this.raw[this.rawHead];
      this.raw[this.rawHead++] = EMPTY;
      this.process(chunk);
    }
    this.compactRaw();
    while (this.pieces.length > 0 && !this.scanner.opaque) {
      const piece = this.pieces[0];
      if (!piece.closed || !piece.droppable) break;
      if (!piece.synthetic) {
        if (piece.lfMark > this.scanner.horizon) break;
        // Before the stream showed its screen, this may have been a full-screen frame.
        if (!this.scanner.screenKnown) this.lossy = true;
      }
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
      const drop = alt && !this.scanner.opaque;
      const piece = this.openPiece(drop);
      const next = this.scanner.scan(chunk, pos, chunk.length, piece.delta);
      if (drop) {
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
    this.bytes += PIECE_OVERHEAD;
    return piece;
  }

  private close(piece: Piece): void {
    piece.closed = true;
    piece.lfMark = this.scanner.lf;
  }

  private shiftPiece(): Piece | undefined {
    const piece = this.pieces.shift();
    if (piece) this.bytes -= piece.bytes + PIECE_OVERHEAD;
    return piece;
  }

  private dropFirst(): void {
    const piece = this.shiftPiece();
    if (!piece) return;
    this.head ??= newDelta();
    foldDelta(this.head, piece.delta);
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
