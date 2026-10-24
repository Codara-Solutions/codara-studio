// Runs the GIF encoder on a worker thread, so encoding a long recording
// never stalls the main process (and with it every window and agent call).
// PNG frame files are read and decoded on the thread too; other frames come
// over already decoded. Each frame waits for the worker's ack, which keeps
// at most one decoded frame in flight however slow the encoder is.

import { Worker } from "node:worker_threads";

import { createGifEncoder } from "./gif-encoder";

/**
 * Decode an 8-bit, non-interlaced PNG (RGB or RGBA, what Chromium and
 * nativeImage write) to RGBA. Self-contained: it runs on the worker from
 * its source text.
 */
export function decodePngRgba(buffer: Uint8Array, inflate: (data: Uint8Array) => Uint8Array): { width: number; height: number; data: Uint8Array } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length < 8 || signature.some((byte, i) => buffer[i] !== byte)) throw new Error("A frame is not a PNG.");
  const u32 = (at: number) => ((buffer[at] << 24) | (buffer[at + 1] << 16) | (buffer[at + 2] << 8) | buffer[at + 3]) >>> 0;
  let width = 0;
  let height = 0;
  let channels = 0;
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let at = 8; at + 8 <= buffer.length; ) {
    const length = u32(at);
    const type = String.fromCharCode(buffer[at + 4], buffer[at + 5], buffer[at + 6], buffer[at + 7]);
    const data = buffer.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = u32(at + 8);
      height = u32(at + 12);
      const depth = data[8];
      const color = data[9];
      if (depth !== 8 || (color !== 2 && color !== 6) || data[12] !== 0) throw new Error(`Unsupported PNG frame (depth ${depth}, color ${color}).`);
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      parts.push(data);
      total += data.length;
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  if (!width || !height) throw new Error("A PNG frame has no header.");
  const compressed = new Uint8Array(total);
  for (let i = 0, offset = 0; i < parts.length; offset += parts[i].length, i += 1) compressed.set(parts[i], offset);
  const raw = inflate(compressed);
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("A PNG frame is truncated.");
  const out = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const prior = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start];
    for (let x = 0; x < stride; x += 1) {
      const value = raw[start + 1 + x];
      const left = x >= channels ? line[x - channels] : 0;
      const up = prior[x];
      if (filter === 0) line[x] = value;
      else if (filter === 1) line[x] = value + left;
      else if (filter === 2) line[x] = value + up;
      else if (filter === 3) line[x] = value + ((left + up) >> 1);
      else {
        const corner = x >= channels ? prior[x - channels] : 0;
        const p = left + up - corner;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - corner);
        line[x] = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : corner);
      }
    }
    const row = y * width * 4;
    if (channels === 4) out.set(line, row);
    else {
      for (let x = 0, o = row; x < width; x += 1, o += 4) {
        out[o] = line[x * 3];
        out[o + 1] = line[x * 3 + 1];
        out[o + 2] = line[x * 3 + 2];
        out[o + 3] = 255;
      }
    }
    prior.set(line);
  }
  return { width, height, data: out };
}

/**
 * Fit an RGBA image into width x height, scaled down (box filtered) or up
 * (bilinear) to fit and centered on white: a frame from after the viewport
 * changed size. Self-contained, like decodePngRgba.
 */
