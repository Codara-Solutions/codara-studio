// Encodes a recording's frames to a real video with Chromium's own WebCodecs
// encoder, so MP4 (H.264) and WebM (VP9) need nothing installed on any
// platform. The encoder runs in a hidden page of its own (a WebContentsView
// that is never shown, src/preload/record-encoder.ts) in its own renderer
// process: main only reads frame files, passes them over a private message
// port, and writes the encoded chunks into the container (video-mux.ts).
// Electron is required lazily so the recorder still loads in unit suites.

import { existsSync, promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { containerFor, createMp4Muxer, createWebmMuxer, type VideoColorSpace, type VideoMuxer, type VideoTrack } from "./video-mux";

export interface VideoFrameFile {
  file: string;
  /** When the frame shows, from the start of the recording. */
  atMs: number;
  durationMs: number;
}

export interface VideoEncodeJob {
  frames: VideoFrameFile[];
  size: { width: number; height: number };
  /** The container asked for; MP4 falls back to WebM where H.264 cannot be encoded. */
  format: "mp4" | "webm";
  fps: number;
  /** The output path without its extension. */
  outBase: string;
  /** A scratch folder for the encoder page and the container's body file. */
  workDir: string;
  onProgress?: (fraction: number) => void;
}

export interface VideoEncodeResult {
  path: string;
  format: "mp4" | "webm";
  codec: string;
  bytes: number;
  note?: string;
}

/**
 * A keyframe at least this often, so a player can seek. Screen content is
 * mostly still, so keyframes are most of a file; and Chromium's software
 * H.264 encoder (OpenH264, used on Linux) sharpens still areas frame after
 * frame until the next keyframe resets them.
 */
const KEYFRAME_EVERY_US = 5_000_000;
/** VP9's constant-quality level (0 best, 63 worst): sharp text at a fraction of a GIF's size. */
const VP9_QUANTIZER = 20;
/** A frame takes milliseconds; an encoder this slow to answer is stuck. */
const REPLY_TIMEOUT_MS = 20_000;

/** H.264 profiles and levels by size, best first: High, then Main, then Baseline. */
function avcCodecs(width: number, height: number): string[] {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const level = macroblocks <= 8192 ? "28" : macroblocks <= 22080 ? "32" : "33";
  return [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.4200${level}`];
}

function vp9Codecs(width: number, height: number): string[] {
  return [width * height <= 2_228_224 ? "vp09.00.41.08" : "vp09.00.51.08", "vp8"];
}

/**
 * Bits per second for H.264, which WebCodecs cannot encode at a constant
 * quality: 0.15 bit per pixel per frame is plenty for screen content on the
 * platform encoders (macOS, Windows) that follow it. OpenH264 picks its own
 * quality and stays far below it.
 */
export function videoBitrate(width: number, height: number, fps: number): number {
  return Math.round(Math.min(24_000_000, Math.max(2_000_000, width * height * Math.min(30, fps) * 0.15)));
}

function encoderPreload(): string {
  // This module may land in out/main/chunks; the preload is in out/preload.
  for (const dir of [__dirname, dirname(__dirname)]) {
    const candidate = join(dir, "..", "preload", "record-encoder.js");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("This Codara build has no video encoder.");
}

const PAGE = "<!doctype html><meta charset=\"utf-8\"><title>Codara recording encoder</title>";

type Reply =
  | { type: "opened"; codec: string }
  | { type: "unsupported" }
  | { type: "ack" }
  | { type: "flushed" }
  | { type: "error"; message: string }
  | { type: "chunk"; data: Uint8Array; timestampUs: number; durationUs: number; key: boolean; description?: Uint8Array; colorSpace?: VideoColorSpace };

/**
 * The encoder views and ports of encodes in progress. Nothing else refers to
 * them while main waits for a reply, and a collected view takes its page
 * (and the encode) with it.
 */
const live = new Set<unknown>();

export async function encodeVideo(job: VideoEncodeJob): Promise<VideoEncodeResult> {
  const { MessageChannelMain, WebContentsView } = require("electron") as typeof import("electron");
  if (!job.frames.length) throw new Error("There are no frames to encode.");
  // 4:2:0 video needs even sizes; a frame one pixel larger is cropped.
  const width = Math.max(2, job.size.width - (job.size.width % 2));
  const height = Math.max(2, job.size.height - (job.size.height % 2));
  const page = join(job.workDir, "encoder.html");
  await fs.writeFile(page, PAGE);
  const view = new WebContentsView({
    webPreferences: {
      preload: encoderPreload(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      partition: "record-encoder",
    },
  });
  const contents = view.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  const { port1, port2 } = new MessageChannelMain();
  live.add(view);
  live.add(port1);
  let muxer: VideoMuxer | null = null;
  let finished = false;
  try {
    let waiter: { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
    let failure: Error | null = null;
    const fail = (error: Error) => {
      failure ??= error;
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.reject(failure);
        waiter = null;
      }
    };
    contents.on("render-process-gone", (_event, details) => fail(new Error(`The video encoder stopped (${details.reason}).`)));
    const track: VideoTrack = { codec: "", width, height };
    let writes = Promise.resolve();
    port1.on("message", ({ data }: { data: Reply }) => {
      if (data.type === "chunk") {
        if (data.description) track.description = new Uint8Array(data.description);
        if (data.colorSpace) track.colorSpace = data.colorSpace;
        const sample = { data: new Uint8Array(data.data), timestampUs: data.timestampUs, durationUs: data.durationUs, key: data.key };
        writes = writes.then(() => muxer?.add(sample)).catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
        return;
      }
      if (data.type === "error") return fail(new Error(`Video encoding failed: ${data.message}`));
      const current = waiter;
      waiter = null;
      if (current) {
        clearTimeout(current.timer);
        current.resolve(data);
      }
    });
    port1.start();
    const request = (message: Record<string, unknown>): Promise<Reply> => {
      if (failure) return Promise.reject(failure);
      return new Promise<Reply>((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error("The video encoder stopped answering.")), REPLY_TIMEOUT_MS);
        waiter = { resolve, reject, timer };
        port1.postMessage(message);
      });
    };

    await contents.loadFile(page);
    contents.postMessage("record-encoder:port", null, [port2]);

    const open = (codecs: string[]) => request({ type: "open", codecs, width, height, fps: job.fps, bitrate: videoBitrate(width, height, job.fps), quantizer: VP9_QUANTIZER });
    let note: string | undefined;
    let reply = await open(job.format === "mp4" ? avcCodecs(width, height) : vp9Codecs(width, height));
    if (reply.type === "unsupported" && job.format === "mp4") {
      note = "This computer cannot encode H.264 video; saved a WebM instead.";
      reply = await open(vp9Codecs(width, height));
    }
    if (reply.type !== "opened") throw new Error("This computer has no video encoder Codara can use.");
    track.codec = reply.codec;
    const format = containerFor(reply.codec);
    const path = `${job.outBase}.${format}`;
    const body = join(job.workDir, `video.${format}.body`);
    muxer = format === "mp4" ? await createMp4Muxer(path, body) : await createWebmMuxer(path, body);

    // Frames sit on the grid of the recording's rate, so players and editors
    // read a 30 fps video with pauses rather than a 90 kHz one, and no frame
    // moves by more than half a frame. The recorder never samples faster.
    const step = 1_000_000 / job.fps;
    const start = job.frames[0].atMs;
    const slots: number[] = [];
    for (const frame of job.frames) {
      const slot = Math.round(((frame.atMs - start) * 1000) / step);
      slots.push(slots.length && slot <= slots[slots.length - 1] ? slots[slots.length - 1] + 1 : slot);
    }
    const last = job.frames[job.frames.length - 1];
    slots.push(slots[slots.length - 1] + Math.max(1, Math.round((last.durationMs * 1000) / step)));
    let lastKey = -Infinity;
    for (const [index, frame] of job.frames.entries()) {
      const timestampUs = Math.round(slots[index] * step);
      const durationUs = Math.round(slots[index + 1] * step) - timestampUs;
      const keyFrame = timestampUs - lastKey >= KEYFRAME_EVERY_US;
      if (keyFrame) lastKey = timestampUs;
      const data = await fs.readFile(frame.file);
      const mime = data[0] === 0x89 ? "image/png" : "image/jpeg";
      await request({ type: "frame", data, mime, timestampUs, durationUs, keyFrame });
      job.onProgress?.((index + 1) / job.frames.length);
    }
    const flushed = await request({ type: "flush" });
    if (flushed.type !== "flushed") throw new Error("The video encoder did not finish.");
    await writes;
    if (failure) throw failure;
    await muxer.finish(track);
    finished = true;
    const bytes = (await fs.stat(path)).size;
    return { path, format, codec: reply.codec, bytes, ...(note ? { note } : {}) };
  } finally {
    if (!finished) await muxer?.abort().catch(() => {});
    port1.close();
    if (!view.webContents.isDestroyed()) view.webContents.close();
    live.delete(port1);
    live.delete(view);
    await fs.rm(page, { force: true }).catch(() => {});
  }
}
