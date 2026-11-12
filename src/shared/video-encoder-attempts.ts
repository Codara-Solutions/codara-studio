// The WebCodecs configurations the recording encoder (src/preload/
// record-encoder.ts) tries, best first. Plain data so a unit suite can pin
// the order without a browser.

export interface VideoEncoderAttempt {
  codec: string;
  width: number;
  height: number;
  framerate: number;
  latencyMode: "quality";
  bitrateMode: "quantizer" | "variable" | "constant";
  bitrate?: number;
  contentHint?: "text";
  avc?: { format: "avc" };
}

export interface VideoEncoderAttemptsRequest {
  /** Codec strings to try, best first. */
  codecs: string[];
  width: number;
  height: number;
  fps: number;
  /** Bits per second for codecs without a constant-quality mode. */
  bitrate: number;
}

/**
 * VP9 at a constant quality where it can be; otherwise a bitrate, variable
 * where the encoder allows it (some hardware ones only keep it constant).
 * H.264 is told the frames are text: OpenH264 (Linux) then encodes them as
 * screen content, which follows a scroll as motion and keeps small text
 * sharp. As camera video it spends its bits on stills and turns each scroll
 * into blocks. An encoder that refuses the hint is asked again without it.
 */
export function videoEncoderAttempts(request: VideoEncoderAttemptsRequest): VideoEncoderAttempt[] {
  return request.codecs.flatMap((codec) => {
    const avc = codec.startsWith("avc1");
    const modes: VideoEncoderAttempt["bitrateMode"][] = codec.startsWith("vp09") ? ["quantizer", "variable", "constant"] : ["variable", "constant"];
    return modes.flatMap((bitrateMode) =>
      (avc ? (["text", undefined] as const) : [undefined]).map((contentHint): VideoEncoderAttempt => ({
        codec,
        width: request.width,
        height: request.height,
        framerate: request.fps,
        latencyMode: "quality",
        bitrateMode,
        ...(bitrateMode === "quantizer" ? {} : { bitrate: request.bitrate }),
        ...(contentHint ? { contentHint } : {}),
        ...(avc ? { avc: { format: "avc" as const } } : {}),
      })),
    );
  });
}
