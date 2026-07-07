// Extension-driven classifier for files that get a visual previewer instead
// of the CodeMirror editor. Deliberately NOT based on the binary sniff in
// fs:readEx: SVG is text (would land in CodeMirror), and media over the 5MB
// read cap never even reaches the binary check — the previewers bypass the
// text-read IPC entirely and load via file:// URLs.
export type PreviewKind = "image" | "svg" | "pdf" | "video" | "audio";

// Image list mirrors PASTED_IMAGE_EXTENSIONS + the dialog:openImages filter
// in src/main/ipc.ts, plus formats Chromium renders natively.
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "avif"]);
// Chromium-decodable containers; mov is best-effort (codec-dependent).
const VIDEO_EXTS = new Set(["mp4", "webm", "ogv", "m4v", "mov"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "flac", "m4a", "aac"]);

export function previewKindForPath(path: string): PreviewKind | null {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  if (ext === "svg") return "svg";
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return null;
}
