// Containers for the encoded video of a recording: MP4 for H.264, WebM for
// VP9 and VP8. Samples are appended to a body file as they arrive, so memory
// holds the sample table only; finishing writes the index first (MP4's moov,
// WebM's cues) and then copies the body after it, so a player or a web page
// can start the file before it has all of it.
//
// Timestamps are variable: a frame lasts until the next one, as a page that
// paints nothing records no frames. Decode order must be presentation order
// (no B-frames), which is what the WebCodecs encoders produce.

import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { pipeline } from "node:stream/promises";

export interface VideoColorSpace {
  primaries?: string | null;
  transfer?: string | null;
  matrix?: string | null;
  fullRange?: boolean | null;
}

export interface VideoTrack {
  /** The WebCodecs codec string: avc1.* goes in MP4, vp09.* and vp8 in WebM. */
  codec: string;
  width: number;
  height: number;
  /** H.264's avcC record (the encoder's decoderConfig.description). */
  description?: Uint8Array;
  colorSpace?: VideoColorSpace;
}

export interface VideoSample {
  data: Uint8Array;
  timestampUs: number;
  durationUs: number;
  key: boolean;
}

export interface VideoMuxer {
  add(sample: VideoSample): Promise<void>;
  /** Write the file at `out`; the track is final by now (an H.264 description arrives with the first sample). */
  finish(track: VideoTrack): Promise<void>;
  /** Drop the body file of a muxer that will not finish. */
  abort(): Promise<void>;
}

export function containerFor(codec: string): "mp4" | "webm" {
  return codec.startsWith("avc1") ? "mp4" : "webm";
}

/** Code points of ITU-T H.273, as both containers spell colors. */
const PRIMARIES: Record<string, number> = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9, smpte432: 12 };
const TRANSFER: Record<string, number> = { bt709: 1, smpte170m: 6, linear: 8, "iec61966-2-1": 13, pq: 16, hlg: 18 };
const MATRIX: Record<string, number> = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, "bt2020-ncl": 9 };

function colorCodes(space?: VideoColorSpace): { primaries: number; transfer: number; matrix: number; fullRange: boolean } | null {
  const primaries = space?.primaries ? PRIMARIES[space.primaries] : undefined;
  const transfer = space?.transfer ? TRANSFER[space.transfer] : undefined;
  const matrix = space?.matrix ? MATRIX[space.matrix] : undefined;
  if (primaries === undefined || transfer === undefined || matrix === undefined) return null;
  return { primaries, transfer, matrix, fullRange: space?.fullRange === true };
}

interface StoredSample {
  size: number;
  timestampUs: number;
  durationUs: number;
  key: boolean;
}

