// Recording a browser flow to an MP4, WebM or GIF file. Frames come from the
// DevTools protocol's screencast, which the page sends whenever it paints, at
// the device's pixel density, so recording costs nothing while the page is
// still and text stays sharp on a HiDPI screen. A tab that sends no frames
// (hidden behind another tab, a minimized window) is captured with the
// target's background-safe viewport capture instead.
//
// Frames are sampled at most `fps` times a second (the newest frame wins,
// so the last state before a pause is never dropped) and written to disk
// as they arrive, lossless PNG for a GIF and JPEG for a video; memory holds
// one frame. Stopping encodes them off the main thread: video with
// Chromium's WebCodecs encoder in a hidden page (video-encoder.ts), with
// the user's ffmpeg as a fallback for WebM, and GIF on a worker thread.

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { workspaceDataDir } from "../../workspace-data";
import { browserArtifactDir, moveBrowserArtifact, writeBrowserArtifact } from "../artifacts";
import { blit, createBitmap, fitSize, scaleBitmap, type Bitmap } from "../capture/bitmap";
import type { BitmapCodec } from "../capture/codec";
import { holdGuestPaint } from "../capture/paint";
import type { CdpSession } from "../cdp-session";
import { encodeWebm, findFfmpeg } from "./ffmpeg";
import { startGifWorker } from "./gif-worker";
import type { VideoEncodeJob, VideoEncodeResult } from "./video-encoder";

export type RecordFormat = "gif" | "webm" | "mp4";

export interface RecordOptions {
  format: RecordFormat;
  /** Frames per second at most. */
  fps: number;
  /** The recording stops itself after this long. */
  maxSeconds: number;
  /** Frame width cap in pixels (device pixels: a HiDPI tab records sharper). */
  maxWidth: number;
}

/** The defaults when nothing is asked for: a GIF, which pastes anywhere. */
export const RECORD_DEFAULTS: RecordOptions = { format: "gif", fps: 15, maxSeconds: 30, maxWidth: 1280 };
/** Per format: a video is smooth and full size for little; a GIF grows with every pixel and frame. */
export const RECORD_FORMAT_DEFAULTS: Record<RecordFormat, Pick<RecordOptions, "fps" | "maxWidth">> = {
  gif: { fps: 15, maxWidth: 1280 },
  mp4: { fps: 30, maxWidth: 1920 },
  webm: { fps: 30, maxWidth: 1920 },
};
export const RECORD_MAX = { fps: 30, maxSeconds: 120, maxWidth: 2560 };
/** Frame files on disk per recording, a backstop under the time limit. */
export const RECORD_MAX_BYTES = 1024 * 1024 * 1024;
/** How long a final frame stays up before a GIF loops (and at the end of a video). */
const FINAL_FRAME_MS = 1_000;
/** Frame folders older than this belong to no running recording. */
const STALE_FRAMES_MS = 30 * 60 * 1000;
/** Without a screencast frame by then, the tab is not painting: capture it instead. */
const SCREENCAST_GRACE_MS = 700;
/** Direct captures run on the main process: at most this often. */
const POLL_EVERY_MS = 100;
/** JPEG quality of a video's frames: near lossless (PNG would be eight times the disk), so the video encoder decides what is lost. */
const VIDEO_FRAME_QUALITY = 95;
const PROGRESS_EVERY_MS = 150;

export class RecordOptionError extends Error {}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeRecordOptions(raw: Record<string, unknown>): RecordOptions {
  const format = raw.format === undefined ? RECORD_DEFAULTS.format : raw.format;
  if (format !== "gif" && format !== "webm" && format !== "mp4") throw new RecordOptionError('format must be "mp4", "webm" or "gif".');
  const fps = finite(raw.fps) ?? RECORD_FORMAT_DEFAULTS[format].fps;
  const maxSeconds = finite(raw.maxSeconds) ?? RECORD_DEFAULTS.maxSeconds;
  const maxWidth = finite(raw.maxWidth) ?? RECORD_FORMAT_DEFAULTS[format].maxWidth;
  if (fps < 1 || fps > RECORD_MAX.fps) throw new RecordOptionError(`fps must be between 1 and ${RECORD_MAX.fps}.`);
  if (maxSeconds < 1 || maxSeconds > RECORD_MAX.maxSeconds) {
    throw new RecordOptionError(`maxSeconds must be between 1 and ${RECORD_MAX.maxSeconds}.`);
  }
  if (maxWidth < 160 || maxWidth > RECORD_MAX.maxWidth) throw new RecordOptionError(`maxWidth must be between 160 and ${RECORD_MAX.maxWidth}.`);
  return { format, fps: Math.round(fps), maxSeconds, maxWidth: Math.round(maxWidth) };
}

