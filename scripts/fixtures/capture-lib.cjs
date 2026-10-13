"use strict";
// Shared by the capture suites: the capture modules bundled for Node (no
// Electron, Codara's home in a temp folder), a PNG codec standing in for
// nativeImage, and a small GIF decoder that checks what the encoder wrote.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..", "..");

async function loadCaptureLib() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codara-capture-home-"));
  const out = await esbuild.build({
    stdin: {
      contents: `
        export * from "./screenshot";
        export * from "./diff";
        export * from "./capture/bitmap";
        export * from "./capture/codec";
        export * from "./capture/sizes";
        export * from "./capture/compare";
        export * from "./record/gif-encoder";
        export * from "./record/gif-worker";
        export * from "./record/ffmpeg";
        export * from "./record/recorder";
        export * from "./capture/paint";
        export * from "./locator";
        export * from "./cdp-session";
        export { applyEmulation, currentEmulation, holdEmulation } from "./emulation";
        export { evaluateOverCdp } from "./targets";
      `,
      resolveDir: path.join(ROOT, "src/main/browser"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    // As the app's main bundle is: the GIF worker runs the encoder's
    // stringified source, which must survive minification.
    minify: true,
    plugins: [{
      name: "home",
      setup(build) {
        build.onResolve({ filter: /codara-home$/ }, () => ({ path: "codara-home", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: `module.exports = { codaraHome: () => ${JSON.stringify(home)} };`,
          loader: "js",
        }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return { lib: mod.exports, home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

// A minimal PNG codec (8-bit RGB or RGBA, not interlaced), which covers
// Chromium's captures and everything the capture modules write.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(bitmap) {
  const { width, height } = bitmap;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    Buffer.from(bitmap.data.buffer, bitmap.data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function decodePng(buffer) {
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  for (let at = 8; at < buffer.length; ) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString("latin1", at + 4, at + 8);
    const data = buffer.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, color, , , interlace] = data.subarray(8, 13);
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace) throw new Error(`unsupported PNG (depth ${depth}, color ${color})`);
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idat.push(data);
    }
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? rows[y * stride + x - channels] : 0;
      const up = y ? rows[(y - 1) * stride + x] : 0;
      const corner = y && x >= channels ? rows[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - corner);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      rows[y * stride + x] = value & 255;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    data[p * 4] = rows[p * channels];
    data[p * 4 + 1] = rows[p * channels + 1];
    data[p * 4 + 2] = rows[p * channels + 2];
    data[p * 4 + 3] = channels === 4 ? rows[p * channels + 3] : 255;
  }
  return { width, height, data };
}

/** The bitmap codec of the capture modules, PNG only. */
const pngBitmapCodec = {
  decode: decodePng,
  async encode(bitmap, format) {
    if (format !== "png") throw new Error(`the test codec only writes png, not ${format}`);
    return encodePng(bitmap);
  },
};

/** The screenshot pipeline's codec over that PNG codec and the capture bitmap operations. */
function pngImageCodec(lib) {
  return {
    size: (buffer) => {
      const { width, height } = decodePng(buffer);
      return { width, height };
    },
    crop: (buffer, rect) => encodePng(lib.cropBitmap(decodePng(buffer), rect)),
    resize: (buffer, size) => encodePng(lib.scaleBitmap(decodePng(buffer), size)),
    encode: (buffer, format) => {
      if (format !== "png") throw new Error(`the test codec only writes png, not ${format}`);
      return buffer;
    },
  };
}

function lzwDecode(bytes, minCodeSize, count) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let size;
  let next;
  let dict;
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i += 1) dict[i] = [i];
    dict[clear] = [];
    dict[eoi] = null;
    next = eoi + 1;
    size = minCodeSize + 1;
  };
  reset();
  const out = [];
  let bit = 0;
  let previous = null;
  while (bit + size <= bytes.length * 8) {
    let code = 0;
    for (let i = 0; i < size; i += 1, bit += 1) code |= ((bytes[bit >> 3] >> (bit & 7)) & 1) << i;
    if (code === clear) {
      reset();
      previous = null;
      continue;
    }
    if (code === eoi) break;
    let entry;
    if (code < next && dict[code]) entry = dict[code];
    else if (code === next && previous) entry = [...previous, previous[0]];
    else throw new Error(`bad LZW code ${code} (next ${next})`);
    for (const value of entry) out.push(value);
    if (previous && next < 4096) {
      dict[next] = [...previous, entry[0]];
      next += 1;
      if (next === 1 << size && size < 12) size += 1;
    }
    previous = entry;
  }
  if (out.length < count) throw new Error(`LZW stream ended after ${out.length} of ${count} pixels`);
  return out.slice(0, count);
}

/** Decode an animated GIF into full RGBA frames, honoring transparency and disposal 1. */
function decodeGif(buffer) {
  if (buffer.toString("ascii", 0, 6) !== "GIF89a") throw new Error("not a GIF89a");
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  let p = 13;
  if (buffer[10] & 0x80) p += 3 * (1 << ((buffer[10] & 7) + 1));
  const canvas = new Uint8Array(width * height * 4);
  const frames = [];
  let control = null;
  let loops = false;
  while (p < buffer.length) {
    const block = buffer[p++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = buffer[p++];
      if (label === 0xf9) {
        control = { disposal: (buffer[p + 1] >> 2) & 7, transparent: (buffer[p + 1] & 1) === 1, delay: buffer.readUInt16LE(p + 2), index: buffer[p + 4] };
      } else if (label === 0xff && buffer.toString("ascii", p + 1, p + 12) === "NETSCAPE2.0") {
        loops = true;
      }
      while (buffer[p]) p += buffer[p] + 1;
      p += 1;
      continue;
    }
    if (block !== 0x2c) throw new Error(`unexpected block 0x${block.toString(16)} at ${p - 1}`);
    const left = buffer.readUInt16LE(p);
    const top = buffer.readUInt16LE(p + 2);
    const w = buffer.readUInt16LE(p + 4);
    const h = buffer.readUInt16LE(p + 6);
    const packed = buffer[p + 8];
    p += 9;
    if (!(packed & 0x80)) throw new Error("frame without a local color table");
    const entries = 1 << ((packed & 7) + 1);
    const table = buffer.subarray(p, p + entries * 3);
    p += entries * 3;
    const minCodeSize = buffer[p++];
    const data = [];
    while (buffer[p]) {
      for (const byte of buffer.subarray(p + 1, p + 1 + buffer[p])) data.push(byte);
      p += buffer[p] + 1;
    }
    p += 1;
    const indices = lzwDecode(data, minCodeSize, w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const index = indices[y * w + x];
        if (control && control.transparent && index === control.index) continue;
        const o = ((top + y) * width + left + x) * 4;
        canvas[o] = table[index * 3];
        canvas[o + 1] = table[index * 3 + 1];
        canvas[o + 2] = table[index * 3 + 2];
        canvas[o + 3] = 255;
      }
    }
    frames.push({ delay: control ? control.delay : 0, box: { left, top, width: w, height: h }, rgba: canvas.slice() });
    control = null;
  }
  return { width, height, loops, frames };
}

function pixel(image, x, y) {
  const i = (y * image.width + x) * 4;
  const data = image.data ?? image.rgba;
  return [data[i], data[i + 1], data[i + 2]];
}

function near(actual, expected, tolerance = 8) {
  return actual.every((value, i) => Math.abs(value - expected[i]) <= tolerance);
}

module.exports = { ROOT, loadCaptureLib, encodePng, decodePng, pngBitmapCodec, pngImageCodec, decodeGif, pixel, near };