export function fitRgba(src: { width: number; height: number; data: Uint8Array }, width: number, height: number): Uint8Array {
  if (src.width === width && src.height === height) return src.data;
  const scale = Math.min(width / src.width, height / src.height);
  const w = Math.max(1, Math.min(width, Math.round(src.width * scale)));
  const h = Math.max(1, Math.min(height, Math.round(src.height * scale)));
  const ox = (width - w) >> 1;
  const oy = (height - h) >> 1;
  const out = new Uint8Array(width * height * 4).fill(255);
  for (let y = 0; y < h; y += 1) {
    const y0 = (y * src.height) / h;
    const y1 = ((y + 1) * src.height) / h;
    for (let x = 0; x < w; x += 1) {
      const x0 = (x * src.width) / w;
      const x1 = ((x + 1) * src.width) / w;
      const o = ((oy + y) * width + ox + x) * 4;
      if (scale >= 1) {
        // Bilinear at the target pixel's center.
        const sx = Math.min(src.width - 1, Math.max(0, (x0 + x1) / 2 - 0.5));
        const sy = Math.min(src.height - 1, Math.max(0, (y0 + y1) / 2 - 0.5));
        const ix = Math.floor(sx);
        const iy = Math.floor(sy);
        const fx = sx - ix;
        const fy = sy - iy;
        const jx = Math.min(src.width - 1, ix + 1);
        const jy = Math.min(src.height - 1, iy + 1);
        for (let c = 0; c < 3; c += 1) {
          const a = src.data[(iy * src.width + ix) * 4 + c];
          const b = src.data[(iy * src.width + jx) * 4 + c];
          const d = src.data[(jy * src.width + ix) * 4 + c];
          const e = src.data[(jy * src.width + jx) * 4 + c];
          out[o + c] = Math.round((a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy);
        }
        continue;
      }
      // The average of the source pixels the target pixel covers.
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = Math.floor(y0); sy < Math.min(src.height, Math.ceil(y1)); sy += 1) {
        for (let sx = Math.floor(x0); sx < Math.min(src.width, Math.ceil(x1)); sx += 1) {
          const i = (sy * src.width + sx) * 4;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          n += 1;
        }
      }
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { readFileSync } = require("node:fs");
const { inflateSync } = require("node:zlib");
const createGifEncoder = (${createGifEncoder.toString()});
const decodePngRgba = (${decodePngRgba.toString()});
const fitRgba = (${fitRgba.toString()});
const encoder = createGifEncoder(workerData.width, workerData.height);
parentPort.on("message", (message) => {
  try {
    if (message.type === "file") {
      const image = decodePngRgba(readFileSync(message.path), (data) => inflateSync(data));
      encoder.addFrame(fitRgba(image, workerData.width, workerData.height), message.delayCs);
      parentPort.postMessage({ type: "ack" });
    } else if (message.type === "frame") {
      encoder.addFrame(new Uint8Array(message.data), message.delayCs);
      parentPort.postMessage({ type: "ack" });
    } else if (message.type === "finish") {
      const bytes = encoder.finish();
      parentPort.postMessage({ type: "done", bytes }, [bytes.buffer]);
    }
  } catch (error) {
    parentPort.postMessage({ type: "error", message: String(error && error.message || error) });
  }
});
`;

export interface GifWorker {
  /** An RGBA frame of the GIF's size. */
  addFrame(rgba: Uint8Array, delayCs: number): Promise<void>;
  /** A PNG frame file, read and decoded on the worker (fitted when its size differs). */
  addFrameFile(path: string, delayCs: number): Promise<void>;
  finish(): Promise<Buffer>;
  terminate(): void;
}

export function startGifWorker(width: number, height: number): GifWorker {
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { width, height } });
  let waiter: { resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
  let failure: Error | null = null;
  const fail = (error: Error) => {
    failure = error;
    waiter?.reject(error);
    waiter = null;
  };
  worker.on("message", (message: { type: string; bytes?: Uint8Array; message?: string }) => {
    if (message.type === "error") return fail(new Error(`GIF encoding failed: ${message.message}`));
    const current = waiter;
    waiter = null;
    current?.resolve(message.bytes);
  });
  worker.on("error", (error) => fail(error));
  worker.on("exit", (code) => {
    if (waiter) fail(new Error(`The GIF encoder stopped (exit ${code}).`));
  });
  const request = <T>(message: Record<string, unknown>, transfer: ArrayBuffer[] = []): Promise<T> => {
    if (failure) return Promise.reject(failure);
    return new Promise<T>((resolve, reject) => {
      waiter = { resolve: resolve as (value: unknown) => void, reject };
      worker.postMessage(message, transfer);
    });
  };
  return {
    async addFrame(rgba, delayCs) {
      const copy = rgba.slice();
      await request({ type: "frame", data: copy.buffer, delayCs }, [copy.buffer as ArrayBuffer]);
    },
    async addFrameFile(path, delayCs) {
      await request({ type: "file", path, delayCs });
    },
    async finish() {
      const bytes = await request<Uint8Array>({ type: "finish" });
      void worker.terminate();
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },
    terminate() {
      void worker.terminate();
    },
  };
}