/** What a recording needs from a tab: a BrowserTarget satisfies it. */
export interface RecordTarget {
  readonly ref: string;
  readonly session: CdpSession;
  readonly workspaceId: string | null;
  captureViewport(): Promise<Buffer>;
}

export type FrameFormat = "jpeg" | "png";

export interface RecordDeps {
  /** Decodes a frame the GIF worker cannot (a JPEG video frame, when a video falls back to a GIF). */
  codec: BitmapCodec;
  /** The frame files' format; by default PNG for a GIF, JPEG for a video. */
  frameFormat?: FrameFormat;
  /** A viewport capture (PNG) as a frame file's bytes, no wider than maxWidth. */
  frameFromPng(png: Buffer, maxWidth: number, format: FrameFormat): Promise<Buffer>;
  /** Encodes a video without ffmpeg (the app's WebCodecs encoder); absent in unit suites. */
  encodeVideo?: (job: VideoEncodeJob) => Promise<VideoEncodeResult>;
  ffmpeg?: () => string | null;
  /** Keeps a background tab painting for the whole recording; returns its release. */
  holdPaint?: (session: CdpSession) => Promise<() => void>;
}

export interface RecordingStatus {
  recording: true;
  tabId: string;
  format: RecordFormat;
  elapsedMs: number;
  frames: number;
  maxSeconds: number;
}

export const RECORD_MIME_TYPES = { gif: "image/gif", mp4: "video/mp4", webm: "video/webm" } as const;

export interface RecordingResult {
  recording: false;
  tabId: string;
  path: string;
  format: RecordFormat;
  mimeType: (typeof RECORD_MIME_TYPES)[RecordFormat];
  bytes: number;
  frames: number;
  durationMs: number;
  size: { width: number; height: number };
  fps: number;
  /** How long encoding took after the recording stopped. */
  encodeMs: number;
  /** Why it stopped on its own (time limit, tab closed), when it did. */
  stoppedBy?: string;
  note?: string;
}

export interface RecordingChange {
  key: string;
  tabId: string;
  recording: boolean;
  /** While a stopped recording encodes: how far along, 0 to 1. */
  progress?: number;
  result?: RecordingResult;
  error?: string;
}

interface Frame {
  file: string;
  at: number;
}

interface Recording {
  key: string;
  target: RecordTarget;
  options: RecordOptions;
  deps: RecordDeps;
  frameFormat: FrameFormat;
  startedAt: number;
  dir: string;
  frames: Frame[];
  bytes: number;
  latest: { data: Buffer; seq: number; at: number } | null;
  seq: number;
  written: number;
  lastWritten: Buffer | null;
  sawScreencast: boolean;
  polling: boolean;
  lastPoll: number;
  writes: Promise<void>;
  timers: Array<ReturnType<typeof setInterval>>;
  cleanups: Array<() => void>;
  release: (() => Promise<void>) | null;
  stopping: Promise<RecordingResult> | null;
  /** A stop call already has the result, so it is not kept for the next one. */
  claimed?: boolean;
}

const active = new Map<string, Recording>();
// Results of recordings that stopped on their own, kept for the next call,
// by session key. The tab's ref finds one whose session is gone: a tab that
// closed resolves to no session, but its id is what the agent passes.
const unclaimed = new Map<string, { ref: string; outcome: RecordingResult | Error }>();
const UNCLAIMED_LIMIT = 20;
const listeners = new Set<(change: RecordingChange) => void>();

