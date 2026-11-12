// Which view a file opens in: a visual previewer or the CodeMirror editor.
// The one table for every way a file opens (the Explorer and editor tabs in
// the renderer, Quick Open's picks and codara_open_file in main), so they
// cannot disagree about what Studio can show.
//
// The view is chosen by extension. Deliberately NOT by the editor's binary
// sniff: SVG is text (it would land in CodeMirror), and media over the text
// read cap never even reaches that check. The previewers load bytes through
// file:// URLs or fs:readFileBytes, not the text read.
export type PreviewKind =
  | "image"
  | "svg"
  | "pdf"
  | "video"
  | "audio"
  | "docx"
  | "pptx"
  | "spreadsheet"
  | "whiteboard"
  | "html";

export const PREVIEW_EXTENSIONS: Readonly<Record<PreviewKind, readonly string[]>> = {
  // Mirrors PASTED_IMAGE_EXTENSIONS + the dialog:openImages filter in
  // src/main/ipc.ts, plus formats Chromium renders natively.
  image: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "avif"],
  svg: ["svg"],
  pdf: ["pdf"],
  // Chromium-decodable containers; mov is best-effort (codec-dependent).
  video: ["mp4", "webm", "ogv", "m4v", "mov"],
  audio: ["mp3", "wav", "ogg", "oga", "flac", "m4a", "aac"],
  // docx-preview only understands the OOXML (zip-based) Word formats. Legacy
  // binary .doc/.dot and .rtf are a different format entirely and stay
  // binary files.
  docx: ["docx", "docm", "dotx", "dotm"],
  // Same OOXML-only rule for PowerPoint: legacy binary .ppt/.pot stay binary.
  pptx: ["pptx", "pptm", "ppsx", "ppsm", "potx", "potm"],
  // Macro-enabled workbooks are safe to inspect because only cells are
  // parsed; macros never run. Legacy .xls/.xlsb and OpenDocument .ods need
  // other parsers.
  spreadsheet: ["xlsx", "xlsm", "xltx", "xltm"],
  whiteboard: ["coraboard"],
  // HTML keeps the document flow (real markup, editable in CodeMirror) and
  // gets a rendered view, the same toggle as SVG.
  html: ["html", "htm"],
};

const KIND_BY_EXTENSION = new Map<string, PreviewKind>(
  (Object.entries(PREVIEW_EXTENSIONS) as Array<[PreviewKind, readonly string[]]>).flatMap(([kind, exts]) =>
    exts.map((ext) => [ext, kind] as const),
  ),
);

export function previewKindForPath(path: string): PreviewKind | null {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return KIND_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

/**
 * Kinds whose viewer reads the whole file through fs:readFileBytes, and so
 * stops at its cap. Images and media stream from file:// with no cap.
 */
export function previewLoadsBytes(kind: PreviewKind): boolean {
  return kind === "pdf" || kind === "docx" || kind === "pptx" || kind === "spreadsheet";
}

/**
 * Kinds whose file is text the editor reads too (SVG and HTML toggle to the
 * editor; a board is saved as JSON), so the editor's text limits apply.
 */
export function previewReadsText(kind: PreviewKind): boolean {
  return kind === "svg" || kind === "html" || kind === "whiteboard";
}

export interface SniffedContent {
  /** What the bytes are, for a message: "a PNG image". */
  label: string;
  /** The views that can show these bytes. */
  kinds: readonly PreviewKind[];
}

function startsWith(head: Uint8Array, bytes: readonly number[], at = 0): boolean {
  if (head.length < at + bytes.length) return false;
  return bytes.every((byte, i) => head[at + i] === byte);
}

function ascii(head: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...head.subarray(from, Math.min(to, head.length)));
}

const OOXML: readonly PreviewKind[] = ["docx", "pptx", "spreadsheet"];
const MEDIA: readonly PreviewKind[] = ["video", "audio"];

/**
 * The format the first bytes of a file announce, for the formats the binary
 * previewers show. Null when no signature matches (text, or a format Studio
 * has no view for).
 */
export function sniffPreviewContent(head: Uint8Array): SniffedContent | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { label: "a PNG image", kinds: ["image"] };
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { label: "a JPEG image", kinds: ["image"] };
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") return { label: "a GIF image", kinds: ["image"] };
  // BMP's two reserved words are zero.
  if (ascii(head, 0, 2) === "BM" && startsWith(head, [0, 0, 0, 0], 6)) return { label: "a BMP image", kinds: ["image"] };
  if (ascii(head, 0, 4) === "RIFF") {
    const form = ascii(head, 8, 12);
    if (form === "WEBP") return { label: "a WebP image", kinds: ["image"] };
    if (form === "WAVE") return { label: "a WAV recording", kinds: ["audio"] };
    return null;
  }
  const box = ascii(head, 4, 8);
  if (box === "ftyp") {
    // AVIF may carry a generic HEIF major brand and name itself among the
    // compatible brands that follow.
    const boxEnd = Math.min(head.length, ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0);
    const brands = [ascii(head, 8, 12)];
    for (let at = 16; at + 4 <= boxEnd; at += 4) brands.push(ascii(head, at, at + 4));
    if (brands.some((brand) => brand === "avif" || brand === "avis") || brands[0] === "mif1" || brands[0] === "msf1") {
      return { label: "an AVIF image", kinds: ["image"] };
    }
    return { label: "an MP4 or QuickTime file", kinds: MEDIA };
  }
  if (box === "moov" || box === "mdat" || box === "wide" || box === "free") return { label: "a QuickTime movie", kinds: ["video"] };
  // An icon directory: reserved zero, type 1, and at least one image.
  if (startsWith(head, [0x00, 0x00, 0x01, 0x00]) && head.length >= 6 && (head[4]! | head[5]!) !== 0) return { label: "an icon", kinds: ["image"] };
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return { label: "a zip archive", kinds: OOXML };
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return { label: "a WebM or Matroska file", kinds: MEDIA };
  if (ascii(head, 0, 4) === "OggS") return { label: "an Ogg file", kinds: MEDIA };
  if (ascii(head, 0, 4) === "fLaC") return { label: "a FLAC recording", kinds: ["audio"] };
  if (ascii(head, 0, 3) === "ID3") return { label: "an MP3 recording", kinds: ["audio"] };
  // An MPEG layer III frame or an AAC ADTS header. Neither matches FF FE,
  // the byte order mark of UTF-16 text.
  if (head.length >= 2 && head[0] === 0xff && (((head[1]! & 0xe6) === 0xe2) || (head[1]! & 0xf6) === 0xf0)) {
    return { label: "an MP3 or AAC recording", kinds: ["audio"] };
  }
  // Last: a PDF may carry a few bytes before its header, so this looks
  // further in than the signatures above.
  if (ascii(head, 0, 1024).includes("%PDF-")) return { label: "a PDF", kinds: ["pdf"] };
  return null;
}

/** True when the bytes read as text: no NUL and valid UTF-8. */
export function looksLikeText(head: Uint8Array): boolean {
  if (head.includes(0)) return false;
  // The sample may end inside a character: drop an unfinished sequence.
  let end = head.length;
  for (let back = 1; back <= 3 && end - back >= 0; back += 1) {
    const byte = head[end - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    if (byte >= 0xc0) end -= back;
    break;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, end));
    return true;
  } catch {
    return false;
  }
}
