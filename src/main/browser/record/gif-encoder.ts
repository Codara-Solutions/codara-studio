// A streaming animated GIF encoder with no dependencies, tuned for screen
// recordings. Frames arrive lossless (PNG screencast frames), so a pixel that
// did not change is exactly equal to the one before: only the box that changed
// is stored, its unchanged pixels are transparent, and a still area never
// flickers however the palette moves.
//
// Each frame gets its own palette, built from the pixels that changed. A frame
// with at most 256 colors (most UI changes) keeps them exactly. Otherwise a
// variance-minimizing median cut over a 6-bit histogram picks the colors and
// two k-means passes refine them, and Floyd-Steinberg dithering spreads the
// rest of the error, so gradients and photos stay smooth instead of banding.
// Dithering skips high-contrast edges (text, borders), which stay crisp.
//
// createGifEncoder is stringified into a worker thread (gif-worker.ts), so
// it must reference nothing outside its own body: no imports, no module
// level helpers.

export interface GifEncoder {
  /** An RGBA frame of the encoder's size, shown for delayCs hundredths of a second. The encoder keeps the array. */
  addFrame(rgba: Uint8Array, delayCs: number): void;
  finish(): Uint8Array;
}

export interface GifEncoderOptions {
  /** Floyd-Steinberg dithering where a frame has more colors than its palette (default true). */
  dither?: boolean;
}