/** The body file and sample table both containers share. */
async function sampleStore(bodyPath: string) {
  const handle = await fs.open(bodyPath, "w");
  const samples: StoredSample[] = [];
  let bytes = 0;
  let closed = false;
  return {
    samples,
    get bytes() {
      return bytes;
    },
    async append(data: Uint8Array): Promise<number> {
      const at = bytes;
      await handle.write(data, 0, data.length, at);
      bytes += data.length;
      return at;
    },
    record(sample: VideoSample) {
      const previous = samples[samples.length - 1];
      if (previous && sample.timestampUs <= previous.timestampUs) {
        throw new Error("The encoder reordered frames, which this recorder cannot store.");
      }
      samples.push({ size: sample.data.length, timestampUs: sample.timestampUs, durationUs: sample.durationUs, key: sample.key });
    },
    async close() {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}

/** Write `head`, then the body file's bytes, to `out`. */
async function assemble(out: string, head: Uint8Array, bodyPath: string): Promise<void> {
  const stream = createWriteStream(out);
  stream.write(head);
  await pipeline(createReadStream(bodyPath), stream);
}

// ---------------------------------------------------------------------------
// MP4

class Bytes {
  private parts: number[] = [];
  u8(value: number) {
    this.parts.push(value & 255);
    return this;
  }
  u16(value: number) {
    return this.u8(value >> 8).u8(value);
  }
  u32(value: number) {
    return this.u16(Math.floor(value / 65536) & 0xffff).u16(value & 0xffff);
  }
  bytes(values: ArrayLike<number>) {
    for (let i = 0; i < values.length; i += 1) this.parts.push(values[i] & 255);
    return this;
  }
  ascii(text: string) {
    for (const char of text) this.parts.push(char.charCodeAt(0));
    return this;
  }
  zeros(count: number) {
    for (let i = 0; i < count; i += 1) this.parts.push(0);
    return this;
  }
  get length() {
    return this.parts.length;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([new Bytes().u32(8 + body.length).ascii(type).done(), body]);
}

function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  return box(type, new Bytes().u8(version).u8(flags >> 16).u16(flags & 0xffff).done(), ...payload);
}

const IDENTITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
const MEDIA_TIMESCALE = 90_000;

function mp4Head(track: VideoTrack, samples: StoredSample[], bodyBytes: number): Uint8Array {
  if (!track.description?.length) throw new Error("The H.264 encoder gave no decoder configuration.");
  const now = Math.floor(Date.now() / 1000) + 2_082_844_800;
  const toMedia = (us: number) => Math.round((us * MEDIA_TIMESCALE) / 1_000_000);
  const first = samples[0].timestampUs;
  const starts = samples.map((sample) => toMedia(sample.timestampUs - first));
  const deltas = samples.map((sample, i) => Math.max(1, i + 1 < samples.length ? starts[i + 1] - starts[i] : toMedia(sample.durationUs)));
  const mediaDuration = deltas.reduce((sum, delta) => sum + delta, 0);
  const movieDuration = Math.round((mediaDuration * 1000) / MEDIA_TIMESCALE);

  const ftyp = box("ftyp", new Bytes().ascii("isom").u32(512).ascii("isomiso2avc1mp41").done());
  const matrix = new Bytes();
  for (const value of IDENTITY_MATRIX) matrix.u32(value);
  const mvhd = fullBox(
    "mvhd", 0, 0,
    new Bytes().u32(now).u32(now).u32(1000).u32(movieDuration).u32(0x00010000).u16(0x0100).zeros(10).bytes(matrix.done()).zeros(24).u32(2).done(),
  );
  const tkhd = fullBox(
    "tkhd", 0, 3,
    new Bytes().u32(now).u32(now).u32(1).zeros(4).u32(movieDuration).zeros(8).u16(0).u16(0).u16(0).zeros(2)
      .bytes(matrix.done()).u32(track.width * 65536).u32(track.height * 65536).done(),
  );
  const mdhd = fullBox("mdhd", 0, 0, new Bytes().u32(now).u32(now).u32(MEDIA_TIMESCALE).u32(mediaDuration).u16(0x55c4).u16(0).done());
  const hdlr = fullBox("hdlr", 0, 0, new Bytes().u32(0).ascii("vide").zeros(12).ascii("VideoHandler").u8(0).done());
  const vmhd = fullBox("vmhd", 0, 1, new Bytes().zeros(8).done());
  const dinf = box("dinf", fullBox("dref", 0, 0, new Bytes().u32(1).done(), fullBox("url ", 0, 1)));
  const colors = colorCodes(track.colorSpace);
  const colr = colors
    ? [box("colr", new Bytes().ascii("nclx").u16(colors.primaries).u16(colors.transfer).u16(colors.matrix).u8(colors.fullRange ? 0x80 : 0).done())]
    : [];
  const avc1 = box(
    "avc1",
    new Bytes().zeros(6).u16(1).zeros(16).u16(track.width).u16(track.height).u32(0x00480000).u32(0x00480000).u32(0).u16(1)
      .zeros(32).u16(0x0018).u16(0xffff).done(),
    box("avcC", track.description),
    ...colr,
  );
  const stsd = fullBox("stsd", 0, 0, new Bytes().u32(1).done(), avc1);
  const runs: Array<[number, number]> = [];
  for (const delta of deltas) {
    const last = runs[runs.length - 1];
    if (last && last[1] === delta) last[0] += 1;
    else runs.push([1, delta]);
  }
  const stts = new Bytes().u32(runs.length);
  for (const [count, delta] of runs) stts.u32(count).u32(delta);
  const keys = samples.flatMap((sample, i) => (sample.key ? [i + 1] : []));
  const stss = new Bytes().u32(keys.length);
  for (const key of keys) stss.u32(key);
  const stsz = new Bytes().u32(0).u32(samples.length);
  for (const sample of samples) stsz.u32(sample.size);
  const stsc = new Bytes().u32(1).u32(1).u32(samples.length).u32(1);
  // One chunk holds every sample, right after the mdat header; its offset
  // depends on the moov's own size, which the offset's value does not change.
  const stbl = (offset: number) =>
    box(
      "stbl",
      stsd,
      fullBox("stts", 0, 0, stts.done()),
      fullBox("stss", 0, 0, stss.done()),
      fullBox("stsc", 0, 0, stsc.done()),
      fullBox("stsz", 0, 0, stsz.done()),
      fullBox("stco", 0, 0, new Bytes().u32(1).u32(offset).done()),
    );
  const moov = (offset: number) =>
    box("moov", mvhd, box("trak", tkhd, box("mdia", mdhd, hdlr, box("minf", vmhd, dinf, stbl(offset)))));
  const mdatHeader = new Bytes().u32(8 + bodyBytes).ascii("mdat").done();
  const offset = ftyp.length + moov(0).length + mdatHeader.length;
  if (offset + bodyBytes > 0xffffffff) throw new Error("The recording is too large for an MP4 file.");
  return concat([ftyp, moov(offset), mdatHeader]);
}

export async function createMp4Muxer(out: string, bodyPath: string): Promise<VideoMuxer> {
  const store = await sampleStore(bodyPath);
  return {
    async add(sample) {
      store.record(sample);
      await store.append(sample.data);
    },
    async finish(track) {
      await store.close();
      if (!store.samples.length) throw new Error("The encoder produced no frames.");
      await assemble(out, mp4Head(track, store.samples, store.bytes), bodyPath);
      await fs.rm(bodyPath, { force: true });
    },
    async abort() {
      await store.close().catch(() => {});
      await fs.rm(bodyPath, { force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// WebM

function vintSize(size: number): Uint8Array {
  for (let length = 1; length <= 8; length += 1) {
    // All ones is reserved for "unknown size".
    if (size < 2 ** (7 * length) - 1) {
      const out = new Uint8Array(length);
      let value = size;
      for (let i = length - 1; i >= 0; i -= 1) {
        out[i] = value % 256;
        value = Math.floor(value / 256);
      }
      out[0] |= 1 << (8 - length);
      return out;
    }
  }
  throw new Error("An element is too large.");
}

function idBytes(id: number): Uint8Array {
  const out: number[] = [];
  for (let value = id; value > 0; value = Math.floor(value / 256)) out.unshift(value % 256);
  return Uint8Array.from(out);
}

function element(id: number, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([idBytes(id), vintSize(body.length), body]);
}

function uint(value: number, width?: number): Uint8Array {
  const out: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) out.unshift(rest % 256);
  while (out.length < (width ?? 1)) out.unshift(0);
  return Uint8Array.from(out);
}

function float64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
}

const text = (value: string) => Uint8Array.from(Array.from(value, (char) => char.charCodeAt(0)));

const EBML = {
  Header: 0x1a45dfa3, Version: 0x4286, ReadVersion: 0x42f7, MaxIDLength: 0x42f2, MaxSizeLength: 0x42f3,
  DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac,
  Info: 0x1549a966, TimestampScale: 0x2ad7b1, Duration: 0x4489, MuxingApp: 0x4d80, WritingApp: 0x5741,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5, TrackType: 0x83, FlagLacing: 0x9c,
  CodecID: 0x86, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, Colour: 0x55b0, MatrixCoefficients: 0x55b1,
  Range: 0x55b9, TransferCharacteristics: 0x55ba, Primaries: 0x55bb,
  Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7, CueClusterPosition: 0xf1,
  Cluster: 0x1f43b675, Timestamp: 0xe7, SimpleBlock: 0xa3,
};

/** A new cluster at each keyframe, and before a block's offset from its cluster outgrows 16 bits. */
const CLUSTER_SPAN_MS = 30_000;

export async function createWebmMuxer(out: string, bodyPath: string): Promise<VideoMuxer> {
  const store = await sampleStore(bodyPath);
  const clusters: Array<{ at: number; timeMs: number; cue: boolean }> = [];
  let cluster: { timeMs: number; blocks: Uint8Array[]; cue: boolean } | null = null;
  let first: number | null = null;
  const closeCluster = async () => {
    if (!cluster) return;
    const at = await store.append(element(EBML.Cluster, element(EBML.Timestamp, uint(cluster.timeMs)), ...cluster.blocks));
    clusters.push({ at, timeMs: cluster.timeMs, cue: cluster.cue });
    cluster = null;
  };
  return {
    async add(sample) {
      store.record(sample);
      first ??= sample.timestampUs;
      const timeMs = Math.round((sample.timestampUs - first) / 1000);
      if (!cluster || sample.key || timeMs - cluster.timeMs > CLUSTER_SPAN_MS) {
        await closeCluster();
        cluster = { timeMs, blocks: [], cue: sample.key };
      }
      const header = new Uint8Array([0x81, 0, 0, sample.key ? 0x80 : 0]);
      new DataView(header.buffer).setInt16(1, timeMs - cluster.timeMs);
      cluster.blocks.push(element(EBML.SimpleBlock, header, sample.data));
    },
    async finish(track) {
      await closeCluster();
      await store.close();
      if (!store.samples.length) throw new Error("The encoder produced no frames.");
      const last = store.samples[store.samples.length - 1];
      const durationMs = (last.timestampUs - store.samples[0].timestampUs + Math.max(1, last.durationUs)) / 1000;
      const colors = colorCodes(track.colorSpace);
      const video = element(
        EBML.Video,
        element(EBML.PixelWidth, uint(track.width)),
        element(EBML.PixelHeight, uint(track.height)),
        ...(colors
          ? [element(
            EBML.Colour,
            element(EBML.MatrixCoefficients, uint(colors.matrix)),
            element(EBML.Range, uint(colors.fullRange ? 2 : 1)),
            element(EBML.TransferCharacteristics, uint(colors.transfer)),
            element(EBML.Primaries, uint(colors.primaries)),
          )]
          : []),
      );
      const codecId = track.codec.startsWith("vp09") ? "V_VP9" : track.codec === "vp8" ? "V_VP8" : null;
      if (!codecId) throw new Error(`WebM cannot hold ${track.codec}.`);
      const info = element(
        EBML.Info,
        element(EBML.TimestampScale, uint(1_000_000)),
        element(EBML.Duration, float64(durationMs)),
        element(EBML.MuxingApp, text("Codara Studio")),
        element(EBML.WritingApp, text("Codara Studio")),
      );
      const tracks = element(
        EBML.Tracks,
        element(
          EBML.TrackEntry,
          element(EBML.TrackNumber, uint(1)),
          element(EBML.TrackUID, uint(1)),
          element(EBML.TrackType, uint(1)),
          element(EBML.FlagLacing, uint(0)),
          element(EBML.CodecID, text(codecId)),
          video,
        ),
      );
      // Positions are 8-byte numbers, so the index's size does not depend on them.
      const cues = (base: number) =>
        element(
          EBML.Cues,
          ...clusters.filter((entry) => entry.cue).map((entry) =>
            element(
              EBML.CuePoint,
              element(EBML.CueTime, uint(entry.timeMs)),
              element(EBML.CueTrackPositions, element(EBML.CueTrack, uint(1)), element(EBML.CueClusterPosition, uint(base + entry.at, 8))),
            )),
        );
      const seek = (id: number, position: number) => element(EBML.Seek, element(EBML.SeekID, idBytes(id)), element(EBML.SeekPosition, uint(position, 8)));
      const seekHead = (infoAt: number, tracksAt: number, cuesAt: number) =>
        element(EBML.SeekHead, seek(EBML.Info, infoAt), seek(EBML.Tracks, tracksAt), seek(EBML.Cues, cuesAt));
      const seekLength = seekHead(0, 0, 0).length;
      const infoAt = seekLength;
      const tracksAt = infoAt + info.length;
      const cuesAt = tracksAt + tracks.length;
      const clustersAt = cuesAt + cues(0).length;
      const segmentData = concat([seekHead(infoAt, tracksAt, cuesAt), info, tracks, cues(clustersAt)]);
      const header = element(
        EBML.Header,
        element(EBML.Version, uint(1)),
        element(EBML.ReadVersion, uint(1)),
        element(EBML.MaxIDLength, uint(4)),
        element(EBML.MaxSizeLength, uint(8)),
        element(EBML.DocType, text("webm")),
        element(EBML.DocTypeVersion, uint(4)),
        element(EBML.DocTypeReadVersion, uint(2)),
      );
      const segmentHead = concat([idBytes(EBML.Segment), vintSize(segmentData.length + store.bytes)]);
      await assemble(out, concat([header, segmentHead, segmentData]), bodyPath);
      await fs.rm(bodyPath, { force: true });
    },
    async abort() {
      await store.close().catch(() => {});
      await fs.rm(bodyPath, { force: true });
    },
  };
}
