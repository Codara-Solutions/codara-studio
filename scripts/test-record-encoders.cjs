"use strict";
// The recording encoders without a browser: the GIF encoder on content that
// is hard for 256 colors (a dark gradient beside a photo-like texture), its
// temporal stability (a still area never changes from frame to frame,
// dithered or not), exact colors for UI frames, the worker's own PNG decoding
// and fitting, GIF delay rounding, and the MP4 and WebM containers parsed
// back box by box and element by element. Real encoders and players are
// covered by tests/e2e/preview-record-quality.spec.ts.
//
//   node scripts/test-record-encoders.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { loadCaptureLib, encodePng, decodeGif } = require("./fixtures/capture-lib.cjs");

/** A dark radial gradient on the left (one level apart, the worst case for banding), a noisy, colorful texture on the right. */
function hardFrame(width, height, seed = 1) {
  const data = new Uint8Array(width * height * 4);
  let state = seed;
  const noise = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (x < width / 2) {
        const d = Math.hypot(x - width * 0.15, y - height * 0.2) / (width * 0.6);
        const t = Math.max(0, 1 - d);
        data.set([Math.round(4 + 40 * t), Math.round(6 + 48 * t), Math.round(14 + 84 * t), 255], i);
      } else {
        const r = 128 + 100 * Math.sin(x / 9) + 30 * noise();
        const g = 110 + 90 * Math.sin(y / 7 + x / 30) + 30 * noise();
        const b = 90 + 80 * Math.cos((x + y) / 11) + 30 * noise();
        data.set([r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v)))).concat(255), i);
      }
    }
  }
  return data;
}

/** Per 8x8 block, the largest channel error of the block's mean: what the eye sees of dithering, where banding stays visible. */
function blockErrors(a, b, width, height, x0, x1) {
  const errors = [];
  for (let by = 0; by + 8 <= height; by += 8) {
    for (let bx = x0; bx + 8 <= x1; bx += 8) {
      let worst = 0;
      for (let c = 0; c < 3; c += 1) {
        let sum = 0;
        for (let y = by; y < by + 8; y += 1) for (let x = bx; x < bx + 8; x += 1) sum += a[(y * width + x) * 4 + c] - b[(y * width + x) * 4 + c];
        worst = Math.max(worst, Math.abs(sum) / 64);
      }
      errors.push(worst);
    }
  }
  return errors.sort((p, q) => p - q);
}

function compare(a, b, width, height, x0 = 0, x1 = width) {
  let total = 0;
  let worst = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        const error = Math.abs(a[(y * width + x) * 4 + c] - b[(y * width + x) * 4 + c]);
        total += error;
        worst = Math.max(worst, error);
      }
    }
  }
  const blocks = blockErrors(a, b, width, height, x0, x1);
  return { mean: total / ((x1 - x0) * height * 3), worst, blocks95: blocks[Math.floor(0.95 * (blocks.length - 1))], blocksWorst: blocks[blocks.length - 1] };
}

function gradientRoundTrip(lib) {
  const width = 320;
  const height = 160;
  const frame = hardFrame(width, height);
  const encode = (options) => {
    const encoder = lib.createGifEncoder(width, height, options);
    encoder.addFrame(frame.slice(), 10);
    return decodeGif(Buffer.from(encoder.finish())).frames[0].rgba;
  };
  const dithered = encode();
  const plain = encode({ dither: false });
  // The texture takes most of the 256 colors, so the gradient gets few, and
  // only dithering keeps its local averages. (The encoder before this one:
  // 95th percentile 6.1, worst block 15.6, texture mean error 17.4.)
  const gradient = compare(dithered, frame, width, height, 0, width / 2);
  const banded = compare(plain, frame, width, height, 0, width / 2);
  assert.ok(gradient.blocks95 <= 1.2, `the dark gradient keeps its local averages: no bands (${JSON.stringify(gradient)})`);
  assert.ok(gradient.blocksWorst <= 7, `even at its ends (${gradient.blocksWorst})`);
  assert.ok(gradient.worst <= 14, `no pixel strays far from its color (worst ${gradient.worst})`);
  assert.ok(gradient.blocks95 < banded.blocks95, `dithering beats plain mapping on a gradient (${gradient.blocks95.toFixed(2)} < ${banded.blocks95.toFixed(2)})`);
  const texture = compare(dithered, frame, width, height, width / 2, width);
  assert.ok(texture.mean <= 10, `the photo-like half stays close (${texture.mean.toFixed(2)})`);
}