export function onRecordingChange(listener: (change: RecordingChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(change: RecordingChange): void {
  for (const listener of listeners) {
    try {
      listener(change);
    } catch {
      /* a listener must not break the recording */
    }
  }
}

function status(rec: Recording): RecordingStatus {
  return {
    recording: true,
    tabId: rec.target.ref,
    format: rec.options.format,
    elapsedMs: Date.now() - rec.startedAt,
    frames: rec.frames.length,
    maxSeconds: rec.options.maxSeconds,
  };
}

export function recordingStatus(target: Pick<RecordTarget, "session">): RecordingStatus | null {
  const rec = active.get(target.session.key);
  return rec && !rec.stopping ? status(rec) : null;
}

export function isRecording(sessionKey: string): boolean {
  const rec = active.get(sessionKey);
  return Boolean(rec && !rec.stopping);
}

function commit(rec: Recording, latest: NonNullable<Recording["latest"]>): void {
  rec.written = latest.seq;
  if (rec.lastWritten && rec.lastWritten.equals(latest.data)) return;
  rec.lastWritten = latest.data;
  const file = join(rec.dir, `${String(rec.frames.length).padStart(6, "0")}.${rec.frameFormat === "jpeg" ? "jpg" : "png"}`);
  // Frame times only move forward, even when a frame's paint time does not.
  const previous = rec.frames[rec.frames.length - 1];
  rec.frames.push({ file, at: Math.max(previous ? previous.at + 1 : 0, latest.at) });
  rec.bytes += latest.data.length;
  rec.writes = rec.writes.then(() => fs.writeFile(file, latest.data));
}

async function poll(rec: Recording): Promise<void> {
  rec.polling = true;
  rec.lastPoll = Date.now();
  try {
    const png = await rec.target.captureViewport();
    const at = Date.now() - rec.startedAt;
    const frame = await rec.deps.frameFromPng(png, rec.options.maxWidth, rec.frameFormat);
    if (!rec.stopping) rec.latest = { data: frame, seq: ++rec.seq, at };
  } catch {
    /* the next tick tries again */
  } finally {
    rec.polling = false;
  }
}

function tick(rec: Recording): void {
  if (rec.stopping) return;
  const now = Date.now();
  if (rec.latest && rec.latest.seq !== rec.written) commit(rec, rec.latest);
  else if (!rec.sawScreencast && now - rec.startedAt >= SCREENCAST_GRACE_MS && !rec.polling && now - rec.lastPoll >= POLL_EVERY_MS) void poll(rec);
  if (rec.bytes >= RECORD_MAX_BYTES) void finishOnItsOwn(rec, `it reached ${RECORD_MAX_BYTES / 1024 / 1024} MB of frames`);
}

function screencastParams(rec: Recording): Record<string, unknown> {
  return {
    format: rec.frameFormat,
    ...(rec.frameFormat === "jpeg" ? { quality: VIDEO_FRAME_QUALITY } : {}),
    maxWidth: rec.options.maxWidth,
    maxHeight: rec.options.maxWidth * 4,
    everyNthFrame: 1,
  };
}

export async function startRecording(target: RecordTarget, options: RecordOptions, deps: RecordDeps): Promise<RecordingStatus & { already?: boolean }> {
  const key = target.session.key;
  const existing = active.get(key);
  if (existing && !existing.stopping) return { ...status(existing), already: true };
  unclaimed.delete(key);
  for (const [other, entry] of unclaimed) if (entry.ref === target.ref) unclaimed.delete(other);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const rec: Recording = {
    key,
    target,
    options,
    deps,
    frameFormat: deps.frameFormat ?? (options.format === "gif" ? "png" : "jpeg"),
    startedAt: Date.now(),
    dir: workspaceDataDir(target.workspaceId, "browser", "recording-frames", id),
    frames: [],
    bytes: 0,
    latest: null,
    seq: 0,
    written: 0,
    lastWritten: null,
    sawScreencast: false,
    polling: false,
    lastPoll: 0,
    writes: Promise.resolve(),
    timers: [],
    cleanups: [],
    release: null,
    stopping: null,
  };
  active.set(key, rec);
  try {
    await fs.mkdir(rec.dir, { recursive: true });
    void dropStaleFrames(dirname(rec.dir));
    rec.cleanups.push(target.session.on("Page.screencastFrame", (params) => {
      void target.session.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
      if (rec.stopping || typeof params.data !== "string") return;
      rec.sawScreencast = true;
      // The frame's own paint time (seconds) keeps motion evenly timed,
      // whenever it arrives; one far from now is from another clock.
      const now = Date.now() - rec.startedAt;
      const painted = (params.metadata as { timestamp?: unknown } | undefined)?.timestamp;
      const paintedAt = typeof painted === "number" && Number.isFinite(painted) ? Math.round(painted * 1000) - rec.startedAt : NaN;
      const at = Math.abs(paintedAt - now) < 2_000 ? paintedAt : now;
      rec.latest = { data: Buffer.from(params.data, "base64"), seq: ++rec.seq, at: Math.max(0, at) };
    }));
    // A tab that closed (or whose page was replaced) ends its session for
    // good without a detach event, and nothing more will come from it.
    rec.cleanups.push(target.session.onDispose(() => void finishOnItsOwn(rec, "the tab closed")));
    rec.cleanups.push(target.session.onDetach(() => {
      // The session re-attaches on its own (a crash, another client); the
      // screencast does not, so ask again once it is back.
      const timer = setTimeout(() => {
        if (rec.stopping) return;
        target.session.send("Page.startScreencast", screencastParams(rec)).catch(() => {
          void finishOnItsOwn(rec, "the tab closed");
        });
      }, 300);
      rec.cleanups.push(() => clearTimeout(timer));
    }));
    const releasePaint = await deps.holdPaint?.(target.session);
    if (releasePaint) rec.cleanups.push(releasePaint);
    rec.release = await target.session.enable("Page");
    await target.session.send("Page.startScreencast", screencastParams(rec));
  } catch (error) {
    active.delete(key);
    for (const cleanup of rec.cleanups.splice(0)) cleanup();
    await rec.release?.().catch(() => {});
    await fs.rm(rec.dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  rec.timers.push(setInterval(() => tick(rec), Math.round(1000 / options.fps)));
  const limit = setTimeout(() => void finishOnItsOwn(rec, `it reached maxSeconds (${options.maxSeconds} s)`), options.maxSeconds * 1000);
  rec.cleanups.push(() => clearTimeout(limit));
  emit({ key, tabId: target.ref, recording: true });
  return status(rec);
}

/**
 * Frame folders a recording never cleaned up (the app quit or crashed while
 * it ran) would otherwise stay on disk for good. A folder still being written
 * or encoded is younger than the longest recording.
 */
async function dropStaleFrames(parent: string): Promise<void> {
  const live = new Set([...active.values()].map((rec) => rec.dir));
  for (const name of await fs.readdir(parent).catch(() => [] as string[])) {
    const dir = join(parent, name);
    if (live.has(dir)) continue;
    const stat = await fs.stat(dir).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > STALE_FRAMES_MS) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function finishOnItsOwn(rec: Recording, reason: string): Promise<void> {
  if (rec.stopping) return;
  try {
    const result = await finish(rec, reason);
    if (!rec.claimed) unclaimed.set(rec.key, { ref: rec.target.ref, outcome: result });
  } catch (error) {
    if (!rec.claimed) unclaimed.set(rec.key, { ref: rec.target.ref, outcome: error instanceof Error ? error : new Error(String(error)) });
  }
  while (unclaimed.size > UNCLAIMED_LIMIT) unclaimed.delete(unclaimed.keys().next().value as string);
}

/** Stop the tab's recording and encode it; also returns one that already stopped itself. */
export async function stopRecording(target: Pick<RecordTarget, "session" | "ref">): Promise<RecordingResult> {
  const key = target.session.key;
  const rec = active.get(key);
  if (rec) {
    rec.claimed = true;
    return finish(rec);
  }
  const done = unclaimed.get(key);
  if (done) {
    unclaimed.delete(key);
    if (done.outcome instanceof Error) throw done.outcome;
    return done.outcome;
  }
  const byRef = claimRecording(target.ref);
  if (byRef) return byRef;
  throw new RecordOptionError(`${target.ref} is not being recorded. Start a recording first.`);
}

/**
 * The recording of the tab with this id when its session is gone (the tab
 * closed during it), once; null when there is none.
 */
export function claimRecording(ref: string): Promise<RecordingResult> | null {
  for (const rec of active.values()) {
    if (rec.target.ref !== ref || !rec.stopping || rec.claimed) continue;
    rec.claimed = true;
    return rec.stopping;
  }
  for (const [key, entry] of unclaimed) {
    if (entry.ref !== ref) continue;
    unclaimed.delete(key);
    return entry.outcome instanceof Error ? Promise.reject(entry.outcome) : Promise.resolve(entry.outcome);
  }
  return null;
}

function finish(rec: Recording, stoppedBy?: string): Promise<RecordingResult> {
  if (rec.stopping) return rec.stopping;
  rec.stopping = (async () => {
    for (const timer of rec.timers.splice(0)) clearInterval(timer);
    for (const cleanup of rec.cleanups.splice(0)) cleanup();
    await rec.target.session.send("Page.stopScreencast").catch(() => {});
    await rec.release?.().catch(() => {});
    const endAt = Date.now() - rec.startedAt;
    if (rec.latest && rec.latest.seq !== rec.written) commit(rec, rec.latest);
    if (!rec.frames.length) {
      await poll(rec);
      if (rec.latest) commit(rec, rec.latest);
    }
    try {
      await rec.writes;
      if (!rec.frames.length) throw new Error("No frames were captured from this tab.");
      return await encode(rec, endAt, stoppedBy);
    } finally {
      await fs.rm(rec.dir, { recursive: true, force: true }).catch(() => {});
    }
  })();
  rec.stopping.then(
    (result) => emit({ key: rec.key, tabId: rec.target.ref, recording: false, result }),
    (error: unknown) => emit({ key: rec.key, tabId: rec.target.ref, recording: false, error: error instanceof Error ? error.message : String(error) }),
  ).finally(() => {
    if (active.get(rec.key) === rec) active.delete(rec.key);
  });
  return rec.stopping;
}

function durations(frames: Frame[], endAt: number): number[] {
  return frames.map((frame, i) => (i + 1 < frames.length ? frames[i + 1].at - frame.at : Math.max(FINAL_FRAME_MS, endAt - frame.at)));
}

/** GIF delays in hundredths of a second, rounded on the running total so they do not drift. */
export function gifDelays(times: number[]): number[] {
  let elapsed = 0;
  return times.map((ms) => {
    const from = Math.round(elapsed / 10);
    elapsed += ms;
    return Math.round(elapsed / 10) - from;
  });
}

/** A PNG's or JPEG's pixel size, from its header. */
export function imageSize(data: Uint8Array): { width: number; height: number } {
  if (data[0] === 0x89 && data[1] === 0x50) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    for (let i = 2; i + 9 < data.length; ) {
      if (data[i] !== 0xff) break;
      const marker = data[i + 1];
      const length = (data[i + 2] << 8) | data[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: (data[i + 7] << 8) | data[i + 8], height: (data[i + 5] << 8) | data[i + 6] };
      }
      i += 2 + length;
    }
  }
  throw new Error("A frame is neither a PNG nor a JPEG.");
}

/** Fit a frame into the recording's size, centered on white, when the viewport changed mid-recording. */
function fitFrame(bitmap: Bitmap, width: number, height: number): Bitmap {
  if (bitmap.width === width && bitmap.height === height) return bitmap;
  const scaled = scaleBitmap(bitmap, fitSize(bitmap, { width, height }));
  const canvas = createBitmap(width, height);
  blit(canvas, scaled, Math.floor((width - scaled.width) / 2), Math.floor((height - scaled.height) / 2));
  return canvas;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function encode(rec: Recording, endAt: number, stoppedBy?: string): Promise<RecordingResult> {
  const encodeStart = Date.now();
  const times = durations(rec.frames, endAt);
  const head = await fs.readFile(rec.frames[0].file);
  const size = imageSize(head);
  let lastProgress = 0;
  const onProgress = (fraction: number) => {
    const now = Date.now();
    if (fraction < 1 && now - lastProgress < PROGRESS_EVERY_MS) return;
    lastProgress = now;
    emit({ key: rec.key, tabId: rec.target.ref, recording: false, progress: Math.max(0, Math.min(1, fraction)) });
  };
  const base = (format: RecordFormat, path: string, bytes: number, frameSize = size) => ({
    recording: false as const,
    tabId: rec.target.ref,
    path,
    format,
    mimeType: RECORD_MIME_TYPES[format],
    bytes,
    frames: rec.frames.length,
    durationMs: times.reduce((sum, ms) => sum + ms, 0),
    size: frameSize,
    fps: rec.options.fps,
    encodeMs: Date.now() - encodeStart,
    ...(stoppedBy ? { stoppedBy } : {}),
  });
  const label = rec.target.ref;
  const notes: string[] = [];
  if (rec.options.format !== "gif") {
    if (rec.deps.encodeVideo) {
      try {
        const video = await rec.deps.encodeVideo({
          frames: rec.frames.map((frame, i) => ({ file: frame.file, atMs: frame.at, durationMs: times[i] })),
          size,
          format: rec.options.format,
          fps: rec.options.fps,
          outBase: join(rec.dir, "recording"),
          workDir: rec.dir,
          onProgress,
        });
        const path = await moveBrowserArtifact(rec.target.workspaceId, "recordings", { label, ext: video.format, from: video.path });
        const even = { width: size.width - (size.width % 2), height: size.height - (size.height % 2) };
        return { ...base(video.format, path, video.bytes, even), ...(video.note ? { note: video.note } : {}) };
      } catch (error) {
        notes.push(`Video encoding failed (${errorText(error)}).`);
      }
    }
    const ffmpeg = (rec.deps.ffmpeg ?? findFfmpeg)();
    if (ffmpeg) {
      const dir = browserArtifactDir(rec.target.workspaceId, "recordings");
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const path = join(dir, `${stamp}-${label.replace(/[^A-Za-z0-9._-]+/g, "-")}.webm`);
      const frames = rec.frames.map((frame, i) => ({ file: frame.file, durationMs: times[i] }));
      // The frames are deleted once this returns, so an ffmpeg that cannot
      // encode them (no VP8 or VP9, a broken install) must not lose the flow.
      try {
        await encodeWebm(ffmpeg, frames, path, rec.dir, rec.options.fps, size);
        const bytes = (await fs.stat(path)).size;
        if (rec.options.format === "mp4") notes.push("Saved a WebM with ffmpeg instead.");
        return { ...base("webm", path, bytes), ...(notes.length ? { note: notes.join(" ") } : {}) };
      } catch (error) {
        await fs.rm(path, { force: true }).catch(() => {});
        notes.push(`WebM encoding failed (${errorText(error)}).`);
      }
    } else if (!rec.deps.encodeVideo) {
      notes.push("A video needs Codara's encoder or ffmpeg on PATH (or CODARA_FFMPEG).");
    }
    notes.push("Saved a GIF instead.");
  }
  const worker = startGifWorker(size.width, size.height);
  try {
    const delays = gifDelays(times);
    for (let i = 0; i < rec.frames.length; i += 1) {
      const file = rec.frames[i].file;
      if (file.endsWith(".png")) await worker.addFrameFile(file, delays[i]);
      else {
        // A video's JPEG frames: decoded here, which only this fallback needs.
        const bitmap = rec.deps.codec.decode(await fs.readFile(file));
        await worker.addFrame(fitFrame(bitmap, size.width, size.height).data, delays[i]);
      }
      onProgress((i + 1) / rec.frames.length);
    }
    const gif = await worker.finish();
    const path = await writeBrowserArtifact(rec.target.workspaceId, "recordings", { label, ext: "gif", data: gif });
    return { ...base("gif", path, gif.length), ...(notes.length ? { note: notes.join(" ") } : {}) };
  } finally {
    worker.terminate();
  }
}

/** The app's recording dependencies: Electron's image codec and the WebCodecs video encoder. */
export function appRecordDeps(codec: BitmapCodec): RecordDeps {
  return {
    codec,
    holdPaint: holdGuestPaint,
    encodeVideo: async (job) => {
      const { encodeVideo } = await import("./video-encoder");
      return encodeVideo(job);
    },
    async frameFromPng(png, maxWidth, format) {
      const { nativeImage } = require("electron") as typeof import("electron");
      let image = nativeImage.createFromBuffer(png);
      if (image.isEmpty()) throw new Error("The capture was empty.");
      const size = image.getSize();
      if (size.width <= maxWidth && format === "png") return png;
      if (size.width > maxWidth) image = image.resize({ width: maxWidth, quality: "best" });
      return format === "png" ? image.toPNG() : image.toJPEG(VIDEO_FRAME_QUALITY);
    },
  };
}
