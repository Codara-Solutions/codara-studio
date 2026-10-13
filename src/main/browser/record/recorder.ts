// Recording a browser flow to a GIF or WebM file. Frames come from the
// DevTools protocol's screencast, which the page sends whenever it paints,
// so recording costs nothing while the page is still. A tab that sends no
// frames (hidden behind another tab, a minimized window) is captured with
// the target's background-safe viewport capture instead.
//
// Frames are sampled at most `fps` times a second (the newest frame wins,
// so the last state before a pause is never dropped) and written to disk
// as they arrive; memory holds one frame. Stopping encodes them: GIF on a
// worker thread, WebM with the user's ffmpeg when there is one.

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { workspaceDataDir } from "../../workspace-data";
import { browserArtifactDir, writeBrowserArtifact } from "../artifacts";
import { blit, createBitmap, fitSize, scaleBitmap, type Bitmap } from "../capture/bitmap";
import type { BitmapCodec } from "../capture/codec";
import { holdGuestPaint } from "../capture/paint";
import type { CdpSession } from "../cdp-session";
import { encodeWebm, findFfmpeg } from "./ffmpeg";
import { startGifWorker } from "./gif-worker";

export type RecordFormat = "gif" | "webm";

export interface RecordOptions {
  format: RecordFormat;
  /** Frames per second at most. */
  fps: number;
  /** The recording stops itself after this long. */
  maxSeconds: number;
  /** Frame width cap in pixels. */
  maxWidth: number;
}

export const RECORD_DEFAULTS: RecordOptions = { format: "gif", fps: 8, maxSeconds: 30, maxWidth: 800 };
export const RECORD_MAX = { fps: 15, maxSeconds: 120, maxWidth: 1920 };
/** Frame files on disk per recording, a backstop under the time limit. */
export const RECORD_MAX_BYTES = 256 * 1024 * 1024;
/** How long a final frame stays up before a GIF loops. */
const FINAL_FRAME_MS = 1_000;
/** Frame folders older than this belong to no running recording. */
const STALE_FRAMES_MS = 30 * 60 * 1000;
/** Without a screencast frame by then, the tab is not painting: capture it instead. */
const SCREENCAST_GRACE_MS = 700;

export class RecordOptionError extends Error {}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeRecordOptions(raw: Record<string, unknown>): RecordOptions {
  const format = raw.format === undefined ? RECORD_DEFAULTS.format : raw.format;
  if (format !== "gif" && format !== "webm") throw new RecordOptionError('format must be "gif" or "webm".');
  const fps = finite(raw.fps) ?? RECORD_DEFAULTS.fps;
  const maxSeconds = finite(raw.maxSeconds) ?? RECORD_DEFAULTS.maxSeconds;
  const maxWidth = finite(raw.maxWidth) ?? RECORD_DEFAULTS.maxWidth;
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

export interface RecordDeps {
  codec: BitmapCodec;
  /** The image format of screencast frames and frame files. */
  frameFormat: "jpeg" | "png";
  /** A viewport capture (PNG) as a frame file's bytes, no wider than maxWidth. */
  frameFromPng(png: Buffer, maxWidth: number): Promise<Buffer>;
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

export interface RecordingResult {
  recording: false;
  tabId: string;
  path: string;
  format: RecordFormat;
  mimeType: "image/gif" | "video/webm";
  bytes: number;
  frames: number;
  durationMs: number;
  size: { width: number; height: number };
  fps: number;
  /** Why it stopped on its own (time limit, tab closed), when it did. */
  stoppedBy?: string;
  note?: string;
}

export interface RecordingChange {
  key: string;
  tabId: string;
  recording: boolean;
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
  startedAt: number;
  dir: string;
  frames: Frame[];
  bytes: number;
  latest: { data: Buffer; seq: number } | null;
  seq: number;
  written: number;
  lastWritten: Buffer | null;
  sawScreencast: boolean;
  polling: boolean;
  writes: Promise<void>;
  timers: Array<ReturnType<typeof setInterval>>;
  cleanups: Array<() => void>;
  release: (() => Promise<void>) | null;
  stopping: Promise<RecordingResult> | null;
}

const active = new Map<string, Recording>();
// Results of recordings that stopped on their own, kept for the next call.
const unclaimed = new Map<string, RecordingResult | Error>();
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

function commit(rec: Recording, data: Buffer, seq: number): void {
  rec.written = seq;
  if (rec.lastWritten && rec.lastWritten.equals(data)) return;
  rec.lastWritten = data;
  const file = join(rec.dir, `${String(rec.frames.length).padStart(6, "0")}.${rec.deps.frameFormat === "jpeg" ? "jpg" : "png"}`);
  rec.frames.push({ file, at: Date.now() - rec.startedAt });
  rec.bytes += data.length;
  rec.writes = rec.writes.then(() => fs.writeFile(file, data));
}

async function poll(rec: Recording): Promise<void> {
  rec.polling = true;
  try {
    const png = await rec.target.captureViewport();
    const frame = await rec.deps.frameFromPng(png, rec.options.maxWidth);
    if (!rec.stopping) rec.latest = { data: frame, seq: ++rec.seq };
  } catch {
    /* the next tick tries again */
  } finally {
    rec.polling = false;
  }
}

function tick(rec: Recording): void {
  if (rec.stopping) return;
  if (rec.latest && rec.latest.seq !== rec.written) commit(rec, rec.latest.data, rec.latest.seq);
  else if (!rec.sawScreencast && Date.now() - rec.startedAt >= SCREENCAST_GRACE_MS && !rec.polling) void poll(rec);
  if (rec.bytes >= RECORD_MAX_BYTES) void finishOnItsOwn(rec, `it reached ${RECORD_MAX_BYTES / 1024 / 1024} MB of frames`);
}

function screencastParams(rec: Recording): Record<string, unknown> {
  return {
    format: rec.deps.frameFormat,
    quality: 80,
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
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const rec: Recording = {
    key,
    target,
    options,
    deps,
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
      rec.latest = { data: Buffer.from(params.data, "base64"), seq: ++rec.seq };
    }));
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
    unclaimed.set(rec.key, result);
  } catch (error) {
    unclaimed.set(rec.key, error instanceof Error ? error : new Error(String(error)));
  }
  while (unclaimed.size > UNCLAIMED_LIMIT) unclaimed.delete(unclaimed.keys().next().value as string);
}

