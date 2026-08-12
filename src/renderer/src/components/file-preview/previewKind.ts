// Extension-driven classifier for files that get a visual previewer instead
// of the CodeMirror editor. Deliberately NOT based on the binary sniff in
// fs:readEx: SVG is text (would land in CodeMirror), and media over the 5MB
// read cap never even reaches the binary check — the previewers bypass the
// text-read IPC entirely and load via file:// URLs.
export type PreviewKind =
  | "image"
  | "svg"
  | "pdf"
  | "video"
  | "audio"
  | "docx"
  | "pptx"
  | "whiteboard"
  | "html";

// Image list mirrors PASTED_IMAGE_EXTENSIONS + the dialog:openImages filter
// in src/main/ipc.ts, plus formats Chromium renders natively.
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "avif"]);
// Chromium-decodable containers; mov is best-effort (codec-dependent).
const VIDEO_EXTS = new Set(["mp4", "webm", "ogv", "m4v", "mov"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "flac", "m4a", "aac"]);
// docx-preview only understands the OOXML (zip-based) Word formats. Legacy
// binary .doc/.dot and .rtf are a different format entirely and fall through
// to the binary-file guard instead.
const DOCX_EXTS = new Set(["docx", "docm", "dotx", "dotm"]);
// Same OOXML-only rule for PowerPoint: pptx-preview reads the zip-based
// formats, so legacy binary .ppt/.pot fall through to the binary-file guard.
const PPTX_EXTS = new Set(["pptx", "pptm", "ppsx", "ppsm", "potx", "potm"]);

export function previewKindForPath(path: string): PreviewKind | null {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  if (ext === "coraboard") return "whiteboard";
  if (ext === "svg") return "svg";
  // HTML keeps the document flow (it's real markup, editable in CodeMirror)
  // and gets a rendered view via <webview> — same toggle pattern as SVG.
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (DOCX_EXTS.has(ext)) return "docx";
  if (PPTX_EXTS.has(ext)) return "pptx";
  return null;
}