function exactColors(lib) {
  // A UI frame: flat fills and a gray ramp, 256 colors in all.
  const width = 253;
  const height = 40;
  const frame = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) frame.set(y < 20 ? [x, x, x, 255] : [[16, 20, 24], [47, 111, 222], [255, 176, 46]][x % 3].concat(255), (y * width + x) * 4);
  }
  frame.set([16, 20, 24, 255], 0);
  const encoder = lib.createGifEncoder(width, height);
  encoder.addFrame(frame, 10);
  const decoded = decodeGif(Buffer.from(encoder.finish())).frames[0].rgba;
  assert.equal(compare(decoded, frame, width, height).worst, 0, "a frame with at most 256 colors is stored exactly");
}

function stillAreasStayStill(lib) {
  const width = 200;
  const height = 120;
  const a = hardFrame(width, height, 3);
  const box = { x: 20, y: 30, w: 24, h: 18 };
  const b = a.slice();
  for (let y = box.y; y < box.y + box.h; y += 1) for (let x = box.x; x < box.x + box.w; x += 1) b.set([230, 60, 90, 255], (y * width + x) * 4);
  const encoder = lib.createGifEncoder(width, height);
  encoder.addFrame(a, 10);
  encoder.addFrame(b, 10);
  encoder.addFrame(b.slice(), 10);
  encoder.addFrame(a.slice(), 10);
  const decoded = decodeGif(Buffer.from(encoder.finish()));
  assert.equal(decoded.frames.length, 3, "a repeated frame adds no image, only time");
  assert.deepEqual(decoded.frames.map((frame) => frame.delay), [10, 20, 10]);
  assert.deepEqual(decoded.frames[1].box, { left: box.x, top: box.y, width: box.w, height: box.h }, "only what changed is stored");
  const outside = (x, y) => x < box.x || x >= box.x + box.w || y < box.y || y >= box.y + box.h;
  for (const [index, frame] of decoded.frames.entries()) {
    let moved = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!outside(x, y)) continue;
        const i = (y * width + x) * 4;
        if (frame.rgba[i] !== decoded.frames[0].rgba[i] || frame.rgba[i + 1] !== decoded.frames[0].rgba[i + 1] || frame.rgba[i + 2] !== decoded.frames[0].rgba[i + 2]) moved += 1;
      }
    }
    assert.equal(moved, 0, `frame ${index}: dithered still areas do not shimmer`);
  }
  const restored = compare(decoded.frames[2].rgba, a, width, height, box.x, box.x + box.w);
  assert.ok(restored.mean <= 6, "the area comes back when the change goes away");
}

/** An RGB PNG whose rows use every filter type, as other encoders write them. */
function filteredPng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const filter = y % 5;
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x += 1) {
      const value = rgb[y * stride + x];
      const left = x >= 3 ? rgb[y * stride + x - 3] : 0;
      const up = y ? rgb[(y - 1) * stride + x] : 0;
      const corner = y && x >= 3 ? rgb[(y - 1) * stride + x - 3] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - corner);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      raw[y * (stride + 1) + 1 + x] = (value - predicted) & 255;
    }
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function worker(lib, dir) {
  const width = 37;
  const height = 21;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < rgb.length; i += 1) rgb[i] = (i * 37 + (i % 7) * 11) & 255;
  const decoded = lib.decodePngRgba(filteredPng(width, height, rgb), (data) => zlib.inflateSync(data));
  assert.deepEqual([decoded.width, decoded.height], [width, height]);
  for (let p = 0; p < width * height; p += 1) {
    assert.deepEqual([...decoded.data.subarray(p * 4, p * 4 + 4)], [rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2], 255], `pixel ${p} of a filtered RGB PNG`);
  }
  assert.throws(() => lib.decodePngRgba(Buffer.from("not a png"), zlib.inflateSync), /not a PNG/);

  // The worker reads PNG files itself and writes what the encoder writes in-thread.
  const a = hardFrame(64, 48, 5);
  const b = hardFrame(64, 48, 6);
  const fileA = path.join(dir, "a.png");
  fs.writeFileSync(fileA, encodePng({ width: 64, height: 48, data: a }));
  const inThread = lib.createGifEncoder(64, 48);
  inThread.addFrame(a.slice(), 7);
  inThread.addFrame(b.slice(), 9);
  const thread = lib.startGifWorker(64, 48);
  await thread.addFrameFile(fileA, 7);
  await thread.addFrame(b, 9);
  assert.deepEqual(await thread.finish(), Buffer.from(inThread.finish()), "a PNG frame file encodes like its pixels");

  // A frame from after the viewport changed size is fitted, centered on white.
  const wide = path.join(dir, "wide.png");
  const red = new Uint8Array(128 * 24 * 4);
  for (let i = 0; i < red.length; i += 4) red.set([200, 30, 30, 255], i);
  fs.writeFileSync(wide, encodePng({ width: 128, height: 24, data: red }));
  const fitted = lib.startGifWorker(64, 48);
  await fitted.addFrameFile(wide, 10);
  const frame = decodeGif(await fitted.finish()).frames[0].rgba;
  const at = (x, y) => [...frame.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 3)];
  assert.deepEqual(at(32, 2), [255, 255, 255], "letterboxed above");
  assert.deepEqual(at(32, 24), [200, 30, 30], "scaled into the middle");
  const missing = lib.startGifWorker(8, 8);
  await assert.rejects(missing.addFrameFile(path.join(dir, "missing.png"), 10), /GIF encoding failed/);
  missing.terminate();
}

