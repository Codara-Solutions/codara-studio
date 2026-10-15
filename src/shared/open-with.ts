// File types Studio offers to open from Finder and Explorer ("Open in Codara
// Studio" and "Open With"). The set is what EditorPane can show as a rendered
// view: everything previewKindForPath classifies, plus CSV and Markdown.
//
// `uti` is the type macOS assigns the extension, which is what a Finder Quick
// Action filters on. Extensions macOS does not know get a dynamic UTI derived
// from the extension alone, so those values are stable across machines too.
//
// Three copies must stay in step with this list: the `mac.fileAssociations`
// block in package.json, build/installer.nsh (the Windows uninstaller), and
// previewKind.ts. scripts/test-open-with.cjs checks all three.
export interface OpenWithType {
  ext: string;
  uti: string;
}

export const OPEN_WITH_TYPES: readonly OpenWithType[] = [
  { ext: "png", uti: "public.png" },
  { ext: "jpg", uti: "public.jpeg" },
  { ext: "jpeg", uti: "public.jpeg" },
  { ext: "webp", uti: "org.webmproject.webp" },
  { ext: "gif", uti: "com.compuserve.gif" },
  { ext: "bmp", uti: "com.microsoft.bmp" },
  { ext: "ico", uti: "com.microsoft.ico" },
  { ext: "avif", uti: "public.avif" },
  { ext: "svg", uti: "public.svg-image" },
  { ext: "pdf", uti: "com.adobe.pdf" },
  { ext: "html", uti: "public.html" },
  { ext: "htm", uti: "public.html" },
  { ext: "mp4", uti: "public.mpeg-4" },
  { ext: "webm", uti: "org.webmproject.webm" },
  { ext: "ogv", uti: "org.xiph.ogv" },
  { ext: "m4v", uti: "com.apple.m4v-video" },
  { ext: "mov", uti: "com.apple.quicktime-movie" },
  { ext: "mp3", uti: "public.mp3" },
  { ext: "wav", uti: "com.microsoft.waveform-audio" },
  { ext: "ogg", uti: "org.xiph.ogg-audio" },
  { ext: "oga", uti: "org.xiph.ogg-audio" },
  { ext: "flac", uti: "org.xiph.flac" },
  { ext: "m4a", uti: "com.apple.m4a-audio" },
  { ext: "aac", uti: "public.aac-audio" },
  { ext: "docx", uti: "org.openxmlformats.wordprocessingml.document" },
  { ext: "docm", uti: "org.openxmlformats.wordprocessingml.document.macroenabled" },
  { ext: "dotx", uti: "org.openxmlformats.wordprocessingml.template" },
  { ext: "dotm", uti: "org.openxmlformats.wordprocessingml.template.macroenabled" },
  { ext: "pptx", uti: "org.openxmlformats.presentationml.presentation" },
  { ext: "pptm", uti: "org.openxmlformats.presentationml.presentation.macroenabled" },
  { ext: "ppsx", uti: "org.openxmlformats.presentationml.slideshow" },
  { ext: "ppsm", uti: "org.openxmlformats.presentationml.slideshow.macroenabled" },
  { ext: "potx", uti: "org.openxmlformats.presentationml.template" },
  { ext: "potm", uti: "org.openxmlformats.presentationml.template.macroenabled" },
  { ext: "xlsx", uti: "org.openxmlformats.spreadsheetml.sheet" },
  { ext: "xlsm", uti: "org.openxmlformats.spreadsheetml.sheet.macroenabled" },
  { ext: "xltx", uti: "org.openxmlformats.spreadsheetml.template" },
  { ext: "xltm", uti: "org.openxmlformats.spreadsheetml.template.macroenabled" },
  { ext: "csv", uti: "public.comma-separated-values-text" },
  { ext: "tsv", uti: "public.tab-separated-values-text" },
  { ext: "psv", uti: "dyn.ah62d4rv4ge81a650" },
  { ext: "md", uti: "net.daringfireball.markdown" },
  { ext: "markdown", uti: "net.daringfireball.markdown" },
  { ext: "mdown", uti: "dyn.ah62d4rv4ge8043dts71a" },
  { ext: "mkd", uti: "dyn.ah62d4rv4ge80445e" },
  { ext: "mkdn", uti: "dyn.ah62d4rv4ge80445er2" },
  { ext: "coraboard", uti: "dyn.ah62d4rv4ge80g55wqfvg82pwqu" },
];

// Marks a launch made only to hand files to a running Studio. Packaged builds
// ignore it (they start normally if nothing is running); a dev build that
// receives it with nothing to forward to explains instead of booting a
// renderer without its Vite server.
export const OPEN_WITH_FLAG = "--codara-open";
