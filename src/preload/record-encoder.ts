/// <reference lib="dom" />
// The video encoder of browser recordings (src/main/browser/record/
// video-encoder.ts): a hidden page whose only job is Chromium's WebCodecs
// encoder, so a recording becomes an H.264 or VP9 video on every platform
// without ffmpeg. Main sends it one frame file at a time over a private
// message port and gets the encoded chunks back; nothing else reaches it.

import { ipcRenderer } from "electron";

interface OpenRequest {
  type: "open";
  /** Codec strings to try, best first. */
  codecs: string[];
  width: number;
  height: number;
  fps: number;
  /** Bits per second for codecs without a constant-quality mode. */
  bitrate: number;
  /** VP9's constant-quality level, 0 (best) to 63. */
  quantizer: number;
}

interface FrameRequest {
  type: "frame";
  data: Uint8Array<ArrayBuffer>;
  mime: string;
  timestampUs: number;
  durationUs: number;
  keyFrame: boolean;
}

type Request = OpenRequest | FrameRequest | { type: "flush" };

ipcRenderer.once("record-encoder:port", (event) => {
  const port = event.ports[0];
  if (!port) return;
  // Rooted on the page's global: otherwise only its own listener refers to
  // it, and the big frames make the garbage collector run often.
  (globalThis as { recordEncoderPort?: MessagePort }).recordEncoderPort = port;
  let encoder: VideoEncoder | null = null;
  let opened: OpenRequest | null = null;
  let codec = "";
  let constantQuality = false;
  let failure: string | null = null;
  let canvas: OffscreenCanvas | null = null;

  const fail = (error: unknown) => {
    failure = error instanceof Error ? error.message : String(error);
    port.postMessage({ type: "error", message: failure });
  };

  async function open(request: OpenRequest): Promise<void> {
    // VP9 at a constant quality where it can be; otherwise a bitrate,
    // variable where the encoder allows it (some hardware ones only keep it
    // constant).
    const attempts = request.codecs.flatMap((candidate) =>
      ((candidate.startsWith("vp09") ? ["quantizer", "variable", "constant"] : ["variable", "constant"]) as VideoEncoderBitrateMode[])
        .map((mode) => ({ candidate, mode })));
    for (const { candidate, mode } of attempts) {
      const config: VideoEncoderConfig = {
        codec: candidate,
        width: request.width,
        height: request.height,
        framerate: request.fps,
        latencyMode: "quality",
        bitrateMode: mode,
        ...(mode === "quantizer" ? {} : { bitrate: request.bitrate }),
        ...(candidate.startsWith("avc1") ? { avc: { format: "avc" as AvcBitstreamFormat } } : {}),
      };
      const support = await VideoEncoder.isConfigSupported(config).catch(() => null);
      if (!support?.supported) continue;
      encoder = new VideoEncoder({
        output(chunk, metadata) {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          const config = metadata?.decoderConfig;
          const description = config?.description
            ? new Uint8Array(ArrayBuffer.isView(config.description) ? config.description.buffer.slice(config.description.byteOffset, config.description.byteOffset + config.description.byteLength) : config.description.slice(0))
            : undefined;
          port.postMessage({
            type: "chunk",
            data,
            timestampUs: chunk.timestamp,
            durationUs: chunk.duration ?? 0,
            key: chunk.type === "key",
            ...(description ? { description } : {}),
            ...(config?.colorSpace ? { colorSpace: { ...config.colorSpace } } : {}),
          });
        },
        error: fail,
      });
      encoder.configure(config);
      opened = request;
      codec = candidate;
      constantQuality = mode === "quantizer";
      port.postMessage({ type: "opened", codec });
      return;
    }
    port.postMessage({ type: "unsupported" });
  }

  async function frame(request: FrameRequest): Promise<void> {
    if (!encoder || !opened) throw new Error("The encoder is not open.");
    const { width, height } = opened;
    const bitmap = await createImageBitmap(new Blob([request.data], { type: request.mime }));
    const init = { timestamp: request.timestampUs, duration: request.durationUs };
    let videoFrame: VideoFrame;
    const extraWidth = bitmap.width - width;
    const extraHeight = bitmap.height - height;
    if (extraWidth >= 0 && extraWidth <= 1 && extraHeight >= 0 && extraHeight <= 1) {
      // The frame size, or one pixel more where the video rounded to even.
      videoFrame = new VideoFrame(bitmap, { ...init, visibleRect: { x: 0, y: 0, width, height } });
    } else {
      // The viewport changed size mid-recording: fit the frame, centered on white.
      canvas ??= new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No 2D canvas for a resized frame.");
      const scale = Math.min(width / bitmap.width, height / bitmap.height);
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, Math.floor((width - w) / 2), Math.floor((height - h) / 2), w, h);
      videoFrame = new VideoFrame(canvas, init);
    }
    bitmap.close();
    const options: VideoEncoderEncodeOptions & { vp9?: { quantizer: number } } = { keyFrame: request.keyFrame };
    if (constantQuality) options.vp9 = { quantizer: opened.quantizer };
    try {
      encoder.encode(videoFrame, options);
    } finally {
      videoFrame.close();
    }
    // Keep a couple of frames queued at most: main waits for this reply.
    while (encoder.encodeQueueSize > 2 && !failure) {
      await new Promise<void>((resolve) => encoder?.addEventListener("dequeue", () => resolve(), { once: true }));
    }
  }

  let queue = Promise.resolve();
  port.onmessage = (message: MessageEvent<Request>) => {
    const request = message.data;
    queue = queue.then(async () => {
      if (failure) return;
      try {
        if (request.type === "open") await open(request);
        else if (request.type === "frame") {
          await frame(request);
          port.postMessage({ type: "ack" });
        } else if (request.type === "flush") {
          await encoder?.flush();
          encoder?.close();
          encoder = null;
          port.postMessage({ type: "flushed" });
        }
      } catch (error) {
        fail(error);
      }
    });
  };
  port.start();
});