export function createGifEncoder(width: number, height: number, options: GifEncoderOptions = {}): GifEncoder {
  const dither = options.dither !== false;
  const pixels = width * height;
  // Channel weights for color distances: the eye is most sensitive to green.
  const WR = 3;
  const WG = 4;
  const WB = 2;
  // Luma steps between neighbours above which a pixel is an edge, mapped
  // without dithering.
  const EDGE = 28;
  // Per channel, the most error one pixel passes on.
  const MAX_ERROR = 40;
  // How much farther than its own nearest color a dithered pixel may land
  // (about six levels per channel) before it is mapped undithered.
  const FAR = (WR + WG + WB) * 6 * 6;
  // Luma steps (times eight) between neighbours below which a pixel counts as
  // smooth when the palette is chosen.
  const SMOOTH = 24;

  const chunks: Uint8Array[] = [];
  let finished = false;
  let previous: Uint32Array | null = null;
  let pending: { delay: number; transparent: number; body: Uint8Array } | null = null;
  const changed = new Uint8Array(pixels);

  // LZW codes by prefix code * 256 + next index, shared by every frame; a
  // generation stamp empties the table without refilling it.
  const codes = new Int32Array(4096 * 256);
  const stamps = new Uint32Array(4096 * 256);
  let generation = 0;

  // A 6-bit-per-channel histogram of the changed pixels, emptied after each
  // frame through the list of bins it touched.
  const HIST = 1 << 18;
  const histCount = new Uint32Array(HIST);
  const histR = new Float64Array(HIST);
  const histG = new Float64Array(HIST);
  const histB = new Float64Array(HIST);
  let used = new Int32Array(4096);

  // Nearest palette entry by color at 7 bits per channel, -1 when unknown.
  const nearestCache = new Int16Array(1 << 21);
  // Exact palette colors, open addressing: key rgb + 1 (0 is empty).
  const exactKeys = new Int32Array(1024);
  const exactIndex = new Int16Array(1024);

  // The palette of the frame being encoded, sorted by green.
  const palR = new Int32Array(256);
  const palG = new Int32Array(256);
  const palB = new Int32Array(256);
  let paletteSize = 0;

  const u16 = (value: number) => [value & 255, (value >> 8) & 255];
  const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));
  const write = (bytes: ArrayLike<number>) => chunks.push(Uint8Array.from(bytes));

  write([...ascii("GIF89a"), ...u16(width), ...u16(height), 0x00, 0x00, 0x00]);
  // Loop forever.
  write([0x21, 0xff, 0x0b, ...ascii("NETSCAPE2.0"), 0x03, 0x01, 0x00, 0x00, 0x00]);

  /** A growable byte buffer. */
  function bytes(initial: number) {
    let buffer = new Uint8Array(Math.max(64, initial));
    let length = 0;
    const ensure = (extra: number) => {
      if (length + extra <= buffer.length) return;
      let size = buffer.length * 2;
      while (size < length + extra) size *= 2;
      const next = new Uint8Array(size);
      next.set(buffer.subarray(0, length));
      buffer = next;
    };
    return {
      push(byte: number) {
        if (length === buffer.length) ensure(1);
        buffer[length++] = byte;
      },
      append(data: ArrayLike<number>) {
        ensure(data.length);
        buffer.set(data, length);
        length += data.length;
      },
      get length() {
        return length;
      },
      view: () => buffer.subarray(0, length),
    };
  }

  function flush(): void {
    if (!pending) return;
    const delay = Math.max(2, Math.min(65535, Math.round(pending.delay)));
    const hasTransparency = pending.transparent >= 0;
    // Disposal 1 (keep the frame), so later frames only paint what changed.
    write([0x21, 0xf9, 0x04, (1 << 2) | (hasTransparency ? 1 : 0), delay & 255, delay >> 8, hasTransparency ? pending.transparent : 0, 0x00]);
    chunks.push(pending.body);
    pending = null;
  }

  function weighted(r: number, g: number, b: number): number {
    return WR * r * r + WG * g * g + WB * b * b;
  }

  /** The palette entry nearest a color: palette sorted by green, searched outward from the color's green. */
  function nearest(r: number, g: number, b: number): number {
    let lo = 0;
    let hi = paletteSize;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (palG[mid] < g) lo = mid + 1;
      else hi = mid;
    }
    let best = -1;
    let bestDistance = Infinity;
    let up = lo;
    let down = lo - 1;
    while (up < paletteSize || down >= 0) {
      if (up < paletteSize) {
        const dg = palG[up] - g;
        if (WG * dg * dg >= bestDistance) up = paletteSize;
        else {
          const distance = weighted(palR[up] - r, dg, palB[up] - b);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = up;
          }
          up += 1;
        }
      }
      if (down >= 0) {
        const dg = palG[down] - g;
        if (WG * dg * dg >= bestDistance) down = -1;
        else {
          const distance = weighted(palR[down] - r, dg, palB[down] - b);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = down;
          }
          down -= 1;
        }
      }
    }
    return best;
  }

  /** nearest() through a cache at 7 bits per channel: close enough, as dithering carries the difference. */
  function nearestTo(r: number, g: number, b: number): number {
    const key = ((r >> 1) << 14) | ((g >> 1) << 7) | (b >> 1);
    let index = nearestCache[key];
    if (index < 0) {
      index = nearest(r, g, b);
      nearestCache[key] = index;
    }
    return index;
  }

  function exactLookup(rgb: number): number {
    let slot = Math.imul(rgb, 0x9e3779b1) >>> 22;
    for (;;) {
      const key = exactKeys[slot];
      if (key === 0) return -1;
      if (key === rgb + 1) return exactIndex[slot];
      slot = (slot + 1) & 1023;
    }
  }

  /** Install a palette (any order): sorts it by green and indexes its exact colors. */
  function setPalette(r: ArrayLike<number>, g: ArrayLike<number>, b: ArrayLike<number>, size: number): void {
    const order = Array.from({ length: size }, (_, i) => i).sort((x, y) => g[x] - g[y] || r[x] - r[y] || b[x] - b[y]);
    paletteSize = size;
    exactKeys.fill(0);
    for (let i = 0; i < size; i += 1) {
      const from = order[i];
      palR[i] = r[from];
      palG[i] = g[from];
      palB[i] = b[from];
      const rgb = (palR[i] << 16) | (palG[i] << 8) | palB[i];
      let slot = Math.imul(rgb, 0x9e3779b1) >>> 22;
      while (exactKeys[slot] !== 0 && exactKeys[slot] !== rgb + 1) slot = (slot + 1) & 1023;
      if (exactKeys[slot] === 0) {
        exactKeys[slot] = rgb + 1;
        exactIndex[slot] = i;
      }
    }
    nearestCache.fill(-1);
  }

  /** The distinct colors of the changed pixels, or null when there are more than `limit`. */
  function exactColors(rgba: Uint8Array, box: { x: number; y: number; w: number; h: number }, limit: number): number[] | null {
    const keys = new Int32Array(1024);
    const colors: number[] = [];
    for (let y = box.y; y < box.y + box.h; y += 1) {
      for (let p = y * width + box.x, end = p + box.w; p < end; p += 1) {
        if (!changed[p]) continue;
        const i = p * 4;
        const rgb = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
        let slot = Math.imul(rgb, 0x9e3779b1) >>> 22;
        for (;;) {
          const key = keys[slot];
          if (key === rgb + 1) break;
          if (key === 0) {
            if (colors.length === limit) return null;
            keys[slot] = rgb + 1;
            colors.push(rgb);
            break;
          }
          slot = (slot + 1) & 1023;
        }
      }
    }
    return colors;
  }

  /** Median cut over the histogram's bins, splitting the box with the most error where it drops most, then k-means. */
  function buildPalette(rgba: Uint8Array, box: { x: number; y: number; w: number; h: number }, maxColors: number): void {
    let usedCount = 0;
    for (let y = box.y; y < box.y + box.h; y += 1) {
      for (let p = y * width + box.x, end = p + box.w; p < end; p += 1) {
        if (!changed[p]) continue;
        const i = p * 4;
        const r = rgba[i];
        const g = rgba[i + 1];
        const b = rgba[i + 2];
        const bin = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
        if (histCount[bin] === 0) {
          if (usedCount === used.length) {
            const grown = new Int32Array(used.length * 2);
            grown.set(used);
            used = grown;
          }
          used[usedCount++] = bin;
        }
        // Smooth areas count more than busy ones: dithering hides a coarse
        // palette in texture, while a gradient short of colors shows bands
        // and loses its ends.
        const l = r * 2 + g * 5 + b;
        const right = p % width + 1 < width ? Math.abs(rgba[i + 4] * 2 + rgba[i + 5] * 5 + rgba[i + 6] - l) : 0;
        const down = p + width < pixels ? Math.abs(rgba[i + width * 4] * 2 + rgba[i + width * 4 + 1] * 5 + rgba[i + width * 4 + 2] - l) : 0;
        const activity = Math.max(right, down);
        const weight = activity < SMOOTH ? 4 : activity < SMOOTH * 4 ? 2 : 1;
        histCount[bin] += weight;
        histR[bin] += r * weight;
        histG[bin] += g * weight;
        histB[bin] += b * weight;
      }
    }
    const bins = used.subarray(0, usedCount);
    const scratch = new Int32Array(usedCount);
    // A box is a range of `bins`; its error is the weighted sum of squared
    // distances of its bins' means to the box mean.
    const starts: number[] = [0];
    const ends: number[] = [usedCount];
    const errors: number[] = [];
    const boxError = (start: number, end: number): number => {
      let n = 0;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let qr = 0;
      let qg = 0;
      let qb = 0;
      for (let k = start; k < end; k += 1) {
        const bin = bins[k];
        const c = histCount[bin];
        n += c;
        sr += histR[bin];
        sg += histG[bin];
        sb += histB[bin];
        qr += (histR[bin] * histR[bin]) / c;
        qg += (histG[bin] * histG[bin]) / c;
        qb += (histB[bin] * histB[bin]) / c;
      }
      if (end - start < 2 || n === 0) return 0;
      return WR * (qr - (sr * sr) / n) + WG * (qg - (sg * sg) / n) + WB * (qb - (sb * sb) / n);
    };
    errors.push(boxError(0, usedCount));
    const counts = new Int32Array(64);
    while (starts.length < maxColors) {
      let pick = -1;
      let worst = 0;
      for (let k = 0; k < starts.length; k += 1) {
        if (errors[k] > worst) {
          worst = errors[k];
          pick = k;
        }
      }
      if (pick < 0) break;
      const start = starts[pick];
      const end = ends[pick];
      // Split along the channel with the most error.
      let n = 0;
      const s = [0, 0, 0];
      const q = [0, 0, 0];
      for (let k = start; k < end; k += 1) {
        const bin = bins[k];
        const c = histCount[bin];
        n += c;
        s[0] += histR[bin];
        s[1] += histG[bin];
        s[2] += histB[bin];
        q[0] += (histR[bin] * histR[bin]) / c;
        q[1] += (histG[bin] * histG[bin]) / c;
        q[2] += (histB[bin] * histB[bin]) / c;
      }
      const spread = [WR * (q[0] - (s[0] * s[0]) / n), WG * (q[1] - (s[1] * s[1]) / n), WB * (q[2] - (s[2] * s[2]) / n)];
      const axis = spread[1] >= spread[0] && spread[1] >= spread[2] ? 1 : spread[0] >= spread[2] ? 0 : 2;
      const shift = axis === 0 ? 12 : axis === 1 ? 6 : 0;
      // Counting sort of the box's bins by their cell along that axis.
      counts.fill(0);
      for (let k = start; k < end; k += 1) counts[(bins[k] >> shift) & 63] += 1;
      for (let v = 0, total = 0; v < 64; v += 1) {
        const c = counts[v];
        counts[v] = total;
        total += c;
      }
      for (let k = start; k < end; k += 1) scratch[counts[(bins[k] >> shift) & 63]++] = bins[k];
      bins.set(scratch.subarray(0, end - start), start);
      // Cut where the two halves' error is least, between cells.
      let bestCut = -1;
      let bestError = Infinity;
      let ln = 0;
      const ls = [0, 0, 0];
      const lq = [0, 0, 0];
      for (let k = start; k < end - 1; k += 1) {
        const bin = bins[k];
        const c = histCount[bin];
        ln += c;
        ls[0] += histR[bin];
        ls[1] += histG[bin];
        ls[2] += histB[bin];
        lq[0] += (histR[bin] * histR[bin]) / c;
        lq[1] += (histG[bin] * histG[bin]) / c;
        lq[2] += (histB[bin] * histB[bin]) / c;
        if (((bins[k + 1] >> shift) & 63) === ((bin >> shift) & 63)) continue;
        const rn = n - ln;
        const left = WR * (lq[0] - (ls[0] * ls[0]) / ln) + WG * (lq[1] - (ls[1] * ls[1]) / ln) + WB * (lq[2] - (ls[2] * ls[2]) / ln);
        const rs0 = s[0] - ls[0];
        const rs1 = s[1] - ls[1];
        const rs2 = s[2] - ls[2];
        const right = WR * (q[0] - lq[0] - (rs0 * rs0) / rn) + WG * (q[1] - lq[1] - (rs1 * rs1) / rn) + WB * (q[2] - lq[2] - (rs2 * rs2) / rn);
        if (left + right < bestError) {
          bestError = left + right;
          bestCut = k + 1;
        }
      }
      if (bestCut < 0) {
        // Every bin sits in one cell along the axis: split by count instead.
        bestCut = start + ((end - start) >> 1);
      }
      starts[pick] = start;
      ends[pick] = bestCut;
      errors[pick] = boxError(start, bestCut);
      starts.push(bestCut);
      ends.push(end);
      errors.push(boxError(bestCut, end));
    }
    // Box means, then k-means over the bins.
    const size = starts.length;
    const r = new Float64Array(size);
    const g = new Float64Array(size);
    const b = new Float64Array(size);
    const n = new Float64Array(size);
    for (let k = 0; k < size; k += 1) {
      for (let j = starts[k]; j < ends[k]; j += 1) {
        const bin = bins[j];
        n[k] += histCount[bin];
        r[k] += histR[bin];
        g[k] += histG[bin];
        b[k] += histB[bin];
      }
    }
    const rounded = (sum: Float64Array, count: Float64Array, k: number) => Math.max(0, Math.min(255, Math.round(sum[k] / count[k])));
    const pr = new Int32Array(size);
    const pg = new Int32Array(size);
    const pb = new Int32Array(size);
    for (let k = 0; k < size; k += 1) {
      pr[k] = rounded(r, n, k);
      pg[k] = rounded(g, n, k);
      pb[k] = rounded(b, n, k);
    }
    let colors = size;
    for (let pass = 0; pass < 2; pass += 1) {
      setPalette(pr, pg, pb, colors);
      r.fill(0);
      g.fill(0);
      b.fill(0);
      n.fill(0);
      for (let j = 0; j < usedCount; j += 1) {
        const bin = bins[j];
        const c = histCount[bin];
        const k = nearest(histR[bin] / c, histG[bin] / c, histB[bin] / c);
        n[k] += c;
        r[k] += histR[bin];
        g[k] += histG[bin];
        b[k] += histB[bin];
      }
      colors = 0;
      for (let k = 0; k < paletteSize; k += 1) {
        if (!n[k]) continue;
        pr[colors] = rounded(r, n, k);
        pg[colors] = rounded(g, n, k);
        pb[colors] = rounded(b, n, k);
        colors += 1;
      }
    }
    setPalette(pr, pg, pb, colors);
    for (let j = 0; j < usedCount; j += 1) {
      const bin = bins[j];
      histCount[bin] = 0;
      histR[bin] = 0;
      histG[bin] = 0;
      histB[bin] = 0;
    }
  }

  function lzw(indices: Uint8Array, minCodeSize: number): Uint8Array {
    const out = bytes(indices.length >> 1);
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let nextCode = eoiCode + 1;
    let codeSize = minCodeSize + 1;
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
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
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
    return out.view();
  }

  /** Map the changed pixels of the box to the palette, dithering smooth areas. */
  function mapPixels(rgba: Uint8Array, box: { x: number; y: number; w: number; h: number }, transparent: number, exact: boolean): Uint8Array {
    const indices = new Uint8Array(box.w * box.h);
    const w = box.w;
    // Error carried into the current and the next row, per channel, offset by one.
    let curR = new Float32Array(w + 2);
    let curG = new Float32Array(w + 2);
    let curB = new Float32Array(w + 2);
    let nextR = new Float32Array(w + 2);
    let nextG = new Float32Array(w + 2);
    let nextB = new Float32Array(w + 2);
    const luma = (i: number) => (rgba[i] * 2 + rgba[i + 1] * 5 + rgba[i + 2]) >> 3;
    for (let y = 0; y < box.h; y += 1) {
      const fy = box.y + y;
      const reverse = (y & 1) === 1;
      for (let step = 0; step < w; step += 1) {
        const x = reverse ? w - 1 - step : step;
        const fx = box.x + x;
        const p = fy * width + fx;
        const out = y * w + x;
        if (!changed[p]) {
          indices[out] = transparent;
          continue;
        }
        const i = p * 4;
        const sr = rgba[i];
        const sg = rgba[i + 1];
        const sb = rgba[i + 2];
        const rgb = (sr << 16) | (sg << 8) | sb;
        if (exact) {
          indices[out] = exactLookup(rgb);
          continue;
        }
        const e = x + 1;
        let er = curR[e];
        let eg = curG[e];
        let eb = curB[e];
        let edge = !dither;
        if (!edge) {
          const l = luma(i);
          edge =
            (fx > 0 && Math.abs(luma(i - 4) - l) > EDGE) ||
            (fx + 1 < width && Math.abs(luma(i + 4) - l) > EDGE) ||
            (fy > 0 && Math.abs(luma(i - width * 4) - l) > EDGE) ||
            (fy + 1 < height && Math.abs(luma(i + width * 4) - l) > EDGE);
        }
        if (edge) {
          er = 0;
          eg = 0;
          eb = 0;
        }
        let index = -1;
        let vr = sr;
        let vg = sg;
        let vb = sb;
        const settled = er > -0.5 && er < 0.5 && eg > -0.5 && eg < 0.5 && eb > -0.5 && eb < 0.5;
        if (settled) index = exactLookup(rgb);
        if (index < 0) {
          vr = Math.max(0, Math.min(255, sr + er));
          vg = Math.max(0, Math.min(255, sg + eg));
          vb = Math.max(0, Math.min(255, sb + eb));
          index = nearestTo(vr, vg, vb);
        }
        if (!settled) {
          // Error that built up across a gap in the palette would jump to a
          // far color (a dot): map such a pixel undithered instead.
          const plain = nearestTo(sr, sg, sb);
          const far = weighted(palR[index] - sr, palG[index] - sg, palB[index] - sb);
          const near = weighted(palR[plain] - sr, palG[plain] - sg, palB[plain] - sb);
          if (far > near * 4 + FAR) {
            index = plain;
            vr = sr;
            vg = sg;
            vb = sb;
          }
        }
        indices[out] = index;
        if (edge) continue;
        // Floyd-Steinberg, mirrored on reversed rows.
        const dr = Math.max(-MAX_ERROR, Math.min(MAX_ERROR, vr - palR[index]));
        const dg = Math.max(-MAX_ERROR, Math.min(MAX_ERROR, vg - palG[index]));
        const db = Math.max(-MAX_ERROR, Math.min(MAX_ERROR, vb - palB[index]));
        if (dr === 0 && dg === 0 && db === 0) continue;
        const ahead = reverse ? e - 1 : e + 1;
        const behind = reverse ? e + 1 : e - 1;
        curR[ahead] += dr * 0.4375;
        curG[ahead] += dg * 0.4375;
        curB[ahead] += db * 0.4375;
        nextR[behind] += dr * 0.1875;
        nextG[behind] += dg * 0.1875;
        nextB[behind] += db * 0.1875;
        nextR[e] += dr * 0.3125;
        nextG[e] += dg * 0.3125;
        nextB[e] += db * 0.3125;
        nextR[ahead] += dr * 0.0625;
        nextG[ahead] += dg * 0.0625;
        nextB[ahead] += db * 0.0625;
      }
      [curR, nextR] = [nextR, curR];
      [curG, nextG] = [nextG, curG];
      [curB, nextB] = [nextB, curB];
      nextR.fill(0);
      nextG.fill(0);
      nextB.fill(0);
    }
    return indices;
  }

  function addFrame(rgba: Uint8Array, delayCs: number): void {
    if (finished) throw new Error("The GIF is already finished.");
    if (rgba.length !== pixels * 4) throw new Error(`A frame must be ${width}x${height}.`);
    const source = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
    const words = new Uint32Array(source.buffer, source.byteOffset, pixels);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    if (previous) {
      for (let y = 0; y < height; y += 1) {
        let rowMin = -1;
        let rowMax = -1;
        for (let p = y * width, x = 0; x < width; x += 1, p += 1) {
          // Alpha is ignored: a GIF frame is opaque.
          if ((words[p] ^ previous[p]) & 0x00ffffff) {
            changed[p] = 1;
            if (rowMin < 0) rowMin = x;
            rowMax = x;
          } else {
            changed[p] = 0;
          }
        }
        if (rowMin < 0) continue;
        if (rowMin < minX) minX = rowMin;
        if (rowMax > maxX) maxX = rowMax;
        if (y < minY) minY = y;
        maxY = y;
      }
    } else {
      changed.fill(1);
      minX = 0;
      minY = 0;
      maxX = width - 1;
      maxY = height - 1;
    }
    previous = words;
    if (maxX < 0) {
      if (pending) pending.delay += delayCs;
      return;
    }
    flush();
    const box = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    let needsTransparency = false;
    for (let y = box.y; y < box.y + box.h && !needsTransparency; y += 1) {
      for (let p = y * width + box.x, end = p + box.w; p < end; p += 1) {
        if (!changed[p]) {
          needsTransparency = true;
          break;
        }
      }
    }
    const maxColors = needsTransparency ? 255 : 256;
    const colors = exactColors(source, box, maxColors);
    if (colors) {
      const r = colors.map((rgb) => rgb >> 16);
      const g = colors.map((rgb) => (rgb >> 8) & 255);
      const b = colors.map((rgb) => rgb & 255);
      setPalette(r, g, b, colors.length);
    } else {
      buildPalette(source, box, maxColors);
    }
    const transparent = needsTransparency ? paletteSize : -1;
    const entries = paletteSize + (needsTransparency ? 1 : 0);
    let tableBits = 1;
    while (1 << tableBits < entries) tableBits += 1;
    const indices = mapPixels(source, box, needsTransparency ? transparent : 0, colors !== null);
    const minCodeSize = Math.max(2, tableBits);
    const data = lzw(indices, minCodeSize);
    const body = bytes(data.length + data.length / 255 + 800);
    body.append([0x2c, ...u16(box.x), ...u16(box.y), ...u16(box.w), ...u16(box.h), 0x80 | (tableBits - 1)]);
    const table = new Uint8Array(3 << tableBits);
    for (let k = 0; k < paletteSize; k += 1) {
      table[k * 3] = palR[k];
      table[k * 3 + 1] = palG[k];
      table[k * 3 + 2] = palB[k];
    }
    body.append(table);
    body.push(minCodeSize);
    for (let i = 0; i < data.length; i += 255) {
      const block = data.subarray(i, i + 255);
      body.push(block.length);
      body.append(block);
    }
    body.push(0);
    pending = { delay: delayCs, transparent, body: body.view().slice() };
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
