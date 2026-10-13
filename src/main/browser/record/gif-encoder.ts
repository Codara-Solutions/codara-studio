// A streaming animated GIF encoder with no dependencies. Each frame gets its
// own 255-color palette (median cut over the colors that changed), only the
// box that changed since the previous frame is stored, and unchanged pixels
// inside it are transparent, so a UI flow where little moves stays small.
//
// createGifEncoder is stringified into a worker thread (gif-worker.ts), so
// it must reference nothing outside its own body: no imports, no module
// level helpers.

export interface GifEncoder {
  /** An RGBA frame of the encoder's size, shown for delayCs hundredths of a second. */
  addFrame(rgba: Uint8Array, delayCs: number): void;
  finish(): Uint8Array;
}

export function createGifEncoder(width: number, height: number): GifEncoder {
  const TRANSPARENT = 255;
  // Per channel, how far a pixel may drift and still count as unchanged:
  // absorbs JPEG noise in screencast frames.
  const TOLERANCE = 6;
  const chunks: Uint8Array[] = [];
  let finished = false;
  let reference: Uint8Array | null = null;
  let pending: { delay: number; transparent: boolean; body: Uint8Array } | null = null;
  // LZW codes by prefix code * 256 + next index, shared by every frame; a
  // generation stamp empties the table without refilling it.
  const codes = new Int32Array(4096 * 256);
  const stamps = new Uint32Array(4096 * 256);
  let generation = 0;

  const u16 = (value: number) => [value & 255, (value >> 8) & 255];
  const write = (bytes: ArrayLike<number>) => chunks.push(Uint8Array.from(bytes));
  const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

  write([...ascii("GIF89a"), ...u16(width), ...u16(height), 0x00, 0x00, 0x00]);
  // Loop forever.
  write([0x21, 0xff, 0x0b, ...ascii("NETSCAPE2.0"), 0x03, 0x01, 0x00, 0x00, 0x00]);

  function flush(): void {
    if (!pending) return;
    const delay = Math.max(2, Math.min(65535, Math.round(pending.delay)));
    // Disposal 1 (keep the frame), so later frames only paint what changed.
    write([0x21, 0xf9, 0x04, (1 << 2) | (pending.transparent ? 1 : 0), delay & 255, delay >> 8, pending.transparent ? TRANSPARENT : 0, 0x00]);
    chunks.push(pending.body);
    pending = null;
  }

  function quantize(rgba: Uint8Array, changed: Uint8Array, box: { x: number; y: number; w: number; h: number }) {
    const count = new Uint32Array(32768);
    const sumR = new Float64Array(32768);
    const sumG = new Float64Array(32768);
    const sumB = new Float64Array(32768);
    for (let y = box.y; y < box.y + box.h; y += 1) {
      for (let x = box.x; x < box.x + box.w; x += 1) {
        const p = y * width + x;
        if (!changed[p]) continue;
        const i = p * 4;
        const bin = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
        count[bin] += 1;
        sumR[bin] += rgba[i];
        sumG[bin] += rgba[i + 1];
        sumB[bin] += rgba[i + 2];
      }
    }
    const bins: number[] = [];
    for (let bin = 0; bin < 32768; bin += 1) if (count[bin]) bins.push(bin);
    const boxes: number[][] = [bins];
    const channel = (bin: number, axis: number) => (axis === 0 ? bin >> 10 : axis === 1 ? (bin >> 5) & 31 : bin & 31);
    while (boxes.length < 255) {
      let pick = -1;
      let best = 0;
      let pickAxis = 0;
      for (let b = 0; b < boxes.length; b += 1) {
        const items = boxes[b];
        if (items.length < 2) continue;
        let weight = 0;
        const min = [31, 31, 31];
        const max = [0, 0, 0];
        for (const bin of items) {
          weight += count[bin];
          for (let axis = 0; axis < 3; axis += 1) {
            const v = channel(bin, axis);
            if (v < min[axis]) min[axis] = v;
            if (v > max[axis]) max[axis] = v;
          }
        }
        const ranges = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
        const axis = ranges[1] >= ranges[0] && ranges[1] >= ranges[2] ? 1 : ranges[0] >= ranges[2] ? 0 : 2;
        const score = ranges[axis] * Math.sqrt(weight) + items.length * 1e-6;
        if (score > best) {
          best = score;
          pick = b;
          pickAxis = axis;
        }
      }
      if (pick < 0) break;
      const items = boxes[pick].sort((a, b) => channel(a, pickAxis) - channel(b, pickAxis));
      let total = 0;
      for (const bin of items) total += count[bin];
      let acc = 0;
      let cut = 1;
      for (; cut < items.length; cut += 1) {
        acc += count[items[cut - 1]];
        if (acc * 2 >= total) break;
      }
      boxes.splice(pick, 1, items.slice(0, cut), items.slice(cut));
    }
    const palette = new Uint8Array(768);
    const lookup = new Uint8Array(32768);
    boxes.forEach((items, index) => {
      let n = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (const bin of items) {
        n += count[bin];
        r += sumR[bin];
        g += sumG[bin];
        b += sumB[bin];
        lookup[bin] = index;
      }
      if (n) {
        palette[index * 3] = Math.round(r / n);
        palette[index * 3 + 1] = Math.round(g / n);
        palette[index * 3 + 2] = Math.round(b / n);
      }
    });
    return { palette, lookup };
  }

  function lzw(indices: Uint8Array): number[] {
    const out: number[] = [];
    const clearCode = 256;
    const eoiCode = 257;
    let nextCode = 258;
    let codeSize = 9;
    let bits = 0;
    let bitCount = 0;
    const emit = (code: number) => {
      bits |= code << bitCount;
      bitCount += codeSize;
      while (bitCount >= 8) {
        out.push(bits & 255);
        bits >>>= 8;
        bitCount -= 8;
      }
    };
    generation += 1;
    emit(clearCode);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i += 1) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      if (stamps[key] === generation) {
        prefix = codes[key];
        continue;
      }
      emit(prefix);
      if (nextCode === 4096) {
        emit(clearCode);
        nextCode = 258;
        codeSize = 9;
        generation += 1;
      } else {
        if (nextCode >= 1 << codeSize) codeSize += 1;
        codes[key] = nextCode;
        stamps[key] = generation;
        nextCode += 1;
      }
      prefix = k;
    }
    emit(prefix);
    emit(eoiCode);
    if (bitCount > 0) out.push(bits & 255);
    return out;
  }

  function addFrame(rgba: Uint8Array, delayCs: number): void {
    if (finished) throw new Error("The GIF is already finished.");
    if (rgba.length !== width * height * 4) throw new Error(`A frame must be ${width}x${height}.`);
    const changed = new Uint8Array(width * height);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const p = y * width + x;
        const i = p * 4;
        if (
          reference &&
          Math.abs(rgba[i] - reference[i]) <= TOLERANCE &&
          Math.abs(rgba[i + 1] - reference[i + 1]) <= TOLERANCE &&
          Math.abs(rgba[i + 2] - reference[i + 2]) <= TOLERANCE
        ) {
          continue;
        }
        changed[p] = 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) {
      if (pending) pending.delay += delayCs;
      return;
    }
    flush();
    const box = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    const { palette, lookup } = quantize(rgba, changed, box);
    const indices = new Uint8Array(box.w * box.h);
    let transparent = false;
    if (!reference) reference = new Uint8Array(rgba.length);
    for (let y = 0; y < box.h; y += 1) {
      for (let x = 0; x < box.w; x += 1) {
        const p = (box.y + y) * width + box.x + x;
        const i = p * 4;
        if (!changed[p]) {
          indices[y * box.w + x] = TRANSPARENT;
          transparent = true;
          continue;
        }
        indices[y * box.w + x] = lookup[((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3)];
        reference[i] = rgba[i];
        reference[i + 1] = rgba[i + 1];
        reference[i + 2] = rgba[i + 2];
      }
    }
    const data = lzw(indices);
    const body: number[] = [0x2c, ...u16(box.x), ...u16(box.y), ...u16(box.w), ...u16(box.h), 0x80 | 0x07];
    for (let i = 0; i < 768; i += 1) body.push(palette[i]);
    body.push(8);
    for (let i = 0; i < data.length; i += 255) {
      const block = data.slice(i, i + 255);
      body.push(block.length);
      for (const byte of block) body.push(byte);
    }
    body.push(0);
    pending = { delay: delayCs, transparent, body: Uint8Array.from(body) };
  }

  function finish(): Uint8Array {
    if (!finished) {
      flush();
      write([0x3b]);
      finished = true;
    }
    let size = 0;
    for (const chunk of chunks) size += chunk.length;
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  return { addFrame, finish };
}