/** Stop the tab's recording and encode it; also returns one that already stopped itself. */
export async function stopRecording(target: Pick<RecordTarget, "session" | "ref">): Promise<RecordingResult> {
  const key = target.session.key;
  const rec = active.get(key);
  if (rec) return finish(rec);
  const done = unclaimed.get(key);
  if (done) {
    unclaimed.delete(key);
    if (done instanceof Error) throw done;
    return done;
  }
  throw new RecordOptionError(`${target.ref} is not being recorded. Start a recording first.`);
}

function finish(rec: Recording, stoppedBy?: string): Promise<RecordingResult> {
  if (rec.stopping) return rec.stopping;
  rec.stopping = (async () => {
    for (const timer of rec.timers.splice(0)) clearInterval(timer);
    for (const cleanup of rec.cleanups.splice(0)) cleanup();
    await rec.target.session.send("Page.stopScreencast").catch(() => {});
    await rec.release?.().catch(() => {});
    const endAt = Date.now() - rec.startedAt;
    if (rec.latest && rec.latest.seq !== rec.written) commit(rec, rec.latest.data, rec.latest.seq);
    if (!rec.frames.length) {
      await poll(rec);
      if (rec.latest) commit(rec, rec.latest.data, rec.latest.seq);
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

/** Fit a frame into the recording's size, centered on white, when the viewport changed mid-recording. */
function fitFrame(bitmap: Bitmap, width: number, height: number): Bitmap {
  if (bitmap.width === width && bitmap.height === height) return bitmap;
  const scaled = scaleBitmap(bitmap, fitSize(bitmap, { width, height }));
  const canvas = createBitmap(width, height);
  blit(canvas, scaled, Math.floor((width - scaled.width) / 2), Math.floor((height - scaled.height) / 2));
  return canvas;
}

async function encode(rec: Recording, endAt: number, stoppedBy?: string): Promise<RecordingResult> {
  const { codec } = rec.deps;
  const times = durations(rec.frames, endAt);
  const first = codec.decode(await fs.readFile(rec.frames[0].file));
  const size = { width: first.width, height: first.height };
  const base = {
    recording: false as const,
    tabId: rec.target.ref,
    frames: rec.frames.length,
    durationMs: times.reduce((sum, ms) => sum + ms, 0),
    size,
    fps: rec.options.fps,
    ...(stoppedBy ? { stoppedBy } : {}),
  };
  let note: string | undefined;
  if (rec.options.format === "webm") {
    const ffmpeg = (rec.deps.ffmpeg ?? findFfmpeg)();
    if (ffmpeg) {
      const dir = browserArtifactDir(rec.target.workspaceId, "recordings");
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const path = join(dir, `${stamp}-${rec.target.ref.replace(/[^A-Za-z0-9._-]+/g, "-")}.webm`);
      const frames = rec.frames.map((frame, i) => ({ file: frame.file, durationMs: times[i] }));
      // The frames are deleted once this returns, so an ffmpeg that cannot
      // encode them (no VP8 or VP9, a broken install) must not lose the flow.
      try {
        await encodeWebm(ffmpeg, frames, path, rec.dir, rec.options.fps, size);
        const bytes = (await fs.stat(path)).size;
        return { ...base, path, format: "webm", mimeType: "video/webm", bytes };
      } catch (error) {
        await fs.rm(path, { force: true }).catch(() => {});
        note = `WebM encoding failed (${error instanceof Error ? error.message : String(error)}); saved a GIF instead.`;
      }
    } else {
      note = "WebM needs ffmpeg on PATH (or CODARA_FFMPEG); saved a GIF instead.";
    }
  }
  const worker = startGifWorker(size.width, size.height);
  try {
    for (let i = 0; i < rec.frames.length; i += 1) {
      const bitmap = i === 0 ? first : codec.decode(await fs.readFile(rec.frames[i].file));
      await worker.addFrame(fitFrame(bitmap, size.width, size.height).data, Math.round(times[i] / 10));
    }
    const gif = await worker.finish();
    const path = await writeBrowserArtifact(rec.target.workspaceId, "recordings", { label: rec.target.ref, ext: "gif", data: gif });
    return { ...base, path, format: "gif", mimeType: "image/gif", bytes: gif.length, ...(note ? { note } : {}) };
  } finally {
    worker.terminate();
  }
}

/** The app's recording dependencies: Electron's image codec and JPEG frames. */
export function appRecordDeps(codec: BitmapCodec): RecordDeps {
  return {
    codec,
    frameFormat: "jpeg",
    holdPaint: holdGuestPaint,
    async frameFromPng(png, maxWidth) {
      const { nativeImage } = require("electron") as typeof import("electron");
      let image = nativeImage.createFromBuffer(png);
      if (image.isEmpty()) throw new Error("The capture was empty.");
      const size = image.getSize();
      if (size.width > maxWidth) image = image.resize({ width: maxWidth, quality: "good" });
      return image.toJPEG(80);
    },
  };
}