function timing(lib) {
  const delays = lib.gifDelays([33, 33, 34, 33, 33, 34, 1000]);
  assert.equal(delays.reduce((sum, d) => sum + d, 0), 120, "rounding does not drift over a run of frames");
  assert.ok(delays.slice(0, 6).every((d) => d === 3 || d === 4));
  assert.deepEqual(lib.imageSize(encodePng({ width: 33, height: 17, data: new Uint8Array(33 * 17 * 4) })), { width: 33, height: 17 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  assert.deepEqual(lib.imageSize(jpeg), { width: 800, height: 600 });
  assert.throws(() => lib.imageSize(Buffer.from("GIF89a")), /neither a PNG nor a JPEG/);
}

// --- containers -------------------------------------------------------------

const SAMPLES = [
  { ts: 0, dur: 33_333, key: true, size: 900 },
  { ts: 33_333, dur: 33_333, key: false, size: 120 },
  { ts: 66_666, dur: 33_334, key: false, size: 80 },
  // The page stood still for a while: nothing was recorded.
  { ts: 2_400_000, dur: 33_333, key: true, size: 700 },
  { ts: 2_433_333, dur: 1_000_000, key: false, size: 60 },
].map((sample, i) => ({ ...sample, data: Uint8Array.from({ length: sample.size }, (_, j) => (i * 31 + j) & 255) }));

function boxes(buffer, start = 0, end = buffer.length) {
  const out = [];
  for (let at = start; at < end; ) {
    const size = buffer.readUInt32BE(at);
    out.push({ type: buffer.toString("latin1", at + 4, at + 8), start: at, body: at + 8, end: at + size });
    at += size;
  }
  return out;
}

function child(buffer, parent, ...types) {
  let current = parent;
  for (const type of types) {
    // Sample entries and stsd carry fields before their children.
    const skip = current.type === "stsd" ? 8 : current.type === "avc1" ? 78 : 0;
    current = boxes(buffer, current.body + skip, current.end).find((entry) => entry.type === type);
    assert.ok(current, `box ${type}`);
  }
  return current;
}

async function mp4(lib, dir) {
  const out = path.join(dir, "out.mp4");
  const muxer = await lib.createMp4Muxer(out, path.join(dir, "mp4.body"));
  for (const sample of SAMPLES) await muxer.add({ data: sample.data, timestampUs: sample.ts, durationUs: sample.dur, key: sample.key });
  const description = Uint8Array.from([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68, 0xee]);
  await muxer.finish({ codec: "avc1.640028", width: 640, height: 400, description, colorSpace: { primaries: "smpte170m", transfer: "smpte170m", matrix: "smpte170m", fullRange: false } });
  assert.equal(fs.existsSync(path.join(dir, "mp4.body")), false, "the body file is gone");
  const file = fs.readFileSync(out);
  const top = boxes(file);
  assert.deepEqual(top.map((entry) => entry.type), ["ftyp", "moov", "mdat"], "the index comes first, so the file starts playing at once");
  assert.equal(top[2].end, file.length);
  const moov = top[1];
  const trak = child(file, moov, "trak");
  const tkhd = child(file, trak, "tkhd");
  assert.deepEqual([file.readUInt32BE(tkhd.end - 8) / 65536, file.readUInt32BE(tkhd.end - 4) / 65536], [640, 400]);
  const mdhd = child(file, trak, "mdia", "mdhd");
  const timescale = file.readUInt32BE(mdhd.body + 12);
  const stbl = child(file, trak, "mdia", "minf", "stbl");
  const avcC = child(file, stbl, "stsd", "avc1", "avcC");
  assert.deepEqual([...file.subarray(avcC.body, avcC.end)], [...description]);
  const colr = child(file, stbl, "stsd", "avc1", "colr");
  assert.deepEqual([file.toString("latin1", colr.body, colr.body + 4), file.readUInt16BE(colr.body + 4), file.readUInt16BE(colr.body + 8), file[colr.body + 10]], ["nclx", 6, 6, 0]);
  const stts = child(file, stbl, "stts");
  const deltas = [];
  for (let i = 0, n = file.readUInt32BE(stts.body + 4); i < n; i += 1) {
    const count = file.readUInt32BE(stts.body + 8 + i * 8);
    for (let k = 0; k < count; k += 1) deltas.push(file.readUInt32BE(stts.body + 12 + i * 8));
  }
  const expected = SAMPLES.map((sample, i) => Math.round(((i + 1 < SAMPLES.length ? SAMPLES[i + 1].ts : sample.ts + sample.dur) - sample.ts) * timescale / 1e6));
  for (const [i, delta] of deltas.entries()) assert.ok(Math.abs(delta - expected[i]) <= 1, `sample ${i} lasts its own time (${delta} vs ${expected[i]})`);
  assert.equal(file.readUInt32BE(mdhd.body + 16), deltas.reduce((sum, d) => sum + d, 0), "the track lasts its samples' total");
  const stss = child(file, stbl, "stss");
  assert.deepEqual([file.readUInt32BE(stss.body + 8), file.readUInt32BE(stss.body + 12)], [1, 4], "keyframes are sync samples");
  const stsz = child(file, stbl, "stsz");
  assert.deepEqual(SAMPLES.map((_, i) => file.readUInt32BE(stsz.body + 12 + i * 4)), SAMPLES.map((sample) => sample.size));
  const stco = child(file, stbl, "stco");
  const offset = file.readUInt32BE(stco.body + 8);
  assert.equal(offset, top[2].body, "the chunk offset points at the samples");
  assert.deepEqual(file.subarray(offset, top[2].end), Buffer.concat(SAMPLES.map((sample) => Buffer.from(sample.data))));

  const reordered = await lib.createMp4Muxer(path.join(dir, "bad.mp4"), path.join(dir, "bad.body"));
  await reordered.add({ data: new Uint8Array(4), timestampUs: 100, durationUs: 10, key: true });
  await assert.rejects(reordered.add({ data: new Uint8Array(4), timestampUs: 50, durationUs: 10, key: false }), /reordered/);
  await reordered.abort();
  assert.equal(fs.existsSync(path.join(dir, "bad.body")), false);
}

function readVint(buffer, at, keepMarker) {
  const first = buffer[at];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
  let value = keepMarker ? first : first & (0xff >> length);
  for (let i = 1; i < length; i += 1) value = value * 256 + buffer[at + i];
  return { value, length };
}

function elements(buffer, start, end) {
  const out = [];
  for (let at = start; at < end; ) {
    const id = readVint(buffer, at, true);
    const size = readVint(buffer, at + id.length, false);
    const body = at + id.length + size.length;
    out.push({ id: id.value, start: at, body, end: body + size.value });
    at = body + size.value;
  }
  return out;
}

const uintAt = (buffer, element) => {
  let value = 0;
  for (let i = element.body; i < element.end; i += 1) value = value * 256 + buffer[i];
  return value;
};

async function webm(lib, dir) {
  const out = path.join(dir, "out.webm");
  const muxer = await lib.createWebmMuxer(out, path.join(dir, "webm.body"));
  const samples = [...SAMPLES, { ts: 40_000_000, dur: 33_333, key: false, size: 50, data: new Uint8Array(50).fill(9) }];
  for (const sample of samples) await muxer.add({ data: sample.data, timestampUs: sample.ts, durationUs: sample.dur, key: sample.key });
  await muxer.finish({ codec: "vp09.00.41.08", width: 640, height: 400, colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: true } });
  const file = fs.readFileSync(out);
  const [header, segment] = elements(file, 0, file.length);
  assert.equal(header.id, 0x1a45dfa3);
  const docType = elements(file, header.body, header.end).find((entry) => entry.id === 0x4282);
  assert.equal(file.toString("latin1", docType.body, docType.end), "webm");
  assert.equal(segment.id, 0x18538067);
  assert.equal(segment.end, file.length, "the segment's size is the rest of the file");
  const children = elements(file, segment.body, segment.end);
  assert.deepEqual(children.slice(0, 4).map((entry) => entry.id), [0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1c53bb6b], "seek head, info, tracks and cues come first");
  for (const seek of elements(file, children[0].body, children[0].end)) {
    const [id, position] = elements(file, seek.body, seek.end);
    const target = children.find((entry) => entry.start === segment.body + uintAt(file, position));
    assert.ok(target, "a seek entry points at an element");
    assert.equal(readVint(file, id.body, true).value, target.id);
  }
  const info = elements(file, children[1].body, children[1].end);
  const duration = info.find((entry) => entry.id === 0x4489);
  assert.equal(file.readDoubleBE(duration.body), (40_000_000 + 33_333) / 1000);
  const track = elements(file, children[2].body, children[2].end)[0];
  const trackFields = elements(file, track.body, track.end);
  const codec = trackFields.find((entry) => entry.id === 0x86);
  assert.equal(file.toString("latin1", codec.body, codec.end), "V_VP9");
  const video = elements(file, trackFields.find((entry) => entry.id === 0xe0).body, trackFields.find((entry) => entry.id === 0xe0).end);
  assert.deepEqual([uintAt(file, video.find((entry) => entry.id === 0xb0)), uintAt(file, video.find((entry) => entry.id === 0xba))], [640, 400]);
  const colour = elements(file, video.find((entry) => entry.id === 0x55b0).body, video.find((entry) => entry.id === 0x55b0).end);
  assert.equal(uintAt(file, colour.find((entry) => entry.id === 0x55b9)), 2, "full range");
  const clusters = children.filter((entry) => entry.id === 0x1f43b675);
  assert.equal(clusters.length, 3, "a cluster per keyframe, and one more after a long gap");
  const blocks = [];
  for (const cluster of clusters) {
    const parts = elements(file, cluster.body, cluster.end);
    const base = uintAt(file, parts[0]);
    for (const block of parts.slice(1)) {
      blocks.push({ time: base + file.readInt16BE(block.body + 1), key: (file[block.body + 3] & 0x80) !== 0, size: block.end - block.body - 4 });
    }
  }
  assert.deepEqual(blocks.map((block) => block.time), samples.map((sample) => Math.round(sample.ts / 1000)));
  assert.deepEqual(blocks.map((block) => block.key), samples.map((sample) => sample.key));
  assert.deepEqual(blocks.map((block) => block.size), samples.map((sample) => sample.data.length));
  const cues = elements(file, children[3].body, children[3].end);
  assert.equal(cues.length, 2, "a cue for each cluster that starts with a keyframe");
  for (const cue of cues) {
    const positions = elements(file, cue.body, cue.end).find((entry) => entry.id === 0xb7);
    const position = elements(file, positions.body, positions.end).find((entry) => entry.id === 0xf1);
    assert.ok(clusters.some((cluster) => cluster.start === segment.body + uintAt(file, position)), "a cue points at its cluster");
  }
  assert.deepEqual(["avc1.640028", "vp09.00.41.08", "vp8"].map(lib.containerFor), ["mp4", "webm", "webm"]);
}

(async () => {
  const { lib, cleanup } = await loadCaptureLib();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-record-encoders-"));
  try {
    gradientRoundTrip(lib);
    exactColors(lib);
    stillAreasStayStill(lib);
    await worker(lib, dir);
    timing(lib);
    await mp4(lib, dir);
    await webm(lib, dir);
    console.log("record encoders: GIF banding, exact UI colors, no shimmer, worker PNG decoding and fitting, delays, MP4 and WebM containers");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
