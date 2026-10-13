// WebM output goes through the user's own ffmpeg when one is installed;
// Codara ships no video encoder. Frames are already JPEG files on disk, so
// ffmpeg reads them through its concat list with each frame's duration.

import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { delimiter, join } from "node:path";

const COMMON_LOCATIONS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "C:\\ffmpeg\\bin"];

/** The ffmpeg to use: CODARA_FFMPEG, then PATH, then the usual install folders; null when there is none. */
export function findFfmpeg(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.CODARA_FFMPEG?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  const names = process.platform === "win32" ? ["ffmpeg.exe"] : ["ffmpeg"];
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...COMMON_LOCATIONS];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface TimedFrame {
  /** Absolute path of the frame image. */
  file: string;
  durationMs: number;
}

function run(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().split("\n").pop() ?? ""}`))));
  });
}

/** Encode the frames as a WebM at `out`: VP9, or VP8 when this ffmpeg lacks VP9. */
export async function encodeWebm(
  ffmpeg: string,
  frames: TimedFrame[],
  out: string,
  workDir: string,
  fps: number,
  size: { width: number; height: number },
): Promise<void> {
  if (!frames.length) throw new Error("There are no frames to encode.");
  const list = join(workDir, "frames.ffconcat");
  const lines = ["ffconcat version 1.0"];
  for (const frame of frames) {
    lines.push(`file '${frame.file.replace(/'/g, "'\\''")}'`, `duration ${(Math.max(1, frame.durationMs) / 1000).toFixed(3)}`);
  }
  // The concat demuxer ignores the last entry's duration unless the file repeats.
  lines.push(`file '${frames[frames.length - 1].file.replace(/'/g, "'\\''")}'`);
  await fs.writeFile(list, `${lines.join("\n")}\n`);
  const input = ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list];
  // One even-sized frame for 4:2:0 even when the viewport changed mid-way,
  // and a constant frame rate, which players seek well in.
  const width = Math.max(2, size.width - (size.width % 2));
  const height = Math.max(2, size.height - (size.height % 2));
  const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p`;
  const filter = ["-vf", fit, "-r", String(fps), "-threads", "2"];
  try {
    await run(ffmpeg, [...input, ...filter, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "38", "-deadline", "realtime", "-cpu-used", "8", out]);
  } catch {
    await run(ffmpeg, [...input, ...filter, "-c:v", "libvpx", "-b:v", "1M", "-crf", "10", "-deadline", "realtime", "-cpu-used", "8", out]);
  }
}
